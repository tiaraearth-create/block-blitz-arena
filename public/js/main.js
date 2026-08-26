// App bootstrap: wire menu, session restore, global buttons.
import { session, api, refreshMe, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, updateTopbar, fmt, staffExtras } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, startBoss, startBossRush, startChaos, startDungeon, startWeekly, startSurvival, startSprint, sprintBest, SPRINT_DURATIONS, cancelMatchmaking, quitCurrent, rerollCurrent, fireUltCurrent, DUNGEON_REALMS, startMeltdown, startChimera, startPuzzle, startDig, puzzleBestStage, startGhost, ghostUnlocked } from './modes.js';
import { showAdminPalette, quickAutopilot, showAutopilotPanel, startGodLoop } from './admintools.js';
import { showAuthModal, showSettingsModal, showGemShop, loadTitles, openLeaderboard, openShop, openInventory, openBattlePass, openAdmin, bindAdminActions, openGacha, openMissions, refreshMissionDot, openPoll, refreshPollBanner, showRestoreModal, openGuild, openNews, showRankRewardsModal } from './screens.js';
import { confettiBurst } from './dom.js';
import { AI_LEVELS } from './ai.js';
import { applySettings } from './settings.js';
import { initChat, reconnectChat, showFeedModal, setMood, updateNewsDot } from './chat.js';
import { setAdminEvent } from './adminevent.js';
import { t, setLang, LANG, applyStaticI18n, catName } from './i18n.js';

applyStaticI18n();

// Admins have every unlockable open from the start.
const isAdminUser = () => !!session.user && session.user.role === 'admin';

// ---- menu buttons ----
$('#btnSolo').onclick = () => { audio.click(); startSolo(); };

$('#btnVsAi').onclick = () => {
  audio.click();
  const kamiUnlocked = localStorage.getItem('bba_kami') === '1' || isAdminUser();
  const souzouUnlocked = localStorage.getItem('bba_souzou') === '1' || isAdminUser();
  const unlocked = key => key === 'kami' ? kamiUnlocked : key === 'souzou' ? souzouUnlocked : true;
  const btnClass = { easy: 'btn-primary', normal: 'btn-ai', hard: 'btn-gold', oni: 'btn-oni', kami: 'btn-kami', souzou: 'btn-souzou' };
  const m = showModal(`
    <h2 id="aiModalTitle">${t('🤖 AI対戦', '🤖 VS AI')}</h2>
    <p class="muted center" style="margin-bottom:12px">${t('2分間のスコアバトル！同じピースが配られます', 'A 2-minute score battle! You both get the same pieces')}</p>
    <div class="form-col" id="aiLevelList">
      ${Object.entries(AI_LEVELS)
        .filter(([key]) => unlocked(key))
        .map(([key, cfg]) => `
        <button class="btn ${btnClass[key]}" data-ai="${key}">
          ${cfg.avatar} ${t(cfg.name, cfg.nameEn || cfg.name)}
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
    btn.textContent = `${AI_LEVELS.kami.avatar} ${t(AI_LEVELS.kami.name, AI_LEVELS.kami.nameEn || AI_LEVELS.kami.name)}`;
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
  toast(t('🔱 天から声が聞こえる……隠し難易度「神」が解放された', '🔱 A voice echoes from the heavens… hidden difficulty "Kami" unlocked!'), 'announce', 5000);
}

function unlockSouzou() {
  if (localStorage.getItem('bba_souzou') === '1') return;
  localStorage.setItem('bba_souzou', '1');
  localStorage.setItem('bba_kami', '1');
  audio.kamiDescend();
  audio.bossAttack();
  confettiBurst(80);
  toast(t('🌌 宇宙の彼方から視線を感じる……真の隠し難易度「創造神」が姿を現した', '🌌 Something watches from beyond the cosmos… the true hidden difficulty "Creator God" has appeared!'), 'announce', 6000);
}

// ---- 👻 幽霊屋敷: メニューのロゴを13回連続タップで解放 ----
function updateGhostButton() {
  $('#btnGhost').classList.toggle('hidden', !ghostUnlocked());
}

function unlockGhost() {
  if (localStorage.getItem('bba_ghost') === '1') return;
  localStorage.setItem('bba_ghost', '1');
  document.body.classList.add('ghost-flicker');
  setTimeout(() => document.body.classList.remove('ghost-flicker'), 3500);
  audio.gameOver();
  setTimeout(() => audio.kamiDescend(), 900);
  toast(t('👻 ……見つかってしまった。メニューに「幽霊屋敷」への扉が現れた', '👻 …it has noticed you. A door to the Haunted House has appeared on the menu'), 'announce', 6000);
  updateGhostButton();
}

let ghostTaps = 0;
let ghostTapTimer = null;
document.querySelector('.logo').addEventListener('click', () => {
  ghostTaps++;
  clearTimeout(ghostTapTimer);
  ghostTapTimer = setTimeout(() => { ghostTaps = 0; }, 2000);   // 2秒空いたらリセット
  // 10回目から不穏な気配（音が少しずつ低く沈む）
  if (ghostTaps >= 10 && ghostTaps < 13) audio.putback();
  if (ghostTaps === 13) { ghostTaps = 0; unlockGhost(); }
});

$('#btnGhost').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_ghost_best') || 0),
    session.user ? (session.user.stats.ghostBest || 0) : 0);
  const m = showModal(`
    <h2>👻 ${t('幽霊屋敷', 'Haunted House')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('この屋敷では、置いたブロックが<b>約1秒で透明になる</b>。頼れるのは記憶だけ。<br><small>ラインを消した瞬間だけ、盤面のすべてが姿を現す。ドラッグ中の影が唯一の手がかり — 初回15,000点で👻バッジ＋💎250。</small>',
          'In this house, placed blocks <b>turn invisible after a second</b>. Memory is all you have.<br><small>Every line clear reveals the whole board for a moment. Your drag shadow is the only other clue — first 15,000 earns the 👻 badge + 250💎.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="ghCancel">${t('逃げる', 'Run away')}</button>
      <button class="btn btn-ghostmode" id="ghStart">👻 ${t('屋敷に入る', 'Enter the house')}</button>
    </div>`);
  m.querySelector('#ghCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#ghStart').onclick = () => { audio.click(); closeModal(); startGhost(); };
};

