// Block Blitz Arena — game server
// Express REST API (auth / leaderboard / shop / battle pass / admin) + WebSocket 1v1 battles.
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { loadDb, saveDb, flushDb, DATA_DIR } from './db.js';
import {
  hashPassword, verifyPassword, issueToken, revokeToken,
  authMiddleware, requireAuth, requireAdmin, userFromToken,
} from './auth.js';
import {
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED,
  BP_TIERS, BP_XP_PER_TIER, BP_PREMIUM_PRICE_GEMS, BP_SEASON_DAYS,
} from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const db = loadDb();
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

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
    stats: { gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0, aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000 },
    owned: [...DEFAULT_OWNED],
    equipped: { ...DEFAULT_EQUIPPED },
    battlePass: { season: currentSeason().id, xp: 0, premium: false, claimed: [] },
    badges: [],
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
  };
}

// Sanity-check and apply a finished game's rewards. Returns the reward summary.
function applyGameResult(user, { mode, score, lines, maxCombo, duration, won }) {
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
  if (mode === 'ai' && won) s.aiWins += 1;
  saveDb();
  return { coins, bpXp, accXp, score };
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 16).replace(/[<>"'`]/g, '');
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

app.post('/api/register', (req, res) => {
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
  const username = sanitizeName(req.body.username);
  const password = String(req.body.password || '');
  const user = Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.salt, user.passHash)) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  if (user.banned) return res.status(403).json({ error: 'このアカウントは凍結されています' });
  const token = issueToken(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  revokeToken(req.token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(req.user), season: currentSeason() });
});

// ---------------------------------------------------------------------------
// Game results & leaderboard
// ---------------------------------------------------------------------------

app.post('/api/game/result', requireAuth, (req, res) => {
  const rewards = applyGameResult(req.user, req.body || {});
  res.json({ rewards, user: publicUser(req.user) });
});

app.get('/api/leaderboard', (req, res) => {
  const board = req.query.board === 'rating' ? 'rating' : 'score';
  const users = Object.values(db.users).filter(u => !u.banned && u.stats.gamesPlayed > 0);
  const rows = users
    .map(u => ({
      username: u.username,
      level: levelOf(u.xp),
      bestScore: u.stats.bestScore,
      rating: u.stats.rating,
      pvpWins: u.stats.pvpWins,
      pvpLosses: u.stats.pvpLosses,
      badges: u.badges,
    }))
    .sort((a, b) => board === 'rating' ? b.rating - a.rating : b.bestScore - a.bestScore)
    .slice(0, 100);
  res.json({ board, rows });
});

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

app.get('/api/shop', (req, res) => {
  res.json({ items: SHOP_ITEMS });
});

app.post('/api/shop/buy', requireAuth, (req, res) => {
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

app.post('/api/battlepass/premium', requireAuth, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  if (bp.premium) return res.status(409).json({ error: 'すでにプレミアムです' });
  if (user.gems < BP_PREMIUM_PRICE_GEMS) return res.status(402).json({ error: 'ジェムが足りません' });
  user.gems -= BP_PREMIUM_PRICE_GEMS;
  bp.premium = true;
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/battlepass/claim', requireAuth, (req, res) => {
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

app.post('/api/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
  const message = String(req.body.message || '').slice(0, 200);
  if (!message) return res.status(400).json({ error: 'メッセージが空です' });
  broadcastAll({ type: 'announce', message, from: req.user.username });
  res.json({ ok: true, delivered: clients.size });
});

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users);
  res.json({
    totalUsers: users.length,
    bannedUsers: users.filter(u => u.banned).length,
    totalGames: users.reduce((a, u) => a + u.stats.gamesPlayed, 0),
    online: clients.size,
    inQueue: queue.length,
    activeMatches: matches.size,
    season: currentSeason(),
  });
});

// ---------------------------------------------------------------------------
// WebSocket: matchmaking + 1v1 battle relay
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();       // all connected sockets
let queue = [];                  // sockets waiting for a match
const matches = new Map();       // matchId -> match state

const MATCH_DURATION = Number(process.env.MATCH_SECONDS) || 120;  // seconds

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastAll(msg) {
  for (const ws of clients) send(ws, msg);
}

function eloUpdate(ra, rb, scoreA /* 1 win, 0.5 draw, 0 loss */) {
  const K = 32;
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(K * (scoreA - ea));
}

function endMatch(match, reason = 'finished') {
  if (match.ended) return;
  match.ended = true;
  clearTimeout(match.timer);
  matches.delete(match.id);

  const [a, b] = match.players;
  const sa = match.scores[0] ?? 0;
  const sb = match.scores[1] ?? 0;
  let resultA = 0.5;
  if (reason === 'forfeit_a') resultA = 0;
  else if (reason === 'forfeit_b') resultA = 1;
  else resultA = sa > sb ? 1 : sa < sb ? 0 : 0.5;

  const results = [
    { ws: a, myScore: sa, oppScore: sb, outcome: resultA },
    { ws: b, myScore: sb, oppScore: sa, outcome: 1 - resultA },
  ];

  for (const r of results) {
    let ratingDelta = 0;
    let rewards = null;
    const me = r.ws.user ? db.users[r.ws.user.id] : null;
    const oppUser = (r.ws === a ? b : a).user;
    const opp = oppUser ? db.users[oppUser.id] : null;
    if (me) {
      if (opp) {
        ratingDelta = eloUpdate(me.stats.rating, opp.stats.rating, r.outcome);
        me.stats.rating = Math.max(0, me.stats.rating + ratingDelta);
      }
      if (r.outcome === 1) me.stats.pvpWins += 1;
      else if (r.outcome === 0) me.stats.pvpLosses += 1;
      rewards = applyGameResult(me, {
        mode: 'pvp', score: r.myScore, lines: r.ws.matchLines || 0,
        maxCombo: r.ws.matchMaxCombo || 0, duration: MATCH_DURATION, won: r.outcome === 1,
      });
    }
    send(r.ws, {
      type: 'result',
      outcome: r.outcome === 1 ? 'win' : r.outcome === 0 ? 'lose' : 'draw',
      reason,
      myScore: r.myScore, oppScore: r.oppScore,
      ratingDelta, rewards,
      user: me ? publicUser(me) : null,
    });
    r.ws.matchId = null;
  }
  saveDb();
}

