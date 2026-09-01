// Block Blitz Arena — Service Worker
//
// なぜ要るか: manifest が display:standalone なので、ホーム画面に入れた人は
// ブラウザのUIを持たないアプリとして起動する。そこで圏外だと、これまでは
// アプリの外観のまま「接続できません」というブラウザ既定の画面になっていた
// （戻る導線もブランドも無い行き止まり）。
//
// 方針は「ネットワークを先に、控えは落ちたときだけ」。
//  ・更新の届き方を今までと変えない。サーバーは js を no-cache で配り、
//    版数つき（?v=…）だけを immutable にしている ── その約束をそのまま踏襲する。
//  ・/api/ は絶対に控えを返さない。古い残高やランキングを本物として出すのは、
//    エラーを出すより悪い。
//  ・結果送信の遅延再送（Background Sync）はここには入れない。いまのサーバーは
//    同じ run を2回加算するので、冪等キーが入るまで足してはいけない。
const CACHE = 'bba-shell-v1';

// 起動に最低限要るもの。js は版数つきURLで変わるので、実際に読まれたものを
// 走りながら控える（ここに列挙すると版が変わった瞬間に嘘になる）。
const SHELL = ['/', '/css/style.css', '/manifest.webmanifest', '/icons/icon-192.png'];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Block Blitz Arena</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;padding:24px;
    background:radial-gradient(120% 100% at 50% 0%,#141a33,#0b0e1f 70%);
    color:#e7e9f2;font-family:'Segoe UI','Hiragino Sans','Noto Sans JP',system-ui,sans-serif;text-align:center}
  .card{max-width:340px;background:rgba(26,33,66,0.9);border:1px solid rgba(255,255,255,0.12);
    border-radius:22px;padding:26px;box-shadow:0 24px 60px rgba(0,0,0,0.6)}
  .blocks span{display:inline-block;width:20px;height:20px;border-radius:5px;margin:0 3px}
  h1{font-size:20px;margin:14px 0 6px}
  p{font-size:14px;line-height:1.6;color:#9aa3c0;margin:0 0 6px}
  button{margin-top:18px;width:100%;min-height:44px;border:none;border-radius:16px;
    padding:12px 22px;font-size:16px;font-weight:800;color:#fff;cursor:pointer;
    font-family:inherit;background:linear-gradient(135deg,#6a9bff,#3f63e0);
    text-shadow:0 2px 4px rgba(0,0,0,0.45)}
</style></head>
<body><div class="card">
  <div class="blocks"><span style="background:#ff5d5d"></span><span style="background:#5b8bff"></span><span style="background:#ffe14d"></span><span style="background:#5ee86e"></span></div>
  <h1>📴 オフラインです<br>You're offline</h1>
  <p>通信が戻ったら、続きから遊べます。</p>
  <p>Everything is waiting for you — come back when the connection returns.</p>
  <button onclick="location.reload()">🔄 再読み込み / Reload</button>
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

// 版数つきURL（?v=…）は「中身が変わったらURLも変わる」約束なので控えが先でよい。
//
// ⚠ 控え置き場の読み取りが失敗しても、**絶対にここで throw しないこと**。
//   index.html が読む唯一の入口 <script type="module" src="js/main.js?v=…">
//   がこの経路を通る。ここが reject すると respondWith がネットワークエラーに
//   なり、main.js が読まれない ＝ **画面がロゴのまま止まり、コンソールには
//   net::ERR_FAILED が1行出るだけ**という、原因の分からない全損になる。
//   （v2.34 の点検中に「?v= の付いた要求だけが全部 Failed to fetch になり、
//    メニューのボタンが1つも配線されない」状態を実際に踏んだ。あのときの
//    直接の原因は自動操作ブラウザ側の制限で caches ではなかったが、
//    「入口が1つの経路に頼っていて、その経路が黙って落ちる」という形は同じ。）
//   caches が使えない端末（プライベートウィンドウ、サイトデータを塞いだ設定、
//   容量逼迫）では現実に読み取りが投げる。控えは「あれば得をするもの」に
//   留めて、落ちたら素のネットワークへ抜ける。
async function cacheFirst(req) {
  try {
    const hit = await caches.match(req);
    if (hit) return hit;
  } catch { /* 控えが読めないだけ。ネットワークで取り直せばよい */ }
  const res = await fetch(req);
  if (cacheable(res)) put(req, res.clone());
  return res;
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
async function navigateFirst(req) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) put('/', res.clone());
    return res;
  } catch {
    const hit = await caches.match('/', { ignoreSearch: true });
    return hit || offlineCard();
  }
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      // 1つでも落ちたら全部失敗する addAll は使わない（icons が増減しても壊れない）。
      await Promise.all(SHELL.map(u => cache.add(u).catch(() => {})));
    } catch { /* 控えを作れなくても、ネットワークがあれば普通に動く */ }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    } catch { /* ignore */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // API と自分自身は素通し。控えた残高やランキングを本物として出さない。
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') { event.respondWith(navigateFirst(req)); return; }
  if (url.searchParams.has('v')) { event.respondWith(cacheFirst(req)); return; }
  event.respondWith(networkFirst(req));
});
