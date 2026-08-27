// 👥 パーティー & パーティーチャット（画面側）。
//
// パーティーは chat.js の**常時つながっている socket**に相乗りしている。
// 対戦用の socket（net.js）は試合から抜けるたびに閉じるので、あちらに
// 置くとメニューに戻った瞬間にパーティーが消える。
//
// 表示は #partyDock。チャットの引き出し(.chat-drawer)の中には入れない ──
// あれはメニュー画面でしか出ない作りなので、試合中に見えなくなる。

import { $, showModal, closeModal, toast, showScreen } from './dom.js';
import { t, trServer } from './i18n.js';
import { audio } from './audio.js';
import { session, api } from './net.js';
import { sendWs, registerHandler, onWsReady } from './chat.js';

const LAST_PARTY_KEY = 'bba_last_party';

let state = null;          // サーバーから来た最新のパーティー
let chatLog = [];
let openDock = false;
let pendingInvite = null;

// サーバーは本文を素通し（200文字で切るだけ）で保存する。
// ここを1か所でも抜かすと、保存された文字がそのまま実行される形になる。
// CSP の script-src 'self' で実行は止まるが、style は通ってしまう。
function esc(x) {
  return String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_LABEL = {
  menu: () => t('メニュー', 'in menu'),
  playing: () => t('対戦中', 'playing'),
  offline: () => t('オフライン', 'offline'),
};

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function dock() { return $('#partyDock'); }

// 試合に入ったら畳む。試合中の棚は触れない帯なので、
// 開いたまま入ると「開いているのに反応しない」状態になる。
function inGame() { return document.body.dataset.screen === 'game'; }

export function renderParty() {
  const el = dock();
  if (!el) return;
  if (!state) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  if (inGame()) openDock = false;
  el.classList.toggle('open', openDock);
  const meId = session.user ? session.user.id : null;
  el.innerHTML = [
    '<button class="pt-bar" id="ptToggle">',
    `  <span class="pt-icon">👥</span>`,
    `  <span class="pt-count">${state.members.length}/${state.max}</span>`,
    `  <span class="pt-peek" id="ptPeek"></span>`,
    `  <span class="pt-caret">${openDock ? '▾' : '▴'}</span>`,
    '</button>',
    '<div class="pt-body">',
    '  <div class="pt-roster">',
    state.members.map(m => [
      `<div class="pt-member ${m.status}">`,
      `  <span class="pt-name">${m.id === state.leaderId ? '👑' : ''}${esc(m.username)}</span>`,
      `  <span class="pt-status">${STATUS_LABEL[m.status] ? STATUS_LABEL[m.status]() : ''}</span>`,
      state.youAreLeader && m.id !== meId
        ? `  <button class="pt-kick" data-kick="${esc(m.id)}" title="${t('外す', 'Remove')}">✕</button>` : '',
      '</div>',
    ].join('')).join(''),
    '  </div>',
    '  <div class="pt-code">',
    `    ${t('合言葉', 'Code')}: <b>${esc(state.code)}</b>`,
    `    <button class="pt-mini" id="ptCopy">${t('コピー', 'Copy')}</button>`,
    '  </div>',
    '  <div class="pt-msgs" id="ptMsgs"></div>',
    '  <div class="pt-input">',
    `    <input id="ptText" maxlength="200" placeholder="${t('パーティーに話す…', 'Say something…')}">`,
    `    <button id="ptSend">${t('送信', 'Send')}</button>`,
    '  </div>',
    // 運営が読める場合があることは、書く前に必ず見える場所に出す。
    // 「通報されたら読まれる」を後出しにしない。
    `  <p class="pt-notice">${t('パーティーチャットは通報時に運営が確認できます',
      'Party chat can be reviewed by staff when reported')}</p>`,
    '  <div class="pt-actions">',
    state.youAreLeader
      ? `    <button class="pt-mini" id="ptPlay">${t('いっしょに遊ぶ', 'Play together')}</button>` : '',
    `    <button class="pt-mini" id="ptInvite">${t('フレンドを招待', 'Invite')}</button>`,
    `    <button class="pt-mini warn" id="ptReport">${t('通報', 'Report')}</button>`,
    `    <button class="pt-mini warn" id="ptLeave">${t('ぬける', 'Leave')}</button>`,
    '  </div>',
    '</div>',
  ].join('');

  $('#ptToggle').onclick = () => { openDock = !openDock; audio.click(); renderParty(); };
  $('#ptCopy').onclick = () => {
    navigator.clipboard?.writeText(state.code);
    toast(t('合言葉をコピーしました', 'Code copied'), 'ok', 1500);
  };
  el.querySelectorAll('[data-kick]').forEach(b => {
    b.onclick = () => sendWs({ type: 'party_kick', userId: b.dataset.kick });
  });
  const leave = $('#ptLeave');
  if (leave) leave.onclick = () => { audio.click(); sendWs({ type: 'party_leave' }); };
  const inv = $('#ptInvite');
  if (inv) inv.onclick = () => { audio.click(); openInvitePicker(); };
  const play = $('#ptPlay');
  if (play) play.onclick = () => { audio.click(); openPlayPicker(); };
  const rep = $('#ptReport');
  if (rep) rep.onclick = () => { audio.click(); openReport(); };
  const send = () => {
    const input = $('#ptText');
    const v = input.value.trim();
    if (!v) return;
    sendWs({ type: 'party_chat', text: v });
    input.value = '';
  };
  $('#ptSend').onclick = send;
  $('#ptText').onkeydown = e => { if (e.key === 'Enter') send(); };
  renderChat();
}

function renderChat() {
  const box = $('#ptMsgs');
  if (!box) return;
  box.innerHTML = chatLog.map(m => [
    `<div class="pt-msg" data-id="${esc(m.id)}">`,
    `  <b>${esc(m.from)}</b>`,
    `  <span>${esc(m.text)}</span>`,
    m.tr ? `  <i class="pt-tr">${esc(m.tr)}</i>` : '',
    '</div>',
  ].join('')).join('');
  box.scrollTop = box.scrollHeight;
}

// 畳んでいるときは、最後の一言をバーに数秒だけ出す。
// 同期で配っている（翻訳を待たない）のは、この一瞬のためでもある。
let peekTimer = null;
function peek(text) {
  const el = $('#ptPeek');
  if (!el || openDock) return;
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => el.classList.remove('on'), 4000);
}