function tryMatch() {
  // Drop dead sockets from the queue first.
  queue = queue.filter(ws => ws.readyState === ws.OPEN);
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const id = crypto.randomUUID();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const match = {
      id, players: [a, b], scores: [null, null], finished: [false, false],
      seed, startedAt: Date.now(), ended: false,
    };
    matches.set(id, match);
    a.matchId = id; b.matchId = id;
    a.matchLines = 0; b.matchLines = 0;
    a.matchMaxCombo = 0; b.matchMaxCombo = 0;

    const info = ws => ({
      name: ws.user ? ws.user.username : ws.guestName,
      level: ws.user ? levelOf(db.users[ws.user.id].xp) : 1,
      rating: ws.user ? db.users[ws.user.id].stats.rating : null,
      equipped: ws.user ? db.users[ws.user.id].equipped : { ...DEFAULT_EQUIPPED },
    });
    send(a, { type: 'match_found', matchId: id, seed, duration: MATCH_DURATION, countdown: 3, opponent: info(b) });
    send(b, { type: 'match_found', matchId: id, seed, duration: MATCH_DURATION, countdown: 3, opponent: info(a) });

    // Hard timeout: countdown + duration + grace.
    match.timer = setTimeout(() => endMatch(match, 'timeout'), (3 + MATCH_DURATION + 10) * 1000);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const match = ws.matchId ? matches.get(ws.matchId) : null;

    switch (msg.type) {
      case 'hello': {
        const user = userFromToken(msg.token);
        if (user && user.banned) { send(ws, { type: 'error', error: 'アカウントが凍結されています' }); ws.close(); return; }
        ws.user = user ? { id: user.id, username: user.username } : null;
        ws.guestName = user ? null : (sanitizeName(msg.guestName) || `ゲスト${Math.floor(Math.random() * 9999)}`);
        send(ws, { type: 'hello_ok', name: user ? user.username : ws.guestName, online: clients.size });
        break;
      }
      case 'queue': {
        if (ws.matchId || queue.includes(ws)) return;
        queue.push(ws);
        send(ws, { type: 'queued', position: queue.length });
        tryMatch();
        break;
      }
      case 'cancel_queue': {
        queue = queue.filter(s => s !== ws);
        send(ws, { type: 'queue_cancelled' });
        break;
      }
      case 'state': {
        if (!match || match.ended) return;
        const idx = match.players.indexOf(ws);
        if (idx === -1) return;
        ws.matchLines = Math.max(0, Math.floor(Number(msg.lines) || 0));
        ws.matchMaxCombo = Math.max(ws.matchMaxCombo || 0, Math.floor(Number(msg.combo) || 0));
        const opp = match.players[1 - idx];
        send(opp, {
          type: 'opp_state',
          score: Math.max(0, Math.floor(Number(msg.score) || 0)),
          combo: Math.floor(Number(msg.combo) || 0),
          grid: Array.isArray(msg.grid) ? msg.grid.slice(0, 64) : null,
        });
        break;
      }
      case 'finish': {
        if (!match || match.ended) return;
        const idx = match.players.indexOf(ws);
        if (idx === -1) return;
        match.scores[idx] = Math.max(0, Math.min(1_000_000, Math.floor(Number(msg.score) || 0)));
        match.finished[idx] = true;
        if (match.finished[0] && match.finished[1]) endMatch(match, 'finished');
        break;
      }
      case 'ping': send(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    queue = queue.filter(s => s !== ws);
    const match = ws.matchId ? matches.get(ws.matchId) : null;
    if (match && !match.ended) {
      const idx = match.players.indexOf(ws);
      endMatch(match, idx === 0 ? 'forfeit_a' : 'forfeit_b');
    }
  });
});

// Heartbeat: drop dead connections.
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

// ---------------------------------------------------------------------------
// Bootstrap: seed admin account, start server
// ---------------------------------------------------------------------------

function seedAdmin() {
  const hasAdmin = Object.values(db.users).some(u => u.role === 'admin');
  if (hasAdmin) return;
  const password = crypto.randomBytes(9).toString('base64url');
  newUser('admin', password, 'admin');
  const credFile = path.join(DATA_DIR, 'admin-credentials.txt');
  fs.writeFileSync(credFile, `username: admin\npassword: ${password}\n`);
  console.log('='.repeat(60));
  console.log('  管理者アカウントを作成しました');
  console.log(`  ユーザー名: admin / パスワード: ${password}`);
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
