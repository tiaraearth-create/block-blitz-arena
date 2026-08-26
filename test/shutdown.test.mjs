// Run from the repo root:  node test/shutdown.test.mjs  (needs a free port 3112)
//
// 🔧 更新で落ちるときの後始末。
//
// 永続ディスクを付けた副作用で、Render は新旧インスタンスを同時に動かせない
// （ディスクは1つにしかマウントできない）ため、デプロイのたびに必ず停止時間が
// 出る。以前はプロセスがそのまま消えるので:
//   ・対戦中の人 → 原因不明の切断。勝敗も記録も残らない
//   ・ソロプレイ中の人 → 終了時の結果送信が失敗し、1回ぶんが黙って消える
// いまは落ちる前に対戦を「引き分け」で正式に終わらせ、全員に予告を投げる。
//
// SIGTERM は Windows では配送されない（kill() が TerminateProcess になる）ので、
// ここでは同じ処理を呼ぶ管理者APIを叩いて検証する。本番(Linux)では SIGTERM が
// 同じ endAllForShutdown() を通る。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-shutdown-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* empty */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0', SESSION_SECRET: 'sd-test', SEED_RESTORE: '0', MATCH_SECONDS: '120' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { if ((await fetch(BASE + '/api/status')).ok) return; } catch { /* not up */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

function client(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox, send: m => ws.send(JSON.stringify(m)),
    async wait(t, ms = 15000) {
      const t0 = Date.now();
      for (;;) { if (inbox[t] && inbox[t].length) return inbox[t].shift(); if (Date.now() - t0 > ms) throw new Error('timeout ' + t); await sleep(60); }
    },
  };
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } (inbox[m.type] = inbox[m.type] || []).push(m); });
  return new Promise(res => ws.on('open', () => { c.send({ type: 'hello', guestName: name, token }); setTimeout(() => res(c), 400); }));
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const atk = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  // 勝敗が報酬に効くのはアカウント持ちだけなので、登録して確かめる
  const pa = await j('/api/register', { method: 'POST', body: { username: '対戦者A', password: 'pass1234' } });
  const pb = await j('/api/register', { method: 'POST', body: { username: '対戦者B', password: 'pass1234' } });

  check('一般ユーザーは更新準備を叩けない',
    (await j('/api/admin/prepare-update', { method: 'POST' }, pa.token)).status === 403);

  const A = await client('対戦者A', pa.token);
  const B = await client('対戦者B', pb.token);
  A.send({ type: 'queue', mode: 'duel' });
  B.send({ type: 'queue', mode: 'duel' });
  await A.wait('match_found');
  await B.wait('match_found');
  await sleep(3800);                                    // カウントダウン明け
  A.send({ type: 'state', score: 9000, lines: 12, combo: 3 });   // A が大きくリード
  B.send({ type: 'state', score: 3000, lines: 5, combo: 1 });
  await sleep(700);

  const winsBefore = (await j('/api/me', {}, pa.token)).user.stats.pvpWins;

  const pr = await j('/api/admin/prepare-update', { method: 'POST' }, atk);
  check('更新準備で進行中の対戦が終了する', pr.status === 200 && pr.ended >= 1, `ended=${pr.ended}`);

  const notice = await A.wait('server_shutdown', 6000).catch(() => null);
  check('全員に更新の予告が届く', !!notice && notice.graceSec > 0, notice ? `猶予${notice.graceSec}秒` : 'なし');

  const rA = await A.wait('result', 8000).catch(() => null);
  const rB = await B.wait('result', 8000).catch(() => null);
  check('両者に結果が届く', !!rA && !!rB, '');
  // ここが肝。スコアで勝っていた人が勝ちにならず、負けていた人も負けにならない。
  check('リードしていた側も引き分け', rA && rA.outcome === 'draw', rA ? rA.outcome : '');
  check('負けていた側も引き分け', rB && rB.outcome === 'draw', rB ? rB.outcome : '');
  check('理由が shutdown として伝わる', rA && rA.reason === 'shutdown', rA ? rA.reason : '');

  const meA = (await j('/api/me', {}, pa.token)).user;
  check('勝敗記録が汚れない（勝ち星が増えない）', meA.stats.pvpWins === winsBefore, `${winsBefore} → ${meA.stats.pvpWins}`);
  check('プレイ記録と報酬は残る', meA.stats.gamesPlayed >= 1 && meA.coins > 0, `${meA.stats.gamesPlayed}戦 / ${meA.coins}🪙`);

  check('マッチング待ちの列も空になる', (await j('/api/status')).queueing === 0, '');
  check('二度目の実行でも落ちない', (await j('/api/admin/prepare-update', { method: 'POST' }, atk)).status === 200);

  A.ws.close(); B.ws.close();
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
