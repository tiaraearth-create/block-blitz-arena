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
import { t } from './i18n.js';
import { audio } from './audio.js';
import { startAdminEventMode } from './modes.js';

let ae = null;              // latest playerView from the server
let tickTimer = null;
let remindedFor = null;     // dayKey:slotId we already warned about
let openedFor = null;       // dayKey:slotId whose "your slot is open" we fired

export function getAdminEvent() { return ae; }

// True while the signed-in player may actually play the exclusive mode.
export function aeIsLive() {
  return !!(ae && ae.live && ae.closesAt > Date.now());
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
    text = t(`🔴 ${ae.mode.icon} ${modeName()} 開催中！ 残り${fmtRemain(ae.live.endsAt - now)} — タップして参加`,
      `🔴 ${ae.mode.icon} ${modeName()} is LIVE! ${fmtRemain(ae.live.endsAt - now)} left — tap to join`);
  } else if (slot && slot.over) {
    text = t(`👑 ${slot.time}の枠は終了 — 次回は来週${dateLabel()}`,
      `👑 Your ${slot.time} slot is over — back next week`);
  } else if (slot) {
    cls = 'booked';
    text = t(`👑 管理者イベント ${dateLabel()} ${slot.time} 予約済み — あと${fmtRemain(slot.startsAt - now)}`,
      `👑 Admin Event ${dateLabel()} ${slot.time} booked — starts in ${fmtRemain(slot.startsAt - now)}`);
  } else {
    text = t(`👑 ${ae.mode.icon}「${modeName()}」${dateLabel()}開催 — 時間枠を予約しよう！`,
      `👑 ${ae.mode.icon} "${modeName()}" on ${dateLabel()} — reserve your time slot!`);
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
    toast(t(`👑 まもなく ${slot.time}！ 管理者イベント「${modeName()}」がはじまります`,
      `👑 ${slot.time} is almost here — "${modeName()}" starts in a moment`), 'announce', 5000);
  } else if (left <= 600_000 && left > 60_000 && !String(remindedFor || '').startsWith(key)) {
    remindedFor = `${key}:10`;
    toast(t(`👑 あと10分で あなたの枠（${slot.time}）です`,
      `👑 Your ${slot.time} slot opens in 10 minutes`), 'announce', 4500);
  }
}

function announceOpen() {
  audio.victory();
  toast(t(`🔴 あなたの枠がはじまりました！ ${ae.mode.icon}「${modeName()}」に参加できます`,
    `🔴 Your slot is open! Join ${ae.mode.icon} "${modeName()}" now`), 'announce', 6000);
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
        <b>${s.live ? `🔴 ${state}` : state}</b>
        <span class="muted">${people}</span>
      </span>
      <span class="ae-slot-pick">${mine ? '✅' : s.over ? '—' : t('予約', 'Book')}</span>
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
          🎁 ${t(`報酬を受け取る（${ready.length}段階ぶん・${fmt(purse.coins)}🪙 ${purse.gems}💎）`,
                 `Collect rewards (${ready.length} tier${ready.length > 1 ? 's' : ''} — ${fmt(purse.coins)}🪙 ${purse.gems}💎)`)}
        </button>` : ''}
        ${joined && !ready.length && w.tiersReached ? `
        <div class="ae-world-sub ae-claimed">✅ ${t('この段階の報酬は受け取り済み', 'Rewards for these tiers collected')}</div>` : ''}
      </div>`;
  }
  if (w.board && w.board.length) {
    return `
      <div class="ae-world">
        <div class="ae-world-label">${t('今日のトップ', 'Today’s top scores')}</div>
        ${w.board.slice(0, 3).map((b, i) => `<div class="ae-world-sub">${['🥇', '🥈', '🥉'][i]} ${b.name} — ${fmt(b.score)}</div>`).join('')}
      </div>`;
  }
  return '';
}

export async function openAeSheet() {
  if (!ae) return;
  const live = aeIsLive();
  const m = showModal(`
    <h2>${ae.mode.icon} ${t('管理者イベント', 'Admin Event')}</h2>
    <div class="ae-head">
      <div class="ae-mode-name">${modeName()}</div>
      <div class="ae-mode-tag">${localized(ae.mode, 'tagline')}</div>
      <p class="ae-mode-desc">${localized(ae.mode, 'desc')}</p>
      ${ae.note ? `<p class="ae-note">📣 ${ae.note}</p>` : ''}
      <p class="muted center" style="font-size:12px">
        ${t(`${dateLabel()} 開催 ・ 1枠 ${ae.durationMin}分 ・ 🎁 報酬 ${ae.rewardMult}倍`,
          `${dateLabel()} ・ ${ae.durationMin} min per slot ・ 🎁 ${ae.rewardMult}× rewards`)}
      </p>
    </div>
    ${worldHtml()}
    ${live ? `<button class="btn btn-gold btn-big" id="aeJoin">${t('🔴 いま参加する！', '🔴 Join now!')}</button>` : ''}
    <div class="ae-slot-label">${t('あなたが遊ぶ時間帯をえらんでください', 'Pick the time that suits you')}</div>
    <div class="ae-slots">${ae.slots.map(slotRow).join('')}</div>
    <p class="muted center" style="font-size:11.5px">${t('※ どの枠を選んでも、上の進捗はみんなで共有されます', '※ Whichever slot you pick, the progress above is shared by everyone')}</p>
    <div class="modal-buttons">
      ${ae.mine ? `<button class="btn btn-ghost" id="aeCancel">${t('予約をとりけす', 'Cancel booking')}</button>` : ''}
      <button class="btn btn-ghost" id="aeClose">${t('とじる', 'Close')}</button>
    </div>`);

  m.querySelector('#aeClose').onclick = closeModal;
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
        toast(t(`✅ ${s ? s.time : ''} の枠を予約しました！`, `✅ Booked your ${s ? s.time : ''} slot!`), 'ok', 3500);
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
      if (g.coins) bits.push(`${fmt(g.coins)}🪙`);
      if (g.gems) bits.push(`${g.gems}💎`);
      if (g.badge) bits.push(t('バッジ', 'a badge'));
      audio.victory?.();
      toast(t(`🎁 ${bits.join(' ') || '報酬'} を受け取りました！`,
              `🎁 Collected ${bits.join(' ') || 'your rewards'}!`), 'ok', 3500);
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
