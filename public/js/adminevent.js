// 👑 管理者イベント — client side.
//
// Three surfaces:
//   1. the menu banner (countdown → "予約する" → "LIVE 参加する")
//   2. the reservation sheet (pick your time slot)
//   3. the lobby for a live slot (shared world state + start button)
//
// The server is the only clock that matters: everything here re-derives from
// the `adminEvent` block that /api/status returns, so a tab left open
// overnight still shows the truth.

import { api, session } from './net.js';
import { $, showModal, closeModal, toast, fmt, updateTopbar } from './dom.js';
import { t, catName, catDesc } from './i18n.js';
import { audio } from './audio.js';
import { icon, medalIconName, itemIconName } from './icons.js';

// 管理者イベントの4つの回。サーバー（server/adminevent.js）の AE_MODES は
// 絵文字の icon を持っているが、画面には出さず id から独自アイコンを引く。
// 👁️ゼロ は badge_zero（見開いた目）。 🏛️共同作業 は hall（列柱の建物）。
const AE_MODE_ICONS = { invasion: 'mode_adminevent', roulette: 'gacha', communal: 'hall', zero: 'badge_zero' };
const aeModeIcon = (size = 18) => icon(AE_MODE_ICONS[ae && ae.mode ? ae.mode.id : ''] || 'mode_adminevent', { size });
import { startAdminEventMode } from './modes.js';

let ae = null;              // latest playerView from the server
let tickTimer = null;
let remindedFor = null;     // dayKey:slotId we already warned about
let openedFor = null;       // dayKey:slotId whose "your slot is open" we fired

export function getAdminEvent() { return ae; }

// True while the signed-in player may actually play the exclusive mode.
export function aeIsLive() {
  return !!(ae && ae.live && ae.live.endsAt > Date.now());
}

export function setAdminEvent(data) {
  const was = ae;
  ae = data || null;
  updateAeBanner();
  if (!ae) return;
  // 予約した枠が開いた瞬間だけは、見逃さないように大きく出す。
  const key = ae.live ? `${ae.dayKey}:${ae.live.slotId}` : null;
  if (key && key !== openedFor) {
    openedFor = key;
    if (!was || !was.live) announceOpen();
  }
}

function localized(o, key) {
  const en = o[`${key}En`];
  return t(o[key], en || o[key]);
}

function modeName() { return ae ? localized(ae.mode, 'name') : ''; }

function fmtRemain(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 86400) return t(`${Math.floor(s / 86400)}日${Math.floor((s % 86400) / 3600)}時間`,
    `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);
  if (s >= 3600) return t(`${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`,
    `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return t(`${s}秒`, `${s}s`);
}

function dateLabel() {
  if (!ae) return '';
  const d = ae.date;
  return t(`${d.mo}/${d.d}(${ae.weekdayJa})`, `${ae.weekdayEn} ${d.mo}/${d.d}`);
}

function mySlot() {
  if (!ae || !ae.mine) return null;
  return ae.slots.find(s => s.id === ae.mine.slotId) || null;
}

// ---------------------------------------------------------------------------
// Menu banner
// ---------------------------------------------------------------------------

export function updateAeBanner() {
  const el = $('#aeBanner');
  if (!el) return;
  if (!ae) {
    el.classList.add('hidden');
    el.classList.remove('live', 'booked');
    stopTick();
    return;
  }
  const now = Date.now();
  const slot = mySlot();
  let text, cls = '';

  if (ae.live) {
    cls = 'live';
    text = t(`${modeName()} 開催中！ 残り${fmtRemain(ae.live.endsAt - now)} — タップして参加`,
      `${modeName()} is LIVE! ${fmtRemain(ae.live.endsAt - now)} left — tap to join`);
  } else if (slot && slot.over) {
    text = t(`${slot.time}の枠は終了 — 次回は来週${dateLabel()}`,
      `Your ${slot.time} slot is over — back next week`);
  } else if (slot) {
    cls = 'booked';
    text = t(`管理者イベント ${dateLabel()} ${slot.time} 予約済み — あと${fmtRemain(slot.startsAt - now)}`,
      `Admin Event ${dateLabel()} ${slot.time} booked — starts in ${fmtRemain(slot.startsAt - now)}`);
  } else {
    text = t(`管理者イベント「${modeName()}」${dateLabel()}開催 — 時間枠を予約しよう！`,
      `Admin Event "${modeName()}" on ${dateLabel()} — reserve your time slot!`);
  }

  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('live', cls === 'live');
  el.classList.toggle('booked', cls === 'booked');
  el.onclick = () => { audio.click(); openAeSheet(); };
  startTick();
  maybeRemind();
}

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!ae) { stopTick(); return; }
    // A slot boundary passed — the banner's own words are stale; re-render and
    // let the next /api/status swap `live` in.
    updateAeBanner();
  }, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// 10分前と1分前に、予約した人にだけ。
