// Admin tools (staff only): the in-game command palette 3.0 and autopilot 5.0.
//
// Everything here manipulates the running mode through the hooks modes.js
// exports; nothing is persisted. Gated by staffExtras() so an admin can hide
// it and play like everyone else.

import {
  getCurrentMode, getViewRef, autopilot, runAutopilot, stopAutopilot, updateAutoBtn,
  updateRerollHud, handleEngineOver, fireUltCurrent, useGameItem, equippedUlt, startSolo,
} from './modes.js';
import { fireUlt, ULT_META } from './skills.js';
import { session, api } from './net.js';
import { $, showModal, closeModal, toast, confettiBurst, fmt, staffExtras, enterIsLive } from './dom.js';
import { audio } from './audio.js';
import { SHAPES } from './engine.js';
// 独自SVGアイコン。管理者パレットのタブ・ボタンに付いていた絵文字の置き換え先。
// **文字として入る場所（toast / textContent）には置けない**ので、そちらは
// 絵文字を落として言葉だけにしてある。
import { icon } from './icons.js';
import { AI_LEVELS } from './ai.js';

const isAdmin = () => !!session.user && session.user.role === 'admin' && staffExtras();
const ic = (name, size = 14) => icon(name, { size });

// 管理者はモードを問わず何でもできる（運営の方針）。アイテム・奥義バーが
// 出ないモードでも、パレット・ゴッド・オートパイロットはここから使える。
// 全部まとめて切りたいときは設定の「🛡️ 管理者専用ボタンを表示」を OFF に
// する ── isAdmin() が staffExtras() を見ているので、それだけで素の状態に戻る。

// Persistent "god" switches — live on the engine so every mode honours them.
export const god = { invincible: false, noGarbage: false, combo: false, mult: 1, fever: false, freezeEnemy: false, stopTimer: false, ultInfinite: true };

let godTimer = null;
// applyGod が前回このエンジンに書き込んだ god 由来の値。×1／OFF に戻したとき、
// モードが積んだ値を握り潰さずに「自分が書いた分だけ」戻すために覚えておく。
let appliedMult = 1;
let appliedCombo = false;
function applyGod() {
  const m = getCurrentMode();
  const e = m && m.engine;
  if (!e) return;
  // 🛡 **スタッフ特典を OFF にしたら、このループも止める。**
  //
  //    isAdmin()（= staffExtras を見る）が掛かっていたのはパレットと
  //    オートパイロットの**入口**だけで、毎秒エンジンへ書き込むこの関数には
  //    権限判定が1つも無かった。しかも OFF にした瞬間にパレット（god を
  //    戻す唯一の道）もボタンも消えるので、**無敌のまま解除できなくなる**。
  //    自分が書いた分だけを畳んでから抜ける（godoff と同じ後始末）。
  if (!isAdmin()) {
    const v0 = getViewRef();
    if (v0) v0.godInvincible = false;
    if (e.fortressUntil > 8e15) e.fortressUntil = 0;
    if (appliedCombo && e.streakShield) e.streakShield = false;
    if (appliedMult !== 1 && e.scoreMult === appliedMult) e.scoreMult = 1;
    if (e.feverUntil > 8e15) { e.feverUntil = 0; $('#hudScore').classList.remove('fever'); }
    appliedCombo = false;
    appliedMult = 1;
    god.invincible = god.noGarbage = god.combo = god.fever = god.freezeEnemy = god.stopTimer = false;
    god.mult = 1;
    if (autopilot.on) stopAutopilot();
    return;
  }
  const view = getViewRef();
  if (view) view.godInvincible = god.invincible;
  e.fortressUntil = god.noGarbage ? 8.64e15 : (e.fortressUntil > 8e15 ? 0 : e.fortressUntil);
  // コンボ永続を OFF に戻したら、自分が立てた streakShield も畳む。
  if (god.combo) e.streakShield = true;
  else if (appliedCombo && e.streakShield) e.streakShield = false;
  appliedCombo = god.combo;
  // このループは全ユーザーで毎秒走る — 無条件で書くと、ダンジョンのパークや
  // 地獄ラッシュの剛力の遺物など「モードが積んだ scoreMult」を握り潰す。
  // ×1 に戻したときも、自分が最後に書いた値がそのまま残っているときだけ 1 に戻す。
  if (god.mult !== 1) e.scoreMult = god.mult;
  else if (appliedMult !== 1 && e.scoreMult === appliedMult) e.scoreMult = 1;
  appliedMult = god.mult;
  if (god.fever) { e.feverUntil = 8.64e15; e.feverMult = Math.max(e.feverMult || 2, 2); $('#hudScore').classList.add('fever'); }
  else if (e.feverUntil > 8e15) { e.feverUntil = 0; $('#hudScore').classList.remove('fever'); }
  if (god.freezeEnemy) {
    if (m.nextAtk) m.nextAtk = Date.now() + 3600000;
    if (m.nextAt) m.nextAt = Date.now() + 3600000;
  }
  if (god.stopTimer && m.endAt) { m.endAt += 1000; m.timeLeft = (m.endAt - Date.now()) / 1000; }
}
export function startGodLoop() {
  clearInterval(godTimer);
  godTimer = setInterval(applyGod, 1000);
  applyGod();
}

function modeLabel(m) {
  if (!m) return '—';
  return m.mode + (m.realm ? `/${m.realm.id}` : '') + (m.kind ? `/${m.kind}` : '');
}

// ---------------------------------------------------------------------------
// Command palette 3.0
// ---------------------------------------------------------------------------

// [id, ラベル, アイコン名]。ラベルは innerHTML に入るので SVG を置ける。
const TABS = [
  ['board', '盤面', 'cat_board'], ['score', 'スコア', 'leaderboard'], ['hand', '手札', 'cat_skin'],
  ['time', '時間/敵', 'mode_sprint'], ['dungeon', 'ダンジョン', 'mode_dungeon'],
  ['ult', '奥義', 'ultimate'], ['god', 'ゴッド', 'throne'],
];

