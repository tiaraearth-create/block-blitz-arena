// Player polls (投票).
//
// One poll runs at a time, stored on db.meta.poll. Players vote from the menu;
// a poll can be a plain question or an "event poll" whose options map to
// EVENT_TYPES, letting the admin launch the winning event with one click.

import crypto from 'crypto';
import { EVENT_TYPES, eventType } from './events.js';
import { ARCHETYPES, unit, mulberry32, strHash } from './residents.js';

export const MAX_OPTIONS = 6;
export const MAX_QUESTION = 80;
export const MAX_OPTION_TEXT = 40;

function clean(s, max) {
  return String(s || '').trim().replace(/[<>]/g, '').slice(0, max);
}

export function createPoll({ question, questionEn, options, minutes, kind, createdBy }) {
  const q = clean(question, MAX_QUESTION);
  if (!q) return { error: '質問を入力してください' };
  const opts = (Array.isArray(options) ? options : [])
    .map(o => (typeof o === 'string' ? { text: o } : o || {}))
    .map(o => {
      const evType = o.eventType ? eventType(String(o.eventType)) : null;
      return {
        text: clean(o.text, MAX_OPTION_TEXT),
        // イベント選択肢はEVENT_TYPESのネイティブ英語名を使う
        textEn: clean(o.textEn, MAX_OPTION_TEXT) || (evType ? `${evType.icon} ${evType.nameEn}` : null),
        // EVENT_TYPES に無い eventType は null に落として plain 選択肢扱いにする。
        // 生の文字列を残すと applyWinner の makeEvent が黙って先頭イベント
        // （カオスタイム）にすり替えるため、投票結果と実開催が食い違う。
        eventType: evType ? evType.id : null,
      };
    })
    .filter(o => o.text)
    .slice(0, MAX_OPTIONS);
  if (opts.length < 2) return { error: '選択肢は2つ以上必要です' };
  const mins = Math.max(1, Math.min(14 * 24 * 60, Math.floor(Number(minutes) || 60)));
  return {
    poll: {
      id: crypto.randomUUID(),
      kind: kind === 'event' ? 'event' : 'plain',
      question: q,
      questionEn: clean(questionEn, MAX_QUESTION) || null,
      options: opts.map((o, i) => ({ id: `o${i}`, text: o.text, textEn: o.textEn || null, eventType: o.eventType, votes: 0 })),
      voters: {},              // userId -> optionId
      createdAt: Date.now(),
      endsAt: Date.now() + mins * 60 * 1000,
      createdBy: createdBy || null,
      closed: false,
      applied: false,          // event polls: has the winner been launched?
    },
  };
}

// An event poll pre-filled with a random selection of event types.
export function eventPollOptions(count = 4) {
  const pool = EVENT_TYPES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // ⚠ MAX_OPTIONS は「1つの投票に置ける選択肢の上限」であって
  //    「候補一覧の上限」ではない。ここで切っていたので、
  //    /api/admin/poll/suggest が EVENT_TYPES.length（8）を渡しても6件しか返らず、
  //    しかも pool は先頭でシャッフル済みなので**毎回ちがう2種類が欠けていた**
  //    （運営には「その2つが選択肢に出せない」理由が分からない）。
  //    投票そのものの6個上限は createPoll 側の .slice(0, MAX_OPTIONS) が担保している。
  return pool.slice(0, Math.max(1, Math.min(count, pool.length))).map(ty => ({
    text: `${ty.icon} ${ty.name}`,
    eventType: ty.id,
  }));
}

export function isOpen(poll) {
  return !!poll && !poll.closed && poll.endsAt > Date.now();
}

// Auto-close a poll whose time is up. Returns true when it just closed.
export function tickPoll(poll) {
  if (poll && !poll.closed && poll.endsAt <= Date.now()) {
    poll.closed = true;
    return true;
  }
  return false;
}

export function winnerOf(poll) {
  if (!poll || !poll.options.length) return null;
  const top = poll.options.slice().sort((a, b) => b.votes - a.votes)[0];
  if (!top || top.votes === 0) return null;
  const tied = poll.options.filter(o => o.votes === top.votes);
  return { ...top, tied: tied.length > 1, tiedWith: tied.map(o => o.text) };
}

export function vote(poll, userId, optionId) {
  if (!isOpen(poll)) return { error: 'この投票は終了しています' };
  const opt = poll.options.find(o => o.id === optionId);
  if (!opt) return { error: '選択肢が見つかりません' };
  const prev = poll.voters[userId];
  if (prev === optionId) return { error: 'すでにその選択肢に投票済みです' };
  // 人間は投票した瞬間に開票状況が見える（pollView の reveal）。捨て票→形勢を
  // 見てから本命に乗り換え、で「投票するまで結果は見えない」の趣旨を骨抜きに
  // できてしまうので、人間の乗り換えは1回までに制限する。AI住人（r: 接頭辞）は
  // スウィング投票が前提なので対象外。
  if (prev && !String(userId).startsWith('r:')) {
    poll.changes = poll.changes || {};
    if ((poll.changes[userId] || 0) >= 1) return { error: '投票の変更は1回までです' };
    poll.changes[userId] = (poll.changes[userId] || 0) + 1;
  }
  if (prev) {
    const old = poll.options.find(o => o.id === prev);
    if (old) old.votes = Math.max(0, old.votes - 1);
  }
  poll.voters[userId] = optionId;
  opt.votes++;
  return { ok: true, changed: !!prev };
}

