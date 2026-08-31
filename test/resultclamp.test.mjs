// リポジトリのルートから:  node test/resultclamp.test.mjs
// 結果送信の「時間の頭押さえ」の回帰テスト。
//
// ここは2つの失敗のあいだの細い道を通す必要がある:
//   ・緩すぎる → 新規アカウントが1リクエストでスコア上限まで通せる
//     （実際に起きた。初回だけ3600秒の猶予を与えていて、3600×500=180万点 が
//       絶対上限100万点を上回るため、頭押さえが一度も発動しなかった）
//   ・厳しすぎる → 「初めての1回が長かった人」のスコアを切り詰める
//     （初回を一律300秒にしていたときがこれ。150,000点で頭打ち）
//
// 通した道: 初回の基準を「アカウントが存在している時間（最大30分）」にする。
// 誰も自分のアカウントより長くは遊べないので偽装できず、
// かつ長い初回プレイを不当に切り詰めない。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// index.js だけを読んでいたが、ルート定義が server/routes/ に分割されたので
// 「結果送信まわりのサーバー実装」はもう1ファイルには収まっていない。
// 読む範囲は広げるだけ ── どの検査も「ある／無い」を見ているので、
// 対象が増えても甘くならない（`: 300;` の不在確認はむしろ厳しくなる）。
const routesDir = path.join(__dirname, '..', 'server', 'routes');
const src = [
  fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8'),
  ...(fs.existsSync(routesDir) ? fs.readdirSync(routesDir).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(routesDir, f), 'utf8')) : []),
].join('\n');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---------------------------------------------------------------------------
// 1. 実装がソースに入っているか
// ---------------------------------------------------------------------------
check('初回の基準を入れる関数がある', /function seedLastResultAt\(user\)/.test(src), '');
check('基準はアカウントの年齢から作る', /now - \(Number\.isFinite\(user\.createdAt\)/.test(src), '');
check('その持ち時間には上限がある', /FIRST_RESULT_GRACE_MS/.test(src), '');
check('一律300秒の分岐が残っていない', !/: 300;/.test(src), '');
const both = (src.match(/seedLastResultAt\(/g) || []).length;
check('通常の結果と管理者イベントの両方で使っている', both >= 3, `${both}か所`);

// 上限の値が現実的か。長すぎると初回1回だけ上限まで通せてしまう。
const graceMatch = src.match(/FIRST_RESULT_GRACE_MS = (\d+) \* 60 \* 1000/);
const graceMin = graceMatch ? Number(graceMatch[1]) : 0;
check('持ち時間の上限が 10〜60分に収まっている', graceMin >= 10 && graceMin <= 60, `${graceMin}分`);

// ---------------------------------------------------------------------------
// 2. 数字としての性質
// ---------------------------------------------------------------------------
// ⚠ 定数は「写経しない」。ここに数値を書き写すと、実装だけが変わったときに
// テストは古い数値で計算し続けて緑のままになる ── 実際それが起きていた
// （RATE を 500 と書き写したまま実装が 2000 になり、「初回で絶対上限に
// 届かない」という守るはずの性質が破れているのに検出できなかった）。
// 必ず実装から読み取り、読めなければテストを落とす。
const GRACE = graceMin * 60 * 1000;

// rateCap は mode ごとの三項演算子。既定値（末尾の : NNNN）が最も緩いので
// 「絶対上限に届かないか」はこれで検算する。
const rateMatch = src.match(/const rateCap = mode === 'sprint'[^;]*?:\s*(\d+);/);
check('1秒あたりの上限(rateCap)を実装から読めた', !!rateMatch, rateMatch ? `既定 ${rateMatch[1]}/秒` : 'rateCap の式が変わった — このテストを実装に合わせて直すこと');
const RATE = rateMatch ? Number(rateMatch[1]) : NaN;

const ceilMatch = src.match(/score = Math\.min\(score, (\d[\d_]*)\)|SCORE_CEILING = (\d[\d_]*)/);
const CEILING = ceilMatch ? Number(String(ceilMatch[1] || ceilMatch[2]).replace(/_/g, '')) : 1_000_000;

function firstSubmissionCap(accountAgeMs) {
  const last = Math.min(accountAgeMs, GRACE);          // 基準からの経過
  const elapsed = last / 1000 + 90;
  return Math.min(CEILING, Math.floor(elapsed) * RATE);
}

// ⚠ この検査が守るのは「レートの絶対値」ではなく **壁時計に縛られること**。
// rateCap（1秒あたり）は v2.14 で 500→2000 に意図して引き上げられた ──
// 奥義（メテオ+100,000・神の裁き・オーバードライブ×3）を使った本気のプレイが
// 切り詰められ「自己ベストを更新したのにランキングが動かない」が起きたため。
// なので「初回で絶対上限に届かない」はもう成り立たない（30分×2000で到達する）。
// 偽装を防いでいるのは rateCap ではなく、その上の
//   duration ≤ (前回の提出からの実経過 + 90秒)
// という壁時計クランプのほう。時間を大きく申告しても実時間より速くは稼げない。
// ここではその「時間に比例して伸び、時間を飛ばせない」性質だけを検算する。

// 作りたて → 90秒ぶん（+猶予）しか通らない。実時間が経っていないので短い。
const fresh = firstSubmissionCap(0);
const freshSecs = 90;
check('作りたてのアカウントは 90秒ぶんに縛られる',
  fresh <= freshSecs * RATE, `${fresh.toLocaleString('ja-JP')}点（= ${freshSecs}秒 × ${RATE}/秒）`);

// アカウントが古くても「持ち時間」は GRACE で頭打ち＝無限には緩まない。
const forever = firstSubmissionCap(Number.MAX_SAFE_INTEGER);
const graceCap = Math.min(CEILING, Math.floor(GRACE / 1000 + 90) * RATE);
check('どれだけ古いアカウントでも持ち時間は上限で止まる',
  forever === graceCap, `${forever.toLocaleString('ja-JP')}点（持ち時間の上限 ${graceMin}分ぶん）`);

// 10分遊んだ人の初回が、一律300秒のときより広いこと
const oldCap = 300 * RATE;                       // 直す前の一律300秒
const tenMin = firstSubmissionCap(10 * 60 * 1000);
check('10分遊んだ初回が、以前より切り詰められない',
  tenMin > oldCap, `${oldCap.toLocaleString('ja-JP')} → ${tenMin.toLocaleString('ja-JP')}点`);

// 年齢が増えるほど緩む（ただし単調で、上限で止まる）
let monotonic = true, capped = false;
let prev = -1;
for (let min = 0; min <= 90; min += 5) {
  const v = firstSubmissionCap(min * 60 * 1000);
  if (v < prev) monotonic = false;
  if (min > graceMin && v !== firstSubmissionCap(graceMin * 60 * 1000)) capped = false;
  prev = v;
}
capped = firstSubmissionCap(90 * 60 * 1000) === firstSubmissionCap(graceMin * 60 * 1000);
check('アカウントが古いほど緩むが、逆転はしない', monotonic, '');
check('上限を超えたぶんは頭打ちになる', capped,
  `${graceMin}分以上は ${firstSubmissionCap(GRACE).toLocaleString('ja-JP')}点で一定`);

// ---------------------------------------------------------------------------
// 3. CSP — WebSocket の行き先を自分のホストだけに絞る
// ---------------------------------------------------------------------------
const cspAt = src.indexOf("'Content-Security-Policy'");
const csp = cspAt >= 0 ? src.slice(Math.max(0, cspAt - 900), cspAt + 1600) : '';
check('connect-src がスキーマ全体(ws:/wss:)を許していない',
  !/connect-src[^"`]*[^/]ws:\s/.test(csp) && !csp.includes("'self' ws: wss:"), '');
check('接続先をこのページのホストに限っている', /ws:\/\/\$\{wsHost\}/.test(csp), '');
check('Host ヘッダーをそのまま差し込まない（形を検査している）',
  /test\(rawHost\)/.test(csp), '');

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
