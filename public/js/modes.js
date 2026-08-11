// Game mode controllers: Solo, VS AI, Online (1v1 / 2v2 team / custom rooms),
// plus the admin-only autopilot.
import { Engine } from './engine.js';
import { GameView, MiniBoard } from './game.js';
import { chooseMove, AI_LEVELS } from './ai.js';
import { audio } from './audio.js';
import { session, api, refreshMe, BattleClient } from './net.js';
import { $, showScreen, showModal, closeModal, toast, countdownOverlay, fmt, updateTopbar, confettiBurst } from './dom.js';
import { t } from './i18n.js';

const MATCH_SECONDS = 120;

let view = null;
let currentMode = null;

function getView() {
  if (!view) {
    view = new GameView($('#gameCanvas'), { interactive: true });
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
  try {
    const data = await api('/api/game/result', { method: 'POST', body: payload });
    updateTopbar();
    return data.rewards;
  } catch (err) {
    console.warn('result submit failed:', err.message);
    return null;
  }
}

function rewardsRows(rewards) {
  if (!rewards) {
    return `<div class="rs-row"><span>${t('💡 報酬を受け取るにはログイン', '💡 Log in to earn rewards')}</span></div>`;
  }
  return `
    <div class="rs-row"><span>${t('🪙 コイン', '🪙 Coins')}</span><b>+${fmt(rewards.coins)}</b></div>
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
  if (currentMode.onTopOut) currentMode.onTopOut();
  else currentMode.finish();
}

export function rerollCurrent() {
  if (!currentMode || !currentMode.engine || !view || view.inputLocked) return;
  const e = currentMode.engine;
  if (!e.reroll()) {
    audio.error();
    toast('リロールは使い切りました', 'err', 1400);
    return;
  }
  audio.coin();
  toast('🔄 ピースを引き直しました！', 'ok', 1400);
  updateRerollHud(e);
  if (e.over) handleEngineOver();
}

// ---------------------------------------------------------------------------
// Booster items (consumables): usable in solo / boss / rush / dungeon / chaos.
// Logged-in inventories live on the server; guests use localStorage.
// ---------------------------------------------------------------------------

const ITEM_DEFS = {
  item_bomb:    { icon: '💣', name: 'スマートボム' },
  item_cleaner: { icon: '🧹', name: 'クリーナー' },
  item_fever:   { icon: '⭐', name: 'フィーバー' },
};

function getItemCounts() {
  if (session.user) return session.user.items || {};
  try {
    const v = JSON.parse(localStorage.getItem('bba_items'));
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  const gift = { item_bomb: 1, item_cleaner: 1, item_fever: 1 };   // guest starter gift
  localStorage.setItem('bba_items', JSON.stringify(gift));
  return gift;
}

function spendItem(id) {
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

export function showItemBar(on) {
  $('#itemBar').classList.toggle('hidden', !on);
  if (on) updateItemBar();
}

export function updateItemBar() {
  const counts = getItemCounts();
  document.querySelectorAll('#itemBar [data-item]').forEach(b => {
    const id = b.dataset.item;
    const n = counts[id] || 0;
    b.querySelector('b').textContent = n;
    b.classList.toggle('off', n <= 0);
  });
}

export function useGameItem(id) {
  const m = currentMode;
  if (!m || !m.engine || !view || view.inputLocked || m.ended) return;
  if (!ITEM_DEFS[id]) return;
  const counts = getItemCounts();
  if ((counts[id] || 0) <= 0) {
    audio.error();
    toast('アイテムがありません。ショップやガチャで入手！', 'err', 2200);
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
    if (!bestCount) { audio.error(); toast('盤面が空です！', 'err', 1500); return; }
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
    toast('💣 ドカーン！', 'ok', 1400);
  } else if (id === 'item_cleaner') {
    let n = 0;
    for (let i = 0; i < 64; i++) if (e.grid[i] === 9) { e.grid[i] = 0; n++; }
    for (let c = 0; c < 8; c++) { const k = 7 * 8 + c; if (e.grid[k]) { e.grid[k] = 0; n++; } }
    if (n === 0) { audio.error(); toast('掃除するものがありません！', 'err', 1500); return; }
    view.reviveFlash();
    audio.coin();
    toast(`🧹 ${n}マスを掃除しました！`, 'ok', 1500);
  } else if (id === 'item_fever') {
    e.feverUntil = Date.now() + 15000;
    view.screenFlash = 0.35;
    $('#hudScore').classList.add('fever');
    audio.combo(6);
    toast('⭐ フィーバー！15秒間スコア2倍！！', 'announce', 2400);
    setTimeout(() => {
      $('#hudScore').classList.remove('fever');
      if (currentMode === m && !m.ended) toast('フィーバー終了', '', 1200);
    }, 15000);
  }

  // survivors of a bomb/clean: board changed, over-state may be stale
  if (e.over && e.hasAnyMove()) e.over = false;
  spendItem(id);
  updateItemBar();
}

// ---------------------------------------------------------------------------
// Autopilot (admin only): the strongest AI plays your board, any mode.
// ---------------------------------------------------------------------------

const autopilot = { on: false, speed: 1, timer: null };

function isAdmin() { return !!session.user && session.user.role === 'admin'; }

function updateAutoBtn() {
  const btn = $('#btnAuto');
  btn.classList.toggle('hidden', !isAdmin());
  $('#autoState').textContent = autopilot.on ? `x${autopilot.speed}` : 'OFF';
  btn.classList.toggle('auto-on', autopilot.on);
  $('#btnAdminCmd').classList.toggle('hidden', !isAdmin());
}

// ---------------------------------------------------------------------------
// In-game admin command palette
// ---------------------------------------------------------------------------

export function showAdminPalette() {
  if (!isAdmin()) return;
  const m = showModal(`
    <h2>🛡️ 管理者コマンド</h2>
    <div class="form-col admin-cmds">
      <button class="btn btn-ghost btn-sm" data-cmd="score">✨ スコア +1,000</button>
      <button class="btn btn-ghost btn-sm" data-cmd="clear">🧹 ボード全消し</button>
      <button class="btn btn-ghost btn-sm" data-cmd="reroll">🔄 リロール +5回</button>
      <button class="btn btn-ghost btn-sm" data-cmd="time">⏱ 残り時間 +60秒</button>
      <button class="btn btn-ghost btn-sm" data-cmd="bosshalf">👹 敵HP 半減</button>
      <button class="btn btn-ghost btn-sm" data-cmd="floorclear">🏰 フロア即クリア</button>
      <button class="btn btn-ghost btn-sm" data-cmd="fever">⭐ フィーバー付与（15秒）</button>
    </div>
    <p class="muted center" style="font-size:11px;margin-top:8px">通貨付与や隠し解放はホームの「🛡️管理」から</p>
    <div class="modal-buttons"><button class="btn btn-primary" id="acClose">閉じる</button></div>`);
  m.querySelector('#acClose').onclick = closeModal;
  m.querySelectorAll('[data-cmd]').forEach(b => {
    b.onclick = () => { adminCmd(b.dataset.cmd); };
  });
}

async function adminCmd(cmd) {
  const mode = currentMode;
  const eng = mode && mode.engine;
  audio.click();
  switch (cmd) {
    case 'score':
      if (!eng) return toast('ゲーム中のみ使えます', 'err');
      eng.score += 1000;
      if (mode.updateHud) mode.updateHud();
      else if (mode.updateMyHud) mode.updateMyHud(eng);
      if (view) view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize / 2, '+1000 (admin)', '#43d9e8', 1.3);
      break;
    case 'clear':
      if (!eng) return toast('ゲーム中のみ使えます', 'err');
      eng.grid.fill(0);
      if (view) view.reviveFlash();
      toast('🧹 ボードを全消ししました', 'ok', 1400);
      break;
    case 'reroll':
      if (!eng) return toast('ゲーム中のみ使えます', 'err');
      eng.rerolls += 5;
      updateRerollHud(eng);
      toast('🔄 リロール+5', 'ok', 1400);
      break;
    case 'time':
      if (!mode || mode.endAt === undefined) return toast('タイマーのあるモードのみ', 'err');
      mode.endAt += 60000;
      mode.timeLeft += 60;
      toast('⏱ +60秒', 'ok', 1400);
      break;
    case 'bosshalf':
      if (!mode || (mode.mode !== 'boss' && mode.mode !== 'dungeon')) return toast('ボス戦・ダンジョンのみ使えます', 'err');
      mode.hp = Math.ceil(mode.hp / 2);
      mode.updateHpBar();
      toast('👹 敵HPを半減しました', 'ok', 1400);
      if (mode.hp <= 0) {
        if (mode.mode === 'dungeon') mode.floorCleared();
        else mode.finish(true);
      }
      break;
    case 'floorclear':
      if (!mode || mode.mode !== 'dungeon') return toast('ダンジョンのみ使えます', 'err');
      if (mode.perkOpen) return;
      mode.engine.score += Math.max(0, mode.hp);
      mode.hp = 0;
      mode.updateHpBar();
      mode.floorCleared();
      break;
    case 'fever':
      if (!eng) return toast('ゲーム中のみ使えます', 'err');
      eng.feverUntil = Date.now() + 15000;
      $('#hudScore').classList.add('fever');
      setTimeout(() => $('#hudScore').classList.remove('fever'), 15000);
      toast('⭐ フィーバー付与！15秒間スコア2倍', 'ok', 1800);
      break;
  }
}

export function toggleAutopilot() {
  if (!isAdmin()) return;
  audio.click();
  if (!autopilot.on) {
    autopilot.on = true;
    autopilot.speed = 1;
    toast('🤖 オートパイロット起動（再タップで加速）', 'ok', 2000);
  } else if (autopilot.speed < 4) {
    autopilot.speed *= 2;
    toast(`🤖 速度 x${autopilot.speed}`, '', 1200);
  } else {
    stopAutopilot();
    toast('🤖 オートパイロット停止', '', 1500);
    return;
  }
  updateAutoBtn();
  runAutopilot();
}

function runAutopilot() {
  clearTimeout(autopilot.timer);
  if (!autopilot.on) return;
  autopilot.timer = setTimeout(() => {
    const m = currentMode;
    if (m && m.engine && view && view.running && !view.inputLocked && !m.engine.over) {
      const mv = chooseMove(m.engine, 'oni');
      if (mv) {
        const r = m.engine.place(mv.index, mv.row, mv.col);
        if (r) view.applyResult(r);   // full effects + mode callbacks
      } else if (m.engine.rerolls > 0 || m.engine.infiniteReroll) {
        m.engine.reroll();
        updateRerollHud(m.engine);
        if (m.engine.over) handleEngineOver();
      }
    }
    runAutopilot();
  }, 800 / autopilot.speed);
}

export function stopAutopilot() {
  autopilot.on = false;
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
        <div class="rs-row"><span>スコア</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>消したライン</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>最大コンボ</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-primary" id="rAgain">もう一度</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() { this.finish(); }
  destroy() {}
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

  aiLabel() { return `${this.cfg.avatar} AI (${this.cfg.name})`; }

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
      <div class="kami-text">創造神が 目覚めた————</div>`;
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
    el.innerHTML = `<div class="oni-face">👹</div><div class="oni-text">おにが あらわれた！</div>`;
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
      <div class="kami-text">神が 降臨した——</div>`;
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
      setTimeout(() => toast('👹 バッジ「おに退治」を獲得！', 'announce', 4000), 1200);
    }
    if (rewards && rewards.badge === 'kami') {
      setTimeout(() => toast('🔱 バッジ「神殺し」を獲得！！', 'announce', 5000), 1200);
    }
    if (rewards && rewards.badge === 'souzou') {
      setTimeout(() => { toast('🌌 バッジ「創造を超えし者」を獲得！！！', 'announce', 6000); confettiBurst(80); }, 1200);
    }

    const banners = { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: this.aborted ? '🤝 引き分け（中断）' : 'DRAW' };
    const m = showModal(`
      <div class="result-banner ${outcome}">${banners[outcome]}</div>
      ${this.aborted ? '<p class="muted center">途中終了は引き分け扱いです。敗北にはなりません</p>' : ''}
      <div class="result-stats">
        <div class="rs-row"><span>あなた</span><b>${fmt(me)}</b></div>
        <div class="rs-row"><span>${this.aiLabel()}</span><b>${fmt(opp)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-primary" id="rAgain">再戦</button>
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
};

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
    $('#bossName').textContent = this.boss.name;
    showItemBar(true);
    this.hp = this.boss.hp;
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
      this.nextAtk = Date.now() + this.boss.atkSec * 1000;
      this.atkInt = setInterval(() => this.tickAttack(), 100);
    }, audio);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = '⚔️ 与ダメージ';
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
    this.updateHpBar();
    this.damageFloat(dmg, result.lineCount > 0);
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
    const total = this.boss.atkSec * 1000;
    const remain = Math.max(0, this.nextAtk - Date.now());
    $('#bossAtkBar').style.width = `${(1 - remain / total) * 100}%`;
    if (remain <= 0) {
      this.nextAtk = Date.now() + total;
      this.attack();
    }
  }

  attack() {
    if (this.ended || !this.engine || view.inputLocked) return;
    const cells = this.engine.addGarbage(this.boss.atkCells);
    audio.bossAttack();
    const em = $('#bossEmoji');
    em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      const cx = view.boardX + (c + 0.5) * view.cell;
      const cy = view.boardY + (r + 0.5) * view.cell;
      view.particles.burstCell(cx, cy, view.cell, 9, 'fx_default');
    }
    view.shake = 12;
    toast(`${this.boss.emoji} ${this.boss.name}の攻撃！`, 'err', 1300);
    if (this.engine.over) this.finish(false);
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    view.inputLocked = true;
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
      duration: (Date.now() - this.startedAt) / 1000, won,
    });
    if (rewards && rewards.badge === 'maou') {
      setTimeout(() => toast('😈 バッジ「魔王討伐」を獲得！', 'announce', 4000), 1200);
    }

    const hasNext = won && this.bossIndex + 1 < this.bossCount;
    const banner = won ? `${this.boss.emoji} 討伐成功！` : this.aborted ? '🤝 中断（引き分け）' : 'やられた…';
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      ${this.aborted ? '<p class="muted center">途中終了は引き分け扱いです。敗北にはなりません</p>' : ''}
      <div class="result-stats">
        <div class="rs-row"><span>与えたダメージ</span><b>${fmt(this.engine.score)}</b></div>
        ${won ? '' : `<div class="rs-row"><span>${this.boss.name}の残りHP</span><b>${fmt(Math.max(0, this.hp))}</b></div>`}
        <div class="rs-row"><span>消したライン</span><b>${fmt(this.engine.linesCleared)}</b></div>
        <div class="rs-row"><span>最大コンボ</span><b>${fmt(this.engine.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn ${won ? 'btn-primary' : 'btn-ai'}" id="rAgain">${hasNext ? '次のボスへ' : won ? 'もう一度' : this.aborted ? 'もう一度' : 'リベンジ'}</button>
      </div>`, { dismissable: false });
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
  }
}

export function startBoss(boss, bossIndex, bossCount) {
  if (currentMode) currentMode.destroy();
  currentMode = new BossMode(boss, bossIndex, bossCount);
  window.__bbaMode = currentMode;   // debug/testing hook
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Boss rush: all bosses back-to-back on one board. Unlocked after clearing
// every boss. One life — top out once and the run is over.
// ---------------------------------------------------------------------------

class BossRushMode {
  constructor(bosses) {
    this.mode = 'boss';        // shares boss-panel admin command (HP halve)
    this.bosses = bosses;
    this.stage = 0;
    this.boss = bosses[0];
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    showItemBar(true);
    this.applyBossPanel();
    this.startedAt = Date.now();

    const v = getView();
    v.setTheme({ ...equippedTheme(), boardId: 'board_oni' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('boss');
    toast('⚔️ ボスラッシュ開始！全ボスを連続で討伐せよ！', 'announce', 2600);

    countdownOverlay(3, () => {
      v.inputLocked = false;
      this.nextAtk = Date.now() + this.boss.atkSec * 1000;
      this.atkInt = setInterval(() => this.tickAttack(), 100);
    }, audio);
  }

  applyBossPanel() {
    this.hp = this.boss.hp;
    $('#bossEmoji').textContent = this.boss.emoji;
    $('#bossEmoji').className = 'boss-emoji';
    $('#bossName').textContent = `${this.boss.name}（${this.stage + 1}/${this.bosses.length}）`;
    this.updateHpBar();
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `⚔️ ボスラッシュ ${this.stage + 1}/${this.bosses.length}`;
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.boss.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.hp))} / ${fmt(this.boss.hp)}`;
  }

  onPlace(result) {
    this.updateHud();
    this.hp -= result.gained;
    this.updateHpBar();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) {
      if (this.stage + 1 >= this.bosses.length) this.finish(true);
      else this.nextBoss();
    }
  }

  nextBoss() {
    this.stage++;
    this.boss = this.bosses[this.stage];
    audio.bossDefeated();
    confettiBurst(30);
    if (view) view.shake = 12;
    toast(`${this.bosses[this.stage - 1].emoji} 撃破！つぎは ${this.boss.emoji} ${this.boss.name}！`, 'announce', 2400);
    this.applyBossPanel();
    this.updateHud();
    this.nextAtk = Date.now() + this.boss.atkSec * 1000;
  }

  tickAttack() {
    if (this.ended) return;
    const total = this.boss.atkSec * 1000;
    const remain = Math.max(0, this.nextAtk - Date.now());
    $('#bossAtkBar').style.width = `${(1 - remain / total) * 100}%`;
    if (remain <= 0) {
      this.nextAtk = Date.now() + total;
      this.attack();
    }
  }

  attack() {
    if (this.ended || !this.engine || view.inputLocked) return;
    const cells = this.engine.addGarbage(this.boss.atkCells);
    audio.bossAttack();
    const em = $('#bossEmoji');
    em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
    }
    view.shake = 12;
    toast(`${this.boss.emoji} ${this.boss.name}の攻撃！`, 'err', 1300);
    if (this.engine.over) this.finish(false);
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    view.inputLocked = true;
    if (won) {
      audio.bossDefeated();
      confettiBurst(80);
      $('#bossEmoji').classList.add('boss-dead');
    } else if (!this.aborted) {
      audio.gameOver();
    }
    const rewards = await submitResult({
      mode: 'boss_rush', score: this.engine.score,
      lines: this.engine.linesCleared, maxCombo: this.engine.maxCombo,
      duration: (Date.now() - this.startedAt) / 1000, won,
    });
    if (rewards && rewards.badge === 'rush') {
      setTimeout(() => toast('⚔️ バッジ「ボスラッシュ制覇」を獲得！+300💎', 'announce', 5000), 1200);
    }
    const banner = won ? '⚔️ ボスラッシュ制覇！！' : this.aborted ? '🤝 中断（引き分け）' : `${this.boss.emoji} に敗北…`;
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>到達</span><b>${won ? '完全制覇' : `${this.stage + 1}体目 (${this.boss.name})`}</b></div>
        <div class="rs-row"><span>総ダメージ</span><b>${fmt(this.engine.score)}</b></div>
        <div class="rs-row"><span>最大コンボ</span><b>${fmt(this.engine.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn ${won ? 'btn-primary' : 'btn-ai'}" id="rAgain">${won ? 'もう一周' : 'リベンジ'}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startBossRush(this.bosses); };
  }

  quit() { this.aborted = true; this.finish(false); }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    $('#bossPanel').classList.add('hidden');
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
    toast(`🎯 ウィークリーチャレンジ！${this.info.pieces}個のピースで限界に挑め！`, 'announce', 2800);
  }

  piecesLeft() { return Math.max(0, this.info.pieces - this.engine.piecesPlaced); }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `🎯 ${this.info.week} ・ ベスト ${fmt(this.best())}`;
    const t = $('#hudTimer');
    t.textContent = `残り${this.piecesLeft()}個`;
    t.classList.toggle('urgent', this.piecesLeft() <= 5);
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
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? '🎯 今週のベスト更新！' : '🎯 チャレンジ終了'}</div>
      ${usedAll ? '' : '<p class="muted center">ピースを置く場所がなくなりました</p>'}
      <div class="result-stats">
        <div class="rs-row"><span>スコア</span><b>${fmt(e.score)}${isBest ? ' 👑' : ''}</b></div>
        <div class="rs-row"><span>今週のベスト</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>使ったピース</span><b>${fmt(e.piecesPlaced)} / ${this.info.pieces}</b></div>
        <div class="rs-row"><span>最大コンボ</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
        ${session.user ? '' : '<div class="rs-row"><span>💡 ランキング掲載にはログイン</span></div>'}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-ghost" id="rRank">🏆 順位を見る</button>
        <button class="btn btn-weekly" id="rAgain">もう一度</button>
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
  { name: '苔の洞窟',   board: 'board_forest',  track: 'battle', foes: [['🦇', 'コウモリ'], ['🐀', '大ネズミ'], ['🟢', 'スライム'], ['🕷️', '毒グモ']], boss: ['👑', 'キングスライム'] },
  { name: '海底神殿',   board: 'board_ocean',   track: 'battle', foes: [['🐙', 'タコ兵'], ['🦀', '鉄カニ'], ['🐡', 'トゲフグ'], ['🦈', 'サメ傭兵']], boss: ['🧜‍♀️', '海の女王'] },
  { name: '桜の迷宮',   board: 'board_sakura',  track: 'solo',   foes: [['🦊', '妖狐'], ['🐍', '花蛇'], ['🦋', '幻蝶'], ['🐦', '怪鳥']], boss: ['👺', '大天狗'] },
  { name: '黄昏の砂漠', board: 'board_sunset',  track: 'hard',   foes: [['🦂', '大サソリ'], ['🐫', '護衛ラクダ'], ['🦅', 'ハゲタカ'], ['🐍', '砂大蛇']], boss: ['🦁', 'スフィンクス'] },
  { name: '灼熱火山',   board: 'board_volcano', track: 'hard',   foes: [['🔥', '火の精'], ['🦎', '溶岩トカゲ'], ['🐗', 'マグマ猪'], ['🗿', '岩人形']], boss: ['🐲', '火竜グレンド'] },
  { name: '氷結洞窟',   board: 'board_default', track: 'boss',   foes: [['⛄', '雪人形'], ['🐧', '氷ペンギン兵'], ['🦭', '氷セイウチ'], ['❄️', '氷の精']], boss: ['🐻‍❄️', 'フロストベア'] },
  { name: '雷雲の頂',   board: 'board_galaxy',  track: 'boss',   foes: [['⚡', '雷精'], ['🦅', '雷鷲'], ['☁️', '雲魔'], ['🌪️', '竜巻魔']], boss: ['🦚', 'サンダーバード'] },
  { name: '亡霊の城',   board: 'board_oni',     track: 'oni',    foes: [['👻', '亡霊'], ['💀', 'スケルトン'], ['🧟', 'ゾンビ騎士'], ['🦇', '吸血コウモリ']], boss: ['🧛', 'ヴァンパイア卿'] },
  { name: '鬼の巣窟',   board: 'board_oni',     track: 'oni',    foes: [['👹', '赤鬼'], ['👺', '青鬼'], ['🔥', '鬼火'], ['💀', '骨武者']], boss: ['👹', '鬼神ラセツ'] },
  { name: '天界の門',   board: 'board_kami',    track: 'kami',   foes: [['🕊️', '堕天使'], ['⚔️', '神殿騎士'], ['🌟', '星霊'], ['🔮', '法陣魔']], boss: ['😈', '魔神ゼルガドス'] },
];

