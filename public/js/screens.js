// Sub-screens: auth modal, leaderboard, shop, battle pass, admin panel.
import { session, api, setToken, refreshMe } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, fmt, updateTopbar, confettiBurst, rankOf, staffUiOn, setStaffUi, staffExtras } from './dom.js';
import { getSkin, BOARDS, PALETTE } from './themes.js';
import { audio, TRACK_INFO } from './audio.js';
import { getSettings, updateSettings } from './settings.js';
import { reconnectChat, markNewsSeen } from './chat.js';
import { t as tr, setLang, LANG, catName, catDesc } from './i18n.js';
import { equippedUlt, setGuestUlt, ghostUnlocked } from './modes.js';
import { ultIcon, ultColor } from './skills.js';
import { showYouTubeStudio } from './ytexport.js';

// ---------------------------------------------------------------------------
// A11y: ボタンではない要素（カード）を押せる形にしている箇所を、キーボードからも
// 押せるようにする。role と tabindex を足し、Enter / Space で同じハンドラを呼ぶ。
// DOM構造も CSS も触らないので見た目は今のまま、Tab で到達できるようになる。
// ※ 中にボタンを持つカード（工房カードの ▶遊ぶ / ❤️）では、そのボタン上の
//    Enter / Space が親まで上がってくるので、自分自身が対象のときだけ反応する。
// ---------------------------------------------------------------------------
function bindActivate(el, handler) {
  if (!el) return;
  el.onclick = handler;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
  el.setAttribute('role', 'button');
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  el.onkeydown = e => {
    if (e.target !== el) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    handler(e);
  };
}

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

// 🏛 シーズン刻印バッジ `s{N}champ`（s3champ, s4champ …）。シーズンが終わるたびに
// server/index.js の settleSeasonHallOfFame() が `s${prev.number}champ` という
// 新しいidを作る動的バッジなので、固定キーの表では持ちきれない（表に無いidは
// 素の 🎖️ や空欄に潰れる）。アイコン・名前・解除条件はここで組み立て、
// どの表を引くときも「固定キーを引く手前」で必ずこれを通すこと。
// 綴りはサーバー側の SEASON_BADGE_RE = /^s\d{1,4}champ$/ に合わせてある。
const SEASON_BADGE_RE = /^s(\d{1,4})champ$/;
function seasonBadgeNo(id) {
  const m = SEASON_BADGE_RE.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}
function seasonBadgeInfo(n) {
  return {
    icon: '🏛',
    ja: `シーズン${n} 王者`, en: `Season ${n} Champion`,
    cja: `シーズン${n}の殿堂ボードで1位になる`, cen: `Finish #1 on a Season ${n} Hall of Fame board`,
  };
}
// 固定バッジは BADGE_INFO（下で定義）、動的なシーズン刻印はここ経由で引く。
function badgeInfoOf(id) {
  const n = seasonBadgeNo(id);
  return n ? seasonBadgeInfo(n) : BADGE_INFO[id] || null;
}

function showProfileModal() {
  const u = session.user;
  const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈', souzou: '🌌', rush: '⚔️', dungeon: '🏰', under: '🕳️', heaven: '☁️', zero: '👁️', tourney: '🏆', royale: '💯', adminevent: '👑', abyss: '🌑', weekly1: '🏅', puzzle: '🧩', dig: '⛏️', crown2: '👑', crown3: '👑', crown5: '👑', crown7: '🌈', ghost: '👻', daily7: '📅', guildquest: '🎖️' };
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
      <div class="rs-row"><span>${tr('バッジ', 'Badges')}</span><b>${u.badges.length ? u.badges.map(b => seasonBadgeNo(b) ? '🏛' : badgeIcons[b] || '🎖️').join(' ') : tr('なし', 'None')}</b></div>
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
    // パーティーの棚も畳む。畳まないと、ログアウトしたあとも前の人の
    // パーティーが出たままになる（次に入った人の画面にも残る）。
    import('./party.js').then(p => p.resetParty()).catch(() => {});
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
  boss_rush: ['ボスラッシュ', 'Boss Rush'], weekly: ['ウィークリー', 'Weekly'], daily: ['デイリー', 'Daily'],
  chaos: ['カオス', 'Chaos'], pvp: ['オンライン', 'Online'], tournament: ['トーナメント', 'Tournament'],
  meltdown: ['メルトダウン', 'Meltdown'], chimera: ['キメラ工房', 'Chimera Lab'],
  puzzle: ['パズル遺跡', 'Puzzle Ruins'], dig: ['採掘場', 'The Mines'], ghost: ['幽霊屋敷', 'Haunted House'],
  royale: ['バトルロイヤル', 'Royale'], dungeon: ['ダンジョン', 'Dungeon'],
  dungeon_under: ['地下', 'Underworld'], dungeon_heaven: ['天界', 'Heavens'],
  ai_easy: ['AI戦', 'VS AI'], ai_normal: ['AI戦', 'VS AI'], ai_hard: ['AI戦', 'VS AI'],
  ai_oni: ['AI戦', 'VS AI'], ai_kami: ['AI戦', 'VS AI'], ai_souzou: ['AI戦', 'VS AI'],
  ai: ['AI戦', 'VS AI'], sprint: ['タイムアタック', 'Time Attack'],
  dungeon_abyss: ['深淵ダンジョン', 'The Abyss'],
  team: ['チーム戦', 'Team'], raid: ['レイド', 'Raid'], coop: ['協力プレイ', 'Co-op'],
  chain: ['連鎖カスケード', 'Chain Cascade'], blueprint: ['ブループリント', 'Blueprint'],
  workshop: ['パズル工房', 'Puzzle Workshop'],
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
      <div class="settings-row">
        <label>${tr('🔣 色にマークを付ける', '🔣 Show shape marks')}<br><small class="muted" style="font-weight:600">${tr('色が見分けにくいときに、ブロックへ形の記号を重ねます', 'Overlays a shape on each block for easier telling apart')}</small></label>
        <input type="checkbox" id="setColorMarks" ${s.colorMarks ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>${tr('✨ 画面フラッシュ', '✨ Screen flash')}<br><small class="muted" style="font-weight:600">${tr('連鎖やボスで画面が白く光る演出を切ります', 'Turns off the full-screen white flash on chains and boss hits')}</small></label>
        <input type="checkbox" id="setFlash" ${s.flash !== false ? 'checked' : ''}>
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
  m.querySelector('#setFlash').onchange = e => updateSettings({ flash: e.target.checked });
  m.querySelector('#setColorMarks').onchange = e => {
    updateSettings({ colorMarks: e.target.checked });
    audio.click();
    // The board runs on a rAF loop, so it picks the flag up on the next frame;
    // nudge a repaint anyway so a paused/idle view updates right away.
    const v = window.__bbaView;
    if (v && typeof v.render === 'function') { try { v.render(); } catch { /* view already torn down */ } }
  };
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
      const keys = [
        'bba_settings', 'bba_guest_name',
        // 隠し難易度・隠しモードの解放状態（神／創造神／幽霊屋敷）
        'bba_kami', 'bba_souzou', 'bba_ghost',
        // ゲストのベストスコア・ローカル記録
        'bba_best', 'bba_meltdown_best', 'bba_chimera_best', 'bba_dig_best',
        'bba_ghost_best', 'bba_chaos_best', 'bba_coop_best', 'bba_survival_best',
        'bba_survival_wave', 'bba_boss_max', 'bba_rush_depth', 'bba_weekly_best',
        'bba_daily_record', 'bba_dungeon_abyss_max', 'bba_puzzle_stars', 'bba_puzzle_stage',
      ];
      for (const key of keys) localStorage.removeItem(key);
      // タイムアタックのベストは時間別に複数（bba_sprint_60 等）あるので前方一致で消す。
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('bba_sprint_')) localStorage.removeItem(k);
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

// タブ連打時のレース対策：これらの一覧を開くたびに世代を進め、await から
// 戻った時点で最新世代でなければ（＝別タブに切り替わっていれば）描画しない。
let viewGen = 0;

export async function openLeaderboard(board = 'score') {
  showScreen('leaderboard');
  const gen = ++viewGen;
  $$('[data-lb]').forEach(t => t.classList.toggle('active', t.dataset.lb === board));
  const list = $('#lbList');
  list.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  // 🏛️ 殿堂への導線。メニューにもボタンを出すが、順位を見ている流れから
  // 歴代の記録へ寄り道できるほうが自然なのでここにも置く。
  const hofLink = `<button class="btn btn-sm btn-ghost" id="lbHof" style="width:100%;margin-bottom:8px">🏛️ ${tr('シーズン殿堂（歴代TOP3）', 'Hall of Fame (past top 3)')}</button>`;
  const bindHof = () => { const b = $('#lbHof'); if (b) b.onclick = () => showHallOfFame(); };
  try {
    const data = await api(`/api/leaderboard?board=${board}`);
    if (gen !== viewGen) return;
    if (!data.rows.length) {
      list.innerHTML = `${hofLink}<p class="muted center">${tr('まだ記録がありません。最初の挑戦者になろう！', 'No records yet — be the first challenger!')}</p>`;
      bindHof();
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
    const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈', souzou: '🌌', rush: '⚔️', dungeon: '🏰', under: '🕳️', heaven: '☁️', zero: '👁️', tourney: '🏆', royale: '💯', adminevent: '👑', abyss: '🌑', weekly1: '🏅', puzzle: '🧩', dig: '⛏️', crown2: '👑', crown3: '👑', crown5: '👑', crown7: '🌈', ghost: '👻', daily7: '📅', guildquest: '🎖️' };
    list.innerHTML = hofLink + rewardHead + data.rows.map((r, i) => `
      <div class="lb-row ${session.user && r.username === session.user.username ? 'me' : ''} ${r.throne ? 'throne' : ''}" style="animation-delay:${Math.min(i * 40, 600)}ms">
        <div class="lb-rank ${i === 0 ? 'top1' : ''}">${medal(i)}</div>
        <div class="lb-name ${r.crowns ? `crowned${Math.min(3, r.crowns)}` : ''}">${r.throne ? `<span class="lb-crown" title="${tr('現王者', 'Reigning champion')}">👑</span>` : ''}${r.guildTag ? `<span class="lb-tag">[${escapeHtml(r.guildTag)}]</span>` : ''}${escapeHtml(r.username)}
          <span class="lb-badges">${(r.badges || []).map(b => seasonBadgeNo(b) ? '🏛' : badgeIcons[b] || '').join('')}</span>
          ${r.title ? `<span class="lb-title" style="color:${escapeHtml(r.title.color)}">《${escapeHtml(r.title.id ? catName(r.title) : r.title.name)}》</span>` : ''}
          <div class="lb-lvl">Lv.${r.level}${board === 'rating' ? ` ・ ${tr(`${r.pvpWins}勝${r.pvpLosses}敗`, `${r.pvpWins}W ${r.pvpLosses}L`)}` : ''}${board === 'sprint' && r.sprint180 ? ` ・ ${tr('3分', '3min')} ${fmt(r.sprint180)}` : ''}${board === 'dungeon' && r.abyssMax ? ` ・ 🌑A${fmt(r.abyssMax)}` : ''}</div>
        </div>
        <div class="lb-score">${board === 'dungeon' ? `F${fmt(r.dungeonMax || 0)}`
          : board === 'weekly' ? fmt(r.weeklyBest || 0)
          : board === 'daily' ? fmt(r.dailyScore || 0)
          // 順位を決めているのは1分のほう。ラベルが無いせいで、下の行にある
          // 「3分 …」だけが説明つきに見え、順位と無関係な数字を読んでしまう。
          : board === 'sprint' ? tr(`1分 ${fmt(r.sprintBest || 0)}`, `1min ${fmt(r.sprintBest || 0)}`)
          : board === 'puzzle' ? tr(`ステージ${fmt(r.puzzleStage || 0)}`, `Stage ${fmt(r.puzzleStage || 0)}`)
          : board === 'dig' ? `${fmt(r.digDepth || 0)}m`
          : board === 'rating' ? `${rankOf(r.rating).icon}${fmt(r.rating)}` : fmt(r.bestScore)}</div>
      </div>`).join('');
    bindHof();
  } catch (err) {
    if (gen !== viewGen) return;
    list.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// 🏛️ シーズン殿堂（I13）— 歴代シーズンのTOP3
//
// 画面（section）を増やすと dom.js の SCREENS を触ることになるので、ここは
// モーダルで作る。中身はランキング画面と同じ「タブ＝ボード／行＝順位」構造。
// /api/halloffame がまだ無いサーバーでは「まだありません」で止まる。
// ---------------------------------------------------------------------------

// ボードの見出し。サーバーの各シーズンが name / nameEn を持って来るので、
// それを優先し、ここは絵文字つきの既定ラベルとして使う（未知の id はそのまま）。
const HOF_BOARD_LABEL = {
  rating:  ['📈 レート',           '📈 Rating'],
  score:   ['🏆 ハイスコア',       '🏆 High Score'],
  wins:    ['🎯 週間チャレンジ優勝', '🎯 Weekly Challenge wins'],
  sprint:  ['⏱️ タイムアタック',   '⏱️ Time Attack'],
  dungeon: ['🏰 ダンジョン',       '🏰 Dungeon'],
  weekly:  ['🎯 ウィークリー',     '🎯 Weekly'],
  puzzle:  ['🧩 パズル遺跡',       '🧩 Puzzle Ruins'],
  dig:     ['⛏️ 採掘場',           '⛏️ The Mines'],
};
const HOF_BOARD_ORDER = ['rating', 'score', 'wins', 'sprint', 'dungeon', 'weekly', 'puzzle', 'dig'];
// サーバーが送ってきたボード名（日英）。id -> [ja, en]
let hofNames = {};
function hofBoardLabel(id) {
  const n = hofNames[id];
  if (Array.isArray(n)) return tr(n[0], n[1]);
  const L = HOF_BOARD_LABEL[id];
  return Array.isArray(L) ? tr(L[0], L[1]) : id;
}

// /api/halloffame は { seasons: [{ season, number, name, nameEn, endsAt, badge,
// boards: [{ id, name, nameEn, entrants, top: [{rank, username, value, resident}] }] }] }。
// boards が配列でもオブジェクトでも読めるようにしてある（形が変わっても落ちない）。
function normalizeHof(data) {
  const raw = Array.isArray(data) ? data
    : (data && (data.seasons || data.halls || data.rows)) || null;
  if (!Array.isArray(raw)) return [];
  hofNames = {};
  const entry = (e, i) => ({
    rank: Number(e && e.rank) || i + 1,
    username: String((e && (e.username || e.name)) || '—'),
    value: Number((e && (e.value ?? e.score ?? e.best ?? e.rating)) || 0) || 0,
    entrants: 0,
  });
  const takeBoard = (out, id, list, name, nameEn) => {
    if (!Array.isArray(list) || !list.length) return;
    if (name) hofNames[id] = [name, nameEn || name];
    out[id] = list.slice(0, 3).map(entry);
  };
  return raw.map(s => {
    const boards = {};
    const entrants = {};
    const bs = s && s.boards;
    if (Array.isArray(bs)) {
      for (const b of bs) {
        if (!b || !b.id) continue;
        takeBoard(boards, b.id, b.top || b.rows || b.entries, b.name, b.nameEn);
        if (boards[b.id]) entrants[b.id] = Number(b.entrants) || 0;
      }
    } else if (bs && typeof bs === 'object') {
      for (const [k, v] of Object.entries(bs)) takeBoard(boards, k, v);
    } else if (Array.isArray(s && (s.top3 || s.top))) {
      takeBoard(boards, 'score', s.top3 || s.top);
    }
    return {
      number: Number(s && (s.number ?? s.season ?? s.n)) || 0,
      name: (LANG === 'en' && s && s.nameEn ? s.nameEn : (s && s.name)) || '',
      endedAt: Number(s && (s.endsAt ?? s.endedAt ?? s.at)) || 0,
      boards, entrants,
    };
  }).filter(s => Object.keys(s.boards).length)
    .sort((a, b) => b.number - a.number);
}

function hofValue(board, e) {
  if (board === 'wins') return tr(`${fmt(e.value)}回`, `${fmt(e.value)}x`);
  if (board === 'dungeon') return `F${fmt(e.value)}`;
  if (board === 'dig') return `${fmt(e.value)}m`;
  if (board === 'puzzle') return tr(`ステージ${fmt(e.value)}`, `Stage ${fmt(e.value)}`);
  if (board === 'rating') return `${rankOf(e.value).icon}${fmt(e.value)}`;
  return fmt(e.value);
}

let hofSeasons = null;
let hofBoard = null;
let hofGen = 0;   // モーダル内の非同期レース対策（画面用の viewGen とは別勘定）

export async function showHallOfFame() {
  audio.click();
  const m = showModal(`
    <h2>🏛️ ${tr('シーズン殿堂', 'Hall of Fame')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">${tr('歴代シーズンの上位3名', 'The top 3 of every past season')}</p>
    <div class="tabs" id="hofTabs" style="justify-content:center;flex-wrap:wrap"></div>
    <div id="hofBody" class="lb-list" style="max-height:52vh;overflow-y:auto"><p class="muted center">${tr('読み込み中…', 'Loading…')}</p></div>
    <div class="modal-buttons"><button class="btn btn-primary" id="hofClose">${tr('閉じる', 'Close')}</button></div>`);
  m.querySelector('#hofClose').onclick = closeModal;

  const gen = ++hofGen;
  let data = null;
  try { data = await api('/api/halloffame'); } catch { data = null; }
  // await のあとは必ずガード。閉じられた／開き直された後には描かない。
  if (gen !== hofGen || !m.isConnected) return;
  hofSeasons = normalizeHof(data);
  const body = m.querySelector('#hofBody');
  if (!hofSeasons.length) {
    body.innerHTML = `<p class="muted center">${tr('まだ殿堂入りしたシーズンがありません', 'No seasons in the Hall of Fame yet')}</p>`;
    return;
  }
  const avail = [];
  for (const id of HOF_BOARD_ORDER) if (hofSeasons.some(s => s.boards[id])) avail.push(id);
  for (const s of hofSeasons) for (const k of Object.keys(s.boards)) if (!avail.includes(k)) avail.push(k);
  if (!avail.includes(hofBoard)) hofBoard = avail[0];

  const tabs = m.querySelector('#hofTabs');
  tabs.innerHTML = avail.map(id =>
    `<button class="tab ${id === hofBoard ? 'active' : ''}" data-hof="${escapeHtml(id)}">${escapeHtml(hofBoardLabel(id))}</button>`).join('');
  tabs.querySelectorAll('[data-hof]').forEach(b => {
    b.onclick = () => {
      audio.click();
      hofBoard = b.dataset.hof;
      tabs.querySelectorAll('[data-hof]').forEach(x => x.classList.toggle('active', x === b));
      renderHofBody(body);
    };
  });
  renderHofBody(body);
}

function renderHofBody(body) {
  const medal = i => i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
  const seasons = (hofSeasons || []).filter(s => s.boards[hofBoard] && s.boards[hofBoard].length);
  if (!seasons.length) {
    body.innerHTML = `<p class="muted center">${tr('このランキングの記録はまだありません', 'No records on this board yet')}</p>`;
    return;
  }
  body.innerHTML = seasons.map(s => {
    const n = s.entrants ? s.entrants[hofBoard] : 0;
    return `
    <div class="inv-sec" style="margin-bottom:10px">
      <div class="inv-sec-head">
        <span>${s.number ? `S${s.number}` : ''} ${escapeHtml(s.name)}</span>
        <span class="muted">${s.endedAt ? new Date(s.endedAt).toLocaleDateString(LANG === 'en' ? 'en-US' : 'ja-JP') : ''}${
          n ? ` ・ ${tr(`${fmt(n)}人中`, `of ${fmt(n)}`)}` : ''}</span>
      </div>
      ${s.boards[hofBoard].map((e, i) => `
        <div class="lb-row ${session.user && e.username === session.user.username ? 'me' : ''}">
          <div class="lb-rank ${i === 0 ? 'top1' : ''}">${medal(i)}</div>
          <div class="lb-name">${escapeHtml(e.username)}</div>
          <div class="lb-score">${hofValue(hofBoard, e)}</div>
        </div>`).join('')}
    </div>`;
  }).join('');
}

// メニューの「🏛️ 殿堂」ボタン。index.html 側にはまだ無いのでここで足す。
// 後から index.html に #btnHallOfFame が生えたら、それを拾うだけで二重にしない。
function ensureHallOfFameNav() {
  try {
    let btn = $('#btnHallOfFame');
    if (!btn) {
      const nav = $('#screen-menu .menu-nav');
      if (!nav) return;
      btn = document.createElement('button');
      btn.className = 'nav-btn';
      btn.id = 'btnHallOfFame';
      btn.innerHTML = `<span>🏛️</span>${tr('殿堂', 'Hall of Fame')}`;
      const after = $('#btnLeaderboard');
      if (after && after.parentNode === nav) nav.insertBefore(btn, after.nextSibling);
      else nav.appendChild(btn);
    }
    btn.onclick = () => showHallOfFame();
  } catch { /* メニューの形が変わっても他の導線は死なせない */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureHallOfFameNav, { once: true });
else ensureHallOfFameNav();

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

// アイテム／奥義が使えるモードの一覧。以前は2か所に手書きしてあり、
// 6モードぶん実態とずれていた（書いてある通りに使えないモードがあった）。
// showItemBar(true) を呼んでいるモードが実際の答え。
const JA = "ソロ・ボス・ボスラッシュ・ダンジョン・サバイバル・カオスの6モードで使えます。それ以外は公平のため使えません";
const EN = "Usable in Solo, Boss, Boss Rush, Dungeon, Survival and Chaos. Every other mode disables them for fairness";

let shopItems = null;
let shopBoosters = null;
let shopTab = 'skin';
let shopRole = null;   // admin sees exclusive gear — refetch when the role changes

// 🔥 日替わりセール／🎁 無料ギフト（I14）。どちらも古いサーバー（deals も gift も
// 返さない）では null のままで、値引きバッジもギフトの棚も一切出ない＝従来の
// 見た目に戻るだけ。セールは時間で変わるので、品目のキャッシュには寿命をつける。
let shopDeals = null;      // Map(itemId -> { price, was, off, endsAt })
let shopGift = null;       // { available, claimed, coins, gems, nextAt } | null
let shopFetchedAt = 0;
const SHOP_CACHE_MS = 60000;

export async function openShop(tab = shopTab) {
  showScreen('shop');
  shopTab = tab;
  $$('[data-shop]').forEach(t => t.classList.toggle('active', t.dataset.shop === tab));
  const grid = $('#shopGrid');
  grid.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  try {
    const role = session.user ? session.user.role : 'guest';
    if (!shopItems || shopRole !== role || Date.now() - shopFetchedAt > SHOP_CACHE_MS) {
      const data = await api('/api/shop');
      shopItems = data.items;
      shopBoosters = data.boosters || [];
      shopRole = role;
      shopFetchedAt = Date.now();
      shopDeals = normalizeDeals(data.deals);
      shopGift = normalizeGift(data.gift || data.freeGift);
    }
  } catch (err) {
    grid.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderShop();
}

// ---- 🔥 セールの読み取り（サーバーの形に幅を持たせる） ----------------------
// deals は配列でも { itemId: {...} } でも受ける。壊れた／期限切れの行は
// 単に「セールなし」に落ちるだけで、通常価格の表示に戻る。
function normalizeDeals(raw) {
  const map = new Map();
  if (!raw) return map;
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'object'
      ? Object.entries(raw).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : { id, price: v }))
      : []);
  for (const d of list) {
    if (!d) continue;
    const id = d.id || d.itemId;
    if (!id) continue;
    const price = Number(d.price ?? d.salePrice ?? d.newPrice);
    const was = Number(d.was ?? d.basePrice ?? d.origPrice ?? d.oldPrice);
    const off = Number(d.off ?? d.pct ?? d.percent ?? d.discount);
    const endsAt = Number(d.endsAt ?? d.until ?? d.expiresAt) || 0;
    map.set(id, {
      price: Number.isFinite(price) ? price : null,
      was: Number.isFinite(was) ? was : null,
      off: Number.isFinite(off) ? off : null,
      endsAt,
    });
  }
  return map;
}

// /api/shop の gift は { day, available, claimed, nextAt }。中身（何が出るか）は
// 受け取ってみるまで分からない＝サーバー抽選なので、金額は一切表示しない。
function normalizeGift(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    available: raw.available === undefined ? !raw.claimed : !!raw.available,
    claimed: !!(raw.claimed ?? raw.taken),
    nextAt: Number(raw.nextAt ?? raw.resetAt ?? raw.nextResetAt) || 0,
  };
}

// その品が「いま値引きされているか」。値引きになっていない／期限切れの行は
// null を返し、呼び出し側は定価表示にフォールバックする。
function dealFor(item) {
  if (!shopDeals || !item) return null;
  const d = shopDeals.get(item.id);
  if (!d) return null;
  const was = d.was != null ? d.was : Number(item.price);
  if (!Number.isFinite(was) || was <= 0) return null;
  let price = d.price;
  if (price == null && d.off != null) price = Math.max(0, Math.round(was * (1 - d.off / 100)));
  if (price == null || !(was > price)) return null;
  if (d.endsAt && d.endsAt <= Date.now()) return null;
  const off = d.off != null ? d.off : Math.round((1 - price / was) * 100);
  return { price, was, off, endsAt: d.endsAt };
}

// 値札。セール中は元値に打ち消し線を引いて隣に割引後を出す。
function priceLabel(cur, item, deal) {
  return deal
    ? `${cur} <s style="opacity:.55;font-weight:400">${fmt(deal.was)}</s> <b>${fmt(deal.price)}</b>`
    : `${cur} ${fmt(item.price)}`;
}

function saleBadge(deal) {
  if (!deal) return '';
  return `<div class="shop-sale" style="font-size:11px;font-weight:800;color:var(--red)">🔥 ${tr(`${deal.off}%OFF`, `${deal.off}% OFF`)}${
    deal.endsAt ? ` <span class="muted" style="font-weight:600" data-deal-end="${deal.endsAt}">…</span>` : ''}</div>`;
}

function dealRemainText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), mn = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h >= 1) return tr(`残り${h}時間${mn}分`, `${h}h ${mn}m left`);
  if (mn >= 1) return tr(`残り${mn}分${sec}秒`, `${mn}m ${sec}s left`);
  return tr(`残り${sec}秒`, `${sec}s left`);
}

