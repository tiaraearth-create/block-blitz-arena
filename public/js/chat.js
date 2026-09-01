// Global chat: persistent WebSocket + drawer UI on the menu screen.
import { session } from './net.js';
import { $, toast, showModal, closeModal, rankBadge } from './dom.js';
// 段位もバッジも「絵を持つ側」は1か所だけ。ここには表を置かない。
import { icon, badgeIconName } from './icons.js';
import { audio } from './audio.js';
import { t, trServer, LANG, catName } from './i18n.js';
import { getSettings } from './settings.js';

let ws = null;
let open = false;
let unread = 0;
let retryMs = 3000;
let retryTimer = null;   // 再接続待ちのタイマー。張り直すときは必ず取り消す。

// ---------------------------------------------------------------------------
// Live feed: a ticker on the menu showing what is happening around the arena
// (everyone's notable moments, shown the same way — see showTicker for why
//  the ⭐ that used to mark real players is gone).
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
  // 以前は item.real（本物のプレイヤーの快挙）に ⭐ を付けていたが、
  // サーバーが real を配らなくなった ── ⭐が付かない行＝住人、という
  // 一覧表になっていたため。誰の出来事も同じ見た目で流す。
  txt.textContent = `${item.icon} ${feedText(item)}`;
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
  // 初回接続時にフィードが空だと hello_ok 側の cycleTicker() が呼ばれず、
  // 以後 feed が来ても自動循環タイマーが張られないまま止まる。未始動ならここで張る。
  if (!tickerTimer) cycleTicker();
}

export function getFeed() { return feed.slice(); }

export function showFeedModal() {
  audio.click();
  const items = feed.slice().reverse();
  const m = showModal(`
    <h2>📡 ${t('ライブフィード', 'Live Feed')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">${t('アリーナで今起きていること', 'What is happening around the arena right now')}</p>
    <div class="feed-list">
      ${items.length ? items.map(it => `
        <div class="feed-row">
          <span class="feed-icon">${it.icon || '📡'}</span>
          <span class="feed-text">${escapeHtml(feedText(it))}</span>
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

// ---------------------------------------------------------------------------
// Reactions (絵文字スタンプ) + replies + name-tap profile cards
// ---------------------------------------------------------------------------

const REACT_EMOJI = ['👍', '😂', '🔥', '💖', '😮', '🎉', '😭', '👏'];
let replyTarget = null;   // { id, from, text }

function sendReact(msgId, emoji) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !msgId) return;
  ws.send(JSON.stringify({ type: 'react', msgId, emoji }));
  audio.click();
}

function renderReacts(el, reacts) {
  const row = el.querySelector('.cm-reacts');
  if (!row) return;
  const entries = Object.entries(reacts || {}).filter(([, names]) => names.length);
  row.innerHTML = entries.map(([emoji, names]) =>
    `<button class="cm-react-chip" data-re="${emoji}" title="${escapeHtml(names.join('、'))}">${emoji}<b>${names.length}</b></button>`).join('');
  row.classList.toggle('hidden', !entries.length);
  row.querySelectorAll('[data-re]').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); sendReact(el.dataset.id, b.dataset.re); };
  });
}

function closeMsgActions() {
  document.querySelectorAll('.cm-actions').forEach(x => x.remove());
}

function showMsgActions(el, msg) {
  const existing = el.querySelector('.cm-actions');
  closeMsgActions();
  if (existing) return;   // tap again = close
  const bar = document.createElement('div');
  bar.className = 'cm-actions';
  bar.innerHTML = REACT_EMOJI.map(e => `<button data-re="${e}">${e}</button>`).join('')
    + `<button class="cm-act-reply" data-reply>↩ ${t('返信', 'Reply')}</button>`;
  el.appendChild(bar);
  bar.querySelectorAll('[data-re]').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); sendReact(msg.id, b.dataset.re); closeMsgActions(); };
  });
  bar.querySelector('[data-reply]').onclick = ev => { ev.stopPropagation(); startReply(msg); closeMsgActions(); };
}

function startReply(msg) {
  replyTarget = { id: msg.id, from: msg.from, text: msg.text };
  const bar = $('#chatReplyBar');
  $('#chatReplyText').textContent = `↩ ${msg.from}: ${msg.text.slice(0, 40)}`;
  bar.classList.remove('hidden');
  $('#chatInput').focus();
}

