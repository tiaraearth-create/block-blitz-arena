// Block Blitz Arena — game server
// Express REST API (auth / leaderboard / shop / battle pass / admin) + WebSocket 1v1 battles.
import express from 'express';
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
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED,
  BP_TIERS, BP_XP_PER_TIER, BP_PREMIUM_PRICE_GEMS, BP_SEASON_DAYS,
  BOSSES, TITLES, earnedTitles, GEM_PACKS,
} from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const db = loadDb();
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(authMiddleware);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  // Always revalidate (ETag 304) so client updates ship immediately.
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
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
    battlePass: user.battlePass, badges: user.badges,
    equippedTitle: user.equippedTitle || null,
  };
}

// Sanity-check and apply a finished game's rewards. Returns the reward summary.
function applyGameResult(user, { mode, score, lines, maxCombo, duration, won, bossId }) {
  const extraBossId = typeof bossId === 'string' ? bossId : null;
  score = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
  lines = Math.max(0, Math.min(5000, Math.floor(Number(lines) || 0)));
  maxCombo = Math.max(0, Math.min(200, Math.floor(Number(maxCombo) || 0)));
  duration = Math.max(1, Math.min(7200, Number(duration) || 1));
  // Cheat guard: cap plausible score rate.
  if (score > duration * 500) score = Math.floor(duration * 500);

  const coins = Math.min(1000, 20 + Math.floor(score / 100) + (won ? 50 : 0));
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
  if (mode.startsWith('ai') && won) s.aiWins += 1;
  if (mode === 'ai_oni' && won && !user.badges.includes('oni')) {
    user.badges.push('oni');
    badge = 'oni';
  }
  if (mode === 'ai_kami' && won && !user.badges.includes('kami')) {
    user.badges.push('kami');
    badge = 'kami';
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
  return { coins, bpXp, accXp, score, badge, gems };
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

// Public lightweight status (menu online counter).
app.get('/api/status', (_req, res) => {
  res.json({
    online: battle.clients.size,
    activeMatches: battle.matches.size,
    maintenance: inMaintenance(),
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
  const board = req.query.board === 'rating' ? 'rating' : 'score';
  // Admins are excluded from public rankings.
  const users = Object.values(db.users).filter(u => !u.banned && u.role !== 'admin' && u.stats.gamesPlayed > 0);
  const titleOf = u => {
    const t = TITLES.find(x => x.id === u.equippedTitle);
    return t ? { name: t.name, color: t.color } : null;
  };
  const rows = users
    .map(u => ({
      username: u.username,
      level: levelOf(u.xp),
      bestScore: u.stats.bestScore,
      rating: u.stats.rating,
      pvpWins: u.stats.pvpWins,
      pvpLosses: u.stats.pvpLosses,
      badges: u.badges,
      title: titleOf(u),
    }))
    .sort((a, b) => board === 'rating' ? b.rating - a.rating : b.bestScore - a.bestScore)
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

app.get('/api/gempacks', (_req, res) => {
  res.json({ packs: GEM_PACKS });
});

app.post('/api/purchase', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`buy:${req.user.id}`, 30, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '購入リクエストが多すぎます' });
  }
  const pack = GEM_PACKS.find(p => p.id === req.body.packId);
  if (!pack) return res.status(404).json({ error: 'パックが見つかりません' });
  // DEMO gateway: in production, verify a real PSP session (e.g. Stripe
  // Checkout webhook) BEFORE granting gems. Never trust the client alone.
  const total = pack.gems + pack.bonus;
  req.user.gems += total;
  db.transactions.push({
    id: crypto.randomUUID(),
    userId: req.user.id,
    username: req.user.username,
    packId: pack.id,
    gems: total,
    jpy: pack.priceJpy,
    status: 'demo_completed',
    at: Date.now(),
  });
  saveDb();
  res.json({ user: publicUser(req.user), granted: total, demo: true });
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
  res.json({ items: SHOP_ITEMS });
});

app.post('/api/shop/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = SHOP_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
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
  if (!req.user.owned.includes(itemId)) return res.status(403).json({ error: '所持していないアイテムです' });
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
    id: u.id, username: u.username, role: u.role, banned: u.banned,
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
  if (typeof b.banned === 'boolean') {
    if (target.role === 'admin' && b.banned) return res.status(400).json({ error: '管理者は凍結できません' });
    target.banned = b.banned;
  }
  if (b.role === 'admin' || b.role === 'user') target.role = b.role;
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

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users);
  res.json({
    totalUsers: users.length,
    bannedUsers: users.filter(u => u.banned).length,
    totalGames: users.reduce((a, u) => a + u.stats.gamesPlayed, 0),
    online: battle.clients.size,
    inQueue: battle.queueSize(),
    activeMatches: battle.matches.size,
    openRooms: battle.rooms.size,
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

server.listen(PORT, () => {
  console.log(`Block Blitz Arena server: http://localhost:${PORT}`);
});

process.on('SIGINT', () => { flushDb(); process.exit(0); });
process.on('SIGTERM', () => { flushDb(); process.exit(0); });