// カウントダウンは1本のタイマーで全部の [data-deal-end] を更新する。
// 対象が画面から消えたら自分で止まるので、画面を離れても回りっぱなしにならない。
let dealTimer = null;
function tickDeals() {
  const els = document.querySelectorAll('[data-deal-end]');
  if (!els.length) { if (dealTimer) { clearInterval(dealTimer); dealTimer = null; } return; }
  const now = Date.now();
  els.forEach(el => {
    const end = Number(el.dataset.dealEnd) || 0;
    el.textContent = end > now ? dealRemainText(end - now) : tr('終了しました', 'Ended');
  });
}
function startDealTimer() {
  tickDeals();
  if (!dealTimer && document.querySelector('[data-deal-end]')) dealTimer = setInterval(tickDeals, 1000);
}

// 🎁 無料ギフトの棚。gift を返さないサーバーでは何も足さない。
function appendGiftBanner(grid) {
  if (!shopGift) return;
  const g = shopGift;
  const el = document.createElement('div');
  el.className = 'shop-gift';
  el.style.cssText = 'grid-column:1 / -1;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;padding:10px;border:1px dashed var(--gold);border-radius:12px;background:rgba(255,215,94,0.08)';
  el.innerHTML = `
    <b>🎁 ${tr('本日の無料ギフト', 'Today\'s free gift')}</b>
    <span class="muted" style="font-size:12px">${tr('中身は開けてのお楽しみ（1日1回）', 'A surprise every day — once per day')}</span>
    ${g.claimed
      ? `<span class="muted">✓ ${tr('受取済み', 'Claimed')}${g.nextAt > Date.now() ? ` ・ ${tr(`次は${fmtResetIn(g.nextAt - Date.now())}後`, `next in ${fmtResetIn(g.nextAt - Date.now())}`)}` : ''}</span>`
      : `<button class="btn btn-sm btn-gold" id="shopGiftClaim">${tr('受け取る', 'Claim')}</button>`}`;
  grid.appendChild(el);
  const btn = el.querySelector('#shopGiftClaim');
  if (btn) btn.onclick = () => claimShopGift(btn);
}

async function claimShopGift(btn) {
  if (!session.user) { showAuthModal(); return; }
  btn.disabled = true;
  try {
    // 中身も受取済みフラグもサーバー側。こちらは押したことを伝えるだけで、
    // 返ってきた gift は表示にしか使わない（user は api() が反映する）。
    const res = await api('/api/shop/gift', { method: 'POST', body: {} });
    const g = (res && res.gift) || {};
    const gname = LANG === 'en' && g.nameEn ? g.nameEn : (g.name || '');
    audio.coin();
    confettiBurst(25);
    updateTopbar();
    toast(tr(`🎁 無料ギフト： ${g.icon || ''}${gname}${g.amount ? ` ×${fmt(g.amount)}` : ''}`,
      `🎁 Free gift: ${g.icon || ''}${gname}${g.amount ? ` ×${fmt(g.amount)}` : ''}`), 'ok', 3500);
    shopFetchedAt = 0;   // 受取済みの状態を取り直す
    openShop(shopTab);
  } catch (err) {
    audio.error();
    toast(err.message, 'err');
    btn.disabled = false;
  }
}

