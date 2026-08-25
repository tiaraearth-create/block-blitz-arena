// Game mode controllers: Solo, VS AI, Online (1v1 / 2v2 team / custom rooms),
// plus the admin-only autopilot.
import { Engine, shapeSize, Rng, SHAPES } from './engine.js';
import { GameView, MiniBoard } from './game.js';
import { chooseMove, AI_LEVELS, planImmortalMove } from './ai.js';
import { audio } from './audio.js';
import { session, api, refreshMe, BattleClient } from './net.js';
import { $, showScreen, showModal, closeModal, toast, countdownOverlay, fmt, updateTopbar, confettiBurst, rankOf, staffExtras } from './dom.js';
import { t, trServer, catName } from './i18n.js';
import { fireUlt, ultIcon, ultColor, ultExists, DEFAULT_ULT } from './skills.js';

const MATCH_SECONDS = 120;

let view = null;
let currentMode = null;

function getView() {
  if (!view) {
    view = new GameView($('#gameCanvas'), { interactive: true });
    view.onRescue = () => autoRescue();   // autopilot 5.0 guard (checks its own eligibility)
    window.__bbaView = view;   // debug/testing hook
  }
  view.setTheme(equippedTheme());
  view.resize();
  return view;
}

function equippedTheme() {
  const eq = (session.user && session.user.equipped) || {};
  return {
    skinId: eq.skin || 'skin_default',
    boardId: eq.board || 'board_default',
    fxId: eq.fx || 'fx_default',
  };
}

function guestBest() { return Number(localStorage.getItem('bba_best') || 0); }
function setGuestBest(v) { localStorage.setItem('bba_best', String(v)); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function submitResult(payload) {
  if (!session.user) return null;
  // Per-run telemetry the mission system feeds on — filled in centrally so
  // every mode reports it without repeating itself.
  const e = currentMode && currentMode.engine;
  const body = e
    ? { ults: e.ultUses || 0, items: e.itemUses || 0, pieces: e.piecesPlaced || 0, ...payload }
    : payload;
  try {
    const data = await api('/api/game/result', { method: 'POST', body });
    updateTopbar();
    if (data.rewards && data.rewards.missionsCompleted && data.rewards.missionsCompleted.length) {
      announceMissions(data.rewards.missionsCompleted.length);
    }
    return data.rewards;
  } catch (err) {
    console.warn('result submit failed:', err.message);
    return null;
  }
}

function announceMissions(n) {
  setTimeout(() => {
    audio.coin();
    toast(t(`📋 ミッションを${n}個達成！メニューの「ミッション」から報酬を受け取ろう`,
      `📋 ${n} mission(s) complete! Claim the rewards from the Missions menu`), 'announce', 4500);
    if (window.__bbaRefreshMissionDot) window.__bbaRefreshMissionDot();
  }, 1400);
}

function rewardsRows(rewards) {
  if (!rewards) {
    return `<div class="rs-row"><span>${t('💡 報酬を受け取るにはログイン', '💡 Log in to earn rewards')}</span></div>`;
  }
  return `
    <div class="rs-row"><span>${t('🪙 コイン', '🪙 Coins')}</span><b>+${fmt(rewards.coins)}</b></div>
    ${rewards.streakBonus ? `<div class="rs-row"><span>${t(`🔥 ${rewards.streak}連勝ボーナス`, `🔥 ${rewards.streak}-win streak bonus`)}</span><b>+${fmt(rewards.streakBonus)}🪙</b></div>` : ''}
    ${rewards.gems ? `<div class="rs-row"><span>${t('💎 初回討伐ボーナス', '💎 First-clear bonus')}</span><b>+${fmt(rewards.gems)}</b></div>` : ''}
    <div class="rs-row"><span>${t('🎫 パスXP', '🎫 Pass XP')}</span><b>+${fmt(rewards.bpXp)}</b></div>
    <div class="rs-row"><span>${t('⭐ アカウントXP', '⭐ Account XP')}</span><b>+${fmt(rewards.accXp)}</b></div>`;
}

export function quitCurrent() {
  if (currentMode) currentMode.quit();
}

// ---------------------------------------------------------------------------
// Reroll power-up (1 per game)
// ---------------------------------------------------------------------------

function updateRerollHud(engine) {
  const btn = $('#btnReroll');
  btn.classList.remove('hidden');
  // Admins get bottomless rerolls in every mode.
  if (session.user && session.user.role === 'admin') engine.infiniteReroll = true;
  if (engine.infiniteReroll) {
    $('#rerollLeft').textContent = '∞';
    btn.classList.remove('off');
  } else {
    $('#rerollLeft').textContent = engine.rerolls;
    btn.classList.toggle('off', engine.rerolls <= 0);
  }
}

function handleEngineOver() {
  if (!currentMode) return;
  if (autoRescue()) return;   // autopilot 5.0: the guard saved the board
  if (currentMode.onTopOut) currentMode.onTopOut();
  else currentMode.finish();
}

export function rerollCurrent() {
  if (!currentMode || !currentMode.engine || !view || view.inputLocked) return;
  const e = currentMode.engine;
  if (!e.reroll()) {
    audio.error();
    toast(t('リロールは使い切りました', 'No rerolls left'), 'err', 1400);
    return;
  }
  audio.coin();
  toast(t('🔄 ピースを引き直しました！', '🔄 New pieces drawn!'), 'ok', 1400);
  updateRerollHud(e);
  if (e.over) handleEngineOver();
}

// ---------------------------------------------------------------------------
// Ultimate skills: one equipped skill, fired when the gauge hits 100.
// Available wherever booster items are (PvE + chaos) — never in the fair-seed
// modes (AI / online / weekly), where only one side would have them.
// ---------------------------------------------------------------------------

const ULT_KEY = 'bba_ult';

export function equippedUlt() {
  const eq = session.user && session.user.equipped;
  const id = (eq && eq.ult) || localStorage.getItem(ULT_KEY) || DEFAULT_ULT;
  return ultExists(id) ? id : DEFAULT_ULT;
}

// Guests keep their choice locally; logged-in players use the server slot.
export function setGuestUlt(id) { localStorage.setItem(ULT_KEY, id); }

let ultTicker = null;

export function showUltBar(on) {
  const btn = $('#btnUlt');
  btn.classList.toggle('hidden', !on);
  clearInterval(ultTicker);
  ultTicker = null;
  if (!on) return;
  $('#ultIcon').textContent = ultIcon(equippedUlt());
  btn.style.setProperty('--ult-color', ultColor(equippedUlt()));
  updateUltHud();
  // Cheap poll: catches gauge changes from placements, items and timed effects
  // without threading a callback through all ten mode controllers.
  ultTicker = setInterval(updateUltHud, 120);
}

function updateUltHud() {
  const e = currentMode && currentMode.engine;
  const btn = $('#btnUlt');
  if (!e || btn.classList.contains('hidden')) return;
  // ⚡奥義祭 event: pick the charge rate up live, even mid-game. Modes can
  // stack their own bonus (rush の雷の遺物) via mode.ultRateBonus — this poll
  // must multiply it in, not clobber it.
  const ev = window.__bbaEvent;
  e.ultRate = (((ev && ev.bonus && ev.bonus.ultRate) || 1) * ((currentMode && currentMode.ultRateBonus) || 1));
  btn.classList.toggle('ult-boosted', e.ultRate > 1);
  // Admins run a permanently charged gauge.
  if (session.user && session.user.role === 'admin' && staffExtras()) e.ult = 100;
  const pct = Math.max(0, Math.min(100, Math.round(e.ult)));
  btn.style.setProperty('--ult-p', `${pct}%`);
  $('#ultPct').textContent = pct >= 100 ? 'MAX' : pct;
  btn.classList.toggle('ult-ready', pct >= 100);
  btn.classList.toggle('off', pct < 100);
}

export function fireUltCurrent() {
  const m = currentMode;
  if (!m || !m.engine || !view || view.inputLocked || m.ended) return;
  // パズル遺跡: 固定ピースの詰将棋 — 奥義は盤面契約を壊すので誰でも不可
  // (スタッフ装備の強制表示や Space/q ショートカット経由もここで止める)。
  if (m.noItems) { audio.error(); return; }
  if ($('#btnUlt').classList.contains('hidden')) return;
  const e = m.engine;
  if (e.ult < 100) {
    audio.error();
    toast(t(`⚡ ゲージが足りません（${Math.round(e.ult)}%）ラインを消して溜めよう！`,
      `⚡ Gauge not full yet (${Math.round(e.ult)}%) — clear lines to charge it!`), 'err', 1800);
    return;
  }
  const id = equippedUlt();
  const out = fireUlt(id, { engine: e, view, mode: m });
  if (out.error) {
    audio.error();
    toast(out.error, 'err', 1600);
    return;   // nothing happened — keep the gauge
  }
  e.consumeUlt();
  // Board changed: a stale game-over flag would end the run unfairly.
  if (e.over && e.hasAnyMove()) e.over = false;
  $('#btnUlt').classList.remove('ult-fire');
  void $('#btnUlt').offsetWidth;
  $('#btnUlt').classList.add('ult-fire');
  toast(out.msg, 'announce', 2600);
  updateUltHud();
  if (e.over) handleEngineOver();
}

// ---------------------------------------------------------------------------
// Booster items (consumables): usable in solo / boss / rush / dungeon / chaos.
// Logged-in inventories live on the server; guests use localStorage.
// ---------------------------------------------------------------------------

const ITEM_DEFS = {
  item_bomb:    { icon: '💣', name: 'スマートボム', nameEn: 'Smart Bomb', tip: 'スマートボム：いちばん埋まった3×3を爆破', tipEn: 'Smart Bomb: blows up the densest 3×3' },
  item_cleaner: { icon: '🧹', name: 'クリーナー', nameEn: 'Cleaner', tip: 'クリーナー：お邪魔＋最下行を掃除', tipEn: 'Cleaner: clears garbage + the bottom row' },
  item_fever:   { icon: '⭐', name: 'フィーバー', nameEn: 'Fever', tip: 'フィーバー：15秒間スコア2倍', tipEn: 'Fever: 2× score for 15 seconds' },
  item_mini:    { icon: '🧩', name: 'ミニブロック', nameEn: 'Mini Blocks', tip: 'ミニブロック：手持ちが極小ピースに変化', tipEn: 'Mini Blocks: turns your hand into tiny pieces' },
  // ---- staff only (infinite, every mode) ----
  item_god_wipe:   { icon: '💥', name: '神の一撃', nameEn: 'Divine Strike', admin: true, tip: '神の一撃：盤面消滅＋50,000点', tipEn: 'Divine Strike: wipe the board, +50,000' },
  item_god_time:   { icon: '⌛', name: '時の支配', nameEn: 'Chrono Rule', admin: true, tip: '時の支配：+120秒／敵の攻撃を60秒封印', tipEn: 'Chrono Rule: +120s / freeze enemies 60s' },
  item_god_hand:   { icon: '🎴', name: '創造の手札', nameEn: 'Creator\'s Hand', admin: true, tip: '創造の手札：最適手札＋12手は大型ピース', tipEn: 'Creator\'s Hand: perfect hand + 12 big draws' },
  item_god_mult:   { icon: '🔱', name: '神威', nameEn: 'Divine Might', admin: true, tip: '神威：30秒間スコア10倍', tipEn: 'Divine Might: 10× score for 30s' },
  item_god_shield: { icon: '🛡️', name: '絶対防御', nameEn: 'Absolute Guard', admin: true, tip: '絶対防御：60秒間 無敵・お邪魔無効・コンボ永続', tipEn: 'Absolute Guard: 60s invincible, no garbage, combo lock' },
  item_god_nuke:   { icon: '☄️', name: '天変地異', nameEn: 'Cataclysm', admin: true, tip: '天変地異：敵HPを99%削る（敵なしなら+100,000点）', tipEn: 'Cataclysm: 99% enemy HP (or +100,000)' },
};

// Build the HUD item buttons for the current player (staff see their gear).
function renderItemBar() {
  const bar = $('#itemBar');
  const admin = session.user && session.user.role === 'admin' && staffExtras();
  const ids = Object.keys(ITEM_DEFS).filter(id => !ITEM_DEFS[id].admin || admin);
  const key = ids.join(',');
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  bar.innerHTML = ids.map(id => {
    const d = ITEM_DEFS[id];
    return `<button class="chip icon-btn ${d.admin ? 'admin-item' : ''}" data-item="${id}" title="${t(d.tip, d.tipEn)}">${d.icon}<b>0</b></button>`;
  }).join('');
  bar.querySelectorAll('[data-item]').forEach(b => { b.onclick = () => useGameItem(b.dataset.item); });
}


function getItemCounts() {
  // Admins carry infinite boosters.
  if (session.user && session.user.role === 'admin') {
    const inf = {};
    for (const id of Object.keys(ITEM_DEFS)) inf[id] = Infinity;
    return inf;
  }
  if (session.user) return session.user.items || {};
  try {
    const v = JSON.parse(localStorage.getItem('bba_items'));
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  const gift = { item_bomb: 1, item_cleaner: 1, item_fever: 1, item_mini: 1 };   // guest starter gift
  localStorage.setItem('bba_items', JSON.stringify(gift));
  return gift;
}

function spendItem(id) {
  if (session.user && session.user.role === 'admin') return;   // ∞ — nothing to spend
  if (session.user) {
    session.user.items = session.user.items || {};
    session.user.items[id] = Math.max(0, (session.user.items[id] || 0) - 1);
    api('/api/items/use', { method: 'POST', body: { itemId: id } })
      .then(d => { if (d.user) session.user = d.user; updateItemBar(); })
      .catch(() => refreshMe().then(updateItemBar).catch(() => {}));
  } else {
    const c = getItemCounts();
    c[id] = Math.max(0, (c[id] || 0) - 1);
    localStorage.setItem('bba_items', JSON.stringify(c));
  }
}

// Boosters and ultimates share the same "PvE only" rule, so one switch drives
// both bars — they can never drift apart.
export function showItemBar(on) {
  // Staff see their gear in every mode (toggle in settings).
  const force = !!session.user && session.user.role === 'admin' && staffExtras();
  const show = on || force;
  renderItemBar();
  $('#itemBar').classList.toggle('hidden', !show);
  if (show) updateItemBar();
  showUltBar(show);
}

export function updateItemBar() {
  const counts = getItemCounts();
  document.querySelectorAll('#itemBar [data-item]').forEach(b => {
    const id = b.dataset.item;
    const n = counts[id] || 0;
    b.querySelector('b').textContent = n === Infinity ? '∞' : n;
    b.classList.toggle('off', n <= 0);
  });
}

export function useGameItem(id) {
  const m = currentMode;
  if (!m || !m.engine || !view || view.inputLocked || m.ended) return;
  if (m.noItems) { audio.error(); return; }   // puzzle: fixed-piece contract
  if (!ITEM_DEFS[id]) return;
  if (ITEM_DEFS[id].admin && !(session.user && session.user.role === 'admin')) return;
  const counts = getItemCounts();
  if ((counts[id] || 0) <= 0) {
    audio.error();
    toast(t('アイテムがありません。ショップやガチャで入手！', 'No items left — get more in the Shop or Gacha!'), 'err', 2200);
    return;
  }
  const e = m.engine;

  if (id === 'item_bomb') {
    // find the densest 3x3 window and blow it up
    let best = null, bestCount = 0;
    for (let r = 0; r <= 5; r++) for (let c = 0; c <= 5; c++) {
      let n = 0;
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        if (e.grid[(r + dr) * 8 + c + dc]) n++;
      }
      if (n > bestCount) { bestCount = n; best = [r, c]; }
    }
    if (!bestCount) { audio.error(); toast(t('盤面が空です！', 'The board is empty!'), 'err', 1500); return; }
    const [br, bc] = best;
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = br + dr, c = bc + dc;
      if (e.grid[r * 8 + c]) {
        e.grid[r * 8 + c] = 0;
        view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 14, 'fx_default');
      }
    }
    audio.bossAttack();
    view.shake = 14;
    toast(t('💣 ドカーン！', '💣 KABOOM!'), 'ok', 1400);
  } else if (id === 'item_cleaner') {
    let n = 0;
    for (let i = 0; i < 64; i++) if (e.grid[i] === 9) { e.grid[i] = 0; n++; }
    for (let c = 0; c < 8; c++) { const k = 7 * 8 + c; if (e.grid[k]) { e.grid[k] = 0; n++; } }
    if (n === 0) { audio.error(); toast(t('掃除するものがありません！', 'Nothing to clean up!'), 'err', 1500); return; }
    view.reviveFlash();
    audio.coin();
    toast(t(`🧹 ${n}マスを掃除しました！`, `🧹 Cleaned up ${n} cells!`), 'ok', 1500);
  } else if (id === 'item_fever') {
    e.feverUntil = Date.now() + 15000;
    e.feverMult = 2;
    view.screenFlash = 0.35;
    $('#hudScore').classList.add('fever');
    audio.combo(6);
    toast(t('⭐ フィーバー！15秒間スコア2倍！！', '⭐ FEVER! 2x score for 15 seconds!!'), 'announce', 2400);
    setTimeout(() => {
      $('#hudScore').classList.remove('fever');
      if (currentMode === m && !m.ended) toast(t('フィーバー終了', 'Fever over'), '', 1200);
    }, 15000);
  } else if (id === 'item_mini') {
    // swap the whole hand for tiny 1-3 cell pieces (escape hatch!)
    const prevMini = e.chaosMini;
    e.chaosMini = true;
    e.hand = [e.drawPiece(), e.drawPiece(), e.drawPiece()];
    e.chaosMini = prevMini;
    view.reviveFlash();
    audio.coin();
    toast(t('🧩 手持ちがミニピースに変化した！', '🧩 Your hand turned into mini pieces!'), 'ok', 1800);
  } else if (id === 'item_god_wipe') {
    const filled = [];
    for (let i = 0; i < 64; i++) if (e.grid[i]) { filled.push(i); e.grid[i] = 0; }
    for (const i of filled) view.particles.burstCell(view.boardX + ((i % 8) + 0.5) * view.cell, view.boardY + (Math.floor(i / 8) + 0.5) * view.cell, view.cell, 14, 'fx_default');
    const gained = Math.round(50000 * (e.scoreMult || 1) * (e.feverUntil > Date.now() ? (e.feverMult || 2) : 1));
    e.score += gained;
    if (m.onPlace) m.onPlace({ placedCells: [[0, 0]], color: 1, fullRows: [], fullCols: [], clearedCells: [], lineCount: 0, gained, streak: e.streak, over: false });
    view.shake = 22; view.screenFlash = 0.7; audio.bossDefeated();
    toast(t(`💥 神の一撃！ +${fmt(gained)}`, `💥 Divine Strike! +${fmt(gained)}`), 'announce', 2000);
  } else if (id === 'item_god_time') {
    if (m.endAt !== undefined && m.timerInt) { m.endAt += 120000; m.timeLeft += 120; if (m.updateTimerHud) m.updateTimerHud(); }
    if (m.nextAtk) m.nextAtk += 60000;
    if (m.nextAt) m.nextAt += 60000;
    if (m.endAt === undefined && !m.nextAtk && !m.nextAt) e.rerolls += 10;
    view.screenFlash = 0.4; audio.combo(7);
    toast(t('⌛ 時の支配！時間+120秒／敵を60秒封印', '⌛ Chrono Rule! +120s / enemies frozen 60s'), 'announce', 2000);
  } else if (id === 'item_god_hand') {
    const out = fireUlt('ult_rainbow', { engine: e, view, mode: m });
    e.godDraws = 12;
    if (out.error) toast(out.error, 'err', 1500);
    else toast(t('🎴 創造の手札！次の12手は大型ピース', '🎴 Creator\'s Hand! 12 big draws incoming'), 'announce', 2000);
  } else if (id === 'item_god_mult') {
    e.feverUntil = Date.now() + 30000;
    e.feverMult = 10;
    $('#hudScore').classList.add('fever');
    view.screenFlash = 0.5; audio.combo(9);
    toast(t('🔱 神威！30秒間スコア10倍！！', '🔱 Divine Might! 10× score for 30s!!'), 'announce', 2400);
    setTimeout(() => { if (e.feverMult === 10) { e.feverMult = 2; $('#hudScore').classList.remove('fever'); } }, 30000);
  } else if (id === 'item_god_shield') {
    view.godInvincibleUntil = Date.now() + 60000;
    e.fortressUntil = Math.max(e.fortressUntil || 0, Date.now() + 60000);
    e.streakShield = true;
    view.reviveFlash(); view.screenFlash = 0.4; audio.combo(6);
    toast(t('🛡️ 絶対防御！60秒間 無敵・お邪魔無効・コンボ永続', '🛡️ Absolute Guard! 60s invincible, no garbage, combo lock'), 'announce', 2400);
  } else if (id === 'item_god_nuke') {
    if (typeof m.hp === 'number' && (m.mode === 'boss' || m.mode === 'dungeon' || m.raidBoss)) {
      const dmg = Math.max(0, m.hp - Math.ceil(m.hp * 0.01));
      m.hp -= dmg;
      e.score += dmg;
      if (m.updateHpBar) m.updateHpBar();
      if (m.updateRaidHp) m.updateRaidHp();
      if (m.damageFloat) m.damageFloat(dmg, true);
      view.shake = 24; view.screenFlash = 0.8; audio.bossAttack();
      toast(t(`☄️ 天変地異！ -${fmt(dmg)}`, `☄️ Cataclysm! -${fmt(dmg)}`), 'announce', 2000);
    } else {
      e.score += 100000;
      if (m.updateHud) m.updateHud(); else if (m.updateMyHud) m.updateMyHud(e);
      view.shake = 24; view.screenFlash = 0.8; audio.bossDefeated();
      toast(t('☄️ 天変地異！ +100,000', '☄️ Cataclysm! +100,000'), 'announce', 2000);
    }
  }

  // survivors of a bomb/clean: board changed, over-state may be stale
  if (e.over && e.hasAnyMove()) e.over = false;
  e.itemUses = (e.itemUses || 0) + 1;
  spendItem(id);
  updateItemBar();
}

// ---------------------------------------------------------------------------
// Autopilot 5.0 (admin only): the strongest AI plays your board, any mode.
// The ♾️不滅 (immortal) brain plans for survival, and the 🚑 guard layer pulls
// dead boards back to life before the game-over pipeline ever sees them.
// ---------------------------------------------------------------------------

export const autopilot = {
  on: false, speed: 1, timer: null,
  brain: 'immortal', style: 'normal', guard: true, lastPlan: null,
  autoItems: true, autoUlt: true, autoContinue: false, autoPerks: true, targetScore: 0,
  stats: { moves: 0, clears: 0, rescues: 0, thinkMs: 0, started: 0 },
};

function isAdmin() { return !!session.user && session.user.role === 'admin'; }

export function getCurrentMode() { return currentMode; }
export function getViewRef() { return view; }

function updateAutoBtn() {
  const btn = $('#btnAuto');
  const show = staffExtras();
  btn.classList.toggle('hidden', !show);
  $('#autoState').textContent = autopilot.on ? `x${autopilot.speed}` : 'OFF';
  btn.classList.toggle('auto-on', autopilot.on);
  $('#btnAdminCmd').classList.toggle('hidden', !show);
}

// Kept for older callers: tap cycles on → faster → off.
export function toggleAutopilot() {
  if (!isAdmin()) return;
  audio.click();
  if (!autopilot.on) {
    autopilot.on = true;
    toast(t('🤖 オートパイロット起動（長押しで設定）', '🤖 Autopilot on (hold for settings)'), 'ok', 2000);
  } else if (autopilot.speed < 32) {
    autopilot.speed *= 2;
    toast(`🤖 x${autopilot.speed}`, '', 1000);
  } else {
    stopAutopilot();
    return;
  }
  updateAutoBtn();
  runAutopilot();
}

