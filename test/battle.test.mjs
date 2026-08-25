// Run from the repo root:  node test/battle.test.mjs  (needs a free port 3107)
// ⚔️ アタック戦のWS統合テスト: 2クライアントの実マッチで
// ペアリング → 攻撃リレー(お邪魔ブロック) → 結果 → 🔁再戦 まで通す。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';

const PORT = 3107;
const DIR = path.join(os.tmpdir(), 'bba-battle-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'battle-test', SEED_RESTORE: '0', MATCH_SECONDS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const r = await fetch(`http://localhost:${PORT}/api/status`); if (r.ok) return; } catch {}
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

// ちいさなWSクライアント: 受信を型別に貯めて、来るまで待てる。
function makeClient(guestName) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    async wait(type, timeout = 20000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type} (got: ${Object.keys(inbox).filter(k => inbox[k].length).join(',') || 'nothing'})`);
        await sleep(60);
      }
    },
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => { c.send({ type: 'hello', guestName }); });
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 8000); res(c); })().catch(rej);
  });
}

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const A = await makeClient('アタッカーA');
  const B = await makeClient('ディフェンダーB');

  // ---- ペアリング ----
  A.send({ type: 'queue', mode: 'attack' });
  B.send({ type: 'queue', mode: 'attack' });
  const mfA = await A.wait('match_found');
  const mfB = await B.wait('match_found');
  check('attack戦がマッチングされる', mfA.mode === 'attack' && mfB.mode === 'attack', `modes=${mfA.mode}/${mfB.mode}`);
  check('2人とも人間同士', mfA.players.every(p => !p.isBot), JSON.stringify(mfA.players.map(p => p.name)));

  // ---- 攻撃リレー: Aの3ライン消し → Bにお邪魔4個 ----
  await sleep(3500);   // カウントダウン明け
  // 実クライアントは pushState → attack の順で送る。サーバーは申告済み累計ライン数を
  // 超える攻撃を捏造として拒否するので、テストも同じ順序で送る。
  A.send({ type: 'state', score: 4200, lines: 8, combo: 2 });
  A.send({ type: 'attack', lines: 3, combo: 2 });
  const g = await B.wait('garbage', 8000);
  check('攻撃がお邪魔ブロックとして届く(3ライン=4個)', g.cells === 4, `cells=${g.cells}`);
  A.send({ type: 'attack', lines: 4, combo: 9 });
  const g2 = await B.wait('garbage', 8000);
  check('4ライン+コンボでお邪魔9個上限内(6+3)', g2.cells === 9, `cells=${g2.cells}`);
  A.send({ type: 'attack', lines: 1, combo: 0 });
  await sleep(800);
  check('1ライン消しでは攻撃なし', !(B.inbox.garbage && B.inbox.garbage.length), '');
  // 捏造: 累計8ライン申告で既に3+4を消費 → さらに8ライン主張は budget 超過で無音
  A.send({ type: 'attack', lines: 8, combo: 0 });
  await sleep(800);
  check('申告ライン数を超える捏造攻撃は拒否される', !(B.inbox.garbage && B.inbox.garbage.length), '');

  // ---- 結果 + 🔁再戦 ----
  const rA = await A.wait('result', 25000);
  const rB = await B.wait('result', 25000);
  check('両者に結果が届く(mode=attack)', rA.mode === 'attack' && rB.mode === 'attack');
  check('再戦IDが両者に発行される', !!rA.rematchId && rA.rematchId === rB.rematchId, rA.rematchId);
  check('tierChangeフィールドが存在(ゲストはnull)', 'tierChange' in rA, '');

  A.send({ type: 'rematch', rematchId: rA.rematchId });
  const offer = await B.wait('rematch_offer', 8000);
  check('相手に再戦オファーが届く', offer.from === 'アタッカーA', offer.from);
  B.send({ type: 'rematch', rematchId: rB.rematchId });
  const mfA2 = await A.wait('match_found', 8000);
  const mfB2 = await B.wait('match_found', 8000);
  check('🔁 両者承諾で即再戦', mfA2.mode === 'attack' && mfB2.mode === 'attack' && mfA2.matchId !== mfA.matchId, '');
  await A.wait('result', 25000);
  await B.wait('result', 25000);

  // ---- ソロ入場 → ボットが補充される ----
  const C = await makeClient('ソロ участник');
  C.send({ type: 'queue', mode: 'attack' });
  const mfC = await C.wait('match_found', 15000);
  check('1人でもボットが相手になる', mfC.mode === 'attack' && mfC.players.some(p => p.isBot), JSON.stringify(mfC.players.map(p => [p.name, p.isBot])));
  const rC = await C.wait('result', 25000);
  check('ボット戦もrematchIdつき(即再戦可)', !!rC.rematchId, '');
  C.send({ type: 'rematch', rematchId: rC.rematchId });
  const mfC2 = await C.wait('match_found', 8000);
  check('ボット相手は即時再戦', mfC2.mode === 'attack', '');

  A.ws.close(); B.ws.close(); C.ws.close();
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
