// リポジトリのルートから:  node test/spectate.test.mjs
//
// 👀 観戦の取り決め（この波の3タスク共通）をWSで通しで見張る。
//
//   クライアント → { type:'watch', target: string|null }   null は「おまかせ＝首位」
//   サーバー   → royale_state / room_update に
//                  watch:     { name, score, grid } | null
//                  watchable: [{ name, score, alive }]   順位順・上位20人
//
// ここで見るもの:
//   A. 脱落したあと、watch で観戦相手を切り替えられる
//   B. 居ない相手（脱落・退出）を指名しても固まらず、黙って首位へ戻る
//   C. watchable が順位順で、上位20人までで、**正体を1文字も漏らさない**
//   D. まだ生きている人の watch は無視される
//      （生存者が他人の盤面を覗けるのは、次に何が来るかを読めるので不正）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';
// 正体を明かすキーの唯一の正解。手書きの表をここに持たない
//（server/sanitize.js が増えたときに、このテストだけ古いままにならないように）。
import { SECRET_KEYS } from '../server/sanitize.js';

const PORT = await freePort();
const DIR = path.join(os.tmpdir(), `bba-spectate-test-${PORT}`);
// 30 はサーバー自身の下限（Math.max(30, ...)）。それより短く頼んでも黙って
// 切り上げられるので、起こりえない値を検査しないよう合わせる。
const ROYALE_SECS = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'spectate-test', SEED_RESTORE: '0', ROYALE_SECS: String(ROYALE_SECS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(proc, `http://localhost:${PORT}`);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

function makeClient(guestName) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    last: type => (inbox[type] || [])[(inbox[type] || []).length - 1],
    clear: type => { inbox[type] = []; },
    async wait(type, timeout = 20000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type}`);
        await sleep(60);
      }
    },
    // 条件に合うフレームが来るまで待つ（来なければ null）。
    async until(type, pred, timeout = 12000) {
      const t0 = Date.now();
      for (;;) {
        const q = inbox[type] || [];
        while (q.length) { const m = q.shift(); if (pred(m)) return m; }
        if (Date.now() - t0 > timeout) return null;
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

// watchable の1行に、名前・点・生死**以外**が入っていないこと。
const ALLOWED = new Set(['name', 'score', 'alive']);
function leakyRow(row) {
  for (const k of Object.keys(row)) {
    if (SECRET_KEYS.has(k)) return `${k}（正体を明かすキー）`;
    if (!ALLOWED.has(k)) return `${k}（取り決めに無いキー）`;
  }
  return null;
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // =========================================================================
  // 脱落 → 観戦へ。そこから相手を選べること。
  // =========================================================================
  const A = await makeClient('観戦A');
  A.send({ type: 'queue', mode: 'royale' });
  const found = await A.wait('royale_found', 20000);
  await sleep((found.countdown + 1) * 1000);

  // まず生きているあいだの検査（D: 生存者は覗けない）。
  A.send({ type: 'state', score: 4000, lines: 12, combo: 3 });
  await sleep(1200);
  const aliveState = await A.until('royale_state', m => !m.spectating, 8000);
  check('D-1 生きているうちは観戦データが来ない',
    !!aliveState && !aliveState.watch && !aliveState.watchable,
    aliveState ? `watch=${JSON.stringify(aliveState.watch)} watchable=${aliveState.watchable ? aliveState.watchable.length : null}` : 'no state');
  // 生存中に watch を投げても無視される（覗けたら不正）。
  A.send({ type: 'watch', target: 'だれか' });
  await sleep(1500);
  const stillAlive = await A.until('royale_state', m => !m.spectating, 6000);
  check('D-2 生存者の watch は無視される',
    !!stillAlive && !stillAlive.watch, stillAlive ? JSON.stringify(stillAlive.watch) : 'no state');

  // 2回トップアウトして脱落 → 観戦へ（1回目は復活）。
  A.send({ type: 'royale_topout' });
  await A.wait('royale_revive', 8000);
  A.send({ type: 'royale_topout' });
  await A.wait('royale_result', 8000);

  const spec = await A.until('royale_state', m => m.spectating && m.watch, 12000);
  check('A-1 脱落すると観戦に移り、既定では首位の盤面が届く',
    !!(spec && spec.watch && Array.isArray(spec.watch.grid) && spec.watch.grid.length === 64),
    spec && spec.watch ? `${spec.watch.name} (${spec.watch.grid.length}マス)` : 'no watch');

  const list = (spec && spec.watchable) || [];
  check('C-1 watchable が届く', list.length > 1, `${list.length}人`);
  check('C-2 上位20人までに切ってある', list.length <= 20, `${list.length}人`);
  const desc = list.every((x, i) => i === 0 || list[i - 1].score >= x.score);
  check('C-3 順位順（強い人が上）', desc, list.slice(0, 5).map(x => `${x.name}:${x.score}`).join(' '));
  const leaks = list.map(leakyRow).filter(Boolean);
  check('C-4 正体に関わるフィールドが1つも無い', leaks.length === 0, leaks.slice(0, 3).join(', '));
  check('C-5 既定の観戦相手は watchable の先頭（＝首位）',
    !!(spec && list[0] && spec.watch.name === list[0].name),
    spec ? `watch=${spec.watch.name} / top=${list[0] && list[0].name}` : '');

  // --- A: 相手を切り替える ---
  const pick = list[Math.min(3, list.length - 1)];
  A.send({ type: 'watch', target: pick.name });
  const switched = await A.until('royale_state', m => m.spectating && m.watch && m.watch.name === pick.name, 10000);
  check('A-2 watch で観戦相手を切り替えられる', !!switched, `→ ${pick.name}`);
  check('A-3 切り替えた相手の盤面が届く',
    !!(switched && Array.isArray(switched.watch.grid) && switched.watch.grid.length === 64),
    switched ? `${switched.watch.grid.length}マス` : '');

  // --- B: 居ない相手を指名しても固まらない ---
  A.send({ type: 'watch', target: 'いない人ですよ' });
  const back = await A.until('royale_state', m => m.spectating && m.watch, 10000);
  check('B-1 居ない相手を指名しても watch が null で固まらない',
    !!(back && back.watch && Array.isArray(back.watch.grid)),
    back && back.watch ? back.watch.name : 'null');
  check('B-2 自動で首位へ戻る（黙って固まらせない）',
    !!(back && back.watchable && back.watchable[0] && back.watch.name === back.watchable[0].name),
    back && back.watch ? `${back.watch.name} / 首位 ${back.watchable[0].name}` : '');

  // --- おまかせ（null）に戻せる ---
  const pick2 = (back.watchable[1] || back.watchable[0]);
  A.send({ type: 'watch', target: pick2.name });
  await A.until('royale_state', m => m.spectating && m.watch && m.watch.name === pick2.name, 10000);
  A.send({ type: 'watch', target: null });
  const auto = await A.until('royale_state',
    m => m.spectating && m.watch && m.watchable && m.watch.name === m.watchable[0].name, 10000);
  check('A-4 target:null で「おまかせ（首位）」に戻る', !!auto, auto ? auto.watch.name : 'none');

  // --- 指名した相手が脱落しても止まらない（足切りが必ず来るので、それで確かめる）---
  const low = back.watchable[back.watchable.length - 1];
  A.send({ type: 'watch', target: low.name });
  await sleep(6000);
  const alive2 = await A.until('royale_state', m => m.spectating && m.watch, 10000);
  check('B-3 観戦は途切れずに続いている（盤面が来続ける）',
    !!(alive2 && alive2.watch && Array.isArray(alive2.watch.grid)),
    alive2 && alive2.watch ? `見ている相手: ${alive2.watch.name}` : 'no watch');

  A.ws.close();
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