updateGhostButton();   // 解放済み(またはadmin)なら最初から扉が見えている

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
      <h2>${t('🐲 ボス戦', '🐲 Boss Battle')}</h2>
      <p class="muted center" style="margin-bottom:12px">${t('ラインを消してダメージを与えろ！<br>ボスはお邪魔ブロックで反撃してくる。盤面が埋まったら敗北！', 'Clear lines to damage the boss!<br>It fights back with garbage blocks. Fill up the board and you lose!')}</p>
      <div class="form-col">
        ${data.bosses.map((b, i) => {
          const locked = i > bossMax;
          const cleared = i < bossMax;
          return `
          <button class="btn boss-select ${locked ? 'btn-ghost' : 'btn-boss'}" data-boss="${i}" ${locked ? 'disabled' : ''}>
            <span>${locked ? '🔒' : b.emoji} ${catName(b)}</span>
            <small>${locked ? t('前のボスを倒すと解放', 'Beat the previous boss to unlock') : `HP ${Number(b.hp).toLocaleString()}${cleared ? t(' ・ ✓討伐済', ' ・ ✓cleared') : ''}`}</small>
          </button>`;
        }).join('')}
        ${(() => {
          // 無限地獄は最初の4体を倒せば解放。周回対象は解放済みボスのみ。
          const rushOpen = bossMax >= 4;
          const depthBest = Math.max(Number(localStorage.getItem('bba_rush_depth') || 0),
            session.user ? (session.user.stats.rushDepth || 0) : 0);
          return `
          <button class="btn boss-select ${rushOpen ? 'btn-oni' : 'btn-ghost'}" data-rush ${rushOpen ? '' : 'disabled'}>
            <span>${rushOpen ? '⚔️' : '🔒'} ${t('無限地獄ラッシュ', 'Infinite Hell Rush')}</span>
            <small>${rushOpen
              ? t(`遺物ビルド×無限周回のローグライク連戦${depthBest ? ` ・ 最深記録 ${depthBest}体` : ''}`, `Relic-build roguelike gauntlet${depthBest ? ` ・ best depth ${depthBest}` : ''}`)
              : t('最初の4ボスを討伐すると解放', 'Defeat the first 4 bosses to unlock')}</small>
          </button>`;
        })()}
      </div>`);
    const rushBtn = m.querySelector('[data-rush]:not([disabled])');
    if (rushBtn) rushBtn.onclick = () => { closeModal(); startBossRush(data.bosses.slice(0, Math.max(4, bossMax))); };
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
    toast(t('ボス情報を取得できません', 'Could not load boss data'), 'err');
  }
}
window.__bbaOpenBossSelect = openBossSelect;
$('#btnBoss').onclick = () => openBossSelect();

$('#btnOnline').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>${t('🌐 オンライン対戦', '🌐 Online Battle')}</h2>
    <div class="form-col">
      <button class="btn btn-primary btn-big" data-online="duel">${t('⚔️ 1v1 ランクマッチ', '⚔️ 1v1 Ranked')}</button>
      <button class="btn btn-melt btn-big" data-online="attack">${t('💥 アタック戦（NEW! 妨害あり）', '💥 Attack Duel (NEW! send garbage)')}</button>
      <button class="btn btn-online btn-big" data-online="team">${t('👥 2v2 チーム戦', '👥 2v2 Team Battle')}</button>
      <button class="btn btn-gold btn-big" data-online="tourney">${t('🏆 トーナメント（8人制）', '🏆 Tournament (8 players)')}</button>
      <button class="btn btn-oni btn-big" data-online="royale">${t('💯 バトルロイヤル（100人）', '💯 Battle Royale (100 players)')}</button>
      <button class="btn btn-boss btn-big" data-online="raid">${t('🐲 レイドボス戦（協力）', '🐲 Raid Boss (co-op)')}</button>
      <button class="btn btn-coop btn-big" data-online="coop">${t('🤝 協力プレイ（2人で1盤面）', '🤝 Co-op (2 players, 1 board)')}</button>
      <button class="btn btn-online btn-big" data-online="custom">${t('🔧 カスタムルーム', '🔧 Custom Room')}</button>
    </div>`);
  m.querySelectorAll('[data-online]').forEach(btn => {
    btn.onclick = () => { closeModal(); startOnline(btn.dataset.online); };
  });
};
$('#btnCancelQueue').onclick = () => { audio.click(); cancelMatchmaking(); };

$('#btnMissions').onclick = () => { audio.click(); openMissions(); };
$('#btnLeaderboard').onclick = () => { audio.click(); openLeaderboard(); };
$('#btnInventory').onclick = () => { audio.click(); openInventory(); };
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
$$('[data-inv]').forEach(t => { t.onclick = () => { audio.click(); openInventory(t.dataset.inv); }; });
$$('[data-ms]').forEach(t => { t.onclick = () => { audio.click(); openMissions(t.dataset.ms); }; });

