// リポジトリのルートから:  node test/roomfix.test.mjs
//
// 🚪 合言葉ルームの監査で見つかった「友達と遊ぶ導線が切れている」6件の回帰テスト。
//
// ■ ここで見るもの
//   A. **2人だけの部屋**で対戦を始めても部屋が消えない（試合後にちゃんと戻る）
//      → 旧: 観戦者ゼロだと startRoom が rooms.delete() していた。友達2人で
//        1v1 という一番普通の使い方が、対戦開始の瞬間に部屋を消していた。
//   B. そのまま2戦目が始まる／3人目が同じ合言葉で入れる
//   C. 部屋が無いときの room_start / room_set / room_seat が **無言で返らない**
//      → 旧: エラーも返さず return。押しても音だけ鳴って何も起きなかった。
//   D. 「攻撃戦」を選んだら本当に attack で始まる
//      → 旧: createMatch へ渡す式に attack の枝が無く、必ず duel に落ちていた。
//   E. 部屋のロビーにいる人は 'playing'（対戦中）ではなく 'room'
//      → 旧: 'playing' に潰していたので、先に部屋を開けて友達を呼ぶ、という
//        一番自然な順番でフレンド一覧が「対戦中」になり、招待も断られた。
//   F. 合言葉をゲーム内から渡せる（コピーボタン）と、パーティーの合言葉ルーム
//      が人数ぶんの対戦席で開く
//
// ■ test/room.test.mjs との違い
//   あちらは常に観戦者を8人目まで用意しているので、**「2人だけ」を一度も
//   踏んでいない**。A の穴が長く残った理由がそれ。ここは2人から始める。
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
const DIR = path.join(os.tmpdir(), `bba-roomfix-test-${PORT}`);
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
  let d = {}; try { d = await r.json(); } catch { /* empty body */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'roomfix-test', SEED_RESTORE: '0', MATCH_SECONDS: String(MATCH_SECS),
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

// 対戦を正規の手順で畳む（時間切れを待つと保険のタイムアウトまで引っぱられる）。
const finishBoth = (a, b) => {
  a.send({ type: 'finish', score: 900, lines: 3, combo: 1 });
  b.send({ type: 'finish', score: 400, lines: 1, combo: 1 });
};

const clients = [];
try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // -------------------------------------------------------------------------
  // A. 2人だけの部屋 — 対戦開始で部屋が消えない
  // -------------------------------------------------------------------------
  const A = await makeClient('あるじ'); clients.push(A);
  const B = await makeClient('ともだち'); clients.push(B);

  A.send({ type: 'create_room' });
  const r1 = await A.wait('room_update', 8000);
  check('A-1 部屋を作れた', !!(r1 && r1.code && r1.code.length === 4), r1 ? r1.code : 'none');
  const code = r1 ? r1.code : '';

  B.send({ type: 'join_room', code });
  const r2 = await B.wait('room_update', 8000);
  check('A-2 友達が入れた（対戦席2人）', !!(r2 && r2.players && r2.players.length === 2),
    r2 ? r2.players.map(p => `${p.name}:${p.seat}`).join(' ') : 'none');
  check('A-3 2人とも対戦席（＝観戦者ゼロ）',
    !!(r2 && r2.players.every(p => p.seat === 'play')), r2 ? r2.players.map(p => p.seat).join('/') : '');

  A.clear('room_update'); B.clear('room_update');
  A.send({ type: 'room_start' });
  const mfA = await A.wait('match_found', 8000);
  const mfB = await B.wait('match_found', 8000);
  check('A-4 2人だけでも試合が始まる', !!(mfA && mfB), `A=${!!mfA} B=${!!mfB}`);
  check('A-5 部屋の試合はレート対象外', !!(mfA && mfA.rated !== true), String(mfA && mfA.rated));

  finishBoth(A, B);
  const resA = await A.wait('result', 25000);
  check('A-6 結果が返る', !!resA, resA ? resA.outcome : 'none');

  // ここが本丸。旧実装ではこの room_update が **1件も来なかった**。
  const backA = await A.until('room_update', m => m.inMatch === false, 12000);
  const backB = await B.until('room_update', m => m.inMatch === false, 12000);
  check('A-7 試合後、2人とも部屋へ戻る（部屋が消えていない）', !!(backA && backB),
    `A=${backA ? backA.players.length + '人' : 'none'} B=${backB ? backB.players.length + '人' : 'none'}`);
  check('A-8 戻った部屋の合言葉は同じ', !!(backA && backA.code === code), backA ? backA.code : 'none');
  check('A-9 2人とも対戦席に戻っている',
    !!(backA && backA.players.length === 2 && backA.players.every(p => p.seat === 'play')),
    backA ? backA.players.map(p => `${p.name}:${p.seat}`).join(' ') : '');

  // -------------------------------------------------------------------------
  // B. 続けて遊べる — 3人目も入れる／2戦目が始まる
  // -------------------------------------------------------------------------
  const C = await makeClient('あとから'); clients.push(C);
  C.send({ type: 'join_room', code });
  const r3 = await C.wait('room_update', 8000);
  const err3 = C.last('room_error');
  check('B-1 試合後も同じ合言葉で3人目が入れる', !!(r3 && r3.code === code),
    err3 ? err3.error : (r3 ? `${r3.players.length}人` : 'none'));

  // 👑 ホストは動かない。旧実装ではホストが1試合遊ぶだけで王冠が
  //    観戦席の先頭（＝ここでは3人目）へ移り、二度と戻らなかった
  //    ── startRoom が splice で抜き、endRoomSpectate が末尾に push するため。
  check('B-2 1試合遊んでもホストは変わらない', !!(backA && backA.youAreHost),
    backA ? backA.players.map(p => `${p.name}${p.isHost ? '(host)' : ''}`).join(' ') : 'none');
  const seenByC = r3;   // wait() は取り出して消すので、受け取った本体を使う
  check('B-3 3人目から見てもホストは作った人のまま',
    !!(seenByC && seenByC.youAreHost === false
      && (seenByC.players.find(p => p.isHost) || {}).name === A.name),
    seenByC ? seenByC.players.map(p => `${p.name}${p.isHost ? '(host)' : ''}`).join(' ') : 'none');

  A.clear('match_found'); B.clear('match_found');
  A.send({ type: 'room_start' });
  const mf2 = await A.wait('match_found', 8000);
  check('B-4 そのまま2戦目が始まる', !!mf2, mf2 ? mf2.mode : (A.last('room_error') || {}).error || 'none');
  finishBoth(A, B);
  await A.wait('result', 25000);
  const back2 = await A.until('room_update', m => m.inMatch === false, 12000);
  check('B-5 2戦目のあともホストは同じ', !!(back2 && back2.youAreHost),
    back2 ? back2.players.map(p => `${p.name}${p.isHost ? '(host)' : ''}`).join(' ') : 'none');

  // -------------------------------------------------------------------------
  // C. 部屋が無いときに無言で返らない
  // -------------------------------------------------------------------------
  const D = await makeClient('よそもの'); clients.push(D);
  D.clear('room_error');
  D.send({ type: 'room_start' });
  const e1 = await D.wait('room_error', 4000);
  check('C-1 部屋にいないのに開始 → 理由が返る（無言でない）', !!e1, e1 ? e1.error : 'なにも返らない');
  D.clear('room_error');
  D.send({ type: 'room_set', settings: { mode: 'team' } });
  const e2 = await D.wait('room_error', 4000);
  check('C-2 部屋にいないのに設定変更 → 理由が返る', !!e2, e2 ? e2.error : 'なにも返らない');
  D.clear('room_error');
  D.send({ type: 'room_seat', name: 'だれか', seat: 'watch' });
  const e3 = await D.wait('room_error', 4000);
  check('C-3 部屋にいないのに席替え → 理由が返る', !!e3, e3 ? e3.error : 'なにも返らない');
  // ホスト以外の設定変更も無言だった。
  C.clear('room_error');
  C.send({ type: 'room_set', settings: { mode: 'team' } });
  const e4 = await C.wait('room_error', 4000);
  check('C-4 ホスト以外の設定変更 → 理由が返る', !!e4, e4 ? e4.error : 'なにも返らない');

  // -------------------------------------------------------------------------
  // D. 攻撃戦を選んだら attack で始まる
  // -------------------------------------------------------------------------
  A.clear('room_update');
  A.send({ type: 'room_set', settings: { mode: 'attack' } });
  const setOk = await A.until('room_update', m => m.settings && m.settings.mode === 'attack', 6000);
  check('D-1 部屋の設定で「攻撃戦」を選べる', !!setOk, setOk ? setOk.settings.mode : 'none');
  check('D-2 攻撃戦の対戦席は1v1と同じ2席', !!(setOk && setOk.seats === 2), String(setOk && setOk.seats));

  A.clear('match_found'); B.clear('match_found');
  A.send({ type: 'room_start' });
  const mfAtk = await A.wait('match_found', 8000);
  check('D-3 攻撃戦が本当に attack で始まる（duel に落ちない）',
    !!(mfAtk && mfAtk.mode === 'attack'), mfAtk ? mfAtk.mode : (A.last('room_error') || {}).error || 'none');
  // この時点で3人いるので、席に座っているのが誰かはローテーション次第。
  // 全員に申告させる（出ていない人のぶんはサーバーが無視する）。
  for (const c2 of [A, B, C]) c2.send({ type: 'finish', score: 700, lines: 2, combo: 1 });
  await A.wait('result', 25000);
  await A.until('room_update', m => m.inMatch === false, 12000);

  // -------------------------------------------------------------------------
  // E. ロビーで待っている人は「対戦中」ではない
  // -------------------------------------------------------------------------
  const tokA = (await j('/api/register', { method: 'POST', body: { username: 'よぶひと', password: 'pw-roomfix-1' } })).token;
  const tokB = (await j('/api/register', { method: 'POST', body: { username: 'よばれるひと', password: 'pw-roomfix-1' } })).token;
  check('E-0 下ごしらえ: 2アカウント作れた', !!(tokA && tokB), '');
  // すれ違い申請はその場で成立する（friends.js）。
  await j('/api/friends/request', { method: 'POST', body: { username: 'よばれるひと' } }, tokA);
  await j('/api/friends/request', { method: 'POST', body: { username: 'よぶひと' } }, tokB);
  const fv0 = await j('/api/friends', {}, tokA);
  check('E-1 フレンドになった', !!(fv0.friends && fv0.friends.length === 1), `${(fv0.friends || []).length}人`);

  const P1 = await makeClient(null, tokA); clients.push(P1);
  const P2 = await makeClient(null, tokB); clients.push(P2);
  await sleep(300);
  const fvMenu = await j('/api/friends', {}, tokA);
  check('E-2 メニューにいる人は menu', ((fvMenu.friends || [])[0] || {}).status === 'menu',
    ((fvMenu.friends || [])[0] || {}).status);

  P2.send({ type: 'create_room' });
  const pr = await P2.wait('room_update', 8000);
  check('E-3 下ごしらえ: 相手が部屋を開けた', !!(pr && pr.code), pr ? pr.code : 'none');
  await sleep(300);
  const fvRoom = await j('/api/friends', {}, tokA);
  const st = ((fvRoom.friends || [])[0] || {}).status;
  check('E-4 部屋のロビーにいる人は「対戦中」ではない', st !== 'playing', String(st));
  check('E-5 その状態は room として区別できる', st === 'room', String(st));

  // 招待が通る（旧: 『対戦中のメンバーがいます』で必ず断られた）。
  P1.clear('party_error'); P1.clear('party_update');
  P1.send({ type: 'party_create' });
  await P1.wait('party_update', 6000);
  P1.clear('party_error');
  P1.send({ type: 'party_invite', userId: ((fvRoom.friends || [])[0] || {}).id });
  await sleep(700);
  const pe = P1.last('party_error');
  const inv = P2.last('party_invite');
  check('E-6 部屋で待っている友達を招待できる', !pe && !!inv,
    pe ? pe.error : (inv ? 'とどいた' : '招待が届かない'));

  // -------------------------------------------------------------------------
  // F. クライアント側（合言葉のコピー・パーティーの席数）
  // -------------------------------------------------------------------------
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  const html = read('public/index.html');
  const modes = read('public/js/modes.js');
  const i18n = read('public/js/i18n.js');
  const css = read('public/css/style.css');
  const friendsJs = read('public/js/friends.js');
  const partyJs = read('public/js/party.js');

  check('F-1 合言葉のコピーボタンがある', /id="btnCopyRoomCode"/.test(html), '');
  // i18n.js は .room-code の innerHTML を丸ごと差し替えるので、ボタンを
  // その内側に置くと英語表示で消える。外に出ていることを機械で見る。
  const codeDiv = html.match(/<div class="room-code">[\s\S]*?<\/div>/);
  check('F-2 コピーボタンは .room-code の外にある（英語化で消えない）',
    !!codeDiv && !/btnCopyRoomCode/.test(codeDiv[0]), '');
  check('F-3 コピーボタンが配線されている', /#btnCopyRoomCode/.test(modes), '');
  check('F-4 クリップボードが使えない環境への退避がある',
    /btnCopyRoomCode[\s\S]{0,900}execCommand\('copy'\)/.test(modes), '');
  check('F-5 コピーボタンに英語がある', /btnCopyRoomCode', 'Copy'/.test(i18n), '');
  check('F-6 合言葉は長押しでも選べる（body の user-select:none を打ち消す）',
    /\.room-code b \{[^}]*user-select: text/.test(css), '');

  check('F-7 パーティーの合言葉ルームは人数を受け取る',
    /createPartyRoom\(mode, size = 2\)/.test(modes), '');
  check('F-8 3人以上なら4席（team）で開く',
    /mode === 'custom' \? \(size >= 3 \? 'team' : 'duel'\) : mode/.test(modes), '');
  check('F-9 呼び出し側が人数を渡している',
    /createPartyRoom\(msg\.mode, state \? state\.members\.length : 2\)/.test(partyJs), '');

  check('F-10 フレンド一覧に room の表示がある', /\n  room: \(\) => t\(/.test(friendsJs), '');
  check('F-11 パーティー一覧に room の表示がある', /\n  room: \(\) => t\(/.test(partyJs), '');
  check('F-12 room の並び順が決まっている', /order = \{ menu: 0, room: 1, playing: 2, offline: 3 \}/.test(friendsJs), '');
  check('F-13 room の色がある', /\.fr-status\.room \{/.test(css), '');

  // -------------------------------------------------------------------------
  // G. 直したことで壊していないか（サーバー側の後始末）
  // -------------------------------------------------------------------------
  const before = await j('/api/admin/stats', {}, null);
  // 管理APIは開いていないので、部屋が残っていないことは join で確かめる。
  for (const c2 of [A, B, C]) { c2.send({ type: 'room_leave' }); }
  await sleep(500);
  const E2 = await makeClient('さいごのひと'); clients.push(E2);
  E2.send({ type: 'join_room', code });
  const gone = await E2.wait('room_error', 4000);
  check('G-1 全員が抜けた部屋はちゃんと消える（残骸が残らない）',
    !!(gone && /見つかりません/.test(gone.error)), gone ? gone.error : '入れてしまった');
  check('G-2 統計APIは認証必須のまま', before.status === 401 || before.status === 403, String(before.status));

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  for (const c of clients) { try { c.ws.close(); } catch { /* 閉じるだけ */ } }
  await sleep(300);
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🚪 合言葉ルーム — 導線の穴6件\n');
for (const [m, n, d] of results) console.log(`${m} ${n}${d ? `  (${d})` : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
