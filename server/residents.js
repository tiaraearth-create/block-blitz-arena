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
// Day index (JST) of the arena's launch — resident "join dates" hang off it.
const LAUNCH_DAY = jstDay(Date.UTC(2026, 6, 20, 15));

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
  const skill = arch.skill[0] + (arch.skill[1] - arch.skill[0]) * rng();
  const len = arch.hours[1] - arch.hours[0];
  // Jitter the window a little so two residents of one archetype differ.
  const start = (arch.hours[0] + Math.floor(rng() * 3) - 1 + 24) % 24;
  const joinedDay = arch.newbie
    ? null                                   // "joined recently" — resolved at read time
    : LAUNCH_DAY - 30 + Math.floor(rng() * 60);
  return {
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
      if (tries > 8) { r.name += String(Math.floor(rng() * 900) + 100); break; }
    }
    used.add(r.name);
    roster.push(r);
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

const TIERS = [
  [1700, 'マスター', 'Master'], [1500, 'ダイヤ', 'Diamond'], [1300, 'プラチナ', 'Platinum'],
  [1100, 'ゴールド', 'Gold'], [950, 'シルバー', 'Silver'], [0, 'ブロンズ', 'Bronze'],
];
export function tierOf(rating) {
  const t = TIERS.find(([min]) => rating >= min) || TIERS[TIERS.length - 1];
  return { name: t[1], nameEn: t[2] };
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
function aptitude(r, mode) {
  if (!mode) return 1;
  if (r.favMode === mode) return 1.16;
  if (r.modes && r.modes.includes(mode)) return 1.07;
  return 0.87;
}

// 自己ベスト。練習日ごとに1回挑戦し、出た記録の最大値を持つ。
// age に対して単調（更新しかしない）で、同じ日なら何度呼んでも同じ。
const MAX_STEPS = 60;
function personalBest(r, age, key, base, span, apt) {
  const cadence = 2 + Math.floor(unit(r.id, `${key}c`) * 5);          // 2〜6日おきに挑戦
  const offset = Math.floor(unit(r.id, `${key}o`) * cadence);          // 全員が同じ日に伸びない
  const steps = Math.min(MAX_STEPS, Math.max(0, Math.floor((age + offset) / cadence)));
  const patience = 14 + (1 - r.skill) * 45;                            // 上手いほど早く頭打ち
  let best = base;
  for (let i = 0; i <= steps; i++) {
    const ceil = base + span * apt * (1 - Math.exp(-i / patience));
    // その日の出来。たまに大当たりが出て、それが記録として残る。
    const luck = unit(r.id, `${key}:${i}`);
    const attempt = base + (ceil - base) * (0.55 + luck * 0.45);
    if (attempt > best) best = attempt;
  }
  return Math.floor(best);
}

export function residentStats(r, now = Date.now(), weekId = 'W0') {
  const day = jstDay(now);
  const seedN = strHash(r.id) % 1000;
  const joined = r.joinedDay === null ? day - (seedN % 14) : r.joinedDay;
  const age = Math.max(1, day - joined);
  const s = r.skill;

  // 調子: 3日ごとに切り替わるブロック。sin 波と違って「連勝が続く」「急に
  // 落ちる」が起きるので、日々見ていると人間がプレイしているように見える。
  const block = Math.floor(day / 3);
  const form = (unit(r.id, `f${block}`) - 0.5) * 2;                     // -1..1
  const formPrev = (unit(r.id, `f${block - 1}`) - 0.5) * 2;
  const blend = (day % 3) / 3;                                          // ブロック境界をなめらかに
  const mood = formPrev * (1 - blend) + form * blend;
  // レートは実力に長期の伸びを足し、そこに調子が乗る形。
  const climb = 1 - Math.exp(-age / (30 + (1 - s) * 60));
  const aptPvp = aptitude(r, 'pvp');
  const rating = Math.round(850 + Math.pow(s, 1.3) * 950 * aptPvp * (0.72 + 0.28 * climb) + mood * 70);
  const level = Math.max(1, Math.min(60, 1 + Math.floor(age * (0.08 + s * 0.25))));
  // ここから下は全部「自己ベスト」— 練習日に更新され、下がらず、住人ごとに
  // 更新日がずれる。得意ボードほど天井が高い。
  const scoreSpan = 4000 + Math.pow(s, 2) * 150000;
  const bestScore = Math.min(160000, personalBest(r, age, 'sc', 2500, scoreSpan, aptitude(r, 'solo')));
  const dungeonMax = Math.min(100, 1 + personalBest(r, age, 'dg', 0, Math.pow(s, 1.4) * 105, aptitude(r, 'dungeon')));
  const wk = unit(r.id, weekId);
  const weeklyMix = s * 0.6 + wk * 0.4;
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
    if (t) title = { name: t.name, color: t.color };
  }
  const aptSprint = aptitude(r, 'sprint');
  return {
    rating, level, bestScore, dungeonMax, age,
    tier: tierOf(rating),
    pvpWins: Math.floor(age * s * 0.9 * aptPvp),
    pvpLosses: Math.floor(age * (1 - s) * 0.8),
    // ウィークリーは週ごとにリセットされる記録なので、そこだけは階段ではなく
    // 「その週の調子」で決まる（本物のウィークリーと同じ性質）。
    weeklyBest: Math.floor(Math.pow(weeklyMix, 2) * 30000 * aptitude(r, 'weekly') * (0.8 + 0.4 * ((mood + 1) / 2)) + 800),
    // かつては住人ごとの定数で、何日経っても1ミリも動かなかった箇所。
    sprintBest: personalBest(r, age, 'sp', 600, Math.pow(s, 2) * 20000, aptSprint),
    sprint180: personalBest(r, age, 's3', 2000, Math.pow(s, 2) * 62000, aptSprint),
    survivalWave: Math.max(1, Math.min(99, personalBest(r, age, 'sv', 3, s * 30, aptitude(r, 'survival')))),
    badges, title,
  };
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
export const BOT_RATING_BANDS = { easy: [700, 1020], normal: [980, 1300], hard: [1240, 1600], oni: [1520, 2000] };
export function residentsForLevel(roster, level, now = Date.now()) {
  const [lo, hi] = BOT_RATING_BANDS[level] || BOT_RATING_BANDS.normal;
  return roster.filter(r => {
    const { rating } = residentStats(r, now);
    return rating >= lo && rating <= hi;
  });
}
