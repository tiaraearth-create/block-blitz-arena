// Sub-screens: auth modal, leaderboard, shop, battle pass, admin panel.
import { session, api, setToken, refreshMe } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, fmt, updateTopbar, confettiBurst, rankOf, staffUiOn, setStaffUi, staffExtras } from './dom.js';
import { getSkin, BOARDS } from './themes.js';
import { audio, TRACK_INFO } from './audio.js';
import { getSettings, updateSettings } from './settings.js';
import { reconnectChat, markNewsSeen } from './chat.js';
import { t as tr, setLang, LANG, catName, catDesc } from './i18n.js';
import { equippedUlt, setGuestUlt, ghostUnlocked } from './modes.js';
import { ultIcon, ultColor } from './skills.js';
import { showYouTubeStudio } from './ytexport.js';

// ---------------------------------------------------------------------------
// Auth modal
// ---------------------------------------------------------------------------

export function showAuthModal() {
  if (session.user) return showProfileModal();
  const m = showModal(`
    <h2>${tr('アカウント', 'Account')}</h2>
    <div class="tabs" style="justify-content:center">
      <button class="tab active" data-auth="login">${tr('ログイン', 'Log in')}</button>
      <button class="tab" data-auth="register">${tr('新規登録', 'Sign up')}</button>
    </div>
    <div class="form-col">
      <input id="authUser" type="text" placeholder="${tr('ユーザー名', 'Username')}" maxlength="16" autocomplete="username">
      <input id="authPass" type="password" placeholder="${tr('パスワード（6文字以上）', 'Password (6+ characters)')}" autocomplete="current-password">
      <div class="form-error" id="authError"></div>
      <button class="btn btn-primary" id="authSubmit">${tr('ログイン', 'Log in')}</button>
      <p class="muted center" style="font-size:12px">${tr('登録するとランキング・報酬・オンラインレートが有効になります', 'Sign up to unlock rankings, rewards and online rating')}</p>
    </div>`);

  let mode = 'login';
  m.querySelectorAll('[data-auth]').forEach(tab => {
    tab.onclick = () => {
      m.querySelectorAll('[data-auth]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.auth;
      m.querySelector('#authSubmit').textContent = mode === 'login' ? tr('ログイン', 'Log in') : tr('登録する', 'Sign up');
    };
  });

  const submit = async () => {
    const username = m.querySelector('#authUser').value.trim();
    const password = m.querySelector('#authPass').value;
    const errEl = m.querySelector('#authError');
    errEl.textContent = '';
    try {
      const data = await api(`/api/${mode}`, { method: 'POST', body: { username, password } });
      setToken(data.token);
      session.user = data.user;
      updateTopbar();
      closeModal();
      audio.coin();
      reconnectChat();
      refreshMissionDot();
      refreshPollBanner();
      toast(mode === 'login' ? tr(`おかえりなさい、${data.user.username}さん！`, `Welcome back, ${data.user.username}!`) : tr(`ようこそ、${data.user.username}さん！`, `Welcome, ${data.user.username}!`), 'ok');
      if (data.dailyBonus) {
        const st = data.dailyBonus.streak || 1;
        setTimeout(() => toast(tr(`🎁 ログインボーナス +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎${st > 1 ? `（🔥${st}日連続！）` : ''}`,
          `🎁 Daily bonus +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎${st > 1 ? ` (🔥${st}-day streak!)` : ''}`), 'ok', 3500), 900);
      }
      if (data.user.rankRewards && data.user.rankRewards.length) {
        setTimeout(() => showRankRewardsModal(), 1400);
      }
    } catch (err) {
      errEl.textContent = err.message;
      audio.error();
    }
  };
  m.querySelector('#authSubmit').onclick = submit;
  m.querySelector('#authPass').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function showProfileModal() {
  const u = session.user;
  const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈', souzou: '🌌', rush: '⚔️', dungeon: '🏰', tourney: '🏆', royale: '💯', adminevent: '👑', abyss: '🌑', weekly1: '🏅', puzzle: '🧩', dig: '⛏️', crown2: '👑', crown3: '👑', crown5: '👑', crown7: '🌈', ghost: '👻' };
  const m = showModal(`
    <h2>${u.role === 'admin' ? '🛡️' : u.role === 'mod' ? '🔧' : '😀'} ${u.guild ? `<span class="lb-tag">[${escapeHtml(u.guild.tag)}]</span>` : ''}${u.username}</h2>
    ${u.equippedTitle ? `<p class="center" style="margin:-8px 0 10px;font-weight:800;font-size:14px">《 ${escapeHtml(titleName(u.equippedTitle))} 》</p>` : ''}
    <div class="result-stats">
      <div class="rs-row"><span>${tr('レベル', 'Level')}</span><b>Lv.${u.level}</b></div>
      <div class="rs-row"><span>${tr('ハイスコア', 'High score')}</span><b>${fmt(u.stats.bestScore)}</b></div>
      <div class="rs-row"><span>${tr('レート', 'Rating')}</span><b>${fmt(u.stats.rating)} <span style="color:${rankOf(u.stats.rating).color}">${rankOf(u.stats.rating).icon}${tr(rankOf(u.stats.rating).name, rankOf(u.stats.rating).nameEn)}</span></b></div>
      <div class="rs-row"><span>${tr('オンライン戦績', 'Online record')}</span><b>${tr(`${u.stats.pvpWins}勝 ${u.stats.pvpLosses}敗`, `${u.stats.pvpWins}W ${u.stats.pvpLosses}L`)}</b></div>
      <div class="rs-row"><span>${tr('AI撃破', 'AI wins')}</span><b>${fmt(u.stats.aiWins)}</b></div>
      <div class="rs-row"><span>${tr('プレイ回数', 'Games played')}</span><b>${fmt(u.stats.gamesPlayed)}</b></div>
      <div class="rs-row"><span>${tr('バッジ', 'Badges')}</span><b>${u.badges.length ? u.badges.map(b => badgeIcons[b] || '🎖️').join(' ') : tr('なし', 'None')}</b></div>
      ${u.guild ? `<div class="rs-row"><span>${tr('ギルド', 'Guild')}</span><b>${u.guild.icon} [${escapeHtml(u.guild.tag)}] ${escapeHtml(u.guild.name)}${u.guild.owner ? ' 👑' : ''}</b></div>` : ''}
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="pLogout">${tr('ログアウト', 'Log out')}</button>
      <button class="btn btn-ghost" id="pRename">${tr('✏️ 名前変更', '✏️ Rename')}</button>
      <button class="btn btn-online" id="pStats">${tr('📊 戦績', '📊 Stats')}</button>
      <button class="btn btn-gold" id="pTitles">${tr('👑 称号', '👑 Titles')}</button>
      <button class="btn btn-primary" id="pClose">${tr('閉じる', 'Close')}</button>
    </div>`);
  m.querySelector('#pClose').onclick = closeModal;
  m.querySelector('#pStats').onclick = () => showStatsModal();
  m.querySelector('#pTitles').onclick = () => showTitlesModal();
  m.querySelector('#pRename').onclick = () => showRenameModal();
  m.querySelector('#pLogout').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    setToken(null);
    session.user = null;
    updateTopbar();
    closeModal();
    reconnectChat();
    refreshMissionDot();
    toast(tr('ログアウトしました', 'Logged out'));
  };
}

// ---------------------------------------------------------------------------
// Stats dashboard (プロフィール → 📊 戦績)
// ---------------------------------------------------------------------------

const MODE_LABEL = {
  solo: ['ソロ', 'Solo'], survival: ['サバイバル', 'Survival'], boss: ['ボス', 'Boss'],
  boss_rush: ['ボスラッシュ', 'Boss Rush'], weekly: ['ウィークリー', 'Weekly'],
  chaos: ['カオス', 'Chaos'], pvp: ['オンライン', 'Online'], tournament: ['トーナメント', 'Tournament'],
  meltdown: ['メルトダウン', 'Meltdown'], chimera: ['キメラ工房', 'Chimera Lab'],
  puzzle: ['パズル遺跡', 'Puzzle Ruins'], dig: ['採掘場', 'The Mines'], ghost: ['幽霊屋敷', 'Haunted House'],
  royale: ['バトルロイヤル', 'Royale'], dungeon: ['ダンジョン', 'Dungeon'],
  dungeon_under: ['地下', 'Underworld'], dungeon_heaven: ['天界', 'Heavens'],
  ai_easy: ['AI戦', 'VS AI'], ai_normal: ['AI戦', 'VS AI'], ai_hard: ['AI戦', 'VS AI'],
  ai_oni: ['AI戦', 'VS AI'], ai_kami: ['AI戦', 'VS AI'], ai_souzou: ['AI戦', 'VS AI'],
};
const modeLabel = id => (MODE_LABEL[id] ? tr(MODE_LABEL[id][0], MODE_LABEL[id][1]) : id);

// Inline SVG sparkline of the most recent runs — no chart library needed.
function sparkline(history) {
  const pts = history.slice(-20);
  if (pts.length < 2) {
    return `<p class="muted center" style="font-size:12px;padding:16px 0">${tr('あと数回プレイするとグラフが表示されます', 'Play a few more games to see your trend')}</p>`;
  }
  const W = 300, H = 90, pad = 6;
  const max = Math.max(...pts.map(p => p.s), 1);
  const x = i => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const y = v => H - pad - (v / max) * (H - pad * 2);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.s).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const dots = pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.s).toFixed(1)}" r="${p.w ? 3.4 : 2.2}" fill="${p.w ? '#ffd75e' : '#5b8bff'}"><title>${modeLabel(p.m)} ${fmt(p.s)}</title></circle>`).join('');
  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="${tr('直近スコアの推移', 'Recent score trend')}">
      <defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5b8bff" stop-opacity=".45"/>
        <stop offset="100%" stop-color="#5b8bff" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#spg)"/>
      <path d="${line}" fill="none" stroke="#5b8bff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
    <div class="spark-legend">
      <span>${tr('直近', 'Last')} ${pts.length}${tr('戦', ' games')}</span>
      <span>${tr('最高', 'Peak')} <b>${fmt(max)}</b></span>
      <span><i style="background:#ffd75e"></i>${tr('勝利', 'Win')}</span>
    </div>`;
}

function showStatsModal() {
  const u = session.user;
  const s = u.stats || {};
  const history = Array.isArray(s.history) ? s.history : [];
  const xpInLevel = (u.xp || 0) % 1000;
  const played = Math.max(1, s.gamesPlayed || 0);
  const avg = Math.round((s.totalScore || 0) / played);
  const winRate = (s.pvpWins || 0) + (s.pvpLosses || 0) > 0
    ? Math.round(((s.pvpWins || 0) / ((s.pvpWins || 0) + (s.pvpLosses || 0))) * 100) : null;
  // Favourite mode, straight out of the rolling history.
  const counts = {};
  for (const h of history) counts[h.m] = (counts[h.m] || 0) + 1;
  const fav = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  const tile = (label, value, color) =>
    `<div class="stat-tile"><b style="${color ? `color:${color}` : ''}">${value}</b><span>${label}</span></div>`;

  const m = showModal(`
    <h2>📊 ${tr('戦績ダッシュボード', 'Stats Dashboard')}</h2>
    <div class="stat-lv">
      <div class="stat-lv-row"><b>Lv.${u.level}</b><span class="muted">${fmt(xpInLevel)} / 1,000 XP</span></div>
      <div class="ms-bar"><div style="width:${(xpInLevel / 1000) * 100}%"></div></div>
    </div>
    <div class="spark-wrap">${sparkline(history)}</div>
    <div class="stat-tiles">
      ${tile(tr('ハイスコア', 'High score'), fmt(s.bestScore || 0), 'var(--gold)')}
      ${tile(tr('平均スコア', 'Average'), fmt(avg))}
      ${tile(tr('累計スコア', 'Total score'), fmt(s.totalScore || 0))}
      ${tile(tr('プレイ回数', 'Games'), fmt(s.gamesPlayed || 0))}
      ${tile(tr('最大コンボ', 'Max combo'), fmt(s.maxCombo || 0), 'var(--yellow)')}
      ${tile(tr('累計ライン', 'Total lines'), fmt(s.totalLines || 0))}
      ${tile(tr('設置ブロック', 'Blocks placed'), fmt(s.piecesPlaced || 0))}
      ${tile(tr('レート', 'Rating'), `${rankOf(s.rating).icon}${fmt(s.rating || 0)}`, rankOf(s.rating).color)}
      ${winRate !== null ? tile(tr('PvP勝率', 'PvP win rate'), `${winRate}%`, winRate >= 50 ? 'var(--green)' : 'var(--red)') : ''}
      ${tile(tr('最高連勝', 'Best streak'), fmt(s.winStreakBest || s.winStreak || 0), 'var(--pink)')}
      ${tile(tr('⚡発動回数', '⚡ Ultimates'), fmt(s.ultsUsed || 0), 'var(--cyan)')}
      ${tile(tr('📋ミッション', '📋 Missions'), fmt(s.missionsDone || 0), 'var(--green)')}
      ${tile(tr('🏅実績', '🏅 Achievements'), fmt((u.achievements || []).length))}
      ${tile(tr('🔥連続ログイン', '🔥 Login streak'), tr(`${fmt(s.loginStreak || 1)}日`, `${fmt(s.loginStreak || 1)}d`), 'var(--red)')}
      ${tile(tr('🏰最高到達階', '🏰 Deepest floor'), `F${fmt(s.dungeonMax || 0)}`)}
      ${tile(tr('💀最高ウェーブ', '💀 Best wave'), `W${fmt(s.survivalWave || 0)}`)}
    </div>
    ${fav ? `<p class="muted center" style="margin-top:10px;font-size:12px">${tr('よく遊ぶモード', 'Most played')}: <b>${escapeHtml(modeLabel(fav[0]))}</b> (${fav[1]}${tr('戦', '')})</p>` : ''}
    <div class="modal-buttons">
      <button class="btn btn-primary" id="stClose">${tr('閉じる', 'Close')}</button>
    </div>`);
  m.querySelector('#stClose').onclick = () => { closeModal(); showProfileModal(); };
}

// Rename: account name (logged in) — once per day, enforced server-side.
function showRenameModal() {
  const m = showModal(`
    <h2>${tr('✏️ 名前変更', '✏️ Change name')}</h2>
    <p class="muted center" style="margin-bottom:10px">${tr('2〜16文字（英数字・日本語）・1日1回まで', '2–16 characters ・ once per day')}</p>
    <div class="form-col">
      <input id="rnName" type="text" maxlength="16" value="${escapeHtml(session.user.username)}" autocomplete="off">
      <div class="form-error" id="rnError"></div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rnCancel">${tr('やめる', 'Cancel')}</button>
        <button class="btn btn-primary" id="rnApply">${tr('変更する', 'Rename')}</button>
      </div>
    </div>`);
  m.querySelector('#rnCancel').onclick = closeModal;
  m.querySelector('#rnApply').onclick = async () => {
    try {
      const data = await api('/api/me/rename', { method: 'POST', body: { username: m.querySelector('#rnName').value.trim() } });
      session.user = data.user;
      updateTopbar();
      reconnectChat();
      closeModal();
      audio.coin();
      toast(tr(`名前を「${data.user.username}」に変更しました！`, `Renamed to "${data.user.username}"!`), 'ok', 3000);
    } catch (err) {
      m.querySelector('#rnError').textContent = err.message;
      audio.error();
    }
  };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

// 🐛 バグ報告 — ゲストでも送れる。管理者パネルの「🐛 バグ報告」に届く。
export function showBugReportModal() {
  const m = showModal(`
    <h2>🐛 ${tr('バグ報告', 'Report a Bug')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">
      ${tr('見つけたバグや気になったことを教えてください！<br><small>「どのモードで・何をしたら・どうなったか」を書いてもらえると直しやすいです。</small>',
          'Tell us about any bug you found!<br><small>Mode, what you did, and what happened — the more detail the faster the fix.</small>')}
    </p>
    <textarea id="bugText" maxlength="1000" rows="6" style="width:100%;resize:vertical"
      placeholder="${tr('例）採掘場で地層が上がった瞬間にピースを置いたら、スコアが…', 'e.g. In the Mines, when I placed a piece right as the ground rose…')}"></textarea>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="bugCancel">${tr('やめる', 'Cancel')}</button>
      <button class="btn btn-primary" id="bugSend">${tr('📮 送信', '📮 Send')}</button>
    </div>`);
  m.querySelector('#bugCancel').onclick = closeModal;
  m.querySelector('#bugSend').onclick = async () => {
    const text = m.querySelector('#bugText').value.trim();
    if (text.length < 5) { toast(tr('もう少し詳しく書いてください', 'Please add a little more detail'), 'err', 2000); return; }
    m.querySelector('#bugSend').disabled = true;
    try {
      await api('/api/bugreport', { method: 'POST', body: { text } });
      closeModal();
      audio.coin();
      toast(tr('🐛 報告ありがとうございます！運営が確認します', '🐛 Thank you! The team will take a look'), 'ok', 3500);
    } catch (err) {
      m.querySelector('#bugSend').disabled = false;
      toast(err.message, 'err', 2500);
    }
  };
}

function showCreditsModal() {
  const m = showModal(`
    <div class="center" style="margin-bottom:6px">
      <span style="font-size:28px">🟥🟦<br>🟨🟩</span>
    </div>
    <h2>BLOCK BLITZ ARENA</h2>
    <div class="result-stats" style="margin-top:10px">
      <div class="rs-row"><span>${tr('企画・運営', 'Produced by')}</span><b>るみまき</b></div>
      <div class="rs-row"><span>${tr('開発・プログラム', 'Development')}</span><b>るみまき</b></div>
      <div class="rs-row"><span>${tr('ゲームデザイン', 'Game design')}</span><b>るみまき</b></div>
      <div class="rs-row"><span>${tr('音楽・効果音', 'Music & SFX')}</span><b>${tr('オリジナル（WebAudioシンセ）', 'Original (WebAudio synth)')}</b></div>
      <div class="rs-row"><span>${tr('グラフィック', 'Graphics')}</span><b>${tr('Canvas 手描きレンダリング', 'Hand-drawn Canvas rendering')}</b></div>
      <div class="rs-row"><span>Special Thanks</span><b>${tr('遊んでくれるキミ！', 'YOU, for playing!')}</b></div>
    </div>
    <p class="muted center" style="font-size:11px;margin-top:10px">© 2026 Block Blitz Arena ・ Made with 🧱 & ❤️</p>
    <div class="modal-buttons">
      <button class="btn btn-primary" id="crClose">${tr('閉じる', 'Close')}</button>
    </div>`);
  m.querySelector('#crClose').onclick = () => { closeModal(); showSettingsModal(); };
  confettiBurst(25);
}

// ---------------------------------------------------------------------------
// Title catalog cache (for name lookups in profile / leaderboard)
// ---------------------------------------------------------------------------

let titlesCatalog = null;
export async function loadTitles() {
  try { titlesCatalog = (await api('/api/titles')).titles; } catch { /* offline */ }
}
function titleName(id) {
  const t = titlesCatalog && titlesCatalog.find(x => x.id === id);
  return t ? catName(t) : '';
}

// ---------------------------------------------------------------------------
// Gem shop (demo payments)
// ---------------------------------------------------------------------------

let gemPacks = null;
let gemMode = 'demo';

export async function showGemShop() {
  if (!session.user) { showAuthModal(); return; }
  try {
    if (!gemPacks) {
      const data = await api('/api/gempacks');
      gemPacks = data.packs;
      gemMode = data.mode || 'demo';
    }
  } catch (err) { toast(err.message, 'err'); return; }
  const isStripe = gemMode === 'stripe';
  const m = showModal(`
    <h2>${tr('💎 ジェムショップ', '💎 Gem Shop')}</h2>
    <p class="muted center" style="margin-bottom:12px">${tr('所持ジェム', 'Your gems')}: <b style="color:var(--cyan)">${fmt(session.user.gems)}</b></p>
    ${isStripe ? '' : `
    <div class="coming-soon-banner">${tr('🚧 課金機能は製作中です 🚧', '🚧 Payments are under construction 🚧')}<br><small>${tr('もうしばらくお待ちください', 'Check back soon!')}</small></div>`}
    <div class="form-col">
      ${gemPacks.map(p => `
        <button class="gem-pack ${isStripe ? '' : 'disabled'}" data-pack="${p.id}" ${isStripe ? '' : 'disabled'}>
          <span class="gp-gems">💎 ${fmt(p.gems)}${p.bonus ? `<small> ${tr(`+${fmt(p.bonus)}ボーナス`, `+${fmt(p.bonus)} bonus`)}</small>` : ''}</span>
          <span class="gp-price">¥${fmt(p.priceJpy)}</span>
        </button>`).join('')}
      ${isStripe
        ? `<p class="muted center" style="font-size:11px">${tr('🔒 決済はStripeの安全なページで行われます', "🔒 Checkout is handled on Stripe's secure page")}</p>`
        : ''}
    </div>`);
  if (!isStripe) return;
  m.querySelectorAll('[data-pack]').forEach(btn => {
    btn.onclick = async () => {
      const pack = gemPacks.find(p => p.id === btn.dataset.pack);
      // Real payment: hand off to Stripe's hosted checkout page.
      try {
        const res = await api('/api/purchase', { method: 'POST', body: { packId: pack.id } });
        if (res.checkoutUrl) { location.href = res.checkoutUrl; return; }
        toast(tr('決済ページを開けませんでした', 'Could not open the checkout page'), 'err');
      } catch (err) { audio.error(); toast(err.message, 'err'); }
    };
  });
}

// ---------------------------------------------------------------------------
// Titles (称号)
// ---------------------------------------------------------------------------

export async function showTitlesModal() {
  let data;
  try {
    data = await api('/api/titles');
  } catch (err) { toast(err.message, 'err'); return; }
  const m = showModal(`
    <h2>${tr('👑 称号', '👑 Titles')}</h2>
    <div class="form-col title-list">
      <button class="title-row ${!data.equipped ? 'equipped' : ''}" data-title="">
        <span class="t-name" style="color:var(--muted)">${tr('称号なし', 'No title')}</span>
      </button>
      ${data.titles.map(t => {
        const earned = data.earned.includes(t.id);
        const eq = data.equipped === t.id;
        return `
        <button class="title-row ${eq ? 'equipped' : ''} ${earned ? '' : 'locked'}" data-title="${t.id}" ${earned ? '' : 'disabled'}>
          <span class="t-name" style="color:${t.color}">${earned ? '' : '🔒 '}${catName(t)}</span>
          <span class="t-desc">${catDesc(t)}</span>
        </button>`;
      }).join('')}
    </div>`);
  m.querySelectorAll('[data-title]').forEach(btn => {
    btn.onclick = async () => {
      if (!session.user) { showAuthModal(); return; }
      try {
        await api('/api/titles/equip', { method: 'POST', body: { id: btn.dataset.title || null } });
        audio.click();
        toast(btn.dataset.title ? tr('称号を装備しました', 'Title equipped') : tr('称号を外しました', 'Title removed'), 'ok', 1500);
        closeModal();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

export function showSettingsModal() {
  const s = getSettings();
  const guestName = localStorage.getItem('bba_guest_name') || '';
  const m = showModal(`
    <h2>${tr('⚙️ 設定', '⚙️ Settings')}</h2>
    <div class="form-col">
      <div class="settings-row">
        <label>${tr('🌐 言語 / Language', '🌐 Language / 言語')}</label>
        <div class="seg" id="setLang">
          <button data-l="ja" ${LANG === 'ja' ? 'class="active"' : ''}>日本語</button>
          <button data-l="en" ${LANG === 'en' ? 'class="active"' : ''}>English</button>
        </div>
      </div>
      <div class="settings-row">
        <label>${tr('🔊 効果音', '🔊 Sound FX')}<br><small class="muted" style="font-weight:600">${tr('最大200%（音割れ防止リミッター内蔵）', 'Up to 200% (built-in limiter)')}</small></label>
        <input type="range" id="setSfxVol" min="0" max="200" value="${Math.round(s.sfxVol * 100)}">
        <b id="setSfxPct" style="min-width:44px;text-align:right;font-variant-numeric:tabular-nums">${Math.round(s.sfxVol * 100)}%</b>
        <input type="checkbox" id="setSfxOn" ${s.sfxOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>🎵 BGM</label>
        <input type="range" id="setMusicVol" min="0" max="200" value="${Math.round(s.musicVol * 100)}">
        <b id="setMusicPct" style="min-width:44px;text-align:right;font-variant-numeric:tabular-nums">${Math.round(s.musicVol * 100)}%</b>
        <input type="checkbox" id="setMusicOn" ${s.musicOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>🎧 ${tr('サウンドトラック', 'Soundtrack')}<br><small class="muted" style="font-weight:600">${tr('好きな曲を選んでループ再生', 'Pick any track & loop it')}</small></label>
        <button class="btn btn-sm btn-ghost" id="setJukebox">${(() => { const t = TRACK_INFO.find(x => x.id === s.bgmTrack); return t ? `🔁 ${escapeHtml(tr(t.name, t.nameEn))}` : tr('開く', 'Open'); })()}</button>
      </div>
      <div class="settings-row">
        <label>${tr('📳 画面シェイク', '📳 Screen shake')}</label>
        <input type="checkbox" id="setShake" ${s.shake ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>${tr('🌐 チャット自動翻訳', '🌐 Auto-translate chat')}<br><small class="muted" style="font-weight:600">${tr('日本語⇄英語。原文はタップで表示', 'JA ⇄ EN, tap to see the original')}</small></label>
        <input type="checkbox" id="setChatTr" ${s.chatTranslate !== false ? 'checked' : ''}>
      </div>
      ${session.user && session.user.role === 'admin' ? `
      <div class="settings-row">
        <label>🛡️ 管理者専用ボタンを表示<br><small class="muted" style="font-weight:600">カオス／オートパイロット／コマンドパレット／全モードでアイテム</small></label>
        <input type="checkbox" id="setStaffUi" ${staffUiOn() ? 'checked' : ''}>
      </div>` : ''}
      <div class="settings-row">
        <label>${tr('✨ パーティクル量', '✨ Particles')}</label>
        <div class="seg" id="setParticles">
          <button data-p="low" ${s.particles === 'low' ? 'class="active"' : ''}>${tr('少なめ', 'Low')}</button>
          <button data-p="normal" ${s.particles === 'normal' ? 'class="active"' : ''}>${tr('標準', 'Normal')}</button>
          <button data-p="high" ${s.particles === 'high' ? 'class="active"' : ''}>${tr('多め', 'High')}</button>
        </div>
      </div>
      ${session.user ? `
      <div class="settings-row">
        <label>${tr('✏️ 名前を変更', '✏️ Change name')}</label>
        <button class="btn btn-sm btn-ghost" id="setRename">${escapeHtml(session.user.username)}</button>
      </div>` : `
      <div class="settings-row">
        <label>${tr('✏️ ゲスト名', '✏️ Guest name')}</label>
        <input id="setGuestName" type="text" maxlength="16" value="${escapeHtml(guestName)}" placeholder="${tr('ゲスト1234', 'Guest1234')}" style="width:130px">
      </div>`}
      <div class="settings-row">
        <label>${tr('🐛 バグ報告', '🐛 Report a bug')}</label>
        <button class="btn btn-sm btn-ghost" id="setBugReport">${tr('報告する', 'Report')}</button>
      </div>
      <div class="settings-row">
        <label>${tr('📜 クレジット', '📜 Credits')}</label>
        <button class="btn btn-sm btn-ghost" id="setCredits">${tr('見る', 'View')}</button>
      </div>
      <div class="settings-row danger-row">
        <label>${tr('🗑️ ローカルデータをリセット', '🗑️ Reset local data')}</label>
        <button class="btn btn-sm btn-ghost" id="setResetLocal">${tr('実行', 'Reset')}</button>
      </div>
      ${session.user ? `
      <div class="settings-row danger-row">
        <label>${tr('⚠️ アカウントを完全削除', '⚠️ Delete account')}</label>
        <button class="btn btn-sm btn-ghost" id="setDeleteAccount" style="color:var(--red)">${tr('削除', 'Delete')}</button>
      </div>` : ''}
      <div class="modal-buttons">
        <button class="btn btn-primary" id="setClose">${tr('閉じる', 'Close')}</button>
      </div>
    </div>`);

  m.querySelectorAll('#setLang button').forEach(b => {
    b.onclick = () => {
      if (b.dataset.l === LANG) return;
      setLang(b.dataset.l);
      location.reload();   // reapply every static/dynamic string in one shot
    };
  });

  m.querySelector('#setCredits').onclick = () => showCreditsModal();
  m.querySelector('#setBugReport').onclick = () => { audio.click(); closeModal(); showBugReportModal(); };
  m.querySelector('#setJukebox').onclick = () => { audio.click(); closeModal(); showJukeboxModal(); };

  const renameBtn = m.querySelector('#setRename');
  if (renameBtn) renameBtn.onclick = () => showRenameModal();

  const guestInput = m.querySelector('#setGuestName');
  if (guestInput) guestInput.onchange = () => {
    const name = guestInput.value.trim().slice(0, 16).replace(/[<>"'`]/g, '');
    if (!name) return;
    localStorage.setItem('bba_guest_name', name);
    reconnectChat();
    toast(tr(`ゲスト名を「${name}」にしました`, `Guest name set to "${name}"`), 'ok', 2000);
  };

  m.querySelector('#setSfxOn').onchange = e => { updateSettings({ sfxOn: e.target.checked }); audio.click(); };
  m.querySelector('#setMusicOn').onchange = e => updateSettings({ musicOn: e.target.checked });
  m.querySelector('#setShake').onchange = e => updateSettings({ shake: e.target.checked });
  m.querySelector('#setChatTr').onchange = e => {
    updateSettings({ chatTranslate: e.target.checked });
    toast(e.target.checked ? tr('🌐 チャットを自動翻訳します', '🌐 Chat will be auto-translated') : tr('🌐 自動翻訳をオフにしました', '🌐 Auto-translation off'), 'ok');
  };
  const staffToggle = m.querySelector('#setStaffUi');
  if (staffToggle) staffToggle.onchange = e => {
    setStaffUi(e.target.checked);
    toast(e.target.checked ? '🛡️ 管理者専用ボタンを表示します' : '👤 プレイヤーと同じ表示にしました', 'ok');
  };
  m.querySelector('#setSfxVol').oninput = e => {
    updateSettings({ sfxVol: e.target.value / 100 });
    m.querySelector('#setSfxPct').textContent = `${e.target.value}%`;
    audio.click();
  };
  m.querySelector('#setMusicVol').oninput = e => {
    updateSettings({ musicVol: e.target.value / 100 });
    m.querySelector('#setMusicPct').textContent = `${e.target.value}%`;
  };
  m.querySelectorAll('#setParticles button').forEach(b => {
    b.onclick = () => {
      m.querySelectorAll('#setParticles button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      updateSettings({ particles: b.dataset.p });
      audio.click();
    };
  });
  m.querySelector('#setClose').onclick = closeModal;

  m.querySelector('#setResetLocal').onclick = () => {
    const c = showModal(`
      <h2>${tr('🗑️ ローカルデータをリセット', '🗑️ Reset local data')}</h2>
      <p class="muted center" style="margin-bottom:14px">${tr('設定・ゲストのベストスコア・隠し難易度の解放状態を消去します。', 'This clears your settings, guest best score and hidden-difficulty unlocks.')}<br>${tr('アカウントのデータ（コイン・スコア等）は残ります。', 'Your account data (coins, scores, etc.) is kept.')}</p>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rlNo">${tr('やめる', 'Cancel')}</button>
        <button class="btn btn-ai" id="rlYes">${tr('リセットする', 'Reset')}</button>
      </div>`);
    c.querySelector('#rlNo').onclick = () => { closeModal(); showSettingsModal(); };
    c.querySelector('#rlYes').onclick = () => {
      for (const key of ['bba_settings', 'bba_best', 'bba_oni', 'bba_kami', 'bba_guest_name']) {
        localStorage.removeItem(key);
      }
      location.reload();
    };
  };

  const delBtn = m.querySelector('#setDeleteAccount');
  if (delBtn) delBtn.onclick = () => {
    const c = showModal(`
      <h2>${tr('⚠️ アカウント削除', '⚠️ Delete account')}</h2>
      <p class="muted center" style="margin-bottom:14px">${tr(`「${escapeHtml(session.user.username)}」を完全に削除します。`, `This will permanently delete "${escapeHtml(session.user.username)}".`)}<br>${tr('コイン・スコア・購入アイテムはすべて失われ、元に戻せません。', 'All coins, scores and purchases will be lost — this cannot be undone.')}</p>
      <div class="form-col">
        <input id="delPass" type="password" placeholder="${tr('パスワードを入力して確認', 'Enter password to confirm')}" autocomplete="current-password">
        <div class="form-error" id="delError"></div>
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="delNo">${tr('やめる', 'Cancel')}</button>
          <button class="btn btn-ai" id="delYes">${tr('完全に削除する', 'Delete forever')}</button>
        </div>
      </div>`);
    c.querySelector('#delNo').onclick = () => { closeModal(); showSettingsModal(); };
    c.querySelector('#delYes').onclick = async () => {
      try {
        await api('/api/me', { method: 'DELETE', body: { password: c.querySelector('#delPass').value } });
        setToken(null);
        session.user = null;
        toast(tr('アカウントを削除しました。ご利用ありがとうございました', 'Account deleted. Thanks for playing!'), 'ok', 3000);
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        c.querySelector('#delError').textContent = err.message;
        audio.error();
      }
    };
  };
}

// ---------------------------------------------------------------------------
// 🎧 サウンドトラック (Jukebox) — 全曲を試聴・ループ固定・音量調整
// ---------------------------------------------------------------------------

export function showJukeboxModal() {
  const s = getSettings();
  // 保存値は必ず実在するトラックIDに正規化してから使う。
  const savedPin = TRACK_INFO.some(t => t.id === s.bgmTrack) ? s.bgmTrack : null;
  let lock = !!savedPin;                         // 🔁 選んだ曲をどの画面でも流す
  let sel = savedPin || audio.playing || null;   // いま選択中のトラック

  const m = showModal(`
    <h2>🎧 ${tr('サウンドトラック', 'Soundtrack')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">
      ${tr('タップで再生。🔁をONにすると、どの画面でもその曲がループ再生され続けます', 'Tap a track to play it. Turn 🔁 on and it keeps looping on every screen')}
    </p>
    <div class="settings-row">
      <label>🔊 ${tr('BGM音量', 'Music volume')}</label>
      <input type="range" id="jbVol" min="0" max="200" value="${Math.round(s.musicVol * 100)}">
      <b id="jbVolPct" style="min-width:42px;text-align:right;font-variant-numeric:tabular-nums">${Math.round(s.musicVol * 100)}%</b>
    </div>
    <div class="settings-row">
      <label>🔁 ${tr('選んだ曲をループ固定', 'Loop my pick everywhere')}</label>
      <input type="checkbox" id="jbLock" ${lock ? 'checked' : ''}>
    </div>
    <div class="jb-list" id="jbList"></div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="jbYt">🎬 ${tr('YouTube書き出し', 'YouTube export')}</button>
      <button class="btn btn-primary" id="jbClose">${tr('閉じる', 'Close')}</button>
    </div>`,
  // 背景タップで閉じると stopPreview が走らず試聴が鳴りっぱなしになるため、
  // 閉じるのは必ず「閉じる」ボタン経由にする。
  { dismissable: false });

  const list = m.querySelector('#jbList');
  // 隠しモードの曲は、その扉を見つけた者にしか聞こえない。
  const visibleTracks = TRACK_INFO.filter(t2 => !t2.hidden || ghostUnlocked());
  const render = () => {
    const now = audio.playing;
    const autoActive = !lock && !audio.previewTrack;
    list.innerHTML = `
      ${visibleTracks.map(t => `
        <button class="jb-row ${now === t.id ? 'playing' : ''}" data-jb="${t.id}">
          <span class="jb-icon">${t.icon}</span>
          <span class="jb-meta">
            <b>${escapeHtml(tr(t.name, t.nameEn))}${lock && sel === t.id ? ' <span class="jb-pin">🔁</span>' : ''}</b>
            <small>${escapeHtml(tr(t.where, t.whereEn))} ・ ${t.bpm} BPM</small>
          </span>
          ${now === t.id ? '<span class="jb-eq"><i></i><i></i><i></i></span>' : '<span class="jb-play">▶</span>'}
        </button>`).join('')}
      <button class="jb-row jb-auto ${autoActive ? 'playing' : ''}" data-jb="">
        <span class="jb-icon">🔄</span>
        <span class="jb-meta"><b>${tr('おまかせ', 'Auto')}</b><small>${tr('画面ごとにBGMを自動で切り替え（通常モード）', 'Music switches with each screen (default)')}</small></span>
        ${autoActive ? '<span class="jb-play">✓</span>' : ''}
      </button>`;
    list.querySelectorAll('[data-jb]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.jb;
        if (!id) {
          // おまかせ: 固定解除して通常の画面連動BGMへ
          lock = false;
          sel = null;
          m.querySelector('#jbLock').checked = false;
          updateSettings({ bgmTrack: null });
          audio.stopPreview();
        } else {
          sel = id;
          // 曲をタップした＝聴きたいということ。BGMがOFFでも鳴らす。
          if (!getSettings().musicOn) {
            updateSettings({ musicOn: true });
            toast(tr('🎵 BGMをONにしました', '🎵 Music turned on'), 'ok', 1800);
          }
          audio.preview(id);
          if (lock) updateSettings({ bgmTrack: id });
        }
        render();
      };
    });
  };
  render();

  m.querySelector('#jbVol').oninput = e => {
    updateSettings({ musicVol: e.target.value / 100 });
    m.querySelector('#jbVolPct').textContent = `${e.target.value}%`;
  };
  m.querySelector('#jbLock').onchange = e => {
    lock = e.target.checked;
    if (lock) {
      // タップ時と同じく、聴く気があるのにBGMがOFFなら黙ってONにする —
      // 「ループ再生します」と言いながら無音、は嘘になる。
      if (!getSettings().musicOn) updateSettings({ musicOn: true });
      sel = TRACK_INFO.some(t => t.id === sel) ? sel : (audio.playing || 'menu');
    }
    updateSettings({ bgmTrack: lock ? sel : null });
    toast(lock
      ? tr('🔁 この曲をどの画面でもループ再生します', '🔁 This track now loops on every screen')
      : tr('🔄 画面ごとの自動BGMに戻しました', '🔄 Back to automatic per-screen music'), 'ok', 2200);
    render();
  };
  m.querySelector('#jbYt').onclick = () => {
    audio.stopPreview();
    closeModal();
    showYouTubeStudio();
  };
  m.querySelector('#jbClose').onclick = () => {
    audio.stopPreview();   // 固定中はその曲が流れ続け、未固定なら元のBGMに戻る
    closeModal();
    showSettingsModal();
  };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export async function openLeaderboard(board = 'score') {
  showScreen('leaderboard');
  $$('[data-lb]').forEach(t => t.classList.toggle('active', t.dataset.lb === board));
  const list = $('#lbList');
  list.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  try {
    const data = await api(`/api/leaderboard?board=${board}`);
    if (!data.rows.length) {
      list.innerHTML = `<p class="muted center">${tr('まだ記録がありません。最初の挑戦者になろう！', 'No records yet — be the first challenger!')}</p>`;
      return;
    }
    const medal = i => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    // Weekly board: show the prize table paid out at every Monday reset.
    let rewardHead = '';
    if (board === 'weekly' && data.rewards) {
      let prev = 0;
      const chips = data.rewards.map(t => {
        const label = t.upTo === null ? tr(`${prev + 1}位〜`, `#${prev + 1}+`)
          : t.upTo === prev + 1 ? tr(`${t.upTo}位`, `#${t.upTo}`)
          : tr(`${prev + 1}〜${t.upTo}位`, `#${prev + 1}-${t.upTo}`);
        prev = t.upTo === null ? prev : t.upTo;
        return `<span>${label} ${fmt(t.coins)}🪙+${fmt(t.gems)}💎${t.badge ? '+🏅' : ''}</span>`;
      }).join('');
      rewardHead = `<div class="lb-rewards">🎁 <b>${tr('毎週月曜リセットで順位に応じた報酬！', 'Rank prizes at every Monday reset!')}</b>${chips}</div>`;
    }
    const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈', souzou: '🌌', rush: '⚔️', dungeon: '🏰', tourney: '🏆', royale: '💯', adminevent: '👑', abyss: '🌑', weekly1: '🏅', puzzle: '🧩', dig: '⛏️', crown2: '👑', crown3: '👑', crown5: '👑', crown7: '🌈', ghost: '👻' };
    list.innerHTML = rewardHead + data.rows.map((r, i) => `
      <div class="lb-row ${session.user && r.username === session.user.username ? 'me' : ''} ${r.throne ? 'throne' : ''}" style="animation-delay:${Math.min(i * 40, 600)}ms">
        <div class="lb-rank ${i === 0 ? 'top1' : ''}">${medal(i)}</div>
        <div class="lb-name ${r.crowns ? `crowned${Math.min(3, r.crowns)}` : ''}">${r.throne ? `<span class="lb-crown" title="${tr('現王者', 'Reigning champion')}">👑</span>` : ''}${r.guildTag ? `<span class="lb-tag">[${escapeHtml(r.guildTag)}]</span>` : ''}${escapeHtml(r.username)}
          <span class="lb-badges">${(r.badges || []).map(b => badgeIcons[b] || '').join('')}</span>
          ${r.title ? `<span class="lb-title" style="color:${escapeHtml(r.title.color)}">《${escapeHtml(r.title.id ? catName(r.title) : r.title.name)}》</span>` : ''}
          <div class="lb-lvl">Lv.${r.level}${board === 'rating' ? ` ・ ${tr(`${r.pvpWins}勝${r.pvpLosses}敗`, `${r.pvpWins}W ${r.pvpLosses}L`)}` : ''}${board === 'sprint' && r.sprint180 ? ` ・ ${tr('3分', '3min')} ${fmt(r.sprint180)}` : ''}${board === 'dungeon' && r.abyssMax ? ` ・ 🌑A${fmt(r.abyssMax)}` : ''}</div>
        </div>
        <div class="lb-score">${board === 'dungeon' ? `F${fmt(r.dungeonMax || 0)}`
          : board === 'weekly' ? fmt(r.weeklyBest || 0)
          : board === 'sprint' ? fmt(r.sprintBest || 0)
          : board === 'puzzle' ? tr(`ステージ${fmt(r.puzzleStage || 0)}`, `Stage ${fmt(r.puzzleStage || 0)}`)
          : board === 'dig' ? `${fmt(r.digDepth || 0)}m`
          : board === 'rating' ? `${rankOf(r.rating).icon}${fmt(r.rating)}` : fmt(r.bestScore)}</div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

let shopItems = null;
let shopBoosters = null;
let shopTab = 'skin';
let shopRole = null;   // admin sees exclusive gear — refetch when the role changes

export async function openShop(tab = shopTab) {
  showScreen('shop');
  shopTab = tab;
  $$('[data-shop]').forEach(t => t.classList.toggle('active', t.dataset.shop === tab));
  const grid = $('#shopGrid');
  grid.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  try {
    const role = session.user ? session.user.role : 'guest';
    if (!shopItems || shopRole !== role) {
      const data = await api('/api/shop');
      shopItems = data.items;
      shopBoosters = data.boosters || [];
      shopRole = role;
    }
  } catch (err) {
    grid.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderShop();
}

function renderShop() {
  if (shopTab === 'item') { renderBoosterShop(); return; }
  const grid = $('#shopGrid');
  const u = session.user;
  const items = shopItems.filter(i => i.cat === shopTab);
  grid.innerHTML = '';
  if (shopTab === 'ult') {
    const note = document.createElement('p');
    note.className = 'muted center';
    note.style.gridColumn = '1 / -1';
    note.innerHTML = tr(
      'ラインを消すと⚡ゲージが溜まり、MAXでHUDの⚡ボタンから<b>必殺技</b>が撃てる！装備できるのは1つだけ。<br><small>ソロ・ボス・ダンジョン・サバイバル・カオスで使用可（AI／オンライン／ウィークリーは公平のため対象外）</small>',
      'Clearing lines charges the ⚡ gauge — at MAX, fire your <b>ultimate</b> from the HUD button. One equipped at a time.<br><small>Usable in Solo, Boss, Dungeon, Survival and Chaos (disabled in AI / Online / Weekly for fairness)</small>');
    grid.appendChild(note);
  }
  items.forEach((item, idx) => {
    // Admin gear is implicitly owned by admins (never purchasable).
    const owned = item.adminOnly ? (u && u.role === 'admin')
      : u ? u.owned.includes(item.id) : item.price === 0;
    const equipped = item.cat === 'ult'
      ? equippedUlt() === item.id
      : u ? u.equipped[item.cat] === item.id : !!item.default;
    const cur = item.currency === 'gems' ? '💎' : '🪙';
    const el = document.createElement('div');
    el.className = `shop-item ${equipped ? 'equipped' : ''}`;
    el.style.animationDelay = `${Math.min(idx * 50, 400)}ms`;
    el.innerHTML = `
      <div class="shop-preview" data-pv="${item.id}"></div>
      <div class="shop-name">${item.adminOnly ? '👑 ' : ''}${catName(item)}</div>
      <div class="shop-desc">${catDesc(item)}</div>
      ${equipped
        ? `<button class="btn btn-sm btn-ghost" disabled>${tr('✓ 装備中', '✓ Equipped')}</button>`
        : owned
          ? `<button class="btn btn-sm btn-primary" data-act="equip">${tr('装備する', 'Equip')}</button>`
          : item.adminOnly
            ? `<button class="btn btn-sm btn-ghost" disabled>${tr('👑 運営専用', '👑 Staff only')}</button>`
            : item.gachaOnly
              ? `<button class="btn btn-sm btn-ghost shop-gachaonly" disabled>${tr('🎰 ガチャ限定', '🎰 Gacha only')}</button>`
              : `<button class="btn btn-sm btn-gold" data-act="buy">${cur} ${fmt(item.price)}</button>`}
    `;
    grid.appendChild(el);
    renderPreview(el.querySelector('.shop-preview'), item);
    const btn = el.querySelector('[data-act]');
    if (btn) btn.onclick = () => (btn.dataset.act === 'buy' ? buyItem(item) : equipItem(item));
  });
}

// ---------------------------------------------------------------------------
// 🎒 インベントリ（プレイヤー向け）
//
// 「自分が何を持っているか」は今まで4か所に散らばっていた: コスメはショップの
// 購入グリッドの中、アイテム個数はショップのタブとゲーム中のHUDだけ、称号は
// プロフィール→👑と3クリック先、バッジに至っては名前も解除条件もプレイヤー
// 側のどこにも存在しなかった。ここに集約する。
//
// 価格・購入・ガチャはここに複製しない（第二のショップになってしまう）。
// 足りないものは openShop(cat) / openGacha() へのリンクで渡す。
// ---------------------------------------------------------------------------

// バッジの名前と解除条件。プレイヤー向けには今まで一切表示されていなかった。
// 条件は server/index.js の付与箇所（applyGameResult ほか）と対応している。
const BADGE_INFO = {
  oni:        { icon: '👹', ja: '鬼討伐',        en: 'Oni Slayer',      cja: 'AI対戦の難易度「鬼」に勝利',        cen: 'Beat the Oni AI' },
  kami:       { icon: '🔱', ja: '神殺し',        en: 'God Slayer',      cja: '隠し難易度「神」に勝利',            cen: 'Beat the hidden Kami AI' },
  souzou:     { icon: '🌌', ja: '創造神討伐',    en: 'Creator Slayer',  cja: '真の隠し難易度「創造神」に勝利',    cen: 'Beat the true hidden AI' },
  maou:       { icon: '😈', ja: '魔王討伐',      en: 'Demon Lord',      cja: 'ボス「まおう」を討伐',              cen: 'Defeat the Demon Lord boss' },
  rush:       { icon: '⚔️', ja: 'ボスラッシュ制覇', en: 'Rush Conqueror', cja: 'ボスラッシュをクリア',            cen: 'Clear Boss Rush' },
  dungeon:    { icon: '🏰', ja: '百塔踏破',      en: 'Tower Conqueror', cja: 'ダンジョンの塔100Fを制覇',          cen: 'Conquer floor 100 of the Tower' },
  abyss:      { icon: '🌑', ja: '深淵踏破',      en: 'Abyss Conqueror', cja: '深淵ダンジョンA100を制覇',          cen: 'Conquer floor A100 of the Abyss' },
  tourney:    { icon: '🏆', ja: '大会優勝',      en: 'Tournament Champ', cja: 'オンライントーナメントで優勝',     cen: 'Win an online tournament' },
  royale:     { icon: '💯', ja: '百人の頂点',    en: 'Apex of 100',     cja: 'バトルロイヤルで1位',               cen: 'Take #1 in Battle Royale' },
  adminevent: { icon: '👑', ja: '管理者イベント制覇', en: 'Admin Event', cja: '管理者イベントの目標を達成',        cen: 'Complete an Admin Event objective' },
  weekly1:    { icon: '🏅', ja: '週間チャンピオン', en: 'Weekly Champion', cja: 'ウィークリーランキングで1位',     cen: 'Finish #1 on the weekly board' },
  puzzle:     { icon: '🧩', ja: '遺跡マスター',  en: 'Ruins Master',    cja: 'パズル遺跡のステージ50に到達',      cen: 'Reach Puzzle Ruins stage 50' },
  dig:        { icon: '⛏️', ja: 'マスター採掘士', en: 'Master Miner',   cja: '採掘場で深度50に到達',              cen: 'Reach depth 50 in the Mines' },
  ghost:      { icon: '👻', ja: '幽霊屋敷の生還者', en: 'Haunted House', cja: '幽霊屋敷で15,000点',               cen: 'Score 15,000 in the Haunted House' },
  bronze:     { icon: '🥉', ja: 'ブロンズ',      en: 'Bronze',          cja: 'バトルパスのティア10到達',          cen: 'Reach battle pass tier 10' },
  silver:     { icon: '🥈', ja: 'シルバー',      en: 'Silver',          cja: 'バトルパスのティア20到達',          cen: 'Reach battle pass tier 20' },
  gold:       { icon: '🥇', ja: 'ゴールド',      en: 'Gold',            cja: 'バトルパスのティア30到達',          cen: 'Reach battle pass tier 30' },
  crown2:     { icon: '👑', ja: '二冠',          en: 'Dual Crown',      cja: '王座を同時に2つ保持',               cen: 'Hold 2 thrones at once' },
  crown3:     { icon: '👑', ja: '三冠',          en: 'Triple Crown',    cja: '王座を同時に3つ保持',               cen: 'Hold 3 thrones at once' },
  crown5:     { icon: '👑', ja: '五冠',          en: 'Five Crowns',     cja: '王座を同時に5つ保持',               cen: 'Hold 5 thrones at once' },
  crown7:     { icon: '🌈', ja: '全冠制覇',      en: 'Total Domination', cja: '7つの王座をすべて同時に保持',       cen: 'Hold all 7 thrones at once' },
};
const BADGE_ORDER = ['oni', 'kami', 'souzou', 'maou', 'rush', 'dungeon', 'abyss', 'tourney', 'royale', 'adminevent', 'weekly1', 'puzzle', 'dig', 'ghost', 'bronze', 'silver', 'gold', 'crown2', 'crown3', 'crown5', 'crown7'];
const THRONE_LABEL = {
  score: '🏆 ハイスコア', rating: '📈 レート', dungeon: '🏰 ダンジョン', weekly: '🎯 ウィークリー',
  sprint: '⏱️ タイムアタック', puzzle: '🧩 パズル遺跡', dig: '⛏️ 採掘場',
};

let invTab = 'gear';

export async function openInventory(tab = invTab) {
  showScreen('inventory');
  invTab = tab;
  $$('[data-inv]').forEach(t => t.classList.toggle('active', t.dataset.inv === tab));
  const body = $('#invBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  try {
    if (!shopItems) {
      const data = await api('/api/shop');
      shopItems = data.items;
      shopBoosters = data.boosters || [];
      shopRole = session.user ? session.user.role : 'guest';
    }
  } catch (err) {
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderInvSummary();
  if (tab === 'gear') renderInvGear();
  else if (tab === 'item') renderInvItems();
  else if (tab === 'title') await renderInvTitles();
  else renderInvBadges();
}

// 管理者は「全ショップ所持・通貨無限」という表示上の嘘を持つので、
// 完成度を数字で出すと必ず嘘になる。そこだけ別扱いにする。
const invIsStaff = () => !!session.user && session.user.role === 'admin';

function invCollectibles() {
  return shopItems.filter(i => !i.adminOnly && !i.default);
}

function renderInvSummary() {
  const el = $('#invSummary');
  const u = session.user;
  if (!u) {
    el.innerHTML = `<span class="muted">${tr('ゲストとしてプレイ中 — 登録すると持ち物が保存されます', 'Playing as a guest — register to keep your collection')}</span>`;
    return;
  }
  if (invIsStaff()) {
    el.innerHTML = `<span>👑 ${tr('運営アカウント', 'Staff account')}</span><span class="muted">${tr('すべて解放されています', 'Everything is unlocked')}</span>`;
    return;
  }
  const all = invCollectibles();
  const have = all.filter(i => (u.owned || []).includes(i.id)).length;
  const pct = Math.round((have / Math.max(1, all.length)) * 100);
  el.innerHTML = `
    <span>📚 ${tr('コレクション', 'Collection')} <b>${have} / ${all.length}</b></span>
    <span class="inv-bar"><span style="width:${pct}%"></span></span>
    <span class="muted">${pct}%</span>`;
}

const CAT_TITLE = {
  skin: { ja: '🧱 ブロックスキン', en: '🧱 Block skins' },
  board: { ja: '🎨 ボードテーマ', en: '🎨 Board themes' },
  fx: { ja: '✨ 消去エフェクト', en: '✨ Clear effects' },
  ult: { ja: '⚡ アルティメット', en: '⚡ Ultimates' },
};

function renderInvGear() {
  const body = $('#invBody');
  const u = session.user;
  body.innerHTML = '';
  for (const cat of ['skin', 'board', 'fx', 'ult']) {
    const all = shopItems.filter(i => i.cat === cat && (!i.adminOnly || staffExtras()));
    const owned = all.filter(i => i.adminOnly ? invIsStaff()
      : u ? (u.owned || []).includes(i.id) : !!i.default);
    const total = all.filter(i => !i.adminOnly).length;
    const equippedId = cat === 'ult' ? equippedUlt()
      : u ? (u.equipped || {})[cat] : `${cat}_default`;
    const missing = total - owned.filter(i => !i.adminOnly).length;

    const sec = document.createElement('div');
    sec.className = 'inv-sec';
    sec.innerHTML = `
      <div class="inv-sec-head">
        <span>${tr(CAT_TITLE[cat].ja, CAT_TITLE[cat].en)}</span>
        <span class="muted">${invIsStaff() ? '∞' : `${owned.filter(i => !i.adminOnly).length} / ${total}`}</span>
      </div>
      <div class="inv-grid"></div>
      ${missing > 0 && !invIsStaff()
        ? `<button class="btn btn-sm btn-ghost inv-more" data-shop-cat="${cat}">🛍️ ${tr(`ショップで見る（あと${missing}種）`, `See ${missing} more in the shop`)}</button>`
        : ''}`;
    const grid = sec.querySelector('.inv-grid');
    for (const item of owned) {
      const isEq = item.id === equippedId;
      const card = document.createElement('button');
      card.className = `inv-card ${isEq ? 'equipped' : ''}`;
      card.innerHTML = `<div class="inv-pv" data-pv="${item.id}"></div>
        <div class="inv-name">${item.adminOnly ? '👑 ' : ''}${catName(item)}</div>
        ${isEq ? `<div class="inv-eq">${tr('装備中', 'Equipped')}</div>` : ''}`;
      renderPreview(card.querySelector('.inv-pv'), item);
      card.onclick = () => { if (!isEq) equipItem(item); };
      grid.appendChild(card);
    }
    body.appendChild(sec);
  }
  body.querySelectorAll('[data-shop-cat]').forEach(b => {
    b.onclick = () => { audio.click(); openShop(b.dataset.shopCat); };
  });
}

function renderInvItems() {
  const body = $('#invBody');
  const u = session.user;
  const counts = u ? (u.items || {}) : guestItemCounts();
  const rows = shopBoosters.filter(i => !i.adminOnly || staffExtras());
  body.innerHTML = `
    <p class="muted center inv-note">${tr(
      'ゲーム中のHUDから使えます。<br><small>ソロ・ボス・ダンジョン・サバイバル・カオスで使用可（AI戦／オンライン／ウィークリーは公平のため対象外）</small>',
      'Use them from the in-game HUD.<br><small>Available in Solo, Boss, Dungeon, Survival and Chaos (disabled in AI / Online / Weekly for fairness)</small>')}</p>
    <div class="inv-items">
      ${rows.map(i => {
        const n = invIsStaff() ? '∞' : (counts[i.id] || 0);
        const zero = !invIsStaff() && !counts[i.id];
        return `<div class="inv-item ${zero ? 'off' : ''}">
          <span class="inv-item-icon">${i.icon}</span>
          <span class="inv-item-body">
            <b>${i.adminOnly ? '👑 ' : ''}${catName(i)}</b>
            <small>${catDesc(i)}</small>
          </span>
          <span class="inv-item-n">×${n}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="inv-links">
      <button class="btn btn-sm btn-ghost" id="invToShop">🛍️ ${tr('ショップで補充', 'Restock in the shop')}</button>
      <button class="btn btn-sm btn-ghost" id="invToGacha">🎰 ${tr('ガチャを引く', 'Pull the gacha')}</button>
    </div>`;
  $('#invToShop').onclick = () => { audio.click(); openShop('item'); };
  $('#invToGacha').onclick = () => { audio.click(); openGacha(); };
}

// ゲストのブースターは localStorage にある（modes.js が初回に1個ずつ配る）。
function guestItemCounts() {
  try { return JSON.parse(localStorage.getItem('bba_items') || '{}'); } catch { return {}; }
}

let invTitleFilter = 'all';
async function renderInvTitles() {
  const body = $('#invBody');
  if (!session.user) {
    body.innerHTML = `<p class="muted center">${tr('称号はアカウント登録すると集められます', 'Register an account to start collecting titles')}</p>`;
    return;
  }
  let data;
  try { data = await api('/api/titles'); } catch (err) { body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`; return; }
  const earned = new Set(data.earned || []);
  const list = data.titles.slice().sort((a, b) => (earned.has(b.id) ? 1 : 0) - (earned.has(a.id) ? 1 : 0));
  const shown = invTitleFilter === 'earned' ? list.filter(t => earned.has(t.id)) : list;
  body.innerHTML = `
    <div class="inv-sec-head">
      <span>👑 ${tr('称号', 'Titles')}</span>
      <span class="muted">${earned.size} / ${data.titles.length}</span>
    </div>
    <div class="seg" id="invTitleSeg" style="justify-content:center;margin-bottom:8px">
      <button data-v="all" class="${invTitleFilter === 'all' ? 'active' : ''}">${tr('すべて', 'All')}</button>
      <button data-v="earned" class="${invTitleFilter === 'earned' ? 'active' : ''}">${tr('獲得済みのみ', 'Earned only')}</button>
    </div>
    <div class="inv-titles">
      ${shown.map(t2 => {
        const has = earned.has(t2.id);
        const eq = data.equipped === t2.id;
        return `<button class="inv-title ${has ? '' : 'locked'} ${eq ? 'equipped' : ''}" data-title="${t2.id}" ${has ? '' : 'disabled'}>
          <span class="inv-title-name" style="color:${has ? escapeHtml(t2.color) : 'var(--dim)'}">《${escapeHtml(catName(t2))}》</span>
          <span class="inv-title-desc">${has ? (eq ? tr('装備中', 'Equipped') : tr('タップで装備', 'Tap to equip')) : `🔒 ${escapeHtml(catDesc(t2))}`}</span>
        </button>`;
      }).join('')}
    </div>`;
  body.querySelectorAll('#invTitleSeg button').forEach(b => {
    b.onclick = () => { invTitleFilter = b.dataset.v; renderInvTitles(); };
  });
  body.querySelectorAll('[data-title]').forEach(b => {
    b.onclick = async () => {
      audio.click();
      try {
        await api('/api/titles/equip', { method: 'POST', body: { titleId: b.dataset.title } });
        updateTopbar();
        toast(tr('👑 称号を変更しました', '👑 Title equipped'), 'ok');
        renderInvTitles();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

function renderInvBadges() {
  const body = $('#invBody');
  const u = session.user;
  const have = new Set(u ? (u.badges || []) : []);
  const thrones = (u && u.thrones) || [];
  body.innerHTML = `
    ${thrones.length ? `
      <div class="inv-thrones">
        <div class="inv-sec-head"><span>👑 ${tr('保持中の王座', 'Thrones you hold')}</span><span class="muted">${thrones.length} / 7</span></div>
        <div class="inv-throne-row">${thrones.map(b => `<span class="inv-throne">${tr(THRONE_LABEL[b] || b, THRONE_LABEL[b] || b)}</span>`).join('')}</div>
      </div>` : ''}
    <div class="inv-sec-head">
      <span>🎖️ ${tr('バッジ', 'Badges')}</span>
      <span class="muted">${invIsStaff() ? '👑' : `${[...have].filter(b => BADGE_INFO[b]).length} / ${BADGE_ORDER.length}`}</span>
    </div>
    <p class="muted center inv-note">${tr('解除条件つき。灰色はまだ持っていないバッジです', 'With unlock conditions — greyed badges are still locked')}</p>
    <div class="inv-badges">
      ${BADGE_ORDER.map(id => {
        const b = BADGE_INFO[id];
        const has = have.has(id);
        return `<div class="inv-badge ${has ? '' : 'locked'}">
          <span class="inv-badge-icon">${b.icon}</span>
          <span class="inv-badge-body">
            <b>${tr(b.ja, b.en)}</b>
            <small>${has ? `✅ ${tr('獲得済み', 'Earned')}` : tr(b.cja, b.cen)}</small>
          </span>
        </div>`;
      }).join('')}
    </div>`;
}

function renderPreview(el, item) {
  if (item.cat === 'skin') {
    const canvas = document.createElement('canvas');
    canvas.width = 168; canvas.height = 168;
    el.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const skin = getSkin(item.id);
    const colors = [1, 4, 6, 8];
    let i = 0;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) skin(ctx, c * 84, r * 84, 84, colors[i++], 1);
  } else if (item.cat === 'board') {
    const b = BOARDS[item.id];
    el.style.background = b ? `linear-gradient(160deg, ${b.bg[0]}, ${b.bg[1]})` : '#222';
    el.style.border = `1px solid ${b ? b.accent : '#555'}`;
    el.textContent = '▦';
    el.style.color = b ? b.accent : '#fff';
  } else if (item.cat === 'ult') {
    el.classList.add('ult-preview');
    el.style.setProperty('--ult-color', ultColor(item.id));
    el.textContent = item.icon || ultIcon(item.id);
  } else {
    const icons = { fx_default: '✨', fx_fireworks: '🎆', fx_thunder: '⚡', fx_sakura: '🌸', fx_bubble: '🫧', fx_star: '⭐', fx_flame: '🔥', fx_admin: '🌈' };
    el.textContent = icons[item.id] || '✨';
  }
}

async function buyItem(item) {
  if (!session.user) { showAuthModal(); return; }
  try {
    await api('/api/shop/buy', { method: 'POST', body: { itemId: item.id } });
    audio.coin();
    toast(tr(`${item.name} を購入しました！`, `Bought ${catName(item)}!`), 'ok');
    updateTopbar();
    renderShop();
  } catch (err) {
    audio.error();
    toast(err.message, 'err');
  }
}

// ---- Booster (consumable) shop tab ----

function renderBoosterShop() {
  const grid = $('#shopGrid');
  const u = session.user;
  grid.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'muted center';
  note.style.gridColumn = '1 / -1';
  note.textContent = tr('ソロ・ボス・ダンジョン・カオスで使える消費アイテム。ゲーム中のHUDから発動！', 'Consumables for Solo, Boss, Dungeon and Chaos. Activate them from the in-game HUD!');
  grid.appendChild(note);
  shopBoosters.forEach((item, idx) => {
    const count = u ? (u.items && u.items[item.id]) || 0 : null;
    const el = document.createElement('div');
    el.className = 'shop-item';
    el.style.animationDelay = `${Math.min(idx * 50, 400)}ms`;
    el.innerHTML = `
      <div class="shop-preview booster-preview">${item.icon}</div>
      <div class="shop-name">${catName(item)}${count !== null ? ` <span class="muted">×${fmt(count)}</span>` : ''}</div>
      <div class="shop-desc">${catDesc(item)}</div>
      <button class="btn btn-sm btn-gold" data-act="buy">🪙 ${fmt(item.price)}</button>
    `;
    grid.appendChild(el);
    el.querySelector('[data-act]').onclick = async () => {
      if (!session.user) { showAuthModal(); return; }
      try {
        await api('/api/items/buy', { method: 'POST', body: { itemId: item.id } });
        await refreshMe();
        audio.coin();
        toast(tr(`${item.icon} ${item.name} を購入しました！`, `Bought ${item.icon} ${catName(item)}!`), 'ok');
        updateTopbar();
        renderShop();
      } catch (err) {
        audio.error();
        toast(err.message, 'err');
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Capsule machine (gacha)
// ---------------------------------------------------------------------------

const RARITY_LABEL = { N: tr('ノーマル', 'Normal'), R: tr('レア', 'Rare'), SR: tr('スーパーレア', 'Super Rare'), SSR: tr('激レア', 'Ultra Rare'), UR: tr('超激レア', 'Legendary') };

export function openGacha() {
  if (!session.user) { showAuthModal(); return; }
  audio.click();
  const pityMax = 40;
  const m = showModal(`
    <h2>${tr('🎰 カプセルマシン', '🎰 Capsule Machine')}</h2>
    <p class="muted center" style="margin-bottom:4px">${tr('コインで回して お宝ゲット！', 'Spin with coins and win treasure!')}</p>
    <p class="center" style="margin-bottom:6px">${tr('所持コイン', 'Your coins')}: <b id="gcCoins">🪙 ${fmt(session.user.coins)}</b></p>
    <div class="gc-pity">
      <div class="gc-pity-head"><span>✨ ${tr('天井', 'Pity')}</span><b id="gcPityText">…</b></div>
      <div class="gc-pity-bar"><div id="gcPityFill" class="gc-pity-fill" style="width:0%"></div></div>
      <div class="gc-pity-head" style="margin-top:4px"><span>📚 ${tr('コレクション', 'Collection')}</span><b id="gcColText">…</b></div>
      <div class="gc-pity-bar"><div id="gcColFill" class="gc-pity-fill col" style="width:0%"></div></div>
    </div>
    <div id="gcResults" class="gacha-results"></div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="gcClose">${tr('閉じる', 'Close')}</button>
      <button class="btn btn-primary" id="gcPull1">${tr('1回 🪙500', '1 pull 🪙500')}</button>
      <button class="btn btn-gold" id="gcPull10">${tr('10連 🪙4,500', '10 pulls 🪙4,500')}<small style="display:block;font-size:9px">${tr('SR以上1枠確定', '1 SR+ guaranteed')}</small></button>
    </div>
    <p class="muted center" style="font-size:10px;margin-top:8px">${tr('N コイン 50% ・ R アイテム 22% ・ SR ジェム 15% ・ SSR スキン等 10% ・ UR ジェム150 3%', 'N Coins 50% ・ R Items 22% ・ SR Gems 15% ・ SSR Cosmetics 10% ・ UR 150 Gems 3%')}<br>${tr(`✨ ${pityMax}連以内にSSR以上が必ず出ます（天井） ・ 🌈 ガチャ限定装備はSSRからのみ入手`, `✨ SSR+ guaranteed within ${pityMax} pulls (pity) ・ 🌈 Gacha-exclusive gear drops only from SSR`)}<br>${tr('スキン等をコンプ済みの場合はジェムに変換されます', 'Duplicate cosmetics are converted to gems')}</p>`);
  m.querySelector('#gcClose').onclick = closeModal;
  const setBars = (pity, collection) => {
    if (pity) {
      const left = Math.max(0, pity.max - pity.count);
      m.querySelector('#gcPityText').textContent = tr(`SSR確定まで あと${left}連`, `${left} pulls to guaranteed SSR`);
      m.querySelector('#gcPityFill').style.width = `${Math.min(100, Math.round((pity.count / pity.max) * 100))}%`;
    }
    if (collection) {
      m.querySelector('#gcColText').textContent = `${collection.owned} / ${collection.total}`;
      m.querySelector('#gcColFill').style.width = `${Math.min(100, Math.round((collection.owned / collection.total) * 100))}%`;
    }
  };
  api('/api/gacha/info').then(d => setBars(d.pity, d.collection)).catch(() => {});
  const pull = async count => {
    const b1 = m.querySelector('#gcPull1'), b10 = m.querySelector('#gcPull10');
    b1.disabled = b10.disabled = true;
    try {
      const data = await api('/api/gacha', { method: 'POST', body: { count } });
      session.user = data.user;
      updateTopbar();
      m.querySelector('#gcCoins').textContent = `🪙 ${fmt(data.user.coins)}`;
      setBars(data.pity, data.collection);
      const box = m.querySelector('#gcResults');
      box.innerHTML = '';
      audio.coin();
      let bigWin = false, limited = false;
      data.results.forEach((r, i) => {
        const card = document.createElement('div');
        card.className = `gacha-card gr-${r.rarity} ${r.limited ? 'gc-limited' : ''}`;
        card.style.animationDelay = `${i * 120}ms`;
        const icon = r.type === 'coins' ? '🪙' : r.type === 'gems' ? '💎' : r.type === 'item' ? r.icon : r.cat === 'skin' ? '🧊' : r.cat === 'board' ? '🖼️' : '✨';
        const label = r.type === 'coins' ? tr(`コイン +${fmt(r.amount)}`, `Coins +${fmt(r.amount)}`)
          : r.type === 'gems' ? tr(`ジェム +${fmt(r.amount)}${r.complete ? '（コンプ済）' : ''}`, `Gems +${fmt(r.amount)}${r.complete ? ' (all collected)' : ''}`)
          : r.type === 'item' ? catName(r)
          : catName(r);
        card.innerHTML = `<span class="gc-rarity">${r.limited ? '🌈' : ''}${r.rarity}</span><span class="gc-icon">${icon}</span><span class="gc-label">${escapeHtml(label)}</span>`;
        box.appendChild(card);
        if (r.rarity === 'SSR' || r.rarity === 'UR') bigWin = true;
        if (r.limited) limited = true;
      });
      if (bigWin) { setTimeout(() => { audio.victory(); confettiBurst(limited ? 90 : 50); }, count * 120 + 300); }
      if (limited) setTimeout(() => toast(tr('🌈 ガチャ限定装備を引き当てた！！', '🌈 You pulled GACHA-EXCLUSIVE gear!!'), 'announce', 4000), count * 120 + 500);
    } catch (err) {
      audio.error();
      toast(err.message, 'err');
    }
    b1.disabled = b10.disabled = false;
  };
  m.querySelector('#gcPull1').onclick = () => pull(1);
  m.querySelector('#gcPull10').onclick = () => pull(10);
}

function confetti() { confettiBurst(50); }

// Equipping is reachable from BOTH the shop and the inventory, so redraw
// whichever screen the player is actually looking at — repainting the shop
// grid while the inventory is open left the old loadout on screen and made
// the tap look like it did nothing.
function afterEquip() {
  if (document.body.dataset.screen === 'inventory') openInventory();
  else renderShop();
}

async function equipItem(item) {
  // Guests can still pick an ultimate — the choice lives in localStorage.
  if (!session.user) {
    if (item.cat !== 'ult') return;
    setGuestUlt(item.id);
    audio.click();
    toast(tr(`${catName(item)} を装備しました`, `Equipped ${catName(item)}`), 'ok');
    afterEquip();
    return;
  }
  try {
    await api('/api/equip', { method: 'POST', body: { slot: item.cat, itemId: item.id } });
    audio.click();
    toast(tr(`${catName(item)} を装備しました`, `Equipped ${catName(item)}`), 'ok');
    afterEquip();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Missions (daily / weekly) + achievements
// ---------------------------------------------------------------------------

let msTab = 'daily';
let missionsCache = null;
let achCache = null;
let achCat = 'all';

function loginPrompt(what) {
  return `<div class="ms-empty">
      <p>${tr(`${what}はアカウント登録で解放されます`, `${what} unlock once you create an account`)}</p>
      <button class="btn btn-primary" id="msLogin">${tr('ログイン / 新規登録', 'Log in / Sign up')}</button>
    </div>`;
}

function rewardChip(coins, gems) {
  return `<span class="ms-reward">${coins ? `🪙${fmt(coins)}` : ''}${gems ? ` 💎${fmt(gems)}` : ''}</span>`;
}

function fmtResetIn(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), mnt = Math.floor((s % 3600) / 60);
  return h >= 1 ? tr(`${h}時間${mnt}分`, `${h}h ${mnt}m`) : tr(`${mnt}分`, `${mnt}m`);
}

export async function openMissions(tab = msTab) {
  showScreen('missions');
  msTab = tab;
  $$('[data-ms]').forEach(x => x.classList.toggle('active', x.dataset.ms === tab));
  const body = $('#msBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;

  if (tab === 'ach') {
    try {
      achCache = (await api('/api/achievements')).achievements;
    } catch (err) {
      body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
      return;
    }
    renderAchievements();
    return;
  }

  if (!session.user) {
    body.innerHTML = loginPrompt(tr('ミッション', 'Missions'));
    const b = body.querySelector('#msLogin');
    if (b) b.onclick = () => showAuthModal();
    return;
  }
  try {
    missionsCache = (await api('/api/missions')).missions;
  } catch (err) {
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderMissions();
}

function renderMissions() {
  const body = $('#msBody');
  const daily = msTab === 'daily';
  const data = missionsCache;
  const rows = daily ? data.daily : data.weekly;
  const bonus = daily ? data.dailyBonus : data.weeklyBonus;
  const bonusClaimed = daily ? data.dailyBonusClaimed : data.weeklyBonusClaimed;
  const allClaimed = rows.every(r => r.claimed);
  const doneCount = rows.filter(r => r.claimed).length;
  // 受け取りそびれたランキング報酬の入口（起動時のダイアログを閉じてもここから受け取れる）
  const rankPending = session.user && Array.isArray(session.user.rankRewards) ? session.user.rankRewards.length : 0;

  body.innerHTML = `
    ${rankPending ? `<button class="btn btn-gold" id="msRankRewards" style="width:100%;margin-bottom:10px">🏆 ${tr(`ランキング報酬が${rankPending}件届いています — タップで受け取る`, `${rankPending} ranking reward${rankPending > 1 ? 's' : ''} waiting — tap to claim`)}</button>` : ''}
    <div class="ms-head">
      <div>
        <b>${daily ? tr('デイリーミッション', 'Daily Missions') : tr('ウィークリーミッション', 'Weekly Missions')}</b>
        <div class="muted" style="font-size:12px">
          ${tr(`達成 ${doneCount} / ${rows.length}`, `Claimed ${doneCount} / ${rows.length}`)}
          ・ ${daily
            ? tr(`リセットまで ${fmtResetIn(data.dailyResetIn)}`, `Resets in ${fmtResetIn(data.dailyResetIn)}`)
            : tr('毎週月曜リセット', 'Resets every Monday')}
        </div>
      </div>
      <div class="ms-progress-ring">${Math.round((doneCount / Math.max(1, rows.length)) * 100)}%</div>
    </div>
    <div class="ms-list">
      ${rows.map(r => {
        const pct = Math.min(100, Math.round((r.progress / r.goal) * 100));
        return `
        <div class="ms-row ${r.claimed ? 'claimed' : r.done ? 'done' : ''}">
          <div class="ms-info">
            <div class="ms-name">${escapeHtml(tr(r.name, r.nameEn))}</div>
            <div class="ms-bar"><div style="width:${pct}%"></div></div>
            <div class="ms-prog">${fmt(r.progress)} / ${fmt(r.goal)}</div>
          </div>
          ${rewardChip(r.coins, r.gems)}
          ${r.claimed
            ? `<span class="ms-check">✓</span>`
            : `<button class="btn btn-sm ${r.done ? 'btn-gold' : 'btn-ghost'}" data-claim="${r.id}" ${r.done ? '' : 'disabled'}>${r.done ? tr('受取', 'Claim') : tr('未達成', 'Locked')}</button>`}
        </div>`;
      }).join('')}
      <div class="ms-row bonus ${bonusClaimed ? 'claimed' : allClaimed ? 'done' : ''}">
        <div class="ms-info">
          <div class="ms-name">🎁 ${tr('コンプリートボーナス', 'Completion Bonus')}</div>
          <div class="ms-prog">${tr('すべて受け取ると解放', 'Unlocks once every mission is claimed')}</div>
        </div>
        ${rewardChip(bonus.coins, bonus.gems)}
        ${bonusClaimed
          ? `<span class="ms-check">✓</span>`
          : `<button class="btn btn-sm ${allClaimed ? 'btn-gold' : 'btn-ghost'}" data-claim="${daily ? 'daily_bonus' : 'weekly_bonus'}" ${allClaimed ? '' : 'disabled'}>${tr('受取', 'Claim')}</button>`}
      </div>
    </div>`;

  const rk = body.querySelector('#msRankRewards');
  if (rk) rk.onclick = () => showRankRewardsModal(true);

  body.querySelectorAll('[data-claim]:not([disabled])').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const res = await api('/api/missions/claim', { method: 'POST', body: { id: btn.dataset.claim } });
        missionsCache = res.missions;
        audio.coin();
        confettiBurst(20);
        toast(tr(`🎁 報酬を受け取りました！ 🪙${fmt(res.reward.coins)}${res.reward.gems ? ` 💎${fmt(res.reward.gems)}` : ''}`,
          `🎁 Reward claimed! 🪙${fmt(res.reward.coins)}${res.reward.gems ? ` 💎${fmt(res.reward.gems)}` : ''}`), 'ok');
        updateTopbar();
        renderMissions();
        refreshMissionDot();
      } catch (err) {
        audio.error();
        toast(err.message, 'err');
        btn.disabled = false;
      }
    };
  });
}

function renderAchievements() {
  const body = $('#msBody');
  const data = achCache;
  const claimable = data.rows.filter(r => r.done && !r.claimed);
  const cats = [{ id: 'all', name: 'すべて', nameEn: 'All' }, ...data.cats];
  const rows = achCat === 'all' ? data.rows : data.rows.filter(r => r.cat === achCat);

  body.innerHTML = `
    <div class="ms-head">
      <div>
        <b>🏅 ${tr('実績', 'Achievements')}</b>
        <div class="muted" style="font-size:12px">${tr(`解除 ${data.unlocked} / ${data.total} ・ 受取済 ${data.claimedCount}`,
          `Unlocked ${data.unlocked} / ${data.total} ・ Claimed ${data.claimedCount}`)}</div>
      </div>
      ${claimable.length && session.user
        ? `<button class="btn btn-sm btn-gold" id="achAll">${tr(`✨ ${claimable.length}件まとめて受取`, `✨ Claim all (${claimable.length})`)}</button>`
        : `<div class="ms-progress-ring">${Math.round((data.unlocked / data.total) * 100)}%</div>`}
    </div>
    <div class="ach-cats">
      ${cats.map(c => `<button class="ach-cat ${achCat === c.id ? 'active' : ''}" data-cat="${c.id}">${tr(c.name, c.nameEn)}</button>`).join('')}
    </div>
    ${session.user ? '' : `<p class="muted center" style="margin-bottom:10px">${tr('💡 ログインすると進捗が記録され、報酬を受け取れます', '💡 Log in to track progress and claim rewards')}</p>`}
    <div class="ach-grid">
      ${rows.map(r => {
        const pct = Math.min(100, Math.round((r.progress / r.goal) * 100));
        return `
        <div class="ach-card ${r.claimed ? 'claimed' : r.done ? 'done' : 'locked'}">
          <div class="ach-icon">${r.done ? r.icon : '🔒'}</div>
          <div class="ach-name">${escapeHtml(tr(r.name, r.nameEn))}</div>
          <div class="ach-desc">${escapeHtml(tr(r.desc, r.descEn))}</div>
          <div class="ms-bar"><div style="width:${pct}%"></div></div>
          <div class="ach-foot">
            <span class="ms-prog">${fmt(r.progress)} / ${fmt(r.goal)}</span>
            ${rewardChip(r.coins, r.gems)}
          </div>
          ${r.claimed
            ? `<div class="ach-claimed">✓ ${tr('受取済', 'Claimed')}</div>`
            : r.done && session.user
              ? `<button class="btn btn-sm btn-gold" data-ach="${r.id}">${tr('受取', 'Claim')}</button>`
              : ''}
        </div>`;
      }).join('')}
    </div>`;

  body.querySelectorAll('[data-cat]').forEach(b => {
    b.onclick = () => { audio.click(); achCat = b.dataset.cat; renderAchievements(); };
  });
  const claim = async id => {
    try {
      const res = await api('/api/achievements/claim', { method: 'POST', body: { id } });
      achCache = res.achievements;
      audio.coin();
      confettiBurst(res.reward.ids.length > 1 ? 60 : 25);
      toast(tr(`🏅 実績${res.reward.ids.length}件！ 🪙${fmt(res.reward.coins)} 💎${fmt(res.reward.gems)}`,
        `🏅 ${res.reward.ids.length} achievement(s)! 🪙${fmt(res.reward.coins)} 💎${fmt(res.reward.gems)}`), 'ok', 3500);
      updateTopbar();
      renderAchievements();
      refreshMissionDot();
    } catch (err) {
      audio.error();
      toast(err.message, 'err');
    }
  };
  body.querySelectorAll('[data-ach]').forEach(b => { b.onclick = () => claim(b.dataset.ach); });
  const all = body.querySelector('#achAll');
  if (all) all.onclick = () => claim('*');
}

// 週間ランキング報酬の受け取りダイアログ（pending は /api/me が session.user
// に載せてくる — ログイン直後・週明けの起動時に出る）。閉じてしまっても
// ミッション画面のバナーからいつでも受け取れる。
export function showRankRewardsModal(force = false) {
  const pending = (session.user && session.user.rankRewards) || [];
  if (!pending.length) return;
  // 自動表示は他のモーダル（復元ダイアログ等）を奪わない。
  if (!force && $('#modal-root').querySelector('.modal')) return;
  const total = pending.reduce((a, r) => ({ coins: a.coins + (r.coins || 0), gems: a.gems + (r.gems || 0) }), { coins: 0, gems: 0 });
  const medal = r => r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '🎖️';
  const m = showModal(`
    <h2>🏆 ${tr('ランキング報酬', 'Ranking Rewards')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">${tr('週間チャレンジの最終結果が出ました！', 'The weekly challenge results are in!')}</p>
    <div class="rank-reward-list">
      ${pending.map(r => `
        <div class="rank-reward-row">
          <span><b>${medal(r)} ${tr(`${r.rank}位`, `#${r.rank}`)}</b> <small class="muted">/ ${r.of}${tr('人中', ' players')} ・ ${escapeHtml(r.week)} ・ ${fmt(r.best)}${tr('点', ' pts')}</small></span>
          <b>+${fmt(r.coins)}🪙 +${fmt(r.gems)}💎${r.badge ? ' +🏅' : ''}</b>
        </div>`).join('')}
    </div>
    <div class="modal-buttons">
      <button class="btn btn-primary" id="rkClaim">🎁 ${tr('受け取る', 'Claim')}（+${fmt(total.coins)}🪙 +${fmt(total.gems)}💎）</button>
      <button class="btn btn-ghost" id="rkLater">${tr('あとで', 'Later')}</button>
    </div>`);
  m.querySelector('#rkLater').onclick = closeModal;
  const claimBtn = m.querySelector('#rkClaim');
  claimBtn.onclick = async () => {
    claimBtn.disabled = true;   // ダブルタップで409トーストを出さない
    try {
      const res = await api('/api/rank/claim', { method: 'POST', body: {} });
      closeModal();
      audio.coin();
      confettiBurst(50);
      updateTopbar();
      toast(tr(`🏆 ランキング報酬を受け取りました！ +${fmt(res.reward.coins)}🪙 +${fmt(res.reward.gems)}💎${res.reward.badges.length ? '（🏅週間チャンピオン獲得！）' : ''}`,
        `🏆 Rewards claimed! +${fmt(res.reward.coins)}🪙 +${fmt(res.reward.gems)}💎${res.reward.badges.length ? ' (🏅 Weekly Champion!)' : ''}`), 'ok', 4500);
      const banner = $('#msRankRewards');
      if (banner) banner.remove();
      refreshMissionDot();
    } catch (err) {
      audio.error();
      toast(err.message, 'err');
      claimBtn.disabled = false;
    }
  };
}

// Red dot on the menu button whenever something is waiting to be claimed.
export async function refreshMissionDot() {
  const dot = $('#missionDot');
  if (!dot) return;
  if (!session.user) { dot.classList.add('hidden'); return; }
  try {
    const [ms, ach] = await Promise.all([
      api('/api/missions').then(d => d.missions).catch(() => null),
      api('/api/achievements').then(d => d.achievements).catch(() => null),
    ]);
    let pending = 0;
    if (ms) {
      pending += [...ms.daily, ...ms.weekly].filter(r => r.done && !r.claimed).length;
      if (ms.daily.every(r => r.claimed) && !ms.dailyBonusClaimed) pending++;
      if (ms.weekly.every(r => r.claimed) && !ms.weeklyBonusClaimed) pending++;
    }
    if (ach) pending += ach.rows.filter(r => r.done && !r.claimed).length;
    if (session.user && Array.isArray(session.user.rankRewards)) pending += session.user.rankRewards.length;
    dot.classList.toggle('hidden', pending === 0);
    dot.textContent = pending > 9 ? '9+' : String(pending || '');
  } catch {
    dot.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Battle pass
// ---------------------------------------------------------------------------

export async function openBattlePass() {
  showScreen('battlepass');
  const header = $('#bpHeader');
  const tiersEl = $('#bpTiers');
  header.innerHTML = `<p class="muted">${tr('読み込み中…', 'Loading…')}</p>`;
  tiersEl.innerHTML = '';
  let data;
  try {
    data = await api('/api/battlepass');
  } catch (err) {
    header.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderBattlePass(data);
}

function rewardLabel(r) {
  if (!r) return { icon: '—', label: '' };
  if (r.type === 'coins') return { icon: '🪙', label: fmt(r.amount) };
  if (r.type === 'gems') return { icon: '💎', label: fmt(r.amount) };
  if (r.type === 'badge') return { icon: { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈' }[r.id] || '🎖️', label: tr('バッジ', 'Badge') };
  const names = { skin_neon: 'ネオン', skin_candy: 'キャンディ', skin_gold: 'ゴールド', board_ocean: 'オーシャン', board_sunset: 'サンセット', fx_fireworks: '花火' };
  return { icon: '🎁', label: catName({ id: r.id, name: names[r.id] || tr('アイテム', 'Item') }) };
}

function renderBattlePass(data) {
  const header = $('#bpHeader');
  const tiersEl = $('#bpTiers');
  const prog = data.progress; // null for guests
  const xp = prog ? prog.xp : 0;
  const unlockedTier = Math.floor(xp / data.xpPerTier);
  const maxTier = data.tiers.length;
  const daysLeft = Math.max(0, Math.ceil((data.season.endsAt - Date.now()) / 86400000));
  const pct = Math.min(100, (xp / (maxTier * data.xpPerTier)) * 100);
  const inTier = xp - unlockedTier * data.xpPerTier;

  header.innerHTML = `
    <div class="bp-row">
      <h3>✨ ${escapeHtml(LANG === 'en' && data.season.nameEn ? data.season.nameEn : data.season.name)}</h3>
      <span class="muted" style="font-size:13px">${tr(`残り ${daysLeft}日`, `${daysLeft} days left`)}</span>
    </div>
    <div class="bp-xpbar"><div style="width:${pct}%"></div></div>
    <div class="bp-row">
      <span style="font-size:13px;font-weight:700">${tr('ティア', 'Tier')} ${Math.min(unlockedTier, maxTier)} / ${maxTier}
        <span class="muted">${tr(`（次まで ${unlockedTier >= maxTier ? '—' : fmt(data.xpPerTier - inTier) + ' XP'}）`, `(${unlockedTier >= maxTier ? '—' : fmt(data.xpPerTier - inTier) + ' XP'} to next)`)}</span></span>
      ${prog && !prog.premium
        ? `<button class="btn btn-sm btn-gold" id="bpBuyPremium">${tr(`💎 ${fmt(data.premiumPriceGems)} でプレミアム解放`, `Unlock Premium 💎 ${fmt(data.premiumPriceGems)}`)}</button>`
        : prog ? `<span style="color:var(--gold);font-weight:800">${tr('👑 プレミアム', '👑 Premium')}</span>`
        : `<span class="muted" style="font-size:12px">${tr('ログインで進行が有効になります', 'Log in to track your progress')}</span>`}
    </div>`;

  const buyBtn = $('#bpBuyPremium');
  if (buyBtn) buyBtn.onclick = async () => {
    try {
      await api('/api/battlepass/premium', { method: 'POST' });
      audio.levelUp();
      toast(tr('プレミアムパスを解放しました！', 'Premium pass unlocked!'), 'ok');
      updateTopbar();
      openBattlePass();
    } catch (err) { audio.error(); toast(err.message, 'err'); }
  };

  tiersEl.innerHTML = '';
  data.tiers.forEach((t, idx) => {
    const unlocked = prog && t.tier <= unlockedTier;
    const el = document.createElement('div');
    el.className = 'bp-tier';
    el.style.animationDelay = `${Math.min(idx * 30, 500)}ms`;
    const cell = (reward, track) => {
      if (!reward) return `<div class="bp-cell ${track === 'premium' ? 'premium-cell' : ''}" style="opacity:.25">—</div>`;
      const { icon, label } = rewardLabel(reward);
      const claimed = prog && prog.claimed.includes(`${t.tier}:${track}`);
      const claimable = unlocked && !claimed && (track === 'free' || (prog && prog.premium));
      return `
        <div class="bp-cell ${track === 'premium' ? 'premium-cell' : ''} ${!unlocked ? 'locked' : ''} ${claimed ? 'claimed' : ''}">
          <span class="rw-icon">${icon}</span><span>${label}</span>
          ${claimable ? `<button class="bp-claim-btn" data-tier="${t.tier}" data-track="${track}">${tr('受取', 'Claim')}</button>` : ''}
        </div>`;
    };
    el.innerHTML = `
      <div class="bp-tier-num ${unlocked ? 'unlocked' : ''}">${t.tier}</div>
      ${cell(t.free, 'free')}
      ${cell(t.premium, 'premium')}`;
    tiersEl.appendChild(el);
  });

  tiersEl.querySelectorAll('.bp-claim-btn').forEach(btn => {
    btn.onclick = async () => {
      try {
        const res = await api('/api/battlepass/claim', { method: 'POST', body: { tier: Number(btn.dataset.tier), track: btn.dataset.track } });
        audio.coin();
        const { icon, label } = rewardLabel(res.reward);
        toast(tr(`${icon} ${label} を受け取りました！`, `Claimed ${icon} ${label}!`), 'ok');
        updateTopbar();
        openBattlePass();
      } catch (err) { audio.error(); toast(err.message, 'err'); }
    };
  });
}

// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------

let adminStats = null;   // last loaded stats (for the maintenance toggle etc.)

export async function openAdmin() {
  showScreen('admin');
  const statsEl = $('#adminStats');
  const usersEl = $('#adminUsers');
  const isMod = session.user && session.user.role === 'mod';
  // Mods see a slim moderation panel — admin sections stay hidden.
  $$('#screen-admin .admin-actions').forEach(el =>
    el.classList.toggle('hidden', isMod && !el.querySelector('#adminUserSearch')));
  statsEl.innerHTML = '<p class="muted">読み込み中…</p>';
  usersEl.innerHTML = '';
  if (isMod) {
    try {
      const data = await api('/api/mod/users');
      statsEl.innerHTML = `
        <div class="stat-card"><b>🔧</b><span>モデレーター</span></div>
        <div class="stat-card"><b>${fmt(data.users.length)}</b><span>登録ユーザー</span></div>`;
      renderModUsers(data.users);
    } catch (err) {
      statsEl.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
    }
    return;
  }
  try {
    const [stats, usersData, txData] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/users'),
      api('/api/admin/transactions').catch(() => ({ totalCount: 0, totalJpy: 0 })),
    ]);
    adminStats = stats;
    statsEl.innerHTML = `
      <div class="stat-card"><b>${fmt(stats.totalUsers)}</b><span>登録ユーザー</span></div>
      <div class="stat-card"><b>${fmt(stats.online)}</b><span>実オンライン</span></div>
      <div class="stat-card"><b>${fmt(stats.displayOnline ?? stats.online)}</b><span>表示人数(AI込)</span></div>
      <div class="stat-card"><b>${fmt(stats.activeMatches)}</b><span>対戦中</span></div>
      <div class="stat-card"><b>${fmt(stats.openRooms || 0)}</b><span>ルーム</span></div>
      <div class="stat-card"><b>${fmt(stats.totalGames)}</b><span>総プレイ数</span></div>
      <div class="stat-card"><b>${fmt(stats.bannedUsers)}</b><span>凍結中</span></div>
      <div class="stat-card"><b>×${stats.popScale ?? 1}</b><span>にぎわい倍率</span></div>
      <div class="stat-card"><b>${fmt(stats.crowd ? stats.crowd.activeResidents : 0)}</b><span>住人オンライン</span></div>
      <div class="stat-card"><b>${stats.crowd ? ({ party: '🔥', busy: '🙂', calm: '😴', off: '⚫' }[stats.crowd.mood.id] || '🙂') : '🙂'}</b><span>${stats.crowd ? ({ party: '大盛況', busy: 'にぎやか', calm: 'まったり', off: 'オフ' }[stats.crowd.mood.id] || '') : ''}${stats.crowd && stats.crowd.quietNow ? '（静かな時間帯）' : ''}</span></div>
      <div class="stat-card"><b>S${stats.season.number}</b><span>${escapeHtml(stats.season.name)}</span></div>
      <div class="stat-card" style="${stats.maintenance ? 'border-color:var(--red)' : ''}"><b>${stats.maintenance ? '🛠' : '✅'}</b><span>${stats.maintenance ? 'メンテナンス中' : '稼働中'}</span></div>
      <div class="stat-card" style="${stats.sessionsPersist ? '' : 'border-color:var(--yellow)'}" title="SESSION_SECRET 環境変数が設定されているとON。更新してもログイン状態が維持されます"><b>${stats.sessionsPersist ? '🔐' : '⚠️'}</b><span>${stats.sessionsPersist ? 'セッション維持 ON' : 'セッション維持 OFF（SESSION_SECRET未設定）'}</span></div>
      <div class="stat-card"><b>¥${fmt(txData.totalJpy)}</b><span>売上(デモ) ${fmt(txData.totalCount)}件</span></div>`;
    $('#btnMaintenance').textContent = stats.maintenance ? '✅ メンテ解除' : '🛠 メンテナンス開始';
    renderAdminUsers(usersData.users);
  } catch (err) {
    statsEl.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

function showSeasonModal() {
  const season = adminStats ? adminStats.season : { number: 1, name: '', endsAt: Date.now() };
  const daysLeft = Math.max(1, Math.ceil((season.endsAt - Date.now()) / 86400000));
  const m = showModal(`
    <h2>🗓️ シーズン管理</h2>
    <p class="muted center" style="margin-bottom:12px">現在: ${escapeHtml(season.name)}（S${season.number}）</p>
    <div class="form-col">
      <div class="settings-row"><label>番号</label><input id="ssNum" type="number" min="1" max="999" value="${season.number}" style="width:80px;text-align:center"></div>
      <div class="settings-row"><label>名前</label><input id="ssName" type="text" maxlength="16" value="${escapeHtml(season.name)}" style="width:150px"></div>
      <div class="settings-row"><label>残り日数</label><input id="ssDays" type="number" min="1" max="365" value="${daysLeft}" style="width:80px;text-align:center"></div>
      <div class="settings-row"><label>🎫 全員のパス進行を維持する</label><input id="ssKeep" type="checkbox" checked></div>
      <p class="muted center" style="font-size:12px">維持ONなら番号や名前を変えても（例: S2→S1に戻しても）<br>バトルパスの進行はリセットされません</p>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="ssCancel">やめる</button>
        <button class="btn btn-primary" id="ssApply">適用する</button>
      </div>
    </div>`);
  m.querySelector('#ssCancel').onclick = closeModal;
  m.querySelector('#ssApply').onclick = async () => {
    try {
      const keep = m.querySelector('#ssKeep').checked;
      if (!keep && !confirm('パス進行を維持せず新シーズンとして開始します。全員のバトルパスがリセットされますが、よろしいですか？')) return;
      const res = await api('/api/admin/season/set', {
        method: 'POST',
        body: {
          number: Number(m.querySelector('#ssNum').value),
          name: m.querySelector('#ssName').value.trim(),
          days: Number(m.querySelector('#ssDays').value),
          keepProgress: keep,
        },
      });
      closeModal();
      toast(`${res.season.name}（S${res.season.number}）に設定しました${res.progressKept ? '（進行維持）' : ''}`, 'ok', 3000);
      openAdmin();
    } catch (err) { toast(err.message, 'err'); }
  };
}

// Moderator view: mute toggles + chat clear, nothing else.
function renderModUsers(users) {
  const usersEl = $('#adminUsers');
  const roleIcon = r => r === 'admin' ? '🛡️' : r === 'mod' ? '🔧' : '👤';
  usersEl.innerHTML = `
    <div class="admin-actions">
      <button class="btn btn-ghost btn-sm" id="modChatClear" style="color:var(--red)">🧹 チャット全消去</button>
    </div>` + users.map(u => `
    <div class="admin-user-row ${u.banned ? 'banned' : ''}" data-uid="${u.id}">
      <span class="au-name">${roleIcon(u.role)} ${escapeHtml(u.username)}</span>
      <span class="au-meta">${u.banned ? '⛔凍結中 ' : ''}${u.muted ? '🔇ミュート中' : ''}</span>
      <span class="au-actions">${u.role === 'user' ? `<button class="btn btn-sm btn-ghost" data-a="mute">${u.muted ? '🔈 解除' : '🔇 ミュート'}</button>` : ''}</span>
    </div>`).join('');
  $('#modChatClear').onclick = async () => {
    if (!confirm('全体チャットの履歴を全員分クリアします。よろしいですか？')) return;
    try {
      await api('/api/mod/chat/clear', { method: 'POST', body: {} });
      toast('🧹 チャットをクリアしました', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  usersEl.querySelectorAll('[data-a="mute"]').forEach(btn => {
    btn.onclick = async () => {
      const u = users.find(x => x.id === btn.closest('.admin-user-row').dataset.uid);
      try {
        await api('/api/mod/mute', { method: 'POST', body: { id: u.id, muted: !u.muted } });
        toast(!u.muted ? '🔇 ミュートしました' : '🔈 ミュートを解除しました', 'ok');
        openAdmin();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

function renderAdminUsers(users) {
  const usersEl = $('#adminUsers');
  usersEl.innerHTML = users
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(u => `
    <div class="admin-user-row ${u.banned ? 'banned' : ''}" data-uid="${u.id}">
      <span class="au-name">${u.role === 'admin' ? '🛡️' : u.role === 'mod' ? '🔧' : '👤'} ${escapeHtml(u.username)}${u.role === 'mod' ? ' <small style="color:var(--cyan)">MOD</small>' : ''}</span>
      <span class="au-meta">Lv.${u.level} ・ 🪙${fmt(u.coins)} ・ 💎${fmt(u.gems)} ・ 🏆${fmt(u.stats.bestScore)} ・ R${u.stats.rating}${u.banned ? ' ・ ⛔凍結中' : ''}${u.muted ? ' ・ 🔇ミュート中' : ''}</span>
      <span class="au-actions">
        <button class="btn btn-sm btn-ghost" data-a="edit" title="インベントリを編集（通貨・アイテム・所持品・バッジ・記録）">🎒編集</button>
        <button class="btn btn-sm btn-ghost" data-a="coins">+🪙</button>
        <button class="btn btn-sm btn-ghost" data-a="gems">+💎</button>
        <button class="btn btn-sm btn-ghost" data-a="rating" title="レートを設定">R</button>
        <button class="btn btn-sm btn-ghost" data-a="level" title="レベルを設定">Lv</button>
        <button class="btn btn-sm btn-ghost" data-a="badge" title="バッジを付与">🎖️</button>
        <button class="btn btn-sm btn-ghost" data-a="pass" title="パスワードを再設定">🔑</button>
        ${session.user && u.id !== session.user.id ? `<button class="btn btn-sm btn-ghost" data-a="role" title="権限を変更（admin/mod/user）">👤⚙</button>` : ''}
        ${u.role !== 'admin' ? `
          <button class="btn btn-sm btn-ghost" data-a="mute" title="チャット禁止の切替">${u.muted ? '🔈' : '🔇'}</button>
          <button class="btn btn-sm btn-ghost" data-a="ban">${u.banned ? '解除' : '凍結'}</button>
          <button class="btn btn-sm btn-ghost" data-a="del" style="color:var(--red)">削除</button>` : ''}
      </span>
    </div>`).join('');

  usersEl.querySelectorAll('.admin-user-row').forEach(row => {
    const uid = row.dataset.uid;
    const user = users.find(u => u.id === uid);
    row.querySelectorAll('[data-a]').forEach(btn => {
      btn.onclick = async () => {
        try {
          const act = btn.dataset.a;
          if (act === 'edit') {
            showUserEditor(uid);
            return;   // 編集画面が自分で保存・再描画する
          }
          if (act === 'coins' || act === 'gems') {
            const amount = promptAmount(act === 'coins' ? 'コイン付与額' : 'ジェム付与額');
            if (amount === null) return;
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: act === 'coins' ? { grantCoins: amount } : { grantGems: amount } });
            toast(`${user.username} に付与しました`, 'ok');
          } else if (act === 'rating') {
            const v = prompt(`${user.username} のレートを設定`, String(user.stats.rating));
            if (v === null) return;
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: { setRating: Math.floor(Number(v)) } });
            toast('レートを設定しました', 'ok');
          } else if (act === 'level') {
            const v = prompt(`${user.username} のレベルを設定`, String(user.level));
            if (v === null) return;
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: { setLevel: Math.floor(Number(v)) } });
            toast('レベルを設定しました', 'ok');
          } else if (act === 'role') {
            const role = prompt(
              `${user.username} の権限を変更\n・admin = 管理者（全機能）\n・mod = モデレーター（チャット監視・ミュート）\n・user = 一般`,
              user.role);
            if (!role) return;
            if (!['admin', 'mod', 'user'].includes(role)) { toast('admin / mod / user のいずれかで入力してください', 'err'); return; }
            if (role === 'admin' && !confirm(`${user.username} を管理者にします。全機能（配布・凍結・削除）が使えるようになりますが、よろしいですか？`)) return;
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: { role } });
            toast(role === 'admin' ? '🛡️ 管理者に任命しました' : role === 'mod' ? '🔧 モデレーターに任命しました' : '👤 一般ユーザーに戻しました', 'ok');
          } else if (act === 'badge') {
            const id = prompt(`${user.username} に付与するバッジID\n(bronze / silver / gold / oni / kami / souzou / maou / rush / dungeon / tourney)\n先頭に - で剥奪 (例: -gold)`, 'gold');
            if (!id) return;
            const body = id.startsWith('-') ? { revokeBadge: id.slice(1) } : { grantBadge: id };
            await api(`/api/admin/users/${uid}`, { method: 'POST', body });
            toast(id.startsWith('-') ? '🎖️ バッジを剥奪しました' : '🎖️ バッジを付与しました', 'ok');
          } else if (act === 'pass') {
            const pw = prompt(`${user.username} の新しいパスワード（6文字以上）\n※本人は全端末で再ログインが必要になります`, '');
            if (pw === null) return;
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: { setPassword: pw } });
            toast('🔑 パスワードを再設定しました', 'ok');
          } else if (act === 'mute') {
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: { muted: !user.muted } });
            toast(user.muted ? '🔈 ミュートを解除しました' : '🔇 チャットを禁止しました', 'ok');
          } else if (act === 'ban') {
            await api(`/api/admin/users/${uid}`, { method: 'POST', body: { banned: !user.banned } });
            toast(user.banned ? '凍結を解除しました' : 'アカウントを凍結しました', 'ok');
          } else if (act === 'del') {
            if (!confirm(`${user.username} を完全に削除しますか？`)) return;
            await api(`/api/admin/users/${uid}`, { method: 'DELETE' });
            toast('削除しました', 'ok');
          }
          openAdmin();
        } catch (err) { toast(err.message, 'err'); }
      };
    });
  });
}

// ---------------------------------------------------------------------------
// 🎒 インベントリ編集（管理者）
//
// 個別ボタン＋prompt() では「消えたアカウントを元に戻す」ような作業に耐えない
// ので、1画面で所持品ぜんぶを見て直接書き換えられるようにする。保存は1回の
// POST にまとめる（途中で失敗して中途半端な状態になるのを避けるため）。
// ---------------------------------------------------------------------------

const CAT_LABEL = { skin: '🧱 ブロックスキン', board: '🎨 ボードテーマ', fx: '✨ 消去エフェクト', ult: '⚡ アルティメット' };
const BADGE_LABEL = {
  bronze: '🥉ブロンズ', silver: '🥈シルバー', gold: '🥇ゴールド', oni: '👹鬼', kami: '🔱神',
  souzou: '🌌創造神', maou: '😈魔王', rush: '⚔️ラッシュ', dungeon: '🏰百塔', tourney: '🏆大会',
  royale: '💯ロイヤル', adminevent: '👑管理者イベント', abyss: '🌑深淵', weekly1: '🏅週間',
  puzzle: '🧩遺跡', dig: '⛏️採掘', crown2: '👑二冠', crown3: '👑三冠', crown5: '👑五冠',
  crown7: '🌈全冠', ghost: '👻幽霊屋敷',
};

export async function showUserEditor(uid) {
  let data;
  try {
    data = await api(`/api/admin/users/${uid}`);
  } catch (err) { toast(err.message, 'err'); return; }
  const u = data.user;
  const c = data.catalog;
  const owned = new Set(u.owned);

  const num = (id, label, value, hint = '') => `
    <div class="settings-row">
      <label>${escapeHtml(label)}${hint ? `<br><span class="muted" style="font-size:10px">${escapeHtml(hint)}</span>` : ''}</label>
      <input id="${id}" type="number" value="${value}" style="width:120px;text-align:right">
    </div>`;

  const byCat = cat => c.shop.filter(i => i.cat === cat);

  const m = showModal(`
    <h2>🎒 ${escapeHtml(u.username)}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">
      ${u.role === 'admin' ? '🛡️管理者' : u.role === 'mod' ? '🔧モデレーター' : '👤一般'}
      ・ 登録 ${new Date(u.createdAt).toLocaleDateString('ja-JP')}
      ${u.guildName ? ` ・ 🏰${escapeHtml(u.guildName)}` : ''}
      ${u.banned ? ' ・ ⛔凍結中' : ''}${u.muted ? ' ・ 🔇ミュート中' : ''}
    </p>
    ${u.role === 'admin' ? '<p class="ae-note">🛡️ 管理者は所持品も通貨も無制限として扱われるため、ここでの編集は表示上ほとんど意味がありません。</p>' : ''}

    <div class="ue-body">
      <h3 class="ue-h">💰 通貨・レベル</h3>
      ${num('ueCoins', '🪙 コイン', u.coins)}
      ${num('ueGems', '💎 ジェム', u.gems)}
      ${num('ueXp', '⭐ XP', u.xp, `いまは Lv.${u.level}（1000ごとに1レベル）`)}
      ${num('ueRating', '📈 レート', u.stats.rating || 1000)}

      <h3 class="ue-h">🎫 バトルパス</h3>
      ${num('uePassXp', 'パスXP', (u.battlePass && u.battlePass.xp) || 0)}
      <div class="settings-row">
        <label>プレミアム<br><span class="muted" style="font-size:10px">ジェムで購入した権利の復元用</span></label>
        <div class="seg" id="uePrem">
          <button type="button" data-v="1" class="${u.battlePass && u.battlePass.premium ? 'active' : ''}">ON</button>
          <button type="button" data-v="0" class="${u.battlePass && u.battlePass.premium ? '' : 'active'}">OFF</button>
        </div>
      </div>

      <h3 class="ue-h">🧪 アイテム（ブースター）</h3>
      <div class="ue-grid">
        ${c.boosters.filter(i => !i.adminOnly).map(i => `
          <label class="ue-item">
            <span>${i.icon} ${escapeHtml(i.name)}</span>
            <input type="number" data-item="${i.id}" value="${(u.items && u.items[i.id]) || 0}" min="0" max="999">
          </label>`).join('')}
      </div>

      <h3 class="ue-h">🎨 所持品</h3>
      ${c.slots.map(cat => `
        <div class="ue-cat">
          <div class="ue-cat-head">
            <span>${CAT_LABEL[cat] || cat}</span>
            <span>
              <button type="button" class="btn btn-sm btn-ghost" data-all="${cat}">全部</button>
              <button type="button" class="btn btn-sm btn-ghost" data-none="${cat}">なし</button>
            </span>
          </div>
          <div class="ue-grid">
            ${byCat(cat).map(i => `
              <label class="ue-own${i.adminOnly ? ' staff' : ''}">
                <input type="checkbox" data-own="${i.id}" data-cat="${cat}" ${owned.has(i.id) ? 'checked' : ''}>
                <span>${i.icon ? i.icon + ' ' : ''}${escapeHtml(i.name)}</span>
              </label>`).join('')}
          </div>
          <div class="settings-row">
            <label>装備中</label>
            <select data-eq="${cat}" style="font-family:inherit;padding:5px 8px;border-radius:8px;max-width:180px">
              ${byCat(cat).map(i => `<option value="${i.id}" ${u.equipped[cat] === i.id ? 'selected' : ''}>${escapeHtml(i.name)}</option>`).join('')}
            </select>
          </div>
        </div>`).join('')}

      <h3 class="ue-h">👑 称号</h3>
      <div class="settings-row">
        <label>装備中の称号</label>
        <select id="ueTitle" style="font-family:inherit;padding:5px 8px;border-radius:8px;max-width:200px">
          <option value="">（なし）</option>
          ${c.titles.map(t2 => `<option value="${t2.id}" ${u.equippedTitle === t2.id ? 'selected' : ''}>${escapeHtml(t2.name)}</option>`).join('')}
        </select>
      </div>

      <h3 class="ue-h">🎖️ バッジ</h3>
      <div class="ue-grid">
        ${c.badges.map(id => `
          <label class="ue-own">
            <input type="checkbox" data-badge="${id}" ${u.badges.includes(id) ? 'checked' : ''}>
            <span>${escapeHtml(BADGE_LABEL[id] || id)}</span>
          </label>`).join('')}
      </div>

      <h3 class="ue-h">📊 記録</h3>
      ${c.stats.map(s => num(`ueSt_${s.key}`, s.label, (u.stats && u.stats[s.key]) || 0)).join('')}
    </div>

    <div class="modal-buttons">
      <button class="btn btn-ghost" id="ueCancel">とじる</button>
      <button class="btn btn-gold" id="ueSave">保存する</button>
    </div>`);

  // 「全部 / なし」— 復旧作業のときに一番よく使う操作。
  m.querySelectorAll('[data-all]').forEach(btn => {
    btn.onclick = () => m.querySelectorAll(`[data-cat="${btn.dataset.all}"]`).forEach(cb => { cb.checked = true; });
  });
  m.querySelectorAll('[data-none]').forEach(btn => {
    btn.onclick = () => m.querySelectorAll(`[data-cat="${btn.dataset.none}"]`).forEach(cb => { cb.checked = false; });
  });

  // プレミアムのトグル
  let premium = !!(u.battlePass && u.battlePass.premium);
  m.querySelectorAll('#uePrem button').forEach(btn => {
    btn.onclick = () => {
      m.querySelectorAll('#uePrem button').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      premium = btn.dataset.v === '1';
      markDirty('pass');
    };
  });

  // 触った項目だけ送る。全項目を毎回送ると、入力を空にしただけの欄が 0 として
  // 保存され、本人の記録を消してしまう（setOwned/setBadges は「全置換」なので
  // なおさら危ない）。
  const dirty = new Set();
  const markDirty = key => dirty.add(key);
  m.querySelectorAll('#ueCoins, #ueGems, #ueXp').forEach(el => { el.oninput = () => markDirty(el.id); });
  m.querySelector('#uePassXp').oninput = () => markDirty('pass');
  m.querySelector('#ueRating').oninput = () => markDirty('stats');
  m.querySelectorAll('[data-item]').forEach(el => { el.oninput = () => markDirty('items'); });
  m.querySelectorAll('[data-own]').forEach(el => { el.onchange = () => markDirty('owned'); });
  m.querySelectorAll('[data-badge]').forEach(el => { el.onchange = () => markDirty('badges'); });
  m.querySelectorAll('[data-eq]').forEach(el => { el.onchange = () => markDirty('equipped'); });
  m.querySelector('#ueTitle').onchange = () => markDirty('title');
  c.stats.forEach(s => {
    const el = m.querySelector(`#ueSt_${s.key}`);
    if (el) el.oninput = () => markDirty('stats');
  });
  // 「全部 / なし」も変更として扱う
  m.querySelectorAll('[data-all], [data-none]').forEach(btn => {
    btn.addEventListener('click', () => markDirty('owned'));
  });

  m.querySelector('#ueCancel').onclick = closeModal;
  m.querySelector('#ueSave').onclick = async () => {
    if (!dirty.size) { toast('変更がありません', '', 1800); return; }
    const int = id => Math.floor(Number(m.querySelector(`#${id}`).value) || 0);
    const body = {};
    if (dirty.has('ueCoins')) body.setCoins = int('ueCoins');
    if (dirty.has('ueGems')) body.setGems = int('ueGems');
    if (dirty.has('ueXp')) body.setXp = int('ueXp');
    if (dirty.has('pass')) body.setPass = { xp: int('uePassXp'), premium };
    if (dirty.has('title')) body.setTitle = m.querySelector('#ueTitle').value || null;
    if (dirty.has('items')) {
      body.setItems = {};
      m.querySelectorAll('[data-item]').forEach(el => { body.setItems[el.dataset.item] = Math.floor(Number(el.value) || 0); });
    }
    if (dirty.has('badges')) {
      body.setBadges = [...m.querySelectorAll('[data-badge]')].filter(el => el.checked).map(el => el.dataset.badge);
    }
    if (dirty.has('owned') || dirty.has('equipped')) {
      const owned = [...m.querySelectorAll('[data-own]')].filter(el => el.checked).map(el => el.dataset.own);
      const equipped = {};
      m.querySelectorAll('[data-eq]').forEach(el => { equipped[el.dataset.eq] = el.value; });
      // 装備は所持していないと弾かれるので、選んだ装備は自動で所持に含める。
      for (const id of Object.values(equipped)) if (!owned.includes(id)) owned.push(id);
      body.setOwned = owned;
      body.setEquipped = equipped;
    }
    if (dirty.has('stats')) {
      body.setStats = { rating: int('ueRating') };
      for (const s of c.stats) {
        if (s.key === 'rating') continue;
        body.setStats[s.key] = Math.floor(Number(m.querySelector(`#ueSt_${s.key}`).value) || 0);
      }
    }
    try {
      await api(`/api/admin/users/${uid}`, { method: 'POST', body });
      toast(`🎒 ${u.username} を保存しました`, 'ok', 3000);
      closeModal();
      openAdmin();
    } catch (err) {
      toast(err.message, 'err', 4500);
    }
  };
}

function promptAmount(label) {
  const v = prompt(`${label}（マイナスで没収）`, '100');
  if (v === null) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) { toast('数値を入力してください', 'err'); return null; }
  return n;
}

// ---------------------------------------------------------------------------
// Data restore (admin): upload a backup file, or roll back to a snapshot
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

// 🐛 管理者用バグ報告ビューア — プレイヤーからの報告を確認・処理・削除。
async function showBugReportsAdminModal() {
  let reports = [];
  try {
    reports = (await api('/api/admin/bugreports')).reports || [];
  } catch (err) { toast(err.message, 'err'); return; }
  const row = b => `
    <div class="feed-row ${b.status === 'done' ? '' : 'real'}" data-bug="${b.id}" style="align-items:flex-start">
      <span class="feed-icon">${b.status === 'done' ? '✅' : '🐛'}</span>
      <span class="feed-text" style="white-space:pre-wrap">${escapeHtml(b.text)}
        <small class="muted" style="display:block;margin-top:2px">${escapeHtml(b.by)}${b.role === 'guest' ? '（ゲスト）' : ''} ・ ${new Date(b.at).toLocaleString('ja-JP')}</small></span>
      <span style="display:flex;flex-direction:column;gap:4px">
        ${b.status === 'done' ? '' : `<button class="btn btn-sm btn-ghost" data-done="${b.id}">✅</button>`}
        <button class="btn btn-sm btn-ghost" data-del="${b.id}" style="color:var(--red)">🗑</button>
      </span>
    </div>`;
  const open = reports.filter(b => b.status !== 'done').length;
  const m = showModal(`
    <h2>🐛 バグ報告（未処理 ${open} / 全 ${reports.length}）</h2>
    <div class="feed-list" style="max-height:52vh">
      ${reports.length ? reports.map(row).join('') : '<p class="muted center">報告はまだありません</p>'}
    </div>
    <div class="modal-buttons"><button class="btn btn-primary" id="bugAdmClose">閉じる</button></div>`);
  m.querySelector('#bugAdmClose').onclick = closeModal;
  m.querySelectorAll('[data-done]').forEach(b => {
    b.onclick = async () => {
      try { await api(`/api/admin/bugreports/${b.dataset.done}`, { method: 'POST', body: { status: 'done' } }); closeModal(); showBugReportsAdminModal(); }
      catch (err) { toast(err.message, 'err'); }
    };
  });
  m.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      try { await api(`/api/admin/bugreports/${b.dataset.del}`, { method: 'DELETE' }); closeModal(); showBugReportsAdminModal(); }
      catch (err) { toast(err.message, 'err'); }
    };
  });
}

export async function showRestoreModal() {
  const isAdmin = !!session.user && session.user.role === 'admin';

  const m = showModal(`
    <h2>♻️ データ復元</h2>
    <p class="muted center" style="margin-bottom:10px;font-size:12px">
      バックアップJSONを読み込んでプレイヤーデータを復旧します。<br>
      <b style="color:var(--green)">マージ</b>＝復元後に登録した人も残す（推奨）／
      <b style="color:var(--red)">置き換え</b>＝現在のデータを破棄してファイルの内容にする
    </p>
    <div class="form-col">
      <div class="settings-row"><label>復元方法</label><div class="seg" id="rsMode">
        <button data-v="merge" class="active">マージ（安全）</button>
        <button data-v="replace">置き換え</button>
      </div></div>
      <div class="settings-row"><label>読み込み方法</label><div class="seg" id="rsSrc">
        <button data-v="file" class="active">📁 ファイル</button>
        <button data-v="paste">📋 貼り付け</button>
      </div></div>
      <input type="file" id="rsFile">
      <textarea id="rsPaste" rows="4" class="hidden" placeholder="バックアップJSONの中身をここに貼り付け"></textarea>
      ${isAdmin ? '' : `
      <input id="rsPass" type="password" placeholder="バックアップ時点の管理者パスワード" autocomplete="current-password">
      <p class="muted" style="font-size:11px;margin-top:-4px">ログインしていなくてもOK：ファイル内の管理者アカウントのパスワードで本人確認します。復元後はそのアカウントで自動ログインします</p>`}
      <div id="rsInfo" class="center" style="font-size:12px;min-height:34px;color:var(--muted)">① まずバックアップを読み込んでください</div>
      <div class="form-error" id="rsError"></div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rsClose">やめる</button>
        <button class="btn btn-primary" id="rsApply" disabled>♻️ 復元する</button>
      </div>
    </div>
    <div id="rsSnaps"></div>`);

  let mode = 'merge';
  let payload = null;
  let armed = false;
  let armTimer = null;
  const err = m.querySelector('#rsError');
  const info = m.querySelector('#rsInfo');
  const apply = m.querySelector('#rsApply');
  const fail = msg => { err.textContent = msg; toast(msg, 'err', 3500); audio.error(); };

  m.querySelectorAll('#rsMode button').forEach(b => {
    b.onclick = () => {
      m.querySelectorAll('#rsMode button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.v;
    };
  });
  m.querySelectorAll('#rsSrc button').forEach(b => {
    b.onclick = () => {
      m.querySelectorAll('#rsSrc button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      m.querySelector('#rsFile').classList.toggle('hidden', b.dataset.v !== 'file');
      m.querySelector('#rsPaste').classList.toggle('hidden', b.dataset.v !== 'paste');
    };
  });
  m.querySelector('#rsClose').onclick = closeModal;

  // Accept a parsed backup from either source; validate locally first so the
  // button comes alive immediately, then ask the server for a preview.
  const loaded = async (obj, label) => {
    err.textContent = '';
    payload = null;
    if (!obj || typeof obj !== 'object' || !obj.users || typeof obj.users !== 'object') {
      apply.disabled = true;
      fail('バックアップの形式ではありません（users が見つかりません）');
      return;
    }
    const n = Object.keys(obj.users).length;
    if (!n) { apply.disabled = true; fail('ユーザーが0件のファイルです'); return; }
    payload = obj;
    payloadLabel = `<b>${fmt(n)}人</b>のアカウント（${escapeHtml(label)}）`;
    apply.disabled = false;
    verify();
  };
  const passValue = () => { const el = m.querySelector('#rsPass'); return el ? el.value : undefined; };
  let payloadLabel = '';

  // Ask the server to check the file (and, when logged out, the password).
  const verify = async () => {
    if (!payload) return;
    if (!isAdmin && !passValue()) {
      info.innerHTML = `② 読み込みOK：${payloadLabel}<br>③ 管理者パスワードを入力して「♻️ 復元する」を押してください`;
      return;
    }
    info.innerHTML = `② 読み込みOK：${payloadLabel}<br><span class="muted">サーバーで検証中…</span>`;
    try {
      const res = await api('/api/admin/restore', { method: 'POST', body: { data: payload, mode, dryRun: true, password: passValue() } });
      const p = res.preview;
      info.innerHTML = `✅ 検証OK：<b>${fmt(p.users)}人</b>（管理者${p.admins}人）・取引${fmt(p.transactions)}件${p.savedAt ? `<br>取得日時: ${new Date(p.savedAt).toLocaleString('ja-JP')}` : ''}<br>③「♻️ 復元する」を押してください`;
    } catch (e) {
      // Server-side validation failed (wrong password, bad file): say so, but
      // the button stays enabled — the real request will report the same error.
      info.innerHTML = `② 読み込みOK：${payloadLabel}<br><span style="color:var(--red)">サーバー検証: ${escapeHtml(e.message)}</span>`;
    }
  };
  const passEl = m.querySelector('#rsPass');
  if (passEl) passEl.onchange = verify;

  m.querySelector('#rsFile').onchange = async ev => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    info.textContent = 'ファイルを読み込み中…';
    let text;
    try {
      text = await (file.text ? file.text() : new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ng; r.readAsText(file); }));
    } catch { fail('ファイルを読み取れませんでした。「📋 貼り付け」をお試しください'); return; }
    let obj;
    try { obj = JSON.parse(text); } catch { fail('JSONとして読み取れませんでした'); return; }
    loaded(obj, `${file.name} ・ ${fmtBytes(file.size)}`);
  };
  m.querySelector('#rsPaste').oninput = ev => {
    const text = ev.target.value.trim();
    if (!text) return;
    let obj;
    try { obj = JSON.parse(text); } catch { info.textContent = '貼り付け中…（JSONの途中）'; return; }
    loaded(obj, `貼り付け ・ ${fmtBytes(text.length)}`);
  };

  // Two-press confirmation — no browser dialogs, which some browsers block.
  apply.onclick = async () => {
    if (!payload) { fail('先にバックアップを読み込んでください'); return; }
    if (!isAdmin && !passValue()) { fail('管理者パスワードを入力してください'); return; }
    if (!armed) {
      armed = true;
      apply.textContent = mode === 'replace' ? '⚠️ もう一度押すと置き換えます' : '✅ もう一度押すと復元します';
      apply.classList.add('btn-gold');
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = false; apply.textContent = '♻️ 復元する'; apply.classList.remove('btn-gold'); }, 6000);
      return;
    }
    armed = false;
    clearTimeout(armTimer);
    apply.disabled = true;
    apply.textContent = '復元中…';
    info.textContent = '復元中…（大きいファイルは少し時間がかかります）';
    try {
      const res = await api('/api/admin/restore', { method: 'POST', body: { data: payload, mode, password: passValue() } });
      const r = res.report;
      if (res.token) {
        setToken(res.token);
        session.user = res.user;
        updateTopbar();
        reconnectChat();
      }
      closeModal();
      audio.coin();
      confettiBurst(40);
      toast(`♻️ 復元完了！ 追加${r.added}人 / 更新${r.updated}人 / 維持${r.kept}人 → 合計${fmt(r.after)}人`, 'ok', 6000);
      await refreshMe().catch(() => {});
      updateTopbar();
      if (session.user && session.user.role === 'admin') openAdmin();
    } catch (e) {
      apply.disabled = false;
      apply.textContent = '♻️ 復元する';
      apply.classList.remove('btn-gold');
      info.textContent = '';
      fail(e.message || '復元に失敗しました');
    }
  };

  // Snapshots are an admin-only extra; load them after the modal is up so a
  // slow request can never keep the dialog from opening.
  if (isAdmin) {
    api('/api/admin/snapshots').then(({ snapshots }) => {
      if (!snapshots.length || !m.isConnected) return;
      const box = m.querySelector('#rsSnaps');
      box.innerHTML = `
        <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
        <p class="muted center" style="font-size:12px;margin-bottom:8px">📸 このサーバーのスナップショット（起動時・復元前に自動保存／再デプロイで消えます）</p>
        <div class="ms-list" style="max-height:190px;overflow-y:auto">
          ${snapshots.map(s => `
            <div class="ms-row">
              <div class="ms-info">
                <div class="ms-name" style="font-size:12px">${escapeHtml(s.name)}</div>
                <div class="ms-prog">${new Date(s.at).toLocaleString('ja-JP')} ・ ${fmtBytes(s.size)}</div>
              </div>
              <button class="btn btn-sm btn-ghost" data-snap="${escapeHtml(s.name)}">巻き戻す</button>
            </div>`).join('')}
        </div>
        <div class="modal-buttons" style="margin-top:12px">
          <button class="btn btn-sm btn-ghost" id="rsSnapNow">📸 いまスナップショットを作る</button>
        </div>`;
      box.querySelectorAll('[data-snap]').forEach(b => {
        let armedSnap = false;
        b.onclick = async () => {
          if (!armedSnap) { armedSnap = true; b.textContent = 'もう一度押す'; setTimeout(() => { armedSnap = false; b.textContent = '巻き戻す'; }, 6000); return; }
          try {
            const res = await api('/api/admin/snapshots/restore', { method: 'POST', body: { name: b.dataset.snap } });
            closeModal();
            toast(`♻️ 巻き戻しました（${fmt(res.report.after)}人）`, 'ok', 5000);
            await refreshMe().catch(() => {});
            updateTopbar();
            openAdmin();
          } catch (e) { fail(e.message); }
        };
      });
      box.querySelector('#rsSnapNow').onclick = async () => {
        try {
          await api('/api/admin/snapshots/create', { method: 'POST', body: {} });
          toast('📸 スナップショットを作成しました', 'ok');
          closeModal();
          showRestoreModal();
        } catch (e) { fail(e.message); }
      };
    }).catch(() => { /* no snapshots yet */ });
  }
}

export function bindAdminActions() {
  $('#btnBroadcast').onclick = async () => {
    const message = $('#adminMsg').value.trim();
    if (!message) return;
    try {
      const res = await api('/api/admin/broadcast', { method: 'POST', body: { message } });
      $('#adminMsg').value = '';
      toast(`${res.delivered}人に配信しました`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnSeasonManage').onclick = () => showSeasonModal();

  $('#btnMaintenance').onclick = async () => {
    const turningOn = !(adminStats && adminStats.maintenance);
    if (!confirm(turningOn
      ? 'メンテナンスモードを開始しますか？一般ユーザーのプレイ・ログインがブロックされます。'
      : 'メンテナンスモードを終了しますか？')) return;
    try {
      await api('/api/admin/maintenance', { method: 'POST', body: { on: turningOn } });
      toast(turningOn ? '🛠 メンテナンスを開始しました' : '✅ メンテナンスを終了しました', 'ok');
      openAdmin();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnBackup').onclick = async () => {
    try {
      const res = await fetch('/api/admin/backup', {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!res.ok) throw new Error('バックアップに失敗しました');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `block-blitz-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('💾 バックアップをダウンロードしました', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnRestore').onclick = () => showRestoreModal();
  $('#btnBugReports').onclick = () => { audio.click(); showBugReportsAdminModal(); };
  $('#btnPoll').onclick = () => { audio.click(); showPollAdminModal(); };

  const selfGrant = async (kind) => {
    const amount = promptAmount(kind === 'coins' ? '自分に付与するコイン数' : '自分に付与するジェム数');
    if (amount === null) return;
    try {
      await api(`/api/admin/users/${session.user.id}`, {
        method: 'POST',
        body: kind === 'coins' ? { grantCoins: amount } : { grantGems: amount },
      });
      await refreshMe();
      updateTopbar();
      audio.coin();
      toast(`${kind === 'coins' ? '💰' : '💎'} ${fmt(amount)} を付与しました`, 'ok');
      openAdmin();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnSelfCoins').onclick = () => selfGrant('coins');
  $('#btnSelfGems').onclick = () => selfGrant('gems');

  $('#btnSelfItems').onclick = async () => {
    const amount = promptAmount('各ブースターを何個付与しますか？（マイナスで没収）');
    if (amount === null) return;
    try {
      await api(`/api/admin/users/${session.user.id}`, { method: 'POST', body: { grantItems: amount } });
      await refreshMe();
      updateTopbar();
      audio.coin();
      toast(`🧪 💣🧹⭐ を各${fmt(amount)}個付与しました`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnWeeklyReset').onclick = async () => {
    if (!confirm('全ユーザーの今週のウィークリーチャレンジ記録を削除します。よろしいですか？')) return;
    try {
      const res = await api('/api/admin/weekly/reset', { method: 'POST', body: {} });
      toast(`🎯 ${res.affected}人のウィークリー記録をリセットしました`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnMissionsDone').onclick = async () => {
    try {
      await api('/api/admin/missions/complete', { method: 'POST', body: {} });
      audio.coin();
      toast('📋 自分のデイリー／ウィークリーを全達成にしました（受け取りはミッション画面から）', 'ok', 3500);
      refreshMissionDot();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnAchReset').onclick = async () => {
    if (!confirm('自分の実績の「受け取り済み」記録を消去します。よろしいですか？')) return;
    try {
      await api('/api/admin/achievements/reset', { method: 'POST', body: {} });
      toast('🏅 実績の受け取り記録をリセットしました', 'ok');
      refreshMissionDot();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnUnlockHidden').onclick = () => {
    localStorage.setItem('bba_kami', '1');
    localStorage.setItem('bba_souzou', '1');
    audio.kamiDescend();
    toast('🔓 「神」「創造神」を解放しました（この端末のみ）', 'announce', 3500);
  };

  $('#btnEvent').onclick = () => showEventModal();
  $('#btnAdminEvent').onclick = () => showAdminEventModal();

  // ---- user search filter ----
  $('#adminUserSearch').oninput = () => {
    const q = $('#adminUserSearch').value.trim().toLowerCase();
    $$('#adminUsers .admin-user-row').forEach(row => {
      row.classList.toggle('hidden', q !== '' && !row.querySelector('.au-name').textContent.toLowerCase().includes(q));
    });
  };

  // ---- gift to everyone ----
  $('#btnGrantAll').onclick = () => {
    const m = showModal(`
      <h2>🎁 全員に配布</h2>
      <p class="muted center" style="margin-bottom:10px">凍結中を除く全アカウントに一斉配布します。<br>全員へのお知らせも自動送信されます。</p>
      <div class="form-col">
        <div class="settings-row"><label>🪙 コイン</label><input id="gaCoins" type="number" min="0" max="1000000" value="500" style="width:110px;text-align:center"></div>
        <div class="settings-row"><label>💎 ジェム</label><input id="gaGems" type="number" min="0" max="100000" value="0" style="width:110px;text-align:center"></div>
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="gaCancel">やめる</button>
          <button class="btn btn-gold" id="gaSend">🎁 配布する！</button>
        </div>
      </div>`);
    m.querySelector('#gaCancel').onclick = closeModal;
    m.querySelector('#gaSend').onclick = async () => {
      const coins = Math.max(0, Math.floor(Number(m.querySelector('#gaCoins').value) || 0));
      const gems = Math.max(0, Math.floor(Number(m.querySelector('#gaGems').value) || 0));
      if (!coins && !gems) { toast('コインかジェムを入力してください', 'err'); return; }
      if (!confirm(`全員に ${coins ? `${fmt(coins)}🪙 ` : ''}${gems ? `${fmt(gems)}💎` : ''} を配布します。よろしいですか？`)) return;
      try {
        const res = await api('/api/admin/grant-all', { method: 'POST', body: { coins, gems } });
        closeModal();
        audio.coin();
        toast(`🎁 ${res.affected}人に配布しました！`, 'ok', 3000);
        openAdmin();
      } catch (err) { toast(err.message, 'err'); }
    };
  };

  // ---- crowd (にぎわい) controls: scale + chattiness + custom AI ----
  $('#btnPop').onclick = () => { audio.click(); showCrowdModal(); };

  $('#btnChatSay').onclick = async () => {
    const text = prompt('AIプレイヤーに発言させる内容（空欄でランダム）', '');
    if (text === null) return;
    try {
      const res = await api('/api/admin/chat/say', { method: 'POST', body: { text } });
      toast(`💬 ${res.from}「${res.text}」`, 'ok', 3000);
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnChatClear').onclick = async () => {
    if (!confirm('全体チャットの履歴を全員分クリアします。よろしいですか？')) return;
    try {
      await api('/api/admin/chat/clear', { method: 'POST', body: {} });
      toast('🧹 チャットをクリアしました', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnLbReset').onclick = async () => {
    if (!confirm('全ユーザーのハイスコア・レート・PvP戦績をリセットします。よろしいですか？')) return;
    try {
      const res = await api('/api/admin/leaderboard/reset', { method: 'POST', body: {} });
      toast(`🏆 ${res.affected}人の戦績をリセットしました`, 'ok');
      openAdmin();
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}


// ---------------------------------------------------------------------------
// Limited-time events (admin): pick a type, run it, extend it, end it
// ---------------------------------------------------------------------------

function evRemainText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}日${Math.floor((s % 86400) / 3600)}時間`;
  if (s >= 3600) return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
  if (s >= 60) return `${Math.floor(s / 60)}分`;
  return `${s}秒`;
}

// ---------------------------------------------------------------------------
// 👑 管理者イベント (weekly, per-player time slots)
//
// The admin picks ONE day of the week and several start times; every player
// books whichever time suits them. All of the day's slots feed the same shared
// boss / gauge / board, so a 18:00 player and a 21:00 player are demonstrably
// in the same event.
// ---------------------------------------------------------------------------

const AE_WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function aeFmtDate(ts) {
  // The schedule is authored in JST; show it in JST regardless of the device.
  const d = new Date(ts + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${AE_WEEKDAY_LABELS[d.getUTCDay()]}) ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

async function showAdminEventModal() {
  let data;
  try {
    data = await api('/api/admin/adminevent');
  } catch (err) { toast(err.message, 'err'); return; }

  const s = data.schedule;
  const occ = data.occurrences && data.occurrences[0];
  const modeOpts = [{ id: 'auto', icon: '🔄', name: '週替わりローテ（おまかせ）' }]
    .concat(data.modes.map(m => ({ id: m.id, icon: m.icon, name: m.name })));

  const m = showModal(`
    <h2>👑 管理者イベント</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">
      週1回・プレイヤーが自分の時間帯を予約する形式です。<br>
      どの枠を選んでも <b>進捗（ボスHP・ゲージ・ランキング）は全員で共有</b> されます。
    </p>

    <div class="settings-row">
      <label>開催する</label>
      <div class="seg" id="aeOn">
        <button data-v="1" class="${s.enabled ? 'active' : ''}">ON</button>
        <button data-v="0" class="${s.enabled ? '' : 'active'}">OFF</button>
      </div>
    </div>

    <div class="settings-row">
      <label>曜日</label>
      <select id="aeWeekday" style="font-family:inherit;padding:6px 10px;border-radius:8px">
        ${AE_WEEKDAY_LABELS.map((w, i) => `<option value="${i}" ${i === s.weekday ? 'selected' : ''}>${w}曜日</option>`).join('')}
      </select>
    </div>

    <div class="settings-row" style="align-items:flex-start">
      <label>時間枠<br><span class="muted" style="font-size:10px">JST・最大6個</span></label>
      <input id="aeSlots" type="text" value="${escapeHtml(s.slots.join(', '))}"
        placeholder="18:00, 19:00, 21:00" style="flex:1;min-width:150px">
    </div>

    <div class="settings-row">
      <label>1枠の長さ</label>
      <div class="seg" id="aeDur">
        ${[15, 30, 60].map(v => `<button data-v="${v}" class="${s.durationMin === v ? 'active' : ''}">${v}分</button>`).join('')}
      </div>
    </div>

    <div class="settings-row">
      <label>モード</label>
      <select id="aeMode" style="font-family:inherit;padding:6px 10px;border-radius:8px">
        ${modeOpts.map(o => `<option value="${o.id}" ${o.id === s.rotation ? 'selected' : ''}>${o.icon} ${o.name}</option>`).join('')}
      </select>
    </div>

    <div class="settings-row">
      <label>🎁 お宝ラッシュ</label>
      <div class="seg" id="aeMult">
        ${[1, 1.5, 2, 3].map(v => `<button data-v="${v}" class="${s.rewardMult === v ? 'active' : ''}">${v}倍</button>`).join('')}
      </div>
    </div>

    <div class="settings-row" style="align-items:flex-start">
      <label>ひとこと<br><span class="muted" style="font-size:10px">予約画面に出ます</span></label>
      <input id="aeNote" type="text" maxlength="140" value="${escapeHtml(s.note || '')}"
        placeholder="今週は初心者歓迎！" style="flex:1;min-width:150px">
    </div>

    ${occ ? `
      <div class="result-stats" style="margin-top:12px">
        <div class="rs-row"><span>次回</span><b>${escapeHtml(occ.dayKey)}</b></div>
        <div class="rs-row"><span>モード</span><b>${escapeHtml((data.modes.find(x => x.id === occ.modeId) || {}).name || occ.modeId)}</b></div>
        ${occ.slots.map(sl => `<div class="rs-row"><span>${sl.time}</span><b>${aeFmtDate(sl.startsAt)} 〜 ・ 予約${sl.taken}人</b></div>`).join('')}
      </div>` : '<p class="muted center" style="margin-top:12px;font-size:12px">OFFのため予定はありません</p>'}

    ${data.roster && data.roster.length ? `
      <div class="result-stats" style="margin-top:10px">
        <div class="rs-row"><span style="font-weight:800">予約者 ${data.roster.length}人</span><b></b></div>
        ${data.roster.slice(0, 12).map(r => `<div class="rs-row"><span>${escapeHtml(r.username)}</span><b>${(s.slots[r.slotId] || '?')}${r.runs ? ` ・ ${r.runs}回プレイ` : ''}</b></div>`).join('')}
      </div>` : ''}

    ${data.run ? `
      <div class="result-stats" style="margin-top:10px">
        <div class="rs-row"><span style="font-weight:800">共有の進捗（${escapeHtml(data.run.dayKey)}）</span><b></b></div>
        ${data.run.modeId === 'invasion' ? `<div class="rs-row"><span>管理者HP</span><b>${fmt(Math.max(0, data.run.hp))} / ${fmt(data.run.maxHp)}</b></div>` : ''}
        <div class="rs-row"><span>合計スコア</span><b>${fmt(data.run.total)}</b></div>
        <div class="rs-row"><span>参加人数</span><b>${Object.keys(data.run.byUser || {}).length}人</b></div>
      </div>` : ''}

    <div class="modal-buttons">
      <button class="btn btn-ghost" id="aeCancelBtn">とじる</button>
      <button class="btn btn-gold" id="aeSave">保存する</button>
    </div>`);

  let enabled = s.enabled;
  let durationMin = s.durationMin;
  let rewardMult = s.rewardMult;
  const seg = (id, set) => {
    m.querySelectorAll(`#${id} button`).forEach(b => {
      b.onclick = () => {
        m.querySelectorAll(`#${id} button`).forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        set(b.dataset.v);
      };
    });
  };
  seg('aeOn', v => { enabled = v === '1'; });
  seg('aeDur', v => { durationMin = Number(v); });
  seg('aeMult', v => { rewardMult = Number(v); });

  m.querySelector('#aeCancelBtn').onclick = closeModal;
  m.querySelector('#aeSave').onclick = async () => {
    const slots = m.querySelector('#aeSlots').value.split(/[,、\s]+/).filter(Boolean);
    try {
      await api('/api/admin/adminevent', {
        method: 'POST',
        body: {
          enabled,
          weekday: Number(m.querySelector('#aeWeekday').value),
          slots,
          durationMin,
          rotation: m.querySelector('#aeMode').value,
          rewardMult,
          note: m.querySelector('#aeNote').value,
        },
      });
      toast(enabled ? '👑 管理者イベントを設定しました（全員にアナウンス済み）' : '👑 管理者イベントをOFFにしました', 'ok', 4000);
      closeModal();
      showAdminEventModal();
    } catch (err) {
      toast(err.message, 'err', 4000);
    }
  };
}

async function showEventModal() {
  let types = [];
  let active = null;
  try {
    const data = await api('/api/admin/event/types');
    types = data.types;
    active = data.event;
  } catch (err) { toast(err.message, 'err'); return; }

  if (active) {
    const m = showModal(`
      <h2>${active.icon || '🌪️'} 開催中のイベント</h2>
      <div class="result-stats" style="margin-bottom:12px">
        <div class="rs-row"><span>イベント名</span><b>${escapeHtml(active.name)}</b></div>
        <div class="rs-row"><span>効果</span><b>${escapeHtml(active.desc || '—')}</b></div>
        <div class="rs-row"><span>残り時間</span><b style="color:var(--yellow)">${evRemainText(active.endsAt - Date.now())}</b></div>
        <div class="rs-row"><span>終了予定</span><b style="font-size:12px">${new Date(active.endsAt).toLocaleString('ja-JP')}</b></div>
      </div>
      <div class="settings-row"><label>延長する</label><div class="seg" id="evExtend">
        <button data-v="30">+30分</button><button data-v="60">+1時間</button>
        <button data-v="360">+6時間</button><button data-v="1440">+1日</button>
      </div></div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="evClose">閉じる</button>
        <button class="btn btn-ai" id="evStop">イベントを終了する</button>
      </div>`);
    m.querySelector('#evClose').onclick = closeModal;
    m.querySelectorAll('#evExtend button').forEach(b => {
      b.onclick = async () => {
        try {
          const res = await api('/api/admin/event', { method: 'POST', body: { extend: Number(b.dataset.v) } });
          window.__bbaEvent = res.event;
          audio.coin();
          toast(`⏱️ 延長しました（残り${evRemainText(res.event.endsAt - Date.now())}）`, 'ok');
          closeModal();
          showEventModal();
        } catch (err) { toast(err.message, 'err'); }
      };
    });
    m.querySelector('#evStop').onclick = async () => {
      try {
        const res = await api('/api/admin/event', { method: 'POST', body: { on: false } });
        window.__bbaEvent = res.event || null;
        closeModal();
        toast('イベントを終了しました', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
    return;
  }

  let typeId = types[0] ? types[0].id : 'chaos';
  const m = showModal(`
    <h2>🎪 期間限定イベント</h2>
    <p class="muted center" style="margin-bottom:10px;font-size:12px">
      種類を選んで開催すると、全員に効果が適用され全体チャットでアナウンスされます
    </p>
    <div class="ev-types" id="evTypes">
      ${types.map(ty => `
        <button class="ev-type ${ty.id === typeId ? 'active' : ''}" data-ty="${ty.id}">
          <span class="ev-icon">${ty.icon}</span>
          <b>${escapeHtml(ty.name)}</b>
          <small>${escapeHtml(ty.desc)}</small>
        </button>`).join('')}
    </div>
    <div class="form-col" style="margin-top:12px">
      <div class="settings-row"><label>イベント名</label><input id="evName" type="text" maxlength="16" value="${escapeHtml(types[0] ? types[0].name : '')}" style="width:150px"></div>
      <div class="settings-row"><label>開催期間</label>
        <input id="evDays" type="number" min="0" max="14" value="1" style="width:50px;text-align:center">日
        <input id="evHours" type="number" min="0" max="23" value="0" style="width:50px;text-align:center">時間
        <input id="evMins" type="number" min="0" max="59" value="0" style="width:50px;text-align:center">分
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="evClose">やめる</button>
        <button class="btn btn-chaos" id="evStart">🎪 開催する！</button>
      </div>
    </div>`);

  m.querySelectorAll('[data-ty]').forEach(b => {
    b.onclick = () => {
      audio.click();
      m.querySelectorAll('[data-ty]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      typeId = b.dataset.ty;
      const ty = types.find(x => x.id === typeId);
      if (ty) m.querySelector('#evName').value = ty.name;
    };
  });
  m.querySelector('#evClose').onclick = closeModal;
  m.querySelector('#evStart').onclick = async () => {
    const num = sel => Math.max(0, Math.floor(Number(m.querySelector(sel).value) || 0));
    const minutes = num('#evDays') * 1440 + num('#evHours') * 60 + num('#evMins');
    if (minutes < 1) { toast('開催期間は1分以上で設定してください', 'err'); return; }
    try {
      const res = await api('/api/admin/event', {
        method: 'POST',
        body: { on: true, type: typeId, name: m.querySelector('#evName').value.trim(), minutes },
      });
      window.__bbaEvent = res.event;
      closeModal();
      audio.coin();
      confettiBurst(40);
      toast(`${res.event.icon} 「${res.event.name}」を開始しました！全員にアナウンス済み`, 'ok', 4000);
    } catch (err) { toast(err.message, 'err'); }
  };
}
// ---------------------------------------------------------------------------
// Polls (投票) — player view + admin builder
// ---------------------------------------------------------------------------

function pollRemainText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mn = Math.floor((s % 3600) / 60);
  if (d) return tr(`${d}日${h ? `${h}時間` : ''}`, `${d}d${h ? ` ${h}h` : ''}`);
  if (h) return tr(`${h}時間${mn ? `${mn}分` : ''}`, `${h}h${mn ? ` ${mn}m` : ''}`);
  if (mn) return tr(`${mn}分`, `${mn}m`);
  return tr(`${s}秒`, `${s}s`);
}

export async function openPoll() {
  audio.click();
  let poll;
  try {
    poll = (await api('/api/poll')).poll;
  } catch (err) { toast(err.message, 'err'); return; }
  if (!poll) { toast(tr('いま開催中の投票はありません', 'No poll is running right now'), '', 2000); return; }
  renderPollModal(poll);
}

function renderPollModal(poll) {
  const closed = poll.closed;
  const canVote = !!session.user && !closed;
  const m = showModal(`
    <h2>🗳️ ${escapeHtml(LANG === 'en' && poll.questionEn ? poll.questionEn : poll.question)}</h2>
    <p class="muted center" style="margin-bottom:12px;font-size:12px">
      ${closed
        ? tr('この投票は終了しました', 'This poll has closed')
        : tr(`残り ${pollRemainText(poll.endsAt - Date.now())} ・ ${poll.voterCount}人が投票済み`,
             `${pollRemainText(poll.endsAt - Date.now())} left ・ ${poll.voterCount} voted`)}
      ${!session.user && !closed ? `<br><b style="color:var(--yellow)">${tr('投票にはログインが必要です', 'Log in to vote')}</b>` : ''}
      ${!poll.reveal ? `<br><small>${tr('投票すると結果が見られます', 'Results appear once you vote')}</small>` : ''}
    </p>
    <div class="poll-options">
      ${poll.options.map(o => {
        const mine = poll.myVote === o.id;
        const pct = o.pct === null ? 0 : o.pct;
        return `
        <button class="poll-option ${mine ? 'mine' : ''} ${poll.reveal ? 'revealed' : ''}"
                data-opt="${o.id}" ${canVote ? '' : 'disabled'}>
          ${poll.reveal ? `<span class="poll-fill" style="width:${pct}%"></span>` : ''}
          <span class="poll-text">${mine ? '✅ ' : ''}${escapeHtml(LANG === 'en' && o.textEn ? o.textEn : o.text)}</span>
          ${poll.reveal ? `<span class="poll-pct">${pct}% <small>(${fmt(o.votes)})</small></span>` : ''}
        </button>`;
      }).join('')}
    </div>
    ${closed && poll.winner ? `<p class="center" style="margin-top:12px;font-weight:800">🏆 ${tr('1位', 'Winner')}: ${escapeHtml(LANG === 'en' && poll.winner.textEn ? poll.winner.textEn : poll.winner.text)}${poll.winner.tied ? tr('（同率）', ' (tied)') : ''}</p>` : ''}
    <div class="modal-buttons">
      ${!session.user && !closed ? `<button class="btn btn-primary" id="plLogin">${tr('ログイン', 'Log in')}</button>` : ''}
      <button class="btn btn-ghost" id="plClose">${tr('閉じる', 'Close')}</button>
    </div>`);
  m.querySelector('#plClose').onclick = closeModal;
  const login = m.querySelector('#plLogin');
  if (login) login.onclick = () => { closeModal(); showAuthModal(); };
  m.querySelectorAll('[data-opt]:not([disabled])').forEach(b => {
    b.onclick = async () => {
      m.querySelectorAll('[data-opt]').forEach(x => { x.disabled = true; });
      try {
        const res = await api('/api/poll/vote', { method: 'POST', body: { optionId: b.dataset.opt } });
        audio.coin();
        toast(res.changed ? tr('投票を変更しました！', 'Vote changed!') : tr('🗳️ 投票しました！', '🗳️ Vote counted!'), 'ok');
        closeModal();
        renderPollModal(res.poll);
        refreshPollBanner();
      } catch (err) {
        audio.error();
        toast(err.message, 'err');
        m.querySelectorAll('[data-opt]').forEach(x => { x.disabled = false; });
      }
    };
  });
}

// Menu banner: shows while a poll is open, with a "not voted yet" nudge.
export async function refreshPollBanner() {
  const el = $('#pollBanner');
  if (!el) return;
  const brief = window.__bbaPoll;
  if (!brief) { el.classList.add('hidden'); return; }
  let voted = false;
  if (session.user) {
    try {
      const p = (await api('/api/poll')).poll;
      voted = !!(p && p.myVote);
    } catch { /* keep nudging */ }
  }
  el.innerHTML = `🗳️ <b>${escapeHtml(LANG === 'en' && brief.questionEn ? brief.questionEn : brief.question)}</b> — ${voted
    ? tr('投票済み・結果を見る', 'Voted — see results')
    : tr('投票受付中！', 'Vote now!')} <small>(${tr(`残り${pollRemainText(brief.endsAt - Date.now())}`, `${pollRemainText(brief.endsAt - Date.now())} left`)})</small>`;
  el.classList.toggle('unvoted', !voted && !!session.user);
  el.classList.remove('hidden');
}

// ---- admin: build a poll ----
export async function showPollAdminModal() {
  let poll = null;
  let suggest = [];
  try { poll = (await api('/api/poll')).poll; } catch { /* none */ }
  try { suggest = (await api('/api/admin/poll/suggest')).options; } catch { /* none */ }

  if (poll) {
    const m = showModal(`
      <h2>🗳️ 投票の管理</h2>
      <p class="center" style="margin-bottom:10px"><b>${escapeHtml(LANG === 'en' && poll.questionEn ? poll.questionEn : poll.question)}</b><br>
        <small class="muted">${poll.closed ? '終了済み' : `受付中 ・ 残り${pollRemainText(poll.endsAt - Date.now())}`} ・ ${poll.voterCount}人が投票${poll.aiVoters !== undefined ? `（👤実人 ${poll.realVoters} ／ 🤖AI住人 ${poll.aiVoters}）` : ''}</small></p>
      <div class="poll-options">
        ${poll.options.map(o => `
          <div class="poll-option revealed" style="cursor:default">
            <span class="poll-fill" style="width:${o.pct || 0}%"></span>
            <span class="poll-text">${escapeHtml(o.text)}${o.archs && o.archs.length
              ? `<small class="muted" style="display:block;font-size:10px">🤖 ${o.archs.map(a => `${escapeHtml(a.label)}×${a.n}`).join('・')}</small>` : ''}</span>
            <span class="poll-pct">${o.pct || 0}% <small>(${fmt(o.votes || 0)}${o.ai !== undefined ? ` = 👤${o.real}+🤖${o.ai}` : ''})</small></span>
          </div>`).join('')}
      </div>
      ${poll.kind === 'event' ? `<p class="muted center" style="font-size:12px;margin-top:10px">🎪 イベント投票：1位のイベントをそのまま開催できます${poll.applied ? '<br><b style="color:var(--green)">開催済み</b>' : ''}</p>` : ''}
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="plClose">閉じる</button>
        ${!poll.closed ? '<button class="btn btn-ghost" id="plCloseNow">締め切る</button>' : ''}
        ${poll.kind === 'event' && !poll.applied ? '<button class="btn btn-gold" id="plApply">🏆 1位でイベント開催</button>' : ''}
        <button class="btn btn-ai" id="plDelete">削除</button>
      </div>`);
    m.querySelector('#plClose').onclick = closeModal;
    const closeNow = m.querySelector('#plCloseNow');
    if (closeNow) closeNow.onclick = async () => {
      try {
        await api('/api/admin/poll', { method: 'POST', body: { action: 'close' } });
        closeModal();
        toast('🗳️ 投票を締め切りました', 'ok');
        showPollAdminModal();
      } catch (err) { toast(err.message, 'err'); }
    };
    const applyBtn = m.querySelector('#plApply');
    if (applyBtn) applyBtn.onclick = async () => {
      const hours = Number(prompt('開催時間を入力してください（時間）', '24'));
      if (!Number.isFinite(hours) || hours <= 0) return;
      try {
        const res = await api('/api/admin/poll', { method: 'POST', body: { action: 'applyWinner', minutes: Math.round(hours * 60) } });
        window.__bbaEvent = res.event;
        closeModal();
        audio.coin();
        confettiBurst(50);
        toast(`${res.event.icon} 投票1位の「${res.event.name}」を開催しました！`, 'ok', 4500);
      } catch (err) { toast(err.message, 'err'); }
    };
    m.querySelector('#plDelete').onclick = async () => {
      if (!confirm('この投票を削除します。よろしいですか？')) return;
      try {
        await api('/api/admin/poll', { method: 'POST', body: { action: 'delete' } });
        window.__bbaPoll = null;
        closeModal();
        toast('投票を削除しました', 'ok');
        refreshPollBanner();
      } catch (err) { toast(err.message, 'err'); }
    };
    return;
  }

  let kind = 'event';
  const m = showModal(`
    <h2>🗳️ 投票を作る</h2>
    <div class="settings-row"><label>種類</label><div class="seg" id="plKind">
      <button data-v="event" class="active">🎪 次のイベント投票</button>
      <button data-v="plain">💬 自由な質問</button>
    </div></div>
    <div class="form-col" style="margin-top:10px">
      <input id="plQ" type="text" maxlength="80" value="つぎの期間限定イベント、どれがいい？" placeholder="質問">
      <div id="plOptWrap">
        <p class="muted" style="font-size:12px;margin-bottom:6px">選択肢（チェックしたイベントが候補になります・2〜6個）</p>
        <div class="poll-pick" id="plPick">
          ${suggest.map((o, i) => `
            <label class="poll-pick-item"><input type="checkbox" value="${escapeHtml(o.eventType)}" ${i < 4 ? 'checked' : ''}>
              <span>${escapeHtml(o.text)}</span></label>`).join('')}
        </div>
      </div>
      <div id="plFreeWrap" class="hidden">
        <p class="muted" style="font-size:12px;margin-bottom:6px">選択肢を1行ずつ（2〜6個）</p>
        <textarea id="plFree" rows="5" style="width:100%" placeholder="選択肢A&#10;選択肢B"></textarea>
      </div>
      <div class="settings-row"><label>受付時間</label>
        <input id="plHours" type="number" min="0" max="336" value="24" style="width:60px;text-align:center">時間
        <input id="plMins" type="number" min="0" max="59" value="0" style="width:60px;text-align:center">分
      </div>
      <div class="form-error" id="plErr"></div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="plCancel">やめる</button>
        <button class="btn btn-primary" id="plCreate">🗳️ 投票を開始</button>
      </div>
    </div>`);

  m.querySelectorAll('#plKind button').forEach(b => {
    b.onclick = () => {
      m.querySelectorAll('#plKind button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      kind = b.dataset.v;
      m.querySelector('#plOptWrap').classList.toggle('hidden', kind !== 'event');
      m.querySelector('#plFreeWrap').classList.toggle('hidden', kind === 'event');
      const q = m.querySelector('#plQ');
      if (kind === 'plain' && q.value === 'つぎの期間限定イベント、どれがいい？') q.value = '';
    };
  });
  m.querySelector('#plCancel').onclick = closeModal;
  m.querySelector('#plCreate').onclick = async () => {
    const err = m.querySelector('#plErr');
    err.textContent = '';
    const num = sel => Math.max(0, Math.floor(Number(m.querySelector(sel).value) || 0));
    const minutes = num('#plHours') * 60 + num('#plMins');
    if (minutes < 1) { err.textContent = '受付時間は1分以上にしてください'; return; }
    let options;
    if (kind === 'event') {
      const picked = [...m.querySelectorAll('#plPick input:checked')].map(i => i.value);
      options = suggest.filter(o => picked.includes(o.eventType));
    } else {
      options = m.querySelector('#plFree').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(text => ({ text }));
    }
    if (options.length < 2) { err.textContent = '選択肢は2つ以上必要です'; return; }
    if (options.length > 6) { err.textContent = '選択肢は6つまでです'; return; }
    try {
      const res = await api('/api/admin/poll', {
        method: 'POST',
        body: { action: 'create', kind, question: m.querySelector('#plQ').value, options, minutes },
      });
      window.__bbaPoll = { id: res.poll.id, question: res.poll.question, questionEn: res.poll.questionEn || null, endsAt: res.poll.endsAt, voterCount: 0 };
      closeModal();
      audio.coin();
      confettiBurst(30);
      toast('🗳️ 投票を開始しました！全員にアナウンス済み', 'ok', 4000);
      refreshPollBanner();
    } catch (e) { err.textContent = e.message; }
  };
}


// ---------------------------------------------------------------------------
// にぎわい設定 2.0 — crowd simulation control room (admin)
// ---------------------------------------------------------------------------

const MOOD_LABEL = { party: '🔥 大盛況', busy: '🙂 にぎやか', calm: '😴 まったり', off: '⚫ オフ' };
const TOGGLE_LABELS = [
  ['chat', '💬 住人のチャット'], ['dialogues', '🗣️ 住人どうしの会話'], ['feed', '📡 ライブフィード'],
  ['greetings', '👋 入室した人への挨拶'], ['reactions', '⚡ 返事・イベント/投票/対戦への反応'],
  ['ghosts', '🏆 ランキングの住人'], ['bots', '🤖 対戦ボットを住人に'], ['votes', '🗳️ AI住人の投票'],
];
const PRESETS = [
  ['normal', '🙂 標準', '人口×1・ふつうのにぎわい'], ['party', '🎉 お祭り', '人口×3・おしゃべり×2.5'],
  ['fever', '🔥 フィーバー', '人口×25・住人320人'], ['mega', '🌋 伝説の夜', '人口×88・住人600人(上限)'],
  ['ultra', '🌠 祭りの極み', '人口×500・表示30万人'],
  ['quiet', '🤫 しずか', '人口×0.5・会話と挨拶なし'], ['night', '🌙 深夜の秘密基地', '人口×0.7・ゆったり'],
  ['silent', '🔇 人口だけ', '人数は出るが誰も喋らない'], ['off', '⚫ 完全オフ', 'AIプレイヤーを全停止'],
];

async function showCrowdModal(tab = 'basic') {
  let data;
  try { data = await api('/api/admin/residents'); } catch (err) { toast(err.message, 'err'); return; }
  const st = data.status;
  const amb = st.ambient;

  const m = showModal(`
    <h2>🎭 にぎわい設定 2.0</h2>
    <div class="crowd-status">
      <span>表示人数 <b>${fmt(st.online)}</b></span>
      <span>住人オンライン <b>${st.activeResidents}</b>/${data.residents.length}</span>
      <span>${MOOD_LABEL[st.mood.id] || st.mood.id}</span>
      ${st.quietNow ? '<span style="color:var(--yellow)">🤫 静かな時間帯</span>' : ''}
    </div>
    <div class="tabs" id="crTabs" style="margin:10px 0 12px;justify-content:center">
      ${[['basic', '基本'], ['cast', '👥 住人'], ['lines', '💭 セリフ'], ['test', '🧪 テスト']].map(([id, l]) =>
        `<button class="tab ${tab === id ? 'active' : ''}" data-ct="${id}">${l}</button>`).join('')}
    </div>
    <div id="crBody"></div>
    <div class="modal-buttons" style="margin-top:12px"><button class="btn btn-ghost" id="crClose">閉じる</button></div>`);
  m.querySelector('#crClose').onclick = () => { closeModal(); openAdmin(); };
  m.querySelectorAll('[data-ct]').forEach(b => { b.onclick = () => { audio.click(); closeModal(); showCrowdModal(b.dataset.ct); }; });

  const body = m.querySelector('#crBody');
  const post = async (payload) => {
    const res = await api('/api/admin/pop', { method: 'POST', body: payload });
    return res;
  };

  // ---- 基本 ----
  if (tab === 'basic') {
    body.innerHTML = `
      <p class="muted" style="font-size:12px;margin-bottom:6px">プリセット</p>
      <div class="preset-grid">
        ${PRESETS.map(([id, l, d]) => `<button class="preset-btn" data-preset="${id}"><b>${l}</b><small>${d}</small></button>`).join('')}
      </div>
      <div class="settings-row" style="margin-top:12px"><label>👥 人口倍率 <b>×${st.scale}</b></label></div>
      <p class="muted" style="font-size:11px;margin:-4px 0 6px">住人の実数は ×88 で上限（600人）。それより上は表示人数だけが増えます</p>
      <div class="seg seg-wrap" id="popSeg" style="justify-content:center">
        ${[0, 0.5, 1, 1.5, 2, 3, 5, 10, 25, 50, 88, 150, 300, 500].map(v => `<button data-v="${v}" ${v === st.scale ? 'class="active"' : ''}>×${v}</button>`).join('')}
      </div>
      <div class="settings-row" style="margin-top:10px"><label>💬 チャット頻度<br><span class="muted" style="font-size:10px">住人の発言とライブフィードの速さ</span></label><div class="seg" id="paceSeg">
        ${[[0.25, 'しずか'], [0.5, 'ひかえめ'], [1, '標準'], [2, 'おしゃべり'], [4, '大騒ぎ'], [6, '爆速'], [8, '限界']].map(([v, l]) =>
          `<button data-v="${v}" ${Number(amb.chatPace) === v ? 'class="active"' : ''}>${l}</button>`).join('')}
      </div></div>
      <p class="muted" style="font-size:12px;margin:12px 0 6px">機能のON/OFF</p>
      <div class="toggle-grid">
        ${TOGGLE_LABELS.map(([k, l]) => `<label class="toggle-item"><input type="checkbox" data-tg="${k}" ${amb.toggles[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <div class="settings-row" style="margin-top:12px">
        <label>🤫 静かな時間帯（JST）</label>
        <input type="checkbox" id="quietOn" ${amb.quiet ? 'checked' : ''}>
        <input type="number" id="quietFrom" min="0" max="23" value="${amb.quiet ? amb.quiet.from : 2}" style="width:54px;text-align:center">時 〜
        <input type="number" id="quietTo" min="0" max="24" value="${amb.quiet ? amb.quiet.to : 6}" style="width:54px;text-align:center">時
      </div>
      <p class="muted" style="font-size:11px">静かな時間帯はチャット・フィード・反応が止まります（人数表示はそのまま）</p>
      <div class="modal-buttons" style="margin-top:10px"><button class="btn btn-primary" id="crSaveBasic">💾 保存する</button></div>`;

    body.querySelectorAll('[data-preset]').forEach(b => {
      b.onclick = async () => {
        try {
          const res = await post({ preset: b.dataset.preset });
          audio.coin();
          toast(`🎭 プリセット適用 — 表示人数 ${fmt(res.online)}人 / ${MOOD_LABEL[res.mood.id]}`, 'ok', 3000);
          closeModal(); showCrowdModal('basic');
        } catch (err) { toast(err.message, 'err'); }
      };
    });
    body.querySelectorAll('#popSeg button').forEach(b => {
      b.onclick = async () => {
        try {
          const res = await post({ scale: Number(b.dataset.v) });
          body.querySelectorAll('#popSeg button').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          audio.click();
          toast(`🎭 人口 ×${res.scale} — 表示人数 ${fmt(res.online)}人・住人${res.activeResidents}人がオンライン`, 'ok', 2600);
        } catch (err) { toast(err.message, 'err'); }
      };
    });
    let pace = Number(amb.chatPace) || 1;
    body.querySelectorAll('#paceSeg button').forEach(b => {
      b.onclick = () => {
        body.querySelectorAll('#paceSeg button').forEach(x => x.classList.remove('active'));
        b.classList.add('active'); pace = Number(b.dataset.v); audio.click();
      };
    });
    body.querySelector('#crSaveBasic').onclick = async () => {
      const toggles = {};
      body.querySelectorAll('[data-tg]').forEach(i => { toggles[i.dataset.tg] = i.checked; });
      const quiet = body.querySelector('#quietOn').checked
        ? { from: Number(body.querySelector('#quietFrom').value), to: Number(body.querySelector('#quietTo').value) } : null;
      try {
        await post({ chatPace: pace, toggles, quiet });
        audio.coin();
        toast('🎭 保存しました', 'ok');
        closeModal(); showCrowdModal('basic');
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  // ---- 住人 ----
  if (tab === 'cast') {
    const rows = data.residents.slice().sort((a, b) => (b.online - a.online) || b.rating - a.rating);
    body.innerHTML = `
      <p class="muted" style="font-size:12px;margin-bottom:6px">${rows.length}人の住人がチャット・ランキング・対戦ボットに同じ名前で登場します。🟢=いまオンライン</p>
      <div class="cast-list">
        ${rows.map(r => `
          <div class="cast-row ${r.online ? 'on' : ''}">
            <span class="cast-dot">${r.online ? '🟢' : '⚫'}</span>
            <span class="cast-name">${escapeHtml(r.name)}${r.custom ? ' <small class="muted">(追加)</small>' : ''}</span>
            <span class="cast-arch">${escapeHtml(r.archLabel)}</span>
            <span class="cast-meta">${r.lang === 'en' ? '🌍' : '🇯🇵'} ${r.registered ? `R${r.rating} Lv${r.level}` : 'ゲスト'} ・ ${r.hours[0]}時〜${r.hours[1] % 24}時</span>
            <button class="btn btn-sm btn-ghost" data-rm="${escapeHtml(r.id)}" title="この住人を引退させる">✕</button>
          </div>`).join('')}
      </div>
      ${data.retired.length ? `
        <p class="muted" style="font-size:12px;margin:10px 0 4px">引退した住人（${data.retired.length}）</p>
        <div class="cast-retired">${data.retired.map(r => `<button class="btn btn-sm btn-ghost" data-restore="${escapeHtml(r.id)}">↩️ ${escapeHtml(r.name)}</button>`).join('')}</div>` : ''}
      <p class="muted" style="font-size:12px;margin:12px 0 6px">➕ 住人を追加</p>
      <div class="settings-row">
        <input id="castName" type="text" maxlength="16" placeholder="名前" style="width:130px">
        <select id="castArch">${data.archetypes.map(a => `<option value="${a.id}">${escapeHtml(a.label)}</option>`).join('')}</select>
        <select id="castLang"><option value="ja">🇯🇵 日本語</option><option value="en">🌍 English</option></select>
        <button class="btn btn-sm btn-primary" id="castAdd">追加</button>
      </div>
      <div class="modal-buttons" style="margin-top:12px">
        <button class="btn btn-sm btn-ghost" id="castReseed" style="color:var(--red)">🔄 住人を総入れ替え</button>
      </div>`;
    body.querySelectorAll('[data-rm]').forEach(b => {
      b.onclick = async () => {
        try { await post({ removeResident: b.dataset.rm }); audio.click(); closeModal(); showCrowdModal('cast'); }
        catch (err) { toast(err.message, 'err'); }
      };
    });
    body.querySelectorAll('[data-restore]').forEach(b => {
      b.onclick = async () => {
        try { await post({ restoreResident: b.dataset.restore }); audio.click(); closeModal(); showCrowdModal('cast'); }
        catch (err) { toast(err.message, 'err'); }
      };
    });
    body.querySelector('#castAdd').onclick = async () => {
      const name = body.querySelector('#castName').value.trim();
      if (!name) { toast('名前を入力してください', 'err'); return; }
      try {
        await post({ addResident: { name, arch: body.querySelector('#castArch').value, lang: body.querySelector('#castLang').value } });
        audio.coin();
        toast(`👥 「${name}」が住人になりました`, 'ok');
        closeModal(); showCrowdModal('cast');
      } catch (err) { toast(err.message, 'err'); }
    };
    body.querySelector('#castReseed').onclick = async () => {
      if (!confirm('住人64人を新しい顔ぶれに総入れ替えします（追加した住人は残ります）。よろしいですか？')) return;
      try { await post({ reseed: true }); audio.coin(); toast('🔄 住人を入れ替えました', 'ok'); closeModal(); showCrowdModal('cast'); }
      catch (err) { toast(err.message, 'err'); }
    };
  }

  // ---- セリフ ----
  if (tab === 'lines') {
    body.innerHTML = `
      <div class="form-col">
        <label class="muted" style="font-size:12px">🤖 追加のAI名（改行かカンマ区切り）— ゲストや一時ボットの名前に混ざります</label>
        <textarea id="popNames" rows="3" maxlength="1800" style="width:100%;resize:vertical" placeholder="例: たろう, PixelHero, ざわ子">${escapeHtml((amb.names || []).join('\n'))}</textarea>
        <label class="muted" style="font-size:12px">💭 カスタムセリフ（改行区切り）— 住人のチャットに混ざります。{me}=自分の名前 {mode}=得意モード {event}=イベント名 {name}=他の住人 が使えます</label>
        <textarea id="popLines" rows="5" maxlength="6000" style="width:100%;resize:vertical" placeholder="例: このゲーム最高！&#10;{mode}いっしょにやろ！">${escapeHtml((amb.lines || []).join('\n'))}</textarea>
      </div>
      <div class="modal-buttons" style="margin-top:10px"><button class="btn btn-primary" id="crSaveLines">💾 保存する</button></div>`;
    body.querySelector('#crSaveLines').onclick = async () => {
      const split = s => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
      try {
        const res = await post({ names: split(body.querySelector('#popNames').value), lines: body.querySelector('#popLines').value.split('\n').map(x => x.trim()).filter(Boolean) });
        audio.coin();
        toast(`💭 保存しました！追加名${res.ambient.names.length}件・セリフ${res.ambient.lines.length}件`, 'ok', 3000);
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  // ---- テスト ----
  if (tab === 'test') {
    body.innerHTML = `
      <p class="muted" style="font-size:12px;margin-bottom:8px">いますぐ1つ流して動作を確かめます（全員に見えます）</p>
      <div class="preset-grid">
        ${[['line', '💬 セリフを1行'], ['dialogue', '🗣️ 会話を1本'], ['feed', '📡 フィードを1件'], ['greet', '👋 挨拶'], ['reaction', '⚡ 反応（イベント/投票）']].map(([w, l]) =>
          `<button class="preset-btn" data-test="${w}"><b>${l}</b></button>`).join('')}
      </div>
      <div id="crTestOut" class="test-out muted">結果がここに表示されます</div>`;
    body.querySelectorAll('[data-test]').forEach(b => {
      b.onclick = async () => {
        const out = body.querySelector('#crTestOut');
        try {
          const res = await api('/api/admin/crowd/test', { method: 'POST', body: { what: b.dataset.test } });
          audio.click();
          out.innerHTML = res.lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
          out.classList.remove('muted');
        } catch (err) { out.textContent = err.message; }
      };
    });
  }
}
// ---------------------------------------------------------------------------
// Guilds (ギルド)
// ---------------------------------------------------------------------------

let guildTab = 'mine';
let guildData = null;

export async function openGuild(tab = guildTab) {
  showScreen('guild');
  guildTab = tab;
  $$('[data-gd]').forEach(x => x.classList.toggle('active', x.dataset.gd === tab));
  const body = $('#guildBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  try {
    guildData = await api('/api/guilds');
  } catch (err) {
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (tab === 'mine') renderMyGuild();
  else if (tab === 'rank') renderGuildRank();
  else renderGuildFind();
}

function guildCard(g, { rank = null, clickable = true } = {}) {
  return `
    <div class="guild-card ${g.ghost ? '' : 'real'}" ${clickable ? `data-guild="${escapeHtml(g.id)}"` : ''}>
      ${rank ? `<div class="guild-rank">${rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank}</div>` : ''}
      <div class="guild-icon">${g.icon}</div>
      <div class="guild-info">
        <div class="guild-name"><span class="lb-tag">[${escapeHtml(g.tag)}]</span>${escapeHtml(g.name)} <small class="muted">Lv.${g.level}</small></div>
        <div class="guild-meta">${escapeHtml(g.desc || '')}</div>
        <div class="guild-meta">👥 ${g.memberCount}/${g.maxMembers} ・ ${g.open ? tr('🔓 公開', '🔓 Open') : tr('🔒 招待制', '🔒 Invite only')} ・ 🪙+${g.bonusPct}%</div>
      </div>
      <div class="guild-pts"><b>${fmt(g.weeklyPoints)}</b><small>${tr('週間pt', 'weekly pts')}</small></div>
    </div>`;
}

function renderMyGuild() {
  const body = $('#guildBody');
  const d = guildData;
  if (!session.user) {
    body.innerHTML = `<div class="ms-empty"><p>${tr('ギルドはアカウント登録で参加できます', 'Create an account to join a guild')}</p><button class="btn btn-primary" id="gdLogin">${tr('ログイン / 新規登録', 'Log in / Sign up')}</button></div>`;
    body.querySelector('#gdLogin').onclick = () => showAuthModal();
    return;
  }
  const g = d.mine;
  if (!g) {
    body.innerHTML = `
      <div class="ms-head"><div><b>${tr('ギルド未所属', 'No guild yet')}</b><div class="muted" style="font-size:12px">${tr('ギルドに入ると毎試合のスコアが週間ポイントになり、ギルドレベルに応じてコインボーナス（最大+20%）がつきます', 'Every game feeds your guild\'s weekly points, and the guild level pays a coin bonus (up to +20%)')}</div></div></div>
      <div class="modal-buttons" style="justify-content:center;margin:14px 0">
        <button class="btn btn-gold" id="gdCreate">${tr(`🏰 ギルドを設立（🪙${fmt(d.createCost)}）`, `🏰 Found a guild (🪙${fmt(d.createCost)})`)}</button>
        <button class="btn btn-online" id="gdFind">${tr('🔍 ギルドをさがす', '🔍 Find a guild')}</button>
      </div>
      <div class="settings-row" style="justify-content:center"><label>${tr('招待コードで参加', 'Join with a code')}</label>
        <input id="gdCode" type="text" maxlength="6" placeholder="ABC123" style="width:110px;text-transform:uppercase"><button class="btn btn-sm btn-primary" id="gdJoinCode">${tr('参加', 'Join')}</button></div>`;
    body.querySelector('#gdCreate').onclick = () => showGuildCreateModal(d);
    body.querySelector('#gdFind').onclick = () => openGuild('find');
    body.querySelector('#gdJoinCode').onclick = () => joinGuildBy({ code: body.querySelector('#gdCode').value.trim() });
    return;
  }
  const me = session.user.id;
  const isOwner = g.ownerId === me;
  body.innerHTML = `
    <div class="guild-hero">
      <div class="guild-hero-icon">${g.icon}</div>
      <div>
        <div class="guild-hero-name"><span class="lb-tag">[${escapeHtml(g.tag)}]</span>${escapeHtml(g.name)}</div>
        <div class="muted" style="font-size:12px">${escapeHtml(g.desc || tr('（説明なし）', '(no description)'))}</div>
        <div class="guild-hero-stats">
          <span>Lv.<b>${g.level}</b></span><span>${tr('週間', 'Weekly')} <b>${fmt(g.weeklyPoints)}</b>pt</span><span>${tr('順位', 'Rank')} <b>${g.rank ? `#${g.rank}` : '-'}</b></span><span>🪙<b>+${g.bonusPct}%</b></span><span>👥 <b>${g.memberCount}</b>/${g.maxMembers}</span>
        </div>
      </div>
    </div>
    ${isOwner ? `<div class="settings-row" style="justify-content:center"><label>${tr('🔑 招待コード', '🔑 Invite code')}</label><b style="font-size:18px;letter-spacing:.12em">${escapeHtml(g.code || '')}</b><span class="muted" style="font-size:11px">${tr('（フレンドに教えると参加できます）', '(share it with friends)')}</span></div>` : ''}
    <div class="ms-list">
      ${g.members.map(mb => `
        <div class="ms-row">
          <div class="ms-info"><div class="ms-name">${mb.role === 'owner' ? '👑 ' : ''}${escapeHtml(mb.username)}${mb.id === me ? tr('（あなた）', ' (you)') : ''}</div>
            <div class="ms-prog">Lv.${mb.level} ・ R${fmt(mb.rating)} ・ ${tr('今週', 'this week')} ${fmt(mb.weeklyPts)}pt</div></div>
          ${isOwner && mb.role !== 'owner' ? `<button class="btn btn-sm btn-ghost" data-kick="${escapeHtml(mb.id)}" style="color:var(--red)">${tr('除名', 'Kick')}</button>` : ''}
        </div>`).join('')}
    </div>
    <div class="modal-buttons" style="margin-top:12px">
      ${isOwner ? `<button class="btn btn-sm btn-ghost" id="gdSettings">${tr('⚙️ ギルド設定', '⚙️ Guild settings')}</button>` : ''}
      <button class="btn btn-sm btn-ghost" id="gdLeave" style="color:var(--red)">${tr('脱退する', 'Leave guild')}</button>
    </div>`;
  body.querySelectorAll('[data-kick]').forEach(b => {
    b.onclick = async () => {
      if (!confirm(tr('このメンバーを除名しますか？', 'Kick this member?'))) return;
      try { await api('/api/guild/kick', { method: 'POST', body: { userId: b.dataset.kick } }); toast(tr('除名しました', 'Member kicked'), 'ok'); openGuild('mine'); }
      catch (err) { toast(err.message, 'err'); }
    };
  });
  const st = body.querySelector('#gdSettings');
  if (st) st.onclick = () => showGuildSettingsModal(g, d);
  body.querySelector('#gdLeave').onclick = async () => {
    if (!confirm(tr(isOwner ? 'リーダーを離れるとメンバーの最古参に引き継がれます。脱退しますか？' : 'ギルドを脱退しますか？（1時間は再加入できません）', 'Leave the guild? (you cannot rejoin for an hour)'))) return;
    try {
      const res = await api('/api/guilds/leave', { method: 'POST', body: {} });
      session.user = res.user; updateTopbar();
      toast(res.disbanded ? tr('ギルドを解散しました', 'Guild disbanded') : tr('ギルドを脱退しました', 'Left the guild'), 'ok');
      openGuild('mine');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function renderGuildRank() {
  const body = $('#guildBody');
  const rows = guildData.guilds;
  body.innerHTML = `
    <p class="muted center" style="font-size:12px;margin-bottom:8px">${tr('週間ポイント順（毎週月曜リセット）。メンバーの全試合のスコアが加算されます', 'Ranked by weekly points (resets Monday). Every member game counts')}</p>
    <div class="ms-list">${rows.map(g => guildCard(g, { rank: g.rank })).join('') || `<p class="muted center">${tr('まだギルドがありません', 'No guilds yet')}</p>`}</div>`;
  body.querySelectorAll('[data-guild]').forEach(el => { el.onclick = () => showGuildModal(el.dataset.guild); });
}

function renderGuildFind() {
  const body = $('#guildBody');
  const rows = guildData.guilds.filter(g => g.open && g.memberCount < g.maxMembers);
  body.innerHTML = `
    <div class="settings-row" style="justify-content:center;margin-bottom:10px"><label>${tr('招待コードで参加', 'Join with a code')}</label>
      <input id="gdCode2" type="text" maxlength="6" placeholder="ABC123" style="width:110px;text-transform:uppercase"><button class="btn btn-sm btn-primary" id="gdJoinCode2">${tr('参加', 'Join')}</button></div>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">${tr('公開ギルド（空きあり）', 'Open guilds with room')}</p>
    <div class="ms-list">${rows.map(g => guildCard(g)).join('') || `<p class="muted center">${tr('いま募集中の公開ギルドはありません', 'No open guilds right now')}</p>`}</div>
    ${session.user && !guildData.mine ? `<div class="modal-buttons" style="margin-top:12px"><button class="btn btn-gold" id="gdCreate2">${tr(`🏰 自分でギルドを設立（🪙${fmt(guildData.createCost)}）`, `🏰 Found your own (🪙${fmt(guildData.createCost)})`)}</button></div>` : ''}`;
  body.querySelector('#gdJoinCode2').onclick = () => joinGuildBy({ code: body.querySelector('#gdCode2').value.trim() });
  body.querySelectorAll('[data-guild]').forEach(el => { el.onclick = () => showGuildModal(el.dataset.guild); });
  const c = body.querySelector('#gdCreate2');
  if (c) c.onclick = () => showGuildCreateModal(guildData);
}

async function showGuildModal(id) {
  let g;
  try { g = (await api(`/api/guilds/${encodeURIComponent(id)}`)).guild; } catch (err) { toast(err.message, 'err'); return; }
  const canJoin = session.user && !(guildData && guildData.mine) && !g.ghost && g.open && g.memberCount < g.maxMembers;
  const m = showModal(`
    <h2>${g.icon} <span class="lb-tag">[${escapeHtml(g.tag)}]</span>${escapeHtml(g.name)}</h2>
    <p class="muted center" style="margin-bottom:8px">${escapeHtml(g.desc || '')}</p>
    <div class="guild-hero-stats" style="justify-content:center;margin-bottom:10px"><span>Lv.<b>${g.level}</b></span><span>${tr('週間', 'Weekly')} <b>${fmt(g.weeklyPoints)}</b>pt</span><span>👥 <b>${g.memberCount}</b>/${g.maxMembers}</span><span>🪙<b>+${g.bonusPct}%</b></span></div>
    <div class="ms-list" style="max-height:40vh;overflow-y:auto">
      ${(g.members || []).map(mb => `<div class="ms-row"><div class="ms-info"><div class="ms-name">${mb.role === 'owner' ? '👑 ' : ''}${escapeHtml(mb.username)}</div><div class="ms-prog">Lv.${mb.level} ・ R${fmt(mb.rating)} ・ ${fmt(mb.weeklyPts)}pt</div></div></div>`).join('')}
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="gmClose">${tr('閉じる', 'Close')}</button>
      ${canJoin ? `<button class="btn btn-primary" id="gmJoin">${tr('参加する', 'Join')}</button>` : ''}
      ${g.ghost ? `<span class="muted" style="font-size:11px;align-self:center">${tr('（AI住人のギルドには参加できません）', '(resident guilds cannot be joined)')}</span>` : ''}
    </div>`);
  m.querySelector('#gmClose').onclick = closeModal;
  const j = m.querySelector('#gmJoin');
  if (j) j.onclick = () => { closeModal(); joinGuildBy({ id: g.id }); };
}

async function joinGuildBy(body) {
  if (!session.user) { showAuthModal(); return; }
  if (body.code !== undefined && body.code.length < 6) { toast(tr('6文字の招待コードを入力してください', 'Enter the 6-character code'), 'err'); return; }
  try {
    const res = await api('/api/guilds/join', { method: 'POST', body });
    session.user = res.user; updateTopbar();
    audio.coin(); confettiBurst(30);
    toast(tr(`${res.guild.icon} 「${res.guild.name}」に参加しました！`, `${res.guild.icon} Joined "${res.guild.name}"!`), 'ok', 3000);
    openGuild('mine');
  } catch (err) { audio.error(); toast(err.message, 'err'); }
}

function showGuildCreateModal(d) {
  if (!session.user) { showAuthModal(); return; }
  const m = showModal(`
    <h2>🏰 ${tr('ギルドを設立', 'Found a guild')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">${tr(`設立費用 🪙${fmt(d.createCost)}（所持 🪙${fmt(session.user.coins)}）`, `Cost 🪙${fmt(d.createCost)} (you have 🪙${fmt(session.user.coins)})`)}</p>
    <div class="form-col">
      <input id="gcName" type="text" maxlength="16" placeholder="${tr('ギルド名（2〜16文字）', 'Guild name (2–16 chars)')}">
      <input id="gcTag" type="text" maxlength="4" placeholder="${tr('タグ（1〜4文字・例 BLZ）', 'Tag (1–4 chars, e.g. BLZ)')}" style="text-transform:uppercase">
      <input id="gcDesc" type="text" maxlength="60" placeholder="${tr('ひとこと説明（任意）', 'Short description (optional)')}">
      <div class="settings-row"><label>${tr('アイコン', 'Icon')}</label><div class="seg seg-wrap" id="gcIcon">${d.icons.map((ic, i) => `<button data-v="${ic}" ${i === 0 ? 'class="active"' : ''}>${ic}</button>`).join('')}</div></div>
      <div class="settings-row"><label>${tr('🔓 誰でも参加OK', '🔓 Anyone can join')}</label><input type="checkbox" id="gcOpen" checked></div>
      <div class="form-error" id="gcErr"></div>
      <div class="modal-buttons"><button class="btn btn-ghost" id="gcCancel">${tr('やめる', 'Cancel')}</button><button class="btn btn-gold" id="gcGo">🏰 ${tr('設立する', 'Found it')}</button></div>
    </div>`);
  let icon = d.icons[0];
  m.querySelectorAll('#gcIcon button').forEach(b => { b.onclick = () => { m.querySelectorAll('#gcIcon button').forEach(x => x.classList.remove('active')); b.classList.add('active'); icon = b.dataset.v; }; });
  m.querySelector('#gcCancel').onclick = closeModal;
  m.querySelector('#gcGo').onclick = async () => {
    try {
      const res = await api('/api/guilds/create', { method: 'POST', body: { name: m.querySelector('#gcName').value, tag: m.querySelector('#gcTag').value, desc: m.querySelector('#gcDesc').value, icon, open: m.querySelector('#gcOpen').checked } });
      session.user = res.user; updateTopbar();
      closeModal(); audio.coin(); confettiBurst(50);
      toast(tr(`${res.guild.icon} ギルド「${res.guild.name}」を設立しました！`, `${res.guild.icon} Founded "${res.guild.name}"!`), 'ok', 3500);
      openGuild('mine');
    } catch (err) { m.querySelector('#gcErr').textContent = err.message; audio.error(); }
  };
}

function showGuildSettingsModal(g, d) {
  const m = showModal(`
    <h2>⚙️ ${tr('ギルド設定', 'Guild settings')}</h2>
    <div class="form-col">
      <input id="gsName" type="text" maxlength="16" value="${escapeHtml(g.name)}">
      <input id="gsTag" type="text" maxlength="4" value="${escapeHtml(g.tag)}" style="text-transform:uppercase">
      <input id="gsDesc" type="text" maxlength="60" value="${escapeHtml(g.desc || '')}" placeholder="${tr('ひとこと説明', 'Description')}">
      <div class="settings-row"><label>${tr('アイコン', 'Icon')}</label><div class="seg seg-wrap" id="gsIcon">${d.icons.map(ic => `<button data-v="${ic}" ${ic === g.icon ? 'class="active"' : ''}>${ic}</button>`).join('')}</div></div>
      <div class="settings-row"><label>${tr('🔓 誰でも参加OK', '🔓 Anyone can join')}</label><input type="checkbox" id="gsOpen" ${g.open ? 'checked' : ''}></div>
      <div class="form-error" id="gsErr"></div>
      <div class="modal-buttons"><button class="btn btn-ghost" id="gsCancel">${tr('やめる', 'Cancel')}</button><button class="btn btn-primary" id="gsSave">${tr('保存', 'Save')}</button></div>
    </div>`);
  let icon = g.icon;
  m.querySelectorAll('#gsIcon button').forEach(b => { b.onclick = () => { m.querySelectorAll('#gsIcon button').forEach(x => x.classList.remove('active')); b.classList.add('active'); icon = b.dataset.v; }; });
  m.querySelector('#gsCancel').onclick = closeModal;
  m.querySelector('#gsSave').onclick = async () => {
    try {
      await api('/api/guild/settings', { method: 'POST', body: { name: m.querySelector('#gsName').value, tag: m.querySelector('#gsTag').value, desc: m.querySelector('#gsDesc').value, icon, open: m.querySelector('#gsOpen').checked } });
      await refreshMe().catch(() => {}); updateTopbar();
      closeModal(); toast(tr('保存しました', 'Saved'), 'ok'); openGuild('mine');
    } catch (err) { m.querySelector('#gsErr').textContent = err.message; }
  };
}

// ---------------------------------------------------------------------------
// News (お知らせ)
// ---------------------------------------------------------------------------

export async function openNews() {
  showScreen('news');
  const body = $('#newsBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  $('#btnNewsPost').classList.toggle('hidden', !(session.user && session.user.role === 'admin'));
  $('#btnNewsPost').onclick = () => showNewsPostModal();
  let data;
  try { data = await api('/api/news'); } catch (err) { body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`; return; }
  markNewsSeen(data.latestAt);
  const isAdmin = session.user && session.user.role === 'admin';
  body.innerHTML = data.news.length ? data.news.map(n => `
    <article class="news-card ${n.pinned ? 'pinned' : ''}">
      <div class="news-head">
        <h3>${n.pinned ? '📌 ' : ''}${escapeHtml(LANG === 'en' && n.titleEn ? n.titleEn : n.title)}</h3>
        <span class="news-date">${new Date(n.at).toLocaleDateString(LANG === 'en' ? 'en-US' : 'ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
      </div>
      <p class="news-body">${escapeHtml(LANG === 'en' && n.bodyEn ? n.bodyEn : n.body).replace(/\n/g, '<br>')}</p>
      <div class="news-foot"><span class="muted">— ${escapeHtml(n.by || '運営')}</span>
        ${isAdmin ? `<span><button class="btn btn-sm btn-ghost" data-pin="${escapeHtml(n.id)}">${n.pinned ? '📌解除' : '📌固定'}</button> <button class="btn btn-sm btn-ghost" data-del="${escapeHtml(n.id)}" style="color:var(--red)">削除</button></span>` : ''}
      </div>
    </article>`).join('') : `<p class="muted center">${tr('お知らせはまだありません', 'No news yet')}</p>`;
  body.querySelectorAll('[data-pin]').forEach(b => {
    b.onclick = async () => {
      const n = data.news.find(x => x.id === b.dataset.pin);
      try { await api(`/api/admin/news/${b.dataset.pin}`, { method: 'POST', body: { pinned: !n.pinned } }); openNews(); } catch (err) { toast(err.message, 'err'); }
    };
  });
  body.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('このお知らせを削除しますか？')) return;
      try { await api(`/api/admin/news/${b.dataset.del}`, { method: 'DELETE' }); openNews(); } catch (err) { toast(err.message, 'err'); }
    };
  });
}

function showNewsPostModal() {
  const m = showModal(`
    <h2>✍️ お知らせを投稿</h2>
    <div class="form-col">
      <input id="npTitle" type="text" maxlength="60" placeholder="タイトル">
      <textarea id="npBody" rows="6" maxlength="2000" placeholder="本文（改行OK）"></textarea>
      <div class="settings-row"><label>📌 上部に固定</label><input type="checkbox" id="npPin"></div>
      <div class="settings-row"><label>📢 全員にアナウンス＋フィードに流す</label><input type="checkbox" id="npAnn" checked></div>
      <div class="form-error" id="npErr"></div>
      <div class="modal-buttons"><button class="btn btn-ghost" id="npCancel">やめる</button><button class="btn btn-primary" id="npGo">投稿する</button></div>
    </div>`);
  m.querySelector('#npCancel').onclick = closeModal;
  m.querySelector('#npGo').onclick = async () => {
    try {
      await api('/api/admin/news', { method: 'POST', body: { title: m.querySelector('#npTitle').value, body: m.querySelector('#npBody').value, pinned: m.querySelector('#npPin').checked, announce: m.querySelector('#npAnn').checked } });
      closeModal(); audio.coin(); toast('📰 投稿しました', 'ok'); openNews();
    } catch (err) { m.querySelector('#npErr').textContent = err.message; }
  };
}