// ---------------------------------------------------------------------------
// 招待・遊ぶ・通報
// ---------------------------------------------------------------------------

async function openInvitePicker() {
  let data;
  try { data = await api('/api/friends'); }
  catch (err) { toast(err.message, 'err'); return; }
  const inParty = new Set((state ? state.members : []).map(m => m.id));
  const rows = (data.friends || []).filter(f => !inParty.has(f.id));
  const m = showModal([
    `<h2>${t('フレンドを招待', 'Invite a friend')}</h2>`,
    rows.length
      ? `<div class="fr-list">${rows.map(f => [
          `<div class="fr-row">`,
          `  <span class="fr-name">${esc(f.username)}</span>`,
          `  <span class="fr-status ${f.status}">${STATUS_LABEL[f.status] ? STATUS_LABEL[f.status]() : ''}</span>`,
          f.status === 'offline'
            ? `  <button class="btn btn-sm btn-ghost" disabled>${t('オフライン', 'Offline')}</button>`
            : `  <button class="btn btn-sm btn-primary" data-inv="${esc(f.id)}">${t('招待', 'Invite')}</button>`,
          '</div>',
        ].join('')).join('')}</div>`
      : `<p class="muted center">${t('招待できるフレンドがいません。', 'No friends available to invite.')}</p>`,
    `<div class="modal-buttons"><button class="btn btn-ghost" id="ivClose">${t('とじる', 'Close')}</button></div>`,
  ].join(''));
  m.querySelector('#ivClose').onclick = closeModal;
  m.querySelectorAll('[data-inv]').forEach(b => {
    b.onclick = () => {
      sendWs({ type: 'party_invite', userId: b.dataset.inv });
      b.disabled = true;
      b.textContent = t('送りました', 'Sent');
    };
  });
}

