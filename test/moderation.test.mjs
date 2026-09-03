// リポジトリのルートから:  node test/moderation.test.mjs
//
// 🚫 取り締まりと身元まわりの、監査で残っていた5件を固定する。
//
//   A. 凍結された回線からは「ゲストとして入り直す」「作り直す」ができない
//      （ただし同じ回線のログイン済みアカウントは巻き添えにしない）
//   B. ゲスト名の照会に上限があり、名簿の総当たりができない
//      （ただし同じ名前での名乗り直し＝再接続は無料）
//   C. 殿堂とお知らせに焼き付いた名前が、退会で伏せ字になり、改名で追従する
//   D. 通報と運営操作ログを **IDで** 照合する（改名で別人の履歴に化けない）
//   E. 同じ回線の同じ相手と短時間に何度も当たると、そこから先は練習試合
//
// ■ どれも「効きすぎない」ことを同じテストで見張る
//   取り締まりの類は、緩いと意味が無く、強いと無関係な人を巻き込む。
//   A なら「同じ回線の別アカウントは遊べる」、B なら「再接続は無料」、
//   E なら「3戦目までは今までどおり」を必ず併記してある。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

// 復元は「ユーザーが0件のファイル」を安全のため受け付けない（空ファイルで
// 本番を消せてしまうため）。殿堂とお知らせだけを流し込みたいので、
// 中身に影響しない当て馬を1人だけ載せる。資格情報の形は server/auth.js と同じ。
function creds(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passHash: crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex') };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-moderation-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なし */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'moderation-test-secret', SEED_RESTORE: '0', MATCH_SECONDS: '5',
    },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    }
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

/** hello の結果（受理された名前 or 断られたエラー）を返す。 */
function hello({ token, guestName } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  return new Promise((res, rej) => {
    let err = null;
    const to = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } res({ name: null, error: err, closed: true }); }, 6000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'error') err = m.error;
      if (m.type === 'hello_ok') { clearTimeout(to); res({ name: m.name, error: err }); try { ws.close(); } catch { /* ignore */ } }
    });
    ws.on('close', () => { clearTimeout(to); res({ name: null, error: err, closed: true }); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, guestName })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
}