// back buttons
$$('[data-back]').forEach(b => { b.onclick = () => { audio.click(); showScreen('menu'); }; });

// quit game
$('#btnQuit').onclick = () => {
  // Chaos and dungeon have their own quit dialogs.
  const cur = window.__bbaMode;
  if (cur && (cur.mode === 'chaos' || cur.mode === 'dungeon') && !cur.ended) { audio.click(); quitCurrent(); return; }
  const m = showModal(`
    <h2>${t('ゲームを終了しますか？', 'Quit this game?')}</h2>
    <p class="muted center">${t('オンライン対戦の離脱は<b style="color:var(--red)">敗北</b>になります。<br>それ以外のモードは引き分け扱いです', 'Leaving an online battle counts as a <b style="color:var(--red)">loss</b>.<br>Other modes count as a draw')}</p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="qNo">${t('続ける', 'Keep playing')}</button>
      <button class="btn btn-ai" id="qYes">${t('終了する', 'Quit')}</button>
    </div>`);
  m.querySelector('#qNo').onclick = closeModal;
  m.querySelector('#qYes').onclick = () => { closeModal(); quitCurrent(); };
};

// settings
$('#btnSettings').onclick = () => { audio.click(); showSettingsModal(); };
applySettings();

// reroll power-up
$('#btnReroll').onclick = () => rerollCurrent();

// ultimate skill: HUD button + spacebar
$('#btnUlt').onclick = () => fireUltCurrent();
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' && e.key !== 'q') return;
  if (document.body.dataset.screen !== 'game') return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  e.preventDefault();
  fireUltCurrent();
});

// autopilot + command palette (admin only): tap = on/faster/off, hold = settings
{
  const auto = $('#btnAuto');
  let holdTimer = null, held = false;
  auto.addEventListener('pointerdown', () => { held = false; holdTimer = setTimeout(() => { held = true; showAutopilotPanel(); }, 550); });
  const release = () => clearTimeout(holdTimer);
  auto.addEventListener('pointerup', release);
  auto.addEventListener('pointerleave', release);
  auto.addEventListener('pointercancel', release);
  auto.onclick = () => { if (!held) quickAutopilot(); };
  auto.oncontextmenu = e => { e.preventDefault(); showAutopilotPanel(); };
}
$('#btnAdminCmd').onclick = () => showAdminPalette();
startGodLoop();

// ---- audio boot: autoplay if allowed, otherwise tap-to-start splash ----
function startAudioNow() {
  audio.ensure();
  // Always register the menu track as the game's request — a jukebox-locked
  // track may already be sounding, and without this the "おまかせ" reset
  // would have nothing to fall back to. No-op when already playing it.
  audio.playTrack(audio.trackName || 'menu');
}

function dismissSplash(e) {
  // Swallow the event completely so the tap can NEVER reach buttons
  // underneath the splash (the splash keeps intercepting during its fade).
  if (e) { e.preventDefault(); e.stopPropagation(); }
  // First visit: the splash doubles as the language picker — a stray tap
  // must not skip it. The picker buttons store the language, then call us.
  if (!localStorage.getItem('bba_lang')) return;
  const splash = $('#tapStart');
  if (!splash.classList.contains('hidden')) {
    splash.classList.add('ts-out');
    setTimeout(() => splash.classList.add('hidden'), 600);
  }
  startAudioNow();
}

{
  const splash = $('#tapStart');
  // First launch: pick a language before anything else.
  if (!localStorage.getItem('bba_lang')) {
    splash.querySelector('.ts-tap').classList.add('hidden');
    const pick = document.createElement('div');
    pick.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:22px;align-items:center';
    pick.innerHTML = `
      <button class="btn btn-primary btn-big" data-lang="ja">🇯🇵 日本語ではじめる</button>
      <button class="btn btn-online btn-big" data-lang="en">🌍 Play in English</button>
      <small style="opacity:.65">Language / 言語はあとで⚙️設定から変更できます</small>`;
    splash.appendChild(pick);
    pick.querySelectorAll('[data-lang]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const lang = b.dataset.lang;
        setLang(lang);
        if (lang !== LANG) { location.reload(); return; }   // re-render in the chosen language
        pick.remove();
        splash.querySelector('.ts-tap').classList.remove('hidden');
        dismissSplash();
      });
    });
  }
  // Block every pointer/click event on the splash from bubbling through.
  splash.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  splash.addEventListener('pointerup', e => { e.preventDefault(); e.stopPropagation(); });
  splash.addEventListener('click', dismissSplash);
  window.addEventListener('keydown', function onKey(e) {
    if (!splash.classList.contains('hidden')) dismissSplash();
    window.removeEventListener('keydown', onKey);
  });
  // Fallback audio unlock for the no-splash (autoplay-allowed) case.
  window.addEventListener('pointerdown', () => startAudioNow(), { once: true });
}

(async () => {
  // Try silent autoplay first — succeeds on repeat visits where the browser
  // has granted audio permission; otherwise show the tap-to-start splash.
  // First launch (no language chosen yet): ALWAYS show the splash — it
  // doubles as the language picker.
  audio.ensure();
  await new Promise(r => setTimeout(r, 250));
  if (!localStorage.getItem('bba_lang')) {
    $('#tapStart').classList.remove('hidden');
  } else if (audio.ctx && audio.ctx.state === 'running') {
    startAudioNow();
  } else {
    $('#tapStart').classList.remove('hidden');
  }
})();

// live online counter + limited-time event on the menu
window.__bbaEvent = null;

