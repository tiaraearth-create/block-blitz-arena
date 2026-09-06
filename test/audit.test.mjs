// リポジトリのルートから:  node test/audit.test.mjs
//
// 🕵 記録の監査（GET /api/admin/audit）。
//
// ■ なぜ要るのか
// 「天井にぶつけた提出を🧾ログに残す」仕組みは v2.54 から。それ以前に置かれた
// 記録には証拠が1バイトも無いので、**残っている数字だけ**で「あり得ない／
// 噛み合わない」組を見つけるしかない。本番で実際に、Lv2〜3 のアカウントが
// ハイスコア100万ちょうど・塔100階踏破という形で並んでいた
// （v2.63.2 で塞いだ初回の持ち時間の穴の指紋）。
//
// ■ ここで守るのは2つ。**2つめのほうが大事。**
//   1. 見逃さない … あり得ない組をちゃんと拾う
//   2. **濡れ衣を着せない** … 正直に遊んでいる人を引っかけない
//
// アカウントの年齢と総プレイ時間を実際に効かせたいので、サーバーを止めて
// db.json を書き換えてから起動し直す（登録直後の値では検査が意味を持たない）。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-audit-test-${PORT}`);
const ADMIN_PW = 'audit-test-admin-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

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
      SESSION_SECRET: 'audit-test', SEED_RESTORE: '0', ADMIN_PASSWORD: ADMIN_PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null) throw new Error(`サーバーが起動直後に終了しました (${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const rowOf = (audit, name) => (audit.rows || []).find(r => r.username === name) || null;
const flagIds = row => (row ? row.flags.map(f => f.id) : []);

// 検査したい形。createdAt と playSecs は登録では作れないので db.json に直接置く。
const CASES = [
  // ① 本番で実際に並んでいた形。10分前に作られ、数回の提出で天井の数字だけがある。
  ['偽装っぽい人', { ageMs: 10 * 60 * 1000 },
    { bestScore: 1000000, gamesPlayed: 1, playSecs: 1890, dungeonMax: 100, underMax: 100 }],
  // ② 総プレイ時間と点数が噛み合わない形（時間の申告かスコアが後から入っている）。
  ['時間があり得ない人', { ageMs: 365 * DAY },
    { bestScore: 2000000, gamesPlayed: 500, playSecs: 300 }],
  // ③ 正直に長く遊んでいる上位者。**絶対に引っかけてはいけない。**
  ['正直な上位者', { ageMs: 365 * DAY },
    { bestScore: 900000, gamesPlayed: 800, playSecs: 200000, dungeonMax: 100, underMax: 100, heavenMax: 100 }],
  // ④ ふつうの人。
  ['ふつうの人', { ageMs: 30 * DAY }, { bestScore: 42000, gamesPlayed: 60, playSecs: 9000 }],
  // ⑤ 旧上限ちょうどだが、遊び込んでいる人（＝正直に100万以上を出して潰された人）。
  ['潰された人', { ageMs: 365 * DAY },
    { bestScore: 1000000, gamesPlayed: 500, playSecs: 150000, dungeonMax: 100 }],
  // ⑥ プレイ回数0なのに記録がある（それ自体が矛盾）。
  ['0回なのに記録がある人', { ageMs: 365 * DAY }, { bestScore: 50000, gamesPlayed: 0, playSecs: 0 }],
];

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const login = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: ADMIN_PW } });
  check('0-1 前提: 管理者でログインできた', !!login.token, JSON.stringify(login).slice(0, 80));
  let admin = login.token;

  const ids = {};
  for (const [name] of CASES) {
    const reg = await j('/api/register', { method: 'POST', body: { username: name, password: 'pw-audit-1234' } });
    if (!reg.token) throw new Error(`登録できません(${name}): ${JSON.stringify(reg)}`);
    ids[name] = reg.user.id;
  }

  // db.json にこの人たちが載るまで待ってから止める（保存は 250ms の debounce）。
  const dbPath = path.join(DIR, 'db.json');
  const allSaved = () => {
    try {
      const u = JSON.parse(fs.readFileSync(dbPath, 'utf8')).users;
      return CASES.every(([n]) => u[ids[n]]);
    } catch { return false; }
  };
  for (let i = 0; i < 40 && !allSaved(); i++) await sleep(150);
  check('0-2 前提: 全員が db.json に載った', allSaved(), '');
  await stop();

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  for (const [name, meta, stats] of CASES) {
    const rec = db.users[ids[name]];
    rec.createdAt = Date.now() - meta.ageMs;
    Object.assign(rec.stats, stats);
  }
  fs.writeFileSync(dbPath, JSON.stringify(db));
  await start();

  const relog = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: ADMIN_PW } });
  admin = relog.token || admin;

  const audit = await j('/api/admin/audit', {}, admin);
  check('1-1 監査を引けた', audit.status === 200 && Array.isArray(audit.rows), JSON.stringify(audit).slice(0, 90));
  check('1-2 検査した母数を返す', audit.total >= CASES.length, `${audit.total}人`);

  // ---- ① 本番で見つかった形 ----------------------------------------------
  const forged = rowOf(audit, '偽装っぽい人');
  check('2-1 本番で見つかった形を拾えた', !!forged, forged ? flagIds(forged).join(',') : '拾えていない');
  check('2-2 「踏破しているのにプレイ回数が少なすぎる」が付く',
    flagIds(forged).includes('deep_but_new'), flagIds(forged).join(','));
  check('2-3 「ほとんど遊んでいない」が付く',
    flagIds(forged).includes('score_no_play'), flagIds(forged).join(','));
  check('2-4 いちばん強い印が high として立つ', !!forged && forged.worst === 'high', forged && forged.worst);
  check('2-5 判断材料（何を見たか）が文章で添えてある',
    !!forged && forged.flags.every(f => f.detail && f.detail.length > 5), '');

  // ---- ② 総プレイ時間との矛盾 --------------------------------------------
  const overtime = rowOf(audit, '時間があり得ない人');
  check('3-1 総プレイ時間で出せる上限を超えた人を拾える',
    flagIds(overtime).includes('score_time'), flagIds(overtime).join(','));

  // ---- ③④ 濡れ衣を着せない（このテストの本命） ----------------------------
  const honest = rowOf(audit, '正直な上位者');
  check('4-1 遊び込んでいる上位者を1つも引っかけない', !honest,
    honest ? flagIds(honest).join(',') : '');
  check('4-2 ふつうの人も引っかけない', !rowOf(audit, 'ふつうの人'), '');

  // ---- ⑤ 旧上限は印どまり ------------------------------------------------
  const squashed = rowOf(audit, '潰された人');
  check('5-1 旧上限ちょうどは印として出る',
    flagIds(squashed).includes('retired_ceiling'), flagIds(squashed).join(','));
  check('5-2 それ単体では high にしない', !!squashed && squashed.worst === 'info', squashed && squashed.worst);

  // ---- ⑥ 回数0なのに記録がある -------------------------------------------
  check('6-1 プレイ0回で記録がある矛盾を拾える',
    flagIds(rowOf(audit, '0回なのに記録がある人')).includes('score_no_games'),
    flagIds(rowOf(audit, '0回なのに記録がある人')).join(','));

  // ---- 取り消し（運営画面のボタンが叩く経路そのもの） ----------------------
  const del = await j(`/api/admin/users/${encodeURIComponent(ids['偽装っぽい人'])}`,
    { method: 'POST', body: { setStats: { bestScore: 0, dungeonMax: 0, underMax: 0 } } }, admin);
  check('7-1 記録を取り消せる', del.status === 200, JSON.stringify(del).slice(0, 80));
  const after = await j('/api/admin/audit', {}, admin);
  check('7-2 取り消したら監査から消える', !rowOf(after, '偽装っぽい人'),
    flagIds(rowOf(after, '偽装っぽい人')).join(','));

  // ---- 権限 ---------------------------------------------------------------
  const reg = await j('/api/register', { method: 'POST', body: { username: 'のぞき見', password: 'pw-audit-1234' } });
  const denied = await j('/api/admin/audit', {}, reg.token);
  check('8-1 一般プレイヤーは見られない', denied.status === 403 || denied.status === 401, String(denied.status));
  const anon = await j('/api/admin/audit');
  check('8-2 未ログインも見られない', anon.status === 401 || anon.status === 403, String(anon.status));
  check('8-3 運営アカウントは対象外', !rowOf(after, 'るみまき'), '');
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
