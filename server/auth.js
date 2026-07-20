// Authentication: pbkdf2 password hashing + random bearer tokens.
import crypto from 'crypto';
import { loadDb, saveDb } from './db.js';

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function issueToken(userId) {
  const db = loadDb();
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens[token] = { userId, createdAt: Date.now() };
  // prune expired tokens occasionally
  const now = Date.now();
  for (const [t, rec] of Object.entries(db.tokens)) {
    if (now - rec.createdAt > TOKEN_TTL) delete db.tokens[t];
  }
  saveDb();
  return token;
}

export function revokeToken(token) {
  const db = loadDb();
  delete db.tokens[token];
  saveDb();
}

export function userFromToken(token) {
  if (!token) return null;
  const db = loadDb();
  const rec = db.tokens[token];
  if (!rec) return null;
  if (Date.now() - rec.createdAt > TOKEN_TTL) { delete db.tokens[token]; saveDb(); return null; }
  return db.users[rec.userId] || null;
}

// Express middleware: attaches req.user (or null).
export function authMiddleware(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.user = userFromToken(token);
  req.token = token;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です' });
  if (req.user.banned) return res.status(403).json({ error: 'このアカウントは凍結されています' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  next();
}
