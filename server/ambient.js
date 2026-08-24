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
  buildRoster, customResident, residentStats, onlineResidents, residentsForLevel,
  archetype, ARCHETYPES, jstHour, jstWeekday, unit, mulberry32, strHash, JA_NAMES, EN_NAMES,
} from './residents.js';
import { composeLine, chooseReplies as crowdReplies, buildCtx } from './crowd.js';

export const POP_SCALE = process.env.POP_SCALE === undefined ? 1 : Math.max(0, Number(process.env.POP_SCALE) || 0);

export const MAX_LIVE_SCALE = 100;

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
  chatPace: 1,          // 0.25 quiet … 4 party
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
    custom.chatPace = Math.max(0.25, Math.min(4, Number(c.chatPace)));
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
}

export function getCustom() {
  return {
    names: [...custom.names], lines: [...custom.lines], chatPace: custom.chatPace,
    toggles: { ...custom.toggles }, quiet: custom.quiet ? { ...custom.quiet } : null,
    removed: [...custom.removed], extra: custom.extra.map(x => ({ ...x })), rosterSeed: custom.rosterSeed,
  };
}
export function chatPaceFactor() { return custom.chatPace; }
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
const MAX_ROSTER = 240;
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
  return onlineResidents(getRoster(), now, popFactor(now));
}

export function residentById(id) { return getRoster().find(r => r.id === id) || null; }
export function residentByName(name) { return getRoster().find(r => r.name === name) || null; }

// ---------------------------------------------------------------------------
// World context (event / poll) — injected by index.js to avoid a cycle
// ---------------------------------------------------------------------------

let worldProvider = () => ({ event: null, poll: null });
export function setWorldProvider(fn) { worldProvider = fn; }
export function worldCtx(extra = {}) {
  const w = worldProvider() || {};
  const now = extra.now || Date.now();
  return buildCtx({ now, event: w.event, poll: w.poll, active: activeResidents(now), humans: extra.humans || [] });
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
  for (let tries = 0; ; tries++) {
    const useCustom = custom.names.length > 0 && rnd() < 0.35;
    const pool = useCustom ? custom.names : NAMES;
    let name = pool[Math.floor(rnd() * pool.length)];
    if (tries >= 3 || (!useCustom && rnd() < 0.25)) name += String(Math.floor(rnd() * 90) + 10);
    if (!used || !used.has(name)) { if (used) used.add(name); return { name, registered: true }; }
  }
}

// A resident to disguise a bot of the given strength. Prefers residents who
// are "online" right now; returns null when none fits (caller falls back).
export function pickResidentBot(level, used, now = Date.now()) {
  if (!custom.toggles.bots || !effectiveScale()) return null;
  const online = new Set(activeResidents(now).map(r => r.id));
  const fits = residentsForLevel(getRoster(), level, now).filter(r => !used || !used.has(r.name));
  if (!fits.length) return null;
  const pool = fits.filter(r => online.has(r.id));
  const pickFrom = pool.length && Math.random() < 0.8 ? pool : fits;
  const r = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  if (used) used.add(r.name);
  const st = residentStats(r, now);
  return { resident: r, name: r.name, registered: r.registered, rating: r.registered ? st.rating : null, level: r.registered ? st.level : 1 };
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
  if (!r) return { name: pickPersona({ guestChance: 0.15 }).name, text: randomChatLine(), resident: null };
  return { name: r.name, text: composeLine(r, ctx, custom.lines), resident: r };
}

// Chattier residents speak more often; lurkers mostly lurk.
function weightedByChat(list) {
  if (!list.length) return null;
  const total = list.reduce((a, r) => a + r.chatty, 0);
  let x = Math.random() * total;
  for (const r of list) { x -= r.chatty; if (x <= 0) return r; }
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
  return crowdReplies(text, ctx, forcedName).map(x => ({ name: x.resident.name, text: x.text, delay: x.delay, resident: x.resident }));
}

// ---------------------------------------------------------------------------
// Ghost leaderboard rows: residents first (so chat names match the rankings),
// topped up with weekly-reseeded randoms when the board wants more.
// ---------------------------------------------------------------------------

const GHOST_COUNT = { score: 40, rating: 30, dungeon: 24, weekly: 18, sprint: 22 };

// `taken`: Set of real usernames — ghosts never shadow a real player.
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
    badges: st.badges,
    title: st.title,
  });

  // Residents: only the registered ones appear on rankings. Which subset
  // shows on a given board is stable per week so the boards don't churn.
  const residents = getRoster().filter(r => r.registered && !used.has(r.name));
  const keyed = residents
    .map(r => ({ r, k: unit(`${r.id}-${board}`, weekId) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, count)
    .map(x => x.r);
  for (const r of keyed) {
    used.add(r.name);
    rows.push(rowOf(r.name, residentStats(r, now, weekId)));
  }

  // Top up with anonymous ghosts when the board wants more than the cast.
  const rng = mulberry32(strHash(`bba-ghost-${weekId}-${board}`));
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
    return {
      id: r.id, name: r.name, arch: r.arch, archLabel: a.label, lang: r.lang,
      skill: r.skill, chatty: r.chatty, favMode: r.favMode, hours: r.hours,
      registered: r.registered, custom: r.custom,
      rating: st.rating, level: st.level, tier: st.tier.name, online: online.has(r.id),
    };
  });
}

export { ARCHETYPES, residentStats, archetype };
