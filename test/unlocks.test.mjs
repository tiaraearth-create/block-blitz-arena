// リポジトリのルートから:  node test/unlocks.test.mjs
//
// 🔓 隠し要素（神 / 創造神 / 幽霊屋敷）の解放まわり。
//
// 見るのは4つ:
//   【A】誤爆しないこと ── 幽霊屋敷の「ロゴ13連打」で 神・創造神 が開かない。
//        これはユーザー本人の懸念そのもの（「同時に開放されるのが一番やばい」）。
//        実装の合図判定（public/js/main.js の matchPadSecret）を**そのまま
//        取り出して**動かし、連打の列を片っ端から流し込んで一度も開かないことを見る。
//   【B】配線が食い違っていないこと ── 解放 id の一覧がサーバーとクライアントで
//        同じか、13連打の口から神の解放へ手が伸びていないか（静的検査）。
//   【C】アカウントに残ること ── 端末を変えても（＝同じユーザーの新しい
//        セッションでも）解放が付いてくる。引き継ぎは1回だけ。
//   【D】復元で消えないこと ── 進行度で負けたコピーが持っていた解放も、
//        merge 復元のあとに残っている。
//
// ⚠ このテストが守っている一番の落とし穴:
//   server/sanitize.js の SECRET_KEYS には **'ghost' が入っている**（住人の
//   正体を隠す関門）。だから解放を { ghost:true } のようなオブジェクトで持つと、
//   非管理者へ返す JSON から幽霊屋敷の解放だけが黙って消える。実装は文字列の
//   配列 ['kami','souzou','ghost'] にしてあり、C-6 がそれを見張っている。

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