export function showAdminPalette(tab = 'board') {
  if (!isAdmin()) return;
  const m = getCurrentMode();
  const e = m && m.engine;
  const modal = showModal(`
    <h2>${ic('admin', 20)} 管理者コマンド 3.0</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">モード: <b>${modeLabel(m)}</b>${e ? ` ・ スコア ${fmt(e.score)} ・ ゲージ ${Math.round(e.ult)}%` : ''}</p>
    <div class="tabs" style="justify-content:center;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${TABS.map(([id, l, name]) => `<button class="tab ${tab === id ? 'active' : ''}" data-ct="${id}">${ic(name)} ${l}</button>`).join('')}
    </div>
    <div id="apBody" class="form-col admin-cmds"></div>
    <div class="settings-row" style="margin-top:10px">
      <input id="apCmd" type="text" placeholder="/score 5000  /floor 50  /time +120  /hp 1  /mult 10  /lives 9  /ult judgement" style="flex:1;min-width:200px">
      <button class="btn btn-sm btn-primary" id="apRun">実行</button>
    </div>
    <p class="muted center" style="font-size:11px;margin-top:6px">通貨付与・隠し解放・イベント・投票はホームの「管理」から</p>
    <div class="modal-buttons"><button class="btn btn-ghost" id="apClose">閉じる</button></div>`);
  modal.querySelector('#apClose').onclick = closeModal;
  modal.querySelectorAll('[data-ct]').forEach(b => { b.onclick = () => { audio.click(); closeModal(); showAdminPalette(b.dataset.ct); }; });
  const body = modal.querySelector('#apBody');
  const btn = (cmd, label, cls = 'btn-ghost') => `<button class="btn ${cls} btn-sm" data-cmd="${cmd}">${label}</button>`;
  // ON の印だけアイコンで出す。OFF は btn-ghost の見た目で分かるので、
  // 「空のチェックボックス」の絵は持たない（icons.js に無い絵を足さない約束）。
  const toggle = (key, label) => `<button class="btn btn-sm ${god[key] ? 'btn-gold' : 'btn-ghost'}" data-god="${key}">${god[key] ? `${ic('check')} ` : ''}${label}</button>`;

  const sections = {
    // 絵は「その操作の道具」に対応するものだけを付ける。意味が薄いところに
    // 飾りで足すと、絵と操作の対応が崩れて全体の手がかりが弱くなる
    // （＋1,000 のような数字は、それ自体が既にいちばん強い手がかり）。
    board: [btn('clear', `${ic('item_god_wipe')} 全消し`), btn('clearbottom', `${ic('cut')} 下半分を消す`), btn('cleargarbage', `${ic('item_cleaner')} お邪魔だけ消す`), btn('fill', `${ic('block')} ランダムに50%埋める`), btn('checker', `${ic('cat_board')} 市松模様にする`), btn('revive', `${ic('reroll')} 盤面リセット（スコア維持）`)],
    score: [btn('score1k', '+1,000'), btn('score10k', '+10,000'), btn('score100k', '+100,000'), btn('scorex2', '×2'), btn('scorezero', `${ic('trash')} 0にする`, 'btn-ai')],
    hand: [btn('reroll', `${ic('reroll')} リロール +5`), btn('rerollinf', `${ic('infinity')} リロール無限`), btn('hand1', `${ic('mini')} 全部 1×1`), btn('hand3', `${ic('block')} 全部 3×3`), btn('handline', `${ic('lines')} 全部 5マス線`), btn('handrainbow', `${ic('ult_rainbow')} 最適な手札`)],
    time: [btn('time60', `${ic('mode_sprint')} +60秒`), btn('time300', `${ic('mode_sprint')} +5分`), btn('timeup', '即タイムアップ', 'btn-ai'), btn('bosshalf', '敵HP半減'), btn('boss1', '敵HPを1に'), btn('bosskill', `${ic('mode_boss')} 即討伐`), btn('bossatk', `${ic('warn')} 今すぐ敵の攻撃`)],
    dungeon: [btn('floorclear', `${ic('mode_dungeon')} フロア即クリア`), btn('warp10', '10フロア進む'), btn('lives', `${ic('heart')} 残機 +5`), btn('perks', `${ic('perk_atk')} パーク全付与`), btn('floor100', `${ic('skull')} 最深部へワープ`, 'btn-oni')],
    ult: [btn('ultmax', `${ic('ultimate')} ゲージMAX`), btn('ultfire', '装備奥義を即発動'),
      // 奥義の絵は icons.js を id で引く（skills.js の絵文字は 🛡️/☄️ が
      // 別の商品と重なっていたので、棚と同じ独自アイコンにそろえる）。
      ...Object.keys(ULT_META).map(id => btn(`ultcast:${id}`, `${ic(id)} ${id.replace('ult_', '')}`))],
    god: [toggle('invincible', '無敵（ゲームオーバー無効）'), toggle('noGarbage', 'お邪魔無効'), toggle('combo', 'コンボ永続'), toggle('fever', 'フィーバー永続'), toggle('freezeEnemy', '敵の攻撃停止'), toggle('stopTimer', 'タイマー停止'),
      `<div class="settings-row"><label>スコア倍率 ×${god.mult}</label><div class="seg" id="apMult">${[1, 2, 5, 10, 100].map(v => `<button data-v="${v}" ${god.mult === v ? 'class="active"' : ''}>×${v}</button>`).join('')}</div></div>`,
      btn('godall', `${ic('throne')} 全部ON（ゴッドモード）`, 'btn-gold'), btn('godoff', '全部OFF')],
  };
  body.innerHTML = `<div class="admin-cmd-grid">${(sections[tab] || sections.board).join('')}</div>`;
  body.querySelectorAll('[data-cmd]').forEach(b => { b.onclick = () => adminCmd(b.dataset.cmd); });
  body.querySelectorAll('[data-god]').forEach(b => { b.onclick = () => { god[b.dataset.god] = !god[b.dataset.god]; applyGod(); audio.click(); closeModal(); showAdminPalette('god'); }; });
  body.querySelectorAll('#apMult button').forEach(b => { b.onclick = () => { god.mult = Number(b.dataset.v); applyGod(); audio.click(); closeModal(); showAdminPalette('god'); }; });
  const run = () => { const v = modal.querySelector('#apCmd').value.trim(); if (v) runCommandLine(v); modal.querySelector('#apCmd').value = ''; };
  modal.querySelector('#apRun').onclick = run;
  modal.querySelector('#apCmd').addEventListener('keydown', ev => { if (enterIsLive(ev)) run(); ev.stopPropagation(); });
}

function needGame() {
  const m = getCurrentMode();
  if (!m || !m.engine) { toast('ゲーム中のみ使えます', 'err'); return null; }
  return m;
}
function refreshHud(m) {
  if (m.updateHud) m.updateHud();
  else if (m.updateMyHud) m.updateMyHud(m.engine);
  if (m.updateCoopHud) m.updateCoopHud();
}
function floatText(text, color = '#43d9e8') {
  const view = getViewRef();
  if (view) view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize / 2, text, color, 1.4);
}
function setHand(shapeFilter) {
  const m = needGame(); if (!m) return;
  const e = m.engine;
  const idx = [];
  for (let i = 0; i < SHAPES.length; i++) if (shapeFilter(SHAPES[i], i)) idx.push(i);
  for (let s = 0; s < 3; s++) { const i = idx[Math.floor(Math.random() * idx.length)]; e.hand[s] = { shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color }; }
  if (e.over && e.hasAnyMove()) e.over = false;
  const view = getViewRef(); if (view) view.reviveFlash();
}
function addScore(m, n) {
  m.engine.score += n;
  refreshHud(m);
  floatText(`+${fmt(n)} (admin)`);
}
function enemyHp(m) { return typeof m.hp === 'number' && (m.mode === 'boss' || m.mode === 'dungeon' || m.raidBoss); }