function dungeonFloor(f) {
  const band = DUNGEON_BANDS[Math.min(DUNGEON_BANDS.length - 1, Math.floor((f - 1) / 10))];
  const isBoss = f % 10 === 0;
  const isFinal = f === 100;
  const [emoji, name] = isBoss ? band.boss : band.foes[(f - 1) % band.foes.length];
  let hp = Math.round(260 + f * 95 + f * f * 1.15);
  if (isBoss) hp = Math.round(hp * (isFinal ? 3 : 2.1));
  const atkSec = Math.max(5.5, 15 - f * 0.09) * (isBoss ? 1.25 : 1);
  const atkCells = Math.min(7, 1 + Math.floor(f / 12) + (isBoss ? 2 : 0));
  return { floor: f, band, isBoss, isFinal, emoji, name, hp, atkSec, atkCells };
}

const DUNGEON_PERKS = [
  { id: 'atk',    icon: '💪', name: '攻撃力アップ',     desc: '与ダメージ +60%（重ねがけOK）', w: 5 },
  { id: 'reroll', icon: '🔄', name: 'リロール補充',     desc: 'リロール +3回', w: 4 },
  { id: 'heal',   icon: '💊', name: '応急修理',         desc: '下2行とお邪魔ブロックを消す', w: 4 },
  { id: 'slow',   icon: '⏳', name: 'スロウの呪文',     desc: '敵の攻撃間隔 +25%（重ねがけOK）', w: 3 },
  { id: 'life',   icon: '❤️', name: '追加ライフ',       desc: '残機 +1（ボードが埋まっても復活）', w: 2 },
  { id: 'shield', icon: '🛡️', name: 'コンボプロテクト', desc: 'コンボが途切れなくなる（永続）', w: 2 },
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
  constructor(startFloor = 1) {
    this.mode = 'dungeon';
    this.startFloor = Math.max(1, Math.min(91, startFloor));
    this.floor = this.startFloor;
    this.lives = 1;
    this.atkSlow = 1;   // >1 = slower enemy attacks (perk)
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
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    toast(k > 0 ? `🏰 F${this.startFloor} から再開！（強化ボーナス付き）` : '🏰 ダンジョン挑戦開始！100Fを目指せ！', 'announce', 2600);
    countdownOverlay(3, () => {
      v.inputLocked = false;
      this.armAttack();
    }, audio);
  }

  loadFloor(f, silent) {
    this.info = dungeonFloor(f);
    this.hp = this.info.hp;
    const v = getView();
    v.setTheme({ ...equippedTheme(), boardId: this.info.band.board });
    audio.playTrack(this.info.band.track);
    $('#bossEmoji').textContent = this.info.emoji;
    $('#bossEmoji').className = 'boss-emoji';
    $('#bossName').textContent = `F${f} ${this.info.band.name}：${this.info.name}`;
    this.updateHpBar();
    this.updateHud();
    if (silent) return;
    if (this.info.isFinal) {
      toast(`😈 最上階——魔神ゼルガドスが待ち受ける！！`, 'announce', 3000);
      audio.bossAttack();
      v.shake = 16;
    } else if (this.info.isBoss) {
      toast(`⚠️ ボス階！${this.info.emoji} ${this.info.name}が立ちはだかる！`, 'announce', 2400);
      audio.bossAttack();
      v.shake = 12;
    } else {
      toast(`${this.info.emoji} ${this.info.name}が あらわれた！`, '', 1400);
    }
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `🏰 F${this.floor}/100 ・ ❤️×${this.lives}${this.engine.scoreMult > 1 ? ` ・ 💪×${this.engine.scoreMult.toFixed(1)}` : ''}`;
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.info.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.hp))} / ${fmt(this.info.hp)}`;
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

  atkMs() { return this.info.atkSec * 1000 * this.atkSlow; }

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
    toast(`${this.info.emoji} ${this.info.name}の攻撃！`, 'err', 1100);
    if (this.engine.over) this.onTopOut();
  }

  onPlace(result) {
    this.updateHud();
    this.hp -= result.gained;
    this.updateHpBar();
    this.damageFloat(result.gained, result.lineCount > 0);
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.floorCleared();
  }

  floorCleared() {
    clearInterval(this.atkInt);
    audio.bossDefeated();
    $('#bossEmoji').classList.add('boss-dead');
    // Progressive best: floors cleared count even if the run ends later.
    const cleared = this.floor;
    if (cleared > Number(localStorage.getItem('bba_dungeon_max') || 0)) {
      localStorage.setItem('bba_dungeon_max', String(cleared));
    }
    if (this.floor >= 100) { this.finish(true); return; }
    confettiBurst(this.info.isBoss ? 45 : 12);
    if (this.info.isBoss) {
      toast(`🎉 ボス撃破！チェックポイント到達（次回からF${this.floor + 1}で再開可能）`, 'announce', 3000);
    }
    view.inputLocked = true;
    this.perkOpen = true;
    this.offerPerk(() => {
      this.perkOpen = false;
      this.floor++;
      this.loadFloor(this.floor);
      const e = this.engine;
      // Mercy: never enter a floor without a legal move.
      if (!e.hasAnyMove()) { e.reviveBoard(); view.reviveFlash(); }
      else e.over = false;
      view.inputLocked = false;
      this.armAttack();
    });
  }

  offerPerk(next) {
    const choices = pickPerks(this);
    const m = showModal(`
      <h2>${this.info.isBoss ? '👑 ボス撃破！' : `✅ F${this.floor} クリア！`}</h2>
      <p class="muted center" style="margin-bottom:10px">ごほうびを1つ選ぼう</p>
      <div class="form-col">
        ${choices.map(p => `
          <button class="btn btn-ghost perk-btn" data-perk="${p.id}">
            <span class="perk-icon">${p.icon}</span>
            <span class="perk-body"><b>${p.name}</b><small>${p.desc}</small></span>
          </button>`).join('')}
      </div>`, { dismissable: false });
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => { this.applyPerk(b.dataset.perk); closeModal(); next(); };
    });
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
    if (this.lives > 1) {
      this.lives--;
      this.engine.reviveBoard();
      getView().reviveFlash();
      toast(`❤️ 残機を使って復活！のこり×${this.lives}`, 'announce', 2200);
      this.updateHud();
    } else {
      this.finish(false);
    }
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    getView().inputLocked = true;
    const cleared = won ? 100 : this.floor - 1;
    if (cleared > Number(localStorage.getItem('bba_dungeon_max') || 0)) {
      localStorage.setItem('bba_dungeon_max', String(cleared));
    }
    if (won) {
      audio.victory();
      confettiBurst(100);
      $('#bossEmoji').classList.add('boss-dead');
    } else if (!this.aborted) {
      audio.gameOver();
    }
    const e = this.engine;
    const rewards = await submitResult({
      mode: 'dungeon', floor: cleared, score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won,
    });
    if (rewards && rewards.badge === 'dungeon') {
      setTimeout(() => { toast('🏰 バッジ「百塔踏破」を獲得！+500💎', 'announce', 6000); confettiBurst(80); }, 1200);
    }
    const cp = Math.floor(cleared / 10) * 10 + 1;
    const banner = won ? '🏆 100F 完全制覇！！' : this.aborted ? `🚪 リタイア（F${this.floor}）` : `F${this.floor} で力尽きた…`;
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>クリアした階</span><b>${won ? '全100階！' : `F${fmt(cleared)}`}</b></div>
        <div class="rs-row"><span>総ダメージ</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>消したライン</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>最大コンボ</span><b>${fmt(e.maxCombo)}</b></div>
        ${won ? '' : `<div class="rs-row"><span>次回の再開地点</span><b>F${cp}</b></div>`}
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-dungeon" id="rAgain">${won ? 'もう一周' : `F${cp}から再挑戦`}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startDungeon(won ? 1 : cp); };
  }

  quit() {
    if (this.ended) return;
    const m = showModal(`
      <h2>🏰 ダンジョンから撤退しますか？</h2>
      <p class="muted center" style="margin-bottom:10px">ここまでにクリアした階は記録されます</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="dqResume">続ける</button>
        <button class="btn btn-ai" id="dqQuit">撤退する</button>
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
    $('#bossPanel').classList.add('hidden');
  }
}

