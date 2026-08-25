// Run from the repo root:  node test/persist.test.mjs  (needs a free port 3103)
// v2.6 不滅アップデート: the season derives from a fixed epoch (identical across
// wipes), legacy UUID battle passes carry over, merge restores meta + earned
// fields, and an encrypted seed backup auto-restores on boot.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3103;
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-persist-test');
const SEED_FILE = path.join(os.tmpdir(), 'bba-persist-seed.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};

let proc = null;
async function start(extraEnv = {}) {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'persist-test-secret-key', SEED_RESTORE: '0', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
const wipeDb = () => {
  fs.rmSync(path.join(DIR, 'db.json'), { force: true });
  fs.rmSync(path.join(DIR, 'snapshots'), { recursive: true, force: true });
};

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(SEED_FILE, { force: true });

  // ---- 1. deterministic season: identical across a full wipe ----
  await start();
  const reg = await j('/api/register', { method: 'POST', body: { username: 'テスト太郎', password: 'pass1234' } });
  check('register works', reg.status === 200 && !!reg.token);
  const season1 = (await j('/api/me', {}, reg.token)).season;
  check('season id is deterministic form s<n>', /^s\d+$/.test(season1.id), season1.id);
  check('season is a 30-day window containing now', season1.endsAt - season1.startedAt === 30 * 86400000 && season1.endsAt > Date.now() && season1.startedAt <= Date.now());
  await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 30000, lines: 25, maxCombo: 5, duration: 120 } }, reg.token);
  const meBp = (await j('/api/me', {}, reg.token)).user.battlePass;
  check('battle pass gained xp on the derived season', meBp.season === season1.id && meBp.xp > 0, `xp=${meBp.xp}`);

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const adminTok = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  const backup = await j('/api/admin/backup', {}, adminTok);
  check('backup includes meta + no stored season needed', !!backup.meta, JSON.stringify(Object.keys(backup)));

  await stop();
  wipeDb();
  await start();
  const reg2 = await j('/api/register', { method: 'POST', body: { username: '別人', password: 'pass1234' } });
  const season2 = (await j('/api/me', {}, reg2.token)).season;
  check('SEASON SURVIVED the wipe: same id/number/endsAt', season2.id === season1.id && season2.number === season1.number && season2.endsAt === season1.endsAt, `${season1.id}→${season2.id}`);

  // ---- 2. merge restore keeps earned fields + battle pass xp ----
  // Live 別人 already exists; backup's テスト太郎 comes back with bp xp intact.
  const edited = JSON.parse(JSON.stringify(backup));
  delete edited.status;
  const taroId = Object.keys(edited.users).find(id => edited.users[id].username === 'テスト太郎');
  edited.users[taroId].achievements = ['ach_play1'];
  edited.users[taroId].badges = ['oni'];
  edited.meta.popScale = 3;
  const rs = await j('/api/admin/restore', { method: 'POST', body: { data: edited, mode: 'merge', password: adminPw } });
  check('merge restore ok', rs.status === 200, JSON.stringify(rs.report || rs));
  const relog = await j('/api/login', { method: 'POST', body: { username: 'テスト太郎', password: 'pass1234' } });
  check('restored user logs in', relog.status === 200);
  const taro = relog.user;
  check('claimed achievements survived restore', (taro.achievements || []).includes('ach_play1'), JSON.stringify(taro.achievements));
  check('badges survived restore', (taro.badges || []).includes('oni'));
  check('battle pass xp survived restore (no reset)', taro.battlePass.season === season1.id && taro.battlePass.xp > 0, `season=${taro.battlePass.season} xp=${taro.battlePass.xp}`);

  // ---- 3. legacy UUID season adopts into the derived season ----
  await stop();
  const dbFile = path.join(DIR, 'db.json');
  const raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const legacyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  raw.season = { id: legacyId, number: 42, name: '旧シーズン', startedAt: Date.now() - 86400000, endsAt: Date.now() + 10 * 86400000 };
  for (const u of Object.values(raw.users)) {
    if (u.username === 'テスト太郎') { u.battlePass.season = legacyId; u.battlePass.xp = 777; }
  }
  fs.writeFileSync(dbFile, JSON.stringify(raw));
  const adoptLog = await start();
  const relog2 = await j('/api/login', { method: 'POST', body: { username: 'テスト太郎', password: 'pass1234' } });
  check('legacy UUID battle pass adopted (xp kept)', relog2.user.battlePass.season === season1.id && relog2.user.battlePass.xp === 777, `season=${relog2.user.battlePass.season} xp=${relog2.user.battlePass.xp}`);
  check('boot log mentions adoption', adoptLog.includes('バトルパスを引き継ぎ'), '');

  // ---- 4. encrypted seed backup auto-restores on a fresh boot ----
  await stop();
  const seedPw = 'seed-admin-pw-1234';
  { // encrypt the edited backup exactly like scripts/pull-backup.mjs
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(seedPw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(edited), 'utf8'), cipher.final()]);
    fs.writeFileSync(SEED_FILE, JSON.stringify({
      v: 1, enc: 'aes-256-gcm', kdf: 'scrypt-n15',
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64'),
    }));
  }
  wipeDb();
  const seedLog = await start({ SEED_RESTORE: '1', SEED_BACKUP_FILE: SEED_FILE, ADMIN_PASSWORD: seedPw });
  check('boot auto-restored the seed', seedLog.includes('自動復元'), seedLog.split('\n').find(l => l.includes('seed')) || '');
  const relog3 = await j('/api/login', { method: 'POST', body: { username: 'テスト太郎', password: 'pass1234' } });
  check('seed-restored user logs in with achievements intact', relog3.status === 200 && (relog3.user.achievements || []).includes('ach_play1'), JSON.stringify(relog3.user && relog3.user.achievements));
  check('seed restore adopted crowd scale from meta', seedLog.includes('自動復元'), '');

  // wrong password → no restore, but boot still succeeds
  await stop();
  wipeDb();
  const badLog = await start({ SEED_RESTORE: '1', SEED_BACKUP_FILE: SEED_FILE, ADMIN_PASSWORD: 'wrong-password-99' });
  check('wrong ADMIN_PASSWORD → warns, boots empty', badLog.includes('復号に失敗'), '');
  const ghost = await j('/api/login', { method: 'POST', body: { username: 'テスト太郎', password: 'pass1234' } });
  check('…and nothing was restored', ghost.status === 401);
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(SEED_FILE, { force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