function maybeRemind() {
  const slot = mySlot();
  if (!ae || !slot || ae.live) return;
  const left = slot.startsAt - Date.now();
  const key = `${ae.dayKey}:${slot.id}`;
  if (left <= 0) return;
  if (left <= 60_000 && remindedFor !== `${key}:1`) {
    remindedFor = `${key}:1`;
    audio.click();
    toast(t(`まもなく ${slot.time}！ 管理者イベント「${modeName()}」がはじまります`,
      `${slot.time} is almost here — "${modeName()}" starts in a moment`), 'announce', 5000);
  } else if (left <= 600_000 && left > 60_000 && !String(remindedFor || '').startsWith(key)) {
    remindedFor = `${key}:10`;
    toast(t(`あと10分で あなたの枠（${slot.time}）です`,
      `Your ${slot.time} slot opens in 10 minutes`), 'announce', 4500);
  }
}

function announceOpen() {
  audio.victory();
  toast(t(`あなたの枠がはじまりました！「${modeName()}」に参加できます`,
    `Your slot is open! Join "${modeName()}" now`), 'announce', 6000);
}

// ---------------------------------------------------------------------------
// Reservation sheet
// ---------------------------------------------------------------------------

function slotRow(s) {
  const now = Date.now();
  const mine = ae.mine && ae.mine.slotId === s.id;
  const state = s.live ? t('開催中', 'LIVE') : s.over ? t('終了', 'ended') : fmtRemain(s.startsAt - now);
  const people = s.taken > 0
    ? t(`${s.taken}人が予約`, `${s.taken} booked`)
    : t('まだ誰もいません', 'nobody yet');
  return `
    <button class="ae-slot${mine ? ' mine' : ''}${s.live ? ' live' : ''}" data-slot="${s.id}" ${s.over ? 'disabled' : ''}>
      <span class="ae-slot-time">${s.time}</span>
      <span class="ae-slot-meta">
        <b>${state}</b>
        <span class="muted">${people}</span>
      </span>
      <span class="ae-slot-pick">${mine ? icon('check', { size: 16 }) : s.over ? '—' : t('予約', 'Book')}</span>
    </button>`;
}

function worldHtml() {
  if (!ae || !ae.world) return '';
  const w = ae.world;
  if (ae.mode.id === 'invasion' && w.maxHp) {
    const pct = Math.max(0, Math.round((w.hp / w.maxHp) * 100));
    return `
      <div class="ae-world">
        <div class="ae-world-label">${t('みんなで削っている管理者HP', 'The admin HP everyone is chipping at')}</div>
        <div class="ae-hpbar"><div style="width:${pct}%"></div></div>
        <div class="ae-world-sub">${fmt(Math.max(0, w.hp))} / ${fmt(w.maxHp)} ${w.killedAt ? t('— 討伐済み！', '— DEFEATED!') : ''}</div>
      </div>`;
  }
  if (ae.mode.id === 'communal' && w.tiers && w.tiers.length) {
    const goal = w.tiers[w.tiers.length - 1].at;
    const pct = Math.max(0, Math.min(100, Math.round((w.total / goal) * 100)));
    // 段階報酬を受け取るボタンが、これまでクライアントに存在しなかった。
    // サーバーには /api/adminevent/claim があり報酬を配る実装も入っているのに、
    // 呼ぶ側が無いので「ゲージを満タンにしても所持金が1円も動かない」状態だった。
    // 参加していて、まだ受け取っていない段階があるときだけ出す。
    const claimed = (ae.mine && ae.mine.claimedTiers) || [];
    const ready = [];
    for (let i = 0; i < (w.tiersReached || 0); i++) if (!claimed.includes(i)) ready.push(i);
    const joined = !!(ae.mine && ae.mine.runs);
    const purse = ready.reduce((acc, i) => ({
      coins: acc.coins + (w.tiers[i].coins || 0),
      gems: acc.gems + (w.tiers[i].gems || 0),
    }), { coins: 0, gems: 0 });
    return `
      <div class="ae-world">
        <div class="ae-world-label">${t('全員の合計スコア', 'Everyone’s combined score')}</div>
        <div class="ae-gauge"><div style="width:${pct}%"></div></div>
        <div class="ae-world-sub">${fmt(w.total)} / ${fmt(goal)} ・ ${t(`目標 ${w.tiersReached}/${w.tiers.length} 達成`, `${w.tiersReached}/${w.tiers.length} tiers cleared`)}</div>
        ${joined && ready.length ? `
        <button class="btn btn-primary ae-claim" id="aeClaim">
          ${t(`報酬を受け取る（${ready.length}段階ぶん・コイン${fmt(purse.coins)} ジェム${purse.gems}）`,
                 `Collect rewards (${ready.length} tier${ready.length > 1 ? 's' : ''} — ${fmt(purse.coins)} coins, ${purse.gems} gems)`)}
        </button>` : ''}
        ${joined && !ready.length && w.tiersReached ? `
        <div class="ae-world-sub ae-claimed">${icon('check', { size: 14 })} ${t('この段階の報酬は受け取り済み', 'Rewards for these tiers collected')}</div>` : ''}
      </div>`;
  }
  if (w.board && w.board.length) {
    return `
      <div class="ae-world">
        <div class="ae-world-label">${t('今日のトップ', 'Today’s top scores')}</div>
        ${w.board.slice(0, 3).map((b, i) => `<div class="ae-world-sub">${icon(medalIconName(i + 1), { size: 16 })} ${b.name} — ${fmt(b.score)}</div>`).join('')}
      </div>`;
  }
  return '';
}

