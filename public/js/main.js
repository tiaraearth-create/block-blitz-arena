// App bootstrap: wire menu, session restore, global buttons.
import { session, api, refreshMe, setToken, queuedResultCount, UNLOCK_LS_KEYS } from './net.js';
// 🗄 端末に置く bba_* の一覧と仕分け（public/js/localdata.js）。
import { noteUnlockSource, locallyEarnedUnlocks } from './localdata.js';
import { $, $$, showScreen, showModal, closeModal, popModal, toast, updateTopbar, fmt, staffExtras , goBack, initHistory, onModalClosed } from './dom.js';
import { audio } from './audio.js';
import { startSolo, startVsAi, startOnline, startBoss, startBossRush, startChaos, startDungeon, startWeekly, startDaily, startSurvival, startSprint, sprintBest, SPRINT_DURATIONS, cancelMatchmaking, quitCurrent, rerollCurrent, fireUltCurrent, DUNGEON_REALMS, startMeltdown, startChimera, startPuzzle, startDig, puzzleBestStage, startGhost, ghostUnlocked, tutorialDone, pauseModeForDialog, canBookmark, bookmarkCurrent, bookmarkOf, resumeBookmark } from './modes.js';
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
// 📖 ルールの「内容」は rules.js が唯一の正解。ここは並べるだけで、
// 説明の本文も数字も一切持たない（数字を直すときに2か所直す羽目にならない）。
import { ONLINE_MODES, onlineModeLine, rulesSections } from './rules.js';
// 🎨 絵文字ではなく自前のアイコン。index.html は静的なので、起動時に流し込む。
import { icon, iconEl, hasIcon, bossIconName } from './icons.js';

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

// ---------------------------------------------------------------------------
// 📖 遊び方
//
// なぜ作ったか（ユーザーの実話）
//   友達に遊ばせたら「2ライン同時消しで相手に攻撃できる」を最後まで知らなかった。
//   調べたら当然で、このゲームには**ルールを説明する場所が1つも無かった** ──
//   初回チュートリアルは4ステップだけ・1人用モードでしか動かず、オンライン対戦の
//   選択画面はボタンが並ぶだけ、「ヘルプ」に相当する画面も無い。
//
// 作りのきまり
//   ・文言も数字もここには書かない。rules.js の rulesSections() を順に並べるだけ。
//     （数字はサーバー／engine.js の式から写したもので、test/rules.test.mjs が
//       ズレを見張っている。ここに書き写すとその見張りの外に出てしまう。）
//   ・独立した <section id="screen-…"> にはしない。dom.js の SCREENS 配列に
//     名前を足さないと「その画面だけ無言で真っ白」になり（test/clientwiring の
//     5番が同じ事故を見張っている）、dom.js は別タスクの担当だから。
//     screens.js の 🏛️殿堂と同じくモーダルで出す（.modal は 88dvh で
//     縦スクロールするので、長い説明でも入る）。
// ---------------------------------------------------------------------------

// 「一度でも開いたか」。初回の印（#rulesDot）を消す判断にだけ使う。
const RULES_SEEN_KEY = 'bba_rules_seen';

function rulesSeen() {
  // localStorage が使えない環境（プライベートモード等）では「既読」扱い。
  // 消せない印を出し続けるより無害。
  try { return localStorage.getItem(RULES_SEEN_KEY) === '1'; } catch { return true; }
}

// 遊び方に使うアイコン。icons.js に 'rules'（開いた本＋？）が入ったので
// いまはそれが選ばれる。missions（チェック付きクリップボード）を流用しては
// いけない ── あれは 📋ミッションの絵そのもので、ナビに同じ絵が2つ並ぶ。
// 名前で探しているのは、絵の名前が変わってもここを直さずに済ませるため。
const RULES_ICON = ['rules', 'help', 'howto'].find(hasIcon) || null;

/** 遊び方の絵。アイコンがまだ無ければ 📖 の絵文字で代用する。 */
function rulesIcon(size = 20) {
  return RULES_ICON ? icon(RULES_ICON, { size }) : `<span style="font-size:${size}px">📖</span>`;
}

/**
 * 初回導線の印。まだ一度も遊び方を開いておらず、かつチュートリアルも
 * 終えていない人にだけ光らせる。開いた瞬間に消えて二度と出ない。
 */
function updateRulesDot() {
  const dot = $('#rulesDot');
  if (!dot) return;
  dot.classList.toggle('hidden', rulesSeen() || tutorialDone());
}

// 節の1行。文字列ならそのまま段落、{ head, body } なら表として出す。
// 表は既存の .rank-reward-list / .rank-reward-row（左に見出し・右に値の行）を
// 借りている ── style.css は別タスクの担当なので、新しいクラスは足せない。
function rulesRowHtml(row) {
  if (typeof row === 'string') {
    return `<p style="font-size:13px;line-height:1.85;margin:0 0 8px">${row}</p>`;
  }
  const head = (row.head || []);
  const body = (row.body || []);
  return `<div class="rank-reward-list">
    <div class="rank-reward-row" style="background:none;border-style:dashed;font-size:11.5px;color:var(--muted);padding:4px 12px">
      <span style="flex:1">${head[0] || ''}</span><span>${head[1] || ''}</span>
    </div>
    ${body.map(cells => `
      <div class="rank-reward-row">
        <span style="flex:1">${cells[0]}</span><b>${cells[1]}</b>
      </div>`).join('')}
  </div>`;
}

/**
 * 遊び方を開く。
 * @param {object} opts.back 親を開き直す関数（オンライン対戦の選択画面などから
 *   呼ぶとき）。渡すと ✕ が ← になり、閉じたときに親へ戻る。
 */
function showRules(opts = {}) {
  // 開いた時点で初回の印は用済み。閉じ方に依らず消したいので、ここで立てる。
  try { localStorage.setItem(RULES_SEEN_KEY, '1'); } catch { /* 保存できなくても読める */ }
  updateRulesDot();
  const back = typeof opts.back === 'function' ? opts.back : null;
  const m = showModal(`
    <h2>${rulesIcon(24)} ${t('遊び方', 'How to play')}</h2>
    <p class="muted center" style="font-size:12.5px;margin:-6px 0 14px">
      ${t('数字はゲーム本体の式から写したものです。', 'Every number here is taken straight from the game code.')}
    </p>
    ${rulesSections().map(sec => `
      <section style="margin-bottom:20px">
        <h3 style="display:flex;align-items:center;gap:8px;font-size:16px;font-weight:900;margin:0 0 8px">
          ${icon(sec.icon, { size: 20 })}<span>${sec.title}</span>
        </h3>
        ${sec.rows.map(rulesRowHtml).join('')}
      </section>`).join('')}
    <div class="modal-buttons">
      <button class="btn btn-primary" id="ruClose">${back ? t('もどる', 'Back') : t('とじる', 'Close')}</button>
    </div>`, { back });
  // popModal は「親が居れば親へ、居なければ閉じる」。✕／←／Esc／背景タップと
  // まったく同じ道を通すので、閉じ方によって戻り先が変わらない。
  m.querySelector('#ruClose').onclick = () => { audio.click(); popModal(); };
  return m;
}

// メニューのナビから。index.html の #btnRules がこの入口。
$('#btnRules').onclick = () => { audio.click(); showRules(); };
updateRulesDot();

// ---- menu buttons ----
// ▶ ソロプレイ。ここだけ説明が1行も無いまま試合が始まっていた（他の16モードは
// 全部「押したら開始モーダルに1〜2行」で説明している）ので、同じ形に揃える。
// 初見の人が最初に押すボタンでもあるので、遊び方への入口もここに置く。
function showSoloSetup() {
  const best = Math.max(Number(localStorage.getItem('bba_best') || 0),
    session.user ? (session.user.stats.bestScore || 0) : 0);
  const m = showModal(`
    <h2>${icon('mode_solo', { size: 24 })} ${t('ソロプレイ', 'Solo Play')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('手札の3ピースを8×8の盤面に置いて、<b>たて or よこ8マス</b>をそろえて消す基本モード。<br><small>時間制限なし・回転なし。置ける場所が無くなったら終了 — ハイスコアはランキングに載ります。</small>',
          'The basic mode: drop your three pieces on the 8x8 board and complete a <b>full row or column</b>.<br><small>No timer, no rotating. It ends when nothing fits — your best score goes on the leaderboard.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="soRules">${rulesIcon(18)} ${t('遊び方', 'How to play')}</button>
      <button class="btn btn-primary" id="soStart">${t('はじめる', 'Play')}</button>
    </div>`);
  m.querySelector('#soRules').onclick = () => { audio.click(); showRules({ back: showSoloSetup }); };
  m.querySelector('#soStart').onclick = () => { audio.click(); closeModal(); startSolo(); };
}
$('#btnSolo').onclick = () => { audio.click(); showSoloSetup(); };

