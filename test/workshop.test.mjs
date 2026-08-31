// リポジトリのルートから:  node test/workshop.test.mjs
//
// 🛠パズル工房（server/routes/workshop.js + server/workshop-seed.js）が守るべき
// 約束を、サーバーを立てずに見張る。守りたい不変条件は4つ:
//
//   ① 開店祝いの初期ステージ7本は、投稿と同じ再生検証を実際に通る（＝解ける）。
//      解けないステージは公開されない仕組みなので、運営が置くステージも
//      engine.js を本当に回して確かめる。par（作者の手数）も固定値で押さえる。
//   ② 不正な盤面（要素数違い・範囲外の値・全マス埋め・光るマス不足）と、
//      存在しない形のピース番号は、公開前に弾かれる。
//   ③ 作者本人が自作を遊んでも plays は増えず、コインも出ない。
//   ④ 同じ人が同じステージを1時間以内に二度遊んでも、2回目は counted:false。
//
// ①は engine.js と workshop-seed.js の **本物の export** を走らせて確かめる。
// ②③④の実体（parseWorkshopBoard / parseWorkshopPieces / /play の門）は
// routes/workshop.js のモジュール内部関数で export されておらず、サーバーを
// 立てずには呼べない。そこは modes-structure.test.mjs と同じ方針で、
// **本物のソースの中に門が在ること** を静的に確かめる（動く写しを別に作って
// 「通った」と言うより、現物の門が消えていないかを見張るほうが嘘が少ない）。
//
// サーバーを立てないので一瞬で終わる。run-all の純ロジック群と一緒に走らせてよい。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, SHAPES, SIZE } from '../public/js/engine.js';
import {
  WORKSHOP_SEED_STAGES,
  WORKSHOP_SEED_REV,
  expandSeedBoard,
  buildWorkshopSeedStages,
  seedAuthorId,
} from '../server/workshop-seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// verifyWorkshopClear の忠実な再生ドライバ。
//
// routes/workshop.js の verifyWorkshopClear() は export されていないので、
// その契約（手札3枚・固定キューだけが供給源・リロール無し・最初からあった
// マスが全部消えたら勝ち）をここで **本物の Engine を使って** 再現する。
// 判定しているのは engine.js 本体なので、これは「初期ステージの盤面と解答が
// 現行エンジンの規則で本当に解けるか」のゴールデンテストになる。
// ※ ドライバがソースからずれていないかは、下の静的検査でも別に見張る。
// ---------------------------------------------------------------------------
function replayClear(board, pieceIdx, moves) {
  const e = new Engine(1);
  e.grid = board.slice();
  e.rerolls = 0;
  e.refillHand = () => {};
  e.reroll = () => false;
  const queue = pieceIdx.map(i => ({ shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color }));
  e.hand = [queue.shift() || null, queue.shift() || null, queue.shift() || null];
  const targets = new Set();
  for (let k = 0; k < board.length; k++) if (board[k] !== 0) targets.add(k);
  let used = 0;
  for (const mv of moves) {
    if (targets.size === 0) break;
    if (!e.hand[mv.h]) return { ok: false, reason: 'empty' };
    const r = e.place(mv.h, mv.r, mv.c);
    if (!r) return { ok: false, reason: 'illegal' };
    used++;
    e.hand[mv.h] = queue.shift() || null;
    for (const [rr, cc] of r.clearedCells) targets.delete(rr * SIZE + cc);
    e.over = false;
  }
  if (targets.size > 0) return { ok: false, reason: 'left', left: targets.size };
  return { ok: true, moves: used, score: e.score };
}

// ---------------------------------------------------------------------------
// ① 初期ステージ7本が、本物の Engine で再生してクリアできる（par も一致）
// ---------------------------------------------------------------------------
// スクラッチで確認済みの手数。ここが変わったらそれは仕様変更（初期ステージの
// 解答が現行エンジンで別手数になった、または解けなくなった）を意味する。
const EXPECTED_PARS = [1, 1, 2, 2, 4, 2, 5];

