// Ambient population: the simulated crowd that makes the arena feel alive.
//
// v3 ("にぎわい 2.0"): the crowd is a persistent cast of residents (see
// residents.js) with personalities, whose words and deeds come from crowd.js.
// This module owns the population curve, the admin-tunable configuration,
// persona lookups for bots/chat, and the ghost leaderboard rows — all drawing
// from the same roster so names and stats agree everywhere.
//
// Env POP_SCALE (0=off) is multiplied by a live scale the admin can change at
// runtime (db.meta.popScale via /api/admin/pop).

import {
  buildRoster, customResident, residentStats, residentDailyScore, onlineResidents, residentsForLevel,
  archetype, ARCHETYPES, jstHour, jstWeekday, jstDay, unit, mulberry32, strHash, JA_NAMES, EN_NAMES,
  isChampion, residentRecord,
  // 🎭 使い捨ての対戦相手を「その帯に出てくる住人」と同じ条件で作るために要る
  // （residentsForLevel が住人を絞るのと同じ帯・同じ軽量レート式）。
  residentRating, BOT_RATING_BANDS,
} from './residents.js';
import { dailyGhostFactor } from './daily.js';
import { composeLine, chooseReplies as crowdReplies, buildCtx } from './crowd.js';
import { speakerDamp } from './chatgen.js';

export const POP_SCALE = process.env.POP_SCALE === undefined ? 1 : Math.max(0, Number(process.env.POP_SCALE) || 0);

// 表示人数の倍率上限。住人の実数は MAX_ROSTER（×88 相当）で頭打ちになるので、
// そこから先は「表示される人数」だけが増える — お祭り演出用の見た目の数字。
// 表示人数の倍率上限。×2000 でピーク時（21時台）に約136万人まで出せる。
// 100万人台を出したいという運営の要望で 500 から引き上げた。
//
// 上げても増えるのは **表示の数字だけ**。住人の実数は MAX_ROSTER=600 で
// 頭打ちなので、チャットの流量も王座の計算量もここから先は一切増えない
// （＝サーバーの負荷は ×88 のときと変わらない）。
export const MAX_LIVE_SCALE = 2000;

let liveScale = 1;
export function setLiveScale(x) {
  liveScale = Math.max(0, Math.min(MAX_LIVE_SCALE, Number(x)));
  if (!Number.isFinite(liveScale)) liveScale = 1;
  rosterCache = null;   // the roster grows with the scale
}
export function getLiveScale() { return liveScale; }
export function effectiveScale() { return POP_SCALE * liveScale; }

// ---------------------------------------------------------------------------
// Admin-tunable configuration (persisted in db.meta.ambient)
// ---------------------------------------------------------------------------

export const DEFAULT_TOGGLES = { chat: true, dialogues: true, feed: true, greetings: true, reactions: true, ghosts: true, bots: true, votes: true, guilds: true };

const custom = {
  names: [],            // extra persona names mixed into guests/bots
  lines: [],            // custom chat lines mixed into the crowd
  chatPace: 1,          // 0.1 ほぼ無言 … 1 標準 … 16 過密
  toggles: { ...DEFAULT_TOGGLES },
  quiet: null,          // { from, to } JST hours during which the crowd is silent
  removed: [],          // resident ids the admin retired
  extra: [],            // admin-added residents [{ name, arch, lang }]
  rosterSeed: 'v1',
};

export function setCustom(c = {}) {
  if (Array.isArray(c.names)) {
    custom.names = c.names.map(s => String(s).trim().slice(0, 16)).filter(Boolean).slice(0, 100);
  }
  if (Array.isArray(c.lines)) {
    custom.lines = c.lines.map(s => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 200);
  }
  if (c.chatPace !== undefined && Number.isFinite(Number(c.chatPace))) {
    custom.chatPace = Math.max(0.1, Math.min(MAX_CHAT_PACE, Number(c.chatPace)));
  }
  if (c.toggles && typeof c.toggles === 'object') {
    for (const k of Object.keys(DEFAULT_TOGGLES)) {
      if (typeof c.toggles[k] === 'boolean') custom.toggles[k] = c.toggles[k];
    }
  }
  if (c.quiet !== undefined) {
    const q = c.quiet;
    custom.quiet = q && Number.isFinite(Number(q.from)) && Number.isFinite(Number(q.to))
      ? { from: Math.max(0, Math.min(23, Math.floor(Number(q.from)))), to: Math.max(0, Math.min(24, Math.floor(Number(q.to)))) }
      : null;
  }
  if (Array.isArray(c.removed)) custom.removed = c.removed.map(String).slice(0, 500);
  if (Array.isArray(c.extra)) {
    custom.extra = c.extra
      .filter(x => x && typeof x.name === 'string' && x.name.trim())
      .map(x => ({ name: x.name.trim().slice(0, 16), arch: ARCHETYPES.some(a => a.id === x.arch) ? x.arch : 'casual', lang: x.lang === 'en' ? 'en' : 'ja' }))
      .slice(0, 100);
  }
  if (typeof c.rosterSeed === 'string' && c.rosterSeed) custom.rosterSeed = c.rosterSeed.slice(0, 32);
  rosterCache = null;
  nameIndex = null;     // seed / removed / extra はどれも名前の並びを変える
}

