// Block Blitz Arena — game server
// Express REST API (auth / leaderboard / shop / battle pass / admin) + WebSocket 1v1 battles.
import express from 'express';
import compression from 'compression';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { loadDb, saveDb, flushDb, DATA_DIR } from './db.js';
import { initBattle } from './battle.js';
import {
  hashPassword, verifyPassword, issueToken, revokeToken, revokeAllTokens,
  authMiddleware, requireAuth, requireAdmin, userFromToken, SESSIONS_PERSIST,
} from './auth.js';
import {
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED, BOOST_ITEMS, EQUIP_SLOTS,
  BP_TIERS, BP_XP_PER_TIER, BP_PREMIUM_PRICE_GEMS, BP_SEASON_DAYS,
  BOSSES, TITLES, earnedTitles, GEM_PACKS,
} from './catalog.js';
import {
  syncMissions, trackMissions, missionsView, claimMission, claimMissionBonus,
} from './missions.js';
import { achievementsView, claimAchievement, ACHIEVEMENTS } from './achievements.js';
import {
  ghostRows, setLiveScale, getLiveScale, setCustom, getCustom, setWorldProvider,
  rosterView, retiredResidents, crowdMood, ambientQueue, isQuietNow, DEFAULT_TOGGLES, ARCHETYPES,
  MAX_LIVE_SCALE, residentByName, activeResidents, residentStats, archetype,
  boardResidents,
} from './ambient.js';
import { BADGE_NAMES } from './crowd.js';
import {
  GUILD_CREATE_COST, GUILD_ICONS, createGuild, findGuild, joinGuild, leaveGuild, kickMember,
  addGuildPoints, guildView, guildLevel, guildCoinBonus, ghostGuildViews, tagOfName, validateGuildInput,
  ghostGuildOfResident,
} from './guilds.js';
import { TRANSLATE_ENGINE, translateChat } from './translate.js';
import {
  validateBackup, applyRestore, snapshot, listSnapshots, readSnapshot, BACKUP_VERSION,
} from './backup.js';
import { EVENT_TYPES, makeEvent, eventBonus } from './events.js';
import {
  createPoll, eventPollOptions, vote as castVote, pollView, tickPoll, winnerOf, isOpen as pollOpen,
} from './polls.js';
import {
  AE_MODES, WEEKDAYS_JA as AE_WEEKDAYS_JA,
  aeMode as aeModeById, getSchedule as getAeSchedule, normalizeSchedule as aeNormalizeSchedule,
  currentOccurrence as aeCurrentOccurrence, upcomingOccurrences as aeUpcoming,
  reserve as aeReserve, cancelReservation as aeCancelReservation, liveSlotFor as aeLiveSlotFor,
  ensureRun as aeEnsureRun, contribute as aeContribute,
  playerView as aePlayerView, slotCounts as aeSlotCounts, entrantCount as aeEntrantCount,
} from './adminevent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const db = loadDb();
setLiveScale(db.meta.popScale === undefined ? 1 : db.meta.popScale);
if (db.meta.ambient) setCustom(db.meta.ambient);

// Heal guilds that account deletions already jammed. Until v2.11 a deleted
// account left its id in guild.members (counter stuck at 20/20, "ギルドは満員
// です" for every applicant) and, if it was the owner, in guild.ownerId — after
// which nothing could rename, re-open or kick. New deletions call leaveGuild;
// this repairs the damage that is sitting in the live db.json right now.
{
  let fixed = 0, disbanded = 0;
  for (const g of Object.values(db.guilds || {})) {
    const live = (g.members || []).filter(id => db.users[id]);
    if (live.length === (g.members || []).length) continue;
    g.members = live;
    fixed++;
    if (!live.length) { delete db.guilds[g.id]; disbanded++; continue; }
    if (!db.users[g.ownerId]) {
      g.ownerId = live.map(id => db.users[id])
        .sort((a, b) => (a.guildJoinedAt || 0) - (b.guildJoinedAt || 0))[0].id;
    }
  }
  if (fixed) console.log(`[guilds] 幽霊メンバーを掃除: ${fixed}件（解散 ${disbanded}件）`);
}

// A throw that escapes an async boundary used to take the process down AND
// discard everything the debounced writer had not flushed yet.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  try { flushDb(); } catch { /* nothing left to try */ }
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});
const app = express();
app.set('trust proxy', 1);
app.use(compression());   // gzip — big win for overseas players on slow links
// Restore uploads a whole database dump, so it gets its own generous parser;
// every other route stays on the tight limit.
const jsonParser = express.json({
  limit: '64kb',
  // Keep the raw body for Stripe webhook signature verification.
  verify: (req, _res, buf) => { req.rawBody = buf; },
});
const restoreParser = express.json({ limit: '64mb' });
app.use((req, res, next) => {
  if (req.path === '/api/admin/restore') return restoreParser(req, res, next);
  return jsonParser(req, res, next);
});
// Body-parser failures must still answer JSON — the client shows `error`.
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'ファイルが大きすぎます（最大64MB）' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSONとして読み取れませんでした' });
  return next(err);
});
app.use(authMiddleware);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  // Icons are immutable — cache a week. Everything else revalidates
  // (ETag 304) so client updates ship immediately.
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}icons${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newUser(username, password, role = 'user') {
  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  const user = {
    id, username, salt, passHash: hash, role,
    banned: false, createdAt: Date.now(),
    coins: 500, gems: 50, xp: 0,
    stats: {
      gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0,
      aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000, bossMax: 0,
      ultsUsed: 0, itemsUsed: 0, missionsDone: 0, piecesPlaced: 0,
      survivalWave: 0, winStreakBest: 0, loginStreak: 1, loginStreakBest: 1,
      sprintPlays: 0, coopPlays: 0, coopBest: 0, sprint: {},
      meltdownBest: 0, chimeraBest: 0,
      history: [],
    },
    owned: [...DEFAULT_OWNED],
    items: { item_bomb: 1, item_cleaner: 1, item_fever: 1 },   // starter boosters
    equipped: { ...DEFAULT_EQUIPPED },
    equippedTitle: null,
    battlePass: { season: currentSeason().id, xp: 0, premium: false, claimed: [] },
    badges: [],
    achievements: [],
    missions: null,   // generated on first access (syncMissions)
    lastDaily: new Date().toISOString().slice(0, 10),
  };
  db.users[id] = user;
  saveDb();
  return user;
}

// Bring accounts created before a feature shipped up to the current shape.
// Cheap and idempotent — called from publicUser + every progression path.
function migrateUser(user) {
  if (!user) return user;
  const s = user.stats || (user.stats = {});
  for (const [k, v] of Object.entries({
    ultsUsed: 0, itemsUsed: 0, missionsDone: 0, piecesPlaced: 0,
    survivalWave: 0, winStreakBest: 0, loginStreak: 1, loginStreakBest: 1,
    sprintPlays: 0, coopPlays: 0, coopBest: 0, abyssMax: 0, guildBestWeek: 0,
    meltdownBest: 0, chimeraBest: 0, rushDepth: 0,
    totalWins: 0, playSecs: 0, bossKills: 0, chaosPlays: 0, meltdownPlays: 0,
    chimeraPlays: 0, survivalPlays: 0, weeklyPlays: 0, dailyLogins: 1,
    gachaPulls: 0, gachaSSR: 0, chatMessages: 0, reactionsGiven: 0,
    weeklyWins: 0, puzzleStage: 0, puzzlePlays: 0, digDepth: 0, digPlays: 0,
    ghostBest: 0, ghostPlays: 0,
  })) if (s[k] === undefined) s[k] = v;
  if (!s.bossRanks || typeof s.bossRanks !== 'object') s.bossRanks = {};
  if (user.guildId && !(db.guilds && db.guilds[user.guildId])) user.guildId = null;
  if (!s.sprint || typeof s.sprint !== 'object') s.sprint = {};
  if (!Array.isArray(s.history)) s.history = [];
  if (!Array.isArray(user.achievements)) user.achievements = [];
  if (!Array.isArray(user.rankRewards)) user.rankRewards = [];   // pending ランキング報酬
  if (typeof user.gachaPity !== 'number') user.gachaPity = 0;    // ガチャ天井カウンター
  if (!user.equipped) user.equipped = { ...DEFAULT_EQUIPPED };
  // Ultimate-skill slot (v2.0): everyone starts with the free 破壊の衝撃波.
  if (!user.equipped.ult) user.equipped.ult = DEFAULT_EQUIPPED.ult;
  if (!Array.isArray(user.owned)) user.owned = [...DEFAULT_OWNED];
  for (const id of DEFAULT_OWNED) if (!user.owned.includes(id)) user.owned.push(id);
  // Top-level fields, not just stats. Only `stats` was being repaired, so a
  // record from an older schema (or a hand-edited backup) reached
  // publicUser() → syncBattlePass() without a battlePass and 500'd the login.
  // The Number() guards also stop a corrupted value writing NaN back to disk,
  // which poisons every later read of that account.
  if (!Array.isArray(user.badges)) user.badges = [];
  if (!user.items || typeof user.items !== 'object') user.items = {};
  for (const k of ['coins', 'gems', 'xp']) {
    if (!Number.isFinite(user[k])) user[k] = 0;
  }
  if (!user.battlePass || typeof user.battlePass !== 'object') {
    user.battlePass = { season: currentSeason().id, xp: 0, premium: false, claimed: [] };
  }
  if (!Array.isArray(user.battlePass.claimed)) user.battlePass.claimed = [];
  if (user.role !== 'admin' && user.role !== 'mod') user.role = 'user';
  return user;
}

function levelOf(xp) { return 1 + Math.floor(xp / 1000); }

// Season number/endsAt derive from a fixed epoch instead of stored state, so a
// redeploy (which wipes the DB on this hosting tier) computes the SAME season
// with the SAME id — no more "every update restarts the 30-day season", and no
// more battle-pass wipes (the pass is keyed by season id, which used to be a
// per-instance random UUID). Admin overrides live in db.meta.seasonOverride:
// { baseIndex, gen, numberOffset, name, startedAt, endsAt } — gen bumps force a
// reset, endsAt (while in the future) freezes the season past the 30-day grid.
const SEASON_MS = BP_SEASON_DAYS * 24 * 60 * 60 * 1000;
const SEASON_EPOCH = 1784782260770;   // maps the live S2 (ends 2026-09-20) exactly

function derivedSeasonIndex(now = Date.now()) {
  return Math.max(1, Math.floor((now - SEASON_EPOCH) / SEASON_MS) + 1);
}

function currentSeason() {
  const now = Date.now();
  const idx = derivedSeasonIndex(now);
  let o = db.meta.seasonOverride || null;
  // An admin-shortened season whose endsAt passed BEFORE the natural 30-day
  // boundary must actually end: roll it into a forced next season starting at
  // that moment (gen bump = new id = battle passes reset), not silently resume
  // the old one with a later end date. Lazy + idempotent, like the old rollover.
  while (o && o.endsAt && o.endsAt <= now && (o.baseIndex || idx) === idx) {
    o = db.meta.seasonOverride = {
      baseIndex: idx,
      gen: (o.gen || 0) + 1,
      numberOffset: (o.numberOffset || 0) + 1,
      name: null,
      startedAt: o.endsAt,
      endsAt: o.endsAt + SEASON_MS,
    };
    saveDb();
  }
  const extended = !!(o && o.endsAt && o.endsAt > now);
  const effIdx = extended ? (o.baseIndex || idx) : idx;
  const gen = o ? (o.gen || 0) : 0;
  const number = effIdx + (o ? (o.numberOffset || 0) : 0);
  const custom = o && o.name && effIdx === (o.baseIndex || idx);
  return {
    id: `s${effIdx}${gen ? '-' + gen : ''}`,
    number,
    name: custom ? o.name : `シーズン ${number}`,
    nameEn: custom ? o.name : `Season ${number}`,
    startedAt: extended && o.startedAt ? o.startedAt : SEASON_EPOCH + (effIdx - 1) * SEASON_MS,
    endsAt: extended ? o.endsAt : SEASON_EPOCH + effIdx * SEASON_MS,
  };
}

// Bridge from the stored-season era (and from restored backups): a legacy
// season object whose clock is still running IS today's season, so every
// battle pass pointing at its old UUID carries over instead of resetting.
function adoptLegacySeason(legacy) {
  if (!legacy || !legacy.id || typeof legacy.id !== 'string') return 0;
  const cur = currentSeason();
  if (legacy.id === cur.id || !(legacy.endsAt > Date.now())) return 0;
  let n = 0;
  for (const u of Object.values(db.users)) {
    if (u.battlePass && u.battlePass.season === legacy.id) { u.battlePass.season = cur.id; n++; }
  }
  return n;
}

// Reset a user's battle pass if the season rolled over.
function syncBattlePass(user) {
  const season = currentSeason();
  if (user.battlePass.season !== season.id) {
    user.battlePass = { season: season.id, xp: 0, premium: false, claimed: [] };
    saveDb();
  }
  return user.battlePass;
}

function publicUser(user) {
  if (!user) return null;
  migrateUser(user);
  const bp = syncBattlePass(user);
  const isAdmin = user.role === 'admin';
  // Admins own the whole shop and the fully-unlocked premium pass.
  const adminBp = isAdmin
    ? { ...bp, premium: true, xp: BP_TIERS.length * BP_XP_PER_TIER }
    : bp;
  return {
    id: user.id, username: user.username, role: user.role, banned: user.banned,
    coins: user.coins, gems: user.gems, xp: user.xp, level: levelOf(user.xp),
    stats: user.stats,
    owned: isAdmin ? SHOP_ITEMS.map(i => i.id) : user.owned,
    equipped: user.equipped,
    items: user.items || {},
    battlePass: adminBp, badges: user.badges,
    equippedTitle: user.equippedTitle || null,
    achievements: user.achievements,
    rankRewards: user.rankRewards || [],
    thrones: thronesOf(user.id),
    guild: user.guildId && db.guilds[user.guildId]
      ? { id: user.guildId, name: db.guilds[user.guildId].name, tag: db.guilds[user.guildId].tag, icon: db.guilds[user.guildId].icon, owner: db.guilds[user.guildId].ownerId === user.id }
      : null,
  };
}

// Sanity-check and apply a finished game's rewards. Returns the reward summary.
function applyGameResult(user, { mode, score, lines, maxCombo, duration, won, drew, bossId, floor, wave, ults, items, pieces, floors, sprintDur, rank, depth, stage }) {
  const extraBossId = typeof bossId === 'string' ? bossId : null;
  mode = String(mode || 'solo');
  migrateUser(user);
  // Pay out last week's ranking BEFORE this game can overwrite a stale
  // stats.weekly record with the new week.
  finalizeWeeklyRankings();
  // v2.0 telemetry from the client — clamped like everything else.
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  wave = clamp(wave, 999);
  ults = clamp(ults, 200);
  items = clamp(items, 200);
  pieces = clamp(pieces, 20000);
  floors = clamp(floors, 100);
  depth = clamp(depth, 9999);
  stage = clamp(stage, 9999);
  rank = ['S', 'A', 'B', 'C'].includes(rank) ? rank : null;
  score = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
  lines = Math.max(0, Math.min(5000, Math.floor(Number(lines) || 0)));
  maxCombo = Math.max(0, Math.min(200, Math.floor(Number(maxCombo) || 0)));
  duration = Math.max(1, Math.min(7200, Number(duration) || 1));
  // Cheat guard: cap plausible score rate. Time attack is *about* scoring
  // fast; Meltdown runs hot multipliers (×15+ near critical) in short bursts
  // and Chimera stacks up to ×3 — both need looser ceilings than the endless
  // modes or legit runs get silently clipped.
  // Dig stacks depth-scaled ore bonuses on top of normal scoring, so it gets a
  // slightly looser ceiling too.
  const rateCap = mode === 'sprint' ? 1000 : mode === 'meltdown' ? 2000 : mode === 'chimera' ? 1000 : mode === 'dig' ? 800 : 500;
  if (score > duration * rateCap) score = Math.floor(duration * rateCap);

  let coins = Math.min(1000, 20 + Math.floor(score / 100) + (won ? 50 : 0));
  if (mode === 'chaos') coins = Math.min(1500, Math.round(coins * 1.5));   // chaos-mode bonus
  let bpXp = Math.min(800, 30 + Math.floor(score / 60) + lines * 5 + (won ? 100 : 0));
  let accXp = Math.min(600, 20 + Math.floor(score / 100) + (won ? 80 : 0));

  // Limited-time event multipliers.
  const bonus = eventBonus(currentEvent());
  const isBossMode = mode === 'boss' || mode === 'boss_rush' || mode === 'raid';
  let eventCoins = 0, eventGems = 0;
  const coinMult = (bonus.coin || 1) * (isBossMode && bonus.bossCoin ? bonus.bossCoin : 1);
  if (coinMult > 1) {
    const boosted = Math.round(coins * coinMult);
    eventCoins = boosted - coins;
    coins = boosted;
  }
  if (bonus.xp > 1) {
    bpXp = Math.round(bpXp * bonus.xp);
    accXp = Math.round(accXp * bonus.xp);
  }
  if (bonus.gemDrop > 0) {
    eventGems = Math.floor(bonus.gemDrop);
    user.gems += eventGems;
  }

  // Guild: every game feeds the weekly race, and the guild's level pays a
  // coin bonus back to its members.
  let guildPts = 0, guildBonus = 0;
  const guild = user.guildId ? db.guilds[user.guildId] : null;
  if (guild) {
    const wk = weekIdOf(currentWeekNum());
    guildPts = addGuildPoints(db, user, Math.floor(score / 400) + (won ? 25 : 0) + Math.floor(lines / 2), wk);
    guildBonus = Math.floor(coins * guildCoinBonus(guildLevel(guild.lifetime || 0)));
    coins += guildBonus;
    const mine = (guild.weekly[wk] && guild.weekly[wk].byMember[user.id]) || 0;
    if (mine > (user.stats.guildBestWeek || 0)) user.stats.guildBestWeek = mine;
  }

  user.coins += coins;
  user.xp += accXp;
  syncBattlePass(user);
  user.battlePass.xp = Math.min(BP_TIERS.length * BP_XP_PER_TIER, user.battlePass.xp + bpXp);

  const s = user.stats;
  s.gamesPlayed += 1;
  s.totalScore += score;
  s.totalLines += lines;
  const prevBest = s.bestScore;
  const prevCombo = s.maxCombo;
  // Meltdown's critical-heat multiplier (×15+) makes its totals incomparable
  // to a plain game — it stays off the global score board (own best stat).
  // Chimera caps around ×3, same ballpark as chaos, so it counts.
  // 管理者イベントも同じ理由で除外: ルーレットは×5、襲来は妨害まみれで、
  // 「誰でも挑めるモードのハイスコア」と並べても意味がない。
  const scoreboardEligible = mode !== 'meltdown' && !mode.startsWith('ae_');
  if (scoreboardEligible && score > s.bestScore) s.bestScore = score;
  if (maxCombo > s.maxCombo) s.maxCombo = maxCombo;
  s.ultsUsed = (s.ultsUsed || 0) + ults;
  s.itemsUsed = (s.itemsUsed || 0) + items;
  s.piecesPlaced = (s.piecesPlaced || 0) + pieces;
  const newWaveBest = mode === 'survival' && wave > (s.survivalWave || 0);
  if (newWaveBest) s.survivalWave = wave;
  if (mode === 'sprint') s.sprintPlays = (s.sprintPlays || 0) + 1;
  if (mode === 'coop') s.coopPlays = (s.coopPlays || 0) + 1;
  // Lifetime counters (v2.6) — cheap monotonic stats that power achievements.
  if (won) s.totalWins = (s.totalWins || 0) + 1;
  s.playSecs = (s.playSecs || 0) + duration;
  if (mode === 'boss' && won) s.bossKills = (s.bossKills || 0) + 1;
  if (mode === 'chaos') s.chaosPlays = (s.chaosPlays || 0) + 1;
  if (mode === 'meltdown') s.meltdownPlays = (s.meltdownPlays || 0) + 1;
  if (mode === 'chimera') s.chimeraPlays = (s.chimeraPlays || 0) + 1;
  if (mode === 'survival') s.survivalPlays = (s.survivalPlays || 0) + 1;
  if (mode === 'weekly') s.weeklyPlays = (s.weeklyPlays || 0) + 1;
  // Rolling score history powers the profile dashboard chart.
  if (!Array.isArray(s.history)) s.history = [];
  s.history.push({ t: Date.now(), m: String(mode).slice(0, 16), s: score, w: won ? 1 : 0 });
  if (s.history.length > 40) s.history = s.history.slice(-40);
  let badge = null;
  let gems = 0;
  // Ranked-duel win streak: bonus coins that grow with the streak.
  let streakBonus = 0;
  if (mode === 'pvp') {
    if (won) {
      s.winStreak = (s.winStreak || 0) + 1;
      if (s.winStreak > (s.winStreakBest || 0)) s.winStreakBest = s.winStreak;
      if (s.winStreak >= 2) {
        streakBonus = Math.min(200, s.winStreak * 20);
        coins += streakBonus;
        user.coins += streakBonus;
      }
    } else if (!drew) {
      s.winStreak = 0;
    }
  }
  if (mode.startsWith('ai') && won) s.aiWins += 1;
  if (mode === 'ai_oni' && won && !user.badges.includes('oni')) {
    user.badges.push('oni');
    badge = 'oni';
  }
  if (mode === 'ai_kami' && won && !user.badges.includes('kami')) {
    user.badges.push('kami');
    badge = 'kami';
  }
  if (mode === 'ai_souzou' && won && !user.badges.includes('souzou')) {
    user.badges.push('souzou');
    badge = 'souzou';
  }
  // Boss rush: clear all bosses back-to-back for a badge + one-time gems.
  if (mode === 'boss_rush' && won && !user.badges.includes('rush')) {
    user.badges.push('rush');
    badge = 'rush';
    gems = 300;
    user.gems += 300;
  }
  // Tournament: first championship earns a badge + one-time gems.
  if (mode === 'tournament' && won && !user.badges.includes('tourney')) {
    user.badges.push('tourney');
    badge = 'tourney';
    gems += 100;
    user.gems += 100;
  }
  // Battle royale: first #1 finish out of 100 earns a badge + one-time gems.
  if (mode === 'royale' && won && !user.badges.includes('royale')) {
    user.badges.push('royale');
    badge = 'royale';
    gems += 150;
    user.gems += 150;
  }
  // Time attack: one personal best per duration.
  if (mode === 'sprint') {
    const dur = [60, 180].includes(Number(sprintDur)) ? Number(sprintDur) : 60;
    s.sprint = s.sprint || {};
    const key = `s${dur}`;
    if (score > (s.sprint[key] || 0)) s.sprint[key] = score;
  }
  // Weekly challenge: per-week personal best.
  if (mode === 'weekly') {
    const w = weekIdOf(currentWeekNum());
    if (!s.weekly || s.weekly.week !== w) s.weekly = { week: w, best: 0 };
    if (score > s.weekly.best) s.weekly.best = score;
  }
  // メルトダウン / キメラ工房: per-mode personal bests.
  if (mode === 'meltdown' && score > (s.meltdownBest || 0)) s.meltdownBest = score;
  if (mode === 'chimera' && score > (s.chimeraBest || 0)) s.chimeraBest = score;
  // 🧩 パズル遺跡: highest stage cleared + first-clear badge at stage 50.
  // stage/depth are client-declared (same trust level as floor/wave) — the gem
  // faucet is bounded like the dungeon's: decade payouts stop at stage 100, and
  // the stored stat is capped so a forged request can't own the leaderboard.
  if (mode === 'puzzle') {
    s.puzzlePlays = (s.puzzlePlays || 0) + 1;
    const st = Math.min(stage, 999);
    if (won && st > (s.puzzleStage || 0)) {
      const decades = Math.floor(Math.min(st, 100) / 10) - Math.floor(Math.min(s.puzzleStage || 0, 100) / 10);
      if (decades > 0) {
        gems += decades * 25;
        user.gems += decades * 25;
      }
      s.puzzleStage = st;
      if (st >= 50 && !user.badges.includes('puzzle')) {
        user.badges.push('puzzle');
        badge = 'puzzle';
        gems += 300;
        user.gems += 300;
      }
    }
  }
  // 👻 幽霊屋敷 (hidden): memory-mode best + badge at 15,000.
  if (mode === 'ghost') {
    s.ghostPlays = (s.ghostPlays || 0) + 1;
    if (score > (s.ghostBest || 0)) s.ghostBest = score;
    if (score >= 15000 && !user.badges.includes('ghost')) {
      user.badges.push('ghost');
      badge = 'ghost';
      gems += 250;
      user.gems += 250;
    }
  }
  // ⛏️ 採掘場: deepest dig + first-clear badge at 50m.
  if (mode === 'dig') {
    s.digPlays = (s.digPlays || 0) + 1;
    const dp = Math.min(depth, 999);
    if (dp > (s.digDepth || 0)) {
      s.digDepth = dp;
      if (dp >= 50 && !user.badges.includes('dig')) {
        user.badges.push('dig');
        badge = 'dig';
        gems += 300;
        user.gems += 300;
      }
    }
  }
  // Dungeon tower: track highest floor cleared; gems for each newly reached
  // checkpoint decade, badge + big gem bonus for conquering all 100 floors.
  // The Abyss: the hardest realm — double gems per decade, a badge and a big
  // bonus for the bottom.
  if (mode === 'dungeon_abyss') {
    const fl = Math.max(0, Math.min(100, Math.floor(Number(floor) || 0)));
    const prevMax = s.abyssMax || 0;
    if (fl > prevMax) {
      const decades = Math.floor(fl / 10) - Math.floor(prevMax / 10);
      if (decades > 0) {
        gems += decades * 40;
        user.gems += decades * 40;
      }
      s.abyssMax = fl;
    }
    if (fl >= 100 && !user.badges.includes('abyss')) {
      user.badges.push('abyss');
      badge = 'abyss';
      gems += 1000;
      user.gems += 1000;
    }
  }
  if (mode === 'dungeon') {
    const fl = Math.max(0, Math.min(100, Math.floor(Number(floor) || 0)));
    const prevMax = s.dungeonMax || 0;
    if (fl > prevMax) {
      const decades = Math.floor(fl / 10) - Math.floor(prevMax / 10);
      if (decades > 0) {
        gems += decades * 20;
        user.gems += decades * 20;
      }
      s.dungeonMax = fl;
    }
    if (fl >= 100 && !user.badges.includes('dungeon')) {
      user.badges.push('dungeon');
      badge = 'dungeon';
      gems += 500;
      user.gems += 500;
    }
  }
  // Boss battles: sequential progression + first-clear gem bonus + clear rank.
  if (mode === 'boss') {
    const idx = BOSSES.findIndex(b => b.id === extraBossId);
    if (idx !== -1 && won) {
      if (idx >= (s.bossMax || 0)) {
        s.bossMax = idx + 1;
        gems = BOSSES[idx].gemsFirst;
        user.gems += gems;
      }
      if (BOSSES[idx].id === 'maou' && !user.badges.includes('maou')) {
        user.badges.push('maou');
        badge = 'maou';
      }
      // 討伐ランク: ボスごとに最高ランクを保存（S > A > B > C）。
      if (rank) {
        if (!s.bossRanks || typeof s.bossRanks !== 'object') s.bossRanks = {};
        const order = { S: 4, A: 3, B: 2, C: 1 };
        if ((order[rank] || 0) > (order[s.bossRanks[extraBossId]] || 0)) s.bossRanks[extraBossId] = rank;
      }
    }
  }
  // 無限地獄ラッシュ: 深度（累計撃破数）のベストを記録。
  if (mode === 'boss_rush' && depth > (s.rushDepth || 0)) s.rushDepth = depth;
  // ---- Live feed + crowd reactions for notable real moments ----
  const feedNotes = [];
  const nm = user.username;
  if (scoreboardEligible && score > prevBest && prevBest > 0 && score >= 8000) {
    feedNotes.push({ icon: '⭐', ja: `${nm} が自己ベスト ${fmtNum(score)} 点を更新！`, en: `${nm} set a new best: ${score.toLocaleString('en-US')}!`,
      react: score >= 30000 ? ['record', { you: nm, score: fmtNum(score) }] : null });
  }
  if (maxCombo >= 10 && maxCombo > prevCombo) {
    feedNotes.push({ icon: '🔥', ja: `${nm} が ${maxCombo} コンボを達成！`, en: `${nm} landed a ${maxCombo} combo!` });
  }
  if (mode === 'tournament' && won) {
    feedNotes.push({ icon: '🏆', ja: `${nm} がトーナメントで優勝！`, en: `${nm} won the tournament!`, react: ['champion', { you: nm }] });
  } else if (mode === 'royale' && won) {
    feedNotes.push({ icon: '💯', ja: `${nm} がバトルロイヤルで1位！`, en: `${nm} took #1 in battle royale!`, react: ['royale_win', { you: nm }] });
  } else if (mode === 'ai_souzou' && won) {
    feedNotes.push({ icon: '🌌', ja: `${nm} が 創造神 を超えた！！！`, en: `${nm} surpassed the Creator God!!!` });
  } else if (mode === 'ai_kami' && won) {
    feedNotes.push({ icon: '🔱', ja: `${nm} が 神 を討伐！！`, en: `${nm} slew the Kami AI!!` });
  } else if (mode === 'ai_oni' && won) {
    feedNotes.push({ icon: '👹', ja: `${nm} が 鬼AI を撃破！`, en: `${nm} crushed the Oni AI!` });
  }
  if (badge && mode !== 'tournament' && mode !== 'royale') {
    const bn = BADGE_NAMES[badge] || badge;
    feedNotes.push({ icon: BADGE_ICONS[badge] || '🎖️', ja: `${nm} が「${bn}」を獲得！`, en: `${nm} earned "${BADGE_NAMES_EN[badge] || badge}"!`,
      react: ['badge', { you: nm, badge: bn }] });
  }
  if (mode === 'boss' && won && gems > 0 && extraBossId) {
    const b = BOSSES.find(x => x.id === extraBossId);
    if (b) feedNotes.push({ icon: '🐲', ja: `${nm} が ${b.name} を初討伐！`, en: `${nm} defeated ${b.nameEn || b.name} for the first time!` });
  }
  if (mode.startsWith('dungeon') && floor >= 10 && Math.floor(floor / 10) > Math.floor((s.dungeonPrev || 0) / 10)) {
    feedNotes.push({ icon: '🏰', ja: `${nm} がダンジョン F${Math.floor(Number(floor) || 0)} に到達`, en: `${nm} reached dungeon F${Math.floor(Number(floor) || 0)}` });
  }
  if (newWaveBest && wave >= 10) feedNotes.push({ icon: '💀', ja: `${nm} がサバイバル WAVE ${wave} に到達`, en: `${nm} survived to wave ${wave}` });
  if (mode === 'sprint' && score >= 8000 && s.sprint && score >= (s.sprint[`s${[60, 180].includes(Number(sprintDur)) ? sprintDur : 60}`] || 0)) {
    feedNotes.push({ icon: '⏱️', ja: `${nm} がタイムアタック${sprintDur === 180 ? '3分' : '60秒'}で ${fmtNum(score)} 点！`, en: `${nm} scored ${score.toLocaleString('en-US')} in the ${sprintDur === 180 ? '3 min' : '60s'} time attack!` });
  }
  s.dungeonPrev = Math.max(s.dungeonPrev || 0, mode.startsWith('dungeon') ? Math.floor(Number(floor) || 0) : 0);
  postRealFeed(user, feedNotes);

  // Daily / weekly missions advance off the same event.
  const missionsCompleted = trackMissions(user, currentWeekNum(), {
    mode, score, maxCombo, lines, won: !!won,
    floors: mode.startsWith('dungeon') ? floors : 0,
    // Survival missions must not advance from other modes' stray wave fields.
    wave: mode === 'survival' ? wave : 0,
    stage: mode === 'puzzle' ? stage : 0,
    depth: mode === 'dig' ? depth : 0,
    ults, items, pieces,
  });
  saveDb();
  refreshThrones(true);   // 👑 did this run take (or defend) a #1 spot?
  return {
    coins, bpXp, accXp, score, badge, gems: gems + eventGems,
    streak: s.winStreak || 0, streakBonus,
    missionsCompleted,
    eventCoins, eventGems,
    guildPts, guildBonus,
  };
}

// Real players' notable moments go on the live feed (starred), and the crowd
// may react. Capped per user so a hot streak doesn't flood the ticker.
const BADGE_ICONS = { oni: '👹', kami: '🔱', souzou: '🌌', maou: '😈', rush: '⚔️', dungeon: '🏰', tourney: '🏆', royale: '💯', adminevent: '👑', weekly1: '🏅', puzzle: '🧩', dig: '⛏️', crown2: '👑', crown3: '👑', crown5: '👑', crown7: '🌈', ghost: '👻' };
const BADGE_NAMES_EN = { oni: 'Oni Slayer badge', kami: 'God Slayer badge', souzou: 'Creator Slayer badge', maou: 'Demon Lord badge', rush: 'Boss Rush Clear', dungeon: 'Tower Conqueror', tourney: 'Tournament Champion', royale: 'Royale #1', adminevent: 'Admin Event', weekly1: 'Weekly Champion', puzzle: 'Ruins Master', dig: 'Master Miner', crown2: 'Dual Crown', crown3: 'Triple Crown', crown5: 'Five Crowns', crown7: 'Total Domination', ghost: 'Haunted House' };
const feedAt = new Map();   // userId -> last feed timestamp
function postRealFeed(user, notes) {
  if (!notes.length) return;
  const last = feedAt.get(user.id) || 0;
  // Always let the rarest moments through; throttle the ordinary ones.
  const big = notes.filter(n => n.react);
  const now = Date.now();
  const allowed = big.length ? big.concat(notes.filter(n => !n.react)).slice(0, 2)
    : now - last < 45000 ? [] : notes.slice(0, 1);
  if (!allowed.length) return;
  feedAt.set(user.id, now);
  for (const n of allowed) {
    battle.crowd.feed({ icon: n.icon, real: true, who: user.username, text: n.ja, textEn: n.en });
    if (n.react) battle.crowd.react(n.react[0], n.react[1]);
  }
}

// Simple in-memory rate limiter (per key, sliding window).
// Keyed by IP (and by user for some routes), so on a long-lived instance this
// grew for every address that ever touched the server and never shrank. Both
// this and feedAt are swept on a slow timer.
const rateMap = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { rateMap.set(key, arr); return false; }
  arr.push(now);
  rateMap.set(key, arr);
  return true;
}

