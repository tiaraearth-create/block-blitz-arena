// リポジトリのルートから:  node test/room.test.mjs
//
// 🚪 カスタムルームの定員（8人）と観戦席のWS統合テスト。
//
// 何が起きていたか（v2.34まで）:
//   定員が「対戦席の数」そのもの（1v1=2 / 2v2=4）だったので、3人目は
//   「ルームが満員です」と言われて **入室すらできなかった**。5人で集まって
//   2人だけ遊ぶ、ができない。
//
// ここで見るもの:
//   A. 8人が1つの部屋に入れる／9人目だけが断られる
//   B. 対戦席からあふれた人は自動で観戦席になる
//   C. 席の入れ替えはホストだけができる
//   D. 試合が始まると、観戦席の人はロイヤルと同じ取り決め（watch / watchable）で
//      盤面を見られる。相手も選べる。
//   E. 観戦者に戦績が付かない（結果フレームも来ない・gamesPlayed も動かない）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';
import { SECRET_KEYS } from '../server/sanitize.js';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-room-test-${PORT}`);
const MATCH_SECS = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
// 出力は最後にまとめて出す（run-all が塊で読む）。ただし長い実時間テストなので
// 「どこで止まったか」を見たいときのために TEST_VERBOSE=1 で逐次表示もできる。
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'room-test', SEED_RESTORE: '0', MATCH_SECONDS: String(MATCH_SECS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(proc, BASE);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

function makeClient(guestName, token = null) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox, name: guestName,
    send: m => ws.send(JSON.stringify(m)),
    got: type => (inbox[type] || []).length,
    last: type => (inbox[type] || [])[(inbox[type] || []).length - 1],
    clear: type => { inbox[type] = []; },
    async wait(type, timeout = 15000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type}`);
        await sleep(50);
      }
    },
    async until(type, pred, timeout = 12000) {
      const t0 = Date.now();
      for (;;) {
        const q = inbox[type] || [];
        while (q.length) { const m = q.shift(); if (pred(m)) return m; }
        if (Date.now() - t0 > timeout) return null;
        await sleep(50);
      }
    },
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => { c.send(token ? { type: 'hello', token } : { type: 'hello', guestName }); });
    ws.on('error', rej);
    (async () => { const ok = await c.wait('hello_ok', 8000); c.name = ok.name; res(c); })().catch(rej);
  });
}

const grid64 = v => Array.from({ length: 64 }, (_, i) => ((i + v) % 7 === 0 ? 1 : 0));
const ALLOWED = new Set(['name', 'score', 'alive']);
const leakyRow = row => Object.keys(row).find(k => SECRET_KEYS.has(k) || !ALLOWED.has(k)) || null;

