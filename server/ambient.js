// Ambient population: simulated players that make the arena feel alive.
// Provides persona names for disguised bots, a time-of-day online counter,
// ambient chat lines + a reply engine, and ghost leaderboard rows.
// Env POP_SCALE (0=off) is multiplied by a live scale the admin can change
// at runtime (db.meta.popScale via /api/admin/pop).
export const POP_SCALE = process.env.POP_SCALE === undefined ? 1 : Math.max(0, Number(process.env.POP_SCALE) || 0);

let liveScale = 1;
export function setLiveScale(x) {
  liveScale = Math.max(0, Math.min(10, Number(x)));
  if (!Number.isFinite(liveScale)) liveScale = 1;
}
export function getLiveScale() { return liveScale; }
export function effectiveScale() { return POP_SCALE * liveScale; }

// Admin-tunable crowd personality: custom AI names, custom chat lines,
// and how chatty the crowd is (0.25 = quiet … 4 = party).
const custom = { names: [], lines: [], chatPace: 1 };
export function setCustom(c = {}) {
  if (Array.isArray(c.names)) {
    custom.names = c.names.map(s => String(s).trim().slice(0, 16)).filter(Boolean).slice(0, 100);
  }
  if (Array.isArray(c.lines)) {
    custom.lines = c.lines.map(s => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 200);
  }
  if (c.chatPace !== undefined && Number.isFinite(Number(c.chatPace))) {
    custom.chatPace = Math.max(0.25, Math.min(4, Number(c.chatPace)));
  }
}
export function getCustom() { return { names: [...custom.names], lines: [...custom.lines], chatPace: custom.chatPace }; }
export function chatPaceFactor() { return custom.chatPace; }

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
  // international handles — the arena is global now
  'Blocky', 'PuzzleFox', 'NovaStar', 'PixelCat', 'MrCombo', 'Sakura99', 'BlockMaster',
  'Zenith', 'Comet', 'Mocha', 'Waffle', 'Prism', 'Lucky7', 'IceWolf', 'StarDust',
  'GridKing', 'Nebula', 'ComboQueen', 'Turbo', 'Panda88',
  'ゆず茶', 'こたつ猫', 'ソーダフロート', 'わたあめ', 'ちゃちゃまる', 'ふわもこ', 'キウイ',
  'レモンサワー', 'プリンアラモード', 'ミルフィーユ', '深夜のブロッカー', 'つよつよ勢',
  'エンジョイ勢', 'ぴよぴよ', 'ホットケーキ', 'グミベア', 'ラテアート', 'おでんくん',
  'BlockNinja', 'CosmicRay', 'PuzzleWiz', 'NightOwl', 'Cherry', 'Maple', 'Frosty',
  'Echo', 'Rocket', 'Pudding', 'Biscuit', 'Shadow7',
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
    // Custom crowd names (admin-set) show up often when configured.
    const useCustom = custom.names.length > 0 && rnd() < 0.35;
    const pool = useCustom ? custom.names : NAMES;
    let name = pool[Math.floor(rnd() * pool.length)];
    if (tries >= 3 || (!useCustom && rnd() < 0.25)) name += String(Math.floor(rnd() * 90) + 10);
    if (!used || !used.has(name)) { if (used) used.add(name); return { name, registered: true }; }
  }
}

// "Lobby regulars": a small rotating cast so the same names keep chatting
// for a while — much more believable than a new name every message.
let regulars = [];
let regularsAt = 0;
export function lobbyPersona() {
  if (!regulars.length || Date.now() - regularsAt > 10 * 60 * 1000) {
    regulars = [];
    const used = new Set();
    for (let i = 0; i < 6; i++) regulars.push(pickPersona({ used, guestChance: 0.15 }));
    regularsAt = Date.now();
  }
  return regulars[Math.floor(Math.random() * regulars.length)];
}

// ---------------------------------------------------------------------------
// Time-of-day online counter (JST curve + smooth wobble so it drifts live)
// ---------------------------------------------------------------------------

const HOURLY = [ // JST hour -> typical player count
  190, 140, 100, 75, 58, 52, 66, 95, 125, 150, 175, 205,
  265, 240, 210, 230, 265, 320, 410, 520, 620, 680, 590, 360,
];

