// リポジトリのルートから:  node test/shelftruth.test.mjs
//
// 🛒 棚・持ち物・順位表の「数え方と言い方」の回帰テスト（監査の残り）。
//
//   A. 持ち物の「あとN種」に、ショップでは買えないガチャ限定が混ざっていた
//   B. 運営のショップ「アイテム」タブだけ所持数が実数（実際は消費されない＝無限）
//   C. 持ち物・図鑑を開いたままガチャを回すと、閉じても表示が引く前のまま
//   D. 圏外の「◯位に入るには X 以上」が、ちょうど X のときに矛盾していた
//   E. 戦績の「平均スコア」が「ハイスコア」を超える（物差しが違う数を並べていた）
//   F. 合言葉ルームの試合は rated:false なのに「離脱＝敗北」と脅していた
//   G. 🎭 順位報酬の「/ N人中」が**実プレイヤーの人数**そのものだった
//      （100行あるランキングの残りが何なのか割れてしまう）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const stripComments = src => src.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const screens = stripComments(read('public/js/screens.js'));
const modes = stripComments(read('public/js/modes.js'));
const index = stripComments(read('server/index.js'));
const shop = stripComments(read('server/routes/shop.js'));

// ===========================================================================
// A. 持ち物の「あとN種」
// ===========================================================================
check('A-1 買える品の判定が1か所にまとまっている',
  /const buyable = i => !i\.adminOnly && !i\.throneOnly && !i\.gachaOnly;/.test(screens), '');
check('A-2 分母がそれを使う', /const total = all\.filter\(buyable\)\.length;/.test(screens), '');
check('A-3 「あとN種」もそれを使う', /const missing = total - owned\.filter\(buyable\)\.length;/.test(screens), '');
check('A-4 見出しの分子も同じ物差し',
  /\$\{owned\.filter\(buyable\)\.length\} \/ \$\{total\}/.test(screens), '');
check('A-5 ガチャ限定の品が実在する（前提の確認）',
  /gachaOnly: true/.test(stripComments(read('server/catalog.js'))), '');

// ===========================================================================
// B. 運営のショップ棚の所持数
// ===========================================================================
check('B-1 サーバーは管理者のブースターを減らさない（前提の確認）',
  /if \(user\.role !== 'admin'\)/.test(shop), '');
check('B-2 棚の所持数も運営なら ∞',
  /×\$\{staffItem \|\| invIsStaff\(\) \? '∞' : fmt\(count\)\}/.test(screens), '');

// ===========================================================================
// C. ガチャのあとに持ち物を描き直す
// ===========================================================================
check('C-1 ガチャを回したら、開いている持ち物を描き直す',
  /setBars\(data\.pity, data\.collection\);[\s\S]{0,260}?if \(document\.body\.dataset\.screen === 'inventory'\) openInventory\(\);/.test(screens), '');

// ===========================================================================
// D. 圏外の説明
// ===========================================================================
check('D-1 「以上」ではなく「超える」',
  /位に入るには \$\{lbValueText\(board, cutoff\)\} を超える/.test(screens)
  && !/位に入るには \$\{lbValueText\(board, cutoff\)\} 以上/.test(screens), '');
check('D-2 ちょうど同点のときは専用の文にする',
  /const tied = full && mine === cutoff && mine > 0;/.test(screens)
  && /同じ点は名前順/.test(screens), '');
check('D-3 サーバーが同点を名前順で割っている（前提の確認）',
  /\(a\.username < b\.username \? -1 : a\.username > b\.username \? 1 : 0\)/.test(index), '');

// ===========================================================================
// E. 戦績の物差し
// ===========================================================================
check('E-1 ハイスコアが順位対象だけなのは変えていない（前提の確認）',
  /const scoreboardEligible = mode !== 'meltdown'/.test(index), '');
check('E-2 タイルのラベルで物差しの違いを言う',
  /ハイスコア（順位対象）/.test(screens) && /平均スコア（全モード）/.test(screens)
  && /累計スコア（全モード）/.test(screens), '');

// ===========================================================================
// F. 合言葉ルームの離脱
// ===========================================================================
check('F-1 サーバーはルームの試合を rated:false で作る（前提の確認）',
  /rated: false[\s\S]{0,200}?roomCode/.test(stripComments(read('server/battle.js')))
  || /roomCode[\s\S]{0,200}?rated: false/.test(stripComments(read('server/battle.js'))), '');
check('F-2 ✕ の警告がルーム戦を分けている',
  /if \(this\.kind === 'custom'\) \{[\s\S]{0,220}?ルームの試合は<b>練習試合<\/b>/.test(modes), '');
check('F-3 離脱のトーストも分けている',
  /wasCustomRoom[\s\S]{0,200}?ルームの試合から離脱しました/.test(modes), '');
check('F-4 その印は destroy() より前に控えている',
  /const wasCustomRoom = this\.kind === 'custom' && !this\.isCoop && !this\.isRoyale;/.test(modes)
  && modes.indexOf('const wasCustomRoom =') < modes.indexOf('this.destroy();\n      toast(wasSpectating'), '');
check('F-5 離脱のトーストを赤くしない（何も失っていない）',
  /\(this\.spectatingRoom \|\| wasCustomRoom \|\| \(this\.isRoyale && this\.royaleDead\)\) \? '' : 'err'/.test(modes), '');
check('F-6 「戻らなければあなたの勝ちです」もルーム戦では出さない',
  /this\.kind === 'custom'[\s\S]{0,200}?ルームの試合なので勝敗は記録されません/.test(modes), '');

// ===========================================================================
// G. 順位報酬の母数（住人の秘匿）
// ===========================================================================
check('G-1 サーバーが of を本人に渡していない',
  /rankRewards: \(user\.rankRewards \|\| \[\]\)\.map\(\(\{ of, \.\.\.r \}\) => r\),/.test(index), '');
check('G-2 画面も「/ N人中」を出さない',
  !/\$\{r\.of\}\$\{tr\('人中'/.test(screens), '');
check('G-3 順位そのものは今までどおり出す',
  /\$\{tr\(`\$\{r\.rank\}位`, `#\$\{r\.rank\}`\)\}/.test(screens), '');
// 運営の目には残す（db.json と管理画面）。
check('G-4 記録側には of を残している（運営の目は塞がない）',
  /rank, of: players\.length,/.test(index) && /rank: t\.rank, of: realEntrants/.test(index), '');
{
  // 実際に剥がれるか（出荷される式をそのまま通す）。
  const m = read('server/index.js').replace(/\r\n/g, '\n')
    .match(/rankRewards: \(user\.rankRewards \|\| \[\]\)\.map\(\(\{ of, \.\.\.r \}\) => r\),/);
  check('G-5 剥がす式を取り出せる', !!m, '');
  if (m) {
    // eslint-disable-next-line no-new-func
    const run = new Function('user', `return { ${m[0]} };`);
    const out = run({ rankRewards: [{ id: 'x', rank: 3, of: 13, coins: 0, gems: 200 }] });
    check('G-6 of だけが落ちて、他は残る',
      out.rankRewards[0].of === undefined
      && out.rankRewards[0].rank === 3 && out.rankRewards[0].gems === 200,
      JSON.stringify(out.rankRewards[0]));
  }
}

for (const [mark, name, detail] of results) console.log(mark, name, detail ? `— ${detail}` : '');
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