setInterval(() => {
  const now = Date.now();
  // Nothing here has a window longer than an hour.
  for (const [k, arr] of rateMap) {
    if (!arr.length || now - arr[arr.length - 1] > 3600_000) rateMap.delete(k);
  }
  for (const [k, at] of feedAt) {
    if (now - at > 3600_000) feedAt.delete(k);
  }
}, 600_000).unref?.();

function inMaintenance() { return !!db.meta.maintenance; }

// Moderators (or admins): chat policing only — no economy/user management.
function requireMod(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'mod')) {
    return res.status(403).json({ error: 'モデレーター権限が必要です' });
  }
  next();
}

// Blocks gameplay/economy endpoints for non-admins during maintenance.
function maintenanceGuard(req, res, next) {
  if (inMaintenance() && (!req.user || req.user.role !== 'admin')) {
    return res.status(503).json({ error: '🛠 メンテナンス中です。しばらくお待ちください' });
  }
  next();
}

const DAILY_COINS = 100;
const DAILY_GEMS = 5;

// Grant the once-per-day login bonus. Returns the bonus or null.
// Daily login bonus. Consecutive days build a streak that scales the reward
// (day 7 and beyond pay roughly triple day 1) — missing a day resets it.
function grantDaily(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.lastDaily === today) return null;
  migrateUser(user);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const s = user.stats;
  s.loginStreak = user.lastDaily === yesterday ? (s.loginStreak || 0) + 1 : 1;
  if (s.loginStreak > (s.loginStreakBest || 0)) s.loginStreakBest = s.loginStreak;
  s.dailyLogins = (s.dailyLogins || 0) + 1;   // lifetime total, streak-independent
  user.lastDaily = today;
  const mult = Math.min(3, 1 + (s.loginStreak - 1) * 0.35);
  let coins = Math.round(DAILY_COINS * mult);
  let gems = Math.round(DAILY_GEMS * mult);
  // 👑 王座の俸給 — a throne holder collects extra with every daily bonus.
  // 多冠は段階ボーナス上乗せ（2冠+200🪙3💎 / 3冠+400🪙6💎 / 5冠+800🪙12💎 / 7冠+1600🪙24💎）。
  const thrones = thronesOf(user.id);
  let throneBonus = null;
  if (thrones.length) {
    const n = thrones.length;
    const tier = n >= 7 ? { coins: 1600, gems: 24, name: '全冠制覇' }
      : n >= 5 ? { coins: 800, gems: 12, name: '五冠' }
      : n >= 3 ? { coins: 400, gems: 6, name: '三冠' }
      : n >= 2 ? { coins: 200, gems: 3, name: '二冠' } : null;
    throneBonus = {
      coins: THRONE_DAILY_COINS * n + (tier ? tier.coins : 0),
      gems: THRONE_DAILY_GEMS * n + (tier ? tier.gems : 0),
      boards: thrones, tier: tier ? tier.name : null,
    };
    coins += throneBonus.coins;
    gems += throneBonus.gems;
  }
  user.coins += coins;
  user.gems += gems;
  saveDb();
  return { coins, gems, streak: s.loginStreak, throneBonus };
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 16).replace(/[<>"'`]/g, '');
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

app.post('/api/register', (req, res) => {
  if (!rateLimit(`auth:${req.ip}`, 20, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
  }
  if (inMaintenance()) return res.status(503).json({ error: '🛠 メンテナンス中です。しばらくお待ちください' });
  const username = sanitizeName(req.body.username);
  const password = String(req.body.password || '');
  if (!/^[\w\-ぁ-んァ-ヶ一-龠ー]{2,16}$/u.test(username)) {
    return res.status(400).json({ error: 'ユーザー名は2〜16文字（英数字・日本語）で入力してください' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  }
  const exists = Object.values(db.users).some(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
  // AI住人と同名のアカウントは作れない — チャットの返信/プロフィールで
  // 住人と人間の区別がつかなくなる。
  if (residentByName(username)) return res.status(409).json({ error: 'その名前はアリーナの住人が使っています。別の名前でどうぞ' });

  const user = newUser(username, password);
  const token = issueToken(user.id);
  // New arrivals show up on the live feed (real players are starred).
  battle.crowd.feed({ icon: '👋', real: true, who: user.username,
    text: `${user.username} が新しく参加しました！ようこそ！`, textEn: `${user.username} just joined — welcome!` });
  res.json({ token, user: publicUser(user) });
});

// Live feed snapshot (the menu ticker also receives pushes over the chat socket).
app.get('/api/feed', (_req, res) => {
  res.json({ feed: battle.crowd.feedHistory().slice(-30) });
});

app.post('/api/login', (req, res) => {
  if (!rateLimit(`auth:${req.ip}`, 20, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
  }
  const username = sanitizeName(req.body.username);
  const password = String(req.body.password || '');
  const user = Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.salt, user.passHash)) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  if (user.banned) return res.status(403).json({ error: 'このアカウントは凍結されています' });
  if (inMaintenance() && user.role !== 'admin') {
    return res.status(503).json({ error: '🛠 メンテナンス中です。しばらくお待ちください' });
  }
  const token = issueToken(user.id);
  const dailyBonus = grantDaily(user);
  res.json({ token, user: publicUser(user), dailyBonus });
});

app.post('/api/logout', requireAuth, (req, res) => {
  revokeToken(req.token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user && req.token) {
    // A signed session whose account is not here (yet): the client keeps the
    // token and re-attaches by itself once the data is restored.
    if (req.tokenStatus === 'missing') {
      // settled: the seed auto-restore has ALREADY run and this account still
      // isn't in it — it was created after the last backup and is not coming
      // back. The client stops waiting and offers a fresh start instead of
      // showing 復元待ち forever.
      return res.status(401).json({ error: 'アカウントのデータが見つかりません（データ復元待ち）', code: 'NO_USER', settled: !!db.meta.seedHash, season: currentSeason() });
    }
    // Logged out elsewhere, deleted, expired, or signed with another secret.
    return res.status(401).json({ error: 'セッションが終了しました。もう一度ログインしてください', code: 'SESSION_ENDED', season: currentSeason() });
  }
  finalizeWeeklyRankings();
  const dailyBonus = req.user && !req.user.banned ? grantDaily(req.user) : null;
  res.json({ user: publicUser(req.user), season: currentSeason(), dailyBonus, maintenance: inMaintenance() });
});

// Change own username (once per 24h; admins exempt from the cooldown).
app.post('/api/me/rename', requireAuth, (req, res) => {
  const user = req.user;
  const username = sanitizeName(req.body.username);
  if (!/^[\w\-ぁ-んァ-ヶ一-龠ー]{2,16}$/u.test(username)) {
    return res.status(400).json({ error: 'ユーザー名は2〜16文字（英数字・日本語）で入力してください' });
  }
  if (username.toLowerCase() !== user.username.toLowerCase()) {
    const exists = Object.values(db.users).some(u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase());
    if (exists) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
    if (residentByName(username)) return res.status(409).json({ error: 'その名前はアリーナの住人が使っています。別の名前でどうぞ' });
  }
  const DAY = 24 * 60 * 60 * 1000;
  if (user.role !== 'admin' && user.lastRename && Date.now() - user.lastRename < DAY) {
    const left = Math.ceil((user.lastRename + DAY - Date.now()) / 3600000);
    return res.status(429).json({ error: `名前変更は1日1回までです（あと約${left}時間）` });
  }
  if (username === user.username) return res.status(400).json({ error: '現在と同じ名前です' });
  user.username = username;
  user.lastRename = Date.now();
  saveDb();
  res.json({ user: publicUser(user) });
});

// Delete own account (password confirmation required).
app.delete('/api/me', requireAuth, (req, res) => {
  const user = req.user;
  const password = String((req.body && req.body.password) || '');
  if (!verifyPassword(password, user.salt, user.passHash)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  if (user.role === 'admin') {
    return res.status(400).json({ error: '管理者アカウントは削除できません（先に権限を外してください）' });
  }
  revokeAllTokens(user.id);
  // Must run BEFORE the record disappears: leaveGuild resolves the remaining
  // members to hand ownership over. Skipping it left a ghost id in
  // guild.members forever — the roster counter said 20/20 and nobody could
  // ever join again, and if the ghost was the owner the guild froze solid.
  leaveGuild(db, user);
  delete db.users[user.id];
  db.deleted[user.id] = Date.now();
  saveDb();
  res.json({ ok: true });
});

// Limited-time event (admin-controlled), e.g. chaos mode.
//
// An event that runs out of time used to just stop being returned — no
// announcement, and the record sat in db.meta.event forever so every backup
// carried a stale one. Expiry is now noticed on the first read after the fact
// (there is no timer to lose across a restart).
let battleReady = false;

function currentEvent() {
  const e = db.meta.event;
  if (!e) return null;
  if (e.endsAt > Date.now()) return e;
  if (!e.expiredHandled) {
    e.expiredHandled = true;
    db.meta.event = null;
    saveDb();
    // `battle` is a const initialised near the bottom of this file, so it is in
    // the temporal dead zone during boot — the flag keeps that reference safe.
    if (battleReady) {
      battle.broadcastAll({
        type: 'announce',
        message: `${e.icon || '🌪️'} 期間限定イベント「${e.name}」は終了しました。おつかれさま！`,
        messageEn: `${e.icon || '🌪️'} The limited-time event "${e.nameEn || e.name}" has ended — thanks for playing!`,
        from: '運営',
      });
      battle.crowd.react('event_end');
    }
  }
  return null;
}

// Public lightweight status (menu online counter + event).
// The client sends its bearer token, so the admin-event block below can be
// personalised (your slot, your countdown) without a second round trip.
app.get('/api/status', (req, res) => {
  refreshThrones();   // polled every ~25s by clients — keeps 👑 takeovers timely
  res.json({
    adminEvent: adminEventView(req.user),
    online: battle.displayOnline(),
    activeMatches: battle.displayMatches(),
    queueing: ambientQueue() + battle.queueSize(),
    mood: crowdMood().id,
    maintenance: inMaintenance(),
    // True when SESSION_SECRET is set, i.e. logins survive redeploys.
    sessionsPersist: SESSIONS_PERSIST,
    event: currentEvent(),
    // Menu badge only — the full poll (and the caller's own vote) comes from
    // /api/poll, which needs auth to know who is asking.
    poll: db.meta.poll && pollOpen(db.meta.poll)
      ? { id: db.meta.poll.id, question: db.meta.poll.question, questionEn: db.meta.poll.questionEn || null, endsAt: db.meta.poll.endsAt, voterCount: Object.keys(db.meta.poll.voters).length }
      : null,
  });
});

// Wipe everyone's weekly-challenge record (fresh week on demand).
app.post('/api/admin/weekly/reset', requireAuth, requireAdmin, (req, res) => {
  // Pay out any finished week first — deleting stale records here would
  // otherwise silently destroy the ranking rewards they still owe.
  finalizeWeeklyRankings();
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.stats && u.stats.weekly) { delete u.stats.weekly; affected++; }
  }
  saveDb();
  res.json({ affected });
});

// ---------------------------------------------------------------------------
// Chat mini-profile: tap a name in chat — works for real players AND the AI
// residents (whose stats come from the same generator as the ghost boards, so
// the card matches what the rankings show).
// ---------------------------------------------------------------------------

app.get('/api/profile/:name', (req, res) => {
  if (!rateLimit(`profile:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください' });
  const name = String(req.params.name || '').slice(0, 20);
  const u = Object.values(db.users).find(x => x.username === name && !x.banned);
  if (u) {
    migrateUser(u);
    const s = u.stats;
    const tl = TITLES.find(x => x.id === u.equippedTitle);
    return res.json({ profile: {
      kind: 'player', name: u.username, role: u.role,
      level: levelOf(u.xp), rating: s.rating, bestScore: s.bestScore,
      pvpWins: s.pvpWins, pvpLosses: s.pvpLosses, dungeonMax: s.dungeonMax || 0,
      badges: u.badges, title: tl ? { id: tl.id, name: tl.name, color: tl.color } : null,
      guildTag: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].tag : null,
      thrones: thronesOf(u.id),
    } });
  }
  const r = residentByName(name);
  if (r && r.registered) {
    const st = residentStats(r, Date.now());
    const a = archetype(r.arch);
    return res.json({ profile: {
      kind: 'resident', name: r.name, role: 'user',
      level: st.level, rating: st.rating, bestScore: st.bestScore,
      pvpWins: st.pvpWins, pvpLosses: st.pvpLosses, dungeonMax: st.dungeonMax,
      badges: st.badges, title: st.title,
      guildTag: tagOfName(db, r.name, null),
      archLabel: a.label, archLabelEn: a.labelEn,
      hours: r.hours, favMode: r.favMode,
      online: activeResidents().some(x => x.id === r.id),
      thrones: thronesOfName(r.name),
    } });
  }
  if (r) return res.json({ profile: { kind: 'guest', name: r.name } });
  res.status(404).json({ error: 'プレイヤーが見つかりません' });
});

// ---------------------------------------------------------------------------
// Polls (投票)
// ---------------------------------------------------------------------------

// Close an expired poll and announce the result exactly once.
function syncPoll() {
  const poll = db.meta.poll;
  if (tickPoll(poll)) {
    const w = winnerOf(poll);
    battle.broadcastAll({
      type: 'announce',
      message: w
        ? `🗳️ 投票「${poll.question}」終了！ 1位は「${w.text}」（${w.votes}票）${w.tied ? '…同率でした！' : ''}`
        : `🗳️ 投票「${poll.question}」は投票ゼロで終了しました`,
      messageEn: w
        ? `🗳️ Poll "${poll.questionEn || poll.question}" closed! Winner: "${w.textEn || w.text}" (${w.votes} votes)${w.tied ? ' — a tie!' : ''}`
        : `🗳️ Poll "${poll.questionEn || poll.question}" closed with no votes`,
      from: '大会運営',
    });
    if (w) battle.crowd.react('poll_close', { winner: w });   // renderSlot が言語別に text/textEn を選ぶ
    saveDb();
  }
  return poll;
}

app.get('/api/poll', (req, res) => {
  const poll = syncPoll();
  res.json({ poll: pollView(poll, req.user && req.user.id, !!req.user && req.user.role === 'admin') });
});

app.post('/api/poll/vote', requireAuth, maintenanceGuard, (req, res) => {
  const poll = syncPoll();
  if (!poll) return res.status(404).json({ error: '投票は開催されていません' });
  const out = castVote(poll, req.user.id, String(req.body.optionId || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ poll: pollView(poll, req.user.id), changed: out.changed });
});

// Admin: create / close / delete a poll, or launch the winning event.
app.post('/api/admin/poll', requireAuth, requireAdmin, (req, res) => {
  const action = String(req.body.action || 'create');

  if (action === 'close') {
    if (!db.meta.poll) return res.status(404).json({ error: '投票がありません' });
    db.meta.poll.closed = true;
    const w = winnerOf(db.meta.poll);
    battle.broadcastAll({
      type: 'announce',
      message: w ? `🗳️ 投票終了！ 1位は「${w.text}」（${w.votes}票）` : '🗳️ 投票を締め切りました',
      messageEn: w ? `🗳️ Poll closed! Winner: "${w.textEn || w.text}" (${w.votes} votes)` : '🗳️ The poll has been closed',
      from: req.user.username,
    });
    if (w) battle.crowd.react('poll_close', { winner: w });   // renderSlot が言語別に text/textEn を選ぶ
    saveDb();
    return res.json({ poll: pollView(db.meta.poll, req.user.id, true) });
  }

  if (action === 'delete') {
    db.meta.poll = null;
    saveDb();
    return res.json({ poll: null });
  }

  if (action === 'applyWinner') {
    const poll = db.meta.poll;
    if (!poll) return res.status(404).json({ error: '投票がありません' });
    if (poll.kind !== 'event') return res.status(400).json({ error: 'イベント投票ではありません' });
    const w = winnerOf(poll);
    if (!w || !w.eventType) return res.status(409).json({ error: '有効な勝者がいません（投票ゼロ？）' });
    const minutes = Math.max(1, Math.min(14 * 24 * 60, Math.floor(Number(req.body.minutes) || 1440)));
    db.meta.event = makeEvent(w.eventType, '', minutes, req.user.username);
    poll.applied = true;
    poll.closed = true;
    const ev = db.meta.event;
    battle.broadcastAll({
      type: 'announce',
      message: `🗳️→${ev.icon} 投票で選ばれた「${ev.name}」を開催します！ ${ev.desc}`,
      messageEn: `🗳️→${ev.icon} The vote has spoken — "${ev.nameEn || ev.name}" is now live! ${ev.descEn || ''}`,
      from: req.user.username,
    });
    battle.crowd.feed({ icon: ev.icon, real: true, who: '運営', text: `投票で選ばれたイベント「${ev.name}」が開幕！`, textEn: `The voted event "${ev.nameEn || ev.name}" has begun!` });
    battle.crowd.react('poll_close', { winner: w });   // renderSlot が言語別に text/textEn を選ぶ
    setTimeout(() => battle.crowd.react('event_start'), 25000);
    saveDb();
    return res.json({ event: currentEvent(), poll: pollView(poll, req.user.id, true) });
  }

  // create
  const options = req.body.kind === 'event' && !Array.isArray(req.body.options)
    ? eventPollOptions(Number(req.body.optionCount) || 4)
    : req.body.options;
  const out = createPoll({
    question: req.body.question,
    options,
    minutes: req.body.minutes,
    kind: req.body.kind,
    createdBy: req.user.username,
  });
  if (out.error) return res.status(400).json({ error: out.error });
  db.meta.poll = out.poll;
  // 英語版を自動補完（イベント選択肢はcreatePollがネイティブ英語名を付与済み）。
  const pollRef = out.poll;
  let qReady = null;
  if (!pollRef.questionEn) {
    const qTr = translateChat(pollRef.question).then(tr2 => {
      if (tr2 && tr2.lang === 'en' && db.meta.poll && db.meta.poll.id === pollRef.id) { pollRef.questionEn = tr2.text; saveDb(); }
    }).catch(() => {});
    // アナウンスの英語文に日本語の質問文が残らないよう、翻訳を最大2秒だけ待つ
    qReady = Promise.race([qTr, new Promise(r => setTimeout(r, 2000))]);
  }
  for (const o of pollRef.options) {
    if (o.textEn) continue;
    translateChat(o.text).then(tr2 => {
      if (tr2 && tr2.lang === 'en' && db.meta.poll && db.meta.poll.id === pollRef.id) { o.textEn = tr2.text; saveDb(); }
    }).catch(() => {});
  }
  const announcePoll = () => {
    if (!db.meta.poll || db.meta.poll.id !== pollRef.id) return;   // 待機中に締切/削除されたら黙る
    battle.broadcastAll({
      type: 'announce',
      message: `🗳️ 投票受付中：「${pollRef.question}」 メニューの「🗳️ 投票」から参加しよう！`,
      messageEn: `🗳️ New poll: "${pollRef.questionEn || pollRef.question}" — vote from the 🗳️ Poll menu!`,
      from: req.user.username,
    });
    battle.crowd.react('poll_open');
  };
  if (qReady) qReady.then(announcePoll); else announcePoll();
  saveDb();
  res.json({ poll: pollView(out.poll, req.user.id, true) });
});

// Suggested event options for the admin's poll builder.
app.get('/api/admin/poll/suggest', requireAuth, requireAdmin, (_req, res) => {
  res.json({ options: eventPollOptions(EVENT_TYPES.length), types: EVENT_TYPES });
});

// ---------------------------------------------------------------------------
// Guilds (ギルド)
// ---------------------------------------------------------------------------

const curWeek = () => weekIdOf(currentWeekNum());

app.get('/api/guilds', (req, res) => {
  const week = curWeek();
  const real = Object.values(db.guilds).map(g => guildView(db, g, week));
  const ghosts = getCustom().toggles.guilds ? ghostGuildViews(week).filter(g => !real.some(r => r.name === g.name || r.tag === g.tag)) : [];
  const rows = real.concat(ghosts).sort((a, b) => b.weeklyPoints - a.weeklyPoints).slice(0, 50).map((g, i) => ({ ...g, rank: i + 1 }));
  const mine = req.user && req.user.guildId && db.guilds[req.user.guildId]
    ? guildView(db, db.guilds[req.user.guildId], week, { detailed: true, viewerId: req.user.id, levelOf })
    : null;
  if (mine) mine.rank = rows.findIndex(r => r.id === mine.id) + 1 || null;
  res.json({ week, guilds: rows, mine, createCost: GUILD_CREATE_COST, icons: GUILD_ICONS });
});

app.get('/api/guilds/:id', (req, res) => {
  const g = db.guilds[req.params.id];
  if (g) return res.json({ guild: guildView(db, g, curWeek(), { detailed: true, viewerId: req.user && req.user.id, levelOf }) });
  const ghost = ghostGuildViews(curWeek()).find(x => x.id === req.params.id);
  if (ghost) return res.json({ guild: ghost });
  res.status(404).json({ error: 'ギルドが見つかりません' });
});

app.post('/api/guilds/create', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  if (user.role !== 'admin' && user.coins < GUILD_CREATE_COST) {
    return res.status(402).json({ error: `ギルド設立には🪙${GUILD_CREATE_COST}必要です` });
  }
  const out = createGuild(db, user, req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  if (user.role !== 'admin') user.coins -= GUILD_CREATE_COST;
  user.guildFounded = true;
  saveDb();
  battle.crowd.feed({ icon: out.guild.icon, real: true, who: user.username,
    text: `${user.username} がギルド「${out.guild.name}」を設立！`, textEn: `${user.username} founded the guild "${out.guild.name}"!` });
  res.json({ guild: guildView(db, out.guild, curWeek(), { detailed: true, viewerId: user.id, levelOf }), user: publicUser(user) });
});

app.post('/api/guilds/join', requireAuth, maintenanceGuard, (req, res) => {
  const b = req.body || {};
  const guild = findGuild(db, { id: b.id, code: b.code });
  if (!guild) return res.status(404).json({ error: b.code ? 'そのコードのギルドは見つかりません' : 'ギルドが見つかりません' });
  const out = joinGuild(db, req.user, guild, { viaCode: !!b.code });
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }), user: publicUser(req.user) });
});

app.post('/api/guilds/leave', requireAuth, (req, res) => {
  const out = leaveGuild(db, req.user);
  saveDb();
  res.json({ ok: true, disbanded: !!out.disbanded, user: publicUser(req.user) });
});

app.post('/api/guild/kick', requireAuth, (req, res) => {
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  const out = kickMember(db, guild, req.user, String(req.body.userId || ''));
  if (out.error) return res.status(403).json({ error: out.error });
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }) });
});

app.post('/api/guild/settings', requireAuth, (req, res) => {
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  if (guild.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'ギルドリーダーのみ変更できます' });
  const v = validateGuildInput(req.body || {}, { partial: true });
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.name && Object.values(db.guilds).some(g => g.id !== guild.id && g.name.toLowerCase() === v.name.toLowerCase())) {
    return res.status(409).json({ error: 'そのギルド名は使われています' });
  }
  if (v.tag && Object.values(db.guilds).some(g => g.id !== guild.id && g.tag === v.tag)) {
    return res.status(409).json({ error: 'そのタグは使われています' });
  }
  Object.assign(guild, v);
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }) });
});

app.delete('/api/admin/guilds/:id', requireAuth, requireAdmin, (req, res) => {
  const g = db.guilds[req.params.id];
  if (!g) return res.status(404).json({ error: 'ギルドが見つかりません' });
  for (const id of g.members) { const u = db.users[id]; if (u) u.guildId = null; }
  delete db.guilds[g.id];
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// News (お知らせ)
// ---------------------------------------------------------------------------

// Fixed ids: a re-seeded post is THE SAME post, so backup merges dedupe it
// instead of multiplying the launch announcements on every restore. Every seed
// post is fully bilingual; boot also BACKFILLS titleEn/bodyEn onto copies that
// were stored before the fields existed (so production news heals itself).
const SEED_NEWS = [
  { id: 'seed-1', pinned: true,
    title: '🎉 v2.0 超進化アップデート！', titleEn: '🎉 The v2.0 Mega Evolution Update!',
    body: '⚡アルティメットスキル（9種・ショップの「奥義」タブ）／📋デイリー・ウィークリーミッション／🏅実績58種／📊戦績ダッシュボード／⏱️タイムアタック／🤝協力プレイ（2人で1盤面）を追加しました。ラインを消して⚡ゲージを溜め、必殺技を撃とう！',
    bodyEn: 'Added: ⚡ Ultimate Skills (9 kinds — see the Ultimates tab in the shop), 📋 daily & weekly missions, 🏅 58 achievements, 📊 a stats dashboard, ⏱️ Time Attack, and 🤝 co-op (two players, one board). Clear lines to charge the ⚡ gauge and unleash your ultimate!' },
  { id: 'seed-2',
    title: '🎪 イベント＆🗳️投票スタート', titleEn: '🎪 Events & 🗳️ Polls are here',
    body: '期間限定イベントが8種類に！コイン祭り・経験値ブースト・ジェムラッシュ・ボス襲来・奥義祭・ラッキーデー…開催中はメニューにバナーが出ます。投票機能では次のイベントをみんなで決められます（投票するまで結果は秘密）。',
    bodyEn: 'Eight kinds of limited-time events: Coin Festival, XP Boost, Gem Rush, Boss Invasion, Ultimate Festival, Lucky Day and more — a banner appears on the menu while one is live. With polls, everyone decides the next event together (results stay hidden until you vote).' },
  { id: 'seed-3',
    title: '🏰 ギルド機能・🌑 深淵ダンジョン・📰 ニュース', titleEn: '🏰 Guilds, 🌑 the Abyss Dungeon & 📰 News',
    body: 'ギルドを作って週間ポイントを競おう（ギルドレベルでコインボーナス）。塔を制覇した猛者には過去最難関「深淵」が待っています。このニュース欄には運営からのお知らせが届きます。',
    bodyEn: 'Found a guild and race for weekly points (guild levels grant coin bonuses). For those who conquered the Tower, the hardest challenge yet — the Abyss — awaits. This news feed is where announcements from the team arrive.' },
  { id: 'seed-4',
    title: '🎭 にぎわい2.0 ＆ チャット自動翻訳', titleEn: '🎭 Crowd 2.0 & chat auto-translation',
    body: 'ロビーの住人たちが性格を持ちました。イベントや投票に反応し、対戦した相手はあとでチャットで話しかけてくることも。チャットは日本語⇄英語を自動翻訳します（設定でOFFにできます）。',
    bodyEn: 'The lobby residents now have personalities. They react to events and polls, and someone you just fought might message you afterwards. Chat auto-translates between Japanese and English (you can turn it off in Settings).' },
  { id: 'seed-v26', pinned: true,
    title: '🛡️ v2.6 不滅アップデート！', titleEn: '🛡️ The v2.6 Immortal Update!',
    body: 'アップデートでデータが消える時代は終わりです。シーズン・バトルパス・実績の受け取り状況・イベント・投票がすべて更新後も引き継がれるようになりました。さらに🏅実績が全100種に大増量、新モード「🧩パズル遺跡」（ステージ制パズル・星3評価）と「⛏️採掘場」（せり上がる地層を掘って鉱石を集めろ）が登場！チャットの住人たちも会話エンジン3.0に進化して、同じセリフの繰り返しがほぼなくなりました。',
    bodyEn: 'The era of updates wiping your data is over: seasons, battle pass, claimed achievements, events and polls all carry over now. Achievements grew to 100, and two new modes arrived — 🧩 Puzzle Ruins (stage-based puzzles with 3-star ratings) and ⛏️ The Mines (dig through rising strata for ore)! The chat residents also evolved to conversation engine 3.0 — repeated lines are nearly gone.' },
  { id: 'seed-throne', pinned: true,
    title: '👑 王座システム登場！', titleEn: '👑 The Throne System is here!',
    body: '各ランキング（スコア・レート・タイムアタック・ダンジョン・ウィークリー・パズル遺跡・採掘場）の現在1位は「王座」を保持します。王者はランキング・チャット・プロフィールに👑が輝き、王座1つにつき毎日のログインボーナスに+150🪙+2💎の俸給が上乗せ！王座が奪われるとライブフィードで全プレイヤーに速報が流れます。頂点を獲れ！',
    bodyEn: 'The current #1 of every leaderboard (Score, Rating, Time Attack, Dungeon, Weekly, Puzzle Ruins, The Mines) holds a Throne. Champions get a shining 👑 on rankings, in chat and on their profile — plus a daily stipend of +150🪙 +2💎 per throne! When a throne changes hands, the live feed announces it to everyone. Take the top!' },
  { id: 'seed-ghost',
    title: '👻 奇妙な報告が届いています', titleEn: '👻 Strange reports are coming in',
    body: '複数のプレイヤーから「メニューで何かに見られている気がする」という報告が届いています。運営で調査したところ、ロゴの周辺で不可解な現象を確認しました。じっと見つめていると、不吉な数字が頭に浮かぶそうです。……くれぐれも、その回数だけ触れたりしないように。実績欄に見慣れない👻が現れた方は、運営までご一報ください。',
    bodyEn: 'Several players report feeling watched on the menu screen. Our investigation confirmed something inexplicable near the logo. Those who stare at it say an unlucky number comes to mind… Whatever you do, please do not touch it that many times. If an unfamiliar 👻 has appeared in your achievements, contact the team immediately.' },
  { id: 'seed-v272', pinned: true,
    title: '🎰 ガチャ2.0 ＆ 👑多冠報酬アップデート！', titleEn: '🎰 Gacha 2.0 & 👑 Multi-Crown Rewards!',
    body: '【🎰ガチャ2.0】✨天井システム登場 — 40連以内にSSR以上が必ず出ます！10連はSR以上1枠確定。さらに🌈ガチャ限定装備3種（プリズム／オーロラ／彗星）が追加 — SSRからのみ入手できます。【👑多冠報酬】王座を2つ以上同時に持つと永久バッジ＋俸給ボーナス（二冠+200🪙3💎〜全冠+1,600🪙24💎）、名前の色も冠の数で豪華に（3冠以上は虹色！）。王者の住人はチャットに常駐するようになりました。【🐛バグ報告】設定→「バグ報告」から不具合を直接送れます！',
    bodyEn: '[🎰 Gacha 2.0] The ✨pity system is here — an SSR or better is guaranteed within 40 pulls, and every 10-pull guarantees at least one SR+. Three 🌈 gacha-exclusive items were added (Prism / Aurora / Comet) — SSR pulls only. [👑 Multi-Crown] Hold 2+ thrones at once for permanent badges and bigger stipends (up to +1,600🪙 24💎 for all seven) — and your name color gets fancier with each crown (3+ crowns = rainbow!). Champion residents now hang out in chat. [🐛 Bug Reports] Report issues directly from Settings → Report a bug!' },
  { id: 'seed-throne2', pinned: true,
    title: '👑 王座戦線にAIプレイヤーが参戦！', titleEn: '👑 AI players join the throne race!',
    body: 'ロビーの住人たち（AIプレイヤー）も王座を持つようになりました。いま各ランキングの👑は住人が守っています — 彼らの実力は日々変化するので、王座も自然に動きます。スコアで追い抜けばその瞬間あなたが王者。AIから王座を奪還して、俸給と栄光を手にしましょう！（住人はログインボーナスを受け取れないので、俸給はいつでも人間のもの）',
    bodyEn: 'The lobby residents (AI players) can now hold thrones too. Right now the 👑 on each leaderboard is defended by a resident — their skills drift daily, so thrones naturally change hands. Beat their score and the crown is yours that instant. Reclaim the thrones from the AI for stipends and glory! (Residents can’t collect login bonuses, so the stipend always belongs to humans.)' },
  { id: 'seed-v210', pinned: true,
    title: '💥 オンライン対戦 超絶大型アップデート ＆ 🌐完全翻訳！', titleEn: '💥 Online Battle MEGA Update & 🌐 Full Translation!',
    body: '【💥アタック戦】新モード登場！2ライン以上を同時消しすると相手の盤面にお邪魔ブロックを送り込めます（3ライン=4個、4ライン+コンボで最大9個）。攻撃も防御も自分の腕次第 — オンラインメニューの「💥アタック戦」から！【🔁再戦】デュエル/アタック戦の結果画面に再戦ボタンが付きました。30秒以内なら同じ相手にリベンジできます。【📈昇格演出】レートが新しい帯（🥈シルバー〜👑グランドマスター）に到達すると紙吹雪でお祝い＋ゴールド以上は全体アナウンス！【🌐翻訳大型アップデート】ニュース・投票・イベント・チャットの住人の会話まで、英語表示が全面ネイティブ品質になりました。',
    bodyEn: '[💥 Attack Duel] New mode! Clear 2+ lines at once to send garbage blocks onto your opponent\'s board (3 lines = 4 cells, up to 9 with combos). Attack and defend with pure skill — find it under "💥 Attack Duel" in the online menu! [🔁 Rematch] Duel and Attack results now have a rematch button — get your revenge against the same opponent within 30 seconds. [📈 Promotions] Reaching a new rank tier (🥈 Silver through 👑 Grandmaster) triggers a confetti celebration, and Gold+ promotions are announced to everyone! [🌐 Translation Overhaul] News, polls, events and even the residents\' chat are now native-quality in English.' },
  { id: 'seed-v211', pinned: true,
    title: '👑 v2.11 管理者イベント開幕 ＆ 💯バトルロイヤル大改造！',
    titleEn: '👑 v2.11 — Admin Events & the Battle Royale Overhaul!',
    body: '【👑 管理者イベント（週1・予約制）】運営が主催する特別イベントがはじまります。ポイントは「開催時間を “あなたが” 選べる」こと — 18:00 / 19:00 / 21:00 のように複数の枠が用意され、メニューのバナーから好きな枠を予約すると、その時間にあなた専用の回が開幕します。予約が違ってもボスHP・共同ゲージ・ランキングは全員で共有。18時に遊んだ人と21時に遊んだ人が、同じ1体のボスを一緒に削ります。10分前と1分前にお知らせが出るので、うっかり寝過ごしても大丈夫。\n' +
      '【🎮 この枠でしか遊べない専用モード3種（週替わり）】👑管理者襲来＝管理者の分身が「お邪魔の雨」「盤面回転」「手札シャッフル」「目隠し」などをリアルタイムで撃ち込んでくる総力戦。全員の合計ダメージで巨大HPを削り切れ！／🎰運営ルーレット＝30秒ごとにルーレットが回り、スコア5倍・極小ブロックのみ・盤面回転・せり上がり・ラッキーセブンなど9種のルールに書き換わるカオス番組。／🏛️共同作業＝参加者全員のスコアが1本のゲージに合流し、段階目標を越えるたび全員に報酬。盤面に湧く🧱建材を回収すると大きく加速します。\n' +
      '【🎁 お宝ラッシュ】自分の枠の中は報酬が最大3倍。討伐に成功すると参加者全員に👑バッジ。\n' +
      '【💯 バトルロイヤル 大改造】99人のAIが「スコアが自動で増えるだけの数字」から、本当に盤面を持って打つプレイヤーになりました。弱いAIは実際に詰んで脱落します。さらに ①2ライン以上消すと生存者の誰かにお邪魔を送り込む殴り合い ②時間経過で全員に降りそそぐ🌩️ストーム ③「あと◯点で生き残れる」を数字で出す危険メーター ④脱落しても終わりじゃない観戦モード ⑤残り3人の盤面が並ぶファイナル ⑥順位別の報酬ラダー（1位🪙1,200💎40 〜 参加賞まで）⑦KO数・最高順位の記録と新実績7種・新称号2種。1回のトップアウトは「復活」、2回目で脱落です。\n' +
      '【🐲 レイド/2v2 の画面改善】仲間3人ぶんのミニ盤面が縦に積み上がって自分の盤面を圧迫していた問題を解消。仲間は1行のコンパクト表示になり、ボスHPも細いバーになりました。iPhone SE クラスの画面では自分の盤面が 210px → 347px（ソロと同じ大きさ）に。横画面では盤面が消えてしまう不具合も修正。仲間の盤面を見たい人は ▾ ボタンで元に戻せます。\n' +
      '【🌐 マッチング見直し】①レートの近い人から優先してマッチ（待つほど条件がゆるくなります）②AI相手の強さがあなたのレートに合わせて選ばれるように（今までは完全ランダムでした）③2v2で2人一緒に来たら必ず同じチーム ④待機画面に「経過時間・同じモードで待っている実人数・レート検索範囲・AIが参戦するまでの秒数」を正直に表示。\n' +
      '【🐛 バグ修正】通信エラーでサーバー全体が落ちうる不具合／対戦の結果待ち中に接続が切れると画面が固まって操作不能になる不具合／ゲーム終了後もピースを置けてしまう不具合／ドラッグ中に手札が変わると別のピースが置かれる不具合／アカウント削除でギルドが満員のまま壊れる不具合／協力プレイのスコアを改ざんできる不具合／アイテムが10個あると左端の4個が画面外で押せない不具合／オンライン対戦でピース数が記録されずミッションが進まない不具合 — ほか多数。',
    bodyEn: '[👑 Admin Events — weekly, and YOU pick the time] A special event hosted by the staff. The point of it is that you choose when to attend: several slots are offered (say 18:00 / 19:00 / 21:00 JST) and you reserve the one that suits you from the menu banner — your own session opens at that time. Different slots, one shared world: the boss HP, the community gauge and the leaderboard are common to everybody, so the 18:00 crowd and the 21:00 crowd chip away at the same boss together. You get a reminder 10 minutes and 1 minute before your slot.\n' +
      '[🎮 Three exclusive modes, rotating weekly] 👑 Admin Invasion — the admin\'s avatar meddles with your board in real time (garbage rain, board spin, hand shuffle, blindfold) while everyone\'s damage goes onto one enormous HP bar. 🎰 Operator Roulette — every 30 seconds the wheel is spun and the rules are rewritten: 5× score, tiny blocks only, a spinning board, a rising floor, Lucky 7 and more. 🏛️ The Great Work — every participant\'s score flows into a single gauge, and each tier cleared pays out to everyone; collect the 🧱 materials that appear on your board to speed it up.\n' +
      '[🎁 Treasure Rush] Rewards are multiplied (up to 3×) inside your slot, and defeating the objective earns a 👑 badge for everyone who took part.\n' +
      '[💯 Battle Royale rebuilt] The 99 AI entrants were score curves that could not be beaten fairly; they now run real boards with the real AI, and weak ones genuinely top out and die. Added: garbage warfare (clear 2+ lines to bury a survivor), a 🌩️ storm that rains garbage on everyone as the clock runs down, a danger meter that tells you exactly how many points you are from safety, spectating after you are knocked out, a finale showing the last three boards, a placement reward ladder (🪙1,200 💎40 for #1 down to a consolation prize), plus knockout/best-placement stats, 7 new achievements and 2 new titles. Your first top-out revives you; the second eliminates you.\n' +
      '[🐲 Raid / 2v2 screen] Three allies\' mini boards used to stack above your own and squeeze it flat. Allies are now a single compact row and the boss HP is a slim bar — on an iPhone SE-sized screen your board goes from 210px to 347px, the same size as in solo. The landscape bug that made the board vanish entirely is fixed. Tap ▾ to bring the ally boards back.\n' +
      '[🌐 Matchmaking] Players are now paired by rating (the search widens the longer you wait), the AI opponent\'s strength is chosen to match your rating instead of at random, two players who queue together for 2v2 always land on the same team, and the search screen honestly shows your elapsed time, how many real people are waiting in that mode, the rating range being searched, and exactly when an AI player will step in.\n' +
      '[🐛 Fixes] A socket error could take the whole server down; a dropped connection while waiting for results left an undismissable modal covering the app; pieces could still be placed after a run had ended; a hand change mid-drag placed a different piece than the one you were holding; deleting an account left a guild permanently stuck at "full"; co-op scores could be forged by a client; with 10 items the leftmost four sat off-screen and were unreachable; online modes recorded 0 pieces placed so those missions never advanced — and more.' },
];

function seedNews() {
  // ループ内で push すると2件目以降の判定が狂うので「元から空だったか」を先に確定
  const hadNews = db.news.length > 0;
  for (const p of SEED_NEWS) {
    const existing = db.news.find(n => n && (n.id === p.id || n.title === p.title));
    if (existing) {
      // 既存の日本語のみの投稿に英語を後から補完（本番が自己修復する）
      if (!existing.titleEn) existing.titleEn = p.titleEn;
      if (!existing.bodyEn) existing.bodyEn = p.bodyEn;
      continue;
    }
    // seed-1..4 は初期ロビー用 — ニュースが既に流れているサーバーには足さない
    if (['seed-1', 'seed-2', 'seed-3', 'seed-4'].includes(p.id) && hadNews) continue;
    db.news.push({
      id: p.id, title: p.title, titleEn: p.titleEn, body: p.body, bodyEn: p.bodyEn,
      pinned: !!p.pinned, by: 'るみまき', at: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// 🐛 バグ報告 — ゲストでも送れる。管理者パネルで確認・処理。
// ---------------------------------------------------------------------------

app.post('/api/bugreport', (req, res) => {
  if (!rateLimit(`bug:${req.ip}`, 3, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '報告が多すぎます。少し待ってください' });
  }
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (text.length < 5) return res.status(400).json({ error: 'もう少し詳しく書いてください' });
  db.bugreports = db.bugreports || [];
  db.bugreports.push({
    id: crypto.randomUUID(),
    text,
    by: req.user ? req.user.username : 'ゲスト',
    role: req.user ? req.user.role : 'guest',
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    at: Date.now(),
    status: 'open',
  });
  // Cap eviction: processed reports go first — a spammer must not be able to
  // push the operator's PENDING reports out of the box.
  if (db.bugreports.length > 300) {
    const doneIdx = db.bugreports.findIndex(b => b && b.status === 'done');
    if (doneIdx !== -1) db.bugreports.splice(doneIdx, 1);
    else db.bugreports.shift();
  }
  saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/bugreports', requireAuth, requireAdmin, (_req, res) => {
  res.json({ reports: (db.bugreports || []).slice().reverse() });
});

app.post('/api/admin/bugreports/:id', requireAuth, requireAdmin, (req, res) => {
  const b = (db.bugreports || []).find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '報告が見つかりません' });
  b.status = req.body.status === 'open' ? 'open' : 'done';
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/bugreports/:id', requireAuth, requireAdmin, (req, res) => {
  db.bugreports = (db.bugreports || []).filter(x => x.id !== req.params.id);
  saveDb();
  res.json({ ok: true });
});

function newsView() {
  return db.news
    .slice()
    .sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at))
    .slice(0, 40)
    .map(n => ({ id: n.id, title: n.title, titleEn: n.titleEn || null, body: n.body, bodyEn: n.bodyEn || null, pinned: !!n.pinned, at: n.at, by: n.by }));
}

app.get('/api/news', (_req, res) => {
  const list = newsView();
  res.json({ news: list, latestAt: list.reduce((a, n) => Math.max(a, n.at), 0) });
});

app.post('/api/admin/news', requireAuth, requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().replace(/[<>]/g, '').slice(0, 60);
  const body = String(req.body.body || '').trim().replace(/[<>]/g, '').slice(0, 2000);
  if (!title || !body) return res.status(400).json({ error: 'タイトルと本文を入力してください' });
  const n = { id: crypto.randomUUID(), title, body, pinned: !!req.body.pinned, by: req.user.username, at: Date.now() };
  db.news.push(n);
  // 英語版を自動翻訳で補完（外部エンジン設定時は高品質、なければ辞書）。
  translateChat(title).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.titleEn = tr2.text; saveDb(); } }).catch(() => {});
  translateChat(body).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.bodyEn = tr2.text; saveDb(); } }).catch(() => {});
  if (db.news.length > 200) db.news.shift();
  saveDb();
  if (req.body.announce !== false) {
    battle.broadcastAll({ type: 'announce', message: `📰 お知らせ「${title}」を公開しました。メニューの「ニュース」から読めます`, messageEn: `📰 News posted: "${title}" — read it from the News menu`, from: req.user.username });
    battle.crowd.feed({ icon: '📰', real: true, who: '運営', text: `お知らせ「${title}」が公開された`, textEn: `News posted: "${title}"` });
  }
  battle.broadcastAll({ type: 'news', latestAt: n.at });
  res.json({ news: newsView() });
});

app.post('/api/admin/news/:id', requireAuth, requireAdmin, (req, res) => {
  const n = db.news.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'お知らせが見つかりません' });
  if (typeof req.body.title === 'string') {
    const v = req.body.title.trim().replace(/[<>]/g, '').slice(0, 60);
    if (v && v !== n.title) {
      n.title = v;
      // 本文が変わったら英語版も作り直す（古い自動翻訳が残り続けないように）
      n.titleEn = null;
      translateChat(v).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.titleEn = tr2.text; saveDb(); } }).catch(() => {});
    }
  }
  if (typeof req.body.body === 'string') {
    const v = req.body.body.trim().replace(/[<>]/g, '').slice(0, 2000);
    if (v && v !== n.body) {
      n.body = v;
      n.bodyEn = null;
      translateChat(v).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.bodyEn = tr2.text; saveDb(); } }).catch(() => {});
    }
  }
  if (typeof req.body.pinned === 'boolean') n.pinned = req.body.pinned;
  saveDb();
  res.json({ news: newsView() });
});

app.delete('/api/admin/news/:id', requireAuth, requireAdmin, (req, res) => {
  const i = db.news.findIndex(x => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'お知らせが見つかりません' });
  db.news.splice(i, 1);
  saveDb();
  res.json({ news: newsView() });
});

// Catalogue of event types (admin picker).
app.get('/api/admin/event/types', requireAuth, requireAdmin, (_req, res) => {
  res.json({ types: EVENT_TYPES, event: currentEvent() });
});

// Start / extend / stop a limited-time event.
app.post('/api/admin/event', requireAuth, requireAdmin, (req, res) => {
  const clampMinutes = v => Math.max(1, Math.min(24 * 14 * 60, Math.floor(v)));

  // Extend the running event without restarting it.
  if (req.body.extend) {
    const ev = currentEvent();
    if (!ev) return res.status(409).json({ error: '開催中のイベントがありません' });
    ev.endsAt += clampMinutes(Number(req.body.extend) || 60) * 60 * 1000;
    saveDb();
    return res.json({ event: currentEvent() });
  }

  if (req.body.on) {
    // Duration in minutes (1 min .. 14 days). Legacy clients may still send hours.
    const rawMinutes = Number(req.body.minutes);
    const legacyHours = Number(req.body.hours);
    const minutes = clampMinutes(
      Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes
        : Number.isFinite(legacyHours) && legacyHours > 0 ? legacyHours * 60
        : 24 * 60);
    // Legacy clients send no type at all — they always meant chaos.
    db.meta.event = makeEvent(String(req.body.type || 'chaos'), sanitizeName(req.body.name), minutes, req.user.username);
    const ev = db.meta.event;
    battle.broadcastAll({
      type: 'announce',
      message: `${ev.icon} 期間限定イベント「${ev.name}」開催！ ${ev.desc}`,
      messageEn: `${ev.icon} Limited-time event "${ev.nameEn || ev.name}" is live! ${ev.descEn || ''}`,
      from: req.user.username,
    });
    battle.crowd.feed({ icon: ev.icon, real: true, who: '運営', text: `イベント「${ev.name}」が始まった！ ${ev.desc}`, textEn: `Event "${ev.nameEn || ev.name}" is live! ${ev.descEn || ev.desc}` });
    battle.crowd.react('event_start');
  } else {
    const was = db.meta.event;
    db.meta.event = null;
    battle.broadcastAll({
      type: 'announce',
      message: `${was ? was.icon : '🌪️'} 期間限定イベントは終了しました。また次回！`,
      messageEn: `${was ? was.icon : '🌪️'} The limited-time event has ended — see you next time!`,
      from: req.user.username,
    });
    battle.crowd.react('event_end');
  }
  saveDb();
  res.json({ event: currentEvent() });
});

// ---------------------------------------------------------------------------
// Weekly challenge: one shared seed per week (Monday 00:00 UTC reset).
// Everyone gets the identical piece sequence — pure score attack.
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_PIECES = 40;

function currentWeekNum() {
  // Unix epoch was a Thursday; shift by 4 days so weeks flip on Monday UTC.
  return Math.floor((Date.now() - 4 * 24 * 60 * 60 * 1000) / WEEK_MS);
}
function weekIdOf(n) { return `W${n}`; }
function weeklySeed(weekId) {
  let h = 0;
  const s = `bba-weekly-${weekId}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0) & 0x7fffffff;
}

app.get('/api/weekly', (req, res) => {
  finalizeWeeklyRankings();
  const n = currentWeekNum();
  const week = weekIdOf(n);
  const w = req.user && req.user.stats.weekly;
  res.json({
    week,
    seed: weeklySeed(week),
    pieces: WEEKLY_PIECES,
    endsAt: (n + 1) * WEEK_MS + 4 * 24 * 60 * 60 * 1000,
    best: w && w.week === week ? w.best : 0,
  });
});

// ---------------------------------------------------------------------------
// Weekly ranking rewards (ランキング報酬)
//
// When the week rolls over, everyone who set a weekly-challenge score gets
// coins/gems by final rank — real players only, so the AI residents on the
// board never take a prize from a person. #1 also earns the 週間チャンピオン
// badge (and its title). Granted lazily from boot + the hot endpoints,
// because the free-tier server may well be asleep at Monday 00:00 UTC.
// ---------------------------------------------------------------------------

const WEEKLY_RANK_REWARDS = [
  { upTo: 1,        coins: 2000, gems: 300, badge: 'weekly1' },
  { upTo: 2,        coins: 1200, gems: 180 },
  { upTo: 3,        coins: 800,  gems: 120 },
  { upTo: 10,       coins: 500,  gems: 60 },
  { upTo: 30,       coins: 300,  gems: 30 },
  { upTo: Infinity, coins: 150,  gems: 10 },
];
function rankRewardFor(rank) {
  return WEEKLY_RANK_REWARDS.find(t => rank <= t.upTo) || WEEKLY_RANK_REWARDS[WEEKLY_RANK_REWARDS.length - 1];
}
// JSON-safe copy for the client (Infinity does not survive res.json).
const rankRewardsTable = () => WEEKLY_RANK_REWARDS.map(t => ({
  upTo: Number.isFinite(t.upTo) ? t.upTo : null, coins: t.coins, gems: t.gems, badge: t.badge || null,
}));

function finalizeWeeklyRankings() {
  const curW = weekIdOf(currentWeekNum());
  if (db.meta.lastRankRewardWeek === curW) return;
  // A fresh post-deploy DB has nobody to rank — don't burn the weekly stamp,
  // or the players about to be auto-restored would wait a full week for the
  // payout of their already-finished week.
  if (!Object.values(db.users).some(u => u.role !== 'admin' && !u.banned)) return;
  db.meta.lastRankRewardWeek = curW;
  // Stale weekly records (any past week — the server may have slept through
  // several) are grouped per week, ranked, and marked so a record is never
  // paid twice even across backup/restore cycles.
  const byWeek = new Map();
  for (const u of Object.values(db.users)) {
    const w = u.stats && u.stats.weekly;
    if (!w || w.week === curW || w.rewarded || !(w.best > 0)) continue;
    w.rewarded = true;
    if (u.banned || u.role === 'admin') continue;
    if (!byWeek.has(w.week)) byWeek.set(w.week, []);
    byWeek.get(w.week).push(u);
  }
  for (const [week, players] of byWeek) {
    players.sort((a, b) => b.stats.weekly.best - a.stats.weekly.best);
    players.forEach((u, i) => {
      migrateUser(u);
      const rank = i + 1;
      if (rank === 1) u.stats.weeklyWins = (u.stats.weeklyWins || 0) + 1;
      const t = rankRewardFor(rank);
      u.rankRewards.push({
        id: crypto.randomUUID(), board: 'weekly', week, rank, of: players.length,
        best: u.stats.weekly.best, coins: t.coins, gems: t.gems, badge: t.badge || null, at: Date.now(),
      });
    });
    const medals = ['🥇', '🥈', '🥉'];
    const top = players.slice(0, 3).map((u, i) => `${medals[i]} ${u.username}（${fmtNum(u.stats.weekly.best)}点）`);
    db.news.push({
      id: crypto.randomUUID(),
      title: `🏆 週間チャレンジ結果発表（${week}）`,
      titleEn: `🏆 Weekly Challenge results (${week})`,
      body: `先週の週間チャレンジの結果です（参加${players.length}人）！\n${top.join('\n')}\n\n参加者全員に順位に応じたコイン＆ジェムをお届けしました。ゲームを開くと受け取れます。今週のチャレンジも開催中！`,
      bodyEn: `Last week's Weekly Challenge results (${players.length} entrants)!\n${top.join('\n')}\n\nEveryone received coins & gems for their placement — open the game to claim. This week's challenge is already live!`,
      pinned: false, by: '運営', at: Date.now(),
    });
    if (db.news.length > 200) db.news.shift();
    battle.crowd.feed({
      icon: '🏆', real: true, who: '運営',
      text: `週間チャレンジ結果発表！1位は ${players[0].username}`,
      textEn: `Weekly challenge results are in — #1 is ${players[0].username}!`,
    });
    battle.crowd.react('champion', { you: players[0].username });
  }
  saveDb();
}

// ---------------------------------------------------------------------------
// 👑 王座 (Thrones) — the CURRENT #1 real player of each leaderboard.
// Derived from stats on demand (memoized); db.meta.thrones only snapshots the
// holders so takeovers can be detected and announced. Holding a throne shows a
// crown on the leaderboard / in chat / on the profile, and pays a stipend on
// top of the daily login bonus. Admins, banned players and ghost residents
// can never hold one — this is for real players.
// ---------------------------------------------------------------------------

const THRONE_BOARDS = {
  score:   { name: 'スコア',         nameEn: 'Score',       value: u => u.stats.bestScore || 0 },
  rating:  { name: 'レート',         nameEn: 'Rating',      value: u => u.stats.rating || 0, min: 1001 },
  sprint:  { name: 'タイムアタック', nameEn: 'Time Attack', value: u => (u.stats.sprint && u.stats.sprint.s60) || 0 },
  dungeon: { name: 'ダンジョン',     nameEn: 'Dungeon',     value: u => u.stats.dungeonMax || 0 },
  weekly:  { name: 'ウィークリー',   nameEn: 'Weekly',      value: u => (u.stats.weekly && u.stats.weekly.week === weekIdOf(currentWeekNum()) ? u.stats.weekly.best : 0) },
  puzzle:  { name: 'パズル遺跡',     nameEn: 'Puzzle Ruins', value: u => u.stats.puzzleStage || 0 },
  dig:     { name: '採掘場',         nameEn: 'The Mines',   value: u => u.stats.digDepth || 0 },
};
const THRONE_DAILY_COINS = 150;
const THRONE_DAILY_GEMS = 2;

let thronesMemo = { at: 0, map: null };

function computeThrones() {
  const now = Date.now();
  if (thronesMemo.map && now - thronesMemo.at < 5000) return thronesMemo.map;
  const week = weekIdOf(currentWeekNum());
  const realCands = [];
  for (const u of Object.values(db.users)) {
    if (u.banned || u.role === 'admin' || !u.stats || !(u.stats.gamesPlayed > 0)) continue;
    realCands.push({ id: u.id, username: u.username, createdAt: u.createdAt || 0, resident: false, user: u });
  }
  // 👑 住人（AIプレイヤー）も王座戦線に参戦 — 王座が空位のまま眠らないように。
  // 候補は「そのボードに実際に表示される住人サブセット」(boardResidents) 限定、
  // 値はゴースト行と同じ式 — 王冠が見えない行に付くことは構造的にない。
  // にぎわいOFF（scale 0 / ghostsトグルOFF）のときは従来どおり実プレイヤーのみ。
  const stCache = new Map();
  const residentValue = (r, board) => {
    let st = stCache.get(r.id);
    if (!st) { st = residentStats(r, now, week); stCache.set(r.id, st); }
    switch (board) {
      case 'score': return st.bestScore;
      case 'rating': return st.rating;
      case 'sprint': return st.sprintBest;
      case 'dungeon': return st.dungeonMax;
      case 'weekly': return st.weeklyBest;
      case 'puzzle': return Math.max(1, Math.round((st.dungeonMax || 8) * 0.55));
      case 'dig': return Math.max(3, Math.round((st.dungeonMax || 8) * 0.75));
      default: return 0;
    }
  };
  // Equal values: a real player beats a resident; among equals the older
  // account keeps the crown (the incumbent defends).
  const beats = (a, aV, b, bV) => aV > bV
    || (aV === bV && b && (b.resident && !a.resident || (b.resident === a.resident && a.createdAt < b.createdAt)));
  const map = {};
  for (const [board, def] of Object.entries(THRONE_BOARDS)) {
    const cands = realCands.slice();
    for (const r of boardResidents(board, week)) {
      cands.push({ id: `res:${r.id}`, username: r.name, createdAt: 0, resident: true, r });
    }
    let best = null, bestV = 0;
    for (const c of cands) {
      const v = Number(c.resident ? residentValue(c.r, board) : def.value(c.user)) || 0;
      if (v < (def.min || 1)) continue;
      if (!best || beats(c, v, best, bestV)) { best = c; bestV = v; }
    }
    if (best) map[board] = { userId: best.id, username: best.username, value: bestV, resident: best.resident };
  }
  thronesMemo = { at: now, map };
  return map;
}

// Diff against the stored holders and announce takeovers. The very first
// computation (fresh DB / just restored) seeds silently — no boot spam.
// force=true bypasses the memo — callers that just CHANGED stats use it, or a
// freshly-cached pre-change map would hide the takeover for a few seconds.
function refreshThrones(force = false) {
  if (force) thronesMemo.at = 0;
  const cur = computeThrones();
  const prev = db.meta.thrones;
  const next = {};
  let moved = false;
  for (const [board, t] of Object.entries(cur)) {
    const old = prev && prev[board];
    next[board] = { userId: t.userId, username: t.username, value: t.value, resident: !!t.resident, at: old && old.userId === t.userId ? old.at : Date.now() };
    if (!old || old.userId !== t.userId) moved = true;
    // Same holder under a NEW name (rename): persist the fresh snapshot so the
    // username-keyed displays (leaderboard crowns, chat presence) follow along
    // — but don't announce a takeover that didn't happen.
    else if (old.username !== t.username || old.value !== t.value) moved = true;
  }
  if (prev && Object.keys(prev).some(b => !next[b])) moved = true;
  if (!prev) { db.meta.thrones = next; saveDb(); return; }
  if (!moved) return;
  for (const [board, t] of Object.entries(next)) {
    const old = prev[board];
    if (old && old.userId === t.userId) continue;
    const def = THRONE_BOARDS[board];
    battle.crowd.feed({
      icon: '👑', real: true, who: t.username,
      text: old ? `${t.username} が ${old.username} から${def.name}の王座を奪取！！` : `${t.username} が${def.name}の王座に就いた！`,
      textEn: old ? `${t.username} seized the ${def.nameEn} throne from ${old.username}!!` : `${t.username} claimed the ${def.nameEn} throne!`,
    });
    // 新王者が住人でも、当の本人が自分を祝わないように除外する。
    battle.crowd.react('throne', { you: t.username, board: def.name, notName: t.username });
  }
  db.meta.thrones = next;
  // 多冠の節目（2/3/5/7冠）に達した実プレイヤーへ永久バッジ。冠を失っても
  // バッジは残る — 「あの時代の王」の証。
  const counts = new Map();
  for (const t of Object.values(next)) if (!t.resident) counts.set(t.userId, (counts.get(t.userId) || 0) + 1);
  for (const [userId, n] of counts) {
    const u = db.users[userId];
    if (!u) continue;
    for (const [need, id] of [[2, 'crown2'], [3, 'crown3'], [5, 'crown5'], [7, 'crown7']]) {
      if (n >= need && !u.badges.includes(id)) {
        u.badges.push(id);
        battle.crowd.feed({
          icon: '👑', real: true, who: u.username,
          text: `${u.username} が${CROWN_TIER_NAMES[id]}を達成！バッジ獲得！`,
          textEn: `${u.username} earned the ${CROWN_TIER_NAMES_EN[id]} badge!`,
        });
      }
    }
  }
  saveDb();
}

const CROWN_TIER_NAMES = { crown2: '二冠', crown3: '三冠', crown5: '五冠', crown7: '全冠制覇' };
const CROWN_TIER_NAMES_EN = { crown2: 'Dual Crown', crown3: 'Triple Crown', crown5: 'Five Crowns', crown7: 'Total Domination' };

function thronesOf(userId) {
  if (!userId) return [];
  const map = db.meta.thrones || computeThrones();
  return Object.keys(map).filter(b => map[b] && map[b].userId === userId);
}

// Residents have no account id — their thrones are looked up by (unique) name.
function thronesOfName(username) {
  if (!username) return [];
  const map = db.meta.thrones || computeThrones();
  return Object.keys(map).filter(b => map[b] && map[b].username === username);
}

// Claim every pending ranking reward at once.
app.post('/api/rank/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  finalizeWeeklyRankings();
  const pending = req.user.rankRewards;
  if (!pending.length) return res.status(409).json({ error: '受け取れるランキング報酬はありません' });
  let coins = 0, gems = 0;
  const badges = [];
  for (const r of pending) {
    coins += r.coins || 0;
    gems += r.gems || 0;
    if (r.badge && !req.user.badges.includes(r.badge)) { req.user.badges.push(r.badge); badges.push(r.badge); }
  }
  req.user.coins += coins;
  req.user.gems += gems;
  const claimed = pending.slice();
  req.user.rankRewards = [];
  saveDb();
  res.json({ reward: { coins, gems, badges }, claimed, user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Game results & leaderboard
// ---------------------------------------------------------------------------

// Per-game rewards are capped (score rate, coin ceiling), but the ENDPOINT had
// no limit at all — a loop against it minted coins, gems, XP and badges as fast
// as the network allowed. A real game takes 20+ seconds, and even the fastest
// mode (a ★3 puzzle stage) tops out near 80 runs an hour, so these ceilings are
// far above legitimate play and still turn "unlimited" into "bounded".
app.post('/api/game/result', requireAuth, maintenanceGuard, (req, res) => {
  const tooFast = !rateLimit(`result:${req.user.id}`, 30, 60 * 1000)
    || !rateLimit(`resulth:${req.user.id}`, 250, 60 * 60 * 1000);
  if (tooFast) {
    return res.status(429).json({ error: '結果の送信が多すぎます。しばらく待ってください' });
  }
  const rewards = applyGameResult(req.user, req.body || {});
  res.json({ rewards, user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// 👑 管理者イベント — weekly, with per-player time slots
// ---------------------------------------------------------------------------

// Reservation counts + the shared world state, recomputed per request. There
// are no timers: everything derives from wall-clock time, so a redeploy in the
// middle of an event changes nothing.
function adminEventView(user) {
  const schedule = getAeSchedule(db);
  if (!schedule.enabled) return null;
  const occ = aeCurrentOccurrence(schedule);
  if (!occ) return null;
  return aePlayerView(db, user, Date.now(), aeSlotCounts(db, occ));
}

app.get('/api/adminevent', (req, res) => {
  res.json({ event: adminEventView(req.user) });
});

app.post('/api/adminevent/reserve', requireAuth, maintenanceGuard, (req, res) => {
  const schedule = getAeSchedule(db);
  if (!schedule.enabled) return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  const occ = aeCurrentOccurrence(schedule);
  if (!occ) return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  const slotId = Math.floor(Number(req.body && req.body.slotId));
  const r = aeReserve(req.user, occ, slotId);
  if (r.error) return res.status(400).json({ error: r.error });
  saveDb();
  res.json({ event: adminEventView(req.user), user: publicUser(req.user) });
});

app.post('/api/adminevent/cancel', requireAuth, (req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  if (occ) aeCancelReservation(req.user, occ.dayKey);
  else req.user.adminEvent = null;
  saveDb();
  res.json({ event: adminEventView(req.user) });
});

// Finish one run of the exclusive mode. The score is folded into the SHARED
// world state (one boss / one gauge / one board per event day), so the 18:00
// crowd and the 21:00 crowd are demonstrably working on the same thing.
app.post('/api/adminevent/result', requireAuth, maintenanceGuard, (req, res) => {
  const schedule = getAeSchedule(db);
  const live = schedule.enabled ? aeLiveSlotFor(schedule, req.user) : null;
  if (!live) return res.status(403).json({ error: 'いまはあなたの枠の時間ではありません' });

  const { occ } = live;
  const counts = aeSlotCounts(db, occ);
  const run = aeEnsureRun(db, occ, Math.max(1, aeEntrantCount(counts)));

  // Same anti-cheat ceiling the normal result path uses, then the event's own
  // reward multiplier on top (🎁 お宝ラッシュ).
  const body = req.body || {};
  const duration = Math.max(1, Math.min(3600, Number(body.duration) || 1));
  let score = Math.max(0, Math.min(1_000_000, Math.floor(Number(body.score) || 0)));
  if (score > duration * 500) score = Math.floor(duration * 500);

  const before = { hp: run.hp, tiersReached: run.tiersReached };
  const delta = aeContribute(run, req.user, score);

  const rewards = applyGameResult(req.user, {
    ...body,
    mode: `ae_${run.modeId}`,
    score,
    duration,
    won: !!delta.killed,
  });

  // 🎁 お宝ラッシュ — the slot's own multiplier, paid on top of whatever the
  // normal pipeline granted, and reported separately so the result screen can
  // show where it came from.
  const mult = Math.max(1, schedule.rewardMult || 1);
  let chestCoins = 0, chestGems = 0;
  if (mult > 1 && rewards) {
    chestCoins = Math.round(rewards.coins * (mult - 1));
    chestGems = Math.floor(score / 25_000) + (delta.killed ? 25 : 0);
    req.user.coins += chestCoins;
    req.user.gems += chestGems;
  }

  const r = req.user.adminEvent;
  if (r && r.dayKey === occ.dayKey) {
    r.playedAt = Date.now();
    r.runs = (r.runs || 0) + 1;
    r.best = Math.max(r.best || 0, score);
    r.contributed = (r.contributed || 0) + score;
    r.chests = (r.chests || 0) + 1;
  }
  req.user.stats.aePlays = (req.user.stats.aePlays || 0) + 1;
  req.user.stats.aeBest = Math.max(req.user.stats.aeBest || 0, score);

  // 👑 Everyone who took part in the day the Admin fell keeps the badge — the
  // final blow is luck, the 120,000 HP was the group's work.
  let aeBadge = null;
  if (run.modeId === 'invasion' && run.killedAt) {
    for (const u of Object.values(db.users)) {
      const ur = u && u.adminEvent;
      if (!ur || ur.dayKey !== occ.dayKey || !ur.runs) continue;
      if (!u.badges.includes('adminevent')) {
        u.badges.push('adminevent');
        if (u.id === req.user.id) aeBadge = 'adminevent';
      }
    }
  }

  // World-scale moments go to everyone, not just the people currently in a slot.
  if (delta.killed) {
    const mode = aeModeById(run.modeId);
    battle.broadcastAll({
      type: 'announce',
      message: `👑 「${req.user.username}」のとどめ！ ${mode ? mode.name : '管理者'}を全員で討ち取りました！`,
      messageEn: `👑 "${req.user.username}" lands the final blow — everyone brought the Admin down together!`,
      from: '運営',
    });
    battle.crowd.feed({ icon: '👑', real: true, who: '運営',
      text: `管理者イベントのボスが討伐されました（とどめ: ${req.user.username}）`,
      textEn: `The Admin Event boss has been defeated (final blow: ${req.user.username})` });
  }
  for (const idx of delta.tiersReached) {
    const tier = run.tiers[idx];
    battle.broadcastAll({
      type: 'announce',
      message: `🏛️ 共同作業 目標${idx + 1}達成！ 参加者全員に 🪙${tier.coins} 💎${tier.gems}`,
      messageEn: `🏛️ The Great Work cleared tier ${idx + 1}! Everyone who took part gets 🪙${tier.coins} 💎${tier.gems}`,
      from: '運営',
    });
  }

  saveDb();
  res.json({
    rewards, user: publicUser(req.user),
    chest: { coins: chestCoins, gems: chestGems, mult },
    delta: { gained: delta.gained, damage: delta.damage, killed: delta.killed, tiersReached: delta.tiersReached },
    aeBadge,
    before,
    event: adminEventView(req.user),
  });
});

// Community-goal payouts are claimed, not pushed — a player who was in the
// 18:00 slot can collect a tier the 21:00 crowd unlocked later.
app.post('/api/adminevent/claim', requireAuth, (req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  const run = db.meta.adminEventRun;
  if (!run || run.modeId !== 'communal') return res.status(409).json({ error: '受け取れる報酬がありません' });
  const r = req.user.adminEvent;
  if (!r || r.dayKey !== run.dayKey || !r.runs) {
    return res.status(403).json({ error: 'この回に参加していません' });
  }
  const claimed = r.claimedTiers || (r.claimedTiers = []);
  // Nothing reached yet is NOT the same as already collected — saying
  // "受け取り済みです" to someone whose gauge simply has not filled is a lie.
  if (!run.tiersReached) {
    return res.status(409).json({ error: 'まだ目標に届いていません（ゲージを進めよう）' });
  }
  let coins = 0, gems = 0, badge = null;
  for (let i = 0; i < run.tiersReached; i++) {
    if (claimed.includes(i)) continue;
    claimed.push(i);
    coins += run.tiers[i].coins;
    gems += run.tiers[i].gems;
    if (run.tiers[i].badge && !req.user.badges.includes(run.tiers[i].badge)) {
      req.user.badges.push(run.tiers[i].badge);
      badge = run.tiers[i].badge;
    }
  }
  if (!coins && !gems && !badge) return res.status(409).json({ error: '受け取り済みです' });
  req.user.coins += coins;
  req.user.gems += gems;
  saveDb();
  res.json({ reward: { coins, gems, badge }, user: publicUser(req.user), event: adminEventView(req.user) });
});

// ---- admin side ----

app.get('/api/admin/adminevent', requireAuth, requireAdmin, (_req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  const counts = occ ? aeSlotCounts(db, occ) : {};
  const roster = [];
  if (occ) {
    for (const u of Object.values(db.users)) {
      const r = u && u.adminEvent;
      if (r && r.dayKey === occ.dayKey) {
        roster.push({ username: u.username, slotId: r.slotId, runs: r.runs || 0, best: r.best || 0 });
      }
    }
    roster.sort((a, b) => a.slotId - b.slotId || b.best - a.best);
  }
  res.json({
    schedule,
    modes: AE_MODES,
    weekdays: AE_WEEKDAYS_JA,
    occurrences: aeUpcoming(schedule, Date.now(), 2).map(o => ({
      dayKey: o.dayKey, modeId: o.modeId, opensAt: o.opensAt, closesAt: o.closesAt,
      slots: o.slots.map(s => ({ id: s.id, time: s.time, startsAt: s.startsAt, endsAt: s.endsAt, taken: counts[s.id] || 0 })),
    })),
    roster,
    run: db.meta.adminEventRun || null,
  });
});

app.post('/api/admin/adminevent', requireAuth, requireAdmin, (req, res) => {
  const prev = db.meta.adminEvent || null;
  const r = aeNormalizeSchedule(req.body || {}, prev);
  if (r.error) return res.status(400).json({ error: r.error });
  const wasEnabled = prev && prev.enabled;
  r.schedule.updatedAt = Date.now();
  r.schedule.updatedBy = req.user.username;
  db.meta.adminEvent = r.schedule;
  // Re-scheduling to a different day — or switching the mode — abandons the
  // old shared state; it belongs to the day+mode pair it was created for.
  const occ = r.schedule.enabled ? aeCurrentOccurrence(r.schedule) : null;
  const run = db.meta.adminEventRun;
  if (run && (!occ || run.dayKey !== occ.dayKey || run.modeId !== occ.modeId)) {
    db.meta.adminEventRun = null;
  }
  saveDb();

  if (r.schedule.enabled && !wasEnabled && occ) {
    const mode = aeModeById(occ.modeId);
    const times = r.schedule.slots.join(' / ');
    battle.broadcastAll({
      type: 'announce',
      message: `👑 管理者イベント「${mode.name}」開催決定！ ${occ.dayKey} の ${times}（JST）— メニューから好きな時間帯を予約してね`,
      messageEn: `👑 Admin Event "${mode.nameEn}" is scheduled for ${occ.dayKey} at ${times} JST — reserve the slot that suits you from the menu`,
      from: '運営',
    });
    battle.crowd.feed({ icon: '👑', real: true, who: '運営',
      text: `管理者イベント「${mode.name}」の予約受付がはじまりました`,
      textEn: `Reservations are open for the Admin Event "${mode.nameEn}"` });
  }
  res.json({ schedule: r.schedule });
});

app.get('/api/leaderboard', (req, res) => {
  finalizeWeeklyRankings();
  refreshThrones();   // Elo changes happen over websockets — catch up here
  const board = ['rating', 'dungeon', 'weekly', 'sprint', 'puzzle', 'dig'].includes(req.query.board) ? req.query.board : 'score';
  const week = weekIdOf(currentWeekNum());
  const weeklyBestOf = u => (u.stats.weekly && u.stats.weekly.week === week ? u.stats.weekly.best : 0);
  // Time attack ranks on the headline 60-second board.
  const sprintBestOf = u => (u.stats.sprint && u.stats.sprint.s60) || 0;
  // Admins are excluded from public rankings.
  let users = Object.values(db.users).filter(u => !u.banned && u.role !== 'admin' && u.stats.gamesPlayed > 0);
  if (board === 'dungeon') users = users.filter(u => (u.stats.dungeonMax || 0) > 0);
  if (board === 'weekly') users = users.filter(u => weeklyBestOf(u) > 0);
  if (board === 'sprint') users = users.filter(u => sprintBestOf(u) > 0);
  if (board === 'puzzle') users = users.filter(u => (u.stats.puzzleStage || 0) > 0);
  if (board === 'dig') users = users.filter(u => (u.stats.digDepth || 0) > 0);
  const titleOf = u => {
    const t = TITLES.find(x => x.id === u.equippedTitle);
    return t ? { name: t.name, color: t.color } : null;
  };
  const realRows = users.map(u => ({
    username: u.username,
    guildTag: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].tag : null,
    abyssMax: u.stats.abyssMax || 0,
    level: levelOf(u.xp),
    bestScore: u.stats.bestScore,
    rating: u.stats.rating,
    pvpWins: u.stats.pvpWins,
    pvpLosses: u.stats.pvpLosses,
    dungeonMax: u.stats.dungeonMax || 0,
    weeklyBest: weeklyBestOf(u),
    sprintBest: sprintBestOf(u),
    sprint180: (u.stats.sprint && u.stats.sprint.s180) || 0,
    puzzleStage: u.stats.puzzleStage || 0,
    digDepth: u.stats.digDepth || 0,
    badges: u.badges,
    title: titleOf(u),
  }));
  // Ghost players pad the boards so rankings feel populated (weekly reshuffle).
  const taken = new Set(Object.values(db.users).map(u => u.username));
  const rows = realRows
    .concat(ghostRows(board, week, taken).map(r => ({ ...r, guildTag: tagOfName(db, r.username, null) })))
    .sort((a, b) => board === 'rating' ? b.rating - a.rating
      : board === 'dungeon' ? b.dungeonMax - a.dungeonMax
      : board === 'weekly' ? b.weeklyBest - a.weeklyBest
      : board === 'sprint' ? (b.sprintBest || 0) - (a.sprintBest || 0)
      : board === 'puzzle' ? (b.puzzleStage || 0) - (a.puzzleStage || 0)
      : board === 'dig' ? (b.digDepth || 0) - (a.digDepth || 0)
      : b.bestScore - a.bestScore)
    .slice(0, 100);
  // 👑 mark the throne holder's row + total crown counts (name colors scale).
  const throne = (db.meta.thrones || {})[board];
  if (throne) for (const r of rows) if (r.username === throne.username) r.throne = true;
  const crownCounts = new Map();
  for (const t of Object.values(db.meta.thrones || {})) if (t) crownCounts.set(t.username, (crownCounts.get(t.username) || 0) + 1);
  for (const r of rows) { const c = crownCounts.get(r.username); if (c) r.crowns = c; }
  // The weekly board pays prizes at the Monday reset — send the tier table.
  res.json({ board, rows, throne: throne ? { username: throne.username, since: throne.at } : null, ...(board === 'weekly' ? { rewards: rankRewardsTable() } : {}) });
});

// ---------------------------------------------------------------------------
// Titles (称号)
// ---------------------------------------------------------------------------

app.get('/api/titles', (req, res) => {
  res.json({
    titles: TITLES,
    earned: req.user ? earnedTitles(req.user) : [],
    equipped: req.user ? req.user.equippedTitle : null,
  });
});

app.post('/api/titles/equip', requireAuth, (req, res) => {
  const id = req.body.id === null ? null : String(req.body.id || '');
  if (id !== null) {
    if (!TITLES.some(t => t.id === id)) return res.status(404).json({ error: '称号が見つかりません' });
    if (!earnedTitles(req.user).includes(id)) return res.status(403).json({ error: 'まだ獲得していない称号です' });
  }
  req.user.equippedTitle = id;
  saveDb();
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Boss battles
// ---------------------------------------------------------------------------

app.get('/api/bosses', (req, res) => {
  // 🐲 Boss Invasion softens every boss while it runs.
  const hpMult = eventBonus(currentEvent()).bossHp || 1;
  res.json({
    bosses: hpMult === 1 ? BOSSES : BOSSES.map(b => ({ ...b, hp: Math.round(b.hp * hpMult), weakened: true })),
    // Admins have everything unlocked, boss rush included.
    bossMax: req.user && req.user.role === 'admin' ? BOSSES.length
      : req.user ? (req.user.stats.bossMax || 0) : 0,
  });
});

// ---------------------------------------------------------------------------
// Gem purchases (DEMO payment — no real money is charged)
// ---------------------------------------------------------------------------

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeEnabled = () => STRIPE_KEY.length > 0;

app.get('/api/gempacks', (_req, res) => {
  res.json({ packs: GEM_PACKS, mode: stripeEnabled() ? 'stripe' : 'coming_soon' });
});

function grantPack(user, pack, status, extId = null) {
  const total = pack.gems + pack.bonus;
  user.gems += total;
  db.transactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    packId: pack.id,
    gems: total,
    jpy: pack.priceJpy,
    status,
    extId,
    at: Date.now(),
  });
  saveDb();
  return total;
}

app.post('/api/purchase', requireAuth, maintenanceGuard, async (req, res) => {
  if (!rateLimit(`buy:${req.user.id}`, 30, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '購入リクエストが多すぎます' });
  }
  const pack = GEM_PACKS.find(p => p.id === req.body.packId);
  if (!pack) return res.status(404).json({ error: 'パックが見つかりません' });

  // Real payments: create a Stripe Checkout session. Card details are entered
  // on Stripe's hosted page; gems are granted ONLY by the verified webhook.
  if (stripeEnabled()) {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      const params = new URLSearchParams({
        mode: 'payment',
        success_url: `${base}/?purchase=success`,
        cancel_url: `${base}/?purchase=cancel`,
        'line_items[0][price_data][currency]': 'jpy',
        'line_items[0][price_data][product_data][name]': `Block Blitz Arena ジェム ${pack.gems + pack.bonus}個`,
        'line_items[0][price_data][unit_amount]': String(pack.priceJpy),
        'line_items[0][quantity]': '1',
        'metadata[userId]': req.user.id,
        'metadata[packId]': pack.id,
      });
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const session = await resp.json();
      if (!resp.ok || !session.url) {
        console.error('[stripe] session create failed:', session.error && session.error.message);
        return res.status(502).json({ error: '決済セッションの作成に失敗しました' });
      }
      return res.json({ checkoutUrl: session.url });
    } catch (err) {
      console.error('[stripe] error:', err.message);
      return res.status(502).json({ error: '決済サービスに接続できません' });
    }
  }

  // No payment provider configured — purchases are under construction.
  res.status(503).json({ error: '💳 課金機能は製作中です。もうしばらくお待ちください！' });
});

// Stripe webhook: the ONLY place real purchases grant gems.
app.post('/api/stripe/webhook', (req, res) => {
  if (!stripeEnabled() || !STRIPE_WEBHOOK_SECRET) return res.status(404).end();
  try {
    const sigHeader = String(req.headers['stripe-signature'] || '');
    const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
    const payload = `${parts.t}.${req.rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
    const given = Buffer.from(parts.v1 || '', 'hex');
    if (given.length !== 32 || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), given)) {
      return res.status(400).json({ error: 'bad signature' });
    }
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) {
      return res.status(400).json({ error: 'stale timestamp' });
    }
    const event = req.body;
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.metadata) {
        const user = db.users[session.metadata.userId];
        const pack = GEM_PACKS.find(p => p.id === session.metadata.packId);
        const already = db.transactions.some(t => t.extId === session.id);
        if (user && pack && !already) {
          grantPack(user, pack, 'stripe_completed', session.id);
          console.log(`[stripe] granted ${pack.id} to ${user.username}`);
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook error:', err.message);
    res.status(400).json({ error: 'webhook error' });
  }
});

app.get('/api/admin/transactions', requireAuth, requireAdmin, (_req, res) => {
  const tx = db.transactions.slice(-100).reverse();
  res.json({
    transactions: tx,
    totalCount: db.transactions.length,
    totalJpy: db.transactions.reduce((a, t) => a + t.jpy, 0),
  });
});

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

app.get('/api/shop', (req, res) => {
  // Admin-exclusive cosmetics are invisible to everyone else. Gacha-exclusive
  // gear is listed (so players know it exists) but marked and unbuyable.
  const isAdmin = req.user && req.user.role === 'admin';
  res.json({ items: SHOP_ITEMS.filter(i => !i.adminOnly || isAdmin), boosters: BOOST_ITEMS.filter(i => !i.adminOnly || isAdmin) });
});

// ---- Booster items (consumables) ----

app.post('/api/items/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = BOOST_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用のアイテムです（非売品）' });
  const count = Math.max(1, Math.min(10, Math.floor(Number(req.body.count) || 1)));
  const cost = item.price * count;
  const user = req.user;
  if (user.role !== 'admin') {   // admins never pay
    if (user.coins < cost) return res.status(402).json({ error: 'コインが足りません' });
    user.coins -= cost;
  }
  user.items = user.items || {};
  user.items[item.id] = (user.items[item.id] || 0) + count;
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/items/use', requireAuth, (req, res) => {
  const user = req.user;
  user.items = user.items || {};
  const id = String(req.body.itemId || '');
  const def = BOOST_ITEMS.find(i => i.id === id);
  if (!def) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (def.adminOnly && user.role !== 'admin') return res.status(403).json({ error: '管理者専用のアイテムです' });
  // Admins have infinite boosters — nothing is consumed.
  if (user.role !== 'admin') {
    if ((user.items[id] || 0) <= 0) return res.status(409).json({ error: 'アイテムを持っていません' });
    user.items[id] -= 1;
    saveDb();
  }
  res.json({ user: publicUser(user) });
});

// ---- Capsule machine (coin gacha) ----

const GACHA_COST_1 = 500;
const GACHA_COST_10 = 4500;

// ガチャ2.0: floor で下限レアリティを底上げできる（87=SSR以上確定、72=SR以上確定）。
const GACHA_PITY = 40;   // 天井 — 40連以内にSSR以上が必ず出る

function gachaPull(user, lucky = false, floor = 0) {
  // 🍀 Lucky Day skews every roll upward (exponent < 1), so the rare tiers at
  // the top of the range come up more often: N 50%→37%, SSR+ 13%→18%.
  const roll = floor + (lucky ? Math.pow(Math.random(), 0.7) : Math.random()) * (100 - floor);
  if (roll < 50) {   // N: coins
    const amount = 150 + Math.floor(Math.random() * 6) * 50;
    user.coins += amount;
    return { type: 'coins', amount, rarity: 'N' };
  }
  if (roll < 72) {   // R: booster item (staff-only god items must never drop)
    const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
    const it = pool[Math.floor(Math.random() * pool.length)];
    user.items[it.id] = (user.items[it.id] || 0) + 1;
    return { type: 'item', id: it.id, name: it.name, icon: it.icon, rarity: 'R' };
  }
  if (roll < 87) {   // SR: gems
    const amount = 15 + Math.floor(Math.random() * 6) * 5;
    user.gems += amount;
    return { type: 'gems', amount, rarity: 'SR' };
  }
  if (roll < 97) {   // SSR: unowned cosmetic (or big gems when complete)
    // adminOnly gear must never drop; gachaOnly gear drops ONLY here.
    const unowned = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !user.owned.includes(i.id));
    if (unowned.length === 0) {
      user.gems += 50;
      return { type: 'gems', amount: 50, rarity: 'SSR', complete: true };
    }
    const it = unowned[Math.floor(Math.random() * unowned.length)];
    user.owned.push(it.id);
    return { type: 'cosmetic', id: it.id, name: it.name, cat: it.cat, rarity: 'SSR', limited: !!it.gachaOnly };
  }
  // UR: jackpot gems
  user.gems += 150;
  return { type: 'gems', amount: 150, rarity: 'UR' };
}

app.post('/api/gacha', requireAuth, maintenanceGuard, (req, res) => {
  const count = Number(req.body.count) === 10 ? 10 : 1;
  const bonus = eventBonus(currentEvent());
  const base = count === 10 ? GACHA_COST_10 : GACHA_COST_1;
  const cost = Math.round(base * (bonus.gachaDiscount || 1));
  const user = req.user;
  if (user.role !== 'admin') {   // admins pull for free
    if (user.coins < cost) return res.status(402).json({ error: `コインが足りません（${fmtNum(cost)}必要）` });
    user.coins -= cost;
  }
  user.items = user.items || {};
  migrateUser(user);
  // ガチャ2.0: 天井（40連でSSR以上確定）＋ 10連はSR以上1枠確定。
  const isSRplus = r => r.rarity === 'SR' || r.rarity === 'SSR' || r.rarity === 'UR';
  const results = [];
  for (let i = 0; i < count; i++) {
    let floor = 0;
    if ((user.gachaPity || 0) >= GACHA_PITY - 1) floor = 87;                       // 天井到達: SSR以上
    else if (count === 10 && i === 9 && !results.some(isSRplus)) floor = 72;      // 10連保証: SR以上
    const r = gachaPull(user, !!bonus.gachaLuck, floor);
    user.gachaPity = (r.rarity === 'SSR' || r.rarity === 'UR') ? 0 : (user.gachaPity || 0) + 1;
    results.push(r);
  }
  user.stats.gachaPulls = (user.stats.gachaPulls || 0) + count;
  user.stats.gachaSSR = (user.stats.gachaSSR || 0) + results.filter(r => r.rarity === 'SSR' || r.rarity === 'UR').length;
  saveDb();
  // Big pulls make the live feed.
  const ur = results.find(r => r.rarity === 'UR');
  const ssr = results.find(r => r.rarity === 'SSR' && r.type === 'cosmetic');
  if (ur) postRealFeed(user, [{ icon: '🌟', ja: `${user.username} が UR を引き当てた！！`, en: `${user.username} hit the UR jackpot!!`, react: null }]);
  else if (ssr) postRealFeed(user, [{ icon: '🎰', ja: `${user.username} がガチャで SSR「${ssr.name}」を引いた！`, en: `${user.username} pulled SSR "${ssr.name}"!` }]);
  const collectibles = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly);
  res.json({
    results, user: publicUser(user), cost, lucky: !!bonus.gachaLuck,
    pity: { count: user.gachaPity || 0, max: GACHA_PITY },
    collection: { owned: collectibles.filter(i => user.owned.includes(i.id)).length, total: collectibles.length },
  });
});

// Public gacha pricing so the UI can show the discounted cost.
app.get('/api/gacha/info', (req, res) => {
  const bonus = eventBonus(currentEvent());
  const mult = bonus.gachaDiscount || 1;
  const collectibles = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly);
  res.json({
    cost1: Math.round(GACHA_COST_1 * mult),
    cost10: Math.round(GACHA_COST_10 * mult),
    base1: GACHA_COST_1, base10: GACHA_COST_10,
    lucky: !!bonus.gachaLuck,
    discounted: mult !== 1,
    pityMax: GACHA_PITY,
    ...(req.user ? {
      pity: { count: req.user.gachaPity || 0, max: GACHA_PITY },
      collection: { owned: collectibles.filter(i => req.user.owned.includes(i.id)).length, total: collectibles.length },
    } : {}),
  });
});

function fmtNum(n) { return n.toLocaleString('ja-JP'); }

app.post('/api/shop/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = SHOP_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用の装備です（非売品）' });
  if (item.gachaOnly) return res.status(403).json({ error: '🎰 ガチャ限定の装備です（SSRで入手）' });
  const user = req.user;
  if (user.owned.includes(item.id)) return res.status(409).json({ error: 'すでに所持しています' });
  if (user[item.currency] < item.price) {
    return res.status(402).json({ error: item.currency === 'coins' ? 'コインが足りません' : 'ジェムが足りません' });
  }
  user[item.currency] -= item.price;
  user.owned.push(item.id);
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/equip', requireAuth, (req, res) => {
  const { slot, itemId } = req.body;
  if (!EQUIP_SLOTS.includes(slot)) return res.status(400).json({ error: '不正なスロットです' });
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item || item.cat !== slot) return res.status(400).json({ error: '不正なアイテムです' });
  // Admins implicitly own the entire catalog; admin gear stays admin-only.
  if (item.adminOnly) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '管理者専用の装備です' });
  } else if (req.user.role !== 'admin' && !req.user.owned.includes(itemId)) {
    return res.status(403).json({ error: '所持していないアイテムです' });
  }
  req.user.equipped[slot] = itemId;
  saveDb();
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Missions (daily / weekly)
// ---------------------------------------------------------------------------

app.get('/api/missions', requireAuth, (req, res) => {
  migrateUser(req.user);
  syncMissions(req.user, currentWeekNum());
  saveDb();
  res.json({ missions: missionsView(req.user, currentWeekNum()) });
});

app.post('/api/missions/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const id = String(req.body.id || '');
  const out = id === 'daily_bonus' || id === 'weekly_bonus'
    ? claimMissionBonus(req.user, currentWeekNum(), id === 'daily_bonus' ? 'daily' : 'weekly')
    : claimMission(req.user, currentWeekNum(), id);
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({
    reward: out,
    missions: missionsView(req.user, currentWeekNum()),
    user: publicUser(req.user),
  });
});

// ---------------------------------------------------------------------------
// Achievements (実績)
// ---------------------------------------------------------------------------

app.get('/api/achievements', (req, res) => {
  if (!req.user) {
    // Guests still get to browse the list (progress reads as zero).
    return res.json({ achievements: achievementsView({ stats: {}, badges: [], owned: [], achievements: [], coins: 0, xp: 0 }) });
  }
  migrateUser(req.user);
  res.json({ achievements: achievementsView(req.user) });
});

app.post('/api/achievements/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const out = claimAchievement(req.user, String(req.body.id || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  // The rarest achievements are worth a line on the feed.
  const top = ACHIEVEMENTS.filter(a => out.ids.includes(a.id)).sort((a, b) => b.gems - a.gems)[0];
  if (top && top.gems >= 15) {
    postRealFeed(req.user, [{ icon: top.icon, ja: `${req.user.username} が実績「${top.name}」を解除！`, en: `${req.user.username} unlocked "${top.nameEn}"!` }]);
  }
  res.json({ reward: out, achievements: achievementsView(req.user), user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Battle pass
// ---------------------------------------------------------------------------

app.get('/api/battlepass', (req, res) => {
  res.json({
    season: currentSeason(),
    tiers: BP_TIERS,
    xpPerTier: BP_XP_PER_TIER,
    premiumPriceGems: BP_PREMIUM_PRICE_GEMS,
    progress: req.user ? syncBattlePass(req.user) : null,
  });
});

app.post('/api/battlepass/premium', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  if (bp.premium) return res.status(409).json({ error: 'すでにプレミアムです' });
  if (user.gems < BP_PREMIUM_PRICE_GEMS) return res.status(402).json({ error: 'ジェムが足りません' });
  user.gems -= BP_PREMIUM_PRICE_GEMS;
  bp.premium = true;
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/battlepass/claim', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  const tierNum = Math.floor(Number(req.body.tier));
  const track = req.body.track === 'premium' ? 'premium' : 'free';
  const tierDef = BP_TIERS.find(t => t.tier === tierNum);
  if (!tierDef) return res.status(404).json({ error: 'ティアが見つかりません' });
  const reward = tierDef[track];
  if (!reward) return res.status(400).json({ error: '報酬がありません' });
  if (track === 'premium' && !bp.premium) return res.status(403).json({ error: 'プレミアムパスが必要です' });
  const unlockedTier = Math.floor(bp.xp / BP_XP_PER_TIER);
  if (tierNum > unlockedTier) return res.status(403).json({ error: 'まだ解放されていません' });
  const key = `${tierNum}:${track}`;
  if (bp.claimed.includes(key)) return res.status(409).json({ error: '受け取り済みです' });

  bp.claimed.push(key);
  if (reward.type === 'coins') user.coins += reward.amount;
  else if (reward.type === 'gems') user.gems += reward.amount;
  else if (reward.type === 'item') { if (!user.owned.includes(reward.id)) user.owned.push(reward.id); }
  else if (reward.type === 'badge') { if (!user.badges.includes(reward.id)) user.badges.push(reward.id); }
  saveDb();
  res.json({ user: publicUser(user), reward });
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, role: u.role, banned: u.banned, muted: !!u.muted,
    coins: u.coins, gems: u.gems, level: levelOf(u.xp),
    stats: u.stats, createdAt: u.createdAt,
  }));
  res.json({ users });
});

// 🎒 インベントリ編集 — one screen with everything an admin can put back.
//
// The list endpoint above deliberately stays light (it renders every account),
// so the editor asks for one player in full, plus the catalogue it needs to
// draw checkboxes for. Without this the client would have to guess what exists.
// The RAW record as the editor needs to see it. Deliberately not publicUser():
// that one hands admins the entire shop and infinite currency as a display
// fiction, which the editor must never read back as fact.
function adminUserView(u) {
  return {
    id: u.id, username: u.username, role: u.role,
    banned: !!u.banned, muted: !!u.muted,
    coins: u.coins, gems: u.gems, xp: u.xp, level: levelOf(u.xp),
    items: u.items || {}, owned: u.owned || [], equipped: u.equipped || {},
    equippedTitle: u.equippedTitle || null,
    badges: u.badges || [], achievements: u.achievements || [],
    battlePass: u.battlePass || null,
    createdAt: u.createdAt,
    guildId: u.guildId || null,
    guildName: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].name : null,
    stats: u.stats,
  };
}

app.get('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  migrateUser(u);
  res.json({
    user: adminUserView(u),
    catalog: {
      shop: SHOP_ITEMS.map(i => ({ id: i.id, cat: i.cat, name: i.name, icon: i.icon || null, adminOnly: !!i.adminOnly, gachaOnly: !!i.gachaOnly })),
      boosters: BOOST_ITEMS.map(i => ({ id: i.id, name: i.name, icon: i.icon, adminOnly: !!i.adminOnly })),
      slots: EQUIP_SLOTS,
      titles: TITLES.map(t => ({ id: t.id, name: t.name, color: t.color })),
      badges: ADMIN_KNOWN_BADGES,
      // Only these stats are hand-editable. Everything else is a running total
      // the game maintains, and editing it just makes the numbers lie.
      stats: EDITABLE_STATS,
    },
  });
});

// The stats an admin can sensibly restore. Anything derived (level from xp,
// titles from stats, achievement progress) is deliberately absent — those
// recompute themselves from what is set here.
const EDITABLE_STATS = [
  { key: 'bestScore', label: 'ハイスコア', max: 100_000_000 },
  { key: 'rating', label: 'レート', max: 5000 },
  { key: 'gamesPlayed', label: 'プレイ回数', max: 1_000_000 },
  { key: 'totalScore', label: '累計スコア', max: 1_000_000_000 },
  { key: 'totalLines', label: '累計ライン', max: 10_000_000 },
  { key: 'maxCombo', label: '最大コンボ', max: 999 },
  { key: 'pvpWins', label: 'PvP勝利', max: 1_000_000 },
  { key: 'pvpLosses', label: 'PvP敗北', max: 1_000_000 },
  { key: 'dungeonMax', label: 'ダンジョン最高階', max: 100 },
  { key: 'abyssMax', label: '深淵最高階', max: 100 },
  { key: 'bossMax', label: 'ボス討伐数', max: 6 },
  { key: 'puzzleStage', label: 'パズル遺跡ステージ', max: 9999 },
  { key: 'digDepth', label: '採掘深度', max: 9999 },
  { key: 'survivalWave', label: 'サバイバルWAVE', max: 999 },
  { key: 'loginStreakBest', label: '最長連続ログイン', max: 3650 },
  // 順位なので 1 が最高。0 は「記録なし」を意味するので下限は 0 のまま。
  { key: 'royaleBest', label: 'ロイヤル最高順位（0=記録なし）', max: 100 },
  { key: 'royaleKills', label: 'ロイヤル通算KO', max: 1_000_000 },
];

const ADMIN_KNOWN_BADGES = ['bronze', 'silver', 'gold', 'oni', 'kami', 'souzou', 'maou', 'rush', 'dungeon', 'tourney', 'royale', 'adminevent', 'abyss', 'weekly1', 'puzzle', 'dig', 'crown2', 'crown3', 'crown5', 'crown7', 'ghost'];

app.post('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  // Repair FIRST, not last: the branches below assume a complete record, and a
  // legacy or restored one could make them throw a 500 or write NaN before the
  // repair at the end of the handler ever ran.
  migrateUser(target);
  const b = req.body || {};
  // `typeof v === 'number'` lets Infinity through — JSON.parse('1e400') is
  // Infinity, and `coins + Infinity` serialises to null, which permanently
  // corrupts that account.
  const delta = (v, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.max(-max, Math.min(max, Math.trunc(v)));
  };
  if (b.grantCoins !== undefined) {
    const n = delta(b.grantCoins, 1_000_000_000);
    if (n === null) return res.status(400).json({ error: 'コイン付与額が不正です' });
    target.coins = Math.max(0, Math.min(1_000_000_000, target.coins + n));
  }
  if (b.grantGems !== undefined) {
    const n = delta(b.grantGems, 100_000_000);
    if (n === null) return res.status(400).json({ error: 'ジェム付与額が不正です' });
    target.gems = Math.max(0, Math.min(100_000_000, target.gems + n));
  }
  if (b.grantItems !== undefined) {
    // grant N of every booster (negative to confiscate)
    const n = delta(b.grantItems, 999);
    if (n === null) return res.status(400).json({ error: 'アイテム付与数が不正です' });
    target.items = target.items || {};
    for (const it of BOOST_ITEMS) target.items[it.id] = Math.max(0, Math.min(999, (target.items[it.id] || 0) + n));
  }
  if (typeof b.banned === 'boolean') {
    if (target.role === 'admin' && b.banned) return res.status(400).json({ error: '管理者は凍結できません' });
    target.banned = b.banned;
  }
  if (typeof b.muted === 'boolean') {
    if ((target.role === 'admin' || target.role === 'mod') && b.muted) {
      return res.status(400).json({ error: '運営メンバーはミュートできません' });
    }
    target.muted = b.muted;
  }
  if (typeof b.setPassword === 'string') {
    if (b.setPassword.length < 6) return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
    const { salt, hash } = hashPassword(b.setPassword);
    target.salt = salt;
    target.passHash = hash;
    // force re-login everywhere with the new password
    revokeAllTokens(target.id);
  }
  const KNOWN_BADGES = ADMIN_KNOWN_BADGES;   // 一箇所で管理（編集画面と同じ一覧）
  if (typeof b.grantBadge === 'string') {
    if (!KNOWN_BADGES.includes(b.grantBadge)) return res.status(400).json({ error: `バッジIDが不正です（${KNOWN_BADGES.join(' / ')}）` });
    if (!target.badges.includes(b.grantBadge)) target.badges.push(b.grantBadge);
  }
  if (typeof b.revokeBadge === 'string') {
    target.badges = target.badges.filter(x => x !== b.revokeBadge);
  }
  if (typeof b.setRating === 'number') target.stats.rating = Math.max(0, Math.min(5000, Math.floor(b.setRating)));
  if (typeof b.setLevel === 'number') {
    // levelOf(xp) = 1 + floor(xp/1000)  →  xp for level L is (L-1)*1000
    const lv = Math.max(1, Math.min(999, Math.floor(b.setLevel)));
    target.xp = (lv - 1) * 1000;
  }
  if (['admin', 'mod', 'user'].includes(b.role)) {
    if (target.id === req.user.id && b.role !== 'admin') {
      return res.status(400).json({ error: '自分の権限は下げられません（別の管理者に依頼してください）' });
    }
    target.role = b.role;
  }
  if (b.resetStats === true) {
    target.stats = { gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0, aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000 };
  }

  // ---- 🎒 インベントリ編集（絶対値で設定する系） ----
  //
  // The grant* fields above ADD; these SET. Two rules make this safe enough to
  // expose in a browser:
  //
  //  1. VALIDATE EVERYTHING FIRST, then apply. Writing as we validated meant a
  //     later field's 400 left the earlier fields already written to the live
  //     record, and the next saveDb() persisted that half-applied edit while
  //     the admin saw an error and assumed nothing happened.
  //  2. Reject rather than coerce. `Number(null)` is 0, so a stray null in the
  //     JSON used to silently wipe a player's currency and answer ok:true.
  const patch = {};
  const intIn = (v, max, min = 0) => {
    if (typeof v === 'string' ? v.trim() === '' : typeof v !== 'number') return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
  };
  const bad = msg => { throw Object.assign(new Error(msg), { userError: true }); };

  try {
    if (b.setCoins !== undefined) {
      const n = intIn(b.setCoins, 1_000_000_000);
      if (n === null) bad('コインの値が不正です');
      patch.coins = n;
    }
    if (b.setGems !== undefined) {
      const n = intIn(b.setGems, 100_000_000);
      if (n === null) bad('ジェムの値が不正です');
      patch.gems = n;
    }
    // setLevel rounds XP down to the floor of that level, which throws away
    // partial progress — setXp restores the exact value.
    if (b.setXp !== undefined) {
      const n = intIn(b.setXp, 998_000);
      if (n === null) bad('XPの値が不正です');
      patch.xp = n;
    }

    if (b.setItems !== undefined) {
      if (!b.setItems || typeof b.setItems !== 'object' || Array.isArray(b.setItems)) bad('アイテムの指定が不正です');
      const known = new Map(BOOST_ITEMS.map(i => [i.id, i]));
      const next = {};
      for (const [id, v] of Object.entries(b.setItems)) {
        const def = known.get(id);
        if (!def) bad(`不明なアイテムです: ${String(id).slice(0, 32)}`);
        if (def.adminOnly && target.role !== 'admin') bad('管理者専用アイテムは付与できません');
        const n = intIn(v, 999);
        if (n === null) bad(`アイテム個数が不正です: ${id}`);
        if (n > 0) next[id] = n;
      }
      patch.items = next;
    }

    // Owned cosmetics. The defaults are always re-added so a player can never
    // be left with nothing equippable.
    if (b.setOwned !== undefined) {
      if (!Array.isArray(b.setOwned)) bad('所持品の指定が不正です');
      const known = new Map(SHOP_ITEMS.map(i => [i.id, i]));
      for (const id of b.setOwned) {
        const it = known.get(id);
        if (!it) bad(`不明なアイテムです: ${String(id).slice(0, 32)}`);
        if (it.adminOnly && target.role !== 'admin') bad('管理者専用の装備は付与できません');
      }
      patch.owned = [...new Set([...DEFAULT_OWNED, ...b.setOwned])];
    }

    // Equipping something the player does not own renders as a blank board, so
    // this is checked against the owned list AFTER any change in this same
    // request — not the stale one.
    if (b.setEquipped !== undefined) {
      if (!b.setEquipped || typeof b.setEquipped !== 'object' || Array.isArray(b.setEquipped)) bad('装備の指定が不正です');
      const owned = new Set(patch.owned || target.owned || []);
      const next = { ...(target.equipped || {}) };
      for (const [slot, id] of Object.entries(b.setEquipped)) {
        if (!EQUIP_SLOTS.includes(slot)) bad(`不明な装備スロットです: ${String(slot).slice(0, 16)}`);
        const item = SHOP_ITEMS.find(i => i.id === id);
        if (!item || item.cat !== slot) bad(`${slot} に装備できないアイテムです`);
        if (!owned.has(id)) bad('所持していないアイテムは装備できません（先に所持品に追加してください）');
        next[slot] = id;
      }
      patch.equipped = next;
    }

    if (b.setTitle !== undefined) {
      if (b.setTitle === null || b.setTitle === '') patch.equippedTitle = null;
      else if (!TITLES.some(t => t.id === b.setTitle)) bad('不明な称号です');
      else patch.equippedTitle = b.setTitle;
    }

    if (b.setBadges !== undefined) {
      if (!Array.isArray(b.setBadges)) bad('バッジの指定が不正です');
      for (const id of b.setBadges) {
        if (!ADMIN_KNOWN_BADGES.includes(id)) bad(`不明なバッジです: ${String(id).slice(0, 32)}`);
      }
      patch.badges = [...new Set(b.setBadges)];
    }

    // A premium battle pass was PAID for with gems, so restoring an account
    // has to be able to give it back. The season is not editable: it must stay
    // whatever currentSeason() says, or syncBattlePass wipes the record.
    if (b.setPass !== undefined) {
      if (!b.setPass || typeof b.setPass !== 'object' || Array.isArray(b.setPass)) bad('バトルパスの指定が不正です');
      const bp = { ...(target.battlePass || {}) };
      if (b.setPass.xp !== undefined) {
        const n = intIn(b.setPass.xp, BP_TIERS.length * BP_XP_PER_TIER);
        if (n === null) bad('バトルパスXPの値が不正です');
        bp.xp = n;
      }
      if (b.setPass.premium !== undefined) {
        if (typeof b.setPass.premium !== 'boolean') bad('プレミアムの指定が不正です');
        bp.premium = b.setPass.premium;
      }
      patch.battlePass = bp;
    }

    if (b.setStats !== undefined) {
      if (!b.setStats || typeof b.setStats !== 'object' || Array.isArray(b.setStats)) bad('統計の指定が不正です');
      const next = {};
      for (const [key, v] of Object.entries(b.setStats)) {
        const def = EDITABLE_STATS.find(s => s.key === key);
        if (!def) bad(`編集できない項目です: ${String(key).slice(0, 32)}`);
        const n = intIn(v, def.max, def.min || 0);
        if (n === null) bad(`${def.label} の値が不正です`);
        next[key] = n;
      }
      patch.stats = next;
    }
  } catch (err) {
    if (err && err.userError) return res.status(400).json({ error: err.message });
    throw err;
  }

  // ---- everything validated: apply ----
  for (const k of ['coins', 'gems', 'xp', 'items', 'owned', 'equippedTitle', 'badges', 'battlePass']) {
    if (patch[k] !== undefined) target[k] = patch[k];
  }
  if (patch.equipped) target.equipped = patch.equipped;
  if (patch.stats) {
    target.stats = target.stats || {};
    Object.assign(target.stats, patch.stats);
  }

  // Reconcile the equipped-must-be-owned invariant no matter WHICH field moved:
  // dropping an item from the owned list while it was equipped used to leave
  // the player staring at a board that renders nothing.
  target.owned = target.owned || [];
  for (const slot of EQUIP_SLOTS) {
    const cur = target.equipped && target.equipped[slot];
    const item = SHOP_ITEMS.find(i => i.id === cur);
    if (!item || item.cat !== slot || !target.owned.includes(cur)) {
      target.equipped = target.equipped || {};
      target.equipped[slot] = DEFAULT_EQUIPPED[slot];
    }
  }

  // Leave the record in a shape the rest of the server can read.
  migrateUser(target);
  saveDb();
  // NOT publicUser(): for an admin target that view fakes the entire shop as
  // owned, and echoing it back would let the editor write that fiction in.
  res.json({ ok: true, user: adminUserView(target) });
});


app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin') return res.status(400).json({ error: '管理者は削除できません' });
  revokeAllTokens(req.params.id);
  leaveGuild(db, target);   // same reason as DELETE /api/me — before the record goes
  delete db.users[req.params.id];
  db.deleted[req.params.id] = Date.now();
  saveDb();
  res.json({ ok: true });
});

// Force a brand-new season starting now (everyone's battle pass resets — that
// is the point of this button). Implemented as an override generation bump so
// it survives redeploys via the backup's meta.
app.post('/api/admin/season/new', requireAuth, requireAdmin, (req, res) => {
  const cur = currentSeason();
  const idx = derivedSeasonIndex();
  const o = db.meta.seasonOverride || {};
  db.meta.seasonOverride = {
    baseIndex: idx,
    gen: (o.gen || 0) + 1,
    numberOffset: (cur.number + 1) - idx,
    name: sanitizeName(req.body.name) || null,
    startedAt: Date.now(),
    endsAt: Date.now() + SEASON_MS,
  };
  saveDb();
  res.json({ season: currentSeason() });
});

// Change the current season — supports reverting the number/name WITHOUT
// resetting everyone's battle pass progress (keepProgress, default true).
app.post('/api/admin/season/set', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const cur = currentSeason();
  const number = Math.max(1, Math.min(999, Math.floor(Number(b.number) || cur.number)));
  const name = sanitizeName(b.name) || null;
  const days = Math.max(1, Math.min(365, Math.floor(Number(b.days) || 0)));
  const keepProgress = b.keepProgress !== false;
  const effIdx = Number(cur.id.slice(1).split('-')[0]) || derivedSeasonIndex();
  const o = db.meta.seasonOverride || {};
  db.meta.seasonOverride = {
    baseIndex: effIdx,
    gen: (o.gen || 0) + (keepProgress ? 0 : 1),
    numberOffset: number - effIdx,
    name,
    startedAt: keepProgress ? (o.startedAt || cur.startedAt) : Date.now(),
    // Only pin an endsAt when the admin actually chose a duration — otherwise
    // stay on the natural 30-day grid so seasons keep rolling on schedule.
    endsAt: b.days ? Date.now() + days * 24 * 60 * 60 * 1000 : (keepProgress ? (o.endsAt || null) : Date.now() + SEASON_MS),
  };
  saveDb();
  res.json({ season: currentSeason(), progressKept: keepProgress });
});

// Reset competitive stats for all users (scores, ratings, PvP records).
app.post('/api/admin/leaderboard/reset', requireAuth, requireAdmin, (_req, res) => {
  let count = 0;
  for (const u of Object.values(db.users)) {
    u.stats.bestScore = 0;
    u.stats.totalScore = 0;
    u.stats.rating = 1000;
    u.stats.pvpWins = 0;
    u.stats.pvpLosses = 0;
    count++;
  }
  saveDb();
  res.json({ ok: true, affected: count });
});

// Full database backup download.
app.get('/api/admin/backup', requireAuth, requireAdmin, (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="block-blitz-backup-${stamp}.json"`);
  // Stamp the dump so the restore dialog can show when it was taken.
  res.json({ ...db, meta: { ...db.meta, backupAt: Date.now(), backupVersion: BACKUP_VERSION } });
});

// Restore a backup file. Defaults to a merge so players who signed up after a
// data loss are not thrown away; the live DB is snapshotted first either way.
// Two ways in: a logged-in admin, OR anyone holding the backup file who can
// prove they know the admin password *inside that backup*. The second path is
// what makes a post-wipe restore painless — after a redeploy the fresh
// instance has a brand-new admin password nobody knows yet.
app.post('/api/admin/restore', (req, res) => {
  const body = req.body || {};
  const data = body.data || body;          // accept a bare dump or { data, mode }
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const check = validateBackup(data);
  if (!check.ok) return res.status(400).json({ error: check.error });

  // Authorisation, in three tiers.
  //
  // This endpoint is deliberately reachable without a session: the whole point
  // of /?restore=1 is to recover a server nobody can log into. But it used to
  // accept ANY uploaded file whose own admin hash matched the typed password —
  // and the attacker supplies that file, so they supply the hash too. Anyone
  // who could reach the URL could overwrite a live server with a forged dump.
  //
  //   1. a signed-in admin                          → always allowed
  //   2. the password of a LIVE admin account       → allowed
  //   3. the password of the FILE's admin           → only onto a server with
  //      no player data yet, and merge only. That is exactly the post-deploy
  //      wipe this flow exists for, and it is worthless to an attacker because
  //      there is nothing there to take over.
  let actor = req.user && req.user.role === 'admin' ? { username: req.user.username } : null;
  if (!actor) {
    if (!rateLimit(`restore:${req.ip}`, 10, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
    }
    const pw = String(body.password || '');
    if (!pw) return res.status(401).json({ error: '管理者パスワードを入力してください' });

    const liveAdmins = Object.values(db.users).filter(u => u.role === 'admin');
    const liveMatch = liveAdmins.find(u => verifyPassword(pw, u.salt, u.passHash));
    if (liveMatch) {
      actor = { username: liveMatch.username };
    } else {
      const fileAdmins = Object.values(data.users).filter(u => u.role === 'admin');
      const fileMatch = fileAdmins.find(u => verifyPassword(pw, u.salt, u.passHash));
      // `replace` destroys whatever is live. Doing that needs the CURRENT
      // password, not one supplied inside the file being uploaded.
      if (!fileMatch || mode !== 'merge') {
        console.warn(`[restore] 拒否: ip=${req.ip} mode=${mode} fileMatch=${!!fileMatch}`);
        return res.status(401).json({ error: !fileAdmins.length
          ? 'このバックアップに管理者アカウントが含まれていません'
          : mode !== 'merge'
            ? '置き換え復元には現在の管理者パスワードが必要です（マージ復元は可能です）'
            : 'バックアップ内の管理者パスワードが違います（バックアップを取った時点のパスワードを入力してください）' });
      }
      actor = { username: fileMatch.username, fromBackup: true };
      // The password that authorised this came out of the uploaded file, so the
      // uploader controls it — and therefore must not be able to hand
      // themselves staff. Anyone who is not ALREADY staff on this server comes
      // in as an ordinary player. Everything the recovery flow actually needs
      // (accounts, scores, seasons, the real admin who is already here) is
      // untouched; only role escalation is removed.
      const liveStaff = new Set(Object.values(db.users)
        .filter(u => u.role === 'admin' || u.role === 'mod')
        .map(u => u.username.toLowerCase()));
      let demoted = 0;
      for (const u of Object.values(data.users)) {
        if ((u.role === 'admin' || u.role === 'mod') && !liveStaff.has(String(u.username).toLowerCase())) {
          u.role = 'user';
          demoted++;
        }
      }
      if (demoted) console.warn(`[restore] バックアップ内の未知の管理者/モデレーター ${demoted}件を一般ユーザーとして取り込みました`);
    }
  }

  // Dry run: let the admin see what would happen before committing.
  if (body.dryRun) return res.json({ preview: check.stats, mode, actor: actor.username });

  const snap = snapshot(db, 'pre-restore');
  let report;
  try {
    report = applyRestore(db, data, mode);
  } catch (err) {
    console.error('[restore] failed:', err);
    return res.status(500).json({ error: '復元中にエラーが発生しました。変更は保存されていません' });
  }
  // Every restored account is brought up to the current schema right away.
  for (const u of Object.values(db.users)) migrateUser(u);
  // Battle passes minted under the old UUID-season scheme carry over, and the
  // restored world state (crowd scale, ambient config) takes effect now.
  adoptLegacySeason(data.season);
  db.season = null;
  setLiveScale(db.meta.popScale ?? 1);
  setCustom(db.meta.ambient);
  flushDb();
  console.log(`[restore] ${mode} by ${actor.username}${actor.fromBackup ? ' (backup password)' : ''}: +${report.added} 更新${report.updated} 維持${report.kept} → 合計${report.after}人`);
  battle.broadcastAll({
    type: 'announce',
    message: '💾 データを復元しました。ページを再読み込みすると反映されます',
    messageEn: '💾 Data restored — reload the page to see it',
    from: actor.username,
  });
  // Backup-password restores log the admin straight in with the restored account.
  let token = null, user = null;
  if (actor.fromBackup) {
    const u = Object.values(db.users).find(x => x.username === actor.username && x.role === 'admin');
    if (u) { token = issueToken(u.id); user = publicUser(u); }
  }
  res.json({ report, snapshot: snap, source: check.stats, token, user });
});

// Local snapshots (same instance only — they die with the filesystem too).
app.get('/api/admin/snapshots', requireAuth, requireAdmin, (_req, res) => {
  res.json({ snapshots: listSnapshots() });
});

app.post('/api/admin/snapshots/restore', requireAuth, requireAdmin, (req, res) => {
  const data = readSnapshot(String(req.body.name || ''));
  if (!data) return res.status(404).json({ error: 'スナップショットが見つかりません' });
  const check = validateBackup(data);
  if (!check.ok) return res.status(400).json({ error: check.error });
  snapshot(db, 'pre-rollback');
  const report = applyRestore(db, data, 'replace');
  for (const u of Object.values(db.users)) migrateUser(u);
  adoptLegacySeason(data.season);
  db.season = null;
  setLiveScale(db.meta.popScale ?? 1);
  setCustom(db.meta.ambient);
  flushDb();
  res.json({ report });
});

app.post('/api/admin/snapshots/create', requireAuth, requireAdmin, (_req, res) => {
  const name = snapshot(db, 'manual');
  if (!name) return res.status(500).json({ error: 'スナップショットの作成に失敗しました' });
  res.json({ name, snapshots: listSnapshots() });
});

// Maintenance mode: blocks play/shop/login for non-admins.
app.post('/api/admin/maintenance', requireAuth, requireAdmin, (req, res) => {
  db.meta.maintenance = !!req.body.on;
  saveDb();
  battle.broadcastAll({
    type: 'announce',
    message: db.meta.maintenance ? '🛠 まもなくメンテナンスを開始します' : '✅ メンテナンスが終了しました',
    messageEn: db.meta.maintenance ? '🛠 Maintenance is starting shortly' : '✅ Maintenance is over',
    from: req.user.username,
  });
  res.json({ maintenance: db.meta.maintenance });
});

app.post('/api/admin/broadcast', requireAuth, requireAdmin, async (req, res) => {
  const message = String(req.body.message || '').slice(0, 200);
  if (!message) return res.status(400).json({ error: 'メッセージが空です' });
  // /api/admin/news already auto-translates; a broadcast did not, so English
  // players got a raw Japanese banner. An explicit messageEn always wins.
  let messageEn = String(req.body.messageEn || '').slice(0, 200) || null;
  if (!messageEn) {
    try {
      const tr = await translateChat(message);
      if (tr && tr.lang === 'en' && tr.text) messageEn = tr.text;
    } catch { /* dictionary fallback failed — ship the original */ }
  }
  battle.broadcastAll({ type: 'announce', message, messageEn, from: req.user.username });
  res.json({ ok: true, delivered: battle.clients.size });
});

// ---------------------------------------------------------------------------
// Moderator API (mods + admins): chat policing tools only
// ---------------------------------------------------------------------------

app.get('/api/mod/users', requireAuth, requireMod, (_req, res) => {
  const users = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, role: u.role, muted: !!u.muted, banned: !!u.banned,
  }));
  res.json({ users });
});

app.post('/api/mod/mute', requireAuth, requireMod, (req, res) => {
  const target = db.users[String(req.body.id || '')];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin' || target.role === 'mod') {
    return res.status(400).json({ error: '運営メンバーはミュートできません' });
  }
  target.muted = !!req.body.muted;
  saveDb();
  res.json({ ok: true, muted: target.muted });
});

app.post('/api/mod/chat/clear', requireAuth, requireMod, (_req, res) => {
  battle.chatOps.clear();
  res.json({ ok: true });
});

// Gift coins/gems to every active (non-banned) account at once.
app.post('/api/admin/grant-all', requireAuth, requireAdmin, (req, res) => {
  const coins = Math.max(0, Math.min(1_000_000, Math.floor(Number(req.body.coins) || 0)));
  const gems = Math.max(0, Math.min(100_000, Math.floor(Number(req.body.gems) || 0)));
  if (!coins && !gems) return res.status(400).json({ error: 'コインかジェムを指定してください' });
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.banned) continue;
    u.coins += coins;
    u.gems += gems;
    affected++;
  }
  saveDb();
  const parts = [coins ? `${coins}🪙` : '', gems ? `${gems}💎` : ''].filter(Boolean).join(' ');
  battle.broadcastAll({
    type: 'announce',
    message: `🎁 運営から全員に ${parts} をプレゼント！（再ログインまたは画面更新で反映）`,
    messageEn: `🎁 A gift for everyone from the team: ${parts}! (relog or refresh to receive)`,
    from: req.user.username,
  });
  res.json({ ok: true, affected, coins, gems });
});

// Live crowd (にぎわい) control: scale, chattiness, custom names & lines.
// One-click crowd moods.
const CROWD_PRESETS = {
  off:    { scale: 0 },
  quiet:  { scale: 0.5, chatPace: 0.5, toggles: { ...DEFAULT_TOGGLES, dialogues: false, greetings: false }, quiet: null },
  normal: { scale: 1,   chatPace: 1,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  party:  { scale: 3,   chatPace: 2.5, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  fever:  { scale: 25,  chatPace: 3.5, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 住人が増え続ける上限は ×88（MAX_ROSTER）。それより上は表示人数だけが伸びる。
  mega:   { scale: 88,  chatPace: 4,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  ultra:  { scale: 500, chatPace: 4,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  night:  { scale: 0.7, chatPace: 0.75, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  silent: { scale: 1,   chatPace: 1,   toggles: { ...DEFAULT_TOGGLES, chat: false, dialogues: false, feed: false, greetings: false, reactions: false }, quiet: null },
};

function crowdStatus() {
  return {
    scale: getLiveScale(), ambient: getCustom(),
    online: battle.displayOnline(), activeMatches: battle.displayMatches(),
    mood: crowdMood(), activeResidents: battle.crowd.activeCount(), quietNow: isQuietNow(),
  };
}

app.post('/api/admin/pop', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.preset && CROWD_PRESETS[b.preset]) {
    const p = CROWD_PRESETS[b.preset];
    b.scale = p.scale;
    if (p.chatPace !== undefined) patch.chatPace = p.chatPace;
    if (p.toggles) patch.toggles = p.toggles;
    if (p.quiet !== undefined) patch.quiet = p.quiet;
  }
  if (b.scale !== undefined) {
    const scale = Math.max(0, Math.min(MAX_LIVE_SCALE, Number(b.scale)));
    if (!Number.isFinite(scale)) return res.status(400).json({ error: `0〜${MAX_LIVE_SCALE}の数値で指定してください` });
    db.meta.popScale = scale;
    setLiveScale(scale);
  }
  if (b.chatPace !== undefined) patch.chatPace = b.chatPace;
  if (Array.isArray(b.names)) patch.names = b.names;
  if (Array.isArray(b.lines)) patch.lines = b.lines;
  if (b.toggles && typeof b.toggles === 'object') patch.toggles = b.toggles;
  if (b.quiet !== undefined) patch.quiet = b.quiet;

  // Cast management.
  const cur = getCustom();
  if (typeof b.removeResident === 'string' && b.removeResident) {
    patch.removed = [...new Set([...cur.removed, b.removeResident])];
  }
  if (typeof b.restoreResident === 'string' && b.restoreResident) {
    patch.removed = (patch.removed || cur.removed).filter(id => id !== b.restoreResident);
  }
  if (b.addResident && typeof b.addResident.name === 'string') {
    const name = sanitizeName(b.addResident.name);
    if (name.length < 2) return res.status(400).json({ error: '住人の名前は2文字以上にしてください' });
    if (Object.values(db.users).some(u => u.username.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: '実在するプレイヤーと同じ名前は使えません' });
    }
    if (cur.extra.some(x => x.name === name)) return res.status(409).json({ error: 'その住人はすでにいます' });
    patch.extra = [...cur.extra, { name, arch: String(b.addResident.arch || 'casual'), lang: b.addResident.lang === 'en' ? 'en' : 'ja' }];
  }
  if (typeof b.removeExtra === 'string' && b.removeExtra) {
    patch.extra = (patch.extra || cur.extra).filter(x => x.name !== b.removeExtra);
  }
  if (b.reseed) {
    patch.rosterSeed = `v${Date.now().toString(36)}`;
    patch.removed = [];   // ids change meaning with a new roster
  }

  if (Object.keys(patch).length) {
    setCustom(patch);
    db.meta.ambient = getCustom();   // persist the sanitized version
  }
  saveDb();
  // Scale / ghost-toggle / roster changes alter throne ELIGIBILITY — recompute
  // now, or the 5s memo serves a stale champion map to the next request.
  refreshThrones(true);
  res.json(crowdStatus());
});

// The cast, with live stats, for the admin roster editor.
app.get('/api/admin/residents', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    residents: rosterView(),
    retired: retiredResidents(),
    archetypes: ARCHETYPES.map(a => ({ id: a.id, label: a.label, labelEn: a.labelEn })),
    status: crowdStatus(),
  });
});

// Fire one crowd action right now (admin preview).
app.post('/api/admin/crowd/test', requireAuth, requireAdmin, (req, res) => {
  const what = String(req.body.what || 'line');
  const out = battle.crowd.test(what);
  if (out.error) return res.status(409).json({ error: out.error });
  res.json(out);
});

// Wipe the global chat for everyone (history + connected clients).
app.post('/api/admin/chat/clear', requireAuth, requireAdmin, (_req, res) => {
  battle.chatOps.clear();
  res.json({ ok: true });
});

// Make an AI player speak (given text, or a random line when empty).
app.post('/api/admin/chat/say', requireAuth, requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  const entry = battle.chatOps.say(text || undefined);
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// Test tools: instantly finish the caller's own mission board / achievements.
app.post('/api/admin/missions/complete', requireAuth, requireAdmin, (req, res) => {
  migrateUser(req.user);
  const ms = syncMissions(req.user, currentWeekNum());
  for (const row of [...ms.daily, ...ms.weekly]) row.p = Number.MAX_SAFE_INTEGER;
  saveDb();
  res.json({ missions: missionsView(req.user, currentWeekNum()), user: publicUser(req.user) });
});

app.post('/api/admin/achievements/reset', requireAuth, requireAdmin, (req, res) => {
  migrateUser(req.user);
  req.user.achievements = [];
  saveDb();
  res.json({ achievements: achievementsView(req.user), user: publicUser(req.user) });
});

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users);
  res.json({
    totalUsers: users.length,
    bannedUsers: users.filter(u => u.banned).length,
    totalGames: users.reduce((a, u) => a + u.stats.gamesPlayed, 0),
    online: battle.clients.size,
    displayOnline: battle.displayOnline(),
    inQueue: battle.queueSize(),
    activeMatches: battle.matches.size,
    openRooms: battle.rooms.size,
    popScale: getLiveScale(),
    ambient: getCustom(),
    crowd: {
      mood: crowdMood(), activeResidents: battle.crowd.activeCount(),
      queueing: ambientQueue(), feedCount: battle.crowd.feedHistory().length, quietNow: isQuietNow(),
    },
    guilds: Object.keys(db.guilds).length,
    news: db.news.length,
    translate: TRANSLATE_ENGINE,
    maintenance: inMaintenance(),
    season: currentSeason(),
    sessionsPersist: SESSIONS_PERSIST,
  });
});

// ---------------------------------------------------------------------------
// WebSocket battles: matchmaking (1v1 / 2v2), custom rooms, server bots
// ---------------------------------------------------------------------------

const MATCH_DURATION = Number(process.env.MATCH_SECONDS) || 120;  // seconds

const server = http.createServer(app);
const battle = initBattle(server, {
  db, saveDb, applyGameResult, publicUser, levelOf, sanitizeName, userFromToken,
  MATCH_DURATION,
  isMaintenance: inMaintenance,
  guildTagOf: (name, user) => tagOfName(db, name, user),
  // AI-vote guild solidarity: ghost-guild tag only (never scans db.users).
  residentGuildTag: (name) => { const g = ghostGuildOfResident(name); return g ? g.tag : null; },
});

battleReady = true;

// The crowd reads the live event / open poll through this (no import cycle).
setWorldProvider(() => ({
  event: currentEvent(),
  poll: db.meta.poll && pollOpen(db.meta.poll) ? db.meta.poll : null,
  // 👑 王座保持者の名前 — 王者住人はチャットに常駐し、王者らしい発言をする
  thrones: Object.values(db.meta.thrones || {}).filter(Boolean).map(t => t.username),
}));

// ---------------------------------------------------------------------------
// Bootstrap: seed admin account, start server
// ---------------------------------------------------------------------------

const ADMIN_NAME = 'るみまき';

// With ADMIN_PASSWORD set (e.g. on Render), the admin password is pinned to it
// on every boot — it survives redeploys and data resets.
function pinAdminPassword() {
  const pinned = process.env.ADMIN_PASSWORD;
  if (!pinned || pinned.length < 8) {
    if (pinned) console.warn('[admin] ADMIN_PASSWORD は8文字以上にしてください（無視されました）');
    return;
  }
  const admin = Object.values(db.users).find(u => u.role === 'admin');
  if (!admin) return;
  const { salt, hash } = hashPassword(pinned);
  admin.salt = salt;
  admin.passHash = hash;
  saveDb();
  console.log(`[admin] 管理者パスワードを環境変数 ADMIN_PASSWORD に固定しました`);
}

// 管理者は「表示だけ全部持っている」状態だった: publicUser が owned を丸ごと
// 差し替え、バトルパスをプレミアム扱いで返すだけで、レコードの中身は空。
// そのためインベントリのように user.owned / badges / achievements を素直に
// 読む画面では何も出ない（見えているものが実在しない）。
// ここで実データとして全部持たせる。ランキングは元から管理者を除外している
// ので、統計を最大にしても順位表は汚れない。
function unlockEverythingForStaff() {
  const admins = Object.values(db.users).filter(u => u.role === 'admin');
  for (const u of admins) {
    migrateUser(u);
    const before = (u.owned || []).length + (u.badges || []).length;
    // ショップ・ガチャ限定・管理者専用まで全部
    u.owned = [...new Set([...(u.owned || []), ...SHOP_ITEMS.map(i => i.id)])];
    u.badges = [...new Set([...(u.badges || []), ...ADMIN_KNOWN_BADGES])];
    // 全実績を解除済みに（受け取り済みリストなので、進捗は統計側で満たす）
    u.achievements = [...new Set([...(u.achievements || []), ...ACHIEVEMENTS.map(a => a.id)])];
    // ブースターは無限のかわりに大量に持たせる（0だと使えない画面がある）
    u.items = u.items || {};
    for (const it of BOOST_ITEMS) u.items[it.id] = Math.max(u.items[it.id] || 0, 999);
    // 称号・実績・モード解放はすべて統計から導出されるので、そこを満たす。
    const s = u.stats;
    const atLeast = (k, v) => { if ((s[k] || 0) < v) s[k] = v; };
    atLeast('gamesPlayed', 500); atLeast('bestScore', 300000); atLeast('totalScore', 5000000);
    atLeast('totalLines', 20000); atLeast('maxCombo', 20); atLeast('rating', 1700);
    atLeast('pvpWins', 100); atLeast('winStreakBest', 10);
    atLeast('bossMax', BOSSES.length); atLeast('dungeonMax', 100); atLeast('abyssMax', 100);
    atLeast('survivalWave', 30); atLeast('puzzleStage', 60); atLeast('digDepth', 60);
    atLeast('loginStreakBest', 30); atLeast('sprintPlays', 50); atLeast('coopPlays', 20);
    atLeast('ultsUsed', 600); atLeast('itemsUsed', 600); atLeast('piecesPlaced', 30000);
    atLeast('gachaPulls', 100); atLeast('gachaSSR', 20); atLeast('ghostBest', 20000);
    atLeast('royalePlays', 50); atLeast('royaleTop10', 10); atLeast('royaleKills', 50);
    atLeast('royaleBestKills', 5); atLeast('aePlays', 20);
    // 残り9称号ぶんの条件（連勝・奥義500・ミッション300・協力2万点・
    // ギルド週2000pt・全ボスSランク・無限地獄深度12・チャット300回）
    atLeast('winStreak', 10); atLeast('missionsDone', 300); atLeast('coopBest', 30000);
    atLeast('guildBestWeek', 3000); atLeast('rushDepth', 20); atLeast('chatMessages', 300);
    if (!s.royaleBest || s.royaleBest > 1) s.royaleBest = 1;
    s.bossRanks = s.bossRanks || {};
    for (const b of BOSSES) s.bossRanks[b.id] = 'S';
    s.sprint = s.sprint || {};
    s.sprint.s60 = Math.max(s.sprint.s60 || 0, 20000);
    s.sprint.s180 = Math.max(s.sprint.s180 || 0, 60000);
    // バトルパスも実データとしてプレミアム＋最大XPに
    u.battlePass = u.battlePass || {};
    u.battlePass.premium = true;
    u.battlePass.xp = Math.max(u.battlePass.xp || 0, BP_TIERS.length * BP_XP_PER_TIER);
    const after = u.owned.length + u.badges.length;
    if (after !== before) {
      console.log(`[admin] ${u.username}: 所持品${u.owned.length}種・バッジ${u.badges.length}種・実績${u.achievements.length}件を解放`);
    }
  }
  if (admins.length) saveDb();
}

function seedAdmin() {
  // One-time migration: rename a legacy "admin" account to the new name.
  const legacy = Object.values(db.users).find(u => u.role === 'admin' && u.username === 'admin');
  if (legacy && !Object.values(db.users).some(u => u.username === ADMIN_NAME)) {
    legacy.username = ADMIN_NAME;
    saveDb();
    const credFile = path.join(DATA_DIR, 'admin-credentials.txt');
    try {
      const old = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
      fs.writeFileSync(credFile, old.replace(/username: .*/, `username: ${ADMIN_NAME}`));
    } catch { /* ignore */ }
    console.log(`[admin] 管理者アカウント名を「${ADMIN_NAME}」に変更しました（パスワードは変更なし）`);
  }
  const hasAdmin = Object.values(db.users).some(u => u.role === 'admin');
  if (hasAdmin) return;
  const password = crypto.randomBytes(9).toString('base64url');
  newUser(ADMIN_NAME, password, 'admin');
  const credFile = path.join(DATA_DIR, 'admin-credentials.txt');
  fs.writeFileSync(credFile, `username: ${ADMIN_NAME}\npassword: ${password}\n`);
  console.log('='.repeat(60));
  console.log('  管理者アカウントを作成しました');
  console.log(`  ユーザー名: ${ADMIN_NAME} / パスワード: ${password}`);
  console.log(`  (${credFile} にも保存済み)`);
  console.log('='.repeat(60));
}

// Seed backup — automatic self-heal on boot. The repo carries a recent
// production backup at server/seed-backup.json (refresh it with
// `npm run backup:pull` before pushing); a fresh post-deploy instance merges
// it in with no manual /?restore=1 step.
//
// SAFETY: a given seed file is applied AT MOST ONCE (its hash is remembered in
// db.meta.seedHash). Without that gate, a host whose disk survives restarts
// would re-merge the stale seed on every boot — refunding spent currency,
// reverting bans/password changes and resurrecting deleted accounts each time
// the process bounced. Re-pulling a fresh seed (new hash) applies again.
const SEED_BACKUP_FILE = process.env.SEED_BACKUP_FILE || path.join(__dirname, 'seed-backup.json');
function autoRestoreFromSeed() {
  if (process.env.SEED_RESTORE === '0') return;
  let data, seedHash;
  try {
    if (!fs.existsSync(SEED_BACKUP_FILE)) return;
    const rawBytes = fs.readFileSync(SEED_BACKUP_FILE);
    seedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    if (db.meta.seedHash === seedHash) return;   // this exact seed is already in
    data = JSON.parse(rawBytes.toString('utf8'));
  } catch (err) {
    console.warn('[seed] seed-backup.json を読み込めませんでした:', err.message);
    return;
  }
  // The repo is public, so the committed seed is encrypted with the admin
  // password (scripts/pull-backup.mjs). ADMIN_PASSWORD must match to open it.
  if (data && data.enc === 'aes-256-gcm') {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) {
      console.warn('[seed] seed-backup.json は暗号化されていますが ADMIN_PASSWORD 環境変数が未設定のため復元できません');
      return;
    }
    try {
      const salt = Buffer.from(data.salt, 'base64');
      const iv = Buffer.from(data.iv, 'base64');
      const key = crypto.scryptSync(pw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
      console.warn('[seed] seed-backup.json の復号に失敗しました（ADMIN_PASSWORD がバックアップ取得時と一致していません）');
      return;
    }
  }
  const check = validateBackup(data);
  if (!check.ok) { console.warn('[seed] seed-backup.json が不正です:', check.error); return; }
  try {
    // The instance's OWN stored legacy season must be adopted before the merge
    // can overwrite user records — and definitely before db.season is nulled.
    const adoptedLocal = adoptLegacySeason(db.season);
    const report = applyRestore(db, data, 'merge');
    for (const u of Object.values(db.users)) migrateUser(u);
    const adopted = adoptedLocal + adoptLegacySeason(data.season);
    db.season = null;   // stored seasons are legacy — everything derives from SEASON_EPOCH now
    db.meta.seedHash = seedHash;
    setLiveScale(db.meta.popScale ?? 1);
    setCustom(db.meta.ambient);
    // Synchronous write, not the debounced saveDb: if the process dies before
    // a debounced write lands (SIGTERM flush doesn't run on every platform),
    // the seedHash is lost and the next boot re-applies the whole seed.
    flushDb();
    console.log(`[seed] 同梱バックアップを自動復元: 追加${report.added} 更新${report.updated} 維持${report.kept} → 合計${report.after}人${adopted ? `（バトルパス引き継ぎ${adopted}件）` : ''}`);
  } catch (err) {
    console.error('[seed] 自動復元に失敗:', err.message);
  }
}

autoRestoreFromSeed();
const seasonAdopted = adoptLegacySeason(db.season);
if (db.season) { db.season = null; saveDb(); }
if (seasonAdopted) console.log(`[season] 旧シーズンIDからバトルパスを引き継ぎました（${seasonAdopted}件）`);
currentSeason();
seedAdmin();
pinAdminPassword();
unlockEverythingForStaff();
seedNews();
finalizeWeeklyRankings();   // pay out any week that ended while we were down
// 👑 Thrones exist from second zero (silent first computation), and the seeded
// chat history — built before the restore above — gets its crowns stamped.
refreshThrones();
battle.crowd.restampCrowns();
console.log(`[chat] 自動翻訳エンジン: ${TRANSLATE_ENGINE === 'api' ? '外部API (TRANSLATE_URL)' : '内蔵フレーズ辞書'}`);

// A boot snapshot means a bad restore is always one click away from undo.
if (Object.keys(db.users).length > 0) snapshot(db, 'boot');

// Unknown paths (shared links, typos) land on the game instead of an error.
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  res.status(404).json({ error: 'Not found' });
});

// Render free tier spins down after ~15min idle (50s cold start + the
// in-memory data dies with the instance). Pinging our own public URL
// keeps the instance warm. RENDER_EXTERNAL_URL is set by Render.
const KEEPALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
if (KEEPALIVE_URL) {
  setInterval(() => {
    fetch(`${KEEPALIVE_URL}/api/status`).catch(() => { /* transient — retry next tick */ });
  }, 10 * 60 * 1000);
  console.log(`[keepalive] ${KEEPALIVE_URL} を10分ごとにpingしてスリープを防止します`);
}

server.listen(PORT, () => {
  console.log(`Block Blitz Arena server: http://localhost:${PORT}`);
});

process.on('SIGINT', () => { flushDb(); process.exit(0); });
process.on('SIGTERM', () => { flushDb(); process.exit(0); });