$('#btnVsAi').onclick = () => {
  audio.click();
  const kamiUnlocked = localStorage.getItem('bba_kami') === '1' || isAdminUser();
  const souzouUnlocked = localStorage.getItem('bba_souzou') === '1' || isAdminUser();
  const unlocked = key => key === 'kami' ? kamiUnlocked : key === 'souzou' ? souzouUnlocked : true;
  const btnClass = { easy: 'btn-primary', normal: 'btn-ai', hard: 'btn-gold', oni: 'btn-oni', kami: 'btn-kami', souzou: 'btn-souzou' };
  const m = showModal(`
    <h2 id="aiModalTitle">${icon('mode_ai', { size: 24 })} ${t('AI対戦', 'VS AI')}</h2>
    <p class="muted center" style="margin-bottom:12px">${t('2分間のスコアバトル！同じピースが配られます', 'A 2-minute score battle! You both get the same pieces')}</p>
    <div class="form-col" id="aiLevelList">
      ${Object.entries(AI_LEVELS)
        .map(([key, cfg]) => (unlocked(key)
          ? `
        <button class="btn ${btnClass[key]}" data-ai="${key}">
          ${icon(cfg.iconName, { size: 20 })} ${t(cfg.name, cfg.nameEn || cfg.name)}
        </button>`
          // 🔓 まだ開いていない段は**行ごと消さず**、押せない「？？？」を出す。
          //    消してしまうと「鬼の先に何かある」こと自体が伝わらず、
          //    隠しコマンドを知らない人には存在しないのと同じだった。
          //    名前も中身も出さない（秘密は保つ）。開ける条件だけ言う。
          : `
        <button class="btn btn-ghost" data-locked="${key}" disabled
          style="opacity:.55;cursor:default">
          ？？？<br><small style="font-weight:600;opacity:.8">${key === 'kami'
            ? t('鬼に肉薄した者にだけ現れる', 'Appears for those who push the Oni close')
            : t('神に肉薄した者にだけ現れる', 'Appears for those who push the Kami close')}</small>
        </button>`)).join('')}
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
    // ここは textContent なので SVG を置けない ── 他の行と同じ形になるよう innerHTML で揃える。
    // 名前は AI_LEVELS の固定値（外部入力ではない）なのでそのまま差してよい。
    btn.innerHTML = `${icon(AI_LEVELS.kami.iconName, { size: 20 })} ${t(AI_LEVELS.kami.name, AI_LEVELS.kami.nameEn || AI_LEVELS.kami.name)}`;
    m.querySelector('#aiLevelList').appendChild(btn);
    wire();
  });
};

// ===========================================================================
// 🔓 隠し要素の解放（神 / 創造神 / 幽霊屋敷）
// ===========================================================================
//
// ■ 解放される道は3つある。どれも入口の形がまったく違うので混ざらない。
//   1. 実力で開く（いちばん自然でスマホでも通る道）
//        鬼に勝つ → 神が現れる ／ 神に勝つ → 創造神が現れる
//      判定するのはサーバー（server/index.js の applyGameResult）で、
//      解放はアカウントに入って返ってくる。クライアントは何も申告しない。
//   2. 隠しコマンド（PC）… ↑↑↓↓←→←→BA ／ その続きに BABA↓↑↓↑
//   3. 隠しコマンド（スマホ）… ロゴを**長押し**して出る紋のパッドを叩く（下）
//   （幽霊屋敷だけは従来どおりロゴの13連打。1〜3のどれとも混ざらない）
//
// ■ 保存
//   ログイン中はアカウント（user.stats.unlocks）に残る＝端末を変えても消えない。
//   ゲストは今までどおり localStorage だけ。読む側（AI対戦の一覧・幽霊屋敷の扉・
//   modes.js の ghostUnlocked）は **localStorage しか見ない** ままでよい ──
//   サーバーの一覧は net.js が localStorage へ映してくれる（片道／消さない）。
// ===========================================================================

// 起動した時点で既に開いていたもの。あとから届いた解放だけを祝うために要る
// （毎回の再訪でお祝いが鳴ったらただの騒音）。
const unlockedAtBoot = new Set(
  Object.entries(UNLOCK_LS_KEYS).filter(([, k]) => {
    try { return localStorage.getItem(k) === '1'; } catch { return false; }
  }).map(([id]) => id));

function hasUnlock(id) {
  try { return localStorage.getItem(UNLOCK_LS_KEYS[id]) === '1'; } catch { return false; }
}
function markUnlockLocally(id) {
  try {
    localStorage.setItem(UNLOCK_LS_KEYS[id], '1');
    // 「この端末で自力で見つけた」印。これがあるものだけが下の
    // carryOverLocalUnlocks でアカウントへ引き継がれる（＝別のアカウントから
    // 写ってきただけの解放は引き継がない）。
    noteUnlockSource(UNLOCK_LS_KEYS[id], 'local');
  } catch { /* 保存できなくてもこの回は遊べる */ }
}

// 解放をアカウントへ送る。ゲスト（未ログイン）は何もしない。
// 失敗しても握りつぶす ── 端末側には既に印が付いているので、次にログインした
// ときの引き継ぎ（carryOverLocalUnlocks）が拾い直す。
function pushUnlock(id) {
  const u = session.user;
  if (!u) return;
  const have = (u.stats && u.stats.unlocks) || [];
  if (have.includes(id)) return;
  api('/api/me/unlocks', { method: 'POST', body: { unlocks: [id], from: 'hidden' } })
    .catch(() => { /* 圏外・レート上限。次のログインで引き継がれる */ });
}

// お祝いの演出。解放の記録（localStorage / サーバー）とは切り離してある ──
// 「他の端末で開けたぶんが届いた」ときにも同じ演出を使い回すため。
function celebrateUnlock(id) {
  if (id === 'kami') {
    audio.kamiDescend();
    confettiBurst(50);
    toast(t('天から声が聞こえる……隠し難易度「神」が解放された', 'A voice echoes from the heavens… hidden difficulty "Kami" unlocked!'), 'announce', 5000);
  } else if (id === 'souzou') {
    audio.kamiDescend();
    audio.bossAttack();
    confettiBurst(80);
    toast(t('宇宙の彼方から視線を感じる……真の隠し難易度「創造神」が姿を現した', 'Something watches from beyond the cosmos… the true hidden difficulty "Creator God" has appeared!'), 'announce', 6000);
  } else if (id === 'ghost') {
    document.body.classList.add('ghost-flicker');
    setTimeout(() => document.body.classList.remove('ghost-flicker'), 3500);
    audio.gameOver();
    setTimeout(() => audio.kamiDescend(), 900);
    toast(t('……見つかってしまった。メニューに「幽霊屋敷」への扉が現れた', '…it has noticed you. A door to the Haunted House has appeared on the menu'), 'announce', 6000);
  }
}

// 端末で解放が起きたときの共通の入口。すでに開いていれば何もしない（＝
// 二度目のコマンド入力で演出が二重に鳴らない）。
function unlockHere(id) {
  if (hasUnlock(id)) return false;
  markUnlockLocally(id);
  celebrateUnlock(id);
  pushUnlock(id);
  updateGhostButton();
  return true;
}

function unlockKami() { unlockHere('kami'); }

function unlockSouzou() {
  // 創造神は神の上位。神を飛ばして開くと AI対戦の一覧に穴が空くので、
  // 先に神を（演出なしで）そろえてから開ける。
  if (!hasUnlock('kami')) { markUnlockLocally('kami'); pushUnlock('kami'); }
  unlockHere('souzou');
}

// ---------------------------------------------------------------------------
// 🔓 アカウント側との橋渡し
// ---------------------------------------------------------------------------
// (a) サーバー → 端末 … net.js が localStorage へ映して 'bba:unlocks-changed'
//     を出す。ここではそれを受けて、扉を塗り直し、届いたぶんを祝う。
// (b) 端末 → サーバー … ログインした人がこの端末で既に開けていたぶんを
//     1回だけ引き継ぐ（PCで開けた人がスマホでも開いた状態になる）。
// ---------------------------------------------------------------------------

// 「他の端末ぶんの復元」は静かに知らせるだけにする。そこで盛大に鳴らすと、
// 新しい端末で開くたびに幽霊屋敷の画面がちらつく。逆に「いま鬼を倒した」は
// 本番の演出（音・紙吹雪・天からの声）でなければ、隠し要素を自力で開けた
// 手応えが丸ごと消える。
//
// ⚠ 見分けを「この画面で1回目かどうか」でやってはいけない。
//   復元は起動直後の refreshMe() から来るが、**解放を1つも持っていない
//   アカウントでは起動時に何も届かない**（net.js は空の一覧では合図を出さない）。
//   その人が鬼を倒すと、それが画面の1回目になり、いちばん盛り上がる場面で
//   「別の端末で解放した隠し要素を引き継ぎました」と出ていた ── 新規
//   アカウントほど確実に踏む。
//
// 届いた時刻で分ける。復元は起動処理の一部なので必ず数秒以内に来る。
// 対戦は最短でも1分はかかるので、両者が重なることはない。
const UNLOCK_BOOT_SYNC_MS = 15000;
const bootAt = Date.now();
window.addEventListener('bba:unlocks-changed', e => {
  updateGhostButton();
  const ids = (e.detail && Array.isArray(e.detail.unlocks)) ? e.detail.unlocks : [];
  const fresh = ids.filter(id => UNLOCK_LS_KEYS[id] && !unlockedAtBoot.has(id));
  for (const id of fresh) unlockedAtBoot.add(id);   // 同じものを二度祝わない
  if (!fresh.length) return;
  if (Date.now() - bootAt < UNLOCK_BOOT_SYNC_MS) {
    toast(t('別の端末で解放した隠し要素を引き継ぎました', 'Hidden content you unlocked on another device has been restored'), 'ok', 4000);
  } else {
    for (const id of fresh) celebrateUnlock(id);
  }
});

// この画面で引き継ぎを試したユーザー。session-changed は上部バーの更新の
// たびに飛んでくるので、送るのは1人につき1回にする（サーバー側も
// 1アカウント1回しか受け付けない）。
const unlockCarried = new Set();

function carryOverLocalUnlocks() {
  const u = session.user;
  if (!u || !u.stats) return;                      // ゲストは localStorage だけ
  if (u.stats.unlockImportedAt) return;            // このアカウントは引き継ぎ済み
  if (unlockCarried.has(u.id)) return;
  const have = u.stats.unlocks || [];
  // 引き継ぐのは **この端末で自力で見つけたぶんだけ**。
  // 以前は「印が付いていれば何でも」送っていたので、共用端末で
  //   A（神を持っている）がログイン → 端末に神の印が写る → Aがログアウト
  //   → Bがログイン → Bのアカウントに神が入る
  // が起きていた。しかも引き継ぎは1アカウント1回きりなので、Bは自分の枠を
  // 他人の解放で使い切ってしまう。
  const earned = new Set(locallyEarnedUnlocks());
  const ids = Object.keys(UNLOCK_LS_KEYS)
    .filter(id => hasUnlock(id) && earned.has(UNLOCK_LS_KEYS[id]) && !have.includes(id));
  if (!ids.length) return;                         // 送るものが無いなら1回きりの枠を使わない
  unlockCarried.add(u.id);
  api('/api/me/unlocks', { method: 'POST', body: { unlocks: ids, from: 'local' } })
    .then(() => toast(t('この端末で解放した隠し要素をアカウントに保存しました', 'Your hidden unlocks on this device are now saved to your account'), 'ok', 4000))
    .catch(() => { /* 409（もう済み）も圏外も、放っておいてよい */ });
}
window.addEventListener('bba:session-changed', carryOverLocalUnlocks);

// ---- 🔖 しおり: メニューの一番上に「続きから」 ----
//
// 預けた1本は、開いた瞬間に目に入る場所に出す。ここに出さないと
// 「預けたのに、どこから戻るのか分からない」で終わる。
// 器は index.html に無いのでここで作る（出すものが無い間は作りもしない）。
export function refreshBookmarkCard() {
  const menu = document.querySelector('#screen-menu .menu-buttons');
  if (!menu) return;
  const old = document.querySelector('#bookmarkCard');
  const bm = bookmarkOf();
  if (!bm) { if (old) old.remove(); return; }
  const leftMs = 48 * 60 * 60 * 1000 - (Date.now() - bm.at);
  const hours = Math.max(1, Math.round(leftMs / 3600000));
  const soon = hours <= 12;
  const el = old || document.createElement('button');
  el.id = 'bookmarkCard';
  el.className = `btn btn-big btn-primary${soon ? ' bookmark-soon' : ''}`;
  // 🔖 幅は CSS に任せる（style.css の #bookmarkCard が grid-column: 1 / -1）。
  //    ここで width:100% を書いても「マスの100%」でしかなく、行いっぱいにはならない。
  el.textContent = `${t('続きから', 'Continue')} — ${bm.label || ''}${bm.score ? ` ・ ${fmt(bm.score)}` : ''}`
    + ` ・ ${t(`あと${hours}時間`, `${hours}h left`)}`;
  el.onclick = () => {
    audio.click();
    if (!resumeBookmark()) {
      toast(t('続きを開けませんでした', 'Could not resume that run'), 'err', 3000);
      refreshBookmarkCard();
    }
  };
  if (!old) menu.insertBefore(el, menu.firstChild);
}
window.addEventListener('bba:session-changed', refreshBookmarkCard);

// ---- 👻 幽霊屋敷: メニューのロゴを13回連続タップで解放 ----
function updateGhostButton() {
  $('#btnGhost').classList.toggle('hidden', !ghostUnlocked());
}
// ghostUnlocked() は localStorage か session.user.role==='admin' で決まるので、
// 「いま誰でログインしているか」が変わったら必ず塗り直す。updateTopbar() が
// 出す合図に乗せてあるので、ログインの導線が増えてもここは直さなくてよい。
window.addEventListener('bba:session-changed', updateGhostButton);

function unlockGhost() { unlockHere('ghost'); updateLogoHint(); }

// ---------------------------------------------------------------------------
// ロゴの13連打（幽霊屋敷）と、ロゴの長押し（神・創造神の紋）は同じ要素に
// 乗っているが、**入口が「押した時間」で分かれている**ので混ざらない。
//   ・13連打 … click（1回あたり100ms前後の短い当たり）を数える
//   ・紋     … pointerdown から指を離さずに LOGO_HOLD_MS 経つ
// 長押しが成立した回の click は数に入れない（下の suppressLogoClick）。
// 入れてしまうと「長押し1回＝13連打の1歩」になり、意図せず数が進む。
// ---------------------------------------------------------------------------
const LOGO_HOLD_MS = 700;
let ghostTaps = 0;
let ghostTapTimer = null;
let suppressLogoClick = false;
let logoHoldTimer = null;

const logoEl = document.querySelector('.logo');

// 🕯 ある程度遊んだ人にだけ、ロゴがかすかに息をする。
//
//    👻幽霊屋敷は1モードまるごと「ロゴ13連打」を知らないと一生出てこない。
//    答えは言いたくないが、**触る場所があること**だけは伝わってほしい。
//    30回遊んだ人に限るのは、初日から光っていると「押せ」の指示になって
//    秘密ではなくなるから。解放済みの人にはもう出さない。
function updateLogoHint() {
  if (!logoEl) return;
  // 🕯 ゲストにも出す。以前は session.user.stats.gamesPlayed だけを見ていたので、
  //    **ログインしていない人には永久に 0**（═ヒントが一度も出ない）だった。
  //    👻幽霊屋敷は「ロゴの13連打」を知らないと一生出てこないモードなので、
  //    触る場所があることだけは伝わってほしい。端末側のプレイ回数と大きいほうを見る。
  const server = (session.user && session.user.stats && session.user.stats.gamesPlayed) || 0;
  let local = 0;
  try { local = Number(localStorage.getItem('bba_plays') || 0) || 0; } catch { local = 0; }
  logoEl.classList.toggle('has-secret', Math.max(server, local) >= 30 && !ghostUnlocked());
}
// 「いま誰でログインしているか」が変わったら塗り直す（幽霊屋敷のボタンと同じ合図）。
window.addEventListener('bba:session-changed', updateLogoHint);

logoEl.addEventListener('click', () => {
  // 長押しで紋を出した回。ここで数えると13連打側が意図せず進む。
  if (suppressLogoClick) { suppressLogoClick = false; return; }
  ghostTaps++;
  clearTimeout(ghostTapTimer);
  ghostTapTimer = setTimeout(() => { ghostTaps = 0; }, 2000);   // 2秒空いたらリセット
  // 10回目から不穏な気配（音が少しずつ低く沈む）
  if (ghostTaps >= 10 && ghostTaps < 13) audio.putback();
  if (ghostTaps === 13) { ghostTaps = 0; unlockGhost(); }
});

// 長押しの検出。pointer 系はマウスも指もペンも同じ道を通るので1組で足りる。
const cancelLogoHold = () => { clearTimeout(logoHoldTimer); logoHoldTimer = null; };
logoEl.addEventListener('pointerdown', () => {
  // 前の押下の取りこぼしを引きずらない。長押しでモーダルが被さると、
  // 指を離したときの click はロゴではなく背景側で起きるので、
  // 「この click は数えない」の印が消えないまま残ることがある ──
  // そのままだと**次の本物のタップが1回ぶん消える**（13連打が14回必要になる）。
  suppressLogoClick = false;
  cancelLogoHold();
  logoHoldTimer = setTimeout(() => {
    logoHoldTimer = null;
    // 押したまま13連打には**絶対にならない**（連打は指を離す動作）。
    // ここまで来たら、この押下の click は数えない。
    suppressLogoClick = true;
    ghostTaps = 0;
    clearTimeout(ghostTapTimer);
    openSigilPad();
  }, LOGO_HOLD_MS);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  logoEl.addEventListener(ev, cancelLogoHold);
}
// 長押しでスマホの選択メニュー（コピー／共有）が割り込むと、紋が出る前に
// 指が奪われる。ロゴは文字なので選択もハイライトも要らない。
// ⚠ CSS ファイルは別担当なので、ここは属性スタイルで閉じる（CSP は
//    style-src に 'unsafe-inline' を許しているので属性は効く）。
logoEl.style.userSelect = 'none';
logoEl.style.webkitUserSelect = 'none';
logoEl.style.webkitTouchCallout = 'none';
logoEl.addEventListener('contextmenu', e => e.preventDefault());

// ---------------------------------------------------------------------------
// ✦ 紋のパッド ── スマホ用の隠しコマンド
// ---------------------------------------------------------------------------
//
// なぜ「もう1つのタップ回数」にしなかったか:
//   ユーザーの指摘どおり、回数を数える入口を増やすと13連打と必ず混ざる。
//   ここは **順番** を見る（同じものを何回叩いても永久に一致しない）ので、
//   構造的に誤爆しない ── 実際 test/unlocks.test.mjs が「同じ印だけを
//   30回叩く」「13連打相当の列」を全部通して、一度も開かないことを見ている。
//
// 並びはキーボードのコマンドの写し。◉ が B と A の両方を兼ねる:
//   ↑↑↓↓←→←→ B A          → ▲▲▼▼◀▶◀▶◉◉            （神）
//   …の続きに B A B A ↓↑↓↑  → …の続きに ◉◉◉◉▼▲▼▲    （創造神）
// 長さも 10 / 18 でキーボードと同じ。
const PAD_KAMI = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'orb', 'orb'];
const PAD_SOUZOU = [...PAD_KAMI, 'orb', 'orb', 'orb', 'orb', 'down', 'up', 'down', 'up'];
// 覚えておく打鍵の上限。押しっぱなしにされても伸びないようにする。
const PAD_MEMORY = PAD_SOUZOU.length + 4;

/**
 * 叩いた順番（末尾）がどの合図に一致するかを返す。純粋関数。
 * パッドに無いトークン（ロゴの 'logo' など）は一致しようがないので、
 * 13連打をそのまま流し込んでも null のまま。
 */
function matchPadSecret(taps) {
  const endsWith = pat => taps.length >= pat.length
    && pat.every((v, i) => taps[taps.length - pat.length + i] === v);
  if (endsWith(PAD_SOUZOU)) return 'souzou';
  if (endsWith(PAD_KAMI)) return 'kami';
  return null;
}

function openSigilPad() {
  audio.putback();
  const taps = [];
  const cell = (dir, glyph, label) =>
    `<button class="btn btn-ghost" data-pad="${dir}" aria-label="${label}"
       style="min-width:0;padding:12px 0;font-size:20px;line-height:1">${glyph}</button>`;
  const m = showModal(`
    <h2 style="letter-spacing:.3em">✦</h2>
    <p class="muted center" style="margin-bottom:14px">
      ${t('天と地の順を、そらんじよ。', 'Recite the order of heaven and earth.')}
    </p>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:240px;margin:0 auto">
      <span></span>${cell('up', '▲', t('上', 'up'))}<span></span>
      ${cell('left', '◀', t('左', 'left'))}${cell('orb', '◉', t('印', 'orb'))}${cell('right', '▶', t('右', 'right'))}
      <span></span>${cell('down', '▼', t('下', 'down'))}<span></span>
    </div>
    <p class="center" id="padTrace" style="min-height:18px;margin-top:12px;letter-spacing:.35em;opacity:.55"></p>`);
  const trace = m.querySelector('#padTrace');
  m.querySelectorAll('[data-pad]').forEach(btn => {
    btn.onclick = () => {
      audio.click();
      taps.push(btn.dataset.pad);
      if (taps.length > PAD_MEMORY) taps.shift();
      // 「何手目まで積んだか」だけを出す。並びそのものは映さない
      // （肩越しに見ている人へ答えを教えないため）。
      trace.textContent = '·'.repeat(Math.min(taps.length, 18));
      const hit = matchPadSecret(taps);
      if (!hit) return;
      if (hit === 'kami' && !hasUnlock('kami')) {
        // 神が開いた時点では閉じない ── ここから続けて創造神へ行けるので、
        // 扉を閉めてしまうと「続きがある」ことに永久に気づけない。
        unlockKami();
      } else if (hit === 'souzou') {
        unlockSouzou();
        closeModal();
      }
    };
  });
}

$('#btnGhost').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_ghost_best') || 0),
    session.user ? (session.user.stats.ghostBest || 0) : 0);
  const m = showModal(`
    <h2>${icon('mode_ghost', { size: 24 })} ${t('幽霊屋敷', 'Haunted House')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('この屋敷では、置いたブロックが<b>約1秒で透明になる</b>。頼れるのは記憶だけ。<br><small>ラインを消した瞬間だけ、盤面のすべてが姿を現す。ドラッグ中の影が唯一の手がかり — 初回15,000点で幽霊屋敷バッジ＋ジェム250。</small>',
          'In this house, placed blocks <b>turn invisible after a second</b>. Memory is all you have.<br><small>Every line clear reveals the whole board for a moment. Your drag shadow is the only other clue — first 15,000 earns the Haunted House badge + 250 gems.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="ghCancel">${t('逃げる', 'Run away')}</button>
      <button class="btn btn-ghostmode" id="ghStart">${t('屋敷に入る', 'Enter the house')}</button>
    </div>`);
  m.querySelector('#ghCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#ghStart').onclick = () => { audio.click(); closeModal(); startGhost(); };
};

updateGhostButton();   // 解放済み(またはadmin)なら最初から扉が見えている
updateLogoHint();      // 🕯 30回遊んだ人にはロゴがかすかに息をする
refreshBookmarkCard(); // 🔖 預けた1本があれば、開いた瞬間に見える場所へ

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
      <h2>${icon('mode_boss', { size: 24 })} ${t('ボス戦', 'Boss Battle')}</h2>
      <p class="muted center" style="margin-bottom:12px">${t('ラインを消してダメージを与えろ！<br>ボスはお邪魔ブロックで反撃してくる。盤面が埋まったら敗北！', 'Clear lines to damage the boss!<br>It fights back with garbage blocks. Fill up the board and you lose!')}</p>
      <div class="form-col">
        ${data.bosses.map((b, i) => {
          const locked = i > bossMax;
          const cleared = i < bossMax;
          return `
          <button class="btn boss-select ${locked ? 'btn-ghost' : 'btn-boss'}" data-boss="${i}" ${locked ? 'disabled' : ''}>
            <span>${locked ? icon('lock', { size: 18 }) : icon(bossIconName(b.id), { size: 20 })} ${catName(b)}</span>
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
            <span>${rushOpen ? icon('mode_bossrush', { size: 20 }) : icon('lock', { size: 18 })} ${t('無限地獄ラッシュ', 'Infinite Hell Rush')}</span>
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

// ---------------------------------------------------------------------------
// 🌐 オンライン対戦の選択画面
//
// 直した問題
//   ボタンが8個並ぶだけで説明文が1行も無く、「押すまで何が起きるか分からない」
//   画面だった。攻撃があるのは一部のモードだけなのに、その違いもどこにも
//   書かれていない ── 友達が最後まで攻撃を知らなかった直接の原因がこれ。
//   ボタンごとに rules.js の1行説明を必ず添える。
//
// 名前と並び順も入れ替えた
//   攻撃ありの試合を対戦の本流にする、というのがこの版の決定。先頭に
//   「1v1 ランクマッチ」（内部 'attack'）を置き、攻撃なしは「クラシック」
//   （内部 'duel'）としてその次に置く。
//   ⚠️ 内部の呼び名（'duel' / 'attack'）は変えていない。サーバーとテストが
//      多数参照していて、名前を入れ替えると意味が反転する。変えたのは
//      **表示名と並び順だけ**で、その対応は rules.js の ONLINE_MODES にある。
//   ⚠️ startOnline() の既定値は 'duel'（＝クラシック）のまま。ここからは必ず
//      押されたボタンの kind を明示的に渡すので、既定値には落ちない。
//      modes.js は別タスクの担当なので、既定値そのものは触らない。
//
// ⚠️ data-online="…" は**リテラルで**書くこと。
//    test/rules.test.mjs が main.js のソースを /data-online="([a-z]+)"/ で読んで
//    「並んでいる全モードに rules.js の1行説明があるか」を突き合わせている。
//    テンプレート式（data-online="${kind}"）にすると一覧が0件になり、検査は
//    何も見ないまま緑になる ── 説明の抜けを二度と検出できなくなる。
//    中身（アイコン・名前・説明・並び順）は下の配線で ONLINE_MODES から流し込む。
// ---------------------------------------------------------------------------

// ここに要るのはボタンの色だけ。名前・説明・並び順は rules.js が唯一の正解。
const ONLINE_BTN_CLASS = {
  attack: 'btn-primary',   // 対戦の本流。メニューの ▶ソロ と同じ主役の青
  duel: 'btn-online',
  team: 'btn-coop',
  tourney: 'btn-gold',
  royale: 'btn-oni',
  raid: 'btn-boss',
  coop: 'btn-chimera',
  custom: 'btn-ghost',
};

function showOnlineSelect() {
  const m = showModal(`
    <h2>${icon('mode_online', { size: 24 })} ${t('オンライン対戦', 'Online Battle')}</h2>
    <p class="muted center" style="font-size:12.5px;margin:-6px 0 12px">
      ${t('押す前にルールが分かるように、全モードに1行の説明を付けてあります。',
          'Every mode has a one-line summary, so you know what happens before you tap.')}
    </p>
    <!-- btn-big は付けない。1行説明が入って2段になるぶん、8個並べると
         19px では画面に収まらなくなる（.btn の 16px でも指の当たりは足りる）。 -->
    <div class="form-col" id="onlineList">
      <button class="btn" data-online="attack"></button>
      <button class="btn" data-online="duel"></button>
      <button class="btn" data-online="team"></button>
      <button class="btn" data-online="tourney"></button>
      <button class="btn" data-online="royale"></button>
      <button class="btn" data-online="raid"></button>
      <button class="btn" data-online="coop"></button>
      <button class="btn" data-online="custom"></button>
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="olRules">${rulesIcon(18)} ${t('攻撃のしくみを読む', 'How attacking works')}</button>
    </div>`);

  const list = m.querySelector('#onlineList');
  // 並び順の正解も rules.js。上の HTML の順ではなく ONLINE_MODES の順に並べ直す
  // ので、本流を入れ替えるときに直すのは rules.js だけで済む。
  // appendChild は「移動」なので、並べ直してもボタンは増えない。
  for (const mode of ONLINE_MODES) {
    const btn = list.querySelector(`[data-online="${mode.kind}"]`);
    if (btn) list.appendChild(btn);
  }

  list.querySelectorAll('[data-online]').forEach(btn => {
    const kind = btn.dataset.online;
    const mode = ONLINE_MODES.find(x => x.kind === kind);
    btn.classList.add(ONLINE_BTN_CLASS[kind] || 'btn-online');
    // rules.js に載っていないモードが混ざっても、名前だけは出して押せるままに
    // する（説明の抜けは test/rules.test.mjs が別に落としてくれる）。
    const name = mode ? mode.name() : kind;
    const tag = mode && mode.tag ? mode.tag() : '';
    btn.innerHTML = `
      <span style="display:flex;align-items:center;justify-content:center;gap:7px;flex-wrap:wrap">
        ${mode ? icon(mode.icon, { size: 22 }) : ''}<span>${name}</span>
        ${tag ? `<i style="font-size:11px;font-weight:800;font-style:normal;opacity:.85;border:1px solid currentColor;border-radius:999px;padding:1px 7px">${tag}</i>` : ''}
      </span>
      <small style="display:block;margin-top:5px;font-size:12px;font-weight:600;line-height:1.55;opacity:.92;white-space:normal">${onlineModeLine(kind)}</small>`;
    // 押されたモードを必ず明示で渡す（startOnline の既定値 'duel' に落ちない）。
    btn.onclick = () => { audio.click(); closeModal(); startOnline(kind); };
  });

  // 攻撃表・得点表までは1行では書けないので、続きは遊び方へ。
  // back を渡してあるので、閉じるとこの選択画面に戻る。
  m.querySelector('#olRules').onclick = () => { audio.click(); showRules({ back: showOnlineSelect }); };
}
$('#btnOnline').onclick = () => { audio.click(); showOnlineSelect(); };
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
  // ⏸ 読んでいる数秒で走行を終わらせない。暗幕で指は届かないのに、ボスの
  //    予告技も波も時計も進んでいた。オンラインでは null が返る（相手を
  //    待たせられないので、そこは止めない）。
  const resume = pauseModeForDialog();
  const m = showModal(`
    <h2>${t('ゲームを終了しますか？', 'Quit this game?')}</h2>
    ${(() => {
      // モードによって「やめたらどうなるか」は全然ちがう。
      // ソロで「引き分け扱い」と言われても、相手がいないので意味が通らない。
      //
      // ⚠ まずモード自身に聞くこと。modes.js の quitWarning() は
      //   「協力プレイの離脱は敗北にならない」「観戦をやめるだけ」
      //   「ロイヤルで生存中なら最下位扱い」「デイリーはこの1回で確定」を
      //   出し分けるために書かれていて、コメントにも『読み手は main.js の
      //   ✕ 確認モーダル』と明記してある。ところがここが一度も呼んでおらず、
      //   mode だけで決めていた ── OnlineMode は協力・陣取り・レイド・ロイヤル・
      //   ルーム観戦まで全部 mode='pvp' なので、**実際の裁定と正反対の文面**が
      //   出ていた（観戦をやめるだけの人に「離脱は敗北」など）。
      if (cur && typeof cur.quitWarning === 'function') {
        try {
          const w = cur.quitWarning();
          // null は「失うものが無い」＝警告を出さないという意思表示。
          if (w) return `<p class="muted center">${w}</p>`;
          return `<p class="muted center">${t('ここでやめても失うものはありません', 'Nothing is lost if you stop here')}</p>`;
        } catch { /* 壊れていても下の従来どおりの文面に落ちる */ }
      }
      const online = cur && (cur.mode === 'pvp' || cur.kind);
      return `<p class="muted center">${online
        ? t('離脱は<b style="color:var(--red)">敗北</b>になります', 'Leaving counts as a <b style="color:var(--red)">loss</b>')
        : t('ここまでのスコアで記録されます', 'Your score so far will be recorded')}</p>`;
    })()}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="qNo">${t('続ける', 'Keep playing')}</button>
      ${/* 🔖 しおり。中断＝終了しか無かったので、長いモードは「まとまった
            時間が取れる日」にしか触れなかった。1本だけ預けて、次のスキマで
            同じ盤面から続けられる。 */''}
      ${/* ラベルは全角3文字まで。style.css の .modal-buttons .btn は
            min-width を明示しているので min-width:auto が効かず、
            flex は「文字より狭い」幅を割り当ててよくなる（＝ flex-wrap が
            発動しないまま字がボタンの外へはみ出し、隣の赤いボタンに潜る）。
            実測で「しおりをはさむ」は 900px 幅で 124px 必要・109px しか無かった。
            CSS 側のコメント（.modal-buttons の予算 ＝ 1本あたり約98px・全角4文字）
            に合わせる。 */''}
      ${canBookmark() ? `<button class="btn btn-primary" id="qMark">${t('しおり', 'Bookmark')}</button>` : ''}
      <button class="btn btn-ai" id="qYes">${t('終了する', 'Quit')}</button>
    </div>`);
  // 「続ける」で必ず時計を戻す。枠外タップ・Esc でも閉じられるので、
  // ボタンの onclick だけに書くと止まったままになる（＝永久に無敵）。
  m.querySelector('#qNo').onclick = closeModal;
  m.querySelector('#qYes').onclick = () => { closeModal(); quitCurrent(); };
  const mark = m.querySelector('#qMark');
  if (mark) mark.onclick = () => {
    audio.click();
    if (!bookmarkCurrent()) {
      toast(t('しおりをはさめませんでした', 'Could not save a bookmark'), 'err', 3000);
      return;
    }
    closeModal();
    toast(t('しおりをはさみました ── メニューの「続きから」で戻れます（48時間）',
      'Bookmarked — pick it up from “Continue” on the menu (48 hours)'), 'ok', 4500);
    // メニューへ戻すのは bookmarkCurrent の中（endToMenu を通す）。
    // view に差し込まれたフックまで畳む必要があるので、自前で showScreen
    // するのでは足りない。
    refreshBookmarkCard();
  };
  if (resume) onModalClosed(resume);
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
  // 🪟 モーダルが開いている間は奥義に触らない。
  //    body.dataset.screen はモーダルが出ても 'game' のままなので、
  //    「終了しますか？」の上で Space を押すと、裏で切り札が1本消えていた。
  //    逆に結果モーダルでは preventDefault に殺されて、Space でボタンを
  //    押せなかった（キーボードだけで遊んでいる人は出口を失う）。
  //    ここは preventDefault もせずに素通りさせるのが正しい。
  const root = document.getElementById('modal-root');
  if (root && root.firstChild) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  // 押しっぱなしの自動リピートで連発しない（1本しかない切り札が溶ける）。
  if (e.repeat) return;
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
      <button class="btn btn-primary btn-big" data-lang="ja">日本語ではじめる</button>
      <button class="btn btn-online btn-big" data-lang="en">Play in English</button>
      <small style="opacity:.65">Language / 言語はあとで設定から変更できます</small>`;
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

// イベントの絵。第4波の統合で server/events.js が iconName（icons.js の名前）を
// 送ってくるようになったので、ここに持っていた対応表は捨てた。
// （同じ対応を main.js と screens.js の2か所に持つと、イベントを
//   1つ足したときに片方だけ絵が出ないというズレ方をする。）
// ※ ev.icon（絵文字）はライブフィード専用で、画面では使わない。
// ⚠️ イベント名は管理者が自由に付けられる（＝外部入力）ので、名前は必ず
//    テキストノードで入れること。innerHTML に混ぜない。
const evIcon = ev => (ev && ev.iconName) || 'mode_chaos';

// バナーに「アイコン＋文字」を入れる。文字は textContent 相当（テキストノード）。
function paintBannerText(el, iconName, text) {
  el.replaceChildren(iconEl(iconName, { size: 16 }), document.createTextNode(' ' + text));
}

function updateEventBanner() {
  const banner = $('#eventBanner');
  const btn = $('#btnChaos');
  const ev = window.__bbaEvent;
  if (ev && ev.endsAt > Date.now()) {
    paintBannerText(banner, evIcon(ev),
      t(`期間限定「${ev.name}」開催中！ — 残り${fmtRemain(ev.endsAt - Date.now())}`,
        `Limited event "${ev.nameEn || ev.name}" is live! — ${fmtRemain(ev.endsAt - Date.now())} left`));
    banner.classList.remove('hidden');
    // 🌀 カオスのボタンは常時出す（上の #btnChaos の注記を参照）。
    //    カオスイベント中だけ「いまは実入りが良い」ことを見た目で伝える。
    if (btn) {
      btn.classList.remove('hidden', 'staff-only');
      btn.classList.toggle('event-live', ev.type === 'chaos');
    }
  } else {
    if (ev) window.__bbaEvent = null;   // expired locally — hide until next poll
    banner.classList.add('hidden');
    if (btn) { btn.classList.remove('hidden', 'staff-only', 'event-live'); }
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
  const name = t(ne.name || 'お楽しみイベント', ne.nameEn || ne.name || 'a special event');
  const clock = new Date(startsAt).toLocaleTimeString(t('ja-JP', 'en-US'), { hour: '2-digit', minute: '2-digit' });
  const remain = fmtRemain(startsAt - Date.now());
  // 予告も開催中と同じ絵（種類の id から引く）。種類が分からないときは「お知らせ」の絵。
  paintBannerText(el, (ne && ne.iconName) || 'news',
    t(`${whenWord(startsAt)}は「${name}」開催！ ${clock}スタート（あと${remain}）`,
      `"${name}" starts ${whenWord(startsAt)} at ${clock}! (in ${remain})`));
  el.classList.remove('hidden');
}

async function pollStatus() {
  try {
    // api() attaches the bearer token, which is what lets /api/status return
    // YOUR admin-event slot and countdown instead of a generic schedule.
    const data = await api('/api/status');
    // 応答が返った＝サーバーに届いている。navigator.onLine は「Wi-Fiに
    // つながっている」しか見ていないので、これが本当の可否の判断材料になる。
    noteServerReachable(true);
    // Keep every counter (menu badge + chat drawer) on the same number.
    $('#onlineCount').textContent = data.online;
    $('#chatOnline').textContent = t(`${data.online}人`, `${data.online} online`);
    $('#onlineBadge').classList.remove('hidden');
    setMood(data.mood);
    window.__bbaEvent = data.event || null;
    // 👁️ 世界の到達段。ソロの観測マスの湧く間隔がこれで縮む
    //    （modes.js の EyeWatch.every）。session に乗せるのは、モード側が
    //    main.js を import できないため（循環になる）。
    session.world = { throneMax: Number(data.throneMax) || 0 };
    // nextEvent を返さないサーバー（自動開催OFF・旧版）では undefined → null。
    window.__bbaNextEvent = data.nextEvent || null;
    updateEventBanner();
    setAdminEvent(data.adminEvent || null);
    const prevPoll = window.__bbaPoll && window.__bbaPoll.id;
    window.__bbaPoll = data.poll || null;
    if (!data.poll || prevPoll !== data.poll.id) refreshPollBanner();
    else updatePollBannerClock();
  } catch (err) {
    // status 0（そもそも届かなかった）とタイムアウトだけを「圏外」とみなす。
    // 4xx/5xx はサーバーが生きている証拠なので、オフライン扱いにしない ──
    // メンテナンス中に「通信が要ります」と出すのは嘘になる。
    noteServerReachable(!(err && (err.status === 0 || err.timeout)));
  }
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
    <h2>${icon('mode_chaos', { size: 24 })} ${t('カオスモード', 'Chaos Mode')}</h2>
    <p class="muted center" style="margin-bottom:10px">${t('一定間隔でルールが激変！コイン1.5倍！', 'The rules mutate on a timer! 1.5x coins!')}${best ? `<br>${t('自己ベスト', 'Personal best')}: <b style="color:var(--yellow)">${fmt(best)}</b>` : ''}</p>
    <div class="form-col">
      <div class="settings-row"><label>${t('プレイ時間', 'Duration')}</label><div class="seg" data-cs="duration">
        ${[60, 120, 180, 300].map(d => `<button data-v="${d}" ${duration === d ? 'class="active"' : ''}>${d / 60}${t('分', 'min')}</button>`).join('')}
        <button data-v="custom" ${!isPreset ? 'class="active"' : ''}>${t('自由', 'Custom')}</button>
      </div></div>
      <div class="settings-row ${isPreset ? 'hidden' : ''}" id="csCustomRow"><label>${t('自由設定（30秒〜30分）', 'Custom (30s〜30min)')}</label>
        <input id="csMin" type="number" min="0" max="30" value="${Math.floor(duration / 60)}" style="width:52px;text-align:center">${t('分', 'min')}
        <input id="csSec" type="number" min="0" max="59" value="${duration % 60}" style="width:52px;text-align:center">${t('秒', 'sec')}
      </div>
      <div class="settings-row"><label>${t('ルール変化の間隔', 'Mutation interval')}</label><div class="seg" data-cs="interval">
        ${[[20, t('ゆるい 20秒', 'Chill 20s')], [15, t('ふつう 15秒', 'Normal 15s')], [8, t('激辛 8秒', 'Spicy 8s')]].map(([v, l]) =>
          `<button data-v="${v}" ${interval === v ? 'class="active"' : ''}>${l}</button>`).join('')}
      </div></div>
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="csCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-chaos" id="csStart">${t('開始！', 'Start!')}</button>
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

// 🌀 カオスは常時遊べる。
//
//    12種のお題・11枚の盤面・時間と間隔の選択まで完成しているのに、
//    「カオスイベント開催中」でなければボタンごと隠れていた ── イベントは
//    運営が手で立てるものなので、実質ほとんどの日は**作り終えた1モードが
//    存在しないのと同じ**だった。
//    イベントで特別になるのは中身ではなく実入り（コイン1.5倍）のほうなので、
//    入口は開けて、イベント中だけ帯で「いまは1.5倍」と伝える形にする。
$('#btnChaos').onclick = () => {
  audio.click();
  showChaosSetup();
};

// ---- dungeon tower: pick a starting checkpoint, then climb ----
// 4つの領域の絵。第4波の統合で modes.js の DUNGEON_REALMS 側を
// icon（絵文字）→ iconName（icons.js の名前）に移したので、ここに置いていた
// 対応表は消した ── 同じ対応を2か所に持つと、領域を1つ足したときに
// 「棚には出るのに絵だけ出ない」というズレ方をする。
const realmIcon = realm => (realm && realm.iconName) || 'mode_dungeon';

function dungeonBest(realm) {
  const local = Number(localStorage.getItem(realm.bestKey) || 0);
  // 🗼 サーバーの記録も見る。**4領域とも** 記録されている
  //    （server/index.js の dungeonMax / underMax / heavenMax / abyssMax）のに、
  //    ここは長らく塔だけを見ていた。そのせいで地下・天国・深淵は端末を
  //    またげず、機種変更やブラウザの切り替えで最大60階ぶん登り直しになる。
  //    しかも深淵は「塔100F制覇」の入場判定だけ塔の記録で通るので、
  //    **入れるのに A1 からやり直し**という、いちばん腹立たしい形になっていた。
  //    領域ごとの stat 名は modes.js の DUNGEON_REALMS が statKey として
  //    持っているので、対応表をここに書き写さないこと。
  const srv = realm.statKey && session.user && session.user.stats
    ? Number(session.user.stats[realm.statKey] || 0) : 0;
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
    <h2>${icon(realmIcon(realm), { size: 24 })} ${t(realm.name, realm.nameEn)}</h2>
    <div class="seg" style="justify-content:center;margin-bottom:10px" data-dr>
      ${Object.values(DUNGEON_REALMS).map(r =>
        `<button data-r="${r.id}" ${r.id === realm.id ? 'class="active"' : ''}>${realmLocked(r) ? icon('lock', { size: 16 }) : icon(realmIcon(r), { size: 16 })}${t(r.name.replace('ダンジョン', ''), r.nameEn.split(' ')[0])}</button>`).join('')}
    </div>
    <p class="muted center" style="margin-bottom:10px">${t(realm.desc, realm.descEn)}${best ? `<br>${t('最高記録', 'Best')}: <b style="color:var(--yellow)">${P}${best}</b>${t(' クリア', ' cleared')}` : ''}${locked ? `<br><b style="color:var(--red)">${icon('lock', { size: 16 })} ${t('ダンジョン塔 F100 を制覇すると解放', 'Conquer Tower F100 to unlock')}</b>` : ''}</p>
    <div class="settings-row"><label>${t('開始階', 'Start floor')}</label><div class="seg seg-wrap" data-ds>
      ${cps.map(f => `<button data-v="${f}" ${f === startF ? 'class="active"' : ''}>${P}${f}</button>`).join('')}
    </div></div>
    ${cps.length > 1 ? `<p class="muted center" style="font-size:11px">${t('チェックポイントから始めると強化ボーナス付き', 'Starting from a checkpoint grants bonus perks')}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="dgCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-dungeon" id="dgStart">${icon(realmIcon(realm), { size: 18 })} ${t('挑戦する！', 'Enter!')}</button>
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
  if (locked) { startBtn.disabled = true; startBtn.textContent = t('未解放', 'Locked'); }
  startBtn.onclick = () => { if (locked) return; audio.click(); closeModal(); startDungeon(startF, realm.id); };
}

$('#btnDungeon').onclick = () => { audio.click(); showDungeonSelect(); };

// ---- survival ----
$('#btnSurvival').onclick = () => {
  audio.click();
  const best = Math.max(Number(localStorage.getItem('bba_survival_wave') || 0),
    session.user ? (session.user.stats.survivalWave || 0) : 0);
  const m = showModal(`
    <h2>${icon('mode_survival', { size: 24 })} ${t('サバイバル', 'Survival')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('<b>ウェーブごとにお邪魔ブロックが降ってくる</b>耐久モード。最初は15秒おき、ウェーブが進むほど<b>間隔はどんどん短く</b>（最短5秒）、降ってくる量も増えていく。<br><small>置ける場所が無くなったら終了 — ラインを消して盤面を空け、1ウェーブでも深く生き延びろ！</small>',
          '<b>Garbage blocks rain down wave after wave</b> — an endurance run. It starts every 15s, but <b>the interval keeps shrinking</b> (down to 5s) and each wave dumps more.<br><small>It ends the moment nothing fits — keep clearing lines to make room and survive one more wave!</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`最高ウェーブ W${fmt(best)}`, `Best wave W${fmt(best)}`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="svCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-oni" id="svStart">${t('生き延びる', 'Survive')}</button>
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
    <h2>${icon('mode_meltdown', { size: 24 })} ${t('メルトダウン', 'Meltdown')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('ラインを消すほど<b>炉心温度＝スコア倍率</b>が上昇（最大×15超）。ただし<b>100%で爆発</b>して即終了！<br><small>盤面に湧く冷却セルを含むラインを消すと熱-35%。臨界(90%+)で置くと倍率さらに1.5倍 — 冷やすか、稼ぐか。</small>',
          'Every clear heats the core — <b>heat is your score multiplier</b> (up to ×15+). But <b>100% = detonation</b>!<br><small>Clear a line through a coolant cell for -35% heat. Placements at 90%+ get an extra ×1.5 — cool it or push it.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="mlCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-melt" id="mlStart">${t('炉心起動', 'Ignite the core')}</button>
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
    <h2>${icon('mode_chimera', { size: 24 })} ${t('キメラ工房', 'Chimera Lab')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('手札のピースを<b>ピースにドラッグして溶接</b>！自作の巨大キメラは<b>合体数がそのままスコア倍率</b>（2体=×2、3体=×3）<br><small>ただし手札は全部置くまで補充されない — 合体するほど窒息リスクと隣り合わせ。盤面を彫って、怪物を叩き込め！</small>',
          '<b>Drag a piece onto another to weld them</b>! Your monster chimera scores <b>×its weld count</b> (2 pieces = ×2, 3 = ×3)<br><small>But your hand only refills once empty — every weld trades safety for power. Carve the board, then slam the monster in!</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="chCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-chimera" id="chStart">${t('錬成開始', 'Start welding')}</button>
    </div>`);
  m.querySelector('#chCancel').onclick = () => { audio.click(); closeModal(); };
  m.querySelector('#chStart').onclick = () => { audio.click(); closeModal(); startChimera(); };
};

// ---- puzzle ruins (ステージ制パズル) ----
$('#btnPuzzle').onclick = () => {
  audio.click();
  const cleared = puzzleBestStage();
  // ⭐ 端末のぶんとサーバーのぶんを重ねる（高いほう）。
  //    サーバーが★を預かるようになる前は端末にしか無かったので、機種変更で
  //    ☆☆☆ に戻っていた。逆に、まだ送っていない直近の★は端末にしか無い。
  //    どちらも落とさないよう Math.max で統合する。
  let stars = {};
  try { stars = JSON.parse(localStorage.getItem('bba_puzzle_stars') || '{}'); } catch { /* fresh */ }
  const remote = (session.user && session.user.stats && session.user.stats.puzzleStars) || {};
  for (const k of Object.keys(remote)) {
    stars[k] = Math.max(Number(stars[k]) || 0, Number(remote[k]) || 0);
  }
  const next = cleared + 1;
  const show = Math.max(next, 10);
  let grid = '';
  for (let s2 = 1; s2 <= show; s2++) {
    const done = s2 <= cleared;
    const isNext = s2 === next;
    const st = stars[s2] || 0;
    grid += `<button class="pz-stage ${isNext ? 'next' : done ? '' : 'locked'}" data-stage="${s2}" ${done || isNext ? '' : 'disabled'}>
      ${s2}<span class="pz-stars">${done ? '★'.repeat(st) + '☆'.repeat(Math.max(0, 3 - st)) : isNext ? 'NEW' : icon('lock', { size: 13 })}</span></button>`;
  }
  const m = showModal(`
    <h2>${icon('mode_puzzle', { size: 24 })} ${t('パズル遺跡', 'Puzzle Ruins')}</h2>
    <p class="muted center" style="margin-bottom:10px">
      ${t('古代遺跡のパズル部屋に挑戦！<b>光るブロックをすべて消せばクリア</b>。<br><small>ピースは決められた分だけ — 全ステージ必ず解けるように封印されている。速く解くほど★が増える（45秒以内で★3）。10ステージごとにジェムボーナス！</small>',
          'Take on the ancient puzzle rooms! <b>Clear every glowing block to win.</b><br><small>You get a fixed set of pieces — every room is sealed with a guaranteed solution. Solve fast for more stars (under 45s = ★3). Gem bonus every 10 stages!</small>')}
    </p>
    <div class="pz-grid">${grid}</div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="pzCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-puzzle" id="pzStart">${t(`ステージ${next}に挑む`, `Enter stage ${next}`)}</button>
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
    <h2>${icon('mode_dig', { size: 24 })} ${t('採掘場', 'The Mines')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('数手ごとに<b>地層がせり上がる</b>！岩盤ラインを消して<b>金鉱石・クリスタル・虹鉱石</b>を回収しろ。<br><small>深く潜るほど鉱石は高価に、岩は分厚くなる。ブロックが天井に触れたら圧死 — ライン消しで上昇を遅らせろ！</small>',
          'Every few moves <b>the ground rises</b>! Clear through the rock to mine <b>gold, crystal and rainbow ore</b>.<br><small>Deeper = richer veins but thicker rock. Touch the ceiling and you get crushed — line clears slow the rise!</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`最高深度 ${best}m`, `Best depth ${best}m`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="dgCancel2">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-dig" id="dgStart2">${t('採掘開始', 'Start digging')}</button>
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
    <h2>${icon('mode_chain', { size: 24 })} ${t('連鎖カスケード', 'Chain Cascade')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('ラインを消すと<b>上のブロックが下に落ちてくる</b>！落ちた先でまたラインが揃えば<b>連鎖</b>し、連鎖が続くほど<b>スコア倍率が跳ね上がる</b>。<br><small>盤面を崩さず「あと1マス」を残して積み、一撃で雪崩を起こせ — 置ける場所が無くなったら終了。</small>',
          'Clearing a line makes <b>everything above it fall</b> — and if the landing forms another line, it <b>chains</b>. The longer the chain, <b>the bigger the score multiplier</b>.<br><small>Stack with one gap left, then trigger the avalanche in a single move. It ends when nothing fits.</small>')}
    </p>
    ${best ? `<p class="center" style="font-size:13px;font-weight:800">${t(`自己ベスト ${fmt(best)}点`, `Best ${fmt(best)} pts`)}${maxChain ? t(` / 最大${maxChain}連鎖`, ` / longest ${maxChain}-chain`) : ''}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="cnCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-coop" id="cnStart">${t('連鎖を起こす', 'Start the cascade')}</button>
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
    <h2>${icon('mode_blueprint', { size: 24 })} ${t('ブループリント', 'Blueprint')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('<b>日替わりの設計図どおりに</b>ピースを組み上げる、全員同じお題のパズル。<br><small>配られるピースは設計図をちょうど作れるぶんだけ。<b>ラインを揃えてしまうと作品が消えてしまう</b>ので、いつもと逆の頭で置き場所を考えろ！</small>',
          'Build <b>today\'s blueprint</b> exactly as drawn — the same puzzle for everyone, every day.<br><small>You get precisely the pieces the drawing needs. <b>Complete a line and your artwork vanishes</b> — so think the opposite way round!</small>')}
    </p>
    ${clears ? `<p class="center" style="font-size:13px;font-weight:800">${t(`これまでに ${fmt(clears)}枚 完成`, `${fmt(clears)} blueprints completed`)}</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="bpCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-gold" id="bpStart">${t('今日の設計図に挑む', "Build today's blueprint")}</button>
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
    <h2>${icon('mode_workshop', { size: 24 })} ${t('パズル工房', 'Puzzle Workshop')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('みんなが作ったパズルで遊べる工房。<b>6文字の共有コード</b>で友達の作品にも飛べる。<br><small>自分で盤面を描いて投稿もできる — 自分でクリアできた図だけが公開されるので、解けない問題は出てこない。遊ばれるほど作者にコインが入る！</small>',
          'A workshop full of player-made puzzles — jump straight to a friend\'s stage with its <b>6-letter share code</b>.<br><small>You can build and publish your own, too: only stages you have solved yourself go live, so nothing is unsolvable. Authors earn coins every time their stage is played!</small>')}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wsCancel2">${t('やめる', 'Cancel')}</button>
      ${canEdit ? `<button class="btn btn-ghost" id="wsMake2">${t('作る', 'Create')}</button>` : ''}
      <button class="btn btn-puzzle" id="wsOpen2">${t('ステージを探す', 'Browse stages')}</button>
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
  const chain = ensureModeButton('btnChain', 'btn-chain', t('連鎖カスケード', 'Chain Cascade'), 'btnChimera');
  if (chain) chain.onclick = () => { audio.click(); showChainSetup(); };
  const blueprint = ensureModeButton('btnBlueprint', 'btn-blueprint', t('ブループリント', 'Blueprint'), 'btnDaily');
  if (blueprint) blueprint.onclick = () => { audio.click(); showBlueprintSetup(); };
  // screens.js が先に onclick を入れているので、ここで上書きして開始モーダルを挟む。
  const workshop = ensureModeButton('btnWorkshop', 'btn-workshop', t('パズル工房', 'Puzzle Workshop'), 'btnPuzzle');
  if (workshop) workshop.onclick = () => { audio.click(); showWorkshopSetup(); };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureNewModeButtons, { once: true });
else ensureNewModeButtons();

// ---------------------------------------------------------------------------
// 🎨 index.html の絵文字を、自前のアイコン（icons.js）へ差し替える
//
// なぜ JS から流し込むのか
//   index.html は静的で、しかも**日本語の文言が正**（英語面は i18n.js の
//   applyStaticI18n() が textContent ごと書き換える）。HTML に <svg> を直接
//   書くと、英語で遊んでいる人の画面ではその瞬間にアイコンが消える。
//   同じ理由で、ここは applyStaticI18n() と ensureNewModeButtons()（どちらも
//   textContent を上書きする）より**あと**でなければならない。
//
// なぜ絵文字をやめるのか
//   絵文字は端末とOSで絵が変わるうえ、同じ絵が別の意味で使い回される
//   （🏰 が「ダンジョン」と「ギルド」の両方、🛡️ が「管理」と管理者アバターの
//   両方に付いていた）。icons.js の絵は id が違えば必ず形も違う。
//
// 触らないもの
//   ・#userAvatar … updateTopbar()（dom.js）が権限によって絵を差し替える。
//     あちらも icons.js を使うようになった（user_guest / user / mod / admin）。
//     ここで塗ると次のログインで必ず消えるので、二重管理にしないこと。
//   ・試合中の HUD（#btnReroll / #btnUlt / #btnAuto など） … 中に <b> の
//     カウンタを抱えていて game.js / modes.js が書き換えるので、別途で。
// ---------------------------------------------------------------------------

// 先頭の絵文字（＋異体字セレクタ・ZWJ・続く空白）だけを落とす。
// 日本語もラテン文字も Extended_Pictographic ではないので、ラベルは削れない。
const LEAD_EMOJI = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+/u;

// モード一覧のボタン（.menu-buttons の中）。左に絵、右にラベル。
const MODE_BTN_ICONS = {
  btnSolo: 'mode_solo', btnVsAi: 'mode_ai', btnBoss: 'mode_boss',
  btnDungeon: 'mode_dungeon', btnSprint: 'mode_sprint', btnWeekly: 'mode_weekly',
  btnDaily: 'mode_daily', btnSurvival: 'mode_survival', btnMeltdown: 'mode_meltdown',
  btnChimera: 'mode_chimera', btnChain: 'mode_chain', btnBlueprint: 'mode_blueprint',
  btnPuzzle: 'mode_puzzle', btnWorkshop: 'mode_workshop', btnDig: 'mode_dig',
  btnGhost: 'mode_ghost', btnChaos: 'mode_chaos', btnOnline: 'mode_online',
};

// ナビ（.menu-nav）。絵は <span> の中に入っている ── .nav-btn span が
// font-size:22px を持っているので、その器を残したまま中身だけ入れ替える。
// #btnHallOfFame は screens.js が足すことがあるので、「在れば塗る」だけに
// してある（無くても何も起きない）。
// 📖 #btnRules はここに入れない ── 専用の絵がまだ無く、いちばん近い missions は
// 📋ミッションの絵そのものなので、並べると2つのナビが同じ絵になる。
// icons.js に 'rules' が入った日に下の paintStaticIcons() が自動で塗り始める。
const NAV_BTN_ICONS = {
  btnMissions: 'missions', btnFriends: 'friends',
  btnGuild: 'guild', btnNews: 'news', btnLeaderboard: 'leaderboard',
  btnHallOfFame: 'hall', btnInventory: 'inventory', btnShop: 'shop',
  btnGacha: 'gacha', btnGemShop: 'gemshop', btnBattlePass: 'battlepass',
  btnAdmin: 'admin',
};

// 試合中の HUD。絵文字を index.html から抜いたので、ここで絵を入れる。
// #btnReroll / #btnAuto は中に <b>（残り回数・ON/OFF）を抱えていて、
// modes.js が textContent を書き換える ── だから中身は消さず、
// **先頭にアイコンを差し込むだけ**にする。名前は title / aria-label が持つ。
const HUD_BTN_ICONS = {
  btnQuit: 'quit', btnReroll: 'reroll', btnAuto: 'autopilot',
  btnAdminCmd: 'admincmd', btnEmote: 'emote', btnClip: 'clip',
};

// 画面の見出し（.sub-header h2）。i18n.js の applyStaticI18n() が
// textContent ごと書き換えるので、**そのあと**に塗ること。
const HEADER_ICONS = [
  ['#screen-room .sub-header h2', 'mode_room'],
  ['#screen-leaderboard .sub-header h2', 'leaderboard'],
  ['#screen-inventory .sub-header h2', 'inventory'],
  ['#screen-shop .sub-header h2', 'shop'],
  ['#screen-missions .sub-header h2', 'missions'],
  ['#screen-battlepass .sub-header h2', 'battlepass'],
  ['#screen-friends .sub-header h2', 'friends'],
  ['#screen-guild .sub-header h2', 'guild'],
  ['#screen-news .sub-header h2', 'news'],
  ['#screen-admin .sub-header h2', 'admin'],
];

function paintModeIcon(id, name) {
  const el = $('#' + id);
  if (!el || el.querySelector('svg')) return;        // 二度塗りしない
  const label = (el.textContent || '').replace(LEAD_EMOJI, '').trim();
  el.replaceChildren(iconEl(name, { size: 20 }), document.createTextNode(' ' + label));
}

function paintNavIcon(id, name) {
  const el = $('#' + id);
  if (!el) return;
  const span = el.querySelector('span');             // 絵の器。ラベルとドットは触らない
  if (!span || span.querySelector('svg')) return;
  span.replaceChildren(iconEl(name, { size: 22 }));
}

// 🪙/💎 のチップ。数字の <b> は updateTopbar() が書き換えるので、
// 絵は <b> の**手前へ差し込む**だけにする（index.html から絵文字を抜いたので、
// 以前のように「先頭の文字ノードを置き換える」形はもう使えない）。
// 絵を消すと読み上げに「0」しか残らないので、こちらは label 付きで出す。
function paintChipIcon(sel, name, label) {
  const el = document.querySelector(sel);
  if (!el || el.querySelector('svg')) return;
  const wrap = document.createElement('span');
  wrap.innerHTML = icon(name, { size: 15, label });
  const svg = wrap.firstElementChild;
  if (!svg) return;
  el.prepend(svg, document.createTextNode(' '));
}

// HUD のボタン。中身（<b>のカウンタ）は残したまま、先頭にだけ絵を足す。
function paintHudIcon(id, name) {
  const el = $('#' + id);
  if (!el || el.querySelector('svg')) return;
  el.prepend(iconEl(name, { size: 18 }));
}

// 見出し。文字は applyStaticI18n() が入れた「正」の言葉をそのまま使い、
// 先頭にだけ絵を足す（言葉を作り直すと英語面が日本語に戻る）。
function paintHeaderIcon(sel, name) {
  const el = document.querySelector(sel);
  if (!el || el.querySelector('svg')) return;
  const label = (el.textContent || '').replace(LEAD_EMOJI, '').trim();
  el.replaceChildren(iconEl(name, { size: 22 }), document.createTextNode(' ' + label));
}

function paintStaticIcons() {
  try {
    for (const [id, name] of Object.entries(MODE_BTN_ICONS)) paintModeIcon(id, name);
    for (const [id, name] of Object.entries(NAV_BTN_ICONS)) paintNavIcon(id, name);
    if (RULES_ICON) paintNavIcon('btnRules', RULES_ICON);   // 絵が入ったら自動で移る
    for (const [id, name] of Object.entries(HUD_BTN_ICONS)) paintHudIcon(id, name);
    for (const [sel, name] of HEADER_ICONS) paintHeaderIcon(sel, name);
    paintChipIcon('.coin-chip', 'coins', t('コイン', 'Coins'));
    paintChipIcon('.gem-chip', 'gems', t('ジェム', 'Gems'));
    // ⚙️ 設定。名前は index.html / i18n.js の title・aria-label が持っている。
    const settings = $('#btnSettings');
    if (settings && !settings.querySelector('svg')) settings.replaceChildren(iconEl('settings', { size: 18 }));
    // 💬 全体チャット。見出しは中に #chatOnline を抱えているので先頭に足すだけ、
    // 開閉ボタンは #chatUnread（未読バッジ）を抱えているので同じく先頭に足すだけ。
    const chatHead = document.querySelector('.chat-head');
    if (chatHead && !chatHead.querySelector('svg')) chatHead.prepend(iconEl('chat', { size: 16 }), document.createTextNode(' '));
    const chatToggle = $('#chatToggle');
    if (chatToggle && !chatToggle.querySelector('svg')) chatToggle.prepend(iconEl('chat', { size: 22 }));
  } catch {
    // 絵が塗れなくても遊べる（言葉だけが残る）。メニューの配線は道連れにしない。
  }
}
// ⚠️ ensureNewModeButtons のあとに登録すること。あちらは btnChain / btnBlueprint /
//    btnWorkshop の textContent を書き換えるので、先に塗ると消える。
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintStaticIcons, { once: true });
else paintStaticIcons();

// ---- time attack ----
$('#btnSprint').onclick = () => {
  audio.click();
  const m = showModal(`
    <h2>${icon('mode_sprint', { size: 24 })} ${t('タイムアタック', 'Time Attack')}</h2>
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
      <button class="btn btn-ghost" id="spRank">${t('順位を見る', 'Standings')}</button>
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
    <h2>${icon('mode_weekly', { size: 24 })} ${t('ウィークリーチャレンジ', 'Weekly Challenge')}</h2>
    <p class="muted center" style="margin-bottom:10px">
      ${t(`全プレイヤー共通のピース順で<b>${info.pieces}個</b>限定スコアアタック！`, `Score attack with <b>${info.pieces}</b> pieces — same order for every player!`)}<br>
      ${t('リセットまで残り', 'Resets in')} <b>${fmtWeeklyRemain(info.endsAt - Date.now())}</b>
      ${best ? `<br>${t('今週のベスト', "This week's best")}: <b style="color:var(--yellow)">${fmt(best)}</b>` : ''}
      ${session.user ? '' : `<br><small>${t('ランキングに載るにはログイン', 'Log in to appear on the ranking')}</small>`}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wkCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-ghost" id="wkRank">${t('順位を見る', 'Standings')}</button>
      <button class="btn btn-weekly" id="wkStart">${t('挑戦する！', 'Play!')}</button>
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
    <h2>${icon('mode_daily', { size: 24 })} ${t('デイリーチャレンジ', 'Daily Challenge')}</h2>
    <p class="center" style="margin:2px 0 6px;font-size:15px"><b>${mod.iconName ? icon(mod.iconName, { size: 18 }) : ''} ${t(mod.ja || '', mod.en || '')}</b><br><small class="muted">${t(mod.descJa || '', mod.descEn || '')}</small></p>
    <p class="muted center" style="margin-bottom:10px">
      ${t(`全プレイヤー共通のピース順で<b>${info.pieces}個</b>の一発勝負！目標 <b>${fmt(info.target)}</b>点でクリア`, `One shot with <b>${info.pieces}</b> pieces — same order for everyone! Score <b>${fmt(info.target)}</b> to clear`)}<br>
      ${played
        ? `${t('今日は挑戦済み', 'Today\'s attempt is done')}${todayScore != null ? ` — <b style="color:var(--yellow)">${fmt(todayScore)}</b>` : ''}${t('（ここからは練習）', ' (practice from here)')}`
        : `<b style="color:var(--yellow)">${t('記録に残るのは最初の1回だけ！', 'Only your FIRST run counts!')}</b>${session.user ? `<br><small>${t('※ 始めた時点で今日の1回を使います（途中でやめても記録は確定）', '* Starting uses today\'s attempt — quitting midway still locks it in')}</small>` : ''}`}
      <br>${t('次のお題まで', 'Next challenge in')} <b>${fmtWeeklyRemain(info.endsAt - Date.now())}</b>
      ${info.streak ? `<br>${t(`連続クリア${info.streak}日`, `${info.streak}-day clear streak`)}${
        info.inProgress ? `<small class="muted"> ${t('（挑戦中）', '(in progress)')}</small>` : ''}` : ''}
      ${session.user ? '' : `<br><small>${t('記録とランキングにはログイン', 'Log in for records & the ranking')}</small>`}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="dcCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-ghost" id="dcRank">${t('順位を見る', 'Standings')}</button>
      <button class="btn btn-daily" id="dcStart">${played ? t('練習する', 'Practice') : t('挑戦する！', 'Play!')}</button>
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
    toast(t('購入ありがとうございます！ジェムを付与しました', 'Thank you for your purchase! Gems added'), 'ok', 4000);
  }, 1500);
} else if (location.search.includes('purchase=cancel')) {
  history.replaceState(null, '', '/');
  toast(t('購入をキャンセルしました', 'Purchase canceled'), '', 2500);
}

// ---------------------------------------------------------------------------
// 📴 オフラインでも遊べるようにする
//
// このゲームの中身（engine.js / game.js / ai.js）は全部ブラウザ側にあるので、
// 1人用モードは本来サーバーが要らない。要るのは2つだけ:
//   1. 起動一式が端末に控えてあること           → public/sw.js（第5波で作り直した）
//   2. サーバーへの問い合わせが落ちても止まらないこと → ここ
//
// メニューの配線はモジュール本体の同期実行で全部済んでいて、サーバーを見る
// 呼び出し（pollStatus / refreshMe / /api/news）はすべて catch 付きの非同期。
// つまり**メニューは元から出る**。足りなかったのは「押す前に分かること」で、
// これまでは圏外でもボタンが普段どおり光っていて、押してはじめて
// 「サーバーに接続できません」と言われていた。
//
// ■ オフライン中の記録をどうするか（第6波で判断が変わった）
//   以前は「自動再送も『つながったら送る』ボタンも入れない。端末にだけ残す」
//   だった。理由は POST /api/game/result に冪等キーが無く、同じ回を2回受けると
//   2回ぶん加算したから。**その前提はもう無い** ── サーバーは runId で
//   同じ回を1回しか数えず、modes.js の submitResult は毎回 runId を載せる。
//   いまは net.js が圏外の結果を控えて、つながったら古い順に送り直す
//   （控えるのは runId を持つ結果だけ・最大20件・寿命12時間）。
//   だから画面で伝えることも変わる: 「端末に残るだけ」ではなく
//   **「つながったら自動で送ります」**。送り終えると net.js が
//   window に 'bba:results-sent'（detail.count）を投げるので、
//   下でそれを拾って知らせと残高の更新を出している。
//   ※ 控えを持つのは net.js の1箇所だけ。sw.js に Background Sync を
//     足さない判断は据え置き（理由は public/sw.js の頭に書いてある）。
// ---------------------------------------------------------------------------

// サーバーに実際に届いたかどうか。null = まだ分からない。
// navigator.onLine は「Wi-Fiにつながっているか」しか見ないので、サーバーが
// 落ちている・寝ている（無料枠のコールドスタート）ときは嘘をつく。
let serverReachable = null;

/** いま「通信が要る操作ができない」状態か。 */
function netDown() {
  return navigator.onLine === false || serverReachable === false;
}

// 最後に知らせた状態。null = まだ一度も知らせていない。
// 「変わったときだけ知らせる」ためだけに持つ ── 30秒ごとの pollStatus で
// 毎回トーストが出てはたまらないし、起動した瞬間の1回目は変化ではない。
let lastAnnouncedDown = null;

/** いまの状態を画面に反映する。状態が反転したときだけ知らせる。 */
function syncOffline() {
  const off = netDown();
  const announce = lastAnnouncedDown !== null && lastAnnouncedDown !== off;
  lastAnnouncedDown = off;
  updateOfflineTag(announce);
}

// pollStatus() から呼ばれる。※この関数は宣言なので巻き上げられており、
// 先に書いてある pollStatus() から呼んでも問題ない（await のあとに実行される
// ＝モジュール本体の評価が終わってからしか動かない）。
function noteServerReachable(ok) {
  const next = !!ok;
  if (serverReachable === next) return;
  serverReachable = next;
  syncOffline();
}

// ---- 通信が要る入口 -------------------------------------------------------
//
// 分類はソースを追って決めたもので、勘ではない:
//   ・btnBoss      … このファイルの openBossSelect() が /api/bosses を読む
//   ・btnWeekly    … /api/weekly     ・btnDaily … /api/daily
//   ・btnBlueprint … modes.js が /api/daily/blueprint を読む
//   ・btnWorkshop  … /api/workshop/*  ・btnOnline … WebSocket
//   ・ナビは「遊び方」以外すべて screens.js が /api/* を読む
// 逆に、ソロ・AI対戦・ダンジョン・タイムアタック・サバイバル・メルトダウン・
// キメラ工房・連鎖カスケード・パズル遺跡・採掘場・幽霊屋敷は
// api() を1回も呼ばない＝オフラインで最後まで遊べる。
const NET_MODE_BTNS = ['btnBoss', 'btnWeekly', 'btnDaily', 'btnBlueprint', 'btnWorkshop', 'btnOnline'];
const NET_NAV_BTNS = ['btnMissions', 'btnFriends', 'btnGuild', 'btnNews', 'btnLeaderboard',
  'btnInventory', 'btnShop', 'btnGacha', 'btnGemShop', 'btnBattlePass', 'btnAdmin', 'btnHallOfFame'];

// 印の付け外し。style.css は担当外なので、見た目は inline style で作る。
function markNetButton(btn, off, withBadge) {
  if (!btn) return;
  btn.dataset.netRequired = '1';
  const had = btn.querySelector('.net-req-badge');
  if (off) {
    btn.style.opacity = '.42';
    btn.style.filter = 'grayscale(.75)';
    btn.setAttribute('aria-disabled', 'true');
    if (withBadge && !had) {
      const i = document.createElement('i');
      i.className = 'net-req-badge';
      i.style.cssText = 'display:block;margin-top:3px;font-size:11px;font-style:normal;'
        + 'font-weight:800;opacity:.95;letter-spacing:.02em';
      i.textContent = t('通信が必要', 'Needs a connection');
      btn.appendChild(i);
    }
  } else {
    btn.style.opacity = '';
    btn.style.filter = '';
    btn.removeAttribute('aria-disabled');
    if (had) had.remove();
  }
}

// メニュー上部の説明。器は index.html に無いのでここで作る（担当外のため）。
// 出すものが無い間は DOM も作らない。
function offlineNoticeEl(create) {
  let el = document.getElementById('offlineNotice');
  if (el || !create) return el;
  const host = $('#eventBanner');
  if (!host || !host.parentNode) return null;
  el = document.createElement('div');
  el.id = 'offlineNotice';
  el.className = 'event-banner';                 // 既存のクラスを借りる
  el.setAttribute('role', 'status');
  // 開催中イベントの赤紫とは別物だと分かるように、色だけ上書きする。
  el.style.cssText = 'animation:none;background:rgba(255,93,93,0.14);'
    + 'border-color:var(--red);font-weight:700;font-size:12.5px;line-height:1.6;'
    + 'text-align:left;margin-bottom:8px';
  host.insertAdjacentElement('beforebegin', el);  // ロゴのすぐ下＝最初に目に入る
  return el;
}

function updateOfflineNotice(off) {
  const el = offlineNoticeEl(off);
  if (!el) return;
  if (!off) { el.classList.add('hidden'); return; }
  el.replaceChildren();
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:7px;font-weight:900;font-size:13px';
  head.append(iconEl('offline', { size: 16 }),
    document.createTextNode(t('オフラインです — 通信の要らないモードだけ遊べます',
      'You are offline — only the modes that need no connection can be played')));
  const body = document.createElement('div');
  body.style.cssText = 'margin-top:4px;opacity:.9';
  // ⚠️ ここは「記録がどうなるか」を先に言う場所。あとから
  //    「送信できませんでした」と言われるより、先に知っているほうがよい。
  // 📮 未送信の件数が分かるなら添える（net.js の控え）。数が出ると
  //    「本当に預かってもらえている」ことが確かめられる。
  const waiting = queuedResultCount();
  body.textContent = t(
    `うすくなっているボタンは通信が戻ると使えます。いま遊んだぶんの記録は端末に預かって、つながったら自動で送ります${waiting ? `（未送信 ${waiting} 件）` : ''}。`,
    `The dimmed buttons come back with your connection. Runs you play now are saved on your device and sent automatically once you are back online${waiting ? ` (${waiting} waiting)` : ''}.`);
  el.append(head, body);
  el.classList.remove('hidden');
}

/** トップバーの印・メニューの説明・ボタンの印を、まとめて今の状態に合わせる。 */
function updateOfflineTag(announce) {
  const off = netDown();
  const tag = $('#offlineTag');
  if (tag) {
    // 絵文字ではなく icons.js のアイコン。読み上げには名前が要るので、
    // 絵は aria-hidden のまま「オフライン」の文字だけを残す。
    tag.replaceChildren(iconEl('offline', { size: 14 }),
      document.createTextNode(' ' + t('オフライン', 'Offline')));
    tag.classList.toggle('hidden', !off);
  }
  try {
    for (const id of NET_MODE_BTNS) markNetButton($('#' + id), off, true);
    for (const id of NET_NAV_BTNS) markNetButton($('#' + id), off, false);
    // 💬 全体チャットは常時WSなので、圏外では開いても何も来ない。
    markNetButton($('#chatToggle'), off, false);
    updateOfflineNotice(off);
  } catch { /* 印が付けられなくても、遊べること自体は変わらない */ }
  if (!announce) return;
  if (off) {
    // 「端末が圏外」と「端末はつながっているがサーバーに届かない」は、
    // プレイヤーにとって直せる相手がまるで違う（機内モードを切ればいいのか、
    // 待つしかないのか）。同じ文言で済ませない。
    const head = navigator.onLine === false
      ? t('通信が切れました。', 'You are offline. ')
      : t('サーバーに接続できません。', "Can't reach the server. ");
    toast(head + t('ソロプレイなどはこのまま遊べます（記録は預かって、つながったら送ります）',
      'Solo modes still work — results are saved and sent when you are back'), 'err', 5000);
  } else {
    toast(t('通信が戻りました', 'Back online'), 'ok', 2200);
  }
}

// 📮 圏外で遊んだぶんを net.js が送り終えたときの知らせ。
//    net.js は表示を持たない（1箇所で控えを持つだけ）ので、
//    トーストと残高の更新はここで受けて出す。
window.addEventListener('bba:results-sent', ev => {
  const n = Math.max(0, Number(ev && ev.detail && ev.detail.count) || 0);
  if (!n) return;
  toast(t(`オフラインで遊んだ${n}件ぶんの報酬が入りました`,
    `Rewards for ${n} offline run${n === 1 ? '' : 's'} have arrived`), 'ok', 4000);
  // 送ったぶんコインとジェムが増えているので、トップバーを引き直す。
  refreshMe().then(() => updateTopbar()).catch(() => { /* 次の更新で合う */ });
  updateOfflineNotice(netDown());
});

// 📮 控えを送れずに捨てたとき。
//
// 結果画面は「つながったときに送られ、そのとき記録されます」と約束している。
// ところが寿命切れ・401・400 で捨てた控えは**黙って件数が減るだけ**で、
// 報酬も記録も付かない理由がどこにも出なかった（デイリーはサーバーの予約が
// 2時間で切れるので、いちばん踏みやすい）。必ず言う。
window.addEventListener('bba:results-dropped', ev => {
  const d = (ev && ev.detail) || {};
  const n = Math.max(0, Number(d.count) || 0);
  if (!n) return;
  const why = {
    auth: t('（ログインが切れていました）', ' (you were signed out)'),
    expired: t('（時間切れです。デイリーは2時間以内に送る必要があります）',
      ' (too old — the Daily must be submitted within 2 hours)'),
    stale: t('（日付が変わっていました）', ' (the day had rolled over)'),
    unreserved: t('（挑戦の登録がありませんでした）', ' (the run was never registered)'),
  }[d.reason] || t('（サーバーに受け付けてもらえませんでした）', ' (the server rejected it)');
  toast(t(`${n}件はデイリーとして記録できませんでした`,
    `${n} run${n === 1 ? '' : 's'} could not be recorded as a Daily`) + why, 'err', 6000);
  updateOfflineNotice(netDown());
});

// 押す前に分かるようにしたうえで、それでも押されたときの受け皿。
// capture で捕まえるので、ボタン自身の onclick までは届かない
// （＝「押す → 通信して失敗 → エラー」という遠回りをしない）。
document.addEventListener('click', ev => {
  if (!netDown()) return;
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-net-required="1"]') : null;
  if (!btn) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  audio.click();
  toast(t('これは通信が必要です。つながると使えるようになります',
    'This one needs a connection — it comes back when you are online'), 'err', 3000);
}, true);

window.addEventListener('offline', () => { serverReachable = false; syncOffline(); });
window.addEventListener('online', () => {
  // 端末が「つながった」と言っても、サーバーに届くとは限らない
  // （自分だけWi-Fiに戻った・サーバーが寝ている）。楽観的に戻したうえで、
  // すぐ問い合わせて確定させる。届かなければ数百ms後にまた暗くなる。
  serverReachable = null;
  syncOffline();
  pollStatus();
});
syncOffline();

// ---- Service Worker ----
// ホーム画面から起動するインストール型（manifest は display:standalone）なので、
// 圏外で開くと「接続できません」というブラウザの既定画面がアプリの中に出ていた。
// sw.js は常にネットワークを先に見て、失敗したときだけ控えを出す ──
// つまり更新の届き方は今までと変わらない。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // 起動直後の通信と取り合わないよう、読み込みが済んでから登録する。
  const registerSw = () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(reg => {
        // 🔧 いちばん確実な補修点。
        //   SW は load で登録されるので、**初回訪問のモジュール取得は1本も
        //   SW を通らない**。しかも install の事前キャッシュが電波の悪い瞬間に
        //   当たると、install は二度と走らないので永久に控えを持たない
        //   （実測で、初回訪問だけの人の控えは4件しか無かった）。
        //   ここまで来た＝このページは現に起動できている＝一式は取得できる、
        //   と分かっているので、SW に「いまのうちに控えておいて」と頼む。
        //   sw.js 側は既にそろっていれば何もしない。
        const sw = reg.active || navigator.serviceWorker.controller;
        if (sw) sw.postMessage({ type: 'bba-warm' });
      })
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
      toast(t(`おかえりなさい、${session.user.username}さん！データが復元されました`,
        `Welcome back, ${session.user.username}! Your data has been restored`), 'ok', 5000);
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
    <h2>${icon('warn', { size: 24 })} ${t('データを復元できませんでした', 'Your data could not be restored')}</h2>
    <p class="muted center" style="margin-bottom:12px">
      ${t('サーバーの復元は完了しましたが、このアカウントは直前のバックアップに含まれていませんでした。<br>本当にごめんなさい…！お手数ですが、新しくアカウントを作成してください。<b>同じ名前をもう一度使えます。</b>',
          'The server restore finished, but this account was not in the latest backup.<br>We are really sorry! Please create a new account — <b>you can use the same name again.</b>')}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-primary" id="rfRestart">${t('新しく始める', 'Start fresh')}</button>
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
          // トーストは textContent なので SVG を混ぜられない。通貨は絵文字ではなく
          // 「コイン／ジェム」と言葉で書く（読み上げにも通貨名がそのまま残る）。
          toast(t(`ログインボーナス コイン+${data.dailyBonus.coins} ジェム+${data.dailyBonus.gems}${st > 1 ? `（${st}日連続！）` : ''}${tb ? `（王座の俸給 コイン+${tb.coins} ジェム+${tb.gems}込み）` : ''}`,
            `Daily bonus +${data.dailyBonus.coins} coins +${data.dailyBonus.gems} gems${st > 1 ? ` (${st}-day streak!)` : ''}${tb ? ` (incl. throne stipend +${tb.coins} coins +${tb.gems} gems)` : ''}`), 'ok', tb ? 4500 : 3500);
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
          toast(t('サーバーのアカウントデータが復元待ちです。復元が終わると自動でログインに戻ります',
            'Your account data is waiting to be restored on the server — you will be logged back in automatically'), 'err', 7000);
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
        if (attempt === 0) toast(t('サーバーを起こしています…そのままお待ちください', 'Waking up the server… please hang on'), '', 8000);
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
    banner.textContent = t(`${session.season.name} 開催中 — 残り${days}日`,
      `${session.season.nameEn || session.season.name} — ${days} days left`);
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
