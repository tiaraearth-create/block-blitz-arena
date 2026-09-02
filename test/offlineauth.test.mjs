// リポジトリのルートから:  node test/offlineauth.test.mjs
//
// 📴 「オフラインでもアカウントは登録されたままに見えるか」と、
//    「その控えで管理者になれないか」を見張る。
//
// ■ 何が起きていたか
//   session.token は通信が落ちても捨てない（失敗経路は net.js の
//   setToken(null) を通らない）ので、つながれば自動でログイン状態に戻る。
//   ところが起動時の refreshMe()（/api/me）が通らないあいだ session.user は
//   null のままで、updateTopbar() がそれを「未ログイン」として描いていた ──
//   名前が「ゲスト」、コインとジェムが 0、レベルは非表示。しかも起動時は
//   9秒×6回＝約54秒 粘るので、圏外の人は1分近く「勝手にログアウトさせられた
//   画面」を見せられていた。
//   直し方は「最後に取れた自分の情報を控えて、オフラインではそれを見せる」。
//
// ■ このテストが本当に守りたいもの
//   控えは localStorage にあり、**本人がいくらでも書き換えられる**。
//   だから「表示は戻す・権限は戻さない」が守れているかを、ソースを読むだけ
//   ではなく **dom.js を実際に動かして** 確かめる（localStorage も DOM も
//   ここで用意した器で代用する。dom.js には一切手を入れない）。
//   1. 控えから復元したユーザーで staffExtras() が false
//   2. 控えに role:'admin' と書き込んでも管理者UIが出ない
//   3. 通信失敗でトークンが捨てられない（既存の約束の回帰検査）

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

// ===========================================================================
// 器（localStorage / 最小の DOM）
//
// public/js は素のままブラウザへ配られるので、ここでも「ブラウザにあるもの」
// だけを足して素の dom.js を読み込む。差し替えは import より前でなければ
// ならないので、下は全部 await import() の前に置いてある。
// ===========================================================================

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
  const el = {
    id, tagName: tag,
    textContent: '', innerHTML: '', title: '',
    style: { cssText: '', opacity: '' },
    dataset: {},
    attrs: {},
    children: [],
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); if (c && c.id) ELEMS.set(c.id, c); return c; },
    append(...xs) { for (const x of xs) this.children.push(typeof x === 'object' ? x : { text: String(x) }); },
    replaceChildren(...xs) { this.children = []; this.append(...xs); },
    insertAdjacentHTML(_pos, html) { this.children.push({ html: String(html) }); },
    insertAdjacentElement(_pos, node) { this.children.push(node); return node; },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    remove() {},
  };
  return el;
}

/** 要素にぶら下がっている文字（append されたテキストノード）を1本につなぐ。 */
const textOf = el => (el ? el.children.filter(c => c && c.text).map(c => c.text).join('') : '');
/** 要素にぶら下がっている HTML 片（insertAdjacentHTML）を1本につなぐ。 */
const htmlOf = el => (el ? el.children.filter(c => c && c.html).map(c => c.html).join('') : '');

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
  addEventListener: () => {},
  body: makeEl('body', 'BODY'),
  activeElement: null,
});
// setInterval を握っておく理由は2つ。
//  ・本物だと 30 秒ごとの見張りが立ってテストのプロセスが終われない
//  ・「通信が戻ったら本物で上書きする」見張りが本当に張られたかを見たい
const intervals = [];
defineGlobal('setInterval', (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; });
defineGlobal('clearInterval', h => { const i = intervals.indexOf(h); if (i >= 0) intervals.splice(i, 1); });
defineGlobal('window', {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
});

const { session, setToken } = await import('../public/js/net.js');
const dom = await import('../public/js/dom.js');
const { updateTopbar, staffExtras, usingCachedUser, clearCachedUser } = dom;

const CACHE_KEY = 'bba_me_cache';
const cacheRaw = () => LS.getItem(CACHE_KEY);
const cacheObj = () => { try { return JSON.parse(cacheRaw() || 'null'); } catch { return null; } };