export async function adminCmd(cmd) {
  if (!isAdmin()) return;
  audio.click();
  const [name, arg] = cmd.split(':');
  const m = getCurrentMode();
  const e = m && m.engine;
  const view = getViewRef();
  switch (name) {
    // ---- board ----
    case 'clear': if (!needGame()) return; e.grid.fill(0); if (e.over && e.hasAnyMove()) e.over = false; view.reviveFlash(); toast('全消し', 'ok', 1200); break;
    case 'clearbottom': if (!needGame()) return; for (let i = 32; i < 64; i++) e.grid[i] = 0; if (e.over && e.hasAnyMove()) e.over = false; view.reviveFlash(); break;
    case 'cleargarbage': if (!needGame()) return; for (let i = 0; i < 64; i++) if (e.grid[i] === 9) e.grid[i] = 0; if (e.over && e.hasAnyMove()) e.over = false; view.reviveFlash(); break;
    case 'fill': if (!needGame()) return; for (let i = 0; i < 64; i++) if (!e.grid[i] && Math.random() < 0.5) e.grid[i] = 1 + (i % 8); break;
    case 'checker': if (!needGame()) return; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) e.grid[r * 8 + c] = (r + c) % 2 ? 1 + ((r * 3 + c) % 8) : 0; break;
    case 'revive': if (!needGame()) return; e.reviveBoard(); view.reviveFlash(); break;
    // ---- score ----
    case 'score1k': if (!needGame()) return; addScore(m, 1000); break;
    case 'score10k': if (!needGame()) return; addScore(m, 10000); break;
    case 'score100k': if (!needGame()) return; addScore(m, 100000); break;
    case 'scorex2': if (!needGame()) return; addScore(m, e.score); break;
    case 'scorezero': if (!needGame()) return; e.score = 0; refreshHud(m); break;
    // ---- hand ----
    case 'reroll': if (!needGame()) return; e.rerolls += 5; updateRerollHud(e); break;
    case 'rerollinf': if (!needGame()) return; e.infiniteReroll = true; updateRerollHud(e); break;
    case 'hand1': setHand(s => s.cells.length === 1); break;
    case 'hand3': setHand(s => s.cells.length === 9); break;
    case 'handline': setHand(s => s.cells.length === 5 && (s.cells.every(([r]) => r === 0) || s.cells.every(([, c]) => c === 0))); break;
    case 'handrainbow': if (!needGame()) return; { const out = fireUlt('ult_rainbow', { engine: e, view, mode: m }); if (out.error) toast(out.error, 'err'); } break;
    // ---- time / enemy ----
    case 'time60': case 'time300': {
      if (!m || m.endAt === undefined) return toast('タイマーのあるモードのみ', 'err');
      const add = name === 'time60' ? 60 : 300;
      m.endAt += add * 1000; m.timeLeft += add; toast(`+${add}秒`, 'ok', 1200); break;
    }
    case 'timeup': if (!m || m.endAt === undefined) return toast('タイマーのあるモードのみ', 'err'); m.endAt = Date.now(); break;
    case 'bosshalf': case 'boss1': case 'bosskill': {
      if (!m || !enemyHp(m)) return toast('ボス戦・ダンジョン・レイドのみ', 'err');
      if (name === 'bosshalf') m.hp = Math.ceil(m.hp / 2);
      else if (name === 'boss1') m.hp = 1;
      else { e.score += Math.max(0, m.hp); m.hp = 0; }
      if (m.updateHpBar) m.updateHpBar();
      if (m.updateRaidHp) m.updateRaidHp();
      // 無限地獄ラッシュは撃破カウント（bossDown）、それ以外は勝利終了。
      if (m.hp <= 0) { if (m.mode === 'dungeon') m.floorCleared(); else if (m.bossDown) m.bossDown(); else if (m.finish) m.finish(true); }
      break;
    }
    case 'bossatk': {
      if (!m) return toast('ボス戦・ダンジョンのみ', 'err');
      if (m.attack) m.attack();                                    // ダンジョン/レイド
      else if (typeof m.nextAtk === 'number') m.nextAtk = Date.now();   // 新ボス戦: 次tickで技発動
      else return toast('ボス戦・ダンジョンのみ', 'err');
      break;
    }
    // ---- dungeon ----
    case 'floorclear': if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err'); if (m.perkOpen) return; e.score += Math.max(0, m.hp); m.hp = 0; m.updateHpBar(); m.floorCleared(); break;
    case 'warp10': case 'floor100': {
      if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err');
      if (m.perkOpen) return;
      m.floor = name === 'floor100' ? m.realm.floors - 1 : Math.min(m.realm.floors - 1, m.floor + 9);
      m.hp = 0; m.updateHpBar(); m.floorCleared(); break;
    }
    case 'lives': if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err'); m.lives += 5; m.updateHud(); break;
    case 'perks': if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err'); for (const id of ['atk', 'atk', 'reroll', 'heal', 'slow', 'life', 'shield']) m.applyPerk(id); m.updateHud(); toast('パーク全付与', 'ok'); break;
    // ---- ultimates ----
    case 'ultmax': if (!needGame()) return; e.ult = 100; break;
    case 'ultfire': if (!needGame()) return; e.ult = 100; fireUltCurrent(); break;
    case 'ultcast': {
      if (!needGame()) return;
      const out = fireUlt(arg, { engine: e, view, mode: m });
      if (out.error) toast(out.error, 'err'); else { e.ultUses++; toast(out.msg, 'announce', 2200); if (e.over && e.hasAnyMove()) e.over = false; if (e.over) handleEngineOver(); }
      break;
    }
    // ---- god ----
    case 'godall': Object.assign(god, { invincible: true, noGarbage: true, combo: true, fever: true, freezeEnemy: true, stopTimer: false, mult: 10 }); applyGod(); confettiBurst(40); toast('ゴッドモードON', 'announce'); closeModal(); showAdminPalette('god'); return;
    case 'godoff': Object.assign(god, { invincible: false, noGarbage: false, combo: false, fever: false, freezeEnemy: false, stopTimer: false, mult: 1 }); applyGod(); toast('ゴッドモードOFF', ''); closeModal(); showAdminPalette('god'); return;
    default: toast('不明なコマンド', 'err');
  }
  if (e && m) { refreshHud(m); if (e.over && e.hasAnyMove()) e.over = false; }
}