export function getCustom() {
  return {
    names: [...custom.names], lines: [...custom.lines], chatPace: custom.chatPace,
    toggles: { ...custom.toggles }, quiet: custom.quiet ? { ...custom.quiet } : null,
    removed: [...custom.removed], extra: custom.extra.map(x => ({ ...x })), rosterSeed: custom.rosterSeed,
  };
}
// 上限を 8 から広げた。運営から「種類を増やしたい」という要望があり、
// 8 が既に選択肢の最後だったので、上を作らないと段階を足せなかった。
// 実際の間隔には chatFloorMs の絶対下限（2.5s / 6s）が別途かかるので、
// ここを上げても発言が無限に速くなるわけではない（頭打ちに近づくだけ）。
export const MAX_CHAT_PACE = 16;
export function chatPaceFactor() { return custom.chatPace; }

// 発言間隔の下限（ms）。以前は 2500ms 固定だったので、チャット頻度を
// 「大騒ぎ」にしても混雑時は必ず 2.5 秒で頭打ちになり、設定が効いていない
// ように見えていた。標準（×2以下）の挙動はそのままに、速い側だけ解放する。
// 1000ms は安全弁 — これ以上速いと読む前に流れていく。
export function chatFloorMs(base = 2500) {
  return Math.max(1000, Math.round(base / Math.max(1, custom.chatPace / 2)));
}
export function toggles() { return custom.toggles; }