// リーダーが選ぶ。人数が足りないモードは最初から出さない。
const PARTY_MODES = [
  { id: 'team', seats: 4, ja: '⚔️ 2vs2', en: '⚔️ 2v2' },
  { id: 'coop', seats: 2, ja: '🤝 協力プレイ', en: '🤝 Co-op' },
  { id: 'custom', seats: 4, ja: '🔑 合言葉ルーム', en: '🔑 Private room' },
];

function openPlayPicker() {
  const n = state ? state.members.length : 1;
  const usable = PARTY_MODES.filter(x => x.seats >= n);
  const m = showModal([
    `<h2>${t('いっしょに遊ぶ', 'Play together')}</h2>`,
    `<p class="muted center" style="font-size:12px">${t(`いま${n}人`, `${n} in the party`)}</p>`,
    usable.length
      ? `<div class="form-col">${usable.map(x =>
          `<button class="btn btn-primary btn-big" data-mode="${x.id}" data-seats="${x.seats}">${t(x.ja, x.en)}</button>`).join('')}</div>`
      : `<p class="muted center">${t('この人数で遊べるモードがありません。', 'No mode fits this party size.')}</p>`,
    `<div class="modal-buttons"><button class="btn btn-ghost" id="ppClose">${t('とじる', 'Close')}</button></div>`,
  ].join(''));
  m.querySelector('#ppClose').onclick = closeModal;
  m.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = () => {
      closeModal();
      sendWs({ type: 'party_play', mode: b.dataset.mode, seats: Number(b.dataset.seats) });
    };
  });
}

