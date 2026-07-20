// Game mode controllers: Solo, VS AI, Online 1v1.
import { Engine } from './engine.js';
import { GameView, MiniBoard } from './game.js';
import { chooseMove, AI_LEVELS } from './ai.js';
import { audio } from './audio.js';
import { session, api, BattleClient } from './net.js';
import { $, showScreen, showModal, closeModal, toast, countdownOverlay, fmt, updateTopbar } from './dom.js';

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
    return `<div class="rs-row"><span>💡 報酬を受け取るにはログイン</span></div>`;
  }
  return `
    <div class="rs-row"><span>🪙 コイン</span><b>+${fmt(rewards.coins)}</b></div>
    <div class="rs-row"><span>🎫 パスXP</span><b>+${fmt(rewards.bpXp)}</b></div>
    <div class="rs-row"><span>⭐ アカウントXP</span><b>+${fmt(rewards.accXp)}</b></div>`;
}

export function quitCurrent() {
  if (currentMode) currentMode.quit();
}

// ---- reroll power-up (1 per game) ----

function updateRerollHud(engine) {
  const btn = $('#btnReroll');
  btn.classList.remove('hidden');
  $('#rerollLeft').textContent = engine.rerolls;
  btn.classList.toggle('off', engine.rerolls <= 0);
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
  if (e.over) {
    if (currentMode.onTopOut) currentMode.onTopOut();
    else currentMode.finish();
  }
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
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    v.start();
    audio.startMusic();
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
    getView().inputLocked = true;
    const e = this.engine;
    if (e.score > guestBest()) setGuestBest(e.score);
    const rewards = await submitResult({
      mode: 'solo', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    const isBest = e.score >= this.best();
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
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.start(); };
  }

  quit() { this.finish(); }
  destroy() {}
}

// ---------------------------------------------------------------------------
// Timed versus base (shared by AI and Online)
// ---------------------------------------------------------------------------

class VersusBase {
  setupHud(oppName) {
    showScreen('game');
    $('#oppPanel').classList.remove('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#oppName').textContent = oppName;
    $('#oppScore').textContent = '0';
    $('#oppCombo').textContent = '';
    this.miniBoard = new MiniBoard($('#oppCanvas'), { skinId: 'skin_default' });
    this.miniBoard.setGrid(new Array(64).fill(0));
    this.timeLeft = MATCH_SECONDS;
    this.updateTimerHud();
    this.updateBars(0, 0);
  }

  updateTimerHud() {
    const t = Math.max(0, Math.ceil(this.timeLeft));
    const mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
    const el = $('#hudTimer');
    el.textContent = `${mm}:${ss}`;
    el.classList.toggle('urgent', t <= 10);
  }

  startTimer(onEnd) {
    this.timerInt = setInterval(() => {
      this.timeLeft -= 0.25;
      this.updateTimerHud();
      if (this.timeLeft <= 0) {
        clearInterval(this.timerInt);
        this.timerInt = null;
        onEnd();
      }
    }, 250);
  }

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

  stopTimer() { if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; } }
}

// ---------------------------------------------------------------------------
// VS AI
// ---------------------------------------------------------------------------

class AiMode extends VersusBase {
  constructor(level) {
    super();
    this.mode = 'ai';
    this.level = level;
    this.cfg = AI_LEVELS[level];
  }

