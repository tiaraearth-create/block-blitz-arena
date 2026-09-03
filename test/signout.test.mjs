// リポジトリのルートから:  node test/signout.test.mjs
//
// 🚪 「ログアウト／アカウント削除しても前のデータが残る」の回帰テスト。
//
// ■ 何が起きていたか
//   ログアウトが消していたのは bba_token と bba_me_cache の2つだけだった。
//   各モードのベスト記録・到達階・パズルの★・解放状態・ゲストの所持品は
//   ログイン中でも端末に書かれるので、ログアウトしても退会しても
//   **前の人の記録が次の人の画面にそのまま出て**いた。
//   さらに画面（フレンド一覧・所持品・ミッション・管理画面）は hidden を
//   付け外しするだけで中身を捨てないので、そこも残っていた。
//
// ■ ここで見るもの
//   A. dom.js を**実際に動かして**、持ち主が変わったら端末の記録が
//      入れ替わること（消えるのではなく、その人のぶんに入れ替わる）
//   B. 起動直後の「トークンはあるが誰か分からない」あいだは動かさないこと
//      （ここで倒すと、開くたびにゲストとの往復が起きる）
//   C. 配線が外れていないこと（ソース検査）── ログアウトが画面を畳むか、
//      退会が端末の記録を捨てるか、設定のリセットが手書き一覧に戻っていないか
//
// public/js は素のままブラウザへ配られるので、器（localStorage / 最小の DOM）
// だけ用意して本物のモジュールを読む。作法は test/offlineauth.test.mjs と同じ。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// 器
// ---------------------------------------------------------------------------
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
    key: i => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}
const ELEMS = new Map();
function makeEl(id = '', tag = 'SPAN') {
  const classes = new Set();
  return {
    id, tagName: tag, textContent: '', innerHTML: '', title: '',
    style: { cssText: '', opacity: '' }, dataset: {}, attrs: {}, children: [],
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { const n = on === undefined ? !classes.has(c) : !!on; if (n) classes.add(c); else classes.delete(c); return n; },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); if (c && c.id) ELEMS.set(c.id, c); return c; },
    append(...xs) { for (const x of xs) this.children.push(typeof x === 'object' ? x : { text: String(x) }); },
    replaceChildren(...xs) { this.children = []; this.append(...xs); },
    insertAdjacentHTML(_p, html) { this.children.push({ html: String(html) }); },
    insertAdjacentElement(_p, node) { this.children.push(node); return node; },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, remove() {},
  };
}
for (const id of ['userName', 'userAvatar', 'coinsLabel', 'gemsLabel', 'userLevel', 'btnAdmin', 'userChip']) {
  ELEMS.set(id, makeEl(id));
}
const LS = makeLocalStorage();
defineGlobal('localStorage', LS);
defineGlobal('navigator', { language: 'ja', onLine: false });
defineGlobal('document', {
  querySelector: sel => (typeof sel === 'string' && sel.startsWith('#') ? ELEMS.get(sel.slice(1)) || null : null),
  querySelectorAll: () => [],
  getElementById: id => ELEMS.get(id) || null,
  createElement: tag => makeEl('', String(tag).toUpperCase()),
  addEventListener: () => {}, body: makeEl('body', 'BODY'), activeElement: null,
});
const intervals = [];
defineGlobal('setInterval', (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; });
defineGlobal('clearInterval', h => { const i = intervals.indexOf(h); if (i >= 0) intervals.splice(i, 1); });
defineGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

const { session } = await import('../public/js/net.js');
const { updateTopbar, clearCachedUser } = await import('../public/js/dom.js');
const { OWNER_KEY, ARCH_PREFIX } = await import('../public/js/localdata.js');

const owner = () => LS.getItem(OWNER_KEY);
const best = () => LS.getItem('bba_best');

// 「その人としてアプリを見ている」状態にして塗り直す。
function signedIn(id) {
  clearCachedUser();                 // 控えからの復元をやり直させる
  session.token = `tok-${id}`;
  session.user = {
    id, username: `ゆーざー${id}`, role: 'player', coins: 10, gems: 1, xp: 0, level: 1,
    stats: { bestScore: 1, rating: 1000, gamesPlayed: 1, history: [] },
    owned: [], equipped: {}, items: {}, badges: [], achievements: [], thrones: [],
    social: {}, battlePass: { season: 1, xp: 0, premium: false, claimed: [] },
  };
  updateTopbar();
}
function signedOut() {
  clearCachedUser();
  session.token = null;
  session.user = null;
  updateTopbar();
}

// ===========================================================================
// A. 持ち主が変わったら、端末の記録が入れ替わる
// ===========================================================================
signedOut();
check('A-0 未ログインなら持ち主はゲスト', owner() === 'guest', `owner=${owner()}`);

LS.setItem('bba_best', '5000');          // ゲストとして遊んだ記録
LS.setItem('bba_settings', '{"sfxVol":0.4}');