function wobble(t) {
  return 0.10 * Math.sin(t / 700000) + 0.06 * Math.sin(t / 190000 + 2) + 0.05 * Math.sin(t / 53000 + 5);
}

export function ambientOnline(now = Date.now()) {
  const scale = effectiveScale();
  if (!scale) return 0;
  const jst = (now / 3600000 + 9) % 24;
  const h = Math.floor(jst), f = jst - h;
  const base = HOURLY[h] * (1 - f) + HOURLY[(h + 1) % 24] * f;
  return Math.max(0, Math.round(base * (1 + wobble(now)) * scale));
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
  '3x3ブロック来なさすぎ', '角を空けるの大事だね', 'あと1マスで全消しだった…', '全消しボーナス気持ちよすぎ',
  'カオスモードまたやりたい', 'バトルパス何ティアまでいった？', '称号かっこいいのほしい', 'ガチャの新スキン神',
  'ランクマ連勝止まらん', 'ラグ？と思ったら自分の回線だった', 'ダンジョン地下シリーズすき', '朝からやりすぎた',
  'テスト勉強しなきゃなのに…', 'あと1戦だけ…', 'コンボ切れた瞬間の絶望感', '2連続全消しキタ━━━',
  'ボスラッシュ2体目で死んだ', 'ウィークリー3位まで来た！', 'マイナス街道から復帰した', 'エモート煽りやめてw',
  'みんなレートいくつ？', '初心者におすすめの立ち回りある？', '縦消し派？横消し派？', '効率いいコイン稼ぎ教えて',
  // new modes & features
  'トーナメント優勝したった！！', 'トーナメント決勝で負けた…悔しい', 'サバイバルWAVE12まで行った',
  'サバイバルの加速えぐいw', 'ランク帯ダイヤになった！', 'ブロンズから抜け出せない…', '連勝ボーナスおいしい',
  'ミニブロック神アイテムすぎる', 'マグマスキンかっこいい', 'サイバー空間のボード買った', '雪のステージ癒される',
  '地下ダンジョン怖すぎw', '天国ダンジョン綺麗すぎて泣いた', 'エモート増えてるじゃん', '新スキンどれがおすすめ？',
  'ガチャでフレイム当てた🔥', '優勝アナウンス見た？すごくない？', '深夜組いる？', 'おはようございます！',
  '今日のウィークリー終わらせた', 'レートまた溶けた', '今週こそランキング入る',
  // English lines — international crowd
  'hi everyone!', 'gg', 'ggwp', 'anyone up for 1v1?', 'this game is addicting lol',
  'just got a 10 combo!', 'new best score 🎉', 'the dungeon boss is brutal', 'good night all',
  'greetings from overseas!', 'love the music in this game', 'how do I get more coins?', 'nice',
  'won my first tournament!! 🏆', 'survival mode is chaos lol', 'finally hit Gold rank',
  'the new magma skin looks sick', 'heaven dungeon is beautiful', 'anyone in the tourney queue?',
];

export function randomChatLine() {
  if (custom.lines.length && Math.random() < 0.45) {
    return custom.lines[Math.floor(Math.random() * custom.lines.length)];
  }
  return CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
}

// ---------------------------------------------------------------------------
// Reply engine: when a real player chats, ambient players answer.
// Returns [{ text, delay }] (possibly empty). Language follows the message.
// ---------------------------------------------------------------------------