function openReport() {
  const m = showModal([
    `<h2>${t('パーティーを通報', 'Report this party')}</h2>`,
    `<p class="muted" style="font-size:12px">${t(
      '直近の会話と参加者が運営に届きます。運営が読んだことも記録に残ります。',
      'The recent messages and the roster are sent to staff. Staff reads are themselves logged.')}</p>`,
    `<textarea id="prText" maxlength="300" rows="3" placeholder="${t('何があったか（任意）', 'What happened (optional)')}"></textarea>`,
    `<div class="modal-buttons">`,
    `  <button class="btn btn-ghost" id="prCancel">${t('やめる', 'Cancel')}</button>`,
    `  <button class="btn btn-danger" id="prSend">${t('通報する', 'Report')}</button>`,
    '</div>',
  ].join(''));
  m.querySelector('#prCancel').onclick = closeModal;
  m.querySelector('#prSend').onclick = async () => {
    try {
      await api('/api/party/report', { method: 'POST', body: { reason: m.querySelector('#prText').value } });
      closeModal();
      toast(t('通報しました。ありがとうございます。', 'Reported — thank you.'), 'ok', 3000);
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ---------------------------------------------------------------------------
// 外から呼ぶ口
// ---------------------------------------------------------------------------

export function createParty() {
  if (!session.user) {
    toast(t('パーティーを使うにはアカウント登録が必要です', 'You need an account to use parties'), 'err', 3000);
    return;
  }
  sendWs({ type: 'party_create' });
}

export function joinParty(code) {
  if (!session.user) {
    toast(t('パーティーを使うにはアカウント登録が必要です', 'You need an account to use parties'), 'err', 3000);
    return;
  }
  sendWs({ type: 'party_join', code });
}

export function currentParty() { return state; }

// 再デプロイでパーティーは消える（サーバーのメモリにしか無い）。
// 直前のメンバーを覚えておいて、ワンタップで組み直せるようにする。
export function lastPartyMembers() {
  try { return JSON.parse(localStorage.getItem(LAST_PARTY_KEY) || '[]'); }
  catch { return []; }
}

export function initParty() {
  registerHandler('party_state', msg => {
    state = msg.party;
    if (state) {
      const meId = session.user ? session.user.id : null;
      localStorage.setItem(LAST_PARTY_KEY, JSON.stringify(
        state.members.filter(m => m.id !== meId).map(m => ({ id: m.id, username: m.username }))));
    } else {
      chatLog = [];
    }
    renderParty();
  });

  registerHandler('party_chat_history', msg => {
    chatLog = (msg.chat || []).slice(-40);
    renderChat();
  });

  registerHandler('party_chat', msg => {
    chatLog.push(msg.msg);
    if (chatLog.length > 40) chatLog.shift();
    renderChat();
    if (!openDock) {
      peek(`${msg.msg.from}: ${msg.msg.text}`);
      audio.click();
    }
  });

  // 翻訳は後追いで貼る（先に配って順番を守るため）。
  registerHandler('party_chat_tr', msg => {
    const m = chatLog.find(x => x.id === msg.id);
    if (m) { m.tr = msg.text; renderChat(); }
  });

  registerHandler('party_invite', msg => {
    pendingInvite = msg.inviteId;
    audio.combo(3);
    const m = showModal([
      `<h2>👥 ${t('パーティーに誘われました', 'Party invite')}</h2>`,
      `<p class="center"><b>${esc(msg.from)}</b> ${t('からのお誘いです', 'invited you')}</p>`,
      `<p class="muted center" style="font-size:12px">${msg.members}/${msg.max}</p>`,
      '<div class="modal-buttons">',
      `  <button class="btn btn-ghost" id="piNo">${t('ことわる', 'Decline')}</button>`,
      `  <button class="btn btn-primary" id="piYes">${t('参加する', 'Join')}</button>`,
      '</div>',
    ].join(''));
    m.querySelector('#piYes').onclick = () => {
      closeModal();
      sendWs({ type: 'party_invite_accept', inviteId: msg.inviteId });
    };
    m.querySelector('#piNo').onclick = () => {
      closeModal();
      sendWs({ type: 'party_invite_decline', inviteId: msg.inviteId });
    };
    // 期限が来たら勝手に閉じる（60秒）
    setTimeout(() => { if (pendingInvite === msg.inviteId) { pendingInvite = null; closeModal(); } }, msg.expiresIn || 60000);
  });

  registerHandler('friend_request', msg => {
    toast(t(`🤝 ${msg.from} からフレンド申請が届きました`, `🤝 Friend request from ${msg.from}`), 'announce', 5000);
  });
  registerHandler('friend_accepted', msg => {
    toast(t(`🤝 ${msg.by} とフレンドになりました！`, `🤝 You and ${msg.by} are now friends!`), 'ok', 4000);
  });

  // 部屋を作るのはリーダーの画面。作れたら合言葉をサーバーへ返し、
  // サーバーが全員に配る。こうすると対戦まわりのコードを1行も触らずに済む。
  registerHandler('party_launch_begin', async msg => {
    try {
      const { createPartyRoom } = await import('./modes.js');
      const code = await createPartyRoom(msg.mode);
      if (code) sendWs({ type: 'party_code', code });
    } catch (err) {
      toast(t('部屋を作れませんでした', 'Could not open the room'), 'err');
    }
  });

  registerHandler('party_launch', msg => {
    audio.combo(5);
    const m = showModal([
      `<h2>👥 ${t('部屋ができました', 'The room is open')}</h2>`,
      `<p class="center">${t('合言葉', 'Code')}: <b>${esc(msg.code)}</b></p>`,
      '<div class="modal-buttons">',
      `  <button class="btn btn-ghost" id="plNo">${t('あとで', 'Not now')}</button>`,
      `  <button class="btn btn-primary" id="plYes">${t('入る', 'Join')}</button>`,
      '</div>',
    ].join(''));
    m.querySelector('#plNo').onclick = closeModal;
    m.querySelector('#plYes').onclick = async () => {
      closeModal();
      const { joinPartyRoom } = await import('./modes.js');
      joinPartyRoom(msg.code);
    };
  });

  registerHandler('party_error', msg => { if (msg.error) toast(trServer(msg.error), 'err', 3000); });

  // 画面が変わったら描き直す。試合中とメニューで棚の姿が変わるので、
  // ここを見ていないと、試合に入っても開いた棚のまま盤面に重なる。
  const mo = new MutationObserver(() => { if (state) renderParty(); });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

  // 再接続したら状態を貼り直してもらう（サーバーが socketArrived で送る）。
  onWsReady(() => { if (state) renderParty(); });
}
