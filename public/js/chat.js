// Global chat: persistent WebSocket + drawer UI on the menu screen.
import { session } from './net.js';
import { $, toast } from './dom.js';
import { audio } from './audio.js';
import { t, trServer } from './i18n.js';

let ws = null;
let open = false;
let unread = 0;
let retryMs = 3000;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function appendMsg(msg, scroll = true) {
  const box = $('#chatMsgs');
  const el = document.createElement('div');
  const me = session.user && msg.from === session.user.username;
  const isAdmin = msg.role === 'admin';
  el.className = `chat-msg ${me ? 'mine' : ''} ${isAdmin ? 'admin-msg' : ''}`;
  const time = new Date(msg.at || Date.now());
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  el.innerHTML = `
    <span class="cm-meta"><span class="${isAdmin ? 'cm-admin' : ''}">${isAdmin ? '🛡️' : ''}${escapeHtml(msg.from)}</span> ・ ${hh}:${mm}</span>
    <span class="cm-bubble">${escapeHtml(msg.text)}</span>`;
  box.appendChild(el);
  while (box.children.length > 80) box.removeChild(box.firstChild);
  if (scroll) box.scrollTop = box.scrollHeight;
}

function setUnread(n) {
  unread = n;
  const b = $('#chatUnread');
  b.classList.toggle('hidden', n === 0);
  b.textContent = n > 9 ? '9+' : String(n);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch { scheduleReconnect(); return; }

  ws.onopen = () => {
    retryMs = 3000;
    ws.send(JSON.stringify({
      type: 'hello',
      token: session.token,
      guestName: localStorage.getItem('bba_guest_name') || undefined,
    }));
  };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello_ok') {
      $('#chatMsgs').innerHTML = '';
      (msg.chat || []).forEach(m => appendMsg(m, false));
      $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
      if (typeof msg.online === 'number') setOnlineCount(msg.online);
    } else if (msg.type === 'online') {
      // Server pushes the live count so every counter stays in sync.
      setOnlineCount(msg.online);
      const mm = $('#mmOnline');
      if (mm) mm.textContent = msg.online;
    } else if (msg.type === 'chat_clear') {
      $('#chatMsgs').innerHTML = '';
      setUnread(0);
    } else if (msg.type === 'chat') {
      appendMsg(msg);
      if (!open) setUnread(unread + 1);
    } else if (msg.type === 'announce') {
      appendMsg({ from: msg.from || '運営', role: 'admin', text: `📢 ${msg.message}`, at: Date.now() });
    } else if (msg.type === 'error') {
      toast(trServer(msg.error), 'err', 1800);
    }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function setOnlineCount(n) {
  $('#chatOnline').textContent = t(`🟢 ${n}人`, `🟢 ${n} online`);
  $('#onlineCount').textContent = n;
  $('#onlineBadge').classList.remove('hidden');
}

function scheduleReconnect() {
  setTimeout(connect, retryMs);
  retryMs = Math.min(30000, retryMs * 1.5);
}

function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast(t('チャットサーバーに接続中です…', 'Connecting to chat server…'), 'err', 1500);
    return;
  }
  ws.send(JSON.stringify({ type: 'chat', text }));
  input.value = '';
  audio.click();
}

export function initChat() {
  $('#chatToggle').onclick = () => {
    open = !open;
    $('#chatBox').classList.toggle('hidden', !open);
    if (open) {
      setUnread(0);
      $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
      $('#chatInput').focus();
    }
    audio.click();
  };
  $('#chatSend').onclick = sendChat;
  $('#chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
    e.stopPropagation();   // don't trigger the secret-command listener
  });
  connect();
}

// Reconnect with the fresh identity after login/logout.
export function reconnectChat() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch { /* ignore */ } }
  connect();
}
