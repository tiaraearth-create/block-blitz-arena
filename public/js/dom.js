// Small DOM helpers: screen router, toasts, modals, top bar.
import { session } from './net.js';
import { t } from './i18n.js';

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

const SCREENS = ['menu', 'game', 'matchmaking', 'room', 'leaderboard', 'shop', 'inventory', 'battlepass', 'missions', 'friends', 'guild', 'news', 'admin'];

// 画面の履歴。端末の「戻る」と、画面左上の「←」の両方がこれを使う。
// 以前はどちらも menu 直行で、しかも履歴を1つも積んでいなかったので、
// Android では戻るを押すとアプリごと閉じていた（PWA は standalone）。
const screenStack = [];
let poppingBack = false;

export function screenHistory() { return screenStack.slice(); }

let historyReady = false;

export function showScreen(name, { push = true } = {}) {
  const prev = document.body.dataset.screen;
  for (const s of SCREENS) {
    const el = $(`#screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  }
  document.body.dataset.screen = name;   // used by CSS (e.g. chat drawer on menu only)

  // メニューはいちばん下。ここに来たら積み上げを畳む ── そうしないと
  // 「メニュー→ショップ→メニュー」で戻り先にメニューが溜まっていき、
  // 戻るを何度押してもメニューのまま、という状態になる。
  if (name === 'menu') screenStack.length = 0;

  if (!push || poppingBack || prev === name) return;
  // 終わった試合には戻れない（動かない盤面に取り残される）。
  // メニューへ戻るときも積まない。片方だけ積むと端末の履歴とズレるので、
  // 「戻り先」と「履歴」はいつも一緒に積む／一緒に積まない。
  if (!prev || prev === 'game' || name === 'menu') return;
  screenStack.push(prev);
  if (screenStack.length > 24) screenStack.shift();
  try { history.pushState({ bbaScreen: name }, ''); } catch { /* file:// など */ }
}

// マッチング画面とカスタムルームは、画面を離れるときに後始末が要る画面。
// 画面を差し替えるだけだとサーバー側ではキュー／ルームに並んだままで、
// メニューを見ているのに match_found が飛んできて突然対戦画面へ引きずり込まれる
// （放置すれば敗北扱い）。カスタムルームなら他の参加者にゴーストが残り、
// ホストが開始すると勝手に試合が始まる。しかも画面の「キャンセル」「←」は
// メニューの裏に隠れて押せない。
//
// 後始末の中身をここに書き写すとボタン側と食い違っていくので、その画面が
// 持っている離脱ボタンをそのまま押す。押した先は endToMenu() まで走って
// メニューを出すので、戻り先の差し替えはこちらでやらない。
// 戻り値は「後始末つきで画面を移せた」かどうか。
function leaveViaScreenButton() {
  const screen = document.body.dataset.screen;
  const btn = screen === 'matchmaking' ? $('#btnCancelQueue')
    : screen === 'room' ? $('#btnRoomBack')
    : null;
  if (!btn) return false;
  btn.click();
  // ハンドラが未接続などで画面が動かなかったときは、通常の戻りに任せる。
  return document.body.dataset.screen !== screen;
}

// 画面の「←」。端末の戻るとまったく同じ道を通す ──
// ここで画面だけ動かすと履歴が1つ余り、次に端末の戻るを押したときに
// 何も起きない（ズレたぶんを消費するだけ）という挙動になる。
export function goBack(onGameBack) {
  if (document.body.dataset.screen === 'game') {
    if (onGameBack) { onGameBack(); return true; }
    return false;
  }
  if (historyReady && screenStack.length) { history.back(); return true; }
  if (leaveViaScreenButton()) return true;
  const to = screenStack.pop() || 'menu';
  poppingBack = true;
  showScreen(to, { push: false });
  poppingBack = false;
  return true;
}

// 端末の戻る（Android のジェスチャー／ハードキー、ブラウザの ←）。
// popstate が来た時点で履歴は1つ減っているので、こちらは画面を合わせるだけ。
export function initHistory(onGameBack) {
  historyReady = true;
  try { history.replaceState({ bbaScreen: document.body.dataset.screen || 'menu' }, ''); } catch { /* ignore */ }
  window.addEventListener('popstate', () => {
    // モーダルが開いているなら、まずそれを閉じる（いちばん自然な戻り先）。
    // ただし閉じられない印のあるモーダル（結果画面など）は閉じない ──
    // 閉じると動かない盤面に取り残される。
    const modal = $('#modal-root');
    if (modal && modal.firstChild) {
      const locked = modal.querySelector('.modal-backdrop[data-locked]');
      if (!locked) { closeModal(); repush(); return; }
      repush();
      return;
    }
    if (document.body.dataset.screen === 'game') {
      // 試合中は閉じない。✕ と同じ確認を出して、履歴だけ積み直す。
      repush();
      if (onGameBack) onGameBack();
      return;
    }
    // キュー／ルームからは必ず抜けてから出る。抜けた先はメニューなので、
    // 履歴も積み直さない（次の戻るでアプリを閉じてよい）。
    if (leaveViaScreenButton()) return;
    const to = screenStack.pop() || 'menu';
    poppingBack = true;
    showScreen(to, { push: false });
    poppingBack = false;
    // menu まで戻ったら、次の戻るでアプリを閉じてよい（＝積み直さない）。
    if (to !== 'menu') repush();
  });
}

function repush() {
  try { history.pushState({ bbaScreen: document.body.dataset.screen || 'menu' }, ''); } catch { /* ignore */ }
}

export function toast(message, kind = '', ms = 2600) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

export function showModal(html, { dismissable = true, peekable = false } = {}) {
  closeModal();
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  // 閉じられないモーダルには印を付ける。端末の「戻る」がこれを見て、
  // 結果画面などを勝手に閉じないようにする（閉じると動かない盤面に
  // 取り残される）。
  if (!dismissable) backdrop.dataset.locked = '1';
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  if (dismissable) {
    backdrop.addEventListener('pointerdown', e => {
      if (e.target === backdrop) closeModal();
    });
  }
  root.appendChild(backdrop);
  const modal = backdrop.querySelector('.modal');
  if (peekable) attachPeekButton(root, backdrop, modal);
  return modal;
}

// 結果モーダルの「👁」。押しているあいだだけ #modal-root（とその中の
// .modal-backdrop）に `.peeking` が付き、モーダルが透けて後ろの盤面
// ＝どう詰んだのかが見える。見た目は CSS 側（`.peeking` / `.modal-peek-btn`）。
//
// 「押している間だけ」なので pointerup を取り逃すと透けたまま固まる。
// ボタン自身の pointerup/pointercancel だけでなく、ポインタ捕捉と window の
// 保険、キーボード操作（Space / Enter を押しっぱなし）、フォーカス外れまで
// すべて解除に繋いである。
function attachPeekButton(root, backdrop, modal) {
  if (!modal) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'modal-peek-btn';
  btn.textContent = '👁';
  const label = t('押している間だけ盤面を見る', 'Hold to peek at the board');
  btn.title = label;
  btn.setAttribute('aria-label', label);

  let peeking = false;
  const end = () => {
    if (!peeking) return;
    peeking = false;
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    root.classList.remove('peeking');
    backdrop.classList.remove('peeking');
  };
  const start = e => {
    // タッチの長押しメニューやスクロールに持っていかれないようにする。
    if (e && e.cancelable) e.preventDefault();
    if (e && e.pointerId != null) {
      try { btn.setPointerCapture(e.pointerId); } catch { /* 非対応環境 */ }
    }
    if (peeking) return;
    peeking = true;
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    root.classList.add('peeking');
    backdrop.classList.add('peeking');
  };

  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('lostpointercapture', end);
  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); start(); }
  });
  btn.addEventListener('keyup', e => {
    if (e.key === ' ' || e.key === 'Enter') end();
  });
  btn.addEventListener('blur', end);
  modal.appendChild(btn);
}

export function closeModal() {
  const root = $('#modal-root');
  // 覗き見中に閉じた場合の保険（透けたままの印を残さない）。
  root.classList.remove('peeking');
  root.innerHTML = '';
}

export function countdownOverlay(n, onDone, audio) {
  const el = document.createElement('div');
  el.className = 'countdown-overlay';
  document.body.appendChild(el);
  let i = n;
  const step = () => {
    if (i <= 0) {
      el.innerHTML = `<div class="countdown-num" style="color:#5ee86e">GO!</div>`;
      if (audio) audio.countdown(true);
      setTimeout(() => { el.remove(); onDone(); }, 600);
      return;
    }
    el.innerHTML = `<div class="countdown-num">${i}</div>`;
    if (audio) audio.countdown(false);
    i--;
    setTimeout(step, 900);
  };
  step();
}

export function fmt(n) { return Number(n).toLocaleString('ja-JP'); }

// ---------------------------------------------------------------------------
// Staff-only UI switch
//
// Admins get extras normal players never see (chaos access outside events,
// autopilot, the in-game command palette). Those stay on by default but can be
// hidden so an admin can look at the game exactly as a player does.
// ---------------------------------------------------------------------------

const STAFF_UI_KEY = 'bba_staff_ui';

export function staffUiOn() { return localStorage.getItem(STAFF_UI_KEY) !== '0'; }
export function setStaffUi(on) { localStorage.setItem(STAFF_UI_KEY, on ? '1' : '0'); }

// True when the current user is staff AND wants to see staff-only controls.
export function staffExtras() {
  const u = session.user;
  return !!u && (u.role === 'admin') && staffUiOn();
}

// Competitive rank tier for a rating value (shown next to ratings everywhere).
export function rankOf(rating) {
  const r = Number(rating) || 0;
  return r >= 1700 ? { name: 'マスター', nameEn: 'Master', icon: '👑', color: '#ffd75e' }
    : r >= 1500 ? { name: 'ダイヤ', nameEn: 'Diamond', icon: '💎', color: '#43d9e8' }
    : r >= 1300 ? { name: 'プラチナ', nameEn: 'Platinum', icon: '💠', color: '#9fd8ff' }
    : r >= 1100 ? { name: 'ゴールド', nameEn: 'Gold', icon: '🥇', color: '#ffd75e' }
    : r >= 950 ? { name: 'シルバー', nameEn: 'Silver', icon: '🥈', color: '#c9d2e8' }
    : { name: 'ブロンズ', nameEn: 'Bronze', icon: '🥉', color: '#d8a05a' };
}

// Lightweight DOM confetti celebration (used on wins / big unlocks).
export function confettiBurst(count = 40) {
  const colors = ['#ff5d5d', '#ffa93d', '#ffe14d', '#5ee86e', '#43d9e8', '#5b8bff', '#b06bff', '#ff6bd4'];
  const root = document.createElement('div');
  root.className = 'dom-confetti';
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[(Math.random() * colors.length) | 0];
    s.style.width = s.style.height = `${6 + Math.random() * 8}px`;
    s.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    s.style.animationDelay = `${Math.random() * 0.5}s`;
    if (Math.random() < 0.4) s.style.borderRadius = '50%';
    root.appendChild(s);
  }
  document.body.appendChild(root);
  setTimeout(() => root.remove(), 3600);
}

export function updateTopbar() {
  const u = session.user;
  $('#userName').textContent = u ? u.username : t('ゲスト', 'Guest');
  $('#userAvatar').textContent = u ? (u.role === 'admin' ? '🛡️' : u.role === 'mod' ? '🔧' : '😀') : '👤';
  // Admins run on infinite money.
  const inf = u && u.role === 'admin';
  $('#coinsLabel').textContent = inf ? '∞' : fmt(u ? u.coins : 0);
  $('#gemsLabel').textContent = inf ? '∞' : fmt(u ? u.gems : 0);
  const lvl = $('#userLevel');
  if (u) { lvl.classList.remove('hidden'); lvl.textContent = `Lv.${u.level}`; }
  else lvl.classList.add('hidden');
  $('#btnAdmin').classList.toggle('hidden', !u || (u.role !== 'admin' && u.role !== 'mod'));
}

// スコアがタイマーに重ならないようにする。
// 桁が増えると数字が伸びて、実測で 6桁から既にはみ出し、8桁では 47px ぶん
// タイマーの上に乗って両方読めなくなっていた。
//
// 桁数で決め打ちの段階に落とす案は 375px では通ったが 320px では通らなかった
// （枠が 93px しか無く、6桁が 102px 必要）。画面幅・言語・モードで枠の広さが
// 変わる以上、決め打ちでは追えない。ので、実際に測って入るところまで縮める。
//
// 文字幅はフォントサイズに比例するので、1回測れば必要な倍率がそのまま出る。
// 桁数と枠の幅が変わらない限り再計算しないので、毎フレーム走っても実質ただ。
const scoreFitCache = new WeakMap();
export function applyScoreFit(el, text) {
  if (!el) return;
  const box = el.clientWidth;
  const key = String(text).length + '/' + box;
  if (scoreFitCache.get(el) === key) return;
  scoreFitCache.set(el, key);
  if (!box) return;                       // まだ画面に出ていない
  el.style.fontSize = '';                 // CSS の既定に戻してから測る
  const base = parseFloat(getComputedStyle(el).fontSize) || 26;
  const range = document.createRange();
  range.selectNodeContents(el);
  const w = range.getBoundingClientRect().width;
  if (w > box) el.style.fontSize = Math.max(11, Math.floor(base * box / w)) + 'px';
}
