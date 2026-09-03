// REST API client + WebSocket battle client.
import { trServer, LANG } from './i18n.js';
// 🗄 端末に置く bba_* の一覧と仕分け（public/js/localdata.js）。ここでは
//    「解放印がどこから来たか」を記録するのに使う ── 記録しておかないと、
//    Aがアカウントで持っていた解放が端末に残り、次にログインしたBの
//    アカウントへ carryOverLocalUnlocks が恒久コピーしてしまう。
import { noteUnlockSource, ownerKeyOf } from './localdata.js';

const TOKEN_KEY = 'bba_token';

export const session = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,       // public user object from server
  season: null,
};

export function setToken(token) {
  session.token = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// 🔓 隠し要素の解放をアカウントから端末へ映す
// ---------------------------------------------------------------------------
//
// 解放を**読む**側は3か所に散っている（main.js のAI対戦と幽霊屋敷の扉、
// modes.js の ghostUnlocked、screens.js のローカルリセット）。全部に
// 「session.user.stats.unlocks も見る」を書き足して回るより、
// **サーバーの一覧を localStorage に写す**ほうが確実で、読む側は1行も
// 変えなくてよい ── 端末をまたいで消えるという本題はこれで解ける。
//
// ここ（net.js）に置いてあるのは、session.user が差し替わる箇所が
// このファイルにしか無いから。api() の応答・refreshMe・ログイン・登録・
// 試合結果まで、どの経路から来ても必ず通る。
//
// 消す向きには**絶対に倒さない**。サーバー側に無いものを閉じてしまうと、
// ゲストのまま開けた人がログインした瞬間に扉を失う（引き継ぎは main.js が
// 別途 POST する）。ここは「開ける」だけの片道。
export const UNLOCK_LS_KEYS = { kami: 'bba_kami', souzou: 'bba_souzou', ghost: 'bba_ghost' };

function mirrorUnlocksToDevice(user) {
  try {
    const list = user && user.stats && user.stats.unlocks;
    if (!Array.isArray(list) || !list.length) return;
    let changed = false;
    for (const id of list) {
      const key = UNLOCK_LS_KEYS[id];
      if (!key) continue;
      // 出どころは毎回付け直す ── 印だけ先にあって出どころが無い端末
      // （この仕組みより前からある端末）を、ここで拾って埋める。
      noteUnlockSource(key, ownerKeyOf(user));
      if (localStorage.getItem(key) === '1') continue;
      localStorage.setItem(key, '1');
      changed = true;
    }
    // 画面（幽霊屋敷の扉）が塗り直せるように合図を出す。net.js は表示を
    // 持たないので、ここでは知らせるだけ。
    if (changed && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('bba:unlocks-changed', { detail: { unlocks: [...list] } }));
    }
  } catch { /* プライベートモード等で localStorage が使えなくても遊べる */ }
}

// レスポンスの user を「自分のアカウント」として採用してよいかどうか。
// 見分けは2つとも要る:
//  ・social を持つのは publicUser（＝自分用の形）だけ。他人を返す friendRow
//    にも、管理画面用の adminUserView にも social は無い。adminUserView は
//    「管理者は全アイテム所持・通貨無限」という表示上の作り話を敢えて外した
//    生の値なので、たとえ自分自身を編集していても session.user には入れない
//    （入れると持ち物や通貨が本来と食い違って見える）。
//  ・そのうえで id が今の自分と一致すること。ログイン／登録の直後だけは
//    session.user がまだ無いので、そのときは id の照合を省く。
function isMyUser(u) {
  if (!u || typeof u !== 'object' || !u.social) return false;
  return !session.user || u.id === session.user.id;
}

