// Authentication: pbkdf2 password hashing + signed bearer tokens.
//
// Tokens are *stateless* ("v2"): `v2.<userId>.<issuedAt>.<hmac>` signed with
// SESSION_SECRET. Nothing about a session needs to live in the database, so a
// redeploy that wipes server/data does not log anyone out — as long as the
// same SESSION_SECRET is set in the environment. Without it a random secret
// is generated per boot and sessions die with the process (the old behaviour).
//
// Revocation still needs a little state: single-device logout adds the token
// to db.revoked; password changes bump user.sessionsSince so every token
// issued before that moment is refused. Legacy random tokens (db.tokens, from
// older builds and restored backups) keep working as before.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadDb, saveDb, DATA_DIR } from './db.js';

const LEGACY_TTL = 1000 * 60 * 60 * 24 * 180;  // 180 days (sliding — refreshed on use)
const LEGACY_REFRESH_AFTER = 1000 * 60 * 60 * 24; // bump createdAt at most daily
const V2_TTL = 1000 * 60 * 60 * 24 * 365;       // a year; players re-login yearly

// Secret source, in order: SESSION_SECRET env (survives everything) → a file
// in the data directory (survives restarts; dies with an ephemeral disk) →
// a per-boot random value (sessions die on restart).
function loadSecret() {
  const env = String(process.env.SESSION_SECRET || '');
  if (env.length >= 16) return { secret: env, source: 'env' };
  const file = path.join(DATA_DIR, 'session-secret.txt');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return { secret: s, source: 'file' };
  } catch { /* not yet */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, s + '\n');
    return { secret: s, source: 'file' };
  } catch {
    return { secret: s, source: 'boot' };
  }
}
const { secret: SECRET, source: SECRET_SOURCE } = loadSecret();
export const SESSIONS_PERSIST = SECRET_SOURCE === 'env';
if (SECRET_SOURCE === 'file') {
  // 環境変数が「設定されているが16文字未満で無視された」場合と「未設定」を取り違えない。
  // pinAdminPassword が長さ不足を明示するのと同じ扱い（さもないと運営が env を確認しても
  // 設定済みに見え、なぜ再デプロイでセッションが飛ぶのか切り分けられない）。
  const envRaw = String(process.env.SESSION_SECRET || '');
  if (envRaw.length > 0 && envRaw.length < 16) {
    console.warn(`[auth] SESSION_SECRET が短すぎます（${envRaw.length}文字／16文字以上が必要）。無視して server/data/session-secret.txt の鍵を使用中（再起動では維持、永続ディスクのないホストでは再デプロイで消えます）。`
      + ' 16文字以上に直して再デプロイすると再デプロイ後もログイン状態が維持されます');
  } else {
    console.warn('[auth] SESSION_SECRET 未設定のため server/data/session-secret.txt の鍵を使用中（再起動では維持、永続ディスクのないホストでは再デプロイで消えます）。'
      + ' 環境変数 SESSION_SECRET を設定すると再デプロイ後もログイン状態が維持されます');
  }
} else if (SECRET_SOURCE === 'boot') {
  console.warn('[auth] セッション鍵を保存できません: ログイン状態は再起動で失われます。環境変数 SESSION_SECRET を設定してください');
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  // アップロードされたバックアップやスキーマの古いレコードには、salt や
  // passHash が壊れているものが混ざりうる。以前はそこで例外が飛び、
  // 「パスワードが違う」ではなく 500 になっていた（pbkdf2Sync は salt が
  // 文字列でないと落ち、timingSafeEqual は長さが違うと落ちる）。
  if (typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
  const expected = Buffer.from(expectedHash, 'hex');
  if (expected.length !== 32) return false;
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected);
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueToken(userId) {
  const payload = `${userId}.${Date.now()}`;
  return `v2.${payload}.${sign(payload)}`;
}

// Verify a v2 token's signature and age. Returns { userId, createdAt } or null.
export function parseToken(token) {
  if (typeof token !== 'string' || !token.startsWith('v2.')) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [, userId, createdAtStr, sig] = parts;
  const expected = sign(`${userId}.${createdAtStr}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const createdAt = Number(createdAtStr);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > V2_TTL) return null;
  return { userId, createdAt };
}

// ログアウト済みトークン表の掃除。
//
// 以前は revokeToken の中でしか走らなかったので、誰もログアウトしない期間は
// 1件も減らなかった。トークンは1件あたり JSON で約115バイトあり、db.json は
// 保存のたびに全体を書き直すので、溜まったぶんはそのまま毎回の保存コストになる。
// 落とすのは次の3つ:
//   ・年（V2_TTL）を越えたもの
//   ・署名が壊れている／期限切れで parseToken が受け付けないもの
//   ・パスワード変更などで user.sessionsSince が立ち、この行が無くても
//     resolveToken が 'revoked' を返すようになったもの
// 持ち主のレコードが見つからない行は **残す**（ディスクが飛んで復元待ちの窓で
// 消すと、復元後にログアウト済みのはずのトークンが生き返る ── 迷ったら閉じる側）。
// db を渡すと saveDb はしない（呼び出し側がまとめて保存する）。
export function sweepRevoked(dbIn) {
  const db = dbIn || loadDb();
  if (!db.revoked || typeof db.revoked !== 'object') return 0;
  const cutoff = Date.now() - V2_TTL;
  let removed = 0;
  for (const [t, at] of Object.entries(db.revoked)) {
    let drop = !(Number(at) > cutoff);
    if (!drop) {
      const v2 = parseToken(t);
      if (!v2) drop = true;
      else {
        const u = db.users && db.users[v2.userId];
        if (u && u.sessionsSince && v2.createdAt < u.sessionsSince) drop = true;
      }
    }
    if (drop) { delete db.revoked[t]; removed++; }
  }
  if (removed && !dbIn) saveDb();
  return removed;
}

// Single-device logout.
export function revokeToken(token) {
  if (!token) return;
  const db = loadDb();
  if (token.startsWith('v2.')) {
    db.revoked = db.revoked || {};
    db.revoked[token] = Date.now();
    sweepRevoked(db);
  } else {
    delete db.tokens[token];
  }
  saveDb();
}

// Every session of one user (password change, admin reset, account deletion).
export function revokeAllTokens(userId) {
  const db = loadDb();
  for (const [t, rec] of Object.entries(db.tokens)) {
    if (rec.userId === userId) delete db.tokens[t];
  }
  const u = db.users[userId];
  if (u) u.sessionsSince = Date.now();
  saveDb();
}

// Resolve a bearer token.
//   ok       — req.user set
//   none     — no token presented
//   missing  — valid signature but the account is not in the database
//              (typically: data wiped by a redeploy, restore pending)
//   deleted  — the account was deleted on purpose
//   revoked  — logged out / password changed
//   invalid  — bad signature, expired, or unknown legacy token
export function resolveToken(token) {
  if (!token) return { user: null, status: 'none' };
  const db = loadDb();
  const v2 = parseToken(token);
  if (v2) {
    if (db.revoked && db.revoked[token]) return { user: null, status: 'revoked' };
    const user = db.users[v2.userId];
    if (!user) return { user: null, status: db.deleted && db.deleted[v2.userId] ? 'deleted' : 'missing' };
    if (user.sessionsSince && v2.createdAt < user.sessionsSince) return { user: null, status: 'revoked' };
    return { user, status: 'ok' };
  }
  if (token.startsWith('v2.')) return { user: null, status: 'invalid' };

  // Legacy random tokens.
  const rec = db.tokens[token];
  if (!rec) return { user: null, status: 'invalid' };
  if (Date.now() - rec.createdAt > LEGACY_TTL) { delete db.tokens[token]; saveDb(); return { user: null, status: 'invalid' }; }
  if (Date.now() - rec.createdAt > LEGACY_REFRESH_AFTER) {
    rec.createdAt = Date.now();
    saveDb();
  }
  const user = db.users[rec.userId];
  return user ? { user, status: 'ok' } : { user: null, status: 'missing' };
}

export function userFromToken(token) {
  return resolveToken(token).user;
}

// Express middleware: attaches req.user (or null) and req.tokenStatus.
export function authMiddleware(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const r = resolveToken(token);
  req.user = r.user;
  req.token = token;
  req.tokenStatus = r.status;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.tokenStatus === 'missing') {
      return res.status(401).json({ error: 'アカウントのデータが見つかりません（データ復元待ち）', code: 'NO_USER' });
    }
    return res.status(401).json({ error: 'ログインが必要です', code: req.token ? 'SESSION_ENDED' : 'NO_TOKEN' });
  }
  if (req.user.banned) return res.status(403).json({ error: 'このアカウントは凍結されています' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  next();
}
