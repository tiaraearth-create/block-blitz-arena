// リポジトリのルートから:  node test/econguard.test.mjs
//
// 🪙 「遊ばずに通貨が湧く」経路の回帰テスト。
//
// farming.test.mjs が 🪙/XP の連投を、idempotent.test.mjs が二重加算を見張って
// いるが、その2つの門をすり抜けていた蛇口が2本あった。
//
//   A. 👁️王座の欠片 … applyGameResult の中で**唯一そのまま通貨を鋳造する**行なのに、
//      realPlay の門も日次上限も無かった。スコア0・ライン0・duration 1 の
//      「遊んだ形跡ゼロ」の結果に pieces:24 を添えるだけで24個入り、
//      コインとXPは idleResult が0にするので稼ぎの日次上限にも当たらず
//      痕跡すら残らない。結果送信の上限（250件/時）いっぱいで毎時6,000個、
//      👑王座の宝物庫（7品・計2,420欠片）を25分で買い切れた。
//
//   B. 申告テレメトリ … ults 200 / items 200 / pieces 20000 という
//      1リクエストあたりの頭押さえが、実プレイの物理から2桁ずれていた。
//      これらは実績→💎（課金通貨）の原資になる累積カウンタなので、
//      「テレメトリだけを連投して最上位実績に到達する」が通っていた。
//      💎ドロップには日次120の上限があるのに、実績経由はそこを迂回する。
//
// ここで見るもの
//   A-1..A-4 空の結果で欠片が湧かない／正直なプレイでは入る／1日の上限で止まる
//   B-1..B-4 奥義・アイテム・設置数・コンボが経過時間（と消したライン）に紐づく
//   C-1..C-3 住人の板の値が人間の絶対上限より内側（＝1位を人間が取れる）
//   D-1..D-2 同点のときの順位が決まっている（登録順にならない）
//   E-1..E-3 上限に当たった理由が「待てば戻る」と「明日また入る」で分かれる
//   F-1..F-2 工房の1日1勝の止め金が復元の合流に入っている
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort, waitForServer } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-econguard-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      SESSION_SECRET: 'econguard-test', SEED_RESTORE: '0',
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