/** 本物の user（サーバーの publicUser の形。ここでは運営アカウントにしてある）。 */
const realAdmin = () => ({
  id: 'u-admin', username: 'ちあら', role: 'admin',
  coins: 1234, gems: 56, xp: 6500, level: 7, shards: 3,
  social: { friends: 2, pending: 0 },
  stats: { bestScore: 98765, rating: 1500, gamesPlayed: 40, history: [{ m: 'solo', s: 1 }] },
  owned: ['theme_a'], equipped: { theme: 'theme_a' }, items: { item_bomb: 2 },
  battlePass: { season: 1, xp: 10, premium: true, claimed: [] },
  badges: ['gold'], achievements: ['first'], equippedTitle: null,
  rankRewards: [{ week: 1, coins: 500 }], thrones: [], guild: null,
});

/**
 * 「アプリを開き直した」状態を作る。
 * 控え（localStorage）は残したまま、dom.js 側の1回きりの復元をやり直させる。
 */
function reopen({ token = 'tok-1', keepCache = true } = {}) {
  const snap = keepCache ? cacheRaw() : null;
  clearCachedUser();               // cachedUserObj と「復元は1回だけ」の印を戻す
  session.user = null;
  session.token = token;
  if (snap) LS.setItem(CACHE_KEY, snap);
}

// ===========================================================================
// A. いままでどおりの振る舞い（控えが無いとき）
// ===========================================================================
reopen({ keepCache: false });
updateTopbar();
check('控えが無ければ今までどおり「ゲスト」', ELEMS.get('userName').textContent === 'ゲスト',
  ELEMS.get('userName').textContent);
check('  └ 控えが無いのに控えを描いたことにしない', usingCachedUser() === false, '');

// ===========================================================================
// B. 本物を描いたら、表示用の写しが残る
// ===========================================================================
session.user = realAdmin();
updateTopbar();
const saved = cacheObj();
check('本物を描くと控えが残る', !!saved && !!saved.user && saved.user.username === 'ちあら',
  saved ? String(saved.user && saved.user.username) : 'なし');
check('  └ 名前・レベル・残高が入っている',
  !!saved && saved.user.level === 7 && saved.user.coins === 1234 && saved.user.gems === 56, '');
check('  └ 🔒 権限（role:admin）は控えに残さない',
  !!saved && saved.user.role !== 'admin' && saved.user.role !== 'mod', saved ? String(saved.user.role) : '');
check('  └ 受け取り待ちの報酬（rankRewards）は控えない',
  !!saved && saved.user.rankRewards === undefined, '');
check('  └ 本物を描いているあいだは「控え」ではない', usingCachedUser() === false, '');
check('  └ 本物なら管理者UIが出る（この検査自体が効いていることの確認）',
  staffExtras() === true && ELEMS.get('btnAdmin').classList.contains('hidden') === false, '');
check('  └ 本物の残高に ~ は付かない', ELEMS.get('coinsLabel').textContent.indexOf('~') === -1,
  ELEMS.get('coinsLabel').textContent);

// ===========================================================================
// C. オフラインで開き直す ── 54秒待たずに控えで描く
// ===========================================================================
reopen();
updateTopbar();
check('オフラインでも「ゲスト」にならない', ELEMS.get('userName').textContent === 'ちあら',
  ELEMS.get('userName').textContent);
check('  └ レベルが出る',
  ELEMS.get('userLevel').textContent === 'Lv.7'
  && ELEMS.get('userLevel').classList.contains('hidden') === false,
  ELEMS.get('userLevel').textContent);
check('  └ 控えを描いていると自覚している', usingCachedUser() === true, '');
check('  └ 🔒 控えから復元したユーザーで staffExtras() が false', staffExtras() === false, '');
check('  └ 🔒 復元したユーザーの role は落ちている',
  !!session.user && session.user.role !== 'admin' && session.user.role !== 'mod',
  session.user ? String(session.user.role) : 'null');
check('  └ 🔒 管理ボタンは出ない', ELEMS.get('btnAdmin').classList.contains('hidden') === true, '');
check('  └ 受け取り待ちの報酬は復活しない',
  Array.isArray(session.user.rankRewards) && session.user.rankRewards.length === 0, '');