export async function openAeSheet() {
  if (!ae) return;
  const live = aeIsLive();
  const m = showModal(`
    <h2>${icon('mode_adminevent', { size: 20 })} ${t('管理者イベント', 'Admin Event')}</h2>
    <div class="ae-head">
      <div class="ae-mode-name">${aeModeIcon(22)} ${modeName()}</div>
      <div class="ae-mode-tag">${localized(ae.mode, 'tagline')}</div>
      <p class="ae-mode-desc">${localized(ae.mode, 'desc')}</p>
      ${ae.note ? `<p class="ae-note">${esc(ae.note)}</p>` : ''}
      <p class="muted center" style="font-size:12px">
        ${t(`${dateLabel()} 開催 ・ 1枠 ${ae.durationMin}分 ・ 報酬 ${ae.rewardMult}倍`,
          `${dateLabel()} ・ ${ae.durationMin} min per slot ・ ${ae.rewardMult}× rewards`)}
      </p>
    </div>
    ${worldHtml()}
    ${live ? `<button class="btn btn-gold btn-big" id="aeJoin">${t('いま参加する！', 'Join now!')}</button>` : ''}
    <div class="ae-slot-label">${t('あなたが遊ぶ時間帯をえらんでください', 'Pick the time that suits you')}</div>
    <div class="ae-slots">${ae.slots.map(slotRow).join('')}</div>
    <p class="muted center" style="font-size:11.5px">${t('※ どの枠を選んでも、上の進捗はみんなで共有されます', '※ Whichever slot you pick, the progress above is shared by everyone')}</p>
    <div class="modal-buttons">
      ${ae.mine && ae.closesAt > Date.now() ? `<button class="btn btn-ghost" id="aeCancel">${t('予約をとりけす', 'Cancel booking')}</button>` : ''}
      <button class="btn btn-throne" id="aeTreasury">${icon('shards', { size: 16 })} ${t('王座の宝物庫', 'Throne Vault')}</button>
      ${ae.mode.id === 'zero' ? `<button class="btn btn-ghost" id="aeChronicle">${t('断罪録', 'Chronicle')}</button>` : ''}
      <button class="btn btn-ghost" id="aeClose">${t('とじる', 'Close')}</button>
    </div>`);

  m.querySelector('#aeClose').onclick = closeModal;
  const vault = m.querySelector('#aeTreasury');
  if (vault) vault.onclick = () => { audio.click(); openThroneVault(); };
  const chron = m.querySelector('#aeChronicle');
  if (chron) chron.onclick = () => { audio.click(); openChronicle(); };
  const join = m.querySelector('#aeJoin');
  if (join) join.onclick = () => { closeModal(); startAdminEventMode(ae); };

  m.querySelectorAll('[data-slot]').forEach(btn => {
    btn.onclick = async () => {
      if (!session.user) {
        toast(t('予約にはアカウント登録が必要です', 'You need an account to reserve a slot'), 'err');
        return;
      }
      audio.click();
      btn.disabled = true;
      try {
        const res = await api('/api/adminevent/reserve', { method: 'POST', body: { slotId: Number(btn.dataset.slot) } });
        setAdminEvent(res.event);
        const s = mySlot();
        toast(t(`${s ? s.time : ''} の枠を予約しました！`, `Booked your ${s ? s.time : ''} slot!`), 'ok', 3500);
        closeModal();
        openAeSheet();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'err');
      }
    };
  });

  const cancel = m.querySelector('#aeCancel');
  if (cancel) cancel.onclick = async () => {
    audio.click();
    try {
      const res = await api('/api/adminevent/cancel', { method: 'POST' });
      setAdminEvent(res.event);
      toast(t('予約をとりけしました', 'Booking cancelled'), 'ok');
      closeModal();
      openAeSheet();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  // 🏛️共同作業の段階報酬。サーバー側は最初からあったのに、押す場所が
  // どこにも無かったので誰も受け取れていなかった。
  const claim = m.querySelector('#aeClaim');
  if (claim) claim.onclick = async () => {
    audio.click();
    claim.disabled = true;
    try {
      const res = await api('/api/adminevent/claim', { method: 'POST' });
      if (res.event) setAdminEvent(res.event);
      // コインとジェムが増えるので、画面上部の表示も合わせる。
      if (res.user) { session.user = res.user; updateTopbar(); }
      const g = res.reward || {};
      const bits = [];
      if (g.coins) bits.push(t(`コイン${fmt(g.coins)}`, `${fmt(g.coins)} coins`));
      if (g.gems) bits.push(t(`ジェム${g.gems}`, `${g.gems} gems`));
      if (g.badge) bits.push(t('バッジ', 'a badge'));
      audio.victory?.();
      toast(t(`${bits.join(' ') || '報酬'} を受け取りました！`,
              `Collected ${bits.join(' ') || 'your rewards'}!`), 'ok', 3500);
      closeModal();
      openAeSheet();
    } catch (err) {
      claim.disabled = false;
      toast(err.message, 'err');
    }
  };
}

// Pull a fresh view (after finishing a run, the shared gauge moved).
export async function refreshAdminEvent() {
  try {
    const res = await api('/api/adminevent');
    setAdminEvent(res.event);
    return res.event;
  } catch {
    return ae;
  }
}

// modes.js finishes a run and needs the shared world state re-read. Going
// through a window hook (the same trick #btnBoss uses) keeps modes.js free of
// an import back into this file.
window.__bbaAeRefresh = refreshAdminEvent;
window.__bbaAeGet = getAdminEvent;

// ---------------------------------------------------------------------------
// 👑 王座の宝物庫 ── 管理者イベント専用ショップ
// ---------------------------------------------------------------------------
// ここの品はコインでもジェムでもガチャでも手に入らない。通貨は
// 「王座の欠片」だけで、欠片は管理者イベントの中でしか増えない。
//
// 面白いのは棚の開きかたで、買えるかどうかが自分の財布ではなく
// 世界がどこまで段を割ったかで決まる。第7段の品は、七つの王座が
// 全部返ってくるまで、世界の誰ひとり買えない。
export async function openThroneVault() {
  let data;
  try { data = await api('/api/throne/shop'); }
  catch (err) { toast(err.message, 'err'); return; }
  renderVault(data);
}

function renderVault(data) {
  const max = data.throneMax || 0;
  const row = (i) => {
    const state = i.owned ? 'owned' : (!i.unlocked ? 'locked' : ((data.shards || 0) >= i.shards ? 'buy' : 'poor'));
    const label = i.owned ? t('所持ずみ', 'Owned')
      : !i.unlocked ? t(`第${i.dan}段が割れるまで`, `Until stage ${i.dan} falls`)
      : `${icon('shards', { size: 14 })} ${fmt(i.shards)}`;
    return `<div class="tv-item ${state}">
      <div class="tv-icon">${icon(itemIconName(i), { size: 28 })}</div>
      <div class="tv-body">
        <div class="tv-name">${catName(i)}<span class="tv-dan">${t(`第${i.dan}段`, `St.${i.dan}`)}</span></div>
        <div class="tv-desc">${catDesc(i)}</div>
      </div>
      <button class="tv-buy" data-buy="${i.id}" ${state === 'buy' ? '' : 'disabled'}>${label}</button>
    </div>`;
  };
  const R = data.rates || {};
  const m = showModal(`
    <h2>${icon('shards', { size: 24 })} ${t('王座の宝物庫', 'Throne Vault')}</h2>
    <p class="muted center" style="font-size:12px">${t(
      'ここの品はコインでもジェムでもガチャでも手に入りません。管理者イベントの中でしか増えない「王座の欠片」だけで交換します。',
      'Nothing here can be bought with coins, gems, or the gacha. Only Throne Shards — and shards only come from Admin Events.')}</p>
    <div class="tv-wallet">${icon('shards', { size: 18 })} <b>${fmt(data.shards || 0)}</b> ${t('王座の欠片', 'Throne Shards')}</div>
    <div class="tv-progress">
      <div class="tv-crowns">${[1,2,3,4,5,6,7].map(n => `<span class="${n <= max ? 'on' : ''}">${icon('throne', { size: 16 })}</span>`).join('')}</div>
      <div class="tv-progress-txt">${max >= 7
        ? t('七つの王座、すべて奪還ずみ。棚は全部ひらいています。', 'All seven thrones reclaimed. Every shelf is open.')
        : t(`世界は第${max}段まで割りました ── 第${max + 1}段が割れると、次の棚がひらきます`,
            `The world has broken through stage ${max} — the next shelf opens when stage ${max + 1} falls`)}</div>
    </div>
    <div class="tv-list">${(data.items || []).map(row).join('')}</div>
    <details class="tv-rates">
      <summary>${t('欠片の集めかた', 'How to earn shards')}</summary>
      <ul>
        <li>${t(`断罪を斬る … 欠片${R.cut || 3}（急所ごとなら +${R.keystone || 5}）`, `Cut a condemnation … ${R.cut || 3} shards (+${R.keystone || 5} with the keystone)`)}</li>
        <li>${t(`段が割れた瞬間に居合わせる … 欠片${R.danPresent || 40}（とどめなら +${R.danFinish || 80}）`, `Be there when a stage falls … ${R.danPresent || 40} shards (+${R.danFinish || 80} for the finishing blow)`)}</li>
        <li>${t(`共同作業の目標を達成 … 欠片${(R.tier || [25])[0]}〜${(R.tier || [0,0,0,250])[3]}`, `Clear a Great Work tier … ${(R.tier || [25])[0]}–${(R.tier || [0,0,0,250])[3]} shards`)}</li>
        <li>${t(`侵攻ボスを討ち取る … 欠片${R.bossKill || 120}`, `Bring down the invasion boss … ${R.bossKill || 120} shards`)}</li>
        <li>${t(`その日はじめて席につく … 欠片${R.join || 10}（1日1回）`, `First time you take a seat that day … ${R.join || 10} shards (once daily)`)}</li>
      </ul>
    </details>
    <div class="modal-buttons"><button class="btn btn-ghost" id="tvClose">${t('とじる', 'Close')}</button></div>`);

  m.querySelector('#tvClose').onclick = closeModal;
  m.querySelectorAll('[data-buy]').forEach(btn => {
    btn.onclick = async () => {
      audio.click();
      btn.disabled = true;
      try {
        const res = await api('/api/throne/buy', { method: 'POST', body: { itemId: btn.dataset.buy } });
        if (res.user) { session.user = res.user; updateTopbar(); }
        toast(t(`「${res.got.name}」を手に入れました！`, `You obtained 「${catName(res.got)}」!`), 'ok', 3500);
        closeModal();
        openThroneVault();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'err');
      }
    };
  });
}