function fmtRemain(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const u = { d: t('日', 'd '), h: t('時間', 'h '), m: t('分', 'm '), s: t('秒', 's') };
  if (s >= 86400) return `${Math.floor(s / 86400)}${u.d}${Math.floor((s % 86400) / 3600)}${u.h}`.trim();
  if (s >= 3600) return `${Math.floor(s / 3600)}${u.h}${Math.floor((s % 3600) / 60)}${u.m}`.trim();
  if (s >= 60) return `${Math.floor(s / 60)}${u.m}${s % 60 ? `${s % 60}${u.s}` : ''}`.trim();
  return `${s}${u.s}`;
}

function updateEventBanner() {
  const banner = $('#eventBanner');
  const btn = $('#btnChaos');
  const ev = window.__bbaEvent;
  if (ev && ev.endsAt > Date.now()) {
    const icon = ev.icon || '🌪️';
    banner.textContent = t(`${icon} 期間限定「${ev.name}」開催中！ — 残り${fmtRemain(ev.endsAt - Date.now())}`,
      `${icon} Limited event "${ev.nameEn || ev.name}" is live! — ${fmtRemain(ev.endsAt - Date.now())} left`);
    banner.classList.remove('hidden');
    // Only the chaos event opens the chaos button for everyone.
    const chaosLive = ev.type === 'chaos';
    btn.classList.toggle('hidden', !chaosLive && !staffExtras());
    btn.classList.toggle('staff-only', !chaosLive);
  } else {
    if (ev) window.__bbaEvent = null;   // expired locally — hide until next poll
    banner.classList.add('hidden');
    // Outside an event only staff can reach chaos, and it is badged as such
    // so it never looks like a live event that refuses to end.
    btn.classList.toggle('hidden', !staffExtras());
    btn.classList.toggle('staff-only', true);
  }
}

async function pollStatus() {
  try {
    // api() attaches the bearer token, which is what lets /api/status return
    // YOUR admin-event slot and countdown instead of a generic schedule.
    const data = await api('/api/status');
    // Keep every counter (menu badge + chat drawer) on the same number.
    $('#onlineCount').textContent = data.online;
    $('#chatOnline').textContent = t(`🟢 ${data.online}人`, `🟢 ${data.online} online`);
    $('#onlineBadge').classList.remove('hidden');
    setMood(data.mood);
    window.__bbaEvent = data.event || null;
    updateEventBanner();
    setAdminEvent(data.adminEvent || null);
    const prevPoll = window.__bbaPoll && window.__bbaPoll.id;
    window.__bbaPoll = data.poll || null;
    if (!data.poll || prevPoll !== data.poll.id) refreshPollBanner();
    else updatePollBannerClock();
  } catch { /* server unreachable — keep hidden */ }
}

// Keep the poll countdown ticking between status polls.
function updatePollBannerClock() {
  const el = $('#pollBanner');
  const p = window.__bbaPoll;
  if (!el || !p) return;
  if (p.endsAt <= Date.now()) { window.__bbaPoll = null; el.classList.add('hidden'); return; }
  const small = el.querySelector('small');
  if (small) small.textContent = `(${t(`残り${fmtRemain(p.endsAt - Date.now())}`, `${fmtRemain(p.endsAt - Date.now())} left`)})`;
}

$('#pollBanner').onclick = () => openPoll();
$('#liveFeed').onclick = () => showFeedModal();
pollStatus();
setInterval(pollStatus, 30000);
setInterval(updateEventBanner, 1000);   // live countdown between polls
setInterval(updatePollBannerClock, 1000);

// ---- chaos setup: pick duration (presets or free min/sec) + mutation interval ----
function showChaosSetup() {
  const prefs = JSON.parse(localStorage.getItem('bba_chaos_prefs') || '{}');
  const best = Number(localStorage.getItem('bba_chaos_best') || 0);
  let duration = Number(prefs.duration) || 120;
  let interval = Number(prefs.interval) || 15;
  const isPreset = [60, 120, 180, 300].includes(duration);

  const m = showModal(`
    <h2>${t('🌪️ カオスモード', '🌪️ Chaos Mode')}</h2>
    <p class="muted center" style="margin-bottom:10px">${t('一定間隔でルールが激変！コイン1.5倍！', 'The rules mutate on a timer! 1.5x coins!')}${best ? `<br>${t('自己ベスト', 'Personal best')}: <b style="color:var(--yellow)">${fmt(best)}</b>` : ''}</p>
    <div class="form-col">
      <div class="settings-row"><label>${t('⏱️ プレイ時間', '⏱️ Duration')}</label><div class="seg" data-cs="duration">
        ${[60, 120, 180, 300].map(d => `<button data-v="${d}" ${duration === d ? 'class="active"' : ''}>${d / 60}${t('分', 'min')}</button>`).join('')}
        <button data-v="custom" ${!isPreset ? 'class="active"' : ''}>${t('自由', 'Custom')}</button>
      </div></div>
      <div class="settings-row ${isPreset ? 'hidden' : ''}" id="csCustomRow"><label>${t('自由設定（30秒〜30分）', 'Custom (30s〜30min)')}</label>
        <input id="csMin" type="number" min="0" max="30" value="${Math.floor(duration / 60)}" style="width:52px;text-align:center">${t('分', 'min')}
        <input id="csSec" type="number" min="0" max="59" value="${duration % 60}" style="width:52px;text-align:center">${t('秒', 'sec')}
      </div>
      <div class="settings-row"><label>${t('🌀 ルール変化の間隔', '🌀 Mutation interval')}</label><div class="seg" data-cs="interval">
        ${[[20, t('ゆるい 20秒', 'Chill 20s')], [15, t('ふつう 15秒', 'Normal 15s')], [8, t('激辛 8秒', 'Spicy 8s')]].map(([v, l]) =>
          `<button data-v="${v}" ${interval === v ? 'class="active"' : ''}>${l}</button>`).join('')}
      </div></div>
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="csCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-chaos" id="csStart">${t('🌪️ 開始！', '🌪️ Start!')}</button>
    </div>`);

  let durChoice = isPreset ? String(duration) : 'custom';
  m.querySelectorAll('[data-cs] button').forEach(b => {
    b.onclick = () => {
      audio.click();
      const group = b.parentElement.dataset.cs;
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (group === 'duration') {
        durChoice = b.dataset.v;
        m.querySelector('#csCustomRow').classList.toggle('hidden', durChoice !== 'custom');
      } else {
        interval = Number(b.dataset.v);
      }
    };
  });
  m.querySelector('#csCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#csStart').onclick = () => {
    if (durChoice === 'custom') {
      const mins = Math.max(0, Math.min(30, Math.floor(Number(m.querySelector('#csMin').value) || 0)));
      const secs = Math.max(0, Math.min(59, Math.floor(Number(m.querySelector('#csSec').value) || 0)));
      duration = mins * 60 + secs;
      if (duration < 30) { toast(t('30秒以上で設定してください', 'Set at least 30 seconds'), 'err'); return; }
      if (duration > 1800) { toast(t('最大30分までです', '30 minutes max'), 'err'); return; }
    } else {
      duration = Number(durChoice);
    }
    localStorage.setItem('bba_chaos_prefs', JSON.stringify({ duration, interval }));
    audio.click();
    closeModal();
    startChaos({ duration, interval });
  };
}

