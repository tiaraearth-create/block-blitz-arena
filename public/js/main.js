// App bootstrap: wire menu, session restore, global buttons.
import { session, api, refreshMe, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, updateTopbar, fmt, staffExtras , goBack, initHistory } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, startBoss, startBossRush, startChaos, startDungeon, startWeekly, startDaily, startSurvival, startSprint, sprintBest, SPRINT_DURATIONS, cancelMatchmaking, quitCurrent, rerollCurrent, fireUltCurrent, DUNGEON_REALMS, startMeltdown, startChimera, startPuzzle, startDig, puzzleBestStage, startGhost, ghostUnlocked } from './modes.js';
import { showAdminPalette, quickAutopilot, showAutopilotPanel, startGodLoop } from './admintools.js';
import { initClipHud } from './clipexport.js';
import { showAuthModal, showSettingsModal, showGemShop, loadTitles, openLeaderboard, openShop, openInventory, openBattlePass, openAdmin, bindAdminActions, openGacha, openMissions, refreshMissionDot, openPoll, refreshPollBanner, showRestoreModal, openGuild, openNews, showRankRewardsModal } from './screens.js';
import { confettiBurst } from './dom.js';
import { AI_LEVELS } from './ai.js';
import { applySettings, getSettings } from './settings.js';
import { initChat, reconnectChat, showFeedModal, setMood, updateNewsDot } from './chat.js';
import { setAdminEvent } from './adminevent.js';
import { t, setLang, LANG, applyStaticI18n, catName } from './i18n.js';
import { openFriends } from './friends.js';
import { initParty } from './party.js';

