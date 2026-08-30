// リポジトリのルートから:  node test/engine.test.mjs
// engine.js のゴールデンマスター（決定性）テスト。
//
// このテストが守っている不変条件はひとつだけ:
//   「対戦の公平性は engine.js が決定的であることに全面的に依存している」
//
// オンライン対戦では、サーバーはシード値だけを両者に配る。ピースの列は
// 各クライアントが自分の手元で Rng(seed) から作り直す。つまり
// Rng の出力が1ビットでも変われば、同じ試合の中で相手と違うピースが降る。
// しかもその壊れ方は無音だ ── 例外も出ないし、片方の画面だけ見ていても
// 気づけない。「なんか相手だけ強い」としか観測できない。
//
// だから機械で見張る。ここに書いてある golden 値は現行実装を実際に走らせて
// 採ったもので、値が変わったらそれは**仕様変更**であって、既存プレイヤーの
// リプレイ・ランキング・進行中の対戦との互換性が切れることを意味する。
// 意図してシード互換性を切るとき以外は、値を書き換えて通してはいけない。
//
// サーバーを立てないので数百msで終わる。いちばん最初に走らせてよい。

import { Engine, Rng, SHAPES, SIZE, shapeSize } from '../public/js/engine.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// 小数の比較は 12 桁で丸めて行う。Rng は整数演算 + 定数除算なので本来
// 完全一致するが、桁を切ってもシード互換性の検出力は落ちない。
const r12 = n => Number(n.toFixed(12));

// ---------------------------------------------------------------------------
// 1. Rng のシード互換性
// ---------------------------------------------------------------------------
// mulberry32 の出力列そのもの。ここが変わったら、過去のシードで作られた
// 試合・リプレイの再現性が全部切れる。
{
  const rng = new Rng(12345);
  const got = Array.from({ length: 8 }, () => r12(rng.next()));
  const want = [0.979728267761, 0.3067522645, 0.484205421526, 0.817934412509,
                0.509428369347, 0.34747186047, 0.073757541832, 0.766396467341];
  check('Rng(12345) の出力列が既知の値と一致する',
    JSON.stringify(got) === JSON.stringify(want), got.slice(0, 3).join(', '));
}
{
  const rng = new Rng(0);
  const got = Array.from({ length: 4 }, () => r12(rng.next()));
  const want = [0.266429208685, 0.000329745701, 0.223272027448, 0.146202147938];
  check('Rng(0) の出力列が既知の値と一致する（シード0を特別扱いしていない）',
    JSON.stringify(got) === JSON.stringify(want), got.slice(0, 2).join(', '));
}
{
  // サーバーが配るシードは (Math.random() * 2**31) | 0 の範囲。上端も確かめる。
  const rng = new Rng(2 ** 31);
  const got = Array.from({ length: 3 }, () => r12(rng.next()));
  const want = [0.820577560924, 0.448108955054, 0.7836112855];
  check('Rng(2^31) の出力列が既知の値と一致する（32bit の折り返しが同じ）',
    JSON.stringify(got) === JSON.stringify(want), got.join(', '));
}
{
  const rng = new Rng(777);
  const got = Array.from({ length: 12 }, () => rng.int(8));
  const want = [5, 0, 1, 0, 5, 3, 2, 5, 4, 6, 5, 6];
  check('Rng.int(8) の出力列が既知の値と一致する',
    JSON.stringify(got) === JSON.stringify(want), got.join(''));
}
{
  // 出力は必ず [0,1) に収まっていること。1.0 が出ると int(n) が n を返し、
  // SHAPES[n] が undefined になって描画が落ちる。
  const rng = new Rng(2024);
  let lo = 1, hi = 0;
  for (let i = 0; i < 200000; i++) { const v = rng.next(); if (v < lo) lo = v; if (v > hi) hi = v; }
  // 上端は 1 に限りなく近い値が出る。toFixed で丸めると 1.000000 に見えて
  // 紛らわしいので、丸めずに出す。
  check('Rng.next() が [0,1) に収まる（20万回）', lo >= 0 && hi < 1, `${lo} 〜 ${hi}`);
}
{
  // constructor が seed >>> 0 しているので、負の値も 32bit に丸められる。
  const a = new Rng(-1), b = new Rng(4294967295);
  check('Rng は負のシードを 32bit 符号なしに丸める', r12(a.next()) === r12(b.next()), '');
  const c = new Rng(5), d = new Rng(5);
  check('同じシードの Rng は同じ列を出す（100回）',
    Array.from({ length: 100 }, () => c.next()).join() === Array.from({ length: 100 }, () => d.next()).join(), '');
  const e = new Rng(5), f = new Rng(6);
  check('違うシードの Rng は違う列を出す', e.next() !== f.next(), '');
}

