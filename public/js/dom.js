// Small DOM helpers: screen router, toasts, modals, top bar.
import { session, refreshMe } from './net.js';
import { t } from './i18n.js';
// 段位のしきい値は ranks.js が唯一の正解、絵は icons.js。
import { rankOf as rankTier } from './ranks.js';
import { icon } from './icons.js';
// 🗄 端末に置く bba_* の仕分け（public/js/localdata.js）。
import { switchOwner, ownerKeyOf } from './localdata.js';

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

const SCREENS = ['menu', 'game', 'matchmaking', 'room', 'leaderboard', 'shop', 'inventory', 'battlepass', 'missions', 'friends', 'guild', 'news', 'admin'];

// 画面の履歴。端末の「戻る」と、画面左上の「←」の両方がこれを使う。
// 以前はどちらも menu 直行で、しかも履歴を1つも積んでいなかったので、
// Android では戻るを押すとアプリごと閉じていた（PWA は standalone）。
const screenStack = [];
let poppingBack = false;
// 自分で history.go(-n) して畳んでいる最中。ここに入っている間の popstate は
// 「利用者が押した戻る」ではないので無視する（showScreen のメニュー復帰を参照）。
let unwindUntil = 0;

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
  //
  // ⚠ 端末の履歴も同じだけ巻き戻すこと。下の push は「戻り先」と「履歴」を
  //   必ず一緒に積むと約束しているのに、**畳む向きだけ**が片手落ちだった。
  //   画面の積み上げだけ捨てて履歴を残すと、popstate は来るのに戻り先が
  //   空 ＝ 何も起きない「死んだ戻る」が、遊ぶたびに1〜2回ぶん溜まっていく
  //   （メニュー→マッチング→対戦 で2つ積まれ、試合後のメニュー復帰で
  //   ぜんぶ置き去りになる）。プレイヤーからは「戻るが効かない」に見える。
  if (name === 'menu') {
    const depth = screenStack.length;
    screenStack.length = 0;
    if (depth > 0 && historyReady && !poppingBack) {
      // go() の popstate は非同期で届く。自分で畳んだぶんを掴まないよう、
      // 短い時間だけ popstate を素通りさせる（件数を数える方式にすると、
      // 履歴の先頭で go() が空振りしたときにカウンタが残り、**本物の戻るを
      // 食べ続ける**ほうの事故になる。時間なら必ず自然に戻る）。
      unwindUntil = Date.now() + 400;
      try { history.go(-depth); } catch { unwindUntil = 0; }
    }
  }

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
    // 自分で畳んでいる最中のぶんは、利用者の操作ではないので何もしない。
    if (Date.now() < unwindUntil) return;
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
    // 🔙 ここでは積み直さない。
    //
    //   popstate は**すでに履歴を1つ消費している**。それと screenStack.pop()
    //   がちょうど釣り合っているので、そのうえ repush() すると履歴だけが
    //   1つ余る ── メニュー→A→B→戻る→戻る で、メニューに着いたあとの
    //   「戻る」が1回ぶん空押しになる（3段潜れば2回）。積み直すのが正しいのは
    //   「戻る操作を受けたが、画面は動かさなかった」ときだけ（上の
    //   モーダル・試合中の枝が、それぞれ自分で repush している）。
    //
    //   これで「履歴の深さ ＝ screenStack.length」が常に保たれる。
    //   メニュー復帰時の history.go(-depth) も同じ前提で数えている。
    const to = screenStack.pop() || 'menu';
    poppingBack = true;
    showScreen(to, { push: false });
    poppingBack = false;
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
  // 試合中は2件まで。盤面の下端とコマの上端のあいだ（実測で109px程度）に
  // 収めるための上限で、3件だと必ず盤面へはみ出す。
  // 3件目が来たら古いものから消えるので、情報が失われるわけではない。
  return document.body.dataset.screen === 'game' ? 2 : 4;
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

  // 通知を **盤面にも手札にも被らない場所** に置く。
  //
  // ここは二度作り直している:
  //   1. 最初は bottom:96px（下寄せ）── そこは手札の帯のど真ん中で、
  //      背の低い端末ではコマが完全に隠れて「何を掴むのか見えない」状態だった。
  //   2. 次に盤面の上端へ移した ── 手札は空いたが、今度は盤面の最上段に重なった。
  // どちらも「片方を避けたら、もう片方に当たる」形。
  //
  // 本当の空きは **盤面の下端とコマの上端のあいだ**にある。手札の帯は残り物の
  // 高さを全部もらうので背の高い端末では余っていて、コマは帯の中央に描かれる
  // （game.js の drawTray）。そこが空く。
  // 座標は game.js が --bba-board-bottom / --bba-hand-piece-top で出している。
  //
  // 入らない端末（背が低い・横持ち）だけ、従来どおり盤面の上端へ落とす。
  // 盤面の最上段に少し重なるが、手札を隠すよりはましという順序。
  const cs = getComputedStyle(document.documentElement);
  const num = name => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : null;
  };
  const boardBottom = num('--bba-board-bottom');
  const pieceTop = num('--bba-hand-piece-top');
  // 判定は「1件ぶんが入るか」で行う。**いま積み上がっている高さで測ってはいけない**
  // ── 2件目・3件目が出た瞬間に判定が裏返り、通知の位置が画面の反対側へ飛ぶ。
  // 底を固定して上へ積む作りなので、入りきらないぶんは盤面側へ静かに溢れる。
  const need = 44;

  const s = document.documentElement.style;
  s.setProperty('--game-toast-top', `${Math.round(r.top + 6)}px`);   // 既定＝盤面の上端

  // 空きに入るなら、**コマの直上を底にして上へ積む**。
  // 上端を固定して下へ積むと、通知が増えるほどコマへ寄っていき、
  // 2枚目・3枚目がまた手札に被る（最初の不具合の再来）。
  // 底を固定して上へ伸ばせば、あふれたぶんは盤面側へ逃げる。
  const inGap = boardBottom != null && pieceTop != null && pieceTop - boardBottom >= need;
  if (inGap) {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    s.setProperty('--game-toast-bottom', `${Math.max(0, Math.round(vh - pieceTop + 6))}px`);
  }
  document.body.dataset.toastGap = inGap ? '1' : '0';
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

