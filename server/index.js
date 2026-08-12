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
  hashPassword, verifyPassword, issueToken, revokeToken,
  authMiddleware, requireAuth, requireAdmin, userFromToken,
} from './auth.js';
import {
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED, BOOST_ITEMS,
  BP_TIERS, BP_XP_PER_TIER, BP_PREMIUM_PRICE_GEMS, BP_SEASON_DAYS,
  BOSSES, TITLES, earnedTitles, GEM_PACKS,
} from './catalog.js';
import { ghostRows, setLiveScale, getLiveScale } from './ambient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const db = loadDb();
setLiveScale(db.meta.popScale === undefined ? 1 : db.meta.popScale);
const app = express();
app.set('trust proxy', 1);
app.use(compression());   // gzip — big win for overseas players on slow links
app.use(express.json({
  limit: '64kb',
  // Keep the raw body for Stripe webhook signature verification.
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
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
    stats: { gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0, aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000, bossMax: 0 },
    owned: [...DEFAULT_OWNED],
    items: { item_bomb: 1, item_cleaner: 1, item_fever: 1 },   // starter boosters
    equipped: { ...DEFAULT_EQUIPPED },
    equippedTitle: null,
    battlePass: { season: currentSeason().id, xp: 0, premium: false, claimed: [] },
    badges: [],
    lastDaily: new Date().toISOString().slice(0, 10),
  };
  db.users[id] = user;
  saveDb();
  return user;
}

function levelOf(xp) { return 1 + Math.floor(xp / 1000); }

function currentSeason() {
  if (!db.season || db.season.endsAt < Date.now()) {
    const number = db.season ? db.season.number + 1 : 1;
    db.season = {
      id: crypto.randomUUID(),
      number,
      name: `シーズン ${number}`,
      startedAt: Date.now(),
      endsAt: Date.now() + BP_SEASON_DAYS * 24 * 60 * 60 * 1000,
    };
    saveDb();
  }
  return db.season;
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
  syncBattlePass(user);
  return {
    id: user.id, username: user.username, role: user.role, banned: user.banned,
    coins: user.coins, gems: user.gems, xp: user.xp, level: levelOf(user.xp),
    stats: user.stats, owned: user.owned, equipped: user.equipped,
    items: user.items || {},
    battlePass: user.battlePass, badges: user.badges,
    equippedTitle: user.equippedTitle || null,
  };
}

// Sanity-check and apply a finished game's rewards. Returns the reward summary.
function applyGameResult(user, { mode, score, lines, maxCombo, duration, won, drew, bossId, floor }) {
  const extraBossId = typeof bossId === 'string' ? bossId : null;
  score = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
  lines = Math.max(0, Math.min(5000, Math.floor(Number(lines) || 0)));
  maxCombo = Math.max(0, Math.min(200, Math.floor(Number(maxCombo) || 0)));
  duration = Math.max(1, Math.min(7200, Number(duration) || 1));
  // Cheat guard: cap plausible score rate.
  if (score > duration * 500) score = Math.floor(duration * 500);

  let coins = Math.min(1000, 20 + Math.floor(score / 100) + (won ? 50 : 0));
  if (mode === 'chaos') coins = Math.min(1500, Math.round(coins * 1.5));   // event bonus
  const bpXp = Math.min(800, 30 + Math.floor(score / 60) + lines * 5 + (won ? 100 : 0));
  const accXp = Math.min(600, 20 + Math.floor(score / 100) + (won ? 80 : 0));

  user.coins += coins;
  user.xp += accXp;
  syncBattlePass(user);
  user.battlePass.xp = Math.min(BP_TIERS.length * BP_XP_PER_TIER, user.battlePass.xp + bpXp);

  const s = user.stats;
  s.gamesPlayed += 1;
  s.totalScore += score;
  s.totalLines += lines;
  if (score > s.bestScore) s.bestScore = score;
  if (maxCombo > s.maxCombo) s.maxCombo = maxCombo;
  let badge = null;
  let gems = 0;
  // Ranked-duel win streak: bonus coins that grow with the streak.
  let streakBonus = 0;
  if (mode === 'pvp') {
    if (won) {
      s.winStreak = (s.winStreak || 0) + 1;
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
  // Weekly challenge: per-week personal best.
  if (mode === 'weekly') {
    const w = weekIdOf(currentWeekNum());
    if (!s.weekly || s.weekly.week !== w) s.weekly = { week: w, best: 0 };
    if (score > s.weekly.best) s.weekly.best = score;
  }
  // Dungeon tower: track highest floor cleared; gems for each newly reached
  // checkpoint decade, badge + big gem bonus for conquering all 100 floors.
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
  // Boss battles: sequential progression + first-clear gem bonus.
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
    }
  }
  saveDb();
  return { coins, bpXp, accXp, score, badge, gems, streak: s.winStreak || 0, streakBonus };
}

// Simple in-memory rate limiter (per key, sliding window).
const rateMap = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { rateMap.set(key, arr); return false; }
  arr.push(now);
  rateMap.set(key, arr);
  return true;
}

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
function grantDaily(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.lastDaily === today) return null;
  user.lastDaily = today;
  user.coins += DAILY_COINS;
  user.gems += DAILY_GEMS;
  saveDb();
  return { coins: DAILY_COINS, gems: DAILY_GEMS };
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

  const user = newUser(username, password);
  const token = issueToken(user.id);
  res.json({ token, user: publicUser(user) });
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
  delete db.users[user.id];
  for (const [t, rec] of Object.entries(db.tokens)) {
    if (rec.userId === user.id) delete db.tokens[t];
  }
  saveDb();
  res.json({ ok: true });
});

