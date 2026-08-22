// Sub-screens: auth modal, leaderboard, shop, battle pass, admin panel.
import { session, api, setToken, refreshMe } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, fmt, updateTopbar, confettiBurst, rankOf, staffUiOn, setStaffUi } from './dom.js';
import { getSkin, BOARDS } from './themes.js';
import { audio } from './audio.js';
import { getSettings, updateSettings } from './settings.js';
import { reconnectChat } from './chat.js';
import { t as tr, setLang, LANG, catName, catDesc } from './i18n.js';
import { equippedUlt, setGuestUlt } from './modes.js';
import { ultIcon, ultColor } from './skills.js';

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
  const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈', souzou: '🌌', rush: '⚔️', dungeon: '🏰', tourney: '🏆', royale: '💯' };
  const m = showModal(`
    <h2>${u.role === 'admin' ? '🛡️' : u.role === 'mod' ? '🔧' : '😀'} ${u.username}</h2>
    ${u.equippedTitle ? `<p class="center" style="margin:-8px 0 10px;font-weight:800;font-size:14px">《 ${escapeHtml(titleName(u.equippedTitle))} 》</p>` : ''}
    <div class="result-stats">
      <div class="rs-row"><span>${tr('レベル', 'Level')}</span><b>Lv.${u.level}</b></div>
      <div class="rs-row"><span>${tr('ハイスコア', 'High score')}</span><b>${fmt(u.stats.bestScore)}</b></div>
      <div class="rs-row"><span>${tr('レート', 'Rating')}</span><b>${fmt(u.stats.rating)} <span style="color:${rankOf(u.stats.rating).color}">${rankOf(u.stats.rating).icon}${tr(rankOf(u.stats.rating).name, rankOf(u.stats.rating).nameEn)}</span></b></div>
      <div class="rs-row"><span>${tr('オンライン戦績', 'Online record')}</span><b>${tr(`${u.stats.pvpWins}勝 ${u.stats.pvpLosses}敗`, `${u.stats.pvpWins}W ${u.stats.pvpLosses}L`)}</b></div>
      <div class="rs-row"><span>${tr('AI撃破', 'AI wins')}</span><b>${fmt(u.stats.aiWins)}</b></div>
      <div class="rs-row"><span>${tr('プレイ回数', 'Games played')}</span><b>${fmt(u.stats.gamesPlayed)}</b></div>
      <div class="rs-row"><span>${tr('バッジ', 'Badges')}</span><b>${u.badges.length ? u.badges.map(b => badgeIcons[b] || '🎖️').join(' ') : tr('なし', 'None')}</b></div>
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

function showCreditsModal() {
  const m = showModal(`
    <div class="center" style="margin-bottom:6px">
      <span style="font-size:28px">🟥🟦<br>🟨🟩</span>
    </div>
    <h2>BLOCK BLITZ ARENA</h2>
    <div class="result-stats" style="margin-top:10px">
      <div class="rs-row"><span>${tr('企画・運営', 'Produced by')}</span><b>るみまき</b></div>
      <div class="rs-row"><span>${tr('開発・プログラム', 'Development')}</span><b>Claude (Anthropic) × るみまき</b></div>
      <div class="rs-row"><span>${tr('ゲームデザイン', 'Game design')}</span><b>るみまき & Claude</b></div>
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
        <label>${tr('🔊 効果音', '🔊 Sound FX')}</label>
        <input type="range" id="setSfxVol" min="0" max="100" value="${Math.round(s.sfxVol * 100)}">
        <input type="checkbox" id="setSfxOn" ${s.sfxOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>🎵 BGM</label>
        <input type="range" id="setMusicVol" min="0" max="100" value="${Math.round(s.musicVol * 100)}">
        <input type="checkbox" id="setMusicOn" ${s.musicOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>${tr('📳 画面シェイク', '📳 Screen shake')}</label>
        <input type="checkbox" id="setShake" ${s.shake ? 'checked' : ''}>
      </div>
      ${session.user && session.user.role === 'admin' ? `
      <div class="settings-row">
        <label>🛡️ 管理者専用ボタンを表示<br><small class="muted" style="font-weight:600">カオス／オートパイロット／コマンドパレット</small></label>
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
  const staffToggle = m.querySelector('#setStaffUi');
  if (staffToggle) staffToggle.onchange = e => {
    setStaffUi(e.target.checked);
    toast(e.target.checked ? '🛡️ 管理者専用ボタンを表示します' : '👤 プレイヤーと同じ表示にしました', 'ok');
  };
  m.querySelector('#setSfxVol').oninput = e => { updateSettings({ sfxVol: e.target.value / 100 }); audio.click(); };
  m.querySelector('#setMusicVol').oninput = e => updateSettings({ musicVol: e.target.value / 100 });
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
    const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈', souzou: '🌌', rush: '⚔️', dungeon: '🏰', tourney: '🏆', royale: '💯' };
    list.innerHTML = data.rows.map((r, i) => `
      <div class="lb-row ${session.user && r.username === session.user.username ? 'me' : ''}" style="animation-delay:${Math.min(i * 40, 600)}ms">
        <div class="lb-rank ${i === 0 ? 'top1' : ''}">${medal(i)}</div>
        <div class="lb-name">${escapeHtml(r.username)}
          <span class="lb-badges">${(r.badges || []).map(b => badgeIcons[b] || '').join('')}</span>
          ${r.title ? `<span class="lb-title" style="color:${escapeHtml(r.title.color)}">《${escapeHtml(r.title.name)}》</span>` : ''}
          <div class="lb-lvl">Lv.${r.level}${board === 'rating' ? ` ・ ${tr(`${r.pvpWins}勝${r.pvpLosses}敗`, `${r.pvpWins}W ${r.pvpLosses}L`)}` : ''}${board === 'sprint' && r.sprint180 ? ` ・ ${tr('3分', '3min')} ${fmt(r.sprint180)}` : ''}</div>
        </div>
        <div class="lb-score">${board === 'dungeon' ? `F${fmt(r.dungeonMax || 0)}`
          : board === 'weekly' ? fmt(r.weeklyBest || 0)
          : board === 'sprint' ? fmt(r.sprintBest || 0)
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
            : `<button class="btn btn-sm btn-gold" data-act="buy">${cur} ${fmt(item.price)}</button>`}
    `;
    grid.appendChild(el);
    renderPreview(el.querySelector('.shop-preview'), item);
    const btn = el.querySelector('[data-act]');
    if (btn) btn.onclick = () => (btn.dataset.act === 'buy' ? buyItem(item) : equipItem(item));
  });
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
  const m = showModal(`
    <h2>${tr('🎰 カプセルマシン', '🎰 Capsule Machine')}</h2>
    <p class="muted center" style="margin-bottom:4px">${tr('コインで回して お宝ゲット！', 'Spin with coins and win treasure!')}</p>
    <p class="center" style="margin-bottom:10px">${tr('所持コイン', 'Your coins')}: <b id="gcCoins">🪙 ${fmt(session.user.coins)}</b></p>
    <div id="gcResults" class="gacha-results"></div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="gcClose">${tr('閉じる', 'Close')}</button>
      <button class="btn btn-primary" id="gcPull1">${tr('1回 🪙500', '1 pull 🪙500')}</button>
      <button class="btn btn-gold" id="gcPull10">${tr('10連 🪙4,500', '10 pulls 🪙4,500')}</button>
    </div>
    <p class="muted center" style="font-size:10px;margin-top:8px">${tr('N コイン 50% ・ R アイテム 22% ・ SR ジェム 15% ・ SSR スキン等 10% ・ UR ジェム150 3%', 'N Coins 50% ・ R Items 22% ・ SR Gems 15% ・ SSR Cosmetics 10% ・ UR 150 Gems 3%')}<br>${tr('スキン等をコンプ済みの場合はジェムに変換されます', 'Duplicate cosmetics are converted to gems')}</p>`);
  m.querySelector('#gcClose').onclick = closeModal;
  const pull = async count => {
    const b1 = m.querySelector('#gcPull1'), b10 = m.querySelector('#gcPull10');
    b1.disabled = b10.disabled = true;
    try {
      const data = await api('/api/gacha', { method: 'POST', body: { count } });
      session.user = data.user;
      updateTopbar();
      m.querySelector('#gcCoins').textContent = `🪙 ${fmt(data.user.coins)}`;
      const box = m.querySelector('#gcResults');
      box.innerHTML = '';
      audio.coin();
      let bigWin = false;
      data.results.forEach((r, i) => {
        const card = document.createElement('div');
        card.className = `gacha-card gr-${r.rarity}`;
        card.style.animationDelay = `${i * 120}ms`;
        const icon = r.type === 'coins' ? '🪙' : r.type === 'gems' ? '💎' : r.type === 'item' ? r.icon : r.cat === 'skin' ? '🧊' : r.cat === 'board' ? '🖼️' : '✨';
        const label = r.type === 'coins' ? tr(`コイン +${fmt(r.amount)}`, `Coins +${fmt(r.amount)}`)
          : r.type === 'gems' ? tr(`ジェム +${fmt(r.amount)}${r.complete ? '（コンプ済）' : ''}`, `Gems +${fmt(r.amount)}${r.complete ? ' (all collected)' : ''}`)
          : r.type === 'item' ? catName(r)
          : catName(r);
        card.innerHTML = `<span class="gc-rarity">${r.rarity}</span><span class="gc-icon">${icon}</span><span class="gc-label">${escapeHtml(label)}</span>`;
        box.appendChild(card);
        if (r.rarity === 'SSR' || r.rarity === 'UR') bigWin = true;
      });
      if (bigWin) { setTimeout(() => { audio.victory(); confetti(); }, count * 120 + 300); }
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

async function equipItem(item) {
  // Guests can still pick an ultimate — the choice lives in localStorage.
  if (!session.user) {
    if (item.cat !== 'ult') return;
    setGuestUlt(item.id);
    audio.click();
    toast(tr(`${catName(item)} を装備しました`, `Equipped ${catName(item)}`), 'ok');
    renderShop();
    return;
  }
  try {
    await api('/api/equip', { method: 'POST', body: { slot: item.cat, itemId: item.id } });
    audio.click();
    toast(tr(`${item.name} を装備しました`, `Equipped ${catName(item)}`), 'ok');
    renderShop();
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

  body.innerHTML = `
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
      <h3>✨ ${escapeHtml(data.season.name)}</h3>
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

async function showRestoreModal() {
  let snaps = [];
  try { snaps = (await api('/api/admin/snapshots')).snapshots; } catch { /* none yet */ }

  const m = showModal(`
    <h2>♻️ データ復元</h2>
    <p class="muted center" style="margin-bottom:12px;font-size:12px">
      バックアップJSONを読み込んでプレイヤーデータを復旧します。<br>
      <b style="color:var(--green)">マージ</b>＝復元後に登録した人も残す（推奨）／
      <b style="color:var(--red)">置き換え</b>＝現在のデータを破棄してファイルの内容にする
    </p>
    <div class="form-col">
      <div class="settings-row"><label>復元方法</label><div class="seg" id="rsMode">
        <button data-v="merge" class="active">マージ（安全）</button>
        <button data-v="replace">置き換え</button>
      </div></div>
      <input type="file" id="rsFile" accept="application/json,.json">
      <div id="rsInfo" class="muted center" style="font-size:12px;min-height:34px"></div>
      <div class="form-error" id="rsError"></div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rsClose">やめる</button>
        <button class="btn btn-primary" id="rsApply" disabled>♻️ 復元する</button>
      </div>
    </div>
    ${snaps.length ? `
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <p class="muted center" style="font-size:12px;margin-bottom:8px">
        📸 このサーバーのスナップショット（起動時・復元前に自動保存／再デプロイで消えます）
      </p>
      <div class="ms-list" style="max-height:190px;overflow-y:auto">
        ${snaps.map(s => `
          <div class="ms-row">
            <div class="ms-info">
              <div class="ms-name" style="font-size:12px">${escapeHtml(s.name)}</div>
              <div class="ms-prog">${new Date(s.at).toLocaleString('ja-JP')} ・ ${fmtBytes(s.size)}</div>
            </div>
            <button class="btn btn-sm btn-ghost" data-snap="${escapeHtml(s.name)}">巻き戻す</button>
          </div>`).join('')}
      </div>` : ''}
    <div class="modal-buttons" style="margin-top:12px">
      <button class="btn btn-sm btn-ghost" id="rsSnapNow">📸 いまスナップショットを作る</button>
    </div>`);

  let mode = 'merge';
  let payload = null;
  const err = m.querySelector('#rsError');
  const info = m.querySelector('#rsInfo');
  const apply = m.querySelector('#rsApply');

  m.querySelectorAll('#rsMode button').forEach(b => {
    b.onclick = () => {
      m.querySelectorAll('#rsMode button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.v;
    };
  });
  m.querySelector('#rsClose').onclick = closeModal;

  m.querySelector('#rsFile').onchange = async ev => {
    err.textContent = '';
    apply.disabled = true;
    payload = null;
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    info.textContent = '読み込み中…';
    try {
      payload = JSON.parse(await file.text());
    } catch {
      info.textContent = '';
      err.textContent = 'JSONとして読み取れませんでした';
      return;
    }
    // Ask the server to validate before anything is written.
    try {
      const res = await api('/api/admin/restore', { method: 'POST', body: { data: payload, mode, dryRun: true } });
      const p = res.preview;
      info.innerHTML = `✅ <b>${fmt(p.users)}人</b>のアカウント（管理者${p.admins}人）・取引${fmt(p.transactions)}件<br>
        ${p.savedAt ? `取得日時: ${new Date(p.savedAt).toLocaleString('ja-JP')}` : 'ファイル: ' + escapeHtml(file.name)} ・ ${fmtBytes(file.size)}`;
      apply.disabled = false;
    } catch (e) {
      info.textContent = '';
      err.textContent = e.message;
    }
  };

  apply.onclick = async () => {
    const warn = mode === 'replace'
      ? '【置き換え】現在のデータをすべて破棄してファイルの内容にします。本当に実行しますか？'
      : 'バックアップをマージして復元します。実行しますか？';
    if (!confirm(warn)) return;
    apply.disabled = true;
    info.textContent = '復元中…（大きいファイルは少し時間がかかります）';
    try {
      const res = await api('/api/admin/restore', { method: 'POST', body: { data: payload, mode } });
      const r = res.report;
      closeModal();
      audio.coin();
      confettiBurst(40);
      toast(`♻️ 復元完了！ 追加${r.added}人 / 更新${r.updated}人 / 維持${r.kept}人 → 合計${fmt(r.after)}人`, 'ok', 6000);
      await refreshMe().catch(() => {});
      updateTopbar();
      openAdmin();
    } catch (e) {
      apply.disabled = false;
      info.textContent = '';
      err.textContent = e.message;
      audio.error();
    }
  };

  m.querySelectorAll('[data-snap]').forEach(b => {
    b.onclick = async () => {
      if (!confirm(`スナップショット「${b.dataset.snap}」の状態に巻き戻します。現在のデータは自動保存された上で置き換えられます。実行しますか？`)) return;
      try {
        const res = await api('/api/admin/snapshots/restore', { method: 'POST', body: { name: b.dataset.snap } });
        closeModal();
        toast(`♻️ 巻き戻しました（${fmt(res.report.after)}人）`, 'ok', 5000);
        await refreshMe().catch(() => {});
        updateTopbar();
        openAdmin();
      } catch (e) { toast(e.message, 'err'); }
    };
  });

  m.querySelector('#rsSnapNow').onclick = async () => {
    try {
      await api('/api/admin/snapshots/create', { method: 'POST', body: {} });
      toast('📸 スナップショットを作成しました', 'ok');
      closeModal();
      showRestoreModal();
    } catch (e) { toast(e.message, 'err'); }
  };
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
    <h2>🗳️ ${escapeHtml(poll.question)}</h2>
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
          <span class="poll-text">${mine ? '✅ ' : ''}${escapeHtml(o.text)}</span>
          ${poll.reveal ? `<span class="poll-pct">${pct}% <small>(${fmt(o.votes)})</small></span>` : ''}
        </button>`;
      }).join('')}
    </div>
    ${closed && poll.winner ? `<p class="center" style="margin-top:12px;font-weight:800">🏆 ${tr('1位', 'Winner')}: ${escapeHtml(poll.winner.text)}${poll.winner.tied ? tr('（同率）', ' (tied)') : ''}</p>` : ''}
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
  el.innerHTML = `🗳️ <b>${escapeHtml(brief.question)}</b> — ${voted
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
      <p class="center" style="margin-bottom:10px"><b>${escapeHtml(poll.question)}</b><br>
        <small class="muted">${poll.closed ? '終了済み' : `受付中 ・ 残り${pollRemainText(poll.endsAt - Date.now())}`} ・ ${poll.voterCount}人が投票</small></p>
      <div class="poll-options">
        ${poll.options.map(o => `
          <div class="poll-option revealed" style="cursor:default">
            <span class="poll-fill" style="width:${o.pct || 0}%"></span>
            <span class="poll-text">${escapeHtml(o.text)}</span>
            <span class="poll-pct">${o.pct || 0}% <small>(${fmt(o.votes || 0)})</small></span>
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
      window.__bbaPoll = { id: res.poll.id, question: res.poll.question, endsAt: res.poll.endsAt, voterCount: 0 };
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
  ['ghosts', '🏆 ランキングの住人'], ['bots', '🤖 対戦ボットを住人に'],
];
const PRESETS = [
  ['normal', '🙂 標準', '人口×1・ふつうのにぎわい'], ['party', '🎉 お祭り', '人口×3・おしゃべり×2.5'],
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
      <div class="seg seg-wrap" id="popSeg" style="justify-content:center">
        ${[0, 0.5, 1, 1.5, 2, 3, 5, 7, 10].map(v => `<button data-v="${v}" ${v === st.scale ? 'class="active"' : ''}>×${v}</button>`).join('')}
      </div>
      <div class="settings-row" style="margin-top:10px"><label>💬 チャット頻度</label><div class="seg" id="paceSeg">
        ${[[0.5, 'ひかえめ'], [1, '標準'], [2, 'おしゃべり'], [4, '大騒ぎ']].map(([v, l]) =>
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