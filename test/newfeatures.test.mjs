// リポジトリのルートから:  node test/newfeatures.test.mjs
//
// 🆕 新要素2つの回帰。
//
//   🔖 しおり   … 走行を預けて、次のスキマで同じ盤面から続ける
//   👁️ ゼロの眼 … 1人用の盤面に混じる観測マス（王座の欠片の初めての蛇口）
//
// どちらも「案出し58件 → 設計17件」から選んだもの。しおりは
// **露見リスクゼロ・運用の手間ゼロ・1人で完結**、ゼロの眼は
// 「王座の欠片が1人用モードから1粒も入らない」「モード同士がつながって
// いない」という空白を、同じ1マスで塞ぐ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, EYE, ICE } from '../public/js/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const modes = read('public/js/modes.js');
const game = read('public/js/game.js');
const main = read('public/js/main.js');
const idx = read('server/index.js');
const localdata = read('public/js/localdata.js');

// ===========================================================================
// A. engine の保存・復元（しおりの土台）
//
// 着手ログの再生では戻せない ── お邪魔・氷・冷却セル・観測マスは
// Math.random() で盤面に書き込まれるので、同じ手を並べても盤面が一致しない。
// 状態そのものを写す。
// ===========================================================================
{
  const e = new Engine(20260905);
  // 適当に進める（決定的な手だけを使う）
  for (let i = 0; i < 12; i++) {
    let placed = false;
    for (let h = 0; h < 3 && !placed; h++) {
      const p = e.hand[h];
      if (!p) continue;
      for (let r = 0; r < 8 && !placed; r++) {
        for (let c = 0; c < 8 && !placed; c++) {
          if (e.canPlace(p, r, c)) { e.place(h, r, c); placed = true; }
        }
      }
    }
    if (!placed) break;
  }
  e.grid[0] = 9;              // お邪魔
  e.grid[1] = ICE;            // 氷
  e.grid[2] = EYE;            // 観測マス
  e.feverUntil = Date.now() + 8000;

  const snap = e.saveState();
  const before = {
    grid: e.grid.join(''), rng: e.rng.s, score: e.score, lines: e.linesCleared,
    combo: e.maxCombo, pieces: e.piecesPlaced, rerolls: e.rerolls,
    hand: e.hand.map(p => p && `${p.color}:${p.cells.map(c => c.join(',')).join('|')}`).join('/'),
  };

  const back = new Engine(1);   // わざと違う種で作る
  const ok = back.restoreState(snap);
  check('A-1 復元できた', ok === true, '');
  check('A-2 盤面が1マスも違わない', back.grid.join('') === before.grid, '');
  check('A-3 お邪魔・氷・観測マスも戻る',
    back.grid[0] === 9 && back.grid[1] === ICE && back.grid[2] === EYE,
    `${back.grid[0]}/${back.grid[1]}/${back.grid[2]}`);
  check('A-4 スコアと記録が戻る',
    back.score === before.score && back.linesCleared === before.lines
    && back.maxCombo === before.combo && back.piecesPlaced === before.pieces, '');
  check('A-5 手札が形も色も同じ',
    back.hand.map(p => p && `${p.color}:${p.cells.map(c => c.join(',')).join('|')}`).join('/') === before.hand, '');
  check('A-6 乱数の続きが同じ（以後のピース列がズレない）', back.rng.s === before.rng,
    `${before.rng} → ${back.rng.s}`);

  // 続きを引いたときに同じ列が出ること（ここが本題）。
  const nextA = []; const nextB = [];
  const ea = new Engine(1); ea.restoreState(snap);
  const eb = new Engine(2); eb.restoreState(snap);
  for (let i = 0; i < 6; i++) { nextA.push(ea.drawPiece().color); nextB.push(eb.drawPiece().color); }
  check('A-7 復元後に引くピース列が一致する', nextA.join(',') === nextB.join(','), nextA.join(','));

  // ⏱ 期限つきの効果は「残り時間」で持つ（絶対時刻のまま預けると翌日には切れている）
  check('A-8 効果は残り時間で預ける', /feverLeft: Math\.max\(0, this\.feverUntil - Date\.now\(\)\)/.test(read('public/js/engine.js')), '');
  check('A-9 戻すときに「いま」から数え直す',
    back.feverUntil > Date.now() + 5000 && back.feverUntil < Date.now() + 12000,
    `残り ${Math.round((back.feverUntil - Date.now()) / 1000)}秒`);

  // 壊れた控えで落ちない
  check('A-10 壊れた控えは黙って断る',
    new Engine(1).restoreState(null) === false
    && new Engine(1).restoreState({ v: 99 }) === false
    && new Engine(1).restoreState({ v: 1, grid: [1, 2] }) === false, '');
}