// Autopilot fires boosters like a pro: cleaner for garbage floods, bomb for
// clogged boards, fever whenever the board is open enough to combo. In an
// emergency (5.0): cooldowns collapse and items become life support.
function autoUseItems(m) {
  const e = m.engine;
  const plan = autopilot.lastPlan;
  const emergency = plan && (plan.stranded > 0 || plan.missingW > 0.25);
  if (Date.now() - (autopilot.itemAt || 0) < (emergency ? 600 : 2500)) return;
  if ($('#itemBar').classList.contains('hidden')) return;
  // Ultimates first: a charged gauge is always the strongest button available.
  if (autopilot.autoUlt !== false && e.ult >= 100
    && Date.now() - (autopilot.ultAt || 0) > (emergency ? 900 : 3000)) {
    autopilot.itemAt = autopilot.ultAt = Date.now();
    fireUltCurrent();
    return;
  }
  if (autopilot.autoItems === false) return;
  const counts = getItemCounts();
  const filled = e.grid.reduce((a, x) => a + (x ? 1 : 0), 0);
  const garbage = e.grid.reduce((a, x) => a + (x === 9 ? 1 : 0), 0);
  if (emergency) {
    if (garbage >= 3 && (counts.item_cleaner || 0) > 0) {
      autopilot.itemAt = Date.now();
      useGameItem('item_cleaner');
      return;
    }
    if (filled >= 20 && (counts.item_bomb || 0) > 0) {
      autopilot.itemAt = Date.now();
      useGameItem('item_bomb');
      return;
    }
    if (plan.stranded > 0 && (counts.item_mini || 0) > 0) {
      autopilot.itemAt = Date.now();
      useGameItem('item_mini');
      return;
    }
  }
  if (garbage >= 8 && (counts.item_cleaner || 0) > 0) {
    autopilot.itemAt = Date.now();
    useGameItem('item_cleaner');
  } else if (filled >= 44 && (counts.item_bomb || 0) > 0) {
    autopilot.itemAt = Date.now();
    useGameItem('item_bomb');
  } else if ((counts.item_fever || 0) > 0 && !(e.feverUntil > Date.now())
    && filled < 30 && Date.now() - (autopilot.feverAt || 0) > 20000) {
    autopilot.itemAt = autopilot.feverAt = Date.now();
    useGameItem('item_fever');
  }
}

// ---------------------------------------------------------------------------
// 🚑 Auto-rescue (autopilot 5.0): called from every game-over entry point in
// the local PvE modes. When the board dies it redraws / detonates its way back
// to a playable state BEFORE the finish pipeline runs. Fair-seed and
// server-authoritative modes (AI / online / weekly / co-op / intent) never
// qualify — the whitelist below is deliberate.
// ---------------------------------------------------------------------------

const RESCUE_MODES = new Set(['solo', 'boss', 'dungeon', 'chaos', 'survival', 'sprint', 'dig']);
let rescueBusy = false;

function autoRescue() {
  if (!autopilot.on || autopilot.guard === false || rescueBusy) return false;
  const m = currentMode;
  if (!m || !m.engine || m.ended || !view) return false;
  if (m.usesIntent || m.isCoop || !RESCUE_MODES.has(m.mode)) return false;
  const e = m.engine;
  const alive = () => {
    if (e.over && e.hasAnyMove()) e.over = false;
    return !e.over;
  };
  if (alive()) return true;   // stale flag — nothing to do
  rescueBusy = true;
  try {
    // 1) Redraw the hand. engine.reroll() refuses on a dead board by design,
    //    so the guard lifts the flag first — this is a staff tool, and exactly
    //    the moment infinite rerolls exist for.
    const redraw = tries => {
      while (!alive() && tries-- > 0) {
        e.over = false;
        if (!e.reroll()) { e.over = !e.hasAnyMove(); break; }
      }
    };
    redraw(e.infiniteReroll ? 16 : Math.max(0, e.rerolls));
    // 2) Open the board with items, then redraw once more.
    if (!alive() && !$('#itemBar').classList.contains('hidden')) {
      const counts = getItemCounts();
      for (const id of ['item_bomb', 'item_mini', 'item_cleaner']) {
        if (alive()) break;
        if ((counts[id] || 0) > 0) useGameItem(id);
      }
      redraw(e.infiniteReroll ? 8 : Math.max(0, e.rerolls));
    }
    if (!alive()) return false;
    autopilot.stats.rescues = (autopilot.stats.rescues || 0) + 1;
    updateRerollHud(e);
    if (view.reviveFlash) view.reviveFlash();
    toast(t('🚑 オートレスキュー！', '🚑 Auto-rescue!'), 'ok', 1200);
    return true;
  } finally {
    rescueBusy = false;
  }
}

// Try a move on a scratch engine; returns { lineCount, filled, mobility }.
function simMove(engine, index, row, col) {
  const s = new Engine(1);
  s.grid = engine.grid.slice();
  s.hand = engine.hand.map(p => (p ? { ...p } : null));
  s.streakShield = true;
  const r = s.place(index, row, col);
  if (!r) return null;
  const filled = s.grid.reduce((a, x) => a + (x ? 1 : 0), 0);
  let mobility = 0;
  for (const p of s.hand) if (p) mobility += s.placements(p).length;
  return { lineCount: r.lineCount, filled, mobility };
}

// Style layer on top of the brain: bias the chosen move toward the goal.
function pickAutoMove(engine) {
  const brain = autopilot.brain || 'immortal';
  if (brain === 'immortal') {
    // 5.0 brain: styles are weights inside the search, not an override on top.
    const plan = planImmortalMove(engine, autopilot.style || 'normal');
    autopilot.lastPlan = plan;
    autopilot.stats.thinkMs = Math.round(plan.ms * 10) / 10;
    return plan.move;
  }
  autopilot.lastPlan = null;
  const base = chooseMove(engine, brain);
  const style = autopilot.style || 'normal';
  if (style === 'normal' || !base) return base;
  let best = base, bestScore = -Infinity;
  for (let i = 0; i < engine.hand.length; i++) {
    const p = engine.hand[i];
    if (!p) continue;
    for (const [r, c] of engine.placements(p)) {
      const sim = simMove(engine, i, r, c);
      if (!sim) continue;
      const score = style === 'clear' ? -sim.filled * 10 + sim.lineCount * 5
        : style === 'combo' ? sim.lineCount * 1000 + sim.mobility
        : /* safe */ sim.mobility * 10 - sim.filled + sim.lineCount * 50;
      if (score > bestScore) { bestScore = score; best = { index: i, row: r, col: c }; }
    }
  }
  // Never let a style pick a move the brain thinks is a blunder when a clear
  // was available: combo/clear styles only override on a real gain.
  if (style === 'combo') {
    const b = simMove(engine, base.index, base.row, base.col);
    const s = simMove(engine, best.index, best.row, best.col);
    if (b && s && s.lineCount <= b.lineCount) return base;
  }
  return best;
}

export function runAutopilot() {
  clearTimeout(autopilot.timer);
  if (!autopilot.on) return;
  if (!autopilot.stats.started) autopilot.stats.started = Date.now();
  autopilot.timer = setTimeout(() => {
    const m = currentMode;
    if (m && m.engine && view && view.running && !view.inputLocked && !m.engine.over && !m.ended) {
      if (autopilot.targetScore && m.engine.score >= autopilot.targetScore) {
        stopAutopilot();
        toast(t(`🤖 目標スコア ${fmt(autopilot.targetScore)} に到達したので停止`, `🤖 Target score ${fmt(autopilot.targetScore)} reached — stopped`), 'ok', 2600);
        return;
      }
      autoUseItems(m);
      const mv = pickAutoMove(m.engine);
      const plan = autopilot.lastPlan;
      if (plan && plan.stranded > 0 && (m.engine.infiniteReroll || m.engine.rerolls > 0)
        && !m.usesIntent && !m.isCoop) {
        // 5.0: the search proved no order places this hand. Redraw NOW —
        // placing first can flip `over`, and a dead board refuses rerolls.
        m.engine.reroll();
        updateRerollHud(m.engine);
        if (m.engine.over) handleEngineOver();
      } else if (mv) {
        if ((m.isCoop || m.usesIntent) && view.onIntentPlace) {
          view.onIntentPlace(mv.index, mv.row, mv.col);   // mode-authoritative placement
        } else {
          const r = m.engine.place(mv.index, mv.row, mv.col);
          if (r) {
            // 5.0 guard: pull a dead refill back to life before the game-over
            // pipeline (applyResult → onGameOver) ever sees it.
            if (r.over && autoRescue()) r.over = false;
            view.applyResult(r);
            autopilot.stats.moves++; autopilot.stats.clears += r.lineCount;
          }
        }
      } else if (m.engine.rerolls > 0 || m.engine.infiniteReroll) {
        m.engine.reroll();
        updateRerollHud(m.engine);
        if (m.engine.over) handleEngineOver();
      }
    } else if (autopilot.autoContinue && m && m.ended) {
      // Keep going: "play again" / "next floor" / "revenge" on the result modal.
      const again = document.querySelector('#modal-root #rAgain');
      if (again) again.click();
    }
    runAutopilot();
  }, autopilot.speed >= 32 ? 15 : 700 / autopilot.speed);
}

export function stopAutopilot() {
  autopilot.on = false;
  autopilot.speed = 1;
  autopilot.lastPlan = null;
  autopilot.stats = { moves: 0, clears: 0, rescues: 0, thinkMs: 0, started: 0 };
  clearTimeout(autopilot.timer);
  updateAutoBtn();
}

// ---------------------------------------------------------------------------
// Solo (endless)
// ---------------------------------------------------------------------------

class SoloMode {
  constructor() { this.mode = 'solo'; }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('solo');
  }

  best() {
    return session.user ? Math.max(session.user.stats.bestScore, guestBest()) : guestBest();
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `BEST ${fmt(Math.max(this.best(), this.engine.score))}`;
  }

  onPlace() { this.updateHud(); }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    if (e.score > guestBest()) setGuestBest(e.score);
    const rewards = await submitResult({
      mode: 'solo', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    const isBest = e.score >= this.best();
    if (isBest && e.score > 0) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() { this.finish(); }
  destroy() {}
}

// ---------------------------------------------------------------------------
// ☢️ メルトダウン: ライン消しで炉心温度＝スコア倍率が上がり、100%で爆発。
// 盤面に湧く冷却セル(❄️)を含むラインを消すと熱が下がる — 稼ぐペダルと
// ブレーキが同じペダル。臨界(90%+)で置くと倍率さらに1.5倍。
// ---------------------------------------------------------------------------

class MeltdownMode {
  constructor() {
    this.mode = 'meltdown';
    this.usesIntent = true;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.remove('hidden');   // 熱ゲージとして流用
    showItemBar(false);   // 純スコアタ — アイテム/奥義なし
    this.startedAt = Date.now();
    this.ended = false;
    this.heat = 0;
    this.maxHeat = 0;
    this.placedSince = 0;
    this.coolCells = new Set();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.coolCells = this.coolCells;
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('oni');
    this.alarmInt = setInterval(() => this.alarmTick(), 600);
    toast(t('☢️ 消すほど熱く、熱いほど稼げる。100%で爆発！❄️で冷やせ！', '☢️ Clears heat the core — heat multiplies your score. 100% = boom! Cool it with ❄️!'), 'announce', 3200);
  }

  mult() {
    const base = 1 + this.heat / 10;
    return Math.round(base * (this.heat >= 90 ? 1.5 : 1) * 10) / 10;
  }

  // 神モードの盤面リセットやスタッフアイテムはグリッドを直接書き換える —
  // Set がグリッドとズレたら幻の❄️や不正な冷却になるので、毎手同期する。
  pruneCool() {
    const e = this.engine;
    for (const k of [...this.coolCells]) if (e.grid[k] !== 6) this.coolCells.delete(k);
  }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    this.pruneCool();
    const v = getView();
    const save = e.scoreMult;
    e.scoreMult = save * this.mult();
    const result = e.place(index, row, col);
    e.scoreMult = save;
    if (!result) return true;
    let cooled = 0;
    if (result.lineCount) {
      for (const [r, c] of result.clearedCells) {
        const k = r * 8 + c;
        if (this.coolCells.has(k)) { this.coolCells.delete(k); cooled++; }
      }
      this.heat = Math.max(0, Math.min(100, this.heat + 4 + 5 * result.lineCount - cooled * 35));
    }
    v.applyResult(result);
    if (cooled) {
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.3, `❄️ -${cooled * 35}%`, '#4dd0ff', 1.6);
      audio.coin();
    }
    this.maxHeat = Math.max(this.maxHeat, this.heat);
    this.placedSince++;
    if (this.placedSince >= 3) { this.placedSince = 0; this.spawnCool(); }
    this.updateHud();
    if (this.ended) return true;
    if (this.heat >= 100) this.meltdown();
    return true;
  }

  // 3手ごとに冷却セルが湧く。置き場を奪って窒息させたら本末転倒なので、
  // 湧いた結果ノーモーブになるときは取り消す。
  spawnCool() {
    const e = this.engine;
    const empty = [];
    for (let k = 0; k < 64; k++) if (!e.grid[k]) empty.push(k);
    if (empty.length < 6) return;
    const k = empty[(Math.random() * empty.length) | 0];
    e.grid[k] = 6;
    if (!e.hasAnyMove()) { e.grid[k] = 0; return; }
    this.coolCells.add(k);
    const v = getView();
    v.spawnAnim.set(k, v.time);
  }

  alarmTick() {
    if (this.ended) return;
    const v = getView();
    if (this.heat >= 85) v.screenFlash = Math.max(v.screenFlash, 0.1);
    if (this.heat >= 95) audio.countdown(false);
  }

  meltdown() {
    const v = getView();
    v.screenFlash = 0.8;
    v.shake = 22;
    audio.bossAttack();
    confettiBurst(60);
    toast(t('☢️ 炉心爆発！！', '☢️ CORE MELTDOWN!!'), 'err', 2500);
    this.finish(true);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `×${this.mult().toFixed(1)} ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`;
    const timer = $('#hudTimer');
    timer.textContent = `🔥${Math.round(this.heat)}%`;
    timer.classList.toggle('urgent', this.heat >= 85);
    const fill = $('#chaosBarFill');
    fill.style.width = `${Math.round(this.heat)}%`;
    fill.style.background = this.heat < 50 ? '#43d9e8' : this.heat < 85 ? '#ffa93d' : '#ff3b3b';
  }

  best() {
    const local = Number(localStorage.getItem('bba_meltdown_best') || 0);
    return session.user ? Math.max(local, session.user.stats.meltdownBest || 0) : local;
  }

  async finish(exploded = false) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.alarmInt);
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_meltdown_best') || 0);
    const isBest = e.score > 0 && e.score >= Math.max(localBest, this.best());
    if (e.score > localBest) localStorage.setItem('bba_meltdown_best', String(e.score));
    const rewards = await submitResult({
      mode: 'meltdown', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : exploded ? 'lose' : 'draw'}">${isBest ? 'NEW RECORD!' : exploded ? t('☢️ 炉心爆発…', '☢️ MELTDOWN…') : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('🔥 最高熱', '🔥 Peak heat')}</span><b>${Math.round(this.maxHeat)}%</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() { this.finish(false); }

  destroy() {
    this.ended = true;
    clearInterval(this.alarmInt);
    const timer = $('#hudTimer');
    timer.classList.add('hidden');
    timer.classList.remove('urgent');
    $('#chaosBar').classList.add('hidden');
    const fill = $('#chaosBarFill');
    fill.style.background = '';
    fill.style.width = '0%';
    if (view) { view.onIntentPlace = null; view.coolCells = null; }
  }
}

// ---------------------------------------------------------------------------
// 🧬 キメラ工房: 手札のピースをドラッグで溶接して怪物ピースを錬成。
// 合体数がそのままスコア倍率（2体=×2、3体=×3）。手札は全部置くまで
// 補充されないので、合体は常に窒息リスクとの取引になる。
// ---------------------------------------------------------------------------

function chimeraMerge(aCells, bCells, how) {
  const { rows: ar, cols: ac } = shapeSize(aCells);
  const off = how === 'side' ? [0, ac] : how === 'down' ? [ar, 0] : [ar, ac];
  const merged = [
    ...aCells.map(([r, c]) => [r, c]),
    ...bCells.map(([r, c]) => [r + off[0], c + off[1]]),
  ];
  const { rows, cols } = shapeSize(merged);
  if (rows > 8 || cols > 8) return null;
  return merged;
}

function chimeraCellsHtml(cells) {
  const { rows, cols } = shapeSize(cells);
  const on = new Set(cells.map(([r, c]) => r * cols + c));
  let inner = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) inner += `<i class="${on.has(r * cols + c) ? 'on' : ''}"></i>`;
  }
  return `<span class="deck-piece" style="grid-template-columns:repeat(${cols},9px)">${inner}</span>`;
}

class ChimeraMode {
  constructor() {
    this.mode = 'chimera';
    this.usesIntent = true;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    showItemBar(false);   // ミニブロック等は錬成した手札を壊してしまう
    this.startedAt = Date.now();
    this.ended = false;
    this.welds = 0;
    this.maxWeld = 1;
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onTrayDrop = (from, to) => this.tryWeld(from, to);
    v.onPlace = null;
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('solo');
    toast(t('🧬 ピースをピースにドラッグで溶接！大きいほど高倍率！', '🧬 Drag a piece onto another to weld them — bigger means bigger multipliers!'), 'announce', 3200);
  }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    const v = getView();
    const weld = piece.weld || 1;
    const save = e.scoreMult;
    e.scoreMult = save * weld;
    const result = e.place(index, row, col);
    e.scoreMult = save;
    if (!result) return true;
    v.applyResult(result);
    if (weld > 1 && result.lineCount) {
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.3, t(`🧬 キメラ ×${weld}！`, `🧬 CHIMERA ×${weld}!`), '#b06bff', 1.8);
      audio.combo(6 + weld);
    }
    this.updateHud();
    return true;
  }

  // ピースをピースに落とすと溶接候補（横/縦/斜め）を提示。
  tryWeld(from, to) {
    const e = this.engine;
    const base = e.hand[to];
    const add = e.hand[from];
    if (!base || !add || from === to || this.ended) return false;
    const opts = [
      ['side', t('→ 横に接合', '→ weld right')],
      ['down', t('↓ 縦に接合', '↓ weld below')],
      ['diag', t('↘ 斜めに接合', '↘ weld diagonal')],
    ].map(([how, label]) => ({ how, label, cells: chimeraMerge(base.cells, add.cells, how) }))
      .filter(o => o.cells);
    if (!opts.length) {
      toast(t('🧬 大きすぎて溶接できない！', '🧬 Too big to weld!'), 'err', 1500);
      return true;
    }
    const v = getView();
    v.inputLocked = true;
    const m = showModal(`
      <h2>🧬 ${t('溶接する？', 'Weld them?')}</h2>
      <div class="form-col">
        ${opts.map((o, i) => `
          <button class="btn btn-ghost perk-btn" data-perk="${i}">
            <span class="perk-icon">🧬</span>
            <span class="perk-body"><b>${o.label} ${chimeraCellsHtml(o.cells)}</b><small>${t(`${o.cells.length}マスの怪物ピース ・ 倍率×${(base.weld || 1) + (add.weld || 1)}`, `${o.cells.length}-cell monster ・ ×${(base.weld || 1) + (add.weld || 1)} multiplier`)}</small></span>
          </button>`).join('')}
      </div>
      <div class="modal-buttons"><button class="btn btn-ghost" id="wldCancel">${t('やめる', 'Cancel')}</button></div>`,
      { dismissable: false });
    const done = () => { v.inputLocked = false; closeModal(); };
    m.querySelector('#wldCancel').onclick = () => { audio.click(); done(); };
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => {
        const o = opts[Number(b.dataset.perk)];
        const weld = (base.weld || 1) + (add.weld || 1);
        e.hand[to] = { shape: -1, cells: o.cells, color: base.color, weld };
        e.hand[from] = null;
        this.welds++;
        this.maxWeld = Math.max(this.maxWeld, weld);
        audio.levelUp();
        done();
        // 巨大ピースで詰んだ扱いにしない — 置けるかは手札次第で判定し直す
        if (!e.hasAnyMove()) { e.over = true; this.finish(); }
        else e.over = false;
        this.updateHud();
      };
    });
    return true;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = t(`🧬 合体${this.welds}回 ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`, `🧬 ${this.welds} welds ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`);
  }

  best() {
    const local = Number(localStorage.getItem('bba_chimera_best') || 0);
    return session.user ? Math.max(local, session.user.stats.chimeraBest || 0) : local;
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_chimera_best') || 0);
    const isBest = e.score > 0 && e.score >= Math.max(localBest, this.best());
    if (e.score > localBest) localStorage.setItem('bba_chimera_best', String(e.score));
    const rewards = await submitResult({
      mode: 'chimera', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('🧬 溶接回数', '🧬 Welds')}</span><b>${fmt(this.welds)}</b></div>
        <div class="rs-row"><span>${t('🧬 最大キメラ', '🧬 Biggest chimera')}</span><b>×${fmt(this.maxWeld)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() { this.finish(); }

  destroy() {
    this.ended = true;
    if (view) { view.onIntentPlace = null; view.onTrayDrop = null; }
  }
}

// ---------------------------------------------------------------------------
// 🧩 パズル遺跡 (v2.6) — stage-based puzzle rooms. Each stage is built by
// REVERSE CONSTRUCTION: fill a band of rows (or columns), then carve whole
// pieces out of it. The player gets exactly those carved pieces, so placing
// each piece back in its home completes every line — a solution always
// exists. Win = every ORIGINAL cell cleared (leftover player cells are fine;
// this is what keeps mid-solve line clears from ever dead-locking a stage).
// ---------------------------------------------------------------------------

function puzzleStars() {
  try { return JSON.parse(localStorage.getItem('bba_puzzle_stars') || '{}'); } catch { return {}; }
}
export function puzzleBestStage() {
  const local = Number(localStorage.getItem('bba_puzzle_stage') || 0);
  return session.user ? Math.max(local, session.user.stats.puzzleStage || 0) : local;
}

// Deterministic stage layout — every player gets the same ruins.
function genPuzzleStage(stage) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = new Rng(((stage * 2654435761) ^ (attempt * 40503) ^ 0x9e3779) >>> 0);
    const vertical = rng.next() < 0.5;
    const band = Math.min(5, 2 + Math.floor((stage - 1) / 8));      // 2..5 lines
    const p0 = rng.int(8 - band + 1);
    const wantPieces = Math.min(10, 3 + Math.floor((stage - 1) / 4)); // 3..10 pieces
    const grid = new Array(64).fill(0);
    const inBand = (r, c) => vertical ? (c >= p0 && c < p0 + band) : (r >= p0 && r < p0 + band);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (inBand(r, c)) grid[r * 8 + c] = 1 + ((vertical ? c : r) % 8);
    }
    const pieces = [];
    let guard = 260;
    while (pieces.length < wantPieces && guard-- > 0) {
      const si = rng.int(SHAPES.length);
      const cells = SHAPES[si].cells;
      const { rows, cols } = shapeSize(cells);
      const r0 = rng.int(Math.max(1, 8 - rows + 1));
      const c0 = rng.int(Math.max(1, 8 - cols + 1));
      let ok = true;
      for (const [dr, dc] of cells) {
        const r = r0 + dr, c = c0 + dc;
        if (r >= 8 || c >= 8 || !inBand(r, c) || grid[r * 8 + c] === 0) { ok = false; break; }
      }
      if (!ok) continue;
      for (const [dr, dc] of cells) grid[(r0 + dr) * 8 + (c0 + dc)] = 0;
      pieces.push({ shape: si, cells, color: SHAPES[si].color });
    }
    if (pieces.length < 2) continue;   // degenerate carve — reroll deterministically
    // A fully-carved line would clear as soon as an unrelated line completes
    // nothing — more importantly it has no originals, which is fine. But a
    // band line with only 1-2 originals left is a nice puzzle; no extra work.
    for (let i = pieces.length - 1; i > 0; i--) {   // deterministic shuffle
      const k = rng.int(i + 1);
      [pieces[i], pieces[k]] = [pieces[k], pieces[i]];
    }
    const targets = new Set();
    for (let k = 0; k < 64; k++) if (grid[k] !== 0) targets.add(k);
    return { grid, pieces, targets, band, vertical };
  }
  // Unreachable in practice; a 1-piece fallback stage keeps the mode alive.
  const grid = new Array(64).fill(0);
  for (let c = 0; c < 7; c++) grid[7 * 8 + c] = 1 + (c % 8);
  return { grid, pieces: [{ shape: 0, cells: SHAPES[0].cells, color: SHAPES[0].color }], targets: new Set([56, 57, 58, 59, 60, 61, 62]), band: 1, vertical: false };
}