// ---------------------------------------------------------------------------
// 通信の待ち時間の上限。
//
// fetch は既定でタイムアウトを持たない。接続だけ張れて返ってこない回線
// （電波が弱い・プロキシで詰まる）だと、ブラウザのソケットタイムアウトまで
// 何分でも await が返らない ── いちばん効くのが結果送信で、最後の1手のあと
// 盤面が固まったまま結果モーダルも出ず、「フリーズした」と読める。
// WebSocket 側は connect() が 8 秒の上限を持っている（下）ので、REST 側にも
// 同じ守りを付ける。切れたら通常のエラー経路（modes.js の rewards:{failed:true}
// ＋トースト）にそのまま落ちる。
const API_TIMEOUT_MS = 12000;
// 重い管理操作だけ別枠。復元は数MBの本文を送るし、スナップショット作成と
// 更新準備はサーバー側で数十秒かかることがある ── ここに 12 秒を当てると
// 正常な操作を途中で切ってしまう。
const SLOW_PATHS = /^\/api\/admin\/(restore|snapshots|prepare-update|backup)/;
const SLOW_TIMEOUT_MS = 180000;

function timeoutFor(path, given) {
  if (given !== undefined) return Number(given) || 0;   // 0 / 負数 = 無制限
  return SLOW_PATHS.test(String(path || '')) ? SLOW_TIMEOUT_MS : API_TIMEOUT_MS;
}

function netError(msg) {
  const e = new Error(trServer(msg));
  e.status = 0;
  if (msg === '接続タイムアウト') e.timeout = true;
  return e;
}

// ---------------------------------------------------------------------------
// 📴 オフライン中の結果を、つながったら送る
// ---------------------------------------------------------------------------
//
// 第5波では **わざと入れなかった**。当時の POST /api/game/result は同じ回を
// 2回受けると2回ぶん加算したので、溜めて後から送る仕組みは「二重加算を
// “事故のとき” から “毎回” へ格上げする」だけだった。
// サーバーに冪等キー（runId）が入ったので解禁する。条件は3つ:
//   1. 控えるのは runId を持つ結果だけ。**runId が無い結果は絶対に控えない**
//      （再送がそのまま二重加算に戻るため。ここがこの仕組みの生命線）。
//   2. 控えるのは「通信そのものが落ちた回」だけ。サーバーが返事を返した回
//      （429・503・400 など）はもう処理が済んでいるので控える理由が無い。
//   3. 控えの寿命は12時間。サーバー側の冪等キーの寿命（24時間 ＝ index.js の
//      RESULT_RUN_TTL_MS）の **内側** に必ず収める。外に出ると、サーバーが
//      runId を忘れたあとに届いて二重加算になりうる。
//
// ■「localStorage を書き換えれば報酬を捏造できるのでは」について
// この控えは **新しい権限を1つも増やしていない**。中身は最終的に
// POST /api/game/result に載るだけで、それは細工したクライアントなら元から
// 直接叩ける。実際に効いている守りは全部サーバー側にあり、どれも緩んでいない:
//   ・trusted … 対戦/レイド等のサーバー判定モードは自己申告では通らない
//   ・レート上限 … 30件/分・250件/時（冪等の判定より **前** に置いたまま）
//   ・duration の壁時計クランプ … 「前回の提出からの実経過＋90秒」。控えを
//     まとめて送っても、2件目以降は実経過がほぼ無いので90秒ぶんに切られる
//   ・1日あたりの上限（🪙/XP/💎）
// 増えるのは「正直に遊んだ人が、圏外で遊んだ回の報酬を受け取れる」ことだけ。
const RESULT_PATH = '/api/game/result';
const RESULT_QUEUE_KEY = 'bba_result_queue';
// 控える件数の上限。圏外で遊べるのは1人用モードだけなので、20件もあれば
// 現実の「圏外のひとまとまり」は収まる（これを超えると古いほうから落ちる）。
const RESULT_QUEUE_MAX = 20;
const RESULT_QUEUE_TTL_MS = 12 * 60 * 60 * 1000;
// 控えを送るときの間隔。まとめて叩いてレート上限(30件/分)を自分で踏まない。
const RESULT_QUEUE_GAP_MS = 2500;

