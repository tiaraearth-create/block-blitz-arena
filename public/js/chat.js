// Global chat: persistent WebSocket + drawer UI on the menu screen.
import { session } from './net.js';
import { $, toast, showModal, closeModal } from './dom.js';
import { audio } from './audio.js';
import { t, trServer, LANG } from './i18n.js';
import { getSettings } from './settings.js';

let ws = null;
let open = false;
let unread = 0;
let retryMs = 3000;

// ---------------------------------------------------------------------------
// Live feed: a ticker on the menu showing what is happening around the arena
// (simulated residents + real players' notable moments, starred).
// ---------------------------------------------------------------------------

let feed = [];          // newest last
let tickerIdx = 0;
let tickerTimer = null;

const feedText = item => (LANG === 'en' && item.textEn ? item.textEn : item.text);

function fmtAgo(at) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return t('たった今', 'just now');
  if (s < 3600) return t(`${Math.floor(s / 60)}分前`, `${Math.floor(s / 60)}m ago`);
  return t(`${Math.floor(s / 3600)}時間前`, `${Math.floor(s / 3600)}h ago`);
}

function showTicker(item, fresh = false) {
  const el = $('#liveFeed');
  const txt = $('#liveFeedText');
  if (!el || !txt || !item) return;
  el.classList.remove('hidden');
  txt.classList.remove('lf-swap'); void txt.offsetWidth; txt.classList.add('lf-swap');
  txt.textContent = `${item.real ? '⭐' : ''}${item.icon} ${feedText(item)}`;
  el.classList.toggle('real', !!item.real);
  if (fresh) { el.classList.remove('lf-new'); void el.offsetWidth; el.classList.add('lf-new'); }
}

function cycleTicker() {
  clearInterval(tickerTimer);
  tickerTimer = setInterval(() => {
    if (document.body.dataset.screen !== 'menu' || !feed.length) return;
    const recent = feed.slice(-8);
    tickerIdx = (tickerIdx + 1) % recent.length;
    showTicker(recent[tickerIdx]);
  }, 4500);
}

function pushFeed(item, fresh) {
  feed.push(item);
  if (feed.length > 40) feed.shift();
  tickerIdx = Math.min(7, feed.slice(-8).length - 1);
  showTicker(item, fresh);
}

export function getFeed() { return feed.slice(); }

export function showFeedModal() {
  audio.click();
  const items = feed.slice().reverse();
  const m = showModal(`
    <h2>📡 ${t('ライブフィード', 'Live Feed')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">${t('アリーナで今起きていること。⭐は本物のプレイヤーの快挙！', 'What is happening around the arena right now. ⭐ marks real players!')}</p>
    <div class="feed-list">
      ${items.length ? items.map(it => `
        <div class="feed-row ${it.real ? 'real' : ''}">
          <span class="feed-icon">${it.icon || '📡'}</span>
          <span class="feed-text">${it.real ? '⭐ ' : ''}${escapeHtml(feedText(it))}</span>
          <span class="feed-ago">${fmtAgo(it.at)}</span>
        </div>`).join('') : `<p class="muted center">${t('まだ何も起きていません', 'Nothing has happened yet')}</p>`}
    </div>
    <div class="modal-buttons"><button class="btn btn-primary" id="fdClose">${t('閉じる', 'Close')}</button></div>`);
  m.querySelector('#fdClose').onclick = closeModal;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Auto-translation: messages arrive with `tr` = { lang, text, engine } when the
// server could translate them. Show the version in the player's language and
// keep the original one tap away.
const msgLang = text => (/[ぁ-んァ-ヶ一-龠ー]/.test(text) ? 'ja' : 'en');

function appendMsg(msg, scroll = true) {
  const box = $('#chatMsgs');
  const el = document.createElement('div');
  const me = session.user && msg.from === session.user.username;
  const isAdmin = msg.role === 'admin';
  const isMod = msg.role === 'mod';
  el.className = `chat-msg ${me ? 'mine' : ''} ${isAdmin ? 'admin-msg' : ''}`;
  const time = new Date(msg.at || Date.now());
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const useTr = getSettings().chatTranslate && msg.tr && msg.tr.lang === LANG && msgLang(msg.text) !== LANG && !me;
  const tag = msg.tag ? `<span class="cm-tag">[${escapeHtml(msg.tag)}]</span>` : '';
  el.innerHTML = `
    <span class="cm-meta">${tag}<span class="${isAdmin ? 'cm-admin' : ''}">${isAdmin ? '🛡️' : isMod ? '🔧' : ''}${escapeHtml(msg.from)}</span> ・ ${hh}:${mm}</span>
    <span class="cm-bubble">${escapeHtml(useTr ? msg.tr.text : msg.text)}</span>
    ${useTr ? `<button class="cm-tr" title="${t('原文を表示', 'Show original')}">🌐 ${msg.tr.engine === 'api' ? t('翻訳', 'translated') : t('簡易翻訳', 'auto-translated')} ・ ${t('原文', 'original')}</button>` : ''}`;
  if (useTr) {
    const btn = el.querySelector('.cm-tr');
    const bubble = el.querySelector('.cm-bubble');
    let showingOriginal = false;
    btn.onclick = () => {
      showingOriginal = !showingOriginal;
      bubble.textContent = showingOriginal ? msg.text : msg.tr.text;
      btn.textContent = showingOriginal ? `🌐 ${t('翻訳を表示', 'Show translation')}` : `🌐 ${t('簡易翻訳', 'auto-translated')} ・ ${t('原文', 'original')}`;
    };
  }
  box.appendChild(el);
  while (box.children.length > 80) box.removeChild(box.firstChild);
  if (scroll) box.scrollTop = box.scrollHeight;
}

// News: the server pings when an announcement is posted; the menu badge
// lights up until the player opens the news screen.
const NEWS_SEEN_KEY = 'bba_news_seen';
export function markNewsSeen(at) { localStorage.setItem(NEWS_SEEN_KEY, String(at || Date.now())); updateNewsDot(0); }
export function updateNewsDot(latestAt) {
  const dot = $('#newsDot');
  if (!dot) return;
  const seen = Number(localStorage.getItem(NEWS_SEEN_KEY) || 0);
  dot.classList.toggle('hidden', !(latestAt && latestAt > seen));
  dot.textContent = '';
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
      if (Array.isArray(msg.feed) && msg.feed.length) {
        feed = msg.feed.slice(-40);
        tickerIdx = Math.max(0, feed.slice(-8).length - 1);
        showTicker(feed[feed.length - 1]);
        cycleTicker();
      }
      setMood(msg.mood);
    } else if (msg.type === 'online') {
      // Server pushes the live count so every counter stays in sync.
      setOnlineCount(msg.online);
      const mm = $('#mmOnline');
      if (mm) mm.textContent = msg.online;
      setMood(msg.mood);
    } else if (msg.type === 'feed') {
      pushFeed(msg, true);
    } else if (msg.type === 'news') {
      updateNewsDot(msg.latestAt);
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

// How lively the arena is right now (from the crowd simulation).
export function setMood(mood) {
  const el = $('#moodTag');
  if (!el || !mood) return;
  const tag = { party: ['🔥 大盛況', '🔥 packed'], busy: ['', ''], calm: ['🌙 まったり', '🌙 chill'], off: ['', ''] }[mood] || ['', ''];
  el.textContent = t(tag[0], tag[1]) ? ` ・ ${t(tag[0], tag[1])}` : '';
  el.dataset.mood = mood;
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
