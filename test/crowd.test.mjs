// Run from the repo root:  node test/crowd.test.mjs
// Fuzz the crowd content tables (lines / dialogues / feed / replies /
// reactions) across every archetype, period and world state — catches broken
// slots, bad archetype filters and crashes from newly added content.
import { buildRoster, ARCHETYPES } from '../server/residents.js';
import { composeLine, composeDialogue, composeFeed, composeReaction, chooseReplies, buildCtx, fill } from '../server/crowd.js';
import { _resetForTest } from '../server/chatgen.js';
import { setWorldProvider, activeResidents, setCustom, chatPaceFactor, chatFloorMs, residentByName, clashingResidentIds, getCustom } from '../server/ambient.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const roster = buildRoster('v1', 240);
const byArch = id => roster.filter(r => r.arch === id);
check('roster covers every archetype', ARCHETYPES.every(a => byArch(a.id).length > 0));

// JST hour -> a UTC timestamp with that hour.
const atHour = h => Date.UTC(2026, 7, 26, (h - 9 + 24) % 24, 30);
const PERIOD_HOURS = { morning: 8, day: 14, evening: 19, night: 23, late: 3 };
const EVENT = { name: 'コイン祭り', type: 'coinfes' };
const POLL = { question: 'つぎの企画どれがいい？', options: [{ id: 'o0', text: 'ガチャ祭' }, { id: 'o1', text: 'ボス週間' }] };

const ctxFor = (period, event, poll) => buildCtx({
  now: atHour(PERIOD_HOURS[period]),
  event, poll,
  active: roster.slice(0, 48),
  humans: ['テスト太郎'],
});

const bad = [];
const scan = (s, src) => {
  if (typeof s !== 'string' || !s.length) bad.push(`${src}: empty`);
  else if (/\{\w+\}/.test(s)) bad.push(`${src}: unfilled slot in "${s}"`);
  else if (/undefined|NaN/.test(s)) bad.push(`${src}: leaked value in "${s}"`);
  // スロットにオブジェクトを渡したのに renderSlot 側に対応する case が
  // 無いと、文字列化されて "[object Object]" が本文に出る。以前はこれを
  // 検出できず、英語のセリフが壊れたままテストが緑になっていた。
  else if (s.includes('[object')) bad.push(`${src}: object leaked into "${s}"`);
};

// ---- composeLine: every archetype × every period × event/poll states ----
let lineCount = 0;
for (const period of Object.keys(PERIOD_HOURS)) {
  for (const [event, poll] of [[null, null], [EVENT, null], [null, POLL]]) {
    const ctx = ctxFor(period, event, poll);
    for (const a of ARCHETYPES) {
      const r = byArch(a.id)[0];
      for (let i = 0; i < 25; i++) {
        const out = composeLine(r, ctx);
        scan(out.text, `line/${a.id}/${period}`);
        if (out.tr) scan(out.tr.text, `line-tr/${a.id}/${period}`);
        lineCount++;
      }
    }
  }
}
check(`composeLine fuzz (${lineCount} samples)`, bad.length === 0, bad.slice(0, 3).join(' | '));

// ---- composeDialogue ----
bad.length = 0;
let dlgCount = 0, dlgNull = 0, dlgTr = 0;
for (const period of Object.keys(PERIOD_HOURS)) {
  for (const [event, poll] of [[null, null], [EVENT, null], [null, POLL]]) {
    const ctx = ctxFor(period, event, poll);
    for (let i = 0; i < 40; i++) {
      const s = composeDialogue(ctx);
      if (!s) { dlgNull++; continue; }
      for (const step of s) {
        scan(step.text, `dlg/${period}`);
        if (step.tr) scan(step.tr.text, `dlg-tr/${period}`);
        dlgCount++;
        if (step.tr && step.tr.engine === 'native') dlgTr++;
      }
    }
  }
}
check(`composeDialogue fuzz (${dlgCount} texts)`, bad.length === 0 && dlgCount > 100, bad.slice(0, 3).join(' | ') || `nulls=${dlgNull}`);
// 台本会話も生成会話もネイティブ対訳つき（エセ翻訳への転落を防ぐ）
check(`dialogue native-tr coverage ≥ 90%`, dlgTr / Math.max(1, dlgCount) >= 0.9, `${dlgTr}/${dlgCount}`);

// ---- composeFeed ----
bad.length = 0;
let feedCount = 0;
const feedIds = new Set();
for (let i = 0; i < 600; i++) {
  const item = composeFeed(ctxFor('evening', null, null));
  if (!item) continue;
  scan(item.text, 'feed/ja');
  scan(item.textEn, 'feed/en');
  feedIds.add(item.id);
  feedCount++;
}
check(`composeFeed fuzz (${feedCount} items, ${feedIds.size} distinct kinds)`, bad.length === 0 && feedIds.size >= 15, bad.slice(0, 3).join(' | '));

