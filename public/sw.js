// Block Blitz Arena — Service Worker
//
// ■ このファイルの役目（v2で変わったこと）
//   v1 は「圏外用の案内カードを1枚出すだけ」だった。実測すると、初回訪問だけの
//   人の控えは **4件（/ と css と manifest と icon-192）** しかなく、そのまま
//   圏外になると:
//     ・ナビゲーションは控えの index.html を返す（案内カードすら出ない）
//     ・しかし CSS 1本と **JS 25本が全部 Failed to fetch** になる
//   ＝ 画面はロゴのまま止まり、案内も出ない、という最悪の見え方になっていた。
//
//   v2 の目標は「1人用モードは圏外でも遊べる」。ゲームの中身（engine.js /
//   game.js / ai.js …）は全部ブラウザ側にあるので、**起動に要るファイルさえ
//   控えてあれば本当に遊べる**。
//
// ■ なぜ v1 は控えられなかったのか（推測ではなく実測した結論）
//   1. SW は main.js から `load` で登録される。つまり **初回訪問のモジュール
//      取得は1本も SW を通らない**。fetch で控える経路は2回目の起動からしか
//      効かない ── 初回に入れて圏外へ行った人は永久に何も持っていない。
//   2. `install` の事前キャッシュは `cache.add(u).catch(() => {})` で失敗を
//      握り潰していた。install は **SW のバイト列が変わるまで二度と走らない**
//      ので、たまたま電波の悪い瞬間に当たった人はそれきり控えを持たない。
//      補修する場所がどこにも無かった。
//   3. `cacheFirst` には**オフラインの逃げ道が無かった**。控えが無ければ
//      `await fetch(req)` がそのまま throw し、respondWith がネットワーク
//      エラーになる ＝ そのモジュールは読まれない。
//
// ■ v2 の作り
//   ・**import グラフを SW 自身が辿って**控える。サーバーは import 指定子に
//     `?v=<hash>` を焼き込むので、ここにファイル名を書き並べると版が変わった
//     瞬間に嘘になる。index.html の modulepreload を写すのも駄目で、
//     実際 clipexport.js は preload に載っていない（＝写すと1本足りない）。
//     配られた index.html → main.js → その import 先…と辿れば、常に「いま
//     本当に要るURL」だけが手に入る。
//   ・**失敗したら次の機会に必ず補修する**。全部そろった時だけ控え置き場に
//     「完了の印」を書き、印が無ければ activate でも・ページを開くたびでも・
//     main.js からの合図でも、もう一度やり直す。
//   ・**/api/ は絶対に控えない／返さない**。古い残高やランキングを本物として
//     出すのは、エラーを出すより悪い。
//   ・**結果の遅延再送（Background Sync）は入れない**。いまのサーバーの
//     POST /api/game/result は同じ回を2回受けると2回ぶん加算する。冪等キーが
//     入るまで再送を足してはいけない（オフライン中の記録の扱いは main.js 側で
//     「端末にだけ残る」と正直に伝える）。
const VERSION = 'v2';
const CACHE = `bba-shell-${VERSION}`;

// 「起動一式がそろった」印。中身は index.html の入口URL（＝版が変わると変わる）。
// 実在しないパスなので、ページから要求されることはない。
const READY_URL = '/__bba-shell-ready';

// import グラフから機械的に出せないもの（HTML から辿れない静的ファイル）。
// アイコンは manifest とホーム画面用。増減しても壊れないよう1件ずつ控える。
const EXTRA_SHELL = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
];

// 控えを作り直す入口。同時に2本走らせない（ページを何枚も開かれたとき用）。
let warming = null;

// ---------------------------------------------------------------------------
// オフライン案内カード
//
// 控えが1つも無い状態（インストール直後に一度も通信できていない）でしか
// 出ない最後の砦。第4波で絵文字を落としたので、ここは icons.js の絵を
// **インラインで写して**使う（sw.js は import できない）。
// 写したのは 'offline'（斜線入りの電波）と 'mode_solo'（4つのブロック）の2つ。
// icons.js は凍結ファイルなので、向こうを直したらここも手で合わせること。
// ---------------------------------------------------------------------------
const IC_OFFLINE = `<svg viewBox="0 0 24 24" width="34" height="34" style="--ic-a:#9fb0d4;--ic-b:#ff5d5d" aria-hidden="true">
  <path d="M12 18.8a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z" fill="var(--ic-a)"/>
  <path d="M6.6 11.6a8 8 0 0 1 10.8 0M3.2 8a12.6 12.6 0 0 1 17.6 0" fill="none" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>
  <path d="m3.6 3.6 16.8 16.8" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;
const IC_SOLO = `<svg viewBox="0 0 24 24" width="26" height="26" style="--ic-a:#5b8bff;--ic-b:#a8c0ff" aria-hidden="true">
  <rect x="3.4" y="3.4" width="7.6" height="7.6" rx="1.8" fill="var(--ic-a)"/>
  <rect x="13" y="3.4" width="7.6" height="7.6" rx="1.8" fill="var(--ic-b)"/>
  <rect x="3.4" y="13" width="7.6" height="7.6" rx="1.8" fill="var(--ic-b)"/>
  <rect x="13" y="13" width="7.6" height="7.6" rx="1.8" fill="var(--ic-a)"/>