class PuzzleMode {
  constructor(stage = 1) {
    this.mode = 'puzzle';
    this.usesIntent = true;
    this.noItems = true;   // fixed queue — items/ults would break solvability
    this.stage = Math.max(1, Math.floor(stage));
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.add('hidden');
    showItemBar(false);   // 固定ピースのパズル — アイテム/奥義は無効
    $('#btnReroll').classList.add('hidden');   // リロールも遺跡では禁止
    this.startedAt = Date.now();
    this.ended = false;
    const st = genPuzzleStage(this.stage);
    this.targets = st.targets;
    this.queue = st.pieces.slice();
    this.total = st.pieces.length;
    const v = getView();
    this.engine = new Engine();
    this.engine.grid = st.grid.slice();
    this.engine.rerolls = 0;
    this.engine.refillHand = () => {};        // the queue is the only source
    this.engine.reroll = () => false;
    this.engine.hand = [this.queue.shift() || null, this.queue.shift() || null, this.queue.shift() || null];
    v.setEngine(this.engine);
    v.glowCells = this.targets;               // originals shimmer = what to clear
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateAutoBtn();
    v.start();
    audio.playTrack('ruins');
    toast(t(`🧩 ステージ${this.stage}：光るブロックをすべて消そう！ピースは使い切り！`,
      `🧩 Stage ${this.stage}: clear every glowing block — no piece refills!`), 'announce', 3200);
  }

