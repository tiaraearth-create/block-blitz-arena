// public/js/modes.js の「モードが守るべき約束」を静かに壊さないための検査。
//
// このファイルは 9,000行を超え、22個のモードクラスが currentMode / view という
// 共有可変状態をまたいで動いている。将来ここをファイル分割するとき（あるいは
// 新しいモードを足すとき）にいちばん怖いのは、「起動はするが終了処理だけが
// 抜けていて、前のモードのタイマーが次のモードに残る」という静かな破損。
// プレイ中には現れないので、既存のテストもブラウザでの手触り確認も見逃す。
//
// 実行時ではなくソースの形を見るので、DOM もサーバーも要らず一瞬で終わる。
//
// 【この検査の書き方の方針】
// 「たぶん危ない」ではなく「静的に証明できること」だけを見る。曖昧な指摘を
// 出すテストは、そのうち誰も読まなくなって存在しないのと同じになる。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`❌ ${name} — ${detail}`); }
}

const src = read('public/js/modes.js');

// ---------------------------------------------------------------------------
// クラス本体を波括弧の対応で正確に切り出す
// ---------------------------------------------------------------------------
// 「次の class まで」で切ると、クラスの後ろにある module スコープのコードまで
// 巻き込んで誤検知する（最初にこの検査を書いたとき実際に4件の嘘を出した）。
function classBodies(source) {
  const out = new Map();
  const re = /^class\s+([A-Za-z0-9_]+Mode)\b[^{]*\{/gm;
  for (const m of source.matchAll(re)) {
    let i = m.index + m[0].length - 1;      // 開き括弧の位置
    let depth = 0, inStr = null, inCmt = null;
    for (; i < source.length; i++) {
      const c = source[i], n = source[i + 1];
      if (inCmt) { if (inCmt === '//' && c === '\n') inCmt = null; else if (inCmt === '/*' && c === '*' && n === '/') { inCmt = null; i++; } continue; }
      if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
      if (c === '/' && n === '/') { inCmt = '//'; i++; continue; }
      if (c === '/' && n === '*') { inCmt = '/*'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    out.set(m[1], source.slice(m.index, i));
  }
  return out;
}

const bodies = classBodies(src);
check('モードクラスが見つかる', bodies.size >= 15, `${bodies.size}個`);

// ---------------------------------------------------------------------------
// 1. ライフサイクルの契約
// ---------------------------------------------------------------------------
// modes.js のディスパッチャは currentMode に対して start() と destroy() を呼ぶ。
//   start 欠落   … そのモードに入れない（すぐ気づく）
//   destroy 欠落 … タイマー・リスナー・WS が残って次のモードを侵食する（気づけない）
for (const [name, body] of bodies) {
  for (const meth of ['start', 'destroy']) {
    const has = new RegExp(`(^|\\n)\\s*(async\\s+)?${meth}\\s*\\(`).test(body);
    check(`${name}.${meth}() がある`, has, has ? '' : `${meth}() が無い`);
  }
}

// ---------------------------------------------------------------------------
// 2. タイマーの持ち主が、必ず自分で始末をつけているか
// ---------------------------------------------------------------------------
// 静的に確実に言えるのは「this.X に握ったタイマーの handle が、同じクラスの
// どこかで clear されているか」まで。destroy から直接呼んでいるか、
// stopGhostRace() のような後片付けヘルパー越しかは問わない（実際 DailyMode は
// 後者で、そこまで縛ると誤検知になる）。握りっぱなしだけを咎める。
for (const [name, body] of bodies) {
  const handles = new Set();
  for (const m of body.matchAll(/this\.([A-Za-z0-9_]+)\s*=\s*(setInterval|setTimeout)\s*\(/g)) {
    handles.add(m[1]);
  }
  for (const h of handles) {
    const cleared = new RegExp(`clear(Interval|Timeout)\\s*\\(\\s*this\\.${h}\\b`).test(body);
    check(`${name}: this.${h} のタイマーを解除している`, cleared,
      cleared ? '' : `this.${h} に握ったまま clearInterval/clearTimeout していない`);
  }
}

// ---------------------------------------------------------------------------
// 3. メニューから呼ばれる入口が本当に存在するか
// ---------------------------------------------------------------------------
// main.js は window 経由でモードの起動関数を引き、無ければ「準備中」トーストで
// 止まる安全設計。つまり配線が切れても画面は壊れず、誰も気づかないまま
// 「押しても何も起きないボタン」が残る。ここで実在を固定しておく。
// 公開元は modes.js と screens.js の両方（工房の一覧は screens.js 側）。
const main = read('public/js/main.js');
const screens = read('public/js/screens.js');
const providers = src + '\n' + screens;
const exists = n => new RegExp(`window\\.${n}\\s*=`).test(providers)
  || new RegExp(`export\\s+(async\\s+)?function\\s+${n}\\b`).test(providers);

// 単独で名指ししているもの（typeof window.X === 'function' の分岐など）は
// その名前が実在すること。
const direct = new Set();
for (const m of main.matchAll(/window\.(start[A-Za-z0-9_]+|open[A-Za-z0-9_]+)/g)) direct.add(m[1]);

// callModeEntry(['A','B','C']) は「先に見つかった名前を採用する」別名指定。
// 全部が実在する必要はなく、1つも無いときだけが配線切れ。
const groups = [];
for (const m of main.matchAll(/callModeEntry\(\[([^\]]*)\]/g)) {
  const names = [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(q => q[1]);
  if (names.length) { groups.push(names); names.forEach(n => direct.delete(n)); }
}

const missing = [...direct].filter(n => !exists(n));
const deadGroups = groups.filter(g => !g.some(exists)).map(g => g.join('/'));
check('main.js が単独で呼ぶ起動関数が実在する', missing.length === 0,
  missing.length ? `見つからない: ${missing.join(', ')}` : `${direct.size}件を照合`);
check('別名で呼ぶ入口も最低1つは実在する', deadGroups.length === 0,
  deadGroups.length ? `どの名前も無い: ${deadGroups.join(' / ')}` : `${groups.length}グループを照合`);

// ---------------------------------------------------------------------------
// 4. 共有状態の出入口が1つに保たれているか
// ---------------------------------------------------------------------------
// currentMode と view は modes.js 内で共有される可変状態で、このファイルを
// 分割するときの最大の難所（currentMode の参照は 130箇所を超える）。
// 出入口が1つであることを固定しておくと、分割時に「何を core に出すか」が
// 自明になり、二重定義で静かに壊れる事故も防げる。
const decls = [...src.matchAll(/^let\s+currentMode\b/gm)].length;
check('currentMode の宣言は1箇所だけ', decls === 1, `${decls}箇所`);
const getViewDefs = [...src.matchAll(/^(export\s+)?function\s+getView\s*\(/gm)].length;
check('getView() の定義は1箇所だけ', getViewDefs === 1, `${getViewDefs}箇所`);

// ---------------------------------------------------------------------------
// 5. 全消し「昇華」のフックを壊していないか
// ---------------------------------------------------------------------------
// installPerfectHook は view.onPlace を getter/setter で包み、モード側が
// view.onPlace に代入する作法に乗って全モード共通で昇華を拾っている。
// 包み方が変わると、全モードで演出が黙って鳴らなくなる（実際この session で
// 関数名の食い違いによって一度鳴らなくなっていた）。
check('installPerfectHook が view.onPlace を包んでいる',
  /function installPerfectHook/.test(src) && /defineProperty\(\s*v\s*,\s*'onPlace'/.test(src), '');

console.log(`\n${fail === 0 ? '✅' : '❌'} modes-structure: ${pass} 件成功 / ${fail} 件失敗`);
process.exitCode = fail === 0 ? 0 : 1;