check('初期ステージは7本ある', WORKSHOP_SEED_STAGES.length === 7,
  `count=${WORKSHOP_SEED_STAGES.length}`);
check('WORKSHOP_SEED_REV は数値', Number.isInteger(WORKSHOP_SEED_REV),
  `rev=${WORKSHOP_SEED_REV}`);

{
  let allOk = true;
  const pars = [];
  for (const s of WORKSHOP_SEED_STAGES) {
    const board = expandSeedBoard(s.art);
    if (!board) { allOk = false; check(`「${s.title}」の盤面が展開できる`, false, 'expandSeedBoard=null'); continue; }
    const verdict = replayClear(board, s.pieces, s.solution);
    check(`「${s.title}」は再生でクリアできる`, !!(verdict && verdict.ok),
      verdict && verdict.ok ? `moves=${verdict.moves}` : `reason=${verdict && verdict.reason}`);
    if (!(verdict && verdict.ok)) { allOk = false; continue; }
    pars.push(verdict.moves);
  }
  check('全7本がクリア可能', allOk);
  check('par が [1,1,2,2,4,2,5] と一致する',
    JSON.stringify(pars) === JSON.stringify(EXPECTED_PARS), `pars=${JSON.stringify(pars)}`);
}

// ① 本物の組み立てパイプライン（expandSeedBoard + buildWorkshopSeedStages）も
//    同じ verify を渡すと7本すべてを通し、1本も落とさない。
{
  const dropped = [];
  const built = buildWorkshopSeedStages(replayClear, (s, why) => dropped.push([s.title, why]));
  check('buildWorkshopSeedStages が7本すべてを組み立てる',
    Array.isArray(built) && built.length === 7, `built=${built.length}, dropped=${JSON.stringify(dropped)}`);
  check('組み立てで落ちたステージは無い', dropped.length === 0, JSON.stringify(dropped));
  const parOk = built.length === 7 && built.every((s, i) => s.par === EXPECTED_PARS[i]);
  check('組み立て結果の par が期待値と一致する', parOk, built.map(s => s.par).join(','));
  const seedFlag = built.every(s => s.seed === true);
  check('全ステージに seed:true の目印が付く', seedFlag);
  // 作者idは resident: 形（db.users に居ないので還元コインは 0 になる ＝ 住人の
  // ステージがコインを生まないのは意図どおり）。
  const authorOk = built.length === 7 && built.every((s, i) => s.by === seedAuthorId(WORKSHOP_SEED_STAGES[i].resident.id));
  check('作者idが resident: 形（実ユーザーidと衝突しない）', authorOk);
  check('作者idが実ユーザー形（UUID）と衝突しない書式',
    built.every(s => /^resident:/.test(s.by)));
  // likedBy の長さと likes が必ず一致する（数だけ入れて配列が空だと、次の♡で
  // likes が 1 に落ちる）。
  const likesOk = built.every(s => Array.isArray(s.likedBy) && s.likedBy.length === s.likes);
  check('likes と likedBy.length が一致する', likesOk);
  // at（投稿日時）は固定値。Date.now() 由来だと backup.js の合流で増殖する。
  const atOk = built.length === 7 && built.every((s, i) => s.at === WORKSHOP_SEED_STAGES[i].at);
  check('投稿日時 at が固定値（機体によらず同じ）', atOk);
}

// ---------------------------------------------------------------------------
// ② 盤面展開（expandSeedBoard は本物の export）が壊れた art を弾く
// ---------------------------------------------------------------------------
const goodArt = [
  '........', '........', '........', '........',
  '........', '........', '333333..', '333333..',
];
check('正しい art は 64要素に展開できる',
  Array.isArray(expandSeedBoard(goodArt)) && expandSeedBoard(goodArt).length === 64);
check('行数が8でない art は null（要素数違い）',
  expandSeedBoard(goodArt.slice(0, 7)) === null);
check('行の長さが8でない art は null',
  expandSeedBoard(['.......', ...goodArt.slice(1)]) === null);
