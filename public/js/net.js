// REST API client + WebSocket battle client.

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

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('サーバーに接続できません');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  if (data.user !== undefined) session.user = data.user;
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
      const timeout = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('接続タイムアウト')); }, 8000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', token: session.token, guestName }));
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
        if (!this.connected) reject(new Error('サーバーに接続できません'));
      };
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  queue() { this.send({ type: 'queue' }); }
  cancelQueue() { this.send({ type: 'cancel_queue' }); }
  sendState(score, combo, lines, grid) { this.send({ type: 'state', score, combo, lines, grid }); }
  finish(score) { this.send({ type: 'finish', score }); }

  close() {
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
    this.connected = false;
  }
}