  start() {
    const seed = (Math.random() * 2 ** 31) | 0;
    this.setupHud(`${this.cfg.avatar} AI (${this.cfg.name})`);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine(seed);
    this.aiEngine = new Engine(seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    v.start();
    audio.startMusic();

    const begin = () => countdownOverlay(3, () => {
      v.inputLocked = false;
      this.startTimer(() => this.finish());
      this.aiLoop();
    }, audio);

    if (this.level === 'oni') this.oniIntro(begin);
    else begin();
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

  aiLoop() {
    const jitter = 0.75 + Math.random() * 0.5;
    this.aiTimer = setTimeout(() => {
      if (this.ended) return;
      if (this.aiEngine.over) this.aiEngine.reviveBoard();
      const move = chooseMove(this.aiEngine, this.level);
      if (move) {
        const r = this.aiEngine.place(move.index, move.row, move.col);
        if (r && r.lineCount > 0 && Math.random() < 0.5) {
          $('#oppCombo').textContent = r.streak >= 2 ? `${r.streak} COMBO!` : 'LINE CLEAR!';
          setTimeout(() => { $('#oppCombo').textContent = ''; }, 1200);
        }
      }
      this.miniBoard.setGrid(this.aiEngine.snapshot());
      $('#oppScore').textContent = fmt(this.aiEngine.score);
      this.updateBars(this.engine.score, this.aiEngine.score);
      this.aiLoop();
    }, this.cfg.moveMs * jitter);
  }

  onPlace() {
    this.updateMyHud(this.engine);
    this.updateBars(this.engine.score, this.aiEngine.score);
  }

  onTopOut() {
    // In timed battles a full board revives instead of ending the game.
    if (this.ended) return;
    toast('ボードリセット！スコアは維持されます', '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.aiTimer);
    getView().inputLocked = true;
    const me = this.engine.score, opp = this.aiEngine.score;
    const outcome = me > opp ? 'win' : me < opp ? 'lose' : 'draw';
    if (outcome === 'win') audio.victory(); else audio.gameOver();

    // Beating "hard" unlocks the hidden difficulty.
    if (outcome === 'win' && this.level === 'hard' && localStorage.getItem('bba_oni') !== '1') {
      localStorage.setItem('bba_oni', '1');
      setTimeout(() => toast('👹 隠し難易度「おに」が解放された…！', 'announce', 4000), 1200);
    }

    const rewards = await submitResult({
      mode: this.level === 'oni' ? 'ai_oni' : 'ai', score: me, lines: this.engine.linesCleared,
      maxCombo: this.engine.maxCombo, duration: MATCH_SECONDS, won: outcome === 'win',
    });
    if (rewards && rewards.badge === 'oni') {
      setTimeout(() => toast('👹 バッジ「おに退治」を獲得！', 'announce', 4000), 1200);
    }

    const banners = { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: 'DRAW' };
    const m = showModal(`
      <div class="result-banner ${outcome}">${banners[outcome]}</div>
      <div class="result-stats">
        <div class="rs-row"><span>あなた</span><b>${fmt(me)}</b></div>
        <div class="rs-row"><span>${this.cfg.avatar} AI (${this.cfg.name})</span><b>${fmt(opp)}</b></div>
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
    this.timeLeft = 0;
    this.updateTimerHud();
    this.finish();
  }

  destroy() {
    this.ended = true;
    this.stopTimer();
    clearTimeout(this.aiTimer);
  }
}

// ---------------------------------------------------------------------------
// Online 1v1
// ---------------------------------------------------------------------------

class OnlineMode extends VersusBase {
  constructor() {
    super();
    this.mode = 'pvp';
    this.client = new BattleClient();
  }

  async start() {
    showScreen('matchmaking');
    $('#mmStatus').textContent = 'サーバーに接続中…';
    try {
      const hello = await this.client.connect(localStorage.getItem('bba_guest_name') || undefined);
      $('#mmOnline').textContent = hello.online;
      if (!session.user) localStorage.setItem('bba_guest_name', hello.name);
    } catch (err) {
      toast(err.message, 'err');
      endToMenu();
      return;
    }

    this.client
      .on('queued', () => { $('#mmStatus').textContent = '対戦相手を探しています…'; })
      .on('match_found', msg => this.onMatchFound(msg))
      .on('opp_state', msg => this.onOppState(msg))
      .on('result', msg => this.onResult(msg))
      .on('announce', msg => toast(`📢 ${msg.message}`, 'announce', 5000))
      .on('close', () => {
        if (!this.ended && this.inMatch) {
          toast('サーバーとの接続が切れました', 'err');
          this.ended = true;
          this.destroy();
          endToMenu();
        }
      });

    $('#mmStatus').textContent = '対戦相手を探しています…';
    this.client.queue();
  }

  onMatchFound(msg) {
    this.inMatch = true;
    this.oppInfo = msg.opponent;
    const ratingStr = msg.opponent.rating != null ? ` (R${msg.opponent.rating})` : '';
    this.setupHud(`${msg.opponent.name}${ratingStr}`);
    this.timeLeft = msg.duration || MATCH_SECONDS;
    this.updateTimerHud();
    this.startedAt = Date.now();

    const v = getView();
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    v.start();
    audio.startMusic();
    toast(`⚔️ ${msg.opponent.name} とマッチしました！`, 'ok');

    countdownOverlay(msg.countdown || 3, () => {
      v.inputLocked = false;
      this.startTimer(() => this.timeUp());
      this.stateInt = setInterval(() => this.pushState(), 900);
    }, audio);
  }

  pushState() {
    if (!this.engine || this.ended) return;
    this.client.sendState(this.engine.score, this.engine.streak, this.engine.linesCleared, this.engine.snapshot());
  }

  onPlace() {
    this.updateMyHud(this.engine);
    this.updateBars(this.engine.score, this.oppScore || 0);
    this.pushState();
  }

  onOppState(msg) {
    this.oppScore = msg.score;
    $('#oppScore').textContent = fmt(msg.score);
    if (msg.combo >= 2) {
      $('#oppCombo').textContent = `${msg.combo} COMBO!`;
      setTimeout(() => { $('#oppCombo').textContent = ''; }, 1200);
    }
    if (msg.grid) this.miniBoard.setGrid(msg.grid);
    this.updateBars(this.engine ? this.engine.score : 0, msg.score);
  }

  onTopOut() {
    if (this.ended) return;
    toast('ボードリセット！スコアは維持されます', '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  timeUp() {
    if (this.ended) return;
    getView().inputLocked = true;
    clearInterval(this.stateInt);
    this.client.finish(this.engine.score);
    this.waitModal = showModal(`
      <h2>⌛ 集計中…</h2>
      <p class="muted center">相手の結果を待っています</p>`, { dismissable: false });
    // Safety: if no result within 15s, bail out.
    this.resultTimeout = setTimeout(() => {
      if (!this.ended) { this.ended = true; this.destroy(); closeModal(); toast('結果を受信できませんでした', 'err'); endToMenu(); }
    }, 15000);
  }

  onResult(msg) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.resultTimeout);
    clearInterval(this.stateInt);
    this.stopTimer();
    getView().inputLocked = true;
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    if (msg.outcome === 'win') audio.victory(); else audio.gameOver();

    const banners = { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: 'DRAW' };
    const reasonNote = msg.reason && msg.reason.startsWith('forfeit') ? '<p class="muted center">相手が切断しました</p>' : '';
    const ratingRow = msg.ratingDelta
      ? `<div class="rs-row"><span>📈 レート変動</span><b style="color:${msg.ratingDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${msg.ratingDelta >= 0 ? '+' : ''}${msg.ratingDelta}</b></div>`
      : '';
    const m = showModal(`
      <div class="result-banner ${msg.outcome}">${banners[msg.outcome]}</div>
      ${reasonNote}
      <div class="result-stats">
        <div class="rs-row"><span>あなた</span><b>${fmt(msg.myScore)}</b></div>
        <div class="rs-row"><span>${this.oppInfo ? this.oppInfo.name : '相手'}</span><b>${fmt(msg.oppScore)}</b></div>
        ${ratingRow}
        ${rewardsRows(msg.rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-primary" id="rAgain">もう一戦</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline(); };
  }

  quit() {
    if (this.inMatch && !this.ended) {
      // Forfeit by disconnecting.
      this.ended = true;
      this.destroy();
      toast('対戦を離脱しました', '', 1800);
      endToMenu();
    } else {
      this.client.cancelQueue();
      this.destroy();
      endToMenu();
    }
  }

  destroy() {
    this.stopTimer();
    clearInterval(this.stateInt);
    clearTimeout(this.resultTimeout);
    this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function endToMenu() {
  if (currentMode) { currentMode.destroy(); currentMode = null; }
  if (view) view.stop();
  audio.stopMusic();
  showScreen('menu');
}

export function startSolo() {
  if (currentMode) currentMode.destroy();
  currentMode = new SoloMode();
  currentMode.start();
}

export function startVsAi(level) {
  if (currentMode) currentMode.destroy();
  currentMode = new AiMode(level);
  currentMode.start();
}

export function startOnline() {
  if (currentMode) currentMode.destroy();
  currentMode = new OnlineMode();
  currentMode.start();
}

export function cancelMatchmaking() {
  if (currentMode && currentMode.mode === 'pvp') currentMode.quit();
  else endToMenu();
}

export { endToMenu };
