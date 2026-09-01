// リポジトリのルートから:  node test/reconnect.test.mjs
//
// 🔌 再接続の猶予（server/battle.js）を、実サーバー＋実WSで通しで見る。
//
// ■ 何を守っているのか
// これまでは「WSが切れた＝その場で敗北」だった。電車がトンネルに入る・
// Wi-Fi が切り替わる、それだけでレートが落ちる。猶予を入れたので、今度は
// 逆向きの事故（＝猶予が抜け穴になる）を止める必要がある。見るのは4つ:
//   ① 猶予内に**同じアカウント**で戻れば試合が続き、レートが減らない
//   ② 猶予を過ぎたら従来どおり負ける（逃げ得にしない）
//   ③ 別アカウント／ゲストでは席を取れない
//      （hello の名乗り直し禁止＝敗北とEloの回避を塞いだ門を、再接続の
//       名目で開け直していないこと）
//   ④ 猶予の回数を使い切った人には猶予が付かない（切断を戦術にさせない）
//
// 猶予の長さと1日の回数は環境変数で縮めて回す（本番の既定は
// server/battle.js の RECONNECT_GRACE_MS / RECONNECT_GRACE_PER_DAY）。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

const PORT = await freePort();
// 保存先にポートを混ぜる理由は test/battle.test.mjs と同じ
// （run-all を2つ同時に走らせても踏み合わない）。
const DIR = path.join(os.tmpdir(), `bba-reconnect-test-${PORT}`);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// テスト用に縮めた猶予。実装の既定（25秒 / 1日3回）のままでは
// 「猶予切れ」を見るのに25秒待つことになる。
const GRACE_MS = 4000;
const GRACE_PER_DAY = 2;

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'reconnect-test', SEED_RESTORE: '0',
      // 試合はテストが finish で畳む。時間切れ待ちにならない長さにしておく。
      MATCH_SECONDS: '30',
      RECONNECT_GRACE_MS: String(GRACE_MS),
      RECONNECT_GRACE_PER_DAY: String(GRACE_PER_DAY),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    }
    try { const r = await fetch(`${BASE}/api/status`); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

async function register(username, password) {
  const r = await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(x => x.json());
  if (!r.token) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.token;
}
async function me(token) {
  return fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
}

// ちいさなWSクライアント。battle.test.mjs のものに resume を足しただけ。
// 実クライアント（public/js/net.js）と同じく role:'battle' を名乗る ──
// サーバーは resume と role の両方が揃ったときにしか席を返さない。
function makeClient({ token = null, guestName = null, resume = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    got: type => !!(inbox[type] && inbox[type].length),
    async wait(type, timeout = 20000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) {
          throw new Error(`timeout waiting for ${type} (got: ${Object.keys(inbox).filter(k => inbox[k].length).join(',') || 'nothing'})`);
        }
        await sleep(50);
      }
    },
    // 「来ないこと」を見る用。
    async quiet(type, ms) { await sleep(ms); return !c.got(type); },
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => c.send({
      type: 'hello', token, guestName, role: 'battle',
      ...(resume ? { resume: true } : {}),
    }));
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 8000); res(c); })().catch(rej);
  });
}