// ポート固定をやめた理由は test/_port.mjs を参照。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
// 保存先にポートを混ぜる（run-all が同時に2つ走っても踏み合わない）。
const DIR = path.join(os.tmpdir(), `bba-unlocks-test-${PORT}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 空ボディ */ }
  return { status: r.status, ...d };
};

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ===========================================================================
// 下ごしらえ: 実装から合図の判定を取り出す（写経しない）
// ===========================================================================
//
// 定数を書き写すと、実装だけ変わったときにテストが嘘をつく。main.js は
// ブラウザ用のモジュールで node からは import できない（起動と同時に DOM を
// 触る）ので、**純粋な部分だけ**を切り出して動かす。

// 文字列とコメントを飛ばしながら括弧の対応を数える（persist-registry と同じ手）。
function balancedFrom(source, startIdx, open, close) {
  let depth = 0, inStr = null, inCmt = null;
  for (let i = startIdx; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (inCmt) { if (inCmt === '//' && c === '\n') inCmt = null; else if (inCmt === '/*' && c === '*' && n === '/') { inCmt = null; i++; } continue; }
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inCmt = '//'; i++; continue; }
    if (c === '/' && n === '*') { inCmt = '/*'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return source.slice(startIdx, i + 1); }
  }
  return null;
}

const MAIN = read('public/js/main.js');

function cutConst(name) {
  const at = MAIN.search(new RegExp(`const\\s+${name}\\s*=\\s*\\[`));
  if (at < 0) return null;
  const arr = balancedFrom(MAIN, MAIN.indexOf('[', at), '[', ']');
  return arr ? `const ${name} = ${arr};` : null;
}
function cutFunction(name) {
  const at = MAIN.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const body = balancedFrom(MAIN, MAIN.indexOf('{', MAIN.indexOf(')', at)), '{', '}');
  if (!body) return null;
  const head = MAIN.slice(at, MAIN.indexOf('{', MAIN.indexOf(')', at)));
  return head + body;
}

const srcKami = cutConst('PAD_KAMI');
const srcSouzou = cutConst('PAD_SOUZOU');
const srcMatch = cutFunction('matchPadSecret');
check('A-0 main.js から合図の判定を取り出せた', !!(srcKami && srcSouzou && srcMatch),
  `PAD_KAMI=${!!srcKami} PAD_SOUZOU=${!!srcSouzou} matchPadSecret=${!!srcMatch}`);

let PAD_KAMI = [], PAD_SOUZOU = [], matchPadSecret = () => null;
if (srcKami && srcSouzou && srcMatch) {
  // eslint-disable-next-line no-new-func
  const mod = new Function(`${srcKami}\n${srcSouzou}\n${srcMatch}\nreturn { PAD_KAMI, PAD_SOUZOU, matchPadSecret };`)();
  ({ PAD_KAMI, PAD_SOUZOU, matchPadSecret } = mod);
}

// ===========================================================================
// 【A】誤爆しない ── 連打では絶対に開かない
// ===========================================================================
{
  check('A-1 正しい並びで 神 が開く', matchPadSecret(PAD_KAMI) === 'kami', String(matchPadSecret(PAD_KAMI)));
  check('A-2 正しい並びで 創造神 が開く', matchPadSecret(PAD_SOUZOU) === 'souzou', String(matchPadSecret(PAD_SOUZOU)));
  check('A-3 神の並びは 創造神 を開かない', matchPadSecret(PAD_KAMI) !== 'souzou');

  // 途中まででは開かない（打ち間違えた人が偶然開かない）。
  const prefixOk = PAD_KAMI.slice(0, -1).every((_, i) => matchPadSecret(PAD_KAMI.slice(0, i + 1)) === null);
  check('A-4 神の並びの途中では開かない', prefixOk);
  const midOk = PAD_SOUZOU.slice(PAD_KAMI.length, -1)
    .every((_, i) => matchPadSecret(PAD_SOUZOU.slice(0, PAD_KAMI.length + i + 1)) !== 'souzou');
  check('A-5 創造神の並びの途中では創造神が開かない', midOk);

  // ── ここが本題。「連打」は同じものを何度も叩くこと。
  // 幽霊屋敷の13連打（ロゴ）はパッドですらないので 'logo' として流し込む。
  const TOKENS = ['up', 'down', 'left', 'right', 'orb', 'logo'];
  let repeatHit = null;
  for (const tk of TOKENS) {
    for (let n = 1; n <= 40; n++) {
      if (matchPadSecret(Array(n).fill(tk)) !== null) { repeatHit = `${tk}×${n}`; break; }
    }
    if (repeatHit) break;
  }
  check('A-6 同じものを1〜40回連打しても開かない（13連打を含む）', repeatHit === null, repeatHit || '6種×40回すべて null');

  // ロゴ13連打そのもの（幽霊屋敷が開く瞬間の列）を明示的にもう一度。
  check('A-7 ロゴ13連打で 神・創造神 が開かない', matchPadSecret(Array(13).fill('logo')) === null);
  // 13連打の前後に何が付いていても同じ（連打の途中でパッドに触れた場合）。
  const around = [...Array(13).fill('logo'), 'orb', ...Array(13).fill('logo')];
  check('A-8 13連打にパッドの1手が混ざっても開かない', matchPadSecret(around) === null);

  // 2種類の交互打ちも総当たりで潰す（長さ12まで＝4,096通り×15組）。
  let altHit = null;
  for (let a = 0; a < TOKENS.length && !altHit; a++) {
    for (let b = a + 1; b < TOKENS.length && !altHit; b++) {
      for (let bits = 0; bits < (1 << 12); bits++) {
        const seq = [];
        for (let i = 0; i < 12; i++) seq.push((bits >> i) & 1 ? TOKENS[b] : TOKENS[a]);
        if (matchPadSecret(seq) !== null) { altHit = `${TOKENS[a]}/${TOKENS[b]} ${seq.join(',')}`; break; }
      }
    }
  }
  check('A-9 2種類だけを使う列は総当たりでも開かない', altHit === null, altHit || '15組×4,096通り');

  // 決定的な乱打（種を固定した擬似乱数）。偶然に開くことがないかを量で見る。
  let seed = 20260902;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let fuzzHits = 0;
  for (let i = 0; i < 200000; i++) {
    const len = 1 + Math.floor(rnd() * 22);
    const seq = [];
    for (let k = 0; k < len; k++) seq.push(TOKENS[Math.floor(rnd() * TOKENS.length)]);
    if (matchPadSecret(seq) !== null) fuzzHits++;
  }
  check('A-10 乱打20万回で一度も開かない', fuzzHits === 0, `当たり ${fuzzHits} 件`);

  // 合図が5種類すべてを使うこと。1〜2種類しか使わない合図だと、上の
  // 総当たりが「たまたま通っている」だけになる（＝この検査群が弱くなる）。
  check('A-11 合図が5方向すべてを使っている', new Set(PAD_KAMI).size === 5, [...new Set(PAD_KAMI)].join(','));
}

// ===========================================================================
// 【B】配線の静的検査
// ===========================================================================
{
  // B-1. 13連打の口から、神・創造神の解放へ手が伸びていないこと。
  const clickAt = MAIN.indexOf("logoEl.addEventListener('click'");
  const clickBody = clickAt >= 0 ? balancedFrom(MAIN, MAIN.indexOf('{', MAIN.indexOf('=>', clickAt)), '{', '}') : null;
  check('B-1a ロゴのクリック処理を切り出せた', !!clickBody && clickBody.length > 80, clickBody ? `${clickBody.length}文字` : '見つからない');
  if (clickBody) {
    const leaks = ['unlockKami', 'unlockSouzou', 'openSigilPad'].filter(n => new RegExp(`\\b${n}\\s*\\(`).test(clickBody));
    check('B-1b ロゴ連打から 神・創造神 へ手が伸びていない', leaks.length === 0,
      leaks.length ? `${leaks.join(', ')} を呼んでいる` : '呼ぶのは unlockGhost だけ');
    check('B-1c 幽霊屋敷は13回のまま', /ghostTaps\s*===\s*13/.test(clickBody), '既存プレイヤーの体験を変えない');
  }

  // B-2. 紋のパッドは「長押し」からしか開かない。
  // click / dblclick から開けられるようになっていたら、それは連打と混ざる道。
  // 定義（function openSigilPad() {…}）は数えない。呼び出しだけを数える。
  const opens = [...MAIN.matchAll(/(?<!function\s)\bopenSigilPad\s*\(\s*\)/g)].length;
  check('B-2a openSigilPad を呼ぶ箇所が1つだけ', opens === 1, `${opens}箇所`);
  const downAt = MAIN.indexOf("logoEl.addEventListener('pointerdown'");
  const downBody = downAt >= 0 ? balancedFrom(MAIN, MAIN.indexOf('{', MAIN.indexOf('=>', downAt)), '{', '}') : null;
  check('B-2b 長押しの検出（pointerdown + setTimeout）から開いている',
    !!downBody && /setTimeout\(/.test(downBody) && /openSigilPad\s*\(\s*\)/.test(downBody),
    downBody ? '' : 'pointerdown の処理が見つからない');
  check('B-2c 長押しの成立で連打カウンタを捨てている',
    !!downBody && /ghostTaps\s*=\s*0/.test(downBody) && /suppressLogoClick\s*=\s*true/.test(downBody),
    '長押し1回が13連打の1歩に化けないこと');

  // B-3. 解放 id の一覧が、サーバーとクライアントで食い違っていないこと。
  // ここがズレると「サーバーは覚えているのに端末に映らない」解放ができる。
  const SERVER = read('server/index.js');
  const NET = read('public/js/net.js');
  const sIds = (SERVER.match(/const UNLOCK_IDS = \[([^\]]*)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const cIds = [...((NET.match(/UNLOCK_LS_KEYS = \{([^}]*)\}/) || [, ''])[1])
    .matchAll(/(\w+)\s*:/g)].map(m => m[1]);
  check('B-3a サーバーの UNLOCK_IDS を読み取れた', sIds.length >= 3, sIds.join(','));
  check('B-3b クライアントの対応表と一覧が一致する',
    sIds.length === cIds.length && sIds.every(id => cIds.includes(id)),
    `server=[${sIds}] client=[${cIds}]`);
  // 対応表の localStorage キーが、既存の読み手（modes.js / screens.js）と同じ綴りか。
  const MODES = read('public/js/modes.js');
  check('B-3c 幽霊屋敷の判定が同じ localStorage キーを見ている',
    /bba_ghost/.test(NET) && /localStorage\.getItem\('bba_ghost'\)/.test(MODES), '');

  // B-4. 復元の合流に載っているか（載せ忘れると復元のたびに解放が消える）。
  const BACKUP = read('server/backup.js');
  check('B-4 backup.js が stats.unlocks を合流させている',
    /stats\s*&&\s*loser\.stats\.unlocks/.test(BACKUP) || /loser\.stats\.unlocks/.test(BACKUP),
    'mergeEarned に無いと、進行度で負けたコピーの解放が消える');
  check('B-5 引き継ぎの止め金も合流させている', /unlockImportedAt/.test(BACKUP), '');
}

// ===========================================================================
// 【C】【D】サーバー側 ── 保存・引き継ぎ・復元
// ===========================================================================

let proc = null;
async function start(extraEnv = {}) {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'unlocks-test-secret-key', SEED_RESTORE: '0', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})\n${log}`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return log; } catch { /* まだ */ }
  }
  throw new Error('server did not start:\n' + log);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  if (p.exitCode !== null || p.signalCode !== null) { await sleep(300); return; }
  await new Promise(res => {
    const done = () => { clearTimeout(timer); res(); };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* もう死んでいる */ } done(); }, 5000);
    p.once('exit', done);
    p.kill();
  });
  await sleep(300);
}
const adminPw = () => fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
const play = (token, n = 1) => Promise.all(Array.from({ length: n }, (_, i) =>
  j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 5000 + i, lines: 10, maxCombo: 3, duration: 90 } }, token)));

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // ---- C-1. 隠しコマンドの申告がアカウントに残る --------------------------
  const reg = await j('/api/register', { method: 'POST', body: { username: 'ゆうしゃ', password: 'pass1234' } });
  check('C-0 登録できた', reg.status === 200 && !!reg.token, JSON.stringify(reg.error || ''));
  const tok1 = reg.token;
  check('C-1a 新規アカウントの解放は空', Array.isArray(reg.user.stats.unlocks) && reg.user.stats.unlocks.length === 0,
    JSON.stringify(reg.user.stats.unlocks));

  const cl = await j('/api/me/unlocks', { method: 'POST', body: { unlocks: ['kami'], from: 'hidden' } }, tok1);
  check('C-1b 隠しコマンドの申告が通る', cl.status === 200 && cl.added.includes('kami') && cl.unlocks.includes('kami'),
    JSON.stringify({ status: cl.status, added: cl.added, unlocks: cl.unlocks }));

  // 一覧に無い id は黙って捨てる（配列を好きに伸ばされない）。
  const junk = await j('/api/me/unlocks', { method: 'POST', body: { unlocks: ['admin', 'kami', 'ghost', 'x'.repeat(300)], from: 'hidden' } }, tok1);
  check('C-2 一覧に無い解放 id は捨てられる',
    junk.status === 200 && junk.unlocks.every(id => ['kami', 'souzou', 'ghost'].includes(id)) && junk.unlocks.includes('ghost'),
    JSON.stringify(junk.unlocks));

  // ---- C-3. 別の端末（同じユーザーの新しいセッション）に付いてくる --------
  const login2 = await j('/api/login', { method: 'POST', body: { username: 'ゆうしゃ', password: 'pass1234' } });
  const tok2 = login2.token;
  check('C-3a 別セッションのトークンが取れた', login2.status === 200 && !!tok2 && tok2 !== tok1);
  const me2 = await j('/api/me', {}, tok2);
  check('C-3b 端末を変えても解放が付いてくる',
    me2.status === 200 && me2.user.stats.unlocks.includes('kami') && me2.user.stats.unlocks.includes('ghost'),
    JSON.stringify(me2.user && me2.user.stats.unlocks));

  // ---- C-4. localStorage からの引き継ぎは1回だけ -------------------------
  const imp1 = await j('/api/me/unlocks', { method: 'POST', body: { unlocks: ['souzou'], from: 'local' } }, tok2);
  check('C-4a 引き継ぎ1回目は通る', imp1.status === 200 && imp1.unlocks.includes('souzou'), JSON.stringify(imp1.added));
  const imp2 = await j('/api/me/unlocks', { method: 'POST', body: { unlocks: ['souzou'], from: 'local' } }, tok2);
  check('C-4b 引き継ぎ2回目は 409 で断られる', imp2.status === 409, `status=${imp2.status}`);
  const meImp = await j('/api/me', {}, tok2);
  check('C-4c 引き継ぎ済みの印がアカウントに残る', !!meImp.user.stats.unlockImportedAt, String(meImp.user.stats.unlockImportedAt));

  // ---- C-5. 申告のレート上限（隠しコマンドは検証できないぶんの歯止め） ----
  const spam = [];
  for (let i = 0; i < 6; i++) {
    spam.push((await j('/api/me/unlocks', { method: 'POST', body: { unlocks: ['kami'], from: 'hidden' } }, tok2)).status);
  }
  check('C-5 隠しコマンドの申告に上限がある（429 が出る）', spam.includes(429), spam.join(','));

  // ---- C-6. 住人の関門で 'ghost' が削られていないこと ---------------------
  // sanitize.js の SECRET_KEYS には 'ghost' が入っている。解放をオブジェクトの
  // キーで持つと、ここで幽霊屋敷だけが消える（管理者では再現しない）。
  const meGhost = await j('/api/me', {}, tok2);
  check('C-6 非管理者の応答でも ghost の解放が消えない',
    meGhost.user.stats.unlocks.includes('ghost'), JSON.stringify(meGhost.user.stats.unlocks));

  // ---- C-7. 実力で開く（サーバーが自分で判定する道） ---------------------
  const reg2 = await j('/api/register', { method: 'POST', body: { username: 'みならい', password: 'pass1234' } });
  const tokN = reg2.token;
  const oni = await j('/api/game/result', { method: 'POST', body: { mode: 'ai_oni', score: 9000, lines: 20, maxCombo: 5, duration: 120, won: true } }, tokN);
  check('C-7a 鬼に勝つと 神 が現れる',
    oni.status === 200 && (oni.rewards.unlocked || []).includes('kami') && oni.user.stats.unlocks.includes('kami'),
    JSON.stringify({ unlocked: oni.rewards && oni.rewards.unlocked, unlocks: oni.user && oni.user.stats.unlocks }));
  const kami = await j('/api/game/result', { method: 'POST', body: { mode: 'ai_kami', score: 9100, lines: 20, maxCombo: 5, duration: 120, won: true } }, tokN);
  check('C-7b 神に勝つと 創造神 が現れる',
    kami.status === 200 && (kami.rewards.unlocked || []).includes('souzou') && kami.user.stats.unlocks.includes('souzou'),
    JSON.stringify(kami.rewards && kami.rewards.unlocked));
  const again = await j('/api/game/result', { method: 'POST', body: { mode: 'ai_oni', score: 9200, lines: 20, maxCombo: 5, duration: 120, won: true } }, tokN);
  check('C-7c 2回目の勝利では「新しく開いた」と言わない',
    again.status === 200 && (again.rewards.unlocked || []).length === 0, JSON.stringify(again.rewards && again.rewards.unlocked));
  check('C-7d 負けでは開かない（鬼に負けた新規は空のまま）',
    !(await j('/api/game/result', { method: 'POST', body: { mode: 'ai_oni', score: 100, lines: 1, maxCombo: 1, duration: 60, won: false } },
      (await j('/api/register', { method: 'POST', body: { username: 'かけだし', password: 'pass1234' } })).token)).user.stats.unlocks.length);

  // ---- D. 復元（backup）で解放が消えない ---------------------------------
  // いちばん危ない形を作る: **バックアップ側にだけ解放があり、生きている側の
  // ほうが進行度で勝つ**。合流を書き忘れていると、勝った側の記録がそのまま
  // 残って解放だけ落ちる。
  await play(tok2, 1);
  const backup = await j('/api/admin/backup', {}, (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw() } })).token);
  check('D-0 バックアップを取得できた', !!backup.users && Object.keys(backup.users).length >= 3, String(Object.keys(backup.users || {}).length));
  const fileUser = Object.values(backup.users).find(u => u.username === 'ゆうしゃ');
  check('D-1 バックアップに解放が入っている',
    !!fileUser && Array.isArray(fileUser.stats.unlocks) && fileUser.stats.unlocks.includes('ghost'),
    JSON.stringify(fileUser && fileUser.stats.unlocks));

  await stop();
  fs.rmSync(path.join(DIR, 'db.json'), { force: true });
  fs.rmSync(path.join(DIR, 'snapshots'), { recursive: true, force: true });
  await start();

  // ディスクが飛んだあと、同じ名前で登録し直して**より多く遊んだ**人。
  const again2 = await j('/api/register', { method: 'POST', body: { username: 'ゆうしゃ', password: 'newpass1234' } });
  check('D-2 復元前の再登録ができた', again2.status === 200, JSON.stringify(again2.error || ''));
  await play(again2.token, 4);
  const before = await j('/api/me', {}, again2.token);
  check('D-3 再登録したほうは解放を持っていない', before.user.stats.unlocks.length === 0, JSON.stringify(before.user.stats.unlocks));

  const rs = await j('/api/admin/restore', { method: 'POST', body: { data: backup, mode: 'merge', password: adminPw() } });
  check('D-4 merge 復元が通った', rs.status === 200, JSON.stringify(rs.error || rs.report || rs));

  const after = await j('/api/me', {}, again2.token);
  check('D-5 進行度で勝った側にも解放が合流している',
    after.status === 200 && after.user.stats.unlocks.includes('kami') && after.user.stats.unlocks.includes('ghost') && after.user.stats.unlocks.includes('souzou'),
    JSON.stringify(after.user && after.user.stats.unlocks));
  check('D-6 引き継ぎ済みの印も残っている（復元で二度目が通らない）',
    !!after.user.stats.unlockImportedAt, String(after.user.stats.unlockImportedAt));
  check('D-7 合流しても一覧に無い id は増えていない',
    after.user.stats.unlocks.every(id => ['kami', 'souzou', 'ghost'].includes(id)) && after.user.stats.unlocks.length <= 3,
    JSON.stringify(after.user.stats.unlocks));
} catch (err) {
  check('テストが最後まで走った', false, String((err && err.stack) || err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${failed === 0 ? '✅' : '❌'} unlocks: ${results.length - failed} 件成功 / ${failed} 件失敗`);
