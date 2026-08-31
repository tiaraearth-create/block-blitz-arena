// リポジトリのルートから:  node test/mode-registry.test.mjs
//
// 「モードを足したときの足し忘れ」だけを見張る検査。
//
// ■ なぜ要るのか
// 3回の横断監査で出た所見のうち22件が、同じ形をしていた ——
// 新しいモードを作り、メニューに並べ、遊べるようにしたところで力尽きて、
// **モードごとの表**のどれかに登録し忘れる。表は5〜8箇所に散らばっていて、
// どれも「知らないモードが来たら黙って既定の動きをする」ように書いてあるので、
// 抜けても例外は出ないし、画面も壊れない。遊んでみても気づけない:
//
//   ・applyGameResult に分岐が無い    → 遊んでも専用の記録・バッジが付かない
//   ・MODE_LABEL に無い              → 戦績に内部ID（chain / ae_invasion）が生で出る
//   ・scoreboardEligible の判断漏れ    → 桁の違うスコアがハイスコア盤を独占する
//
// 一度作った表は、逆に「もう誰も送らないのに残っているエントリ」も溜める。
// i18n.test.mjs が死んだ対訳を見張っているのと同じ考えかたで、両方向を見る。
//
// ■ この検査の方針
// 実行時ではなくソースの形を見る。DOM もサーバーも要らない。
// そして「静的に確実に言えること」だけを見る。曖昧な指摘を出すテストは、
// そのうち誰も読まなくなって存在しないのと同じになる。
// 定数は一切書き写さない。モード名も、除外リストも、ラベル表も、
// **すべて実装のソースから読み取る**（書き写した定数が実装とずれて嘘を
// つくようになったテストが、このリポジトリには実際にあった）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
// 改行コードを揃えてから扱う。server/battle.js と public/js/modes.js は CRLF、
// server/index.js と public/js/screens.js は LF で保存されている。
// 正規表現に `,\n` のような書きかたが混ざると、CRLF のファイルだけ
// 何も拾わず「0件」になり、**検査が黙って無効化される**（実際に一度なった）。
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`❌ ${name} — ${detail}`); }
}

const modesSrc = read('public/js/modes.js');
const screensSrc = read('public/js/screens.js');
const indexSrc = read('server/index.js');
const battleSrc = read('server/battle.js');
const aeSrc = read('server/adminevent.js');
const aeRouteSrc = read('server/routes/adminevent.js');

// ===========================================================================
// 0. ソースを読むための道具
// ===========================================================================
// 正規表現だけで JS を読むと、コメントや文字列の中身を拾って誤検知する。
// 深さと文字列・コメントを数えながら舐めるだけの、最小限のスキャナを持つ。

const QUOTES = `'"\``;

// i が文字列の開始位置。閉じ引用符の次の位置を返す。
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j + 1;
  }
  return src.length;
}

// i がコメントの開始位置なら、その終わりの次を返す。コメントでなければ -1。
function skipComment(src, i) {
  if (src[i] !== '/') return -1;
  if (src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; }
  if (src[i + 1] === '*') { const e = src.indexOf('*/', i); return e < 0 ? src.length : e + 2; }
  return -1;
}

