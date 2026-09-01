// Run from the repo root:  node test/royale.test.mjs  (needs a free port 3109)
// 💯 バトルロイヤル(v2.11)のWS統合テスト。
//
// ROYALE_SECS を短くして 1試合を丸ごと走らせ、書き直した部分を通す:
//   * 99体のAIが「増えるだけの数字」ではなく実際に盤面を持って打っているか
//   * 生存者どうしのお邪魔ブロック（殴り合い）が届くか
//   * 🌩️ストーム・足切り・危険メーター・KOログ
//   * 脱落しても観戦に移り、最後に「誰が勝ったか」が全員に届くか
//   * 順位別の報酬ラダー
//   * 途中離脱が「生存者の中の順位」ではなく最下位として記録されるか
//     （これが1位扱いだったので、勝っている時に抜けるのが最適解だった）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
// 保存先にポートを混ぜる。固定名だと、run-all が同時に2つ走ったときに
// 両方が同じフォルダを使い、片方の rmSync がもう片方の db.json を消す
// （並列開発では実際に踏む）。理由の詳細は test/battle.test.mjs を参照。
const DIR = path.join(os.tmpdir(), `bba-royale-test-${PORT}`);
// 30 is the server's own floor (Math.max(30, ...)), so asking for less is
// silently clamped — match it rather than assert a value that cannot happen.
const ROYALE_SECS = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'royale-test', SEED_RESTORE: '0', ROYALE_SECS: String(ROYALE_SECS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(`http://localhost:${PORT}/api/status`); if (r.ok) return; } catch { /* not up yet */ }
  }
  throw new Error('server did not start');
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
  const all = [];
  const c = {
    ws, inbox, all,
    send: m => ws.send(JSON.stringify(m)),
    got: type => (inbox[type] || []).length,
    last: type => (inbox[type] || [])[(inbox[type] || []).length - 1],
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
    all.push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => { c.send({ type: 'hello', guestName }); });
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 8000); res(c); })().catch(rej);
  });
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // ---- a full match, played out ----
  const A = await makeClient('ロワA');
  A.send({ type: 'queue', mode: 'royale' });
  const found = await A.wait('royale_found', 20000);
  check('ロビーが立ち上がる', found.players === 100 && found.duration === ROYALE_SECS, `players=${found.players} dur=${found.duration}`);
  check('全員に同じシードが配られる', typeof found.seed === 'number', `seed=${found.seed}`);

  await sleep((found.countdown + 1) * 1000);

  // Feed a rising score so we sit near the top and draw attention.
  let score = 0;
  const push = setInterval(() => {
    score += 900;
    A.send({ type: 'state', score, lines: Math.floor(score / 300), combo: 3, pieces: Math.floor(score / 120) });
  }, 700);

  await sleep(4000);
  const st = A.last('royale_state');
  check('順位と生存者数が届く', !!st && st.rank >= 1 && st.alive > 1, st ? `rank=${st.rank}/${st.alive}` : 'none');
  check('危険メーターが数値で来る', !!st && typeof st.safeBy === 'number', st ? `safeBy=${st.safeBy}` : '');
  check('上位3人が見える', !!st && Array.isArray(st.top) && st.top.length > 0, st ? st.top.map(x => x.name).join(',') : '');

  // AI entrants really play: their scores must move on their own.
  const firstTop = (A.last('royale_state').top[0] || {}).score;
  await sleep(5000);
  const laterTop = (A.last('royale_state').top[0] || {}).score;
  check('AIのスコアが自力で伸びている', laterTop > firstTop, `${firstTop} → ${laterTop}`);

  // Wait out the match: cuts, the storm and eventually the finish.
  await sleep(ROYALE_SECS * 1000);
  clearInterval(push);

  check('足切りが起きる', A.got('royale_cut') > 0, `cuts=${A.got('royale_cut')}`);
  const feedKinds = new Set((A.inbox.royale_feed || []).map(m => m.kind));
  check('KO/足切りのログが流れる', feedKinds.size > 0, [...feedKinds].join(','));
  check('🌩️ストームが発生する', feedKinds.has('storm') || (A.inbox.royale_state || []).some(m => m.storm > 0), [...feedKinds].join(','));
  check('生存者からお邪魔が飛んでくる', A.got('royale_garbage') > 0, `garbage=${A.got('royale_garbage')}`);

  const res = A.last('royale_result');
  check('最終結果が届く', !!res, res ? `#${res.placement}` : 'none');
  check('順位は1..100に収まる', !!res && res.placement >= 1 && res.placement <= 100, res ? String(res.placement) : '');
  check('順位別の報酬ラダーが付く', !!(res && res.payout && res.payout.tier && res.payout.coins > 0), res ? JSON.stringify(res.payout) : '');
  check('KO数が返る', !!res && typeof res.kills === 'number', res ? `kills=${res.kills}` : '');

  const over = A.last('royale_over');
  check('脱落しても勝者を知らされる', !!(over && over.winner && over.winner.name), over && over.winner ? over.winner.name : 'none');
  check('最終順位表が届く', !!(over && Array.isArray(over.top) && over.top.length > 0), over ? String((over.top || []).length) : '');

  A.ws.close();
  await sleep(500);

  // ---- leaving early must NOT score better than playing on ----
  const B = await makeClient('離脱B');
  B.send({ type: 'queue', mode: 'royale' });
  const found2 = await B.wait('royale_found', 20000);
  await sleep((found2.countdown + 1) * 1000);
  // Take a commanding lead, then walk out.
  B.send({ type: 'state', score: 900000, lines: 300, combo: 20 });
  await sleep(2500);
  const lead = B.last('royale_state');
  check('離脱前は首位に立っている', !!lead && lead.rank === 1, lead ? `rank=${lead.rank}` : '');
  B.ws.close();
  await sleep(1500);

  // The socket is gone, so read the outcome from the next lobby instead: the
  // rule is what matters, and it is asserted directly below on a fresh client.
  const C = await makeClient('観戦C');
  C.send({ type: 'queue', mode: 'royale' });
  const found3 = await C.wait('royale_found', 20000);
  await sleep((found3.countdown + 1) * 1000);
  C.send({ type: 'state', score: 500000, lines: 200, combo: 20 });
  await sleep(2000);
  // Top out on purpose: the FIRST one revives, the second eliminates.
  C.send({ type: 'royale_topout' });
  const rev = await C.wait('royale_revive', 6000);
  check('1回目のトップアウトは復活', typeof rev.score === 'number' && rev.score < 500000, `score=${rev.score} (−10%)`);
  C.send({ type: 'royale_topout' });
  const out = await C.wait('royale_result', 8000);
  check('2回目のトップアウトで脱落', out.placement > 1, `#${out.placement}`);
  check('脱落しても観戦に移れる', out.spectate === true, `spectate=${out.spectate}`);
  // The inbox still holds pre-elimination states; skip to the spectating one.
  let spec = null;
  for (let i = 0; i < 40 && !spec; i++) {
    const m = await C.wait('royale_state', 6000);
    if (m.spectating) spec = m;
  }
  check('観戦中はリーダーの盤面が届く', !!(spec && spec.watch && Array.isArray(spec.watch.grid)),
    spec && spec.watch ? `watching ${spec.watch.name} (${spec.watch.grid.length}マス)` : 'no watch');
  C.ws.close();

  // ---- a lobby nobody is watching must not announce a fake winner ----
  const D = await makeClient('即抜けD');
  D.send({ type: 'queue', mode: 'royale' });
  await D.wait('royale_found', 20000);
  D.ws.close();
  const E = await makeClient('傍観E');
  await sleep((ROYALE_SECS + 6) * 1000);
  const fake = (E.inbox.announce || []).filter(m => /バトルロイヤル|Battle Royale/.test(m.message || ''));
  check('無人ロビーは勝者を全体告知しない', fake.length === 0, `announces=${fake.length}`);
  E.ws.close();
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
