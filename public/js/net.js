// REST API client + WebSocket battle client.
import { trServer, LANG } from './i18n.js';

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

export async function api(path, { method = 'GET', body, timeout } = {}) {
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
    throw netError(to ? '接続タイムアウト' : 'サーバーに接続できません');
  }
  // 本文を読み終わるまでタイマーは止めない。ヘッダだけ返ってきて本文が
  // 来ない回線があるので、ここを外すと結局そこで固まる。
  let data = {};
  let bodyFailed = false;
  try { data = await res.json(); } catch { bodyFailed = true; /* empty body */ }
  // 空ボディ（204 など）は今までどおり data={} で通す。中断されたときだけ
  // エラーにする ── ここを黙って通すと「報酬ゼロの成功」に化ける。
  if (bodyFailed && aborted()) { clear(); throw netError('接続タイムアウト'); }
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
  if (isMyUser(data.user)) session.user = data.user;
  if (data.season) session.season = data.season;
  return data;
}

export async function refreshMe() {
  const data = await api('/api/me');
  session.user = data.user;
  session.season = data.season;
  return data;   // { user, season, dailyBonus }
}

// ---------------------------------------------------------------------------
// Battle WebSocket
// ---------------------------------------------------------------------------

export class BattleClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
  }

  on(type, fn) { this.handlers[type] = fn; return this; }
  emit(type, msg) { if (this.handlers[type]) this.handlers[type](msg); }

  connect(guestName) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
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
        ws.send(JSON.stringify({ type: 'hello', token: session.token, guestName, role: 'battle' }));
      };
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'hello_ok' && !this.connected) {
          this.connected = true;
          clearTimeout(timeout);
          settled = true;
          resolve(msg);
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

  close() {
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
    this.connected = false;
  }
}