signedIn('A');
check('A-1 ログインすると持ち主が変わる', owner() === 'u:A', `owner=${owner()}`);
check('A-2 ゲストの記録は画面から消える', best() === null, `bba_best=${best()}`);
check('A-3 でも捨ててはいない（控えにある）', LS.getItem(`${ARCH_PREFIX}guest`) !== null);
check('A-4 端末の好み（音量）は巻き添えにしない', LS.getItem('bba_settings') === '{"sfxVol":0.4}');

LS.setItem('bba_best', '90000');         // A が遊んだ記録

signedOut();
check('A-5 ログアウトでAの記録が画面から消える', best() === '5000',
  `bba_best=${best()}（ゲスト自身の 5000 に戻るのが正しい）`);
check('A-6 持ち主がゲストに戻る', owner() === 'guest', `owner=${owner()}`);

signedIn('B');
check('A-7 別人Bの画面にAの記録は出ない', best() === null, `bba_best=${best()}`);

signedIn('A');
check('A-8 Aが戻ってきたらAの記録も戻る（消していない）', best() === '90000', `bba_best=${best()}`);

// ===========================================================================
// B. 起動直後（トークンはあるが、誰かはまだ分からない）は動かさない
// ===========================================================================
{
  // 控えを消したうえで「トークンだけある」状態を作る。控えが残っていると
  // dom.js がそこから復元してしまい、この状況を再現できない。
  clearCachedUser();
  LS.removeItem('bba_me_cache');
  session.token = 'tok-A';
  session.user = null;
  const before = owner();
  updateTopbar();
  check('B-1 誰か分からないあいだは持ち主を動かさない', owner() === before,
    `${before} → ${owner()}`);
  check('B-2 記録も動かさない', best() === '90000', `bba_best=${best()}`);
}

// ===========================================================================
// C. 配線（ソース検査）
// ===========================================================================
{
  const screens = read('public/js/screens.js');
  const logout = screens.slice(screens.indexOf("m.querySelector('#pLogout').onclick"));
  const logoutBody = logout.slice(0, logout.indexOf('\n  };'));
  check('C-1 ログアウトがメニュー画面へ戻す', /showScreen\('menu'\)/.test(logoutBody), '');
  check('C-2 ログアウトが画面の中身を捨てる', /resetScreenCaches\(\)/.test(logoutBody), '');
  check('C-3 ログアウトが対戦用ソケットを閉じる', /leaveOnlineOnSignOut/.test(logoutBody), '');
  check('C-4 ログアウトが上部バーを塗り直す（持ち主の切替もここ）', /updateTopbar\(\)/.test(logoutBody), '');
  check('C-5 通信が届かなかったときに別の文面を出す', /reachedServer/.test(logoutBody), '');

  const del = screens.slice(screens.indexOf('delYes.onclick'));
  const delBody = del.slice(0, del.indexOf('\n    };'));
  check('C-6 退会が端末の記録も捨てる', /forgetOwner\(/.test(delBody), '');
  check('C-7 退会が「前回の情報」の控えも捨てる', /clearCachedUser\(\)/.test(delBody), '');
  check('C-8 退会ボタンに二重送信ガードがある', /disabled = true/.test(delBody) && /if \(delYes\.disabled\) return/.test(delBody), '');
  check('C-9 退会の失敗でボタンが戻る', /disabled = false/.test(delBody), '');

  const reset = screens.slice(screens.indexOf("m.querySelector('#setResetLocal').onclick"));
  const resetBody = reset.slice(0, reset.indexOf('\n  };'));
  check('C-10 リセットが localdata.js の resetLocal を使う', /resetLocal\(/.test(resetBody), '');
  check('C-11 リセットが2段階になっている', /'records'/.test(resetBody) && /'all'/.test(resetBody), '');
  check('C-12 手書きのキー一覧が復活していない',
    !/'bba_meltdown_best'/.test(resetBody) && !/'bba_puzzle_stars'/.test(resetBody), '');

  const dom = read('public/js/dom.js');
  check('C-13 updateTopbar が持ち主を同期する', /switchOwner\(ownerNow\)/.test(dom), '');
  check('C-14 誰か分からないあいだは同期しない（門がある）',
    /session\.token \? null : 'guest'/.test(dom), '');

  const main = read('public/js/main.js');
  check('C-15 引き継ぎは「自力で見つけたぶん」だけ', /locallyEarnedUnlocks\(\)/.test(main), '');
  check('C-16 自力で見つけたら出どころを記録する', /noteUnlockSource\(UNLOCK_LS_KEYS\[id\], 'local'\)/.test(main), '');

  const net = read('public/js/net.js');
  check('C-17 アカウントから写した解放は出どころを残す',
    /noteUnlockSource\(key, ownerKeyOf\(user\)\)/.test(net), '');

  const modes = read('public/js/modes.js');
  check('C-18 leaveOnlineOnSignOut がオンラインだけ畳む',
    /export function leaveOnlineOnSignOut/.test(modes) && /if \(!m \|\| !m\.client\) return false/.test(modes), '');

  const friends = read('public/js/friends.js');
  check('C-19 フレンド一覧の控えを捨てる口がある', /export function resetFriendsCache/.test(friends), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🚪 ログアウト・退会の後始末（端末側）  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