// 「最後に見た値」だと分かる印（残高をそのまま信じさせない）
check('残高に「最後に見た値」の印が付く',
  ELEMS.get('coinsLabel').textContent.startsWith('~') && ELEMS.get('gemsLabel').textContent.startsWith('~'),
  `${ELEMS.get('coinsLabel').textContent} / ${ELEMS.get('gemsLabel').textContent}`);
check('  └ 印の理由が読める（title）',
  /オフライン/.test(ELEMS.get('coinsLabel').getAttribute('title') || ''),
  ELEMS.get('coinsLabel').getAttribute('title') || 'なし');
{
  const tag = ELEMS.get('staleTag');
  check('オフライン表示の札が出る', !!tag && tag.classList.contains('hidden') === false, tag ? '' : 'なし');
  check('  └ 札に絵と言葉の両方がある（読み上げに何も残らない、を避ける）',
    !!tag && /<svg/.test(htmlOf(tag)) && textOf(tag).length > 0, tag ? textOf(tag) : '');
}
check('通信が戻ったか見に行く見張りが張られる', intervals.length >= 1, `${intervals.length}本`);

// ===========================================================================
// D. 控えを書き換えても管理者にはなれない（いちばん大事な検査）
// ===========================================================================
{
  // 端末の localStorage を直接いじった人を作る。
  LS.setItem(CACHE_KEY, JSON.stringify({
    v: 1, at: Date.now(),
    user: {
      id: 'u-fake', username: 'にせ運営', role: 'admin', level: 99,
      coins: 99999999, gems: 99999999,
      rankRewards: [{ week: 99, coins: 1000000 }],
      stats: { bestScore: 1, rating: 1 },
    },
  }));
  reopen();
  updateTopbar();
  check('🔒 控えに role:"admin" と書いても staffExtras() は false', staffExtras() === false, '');
  check('🔒 控えに role:"admin" と書いても session.user.role は admin にならない',
    session.user.role !== 'admin', String(session.user.role));
  check('🔒 控えに role:"admin" と書いても管理ボタンは出ない',
    ELEMS.get('btnAdmin').classList.contains('hidden') === true, '');
  check('🔒 控えの rankRewards は受け取り待ちとして復活しない',
    Array.isArray(session.user.rankRewards) && session.user.rankRewards.length === 0, '');
  check('  └ 名前は控えのものが出る（表示だけは戻す、が守れている）',
    ELEMS.get('userName').textContent === 'にせ運営', ELEMS.get('userName').textContent);
  check('  └ 残高は「最後に見た値」の印つきで出る',
    ELEMS.get('coinsLabel').textContent.startsWith('~'), ELEMS.get('coinsLabel').textContent);
}