function renderShop() {
  if (shopTab === 'item') { renderBoosterShop(); return; }
  const grid = $('#shopGrid');
  const u = session.user;
  const items = shopItems.filter(i => i.cat === shopTab);
  grid.innerHTML = '';
  appendGiftBanner(grid);
  if (shopTab === 'ult') {
    const note = document.createElement('p');
    note.className = 'muted center';
    note.style.gridColumn = '1 / -1';
    note.innerHTML = tr(
      'ラインを消すと⚡ゲージが溜まり、MAXでHUDの⚡ボタンから<b>奥義</b>が撃てる！装備できるのは1つだけ。<br><small>'+JA+'</small>',
      'Clearing lines charges the ⚡ gauge — at MAX, fire your <b>ultimate</b> from the HUD button. One equipped at a time.<br><small>'+EN+'</small>');
    grid.appendChild(note);
  }
  items.forEach((item, idx) => {
    // Admin gear is implicitly owned by admins (never purchasable).
    // ゲストは「値段0のもの」ではなく「初期装備」だけ所持扱いにする。
    // 以前は price===0 だったので、ガチャ限定品（price:0）まで所持扱いになり、
    // 押しても何も起きない「装備する」が出ていた。
    const owned = item.adminOnly ? (u && u.role === 'admin')
      : u ? u.owned.includes(item.id) : !!item.default;
    const equipped = item.cat === 'ult'
      ? equippedUlt() === item.id
      : u ? u.equipped[item.cat] === item.id : !!item.default;
    const cur = item.currency === 'gems' ? '💎' : '🪙';
    // 値引きは「まだ買っていない・買える品」にだけ意味がある。
    const deal = (!owned && !item.adminOnly && !item.throneOnly && !item.gachaOnly) ? dealFor(item) : null;
    const el = document.createElement('div');
    el.className = `shop-item ${equipped ? 'equipped' : ''}`;
    el.style.animationDelay = `${Math.min(idx * 50, 400)}ms`;
    el.innerHTML = `
      <div class="shop-preview" data-pv="${item.id}"></div>
      <div class="shop-name">${item.adminOnly || item.throneOnly ? '👑 ' : ''}${catName(item)}</div>
      <div class="shop-desc">${catDesc(item)}</div>
      ${saleBadge(deal)}
      ${equipped
        ? `<button class="btn btn-sm btn-ghost" disabled>${tr('✓ 装備中', '✓ Equipped')}</button>`
        : owned
          ? `<button class="btn btn-sm btn-primary" data-act="equip">${tr('装備する', 'Equip')}</button>`
          : item.adminOnly
            ? `<button class="btn btn-sm btn-ghost" disabled>${tr('👑 運営専用', '👑 Staff only')}</button>`
            : item.throneOnly
              ? `<button class="btn btn-sm btn-ghost shop-gachaonly" disabled>${tr('👑 イベント専用', '👑 Event only')}</button>`
            : item.gachaOnly
              ? `<button class="btn btn-sm btn-ghost shop-gachaonly" disabled>${tr('🎰 ガチャ限定', '🎰 Gacha only')}</button>`
              : `<button class="btn btn-sm btn-gold" data-act="buy">${priceLabel(cur, item, deal)}</button>`}
    `;
    grid.appendChild(el);
    renderPreview(el.querySelector('.shop-preview'), item);
    const btn = el.querySelector('[data-act]');
    if (btn) btn.onclick = () => (btn.dataset.act === 'buy' ? buyItem(item) : equipItem(item));
  });
  startDealTimer();
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
  under:      { icon: '🕳️', ja: '地底踏破',      en: 'Depths Conqueror', cja: '地下ダンジョンB100を制覇',         cen: 'Conquer floor B100 of the Depths' },
  heaven:     { icon: '☁️', ja: '天界踏破',      en: 'Ascent Conqueror', cja: '天国ダンジョンH100を制覇',         cen: 'Conquer floor H100 of the Ascent' },
  abyss:      { icon: '🌑', ja: '深淵踏破',      en: 'Abyss Conqueror', cja: '深淵ダンジョンA100を制覇',          cen: 'Conquer floor A100 of the Abyss' },
  zero:       { icon: '👁️', ja: '断罪',          en: 'Condemned',       cja: '👁️断罪で段を割った回に参加する', cen: 'Be present when a stage falls in Condemned' },
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
  daily7:     { icon: '📅', ja: '日課の鬼',      en: 'Daily Devotee',   cja: 'デイリーチャレンジを7日連続クリア', cen: 'Clear the Daily Challenge 7 days in a row' },
  guildquest: { icon: '🎖️', ja: 'ギルドの誉れ',  en: 'Guild Honors',    cja: 'ギルド週間クエストを3本すべて達成して受け取る', cen: 'Claim all 3 weekly guild quests' },
};
// 🏛 シーズン刻印（s{N}champ）はシーズンごとに増えるのでここには並べない。
// 持っているぶんだけ renderInvBadges が末尾に足す（seasonBadgeInfo 参照）。
const BADGE_ORDER = ['oni', 'kami', 'souzou', 'maou', 'rush', 'dungeon', 'under', 'heaven', 'abyss', 'zero', 'tourney', 'royale', 'adminevent', 'weekly1', 'daily7', 'guildquest', 'puzzle', 'dig', 'ghost', 'bronze', 'silver', 'gold', 'crown2', 'crown3', 'crown5', 'crown7'];
// 👑 王座のボード名は [日本語, English] のペアで持つ。
// 以前は日本語だけの表で、引くときに tr(THRONE_LABEL[b], THRONE_LABEL[b]) と
// 第2引数にも同じ日本語を渡していたため、英語表示でもここだけ日本語のまま出ていた。
// （chat.js のプロフィールカードは対訳表を持っていて英語化されるので、
//   同じ王座がインベントリとチャットで違う言語に見えていた）
const THRONE_LABEL = {
  score:  ['🏆 ハイスコア',   '🏆 High Score'],
  rating: ['📈 レート',       '📈 Rating'],
  dungeon:['🏰 ダンジョン',   '🏰 Dungeon'],
  weekly: ['🎯 ウィークリー', '🎯 Weekly'],
  sprint: ['⏱️ タイムアタック', '⏱️ Time Attack'],
  puzzle: ['🧩 パズル遺跡',   '🧩 Puzzle Ruins'],
  dig:    ['⛏️ 採掘場',       '⛏️ The Mines'],
};

let invTab = 'gear';

export async function openInventory(tab = invTab) {
  showScreen('inventory');
  ensureInvDexTab();
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
      shopFetchedAt = Date.now();
      shopDeals = normalizeDeals(data.deals);
      shopGift = normalizeGift(data.gift || data.freeGift);
    }
  } catch (err) {
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderInvSummary();
  if (tab === 'gear') renderInvGear();
  else if (tab === 'item') renderInvItems();
  else if (tab === 'title') await renderInvTitles();
  else if (tab === 'dex') await renderInvDex();
  else renderInvBadges();
}

// 📚 図鑑タブのボタンは index.html 側にはまだ無い（担当が別）。無ければここで
// 足し、あればそれを使う ── 後から index.html に生えても二重にならない。
function ensureInvDexTab() {
  try {
    const tabs = $('#screen-inventory .tabs');
    if (!tabs || tabs.querySelector('[data-inv="dex"]')) return;
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.inv = 'dex';
    b.textContent = tr('📚 図鑑', '📚 Collection');
    b.onclick = () => { audio.click(); openInventory('dex'); };
    tabs.appendChild(b);
  } catch { /* タブ列の形が変わっても他のタブは死なせない */ }
}

// 管理者は「全ショップ所持・通貨無限」という表示上の嘘を持つので、
// 完成度を数字で出すと必ず嘘になる。そこだけ別扱いにする。
const invIsStaff = () => !!session.user && session.user.role === 'admin';

function invCollectibles() {
  return shopItems.filter(i => !i.adminOnly && !i.throneOnly && !i.default);
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
  ult: { ja: '⚡ 奥義', en: '⚡ Ultimates' },
};

