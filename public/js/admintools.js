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
import { session } from './net.js';
import { $, showModal, closeModal, toast, confettiBurst, fmt, staffExtras } from './dom.js';
import { audio } from './audio.js';
import { SHAPES } from './engine.js';
import { AI_LEVELS } from './ai.js';

const isAdmin = () => !!session.user && session.user.role === 'admin' && staffExtras();

// Persistent "god" switches — live on the engine so every mode honours them.
export const god = { invincible: false, noGarbage: false, combo: false, mult: 1, fever: false, freezeEnemy: false, stopTimer: false, ultInfinite: true };

let godTimer = null;
function applyGod() {
  const m = getCurrentMode();
  const e = m && m.engine;
  if (!e) return;
  const view = getViewRef();
  if (view) view.godInvincible = god.invincible;
  e.fortressUntil = god.noGarbage ? 8.64e15 : (e.fortressUntil > 8e15 ? 0 : e.fortressUntil);
  if (god.combo) e.streakShield = true;
  // このループは全ユーザーで毎秒走る — 無条件で書くと、ダンジョンのパークや
  // 地獄ラッシュの剛力の遺物など「モードが積んだ scoreMult」を握り潰す。
  if (god.mult !== 1) e.scoreMult = god.mult;
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

const TABS = [['board', '🧱 盤面'], ['score', '✨ スコア'], ['hand', '🎴 手札'], ['time', '⏱ 時間/敵'], ['dungeon', '🏰 ダンジョン'], ['ult', '⚡ 奥義'], ['god', '👑 ゴッド']];

export function showAdminPalette(tab = 'board') {
  if (!isAdmin()) return;
  const m = getCurrentMode();
  const e = m && m.engine;
  const modal = showModal(`
    <h2>🛡️ 管理者コマンド 3.0</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">モード: <b>${modeLabel(m)}</b>${e ? ` ・ スコア ${fmt(e.score)} ・ ゲージ ${Math.round(e.ult)}%` : ''}</p>
    <div class="tabs" style="justify-content:center;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${TABS.map(([id, l]) => `<button class="tab ${tab === id ? 'active' : ''}" data-ct="${id}">${l}</button>`).join('')}
    </div>
    <div id="apBody" class="form-col admin-cmds"></div>
    <div class="settings-row" style="margin-top:10px">
      <input id="apCmd" type="text" placeholder="/score 5000  /floor 50  /time +120  /hp 1  /mult 10  /lives 9  /ult judgement" style="flex:1;min-width:200px">
      <button class="btn btn-sm btn-primary" id="apRun">実行</button>
    </div>
    <p class="muted center" style="font-size:11px;margin-top:6px">通貨付与・隠し解放・イベント・投票はホームの「🛡️管理」から</p>
    <div class="modal-buttons"><button class="btn btn-ghost" id="apClose">閉じる</button></div>`);
  modal.querySelector('#apClose').onclick = closeModal;
  modal.querySelectorAll('[data-ct]').forEach(b => { b.onclick = () => { audio.click(); closeModal(); showAdminPalette(b.dataset.ct); }; });
  const body = modal.querySelector('#apBody');
  const btn = (cmd, label, cls = 'btn-ghost') => `<button class="btn ${cls} btn-sm" data-cmd="${cmd}">${label}</button>`;
  const toggle = (key, label) => `<button class="btn btn-sm ${god[key] ? 'btn-gold' : 'btn-ghost'}" data-god="${key}">${god[key] ? '✅' : '⬜'} ${label}</button>`;

  const sections = {
    board: [btn('clear', '🧹 全消し'), btn('clearbottom', '⬇️ 下半分を消す'), btn('cleargarbage', '🗑️ お邪魔だけ消す'), btn('fill', '🧱 ランダムに50%埋める'), btn('checker', '♟️ 市松模様にする'), btn('revive', '♻️ 盤面リセット（スコア維持）')],
    score: [btn('score1k', '+1,000'), btn('score10k', '+10,000'), btn('score100k', '+100,000'), btn('scorex2', '×2'), btn('scorezero', '0にする', 'btn-ai')],
    hand: [btn('reroll', '🔄 リロール +5'), btn('rerollinf', '♾️ リロール無限'), btn('hand1', '🔹 全部 1×1'), btn('hand3', '🟥 全部 3×3'), btn('handline', '📏 全部 5マス線'), btn('handrainbow', '🌈 最適な手札')],
    time: [btn('time60', '⏱ +60秒'), btn('time300', '⏱ +5分'), btn('timeup', '⏰ 即タイムアップ', 'btn-ai'), btn('bosshalf', '👹 敵HP半減'), btn('boss1', '🩸 敵HPを1に'), btn('bosskill', '💀 即討伐'), btn('bossatk', '⚠️ 今すぐ敵の攻撃')],
    dungeon: [btn('floorclear', '🏰 フロア即クリア'), btn('warp10', '⏩ 10フロア進む'), btn('lives', '❤️ 残機 +5'), btn('perks', '🎁 パーク全付与'), btn('floor100', '🏁 最深部へワープ', 'btn-oni')],
    ult: [btn('ultmax', '⚡ ゲージMAX'), btn('ultfire', '💥 装備奥義を即発動'), ...Object.keys(ULT_META).map(id => btn(`ultcast:${id}`, `${ULT_META[id].icon} ${id.replace('ult_', '')}`))],
    god: [toggle('invincible', '無敵（ゲームオーバー無効）'), toggle('noGarbage', 'お邪魔無効'), toggle('combo', 'コンボ永続'), toggle('fever', 'フィーバー永続'), toggle('freezeEnemy', '敵の攻撃停止'), toggle('stopTimer', 'タイマー停止'),
      `<div class="settings-row"><label>スコア倍率 ×${god.mult}</label><div class="seg" id="apMult">${[1, 2, 5, 10, 100].map(v => `<button data-v="${v}" ${god.mult === v ? 'class="active"' : ''}>×${v}</button>`).join('')}</div></div>`,
      btn('godall', '👑 全部ON（ゴッドモード）', 'btn-gold'), btn('godoff', '⬜ 全部OFF')],
  };
  body.innerHTML = `<div class="admin-cmd-grid">${(sections[tab] || sections.board).join('')}</div>`;
  body.querySelectorAll('[data-cmd]').forEach(b => { b.onclick = () => adminCmd(b.dataset.cmd); });
  body.querySelectorAll('[data-god]').forEach(b => { b.onclick = () => { god[b.dataset.god] = !god[b.dataset.god]; applyGod(); audio.click(); closeModal(); showAdminPalette('god'); }; });
  body.querySelectorAll('#apMult button').forEach(b => { b.onclick = () => { god.mult = Number(b.dataset.v); applyGod(); audio.click(); closeModal(); showAdminPalette('god'); }; });
  const run = () => { const v = modal.querySelector('#apCmd').value.trim(); if (v) runCommandLine(v); modal.querySelector('#apCmd').value = ''; };
  modal.querySelector('#apRun').onclick = run;
  modal.querySelector('#apCmd').addEventListener('keydown', ev => { if (ev.key === 'Enter') run(); ev.stopPropagation(); });
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
    case 'clear': if (!needGame()) return; e.grid.fill(0); if (e.over && e.hasAnyMove()) e.over = false; view.reviveFlash(); toast('🧹 全消し', 'ok', 1200); break;
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
      m.endAt += add * 1000; m.timeLeft += add; toast(`⏱ +${add}秒`, 'ok', 1200); break;
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
    case 'perks': if (!m || m.mode !== 'dungeon') return toast('ダンジョンのみ', 'err'); for (const id of ['atk', 'atk', 'reroll', 'heal', 'slow', 'life', 'shield']) m.applyPerk(id); m.updateHud(); toast('🎁 パーク全付与', 'ok'); break;
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
    case 'godall': Object.assign(god, { invincible: true, noGarbage: true, combo: true, fever: true, freezeEnemy: true, stopTimer: false, mult: 10 }); applyGod(); confettiBurst(40); toast('👑 ゴッドモードON', 'announce'); closeModal(); showAdminPalette('god'); return;
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
    case 'time': if (!m || m.endAt === undefined) return toast('タイマーのあるモードのみ', 'err'); m.endAt += (n || 60) * 1000; m.timeLeft += (n || 60); toast(`⏱ ${n > 0 ? '+' : ''}${n}秒`, 'ok'); break;
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
// Autopilot 5.0 — ♾️不滅ブレイン + 🚑オートレスキュー
// ---------------------------------------------------------------------------

export const AUTO_BRAINS = ['immortal', 'easy', 'normal', 'hard', 'oni', 'kami', 'souzou'];
export const AUTO_SPEEDS = [1, 2, 4, 8, 16, 32];
export const AUTO_STYLES = [['normal', '通常'], ['clear', '全消し狙い'], ['combo', 'コンボ重視'], ['safe', '安全重視']];

// The immortal brain is autopilot-only — it must never appear in the VS AI
// difficulty list, so its label lives here instead of AI_LEVELS.
const BRAIN_META = { immortal: { avatar: '♾️', name: '不滅', nameEn: 'Immortal' } };
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
    <h2>🤖 オートパイロット 5.0</h2>
    <p style="opacity:.72;font-size:12px;margin:2px 0 8px">♾️不滅ブレイン：生存最優先の探索で32倍速でも死なない。詰んでも🚑オートレスキューが即蘇生。</p>
    <div class="form-col">
      <div class="settings-row"><label>電源</label><div class="seg" id="auOn">
        <button data-v="1" ${a.on ? 'class="active"' : ''}>ON</button><button data-v="0" ${!a.on ? 'class="active"' : ''}>OFF</button></div></div>
      <div class="settings-row"><label>🧠 ブレイン</label><div class="seg seg-wrap" id="auBrain">
        ${AUTO_BRAINS.map(b => `<button data-v="${b}" ${a.brain === b ? 'class="active"' : ''}>${brainInfo(b).avatar}${brainInfo(b).name}</button>`).join('')}</div></div>
      <div class="settings-row"><label>⚡ 速度</label><div class="seg seg-wrap" id="auSpeed">
        ${AUTO_SPEEDS.map(s => `<button data-v="${s}" ${a.speed === s ? 'class="active"' : ''}>x${s}</button>`).join('')}</div></div>
      <div class="settings-row"><label>🎯 スタイル</label><div class="seg seg-wrap" id="auStyle">
        ${AUTO_STYLES.map(([id, l]) => `<button data-v="${id}" ${(a.style || 'normal') === id ? 'class="active"' : ''}>${l}</button>`).join('')}</div></div>
      <div class="toggle-grid">
        <label class="toggle-item"><input type="checkbox" id="auItems" ${a.autoItems !== false ? 'checked' : ''}><span>💣 アイテム自動使用</span></label>
        <label class="toggle-item"><input type="checkbox" id="auUlt" ${a.autoUlt !== false ? 'checked' : ''}><span>⚡ 奥義自動発動</span></label>
        <label class="toggle-item"><input type="checkbox" id="auGuard" ${a.guard !== false ? 'checked' : ''}><span>🚑 オートレスキュー（詰み防止）</span></label>
        <label class="toggle-item"><input type="checkbox" id="auContinue" ${a.autoContinue ? 'checked' : ''}><span>🔁 終了後も自動で続ける</span></label>
        <label class="toggle-item"><input type="checkbox" id="auPerks" ${a.autoPerks !== false ? 'checked' : ''}><span>🎁 パーク自動選択</span></label>
      </div>
      <div class="settings-row"><label>🛑 目標スコアで停止</label><input id="auTarget" type="number" min="0" step="1000" value="${a.targetScore || ''}" placeholder="なし" style="width:110px"></div>
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
    if (a.on) { runAutopilot(); toast(`🤖 起動: ${brainInfo(a.brain || 'immortal').name}ブレイン x${a.speed} ${AUTO_STYLES.find(s => s[0] === (a.style || 'normal'))[1]}`, 'ok', 2600); }
    else { stopAutopilot(); toast('🤖 停止', '', 1200); }
    updateAutoBtn();
  };
  const tick = setInterval(() => { const el = m.querySelector('#auStats'); if (!el || !m.isConnected) { clearInterval(tick); return; } el.textContent = autoStatsText(); }, 1000);
}