export function startDungeon(startFloor = 1) {
  if (currentMode) currentMode.destroy();
  currentMode = new DungeonMode(startFloor);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Chaos mode (limited-time event, admin-controlled): the rules mutate on an
// interval the player chooses. Duration is also player-chosen (min/sec).
// Pure mayhem, bonus coins.
// ---------------------------------------------------------------------------

const CHAOS_BOARDS = ['board_default', 'board_ocean', 'board_sunset', 'board_forest', 'board_galaxy', 'board_oni', 'board_kami', 'board_sakura', 'board_volcano'];
const CHAOS_MODS = {
  fever:   '🔥 フィーバー！スコア3倍！',
  rain:    '☔ お邪魔ブロックの雨！',
  giant:   '🧱 巨大ブロック時代！',
  mini:    '🐜 ミニブロック時代！',
  heaven:  '✨ 天の恵み！全消し！',
  shuffle: '🌀 大シャッフル！',
  reroll:  '🔄 リロール無限！',
  bomb:    '💣 爆撃！ボードに大穴！',
  freeze:  '⏱️ 時間停止！残り+10秒！',
  gravity: '🧲 重力発生！ブロック落下！',
  cleanse: '🧹 お邪魔ブロック浄化！',
  shield:  '🛡️ コンボプロテクト！',
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
    toast(`🌪️ カオスモード！${this.interval}秒ごとにルールが変わるぞ！`, 'announce', 3000);

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
    $('#hudSub').textContent = this.modName || 'カオス';
  }

  onTopOut() {
    if (this.ended) return;
    toast('ボードリセット！スコアは維持されます', '', 1600);
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
      <div class="result-banner win">${isBest ? '🌪️ カオス新記録！！' : '🌪️ カオス終了！'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>スコア</span><b>${fmt(e.score)}${isBest ? ' 👑' : ''}</b></div>
        <div class="rs-row"><span>自己ベスト</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>発動したルール</span><b>${fmt(this.modCount)}回</b></div>
        <div class="rs-row"><span>消したライン</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>最大コンボ</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewards ? '<div class="rs-row"><span>🎉 イベントボーナス</span><b>コイン1.5倍！</b></div>' : ''}
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-chaos" id="rAgain">もう一回！</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startChaos({ duration: this.duration, interval: this.interval }); };
  }

  quit() {
    if (this.ended) return;
    // Mid-run cancel: let the player abort (no record), cash out early, or resume.
    const m = showModal(`
      <h2>🌪️ カオスモードを中断しますか？</h2>
      <p class="muted center" style="margin-bottom:10px">「中断する」は記録なしでメニューに戻ります。<br>「終了して集計」はここまでのスコアで報酬を受け取ります。</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="cqResume">続ける</button>
        <button class="btn btn-ghost" id="cqAbort">中断する（記録なし）</button>
        <button class="btn btn-chaos" id="cqFinish">終了して集計</button>
      </div>`);
    m.querySelector('#cqResume').onclick = () => { audio.click(); closeModal(); };
    m.querySelector('#cqAbort').onclick = () => {
      audio.click();
      closeModal();
      this.ended = true;
      this.destroy();
      toast('🌪️ カオスモードを中断しました（記録なし）', '', 2200);
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
      .on('room_error', msg => { audio.error(); toast(msg.error, 'err'); })
      .on('raid_state', msg => this.onRaidState(msg))
      .on('raid_attack', msg => this.onRaidAttack(msg))
      .on('emote', msg => this.showEmote(msg.slot, msg.emoji))
      .on('online', msg => {
        this.onlineCount = msg.online;
        const el = $('#mmOnline');
        if (el) el.textContent = msg.online;
      })
      .on('close', () => {
        if (this.ended) return;
        if (this.inMatch || this.kind === 'custom') {
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
        : t('対戦相手を探しています…', 'Looking for an opponent…');
      $('#mmSub').innerHTML = t('オンライン: <span id="mmOnline">-</span>人 ・ 対戦相手を検索中…',
        'Online: <span id="mmOnline">-</span> players ・ searching…');
      $('#mmOnline').textContent = this.onlineCount ?? '-';
      this.client.queue(this.kind);
    }
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
      if (code.length !== 4) { toast('4文字のコードを入力してください', 'err'); return; }
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
        <span class="rp-team">${msg.settings.team ? (i < 2 ? '🟦' : '🟥') : '⚔️'}</span>
        <span class="rp-name">${escapeHtml(p.name)}${p.isYou ? '（あなた）' : ''}</span>
        ${p.isHost ? '<span class="rp-host">👑 ホスト</span>' : ''}
      </div>`).join('');

    const host = msg.youAreHost;
    const s = msg.settings;
    const dis = host ? '' : 'disabled';
    $('#roomSettings').innerHTML = `
      <div class="settings-row"><label>${t('⏱️ 試合時間', '⏱️ Match time')}</label><div class="seg" data-rs="duration">
        ${[60, 120, 180].map(d => `<button data-v="${d}" ${s.duration === d ? 'class="active"' : ''} ${dis}>${d / 60}${t('分', 'min')}</button>`).join('')}
      </div></div>
      <div class="settings-row"><label>${t('👥 モード', '👥 Mode')}</label><div class="seg" data-rs="team">
        <button data-v="false" ${!s.team ? 'class="active"' : ''} ${dis}>1v1</button>
        <button data-v="true" ${s.team ? 'class="active"' : ''} ${dis}>${t('2v2チーム', '2v2 Team')}</button>
      </div></div>
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
          if (key === 'team') v = v === 'true';
          audio.click();
          this.client.setRoom({ [key]: v });
        };
      });
      const bf = $('#rsBotFill');
      if (bf) bf.onchange = e => this.client.setRoom({ botFill: e.target.checked });
    }
  }

  // ---- match ----

  onMatchFound(msg) {
    if (this.inMatch || this.ended) return;   // guard against duplicates
    this.inMatch = true;
    this.matchInfo = msg;
    this.you = msg.you;
    this.isTeam = msg.mode === 'team';
    this.isRaid = msg.mode === 'raid';

    const others = msg.players.filter(p => !p.isYou).map(p => ({
      slot: p.slot,
      name: `${p.name}${p.rating != null ? ` (R${p.rating})` : ''}`,
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
      $('#bossName').textContent = `${msg.boss.name}（レイド）`;
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
    toast(this.isRaid ? t(`🐲 レイド開始！${this.raidBoss ? this.raidBoss.name : ''}を倒せ！`, `🐲 Raid start! Take down ${this.raidBoss ? this.raidBoss.name : 'the boss'}!`)
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
    for (const e of ['👍', '🔥', '😂', '😭', '🎉', '😱']) {
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
    toast(`${this.raidBoss.emoji} ${this.raidBoss.name}の攻撃！`, 'err', 1300);
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

  onResult(msg) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.resultTimeout);
    clearInterval(this.stateInt);
    this.stopTimer();
    getView().inputLocked = true;
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    if (msg.outcome === 'win') { audio.victory(); confettiBurst(); } else audio.gameOver();

    const banners = msg.mode === 'raid'
      ? { win: t(`${msg.boss ? msg.boss.emoji : '🐲'} レイドボス討伐！`, `${msg.boss ? msg.boss.emoji : '🐲'} Raid boss down!`), lose: t('討伐失敗…', 'Raid failed…'), draw: 'DRAW' }
      : { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: 'DRAW' };
    const reasonNote =
      msg.reason === 'forfeit' ? `<p class="muted center">${t('相手が切断しました', 'Your opponent disconnected')}</p>` :
      msg.reason === 'abandoned' ? `<p class="muted center">${t('対戦が中断されました', 'The match was abandoned')}</p>` : '';

    let scoreRows;
    if (msg.mode === 'raid') {
      const total = msg.players.reduce((a, p) => a + p.score, 0);
      scoreRows = `
        <div class="rs-row"><span>${msg.boss ? escapeHtml(msg.boss.name) : t('ボス', 'Boss')} HP</span><b>${fmt(msg.boss ? msg.boss.hp : 0)}</b></div>
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

    const ratingRow = msg.ratingDelta
      ? `<div class="rs-row"><span>${t('📈 レート変動', '📈 Rating')}</span><b style="color:${msg.ratingDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${msg.ratingDelta >= 0 ? '+' : ''}${msg.ratingDelta}</b></div>`
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
      toast(t('🏳️ 対戦から離脱しました（敗北扱い・相手の不戦勝）', '🏳️ You left the match (counts as a loss)'), 'err', 2600);
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
    clearTimeout(this.resultTimeout);
    $('#bossPanel').classList.add('hidden');
    this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function endToMenu() {
  if (currentMode) { currentMode.destroy(); currentMode = null; }
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