const REPLIES = {
  greeting: {
    ja: ['こんにちは〜！', 'こんばんは！', 'よろしく！', 'やあ！', 'ちわ〜っす', 'いらっしゃい！'],
    en: ['hi! 👋', 'hello!', 'yo!', 'welcome!', 'hey hey'],
  },
  gg: {
    ja: ['gg！', 'ggでした！', 'おつ〜', 'ナイスファイト！'],
    en: ['gg!', 'ggwp', 'good game!', 'nice one'],
  },
  battle: {
    ja: ['いいよ！ランクマ潜ろ', '今から潜るわ', 'おれも行く！', '1v1いこ！', 'カスタムルーム建てる？'],
    en: ["let's go! queueing now", "i'm in, 1v1?", 'sure, see you in ranked'],
  },
  praise: {
    ja: ['ありがとw', '照れるわ', 'まだまだですよ〜', 'そっちこそ強かった'],
    en: ['thanks haha', 'nah still learning', 'you too!'],
  },
  beginner: {
    ja: ['ようこそ！', '最初はソロで練習がおすすめ', 'わからんことあったら聞いて！', '一緒にがんばろ〜'],
    en: ['welcome! try solo mode first', 'welcome aboard!', 'ask anything!'],
  },
  dungeon: {
    ja: ['ダンジョンは残機管理が大事', '40Fから急にキツくなるよね', 'シールドの強化おすすめ', '100F勢おる？'],
    en: ['the dungeon gets rough after 40F', 'pick the shield perk, trust me'],
  },
  gacha: {
    ja: ['爆死仲間がここにも', 'SSR出る気しない', '10連で決めろ！', 'UR引いた人見たことない'],
    en: ['gacha luck is brutal lol', 'save for the 10-pull!'],
  },
  weekly: {
    ja: ['今週のむずいよね', 'ピース運ゲーすぎるw', '月曜リセット待ち', 'あと2000点で自己べ'],
    en: ['this week is a hard one', 'so close to my best score'],
  },
  boss: {
    ja: ['レイド行こうぜ', 'ボスのお邪魔ブロックえぐい', '魔王まで倒した？', 'ラッシュはノーミス必須がつらい'],
    en: ['raid time! join the queue', 'the boss garbage blocks are evil'],
  },
  question: {
    ja: ['たぶんそうだと思う', 'わかる', 'それな', 'どうだろ？やってみるしかない', '公式には書いてなかった気がする'],
    en: ['probably yeah', 'good question lol', 'try it and see!'],
  },
  generic: {
    ja: ['それな', 'わかるw', 'たしかに', '🔥', 'がんばれ！', 'いいね！', 'ないす', 'w', 'まじか'],
    en: ['nice', 'lol', 'same here', 'good luck!', '🔥', 'fr', 'haha'],
  },
};

const REPLY_RULES = [
  ['greeting', /こんにち|こんばん|おはよ|やあ|よろしく|はじめまして|hello|\bhi\b|\bhey\b/i],
  ['gg', /^gg|ｇｇ|おつ(かれ)?|お疲れ/i],
  ['battle', /対戦|たいせん|1v1|勝負|やろ[うぜ]|潜ろ|battle|duel|match/i],
  ['praise', /強い|つよ|うま[いっ]|上手|すごい|ナイス|nice|strong|\bpro\b/i],
  ['beginner', /初心者|はじめて|始めた|新規|newbie|beginner|new here|just started/i],
  ['dungeon', /ダンジョン|dungeon|[0-9]+f/i],
  ['gacha', /ガチャ|gacha|ssr|爆死/i],
  ['weekly', /ウィークリー|週替|weekly/i],
  ['boss', /ボス|レイド|魔王|raid|boss/i],
  ['question', /[?？]$/],
];

export function chooseReplies(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  // Language: reply in English when the message has no Japanese characters.
  const lang = /[ぁ-んァ-ヶ一-龠ー]/.test(t) ? 'ja' : 'en';
  let category = 'generic';
  for (const [cat, re] of REPLY_RULES) {
    if (re.test(t)) { category = cat; break; }
  }
  const pool = REPLIES[category][lang] || REPLIES[category].ja;
  const out = [];
  const first = pool[Math.floor(Math.random() * pool.length)];
  out.push({ text: first, delay: 3500 + Math.random() * 8500 });
  // Sometimes a second voice chimes in with a different line.
  if (Math.random() < 0.28) {
    const pool2 = Math.random() < 0.5 ? pool : (REPLIES.generic[lang] || REPLIES.generic.ja);
    let second = pool2[Math.floor(Math.random() * pool2.length)];
    if (second === first) second = (REPLIES.generic[lang] || REPLIES.generic.ja)[0];
    out.push({ text: second, delay: out[0].delay + 4000 + Math.random() * 7000 });
  }
  return out;
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

const GHOST_COUNT = { score: 40, rating: 30, dungeon: 24, weekly: 18 };

// `taken`: Set of real usernames — ghosts never shadow a real player.
export function ghostRows(board, weekId, taken) {
  const scale = effectiveScale();
  if (!scale) return [];
  const rng = mulberry32(strHash(`bba-ghost-${weekId}-${board}`));
  const count = Math.round((GHOST_COUNT[board] || 24) * Math.min(scale, 2));
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
