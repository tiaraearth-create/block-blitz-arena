// 👥 パーティー & パーティーチャット（画面側）。
//
// パーティーは chat.js の**常時つながっている socket**に相乗りしている。
// 対戦用の socket（net.js）は試合から抜けるたびに閉じるので、あちらに
// 置くとメニューに戻った瞬間にパーティーが消える。
//
// 表示は #partyDock。チャットの引き出し(.chat-drawer)の中には入れない ──
// あれはメニュー画面でしか出ない作りなので、試合中に見えなくなる。

import { $, showModal, closeModal, toast, showScreen } from './dom.js';
import { t, trServer, LANG } from './i18n.js';
import { audio } from './audio.js';
import { session, api } from './net.js';
import { sendWs, registerHandler, onWsReady } from './chat.js';
import { getSettings } from './settings.js';

// 全体チャット側（chat.js）と同じ判定。日本語かな/カナ/漢字があれば ja。
const msgLang = text => (/[ぁ-んァ-ヶ一-龠ー]/.test(text) ? 'ja' : 'en');

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
  // 組み直す前に、打ちかけの文と焦点を控える。
  const old = $('#ptText');
  const draft = old ? old.value : '';
  const draftFocused = old ? document.activeElement === old : false;
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
  $('#ptCopy').onclick = async () => {
    // 非セキュアな LAN(http) では navigator.clipboard 自体が無く、セキュアでも
    // writeText が拒否され得る。成功を確かめてから知らせる ── ytexport の ytCopy と
    // 同じく execCommand へ退避し、それも駄目なら「コピーできなかった」と正直に出す。
    const code = state.code;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(code); ok = true; }
    } catch { /* execCommand に退避 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch { ok = false; }
    }
    toast(ok ? t('合言葉をコピーしました', 'Code copied')
             : t(`コピーできませんでした（合言葉: ${code}）`, `Could not copy (code: ${code})`),
      ok ? 'ok' : 'err', ok ? 1500 : 3000);
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
    // 送れなかったら文を消さない。消すと、打った内容が黙って失われる。
    if (!sendWs({ type: 'party_chat', text: v })) {
      toast(t('接続中です。少し待ってからもう一度どうぞ', 'Reconnecting — try again in a moment'), 'err', 2400);
      return;
    }
    input.value = '';
  };
  $('#ptSend').onclick = send;
  $('#ptText').onkeydown = e => { if (e.key === 'Enter') send(); };
  // 状態が届くたびに innerHTML を組み直しているので、打ちかけの文と
  // カーソル位置が消えていた。誰かが出入りしただけで書きかけが飛ぶ。
  if (draft) {
    const input = $('#ptText');
    input.value = draft;
    if (draftFocused) { input.focus(); try { input.setSelectionRange(draft.length, draft.length); } catch { /* ignore */ } }
  }
  renderChat();
}

