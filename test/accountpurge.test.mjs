// リポジトリのルートから:  node test/accountpurge.test.mjs
//
// 🚪 退会（DELETE /api/me）と管理者削除（DELETE /api/admin/users/:id）の後始末。
//
// ■ なぜこのテストが要るのか
//   server/routes/admin.js の purgeUserContent には「呼ぶのは2本」とコメントが
//   書いてあったのに、実際に呼んでいたのは管理者経路だけで、**実際に多いほうの
//   経路（本人の退会）が素通り**していた。コメントは嘘をつけるがテストはつけない。
//   同じ非対称が次に生えたときへの見張りとして、ここで両経路を固定する。
//
// ■ 見るもの
//   ① 削除経路は2本とも purgeUserContent を通る（ソース検査 ── UGC の掃除は
//      工房の投稿を1本作らないと外から観測できないので、門の存在で見張る）
//   ② 🐛バグ報告の報告者名が伏せ字になる（件数と本文は残る）
//   ③ 💬全体チャットの履歴から名前が消える（次に繋いだ人へ配られない）
//   ④ 🚪開いている WebSocket が閉じる（退会後も旧名で発言できない）
//   ⑤ トークンが失効する
//   ⑥ 🪦墓標: replace 復元でも削除済みアカウントは復活しない
//   ⑦ ⑥の巻き添えが無い（生きているアカウントは replace でちゃんと戻る）
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
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-accountpurge-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const api = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opt.headers || {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なし */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'accountpurge-test', SEED_RESTORE: '0',
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

// hello_ok を受け取るまで待つ小さなWSクライアント。hello_ok の中身（chat 履歴）も返す。
function connect(token, guestName) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('hello_ok timeout')), 8000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'hello_ok') { clearTimeout(to); res({ ws, hello: m }); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, guestName })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });

  // =========================================================================
  // ① ソース検査 — 削除経路は2本とも purgeUserContent を通る
  //
  // 実行前に見る（サーバーの起動を待たずに落ちてくれたほうが早い）。
  // =========================================================================
  {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const adminSrc = fs.readFileSync(path.join(ROOT, 'server/routes/admin.js'), 'utf8');

    // 本人の退会。ハンドラ本体の中に呼び出しがあること（import だけでは足りない）。
    const selfDelete = indexSrc.slice(indexSrc.indexOf("app.delete('/api/me'"));
    const selfBody = selfDelete.slice(0, selfDelete.indexOf('\n});'));
    check('① 本人の退会 DELETE /api/me が purgeUserContent を呼ぶ',
      selfBody.includes('purgeUserContent('), selfBody.includes('purgeUserContent(') ? '' : '呼び出しが無い');
    check('① そのために import されている',
      /import\s*\{[^}]*purgeUserContent[^}]*\}\s*from\s*'\.\/routes\/admin\.js'/.test(indexSrc));

    const admDelete = adminSrc.slice(adminSrc.indexOf("adminRouter.delete('/api/admin/users/:id'"));
    const admBody = admDelete.slice(0, admDelete.indexOf('\n});'));
    check('① 管理者削除 DELETE /api/admin/users/:id も purgeUserContent を呼ぶ',
      admBody.includes('purgeUserContent('));

    // 後始末の実体。増えた掃除がこの1本の中にあること（経路ごとに散らさない）。
    const fn = adminSrc.slice(adminSrc.indexOf('export function purgeUserContent'));
    const fnBody = fn.slice(0, fn.indexOf('\n}\n'));
    for (const [what, needle] of [
      ['工房', 'purgeUserWorkshop('],
      ['デイリーのゴースト', 'purgeUserDailyReplays('],
      ['購入履歴', 'anonymizeUserTransactions('],
      ['バグ報告', 'db.bugreports'],
      ['クライアントエラー', 'clientErrors'],
      ['チャット履歴', 'scrubDepartedName'],
      ['WebSocket', 'disconnectUser'],
    ]) {
      check(`① 後始末に「${what}」が入っている`, fnBody.includes(needle));
    }
  }

  await start();
  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const atk = (await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  check('管理者でログインできる', !!atk);

  const PW = 'taikai-pass-1';
  const NAME = 'やめるひと';
  const reg = await api('/api/register', { method: 'POST', body: { username: NAME, password: PW } });
  check('退会するアカウントを作れた', !!reg.token, reg.error || '');
  const tok = reg.token;
  const uid = reg.user.id;

  // 巻き添えが無いことを見るための「残る人」。
  const keep = await api('/api/register', { method: 'POST', body: { username: 'のこるひと', password: 'nokoru-pass-1' } });
  check('残るアカウントも作れた', !!keep.token, keep.error || '');

  // ---- ②の下ごしらえ: バグ報告を1件出す ----
  const bug = await api('/api/bugreport', { method: 'POST', body: { text: '退会テスト用の報告です。よろしくおねがいします' } }, tok);
  check('バグ報告を出せた', bug.status === 200 || bug.ok === true, `HTTP ${bug.status} ${bug.error || ''}`);

  // ---- ③④の下ごしらえ: WSでチャットして、繋いだままにする ----
  const CHAT_TEXT = 'たいかいするまえのはつげんです';
  const a = await connect(tok);
  a.ws.send(JSON.stringify({ type: 'chat', text: CHAT_TEXT }));
  await sleep(600);
  {
    const probe = await connect(undefined, 'みているひと');
    const seen = (probe.hello.chat || []).some(e => e && e.from === NAME);
    check('③(前提) 退会前はチャット履歴に名前が載っている', seen,
      JSON.stringify((probe.hello.chat || []).map(e => e && e.from)));
    probe.ws.close();
  }

  let closed = false;
  a.ws.on('close', () => { closed = true; });

  // 退会前のバックアップ（⑥⑦で使う）。
  const backup = await api('/api/admin/backup', {}, atk);
  check('退会前のバックアップを取れた', !!(backup.users && backup.users[uid]), `users=${backup.users ? Object.keys(backup.users).length : 0}`);

  // =========================================================================
  // 退会する
  // =========================================================================
  const del = await api('/api/me', { method: 'DELETE', body: { password: PW } }, tok);
  check('退会できた', del.status === 200 && del.ok === true, `HTTP ${del.status} ${del.error || ''}`);
  await sleep(800);

  // ---- ② バグ報告の報告者名 ----
  {
    const list = await api('/api/admin/bugreports', {}, atk);
    const rows = list.reports || [];
    const mine = rows.filter(r => r && String(r.text || '').includes('退会テスト用の報告'));
    check('② 報告そのものは残っている（件数も本文も）', mine.length === 1, `件数=${mine.length}`);
    check('② 報告者名が伏せ字になっている',
      mine.length === 1 && mine[0].by !== NAME && String(mine[0].by).includes('退会済み'),
      mine.length === 1 ? `by=${mine[0].by}` : '');
  }

  // ---- ③ チャット履歴 ----
  {
    const probe = await connect(undefined, 'あとからきたひと');
    const names = (probe.hello.chat || []).map(e => e && e.from);
    check('③ 退会者の名前がチャット履歴から消えている', !names.includes(NAME), JSON.stringify(names));
    const still = (probe.hello.chat || []).find(e => e && e.text === CHAT_TEXT);
    check('③ 発言そのものは会話の流れとして残る（名前だけ伏せる）',
      !!still && String(still.from).includes('退会済み'), still ? `from=${still.from}` : '発言ごと消えている');
    probe.ws.close();
  }

  // ---- ④ WebSocket が閉じている ----
  check('④ 退会した人の WebSocket が閉じられた', closed || a.ws.readyState === WebSocket.CLOSED,
    `readyState=${a.ws.readyState}`);

  // ---- ⑤ トークン失効 ----
  {
    const me = await api('/api/me', {}, tok);
    check('⑤ 退会後のトークンでは /api/me が通らない', me.status === 401 || me.status === 403, `HTTP ${me.status}`);
  }

  // ---- 退会したのでレコードも消えている ----
  {
    const again = await api('/api/login', { method: 'POST', body: { username: NAME, password: PW } });
    check('退会したアカウントではログインできない', again.status !== 200, `HTTP ${again.status}`);
  }

  // =========================================================================
  // ⑥⑦ 墓標 — replace 復元で削除済みアカウントは復活しない
  // =========================================================================
  {
    const before = await api('/api/admin/users', {}, atk);
    const rest = await api('/api/admin/restore', {
      method: 'POST', body: { mode: 'replace', password: adminPw, data: backup },
    }, atk);
    check('replace 復元そのものは成功する', rest.status === 200, `HTTP ${rest.status} ${rest.error || ''}`);
    await sleep(500);

    const zombie = await api('/api/login', { method: 'POST', body: { username: NAME, password: PW } });
    check('⑥ 削除済みアカウントは replace 復元でも復活しない', zombie.status !== 200,
      `HTTP ${zombie.status}`);

    const alive = await api('/api/login', { method: 'POST', body: { username: 'のこるひと', password: 'nokoru-pass-1' } });
    check('⑦ 生きているアカウントは replace 復元でちゃんと戻る', alive.status === 200,
      `HTTP ${alive.status} ${alive.error || ''}`);
    const stillAdmin = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
    check('⑦ 管理者も無事', stillAdmin.status === 200, `HTTP ${stillAdmin.status}`);
    void before;
  }
} catch (err) {
  check('テストが最後まで走った', false, String((err && err.stack) || err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🚪 退会の後始末  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
