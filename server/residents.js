// Residents (住人): a persistent cast of simulated players with personalities.
//
// Every resident has an archetype (who they are), a skill level, an activity
// window and a language. The same resident shows up everywhere — chatting in
// the lobby, sitting on the leaderboards with matching stats, and fighting as
// a disguised bot with a matching rating — so the crowd reads as one world
// rather than a pile of random names.
//
// The roster is generated deterministically from a seed, so it is identical
// after every restart (the data directory is ephemeral on the free tier).
// Admin edits (removed / added residents) are stored separately and applied
// on top.

import { TITLES } from './catalog.js';
import { dailyGhostFactor } from './daily.js';
// 段位（帯）の唯一の正解。ここに帯の表を手書きすると、画面とサーバーで
// 「ゴールドなのにプラチナ扱い」がいつか必ず起きる。server/catalog.js が
// public/js/catalog-en.js を読んでいるのと同じ作法で、素のJSを直に読む。
import { bandOf, rankOf } from '../public/js/ranks.js';

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

export function strHash(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 0..1 noise that is stable for a (key, bucket) pair.
export function unit(key, bucket) {
  return strHash(`${key}|${bucket}`) / 4294967296;
}

export function jstHour(now = Date.now()) {
  return (now / 3600000 + 9) % 24;
}

export function jstDay(now = Date.now()) {
  return Math.floor((now + 9 * 3600000) / 86400000);
}

// 0 = Sunday … 6 = Saturday, in JST.
export function jstWeekday(now = Date.now()) {
  return (jstDay(now) + 4) % 7;
}

// 週の何日目か（0=月曜 … 6=日曜）。境目は index.js の currentWeekNum と同じ
// 「月曜 00:00 UTC」に合わせてある（Unix エポックは木曜なので4日ずらす）。
// ここを jstDay ベース（JSTの月曜 00:00）にすると 9 時間ぶんズレて、weekId が
// まだ変わっていないのに日数カウンタだけ先に 0 へ戻る — つまり週の途中で
// ウィークリー記録が減る、という直したはずの不具合が週1回だけ蘇る。
const WEEK_MS = 7 * 86400000;
function weekDayIndex(now = Date.now()) {
  const ms = (((now - 4 * 86400000) % WEEK_MS) + WEEK_MS) % WEEK_MS;
  return Math.floor(ms / 86400000);
}

// ---------------------------------------------------------------------------
// Name pools
// ---------------------------------------------------------------------------

export const JA_NAMES = [
  'そらまめ', 'ゆきんこ', 'たける', 'ミントアイス', 'ぽんず', 'カイト', 'りんごあめ', 'ネオ',
  'しろくま', 'ハヤテ', 'こむぎ', 'レンレン', 'あおいそら', 'ツバサ', 'もちもち', 'さくらんぼ',
  'ダイチ', 'ひなたぼっこ', 'けんちゃん', 'ミサキ', 'ふうか', 'ショウ', 'まったり勢', 'ブロック職人',
  'コンボマスター', 'ぷにぷに', 'たこやき8個', 'メロンソーダ', 'ゆるふわ', 'ガチで勝つ', 'パズル王',
  '夜ふかし中', 'おにぎり', 'ラムネ', 'きつねうどん', 'スバル', 'ノア', 'ハルカ', 'リク', 'ユウナ',
  'ソウタ', 'ミオ', 'カエデ', 'イツキ', 'ホシゾラ', 'クロネコ', 'シルバー', 'タピオカ', 'ちくわ',
  'ぺんぎん', 'マグロ', 'うさぎさん', 'カフェオレ', 'ドラゴン太郎', 'ミルクティー', 'ハンバーグ',
  'ポテチ', 'ゼリービーンズ', 'しゅわしゅわ', 'ねむい', 'ブロッコリ', 'キラキラ星', 'マカロン',
  'おこめ', 'とうふメンタル', 'スナイパー', 'いちごみるく', 'カミナリ', 'よもぎもち', 'アルト',
  'ゆず茶', 'こたつ猫', 'ソーダフロート', 'わたあめ', 'ちゃちゃまる', 'ふわもこ', 'キウイ',
  'レモンサワー', 'プリンアラモード', 'ミルフィーユ', '深夜のブロッカー', 'つよつよ勢',
  'エンジョイ勢', 'ぴよぴよ', 'ホットケーキ', 'グミベア', 'ラテアート', 'おでんくん',
  'みかんの皮', 'さばみそ', 'ねこまんま', 'あずきバー', 'コロッケ', 'おもち', 'ラーメン二郎',
  'たぬきそば', 'しらたま', 'くまのぬいぐるみ', 'サイダー', 'ひよこ豆', 'カツカレー', 'メンマ',
  'ほうじ茶', 'なると', 'じゃがりこ', 'ぶどうグミ', 'バニラ', 'ルイボス', 'ちゃんぽん',
  'ヒカリ', 'レイ', 'アオイ', 'サナ', 'ヨシキ', 'ユウト', 'ミナト', 'ヒロ', 'カンナ', 'セナ',
  'りんりん', 'ぽてと', 'ねむねむ', 'ぴぃ', 'もも', 'くるみ', 'あんこ', 'きなこ', 'まろん', 'むぎ',
];

export const EN_NAMES = [
  'Blocky', 'PuzzleFox', 'NovaStar', 'PixelCat', 'MrCombo', 'Sakura99', 'BlockMaster',
  'Zenith', 'Comet', 'Mocha', 'Waffle', 'Prism', 'Lucky7', 'IceWolf', 'StarDust',
  'GridKing', 'Nebula', 'ComboQueen', 'Turbo', 'Panda88',
  'BlockNinja', 'CosmicRay', 'PuzzleWiz', 'NightOwl', 'Cherry', 'Maple', 'Frosty',
  'Echo', 'Rocket', 'Pudding', 'Biscuit', 'Shadow7', 'Kai', 'Luna', 'Milo', 'Aria',
  'Zed', 'Juniper', 'Pixel', 'Atlas', 'Bolt', 'Clover', 'Dusk', 'Ember', 'Fable',
  'Gizmo', 'Halo', 'Indigo', 'Jinx', 'Koda', 'Lumen', 'Mochi', 'Nimbus', 'Orbit',
  'Quill', 'Rune', 'Sprout', 'Tango', 'Umber', 'Vega', 'Wisp', 'Yuki', 'Zephyr',
  'TetraTom', 'LineLord', 'ClearQueen', 'BigBrain', 'SleepyJoe', 'CoffeeCat',
];

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------
// hours: JST active window [start, end); end may exceed 24 to wrap past midnight.
// quirk: how the character "types" — applied when composing lines.

export const ARCHETYPES = [
  { id: 'newbie',   label: '初心者',       labelEn: 'Newbie',        w: 14, skill: [0.05, 0.35], chatty: 1.1, emoji: 0.30, lang: 'ja', modes: ['solo', 'ai', 'dungeon', 'boss'],          hours: [17, 24], quirk: 'polite',  newbie: true },
  { id: 'tryhard',  label: 'ガチ勢',       labelEn: 'Tryhard',       w: 12, skill: [0.68, 0.98], chatty: 0.8, emoji: 0.12, lang: 'ja', modes: ['pvp', 'tourney', 'sprint', 'weekly'],      hours: [20, 27], quirk: 'terse' },
  { id: 'casual',   label: 'エンジョイ勢', labelEn: 'Casual',        w: 16, skill: [0.30, 0.65], chatty: 1.0, emoji: 0.35, lang: 'ja', modes: ['solo', 'coop', 'boss', 'chaos', 'survival'], hours: [12, 25], quirk: 'w' },
  { id: 'nightowl', label: '夜型',         labelEn: 'Night Owl',     w: 9,  skill: [0.40, 0.85], chatty: 1.0, emoji: 0.20, lang: 'ja', modes: ['pvp', 'dungeon', 'survival', 'royale'],    hours: [23, 29], quirk: 'dots' },
  { id: 'morning',  label: '朝活勢',       labelEn: 'Early Bird',    w: 6,  skill: [0.35, 0.75], chatty: 0.9, emoji: 0.25, lang: 'ja', modes: ['weekly', 'sprint', 'solo'],                 hours: [5, 10],  quirk: 'polite' },
  { id: 'global',   label: '海外勢',       labelEn: 'International', w: 12, skill: [0.25, 0.90], chatty: 0.9, emoji: 0.30, lang: 'en', modes: ['pvp', 'solo', 'dungeon', 'coop'],           hours: [21, 33], quirk: 'lol' },
  { id: 'gacha',    label: 'ガチャ中毒',   labelEn: 'Gacha Addict',  w: 7,  skill: [0.30, 0.70], chatty: 1.2, emoji: 0.45, lang: 'ja', modes: ['solo', 'chaos', 'boss'],                   hours: [18, 26], quirk: 'excite' },
  { id: 'explorer', label: '探索者',       labelEn: 'Explorer',      w: 9,  skill: [0.45, 0.85], chatty: 0.9, emoji: 0.15, lang: 'ja', modes: ['dungeon', 'boss', 'survival', 'raid'],     hours: [19, 26], quirk: 'dots' },
  { id: 'senpai',   label: '優しい先輩',   labelEn: 'Mentor',        w: 6,  skill: [0.70, 0.95], chatty: 1.3, emoji: 0.20, lang: 'ja', modes: ['pvp', 'coop', 'raid', 'dungeon'],          hours: [19, 25], quirk: 'tilde' },
  { id: 'kid',      label: '小学生',       labelEn: 'Kid',           w: 7,  skill: [0.10, 0.50], chatty: 1.4, emoji: 0.55, lang: 'ja', modes: ['boss', 'chaos', 'solo', 'coop'],           hours: [16, 21], quirk: 'bang' },
  { id: 'streamer', label: '配信者',       labelEn: 'Streamer',      w: 3,  skill: [0.55, 0.90], chatty: 1.2, emoji: 0.35, lang: 'ja', modes: ['royale', 'tourney', 'pvp', 'chaos'],       hours: [20, 25], quirk: 'excite' },
  { id: 'lurker',   label: 'ROM専',        labelEn: 'Lurker',        w: 8,  skill: [0.20, 0.80], chatty: 0.25, emoji: 0.10, lang: 'ja', modes: ['solo', 'weekly', 'sprint'],               hours: [10, 26], quirk: 'terse' },
];

export function archetype(id) {
  return ARCHETYPES.find(a => a.id === id) || ARCHETYPES[2];
}

// ---------------------------------------------------------------------------
// Roster generation
// ---------------------------------------------------------------------------

export const ROSTER_SIZE = 64;

// 👑 アリーナの頂点。運営が名指しで決めた「住人の中でいちばん強い人」。
//
// 住人の強さは makeResident の skill（0〜1）で決まり、レートも勝率も適性も
// すべてそこから導かれる。だから最強を作るには skill を最上位に固定すればよく、
// レート式（ratingFor）や勝率式に例外を足す必要はない ── 式を触ると
// 「住人の変装レートとランキング表示がズレる」というこのコードベースが最も
// 嫌う穴を開けることになる。
//
// 名前は JA_NAMES にも入っているので、ロースターの引きによっては普通の住人
// としても選ばれうる。makeResident 側でこの名前を見たら必ず王者の値に
// 差し替えるので、どちらの経路でも「ちゃちゃまるは最強」が保たれる。
export const CHAMPION = {
  name: 'ちゃちゃまる',
  arch: 'tryhard',      // ガチ勢（PvP・大会・タイムアタックに出る）
  skill: 0.995,         // どのアーキタイプの上限(0.98)よりも高い＝常に最上位
};
// Day index (JST) of the arena's launch — resident "join dates" hang off it.
const LAUNCH_DAY = jstDay(Date.UTC(2026, 6, 20, 15));

// 👑 王者かどうか。名前で決めるのが本筋だが、名簿の引き直しで名前が変わった
// 過去データも拾えるよう skill でも見る（他のアーキタイプの上限は 0.98 なので、
// 0.995 に届くのは王者だけ）。
export function isChampion(r) {
  return !!r && (r.name === CHAMPION.name || r.skill >= CHAMPION.skill);
}

// ---------------------------------------------------------------------------
// 👑 「住人の中でいちばん強い」を、式のどの入り口でも崩れないようにする
// ---------------------------------------------------------------------------
// これまで王者を最強にしていたのは skill(0.995) と天井の帯(CHAMP_CAP)だけで、
// それ以外の入り口 ── 得意分野(aptitude)・練習の間隔と当たり外れ(personalBest)・
// 3日ごとの調子(moodFor)・週や日の運(weeklyBest / residentDailyScore)・
// 参加日(joinedDay) ── は全部ふつうに乱数だった。だから
//
//   ・ハイスコア部門: 練習日が2日おきの住人が、5日おきの王者を追い抜く
//   ・レート部門: 王者の調子が -1、相手が +1 の日に逆転する
//   ・デイリー/ウィークリー部門: その日その週の運だけで決まるので日常的に負ける
//
// が起きていた（実測: ハイスコア部門に1件も出てこないボードがあった）。
// 個別に「王者だけ+α」を足すと式が嘘をつき始めるので、**同じ式に、いちばん良い
// 入力を渡す** 形に統一する: 練習量も調子も運も常に最良、得意分野は全部得意。
// こうすると、どの項も他の住人以上なので、比較しなくても必ず上に来る。
//
//   ・skill      0.995 > 他の上限 0.98        （CHAMPION）
//   ・aptitude   1.16 = 得意分野の最大値       （下の aptitude）
//   ・patience   skill が高いほど早く伸びる    （personalBest）
//   ・練習の間隔 最短(2日) / ずれ 最大         （下の CHAMP_* とその使用箇所）
//   ・当たり外れ 常に上振れ(luck=1)
//   ・調子       常に絶好調(mood=+1)
//   ・参加日     いちばん古い ＝ 練習日数が最大 （makeResident）
//   ・天井       CHAMP_CAP は他の帯と重ならない（下）
//
// 「王者だけ別式」ではないので、レート上限2600・塔99F・タイムアタック59,000 と
// いった **頂は人間に残す** 約束はそのまま効く。
const CHAMP_APTITUDE = 1.16;   // aptitude() が返しうる最大値（favMode と同じ）
const CHAMP_CADENCE = 2;       // personalBest の練習間隔の最小値
const CHAMP_LUCK = 1;          // 当たり外れ（unit の上限）
const CHAMP_MOOD = 1;          // 調子 moodFor の上限
// 👑 王者の敗北数。**0敗（無敗）**。
//
// 前の波では「147勝0敗は作り物に見える」と判断して 2% の負けを決定論的に
// 持たせていた。ユーザーの決定はその逆で、「不自然に見えるから負けを足す」
// のではなく「**本当に負けないだけの強さを与えて0敗を実態にする**」。
// 実装は server/battle.js 側 ── 王者が対戦相手として出るときだけ専用の
// 最強AI（public/js/ai.js の souzou / 全順列読みのビームサーチ）を使う。
// 実測の勝率はそのタスクの numbers に残してある。
// ここを 0 以外に戻すときは、その最強AIの実測勝率と必ずセットで考えること。
const CHAMP_LOSSES = 0;

// ---------------------------------------------------------------------------
// 上限への「張り付き」を崩す、住人ごとの天井
// ---------------------------------------------------------------------------
// 各ボードには絶対上限がある（頂は人間に残す、という約束）。ところが最上位の
// 住人はその上限に **ちょうど** 届いてしまうので、レート2600・塔99F・
// タイムアタック59,000 が同時にきっかり並ぶ ── 本物のプレイヤーの記録が
// 3つのボードで同時に理論値ぴったりで止まることは起こらないので、
// 「この人は計算式です」と数字が白状しているのと同じだった。
//
// そこで上限そのものを、住人ごとに 0.97〜0.999 倍のあたりへずらす。
//   ・自己ベスト系は **日付を見ない**（seed だけ）。日で動かすと天井が下がった
//     日に自己ベストが縮み、「自己ベストは下がらない」が壊れる。
//   ・レートだけは調子(mood)と同じ3日ブロックで天井も動かす。レートは
//     上下してよい数字なので、ここで日付の揺らぎを受け持つ。
//
// ⚠ 王者の帯 (0.994〜0.999) と他の住人の帯 (0.970〜0.988) は **重ならない**。
//   天井に届く住人が何人いても、王者の天井が必ずいちばん高い ＝ 王者は
//   引き続き「全住人の頂点」であり続ける（ユーザーの明示要求）。
const CHAMP_CAP = [0.994, 0.005];
const OTHER_CAP = [0.970, 0.018];
function capFactor(r, bucket) {
  const [base, span] = isChampion(r) ? CHAMP_CAP : OTHER_CAP;
  return base + unit(r.id, `cap:${bucket}`) * span;
}
// 自己ベスト系（時間に依らない天井 ＝ 単調性を壊さない）
function capOf(r, key, cap) {
  return Math.floor(cap * capFactor(r, key));
}
// レートの天井だけは3日ごとに揺れる（調子のブロックと同じ刻み）
function ratingCapOf(r, day) {
  return Math.floor(2600 * capFactor(r, `R${Math.floor(day / 3)}`));
}

function weightedPick(list, rnd) {
  const total = list.reduce((a, x) => a + (x.w || 1), 0);
  let r = rnd() * total;
  for (const x of list) { r -= (x.w || 1); if (r <= 0) return x; }
  return list[list.length - 1];
}

function makeResident(i, rng, forced = {}) {
  const arch = forced.arch ? archetype(forced.arch) : weightedPick(ARCHETYPES, rng);
  const lang = forced.lang || arch.lang || 'ja';
  let name = forced.name;
  if (!name) {
    const pool = lang === 'en' ? EN_NAMES : JA_NAMES;
    name = pool[Math.floor(rng() * pool.length)];
    if (rng() < 0.22) name += String(10 + Math.floor(rng() * 90));
  }
  let skill = arch.skill[0] + (arch.skill[1] - arch.skill[0]) * rng();
  // 王者は引きに関係なく最上位。名前が一致した時点で強さを固定する。
  if (name === CHAMPION.name) skill = CHAMPION.skill;
  const len = arch.hours[1] - arch.hours[0];
  // Jitter the window a little so two residents of one archetype differ.
  const start = (arch.hours[0] + Math.floor(rng() * 3) - 1 + 24) % 24;
  const joinedDay = arch.newbie
    ? null                                   // "joined recently" — resolved at read time
    : LAUNCH_DAY - 30 + Math.floor(rng() * 60);
  const out = {
    id: forced.id || `r${i}`,
    name, arch: arch.id, lang,
    skill: Math.round(skill * 1000) / 1000,
    chatty: Math.round(arch.chatty * (0.7 + 0.6 * rng()) * 100) / 100,
    emoji: arch.emoji,
    quirk: arch.quirk,
    modes: arch.modes,
    favMode: arch.modes[Math.floor(rng() * arch.modes.length)],
    hours: [start, start + len],
    registered: arch.newbie ? rng() < 0.6 : rng() < 0.93,
    joinedDay,
    custom: !!forced.name,
  };
  // 👑 王者は「引きで普通の住人として出た回」でも王者にそろえる。
  // これまで差し替えていたのは skill だけだったので、たまたま夜型として
  // 引かれた回のちゃちゃまるは modes に sprint / tourney を持たず、
  // aptitude が 0.87 に落ちてタイムアタックのボードで他の住人に負けていた
  // （buildRoster のコメントが約束している「どちらの経路でも最強」が、
  //  引きによっては嘘になっていた）。乱数の消費順は変えていないので、
  //  他の住人の内容はこれまでと1ビットも変わらない。
  if (name === CHAMPION.name) {
    const ca = archetype(CHAMPION.arch);
    out.arch = ca.id;
    out.modes = ca.modes;
    out.favMode = 'pvp';
    out.lang = 'ja';
    out.registered = true;
    // 参加日はいちばん古い日に固定する（他の住人は LAUNCH_DAY-30 〜 +29 の引き）。
    // 自己ベストの「練習日の回数」は age から出るので、ここが遅い引きになると、
    // 古参の住人のほうが練習量で上回ってハイスコア部門を持っていってしまう。
    // アリーナの開幕からいる ＝ 王者、というのは設定としても自然。
    out.joinedDay = LAUNCH_DAY - 30;
  }
  return out;
}

export function buildRoster(seed = 'v1', size = ROSTER_SIZE) {
  const rng = mulberry32(strHash(`bba-residents-${seed}`));
  const used = new Set();
  const roster = [];
  for (let i = 0; i < size; i++) {
    let r;
    for (let tries = 0; ; tries++) {
      r = makeResident(i, rng);
      if (!used.has(r.name)) break;
      if (tries > 8) {
        r.name += String(Math.floor(rng() * 900) + 100);
        // 連番が付いた ＝ この住人はもう王者ではない。makeResident は名前を見て
        // 強さを 0.995 に固定するので、ここで戻さないと「2人目のちゃちゃまる」
        // （ちゃちゃまる768 など）が skill 0.995 のまま残る。isChampion は
        // 名前だけでなく skill でも判定するので、その偽者が王者と同じ特別扱いを
        // 受け、ボードによっては本物より上に出ていた（600人の名簿で実際に発生）。
        // その属性の上限まで下げる ＝ 王者に次ぐ強さの、ふつうの住人になる。
        if (r.skill >= CHAMPION.skill) r.skill = archetype(r.arch).skill[1];
        break;
      }
    }
    used.add(r.name);
    roster.push(r);
  }
  // 王者が引かれなかった回でも必ず1人置く。
  // 差し替えるのは「いま最も強い住人」── 弱い住人を王者にすると、その人の
  // 元の強さぶんの席（初心者の層）が消えて分布が歪む。最強を最強で置き換える
  // なら層は動かない。決定論も保たれる（roster の中身は seed で決まるため）。
  if (!roster.some(r => r.name === CHAMPION.name)) {
    let top = 0;
    for (let i = 1; i < roster.length; i++) if (roster[i].skill > roster[top].skill) top = i;
    const base = roster[top];
    roster[top] = {
      ...base,
      name: CHAMPION.name,
      arch: CHAMPION.arch,
      skill: CHAMPION.skill,
      modes: archetype(CHAMPION.arch).modes,
      favMode: 'pvp',
      lang: 'ja',
      registered: true,
      // makeResident の王者ぶんと同じ。差し替え経路だけ base の参加日が
      // 残っていると、「引かれた回の王者」と「差し替えた回の王者」で
      // 自己ベストの伸びが変わる（＝名簿のシード次第で最強でなくなる）。
      joinedDay: LAUNCH_DAY - 30,
    };
  }
  return roster;
}

// Admin-added resident (name chosen by the admin).
export function customResident(spec, index) {
  const rng = mulberry32(strHash(`bba-custom-${spec.name}-${index}`));
  return makeResident(index, rng, {
    id: `x${index}`, name: String(spec.name).trim().slice(0, 16),
    arch: ARCHETYPES.some(a => a.id === spec.arch) ? spec.arch : undefined,
    lang: spec.lang === 'en' ? 'en' : spec.lang === 'ja' ? 'ja' : undefined,
  });
}

// ---------------------------------------------------------------------------
// Derived, slowly-drifting stats
// ---------------------------------------------------------------------------

// 帯（ブロンズ〜レジェンド）は public/js/ranks.js が唯一の正解。
// ここには表を持たない ── 以前はしきい値の写しを持っていて、片方だけ触ると
// 画面とサーバーで段位がズレる状態だった（住人の帯だけ6帯で止まっていて、
// レート1900以上の住人が全員「マスター」に丸められていたのもこれが原因）。
export function tierOf(rating) {
  const b = bandOf(rating);
  const r = rankOf(rating);
  return {
    // name / nameEn は**帯だけ**（ブロンズ〜レジェンド）。住人チャットの
    // {tier} スロットはこちらを使う ── 「◯◯に昇格した」は帯の単位のほうが
    // 自然で、段（I/II/III）まで言うと人間の話し方から浮く。
    name: b.name, nameEn: b.nameEn,
    // label / labelEn は段まで入った表示名（例「グランドマスター I」）。
    // 実プレイヤー側の表示（結果画面・段位一覧・対戦相手）はすべて段まで
    // 出しているので、管理画面の住人一覧だけ6帯時代の粒度で止まっていた。
    label: r.label, labelEn: r.labelEn,
  };
}

// ---------------------------------------------------------------------------
// 住人の成績 (v2.11 で作り直し)
//
// 以前は skill と age だけの閉じた式で、実測するとこうなっていた:
//   ・タイムアタックとサバイバルは「一生変わらない定数」
//     （14日測っても 11,933 / WAVE21 のまま）
//   ・ハイスコアは毎日きっかり +35 の直線
//   ・レートは ±45 の滑らかな sin 波
//   ・skill が1つしかないので、強い住人は全ボードで一律に強い
// つまり「誰も実際にプレイしていない」ことが数字から丸見えだった。
//
// 作り直しの方針:
//   1. 自己ベストは「階段」で伸びる — 数日おきの練習日に、当たり外れつきで
//      更新される。下がることはない（自己ベストなので）
//   2. レートは3日単位の「調子」ブロックで上下する。連勝・スランプが出る
//   3. 得意分野を持つ。アーキタイプの modes（ガチ勢=pvp/sprint、探索者=
//      dungeon など）をボード適性に反映するので、「パズルだけ異様に強い人」
//      が生まれる
//
// 制約: /api/leaderboard は頻繁に叩かれ、1行ごとにこれを呼ぶ。
// (住人, 日) に対して決定的で、同じ日のうちは何度読んでも同じ値であること。
// ---------------------------------------------------------------------------

// 得意なモードのボードでは伸びやすく、苦手なボードでは伸びにくい。
// 👑 王者だけは全ボードが得意（＝この関数が返しうる最大値）。
// 以前は王者もふつうに 0.87 を引くことがあり、タイムアタックやダンジョンの
// ボードで格下の住人に抜かれていた。
function aptitude(r, mode) {
  if (isChampion(r)) return CHAMP_APTITUDE;
  if (!mode) return 1;
  if (r.favMode === mode) return 1.16;
  if (r.modes && r.modes.includes(mode)) return 1.07;
  return 0.87;
}

// 自己ベスト。練習日ごとに1回挑戦し、出た記録の最大値を持つ。
// age に対して単調（更新しかしない）で、同じ日なら何度呼んでも同じ。
const MAX_STEPS = 60;
function personalBest(r, age, key, base, span, apt) {
  const champ = isChampion(r);
  // 👑 王者は「いちばん練習していて、いちばん出る」。間隔は最短、ずれは最大、
  //    出来は常に上振れ。他の住人の cadence は 2〜5・offset は 0〜cadence-1 なので、
  //    同じ age なら王者の steps が必ず最大になる（age≥1 で floor((age+c-1)/c) ≤
  //    floor((age+1)/2) が成り立つ）。
  const cadence = champ ? CHAMP_CADENCE : 2 + Math.floor(unit(r.id, `${key}c`) * 4);   // 2〜5日おきに挑戦
  const offset = champ ? cadence - 1 : Math.floor(unit(r.id, `${key}o`) * cadence);    // 全員が同じ日に伸びない
  const steps = Math.min(MAX_STEPS, Math.max(0, Math.floor((age + offset) / cadence)));
  const patience = 9 + (1 - r.skill) * 30;                             // 上手いほど早く頭打ち
  let best = base;
  for (let i = 0; i <= steps; i++) {
    const ceil = base + span * apt * (1 - Math.exp(-i / patience));
    // その日の出来。たまに大当たりが出て、それが記録として残る。
    const luck = champ ? CHAMP_LUCK : unit(r.id, `${key}:${i}`);
    const attempt = base + (ceil - base) * (0.55 + luck * 0.45);
    if (attempt > best) best = attempt;
  }
  return Math.floor(best);
}

// 調子（mood）: 3日ごとに切り替わるブロック。sin波と違って「連勝が続く」「急に
// 落ちる」が起きるので、日々見ていると人間がプレイしているように見える。rating 専用の
// 入力なので residentStats から切り出してある。
// 👑 王者だけは常に絶好調。ここを乱数のままにすると「王者の調子が -1、格下が +1」の
// 日にレート部門で抜かれる（mood は最大 ±70pt 動く）。
function moodFor(r, day) {
  if (isChampion(r)) return CHAMP_MOOD;
  const block = Math.floor(day / 3);
  const form = (unit(r.id, `f${block}`) - 0.5) * 2;                     // -1..1
  const formPrev = (unit(r.id, `f${block - 1}`) - 0.5) * 2;
  const blend = (day % 3) / 3;                                          // ブロック境界をなめらかに
  return formPrev * (1 - blend) + form * blend;
}

// レート式の唯一の実体。residentStats と residentsForLevel（軽量パス）の両方が
// これを呼ぶ — 式をここ以外に複製すると、住人の変装レートとランキング表示が
// ズレる（このコードベースが最も嫌う「数字から嘘がばれる」系の穴）。
// v2.14: 住人は大幅強化。それでもレートは 2600 止まり（Eloに上限は無いので勝ち
// 続ける人間は超えうる）— 頂は人間に残す。
function ratingFor(r, s, age, mood, day) {
  const climb = 1 - Math.exp(-age / (30 + (1 - s) * 60));
  const aptPvp = aptitude(r, 'pvp');
  // 上限は 2600 のままだが、住人ごとの天井（ratingCapOf）で 0.97〜0.999 倍の
  // あたりに散らす。全員がきっかり 2600 で止まる不自然さを消すため。
  return Math.min(ratingCapOf(r, day), Math.round(850 + Math.pow(s, 1.3) * 1600 * aptPvp * (0.72 + 0.28 * climb) + mood * 70));
}

// ---------------------------------------------------------------------------
// 🗒 実際に起きたことの差分（住人の戦績台帳）
// ---------------------------------------------------------------------------
// ここより上の成績は全部「種＋日付」から計算している。つまり **人間が住人に
// 勝っても相手の戦績は1ミリも動かない** ── これが「この人は計算式です」と
// いちばんはっきり白状する場所だった（ユーザーの指摘）。
//
//     表示される値 ＝ 計算で作る基準値（今までどおり日々動く）
//                   ＋ 実際に起きたことの差分（ここで保存する）
//
// 全部を実記録に置き換えては **いけない**。住人が対戦するのは人間と当たった
// ときだけなので、置き換えると600人のほとんどが「何日経っても1戦も増えない」
// になり、別の不自然さが生まれる。基準値は今までどおり日々伸び続けるので、
// 負けて下がったレートは時間とともに戻る ── 実在のプレイヤーが負けを取り返す
// のと同じ見え方になる。
//
// 置き場は db.meta.residentRecords。このファイルは db を知らない（純関数の
// 集まりで、テストも server 抜きで読む）ので、**読み口だけを注入してもらう**。
// 呼ぶたびに引き直すので、復元で db.meta ごと差し替わっても古い参照を掴まない。
// 注入が無いとき（テストや部分起動）は差分ゼロ ＝ 従来どおりの計算値になる。
//
// ■ キーは id ではなく **名前**（実測で決めた）
// 住人の id（r21）は「名簿の何番目か」でしかなく、名簿の大きさで指す人が変わる。
// buildRoster は最後に「王者が引かれなかったら**いちばん強い住人**を差し替える」
// ので、64人の名簿と600人の名簿では王者の id が別番号になる。実際、通しで
// 確かめると /api/profile（ambient.js の名前引き＝600人で組む）と
// 🏆ランキング（getRoster＝倍率ぶんの人数で組む）が同じ「ちゃちゃまる」に
// 別の id を返し、id をキーにすると **ランキングには1敗が出るのにプロフィール
// では0敗のまま** になった（受け入れ条件そのものを外す）。
// 名前は名簿の中で一意（buildRoster の used セット）で、実プレイヤーとも
// ぶつからない（clashingResidentIds が予約している）ので、どの経路から引いた
// 住人でも同じ行に当たる。名簿を引き直して居なくなった名前の行は、
// 誰も参照しないまま古い順に押し出されて消える。
//
// ⚠ 名前は運営が自由に付けられる（ambient.js の custom.extra）ので、
//   "__proto__" などのキーは必ず弾くこと。

// 台帳の行数の上限。db.json は保存のたびに丸ごと書き出す（同期＋fsync）ので、
// 伸び続ける入れ物を1つ足すと、そのまま「保存でイベントループが止まる時間」に
// なる。行ができるのは実際に人間と当たった住人だけだが、上限は必ず要る。
// 1行 70バイト前後なので 300行で約20KB。
export const RESIDENT_RECORD_MAX = 300;
// レートの差分が効く下限（基準値からの最大の下げ幅）。同じ住人を狩り続けても
// これ以上は下がらない ── 際限なく削れると、狩られた住人がランキングから
// 消えてしまい、それはそれで不自然だから。
const RECORD_RATING_DROP_MAX = 300;
// 絶対の床。BOT_RATING_BANDS.easy の下限（700）を割ると、その住人はどの帯の
// 変装候補にも入らなくなり、二度と対戦相手として出てこない。
const RECORD_RATING_FLOOR = 700;
// 台帳に貯める値の頭押さえ（db.json は外から差し替わりうるので読み書き両方で切る）。
const RECORD_RD_MAX = 2000;
const RECORD_COUNT_MAX = 100000;
const RECORD_SCORE_MAX = 1000000;
// レートへの効きを逓減させる刻み。同じ住人と同じ日に何度も当たると、
// 3戦ごとに 1 → 1/2 → 1/3 … と効きが落ちる。
const RECORD_FARM_STEP = 3;

// db.json 由来の値を数として信用しない（手で書き換えたファイルの復元もある）。
function recNum(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

let recordSource = () => null;
// server/battle.js が起動時に呼ぶ。引数 create が true のときだけ入れ物を作る
// （読むだけの経路 ── ランキング1行ごと ── で db.meta に空の欄を生やさない）。
export function setResidentRecordSource(fn) {
  recordSource = typeof fn === 'function' ? fn : () => null;
}
function recordTable(create = false) {
  const t = recordSource(create);
  return t && typeof t === 'object' && !Array.isArray(t) ? t : null;
}

// JSON.parse は "__proto__" を素の own プロパティとして作るし、住人の名前は
// 運営が自由に付けられる。名前で引く入れ物なので、必ずここを通す。
export function safeRecordKey(name) {
  const k = String(name == null ? '' : name);
  if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') return null;
  return k;
}

// この住人の差分。無ければ null（＝従来どおりの計算値だけ）。
export function residentRecord(r) {
  const key = r && safeRecordKey(r.name);
  if (!key) return null;
  const t = recordTable(false);
  if (!t) return null;
  const row = Object.prototype.hasOwnProperty.call(t, key) ? t[key] : null;
  if (!row || typeof row !== 'object') return null;
  return row;
}

// レートに差分を乗せる。上は住人ごとの天井（＝頂は人間に残す約束）、
// 下は上の2つの床。基準値は日々動くので、この足し算だけで「負けた翌週には
// 戻り始める」が成り立つ。
function ratingWithRecord(r, base, day, rec) {
  const row = rec === undefined ? residentRecord(r) : rec;
  if (!row) return base;
  const rd = recNum(row.rd, -RECORD_RD_MAX, RECORD_RD_MAX);
  if (!rd) return base;
  const floor = Math.min(base, Math.max(RECORD_RATING_FLOOR, base - RECORD_RATING_DROP_MAX));
  return Math.max(floor, Math.min(ratingCapOf(r, day), base + rd));
}

// 1試合ぶんを台帳に足す。呼ぶのは server/battle.js の endMatch だけ
// （レート戦の1対1で、相手に人間が居て、住人が変装で出ていたとき）。
//   outcome … 住人から見た結果（1 勝 / 0.5 引き分け / 0 敗）
//   score   … その試合で住人が実際に出した点。**上がるときだけ**自己ベストに残す
export function recordResidentMatch(r, { outcome, ratingDelta = 0, score = 0, now = Date.now() } = {}) {
  const key = r && safeRecordKey(r.name);
  if (!key) return null;
  const t = recordTable(true);
  if (!t) return null;
  const day = jstDay(now);
  let row = Object.prototype.hasOwnProperty.call(t, key) ? t[key] : null;
  if (!row || typeof row !== 'object') {
    row = t[key] = { w: 0, l: 0, rd: 0, bs: 0, at: 0, d: 0, dn: 0 };
  }
  // 同じ住人を1日に何度も狩ったとき、**レートへの効きだけ**を逓減させる。
  // 勝敗の数はそのまま積む（本当にその回数だけ対戦しているので、そこを
  // 削ると今度は「何度倒しても敗が増えない」という別の嘘になる）。
  // レートだけ守るのは、1人の都合でランキングの並びを動かせないようにするため。
  if (recNum(row.d, 0, 1e9) !== day) { row.d = day; row.dn = 0; }
  const damp = 1 / (1 + Math.floor(recNum(row.dn, 0, 9999) / RECORD_FARM_STEP));
  row.dn = Math.min(9999, recNum(row.dn, 0, 9999) + 1);
  // 引き分け（outcome === 0.5）はどちらにも数えない ── レートだけが動く。
  row.w = Math.min(RECORD_COUNT_MAX, recNum(row.w, 0, RECORD_COUNT_MAX) + (outcome === 1 ? 1 : 0));
  row.l = Math.min(RECORD_COUNT_MAX, recNum(row.l, 0, RECORD_COUNT_MAX) + (outcome === 0 ? 1 : 0));
  row.rd = recNum(recNum(row.rd, -RECORD_RD_MAX, RECORD_RD_MAX) + Math.round((Number(ratingDelta) || 0) * damp),
    -RECORD_RD_MAX, RECORD_RD_MAX);
  // 自己ベストは上がるときだけ。人間に勝たれても住人のベストは下がらない（当然）。
  const sc = recNum(score, 0, RECORD_SCORE_MAX);
  if (sc > recNum(row.bs, 0, RECORD_SCORE_MAX)) row.bs = sc;
  row.at = now;
  pruneResidentRecords(t);
  return row;
}

// 上限を超えたぶんを、最後に対戦した時刻が古い順に落とす。落ちた住人は
// 基準値だけに戻る ──「しばらく誰とも当たっていない人の記録が薄れる」なので、
// 見え方としても不自然にならない。
export function pruneResidentRecords(table) {
  const t = table || recordTable(false);
  if (!t) return 0;
  const keys = Object.keys(t);
  if (keys.length <= RESIDENT_RECORD_MAX) return 0;
  keys.sort((a, b) => (Number(t[a] && t[a].at) || 0) - (Number(t[b] && t[b].at) || 0));
  const drop = keys.length - RESIDENT_RECORD_MAX;
  for (let i = 0; i < drop; i++) delete t[keys[i]];
  return drop;
}

// rating だけを軽量に出す（personalBest の重いループを一切踏まない）。
// residentsForLevel がバトロワの席数ぶん呼ぶので、ここが軽いことが効く。
export function residentRating(r, now = Date.now()) {
  const day = jstDay(now);
  const seedN = strHash(r.id) % 1000;
  const joined = r.joinedDay === null ? day - (seedN % 14) : r.joinedDay;
  const age = Math.max(1, day - joined);
  // 差分は residentStats 側と**同じ関数**で乗せる。ここだけ素の値を返すと、
  // 変装レート（対戦相手として出るときの数字）とランキング表示がズレる。
  return ratingWithRecord(r, ratingFor(r, r.skill, age, moodFor(r, day), day), day);
}

export function residentStats(r, now = Date.now(), weekId = 'W0') {
  const day = jstDay(now);
  const seedN = strHash(r.id) % 1000;
  const joined = r.joinedDay === null ? day - (seedN % 14) : r.joinedDay;
  const age = Math.max(1, day - joined);
  const s = r.skill;

  // 調子（3日ブロック）と レート式は moodFor / ratingFor に集約してある
  // （residentsForLevel の軽量パスと必ず同値にするため — 式が分岐すると住人の
  // 変装レートとランキング表示がズレる）。上限や根拠は ratingFor 参照。
  const mood = moodFor(r, day);
  // 🗒 実際に起きたことの差分（人間と当たった住人にだけ行がある）。
  // 1行ぶんの引きなので、ランキング1行ごとに呼ばれても効かない。
  const rec = residentRecord(r);
  const aptPvp = aptitude(r, 'pvp');   // rating 以外（pvpWins）でも使う
  // v2.14: 住人は大幅強化 — ランキング上位は化け物級の記録になる。
  // それでも各ボードに絶対上限を残す。根拠は「人間の理論上限の内側」:
  //   ・スコアの不正対策クランプは 500点/秒 なので、長時間の本気の走りで
  //     100万点级に届きうる。住人は 900,000 で頭打ち。
  //   ・レートは 2600 止まり（Eloに上限は無いので、勝ち続ける人間は超えうる）
  //   ・王座は同値なら実プレイヤーが勝つ — どの王冠も理論上は奪還できる。
  const rating = ratingWithRecord(r, ratingFor(r, s, age, mood, day), day, rec);
  const level = Math.max(1, Math.min(60, 1 + Math.floor(age * (0.10 + s * 0.45))));
  // ここから下は全部「自己ベスト」— 練習日に更新され、下がらず、住人ごとに
  // 更新日がずれる。得意ボードほど天井が高い。
  // 上限（900,000 / 99 / 59,000 / 175,000）は据え置きのまま、住人ごとの天井
  // （capOf）でその 0.97〜0.999 倍のあたりに散らす ── 最上位が複数のボードで
  // 同時にきっかり上限へ張り付くのを止めるため。天井は seed だけで決まるので
  // 「同じ日なら同じ値」「自己ベストは下がらない」はどちらも保たれる。
  const scoreSpan = 5000 + Math.pow(s, 2) * 1000000;
  const scoreCap = capOf(r, 'sc', 900000);
  // 🗒 実際の対戦で出した点も自己ベストの候補にする（**上がるときだけ**）。
  // 実プレイヤー側も PvP のスコアが bestScore に載る（index.js の
  // scoreboardEligible）ので、住人だけ載らないのは扱いが違うということ。
  // 天井（capOf）は素の式と同じものを掛けるので「頂は人間に残す」は保たれ、
  // 基準値も台帳の値もどちらも単調なので、最大値も下がらない。
  const bestScore = Math.max(
    Math.min(scoreCap, personalBest(r, age, 'sc', 2500, scoreSpan, aptitude(r, 'solo'))),
    rec ? Math.min(scoreCap, recNum(rec.bs, 0, RECORD_SCORE_MAX)) : 0);
  // 99止まり: 塔100F制覇（🏰バッジ）は人間だけのものにしておく。
  const dungeonMax = Math.min(capOf(r, 'dg', 99), 1 + personalBest(r, age, 'dg', 0, Math.pow(s, 1.3) * 160, aptitude(r, 'dungeon')));
  // 👑 王者の「その週の運」は常に最良（他の住人は 0..1 の乱数）。
  // ここが乱数のままだと、ウィークリー部門は skill より運の寄与が大きいので
  // （weeklyMix = skill×0.6 + 運×0.4）、格下に日常的に抜かれる。
  const champ = isChampion(r);
  const wk = champ ? CHAMP_LUCK : unit(r.id, weekId);
  const weeklyMix = s * 0.6 + wk * 0.4;
  // ウィークリーは「その週でいちばん良かった1回」なので、週の途中で下がっては
  // いけない。以前は日ごとの調子 mood をそのまま掛けていたため、weekId が同じ
  // ＝同じ週のあいだに記録が最大2割減っていた（住人214人中160人で減少日あり）。
  // 実プレイヤー側は本物のベスト（index.js の weeklyBestOf）で単調なので、
  // 同じボードで住人だけが理由もなく後退して見える。週内の各日ぶんを引いて
  // その最大値を取れば、週の頭からは伸びる一方になり、月曜のリセットで
  // ちゃんと引き直される — 本物のウィークリーと同じ振る舞いになる。
  let weeklyForm = champ ? CHAMP_LUCK : 0;
  if (!champ) for (let d = weekDayIndex(now); d >= 0; d--) weeklyForm = Math.max(weeklyForm, unit(r.id, `wf${weekId}:${d}`));
  const badges = [];
  if (s > 0.8 && age > 15) badges.push('oni');
  if (s > 0.93 && age > 40) badges.push('kami');
  if (dungeonMax >= 100) badges.push('dungeon');
  if (s > 0.6 && age > 25 && seedN % 3 === 0) badges.push('maou');
  if (s > 0.75 && age > 30 && seedN % 5 === 0) badges.push('rush');
  if (s > 0.85 && age > 45 && seedN % 7 === 0) badges.push('tourney');
  // A title that matches what they've done (about half equip one).
  let title = null;
  if (seedN % 2 === 0) {
    const pick = badges.includes('kami') ? 'kamislayer'
      : badges.includes('tourney') ? 'tourneyking'
      : badges.includes('dungeon') ? 'towerlord'
      : badges.includes('oni') ? 'onislayer'
      : rating >= 1500 ? 'diamond'
      : rating >= 1200 ? 'rate1200'
      : bestScore >= 100000 ? 'score100k'
      : level >= 20 ? 'veteran'
      : age > 10 ? 'addict' : 'rookie';
    const t = TITLES.find(x => x.id === pick);
    // id を落とすと、画面側（catName）が英語名に引き当てられない。英語で
    // 遊んでいてもランキングとプロフィールの称号だけ日本語のまま並ぶ。
    // 実プレイヤー側（index.js の titleOf）は既に id 付きなので、ここが
    // 抜けていると同じ画面で日本語と英語が混ざる。
    if (t) title = { id: t.id, name: t.name, color: t.color };
  }
  const aptSprint = aptitude(r, 'sprint');
  const pvpWins = Math.floor(age * s * 1.8 * aptPvp);
  return {
    rating, level, bestScore, dungeonMax, age,
    tier: tierOf(rating),
    // 🗒 勝敗は「基準値 ＋ 実際に起きたこと」。人間に勝たれた住人は、
    // ランキングでもプロフィールでも本当に1敗増える。
    pvpWins: pvpWins + (rec ? recNum(rec.w, 0, RECORD_COUNT_MAX) : 0),
    // 👑 王者は 0敗（ユーザーの明示要求）。skill が 0.995 なので
    // (1-s)×0.8 は切り捨てで 0 になり、素の式でも 0 に落ちる ── つまり
    // 「王者だけ別式」を足しているのではなく、**足していた例外を外した**。
    // CHAMP_LOSSES は「まだ誰にも負けていない」の**初期値**であって、
    // 不変条件ではない。実際に人間へ負けたらここに敗が付く（ユーザーの決定：
    // 速さは人間の範囲に収め、戦績は実態に合わせる）。0敗を守っているのは
    // 数式ではなく battle.js の専用AIの強さのほう。
    pvpLosses: (champ ? CHAMP_LOSSES : Math.floor(age * (1 - s) * 0.8))
      + (rec ? recNum(rec.l, 0, RECORD_COUNT_MAX) : 0),
    // ウィークリーは週ごとにリセットされる記録なので、そこだけは（他の自己ベストの
    // ような）長期の階段ではなく「その週の調子」= weeklyMix と weeklyForm で決まる。
    weeklyBest: Math.floor(Math.pow(weeklyMix, 2) * 90000 * aptitude(r, 'weekly') * (0.8 + 0.4 * weeklyForm) + 800),
    // タイムアタックの理論上限は 1000点/秒 × 60秒 = 60,000。住人はその内側
    // （59,000 / 175,000）で頭打ち — 頂点そのものは人間に残す。
    sprintBest: Math.min(capOf(r, 'sp', 59000), personalBest(r, age, 'sp', 600, Math.pow(s, 2) * 62000, aptSprint)),
    sprint180: Math.min(capOf(r, 's3', 175000), personalBest(r, age, 's3', 2000, Math.pow(s, 2) * 186000, aptSprint)),
    survivalWave: Math.max(1, Math.min(capOf(r, 'sv', 99), personalBest(r, age, 'sv', 3, s * 95, aptitude(r, 'survival')))),
    badges, title,
  };
}

// 📅 デイリーチャレンジ（30ピース1発勝負）のその日の記録。
// (住人, JST日) に対して決定的 — 同じ日は何度読んでも同じで、日が変われば
// 全員の出来が入れ替わる。上位は2万点級、平均は数千点。1発勝負なので
// 自己ベストのような単調性は要らない（毎日リセットされる記録）。
//
// お題の係数を必ず掛ける。掛け忘れると「極小の日（人間の理論上限は約7千点）に
// 住人が2万点」という、正直に遊んだ人間が絶対に届かない行がボードに並ぶ。
// 係数込みでも最上位の住人が人間の理論上限をわずかに下回るよう、基礎点や
// 運の項もまとめて掛ける — 頂は必ず人間に残す、という約束のため。
export function residentDailyScore(r, now = Date.now()) {
  const day = jstDay(now);
  // 👑 王者の「その日の出来」は常に最良。デイリーは1発勝負で運の寄与がとても
  // 大きく（0.35〜1.00 の幅）、ここを乱数にすると skill 0.9 の住人が運だけで
  // 王者を抜く日が頻繁に出る。日ごとの数字はお題の係数で動くので、値が
  // 毎日同じになることはない。
  const luck = isChampion(r) ? CHAMP_LUCK : unit(r.id, `dc${day}`);   // その日の出来 0..1
  const s = r.skill;
  const raw = 400 + Math.pow(s, 1.6) * 21000 * (0.35 + 0.65 * luck) + luck * 1500;
  return Math.floor(raw * dailyGhostFactor(now));
}

// ---------------------------------------------------------------------------
// Activity: who is "online" right now
// ---------------------------------------------------------------------------

function inWindow(r, hour) {
  const [a, b] = r.hours;
  const h = hour < a ? hour + 24 : hour;
  return h >= a && h < b;
}

// Stable for 20-minute slots, with a little hysteresis so nobody flaps.
export function isOnline(r, now = Date.now(), popFactor = 1) {
  const hour = jstHour(now);
  const slot = Math.floor(now / (20 * 60 * 1000));
  // Even on the busiest night only ~60% of the in-window cast is around —
  // the lobby should feel populated, not like a roll call.
  const base = (inWindow(r, hour) ? 0.52 : 0.08) * Math.min(1.25, Math.max(0.4, popFactor));
  const cur = unit(r.id, slot);
  if (cur < base) return true;
  return unit(r.id, slot - 1) < base && cur < base + 0.22;
}

export function onlineResidents(roster, now = Date.now(), popFactor = 1) {
  return roster.filter(r => isOnline(r, now, popFactor));
}

// Level band a resident's rating corresponds to (for bot disguise matching).
// v2.14: 住人のレート上限が 1900→2600 に上がったので、鬼帯の天井も追随させる
// （据え置くと最強格の住人が変装候補から全員こぼれ、鬼の変装が枯れる）。
export const BOT_RATING_BANDS = { easy: [700, 1020], normal: [980, 1300], hard: [1240, 1600], oni: [1520, 2800] };
export function residentsForLevel(roster, level, now = Date.now()) {
  const [lo, hi] = BOT_RATING_BANDS[level] || BOT_RATING_BANDS.normal;
  return roster.filter(r => {
    // rating だけで足りるので軽量版を使う（residentStats の personalBest 60ステップ
    // ×5ボードを席数ぶん回すと、最大倍率のバトロワ開始でイベントループが約140ms
    // 詰まる）。residentRating と residentStats.rating は同じ ratingFor を通るので同値。
    const rating = residentRating(r, now);
    return rating >= lo && rating <= hi;
  });
}
