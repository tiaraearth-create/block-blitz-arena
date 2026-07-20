// App bootstrap: wire menu, session restore, global buttons.
import { session, refreshMe, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, updateTopbar, fmt } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, startBoss, startBossRush, cancelMatchmaking, quitCurrent, rerollCurrent, toggleAutopilot, showAdminPalette } from './modes.js';
import { showAuthModal, showSettingsModal, showGemShop, loadTitles, openLeaderboard, openShop, openBattlePass, openAdmin, bindAdminActions } from './screens.js';
import { confettiBurst } from './dom.js';
import { AI_LEVELS } from './ai.js';
import { applySettings } from './settings.js';

// ---- menu buttons ----
$('#btnSolo').onclick = () => { audio.click(); startSolo(); };

$('#btnVsAi').onclick = () => {
  audio.click();
  const kamiUnlocked = localStorage.getItem('bba_kami') === '1';
  const souzouUnlocked = localStorage.getItem('bba_souzou') === '1';
  const unlocked = key => key === 'kami' ? kamiUnlocked : key === 'souzou' ? souzouUnlocked : true;
  const btnClass = { easy: 'btn-primary', normal: 'btn-ai', hard: 'btn-gold', oni: 'btn-oni', kami: 'btn-kami', souzou: 'btn-souzou' };
  const m = showModal(`
    <h2 id="aiModalTitle">🤖 AI対戦</h2>
    <p class="muted center" style="margin-bottom:12px">2分間のスコアバトル！同じピースが配られます</p>
    <div class="form-col" id="aiLevelList">
      ${Object.entries(AI_LEVELS)
        .filter(([key]) => unlocked(key))
        .map(([key, cfg]) => `
        <button class="btn ${btnClass[key]}" data-ai="${key}">
          ${cfg.avatar} ${cfg.name}
        </button>`).join('')}
    </div>`);
  const wire = () => m.querySelectorAll('[data-ai]').forEach(btn => {
    btn.onclick = () => { closeModal(); startVsAi(btn.dataset.ai); };
  });
  wire();

  // Touch fallback for the secret command: tap the title 10 times.
  let taps = 0;
  m.querySelector('#aiModalTitle').addEventListener('click', () => {
    if (m.querySelector('[data-ai="kami"]')) return;
    if (++taps < 10) return;
    unlockKami();
    const btn = document.createElement('button');
    btn.className = 'btn btn-kami reveal';
    btn.dataset.ai = 'kami';
    btn.textContent = `${AI_LEVELS.kami.avatar} ${AI_LEVELS.kami.name}`;
    m.querySelector('#aiLevelList').appendChild(btn);
    wire();
  });
};

// ---- secret command (Konami code) unlocks 神 ----
function unlockKami() {
  if (localStorage.getItem('bba_kami') === '1') return;
  localStorage.setItem('bba_kami', '1');
  audio.kamiDescend();
  confettiBurst(50);
  toast('🔱 天から声が聞こえる……隠し難易度「神」が解放された', 'announce', 5000);
}

function unlockSouzou() {
  if (localStorage.getItem('bba_souzou') === '1') return;
  localStorage.setItem('bba_souzou', '1');
  localStorage.setItem('bba_kami', '1');
  audio.kamiDescend();
  audio.bossAttack();
  confettiBurst(80);
  toast('🌌 宇宙の彼方から視線を感じる……真の隠し難易度「創造神」が姿を現した', 'announce', 6000);
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
// 超絶コマンド: コナミコマンドの後に BABA↓↑↓↑ を続ける
const SOUZOU = [...KONAMI, 'b', 'a', 'b', 'a', 'ArrowDown', 'ArrowUp', 'ArrowDown', 'ArrowUp'];
let konamiPos = 0;
let souzouPos = 0;
window.addEventListener('keydown', e => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === KONAMI[konamiPos]) {
    konamiPos++;
    if (konamiPos === KONAMI.length) { konamiPos = 0; unlockKami(); }
  } else {
    konamiPos = k === KONAMI[0] ? 1 : 0;
  }
  if (k === SOUZOU[souzouPos]) {
    souzouPos++;
    if (souzouPos === SOUZOU.length) { souzouPos = 0; unlockSouzou(); }
  } else {
    souzouPos = k === SOUZOU[0] ? 1 : 0;
  }
});