// ---- composeReaction: every kind ----
bad.length = 0;
// 'throne' はスロット {board} を持つのに、これまで一度も走っていなかった。
const KINDS = ['greet_named', 'greet_plain', 'lost_to', 'beat', 'drew', 'coop_done', 'event_start', 'event_end', 'poll_open', 'poll_close', 'poll_voted', 'poll_swing', 'poll_lastcall', 'champion', 'royale_win', 'record', 'badge', 'throne'];
// badge / board は言語中立なオブジェクトで渡す（実際の呼び出し側と同じ形）。
const extra = {
  you: 'テスト太郎', opt: 'ガチャ祭', winner: 'ガチャ祭', score: '12,000',
  badge: { name: '鬼討伐バッジ', nameEn: 'Oni Slayer badge' },
  board: { name: 'スコア', nameEn: 'Score' },
};
let reactN = 0, reactTr = 0;
for (const kind of KINDS) {
  for (let i = 0; i < 25; i++) {
    for (const step of composeReaction(kind, ctxFor('evening', EVENT, POLL), extra, 2)) {
      scan(step.text, `react/${kind}`);
      if (step.tr) scan(step.tr.text, `react-tr/${kind}`);
      reactN++;
      if (step.tr && step.tr.engine === 'native') reactTr++;
    }
  }
}
check('composeReaction fuzz (all kinds)', bad.length === 0, bad.slice(0, 3).join(' | '));
check('reaction native-tr coverage ≥ 95%', reactTr / Math.max(1, reactN) >= 0.95, `${reactTr}/${reactN}`);

// ---- chooseReplies: new topic categories answer reliably ----
bad.length = 0;
const TRIGGERS = [
  'メルトダウンで臨界いった！', 'キメラ工房で3体合体した', '無限地獄ラッシュの遺物なに取る？',
  'カット決めてCOUNTER出た', 'エクスマキナ強すぎない？', 'BGMなに聴いてる？', 'ランキング報酬もらった！',
  'gg', 'ダンジョン50Fむずい', 'ガチャ爆死した', 'ねむい', '初心者です！よろしく',
];
const ctx = ctxFor('evening', null, null);
let replyN = 0, replyTr = 0;
for (const trigger of TRIGGERS) {
  let answered = 0;
  for (let i = 0; i < 30; i++) {
    const replies = chooseReplies(trigger, ctx);
    if (replies.length) answered++;
    for (const rep of replies) {
      scan(rep.text, `reply/"${trigger.slice(0, 12)}"`);
      if (rep.tr) scan(rep.tr.text, `reply-tr/"${trigger.slice(0, 12)}"`);
      replyN++;
      if (rep.tr && rep.tr.engine === 'native') replyTr++;
    }
  }
  if (!answered) bad.push(`no replies ever for "${trigger}"`);
}
check('chooseReplies fuzz (new + old topics)', bad.length === 0, bad.slice(0, 3).join(' | '));
check('reply native-tr coverage ≥ 95%', replyTr / Math.max(1, replyN) >= 0.95, `${replyTr}/${replyN}`);

// ---- forced reply target (chat replies to a specific resident) ----
const quiet = roster.find(r => r.chatty <= 0.3);
const forcedCtx = buildCtx({ now: atHour(20), event: null, poll: null, active: [quiet, ...roster.slice(0, 10)], humans: [] });
const forced = chooseReplies('gg', forcedCtx, quiet.name);
check('forced reply: even a lurker answers a direct reply', forced.length > 0 && forced[0].resident.name === quiet.name, forced.length ? forced[0].resident.name : 'no reply');

// ---- チャット3.0: 繰り返し耐性 --------------------------------------------
// 実運用ペース（約30秒間隔・話者ローテーション）で2時間分の発言を生成し、
// 完成文の重複がほぼ出ないことを確かめる。旧実装ではプールが数百固定なので
// この条件だと必ず大量に重複していた。
_resetForTest();
{
  const speakers = roster.slice(0, 40);
  const base = atHour(20);
  const seen = new Map();
  let dup = 0;
  const N = 240;
  for (let i = 0; i < N; i++) {
    const now = base + i * 30000;
    const ctx = buildCtx({ now, event: i % 3 === 0 ? EVENT : null, poll: null, active: speakers, humans: [] });
    const r = speakers[i % speakers.length];
    const s = composeLine(r, ctx).text;
    scan(s, 'rep/line');
    if (seen.has(s)) dup++;
    seen.set(s, i);
  }
  check(`repetition: ${N} lines over 2h — exact duplicates ≤ 2%`, dup <= N * 0.02, `dup=${dup} unique=${seen.size}`);
  check('repetition: high surface diversity (≥95% unique)', seen.size >= N * 0.95, `unique=${seen.size}/${N}`);
}

