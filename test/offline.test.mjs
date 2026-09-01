// リポジトリのルートから:  node test/offline.test.mjs
//
// 「オフラインでもこのゲームは遊べるか」を見張る。
//
// ■ なぜソース検査だけにしないのか
//   v1 の sw.js は、読むかぎりでは正しく見えた（SHELL を事前キャッシュし、
//   ?v= 付きは cacheFirst で控える）。ところが実測すると、初回訪問しかして
//   いない人の控えは **4件** しか無く、そのまま圏外になると CSS 1本と JS 25本が
//   全部 Failed to fetch になっていた。理由は「SW は load で登録されるので
//   初回のモジュール取得は1本も SW を通らない」から ── ソースを読んでも
//   出てこない、実行順の話だった。
//   なので、このテストは **本物の sw.js を本物のサーバー相手に走らせて**、
//   控えの中身を数え、そのうえで通信を落として起動できるかを見る。
//
// ■ 何を守っているか
//   1. 起動一式（index.html / CSS / import グラフの js 全部）が控えに入ること
//   2. install が失敗しても、次の機会に必ず補修されること
//   3. /api/ は絶対に控えないし返さないこと（古い残高を本物として出さない）
//   4. 結果の控え送りが「冪等キーのある結果だけ」に限られていること
//      ── かつては再送そのものが禁止だった（POST /api/game/result が同じ回を
//      2回受けると2回ぶん加算したため）。サーバーに冪等キー(runId)が入った
//      ので解禁したが、**runId を持たない結果を控えたら元の二重加算に戻る**。
//      控えを持つのは public/js/net.js。sw.js は今までどおり結果送信を知らない
//      （Background Sync は入れない ── 画面もセッションも無いところから
//      報酬の付く POST を投げる仕組みは、増やす価値より危なさのほうが大きい）。
//   5. オンライン専用の入口に「押す前に分かる」印が付いていること
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
// 📴 オフライン中の結果の控えは net.js が持つ（4番の検査で読む）。
const NET_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'net.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// Service Worker を「本物のまま」動かすための最小の器
//
// ブラウザの自動操作では SW のスクリプト取得が塞がれていて登録できないので、
// CacheStorage と ExtendableEvent だけを用意して sw.js をそのまま評価する。
// 中身に手を入れていないので、ここで通ることは実機の振る舞いとほぼ同じ。
// ---------------------------------------------------------------------------
function makeScope(origin, net) {
  const stores = new Map();                       // name -> Map<url, stored>
  const keyOf = r => (typeof r === 'string' ? new URL(r, origin).href : r.url);
  const store = async res => ({
    status: res.status, statusText: res.statusText,
    headers: [...res.headers], body: Buffer.from(await res.arrayBuffer()),
  });
  const revive = s => new Response(s.body, { status: s.status, statusText: s.statusText, headers: s.headers });

  class FakeCache {
    constructor(map) { this.map = map; }
    async put(req, res) { this.map.set(keyOf(req), await store(res)); }
    async match(req, opts = {}) {
      const k = keyOf(req);
      if (this.map.has(k)) return revive(this.map.get(k));
      if (opts.ignoreSearch) {
        const bare = k.split('?')[0];
        for (const [u, s] of this.map) if (u.split('?')[0] === bare) return revive(s);
      }
      return undefined;
    }
    async add(req) {
      const res = await net(new URL(keyOf(req), origin).href);
      if (!res.ok) throw new TypeError('bad response');
      await this.put(req, res);
    }
    async addAll(list) { for (const u of list) await this.add(u); }
    async keys() { return [...this.map.keys()].map(u => new Request(u)); }
    async delete(req) { return this.map.delete(keyOf(req)); }
  }
  const caches = {
    async open(n) { if (!stores.has(n)) stores.set(n, new Map()); return new FakeCache(stores.get(n)); },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
    async match(req, opts) {
      for (const n of stores.keys()) {
        const hit = await (await this.open(n)).match(req, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const listeners = new Map();
  const self = {
    location: new URL(origin + '/sw.js'),
    registration: { scope: origin + '/' },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: () => {},
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
  };
  const fn = new Function('self', 'caches', 'fetch', 'location', SW_SRC);
  fn(self, caches, net, self.location);
  return { self, caches, stores, listeners };
}

async function dispatch(scope, type, event) {
  const waits = [];
  event.waitUntil = p => waits.push(Promise.resolve(p).catch(() => {}));
  for (const fn of scope.listeners.get(type) || []) await fn(event);
  await Promise.all(waits);
}
const runInstall = s => dispatch(s, 'install', {});
const runActivate = s => dispatch(s, 'activate', {});
const runMessage = (s, data) => dispatch(s, 'message', { data });

/** fetch イベントを1本流す。respondWith が呼ばれなければ passthrough。 */
async function runFetch(scope, url, mode = 'cors') {
  const req = new Request(url);
  // Request の mode に 'navigate' は外から入れられないので覆い隠す。
  Object.defineProperty(req, 'mode', { value: mode, configurable: true });
  let answer;
  await dispatch(scope, 'fetch', { request: req, respondWith: p => { answer = Promise.resolve(p); } });
  if (!answer) return { passthrough: true };
  try { return { res: await answer }; } catch (err) { return { error: String((err && err.message) || err) }; }
}

const cacheUrls = scope => {
  const out = [];
  for (const map of scope.stores.values()) out.push(...map.keys());
  return out;
};

// ===========================================================================
// A. ソース検査（サーバー不要）
// ===========================================================================

// 1) 起動に要る js を「書き写して」いないこと。
//    この検査が要る理由: 第5波の時点で index.html の modulepreload は 23本、
//    実際の import グラフは 25本（clipexport.js が preload から抜けていた）。
//    統合フェーズで足したので今は一致しているが、**一致は保証ではない** ──
//    次に import を1本足した人が preload を更新し忘れれば、また離れる。
//    だから sw.js 側は「preload を写す」ではなく「グラフを辿る」でなければ
//    ならない。ここではその作りだけを見る（一致しているかどうかは見ない）。
const hardcoded = [...SW_SRC.matchAll(/['"]\/js\/[\w.-]+\.js['"]/g)].map(m => m[0]);
check('sw.js に js のファイル名を書き並べていない（import グラフを辿る作り）',
  hardcoded.length === 0, hardcoded.slice(0, 4).join(' ') || 'なし');
check('import を辿る仕掛けがある',
  /crawlModules\s*\(/.test(SW_SRC) && /matchAll\(IMPORT_RE\)/.test(SW_SRC), '');

// 2) HTML から辿れない静的ファイルは列挙が要る（manifest とアイコン）。
for (const need of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']) {
  check(`SHELL に ${need} が列挙されている`, SW_SRC.includes(`'${need}'`), '');
  check(`  └ 実在する`, fs.existsSync(path.join(ROOT, 'public', need.slice(1))), '');
}

// 3) install が落ちても次の機会に補修される作りか。
//    「そろった印」を書き、印が無ければ activate でも・ページを開くたびでも・
//    main.js からの合図でもやり直す ── どれか1つでも欠けると、電波の悪い
//    瞬間に install した人が永久に控えを持たない（install は SW のバイト列が
//    変わるまで二度と走らない）。
check('「そろった印」を持っている', /READY_URL/.test(SW_SRC) && /shellReadyFor\s*\(/.test(SW_SRC), '');
const repairAt = {
  install: /addEventListener\('install'[\s\S]{0,400}?ensureShell\(/.test(SW_SRC),
  activate: /addEventListener\('activate'[\s\S]{0,600}?ensureShell\(/.test(SW_SRC),
  fetch: /addEventListener\('fetch'[\s\S]{0,900}?ensureShell\(/.test(SW_SRC),
  message: /addEventListener\('message'[\s\S]{0,400}?ensureShell\(/.test(SW_SRC),
};
for (const [where, ok] of Object.entries(repairAt)) {
  check(`install の失敗を ${where} で取り返せる`, ok, '');
}
check('main.js が SW に補修の合図を送っている',
  /postMessage\(\s*\{\s*type:\s*'bba-warm'/.test(MAIN_SRC), '');

// 4) 控え送りの置き場と条件。
//    ⚠️ 控えてよいのは冪等キー(runId)を持つ結果だけ。ここが緩むと、
//    再送のたびにコインとXPが二重に入る昔の状態に戻る。
check("sw.js に 'sync' / 'periodicsync' の購読が無い",
  !/addEventListener\(\s*['"](periodic)?sync['"]/.test(SW_SRC), '');
// コメントは落として見る ── 「なぜ入れないか」の説明は残したいが、
// 実際のコードに結果送信のパスが現れたら落とす。
const swCode = SW_SRC.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('sw.js のコードが結果送信のパスを一切知らない',
  !swCode.includes('/api/game/result') && !/\bBackgroundSync\b/.test(swCode), '');
// 控えの持ち主は net.js 1箇所だけ。画面側(main.js)にもう1本ぶら下がると、
// 「どちらが送ったか」が分からないまま二重に送る経路ができる。
check('main.js にオフライン結果の再送キューが無い',
  !/(resend|retryQueue|pendingResults|flushQueue)/i.test(MAIN_SRC), '');
// ⚠️ 生命線: 控えるのは runId を持つ結果だけ。
{
  const q = NET_SRC.match(/function queueOfflineResult\([\s\S]{0,900}?\n\}/);
  check('net.js に控えの入口(queueOfflineResult)がある', !!q, q ? '' : '関数名が変わった — このテストを実装に合わせて直すこと');
  const body = q ? q[0] : '';
  check('控えるのは runId を持つ結果だけ',
    /typeof body\.runId !== 'string'/.test(body) && /return;/.test(body),
    body ? '' : '');
  check('控えるのは結果送信のパスだけ', /path !== RESULT_PATH/.test(body), '');
  // 送り出す側があること（控えるだけで一生送らない、を防ぐ）。
  check('つながったら送る仕組みがある',
    /export async function flushResultQueue/.test(NET_SRC)
    && /addEventListener\('online'/.test(NET_SRC), '');
}
// オフライン中の記録の扱いを、画面でも正直に伝えているか。
// v2.38 で net.js に「つながったら送る」控えが入り、サーバーに冪等キー(runId)が
// 入ったので、伝える中身が変わった:
//   旧「この端末にだけ残ります（ランキングにも報酬にも入りません）」
//   新「端末に預かって、つながったら自動で送ります」
// ⚠️ 逆戻り（＝控えを消したのに文言だけ残る）を捕まえたいので、**古い文言が
//    消えていること**も一緒に見る。控えが本当にあるかは1つ上の検査が見ている。
check('オフライン中の記録の扱いを画面で伝えている',
  /つながったら自動で送ります/.test(MAIN_SRC) && /sent automatically once you are back online/.test(MAIN_SRC), '');
check('「端末にだけ残る」という古い案内が残っていない',
  !/この端末にだけ残り/.test(MAIN_SRC) && !/stay on this device only/.test(MAIN_SRC), '');
// 送り終わったことを画面に伝える口があるか（net.js は表示を持たない）。
check('控えを送り終えたら画面が知らせる', /bba:results-sent/.test(MAIN_SRC), '');

// 5) /api/ は素通し（控えない・返さない）。
check('sw.js が /api/ を素通ししている',
  /url\.pathname\.startsWith\('\/api\/'\)[\s\S]{0,80}return;/.test(SW_SRC), '');

// 6) 押す前に分かる印の配線。
//    ここが「ボタンの id を変えたら黙って印が消える」を止める唯一の見張り。
const listOf = name => {
  const m = MAIN_SRC.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  return m ? [...m[1].matchAll(/'([\w]+)'/g)].map(x => x[1]) : [];
};
const netBtns = [...listOf('NET_MODE_BTNS'), ...listOf('NET_NAV_BTNS')];
check('通信が要る入口の一覧がある', netBtns.length >= 15, `${netBtns.length}個`);
// 一覧に載っている id が本当に存在するか（打ち間違いは黙って無効になる）
const knownIds = new Set([...INDEX_SRC.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
for (const f of fs.readdirSync(path.join(ROOT, 'public', 'js'))) {
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
  for (const m of s.matchAll(/\.id = '([\w-]+)'/g)) knownIds.add(m[1]);
}
const ghosts = netBtns.filter(id => !knownIds.has(id));
check('一覧の id がすべて実在する', ghosts.length === 0, ghosts.join(', ') || `${netBtns.length}個`);
// 通信が要るもの／要らないものの取り違えを止める
for (const id of ['btnBoss', 'btnWeekly', 'btnDaily', 'btnOnline', 'btnShop', 'btnLeaderboard', 'btnGacha']) {
  check(`${id} は「通信が必要」に入っている`, netBtns.includes(id), '');
}
for (const id of ['btnSolo', 'btnVsAi', 'btnDungeon', 'btnSprint', 'btnSurvival',
  'btnMeltdown', 'btnChimera', 'btnChain', 'btnPuzzle', 'btnDig', 'btnRules']) {
  check(`${id} はオフラインでも遊べる（印を付けない）`, !netBtns.includes(id), '');
}
check('押されたときは通信せずにその場で知らせる（capture で受ける）',
  /data-net-required="1"/.test(MAIN_SRC) && /stopImmediatePropagation\(\)/.test(MAIN_SRC), '');

// ===========================================================================
// B. 実測（本物のサーバーを立てて、本物の sw.js を回す）
// ===========================================================================
const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-offline-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0', SEED_RESTORE: '0', SESSION_SECRET: 'offline-test-secret-key' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null) throw new Error('サーバーが起動直後に終了しました');
    try { const r = await fetch(ORIGIN + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(200);
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // ページが実際に読むURLを、配られた index.html から組み立てる。
  const html = await fetch(ORIGIN + '/').then(r => r.text());
  const cssHref = (html.match(/rel="stylesheet"[^>]*href="([^"]+)"/) || [])[1];
  const mainSrc = (html.match(/<script type="module" src="([^"]+)"/) || [])[1];
  check('サーバーが ?v= を焼いた index.html を配っている',
    !!cssHref && !!mainSrc && /\?v=/.test(mainSrc), mainSrc || '');
  const CSS = new URL(cssHref, ORIGIN).href;
  const MAIN = new URL(mainSrc, ORIGIN + '/').href;

  // 起動に本当に要る js（import グラフ）をテスト側でも独立に数える。
  const graph = async entry => {
    const seen = new Set(); const q = [entry];
    while (q.length) {
      const u = q.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      const text = await fetch(u).then(r => r.text());
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
        if (!/\.js(\?|$)/.test(m[1])) continue;
        const abs = new URL(m[1], u).href;
        if (abs.startsWith(ORIGIN) && !seen.has(abs)) q.push(abs);
      }
    }
    return [...seen];
  };
  const MODULES = await graph(MAIN);
  check('起動に要るモジュールを数えられた', MODULES.length >= 20, `${MODULES.length}本`);
  // index.html の modulepreload と、実際の import グラフを突き合わせる。
  //
  // ⚠ ここは以前 `notPreloaded.length > 0`（＝「preload には必ず抜けがある」）
  // を **成功条件** にしていた。書いた当時 clipexport.js が preload から
  // 抜けていて、それを「写経では足りない」ことの証拠として使ったため。
  // ところが同じ波の forOthers で「その1行を足してほしい」と依頼しており、
  // 統合フェーズで実際に足したとたん、**直したせいでテストが赤くなった**。
  // 欠陥が在ることを成功条件にすると、直す人の手元で必ず落ちる。
  //
  // 本当に守りたいのは「sw.js が preload を写経していないこと」で、それは
  // 上の A-1（ファイル名の直書きが無い／crawlModules がある）が見ている。
  // ここでは代わりに、**逆向きの本物の欠陥**だけを落とす:
  //   preload に載っているのに import グラフに居ない ＝ 消したファイルや
  //   綴り違いを先読みしている（そのぶん帯域を捨て、404 を1本増やす）。
  const preloaded = new Set([...html.matchAll(/rel="modulepreload"[^>]*href="([^"]+)"/g)]
    .map(m => new URL(m[1], ORIGIN + '/').href));
  const graphBare = new Set(MODULES.map(u => u.split('?')[0]));
  const deadPreloads = [...preloaded].filter(u => !graphBare.has(u.split('?')[0]));
  check('modulepreload に死んだ先読みが無い',
    deadPreloads.length === 0,
    deadPreloads.map(u => u.split('/').pop()).join(', ') || `${preloaded.size}本すべてグラフ上にある`);
  // 抜けは落とさない（sw.js はグラフを辿るので壊れない）。ただし先読みの
  // 意図どおりにはなっていないので、気づけるように名指しで出す。
  const notPreloaded = MODULES.filter(u => u !== MAIN && !preloaded.has(u));
  if (notPreloaded.length) {
    console.log(`⚠ modulepreload に無い起動モジュール（sw.js は辿るので壊れないが、先読みは効かない）: ${
      notPreloaded.map(u => u.split('/').pop().split('?')[0]).join(', ')}`);
  }

  const BOOT = [{ u: ORIGIN + '/', mode: 'navigate' }, { u: CSS }, ...MODULES.map(u => ({ u }))];

  // --- 初回訪問しかしていない人（＝ install しか走っていない） ---
  const state = { offline: false };
  const net = async (input, init) => {
    if (state.offline) throw new TypeError('Failed to fetch');
    return fetch(input, init);
  };
  const scope = makeScope(ORIGIN, net);
  await runInstall(scope);
  await runActivate(scope);

  const cached = cacheUrls(scope);
  const missing = BOOT.map(b => b.u).filter(u => !cached.includes(u));
  check('install だけで起動一式がそろう（初回訪問の人がそのまま圏外でも遊べる）',
    missing.length === 0, missing.length ? missing.slice(0, 3).join(' / ') : `${cached.length}件を控えた`);

  // --- ここで通信を落とす。ホーム画面から起動したのと同じ順で叩く ---
  state.offline = true;
  const failed = [];
  for (const b of BOOT) {
    const out = await runFetch(scope, b.u, b.mode || 'cors');
    if (!out.res || out.res.status !== 200) failed.push(b.u.replace(ORIGIN, ''));
  }
  check('通信を落としても起動一式を全部返せる（＝メニューが出てソロが遊べる）',
    failed.length === 0, failed.length ? failed.slice(0, 3).join(' / ') : `${BOOT.length}本すべて`);
  // 返したのが案内カードではなく本物の index.html であること
  const nav = await runFetch(scope, ORIGIN + '/', 'navigate');
  const navBody = nav.res ? await nav.res.text() : '';
  check('オフラインのナビゲーションが本物の index.html を返す',
    navBody.includes('id="screen-menu"') && navBody.includes('btnSolo'), '');

  // --- /api/ は絶対に触らない ---
  state.offline = false;
  await runFetch(scope, ORIGIN + '/api/status');
  state.offline = true;
  const apiOut = await runFetch(scope, ORIGIN + '/api/status');
  check('/api/ は SW が応答しない（控えを本物として出さない）', apiOut.passthrough === true,
    apiOut.passthrough ? '' : JSON.stringify(apiOut));
  check('控えに /api/ が1件も入っていない',
    cacheUrls(scope).filter(u => u.includes('/api/')).length === 0, '');

  // --- install が「電波の悪い瞬間」に当たった端末の補修 ---
  const state2 = { offline: true };
  const net2 = async (i, o) => { if (state2.offline) throw new TypeError('Failed to fetch'); return fetch(i, o); };
  const scope2 = makeScope(ORIGIN, net2);
  await runInstall(scope2);
  await runActivate(scope2);
  check('圏外で install した端末は、その時点では何も控えていない',
    cacheUrls(scope2).length === 0, `${cacheUrls(scope2).length}件`);
  state2.offline = false;
  await runFetch(scope2, ORIGIN + '/', 'navigate');   // 通信が戻ってページを1回開いただけ
  const repaired = BOOT.map(b => b.u).filter(u => !cacheUrls(scope2).includes(u));
  check('通信が戻ってページを1回開けば補修される', repaired.length === 0,
    repaired.length ? repaired.slice(0, 3).join(' / ') : `${cacheUrls(scope2).length}件`);
  state2.offline = true;
  const failed2 = [];
  for (const b of BOOT) {
    const out = await runFetch(scope2, b.u, b.mode || 'cors');
    if (!out.res || out.res.status !== 200) failed2.push(b.u.replace(ORIGIN, ''));
  }
  check('補修後は圏外でも起動できる', failed2.length === 0, failed2.slice(0, 3).join(' / ') || 'すべて');

  // --- 更新（?v= が変わった）に気づいて控えを作り直すこと ---
  // 印だけ見て「そろっている」と判断すると、navigateFirst が新しい index.html を
  // 控えに書く一方でモジュールは古いまま、という混ざった状態が残る。
  // ここでは「印が現行の入口を指していない」状態を作って、ページを1回開いたら
  // 直っているかを見る（＝更新が出た直後と同じ状態）。
  state.offline = false;
  const readyKey = ORIGIN + '/__bba-shell-ready';
  const shellStore = [...scope.stores.values()][0];
  check('「そろった印」が控えに置かれている', shellStore.has(readyKey), '');
  shellStore.set(readyKey, {
    status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']],
    body: Buffer.from(ORIGIN + '/js/main.js?v=oldversion'),   // 前の版を指す印
  });
  await runFetch(scope, ORIGIN + '/', 'navigate');
  const readyNow = Buffer.from(shellStore.get(readyKey).body).toString();
  check('更新に気づいて控えを作り直す', readyNow === MAIN, readyNow.replace(ORIGIN, ''));

  // --- 更新のたびに控えが増え続けないこと ---
  // 版が変わると URL も変わるので、掃除しないと 25本ずつ積み増して端末の
  // 容量を静かに食い潰す（そのうち控えごとOSに捨てられる）。
  const stale = ORIGIN + '/js/main.js?v=0000000000';
  const store = [...scope.stores.values()][0];
  store.set(stale, { status: 200, statusText: 'OK', headers: [], body: Buffer.from('// old') });
  state.offline = false;
  await runMessage(scope, { type: 'bba-warm', force: true });
  check('古い版の控えは掃除される', !cacheUrls(scope).includes(stale),
    `${cacheUrls(scope).length}件`);
  // 掃除しすぎて今の一式を壊していないこと
  const afterPrune = BOOT.map(b => b.u).filter(u => !cacheUrls(scope).includes(u));
  check('掃除しても今の一式は残る', afterPrune.length === 0, afterPrune.slice(0, 3).join(' / ') || 'すべて');
} catch (err) {
  check('テストの土台', false, (err && err.stack) || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