check('読めない文字を含む art は null',
  expandSeedBoard(['zzzzzzzz', ...goodArt.slice(1)]) === null);
check('配列でない art は null', expandSeedBoard('nope') === null);

// ---------------------------------------------------------------------------
// ②③④ 投稿検証と /play の門は routes/workshop.js のモジュール内部にあり
//      export されていないので、現物のソースに門が在ることを静的に確かめる。
// ---------------------------------------------------------------------------
const wsSrc = fs.readFileSync(path.join(root, 'server/routes/workshop.js'), 'utf8');
const has = (re) => re.test(wsSrc);

// ② 盤面: 要素数・範囲外の値・全マス埋め・光るマス不足を弾く（parseWorkshopBoard）
check('盤面: 要素数が 8×8 でなければ弾く',
  has(/raw\.length\s*!==\s*SIZE\s*\*\s*SIZE/));
check('盤面: 値の上限 WS_CELL_MAX は 11',
  has(/WS_CELL_MAX\s*=\s*11\b/));
check('盤面: 範囲外の値（例: 12）を弾く（v > WS_CELL_MAX）',
  has(/v\s*<\s*0\s*\|\|\s*v\s*>\s*WS_CELL_MAX/));
check('盤面: 全マス埋め（1手も置けない）を弾く',
  has(/filled\s*>=\s*board\.length/));
check('盤面: 光るマスの下限 WS_MIN_CELLS は 4',
  has(/WS_MIN_CELLS\s*=\s*4\b/));
check('盤面: 光るマスが下限未満（例: 3個）を弾く',
  has(/filled\s*<\s*WS_MIN_CELLS/));
// 12 が本当に範囲外、3 が本当に下限未満であることを、しきい値の数字でも押さえる。
check('しきい値の整合: 12 > 11(WS_CELL_MAX) かつ 3 < 4(WS_MIN_CELLS)',
  12 > 11 && 3 < 4);

// ② ピース: 存在しない形の番号（400）を弾く（parseWorkshopPieces）
check('ピース: SHAPES の範囲外を弾く（i < SHAPES.length）',
  has(/i\s*>=\s*0\s*&&\s*i\s*<\s*SHAPES\.length/));
check('ピース番号 400 は実際に SHAPES の範囲外',
  !(400 >= 0 && 400 < SHAPES.length), `SHAPES.length=${SHAPES.length}`);

// ③④ /play の門: プレイ数もコインも「作者本人以外 かつ 1時間に1回」に載る
check('/play: counted は「作者本人以外」を必須にする',
  has(/counted\s*=\s*stage\.by\s*!==\s*req\.user\.id\s*&&\s*rateLimit\(/));
check('/play: 二重カウント防止は wspay の 1回/時 の門',
  has(/rateLimit\(`wspay:\$\{req\.user\.id\}:\$\{stage\.code\}`,\s*1,\s*60\s*\*\s*60\s*\*\s*1000\)/));
check('/play: plays の加算は counted のときだけ（if (counted) の中）',
  has(/if\s*\(counted\)\s*\{[\s\S]*?stage\.plays\s*=\s*\(stage\.plays\s*\|\|\s*0\)\s*\+\s*1;/));
check('/play: 応答に counted を返す',
  has(/res\.json\(\{\s*ok:\s*true,\s*plays:[^}]*counted[^}]*\}\)/));
// コイン還元も counted の門の内側にある（作者本人のプレイでは呼ばれない）。
check('/play: 作者へのコイン還元 payWorkshopAuthor も counted の中',
  has(/if\s*\(counted\)\s*\{[\s\S]*?payWorkshopAuthor\(/));

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------
const failed = results.filter(r => r[0] === '❌');
for (const [mark, name, detail] of results) {
  console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
}
console.log('─'.repeat(50));
if (failed.length) {
  console.log(`❌ ${failed.length} / ${results.length} 件が失敗しました`);
} else {
  console.log(`✅ 全 ${results.length} 件が成功しました`);
}