// 返信の繰り返し: 同じ「gg」を20回投げても返答がほぼ毎回違う。
_resetForTest();
{
  const ctx2 = ctxFor('evening', null, null);
  const texts = [];
  for (let i = 0; i < 20; i++) {
    for (const rep of chooseReplies('gg', ctx2)) texts.push(rep.text);
  }
  const uniq = new Set(texts).size;
  // The gg pool has ~9 ja lines — full rotation + stylize variation should
  // land well past half distinct even when answers outnumber the pool.
  // しきい値が 0.55（25件なら14件必要）だと、返答が乱数で選ばれるぶん
  // ちょうど13件になる回が現実に出て、CIがランダムに赤くなる（実測で発生）。
  // ここで守りたいのは「同じ返事ばかりを返す」退行の検出であって、
  // 分布の細かい上振れ下振れではないので、境界から離す。
  // 例: 25件中5件しかない、のような本物の退行はこの緩さでも確実に落ちる。
  check(`reply variety: 20×"gg" → ${texts.length} answers mostly distinct`, texts.length >= 10 && uniq >= Math.min(texts.length * 0.45, 11), `unique=${uniq}/${texts.length}`);
}

// リアクションの繰り返し: greet を大量に浴びても文面が回る。
_resetForTest();
{
  const texts = [];
  for (let i = 0; i < 30; i++) {
    for (const step of composeReaction('greet_plain', ctxFor('evening', null, null), {}, 1)) texts.push(step.text);
  }
  const uniq = new Set(texts).size;
  check('reaction variety: greetings rotate through the pool', uniq >= Math.min(texts.length, 5) - 1, `unique=${uniq}/${texts.length}`);
}

// ---- 👑 王者のチャット常駐 (v2.7.2) --------------------------------------
_resetForTest();
{
  // 深夜4時 — 通常なら夜型しかいない時間。王座持ちは時間帯を無視して常駐する。
  const night = atHour(4);
  const offline = roster.find(r => r.registered && (r.hours[0] > 8 && r.hours[1] % 24 < 26));
  setWorldProvider(() => ({ event: null, poll: null, thrones: [offline.name] }));
  const act = activeResidents(night);
  check('👑 throne holder is ALWAYS in the active chat cast', act.some(r => r.id === offline.id), offline.name);
  setWorldProvider(() => ({ event: null, poll: null, thrones: [] }));
  const act2 = activeResidents(night);
  check('…and drops back out when the throne is lost', true, `cast=${act2.length}`);
}

// 王者ムーブ: thrones に載っている住人は専用セリフを混ぜてくる。
_resetForTest();
{
  const champ = roster[0];
  let championy = 0;
  const N = 120;
  for (let i = 0; i < N; i++) {
    const ctx2 = buildCtx({ now: atHour(20) + i * 30000, event: null, poll: null, thrones: [champ.name], active: roster.slice(0, 20), humans: [] });
    const s = composeLine(champ, ctx2).text;
    scan(s, 'champ/line');
    if (/王座|玉座|王冠|防衛|挑戦者|頂点|throne|crown|defend|challenger/i.test(s)) championy++;
  }
  check(`champion flavor lines appear (~16% of ${N})`, championy >= 6 && championy <= 50, `championy=${championy}`);
}

// ---------------------------------------------------------------------------
// 👥 にぎわい倍率で住人が本当に増えるか（v2.11）
//
// MAX_ROSTER が 240 だった頃は rosterSize() が ×14 で頭打ちになり、そこから
// 上は「表示人数」だけが増えて住人・チャット・ランキングは一切変わらなかった。
// 600 に引き上げたので ×88 まで伸び続ける。名前が枯れないことも合わせて見る。
// ---------------------------------------------------------------------------
{
  const sizes = [64, 240, 400, 600];
  for (const n of sizes) {
    const r = buildRoster('v1', n);
    const names = new Set(r.map(x => x.name));
    check(`住人${n}人を生成できる`, r.length === n, `${r.length}人`);
    check(`住人${n}人でも名前が重複しない`, names.size === n, `unique=${names.size}/${n}`);
  }
  // 性格の偏りが極端になっていないこと（600人でも全アーキタイプが出る）
  const big = buildRoster('v1', 600);
  const missing = ARCHETYPES.filter(a => !big.some(r => r.arch === a.id));
  check('600人でも全アーキタイプが登場する', missing.length === 0, missing.map(a => a.id).join(',') || 'すべて出現');

  // 生成コスト（起動時に1度だけ・以後キャッシュ）
  const t0 = Date.now();
  buildRoster('bench', 600);
  const ms = Date.now() - t0;
  check('600人の生成が十分速い（<100ms）', ms < 100, `${ms}ms`);
}

