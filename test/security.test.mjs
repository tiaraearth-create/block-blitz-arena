// Run from the repo root:  node test/security.test.mjs  (needs a free port 3110)
//
// v2.11 で塞いだ2つの穴の回帰テスト。どちらも「正規の使い方は通したまま、
// 悪用経路だけを閉じる」形なので、両側を押さえる。
//
//   1. POST /api/admin/restore
//      復旧用にセッション無しで叩けるのは意図どおり（ログインできない状態から
//      戻すための導線）。ただし以前は「アップロードされたファイルの中の管理者
//      ハッシュ」と入力パスワードを突き合わせていた。ファイルは攻撃者が作れる
//      ので、ハッシュも攻撃者が決められる = 誰でも本番を書き換えられた。
//      いまは (a) 現在の管理者パスワード なら何でも可、(b) ファイル側の
//      パスワードで通した場合は merge のみ・かつ未知の管理者は一般ユーザーに
//      降格して取り込む。
//
//   2. POST /api/game/result
//      1回あたりの報酬に上限はあったが、エンドポイント自体は無制限だった。
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3110;
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-security-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* empty body */ }
  return { status: r.status, ...d };
};

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'security-test', SEED_RESTORE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* not up yet */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

// Mint a password hash the same way server/auth.js does, so a forged backup is
// indistinguishable from a real one as far as the old check was concerned.
function hashLike(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, passHash };
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const adminTok = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  check('管理者ログイン', !!adminTok);

  const victim = await j('/api/register', { method: 'POST', body: { username: '常連プレイヤー', password: 'pass1234' } });
  check('一般プレイヤーが存在する状態を作る', victim.status === 200, victim.error || '');

  const real = await j('/api/admin/backup', {}, adminTok);
  check('バックアップが取れる', !!real.users, '');

  // ---------------------------------------------------------------------
  // 1. 復元エンドポイント
  // ---------------------------------------------------------------------

  // 攻撃者の作ったダンプ: 自分の知っているパスワードの管理者を1人仕込む。
  const FORGED_PW = 'attacker-knows-this';
  const forged = JSON.parse(JSON.stringify(real));
  delete forged.status;
  const evilId = crypto.randomUUID();
  const { salt, passHash } = hashLike(FORGED_PW);
  forged.users[evilId] = {
    id: evilId, username: '乗っ取り太郎', role: 'admin', salt, passHash,
    coins: 0, gems: 0, xp: 0, badges: [], achievements: [], owned: [], items: {},
    equipped: {}, stats: { gamesPlayed: 0, totalScore: 0 },
  };

  // (a) replace は現在のパスワードでしか通らない — 生データを消せる操作なので
  let r = await j('/api/admin/restore', { method: 'POST', body: { data: forged, mode: 'replace', password: FORGED_PW } });
  check('偽造ファイルでの置き換え復元は拒否される', r.status === 401, `${r.status} ${r.error || ''}`);

  // (b) merge は通るが、未知の管理者は一般ユーザーとして取り込まれる
  r = await j('/api/admin/restore', { method: 'POST', body: { data: forged, mode: 'merge', password: FORGED_PW } });
  check('偽造ファイルでのマージ復元自体は通る（復旧導線を残す）', r.status === 200, `${r.status} ${r.error || ''}`);

  const evil = await j('/api/login', { method: 'POST', body: { username: '乗っ取り太郎', password: FORGED_PW } });
  check('仕込んだアカウントは作られる', evil.status === 200, evil.error || '');
  check('しかし管理者ではなく一般ユーザーに降格されている', evil.user && evil.user.role !== 'admin', `role=${evil.user && evil.user.role}`);

  const stolen = await j('/api/admin/stats', {}, evil.token);
  check('降格された結果、管理APIは使えない', stolen.status === 403, `${stolen.status}`);

  const stillThere = await j('/api/profile/常連プレイヤー');
  check('既存プレイヤーは無事', stillThere.status === 200, `${stillThere.status}`);

  // (c) 本物の管理者パスワードなら replace も通る（運用を壊さない）
  const clean = JSON.parse(JSON.stringify(real));
  delete clean.status;
  r = await j('/api/admin/restore', { method: 'POST', body: { data: clean, mode: 'replace', password: adminPw } });
  check('現在の管理者パスワードなら置き換え復元も通る', r.status === 200, `${r.status} ${r.error || ''}`);

  // (d) パスワード無しは即座に拒否
  r = await j('/api/admin/restore', { method: 'POST', body: { data: clean, mode: 'merge' } });
  check('パスワード無しは拒否される', r.status === 401, `${r.status}`);

  // ---------------------------------------------------------------------
  // 2. /api/game/result のレート制限
  // ---------------------------------------------------------------------

  const player = await j('/api/register', { method: 'POST', body: { username: '連打太郎', password: 'pass1234' } });
  const ptok = player.token;
  const before = (await j('/api/me', {}, ptok)).user.coins;

  let ok = 0, limited = 0;
  for (let i = 0; i < 45; i++) {
    const res = await j('/api/game/result', {
      method: 'POST',
      body: { mode: 'solo', score: 200000, lines: 40, maxCombo: 9, duration: 600 },
    }, ptok);
    if (res.status === 200) ok++;
    else if (res.status === 429) limited++;
  }
  check('連打はいずれ429で止まる', limited > 0, `成功${ok}件 / 429が${limited}件`);
  check('正当なプレイ量(30件)は通る', ok >= 30, `成功${ok}件`);

  const after = (await j('/api/me', {}, ptok)).user.coins;
  check('稼げる上限が有限になっている', after - before <= 30 * 1000 + 5000, `+${after - before}🪙`);

  // 制限は「ユーザーごと」— 巻き込まれる他人がいないことを確認する
  const bystander = await j('/api/register', { method: 'POST', body: { username: '無関係さん', password: 'pass1234' } });
  const rb = await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 5000, lines: 8, maxCombo: 3, duration: 60 } }, bystander.token);
  check('別のプレイヤーは巻き込まれない', rb.status === 200, `${rb.status}`);

  // ---------------------------------------------------------------------
  // 3. duration 詐称
  //
  // レート上限は score / duration で判定するが、その duration はクライアント
  // 申告だった。「7200秒プレイした」と偽れば上限が事実上外れ、1回で
  // 1,000,000点まで通せた（レート制限があっても分あたり3万コインは作れる）。
  // 直前の送信からの実経過時間は誰にも偽れないので、それを上界にする。
  // ---------------------------------------------------------------------
  {
    const c = await j('/api/register', { method: 'POST', body: { username: '詐称太郎', password: 'pass1234' } });
    const ct = c.token;
    // 1回目は基準になる直前送信が無いので猶予つき（それでも1時間ぶんが上限）
    await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 3000, lines: 5, maxCombo: 2, duration: 30 } }, ct);
    const base = (await j('/api/me', {}, ct)).user;
    check('正当な範囲のスコアはそのまま通る', base.stats.bestScore === 3000, `bestScore=${base.stats.bestScore}`);

    // 2回目: 直後に「7200秒プレイした」と主張して上限いっぱいを狙う
    await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1000000, lines: 500, maxCombo: 50, duration: 7200 } }, ct);
    const after = (await j('/api/me', {}, ct)).user;
    check('duration を偽っても実経過時間までしか通らない',
      after.stats.bestScore < 100000,
      `bestScore=${after.stats.bestScore}（7200秒を申告しても1,000,000は通らない）`);
    check('稼げるコインも有限にとどまる', after.coins < 5000, `${after.coins}🪙`);
  }
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
