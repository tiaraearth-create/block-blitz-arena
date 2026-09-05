// リポジトリのルートから:  node test/awaken.test.mjs
//
// 💤 「作り終えているのに触れない」機能を起こしたぶんの回帰。
//
// カオス（12種のお題・11枚の盤面が完成しているのにイベント中しか押せない）、
// 王座の宝物庫（イベントが無い日は欠片の残高すら見られない）、
// 👻幽霊屋敷（ロゴ13連打を知らない人には存在しないのと同じ）、
// そして記録はサーバーに保存されているのに板が1枚も無かった9モード。
//
// どれも新規実装より一桁安いのに、放っておくと「無い機能」と同じ扱いになる。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const idx = read('server/index.js');
const ambient = read('server/ambient.js');
const screens = read('public/js/screens.js');
const main = read('public/js/main.js');
const html = read('public/index.html');
const css = read('public/css/style.css');
const i18n = read('public/js/i18n.js');
const crowd = read('server/crowd.js');

// ===========================================================================
// ① カオスは常時遊べる
// ===========================================================================
{
  check('①-1 ボタンが既定で隠れていない',
    /<button class="btn btn-chaos btn-big" id="btnChaos">/.test(html), '');
  check('①-2 押したときにイベントを条件にしない',
    !/カオスモードはイベント開催中のみ遊べます/.test(main), '');
  check('①-3 イベントの有無でボタンを隠さない',
    !/btn\.classList\.toggle\('hidden', !chaosLive/.test(main), '');
  check('①-4 イベント中だけ「実入りが良い」印を付ける',
    /btn\.classList\.toggle\('event-live', ev\.type === 'chaos'\);/.test(main), '');
  check('①-5 印の見た目がある', /\.btn\.event-live::after \{/.test(css), '');
  check('①-6 イベントが終わったら印を外す',
    /btn\.classList\.remove\('hidden', 'staff-only', 'event-live'\);/.test(main), '');
}

// ===========================================================================
// ② 王座の宝物庫は、イベントが無い日も開ける
// ===========================================================================
{
  check('②-1 ショップにタブがある', /data-shop="throne"/.test(html), '');
  check('②-2 タブの描画がある', /async function renderThroneTab\(\) \{/.test(screens), '');
  check('②-3 renderShop が振り分ける', /if \(shopTab === 'throne'\) \{ renderThroneTab\(\); return; \}/.test(screens), '');
  check('②-4 欠片の残高を出す', /tr\('王座の欠片', 'Throne Shards'\)/.test(screens), '');
  check('②-5 到達段も出す', /世界が第\$\{data\.throneMax \|\| 0\}段まで割れています/.test(screens), '');
  check('②-6 別タブへ移っていたら塗り替えない',
    /if \(shopTab !== 'throne' \|\| document\.body\.dataset\.screen !== 'shop'\) return;/.test(screens), '');
  // サーバー側の口がイベントに依存していないこと（依存していたら、画面を
  // 足しても「イベントが無い日は開けない」が残る）。
  const shopSrv = read('server/routes/shop.js');
  const i = shopSrv.indexOf("throneShopRouter.get('/api/throne/shop'");
  const body = i < 0 ? '' : shopSrv.slice(i, i + 900);
  check('②-7 /api/throne/shop がイベントを見ていない',
    body.length > 100 && !/adminEvent|liveSlot|currentOccurrence/.test(body), `${body.length}文字`);
}

// ===========================================================================
// ③ 👻幽霊屋敷 ── 秘密は残したまま、見つかる道を作る
// ===========================================================================
{
  check('③-1 13連打はそのまま残っている', /if \(ghostTaps === 13\) \{ ghostTaps = 0; unlockGhost\(\); \}/.test(main), '');
  check('③-2 遊んだ人にだけロゴが合図する', /function updateLogoHint\(\) \{/.test(main), '');
  check('③-3 30回遊ぶまでは出さない', /played >= 30 && !ghostUnlocked\(\)/.test(main), '');
  check('③-4 解放したら合図を消す', /unlockHere\('ghost'\); updateLogoHint\(\);/.test(main), '');
  check('③-5 合図の見た目がある', /\.logo\.has-secret \.logo-block \{ animation: logoBreathe/.test(css), '');
  check('③-6 動きを嫌う設定では出さない',
    /@media \(prefers-reduced-motion: reduce\) \{\n  \.logo\.has-secret \.logo-block \{ animation: none; \}/.test(css), '');
  // 世界の側からも噂が流れること。英語プールが1本しか無く、英語で遊ぶ人には
  // 噂そのものが届いていなかった。
  const sec = crowd.slice(crowd.indexOf('  secret: {'), crowd.indexOf('  question: {'));
  check('③-7 噂がロゴを指している', /ロゴ/.test(sec) && /logo/.test(sec), '');
  check('③-8 英語の噂も増えた', (sec.match(/'[^']*'/g) || []).filter(x => /^'[ -~]+'$/.test(x)).length >= 4,
    `英文 ${(sec.match(/'[ -~]+'/g) || []).length}本`);
  check('③-9 答え（13回）は言わない', !/13/.test(sec), '');
}

// ===========================================================================
// ④ 板の無かったモードに板を立てる
//
// ⚠ この機能で怖いのは「板は出るのに全員0点で並ぶ」と
//   「その板だけ実プレイヤーしか並ばない」の2つ。後者は、他の板が住人で
//   埋まっているので対比で一目で分かり、**正体判定器**になる。
//   だから4か所（LB_BOARDS / BOARD_VALUE / ghostRows の行 / GHOST_COUNT）が
//   そろっていることを機械で確かめる。
// ===========================================================================
{
  const NEW = ['meltdown', 'chimera', 'chain', 'survival', 'rush', 'blueprint', 'under', 'heaven', 'abyss'];

  // サーバー: 部門の表
  const lb = idx.slice(idx.indexOf('const LB_BOARDS = {'), idx.indexOf('};', idx.indexOf('const LB_BOARDS = {')));
  check('④-0(前提) 部門の表を読めた', lb.length > 200, `${lb.length}文字`);
  for (const b of NEW) check(`④-1 LB_BOARDS に ${b} がある`, new RegExp(`\\b${b}:\\s*\\{`).test(lb), '');

  // 三項の鎖が残っていないこと（部門を足すたびに4か所そろえる形に戻さない）
  check('④-2 値を引く道が1本になっている', /const lbVal = r => Number\(r\[lbKey\]\) \|\| 0;/.test(idx), '');
  check('④-3 並べ替えも同じ道を使う', /\.sort\(\(a, b\) => lbVal\(b\) - lbVal\(a\)\)/.test(idx), '');
  check('④-4 filter も1本になっている',
    /if \(board !== 'score' && board !== 'rating'\) users = users\.filter\(u => valueOf\(u\) > 0\);/.test(idx), '');

  // 住人側の3か所
  const bv = ambient.slice(ambient.indexOf('const BOARD_VALUE = {'), ambient.indexOf('};', ambient.indexOf('const BOARD_VALUE = {')));
  for (const b of NEW) check(`④-5 BOARD_VALUE に ${b} がある`, new RegExp(`\\b${b}:\\s*\\(st\\)`).test(bv), '');
  const gc = ambient.slice(ambient.indexOf('const GHOST_COUNT = {'), ambient.indexOf('};', ambient.indexOf('const GHOST_COUNT = {')));
  for (const b of NEW) check(`④-6 GHOST_COUNT に ${b} がある`, new RegExp(`\\b${b}: \\d+`).test(gc), '');
  const rowOf = ambient.slice(ambient.indexOf('const rowOf = (name, st, r) => ({'), ambient.indexOf('});', ambient.indexOf('const rowOf = (name, st, r) => ({')));
  check('④-7 住人の行が BOARD_VALUE と同じ式から出ている',
    (rowOf.match(/BOARD_VALUE\.\w+\(st, r\)/g) || []).length === NEW.length,
    `${(rowOf.match(/BOARD_VALUE\.\w+\(st, r\)/g) || []).length}件`);

  // 実プレイヤーの行にも欄があること
  // ⛓️ chain は chainMax（最大連鎖数）。chainBest はスコアで別物 ── 取り違えると
  //    「5000連鎖」の板ができる（実際に一度作った）。
  for (const key of ['meltdownBest', 'chimeraBest', 'chainMax', 'survivalWave', 'rushDepth', 'blueprintClears', 'underMax', 'heavenMax']) {
    check(`④-8 実プレイヤーの行に ${key} がある`,
      new RegExp(`${key}: u\\.stats\\.${key} \\|\\| 0,`).test(idx), '');
  }

  // クライアント側
  const key = screens.slice(screens.indexOf('const LB_KEY = {'), screens.indexOf('};', screens.indexOf('const LB_KEY = {')));
  for (const b of NEW) check(`④-9 画面の対応表に ${b} がある`, new RegExp(`${b}: '`).test(key), '');
  for (const b of NEW) check(`④-10 タブがある: ${b}`, new RegExp(`data-lb="${b}"`).test(html), '');
  for (const b of NEW) check(`④-11 英語のタブ名がある: ${b}`, new RegExp(`\\[data-lb="${b}"\\]`).test(i18n), '');
  check('④-12 単位のある部門は単位を出す',
    /if \(board === 'under'\) return `B\$\{fmt\(v\)\}`;/.test(screens)
    && /if \(board === 'chain'\) return tr\(/.test(screens), '');

  // 🔒 秘匿: 👻幽霊屋敷は公開の板に出さない（部門があること自体が答えになる）
  check('④-13 幽霊屋敷の板は作っていない',
    !/ghost:\s*\{/.test(lb) && !/data-lb="ghost"/.test(html), '');
  check('④-14 その理由がコードに書いてある', /隠しモードなので/.test(idx), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n💤 眠っていた完成品  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
