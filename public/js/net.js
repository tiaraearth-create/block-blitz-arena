// REST API client + WebSocket battle client.
import { trServer } from './i18n.js';

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

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error(trServer('サーバーに接続できません'));
    e.status = 0;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (data.season) session.season = data.season;   // /api/me sends it even when logged out
    const e = new Error(trServer(data.error) || `Error (${res.status})`);
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
      const timeout = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error(trServer('接続タイムアウト'))); }, 8000);

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
          resolve(msg);
        }
        this.emit(msg.type, msg);
      };
      ws.onclose = () => {
        this.connected = false;
        clearTimeout(timeout);
        this.emit('close', {});
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        if (!this.connected) reject(new Error(trServer('サーバーに接続できません')));
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
