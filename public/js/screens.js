// Sub-screens: auth modal, leaderboard, shop, battle pass, admin panel.
import { session, api, setToken } from './net.js';
import { $, $$, showScreen, showModal, closeModal, toast, fmt, updateTopbar } from './dom.js';
import { getSkin, BOARDS } from './themes.js';
import { audio } from './audio.js';
import { getSettings, updateSettings } from './settings.js';

// ---------------------------------------------------------------------------
// Auth modal
// ---------------------------------------------------------------------------

export function showAuthModal() {
  if (session.user) return showProfileModal();
  const m = showModal(`
    <h2>アカウント</h2>
    <div class="tabs" style="justify-content:center">
      <button class="tab active" data-auth="login">ログイン</button>
      <button class="tab" data-auth="register">新規登録</button>
    </div>
    <div class="form-col">
      <input id="authUser" type="text" placeholder="ユーザー名" maxlength="16" autocomplete="username">
      <input id="authPass" type="password" placeholder="パスワード（6文字以上）" autocomplete="current-password">
      <div class="form-error" id="authError"></div>
      <button class="btn btn-primary" id="authSubmit">ログイン</button>
      <p class="muted center" style="font-size:12px">登録するとランキング・報酬・オンラインレートが有効になります</p>
    </div>`);

  let mode = 'login';
  m.querySelectorAll('[data-auth]').forEach(tab => {
    tab.onclick = () => {
      m.querySelectorAll('[data-auth]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.auth;
      m.querySelector('#authSubmit').textContent = mode === 'login' ? 'ログイン' : '登録する';
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
      toast(mode === 'login' ? `おかえりなさい、${data.user.username}さん！` : `ようこそ、${data.user.username}さん！`, 'ok');
      if (data.dailyBonus) {
        setTimeout(() => toast(`🎁 ログインボーナス +${data.dailyBonus.coins}🪙 +${data.dailyBonus.gems}💎`, 'ok', 3500), 900);
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
  const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈' };
  const m = showModal(`
    <h2>${u.role === 'admin' ? '🛡️' : '😀'} ${u.username}</h2>
    ${u.equippedTitle ? `<p class="center" style="margin:-8px 0 10px;font-weight:800;font-size:14px">《 ${escapeHtml(titleName(u.equippedTitle))} 》</p>` : ''}
    <div class="result-stats">
      <div class="rs-row"><span>レベル</span><b>Lv.${u.level}</b></div>
      <div class="rs-row"><span>ハイスコア</span><b>${fmt(u.stats.bestScore)}</b></div>
      <div class="rs-row"><span>レート</span><b>${fmt(u.stats.rating)}</b></div>
      <div class="rs-row"><span>オンライン戦績</span><b>${u.stats.pvpWins}勝 ${u.stats.pvpLosses}敗</b></div>
      <div class="rs-row"><span>AI撃破</span><b>${fmt(u.stats.aiWins)}</b></div>
      <div class="rs-row"><span>プレイ回数</span><b>${fmt(u.stats.gamesPlayed)}</b></div>
      <div class="rs-row"><span>バッジ</span><b>${u.badges.length ? u.badges.map(b => badgeIcons[b] || '🎖️').join(' ') : 'なし'}</b></div>
    </div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="pLogout">ログアウト</button>
      <button class="btn btn-gold" id="pTitles">👑 称号</button>
      <button class="btn btn-primary" id="pClose">閉じる</button>
    </div>`);
  m.querySelector('#pClose').onclick = closeModal;
  m.querySelector('#pTitles').onclick = () => showTitlesModal();
  m.querySelector('#pLogout').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    setToken(null);
    session.user = null;
    updateTopbar();
    closeModal();
    toast('ログアウトしました');
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
  return t ? t.name : '';
}

// ---------------------------------------------------------------------------
// Gem shop (demo payments)
// ---------------------------------------------------------------------------

let gemPacks = null;

export async function showGemShop() {
  if (!session.user) { showAuthModal(); return; }
  try {
    if (!gemPacks) gemPacks = (await api('/api/gempacks')).packs;
  } catch (err) { toast(err.message, 'err'); return; }
  const m = showModal(`
    <h2>💎 ジェムショップ</h2>
    <p class="muted center" style="margin-bottom:12px">所持ジェム: <b style="color:var(--cyan)">${fmt(session.user.gems)}</b></p>
    <div class="form-col">
      ${gemPacks.map(p => `
        <button class="gem-pack" data-pack="${p.id}">
          <span class="gp-gems">💎 ${fmt(p.gems)}${p.bonus ? `<small> +${fmt(p.bonus)}ボーナス</small>` : ''}</span>
          <span class="gp-price">¥${fmt(p.priceJpy)}</span>
        </button>`).join('')}
      <p class="muted center" style="font-size:11px">⚠️ 現在は<b>デモ決済</b>です。実際の請求は発生しません。<br>本番公開時はStripe等の決済サービス接続が必要です（README参照）</p>
    </div>`);
  m.querySelectorAll('[data-pack]').forEach(btn => {
    btn.onclick = () => {
      const pack = gemPacks.find(p => p.id === btn.dataset.pack);
      const c = showModal(`
        <h2>💳 購入確認（デモ）</h2>
        <div class="result-stats">
          <div class="rs-row"><span>💎 ジェム</span><b>${fmt(pack.gems + pack.bonus)}</b></div>
          <div class="rs-row"><span>価格</span><b>¥${fmt(pack.priceJpy)}</b></div>
          <div class="rs-row"><span>決済方法</span><b>デモ（請求なし）</b></div>
        </div>
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="gpNo">やめる</button>
          <button class="btn btn-gold" id="gpYes">購入する</button>
        </div>`);
      c.querySelector('#gpNo').onclick = () => { closeModal(); showGemShop(); };
      c.querySelector('#gpYes').onclick = async () => {
        try {
          const res = await api('/api/purchase', { method: 'POST', body: { packId: pack.id } });
          audio.coin();
          updateTopbar();
          closeModal();
          toast(`💎 ${fmt(res.granted)}ジェムを獲得しました！（デモ決済）`, 'ok', 3000);
        } catch (err) { audio.error(); toast(err.message, 'err'); }
      };
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
    <h2>👑 称号</h2>
    <div class="form-col title-list">
      <button class="title-row ${!data.equipped ? 'equipped' : ''}" data-title="">
        <span class="t-name" style="color:var(--muted)">称号なし</span>
      </button>
      ${data.titles.map(t => {
        const earned = data.earned.includes(t.id);
        const eq = data.equipped === t.id;
        return `
        <button class="title-row ${eq ? 'equipped' : ''} ${earned ? '' : 'locked'}" data-title="${t.id}" ${earned ? '' : 'disabled'}>
          <span class="t-name" style="color:${t.color}">${earned ? '' : '🔒 '}${t.name}</span>
          <span class="t-desc">${t.desc}</span>
        </button>`;
      }).join('')}
    </div>`);
  m.querySelectorAll('[data-title]').forEach(btn => {
    btn.onclick = async () => {
      if (!session.user) { showAuthModal(); return; }
      try {
        await api('/api/titles/equip', { method: 'POST', body: { id: btn.dataset.title || null } });
        audio.click();
        toast(btn.dataset.title ? '称号を装備しました' : '称号を外しました', 'ok', 1500);
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
  const m = showModal(`
    <h2>⚙️ 設定</h2>
    <div class="form-col">
      <div class="settings-row">
        <label>🔊 効果音</label>
        <input type="range" id="setSfxVol" min="0" max="100" value="${Math.round(s.sfxVol * 100)}">
        <input type="checkbox" id="setSfxOn" ${s.sfxOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>🎵 BGM</label>
        <input type="range" id="setMusicVol" min="0" max="100" value="${Math.round(s.musicVol * 100)}">
        <input type="checkbox" id="setMusicOn" ${s.musicOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>📳 画面シェイク</label>
        <input type="checkbox" id="setShake" ${s.shake ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <label>✨ パーティクル量</label>
        <div class="seg" id="setParticles">
          <button data-p="low" ${s.particles === 'low' ? 'class="active"' : ''}>少なめ</button>
          <button data-p="normal" ${s.particles === 'normal' ? 'class="active"' : ''}>標準</button>
          <button data-p="high" ${s.particles === 'high' ? 'class="active"' : ''}>多め</button>
        </div>
      </div>
      <div class="settings-row danger-row">
        <label>🗑️ ローカルデータをリセット</label>
        <button class="btn btn-sm btn-ghost" id="setResetLocal">実行</button>
      </div>
      ${session.user ? `
      <div class="settings-row danger-row">
        <label>⚠️ アカウントを完全削除</label>
        <button class="btn btn-sm btn-ghost" id="setDeleteAccount" style="color:var(--red)">削除</button>
      </div>` : ''}
      <div class="modal-buttons">
        <button class="btn btn-primary" id="setClose">閉じる</button>
      </div>
    </div>`);

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
      <h2>🗑️ ローカルデータをリセット</h2>
      <p class="muted center" style="margin-bottom:14px">設定・ゲストのベストスコア・隠し難易度の解放状態を消去します。<br>アカウントのデータ（コイン・スコア等）は残ります。</p>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rlNo">やめる</button>
        <button class="btn btn-ai" id="rlYes">リセットする</button>
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
      <h2>⚠️ アカウント削除</h2>
      <p class="muted center" style="margin-bottom:14px">「${escapeHtml(session.user.username)}」を完全に削除します。<br>コイン・スコア・購入アイテムはすべて失われ、元に戻せません。</p>
      <div class="form-col">
        <input id="delPass" type="password" placeholder="パスワードを入力して確認" autocomplete="current-password">
        <div class="form-error" id="delError"></div>
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="delNo">やめる</button>
          <button class="btn btn-ai" id="delYes">完全に削除する</button>
        </div>
      </div>`);
    c.querySelector('#delNo').onclick = () => { closeModal(); showSettingsModal(); };
    c.querySelector('#delYes').onclick = async () => {
      try {
        await api('/api/me', { method: 'DELETE', body: { password: c.querySelector('#delPass').value } });
        setToken(null);
        session.user = null;
        toast('アカウントを削除しました。ご利用ありがとうございました', 'ok', 3000);
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
  list.innerHTML = '<p class="muted center">読み込み中…</p>';
  try {
    const data = await api(`/api/leaderboard?board=${board}`);
    if (!data.rows.length) {
      list.innerHTML = '<p class="muted center">まだ記録がありません。最初の挑戦者になろう！</p>';
      return;
    }
    const medal = i => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    const badgeIcons = { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈' };
    list.innerHTML = data.rows.map((r, i) => `
      <div class="lb-row ${session.user && r.username === session.user.username ? 'me' : ''}" style="animation-delay:${Math.min(i * 40, 600)}ms">
        <div class="lb-rank ${i === 0 ? 'top1' : ''}">${medal(i)}</div>
        <div class="lb-name">${escapeHtml(r.username)}
          <span class="lb-badges">${(r.badges || []).map(b => badgeIcons[b] || '').join('')}</span>
          ${r.title ? `<span class="lb-title" style="color:${escapeHtml(r.title.color)}">《${escapeHtml(r.title.name)}》</span>` : ''}
          <div class="lb-lvl">Lv.${r.level}${board === 'rating' ? ` ・ ${r.pvpWins}勝${r.pvpLosses}敗` : ''}</div>
        </div>
        <div class="lb-score">${fmt(board === 'rating' ? r.rating : r.bestScore)}</div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

let shopItems = null;
let shopTab = 'skin';

export async function openShop(tab = shopTab) {
  showScreen('shop');
  shopTab = tab;
  $$('[data-shop]').forEach(t => t.classList.toggle('active', t.dataset.shop === tab));
  const grid = $('#shopGrid');
  grid.innerHTML = '<p class="muted center">読み込み中…</p>';
  try {
    if (!shopItems) shopItems = (await api('/api/shop')).items;
  } catch (err) {
    grid.innerHTML = `<p class="muted center">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderShop();
}

function renderShop() {
  const grid = $('#shopGrid');
  const u = session.user;
  const items = shopItems.filter(i => i.cat === shopTab);
  grid.innerHTML = '';
  items.forEach((item, idx) => {
    const owned = u ? u.owned.includes(item.id) : item.price === 0;
    const equipped = u ? u.equipped[item.cat] === item.id : !!item.default;
    const cur = item.currency === 'gems' ? '💎' : '🪙';
    const el = document.createElement('div');
    el.className = `shop-item ${equipped ? 'equipped' : ''}`;
    el.style.animationDelay = `${Math.min(idx * 50, 400)}ms`;
    el.innerHTML = `
      <div class="shop-preview" data-pv="${item.id}"></div>
      <div class="shop-name">${item.name}</div>
      <div class="shop-desc">${item.desc}</div>
      ${equipped
        ? '<button class="btn btn-sm btn-ghost" disabled>✓ 装備中</button>'
        : owned
          ? '<button class="btn btn-sm btn-primary" data-act="equip">装備する</button>'
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
    const icons = { fx_default: '✨', fx_fireworks: '🎆', fx_thunder: '⚡', fx_sakura: '🌸' };
    el.textContent = icons[item.id] || '✨';
  }
}

async function buyItem(item) {
  if (!session.user) { showAuthModal(); return; }
  try {
    await api('/api/shop/buy', { method: 'POST', body: { itemId: item.id } });
    audio.coin();
    toast(`${item.name} を購入しました！`, 'ok');
    updateTopbar();
    renderShop();
  } catch (err) {
    audio.error();
    toast(err.message, 'err');
  }
}

async function equipItem(item) {
  if (!session.user) return;
  try {
    await api('/api/equip', { method: 'POST', body: { slot: item.cat, itemId: item.id } });
    audio.click();
    toast(`${item.name} を装備しました`, 'ok');
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
  header.innerHTML = '<p class="muted">読み込み中…</p>';
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
  if (r.type === 'badge') return { icon: { bronze: '🥉', silver: '🥈', gold: '🥇', oni: '👹', kami: '🔱', maou: '😈' }[r.id] || '🎖️', label: 'バッジ' };
  const names = { skin_neon: 'ネオン', skin_candy: 'キャンディ', skin_gold: 'ゴールド', board_ocean: 'オーシャン', board_sunset: 'サンセット', fx_fireworks: '花火' };
  return { icon: '🎁', label: names[r.id] || 'アイテム' };
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
      <span class="muted" style="font-size:13px">残り ${daysLeft}日</span>
    </div>
    <div class="bp-xpbar"><div style="width:${pct}%"></div></div>
    <div class="bp-row">
      <span style="font-size:13px;font-weight:700">ティア ${Math.min(unlockedTier, maxTier)} / ${maxTier}
        <span class="muted">（次まで ${unlockedTier >= maxTier ? '—' : fmt(data.xpPerTier - inTier) + ' XP'}）</span></span>
      ${prog && !prog.premium
        ? `<button class="btn btn-sm btn-gold" id="bpBuyPremium">💎 ${fmt(data.premiumPriceGems)} でプレミアム解放</button>`
        : prog ? '<span style="color:var(--gold);font-weight:800">👑 プレミアム</span>'
        : '<span class="muted" style="font-size:12px">ログインで進行が有効になります</span>'}
    </div>`;

  const buyBtn = $('#bpBuyPremium');
  if (buyBtn) buyBtn.onclick = async () => {
    try {
      await api('/api/battlepass/premium', { method: 'POST' });
      audio.levelUp();
      toast('プレミアムパスを解放しました！', 'ok');
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
          ${claimable ? `<button class="bp-claim-btn" data-tier="${t.tier}" data-track="${track}">受取</button>` : ''}
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
        toast(`${icon} ${label} を受け取りました！`, 'ok');
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
  statsEl.innerHTML = '<p class="muted">読み込み中…</p>';
  usersEl.innerHTML = '';
  try {
    const [stats, usersData, txData] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/users'),
      api('/api/admin/transactions').catch(() => ({ totalCount: 0, totalJpy: 0 })),
    ]);
    adminStats = stats;
    statsEl.innerHTML = `
      <div class="stat-card"><b>${fmt(stats.totalUsers)}</b><span>登録ユーザー</span></div>
      <div class="stat-card"><b>${fmt(stats.online)}</b><span>オンライン</span></div>
      <div class="stat-card"><b>${fmt(stats.activeMatches)}</b><span>対戦中</span></div>
      <div class="stat-card"><b>${fmt(stats.openRooms || 0)}</b><span>ルーム</span></div>
      <div class="stat-card"><b>${fmt(stats.totalGames)}</b><span>総プレイ数</span></div>
      <div class="stat-card"><b>${fmt(stats.bannedUsers)}</b><span>凍結中</span></div>
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

function renderAdminUsers(users) {
  const usersEl = $('#adminUsers');
  usersEl.innerHTML = users
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(u => `
    <div class="admin-user-row ${u.banned ? 'banned' : ''}" data-uid="${u.id}">
      <span class="au-name">${u.role === 'admin' ? '🛡️' : '👤'} ${escapeHtml(u.username)}</span>
      <span class="au-meta">Lv.${u.level} ・ 🪙${fmt(u.coins)} ・ 💎${fmt(u.gems)} ・ 🏆${fmt(u.stats.bestScore)} ・ R${u.stats.rating}${u.banned ? ' ・ ⛔凍結中' : ''}</span>
      <span class="au-actions">
        <button class="btn btn-sm btn-ghost" data-a="coins">+🪙</button>
        <button class="btn btn-sm btn-ghost" data-a="gems">+💎</button>
        ${u.role !== 'admin' ? `
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
