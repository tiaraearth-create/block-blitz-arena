// リポジトリのルートから:  node test/clientwiring.test.mjs
// 画面側が「読み込んだ瞬間に落ちる」類の事故を止める。
//
// この手のミスは構文としては正しいので node --check を通り抜ける。
// そして main.js は上から下へ一直線に配線しているので、途中で1回投げると
// **それ以降のボタンが全部無反応になる**。実際に起きた:
//   ・$$('[data-back]') が $('[data-back]') になり（querySelector は
//     配列ではないので .forEach で例外）、以降の #btnQuit も端末の戻るも
//     まるごと死んだ
// 画面を出さずに拾える形だけでも見張っておく。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const CLIENT = ['main.js', 'modes.js', 'screens.js', 'dom.js', 'chat.js', 'party.js', 'friends.js', 'adminevent.js', 'i18n.js', 'game.js', 'skills.js', 'themes.js', 'particles.js'];

// --- 1. $ と $$ の取り違え ---
// $ は querySelector（1個）、$$ は querySelectorAll（配列）。
// $(...) に .forEach / .map / .length を使ったら、ほぼ確実に間違い。
for (const f of CLIENT) {
  const src = read(`public/js/${f}`);
  const bad = [...src.matchAll(/(?<![$\w])\$\([^)]*\)\.(forEach|map|filter)\b/g)].map(m => m[0]);
  check(`${f}: $() を配列として使っていない`, bad.length === 0, bad.slice(0, 3).join(' / '));
}

// --- 2. import したものを実際に使っているか（名前の取りこぼし） ---
// import から名前が落ちると ReferenceError で同じ死に方をする。
for (const f of CLIENT) {
  const src = read(`public/js/${f}`);
  const used = new Set();
  // 使っている識別子をざっくり集める
  for (const m of src.matchAll(/(?<![$\w.])([$A-Za-z_][$\w]*)\s*\(/g)) used.add(m[1]);
  const missing = [];
  for (const imp of src.matchAll(/^import \{([^}]*)\} from '\.\/([\w-]+)\.js';/gm)) {
    const names = imp[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean);
    for (const n of names) {
      if (!used.has(n) && !new RegExp(`(?<![$\\w.])${n.replace(/\$/g, '\\$')}(?![$\\w])`).test(src.replace(imp[0], ''))) {
        missing.push(n);
      }
    }
  }
  // 使われていない import は「消し忘れ」で無害。ここで見たいのは逆
  // （使っているのに import していない）なので、そちらだけを見る。
  check(`${f}: import の消し忘れが多すぎない`, missing.length <= 6, missing.join(', '));
}

// --- 3. 使っているのに import していない ---
//
// この検査はソースに正規表現を当てるので、**コメントに書かれた関数名**まで
// 「呼び出し」に見えてしまう。実際に一度これで赤くなった:
//   modes.js の「確実に止めたいときは dom.js の cancelCountdowns() を呼んでもよい」
// という説明文が、import 忘れとして報告された。
// コメントに関数名を（括弧つきで）書けないのは不便だし、書けないルールを
// 人は守れない。丸ごとコメントの行だけ落としてから見る。
//
// 行の途中の // は落とさない ── 文字列の中の "https://" を壊すし、
// 行の途中に関数呼び出しとコメントが同居していれば呼び出しは本物だから。
function stripCommentLines(src) {
  return src.split('\n')
    .map(line => {
      const s = line.trim();
      return (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) ? '' : line;
    })
    .join('\n');
}

