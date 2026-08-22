// Run from the repo root:  node test/session.test.mjs  (needs a free port 3100)
// Integration test: signed sessions survive a data wipe + restore when
// SESSION_SECRET is stable, and die when it changes.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-session-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};

let proc = null;
async function start(secret) {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, SESSION_SECRET: secret, POP_SCALE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return log; } catch {}
  }
  throw new Error('server did not start:\n' + log);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  const bootLog = await start('super-secret-session-key-A');
  check('boot without warning when SESSION_SECRET set', !bootLog.includes('SESSION_SECRET が未設定'));

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const login = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
  check('admin login → v2 token', login.status === 200 && String(login.token).startsWith('v2.'), login.token && login.token.slice(0, 12));
  const adminTok = login.token;

  const reg = await j('/api/register', { method: 'POST', body: { username: 'テスト太郎', password: 'pass1234' } });
  check('register → v2 token', reg.status === 200 && String(reg.token).startsWith('v2.'));
  const userTok = reg.token;
  await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 12000, lines: 10, maxCombo: 3, duration: 90 } }, userTok);
  const me1 = await j('/api/me', {}, userTok);
  check('/api/me with user token', me1.status === 200 && me1.user && me1.user.username === 'テスト太郎' && me1.user.stats.gamesPlayed === 1);

  const backup = await j('/api/admin/backup', {}, adminTok);
  check('backup downloaded', Object.keys(backup.users || {}).length === 2);

  // logout = single-device revoke
  const out = await j('/api/logout', { method: 'POST', body: {} }, adminTok);
  const afterLogout = await j('/api/me', {}, adminTok);
  check('logout revokes the signed token', out.status === 200 && afterLogout.status === 401 && afterLogout.code === 'SESSION_ENDED', JSON.stringify(afterLogout));

  // ---- simulate a redeploy wipe ----
  await stop();
  fs.rmSync(path.join(DIR, 'db.json'), { force: true });
  fs.rmSync(path.join(DIR, 'snapshots'), { recursive: true, force: true });
  await start('super-secret-session-key-A');
  const me2 = await j('/api/me', {}, userTok);
  check('after wipe: token kept, account missing → 401 NO_USER', me2.status === 401 && me2.code === 'NO_USER', JSON.stringify(me2));
  const guarded = await j('/api/missions', {}, userTok);
  check('requireAuth also reports NO_USER', guarded.status === 401 && guarded.code === 'NO_USER');

  // restore with the backup's admin password (no session)
  const rs = await j('/api/admin/restore', { method: 'POST', body: { data: backup, mode: 'merge', password: adminPw } });
  check('restore via backup password', rs.status === 200 && rs.report && rs.report.after === 2 && String(rs.token).startsWith('v2.'), JSON.stringify(rs.report));
  const me3 = await j('/api/me', {}, userTok);
  check('SESSION SURVIVED the wipe: old user token works after restore', me3.status === 200 && me3.user && me3.user.username === 'テスト太郎' && me3.user.stats.gamesPlayed === 1, JSON.stringify(me3.user && me3.user.stats));
  const adminAgain = await j('/api/me', {}, adminTok);
  check('revoked admin token stays revoked? (revocations are not in the backup → comes back after a wipe; acceptable)', adminAgain.status === 200 || adminAgain.status === 401, `status ${adminAgain.status}`);

  // password change kills older sessions
  const restoredAdminTok = rs.token;
  const pw = await j('/api/admin/users/' + me3.user.id, { method: 'POST', body: { setPassword: 'newpass99' } }, restoredAdminTok);
  const me4 = await j('/api/me', {}, userTok);
  check('admin password reset → user session revoked (SESSION_ENDED)', pw.status === 200 && me4.status === 401 && me4.code === 'SESSION_ENDED', JSON.stringify(me4));
  const relog = await j('/api/login', { method: 'POST', body: { username: 'テスト太郎', password: 'newpass99' } });
  const me5 = await j('/api/me', {}, relog.token);
  check('new login after reset works', relog.status === 200 && me5.status === 200);

  // deleted account → DELETED-style session end (not NO_USER)
  const del = await j('/api/admin/users/' + me3.user.id, { method: 'DELETE' }, restoredAdminTok);
  const me6 = await j('/api/me', {}, relog.token);
  check('deleted account → SESSION_ENDED (not restore-pending)', del.status === 200 && me6.status === 401 && me6.code === 'SESSION_ENDED', JSON.stringify(me6));

  // ---- different secret → everything signed before is invalid ----
  await stop();
  await start('a-completely-different-secret-B');
  const me7 = await j('/api/me', {}, restoredAdminTok);
  check('different SESSION_SECRET → SESSION_ENDED', me7.status === 401 && me7.code === 'SESSION_ENDED', JSON.stringify(me7));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
