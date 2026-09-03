// リポジトリのルートから:  node test/nameclaim.test.mjs
//
// 🪪 「名乗れる名前」の門。登録・改名・ゲスト名の3つで同じ厳しさにする。
//
// ■ 何が抜けていたか
//   名前の正規化は sanitizeName（前後を切る／16文字で切る／<>"'` を落とす）
//   だけで、**見えない文字**を素通ししていた。ゼロ幅スペースを1つ足した
//   「運営␣」は、予約名の検査にも既存ユーザーとの衝突検査にも当たらないのに、
//   画面では「運営」とまったく同じに見える。全角の「ａｄｍｉｎ」も同じ。
//   しかもゲスト名には文字種の検査が無かったので、キリル文字の "аdmin" や
//   空白だけの名前も名乗れた ── 断罪イベント中に偽の「運営」告知を流せる形。
//
// ■ 通したい細い道
//   ・緩すぎる → 上のとおりなりすませる。
//   ・厳しすぎる → **ログインの照合まで正規化すると、正規化前に作られた名前を
//     持つ人がログインできなくなる**。名乗り直す場面だけを厳しくして、
//     すでに持っている名前の照合は今までどおりにする。
//
// ■ ここで見るもの
//   ① ゼロ幅スペース／全角で予約名・既存ユーザーになりすませない（登録）
//   ② 改名でも同じ（登録だけ塞いでも改名で抜けられる、をやらない）
//   ③ ゲスト名も同じ門を通る（WSの hello）
//   ④ ふつうの名前は今までどおり通る（巻き添えが無い）
//   ⑤ ログインの照合は厳しくしていない（既存ユーザーを締め出さない）
//   ⑥ 断る理由を出し分けない（名前の投げ分けで住人を炙り出せない）
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
const DIR = path.join(os.tmpdir(), `bba-nameclaim-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ZWSP = '​';        // ゼロ幅スペース
const VS16 = '️';        // 異体字セレクタ
const RLO = '‮';         // 書字方向の上書き

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
      SESSION_SECRET: 'nameclaim-test', SEED_RESTORE: '0',
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

/** hello で名乗った名前を、サーバーがどう受理したか返す。 */
function helloName(guestName) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const to = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } rej(new Error('hello_ok timeout')); }, 8000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'hello_ok') { clearTimeout(to); res(m.name); try { ws.close(); } catch { /* ignore */ } }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', guestName })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // =========================================================================
  // ① 登録
  // =========================================================================
  {
    const cases = [
      ['ゼロ幅スペース付きの「運営」', `運営${ZWSP}`],
      ['先頭にゼロ幅スペース', `${ZWSP}運営`],
      ['全角の admin', 'ａｄｍｉｎ'],
      ['異体字セレクタ付きの「ゼロ」', `ゼロ${VS16}`],
      ['書字方向の上書き入り', `管理者${RLO}ゼロ`],
    ];
    for (const [label, name] of cases) {
      const r = await j('/api/register', { method: 'POST', body: { username: name, password: 'pass1234' } });
      check(`① ${label} で登録できない`, r.status !== 200, `HTTP ${r.status} ${r.error || ''}`);
    }
    // キリル文字・空白・短すぎ・絵文字は「形が悪い」として弾かれる。
    for (const [label, name] of [
      ['キリル文字の аdmin', 'аdmin'],
      ['空白だけ', '   '],
      ['1文字', 'あ'],
      ['絵文字だけ', '🙂🙂'],
    ]) {
      const r = await j('/api/register', { method: 'POST', body: { username: name, password: 'pass1234' } });
      check(`① ${label} は登録できない`, r.status === 400, `HTTP ${r.status} ${r.error || ''}`);
    }
  }

  // =========================================================================
  // ④ ふつうの名前は通る（巻き添えが無い）
  // =========================================================================
  const ok = await j('/api/register', { method: 'POST', body: { username: 'ふつうのひと', password: 'pass1234' } });
  check('④ ふつうの日本語名は今までどおり登録できる', ok.status === 200, `HTTP ${ok.status} ${ok.error || ''}`);
  const okEn = await j('/api/register', { method: 'POST', body: { username: 'Normal_Player-1', password: 'pass1234' } });
  check('④ 英数字・ハイフン・アンダースコアも通る', okEn.status === 200, `HTTP ${okEn.status} ${okEn.error || ''}`);

  // =========================================================================
  // ⑤ ログインの照合は厳しくしていない
  // =========================================================================
  {
    const r = await j('/api/login', { method: 'POST', body: { username: 'ふつうのひと', password: 'pass1234' } });
    check('⑤ 登録した名前でそのままログインできる', r.status === 200, `HTTP ${r.status} ${r.error || ''}`);
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const login = src.slice(src.indexOf("app.post('/api/login'"));
    const body = login.slice(0, login.indexOf('\n});'));
    check('⑤ ログインは claimName を使っていない（既存ユーザーを締め出さない）',
      !/claimName\(/.test(body) && /sanitizeName\(req\.body\.username\)/.test(body), '');
  }

  // =========================================================================
  // ② 改名でも同じ門
  // =========================================================================
  {
    const tok = ok.token;
    for (const [label, name] of [
      ['ゼロ幅スペース付きの「運営」', `運営${ZWSP}`],
      ['全角の admin', 'ａｄｍｉｎ'],
      ['キリル文字の аdmin', 'аdmin'],
    ]) {
      const r = await j('/api/me/rename', { method: 'POST', body: { username: name } }, tok);
      check(`② 改名でも ${label} は通らない`, r.status !== 200, `HTTP ${r.status} ${r.error || ''}`);
    }
    // 巻き添え確認: ふつうの改名は通る（1日1回の門があるので1回だけ）。
    const r2 = await j('/api/me/rename', { method: 'POST', body: { username: 'あたらしいなまえ' } }, tok);
    check('② ふつうの改名は今までどおり通る', r2.status === 200, `HTTP ${r2.status} ${r2.error || ''}`);
  }

  // =========================================================================
  // ③ ゲスト名（WS の hello）
  // =========================================================================
  {
    for (const [label, name] of [
      ['ゼロ幅スペース付きの「運営」', `運営${ZWSP}`],
      ['全角の admin', 'ａｄｍｉｎ'],
      ['キリル文字の аdmin', 'аdmin'],
      ['空白だけ', '   '],
      ['絵文字だけ', '🙂🙂'],
      ['既存ユーザーの名前', 'あたらしいなまえ'],
      ['予約名', '運営'],
    ]) {
      const got = await helloName(name);
      check(`③ ゲストは ${label} を名乗れない`, got.startsWith('ゲスト'), `name=${JSON.stringify(got)}`);
    }
    const good = await helloName('とおりすがり');
    check('③ ふつうのゲスト名は今までどおり通る', good === 'とおりすがり', `name=${good}`);
  }

  // =========================================================================
  // ⑥ 断る理由を出し分けない
  // =========================================================================
  {
    // ②で 'ふつうのひと' は改名済みなので、確実に在籍している名前を使う。
    const taken = await j('/api/register', { method: 'POST', body: { username: 'Normal_Player-1', password: 'pass1234' } });
    const reserved = await j('/api/register', { method: 'POST', body: { username: '運営', password: 'pass1234' } });
    check('⑥ 既存ユーザーと予約名で同じ応答になる',
      taken.status === reserved.status && taken.error === reserved.error,
      `${taken.status}:${taken.error} / ${reserved.status}:${reserved.error}`);
  }
} catch (err) {
  check('テストが最後まで走った', false, String((err && err.stack) || err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🪪 名乗れる名前の門  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
