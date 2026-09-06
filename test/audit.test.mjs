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

  // ---- ★ 同じ点の写しも消せること（v2.70） --------------------------------
  //
  // ⚠ 取り消しは bestScore しか消していなかった。ところが1回の走りで出た点は
  //   各モードの自己ベストにも写し取られる。しかもそれらは EDITABLE_STATS に
  //   無かったので、**運営には消す手段そのものが存在しなかった**。
  //   実害: soloBest は本人のソロ開始画面に「BEST ◯◯」と出続け、
  //   meltdown / chimera / chain / rush / blueprint は順位表の部門が実在する
  //   （index.js の LB_BOARDS）ので、不正記録が板に居座っても手が出せない。
  {
    const FAM = ['soloBest', 'meltdownBest', 'chimeraBest', 'chainBest',
      'chainMax', 'rushDepth', 'blueprintClears', 'ghostBest'];
    const id = ids['偽装っぽい人'];
    // まず全部に値を入れてから、監査ボタンと同じ形で 0 を送る。
    const seed = await j(`/api/admin/users/${encodeURIComponent(id)}`,
      { method: 'POST', body: { setStats: Object.fromEntries(FAM.map(k => [k, 777])) } }, admin);
    check('7-3 ★各モードの自己ベストを運営が編集できる', seed.status === 200,
      JSON.stringify(seed).slice(0, 120));
    const wiped = await j(`/api/admin/users/${encodeURIComponent(id)}`,
      { method: 'POST', body: { setStats: Object.fromEntries(FAM.map(k => [k, 0])) } }, admin);
    const st = (wiped.user && wiped.user.stats) || {};
    const left = FAM.filter(k => (Number(st[k]) || 0) !== 0);
    check('7-4 ★写しも 0 に戻せる', wiped.status === 200 && left.length === 0, left.join(','));
  }

  // ---- ★ 何をいくつから いくつにしたかが操作ログに残ること（v2.70） -------
  //
  // ⚠ adminLog は入れ子の object を「N項目」に潰すので、記録されるのは
  //   {"setStats":"4項目"} だけだった。押し間違えても、どの欄をいくつから
  //   いくつに変えたのかがどこにも無く、ログを見て戻すことができなかった。
  //   ハイスコアの取り消しは「不正の疑い」に対する人の判断で、間違えうる操作。
  {
    const id = ids['0回なのに記録がある人'];
    const before = (await j(`/api/admin/users/${encodeURIComponent(id)}`, {}, admin));
    const was = ((before.user && before.user.stats) || {}).bestScore || 0;
    await j(`/api/admin/users/${encodeURIComponent(id)}`,
      { method: 'POST', body: { setStats: { bestScore: 0 } } }, admin);
    const log = await j('/api/admin/log', {}, admin);
    const rows = (log.log || log.entries || log.items || []);
    const hit = rows.find(r => r && r.action === 'user_edit' && r.detail && r.detail.statsDiff);
    check('7-5 ★取り消しの前後が操作ログに残る',
      !!hit && String(hit.detail.statsDiff).includes('bestScore')
        && String(hit.detail.statsDiff).includes(was.toLocaleString('en-US')),
      hit ? String(hit.detail.statsDiff) : `statsDiff が無い（前の値 ${was}）`);
  }

  // ---- 🧰 scripts/clear-record.mjs（運営が実際に叩く道具）------------------
  //
  // 画面のボタンと同じAPIを叩くだけの道具だが、**本番のデータを書き換える**
  // ので、素通しにはしない。本物のスクリプトを子プロセスで走らせて、
  //   ・確認に yes と答えない限り 1バイトも書き換えない
  //   ・名指しした人しか触らない
  //   ・実際に取り消せる
  // を通しで見る。
  {
    const run = (args, stdin) => new Promise(resolve => {
      const ps = spawn(process.execPath, [path.join(ROOT, 'scripts', 'clear-record.mjs'),
        '--url', BASE, ...args], { env: { ...process.env, ADMIN_PASSWORD: ADMIN_PW } });
      let out = '';
      ps.stdout.on('data', d => { out += d; });
      ps.stderr.on('data', d => { out += d; });
      ps.stdin.end(stdin === undefined ? '' : stdin);
      ps.on('close', code => resolve({ code, out }));
    });
    const name = '時間があり得ない人';
    const idOf = n => ids[n];
    const scoreOf = async n => {
      const d = await j(`/api/admin/users/${encodeURIComponent(idOf(n))}`, {}, admin);
      return ((d.user && d.user.stats) || {}).bestScore || 0;
    };

    // ① 下見（--apply 無し）は絶対に書き換えない
    const was = await scoreOf(name);
    const dry = await run([]);
    check('9-1 下見だけでは何も書き換えない', dry.code === 0 && (await scoreOf(name)) === was,
      `code=${dry.code} / ${was} → ${await scoreOf(name)}`);
    check('9-2 下見で監査の一覧が出る', /気になる点があります/.test(dry.out),
      dry.out.split('\n').slice(0, 3).join(' / '));

    // ② --apply でも、確認に yes と答えなければ書き換えない
    const no = await run(['--apply', name], 'no\n');
    check('9-3 ★確認に yes と答えなければ書き換えない',
      (await scoreOf(name)) === was && /中止しました/.test(no.out),
      `${was} → ${await scoreOf(name)}`);

    // ③ 一覧に居ない名前は弾く（打ち間違いで別人を消さない）
    const bad = await run(['--apply', 'そんな人はいない'], 'yes\n');
    check('9-4 ★一覧に居ない名前は弾く', bad.code === 1 && /居ません/.test(bad.out),
      `code=${bad.code}`);

    // ④ 名前を挙げずに --apply しても消さない（一括削除の事故を作らない）
    const none = await run(['--apply'], 'yes\n');
    check('9-5 ★名前を挙げない一括取り消しはできない',
      none.code === 1 && (await scoreOf(name)) === was, `code=${none.code}`);

    // ⑤ yes と答えたら実際に消える
    const yes = await run(['--apply', name], 'yes\n');
    check('9-6 yes なら取り消せる', yes.code === 0 && (await scoreOf(name)) === 0,
      `${was} → ${await scoreOf(name)} / ${yes.out.split('\n').filter(l => /✅|❌|⚠/.test(l)).join(' ')}`);

    // ⑥ 名指しした人以外は無傷
    // 名指ししていない人が巻き添えになっていないこと。
    // 「潰された人」は CASES で bestScore 1,000,000 を持たされていて、
    // ここまでの取り消しは一度もこの人を名指ししていない。
    const other = await scoreOf('潰された人');
    check('9-7 ★名指ししていない人は無傷', other === 1000000,
      `ハイスコア=${other}（期待 1000000）`);
  }

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