// ---------------------------------------------------------------------------
// 🧯 クライアントJSエラーの自動報告（POST /api/clienterror）
//
// index.html には CSP（script-src 'self'）が効いているのでインライン script は
// 置けない。ES Modules は import が先に評価される仕様上、main.js の本体で
// これより早くは走れない ── ここが「このファイルで可能なかぎり最速」の位置。
// import 中に落ちた分だけは拾えないが、それ以降の実行時エラーは全部ここに来る。
//
// 大原則: 報告が新しいエラーを生んではいけない。すべて try/catch で握りつぶす。
// ---------------------------------------------------------------------------
{
  const seen = new Set();          // 同じエラーはセッション中1回だけ
  const MAX_REPORTS = 20;          // 別種のエラーでも送り過ぎない上限
  let sentCount = 0;

  const post = (payload) => {
    try {
      const json = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        // Blob で type を付けないと text/plain になり、express.json() が読めない。
        const blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon('/api/clienterror', blob)) return;
      }
      fetch('/api/clienterror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
      }).catch(() => { /* 報告が届かなくても遊びは続く */ });
    } catch { /* sendBeacon も fetch も無い環境。何もしない */ }
  };

  const report = (kind, message, stack, where) => {
    try {
      const msg = String(message == null ? '' : message).slice(0, 400);
      if (!msg) return;
      const key = `${kind}|${msg}|${where || ''}`;
      if (seen.has(key)) return;
      if (sentCount >= MAX_REPORTS) return;
      seen.add(key);
      sentCount++;
      post({
        kind,                                     // 'error' | 'unhandledrejection'
        message: msg,
        // スタックは先頭数行だけ（全部送ると1件が数KBになる）
        stack: String(stack == null ? '' : stack).split('\n').slice(0, 5).join('\n').slice(0, 1200),
        where: String(where == null ? '' : where).slice(0, 300),   // file:line:col
        url: String(location.pathname + location.search).slice(0, 300),
        ua: String(navigator.userAgent || '').slice(0, 300),
        lang: String(navigator.language || ''),
        screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
        at: Date.now(),
      });
    } catch { /* 絶対に投げ返さない */ }
  };

  window.addEventListener('error', (e) => {
    try {
      if (!e) return;
      const err = e.error;
      // <img>/<script> の読み込み失敗も同じ 'error' で上がってくるが、
      // message も error も無い。JSエラーではないので送らない。
      const message = e.message || (err && err.message);
      if (!message) return;
      const where = e.filename ? `${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
      report('error', message, err && err.stack, where);
    } catch { /* ignore */ }
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      if (!e) return;
      const r = e.reason;
      const message = (r && r.message) ? r.message : (typeof r === 'string' ? r : (() => {
        try { return JSON.stringify(r); } catch { return String(r); }
      })());
      report('unhandledrejection', message, r && r.stack, '');
    } catch { /* ignore */ }
  });
}

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
    // ログイン中はサーバーの記録だけを見る。localStorage を混ぜていたせいで、
    // 同じ端末で別アカウントを作った人・ゲストのあと登録した人・家族と端末を
    // 共有している人に、討伐数0なのに全ボスが解放されて見えていた。
    // そこで最終ボスから始めると討伐順が一気に進み、下位ボスの初回ボーナスが
    // 二度と手に入らなくなる（サーバー側も下で直してある）。
    const bossMax = localStorage.getItem('bba_token')
      ? (data.bossMax || 0)
      : Number(localStorage.getItem('bba_boss_max') || 0);
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
// 「←」は1枚だけ戻す（以前は常にメニュー直行で、ショップ→インベントリと
// 行き来したあとに元の画面へ戻れなかった）。
$$('[data-back]').forEach(b => { b.onclick = () => { audio.click(); goBack(); }; });

// 端末の戻る（Android のジェスチャー／ハードキー）。
// 試合中は閉じずに、✕ と同じ確認を出す。
initHistory(() => {
  const q = $('#btnQuit');
  if (q) q.click();
});

// quit game
$('#btnQuit').onclick = () => {
  // Chaos and dungeon have their own quit dialogs.
  const cur = window.__bbaMode;
  if (cur && (cur.mode === 'chaos' || cur.mode === 'dungeon') && !cur.ended) { audio.click(); quitCurrent(); return; }
  const m = showModal(`
    <h2>${t('ゲームを終了しますか？', 'Quit this game?')}</h2>
    ${(() => {
      // モードによって「やめたらどうなるか」は全然ちがう。
      // ソロで「引き分け扱い」と言われても、相手がいないので意味が通らない。
      const online = cur && (cur.mode === 'pvp' || cur.kind);
      return `<p class="muted center">${online
        ? t('離脱は<b style="color:var(--red)">敗北</b>になります', 'Leaving counts as a <b style="color:var(--red)">loss</b>')
        : t('ここまでのスコアで記録されます', 'Your score so far will be recorded')}</p>`;
    })()}
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
// 🎬 プレイクリップ。録れない端末ではボタンごと隠れる（clipexport 側で判定）。
initClipHud();
startGodLoop();

// ---------------------------------------------------------------------------
// 📳 触覚フィードバック（navigator.vibrate）
//
// このゲームは縦固定の standalone PWA で、入力は canvas の上の指ドラッグひとつ。
// なのに手応えは音と絵だけで、音は Web Audio の合成音のみ ── iPhone の
// サイレントスイッチや音量0では「置いた／消えた／置けなかった」の確認が
// 画面しか無かった。
//
// 鳴らし分けは効果音の呼び出し点とまったく同じなので、各所に手を入れるより
// audio の該当メソッドに1枚かぶせるほうが漏れない（modes.js から鳴らす
// ぶんも同じ経路を通る）。元の実装はそのまま呼ぶので音は1ミリも変わらない。
//
// iOS Safari は vibrate 非対応。存在チェックで丸ごと no-op に落ちる。
// ---------------------------------------------------------------------------
{
  const canBuzz = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  let lastBuzz = 0;
  const buzz = pattern => {
    if (!canBuzz || !pattern) return;
    if (!getSettings().haptics) return;
    // 同じ瞬間に2つ鳴る場面（ライン消去＋コンボ）で後の1本が前を打ち消さない
    // ように、ごく短い間隔は捨てる。先に来た＝強いほうが残る。
    const now = Date.now();
    if (now - lastBuzz < 30) return;
    lastBuzz = now;
    try { navigator.vibrate(pattern); } catch { /* 端末が拒んでも遊びは続く */ }
  };
  const withHaptic = (name, pattern) => {
    const orig = audio[name];
    if (typeof orig !== 'function') return;          // 名前が変わったら黙って何もしない
    audio[name] = function (...args) {
      try { buzz(typeof pattern === 'function' ? pattern(...args) : pattern); } catch { /* ignore */ }
      return orig.apply(this, args);
    };
  };
  if (canBuzz) {
    withHaptic('pickup', 8);                          // つまむ
    withHaptic('place', 12);                          // 置けた
    withHaptic('putback', [10, 40, 10]);              // 置けずに戻った
    withHaptic('invalid', [10, 40, 10]);              // そもそも触れない
    // 消えた本数ぶんだけ強くする（1本=30ms 〜 4本=60ms）。
    withHaptic('clearLines', count => Math.min(60, 18 + (Math.max(1, Number(count) || 1)) * 12));
    // 連鎖は「本数」ではなく「回数」で返す。段が上がるほど刻みが増える。
    withHaptic('combo', streak => {
      const n = Math.max(1, Math.min(3, Math.ceil((Number(streak) || 1) / 3)));
      const p = [];
      for (let i = 0; i < n; i++) p.push(14, 50);
      p.pop();                                        // 末尾の休みは要らない
      return p;
    });
    withHaptic('gameOver', [60, 60, 120]);            // おしまい
  }
}

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
    // ⚠️ この画面は「ここで」＝モジュール本体の同期実行中に出しきること。
    // 下の async ブロックまで待つと sleep(250) ぶんの窓が空き、その間は
    // メニューのボタンだけが生きている状態になる。そこでソロを押されると
    // 試合が始まった上に全画面のピッカーが降ってきて、しかもこの画面は
    // 言語を選ぶまでタップでは閉じない ── 唯一の脱出（英語を選ぶ）は
    // location.reload() なので、始まったばかりの1戦目が消えてしまう。
    // 同期のうちに出しておけば、ボタンが有効になる瞬間にはもう塞がっている。
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
    splash.classList.remove('hidden');
  }
  // Block every pointer/click event on the splash from bubbling through.
  splash.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  splash.addEventListener('pointerup', e => { e.preventDefault(); e.stopPropagation(); });
  splash.addEventListener('click', dismissSplash);
  window.addEventListener('keydown', function onKey(e) {
    // スプラッシュが表示される前（起動直後の約250msの判定待ち）はまだ hidden。
    // その間の打鍵でリスナーを消費してしまうと、表示後にキーボードで閉じられ
    // なくなる。表示されている時だけ閉じ、閉じ終えたらリスナーを解除する。
    if (splash.classList.contains('hidden')) {
      // クリック／タップ等で既に閉じられていた場合はここで解除して漏らさない。
      if (splash.classList.contains('ts-out')) window.removeEventListener('keydown', onKey);
      return;
    }
    // 初回（言語未選択）は打鍵で閉じない ── ここでリスナーを外してしまうと、
    // 言語を選んだあとキーボードで閉じられなくなる。
    if (!localStorage.getItem('bba_lang')) return;
    dismissSplash();
    window.removeEventListener('keydown', onKey);
  });
  // Fallback audio unlock for the no-splash (autoplay-allowed) case.
  window.addEventListener('pointerdown', () => startAudioNow(), { once: true });
}

(async () => {
  // Try silent autoplay first — succeeds on repeat visits where the browser
  // has granted audio permission; otherwise show the tap-to-start splash.
  // First launch (no language chosen yet) は上のブロックが既に出しているので、
  // ここは 250ms の判定を待たずに何もしない（待つと、その間だけメニューが
  // 生きた状態になってしまう）。
  audio.ensure();
  if (!localStorage.getItem('bba_lang')) return;
  await new Promise(r => setTimeout(r, 250));
  if (audio.ctx && audio.ctx.state === 'running') {
    startAudioNow();
  } else {
    $('#tapStart').classList.remove('hidden');
  }
})();

// live online counter + limited-time event on the menu
window.__bbaEvent = null;
// 次の自動開催イベント（/api/status の nextEvent）。旧サーバー・自動開催OFFでは
// このキー自体が来ないので、null のまま＝予告バナーは一切出ない。
window.__bbaNextEvent = null;

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
  updateNextEventBanner();
}

