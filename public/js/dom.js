// Small DOM helpers: screen router, toasts, modals, top bar.
import { session } from './net.js';
import { t } from './i18n.js';
// 段位のしきい値は ranks.js が唯一の正解、絵は icons.js。
import { rankOf as rankTier } from './ranks.js';
import { icon } from './icons.js';

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
// 試合中の「戻る」だけは確認を挟む。initHistory() で受け取ったものを、
// 端末の戻る・Esc・← の全部で使い回す（3箇所に散ると必ずズレる）。
let gameBackHandler = null;

export function showScreen(name, { push = true } = {}) {
  const prev = document.body.dataset.screen;
  for (const s of SCREENS) {
    const el = $(`#screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  }
  document.body.dataset.screen = name;   // used by CSS (e.g. chat drawer on menu only)
  // 画面を出したあとにタブが描かれるので、次の順番で印を付け直す。
  setTimeout(() => markCurrent(document), 0);
  // 試合画面はパネルの有無で盤面の上端が動く。トーストの置き場所を測り直す
  // ── レイアウトが確定してからでないと 0 が返るので、次の順番で。
  if (name === 'game') setTimeout(syncGameToastAnchor, 0);

  // メニューはいちばん下。ここに来たら積み上げを畳む ── そうしないと
  // 「メニュー→ショップ→メニュー」で戻り先にメニューが溜まっていき、
  // 戻るを何度押してもメニューのまま、という状態になる。
  if (name === 'menu') screenStack.length = 0;

  // 画面が変わったらモーダルの親子関係は捨てる。残しておくと、モーダルの中の
  // ボタンで画面を移したあとに「閉じる」を押した瞬間、新しい画面の上に
  // 前の画面のモーダルが生えてくる。
  // ※ closeModal() より先に showScreen() を呼ぶ順番だけは避けること
  //   （先に閉じると、閉じた拍子に親が開き直ってから画面が変わる）。
  if (prev !== name) modalStack.length = 0;

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
//
// ただし「#btnCancelQueue / #btnRoomBack を名前で決め打ち」は、画面が増える
// たびにここへ if を足しに来ないといけない（＝新しいモードの離脱は必ず
// 忘れられる）。各画面が自分で後始末を登録できるようにして、決め打ちの
// ほうは登録の無い画面が無反応にならないための保険として残す。
const screenExits = new Map();

/**
 * 画面ごとの「離脱時の後始末」を登録する。
 * ← / 端末の戻る / Esc のどれで抜けても、画面を差し替える前にこれが呼ばれる。
 * fn は「自分で引き受けたか」を返す（下の leaveViaScreenButton のコメント参照）。
 * 戻り値は登録を外す関数。
 */
export function registerScreenExit(screen, fn) {
  if (!screen) return () => {};
  if (typeof fn !== 'function') { screenExits.delete(screen); return () => {}; }
  screenExits.set(screen, fn);
  return () => { if (screenExits.get(screen) === fn) screenExits.delete(screen); };
}

function leaveViaScreenButton() {
  const screen = document.body.dataset.screen;

  // 1) 登録された後始末があればそれが最優先。
  const exit = screenExits.get(screen);
  if (exit) {
    let claimed = false;
    // 後始末が投げても「戻る」そのものは止めない（保険の経路へ落とす）。
    try { claimed = exit() === true; } catch { claimed = false; }
    if (document.body.dataset.screen !== screen) return true;   // 自分で画面まで移した
    if (claimed) return true;                                   // 確認ダイアログを出した等、引き受けた
    // 何もしなかった → 下の保険へ落ちる
  }

  // 2) 決め打ちの保険。登録が無い画面をここで無反応にしない。
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
  // Esc（画面レベル）も試合中は同じ確認へ回したいので、ここで預かっておく。
  gameBackHandler = typeof onGameBack === 'function' ? onGameBack : null;
  try { history.replaceState({ bbaScreen: document.body.dataset.screen || 'menu' }, ''); } catch { /* ignore */ }
  window.addEventListener('popstate', () => {
    // モーダルが開いているなら、まずそれを閉じる（いちばん自然な戻り先）。
    // ただし閉じられない印のあるモーダル（結果画面など）は閉じない ──
    // 閉じると動かない盤面に取り残される。
    const modal = $('#modal-root');
    if (modal && modal.firstChild) {
      const locked = modal.querySelector('.modal-backdrop[data-locked]');
      if (!locked) { popModal(); repush(); return; }
      repush();
      // 閉じられないモーダルでも、黙って return してはいけない ──
      // 戻る操作が完全に無反応になり、端末が壊れたように見える。
      // 逃げ道（[data-modal-dismiss]）が用意されていればそれを押し、
      // 無ければ「なぜ戻れないのか」だけは伝える。
      dismissLockedModal(locked);
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

// ---------------------------------------------------------------------------
// 「← 戻る」の共通部品
//
// 戻り口のヘッダが5系統に割れていた（サブ画面の [data-back]、試合中の #btnQuit、
// マッチングの「キャンセル」、カスタムルームの #btnRoomBack、そして何も無い
// モード）。見た目も押し心地もバラバラなので、差し込む部品を1つに寄せる。
//
// 見た目は style.css 側（.back-bar / .back-bar-btn）。まだ CSS が無くても
// 既存の .chip .icon-btn で成立するようにしてあり、44x44 の当たり判定だけは
// インラインで床を張ってある（指で押す部品の最低ライン）。
// ---------------------------------------------------------------------------

/**
 * container の先頭（既定）に「← 戻る」を差し込む。同じ container に2回呼んでも
 * 増えない（作り直す画面が何度も呼ぶので、ここは冪等にしておく）。
 *
 * @param {Element} container 差し込み先
 * @param {object}  opts
 *   text     {string}  ← の右に置く見出し。空なら見出しを作らない
 *   label    {string}  ボタンの中身（既定 '←'）
 *   ariaLabel{string}  読み上げ名（既定「戻る」）
 *   onBack   {Function} 押されたときの処理（既定 goBack）
 *   place    {'prepend'|'append'} 差し込み位置（既定 prepend）
 * @returns {Element|null} 差し込んだ .back-bar
 */
export function mountBackBar(container, opts = {}) {
  if (!container || !container.appendChild) return null;
  const { text = '', label = '←', ariaLabel, onBack, place = 'prepend' } = opts;

  let bar = [...container.children].find(c => c.classList && c.classList.contains('back-bar'));
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'back-bar';
    bar.innerHTML = '<button type="button" class="chip icon-btn back-btn back-bar-btn"></button><h2 class="back-bar-title"></h2>';
    if (place === 'append') container.appendChild(bar);
    else container.insertBefore(bar, container.firstChild);
  }

  const btn = bar.querySelector('.back-bar-btn');
  const title = bar.querySelector('.back-bar-title');
  btn.textContent = label;
  const name = ariaLabel || t('戻る', 'Back');
  btn.title = name;
  btn.setAttribute('aria-label', name);
  // CSS が未着でも指で押せる大きさを保証する（最低ラインなので、
  // style.css 側がもっと大きくするぶんには邪魔をしない）。
  btn.style.minWidth = '44px';
  btn.style.minHeight = '44px';
  // addEventListener ではなく onclick。呼び直されても二重に発火しない。
  btn.onclick = typeof onBack === 'function' ? onBack : (() => { goBack(gameBackHandler); });

  title.textContent = text || '';
  title.classList.toggle('hidden', !text);
  return bar;
}

// ---------------------------------------------------------------------------
// トースト（画面上部に出る短い通知）
//
// 直した問題（v2.34）
//  1. 同時に出る枚数に上限が無く、報酬・実績・ミッションが一度に片付いた瞬間などに
//     10枚以上が縦に積み上がって画面を覆っていた。→ MAX_TOASTS で頭打ちにし、
//     あふれたら古いものから消す。
//  2. 同じ文言が連続で出ると同じ行が何枚も並んだ。→ 直前と同じ文言なら
//     行を増やさず「×2」「×3」と数える。
//  3. 試合中は手札の上に重なっていた。→ 位置は CSS 側（--game-toast-top）で
//     盤面の上端に移した。ここではその値を測って入れる。
// ---------------------------------------------------------------------------

// 試合中は盤面を隠したくないので少なめ。メニューでは少し余裕を持たせる。
function toastCap() {
  return document.body.dataset.screen === 'game' ? 3 : 4;
}

/**
 * 試合中のトーストを置く高さ（＝盤面の上端）を測って CSS 変数へ入れる。
 * 相手パネルやボスパネルが出ると盤面の上端は下がるので、
 * 画面を出したとき・大きさが変わったときに測り直す。
 */
export function syncGameToastAnchor() {
  const wrap = document.querySelector('.game-canvas-wrap');
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  // 画面が隠れているときは 0 が返る。0 を入れると通知が画面の外へ飛ぶので、
  // 測れなかったときは既定値（CSS の 88px）に任せて何もしない。
  if (r.height <= 0) return;
  document.documentElement.style.setProperty('--game-toast-top', `${Math.round(r.top + 6)}px`);
}

export function toast(message, kind = '', ms = 2600) {
  const root = $('#toast-root');
  if (!root) return;
  if (document.body.dataset.screen === 'game') syncGameToastAnchor();

  // 直前と同じ文言なら行を増やさず回数だけ増やす。
  // （「まだ消えていない」ものだけが対象。out が付いた行は数え直さない）
  const last = [...root.children].filter(c => !c.classList.contains('out')).pop();
  if (last && last.dataset.msg === message && last.classList.contains(kind || 'plain')) {
    const n = (Number(last.dataset.n) || 1) + 1;
    last.dataset.n = String(n);
    let x = last.querySelector('.toast-x');
    if (!x) { x = document.createElement('span'); x.className = 'toast-x'; last.appendChild(x); }
    x.textContent = `×${n}`;
    // 数え直したぶん、消えるまでの時間も伸ばす（上限あり）。
    clearTimeout(last._t);
    last._t = setTimeout(() => fade(last), Math.min(ms + 900, 6000));
    return;
  }

  const el = document.createElement('div');
  el.className = `toast ${kind || 'plain'}`;
  el.dataset.msg = message;
  el.dataset.n = '1';
  el.textContent = message;
  root.appendChild(el);

  // あふれたぶんは古いものから即座に片付ける。
  // これをしないと、報酬がまとめて入った瞬間に画面が通知で埋まる。
  const cap = toastCap();
  const live = [...root.children].filter(c => !c.classList.contains('out'));
  for (const old of live.slice(0, Math.max(0, live.length - cap))) fade(old, 150);

  el._t = setTimeout(() => fade(el), ms);
}

function fade(el, after = 350) {
  if (!el || el.classList.contains('out')) return;
  clearTimeout(el._t);
  el.classList.add('out');
  setTimeout(() => el.remove(), after);
}

// 画面の向きを変える／キーボードが出入りする／相手パネルが出る、のどれでも
// 盤面の上端は動く。ResizeObserver は .game-canvas-wrap が出来てからでないと
// 張れないので、素直に window の resize を見る（測るだけなので安い）。
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (document.body.dataset.screen === 'game') syncGameToastAnchor();
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(syncGameToastAnchor, 120);
  });
}

// ---------------------------------------------------------------------------
// 読み上げ・キーボードまわりの下ごしらえ
//
// モーダルはこの1関数から生えているので、ここに足せば全部のモーダルに効く。
// ・role="dialog" / aria-modal / 見出しとの結びつけ
// ・開いたらフォーカスをモーダルへ、閉じたら開いたボタンへ戻す
// ・Tab をモーダルの中で巻き戻す（裏のメニューへ抜けない）
// ・Escape で閉じる（端末の「戻る」と同じ判定を使う ── [data-locked] は閉じない）
// ---------------------------------------------------------------------------
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let a11yUid = 0;
let modalReturnFocus = null;

const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
const focusablesIn = root => [...root.querySelectorAll(FOCUSABLE_SEL)].filter(isVisible);

// <label> と入力欄が「兄弟に並んでいるだけ」の行を結ぶ。設定モーダルがこの形で、
// for が無いせいでチェックボックスに読み上げ名が無く、ラベルを押しても
// トグルしなかった（22px の四角だけが当たり判定だった）。
// 入力欄が2つ以上ある行は、どれを指すのか決められないので触らない。
function linkLabels(root) {
  for (const label of root.querySelectorAll('label:not([for])')) {
    if (label.querySelector('input, select, textarea')) continue;   // 包んである形は元から結ばれている
    const row = label.parentElement;
    if (!row) continue;
    const fields = row.querySelectorAll('input, select, textarea');
    if (fields.length !== 1) continue;
    const f = fields[0];
    if (!f.id) f.id = `a11yf${++a11yUid}`;
    label.setAttribute('for', f.id);
  }
}

// 選ばれているタブ／セグメントに印を付ける。class="active" は見た目だけの印で、
// 読み上げにはどれが開いているのか届いていなかった。
// role="tab" は矢印キーでの移動まで期待されてしまうので、どこにでも置けて
// 意味が変わらない aria-current を使う。
function markCurrent(root) {
  if (!root || !root.querySelectorAll) return;
  for (const el of root.querySelectorAll('.tab, .seg button')) {
    if (el.classList.contains('active')) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  }
}

// タブの切り替えはあちこちに散っているので、押された結果を後から拾う。
document.addEventListener('click', e => {
  const el = e.target && e.target.closest ? e.target.closest('.tab, .seg button') : null;
  if (!el) return;
  const group = el.closest('.tabs, .seg') || document;
  setTimeout(() => markCurrent(group), 0);
});

// 日本語変換中（isComposing / keyCode 229）の Esc は変換の取り消しに使われている。
// 盤面のブロック解除（game.js の canvas keydown）のように、既に誰かが受け取った
// ものも横取りしない。
function escIsLive(e) {
  return !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented;
}

// 画面レベルの Esc（＝戻る）は、文字を打っている最中には効かせない。
// モーダルの Esc は入力欄にいても閉じてよい（それが普通の作法）ので、
// この判定はモーダルが開いていないときだけ使う。
function escIsOurs(e) {
  if (!escIsLive(e)) return false;
  const a = document.activeElement;
  if (!a) return true;
  const tag = a.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable) return false;
  return true;
}

document.addEventListener('keydown', e => {
  const root = document.getElementById('modal-root');
  if (!root || !root.firstChild) {
    // モーダルが開いていないときの Esc は「画面の戻る」。
    // ここまで無効だったせいで、サブ画面ではキーボードから戻る手段が
    // 一切なかった（← を目で探して押すしかない）。
    if (e.key !== 'Escape' || !escIsOurs(e)) return;
    // 試合中は画面を勝手に離れない。✕（#btnQuit）と同じ確認へ回す。
    if (document.body.dataset.screen === 'game') {
      if (!gameBackHandler) return;
      e.preventDefault();
      gameBackHandler();
      return;
    }
    if (document.body.dataset.screen === 'menu') return;   // これ以上戻る先が無い
    e.preventDefault();
    goBack(gameBackHandler);
    return;
  }
  const backdrop = root.lastElementChild;
  const modal = backdrop && backdrop.querySelector('.modal');
  if (!modal) return;
  if (e.key === 'Escape') {
    if (!escIsLive(e)) return;                 // 変換中の Escape は入力側のもの
    e.preventDefault();
    e.stopPropagation();
    // 結果画面などは閉じない。ただし黙って無視もしない（popstate と同じ扱い）。
    if (backdrop.dataset.locked) { dismissLockedModal(backdrop); return; }
    popModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusablesIn(modal);
  const cur = document.activeElement;
  if (!items.length) { e.preventDefault(); modal.focus({ preventScroll: true }); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (!modal.contains(cur)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && (cur === first || cur === modal)) { e.preventDefault(); last.focus(); }
});

// ---------------------------------------------------------------------------
// モーダルの親子関係（modalStack）
//
// showModal は必ず前のモーダルを閉じるので、「モーダル→モーダル」で開いたとき
// の戻り先が実装者任せだった（戦績→プロフィールは自前で戻していたのに、
// 名前変更・称号は閉じて終わり＝プロフィールごと消える）。
//
// showModal(html, { back: 親を開き直す関数 }) と書けば、
//   ✕ / ← / Esc / 背景タップ / 端末の戻る
// の**どれを使っても同じ popModal() を通り**、親が居れば開き直す。
// 積み上げが空になったら普通に閉じる。
// ※ back は「同期で親の showModal を呼ぶ」関数にすること（await の向こうで
//    開くと、積み直しの順番がズレて同じ親が二重に積まれる）。
// ---------------------------------------------------------------------------
const modalStack = [];
let reopeningParent = false;   // popModal() の中から showModal が呼ばれている最中

export function modalDepth() { return modalStack.length; }

/**
 * 「1枚戻る」。親が居れば開き直し、居なければ閉じる。
 * 戻り値は「親を開き直したか」。
 */
export function popModal() {
  const back = modalStack.pop();
  if (typeof back !== 'function') { closeModal({ keepStack: true }); return false; }
  const root = $('#modal-root');
  const before = root ? root.lastElementChild : null;
  reopeningParent = true;
  // 親を開き直せなくても「閉じる」だけは必ず成立させる。ここで投げたまま
  // 抜けると、押しても何も起きないモーダルに閉じ込められる。
  try { back(); } catch { /* ignore */ }
  reopeningParent = false;
  const after = root ? root.lastElementChild : null;
  if (after && after === before) closeModal({ keepStack: true });   // back() が何も開かなかった
  return true;
}

/** 積み上げごと全部閉じる（画面を切り替える前などに使う）。 */
export function closeAllModals() {
  modalStack.length = 0;
  closeModal({ keepStack: true });
}

// 閉じられないモーダル（dismissable:false）で戻る操作を受けたとき。
// 黙って無視すると「戻るが完全に無反応」になり、端末が壊れたように見える。
function dismissLockedModal(backdrop) {
  const esc = backdrop && backdrop.querySelector('[data-modal-dismiss]');
  if (esc) { esc.click(); return; }
  toast(t('選択が必要です', 'Please choose an option'), 'err', 2000);
}

// 自前の閉じるボタンを既に持っているモーダルに、もう1つ足さないための判定。
// 下の「閉じる」ボタンと右上の ✕ が並ぶと、押し間違えるだけで得が無い。
//
// 親が居るとき（← を入れたいとき）の基準は厳しくする。「閉じる」ボタンは
// “閉じる”のボタンであって“戻る”のボタンではないので、それがあることを理由に
// ← を省くと、結局どこにも戻り口が見えないモーダルが残ってしまう。
const CLOSE_WORDS = /閉じる|とじる|やめる|キャンセル|戻る|もどる|✕|×|✖|close|cancel|back|dismiss/i;
const BACK_WORDS = /戻る|もどる|←|\bback\b/i;
function hasOwnCloseControl(modal, hasBack) {
  if (modal.querySelector('[data-modal-close], [data-modal-back], [data-modal-dismiss], .modal-x, .modal-back')) return true;
  const words = hasBack ? BACK_WORDS : CLOSE_WORDS;
  for (const b of modal.querySelectorAll('button, .btn')) {
    if (words.test(b.textContent || '')) return true;
  }
  return false;
}

// 右上の ✕（親が居るなら ←）を自動で入れる。
// 見た目は style.css 側（.modal-nav / .modal-nav-btn）。まだ CSS が無くても
// 既存の .chip .icon-btn で 44px の丸ボタンとして成立するようにしてある。
// 44x44 だけはインラインで床を張る（指で押す部品の最低ライン）。
function attachModalNav(modal, hasBack) {
  const nav = document.createElement('div');
  nav.className = 'modal-nav';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `chip icon-btn modal-nav-btn ${hasBack ? 'modal-back' : 'modal-x'}`;
  btn.textContent = hasBack ? '←' : '✕';
  const label = hasBack ? t('戻る', 'Back') : t('閉じる', 'Close');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute(hasBack ? 'data-modal-back' : 'data-modal-close', '');
  btn.style.minWidth = '44px';
  btn.style.minHeight = '44px';
  // ✕ も ← も入口は同じ。親が居れば親へ、居なければ閉じる。
  btn.onclick = () => popModal();
  nav.appendChild(btn);
  modal.insertBefore(nav, modal.firstChild);
}

export function showModal(html, { dismissable = true, peekable = false, back = null } = {}) {
  const opener = document.activeElement;
  // ここで積み上げを崩さない（崩すと親を開き直した瞬間に親を見失う）。
  closeModal({ restoreFocus: false, keepStack: true });
  // 親を開き直しているところなら、積み直さない（同じ親が二重に積まれる）。
  if (!reopeningParent) {
    if (typeof back === 'function') {
      modalStack.push(back);
      if (modalStack.length > 12) modalStack.shift();
    } else {
      modalStack.length = 0;   // 親を指定していない＝ここが積み上げの底
    }
  }
  const hasBack = modalStack.length > 0;
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
      if (e.target === backdrop) popModal();
    });
  }
  root.appendChild(backdrop);
  const modal = backdrop.querySelector('.modal');
  if (peekable) attachPeekButton(root, backdrop, modal);
  if (modal) {
    // 閉じ口が1つも無いモーダルを作らない。自前で持っているものには足さない。
    if (dismissable && !hasOwnCloseControl(modal, hasBack)) attachModalNav(modal, hasBack);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const h = modal.querySelector('h2');
    if (h) {
      if (!h.id) h.id = `a11yt${++a11yUid}`;
      modal.setAttribute('aria-labelledby', h.id);
    }
    modal.tabIndex = -1;
    linkLabels(modal);
    markCurrent(modal);
    // 入力欄ではなくモーダルそのものへ寄せる ── いきなり文字入力欄に
    // 移すと、スマホでキーボードが勝手にせり上がってくる。
    // 呼び出し側が自分で .focus() するモーダルは、そちらが後から上書きする。
    try { modal.focus({ preventScroll: true }); } catch { /* 非対応環境 */ }
  }
  // 閉じたときの戻り先。閉じた直後に消える要素（前のモーダルの中のボタン）は
  // ここで既に document から外れているので、自然に対象外になる。
  modalReturnFocus = (opener && opener !== document.body && document.contains(opener)) ? opener : null;
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

// ---------------------------------------------------------------------------
// モーダルの退場アニメ。
//
// 開くときは modalIn（バネ）で気持ちよく出るのに、閉じるときだけ一瞬で消えて
// いた（トーストには .out の退場があるのに、モーダルだけ入退場が非対称）。
//
// ただし「本物を残したままフェードさせる」のは危ない ── 消えたことを見張って
// いる側が何人もいる（録画スタジオの MutationObserver、パーティーの待ち行列、
// 各画面の $('#…')）。同じ id の要素が180ms だけ2つ並ぶと、閉じて開き直す
// パターンで新しいモーダルの配線が古いほうに刺さる。
// なので踊らせるのは「見た目の写し」だけにして、本物はこれまでどおり同じ行で
// #modal-root ごと消す。写しは id を全部剥がし、当たり判定も持たせない。
// ---------------------------------------------------------------------------
function ghostOut(node) {
  try {
    if (!node || node.nodeType !== 1 || typeof node.cloneNode !== 'function') return;
    const ghost = node.cloneNode(true);
    ghost.removeAttribute('id');
    for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id');
    // 読み上げにも渡さない（本物はもう無い）。
    ghost.setAttribute('aria-hidden', 'true');
    const dst = ghost.querySelector('.modal');
    if (dst) {
      dst.removeAttribute('role');
      dst.removeAttribute('aria-modal');
      dst.removeAttribute('tabindex');
    }
    // 👁 は遅れて出る作りなので、写しでは消しておく（点滅して見える）。
    const peek = ghost.querySelector('.modal-peek-btn');
    if (peek) peek.remove();
    ghost.classList.remove('peeking');   // 覗き見中に閉じても、写しは普通に出す
    ghost.classList.add('closing');
    document.body.appendChild(ghost);
    // スクロールしていた位置を合わせる（写しは先頭に戻っているので飛んで見える）。
    const src = node.querySelector('.modal');
    if (src && dst) { try { dst.scrollTop = src.scrollTop; } catch { /* ignore */ } }
    setTimeout(() => ghost.remove(), 260);
  } catch { /* 見た目だけの飾り。閉じる動作そのものは絶対に止めない */ }
}

export function closeModal(opts) {
  const root = $('#modal-root');
  if (!root) return;
  // 「閉じる」は「1枚戻る」と同じ入口にする ── 既存の `onclick = closeModal`
  // が全部そのまま親へ戻るようになる。keepStack は popModal / showModal が
  // 自分で積み上げを管理するときの逃げ道。
  // ※ opts はイベントハンドラに直接渡されることがある（Event には
  //   keepStack が無いので、素の closeModal() と同じ扱いになる）。
  if (!(opts && opts.keepStack)) {
    if (root.firstChild && modalStack.length) { popModal(); return; }
    modalStack.length = 0;   // 開いていないのに残っていた積み上げは捨てる
  }
  // 覗き見中に閉じた場合の保険（透けたままの印を残さない）。
  root.classList.remove('peeking');
  const had = !!root.firstChild;
  for (const el of [...root.children]) ghostOut(el);
  root.innerHTML = '';
  // 開いたボタンへフォーカスを返す。返さないと <body> に落ちて、
  // 次の Tab がページの先頭（トップバー）からやり直しになる。
  // 引数はイベントハンドラに直接渡されることがあるので、明示的に
  // restoreFocus === false のときだけ止める。
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (!had || (opts && opts.restoreFocus === false)) return;
  if (!target || !document.contains(target) || typeof target.focus !== 'function') return;
  // 文字入力欄には返さない（スマホでキーボードがせり上がってくる）。
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
  try { target.focus({ preventScroll: true }); } catch { /* 非対応環境 */ }
}

// ---------------------------------------------------------------------------
// 3-2-1 カウントダウン
//
// 以前は「止める口」がまったく無かった。setTimeout の鎖が自分で回るだけなので
//  ・モードを素早く2回始めると、古いカウントが裏で鳴り続けて音が二重になる
//  ・中断したとき modes.js の clearIntroOverlays() が要素を remove() しても、
//    鎖は生き残って detach された要素に数字を書き続け、音だけが鳴り切る
// という状態だった。止め方を3つ用意する。
//  1. 新しいカウントを始めるときに、古いものを必ず止める（自動）
//  2. 戻り値の cancel() ／ 要素の __bbaCancel()（clearIntroOverlays 用）
//  3. 要素が DOM から外されたら、次の一歩で自分から止まる（remove() だけでも効く）
// ---------------------------------------------------------------------------
const liveCountdowns = new Set();

/** 走っているカウントダウンを全部止める（音も数字も）。 */
export function cancelCountdowns() {
  for (const stop of [...liveCountdowns]) stop();
  // 登録の無い残骸（古い経路で作られたもの）も画面からは消しておく。
  for (const el of document.querySelectorAll('.countdown-overlay')) el.remove();
}

export function countdownOverlay(n, onDone, audio) {
  // 前のカウントが残っていたら必ず先に止める。これが「500ms 間隔で2回開始
  // すると音が二重に鳴る」の直接の対策。
  cancelCountdowns();

  const el = document.createElement('div');
  el.className = 'countdown-overlay';
  document.body.appendChild(el);
  let i = n;
  let timer = null;
  let done = false;

  const finish = () => {
    if (done) return false;
    done = true;
    clearTimeout(timer);
    liveCountdowns.delete(cancel);
    el.remove();
    return true;
  };
  // 中断（onDone は呼ばない ── 中断なので試合は始まらない）。
  const cancel = () => { finish(); };
  liveCountdowns.add(cancel);
  el.__bbaCancel = cancel;   // clearIntroOverlays() など、要素しか持っていない側から

  const step = () => {
    if (done) return;
    // 外から remove() されたらそこで止める。これが無いと見えないカウントが
    // 音を鳴らし続ける（clearIntroOverlays は remove() しかしない）。
    if (el.isConnected === false) { cancel(); return; }
    if (i <= 0) {
      el.innerHTML = `<div class="countdown-num" style="color:#5ee86e">GO!</div>`;
      if (audio) audio.countdown(true);
      timer = setTimeout(() => { if (finish()) onDone(); }, 600);
      return;
    }
    el.innerHTML = `<div class="countdown-num">${i}</div>`;
    if (audio) audio.countdown(false);
    i--;
    timer = setTimeout(step, 900);
  };
  step();
  return { el, cancel };
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

// ---------------------------------------------------------------------------
// 段位（レートの帯）
//
// しきい値はここに書かない。public/js/ranks.js が唯一の正解で、
// 帯の追加や境界の変更はあちらだけで行う。以前はこの表が dom.js /
// server/battle.js / server/residents.js / icons.js の4か所に複製されていて、
// どれか1つを触った瞬間に「画面はゴールドなのに内部はプラチナ」になる状態だった。
//
// ⚠️ 返り値の変更（v2.34）
//   以前は icon が絵文字（🥉🥈🥇💠💎👑）だったが、💎はジェム通貨と、
//   👑は管理者奥義と重複していたので独自アイコンに置き換えた。
//   絵文字1文字と違って SVG は「文字として置く」ことができないため、
//   **icon という名前のフィールドは廃止**し、次の2つに分けた:
//     ・iconName … icons.js のアイコン名（自分で icon() に渡す）
//     ・rankBadge(rating) … アイコン＋段位名の HTML を組み立てて返す
//   textContent に入れる場所では rankLabel(rating) を使うこと（文字だけ）。
// ---------------------------------------------------------------------------
export function rankOf(rating) {
  const k = rankTier(rating);
  return { ...k, iconName: k.icon };
}

/** 段位の表示名だけ（textContent 用。HTML を混ぜてはいけない場所向け）。 */
export function rankLabel(rating) {
  const k = rankTier(rating);
  return t(k.label, k.labelEn);
}

/** アイコン＋段位名の HTML（innerHTML に入れる場所向け）。 */
export function rankBadge(rating, { size = 15, withName = true } = {}) {
  const k = rankTier(rating);
  const svg = icon(k.icon, { size, cls: 'rank-ic' });
  return `<span class="rank-badge" style="color:${k.color}">${svg}${withName ? `<span>${t(k.label, k.labelEn)}</span>` : ''}</span>`;
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
    // 落ちながら左右に振れる幅（style.css の confFall が --sway で読む）。
    // 粒ごとに幅と向きを散らさないと、全部が同じ形で揺れて機械に見える。
    s.style.setProperty('--sway', `${(Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 26)}px`);
    if (Math.random() < 0.4) s.style.borderRadius = '50%';
    root.appendChild(s);
  }
  document.body.appendChild(root);
  setTimeout(() => root.remove(), 3600);
}

export function updateTopbar() {
  const u = session.user;
  $('#userName').textContent = u ? u.username : t('ゲスト', 'Guest');
  // 顔の絵も icons.js に寄せる。4つの状態（未ログイン / プレイヤー / モデレーター /
  // 運営）がそれぞれ別の絵であることに意味があるので、1つに丸めない。
  //
  // ⚠️ ここは textContent ではなく innerHTML。main.js の paintStaticIcons() は
  //    この要素を意図的に避けている ── updateTopbar() がログインのたびに
  //    中身を書き直すので、両方から塗ると片方の結果が必ず消える。
  const avatarName = !u ? 'user_guest' : u.role === 'admin' ? 'admin' : u.role === 'mod' ? 'mod' : 'user';
  const avatarLabel = !u ? t('ゲスト', 'Guest')
    : u.role === 'admin' ? t('運営', 'Staff')
      : u.role === 'mod' ? t('モデレーター', 'Moderator') : t('プレイヤー', 'Player');
  $('#userAvatar').innerHTML = icon(avatarName, { size: 20, label: avatarLabel });
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
