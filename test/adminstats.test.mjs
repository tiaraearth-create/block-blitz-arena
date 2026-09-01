// リポジトリのルートから:  node test/adminstats.test.mjs
//
// 📊 プレイヤー統計（/api/admin/playerstats と /api/admin/playerstats/:id）。
//
// この面は「誰がいつオンラインだったか」を運営に見せるためのものなので、
// 見せてよい相手を1人でも間違えると、そのまま個人の行動履歴の流出になる。
// だからこのファイルで見るのは大きく2つ:
//
//   ① 権限 ── 未ログインは 401、一般プレイヤーとモデレーターは 403、
//      管理者だけ 200。しかも 403 の応答には統計の欠片も乗っていないこと
//      （「エラーだけど本文に users が入っている」が実際に起きやすい事故）。
//   ② 住人（AI）と実プレイヤーの区別が、管理者にだけ見えること。
//      運営には区別が要る（にぎわいの数字と実際の客足を取り違えると
//      判断を誤る）が、非管理者には1件も出してはいけない。
//
// あわせて、一覧に件数上限があること（db.users は上限なしに増えるので、
// 全員を1回で返すと応答が膨れる）と、個人の詳細が返ることを見る。
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
const DIR = path.join(os.tmpdir(), 'bba-adminstats-test');
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