  remaining() { return this.queue.length + this.engine.hand.filter(Boolean).length; }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    const result = e.place(index, row, col);
    if (!result) return true;
    e.hand[index] = this.queue.shift() || null;   // fixed queue, no random refills
    for (const [r, c] of result.clearedCells) this.targets.delete(r * 8 + c);
    // place() judged "no moves" against the pre-refill hand — re-judge after
    // the queue refill so applyResult doesn't fire a phantom game over.
    e.over = false;
    result.over = false;
    getView().applyResult(result);
    this.updateHud();
    if (this.ended) return true;
    if (this.targets.size === 0) { this.finish(true); return true; }
    if (!e.hasAnyMove()) {
      e.over = true;
      this.finish(false);
    }
    return true;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    $('#hudSub').textContent = t(`ステージ${this.stage} ・ 残り${this.targets.size}マス`, `Stage ${this.stage} — ${this.targets.size} left`);
    $('#hudTimer').textContent = `🧩${this.remaining()}`;
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const secs = (Date.now() - this.startedAt) / 1000;
    const stars = won ? (secs <= 45 ? 3 : secs <= 90 ? 2 : 1) : 0;
    let firstClear = false;
    if (won) {
      const all = puzzleStars();
      if ((all[this.stage] || 0) < stars) { all[this.stage] = stars; localStorage.setItem('bba_puzzle_stars', JSON.stringify(all)); }
      const localBest = Number(localStorage.getItem('bba_puzzle_stage') || 0);
      firstClear = this.stage > localBest;
      if (firstClear) localStorage.setItem('bba_puzzle_stage', String(this.stage));
      confettiBurst(stars >= 3 ? 60 : 30);
      audio.victory();
    }
    const rewards = await submitResult({
      mode: 'puzzle', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      duration: secs, won, stage: this.stage,
    });
    const starStr = won ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '';
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : 'lose'}">${won ? `${t('遺跡クリア！', 'ROOM CLEARED!')} ${starStr}` : t('❌ 失敗…', '❌ FAILED…')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('ステージ', 'Stage')}</span><b>${this.stage}</b></div>
        <div class="rs-row"><span>${t('タイム', 'Time')}</span><b>${secs.toFixed(1)}s</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t('残りブロック', 'Blocks left')}</span><b>${this.targets.size}</b></div>`}
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${won ? t('▶ 次のステージ', '▶ Next stage') : t('リトライ', 'Retry')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      this.destroy();
      startPuzzle(won ? this.stage + 1 : this.stage);
    };
  }

  quit() { this.finish(false); }

  destroy() {
    this.ended = true;
    $('#hudTimer').classList.add('hidden');
    if (view) { view.onIntentPlace = null; view.glowCells = null; }
  }
}

export function startPuzzle(stage = 1) {
  if (currentMode) currentMode.destroy();
  currentMode = new PuzzleMode(stage);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// ⛏️ 採掘場 (v2.6) — the ground rises. Every few placements the whole board
// shifts up one row and a fresh rock layer (with ore) slides in at the bottom.
// Clear lines through the rock to collect 🪙金鉱石 / 💠クリスタル / 🌈虹鉱石
// for score. Anything touching the ceiling when the ground moves = crushed.
// ---------------------------------------------------------------------------

const DIG_ORES = {
  gold:    { icon: '🪙', tint: '#ffd75e', base: 150 },
  crystal: { icon: '💠', tint: '#4dd0ff', base: 400 },
  rainbow: { icon: '🌈', tint: '#ff6bd4', base: 1200 },
};
const DIG_STEP = 4;   // placements per layer rise

class DigMode {
  constructor() {
    this.mode = 'dig';
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.remove('hidden');   // 地層の上昇ゲージとして流用
    showItemBar(false);
    this.startedAt = Date.now();
    this.ended = false;
    this.depth = 0;
    this.placedSince = 0;
    this.ores = new Map();
    this.mined = { gold: 0, crystal: 0, rainbow: 0 };
    this.rng = new Rng((Math.random() * 2 ** 31) | 0);
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.oreCells = this.ores;
    v.inputLocked = false;
    v.onIntentPlace = null;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.initStrata();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('mine');
    toast(t('⛏️ 地層がせり上がる！ラインを消して鉱石を回収しろ！天井に触れたら終わり！',
      '⛏️ The ground is rising! Clear lines to mine ore — touch the ceiling and it\'s over!'), 'announce', 3400);
  }

  oreValue(type) {
    return Math.round(DIG_ORES[type].base * (1 + this.depth / 25));
  }

  // Fill one row with rock + ore rolls. Used for the starting strata (rows
  // 5-7) and for every fresh stratum entering at the bottom.
  fillLayerRow(row, density) {
    const e = this.engine;
    const v = getView();
    const cols = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = cols.length - 1; i > 0; i--) { const k = this.rng.int(i + 1); [cols[i], cols[k]] = [cols[k], cols[i]]; }
    for (let c = 0; c < 8; c++) { e.grid[row * 8 + c] = 0; this.ores.delete(row * 8 + c); }
    for (const c of cols.slice(0, density)) {
      const k = row * 8 + c;
      e.grid[k] = 9;
      const roll = this.rng.next();
      const crystalP = 0.05 + Math.min(0.06, this.depth * 0.0015);
      if (roll < 0.012) this.ores.set(k, 'rainbow');
      else if (roll < 0.012 + crystalP) this.ores.set(k, 'crystal');
      else if (roll < 0.012 + crystalP + 0.13) this.ores.set(k, 'gold');
      v.spawnAnim.set(k, v.time);
    }
  }

  layerDensity() {
    return Math.min(7, 5 + (this.depth >= 15 ? 1 : 0) + (this.depth >= 40 ? 1 : 0));
  }

  // Three starting strata, loosest on top — the mine face you dig into.
  initStrata() {
    this.fillLayerRow(5, 3);
    this.fillLayerRow(6, 4);
    this.fillLayerRow(7, 5);
  }

  // The ground rises: rows shift up one, a fresh stratum enters at the bottom.
  pushLayer() {
    const e = this.engine;
    for (let c = 0; c < 8; c++) {
      if (e.grid[c] !== 0) { this.crushed(); return; }   // top row occupied = crushed
    }
    e.grid.copyWithin(0, 8);
    const shifted = new Map();
    for (const [k, type] of this.ores) if (k >= 8) shifted.set(k - 8, type);
    this.ores.clear();
    for (const [k, type] of shifted) this.ores.set(k, type);
    this.fillLayerRow(7, this.layerDensity());
    this.depth++;
    const v = getView();
    v.shake = Math.max(v.shake, 6);
    audio.countdown(false);
    if (this.depth % 10 === 0) {
      toast(t(`⛏️ 深度${this.depth}m 到達！鉱石が濃くなってきた…`, `⛏️ Depth ${this.depth}m! The veins are getting richer…`), 'announce', 2200);
      confettiBurst(20);
    }
    if (!e.hasAnyMove()) { e.over = true; handleEngineOver(); }
  }

  crushed() {
    if (this.ended) return;
    const v = getView();
    v.shake = 20;
    v.screenFlash = 0.5;
    audio.bossAttack();
    toast(t('⛏️ 天井に押しつぶされた…', '⛏️ Crushed against the ceiling…'), 'err', 2400);
    this.finish();
  }

  onPlace(result) {
    if (this.ended) return;
    const e = this.engine;
    const v = getView();
    // Collect ore that was inside the cleared lines.
    let bonus = 0;
    for (const [r, c] of result.clearedCells) {
      const k = r * 8 + c;
      const type = this.ores.get(k);
      if (!type) continue;
      this.ores.delete(k);
      this.mined[type]++;
      const val = this.oreValue(type);
      bonus += val;
      v.addFloatText(v.boardX + (c + 0.5) * v.cell, v.boardY + (r + 0.5) * v.cell,
        `${DIG_ORES[type].icon} +${fmt(val)}`, DIG_ORES[type].tint, type === 'rainbow' ? 1.8 : 1.3);
    }
    if (bonus) {
      e.score += bonus;
      audio.coin();
    }
    // Items/ults may wipe cells without a "clear" — drop orphaned ore markers.
    for (const k of [...this.ores.keys()]) if (e.grid[k] === 0) this.ores.delete(k);
    // Cadence: each placement pushes toward the next rise; clears buy time.
    this.placedSince += 1 - Math.min(1, result.lineCount);
    if (this.placedSince >= DIG_STEP) {
      this.placedSince = 0;
      clearTimeout(this.riseTimer);
      this.riseTimer = setTimeout(() => { if (!this.ended) { this.pushLayer(); this.updateHud(); } }, 260);
    }
    this.updateHud();
  }

  best() {
    const local = Number(localStorage.getItem('bba_dig_best') || 0);
    return session.user ? Math.max(local, session.user.stats.digDepth || 0) : local;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    $('#hudSub').textContent = `🪙${this.mined.gold} 💠${this.mined.crystal} 🌈${this.mined.rainbow} ・ BEST ${this.best()}m`;
    $('#hudTimer').textContent = `⛏️${this.depth}m`;
    const fill = $('#chaosBarFill');
    const pct = Math.round((this.placedSince / DIG_STEP) * 100);
    fill.style.width = `${pct}%`;
    fill.style.background = pct >= 75 ? '#ff9d3b' : '#a7793b';
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.riseTimer);
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_dig_best') || 0);
    const isBest = this.depth > 0 && this.depth >= Math.max(localBest, this.best());
    if (this.depth > localBest) localStorage.setItem('bba_dig_best', String(this.depth));
    const rewards = await submitResult({
      mode: 'dig', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      duration: (Date.now() - this.startedAt) / 1000, won: false, depth: this.depth,
    });
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('⛏️ 到達深度', '⛏️ Depth reached')}</span><b>${this.depth}m</b></div>
        <div class="rs-row"><span>${t('🪙 金鉱石', '🪙 Gold ore')}</span><b>${this.mined.gold}</b></div>
        <div class="rs-row"><span>${t('💠 クリスタル', '💠 Crystal')}</span><b>${this.mined.crystal}</b></div>
        ${this.mined.rainbow ? `<div class="rs-row"><span>${t('🌈 虹鉱石', '🌈 Rainbow ore')}</span><b>${this.mined.rainbow}</b></div>` : ''}
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() { this.finish(); }

  destroy() {
    this.ended = true;
    clearTimeout(this.riseTimer);
    const timer = $('#hudTimer');
    timer.classList.add('hidden');
    $('#chaosBar').classList.add('hidden');
    const fill = $('#chaosBarFill');
    fill.style.background = '';
    fill.style.width = '0%';
    if (view) { view.onPlace = null; view.oreCells = null; }
  }
}

export function startDig() {
  if (currentMode) currentMode.destroy();
  currentMode = new DigMode();
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Timed versus base (shared by AI battles and online battles)
// ---------------------------------------------------------------------------

class VersusBase {
  setupHud(duration) {
    showScreen('game');
    $('#oppPanel').classList.remove('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#teamTotals').classList.add('hidden');
    this.timeLeft = duration;
    this.updateTimerHud();
    this.scores = {};       // slot -> latest score of others
    this.miniBoards = {};   // slot -> MiniBoard
    this.updateBars(0, 0);
  }

  // others: [{ slot, name, isAlly }]
  buildPanels(others) {
    const cards = $('#oppCards');
    cards.innerHTML = '';
    cards.classList.toggle('compact', others.length > 1);
    for (const o of others) {
      const card = document.createElement('div');
      card.className = `opp-card ${o.isAlly ? 'ally' : ''}`;
      card.innerHTML = `
        <canvas></canvas>
        <div class="opp-name">${o.isAlly ? '🤝 ' : ''}${escapeHtml(o.name)}</div>
        <div class="opp-score" data-slot-score="${o.slot}">0</div>
        <div class="opp-combo" data-slot-combo="${o.slot}"></div>`;
      cards.appendChild(card);
      this.miniBoards[o.slot] = new MiniBoard(card.querySelector('canvas'));
      this.miniBoards[o.slot].setGrid(new Array(64).fill(0));
      this.scores[o.slot] = 0;
    }
  }

  updateOpp(slot, state) {
    this.scores[slot] = state.score || 0;
    const sc = document.querySelector(`[data-slot-score="${slot}"]`);
    if (sc) sc.textContent = fmt(state.score || 0);
    if (state.combo >= 2) {
      const cb = document.querySelector(`[data-slot-combo="${slot}"]`);
      if (cb) {
        cb.textContent = `${state.combo} COMBO!`;
        setTimeout(() => { cb.textContent = ''; }, 1200);
      }
    }
    if (state.grid && this.miniBoards[slot]) this.miniBoards[slot].setGrid(state.grid);
  }

  updateTimerHud() {
    const t = Math.max(0, Math.ceil(this.timeLeft));
    const mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
    const el = $('#hudTimer');
    el.textContent = `${mm}:${ss}`;
    el.classList.toggle('urgent', t <= 10);
  }

  startTimer(onEnd) {
    // Wall-clock based: stays accurate even when background tabs throttle timers.
    if (this.timerInt) clearInterval(this.timerInt);
    this.endAt = Date.now() + this.timeLeft * 1000;
    this.timerInt = setInterval(() => {
      this.timeLeft = Math.max(0, (this.endAt - Date.now()) / 1000);
      this.updateTimerHud();
      if (this.timeLeft <= 0) {
        clearInterval(this.timerInt);
        this.timerInt = null;
        onEnd();
      }
    }, 250);
  }

  stopTimer() { if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; } }

  updateBars(me, opp) {
    const total = me + opp;
    const pct = total === 0 ? 50 : Math.round((me / total) * 100);
    $('#vsBarMe').style.width = `${pct}%`;
  }

  updateMyHud(engine) {
    const el = $('#hudScore');
    el.textContent = fmt(engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = engine.streak >= 2 ? `${engine.streak} COMBO` : 'SCORE';
  }
}

// ---------------------------------------------------------------------------
// VS AI
// ---------------------------------------------------------------------------

// Per-difficulty stage presentation: board theme + music track.
const DIFF_THEME = {
  easy:   { board: 'board_forest',  track: 'solo' },
  normal: { board: 'board_default', track: 'battle' },
  hard:   { board: 'board_sunset',  track: 'hard' },
  oni:    { board: 'board_oni',     track: 'oni' },
  kami:   { board: 'board_kami',    track: 'kami' },
  souzou: { board: 'board_galaxy',  track: 'kami' },
};

class AiMode extends VersusBase {
  constructor(level) {
    super();
    this.mode = 'ai';
    this.level = level;
    this.cfg = AI_LEVELS[level];
  }

  aiLabel() { return `${this.cfg.avatar} AI (${t(this.cfg.name, this.cfg.nameEn)})`; }

  start() {
    const seed = (Math.random() * 2 ** 31) | 0;
    this.setupHud(MATCH_SECONDS);
    showItemBar(false);   // fair fight: same pieces, no boosters
    this.buildPanels([{ slot: 1, name: this.aiLabel(), isAlly: false }]);
    this.startedAt = Date.now();
    const v = getView();
    const stage = DIFF_THEME[this.level] || DIFF_THEME.normal;
    v.setTheme({ ...equippedTheme(), boardId: stage.board });
    this.engine = new Engine(seed);
    this.aiEngine = new Engine(seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(stage.track);

    const begin = () => countdownOverlay(3, () => {
      v.inputLocked = false;
      this.startTimer(() => this.finish());
      this.aiLoop();
    }, audio);

    if (this.level === 'oni') this.oniIntro(begin);
    else if (this.level === 'kami') this.kamiIntro(begin);
    else if (this.level === 'souzou') this.souzouIntro(begin);
    else begin();
  }

  // Cosmic entrance for the TRUE hidden difficulty.
  souzouIntro(next) {
    const el = document.createElement('div');
    el.className = 'kami-intro souzou';
    el.innerHTML = `
      <div class="kami-rays"></div>
      <div class="kami-face">🌌</div>
      <div class="kami-text">${t('創造神が 目覚めた————', 'The Creator God has awakened————')}</div>`;
    document.body.appendChild(el);
    audio.kamiDescend();
    audio.bossAttack();
    if (view) view.shake = 16;
    setTimeout(() => { el.remove(); next(); }, 2600);
  }

  // Dramatic entrance for the hidden difficulty.
  oniIntro(next) {
    const el = document.createElement('div');
    el.className = 'oni-intro';
    el.innerHTML = `<div class="oni-face">👹</div><div class="oni-text">${t('おにが あらわれた！', 'The Oni appears!')}</div>`;
    document.body.appendChild(el);
    audio.gameOver();
    if (view) view.shake = 14;
    setTimeout(() => { el.remove(); next(); }, 1900);
  }

  // Divine entrance for the ultimate hidden difficulty.
  kamiIntro(next) {
    const el = document.createElement('div');
    el.className = 'kami-intro';
    el.innerHTML = `
      <div class="kami-rays"></div>
      <div class="kami-face">🔱</div>
      <div class="kami-text">${t('神が 降臨した——', 'A God descends——')}</div>`;
    document.body.appendChild(el);
    audio.kamiDescend();
    if (view) view.shake = 8;
    setTimeout(() => { el.remove(); next(); }, 2300);
  }

  aiLoop() {
    const jitter = 0.75 + Math.random() * 0.5;
    this.aiTimer = setTimeout(() => {
      if (this.ended) return;
      if (this.aiEngine.over) this.aiEngine.reviveBoard();
      const move = chooseMove(this.aiEngine, this.level);
      let combo = 0;
      if (move) {
        const r = this.aiEngine.place(move.index, move.row, move.col);
        if (r && r.lineCount > 0) combo = r.streak;
      }
      this.updateOpp(1, {
        score: this.aiEngine.score, combo,
        grid: this.aiEngine.snapshot(),
      });
      this.updateBars(this.engine.score, this.aiEngine.score);
      this.aiLoop();
    }, this.cfg.moveMs * jitter);
  }

  onPlace() {
    this.updateMyHud(this.engine);
    this.updateBars(this.engine.score, this.aiEngine.score);
  }

  onTopOut() {
    if (this.ended) return;
    toast(t('ボードリセット！スコアは維持されます', 'Board reset! Your score is kept'), '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    clearTimeout(this.aiTimer);
    getView().inputLocked = true;
    const me = this.engine.score, opp = this.aiEngine.score;
    // Quitting early is ALWAYS a draw — never counted as a defeat.
    const outcome = this.aborted ? 'draw' : me > opp ? 'win' : me < opp ? 'lose' : 'draw';
    if (!this.aborted) {
      if (outcome === 'win') { audio.victory(); confettiBurst(); } else audio.gameOver();
    }

    const modeName = { oni: 'ai_oni', kami: 'ai_kami', souzou: 'ai_souzou' }[this.level] || 'ai';
    const rewards = await submitResult({
      mode: modeName, score: me, lines: this.engine.linesCleared,
      maxCombo: this.engine.maxCombo, duration: MATCH_SECONDS, won: outcome === 'win',
    });
    if (rewards && rewards.badge === 'oni') {
      setTimeout(() => toast(t('👹 バッジ「おに退治」を獲得！', '👹 Badge earned: Oni Slayer!'), 'announce', 4000), 1200);
    }
    if (rewards && rewards.badge === 'kami') {
      setTimeout(() => toast(t('🔱 バッジ「神殺し」を獲得！！', '🔱 Badge earned: God Slayer!!'), 'announce', 5000), 1200);
    }
    if (rewards && rewards.badge === 'souzou') {
      setTimeout(() => { toast(t('🌌 バッジ「創造を超えし者」を獲得！！！', '🌌 Badge earned: Beyond Creation!!!'), 'announce', 6000); confettiBurst(80); }, 1200);
    }

    const banners = { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: this.aborted ? t('🤝 引き分け（中断）', '🤝 Draw (aborted)') : 'DRAW' };
    const m = showModal(`
      <div class="result-banner ${outcome}">${banners[outcome]}</div>
      ${this.aborted ? `<p class="muted center">${t('途中終了は引き分け扱いです。敗北にはなりません', 'Quitting early counts as a draw, not a loss')}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('あなた', 'You')}</span><b>${fmt(me)}</b></div>
        <div class="rs-row"><span>${this.aiLabel()}</span><b>${fmt(opp)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('再戦', 'Rematch')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startVsAi(this.level); };
  }

  quit() {
    this.aborted = true;
    this.finish();
  }

  destroy() {
    this.ended = true;
    this.stopTimer();
    clearTimeout(this.aiTimer);
  }
}

// ---------------------------------------------------------------------------
// Boss battles (PvE): deal damage with points, survive the boss's attacks.
// ---------------------------------------------------------------------------

const BOSS_STAGE = {
  slime:  { board: 'board_forest', track: 'battle' },
  golem:  { board: 'board_ocean',  track: 'boss' },
  dragon: { board: 'board_sunset', track: 'boss' },
  maou:   { board: 'board_oni',    track: 'oni' },
  mecha:  { board: 'board_cyber',  track: 'pixel' },
  frost:  { board: 'board_snow',   track: 'kami' },
};

// ---------------------------------------------------------------------------
// ボス共通戦闘システム — 技テーブル・予告&カット・フェーズ制。
// BossMode（単体戦）と BossRushMode（無限地獄）が共有する。
// 予告技は着弾マスが赤く点滅し、そのマスを通るラインを消すと『カット』：
// 攻撃キャンセル＋反撃ダメージ＋奥義ゲージ加速。
// ---------------------------------------------------------------------------

const TELEGRAPH_MS = 4200;

const BOSS_MOVES = {
  garbage:     { name: 'お邪魔弾',       nameEn: 'Garbage Shot',   telegraph: true },
  breath_row:  { name: '火炎ブレス',     nameEn: 'Flame Breath',   telegraph: true },
  laser_col:   { name: '縦断レーザー',   nameEn: 'Piercing Laser', telegraph: true },
  laser_col2:  { name: 'ダブルレーザー', nameEn: 'Twin Lasers',    telegraph: true },
  quake:       { name: '大地震',         nameEn: 'Quake',          telegraph: false },
  curse_hand:  { name: '呪縛',           nameEn: 'Hand Curse',     telegraph: false },
  curse_hand2: { name: '二重呪縛',       nameEn: 'Double Curse',   telegraph: false },
};

function bossAtkMs(m) {
  return m.boss.atkSec * 1000 * (m.phase2 ? (m.boss.atk2 || 0.75) : 1);
}

function bossTelegraphMs(m) {
  return m.phase2 ? TELEGRAPH_MS * 0.8 : TELEGRAPH_MS;
}

// Target cells for a telegraphed move (empty cells only — filling a target
// yourself also defuses that cell).
function bossMoveCells(m, moveId) {
  const e = m.engine;
  const empty = [];
  for (let i = 0; i < 64; i++) if (!e.grid[i]) empty.push(i);
  if (moveId === 'breath_row') {
    const r = (Math.random() * 8) | 0;
    return empty.filter(k => ((k / 8) | 0) === r);
  }
  if (moveId === 'laser_col' || moveId === 'laser_col2') {
    const n = moveId === 'laser_col2' ? 2 : 1;
    const cols = [...Array(8).keys()];
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(cols.splice((Math.random() * cols.length) | 0, 1)[0]);
    return empty.filter(k => picked.includes(k % 8));
  }
  const n = Math.max(1, m.boss.atkCells + (m.atkCellsDelta || 0));
  const out = [];
  for (let i = 0; i < n && empty.length; i++) out.push(empty.splice((Math.random() * empty.length) | 0, 1)[0]);
  return out;
}

function bossBeginMove(m) {
  if (m.ended || !m.engine || view.inputLocked || m.relicOpen || m.pendingAtk) return;
  const list = (m.phase2 && m.boss.moves2) || m.boss.moves || ['garbage'];
  const moveId = list[(Math.random() * list.length) | 0];
  const def = BOSS_MOVES[moveId] || BOSS_MOVES.garbage;
  if (!def.telegraph) {
    bossInstantMove(m, moveId);
    m.nextAtk = Date.now() + bossAtkMs(m);
    return;
  }
  const cells = bossMoveCells(m, moveId);
  if (!cells.length) { m.nextAtk = Date.now() + bossAtkMs(m); return; }
  m.pendingAtk = { cells, moveId };
  m.nextAtk = Date.now() + bossTelegraphMs(m);
  view.dangerCells = new Set(cells);
  audio.countdown(false);
  toast(t(`⚠️ ${m.boss.emoji} ${def.name}の予告！赤マスをラインで切れ！`, `⚠️ ${def.nameEn} incoming! Cut the red cells with a line!`), 'err', 1700);
}

function bossInstantMove(m, moveId) {
  const e = m.engine;
  // 絶対防御/フォートレスは予告技と同様に即時技も完全無効化する。
  if (e.fortressActive && e.fortressActive()) {
    toast(t('🛡️ 絶対防御が攻撃を無効化！', '🛡️ Absolute Guard nullified the attack!'), 'ok', 1500);
    m.afterAttack();
    return;
  }
  audio.bossAttack();
  const em = $('#bossEmoji');
  em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
  if (moveId === 'quake') {
    // 全列が下へ崩落（カオスの重力と同じ）＋お邪魔2個
    for (let c = 0; c < 8; c++) {
      const col = [];
      for (let r = 0; r < 8; r++) { const cv = e.grid[r * 8 + c]; if (cv) col.push(cv); }
      for (let r = 0; r < 8; r++) {
        const k = r * 8 + c;
        const nv = r < 8 - col.length ? 0 : col[r - (8 - col.length)];
        if (e.grid[k] !== nv) { e.grid[k] = nv; if (nv) view.spawnAnim.set(k, view.time); }
      }
    }
    const cells = e.addGarbage(2);
    m.garbageTaken = (m.garbageTaken || 0) + cells.length;
    view.shake = 14;
    toast(t(`${m.boss.emoji} 大地震！ブロックが崩落！`, `${m.boss.emoji} Quake! The board collapses!`), 'err', 1500);
  } else if (moveId === 'curse_hand' || moveId === 'curse_hand2') {
    const n = moveId === 'curse_hand2' ? 2 : 1;
    const idxs = e.hand.map((p, i) => (p ? i : -1)).filter(i => i >= 0);
    let frozen = 0;
    // 最低1枠は自由に残す — 完全ロックは理不尽
    for (let i = 0; i < n && idxs.length > 1; i++) {
      const slot = idxs.splice((Math.random() * idxs.length) | 0, 1)[0];
      e.hand[slot].frozenUntil = Date.now() + 8000;
      frozen++;
    }
    if (frozen) {
      view.screenFlash = 0.25;
      toast(t(`${m.boss.emoji} 呪縛！ピース${frozen}個が凍結（8秒）`, `${m.boss.emoji} Curse! ${frozen} piece(s) frozen (8s)`), 'err', 1800);
    }
  }
  m.afterAttack();
}

function bossImpact(m) {
  const e = m.engine;
  const pa = m.pendingAtk;
  m.pendingAtk = null;
  view.dangerCells = null;
  // 予告時間ぶんを次の攻撃間隔から差し引く — 予告の追加で実質の攻撃頻度が
  // 旧仕様より下がらないように。
  m.nextAtk = Date.now() + Math.max(2500, bossAtkMs(m) - bossTelegraphMs(m));
  if (e.fortressActive && e.fortressActive()) {
    toast(t('🛡️ 絶対防御が攻撃を無効化！', '🛡️ Absolute Guard nullified the attack!'), 'ok', 1500);
    return;
  }
  const landed = [];
  for (const k of pa.cells) {
    if (!e.grid[k]) { e.grid[k] = 9; landed.push(k); }
  }
  m.garbageTaken = (m.garbageTaken || 0) + landed.length;
  audio.bossAttack();
  const em = $('#bossEmoji');
  em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
  for (const k of landed) {
    const r = (k / 8) | 0, c = k % 8;
    view.spawnAnim.set(k, view.time);
    view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
  }
  view.shake = 12;
  const def = BOSS_MOVES[pa.moveId] || BOSS_MOVES.garbage;
  toast(t(`${m.boss.emoji} ${def.name}が直撃！`, `${m.boss.emoji} ${def.nameEn} hits!`), 'err', 1300);
  // Direct grid writes bypass engine.place's game-over check.
  if (!e.hasAnyMove()) e.over = true;
  m.afterAttack();
}

// Clearing a line through a telegraphed cell = CUT: cancel + counter damage.
function bossTryCut(m, result) {
  const pa = m.pendingAtk;
  if (!pa || result.lineCount === 0) return 0;
  const hit = pa.cells.some(k => {
    const r = (k / 8) | 0, c = k % 8;
    return result.fullRows.includes(r) || result.fullCols.includes(c);
  });
  if (!hit) return 0;
  m.pendingAtk = null;
  view.dangerCells = null;
  m.cuts = (m.cuts || 0) + 1;
  m.nextAtk = Date.now() + Math.max(2500, bossAtkMs(m) - bossTelegraphMs(m));
  const dmg = Math.round((200 + m.maxHp * 0.018) * (m.counterMult || 1));
  m.hp -= dmg;
  m.engine.chargeUlt(12);
  audio.combo(9);
  view.screenFlash = 0.3;
  view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize * 0.18, 'COUNTER!', '#43d9e8', 2);
  m.damageFloat(dmg, true);
  return dmg;
}

function bossCheckPhase(m) {
  if (m.phase2 || m.hp > m.maxHp / 2 || m.hp <= 0 || m.ended) return;
  m.phase2 = true;
  $('#bossEmoji').classList.add('boss-enrage');
  view.screenFlash = 0.45;
  view.shake = 16;
  audio.kamiDescend();
  toast(t(`😡 ${m.boss.name} 第二形態！攻撃が激化する！`, `😡 ${catName(m.boss)} enters phase 2! Attacks intensify!`), 'announce', 2600);
}

// 討伐ランク: 速さ・カット数・被弾数・コンボから S/A/B/C。
function bossRankFor(m) {
  const dur = (Date.now() - m.startedAt) / 1000;
  const par = m.maxHp / 110 + 25;
  let pts = 100;
  pts -= Math.max(0, dur / par - 1) * 45;
  pts += Math.min(30, (m.cuts || 0) * 6);
  pts -= (m.garbageTaken || 0) * 1.1;
  if (m.engine.maxCombo >= 8) pts += 8;
  return pts >= 96 ? 'S' : pts >= 72 ? 'A' : pts >= 45 ? 'B' : 'C';
}

function bossRankHtml(rank) {
  return `<div class="boss-rank-wrap"><span class="boss-rank rank-${rank}">${rank}</span><small>${t('討伐ランク', 'Clear rank')}</small></div>`;
}

class BossMode {
  constructor(boss, bossIndex, bossCount) {
    this.mode = 'boss';
    this.boss = boss;
    this.bossIndex = bossIndex;
    this.bossCount = bossCount;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    $('#bossEmoji').textContent = this.boss.emoji;
    $('#bossEmoji').className = 'boss-emoji';
    $('#bossName').textContent = catName(this.boss);
    showItemBar(true);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.hp;
    this.phase2 = false;
    this.pendingAtk = null;
    this.cuts = 0;
    this.garbageTaken = 0;
    this.updateHpBar();
    this.startedAt = Date.now();

    const v = getView();
    const stage = BOSS_STAGE[this.boss.id] || {};
    v.setTheme({ ...equippedTheme(), boardId: stage.board || 'board_default' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(stage.track || 'boss');

    countdownOverlay(3, () => {
      v.inputLocked = false;
      this.nextAtk = Date.now() + bossAtkMs(this);
      this.atkInt = setInterval(() => this.tickAttack(), 100);
    }, audio);
  }

  afterAttack() {
    if (this.engine.over) this.finish(false);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = t('⚔️ 与ダメージ', '⚔️ Damage dealt');
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.boss.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.hp))} / ${fmt(this.boss.hp)}`;
  }

  onPlace(result) {
    this.updateHud();
    const dmg = result.gained;
    this.hp -= dmg;
    this.damageFloat(dmg, result.lineCount > 0);
    bossTryCut(this, result);
    bossCheckPhase(this);
    this.updateHpBar();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.finish(true);
  }

  damageFloat(dmg, big) {
    const span = document.createElement('span');
    span.className = `dmg-float ${big ? 'big' : ''}`;
    span.textContent = `-${fmt(dmg)}`;
    span.style.left = `${30 + Math.random() * 40}%`;
    $('#bossPanel').appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  tickAttack() {
    if (this.ended) return;
    const total = this.pendingAtk ? bossTelegraphMs(this) : bossAtkMs(this);
    const remain = Math.max(0, this.nextAtk - Date.now());
    const bar = $('#bossAtkBar');
    bar.style.width = `${Math.max(0, Math.min(100, (1 - remain / total) * 100))}%`;
    bar.classList.toggle('danger', !!this.pendingAtk);
    if (remain <= 0) {
      if (this.pendingAtk) bossImpact(this);
      else bossBeginMove(this);
    }
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    view.inputLocked = true;
    view.dangerCells = null;
    $('#bossAtkBar').classList.remove('danger');
    const dur = (Date.now() - this.startedAt) / 1000;
    const rank = won ? bossRankFor(this) : null;
    if (won) {
      audio.bossDefeated();
      confettiBurst(60);
      $('#bossEmoji').classList.add('boss-dead');
    } else if (!this.aborted) {
      audio.gameOver();
    }

    if (won) {
      const cur = Number(localStorage.getItem('bba_boss_max') || 0);
      if (this.bossIndex + 1 > cur) localStorage.setItem('bba_boss_max', String(this.bossIndex + 1));
    }
    const rewards = await submitResult({
      mode: 'boss', bossId: this.boss.id, score: this.engine.score,
      lines: this.engine.linesCleared, maxCombo: this.engine.maxCombo,
      duration: dur, won, rank,
    });
    if (rewards && rewards.badge === 'maou') {
      setTimeout(() => toast(t('😈 バッジ「魔王討伐」を獲得！', '😈 Badge earned: Demon Lord Slain!'), 'announce', 4000), 1200);
    }

    const hasNext = won && this.bossIndex + 1 < this.bossCount;
    const banner = won ? t(`${this.boss.emoji} 討伐成功！`, `${this.boss.emoji} Boss defeated!`) : this.aborted ? t('🤝 中断（引き分け）', '🤝 Aborted (draw)') : t('やられた…', 'Defeated…');
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      ${won ? bossRankHtml(rank) : ''}
      ${this.aborted ? `<p class="muted center">${t('途中終了は引き分け扱いです。敗北にはなりません', 'Quitting early counts as a draw, not a loss')}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('与えたダメージ', 'Damage dealt')}</span><b>${fmt(this.engine.score)}</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t(`${this.boss.name}の残りHP`, `${catName(this.boss)}'s HP left`)}</span><b>${fmt(Math.max(0, this.hp))}</b></div>`}
        <div class="rs-row"><span>${t('⏱️ 討伐タイム', '⏱️ Clear time')}</span><b>${Math.round(dur)}${t('秒', 's')}</b></div>
        <div class="rs-row"><span>${t('✂️ 攻撃カット', '✂️ Attacks cut')}</span><b>${fmt(this.cuts)}</b></div>
        <div class="rs-row"><span>${t('💢 被弾お邪魔', '💢 Garbage taken')}</span><b>${fmt(this.garbageTaken)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(this.engine.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn ${won ? 'btn-primary' : 'btn-ai'}" id="rAgain">${hasNext ? t('次のボスへ', 'Next boss') : won ? t('もう一度', 'Play again') : this.aborted ? t('もう一度', 'Play again') : t('リベンジ', 'Revenge!')}</button>
      </div>`, { dismissable: false });
    if (won) setTimeout(() => { const el = m.querySelector('.boss-rank'); if (el) { el.classList.add('show'); audio.victory(); } }, 500);
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      this.destroy();
      if (hasNext && window.__bbaOpenBossSelect) window.__bbaOpenBossSelect(this.bossIndex + 1);
      else startBoss(this.boss, this.bossIndex, this.bossCount);
    };
  }

  quit() {
    this.aborted = true;
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    $('#bossPanel').classList.add('hidden');
    $('#bossAtkBar').classList.remove('danger');
    if (view) view.dangerCells = null;
  }
}

export function startBoss(boss, bossIndex, bossCount) {
  if (currentMode) currentMode.destroy();
  currentMode = new BossMode(boss, bossIndex, bossCount);
  window.__bbaMode = currentMode;   // debug/testing hook
  currentMode.start();
}

// ---------------------------------------------------------------------------
// ⚔️ 無限地獄ラッシュ: 全ボス連戦のローグライク。撃破ごとに遺物を1つ選んで
// ビルドを組み、全ボスを撃破したら2周目へ（HP倍増・攻撃加速）。深度＝累計
// 撃破数が記録になる。1ミス終了 — ただし不死鳥の羽があれば一度だけ蘇る。
// ---------------------------------------------------------------------------

const RUSH_RELICS = [
  { id: 'atk',     icon: '🗡️', name: '剛力の遺物',   nameEn: 'Relic of Might',   desc: '与ダメージ+40%（累積可）',        descEn: 'Damage +40% (stacks)', w: 10 },
  { id: 'counter', icon: '🧨', name: '火薬の遺物',   nameEn: 'Relic of Powder',  desc: 'カット反撃ダメージ2倍（累積可）', descEn: 'Counter damage ×2 (stacks)', w: 8 },
  { id: 'reroll',  icon: '🔄', name: '風の遺物',     nameEn: 'Relic of Wind',    desc: 'リロール+2',                      descEn: '+2 rerolls', w: 9 },
  { id: 'ult',     icon: '⚡', name: '雷の遺物',     nameEn: 'Relic of Thunder', desc: '奥義ゲージの溜まり1.5倍（累積可）', descEn: 'Ult charge ×1.5 (stacks)', w: 8 },
  { id: 'heal',    icon: '💚', name: '慈悲の遺物',   nameEn: 'Relic of Mercy',   desc: '下2行とお邪魔を全消去',           descEn: 'Clear bottom rows + garbage', w: 9 },
  { id: 'calm',    icon: '🎯', name: '静寂の遺物',   nameEn: 'Relic of Calm',    desc: 'ボスの攻撃セル-1（最低1）',       descEn: 'Boss attack cells -1 (min 1)', w: 7 },
  { id: 'shield',  icon: '🛡️', name: '城壁の遺物',   nameEn: 'Relic of Walls',   desc: 'コンボが途切れなくなる',          descEn: 'Your combo never breaks', w: 6, unique: true },
  { id: 'phoenix', icon: '🐦', name: '不死鳥の羽',   nameEn: 'Phoenix Feather',  desc: '一度だけ窒息から復活する',        descEn: 'Revive once from a top-out', w: 5, unique: true },
];

class BossRushMode {
  constructor(bosses) {
    this.mode = 'boss';        // shares boss-panel admin command (HP halve)
    this.bosses = bosses;
    this.kills = 0;            // 深度 = 累計撃破数
    this.relics = [];
  }

  lap() { return Math.floor(this.kills / this.bosses.length); }

  // 周回でHPが倍々に、攻撃間隔が少しずつ短く。
  scaledBoss() {
    const base = this.bosses[this.kills % this.bosses.length];
    const lap = this.lap();
    return {
      ...base,
      hp: Math.round(base.hp * (1 + lap)),
      atkSec: Math.max(4, base.atkSec * Math.pow(0.94, lap)),
    };
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    showItemBar(true);
    this.kills = 0;
    this.relics = [];
    this.counterMult = 1;
    this.atkCellsDelta = 0;
    this.ultRateBonus = 1;
    this.phoenix = false;
    this.relicOpen = false;
    this.cuts = 0;
    this.garbageTaken = 0;
    this.boss = this.scaledBoss();
    this.applyBossPanel();
    this.startedAt = Date.now();

    const v = getView();
    v.setTheme({ ...equippedTheme(), boardId: 'board_oni' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('boss');
    toast(t('⚔️ 無限地獄ラッシュ！倒すほど深く、敵は強く。遺物でビルドを組め！', '⚔️ Infinite Hell Rush! The deeper you go, the stronger they get. Build with relics!'), 'announce', 3200);

    countdownOverlay(3, () => {
      v.inputLocked = false;
      this.nextAtk = Date.now() + bossAtkMs(this);
      this.atkInt = setInterval(() => this.tickAttack(), 100);
    }, audio);
  }

  afterAttack() {
    if (this.engine.over) this.onTopOut();
  }

  damageFloat(dmg, big) {
    const span = document.createElement('span');
    span.className = `dmg-float ${big ? 'big' : ''}`;
    span.textContent = `-${fmt(dmg)}`;
    span.style.left = `${30 + Math.random() * 40}%`;
    $('#bossPanel').appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  tickAttack() {
    if (this.ended || this.relicOpen) return;
    const total = this.pendingAtk ? bossTelegraphMs(this) : bossAtkMs(this);
    const remain = Math.max(0, this.nextAtk - Date.now());
    const bar = $('#bossAtkBar');
    bar.style.width = `${Math.max(0, Math.min(100, (1 - remain / total) * 100))}%`;
    bar.classList.toggle('danger', !!this.pendingAtk);
    if (remain <= 0) {
      if (this.pendingAtk) bossImpact(this);
      else bossBeginMove(this);
    }
  }

  applyBossPanel() {
    this.hp = this.boss.hp;
    this.maxHp = this.boss.hp;
    this.phase2 = false;
    this.pendingAtk = null;
    if (view) view.dangerCells = null;
    $('#bossEmoji').textContent = this.boss.emoji;
    $('#bossEmoji').className = 'boss-emoji';
    const lapTxt = this.lap() > 0 ? t(`（${this.lap() + 1}周目）`, ` (lap ${this.lap() + 1})`) : '';
    $('#bossName').textContent = `${catName(this.boss)}${lapTxt}`;
    this.updateHpBar();
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = t(`⚔️ 深度${this.kills + 1} ・ 遺物${this.relics.length}`, `⚔️ Depth ${this.kills + 1} ・ ${this.relics.length} relics`);
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.maxHp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.hp))} / ${fmt(this.maxHp)}`;
  }

  onPlace(result) {
    this.updateHud();
    this.hp -= result.gained;
    bossTryCut(this, result);
    bossCheckPhase(this);
    this.updateHpBar();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.bossDown();
  }

  bossDown() {
    this.kills++;
    this.pendingAtk = null;
    if (view) view.dangerCells = null;
    audio.bossDefeated();
    confettiBurst(30);
    if (view) view.shake = 12;
    // 遺物を選んでから次のボスへ（選択中は攻撃停止）。
    this.relicOpen = true;
    view.inputLocked = true;
    this.offerRelic(() => {
      this.boss = this.scaledBoss();
      this.applyBossPanel();
      this.updateHud();
      this.relicOpen = false;
      view.inputLocked = false;
      this.nextAtk = Date.now() + bossAtkMs(this);
      const lapUp = this.kills % this.bosses.length === 0;
      toast(lapUp
        ? t(`🔥 ${this.lap() + 1}周目突入！ボスが強化された！`, `🔥 Lap ${this.lap() + 1}! The bosses grow stronger!`)
        : t(`つぎは ${this.boss.emoji} ${this.boss.name}！`, `Next up: ${this.boss.emoji} ${catName(this.boss)}!`), 'announce', 2400);
    });
  }

  relicChoices() {
    const pool = RUSH_RELICS.filter(r =>
      !(r.unique && (r.id === 'shield' ? this.engine.streakShield : this.phoenix)));
    const out = [];
    const bag = pool.slice();
    while (out.length < 3 && bag.length) {
      const total = bag.reduce((a, r) => a + r.w, 0);
      let x = Math.random() * total;
      for (let i = 0; i < bag.length; i++) {
        x -= bag[i].w;
        if (x <= 0) { out.push(bag.splice(i, 1)[0]); break; }
      }
    }
    return out;
  }

  offerRelic(next) {
    const choices = this.relicChoices();
    const m = showModal(`
      <h2>${this.boss.emoji} ${t('撃破！', 'Down!')} <small class="muted">${t(`深度${this.kills}`, `depth ${this.kills}`)}</small></h2>
      <p class="muted center" style="margin-bottom:10px">${t('遺物を1つ選べ', 'Choose a relic')}</p>
      <div class="form-col">
        ${choices.map(r => `
          <button class="btn btn-ghost perk-btn" data-perk="${r.id}">
            <span class="perk-icon">${r.icon}</span>
            <span class="perk-body"><b>${t(r.name, r.nameEn)}</b><small>${t(r.desc, r.descEn)}</small></span>
          </button>`).join('')}
      </div>
      <p class="muted center deck-strip">${this.relics.length ? `${t('所持遺物', 'Relics')}: ${this.relics.map(id => (RUSH_RELICS.find(r => r.id === id) || {}).icon || '').join(' ')}` : ''}</p>`,
      { dismissable: false });
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => { this.applyRelic(b.dataset.perk); closeModal(); next(); };
    });
    if (autopilot.on && autopilot.autoPerks !== false) {
      setTimeout(() => {
        const b = m.querySelector('[data-perk]');
        if (b && document.body.contains(b)) b.click();
      }, 800);
    }
  }

  applyRelic(id) {
    const e = this.engine;
    audio.coin();
    this.relics.push(id);
    switch (id) {
      case 'atk':     e.scoreMult = Math.round((e.scoreMult + 0.4) * 100) / 100; break;
      case 'counter': this.counterMult *= 2; break;
      case 'reroll':  e.rerolls += 2; updateRerollHud(e); break;
      // updateUltHud rewrites e.ultRate every 120ms — the bonus must live on
      // the mode where that poll multiplies it in.
      case 'ult':     this.ultRateBonus *= 1.5; break;
      case 'heal': {
        for (let i = 0; i < 64; i++) if (e.grid[i] === 9) e.grid[i] = 0;
        for (let r = 6; r < 8; r++) for (let c = 0; c < 8; c++) e.grid[r * 8 + c] = 0;
        view.reviveFlash();
        break;
      }
      case 'calm':    this.atkCellsDelta--; break;
      case 'shield':  e.streakShield = true; break;
      case 'phoenix': this.phoenix = true; break;
    }
  }

  onTopOut() {
    if (this.ended) return;
    if (autoRescue()) return;   // autopilot 5.0 guard — before burning the phoenix
    if (this.phoenix) {
      this.phoenix = false;
      this.engine.reviveBoard();
      view.reviveFlash();
      confettiBurst(40);
      audio.levelUp();
      toast(t('🐦 不死鳥の羽が燃え尽きた！盤面リセットで復活！', '🐦 The Phoenix Feather burns out — board reset, you live!'), 'announce', 3000);
      this.updateHud();
      updateRerollHud(this.engine);
      return;
    }
    this.finish(false);
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    view.inputLocked = true;
    view.dangerCells = null;
    $('#bossAtkBar').classList.remove('danger');
    // 「制覇」= 1周（全ボス撃破）以上。深度がそのまま記録になる。
    const conquered = this.kills >= this.bosses.length;
    if (!this.aborted) audio.gameOver();
    const localDepth = Number(localStorage.getItem('bba_rush_depth') || 0);
    const isBest = this.kills > 0 && this.kills > localDepth;
    if (this.kills > localDepth) localStorage.setItem('bba_rush_depth', String(this.kills));
    const rewards = await submitResult({
      mode: 'boss_rush', score: this.engine.score,
      lines: this.engine.linesCleared, maxCombo: this.engine.maxCombo,
      duration: (Date.now() - this.startedAt) / 1000, won: conquered, depth: this.kills,
    });
    if (rewards && rewards.badge === 'rush') {
      setTimeout(() => toast(t('⚔️ バッジ「ボスラッシュ制覇」を獲得！+300💎', '⚔️ Badge earned: Boss Rush Conqueror! +300💎'), 'announce', 5000), 1200);
    }
    if (isBest) confettiBurst(50);
    const banner = isBest ? t('⚔️ 最深記録更新！', '⚔️ New depth record!') : this.aborted ? t('🤝 中断', '🤝 Aborted') : t(`${this.boss.emoji} に敗北…`, `Defeated by ${this.boss.emoji}…`);
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('⚔️ 深度', '⚔️ Depth')}</span><b>${fmt(this.kills)}${t('体', '')} ${this.lap() > 0 || conquered ? t(`（${this.lap() + 1}周目）`, ` (lap ${this.lap() + 1})`) : ''}</b></div>
        <div class="rs-row"><span>${t('🏺 集めた遺物', '🏺 Relics collected')}</span><b>${this.relics.map(id => (RUSH_RELICS.find(r => r.id === id) || {}).icon || '').join('') || t('なし', 'none')}</b></div>
        <div class="rs-row"><span>${t('総ダメージ', 'Total damage')}</span><b>${fmt(this.engine.score)}</b></div>
        <div class="rs-row"><span>${t('✂️ 攻撃カット', '✂️ Attacks cut')}</span><b>${fmt(this.cuts)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ai" id="rAgain">${t('もう一度潜る', 'Dive again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startBossRush(this.bosses); };
  }

  quit() { this.aborted = true; this.finish(false); }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    $('#bossPanel').classList.add('hidden');
    $('#bossAtkBar').classList.remove('danger');
    if (view) view.dangerCells = null;
  }
}