// AI residents vote too (voter keys are prefixed "r:"). Each resident has a
// real opinion: archetype tastes (event polls), keyword tastes read from the
// option text (plain polls), a stable personal lean, bandwagon/contrarian
// streaks that follow their personality, and guild solidarity.
const EVENT_TASTE = {
  newbie:   { coinfes: 3, xpboost: 3, gemrush: 2, lucky: 1 },
  tryhard:  { ultfes: 3, xpboost: 2, doubletrouble: 2, bossraid: 1 },
  casual:   { coinfes: 3, doubletrouble: 3, lucky: 1 },
  nightowl: { ultfes: 3, doubletrouble: 2 },
  morning:  { xpboost: 2, coinfes: 2 },
  global:   { doubletrouble: 2, coinfes: 2, ultfes: 1 },
  gacha:    { lucky: 5, gemrush: 3, coinfes: 1 },
  explorer: { bossraid: 4, ultfes: 1, gemrush: 1 },
  senpai:   { xpboost: 2, bossraid: 2, coinfes: 1 },
  kid:      { doubletrouble: 3, coinfes: 2 },
  streamer: { doubletrouble: 3, ultfes: 2 },
  lurker:   { coinfes: 2, xpboost: 2 },
};

// Plain polls: what each archetype hears in an option's wording.
const TEXT_TASTE = [
  [/ガチャ|gacha|ssr|レア|運試し/i,                    { gacha: 4, kid: 1 }],
  [/ボス|boss|raid|レイド|討伐|襲来/i,                { explorer: 3, tryhard: 1, kid: 1 }],
  [/ダンジョン|dungeon|塔|深淵|abyss|探索/i,          { explorer: 4, nightowl: 1 }],
  [/初心者|やさし|かんたん|簡単|easy|beginner|入門/i, { newbie: 4, senpai: 2, casual: 1 }],
  [/激ムズ|むずかし|難し|ハード|hard|鬼|地獄/i,       { tryhard: 3, explorer: 2, nightowl: 1 }],
  [/ランク|レート|rank|rating|大会|トーナメント|tourney|対戦|pvp/i, { tryhard: 4, streamer: 1 }],
  [/深夜|夜ふかし|夜型|night/i,                       { nightowl: 4 }],
  [/朝|morning|早起き/i,                              { morning: 4 }],
  [/協力|coop|co-op|フレンド|みんなで|一緒/i,         { casual: 2, senpai: 2, kid: 1 }],
  [/コイン|coin|ジェム|gem|報酬|プレゼント|無料|タダ/i, { gacha: 2, casual: 2, newbie: 2, kid: 2, lurker: 1 }],
  [/カオス|chaos|おもしろ|ネタ|ヘンテコ|変な/i,       { kid: 3, streamer: 3, casual: 1 }],
  [/タイムアタック|sprint|スピード|速|秒/i,           { tryhard: 2, morning: 2 }],
  [/スキン|skin|着せ替え|コスメ|かわいい|デザイン/i,  { kid: 2, casual: 2, gacha: 1 }],
];

// How much each archetype follows the crowd; the rest march to their own drum.
const CONFORMITY = {
  newbie: 1.6, kid: 1.8, casual: 1.4, lurker: 1.7, gacha: 1.2, morning: 1.0,
  global: 1.0, nightowl: 0.8, senpai: 0.8, explorer: 0.6, streamer: 0.5, tryhard: 0.4,
};
// Contrarians throw the underdog a bone once a poll has momentum.
const CONTRARIAN = { streamer: 0.9, tryhard: 0.5, nightowl: 0.4, explorer: 0.3 };

