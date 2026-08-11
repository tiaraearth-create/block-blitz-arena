// Ambient population: simulated players that make the arena feel alive.
// Provides persona names for disguised bots, a time-of-day online counter,
// ambient chat lines, and ghost leaderboard rows.
// Set POP_SCALE=0 to disable everything (real numbers only); >1 to boost.
export const POP_SCALE = process.env.POP_SCALE === undefined ? 1 : Math.max(0, Number(process.env.POP_SCALE) || 0);

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const NAMES = [
  'そらまめ', 'ゆきんこ', 'たける', 'ミントアイス', 'ぽんず', 'カイト', 'りんごあめ', 'ネオ',
  'しろくま', 'ハヤテ', 'こむぎ', 'レンレン', 'あおいそら', 'ツバサ', 'もちもち', 'さくらんぼ',
  'ダイチ', 'ひなたぼっこ', 'けんちゃん', 'ミサキ', 'ふうか', 'ショウ', 'まったり勢', 'ブロック職人',
  'コンボマスター', 'ぷにぷに', 'たこやき8個', 'メロンソーダ', 'ゆるふわ', 'ガチで勝つ', 'パズル王',
  '夜ふかし中', 'おにぎり', 'ラムネ', 'きつねうどん', 'スバル', 'ノア', 'ハルカ', 'リク', 'ユウナ',
  'ソウタ', 'ミオ', 'カエデ', 'イツキ', 'ホシゾラ', 'クロネコ', 'シルバー', 'タピオカ', 'ちくわ',
  'ぺんぎん', 'マグロ', 'うさぎさん', 'カフェオレ', 'ドラゴン太郎', 'ミルクティー', 'ハンバーグ',
  'ポテチ', 'ゼリービーンズ', 'しゅわしゅわ', 'ねむい', 'ブロッコリ', 'キラキラ星', 'マカロン',
  'おこめ', 'とうふメンタル', 'スナイパー', 'いちごみるく', 'カミナリ', 'よもぎもち', 'アルト',
];

// Pick a human-looking persona. `used` prevents duplicates inside one match.
// guestChance: some personas look like guests (ゲストXXXX, no rating).
export function pickPersona({ used, guestChance = 0.3, rnd = Math.random } = {}) {
  if (rnd() < guestChance) {
    for (;;) {
      const name = `ゲスト${1000 + Math.floor(rnd() * 9000)}`;
      if (!used || !used.has(name)) { if (used) used.add(name); return { name, registered: false }; }
    }
  }
  for (let tries = 0; ; tries++) {
    let name = NAMES[Math.floor(rnd() * NAMES.length)];
    if (tries >= 3 || rnd() < 0.25) name += String(Math.floor(rnd() * 90) + 10);
    if (!used || !used.has(name)) { if (used) used.add(name); return { name, registered: true }; }
  }
}

// ---------------------------------------------------------------------------
// Time-of-day online counter (JST curve + smooth wobble so it drifts live)
// ---------------------------------------------------------------------------

const HOURLY = [ // JST hour -> typical player count
  110, 80, 58, 42, 33, 30, 38, 55, 70, 85, 100, 115,
  150, 135, 120, 130, 150, 180, 230, 290, 350, 380, 330, 200,
];

function wobble(t) {
  return 0.10 * Math.sin(t / 700000) + 0.06 * Math.sin(t / 190000 + 2) + 0.05 * Math.sin(t / 53000 + 5);
}

export function ambientOnline(now = Date.now()) {
  if (!POP_SCALE) return 0;
  const jst = (now / 3600000 + 9) % 24;
  const h = Math.floor(jst), f = jst - h;
  const base = HOURLY[h] * (1 - f) + HOURLY[(h + 1) % 24] * f;
  return Math.max(0, Math.round(base * (1 + wobble(now)) * POP_SCALE));
}

export function ambientMatches(now = Date.now()) {
  return Math.round(ambientOnline(now) * 0.17 * (1 + 0.05 * Math.sin(now / 97000)));
}

// ---------------------------------------------------------------------------
// Ambient chat
// ---------------------------------------------------------------------------

const CHAT_LINES = [
  'こんにちは〜', 'こんばんは！', 'よろしく〜', '誰か対戦しよ！', '1v1こない？', 'レイド行く人いる？',
  'ダンジョン40Fで全滅した…', 'ダンジョンのボス強すぎw', 'ウィークリー更新きたね', 'ウィークリーむずくない？',
  'ガチャSSR出たあああ', 'ガチャ爆死した😭', 'コンボ12いった！', '自己ベスト更新！', '鬼AIに勝てた！',
  '神って隠し難易度あるらしいよ', 'はじめて10分の初心者です', 'おやすみ〜', '疲れたので落ちます', 'gg',
  'ggでした！', 'さっきの人強かった…', 'リベンジさせて！', 'チーム戦たのしい', 'エフェクトかっこいい',
  'BGMすき', 'スキン何使ってる？', 'コイン貯まらん', 'フィーバー強すぎw', 'ボム使うタイミングむずい',
  '今日から始めました！', 'ランキング入りたい', 'レート1500いきたい', '2v2誰か組も！', '連勝中🔥',
  '5連敗つらい', 'ブロック綺麗に消えると気持ちいい', '休憩なう', '週末ガチる', 'レイドボス硬すぎない？',
];

export function randomChatLine() {
  return CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
}

// ---------------------------------------------------------------------------
// Ghost leaderboard rows (deterministic per ISO week, reshuffle weekly)
// ---------------------------------------------------------------------------

function strHash(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GHOST_COUNT = { score: 26, rating: 20, dungeon: 16, weekly: 12 };

// `taken`: Set of real usernames — ghosts never shadow a real player.
export function ghostRows(board, weekId, taken) {
  if (!POP_SCALE) return [];
  const rng = mulberry32(strHash(`bba-ghost-${weekId}-${board}`));
  const count = Math.round((GHOST_COUNT[board] || 16) * Math.min(POP_SCALE, 2));
  const used = new Set(taken);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const { name } = pickPersona({ used, guestChance: 0, rnd: rng });
    const skill = rng();   // one base skill so a ghost's stats correlate
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
      badges: [],
      title: null,
    });
  }
  return rows;
}