let seq = 0;
const reg = async () => {
  const r = await j('/api/register', { method: 'POST', body: { username: `けいざい${++seq}`, password: 'pw-econguard-1' } });
  if (!r.token) throw new Error(`登録できません: ${JSON.stringify(r)}`);
  return r.token;
};
const shardsOf = async tok => ((await j('/api/me', {}, tok)).user || {}).shards || 0;

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // -------------------------------------------------------------------------
  // A. 👁️王座の欠片
  // -------------------------------------------------------------------------
  // 「遊んだ形跡ゼロ」＋ 眼だけ満額。旧実装ではこれで24個入った。
  const tokEmpty = await reg();
  const EMPTY = { mode: 'solo', score: 0, lines: 0, duration: 1, pieces: 24, eyes: 12 };
  let emptyGot = 0;
  for (let i = 0; i < 5; i++) {
    const r = await j('/api/game/result', { method: 'POST', body: EMPTY }, tokEmpty);
    if (r.status === 200) emptyGot += (r.rewards && r.rewards.shards) || 0;
  }
  const emptyWallet = await shardsOf(tokEmpty);
  check('A-1 空の結果では欠片が1粒も入らない', emptyGot === 0 && emptyWallet === 0,
    `返り値 ${emptyGot} / 所持 ${emptyWallet}`);

  // 正直なプレイでは入る（塞ぎすぎていないこと。両側に失敗がある）。
  const tokReal = await reg();
  const REAL = { mode: 'solo', score: 24000, lines: 30, duration: 120, pieces: 160, eyes: 6 };
  const r1 = await j('/api/game/result', { method: 'POST', body: REAL }, tokReal);
  const got1 = (r1.rewards && r1.rewards.shards) || 0;
  check('A-2 正直なプレイではちゃんと入る', got1 > 0, `+${got1}`);
  check('A-3 入った数が眼の数と釣り合っている', got1 === 6 * 2, `${got1}（眼6個 × 2）`);

  // 1日の上限で止まる。
  let total = got1;
  for (let i = 0; i < 6; i++) {
    const r = await j('/api/game/result', { method: 'POST', body: REAL }, tokReal);
    if (r.status === 200) total += (r.rewards && r.rewards.shards) || 0;
  }
  const wallet = await shardsOf(tokReal);
  check('A-4 1日の上限で止まる（無限に湧かない）', wallet <= 60 && wallet === total,
    `所持 ${wallet} / 返り値の合計 ${total}`);
  check('A-5 上限は「よく遊んだ1日」より上にある（正直な人を削らない）', wallet >= 24, `所持 ${wallet}`);

  // -------------------------------------------------------------------------
  // B. 申告テレメトリが経過時間に紐づく
  // -------------------------------------------------------------------------
  const tokTel = await reg();
  // duration は「前回の結果送信からの経過＋90秒」までしか名乗れないので、
  // ここでは 30 秒を申告する（アカウント作成直後なので通る）。
  const before = (await j('/api/me', {}, tokTel)).user.stats;
  const forged = await j('/api/game/result', { method: 'POST', body: {
    mode: 'solo', score: 30000, lines: 12, duration: 30,
    ults: 200, items: 200, pieces: 20000, maxCombo: 200, perfectClears: 5,
  } }, tokTel);
  check('B-0 申告そのものは通る（黙って弾かない）', forged.status === 200, String(forged.status));
  const after = (await j('/api/me', {}, tokTel)).user.stats;
  const d = k => (after[k] || 0) - (before[k] || 0);
  check('B-1 奥義の回数が経過時間に紐づく', d('ultsUsed') <= 10, `+${d('ultsUsed')}（30秒の申告）`);
  check('B-2 アイテムの回数が経過時間に紐づく', d('itemsUsed') <= 10, `+${d('itemsUsed')}`);
  check('B-3 設置数が経過時間に紐づく', d('piecesPlaced') <= 200, `+${d('piecesPlaced')}（20000を申告）`);
  check('B-4 コンボは消したライン数を超えない', (after.maxCombo || 0) <= 12,
    `maxCombo=${after.maxCombo}（lines=12 を申告）`);
  // 正直なプレイぶんは削られていない。
  const tokOk = await reg();
  const okRes = await j('/api/game/result', { method: 'POST', body: {
    mode: 'solo', score: 40000, lines: 40, duration: 180, ults: 3, items: 2, pieces: 220, maxCombo: 9,
  } }, tokOk);
  const okStats = (await j('/api/me', {}, tokOk)).user.stats;
  check('B-5 正直な申告は1つも削られない',
    okRes.status === 200 && okStats.ultsUsed === 3 && okStats.itemsUsed === 2
    && okStats.piecesPlaced === 220 && okStats.maxCombo === 9,
    JSON.stringify({ u: okStats.ultsUsed, i: okStats.itemsUsed, p: okStats.piecesPlaced, c: okStats.maxCombo }));

  // -------------------------------------------------------------------------
  // C. 住人の板の値が人間の絶対上限より内側
  // -------------------------------------------------------------------------
  const ambient = await import('../server/ambient.js');
  ambient.setLiveScale ? ambient.setLiveScale(1) : null;
  // 絶対上限は server/index.js のソースから読み取る（書き写さない）。
  const idx = read('server/index.js');
  const capM = idx.match(/score = Math\.max\(0, Math\.min\((\d[\d_]*), Math\.floor/);
  const HUMAN_MAX = capM ? Number(capM[1].replace(/_/g, '')) : 1000000;
  check('C-0 人間の絶対上限を実装から読み取れた', HUMAN_MAX > 0, String(HUMAN_MAX));
  const over = [];
  for (const board of ['score', 'meltdown', 'chimera', 'weekly', 'sprint']) {
    const rows = ambient.ghostRows(board, 'w1', new Set());
    const key = { score: 'bestScore', meltdown: 'meltdownBest', chimera: 'chimeraBest', weekly: 'weeklyBest', sprint: 'sprintBest' }[board];
    for (const r of rows) if ((r[key] || 0) >= HUMAN_MAX) over.push(`${board}/${r.username}=${r[key]}`);
  }
  check('C-1 住人の板の値が人間の絶対上限に届かない（1位を人間が取れる）',
    over.length === 0, over.slice(0, 3).join(' '));
  const melt = ambient.ghostRows('meltdown', 'w1', new Set());
  check('C-2 メルトダウン板が空になっていない（塞ぎすぎていない）', melt.length >= 5, `${melt.length}行`);
  const top = Math.max(0, ...melt.map(r => r.meltdownBest || 0));
  check('C-3 それでも板の上位は十分に高い', top > HUMAN_MAX * 0.5, `最高 ${top}`);

  // -------------------------------------------------------------------------
  // D. 同点のときの順位が決まっている
  // -------------------------------------------------------------------------
  check('D-1 並べ替えに第2キーがある', /\|\| \(a\.username < b\.username \? -1 : a\.username > b\.username \? 1 : 0\)/.test(idx), '');
  // 同点を2人作って、2回引いても同じ順で返ることを見る。
  const tA = await reg(); const tB = await reg();
  const SAME = { mode: 'solo', score: 5000, lines: 10, duration: 60, pieces: 60 };
  await j('/api/game/result', { method: 'POST', body: SAME }, tA);
  await j('/api/game/result', { method: 'POST', body: SAME }, tB);
  const ord1 = ((await j('/api/leaderboard?board=score')).rows || []).map(r => r.username).join(',');
  const ord2 = ((await j('/api/leaderboard?board=score')).rows || []).map(r => r.username).join(',');
  check('D-2 同点でも順位が毎回同じ', ord1 === ord2 && ord1.length > 0, ord1.slice(0, 60));

  // -------------------------------------------------------------------------
  // E. 上限に当たった理由
  // -------------------------------------------------------------------------
  const modesSrc = read('public/js/modes.js');
  check('E-1 「1時間の上限」と「今日ぶん受け取り済み」を分けている',
    /workshopCapped = 'workshop'/.test(idx) && /workshopCapped = 'workshop_day'/.test(idx), '');
  check('E-2 遺跡・設計図も理由を返す',
    /workshopCapped = 'puzzle_day'/.test(idx) && /workshopCapped = 'blueprint_day'/.test(idx), '');
  check('E-3 画面が理由ごとに文言を出し分ける',
    /function cappedRow\(kind\)/.test(modesSrc)
    && ['workshop', 'workshop_day', 'puzzle_day', 'blueprint_day'].every(k => modesSrc.includes(`kind === '${k}'`)), '');
  check('E-4 「時間をおくと戻ります」を、戻らない場合に出していない',
    /kind === 'workshop_day'[\s\S]{0,240}明日また入ります/.test(modesSrc), '');

  // -------------------------------------------------------------------------
  // F. 復元の合流（工房の1日1勝の止め金）
  // -------------------------------------------------------------------------
  const backup = read('server/backup.js');
  check('F-1 wsWinDay が復元の合流に入っている', /wsWinDay/.test(backup), '');
  check('F-2 合流の作法が puzWinDay と同じ（同じ日は和集合・新しい日を採る）',
    /wsWinDay = \{ day: String\(lww\.day\), codes: \[\.\.\.new Set\(lcodes\)\]/.test(backup)
    && /www\.codes = \[\.\.\.new Set\(\[\.\.\.cur, \.\.\.lcodes\]\)\]/.test(backup), '');

  // -------------------------------------------------------------------------
  // G. 圏外の控え（期限切れが消えず警告が鳴り続ける）
  // -------------------------------------------------------------------------
  const net = read('public/js/net.js');
  check('G-1 期限切れを落としたら書き戻す', /writeResultQueue\(kept\); noteResultsDropped\(dropped, 'expired'\)/.test(net), '');
  check('G-2 連打よけの刻印が早期returnより前にある',
    /lastResultFlushAt = Date\.now\(\);\n  if \(!readResultQueue\(\)\.some/.test(net), '');

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🪙 遊ばずに湧く経路\n');
for (const [m, n, dd] of results) console.log(`${m} ${n}${dd ? `  (${dd})` : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
