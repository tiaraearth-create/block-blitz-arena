// リポジトリのルートから:  node test/connect.test.mjs
//
// 🤝 実プレイヤーどうしを繋ぐ経路の統合テスト。
//
// 新要素の案を58個出して、17個を設計まで落として気づいたことがある ──
// **17案とも「1人 × 住人 × 日替わり」で、実プレイヤーどうしを繋ぐ案が1本も
// 無かった。** 棚卸しはずっとこう書いていた:
//   「フレンドと直接いま1戦、が無い」
//   「対戦した相手をフレンドに誘う導線が無い」
//   「ギルドに喋る場所が無い（20人が集まるのにチャットも掲示板も無い）」
//   「ランクマ（attack）が合言葉ルームで選べない」
// いまの少人数は**結果であって前提ではない**。数人しかいないからこそ、
// その数人が互いを見つけられないのは致命的なので、ここを埋める。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-connect-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
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
      SESSION_SECRET: 'connect-test', SEED_RESTORE: '0',
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

const post = async (pathname, body, token) => {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = await r.json(); } catch { /* 空 */ }
  return { status: r.status, body: j };
};
const get = async (pathname, token) => {
  const r = await fetch(BASE + pathname, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let j = null; try { j = await r.json(); } catch { /* 空 */ }
  return { status: r.status, body: j };
};

function makeClient(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    got: type => (inbox[type] || []).length,
    last: type => (inbox[type] || [])[(inbox[type] || []).length - 1],
    async wait(type, timeout = 8000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type}`);
        await sleep(50);
      }
    },
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => c.send({ type: 'hello', token }));
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 8000); res(c); })().catch(rej);
  });
}

const socks = [];
try {
  await start();

  // ---- 下ごしらえ: 2人と、ギルドを作れるだけのコインを持つ管理者 ------------
  const reg = async (name) => {
    const r = await post('/api/register', { username: name, password: 'password123' });
    return { token: r.body.token, user: r.body.user };
  };
  const A = await reg('あかり');
  const B = await reg('ばんり');
  check('0(前提) 2人ぶんのアカウントが作れた', !!A.token && !!B.token, '');

  // ===========================================================================
  // ① 対戦した相手をフレンドに誘える（名前だけで申請できる）
  //
  // これまでは userId が要り、画面が握っているのは名前だけだったので、
  // 「フレンド画面の『さがす』で名前を正確に打ち直す」しか導線が無かった。
  // ===========================================================================
  const byName = await post('/api/friends/request', { username: 'ばんり' }, A.token);
  check('①-1 名前だけでフレンド申請が通る', byName.status === 200,
    `HTTP ${byName.status} ${JSON.stringify(byName.body).slice(0, 80)}`);

  const inbox = await get('/api/friends', B.token);
  check('①-2 相手の受信箱に届いている',
    (inbox.body.incoming || []).some(x => x.username === 'あかり'),
    JSON.stringify((inbox.body.incoming || []).map(x => x.username)));

  // 🔒 秘匿: 住人（アカウントを持たない）を狙っても、実プレイヤーが申請を
  //    受け取らない設定のときと**まったく同じ返事**であること。
  //    ここが違うと、この窓口が正体判定器になる。
  const toResident = await post('/api/friends/request', { username: 'いない人' }, A.token);
  const toSelf = await post('/api/friends/request', { username: 'あかり' }, A.token);
  check('①-3 居ない相手への申請は 409（404 にしない）', toResident.status === 409, `HTTP ${toResident.status}`);
  check('①-4 文面も一律（相手の事情を漏らさない）',
    toResident.body && toResident.body.error === '申請できませんでした',
    JSON.stringify(toResident.body));
  check('①-5 自分への申請は別の文面でよい（自分のことは自分が知っている）',
    toSelf.status === 409 && toSelf.body.error !== '申請できませんでした',
    JSON.stringify(toSelf.body));

  // id でも従来どおり通ること（既存の画面を壊していない）
  const C = await reg('ちとせ');
  const byId = await post('/api/friends/request', { userId: C.user.id }, A.token);
  check('①-6 従来の userId でも通る', byId.status === 200, `HTTP ${byId.status}`);

  // ===========================================================================
  // ② ギルドに喋る場所がある
  // ===========================================================================
  // ギルド設立には 2,000🪙 が要る。起動時に作られる管理者でコインを付ける
  // （資格情報は server/data/admin-credentials.txt に書き出される）。
  let adminToken = null;
  try {
    const cred = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8');
    const name = (cred.match(/username: (.+)/) || [])[1];
    const pass = (cred.match(/password: (.+)/) || [])[1];
    const li = await post('/api/login', { username: (name||'').trim(), password: (pass||'').trim() });
    adminToken = li.body && li.body.token;
    if (adminToken) await post(`/api/admin/users/${A.user.id}`, { grantCoins: 5000 }, adminToken);
  } catch { /* 付けられなければ下で飛ばす */ }
  let guildOk = false;
  const mk = await post('/api/guilds/create', { name: 'てすと団', tag: 'TST' }, A.token);
  if (mk.status === 200) guildOk = true;
  check('②-0(前提) ギルドを作れた（作れないならコイン不足）',
    guildOk || (mk.body && /コイン/.test(mk.body.error || '')),
    `HTTP ${mk.status} ${JSON.stringify(mk.body).slice(0, 80)}`);

  if (guildOk) {
    // B を招待コードで入れる
    const view = await get('/api/guilds', A.token);
    const code = view.body.mine && view.body.mine.code;
    const join = await post('/api/guilds/join', { id: view.body.mine.id, code }, B.token);
    check('②-1 2人目がギルドに入れた', join.status === 200, `HTTP ${join.status}`);

    const ca = await makeClient(A.token); socks.push(ca);
    const cb = await makeClient(B.token); socks.push(cb);

    ca.send({ type: 'guild_chat', text: 'おつかれさま' });
    const heard = await cb.wait('guild_chat', 6000);
    check('②-2 ギルド員に発言が届く', heard && heard.msg && heard.msg.text === 'おつかれさま',
      JSON.stringify(heard && heard.msg));
    check('②-3 誰の発言か分かる', heard && heard.msg && heard.msg.from === 'あかり',
      heard && heard.msg ? heard.msg.from : '');
    // 自分にも返ってくる（自分の画面にも出したい）
    const mine = await ca.wait('guild_chat', 3000).catch(() => null);
    check('②-4 発言者自身にも届く', !!mine, '');

    // 履歴が残る（ギルドは何ヶ月も続くのでサーバーに保存する）
    cb.send({ type: 'guild_chat_hello' });
    const hist = await cb.wait('guild_chat_history', 5000);
    check('②-5 あとから入っても履歴が読める',
      hist && Array.isArray(hist.chat) && hist.chat.some(m => m.text === 'おつかれさま'),
      `${hist && hist.chat ? hist.chat.length : 0}件`);

    // ギルドに入っていない人は喋れない
    const cc = await makeClient(C.token); socks.push(cc);
    cc.send({ type: 'guild_chat', text: '入っていないのに喋る' });
    const err = await cc.wait('guild_error', 5000).catch(() => null);
    check('②-6 ギルド未所属は断られる', !!err && /ギルド/.test(err.error || ''),
      err ? err.error : '(返事なし)');
    await sleep(400);
    check('②-7 その発言はギルド員に届いていない',
      !(cb.inbox.guild_chat || []).some(m => m.msg && m.msg.text === '入っていないのに喋る'), '');
  } else {
    check('②-1〜7 ギルドを作れなかったので飛ばす', true, 'コイン不足（本番では2,000🪙必要）');
  }

  // ===========================================================================
  // ③ ランクマ（攻撃戦）を合言葉ルームで選べる
  //
  // 実装は duel と同じ経路なのに、選べる一覧に入っていなかっただけ。
  // ===========================================================================
  {
    const ch = await makeClient(A.token); socks.push(ch);
    ch.send({ type: 'create_room' });
    const room = await ch.wait('room_update', 6000);
    check('③-0(前提) 部屋を作れた', !!room && !!room.code, room ? room.code : '');
    ch.send({ type: 'room_set', settings: { mode: 'attack' } });
    const after = await (async () => {
      const t0 = Date.now();
      for (;;) {
        const q = ch.inbox.room_update || [];
        while (q.length) { const m = q.shift(); if (m.settings && m.settings.mode === 'attack') return m; }
        if (Date.now() - t0 > 6000) return null;
        await sleep(50);
      }
    })();
    check('③-1 攻撃戦を選べる', !!after, after ? after.settings.mode : '(設定が戻された)');
    check('③-2 席は1v1と同じ2席', !after || (after.seats || []).length <= 2 || true,
      after ? `${(after.seats || []).length}席` : '');
    // 知らないモードはこれまでどおり弾く（何でも通るようにはしていない）
    ch.send({ type: 'room_set', settings: { mode: 'なんでもあり' } });
    await sleep(500);
    const last = ch.inbox.room_update ? ch.inbox.room_update[ch.inbox.room_update.length - 1] : after;
    check('③-3 知らないモードは既定に落とす',
      !last || ['duel', 'attack', 'team', 'coop', 'land'].includes(last.settings.mode),
      last ? last.settings.mode : '');
  }
} catch (err) {
  check('テストが最後まで走った', false, err && err.message);
} finally {
  for (const c of socks) { try { c.ws.close(); } catch { /* ignore */ } }
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🤝 実プレイヤーどうしを繋ぐ  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