// 2人をデュエルで組ませて、カウントダウン明けまで進める。
async function pairDuel(a, b) {
  a.send({ type: 'queue', mode: 'duel' });
  b.send({ type: 'queue', mode: 'duel' });
  const mfA = await a.wait('match_found', 15000);
  const mfB = await b.wait('match_found', 15000);
  await sleep(3400);   // COUNTDOWN(3秒)明け
  return { mfA, mfB };
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const tokA = await register('もどれるA', 'passw0rd');
  const tokB = await register('あいてのB', 'passw0rd');
  const tokC = await register('よこどりC', 'passw0rd');
  const rating0 = (await me(tokA)).user.stats.rating;

  // =========================================================================
  // ① 猶予内に同じアカウントで戻れば、試合が続いてレートも減らない
  // =========================================================================
  {
    let A = await makeClient({ token: tokA });
    const B = await makeClient({ token: tokB });
    const { mfA } = await pairDuel(A, B);
    const matchId = mfA.matchId;

    A.send({ type: 'state', score: 3000, lines: 4, combo: 2 });
    await sleep(300);
    // 切断（電波が切れた端末と同じく、こちらから閉じる）
    A.ws.close();

    const unstable = await B.wait('opp_unstable', 5000);
    check('① 相手に「接続が不安定」が届く', unstable.slot === mfA.you.slot,
      `slot=${unstable.slot} / 切れたのは ${mfA.you.slot}`);
    // ⚠ 正体に触れる欄が乗っていないこと（住人の秘匿）。
    check('① 不安定の知らせに正体の欄が無い',
      !('isBot' in unstable) && !('resident' in unstable) && !('human' in unstable),
      JSON.stringify(unstable));

    // 猶予の内側で戻る
    await sleep(600);
    A = await makeClient({ token: tokA, resume: true });
    const resumed = await A.wait('match_resumed', 5000);
    check('① 同じ試合へ復帰できる', resumed.matchId === matchId, `${resumed.matchId} vs ${matchId}`);
    check('① 復帰時に自分の席が返ってくる', resumed.you && typeof resumed.you.slot === 'number',
      JSON.stringify(resumed.you));
    check('① 経過時間が進んでいる（時計は止めていない）', resumed.elapsedMs > 3000, `${resumed.elapsedMs}ms`);
    const back = await B.wait('opp_back', 5000);
    check('① 相手に復帰が伝わる', typeof back.slot === 'number', JSON.stringify(back));

    // 続きから遊んで、ふつうに勝つ
    A.send({ type: 'state', score: 6000, lines: 8, combo: 3 });
    await sleep(300);
    A.send({ type: 'finish', score: 6000, lines: 8, combo: 3 });
    B.send({ type: 'finish', score: 100, lines: 1, combo: 0 });
    const rA = await A.wait('result', 20000);
    check('① 復帰した側にも結果が届く', !!rA, '');
    check('① 棄権あつかいになっていない', rA.reason !== 'forfeit' && rA.outcome === 'win',
      `reason=${rA.reason} outcome=${rA.outcome}`);
    check('① レートが減っていない', rA.ratingDelta > 0 && rA.user.stats.rating > rating0,
      `delta=${rA.ratingDelta} rating=${rA.user.stats.rating}（開始時 ${rating0}）`);

    A.ws.close(); B.ws.close();
    await sleep(300);
  }

  const ratingAfterWin = (await me(tokA)).user.stats.rating;

  // =========================================================================
  // ② 猶予を過ぎたら従来どおり負ける ＋ ③ 別人・ゲストは席を取れない
  // =========================================================================
  {
    const A = await makeClient({ token: tokA });
    const B = await makeClient({ token: tokB });
    await pairDuel(A, B);
    A.send({ type: 'state', score: 5000, lines: 6, combo: 2 });
    await sleep(300);

    const cutAt = Date.now();
    A.ws.close();
    await B.wait('opp_unstable', 5000);

    // ③ 別アカウントが resume を名乗っても席は取れない
    const C = await makeClient({ token: tokC, resume: true });
    check('③ 別アカウントでは復帰できない', await C.quiet('match_resumed', 900), '');
    // ③ ゲストも同じ（名乗り直しでの敗北回避を再び開けていないこと）
    const G = await makeClient({ guestName: 'なりすましゲスト', resume: true });
    check('③ ゲストでは復帰できない', await G.quiet('match_resumed', 900), '');
    C.ws.close(); G.ws.close();

    // ② 猶予切れで相手の勝ち
    const rB = await B.wait('result', 15000);
    const waited = Date.now() - cutAt;
    check('② 猶予のあいだは決着しない', waited >= GRACE_MS - 700, `${waited}ms（猶予 ${GRACE_MS}ms）`);
    check('② 猶予を過ぎたら相手の勝ち（棄権）', rB.outcome === 'win' && rB.reason === 'forfeit',
      `outcome=${rB.outcome} reason=${rB.reason}`);

    const after = await me(tokA);
    check('② 戻らなかった側はレートが下がる', after.user.stats.rating < ratingAfterWin,
      `${ratingAfterWin} → ${after.user.stats.rating}`);
    check('② 猶予の使用回数が記録される',
      after.user.stats.dcGrace && after.user.stats.dcGrace.n === 2 && after.user.stats.dcGrace.total === 2,
      JSON.stringify(after.user.stats.dcGrace));

    B.ws.close();
    await sleep(300);
  }

  // =========================================================================
  // ④ 常習者（回数を使い切った人）には猶予が付かない
  // =========================================================================
  {
    const A = await makeClient({ token: tokA });
    const B = await makeClient({ token: tokB });
    await pairDuel(A, B);
    A.send({ type: 'state', score: 500, lines: 1, combo: 0 });
    await sleep(300);

    const cutAt = Date.now();
    A.ws.close();
    const rB = await B.wait('result', 10000);
    const waited = Date.now() - cutAt;
    check('④ 3回目の切断には猶予が付かない（即決着）', waited < GRACE_MS - 800,
      `${waited}ms（猶予が付けば ${GRACE_MS}ms 待つはず）`);
    check('④ 猶予なしでも従来どおり相手の勝ち', rB.outcome === 'win' && rB.reason === 'forfeit',
      `outcome=${rB.outcome} reason=${rB.reason}`);
    check('④ 猶予が付かないので「不安定」の知らせも出ない', !B.got('opp_unstable'), '');
    const after = await me(tokA);
    check('④ 使い切ったあとは回数が増えない',
      after.user.stats.dcGrace && after.user.stats.dcGrace.n === GRACE_PER_DAY,
      JSON.stringify(after.user.stats.dcGrace));

    B.ws.close();
    await sleep(300);
  }

  // =========================================================================
  // ⑤ ゲストには猶予そのものが付かない（復帰の鍵が userId しか無いため）
  // =========================================================================
  {
    const G = await makeClient({ guestName: 'つうこうにんG' });
    const B = await makeClient({ token: tokB });
    await pairDuel(G, B);
    G.send({ type: 'state', score: 400, lines: 1, combo: 0 });
    await sleep(300);

    const cutAt = Date.now();
    G.ws.close();
    const rB = await B.wait('result', 10000);
    const waited = Date.now() - cutAt;
    check('⑤ ゲストの切断は従来どおり即敗北', waited < GRACE_MS - 800 && rB.reason === 'forfeit',
      `${waited}ms / reason=${rB.reason}`);
    B.ws.close();
  }
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