// `fnName(` の呼び出しごとに、括弧の中身（引数テキスト）を返す。
// 定義側（function fnName(...)）と分割代入（{ fnName, ... }）は入らない。
function callArgs(src, fnName) {
  const out = [];
  const re = new RegExp(`(^|[^\\w.$])${fnName}\\s*\\(`, 'g');
  for (const m of src.matchAll(re)) {
    const before = src.slice(Math.max(0, m.index - 12), m.index + m[1].length);
    if (/\bfunction\s+$/.test(before)) continue;   // 定義側
    let i = m.index + m[0].length;                  // `(` の次
    let depth = 1;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      const cm = skipComment(src, i);
      if (cm >= 0) { i = cm - 1; continue; }
      if (QUOTES.includes(c)) { i = skipString(src, i) - 1; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

// 引数テキスト（`( ... )` の中身）から、オブジェクトリテラル直下の
// `mode:` の**値の式**をそのまま切り出す。三項演算子でもテンプレートでも、
// 判断せずに文字列として返す（解釈は呼び出し側でやる）。
function modeExpr(argText) {
  let depth = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    const cm = skipComment(argText, i);
    if (cm >= 0) { i = cm - 1; continue; }
    if (QUOTES.includes(c)) { i = skipString(argText, i) - 1; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    // オブジェクト直下（`{` を1つくぐった深さ）の `mode:` だけを見る。
    if (depth === 1 && argText.startsWith('mode:', i) && !/[\w.$]/.test(argText[i - 1] || ' ')) {
      let j = i + 5, d = 0;
      while (j < argText.length && /\s/.test(argText[j])) j++;
      const vs = j;
      for (; j < argText.length; j++) {
        const v = argText[j];
        const vc = skipComment(argText, j);
        if (vc >= 0) { j = vc - 1; continue; }
        if (QUOTES.includes(v)) { j = skipString(argText, j) - 1; continue; }
        if (v === '(' || v === '{' || v === '[') d++;
        else if (v === ')' || v === '}' || v === ']') { if (d === 0) break; d--; }
        else if (v === ',' && d === 0) break;
      }
      return argText.slice(vs, j).trim();
    }
  }
  return null;
}

// 関数本体を、引数の分割代入に釣られずに切り出す。
// applyGameResult は `function f(user, { mode, score, ... }) {` という形で、
// 素朴に「最初の `{`」から数えると**分割代入の閉じ括弧**で終わってしまう
// （実際それで本体1行しか取れず、全モードが「分岐なし」に見えた）。
// 括弧の深さが0のところに現れる `{` が本体の始まり。
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  let i = start, paren = 0, seenParen = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') { paren++; seenParen = true; }
    else if (c === ')') paren--;
    else if (c === '{' && seenParen && paren === 0) break;
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const cm = skipComment(src, j);
    if (cm >= 0) { j = cm - 1; continue; }
    if (QUOTES.includes(c)) { j = skipString(src, j) - 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}

// ===========================================================================
// 1. 「モードとは何か」を実コードから洗い出す
// ===========================================================================
// 表と照合する前に、まず**照合すべき集合**を作る。ここが取りこぼすと
// 検査全体が静かに空回りするので、下限アサーションを必ず置く。

// --- 1a. クライアントが送るモード（public/js/modes.js の submitResult） ---
const clientModes = new Set();
const clientDynamic = new Set();
for (const arg of callArgs(modesSrc, 'submitResult')) {
  const expr = modeExpr(arg);
  if (expr == null) continue;                       // mode を持たない呼び出し
  const lit = expr.match(/^'([a-z_0-9]+)'$/);
  if (lit) clientModes.add(lit[1]);
  else clientDynamic.add(expr);                     // 変数・三項・テンプレート
}

// 変数で渡しているものは、その場で決め打ちせず**ソースから解決する**。
// 新しい動的指定が増えたらここで赤くなる（解決方法を教えろ、という赤）。
const CLIENT_RESOLVERS = {
  // AI戦: `const modeName = { oni: 'ai_oni', ... }[this.level] || 'ai'`
  // 難易度を足すとこの表が伸びるので、表ごと読む。
  modeName: () => {
    const m = modesSrc.match(/const\s+modeName\s*=\s*\{([^}]*)\}\s*\[[^\]]*\]\s*\|\|\s*'([a-z_0-9]+)'/);
    if (!m) return [];
    return [...[...m[1].matchAll(/'([a-z_0-9]+)'/g)].map(x => x[1]), m[2]];
  },
  // ダンジョン4世界: 世界ごとの設定表が `resultMode: '...'` を持っている。
  'R.resultMode': () => [...modesSrc.matchAll(/\bresultMode:\s*'([a-z_0-9]+)'/g)].map(m => m[1]),
};

const unknownDynamic = [];
for (const expr of clientDynamic) {
  const resolve = CLIENT_RESOLVERS[expr];
  const ids = resolve ? resolve() : [];
  if (!ids.length) { unknownDynamic.push(expr); continue; }
  for (const id of ids) clientModes.add(id);
}
check('submitResult の動的な mode 指定をすべて解決できた',
  unknownDynamic.length === 0,
  unknownDynamic.length
    ? `解決方法が分からない式: ${unknownDynamic.join(' / ')} — test/mode-registry.test.mjs の CLIENT_RESOLVERS に足すこと`
    : `${clientDynamic.size}種の式を解決`);

// --- 1b. サーバーが自分で名づけるモード ---
// 対戦・ロイヤル・トーナメントはクライアントの申告を信用しない（SERVER_JUDGED_MODES）。
// 実際の mode 名は server/battle.js の applyGameResult 呼び出し側にある。
const serverModes = new Set();
const serverUnresolved = [];
for (const arg of callArgs(battleSrc, 'applyGameResult')) {
  const expr = modeExpr(arg);
  if (expr == null) continue;
  const lits = [...expr.matchAll(/'([a-z_0-9]+)'/g)].map(m => m[1]);
  if (lits.length) lits.forEach(x => serverModes.add(x));
  else serverUnresolved.push(expr);
}
// 👑管理者イベントは `ae_${run.modeId}` という一族。modeId は AE_MODES の id。
const aeArr = aeSrc.match(/export const AE_MODES\s*=\s*\[([\s\S]*?)\n\];/);
const aeIds = aeArr ? [...aeArr[1].matchAll(/^\s*id:\s*'([a-z_0-9]+)'/gm)].map(m => m[1]) : [];
const aeModes = new Set(aeIds.map(id => `ae_${id}`));
check('👑管理者イベントが ae_ 接頭辞でモード名を作っている',
  /mode:\s*`ae_\$\{run\.modeId\}`/.test(aeRouteSrc) && aeIds.length > 0,
  `AE_MODES ${aeIds.length}種`);
check('server/battle.js の applyGameResult の mode をすべて解決できた',
  serverUnresolved.length === 0, serverUnresolved.join(' / '));

const allModes = new Set([...clientModes, ...serverModes, ...aeModes]);

// 抽出が壊れたときに「全部緑」で終わらないための下限。
// 抜き出しの正規表現は、リファクタ一発で何も拾わなくなる。
check('送信される mode を十分に抽出できている',
  clientModes.size >= 20 && serverModes.size >= 5 && aeModes.size >= 3,
  `クライアント${clientModes.size}種 / サーバー${serverModes.size}種 / 管理者イベント${aeModes.size}種 = 合計${allModes.size}種`);

// ===========================================================================
// 2. クライアントは「サーバーが決めるモード」を名乗ってはいけない
// ===========================================================================
// SERVER_JUDGED_MODES に載っている名前をクライアントから送ると、
// applyGameResult は不正申告として**まるごと拒否**する（報酬0）。
// うっかり同じ名前を使うと、そのモードだけ何も付かない静かな死にかたをする。
const sjm = indexSrc.match(/SERVER_JUDGED_MODES\s*=\s*new Set\(\[([^\]]*)\]/);
const serverJudged = new Set(sjm ? [...sjm[1].matchAll(/'([a-z_0-9]+)'/g)].map(m => m[1]) : []);
check('SERVER_JUDGED_MODES を読めた', serverJudged.size > 0, `${serverJudged.size}種`);
const collide = [...clientModes].filter(m => serverJudged.has(m));
check('クライアントがサーバー判定モードを名乗っていない',
  collide.length === 0,
  collide.length ? `拒否される名前で送っている: ${collide.join(', ')}` : `${clientModes.size}種を照合`);

// ===========================================================================
// 3. applyGameResult に分岐があるか
// ===========================================================================
// 「分岐がある」＝ そのモードのために誰かが何かを書いた、ということ。
// 静的に言えるのはそこまでで、中身が正しいかは見ない（見ようとすると嘘をつく）。
const agr = functionBody(indexSrc, 'function applyGameResult(');
check('applyGameResult の本体を切り出せた', agr.split('\n').length > 100,
  `${agr.split('\n').length}行`);

const agrLiterals = new Set();
// `typeof mode === 'string'` を数えてはいけない。素朴に書いた最初の版は
// string / number を「モード分岐」として拾い、そのまま「死んだ分岐が2つある」と
// 嘘の警告を出した。型判定は除く。
for (const m of agr.matchAll(/(?<!typeof\s)mode\s*[=!]==\s*'([a-z_0-9]+)'/g)) agrLiterals.add(m[1]);
for (const m of agr.matchAll(/'([a-z_0-9]+)'\s*[=!]==\s*mode\b/g)) agrLiterals.add(m[1]);
const agrPrefixes = [...agr.matchAll(/mode\.startsWith\('([a-z_0-9]*)'\)/g)].map(m => m[1]);
// mode で引く表のキーも「分岐」と数える（ダンジョン4世界は表で回している）。
const realmTable = agr.match(/DUNGEON_REALMS\s*=\s*\{([\s\S]*?)\n\s*\};/);
const realmKeys = realmTable ? [...realmTable[1].matchAll(/^\s*([a-z_0-9]+):/gm)].map(m => m[1]) : [];
check('applyGameResult のモード分岐を読めた',
  agrLiterals.size >= 20 && agrPrefixes.length >= 1 && realmKeys.length >= 4,
  `=== ${agrLiterals.size}件 / startsWith ${agrPrefixes.length}件 / 表のキー ${realmKeys.length}件`);

const hasBranch = m =>
  agrLiterals.has(m) || realmKeys.includes(m) || agrPrefixes.some(p => p && m.startsWith(p));

// 【許可リスト①】分岐が無くて**正しい**モード。
const NO_BRANCH_OK = {
  // 'solo' は applyGameResult の**既定値そのもの**（未知の mode もここに落ちる）。
  // 分岐で足すものが無いのが正しい姿なので、永久に許可でよい。
  solo: '既定値。分岐なしが正しい',
};
// 【許可リスト②】いま既知の抜け。ここが空になるのが目標。
// 最初から赤いテストは運用されなくなるので、既知ぶんは緑から始めて
// **新しく増えたものだけ**を赤くする。直したらこの行を消すこと。
const NO_BRANCH_TODO = {
  // TODO(server): 2v2（'team'）だけ applyGameResult に一切の分岐が無い。
  // 1v1（'pvp'）には 🔥連勝ボーナス（winStreak / streakBonus）があり、
  // 敗北時のリセットもある。2v2 はレート戦で pvpWins/pvpLosses は
  // server/battle.js 側が積んでいるのに、連勝だけが伸びも切れもしない
  // ——「2v2 で連勝してもボーナスが付かず、2v2 で負けても連勝が途切れない」。
  // 意図的にそうしたのなら applyGameResult に一行コメントを、
  // そうでないなら 'pvp' の分岐に 'team' を足す。直すのは server/index.js の担当。
  team: '2v2 に連勝ボーナス（winStreak）の分岐が無い — server/index.js 側で判断',
};
const noBranch = [...allModes].filter(m =>
  !hasBranch(m) && !(m in NO_BRANCH_OK) && !(m in NO_BRANCH_TODO));
check('すべてのモードが applyGameResult に登録されている',
  noBranch.length === 0,
  noBranch.length
    ? `分岐が無い: ${noBranch.join(', ')} — 遊んでも専用の記録・バッジが付かない`
    : `${allModes.size}種を照合（既定値の ${Object.keys(NO_BRANCH_OK).join('/')} と既知の抜け ${Object.keys(NO_BRANCH_TODO).join('/')} を除く）`);
// 許可リスト②が直ったら、この検査が「もう要らない」と教えてくれる。
// 許可リストは放っておくと永久に残るので、外す合図を機械が出す。
const fixedTodo = Object.keys(NO_BRANCH_TODO).filter(m => hasBranch(m));
check('applyGameResult の許可リストに、直ったのに残っているものが無い',
  fixedTodo.length === 0,
  fixedTodo.length ? `分岐ができた: ${fixedTodo.join(', ')} — NO_BRANCH_TODO から消すこと` : '');

// 逆方向: 分岐だけ残っていて、もう誰も送らないモード。
// 死んだ分岐は「対応済みに見える」ぶんだけ、無いより性質が悪い。
const DEAD_BRANCH_OK = {};
const deadBranch = [...agrLiterals].filter(m => !allModes.has(m) && !(m in DEAD_BRANCH_OK));
check('applyGameResult に死んだモード分岐が無い',
  deadBranch.length === 0,
  deadBranch.length ? `誰も送らない mode の分岐: ${deadBranch.join(', ')}` : '');

// ===========================================================================
// 4. ハイスコア盤に載せる / 載せないを、誰かが決めたか
// ===========================================================================
// scoreboardEligible は**除外リスト方式**なので、何も書かなければ新しい
// モードは自動的に「載せる」になる。桁の違うスコアが出るモード
// （⛓️連鎖カスケードは倍率×64）を足すと、その日から通常ハイスコア盤を
// 独占する。「書き忘れ」が最悪の結果になる唯一の表なので、
// **全モードについて明示的な判断があること**を要求する。
//
// ※ 下の台帳は「実装の写し」ではなく「判断の記録」。実装側（除外リスト）は
//   ソースから読み取っていて、台帳と食い違えば赤くなる。だから台帳だけが
//   こっそり嘘になることはできない。新しいモードは台帳にも載っていないので、
//   足した人は必ず一度ここで立ち止まることになる。
const sbLine = agr.match(/const scoreboardEligible\s*=([^\n;]*);/);
check('scoreboardEligible の式を読めた', !!sbLine, sbLine ? sbLine[1].trim() : '見つからない');
const sbExcluded = new Set(sbLine ? [...sbLine[1].matchAll(/mode\s*!==\s*'([a-z_0-9]+)'/g)].map(m => m[1]) : []);
const sbExcludedPrefix = sbLine ? [...sbLine[1].matchAll(/!\s*mode\.startsWith\('([a-z_0-9]*)'\)/g)].map(m => m[1]) : [];
const isExcluded = m => sbExcluded.has(m) || sbExcludedPrefix.some(p => p && m.startsWith(p));

// true = 通常ハイスコア盤に載せる / false = 載せない
const SCOREBOARD_LEDGER = {
  // ── 載せる（スコアの桁がソロと比較可能なもの）
  solo: true, survival: true, sprint: true, chaos: true, chimera: true,
  boss: true, boss_rush: true, weekly: true, puzzle: true, dig: true,
  ghost: true, blueprint: true, workshop: true,
  dungeon: true, dungeon_under: true, dungeon_heaven: true, dungeon_abyss: true,
  ai: true, ai_oni: true, ai_kami: true, ai_souzou: true,
  pvp: true, team: true, raid: true, coop: true, tournament: true, royale: true,
  // ── 載せない
  meltdown: false,   // 加速し続ける盤面で、スコアの桁がソロと比較にならない
  chain: false,      // ⛓️連鎖倍率が最大×64。載せると通常盤を独占する
  daily: false,      // 📅デイリーは専用ランキングを持っている
  'ae_*': false,     // 👑管理者イベントは報酬倍率がかかる別勘定
};
const ledgerKey = m => (m.startsWith('ae_') ? 'ae_*' : m);
const notDecided = [...allModes].filter(m => !(ledgerKey(m) in SCOREBOARD_LEDGER));
check('ハイスコア盤に載せるかを全モードについて決めてある',
  notDecided.length === 0,
  notDecided.length
    ? `判断が無い: ${notDecided.join(', ')} — test/mode-registry.test.mjs の SCOREBOARD_LEDGER に理由つきで足すこと`
    : `${allModes.size}種を照合`);

// 台帳と実装が食い違っていないか（どちらが動いても赤くなる）
const disagree = [...allModes]
  .filter(m => ledgerKey(m) in SCOREBOARD_LEDGER)
  .filter(m => SCOREBOARD_LEDGER[ledgerKey(m)] === isExcluded(m))
  .map(m => `${m}(台帳=${SCOREBOARD_LEDGER[ledgerKey(m)] ? '載せる' : '載せない'} / 実装=${isExcluded(m) ? '載せない' : '載せる'})`);
check('scoreboardEligible の実装が台帳どおり', disagree.length === 0, disagree.join(' / '));

// 除外リストに、もう存在しないモードが残っていないか
const deadExcl = [...sbExcluded].filter(m => !allModes.has(m));
check('scoreboardEligible の除外リストに死んだモードが無い',
  deadExcl.length === 0, deadExcl.join(', '));

// ===========================================================================
// 5. MODE_LABEL（戦績の表示名）— 日英そろっているか
// ===========================================================================
// 抜けると modeLabel() が内部IDをそのまま返すので、📊戦績の「よく遊ぶモード」や
// グラフの吹き出しに `chain` / `ae_invasion` が生で出る。
const labelBlock = screensSrc.match(/const MODE_LABEL\s*=\s*\{([\s\S]*?)\n\};/);
check('MODE_LABEL を読めた', !!labelBlock, '');
const labels = new Map(
  labelBlock
    ? [...labelBlock[1].matchAll(/([a-z_0-9]+):\s*\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g)]
      .map(m => [m[1], [m[2], m[3]]])
    : []
);
check('MODE_LABEL のエントリを十分に読めた', labels.size >= 25, `${labels.size}件`);

// 【許可リスト】いま既知の抜け。緑から始めて、**新しく増えたものだけ**を赤くする。
const LABEL_MISSING_OK = {
  // 👑管理者イベント（ae_invasion / ae_roulette / ae_communal / ae_zero）は
  // MODE_LABEL に1件も無く、戦績には内部IDが生で出る。
  // modeLabel() 側に「ae_ で始まったら👑管理者イベント」の一行を足すのが筋。
  // → 直すのは screens.js の担当（このテストは実装を触らない）。
  'ae_*': '👑管理者イベントのラベルが未登録。screens.js の modeLabel に ae_ の分岐を足す担当が直す',
};
const noLabel = [...allModes].filter(m => !labels.has(m) && !(ledgerKey(m) in LABEL_MISSING_OK));
check('すべてのモードに戦績のラベルがある',
  noLabel.length === 0,
  noLabel.length
    ? `ラベルが無い（内部IDが生で出る）: ${noLabel.join(', ')}`
    : `${allModes.size}種を照合（既知の抜け ${Object.keys(LABEL_MISSING_OK).join('/')} を除く）`);

// 日英そろっているか。英語面に日本語が残ると、i18n.test.mjs と同じ事故になる。
const hasJa = s => /[ぁ-んァ-ヶ一-龠]/.test(s);
const badLabel = [];
for (const [id, [ja, en]] of labels) {
  if (!ja || !en) badLabel.push(`${id}: 空のラベル`);
  else if (!hasJa(ja)) badLabel.push(`${id}: 日本語側に日本語が無い ('${ja}')`);
  else if (hasJa(en)) badLabel.push(`${id}: 英語側に日本語が残っている ('${en}')`);
}
check('MODE_LABEL が日英そろっている', badLabel.length === 0,
  badLabel.length ? badLabel.join(' / ') : `${labels.size}件を照合`);

// 逆方向: 表にあるのに、もう誰も送らないラベル（死んだエントリ）。
// i18n.test.mjs の「死んだ対訳」と同じ考えかた。
const DEAD_LABEL_OK = {
  // AI戦の難易度は oni / kami / souzou の3段に作り直され、
  // ai_easy / ai_normal / ai_hard はどのコードからも送られなくなった。
  // 古いアカウントの stats.history には残っている可能性があるので消すのは
  // 早計かもしれない ── 残すなら「履歴の互換のため」と1行書く、消すなら消す。
  // → 判断するのは screens.js の担当。
  ai_easy: '旧AI難易度。いまは誰も送らない（古い履歴の互換のためかは要判断）',
  ai_normal: '旧AI難易度。同上',
  ai_hard: '旧AI難易度。同上',
};
const deadLabels = [...labels.keys()].filter(m => !allModes.has(m) && !(m in DEAD_LABEL_OK));
check('MODE_LABEL に死んだエントリが無い',
  deadLabels.length === 0,
  deadLabels.length
    ? `誰も送らない mode のラベル: ${deadLabels.join(', ')}`
    : `既知の死にラベル ${Object.keys(DEAD_LABEL_OK).length}件を除いて照合`);

console.log(`\n${fail === 0 ? '✅' : '❌'} mode-registry: ${pass} 件成功 / ${fail} 件失敗`);
process.exitCode = fail === 0 ? 0 : 1;