// ⌨️ 「この Enter は送信の Enter か？」
//
// 漢字変換の**確定**も Enter で起きる。同じ問題を Esc 側では escIsLive() が
// 既に知っていたのに、Enter 側には誰も適用していなかった ── 日本語で打つ人は
// 変換を確定するたびに未確定の文が全員に配信され、取り消せない。
// チャット・パーティー・ルームの合言葉・伝言・検索…と8か所に散っていたので、
// 判定はここ1本に置いて全部そこを通す。
//
// e.isComposing は変換中の keydown で true。keyCode 229 は Safari/古い WebKit が
// isComposing を出さない場合の保険（Esc 側と同じ組み合わせ）。
export function enterIsLive(e) {
  return !!e && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
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
  // ⚠ ここへ落ちるのは「押せる出口がそもそも無いモーダル」だけ。
  //   以前は data-modal-dismiss を**実際に付けている場所が1つも無かった**ので、
  //   dismissable:false のモーダル（modes.js だけで40か所以上）はすべてここに落ち、
  //   Android の戻るジェスチャーが毎回「選択が必要です」の赤トーストになっていた。
  //   ジュークボックスのように“選ぶもの”が無いダイアログでも同じ文が出るので、
  //   何を求められているのかも分からない。下で印を付けるようにしたうえで、
  //   文言も「何をすればいいか」に変える。
  toast(t('下のボタンから選んでください', 'Use one of the buttons below'), '', 2000);
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
  // 印は icons.js の back / close。以前は '←' / '✕' の文字だったが、
  // 字体任せで太さも中心も端末ごとにズレるし、モーダルの右上は
  // 画面中でもっとも押される部品。hasOwnCloseControl() はこのボタンを
  // data-modal-close / data-modal-back で見分けるので、文字を失っても壊れない。
  btn.innerHTML = icon(hasBack ? 'back' : 'close', { size: 18 });
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

// 🔚 「このモーダルが閉じたら1回だけ呼んでほしい」用の口。
//
// ボタンの onclick に後始末を書くだけでは足りない ── モーダルは枠外タップ・
// Esc・端末の戻る・親へ戻る（popModal）でも閉じるので、そのどれかで
// 後始末が飛ぶと、止めた時計が止まったままになる（＝永久に無敵）。
// 中身が消えたときに必ず流す。次のモーダルに入れ替わったときも流す
// （開けっぱなしより「戻しすぎる」ほうが必ず安全な向き）。
let modalClosedHooks = [];
export function onModalClosed(fn) {
  if (typeof fn === 'function') modalClosedHooks.push(fn);
}
function runModalClosedHooks() {
  if (!modalClosedHooks.length) return;
  const hooks = modalClosedHooks;
  modalClosedHooks = [];
  for (const fn of hooks) {
    try { fn(); } catch { /* 後始末の失敗で画面を止めない */ }
  }
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
    // 🚪 閉じられないモーダルでも、**「やめる／閉じる／メニュー」に当たるボタンが
    //    あるならそれを逃げ道として印付けする**（端末の戻るがそこを押す）。
    //    印を付ける場所が1つも無かったので、dismissLockedModal の逃げ道は
    //    ずっと空振りしていた。判定は既存の CLOSE_WORDS を借りる（規則を増やさない）。
    if (!dismissable && !modal.querySelector('[data-modal-dismiss]')) {
      for (const b of modal.querySelectorAll('.modal-buttons button, .modal-buttons .btn')) {
        if (CLOSE_WORDS.test(b.textContent || '') || /メニュー|menu/i.test(b.textContent || '')) {
          b.setAttribute('data-modal-dismiss', '1');
          break;
        }
      }
    }
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
  // 👁 だったところ。盤面を覚かせるボタンなので、観戦（spectate）の目を使う。
  btn.innerHTML = icon('spectate', { size: 18 });
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
  if (had) runModalClosedHooks();
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
// 📴 オフラインでも「ログインしたまま」に見せるための控え
//
// ■ なぜ要るか
//   session.token は通信が落ちても捨てない（失敗経路は net.js の setToken(null)
//   を通らない）ので、つながれば自動でログイン状態に戻る ── そこは元から
//   正しかった。問題はその手前で、起動時の refreshMe()（/api/me）が通らない
//   あいだ session.user は null のままで、updateTopbar() がそれを「未ログイン」
//   として描いていた。結果、名前は「ゲスト」、コインとジェムは 0、レベルは
//   非表示。しかも起動時は 9秒×6回＝**約54秒**粘るので、圏外の人は1分近く
//   「勝手にログアウトさせられた画面」を見せられていた。
//   そこで、通信が取れているあいだに表示用の写しを控えておき、トークンが
//   あるのに本物がまだ無いときは、待たずに控えで描く。
//
// ■ 控えは「表示」にしか使わない（ここが肝心）
//   localStorage は本人がいくらでも書き換えられる。だから控えから戻した
//   ユーザーには3つの縛りを掛けてある:
//     1. role は保存時にも復元時にも必ず 'player' に落とす。管理者UIの
//        出し分けは全部 role を見ているので、ここで潰しておけば
//        「localStorage に role:'admin' と書くだけで管理画面のボタンが並ぶ」
//        が起きない。
//     2. staffExtras() は usingCachedUser() が真のあいだ必ず false。role を
//        見ていない将来の権限判定も、この一段で止まる（守りは2枚）。
//     3. rankRewards（受け取り待ちのランキング報酬）は控えない。控えの中身
//        から「受け取る」入口が生えるのは、サーバーが弾くとしても筋が悪い。
//   API はどれもサーバー側で 401/403 を返すので実害は元から出ないが、
//   押しても何も起きないボタンを並べないための行儀の話。
//
// ■ 「いま控えを描いているか」の見分け方
//   localStorage に書いた目印は見ない ── 書き換えられた瞬間に嘘になる
//   （＝控えなのに本物だと名乗れる）。restoreCachedUser() が作った **その
//   object そのもの** と session.user が同一かどうかで見る。本物が届けば
//   別の object に差し替わるので、判定は自然に外れる。
// ---------------------------------------------------------------------------

const USER_CACHE_KEY = 'bba_me_cache';
// 控えの寿命。サーバーのセッションは1年（server/auth.js の V2_TTL）なので、
// その内側に収める。トークンがまだ生きているのに控えだけ切れていると、
// また「ゲスト」に落ちる時間ができてしまうので短くしすぎない。
const USER_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
// 控えに写す欄。丸ごと保存にしないのは、あとから publicUser に欄が増えたときに
// 「知らないものを勝手に端末へ平文で置く」ことになるから。増やすときはここへ。
// ⚠️ role と rankRewards は**わざと入っていない**（上の 1. と 3.）。
const USER_CACHE_FIELDS = [
  'id', 'username', 'level', 'xp', 'coins', 'gems', 'shards',
  'stats', 'social', 'owned', 'equipped', 'items', 'badges',
  'achievements', 'equippedTitle', 'guild', 'battlePass', 'thrones',
];
// つながり直したかを見に行く間隔。起動直後は main.js が 9秒×6回で粘っている
// ので、その裏で二重に叩かないようゆっくり回す。
const CACHE_RETRY_MS = 30000;

// restoreCachedUser() が session.user に入れた当の object。
let cachedUserObj = null;
// 控えからの復元は**起動時の1回だけ**。何度も戻すと、main.js の
// waitForRestore()（復元待ちの見張り）が「session.user があるなら終わり」と
// 判断して止まってしまう ── あちらは session.user = null を合図にしている。
let cacheRestoreTried = false;

/** いま画面に出ている自分の情報が「控え」か（＝本物がまだ取れていない）。 */
export function usingCachedUser() {
  return !!cachedUserObj && session.user === cachedUserObj;
}

function hasCachedUser() {
  try { return localStorage.getItem(USER_CACHE_KEY) != null; } catch { return false; }
}

/**
 * 表示用の写しを控える。**通信が取れているとき（＝本物の user）だけ**呼ぶこと。
 * net.js の refreshMe() から呼んでもらってもよい（forOthers 参照）。当面は
 * updateTopbar() が本物を描くたびに自分で控える。
 */
export function cacheSessionUser(u) {
  if (!u || typeof u !== 'object' || !u.id || typeof u.username !== 'string') return;
  if (u === cachedUserObj) return;                 // 控えを控え直さない
  const copy = {};
  for (const k of USER_CACHE_FIELDS) if (u[k] !== undefined) copy[k] = u[k];
  copy.role = 'player';                            // 🔒 権限は控えない
  const write = body => localStorage.setItem(USER_CACHE_KEY, JSON.stringify(body));
  try { write({ v: 1, at: Date.now(), user: copy }); }
  catch {
    // 容量いっぱい／プライベートモード。いちばん重いのは戦績の履歴なので、
    // それだけ落としてもう一度だけ試す（控えられなくても遊べる）。
    try {
      if (copy.stats && typeof copy.stats === 'object') copy.stats = { ...copy.stats, history: [] };
      write({ v: 1, at: Date.now(), user: copy });
    } catch { /* あきらめる。次のログインでまた試す */ }
  }
}

/** 控えを捨てる。ログアウト（＝トークンが消えた）ときに呼ぶ。 */
export function clearCachedUser() {
  cachedUserObj = null;
  cacheRestoreTried = false;
  try { localStorage.removeItem(USER_CACHE_KEY); } catch { /* ignore */ }
}

/**
 * 控えを session.user に戻す。戻せたら true。
 * ⚠️ ここを通ったユーザーは「表示専用」。権限は必ず剥がして返す。
 */
export function restoreCachedUser() {
  if (session.user || !session.token) return false;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(USER_CACHE_KEY) || 'null'); }
  catch { return false; }
  const u = saved && typeof saved === 'object' ? saved.user : null;
  if (!u || typeof u !== 'object' || !u.id || typeof u.username !== 'string') return false;
  if (!(Number(saved.at) > Date.now() - USER_CACHE_TTL_MS)) return false;
  // 戦績が入っていない控えは、こちらが書いたものではない（＝手で作られた）。
  // 空の器を渡すと画面のあちこちが fmt(undefined) で「NaN」になるので、
  // 中途半端に直さず丸ごと使わない。
  if (!u.stats || typeof u.stats !== 'object' || Array.isArray(u.stats)) return false;
  const me = { ...u };
  // 名前は端末から来る文字列。screens.js の showProfileModal() は見出しへ
  // **生のまま**差し込むので、記号を落として長さも切っておく
  // （サーバー側の名前は2〜16文字の英数字・日本語しか通らない）。
  me.username = String(u.username).replace(/[<>&"'`\\]/g, '').trim().slice(0, 16);
  if (!me.username) return false;
  // 🔒 書き換えられていても、ここで必ず落とす。role を見ている判定
  //    （updateTopbar の管理ボタン・設定の運営トグル・modes.js のアイテム棚）は
  //    これだけで全部 false になる。
  me.role = 'player';
  // 受け取り待ちの報酬は復活させない（控えから付与の入口を作らない）。
  me.rankRewards = [];
  // 形が欠けていると screens.js / main.js が u.owned.map などで落ちる。
  // 控えは手で書き換えられる前提なので、型もここで揃える。
  for (const k of ['owned', 'badges', 'achievements', 'thrones']) {
    if (!Array.isArray(me[k])) me[k] = [];
  }
  for (const k of ['items', 'equipped', 'social']) {
    if (!me[k] || typeof me[k] !== 'object') me[k] = {};
  }
  for (const k of ['coins', 'gems', 'xp', 'shards']) me[k] = Number(me[k]) || 0;
  me.level = Number(me.level) || 1;
  cachedUserObj = me;
  session.user = me;
  startCachedUserWatch();
  return true;
}

// 通信が戻ったら本物で上書きする。
// net.js / main.js は担当外なので、見張りはここに置いてある（本来は
// refreshMe() の側に寄せたい ── forOthers に依頼を書いた）。
// 機内モード中は叩かない（必ず失敗するのに30秒ごとに fetch を投げるだけ）。
let cacheWatchTimer = null;
function stopCachedUserWatch() {
  if (cacheWatchTimer) { clearInterval(cacheWatchTimer); cacheWatchTimer = null; }
}
function retryCachedUser() {
  if (!usingCachedUser()) { stopCachedUserWatch(); return; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  refreshMe()
    .then(() => { stopCachedUserWatch(); updateTopbar(); })
    .catch(() => { /* まだ届かない。次の刻みで */ });
}
function startCachedUserWatch() {
  if (cacheWatchTimer || typeof setInterval !== 'function') return;
  cacheWatchTimer = setInterval(retryCachedUser, CACHE_RETRY_MS);
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // 端末が「つながった」と言った直後は、次の刻みを待たずに一度だけ試す。
  window.addEventListener('online', () => setTimeout(retryCachedUser, 600));
}

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
  // 🔒 控え（オフラインで復元した表示用の写し）では絶対に真にしない。
  //    権限は「通信が取れているとき」だけ有効 ── localStorage を書き換えて
  //    管理者UIを引き出せる状態にはしない。restoreCachedUser() が role を
  //    剥がしたうえで、ここでももう一度止めている（守りは2枚）。
  if (usingCachedUser()) return false;
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

// 「いま出ているのは控えです」の印。#userChip の中、レベルの隣に置く。
// main.js の #offlineTag（＝回線そのものの印）とは別物 ── あちらは「いま
// つながっていない」を、こちらは「出ている数字が最後に見た値だ」を言う。
// 器は index.html に無い（担当外）ので、必要になったときだけここで作る。
function syncStaleTag(stale, title) {
  let tag = document.getElementById('staleTag');
  if (!tag) {
    if (!stale) return;
    const host = $('#userChip');
    if (!host) return;
    tag = document.createElement('span');
    tag.id = 'staleTag';
    tag.setAttribute('role', 'status');
    // style.css は担当外なので、見た目は inline で作る。
    tag.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-left:5px;'
      + 'padding:1px 5px;border-radius:6px;font-size:10.5px;font-weight:800;'
      + 'background:rgba(255,93,93,.16);color:var(--red);white-space:nowrap';
    host.appendChild(tag);
  }
  tag.classList.toggle('hidden', !stale);
  if (!stale) return;
  tag.title = title;
  tag.replaceChildren();
  tag.insertAdjacentHTML('beforeend', icon('offline', { size: 11 }));
  tag.append(t('前回の情報', 'Last seen'));
}

export function updateTopbar() {
  // 📴 トークンはあるのに本物がまだ無い（起動直後・圏外）なら、54秒待たずに
  //    控えで描く。ここに置くのは、session.user が差し替わる経路すべてが
  //    必ず updateTopbar() を通るから ── 起動時の1回目もここを通る。
  if (!cacheRestoreTried && !session.user && session.token) {
    cacheRestoreTried = true;
    restoreCachedUser();
  }
  // ログアウト（＝トークンが消えた）なら控えも捨てる。残すと、次にこの端末を
  // 開いた人の画面に前の人の名前と残高が出る。
  if (!session.token && hasCachedUser()) clearCachedUser();

  // 🗄 遊んでいる人が変わったら、端末に置いてある記録を仕舞い直す。
  //
  //   ここに置くのは、session.user が差し替わる経路すべてが必ず
  //   updateTopbar() を通るから（clearCachedUser や幽霊屋敷の扉と同じ理由）。
  //   仕舞う＝消すではない ── サーバーに控えが無いもの（パズルの★・カオスの
  //   自己ベスト等）まで消すと、前の人のデータを隠すために自分のデータを
  //   失うことになる。詳しくは public/js/localdata.js の冒頭。
  //
  //   ⚠ 「トークンはあるのに本物がまだ無い」＝**誰なのか分からない**あいだは
  //     動かさない。ここで guest に倒すと、起動のたびに
  //     「ゲストへ仕舞う → 本物が届いて戻す」を往復し、その最中に閉じられると
  //     記録が控えに入ったままになる。
  const ownerNow = session.user ? ownerKeyOf(session.user) : (session.token ? null : 'guest');
  if (ownerNow) switchOwner(ownerNow);

  const u = session.user;
  // 控えを描いているあいだは true。権限も残高も、そのまま信じさせない。
  const stale = usingCachedUser();
  // 本物が取れているときだけ控えを更新する。
  if (u && !stale) cacheSessionUser(u);

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
  // 控えの残高は「最後に見た値」。~ を付けて、そのまま今の残高だと読ませない。
  const approx = stale ? '~' : '';
  const coinsEl = $('#coinsLabel');
  const gemsEl = $('#gemsLabel');
  coinsEl.textContent = inf ? '∞' : approx + fmt(u ? u.coins : 0);
  gemsEl.textContent = inf ? '∞' : approx + fmt(u ? u.gems : 0);
  const staleTitle = t('オフラインのため、最後に受け取った値を表示しています',
    'Offline — showing the last values we received');
  for (const el of [coinsEl, gemsEl]) {
    if (stale) el.setAttribute('title', staleTitle);
    else el.removeAttribute('title');
    el.style.opacity = stale ? '.72' : '';
  }
  syncStaleTag(stale, staleTitle);
  const lvl = $('#userLevel');
  if (u) { lvl.classList.remove('hidden'); lvl.textContent = `Lv.${u.level}`; }
  else lvl.classList.add('hidden');
  $('#btnAdmin').classList.toggle('hidden', !u || (u.role !== 'admin' && u.role !== 'mod'));
  // 📣 「ログインしている人が変わった」の合図。updateTopbar は session.user が
  //    差し替わる経路すべて（ログイン・ログアウト・復元・改名）から必ず呼ばれる
  //    ので、権限で見え方が変わる物はここに乗せれば取りこぼしが無い。
  //    最初の利用者は main.js の幽霊屋敷の扉 ── 以前はログインのたびに
  //    updateGhostButton() を書き足す作りで、ログインモーダルからの経路だけ
  //    抜けており、管理者でログインしても再読み込みするまで扉が出なかった
  //    （ログアウトしても消えない、という逆向きの穴も同じ原因）。
  try { window.dispatchEvent(new CustomEvent('bba:session-changed')); }
  catch { /* CustomEvent の無い環境では何もしない */ }
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