// ===========================================================================
// B. しおりの決めごと
// ===========================================================================
{
  check('B-1 預けられるのは1本だけ（キーが1つ）', /const BOOKMARK_KEY = 'bba_bookmark';/.test(modes), '');
  check('B-2 48時間で腐る', /const BOOKMARK_TTL_MS = 48 \* 60 \* 60 \* 1000;/.test(modes), '');
  check('B-3 腐った控えは読んだ時点で捨てる',
    /if \(Date\.now\(\) - \(v\.at \|\| 0\) > BOOKMARK_TTL_MS\) \{ localStorage\.removeItem\(BOOKMARK_KEY\); return null; \}/.test(modes), '');

  // 🔒 サーバーが進行を持つモードと、公平さが命のモードは預けない。
  const set = modes.slice(modes.indexOf('const BOOKMARKABLE = new Set('), modes.indexOf(']);', modes.indexOf('const BOOKMARKABLE = new Set(')));
  for (const bad of ['pvp', 'zero', 'daily', 'weekly', 'sprint', 'coop', 'land', 'raid', 'royale', 'tourney']) {
    check(`B-4 ${bad} は預けない`, !new RegExp(`'${bad}'`).test(set), '');
  }
  check('B-5 預けられるモードには戻し方がある',
    /const BOOKMARK_START = \{/.test(modes)
    && ['solo', 'meltdown', 'survival', 'chain', 'ghost'].every(m => new RegExp(`\\b${m}: \\(\\) =>`).test(modes)), '');
  check('B-6 engine 以外の進み具合も預ける口がある',
    (modes.match(/bookmarkExtra\(\)/g) || []).length >= 3
    && (modes.match(/bookmarkRestore\(x\)/g) || []).length >= 3, '');
  check('B-7 サバイバルは次の波を「残り時間」で預ける',
    /nextIn: Math\.max\(0, this\.nextAt - Date\.now\(\)\)/.test(modes), '');
  check('B-8 連鎖の途中では預けない（落下中を写しても戻せない）',
    /return this\.cascading \? null :/.test(modes), '');

  check('B-9 片付けは endToMenu を通す（フックを次のモードへ漏らさない）',
    /export function bookmarkCurrent\(\) \{[\s\S]{0,700}?endToMenu\(\);/.test(modes), '');
  check('B-10 戻すときは先に控えを捨てる', /clearBookmark\(\);\s+\/\/ 先に捨てる/.test(modes), '');
  check('B-11 掴んでいるもの・選択も捨てる', /v\.drag = null; v\.sel = null; v\.spawnAnim\.clear\(\);/.test(modes), '');
  check('B-12 持ち主が変われば一緒に仕舞う（登録簿に載せた）',
    /'bba_bookmark',/.test(localdata), '');
  check('B-13 ✕ の確認に「しおりをはさむ」が出る', /id="qMark"/.test(main), '');
  check('B-14 預けられないモードでは出さない', /\$\{canBookmark\(\) \?/.test(main), '');
  check('B-15 メニューに「続きから」が出る', /export function refreshBookmarkCard\(\) \{/.test(main), '');
  check('B-16 残り時間が短いと色が変わる', /bookmark-soon/.test(main), '');
}

// ===========================================================================
// C. 👁️ ゼロの眼
// ===========================================================================
{
  const engineSrc = read('public/js/engine.js');
  check('C-1 マス値12を足した', /export const EYE = 12;/.test(engineSrc), '');
  check('C-2 engine の消去判定には触っていない（既存17モードが素通りする）',
    !/EYE/.test(engineSrc.slice(engineSrc.indexOf('  resolveLines() {'), engineSrc.indexOf('  place(', engineSrc.indexOf('  resolveLines() {')))), '');

  // 実物で確かめる: 眼のマスはふつうのブロックと同じく消える。
  {
    const e = new Engine(7);
    for (let c = 0; c < 7; c++) e.grid[c] = 3;
    e.grid[7] = EYE;
    const r = e.resolveLines();
    check('C-3 眼のマスも行がそろえば消える', r.lineCount === 1 && e.grid.slice(0, 8).every(v => v === 0),
      `lineCount=${r.lineCount}`);
  }
  {
    // 氷とは違う（氷は行を止める）。眼が氷と同じ扱いになっていないこと。
    const e = new Engine(7);
    for (let c = 0; c < 7; c++) e.grid[c] = 3;
    e.grid[7] = ICE;
    const r = e.resolveLines();
    check('C-4 氷はこれまでどおり行を止める', r.lineCount === 0, `lineCount=${r.lineCount}`);
  }

  check('C-5 描画はスキンを横取りする（PALETTE[12] を触らせない）',
    /function withEye\(draw\) \{/.test(game), '');
  check('C-6 包む順は withEye がいちばん外側',
    /return withEye\(withIce\(getSkin\(skinId\)\)\);/.test(game), '');
  check('C-7 開き具合は描画側が読むだけ', /export function setEyePhase\(v\)/.test(game), '');

  check('C-8 湧かせる順序がメルトダウンと同じ（消す→詰み判定）',
    /const cleared = e\.resolveLines\(\);\n\s+if \(!e\.hasAnyMove\(\)\) \{ e\.grid\[k\] = 0; return; \}/.test(modes), '');
  check('C-9 詰まりかけでは湧かせない', /if \(empty\.length < 8\) return;/.test(modes), '');
  check('C-10 開き切ったらお邪魔になる', /e\.grid\[this\.cell\] = 9;/.test(modes), '');
  check('C-11 ソロにだけ配線した', /this\.eye = new EyeWatch\(this\);/.test(modes), '');

  // 🔒 秘匿: 湧く速さを住人の数や活動から導かない（盤面がボットの人数計になる）
  const every = modes.slice(modes.indexOf('  every() {'), modes.indexOf('\n  }', modes.indexOf('  every() {')));
  check('C-12 湧く速さは世界の到達段だけから決める',
    /session\.world && session\.world\.throneMax/.test(every)
    && !/active|resident|online|humans/i.test(every), every.replace(/\s+/g, ' ').slice(0, 90));
  check('C-13 その理由がコードに書いてある', /ボットが居るか.*メーター|「いま何人ボットが居るか」のメーター/.test(modes), '');

  // サーバー側の頭押さえ
  check('C-14 申告に上限がある', /eyes = Math\.min\(clamp\(eyes, EYE_MAX_PER_RUN\)/.test(idx), '');
  check('C-15 置いた手数でも頭を押さえる', /Math\.floor\(\(pieces \|\| 0\) \/ 2\)/.test(idx), '');
  check('C-16 ソロ以外では欠片を出さない', /if \(mode === 'solo' && eyes > 0\) \{/.test(idx), '');
  check('C-17 欠片が入った回だけ結果に載せる', /\.\.\.\(eyeShards \? \{ shards: eyeShards \} : \{\}\),/.test(idx), '');
  check('C-18 結果画面に欠片の行が出る', /rewards\.shards \?/.test(modes), '');
  check('C-19 「欠片は管理者イベントでしか」の嘘を直した',
    !/欠片は管理者イベントで手に入ります/.test(read('public/js/screens.js')), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🆕 しおり と ゼロの眼  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
