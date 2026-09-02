// リポジトリのルートから:  node test/adminonline.test.mjs
//
// 👀 いま誰がオンラインか（/api/admin/online）。
//
// ■ この面が何をするものか
// 運営が見られたのは「オンライン人数」という数字だけで、しかもそれは住人
// （にぎわい）を足した表示用の数だった。「いま誰が来ていて、何をしているか」
// を名前つきで出すのがこの口。つまり **実プレイヤーの現在地そのもの** なので、
// 見せてよい相手を1人でも間違えたら、その瞬間に個人の行動の流出になる。
//
// ■ だからこのファイルで見るのは3つ
//   ① 権限 ── 未ログインは 401、一般プレイヤーもモデレーターも 403、
//      管理者だけ 200。しかも 403 の本文に一覧の欠片も乗っていないこと
//      （「断ってはいるが本文に players が入っている」は実際に起きる事故）。
//   ② 中身 ── 実際に WebSocket でつないだ人が、名前・接続してからの時間・
//      いま何をしているか（メニュー／対戦画面／マッチング待ち／ルーム／対戦中）
//      つきで並ぶこと。ゲストも並ぶこと。
//   ③ まとめ方 ── 同じ人が複数タブ／端末でつないでも **1行** になり、
//      接続本数（conns）がそこに乗ること。対戦画面に入ると2本になるので、
//      これが効かないと「オンライン人数」が実人数の倍近くまで膨らむ。
//
// あわせて、住人（AI）の席が実プレイヤーと **別の入れ物** で返ること
// （混ぜた1本の配列にすると、その行を誰かが非管理者の画面へ持って行った
// 瞬間に正体ごと漏れる）と、件数の上限・絞り込みが効くことを見る。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
// ⚠ DATA_DIR には必ずポートを混ぜる（並列で走る他のテストと踏み合わないため）。
const DIR = path.join(os.tmpdir(), `bba-adminonline-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: d };
};

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// 403 / 401 の本文に「一覧の欠片」が乗っていないか。キー名で機械的に探す。
const LEAK_KEYS = [
  'players', 'residents', 'seats', 'totals', 'sockets', 'conns', 'act',
  'caveats', 'matched', 'since', 'userId', 'guest', 'online',
];
function leaks(value, at = '$') {
  const found = [];
  const walk = (v, path0, depth) => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path0}[${i}]`, depth + 1)); return; }
    for (const k of Object.keys(v)) {
      if (LEAK_KEYS.includes(k)) found.push(`${path0}.${k}`);
      walk(v[k], `${path0}.${k}`, depth + 1);
    }
  };
  walk(value, at, 0);
  return found;
}

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'adminonline-test', SEED_RESTORE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* not up */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

// hello_ok まで待つ小さなWSクライアント。名乗る前の socket は一覧に出ない
// 決まりなので、hello_ok を待たずに読むと「まだ居ない」を拾って偽の失敗になる。
// role:'battle' を渡すと、対戦画面の2本目と同じ扱い（ws.secondary）になる。
function connect(token, { role = null, guestName = null } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.inbox = [];
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('hello_ok timeout')), 8000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      ws.inbox.push(m);
      if (m.type === 'hello_ok') { clearTimeout(to); ws.myName = m.name; res(ws); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, role, guestName })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
}
const sendWs = (ws, msg) => ws.send(JSON.stringify(msg));
async function closeAndSettle(ws) {
  await new Promise(res => { ws.on('close', res); ws.close(); });
  await sleep(300);
}

