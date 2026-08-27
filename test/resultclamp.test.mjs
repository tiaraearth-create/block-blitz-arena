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
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

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
// index.js の式をそのまま写したもの。式が変わったらここも直す。
const GRACE = graceMin * 60 * 1000;
const RATE = 500;              // 1秒あたりに認めるスコア
const CEILING = 1_000_000;     // スコアの絶対上限

function firstSubmissionCap(accountAgeMs) {
  const last = Math.min(accountAgeMs, GRACE);          // 基準からの経過
  const elapsed = last / 1000 + 90;
  return Math.min(CEILING, Math.floor(elapsed) * RATE);
}

// 作りたて → ほぼ90秒ぶんしか通らない
const fresh = firstSubmissionCap(0);
check('作りたてのアカウントは 90秒ぶんに縛られる',
  fresh <= 50_000, `${fresh.toLocaleString('ja-JP')}点`);

// 「初回だけ上限まで通せる」が起きないこと ── ここが元のバグ
check('どんなアカウント年齢でも絶対上限には届かない',
  firstSubmissionCap(Number.MAX_SAFE_INTEGER) < CEILING,
  `${firstSubmissionCap(Number.MAX_SAFE_INTEGER).toLocaleString('ja-JP')}点`);

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