// Quiet hours: the crowd goes silent (chat/feed), population still shows.
export function isQuietNow(now = Date.now()) {
  const q = custom.quiet;
  if (!q) return false;
  const h = jstHour(now);
  return q.from <= q.to ? (h >= q.from && h < q.to) : (h >= q.from || h < q.to);
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

// The cast grows with the crowd scale (√ curve, capped) so a packed arena
// still has enough named residents to chat, vote and fill the boards.
// buildRoster is deterministic per index, so growing only APPENDS residents —
// r0..r63 keep their identity (and the admin's removed-list stays valid).
// 住人の実数の上限。240 だと rosterSize() が ×14 で頭打ちになり、そこから先は
// 倍率を上げても「表示人数」しか増えなかった（住人240人・オンライン118人・
// チャット速度が全部張り付く）。600 なら ×88 まで住人が増え続ける。
// 実測: 生成 1ms / 141KB（起動時に1度だけ・以後キャッシュ）、名前の重複ゼロ。
const MAX_ROSTER = 600;
export function rosterSize() {
  const scale = effectiveScale();
  return Math.min(MAX_ROSTER, Math.round(64 * Math.max(1, Math.sqrt(scale))));
}

let rosterCache = null;
let rosterCacheSize = 0;
export function getRoster() {
  const size = rosterSize();
  if (rosterCache && rosterCacheSize === size) return rosterCache;
  const removed = new Set(custom.removed);
  const base = buildRoster(custom.rosterSeed, size).filter(r => !removed.has(r.id));
  const extra = custom.extra.map((spec, i) => customResident(spec, i)).filter(r => !removed.has(r.id));
  rosterCache = base.concat(extra);
  rosterCacheSize = size;
  return rosterCache;
}

// Population pressure relative to a "normal" evening — drives how many
// residents are online and how chatty the lobby is.
export function popFactor(now = Date.now()) {
  const scale = effectiveScale();
  if (!scale) return 0;
  const base = Math.max(0.3, Math.min(2.2, ambientOnline(now) / 320));
  // Above ×2 the raw curve saturates; a log-damped boost lets big multipliers
  // keep pushing the crowd (×10 ≈ ×1.7, ×100 ≈ ×2.7) without runaway timers —
  // consumers keep their own absolute floors on gaps.
  const boost = scale > 2 ? 1 + Math.log10(scale / 2) : 1;
  return Math.min(4, base * boost);
}

export function activeResidents(now = Date.now()) {
  if (!effectiveScale()) return [];
  const list = onlineResidents(getRoster(), now, popFactor(now));
  // 👑 王座持ちの住人は時間帯に関係なく「王座を守りに」常駐する — ランキングの
  // 顔ぶれ（王者）がチャットにもちゃんと現れる。
  const world = worldProvider ? worldProvider() : null;
  if (world && Array.isArray(world.thrones) && world.thrones.length) {
    const have = new Set(list.map(r => r.id));
    for (const name of world.thrones) {
      const r = getRoster().find(x => x.name === name);
      if (r && !have.has(r.id)) { list.push(r); have.add(r.id); }
    }
  }
  return list;
}

export function residentById(id) { return getRoster().find(r => r.id === id) || null; }

// 名前の予約表。getRoster() ではなく MAX_ROSTER の全600人で引く。
//
// getRoster() はにぎわい倍率で伸び縮みするので（×1 なら64人）、倍率が低い
// あいだは r64..r599 の名前が「空いている」ように見え、そのままアカウントを
// 作れてしまっていた。あとで管理者が倍率を上げると同名の住人が湧き、
//   ・ロビーに from:「その名前」の発言が流れる（本人は何も言っていない）
//   ・タップすると /api/profile が本物のプレイヤーを返す＝なりすまし成立
//   ・battle.js が username 一致で王冠まで付ける（「名前は一意」の前提が崩れる）
//   ・pickResidentBot が同名の偽レート付き対戦相手を出す
// という状態になる。ランキングと王座は realNames 除外で自衛しているのに、
// チャットと対戦だけ素通しだった。retiredResidents() が「倍率を下げても
// 有効であること」を理由に MAX_ROSTER で組み直しているのと同じ理由で、
// 名前の一意性も倍率に依存させない。
//
// 比較は小文字化して行う。近くの重複チェック（db.users の username や
// index.js の addResident）はどれも toLowerCase なので、ここだけ完全一致だと
// 「milo」で登録して住人「Milo」と並ぶ、という同じ穴が残る。
let nameIndex = null;
function residentNameIndex() {
  if (nameIndex) return nameIndex;
  const removed = new Set(custom.removed);
  const all = buildRoster(custom.rosterSeed, MAX_ROSTER)
    .concat(custom.extra.map((spec, i) => customResident(spec, i)));
  nameIndex = new Map();
  for (const r of all) if (!removed.has(r.id)) nameIndex.set(r.name.toLowerCase(), r);
  return nameIndex;
}
// 指定したシードで名簿を組んだとき、渡した名前（＝実プレイヤーの username）と
// ぶつかる住人の id。名簿を引き直す前に「その名前は人間が使っている」を調べる
// ための口で、MAX_ROSTER 全員で引くので、にぎわい倍率に左右されない。
// 呼び出し側が新しいシードを渡せるように、現在の custom.rosterSeed ではなく
// 引数のシードで組む（引き直しは setCustom より前に判定する必要があるため）。
export function clashingResidentIds(seed, takenNames) {
  const taken = new Set([...takenNames].map(n => String(n == null ? '' : n).toLowerCase()));
  if (!taken.size) return [];
  return buildRoster(seed || custom.rosterSeed, MAX_ROSTER)
    .filter(r => taken.has(r.name.toLowerCase()))
    .map(r => r.id);
}

// いま出ている名簿（getRoster）のほうを優先して引く。
//
// ⚠ ここを予約表だけで引いていたころ、**同じ住人がプロフィールとランキングで
//   違う数字になっていた**。理由は id のズレ:
//     ・予約表は MAX_ROSTER(600) で組む（倍率を下げても名前を守るため）
//     ・ランキングは getRoster()＝rosterSize()（×1 なら64人）で組む
//     ・buildRoster は最後に「王者が引かれなかったら **いちばん強い住人** を
//       差し替える」ので、名簿の大きさが変わると王者の席（＝id）が動く
//       実測: ちゃちゃまるが 64人名簿では r21、600人名簿では r122
//   residentStats は unit(r.id, …) で数字を作るので、id が違えばレートも
//   自己ベストも変わる（実測 2594 と 2591 / 895,220 と 894,622）。
//   本番は倍率が高くて rosterSize() が 600 に張り付くので出なかったが、
//   倍率を下げた機体では見える食い違いだった。
//
// 予約（「その名前は住人が使っているか？」）の意味は落とさない ── 出ていない
// 住人は予約表のほうで拾うので、真偽の答えは今までどおり600人ぶん。
// 変わるのは「見つかった住人の実体をどちらの名簿から返すか」だけ。
let liveNameIndex = null;
let liveNameIndexFor = null;
export function residentByName(name) {
  const key = String(name == null ? '' : name).toLowerCase();
  if (!key) return null;
  const roster = getRoster();
  // 名簿は起動時に1度組んで使い回すので、同じ配列のあいだは索引も使い回す。
  if (liveNameIndexFor !== roster) {
    liveNameIndex = new Map();
    for (const r of roster) liveNameIndex.set(r.name.toLowerCase(), r);
    liveNameIndexFor = roster;
  }
  return liveNameIndex.get(key) || residentNameIndex().get(key) || null;
}

// ---------------------------------------------------------------------------
// World context (event / poll) — injected by index.js to avoid a cycle
// ---------------------------------------------------------------------------

let worldProvider = () => ({ event: null, poll: null });
export function setWorldProvider(fn) { worldProvider = fn; }

// 実プレイヤーの登録名（db.users の username 小文字集合）を返す関数。index.js が
// 注入する。ghostRows は taken 照合で衝突を防いでいるのに、Bot 変装やロビー発言の
// pickPersona フォールバックは素通しで、同名の偽レート対戦相手/発言者が出て
// なりすましが成立しうる（v2.15 で塞いだ住人名衝突と同型）。未設定時は素通し。
let takenNamesProvider = null;
export function setTakenNamesProvider(fn) { takenNamesProvider = fn; }
export function worldCtx(extra = {}) {
  const w = worldProvider() || {};
  const now = extra.now || Date.now();
  return buildCtx({ now, event: w.event, poll: w.poll, thrones: w.thrones || [], active: activeResidents(now), humans: extra.humans || [] });
}

// ---------------------------------------------------------------------------
// Personas (bots, guests, fallbacks)
// ---------------------------------------------------------------------------

const NAMES = JA_NAMES.concat(EN_NAMES);

// Pick a human-looking persona. `used` prevents duplicates inside one match.
// guestChance: some personas look like guests (ゲストXXXX, no rating).
export function pickPersona({ used, guestChance = 0.3, rnd = Math.random } = {}) {
  if (rnd() < guestChance) {
    for (;;) {
      const name = `ゲスト${1000 + Math.floor(rnd() * 9000)}`;
      if (!used || !used.has(name)) { if (used) used.add(name); return { name, registered: false }; }
    }
  }
  // 実プレイヤーの登録名は避ける（同名の偽レート対戦相手/発言者＝なりすまし防止）。
  // tries>=3 で必ず2桁サフィックスが付き名前空間が広がるので枯れない。比較は小文字。
  const taken = takenNamesProvider ? takenNamesProvider() : null;
  for (let tries = 0; ; tries++) {
    const useCustom = custom.names.length > 0 && rnd() < 0.35;
    const pool = useCustom ? custom.names : NAMES;
    let name = pool[Math.floor(rnd() * pool.length)];
    if (tries >= 3 || (!useCustom && rnd() < 0.25)) name += String(Math.floor(rnd() * 90) + 10);
    const free = (!used || !used.has(name)) && (!taken || !taken.has(name.toLowerCase()));
    if (free) { if (used) used.add(name); return { name, registered: true }; }
  }
}

// ---------------------------------------------------------------------------
// 👑 伝説枠: 王者（ちゃちゃまる）との遭遇
// ---------------------------------------------------------------------------
// これまで王者は「鬼の帯に入る住人28人のうちの1人」として普通に抽選されて
// いた（鬼枠に当たった対戦のうち約3.6%）。王者に専用の最強AIを与えた以上、
// その頻度で当たると「勝てない相手」が日常になる。抽選からは丸ごと外し、
// ここでだけ、決めた確率で呼び出す ＝ 遭遇率をこの1行で調整できる。
//
// 値の根拠（1試合＝ボット1席として）:
//   ・0.01 なら 100試合に1回。1日20試合遊ぶ人で5日に1度めぐり会う計算で、
//     「稀に出会う伝説」の頻度としてちょうどよい（毎日は会わない／
//     1か月遊んで一度も会わない、にもならない）。
//   ・従来の実効遭遇率（鬼枠12% × 住人採用70% × 28人に1人 ≒ 0.30%）よりは
//     むしろ**上げて**ある。専用AIを与えたぶん、一度の遭遇の価値が上がった
//     ので「存在は知っているが会えない」側に倒しすぎないため。
// テスト用に環境変数で上書きできる（CHAMPION_RATE=1 で必ず出る）。
export const CHAMPION_ENCOUNTER = (() => {
  const v = Number(process.env.CHAMPION_RATE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.01;
})();

// 王者を対戦相手として出す（出ないときは null）。pickResidentBot と同じ形を
// 返すので、呼び出し側は「住人を引いた」のと同じ扱いができる。
// ⚠ 強さ（専用AI）を決めるのは battle.js。ここは「誰が出るか」だけを決める。
export function pickChampionBot(used, now = Date.now()) {
  if (!custom.toggles.bots || !effectiveScale()) return null;
  if (Math.random() >= CHAMPION_ENCOUNTER) return null;
  const champ = getRoster().find(isChampion);
  if (!champ || (used && used.has(champ.name))) return null;
  if (used) used.add(champ.name);
  const st = residentStats(champ, now);
  return {
    resident: champ, name: champ.name, registered: champ.registered,
    rating: champ.registered ? st.rating : null, level: champ.registered ? st.level : 1,
  };
}

// A resident to disguise a bot of the given strength. Prefers residents who
// are "online" right now; returns null when none fits (caller falls back).
export function pickResidentBot(level, used, now = Date.now()) {
  if (!custom.toggles.bots || !effectiveScale()) return null;
  const online = new Set(activeResidents(now).map(r => r.id));
  // 👑 王者は通常の抽選から外す（上の pickChampionBot だけが出せる）。
  // 外さないと、遭遇率を1か所で決めるという上の設計が成り立たない。
  const fits = residentsForLevel(getRoster(), level, now)
    .filter(r => !isChampion(r) && (!used || !used.has(r.name)));
  if (!fits.length) return null;
  const pool = fits.filter(r => online.has(r.id));
  const pickFrom = pool.length && Math.random() < 0.8 ? pool : fits;
  const r = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  if (used) used.add(r.name);
  const st = residentStats(r, now);
  return { resident: r, name: r.name, registered: r.registered, rating: r.registered ? st.rating : null, level: r.registered ? st.level : 1 };
}

// ---------------------------------------------------------------------------
// 🎭 席に並ぶ「人間なら当然持っているもの」（称号・ギルドタグ・直近の戦績）
// ---------------------------------------------------------------------------
// 対戦カードに称号やギルドを出すと、値そのものより **欄の有無** が正体を明かす。
// 住人（residents）は residentStats から3つとも作れるが、ボット席の約3割は
// 名簿に居ない使い捨ての persona（pickResidentBot が null を返す分岐）なので、
// 素直に書くとそこだけ null になる ──「その欄が出ない＝使い捨てのボット」と
// 読めてしまい、いま無害な機能がそのまま秘匿の穴になる。第5波で称号・ギルド・
// 戦績を対戦カードから外したのはこれが理由で、ここはその封印を解く側の実装。
//
// 作り方は「値を似せる」ではなく **住人と同じ関数に通す**:
//   ① 名前から決定論的に“合成住人”を1人こしらえる（customResident）
//   ② その席の強さの帯（BOT_RATING_BANDS）にレートが収まるまで引き直す
//      ← residentsForLevel が変装候補を絞る条件と**まったく同じ**なので、
//        「その帯に出てくる住人」と同じ条件付き分布になる。称号は
//        residentStats の中でレートやバッジから決まるので、帯を合わせないと
//        「レート1800なのに“かけだしブロッカー”」という、住人には絶対に
//        起きない組み合わせが persona にだけ現れる。
//   ③ あとは residentStats に通すだけ ── 称号の出る割合も勝敗の分布も、
//      似せているのではなく**同じ式が出した値**になる。
//
// ギルドだけは別扱い。ghostGuilds は名簿から組み、定員20人から溢れた住人は
// 無所属になるので、加入率は名簿の大きさで 70.3%（64人）〜65.8%（600人）と
// 動く。「unit(id,'guild') が 0.3 未満なら無所属」と写経すると倍率次第で
// 数ポイントずれる（1000人ぶん並べれば有意に見える差）。そこで
// **名前から選んだ住人1人の加入状況をそのまま借りる** ── 借り元が住人の実分布
// そのものなので、定員あふれ込みで必ず一致する。
//
// ⚠ 合成住人は名簿には**入れない**。id は `x……` 形で sanitize.js が住人の印と
// 見なす形なので、外へ出すのは title / guild / record の3つだけに留めること。

// 帯に収まるまでの引き直しの上限。実測（住人600人ぶんの名前 × 4帯）で平均
// 2.6〜8.9回、40回までで 98〜100% が帯に収まる。収まらなかった名前は
// 「いちばん帯に近かった1人」を使う ── 席を空欄にするより近い値のほうがよい。
const PERSONA_TRIES = 40;
// 引き直しの刻み。素数にしておくと index が近い名前どうしで系列が重ならない。
const PERSONA_STEP = 7919;

// 名前と席の強さから決まる“合成住人”。同じ (名前, 強さ) なら毎回同じ。
// 強さも種に混ぜるのは、席のレートが帯から決まる以上、称号だけ名前で固定すると
// レートと食い違う組み合わせが出てしまうため（上の②の理由）。
function personaResident(name, level, now) {
  const [lo, hi] = BOT_RATING_BANDS[level] || BOT_RATING_BANDS.normal;
  const base = strHash(`persona:${name}:${level}`) % 1000000;
  let best = null;
  let bestGap = Infinity;
  for (let k = 0; k < PERSONA_TRIES; k++) {
    // index を動かすと id（unit の種）と名前由来の乱数列の両方が動く。
    const r = customResident({ name }, base + k * PERSONA_STEP);
    const rating = residentRating(r, now);
    if (rating >= lo && rating <= hi) return r;
    const gap = rating < lo ? lo - rating : rating - hi;
    if (gap < bestGap) { bestGap = gap; best = r; }
  }
  return best;
}

// いま名簿に出ている同名の住人。residentByName は予約表（MAX_ROSTER=600）にも
// 落ちるが、ここで欲しいのは **ゴーストギルドの名簿に本当に載っている人**なので
// 出ている名簿だけを見る（予約表の住人にギルドは無く、借りると必ず null になる）。
function liveResidentNamed(name) {
  return getRoster().find(r => r.name === name) || null;
}

// ギルドを借りる住人を1人選ぶ。名簿はにぎわい倍率で伸び縮みするので、同じ名前
// でも世界の大きさが変われば借り元は変わる ── 住人自身の数字（レート・自己
// ベスト）も倍率で動くので、ここだけ据え置いても意味がない。
function personaGuildDonor(name) {
  const roster = getRoster();
  if (!roster.length) return null;
  return roster[strHash(`persona-guild:${name}`) % roster.length];
}

/**
 * 席1つぶんの称号・ギルドタグ・直近の戦績。
 *
 * 住人でも使い捨てでも **この1つの関数**を通すこと。経路が分かれた瞬間に
 * 差が生まれ、その差がそのまま正体になる。
 *
 * @param {object|null} resident  名簿の住人（persona なら null）
 * @param {string} name           画面に出る名前
 * @param {string} level          席の強さ（BOT_RATING_BANDS のキー）
 * @param {boolean} registered    アカウント持ちか
 * @param {number} now
 * @param {function|null} guildTagOf  住人名 → ギルドタグ（battle.js が渡す）
 * @returns {{title: object|null, guild: string|null, record: {w:number,l:number}|null}}
 *   欄は必ず3つとも返る（値が null でも**キーは消さない**）。
 */
export function seatProfile({ resident = null, name = '', level = 'normal', registered = true, now = Date.now(), guildTagOf = null } = {}) {
  const none = { title: null, guild: null, record: null };
  // ゲスト（アカウント無し）は本物のゲストと同じく3つとも持たない。ここを
  // 埋めると「ゲスト名なのに称号がある＝人間ではない」という逆向きの穴になる。
  // 未登録の住人（registered:false）も同じ扱い ── 席の見え方はゲストなので。
  if (!registered) return none;
  const r = resident || personaResident(name, level, now);
  if (!r) return none;
  const st = residentStats(r, now);
  // 住人は本当にそのギルドに居る。persona は名簿に席が無いので借りるのだが、
  // 借り元は **まず同名の住人**を試す。
  //
  // 理由: ゴーストギルドの詳細（/api/guilds/:id）は所属者の名前を並べる。
  // 無関係な住人からタグを借りると「タグは 🛡COMBO なのに COMBO の名簿に
  // その名前が居ない」という、実プレイヤーにも住人にも起きない食い違いが残る
  // ── 手間はかかるが、1人ずつ確実に判定できてしまう形の穴。
  // pickPersona は住人と**同じ名前の池**から引くので、多くの名前は名簿に本人が
  // 居る。その場合は本人のギルドをそのまま名乗れば名簿とも一致する。
  // 2桁サフィックス付き（`Milo42` など）の名前だけが借り物のままだが、
  // 分布はどちらの経路でも住人そのものなので、加入率は変わらない。
  const donor = resident || liveResidentNamed(name) || personaGuildDonor(name);
  const tag = guildTagOf && donor ? guildTagOf(donor.name) : null;
  return {
    title: st.title || null,
    guild: typeof tag === 'string' && tag ? tag : null,
    // 実プレイヤー側（index.js の stats.pvpWins / pvpLosses）と同じ形。
    record: { w: st.pvpWins, l: st.pvpLosses },
  };
}

// A lobby voice: an active resident weighted by chattiness.
export function lobbyPersona(now = Date.now()) {
  const active = activeResidents(now).filter(r => r.chatty > 0.2);
  if (!active.length) return pickPersona({ guestChance: 0.15 });
  const total = active.reduce((a, r) => a + r.chatty, 0);
  let x = Math.random() * total;
  for (const r of active) { x -= r.chatty; if (x <= 0) return { name: r.name, registered: r.registered, resident: r }; }
  const r = active[active.length - 1];
  return { name: r.name, registered: r.registered, resident: r };
}

// ---------------------------------------------------------------------------
// Time-of-day online counter (JST curve, weekday factor, event boost,
// occasional surges, and a smooth wobble so it drifts live)
// ---------------------------------------------------------------------------

const HOURLY = [ // JST hour -> typical player count
  190, 140, 100, 75, 58, 52, 66, 95, 125, 150, 175, 205,
  265, 240, 210, 230, 265, 320, 410, 520, 620, 680, 590, 360,
];

function wobble(t) {
  return 0.10 * Math.sin(t / 700000) + 0.06 * Math.sin(t / 190000 + 2) + 0.05 * Math.sin(t / 53000 + 5);
}

// Random "someone big is streaming" surges: ~1 in 6 hours, 10–25 minutes,
// ramping in and out smoothly. Deterministic per hour slot.
function surge(now) {
  const slot = Math.floor(now / 3600000);
  for (const s of [slot, slot - 1]) {
    if (unit('surge', s) > 0.17) continue;
    const start = s * 3600000 + unit('surge-at', s) * 2400000;
    const len = (10 + unit('surge-len', s) * 15) * 60000;
    const x = (now - start) / len;
    if (x < 0 || x > 1) continue;
    const amp = 0.3 + unit('surge-amp', s) * 0.5;
    return 1 + amp * Math.sin(Math.PI * x);
  }
  return 1;
}

function weekdayFactor(now) {
  const wd = jstWeekday(now);
  const h = jstHour(now);
  if (wd === 0 || wd === 6) return 1.25;
  if (wd === 5 && h >= 17) return 1.12;
  return 1;
}

function eventFactor() {
  const w = worldProvider() || {};
  let f = 1;
  if (w.event) f *= 1.22;
  if (w.poll) f *= 1.05;
  return f;
}

export function ambientOnline(now = Date.now()) {
  const scale = effectiveScale();
  if (!scale) return 0;
  const jst = jstHour(now);
  const h = Math.floor(jst), f = jst - h;
  const base = HOURLY[h] * (1 - f) + HOURLY[(h + 1) % 24] * f;
  return Math.max(0, Math.round(base * (1 + wobble(now)) * weekdayFactor(now) * eventFactor() * surge(now) * scale));
}

export function ambientMatches(now = Date.now()) {
  return Math.round(ambientOnline(now) * 0.17 * (1 + 0.05 * Math.sin(now / 97000)));
}

// People sitting in matchmaking right now.
export function ambientQueue(now = Date.now()) {
  return Math.round(ambientOnline(now) * 0.045 * (1 + 0.3 * Math.sin(now / 41000)));
}

// How lively the arena is versus its own daily peak.
export function crowdMood(now = Date.now()) {
  const scale = effectiveScale();
  if (!scale) return { id: 'off', ratio: 0 };
  // Reference peak grows slower than the scale (^0.7), so cranking the
  // multiplier genuinely shifts the mood toward "party" instead of the scale
  // cancelling itself out of the ratio.
  const peak = Math.max(...HOURLY) * 1.25 * Math.max(1, Math.pow(scale, 0.7));
  const ratio = Math.min(3, ambientOnline(now) / peak);
  return { id: ratio > 0.72 ? 'party' : ratio > 0.38 ? 'busy' : 'calm', ratio: Math.round(ratio * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Ambient chat
// ---------------------------------------------------------------------------

// A line from a specific resident (or a random active one).
export function residentLine(resident = null, now = Date.now()) {
  const ctx = worldCtx({ now });
  const r = resident || weightedByChat(ctx.active);
  if (!r) return { name: pickPersona({ guestChance: 0.15 }).name, text: randomChatLine(), tr: null, resident: null };
  const out = composeLine(r, ctx, custom.lines);
  return { name: r.name, text: out.text, tr: out.tr, resident: r };
}

// Chattier residents speak more often; lurkers mostly lurk. Chat 3.0 adds a
// rotation damp: whoever just spoke goes quiet for a bit, so the lobby never
// sounds like one person narrating.
function weightedByChat(list, now = Date.now()) {
  if (!list.length) return null;
  const weights = list.map(r => r.chatty * speakerDamp(r.id, now));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = Math.random() * total;
  for (let i = 0; i < list.length; i++) { x -= weights[i]; if (x <= 0) return list[i]; }
  return list[list.length - 1];
}

// Legacy: a line with no particular speaker (admin "say" with empty text).
const FALLBACK_LINES = ['こんにちは〜', 'こんばんは！', 'よろしく〜', '誰か対戦しよ！', 'gg', 'ggでした！', '自己ベスト更新！', 'hi everyone!', 'gg'];
export function randomChatLine() {
  if (custom.lines.length && Math.random() < 0.45) {
    return custom.lines[Math.floor(Math.random() * custom.lines.length)];
  }
  return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)];
}

// Reply engine: when a real player chats, residents answer.
// Returns [{ name, text, delay, resident }]. forcedName: this resident must
// answer first (direct replies in chat).
export function chooseReplies(text, now = Date.now(), forcedName = null) {
  if (!custom.toggles.reactions) return [];
  const ctx = worldCtx({ now });
  return crowdReplies(text, ctx, forcedName).map(x => ({ name: x.resident.name, text: x.text, tr: x.tr || null, delay: x.delay, resident: x.resident }));
}

// ---------------------------------------------------------------------------
// Ghost leaderboard rows: residents first (so chat names match the rankings),
// topped up with weekly-reseeded randoms when the board wants more.
// ---------------------------------------------------------------------------

const GHOST_COUNT = { score: 40, rating: 30, dungeon: 24, weekly: 18, sprint: 22, daily: 20 };

// `taken`: Set of real usernames — ghosts never shadow a real player.
// The stable weekly subset of registered residents shown on a given board.
// Exported because the 👑 throne computation must pick its AI champions from
// the SAME subset — a crowned resident who isn't on the visible board would
// look like the crown vanished.
export function boardResidents(board, weekId, now = Date.now()) {
  const scale = effectiveScale();
  if (!scale || !custom.toggles.ghosts) return [];
  const count = Math.min(100, Math.round((GHOST_COUNT[board] || 24) * Math.min(scale, 2.5)));
  // 📅 デイリーは「今日挑戦した住人」の顔ぶれ — 週ではなくJST日で入れ替わる。
  const bucket = board === 'daily' ? `D${jstDay(now)}` : weekId;
  const registered = getRoster().filter(r => r.registered);
  // 👑 王者（ちゃちゃまる）は抽選に一切かけない。
  //
  // ここは「そのボードに出す住人の部分集合」を毎週引き直す抽選で、王者も
  // ふつうに他の住人と同じ確率で漏れていた。結果、ハイスコア部門に1件も
  // 出てこないボードが実在した（レート部門では1位なのに）── アリーナの
  // 頂点が、日によってランキングから丸ごと消える。
  // 抽選から外して常に先頭に置く。先頭なのは、値が同点になったときの
  // 並び順（Array.prototype.sort は安定・王座計算も先に見つけたほうが勝つ）で
  // 王者が他の住人の上に来るようにするため。
  const champ = registered.find(isChampion) || null;
  const pool = champ ? registered.filter(r => r !== champ) : registered;
  const rest = pool
    .map(r => ({ r, k: unit(`${r.id}-${board}`, bucket) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, champ ? Math.max(0, count - 1) : count)
    .map(x => x.r);
  return champ ? [champ, ...rest] : rest;
}

export function ghostRows(board, weekId, taken, now = Date.now()) {
  const scale = effectiveScale();
  if (!scale || !custom.toggles.ghosts) return [];
  // The public board is sliced to 100 rows — never generate more than that.
  const count = Math.min(100, Math.round((GHOST_COUNT[board] || 24) * Math.min(scale, 2.5)));
  const used = new Set(taken);
  const rows = [];

  const rowOf = (name, st) => ({
    username: name,
    level: st.level,
    bestScore: st.bestScore,
    rating: st.rating,
    pvpWins: st.pvpWins,
    pvpLosses: st.pvpLosses,
    dungeonMax: st.dungeonMax,
    weeklyBest: st.weeklyBest,
    sprintBest: st.sprintBest,
    sprint180: st.sprint180,
    // v2.6 boards — derived from tower progress so they track each resident's
    // skill drift without new stat plumbing.
    puzzleStage: Math.max(1, Math.round((st.dungeonMax || 8) * 0.55)),
    digDepth: Math.max(3, Math.round((st.dungeonMax || 8) * 0.75)),
    badges: st.badges,
    title: st.title,
  });
  // 📅 デイリーの記録はその日限りなので residentStats（自己ベスト系）ではなく
  // 日替わりの別式で出す。デイリーボードの行にだけ載せる。
  const stampDaily = (row, r) => {
    if (board === 'daily') row.dailyScore = residentDailyScore(r, now);
    return row;
  };

  // Residents: only the registered ones appear on rankings. Which subset
  // shows on a given board is stable per week so the boards don't churn.
  const keyed = boardResidents(board, weekId, now).filter(r => !used.has(r.name));
  for (const r of keyed) {
    used.add(r.name);
    rows.push(stampDaily(rowOf(r.name, residentStats(r, now, weekId)), r));
  }

  // Top up with anonymous ghosts when the board wants more than the cast.
  // 📅 デイリーはその日限りのボードなので、名無しの埋め草も週ではなくJST日で
  // 引き直す。週シードのままだと、同じ名前が同じ点数で7日間居座ってしまう。
  const ghostBucket = board === 'daily' ? `D${jstDay(now)}` : weekId;
  const rng = mulberry32(strHash(`bba-ghost-${ghostBucket}-${board}`));
  for (let i = rows.length; i < count; i++) {
    const { name } = pickPersona({ used, guestChance: 0, rnd: rng });
    const skill = rng();
    const mix = (w) => skill * w + rng() * (1 - w);
    rows.push({
      username: name,
      level: 2 + Math.floor(mix(0.7) * 42),
      bestScore: Math.floor(Math.pow(mix(0.6), 2) * 62000 + 2500),
      rating: 850 + Math.floor(Math.pow(mix(0.7), 1.4) * 900),
      pvpWins: Math.floor(mix(0.5) * 90),
      pvpLosses: Math.floor(rng() * 70),
      dungeonMax: 1 + Math.floor(Math.pow(mix(0.6), 1.6) * 72),
      weeklyBest: Math.floor(Math.pow(mix(0.5), 2) * 30000 + 800),
      sprintBest: Math.floor(Math.pow(mix(0.6), 2) * 14000 + 600),
      sprint180: Math.floor(Math.pow(mix(0.6), 2) * 46000 + 2000),
      puzzleStage: 1 + Math.floor(Math.pow(mix(0.6), 1.5) * 44),
      digDepth: 3 + Math.floor(Math.pow(mix(0.6), 1.5) * 60),
      // 住人と同じく、名無しの埋め草にもその日のお題の係数を掛ける。
      ...(board === 'daily' ? { dailyScore: Math.floor((Math.pow(mix(0.6), 1.5) * 9000 + 400) * dailyGhostFactor(now)) } : {}),
      badges: [],
      title: null,
    });
  }
  return rows;
}

// Residents the admin retired (so they can be brought back). Always builds
// the maximum roster: a resident retired while the scale was high (r64+)
// must stay restorable even after the scale is lowered again.
export function retiredResidents() {
  const removed = new Set(custom.removed);
  if (!removed.size) return [];
  const base = buildRoster(custom.rosterSeed, MAX_ROSTER).filter(r => removed.has(r.id));
  const extra = custom.extra.map((spec, i) => customResident(spec, i)).filter(r => removed.has(r.id));
  return base.concat(extra).map(r => ({ id: r.id, name: r.name, archLabel: archetype(r.arch).label }));
}

// Admin view of the cast with live stats.
export function rosterView(now = Date.now()) {
  const online = new Set(activeResidents(now).map(r => r.id));
  return getRoster().map(r => {
    const st = residentStats(r, now);
    const a = archetype(r.arch);
    // 🗒 実際に人間と当たったぶんの差分。ここは /api/admin/* なので
    // sanitize.js の関門を通らない ＝ 運営だけが見る面。この表を
    // 非管理者に出す口はここ以外に無い（residentStats が返すのは
    // 差分を **足したあとの** 合計値だけで、内訳は載っていない）。
    const rec = residentRecord(r);
    return {
      id: r.id, name: r.name, arch: r.arch, archLabel: a.label, lang: r.lang,
      skill: r.skill, chatty: r.chatty, favMode: r.favMode, hours: r.hours,
      registered: r.registered, custom: r.custom,
      // 段まで入った表示名（例「グランドマスター I」）。実プレイヤー側の表示は
      // すべて24段の粒度なので、運営が見る住人一覧だけ帯止まりにしない。
      rating: st.rating, level: st.level, tier: st.tier.label || st.tier.name, online: online.has(r.id),
      // 差分が無い住人（＝まだ誰とも当たっていない）は null。行が無いことと
      // 「0勝0敗の行がある」ことを運営が見分けられるようにしておく。
      record: rec ? { w: rec.w || 0, l: rec.l || 0, rd: rec.rd || 0, lastAt: rec.at || 0 } : null,
    };
  });
}

export { ARCHETYPES, residentStats, archetype };
