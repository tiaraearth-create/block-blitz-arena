// App bootstrap: wire menu, session restore, global buttons.
import { session, refreshMe, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, updateTopbar, fmt } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, cancelMatchmaking, quitCurrent } from './modes.js';
import { showAuthModal, openLeaderboard, openShop, openBattlePass, openAdmin, bindAdminActions } from './screens.js';
import { AI_LEVELS } from './ai.js';

// ---- menu buttons ----
$('#btnSolo').onclick = () => { audio.click(); startSolo(); };

$('#btnVsAi').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>🤖 AI対戦</h2>
    <p class="muted center" style="margin-bottom:12px">2分間のスコアバトル！同じピースが配られます</p>
    <div class="form-col">
      ${Object.entries(AI_LEVELS).map(([key, cfg]) => `
        <button class="btn ${key === 'easy' ? 'btn-primary' : key === 'normal' ? 'btn-ai' : 'btn-gold'}" data-ai="${key}">
          ${cfg.avatar} ${cfg.name}
        </button>`).join('')}
    </div>`);
  m.querySelectorAll('[data-ai]').forEach(btn => {
    btn.onclick = () => { closeModal(); startVsAi(btn.dataset.ai); };
  });
};

$('#btnOnline').onclick = () => { audio.click(); startOnline(); };
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

// sound toggles
const soundBtn = $('#btnSound');
const musicBtn = $('#btnMusic');
soundBtn.onclick = () => {
  audio.setSfx(!audio.sfxOn);
  soundBtn.classList.toggle('off', !audio.sfxOn);
  soundBtn.textContent = audio.sfxOn ? '🔊' : '🔇';
  localStorage.setItem('bba_sfx', audio.sfxOn ? '1' : '0');
  audio.click();
};
musicBtn.onclick = () => {
  audio.setMusic(!audio.musicOn);
  musicBtn.classList.toggle('off', !audio.musicOn);
  localStorage.setItem('bba_music', audio.musicOn ? '1' : '0');
};
if (localStorage.getItem('bba_sfx') === '0') { audio.sfxOn = false; soundBtn.classList.add('off'); soundBtn.textContent = '🔇'; }
if (localStorage.getItem('bba_music') === '0') { audio.musicOn = false; musicBtn.classList.add('off'); }

// unlock audio context on first interaction
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });

bindAdminActions();

// ---- session restore ----
(async () => {
  updateTopbar();
  if (session.token) {
    try {
      await refreshMe();
      updateTopbar();
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