</svg>`;

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Block Blitz Arena</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;padding:24px;
    background:radial-gradient(120% 100% at 50% 0%,#141a33,#0b0e1f 70%);
    color:#e7e9f2;font-family:'Segoe UI','Hiragino Sans','Noto Sans JP',system-ui,sans-serif;text-align:center}
  .card{max-width:360px;background:rgba(26,33,66,0.9);border:1px solid rgba(255,255,255,0.12);
    border-radius:22px;padding:26px;box-shadow:0 24px 60px rgba(0,0,0,0.6)}
  h1{font-size:20px;margin:12px 0 6px;line-height:1.4}
  p{font-size:13.5px;line-height:1.7;color:#9aa3c0;margin:0 0 8px}
  .note{display:flex;align-items:center;gap:9px;justify-content:center;
    margin:16px 0 4px;padding:11px 12px;border-radius:14px;
    background:rgba(91,139,255,0.12);border:1px solid rgba(91,139,255,0.3);
    font-size:12.5px;color:#c8d2ee;text-align:left;line-height:1.55}
  /* 幅の狭い端末（iPhone SE 375px）で絵だけが潰れないように。 */
  .note svg{flex:none}
  button{margin-top:16px;width:100%;min-height:44px;border:none;border-radius:16px;
    padding:12px 22px;font-size:16px;font-weight:800;color:#fff;cursor:pointer;
    font-family:inherit;background:linear-gradient(135deg,#6a9bff,#3f63e0);
    text-shadow:0 2px 4px rgba(0,0,0,0.45)}
</style></head>
<body><div class="card">
  ${IC_OFFLINE}
  <h1>オフラインです<br>You're offline</h1>
  <p>このゲームは一度オンラインで開いておくと、次からは圏外でも1人用モードが遊べます。<br>
     まだ準備ができていないので、通信が戻ったら一度開いてください。</p>
  <p>Open this game once while online and solo modes will work offline from then on.<br>
     It isn't ready yet — please open it again when your connection returns.</p>
  <div class="note">${IC_SOLO}<span>準備が済むと、ソロプレイ・AI対戦・ダンジョンなどは通信なしで遊べます。<br>Once ready: Solo, VS AI, Dungeon and more play with no connection.</span></div>
  <button onclick="location.reload()">再読み込み / Reload</button>
</div></body></html>`;

function offlineCard() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 控えてよい応答だけを控える（自分のサーバーの 200 のみ）。
function cacheable(res) {
  return !!res && res.status === 200 && (res.type === 'basic' || res.type === 'default');
}

async function put(req, res) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(req, res);
  } catch { /* 容量不足などは黙って諦める（表の動きは変えない） */ }
}

// ---------------------------------------------------------------------------
// 起動一式をそろえる
// ---------------------------------------------------------------------------

// index.html の中から、実際に読まれるURLを拾う。
// サーバー(server/index.js buildAssetHashes)が ?v=<hash> を焼き込んだあとの
// 文字列なので、ここで拾えば版数まで込みで正しい。
function shellUrlsFromHtml(html, base) {
  const abs = (u) => new URL(u, base).href;
  const out = { css: null, main: null, preload: [] };
  const css = html.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/i);
  if (css) out.css = abs(css[1]);
  const main = html.match(/<script\b[^>]*\bsrc="([^"]*main\.js[^"]*)"/i);
  if (main) out.main = abs(main[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/gi)) {
    out.preload.push(abs(m[1]));
  }
  return out;
}

// main.js から import を辿って、起動に要る js を全部集める。
//
// ⚠ ここでファイル名を列挙してはいけない理由（実測）:
//   index.html の <link rel="modulepreload"> は 23本だが、実際の import グラフは
//   25本ある（clipexport.js が preload に載っていない）。1本でも欠けると
//   オフラインの起動はそこで止まるので、「書き写す」方式は必ずいつか嘘になる。
//   静的な from 節と動的 import の両方を拾う（どちらも ?v= 付きで配られる）。
//   ※ この正規表現は sw.js 自身のソースにも当たるので、ここに import の見本を
//     文字列で書かないこと（test/syntax.test.mjs が「実在しない import 先」
//     として拾ってしまう）。
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