function readResultQueue() {
  try {
    const raw = localStorage.getItem(RESULT_QUEUE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    // 読むたびに「冪等キーを持つ・期限内」だけに絞る。手で書き換えられた
    // 控えも、ここで形の合わないものは落ちる。
    return list.filter(e => e && typeof e === 'object' && e.body && typeof e.body === 'object'
      && typeof e.body.runId === 'string' && e.body.runId
      && Number(e.at) > now - RESULT_QUEUE_TTL_MS).slice(-RESULT_QUEUE_MAX);
  } catch { return []; }
}

function writeResultQueue(list) {
  try {
    if (!list.length) localStorage.removeItem(RESULT_QUEUE_KEY);
    else localStorage.setItem(RESULT_QUEUE_KEY, JSON.stringify(list.slice(-RESULT_QUEUE_MAX)));
  } catch { /* 容量いっぱい／プライベートモード。控えられなくても遊べる */ }
}

/** 送れずに控えてある結果の件数（画面から「未送信◯件」を出せるように）。 */
export function queuedResultCount() {
  return readResultQueue().filter(e => !session.user || e.uid === session.user.id).length;
}

function queueOfflineResult(path, method, body) {
  if (path !== RESULT_PATH || method !== 'POST') return;
  // ⚠ 冪等キーが無いものは控えない（＝再送しない）。ここを緩めると、
  //   再送のたびにコインとXPが二重に入る昔の状態に戻る。
  if (!body || typeof body.runId !== 'string' || !body.runId) return;
  // 誰の結果かが分からないと、別の人がログインしている端末で送ってしまう。
  if (!session.token || !session.user) return;
  const list = readResultQueue().filter(e => e.body.runId !== body.runId);
  list.push({ uid: session.user.id, at: Date.now(), body });
  writeResultQueue(list);
}

let flushingResults = false;
let lastResultFlushAt = 0;

/**
 * 控えてある結果を古い順に送る。送れた件数を返す。
 * 送信中・未ログイン・控えなしのときは何もしない。
 */
export async function flushResultQueue() {
  if (flushingResults || !session.token || !session.user) return 0;
  if (!readResultQueue().some(e => e.uid === session.user.id)) return 0;
  flushingResults = true;
  lastResultFlushAt = Date.now();
  let sent = 0;
  try {
    for (;;) {
      const list = readResultQueue();
      const entry = list.find(e => e.uid === session.user.id);
      if (!entry) break;
      // 送る前に控えから外し、送れなかったら戻す。付けたまま送ると、
      // 送信中にもう一度 flush が走ったときに同じ控えを二度送ることになる
      // （サーバーは冪等なので実害は無いが、レート上限を無駄に食う）。
      writeResultQueue(list.filter(e => e !== entry));
      try {
        await api(RESULT_PATH, { method: 'POST', body: entry.body, queueOffline: false });
        sent++;
      } catch (err) {
        // まだ圏外(0) / 送りすぎ(429) / メンテ中(503) は、こちらの都合ではなく
        // 時間が解決する ── 控えに戻して次の機会に回す。
        if (err.status === 0 || err.status === 429 || err.status === 503) {
          const back = readResultQueue();
          back.unshift(entry);
          writeResultQueue(back);
          break;
        }
        // 401/403/400 … 送り直しても通らない。捨てる（残すと永遠に叩き続ける）。
      }
      // 次がある時だけ間を空ける（最後の1件のあとに待つ意味は無い）。
      if (!readResultQueue().some(e => e.uid === session.user.id)) break;
      await new Promise(r => setTimeout(r, RESULT_QUEUE_GAP_MS));
    }
  } finally { flushingResults = false; }
  // 画面（main.js）が「◯件ぶんの報酬が入りました」を出せるように知らせる。
  // net.js は表示を持たないので、ここでは合図だけ。
  if (sent && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new CustomEvent('bba:results-sent', { detail: { count: sent } })); }
    catch { /* CustomEvent が無い環境では黙って諦める */ }
  }
  return sent;
}

