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
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
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
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
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

  // (b) merge も、プレイヤーが既に居るサーバーには通らない。
  //
  // ここは以前『通るが未知の管理者は降格されるので安全』としていた。
  // その前提が誤りだった: 降格は「この機体に居るスタッフと同名なら見送る」
  // 実装だったため、公開情報である管理者名を騙るだけで admin のまま入り、
  // マージの勝敗(進行度)を巨大な stats で取れば本物の資格情報を上書きできた。
  // 未認証の1リクエストで管理者を奪える状態で、監査で実際に再現された。
  //
  // ファイル内のパスワードは**アップロードする側が用意できる**ので、
  // これを守るべきものがあるサーバーで通してはいけない。復旧導線としては
  // 「まだ誰も居ないサーバー」に限定して残してある（test/restore-auth.test.mjs）。
  r = await j('/api/admin/restore', { method: 'POST', body: { data: forged, mode: 'merge', password: FORGED_PW } });
  check('偽造ファイルでのマージ復元も拒否される', r.status === 401, `${r.status} ${r.error || ''}`);

  const evil = await j('/api/login', { method: 'POST', body: { username: '乗っ取り太郎', password: FORGED_PW } });
  check('仕込んだアカウントは作られていない', evil.status !== 200, `${evil.status}`);

  const realAdminStill = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
  check('本物の管理者パスワードが奪われていない', realAdminStill.status === 200, `${realAdminStill.status}`);

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

  // ---------------------------------------------------------------------
  // サーバーが勝敗を決めるモードは、直接申告できない
  // ---------------------------------------------------------------------
  // 監査で、新規アカウントが239msで4,875ジェム＋バッジ11種を取得できた。
  // /api/game/result に mode:'royale', won:true と書いて送るだけで、
  // server/battle.js が持っているサーバー側の勝敗判定を丸ごと飛び越えられた。
  {
    const g = await j('/api/register', { method: 'POST', body: { username: '直接申告太郎', password: 'pass1234' } });
    const gt = g.token;
    const before = (await j('/api/me', {}, gt)).user;
    for (const mode of ['royale', 'tournament', 'pvp', 'team', 'raid', 'coop', 'attack']) {
      await j('/api/game/result', { method: 'POST', body: { mode, won: true, score: 900000, lines: 400, maxCombo: 30, duration: 600 } }, gt);
    }
    const after = (await j('/api/me', {}, gt)).user;
    check('サーバー判定モードを直接申告してもジェムが増えない',
      after.gems === before.gems, `${before.gems}→${after.gems}💎`);
    check('バッジも付かない', (after.badges || []).length === (before.badges || []).length,
      `${(before.badges || []).length}→${(after.badges || []).length}種`);
    check('勝ち星も増えない', (after.stats.pvpWins || 0) === 0, `pvpWins=${after.stats.pvpWins}`);
  }

  // ---------------------------------------------------------------------
  // アカウント生涯の初回でも、スコアの上限は効く
  // ---------------------------------------------------------------------
  // 初回だけ猶予3600秒を与えていたため、3600×500=180万点 が絶対上限の
  // 100万点を上回り、上限チェックが一度も発動しなかった。
  // 実測で、新規アカウントが1リクエストで王座を6つ独占できた。
  {
    const v = await j('/api/register', { method: 'POST', body: { username: '初回一撃太郎', password: 'pass1234' } });
    await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1000000, lines: 900, maxCombo: 99, duration: 7200 } }, v.token);
    const me = (await j('/api/me', {}, v.token)).user;
    check('初回でも100万点は通らない', me.stats.bestScore < 1000000, `bestScore=${me.stats.bestScore}`);
    check('初回の上限が妥当な範囲', me.stats.bestScore <= 300 * 500, `bestScore=${me.stats.bestScore} (上限 ${300 * 500})`);
  }

  // ---------------------------------------------------------------------
  // __proto__ を id に渡しても、全ユーザーに波及しない
  // ---------------------------------------------------------------------
  // db.users['__proto__'] は Object.prototype を返す。そこに muted:true を
  // 書けたので、モデレーターが1回の操作で管理者を含む全員をミュートできた。
  {
    const r = await j('/api/mod/mute', { method: 'POST', body: { id: '__proto__', muted: true } }, adminTok);
    check('__proto__ を渡しても成功しない', r.status !== 200, `HTTP ${r.status}`);
    const someone = await j('/api/register', { method: 'POST', body: { username: '巻き添え太郎', password: 'pass1234' } });
    const me = (await j('/api/me', {}, someone.token)).user;
    check('無関係なユーザーがミュートされていない', !me.muted, `muted=${me.muted}`);
  }

  // ---------------------------------------------------------------------
  // 復元で受け付けるユーザー数に上限がある（1回で数分止められた）
  // ---------------------------------------------------------------------
  {
    const many = { users: {} };
    for (let i = 0; i < 25000; i++) {
      many.users['u' + i] = { id: 'u' + i, username: 'u' + i, passHash: 'x'.repeat(64), salt: 'y', role: 'admin' };
    }
    const r = await j('/api/admin/restore', { method: 'POST', body: { data: many, mode: 'merge', password: 'nope' } }, adminTok);
    check('巨大すぎるバックアップは弾かれる', r.status === 400, `HTTP ${r.status} ${r.error || ''}`);
  }

  // ---------------------------------------------------------------------
  // セキュリティヘッダ
  // ---------------------------------------------------------------------
  {
    const res = await fetch(BASE + '/');
    const csp = res.headers.get('content-security-policy') || '';
    check('CSP が付いている', csp.includes("default-src 'self'"), csp.slice(0, 50));
    check('外部スクリプトを許可していない', csp.includes("script-src 'self'") && !csp.includes('unsafe-eval'), '');
    check('Referrer-Policy が付いている', !!res.headers.get('referrer-policy'), '');
    check('X-Content-Type-Options が付いている', res.headers.get('x-content-type-options') === 'nosniff', '');
  }
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
