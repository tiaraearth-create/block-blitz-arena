// リポジトリのルートから:  node test/opplayout.test.mjs
//
// 🪟 相手カードの並びと、⏳「時間が解決する」結果の控え。
//
// ■ ① 16人ルームで相手の盤面が重なっていた
// #oppCards は **flex-wrap の無い1行**で、.opp-panel は max-width 430px。
// ところがカスタムルームは最大16人（＝相手15人）入る。74px×15枚＋隙間で
// 1,306px を 410px に押し込んでいたので、実測で **27組が重なって**いた。
// 折り返しと、枚数に応じた1枚の大きさの両方を入れて直した。
//
// ■ ② 更新するたびに「この回の報酬は付いていません」が出ていた
// 結果の控え（送り直し）は status 0（通信断）のときだけ作られていたのに、
// 送り直しの判定は 0/429/503 を「時間が解決する」として扱っていた。
// つまり**同じ状態なのに1回目だけ捨てる**という食い違い。再デプロイ中は
// /api/result が 503 を返すので、更新のたびに遊んでいた人の1回が消えていた。
//
// ★ このテストの本題は B-1（表を1つにしたこと）と A-3（15人が収まること）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const css = read('public/css/style.css');
const modes = strip(read('public/js/modes.js'));
const net = strip(read('public/js/net.js'));

// ===========================================================================
// A. 相手カードが重ならない
// ===========================================================================
{
  const block = (css.match(/#oppCards \{[^}]*\}/) || [''])[0];
  check('A-1 前提: #oppCards の指定を取り出せた', block.length > 20, block.slice(0, 60));
  check('A-2 ★折り返す（1行に押し込まない）', /flex-wrap:\s*wrap/.test(block), block.replace(/\s+/g, ' '));

  // 実測した値をそのまま使う。ブラウザ無しでは測れないので、
  // 「置ける幅」は実機で測った 408px を定数として持つ（下のコメント参照）。
  const INNER = 408;   // 実測: .opp-panel(max-width 430) の中で #oppCards が使える幅
  const gapM = block.match(/gap:\s*\d+px\s+(\d+)px/);
  check('A-2b 前提: 横の隙間を読めた', !!gapM, block.replace(/\s+/g, ' ').slice(0, 80));
  const gap = gapM ? Number(gapM[1]) : 10;

  // JS 側の段（sizeOppCards）と同じ式をここでも持つ。
  // ⚠ 片方だけ変えると「1行に入るつもりで入らない」に戻るので、
  //   式が変わったらこのテストも一緒に落ちるよう、実装から正規表現で拾う。
  const ladder = modes.match(/const px = n <= (\d+) \? (\d+) : n <= (\d+) \? (\d+) : (\d+);/);
  check('A-2c 前提: 大きさの段を実装から拾えた', !!ladder, ladder ? ladder[0] : '見つからない');
  const pick = n => {
    if (!ladder) return 74;
    return n <= Number(ladder[1]) ? Number(ladder[2])
      : n <= Number(ladder[3]) ? Number(ladder[4]) : Number(ladder[5]);
  };
  const rowsFor = n => {
    const px = pick(n);
    const per = Math.floor((INNER + gap) / (px + gap));
    return per > 0 ? Math.ceil(n / per) : 99;
  };

  // ★本題。16人ルーム満員（相手15人）でも 2行に収まること。
  //   実機の実測とも一致している（15人 → 2行・重なり0）。
  check('A-3 ★15人でも2行に収まる', rowsFor(15) <= 2, `${rowsFor(15)}行 / 1枚 ${pick(15)}px`);
  // ふつうの対戦（1〜5人）を巻き添えにしない。ここが2行になると、
  // 盤面の上を余計に取られて**全員が損をする**。
  const wide = [1, 2, 3, 4, 5, 6, 7, 8].filter(n => rowsFor(n) > 1);
  check('A-4 ★8人までは1行のまま', wide.length === 0,
    wide.map(n => `${n}人=${rowsFor(n)}行`).join(' '));
  const over = [];
  for (let n = 1; n <= 15; n++) if (rowsFor(n) > 2) over.push(`${n}人=${rowsFor(n)}行`);
  check('A-5 どの人数でも3行以上にならない', over.length === 0, over.join(' '));
}
{
  // カードの幅は**盤の大きさ**で決める。ここを開けておくと、幅を決めるのは
  // 点数の文字になる（実測: 盤42px に対しカード45px）。数px広いだけで
  // 1行に入る枚数が減り、15人が2行に収まらなくなる。
  check('A-6 カードの幅を盤の大きさに固定している',
    /#oppCards \.opp-card \{[^}]*width:\s*var\(--opp-cell/.test(css), '');
  check('A-7 大きさを JS から渡している（--opp-cell）',
    /setProperty\('--opp-cell'/.test(modes), '');
}

// ===========================================================================
// B. ★「時間が解決する」結果は控える
// ===========================================================================
{
  check('B-1 ★判定の表が1つにまとまっている（RETRY_LATER）',
    /export const RETRY_LATER = new Set\(\[0, 429, 503\]\)/.test(net), '');
  // 送る前（api）と送り直し（flushResultQueue）が**同じ表**を見ていること。
  // 別々に書いていたので「1回目は捨てるのに2回目以降は取っておく」だった。
  const uses = (net.match(/RETRY_LATER\.has\(/g) || []).length;
  check('B-2 ★送る前と送り直しの両方が同じ表を見る', uses >= 2, `${uses}箇所`);
  check('B-3 503/429 の返事でも控えに入れる',
    /if \(queueOffline && RETRY_LATER\.has\(res\.status\)\) queueOfflineResult/.test(net), '');
  // 昔の書き方が残っていないこと（残っていると片方だけ直った状態になる）。
  check('B-4 古い直書きの判定が残っていない',
    !/err\.status === 0 \|\| err\.status === 429 \|\| err\.status === 503/.test(net), '');
}
{
  // 画面の文言も、控えたかどうかで分ける。
  check('B-5 結果画面も同じ表を見る', /RETRY_LATER\.has\(status\)/.test(modes), '');
  check('B-6 更新中は「更新中」と伝える（圏外と言わない）',
    /サーバーの更新中です/.test(modes), '');
  check('B-7 控えたときは「あとで自動で送る」と言う',
    /自動で送ります/.test(modes), '');
  // 控えられていないのに「あとで送る」と言わないこと（逆の嘘のほうが悪い）。
  check('B-8 実際に控えられたかを確かめてから言う',
    /RETRY_LATER\.has\(status\) && queuedResultCount\(\) > 0/.test(modes), '');
}

// ===========================================================================
// C. 🐉 ボス選択へ戻れる
// ===========================================================================
{
  check('C-1 ボスの結果画面に「ボス選択」がある', /id="rBossList"/.test(modes), '');
  check('C-2 押したらボス一覧を開く',
    /rBossList'\)\.onclick[\s\S]{0,400}?__bbaOpenBossSelect/.test(modes), '');
  // ⚠ ゲーム画面のままボス一覧を開くと、閉じた人が固まった盤面に取り残される
  //   （destroy 済みで ✕→終了も効かない）。「次のボスへ」と同じく先にメニューへ。
  check('C-3 ★先にメニューへ戻してから開く（取り残されない）',
    /rBossList'\)\.onclick[\s\S]{0,300}?endToMenu\(\);[\s\S]{0,200}?__bbaOpenBossSelect/.test(modes), '');
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
