// Backup / restore + local snapshots.
//
// The hosting tier this game runs on has an ephemeral filesystem: a redeploy
// wipes server/data. The admin panel can download a backup before deploying
// and upload it again afterwards — this module validates and applies it.
//
// Restore defaults to MERGE, because players may have registered again in the
// window between the wipe and the restore; merging keeps both populations and,
// for a username that exists on both sides, keeps whichever record has more
// progress. `replace` is available when you really want the file to win.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db.js';

const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const KEEP_SNAPSHOTS = 12;

export const BACKUP_VERSION = 2;

// --- validation -----------------------------------------------------------

// Returns { ok: true, stats } or { ok: false, error }.
export function validateBackup(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'バックアップの形式が不正です' };
  if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
    return { ok: false, error: 'users が見つかりません（正しいバックアップファイルですか？）' };
  }
  const users = Object.values(data.users);
  if (users.length === 0) return { ok: false, error: 'ユーザーが0件です。安全のため復元を中止しました' };
  for (const u of users) {
    if (!u || typeof u !== 'object' || !u.id || !u.username || !u.passHash || !u.salt) {
      return { ok: false, error: 'ユーザーレコードが壊れています（id/username/パスワードハッシュが必要）' };
    }
  }
  return {
    ok: true,
    stats: {
      users: users.length,
      admins: users.filter(u => u.role === 'admin').length,
      tokens: data.tokens ? Object.keys(data.tokens).length : 0,
      transactions: Array.isArray(data.transactions) ? data.transactions.length : 0,
      savedAt: data.meta && data.meta.backupAt ? data.meta.backupAt : null,
    },
  };
}

// How "far along" a user record is — used to pick a winner on username clashes.
function progressOf(u) {
  const s = (u && u.stats) || {};
  return (s.gamesPlayed || 0) * 1e9
    + (s.totalScore || 0)
    + (u.coins || 0) + (u.gems || 0) * 10 + (u.xp || 0);
}

// Claimed achievements, badges, owned cosmetics, item counts and battle-pass
// progress are EARNED — the winner-takes-the-record merge must not un-earn
// them just because the other copy of the account had more raw progress.
// (This was why "アップデートのたびに実績をもう一度受け取り" happened whenever
// the losing side of a merge held the claimed list.)
// Known tradeoff: if the LOSING copy bought something, the winner keeps its
// own (pre-purchase) currency while the purchase is unioned in — a one-time
// windfall for that player. Acceptable: losing purchases outright is worse,
// and the boot-time seed merge only ever applies a given seed once.
function mergeEarned(winner, loser) {
  if (!winner || !loser) return;
  for (const k of ['achievements', 'badges', 'owned']) {
    const a = Array.isArray(winner[k]) ? winner[k] : (winner[k] = []);
    for (const v of (Array.isArray(loser[k]) ? loser[k] : [])) if (!a.includes(v)) a.push(v);
  }
  if (loser.items && typeof loser.items === 'object') {
    winner.items = winner.items || {};
    for (const [id, n] of Object.entries(loser.items)) {
      winner.items[id] = Math.max(winner.items[id] || 0, Number(n) || 0);
    }
  }
  const wb = winner.battlePass, lb = loser.battlePass;
  if (wb && lb && wb.season === lb.season) {
    wb.xp = Math.max(wb.xp || 0, lb.xp || 0);
    wb.premium = !!(wb.premium || lb.premium);
    wb.claimed = [...new Set([...(wb.claimed || []), ...(lb.claimed || [])])];
  }
}

// --- snapshots ------------------------------------------------------------

export function snapshot(db, label = 'auto') {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(SNAP_DIR, `${stamp}_${label}.json`);
    fs.writeFileSync(file, JSON.stringify(db));
    prune();
    return path.basename(file);
  } catch (err) {
    console.error('[backup] snapshot failed:', err.message);
    return null;
  }
}

function prune() {
  try {
    const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS))) {
      fs.unlinkSync(path.join(SNAP_DIR, f));
    }
  } catch { /* best effort */ }
}