// opts.guildVotes: { optionId -> votes } from the resident's guildmates.
// opts.exclude: optionId to skip (used when a swing voter picks a new side).
export function residentChoice(poll, resident, opts = {}) {
  if (!poll || !poll.options.length) return null;
  const taste = EVENT_TASTE[resident.arch] || {};
  const total = poll.options.reduce((a, o) => a + o.votes, 0);
  const minVotes = Math.min(...poll.options.map(o => o.votes));
  const maxVotes = Math.max(...poll.options.map(o => o.votes));
  const guild = opts.guildVotes || null;
  const guildTotal = guild ? Object.values(guild).reduce((a, b) => a + b, 0) : 0;
  // Seeded per resident+poll: the personal lean never flips between ticks.
  const rng = mulberry32(strHash(`${resident.id}|${poll.id}`));
  const weights = poll.options.map(o => {
    let w = 1;
    if (poll.kind === 'event' && o.eventType) {
      w += taste[o.eventType] || 0;
    } else {
      for (const [re, per] of TEXT_TASTE) if (re.test(o.text)) w += per[resident.arch] || 0;
    }
    // English-only options click with English speakers.
    if (resident.lang === 'en' && /[a-z]{3,}/i.test(o.text) && !/[ぁ-んァ-ヶ一-龠]/.test(o.text)) w += 1.2;
    // A stable personal favorite, logic be damned.
    w += rng() * 2.2;
    if (total > 0) w += (o.votes / total) * (CONFORMITY[resident.arch] ?? 1);
    if (total >= 6 && o.votes === minVotes && maxVotes > minVotes) w += CONTRARIAN[resident.arch] || 0;
    if (guildTotal > 0) w += ((guild[o.id] || 0) / guildTotal) * 1.3;
    if (opts.exclude === o.id) w = 0;
    return Math.max(0, w);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return null;
  let x = rng() * sum;
  for (let i = 0; i < poll.options.length; i++) { x -= weights[i]; if (x <= 0) return poll.options[i].id; }
  return poll.options[poll.options.length - 1].id;
}

// When (as a fraction of the poll's lifetime) a resident casts their vote:
// early birds pounce, procrastinators wait for the deadline rush.
const VOTE_TIMING = {
  morning: 'early', tryhard: 'early', kid: 'early', streamer: 'early', gacha: 'early',
  nightowl: 'late', lurker: 'late', explorer: 'late',
};
export function residentVoteAt(poll, resident) {
  const u = unit(resident.id, `${poll.id}:t`);
  const style = VOTE_TIMING[resident.arch];
  const f = style === 'early' ? u * u : style === 'late' ? 1 - (1 - u) * (1 - u) : u;
  return 0.02 + f * 0.93;
}

// A minority of residents will switch sides late when their pick is losing.
const SWING_PROB = { kid: 0.25, casual: 0.2, gacha: 0.2, newbie: 0.18, lurker: 0.15 };
export function isSwingVoter(poll, resident) {
  return unit(resident.id, `${poll.id}:s`) < (SWING_PROB[resident.arch] ?? 0.08);
}

function voteSplit(poll) {
  const per = {};
  for (const o of poll.options) per[o.id] = { ai: 0, real: 0 };
  for (const [voter, opt] of Object.entries(poll.voters)) {
    if (!per[opt]) continue;
    if (voter.startsWith('r:')) per[opt].ai++; else per[opt].real++;
  }
  return per;
}

// Admin-only: which archetypes back each option (from poll.voterMeta, written
// as AI votes come in — polls created before the field simply show nothing).
function archSplit(poll) {
  const meta = poll.voterMeta || {};
  const per = {};
  for (const o of poll.options) per[o.id] = {};
  for (const [voter, opt] of Object.entries(poll.voters)) {
    const arch = meta[voter];
    if (!arch || !per[opt]) continue;
    per[opt][arch] = (per[opt][arch] || 0) + 1;
  }
  const label = id => { const a = ARCHETYPES.find(x => x.id === id); return a ? a.label : id; };
  const top = {};
  for (const [optId, counts] of Object.entries(per)) {
    top[optId] = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([arch, n]) => ({ arch, label: label(arch), n }));
  }
  return top;
}

// Public shape — never leaks the voter map. `admin` adds the AI/real split.
export function pollView(poll, userId, admin = false) {
  if (!poll) return null;
  const total = poll.options.reduce((a, o) => a + o.votes, 0);
  const myVote = userId ? poll.voters[userId] || null : null;
  const open = isOpen(poll);
  // Tallies stay hidden until you have voted (or the poll has closed), so the
  // running order can't sway people who haven't picked yet.
  const reveal = !open || !!myVote;
  const split = admin ? voteSplit(poll) : null;
  const archs = admin ? archSplit(poll) : null;
  const voters = Object.keys(poll.voters);
  return {
    id: poll.id,
    kind: poll.kind,
    question: poll.question,
    questionEn: poll.questionEn || null,
    options: poll.options.map(o => ({
      id: o.id, text: o.text, textEn: o.textEn || null, eventType: o.eventType,
      votes: reveal ? o.votes : null,
      pct: reveal && total ? Math.round((o.votes / total) * 100) : null,
      ...(split ? { ai: split[o.id].ai, real: split[o.id].real } : {}),
      ...(archs && archs[o.id].length ? { archs: archs[o.id] } : {}),
    })),
    total: reveal ? total : null,
    voterCount: voters.length,
    ...(admin ? { aiVoters: voters.filter(v => v.startsWith('r:')).length, realVoters: voters.filter(v => !v.startsWith('r:')).length } : {}),
    endsAt: poll.endsAt,
    closed: !open,
    reveal,
    myVote,
    applied: !!poll.applied,
    winner: !open ? winnerOf(poll) : null,
  };
}

export { eventType };