// ===========================================================================
// D2. 控えは端末から来る文字列。形が変でも画面に流さない
// ===========================================================================
{
  LS.setItem(CACHE_KEY, JSON.stringify({
    v: 1, at: Date.now(),
    user: {
      id: 'u-x', username: '<img src=x onerror="boom()">とても長すぎる名前',
      level: 2, coins: 1, gems: 1, stats: { bestScore: 1 },
    },
  }));
  reopen();
  updateTopbar();
  const shown = ELEMS.get('userName').textContent;
  // screens.js の showProfileModal() は名前を見出しへ **生のまま** 差し込む。
  // サーバー経由の名前は 2〜16文字の英数字・日本語しか通らないが、控えは
  // 端末から来るので、ここで同じところまで絞る。
  check('控えの名前から記号が落ちる', !/[<>&"'`\\]/.test(shown), shown);
  check('  └ 長さも切られる（16文字まで）', shown.length > 0 && shown.length <= 16, `${shown.length}文字: ${shown}`);
}
{
  // 戦績の入っていない控えは、こちらが書いたものではない（＝手で作られた）。
  // 空の器を渡すと画面のあちこちが fmt(undefined) で「NaN」になる。
  LS.setItem(CACHE_KEY, JSON.stringify({
    v: 1, at: Date.now(),
    user: { id: 'u-y', username: 'からっぽ', level: 1, coins: 1, gems: 1 },
  }));
  reopen();
  updateTopbar();
  check('戦績の無い控えは使わない（画面が NaN にならない）',
    ELEMS.get('userName').textContent === 'ゲスト' && usingCachedUser() === false,
    ELEMS.get('userName').textContent);
}

// ===========================================================================
// E. 通信が戻ったら本物で上書きされる
// ===========================================================================
session.user = realAdmin();          // refreshMe() が本物を入れたのと同じ状態
updateTopbar();
check('通信が戻れば控えではなくなる', usingCachedUser() === false, '');
check('  └ 権限も戻る', staffExtras() === true, '');
check('  └ 管理ボタンが戻る', ELEMS.get('btnAdmin').classList.contains('hidden') === false, '');
check('  └ 残高の ~ が消える', ELEMS.get('coinsLabel').textContent.indexOf('~') === -1,
  ELEMS.get('coinsLabel').textContent);
check('  └ オフライン表示の札が引っ込む',
  ELEMS.get('staleTag').classList.contains('hidden') === true, '');
check('  └ 控えは本物で上書きされている',
  (cacheObj() || {}).user.username === 'ちあら', '');
{
  // 見張りは、本物が入ったら自分で止まる。
  const before = intervals.length;
  for (const h of [...intervals]) h.fn();
  check('見張りは本物が入ったら止まる', intervals.length < before || before === 0,
    `${before} → ${intervals.length}`);
}
{
  // 運営は残高が ∞ 表示なので、~ が消えたことの証拠にならない。
  // ふつうのプレイヤーでも数字がそのまま出ることを確かめる。
  session.user = { ...realAdmin(), id: 'u-player', username: 'ふつうの人', role: 'user' };
  updateTopbar();
  check('  └ ふつうのプレイヤーでも本物なら数字がそのまま出る',
    ELEMS.get('coinsLabel').textContent === '1,234' && staffExtras() === false,
    ELEMS.get('coinsLabel').textContent);
}

// ===========================================================================
// F. ログアウトしたら控えも消える（次に開いた人に前の人が見えない）
// ===========================================================================
setToken(null);
session.user = null;
updateTopbar();
check('ログアウトで控えが消える', cacheRaw() === null, cacheRaw() || '');
check('  └ 表示も「ゲスト」に戻る', ELEMS.get('userName').textContent === 'ゲスト',
  ELEMS.get('userName').textContent);
check('  └ 控えが無いので復元もされない', usingCachedUser() === false, '');

// ===========================================================================
// G. 古すぎる控えは使わない
// ===========================================================================
LS.setItem(CACHE_KEY, JSON.stringify({
  v: 1, at: Date.now() - 400 * 24 * 60 * 60 * 1000,   // 400日前（サーバーのセッションより古い）
  user: { id: 'u-old', username: 'むかしの人', level: 3, coins: 1, gems: 1, stats: {} },
}));
reopen();
updateTopbar();
check('期限切れの控えは使わない', ELEMS.get('userName').textContent === 'ゲスト',
  ELEMS.get('userName').textContent);

// ===========================================================================
// H. トークンが無いときは控えを見に行かない
// ===========================================================================
LS.setItem(CACHE_KEY, JSON.stringify({
  v: 1, at: Date.now(),
  user: { id: 'u1', username: 'だれか', level: 5, coins: 10, gems: 10, stats: {} },
}));
reopen({ token: null });
updateTopbar();
check('トークンが無ければ控えを描かない（ログインしていない人に他人が出ない）',
  ELEMS.get('userName').textContent === 'ゲスト' && usingCachedUser() === false,
  ELEMS.get('userName').textContent);

// ===========================================================================
// I. ソース検査 ── 既存の約束の回帰
// ===========================================================================
const NET_SRC = read('public/js/net.js');
const DOM_SRC = read('public/js/dom.js');
const MAIN_SRC = read('public/js/main.js');

// 1) 通信失敗でトークンを捨てない。
//    net.js は setToken を **定義するだけ** で、自分では一度も呼ばない
//    （呼ぶのはログイン・ログアウト・401/403 を見た画面側）。ここに
//    setToken(null) が生えた瞬間、圏外＝ログアウトに逆戻りする。
{
  // 定義（export function setToken(...)）は数えない。数えたいのは呼び出し。
  const calls = [...NET_SRC.matchAll(/(?<!function\s)setToken\s*\(/g)];
  check('net.js は setToken() を自分から呼ばない（通信失敗でトークンを捨てない）',
    calls.length === 0, `${calls.length}箇所`);
  // api() の中（＝タイムアウトも fetch 失敗もここに落ちる）が、控えを積む以外に
  // セッションへ手を出していないこと。関数まるごとを見るので、中の書き方が
  // 変わっても壊れない。
  const apiFn = NET_SRC.match(/export async function api\([\s\S]*?\n\}/);
  check('  └ api() の失敗経路がセッションを消さない',
    !!apiFn && !/setToken|session\.token\s*=/.test(apiFn[0]),
    apiFn ? '' : 'api() が見つからない — このテストを実装に合わせて直すこと');
}

// 2) 画面側がトークンを捨てるのは「サーバーが本当に断った(401/403)」ときと
//    「本人が押した」ときだけ。時間切れ(status 0)で捨てていないか。
{
  const bad = [];
  for (const m of MAIN_SRC.matchAll(/setToken\(null\)/g)) {
    const before = MAIN_SRC.slice(Math.max(0, m.index - 300), m.index);
    if (!/401|403|rfRestart|Logout|logout/.test(before)) bad.push(MAIN_SRC.slice(Math.max(0, m.index - 60), m.index + 20).replace(/\s+/g, ' '));
  }
  check('main.js がトークンを捨てるのは 401/403 か本人の操作だけ', bad.length === 0, bad.slice(0, 2).join(' | '));
}

// 3) 控えの作り。ここが緩むと「localStorage を書き換えるだけで管理者UI」に戻る。
check('dom.js: 控えに権限を書かない（保存時に role を落とす）',
  /copy\.role\s*=\s*'player'/.test(DOM_SRC), '');
check('dom.js: 復元時にも role を落とす（書き換えられた控えへの2枚目の守り）',
  /me\.role\s*=\s*'player'/.test(DOM_SRC), '');
check('dom.js: staffExtras() が「控えかどうか」を見ている',
  /export function staffExtras\(\)[\s\S]{0,400}?usingCachedUser\(\)/.test(DOM_SRC), '');
check('dom.js: 「控えかどうか」は localStorage の目印ではなく object の同一性で見る',
  /session\.user === cachedUserObj/.test(DOM_SRC), '');
// 控えに写す欄は明示の一覧。丸ごと保存に戻ると、あとから増えた欄まで
// 黙って端末に平文で置くことになる。
{
  const m = DOM_SRC.match(/const USER_CACHE_FIELDS = \[([\s\S]*?)\];/);
  const fields = m ? [...m[1].matchAll(/'([\w]+)'/g)].map(x => x[1]) : [];
  check('dom.js: 控えに写す欄が一覧で決まっている', fields.length > 0, `${fields.length}欄`);
  check('  └ role と rankRewards は一覧に入っていない',
    !fields.includes('role') && !fields.includes('rankRewards'), fields.join(','));
  // 🎭 このプロジェクトの最優先事項。控えは端末に平文で残るので、住人まわりの
  //    欄が紛れ込んでいないかをここでも見る（server/sanitize.js と同じ気持ち）。
  const secret = fields.filter(f => /^(isBot|resident|persona|bot)$/i.test(f));
  check('  └ 住人（AI）まわりの欄が紛れていない', secret.length === 0, secret.join(','));
}
check('dom.js: 控えには上限（寿命）がある', /USER_CACHE_TTL_MS/.test(DOM_SRC), '');

// 4) 数字を並べる画面でも「最後に見た値」だと断っていること。
//    トップバーだけだと、プロフィールと戦績ダッシュボード（ハイスコア・レート・
//    コイン）は今の値のように読めてしまう。
{
  const SCREENS_SRC = read('public/js/screens.js');
  const notes = [...SCREENS_SRC.matchAll(/\$\{staleNote\(\)\}/g)].length;
  check('screens.js: プロフィールと戦績で「最後に受け取った情報」だと断っている',
    /usingCachedUser\(\)/.test(SCREENS_SRC) && notes >= 2, `${notes}箇所`);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
console.log('');
const ng = results.filter(r => r[0] === '❌').length;
console.log(ng ? `❌ ${ng} / ${results.length} 件が失敗` : `✅ 全 ${results.length} 件が成功`);