// ---- 📣 「明日は◯◯開催！」予告バナー ----
//
// 開催中バナー(#eventBanner)のすぐ下に、同じ .event-banner の見た目で並べる。
// index.html は担当外なので器はここで作る ── 出すものが無い間は作りもしない
// （nextEvent を返さないサーバーでは DOM が1つも増えない）。
function nextEventBannerEl(create) {
  let el = document.getElementById('nextEventBanner');
  if (el || !create) return el;
  const host = $('#eventBanner');
  if (!host || !host.parentNode) return null;
  el = document.createElement('div');
  el.id = 'nextEventBanner';
  el.className = 'event-banner';
  // 開催中バナーより一段控えめに（予告が本番より目立たないように）
  el.style.cssText = 'margin-top:6px;opacity:.82;font-weight:700';
  host.insertAdjacentElement('afterend', el);
  return el;
}

// 「今日 / 明日 / N日後」— 時計ではなくカレンダー上の日付で数える。
function whenWord(startsAt) {
  const now = new Date();
  const then = new Date(startsAt);
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d1 = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((d1 - d0) / 86400000);
  if (days <= 0) return t('今日', 'today');
  if (days === 1) return t('明日', 'tomorrow');
  return t(`${days}日後`, `in ${days} days`);
}

function updateNextEventBanner() {
  const ne = window.__bbaNextEvent;
  const startsAt = ne ? Number(ne.startsAt || ne.startAt) : 0;
  const live = window.__bbaEvent && window.__bbaEvent.endsAt > Date.now();
  // 開催中は予告を出さない。まだ予告が無い／もう始まっている場合も同じ。
  if (live || !ne || !startsAt || !isFinite(startsAt) || startsAt <= Date.now()) {
    const cur = nextEventBannerEl(false);
    if (cur) cur.classList.add('hidden');
    return;
  }
  const el = nextEventBannerEl(true);
  if (!el) return;
  const icon = ne.icon || '📣';
  const name = t(ne.name || 'お楽しみイベント', ne.nameEn || ne.name || 'a special event');
  const clock = new Date(startsAt).toLocaleTimeString(t('ja-JP', 'en-US'), { hour: '2-digit', minute: '2-digit' });
  const remain = fmtRemain(startsAt - Date.now());
  el.textContent = t(`${icon} ${whenWord(startsAt)}は「${name}」開催！ ${clock}スタート（あと${remain}）`,
    `${icon} "${name}" starts ${whenWord(startsAt)} at ${clock}! (in ${remain})`);
  el.classList.remove('hidden');
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
    // nextEvent を返さないサーバー（自動開催OFF・旧版）では undefined → null。
    window.__bbaNextEvent = data.nextEvent || null;
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
  // 再開できる階は「ボス階の次」＝チェックポイント。刻み幅はレルクごとに違う
  // （深淵は bossEvery: 5）。ここだけ10刻みを決め打ちしていたので、深淵で A5 を
  // 撃破しても選択肢に A6 が出てこず、結果画面の「A6から再挑戦」を押した人しか
  // 恩恵を受けられなかった ── 一度メニューへ戻ると進行が巻き戻って見える。
  const step = realm.bossEvery || 10;
  for (let f = 1; f <= realm.floors - (step - 1); f += step) if (f === 1 || best >= f - 1) cps.push(f);
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
$('#btnSurvival').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_survival_wave') || 0),
    session.user ? (session.user.stats.survivalWave || 0) : 0);
  const m = showModal(`
    <h2>💀 ${t('サバイバル', 'Survival')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('<b>ウェーブごとにお邪魔ブロックが降ってくる</b>耐久モード。最初は15秒おき、ウェーブが進むほど<b>間隔はどんどん短く</b>（最短5秒）、降ってくる量も増えていく。<br><small>置ける場所が無くなったら終了 — ラインを消して盤面を空け、1ウェーブでも深く生き延びろ！</small>',
          '<b>Garbage blocks rain down wave after wave</b> — an endurance run. It starts every 15s, but <b>the interval keeps shrinking</b> (down to 5s) and each wave dumps more.<br><small>It ends the moment nothing fits — keep clearing lines to make room and survive one more wave!</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`最高ウェーブ W${fmt(best)}`, `Best wave W${fmt(best)}`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="svCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-oni" id="svStart">💀 ${t('生き延びる', 'Survive')}</button>
    </div>`);
  m.querySelector('#svCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#svStart').onclick = () => { audio.click(); closeModal(); startSurvival(); };
};

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