const clients = [];
try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // 観戦者の戦績を見るために1人だけ本登録する（ゲストには stats が無い）。
  const reg = await (await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'みてるだけ', password: 'pw-room-test-1' }),
  })).json();
  check('下ごしらえ: 観戦者アカウントを作れた', !!(reg && reg.token), reg && reg.error ? reg.error : '');
  const meBefore = await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${reg.token}` } })).json();
  const playedBefore = ((meBefore.user || {}).stats || {}).gamesPlayed || 0;

  // ---- A/B: 8人が1部屋に入り、あふれたぶんが観戦席になる ----
  const host = await makeClient('ホスト'); clients.push(host);
  host.send({ type: 'create_room', settings: { mode: 'duel' } });
  const first = await host.wait('room_update');
  const code = first.code;
  check('A-1 部屋ができる', !!code && first.seats === 2 && first.max === 8, `code=${code} seats=${first.seats} max=${first.max}`);

  for (let i = 2; i <= 7; i++) {
    const c = await makeClient(`参加${i}`); clients.push(c);
    c.send({ type: 'join_room', code });
    await c.wait('room_update');
    await sleep(120);   // join_room は 10秒に5回まで（連投制限）— 余裕を持って間隔をあける
  }
  // 8人目は本登録アカウント（観戦者の戦績を見るため）。
  const watcher = await makeClient(null, reg.token); clients.push(watcher);
  watcher.send({ type: 'join_room', code });
  // wait() は受け取った1件を取り出してしまうので、観戦者側の見え方は
  // この戻り値で見る（あとから last() を呼んでも空になっている）。
  const watcherView = await watcher.wait('room_update');
  await sleep(300);

  const full = host.last('room_update');
  check('A-2 8人が1つの部屋に入れる', full.players.length === 8, `${full.players.length}人`);
  const play = full.players.filter(p => p.seat === 'play');
  const watch = full.players.filter(p => p.seat === 'watch');
  check('B-1 対戦席はモードどおり2人', play.length === 2, play.map(p => p.name).join(','));
  check('B-2 あふれた6人は観戦席', watch.length === 6, watch.map(p => p.name).join(','));
  check('B-3 入室順に対戦席が埋まる（ホストは対戦席）',
    play[0].name === host.name && play[0].isHost, `${play.map(p => p.name).join(',')}`);
  check('B-4 自分の席が分かる（観戦者には watch と伝わる）',
    watcherView.yourSeat === 'watch', String(watcherView.yourSeat));

  // ---- A: 9人目は断られる ----
  const ninth = await makeClient('9人目'); clients.push(ninth);
  ninth.send({ type: 'join_room', code });
  const err9 = await ninth.wait('room_error', 8000);
  check('A-3 9人目だけが「満員」で断られる', /満員/.test(err9.error || ''), err9.error);
  ninth.ws.close();

  // ---- C: 席の入れ替えはホストだけ ----
  const second = clients[1];   // 参加2 = もう1つの対戦席
  second.clear('room_error');
  second.send({ type: 'room_seat', name: host.name, seat: 'watch' });
  const errSeat = await second.wait('room_error', 6000);
  check('C-1 ホスト以外が席を動かそうとすると断られる', /ホスト/.test(errSeat.error || ''), errSeat.error);
  await sleep(300);
  check('C-2 断られたので席は変わっていない',
    host.last('room_update').players.find(p => p.name === host.name).seat === 'play', '');

  // ホストが「参加2」を観戦席へ回すと、次の人（参加3）が繰り上がる。
  const third = clients[2];
  host.clear('room_update');
  host.send({ type: 'room_seat', name: second.name, seat: 'watch' });
  const after = await host.wait('room_update', 6000);
  const seatOf = (msg, name) => (msg.players.find(p => p.name === name) || {}).seat;
  check('C-3 ホストは誰かを観戦席へ回せる', seatOf(after, second.name) === 'watch', seatOf(after, second.name));
  check('C-4 空いた対戦席には次の人が繰り上がる', seatOf(after, third.name) === 'play', seatOf(after, third.name));

  // ---- D: 試合開始 → 観戦席から見られる ----
  for (const c of clients) c.clear('room_update');
  host.send({ type: 'room_start' });
  const mfHost = await host.wait('match_found', 10000);
  const mfThird = await third.wait('match_found', 10000);
  check('D-1 対戦席の2人だけが試合に入る',
    !!mfHost && !!mfThird && mfHost.players.length === 2,
    `players=${mfHost.players.map(p => p.name).join(',')}`);
  check('D-2 観戦席の人は試合に入らない', watcher.got('match_found') === 0, `match_found=${watcher.got('match_found')}`);

  // 盤面を流す（観戦席にはこの盤面が中継される）。
  await sleep(3200);   // カウントダウン
  const pushA = setInterval(() => host.send({ type: 'state', score: 900, lines: 3, combo: 1, grid: grid64(0) }), 700);
  const pushB = setInterval(() => third.send({ type: 'state', score: 400, lines: 1, combo: 1, grid: grid64(3) }), 700);

  // 試合開始の直後にも room_update は飛ぶが、その時点ではまだ誰も1手も置いて
  // いないので grid は null。盤面が乗ったフレームを待つ。
  const specMsg = await watcher.until('room_update', m => m.inMatch && m.watch && m.watch.grid, 10000);
  check('D-3 観戦席に watch が届く',
    !!(specMsg && specMsg.watch && Array.isArray(specMsg.watch.grid) && specMsg.watch.grid.length === 64),
    specMsg && specMsg.watch ? `${specMsg.watch.name} (${specMsg.watch.grid.length}マス)` : 'none');
  const wl = (specMsg && specMsg.watchable) || [];
  check('D-4 watchable が順位順で届く',
    wl.length === 2 && wl[0].score >= wl[1].score, wl.map(x => `${x.name}:${x.score}`).join(' '));
  check('D-5 watchable に正体を明かすフィールドが無い',
    wl.every(r => !leakyRow(r)), wl.map(leakyRow).filter(Boolean).join(','));
  check('D-6 既定は首位（点の高いほう）', !!(specMsg && specMsg.watch.name === wl[0].name),
    specMsg ? `${specMsg.watch.name} / 首位 ${wl[0].name}` : '');

  // もう一方へ切り替えられる。
  const other = wl[1].name;
  watcher.send({ type: 'watch', target: other });
  const switched = await watcher.until('room_update', m => m.watch && m.watch.name === other, 8000);
  check('D-7 観戦相手を切り替えられる', !!switched, `→ ${other}`);
  // 居ない相手を指名しても固まらず、首位へ戻る。
  watcher.send({ type: 'watch', target: 'いない人ですよ' });
  const fell = await watcher.until('room_update', m => m.inMatch && m.watch, 8000);
  check('D-8 居ない相手を指名したら首位へ戻る（固まらない）',
    !!(fell && fell.watch && fell.watchable && fell.watch.name === fell.watchable[0].name),
    fell && fell.watch ? fell.watch.name : 'null');

  // 生存中のプレイヤー（対戦席）が watch を投げても効かない。
  host.clear('room_update');
  host.send({ type: 'watch', target: third.name });
  await sleep(600);
  check('D-9 対戦中の人の watch は無視される（部屋にもいない）',
    host.got('room_update') === 0, `room_update=${host.got('room_update')}`);

  clearInterval(pushA); clearInterval(pushB);

  // ---- E: 試合が終わったら観戦は畳まれ、観戦者に戦績は付かない ----
  // 正規のクライアントと同じく自分から終了を申告する（待つと保険の
  // タイムアウト = 開始+カウントダウン+時間+12秒 まで引っぱられる）。
  host.send({ type: 'finish', score: 900, lines: 3, combo: 1 });
  third.send({ type: 'finish', score: 400, lines: 1, combo: 1 });
  await host.wait('result', 25000);
  const back = await watcher.until('room_update', m => m.inMatch === false, 12000);
  check('E-1 試合が終わると観戦が畳まれ、ふつうの部屋に戻る', !!back, back ? `${back.players.length}人` : 'none');
  check('E-2 観戦者には結果フレームが来ない', watcher.got('result') === 0, `result=${watcher.got('result')}`);
  check('E-3 試合後は観戦者が対戦席に繰り上がる',
    !!(back && back.players.some(p => p.seat === 'play')), back ? back.players.map(p => `${p.name}:${p.seat}`).join(' ') : '');

  const meAfter = await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${reg.token}` } })).json();
  const playedAfter = ((meAfter.user || {}).stats || {}).gamesPlayed || 0;
  check('E-4 観戦者の戦績（gamesPlayed）が動かない',
    playedAfter === playedBefore, `${playedBefore} → ${playedAfter}`);
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  for (const c of clients) { try { c.ws.close(); } catch { /* ignore */ } }
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
