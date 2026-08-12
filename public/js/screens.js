// Sub-screens: auth modal, leaderboard, shop, battle pass, admin panel.
import { session, api, setToken, refreshMe } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, fmt, updateTopbar, confettiBurst, rankOf } from './dom.js';
import { getSkin, BOARDS } from './themes.js';
import { audio } from './audio.js';
import { getSettings, updateSettings } from './settings.js';
import { reconnectChat } from './chat.js';
import { t as tr, setLang, LANG, catName, catDesc } from './i18n.js';

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
      toast(mode === 'login' ? tr(`おかえりなさい、${data.user.username}さん！`, `Welcome back, ${data.user.username}!`) : tr(`ようこそ、${data.user.username}さん！`, `Welcome, ${data.user.username}!`), 'ok');
      if (data.dailyBonus) {
        setTimeout(() => toast(tr(`🎁 ログインボーナス +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎`, `🎁 Daily bonus +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎`), 'ok', 3500), 900);
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
      <button class="btn btn-gold" id="pTitles">${tr('👑 称号', '👑 Titles')}</button>
      <button class="btn btn-primary" id="pClose">${tr('閉じる', 'Close')}</button>
    </div>`);
  m.querySelector('#pClose').onclick = closeModal;
  m.querySelector('#pTitles').onclick = () => showTitlesModal();
  m.querySelector('#pRename').onclick = () => showRenameModal();
  m.querySelector('#pLogout').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    setToken(null);
    session.user = null;
    updateTopbar();
    closeModal();
    reconnectChat();
    toast(tr('ログアウトしました', 'Logged out'));
  };
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
          <div class="lb-lvl">Lv.${r.level}${board === 'rating' ? ` ・ ${tr(`${r.pvpWins}勝${r.pvpLosses}敗`, `${r.pvpWins}W ${r.pvpLosses}L`)}` : ''}</div>
        </div>
        <div class="lb-score">${board === 'dungeon' ? `F${fmt(r.dungeonMax || 0)}` : board === 'weekly' ? fmt(r.weeklyBest || 0) : board === 'rating' ? `${rankOf(r.rating).icon}${fmt(r.rating)}` : fmt(r.bestScore)}</div>
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
  items.forEach((item, idx) => {
    // Admin gear is implicitly owned by admins (never purchasable).
    const owned = item.adminOnly ? (u && u.role === 'admin')
      : u ? u.owned.includes(item.id) : item.price === 0;
    const equipped = u ? u.equipped[item.cat] === item.id : !!item.default;
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
  if (!session.user) return;
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

  $('#btnUnlockHidden').onclick = () => {
    localStorage.setItem('bba_kami', '1');
    localStorage.setItem('bba_souzou', '1');
    audio.kamiDescend();
    toast('🔓 「神」「創造神」を解放しました（この端末のみ）', 'announce', 3500);
  };

  $('#btnEvent').onclick = async () => {
    let active = null;
    try { active = (await api('/api/status')).event; } catch { /* ignore */ }
    const remainText = ms => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      if (s >= 86400) return `${Math.floor(s / 86400)}日${Math.floor((s % 86400) / 3600)}時間`;
      if (s >= 3600) return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
      if (s >= 60) return `${Math.floor(s / 60)}分`;
      return `${s}秒`;
    };
    const m = showModal(active ? `
      <h2>🌪️ 期間限定イベント</h2>
      <p class="center" style="margin-bottom:14px">「${escapeHtml(active.name)}」開催中 — 残り${remainText(active.endsAt - Date.now())}<br><small class="muted">終了: ${new Date(active.endsAt).toLocaleString('ja-JP')}</small></p>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="evClose">閉じる</button>
        <button class="btn btn-ai" id="evStop">イベントを終了する</button>
      </div>` : `
      <h2>🌪️ 期間限定イベント</h2>
      <p class="muted center" style="margin-bottom:12px">カオスモードを全プレイヤーに開放します。<br>ルールが激変＋コイン1.5倍！（時間・変化間隔はプレイヤーが選択）</p>
      <div class="form-col">
        <div class="settings-row"><label>イベント名</label><input id="evName" type="text" maxlength="16" value="カオスタイム" style="width:150px"></div>
        <div class="settings-row"><label>開催期間</label>
          <input id="evDays" type="number" min="0" max="14" value="1" style="width:50px;text-align:center">日
          <input id="evHours" type="number" min="0" max="23" value="0" style="width:50px;text-align:center">時間
          <input id="evMins" type="number" min="0" max="59" value="0" style="width:50px;text-align:center">分
        </div>
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="evClose">やめる</button>
          <button class="btn btn-chaos" id="evStart">🌪️ 開催する！</button>
        </div>
      </div>`);
    m.querySelector('#evClose').onclick = closeModal;
    const startBtn = m.querySelector('#evStart');
    if (startBtn) startBtn.onclick = async () => {
      const num = sel => Math.max(0, Math.floor(Number(m.querySelector(sel).value) || 0));
      const minutes = num('#evDays') * 1440 + num('#evHours') * 60 + num('#evMins');
      if (minutes < 1) { toast('開催期間は1分以上で設定してください', 'err'); return; }
      try {
        await api('/api/admin/event', { method: 'POST', body: { on: true, name: m.querySelector('#evName').value.trim(), minutes } });
        closeModal();
        toast('🌪️ イベントを開始しました！全員にアナウンス済み', 'ok', 3000);
      } catch (err) { toast(err.message, 'err'); }
    };
    const stopBtn = m.querySelector('#evStop');
    if (stopBtn) stopBtn.onclick = async () => {
      try {
        await api('/api/admin/event', { method: 'POST', body: { on: false } });
        closeModal();
        toast('イベントを終了しました', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
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

  // ---- crowd (にぎわい) controls ----
  $('#btnPop').onclick = () => {
    const cur = adminStats ? (adminStats.popScale ?? 1) : 1;
    const m = showModal(`
      <h2>🎭 にぎわい設定</h2>
      <p class="muted center" style="margin-bottom:10px">AIプレイヤーの人口・チャット・ランキングの量を調整します<br>現在: <b>×${cur}</b>（0でオフ / 最大×10 — ×10で夜は7,000人規模！）</p>
      <div class="seg seg-wrap" id="popSeg" style="justify-content:center">
        ${[0, 0.5, 1, 1.5, 2, 3, 5, 7, 10].map(v => `<button data-v="${v}" ${v === cur ? 'class="active"' : ''}>×${v}</button>`).join('')}
      </div>
      <div class="modal-buttons" style="margin-top:12px">
        <button class="btn btn-primary" id="popClose">閉じる</button>
      </div>`);
    m.querySelector('#popClose').onclick = closeModal;
    m.querySelectorAll('#popSeg button').forEach(b => {
      b.onclick = async () => {
        try {
          const res = await api('/api/admin/pop', { method: 'POST', body: { scale: Number(b.dataset.v) } });
          m.querySelectorAll('#popSeg button').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          audio.click();
          toast(`🎭 にぎわい ×${res.scale} — 表示人数 ${fmt(res.online)}人`, 'ok', 2500);
        } catch (err) { toast(err.message, 'err'); }
      };
    });
  };

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