// Limited-time event (admin-controlled), e.g. chaos mode.
function currentEvent() {
  const e = db.meta.event;
  if (e && e.endsAt > Date.now()) return e;
  return null;
}

// Public lightweight status (menu online counter + event).
app.get('/api/status', (_req, res) => {
  res.json({
    online: battle.displayOnline(),
    activeMatches: battle.displayMatches(),
    maintenance: inMaintenance(),
    event: currentEvent(),
  });
});

// Wipe everyone's weekly-challenge record (fresh week on demand).
app.post('/api/admin/weekly/reset', requireAuth, requireAdmin, (req, res) => {
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.stats && u.stats.weekly) { delete u.stats.weekly; affected++; }
  }
  saveDb();
  res.json({ affected });
});

// Start / stop a limited-time event.
app.post('/api/admin/event', requireAuth, requireAdmin, (req, res) => {
  if (req.body.on) {
    // Duration in minutes (1 min .. 14 days). Legacy clients may still send hours.
    const rawMinutes = Number(req.body.minutes);
    const legacyHours = Number(req.body.hours);
    const minutes = Math.max(1, Math.min(24 * 14 * 60, Math.floor(
      Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes
        : Number.isFinite(legacyHours) && legacyHours > 0 ? legacyHours * 60
        : 24 * 60)));
    db.meta.event = {
      id: 'chaos',
      name: sanitizeName(req.body.name) || 'カオスタイム',
      startedAt: Date.now(),
      endsAt: Date.now() + minutes * 60 * 1000,
    };
    battle.broadcastAll({ type: 'announce', message: `🌪️ 期間限定イベント「${db.meta.event.name}」開催中！メニューから参加しよう！`, from: req.user.username });
  } else {
    db.meta.event = null;
    battle.broadcastAll({ type: 'announce', message: '🌪️ 期間限定イベントは終了しました。また次回！', from: req.user.username });
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
// Game results & leaderboard
// ---------------------------------------------------------------------------

app.post('/api/game/result', requireAuth, maintenanceGuard, (req, res) => {
  const rewards = applyGameResult(req.user, req.body || {});
  res.json({ rewards, user: publicUser(req.user) });
});

app.get('/api/leaderboard', (req, res) => {
  const board = ['rating', 'dungeon', 'weekly'].includes(req.query.board) ? req.query.board : 'score';
  const week = weekIdOf(currentWeekNum());
  const weeklyBestOf = u => (u.stats.weekly && u.stats.weekly.week === week ? u.stats.weekly.best : 0);
  // Admins are excluded from public rankings.
  let users = Object.values(db.users).filter(u => !u.banned && u.role !== 'admin' && u.stats.gamesPlayed > 0);
  if (board === 'dungeon') users = users.filter(u => (u.stats.dungeonMax || 0) > 0);
  if (board === 'weekly') users = users.filter(u => weeklyBestOf(u) > 0);
  const titleOf = u => {
    const t = TITLES.find(x => x.id === u.equippedTitle);
    return t ? { name: t.name, color: t.color } : null;
  };
  const realRows = users.map(u => ({
    username: u.username,
    level: levelOf(u.xp),
    bestScore: u.stats.bestScore,
    rating: u.stats.rating,
    pvpWins: u.stats.pvpWins,
    pvpLosses: u.stats.pvpLosses,
    dungeonMax: u.stats.dungeonMax || 0,
    weeklyBest: weeklyBestOf(u),
    badges: u.badges,
    title: titleOf(u),
  }));
  // Ghost players pad the boards so rankings feel populated (weekly reshuffle).
  const taken = new Set(Object.values(db.users).map(u => u.username));
  const rows = realRows
    .concat(ghostRows(board, week, taken))
    .sort((a, b) => board === 'rating' ? b.rating - a.rating
      : board === 'dungeon' ? b.dungeonMax - a.dungeonMax
      : board === 'weekly' ? b.weeklyBest - a.weeklyBest
      : b.bestScore - a.bestScore)
    .slice(0, 100);
  res.json({ board, rows });
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
  res.json({
    bosses: BOSSES,
    bossMax: req.user ? (req.user.stats.bossMax || 0) : 0,
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
  // Admin-exclusive cosmetics are invisible to everyone else.
  const isAdmin = req.user && req.user.role === 'admin';
  res.json({ items: SHOP_ITEMS.filter(i => !i.adminOnly || isAdmin), boosters: BOOST_ITEMS });
});

// ---- Booster items (consumables) ----

app.post('/api/items/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = BOOST_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  const count = Math.max(1, Math.min(10, Math.floor(Number(req.body.count) || 1)));
  const cost = item.price * count;
  const user = req.user;
  if (user.coins < cost) return res.status(402).json({ error: 'コインが足りません' });
  user.coins -= cost;
  user.items = user.items || {};
  user.items[item.id] = (user.items[item.id] || 0) + count;
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/items/use', requireAuth, (req, res) => {
  const user = req.user;
  user.items = user.items || {};
  const id = String(req.body.itemId || '');
  if (!BOOST_ITEMS.some(i => i.id === id)) return res.status(404).json({ error: 'アイテムが見つかりません' });
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

function gachaPull(user) {
  const roll = Math.random() * 100;
  if (roll < 50) {   // N: coins
    const amount = 150 + Math.floor(Math.random() * 6) * 50;
    user.coins += amount;
    return { type: 'coins', amount, rarity: 'N' };
  }
  if (roll < 72) {   // R: booster item
    const it = BOOST_ITEMS[Math.floor(Math.random() * BOOST_ITEMS.length)];
    user.items[it.id] = (user.items[it.id] || 0) + 1;
    return { type: 'item', id: it.id, name: it.name, icon: it.icon, rarity: 'R' };
  }
  if (roll < 87) {   // SR: gems
    const amount = 15 + Math.floor(Math.random() * 6) * 5;
    user.gems += amount;
    return { type: 'gems', amount, rarity: 'SR' };
  }
  if (roll < 97) {   // SSR: unowned cosmetic (or big gems when complete)
    const unowned = SHOP_ITEMS.filter(i => !i.default && !user.owned.includes(i.id));
    if (unowned.length === 0) {
      user.gems += 50;
      return { type: 'gems', amount: 50, rarity: 'SSR', complete: true };
    }
    const it = unowned[Math.floor(Math.random() * unowned.length)];
    user.owned.push(it.id);
    return { type: 'cosmetic', id: it.id, name: it.name, cat: it.cat, rarity: 'SSR' };
  }
  // UR: jackpot gems
  user.gems += 150;
  return { type: 'gems', amount: 150, rarity: 'UR' };
}

app.post('/api/gacha', requireAuth, maintenanceGuard, (req, res) => {
  const count = Number(req.body.count) === 10 ? 10 : 1;
  const cost = count === 10 ? GACHA_COST_10 : GACHA_COST_1;
  const user = req.user;
  if (user.coins < cost) return res.status(402).json({ error: `コインが足りません（${fmtNum(cost)}必要）` });
  user.coins -= cost;
  user.items = user.items || {};
  const results = Array.from({ length: count }, () => gachaPull(user));
  saveDb();
  res.json({ results, user: publicUser(user) });
});

function fmtNum(n) { return n.toLocaleString('ja-JP'); }

app.post('/api/shop/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = SHOP_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用の装備です（非売品）' });
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
  if (!['skin', 'board', 'fx'].includes(slot)) return res.status(400).json({ error: '不正なスロットです' });
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item || item.cat !== slot) return res.status(400).json({ error: '不正なアイテムです' });
  // Admin-only gear: admins implicitly own it; nobody else can equip it.
  if (item.adminOnly) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '管理者専用の装備です' });
  } else if (!req.user.owned.includes(itemId)) {
    return res.status(403).json({ error: '所持していないアイテムです' });
  }
  req.user.equipped[slot] = itemId;
  saveDb();
  res.json({ user: publicUser(req.user) });
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

app.post('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const b = req.body || {};
  if (typeof b.grantCoins === 'number') target.coins = Math.max(0, target.coins + Math.floor(b.grantCoins));
  if (typeof b.grantGems === 'number') target.gems = Math.max(0, target.gems + Math.floor(b.grantGems));
  if (typeof b.grantItems === 'number') {
    // grant N of every booster (negative to confiscate)
    const n = Math.floor(b.grantItems);
    target.items = target.items || {};
    for (const it of BOOST_ITEMS) target.items[it.id] = Math.max(0, (target.items[it.id] || 0) + n);
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
    for (const [tk, rec] of Object.entries(db.tokens)) {
      if (rec.userId === target.id) delete db.tokens[tk];
    }
  }
  const KNOWN_BADGES = ['bronze', 'silver', 'gold', 'oni', 'kami', 'souzou', 'maou', 'rush', 'dungeon', 'tourney'];
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
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin') return res.status(400).json({ error: '管理者は削除できません' });
  delete db.users[req.params.id];
  for (const [t, rec] of Object.entries(db.tokens)) {
    if (rec.userId === req.params.id) delete db.tokens[t];
  }
  saveDb();
  res.json({ ok: true });
});