function autoStatsText() {
  const a = autopilot;
  const s = a.stats || { moves: 0, clears: 0, rescues: 0, thinkMs: 0, started: 0 };
  const secs = Math.max(1, (Date.now() - (s.started || Date.now())) / 1000);
  const plan = a.lastPlan;
  const danger = !plan ? '—'
    : plan.stranded > 0 || plan.missingW > 0.25 ? '🔴危険'
    : plan.missingW > 0.06 ? '🟡注意' : '🟢安全';
  return `📊 手数 ${fmt(s.moves)} ・ 消去 ${fmt(s.clears)} ライン ・ ${(s.moves / secs).toFixed(1)} 手/秒 ・ 稼働 ${Math.floor(secs)}秒
🚑 レスキュー ${fmt(s.rescues || 0)}回 ・ 🧠 思考 ${(s.thinkMs || 0).toFixed(1)}ms ・ 盤面 ${danger}`;
}

// Quick tap on the HUD 🤖 button: ON → speed up → panel on long list; a
// long press opens the panel (handled in main.js).
export function quickAutopilot() {
  if (!isAdmin()) return;
  audio.click();
  if (!autopilot.on) {
    autopilot.on = true;
    autopilot.speed = autopilot.speed || 1;
    toast(`🤖 オートパイロット起動（${brainInfo(autopilot.brain || 'immortal').name}） — 長押しで設定`, 'ok', 2200);
    updateAutoBtn();
    runAutopilot();
  } else {
    const i = AUTO_SPEEDS.indexOf(autopilot.speed);
    if (i >= 0 && i < AUTO_SPEEDS.length - 1) { autopilot.speed = AUTO_SPEEDS[i + 1]; toast(`🤖 速度 x${autopilot.speed}`, '', 1000); updateAutoBtn(); }
    else { stopAutopilot(); toast('🤖 停止', '', 1200); }
  }
}

export { startSolo as _startSolo };
