// リポジトリのルートから:  npm test   （＝ node test/run-all.mjs）
//
// test/*.test.mjs をまとめて走らせる。
//
// もともと package.json の test は全部を `&&` でつないだ一本の長い行だった。
// 直列なので遅いうえ、途中で1本落ちるとそこで止まり、**残りが通るのかどうかが
// 分からない**。1つ直して回し直すと次が落ちる、を繰り返すことになる。
// ここでは全部を最後まで走らせて、落ちたものをまとめて出す。
//
// ■ 並列にしてよいのか（重要）
// サーバーを立てるテストが16本ある。並列にするなら、次の2つが衝突しないことが
// 前提になる。両方とも確認済み:
//   ・ポート … 全16本が test/_port.mjs の freePort() を使い、OS に 0 番を
//     渡して空きを割り当ててもらっている。固定ポートは残っていない。
//   ・保存先 … 全16本が DATA_DIR に os.tmpdir() 配下の**自分専用**の名前を
//     渡している（bba-battle-test / bba-social-test …）。重複は無い。
//     dbsafety だけは mkdtempSync で毎回別の場所を作る。
// なので同時に走らせてもデータを踏み合わない。
//
// ただし freePort() は「空きを見つけて閉じてから使う」ので、閉じてから
// サーバーが listen するまでの一瞬に他人が取る可能性はゼロではない。並列度を
// 上げるほどその窓は踏まれやすくなる。また royale / shutdown のように実時間で
// 待つテストがあり、機械が重いと起動待ち（15〜20秒）が間に合わなくなる。
// 4本までなら実測で問題なかったが、疑わしいときは直列に落とせるようにしてある:
//
//   node test/run-all.mjs --jobs 1     … 直列（昔と同じ挙動）
//   node test/run-all.mjs --jobs 2     … 控えめ
//   TEST_JOBS=1 npm test               … 環境変数でも同じ
//
// 出力は「走らせた順」ではなく「1本ぶんをまとめて」出す。並列の出力を
// 混ぜると誰の ❌ なのか分からなくなるため、終わったものから塊で流す。

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 速い順。直列で回すときに、安いテストから落ちてくれたほうが早く気づける。
// 上の10本はサーバーを立てない純ロジック（合計でも数秒）。
const TESTS = [
  'engine.test.mjs',
  'viewresize.test.mjs',
  'i18n.test.mjs',
  'clientwiring.test.mjs',
  'ytexport.test.mjs',
  'resultclamp.test.mjs',
  'zero.test.mjs',
  'zero-session.test.mjs',
  'crowd.test.mjs',
  'ranking-ai.test.mjs',
  'dbsafety.test.mjs',
  // ここから下はサーバーを起動する。
  'restore-auth.test.mjs',
  'session.test.mjs',
  'rank-rewards.test.mjs',
  'new-modes.test.mjs',
  'persist.test.mjs',
  'gacha.test.mjs',
  'inventory.test.mjs',
  'useredit.test.mjs',
  'security.test.mjs',
  'adminevent.test.mjs',
  'throne.test.mjs',
  'social.test.mjs',
  'daily.test.mjs',
  'battle.test.mjs',
  'royale.test.mjs',
  'shutdown.test.mjs',
];

// 1本あたりの上限。無限に待つと CI が止まったまま気づけない。
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 300000);

const args = process.argv.slice(2);
const jobsArg = args.indexOf('--jobs');
let JOBS = Number(
  (jobsArg >= 0 && args[jobsArg + 1]) || process.env.TEST_JOBS || 4
);
if (!Number.isFinite(JOBS) || JOBS < 1) JOBS = 1;
JOBS = Math.min(JOBS, TESTS.length);