// ---- boss battles ----
async function openBossSelect(preferIndex = null) {
  audio.click();
  try {
    const headers = {};
    const token = localStorage.getItem('bba_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    const data = await fetch('/api/bosses', { headers }).then(r => r.json());
    const bossMax = Math.max(data.bossMax || 0, Number(localStorage.getItem('bba_boss_max') || 0));
    const m = showModal(`
      <h2>🐲 ボス戦</h2>
      <p class="muted center" style="margin-bottom:12px">ラインを消してダメージを与えろ！<br>ボスはお邪魔ブロックで反撃してくる。盤面が埋まったら敗北！</p>
      <div class="form-col">
        ${data.bosses.map((b, i) => {
          const locked = i > bossMax;
          const cleared = i < bossMax;
          return `
          <button class="btn boss-select ${locked ? 'btn-ghost' : 'btn-boss'}" data-boss="${i}" ${locked ? 'disabled' : ''}>
            <span>${locked ? '🔒' : b.emoji} ${b.name}</span>
            <small>${locked ? '前のボスを倒すと解放' : `HP ${Number(b.hp).toLocaleString()}${cleared ? ' ・ ✓討伐済' : ''}`}</small>
          </button>`;
        }).join('')}
        ${(() => {
          const rushOpen = bossMax >= data.bosses.length;
          return `
          <button class="btn boss-select ${rushOpen ? 'btn-oni' : 'btn-ghost'}" data-rush ${rushOpen ? '' : 'disabled'}>
            <span>${rushOpen ? '⚔️' : '🔒'} ボスラッシュ</span>
            <small>${rushOpen ? '全4体を連戦！休憩なし・1ミスで終了' : '全ボスを討伐すると解放'}</small>
          </button>`;
        })()}
      </div>`);
    const rushBtn = m.querySelector('[data-rush]:not([disabled])');
    if (rushBtn) rushBtn.onclick = () => { closeModal(); startBossRush(data.bosses); };
    m.querySelectorAll('[data-boss]:not([disabled])').forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.dataset.boss);
        closeModal();
        startBoss(data.bosses[i], i, data.bosses.length);
      };
    });
    if (preferIndex !== null) {
      const btn = m.querySelector(`[data-boss="${preferIndex}"]:not([disabled])`);
      if (btn) btn.classList.add('reveal');
    }
  } catch {
    toast('ボス情報を取得できません', 'err');
  }
}
window.__bbaOpenBossSelect = openBossSelect;
$('#btnBoss').onclick = () => openBossSelect();

$('#btnOnline').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>🌐 オンライン対戦</h2>
    <div class="form-col">
      <button class="btn btn-primary btn-big" data-online="duel">⚔️ 1v1 ランクマッチ</button>
      <button class="btn btn-online btn-big" data-online="team">👥 2v2 チーム戦</button>
      <button class="btn btn-boss btn-big" data-online="raid">🐲 レイドボス戦（協力）</button>
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
$('#btnGemShop').onclick = () => { audio.click(); showGemShop(); };
$('#btnBattlePass').onclick = () => { audio.click(); openBattlePass(); };
$('#btnAdmin').onclick = () => { audio.click(); openAdmin(); };
$('#userChip').onclick = () => { audio.click(); showAuthModal(); };
document.querySelector('.gem-chip').style.cursor = 'pointer';
document.querySelector('.gem-chip').onclick = () => { audio.click(); showGemShop(); };

// tabs
$$('[data-lb]').forEach(t => { t.onclick = () => openLeaderboard(t.dataset.lb); });
$$('[data-shop]').forEach(t => { t.onclick = () => openShop(t.dataset.shop); });

// back buttons
$$('[data-back]').forEach(b => { b.onclick = () => { audio.click(); showScreen('menu'); }; });

// quit game
$('#btnQuit').onclick = () => {
  const m = showModal(`
    <h2>ゲームを終了しますか？</h2>
    <p class="muted center">オンライン対戦の離脱は<b style="color:var(--red)">敗北</b>になります。<br>それ以外のモードは引き分け扱いです</p>
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

// autopilot + command palette (admin only)
$('#btnAuto').onclick = () => toggleAutopilot();
$('#btnAdminCmd').onclick = () => showAdminPalette();

// unlock audio context on first interaction and start menu music
window.addEventListener('pointerdown', () => {
  audio.ensure();
  if (!audio.playing) audio.playTrack(audio.trackName || 'menu');
}, { once: true });

// live online counter on the menu
async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    $('#onlineCount').textContent = data.online;
    $('#onlineBadge').classList.remove('hidden');
  } catch { /* server unreachable — keep hidden */ }
}
pollStatus();
setInterval(pollStatus, 30000);

bindAdminActions();
loadTitles();

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
      // Only drop the session on real auth errors — keep it through outages.
      if (err.status === 401 || err.status === 403) {
        setToken(null);
        session.user = null;
      }
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