export function listSnapshots() {
  try {
    return fs.readdirSync(SNAP_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(name => {
        const st = fs.statSync(path.join(SNAP_DIR, name));
        return { name, size: st.size, at: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

export function readSnapshot(name) {
  // Defend against path traversal — only plain file names from listSnapshots.
  if (!/^[\w.-]+\.json$/.test(name)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

// --- restore --------------------------------------------------------------

// Mutates `db` in place (db.js holds the same object reference).
// mode: 'merge' (default) | 'replace'
export function applyRestore(db, data, mode = 'merge') {
  const before = Object.keys(db.users || {}).length;
  const report = { mode, added: 0, updated: 0, kept: 0, tokens: 0, before, after: 0 };

  if (mode === 'replace') {
    db.users = data.users;
    db.tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
    if (data.season) db.season = data.season;
    if (Array.isArray(data.transactions)) db.transactions = data.transactions;
    if (data.guilds && typeof data.guilds === 'object') db.guilds = data.guilds;
    if (Array.isArray(data.news)) db.news = data.news;
    if (Array.isArray(data.bugreports)) db.bugreports = data.bugreports;
    if (data.revoked && typeof data.revoked === 'object') db.revoked = data.revoked;
    if (data.deleted && typeof data.deleted === 'object') db.deleted = data.deleted;
    if (data.meta && typeof data.meta === 'object') db.meta = { ...db.meta, ...data.meta };
    report.added = Object.keys(db.users).length;
    report.tokens = Object.keys(db.tokens).length;
    report.after = report.added;
    return report;
  }

  // ---- merge ----
  db.users = db.users || {};
  const byName = new Map();
  for (const u of Object.values(db.users)) byName.set(u.username.toLowerCase(), u);

  for (const inc of Object.values(data.users)) {
    // Tombstone: an account the operator deleted stays deleted — a stale
    // backup/seed must not resurrect it (db.deleted survives merges below).
    if (db.deleted && db.deleted[inc.id]) continue;
    const live = db.users[inc.id] || byName.get(inc.username.toLowerCase());
    if (!live) {
      db.users[inc.id] = inc;
      byName.set(inc.username.toLowerCase(), inc);
      report.added++;
      continue;
    }
    if (progressOf(inc) >= progressOf(live)) {
      // The backup is at least as far along (ties go to the backup — that is
      // the account everyone actually had, e.g. the real admin vs the one
      // re-seeded after a wipe). It wins AND keeps its own id: every session
      // signed before the wipe references that id, so logins come straight
      // back. Only the few sessions issued in the wipe→restore window lose.
      mergeEarned(inc, live);
      // Moderation and credentials are OPERATOR state, not player progress —
      // they must not roll back just because the backup copy had more score.
      // A newer sessionsSince marks newer credentials (password changes bump
      // it); bans/mutes are unioned (an unbanned-then-restored account may be
      // re-banned once — far safer than a ban silently reverting).
      if ((live.sessionsSince || 0) > (inc.sessionsSince || 0)) {
        inc.passHash = live.passHash;
        inc.salt = live.salt;
        inc.sessionsSince = live.sessionsSince;
      }
      if (live.banned) inc.banned = true;
      if (live.muted) inc.muted = true;
      delete db.users[live.id];
      db.users[inc.id] = inc;
      byName.set(inc.username.toLowerCase(), inc);
      for (const [tk, rec] of Object.entries(db.tokens || {})) {
        if (rec && rec.userId === live.id) delete db.tokens[tk];
      }
      report.updated++;
    } else {
      mergeEarned(live, inc);
      report.kept++;
    }
  }

  // Tokens: union, dropping any that no longer point at a real user.
  db.tokens = db.tokens || {};
  if (data.tokens && typeof data.tokens === 'object') {
    for (const [tk, rec] of Object.entries(data.tokens)) {
      if (rec && db.users[rec.userId] && !db.tokens[tk]) db.tokens[tk] = rec;
    }
  }
  for (const [tk, rec] of Object.entries(db.tokens)) {
    if (!rec || !db.users[rec.userId]) delete db.tokens[tk];
  }
  report.tokens = Object.keys(db.tokens).length;

  // Session bookkeeping: logged-out tokens stay logged out, deleted accounts
  // stay deleted, even across a wipe. Guilds come back by id (live wins a
  // clash); news is unioned by id.
  for (const key of ['revoked', 'deleted', 'guilds']) {
    if (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) {
      db[key] = { ...(data[key]), ...(db[key] || {}) };
    }
  }
  if (Array.isArray(data.news)) {
    db.news = db.news || [];
    const seen = new Set(db.news.map(n => n && n.id));
    // Identical title+body means the same announcement even under a different
    // random id (seedNews used to mint fresh UUIDs every boot — without this,
    // the four launch posts multiplied on every wipe→restore cycle).
    const seenBody = new Set(db.news.map(n => n && `${n.title}${n.body}`));
    for (const n of data.news) {
      if (!n || !n.id || seen.has(n.id)) continue;
      const key = `${n.title}${n.body}`;
      if (seenBody.has(key)) continue;
      db.news.push(n);
      seen.add(n.id);
      seenBody.add(key);
    }
  }

  // db.meta: a fresh post-deploy instance holds only trivial meta — adopt the
  // backup's world state (event, poll+votes, crowd scale/config, maintenance,
  // season override) for every key the live side hasn't set since boot.
  if (data.meta && typeof data.meta === 'object') {
    db.meta = db.meta || {};
    for (const k of ['event', 'poll', 'popScale', 'ambient', 'maintenance', 'seasonOverride', 'createdAt']) {
      if (db.meta[k] == null && data.meta[k] != null) db.meta[k] = data.meta[k];
    }
    // Weekly payouts: an empty post-deploy boot may have stamped the current
    // week with nobody in it. Clearing the stamp lets finalizeWeeklyRankings
    // re-run for the restored users (per-record `rewarded` flags keep it safe).
    delete db.meta.lastRankRewardWeek;
  }
  // Members' guild pointers must agree with the guild roster after a merge.
  if (db.guilds) {
    const memberOf = {};
    for (const g of Object.values(db.guilds)) for (const id of g.members || []) memberOf[id] = g.id;
    for (const u of Object.values(db.users)) {
      if (u.guildId && !db.guilds[u.guildId]) u.guildId = memberOf[u.id] || null;
      else if (!u.guildId && memberOf[u.id]) u.guildId = memberOf[u.id];
    }
  }

  // Purchase history is append-only: union by transaction id.
  if (Array.isArray(data.transactions)) {
    db.transactions = db.transactions || [];
    const seen = new Set(db.transactions.map(t => t && t.id).filter(Boolean));
    for (const t of data.transactions) {
      if (t && t.id && !seen.has(t.id)) { db.transactions.push(t); seen.add(t.id); }
    }
  }

  // Bug reports: union by id so player reports survive a wipe too.
  if (Array.isArray(data.bugreports)) {
    db.bugreports = db.bugreports || [];
    const seen = new Set(db.bugreports.map(b => b && b.id).filter(Boolean));
    for (const b of data.bugreports) {
      if (b && b.id && !seen.has(b.id)) { db.bugreports.push(b); seen.add(b.id); }
    }
  }

  report.after = Object.keys(db.users).length;
  return report;
}

export { SNAP_DIR };