async function crawlModules(entryUrl, cache, origin) {
  const seen = new Set();
  const queue = [entryUrl];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!cacheable(res)) throw new Error('module fetch failed: ' + url);
    const text = await res.clone().text();
    await cache.put(url, res);
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      // 相対・絶対どちらでも、.js で終わるもの（?v= 付きを含む）だけを追う。
      if (!/\.js(\?|$)/.test(spec)) continue;
      let abs;
      try { abs = new URL(spec, url).href; } catch { continue; }
      if (abs.startsWith(origin) && !seen.has(abs)) queue.push(abs);
    }
  }
  return seen;
}

/**
 * 起動一式を控える。**全部そろったときだけ**完了の印を書く。
 * 途中で1つでも落ちたら印を書かない ＝ 次の機会に必ずやり直される。
 */
async function warmShell() {
  const origin = self.location.origin;
  const cache = await caches.open(CACHE);

  // index.html は毎回ネットワークから取り直す（版数の焼き込みが変わるため）。
  const indexRes = await fetch(new URL('/', origin).href, {
    cache: 'reload', credentials: 'same-origin',
  });
  if (!cacheable(indexRes)) throw new Error('index fetch failed');
  const html = await indexRes.clone().text();
  await cache.put('/', indexRes);

  const found = shellUrlsFromHtml(html, origin);
  if (!found.main) throw new Error('main.js not found in index.html');

  const keep = new Set([new URL('/', origin).href]);

  // CSS。?v= 付きのURLと、素のURLの両方を控える。
  // （サーバーが版数を出せなかったときは素のURLで配られるため。）
  if (found.css) {
    const res = await fetch(found.css, { credentials: 'same-origin' });
    if (!cacheable(res)) throw new Error('css fetch failed');
    await cache.put(found.css, res);
    keep.add(found.css);
  }

  // js は import グラフを辿って集める。preload に載っているものも保険で足す。
  const mods = await crawlModules(found.main, cache, origin);
  for (const u of mods) keep.add(u);
  for (const u of found.preload) {
    if (keep.has(u)) continue;
    try {
      const res = await fetch(u, { credentials: 'same-origin' });
      if (cacheable(res)) { await cache.put(u, res); keep.add(u); }
    } catch { /* preload は保険。落ちても起動には要らない */ }
  }

  // manifest とアイコン。ここが欠けても遊べるので、失敗しても印は書く。
  for (const p of EXTRA_SHELL) {
    const u = new URL(p, origin).href;
    keep.add(u);
    try {
      const res = await fetch(u, { credentials: 'same-origin' });
      if (cacheable(res)) await cache.put(u, res);
    } catch { /* 絵が1枚無いだけ */ }
  }

  // 古い版の js / css を捨てる。更新のたびに 25本ずつ積み増すと、
  // 端末の容量を静かに食い潰して、そのうち控えごと消される。
  try {
    for (const req of await cache.keys()) {
      if (keep.has(req.url)) continue;
      const p = new URL(req.url).pathname;
      if (p === READY_URL) continue;
      if (p.startsWith('/js/') || p.startsWith('/css/')) await cache.delete(req);
    }
  } catch { /* 掃除に失敗しても動きは変わらない */ }

  // ここまで来て初めて「そろった」。印の中身は入口URL（版が変わると変わる）。
  await cache.put(READY_URL, new Response(found.main, {
    headers: { 'Content-Type': 'text/plain' },
  }));
  return found.main;
}

/**
 * 配られた index.html を見て、控えが「いまの版」かどうかを確かめる。
 *
 * なぜ要るか: 印だけ見ていると、更新が出たあとも「そろっている」と判断して
 * 作り直さない。すると navigateFirst が **新しい** index.html を控えに書き、
 * モジュールは **古い** ままという混ざった状態が残る。そのまま圏外になると、
 * 新しい ?v= の要求は控えに無い ── cacheFirst の ignoreSearch の逃げ道で
 * 一世代前を返して辛うじて起動する、という綱渡りになってしまう。
 * ページを開いたときに気づいて作り直しておけば、その綱渡りに乗らずに済む。
 *
 * 追加の通信はしない（navigateFirst が既に取ってきた応答の写しを使う）。
 */
async function reviewShell(res) {
  try {
    const html = await res.text();
    const found = shellUrlsFromHtml(html, self.location.origin);
    if (!found.main) return false;
    const ready = await shellReadyFor();
    if (ready === found.main) return true;     // そろっていて、版も同じ
    return await ensureShell(true);
  } catch {
    return false;                              // 次にページを開いたときに再挑戦
  }
}

/** 印を読む。まだそろっていなければ null。 */
async function shellReadyFor() {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(READY_URL);
    return hit ? await hit.text() : null;
  } catch { return null; }
}

/**
 * 補修の入口。install が失敗していても、activate・ページを開いた時・
 * main.js からの合図、のどれかで必ずここに戻ってくる。
 * @param {boolean} force 印があってもやり直す（main.js からの合図用）。
 */