function renderChat() {
  const box = $('#ptMsgs');
  if (!box) return;
  // 翻訳行は全体チャット（chat.js:231）と同じ約束に合わせる ── 設定でOFFなら
  // 出さず、自分の言語で書かれた発言（同言語の読者・自分の発言を含む）にも付けない。
  const showTr = getSettings().chatTranslate;
  box.innerHTML = chatLog.map(m => [
    `<div class="pt-msg" data-id="${esc(m.id)}">`,
    `  <b>${esc(m.from)}</b>`,
    `  <span>${esc(m.text)}</span>`,
    (m.tr && showTr && msgLang(m.text) !== LANG) ? `  <i class="pt-tr">${esc(m.tr)}</i>` : '',
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
      // 送れていないのに「送りました」と出さない（friends.js:219 と同じ）。
      // /api/friends は HTTP なので、ws だけ落ちている窓（サーバー再起動直後や
      // chat.js の再接続待ち）では一覧は普通に出る。そこで押すと1通も飛ばないまま
      // ボタンだけ無効になり、相手が来ない理由が誰にも分からなくなる。
      if (!sendWs({ type: 'party_invite', userId: b.dataset.inv })) {
        toast(t('接続中です。少し待ってからもう一度どうぞ', 'Reconnecting — try again in a moment'), 'err', 2400);
        return;
      }
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
// 割り込みモーダルの順番待ち
//
// showModal は必ず closeModal() から始まる（dom.js）。つまり招待が1通届いた
// だけで、いま出ているモーダルが中身ごと消える。結果画面は軒並み
// { dismissable: false } で出していて、閉じる口はモーダルの中のボタンだけ ──
// しかも VS AI・ボス・ボスラッシュ・メルトダウン・パズル遺跡の quit() は
// `if (this.ended) return;` に吸われて何もしないので、消されると
// 「動かない盤面＋出口なし」でリロードするまで戻れなくなる。
// （試合中はトップバーもパーティー棚の本体も CSS で消えている）
//
// なので、閉じられない印（data-locked）が出ているあいだは割り込まない。
// 空いたら出す。それまでは toast で「来ていること」だけ伝える。
// ---------------------------------------------------------------------------

let waiting = [];            // { show, until } — until が 0 なら期限なし
let waitObserver = null;

function modalOpen() {
  const root = $('#modal-root');
  return !!(root && root.firstChild);
}

function modalLocked() {
  const root = $('#modal-root');
  return !!(root && root.querySelector('.modal-backdrop[data-locked]'));
}

function showLater(show, until = 0) {
  waiting.push({ show, until });
  if (waiting.length > 4) waiting.shift();   // 溜め込んで後から一斉に出さない
  const root = $('#modal-root');
  if (!root || waitObserver) return;
  // 閉じられた瞬間に出したいので、#modal-root の出入りを見張る。
  waitObserver = new MutationObserver(flushWaiting);
  waitObserver.observe(root, { childList: true });
}

function flushWaiting() {
  const now = Date.now();
  waiting = waiting.filter(x => !x.until || x.until > now);
  // ロック中でなくても、出ているものは潰さない ── ショップの購入確認を
  // 勝手に消すのも結局は同じ事故なので、完全に空くまで待つ。
  if (!waiting.length || modalOpen()) return;
  // ここは MutationObserver のコールバックなので、投げると残りの待ち行列が
  // まるごと出せなくなる。1件の失敗で道を塞がない。
  try { waiting.shift().show(); } catch (err) { console.error('[party] queued modal', err); }
}

// ---------------------------------------------------------------------------
// 外から呼ぶ口
// ---------------------------------------------------------------------------

export function createParty() {
  if (!session.user) {
    toast(t('パーティーを使うにはアカウント登録が必要です', 'You need an account to use parties'), 'err', 3000);
    return;
  }
  if (!sendWs({ type: 'party_create' })) notConnected();
}

// 押しても何も起きない、が起きないように。
function notConnected() {
  toast(t('接続中です。少し待ってからもう一度どうぞ', 'Reconnecting — try again in a moment'), 'err', 2400);
}

export function joinParty(code) {
  if (!session.user) {
    toast(t('パーティーを使うにはアカウント登録が必要です', 'You need an account to use parties'), 'err', 3000);
    return;
  }
  if (!sendWs({ type: 'party_join', code })) notConnected();
}

export function currentParty() { return state; }

// ログアウトやアカウント切り替えのときに呼ぶ。
// 呼ばないと、前の人のパーティーが棚に出たままになる。
export function resetParty() {
  state = null;
  chatLog = [];
  pendingInvite = null;
  waiting = [];
  // 前の人あての通知ドットも消す（未ログインなら refreshFriendDot が 0 にする）。
  import('./friends.js').then(f => f.refreshFriendDot()).catch(() => {});
  renderParty();
}

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
      const others = state.members.filter(m => m.id !== meId).map(m => ({ id: m.id, username: m.username }));
      // 自分ひとりのときは書かない。パーティーを作った直後は必ず「自分1人」の
      // party_state が届くので、無条件に上書きすると「さっきの◯人で組み直す」の
      // 記憶が作るたびに空で潰れる。招待が誰にも通らなければ（相手がオフライン等）
      // その記憶は二度と戻らず、手作業で誘い直すしかなくなる。
      // 保存が失敗しても棚の描画までは必ず進める（プライベートモードでは投げる）。
      if (others.length) {
        try { localStorage.setItem(LAST_PARTY_KEY, JSON.stringify(others)); } catch { /* ignore */ }
      }
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
    // 期限は「届いた時刻」から数える。順番待ちで遅れて出したときに 60秒が
    // まるごと延びると、サーバー側ではもう切れている招待に「参加する」を
    // 押せてしまう。
    const life = msg.expiresIn || 60000;
    const until = Date.now() + life;
    let modal = null;
    // 期限切れで自動的に閉じるが、先に答えたらタイマーを解除する。
    // 解除していなかったので、60秒後に「そのとき開いていた別のモーダル」を
    // 勝手に閉じていた（結果画面やショップの購入確認が消える）。
    const timer = setTimeout(() => {
      if (pendingInvite !== msg.inviteId) return;
      pendingInvite = null;
      // 自分の招待モーダルがまだ出ているときだけ閉じる。別のモーダルに
      // 差し替わったあとに closeModal() すると、それを巻き添えにする
      // （順番待ちに回してまだ出していない場合も同じ）。
      if (modal && modal.isConnected) closeModal();
    }, life);
    const answer = (type) => {
      clearTimeout(timer);
      pendingInvite = null;
      closeModal();
      sendWs({ type, inviteId: msg.inviteId });
    };
    const open = () => {
      if (pendingInvite !== msg.inviteId) return;   // もう答えた／期限切れ
      modal = showModal([
        `<h2>👥 ${t('パーティーに誘われました', 'Party invite')}</h2>`,
        `<p class="center"><b>${esc(msg.from)}</b> ${t('からのお誘いです', 'invited you')}</p>`,
        `<p class="muted center" style="font-size:12px">${msg.members}/${msg.max}</p>`,
        '<div class="modal-buttons">',
        `  <button class="btn btn-ghost" id="piNo">${t('ことわる', 'Decline')}</button>`,
        `  <button class="btn btn-primary" id="piYes">${t('参加する', 'Join')}</button>`,
        '</div>',
      ].join(''));
      modal.querySelector('#piYes').onclick = () => answer('party_invite_accept');
      modal.querySelector('#piNo').onclick = () => answer('party_invite_decline');
    };
    // 結果画面などが出ているあいだは割り込まない。サーバーの invite() は
    // 相手が対戦中かどうかを見ていないので、試合中でも結果表示中でも普通に届く。
    if (modalLocked()) {
      toast(t(`👥 ${msg.from} からパーティーのお誘いが届いています`,
        `👥 ${msg.from} invited you to a party`), 'announce', 4500);
      showLater(open, until);
      return;
    }
    open();
  });

  registerHandler('friend_request', msg => {
    toast(t(`🤝 ${msg.from} からフレンド申請が届きました`, `🤝 Friend request from ${msg.from}`), 'announce', 5000);
    // toast は数秒で消える。見逃してもナビの🤝に気づけるよう、ドットも点ける。
    // （静的 import にすると friends.js ⇄ party.js が循環するので動的に）
    import('./friends.js').then(f => f.noteFriendRequest()).catch(() => {});
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
    const open = () => {
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
    };
    // こちらも招待と同じ。結果画面を潰すと盤面から出られなくなる。
    // 合言葉は toast にも載せておく ── 順番待ちのまま見られなくても、
    // 「合言葉で入る」から自力で入れる。
    if (modalLocked()) {
      toast(t(`👥 部屋ができました（合言葉 ${msg.code}）`, `👥 The room is open — code ${msg.code}`), 'announce', 6000);
      // 招待と同じく期限を守る。until=0 のままだと順番待ちで数分寝かせた
      // モーダルが後から湧き、既に閉じた部屋への参加を押させてしまう。
      showLater(open, Date.now() + (msg.expiresIn || 60000));
      return;
    }
    open();
  });

  registerHandler('party_error', msg => { if (msg.error) toast(trServer(msg.error), 'err', 3000); });

  // 画面が変わったら描き直す。試合中とメニューで棚の姿が変わるので、
  // ここを見ていないと、試合に入っても開いた棚のまま盤面に重なる。
  const mo = new MutationObserver(() => { if (state) renderParty(); });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

  // 再接続したら状態を貼り直してもらう（サーバーが socketArrived で送る）。
  onWsReady(() => { if (state) renderParty(); });
}
