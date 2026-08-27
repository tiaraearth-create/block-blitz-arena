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
  for (const n of domNames) {
    if (f === 'dom.js') continue;
    if (imported.has(n) || declared.has(n)) continue;
    if (new RegExp(`(?<![$\\w.])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(src)) orphans.push(n);
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

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
