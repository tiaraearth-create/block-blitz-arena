// リポジトリのルートから:  node test/social.test.mjs
// 🤝 フレンド / 👥 パーティー / パーティーチャットのテスト。
//
// 守りたいのは主に「安全側」。仕様が動くことより、抜け道が塞がっていること:
//   1. 断りの文言が理由ごとに変わらない（この窓口でブロックの有無を調べられない）
//   2. ブロックが招待でも合言葉入場でも効く（合言葉は全体チャットに貼れる）
//   3. ミュートされた人はパーティーチャットでも喋れない
//   4. ゲストはフレンドにもパーティーにも入れない
//   5. アカウント削除で相手側に宙に浮いた id が残らない
//   6. 復元でブロックが消えない／id 付け替えでフレンドが切れない
//   7. 対戦用 socket が閉じてもパーティーの所属は残る
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import { freePort } from './_port.mjs';
import {
  sendRequest, acceptRequest, declineRequest, block as blockUser,
  unfriendAll, healSocial, ensureSocial, MAX_REQ_IN,
} from '../server/friends.js';
import { createParties } from '../server/party.js';
import { applyRestore } from '../server/backup.js';

const PORT = await freePort();
const DIR = path.join(os.tmpdir(), 'bba-social-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
// サーバーの stderr は「その場で出す分」を絞りつつ、全文も溜めておく。
// 絞ったままだと、サーバーが何も言わずに終わった回が `fetch failed` だけになり、
// 何が壊れたのか分からない失敗になっていた（失敗時に下でまとめて出す）。
let serverErr = '';
let serverExit = null;
function serverDiag() {
  const parts = [];
  if (serverExit !== null) parts.push(`[server] 終了コード ${serverExit}`);
  if (serverErr.trim()) parts.push('[server stderr]\n' + serverErr.trim());
  return parts.length ? '\n' + parts.join('\n') : '';
}
async function start() {
  serverErr = ''; serverExit = null;
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'social-test', SEED_RESTORE: '0', ADMIN_PASSWORD: 'socialtestpassword',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // サーバーが落ちたときに黙って `fetch failed` になるのを避ける。
  // 起動時の案内は毎回出るので、その場に流すのは本当の異常だけ。
  proc.stderr.on('data', d => {
    const line = String(d);
    serverErr = (serverErr + line).slice(-8000);   // 溜めすぎない
    if (/Error|error:|throw|at .*\.js:/.test(line)) process.stderr.write('[server] ' + line);
  });
  proc.on('exit', code => { serverExit = code; });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null) throw new Error(`サーバーが起動直後に終了 (code=${proc.exitCode})`);
    try { const r = await fetch(`http://localhost:${PORT}/api/status`); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  if (p.exitCode !== null) return;   // もう終わっている（'exit' は二度と来ない）
  await new Promise(res => {
    let t = null;
    const done = () => { if (t) clearTimeout(t); res(); };
    p.on('exit', done);
    p.kill();
    // kill() が届かないことがある（Windows では SIGTERM ハンドラも走らない）。
    // 待ちっぱなしにするとランナーの時間切れになるので、5秒で強制終了に切り替える。
    t = setTimeout(() => {
      if (process.platform === 'win32' && p.pid) {
        try { spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { /* 下の SIGKILL にまかせる */ }
      }
      try { p.kill('SIGKILL'); } catch { /* もう死んでいる */ }
      res();
    }, 5000);
  });
  await sleep(300);
}

const api = async (p, o = {}) => {
  const r = await fetch(`http://localhost:${PORT}${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};

// WS の受信箱（test/battle.test.mjs と同じ形）
function openWs(token, role) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  ws.inbox = [];
  ws.on('message', raw => { try { ws.inbox.push(JSON.parse(raw)); } catch { /* ignore */ } });
  return new Promise((resolve, reject) => {
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token, role })); resolve(ws); });
    ws.on('error', reject);
  });
}
// 条件つきで待てるようにする。接続直後にサーバーが
// 「あなたはどのパーティーにも居ません」(party:null) を送るので、
// 単に最初の party_state を拾うと、そちらを掴んでしまう。
const waitWhere = async (ws, type, pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = ws.inbox.find(x => x.type === type && pred(x));
    if (m) return m;
    await sleep(50);
  }
  return null;
};
const waitFor = async (ws, type, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = ws.inbox.find(x => x.type === type);
    if (m) return m;
    await sleep(50);
  }
  return null;
};

fs.rmSync(DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 1. 純粋な部分（サーバー不要）
// ---------------------------------------------------------------------------
{
  const db = { users: {}, deleted: [] };
  const mk = (id, n) => { db.users[id] = ensureSocial({ id, username: n, xp: 0, badges: [] }); return db.users[id]; };
  const a = mk('a', 'あ'), b = mk('b', 'い'), c = mk('c', 'う');

  // 断りの文言が理由ごとに変わってはいけない。
  // 変わると、この窓口が「あの人にブロックされているか」を調べる道具になる。
  b.social.requests = 'none';
  const refusedByPref = sendRequest(db, a, 'b').error;
  b.social.requests = 'all';
  blockUser(db, b, 'a');
  const refusedByBlock = sendRequest(db, a, 'b').error;
  const refusedByGhost = sendRequest(db, a, 'nosuchid').error;
  check('断りの文言が理由で変わらない（ブロックを探れない）',
    refusedByPref === refusedByBlock && refusedByBlock === refusedByGhost,
    `${refusedByPref} / ${refusedByBlock} / ${refusedByGhost}`);

  // 受け取り側の上限は、送り主を断る形でないと意味がない。
  // 古いものを押し出す作りだと、大量申請で本物の申請を消せる。
  const victim = mk('v', 'ぶ');
  for (let i = 0; i < MAX_REQ_IN; i++) {
    const s = mk('s' + i, 'そ' + i);
    sendRequest(db, s, 'v');
  }
  const real = mk('real', 'ほんもの');
  const over = sendRequest(db, real, 'v');
  check('受け取りがあふれたら送り主を断る（既存を押し出さない）',
    !!over.error && victim.friendReqIn.length === MAX_REQ_IN, `${victim.friendReqIn.length}件`);

  // 削除で宙に浮く id を残さない（ギルドで一度やらかしている）
  sendRequest(db, c, 'a'); acceptRequest(db, a, 'c');
  check('削除前: フレンドになっている', a.friends.includes('c') && c.friends.includes('a'), '');
  unfriendAll(db, c); delete db.users['c'];
  check('削除で相手側に id が残らない', !a.friends.includes('c'), JSON.stringify(a.friends));

  // 片側だけ残った関係は両側から落とす
  a.friends.push('zzz');
  const fixed = healSocial(db);
  check('存在しない相手は掃除される', !a.friends.includes('zzz'), `${fixed.friends}件`);
}

// ---------------------------------------------------------------------------
// 2. 復元（レビューが見つけた穴を含む）
// ---------------------------------------------------------------------------
{
  // ブロックは進行度で負けたコピーに入っていても残さないといけない。
  const db = {
    users: {
      u1: ensureSocial({ id: 'u1', username: 'あ', xp: 100, badges: [], owned: [], achievements: [], blocked: ['u2'], friends: [] }),
      u2: ensureSocial({ id: 'u2', username: 'い', xp: 100, badges: [], owned: [], achievements: [], friends: [] }),
    },
    tokens: {}, guilds: {}, news: [], meta: {}, deleted: {}, transactions: [], bugreports: [],
  };
  const incoming = {
    version: 3, users: [
      { id: 'u1', username: 'あ', xp: 999, badges: [], owned: [], achievements: [], friends: [], blocked: [] },
    ],
  };
  try {
    applyRestore(db, incoming, { mode: 'merge' });
    check('復元でブロックが消えない（ファイル側に無くても残る）',
      (db.users.u1.blocked || []).includes('u2'), JSON.stringify(db.users.u1.blocked));
  } catch (err) {
    check('復元でブロックが消えない（ファイル側に無くても残る）', false, String(err.message));
  }

  // id の付け替え。名前で照合して勝ったレコードは id ごと入れ替わるので、
  // 他の人が持っている古い id が全部宙に浮く＝黙って縁が切れ、
  // しかもブロックが「存在しない id」になって無効化する。
  const db2 = {
    users: {
      old1: ensureSocial({ id: 'old1', username: 'あ', xp: 10, badges: [], owned: [], achievements: [], friends: ['keep'], blocked: [] }),
      keep: ensureSocial({ id: 'keep', username: 'き', xp: 10, badges: [], owned: [], achievements: [], friends: ['old1'], blocked: ['old1'] }),
    },
    tokens: {}, guilds: {}, news: [], meta: {}, deleted: {}, transactions: [], bugreports: [],
  };
  const inc2 = {
    version: 3, users: [
      { id: 'new1', username: 'あ', xp: 999, badges: [], owned: [], achievements: [], friends: [], blocked: [] },
    ],
  };
  try {
    applyRestore(db2, inc2, { mode: 'merge' });
    const k = db2.users.keep;
    check('id が入れ替わってもフレンドが切れない',
      (k.friends || []).includes('new1'), JSON.stringify(k.friends));
    check('id が入れ替わってもブロックが効いたまま',
      (k.blocked || []).includes('new1'), JSON.stringify(k.blocked));
  } catch (err) {
    check('id の付け替え', false, String(err.message));
  }
}

// ---------------------------------------------------------------------------
// 3. パーティー（純粋）
// ---------------------------------------------------------------------------
{
  const db = { users: {} };
  const mk = (id, n) => { db.users[id] = ensureSocial({ id, username: n, xp: 0, badges: [] }); };
  mk('a', 'あ'); mk('b', 'い'); mk('c', 'う');
  db.users.a.friends = ['b']; db.users.b.friends = ['a'];
  let seq = 0;
  const P = createParties({
    db, uuid: () => 'p' + (++seq),
    sendToUser: () => true, isOnline: () => true, statusOf: () => 'menu',
  });
  P.create('a');
  const code = P.partyOf('a').code;
  check('合言葉は6文字', code.length === 6, code);
  check('紛らわしい文字を使わない', !/[IO01]/.test(code), code);
  check('フレンドでない相手は招待できない', !!P.invite('a', 'c').error, '');
  P.join('c', code);
  check('合言葉なら誰でも入れる', !!P.partyOf('c'), '');
  db.users.a.blocked = ['c'];
  P.splitOnBlock('a', 'c');
  check('ブロックした相手は同席から外れる', !P.partyOf('c'), '');
  check('ブロック相手は合言葉でも入り直せない', !!P.join('c', code).error, '');
  // リーダーが抜けたら明示的に引き継ぐ
  P.join('b', code);
  P.leave('a');
  check('リーダーが抜けたら引き継がれる', P.partyOf('b').leaderId === 'b', '');
}

// ---------------------------------------------------------------------------
// 4. 実サーバー
// ---------------------------------------------------------------------------
try {
  await start();

  const reg = async (n) => (await api('/api/register', { method: 'POST', body: { username: n, password: 'password123' } })).d.token;
  const t1 = await reg('あきら'), t2 = await reg('ばんり'), t3 = await reg('ちさと');
  check('3人登録できた', !!(t1 && t2 && t3), '');

  const me1 = (await api('/api/me', { token: t1 })).d.user;
  const me2 = (await api('/api/me', { token: t2 })).d.user;
  check('publicUser に社交の要約が入る',
    me1.social && typeof me1.social.friends === 'number' && typeof me1.social.pending === 'number',
    JSON.stringify(me1.social));
  check('publicUser にフレンドのidや配列は入らない',
    !('friends' in me1) && !('blocked' in me1) && !Array.isArray(me1.social), Object.keys(me1).join(','));

  // 名前で探す
  let r = await api('/api/friends/search', { method: 'POST', token: t1, body: { username: 'ばんり' } });
  check('名前で探せる', r.d.user && r.d.user.username === 'ばんり', JSON.stringify(r.d.user));
  check('探した結果に財布が含まれない',
    r.d.user && !('coins' in r.d.user) && !('gems' in r.d.user), Object.keys(r.d.user || {}).join(','));
  r = await api('/api/friends/search', { method: 'POST', token: t1, body: { username: 'いない人' } });
  check('居ない人は null（在籍を総当たりで調べられない）', r.d.user === null, JSON.stringify(r.d));

  // 申請 → 承認
  r = await api('/api/friends/request', { method: 'POST', token: t1, body: { userId: me2.id } });
  check('申請できる', r.status === 200, r.d.error || '');
  const inbox2 = await api('/api/friends', { token: t2 });
  check('相手に届いている', inbox2.d.incoming.length === 1, JSON.stringify(inbox2.d.incoming.map(x => x.username)));
  r = await api('/api/friends/accept', { method: 'POST', token: t2, body: { userId: me1.id } });
  check('承認できる', r.status === 200 && r.d.friends.length === 1, r.d.error || '');
  const back = await api('/api/friends', { token: t1 });
  check('相互にフレンドになる', back.d.friends.length === 1, '');

  // 未ログインは触れない
  r = await api('/api/friends', {});
  check('未ログインではフレンド一覧を読めない', r.status === 401, `status=${r.status}`);

  // __proto__ を投げても壊れない
  r = await api('/api/friends/request', { method: 'POST', token: t1, body: { userId: '__proto__' } });
  check('__proto__ を投げても落ちない', r.status === 404 || r.status === 409, `status=${r.status}`);
  const still = await api('/api/friends', { token: t1 });
  check('その後も一覧が読める（汚染されていない）', still.status === 200, '');

  // ---- WS: パーティー ----
  const ws1 = await openWs(t1);           // 常時接続（chat 相当）
  const ws2 = await openWs(t2);
  await sleep(400);

  ws1.send(JSON.stringify({ type: 'party_create' }));
  const st1 = await waitWhere(ws1, 'party_state', m => !!m.party);
  check('パーティーを作れる', !!(st1 && st1.party), JSON.stringify(st1 && st1.party ? st1.party.code : st1));
  const pcode = st1.party.code;
  check('作った人がリーダー', st1.party.youAreLeader === true, '');

  ws1.inbox.length = 0; ws2.inbox.length = 0;
  ws1.send(JSON.stringify({ type: 'party_invite', userId: me2.id }));
  const inv = await waitFor(ws2, 'party_invite');
  check('フレンドを招待できる', !!inv, JSON.stringify(ws2.inbox.map(x => x.type)));

  ws2.send(JSON.stringify({ type: 'party_invite_accept', inviteId: inv.inviteId }));
  const st2 = await waitWhere(ws2, 'party_state', m => !!m.party);
  check('招待から参加できる', !!(st2 && st2.party && st2.party.members.length === 2), '');

  // チャット
  ws1.inbox.length = 0; ws2.inbox.length = 0;
  ws1.send(JSON.stringify({ type: 'party_chat', text: 'こんばんは' }));
  const pc = await waitFor(ws2, 'party_chat');
  check('パーティーチャットが相手に届く', !!(pc && pc.msg.text === 'こんばんは'), JSON.stringify(pc));

  // 全体チャットに漏れていないこと
  const ws3 = await openWs(t3);
  await sleep(500);
  const leaked = ws3.inbox.some(m => m.type === 'chat' && String(m.text || '').includes('こんばんは'));
  check('パーティーの発言が全体チャットに漏れない', !leaked, '');
  const leaked2 = ws3.inbox.some(m => m.type === 'party_chat');
  check('パーティー外にはパーティーチャットが届かない', !leaked2, '');

  // 対戦用 socket が閉じても所属は残る
  const wsBattle = await openWs(t1, 'battle');
  await sleep(300);
  wsBattle.close();
  await sleep(600);
  ws1.inbox.length = 0;
  ws1.send(JSON.stringify({ type: 'party_chat', text: 'まだいる' }));
  const stillIn = await waitFor(ws2, 'party_chat');
  check('対戦用socketが閉じてもパーティーに残る', !!stillIn, '');

  // ゲストは入れない
  const wsGuest = await openWs(undefined);
  await sleep(400);
  wsGuest.inbox.length = 0;
  wsGuest.send(JSON.stringify({ type: 'party_create' }));
  const gErr = await waitFor(wsGuest, 'party_error');
  check('ゲストはパーティーを作れない', !!gErr, JSON.stringify(wsGuest.inbox.map(x => x.type)));

  // ミュートされた人はパーティーチャットでも喋れない
  const atk = (await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: 'socialtestpassword' } })).d.token;
  await api(`/api/admin/users/${me2.id}`, { method: 'POST', token: atk, body: { muted: true } });
  ws2.inbox.length = 0;
  ws2.send(JSON.stringify({ type: 'party_chat', text: 'ミュート中' }));
  const mErr = await waitFor(ws2, 'party_error');
  check('ミュートはパーティーチャットでも効く', !!mErr, mErr ? mErr.error : JSON.stringify(ws2.inbox.map(x => x.type)));
  await api(`/api/admin/users/${me2.id}`, { method: 'POST', token: atk, body: { muted: false } });

  // ブロックすると同席から外れる
  ws2.inbox.length = 0;
  r = await api('/api/friends/block', { method: 'POST', token: t1, body: { userId: me2.id } });
  check('ブロックできる', r.status === 200, r.d.error || '');
  await sleep(400);
  const kicked = ws2.inbox.some(m => m.type === 'party_state' && !m.party);
  check('ブロックで同席が解除される', kicked, JSON.stringify(ws2.inbox.map(x => x.type)));

  // ブロック相手は合言葉でも入れない
  ws2.inbox.length = 0;
  ws2.send(JSON.stringify({ type: 'party_join', code: pcode }));
  const jErr = await waitFor(ws2, 'party_error');
  check('ブロック相手は合言葉でも入れない', !!jErr, jErr ? jErr.error : '');

  // 通報 → bugreports に入る
  const rep = await api('/api/party/report', { method: 'POST', token: t1, body: { reason: 'テスト' } });
  check('通報できる', rep.status === 200, rep.d.error || `status=${rep.status}`);
  const mods = await api('/api/mod/parties', { token: atk });
  check('運営は一覧を見られる（本文は出ない）',
    mods.status === 200 && Array.isArray(mods.d.parties)
    && mods.d.parties.every(p => !('chat' in p)), JSON.stringify(mods.d.parties));
  const modsDenied = await api('/api/mod/parties', { token: t1 });
  check('一般ユーザーは運営の窓口を叩けない', modsDenied.status === 403, `status=${modsDenied.status}`);

  if (mods.d.parties.length) {
    const read = await api(`/api/mod/party/${mods.d.parties[0].id}`, { token: atk });
    check('運営は本文を読める', read.status === 200 && Array.isArray(read.d.party.chat), read.d.error || '');
  }

  for (const w of [ws1, ws2, ws3, wsGuest]) { try { w.close(); } catch { /* ignore */ } }
  await sleep(300);

} catch (err) {
  check('テストの土台', false, (err.stack || String(err)) + serverDiag());
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
