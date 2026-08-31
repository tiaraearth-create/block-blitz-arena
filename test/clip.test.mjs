// リポジトリのルートから:  node test/clip.test.mjs
//
// 🎬 プレイクリップ書き出し（public/js/clipexport.js）の回帰テスト。
//
// MediaRecorder も captureStream も Node には無いので、ytexport.test.mjs と同じく
// **ソース文字列に正規表現を当てて「壊れやすい形」を見張る**方式にする。
// ここで見張るのは、どれも「壊れても例外が出ず、動画が静かに劣化する」ものばかり:
//   ・#gameCanvas に直接 captureStream を張る → resize の瞬間に映像が止まる
//   ・musicGain をタップする → 効果音が1つも入らない無音気味のクリップ
//   ・Worker の退避を片方だけ写す → 録画中の表示なのに何も起きない
//   ・停止経路の取りこぼし → 凍った絵を録り続ける / 2本目が録れない
// どれも「実際に録って再生するまで気づけない」ので、形だけでも機械で固定する。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const src = read('public/js/clipexport.js');

// --- 1. 録画対象は合成canvas（ここを間違えると映像が途中で止まる） ---
check('自前の合成canvas に captureStream を張っている',
  /out\.captureStream\(/.test(src), '');
check('ゲームの canvas に直接 captureStream を張っていない',
  !/view\.canvas\.captureStream|gameCanvas'\)\.captureStream/.test(src),
  'GameView.resize() が canvas.width を書き換えるとトラックが死ぬ');
check('盤面は drawImage で合成canvasへ転写している',
  /drawImage\(src,/.test(src), '');

// --- 2. 音の取り口（ここを間違えると効果音が入らない） ---
check('音は limiter からタップしている', /audio\.limiter\.connect\(/.test(src), '');
check('musicGain をタップしていない', !/musicGain\.connect/.test(src),
  'musicGain だとライン消し・コンボ・破砕音が1つも入らない');
check('録画をやめたらタップを外している', /audio\.limiter\.disconnect\(/.test(src), '');

// --- 3. Worker タイマーの二重の保険（片方だけだと詰む） ---
check('Worker の onerror で退避する', /worker\.onerror = fallback/.test(src), '');
check('300ms 動かなければ退避する保険がある',
  /ticked === 0\) fallback\(\)/.test(src), 'onerror が来ない環境向け');
check('退避するときは先に Worker を止める（送出が二重になると倍速になる）',
  /worker\.terminate\(\)[\s\S]{0,120}?timer = setInterval/.test(src), '');
check('タイマーを止めるときに timer を 0 に戻す（2本目が録れなくなる）',
  /clearInterval\(timer\); timer = 0;/.test(src), '');

// --- 4. 停止経路（取りこぼすと凍った絵を録り続ける） ---
check('長さに達したら止まる', /el >= dur\) stopClip/.test(src), '');
check('タブが隠れたら止まる', /document\.hidden\) stopClip/.test(src), '');
check('ゲーム画面から離れたら止まる', /dataset\.screen !== 'game'\) stopClip/.test(src), '');
check('画面遷移の見張りを片付けている', /screenObs\.disconnect\(\)/.test(src), '');
check('visibilitychange のリスナーを片付けている',
  /removeEventListener\('visibilitychange'/.test(src), '');

// --- 5. WakeLock は常に1枚だけ ---
const wakeReqs = (src.match(/wakeLock\.request\(/g) || []).length;
check('wakeLock.request の呼び出しは1か所だけ', wakeReqs === 1, `${wakeReqs}か所`);
check('取得中フラグを必ず戻す（戻し忘れると2枚目以降が永久に取れない）',
  /finally \{ state\.wakeLockPending = false; \}/.test(src), '');
check('待っている間に録画が終わっていたら札を返す',
  /if \(state\.gone\) \{ try \{ await lock\.release\(\)/.test(src), '');

// --- 6. 失敗したときに必ず後始末する ---
check('MediaRecorder の生成を try で囲んでいる',
  /try \{[\s\S]{0,200}new MediaRecorder\(/.test(src), '');
check('生成に失敗したら音のタップを解いている',
  /catch \{[\s\S]{0,240}audio\.limiter\.disconnect/.test(src), '');
check('空の録画データを黙って渡さない', /blob\.size\)[\s\S]{0,160}録画データが空/.test(src), '');

// --- 7. モーダルと Blob URL ---
check('結果モーダルは背景タップで閉じられない',
  /\{ dismissable: false \}/.test(src), '閉じられると Blob URL を解放できない');
check('Blob URL を解放している', /revokeObjectURL\(url\)/.test(src), '');
check('Worker の Blob URL も解放している', /revokeObjectURL\(url\);\s*\/\/ 読み込みは開始済み/.test(src), '');

// --- 8. 拡散の導線として成立しているか ---
check('URLを焼き込んでいる', /info\.host/.test(src) && /location\.host/.test(src), '');
check('スコアを焼き込んでいる（DOM側にしか無いので焼かないと映らない）',
  /fmt\(Math\.round\(e\.score/.test(src), '');
check('共有リンクに流入計測の ref が付いている', /\?ref=clip/.test(src), '');
check('共有は共有シートとコピーの2段構え',
  /navigator\.canShare/.test(src) && /clipboard\.writeText/.test(src), '');
check('共有シートを閉じただけをエラー扱いしない', /AbortError/.test(src), '');

// --- 9. 全員が使えること（管理者ゲートを入れない） ---
check('管理者専用になっていない', !/staffExtras|role === 'admin'/.test(src),
  'プレイヤー自身が拡散装置になるのが目的');

// --- 10. 配線 ---
const html = read('public/index.html');
check('HUD に 🎬 ボタンがある', /id="btnClip"/.test(html), '');
const main = read('public/js/main.js');
check('main.js から配線している', /initClipHud\(\)/.test(main), '');
check('main.js が clipexport を import している',
  /from '\.\/clipexport\.js'/.test(main), '');
check('modes.js は clipexport を import していない（循環するため）',
  !/from '\.\/clipexport\.js'/.test(read('public/js/modes.js')), '');
check('モード名はシェアと同じ表を使っている（表が2つに割れると片方が古くなる）',
  /modeDisplayName/.test(src) && /export function modeDisplayName/.test(read('public/js/modes.js')), '');
const css = read('public/css/style.css');
check('録画中の帯にスタイルがある', /#clipBar \{/.test(css), '');
check('帯が iPhone のホームバーを避けている', /safe-area-inset-bottom/.test(css.match(/#clipBar \{[\s\S]*?\}/)[0]), '');
check('明滅は prefers-reduced-motion で止まる',
  /prefers-reduced-motion[\s\S]{0,120}clipLeft[\s\S]{0,60}animation: none/.test(css), '');

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