// ---------------------------------------------------------------------------
// 2. SHAPES 表の指紋
// ---------------------------------------------------------------------------
// ピースの抽選は「重み付きの累積を乱数で切る」方式なので、表の**並び順**や
// 重みを1つ触るだけで、同じ乱数列から別のピースが出る。形を足したいときは
// 末尾に足せば既存シードへの影響が最小になる ── それを気づける形にしておく。
{
  const totalW = SHAPES.reduce((a, s) => a + s.w, 0);
  check('SHAPES の個数が変わっていない', SHAPES.length === 27, `${SHAPES.length}個`);
  check('SHAPES の重みの合計が変わっていない', totalW === 141, `${totalW}`);

  const str = SHAPES.map(s => `${s.color}:${s.w}:${s.cells.map(c => c.join('')).join('')}`).join('|');
  let fp = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { fp ^= str.charCodeAt(i); fp = Math.imul(fp, 16777619) >>> 0; }
  check('SHAPES 表の指紋が変わっていない（並び順・形・重み・色）', fp === 323482467, `${fp}`);

  // 表そのものの健全性。盤に入らない形が混ざると placements() が常に空になり、
  // その形を引いた瞬間に理不尽なゲームオーバーになる。
  let sane = true, bad = '';
  for (let i = 0; i < SHAPES.length; i++) {
    const { rows, cols } = shapeSize(SHAPES[i].cells);
    if (rows > SIZE || cols > SIZE || SHAPES[i].w <= 0 || !SHAPES[i].cells.length) { sane = false; bad = `#${i}`; break; }
    for (const [r, c] of SHAPES[i].cells) if (r < 0 || c < 0) { sane = false; bad = `#${i}`; break; }
  }
  check('すべての形が 8x8 に収まり、重みが正', sane, bad);
}

// ---------------------------------------------------------------------------
// 3. ピース列のゴールデン
// ---------------------------------------------------------------------------
// Engine の constructor は refillHand() まで走るので、初期手札もシードだけで
// 決まる。対戦開始直後の3枚がずれていたら、それはもう別のゲーム。
{
  const hand = seed => new Engine(seed).hand.map(p => p.shape);
  check('Engine(20260830) の初期手札が golden と一致', JSON.stringify(hand(20260830)) === '[15,4,15]', hand(20260830).join(','));
  check('Engine(1) の初期手札が golden と一致', JSON.stringify(hand(1)) === '[14,0,11]', hand(1).join(','));
  check('Engine(424242) の初期手札が golden と一致', JSON.stringify(hand(424242)) === '[2,4,3]', hand(424242).join(','));

  const e = new Engine(20260830);
  const draws = Array.from({ length: 15 }, () => e.drawPiece().shape);
  check('drawPiece() 15連の列が golden と一致',
    JSON.stringify(draws) === '[8,19,22,0,10,12,9,23,8,18,16,19,0,11,19]', draws.join(','));

  // 初期手札は必ず3枚そろっていること（null が混ざると掴めない枠ができる）。
  check('初期手札は3枚とも埋まっている', new Engine(9).hand.every(p => p && p.cells && p.cells.length > 0), '');
}

// ---------------------------------------------------------------------------
// 4. 固定シード・固定手順のゴールデン（盤面・スコア・消去ライン）
// ---------------------------------------------------------------------------
// 決まった打ち方を最後まで流し、終局の盤面・スコア・消去行数を丸ごと比べる。
// 打ち手は乱数を使わない貪欲法にしてある:
//   ① 消える行数が多い手 ② 大きいピース ③ 左上に近いマス ④ 手札の若い枠
// この順で必ず一意に決まるので、engine 側が変わらない限り結果は動かない。
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

function wouldClear(e, piece, row, col) {
  const g = e.grid.slice();
  for (const [dr, dc] of piece.cells) g[(row + dr) * SIZE + (col + dc)] = piece.color;
  let n = 0;
  for (let r = 0; r < SIZE; r++) { let f = true; for (let c = 0; c < SIZE; c++) if (!g[r * SIZE + c]) { f = false; break; } if (f) n++; }
  for (let c = 0; c < SIZE; c++) { let f = true; for (let r = 0; r < SIZE; r++) if (!g[r * SIZE + c]) { f = false; break; } if (f) n++; }
  return n;
}