// 走らせる前に、並べたファイルが実在するか見る。名前を打ち間違えたまま
// 「26本中25本成功」と出るのがいちばん困る（見えないところが増えていく）。
const missing = TESTS.filter(f => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) {
  console.error(`❌ 一覧にあるのに見つからないテストがあります: ${missing.join(', ')}`);
  console.error('   test/run-all.mjs の TESTS を直してください。');
  process.exit(1);
}
// 逆に、置いてあるのに一覧に無いものも知らせる（黙って走らないほうが怖い）。
const listed = new Set(TESTS);
const onDisk = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.mjs'));
const unlisted = onDisk.filter(f => !listed.has(f));

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const secs = ms => `${(ms / 1000).toFixed(1)}s`;

// Windows では kill() が子（テストが起動したサーバー）まで届かない。
// 時間切れで諦めるときくらいは、道連れにしておく。
function hardKill(proc) {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
      return;
    } catch { /* taskkill が無ければ下の kill にまかせる */ }
  }
  try { proc.kill('SIGKILL'); } catch { /* もう死んでいる */ }
}

function runOne(file) {
  return new Promise(resolve => {
    const t0 = nowMs();
    const proc = spawn(process.execPath, [path.join('test', file)], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let timedOut = false;
    // 明示的に utf8 で受ける。Buffer のまま足していくと、日本語が
    // チャンクの切れ目でちょうど分断されたときに文字化けする
    // （✅ の行が読めなくなって、何が落ちたのか分からなくなる）。
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { timedOut = true; hardKill(proc); }, TIMEOUT_MS);
    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({
        file, out, err, timedOut,
        ms: nowMs() - t0,
        ok: !timedOut && code === 0,
        why: timedOut ? `時間切れ（${secs(TIMEOUT_MS)}）`
          : code === 0 ? '' : `終了コード ${code}${signal ? ` / ${signal}` : ''}`,
      });
    };
    proc.on('error', e => finish(-1, String(e && e.message)));
    proc.on('close', finish);
  });
}

function report(r, index, total) {
  const head = r.ok ? '✅' : '❌';
  console.log('');
  console.log(`${head} ${r.file}  (${secs(r.ms)})  [${index}/${total}]`);
  const body = (r.out + (r.err ? (r.out ? '\n' : '') + r.err : '')).replace(/\s+$/, '');
  if (body) console.log(body.split('\n').map(l => `   ${l}`).join('\n'));
  if (!r.ok) console.log(`   ── ${r.why}`);
}

async function main() {
  console.log(`[test] ${TESTS.length}本を同時${JOBS}本で実行します（node ${process.version} / ${os.platform()}）`);
  if (JOBS === 1) console.log('[test] 直列モードです。');
  if (unlisted.length) {
    console.log(`[test] ⚠ 一覧に入っていないテストがあります（走りません）: ${unlisted.join(', ')}`);
  }

  const t0 = nowMs();
  const done = [];
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= TESTS.length) return;
      const r = await runOne(TESTS[i]);
      done.push(r);
      report(r, done.length, TESTS.length);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));

  const failed = done.filter(r => !r.ok);
  const total = nowMs() - t0;

  console.log('');
  console.log('─'.repeat(60));
  if (!failed.length) {
    console.log(`✅ 全 ${TESTS.length} 本が成功しました（${secs(total)}）`);
    return;
  }
  console.log(`❌ ${failed.length} / ${TESTS.length} 本が失敗しました（${secs(total)}）`);
  console.log('');
  for (const r of failed) {
    console.log(`  ❌ ${r.file} — ${r.why}`);
    // 失敗した行だけ抜き出して添える。上のログを遡らなくても原因に当たれる。
    const bad = (r.out + '\n' + r.err).split('\n').filter(l => l.includes('❌')).slice(0, 8);
    for (const l of bad) console.log(`       ${l.trim()}`);
  }
  console.log('');
  console.log('  1本だけ回すには:  node test/<ファイル名>');
  if (JOBS > 1) {
    console.log('  同時実行が原因かもしれないときは:  node test/run-all.mjs --jobs 1');
  }
  process.exitCode = 1;
}

main().catch(err => {
  console.error('[test] ランナー自体が落ちました:', (err && err.stack) || err);
  process.exit(1);
});