const EXPORTS = {};
for (const f of CLIENT) {
  const src = read(`public/js/${f}`);
  EXPORTS[f.replace('.js', '')] = new Set(
    [...src.matchAll(/^export (?:async )?function ([$\w]+)|^export (?:const|let) ([$\w]+)/gm)]
      .map(m => m[1] || m[2]));
}
for (const f of CLIENT) {
  const src = read(`public/js/${f}`);
  const imported = new Set();
  for (const imp of src.matchAll(/^import \{([^}]*)\} from/gm)) {
    for (const n of imp[1].split(',')) imported.add(n.trim().split(/\s+as\s+/).pop());
  }
  const declared = new Set([
    ...[...src.matchAll(/(?:function|const|let|var|class)\s+([$\w]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/^\s*([$\w]+)\s*\(/gm)].map(m => m[1]),
  ]);
  // dom.js が出している名前を、他のファイルが import せずに呼んでいないか
  const domNames = EXPORTS.dom || new Set();
  const orphans = [];
  const code = stripCommentLines(src);   // 説明文の中の関数名を拾わない
  for (const n of domNames) {
    if (f === 'dom.js') continue;
    if (imported.has(n) || declared.has(n)) continue;
    if (new RegExp(`(?<![$\\w.])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(code)) orphans.push(n);
  }
  check(`${f}: dom.js の関数を import せずに呼んでいない`, orphans.length === 0, orphans.join(', '));
}

// --- 4. 端末の戻る（Android でアプリごと閉じないこと） ---
const dom = read('public/js/dom.js');
const main = read('public/js/main.js');
check('showScreen が履歴を積んでいる', /history\.pushState/.test(dom), '');
check('popstate を受けている', /addEventListener\('popstate'/.test(dom), '');
check('main.js が initHistory を呼んでいる', /initHistory\(/.test(main), '');
check('試合中の戻るは確認につながる', /onGameBack/.test(dom) && /btnQuit/.test(main), '');
check('「←」が1枚だけ戻す（menu 直行でない）',
  /\$\$\('\[data-back\]'\)\.forEach\(b => \{ b\.onclick = \(\) => \{ audio\.click\(\); goBack\(\); \}/.test(main), '');

// --- 5. 新しい画面が SCREENS に入っているか ---
// 入れ忘れると、その画面だけ無言で真っ白になる。
const html = read('public/index.html');
const ids = [...html.matchAll(/<section id="screen-([\w-]+)"/g)].map(m => m[1]);
const listed = (dom.match(/const SCREENS = \[([^\]]*)\]/) || [, ''])[1];
const notListed = ids.filter(id => !listed.includes(`'${id}'`));
check('すべての画面が SCREENS に載っている', notListed.length === 0, notListed.join(', '));

// --- 6. サーバーが用意した経路を、画面がちゃんと通っているか ---
// 実際にあった事故: /api/daily/start（開始時に今日の1回を消費して attemptId を
// 発行する仕組み）をクライアントがどこからも呼んでおらず、提出にも day /
// attemptId を載せていなかった。サーバー側の不正防止は丸ごと死んだまま、
// テストは全部緑だった（旧クライアント向けの緩い経路だけを叩いていたため）。
// 「呼ばれない防御」は無いのと同じなので、配線そのものを見張る。
const modes = read('public/js/modes.js');
check('デイリー開始が /api/daily/start を呼んでいる', /\/api\/daily\/start/.test(modes), '');
check('デイリーの提出が day を添えている', /day:\s*this\.info\.day/.test(modes), '');
check('デイリーの提出が attemptId を添えている', /attemptId:\s*this\.attemptId/.test(modes), '');

// サーバーの申告ホワイトリストに無い欄は黙って捨てられる。載せ忘れると
// 上の配線が全部そろっていても値が届かない（実際そうなっていた）。
const server = read('server/index.js');
const fields = (server.match(/const RESULT_FIELDS = \[([\s\S]*?)\]/) || [, ''])[1];
check("RESULT_FIELDS に 'day' がある", /'day'/.test(fields), '');
check("RESULT_FIELDS に 'attemptId' がある", /'attemptId'/.test(fields), '');

// --- 7. プレイヤーに見える文面で、住人の正体を明かしていないか ---
// 住人（ロビーで喋り、ランキングに並び、対戦相手にもなる面々）を「AIプレイヤー」
// などと名指しすると、その瞬間に世界が薄っぺらくなる。ゲーム内ニュースが5箇所で
// 名指ししていたことがあり、しかも英語面だけの1件は改訂の仕組みの穴（下の8番）で
// 本番に残り続けた。コメントの申し送りだけでは守れないので、テストで固定する。
{
  const AI_WORDS = /AIプレイヤー|AI住人|AI player|AI opponent|AI resident/;
  const src = read('server/index.js');
  // SEED_NEWS の中身だけを切り出す（コード中のコメントは対象外 — 読むのは開発者だけ）
  const newsStart = src.indexOf('const SEED_NEWS = [');
  const newsEnd = src.indexOf('\n];', newsStart);
  const news = src.slice(newsStart, newsEnd);
  const newsHits = (news.match(new RegExp(AI_WORDS.source, 'g')) || []);
  check('ゲーム内ニュースが住人をAIと名指ししていない', newsHits.length === 0, newsHits.join(', '));

  // 管理者イベントのモード説明もプレイヤーに出る
  const ae = read('server/adminevent.js');
  const aeText = [...ae.matchAll(/^\s*(?:desc|descEn|tagline|taglineEn|name|nameEn):\s*'([\s\S]*?)',$/gm)].map(m => m[1]).join('\n');
  const aeHits = (aeText.match(new RegExp(AI_WORDS.source, 'g')) || []);
  check('管理者イベントの説明が住人をAIと名指ししていない', aeHits.length === 0, aeHits.join(', '));
}

// --- 8. お知らせの改訂が英語面の変更も拾うか ---
// 比較が日本語の body/title だけだったので、英語だけを直した改訂は
// NEWS_BODY_REV を上げても永久に公開されなかった（本番で実際に取り残された）。
{
  const src = read('server/index.js');
  const cmp = (src.match(/if \(refresh && \([\s\S]{0,220}?\)\) \{/) || [''])[0];
  check('お知らせの改訂判定が bodyEn を見ている', /existing\.bodyEn !== p\.bodyEn/.test(cmp), cmp.slice(0, 80));
  check('お知らせの改訂判定が titleEn を見ている', /existing\.titleEn !== p\.titleEn/.test(cmp), '');
}


// --- 9. 📣 スコアのシェアが全モードの結果画面に乗っているか ---
// 結果モーダルは18個あるが、報酬欄は全部 rewardsRows() を通る。ここに
// 足しておけば全モードに一度に乗る（signup ボタンと同じ作法）。1つの出口でも
// 抜けると、そのモードだけ黙ってシェアできなくなり、気づく手がかりが無い。
{
  const src = read('public/js/modes.js');
  const body = (src.match(/function rewardsRows\(rewards\) \{[\s\S]*?\n\}/) || [''])[0];
  const exits = (body.match(/shareRow\(\)/g) || []).length;
  // ⚠ 「出口がちょうど3つ」で固定しない。検査したいのは**どの出口にも
  //    シェアがあること**なので、出口（return 文）の数と shareRow() の数を
  //    突き合わせる。個数で固定すると、出口を1つ足した人が
  //    （シェアを正しく乗せていても）赤くなり、テストのほうを疑わせる。
  const returns = (body.match(/\breturn\b/g) || []).length;
  check('rewardsRows のすべての出口にシェアが乗っている',
    exits > 0 && exits === returns, `シェア ${exits} / 出口 ${returns}`);
  check('報酬あり・ゲスト・送信失敗の全部が rewardsRows を通る',
    (src.match(/\$\{rewardsRows\(rewards\)\}/g) || []).length >= 15,
    `${(src.match(/\$\{rewardsRows\(rewards\)\}/g) || []).length} モーダル`);

  // 🧾 結果送信に冪等キー(runId)が添えてあるか。サーバーは runId が来た回だけ
  //    「同じ回」を1回にまとめられる（server/index.js の RESULT_FIELDS に
  //    'runId' があることは test/api-contract.test.mjs が見張っている）。
  //    ここが抜けると、net.js の再送がそのまま二重加算に戻る。
  const submit = (src.match(/async function submitResult\([\s\S]*?\n\}/) || [''])[0];
  check('結果送信が冪等キー runId を添えている', /runId:\s*currentRunId\(\)/.test(submit),
    submit ? '' : 'submitResult が見つからない');
  // 1回のプレイで1つ・同じ試合なら同じ値であること（作り直すと鍵にならない）。
  check('runId は1回のプレイに1つだけ発行する',
    /if \(!m\.runId\) m\.runId = newRunId\(\)/.test(src), '');

  check('シェアボタンの委譲リスナーがある', /closest\('\[data-bba-share\]'\)/.test(src), '');
  check('シェア先URLに流入計測の ref が付いている', /\?ref=share/.test(src), '');
  // ゲストにも出すことが肝心（まだアカウントの無い人こそ friend に見せる）。
  const guest = (body.match(/if \(!rewards\) \{[\s\S]*?\n  \}/) || [''])[0];
  check('ゲストの結果画面にもシェアが出る', /shareRow\(\)/.test(guest), '');
  // 0点の回は誘わない（宣伝にならないうえ、押しても恥ずかしいだけ）。
  check('0点のときはシェアを出さない', /score <= 0\) return null/.test(src), '');
  // 画像つき→共有シート→コピー＋X の3段構え。どれか1つでも欠けると
  // 「押しても何も起きない」環境が生まれる。
  check('共有は画像つき・共有シート・コピーの3経路がある',
    /navigator\.canShare/.test(src) && /navigator\.share/.test(src) && /clipboard/.test(src), '');
  check('共有シートを閉じただけをエラー扱いしない', /AbortError/.test(src), '');
  // シェア文のモード名は、モードが増えるたびに足し忘れる典型的な場所。
  // 落ちても「プレイ」に化けるだけで誰も気づかないので、機械で対応を守る。
  {
    const tbl = (src.match(/const SHARE_MODE_NAME = \{[\s\S]*?\n\};/) || [''])[0];
    const listed = [...tbl.matchAll(/(\w+): \[/g)].map(m => m[1]);
    const real = [...new Set([...src.matchAll(/this\.mode = '([a-z]+)'/g)].map(m => m[1]))];
    const missing = real.filter(id => !listed.includes(id));
    const extra = listed.filter(id => !real.includes(id));
    check('シェア文のモード名が全モードを網羅している', missing.length === 0,
      missing.length ? `名前が無い: ${missing.join(', ')}` : `${real.length}モード`);
    check('シェア文に実在しないモードが混ざっていない', extra.length === 0, extra.join(', '));
  }
}

// --- 10. 外部サイトへの埋め込みは環境変数を入れたときだけ開く ---
// itch.io 等に出すために必要だが、既定で開けると誰にでも枠の中に置かれる。
{
  const src = read('server/index.js');
  // 埋め込み許可の検証。ここが緩むと「誰でも枠に入れられる」状態になり、
  // しかも許可先を1つでも書くと X-Frame-Options を落とす作りなので被害が二重。
  // 実際、最初の実装は `https://*`（全サイト許可）を通していた。
  const hostRe = (src.match(/const HOST_OK = (\/\^.*\$\/);/) || [])[1];
  check('埋め込み許可にホスト名の検証がある', !!hostRe, hostRe ? '' : '見つからない');
  if (hostRe) {
    const re = new RegExp(hostRe.slice(1, -1));
    const mustReject = ['*', 'https://*', 'http://*', 'https://*.*', 'https://a*.com'];
    const mustAccept = ['https://itch.io', 'https://*.itch.io', 'https://html-classic.itch.zone'];
    const leaked = mustReject.filter(v => re.test(v));
    const blocked = mustAccept.filter(v => !re.test(v));
    check('危険な形（全サイト許可・部分ワイルドカード）を落とす', leaked.length === 0, leaked.join(', '));
    check('itch.io の正しい指定は通す', blocked.length === 0, blocked.join(', '));
  }
  check('未設定なら X-Frame-Options を今までどおり出す',
    /if \(!FRAME_ANCESTORS\.length\) res\.setHeader\('X-Frame-Options'/.test(src), '');
  check('許可先は frame-ancestors に載る', /frame-ancestors 'self'\$\{FRAME_ANCESTORS/.test(src), '');
}


// --- 11. にぎわいプリセットがサーバーとUIで一致しているか ---
// 片方にしか無いプリセットは「ボタンはあるのに押しても何も起きない」か
// 「設定はあるのに誰も選べない」になる。どちらも例外は出ない。
{
  const srv = read('server/routes/admin.js');
  const blk = (srv.match(/const CROWD_PRESETS = \{[\s\S]*?\n\};/) || [''])[0];
  const ids = [...blk.matchAll(/^  (\w+):/gm)].map(m => m[1]);
  const ui = read('public/js/screens.js');
  const grp = (ui.match(/const PRESET_GROUPS = \[[\s\S]*?\n\];/) || [''])[0];
  const uids = [...grp.matchAll(/\['(\w+)',/g)].map(m => m[1]);
  const onlySrv = ids.filter(i => !uids.includes(i));
  const onlyUi = uids.filter(i => !ids.includes(i));
  check('プリセットがサーバーとUIで一致している', onlySrv.length === 0 && onlyUi.length === 0,
    onlySrv.length ? `UIに無い: ${onlySrv.join(', ')}` : onlyUi.length ? `サーバーに無い: ${onlyUi.join(', ')}` : `${ids.length}種`);

  // 選択肢の値が、サーバー側のクランプ範囲に収まっているか。
  // 範囲外の値は黙って丸められるので、押しても「効かないボタン」に見える。
  const amb = read('server/ambient.js');
  const maxScale = Number((amb.match(/MAX_LIVE_SCALE = (\d+)/) || [])[1]);
  const maxPace = Number((amb.match(/MAX_CHAT_PACE = (\d+)/) || [])[1]);
  const minPace = Number((amb.match(/Math\.max\(([\d.]+), Math\.min\(MAX_CHAT_PACE/) || [])[1]);
  const scales = (ui.match(/\$\{\[0, [\d., ]+\]\.map\(v => `<button data-v/) || [''])[0]
    .replace(/[^\d., ]/g, '').split(',').map(Number).filter(n => !Number.isNaN(n));
  const paces = [...grp ? [] : []].concat(
    [...ui.matchAll(/\[\[([\d.]+), 'ほぼ無言'\][\s\S]{0,400}?\]\]/g)].map(m => m[0])
  ).join('');
  const paceVals = [...paces.matchAll(/\[([\d.]+), '/g)].map(m => Number(m[1]));
  check('人口倍率の選択肢が上限を超えていない', scales.length > 0 && Math.max(...scales) <= maxScale,
    `最大 ×${Math.max(...scales)} / 上限 ×${maxScale}`);
  check('チャット頻度の選択肢が範囲に収まっている',
    paceVals.length > 0 && Math.max(...paceVals) <= maxPace && Math.min(...paceVals) >= minPace,
    `${Math.min(...paceVals)}〜${Math.max(...paceVals)} / 範囲 ${minPace}〜${maxPace}`);

  // プリセットの値も同じ範囲に収まっていること。
  const pScales = [...blk.matchAll(/scale: ([\d.]+)/g)].map(m => Number(m[1]));
  const pPaces = [...blk.matchAll(/chatPace: ([\d.]+)/g)].map(m => Number(m[1]));
  check('プリセットの人口倍率が上限を超えていない', Math.max(...pScales) <= maxScale, `最大 ×${Math.max(...pScales)}`);
  check('プリセットのチャット頻度が上限を超えていない', Math.max(...pPaces) <= maxPace, `最大 ×${Math.max(...pPaces)}`);
}


// --- 12. ショップの品揃えと実装の対応 ---
// カタログに並べただけで実装が無いと、買えるのに見た目が変わらない（既定に
// 落ちる）。例外は出ないので、買った人が「損した」と気づくまで誰も分からない。
{
  const cat = read('server/catalog.js');
  const th = read('public/js/themes.js');
  const par = read('public/js/particles.js');
  const en = read('public/js/catalog-en.js');

  const idsOf = c => [...cat.matchAll(new RegExp(`id: '(${c}_\\w+)'`, 'g'))].map(m => m[1]);
  const skins = idsOf('skin'), boards = idsOf('board'), fxs = idsOf('fx');

  const drawn = [...th.matchAll(/^  (skin_\w+):/gm)].map(m => m[1]);
  const noDraw = skins.filter(id => !drawn.includes(id));
  check('全スキンに描画関数がある', noDraw.length === 0, noDraw.join(', ') || `${skins.length}種`);

  const stages = [...th.matchAll(/^  (board_\w+): \{/gm)].map(m => m[1]);
  const noStage = boards.filter(id => !stages.includes(id));
  check('全ボードにステージ定義がある', noStage.length === 0, noStage.join(', ') || `${boards.length}種`);

  // fx_default は「既定＝分岐なし」なので対象外。
  const cases = [...par.matchAll(/case '(fx_\w+)'/g)].map(m => m[1]);
  const noFx = fxs.filter(id => id !== 'fx_default' && !cases.includes(id));
  check('全エフェクトに粒子の実装がある', noFx.length === 0, noFx.join(', ') || `${fxs.length}種`);

  // 逆向き（実装はあるのに売り場に無い）は在庫漏れ。特殊用途の board_* は
  // 買えなくてよいので、カタログにある id だけを対象にする上の検査で足りる。
  const missEn = [...skins, ...boards, ...fxs].filter(id => !new RegExp(`\\b${id}:`).test(en));
  check('全ての見た目に英語名がある', missEn.length === 0, missEn.join(', '));

  // 価格の帯。0円は default/ガチャ限定/王座/管理者だけのはずで、通常品に
  // 0円が混ざると「無料で全部揃う」になる。
  const freeNormal = [...cat.matchAll(/\{ id: '((?:skin|board|fx)_\w+)',[^}]*?price: 0,[^}]*?\}/g)]
    // 🔄 exchangeOnly も 0円でよい（交換所での値段は exPrice が持つ）。
    .filter(m => !/default: true|gachaOnly|throneOnly|adminOnly|eventOnly|exchangeOnly/.test(m[0]))
    .map(m => m[1]);
  check('通常販売品に0円が混ざっていない', freeNormal.length === 0, freeNormal.join(', '));
}


// --- 13. お知らせの整形と画像 ---
{
  const ui = read('public/js/screens.js');
  const srv = read('server/index.js');
  // 本文の装飾。全部エスケープしたままだと、書いた <b> がタグの文字で出る
  // （実際に seed の7箇所がそうなっていた）。
  check('お知らせ本文は escapeHtml を通している', /function newsHtml[\s\S]{0,200}escapeHtml\(String/.test(ui), '');
  check('<b> だけは太字として戻している', /&lt;b&gt;[\s\S]{0,120}<b>/.test(ui), '');
  check('** 強調 ** も太字にしている', ui.includes("'<b>$1</b>'"), '');
  check('本文をそのまま innerHTML に流していない',
    !/news-body">\$\{(?!newsHtml)/.test(ui), '');

  // 画像は自分のサイトの /img/ 配下だけ（CSP img-src 'self' のため、外部URLは
  // 管理画面では見えてもプレイヤーには壊れた枠になる）。
  check('画像の検証がクライアントにある',
    ui.includes('function newsImage') && ui.includes("/img/"), '');
  check('画像の検証がサーバーにもある', srv.includes('const image = ') && srv.includes('img/'), '');
  check('画像フィールドが API の返り値に載っている', /image: n\.image \|\| null/.test(srv),
    'newsView に足さないと保存できても画面に出ない');
  check('seed のお知らせも画像を運べる', /image: p\.image \|\| null/.test(srv), '');

  // 画像を指しているお知らせのファイルが実在するか（404 の枠を出さない）。
  const refs = [...srv.matchAll(/image: '(\/img\/[^']+)'/g)].map(m => m[1]);
  const missing = refs.filter(r => !fs.existsSync(path.join(root, 'public', r.replace(/^\//, ''))));
  check('お知らせが指す画像が実在する', missing.length === 0, missing.join(', ') || `${refs.length}件`);
}


// --- 14. 押しても何も起きないボタンが無いか ---
// index.html にボタンを足したのに、配線を忘れると「見えているのに押せない」
// ボタンになる。例外も出ず、CIも通り、誰かが押して報告するまで分からない。
// 実際 #btnWorkshopManage（管理画面の「工房の管理」）が、置かれてから一度も
// 配線されないまま公開されていた。
{
  const html = read('public/index.html');
  const names = ['main', 'screens', 'modes', 'chat', 'party', 'friends', 'adminevent',
    'admintools', 'dom', 'clipexport', 'ytexport', 'audio', 'game', 'i18n', 'settings', 'themes', 'net'];
  const js = names.map(n => { try { return read(`public/js/${n}.js`); } catch { return ''; } }).join('\n');
  const ids = [...html.matchAll(/<button[^>]*\bid="([\w-]+)"/g)].map(m => m[1]);
  const dead = ids.filter(id => !js.includes(id));
  check('HTMLのボタンが全部コードから参照されている', dead.length === 0,
    dead.length ? `配線されていない: ${dead.join(', ')}` : `${ids.length}個`);
}


// --- 15. バッジが全部の表に載っているか ---
// サーバーが配るバッジが、絵の表・名前の表・管理画面の一覧のどれかから
// 漏れると、その人の実績だけ画面から静かに消える（例外は出ない）。
// 実際 zero7（七段すべて陥落に居合わせた証）が5つの表から漏れていた。
{
  const battle = read('server/battle.js');
  const catalog = read('server/catalog.js');
  const ui = read('public/js/screens.js');
  const names = read('server/crowd.js');
  const srv = read('server/index.js');

  // 実際に配られているバッジID（push と、称号の has() 判定の両方から集める）
  const granted = new Set([
    ...[...battle.matchAll(/badges\.push\('([\w]+)'\)/g)].map(m => m[1]),
    ...[...srv.matchAll(/badges\.push\('([\w]+)'\)/g)].map(m => m[1]),
    ...[...catalog.matchAll(/has\('([\w]+)'\)/g)].map(m => m[1]),
  ]);
  // シーズン殿堂バッジ（season1 など連番）は表に持たず別処理なので除く
  const ids = [...granted].filter(b => !/^season\d*$/.test(b) && b.length > 2);

  const noIcon = ids.filter(b => !ui.includes(`${b}:`));
  const noName = ids.filter(b => !names.includes(`${b}:`));
  const noAdmin = ids.filter(b => !srv.includes(`'${b}'`));
  check('全バッジに絵がある（画面で🎖️に潰れない）', noIcon.length === 0, noIcon.join(', ') || `${ids.length}種`);
  check('全バッジに名前がある（フィード・お知らせ用）', noName.length === 0, noName.join(', '));
  check('全バッジが管理画面から付与できる', noAdmin.length === 0, noAdmin.join(', '));
}

// --- 8. サーバーが送るWSフレームに、画面側の受け口があるか ---
//
// 並列開発でいちばん確実に抜けるのがここ。第5波では実際に、サーバー
// （server/battle.js）と通信層（public/js/net.js）だけが再接続に対応していて、
// **画面側（modes.js）に受け口が1つも無い**まま4フレームが宙に浮いていた
// （opp_unstable / opp_back / match_resumed / reconnecting）。
// 型としては正しいので構文検査も型検査も通り抜けるし、サーバー側のテストも
// 全部緑になる ── 「送っているのに誰も聞いていない」は動かしてみるまで
// 分からないので、機械で見張る。
{
  const battle = read('server/battle.js');
  const clientSrc = ['modes.js', 'net.js', 'chat.js', 'screens.js', 'main.js',
    'party.js', 'friends.js', 'adminevent.js']
    .map(f => read(`public/js/${f}`)).join('\n');

  // 送る側は battle.js だけではない。パーティーの状態・チャット・招待は
  // server/party.js が自分で送っており、そこは長らくこの照合の外にあった
  // （＝あちらに受け口の無いフレームを足しても気づけない）。
  const partySrv = read('server/party.js');
  // ⚠ **コメントを落としてから集める。** サーバー側のコメントには
  //   「クライアントはこう送ってくる」という説明が
  //   `{ type:'room_seat', idx:…, seat:… }` の形で書いてあり、素のまま拾うと
  //   **クライアント→サーバーのメッセージまで「サーバーが送るフレーム」として
  //   数えられる**（受け口が無い、と嘘の赤が出る）。
  //   ⚠ CRLF を先に落とすこと。JS の正規表現では `\r` も行終端なので `.` が
  //     跨げず、`//.*$` は行末に `\r` が残ったままだと **1件も当たらない**
  //     （この罠で最初の版は素通りした）。read() は正規化していない。
  const stripComments = src => src.replace(/\r\n/g, '\n').split('\n')
    .map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const sent = new Set([...`${stripComments(battle)}\n${stripComments(partySrv)}`
    .matchAll(/type:\s*'([a-z_0-9]+)'/g)].map(m => m[1]));
  // 受け口の書き方は3通りある（BattleClient の .on / net.js 内の直接判定 /
  // chat.js の switch）。どれか1つでもあれば「聞いている」とみなす。
  const handled = new Set([
    ...[...clientSrc.matchAll(/\.on\(\s*'([a-z_0-9]+)'/g)].map(m => m[1]),
    ...[...clientSrc.matchAll(/msg\.type\s*===\s*'([a-z_0-9]+)'/g)].map(m => m[1]),
    ...[...clientSrc.matchAll(/case\s*'([a-z_0-9]+)'/g)].map(m => m[1]),
    // 4通り目: chat.js の常時つながっている socket に相乗りする口。
    // party.js が前から使っていて、screens.js のギルドチャットも同じ形。
    // これを見ていなかったので「受け口はあるのに無いと言われる」状態だった。
    ...[...clientSrc.matchAll(/registerHandler\(\s*'([a-z_0-9]+)'/g)].map(m => m[1]),
  ]);

  // 受け口が要らないもの。**理由を書いてから**足すこと ── 理由を書けないなら
  // それは受け口の書き忘れなので、ここではなく画面側を直す。
  const NO_HANDLER_NEEDED = new Set([
    'finish',      // クライアント→サーバー。battle.js 側は受ける側なので送らない
    'watch',       // 同上（観戦の申し込み）
    'pong',        // 心拍の返事。net.js はブラウザの標準機能に任せていて読まない
    'party_error', // パーティーの失敗は party.js が汎用の error 表示で拾う
    'room_left',   // 退室は room_update が続けて来るので、そちらで画面が直る
  ]);

  const orphan = [...sent].filter(t => !handled.has(t) && !NO_HANDLER_NEEDED.has(t)).sort();
  check('サーバーが送るWSフレームに画面側の受け口がある',
    orphan.length === 0,
    orphan.length ? `受け口が無い: ${orphan.join(', ')}` : `${sent.size}種を照合`);

  // 再接続の4フレームは名指しで見張る。上の照合は「どのファイルでもいいから
  // 誰かが聞いていれば通る」ので、net.js だけが聞いていて画面が聞いていない
  // ——という第5波でまさに起きた形は、そちらでは捕まらない。
  const modes = read('public/js/modes.js');
  for (const f of ['opp_unstable', 'opp_back', 'match_resumed', 'reconnecting']) {
    check(`  └ modes.js が ${f} を受けている`,
      new RegExp(`\\.on\\(\\s*'${f}'`).test(modes), '');
  }
  // 逆に、受け口ができたあとも「つなぎ」の announce を残すと同じことを
  // 二重に言う（帯とトーストが両方出る）。消し忘れをここで止める。
  check('  └ 猶予の「つなぎ」announce が消えている',
    !/相手の接続が不安定です/.test(battle) && !/相手が戻ってきました/.test(battle), '');
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
