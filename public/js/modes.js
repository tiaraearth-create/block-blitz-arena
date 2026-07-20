// Game mode controllers: Solo, VS AI, Online (1v1 / 2v2 team / custom rooms),
// plus the admin-only autopilot.
import { Engine } from './engine.js';
import { GameView, MiniBoard } from './game.js';
import { chooseMove, AI_LEVELS } from './ai.js';
import { audio } from './audio.js';
import { session, api, refreshMe, BattleClient } from './net.js';
import { $, showScreen, showModal, closeModal, toast, countdownOverlay, fmt, updateTopbar, confettiBurst } from './dom.js';

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
    return `<div class="rs-row"><span>💡 報酬を受け取るにはログイン</span></div>`;
  }
  return `
    <div class="rs-row"><span>🪙 コイン</span><b>+${fmt(rewards.coins)}</b></div>
    ${rewards.gems ? `<div class="rs-row"><span>💎 初回討伐ボーナス</span><b>+${fmt(rewards.gems)}</b></div>` : ''}
    <div class="rs-row"><span>🎫 パスXP</span><b>+${fmt(rewards.bpXp)}</b></div>
    <div class="rs-row"><span>⭐ アカウントXP</span><b>+${fmt(rewards.accXp)}</b></div>`;
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
  $('#rerollLeft').textContent = engine.rerolls;
  btn.classList.toggle('off', engine.rerolls <= 0);
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
      <button class="btn btn-ghost btn-sm" data-cmd="bosshalf">👹 ボスHP 半減</button>
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
      if (!mode || mode.mode !== 'boss') return toast('ボス戦のみ使えます', 'err');
      mode.hp = Math.ceil(mode.hp / 2);
      mode.updateHpBar();
      toast('👹 ボスHPを半減しました', 'ok', 1400);
      if (mode.hp <= 0) mode.finish(true);
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
      } else if (m.engine.rerolls > 0) {
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
    toast('ボードリセット！スコアは維持されます', '', 1800);
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
    $('#bossPanel').classList.remove('hidden');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    $('#bossEmoji').textContent = this.boss.emoji;
    $('#bossEmoji').className = 'boss-emoji';
    $('#bossName').textContent = this.boss.name;
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
    $('#bossPanel').classList.remove('hidden');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
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
      $('#mmStatus').textContent = 'サーバーに接続中…';
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
      .on('close', () => {
        if (this.ended) return;
        if (this.inMatch || this.kind === 'custom') {
          toast('サーバーとの接続が切れました', 'err');
          this.ended = true;
          this.destroy();
          endToMenu();
        }
      });

    if (this.kind !== 'custom') {
      $('#mmStatus').textContent = this.kind === 'team'
        ? 'チームメンバーを探しています…'
        : this.kind === 'raid'
        ? 'レイドパーティを募集しています…'
        : '対戦相手を探しています…';
      $('#mmSub').innerHTML = this.kind === 'team'
        ? 'オンライン: <span id="mmOnline">-</span>人 ・ 人数が足りない分はボットが参加します'
        : 'オンライン: <span id="mmOnline">-</span>人 ・ 10秒待つとボットが相手になります';
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
      <div class="settings-row"><label>⏱️ 試合時間</label><div class="seg" data-rs="duration">
        ${[60, 120, 180].map(d => `<button data-v="${d}" ${s.duration === d ? 'class="active"' : ''} ${dis}>${d / 60}分</button>`).join('')}
      </div></div>
      <div class="settings-row"><label>👥 モード</label><div class="seg" data-rs="team">
        <button data-v="false" ${!s.team ? 'class="active"' : ''} ${dis}>1v1</button>
        <button data-v="true" ${s.team ? 'class="active"' : ''} ${dis}>2v2チーム</button>
      </div></div>
      <div class="settings-row"><label>🤖 ボット補充</label><input type="checkbox" id="rsBotFill" ${s.botFill ? 'checked' : ''} ${dis}></div>
      <div class="settings-row"><label>💪 ボットの強さ</label><div class="seg" data-rs="botLevel">
        ${[['easy', '弱'], ['normal', '中'], ['hard', '強']].map(([v, l]) =>
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
    toast(this.isRaid ? `🐲 レイド開始！${this.raidBoss ? this.raidBoss.name : ''}を倒せ！`
      : this.isTeam ? '👥 チーム戦スタート！' : '⚔️ マッチしました！', 'ok');

    countdownOverlay(msg.countdown || 3, () => {
      v.inputLocked = false;
      this.startTimer(() => this.timeUp());
      this.stateInt = setInterval(() => this.pushState(), 900);
    }, audio);
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
    toast('ボードリセット！スコアは維持されます', '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  timeUp() {
    if (this.ended) return;
    getView().inputLocked = true;
    clearInterval(this.stateInt);
    this.client.finish(this.engine.score, this.engine.linesCleared, this.engine.maxCombo);
    showModal(`
      <h2>⌛ 集計中…</h2>
      <p class="muted center">全員の結果を待っています</p>`, { dismissable: false });
    this.resultTimeout = setTimeout(() => {
      if (!this.ended) {
        this.ended = true;
        this.destroy();
        closeModal();
        toast('結果を受信できませんでした', 'err');
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
      ? { win: `${msg.boss ? msg.boss.emoji : '🐲'} レイドボス討伐！`, lose: '討伐失敗…', draw: 'DRAW' }
      : { win: '🏆 YOU WIN!', lose: 'YOU LOSE…', draw: 'DRAW' };
    const reasonNote =
      msg.reason === 'forfeit' ? '<p class="muted center">相手が切断しました</p>' :
      msg.reason === 'abandoned' ? '<p class="muted center">対戦が中断されました</p>' : '';

    let scoreRows;
    if (msg.mode === 'raid') {
      const total = msg.players.reduce((a, p) => a + p.score, 0);
      scoreRows = `
        <div class="rs-row"><span>${msg.boss ? escapeHtml(msg.boss.name) : 'ボス'} HP</span><b>${fmt(msg.boss ? msg.boss.hp : 0)}</b></div>
        <div class="rs-row"><span>パーティ総ダメージ</span><b>${fmt(total)}</b></div>
        ${msg.players.map(p => `<div class="rs-row"><span>${p.slot === msg.you.slot ? '⭐あなた' : (p.isBot ? '' : '👤') + escapeHtml(p.name)}</span><b>${fmt(p.score)}</b></div>`).join('')}`;
    } else if (msg.mode === 'team') {
      const teamRow = t => {
        const members = msg.players.filter(p => p.team === t);
        const names = members.map(p => `${p.slot === msg.you.slot ? '⭐' : p.isBot ? '' : '👤'}${escapeHtml(p.name)} ${fmt(p.score)}`).join('<br>');
        const label = t === msg.you.team ? 'あなたのチーム' : '相手チーム';
        return `<div class="rs-row team-row"><span>${label}<br><small class="muted">${names}</small></span><b>${fmt(msg.teamScores[t])}</b></div>`;
      };
      scoreRows = teamRow(msg.you.team) + teamRow(1 - msg.you.team);
    } else {
      scoreRows = msg.players
        .sort((a, b) => (a.slot === msg.you.slot ? -1 : b.slot === msg.you.slot ? 1 : 0))
        .map(p => `<div class="rs-row"><span>${p.slot === msg.you.slot ? 'あなた' : escapeHtml(p.name)}</span><b>${fmt(p.score)}</b></div>`)
        .join('');
    }

    const ratingRow = msg.ratingDelta
      ? `<div class="rs-row"><span>📈 レート変動</span><b style="color:${msg.ratingDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${msg.ratingDelta >= 0 ? '+' : ''}${msg.ratingDelta}</b></div>`
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
        <button class="btn btn-ghost" id="rMenu">メニュー</button>
        <button class="btn btn-primary" id="rAgain">${this.kind === 'custom' ? 'ルームへ' : 'もう一戦'}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline(this.kind); };
  }

  quit() {
    if (this.inMatch && !this.ended) {
      this.ended = true;
      this.destroy();
      toast('🏳️ 対戦から離脱しました（敗北扱い・相手の不戦勝）', 'err', 2600);
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