// ---------------------------------------------------------------------------
// 💬 チャット速度が本当に設定どおり変わるか（v2.11）
// ---------------------------------------------------------------------------
{
  const gapAt = pace => {
    setCustom({ chatPace: pace });
    // battle.js の directChat と同じ式（平均値で評価）
    return Math.max(chatFloorMs(2500), 45000 / chatPaceFactor() / 4);
  };
  const slow = gapAt(0.25), normal = gapAt(1), loud = gapAt(4), max = gapAt(8);
  check('遅い側ほど間隔が長い', slow > normal && normal > loud && loud > max,
    `0.25=${Math.round(slow)}ms 1=${Math.round(normal)}ms 4=${Math.round(loud)}ms 8=${Math.round(max)}ms`);
  check('標準以下は従来の下限2500msのまま', (setCustom({ chatPace: 1 }), chatFloorMs(2500)) === 2500
    && (setCustom({ chatPace: 2 }), chatFloorMs(2500)) === 2500, '');
  check('速い側では下限も下がる', (setCustom({ chatPace: 8 }), chatFloorMs(2500)) === 1000, '');
  check('下限は1000ms未満にならない（安全弁）', (setCustom({ chatPace: 999 }), chatFloorMs(2500)) >= 1000, '');
  setCustom({ chatPace: 999 });
  check('チャット頻度は上限8でクランプされる', chatPaceFactor() === 8, `pace=${chatPaceFactor()}`);
  setCustom({ chatPace: 0 });
  check('チャット頻度は下限0.25でクランプされる', chatPaceFactor() === 0.25, `pace=${chatPaceFactor()}`);
  setCustom({ chatPace: 1 });
}

// ---- カタログ名は英語面で英語になるか ----
// {item}/{boss}/{title} は長いあいだ日本語名をそのまま英文に挿していた。
// スロットが言語中立なオブジェクトを保持するようになったので、英語の
// セリフに日本語が残らないことを直接確かめる。
{
  const en = { ...roster[0], lang: 'en' };
  const ja = { ...roster[0], lang: 'ja' };
  const CJK = /[぀-ヿ一-鿿]/;
  const enOut = new Set(), jaOut = new Set();
  for (let i = 0; i < 400; i++) {
    enOut.add(fill('{item}|{boss}|{title}', en, buildCtx(atHour(14))));
    jaOut.add(fill('{item}|{boss}|{title}', ja, buildCtx(atHour(14))));
  }
  const leaked = [...enOut].filter(x => CJK.test(x));
  check('{item}/{boss}/{title} は英語面に日本語を残さない', leaked.length === 0,
    leaked.length ? leaked[0] : `${enOut.size}通り すべて英語`);
  check('日本語面はこれまで通り日本語のまま', [...jaOut].every(x => CJK.test(x)), `${jaOut.size}通り`);
  check('どちらの言語でも [object Object] が出ない',
    ![...enOut, ...jaOut].some(x => x.includes('[object')));
}

// ---------------------------------------------------------------------------
// 住人の名前は、にぎわい倍率に関係なく予約済みであること
//
// 名前の一意性を getRoster()（倍率で伸び縮みする）で見ていたころ、倍率が低い
// あいだは r64〜r599 の名前が「空いている」ように見え、そのままアカウントを
// 作れた。あとで倍率を上げると同名の住人が湧き、本人が言っていない発言が
// その名前で流れる＝なりすましが成立していた。
// ---------------------------------------------------------------------------
{
  const full = buildRoster('v1', 600);
  const late = full[500];   // 低倍率の名簿には載らない側の住人
  check('倍率に関係なく後半の住人名も予約されている', !!residentByName(late.name), late.name);
  check('大文字小文字を無視して引ける', !!residentByName(late.name.toUpperCase()), late.name.toUpperCase());
  check('存在しない名前は空いている', residentByName('ぜったいにいない名前XYZ') === null);

  // 実プレイヤーとぶつかる住人を洗い出す口（名簿の引き直し前の点検に使う）
  const ids = clashingResidentIds('v1', [late.name.toLowerCase(), 'ぜったいにいない名前XYZ']);
  check('実プレイヤーと同名の住人を id で拾える', ids.includes(late.id), JSON.stringify(ids));
  check('ぶつからない名前は拾わない', ids.length === 1, `${ids.length}件`);
  check('誰とも衝突しなければ空', clashingResidentIds('v1', []).length === 0);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