function renderInvGear() {
  const body = $('#invBody');
  const u = session.user;
  body.innerHTML = '';
  for (const cat of ['skin', 'board', 'fx', 'ult']) {
    const all = shopItems.filter(i => i.cat === cat && (!i.adminOnly || staffExtras()));
    const owned = all.filter(i => i.adminOnly ? invIsStaff()
      : u ? (u.owned || []).includes(i.id) : !!i.default);
    // 👑 専用ショップの品はここでは数えない ── 「あとN種」を押すと
    // 通常ショップに飛ぶが、そこでは買えないので数に入れると嘘になる。
    const total = all.filter(i => !i.adminOnly && !i.throneOnly).length;
    const equippedId = cat === 'ult' ? equippedUlt()
      : u ? (u.equipped || {})[cat] : `${cat}_default`;
    const missing = total - owned.filter(i => !i.adminOnly && !i.throneOnly).length;

    const sec = document.createElement('div');
    sec.className = 'inv-sec';
    sec.innerHTML = `
      <div class="inv-sec-head">
        <span>${tr(CAT_TITLE[cat].ja, CAT_TITLE[cat].en)}</span>
        <span class="muted">${invIsStaff() ? '∞' : `${owned.filter(i => !i.adminOnly && !i.throneOnly).length} / ${total}`}</span>
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
        <div class="inv-name">${item.adminOnly || item.throneOnly ? '👑 ' : ''}${catName(item)}</div>
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
      // 英語側だけ古い手書き文字列が残っていて、ボスラッシュが抜けたうえに
      // 「無効なのは AI / Online / Weekly だけ」と読める嘘になっていた。
      // 奥義タブ・ブースターショップと同じく JA / EN 定数を参照する。
      'ゲーム中のHUDから使えます。<br><small>'+JA+'</small>',
      'Use them from the in-game HUD.<br><small>'+EN+'</small>')}</p>
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
  const gen = ++viewGen;
  let data;
  try { data = await api('/api/titles'); } catch (err) { if (gen !== viewGen) return; body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`; return; }
  if (gen !== viewGen) return;
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
        // キーは `id`。サーバー（/api/titles/equip）は req.body.id しか読まないので、
        // titleId で送っていた頃はインベントリの称号タブからの装備が必ず 404 になっていた。
        // プロフィール側（このファイルの showTitlesModal）と同じ形に揃える。
        await api('/api/titles/equip', { method: 'POST', body: { id: b.dataset.title } });
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
        <div class="inv-throne-row">${thrones.map(b => {
          // Array.isArray で引く。素の `THRONE_LABEL[b] ||` だと constructor 等の
          // プロトタイプ由来の値まで拾ってしまうため。未知のボードは id をそのまま出す。
          const L = THRONE_LABEL[b];
          return `<span class="inv-throne">${Array.isArray(L) ? tr(L[0], L[1]) : escapeHtml(b)}</span>`;
        }).join('')}</div>
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
      ${[...have].filter(b => seasonBadgeNo(b)).sort((a, b) => seasonBadgeNo(b) - seasonBadgeNo(a)).map(id => {
        // 🏛 シーズン刻印は BADGE_ORDER に固定では並べられない（シーズンごとに
        // 増える）。持っているぶんだけ、名前を動的に組み立てて末尾に足す。
        const b = seasonBadgeInfo(seasonBadgeNo(id));
        return `<div class="inv-badge">
          <span class="inv-badge-icon">${b.icon}</span>
          <span class="inv-badge-body">
            <b>${tr(b.ja, b.en)}</b>
            <small>✅ ${tr('獲得済み', 'Earned')}</small>
          </span>
        </div>`;
      }).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// 📚 コレクション図鑑（I10）
//
// カテゴリごとの収集率と、セットコンプ報酬の受取口。未所持はシルエットで
// 「あるのは分かるが正体は分からない」状態にし、どこで手に入るかだけ明記する。
//
// /api/collection がまだ無いサーバーでは、すでに手元にある /api/shop の品目から
// 同じ形を組み立てて表示する（セット報酬だけが出ない）。画面が空にならない。
// ---------------------------------------------------------------------------

const DEX_SOURCE = {
  shop:       ['🛍️ ショップで購入', '🛍️ Buy in the shop'],
  gacha:      ['🎰 ガチャ（SSR以上）', '🎰 Gacha (SSR+)'],
  throne:     ['👑 王座の欠片と交換', '👑 Trade throne shards'],
  battlepass: ['🎫 バトルパスの報酬', '🎫 Battle pass reward'],
  event:      ['🎪 イベント報酬', '🎪 Event reward'],
};
function dexSourceLabel(src) {
  const L = DEX_SOURCE[src];
  return Array.isArray(L) ? tr(L[0], L[1]) : tr('🛍️ ショップで購入', '🛍️ Buy in the shop');
}

// 図鑑1マスぶんの情報。セットの kind で引き先が変わる:
//   item  … ショップの装備（プレビューも流用できる）
//   boost … ブースター（ショップの「アイテム」タブ）
//   badge … BADGE_INFO（解除条件をそのまま入手経路として出す）
//   title … /api/titles のカタログ（loadTitles が入れている）
function dexEntryInfo(kind, id) {
  if (kind === 'badge') {
    const b = badgeInfoOf(id);
    return { name: b ? tr(b.ja, b.en) : id, icon: b ? b.icon : '🎖️',
      how: b ? tr(b.cja, b.cen) : tr('プレイして獲得', 'Earn it in-game'), item: null, go: null };
  }
  if (kind === 'title') {
    const t = titlesCatalog && titlesCatalog.find(x => x.id === id);
    return { name: t ? catName(t) : id, icon: '👑',
      how: t ? catDesc(t) : tr('条件を満たすと獲得', 'Unlocked by meeting its condition'), item: null, go: null };
  }
  if (kind === 'boost') {
    const it = (shopBoosters || []).find(x => x.id === id);
    return { name: it ? catName(it) : id, icon: it ? it.icon : '🧪',
      how: tr('🛍️ ショップの「アイテム」で購入', '🛍️ Buy from the shop’s Items tab'),
      item: null, go: () => openShop('item') };
  }
  const it = (shopItems || []).find(x => x.id === id);
  const src = it ? (it.throneOnly ? 'throne' : it.gachaOnly ? 'gacha' : 'shop') : 'shop';
  return {
    name: it ? catName(it) : id, icon: null, how: dexSourceLabel(src), item: it || null,
    // 👑王座の宝物庫は管理者イベント中しか開かないので、飛ばす先を作らない。
    go: src === 'gacha' ? () => openGacha() : src === 'throne' ? null : (it ? () => openShop(it.cat) : null),
  };
}

// /api/collection（catalog.js の collectionView）を画面用にならす。
function normalizeDexSets(data) {
  const raw = data && (data.sets || data.cats || data.collection);
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = raw.map(s => {
    const ids = Array.isArray(s.ids) ? s.ids : [];
    const ownedIds = new Set(Array.isArray(s.ownedIds) ? s.ownedIds : []);
    return {
      id: String(s.id || ''),
      icon: s.icon || '📦',
      kind: s.kind || 'item',
      name: (LANG === 'en' && s.nameEn ? s.nameEn : s.name) || String(s.id || ''),
      desc: (LANG === 'en' && s.descEn ? s.descEn : s.desc) || '',
      ids, ownedIds,
      owned: Number.isFinite(s.owned) ? s.owned : ownedIds.size,
      total: Number.isFinite(s.total) ? s.total : ids.length,
      done: !!s.done,
      claimed: !!s.claimed,
      coins: Number(s.coins) || 0,
      gems: Number(s.gems) || 0,
      titleName: s.titleName || '',
    };
  }).filter(s => s.ids.length);
  return out.length ? out : null;
}

// /api/collection がまだ無いサーバー用の代替。手元の /api/shop から
// カテゴリ別の収集率だけを組み立てる（セット報酬は出さない）。
function dexFallbackSets() {
  if (!shopItems) return null;
  const u = session.user;
  const has = i => i.default || invIsStaff() || (u ? (u.owned || []).includes(i.id) : false);
  return ['skin', 'board', 'fx', 'ult'].map(cat => {
    const list = shopItems.filter(i => i.cat === cat && !i.adminOnly);
    const ownedIds = new Set(list.filter(has).map(i => i.id));
    return {
      id: `set_${cat}`, icon: '📦', kind: 'item',
      name: tr(CAT_TITLE[cat].ja, CAT_TITLE[cat].en), desc: '',
      ids: list.map(i => i.id), ownedIds,
      owned: ownedIds.size, total: list.length,
      done: false, claimed: false, coins: 0, gems: 0, titleName: '',
    };
  }).filter(s => s.ids.length);
}

async function renderInvDex() {
  const body = $('#invBody');
  // タブ連打のレース対策は既存の renderInvTitles と同じ作法。
  const gen = ++viewGen;
  let data = null;
  try { data = await api('/api/collection'); } catch { data = null; }
  if (gen !== viewGen) return;
  const sets = normalizeDexSets(data) || dexFallbackSets();
  if (!sets || !sets.length) {
    body.innerHTML = `<p class="muted center">${tr('図鑑はまだありません', 'Nothing in the collection yet')}</p>`;
    return;
  }
  const hasReward = s => !!(s.coins || s.gems || s.titleName);
  const got = sets.reduce((a, s) => a + s.owned, 0);
  const slots = sets.reduce((a, s) => a + s.total, 0);
  const rate = slots ? Math.round((got / slots) * 100) : 0;
  const claimable = sets.filter(s => s.done && !s.claimed && hasReward(s)).length;
  // 図鑑のセット報酬は1日 claimPerDay セットまで（サーバーが再計算・多重受取を止める）。
  // claimsLeftToday が来ていて、受け取れる件数がそれを上回るときだけ注意書きを添える。
  const claimPerDay = data && Number.isFinite(data.claimPerDay) ? data.claimPerDay : null;
  const claimsLeft = data && Number.isFinite(data.claimsLeftToday) ? data.claimsLeftToday : null;
  const capHint = (claimsLeft !== null && claimable > claimsLeft)
    ? tr(`きょうは${claimPerDay || claimsLeft}セットまで（残り${claimable - claimsLeft}件は明日）`,
         `Up to ${claimPerDay || claimsLeft} set${(claimPerDay || claimsLeft) > 1 ? 's' : ''} today (${claimable - claimsLeft} more tomorrow)`)
    : '';

  const cell = (kind, id, owned) => {
    const info = dexEntryInfo(kind, id);
    const pv = info.item
      ? `<div class="inv-pv" data-dexpv="${escapeHtml(id)}"${owned ? '' : ' style="filter:grayscale(1) brightness(.25) contrast(.6)"'}></div>`
      : `<div class="inv-pv" style="display:flex;align-items:center;justify-content:center;font-size:26px${owned ? '' : ';filter:grayscale(1) brightness(.25) contrast(.6)'}">${escapeHtml(info.icon || '❓')}</div>`;
    return `<div class="inv-card"${owned ? ' style="cursor:default"' : ` style="opacity:.75" data-dexgo="${escapeHtml(kind)}|${escapeHtml(id)}"`}>
      ${pv}
      <div class="inv-name"${owned ? '' : ' style="color:var(--dim)"'}>${owned ? escapeHtml(info.name) : '？？？'}</div>
      <div class="inv-eq"${owned ? '' : ' style="background:none;color:var(--muted);font-size:10px;font-weight:600"'}>${
        owned ? `✅ ${tr('所持', 'Owned')}` : escapeHtml(info.how)}</div>
    </div>`;
  };

  body.innerHTML = `
    <div class="inv-sec-head">
      <span>📚 ${tr('コレクション図鑑', 'Collection')}</span>
      <span class="muted">${fmt(got)} / ${fmt(slots)}（${rate}%）</span>
    </div>
    <span class="inv-bar"><span style="width:${rate}%"></span></span>
    <p class="muted center inv-note">${tr('灰色はまだ持っていない品です。入手できる場所を各マスに書いています',
      'Greyed-out entries are still missing — each one lists where to get it')}</p>
    ${claimable && session.user
      ? `<button class="btn btn-gold" id="dexClaimAll" style="width:100%;margin-bottom:${capHint ? '4' : '10'}px">🎁 ${tr(`受け取れるセット報酬が${claimable}件あります`, `${claimable} set reward${claimable > 1 ? 's' : ''} ready to claim`)}</button>${
          capHint ? `<p class="muted center" style="font-size:12px;margin:0 0 10px">🎁 ${escapeHtml(capHint)}</p>` : ''}`
      : ''}
    ${sets.map(s => {
      const pct = Math.round((s.owned / Math.max(1, s.total)) * 100);
      return `
      <div class="inv-sec">
        <div class="inv-sec-head">
          <span>${escapeHtml(s.icon)} ${escapeHtml(s.name)}</span>
          <span class="muted">${fmt(s.owned)} / ${fmt(s.total)}（${pct}%）</span>
        </div>
        ${s.desc ? `<p class="muted inv-note" style="margin:0">${escapeHtml(s.desc)}</p>` : ''}
        <span class="inv-bar"><span style="width:${pct}%"></span></span>
        <div class="inv-grid">
          ${s.ids.map(id => cell(s.kind, id, s.ownedIds.has(id))).join('')}
        </div>
        ${hasReward(s) ? `
          <div class="ms-row ${s.claimed ? 'claimed' : s.done ? 'done' : ''}">
            <div class="ms-info">
              <div class="ms-name">🎁 ${tr('セットコンプ報酬', 'Set completion reward')}</div>
              <div class="ms-prog">${s.titleName
                ? tr(`全部そろえると受け取れます ・ 称号《${s.titleName}》つき`, `Claimable once the set is complete — includes the title 《${s.titleName}》`)
                : tr('全部そろえると受け取れます', 'Claimable once the set is complete')}</div>
            </div>
            ${rewardChip(s.coins, s.gems)}
            ${s.claimed
              ? '<span class="ms-check">✓</span>'
              : `<button class="btn btn-sm ${s.done ? 'btn-gold' : 'btn-ghost'}" data-dexclaim="${escapeHtml(s.id)}" ${s.done ? '' : 'disabled'}>${s.done ? tr('受取', 'Claim') : tr('未達成', 'Locked')}</button>`}
          </div>` : ''}
      </div>`;
    }).join('')}`;

  // プレビューはショップ用の描画を流用する（未所持は上のフィルタで黒く潰れてシルエットになる）。
  body.querySelectorAll('[data-dexpv]').forEach(el => {
    const item = (shopItems || []).find(i => i.id === el.dataset.dexpv);
    if (item) renderPreview(el, item);
  });

  // 未所持のマスは入手先へ送る（ショップの該当タブ／ガチャ）。
  body.querySelectorAll('[data-dexgo]').forEach(card => {
    const [kind, id] = String(card.dataset.dexgo).split('|');
    const go = dexEntryInfo(kind, id).go;
    if (go) { card.style.cursor = 'pointer'; bindActivate(card, () => { audio.click(); go(); }); }
    else card.style.cursor = 'default';
  });

  const claim = async (id, btn) => {
    if (!session.user) { showAuthModal(); return; }
    if (btn) btn.disabled = true;
    try {
      // 金額はサーバーが COLLECTION_SETS から再計算する。ここは id を渡すだけ。
      const res = await api('/api/collection/claim', { method: 'POST', body: { id } });
      const r = (res && res.reward) || res || {};
      audio.coin();
      confettiBurst(r.ids && r.ids.length > 1 ? 60 : 30);
      updateTopbar();
      toast(tr(`🎁 セットコンプ報酬を受け取りました！${r.coins ? ` 🪙${fmt(r.coins)}` : ''}${r.gems ? ` 💎${fmt(r.gems)}` : ''}${r.titles && r.titles.length ? ' ＋👑称号' : ''}`,
        `🎁 Set reward claimed!${r.coins ? ` 🪙${fmt(r.coins)}` : ''}${r.gems ? ` 💎${fmt(r.gems)}` : ''}${r.titles && r.titles.length ? ' + 👑 title' : ''}`), 'ok', 3500);
      renderInvDex();
    } catch (err) {
      audio.error();
      toast(err.message, 'err');
      if (btn) btn.disabled = false;
    }
  };
  body.querySelectorAll('[data-dexclaim]:not([disabled])').forEach(btn => {
    btn.onclick = () => claim(btn.dataset.dexclaim, btn);
  });
  const all = body.querySelector('#dexClaimAll');
  if (all) all.onclick = () => claim('*', all);
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
  note.textContent = tr('消費アイテム。ゲーム中のHUDから発動！'+JA, 'Consumables. Activate them from the in-game HUD. '+EN);
  grid.appendChild(note);
  appendGiftBanner(grid);
  shopBoosters.forEach((item, idx) => {
    const count = u ? (u.items && u.items[item.id]) || 0 : null;
    const deal = item.adminOnly ? null : dealFor(item);
    const el = document.createElement('div');
    el.className = 'shop-item';
    el.style.animationDelay = `${Math.min(idx * 50, 400)}ms`;
    el.innerHTML = `
      <div class="shop-preview booster-preview">${item.icon}</div>
      <div class="shop-name">${catName(item)}${count !== null ? ` <span class="muted">×${fmt(count)}</span>` : ''}</div>
      <div class="shop-desc">${catDesc(item)}</div>
      ${saleBadge(deal)}
      <button class="btn btn-sm btn-gold" data-act="buy">${priceLabel('🪙', item, deal)}</button>
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
  startDealTimer();
}

// ---------------------------------------------------------------------------
// Capsule machine (gacha)
// ---------------------------------------------------------------------------

const RARITY_LABEL = { N: tr('ノーマル', 'Normal'), R: tr('レア', 'Rare'), SR: tr('スーパーレア', 'Super Rare'), SSR: tr('激レア', 'Ultra Rare'), UR: tr('超激レア', 'Legendary') };

// 割引なしの定価（サーバーの GACHA_COST_1 / GACHA_COST_10 と同じ）。
// モーダルは即座に出したいので、まずこの値で描いてから /api/gacha/info の
// 実価格でラベルを差し替える。取得に失敗しても定価が残るだけで済む。
const GACHA_BASE_1 = 500;
const GACHA_BASE_10 = 4500;

export function openGacha() {
  if (!session.user) { showAuthModal(); return; }
  audio.click();
  const pityMax = 40;
  // 管理者は無課金で回せる（server 側で coins を引かない）ので、値段を出すと嘘になる。
  const freePull = session.user.role === 'admin';
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
    <p id="gcEvent" class="center hidden" style="font-size:11px;margin-bottom:6px"></p>
    <div id="gcResults" class="gacha-results"></div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="gcClose">${tr('閉じる', 'Close')}</button>
      <button class="btn btn-primary" id="gcPull1">${tr('1回', '1 pull')} <span id="gcCost1">🪙${fmt(GACHA_BASE_1)}</span></button>
      <button class="btn btn-gold" id="gcPull10">${tr('10連', '10 pulls')} <span id="gcCost10">🪙${fmt(GACHA_BASE_10)}</span><small style="display:block;font-size:9px">${tr('SR以上1枠確定', '1 SR+ guaranteed')}</small></button>
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
  // 値段はイベント（🍀 ラッキーデー = 20%オフ）で変わる。以前はボタンに
  // 「1回 🪙500」と決め打ちしていたので、割引中は表示 500・実請求 400 と食い違い、
  // せっかくの割引もレア確率アップも画面上ではまったく分からなかった。
  // /api/gacha/info はそのために cost1 / cost10 / discounted / lucky を返している。
  const setPrices = d => {
    const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
    const c1 = num(d.cost1, GACHA_BASE_1), c10 = num(d.cost10, GACHA_BASE_10);
    const b1 = num(d.base1, GACHA_BASE_1), b10 = num(d.base10, GACHA_BASE_10);
    const price = (cost, base) => freePull
      ? tr('無料', 'Free')
      : cost < base ? `<s style="opacity:.55">🪙${fmt(base)}</s> 🪙${fmt(cost)}` : `🪙${fmt(cost)}`;
    m.querySelector('#gcCost1').innerHTML = price(c1, b1);
    m.querySelector('#gcCost10').innerHTML = price(c10, b10);
    const notes = [];
    if (!freePull && c1 < b1) {
      const off = Math.round((1 - c1 / b1) * 100);
      notes.push(tr(`🍀 イベント割引 ${off}%オフ`, `🍀 Event discount: ${off}% off`));
    }
    if (d.lucky) notes.push(tr('✨ レア排出率アップ中', '✨ Rare rates boosted'));
    const ev = m.querySelector('#gcEvent');
    ev.textContent = notes.join(' ・ ');
    ev.classList.toggle('hidden', notes.length === 0);
  };
  if (freePull) setPrices({});
  api('/api/gacha/info').then(d => { setPrices(d); setBars(d.pity, d.collection); }).catch(() => {});
  const pull = async count => {
    const b1 = m.querySelector('#gcPull1'), b10 = m.querySelector('#gcPull10');
    b1.disabled = b10.disabled = true;
    try {
      const data = await api('/api/gacha', { method: 'POST', body: { count } });
      session.user = data.user;
      updateTopbar();
      m.querySelector('#gcCoins').textContent = `🪙 ${fmt(data.user.coins)}`;
      setBars(data.pity, data.collection);
      // モーダルを開いたままイベントが始まる／終わることがあるので、値段も引き直す。
      // （表示だけ古いままだと、また「表示と請求額が違う」に戻ってしまう）
      api('/api/gacha/info').then(setPrices).catch(() => {});
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
    if (item.cat !== 'ult') {
      // 無言の return をやめる。押して何も起きないのが、いちばん困る。
      toast(tr('装備を保存するにはアカウント登録が必要です', 'You need an account to save your loadout'), 'err', 3000);
      return;
    }
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
  const gen = ++viewGen;
  $$('[data-ms]').forEach(x => x.classList.toggle('active', x.dataset.ms === tab));
  const body = $('#msBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;

  if (tab === 'ach') {
    try {
      achCache = (await api('/api/achievements')).achievements;
    } catch (err) {
      if (gen !== viewGen) return;
      body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (gen !== viewGen) return;
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
    if (gen !== viewGen) return;
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (gen !== viewGen) return;
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
  // 🔁 リロール（I12）。回数と次の値段はサーバーが missions.rerolls で教えてくる
  // （デイリー／ウィークリーは別枠。1回目が0＝1日1回無料）。返してこない旧版では
  // 「1日1回無料」の既定表示で出し、可否と金額の判定はサーバーに任せる。
  const rr = (data.rerolls && data.rerolls[daily ? 'daily' : 'weekly']) || null;
  const rrCost = rr && Number.isFinite(Number(rr.cost)) ? Number(rr.cost) : 500;
  // 💎払いの値段（サーバーが costGems を返したときだけ。無料枠では出さない）。
  const rrCostGems = rr && Number.isFinite(Number(rr.costGems)) ? Number(rr.costGems) : 0;
  const rrFree = rr ? !!rr.free : true;
  const rrLeft = rr && Number.isFinite(Number(rr.left)) ? Number(rr.left) : null;
  const rrOut = rrLeft !== null && rrLeft <= 0;
  const rrLeftJa = rrLeft === null ? '' : `（あと${rrLeft}回）`;
  const rrLeftEn = rrLeft === null ? '' : ` (${rrLeft} left)`;
  const rrLabel = rrFree ? tr('無料', 'Free') : `🪙${fmt(rrCost)}`;
  const rrHint = rrOut
    ? tr('🔁 引き直しは本日ぶんを使い切りました', '🔁 No rerolls left today')
    : rrFree
      ? tr(`🔁 引き直し 本日1回無料${rrLeftJa}`, `🔁 Reroll: free today${rrLeftEn}`)
      : tr(`🔁 引き直し 1回 🪙${fmt(rrCost)}${rrLeftJa}`, `🔁 Reroll: 🪙${fmt(rrCost)} each${rrLeftEn}`);
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
          <br>${rrHint}
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
            : `${rrOut ? '' : `<button class="btn btn-sm btn-ghost" data-reroll="${escapeHtml(String(r.id))}"${r.done ? ' data-reroll-done="1"' : ''} title="${rrFree
                  ? tr('別のミッションに引き直す（本日1回無料）', 'Swap for another mission (free today)')
                  : tr(`別のミッションに引き直す（🪙${fmt(rrCost)}）`, `Swap for another mission (🪙${fmt(rrCost)})`)}"
                style="padding:4px 8px;line-height:1.1">🔁<small style="display:block;font-size:9px">${rrLabel}</small></button>${
                !rrFree && rrCostGems > 0
                  ? `<button class="btn btn-sm btn-ghost" data-reroll-gems="${escapeHtml(String(r.id))}"${r.done ? ' data-reroll-done="1"' : ''} title="${tr(`💎で引き直す（💎${fmt(rrCostGems)}）`, `Reroll with gems (💎${fmt(rrCostGems)})`)}"
                    style="padding:4px 8px;line-height:1.1">🔁<small style="display:block;font-size:9px">💎${fmt(rrCostGems)}</small></button>` : ''}`}
              <button class="btn btn-sm ${r.done ? 'btn-gold' : 'btn-ghost'}" data-claim="${r.id}" ${r.done ? '' : 'disabled'}>${r.done ? tr('受取', 'Claim') : tr('未達成', 'Locked')}</button>`}
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

  // 🔁 引き直し。🪙コイン払い（data-reroll）と💎ジェム払い（data-reroll-gems）で
  // 入口を分ける。通貨も金額もサーバーが確定させる（クライアントは希望だけ渡す）。
  const doReroll = async (btn, id, currency) => {
    // 達成済み（未受取）を引き直すと報酬ごと消える。ここだけは無料でも確認する。
    if (btn.dataset.rerollDone && !confirm(tr(
      'このミッションはもう達成しています。引き直すと報酬を受け取れなくなります。よろしいですか？',
      'This mission is already complete — rerolling forfeits its reward. Continue?'))) return;
    if (currency === 'gems') {
      if (rrCostGems > 0 && !confirm(tr(
        `このミッションを別のものに引き直します。ジェム${fmt(rrCostGems)}を消費します。よろしいですか？`,
        `Reroll this mission for ${fmt(rrCostGems)} gems?`))) return;
    } else if (!rrFree && !confirm(tr(
      `このミッションを別のものに引き直します。コイン${fmt(rrCost)}を消費します。よろしいですか？`,
      `Reroll this mission for ${fmt(rrCost)} coins?`))) return;
    btn.disabled = true;
    try {
      // 消費と抽選はサーバー側。ここは id と「どちらで払うか」を渡すだけで、金額は申告しない。
      // 返ってくる user は api() が session に反映するので refreshMe は要らない。
      const res = await api('/api/missions/reroll', { method: 'POST', body: currency === 'gems' ? { id, currency: 'gems' } : { id } });
      missionsCache = (res && res.missions) || (await api('/api/missions')).missions;
      audio.click();
      updateTopbar();
      const rw = (res && res.reroll) || {};
      const paidGems = Number(rw.gems) || 0;
      const paidCoins = Number(rw.cost) || 0;
      const cost = rw.currency === 'gems' || paidGems
        ? (paidGems ? `（-💎${fmt(paidGems)}）` : '')
        : (paidCoins ? `（-🪙${fmt(paidCoins)}）` : '');
      const costEn = rw.currency === 'gems' || paidGems
        ? (paidGems ? ` (-💎${fmt(paidGems)})` : '')
        : (paidCoins ? ` (-🪙${fmt(paidCoins)})` : '');
      toast(tr(`🔁 ミッションを引き直しました！${cost}`, `🔁 Mission rerolled!${costEn}`), 'ok');
      renderMissions();
      refreshMissionDot();
    } catch (err) {
      audio.error();
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
  body.querySelectorAll('[data-reroll]').forEach(btn => {
    btn.onclick = () => doReroll(btn, btn.dataset.reroll, 'coins');
  });
  body.querySelectorAll('[data-reroll-gems]').forEach(btn => {
    btn.onclick = () => doReroll(btn, btn.dataset.rerollGems, 'gems');
  });

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
          <b>+${fmt(r.coins)}🪙 +${fmt(r.gems)}💎${r.badge ? ` +${(badgeInfoOf(r.badge) || { icon: '🏅' }).icon}` : ''}</b>
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
      // 貰えるバッジは週間チャンピオン🏅だけではない（🏛シーズン刻印など）ので、
      // 表示定義から名前を引く。未知のidは黙って伏せる（生のidは出さない）。
      const got = (res.reward.badges || []).map(b => badgeInfoOf(b)).filter(Boolean);
      toast(tr(`🏆 ランキング報酬を受け取りました！ +${fmt(res.reward.coins)}🪙 +${fmt(res.reward.gems)}💎${got.length ? `（${got.map(b => `${b.icon}${b.ja}`).join('・')}獲得！）` : ''}`,
        `🏆 Rewards claimed! +${fmt(res.reward.coins)}🪙 +${fmt(res.reward.gems)}💎${got.length ? ` (${got.map(b => `${b.icon} ${b.en}`).join(', ')}!)` : ''}`), 'ok', 4500);
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
// （🤝 フレンド申請のドット #friendDot は friends.js が持っている。
//   同じ器を2か所から書くと、片方の古い数でもう片方が上書きされる）
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
  if (buyBtn) buyBtn.onclick = () => {
    // 500💎 が確認なしのワンタップで飛んでいた。しかもシーズンが終われば
    // 効果は消えるので、残り日数を必ず見せてから確認を取る。
    const m = showModal([
      `<h2>👑 ${tr('プレミアムパス', 'Premium Pass')}</h2>`,
      `<p class="center">${tr(`💎 ${fmt(data.premiumPriceGems)} を使って解放します。`, `Unlock for 💎 ${fmt(data.premiumPriceGems)}.`)}</p>`,
      `<p class="muted center" style="font-size:12px">${tr(
        `このシーズン（残り ${daysLeft}日）だけ有効です。シーズンが変わると効果は無くなります。`,
        `Valid for this season only — ${daysLeft} days left. It does not carry over.`)}</p>`,
      daysLeft <= 3
        ? `<p class="center" style="color:#ffa93d;font-size:12.5px;font-weight:700">${tr(
            '⚠️ シーズン終了が近いです。次のシーズンまで待つほうがお得かもしれません。',
            '⚠️ The season ends soon — waiting for the next one may be better value.')}</p>`
        : '',
      '<div class="modal-buttons">',
      `  <button class="btn btn-ghost" id="bpNo">${tr('やめる', 'Cancel')}</button>`,
      `  <button class="btn btn-gold" id="bpYes">${tr('解放する', 'Unlock')}</button>`,
      '</div>',
    ].join(''));
    m.querySelector('#bpNo').onclick = closeModal;
    m.querySelector('#bpYes').onclick = async () => {
      closeModal();
      await doBuyPremium();
    };
  };

  async function doBuyPremium() {
    try {
      await api('/api/battlepass/premium', { method: 'POST' });
      audio.levelUp();
      toast(tr('プレミアムパスを解放しました！', 'Premium pass unlocked!'), 'ok');
      updateTopbar();
      openBattlePass();
    } catch (err) { audio.error(); toast(err.message, 'err'); }
  };

  tiersEl.innerHTML = '';
  // どちらの列が無料で、どちらが課金かの見出しが無かった。
  // 見出しが無いと、届いているのに受け取れない報酬が「受け取れそう」に見える。
  const head = document.createElement('div');
  head.className = 'bp-tier bp-head';
  head.innerHTML = `
    <div class="bp-tier-num"></div>
    <div class="bp-cell bp-col-head">${tr('無料', 'Free')}</div>
    <div class="bp-cell bp-col-head premium-cell">${(prog && prog.premium) ? tr('👑 プレミアム', '👑 Premium') : tr('👑 プレミアム（未解放）', '👑 Premium (locked)')}</div>`;
  tiersEl.appendChild(head);

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
      // 到達しているのにプレミアム未加入で受け取れない場合、
      // 何も出さないと「押せば取れそう」に見えてしまう。理由を書く。
      const needPremium = unlocked && !claimed && track === 'premium' && prog && !prog.premium;
      return `
        <div class="bp-cell ${track === 'premium' ? 'premium-cell' : ''} ${!unlocked ? 'locked' : ''} ${claimed ? 'claimed' : ''}">
          <span class="rw-icon">${icon}</span><span>${label}</span>
          ${claimable ? `<button class="bp-claim-btn" data-tier="${t.tier}" data-track="${track}">${tr('受取', 'Claim')}</button>` : ''}
          ${needPremium ? `<button class="bp-need-premium" data-need="1">${tr('👑 プレミアムで解放', '👑 Unlock with Premium')}</button>` : ''}
        </div>`;
    };
    el.innerHTML = `
      <div class="bp-tier-num ${unlocked ? 'unlocked' : ''}">${t.tier}</div>
      ${cell(t.free, 'free')}
      ${cell(t.premium, 'premium')}`;
    tiersEl.appendChild(el);
  });

  tiersEl.querySelectorAll('[data-need]').forEach(btn => {
    btn.onclick = () => {
      const buy = $('#bpBuyPremium');
      if (buy) { buy.scrollIntoView({ behavior: 'smooth', block: 'center' }); buy.click(); }
    };
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
      <div class="stat-card"><b>¥${fmt(txData.totalJpy)}</b><span>売上(デモ) ${fmt(txData.totalCount)}件</span></div>
      ${statCard(stats.dbBytes == null ? null : fmtBytes(stats.dbBytes), 'DBサイズ')}
      ${statCard(stats.saveMs == null ? null : `${Math.round(Number(stats.saveMs))}ms`, '保存にかかる時間')}
      ${statCard(stats.txLive == null ? null : fmt(stats.txLive), '取引ログ（現行）')}
      ${statCard(stats.txArchived == null ? null : fmt(stats.txArchived), '取引ログ（保管済）')}
      ${statCard(eventLoopText(stats), 'イベントループ遅延(P99)')}
      ${statCard(perfRssText(stats), 'メモリ(RSS)')}
      ${statCard(stats.persistError ? '⚠️' : null, `保存エラー: ${String(stats.persistError || '').slice(0, 60)}`, 'border-color:var(--red)')}
      ${statCard(stats.clientErrors && stats.clientErrors.open != null ? fmt(stats.clientErrors.open) : null, 'クライアントエラー(未解決)')}`;
    $('#btnMaintenance').textContent = stats.maintenance ? '✅ メンテ解除' : '🛠 メンテナンス開始';
    renderAdminUsers(usersData.users);
  } catch (err) {
    statsEl.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

// 値が無い（null / undefined）指標はカードごと出さない。「—」のカードを並べると
// 「0 件」なのか「まだ測っていない」のか区別できなくなる。
function statCard(value, label, style = '') {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="stat-card"${style ? ` style="${style}"` : ''}><b>${value}</b><span>${escapeHtml(label)}</span></div>`;
}

// イベントループ遅延は stats.perf.lagP99（まだ1回も測っていなければ null）。
// 素の数値／別名で来ても読めるようにしてある。
function eventLoopText(stats) {
  const p = stats.perf || {};
  const v = p.lagP99 ?? p.lagP50 ?? stats.eventLoop ?? stats.eventLoopLag ?? stats.eventLoopMs;
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' ? (v.p99 ?? v.lagMs ?? v.mean ?? v.p50) : v;
  return (n === null || n === undefined || !Number.isFinite(Number(n))) ? null : `${Number(n).toFixed(1)}ms`;
}

function perfRssText(stats) {
  const rss = stats.perf && stats.perf.rss;
  return rss === null || rss === undefined || !Number.isFinite(Number(rss)) ? null : fmtBytes(Number(rss));
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

const CAT_LABEL = { skin: '🧱 ブロックスキン', board: '🎨 ボードテーマ', fx: '✨ 消去エフェクト', ult: '⚡ 奥義' };
const BADGE_LABEL = {
  bronze: '🥉ブロンズ', silver: '🥈シルバー', gold: '🥇ゴールド', oni: '👹鬼', kami: '🔱神',
  souzou: '🌌創造神', maou: '😈魔王', rush: '⚔️ラッシュ', dungeon: '🏰百塔', tourney: '🏆大会',
  royale: '💯ロイヤル', adminevent: '👑管理者イベント', abyss: '🌑深淵', weekly1: '🏅週間',
  puzzle: '🧩遺跡', dig: '⛏️採掘', crown2: '👑二冠', crown3: '👑三冠', crown5: '👑五冠',
  crown7: '🌈全冠', ghost: '👻幽霊屋敷', daily7: '📅日課の鬼',
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
  // 🧩 工房通報の該当ステージコード。専用の口で来たものは b.stage.code に、
  // フォールバック（/api/bugreport）で来たものは本文頭の「コード XXXXXX」に載る。
  const wsCodeOf = b => {
    if (b.kind === 'workshop' && b.stage && b.stage.code) return String(b.stage.code).toUpperCase();
    const mm = String(b.text || '').match(/\[通報\/工房\][^]*?コード\s*([A-Z0-9]{4,8})/i);
    return mm ? mm[1].toUpperCase() : '';
  };
  const row = b => {
    const wsCode = wsCodeOf(b);
    return `
    <div class="feed-row ${b.status === 'done' ? '' : 'real'}" data-bug="${b.id}" style="align-items:flex-start">
      <span class="feed-icon">${b.status === 'done' ? '✅' : b.kind === 'workshop' || wsCode ? '🚩' : '🐛'}</span>
      <span class="feed-text" style="white-space:pre-wrap">${escapeHtml(b.text)}${
        b.kind === 'workshop' && b.stage ? `
        <small class="muted" style="display:block;margin-top:2px">🧩 ${escapeHtml(b.stage.title || '(無題)')} ・ 👤 ${escapeHtml(b.stage.author || '(不明)')} ・ コード ${escapeHtml(String(b.stage.code || wsCode))}</small>` : ''}
        <small class="muted" style="display:block;margin-top:2px">${escapeHtml(b.by)}${b.role === 'guest' ? '（ゲスト）' : ''} ・ ${new Date(b.at).toLocaleString('ja-JP')}</small></span>
      <span style="display:flex;flex-direction:column;gap:4px">
        ${b.status === 'done' ? '' : `<button class="btn btn-sm btn-ghost" data-done="${b.id}">✅</button>`}
        ${wsCode ? `<button class="btn btn-sm btn-ghost" data-wsdel="${escapeHtml(wsCode)}" style="color:var(--red)" title="該当ステージを削除">🗑ステージ</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-del="${b.id}" style="color:var(--red)">🗑</button>
      </span>
    </div>`;
  };
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
  // 🚩工房通報 → 該当ステージをこの画面から直接削除（通報→削除を1画面で完結）。
  m.querySelectorAll('[data-wsdel]').forEach(b => {
    b.onclick = async () => {
      const code = b.dataset.wsdel;
      if (!confirm(`工房ステージ ${code} を削除しますか？（元に戻せません）`)) return;
      b.disabled = true;
      try {
        await api(`/api/workshop/stages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        toast(`ステージ ${code} を削除しました`, 'ok');
      } catch (err) {
        // 既に消えている（404）なら「消えている」で足り、通報は処理済みにできる。
        toast(err.status === 404 ? `ステージ ${code} は既にありません` : err.message, err.status === 404 ? 'ok' : 'err');
        if (err.status !== 404) { b.disabled = false; return; }
      }
    };
  });
}

// ⚠️ 管理者用クライアントエラービューア（I27）— ブラウザ側で起きた例外の集計。
// 🐛バグ報告と同じ形（一覧＋✅で処理済み）。API がまだ無いサーバーでは
// 「まだありません」と出るだけで、パネルは壊れない。
function normalizeClientErrors(data) {
  const raw = (data && (data.errors || data.rows || data.reports || data.list)) || [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map((e, i) => ({
    id: String(e.hash ?? e.id ?? e.key ?? i),
    message: String(e.message || e.msg || e.text || e.error || '(メッセージなし)'),
    where: String(e.where || e.url || e.page || ''),
    stack: String(e.stack || ''),
    count: Number(e.count ?? e.n) || 1,
    lastAt: Number(e.lastAt ?? e.at ?? e.last ?? e.updatedAt) || 0,
    ua: String(e.ua || e.userAgent || ''),
    lang: String(e.lang || ''),
    screen: String(e.screen || ''),
    by: String(e.by || ''),
    resolved: !!(e.resolved ?? (e.status === 'done')),
  }));
}

async function showClientErrorsAdminModal() {
  let rows = [];
  let errMsg = '';
  try {
    rows = normalizeClientErrors(await api('/api/admin/clienterrors'));
  } catch (err) {
    // 404（＝サーバー側がまだ無い）は「報告ゼロ」と同じ扱いにする。
    if (err.status !== 404) errMsg = err.message;
  }
  const row = e => `
    <div class="feed-row ${e.resolved ? '' : 'real'}" style="align-items:flex-start">
      <span class="feed-icon">${e.resolved ? '✅' : '⚠️'}</span>
      <span class="feed-text" style="white-space:pre-wrap;min-width:0;word-break:break-word">${escapeHtml(e.message)}
        ${e.where ? `<small class="muted" style="display:block">📄 ${escapeHtml(e.where)}</small>` : ''}
        ${e.stack ? `<small class="muted" style="display:block">${escapeHtml(e.stack)}</small>` : ''}
        <small class="muted" style="display:block;margin-top:2px">×${fmt(e.count)} ・ 最終 ${e.lastAt ? new Date(e.lastAt).toLocaleString('ja-JP') : '—'}${e.by ? ` ・ ${escapeHtml(e.by)}` : ''}${e.screen ? ` ・ ${escapeHtml(e.screen)}` : ''}${e.lang ? ` ・ ${escapeHtml(e.lang)}` : ''}</small>
        ${e.ua ? `<small class="muted" style="display:block">${escapeHtml(e.ua)}</small>` : ''}</span>
      <span style="display:flex;flex-direction:column;gap:4px">
        ${e.resolved ? '' : `<button class="btn btn-sm btn-ghost" data-ce-done="${escapeHtml(e.id)}" title="解決済みにする">✅</button>`}
        <button class="btn btn-sm btn-ghost" data-ce-del="${escapeHtml(e.id)}" style="color:var(--red)" title="この記録を削除">🗑</button>
      </span>
    </div>`;
  const open = rows.filter(e => !e.resolved).length;
  const m = showModal(`
    <h2>⚠️ クライアントエラー（未解決 ${open} / 全 ${rows.length}）</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">プレイヤーのブラウザで起きた例外の集計です</p>
    <div class="feed-list" style="max-height:52vh">
      ${rows.length ? rows.map(row).join('') : `<p class="muted center">${escapeHtml(errMsg || 'クライアントエラーの報告はまだありません')}</p>`}
    </div>
    <div class="modal-buttons">
      ${rows.length ? '<button class="btn btn-ghost" id="ceClear" style="color:var(--red)">🧹 全消去</button>' : ''}
      <button class="btn btn-primary" id="ceClose">閉じる</button>
    </div>`);
  m.querySelector('#ceClose').onclick = closeModal;
  const clr = m.querySelector('#ceClear');
  if (clr) clr.onclick = async () => {
    if (!confirm('クライアントエラーの記録をすべて消去します。よろしいですか？')) return;
    try { await api('/api/admin/clienterrors/all', { method: 'DELETE' }); closeModal(); showClientErrorsAdminModal(); }
    catch (err) { toast(err.message, 'err'); }
  };
  m.querySelectorAll('[data-ce-del]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try { await api(`/api/admin/clienterrors/${encodeURIComponent(b.dataset.ceDel)}`, { method: 'DELETE' }); closeModal(); showClientErrorsAdminModal(); }
      catch (err) { toast(err.message, 'err'); b.disabled = false; }
    };
  });
  m.querySelectorAll('[data-ce-done]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        // resolved / status のどちらを読むサーバーでも通るように両方送る。
        await api(`/api/admin/clienterrors/${encodeURIComponent(b.dataset.ceDone)}`, { method: 'POST', body: { resolved: true, status: 'done' } });
        closeModal();
        showClientErrorsAdminModal();
      } catch (err) { toast(err.message, 'err'); b.disabled = false; }
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
      const counts = `追加${r.added}人 / 更新${r.updated}人 / 維持${r.kept}人 → 合計${fmt(r.after)}人`;
      // res.snapshot は「復元の直前に退避したスナップショットのファイル名」。
      // サーバーが null を返すのは退避を1バイトも書けなかった印（ディスクが
      // 読み取り専用／満杯など）で、つまり **この復元は元に戻せない**。
      // ここで祝ってしまうと、管理者は「間違えても巻き戻せる」と思ったまま
      // 先へ進み、上書き前のデータがもうどこにも無いことに後で気づく。
      // サーバーは失敗の合図を既に送ってきているので、捨てずに警告として出す。
      // （undefined＝この項目を返さないサーバーでは誤警報を出さないよう、
      //   厳密に null のときだけ警告する）
      if (res.snapshot === null) {
        toast(`⚠️ 復元しました（${counts}）が、巻き戻し用のスナップショットを保存できませんでした。この復元は元に戻せません`, 'err', 9000);
      } else {
        audio.coin();
        confettiBurst(40);
        toast(`♻️ 復元完了！ ${counts}`, 'ok', 6000);
      }
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
            // 復元と同じ理由で、退避が撮れていないときは祝わない。
            // 巻き戻しは「戻しすぎた」ときにもう一度戻す必要が出やすいので、
            // 退避が無いことはこちらのほうが痛い。
            if (res.snapshot === null) {
              toast(`⚠️ 巻き戻しました（${fmt(res.report.after)}人）が、退避スナップショットを保存できませんでした。この操作は取り消せません`, 'err', 9000);
            } else {
              toast(`♻️ 巻き戻しました（${fmt(res.report.after)}人）`, 'ok', 5000);
            }
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
      // 天井（restoreLimitBytes）に対する重さをヘッダから読む。削られたら必ず知らせ、
      // 削らずに済んでも8割を越えていたら警告する ── ここが唯一の早期警告になる。
      const trimmed = res.headers.get('X-Backup-Trimmed');
      const bytes = Number(res.headers.get('X-Backup-Bytes')) || 0;
      const limit = Number(res.headers.get('X-Backup-Limit-Bytes')) || 0;
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `block-blitz-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('💾 バックアップをダウンロードしました', 'ok');
      if (trimmed) {
        toast(tr(`🎞 サイズ上限のため一部（${trimmed}）を省いて保存しました`,
          `🎞 Some data (${trimmed}) was left out to fit the size limit`), 'err', 5000);
      } else if (limit > 0 && bytes > limit * 0.8) {
        toast(tr(`⚠️ バックアップが上限の${Math.round((bytes / limit) * 100)}%に達しています`,
          `⚠️ Backup is at ${Math.round((bytes / limit) * 100)}% of the size limit`), 'err', 5000);
      }
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnRestore').onclick = () => showRestoreModal();
  $('#btnBugReports').onclick = () => { audio.click(); showBugReportsAdminModal(); };

  // ⚠️ クライアントエラーのボタンは 🐛 の隣。index.html 側にまだ無いので
  // 無ければここで足す（後から生えたら、それを拾うだけで二重にしない）。
  try {
    let ce = $('#btnClientErrors');
    if (!ce) {
      const bug = $('#btnBugReports');
      if (bug && bug.parentNode) {
        ce = document.createElement('button');
        ce.className = 'btn btn-ghost btn-sm';
        ce.id = 'btnClientErrors';
        ce.textContent = '⚠️ クライアントエラー';
        bug.parentNode.insertBefore(ce, bug.nextSibling);
      }
    }
    if (ce) ce.onclick = () => { audio.click(); showClientErrorsAdminModal(); };
  } catch { /* 管理パネルの形が変わっても他のボタンは死なせない */ }
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
  $('#btnAdminLog').onclick = () => showAdminLogModal();

  // 🔧 デプロイ直前に人を安全に逃がす。Render では SIGTERM で自動的に同じ
  // 処理が走るが、押しておけば「いつ落ちるか」を管理者が選べる。
  $('#btnPrepareUpdate').onclick = async () => {
    if (!confirm('進行中のオンライン対戦をすべて引き分けで終了し、プレイ中の人に保存を促します。よろしいですか？')) return;
    try {
      const r = await api('/api/admin/prepare-update', { method: 'POST' });
      toast(`🔧 ${r.ended}件の対戦を引き分けで終了しました。いま push すると安全です`, 'ok', 5000);
    } catch (err) { toast(err.message, 'err'); }
  };

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

// 🧾 管理者操作の履歴。🎒編集で何でも書けるようになった以上、
// 「誰がいつ何を変えたか」を見られる場所が要る。
const ADMIN_ACTION_LABEL = {
  user_edit: '🎒 ユーザー編集',
  user_delete: '🗑️ ユーザー削除',
  restore: '♻️ データ復元',
  grant_all: '🎁 全員に配布',
  leaderboard_reset: '🏆 ランキング初期化',
};

async function showAdminLogModal() {
  let data;
  try { data = await api('/api/admin/log'); } catch (err) { toast(err.message, 'err'); return; }
  const rows = data.log || [];
  const fmtDetail = d => {
    const parts = Object.entries(d || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return parts.length ? parts.join(' ・ ') : '—';
  };
  const m = showModal(`
    <h2>🧾 操作ログ</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:10px">
      通貨・権限・バッジの書き換え、削除、復元、全体配布を記録しています（最新${data.max}件）。<br>
      パスワードなどの値そのものは記録されません。
    </p>
    ${rows.length ? `
      <div class="ue-body">
        ${rows.map(r => `
          <div class="alog-row">
            <div class="alog-head">
              <b>${escapeHtml(ADMIN_ACTION_LABEL[r.action] || r.action)}</b>
              <span class="muted">${new Date(r.at).toLocaleString('ja-JP')}</span>
            </div>
            <div class="alog-sub">
              👤 ${escapeHtml(r.by)}${r.target ? ` → <b>${escapeHtml(r.target)}</b>` : ''}
            </div>
            <div class="alog-detail">${escapeHtml(fmtDetail(r.detail))}</div>
          </div>`).join('')}
      </div>`
    : '<p class="muted center" style="padding:20px 0">まだ記録がありません</p>'}
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="alClose">とじる</button>
    </div>`);
  m.querySelector('#alClose').onclick = closeModal;
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
      <label>試運転<br><span class="muted" style="font-size:10px">運営だけに見せる</span></label>
      <div class="seg" id="aeStaff">
        <button data-v="1" class="${s.staffOnly ? 'active' : ''}">ON</button>
        <button data-v="0" class="${s.staffOnly ? '' : 'active'}">OFF</button>
      </div>
    </div>
    <p class="muted" style="font-size:11px;margin:-4px 0 10px">
      試運転ONの間は、一般プレイヤーにはバナーも出ず、予約も参加もできません。
      新しいモードを自分で一度確かめてからOFFにしてください。
    </p>

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
  let staffOnly = !!s.staffOnly;
  m.querySelectorAll('#aeStaff button').forEach(btn => {
    btn.onclick = () => {
      staffOnly = btn.dataset.v === '1';
      m.querySelectorAll('#aeStaff button').forEach(x => x.classList.toggle('active', x === btn));
    };
  });

  m.querySelector('#aeSave').onclick = async () => {
    const slots = m.querySelector('#aeSlots').value.split(/[,、\s]+/).filter(Boolean);
    try {
      await api('/api/admin/adminevent', {
        method: 'POST',
        body: {
          enabled,
          staffOnly,
          weekday: Number(m.querySelector('#aeWeekday').value),
          slots,
          durationMin,
          rotation: m.querySelector('#aeMode').value,
          rewardMult,
          note: m.querySelector('#aeNote').value,
        },
      });
      toast(!enabled ? '👑 管理者イベントをOFFにしました'
        : staffOnly ? '🔒 試運転で設定しました（いま見えるのは運営だけです）'
        : '👑 管理者イベントを設定しました（全員にアナウンス済み）', 'ok', 4000);
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
  const gen = ++viewGen;
  $$('[data-gd]').forEach(x => x.classList.toggle('active', x.dataset.gd === tab));
  const body = $('#guildBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  try {
    guildData = await api('/api/guilds');
  } catch (err) {
    if (gen !== viewGen) return;
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (gen !== viewGen) return;
  if (tab === 'mine') renderMyGuild();
  else if (tab === 'rank') renderGuildRank();
  else renderGuildFind();
}

function guildCard(g, { rank = null, clickable = true } = {}) {
  return `
    <div class="guild-card ${g.ghost ? '' : 'real'}" ${clickable ? `data-guild="${escapeHtml(g.id)}"` : ''}>
      ${rank ? `<div class="guild-rank">${rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank}</div>` : ''}
      <div class="guild-icon">${escapeHtml(g.icon)}</div>
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
  // 🗡️ 週間クエスト＋金庫（メンバー一覧の上）。データは追加取得不要で
  // guildData.mine.quests（guildQuestView）に載っている。報酬額・受取可否は
  // すべてサーバーが返した値だけを出す（クライアントは申告しない）。
  const q = g.quests;
  const questsHtml = q && Array.isArray(q.quests) && q.quests.length ? `
    <div class="ms-head" style="margin-top:4px">
      <div>
        <b>${tr('🗡️ 週間クエスト', '🗡️ Weekly quests')}</b>
        <div class="muted" style="font-size:12px">${tr(`達成 ${q.doneCount} / ${q.total}`, `Done ${q.doneCount} / ${q.total}`)}${
          q.badgeEarned ? tr(' ・ 🎖️ ギルドの誉れ 獲得済み', ' ・ 🎖️ Guild Honors earned') : ''}<br>${
          tr('達成したクエストの金庫は、メンバーが1人1回ずつ開けられます', 'Each completed quest is a vault every member can open once')}</div>
      </div>
    </div>
    <div class="ms-list">
      ${q.quests.map(quest => {
        const pct = Math.min(100, Math.round((quest.progress / Math.max(1, quest.goal)) * 100));
        return `
        <div class="ms-row ${quest.claimed ? 'claimed' : quest.done ? 'done' : ''}">
          <div class="ms-info">
            <div class="ms-name">${escapeHtml(tr(quest.name, quest.nameEn))}</div>
            <div class="ms-bar"><div style="width:${pct}%"></div></div>
            <div class="ms-prog">${fmt(quest.progress)} / ${fmt(quest.goal)}</div>
          </div>
          ${rewardChip(quest.coins, quest.gems)}
          ${quest.claimed
            ? '<span class="ms-check">✓</span>'
            : quest.done
              ? `<button class="btn btn-sm btn-gold" data-gquest="${escapeHtml(String(quest.id))}">${tr('受取', 'Claim')}</button>`
              : `<button class="btn btn-sm btn-ghost" disabled>${tr('未達成', 'Locked')}</button>`}
        </div>`;
      }).join('')}
    </div>` : '';
  body.innerHTML = `
    <div class="guild-hero">
      <div class="guild-hero-icon">${escapeHtml(g.icon)}</div>
      <div>
        <div class="guild-hero-name"><span class="lb-tag">[${escapeHtml(g.tag)}]</span>${escapeHtml(g.name)}</div>
        <div class="muted" style="font-size:12px">${escapeHtml(g.desc || tr('（説明なし）', '(no description)'))}</div>
        <div class="guild-hero-stats">
          <span>Lv.<b>${g.level}</b></span><span>${tr('週間', 'Weekly')} <b>${fmt(g.weeklyPoints)}</b>pt</span><span>${tr('順位', 'Rank')} <b>${g.rank ? `#${g.rank}` : '-'}</b></span><span>🪙<b>+${g.bonusPct}%</b></span><span>👥 <b>${g.memberCount}</b>/${g.maxMembers}</span>
        </div>
      </div>
    </div>
    ${isOwner ? `<div class="settings-row" style="justify-content:center"><label>${tr('🔑 招待コード', '🔑 Invite code')}</label><b style="font-size:18px;letter-spacing:.12em">${escapeHtml(g.code || '')}</b><span class="muted" style="font-size:11px">${tr('（フレンドに教えると参加できます）', '(share it with friends)')}</span></div>` : ''}
    ${questsHtml}
    <div class="ms-head" style="margin-top:4px"><div><b>${tr('👥 メンバー', '👥 Members')}</b></div></div>
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
  // 🗡️ 週間クエストの金庫を開ける（q.done && !q.claimed のときだけボタンが出る）。
  // 通貨はサーバー確定。応答の user で session を更新し、kick/settings と同じく
  // openGuild('mine') で描き直す。二重受取はサーバーの claimed 名簿が止める。
  body.querySelectorAll('[data-gquest]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await api('/api/guild/quest/claim', { method: 'POST', body: { questId: b.dataset.gquest } });
        if (res && res.user) { session.user = res.user; updateTopbar(); }
        const rw = (res && res.reward) || {};
        audio.coin(); confettiBurst(30);
        const parts = [];
        if (rw.coins) parts.push(`🪙${fmt(rw.coins)}`);
        if (rw.gems) parts.push(`💎${fmt(rw.gems)}`);
        toast(tr(`🎁 クエスト報酬を受け取りました！${parts.length ? ` ${parts.join(' ')}` : ''}`,
          `🎁 Quest reward claimed!${parts.length ? ` ${parts.join(' ')}` : ''}`), 'ok', 3000);
        if (rw.badge) toast(tr('🎖️ 「ギルドの誉れ」を獲得しました！', '🎖️ You earned Guild Honors!'), 'ok', 3500);
        openGuild('mine');
      } catch (err) { audio.error(); toast(err.message, 'err'); b.disabled = false; }
    };
  });
  const st = body.querySelector('#gdSettings');
  if (st) st.onclick = () => showGuildSettingsModal(g, d);
  body.querySelector('#gdLeave').onclick = async () => {
    // 1人だけのギルドでリーダーが抜けると、引き継ぐ相手がいないので
    // その場で解散する。設立に払った 2,000🪙 も戻らない。
    // 「引き継がれます」としか書いていなかったので、消えるとは思わずに押せた。
    const alone = isOwner && (g.members || []).length <= 1;
    const msg = alone
      ? tr('あなた以外にメンバーがいません。脱退するとギルドは解散し、'
         + 'ギルド名も設立に使った 2,000🪙 も戻りません。本当に解散しますか？',
           'You are the only member. Leaving DISBANDS the guild for good — '
         + 'the name and the 2,000🪙 you paid are not refunded. Disband it?')
      : isOwner
        ? tr('リーダーを離れるとメンバーの最古参に引き継がれます。脱退しますか？（1時間は再加入できません）',
             'Leadership passes to the longest-serving member. Leave? (you cannot rejoin for an hour)')
        : tr('ギルドを脱退しますか？（1時間は再加入できません）',
             'Leave the guild? (you cannot rejoin for an hour)');
    if (!confirm(msg)) return;
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
  body.querySelectorAll('[data-guild]').forEach(el => { bindActivate(el, () => showGuildModal(el.dataset.guild)); });
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
  body.querySelectorAll('[data-guild]').forEach(el => { bindActivate(el, () => showGuildModal(el.dataset.guild)); });
  const c = body.querySelector('#gdCreate2');
  if (c) c.onclick = () => showGuildCreateModal(guildData);
}

async function showGuildModal(id) {
  let g;
  try { g = (await api(`/api/guilds/${encodeURIComponent(id)}`)).guild; } catch (err) { toast(err.message, 'err'); return; }
  const canJoin = session.user && !(guildData && guildData.mine) && !g.ghost && g.open && g.memberCount < g.maxMembers;
  const m = showModal(`
    <h2>${escapeHtml(g.icon)} <span class="lb-tag">[${escapeHtml(g.tag)}]</span>${escapeHtml(g.name)}</h2>
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
  const gen = ++viewGen;
  const body = $('#newsBody');
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  $('#btnNewsPost').classList.toggle('hidden', !(session.user && session.user.role === 'admin'));
  $('#btnNewsPost').onclick = () => showNewsPostModal();
  let data;
  try { data = await api('/api/news'); } catch (err) { if (gen !== viewGen) return; body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`; return; }
  if (gen !== viewGen) return;
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

// ---------------------------------------------------------------------------
// 🧩 パズル工房 (I6) — みんなの自作ステージの閲覧・コード入力・いいね
//
// 画面(section)を増やすと dom.js の SCREENS と index.html を触ることになるので、
// 🏛️殿堂(showHallOfFame)と同じくモーダルで作る。非同期レースのガードも殿堂と
// 同じ作りで、画面用の viewGen とは別勘定の wsGen を使う（await から戻った
// 時点で世代が変わっている＝タブが切り替わった／閉じられたら描かない）。
//
// サーバー側（server/index.js 担当）の想定API:
//   GET  /api/workshop/stages?sort=popular|new&limit=40
//          -> { stages: [{ code, name, nameEn, author, likes, plays, liked,
//                          grid, pieces, at }] }
//   GET  /api/workshop/stages/:code      -> { stage: {...} }
//   POST /api/workshop/stages/:code/like -> { likes, liked }
// どれも未実装／空でも画面は壊さない（「まだありません」で止まるだけ）。
// キー名のゆらぎ（stages/rows/items、code/shareCode、likes/likeCount …）は
// normalizeWorkshopStage() が吸収する。
//
// 実際に遊ぶ／エディタを開くのは modes.js 担当。ここからは
//   window.startWorkshopStage(code, stage)   ステージを遊ぶ
//   window.openWorkshopEditor()              自作ステージのエディタを開く
// を呼ぶだけにしてある（未実装なら「準備中」のトーストで止まる）。
// ---------------------------------------------------------------------------

const WS_SORTS = ['popular', 'new', 'mine'];
const WS_PAGE = 40;                          // 1ページの取得件数（サーバーの limit）
const WS_LIKED_KEY = 'bba_workshop_liked';   // いいね済みコード（サーバーが liked を返さない場合の控え）

let wsSort = 'popular';
let wsStages = [];
let wsMore = false;                          // まだ続きがある（応答の more）
let wsMatched = 0;                           // この並び順で見えている総数（応答の matched）
let wsGen = 0;

function wsLikedCodes() {
  try {
    const a = JSON.parse(localStorage.getItem(WS_LIKED_KEY) || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch { return []; }
}
function wsRememberLike(code) {
  const a = wsLikedCodes();
  if (a.includes(code)) return;
  a.push(code);
  try { localStorage.setItem(WS_LIKED_KEY, JSON.stringify(a.slice(-300))); } catch { /* 容量超過などは無視 */ }
}

// 図柄。8x8=64マス（0=空、1..9=色）に揃える。64要素の配列でも、8行の配列でも、
// "0012.." のような64文字の文字列でも読めるようにしてある（形が変わっても落ちない）。
function wsNormalizeGrid(src) {
  let cells = null;
  if (Array.isArray(src)) {
    if (src.length === 64 && !Array.isArray(src[0])) cells = src;
    else if (src.length === 8) {
      cells = [];
      for (const row of src) {
        const r = typeof row === 'string' ? row.split('') : Array.isArray(row) ? row : null;
        if (!r || r.length !== 8) return null;
        for (const v of r) cells.push(v);
      }
    }
  } else if (typeof src === 'string') {
    const s = src.replace(/[^0-9]/g, '');
    if (s.length === 64) cells = s.split('');
  }
  if (!cells || cells.length !== 64) return null;
  return cells.map(v => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(9, n) : 0;
  });
}

// 1件ぶんの正規化。読めなければ null（＝一覧から静かに落とす）。
function normalizeWorkshopStage(s, fallbackCode = '') {
  if (!s || typeof s !== 'object') return null;
  const inner = (s.stage && typeof s.stage === 'object') ? s.stage : s;
  const code = String(s.code || s.shareCode || s.share || inner.code || fallbackCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return null;
  const nameJa = String(s.name || s.title || inner.name || '').trim();
  const nameEn = String(s.nameEn || s.titleEn || '').trim();
  const author = String(s.author || s.authorName || s.by || s.username || (s.user && s.user.username) || '').trim();
  const likes = Math.max(0, Math.floor(Number(s.likes ?? s.likeCount ?? s.hearts ?? 0)) || 0);
  const plays = Math.max(0, Math.floor(Number(s.plays ?? s.playCount ?? s.played ?? 0)) || 0);
  const pieces = Array.isArray(s.pieces) ? s.pieces : Array.isArray(inner.pieces) ? inner.pieces : null;
  const pieceCount = pieces ? pieces.length : Math.max(0, Math.floor(Number(s.pieceCount ?? s.pieces ?? 0)) || 0);
  const likedRaw = s.liked ?? s.likedByMe ?? s.myLike ?? s.isLiked;
  return {
    code,
    name: (LANG === 'en' && nameEn ? nameEn : nameJa) || tr(`ステージ ${code}`, `Stage ${code}`),
    author: author || tr('名無しの職人', 'Anonymous'),
    likes, plays, pieceCount,
    liked: likedRaw === undefined ? wsLikedCodes().includes(code) : !!likedRaw,
    // 自分の作品か（サーバーの workshopView が mine を返す）。🗑削除ボタンの出し分けに使う。
    mine: !!(s.mine ?? s.isMine ?? (inner && inner.mine)),
    grid: wsNormalizeGrid(s.grid ?? s.cells ?? s.board ?? inner.grid ?? inner.cells ?? null),
    at: Number(s.at ?? s.createdAt ?? s.postedAt ?? 0) || 0,
    raw: s,
  };
}

function normalizeWorkshopList(data) {
  const raw = Array.isArray(data) ? data
    : (data && (data.stages || data.rows || data.items || data.list)) || null;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    const st = normalizeWorkshopStage(s);
    if (!st || seen.has(st.code)) continue;
    seen.add(st.code);
    out.push(st);
  }
  return out;
}

// 図柄のミニプレビュー。新規CSSを増やさずに済むよう、8x8のグリッドを
// インラインstyleだけで描く（cell=1マスの px）。
function wsPreviewHtml(grid, cell = 7) {
  const side = cell * 8 + 7;
  if (!grid) {
    return `<div style="width:${side}px;height:${side}px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      border-radius:8px;background:rgba(255,255,255,0.06);font-size:${Math.round(side / 2.4)}px">🧩</div>`;
  }
  const cells = grid.map(v => {
    const col = v ? (PALETTE[v] || PALETTE[1])[0] : 'rgba(255,255,255,0.07)';
    return `<i style="display:block;border-radius:1px;background:${col}"></i>`;
  }).join('');
  return `<div style="display:grid;grid-template-columns:repeat(8,${cell}px);grid-auto-rows:${cell}px;gap:1px;
    flex:0 0 auto;padding:3px;border-radius:8px;background:rgba(0,0,0,0.28)">${cells}</div>`;
}

function wsLikeLabel(st) { return `${st.liked ? '❤️' : '🤍'} ${fmt(st.likes)}`; }

function wsCardHtml(st) {
  const code = escapeHtml(st.code);
  return `
    <div class="ms-row" data-ws-code="${code}">
      ${wsPreviewHtml(st.grid)}
      <div class="ms-info">
        <div class="ms-name">${escapeHtml(st.name)}</div>
        <div class="ms-prog"><span style="white-space:nowrap">👤 ${escapeHtml(st.author)}</span>${
          st.pieceCount ? ` <span style="white-space:nowrap">・ 🧩 ${tr(`${st.pieceCount}ピース`, `${st.pieceCount} pieces`)}</span>` : ''}</div>
        <div class="ms-prog"><span style="white-space:nowrap">❤️ ${fmt(st.likes)}</span> <span style="white-space:nowrap">・ ▶ ${tr(`${fmt(st.plays)}回`, `${fmt(st.plays)} plays`)}</span> <span style="white-space:nowrap">・ <b style="letter-spacing:.1em">${code}</b></span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;flex:0 0 auto">
        <button class="btn btn-sm btn-primary" data-ws-play="${code}">▶ ${tr('遊ぶ', 'Play')}</button>
        <button class="btn btn-sm btn-ghost" data-ws-like="${code}">${wsLikeLabel(st)}</button>
      </div>
    </div>`;
}

function wsEmptyHtml() {
  return `<div class="ms-empty">
      <p>${tr('まだ公開されたステージがありません', 'No stages published yet')}</p>
      <button class="btn btn-gold" id="wsMakeFirst">🛠️ ${tr('最初の1作を作る', 'Build the first one')}</button>
    </div>`;
}

// モーダル本体。開き直しではなくタブ切り替えでも中身だけ差し替える。
export async function openWorkshop(sort = wsSort) {
  audio.click();
  wsSort = WS_SORTS.includes(sort) ? sort : 'popular';
  // 「自分の作品」はログイン中だけ。ログアウト状態で残っていたら人気に戻す。
  if (wsSort === 'mine' && !session.user) wsSort = 'popular';
  const m = showModal(`
    <h2>🧩 ${tr('パズル工房', 'Puzzle Workshop')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">${tr('みんなが作ったステージで遊ぼう。気に入ったら❤️を送ろう',
      'Play stages built by other players — send a ❤️ if you like one')}</p>
    <div class="settings-row" style="justify-content:center;gap:6px;flex-wrap:wrap">
      <input id="wsCode" type="text" maxlength="6" placeholder="ABC123" style="width:110px;text-transform:uppercase" autocomplete="off">
      <button class="btn btn-sm btn-primary" id="wsGo">🔍 ${tr('コードで開く', 'Open code')}</button>
      <button class="btn btn-sm btn-gold" id="wsNew">🛠️ ${tr('作る', 'Create')}</button>
    </div>
    <div class="tabs" id="wsTabs" style="justify-content:center;flex-wrap:wrap">
      <button class="tab ${wsSort === 'popular' ? 'active' : ''}" data-ws="popular">🔥 ${tr('人気', 'Popular')}</button>
      <button class="tab ${wsSort === 'new' ? 'active' : ''}" data-ws="new">🆕 ${tr('新着', 'Newest')}</button>
      ${session.user ? `<button class="tab ${wsSort === 'mine' ? 'active' : ''}" data-ws="mine">🛠️ ${tr('自分の作品', 'My stages')}</button>` : ''}
    </div>
    ${session.user && session.user.role === 'admin'
      ? `<div class="settings-row" style="justify-content:center"><button class="btn btn-sm btn-ghost" id="wsAdmin">🛡️ ${tr('全ステージを管理', 'Manage all stages')}</button></div>` : ''}
    <div id="wsBody" class="ms-list" style="max-height:50vh;overflow-y:auto"><p class="muted center">${tr('読み込み中…', 'Loading…')}</p></div>
    <div class="modal-buttons"><button class="btn btn-primary" id="wsClose">${tr('閉じる', 'Close')}</button></div>`);
  m.querySelector('#wsClose').onclick = closeModal;
  m.querySelector('#wsNew').onclick = () => wsOpenEditor();
  const adminBtn = m.querySelector('#wsAdmin');
  if (adminBtn) adminBtn.onclick = () => showWorkshopAdminModal();
  const codeInput = m.querySelector('#wsCode');
  const go = () => openWorkshopByCode(codeInput.value);
  m.querySelector('#wsGo').onclick = go;
  codeInput.onkeydown = e => { if (e.key === 'Enter') go(); };
  m.querySelectorAll('[data-ws]').forEach(b => {
    b.onclick = () => {
      if (wsSort === b.dataset.ws) return;
      audio.click();
      wsSort = b.dataset.ws;
      m.querySelectorAll('[data-ws]').forEach(x => x.classList.toggle('active', x === b));
      loadWorkshopList(m);
    };
  });
  await loadWorkshopList(m);
  return m;
}

async function loadWorkshopList(m) {
  const gen = ++wsGen;
  const body = m.querySelector('#wsBody');
  if (!body) return;
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  let data = null;
  // API がまだ無くても「まだありません」で止める（画面は壊さない）。
  try { data = await api(`/api/workshop/stages?sort=${encodeURIComponent(wsSort)}&limit=${WS_PAGE}&offset=0`); } catch { data = null; }
  if (gen !== wsGen || !m.isConnected) return;
  wsStages = normalizeWorkshopList(data);
  wsMore = !!(data && data.more);
  wsMatched = Number(data && data.matched) || wsStages.length;
  renderWorkshopList(m);
}

// もっと見る（次ページ）。今の並び順のまま offset を進めて追加取得し、
// 既存の一覧に重複を除いて足す。世代（wsGen）が変わっていたら捨てる。
async function loadMoreWorkshop(m, btn) {
  const gen = wsGen;
  if (btn) { btn.disabled = true; btn.textContent = tr('読み込み中…', 'Loading…'); }
  let data = null;
  try { data = await api(`/api/workshop/stages?sort=${encodeURIComponent(wsSort)}&limit=${WS_PAGE}&offset=${wsStages.length}`); } catch { data = null; }
  if (gen !== wsGen || !m.isConnected) return;
  const next = normalizeWorkshopList(data);
  const seen = new Set(wsStages.map(s => s.code));
  for (const s of next) if (!seen.has(s.code)) { seen.add(s.code); wsStages.push(s); }
  wsMore = !!(data && data.more) && next.length > 0;
  wsMatched = Number(data && data.matched) || wsMatched;
  renderWorkshopList(m);
}

function renderWorkshopList(m) {
  const body = m.querySelector('#wsBody');
  if (!body) return;
  if (!wsStages.length) {
    // 「自分の作品」タブが空のときは、初回作成ではなく専用の空表示にする。
    if (wsSort === 'mine') {
      body.innerHTML = `<div class="ms-empty">
          <p>${tr('まだ自分のステージがありません', 'You have not published any stages yet')}</p>
          <button class="btn btn-gold" id="wsMakeFirst">🛠️ ${tr('作ってみる', 'Build one')}</button>
        </div>`;
    } else {
      body.innerHTML = wsEmptyHtml();
    }
    const b = body.querySelector('#wsMakeFirst');
    if (b) b.onclick = () => wsOpenEditor();
    return;
  }
  body.innerHTML = wsStages.map(wsCardHtml).join('')
    + (wsMore ? `<button class="btn btn-ghost" id="wsMore" style="width:100%;margin-top:8px">⬇️ ${tr('もっと見る', 'Show more')}${wsMatched ? tr(`（${wsStages.length} / ${wsMatched}）`, ` (${wsStages.length} / ${wsMatched})`) : ''}</button>` : '');
  bindWorkshopCards(body);
  const more = body.querySelector('#wsMore');
  if (more) more.onclick = () => loadMoreWorkshop(m, more);
}

// カード内のボタン。プレビュー／名前の側を押したら詳細モーダルへ。
function bindWorkshopCards(root) {
  root.querySelectorAll('[data-ws-play]').forEach(b => {
    b.onclick = e => { e.stopPropagation(); playWorkshopStage(wsFind(b.dataset.wsPlay) || { code: b.dataset.wsPlay, raw: null }); };
  });
  root.querySelectorAll('[data-ws-like]').forEach(b => {
    b.onclick = e => { e.stopPropagation(); likeWorkshopStage(b.dataset.wsLike, b); };
  });
  root.querySelectorAll('[data-ws-code]').forEach(el => {
    bindActivate(el, () => { const st = wsFind(el.dataset.wsCode); if (st) showWorkshopStageModal(st); });
  });
}

function wsFind(code) { return wsStages.find(s => s.code === String(code || '').toUpperCase()) || null; }

// 6文字コードで1件だけ取ってくる（modes.js からも使えるよう export + window）。
export async function fetchWorkshopStage(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(c)) return null;
  let data = null;
  try { data = await api(`/api/workshop/stages/${encodeURIComponent(c)}`); } catch { return null; }
  const raw = (data && (data.stage || data.item || data.data)) || data;
  return normalizeWorkshopStage(raw, c);
}

async function openWorkshopByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) {
    audio.error();
    toast(tr('6文字の共有コードを入力してください', 'Enter the 6-character share code'), 'err');
    return;
  }
  audio.click();
  const st = await fetchWorkshopStage(c);
  if (!st) {
    audio.error();
    toast(tr('そのコードのステージは見つかりませんでした', 'No stage with that code'), 'err');
    return;
  }
  showWorkshopStageModal(st);
}

// 1件の詳細。ここからも遊ぶ／いいね／コードのコピーができる。
function showWorkshopStageModal(st) {
  const m = showModal(`
    <h2>🧩 ${escapeHtml(st.name)}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">👤 ${escapeHtml(st.author)}${
      st.pieceCount ? ` ・ 🧩 ${tr(`${st.pieceCount}ピース`, `${st.pieceCount} pieces`)}` : ''}</p>
    <div style="display:flex;justify-content:center;margin-bottom:10px">${wsPreviewHtml(st.grid, 16)}</div>
    <div class="guild-hero-stats" style="justify-content:center;margin-bottom:10px">
      <span>❤️ <b>${fmt(st.likes)}</b></span><span>▶ <b>${fmt(st.plays)}</b></span>
      <span>${tr('コード', 'Code')} <b style="letter-spacing:.12em">${escapeHtml(st.code)}</b></span>
    </div>
    <div class="settings-row" style="justify-content:center;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-ghost" id="wsCopy">📋 ${tr('コードをコピー', 'Copy code')}</button>
      <button class="btn btn-sm btn-ghost" id="wsLike1">${wsLikeLabel(st)}</button>
      <button class="btn btn-sm btn-ghost" id="wsReport1">🚩 ${tr('通報', 'Report')}</button>
      ${(st.mine || (session.user && session.user.role === 'admin'))
        ? `<button class="btn btn-sm btn-ghost" id="wsDelete1" style="color:var(--red)">🗑 ${tr('削除', 'Delete')}</button>` : ''}
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wsBack">← ${tr('一覧へ', 'Back')}</button>
      <button class="btn btn-primary" id="wsPlay1">▶ ${tr('遊ぶ', 'Play')}</button>
    </div>`);
  m.querySelector('#wsBack').onclick = () => openWorkshop();
  m.querySelector('#wsPlay1').onclick = () => playWorkshopStage(st);
  m.querySelector('#wsLike1').onclick = e => likeWorkshopStage(st.code, e.currentTarget, st);
  // 🚩 通報。導線は party.js の openStageReport をそのまま使う（st は code/name/author を持つ）。
  m.querySelector('#wsReport1').onclick = () => {
    import('./party.js').then(p => p.openStageReport(st)).catch(() => {
      toast(tr('通報画面を開けませんでした', 'Could not open the report dialog'), 'err');
    });
  };
  const delBtn = m.querySelector('#wsDelete1');
  if (delBtn) delBtn.onclick = () => deleteWorkshopStage(st, delBtn);
  m.querySelector('#wsCopy').onclick = async () => {
    // 非セキュアな LAN(http) には navigator.clipboard が無い。party.js と同じ退避。
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(st.code); ok = true; } } catch { /* 下へ退避 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = st.code; document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch { ok = false; }
    }
    toast(ok ? tr('共有コードをコピーしました', 'Share code copied')
             : tr(`コピーできませんでした（コード: ${st.code}）`, `Could not copy (code: ${st.code})`),
      ok ? 'ok' : 'err', ok ? 1500 : 3000);
  };
}

// 🗑 削除。作者本人か管理者だけ（サーバーが最終判定する）。消したら一覧へ戻る。
async function deleteWorkshopStage(st, btn) {
  const code = String((st && st.code) || '').toUpperCase();
  if (!code) return;
  const mine = !!(st && st.mine);
  if (!confirm(mine
    ? tr('この自作ステージを削除しますか？（元に戻せません）', 'Delete this stage of yours? This cannot be undone.')
    : tr(`このステージ（${code}）を削除しますか？（管理者操作・元に戻せません）`, `Delete this stage (${code})? (admin action, cannot be undone)`))) return;
  if (btn) btn.disabled = true;
  try {
    await api(`/api/workshop/stages/${encodeURIComponent(code)}`, { method: 'DELETE' });
    audio.click();
    toast(tr('ステージを削除しました', 'Stage deleted'), 'ok');
    closeModal();
    openWorkshop();
  } catch (err) {
    audio.error();
    toast(err.message, 'err');
    if (btn) btn.disabled = false;
  }
}

// 🛡️ 管理者用の全ステージ棚卸し。公開一覧はページ送りが要るので、通報を受けて
// 「今どんなものが公開されているか」を丸ごと（新着順で）見る口。各行に🗑。
// 盤面も解答も返ってこない（消すのに要るのはコードと見出しだけ）。
let wsAdminGen = 0;
async function showWorkshopAdminModal(q = '') {
  const m = showModal(`
    <h2>🛡️ ${tr('工房ステージ管理', 'Workshop stages')}</h2>
    <div class="settings-row" style="justify-content:center;gap:6px">
      <input id="waQ" type="text" maxlength="40" placeholder="${tr('コード・題名・作者で検索', 'Search code / title / author')}" value="${escapeHtml(q)}" style="width:200px">
      <button class="btn btn-sm btn-primary" id="waSearch">🔍 ${tr('検索', 'Search')}</button>
    </div>
    <div id="waBody" class="feed-list" style="max-height:52vh"><p class="muted center">${tr('読み込み中…', 'Loading…')}</p></div>
    <div class="modal-buttons"><button class="btn btn-primary" id="waClose">${tr('閉じる', 'Close')}</button></div>`);
  m.querySelector('#waClose').onclick = closeModal;
  const qInput = m.querySelector('#waQ');
  const run = () => loadWorkshopAdmin(m, qInput.value.trim());
  m.querySelector('#waSearch').onclick = run;
  qInput.onkeydown = e => { if (e.key === 'Enter') run(); };
  await loadWorkshopAdmin(m, q);
  return m;
}

async function loadWorkshopAdmin(m, q = '') {
  const gen = ++wsAdminGen;
  const body = m.querySelector('#waBody');
  if (!body) return;
  body.innerHTML = `<p class="muted center">${tr('読み込み中…', 'Loading…')}</p>`;
  let data = null;
  try { data = await api(`/api/admin/workshop/stages${q ? `?q=${encodeURIComponent(q)}` : ''}`); } catch (err) {
    if (gen !== wsAdminGen || !m.isConnected) return;
    body.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (gen !== wsAdminGen || !m.isConnected) return;
  const rows = (data && Array.isArray(data.stages)) ? data.stages : [];
  if (!rows.length) {
    body.innerHTML = `<p class="muted center">${q ? tr('該当するステージがありません', 'No stages match') : tr('公開ステージはありません', 'No published stages')}</p>`;
    return;
  }
  const flag = r => [
    r.banned ? tr('🚫凍結中', '🚫 banned') : '',
    r.orphan ? tr('👻作者退会', '👻 no author') : '',
    r.seed ? tr('🌱初期', '🌱 seed') : '',
  ].filter(Boolean).join(' ・ ');
  body.innerHTML = `<p class="muted center" style="font-size:12px;margin-bottom:6px">${tr(`全 ${fmt(data.total || rows.length)} 件`, `${fmt(data.total || rows.length)} total`)}</p>`
    + rows.map(r => `
    <div class="feed-row real" style="align-items:flex-start" data-wa-row="${escapeHtml(r.code)}">
      <span class="feed-text" style="white-space:normal;min-width:0;word-break:break-word">
        <b>${escapeHtml(LANG === 'en' && r.titleEn ? r.titleEn : (r.title || tr('（無題）', '(untitled)')))}</b>
        <small class="muted" style="display:block;margin-top:2px">👤 ${escapeHtml(r.author || tr('（不明）', '(unknown)'))} ・ <b style="letter-spacing:.1em">${escapeHtml(r.code)}</b> ・ ❤️${fmt(r.likes || 0)} ・ ▶${fmt(r.plays || 0)}</small>
        ${flag(r) ? `<small class="muted" style="display:block">${flag(r)}</small>` : ''}</span>
      <span style="display:flex;flex-direction:column;gap:4px">
        <button class="btn btn-sm btn-ghost" data-wa-del="${escapeHtml(r.code)}" style="color:var(--red)" title="${tr('このステージを削除', 'Delete this stage')}">🗑</button>
      </span>
    </div>`).join('');
  body.querySelectorAll('[data-wa-del]').forEach(b => {
    b.onclick = async () => {
      const code = b.dataset.waDel;
      if (!confirm(tr(`ステージ ${code} を削除しますか？（元に戻せません）`, `Delete stage ${code}? This cannot be undone.`))) return;
      b.disabled = true;
      try {
        await api(`/api/workshop/stages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        audio.click();
        const rowEl = b.closest('[data-wa-row]');
        if (rowEl) rowEl.remove();
        toast(tr('ステージを削除しました', 'Stage deleted'), 'ok');
      } catch (err) { audio.error(); toast(err.message, 'err'); b.disabled = false; }
    };
  });
}

// ❤️ いいね（1人1回）。サーバーが likes/liked を返せばそれを、返さなければ
// 手元で +1 して押した状態にする。押せたコードは localStorage にも控える。
async function likeWorkshopStage(code, btn, single = null) {
  const c = String(code || '').toUpperCase();
  const st = single && single.code === c ? single : wsFind(c);
  if (!session.user) {
    audio.error();
    toast(tr('❤️ はアカウント登録で押せます', 'Create an account to send a ❤️'), 'err');
    showAuthModal();
    return;
  }
  if (st && st.liked) { toast(tr('もう❤️を送っています', 'You already liked this stage')); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await api(`/api/workshop/stages/${encodeURIComponent(c)}/like`, { method: 'POST', body: {} });
    const n = Number(res && (res.likes ?? res.likeCount));
    if (st) {
      st.likes = Number.isFinite(n) && n >= 0 ? n : st.likes + 1;
      st.liked = res && res.liked !== undefined ? !!res.liked : true;
    }
    wsRememberLike(c);
    audio.coin();
    // 一覧ごと描き直すとスクロール位置が飛ぶので、押したボタンだけ書き換える。
    if (btn) {
      btn.disabled = false;
      if (st) btn.textContent = wsLikeLabel(st);
    }
    // 同じステージのカードが一覧側にも出ているときは、そちらの数字も合わせる。
    // コードは英数字だけ（正規化ずみ）なので、そのまま属性セレクタに置ける。
    if (st && /^[A-Z0-9]{4,8}$/.test(c)) {
      document.querySelectorAll(`[data-ws-like="${c}"]`).forEach(b => {
        if (b !== btn) b.textContent = wsLikeLabel(st);
      });
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    audio.error();
    toast(err.message, 'err');
  }
}

// ▶ 遊ぶ／🛠️ 作る は modes.js 担当の実装を呼ぶだけ。まだ無ければ静かに断る。
function playWorkshopStage(st) {
  const fn = window.startWorkshopStage;
  if (typeof fn !== 'function') {
    audio.error();
    toast(tr('このステージで遊ぶ機能はまもなく公開されます', 'Playing workshop stages is coming soon'), 'err');
    return;
  }
  closeModal();
  try { fn(st.code, st.raw || null); }
  catch (err) { audio.error(); toast(err && err.message ? err.message : String(err), 'err'); }
}

function wsOpenEditor() {
  const fn = window.openWorkshopEditor;
  if (typeof fn !== 'function') {
    audio.error();
    toast(tr('ステージ作成はまもなく公開されます', 'The stage editor is coming soon'), 'err');
    return;
  }
  if (!session.user) { toast(tr('投稿はアカウント登録で解放されます', 'Publishing needs an account'), 'err'); showAuthModal(); return; }
  closeModal();
  try { fn(); }
  catch (err) { audio.error(); toast(err && err.message ? err.message : String(err), 'err'); }
}

// modes.js（および main.js）から呼べるようにしておく。screens.js は modes.js を
// import している側なので、逆向きは window 経由でしか繋げない。
window.openWorkshop = openWorkshop;
window.fetchWorkshopStage = fetchWorkshopStage;

// メニューの「🧩 工房」ボタン。index.html にはまだ無いのでここで足す
// （ensureHallOfFameNav と同じ作り。後から生えたら拾うだけで二重にしない）。
function ensureWorkshopNav() {
  try {
    let btn = $('#btnWorkshop');
    if (!btn) {
      const nav = $('#screen-menu .menu-nav');
      if (!nav) return;
      btn = document.createElement('button');
      btn.className = 'nav-btn';
      btn.id = 'btnWorkshop';
      btn.innerHTML = `<span>🧩</span>${tr('工房', 'Workshop')}`;
      const before = $('#btnAdmin');
      if (before && before.parentNode === nav) nav.insertBefore(btn, before);
      else nav.appendChild(btn);
    }
    btn.onclick = () => openWorkshop();
  } catch { /* メニューの形が変わっても他の導線は死なせない */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureWorkshopNav, { once: true });
else ensureWorkshopNav();
