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
// サーバーを立てるテストが17本ある。並列にするなら、次の2つが衝突しないことが
// 前提になる。両方とも確認済み:
//   ・ポート … 全17本が test/_port.mjs の freePort() を使い、OS に 0 番を
//     渡して空きを割り当ててもらっている。固定ポートは残っていない。
//   ・保存先 … 全17本が DATA_DIR に os.tmpdir() 配下の**自分専用**の名前を
//     渡している（bba-battle-test / bba-social-test …）。重複は無い。
//     dbsafety は mkdtempSync で毎回別の場所を作り、wsip は割り当てられた
//     ポート由来の名前を使う（起動前と終了後に自分で消す）。
// なので同時に走らせてもデータを踏み合わない。
//
// ただし freePort() は「空きを見つけて閉じてから使う」ので、閉じてから
// サーバーが listen するまでの一瞬に他人が取る可能性はゼロではない。並列度を
// 上げるほどその窓は踏まれやすくなる。また royale / shutdown のように実時間で
// 待つテストがあり、機械が重いと起動待ち（15〜20秒）が間に合わなくなる。
//
// 既定は同時2本。以前の既定（4本）だと social / battle / royale あたりが
// 「fetch failed」だけ残して落ちることがあり、単独で回すと全部通る——という
// 偽の失敗が出ていた。テストが嘘をつくと、本物の失敗まで疑われなくなる。
// CI（.github/workflows/ci.yml）も TEST_JOBS=2 なので、これで手元と揃う。
// 速さが要るときだけ上げる:
//
//   node test/run-all.mjs --jobs 1     … 直列（いちばん安全・いちばん遅い）
//   node test/run-all.mjs --jobs 4     … 速いマシン向け（偽の失敗が出たら下げる）
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
// 上の17本はサーバーを立てない純ロジック（合計でも数秒）。
const TESTS = [
  // いちばん最初に置く。public/js は素のままブラウザへ配られる（ビルド工程が
  // 無い）ので、閉じ括弧1つの欠けで全プレイヤーが起動できなくなる。それを
  // 数百msで止められるのはこれだけなので、他のどれより先に落ちてほしい。
  'syntax.test.mjs',
  'engine.test.mjs',
  'modes-structure.test.mjs',
  'mode-registry.test.mjs',
  // 商品を足したのにアイコン表を更新し忘れる（＝棚に同じ絵が並ぶ）を止める。
  // サーバーも DOM も要らないので、安いほうに置いてある。
  'icons.test.mjs',
  // 遊び方（public/js/rules.js）の数字が、サーバー／engine の式とズレていないか。
  // 一覧に入れ忘れていたので走っていなかった（第1波の統合で発覚）。
  // サーバーも DOM も要らないので、icons と同じ安い組に置く。
  'rules.test.mjs',
  // 段位（帯・24段）の唯一の正解が public/js/ranks.js であること。
  // server に手書きの表が復活していないかをソース検査で見張るので、
  // rules と同じくサーバー不要の安い組に置く。
  'ranks.test.mjs',
  'workshop.test.mjs',
  // 📴 圏外でもアカウントが残って見えること／その控えで管理者になれないこと。
  // サーバーを立てず、localStorage と最小の DOM を用意して dom.js を実際に
  // 動かすだけなので、安い組に置く（offline.test.mjs は本物のサーバーと
  // 本物の sw.js を回すので重い組。見ているものも別: あちらは「起動一式が
  // 控えにあるか」、こちらは「自分の情報の控えと、その権限の扱い」）。
  'offlineauth.test.mjs',
  // 🗄 端末に置く bba_* の一覧と仕分け。手書きの消去リストが腐って
  // 「リセットしたのに前の人の記録が残る」になったので、ソースから機械抽出して
  // 突き合わせる。サーバー不要の安い組。
  'localkeys.test.mjs',
  // 🚪 ログアウト・退会で端末に前の人のデータを残さない。offlineauth と同じ
  // 器（localStorage と最小の DOM）で dom.js を実際に動かすので隣に置く。
  'signout.test.mjs',
  'viewresize.test.mjs',
  'i18n.test.mjs',
  'clientwiring.test.mjs',
  'persist-registry.test.mjs',
  'api-contract.test.mjs',
  'ytexport.test.mjs',
  'clip.test.mjs',
  'resultclamp.test.mjs',
  'zero.test.mjs',
  'zero-session.test.mjs',
  'crowd.test.mjs',
  'ranking-ai.test.mjs',
  // 🌍 世界の辻褄（表示オンライン人数 ↔ ランキングの行数 ↔ にぎわいの札 ↔
  // 発言の速さ）。ranking-ai が「1人ぶんの数字が生きているか」を見るのに対し、
  // こちらは「人数と他の数字が食い違っていないか」を見る。サーバー不要の安い組。
  'worldconsistency.test.mjs',
  // 🏆 「上位100位」がその世界の規模に見合った顔ぶれか。worldconsistency が
  // 「行数」を見るのに対し、こちらは **行の中身** を見る（人数だけ増えて
  // 100位が Lv.1・8,309点、という非対称を作らない）。サーバー不要の安い組。
  'boardquality.test.mjs',
  // 🗒 住人の戦績が「実際に起きたこと」を映すか（人間が勝つと本当に敗が増える）。
  // ranking-ai と表裏なので隣に置く ── あちらは「計算で作る基準値」が生きて
  // いることを、こちらは「その上に乗る実記録」を見る。サーバー不要の安い組。
  'residentrecord.test.mjs',
  'dbsafety.test.mjs',
  // ここから下はサーバーを起動する。
  // 接続上限まわり。サーバーを2つ立てる（プロキシ有り構成／無し構成）ぶん
  // 少し重いので、サーバー組の先頭に置いて早めに結果を出す。
  'wsip.test.mjs',
  'restore-auth.test.mjs',
  'session.test.mjs',
  'rank-rewards.test.mjs',
  'new-modes.test.mjs',
  'persist.test.mjs',
  'gacha.test.mjs',
  'inventory.test.mjs',
  'useredit.test.mjs',
  // 🔓 隠し要素（神／創造神／幽霊屋敷）の解放。誤爆しない合図（純ロジック）＋
  // アカウント保存・端末またぎ・復元の合流をサーバーで通す。復元まで見るので
  // persist / useredit と同じ組に置く。
  'unlocks.test.mjs',
  'security.test.mjs',
  // 🚪 退会・管理者削除の後始末（UGC・報告者名・チャット履歴・接続・墓標）。
  // 「コメントには2本から呼ぶと書いてあるのに1本しか呼んでいない」を機械で
  // 見張る。security と同じ組（サーバーを立て、復元まで通す）。
  'accountpurge.test.mjs',
  // 🤝 ゲスト相手／合言葉ルームの対戦は「練習試合」（勝ち星・連勝・勝利報酬が
  // 付かない）。ゲストは登録が要らない＝ただで作れるので、ここが緩いと
  // 勝ち星と実績を無限に量産できる。巻き添え（ふつうのレート戦が動かなくなる）
  // も同じテストで見張る。
  'guestmatch.test.mjs',
  // 🪪 名乗れる名前の門（登録・改名・ゲスト名で同じ厳しさ）。ゼロ幅スペースや
  // 全角で「運営」「管理者ゼロ」になりすませないこと、その代わりに既存
  // ユーザーのログインを締め出していないこと。
  'nameclaim.test.mjs',
  // 🚫 取り締まりと身元 ── 凍結された回線／ゲスト名の照会上限／殿堂とお知らせに
  // 焼き付いた名前／通報と操作ログのID照合／同じ相手との連戦。どれも
  // 「効きすぎない」ことを同じテストで見張っている（巻き添えが本体より怖い）。
  'moderation.test.mjs',
  // 🔌 切断の猶予（戻れる／戻らなければ従来どおり負ける／別人は席を取れない）。
  // 「敗北とEloの回避」を塞いだ門を再接続の名目で開け直していないかを見るので、
  // security / secrecy と同じ組に置く。実時間で20秒ほどかかる。
  'reconnect.test.mjs',
  // 🕒 在席区間ログ（誰がいつオンラインだったか）。上限が効いていることと、
  // 復元の合流で消えないこと。reconnect と同じ WS の生死まわりなので隣に置く。
  'onlinelog.test.mjs',
  // 📊 管理者のプレイヤー統計（誰がいつオンラインだったか）。見せてよい相手を
  // 間違えると個人の行動履歴の流出になるので、security / secrecy と同じ組に置く
  // ── どれも「返してはいけないものを返していないか」を見るテスト。
  'adminstats.test.mjs',
  // 👀 いま誰がオンラインか（/api/admin/online）。名前つきの現在地そのものなので、
  // 見せてよい相手を間違えたら即流出。adminstats の隣に置く ── あちらが
  // 「いつオンラインだったか（履歴）」を、こちらが「いま誰が居るか」を見る。
  // 実WSで数人つないで対戦が始まるまで待つので、実時間で20秒ほどかかる。
  'adminonline.test.mjs',
  // 「ソロを押してすぐ終了」の連投で稼げないこと＋1日の上限。
  // security と同じく「配ってはいけないものを配っていないか」を見るので隣に置く。
  'farming.test.mjs',
  // 🧾 結果送信の冪等キー（同じ runId を2回送っても1回ぶんしか入らない）と、
  // その上に乗る「オフライン中の記録を後から送る」控え。farming と同じく
  // 「配ってはいけないものを配っていないか」を見るので隣に置く。
  'idempotent.test.mjs',
  // 🎭 住人（AIプレイヤー）の正体が非管理者に漏れていないか。security の隣に
  // 置く ── 見ているものは違うが、どちらも「返してはいけないものを返していないか」。
  'secrecy.test.mjs',
  // 🎭 対戦カードの称号・ギルド・戦績で正体が割れないか。secrecy が「禁止キーが
  // 混ざっていないか」を見るのに対し、こちらは「**欄の揃い方と値の分布**で
  // 選り分けられないか」を統計で見る（使い捨ての対戦相手が住人と同じ分布か）。
  // サーバーを2つ順に立てるので、secrecy と同じ重い組に置く。
  'personaparity.test.mjs',
  'adminevent.test.mjs',
  'throne.test.mjs',
  'social.test.mjs',
  'daily.test.mjs',
  'battle.test.mjs',
  'royale.test.mjs',
  // 👀 観戦の取り決め（watch / watchable）。ロイヤル側をWSで1試合ぶん通すので
  // royale の隣に置く（実時間で30秒ほどかかる）。
  'spectate.test.mjs',
  // 🚪 カスタムルームの定員8人と観戦席。実マッチを1本回すので重い組。
  'room.test.mjs',
  // 🩹 第6波の統合で潰した不具合の回帰。対戦の裁定（終了間際の切断・二重切断・
  // 自分から降りる）とカスタムルームの観戦席を実WSで通すので、reconnect / room と
  // 同じ重い組に置く。翻訳・実績・復元の検査はサーバー無しで同じファイルの後半にある。
  'wave6.test.mjs',
  // 📴 オフラインで遊べるか。本物の sw.js を本物のサーバー相手に走らせて、
  // 控えの中身を数えてから通信を落とす（＝ソース検査では出てこない
  // 「SW は load で登録されるので初回訪問は1本も通らない」を捕まえる）。
  // サーバーを立てるので重い組に置く。
  'offline.test.mjs',
  // 👑 ちゃちゃまる。住人の計算（サーバー不要）に加えて、v2.35 から
  // 「本当に対戦相手として出て、倒すと印が付く」をWSで通しで見るので、
  // 純ロジックの安い組ではなくサーバー組に置いてある。
  'champion.test.mjs',
  'shutdown.test.mjs',
];

// 1本あたりの上限。無限に待つと CI が止まったまま気づけない。
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 300000);

const args = process.argv.slice(2);
const jobsArg = args.indexOf('--jobs');
let JOBS = Number(
  (jobsArg >= 0 && args[jobsArg + 1]) || process.env.TEST_JOBS || 2
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
    // ❌ が1行も無いまま落ちた＝「何が壊れたのか分からない失敗」。
    // 無言で終わったときは、せめて最後に出ていたものを見せる。
    if (!bad.length) {
      const tail = (r.err || r.out).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-8);
      if (tail.length) for (const l of tail) console.log(`       ${l}`);
      else console.log('       （出力はありませんでした）');
    }
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