export function startBossRush(bosses) {
  if (currentMode) currentMode.destroy();
  currentMode = new BossRushMode(bosses);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Weekly challenge: everyone worldwide gets the same seed and 40 pieces.
// Pure score attack — resets every Monday 00:00 UTC.
// ---------------------------------------------------------------------------

class WeeklyMode {
  constructor(info) {
    this.mode = 'weekly';
    this.info = info;   // { week, seed, pieces, endsAt, best }
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);   // fair play: no boosters
    this.startedAt = Date.now();
    const v = getView();
    v.setTheme({ ...equippedTheme(), boardId: 'board_galaxy' });
    this.engine = new Engine(this.info.seed);
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = () => this.onPlace();
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('battle');
    toast(t(`🎯 ウィークリーチャレンジ！${this.info.pieces}個のピースで限界に挑め！`, `🎯 Weekly Challenge! Push your limit with ${this.info.pieces} pieces!`), 'announce', 2800);
  }

  piecesLeft() { return Math.max(0, this.info.pieces - this.engine.piecesPlaced); }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = t(`🎯 ${this.info.week} ・ ベスト ${fmt(this.best())}`, `🎯 ${this.info.week} ・ Best ${fmt(this.best())}`);
    const tm = $('#hudTimer');
    tm.textContent = t(`残り${this.piecesLeft()}個`, `${this.piecesLeft()} left`);
    tm.classList.toggle('urgent', this.piecesLeft() <= 5);
  }

  best() {
    const local = this.localBest();
    return Math.max(this.info.best || 0, local);
  }

  localBest() {
    try {
      const v = JSON.parse(localStorage.getItem('bba_weekly_best'));
      if (v && v.week === this.info.week) return v.best || 0;
    } catch { /* ignore */ }
    return 0;
  }

  onPlace() {
    this.updateHud();
    if (this.piecesLeft() <= 0 && !this.ended) this.finish();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const prevBest = this.best();
    const isBest = e.score > prevBest;
    if (e.score > this.localBest()) {
      localStorage.setItem('bba_weekly_best', JSON.stringify({ week: this.info.week, best: e.score }));
    }
    if (isBest && e.score > 0) { audio.victory(); confettiBurst(50); } else { audio.gameOver(); }
    const rewards = await submitResult({
      mode: 'weekly', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    const usedAll = e.piecesPlaced >= this.info.pieces;
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? t('🎯 今週のベスト更新！', '🎯 New weekly best!') : t('🎯 チャレンジ終了', '🎯 Challenge complete')}</div>
      ${usedAll ? '' : `<p class="muted center">${t('ピースを置く場所がなくなりました', 'No room left to place a piece')}</p>`}
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}${isBest ? ' 👑' : ''}</b></div>
        <div class="rs-row"><span>${t('今週のベスト', "This week's best")}</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>${t('使ったピース', 'Pieces used')}</span><b>${fmt(e.piecesPlaced)} / ${this.info.pieces}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
        ${session.user ? '' : `<div class="rs-row"><span>${t('💡 ランキング掲載にはログイン', '💡 Log in to appear on the ranking')}</span></div>`}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rRank">${t('🏆 順位を見る', '🏆 Standings')}</button>
        <button class="btn btn-weekly" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rRank').onclick = () => {
      closeModal(); endToMenu();
      if (window.__bbaOpenLeaderboard) window.__bbaOpenLeaderboard('weekly');
    };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startWeekly({ ...this.info, best: Math.max(this.info.best || 0, e.score) }); };
  }

  quit() { this.finish(); }
  destroy() { this.ended = true; }
}