// 1試合まるごと回して、外から見える状態を全部返す。
function runScript(seed, steps = 200) {
  const e = new Engine(seed);
  const log = [];
  for (let i = 0; i < steps; i++) {
    if (e.over) break;
    if (i === 5 && e.rerolls > 0) { e.reroll(); if (e.over) break; }   // 引き直しも経路に入れる
    let best = null;
    for (let j = 0; j < 3; j++) {
      const p = e.hand[j];
      if (!p) continue;
      for (const [r, c] of e.placements(p)) {
        const key = [-wouldClear(e, p, r, c), -p.cells.length, r * SIZE + c, j];
        if (!best || cmp(key, best.key) < 0) best = { key, j, r, c };
      }
    }
    if (!best) break;
    const res = e.place(best.j, best.r, best.c);
    if (!res) break;
    if (res.lineCount > 0) log.push(`${i}:${res.lineCount}:${res.gained}`);
  }
  return {
    grid: e.grid.join(''),
    score: e.score,
    lines: e.linesCleared,
    pieces: e.piecesPlaced,
    maxCombo: e.maxCombo,
    ult: Math.round(e.ult * 100) / 100,
    over: e.over,
    hand: e.hand.map(p => (p ? p.shape : -1)),
    clears: log.join(','),
  };
}

const GOLDEN = {
  20260830: {
    grid: '1166308811666880663334016601166600410460604004006007770070777700',
    score: 1066, lines: 9, pieces: 28, maxCombo: 2, ult: 100, over: true, hand: [-1, 19, -1],
    clears: '3:1:105,5:1:109,7:1:101,9:1:104,12:1:103,14:1:105,16:1:101,23:1:106,24:1:154',
  },
  7: {
    grid: '4444000005525500006007730700700307007003444000000000088000606000',
    score: 1098, lines: 9, pieces: 25, maxCombo: 2, ult: 100, over: true, hand: [-1, -1, 12],
    clears: '5:1:103,8:1:103,9:1:153,11:1:103,13:1:105,17:1:104,18:1:153,20:1:104,23:1:103',
  },
  999999: {
    grid: '1108222218444000004801110742225344100053777023337774444000600000',
    score: 1748, lines: 13, pieces: 38, maxCombo: 3, ult: 100, over: true, hand: [11, 13, 19],
    clears: '2:1:102,3:1:154,5:1:103,9:1:102,14:1:105,15:1:152,16:1:203,20:1:105,23:1:102,24:1:151,27:1:104,32:1:103,33:1:152',
  },
};

