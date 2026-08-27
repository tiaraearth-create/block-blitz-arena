// 🤝 フレンド画面。
//
// 連絡は必ず申請制。申請に自由文は載せられない（載せられると、申請そのものが
// 嫌がらせの配達手段になる）。断ったことは相手に伝わらない。
// ブロックは片方向で、相手には一切見えない。
//
// 断りの文言はサーバー側でどの理由でも同じにしてある ── 理由を出し分けると、
// この窓口が「あの人にブロックされているか」を調べる道具になるので。

import { $, showScreen, showModal, closeModal, toast } from './dom.js';
import { t } from './i18n.js';
import { audio } from './audio.js';
import { session, api } from './net.js';
import { sendWs } from './chat.js';
import { createParty, joinParty, currentParty, lastPartyMembers } from './party.js';

let data = null;
let tab = 'list';

function esc(x) {
  return String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS = {
  menu: () => t('🟢 オンライン', '🟢 Online'),
  playing: () => t('🎮 対戦中', '🎮 Playing'),
  offline: () => t('⚫ オフライン', '⚫ Offline'),
};

function ago(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return t('たった今', 'just now');
  if (m < 60) return t(`${m}分前`, `${m}m ago`);
  const h = Math.floor(m / 60);
  if (h < 24) return t(`${h}時間前`, `${h}h ago`);
  return t(`${Math.floor(h / 24)}日前`, `${Math.floor(h / 24)}d ago`);
}

export async function openFriends(which = 'list') {
  if (!session.user) {
    toast(t('フレンド機能を使うにはアカウント登録が必要です', 'You need an account to use friends'), 'err', 3500);
    return;
  }
  tab = which;
  showScreen('friends');
  try { data = await api('/api/friends'); }
  catch (err) { toast(err.message, 'err'); return; }
  renderFriends();
}

export function friendPending() {
  return data ? (data.incoming || []).length : 0;
}

function setTab(x) {
  tab = x;
  document.querySelectorAll('#screen-friends [data-fr]').forEach(b => {
    b.classList.toggle('active', b.dataset.fr === x);
  });
  renderFriends();
}

function renderFriends() {
  const body = $('#friendsBody');
  if (!body || !data) return;
  document.querySelectorAll('#screen-friends [data-fr]').forEach(b => {
    b.classList.toggle('active', b.dataset.fr === tab);
    b.onclick = () => { audio.click(); setTab(b.dataset.fr); };
  });
  const dot = $('#frReqDot');
  if (dot) dot.classList.toggle('hidden', !(data.incoming || []).length);

  if (tab === 'list') body.innerHTML = viewList();
  else if (tab === 'requests') body.innerHTML = viewRequests();
  else if (tab === 'find') body.innerHTML = viewFind();
  else body.innerHTML = viewSettings();
  wire(body);
}

function row(f, buttons) {
  return [
    '<div class="fr-row">',
    `  <span class="fr-name">${esc(f.username)}</span>`,
    `  <span class="fr-lvl">Lv.${f.level}</span>`,
    `  <span class="fr-status ${f.status}">${STATUS[f.status] ? STATUS[f.status]() : ''}`,
    f.status === 'offline' && f.lastSeen ? ` <i>${ago(f.lastSeen)}</i>` : '',
    '  </span>',
    `  <span class="fr-btns">${buttons}</span>`,
    '</div>',
  ].join('');
}

function viewList() {
  const p = currentParty();
  const last = lastPartyMembers();
  const head = [
    '<div class="fr-party">',
    p
      ? `<span>${t(`👥 パーティー中（${p.members.length}/${p.max}）`, `👥 In a party (${p.members.length}/${p.max})`)}</span>`
      : `<span>${t('👥 パーティーを組むと、いっしょに遊べます', '👥 Make a party to play together')}</span>`,
    p ? '' : `<button class="btn btn-sm btn-primary" id="frMakeParty">${t('パーティーを作る', 'Create party')}</button>`,
    p ? '' : `<button class="btn btn-sm btn-ghost" id="frJoinParty">${t('合言葉で入る', 'Join by code')}</button>`,
    // サーバーを更新するとパーティーは消える（保存していないので）。
    // 直前のメンバーを覚えておいて、ワンタップで組み直せるようにする。
    (!p && last.length)
      ? `<button class="btn btn-sm btn-ghost" id="frReParty">${t(`さっきの${last.length}人で組み直す`, `Re-form with ${last.length}`)}</button>`
      : '',
    '</div>',
  ].join('');

  if (!data.friends.length) {
    return head + `<p class="muted center" style="margin-top:20px">${t(
      'まだフレンドがいません。「さがす」から名前で申請できます。',
      'No friends yet. Use “Find” to send a request by name.')}</p>`;
  }
  const order = { menu: 0, playing: 1, offline: 2 };
  const sorted = data.friends.slice().sort((a, b) => (order[a.status] - order[b.status]) || a.username.localeCompare(b.username));
  return head + '<div class="fr-list">' + sorted.map(f => row(f, [
    p && p.members.length < p.max && f.status !== 'offline'
      ? `<button class="fr-b" data-invite="${esc(f.id)}">${t('招待', 'Invite')}</button>` : '',
    `<button class="fr-b warn" data-remove="${esc(f.id)}">${t('外す', 'Remove')}</button>`,
    `<button class="fr-b warn" data-block="${esc(f.id)}">${t('ブロック', 'Block')}</button>`,
  ].join(''))).join('') + '</div>';
}

function viewRequests() {
  const inc = data.incoming || [], out = data.outgoing || [];
  return [
    `<h3 class="fr-h">${t('届いている申請', 'Incoming')}</h3>`,
    inc.length
      ? '<div class="fr-list">' + inc.map(f => row(f, [
          `<button class="fr-b ok" data-accept="${esc(f.id)}">${t('承認', 'Accept')}</button>`,
          `<button class="fr-b" data-decline="${esc(f.id)}">${t('ことわる', 'Decline')}</button>`,
          `<button class="fr-b warn" data-block="${esc(f.id)}">${t('ブロック', 'Block')}</button>`,
        ].join(''))).join('') + '</div>'
      : `<p class="muted">${t('ありません。', 'None.')}</p>`,
    `<p class="muted" style="font-size:11px">${t(
      'ことわっても相手には伝わりません。',
      'Declining is never shown to the sender.')}</p>`,
    `<h3 class="fr-h">${t('送った申請', 'Sent')}</h3>`,
    out.length
      ? '<div class="fr-list">' + out.map(f => row(f,
          `<button class="fr-b" data-cancel="${esc(f.id)}">${t('とりけす', 'Cancel')}</button>`)).join('') + '</div>'
      : `<p class="muted">${t('ありません。', 'None.')}</p>`,
    (data.blocked || []).length ? [
      `<h3 class="fr-h">${t('ブロック中', 'Blocked')}</h3>`,
      '<div class="fr-list">',
      data.blocked.map(b => [
        '<div class="fr-row">',
        `  <span class="fr-name">${esc(b.username)}</span>`,
        `  <span class="fr-btns"><button class="fr-b" data-unblock="${esc(b.id)}">${t('解除', 'Unblock')}</button></span>`,
        '</div>',
      ].join('')).join(''),
      '</div>',
    ].join('') : '',
  ].join('');
}

function viewFind() {
  return [
    `<p class="muted">${t('相手の名前をそのまま入力してください。', 'Type the exact username.')}</p>`,
    '<div class="fr-find">',
    `  <input id="frName" maxlength="24" placeholder="${t('ユーザー名', 'Username')}">`,
    `  <button class="btn btn-primary" id="frSearch">${t('さがす', 'Find')}</button>`,
    '</div>',
    '<div id="frResult"></div>',
    `<p class="muted" style="font-size:11px;margin-top:16px">${t(
      '申請にメッセージは付けられません。相手が承認するまで、あなたの画面には何も出せません。',
      'Requests carry no message. Until they accept, you cannot put anything on their screen.')}</p>`,
  ].join('');
}

function viewSettings() {
  const s = data.social || {};
  const opt = (name, val, cur, ja, en) =>
    `<label class="fr-opt"><input type="radio" name="${name}" value="${val}" ${cur === val ? 'checked' : ''}> ${t(ja, en)}</label>`;
  return [
    `<h3 class="fr-h">${t('フレンド申請を受け取る', 'Friend requests')}</h3>`,
    opt('requests', 'all', s.requests, '誰からでも', 'From anyone'),
    opt('requests', 'none', s.requests, '受け取らない', 'Nobody'),
    `<h3 class="fr-h">${t('パーティーの招待を受け取る', 'Party invites')}</h3>`,
    opt('invites', 'friends', s.invites, 'フレンドから（おすすめ）', 'Friends only (recommended)'),
    opt('invites', 'all', s.invites, '誰からでも', 'From anyone'),
    opt('invites', 'none', s.invites, '受け取らない', 'Nobody'),
    `<p class="muted" style="font-size:11px;margin-top:14px">${t(
      'ブロックした相手は、この設定に関係なく一切あなたに届きません。合言葉でも同じパーティーには入れません。',
      'Blocked accounts never reach you regardless of these settings — not even through a party code.')}</p>`,
  ].join('');
}

// ---------------------------------------------------------------------------

async function act(path, body) {
  try {
    data = await api(path, { method: 'POST', body });
    renderFriends();
    return true;
  } catch (err) { toast(err.message, 'err', 3000); return false; }
}

function wire(body) {
  const on = (sel, fn) => body.querySelectorAll(sel).forEach(b => { b.onclick = () => fn(b); });
  on('[data-accept]', b => act('/api/friends/accept', { userId: b.dataset.accept }));
  on('[data-decline]', b => act('/api/friends/decline', { userId: b.dataset.decline }));
  on('[data-cancel]', b => act('/api/friends/cancel', { userId: b.dataset.cancel }));
  on('[data-unblock]', b => act('/api/friends/unblock', { userId: b.dataset.unblock }));
  on('[data-remove]', b => confirmThen(
    t('フレンドから外しますか？', 'Remove this friend?'),
    () => act('/api/friends/remove', { userId: b.dataset.remove })));
  on('[data-block]', b => confirmThen(
    t('ブロックしますか？ 相手には伝わりません。フレンドからも外れ、同じパーティーにも入れなくなります。',
      'Block them? They are never told. You will also be unfriended and cannot share a party.'),
    () => act('/api/friends/block', { userId: b.dataset.block })));
  on('[data-invite]', b => {
    // 送れていないのに「送りました」と出さない。
    if (!sendWs({ type: 'party_invite', userId: b.dataset.invite })) {
      toast(t('接続中です。少し待ってからもう一度どうぞ', 'Reconnecting — try again in a moment'), 'err', 2400);
      return;
    }
    b.disabled = true;
    b.textContent = t('送りました', 'Sent');
  });

  const mk = body.querySelector('#frMakeParty');
  if (mk) mk.onclick = () => { audio.click(); createParty(); };
  const jn = body.querySelector('#frJoinParty');
  if (jn) jn.onclick = () => { audio.click(); askCode(); };
  const re = body.querySelector('#frReParty');
  if (re) re.onclick = async () => {
    audio.click();
    createParty();
    // パーティーができてから招待するので、少しだけ待つ。
    const ids = lastPartyMembers().map(x => x.id);
    setTimeout(() => { for (const id of ids) sendWs({ type: 'party_invite', userId: id }); }, 600);
  };

  const search = body.querySelector('#frSearch');
  if (search) search.onclick = async () => {
    const name = body.querySelector('#frName').value.trim();
    if (!name) return;
    const out = body.querySelector('#frResult');
    out.innerHTML = `<p class="muted">${t('さがしています…', 'Searching…')}</p>`;
    try {
      const r = await api('/api/friends/search', { method: 'POST', body: { username: name } });
      if (!r.user) {
        // 見つからない理由は出し分けない（総当たりで在籍を調べられる）。
        out.innerHTML = `<p class="muted">${t('見つかりませんでした。', 'Not found.')}</p>`;
        return;
      }
      out.innerHTML = '<div class="fr-list">' + row(r.user,
        r.already ? `<span class="muted">${t('フレンド', 'Friend')}</span>`
          : r.pending ? `<span class="muted">${t('申請ずみ', 'Requested')}</span>`
            : `<button class="fr-b ok" data-req="${esc(r.user.id)}">${t('フレンド申請', 'Add friend')}</button>`) + '</div>';
      out.querySelectorAll('[data-req]').forEach(b => {
        b.onclick = async () => {
          b.disabled = true;
          const ok = await act('/api/friends/request', { userId: b.dataset.req });
          if (ok) toast(t('申請を送りました', 'Request sent'), 'ok');
          setTab('find');
        };
      });
    } catch (err) { out.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  };
  const nameInput = body.querySelector('#frName');
  if (nameInput) nameInput.onkeydown = e => { if (e.key === 'Enter') search.click(); };

  body.querySelectorAll('input[type=radio]').forEach(r => {
    r.onchange = () => act('/api/friends/settings', { [r.name]: r.value });
  });
}

function confirmThen(text, fn) {
  const m = showModal([
    `<p class="center">${esc(text)}</p>`,
    '<div class="modal-buttons">',
    `  <button class="btn btn-ghost" id="cfNo">${t('やめる', 'Cancel')}</button>`,
    `  <button class="btn btn-danger" id="cfYes">${t('はい', 'Yes')}</button>`,
    '</div>',
  ].join(''));
  m.querySelector('#cfNo').onclick = closeModal;
  m.querySelector('#cfYes').onclick = () => { closeModal(); fn(); };
}

function askCode() {
  const m = showModal([
    `<h2>${t('合言葉で入る', 'Join by code')}</h2>`,
    `<input id="pjCode" maxlength="8" placeholder="ABCDEF" style="text-transform:uppercase">`,
    '<div class="modal-buttons">',
    `  <button class="btn btn-ghost" id="pjNo">${t('やめる', 'Cancel')}</button>`,
    `  <button class="btn btn-primary" id="pjYes">${t('入る', 'Join')}</button>`,
    '</div>',
  ].join(''));
  m.querySelector('#pjNo').onclick = closeModal;
  m.querySelector('#pjYes').onclick = () => {
    const v = m.querySelector('#pjCode').value.trim().toUpperCase();
    closeModal();
    if (v) joinParty(v);
  };
}
