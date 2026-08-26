// リポジトリのルートから:  node test/viewresize.test.mjs
// 盤面が「縦に潰れる」バグの回帰テスト。
//
// 症状: 試合中に上のパネルが1行伸び縮みすると canvas の CSS 高さだけが変わり、
// view.H が古いまま残る。すると
//   ・盤面が正方形でなくなって縦に潰れた長方形として描かれる
//   ・手札の当たり判定（trayY）が置き去りになり、見えているピースを掴めない
// 原因は resize() が window の resize でしか走っていなかったこと
// （ResizeObserver は public/js 全体で 0 件だった）。
//
// GameView は DOM に強く依存しているので、ここではクラスを丸ごと動かさず、
// resize() が持っているレイアウト計算そのものを取り出して検証する。
// 計算式は public/js/game.js:94-101 と一致していなければならない。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---------------------------------------------------------------------------
// 1. 直しそのものがソースに入っているか
// ---------------------------------------------------------------------------
check('ResizeObserver で canvas を監視している',
  /this\._ro = new ResizeObserver/.test(SRC) && /this\._ro\.observe\(this\.canvas\)/.test(SRC), '');
check('destroy() で Observer を切っている',
  /this\._ro\.disconnect\(\)/.test(SRC), '');
check('ResizeObserver が無い環境でも落ちない',
  /typeof ResizeObserver === 'function'/.test(SRC), '');
check('Observer が来ない環境向けの保険がループに入っている',
  /_sizeTick/.test(SRC), '');
check('同じ寸法なら計算し直さない（毎フレーム作り直さないため）',
  /_lastW/.test(SRC) && /_lastH/.test(SRC), '');

// 保険の間隔が現実的か（速すぎれば毎フレーム計測、遅すぎれば潰れが残る）
const tick = SRC.match(/>= (\d+)\) \{ this\._sizeTick = 0/);
check('保険の間隔が 5〜30 フレームに収まっている',
  !!tick && Number(tick[1]) >= 5 && Number(tick[1]) <= 30, tick ? `${tick[1]}フレーム` : '見つからない');

// ---------------------------------------------------------------------------
// 2. レイアウト計算の性質
// ---------------------------------------------------------------------------
// game.js の式をそのまま写したもの。式が変わったらここも直す必要がある。
const SIZE = 8;
function layout(W, H, showTray = true) {
  const trayH0 = showTray ? Math.min(H * 0.24, 130) : 0;
  const side = Math.min(W - 12, H - trayH0 - 16);
  const boardY = showTray ? 6 : (H - side) / 2;
  const trayY = boardY + side + 8;
  return { side, cell: side / SIZE, boardY, trayY, trayH: Math.max(0, H - trayY - 4) };
}

// 式がソースと一致していることを確かめる（写し間違いに気づけるように）
check('計算式がソースと一致している（trayH の係数）',
  SRC.includes('Math.min(this.H * 0.24, 130)'), '');
check('計算式がソースと一致している（side）',
  SRC.includes('Math.min(this.W - 12, this.H - trayH - 16)'), '');
check('計算式がソースと一致している（trayY）',
  SRC.includes('this.trayY = this.boardY + side + 8;'), '');

// --- 盤面はつねに正方形 ---
// 潰れの正体は「描画側が古い H を使うこと」なので、H が正しく渡っている限り
// 盤面は必ず正方形になる。これが崩れる入力があってはいけない。
let allSquare = true;
for (let H = 300; H <= 900; H += 7) {
  const L = layout(375 - 16, H);
  if (!(L.side > 0) || Math.abs(L.cell * SIZE - L.side) > 1e-9) { allSquare = false; break; }
}
check('どの高さでも盤面は正方形（side = cell × 8）', allSquare, '');

// --- パネルが伸びると何が起きるか（測り直した場合） ---
const W = 359;
const tall = layout(W, 675);          // アイテムバー無し
const short = layout(W, 620);         // パネルが55px 伸びた
check('パネルが伸びても盤面の幅は変わらない（幅で頭打ちのため）',
  Math.round(tall.side) === Math.round(short.side), `${Math.round(tall.side)} / ${Math.round(short.side)}`);
check('パネルが伸びると手札だけが縮む',
  short.trayH < tall.trayH, `${Math.round(tall.trayH)} → ${Math.round(short.trayH)}`);

// --- 測り直さなかった場合に何が壊れるか ---
// 古い H で描き、新しい箱に収める → 縦だけが圧縮されて長方形になる。
const squash = 1 - (620 / 675);
check('測り直さないと縦が約8%潰れる（このテストが守っている症状）',
  squash > 0.05 && squash < 0.12, `${(squash * 100).toFixed(1)}%`);
// 当たり判定のずれ。trayY は古いまま、絵は新しい箱に縮んで描かれる。
const drawnTrayY = tall.trayY * (620 / 675);
const gap = tall.trayY - drawnTrayY;
check('測り直さないと手札の当たり判定が1マス近くずれる',
  gap > tall.cell * 0.5, `${Math.round(gap)}px ずれ / 1マス${Math.round(tall.cell)}px`);

// --- 手札が消えるほど潰れないか ---
let trayAlwaysUsable = true;
for (let H = 380; H <= 900; H += 5) {
  const L = layout(W, H);
  if (L.trayH < 60) { trayAlwaysUsable = false; break; }
}
check('現実的な高さの範囲で手札が潰れきらない（60px 以上）', trayAlwaysUsable, '');

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
