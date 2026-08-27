// リポジトリのルートから:  node test/ytexport.test.mjs
// 🎬 YouTubeスタジオ（サントラの動画書き出し）の回帰テスト。
//
// この機能はブラウザのAPI（MediaRecorder / captureStream / Worker /
// WakeLock）に強く依存していて、Nodeでは動かせない。なので「壊れやすい形」を
// ソースの上で見張る。実際に壊れた事故を、二度と黙って通さないための番人。
//
// 実際に起きた事故:
//   1. CSP に worker-src が無く、Blob の Worker が **非同期に** 死んだ。
//      コンストラクタは成功するので try/catch では捕まらず、録画が丸ごと
//      無反応になった（描画・フレーム送出・進行管理を全部この Worker が
//      駆動しているため）。
//   2. 他の機能のモーダルがスタジオを消しても録画が裏で回り続けた。
//   3. 画面スリープ防止の札を2枚取って1枚しか返さず、画面が永久に眠らなかった。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const src = read('public/js/ytexport.js');
const server = read('server/index.js');

// ---------------------------------------------------------------------------
// 1. CSP — これが無いと録画が丸ごと動かない
// ---------------------------------------------------------------------------
// CSP はヘッダーを組み立てている場所から素直に切り出す。
// 範囲を正規表現で決め打ちすると、コメントが増えただけで見失う。
const cspAt = server.indexOf("'Content-Security-Policy'");
const csp = cspAt >= 0 ? server.slice(cspAt, cspAt + 1600) : '';
check('CSP に worker-src がある', /worker-src/.test(csp), '');
check('worker-src が blob: を許している', /worker-src[^"]*blob:/.test(csp), '');
check('script-src は self のまま（外部スクリプトは締め出す）',
  /"script-src 'self'"/.test(csp), '');

// ---------------------------------------------------------------------------
// 2. Worker が死んだときの退避
// ---------------------------------------------------------------------------
// Blob の Worker は非同期に死ぬので、try/catch だけでは足りない。
check('Worker の onerror を見ている', /w\.onerror\s*=/.test(src), '');
check('Worker が使えないときの退避口がある', /const fallback = \(\) =>/.test(src), '');
check('退避口は二重に張らない', /clearInterval\(studioState\.timer\)[\s\S]{0,80}setInterval\(tick, 33\)/.test(src), '');
check('onerror が来ない環境向けの見張りがある', /ticked === 0/.test(src), '');
// 2回目の録画が動かなくなった原因（timer を 0 に戻していなかった）
check('録画終了時に timer を 0 に戻す', /studioState\.timer = 0;/.test(src), '');

// ---------------------------------------------------------------------------
// 3. 画面が消えても録画が回り続けない
// ---------------------------------------------------------------------------
check('モーダルが消えたら畳む見張りがある', /MutationObserver/.test(src), '');
check('その見張りは canvas がDOMに居るかで判定している', /document\.contains\(canvas\)/.test(src), '');
check('見張りも後片付けで切る', /s\.gone/.test(src), '');
check('開くときに前のスタジオを畳む', /stopStudio\(\);\s*[\r\n]\s*audio\.ensure\(\)/.test(src), '');

// ---------------------------------------------------------------------------
// 4. 画面スリープ防止の札は1枚だけ
// ---------------------------------------------------------------------------
check('札を取る場所が1か所にまとまっている', /const takeWakeLock = \(\)/.test(src), '');
const requests = (src.match(/wakeLock\.request\('screen'\)/g) || []).length;
check('wakeLock.request の呼び出しは1か所だけ', requests === 1, `${requests}か所`);
check('すでに持っていたら取らない', /studioState\.wakeLock \|\| studioState\.wakeLockPending/.test(src), '');
check('録画が終わっていたら受け取った札をその場で返す', /!recording[\s\S]{0,60}wl\.release\(\)/.test(src), '');

// ---------------------------------------------------------------------------
// 5. 録画できない環境で黙って壊れない
// ---------------------------------------------------------------------------
check('実際に録れる形式を先に決めている', /const MIME =/.test(src), '');
check('canRecord が形式まで見ている', /const canRecord = !!MIME/.test(src), '');
check('MediaRecorder の生成を try で囲っている', /try \{[\s\S]{0,160}new MediaRecorder/.test(src), '');
check('失敗したら音楽の乗っ取りを解く',
  /catch \(err\)[\s\S]{0,400}setMusicEnabled\(false\)/.test(src), '');
check('何も録れなかったら知らせる', /録画データが空でした/.test(src), '');

// ---------------------------------------------------------------------------
// 6. 後片付け
// ---------------------------------------------------------------------------
check('録画トラックを止めている', /getTracks\(\)\.forEach\(tr => tr\.stop\(\)\)/.test(src), '');
check('録画の破片を捨てている', /chunks\.length = 0/.test(src), '');
check('フェード明けは一気に戻さない（プツッと鳴らない）',
  /linearRampToValueAtTime\(0\.45 \* audio\.musicVol/.test(src), '');

// ---------------------------------------------------------------------------
// 7. 縦型（ショート）対応
// ---------------------------------------------------------------------------
check('横型と縦型の2つを持っている', /FORMATS = \{[\s\S]{0,300}short:/.test(src), '');
const shortFmt = (src.match(/short:\s*\{[^}]*\}/) || [''])[0];
check('縦型は 1080×1920（9:16）', /w: 1080, h: 1920/.test(shortFmt), shortFmt.slice(0, 60));
check('縦型の長さは60秒まで', /durs: \[15, 30, 45, 60\]/.test(shortFmt), '');
check('描画が縦横を見分けている', /const tall = H > W;/.test(src), '');
check('縦型は上下の端を空ける（ショートのUIに隠されないため）',
  /H \* 0\.20/.test(src) && /H \* 0\.80/.test(src), '');
check('縦型のときだけ #Shorts を付ける', /#Shorts #BlockBlitzArena/.test(src), '');
check('ファイル名で横縦を見分けられる', /short-/.test(src), '');
check('録画中は形を変えられない', /録画中は形を変えられません/.test(src), '');
check('録画中は曲を変えられない', /録画中は曲を変えられません/.test(src), '');

// ---------------------------------------------------------------------------
// 8. 中身の正しさ
// ---------------------------------------------------------------------------
check('曲名は遊んでいる言語で出す', /const primary = t\(info\.name, info\.nameEn\)/.test(src), '');
check('サムネイルは別紙に描き直す（進行バーが写らない）',
  /off\.toBlob/.test(src), '');
check('タブを切り替えてよいかを正直に出す',
  /この画面を開いたままにしてください/.test(src), '');
check('頭出しの前に試聴を止めて予約ずみを流し切る',
  /audio\.stopPreview\(\);[\s\S]{0,200}準備中/.test(src), '');

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