function cancelReply() {
  replyTarget = null;
  $('#chatReplyBar').classList.add('hidden');
}

// バッジの絵。ここには表を置かない ── icons.js の badgeIconName(id) が唯一の
// 引き口で、シーズン刻印（s{N}champ）の畳み込みもあちらが持っている。
//
// なぜ表を消したか: 以前はこのファイルにも screens.js にも同じ絵文字表があり
// （合わせて6か所）、片方だけ更新されるたびに「同じバッジが画面ごとに違って
// 見える」が起きていた。絵文字そのものにも重複があって、👑 が管理者イベント・
// 二冠・三冠・五冠の4つ、🎖️ がギルドの誉れと「表に無い全部」の受け皿を
// 兼ねていたので、チャットのプロフィールカードでは見分けが付かなかった。
// 表を持たなければ、ズレようがない。
function profileBadgeIcon(id) {
  return icon(badgeIconName(id), { size: 18 });
}
// 👑 王座のボード名（プロフィールカード表示用）
const THRONE_LABELS = {
  score: ['スコア', 'Score'], rating: ['レート', 'Rating'], sprint: ['タイムアタック', 'Time Attack'],
  dungeon: ['ダンジョン', 'Dungeon'], weekly: ['ウィークリー', 'Weekly'],
  puzzle: ['パズル遺跡', 'Puzzle Ruins'], dig: ['採掘場', 'The Mines'],
};