// 通信が生きていると分かった直後（＝どれか1本でも api() が成功した直後）と、
// ブラウザが「オンラインに戻った」と言ったときに送る。専用の見張りを回さない
// のは、圏外から戻ったことを知る最も確実な合図が「実際に1本通ったこと」だから。
function scheduleResultFlush(delay = 1200) {
  if (flushingResults) return;
  if (Date.now() - lastResultFlushAt < 15000) return;   // 連打しない
  setTimeout(() => { flushResultQueue().catch(() => { /* 次の機会に */ }); }, delay);
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => scheduleResultFlush(800));
}

export async function api(path, { method = 'GET', body, timeout, queueOffline = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const ms = timeoutFor(path, timeout);
  // AbortController が無い環境（かなり古いブラウザ）では今までどおり無制限。
  const ctrl = (ms > 0 && typeof AbortController === 'function') ? new AbortController() : null;
  let timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, ms) : null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const aborted = () => !!(ctrl && ctrl.signal.aborted);
  let res;
  try {
    res = await fetch(path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch {
    const to = aborted();
    clear();
    // 📴 通信そのものが落ちた回だけ控える（返事が返った回は控えない）。
    if (queueOffline) queueOfflineResult(path, method, body);
    throw netError(to ? '接続タイムアウト' : 'サーバーに接続できません');
  }
  // 本文を読み終わるまでタイマーは止めない。ヘッダだけ返ってきて本文が
  // 来ない回線があるので、ここを外すと結局そこで固まる。
  let data = {};
  let bodyFailed = false;
  try { data = await res.json(); } catch { bodyFailed = true; /* empty body */ }
  // 空ボディ（204 など）は今までどおり data={} で通す。中断されたときだけ
  // エラーにする ── ここを黙って通すと「報酬ゼロの成功」に化ける。
  if (bodyFailed && aborted()) {
    clear();
    // ヘッダだけ返って本文が来なかった回。サーバーには届いている**かもしれない**
    // ので、以前は再送そのものが危なかった。いまは同じ runId なら二重加算に
    // ならないので、ここも控えてよい（届いていれば前回の結果がそのまま返る）。
    if (queueOffline) queueOfflineResult(path, method, body);
    throw netError('接続タイムアウト');
  }
  clear();
  if (!res.ok) {
    if (data.season) session.season = data.season;   // /api/me sends it even when logged out
    // サーバーは errorEn を添えてくることがある（そのために作った）のに、
    // ここで一度も読んでいなかったので、英語面に日本語のエラーが出ていた。
    // errorEn を第一候補にし、無い旧経路は今までどおり辞書（trServer）に落とす。
    const e = new Error((LANG === 'en' && data.errorEn)
      || trServer(data.error) || `Error (${res.status})`);
    e.status = res.status;
    e.code = data.code || null;   // e.g. NO_USER (restore pending) / SESSION_ENDED
    e.settled = !!data.settled;   // NO_USER + settled: the restore ran and the account isn't in it
    throw e;
  }
  // 自分の user だけを書き戻す。以前は `data.user !== undefined` で無条件に
  // 代入していたので、user キーに「自分以外」を載せて返すルート
  // （POST /api/friends/search、/api/admin/users/:id の GET と POST）を叩いた
  // 瞬間に session.user が別人や null に差し替わっていた ── 上部バーが他人の
  // 名前とコインになり、プロフィールやショップは stats/owned が無くて
  // TypeError で開けなくなり、管理者の「💰自分にコイン付与」は直前に編集画面を
  // 開いた相手のほうへ飛ぶ。検索が空振り（user:null）だとゲスト扱いに落ちて、
  // リロードするまで戻らなかった。
  if (isMyUser(data.user)) { session.user = data.user; mirrorUnlocksToDevice(session.user); }
  if (data.season) session.season = data.season;
  // 📴 1本でも通ったなら通信は生きている。控えてある結果があれば送る。
  if (queueOffline) scheduleResultFlush();
  return data;
}

export async function refreshMe() {
  const data = await api('/api/me');
  session.user = data.user;
  session.season = data.season;
  // api() の中の代入は isMyUser() を通すので、ここで素通しに入れ直した user は
  // まだ端末へ映っていないことがある。念のためもう一度通す（冪等）。
  mirrorUnlocksToDevice(session.user);
  return data;   // { user, season, dailyBonus }
}

// ---------------------------------------------------------------------------
// Battle WebSocket
// ---------------------------------------------------------------------------

// 🔌 自動再接続の刻み（ms）。指数バックオフ＋ゆらぎ。
//
// 合計は約15秒。サーバー側の猶予（server/battle.js の RECONNECT_GRACE_MS
// ＝25秒）の**内側**に収まるようにしてある ── 猶予が切れてから叩いても
// 席はもう無いので、そこから先は繰り返すだけ無駄になる。
// ゆらぎを混ぜるのは、サーバーが落ちて全員が同時に切れたとき、全員が
// 同じ瞬間に叩き直して復帰そのものを妨げないため。
const RECONNECT_STEPS_MS = [300, 700, 1500, 3000, 5000, 5000];
// 繋ぎ直せたのに試合が返ってこないとき、いつまで待つか。
// （猶予切れ・別端末が先に席を取った等。結果フレームは閉じた古いソケットへ
//  送られてしまっているので、待ち続けても何も来ない）
const RESUME_WAIT_MS = 3000;

export class BattleClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
    // ---- 自動再接続 ----
    this.guestName = undefined;
    // match_found 〜 result のあいだだけ true。
    // 繋ぎ直してよいのは**試合中だけ**にしている ── マッチング待ちで切れた
    // 場合、サーバー側の待ち行列は切断で消えているので、黙って繋ぎ直すと
    // 動かない検索画面の前に置き去りにするだけになる（そこは今までどおり
    // 'close' を上げて modes.js にメニューへ戻してもらう）。
    this.inMatch = false;
    this.closing = false;     // 自分で close() した＝繋ぎ直さない
    this.retry = 0;
    this.retryTimer = null;
    this.resumeTimer = null;
  }

  on(type, fn) { this.handlers[type] = fn; return this; }
  emit(type, msg) { if (this.handlers[type]) this.handlers[type](msg); }

  connect(guestName) {
    this.guestName = guestName;
    this.closing = false;
    this.retry = 0;
    return this._open(false);
  }

  // resume=true のときだけ、hello に復帰の申告を添える。
  // サーバーは resume と role の両方が揃ったときにしか席を返さない
  // （でないと同じ人のチャット用ソケットが席を奪う）。
  _open(resume) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
      catch {
        // 繋ぎ直しの途中でここに落ちると onclose が来ないので、次の刻みは
        // 自分で積む（積めなければ、いつもどおり切断として上げる）。
        if (resume && !this._scheduleReconnect()) this.emit('close', {});
        reject(new Error(trServer('サーバーに接続できません')));
        return;
      }
      this.ws = ws;
      // connect() の Promise は一度だけ解決する。hello_ok 前にサーバーが
      // error 送信→close（メンテ中・凍結・接続上限など）で切ってきた場合、
      // open 後のクリーンクローズはブラウザで error を発火しないため、
      // onclose で reject しないと呼び出し元が永遠に await で固まる。
      let settled = false;
      let lastError = '';
      const timeout = setTimeout(() => { try { ws.close(); } catch {} ; if (!settled) { settled = true; reject(new Error(trServer('接続タイムアウト'))); } }, 8000);

      ws.onopen = () => {
        // 対戦用のこのソケットは、chat.js が常時つないでいるソケットと
        // 同じ人の2本目。role を申告して人数に二重計上されないようにする。
        ws.send(JSON.stringify({
          type: 'hello', token: session.token, guestName: this.guestName, role: 'battle',
          ...(resume ? { resume: true } : {}),
        }));
      };
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'hello_ok' && !this.connected) {
          this.connected = true;
          this.retry = 0;
          clearTimeout(timeout);
          settled = true;
          resolve(msg);
          // 復帰のつもりで繋いだのに試合が返ってこないなら、そこで諦めて
          // いつもの切断あつかいにする（結果画面の待ち状態に置き去りにしない）。
          if (resume && this.inMatch) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = setTimeout(() => {
              // close() を通す（＝ソケットも畳む）。'close' の発火は
              // そちらの onclose に1回だけ任せる ── ここで emit も足すと
              // 同じ切断が2回流れる。
              if (this.inMatch) this.close();
            }, RESUME_WAIT_MS);
          }
        }
        if (msg.type === 'match_found' || msg.type === 'match_resumed') {
          this.inMatch = true;
          clearTimeout(this.resumeTimer);
          this.resumeTimer = null;
        } else if (msg.type === 'result') {
          this.inMatch = false;
        }
        // hello 処理中の切断理由（メンテ中・凍結など）を握っておき、
        // 続く onclose の reject に添える。
        if (msg.type === 'error' && msg.error) lastError = msg.error;
        this.emit(msg.type, msg);
      };
      ws.onclose = () => {
        this.connected = false;
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(lastError || trServer('接続が切断されました')));
        }
        // 🔌 試合中に切れたら、すぐ諦めずに繋ぎ直す。
        if (this._scheduleReconnect()) return;
        this.emit('close', {});
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        if (!this.connected && !settled) {
          settled = true;
          reject(new Error(trServer('サーバーに接続できません')));
        }
      };
    });
  }

  // 繋ぎ直しを予約できたら true（＝'close' を上げない）。
  _scheduleReconnect() {
    if (this.closing) return false;
    // 席を返してもらう鍵は userId なので、ログインしていない人は繋ぎ直しても
    // 試合には戻れない（サーバー側でゲストの復帰は塞いである）。
    if (!session.token) return false;
    if (!this.inMatch) return false;
    if (this.retry >= RECONNECT_STEPS_MS.length) return false;
    const base = RECONNECT_STEPS_MS[this.retry++];
    const wait = base + Math.floor(Math.random() * (base / 2));
    this.emit('reconnecting', { attempt: this.retry, waitMs: wait });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closing) return;
      // 失敗しても onclose からまた予約される。ここで拾わないと
      // 「未処理の Promise 拒否」になるだけなので、握って捨ててよい。
      this._open(true).catch(() => { /* onclose が次の刻みを積む */ });
    }, wait);
    return true;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  queue(mode = 'duel') { this.send({ type: 'queue', mode }); }
  cancelQueue() { this.send({ type: 'cancel_queue' }); }
  sendState(score, combo, lines, grid, pieces) { this.send({ type: 'state', score, combo, lines, grid, pieces }); }
  finish(score, lines, combo) { this.send({ type: 'finish', score, lines, combo }); }
  createRoom(settings) { this.send({ type: 'create_room', settings }); }
  joinRoom(code) { this.send({ type: 'join_room', code }); }
  setRoom(settings) { this.send({ type: 'room_set', settings }); }
  leaveRoom() { this.send({ type: 'room_leave' }); }
  startRoom() { this.send({ type: 'room_start' }); }
  // 🚪 自分の意思で試合を降りる。ソケットを閉じるだけだと、サーバーからは
  //    回線事故と区別が付かず「再接続の猶予」に入ってしまい、(1) 相手が
  //    最大25秒も動かない盤面を相手に戦い続け、(2) 自分の1日3回の猶予枠まで
  //    減る（本当に電波が切れた日に猶予が出なくなる）。
  //    これを送ってから閉じれば、サーバーはその場で棄権として裁ける。
  forfeit() { this.send({ type: 'forfeit' }); }

  close() {
    // 自分で閉じたときは繋ぎ直さない。ここを立てずに閉じると、
    // 予約済みの再接続が「もう捨てた画面」のために叩き続ける。
    this.closing = true;
    this.inMatch = false;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearTimeout(this.resumeTimer); this.resumeTimer = null;
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
    this.connected = false;
  }
}
