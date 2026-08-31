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

    // 2回目: 直後に「7200秒プレイした」と主張して上限いっぱいを狙う。
    // v2.14 でレート上限は 500→2000/秒 に上げた（会心のプレイが切られる
    // 悪仕様の解消）。だが本当の防御は「直前送信からの実経過時間」の方で、
    // ここは据え置き。直後の連投なので猶予90秒しか経っておらず、
    // 90秒 × 2000/秒 = 180,000 が上界。7200秒の申告は一切効かない。
    await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1000000, lines: 500, maxCombo: 50, duration: 7200 } }, ct);
    const after = (await j('/api/me', {}, ct)).user;
    check('duration を偽っても実経過時間までしか通らない',
      after.stats.bestScore < 200000,
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
  // v2.14: レート上限は 2000/秒 に上げたが、初回の持ち時間は「アカウントの
  // 年齢（最大30分）＋猶予90秒」のまま。作りたてのアカウント（年齢≒0）の
  // 1リクエストは 90秒 × 2000/秒 = 180,000 が上界で、絶対上限100万には届かない。
  {
    const v = await j('/api/register', { method: 'POST', body: { username: '初回一撃太郎', password: 'pass1234' } });
    await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1000000, lines: 900, maxCombo: 99, duration: 7200 } }, v.token);
    const me = (await j('/api/me', {}, v.token)).user;
    check('初回でも100万点は通らない', me.stats.bestScore < 1000000, `bestScore=${me.stats.bestScore}`);
    check('初回の上限が妥当な範囲', me.stats.bestScore <= 200000, `bestScore=${me.stats.bestScore} (上限 200,000)`);
  }

  // ---------------------------------------------------------------------
  // mode 文字列で stats を無限に太らせられない
  //
  // mode はキー生成に使われる（`${mode}Prev`）のに検証されておらず、
  // 'dungeon' で始まる巨大文字列を送ると、その文字列がまるごと永続キー名に
  // なった。1リクエストごとに ~60KB の新キーが増え、やがて db.json の保存
  // そのものが静かに失敗しうる（全プレイヤーの進捗が次の再起動で消える）。
  // ---------------------------------------------------------------------
  {
    const v = await j('/api/register', { method: 'POST', body: { username: '肥大化太郎', password: 'pass1234' } });
    const junk = 'dungeon' + 'x'.repeat(60000);
    const r = await j('/api/game/result', { method: 'POST', body: { mode: junk, score: 100, floor: 10, duration: 30 } }, v.token);
    check('巨大 mode の申告でもサーバーは落ちない', r.status === 200, `status=${r.status}`);
    const me = (await j('/api/me', {}, v.token)).user;
    const statsSize = JSON.stringify(me.stats).length;
    check('巨大 mode が stats の永続キーにならない', statsSize < 4000, `stats=${statsSize}B`);
    const bigKeys = Object.keys(me.stats).filter(k => k.length > 40);
    check('mode 由来の巨大キーが1つも無い', bigKeys.length === 0, bigKeys.map(k => k.slice(0, 20) + '…').join(','));
  }

  // ---------------------------------------------------------------------
  // mode にプロトタイプ上のキー名を渡しても、💎が消えない
  //
  // DUNGEON_REALMS[mode] は素の添字引きだったので、mode:'constructor' で
  // Object 関数が返り truthy になった。realm.perDecade が undefined のまま
  // 加算されて user.gems が NaN になり、migrateUser の Number.isFinite ガードが
  // それを 0 に潰す ── 実測で 💎5,200 が db.json ごと消えた（復旧不能）。
  // badges には null が、stats には 'undefined' / 'constructorPrev' という
  // 永久ゴミキーが残った。
  // ---------------------------------------------------------------------
  {
    const v = await j('/api/register', { method: 'POST', body: { username: '汚染太郎', password: 'pass1234' } });
    await j('/api/admin/users/' + v.user.id, { method: 'POST', body: { setGems: 5200 } }, adminTok);
    const before = (await j('/api/me', {}, v.token)).user.gems;
    for (const evil of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const r = await j('/api/game/result', { method: 'POST', body: { mode: evil, floor: 100, score: 5000, duration: 300 } }, v.token);
      check(`mode:'${evil}' でも 200 で返る`, r.status === 200, `status=${r.status}`);
    }
    const me = (await j('/api/me', {}, v.token)).user;
    check('プロトタイプ名の mode で💎が消えない', me.gems >= before, `${before} -> ${me.gems}`);
    check('badges に文字列以外が混ざらない', me.badges.every(b => typeof b === 'string'), JSON.stringify(me.badges));
    const junkKeys = Object.keys(me.stats).filter(k => k === 'undefined' || (k.endsWith('Prev') && !k.startsWith('dungeon')));
    check('stats にプロトタイプ由来のゴミキーが増えない', junkKeys.length === 0, junkKeys.join(','));
  }

  // ---------------------------------------------------------------------
  // mode に原始値へ変換できないオブジェクトを渡しても 500 にならない
  //
  // String(mode) は JSON で作れる値でも投げる: {"toString":1,"valueOf":1}。
  // 素通しだと既定のエラーハンドラが HTML とスタックトレース（サーバー上の
  // 絶対パス入り）を返していた。
  // ---------------------------------------------------------------------
  {
    const v = await j('/api/register', { method: 'POST', body: { username: '変換不能さん', password: 'pass1234' } });
    const r = await j('/api/game/result', { method: 'POST', body: { mode: { toString: 1, valueOf: 1 }, score: 100, duration: 30 } }, v.token);
    check('原始値にできない mode でも 500 にならない', r.status === 200, `status=${r.status}`);
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

  // ---------------------------------------------------------------------
  // 巨大な本文は「読み込む前に」断る
  //
  // /api/admin/restore は認証より前にパーサが走る（＝誰でも到達できる）。
  // ハンドラ内の rateLimit はパース後にしか効かないので歯止めにならず、
  // 12MB×20並列で RSS が 510MB まで伸びた（Render starter は 512MB＝OOM）。
  // Content-Length を見て、本文を読む前に落とすこと。
  // ---------------------------------------------------------------------
  {
    // ⚠ 上限は実装から読む。ここに数値を書き写すと、上限が上がった日に
    // 「上限内の本文」を送ってしまい、2枚目の門（レート制限=429）に当たって
    // 落ちる ── 実際そうなった（4MB→12MB に上がったのにテストは6MBのまま）。
    const srcIndex = fs.readFileSync(path.join(process.cwd(), 'server', 'index.js'), 'utf8');
    const limMatch = srcIndex.match(/const RESTORE_LIMIT_MB = (\d+)/);
    check('復元の上限(RESTORE_LIMIT_MB)を実装から読めた', !!limMatch,
      limMatch ? `${limMatch[1]}MB` : 'RESTORE_LIMIT_MB が見つからない — このテストを実装に合わせて直すこと');
    const limitMb = limMatch ? Number(limMatch[1]) : 12;
    // 上限を確実に超える大きさ（+2MB）。Content-Length で読む前に落ちるので
    // 実際に転送されるわけではない。
    const big = '{"users":{},"pad":"' + 'a'.repeat((limitMb + 2) * 1024 * 1024) + '"}';
    const codes = await Promise.all(Array.from({ length: 6 }, () =>
      fetch(BASE + '/api/admin/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big })
        .then(r => r.status).catch(() => 0)));
    check('上限超えの本文は全部 413 で断られる', codes.every(c => c === 413), `上限${limitMb}MB / ${codes.join(',')}`);
    const alive = await fetch(BASE + '/api/status');
    check('連投してもサーバーは生きている', alive.ok, `status=${alive.status}`);
  }

  // ---------------------------------------------------------------------
  // 💎ジェムラッシュ: 遊ばずに💎を無限に湧かせられない
  //
  // gemDrop はスコアもプレイ実体も見ず、送信1回ごとに固定額を払っていた。
  // 空ボディの連投だけで 750💎/時（課金換算 約¥890/時）が湧いた。
  // ---------------------------------------------------------------------
  {
    const ev = await j('/api/admin/event', { method: 'POST', body: { on: true, type: 'gemrush', minutes: 60 } }, adminTok);
    check('ジェムラッシュを開始できる', ev.status === 200 && ev.event && ev.event.id === 'gemrush', ev.error || '');
    const v = await j('/api/register', { method: 'POST', body: { username: '空撃ちさん', password: 'pass1234' } });
    const before = (await j('/api/me', {}, v.token)).user.gems;
    for (let i = 0; i < 20; i++) await j('/api/game/result', { method: 'POST', body: {} }, v.token);
    const afterEmpty = (await j('/api/me', {}, v.token)).user.gems;
    check('空ボディの連投では💎が1個も湧かない', afterEmpty === before, `${before} -> ${afterEmpty}`);

    const honest = await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 9000, lines: 12, maxCombo: 4, duration: 75 } }, v.token);
    check('正直に遊べば💎ドロップは今までどおり出る', honest.rewards && honest.rewards.eventGems === 3, JSON.stringify(honest.rewards && honest.rewards.eventGems));

    const me = (await j('/api/me', {}, v.token)).user;
    check('1日の受取総額が記録される', !!(me.stats.eventGemDay && me.stats.eventGemDay.got === 3), JSON.stringify(me.stats.eventGemDay));
    await j('/api/admin/event', { method: 'POST', body: { on: false } }, adminTok);
  }

} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