// ---------------------------------------------------------------------------
// 第3波の新モード導線（⛓️ 連鎖カスケード / 🏗️ ブループリント / 🛠️ パズル工房）
//
// ボタン要素は index.html 側（#btnChain / #btnBlueprint / #btnWorkshop）にある
// が、index.html は担当外なので「無ければ JS から足す」形にしてある（screens.js
// の ensureHallOfFameNav / ensureWorkshopNav と同じ流儀）。既にあるものは拾う
// だけなので二重には生えない。
//
// #btnWorkshop は screens.js の ensureWorkshopNav() も拾って openWorkshop() を
// 直に割り当てる。main.js は import の評価が終わったあとに走る＝こちらの
// onclick が後勝ちになるので、他モードと同じ「開始モーダル」を挟める。
//
// 起動関数は modes.js 側でまだ名前が固まっていないので import はせず、
// window 経由で「あれば呼ぶ・無ければトーストで止める」形にしてある。
// modes.js の実装が間に合わなくてもメニューは絶対に壊れない。
// ---------------------------------------------------------------------------

// 候補名を順に試して、最初に見つかった関数を呼ぶ。見つからなければトースト。
function callModeEntry(names, args) {
  for (const name of names) {
    const fn = window[name];
    if (typeof fn === 'function') {
      try {
        fn.apply(window, args || []);
      } catch (err) {
        // モード側が落ちてもメニューまで道連れにしない（自動報告には乗る）。
        console.error(err);
        toast(t('モードを開始できませんでした', 'Could not start this mode'), 'err');
      }
      return true;
    }
  }
  toast(t('準備中です', 'Coming soon'));
  return false;
}