// 意図して engine の仕様を変えたときの採り直し方:
//   node test/engine.test.mjs --regold
// 現在の実装の値を GOLDEN にそのまま貼れる形で出す。
// 「落ちたからとりあえず採り直す」ためのものではない ── 採り直すことは
// 既存シードとの互換性を切ることであり、進行中の対戦やリプレイに影響する。
if (process.argv.includes('--regold')) {
  console.log('// 採り直した GOLDEN（互換性を切る意図があるときだけ貼り替える）');
  const out = {};
  for (const seed of Object.keys(GOLDEN)) out[seed] = runScript(Number(seed));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

for (const [seed, want] of Object.entries(GOLDEN)) {
  const got = runScript(Number(seed));
  check(`シード${seed}: 終局の盤面が golden と一致`, got.grid === want.grid, got.grid === want.grid ? '' : got.grid);
  check(`シード${seed}: スコアが golden と一致`, got.score === want.score, `${got.score} (期待 ${want.score})`);
  check(`シード${seed}: 消去ライン数が golden と一致`, got.lines === want.lines, `${got.lines} (期待 ${want.lines})`);
  check(`シード${seed}: 設置数・最大コンボが golden と一致`,
    got.pieces === want.pieces && got.maxCombo === want.maxCombo, `${got.pieces}手 / ${got.maxCombo}コンボ`);
  check(`シード${seed}: 消去のたびの加点内訳が golden と一致`, got.clears === want.clears, got.clears === want.clears ? '' : got.clears);
  check(`シード${seed}: 奥義ゲージの溜まり方が golden と一致`, got.ult === want.ult, `${got.ult}`);
  check(`シード${seed}: 終局状態と残り手札が golden と一致`,
    got.over === want.over && JSON.stringify(got.hand) === JSON.stringify(want.hand), `over=${got.over} hand=${got.hand.join(',')}`);
}

// golden がそもそも「意味のある試合」を捉えているか。
// もし engine が壊れて1手で終わるようになっても、上の比較は落ちるが、
// うっかり golden を採り直したときに気づけるよう性質でも縛っておく。
{
  const g = runScript(999999);
  check('golden の試合が実際に線を消している（消えない盤面を固定していない）', g.lines >= 5, `${g.lines}ライン`);
  check('golden の試合がコンボを踏んでいる', g.maxCombo >= 2, `${g.maxCombo}コンボ`);
  check('golden の試合が最後まで進んでゲームオーバーになる', g.over === true, '');
}

// ---------------------------------------------------------------------------
// 5. 対戦の公平性: 同一シード・同一手順の2インスタンスが完全一致
// ---------------------------------------------------------------------------
{
  for (const seed of [20260830, 7, 999999, 1, 0]) {
    const a = runScript(seed), b = runScript(seed);
    check(`シード${seed}: 別インスタンスでも結果が完全一致（対戦の公平性）`,
      JSON.stringify(a) === JSON.stringify(b), '');
  }
  // 違うシードなら違う試合になること（シードを無視して固定列を返していない）。
  const a = runScript(20260830), b = runScript(7);
  check('違うシードは違う試合になる（シードが効いている）', a.grid !== b.grid, '');
}
{
  // 1手ずつ突き合わせる。上の一括比較だと「最後に帳尻が合っている」場合を
  // 見逃しうるので、途中経過も同じであることを確かめる。
  const a = new Engine(31337), b = new Engine(31337);
  let same = true, where = '';
  for (let i = 0; i < 40 && !a.over && !b.over; i++) {
    if (JSON.stringify(a.hand.map(p => p && p.shape)) !== JSON.stringify(b.hand.map(p => p && p.shape))) { same = false; where = `${i}手目の手札`; break; }
    const idx = a.hand.findIndex(p => p && a.placements(p).length);
    if (idx < 0) break;
    const [r, c] = a.placements(a.hand[idx])[0];
    const ra = a.place(idx, r, c), rb = b.place(idx, r, c);
    if (JSON.stringify(ra) !== JSON.stringify(rb)) { same = false; where = `${i}手目の戻り値`; break; }
    if (a.grid.join('') !== b.grid.join('') || a.score !== b.score) { same = false; where = `${i}手目の盤面`; break; }
  }
  check('同一シードの2台は1手ごとに手札・盤面・スコアが一致する', same, where);
}
{
  // お邪魔ブロックが共有シードの乱数を進めてしまうと、攻撃を受けた側だけ
  // 以後のピース列がずれる ── 攻撃が「相手の未来を書き換える」チートになる。
  // addGarbage() が Math.random() を使っているのはそのため（engine.js の注記）。
  const a = new Engine(555), b = new Engine(555);
  a.addGarbage(6);
  const da = Array.from({ length: 10 }, () => a.drawPiece().shape).join(',');
  const db = Array.from({ length: 10 }, () => b.drawPiece().shape).join(',');
  check('お邪魔ブロックは共有シードの乱数を進めない（攻撃されてもピース列が同じ）', da === db, `${da} / ${db}`);
}

// ---------------------------------------------------------------------------
// 6. 消去と加点の規則（golden 値の意味を固定する）
// ---------------------------------------------------------------------------
{
  // 行をひとつ手で埋めて消す。加点は「置いたマス数 + lineCount^2 * 100 * コンボ倍率」。
  const e = new Engine(1);
  for (let c = 0; c < SIZE - 1; c++) e.grid[c] = 3;      // 0行目を1マスだけ残して埋める
  e.hand = [{ shape: 0, cells: [[0, 0]], color: 1 }, null, null];
  const res = e.place(0, 0, SIZE - 1);
  check('埋まった行が消える', res && res.lineCount === 1 && res.fullRows.join() === '0', res ? `${res.lineCount}本` : 'null');
  check('消えた行のマスが 0 に戻る', e.grid.slice(0, SIZE).every(v => v === 0), '');
  check('1ライン消しの加点が 1 + 100 = 101', res && res.gained === 101, res ? `${res.gained}` : '');
  check('コンボが 1 になる', e.streak === 1, `${e.streak}`);
}
{
  // 2本同時消し（行と列）。lineCount^2 なので 4 倍になる。
  const e = new Engine(2);
  for (let c = 0; c < SIZE; c++) e.grid[c] = 3;                       // 0行目
  for (let r = 0; r < SIZE; r++) e.grid[r * SIZE] = 3;                // 0列目
  e.grid[0] = 0;                                                      // 交点だけ空ける
  e.hand = [{ shape: 0, cells: [[0, 0]], color: 1 }, null, null];
  const res = e.place(0, 0, 0);
  check('行と列を同時に消せる', res && res.lineCount === 2, res ? `${res.lineCount}本` : 'null');
  check('2本同時消しの加点が 1 + 4*100 = 401', res && res.gained === 401, res ? `${res.gained}` : '');
  check('交点のマスを二重に数えない（消去マスが 15）', res && res.clearedCells.length === 15, res ? `${res.clearedCells.length}` : '');
}
{
  // コンボ倍率: 2連続目は 1 + 0.5 = 1.5 倍。
  const e = new Engine(3);
  const fill = () => { for (let c = 0; c < SIZE - 1; c++) e.grid[c] = 3; };
  e.hand = [{ shape: 0, cells: [[0, 0]], color: 1 }, null, null];
  fill(); e.place(0, 0, SIZE - 1);
  e.hand = [{ shape: 0, cells: [[0, 0]], color: 1 }, null, null];
  fill(); const res2 = e.place(0, 0, SIZE - 1);
  check('2連続消しはコンボ倍率 1.5 が乗る（1 + 150 = 151）', res2 && res2.gained === 151, res2 ? `${res2.gained}` : '');
  check('最大コンボが記録される', e.maxCombo === 2, `${e.maxCombo}`);
}
{
  // 消せなかったらコンボは切れる。
  const e = new Engine(4);
  e.streak = 5;
  e.hand = [{ shape: 0, cells: [[0, 0]], color: 1 }, null, null];
  e.place(0, 4, 4);
  check('消せない手でコンボが切れる', e.streak === 0, `${e.streak}`);
}
{
  // resolveLines() は place() の外からも効く。お邪魔で埋まった行が
  // 居座ると、8マス空くはずの盤面で不当にゲームオーバーになる。
  const e = new Engine(5);
  for (let c = 0; c < SIZE; c++) e.grid[c] = 9;
  const r = e.resolveLines();
  check('resolveLines() は place() を通さずに消せる', r.lineCount === 1 && e.grid.slice(0, SIZE).every(v => v === 0), `${r.lineCount}本`);
  check('resolveLines() だけではスコアが動かない（妨害が贈り物にならない）', e.score === 0, `${e.score}`);
}
{
  // 置けない手・終局後の手は必ず null（不正な手でスコアが動かない）。
  const e = new Engine(6);
  const p = e.hand[0];
  check('盤外への設置は拒否される', e.place(0, -1, 0) === null && e.place(0, SIZE, 0) === null, '');
  const before = e.score;
  e.place(0, 0, 0);
  e.over = true;
  check('終局後は設置できない', e.place(1, 4, 4) === null, '');
  check('拒否された手ではスコアが動かない', e.score > before && e.score === before + p.cells.length, `${e.score}`);
}
{
  // 復活は盤面だけ消してスコアを残す（時間制バトルで使う）。
  const e = new Engine(8);
  e.score = 4321; e.grid.fill(5); e.over = true;
  e.reviveBoard();
  check('reviveBoard() は盤面だけ流してスコアを残す',
    e.score === 4321 && e.grid.every(v => v === 0) && !e.over && e.hand.every(p => p), `${e.score}`);
}
{
  // snapshot() は複製であること。参照を返すと、送信後の1手で
  // 相手に見えている盤面まで書き換わる。
  const e = new Engine(10);
  const snap = e.snapshot();
  e.grid[0] = 7;
  check('snapshot() は複製を返す（参照ではない）', snap[0] !== 7 && snap.length === SIZE * SIZE, '');
}
{
  // 引き直しは1回きり。無限に引き直せると、詰みが存在しなくなる。
  const e = new Engine(11);
  check('引き直しは初期値1回', e.rerolls === 1, `${e.rerolls}`);
  check('1回目の引き直しは通る', e.reroll() === true, '');
  check('2回目の引き直しは断られる', e.reroll() === false, '');
  const f = new Engine(11);
  f.infiniteReroll = true;
  f.reroll(); f.reroll();
  check('カオス演出中は回数を消費せず引き直せる', f.rerolls === 1, `${f.rerolls}`);
}
{
  // 奥義ゲージは 0..100 に収まり、100 でのみ発動できる。
  const e = new Engine(12);
  e.chargeUlt(500);
  check('奥義ゲージは 100 を超えない', e.ult === 100 && e.ultReady === true, `${e.ult}`);
  check('満タンなら発動できる', e.consumeUlt() === true && e.ult === 0 && e.ultUses === 1, '');
  check('空なら発動できない', e.consumeUlt() === false, '');
  e.chargeUlt(-500);
  check('奥義ゲージは 0 を下回らない', e.ult === 0, `${e.ult}`);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