export function startWeekly(info) {
  if (currentMode) currentMode.destroy();
  currentMode = new WeeklyMode(info);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Dungeon tower (PvE roguelite): climb 100 floors. Each floor is a foe with
// HP and periodic garbage attacks; every 10th floor is a boss + checkpoint.
// After each floor you pick 1 of 3 perks that stack for the whole run.
// ---------------------------------------------------------------------------

const DUNGEON_BANDS = [
  { name: '苔の洞窟',   nameEn: 'Mossy Cave',       board: 'board_forest',  track: 'battle', foes: [['🦇', 'コウモリ', 'Bat'], ['🐀', '大ネズミ', 'Giant Rat'], ['🟢', 'スライム', 'Slime'], ['🕷️', '毒グモ', 'Venom Spider']], boss: ['👑', 'キングスライム', 'King Slime'] },
  { name: '海底神殿',   nameEn: 'Sunken Temple',    board: 'board_ocean',   track: 'battle', foes: [['🐙', 'タコ兵', 'Octopus Trooper'], ['🦀', '鉄カニ', 'Iron Crab'], ['🐡', 'トゲフグ', 'Spike Puffer'], ['🦈', 'サメ傭兵', 'Shark Mercenary']], boss: ['🧜‍♀️', '海の女王', 'Queen of the Sea'] },
  { name: '桜の迷宮',   nameEn: 'Sakura Labyrinth', board: 'board_sakura',  track: 'solo',   foes: [['🦊', '妖狐', 'Fox Spirit'], ['🐍', '花蛇', 'Blossom Snake'], ['🦋', '幻蝶', 'Phantom Butterfly'], ['🐦', '怪鳥', 'Dread Bird']], boss: ['👺', '大天狗', 'Great Tengu'] },
  { name: '黄昏の砂漠', nameEn: 'Twilight Desert',  board: 'board_sunset',  track: 'hard',   foes: [['🦂', '大サソリ', 'Giant Scorpion'], ['🐫', '護衛ラクダ', 'Guard Camel'], ['🦅', 'ハゲタカ', 'Vulture'], ['🐍', '砂大蛇', 'Sand Serpent']], boss: ['🦁', 'スフィンクス', 'Sphinx'] },
  { name: '灼熱火山',   nameEn: 'Scorching Volcano', board: 'board_volcano', track: 'hard',  foes: [['🔥', '火の精', 'Fire Sprite'], ['🦎', '溶岩トカゲ', 'Lava Lizard'], ['🐗', 'マグマ猪', 'Magma Boar'], ['🗿', '岩人形', 'Stone Golem']], boss: ['🐲', '火竜グレンド', 'Grend the Fire Dragon'] },
  { name: '氷結洞窟',   nameEn: 'Frozen Cavern',    board: 'board_default', track: 'boss',   foes: [['⛄', '雪人形', 'Snow Golem'], ['🐧', '氷ペンギン兵', 'Ice Penguin Trooper'], ['🦭', '氷セイウチ', 'Ice Walrus'], ['❄️', '氷の精', 'Frost Sprite']], boss: ['🐻‍❄️', 'フロストベア', 'Frost Bear'] },
  { name: '雷雲の頂',   nameEn: 'Thunderhead Peak', board: 'board_galaxy',  track: 'boss',   foes: [['⚡', '雷精', 'Storm Sprite'], ['🦅', '雷鷲', 'Thunder Eagle'], ['☁️', '雲魔', 'Cloud Fiend'], ['🌪️', '竜巻魔', 'Tornado Fiend']], boss: ['🦚', 'サンダーバード', 'Thunderbird'] },
  { name: '亡霊の城',   nameEn: 'Haunted Castle',   board: 'board_oni',     track: 'oni',    foes: [['👻', '亡霊', 'Wraith'], ['💀', 'スケルトン', 'Skeleton'], ['🧟', 'ゾンビ騎士', 'Zombie Knight'], ['🦇', '吸血コウモリ', 'Vampire Bat']], boss: ['🧛', 'ヴァンパイア卿', 'Lord Vampire'] },
  { name: '鬼の巣窟',   nameEn: 'Oni Den',          board: 'board_oni',     track: 'oni',    foes: [['👹', '赤鬼', 'Red Oni'], ['👺', '青鬼', 'Blue Oni'], ['🔥', '鬼火', 'Ghost Flame'], ['💀', '骨武者', 'Bone Samurai']], boss: ['👹', '鬼神ラセツ', 'Rasetsu the Oni God'] },
  { name: '天界の門',   nameEn: 'Heavenly Gate',    board: 'board_kami',    track: 'kami',   foes: [['🕊️', '堕天使', 'Fallen Angel'], ['⚔️', '神殿騎士', 'Temple Knight'], ['🌟', '星霊', 'Star Spirit'], ['🔮', '法陣魔', 'Rune Fiend']], boss: ['😈', '魔神ゼルガドス', 'Zelgados the Demon God'] },
];

// Underground realm (B1–B100): tougher, faster, rubble on every floor.
const UNDER_BANDS = [
  { name: '苔むす地下道', nameEn: 'Mossy Underpass',  board: 'board_forest',  track: 'battle', foes: [['🐛', '大ミミズ', 'Giant Worm'], ['🦟', '洞窟蚊', 'Cave Gnat'], ['🍄', '毒キノコ', 'Toxic Shroom'], ['🐌', '岩ナメクジ', 'Rock Slug']], boss: ['🐍', '地底大蛇', 'Tunnel Serpent'] },
  { name: '忘れられた坑道', nameEn: 'Forgotten Mineshaft', board: 'board_default', track: 'battle', foes: [['⛏️', '亡霊坑夫', 'Ghost Miner'], ['🦇', '洞窟コウモリ', 'Cave Bat'], ['🕸️', '坑道グモ', 'Shaft Spider'], ['🧌', 'トロル', 'Troll']], boss: ['🗿', 'ゴーレム親方', 'Golem Foreman'] },
  { name: '地底湖',       nameEn: 'Sunless Lake',     board: 'board_ocean',   track: 'battle', foes: [['🐟', '盲目魚', 'Blind Fish'], ['🦞', '白ザリガニ', 'Pale Crayfish'], ['🐸', '洞窟ガエル', 'Cave Toad'], ['🪼', '地底クラゲ', 'Deep Jelly']], boss: ['🐊', '地底湖の主', 'Lord of the Sunless Lake'] },
  { name: '水晶の洞',     nameEn: 'Crystal Hollow',   board: 'board_galaxy',  track: 'hard',   foes: [['💎', 'クリスタル獣', 'Crystal Beast'], ['✨', '光の精', 'Light Wisp'], ['🦂', '水晶サソリ', 'Crystal Scorpion'], ['🗿', '晶石人形', 'Geode Golem']], boss: ['👸', '水晶の女王', 'Crystal Queen'] },
  { name: '骨の回廊',     nameEn: 'Bone Gallery',     board: 'board_oni',     track: 'boss',   foes: [['💀', '骸骨兵', 'Bone Soldier'], ['🦴', '骨犬', 'Bone Hound'], ['👻', '地縛霊', 'Earthbound Ghost'], ['🧟', '屍鬼', 'Ghoul']], boss: ['☠️', '骸骨王', 'Skeleton King'] },
  { name: '溶岩脈',       nameEn: 'Lava Vein',        board: 'board_volcano', track: 'hard',   foes: [['🔥', 'マグマ虫', 'Magma Grub'], ['🦎', '火蜥蜴', 'Flame Newt'], ['👹', '炎鬼', 'Flame Oni'], ['🌋', '噴煙魔', 'Smoke Fiend']], boss: ['🐉', '地竜バルガ', 'Balga the Earth Dragon'] },
  { name: '毒の沼窟',     nameEn: 'Venom Grotto',     board: 'board_forest',  track: 'oni',    foes: [['🐍', '毒蛇', 'Viper'], ['🦠', '猛毒スライム', 'Toxic Ooze'], ['🕷️', '母グモ', 'Brood Spider'], ['🦂', '死のサソリ', 'Death Scorpion']], boss: ['🐲', '毒竜ドクロア', 'Dokuroa the Venom Drake'] },
  { name: '静寂の墓所',   nameEn: 'Silent Crypt',     board: 'board_oni',     track: 'oni',    foes: [['⚰️', '棺の霊', 'Coffin Wraith'], ['🧛', '血吸い', 'Blood Fiend'], ['👤', '影人', 'Shade'], ['🕯️', '呪い火', 'Curse Flame']], boss: ['👑', '墓所の王', 'Crypt King'] },
  { name: '奈落への橋',   nameEn: 'Bridge to the Abyss', board: 'board_galaxy', track: 'kami', foes: [['🌑', '闇の使徒', 'Dark Apostle'], ['🦅', '深淵鷲', 'Abyss Eagle'], ['⛓️', '鎖の獄卒', 'Chain Warden'], ['🔮', '虚無魔', 'Void Fiend']], boss: ['😱', '奈落の番人', 'Warden of the Abyss'] },
  { name: '深淵の玉座',   nameEn: 'Throne of the Abyss', board: 'board_oni',  track: 'kami',   foes: [['👿', '深淵の魔兵', 'Abyssal Soldier'], ['🌑', '無貌のもの', 'The Faceless'], ['🐙', '深淵の触手', 'Abyssal Tendril'], ['💀', '奈落騎士', 'Abyss Knight']], boss: ['👁️', '深淵神アビソス', 'Abysos the Abyss God'] },
];

// Heaven realm (H1–H100): slower but heavier attacks; bosses grant blessings.
const HEAVEN_BANDS = [
  { name: '雲の階段',     nameEn: 'Stairway of Clouds', board: 'board_default', track: 'solo', foes: [['☁️', '雲ひつじ', 'Cloud Sheep'], ['🕊️', '白鳩兵', 'Dove Trooper'], ['🌬️', '風の精', 'Wind Sprite'], ['🎐', '鈴天使', 'Chime Cherub']], boss: ['🦢', '白鳥の守護者', 'Swan Guardian'] },
  { name: '虹の花園',     nameEn: 'Rainbow Garden',   board: 'board_sakura',  track: 'solo',   foes: [['🦋', '虹蝶', 'Rainbow Butterfly'], ['🐝', '蜜天蜂', 'Honeybee Cherub'], ['🌷', '花の精', 'Flower Sprite'], ['🐞', '星てんとう', 'Star Ladybug']], boss: ['🧚', '花園の女王', 'Queen of the Garden'] },
  { name: '星屑の橋',     nameEn: 'Stardust Bridge',  board: 'board_galaxy',  track: 'battle', foes: [['⭐', '星の子', 'Starling'], ['🌠', '流星獣', 'Meteor Beast'], ['🪐', '環の精', 'Ring Spirit'], ['✨', '光塵魔', 'Gleam Fiend']], boss: ['🌟', '星織りの賢者', 'Sage of Woven Stars'] },
  { name: '月光の泉',     nameEn: 'Moonlit Spring',   board: 'board_ocean',   track: 'solo',   foes: [['🌙', '月ウサギ', 'Moon Rabbit'], ['🫧', '泡天使', 'Bubble Cherub'], ['🐬', '天空イルカ', 'Sky Dolphin'], ['🦚', '月孔雀', 'Moon Peacock']], boss: ['🌕', '月の巫女', 'Priestess of the Moon'] },
  { name: '審判の間',     nameEn: 'Hall of Judgment', board: 'board_kami',    track: 'boss',   foes: [['⚖️', '天秤の番人', 'Scale Keeper'], ['📜', '律法の霊', 'Law Spirit'], ['🗡️', '裁きの剣', 'Judging Blade'], ['👁️', '監視者', 'The Watcher']], boss: ['🦁', '審判者レオン', 'Leon the Adjudicator'] },
  { name: '竪琴の雲海',   nameEn: 'Sea of Harp Clouds', board: 'board_sunset', track: 'kami',  foes: [['🎵', '音符精', 'Note Sprite'], ['🎺', 'ラッパ天使', 'Trumpet Cherub'], ['🪽', '有翼獅子', 'Winged Lion'], ['🕊️', '聖鳩', 'Holy Dove']], boss: ['🎼', '大聖歌長', 'Grand Cantor'] },
  { name: '黄金の大聖堂', nameEn: 'Golden Cathedral', board: 'board_kami',    track: 'kami',   foes: [['⚔️', '聖堂騎士', 'Cathedral Knight'], ['🛡️', '光の衛兵', 'Light Sentinel'], ['🕯️', '聖火の精', 'Sacred Flame'], ['📿', '祈りの霊', 'Prayer Spirit']], boss: ['👼', '大天使ミカエラ', 'Archangel Michaela'] },
  { name: '天雷の峰',     nameEn: 'Peak of Holy Thunder', board: 'board_galaxy', track: 'oni', foes: [['⚡', '天雷精', 'Skybolt Sprite'], ['🦅', '神鷲', 'Divine Eagle'], ['🌩️', '雷雲魔', 'Storm Halo'], ['🔱', '雷槍兵', 'Thunder Lancer']], boss: ['🐦‍🔥', '不死鳥フェニクス', 'Phoenix'] },
  { name: '神々の回廊',   nameEn: 'Corridor of the Gods', board: 'board_kami', track: 'kami',  foes: [['🗿', '神像兵', 'Idol Soldier'], ['🦄', '聖獣ユニコーン', 'Unicorn'], ['🐉', '天竜', 'Sky Dragon'], ['🪽', '熾天使', 'Seraph']], boss: ['🌈', '虹神殿の主', 'Master of the Rainbow Shrine'] },
  { name: '創造の玉座',   nameEn: 'Throne of Creation', board: 'board_kami',  track: 'kami',   foes: [['🪽', '大熾天使', 'High Seraph'], ['☀️', '太陽の化身', 'Avatar of the Sun'], ['🌌', '星幽体', 'Astral Being'], ['👑', '王冠の霊', 'Crown Spirit']], boss: ['✨', '至高神ルミナス', 'Luminus the Supreme'] },
];

// 🌑 The Abyss — the hardest realm. Unlocked by conquering the tower.
const ABYSS_BANDS = [
  { name: '忘却の入口',   nameEn: 'Gate of Oblivion',   board: 'board_oni',     track: 'oni',  foes: [['🕯️', '消えかけの灯', 'Dying Light'], ['🦇', '影蝙蝠', 'Shade Bat'], ['🪦', '墓守', 'Gravekeeper'], ['🐍', '黒蛇', 'Black Serpent']], boss: ['🧟', '忘却の番人', 'Warden of Oblivion'] },
  { name: '嘆きの回廊',   nameEn: 'Corridor of Lament', board: 'board_oni',     track: 'oni',  foes: [['👻', '嘆きの霊', 'Lamenting Spirit'], ['🕷️', '毒蜘蛛', 'Venom Spider'], ['🗝️', '錆びた鍵守', 'Rusted Keyholder'], ['🌫️', '瘴気', 'Miasma']], boss: ['💀', '嘆きの王', 'King of Lament'] },
  { name: '血の沼',       nameEn: 'Blood Marsh',        board: 'board_volcano', track: 'oni',  foes: [['🩸', '血の滴', 'Blood Drop'], ['🐊', '沼の顎', 'Marsh Jaw'], ['🧛', '吸血鬼', 'Vampire'], ['🦟', '吸血蚊の群れ', 'Mosquito Swarm']], boss: ['🐲', '血竜ヴァルグ', 'Valg the Blood Dragon'] },
  { name: '虚無の階段',   nameEn: 'Stairs of the Void', board: 'board_cyber',   track: 'kami', foes: [['⬛', '虚無の欠片', 'Void Shard'], ['🌀', '歪み', 'Distortion'], ['👁️', '無の眼', 'Eye of Nothing'], ['🕳️', '落とし穴', 'Pitfall']], boss: ['🌀', '虚無の支配者', 'Master of the Void'] },
  { name: '狂気の鏡殿',   nameEn: 'Hall of Mad Mirrors', board: 'board_cyber',  track: 'oni',  foes: [['🪞', '鏡像', 'Mirror Image'], ['🤡', '狂道化', 'Mad Jester'], ['🎭', '二面鬼', 'Two-Faced Oni'], ['🔮', '惑わしの珠', 'Orb of Delusion']], boss: ['🃏', '狂王ジョーカー', 'The Mad Joker'] },
  { name: '氷獄',         nameEn: 'Frozen Hell',        board: 'board_snow',    track: 'oni',  foes: [['🧊', '氷の亡者', 'Frozen Wraith'], ['🐺', '氷狼', 'Ice Wolf'], ['❄️', '吹雪の精', 'Blizzard Sprite'], ['🗿', '凍てつく像', 'Frozen Idol']], boss: ['🧙', '氷獄の魔女', 'Witch of Frozen Hell'] },
  { name: '灼熱の底',     nameEn: 'Scorched Depths',    board: 'board_volcano', track: 'oni',  foes: [['🔥', '溶岩魔', 'Lava Fiend'], ['🌋', '噴火獣', 'Eruption Beast'], ['🐉', '火蜥蜴', 'Fire Lizard'], ['💥', '爆炎の精', 'Blast Sprite']], boss: ['👹', '灼熱鬼イフリート', 'Ifrit the Scorching'] },
  { name: '星喰いの巣',   nameEn: 'Nest of the Star-Eater', board: 'board_galaxy', track: 'kami', foes: [['🕸️', '星の糸', 'Star Silk'], ['🦑', '宇宙蛸', 'Cosmic Squid'], ['☄️', '落星', 'Fallen Star'], ['🌑', '暗黒球', 'Dark Sphere']], boss: ['🐙', '星喰いヨグ', 'Yog the Star-Eater'] },
  { name: '神殺しの祭壇', nameEn: 'Altar of Godslaying', board: 'board_kami',   track: 'kami', foes: [['⚔️', '堕天騎士', 'Fallen Knight'], ['🗡️', '弑逆の刃', 'Regicide Blade'], ['📿', '異端僧', 'Heretic Monk'], ['🪽', '黒翼', 'Black Wing']], boss: ['😈', '堕神ルシファル', 'Lucifal the Fallen'] },
  { name: '深淵の玉座',   nameEn: 'Throne of the Abyss', board: 'board_oni',    track: 'kami', foes: [['👁️‍🗨️', '深淵の視線', 'Gaze of the Abyss'], ['🌌', '終焉の兆し', 'Omen of the End'], ['🕳️', '奈落', 'Naraka'], ['🖤', '無慈悲', 'Mercilessness']], boss: ['🩻', '深淵王アビスゼロ', 'Abyss Zero, King of the Deep'] },
];

// One curse per Abyss floor (deterministic, so a floor feels like "that floor").
const ABYSS_CURSES = [
  { id: 'none', w: 3 },
  { id: 'noreroll', name: '封印の呪い', nameEn: 'Curse of Sealing',    desc: 'このフロアはリロール不可', descEn: 'No rerolls on this floor', w: 2 },
  { id: 'mini',     name: '矮小の呪い', nameEn: 'Curse of Dwindling',  desc: '極小ピースしか来ない', descEn: 'Only tiny pieces', w: 2 },
  { id: 'big',      name: '巨大の呪い', nameEn: 'Curse of Bulk',       desc: '大型ピースしか来ない', descEn: 'Only big pieces', w: 2 },
  { id: 'rain',     name: '瓦礫の雨',   nameEn: 'Rubble Rain',         desc: '8秒ごとにお邪魔が2個降る', descEn: '2 garbage cells every 8s', w: 2 },
  { id: 'haste',    name: '加速の呪い', nameEn: 'Curse of Haste',      desc: '敵の攻撃が30%速い', descEn: 'Attacks 30% faster', w: 2 },
  { id: 'blind',    name: '盲目の呪い', nameEn: 'Curse of Blindness',  desc: '敵のHPが見えない', descEn: 'Enemy HP is hidden', w: 1 },
  { id: 'greed',    name: '強欲の呪い', nameEn: 'Curse of Greed',      desc: '与ダメージ半減', descEn: 'Half damage dealt', w: 1 },
];

function abyssCurse(f, isBoss) {
  let h = (f * 2654435761) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  const pool = ABYSS_CURSES.filter(c => !(isBoss && c.id === 'greed'));
  const total = pool.reduce((a, c) => a + c.w, 0);
  let x = (h >>> 0) % total;
  for (const c of pool) { x -= c.w; if (x < 0) return c; }
  return pool[0];
}

// Realm definitions: the tower is the classic; the others remix the rules.
const DUNGEON_REALMS = {
  tower: {
    id: 'tower', icon: '🏰', name: 'ダンジョン塔', nameEn: 'Dungeon Tower',
    prefix: 'F', floors: 100, bands: DUNGEON_BANDS,
    hpMult: 1, atkSecMult: 1, extraAtkCells: 0,
    bestKey: 'bba_dungeon_max', resultMode: 'dungeon',
    desc: '王道の100階。10階ごとにボス＆チェックポイント',
    descEn: 'The classic 100-floor climb. Boss + checkpoint every 10 floors',
  },
  under: {
    id: 'under', icon: '🕳️', name: '地下ダンジョン', nameEn: 'Underground Depths',
    prefix: 'B', floors: 100, bands: UNDER_BANDS,
    hpMult: 1.25, atkSecMult: 0.85, extraAtkCells: 0, startGarbage: true,
    bestKey: 'bba_dungeon_under_max', resultMode: 'dungeon_under',
    desc: '上級者向け。敵が硬く攻撃も速い。毎フロア、床にガレキが積もっている…',
    descEn: 'For veterans: tougher foes, faster attacks, and rubble litters every floor…',
  },
  heaven: {
    id: 'heaven', icon: '☁️', name: '天国ダンジョン', nameEn: 'Heavenly Ascent',
    prefix: 'H', floors: 100, bands: HEAVEN_BANDS,
    hpMult: 0.9, atkSecMult: 1.15, extraAtkCells: 1, blessing: true,
    bestKey: 'bba_dungeon_heaven_max', resultMode: 'dungeon_heaven',
    desc: '攻撃はゆっくり大ぶり。ボスを倒すたび「天使の祝福」で残機+1',
    descEn: "Slow but heavy attacks. Every boss grants an angel's blessing: +1 life",
  },
  abyss: {
    id: 'abyss', icon: '🌑', name: '深淵ダンジョン', nameEn: 'The Abyss',
    prefix: 'A', floors: 100, bands: ABYSS_BANDS,
    hpMult: 1.7, atkSecMult: 0.6, extraAtkCells: 2, startGarbage: true, garbageBase: 5, garbageDiv: 15,
    bossEvery: 5, finalMult: 4, curses: true, phases: true, unlock: 'tower100',
    bestKey: 'bba_dungeon_abyss_max', resultMode: 'dungeon_abyss',
    desc: '過去最難関。5階ごとにボス、毎フロアに呪い、最深部には三段階の魔神。塔100F制覇者のみ挑める',
    descEn: 'The hardest realm: a boss every 5 floors, a curse on every floor, a three-phase demon at the bottom. Tower conquerors only',
  },
};

function dungeonFloor(f, realm = DUNGEON_REALMS.tower) {
  const bands = realm.bands;
  const band = bands[Math.min(bands.length - 1, Math.floor((f - 1) / 10))];
  const isBoss = f % (realm.bossEvery || 10) === 0;
  const isFinal = f === realm.floors;
  const [emoji, name, nameEn] = isBoss ? band.boss : band.foes[(f - 1) % band.foes.length];
  let hp = Math.round((260 + f * 95 + f * f * 1.15) * realm.hpMult);
  if (isBoss) hp = Math.round(hp * (isFinal ? (realm.finalMult || 3) : 2.1));
  const atkSec = Math.max(4.5, (15 - f * 0.09) * realm.atkSecMult) * (isBoss ? 1.25 : 1);
  const atkCells = Math.min(8, 1 + Math.floor(f / 12) + (isBoss ? 2 : 0) + realm.extraAtkCells);
  return { floor: f, band, isBoss, isFinal, emoji, name, nameEn, hp, atkSec, atkCells };
}

const DUNGEON_PERKS = [
  { id: 'atk',    icon: '💪', name: '攻撃力アップ',     nameEn: 'Attack Up',     desc: '与ダメージ +60%（重ねがけOK）', descEn: '+60% damage (stacks)', w: 5 },
  { id: 'reroll', icon: '🔄', name: 'リロール補充',     nameEn: 'Reroll Refill', desc: 'リロール +3回', descEn: '+3 rerolls', w: 4 },
  { id: 'heal',   icon: '💊', name: '応急修理',         nameEn: 'Field Repair',  desc: '下2行とお邪魔ブロックを消す', descEn: 'Clears the bottom 2 rows + all garbage', w: 4 },
  { id: 'slow',   icon: '⏳', name: 'スロウの呪文',     nameEn: 'Slow Spell',    desc: '敵の攻撃間隔 +25%（重ねがけOK）', descEn: 'Enemy attacks 25% slower (stacks)', w: 3 },
  { id: 'life',   icon: '❤️', name: '追加ライフ',       nameEn: 'Extra Life',    desc: '残機 +1（ボードが埋まっても復活）', descEn: '+1 life (revive when the board fills)', w: 2 },
  { id: 'shield', icon: '🛡️', name: 'コンボプロテクト', nameEn: 'Combo Protect', desc: 'コンボが途切れなくなる（永続）', descEn: 'Your combo never breaks (permanent)', w: 2 },
];

function pickPerks(mode) {
  const bag = DUNGEON_PERKS.filter(p => !(p.id === 'shield' && mode.engine.streakShield));
  const out = [];
  while (out.length < 3 && bag.length) {
    const total = bag.reduce((a, p) => a + p.w, 0);
    let roll = Math.random() * total;
    let idx = bag.length - 1;
    for (let i = 0; i < bag.length; i++) { roll -= bag[i].w; if (roll <= 0) { idx = i; break; } }
    out.push(bag.splice(idx, 1)[0]);
  }
  return out;
}

class DungeonMode {
  constructor(startFloor = 1, realmId = 'tower') {
    this.mode = 'dungeon';
    this.realm = DUNGEON_REALMS[realmId] || DUNGEON_REALMS.tower;
    this.startFloor = Math.max(1, Math.min(this.realm.floors - 9, startFloor));
    this.floor = this.startFloor;
    this.lives = 1;
    this.atkSlow = 1;   // >1 = slower enemy attacks (perk)
  }

  best() { return Number(localStorage.getItem(this.realm.bestKey) || 0); }
  setBest(v) { if (v > this.best()) localStorage.setItem(this.realm.bestKey, String(v)); }

  // Underground floors start half-buried in rubble.
  realmFloorStart() {
    if (!this.realm.startGarbage) return;
    const n = (this.realm.garbageBase || 3) + Math.floor(this.floor / (this.realm.garbageDiv || 25));
    this.engine.addGarbage(n);
    if (this.engine.over && !this.engine.hasAnyMove()) { this.engine.reviveBoard(); }
    else this.engine.over = false;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    // Checkpoint head start: rough stand-in for the perks a fresh run would
    // have accumulated by this floor.
    const k = Math.floor((this.startFloor - 1) / 10);
    if (k > 0) {
      this.engine.scoreMult = 1 + 0.35 * k;
      this.engine.rerolls += k;
      this.lives += Math.floor(k / 3);
    }
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.loadFloor(this.floor, true);
    this.realmFloorStart();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    const R = this.realm;
    toast(k > 0
      ? t(`${R.icon} ${R.prefix}${this.startFloor} から再開！（強化ボーナス付き）`, `${R.icon} Resuming from ${R.prefix}${this.startFloor}! (bonus perks included)`)
      : t(`${R.icon} ${R.name}に挑戦開始！${R.prefix}${R.floors}を目指せ！`, `${R.icon} ${R.nameEn} begins! Reach ${R.prefix}${R.floors}!`), 'announce', 2600);
    countdownOverlay(3, () => {
      v.inputLocked = false;
      this.armAttack();
    }, audio);
  }

  loadFloor(f, silent) {
    this.info = dungeonFloor(f, this.realm);
    this.hp = this.info.hp;
    const v = getView();
    v.setTheme({ ...equippedTheme(), boardId: this.info.band.board });
    audio.playTrack(this.info.band.track);
    $('#bossEmoji').textContent = this.info.emoji;
    $('#bossEmoji').className = 'boss-emoji';
    $('#bossName').textContent = t(`${this.realm.prefix}${f} ${this.info.band.name}：${this.info.name}`, `${this.realm.prefix}${f} ${this.info.band.nameEn}: ${this.info.nameEn}`);
    this.phase = 1;
    this.applyCurse(f);
    this.updateHpBar();
    this.updateHud();
    if (silent) return;
    if (this.info.isFinal) {
      toast(t(`${this.info.emoji} 最深部——${this.info.name}が待ち受ける！！`, `${this.info.emoji} The last floor — ${this.info.nameEn} awaits!!`), 'announce', 3000);
      audio.bossAttack();
      v.shake = 16;
    } else if (this.info.isBoss) {
      toast(t(`⚠️ ボス階！${this.info.emoji} ${this.info.name}が立ちはだかる！`, `⚠️ Boss floor! ${this.info.emoji} ${this.info.nameEn} blocks your path!`), 'announce', 2400);
      audio.bossAttack();
      v.shake = 12;
    } else {
      toast(t(`${this.info.emoji} ${this.info.name}が あらわれた！`, `${this.info.emoji} ${this.info.nameEn} appears!`), '', 1400);
    }
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `${this.realm.icon} ${this.realm.prefix}${this.floor}/${this.realm.floors} ・ ❤️×${this.lives}${this.engine.scoreMult > 1 ? ` ・ 💪×${this.engine.scoreMult.toFixed(1)}` : ''}${this.curse ? ' ・ ☠️' + (ABYSS_CURSES.find(c => c.id === this.curse) || {}).name : ''}`;
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.info.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = this.curse === 'blind' ? '？？？ / ？？？' : `${fmt(Math.max(0, this.hp))} / ${fmt(this.info.hp)}`;
  }

  damageFloat(dmg, big) {
    const span = document.createElement('span');
    span.className = `dmg-float ${big ? 'big' : ''}`;
    span.textContent = `-${fmt(dmg)}`;
    span.style.left = `${30 + Math.random() * 40}%`;
    $('#bossPanel').appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  armAttack() {
    clearInterval(this.atkInt);
    this.nextAtk = Date.now() + this.atkMs();
    this.atkInt = setInterval(() => this.tickAttack(), 100);
  }

  atkMs() { return this.info.atkSec * 1000 * this.atkSlow * (this.curseHaste || 1); }

  tickAttack() {
    if (this.ended || this.perkOpen) return;
    const total = this.atkMs();
    const remain = Math.max(0, this.nextAtk - Date.now());
    $('#bossAtkBar').style.width = `${(1 - remain / total) * 100}%`;
    if (remain <= 0) {
      this.nextAtk = Date.now() + total;
      this.attack();
    }
  }

  attack() {
    if (this.ended || !this.engine || view.inputLocked) return;
    const cells = this.engine.addGarbage(this.info.atkCells);
    audio.bossAttack();
    const em = $('#bossEmoji');
    em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
    }
    view.shake = 10;
    toast(t(`${this.info.emoji} ${this.info.name}の攻撃！`, `${this.info.emoji} ${this.info.nameEn} attacks!`), 'err', 1100);
    if (this.engine.over) this.onTopOut();
  }

  onPlace(result) {
    this.updateHud();
    const dmg = this.curseGreed ? Math.ceil(result.gained / 2) : result.gained;
    this.hp -= dmg;
    this.updateHpBar();
    this.damageFloat(dmg, result.lineCount > 0);
    this.checkPhases();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.floorCleared();
  }

  // ---- Abyss: a curse on every floor + a three-phase final boss ----
  applyCurse(f) {
    clearInterval(this.rainInt);
    const e = this.engine;
    if (this.curse === 'noreroll') e.rerolls = Math.max(e.rerolls, this.savedRerolls || 0);
    this.curse = null; this.curseHaste = 1; this.curseGreed = false;
    e.chaosMini = false; e.chaosBig = false;
    if (!this.realm.curses) return;
    const pick = abyssCurse(f, this.info.isBoss);
    if (!pick || pick.id === 'none') { $('#hudSub').classList.remove('cursed'); return; }
    this.curse = pick.id;
    switch (pick.id) {
      case 'noreroll': this.savedRerolls = e.rerolls; e.rerolls = 0; updateRerollHud(e); break;
      case 'mini': e.chaosMini = true; break;
      case 'big': e.chaosBig = true; break;
      case 'haste': this.curseHaste = 0.7; break;
      case 'greed': this.curseGreed = true; break;
      case 'rain':
        this.rainInt = setInterval(() => {
          if (this.ended || this.perkOpen || getView().inputLocked) return;
          const cells = e.addGarbage(2);
          const v = getView();
          for (const [r, c] of cells) { v.spawnAnim.set(r * 8 + c, v.time); v.particles.burstCell(v.boardX + (c + 0.5) * v.cell, v.boardY + (r + 0.5) * v.cell, v.cell, 9, 'fx_default'); }
          if (e.over) this.onTopOut();
        }, 8000);
        break;
      default: break;
    }
    toast(t(`☠️ ${pick.name}：${pick.desc}`, `☠️ ${pick.nameEn}: ${pick.descEn}`), 'err', 2400);
    this.updateHpBar();
  }

  checkPhases() {
    if (!this.realm.phases || !this.info.isFinal || this.hp <= 0) return;
    const pct = this.hp / this.info.hp;
    const phase = pct < 0.33 ? 3 : pct < 0.66 ? 2 : 1;
    if (phase > (this.phase || 1)) {
      this.phase = phase;
      this.atkSlow *= 0.72;
      const cells = this.engine.addGarbage(phase === 3 ? 6 : 4);
      const v = getView();
      for (const [r, c] of cells) v.spawnAnim.set(r * 8 + c, v.time);
      v.shake = 18; v.screenFlash = 0.5; audio.bossAttack();
      $('#bossEmoji').classList.add('boss-atk');
      toast(phase === 3
        ? t(`${this.info.emoji} ${this.info.name}が真の姿に…！！攻撃がさらに加速！`, `${this.info.emoji} ${this.info.nameEn} reveals its true form!! Even faster attacks!`)
        : t(`${this.info.emoji} ${this.info.name}が第二形態に！攻撃が加速する！`, `${this.info.emoji} ${this.info.nameEn} enters phase 2! Attacks speed up!`), 'announce', 2800);
      this.armAttack();
      if (this.engine.over) this.onTopOut();
    }
  }

  floorCleared() {
    clearInterval(this.atkInt);
    audio.bossDefeated();
    $('#bossEmoji').classList.add('boss-dead');
    // Progressive best: floors cleared count even if the run ends later.
    this.setBest(this.floor);
    if (this.floor >= this.realm.floors) { this.finish(true); return; }
    confettiBurst(this.info.isBoss ? 45 : 12);
    if (this.info.isBoss) {
      toast(t(`🎉 ボス撃破！チェックポイント到達（次回から${this.realm.prefix}${this.floor + 1}で再開可能）`, `🎉 Boss down! Checkpoint reached (you can restart from ${this.realm.prefix}${this.floor + 1})`), 'announce', 3000);
      if (this.realm.blessing) {
        this.lives++;
        setTimeout(() => toast(t('👼 天使の祝福！残機 +1', "👼 An angel's blessing! +1 life"), 'announce', 2400), 1200);
      }
    }
    view.inputLocked = true;
    this.perkOpen = true;
    this.offerPerk(() => {
      this.perkOpen = false;
      this.floor++;
      this.loadFloor(this.floor);
      this.realmFloorStart();
      const e = this.engine;
      // Mercy: never enter a floor without a legal move.
      if (!e.hasAnyMove()) { e.reviveBoard(); view.reviveFlash(); }
      else e.over = false;
      view.inputLocked = false;
      this.updateHud();
      this.armAttack();
    });
  }

  offerPerk(next) {
    const choices = pickPerks(this);
    const m = showModal(`
      <h2>${this.info.isBoss ? t('👑 ボス撃破！', '👑 Boss defeated!') : t(`✅ F${this.floor} クリア！`, `✅ Floor ${this.floor} cleared!`)}</h2>
      <p class="muted center" style="margin-bottom:10px">${t('ごほうびを1つ選ぼう', 'Pick one reward')}</p>
      <div class="form-col">
        ${choices.map(p => `
          <button class="btn btn-ghost perk-btn" data-perk="${p.id}">
            <span class="perk-icon">${p.icon}</span>
            <span class="perk-body"><b>${t(p.name, p.nameEn)}</b><small>${t(p.desc, p.descEn)}</small></span>
          </button>`).join('')}
      </div>`, { dismissable: false });
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => { this.applyPerk(b.dataset.perk); closeModal(); next(); };
    });
    // Autopilot keeps climbing on its own — it grabs a perk and moves on.
    if (autopilot.on && autopilot.autoPerks !== false) {
      setTimeout(() => {
        const b = m.querySelector('[data-perk]');
        if (b && document.body.contains(b)) b.click();
      }, 800);
    }
  }

  applyPerk(id) {
    const e = this.engine;
    audio.coin();
    switch (id) {
      case 'atk':
        e.scoreMult = Math.round((e.scoreMult + 0.6) * 100) / 100;
        break;
      case 'reroll':
        e.rerolls += 3;
        updateRerollHud(e);
        break;
      case 'heal': {
        for (let i = 0; i < 64; i++) if (e.grid[i] === 9) e.grid[i] = 0;
        for (let r = 6; r < 8; r++) for (let c = 0; c < 8; c++) e.grid[r * 8 + c] = 0;
        view.reviveFlash();
        break;
      }
      case 'slow':
        this.atkSlow *= 1.25;
        break;
      case 'life':
        this.lives++;
        break;
      case 'shield':
        e.streakShield = true;
        break;
    }
    this.updateHud();
  }

  onTopOut() {
    if (this.ended || this.perkOpen) return;
    if (autoRescue()) return;   // autopilot 5.0 guard — before spending a life
    if (this.lives > 1) {
      this.lives--;
      this.engine.reviveBoard();
      getView().reviveFlash();
      toast(t(`❤️ 残機を使って復活！のこり×${this.lives}`, `❤️ Life used — revived! ×${this.lives} left`), 'announce', 2200);
      this.updateHud();
    } else {
      this.finish(false);
    }
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    clearInterval(this.rainInt);
    getView().inputLocked = true;
    const R = this.realm;
    const cleared = won ? R.floors : this.floor - 1;
    this.setBest(cleared);
    if (won) {
      audio.victory();
      confettiBurst(100);
      $('#bossEmoji').classList.add('boss-dead');
    } else if (!this.aborted) {
      audio.gameOver();
    }
    const e = this.engine;
    const rewards = await submitResult({
      mode: R.resultMode, floor: cleared, score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won,
      // Floors beaten in THIS run (missions count progress, not absolute depth).
      floors: Math.max(0, cleared - this.startFloor + 1),
    });
    if (rewards && rewards.badge === 'dungeon') {
      setTimeout(() => { toast(t('🏰 バッジ「百塔踏破」を獲得！+500💎', '🏰 Badge earned: Hundred-Floor Conqueror! +500💎'), 'announce', 6000); confettiBurst(80); }, 1200);
    }
    const cp = Math.floor(cleared / 10) * 10 + 1;
    const P = R.prefix;
    const banner = won ? t(`🏆 ${R.name} 完全制覇！！`, `🏆 ${R.nameEn} conquered!!`) : this.aborted ? t(`🚪 リタイア（${P}${this.floor}）`, `🚪 Retired (${P}${this.floor})`) : t(`${P}${this.floor} で力尽きた…`, `Fell on ${P}${this.floor}…`);
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('クリアした階', 'Floors cleared')}</span><b>${won ? t(`全${R.floors}階！`, `All ${R.floors}!`) : `${P}${fmt(cleared)}`}</b></div>
        <div class="rs-row"><span>${t('総ダメージ', 'Total damage')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t('次回の再開地点', 'Next run resumes at')}</span><b>${P}${cp}</b></div>`}
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-dungeon" id="rAgain">${won ? t('もう一周', 'Run it again') : t(`${P}${cp}から再挑戦`, `Retry from ${P}${cp}`)}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startDungeon(won ? 1 : cp, R.id); };
  }

  quit() {
    if (this.ended) return;
    const m = showModal(`
      <h2>${t('🏰 ダンジョンから撤退しますか？', '🏰 Retreat from the dungeon?')}</h2>
      <p class="muted center" style="margin-bottom:10px">${t('ここまでにクリアした階は記録されます', 'Floors cleared so far will be saved')}</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="dqResume">${t('続ける', 'Keep going')}</button>
        <button class="btn btn-ai" id="dqQuit">${t('撤退する', 'Retreat')}</button>
      </div>`);
    m.querySelector('#dqResume').onclick = () => { audio.click(); closeModal(); };
    m.querySelector('#dqQuit').onclick = () => {
      audio.click();
      closeModal();
      this.aborted = true;
      this.finish(false);
    };
  }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    clearInterval(this.rainInt);
    $('#bossPanel').classList.add('hidden');
  }
}

export function startDungeon(startFloor = 1, realmId = 'tower') {
  if (currentMode) currentMode.destroy();
  currentMode = new DungeonMode(startFloor, realmId);
  window.__bbaMode = currentMode;
  currentMode.start();
}

export { DUNGEON_REALMS };

// ---------------------------------------------------------------------------
// Chaos mode (limited-time event, admin-controlled): the rules mutate on an
// interval the player chooses. Duration is also player-chosen (min/sec).
// Pure mayhem, bonus coins.
// ---------------------------------------------------------------------------

const CHAOS_BOARDS = ['board_default', 'board_ocean', 'board_sunset', 'board_forest', 'board_galaxy', 'board_oni', 'board_kami', 'board_sakura', 'board_volcano'];
const CHAOS_MODS = {
  fever:   t('🔥 フィーバー！スコア3倍！', '🔥 Fever! 3x score!'),
  rain:    t('☔ お邪魔ブロックの雨！', '☔ Garbage rain!'),
  giant:   t('🧱 巨大ブロック時代！', '🧱 Age of giant blocks!'),
  mini:    t('🐜 ミニブロック時代！', '🐜 Age of mini blocks!'),
  heaven:  t('✨ 天の恵み！全消し！', '✨ Divine gift! Board cleared!'),
  shuffle: t('🌀 大シャッフル！', '🌀 Grand shuffle!'),
  reroll:  t('🔄 リロール無限！', '🔄 Infinite rerolls!'),
  bomb:    t('💣 爆撃！ボードに大穴！', '💣 Bombing run! Holes everywhere!'),
  freeze:  t('⏱️ 時間停止！残り+10秒！', '⏱️ Time freeze! +10 seconds!'),
  gravity: t('🧲 重力発生！ブロック落下！', '🧲 Gravity! Blocks fall!'),
  cleanse: t('🧹 お邪魔ブロック浄化！', '🧹 Garbage purged!'),
  shield:  t('🛡️ コンボプロテクト！', '🛡️ Combo protect!'),
};

class ChaosMode extends VersusBase {
  constructor(opts = {}) {
    super();
    this.mode = 'chaos';
    this.duration = Math.max(30, Math.min(1800, Math.floor(Number(opts.duration) || 120)));
    this.interval = Math.max(5, Math.min(60, Math.floor(Number(opts.interval) || 15)));
  }

  start() {
    this.setupHud(this.duration);
    $('#oppPanel').classList.add('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    this.modCount = 0;
    const v = getView();
    v.setTheme({ ...equippedTheme(), boardId: 'board_galaxy' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = () => this.onPlace();
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('boss');
    toast(t(`🌪️ カオスモード！${this.interval}秒ごとにルールが変わるぞ！`, `🌪️ Chaos Mode! The rules change every ${this.interval} seconds!`), 'announce', 3000);

    countdownOverlay(3, () => {
      v.inputLocked = false;
      this.startTimer(() => this.finish());
      this.nextModifier();
      this.modInt = setInterval(() => this.nextModifier(), this.interval * 1000);
      // slim progress bar counting down to the next rule mutation
      $('#chaosBar').classList.remove('hidden');
      this.barInt = setInterval(() => {
        const remain = Math.max(0, (this.nextModAt || 0) - Date.now());
        $('#chaosBarFill').style.width = `${(remain / (this.interval * 1000)) * 100}%`;
      }, 100);
    }, audio);
  }

  nextModifier() {
    if (this.ended) return;
    const e = this.engine;
    this.nextModAt = Date.now() + this.interval * 1000;
    this.modCount++;
    // clear the previous modifier
    clearInterval(this.rainInt);
    e.scoreMult = 1;
    e.chaosBig = false;
    e.chaosMini = false;
    e.streakShield = false;
    if (e.infiniteReroll) { e.infiniteReroll = false; updateRerollHud(e); }

    const ids = Object.keys(CHAOS_MODS);
    let id = ids[(Math.random() * ids.length) | 0];
    if (id === this.currentMod) id = ids[(ids.indexOf(id) + 1) % ids.length];
    // freeze makes no sense twice in a row and cleanse needs garbage to shine —
    // reroll them once if they'd be a dud.
    if (id === 'cleanse' && !e.grid.includes(9)) id = ids[(Math.random() * ids.length) | 0];
    this.currentMod = id;
    this.modName = CHAOS_MODS[id];

    // visual chaos: new random stage + flash + shake
    view.setTheme({ ...equippedTheme(), boardId: CHAOS_BOARDS[(Math.random() * CHAOS_BOARDS.length) | 0] });
    view.screenFlash = 0.3;
    view.shake = 10;
    audio.combo(8);
    toast(this.modName, 'announce', 2400);
    $('#hudSub').textContent = this.modName;

    switch (id) {
      case 'fever':
        e.scoreMult = 3;
        break;
      case 'rain':
        this.rainInt = setInterval(() => {
          if (this.ended || !view || view.inputLocked || view.drag) return;
          const cells = e.addGarbage(2);
          for (const [r, c] of cells) {
            view.spawnAnim.set(r * 8 + c, view.time);
            view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
          }
          audio.place();
          if (e.over) this.onTopOut();
        }, 3000);
        break;
      case 'giant':
        e.chaosBig = true;
        if (!view.drag) e.hand = e.hand.map(p => (p ? e.drawPiece() : null));
        break;
      case 'mini':
        e.chaosMini = true;
        if (!view.drag) e.hand = e.hand.map(p => (p ? e.drawPiece() : null));
        break;
      case 'heaven':
        e.grid.fill(0);
        view.reviveFlash();
        confettiBurst(30);
        break;
      case 'shuffle': {
        const values = [];
        for (let i = 0; i < 64; i++) { if (e.grid[i]) values.push(e.grid[i]); }
        e.grid.fill(0);
        const spots = [...Array(64).keys()];
        for (const v2 of values) {
          const k = spots.splice((Math.random() * spots.length) | 0, 1)[0];
          e.grid[k] = v2;
          view.spawnAnim.set(k, view.time);
        }
        view.shake = 14;
        if (!e.hasAnyMove()) { e.grid.fill(0); }   // shuffle never kills you
        break;
      }
      case 'reroll':
        // TRULY infinite while this modifier is active — the button never runs out.
        e.infiniteReroll = true;
        updateRerollHud(e);
        break;
      case 'bomb': {
        // two friendly 3x3 explosions carve holes in the board
        for (let b = 0; b < 2; b++) {
          const cr = 1 + ((Math.random() * 6) | 0), cc = 1 + ((Math.random() * 6) | 0);
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const r = cr + dr, c = cc + dc;
            const k = r * 8 + c;
            if (e.grid[k]) {
              e.grid[k] = 0;
              view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 12, 'fx_default');
            }
          }
        }
        audio.bossAttack();
        view.shake = 14;
        break;
      }
      case 'freeze':
        this.endAt += 10000;
        this.timeLeft += 10;
        this.updateTimerHud();
        break;
      case 'gravity': {
        // every column falls to the bottom
        for (let c = 0; c < 8; c++) {
          const col = [];
          for (let r = 0; r < 8; r++) { const cv = e.grid[r * 8 + c]; if (cv) col.push(cv); }
          for (let r = 0; r < 8; r++) {
            const k = r * 8 + c;
            const nv = r < 8 - col.length ? 0 : col[r - (8 - col.length)];
            if (e.grid[k] !== nv) { e.grid[k] = nv; if (nv) view.spawnAnim.set(k, view.time); }
          }
        }
        view.shake = 12;
        if (!e.hasAnyMove()) { e.grid.fill(0); }   // gravity never kills you
        break;
      }
      case 'cleanse': {
        let n = 0;
        for (let i = 0; i < 64; i++) if (e.grid[i] === 9) { e.grid[i] = 0; n++; }
        if (n > 0) {
          view.reviveFlash();
        } else {
          e.score += 300;   // no garbage? take a consolation bonus
          this.updateMyHud(e);
          view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize / 2, '+300', '#43d9e8', 1.2);
        }
        break;
      }
      case 'shield':
        e.streakShield = true;
        break;
    }
  }

  onPlace() {
    this.updateMyHud(this.engine);
    $('#hudSub').textContent = this.modName || t('カオス', 'Chaos');
  }

  onTopOut() {
    if (this.ended) return;
    if (autoRescue()) return;   // autopilot 5.0 guard — keeps the combo streak alive
    toast(t('ボードリセット！スコアは維持されます', 'Board reset! Your score is kept'), '', 1600);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    clearInterval(this.modInt);
    clearInterval(this.rainInt);
    clearInterval(this.barInt);
    $('#chaosBar').classList.add('hidden');
    getView().inputLocked = true;
    audio.victory();
    confettiBurst(40);
    const e = this.engine;
    const prevBest = Number(localStorage.getItem('bba_chaos_best') || 0);
    const isBest = e.score > prevBest;
    if (isBest) localStorage.setItem('bba_chaos_best', String(e.score));
    const rewards = await submitResult({
      mode: 'chaos', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    const m = showModal(`
      <div class="result-banner win">${isBest ? t('🌪️ カオス新記録！！', '🌪️ New chaos record!!') : t('🌪️ カオス終了！', '🌪️ Chaos over!')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}${isBest ? ' 👑' : ''}</b></div>
        <div class="rs-row"><span>${t('自己ベスト', 'Personal best')}</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>${t('発動したルール', 'Rules triggered')}</span><b>${t(`${fmt(this.modCount)}回`, `${fmt(this.modCount)}`)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewards ? `<div class="rs-row"><span>${t('🎉 イベントボーナス', '🎉 Event bonus')}</span><b>${t('コイン1.5倍！', '1.5x coins!')}</b></div>` : ''}
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-chaos" id="rAgain">${t('もう一回！', 'One more!')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startChaos({ duration: this.duration, interval: this.interval }); };
  }

  quit() {
    if (this.ended) return;
    // Mid-run cancel: let the player abort (no record), cash out early, or resume.
    const m = showModal(`
      <h2>${t('🌪️ カオスモードを中断しますか？', '🌪️ Stop the chaos run?')}</h2>
      <p class="muted center" style="margin-bottom:10px">${t('「中断する」は記録なしでメニューに戻ります。<br>「終了して集計」はここまでのスコアで報酬を受け取ります。', '"Abort" returns to the menu with no record.<br>"Finish &amp; score" collects rewards for your score so far.')}</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="cqResume">${t('続ける', 'Keep playing')}</button>
        <button class="btn btn-ghost" id="cqAbort">${t('中断する（記録なし）', 'Abort (no record)')}</button>
        <button class="btn btn-chaos" id="cqFinish">${t('終了して集計', 'Finish & score')}</button>
      </div>`);
    m.querySelector('#cqResume').onclick = () => { audio.click(); closeModal(); };
    m.querySelector('#cqAbort').onclick = () => {
      audio.click();
      closeModal();
      this.ended = true;
      this.destroy();
      toast(t('🌪️ カオスモードを中断しました（記録なし）', '🌪️ Chaos run aborted (no record)'), '', 2200);
      endToMenu();
    };
    m.querySelector('#cqFinish').onclick = () => { audio.click(); closeModal(); this.finish(); };
  }

  destroy() {
    this.ended = true;
    this.stopTimer();
    clearInterval(this.modInt);
    clearInterval(this.rainInt);
    clearInterval(this.barInt);
    $('#chaosBar').classList.add('hidden');
  }
}