async function showProfileCard(name) {
  audio.click();
  let p;
  // api() を通していないのは 404 を「エラー」ではなく普通の案内にしたいから。
  // そのぶんタイムアウトも自前で持つ ── 付けていなかった頃は、返らない回線で
  // 名前をタップしても何も出ないまま無反応だった（net.js の api() と同じ話）。
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, 10000) : null;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(name)}`, { signal: ctrl ? ctrl.signal : undefined });
    if (res.status === 404) {
      // 未登録のゲストプレイヤー — エラーではなく普通の案内にする。
      toast(t(`${name} はゲストプレイヤーです`, `${name} is a guest player`), '', 2000);
      return;
    }
    if (!res.ok) throw new Error();
    p = (await res.json()).profile;
  } catch {
    toast(t('プロフィールを取得できません', 'Could not load the profile'), 'err', 1600);
    return;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (p.kind === 'guest') {
    toast(t(`${p.name} はゲストプレイヤーです`, `${p.name} is a guest player`), '', 2000);
    return;
  }
  // 段位の絵。しきい値をここに書かない ── public/js/ranks.js が唯一の正解。
  // 以前はこの1行が 1700 以上を全部 👑 に丸める6帯ぶんの表を持っていたので、
  // 帯がグランドマスター（1900）とレジェンド（2100）まで広がったあとも、
  // チャットのプロフィールカードだけが3帯を同じ絵で出していた。
  const rk = rankBadge(p.rating, { withName: false, size: 15 });
  const m = showModal(`
    <div class="profile-card">
      <div class="pc-head">
        <span class="pc-avatar">${p.kind === 'resident' ? '🎭' : p.role === 'admin' ? '🛡️' : '😀'}</span>
        <div class="pc-id">
          <b class="${(p.thrones || []).length ? `crowned${Math.min(3, p.thrones.length)}` : ''}">${p.guildTag ? `<span class="lb-tag">[${escapeHtml(p.guildTag)}]</span>` : ''}${escapeHtml(p.name)}</b>
          ${p.title ? `<span class="pc-title" style="color:${escapeHtml(p.title.color || '#fff')}">《${escapeHtml(p.title.id ? catName(p.title) : p.title.name)}》</span>` : ''}
          <small class="muted">${p.kind === 'resident'
            ? `${escapeHtml((LANG === 'en' && p.archLabelEn) || p.archLabel || '')} ・ ${p.online
              ? t('🟢 オンライン', '🟢 online')
              // 出現時間帯もチャットのタイムスタンプと同じ時計で出す（fmtClockHM）。
              // 英語だけ 24時間制で残っていたので、同じ画面の中で時計が2種類あった。
              : (p.hours
                ? t(`⚫ ${fmtClockHM(p.hours[0])}〜${fmtClockHM(p.hours[1])}に出現`,
                  `⚫ appears ${fmtClockHM(p.hours[0])}–${fmtClockHM(p.hours[1])}`)
                : t('⚫ オフライン', '⚫ offline'))}`
            : t(`Lv.${p.level} プレイヤー`, `Level ${p.level} player`)}</small>
        </div>
      </div>
      <div class="pc-grid">
        <div class="pc-stat"><b>${rk}${fmtNum(p.rating)}</b><span>${t('レート', 'Rating')}</span></div>
        <div class="pc-stat"><b>${fmtNum(p.bestScore)}</b><span>${t('ベストスコア', 'Best score')}</span></div>
        <div class="pc-stat"><b>${fmtNum(p.pvpWins)}${t('勝', 'W')}${fmtNum(p.pvpLosses)}${t('敗', 'L')}</b><span>${t('オンライン対戦', 'Online battles')}</span></div>
        <div class="pc-stat"><b>F${fmtNum(p.dungeonMax)}</b><span>${t('ダンジョン', 'Dungeon')}</span></div>
      </div>
      ${(p.thrones || []).length ? `<p class="center pc-thrones">👑 ${p.thrones.map(b => THRONE_LABELS[b] ? t(THRONE_LABELS[b][0], THRONE_LABELS[b][1]) : b).join(' ・ ')} ${t('王者', 'Champion')}</p>` : ''}
      ${(p.badges || []).length ? `<p class="center pc-badges">${p.badges.map(b => profileBadgeIcon(b)).join(' ')}</p>` : ''}
      ${p.kind === 'resident' ? `<p class="muted center" style="font-size:11px">🛡️ ${t('運営のみ表示 ・ 住人アカウント', 'Staff only ・ resident account')}</p>` : ''}
    </div>
    <div class="modal-buttons"><button class="btn btn-primary" id="pcClose">${t('閉じる', 'Close')}</button></div>`);
  m.querySelector('#pcClose').onclick = closeModal;
}

function fmtNum(n) { return Number(n || 0).toLocaleString('ja-JP'); }

// ---------------------------------------------------------------------------
// 🕐 時計の書式は必ずここを通す。
//
// 画面ごとに 12時間制と 24時間制が混ざっていて、同じアプリを行き来しながら
// どちらの時計を読んでいるのか分からなくなっていた（チャットのタイムスタンプと
// 住人の出現時間帯は 24時間制、イベント予告だけ 12時間制）。しかも予告側は
// `hour:'2-digit'` を渡していたので en-US でも "08:00 PM" とゼロ埋めされていて、
// 英語としては読まない書き方だった（"8:00 PM" が普通）。
//
// 決めごと: 日本語は 24時間制の HH:MM、英語は 12時間制の "8:00 PM"。
// サーバー側の内部表現（server/adminevent.js の分単位・"HH:MM"）はそのまま
// 24時間制でよい ── 表示の直前にこれを通すこと。
export function fmtClockHM(hour, minute = 0) {
  const h = ((Math.floor(Number(hour) || 0) % 24) + 24) % 24;
  const raw = Math.floor(Number(minute) || 0);
  const mm = String(Math.max(0, Math.min(59, raw))).padStart(2, '0');
  if (LANG === 'en') {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return `${String(h).padStart(2, '0')}:${mm}`;
}
// Date（またはミリ秒）から。
export function fmtClock(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d.getTime())) return '';
  return fmtClockHM(d.getHours(), d.getMinutes());
}
// サーバーが返す "HH:MM"（管理者イベントの枠時刻など）から。
// 読めない形はそのまま返す ── 表示のために落ちるほうが困る。
export function fmtClockStr(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s == null ? '' : s));
  return m ? fmtClockHM(Number(m[1]), Number(m[2])) : String(s == null ? '' : s);
}

// box を差し替えられるようにしてある。パーティー欄へ流すために、
// 同じ描画をもう1本書き写すのを避ける。
function appendMsg(msg, scroll = true, box = $('#chatMsgs')) {
  const el = document.createElement('div');
  const me = session.user && msg.from === session.user.username;
  const isAdmin = msg.role === 'admin';
  const isMod = msg.role === 'mod';
  // 👁️ 管理者ゼロ。イベントの敵役なので、ふつうの発言とは別物に見せる。
  // 名前はサーバー側で予約されているので、これを騙る発言は存在しない。
  const isZero = msg.role === 'zero';
  el.className = `chat-msg ${me ? 'mine' : ''} ${isAdmin ? 'admin-msg' : ''} ${isZero ? 'zero-msg' : ''}`;
  if (msg.id) el.dataset.id = msg.id;
  const clock = fmtClock(msg.at || Date.now());
  const useTr = getSettings().chatTranslate && msg.tr && msg.tr.lang === LANG && msgLang(msg.text) !== LANG && !me;
  const tag = msg.tag ? `<span class="cm-tag">[${escapeHtml(msg.tag)}]</span>` : '';
  const reply = msg.reply ? `<span class="cm-reply">↩ <b>${escapeHtml(msg.reply.from)}</b> ${escapeHtml(msg.reply.text)}</span>` : '';
  el.innerHTML = `
    <span class="cm-meta">${tag}<button class="cm-name ${isAdmin ? 'cm-admin' : ''} ${isZero ? 'cm-zero' : ''} ${Number(msg.crown) ? `crowned${Math.min(3, Number(msg.crown))}` : ''}">${msg.crown ? '👑' : ''}${isZero ? '👁️' : isAdmin ? '🛡️' : isMod ? '🔧' : ''}${escapeHtml(msg.from)}</button> ・ ${clock}</span>
    ${reply}
    <span class="cm-bubble">${escapeHtml(useTr ? msg.tr.text : msg.text)}</span>
    ${useTr ? `<button class="cm-tr" title="${t('原文を表示', 'Show original')}">🌐 ${msg.tr.engine !== 'table' ? t('翻訳', 'translated') : t('簡易翻訳', 'auto-translated')} ・ ${t('原文', 'original')}</button>` : ''}
    <span class="cm-reacts hidden"></span>`;
  if (useTr) {
    const btn = el.querySelector('.cm-tr');
    const bubble = el.querySelector('.cm-bubble');
    let showingOriginal = false;
    btn.onclick = ev => {
      ev.stopPropagation();
      showingOriginal = !showingOriginal;
      bubble.textContent = showingOriginal ? msg.text : msg.tr.text;
      btn.textContent = showingOriginal ? `🌐 ${t('翻訳を表示', 'Show translation')}` : `🌐 ${msg.tr.engine !== 'table' ? t('翻訳', 'translated') : t('簡易翻訳', 'auto-translated')} ・ ${t('原文', 'original')}`;
    };
  }
  // タップでリアクション/返信。名前タップでプロフィールカード。
  el.querySelector('.cm-name').onclick = ev => { ev.stopPropagation(); showProfileCard(msg.from); };
  if (msg.id) {
    el.querySelector('.cm-bubble').onclick = ev => { ev.stopPropagation(); showMsgActions(el, msg); };
  }
  if (msg.reacts) renderReacts(el, msg.reacts);
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

// 古いソケットを完全に畳む。ハンドラを外してから閉じるのが要点 ──
// 外さずに閉じると、その拍子に onclose が走って再接続タイマーがもう1本増える。
function dropSocket(sock) {
  if (!sock) return;
  sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
  try { sock.close(); } catch { /* ignore */ }
}

function connect() {
  // 張り直す前に、前のソケットと再接続待ちのタイマーを必ず畳む。
  // これをしないと「切断→再接続待ちの3秒間にログイン／ログアウト」で
  // ws が上書きされ、前のソケットが誰にも閉じられないまま OPEN で生き残る。
  // 生き残ったソケットの onmessage も動いたままなので、同じ発言が2回ずつ
  // チャット欄に出るし、サーバーからは別人として数えられてオンライン人数も
  // 水増しされる。繰り返すと同一アカウントの接続本数の上限に達して弾かれる。
  clearTimeout(retryTimer);
  retryTimer = null;
  dropSocket(ws);
  ws = null;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // ハンドラはモジュール変数 ws ではなくこのローカルだけを触る。ws を見ていた
  // 頃は、取り残された古いソケットの onerror が「今つながっている方」を
  // 閉じてしまっていた。
  let sock;
  try {
    sock = new WebSocket(`${proto}://${location.host}/ws`);
  } catch { scheduleReconnect(); return; }
  ws = sock;

  sock.onopen = () => {
    retryMs = 3000;
    sock.send(JSON.stringify({
      type: 'hello',
      token: session.token,
      guestName: localStorage.getItem('bba_guest_name') || undefined,
    }));
  };
  sock.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello_ok') {
      cancelReply();   // 再接続で返信先メッセージは失効している
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
      for (const fn of readyHandlers) { try { fn(); } catch (err) { console.error('[chat] ready', err); } }
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
      cancelReply();
    } else if (msg.type === 'chat') {
      appendMsg(msg);
      if (!open) setUnread(unread + 1);
    } else if (msg.type === 'react') {
      const el = document.querySelector(`.chat-msg[data-id="${msg.msgId}"]`);
      if (el) renderReacts(el, msg.reacts);
    } else if (msg.type === 'server_shutdown') {
      // 更新でサーバーが落ちる。対戦はサーバー側が引き分けで畳んでくれるので、
      // こちらはソロなどの「まだ結果を送っていない run」を今のうちに確定させる。
      // これをやらないと、終了時の送信が失敗して1回ぶんの記録が黙って消える。
      toast(t('🔧 アップデートのためサーバーを更新します。プレイ中の記録を保存しました',
        '🔧 The server is updating. Your current run has been saved'), 'announce', 6000);
      if (window.__bbaSaveNow) window.__bbaSaveNow();
    } else if (msg.type === 'announce') {
      appendMsg({ from: msg.from || t('運営', 'Staff'), role: 'admin', text: `📢 ${LANG === 'en' && msg.messageEn ? msg.messageEn : msg.message}`, at: Date.now() });
    } else if (extraHandlers.has(msg.type)) {
      // パーティー系はここで受ける。常時つながっているこの socket に
      // 相乗りさせるのが、メニュー→ソロ→対戦とパーティーがついてくる理由。
      for (const fn of extraHandlers.get(msg.type)) {
        try { fn(msg); } catch (err) { console.error('[chat] handler', msg.type, err); }
      }
    } else if (msg.type === 'error') {
      toast(trServer(msg.error), 'err', 1800);
    }
  };
  // 今つながっている1本が落ちたときだけ再接続する。
  sock.onclose = () => { if (ws === sock) scheduleReconnect(); };
  sock.onerror = () => { try { sock.close(); } catch { /* ignore */ } };
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
  // ハンドルを持っておく。持っていなかった頃は、待っている間に connect() が
  // 別経路から呼ばれてもこのタイマーを止められず、あとから発火して2本目を
  // 張ってしまっていた。
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryMs);
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
  ws.send(JSON.stringify({ type: 'chat', text, ...(replyTarget ? { replyTo: replyTarget.id } : {}) }));
  cancelReply();
  input.value = '';
  audio.click();
}