// メニューのモード一覧にボタンを1つ確保する。戻り値は button（作れなければ null）。
function ensureModeButton(id, cls, label, afterId) {
  try {
    let btn = $('#' + id);
    if (!btn) {
      const list = $('#screen-menu .menu-buttons');
      if (!list) return null;
      btn = document.createElement('button');
      btn.id = id;
      btn.className = `btn ${cls} btn-big`;
      const after = afterId ? $('#' + afterId) : null;
      if (after && after.parentNode === list) list.insertBefore(btn, after.nextSibling);
      else list.appendChild(btn);
    }
    // index.html の文言は日本語固定で、i18n.js の applyStaticI18n() に対応する
    // 行が入るまで英語面でも日本語のままになる。ここで毎回 t() の結果に揃えて
    // おけば、i18n.js が追いついても同じ文言なので取り合いにならない。
    btn.textContent = label;
    return btn;
  } catch {
    return null;   // メニューの形が変わっても他の導線は死なせない
  }
}

function modeLocalBest(key) {
  const v = Number(localStorage.getItem(key) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function modeStatBest(field) {
  return (session.user && session.user.stats && Number(session.user.stats[field])) || 0;
}

// ---- ⛓️ chain cascade (連鎖カスケード) ----
function showChainSetup() {
  const best = Math.max(modeLocalBest('bba_chain_best'), modeStatBest('chainBest'));
  const maxChain = Math.max(modeLocalBest('bba_chain_max'), modeStatBest('chainMax'));
  const m = showModal(`
    <h2>⛓️ ${t('連鎖カスケード', 'Chain Cascade')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('ラインを消すと<b>上のブロックが下に落ちてくる</b>！落ちた先でまたラインが揃えば<b>連鎖</b>し、連鎖が続くほど<b>スコア倍率が跳ね上がる</b>。<br><small>盤面を崩さず「あと1マス」を残して積み、一撃で雪崩を起こせ — 置ける場所が無くなったら終了。</small>',
          'Clearing a line makes <b>everything above it fall</b> — and if the landing forms another line, it <b>chains</b>. The longer the chain, <b>the bigger the score multiplier</b>.<br><small>Stack with one gap left, then trigger the avalanche in a single move. It ends when nothing fits.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}${maxChain ? t(` / 最大${maxChain}連鎖`, ` / longest ${maxChain}-chain`) : ''}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="cnCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-coop" id="cnStart">⛓️ ${t('連鎖を起こす', 'Start the cascade')}</button>
    </div>`);
  m.querySelector('#cnCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#cnStart').onclick = () => {
    audio.click();
    closeModal();
    // modes.js 側の名前が確定していないので候補を順に試す。
    callModeEntry(['startChainMode', 'startChain', 'startCascade']);
  };
}

// ---- 🏗️ blueprint (日替わりの設計図) ----
function showBlueprintSetup() {
  const clears = Math.max(modeLocalBest('bba_blueprint_clears'), modeStatBest('blueprintClears'));
  const m = showModal(`
    <h2>🏗️ ${t('ブループリント', 'Blueprint')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('<b>日替わりの設計図どおりに</b>ピースを組み上げる、全員同じお題のパズル。<br><small>配られるピースは設計図をちょうど作れるぶんだけ。<b>ラインを揃えてしまうと作品が消えてしまう</b>ので、いつもと逆の頭で置き場所を考えろ！</small>',
          'Build <b>today\'s blueprint</b> exactly as drawn — the same puzzle for everyone, every day.<br><small>You get precisely the pieces the drawing needs. <b>Complete a line and your artwork vanishes</b> — so think the opposite way round!</small>')}
    </p>
    ${clears ? `<p class="center" style="font-size:13px;font-weight:800">${t(`これまでに ${fmt(clears)}枚 完成`, `${fmt(clears)} blueprints completed`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="bpCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-gold" id="bpStart">🏗️ ${t('今日の設計図に挑む', "Build today's blueprint")}</button>
    </div>`);
  m.querySelector('#bpCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#bpStart').onclick = () => {
    audio.click();
    closeModal();
    callModeEntry(['startBlueprint', 'startBlueprintMode', 'startBlueprintDaily']);
  };
}

// ---- 🛠️ puzzle workshop (自作ステージ) ----
function showWorkshopSetup() {
  const canEdit = typeof window.openWorkshopEditor === 'function';
  const m = showModal(`
    <h2>🛠️ ${t('パズル工房', 'Puzzle Workshop')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('みんなが作ったパズルで遊べる工房。<b>6文字の共有コード</b>で友達の作品にも飛べる。<br><small>自分で盤面を描いて投稿もできる — 自分でクリアできた図だけが公開されるので、解けない問題は出てこない。遊ばれるほど作者に🪙が入る！</small>',
          'A workshop full of player-made puzzles — jump straight to a friend\'s stage with its <b>6-letter share code</b>.<br><small>You can build and publish your own, too: only stages you have solved yourself go live, so nothing is unsolvable. Authors earn 🪙 every time their stage is played!</small>')}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wsCancel2">${t('やめる', 'Cancel')}</button>
      ${canEdit ? `<button class="btn btn-ghost" id="wsMake2">🛠️ ${t('作る', 'Create')}</button>` : ''}
      <button class="btn btn-puzzle" id="wsOpen2">🧩 ${t('ステージを探す', 'Browse stages')}</button>
    </div>`);
  m.querySelector('#wsCancel2').onclick = () => { audio.click(); closeModal(); };
  const make = m.querySelector('#wsMake2');
  if (make) make.onclick = () => { audio.click(); closeModal(); callModeEntry(['openWorkshopEditor']); };
  m.querySelector('#wsOpen2').onclick = () => {
    audio.click();
    closeModal();
    // 一覧は screens.js が window.openWorkshop として公開済み（audio.click は向こうで鳴る）。
    callModeEntry(['openWorkshop']);
  };
}

function ensureNewModeButtons() {
  const chain = ensureModeButton('btnChain', 'btn-chain', `⛓️ ${t('連鎖カスケード', 'Chain Cascade')}`, 'btnChimera');
  if (chain) chain.onclick = () => { audio.click(); showChainSetup(); };
  const blueprint = ensureModeButton('btnBlueprint', 'btn-blueprint', `🏗️ ${t('ブループリント', 'Blueprint')}`, 'btnDaily');
  if (blueprint) blueprint.onclick = () => { audio.click(); showBlueprintSetup(); };
  // screens.js が先に onclick を入れているので、ここで上書きして開始モーダルを挟む。
  const workshop = ensureModeButton('btnWorkshop', 'btn-workshop', `🛠️ ${t('パズル工房', 'Puzzle Workshop')}`, 'btnPuzzle');
  if (workshop) workshop.onclick = () => { audio.click(); showWorkshopSetup(); };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureNewModeButtons, { once: true });
else ensureNewModeButtons();

// ---- time attack ----
$('#btnSprint').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>${t('⏱️ タイムアタック', '⏱️ Time Attack')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('制限時間内にどれだけ稼げる？<br><small>専用ランキングあり。公平性のためアイテム・奥義は使えません</small>',
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

// 📅 デイリーチャレンジ — 1日1回の真剣勝負（挑戦後は練習し放題）
$('#btnDaily').onclick = async () => {
  audio.click();
  let info;
  try {
    info = await api('/api/daily');
  } catch {
    toast(t('サーバーに接続できません', 'Cannot reach the server'), 'err');
    return;
  }
  // ゲストの「今日の記録」はローカルに控えてある（サーバーには残らない）。
  const localRec = (() => {
    try {
      const v = JSON.parse(localStorage.getItem('bba_daily_record'));
      if (v && v.day === info.day) return v;
    } catch { /* ignore */ }
    return null;
  })();
  const played = info.played || (!session.user && !!localRec);
  const todayScore = info.played ? info.score : (localRec ? localRec.score : null);
  const mod = info.modifier || {};
  const m = showModal(`
    <h2>${t('📅 デイリーチャレンジ', '📅 Daily Challenge')}</h2>
    <p class="center" style="margin:2px 0 6px;font-size:15px"><b>${mod.icon || ''} ${t(mod.ja || '', mod.en || '')}</b><br><small class="muted">${t(mod.descJa || '', mod.descEn || '')}</small></p>
    <p class="muted center" style="margin-bottom:10px">
      ${t(`全プレイヤー共通のピース順で<b>${info.pieces}個</b>の一発勝負！目標 <b>${fmt(info.target)}</b>点でクリア`, `One shot with <b>${info.pieces}</b> pieces — same order for everyone! Score <b>${fmt(info.target)}</b> to clear`)}<br>
      ${played
        ? `${t('今日は挑戦済み', 'Today\'s attempt is done')}${todayScore != null ? ` — <b style="color:var(--yellow)">${fmt(todayScore)}</b>` : ''}${t('（ここからは練習）', ' (practice from here)')}`
        : `<b style="color:var(--yellow)">${t('記録に残るのは最初の1回だけ！', 'Only your FIRST run counts!')}</b>${session.user ? `<br><small>${t('※ 始めた時点で今日の1回を使います（途中でやめても記録は確定）', '* Starting uses today\'s attempt — quitting midway still locks it in')}</small>` : ''}`}
      <br>${t('次のお題まで', 'Next challenge in')} <b>${fmtWeeklyRemain(info.endsAt - Date.now())}</b>
      ${info.streak ? `<br>🔥 ${t(`連続クリア${info.streak}日`, `${info.streak}-day clear streak`)}` : ''}
      ${session.user ? '' : `<br><small>${t('💡 記録とランキングにはログイン', '💡 Log in for records & the ranking')}</small>`}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="dcCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-ghost" id="dcRank">${t('🏆 順位を見る', '🏆 Standings')}</button>
      <button class="btn btn-daily" id="dcStart">${played ? t('🔁 練習する', '🔁 Practice') : t('📅 挑戦する！', '📅 Play!')}</button>
    </div>`);
  m.querySelector('#dcCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#dcRank').onclick = () => { audio.click(); closeModal(); openLeaderboard('daily'); };
  // 記録回は開始時にサーバーへ挑戦を予約する（通信が1往復入る）。押した直後に
  // モーダルを閉じると、遅い回線では「押したのに何も起きない」時間ができる。
  m.querySelector('#dcStart').onclick = async (ev) => {
    audio.click();
    const b = ev.currentTarget;
    if (b.disabled) return;
    b.disabled = true;
    const label = b.textContent;
    b.textContent = t('準備中…', 'Starting…');
    try { await startDaily(info); } finally { b.textContent = label; closeModal(); }
  };
};

// ---- gacha (in-game item buttons are built by modes.js) ----
$('#btnGacha').onclick = () => openGacha();

// ---- guilds + news ----
$('#btnFriends').onclick = () => { audio.click(); openFriends(); };
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

// ---------------------------------------------------------------------------
// 📴 通信が切れたとき
//
// これまでは圏外になっても画面はまったく変わらず、次に何かを押したときに
// はじめて失敗のトーストが出ていた（＝理由が分からない）。トップバーに
// 小さな印を出して、押す前に気づけるようにする。
// ---------------------------------------------------------------------------
function updateOfflineTag(announce) {
  const tag = $('#offlineTag');
  if (!tag) return;
  const off = navigator.onLine === false;
  tag.textContent = t('📴 オフライン', '📴 Offline');
  tag.classList.toggle('hidden', !off);
  if (!announce) return;
  if (off) toast(t('📴 通信が切れました。つながると自動で元に戻ります', '📴 You are offline — everything resumes once the connection is back'), 'err', 4000);
  else toast(t('📶 通信が戻りました', '📶 Back online'), 'ok', 2200);
}
window.addEventListener('offline', () => updateOfflineTag(true));
window.addEventListener('online', () => updateOfflineTag(true));
updateOfflineTag(false);

// ---- Service Worker ----
// ホーム画面から起動するインストール型（manifest は display:standalone）なので、
// 圏外で開くと「接続できません」というブラウザの既定画面がアプリの中に出ていた。
// sw.js は常にネットワークを先に見て、失敗したときだけ控えを出す ──
// つまり更新の届き方は今までと変わらない。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // 起動直後の通信と取り合わないよう、読み込みが済んでから登録する。
  const registerSw = () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .catch(() => { /* 未対応・非HTTPS なら今までどおり動くだけ */ });
  };
  if (document.readyState === 'complete') registerSw();
  else window.addEventListener('load', registerSw, { once: true });
}

// ---- session restore ----
document.body.dataset.screen = 'menu';
initChat();
// 👥 パーティーは chat.js の常時接続に相乗りするので、initChat の後で。
initParty();

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

// ---------------------------------------------------------------------------
// 🎬 起動中の目隠し(#bootVeil)を外す。
//
// ここはモジュール本体のいちばん最後 ── つまり、メニューの onclick が全部
// 付き終わったあと。ここまで来てから外すので、「押せる見た目なのに無反応」な
// 時間がプレイヤーの側には残らない（英語面の applyStaticI18n() も済んでいる
// ので、日本語メニューが一瞬だけ見えることも無い）。
// 万一ここに到達できなくても、CSS 側の 12 秒の保険が同じ目隠しを剥がす。
// ---------------------------------------------------------------------------
{
  const veil = document.getElementById('bootVeil');
  if (veil) {
    veil.classList.add('bv-out');
    setTimeout(() => veil.remove(), 320);   // フェードが終わってから DOM ごと捨てる
  }
}