export function startChaos(opts) {
  if (currentMode) currentMode.destroy();
  currentMode = new ChaosMode(opts);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Online: 1v1 duel / 2v2 team / custom rooms — all via the battle server.
// ---------------------------------------------------------------------------

class OnlineMode extends VersusBase {
  constructor(kind) {
    super();
    this.mode = 'pvp';
    this.kind = kind;               // 'duel' | 'team' | 'custom'
    this.client = new BattleClient();
  }

  async start() {
    if (this.kind === 'custom') {
      showScreen('room');
      this.showJoinView();
      this.wireRoomButtons();
    } else {
      showScreen('matchmaking');
      $('#mmStatus').textContent = t('サーバーに接続中…', 'Connecting to server…');
    }
    try {
      const hello = await this.client.connect(localStorage.getItem('bba_guest_name') || undefined);
      this.onlineCount = hello.online;
      $('#mmOnline').textContent = hello.online;
      this.showQueueCount(hello.queueing);
      if (!session.user) localStorage.setItem('bba_guest_name', hello.name);
    } catch (err) {
      toast(err.message, 'err');
      endToMenu();
      return;
    }

    this.client
      .on('match_found', msg => this.onMatchFound(msg))
      .on('opp_state', msg => this.onOppState(msg))
      .on('result', msg => this.onResult(msg))
      .on('announce', msg => toast(`📢 ${msg.message}`, 'announce', 5000))
      .on('room_update', msg => this.onRoomUpdate(msg))
      .on('room_error', msg => { audio.error(); toast(trServer(msg.error), 'err'); })
      .on('raid_state', msg => this.onRaidState(msg))
      .on('raid_attack', msg => this.onRaidAttack(msg))
      .on('coop_state', msg => this.onCoopState(msg))
      .on('coop_reject', msg => this.onCoopReject(msg))
      .on('coop_partner_left', () => toast(t('相棒が離脱しました。残りはサーバーが代打します！', 'Your partner left — the server will play their turns!'), 'err', 4000))
      .on('emote', msg => this.showEmote(msg.slot, msg.emoji))
      .on('tourney_state', msg => this.onTourneyState(msg))
      .on('tourney_champion', () => confettiBurst(70))
      .on('royale_found', msg => this.onRoyaleFound(msg))
      .on('royale_state', msg => this.onRoyaleState(msg))
      .on('royale_cut', msg => this.onRoyaleCut(msg))
      .on('royale_result', msg => this.onRoyaleResult(msg))
      .on('online', msg => {
        this.onlineCount = msg.online;
        const el = $('#mmOnline');
        if (el) el.textContent = msg.online;
        this.showQueueCount(msg.queueing);
      })
      .on('close', () => {
        if (this.ended) return;
        if (this.inMatch || this.kind === 'custom' || this.kind === 'tourney') {
          toast(t('サーバーとの接続が切れました', 'Lost connection to the server'), 'err');
          this.ended = true;
          this.destroy();
          endToMenu();
        }
      });

    if (this.kind !== 'custom') {
      $('#mmStatus').textContent = this.kind === 'team'
        ? t('チームメンバーを探しています…', 'Looking for teammates…')
        : this.kind === 'raid'
        ? t('レイドパーティを募集しています…', 'Gathering a raid party…')
        : this.kind === 'tourney'
        ? t('トーナメント参加者を募集しています…', 'Gathering tournament entrants…')
        : this.kind === 'royale'
        ? t('バトルロイヤル参加者を募集しています…', 'Gathering battle-royale contenders…')
        : this.kind === 'coop'
        ? t('いっしょに遊ぶ相棒を探しています…', 'Looking for a co-op partner…')
        : t('対戦相手を探しています…', 'Looking for an opponent…');
      $('#mmSub').innerHTML = t('オンライン: <span id="mmOnline">-</span>人 ・ 対戦相手を検索中…',
        'Online: <span id="mmOnline">-</span> players ・ searching…');
      $('#mmOnline').textContent = this.onlineCount ?? '-';
      this.client.queue(this.kind);
    }
  }

  // People waiting in matchmaking right now (crowd simulation + real queues).
  showQueueCount(n) {
    const el = $('#mmQueue');
    if (!el) return;
    if (typeof n !== 'number') { el.textContent = ''; return; }
    el.textContent = t(`🧑‍🤝‍🧑 いま ${n} 人がマッチング待ち`, `🧑‍🤝‍🧑 ${n} players queueing right now`);
  }

  // ---- custom room lobby ----

  showJoinView() {
    $('#roomJoin').classList.remove('hidden');
    $('#roomLobby').classList.add('hidden');
  }

  wireRoomButtons() {
    $('#btnCreateRoom').onclick = () => { audio.click(); this.client.createRoom({}); };
    const join = () => {
      const code = $('#roomCodeInput').value.trim();
      if (code.length !== 4) { toast(t('4文字のコードを入力してください', 'Enter the 4-letter code'), 'err'); return; }
      audio.click();
      this.client.joinRoom(code);
    };
    $('#btnJoinRoom').onclick = join;
    $('#roomCodeInput').onkeydown = e => { if (e.key === 'Enter') join(); };
    $('#btnLeaveRoom').onclick = () => { audio.click(); this.client.leaveRoom(); this.showJoinView(); };
    $('#btnStartRoom').onclick = () => { audio.click(); this.client.startRoom(); };
    $('#btnRoomBack').onclick = () => { audio.click(); this.quit(); };
  }

  onRoomUpdate(msg) {
    this.roomInfo = msg;
    $('#roomJoin').classList.add('hidden');
    $('#roomLobby').classList.remove('hidden');
    $('#roomCodeLabel').textContent = msg.code;

    $('#roomPlayers').innerHTML = msg.players.map((p, i) => `
      <div class="room-player ${p.isYou ? 'me' : ''}">
        <span class="rp-team">${(msg.settings.mode || (msg.settings.team ? 'team' : 'duel')) === 'coop' ? '🤝' : msg.settings.team ? (i < 2 ? '🟦' : '🟥') : '⚔️'}</span>
        <span class="rp-name">${escapeHtml(p.name)}${p.isYou ? t('（あなた）', ' (you)') : ''}</span>
        ${p.isHost ? `<span class="rp-host">${t('👑 ホスト', '👑 Host')}</span>` : ''}
      </div>`).join('');

    const host = msg.youAreHost;
    const s = msg.settings;
    const mode = s.mode || (s.team ? 'team' : 'duel');
    const dis = host ? '' : 'disabled';
    $('#roomSettings').innerHTML = `
      <div class="settings-row ${mode === 'coop' ? 'hidden' : ''}"><label>${t('⏱️ 試合時間', '⏱️ Match time')}</label><div class="seg" data-rs="duration">
        ${[60, 120, 180].map(d => `<button data-v="${d}" ${s.duration === d ? 'class="active"' : ''} ${dis}>${d / 60}${t('分', 'min')}</button>`).join('')}
      </div></div>
      <div class="settings-row"><label>${t('👥 モード', '👥 Mode')}</label><div class="seg" data-rs="mode">
        ${[['duel', '1v1'], ['team', t('2v2チーム', '2v2 Team')], ['coop', t('🤝 協力', '🤝 Co-op')]].map(([v, l]) =>
          `<button data-v="${v}" ${mode === v ? 'class="active"' : ''} ${dis}>${l}</button>`).join('')}
      </div></div>
      ${mode === 'coop' ? `<p class="muted center" style="font-size:11px">${t('🤝 2人で1つの盤面を交互に操作。ボット補充ONなら1人でも遊べます', '🤝 Two players share one board, taking turns. Bot fill lets you play solo')}</p>` : ''}
      <div class="settings-row"><label>${t('🤖 ボット補充', '🤖 Fill with bots')}</label><input type="checkbox" id="rsBotFill" ${s.botFill ? 'checked' : ''} ${dis}></div>
      <div class="settings-row"><label>${t('💪 ボットの強さ', '💪 Bot strength')}</label><div class="seg" data-rs="botLevel">
        ${[['random', '🎲'], ['easy', t('弱', 'Easy')], ['normal', t('中', 'Mid')], ['hard', t('強', 'Hard')], ['oni', t('鬼', 'Oni')]].map(([v, l]) =>
          `<button data-v="${v}" ${s.botLevel === v ? 'class="active"' : ''} ${dis}>${l}</button>`).join('')}
      </div></div>`;
    $('#btnStartRoom').classList.toggle('hidden', !host);

    if (host) {
      $('#roomSettings').querySelectorAll('.seg button').forEach(b => {
        b.onclick = () => {
          const key = b.parentElement.dataset.rs;
          let v = b.dataset.v;
          if (key === 'duration') v = Number(v);
          audio.click();
          this.client.setRoom({ [key]: v });
        };
      });
      const bf = $('#rsBotFill');
      if (bf) bf.onchange = e => this.client.setRoom({ botFill: e.target.checked });
    }
  }

  // ---- battle royale (100 players, score race with cuts) ----

  onRoyaleFound(msg) {
    if (this.inMatch || this.ended) return;
    closeModal();
    this.inMatch = true;
    this.isRoyale = true;
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);
    this.timeLeft = msg.duration;
    this.updateTimerHud();
    const v = getView();
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = () => this.updateRoyaleHud();
    v.onGameOver = () => this.onTopOut();
    this.updateRoyaleHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('pixel');
    toast(t('💯 バトルロイヤル開始！100人の頂点を目指せ！', '💯 Battle Royale! Outscore 99 rivals!'), 'announce', 2600);
    countdownOverlay(msg.countdown || 3, () => {
      v.inputLocked = false;
      this.startTimer(() => { getView().inputLocked = true; });   // the server calls the finish
      this.stateInt = setInterval(() => this.pushState(), 900);
    }, audio);
  }

  updateRoyaleHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = this.royaleRank
      ? `RANK ${this.royaleRank}/${this.royaleAlive}` : 'SCORE';
  }

  onRoyaleState(msg) {
    this.royaleRank = msg.rank;
    this.royaleAlive = msg.alive;
    this.updateRoyaleHud();
    if (msg.nextCutIn != null && msg.nextCutIn <= 5 && msg.alive > msg.nextKeep
      && (!this.cutWarnedAt || Date.now() - this.cutWarnedAt > 8000)) {
      this.cutWarnedAt = Date.now();
      toast(t(`⚠️ まもなく足切り！上位${msg.nextKeep}人だけ生き残れる`, `⚠️ Cut incoming! Only the top ${msg.nextKeep} survive`), 'err', 2000);
    }
  }

  onRoyaleCut(msg) {
    audio.bossAttack();
    if (view) view.shake = 8;
    toast(t(`⚔️ 足切り！${msg.eliminated}人脱落 — 残り${msg.alive}人`, `⚔️ The cut! ${msg.eliminated} eliminated — ${msg.alive} remain`), 'announce', 2400);
  }

  onRoyaleResult(msg) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.stateInt);
    this.stopTimer();
    getView().inputLocked = true;
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    const win = msg.placement === 1;
    if (win) { audio.victory(); confettiBurst(90); }
    else if (msg.placement <= 10) audio.victory();
    else audio.gameOver();
    if (msg.rewards && msg.rewards.badge === 'royale') {
      setTimeout(() => toast(t('💯 バッジ「百人の頂点」を獲得！+150💎', '💯 Badge earned: Apex of 100! +150💎'), 'announce', 5000), 1200);
    }
    const banner = win ? t('👑 1位！VICTORY!', '👑 #1 VICTORY!') : `#${msg.placement} / ${msg.players}`;
    const m = showModal(`
      <div class="result-banner ${win ? 'win' : msg.placement <= 10 ? 'draw' : 'lose'}">${banner}</div>
      ${msg.placement <= 10 && !win ? `<p class="muted center">${t('TOP10入り！すごい！', 'Top 10 finish — amazing!')}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('最終順位', 'Final placement')}</span><b>#${msg.placement} / ${msg.players}</b></div>
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(msg.score)}</b></div>
        ${msg.top && msg.top[0] ? `<div class="rs-row"><span>🥇 ${escapeHtml(msg.top[0].name)}</span><b>${fmt(msg.top[0].score)}</b></div>` : ''}
        ${rewardsRows(msg.rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-oni" id="rAgain">${t('もう一度参戦', 'Drop in again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline('royale'); };
  }

  // ---- tournament bracket (between rounds) ----

  tourneyRoundName(pairCount) {
    return pairCount === 4 ? t('準々決勝', 'Quarterfinal')
      : pairCount === 2 ? t('準決勝', 'Semifinal')
      : t('決勝', 'Final');
  }

  onTourneyState(msg) {
    if (this.ended) return;
    this.inMatch = false;   // between rounds — ready for the next match_found
    const mark = e => `${e.you ? '⭐<b>' : ''}${escapeHtml(e.name)}${e.you ? '</b>' : ''}${e.rating != null ? ` <small class="muted">R${e.rating}</small>` : ''}`;
    const rows = msg.pairs.map(p =>
      `<div class="rs-row"><span>${mark(p[0])}</span><span style="opacity:.6">⚔️</span><span>${mark(p[1])}</span></div>`).join('');
    showModal(`
      <h2>🏆 ${t('トーナメント', 'Tournament')} — ${this.tourneyRoundName(msg.pairs.length)}</h2>
      <div class="result-stats">${rows}</div>
      <p class="muted center" style="margin-top:8px">${t('まもなく対戦開始…', 'Match starting soon…')}</p>`, { dismissable: false });
    audio.click();
  }

  // ---- match ----

  // ---- 🤝 Co-op: two players, one board, alternating turns -----------------
  //
  // The server owns the board. We keep a mirror Engine on the same seed and
  // replay each confirmed move, so placements animate exactly like solo ones
  // while staying byte-identical on both clients.

  setupCoop(msg) {
    this.isCoop = true;
    const me = msg.players.find(p => p.isYou);
    const partner = msg.players.find(p => !p.isYou);
    this.mySlot = msg.you.slot;
    this.partnerName = partner ? partner.name : '???';
    this.coopTurn = 0;
    this.coopTurnRemain = 0;
    this.coopTurnMs = 15000;

    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#coopBar').classList.remove('hidden');
    showItemBar(false);   // shared board: no boosters, no ultimates

    const v = getView();
    v.setTheme(equippedTheme());
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onGameOver = () => { /* the server decides when a co-op run is over */ };
    v.onPlace = () => this.updateCoopHud();
    // Hand every drop to the server instead of applying it locally.
    v.onIntentPlace = (index, row, col) => {
      if (this.coopTurn !== this.mySlot || this.ended) {
        audio.error();
        toast(t(`いまは${this.partnerName}さんの番です`, `It's ${this.partnerName}'s turn`), 'err', 1200);
        return true;
      }
      this.client.send({ type: 'coop_place', index, row, col });
      v.inputLocked = true;          // lock until the server confirms
      return true;
    };
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('solo');
    this.updateCoopHud();

    const emoteBtn = $('#btnEmote');
    emoteBtn.classList.remove('hidden');
    emoteBtn.onclick = () => this.toggleEmotePicker();

    toast(t(`🤝 ${this.partnerName}さんと協力プレイ！交互にピースを置いて高得点を狙おう`,
      `🤝 Co-op with ${this.partnerName}! Take turns placing pieces for a shared high score`), 'announce', 4000);

    countdownOverlay(msg.countdown || 3, () => {
      if (this.ended) return;
      this.coopStarted = true;
      this.applyCoopTurn();
      this.coopInt = setInterval(() => this.tickCoopBar(), 120);
    }, audio);
  }

  onCoopState(msg) {
    if (this.ended || !this.engine) return;
    // Replay the confirmed move on the mirror board.
    if (msg.move) {
      const result = this.engine.place(msg.move.index, msg.move.row, msg.move.col);
      if (result) {
        getView().applyResult(result);
        if (msg.move.slot !== this.mySlot) {
          const el = $('#hudSub');
          el.classList.remove('coop-flash'); void el.offsetWidth; el.classList.add('coop-flash');
        }
      }
    }
    // Authoritative resync — cheap insurance against any drift.
    if (Array.isArray(msg.grid)) {
      const mine = this.engine.snapshot();
      if (msg.grid.some((v, i) => v !== mine[i])) {
        for (let i = 0; i < msg.grid.length; i++) this.engine.grid[i] = msg.grid[i];
        console.warn('[coop] board resynced from server');
      }
    }
    if (typeof msg.score === 'number') this.engine.score = msg.score;
    this.coopTurn = msg.turn;
    this.coopTurnRemain = msg.turnRemain || 0;
    this.coopTurnMs = msg.turnMs || 15000;
    this.coopTurnAt = Date.now();
    this.coopMoves = msg.moves || 0;
    this.applyCoopTurn();
    this.updateCoopHud();
  }

  onCoopReject(msg) {
    if (!this.engine) return;
    if (Array.isArray(msg.grid)) {
      for (let i = 0; i < msg.grid.length; i++) this.engine.grid[i] = msg.grid[i];
    }
    this.coopTurn = msg.turn;
    this.applyCoopTurn();
    audio.putback();
  }

  applyCoopTurn() {
    if (!this.coopStarted || this.ended) return;
    getView().inputLocked = this.coopTurn !== this.mySlot;
  }

  updateCoopHud() {
    if (!this.engine) return;
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const mine = this.coopTurn === this.mySlot;
    $('#hudSub').textContent = this.engine.streak >= 2
      ? t(`${this.engine.streak} コンボ！`, `${this.engine.streak} COMBO!`)
      : t('🤝 きょうりょくスコア', '🤝 SHARED SCORE');
    const label = $('#coopTurnLabel');
    label.textContent = mine
      ? t('🎯 あなたの番！', '🎯 Your turn!')
      : t(`⏳ ${this.partnerName}さんの番…`, `⏳ ${this.partnerName} is thinking…`);
    label.classList.toggle('mine', mine);
  }

  tickCoopBar() {
    if (this.ended) return;
    const total = this.coopTurnMs || 15000;
    const elapsed = Date.now() - (this.coopTurnAt || Date.now());
    const remain = Math.max(0, (this.coopTurnRemain || 0) - elapsed);
    const fill = $('#coopTurnFill');
    fill.style.width = `${Math.max(0, Math.min(100, (remain / total) * 100))}%`;
    fill.classList.toggle('urgent', remain < 4000 && this.coopTurn === this.mySlot);
  }

  onMatchFound(msg) {
    if (this.inMatch || this.ended) return;   // guard against duplicates
    closeModal();                             // clear the bracket between rounds
    this.inMatch = true;
    this.matchInfo = msg;
    this.you = msg.you;
    this.isTeam = msg.mode === 'team';
    this.isRaid = msg.mode === 'raid';
    if (msg.mode === 'coop') { this.setupCoop(msg); return; }

    const others = msg.players.filter(p => !p.isYou).map(p => ({
      slot: p.slot,
      name: `${p.name}${p.rating != null ? ` (${rankOf(p.rating).icon}R${p.rating})` : ''}`,
      isAlly: (this.isTeam && p.team === msg.you.team) || this.isRaid,
    }));
    this.setupHud(msg.duration || MATCH_SECONDS);
    showItemBar(false);   // no boosters in PvP
    this.buildPanels(others);
    if (this.isTeam) {
      $('#teamTotals').classList.remove('hidden');
      this.refreshTeamHud();
    }
    if (this.isRaid && msg.boss) {
      this.raidBoss = msg.boss;
      this.raidHp = msg.boss.hp;
      $('#bossPanel').classList.remove('hidden');
      $('#bossEmoji').textContent = msg.boss.emoji;
      $('#bossEmoji').className = 'boss-emoji';
      $('#bossName').textContent = t(`${msg.boss.name}（レイド）`, `${catName(msg.boss)} (Raid)`);
      document.querySelector('.boss-atkbar').classList.add('hidden');
      this.updateRaidHp();
    }

    const v = getView();
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(this.isRaid ? 'boss' : 'battle');
    toast(this.isRaid ? t(`🐲 レイド開始！${this.raidBoss ? this.raidBoss.name : ''}を倒せ！`, `🐲 Raid start! Take down ${this.raidBoss ? catName(this.raidBoss) : 'the boss'}!`)
      : this.isTeam ? t('👥 チーム戦スタート！', '👥 Team battle start!') : t('⚔️ マッチしました！', '⚔️ Match found!'), 'ok');

    // Emotes: quick reactions relayed to everyone in the match.
    const emoteBtn = $('#btnEmote');
    emoteBtn.classList.remove('hidden');
    emoteBtn.onclick = () => this.toggleEmotePicker();

    countdownOverlay(msg.countdown || 3, () => {
      v.inputLocked = false;
      this.startTimer(() => this.timeUp());
      this.stateInt = setInterval(() => this.pushState(), 900);
    }, audio);
  }

  toggleEmotePicker() {
    const existing = document.querySelector('.emote-picker');
    if (existing) { existing.remove(); return; }
    const picker = document.createElement('div');
    picker.className = 'emote-picker';
    for (const e of ['👍', '🔥', '😂', '😭', '🎉', '😱', '💪', '😎', '👏', '🤯']) {
      const b = document.createElement('button');
      b.textContent = e;
      b.onclick = () => {
        this.client.send({ type: 'emote', emoji: e });
        this.floatEmote(e, 'me');
        audio.click();
        picker.remove();
      };
      picker.appendChild(b);
    }
    $('#screen-game').appendChild(picker);
    setTimeout(() => picker.remove(), 6000);
  }

  showEmote(slot, emoji) {
    this.floatEmote(emoji, slot);
    audio.pickup();
  }

  floatEmote(emoji, from) {
    const el = document.createElement('div');
    el.className = 'emote-float';
    let x = window.innerWidth / 2, y = window.innerHeight * 0.55;
    if (from === 'me') {
      y = window.innerHeight * 0.6;
      x = window.innerWidth * 0.25;
    } else {
      const scoreEl = document.querySelector(`[data-slot-score="${from}"]`);
      const card = scoreEl && scoreEl.closest('.opp-card');
      if (card) {
        const r = card.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
    }
    el.style.left = `${x - 27}px`;
    el.style.top = `${y - 27}px`;
    el.textContent = emoji;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }

  teamTotalsCalc() {
    const my = this.engine ? this.engine.score : 0;
    let allies = 0, theirs = 0;
    for (const p of this.matchInfo.players) {
      if (p.isYou) continue;
      const s = this.scores[p.slot] || 0;
      if (this.isTeam && p.team === this.you.team) allies += s;
      else theirs += s;
    }
    return { mine: my + allies, theirs };
  }

  refreshTeamHud() {
    const { mine, theirs } = this.teamTotalsCalc();
    this.updateBars(mine, theirs);
    if (this.isTeam) {
      $('#teamTotals').innerHTML =
        `<b class="tt-a">${fmt(mine)}</b><span class="muted"> vs </span><b class="tt-b">${fmt(theirs)}</b>`;
    }
  }

  pushState() {
    if (!this.engine || this.ended) return;
    this.client.sendState(this.engine.score, this.engine.streak, this.engine.linesCleared, this.engine.snapshot());
  }

  onPlace() {
    this.updateMyHud(this.engine);
    this.refreshTeamHud();
    this.pushState();
  }

  onOppState(msg) {
    this.updateOpp(msg.slot, msg);
    if (!this.isRaid) this.refreshTeamHud();
  }

  updateRaidHp() {
    if (!this.raidBoss) return;
    const pct = Math.max(0, (this.raidHp / this.raidBoss.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.raidHp))} / ${fmt(this.raidBoss.hp)}`;
  }

  onRaidState(msg) {
    if (!this.isRaid) return;
    const prev = this.raidHp;
    this.raidHp = msg.hp;
    this.updateRaidHp();
    if (msg.hp < prev) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
  }

  onRaidAttack(msg) {
    if (!this.isRaid || this.ended || !this.engine || !view || view.inputLocked) return;
    const cells = this.engine.addGarbage(msg.cells || 3);
    audio.bossAttack();
    const em = $('#bossEmoji');
    em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
    }
    view.shake = 12;
    toast(t(`${this.raidBoss.emoji} ${this.raidBoss.name}の攻撃！`, `${this.raidBoss.emoji} ${catName(this.raidBoss)} attacks!`), 'err', 1300);
    if (this.engine.over) this.onTopOut();
  }

  onTopOut() {
    if (this.ended) return;
    toast(t('ボードリセット！スコアは維持されます', 'Board reset! Your score is kept'), '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  timeUp() {
    if (this.ended) return;
    getView().inputLocked = true;
    clearInterval(this.stateInt);
    this.client.finish(this.engine.score, this.engine.linesCleared, this.engine.maxCombo);
    showModal(`
      <h2>${t('⌛ 集計中…', '⌛ Tallying…')}</h2>
      <p class="muted center">${t('全員の結果を待っています', 'Waiting for all results')}</p>`, { dismissable: false });
    this.resultTimeout = setTimeout(() => {
      if (!this.ended) {
        this.ended = true;
        this.destroy();
        closeModal();
        toast(t('結果を受信できませんでした', 'Could not receive the results'), 'err');
        endToMenu();
      }
    }, 20000);
  }

  onCoopResult(msg) {
    this.ended = true;
    clearTimeout(this.resultTimeout);
    clearInterval(this.stateInt);
    clearInterval(this.coopInt);
    this.stopTimer();
    getView().inputLocked = true;
    $('#coopBar').classList.add('hidden');
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    const c = msg.coop;
    const isBest = c.score >= (c.best || 0) && c.score > 0;
    const localBest = Number(localStorage.getItem('bba_coop_best') || 0);
    if (c.score > localBest) localStorage.setItem('bba_coop_best', String(c.score));
    if (isBest) { audio.victory(); confettiBurst(70); } else audio.gameOver();
    const mine = msg.players.find(p => p.slot === msg.you.slot);
    const partner = msg.players.find(p => p.slot !== msg.you.slot);
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? t('🤝 新記録！', '🤝 NEW RECORD!') : t('🤝 おつかれさま！', '🤝 GOOD GAME!')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('きょうりょくスコア', 'Shared score')}</span><b>${fmt(c.score)}</b></div>
        <div class="rs-row"><span>${t('自己ベスト', 'Personal best')}</span><b>${fmt(Math.max(c.best || 0, localBest, c.score))}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(c.lines)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(c.combo)}</b></div>
        <div class="rs-row"><span>${t('置いたピース', 'Pieces placed')}</span><b>${t(`あなた ${mine ? mine.moves : 0} ・ ${partner ? escapeHtml(partner.name) : '?'} ${partner ? partner.moves : 0}`,
          `You ${mine ? mine.moves : 0} ・ ${partner ? escapeHtml(partner.name) : '?'} ${partner ? partner.moves : 0}`)}</b></div>
        ${rewardsRows(msg.rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-online" id="rAgain">${t('🤝 もう一度組む', '🤝 Team up again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline('coop'); };
  }

  onResult(msg) {
    if (this.ended) return;

    // Tournament round won (not the final): stay in — the bracket and the
    // next match arrive from the server momentarily.
    if (msg.tourney && !msg.tourney.final && msg.outcome === 'win') {
      clearTimeout(this.resultTimeout);
      clearInterval(this.stateInt);
      this.stopTimer();
      getView().inputLocked = true;
      this.inMatch = false;
      if (msg.user) { session.user = msg.user; updateTopbar(); }
      audio.victory();
      const opp = msg.players.find(p => p.slot !== msg.you.slot);
      showModal(`
        <div class="result-banner win">${t('勝利！', 'Victory!')}</div>
        <div class="result-stats">
          <div class="rs-row"><span>${t('あなた', 'You')}</span><b>${fmt(msg.players.find(p => p.slot === msg.you.slot).score)}</b></div>
          ${opp ? `<div class="rs-row"><span>${escapeHtml(opp.name)}</span><b>${fmt(opp.score)}</b></div>` : ''}
        </div>
        <p class="muted center" style="margin-top:8px">${t('🏆 勝ち上がり！次のラウンドを待っています…', '🏆 Advancing! Waiting for the next round…')}</p>`, { dismissable: false });
      return;
    }

    // Co-op: no winner, just a shared score and a shared personal best.
    if (msg.coop) { this.onCoopResult(msg); return; }

    this.ended = true;
    clearTimeout(this.resultTimeout);
    clearInterval(this.stateInt);
    this.stopTimer();
    getView().inputLocked = true;
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    if (msg.outcome === 'win') { audio.victory(); confettiBurst(); } else audio.gameOver();

    const banners = msg.tourney
      ? { win: t('👑 トーナメント優勝！！', '👑 TOURNAMENT CHAMPION!!'), lose: t('敗退…', 'Eliminated…'), draw: 'DRAW' }
      : msg.mode === 'raid'
      ? { win: t(`${msg.boss ? msg.boss.emoji : '🐲'} レイドボス討伐！`, `${msg.boss ? msg.boss.emoji : '🐲'} Raid boss down!`), lose: t('討伐失敗…', 'Raid failed…'), draw: 'DRAW' }
      : { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: 'DRAW' };
    const roundNames = [t('準々決勝', 'the quarterfinal'), t('準決勝', 'the semifinal'), t('決勝', 'the final')];
    const tourneyNote = msg.tourney && msg.outcome !== 'win'
      ? `<p class="muted center">${t(`${roundNames[msg.tourney.round] || ''}で敗退しました`, `Knocked out in ${roundNames[msg.tourney.round] || 'the bracket'}`)}</p>`
      : msg.tourney ? `<p class="muted center">${t('8人トーナメントを制覇！', 'You conquered the 8-player bracket!')}</p>` : '';
    const reasonNote = tourneyNote + (
      msg.reason === 'forfeit' ? `<p class="muted center">${t('相手が切断しました', 'Your opponent disconnected')}</p>` :
      msg.reason === 'abandoned' ? `<p class="muted center">${t('対戦が中断されました', 'The match was abandoned')}</p>` : '');

    let scoreRows;
    if (msg.mode === 'raid') {
      const total = msg.players.reduce((a, p) => a + p.score, 0);
      scoreRows = `
        <div class="rs-row"><span>${msg.boss ? escapeHtml(catName(msg.boss)) : t('ボス', 'Boss')} HP</span><b>${fmt(msg.boss ? msg.boss.hp : 0)}</b></div>
        <div class="rs-row"><span>${t('パーティ総ダメージ', 'Party total damage')}</span><b>${fmt(total)}</b></div>
        ${msg.players.map(p => `<div class="rs-row"><span>${p.slot === msg.you.slot ? t('⭐あなた', '⭐You') : '👤' + escapeHtml(p.name)}</span><b>${fmt(p.score)}</b></div>`).join('')}`;
    } else if (msg.mode === 'team') {
      const teamRow = tm => {
        const members = msg.players.filter(p => p.team === tm);
        const names = members.map(p => `${p.slot === msg.you.slot ? '⭐' : '👤'}${escapeHtml(p.name)} ${fmt(p.score)}`).join('<br>');
        const label = tm === msg.you.team ? t('あなたのチーム', 'Your team') : t('相手チーム', 'Enemy team');
        return `<div class="rs-row team-row"><span>${label}<br><small class="muted">${names}</small></span><b>${fmt(msg.teamScores[tm])}</b></div>`;
      };
      scoreRows = teamRow(msg.you.team) + teamRow(1 - msg.you.team);
    } else {
      scoreRows = msg.players
        .sort((a, b) => (a.slot === msg.you.slot ? -1 : b.slot === msg.you.slot ? 1 : 0))
        .map(p => `<div class="rs-row"><span>${p.slot === msg.you.slot ? t('あなた', 'You') : escapeHtml(p.name)}</span><b>${fmt(p.score)}</b></div>`)
        .join('');
    }

    const myRating = msg.user && msg.user.stats ? msg.user.stats.rating : null;
    const tier = myRating != null ? rankOf(myRating) : null;
    const ratingRow = msg.ratingDelta
      ? `<div class="rs-row"><span>${t('📈 レート変動', '📈 Rating')}</span><b style="color:${msg.ratingDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${msg.ratingDelta >= 0 ? '+' : ''}${msg.ratingDelta}${tier ? ` <span style="color:${tier.color}">${tier.icon}${t(tier.name, tier.nameEn)}</span>` : ''}</b></div>`
      : '';

    const m = showModal(`
      <div class="result-banner ${msg.outcome}">${banners[msg.outcome]}</div>
      ${reasonNote}
      <div class="result-stats">
        ${scoreRows}
        ${ratingRow}
        ${rewardsRows(msg.rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${this.kind === 'custom' ? t('ルームへ', 'To room') : t('もう一戦', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline(this.kind); };
  }

  quit() {
    if (this.inMatch && !this.ended) {
      this.ended = true;
      this.destroy();
      toast(this.isCoop
        ? t('🤝 協力プレイから離脱しました（敗北にはなりません）', '🤝 You left the co-op run (no loss recorded)')
        : t('🏳️ 対戦から離脱しました（敗北扱い・相手の不戦勝）', '🏳️ You left the match (counts as a loss)'), 'err', 2600);
      endToMenu();
    } else {
      this.client.cancelQueue();
      this.client.leaveRoom();
      this.destroy();
      endToMenu();
    }
  }

  destroy() {
    this.stopTimer();
    clearInterval(this.stateInt);
    clearInterval(this.coopInt);
    clearTimeout(this.resultTimeout);
    $('#bossPanel').classList.add('hidden');
    $('#coopBar').classList.add('hidden');
    if (view) view.onIntentPlace = null;
    this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Survival: endless garbage waves on an accelerating timer. How long can
// you keep the board alive?
// ---------------------------------------------------------------------------

class SurvivalMode {
  constructor() {
    this.mode = 'survival';
    this.wave = 0;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = () => this.updateHud();
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('hard');
    this.nextAt = Date.now() + 15000;
    this.int = setInterval(() => this.tick(), 200);
    toast(t('💀 15秒ごとにお邪魔ブロックが降ってくる！生き延びろ！', '💀 Garbage drops every 15s — survive!'), 'announce', 3000);
  }

  best() { return Number(localStorage.getItem('bba_survival_best') || 0); }
  bestWave() { return Number(localStorage.getItem('bba_survival_wave') || 0); }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `WAVE ${this.wave}${this.bestWave() ? ` ・ BEST W${this.bestWave()}` : ''}`;
  }

  tick() {
    if (this.ended) return;
    const remain = Math.max(0, this.nextAt - Date.now());
    const el = $('#hudTimer');
    el.textContent = `☠ ${Math.ceil(remain / 1000)}`;
    el.classList.toggle('urgent', remain <= 3000);
    if (remain <= 0) this.dropWave();
  }

  dropWave() {
    this.wave++;
    const cells = Math.min(2 + Math.floor(this.wave / 2), 7);
    const added = this.engine.addGarbage(cells);
    audio.bossAttack();
    if (view) {
      view.shake = 10;
      for (const [r, c] of added) {
        view.spawnAnim.set(r * 8 + c, view.time);
        view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 8, 'fx_default');
      }
    }
    toast(t(`💀 WAVE ${this.wave}！お邪魔${cells}個`, `💀 WAVE ${this.wave}! ${cells} garbage blocks`), 'err', 1300);
    const interval = Math.max(5, 15 - this.wave * 0.6);
    this.nextAt = Date.now() + interval * 1000;
    this.updateHud();
    if ((this.engine.over || !this.engine.hasAnyMove()) && !autoRescue()) this.finish();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.int);
    getView().inputLocked = true;
    const e = this.engine;
    const survived = Math.round((Date.now() - this.startedAt) / 1000);
    const isBest = e.score > this.best();
    if (isBest) localStorage.setItem('bba_survival_best', String(e.score));
    if (this.wave > this.bestWave()) localStorage.setItem('bba_survival_wave', String(this.wave));
    if (isBest && e.score > 0) confettiBurst();
    audio.gameOver();
    const rewards = await submitResult({
      mode: 'survival', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: survived, won: false, wave: this.wave,
    });
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : t('生存終了…', 'You were buried…')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('到達ウェーブ', 'Wave reached')}</span><b>W${this.wave}</b></div>
        <div class="rs-row"><span>${t('生存時間', 'Time survived')}</span><b>${Math.floor(survived / 60)}:${String(survived % 60).padStart(2, '0')}</b></div>
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-oni" id="rAgain">${t('もう一度生き残る', 'Survive again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startSurvival(); };
  }

  quit() { this.finish(); }
  destroy() { this.ended = true; clearInterval(this.int); }
}

// ---------------------------------------------------------------------------
// ⏱️ Time Attack (sprint): a fixed clock, pure scoring.
//
// Boosters and ultimates are OFF here on purpose — this mode has its own
// leaderboard, and paid consumables would decide it.
// ---------------------------------------------------------------------------

export const SPRINT_DURATIONS = [60, 180];

function sprintKey(dur) { return `bba_sprint_${dur}`; }

export function sprintBest(dur) {
  const local = Number(localStorage.getItem(sprintKey(dur)) || 0);
  const srv = session.user && session.user.stats && session.user.stats.sprint
    ? Number(session.user.stats.sprint[`s${dur}`] || 0) : 0;
  return Math.max(local, srv);
}

class SprintMode {
  constructor(duration) {
    this.mode = 'sprint';
    this.duration = SPRINT_DURATIONS.includes(duration) ? duration : 60;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);            // fair leaderboard: no boosters, no ultimates
    this.ended = false;
    this.startedAt = Date.now();
    const v = getView();
    v.setTheme(equippedTheme());
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = () => this.onPlace();
    v.onGameOver = () => this.finish('topout');
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('hard');

    countdownOverlay(3, () => {
      if (this.ended) return;
      v.inputLocked = false;
      this.endAt = Date.now() + this.duration * 1000;
      this.tickInt = setInterval(() => this.tick(), 200);
      this.tick();
    }, audio);
  }

  tick() {
    if (this.ended) return;
    const remain = Math.max(0, this.endAt - Date.now());
    const s = Math.ceil(remain / 1000);
    const el = $('#hudTimer');
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', s <= 10);
    if (remain <= 0) this.finish('time');
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const best = sprintBest(this.duration);
    const rate = Math.round(this.engine.score / Math.max(1, (Date.now() - this.startedAt) / 1000));
    $('#hudSub').textContent = t(`${this.duration}秒 ・ BEST ${fmt(best)} ・ ${fmt(rate)}/秒`,
      `${this.duration}s ・ BEST ${fmt(best)} ・ ${fmt(rate)}/s`);
  }

  onPlace() { this.updateHud(); }

  async finish(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.tickInt);
    getView().inputLocked = true;
    $('#hudTimer').classList.add('hidden');
    const e = this.engine;
    const prevBest = sprintBest(this.duration);
    const isBest = e.score > prevBest;
    if (isBest) localStorage.setItem(sprintKey(this.duration), String(e.score));
    if (isBest && e.score > 0) { confettiBurst(60); audio.victory(); }
    else audio.gameOver();

    const rewards = await submitResult({
      mode: 'sprint', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      duration: Math.max(1, (Date.now() - this.startedAt) / 1000), won: false,
      sprintDur: this.duration,
    });
    const banner = isBest ? 'NEW RECORD!' : reason === 'topout' ? t('盤面が埋まった…', 'Board filled up…') : 'TIME UP!';
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('自己ベスト', 'Personal best')}</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>${t('毎秒スコア', 'Score per second')}</span><b>${fmt(Math.round(e.score / this.duration))}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rRank">${t('🏆 順位', '🏆 Ranking')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rRank').onclick = () => {
      closeModal();
      endToMenu();
      if (window.__bbaOpenLeaderboard) window.__bbaOpenLeaderboard('sprint');
    };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startSprint(this.duration); };
  }

  quit() { this.finish('quit'); }
  destroy() { this.ended = true; clearInterval(this.tickInt); $('#hudTimer').classList.add('hidden'); }
}

export function startSprint(duration = 60) {
  if (currentMode) currentMode.destroy();
  currentMode = new SprintMode(duration);
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function startSurvival() {
  if (currentMode) currentMode.destroy();
  currentMode = new SurvivalMode();
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function endToMenu() {
  if (currentMode) { currentMode.destroy(); currentMode = null; }
  // Mode-installed view hooks/overlays must never leak into the next mode.
  if (view) {
    view.onIntentPlace = null;
    view.onTrayDrop = null;
    view.glowCells = null;
    view.dangerCells = null;
    view.coolCells = null;
    view.oreCells = null;
  }
  if (view) view.stop();
  stopAutopilot();
  const picker = document.querySelector('.emote-picker');
  if (picker) picker.remove();
  $('#btnEmote').classList.add('hidden');
  showItemBar(false);
  audio.playTrack('menu');
  showScreen('menu');
}

export function startSolo() {
  if (currentMode) currentMode.destroy();
  currentMode = new SoloMode();
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function startMeltdown() {
  if (currentMode) currentMode.destroy();
  currentMode = new MeltdownMode();
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function startChimera() {
  if (currentMode) currentMode.destroy();
  currentMode = new ChimeraMode();
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function startVsAi(level) {
  if (currentMode) currentMode.destroy();
  currentMode = new AiMode(level);
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function startOnline(kind = 'duel') {
  if (currentMode) currentMode.destroy();
  currentMode = new OnlineMode(kind);
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function cancelMatchmaking() {
  if (currentMode && currentMode.mode === 'pvp') currentMode.quit();
  else endToMenu();
}

export { endToMenu };

export { updateRerollHud, handleEngineOver, updateAutoBtn };
