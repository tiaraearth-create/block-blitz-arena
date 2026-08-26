// Run from the repo root:  node test/restore-auth.test.mjs
//
// /api/admin/restore の認可を固定する。
//
// なぜこのテストがあるか:
// この口は「再デプロイでデータが飛び、誰もログインできなくなったサーバーを
// 復旧する」ために、わざと未認証で叩けるようにしてある。認可は3段階:
//   1. ログイン済みの管理者                     → 常に許可
//   2. 生きている管理者アカウントのパスワード   → 許可
//   3. アップロードしたファイル内の管理者パスワード
//        → 「まだプレイヤーが1人も居ないサーバー」に対する merge のみ
//
// 第3層のパスワードは**アップロードする側がファイルごと用意できる**ので、
// 条件を1つでも緩めると「誰でも通る認証」になる。実際、第3層の
// 「まだ誰も居ないサーバー限定」という条件はコメントに書かれているだけで
// 実装されておらず、稼働中の本番に対して未認証の1リクエストで
// 管理者アカウントを奪える状態だった。
//
// 攻撃の形（監査で実際に再現されたもの）:
//   管理者名は公開情報なので、その名前・role:'admin'・攻撃者自身のパスワード
//   ハッシュ・巨大な stats（マージの勝敗は進行度で決まる）・巨大な
//   sessionsSince（資格情報の保護判定を無効化する）を持つ偽レコードを作り、
//   自分で決めたパスワードを添えて投げるだけ。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { freePort } from './_port.mjs';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-restore-auth-${PORT}`);
const ADMIN_PW = 'adminSecret123';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, SESSION_SECRET: 'restore-auth-test-secret',
      ADMIN_PASSWORD: ADMIN_PW, SEED_RESTORE: '0', POP_SCALE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました:\n${log}`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return log; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした:\n' + log);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  if (p.exitCode !== null || p.signalCode !== null) return;
  await new Promise(res => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} done(); }, 5000);
    p.once('exit', done);
    p.kill();
  });
}

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch { /* 本文なし */ }
  return { status: r.status, d };
}

// 任意のパスワードに対する salt/passHash を作る（攻撃者にもできること）
function creds(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passHash: crypto.pbkdf2Sync(pw, salt, 120000, 32, 'sha256').toString('hex') };
}
const user = (id, username, pw, extra = {}) => ({
  id, username, role: 'user', ...creds(pw), coins: 0, gems: 0, xp: 0,
  stats: { gamesPlayed: 1, totalScore: 1 }, ...extra,
});

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // ================= 稼働中のサーバー（守るべきものがある） =================
  await api('/api/register', { method: 'POST', body: { username: '常連プレイヤー', password: 'player-pass-1' } });
  const pre = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: ADMIN_PW } });
  check('前提: 本物の管理者でログインできる', pre.status === 200 && pre.d.token, `HTTP ${pre.status}`);

  // --- 攻撃1: 管理者名を騙る偽レコードで乗っ取りを試みる ---
  const forged = {
    users: {
      'attacker-forged-id': {
        id: 'attacker-forged-id', username: 'るみまき', role: 'admin', ...creds('attacker123'),
        sessionsSince: 9999999999999,            // 資格情報の保護判定をすり抜ける狙い
        coins: 0, gems: 0, xp: 0,
        stats: { gamesPlayed: 1000000000, totalScore: 0 },   // マージの勝敗を取る狙い
      },
    },
  };
  const atk = await api('/api/admin/restore', {
    method: 'POST', body: { mode: 'merge', password: 'attacker123', data: forged },
  });
  check('稼働中サーバーへの未認証 merge 復元は拒否される', atk.status === 401, `HTTP ${atk.status}`);
  check('管理者トークンを返さない', !atk.d.token, atk.d.token ? '返してしまった' : '');

  const asAttacker = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: 'attacker123' } });
  check('攻撃者のパスワードで管理者になれない', asAttacker.status !== 200, `HTTP ${asAttacker.status}`);
  const asReal = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: ADMIN_PW } });
  check('本物の管理者パスワードが壊されていない', asReal.status === 200, `HTTP ${asReal.status}`);
  const asPlayer = await api('/api/login', { method: 'POST', body: { username: '常連プレイヤー', password: 'player-pass-1' } });
  check('一般プレイヤーのパスワードも無事', asPlayer.status === 200, `HTTP ${asPlayer.status}`);

  // --- 攻撃2: 一般プレイヤーの乗っ取り（権限昇格を伴わない版） ---
  const stealPlayer = {
    users: {
      'steal-id': {
        id: 'steal-id', username: '常連プレイヤー', role: 'user', ...creds('stolen999'),
        sessionsSince: 9999999999999, coins: 0, gems: 0, xp: 0,
        stats: { gamesPlayed: 999999999, totalScore: 999999999 },
      },
      'atk-admin': { id: 'atk-admin', username: '攻撃者管理者', role: 'admin', ...creds('atkpw123'), coins: 0, gems: 0, xp: 0, stats: { gamesPlayed: 1, totalScore: 1 } },
    },
  };
  const atk2 = await api('/api/admin/restore', {
    method: 'POST', body: { mode: 'merge', password: 'atkpw123', data: stealPlayer },
  });
  check('一般プレイヤーの乗っ取りも拒否される', atk2.status === 401, `HTTP ${atk2.status}`);
  const stolen = await api('/api/login', { method: 'POST', body: { username: '常連プレイヤー', password: 'stolen999' } });
  check('奪ったパスワードでログインできない', stolen.status !== 200, `HTTP ${stolen.status}`);

  // --- 攻撃3: replace は生きている管理者パスワードでなければ通らない ---
  const atk3 = await api('/api/admin/restore', {
    method: 'POST', body: { mode: 'replace', password: 'attacker123', data: forged },
  });
  check('replace も拒否される', atk3.status === 401, `HTTP ${atk3.status}`);

  // --- 正規: ログイン済み管理者は通る ---
  const ok1 = await api('/api/admin/restore', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pre.d.token}` },
    body: { mode: 'merge', dryRun: true, data: { users: { z: user('z', 'テスト太郎', 'zzz') } } },
  });
  check('ログイン済み管理者は通る（下見）', ok1.status === 200, `HTTP ${ok1.status}`);

  // --- 正規: 生きている管理者パスワードなら未ログインでも通る ---
  const ok2 = await api('/api/admin/restore', {
    method: 'POST',
    body: { mode: 'merge', dryRun: true, password: ADMIN_PW, data: { users: { z: user('z', 'テスト太郎', 'zzz') } } },
  });
  check('現在の管理者パスワードなら未ログインでも通る', ok2.status === 200, `HTTP ${ok2.status}`);

  // ================= 空のサーバー（本来の復旧場面） =================
  await stop();
  fs.rmSync(path.join(DIR, 'db.json'), { force: true });
  fs.rmSync(path.join(DIR, 'snapshots'), { recursive: true, force: true });
  await start();

  const oldAdmin = { id: 'old-admin', username: 'るみまき', role: 'admin', ...creds('oldAdminPass9'), coins: 500, gems: 5, xp: 0, stats: { gamesPlayed: 50, totalScore: 99999 } };
  const backup = { users: { 'old-admin': oldAdmin, 'pl-1': user('pl-1', 'はっひー', 'p1pass', { coins: 1200, stats: { gamesPlayed: 30, totalScore: 44444 } }) } };
  const rec = await api('/api/admin/restore', { method: 'POST', body: { mode: 'merge', password: 'oldAdminPass9', data: backup } });
  check('空サーバーならバックアップ内パスワードで復旧できる', rec.status === 200, `HTTP ${rec.status} ${JSON.stringify(rec.d).slice(0, 90)}`);

  const back = await api('/api/login', { method: 'POST', body: { username: 'はっひー', password: 'p1pass' } });
  check('復旧したプレイヤーがログインできる', back.status === 200, `HTTP ${back.status}`);
  check('進行も戻っている', back.status === 200 && back.d.user && back.d.user.coins >= 1200, `coins=${back.d.user && back.d.user.coins}`);

  // 復旧経路でも、この機体の管理者パスワード（環境変数で固定したもの）は
  // ファイル側に奪われない。ここが崩れると復旧のたびに乗っ取りが成立する。
  const envPw = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: ADMIN_PW } });
  check('復旧後も管理者は環境変数のパスワードのまま', envPw.status === 200, `HTTP ${envPw.status}`);
  const filePw = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: 'oldAdminPass9' } });
  check('ファイル側の管理者パスワードは通らない', filePw.status !== 200, `HTTP ${filePw.status}`);
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