$('#btnChaos').onclick = () => {
  const chaosLive = window.__bbaEvent && window.__bbaEvent.type === 'chaos';
  if (!chaosLive && !staffExtras()) { toast(t('カオスモードはイベント開催中のみ遊べます', 'Chaos Mode is only playable during a chaos event'), 'err'); return; }
  audio.click();
  showChaosSetup();
};

// ---- dungeon tower: pick a starting checkpoint, then climb ----
function dungeonBest(realm) {
  const local = Number(localStorage.getItem(realm.bestKey) || 0);
  // Only the classic tower is tracked server-side.
  const srv = realm.id === 'tower' && session.user && session.user.stats
    ? Number(session.user.stats.dungeonMax || 0) : 0;
  return Math.max(local, srv);
}

function realmLocked(realm) {
  if (realm.unlock !== 'tower100' || isAdminUser()) return false;
  return dungeonBest(DUNGEON_REALMS.tower) < DUNGEON_REALMS.tower.floors;
}

function showDungeonSelect(realmId = 'tower') {
  const realm = DUNGEON_REALMS[realmId] || DUNGEON_REALMS.tower;
  const locked = realmLocked(realm);
  const best = isAdminUser() ? realm.floors : dungeonBest(realm);
  const P = realm.prefix;
  const cps = [];
  for (let f = 1; f <= realm.floors - 9; f += 10) if (f === 1 || best >= f - 1) cps.push(f);
  let startF = cps[cps.length - 1];
  const m = showModal(`
    <h2>${realm.icon} ${t(realm.name, realm.nameEn)}</h2>
    <div class="seg" style="justify-content:center;margin-bottom:10px" data-dr>
      ${Object.values(DUNGEON_REALMS).map(r =>
        `<button data-r="${r.id}" ${r.id === realm.id ? 'class="active"' : ''}>${realmLocked(r) ? '🔒' : r.icon}${t(r.name.replace('ダンジョン', ''), r.nameEn.split(' ')[0])}</button>`).join('')}
    </div>
    <p class="muted center" style="margin-bottom:10px">${t(realm.desc, realm.descEn)}${best ? `<br>${t('最高記録', 'Best')}: <b style="color:var(--yellow)">${P}${best}</b>${t(' クリア', ' cleared')}` : ''}${locked ? `<br><b style="color:var(--red)">🔒 ${t('ダンジョン塔 F100 を制覇すると解放', 'Conquer Tower F100 to unlock')}</b>` : ''}</p>
    <div class="settings-row"><label>${t('開始階', 'Start floor')}</label><div class="seg seg-wrap" data-ds>
      ${cps.map(f => `<button data-v="${f}" ${f === startF ? 'class="active"' : ''}>${P}${f}</button>`).join('')}
    </div></div>
    ${cps.length > 1 ? `<p class="muted center" style="font-size:11px">${t('チェックポイントから始めると強化ボーナス付き', 'Starting from a checkpoint grants bonus perks')}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="dgCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-dungeon" id="dgStart">${realm.icon} ${t('挑戦する！', 'Enter!')}</button>
    </div>`);
  m.querySelectorAll('[data-dr] button').forEach(b => {
    b.onclick = () => { audio.click(); closeModal(); showDungeonSelect(b.dataset.r); };
  });
  m.querySelectorAll('[data-ds] button').forEach(b => {
    b.onclick = () => {
      audio.click();
      m.querySelectorAll('[data-ds] button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      startF = Number(b.dataset.v);
    };
  });
  m.querySelector('#dgCancel').onclick = () => { audio.click(); closeModal(); };
  const startBtn = m.querySelector('#dgStart');
  if (locked) { startBtn.disabled = true; startBtn.textContent = `🔒 ${t('未解放', 'Locked')}`; }
  startBtn.onclick = () => { if (locked) return; audio.click(); closeModal(); startDungeon(startF, realm.id); };
}

$('#btnDungeon').onclick = () => { audio.click(); showDungeonSelect(); };

// ---- survival ----
$('#btnSurvival').onclick = () => { audio.click(); startSurvival(); };

// ---- meltdown (炉心スコアアタック) ----
$('#btnMeltdown').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_meltdown_best') || 0),
    session.user ? (session.user.stats.meltdownBest || 0) : 0);
  const m = showModal(`
    <h2>☢️ ${t('メルトダウン', 'Meltdown')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('ラインを消すほど<b>炉心温度＝スコア倍率</b>が上昇（最大×15超）。ただし<b>100%で爆発</b>して即終了！<br><small>盤面に湧く❄️冷却セルを含むラインを消すと熱-35%。臨界(90%+)で置くと倍率さらに1.5倍 — 冷やすか、稼ぐか。</small>',
          'Every clear heats the core — <b>heat is your score multiplier</b> (up to ×15+). But <b>100% = detonation</b>!<br><small>Clear a line through a ❄️ coolant cell for -35% heat. Placements at 90%+ get an extra ×1.5 — cool it or push it.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="mlCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-melt" id="mlStart">☢️ ${t('炉心起動', 'Ignite the core')}</button>
    </div>`);
  m.querySelector('#mlCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#mlStart').onclick = () => { audio.click(); closeModal(); startMeltdown(); };
};

// ---- chimera lab (ピース溶接) ----
$('#btnChimera').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_chimera_best') || 0),
    session.user ? (session.user.stats.chimeraBest || 0) : 0);
  const m = showModal(`
    <h2>🧬 ${t('キメラ工房', 'Chimera Lab')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('手札のピースを<b>ピースにドラッグして溶接</b>！自作の巨大キメラは<b>合体数がそのままスコア倍率</b>（2体=×2、3体=×3）<br><small>ただし手札は全部置くまで補充されない — 合体するほど窒息リスクと隣り合わせ。盤面を彫って、怪物を叩き込め！</small>',
          '<b>Drag a piece onto another to weld them</b>! Your monster chimera scores <b>×its weld count</b> (2 pieces = ×2, 3 = ×3)<br><small>But your hand only refills once empty — every weld trades safety for power. Carve the board, then slam the monster in!</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="chCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-chimera" id="chStart">🧬 ${t('錬成開始', 'Start welding')}</button>
    </div>`);
  m.querySelector('#chCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#chStart').onclick = () => { audio.click(); closeModal(); startChimera(); };
};

// ---- puzzle ruins (ステージ制パズル) ----
$('#btnPuzzle').onclick = () => {
  audio.click();
  const cleared = puzzleBestStage();
  let stars = {};
  try { stars = JSON.parse(localStorage.getItem('bba_puzzle_stars') || '{}'); } catch { /* fresh */ }
  const next = cleared + 1;
  const show = Math.max(next, 10);
  let grid = '';
  for (let s2 = 1; s2 <= show; s2++) {
    const done = s2 <= cleared;
    const isNext = s2 === next;
    const st = stars[s2] || 0;
    grid += `<button class="pz-stage ${isNext ? 'next' : done ? '' : 'locked'}" data-stage="${s2}" ${done || isNext ? '' : 'disabled'}>
      ${s2}<span class="pz-stars">${done ? '★'.repeat(st) + '☆'.repeat(Math.max(0, 3 - st)) : isNext ? 'NEW' : '🔒'}</span></button>`;
  }
  const m = showModal(`
    <h2>🧩 ${t('パズル遺跡', 'Puzzle Ruins')}</h2>
    <p class="muted center" style="margin-bottom:10px">
      ${t('古代遺跡のパズル部屋に挑戦！<b>光るブロックをすべて消せばクリア</b>。<br><small>ピースは決められた分だけ — 全ステージ必ず解けるように封印されている。速く解くほど★が増える（45秒以内で★3）。10ステージごとに💎ボーナス！</small>',
          'Take on the ancient puzzle rooms! <b>Clear every glowing block to win.</b><br><small>You get a fixed set of pieces — every room is sealed with a guaranteed solution. Solve fast for more stars (under 45s = ★3). Gem bonus every 10 stages!</small>')}
    </p>
    <div class="pz-grid">${grid}</div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="pzCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-puzzle" id="pzStart">🧩 ${t(`ステージ${next}に挑む`, `Enter stage ${next}`)}</button>
    </div>`);
  m.querySelector('#pzCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#pzStart').onclick = () => { audio.click(); closeModal(); startPuzzle(next); };
  m.querySelectorAll('.pz-stage:not(.locked)').forEach(b => {
    b.onclick = () => { audio.click(); closeModal(); startPuzzle(Number(b.dataset.stage)); };
  });
};

// ---- the mines (せり上がる地層) ----
$('#btnDig').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_dig_best') || 0),
    session.user ? (session.user.stats.digDepth || 0) : 0);
  const m = showModal(`
    <h2>⛏️ ${t('採掘場', 'The Mines')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('数手ごとに<b>地層がせり上がる</b>！岩盤ラインを消して<b>🪙金鉱石・💠クリスタル・🌈虹鉱石</b>を回収しろ。<br><small>深く潜るほど鉱石は高価に、岩は分厚くなる。ブロックが天井に触れたら圧死 — ライン消しで上昇を遅らせろ！</small>',
          'Every few moves <b>the ground rises</b>! Clear through the rock to mine <b>🪙 gold, 💠 crystal and 🌈 rainbow ore</b>.<br><small>Deeper = richer veins but thicker rock. Touch the ceiling and you get crushed — line clears slow the rise!</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`最高深度 ${best}m`, `Best depth ${best}m`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="dgCancel2">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-dig" id="dgStart2">⛏️ ${t('採掘開始', 'Start digging')}</button>
    </div>`);
  m.querySelector('#dgCancel2').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#dgStart2').onclick = () => { audio.click(); closeModal(); startDig(); };
};

// ---- time attack ----
$('#btnSprint').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>${t('⏱️ タイムアタック', '⏱️ Time Attack')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('制限時間内にどれだけ稼げる？<br><small>専用ランキングあり。公平性のためアイテム・アルティメットは使えません</small>',
          'How much can you score against the clock?<br><small>Has its own ranking — items and ultimates are disabled for fairness</small>')}
    </p>
    <div class="form-col">
      ${SPRINT_DURATIONS.map(d => {
        const best = sprintBest(d);
        return `<button class="btn btn-sprint btn-big" data-sp="${d}">
          ${d < 60 ? `${d}${t('秒', 's')}` : `${d / 60}${t('分', ' min')}`} ${t('スプリント', 'Sprint')}
          <small style="display:block;font-size:12px;opacity:.85;font-weight:700">${best ? t(`自己ベスト ${fmt(best)}`, `Best ${fmt(best)}`) : t('記録なし', 'No record yet')}</small>
        </button>`;
      }).join('')}
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="spCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-ghost" id="spRank">${t('🏆 順位を見る', '🏆 Standings')}</button>
    </div>`);
  m.querySelector('#spCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#spRank').onclick = () => { audio.click(); closeModal(); openLeaderboard('sprint'); };
  m.querySelectorAll('[data-sp]').forEach(b => {
    b.onclick = () => { audio.click(); closeModal(); startSprint(Number(b.dataset.sp)); };
  });
};

// ---- weekly challenge ----
window.__bbaOpenLeaderboard = openLeaderboard;

function fmtWeeklyRemain(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}${t('日', 'd ')}${Math.floor((s % 86400) / 3600)}${t('時間', 'h')}`.trim();
  if (s >= 3600) return `${Math.floor(s / 3600)}${t('時間', 'h ')}${Math.floor((s % 3600) / 60)}${t('分', 'm')}`.trim();
  return `${Math.floor(s / 60)}${t('分', 'm')}`;
}

$('#btnWeekly').onclick = async () => {
  audio.click();
  let info;
  try {
    info = await api('/api/weekly');
  } catch {
    toast(t('サーバーに接続できません', 'Cannot reach the server'), 'err');
    return;
  }
  const localBest = (() => {
    try {
      const v = JSON.parse(localStorage.getItem('bba_weekly_best'));
      if (v && v.week === info.week) return v.best || 0;
    } catch { /* ignore */ }
    return 0;
  })();
  const best = Math.max(info.best || 0, localBest);
  const m = showModal(`
    <h2>${t('🎯 ウィークリーチャレンジ', '🎯 Weekly Challenge')}</h2>
    <p class="muted center" style="margin-bottom:10px">
      ${t(`全プレイヤー共通のピース順で<b>${info.pieces}個</b>限定スコアアタック！`, `Score attack with <b>${info.pieces}</b> pieces — same order for every player!`)}<br>
      ${t('リセットまで残り', 'Resets in')} <b>${fmtWeeklyRemain(info.endsAt - Date.now())}</b>
      ${best ? `<br>${t('今週のベスト', "This week's best")}: <b style="color:var(--yellow)">${fmt(best)}</b>` : ''}
      ${session.user ? '' : `<br><small>${t('💡 ランキングに載るにはログイン', '💡 Log in to appear on the ranking')}</small>`}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wkCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-ghost" id="wkRank">${t('🏆 順位を見る', '🏆 Standings')}</button>
      <button class="btn btn-weekly" id="wkStart">${t('🎯 挑戦する！', '🎯 Play!')}</button>
    </div>`);
  m.querySelector('#wkCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#wkRank').onclick = () => { audio.click(); closeModal(); openLeaderboard('weekly'); };
  m.querySelector('#wkStart').onclick = () => { audio.click(); closeModal(); startWeekly({ ...info, best }); };
};

// ---- gacha (in-game item buttons are built by modes.js) ----
$('#btnGacha').onclick = () => openGacha();

// ---- guilds + news ----
$('#btnGuild').onclick = () => { audio.click(); openGuild(); };
$('#btnNews').onclick = () => { audio.click(); openNews(); };
$$('[data-gd]').forEach(b => { b.onclick = () => { audio.click(); openGuild(b.dataset.gd); }; });
fetch('/api/news').then(r => r.json()).then(d => updateNewsDot(d.latestAt)).catch(() => {});

bindAdminActions();
loadTitles();

// Menu badge for unclaimed mission / achievement rewards.
window.__bbaRefreshMissionDot = refreshMissionDot;
setInterval(() => { if (session.user) refreshMissionDot(); }, 120000);

// ---- Recovery entry point: /?restore=1 opens the backup-restore dialog even
// when nobody can log in yet (it authenticates with the backup's own admin
// password). Used right after a redeploy wiped the data directory.
if (location.search.includes('restore=1')) {
  history.replaceState(null, '', '/');
  setTimeout(() => {
    const splash = $('#tapStart');
    if (!splash.classList.contains('hidden')) { splash.classList.add('hidden'); audio.ensure(); }
    showRestoreModal();
  }, 900);
}

// ---- Stripe checkout return ----
if (location.search.includes('purchase=success')) {
  history.replaceState(null, '', '/');
  setTimeout(async () => {
    try { await refreshMe(); updateTopbar(); } catch { /* ignore */ }
    audio.coin();
    toast(t('💎 購入ありがとうございます！ジェムを付与しました', '💎 Thank you for your purchase! Gems added'), 'ok', 4000);
  }, 1500);
} else if (location.search.includes('purchase=cancel')) {
  history.replaceState(null, '', '/');
  toast(t('購入をキャンセルしました', 'Purchase canceled'), '', 2500);
}

// ---- session restore ----
document.body.dataset.screen = 'menu';
initChat();

// Poll until the server has our account again (after a data restore), then
// re-attach the session without asking the player to log in.
let restoreWaitTimer = null;
function waitForRestore() {
  clearInterval(restoreWaitTimer);
  restoreWaitTimer = setInterval(async () => {
    if (!session.token || session.user) { clearInterval(restoreWaitTimer); return; }
    try {
      await refreshMe();
      clearInterval(restoreWaitTimer);
      updateTopbar();
      reconnectChat();
      refreshMissionDot();
      refreshPollBanner();
      audio.coin();
      toast(t(`✅ おかえりなさい、${session.user.username}さん！データが復元されました`,
        `✅ Welcome back, ${session.user.username}! Your data has been restored`), 'ok', 5000);
    } catch (err) {
      if (err.code === 'NO_USER' && err.settled) {
        clearInterval(restoreWaitTimer);
        showRestoreFailedModal();
        return;
      }
      if (err.code !== 'NO_USER' && (err.status === 401 || err.status === 403)) {
        clearInterval(restoreWaitTimer);
        setToken(null);
        updateTopbar();
      }
    }
  }, 30000);
}

// 復元が終わったのにアカウントが戻らなかった人への正直な案内。
// （最後のバックアップ以降に作られたアカウントは復元に含まれない）
function showRestoreFailedModal() {
  const m = showModal(`
    <h2>😢 ${t('データを復元できませんでした', 'Your data could not be restored')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('サーバーの復元は完了しましたが、このアカウントは直前のバックアップに含まれていませんでした。<br>本当にごめんなさい…！お手数ですが、新しくアカウントを作成してください。<b>同じ名前をもう一度使えます。</b>',
          'The server restore finished, but this account was not in the latest backup.<br>We are really sorry! Please create a new account — <b>you can use the same name again.</b>')}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-primary" id="rfRestart">${t('🌱 新しく始める', '🌱 Start fresh')}</button>
    </div>`, { dismissable: false });
  m.querySelector('#rfRestart').onclick = () => {
    closeModal();
    setToken(null);
    session.user = null;
    updateTopbar();
    showAuthModal();
  };
}

(async () => {
  updateTopbar();
  if (session.token) {
    // Retry through free-tier cold starts so closing/reopening the app
    // never looks like a logout.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const data = await refreshMe();
        updateTopbar();
        refreshMissionDot();
        updateGhostButton();   // adminは幽霊屋敷が常時開放
        // The first status poll usually lands before the session is restored,
        // so the banner still says "not voted" — re-check now that we know who
        // is logged in.
        refreshPollBanner();
        if (data.dailyBonus) {
          const st = data.dailyBonus.streak || 1;
          const tb = data.dailyBonus.throneBonus;
          toast(t(`🎁 ログインボーナス +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎${st > 1 ? `（🔥${st}日連続！）` : ''}${tb ? `（👑王座の俸給 +${tb.coins}🪙+${tb.gems}💎込み）` : ''}`,
            `🎁 Daily bonus +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎${st > 1 ? ` (🔥${st}-day streak!)` : ''}${tb ? ` (incl. 👑 throne stipend +${tb.coins}🪙+${tb.gems}💎)` : ''}`), 'ok', tb ? 4500 : 3500);
          audio.coin();
        }
        // 週明け: ランキング報酬が待っていたら受け取りダイアログを出す。
        if (data.user && data.user.rankRewards && data.user.rankRewards.length) {
          setTimeout(() => showRankRewardsModal(), 1600);
        }
        break;
      } catch (err) {
        if (err.status === 403 || String(err.message).includes('凍結') || /suspended/i.test(String(err.message))) { toast(err.message, 'err'); break; }
        // The session is fine but the account data is missing on the server
        // (a redeploy wiped it, restore pending): keep the token and keep
        // checking — the login comes back by itself once the data is restored.
        if (err.code === 'NO_USER') {
          session.user = null;
          updateTopbar();
          if (err.settled) {
            // 復元はもう終わっている — 待っても戻らないので正直に案内する。
            showRestoreFailedModal();
            break;
          }
          toast(t('⚠️ サーバーのアカウントデータが復元待ちです。復元が終わると自動でログインに戻ります',
            '⚠️ Your account data is waiting to be restored on the server — you will be logged back in automatically'), 'err', 7000);
          waitForRestore();
          break;
        }
        // Only drop the session on real auth errors — keep it through outages.
        if (err.status === 401 || err.status === 403) {
          setToken(null);
          session.user = null;
          updateTopbar();
          break;
        }
        if (attempt === 0) toast(t('🌙 サーバーを起こしています…そのままお待ちください', '🌙 Waking up the server… please hang on'), '', 8000);
        await new Promise(r => setTimeout(r, 9000));
      }
    }
  }
  // season banner
  try {
    if (!session.season) await refreshMe().catch(() => {});
  } catch { /* ignore */ }
  if (session.season) {
    const days = Math.max(0, Math.ceil((session.season.endsAt - Date.now()) / 86400000));
    const banner = $('#seasonBanner');
    banner.textContent = t(`✨ ${session.season.name} 開催中 — 残り${days}日`,
      `✨ ${session.season.nameEn || session.season.name} — ${days} days left`);
    banner.classList.remove('hidden');
  }
})();