function ensureShell(force = false) {
  if (warming) return warming;
  warming = (async () => {
    try {
      if (!force && await shellReadyFor()) return true;
      await warmShell();
      return true;
    } catch {
      // 落ちた＝印は書かれていない。次の機会にまたここへ来る。
      return false;
    } finally {
      warming = null;
    }
  })();
  return warming;
}

// ---------------------------------------------------------------------------
// 取り出し方
// ---------------------------------------------------------------------------

// 版数つきURL（?v=…）は「中身が変わったらURLも変わる」約束なので控えが先でよい。
//
// ⚠ 控え置き場の読み取りが失敗しても、**絶対にここで throw しないこと**。
//   index.html が読む唯一の入口 <script type="module" src="js/main.js?v=…">
//   がこの経路を通る。ここが reject すると respondWith がネットワークエラーに
//   なり、main.js が読まれない ＝ **画面がロゴのまま止まり、コンソールには
//   net::ERR_FAILED が1行出るだけ**という、原因の分からない全損になる。
//   caches が使えない端末（プライベートウィンドウ、サイトデータを塞いだ設定、
//   容量逼迫）では現実に読み取りが投げる。控えは「あれば得をするもの」に
//   留めて、落ちたら素のネットワークへ抜ける。
async function cacheFirst(req) {
  try {
    const hit = await caches.match(req);
    if (hit) return hit;
  } catch { /* 控えが読めないだけ。ネットワークで取り直せばよい */ }
  try {
    const res = await fetch(req);
    if (cacheable(res)) put(req, res.clone());
    return res;
  } catch (err) {
    // ここが v1 に無かった逃げ道。
    // 圏外で、しかも版数がズレている（更新の直後に控えが間に合わなかった）
    // ときの最後の手段として、?v= を無視して同じパスの控えを返す。
    // 版が混ざる危険はあるが、**圏外では「起動しない」が確定の負け**なので、
    // 一世代前で丸ごとそろっているほうがましだと判断した。
    // ※ ふだん（オンライン）は上の fetch が成功するので、ここは通らない。
    try {
      const stale = await caches.match(req, { ignoreSearch: true });
      if (stale) return stale;
    } catch { /* ignore */ }
    throw err;
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

// ページそのもの。落ちたら控えの index、それも無ければオフラインの1枚。
//
// onHtml には応答の**写し**を渡す（版数の確認用）。写しを作るのはここ ──
// 呼び出し側で body を読んでから clone しようとすると、既に読まれた応答は
// clone できずに投げる。
async function navigateFirst(req, onHtml) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) {
      put('/', res.clone());
      if (onHtml) { try { onHtml(res.clone()); } catch { /* 確認は諦める */ } }
    }
    return res;
  } catch {
    const hit = await caches.match('/', { ignoreSearch: true });
    return hit || offlineCard();
  }
}

// ---------------------------------------------------------------------------
// ライフサイクル
// ---------------------------------------------------------------------------

self.addEventListener('install', event => {
  self.skipWaiting();
  // ここで失敗しても install は成功させる（activate させないと補修もできない）。
  event.waitUntil(ensureShell().catch(() => {}));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    } catch { /* ignore */ }
    await self.clients.claim();
    // install が落ちていたらここで取り返す（印が無いときだけ走る）。
    await ensureShell().catch(() => {});
  })());
});

// main.js が起動しきったあとに送ってくる合図。
// **いちばん確実な補修点**: このメッセージが届いた＝ページは現に動いていて、
// import グラフも取得できる状態だと分かっている。
self.addEventListener('message', event => {
  const data = event && event.data;
  if (!data || data.type !== 'bba-warm') return;
  event.waitUntil(ensureShell(!!data.force).catch(() => {}));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // API と自分自身は素通し。控えた残高やランキングを本物として出さない。
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  // 完了の印は内部用。ページから要求される筋合いは無いので素通しでよい。
  if (url.pathname === READY_URL) return;

  if (req.mode === 'navigate') {
    // ページを開くたびに:
    //   ・まだそろっていなければ補修する
    //     （install が電波の悪い瞬間に当たった人を、ここで必ず拾い直す）
    //   ・更新が出ていれば控えを作り直す（reviewShell）
    // どちらも返事は待たせない。waitUntil で SW が途中で殺されないようにする。
    const jobs = [];
    const answer = navigateFirst(req, copy => jobs.push(reviewShell(copy)));
    event.respondWith(answer);
    event.waitUntil(answer
      .then(() => (jobs.length ? jobs[0] : ensureShell()), () => ensureShell())
      .catch(() => {}));
    return;
  }
  if (url.searchParams.has('v')) { event.respondWith(cacheFirst(req)); return; }
  event.respondWith(networkFirst(req));
});