app.post('/api/admin/season/new', requireAuth, requireAdmin, (req, res) => {
  const number = db.season ? db.season.number + 1 : 1;
  db.season = {
    id: crypto.randomUUID(),
    number,
    name: sanitizeName(req.body.name) || `シーズン ${number}`,
    startedAt: Date.now(),
    endsAt: Date.now() + BP_SEASON_DAYS * 24 * 60 * 60 * 1000,
  };
  saveDb();
  res.json({ season: db.season });
});

// Change the current season — supports reverting the number/name WITHOUT
// resetting everyone's battle pass progress (keepProgress, default true).
app.post('/api/admin/season/set', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const number = Math.max(1, Math.min(999, Math.floor(Number(b.number) || (db.season ? db.season.number : 1))));
  const name = sanitizeName(b.name) || `シーズン ${number}`;
  const days = Math.max(1, Math.min(365, Math.floor(Number(b.days) || 0)));
  const keepProgress = b.keepProgress !== false;

  if (keepProgress && db.season) {
    db.season.number = number;
    db.season.name = name;
    if (b.days) db.season.endsAt = Date.now() + days * 24 * 60 * 60 * 1000;
  } else {
    db.season = {
      id: crypto.randomUUID(),
      number, name,
      startedAt: Date.now(),
      endsAt: Date.now() + (b.days ? days : BP_SEASON_DAYS) * 24 * 60 * 60 * 1000,
    };
  }
  saveDb();
  res.json({ season: db.season, progressKept: keepProgress });
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
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="block-blitz-backup-${stamp}.json"`);
  res.json(db);
});

// Maintenance mode: blocks play/shop/login for non-admins.
app.post('/api/admin/maintenance', requireAuth, requireAdmin, (req, res) => {
  db.meta.maintenance = !!req.body.on;
  saveDb();
  battle.broadcastAll({
    type: 'announce',
    message: db.meta.maintenance ? '🛠 まもなくメンテナンスを開始します' : '✅ メンテナンスが終了しました',
    from: req.user.username,
  });
  res.json({ maintenance: db.meta.maintenance });
});

app.post('/api/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
  const message = String(req.body.message || '').slice(0, 200);
  if (!message) return res.status(400).json({ error: 'メッセージが空です' });
  battle.broadcastAll({ type: 'announce', message, from: req.user.username });
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
    from: req.user.username,
  });
  res.json({ ok: true, affected, coins, gems });
});

// Live crowd (にぎわい) control: scales AI population/chat/ghost rankings.
app.post('/api/admin/pop', requireAuth, requireAdmin, (req, res) => {
  const scale = Math.max(0, Math.min(10, Number(req.body.scale)));
  if (!Number.isFinite(scale)) return res.status(400).json({ error: '0〜10の数値で指定してください' });
  db.meta.popScale = scale;
  setLiveScale(scale);
  saveDb();
  res.json({ scale: getLiveScale(), online: battle.displayOnline(), activeMatches: battle.displayMatches() });
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
    maintenance: inMaintenance(),
    season: currentSeason(),
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
});

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

currentSeason();
seedAdmin();
pinAdminPassword();

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
