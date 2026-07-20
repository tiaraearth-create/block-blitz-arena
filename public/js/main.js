// App bootstrap: wire menu, session restore, global buttons.
import { session, refreshMe, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, updateTopbar, fmt } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, cancelMatchmaking, quitCurrent, rerollCurrent, toggleAutopilot } from './modes.js';
import { showAuthModal, showSettingsModal, openLeaderboard, openShop, openBattlePass, openAdmin, bindAdminActions } from './screens.js';
import { AI_LEVELS } from './ai.js';
import { applySettings } from './settings.js';

// ---- menu buttons ----
$('#btnSolo').onclick = () => { audio.click(); startSolo(); };

$('#btnVsAi').onclick = () => {
  audio.click();
  const oniUnlocked = localStorage.getItem('bba_oni') === '1';
  const btnClass = { easy: 'btn-primary', normal: 'btn-ai', hard: 'btn-gold', oni: 'btn-oni' };
  const m = showModal(`
    <h2 id="aiModalTitle">🤖 AI対戦</h2>
    <p class="muted center" style="margin-bottom:12px">2分間のスコアバトル！同じピースが配られます</p>
    <div class="form-col" id="aiLevelList">
      ${Object.entries(AI_LEVELS)
        .filter(([, cfg]) => !cfg.secret || oniUnlocked)
        .map(([key, cfg]) => `
        <button class="btn ${btnClass[key]}" data-ai="${key}">
          ${cfg.avatar} ${cfg.name}
        </button>`).join('')}
    </div>`);
  const wire = () => m.querySelectorAll('[data-ai]').forEach(btn => {
    btn.onclick = () => { closeModal(); startVsAi(btn.dataset.ai); };
  });
  wire();

  // Secret unlock: tap the title 5 times to summon the hidden difficulty.
  let taps = 0;
  m.querySelector('#aiModalTitle').addEventListener('click', () => {
    if (m.querySelector('[data-ai="oni"]')) return;
    if (++taps < 5) return;
    localStorage.setItem('bba_oni', '1');
    const btn = document.createElement('button');
    btn.className = 'btn btn-oni reveal';
    btn.dataset.ai = 'oni';
    btn.textContent = `${AI_LEVELS.oni.avatar} ${AI_LEVELS.oni.name}`;
    m.querySelector('#aiLevelList').appendChild(btn);
    audio.combo(10);
    toast('👹 なにかが めをさました…', 'announce', 3000);
    wire();
  });
};

$('#btnOnline').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>🌐 オンライン対戦</h2>
    <div class="form-col">
      <button class="btn btn-primary btn-big" data-online="duel">⚔️ 1v1 ランクマッチ</button>
      <button class="btn btn-online btn-big" data-online="team">👥 2v2 チーム戦</button>
      <button class="btn btn-gold btn-big" data-online="custom">🔧 カスタムルーム</button>
      <p class="muted center" style="font-size:12px">人数が足りないときはボットが自動参加します</p>
    </div>`);
  m.querySelectorAll('[data-online]').forEach(btn => {
    btn.onclick = () => { closeModal(); startOnline(btn.dataset.online); };
  });
};
$('#btnCancelQueue').onclick = () => { audio.click(); cancelMatchmaking(); };

$('#btnLeaderboard').onclick = () => { audio.click(); openLeaderboard(); };
$('#btnShop').onclick = () => { audio.click(); openShop(); };
$('#btnBattlePass').onclick = () => { audio.click(); openBattlePass(); };
$('#btnAdmin').onclick = () => { audio.click(); openAdmin(); };
$('#userChip').onclick = () => { audio.click(); showAuthModal(); };

// tabs
$$('[data-lb]').forEach(t => { t.onclick = () => openLeaderboard(t.dataset.lb); });
$$('[data-shop]').forEach(t => { t.onclick = () => openShop(t.dataset.shop); });

// back buttons
$$('[data-back]').forEach(b => { b.onclick = () => { audio.click(); showScreen('menu'); }; });

// quit game
$('#btnQuit').onclick = () => {
  const m = showModal(`
    <h2>ゲームを終了しますか？</h2>
    <p class="muted center">対戦中の場合は敗北扱いになることがあります</p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="qNo">続ける</button>
      <button class="btn btn-ai" id="qYes">終了する</button>
    </div>`);
  m.querySelector('#qNo').onclick = closeModal;
  m.querySelector('#qYes').onclick = () => { closeModal(); quitCurrent(); };
};

// settings
$('#btnSettings').onclick = () => { audio.click(); showSettingsModal(); };
applySettings();

// reroll power-up
$('#btnReroll').onclick = () => rerollCurrent();

// autopilot (admin only)
$('#btnAuto').onclick = () => toggleAutopilot();

// unlock audio context on first interaction
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });

bindAdminActions();

// ---- session restore ----
(async () => {
  updateTopbar();
  if (session.token) {
    try {
      const data = await refreshMe();
      updateTopbar();
      if (data.dailyBonus) {
        toast(`🎁 ログインボーナス +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎`, 'ok', 3500);
        audio.coin();
      }
    } catch (err) {
      if (String(err.message).includes('凍結')) toast(err.message, 'err');
      setToken(null);
      session.user = null;
      updateTopbar();
    }
  }
  // season banner
  try {
    if (!session.season) await refreshMe().catch(() => {});
  } catch { /* ignore */ }
  if (session.season) {
    const days = Math.max(0, Math.ceil((session.season.endsAt - Date.now()) / 86400000));
    const banner = $('#seasonBanner');
    banner.textContent = `✨ ${session.season.name} 開催中 — 残り${days}日`;
    banner.classList.remove('hidden');
  }
})();