// 他のモジュール（パーティー）がこの常時接続を使うための口。
// 1つの種類に複数の受け手を許す。set で上書きにしていた頃は、
// 後から登録した側が前の受け手を黙って消してしまい、
// 「サーバーは送っているのに画面が反応しない」が起きた。
const extraHandlers = new Map();   // type -> Set<fn>
const readyHandlers = new Set();
export function onWsReady(fn) { readyHandlers.add(fn); if (wsReady()) fn(); }
export function registerHandler(type, fn) {
  let set = extraHandlers.get(type);
  if (!set) { set = new Set(); extraHandlers.set(type, set); }
  set.add(fn);
  return () => set.delete(fn);
}
export function sendWs(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}
export function wsReady() { return !!ws && ws.readyState === WebSocket.OPEN; }

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
  $('#chatReplyCancel').onclick = cancelReply;
  // メッセージ外をタップしたらアクションバーを閉じる。
  $('#chatMsgs').addEventListener('click', () => closeMsgActions());
  connect();
}

// Reconnect with the fresh identity after login/logout.
// 古いソケットと再接続待ちのタイマーの後始末は connect() の冒頭がまとめて
// やる ── ここで別に畳んでいた頃は、保留中のタイマーだけ取り消し忘れていた。
export function reconnectChat() {
  connect();
}
