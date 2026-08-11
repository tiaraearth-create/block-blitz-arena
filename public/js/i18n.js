// Lightweight i18n: Japanese (default) / English.
// Usage: t('日本語テキスト', 'English text') — inline pairs, no key tables.
// The language is stored in localStorage and auto-detected on first visit.

const KEY = 'bba_lang';

export const LANG = (() => {
  const saved = localStorage.getItem(KEY);
  if (saved === 'ja' || saved === 'en') return saved;
  return (navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en';
})();

export function setLang(lang) {
  if (lang === 'ja' || lang === 'en') localStorage.setItem(KEY, lang);
}

export function t(ja, en) {
  return LANG === 'en' && en !== undefined ? en : ja;
}

// Rewrites the static HTML (menu, nav, sub-screen chrome) for English.
// Japanese is the source of truth in index.html, so 'ja' is a no-op.
export function applyStaticI18n() {
  document.documentElement.lang = LANG;
  if (LANG !== 'en') return;

  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };

  // menu buttons
  set('#btnSolo', '▶ Solo Play');
  set('#btnVsAi', '🤖 VS AI');
  set('#btnBoss', '🐲 Boss Battle');
  set('#btnDungeon', '🏰 Dungeon');
  set('#btnWeekly', '🎯 Weekly');
  set('#btnChaos', '🌪️ Chaos Mode');
  set('#btnOnline', '🌐 Online Battle');

  // nav (each is <span>icon</span> + text node)
  const nav = { btnLeaderboard: 'Ranking', btnShop: 'Shop', btnGacha: 'Gacha', btnGemShop: 'Gems', btnBattlePass: 'Pass', btnAdmin: 'Admin' };
  for (const [id, label] of Object.entries(nav)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `${el.querySelector('span') ? el.querySelector('span').outerHTML : ''}${label}`;
  }

  // online badge (keep the counter element)
  const badge = document.getElementById('onlineBadge');
  if (badge) {
    const n = document.getElementById('onlineCount')?.textContent || '0';
    badge.innerHTML = `🟢 Online: <b id="onlineCount">${n}</b>`;
  }

  // sub-screen headers + tabs
  set('#screen-leaderboard .sub-header h2', '🏆 Ranking');
  set('[data-lb="score"]', 'High Score');
  set('[data-lb="rating"]', 'Rating');
  set('[data-lb="dungeon"]', 'Dungeon');
  set('[data-lb="weekly"]', 'Weekly');
  set('#screen-shop .sub-header h2', '🛍️ Shop');
  set('[data-shop="skin"]', 'Blocks');
  set('[data-shop="board"]', 'Boards');
  set('[data-shop="fx"]', 'Effects');
  set('[data-shop="item"]', 'Items');
  set('#screen-battlepass .sub-header h2', '🎫 Battle Pass');
  set('#screen-room .sub-header h2', '🔧 Custom Room');

  // matchmaking
  set('#mmStatus', 'Looking for an opponent…');
  const mmSub = document.getElementById('mmSub');
  if (mmSub) mmSub.innerHTML = 'Online: <span id="mmOnline">-</span> players';
  set('#btnCancelQueue', 'Cancel');

  // custom room
  set('#btnCreateRoom', '➕ Create Room');
  set('#btnJoinRoom', 'Join');
  const codeInput = document.getElementById('roomCodeInput');
  if (codeInput) codeInput.placeholder = 'CODE';
  const joinNote = document.querySelector('#roomJoin .muted');
  if (joinNote) joinNote.innerHTML = 'Gather friends with the same code!<br>In team mode the first two players form Team A';
  const roomCode = document.querySelector('.room-code');
  if (roomCode) roomCode.innerHTML = `Room code <b id="roomCodeLabel">----</b>`;
  set('#btnLeaveRoom', 'Leave');
  set('#btnStartRoom', '🚀 Start!');

  // chat drawer
  const chatHead = document.querySelector('.chat-head');
  if (chatHead) chatHead.innerHTML = `💬 Global Chat <span id="chatOnline" class="muted"></span>`;
  const chatInput = document.getElementById('chatInput');
  if (chatInput) chatInput.placeholder = 'Message everyone…';
  set('#chatSend', 'Send');

  // splash + admin panel bits players never see stay Japanese
  set('.ts-tap', '▶ Tap to Start');
}
