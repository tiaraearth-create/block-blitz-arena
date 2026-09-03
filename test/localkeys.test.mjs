// リポジトリのルートから:  node test/localkeys.test.mjs
//
// 🗄 端末に置く localStorage キー（bba_*）の一覧と仕分けを見張る。
//
// ■ なぜ要るか
//   設定の「ローカルデータをリセット」は **手書きの消去リスト** だった。
//   実在キー46種のうち25種が取り残されていて、「リセットしたのに前の人の
//   ベストスコアが残る」が起きていた。手書きの一覧は必ず腐るので、
//   ソースから機械抽出して突き合わせる。
//
// ■ 見るもの
//   ① public/ に出てくる bba_* が全部 localdata.js で分類されている
//      （分類漏れ＝ログアウトでも退会でもリセットでも触られないキー）
//   ② localdata.js に書いてあるキーが全部実在する（幽霊エントリを残さない）
//   ③ 持ち主の入れ替え: 仕舞う → 別人 → 戻ってきたら戻る（消さない）
//   ④ 解放印は「写してきたぶん」だけ落ち、「自力で見つけたぶん」は残る
//   ⑤ アカウント削除はその人ぶんを控えごと捨てる
//   ⑥ リセットは2段階（記録だけ／全部）で、記録だけのときは設定が残る
//   ⑦ 'all' は前方一致で消すので、**この表に載っていない未知のキーも消える**
//
// サーバーも DOM も要らないので、安い組で走らせてよい。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_KEYS, OWNED_KEYS, OWNED_PREFIXES, UNLOCK_KEYS, EXTERNAL_KEYS,
  OWNER_KEY, UNLOCK_SRC_KEY, ARCH_PREFIX,
  classify, switchOwner, forgetOwner, resetLocal, noteUnlockSource, locallyEarnedUnlocks,
  ownerKeyOf,
} from '../public/js/localdata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// --- ソースから bba_* を機械抽出 -------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|webmanifest)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'public'));
const found = new Map();   // key -> 出てきたファイル
for (const f of files) {
  // localdata.js 自身は「表」なので抽出元から外す（自分を根拠にしない）。
  if (f.endsWith(`${path.sep}localdata.js`)) continue;
  const src = fs.readFileSync(f, 'utf8');
  // 文字列リテラルの中だけを見る。地の文（コメントの「bba_* の仕分け」など）まで
  // 拾うと、実在しないキーで落ちる。実際のキーは必ず引用符の直後から始まる
  // （テンプレートリテラルの `bba_sprint_${dur}` も含む）。
  for (const m of src.matchAll(/['"`](bba_[a-zA-Z0-9_]*)/g)) {
    if (!found.has(m[1])) found.set(m[1], path.relative(ROOT, f));
  }
}
check('public/ から bba_* を抽出できた', found.size > 20, `${found.size}種`);

// --- ① 分類漏れが無い -------------------------------------------------------
{
  const unknown = [];
  for (const [k, where] of found) {
    // 前方一致で組み立てるキーは、根っこ（'bba_sprint_'）のほうが出てくる。
    if (OWNED_PREFIXES.includes(k)) continue;
    if (classify(k) === 'unknown') unknown.push(`${k}(${where})`);
  }
  check('① 実在する bba_* がすべて分類されている', unknown.length === 0, unknown.join(' / '));
}

// --- ② 幽霊エントリが無い ---------------------------------------------------
{
  const listed = [...DEVICE_KEYS, ...OWNED_KEYS, ...UNLOCK_KEYS, ...EXTERNAL_KEYS];
  const ghosts = listed.filter(k => !found.has(k) && !OWNED_PREFIXES.some(p => k.startsWith(p)));
  check('② 表に書いたキーが全部ソースに実在する', ghosts.length === 0, ghosts.join(' / '));
  const dupes = listed.filter((k, i) => listed.indexOf(k) !== i);
  check('② 同じキーを2つのバケツに入れていない', dupes.length === 0, dupes.join(' / '));
}

// --- ふりの localStorage ----------------------------------------------------
function fakeStore(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _dump() { return Object.fromEntries(map); },
  };
}

// --- ③ 持ち主の入れ替え -----------------------------------------------------
{
  const s = fakeStore({
    bba_settings: '{"sfxVol":0.5}',
    bba_lang: 'ja',
    bba_best: '48000',
    bba_puzzle_stars: '{"3":2}',
    bba_sprint_60: '9100',
  });
  // ゲスト → アカウントA
  const toA = switchOwner('u:A', s);
  check('③ ゲストの記録が仕舞われる', toA.stashed === 3, `stashed=${toA.stashed}`);
  check('③ 仕舞ったあと、記録は画面から消えている',
    s.getItem('bba_best') === null && s.getItem('bba_puzzle_stars') === null && s.getItem('bba_sprint_60') === null);
  check('③ 端末の好みは残る',
    s.getItem('bba_settings') === '{"sfxVol":0.5}' && s.getItem('bba_lang') === 'ja');
  check('③ 持ち主が記録される', s.getItem(OWNER_KEY) === 'u:A');

  // Aが遊ぶ
  s.setItem('bba_best', '120000');
  // A → ゲスト（ログアウト）
  switchOwner('guest', s);
  check('③ ログアウトでAの記録が画面から消える', s.getItem('bba_best') === '48000',
    `bba_best=${s.getItem('bba_best')}（ゲスト自身の記録が戻るのが正しい）`);
  check('③ ゲスト自身の★も戻る', s.getItem('bba_puzzle_stars') === '{"3":2}');

  // ゲスト → A（もう一度ログイン）
  switchOwner('u:A', s);
  check('③ Aが戻ってきたらAの記録が戻る（消していない）', s.getItem('bba_best') === '120000',
    `bba_best=${s.getItem('bba_best')}`);
  check('③ 同じ持ち主への切替は何もしない', switchOwner('u:A', s).stashed === 0);
}

// --- ④ 解放印の出どころ -----------------------------------------------------
{
  const s = fakeStore();
  // ゲストが自力で幽霊屋敷を見つけた
  s.setItem('bba_ghost', '1');
  noteUnlockSource('bba_ghost', 'local', s);
  // ログインしたら、アカウントから神が写ってきた
  switchOwner('u:A', s);
  s.setItem('bba_kami', '1');
  noteUnlockSource('bba_kami', 'u:A', s);

  check('④ 自力ぶんは引き継ぎ対象に出る', locallyEarnedUnlocks(s).join(',') === 'bba_ghost',
    locallyEarnedUnlocks(s).join(','));
  check('④ 写しは引き継ぎ対象に出ない', !locallyEarnedUnlocks(s).includes('bba_kami'));

  // ログアウト
  switchOwner('guest', s);
  check('④ Aから写した神はログアウトで落ちる', s.getItem('bba_kami') === null);
  check('④ 自力で見つけた幽霊屋敷は残る', s.getItem('bba_ghost') === '1');

  // 別人Bがログインしても、Aの解放は付いてこない
  switchOwner('u:B', s);
  check('④ 次にログインした別人にAの解放が渡らない', s.getItem('bba_kami') === null);
}

// --- ⑤ アカウント削除 -------------------------------------------------------
{
  const s = fakeStore({ bba_settings: '{}' });
  switchOwner('u:A', s);
  s.setItem('bba_best', '77000');
  s.setItem('bba_kami', '1');
  noteUnlockSource('bba_kami', 'u:A', s);
  switchOwner('guest', s);          // 一度ログアウト（Aぶんは控えへ）
  switchOwner('u:A', s);            // 戻ってくる
  check('⑤(前提) 控えから戻っている', s.getItem('bba_best') === '77000');

  forgetOwner('u:A', s);
  check('⑤ 退会したらその人の記録が端末から消える', s.getItem('bba_best') === null);
  check('⑤ 控えごと消える（戻る先が無い）', s.getItem(ARCH_PREFIX + 'u:A') === null);
  check('⑤ 持ち主はゲストに戻る', s.getItem(OWNER_KEY) === 'guest');
  check('⑤ 端末の好みは巻き添えにしない', s.getItem('bba_settings') === '{}');
}

// --- ⑥⑦ リセット2段階 ------------------------------------------------------
{
  const s = fakeStore({
    bba_settings: '{"sfxVol":0.5}',
    bba_lang: 'en',
    bba_tut_done: '1',
    bba_best: '5000',
    bba_kami: '1',
    bba_sprint_120: '3000',
    bba_token: 'xxx.yyy.zzz',
    bba_me_cache: '{"v":1}',
    bba_mystery_new_key: '1',      // 将来だれかが足した未知のキー
  });
  const removed = resetLocal('records', s);
  check('⑥ 記録・解放は消える',
    s.getItem('bba_best') === null && s.getItem('bba_kami') === null && s.getItem('bba_sprint_120') === null,
    removed.join(','));
  check('⑥ 設定・言語・チュートリアル済みは残る',
    s.getItem('bba_settings') === '{"sfxVol":0.5}' && s.getItem('bba_lang') === 'en' && s.getItem('bba_tut_done') === '1');
  check('⑥ ログイン状態は保たれる', s.getItem('bba_token') === 'xxx.yyy.zzz');

  const removedAll = resetLocal('all', s);
  check('⑦ 全部消すと設定も消える', s.getItem('bba_settings') === null && s.getItem('bba_lang') === null);
  check('⑦ 未知のキーも前方一致で消える（手書き一覧の取り残しを作らない）',
    s.getItem('bba_mystery_new_key') === null, removedAll.join(','));
  check('⑦ それでもログイン状態だけは残す', s.getItem('bba_token') === 'xxx.yyy.zzz');
}

// --- おまけ: 持ち主キーの作り方 ---------------------------------------------
{
  check('持ち主キー: 未ログインは guest', ownerKeyOf(null) === 'guest');
  check('持ち主キー: ログイン中は u:<id>', ownerKeyOf({ id: 'abc' }) === 'u:abc');
  check('持ち主キー: id の無い控えも guest 扱い', ownerKeyOf({ username: 'x' }) === 'guest');
  check('内部キーは分類できている',
    classify(OWNER_KEY) === 'internal' && classify(UNLOCK_SRC_KEY) === 'internal'
    && classify(`${ARCH_PREFIX}u:A`) === 'internal');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🗄 端末のローカルデータ  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