// （カテゴリごとの絵文字の表はここにあったが、宝物庫の絵は icons.js の
//  itemIconName(item) が引くようになったので消した。表が2つあると、
//  ショップと宝物庫で同じ品が別の絵になる。）

// ---------------------------------------------------------------------------
// 📜 断罪録
// ---------------------------------------------------------------------------
// その日ゼロが誰に何を言ったかが、実名つきで時系列に残る。
// 消えた住人と、次の枠へ残された伝言もここ。ログイン不要。
export async function openChronicle() {
  let data;
  try { data = await api('/api/zero/chronicle'); }
  catch (err) { toast(err.message, 'err'); return; }
  const run = data.run;
  if (!run) {
    showModal(`<h2>${t('断罪録', 'The Chronicle')}</h2>
      <p class="muted center">${t('まだ何も書かれていません。断罪がはじまると、ここに記録が残ります。',
        'Nothing is written yet. Once CONDEMNED begins, the record appears here.')}</p>
      <div class="modal-buttons"><button class="btn btn-ghost" id="chClose">${t('とじる', 'Close')}</button></div>`);
    document.querySelector('#chClose').onclick = closeModal;
    return;
  }
  const line = (e) => {
    const who = e.by ? esc(e.by) : '';
    switch (e.kind) {
      case 'cut':    return `<li class="ch-cut">${t(`<b>${who}</b> が第${e.dan}段の封印を斬った`, `<b>${who}</b> cut the seal of stage ${e.dan}`)}${e.keystone ? ` <i>${t('急所', 'keystone')}</i>` : ''}</li>`;
      case 'missed': return `<li class="ch-miss">${t(`<b>${who}</b> が落とした`, `<b>${who}</b> missed`)}${e.victim ? t(` ── ${esc(e.victim)} が処刑された`, ` — ${esc(e.victim)} was executed`) : ''}</li>`;
      case 'dan':    return `<li class="ch-dan">${t(`第${e.dan}段 陥落`, `Stage ${e.dan} has fallen`)}${e.by ? t(`（とどめ: ${esc(e.by)}）`, ` (finished by ${esc(e.by)})`) : ''}</li>`;
      // 🤝 chronicle(run,'deal', {win, tally, q}) が書くのは win / tally / q。
      //    ここは e.pick を読んでいたので**常に undefined** ＝ 断罪録には
      //    「取引が成立した」としか出ず、飲んだのか断ったのかが永久に分からなかった。
      case 'deal': {
        const yes = e.win === 'yes';
        const tally = e.tally && (e.tally.yes != null) ? `（${e.tally.yes} 対 ${e.tally.no}）` : '';
        const q = e.q ? `<span class="ch-deal-q">${esc(String(e.q).slice(0, 60))}</span>` : '';
        return `<li class="ch-deal">${q}${e.win
          ? t(`取引を${yes ? '飲んだ' : '断った'}${tally}`, `The bargain was ${yes ? 'accepted' : 'refused'}${tally}`)
          : t('取引が成立した', 'A bargain was struck')}</li>`;
      }
      default:       return `<li>${esc(e.kind || '')} ${who}</li>`;
    }
  };
  const m = showModal([
    `<h2>${t('断罪録', 'The Chronicle')}</h2>`,
    `<p class="muted center" style="font-size:12px">${t(`${run.dayKey} ・ いまは第${run.dan}段`, `${run.dayKey} — currently stage ${run.dan}`)}</p>`,
    run.broken && run.broken.length
      ? `<div class="ch-sec"><h3>${t('割れた段', 'Stages broken')}</h3><ul class="ch-list">${
          run.broken.map(b => `<li class="ch-dan">${t(`第${b.dan}段`, `Stage ${b.dan}`)}${b.by ? t(`（とどめ: ${esc(b.by)}）`, ` (finished by ${esc(b.by)})`) : ''}</li>`).join('')
        }</ul></div>` : '',
    run.fallen && run.fallen.length
      ? `<div class="ch-sec"><h3>${t('今日、消えた住人', 'Lost today')}</h3>
         <p class="ch-fallen">${run.fallen.map(x => esc(x.name)).join('、')}</p>
         <p class="muted" style="font-size:11px">${t('明日には戻ってきます。', 'They return tomorrow.')}</p></div>` : '',
    run.wills && run.wills.length
      ? `<div class="ch-sec"><h3>${t('前の枠からの言伝', 'Messages from earlier slots')}</h3><ul class="ch-list">${
          run.wills.map(w => `<li class="ch-will">「${esc(w.text)}」 ── ${esc(w.by)}</li>`).join('')
        }</ul></div>` : '',
    `<div class="ch-sec"><h3>${t('記録', 'Record')}</h3>`,
    (run.log && run.log.length)
      ? `<ul class="ch-list ch-log">${run.log.slice().reverse().map(line).join('')}</ul>`
      : `<p class="muted">${t('まだ記録がありません。', 'Nothing recorded yet.')}</p>`,
    '</div>',
    `<div class="modal-buttons"><button class="btn btn-ghost" id="chClose">${t('とじる', 'Close')}</button></div>`,
  ].join(''));
  m.querySelector('#chClose').onclick = closeModal;
}

// 断罪録には実名がそのまま並ぶので、必ず通してから入れる。
function esc(x) {
  return String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
