// App bootstrap: wire menu, session restore, global buttons.
import { session, api, refreshMe, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, updateTopbar, fmt } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, startBoss, startBossRush, startChaos, startDungeon, startWeekly, startSurvival, cancelMatchmaking, quitCurrent, rerollCurrent, toggleAutopilot, showAdminPalette, useGameItem, DUNGEON_REALMS } from './modes.js';
import { showAuthModal, showSettingsModal, showGemShop, loadTitles, openLeaderboard, openShop, openBattlePass, openAdmin, bindAdminActions, openGacha } from './screens.js';
import { confettiBurst } from './dom.js';
import { AI_LEVELS } from './ai.js';
import { applySettings } from './settings.js';
import { initChat } from './chat.js';
import { t, setLang, LANG, applyStaticI18n, catName } from './i18n.js';

applyStaticI18n();

// ---- menu buttons ----
$('#btnSolo').onclick = () => { audio.click(); startSolo(); };

$('#btnVsAi').onclick = () => {
  audio.click();
  const kamiUnlocked = localStorage.getItem('bba_kami') === '1';
  const souzouUnlocked = localStorage.getItem('bba_souzou') === '1';
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
          const rushOpen = bossMax >= data.bosses.length;
          return `
          <button class="btn boss-select ${rushOpen ? 'btn-oni' : 'btn-ghost'}" data-rush ${rushOpen ? '' : 'disabled'}>
            <span>${rushOpen ? '⚔️' : '🔒'} ${t('ボスラッシュ', 'Boss Rush')}</span>
            <small>${rushOpen ? t('全4体を連戦！休憩なし・1ミスで終了', 'All 4 bosses back to back! No breaks, one loss ends it') : t('全ボスを討伐すると解放', 'Defeat every boss to unlock')}</small>
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
      <button class="btn btn-online btn-big" data-online="team">${t('👥 2v2 チーム戦', '👥 2v2 Team Battle')}</button>
      <button class="btn btn-gold btn-big" data-online="tourney">${t('🏆 トーナメント（8人制）', '🏆 Tournament (8 players)')}</button>
      <button class="btn btn-oni btn-big" data-online="royale">${t('💯 バトルロイヤル（100人）', '💯 Battle Royale (100 players)')}</button>
      <button class="btn btn-boss btn-big" data-online="raid">${t('🐲 レイドボス戦（協力）', '🐲 Raid Boss (co-op)')}</button>
      <button class="btn btn-online btn-big" data-online="custom">${t('🔧 カスタムルーム', '🔧 Custom Room')}</button>
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

// autopilot + command palette (admin only)
$('#btnAuto').onclick = () => toggleAutopilot();
$('#btnAdminCmd').onclick = () => showAdminPalette();

// ---- audio boot: autoplay if allowed, otherwise tap-to-start splash ----
function startAudioNow() {
  audio.ensure();
  if (!audio.playing) audio.playTrack(audio.trackName || 'menu');
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
    banner.textContent = t(`🌪️ 期間限定「${ev.name}」開催中！ — 残り${fmtRemain(ev.endsAt - Date.now())}`,
      `🌪️ Limited event "${ev.name}" is live! — ${fmtRemain(ev.endsAt - Date.now())} left`);
    banner.classList.remove('hidden');
    btn.classList.remove('hidden');
  } else {
    if (ev) window.__bbaEvent = null;   // expired locally — hide until next poll
    banner.classList.add('hidden');
    btn.classList.add('hidden');
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    // Keep every counter (menu badge + chat drawer) on the same number.
    $('#onlineCount').textContent = data.online;
    $('#chatOnline').textContent = t(`🟢 ${data.online}人`, `🟢 ${data.online} online`);
    $('#onlineBadge').classList.remove('hidden');
    window.__bbaEvent = data.event || null;
    updateEventBanner();
  } catch { /* server unreachable — keep hidden */ }
}
pollStatus();
setInterval(pollStatus, 30000);
setInterval(updateEventBanner, 1000);   // live countdown between polls

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
  if (!window.__bbaEvent) { toast(t('イベントは開催されていません', 'No event is live right now'), 'err'); return; }
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

function showDungeonSelect(realmId = 'tower') {
  const realm = DUNGEON_REALMS[realmId] || DUNGEON_REALMS.tower;
  const best = dungeonBest(realm);
  const P = realm.prefix;
  const cps = [];
  for (let f = 1; f <= realm.floors - 9; f += 10) if (f === 1 || best >= f - 1) cps.push(f);
  let startF = cps[cps.length - 1];
  const m = showModal(`
    <h2>${realm.icon} ${t(realm.name, realm.nameEn)}</h2>
    <div class="seg" style="justify-content:center;margin-bottom:10px" data-dr>
      ${Object.values(DUNGEON_REALMS).map(r =>
        `<button data-r="${r.id}" ${r.id === realm.id ? 'class="active"' : ''}>${r.icon}${t(r.name.replace('ダンジョン', ''), r.nameEn.split(' ')[0])}</button>`).join('')}
    </div>
    <p class="muted center" style="margin-bottom:10px">${t(realm.desc, realm.descEn)}${best ? `<br>${t('最高記録', 'Best')}: <b style="color:var(--yellow)">${P}${best}</b>${t(' クリア', ' cleared')}` : ''}</p>
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
  m.querySelector('#dgStart').onclick = () => { audio.click(); closeModal(); startDungeon(startF, realm.id); };
}

$('#btnDungeon').onclick = () => { audio.click(); showDungeonSelect(); };

// ---- survival ----
$('#btnSurvival').onclick = () => { audio.click(); startSurvival(); };

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

// ---- gacha + in-game items ----
$('#btnGacha').onclick = () => openGacha();
$$('#itemBar [data-item]').forEach(b => {
  b.onclick = () => useGameItem(b.dataset.item);
});

bindAdminActions();
loadTitles();

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

(async () => {
  updateTopbar();
  if (session.token) {
    // Retry through free-tier cold starts so closing/reopening the app
    // never looks like a logout.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const data = await refreshMe();
        updateTopbar();
        if (data.dailyBonus) {
          toast(t(`🎁 ログインボーナス +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎`,
            `🎁 Daily bonus +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎`), 'ok', 3500);
          audio.coin();
        }
        break;
      } catch (err) {
        if (String(err.message).includes('凍結')) { toast(err.message, 'err'); break; }
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
      `✨ ${session.season.name} — ${days} days left`);
    banner.classList.remove('hidden');
  }
})();