// 応答のどこかに「統計の欠片」が乗っていないか。403 の本文に users が
// 混ざる、というのは実際に起きる事故なので、キー名で機械的に探す。
const LEAK_KEYS = [
  'users', 'summary', 'residents', 'players', 'trend', 'modes',
  'playSecs', 'lastOnline', 'lastSeen', 'lastLoginAt', 'logins', 'online',
  'history', 'adminActions',
];
function leaks(value, at = '') {
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

// 在席区間の最短時間。既定は20秒で、テストで待つには長すぎる。
// 「短い区間は積まない」規則そのものは動かさず、しきい値だけ下げる。
const SPAN_MIN_MS = 400;

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'adminstats-test', SEED_RESTORE: '0',
      ONLINE_SPAN_MIN_MS: String(SPAN_MIN_MS),
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

// hello_ok まで待つ小さなWSクライアント。在席区間を積むのは battle.js の
// hello / close なので、実際につないで切らないと記録が生まれない。
function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('hello_ok timeout')), 8000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'hello_ok') { clearTimeout(to); res(ws); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
}
// close が**サーバー側で**処理されるまで待つ。待たずに読むと、まだ区間が
// 閉じていないタイミングを拾って偽の失敗になる。
async function closeAndSettle(ws) {
  await new Promise(res => { ws.on('close', res); ws.close(); });
  await sleep(400);
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const login = (name, password) => j('/api/login', { method: 'POST', body: { username: name, password } });
  const atk = (await login('るみまき', adminPw)).body.token;
  check('管理者でログインできる', !!atk);

  // 一般プレイヤー2人とモデレーター1人。
  const p1 = await j('/api/register', { method: 'POST', body: { username: 'ひなたぼこ', password: 'pass1234' } });
  const p2 = await j('/api/register', { method: 'POST', body: { username: 'ゆきしろ', password: 'pass1234' } });
  const p3 = await j('/api/register', { method: 'POST', body: { username: 'もぐらん', password: 'pass1234' } });
  const uid1 = p1.body.user && p1.body.user.id;
  const uid3 = p3.body.user && p3.body.user.id;
  check('検証用のプレイヤーを用意できた', !!uid1 && !!p2.body.token && !!uid3,
    `${p1.body.error || ''} ${p2.body.error || ''} ${p3.body.error || ''}`.trim());
  await j(`/api/admin/users/${uid3}`, { method: 'POST', body: { role: 'mod' } }, atk);
  const modTok = (await login('もぐらん', 'pass1234')).body.token;
  check('モデレーターを用意できた', !!modTok);

  // -------------------------------------------------------------------------
  // 1. 権限（401 / 403 / 200）
  // -------------------------------------------------------------------------
  const anon = await j('/api/admin/playerstats');
  check('1-a 未ログインは 401', anon.status === 401, `status=${anon.status}`);
  const anonDetail = await j(`/api/admin/playerstats/${uid1}`);
  check('1-b 未ログインは個人の詳細も 401', anonDetail.status === 401, `status=${anonDetail.status}`);

  // 一般プレイヤーは 2 回ログインしておく（下のログイン回数の検証に使う）。
  const tok1a = (await login('ひなたぼこ', 'pass1234')).body.token;
  const tok1 = (await login('ひなたぼこ', 'pass1234')).body.token;
  check('一般プレイヤーでログインできる', !!tok1a && !!tok1);

  const asUser = await j('/api/admin/playerstats', {}, tok1);
  check('1-c 一般プレイヤーは 403', asUser.status === 403, `status=${asUser.status}`);
  const asUserDetail = await j(`/api/admin/playerstats/${uid1}`, {}, tok1);
  check('1-d 自分自身の詳細でも一般プレイヤーは 403', asUserDetail.status === 403, `status=${asUserDetail.status}`);
  const asMod = await j('/api/admin/playerstats', {}, modTok);
  check('1-e モデレーターも 403（統計は管理者だけ）', asMod.status === 403, `status=${asMod.status}`);

  const asAdmin = await j('/api/admin/playerstats', {}, atk);
  check('1-f 管理者は 200', asAdmin.status === 200, asAdmin.body.error || '');

  // -------------------------------------------------------------------------
  // 2. 非管理者に統計が1件も漏れないこと
  // -------------------------------------------------------------------------
  // 断り方が正しくても、本文に中身が乗っていたら意味がない。
  for (const [label, r] of [
    ['未ログイン', anon], ['未ログイン(詳細)', anonDetail],
    ['一般プレイヤー', asUser], ['一般プレイヤー(詳細)', asUserDetail],
    ['モデレーター', asMod],
  ]) {
    const bad = leaks(r.body, label);
    check(`2 ${label} の応答に統計が1件も乗っていない`, bad.length === 0, bad.join(' / '));
  }
  check('2-z 断りの本文は error（と errorEn）だけ',
    Object.keys(asUser.body).every(k => k === 'error' || k === 'errorEn' || k === 'code'),
    Object.keys(asUser.body).join(', '));

  // -------------------------------------------------------------------------
  // 3. 一覧の件数上限
  // -------------------------------------------------------------------------
  // 上限の値は実装から読む（テストに写すと、片方だけ動いたときに気づけない）。
  const ADMIN_SRC = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'admin.js'), 'utf8');
  const capMatch = ADMIN_SRC.match(/const\s+PS_LIMIT_MAX\s*=\s*(\d+)/);
  const CAP = capMatch ? Number(capMatch[1]) : null;
  check('3-a 実装から件数上限を読めた', Number.isFinite(CAP) && CAP > 0, `PS_LIMIT_MAX=${CAP}`);
  const huge = await j('/api/admin/playerstats?limit=99999', {}, atk);
  check('3-b limit は上限で頭打ちになる', huge.body.limit === CAP, `limit=${huge.body.limit} / 上限=${CAP}`);
  check('3-c 返る行数が limit を超えない', (huge.body.users || []).length <= huge.body.limit,
    `${(huge.body.users || []).length}件`);
  const oneRow = await j('/api/admin/playerstats?limit=1', {}, atk);
  check('3-d limit=1 なら1行だけ返る', (oneRow.body.users || []).length === 1
    && oneRow.body.total >= 4 && oneRow.body.matched === oneRow.body.total,
    `users=${(oneRow.body.users || []).length} total=${oneRow.body.total}`);
  const page2 = await j('/api/admin/playerstats?limit=1&offset=1', {}, atk);
  check('3-e offset でページを送れる（別の人が返る）',
    (page2.body.users || []).length === 1
    && page2.body.users[0].id !== oneRow.body.users[0].id,
    `${oneRow.body.users[0] && oneRow.body.users[0].username} → ${page2.body.users[0] && page2.body.users[0].username}`);
  const badSort = await j('/api/admin/playerstats?sort=__proto__', {}, atk);
  check('3-f 知らない並べ替えキーは既定に落ちる（レコードを覗けない）',
    badSort.status === 200 && badSort.body.sort === 'lastOnline', `sort=${badSort.body.sort}`);

  // -------------------------------------------------------------------------
  // 4. 一覧の中身（画面が必要とする欄がそろっているか）
  // -------------------------------------------------------------------------
  const found = await j(`/api/admin/playerstats?q=${encodeURIComponent('ひなた')}`, {}, atk);
  check('4-a 名前で検索できる', found.status === 200 && found.body.matched === 1
    && found.body.users[0].username === 'ひなたぼこ',
    `matched=${found.body.matched}`);
  const row = (found.body.users || [])[0] || {};
  const WANT = ['username', 'lastOnline', 'lastSeen', 'playSecs', 'gamesPlayed',
    'logins', 'loginStreak', 'loginStreakBest', 'rating', 'level', 'createdAt'];
  const missing = WANT.filter(k => row[k] === undefined);
  check('4-b 一覧に画面が必要とする欄がそろっている', missing.length === 0, missing.join(', '));
  // ログイン回数は /api/login の成功だけを数える（登録は数えない）。
  check('4-c ログイン回数が数えられている（登録は数えない）', row.logins === 2, `logins=${row.logins}`);
  check('4-d 最終オンラインが記録されている', row.lastOnline > 0 && Date.now() - row.lastOnline < 600000,
    `lastOnline=${row.lastOnline}`);
  // 一度もログインしていない人は 0 のまま（数え始める前と区別できる）。
  const never = await j(`/api/admin/playerstats?q=${encodeURIComponent('ゆきしろ')}`, {}, atk);
  check('4-e ログインしていない人は 0 のまま', (never.body.users[0] || {}).logins === 0,
    `logins=${(never.body.users[0] || {}).logins}`);

  // 既存の一覧にも「最後にオンラインだった時刻」が出ること（仕事1）。
  const usersList = await j('/api/admin/users', {}, atk);
  const listRow = (usersList.body.users || []).find(u => u.username === 'ひなたぼこ') || {};
  check('4-f /api/admin/users が lastSeen / lastDaily を返す',
    listRow.lastSeen !== undefined && listRow.lastDaily !== undefined,
    JSON.stringify({ lastSeen: listRow.lastSeen, lastDaily: listRow.lastDaily }));
  const editView = await j(`/api/admin/users/${uid1}`, {}, atk);
  check('4-g 編集画面にも lastSeen / lastDaily が来る',
    editView.body.user && editView.body.user.lastSeen !== undefined && editView.body.user.lastDaily !== undefined, '');
  check('4-h ログイン回数を運営が手で戻せる（EDITABLE_STATS）',
    (editView.body.catalog.stats || []).some(s => s.key === 'logins')
    && (editView.body.catalog.stats || []).some(s => s.key === 'playSecs'),
    (editView.body.catalog.stats || []).map(s => s.key).join(', '));

  // -------------------------------------------------------------------------
  // 5. 個人の詳細
  // -------------------------------------------------------------------------
  const detail = await j(`/api/admin/playerstats/${uid1}`, {}, atk);
  check('5-a 個人の詳細が返る', detail.status === 200 && detail.body.user
    && detail.body.user.username === 'ひなたぼこ', detail.body.error || '');
  const dWant = ['live', 'online', 'onlineTotal', 'history', 'modes', 'reports', 'adminActions'];
  const dMissing = dWant.filter(k => detail.body[k] === undefined);
  check('5-b 詳細に必要な塊がそろっている', dMissing.length === 0, dMissing.join(', '));
  check('5-c 在席区間はまだ無くても配列で来る（画面が落ちない）',
    Array.isArray(detail.body.online) && Array.isArray(detail.body.history)
    && Array.isArray(detail.body.modes), '');
  check('5-d 詳細にもログイン回数と最終ログインが来る',
    detail.body.live.logins === 2 && detail.body.live.lastLoginAt > 0,
    JSON.stringify(detail.body.live).slice(0, 120));
  const noSuch = await j('/api/admin/playerstats/nosuchuser', {}, atk);
  check('5-e 居ない id は 404', noSuch.status === 404, `status=${noSuch.status}`);
  // 運営がこの人に対して行った操作が拾えること（もぐらんを mod にした記録）。
  const modDetail = await j(`/api/admin/playerstats/${uid3}`, {}, atk);
  check('5-f 運営の操作ログがその人の詳細に出る',
    (modDetail.body.adminActions || []).some(a => a.action === 'user_edit'),
    JSON.stringify((modDetail.body.adminActions || []).map(a => a.action)));

  // -------------------------------------------------------------------------
  // 6. 住人と実プレイヤーの区別が管理者だけに見える
  // -------------------------------------------------------------------------
  const sum = asAdmin.body.summary || {};
  check('6-a 管理者には住人の箱が見える',
    !!sum.residents && sum.residents.total > 0, JSON.stringify(sum.residents));
  check('6-b 実プレイヤーと住人が別の箱に入っている',
    !!sum.players && sum.players.total >= 4 && sum.players.total !== undefined
    && sum.residents.total !== sum.players.total,
    `players=${sum.players && sum.players.total} residents=${sum.residents && sum.residents.total}`);
  // 一覧には実プレイヤーしか並ばないこと（住人が混ざると、行を1本足した
  // 誰かがうっかり非管理者の画面へ持って行ったときに正体ごと漏れる）。
  const realIds = new Set((usersList.body.users || []).map(u => u.id));
  const strangers = (huge.body.users || []).filter(u => !realIds.has(u.id));
  check('6-c 一覧に db.users 以外（住人）の行が混ざっていない', strangers.length === 0,
    strangers.map(u => u.username).join(', '));
  // 住人の名簿そのものも管理者専用のまま。
  const rosterUser = await j('/api/admin/residents', {}, tok1);
  const rosterAdmin = await j('/api/admin/residents', {}, atk);
  check('6-d 住人の名簿は一般プレイヤーに 403', rosterUser.status === 403, `status=${rosterUser.status}`);
  check('6-e 住人の名簿は管理者に返る（実対戦の記録つき）',
    rosterAdmin.status === 200 && (rosterAdmin.body.residents || []).length > 0
    && 'record' in (rosterAdmin.body.residents[0] || {}),
    `${(rosterAdmin.body.residents || []).length}人`);
  check('6-f 住人の名簿の応答にも統計の欠片が乗らない（非管理者）',
    leaks(rosterUser.body, 'roster').length === 0, leaks(rosterUser.body, 'roster').join(' / '));

  // -------------------------------------------------------------------------
  // 7. 全体サマリ
  // -------------------------------------------------------------------------
  const p = sum.players || {};
  check('7-a 今日／今週のアクティブ人数が出る',
    p.activeToday >= 1 && p.activeWeek >= p.activeToday && p.activeMonth >= p.activeWeek,
    `today=${p.activeToday} week=${p.activeWeek} month=${p.activeMonth}`);
  check('7-b 新規登録の推移が日数ぶん並ぶ',
    Array.isArray(sum.trend) && sum.trend.length === sum.trendDays
    && sum.trend[sum.trend.length - 1].signups >= 3,
    `${(sum.trend || []).length}日 / 最終日の新規=${(sum.trend || []).slice(-1)[0] && sum.trend.slice(-1)[0].signups}`);
  check('7-c モード別の内訳の器がある', Array.isArray(sum.modes), typeof sum.modes);
  check('7-d 総プレイ時間とログイン総数が出る',
    typeof p.totalPlaySecs === 'number' && typeof p.totalLogins === 'number' && p.totalLogins >= 3,
    `playSecs=${p.totalPlaySecs} logins=${p.totalLogins}`);

  // -------------------------------------------------------------------------
  // 8. 在席区間が「記録した側」から「見せる側」まで通っているか
  // -------------------------------------------------------------------------
  // 積むのは server/battle.js（hello / close）、上限と合流は server/backup.js、
  // 見せるのは routes/admin.js。3つの担当をまたぐので、片方だけ直したときに
  // いちばん静かに切れる。実際につないで切ってから、管理画面が読む口に
  // その区間が出てくるところまでを通しで見る。
  {
    const ws = await connect(tok1);
    await sleep(SPAN_MIN_MS + 400);
    await closeAndSettle(ws);
    const after = await j(`/api/admin/playerstats/${uid1}`, {}, atk);
    const spans = after.body.online || [];
    check('8-a 在席区間が個人の詳細に出てくる', spans.length >= 1, `${spans.length}件`);
    check('8-b 区間が開始時刻と長さを持つ',
      spans[0] && spans[0].at > 0 && spans[0].ms >= SPAN_MIN_MS,
      JSON.stringify(spans[0]));
    check('8-c 通算セッション数も詳細に出る', (after.body.live || {}).sessions >= 1,
      `sessions=${(after.body.live || {}).sessions}`);
    const listAfter = await j(`/api/admin/playerstats?q=${encodeURIComponent('ひなた')}`, {}, atk);
    const r2 = (listAfter.body.users || [])[0] || {};
    check('8-d 一覧の行にも区間の本数が乗る', r2.spans >= 1 && r2.sessions >= 1,
      `spans=${r2.spans} sessions=${r2.sessions}`);
    check('8-e 最終オンラインが区間の終わりまで進む',
      r2.lastOnline >= spans[0].at + spans[0].ms - 1000,
      `lastOnline=${r2.lastOnline} 区間終わり=${spans[0] && spans[0].at + spans[0].ms}`);
    // 非管理者には、この在席の記録も1件も出ない。
    const leakAfter = await j(`/api/admin/playerstats/${uid1}`, {}, tok1);
    check('8-f 在席の記録も非管理者には出ない',
      leakAfter.status === 403 && leaks(leakAfter.body, 'after').length === 0, `status=${leakAfter.status}`);
  }
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