// 一覧から名前で1行引く。
const rowOf = (body, name) => (body.players || []).find(p => p.name === name) || null;

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const login = (name, password) => j('/api/login', { method: 'POST', body: { username: name, password } });
  const atk = (await login('るみまき', adminPw)).body.token;
  check('管理者でログインできる', !!atk);

  const p1 = await j('/api/register', { method: 'POST', body: { username: 'あおぞら', password: 'pass1234' } });
  const p2 = await j('/api/register', { method: 'POST', body: { username: 'こもれび', password: 'pass1234' } });
  const uid1 = p1.body.user && p1.body.user.id;
  const uid2 = p2.body.user && p2.body.user.id;
  check('検証用のプレイヤーを用意できた', !!uid1 && !!uid2,
    `${p1.body.error || ''} ${p2.body.error || ''}`.trim());
  await j(`/api/admin/users/${uid2}`, { method: 'POST', body: { role: 'mod' } }, atk);
  const tok1 = (await login('あおぞら', 'pass1234')).body.token;
  const modTok = (await login('こもれび', 'pass1234')).body.token;
  check('一般プレイヤーとモデレーターを用意できた', !!tok1 && !!modTok);

  // -------------------------------------------------------------------------
  // 1. 権限（401 / 403 / 200）
  // -------------------------------------------------------------------------
  const anon = await j('/api/admin/online');
  check('1-a 未ログインは 401', anon.status === 401, `status=${anon.status}`);
  const asUser = await j('/api/admin/online', {}, tok1);
  check('1-b 一般プレイヤーは 403', asUser.status === 403, `status=${asUser.status}`);
  const asMod = await j('/api/admin/online', {}, modTok);
  check('1-c モデレーターも 403（オンライン一覧は管理者だけ）', asMod.status === 403, `status=${asMod.status}`);
  const asAdmin = await j('/api/admin/online', {}, atk);
  check('1-d 管理者は 200', asAdmin.status === 200, asAdmin.body.error || '');
  check('1-e 管理者の応答に players / residents の器がある',
    Array.isArray(asAdmin.body.players) && Array.isArray(asAdmin.body.residents),
    Object.keys(asAdmin.body).join(', '));
  check('1-f 内訳が取れている（detailed）', asAdmin.body.detailed === true, `detailed=${asAdmin.body.detailed}`);

  // -------------------------------------------------------------------------
  // 2. 非管理者には1件も取れない
  // -------------------------------------------------------------------------
  for (const [label, r] of [['未ログイン', anon], ['一般プレイヤー', asUser], ['モデレーター', asMod]]) {
    const bad = leaks(r.body, label);
    check(`2 ${label} の応答に一覧の欠片が1件も乗っていない`, bad.length === 0, bad.join(' / '));
  }
  check('2-z 断りの本文は error（と errorEn / code）だけ',
    Object.keys(asUser.body).every(k => k === 'error' || k === 'errorEn' || k === 'code'),
    Object.keys(asUser.body).join(', '));

  // -------------------------------------------------------------------------
  // 3. 実際につないだ人が、名前・接続時間・状態つきで並ぶ
  // -------------------------------------------------------------------------
  const chat1 = await connect(tok1);                 // 常時接続（チャット用）
  await sleep(300);
  let list = (await j('/api/admin/online', {}, atk)).body;
  let me = rowOf(list, 'あおぞら');
  check('3-a つないだ実プレイヤーが一覧に出る', !!me, (list.players || []).map(p => p.name).join(', '));
  check('3-b 接続してからの時間が出る（いつ繋いだか＋経過）',
    !!me && me.since > 0 && Date.now() - me.since < 60000 && me.ms >= 0,
    me ? `since=${me.since} ms=${me.ms}` : '—');
  check('3-c まだ何もしていない人は「メニュー」',
    !!me && me.act === 'menu' && me.label === 'メニュー', me ? `${me.act}/${me.label}` : '—');
  check('3-d 実プレイヤーだと分かる欄がある（管理者向け）',
    !!me && me.guest === false && me.userId === uid1 && me.conns === 1,
    me ? JSON.stringify({ guest: me.guest, conns: me.conns }) : '—');
  check('3-e 「分からないこと」が応答に添えられている',
    Array.isArray(list.caveats) && list.caveats.length >= 1, JSON.stringify(list.caveats));

  // -------------------------------------------------------------------------
  // 4. 同じ人の複数接続が1行にまとまる
  // -------------------------------------------------------------------------
  const battle1 = await connect(tok1, { role: 'battle' });   // 対戦画面の2本目
  await sleep(300);
  list = (await j('/api/admin/online', {}, atk)).body;
  const mine = (list.players || []).filter(p => p.name === 'あおぞら');
  check('4-a 2本つないでも行は1つ', mine.length === 1, `${mine.length}行`);
  check('4-b 接続本数が行に乗る', mine[0] && mine[0].conns === 2, mine[0] ? `conns=${mine[0].conns}` : '—');
  check('4-c 対戦画面を開いていると分かる',
    mine[0] && mine[0].act === 'online', mine[0] ? `${mine[0].act}/${mine[0].label}` : '—');
  check('4-d 人数（people）と接続本数（conns）が別々に数えられている',
    list.totals && list.totals.people === (list.players || []).length && list.totals.conns >= 2,
    JSON.stringify(list.totals));

  // -------------------------------------------------------------------------
  // 5. ゲスト（未ログイン）も出る
  // -------------------------------------------------------------------------
  const guest = await connect(null, { guestName: 'とおりすがり' });
  await sleep(300);
  list = (await j('/api/admin/online', {}, atk)).body;
  const g = rowOf(list, guest.myName);
  check('5-a ゲストも一覧に出る', !!g, `name=${guest.myName}`);
  check('5-b ゲストだと分かる（userId は無い）',
    !!g && g.guest === true && g.userId === null, g ? JSON.stringify({ guest: g.guest, userId: g.userId }) : '—');
  check('5-c ゲストにも接続時間が出る', !!g && g.since > 0, g ? `since=${g.since}` : '—');
  // アカウントが無い＝レベルもレートも「無い」。0 で返すと画面が
  // 「Lv.0 ・ R0」と出し、レベル0の人が居るように見える（実際にそうなっていた）。
  check('5-d ゲストのレベル／レートは 0 ではなく null（無いものは無いまま）',
    !!g && g.level === null && g.rating === null,
    g ? JSON.stringify({ level: g.level, rating: g.rating }) : '—');
  const meRow = rowOf(list, 'あおぞら');
  check('5-e 登録済みの人にはレベルとレートが入る',
    !!meRow && typeof meRow.level === 'number' && typeof meRow.rating === 'number',
    meRow ? JSON.stringify({ level: meRow.level, rating: meRow.rating }) : '—');
  check('5-f ゲストの人数も数えられている', list.totals && list.totals.guests >= 1, JSON.stringify(list.totals));

  // -------------------------------------------------------------------------
  // 6. マッチング待ち（モードと待ち秒）
  // -------------------------------------------------------------------------
  // チーム戦は4人そろうまで並ぶ（ボット補充は5〜10秒後）。並んだ直後に読む。
  sendWs(battle1, { type: 'queue', mode: 'team' });
  await sleep(400);
  list = (await j('/api/admin/online', {}, atk)).body;
  me = rowOf(list, 'あおぞら');
  check('6-a マッチング待ちが状態に出る', !!me && me.act === 'queue', me ? `${me.act}/${me.label}` : '—');
  check('6-b どのモードで待っているかが出る', !!me && me.mode === 'team', me ? `mode=${me.mode}` : '—');
  check('6-c 待ち秒が添えられている', !!me && /待機/.test(me.detail || ''), me ? `detail=${me.detail}` : '—');
  sendWs(battle1, { type: 'cancel_queue' });
  await sleep(400);

  // -------------------------------------------------------------------------
  // 7. 合言葉ルームで待機
  // -------------------------------------------------------------------------
  sendWs(battle1, { type: 'create_room', settings: {} });
  await sleep(500);
  const roomMsg = battle1.inbox.filter(m => m.type === 'room_update').slice(-1)[0];
  check('7-a ルームを作れた', !!(roomMsg && roomMsg.code), roomMsg ? '' : 'room_update が来ない');
  list = (await j('/api/admin/online', {}, atk)).body;
  me = rowOf(list, 'あおぞら');
  check('7-b ルームで待機している人がそう出る',
    !!me && me.act === 'room' && me.label === 'ルームで待機', me ? `${me.act}/${me.label}` : '—');
  check('7-c 合言葉とホストかどうかが添えられている',
    !!me && roomMsg && me.detail.includes(roomMsg.code) && /ホスト/.test(me.detail),
    me ? `detail=${me.detail}` : '—');
  sendWs(battle1, { type: 'room_leave' });
  await sleep(400);

  // -------------------------------------------------------------------------
  // 8. 対戦中（＋住人の席が別の入れ物で返る）
  // -------------------------------------------------------------------------
  // 1on1 に並ぶと 4〜9秒でAI側の席が埋まる（掃除は2秒ごと）。
  sendWs(battle1, { type: 'queue', mode: 'duel' });
  let inMatch = null, seats = [];
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const b = (await j('/api/admin/online', {}, atk)).body;
    const r = rowOf(b, 'あおぞら');
    if (r && r.act === 'match') { inMatch = r; seats = b.residents || []; list = b; break; }
  }
  check('8-a 対戦が始まると「対戦中」になる',
    !!inMatch && inMatch.label === '対戦中', inMatch ? `${inMatch.act}/${inMatch.label}` : 'タイムアウト');
  check('8-b どのモードで対戦中かが出る（経過秒つき）',
    !!inMatch && inMatch.mode === 'duel' && /経過/.test(inMatch.detail || ''),
    inMatch ? `mode=${inMatch.mode} detail=${inMatch.detail}` : '—');
  check('8-c 住人の席は residents（実プレイヤーとは別の入れ物）に入る',
    seats.length >= 1 && seats.some(s => s.act === 'match'),
    `${seats.length}席: ${seats.map(s => `${s.name}/${s.act}`).join(', ')}`);
  check('8-d 住人には接続時間が無い（socket を持たないので null で来る）',
    seats.every(s => s.since === null && s.conns === null),
    JSON.stringify(seats.slice(0, 2)));
  // players 側に住人が混ざっていないこと。つないでいるのは
  // あおぞら（2本）とゲスト1人だけなので、それ以外の名前が出たら混入。
  const known = new Set(['あおぞら', guest.myName]);
  const strangers = (list.players || []).map(p => p.name).filter(n => !known.has(n));
  check('8-e players に住人が1件も混ざっていない', strangers.length === 0, strangers.join(', '));
  check('8-f 住人の数は実プレイヤーの数と足されていない',
    list.totals && list.totals.people === (list.players || []).length
    && typeof list.totals.residentSeats === 'number',
    JSON.stringify(list.totals));

  // -------------------------------------------------------------------------
  // 9. 上限と絞り込み
  // -------------------------------------------------------------------------
  const ADMIN_SRC = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'admin.js'), 'utf8');
  const capMatch = ADMIN_SRC.match(/const\s+ONLINE_LIMIT_MAX\s*=\s*(\d+)/);
  const CAP = capMatch ? Number(capMatch[1]) : null;
  check('9-a 実装から件数上限を読めた', Number.isFinite(CAP) && CAP > 0, `ONLINE_LIMIT_MAX=${CAP}`);
  const huge = await j('/api/admin/online?limit=99999', {}, atk);
  check('9-b limit は上限で頭打ちになる', huge.body.limit === CAP, `limit=${huge.body.limit} / 上限=${CAP}`);
  const one = await j('/api/admin/online?limit=1', {}, atk);
  check('9-c limit で行数が絞られる（総数は matched に残る）',
    (one.body.players || []).length === 1 && one.body.matched.players >= 1,
    `players=${(one.body.players || []).length} matched=${one.body.matched && one.body.matched.players}`);
  const q = await j(`/api/admin/online?q=${encodeURIComponent('あおぞ')}`, {}, atk);
  check('9-d 名前で絞り込める',
    (q.body.players || []).length === 1 && q.body.players[0].name === 'あおぞら',
    (q.body.players || []).map(p => p.name).join(', '));
  const onlyPlayers = await j('/api/admin/online?only=players', {}, atk);
  check('9-e only=players なら住人は1件も返らない',
    (onlyPlayers.body.residents || []).length === 0 && (onlyPlayers.body.players || []).length >= 1,
    `residents=${(onlyPlayers.body.residents || []).length}`);
  const crowd = await j('/api/admin/online?crowd=1', {}, atk);
  check('9-f crowd=1 でも器の形は同じ（POP_SCALE=0 なのでロビーは空）',
    crowd.status === 200 && Array.isArray(crowd.body.residents) && crowd.body.crowd === true,
    `status=${crowd.status}`);

  // -------------------------------------------------------------------------
  // 10. 人が居る状態でも、非管理者からは1件も取れない
  // -------------------------------------------------------------------------
  const asUser2 = await j('/api/admin/online', {}, tok1);
  const asMod2 = await j('/api/admin/online?crowd=1&limit=500', {}, modTok);
  const anon2 = await j('/api/admin/online?only=players');
  check('10-a 人が居ても一般プレイヤーは 403', asUser2.status === 403, `status=${asUser2.status}`);
  check('10-b 人が居てもモデレーターは 403', asMod2.status === 403, `status=${asMod2.status}`);
  check('10-c 人が居ても未ログインは 401', anon2.status === 401, `status=${anon2.status}`);
  for (const [label, r] of [['一般プレイヤー', asUser2], ['モデレーター', asMod2], ['未ログイン', anon2]]) {
    check(`10-d ${label} の応答に名前が1件も乗っていない`,
      !JSON.stringify(r.body).includes('あおぞら') && leaks(r.body, label).length === 0,
      JSON.stringify(r.body).slice(0, 120));
  }

  // -------------------------------------------------------------------------
  // 11. 切れたら一覧から消える
  // -------------------------------------------------------------------------
  await closeAndSettle(guest);
  await closeAndSettle(battle1);
  await closeAndSettle(chat1);
  const after = (await j('/api/admin/online', {}, atk)).body;
  check('11-a 切断した人は一覧から消える',
    !rowOf(after, 'あおぞら') && !rowOf(after, guest.myName),
    (after.players || []).map(p => p.name).join(', '));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
const failed = results.filter(r => r[0] === '❌').length;
console.log('');
console.log(`${failed ? '❌' : '✅'} ${results.length - failed} 件成功 / ${failed} 件失敗`);