// Text commands: /score 5000, /floor 50, /time +120, /hp 1, /mult 10, /lives 9, /ult judgement
export function runCommandLine(line) {
  const [c, ...rest] = line.replace(/^\//, '').trim().split(/\s+/);
  const arg = rest.join(' ');
  const n = Number(arg.replace('+', ''));
  const m = getCurrentMode();
  const e = m && m.engine;
  switch ((c || '').toLowerCase()) {
    case 'score': if (!needGame()) return; if (arg.startsWith('+') || arg.startsWith('-')) e.score = Math.max(0, e.score + Number(arg)); else e.score = Math.max(0, n || 0); refreshHud(m); toast(`スコア → ${fmt(e.score)}`, 'ok'); break;
    case 'floor': if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err'); if (m.perkOpen) return; m.floor = Math.max(1, Math.min(m.realm.floors, Math.floor(n) || 1)) - 1; m.hp = 0; m.updateHpBar(); m.floorCleared(); break;
    case 'time': if (!m || m.endAt === undefined) return toast('タイマーのあるモードのみ', 'err'); m.endAt += (n || 60) * 1000; m.timeLeft += (n || 60); toast(`${n > 0 ? '+' : ''}${n}秒`, 'ok'); break;
    case 'hp': if (!m || !enemyHp(m)) return toast('敵のいるモードのみ', 'err'); m.hp = Math.max(0, Math.floor(n) || 0); if (m.updateHpBar) m.updateHpBar(); if (m.hp <= 0) { if (m.mode === 'dungeon') m.floorCleared(); else if (m.bossDown) m.bossDown(); else if (m.finish) m.finish(true); } break;
    case 'mult': god.mult = Math.max(1, Math.min(1000, n || 1)); applyGod(); toast(`スコア倍率 ×${god.mult}`, 'ok'); break;
    case 'lives': if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err'); m.lives = Math.max(1, Math.floor(n) || 1); m.updateHud(); break;
    case 'ult': { if (!needGame()) return; const id = arg.startsWith('ult_') ? arg : `ult_${arg}`; adminCmd(`ultcast:${ULT_META[id] ? id : equippedUlt()}`); break; }
    case 'item': if (!needGame()) return; useGameItem(arg.startsWith('item_') ? arg : `item_${arg}`); break;
    case 'god': adminCmd(arg === 'off' ? 'godoff' : 'godall'); break;
    case 'auto': autopilot.on ? stopAutopilot() : toggleAutopilotOn(); break;
    case 'help': toast('/score /floor /time /hp /mult /lives /ult /item /god /auto', '', 4000); break;
    default: toast(`不明なコマンド: ${c}（/help）`, 'err');
  }
}

// ---------------------------------------------------------------------------
// Autopilot 5.0 — 不滅ブレイン + オートレスキュー
// ---------------------------------------------------------------------------

export const AUTO_BRAINS = ['immortal', 'easy', 'normal', 'hard', 'oni', 'kami', 'souzou'];
export const AUTO_SPEEDS = [1, 2, 4, 8, 16, 32];
export const AUTO_STYLES = [['normal', '通常'], ['clear', '全消し狙い'], ['combo', 'コンボ重視'], ['safe', '安全重視']];

// The immortal brain is autopilot-only — it must never appear in the VS AI
// difficulty list, so its label lives here instead of AI_LEVELS.
// iconName は AI_LEVELS 側（ai.js）と同じ形。不滅ブレインは
// 対戦の難易度ではなくオート専用なので、顔を持たず infinity（≡死なない）を使う。
const BRAIN_META = { immortal: { iconName: 'infinity', name: '不滅', nameEn: 'Immortal' } };
const brainInfo = b => BRAIN_META[b] || AI_LEVELS[b] || BRAIN_META.immortal;

function toggleAutopilotOn() {
  autopilot.on = true;
  updateAutoBtn();
  runAutopilot();
}

export function showAutopilotPanel() {
  if (!isAdmin()) return;
  const a = autopilot;
  const m = showModal(`
    <h2>${ic('autopilot', 20)} オートパイロット 5.0</h2>
    <p style="opacity:.72;font-size:12px;margin:2px 0 8px">不滅ブレイン：生存最優先の探索で32倍速でも死なない。詰んでもオートレスキューが即蘇生。</p>
    <div class="form-col">
      <div class="settings-row"><label>電源</label><div class="seg" id="auOn">
        <button data-v="1" ${a.on ? 'class="active"' : ''}>ON</button><button data-v="0" ${!a.on ? 'class="active"' : ''}>OFF</button></div></div>
      <div class="settings-row"><label>ブレイン</label><div class="seg seg-wrap" id="auBrain">
        ${AUTO_BRAINS.map(b => `<button data-v="${b}" ${a.brain === b ? 'class="active"' : ''}>${ic(brainInfo(b).iconName, 15)} ${brainInfo(b).name}</button>`).join('')}</div></div>
      <div class="settings-row"><label>${ic('mode_sprint')} 速度</label><div class="seg seg-wrap" id="auSpeed">
        ${AUTO_SPEEDS.map(s => `<button data-v="${s}" ${a.speed === s ? 'class="active"' : ''}>x${s}</button>`).join('')}</div></div>
      <div class="settings-row"><label>スタイル</label><div class="seg seg-wrap" id="auStyle">
        ${AUTO_STYLES.map(([id, l]) => `<button data-v="${id}" ${(a.style || 'normal') === id ? 'class="active"' : ''}>${l}</button>`).join('')}</div></div>
      <div class="toggle-grid">
        <label class="toggle-item"><input type="checkbox" id="auItems" ${a.autoItems !== false ? 'checked' : ''}><span>${ic('cat_boost')} アイテム自動使用</span></label>
        <label class="toggle-item"><input type="checkbox" id="auUlt" ${a.autoUlt !== false ? 'checked' : ''}><span>${ic('ultimate')} 奥義自動発動</span></label>
        <label class="toggle-item"><input type="checkbox" id="auGuard" ${a.guard !== false ? 'checked' : ''}><span>オートレスキュー（詰み防止）</span></label>
        <label class="toggle-item"><input type="checkbox" id="auContinue" ${a.autoContinue ? 'checked' : ''}><span>${ic('reroll')} 終了後も自動で続ける</span></label>
        <label class="toggle-item"><input type="checkbox" id="auPerks" ${a.autoPerks !== false ? 'checked' : ''}><span>パーク自動選択</span></label>
      </div>
      <div class="settings-row"><label>目標スコアで停止</label><input id="auTarget" type="number" min="0" step="1000" value="${a.targetScore || ''}" placeholder="なし" style="width:110px"></div>
      <div class="test-out" id="auStats" style="white-space:pre-line">${autoStatsText()}</div>
    </div>
    <div class="modal-buttons"><button class="btn btn-ghost" id="auClose">閉じる</button><button class="btn btn-primary" id="auApply">適用</button></div>`);
  const seg = (id, key, cast = v => v) => m.querySelectorAll(`#${id} button`).forEach(b => {
    b.onclick = () => { m.querySelectorAll(`#${id} button`).forEach(x => x.classList.remove('active')); b.classList.add('active'); a[key] = cast(b.dataset.v); audio.click(); };
  });
  seg('auOn', 'on', v => v === '1');
  seg('auBrain', 'brain');
  seg('auSpeed', 'speed', Number);
  seg('auStyle', 'style');
  m.querySelector('#auClose').onclick = closeModal;
  m.querySelector('#auApply').onclick = () => {
    a.autoItems = m.querySelector('#auItems').checked;
    a.autoUlt = m.querySelector('#auUlt').checked;
    a.guard = m.querySelector('#auGuard').checked;
    a.autoContinue = m.querySelector('#auContinue').checked;
    a.autoPerks = m.querySelector('#auPerks').checked;
    a.targetScore = Number(m.querySelector('#auTarget').value) || 0;
    closeModal();
    if (a.on) { runAutopilot(); toast(`起動: ${brainInfo(a.brain || 'immortal').name}ブレイン x${a.speed} ${AUTO_STYLES.find(s => s[0] === (a.style || 'normal'))[1]}`, 'ok', 2600); }
    else { stopAutopilot(); toast('停止しました', '', 1200); }
    updateAutoBtn();
  };
  const tick = setInterval(() => { const el = m.querySelector('#auStats'); if (!el || !m.isConnected) { clearInterval(tick); return; } el.textContent = autoStatsText(); }, 1000);
}

function autoStatsText() {
  const a = autopilot;
  const s = a.stats || { moves: 0, clears: 0, rescues: 0, thinkMs: 0, started: 0 };
  const secs = Math.max(1, (Date.now() - (s.started || Date.now())) / 1000);
  const plan = a.lastPlan;
  // この文字列は1秒ごとに textContent へ入れ直すので、絵は置けない（言葉だけ）。
  const danger = !plan ? '—'
    : plan.stranded > 0 || plan.missingW > 0.25 ? '危険'
    : plan.missingW > 0.06 ? '注意' : '安全';
  return `手数 ${fmt(s.moves)} ・ 消去 ${fmt(s.clears)} ライン ・ ${(s.moves / secs).toFixed(1)} 手/秒 ・ 稼働 ${Math.floor(secs)}秒
レスキュー ${fmt(s.rescues || 0)}回 ・ 思考 ${(s.thinkMs || 0).toFixed(1)}ms ・ 盤面 ${danger}`;
}

// Quick tap on the HUD autopilot button: ON → speed up → panel on long list; a
// long press opens the panel (handled in main.js).
export function quickAutopilot() {
  if (!isAdmin()) return;
  audio.click();
  if (!autopilot.on) {
    autopilot.on = true;
    autopilot.speed = autopilot.speed || 1;
    toast(`オートパイロット起動（${brainInfo(autopilot.brain || 'immortal').name}） — 長押しで設定`, 'ok', 2200);
    updateAutoBtn();
    runAutopilot();
  } else {
    const i = AUTO_SPEEDS.indexOf(autopilot.speed);
    if (i >= 0 && i < AUTO_SPEEDS.length - 1) { autopilot.speed = AUTO_SPEEDS[i + 1]; toast(`速度 x${autopilot.speed}`, '', 1000); updateAutoBtn(); }
    else { stopAutopilot(); toast('停止しました', '', 1200); }
  }
}

// ---------------------------------------------------------------------------
// 📊 プレイヤー統計（管理者専用）
// ---------------------------------------------------------------------------
//
// 「誰がいつオンラインになったのか」を運営が読む面。出どころは
// /api/admin/playerstats（一覧＋全体サマリ）と /api/admin/playerstats/:id
// （個人の詳細）と /api/admin/residents（住人の名簿）と
// /api/admin/online（**いま**誰が繋いでいるか）の4本だけで、どれも
// requireAuth + requireAdmin で守られている。
//
// ■ なぜ admintools.js に置くのか
// 管理者パネルの画面そのもの（screens.js / index.html）は別担当の持ち物。
// こちらから触れるのは「自分で作った DOM を差し込むこと」だけなので、
// パネルにボタンを1つ足して、中身はモーダルで持つ形にしてある。
// 枠が別担当の手で正式に生えたら、そちらから showPlayerStats() を呼ぶだけで
// この差し込みは外せる（mountPlayerStatsButton が二重に足さない）。
//
// ■ CSS を増やさない
// public/css も別担当なので、既にある .stat-card / .live-* / .tabs だけを
// 借り、足りないところはインライン指定で済ませている。
//
// ■ 住人（AI）と実プレイヤー
// サーバーが **入れ物ごと** 分けて返す（summary.players と summary.residents）。
// 画面でも混ぜない。ここは管理者しか到達できない面なので区別を出してよいが、
// 同じ描画関数を非管理者の画面へ持ち出さないこと。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 時刻の見せ方。運営が知りたいのは「どれくらい前か」なので相対表記を先に出し、
// 実際の日時は title 属性に置く（並べたときに桁がそろい、詳しく見たいときは
// 触れば分かる）。0 は「記録がない」であって「1970年」ではないので必ず — にする。
function whenText(t) {
  if (!t) return '—';
  const d = Math.max(0, Date.now() - t);
  if (d < 60000) return 'たった今';
  if (d < 3600000) return `${Math.floor(d / 60000)}分前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}時間前`;
  if (d < 30 * 86400000) return `${Math.floor(d / 86400000)}日前`;
  return `${Math.floor(d / 86400000 / 30)}か月前`;
}
const whenFull = t => (t ? new Date(t).toLocaleString('ja-JP') : '記録なし');
const dayText = t => (t ? new Date(t).toLocaleDateString('ja-JP') : '—');

// 累計プレイ時間などの秒数。0 は本当に 0 なので — にはしない。
function durText(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分`;
  return `${Math.floor(h / 24)}日${h % 24}時間`;
}
// 在席区間の長さ（ms）。1分未満の区間もあるので秒まで出す。
const spanText = ms => durText(Math.round((Number(ms) || 0) / 1000));

// ログイン回数は v2.37 から数え始めた。0 は「0回来た」ではなく
// 「まだ数えていない」なので、0 と未計測を同じ顔で出さない。
const countText = (n, unit) => (n > 0 ? `${fmt(n)}${unit}` : '—');

const PS_TABS = [
  ['summary', '全体', 'leaderboard'],
  // 👀 いま誰が繋いでいるか。他の3つが「記録」なのに対してここだけ「実況」で、
  // 数秒ごとに勝手に更新される（下の OL_REFRESH_MS）。
  ['online', 'オンライン', 'mode_online'],
  ['players', 'プレイヤー', 'user'],
  ['residents', '住人', 'mask'],
];
const PS_SORTS = [
  ['lastOnline', '最終オンライン'], ['playSecs', 'プレイ時間'], ['games', 'プレイ回数'],
  ['logins', 'ログイン'], ['streak', '連続'], ['rating', 'レート'],
  ['level', 'レベル'], ['createdAt', '登録日'], ['name', '名前'],
];

// 開き直しても条件が残るように、状態はモジュールに置く。
const ps = { tab: 'summary', sort: 'lastOnline', order: 'desc', q: '', offset: 0, limit: 50 };

const psAdmin = () => !!session.user && session.user.role === 'admin';

export async function showPlayerStats(tab = ps.tab) {
  if (!psAdmin()) return toast('管理者専用です', 'err');
  ps.tab = PS_TABS.some(([id]) => id === tab) ? tab : 'summary';
  const modal = showModal(`
    <h2>${ic('leaderboard', 20)} プレイヤー統計</h2>
    <div class="tabs" style="justify-content:center;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${PS_TABS.map(([id, l, name]) => `<button class="tab ${ps.tab === id ? 'active' : ''}" data-pt="${id}">${ic(name)} ${l}</button>`).join('')}
    </div>
    <div id="psBody"><p class="muted center">読み込み中…</p></div>
    <div class="modal-buttons"><button class="btn btn-ghost" id="psClose">閉じる</button></div>`);
  modal.querySelector('#psClose').onclick = closeModal;
  modal.querySelectorAll('[data-pt]').forEach(b => {
    b.onclick = () => { audio.click(); ps.offset = 0; closeModal(); showPlayerStats(b.dataset.pt); };
  });
  const body = modal.querySelector('#psBody');
  try {
    if (ps.tab === 'online') await renderOnlineTab(body);
    else if (ps.tab === 'residents') renderResidentsTab(body, await api('/api/admin/residents'));
    else renderStatsTab(body, await api(psQuery()), modal);
  } catch (err) {
    // 403 は「管理者ではない」。サーバー側の requireAdmin が最終判断なので、
    // ここで理由をそのまま見せる（画面側の判定だけを信じない）。
    body.innerHTML = `<p class="muted center">${ic('warn', 14)} ${esc(err.message)}</p>`;
  }
}

function psQuery() {
  const p = new URLSearchParams({
    sort: ps.sort, order: ps.order,
    offset: String(ps.offset), limit: String(ps.limit),
  });
  if (ps.q) p.set('q', ps.q);
  return `/api/admin/playerstats?${p.toString()}`;
}

// 全体サマリとプレイヤー一覧は同じ応答から描く（サーバーに2回聞かない）。
function renderStatsTab(body, data, modal) {
  body.innerHTML = ps.tab === 'summary' ? summaryHtml(data) : playersHtml(data);
  if (ps.tab === 'summary') return;

  const reload = async () => {
    body.innerHTML = '<p class="muted center">読み込み中…</p>';
    try { renderStatsTab(body, await api(psQuery()), modal); }
    catch (err) { body.innerHTML = `<p class="muted center">${ic('warn', 14)} ${esc(err.message)}</p>`; }
  };
  const search = body.querySelector('#psSearch');
  if (search) {
    // Enter でも「検索」でも同じ経路。入力のたびに投げると、
    // 8,000件の集計を打鍵ごとに走らせることになるので投げない。
    const go = () => { ps.q = search.value.trim(); ps.offset = 0; reload(); };
    search.addEventListener('keydown', ev => { if (enterIsLive(ev)) go(); ev.stopPropagation(); });
    body.querySelector('#psSearchGo').onclick = () => { audio.click(); go(); };
  }
  body.querySelectorAll('[data-sort]').forEach(b => {
    b.onclick = () => {
      audio.click();
      // 同じ列をもう一度押したら昇順／降順を入れ替える。
      if (ps.sort === b.dataset.sort) ps.order = ps.order === 'desc' ? 'asc' : 'desc';
      else { ps.sort = b.dataset.sort; ps.order = b.dataset.sort === 'name' ? 'asc' : 'desc'; }
      ps.offset = 0;
      reload();
    };
  });
  body.querySelectorAll('[data-page]').forEach(b => {
    b.onclick = () => { audio.click(); ps.offset = Math.max(0, Number(b.dataset.page) || 0); reload(); };
  });
  body.querySelectorAll('[data-uid]').forEach(b => {
    b.onclick = () => { audio.click(); showPlayerDetail(b.dataset.uid); };
  });
}

function summaryHtml(data) {
  const s = data.summary || {};
  const p = s.players || {};
  const r = s.residents || {};
  const card = (v, label, title = '') => `<div class="stat-card"${title ? ` title="${esc(title)}"` : ''}><b>${v}</b><span>${esc(label)}</span></div>`;
  const modes = (s.modes || []).map(m => `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-name">${esc(m.id)}</span>
      <span class="live-sub">${fmt(m.plays)}戦 ・ ${fmt(m.wins)}勝 ・ 最高 ${fmt(m.best)}点</span>
    </div>`).join('');
  // 推移は棒グラフ1本。CSS を足せないので、幅の割合だけで見せる。
  const trend = s.trend || [];
  const peak = Math.max(1, ...trend.map(d => Math.max(d.actives, d.signups)));
  const trendRows = trend.map(d => `<div class="live-row" style="grid-template-columns:88px minmax(0,1fr) auto">
      <span class="live-sub">${esc(d.day)}</span>
      <span style="display:block;height:10px;border-radius:5px;background:rgba(255,255,255,.06)">
        <span style="display:block;height:10px;border-radius:5px;width:${Math.round(d.actives / peak * 100)}%;background:var(--cyan,#43d9e8)"></span></span>
      <span class="live-sub">遊んだ ${fmt(d.actives)} ・ 新規 ${fmt(d.signups)}</span>
    </div>`).join('');
  return `
    <p class="live-head">${ic('user', 14)} 実プレイヤー</p>
    <div class="admin-stats" style="margin-bottom:10px">
      ${card(fmt(p.total || 0), '登録ユーザー')}
      ${card(fmt(p.online || 0), 'いま接続中')}
      ${card(fmt(p.activeToday || 0), '今日きた人')}
      ${card(fmt(p.activeWeek || 0), '今週きた人')}
      ${card(fmt(p.activeMonth || 0), '30日以内')}
      ${card(fmt(p.newToday || 0), '今日の新規')}
      ${card(fmt(p.newWeek || 0), '今週の新規')}
      ${card(durText(p.totalPlaySecs || 0), '総プレイ時間')}
      ${card(fmt(p.totalGames || 0), '総プレイ回数')}
      ${card(countText(p.totalLogins || 0, '回'), 'ログイン総数', 'v2.37 から計測。それ以前のログインは含まれません')}
      ${card(fmt(p.banned || 0), '凍結中')}
      ${card(fmt(p.muted || 0), 'ミュート中')}
    </div>
    ${/* ⚠ 住人（AI）の数は実プレイヤーと必ず別の箱に出す。足した数を1つ出すと、
          この画面を見た運営が「実際に何人来ているか」を二度と読めなくなる。 */''}
    <p class="live-head">${ic('mask', 14)} 住人（AI・運営だけに見えます）</p>
    <div class="admin-stats" style="margin-bottom:10px">
      ${card(fmt(r.total || 0), '名簿の人数')}
      ${card(fmt(r.online || 0), 'いまオンライン')}
      ${card(fmt(r.withRecord || 0), '実対戦の記録あり')}
      ${card(`${fmt(r.wins || 0)}-${fmt(r.losses || 0)}`, '住人の通算（勝-敗）')}
    </div>
    <p class="live-head">${ic('leaderboard', 14)} モード別の人気
      <span class="muted" style="font-weight:400;font-size:11px">（直近${fmt(s.historyKeep || 40)}戦ぶんの履歴から）</span></p>
    ${modes ? `<div class="live-list">${modes}</div>` : '<p class="muted" style="font-size:12px">まだ履歴がありません</p>'}
    <p class="live-head" style="margin-top:10px">${ic('calendar', 14)} 直近${fmt(s.trendDays || 14)}日の推移</p>
    ${trendRows ? `<div class="live-list">${trendRows}</div>` : '<p class="muted" style="font-size:12px">まだ記録がありません</p>'}`;
}

function playersHtml(data) {
  const rows = (data.users || []).map(u => {
    const tag = u.role === 'admin' ? '<span class="live-tag admin">管理</span>'
      : u.role === 'mod' ? '<span class="live-tag admin">モデ</span>' : '';
    const state = u.banned ? '<span class="live-tag guest">凍結</span>'
      : u.online ? '<span class="live-tag user">接続中</span>' : '';
    return `<button data-uid="${esc(u.id)}" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;width:100%;text-align:left;background:rgba(255,255,255,.04);border:0;border-radius:8px;padding:6px 10px;color:inherit;font:inherit;cursor:pointer">
      <span class="live-name">${esc(u.username)}${tag}${state}</span>
      <span class="live-sub" title="${esc(whenFull(u.lastOnline))}">${esc(whenText(u.lastOnline))}</span>
      <span class="live-sub" style="grid-column:1/-1;white-space:normal">
        プレイ ${esc(durText(u.playSecs))} ・ ${fmt(u.gamesPlayed)}戦 ・ ログイン ${esc(countText(u.logins, '回'))}
        ・ 連続 ${fmt(u.loginStreak)}日（最長${fmt(u.loginStreakBest)}）
        ・ R${fmt(u.rating)} ・ Lv.${fmt(u.level)} ・ 登録 ${esc(dayText(u.createdAt))}</span>
    </button>`;
  }).join('');
  const from = data.matched ? data.offset + 1 : 0;
  const to = Math.min(data.matched, data.offset + data.limit);
  const prev = Math.max(0, data.offset - data.limit);
  const next = data.offset + data.limit;
  return `
    <div class="settings-row" style="margin-bottom:6px">
      <input id="psSearch" type="text" maxlength="16" placeholder="名前で検索…" value="${esc(ps.q)}" style="flex:1;min-width:140px">
      <button class="btn btn-sm btn-primary" id="psSearchGo">${ic('search')} 検索</button>
    </div>
    <div class="tabs" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">
      ${PS_SORTS.map(([id, l]) => `<button class="tab ${ps.sort === id ? 'active' : ''}" data-sort="${id}" style="font-size:11px;padding:4px 8px">${esc(l)}${ps.sort === id ? (ps.order === 'desc' ? ' ▼' : ' ▲') : ''}</button>`).join('')}
    </div>
    <p class="muted" style="font-size:11px;margin:0 0 6px">
      ${fmt(data.total)}人中 ${fmt(data.matched)}人が該当 ・ ${fmt(from)}〜${fmt(to)}件目を表示（1ページ${fmt(data.limit)}件）
      ・ 行を押すと詳しい記録が開きます</p>
    ${rows ? `<div class="live-list" style="max-height:min(52vh,420px)">${rows}</div>`
      : '<p class="muted center" style="font-size:12px">該当するプレイヤーがいません</p>'}
    <div class="settings-row" style="justify-content:center;margin-top:8px">
      <button class="btn btn-sm btn-ghost" data-page="${prev}" ${data.offset <= 0 ? 'disabled' : ''}>← 前の${fmt(data.limit)}件</button>
      <button class="btn btn-sm btn-ghost" data-page="${next}" ${next >= data.matched ? 'disabled' : ''}>次の${fmt(data.limit)}件 →</button>
    </div>`;
}

// 🎭 住人の名簿。/api/admin/residents は前から `record`（実プレイヤーと
// 当たったぶんの実戦績）を返していたのに、どの画面も読んでいなかった。
// 「計算で出しているレート」と「実際に人間と当たった結果」は別物なので、
// 並べて出さないと名簿の調整ができない。
function renderResidentsTab(body, data) {
  const list = (data.residents || []).slice()
    .sort((a, b) => (b.record ? b.record.w + b.record.l : -1) - (a.record ? a.record.w + a.record.l : -1));
  const rows = list.map(r => {
    const rec = r.record;
    // 「実対戦 3勝7敗 / レート -55」。差分が無い住人は行が無いのと同じなので、
    // 0勝0敗の行と取り違えないよう言葉で書き分ける。
    const recText = rec
      ? `実対戦 ${fmt(rec.w)}勝${fmt(rec.l)}敗 / レート ${rec.rd > 0 ? '+' : ''}${fmt(rec.rd)}${rec.lastAt ? ` ・ ${whenText(rec.lastAt)}` : ''}`
      : '実対戦の記録なし';
    return `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-name">${esc(r.name)}
        <span class="live-tag ${r.online ? 'user' : 'guest'}">${r.online ? 'オンライン' : 'オフ'}</span>
        ${r.custom ? '<span class="live-tag admin">追加</span>' : ''}</span>
      <span class="live-sub">R${fmt(r.rating)} ・ ${esc(r.tier || '')} ・ Lv.${fmt(r.level)}</span>
      <span class="live-sub" style="grid-column:1/-1;white-space:normal">${esc(r.archLabel || '')} ・ 腕前${Math.round((r.skill || 0) * 100)} ・ ${esc(recText)}</span>
    </div>`;
  }).join('');
  const retired = (data.retired || []).length;
  const st = data.status || {};
  body.innerHTML = `
    <p class="muted" style="font-size:11px;margin:0 0 6px">
      ${ic('warn', 12)} ここは運営専用の面です。住人は実プレイヤーではありません
      ${st.scale != null ? ` ・ にぎわい倍率 ×${esc(st.scale)}` : ''}
      ${retired ? ` ・ 引退 ${fmt(retired)}人` : ''}</p>
    ${rows ? `<div class="live-list" style="max-height:min(56vh,460px)">${rows}</div>`
      : '<p class="muted center" style="font-size:12px">名簿が空です</p>'}`;
}

// ---------------------------------------------------------------------------
// 👀 いま誰がオンラインか（/api/admin/online）
// ---------------------------------------------------------------------------
//
// ■ 他のタブとの違い
// 全体／プレイヤー／住人は「記録」なので開いたときの1回で足りる。ここだけは
// 「実況」なので、数秒ごとに勝手に描き直す。ただし **一覧の部分だけ** を
// 差し替える ── 全部を innerHTML で捨てると、検索欄に打っている途中の文字と
// カーソル位置が5秒ごとに消える。
//
// ■ 止め方
// タイマーはモーダルが消えたら自分で止まる（描画先が DOM から外れたことを
// 毎回確かめる）。タブを切り替えるときはモーダルごと開き直すので、これで
// 二重に走ることはない。
//
// ■ 人数が多いときのために
// 上限（limit）と名前の絞り込み（q）と「実プレイヤーだけ／住人だけ」の
// 切り替えを付けてある。ロビーに居るだけの住人はにぎわい倍率しだいで数百人に
// なるので、既定では出さない（crowd のスイッチで足す）。
//
// ■ 住人と実プレイヤー
// サーバーが入れ物ごと分けて返す（players / residents）。画面でも節を分け、
// 住人の節には「運営だけに見えます」と必ず書く。

const OL_REFRESH_MS = 5000;
// 開き直しても条件が残るように、状態はモジュールに置く（ps と同じ作法）。
const ol = { q: '', crowd: false, only: 'all', limit: 100 };
let olTimer = null;

function olQuery() {
  const p = new URLSearchParams({ limit: String(ol.limit), only: ol.only });
  if (ol.q) p.set('q', ol.q);
  if (ol.crowd) p.set('crowd', '1');
  return `/api/admin/online?${p.toString()}`;
}

// 状態の見出しに色を付ける。.live-tag は既にあるクラスなので CSS を足さない。
// user＝遊んでいる／admin＝待っている／guest＝それ以外、と割り当てる。
const OL_TAG = { match: 'user', zero: 'user', tourney: 'user', room_watch: 'admin', royale_watch: 'admin', zero_watch: 'admin', queue: 'admin', room: 'admin' };

// 1行ぶん。実プレイヤーは押すと第5波の個人詳細（在席区間の履歴）へ飛べる。
// 住人は押せない（詳細に当たるものが無い）ので div のまま。
function olRow(r, { clickable }) {
  const tag = OL_TAG[r.act] || 'guest';
  const marks = [
    r.admin ? '<span class="live-tag admin">管理</span>' : '',
    r.role === 'mod' ? '<span class="live-tag admin">モデ</span>' : '',
    r.guest ? '<span class="live-tag guest">ゲスト</span>' : '',
    r.conns > 1 ? `<span class="live-tag user">${fmt(r.conns)}接続</span>` : '',
  ].join('');
  // 住人には接続時間が無い（socket を持たないので、そもそも存在しない）。
  const stay = r.since
    ? `<span title="${esc(whenFull(r.since))}">接続 ${esc(spanText(r.ms))}（${esc(whenText(r.since))}から）</span>`
    : '<span class="muted">接続時間なし</span>';
  const meta = [
    r.level != null ? `Lv.${fmt(r.level)}` : '',
    r.rating != null ? `R${fmt(r.rating)}` : '',
  ].filter(Boolean).join(' ・ ');
  const inner = `
      <span class="live-name">${esc(r.name)}${marks}</span>
      <span class="live-tag ${tag}">${esc(r.label || '不明')}</span>
      <span class="live-sub" style="grid-column:1/-1;white-space:normal">${stay}${r.detail ? ` ・ ${esc(r.detail)}` : ''}${meta ? ` ・ ${meta}` : ''}</span>`;
  const style = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;width:100%;text-align:left;background:rgba(255,255,255,.04);border:0;border-radius:8px;padding:6px 10px;color:inherit;font:inherit';
  return clickable && r.userId
    ? `<button data-uid="${esc(r.userId)}" style="${style};cursor:pointer">${inner}</button>`
    : `<div style="${style}">${inner}</div>`;
}

function olListHtml(d) {
  const t = d.totals || {};
  const card = (v, label, title = '') => `<div class="stat-card"${title ? ` title="${esc(title)}"` : ''}><b>${v}</b><span>${esc(label)}</span></div>`;
  const players = (d.players || []).map(r => olRow(r, { clickable: true })).join('');
  const residents = (d.residents || []).map(r => olRow(r, { clickable: false })).join('');
  const m = d.matched || {};
  const more = (n, shown) => (n > shown ? `<p class="muted" style="font-size:11px;margin:4px 0 0">${fmt(n)}人中 ${fmt(shown)}人を表示（上限 ${fmt(d.limit)}件・絞り込みで減らせます）</p>` : '');
  return `
    <div class="admin-stats" style="margin-bottom:8px">
      ${card(fmt(t.people || 0), 'いま接続中', '実プレイヤーの人数（複数タブは1人）')}
      ${card(fmt(t.guests || 0), 'うちゲスト')}
      ${card(fmt(t.conns || 0), '接続本数', '同じ人が対戦画面に入ると2本になります')}
      ${card(fmt(d.sockets || 0), 'WS総数', 'まだ名乗っていない接続も含む生の本数')}
    </div>
    ${/* ⚠ 住人の数は実プレイヤーと必ず別の箱に出す。足した数を1つ出すと、
          この画面を見た運営が「実際に何人来ているか」を二度と読めなくなる。 */''}
    <p class="live-head">${ic('user', 14)} 実プレイヤー
      <span class="muted" style="font-weight:400;font-size:11px">（押すと在席の履歴が開きます）</span></p>
    ${players ? `<div class="live-list" style="max-height:min(38vh,320px)">${players}</div>`
    : '<p class="muted center" style="font-size:12px">いま繋いでいる実プレイヤーはいません</p>'}
    ${more(m.players || 0, (d.players || []).length)}
    <p class="live-head" style="margin-top:10px">${ic('mask', 14)} 住人（AI・運営だけに見えます）
      <span class="muted" style="font-weight:400;font-size:11px">席 ${fmt(t.residentSeats || 0)}${d.crowd ? ` ・ ロビー ${fmt(t.residentLobby || 0)}` : ''}</span></p>
    ${residents ? `<div class="live-list" style="max-height:min(30vh,240px)">${residents}</div>`
    : `<p class="muted" style="font-size:12px">${d.crowd ? '住人はどこにも居ません（にぎわい倍率が0かもしれません）' : '試合に座っている住人はいません（ロビーの住人は「ロビーの住人も出す」で表示）'}</p>`}
    ${more(m.residents || 0, (d.residents || []).length)}
    ${(d.caveats || []).length ? `<p class="muted" style="font-size:11px;margin:8px 0 0;white-space:normal">
      ${ic('warn', 12)} ${(d.caveats || []).map(c => esc(c)).join('<br>')}</p>` : ''}`;
}

async function renderOnlineTab(body) {
  if (!psAdmin()) return;
  clearInterval(olTimer); olTimer = null;
  body.innerHTML = `
    <div class="settings-row" style="margin-bottom:6px">
      <input id="olSearch" type="text" maxlength="24" placeholder="名前で絞り込み…" value="${esc(ol.q)}" style="flex:1;min-width:130px">
      <button class="btn btn-sm btn-primary" id="olSearchGo">${ic('search')} 絞り込み</button>
    </div>
    <div class="tabs" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">
      ${[['all', 'ぜんぶ'], ['players', '実プレイヤーだけ'], ['residents', '住人だけ']]
    .map(([id, l]) => `<button class="tab ${ol.only === id ? 'active' : ''}" data-only="${id}" style="font-size:11px;padding:4px 8px">${esc(l)}</button>`).join('')}
      <button class="tab ${ol.crowd ? 'active' : ''}" id="olCrowd" style="font-size:11px;padding:4px 8px">ロビーの住人も出す</button>
    </div>
    <p class="muted" style="font-size:11px;margin:0 0 6px" id="olStamp">読み込み中…</p>
    <div id="olList"><p class="muted center">読み込み中…</p></div>`;

  const list = body.querySelector('#olList');
  const stamp = body.querySelector('#olStamp');
  const search = body.querySelector('#olSearch');

  // 一覧だけを描き直す。描画先がもう DOM に無い＝モーダルが閉じた／タブが
  // 変わった、なのでタイマーごと畳む（放っておくと裏で叩き続ける）。
  const tick = async () => {
    if (!document.body.contains(list)) { clearInterval(olTimer); olTimer = null; return; }
    let d;
    try { d = await api(olQuery()); }
    catch (err) {
      if (document.body.contains(list)) stamp.innerHTML = `${ic('warn', 12)} ${esc(err.message)}`;
      return;
    }
    if (!document.body.contains(list)) return;   // 待っているあいだに閉じられた
    list.innerHTML = olListHtml(d);
    stamp.textContent = `${new Date(d.at).toLocaleTimeString('ja-JP')} 時点 ・ ${Math.round(OL_REFRESH_MS / 1000)}秒ごとに自動更新`;
    list.querySelectorAll('[data-uid]').forEach(b => {
      b.onclick = () => { audio.click(); showPlayerDetail(b.dataset.uid); };
    });
  };

  const go = () => { ol.q = search.value.trim(); tick(); };
  search.addEventListener('keydown', ev => { if (enterIsLive(ev)) go(); ev.stopPropagation(); });
  body.querySelector('#olSearchGo').onclick = () => { audio.click(); go(); };
  body.querySelectorAll('[data-only]').forEach(b => {
    b.onclick = () => {
      audio.click();
      ol.only = b.dataset.only;
      body.querySelectorAll('[data-only]').forEach(x => x.classList.toggle('active', x === b));
      tick();
    };
  });
  const crowdBtn = body.querySelector('#olCrowd');
  crowdBtn.onclick = () => {
    audio.click();
    ol.crowd = !ol.crowd;
    crowdBtn.classList.toggle('active', ol.crowd);
    tick();
  };

  olTimer = setInterval(tick, OL_REFRESH_MS);
  await tick();
}

// 個人の詳細。閉じたら一覧へ戻れるように showModal の back を渡す。
// ⚠ 戻り先は「開いたときのタブ」。決め打ちで 'players' に戻していたので、
//    👀オンラインの行から開いて戻ると別のタブに落ちていた（自分が押した行が
//    どこにも無い画面に出るので、戻ったつもりが迷子になる）。
export async function showPlayerDetail(id, from = ps.tab) {
  if (!psAdmin()) return;
  const tab = PS_TABS.some(([t]) => t === from) && from !== 'summary' ? from : 'players';
  const back = () => showPlayerStats(tab);
  const modal = showModal(`<h2>${ic('user', 20)} プレイヤーの記録</h2>
    <div id="psdBody"><p class="muted center">読み込み中…</p></div>
    <div class="modal-buttons"><button class="btn btn-ghost" id="psdClose">閉じる</button></div>`, { back });
  modal.querySelector('#psdClose').onclick = closeModal;
  const body = modal.querySelector('#psdBody');
  let d;
  try { d = await api(`/api/admin/playerstats/${encodeURIComponent(id)}`); }
  catch (err) { body.innerHTML = `<p class="muted center">${ic('warn', 14)} ${esc(err.message)}</p>`; return; }

  const u = d.user || {};
  const live = d.live || {};
  const card = (v, label, title = '') => `<div class="stat-card"${title ? ` title="${esc(title)}"` : ''}><b style="font-size:17px">${v}</b><span>${esc(label)}</span></div>`;

  // 在席区間。「いつからいつまで居たか」がこの画面の本題。
  const spans = (d.online || []).map(s => {
    const end = s.at + (s.ms || 0);
    return `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-sub" style="white-space:normal">${esc(new Date(s.at).toLocaleString('ja-JP'))} → ${esc(new Date(end).toLocaleTimeString('ja-JP'))}</span>
      <span class="live-sub">${esc(spanText(s.ms))}</span>
    </div>`;
  }).join('');

  const hist = (d.history || []).map(h => `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-name">${esc(h.mode)}${h.won ? '<span class="live-tag user">勝</span>' : ''}</span>
      <span class="live-sub" title="${esc(whenFull(h.t))}">${fmt(h.score)}点 ・ ${esc(whenText(h.t))}</span>
    </div>`).join('');

  const modes = (d.modes || []).map(m => `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-name">${esc(m.id)}</span>
      <span class="live-sub">${fmt(m.plays)}戦 ${fmt(m.wins)}勝 ・ 最高 ${fmt(m.best)}点</span>
    </div>`).join('');

  const reports = (d.reports || []).map(r => `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-sub" style="white-space:normal">${esc(String(r.text).slice(0, 120))}</span>
      <span class="live-sub">${esc(r.status === 'done' ? '処理済' : '未処理')} ・ ${esc(whenText(r.at))}</span>
    </div>`).join('');

  const acts = (d.adminActions || []).map(a => `<div class="live-row" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="live-sub" style="white-space:normal">${esc(a.action)} ← ${esc(a.by)}</span>
      <span class="live-sub" title="${esc(whenFull(a.at))}">${esc(whenText(a.at))}</span>
    </div>`).join('');

  const section = (title, iconName, html, empty) =>
    `<p class="live-head" style="margin-top:10px">${ic(iconName, 14)} ${esc(title)}</p>`
    + (html ? `<div class="live-list" style="max-height:min(30vh,240px)">${html}</div>`
      : `<p class="muted" style="font-size:12px">${esc(empty)}</p>`);

  body.innerHTML = `
    <p class="live-head">${esc(u.username || '')}
      <span class="live-tag ${live.online ? 'user' : 'guest'}">${live.online ? '接続中' : 'オフライン'}</span>
      ${u.role !== 'user' ? `<span class="live-tag admin">${esc(u.role)}</span>` : ''}
      ${u.banned ? '<span class="live-tag guest">凍結</span>' : ''}</p>
    <div class="admin-stats" style="margin-bottom:8px">
      ${card(esc(whenText(live.lastOnline)), '最終オンライン', whenFull(live.lastOnline))}
      ${card(esc(whenText(live.lastLoginAt)), '最終ログイン', whenFull(live.lastLoginAt))}
      ${card(esc(durText(live.playSecs)), '累計プレイ時間')}
      ${card(fmt((u.stats && u.stats.gamesPlayed) || 0), '総プレイ回数')}
      ${card(esc(countText(live.logins, '回')), 'ログイン回数', 'v2.37 から計測')}
      ${card(`${fmt(live.loginStreak || 0)}日`, `連続ログイン（最長${fmt(live.loginStreakBest || 0)}）`)}
      ${card(fmt((u.stats && u.stats.rating) || 0), 'レート')}
      ${card(`Lv.${fmt(u.level || 1)}`, 'レベル')}
      ${card(esc(dayText(u.createdAt)), '登録日')}
      ${card(esc(live.lastDaily || '—'), 'ボーナス最終受取')}
      ${card(esc(countText(live.sessions, '回')), '接続セッション数')}
      ${card(fmt(d.onlineTotal || 0), '在席区間の記録数')}
    </div>
    ${/* 在席区間は closeOnlineSpan()（battle.js）が「最後の socket が閉じたとき」に
          押すので、いま繋いでいる人の区間はまだ配列に無い。0件を「一度も接続して
          いません」と決めつけると、同じ画面の上に出ている「接続中」と真逆のことを
          言ってしまう（実際にそうなっていた）。在席中かどうかで出し分ける。 */''}
    ${section('在席の履歴（いつからいつまで居たか）', 'clock', spans,
      d.onlineTotal ? ''
        : live.online
          ? 'いま接続中です（この区間は切断したときに記録されます）'
          : 'まだ在席の記録がありません（記録を始める前のアカウント、または一度も接続していません）')}
    ${section('直近のプレイ履歴', 'rematch', hist, 'まだプレイ履歴がありません')}
    ${section('モード別の内訳', 'leaderboard', modes, '—')}
    ${section('この人からの通報・バグ報告', 'bug', reports, '報告はありません')}
    ${section('運営がこの人に対して行った操作', 'admin', acts, '記録はありません')}`;
}

// 管理者パネル（#screen-admin）に入口を1つ足す。
//
// index.html と screens.js は別担当の持ち物なので、ボタンだけをこちらから
// 差し込む。.admin-actions を名乗るのは、モデレーターで開いたときに
// screens.js がこのクラスの箱をまとめて畳んでくれるから（管理者専用の面を
// モデレーターに出さない仕組みに、そのまま乗る）。
// 正式な枠が生えたら、あちらから showPlayerStats() を呼ぶだけでよい ──
// 既に #btnPlayerStats があれば足さないので、二重にはならない。
export function mountPlayerStatsButton() {
  if (document.getElementById('btnPlayerStats')) return;
  const screen = document.getElementById('screen-admin');
  const anchor = screen && screen.querySelector('#adminUserSearch');
  const before = anchor ? anchor.closest('.admin-actions') : null;
  if (!screen || !before) return;
  const row = document.createElement('div');
  row.className = 'admin-actions';
  const btn = document.createElement('button');
  btn.id = 'btnPlayerStats';
  btn.className = 'btn btn-ghost btn-sm';
  btn.innerHTML = `${ic('leaderboard')} プレイヤー統計`;
  btn.onclick = () => { audio.click(); showPlayerStats(); };
  row.appendChild(btn);
  screen.insertBefore(row, before);
}

// main.js は起動の終盤にこのモジュールを読む（startGodLoop を呼ぶため）ので、
// この時点で index.html の DOM は出来上がっている。念のため、まだなら
// DOMContentLoaded を待って1回だけ試す。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPlayerStatsButton, { once: true });
  } else {
    mountPlayerStatsButton();
  }
}

export { startSolo as _startSolo };
