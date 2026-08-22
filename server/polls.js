// Player polls (投票).
//
// One poll runs at a time, stored on db.meta.poll. Players vote from the menu;
// a poll can be a plain question or an "event poll" whose options map to
// EVENT_TYPES, letting the admin launch the winning event with one click.

import crypto from 'crypto';
import { EVENT_TYPES, eventType } from './events.js';

export const MAX_OPTIONS = 6;
export const MAX_QUESTION = 80;
export const MAX_OPTION_TEXT = 40;

function clean(s, max) {
  return String(s || '').trim().replace(/[<>]/g, '').slice(0, max);
}

export function createPoll({ question, options, minutes, kind, createdBy }) {
  const q = clean(question, MAX_QUESTION);
  if (!q) return { error: '質問を入力してください' };
  const opts = (Array.isArray(options) ? options : [])
    .map(o => (typeof o === 'string' ? { text: o } : o || {}))
    .map(o => ({ text: clean(o.text, MAX_OPTION_TEXT), eventType: o.eventType ? String(o.eventType) : null }))
    .filter(o => o.text)
    .slice(0, MAX_OPTIONS);
  if (opts.length < 2) return { error: '選択肢は2つ以上必要です' };
  const mins = Math.max(1, Math.min(14 * 24 * 60, Math.floor(Number(minutes) || 60)));
  return {
    poll: {
      id: crypto.randomUUID(),
      kind: kind === 'event' ? 'event' : 'plain',
      question: q,
      options: opts.map((o, i) => ({ id: `o${i}`, text: o.text, eventType: o.eventType, votes: 0 })),
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
  return pool.slice(0, Math.min(count, MAX_OPTIONS)).map(ty => ({
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
  if (prev) {
    const old = poll.options.find(o => o.id === prev);
    if (old) old.votes = Math.max(0, old.votes - 1);
  }
  poll.voters[userId] = optionId;
  opt.votes++;
  return { ok: true, changed: !!prev };
}

// AI residents vote too (voter keys are prefixed "r:"). Their tastes follow
// their archetype; plain polls get a mild bandwagon effect.
const EVENT_TASTE = {
  newbie:   { coinfes: 3, xpboost: 3, gemrush: 2, lucky: 1 },
  tryhard:  { ultfes: 3, xpboost: 2, doubletrouble: 2, bossraid: 1 },
  casual:   { coinfes: 3, chaos: 2, doubletrouble: 2, lucky: 1 },
  nightowl: { chaos: 2, ultfes: 2, doubletrouble: 2 },
  morning:  { xpboost: 2, coinfes: 2 },
  global:   { doubletrouble: 2, coinfes: 2, ultfes: 1 },
  gacha:    { lucky: 5, gemrush: 3, coinfes: 1 },
  explorer: { bossraid: 4, ultfes: 1, gemrush: 1 },
  senpai:   { xpboost: 2, bossraid: 2, coinfes: 1 },
  kid:      { chaos: 3, doubletrouble: 2, coinfes: 2 },
  streamer: { chaos: 3, doubletrouble: 3 },
  lurker:   { coinfes: 2, xpboost: 2 },
};

export function residentChoice(poll, resident) {
  if (!poll || !poll.options.length) return null;
  const taste = EVENT_TASTE[resident.arch] || {};
  const total = poll.options.reduce((a, o) => a + o.votes, 0);
  const weights = poll.options.map(o => {
    let w = 1;
    if (poll.kind === 'event' && o.eventType) w += taste[o.eventType] || 0;
    if (total > 0) w += (o.votes / total) * 1.5;   // bandwagon
    return w;
  });
  let x = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < poll.options.length; i++) { x -= weights[i]; if (x <= 0) return poll.options[i].id; }
  return poll.options[poll.options.length - 1].id;
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
  const voters = Object.keys(poll.voters);
  return {
    id: poll.id,
    kind: poll.kind,
    question: poll.question,
    options: poll.options.map(o => ({
      id: o.id, text: o.text, eventType: o.eventType,
      votes: reveal ? o.votes : null,
      pct: reveal && total ? Math.round((o.votes / total) * 100) : null,
      ...(split ? { ai: split[o.id].ai, real: split[o.id].real } : {}),
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
