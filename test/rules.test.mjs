// リポジトリのルートから:  node test/rules.test.mjs
//
// 「遊び方」画面が**嘘のルールを教えていないか**だけを見張る検査。
//
// ■ なぜ要るのか
// 実際に友達に遊んでもらったところ「2ライン同時消しで相手を攻撃できる」を
// 知らないまま終わった。原因は単純で、このゲームにはルールを説明する場所が
// 1つも無かった。そこで public/js/rules.js に説明を置いたのだが、
// **説明は実装から離れると必ず腐る**。しかも腐っても画面は壊れないので、
// 遊んでいる人が黙って間違ったことを覚えるだけになる ── これが一番たちが悪い。
//
// ■ 方針
// 定数を書き写さない。攻撃量の式は server/battle.js の attackCells() が本物、
// 得点の式は public/js/engine.js の place() が本物なので、**両方のソースから
// 式を取り出して実際に動かし**、rules.js の値と突き合わせる。
// こうしておけば、サーバーの式を触った人が rules.js を直し忘れた瞬間に落ちる。
//
// mode-registry.test.mjs と同じく、改行コードは先に揃える
// （server/battle.js は CRLF、public/js/* は LF で保存されている）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`❌ ${name} — ${detail}`); }
}

// rules.js は i18n.js を読み、i18n.js は localStorage を触る。
// Node には無いので、読み込む前に最小限の代わりを置く。
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const rules = await import('../public/js/rules.js');

// ---------------------------------------------------------------------------
// 1. 攻撃量 — server/battle.js の attackCells() が本物
// ---------------------------------------------------------------------------
const battleSrc = read('server/battle.js');
const attackSrc = battleSrc.match(/function attackCells\s*\(([^)]*)\)\s*\{([\s\S]*?)\n  \}/);
check('server/battle.js から attackCells() を取り出せる', !!attackSrc,
  attackSrc ? '' : '関数の形が変わった可能性がある。この検査を先に直すこと');

if (attackSrc) {
  const serverAttack = new Function(attackSrc[1], attackSrc[2]);
  let mismatch = null, checked = 0;
  for (let lines = 0; lines <= 8 && !mismatch; lines++) {
    for (let combo = 0; combo <= 30; combo++) {
      const want = serverAttack(lines, combo);
      const got = rules.attackCellsFor(lines, combo);
      checked++;
      if (want !== got) { mismatch = `lines=${lines} combo=${combo}: サーバー=${want} / rules.js=${got}`; break; }
    }
  }
  check('rules.js の attackCellsFor がサーバーの式と一致する', !mismatch,
    mismatch || `${checked}通りすべて一致`);

  // 「1ラインでは攻撃にならない」は説明文の要になっている主張なので、明示的に見る。
  check('1ライン消しは攻撃にならない', serverAttack(1, 99) === 0, `= ${serverAttack(1, 99)}`);
  check('2ライン同時消しは攻撃になる', serverAttack(2, 0) > 0, `= ${serverAttack(2, 0)}個`);
}

// ---------------------------------------------------------------------------
// 2. 得点とコンボ倍率 — public/js/engine.js の place() が本物
// ---------------------------------------------------------------------------
const engineSrc = read('public/js/engine.js');

// const comboMult = 1 + 0.5 * (this.streak - 1) * (this.comboBonusMult || 1);
const multLine = engineSrc.match(/const comboMult\s*=\s*1 \+ 0\.5 \* \(this\.streak - 1\)/);
check('engine.js のコンボ倍率が 1 + 0.5*(streak-1) のまま', !!multLine,
  multLine ? '' : '式が変わった。rules.js の倍率表を直すこと');

// gained += Math.round(lineCount * lineCount * 100 * comboMult);
const gainLine = engineSrc.match(/Math\.round\(lineCount \* lineCount \* 100 \* comboMult\)/);
check('engine.js の消去点が lineCount² × 100 × 倍率 のまま', !!gainLine,
  gainLine ? '' : '式が変わった。rules.js の得点表を直すこと');

if (multLine && gainLine) {
  const want = (lineCount, streak) => Math.round(lineCount * lineCount * 100 * (1 + 0.5 * (streak - 1)));
  let bad = null;
  for (let l = 1; l <= 4 && !bad; l++) {
    for (let s = 1; s <= 12; s++) {
      if (rules.lineScore(l, s) !== want(l, s)) { bad = `lines=${l} combo=${s}`; break; }
    }
  }
  check('rules.js の lineScore が engine.js と一致する', !bad, bad || '48通りすべて一致');
}

// 説明文に載せている表そのものを見る（ここが狂うと画面に嘘が出る）。
check('得点表 1/2/3/4ライン = 100/400/900/1600',
  rules.lineScore(1, 1) === 100 && rules.lineScore(2, 1) === 400
  && rules.lineScore(3, 1) === 900 && rules.lineScore(4, 1) === 1600,
  [1, 2, 3, 4].map(l => rules.lineScore(l, 1)).join('/'));

check('倍率表 コンボ1/2/3/5/9 = ×1/1.5/2/3/5',
  rules.comboMult(1) === 1 && rules.comboMult(2) === 1.5 && rules.comboMult(3) === 2
  && rules.comboMult(5) === 3 && rules.comboMult(9) === 5,
  [1, 2, 3, 5, 9].map(s => 'x' + rules.comboMult(s)).join(' '));

// ---------------------------------------------------------------------------
// 3. 攻撃があると説明したモードに、本当に攻撃があるか
// ---------------------------------------------------------------------------
// battle.js は攻撃を match.mode === 'attack' でだけ通す。
check("battle.js が 'attack' モードでのみ攻撃を通す",
  /match\.mode === 'attack' && r\.lineCount >= 2/.test(battleSrc),
  'この条件が変わったら rules.js の「攻撃があるモード」を見直すこと');

// バトルロイヤルにも同じ 2ライン条件がある（rules.js がそう説明している）。
check('バトルロイヤルも2ライン以上で攻撃になる',
  /res\.lineCount >= 2\) royaleAttack/.test(battleSrc));

// クライアント側の送信条件も 'attack' と 2ライン。
const modesSrc = read('public/js/modes.js');
check("modes.js の送信条件も 'attack' かつ 2ライン以上",
  /this\.matchMode === 'attack' && result && result\.lineCount >= 2/.test(modesSrc));

// ---------------------------------------------------------------------------
// 4. 説明の中身が空になっていないか
// ---------------------------------------------------------------------------
const sections = rules.rulesSections();
check('遊び方の節が4つ以上ある', sections.length >= 4, `${sections.length}節`);
check('どの節も中身が空でない', sections.every(s => s.title && s.rows && s.rows.length > 0),
  sections.map(s => `${s.title}:${s.rows.length}`).join(' / '));

// オンライン対戦の選択画面に出す1行説明が、全モードぶん揃っているか。
// main.js に並ぶ data-online の値をソースから読み、書き写さない。
const mainSrc = read('public/js/main.js');
const kinds = [...mainSrc.matchAll(/data-online="([a-z]+)"/g)].map(m => m[1]);
check('main.js からオンライン対戦の一覧を読める', kinds.length > 0, kinds.join(','));
if (kinds.length) {
  const missing = kinds.filter(k => !rules.onlineModeLine(k));
  check('全モードに1行説明がある', missing.length === 0,
    missing.length ? `説明が無い: ${missing.join(', ')}` : `${kinds.length}モード`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} rules: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
