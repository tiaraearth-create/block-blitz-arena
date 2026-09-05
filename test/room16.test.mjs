// リポジトリのルートから:  node test/room16.test.mjs
//
// 🚪 カスタムルームの拡張（2026-09-06 ユーザー要望）の回帰テスト。
//   「8人までじゃなくて16人までにしてくれませんか？
//     そして…チームを変えられるようにしたり人数を操作出来るようにしてほしいです。」
//
// ■ ここで見るもの
//   A. 定員16人・対戦する人数をホストが選べる（モードごとに成立する上限つき）
//   B. 席ごとのチーム指定（A/B）が、実際の試合のチーム分けに効く
//   C. 人を指すのが**席番号**であること（表示名はゲストどうしで重複できる）
//   D. ★ 部屋の試合は **人数にもモードにもよらず練習試合**
//      席を選べるようにした瞬間、これが無いと「1人＋ボット15人で必勝ボタン」になる
//      （実測: 席2の部屋で勝つと totalWins 0→0、席16の部屋で勝つと 0→1 だった）
//
// ■ 塞ぎすぎていないことも見る
//   ・1つの盤面を交互に使う協力・陣取りと、お邪魔の量が人数で壊れる攻撃戦は2人固定
//   ・遊んだ記録（gamesPlayed・スコア）は練習試合でもちゃんと残る
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-room16-test-${PORT}`);
const MATCH_SECS = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なしもある */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'room16-test', SEED_RESTORE: '0', MATCH_SECONDS: String(MATCH_SECS),
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
    last: type => (inbox[type] || [])[(inbox[type] || []).length - 1],
    clear: type => { inbox[type] = []; },
    async wait(type, timeout = 12000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) return null;
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
    (async () => { const ok = await c.wait('hello_ok', 8000); if (ok) c.name = ok.name; res(c); })().catch(rej);
  });
}

const clients = [];
try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // -------------------------------------------------------------------------
  // A. 定員と席数
  // -------------------------------------------------------------------------
  const A = await makeClient('あるじ'); clients.push(A);
  A.send({ type: 'create_room', settings: { mode: 'duel' } });
  const r1 = await A.wait('room_update', 8000);
  check('A-1 定員が16人になった', r1 && r1.max === 16, `max=${r1 && r1.max}`);
  check('A-2 1v1 の既定は2席', r1 && r1.seats === 2, `seats=${r1 && r1.seats}`);

  A.clear('room_update');
  A.send({ type: 'room_set', settings: { seats: 8 } });
  const r2 = await A.until('room_update', m => m.seats === 8, 6000);
  check('A-3 1v1 でも対戦する人数を選べる', !!r2, r2 ? `seats=${r2.seats}` : 'none');

  A.clear('room_update');
  A.send({ type: 'room_set', settings: { mode: 'team', seats: 16 } });
  const r3 = await A.until('room_update', m => m.settings.mode === 'team', 6000);
  check('A-4 2v2チームは16席まで', !!(r3 && r3.seats === 16), `seats=${r3 && r3.seats}`);

  // ★ 塞ぎすぎ・緩すぎの両側。1盤面を交互に使うモードとお邪魔の経済が壊れる
  //   モードは2人固定でなければならない。
  for (const [mode, why] of [['coop', '1盤面を交互に使う'], ['land', '領土の数え方が2人前提'], ['attack', 'お邪魔の量が人数で壊れる']]) {
    A.clear('room_update');
    A.send({ type: 'room_set', settings: { mode, seats: 16 } });
    const r = await A.until('room_update', m => m.settings.mode === mode, 6000);
    check(`A-5 ${mode} は席を増やせない（${why}）`, !!(r && r.seats === 2), `seats=${r && r.seats}`);
  }

  // -------------------------------------------------------------------------
  // B/C. 席ごとのチーム指定（席番号で指す）
  // -------------------------------------------------------------------------
  const code = r1.code;
  A.clear('room_update');
  A.send({ type: 'room_set', settings: { mode: 'team', seats: 4 } });
  await A.until('room_update', m => m.settings.mode === 'team' && m.seats === 4, 6000);

  const others = [];
  for (let i = 1; i <= 3; i++) {
    const c = await makeClient(`なかま${i}`); clients.push(c); others.push(c);
    c.send({ type: 'join_room', code });
    await c.wait('room_update', 8000);
    await sleep(150);
  }
  await sleep(400);
  const seated = A.last('room_update');
  check('B-0 4人が対戦席に座った', !!(seated && seated.players.length === 4),
    seated ? `${seated.players.length}人` : 'none');
  check('C-1 席に番号が振られている（表示名で指さない）',
    !!(seated && seated.players.every((p, i) => p.idx === i)),
    seated ? seated.players.map(p => p.idx).join(',') : '');

  // 既定は「前半A・後半B」
  A.clear('room_update');
  A.send({ type: 'room_team', idx: 1, team: 1 });
  const t1 = await A.until('room_update', m => (m.players[1] || {}).team === 1, 6000);
  check('B-1 ホストが席のチームを変えられる', !!t1,
    t1 ? t1.players.map(p => `${p.name}:${p.team}`).join(' ') : 'none');

  // ホスト以外は変えられない
  others[0].clear('room_error');
  others[0].send({ type: 'room_team', idx: 0, team: 1 });
  const e1 = await others[0].wait('room_error', 4000);
  check('B-2 ホスト以外は変えられない', !!(e1 && /ホスト/.test(e1.error)), e1 ? e1.error : 'なにも返らない');

  // 2v2 以外では断る
  A.clear('room_error'); A.clear('room_update');
  A.send({ type: 'room_set', settings: { mode: 'duel', seats: 4 } });
  await A.until('room_update', m => m.settings.mode === 'duel', 6000);
  A.clear('room_error');
  A.send({ type: 'room_team', idx: 1, team: 1 });
  const e2 = await A.wait('room_error', 4000);
  check('B-3 2v2以外では理由を返して断る', !!(e2 && /チーム/.test(e2.error)), e2 ? e2.error : 'なにも返らない');

  // ★ 実際の試合のチーム分けに効くか
  A.clear('room_update');
  A.send({ type: 'room_set', settings: { mode: 'team', seats: 4 } });
  await A.until('room_update', m => m.settings.mode === 'team' && m.seats === 4, 6000);
  // 席0,1 を A に、席2,3 を B に（既定と同じだが明示して指定する）
  for (const [idx, team] of [[0, 0], [1, 0], [2, 1], [3, 1]]) {
    A.send({ type: 'room_team', idx, team });
    await sleep(120);
  }
  await sleep(400);
  for (const c of [A, ...others]) c.clear('match_found');
  A.send({ type: 'room_start' });
  const mfA = await A.wait('match_found', 8000);
  const mf1 = await others[0].wait('match_found', 8000);
  const mf2 = await others[1].wait('match_found', 8000);
  const mf3 = await others[2].wait('match_found', 8000);
  check('B-4 4人で2v2の試合が始まる', !!(mfA && mf1 && mf2 && mf3), '');
  const teams = [mfA, mf1, mf2, mf3].map(m => m && m.you && m.you.team);
  check('B-5 指定どおりのチーム分けで始まる（2 vs 2）',
    JSON.stringify(teams) === JSON.stringify([0, 0, 1, 1]), JSON.stringify(teams));

  // -------------------------------------------------------------------------
  // D. ★ 部屋の試合は人数にもモードにもよらず練習試合
  // -------------------------------------------------------------------------
  const tok = (await j('/api/register', { method: 'POST', body: { username: 'れんしゅう', password: 'pw-room16-1' } })).token;
  const me0 = (await j('/api/me', {}, tok)).user;
  const H = await makeClient(null, tok); clients.push(H);
  H.send({ type: 'create_room', settings: { mode: 'duel', seats: 8, botFill: true } });
  const rh = await H.wait('room_update', 8000);
  check('D-0 下ごしらえ: 8席の部屋を作れた', !!(rh && rh.seats === 8), `seats=${rh && rh.seats}`);
  H.send({ type: 'room_start' });
  const mfH = await H.wait('match_found', 8000);
  check('D-1 1人＋ボット7人で試合が始まる', !!(mfH && (mfH.players || []).length === 8),
    mfH ? `${(mfH.players || []).length}人` : 'none');
  H.send({ type: 'finish', score: 999999, lines: 40, combo: 8 });
  const res = await H.wait('result', 25000);
  check('D-2 結果が返る', !!res, res ? res.outcome : 'none');
  check('D-3 練習試合の印が付く（人数によらず）', res && res.friendly === 'room', String(res && res.friendly));
  const me1 = (await j('/api/me', {}, tok)).user;
  check('D-4 勝ち星が付かない', (me1.stats.totalWins || 0) === (me0.stats.totalWins || 0),
    `${me0.stats.totalWins || 0} → ${me1.stats.totalWins || 0}`);
  check('D-5 連勝も動かない', (me1.stats.winStreak || 0) === (me0.stats.winStreak || 0),
    `${me0.stats.winStreak || 0} → ${me1.stats.winStreak || 0}`);
  check('D-6 PvP勝利数も動かない', (me1.stats.pvpWins || 0) === (me0.stats.pvpWins || 0),
    `${me0.stats.pvpWins || 0} → ${me1.stats.pvpWins || 0}`);
  // 塞ぎすぎていないこと ── 遊んだ事実は残る。
  check('D-7 遊んだ記録は残る（塞ぎすぎていない）',
    (me1.stats.gamesPlayed || 0) > (me0.stats.gamesPlayed || 0),
    `${me0.stats.gamesPlayed || 0} → ${me1.stats.gamesPlayed || 0}`);

  // -------------------------------------------------------------------------
  // E. ソースの形（片方だけ直る事故を防ぐ）
  // -------------------------------------------------------------------------
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  const battle = read('server/battle.js');
  const modes = read('public/js/modes.js');
  check('E-1 練習試合の判定が部屋ぜんたいに掛かる',
    /const inRoom = !!match\.roomCode && !match\.rated && !match\.tourney;/.test(battle), '');
  check('E-2 席の指定が1か所の関数に寄っている', /function roomTargetOf\(room, msg\)/.test(battle), '');
  check('E-3 画面も席番号で送る', /type: 'room_seat', idx: Number\(b\.dataset\.seatIdx\)/.test(modes), '');
  check('E-4 空き席は1行にまとめる（16席で画面が伸びない）',
    /空き席 ×\$\{openCount\}/.test(modes), '');
  check('E-5 チーム分けの既定式が画面とサーバーで揃っている',
    /const half = Math\.ceil\(need \/ 2\);/.test(battle) && /const half = Math\.ceil\(playSeats \/ 2\);/.test(modes), '');
  check('E-6 ボットは人数の少ないチームへ入る', /a <= b \? 0 : 1/.test(battle), '');

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  for (const c of clients) { try { c.ws.close(); } catch { /* 閉じるだけ */ } }
  await sleep(300);
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🚪 16人ルーム・チーム・人数\n');
for (const [m, n, d] of results) console.log(`${m} ${n}${d ? `  (${d})` : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
