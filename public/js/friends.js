// 🤝 フレンド画面。
//
// 連絡は必ず申請制。申請に自由文は載せられない（載せられると、申請そのものが
// 嫌がらせの配達手段になる）。断ったことは相手に伝わらない。
// ブロックは片方向で、相手には一切見えない。
//
// 断りの文言はサーバー側でどの理由でも同じにしてある ── 理由を出し分けると、
// この窓口が「あの人にブロックされているか」を調べる道具になるので。

import { $, showScreen, showModal, closeModal, toast, fmt, enterIsLive } from './dom.js';
import { t } from './i18n.js';
import { audio } from './audio.js';
import { icon, medalIconName } from './icons.js';
import { session, api } from './net.js';
import { sendWs, onWsReady } from './chat.js';
import { createParty, joinParty, currentParty, lastPartyMembers } from './party.js';

let data = null;
let tab = 'list';

function esc(x) {
  return String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS = {
  menu: () => t('オンライン', 'Online'),
  // 🚪 ルームのロビーで待っている。以前はこれも「対戦中」に潰していたので、
  //    先に部屋を開けて呼ぶ、という一番自然な順番で招待が全部断られていた。
  room: () => t('ルームで待機中', 'In a room'),
  playing: () => t('対戦中', 'Playing'),
  offline: () => t('オフライン', 'Offline'),
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

// ---------------------------------------------------------------------------
// 🏁 ライバルボード（GET /api/friends/board）
//
// タブの器は index.html 側（担当外）に無いので、ここで一度だけ差し込む。
// 差し込みは createElement + textContent なので、既存タブの中身（#frReqDot）
// には一切触らない ── 静的i18nの textContent 代入でドットが消えた件と同じ罠を
// 踏まないための作法。
// ---------------------------------------------------------------------------

const BOARD_SECTIONS = [
  { key: 'daily', icon: 'mode_daily', ja: '今日のデイリー', en: "Today's Daily" },
  { key: 'weekly', icon: 'mode_weekly', ja: '今週のウィークリー', en: "This week's Weekly" },
  { key: 'rating', icon: 'seat_play', ja: 'レート', en: 'Rating' },
];

const CHALLENGE_COOLDOWN_MS = 60 * 60 * 1000;   // サーバーが返さなかったときの控えめな既定値
const challengeCooldown = new Map();            // userId -> 送れるようになる時刻

let boardData = null;
let boardLoading = false;
let boardError = null;    // 'na'（未実装） | 文字列（メッセージ） | null

// 桁区切りは他の画面と同じ fmt()（dom.js）に寄せる。ここだけ引数なしの
// toLocaleString() だったので、ブラウザの既定ロケールが de-DE などだと
// ライバル表の数字だけ "1.000"、他の画面は "1,000" と割れて見えていた。
function num(v) {
  const n = Number(v);
  return isFinite(n) ? fmt(n) : null;
}

function cdLabel(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return t(`${Math.floor(s / 3600)}時間`, `${Math.floor(s / 3600)}h`);
  if (s >= 60) return t(`${Math.floor(s / 60)}分`, `${Math.floor(s / 60)}m`);
  return t(`${s}秒`, `${s}s`);
}

function cooldownUntil(e) {
  const local = challengeCooldown.get(e.id) || 0;
  // サーバーが期限を持っているならそちらが正。無くても壊れない。
  const srv = Number(e.cooldownUntil || e.challengeUntil || e.nextChallengeAt || 0) || 0;
  return Math.max(local, srv);
}

function ensureRivalTab() {
  const tabs = document.querySelector('#screen-friends .tabs');
  if (!tabs || tabs.querySelector('[data-fr="rival"]')) return;
  const b = document.createElement('button');
  b.className = 'tab';
  b.dataset.fr = 'rival';
  b.textContent = t('ライバル', 'Rivals');
  const settings = tabs.querySelector('[data-fr="settings"]');
  if (settings) tabs.insertBefore(b, settings);
  else tabs.appendChild(b);
}

async function loadBoard(force = false) {
  if (boardLoading) return;
  if (boardData && !force) return;
  boardLoading = true;
  boardError = null;
  try {
    const r = await api('/api/friends/board');
    boardData = (r && typeof r === 'object') ? r : {};
  } catch (err) {
    boardData = null;
    // 404 は「サーバーがまだこの口を持っていない」。荒らさず静かに案内する。
    boardError = (err && err.status === 404) ? 'na' : ((err && err.message) || t('読み込めませんでした', 'Could not load'));
  } finally {
    boardLoading = false;
    if (tab === 'rival') renderFriends();
  }
}

// レスポンスの形が多少ぶれても落ちないように、部門ごとに拾い直す。
function sectionRows(key) {
  const b = boardData || {};
  const raw = b[key] || (b.boards && b.boards[key]) || [];
  return Array.isArray(raw) ? raw.filter(x => x && typeof x === 'object') : [];
}

function valueLabel(key, e) {
  if (key === 'rating') {
    const v = num(e.rating != null ? e.rating : e.value);
    return v == null ? t('—', '—') : v;
  }
  const raw = [e.score, e.best, e.value, e.points].find(x => x != null);
  const v = num(raw);
  return v == null ? t('未挑戦', 'No run') : t(`${v}点`, `${v} pts`);
}

// 📅 JSTの今日（server/adminevent.js の jstDayKey と同じ式）。
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function challengeBtn(key, e) {
  if (!e.id) return '';
  if (session.user && e.id === session.user.id) return '';
  // 🏁 **送れない理由が自分側にあるなら、押す前に言う。**
  //    サーバーは rivalBoard で canChallenge（＝自分に今日の記録があるか）を
  //    毎回返しているのに、画面が一度も読んでいなかった。押すと
  //    「今日のデイリーチャレンジの記録がまだありません」と赤トーストが出て、
  //    しかもそのボタンが60秒ロックされる ── すぐ遊んで戻ってきても送れない。
  if (boardData && boardData.canChallenge === false) {
    return `<button class="fr-b" disabled title="${t('先に今日のデイリーを遊んでください', 'Play today’s Daily first')}">${t('先にデイリー', 'Daily first')}</button>`;
  }
  const left = cooldownUntil(e) - Date.now();
  if (left > 0) {
    return `<button class="fr-b" disabled title="${t('しばらく送れません', 'On cooldown')}">${esc(cdLabel(left))}</button>`;
  }
  return `<button class="fr-b" data-chal="${esc(e.id)}" data-chalboard="${esc(key)}">${t('挑戦状', 'Challenge')}</button>`;
}

function boardRow(key, e, i) {
  const me = !!(session.user && e.id === session.user.id);
  // 🏅 サーバーが付けた**競技順位**（同点は同順位）を使う。配列の添字を
  //    そのまま順位にしていたので、まったく同じ点の2人に金と銀が割れていた。
  //    旧サーバー相手のときだけ添字に落とす。
  const rank = Number.isFinite(Number(e.rank)) && Number(e.rank) > 0 ? Number(e.rank) : i + 1;
  // 順位の絵は icons.js が唯一の引き口（medal_1/2/3）。4位以降は数字。
  const mi = medalIconName(rank);
  const medal = mi ? icon(mi, { size: 20 }) : `${rank}.`;
  return [
    `<div class="fr-row"${me ? ' style="border-color:rgba(255,255,255,0.28)"' : ''}>`,
    `  <span class="fr-lvl" style="min-width:26px;text-align:center">${medal}</span>`,
    `  <span class="fr-name">${esc(e.username || '???')}${me ? t('（あなた）', ' (you)') : ''}</span>`,
    `  <span class="fr-status" style="font-weight:800;color:var(--yellow)">${esc(valueLabel(key, e))}</span>`,
    `  <span class="fr-btns">${challengeBtn(key, e)}</span>`,
    '</div>',
  ].join('');
}

function viewRival() {
  if (!boardData && !boardLoading && !boardError) loadBoard();
  const head = [
    `<p class="muted" style="font-size:11.5px;line-height:1.6">${t(
      'デイリーもウィークリーも、<b>全員がまったく同じピース順</b>で挑んでいます。運の差はゼロ — ここに出ている差は、そのまま腕の差です。',
      'Daily and Weekly hand <b>every player the exact same pieces</b>. No luck involved — the gap you see here is pure skill.')}</p>`,
    `<div style="display:flex;justify-content:flex-end;margin:6px 0 2px">
       <button class="fr-b" id="frBoardReload">${t('更新', 'Refresh')}</button>
     </div>`,
  ].join('');

  if (boardLoading && !boardData) return head + `<p class="muted center" style="margin-top:20px">${t('読み込んでいます…', 'Loading…')}</p>`;
  if (boardError === 'na') {
    return head + `<p class="muted center" style="margin-top:20px">${t(
      'ライバルボードはまだ準備中です。もう少しお待ちください。',
      'The rival board is not available yet — please check back soon.')}</p>`;
  }
  if (boardError) return head + `<p class="muted center" style="margin-top:20px">${esc(boardError)}</p>`;

  const body = BOARD_SECTIONS.map(sec => {
    const rows = sectionRows(sec.key);
    const note = sec.key === 'rating'
      ? t('オンライン対戦の実力値', 'Your online battle rating')
      : t('全員共通のシード — 純粋な腕比べ', 'One shared seed — a pure test of skill');
    return [
      `<h3 class="fr-h">${icon(sec.icon, { size: 18 })} ${t(sec.ja, sec.en)} <span style="font-weight:600;text-transform:none;letter-spacing:0">— ${note}</span></h3>`,
      rows.length
        ? '<div class="fr-list">' + rows.map((e, i) => boardRow(sec.key, e, i)).join('') + '</div>'
        : `<p class="muted" style="font-size:11.5px">${t('まだ記録がありません。', 'No records yet.')}</p>`,
    ].join('');
  }).join('');

  const anyRows = BOARD_SECTIONS.some(sec => sectionRows(sec.key).length);
  if (!anyRows && !(data && data.friends && data.friends.length)) {
    return head + `<p class="muted center" style="margin-top:20px">${t(
      'フレンドがいると、ここで順位を競えます。「さがす」から申請してみましょう。',
      'Add friends to race them here. Send a request from “Find”.')}</p>`;
  }
  return head + body + `<p class="muted" style="font-size:11px;margin-top:14px">${t(
    '挑戦状は「今日は勝負しよう」という合図だけです。文章は付けられません。',
    'A challenge is just a nudge saying “race me today”. No message can be attached.')}</p>`;
}

async function sendChallenge(b) {
  if (!b || b.disabled) return;
  const id = b.dataset.chal;
  const key = b.dataset.chalboard || 'daily';
  if (!id) return;
  b.disabled = true;                       // 連打防止（レンダリングし直すまで戻さない）
  b.textContent = t('送信中…', 'Sending…');
  audio.click();
  try {
    const r = await api('/api/friends/challenge', { method: 'POST', body: { userId: id, board: key } });
    const until = Number(r && (r.cooldownUntil || r.until)) || (Date.now() + CHALLENGE_COOLDOWN_MS);
    challengeCooldown.set(id, until);
    toast(t('挑戦状を送りました', 'Challenge sent'), 'ok', 2400);
  } catch (err) {
    if (err && err.status === 404) {
      toast(t('挑戦状はまだ準備中です', 'Challenges are not available yet'), 'err', 2600);
      challengeCooldown.set(id, Date.now() + 60000);
    } else {
      toast((err && err.message) || t('送れませんでした', 'Could not send'), 'err', 3000);
      // ⚠ **断られた理由が自分側の事情なら、クールダウンを付けない。**
      //    「今日のデイリーの記録がまだありません」で弾かれた人は、すぐに
      //    デイリーを遊んで戻ってきても 60秒間送れなかった。
      //    （上の challengeBtn が先に止めるので普通はここまで来ないが、
      //     古い boardData を見ていたときの保険。）
      const mine = /記録がまだありません|no Daily Challenge record/i.test(String((err && err.message) || ''));
      if (!mine) challengeCooldown.set(id, Date.now() + 60000);
    }
  }
  if (tab === 'rival') renderFriends();
}

export async function openFriends(which = 'list') {
  if (!session.user) {
    toast(t('フレンド機能を使うにはアカウント登録が必要です', 'You need an account to use friends'), 'err', 3500);
    return;
  }
  tab = which;
  // 画面を開き直したら順位は取り直す（前に見た並びのまま出さない）。
  boardData = null;
  boardError = null;
  showScreen('friends');
  try { data = await api('/api/friends'); }
  catch (err) { toast(err.message, 'err'); return; }
  renderFriends();
}

// ---------------------------------------------------------------------------
// 🤝 ナビの通知ドット（#friendDot）
//
// index.html にはずっとドットの器があったのに、hidden を外す側がどこにも
// 無かった ── 申請に気づく手段は party.js の toast だけで、あれは「申請が
// 飛んだ瞬間にオンラインだった人」にしか出ない。サーバーはオフライン宛ての
// 通知をキューにも積まず黙って捨てるので、オフライン中に来た申請は自分から
// フレンド画面を開くまで一生見えないままだった。
// ミッションの refreshMissionDot と同じで、ここで数えて自分で点ける。
// （画面内タブの #frReqDot は前から動いている。壊れていたのはナビの方だけ）
// ---------------------------------------------------------------------------

let pendingCount = 0;

// 🚪 ログアウト・アカウント切替のときに呼ぶ。読み込み済みの他人の情報を捨てる。
//
// data には**フレンドの名前・レベル・在席状態**が、boardData には順位表が
// 入っている。持ち主が変わっても捨てていなかったので、ログアウトしたあとも
// 前の人のフレンド一覧がそのまま画面に残り、次に開いた人にも見えていた
// （画面は hidden を外し付けするだけで、中身を消していない）。
export function resetFriendsCache() {
  data = null;
  boardData = null;
  boardLoading = false;
  boardError = null;
  tab = 'list';
  challengeCooldown.clear();
  setFriendPending(0);
}

export function friendPending() { return pendingCount; }

function setFriendPending(n) {
  pendingCount = Math.max(0, Number(n) || 0);
  const dot = $('#friendDot');
  // i18n の言語切り替えでナビを組み直すときは .nav-dot をそのまま持ち回すので、
  // ここで付けた状態はちゃんと残る（outerHTML ごと差し込み直すため中身の数字も残る）。
  if (!dot) return;
  dot.classList.toggle('hidden', !pendingCount);
  // 件数まで出す（#missionDot と同じ形・同じ 9+ 打ち切り）。器は .nav-dot 共通で、
  // min-width と padding があるので数字がそのまま入る。
  // 数を出さないと「何か来ている」しか分からず、3件たまっていても1件だと思って
  // 捌き残す ── 申請は溜まると相手側の送信上限を食い潰すので、数が見える方がいい。
  dot.textContent = pendingCount > 9 ? '9+' : String(pendingCount || '');
}

// WS で申請が届いた瞬間に点ける（party.js の friend_request ハンドラから）。
// 数え直しを待たせない。
export function noteFriendRequest() { setFriendPending(pendingCount + 1); }

export async function refreshFriendDot() {
  if (!session.user) { setFriendPending(0); return; }
  try {
    const d = await api('/api/friends');
    // 申請と挑戦状は同じタブで捌くので、同じドットで数える。
    setFriendPending((d.incoming || []).length + (d.challenges || []).length);
  } catch { /* 取れなければ今の表示のまま。ドット1つのために画面は荒らさない */ }
}

// 数え直しの起点。起動直後は session.user がまだ入っていない ──
// main.js の refreshMe は非同期で、しかもコールドスタート対策で最大6回
// リトライする。一方 WS は localStorage のトークンをそのまま載せて先に
// つながるので、hello_ok（onWsReady）の方が早いことがある。入るまで少し待つ。
let bootTimer = null;
function refreshFriendDotSoon() {
  if (session.user) { refreshFriendDot(); return; }
  if (bootTimer) return;
  let waited = 0;
  bootTimer = setInterval(() => {
    if (session.user) { clearInterval(bootTimer); bootTimer = null; refreshFriendDot(); return; }
    if ((waited += 1000) >= 30000) { clearInterval(bootTimer); bootTimer = null; }   // 未ログインなら諦める
  }, 1000);
}

// ログイン直後は必ず chat がつなぎ直る（screens.js の reconnectChat）ので、
// そこで1回。以後はミッションのドットと同じ2分間隔で数え直す ──
// 自分が別の端末で捌いた申請も、これで消える。
onWsReady(refreshFriendDotSoon);
setInterval(() => { if (session.user) refreshFriendDot(); }, 120000);

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
  ensureRivalTab();
  document.querySelectorAll('#screen-friends [data-fr]').forEach(b => {
    b.classList.toggle('active', b.dataset.fr === tab);
    b.onclick = () => { audio.click(); setTab(b.dataset.fr); };
  });
  // 挑戦状もこのタブで捌くので、ドットの件数に足す（申請だけ数えていたので、
  // 挑戦状が届いても画面のどこにも印が出なかった）。
  const inc = (data.incoming || []).length + (data.challenges || []).length;
  const dot = $('#frReqDot');
  if (dot) dot.classList.toggle('hidden', !inc);
  // 画面を開いた／申請を捌いた時点の実数で、ナビのドットも合わせる。
  // （act() は毎回サーバーの最新を返すので、承認・拒否した瞬間に消える）
  setFriendPending(inc);

  if (tab === 'list') body.innerHTML = viewList();
  else if (tab === 'requests') body.innerHTML = viewRequests();
  else if (tab === 'find') body.innerHTML = viewFind();
  else if (tab === 'rival') body.innerHTML = viewRival();
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
      ? `<span>${t(`パーティー中（${p.members.length}/${p.max}）`, `In a party (${p.members.length}/${p.max})`)}</span>`
      : `<span>${t('パーティーを組むと、いっしょに遊べます', 'Make a party to play together')}</span>`,
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
  // 呼べば来られる人を上に。room はロビーで待っているだけなので menu の次。
  const order = { menu: 0, room: 1, playing: 2, offline: 3 };
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
  const chal = data.challenges || [];
  return [
    // 🔔 届いている挑戦状。
    //
    // サーバーは24時間の保管・上限20件・期限切れの掃除まで作ってあり、
    // /api/friends の応答にも毎回載っていたのに、**描く場所が public/js の
    // どこにも無かった**。挑戦状は誰にも見られないまま消え、送った側は成功
    // トーストと20時間のクールダウンだけを消費していた。
    chal.length ? [
      `<h3 class="fr-h">${t('届いている挑戦状', 'Challenges')}</h3>`,
      '<div class="fr-list">',
      chal.map(f => {
        // 🔔 挑戦状の行だけ専用に描く。汎用の row() は名前・Lv・在席しか出さないので、
        //    **追う点数がどこにも出ていなかった** ── 数字を知る手段は、送られた
        //    瞬間にたまたまオンラインだった人に出るトーストだけで、見逃すと
        //    24時間そのまま消える。サーバーは f.score / f.cleared / f.day を
        //    毎回載せているのに、一度も読んでいなかった。
        // 📅 日をまたいだ挑戦状は「受けて立つ」を止める。デイリーは日ごとに
        //    シードもピース順も違うので、今日の盤面で出した点を比べても意味がない
        //    （しかも1日1回勝負なのでやり直せない）。
        const stale = !!f.day && f.day !== jstToday();
        const goal = Number(f.score) || 0;
        return [
          '<div class="fr-row">',
          `  <span class="fr-name">${esc(f.username)}</span>`,
          `  <span class="fr-status" style="font-weight:800;color:var(--yellow)">${
            goal ? t(`${num(goal)}点`, `${num(goal)} pts`) : t('記録なし', 'no score')}${
            f.cleared ? ` <i style="color:var(--green)">${t('クリア', 'cleared')}</i>` : ''}${
            stale ? ` <i class="muted">${esc(f.day)}</i>` : ''}</span>`,
          '  <span class="fr-btns">',
          stale
            ? `<button class="fr-b" disabled title="${t('昨日のデイリーへの挑戦状です', 'This challenge is for a previous day’s Daily')}">${t('期限切れ', 'Expired')}</button>`
            : `<button class="fr-b ok" data-chalgo="${esc(f.day)}">${t('受けて立つ', 'Accept')}</button>`,
          `<button class="fr-b" data-chaldrop="${esc(f.id)}">${t('消す', 'Dismiss')}</button>`,
          '  </span>',
          '</div>',
        ].join('');
      }).join(''),
      '</div>',
      `<p class="muted" style="font-size:11px">${t(
        'デイリーは全員が同じ盤面・同じピース順です。同じ日のうちに挑めば、実力だけの勝負になります。',
        'The Daily uses the same board and piece order for everyone — take it on the same day for a fair contest.')}</p>`,
    ].join('') : '',
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

  // 🔔 届いた挑戦状
  //
  // 「受けて立つ」はメニューのデイリーへ送るだけにする。startDaily をここから
  // 呼ぶと friends.js → modes.js の import が増えて循環になりかねないので、
  // メニューのボタンを押す（挑戦状は当日ぶんなので、行き先は必ずこれで合う）。
  on('[data-chalgo]', () => {
    showScreen('menu');
    const btn = $('#btnDaily');
    if (btn) btn.click();
    else toast(t('メニューの「デイリー」から挑戦できます', 'Start it from “Daily” on the menu'), '', 3000);
  });
  on('[data-chaldrop]', b => act('/api/friends/challenge/dismiss', { userId: b.dataset.chaldrop }));

  // 🏁 ライバルボード
  on('[data-chal]', b => sendChallenge(b));
  const reload = body.querySelector('#frBoardReload');
  if (reload) reload.onclick = () => { audio.click(); loadBoard(true); renderFriends(); };

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
          // ⚠ **検索結果を消さない。** 成否にかかわらず setTab('find') を呼んでいたので、
          //    タブごと描き直されて #frResult が空に戻り、名前を一から打ち直しになっていた。
          //    この世界では申請が通らないことのほうが多いので、同じ打ち直しを何度も踏む。
          //    チャットのプロフィールカード（chat.js の askFriend）は最初から
          //    「カードは残し、ボタンだけ戻す」形なので、窓口によって後始末が違っていた。
          if (ok) {
            toast(t('申請を送りました', 'Request sent'), 'ok');
            b.replaceWith(Object.assign(document.createElement('span'), {
              className: 'muted', textContent: t('申請ずみ', 'Requested'),
            }));
          } else {
            b.disabled = false;   // 断られた ── もう一度押せるように戻すだけ
          }
        };
      });
    } catch (err) { out.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  };
  const nameInput = body.querySelector('#frName');
  if (nameInput) nameInput.onkeydown = e => { if (enterIsLive(e)) search.click(); };

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