// 型別に受信を貯めるクライアント（E で使う）。
function makeClient(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    async wait(type, timeout = 25000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type}`);
        await sleep(60);
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

const open = [];
try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();
  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const atk = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  check('下ごしらえ: 管理者でログインできる', !!atk);

  // =========================================================================
  // A. 凍結された回線
  // =========================================================================
  {
    const bad = await j('/api/register', { method: 'POST', body: { username: 'こおるひと', password: 'kooru-1234' } });
    const inn = await j('/api/register', { method: 'POST', body: { username: 'むかんけい', password: 'mukan-1234' } });
    check('A-0 下ごしらえの2アカウント', !!bad.token && !!inn.token, `${bad.error || ''} ${inn.error || ''}`);

    // 凍結の対象が「この回線を使っている」ことをサーバーに知らせる（WS で名乗る）。
    const c = await makeClient(bad.token); open.push(c);
    await sleep(300);

    check('A-1(前提) 凍結前はゲストとして入れる', !!(await hello({ guestName: 'まえのゲスト' })).name);

    const ban = await j(`/api/admin/users/${bad.user.id}`, { method: 'POST', body: { banned: true } }, atk);
    check('A-2 凍結できた', ban.status === 200, `HTTP ${ban.status} ${ban.error || ''}`);
    await sleep(500);

    const list = await j('/api/admin/ipbans', {}, atk);
    check('A-3 凍結に伴って回線が登録される', Array.isArray(list.bans) && list.bans.length >= 1,
      `件数=${list.bans ? list.bans.length : 'なし'}`);
    check('A-3 誰のせいで止めたかが分かる',
      (list.bans || []).some(b => b.target === 'こおるひと'), JSON.stringify((list.bans || []).map(b => b.target)));
    check('A-3 期限が付いている', (list.bans || []).every(b => Number(b.until) > Date.now()));

    const asGuest = await hello({ guestName: 'にげたゲスト' });
    check('A-4 凍結された回線からはゲストとして入れない', !asGuest.name,
      `name=${asGuest.name} error=${asGuest.error}`);

    const remake = await j('/api/register', { method: 'POST', body: { username: 'つくりなおし', password: 'tukuri-1234' } });
    check('A-5 凍結された回線からは作り直せない', remake.status === 403, `HTTP ${remake.status} ${remake.error || ''}`);

    // 巻き添えが無いこと ── 同じ回線の**別の登録済みアカウント**は今までどおり。
    const innLogin = await j('/api/login', { method: 'POST', body: { username: 'むかんけい', password: 'mukan-1234' } });
    check('A-6 同じ回線でも、別の登録済みアカウントはログインできる', innLogin.status === 200,
      `HTTP ${innLogin.status} ${innLogin.error || ''}`);
    const innWs = await hello({ token: innLogin.token });
    check('A-6 その人は対戦サーバーにも入れる', innWs.name === 'むかんけい', `name=${innWs.name} error=${innWs.error}`);

    // 解除で戻る。
    const unban = await j(`/api/admin/users/${bad.user.id}`, { method: 'POST', body: { banned: false } }, atk);
    check('A-7 凍結を解除できる', unban.status === 200, `HTTP ${unban.status}`);
    await sleep(300);
    const after = await j('/api/admin/ipbans', {}, atk);
    check('A-7 解除で回線も戻る（家ごと2週間止めたままにしない）',
      (after.bans || []).every(b => b.target !== 'こおるひと'), JSON.stringify((after.bans || []).map(b => b.target)));
    const backAsGuest = await hello({ guestName: 'もどったゲスト' });
    check('A-7 ゲストとしても入り直せる', !!backAsGuest.name, `name=${backAsGuest.name} error=${backAsGuest.error}`);

    c.ws.close();
  }

  // =========================================================================
  // B. ゲスト名の照会に上限
  // =========================================================================
  {
    // 同じ名前での名乗り直しは何度でも無料（再接続は1回の切断で最大6本走る）。
    let sameOk = 0;
    for (let i = 0; i < 8; i++) {
      const r = await hello({ guestName: 'いつものなまえ' });
      if (r.name === 'いつものなまえ') sameOk++;
    }
    check('B-1 同じ名前での名乗り直しは何度でも通る（再接続を壊さない）', sameOk === 8, `${sameOk}/8`);

    // 名前を変え続けると、どこかで照会そのものが止まる。
    let assigned = 0;
    let sawLimitMsg = false;
    for (let i = 0; i < 22; i++) {
      const r = await hello({ guestName: `さがすひと${i}` });
      if (r.name && r.name.startsWith('ゲスト')) assigned++;
      if (r.error && r.error.includes('多すぎ')) sawLimitMsg = true;
    }
    check('B-2 名前を変え続けると照会が止まる（名簿の総当たりができない）', assigned > 0, `打ち切られた回数=${assigned}`);
    check('B-2 打ち切りは名前について何も答えない文面', sawLimitMsg, '');
  }

  // =========================================================================
  // C+D. 殿堂・お知らせの名前と、ID照合
  // =========================================================================
  {
    const u = await j('/api/register', { method: 'POST', body: { username: 'きろくのひと', password: 'kiroku-1234' } });
    check('C-0 下ごしらえのアカウント', !!u.token, u.error || '');
    const uid = u.user.id;

    // 殿堂とお知らせを、復元経路で流し込む（シーズン切替を待たずに作る）。
    const seeded = {
      users: {
        'seed-filler': {
          id: 'seed-filler', username: 'あてうま', role: 'user', ...creds('ateuma-1234'),
          coins: 0, gems: 0, xp: 0, stats: { gamesPlayed: 0, totalScore: 0 },
        },
      },
      news: [{
        id: 'news-hof-test', title: '殿堂入り発表', titleEn: 'Hall of Fame',
        body: '1位 きろくのひと（12,345）\n2位 ほかのひと（9,000）',
        bodyEn: '#1 きろくのひと (12,345)\n#2 ほかのひと (9,000)',
        pinned: false, by: 'きろくのひと', at: Date.now(),
        // 焼き込んだ名前は「持ち主つき」で残す。改名 → 退会 の順で通っても
        // 引き当てられるのはこの userId のおかげ（本文は当時の名前のまま）。
        names: [{ name: 'きろくのひと', userId: uid }, { name: 'ほかのひと', userId: 'other-id' }],
      }],
      meta: {
        hallOfFame: [{
          season: 's-test', number: 1, name: 'テストシーズン', nameEn: 'Test Season', at: Date.now(),
          boards: [{ id: 'rating', name: 'レート', nameEn: 'Rating', entrants: 2, top: [
            { rank: 1, username: 'きろくのひと', userId: uid, value: 12345, resident: false },
            { rank: 2, username: 'ほかのひと', userId: 'other-id', value: 9000, resident: false },
          ] }],
        }],
      },
    };
    const seed = await j('/api/admin/restore', { method: 'POST', body: { mode: 'merge', data: seeded } }, atk);
    check('C-0 殿堂とお知らせを用意できた', seed.status === 200, `HTTP ${seed.status} ${seed.error || ''}`);

    const hof0 = await j('/api/halloffame');
    const top0 = ((((hof0.seasons || [])[0] || {}).boards || [])[0] || {}).top || [];
    check('C-0(前提) 殿堂に名前が載っている', top0.some(t => t.username === 'きろくのひと'),
      JSON.stringify(top0.map(t => t.username)));
    check('C-1 公開の殿堂に userId は出ない', top0.every(t => !('userId' in t)), JSON.stringify(top0[0] || {}));

    // --- D: 通報を出してから改名する ---
    const rep = await j('/api/bugreport', { method: 'POST', body: { text: '改名テスト用の報告です。よろしくおねがいします' } }, u.token);
    check('D-0 通報を出せた', rep.status === 200, `HTTP ${rep.status} ${rep.error || ''}`);

    const ren = await j('/api/me/rename', { method: 'POST', body: { username: 'あらためたひと' } }, u.token);
    check('D-1 改名できた', ren.status === 200, `HTTP ${ren.status} ${ren.error || ''}`);

    // 旧名を別人が取る（ここが「別人の履歴に化ける」の再現条件）。
    const impostor = await j('/api/register', { method: 'POST', body: { username: 'きろくのひと', password: 'impostor-1234' } });
    check('D-1 旧名は別人が取れる（取れないと再現できない）', impostor.status === 200, `HTTP ${impostor.status} ${impostor.error || ''}`);

    const mine = await j(`/api/admin/playerstats/${uid}`, {}, atk);
    check('D-2 改名しても自分の通報は自分の履歴に残る',
      (mine.reports || []).some(r => String(r.text || '').includes('改名テスト用')),
      `件数=${(mine.reports || []).length}`);
    const theirs = await j(`/api/admin/playerstats/${impostor.user.id}`, {}, atk);
    check('D-3 旧名を取った別人の履歴には出てこない',
      !(theirs.reports || []).some(r => String(r.text || '').includes('改名テスト用')),
      `件数=${(theirs.reports || []).length}`);

    // --- C: 改名に殿堂が追従する ---
    const hof1 = await j('/api/halloffame');
    const top1 = ((((hof1.seasons || [])[0] || {}).boards || [])[0] || {}).top || [];
    check('C-2 改名すると殿堂の名前も変わる（旧名が別人のものに見えない）',
      top1.some(t => t.username === 'あらためたひと') && !top1.some(t => t.username === 'きろくのひと'),
      JSON.stringify(top1.map(t => t.username)));

    // --- C: 退会で殿堂とお知らせの名前が伏せ字になる ---
    const del = await j('/api/me', { method: 'DELETE', body: { password: 'kiroku-1234' } }, u.token);
    check('C-3 退会できた', del.status === 200, `HTTP ${del.status} ${del.error || ''}`);
    await sleep(500);

    const hof2 = await j('/api/halloffame');
    const top2 = ((((hof2.seasons || [])[0] || {}).boards || [])[0] || {}).top || [];
    check('C-4 退会すると殿堂の名前が伏せ字になる',
      top2.some(t => String(t.username).includes('退会済み')), JSON.stringify(top2.map(t => t.username)));
    check('C-4 順位と記録そのものは歴代の事実として残る',
      top2.some(t => t.rank === 1 && t.value === 12345), JSON.stringify(top2));
    check('C-4 他の人は巻き添えにしない',
      top2.some(t => t.username === 'ほかのひと'), JSON.stringify(top2.map(t => t.username)));

    const news = await j('/api/news');
    const row = (news.news || []).find(n => n.id === 'news-hof-test');
    check('C-5 お知らせ本文からも退会者の名前が消える',
      !!row && !String(row.body).includes('あらためたひと') && String(row.body).includes('退会済み'),
      row ? String(row.body).replace(/\n/g, ' / ') : 'お知らせが無い');
    check('C-5 同じお知らせの他の人はそのまま',
      !!row && String(row.body).includes('ほかのひと'), row ? String(row.body).replace(/\n/g, ' / ') : '');
  }

  // =========================================================================
  // E. 同じ回線の同じ相手と繰り返し当たる
  // =========================================================================
  {
    const a = await j('/api/register', { method: 'POST', body: { username: 'れんせんA', password: 'rensen-a-1' } });
    const b = await j('/api/register', { method: 'POST', body: { username: 'れんせんB', password: 'rensen-b-1' } });
    check('E-0 下ごしらえの2アカウント', !!a.token && !!b.token, `${a.error || ''} ${b.error || ''}`);

    const seen = [];
    for (let i = 0; i < 4; i++) {
      const ca = await makeClient(a.token); open.push(ca);
      const cb = await makeClient(b.token); open.push(cb);
      ca.send({ type: 'queue', mode: 'duel' });
      cb.send({ type: 'queue', mode: 'duel' });
      await ca.wait('match_found', 20000);
      await cb.wait('match_found', 20000);
      await sleep(3500);
      ca.send({ type: 'state', score: 3000 + i, lines: 4, combo: 1 });
      await sleep(300);
      const r = await ca.wait('result', 25000);
      seen.push(r.friendly || null);
      ca.ws.close(); cb.ws.close();
      await sleep(400);
    }
    check('E-1 3戦目までは今までどおり（正直な連戦を止めない）',
      seen.slice(0, 3).every(f => !f), JSON.stringify(seen));
    check('E-2 4戦目からは練習試合に落ちる', seen[3] === 'repeat', JSON.stringify(seen));

    const sa = ((await j('/api/me', {}, a.token)).user || {}).stats || {};
    check('E-3 数えられた勝敗は3戦ぶんまで', (sa.pvpWins || 0) + (sa.pvpLosses || 0) === 3,
      `${sa.pvpWins}勝${sa.pvpLosses}敗`);
  }
} catch (err) {
  check('テストが最後まで走った', false, String((err && err.stack) || err));
} finally {
  for (const c of open) { try { c.ws.close(); } catch { /* もう閉じている */ } }
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🚫 取り締まりと身元  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
