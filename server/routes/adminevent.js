// 👑 管理者イベント — 週1・枠の予約制。参加者側（予約／取消／結果／受け取り）と
// 運営側（日程の設定）、それに世界の到達段を動かす口。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
import express from 'express';
import path from 'path';
import {
  saveDb,
} from '../db.js';
import {
  requireAuth, requireAdmin,
} from '../auth.js';
import {
  AE_MODES, WEEKDAYS_JA as AE_WEEKDAYS_JA, jstDayKey, aeMode as aeModeById, getSchedule as getAeSchedule, normalizeSchedule as aeNormalizeSchedule, currentOccurrence as aeCurrentOccurrence, upcomingOccurrences as aeUpcoming, reserve as aeReserve, cancelReservation as aeCancelReservation, liveSlotFor as aeLiveSlotFor, ensureRun as aeEnsureRun, contribute as aeContribute, isStaff as aeIsStaff, playerView as aePlayerView, slotCounts as aeSlotCounts, entrantCount as aeEntrantCount, SHARD as AE_SHARD, throneMax as aeThroneMax,
} from '../adminevent.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, seedLastResultAt, publicUser, GEMDROP_DAILY_CAP, applyGameResult, pickResultFields, rateLimit, battle, adminLog;
export function initAdminEventRoutes() {
  ({ db, seedLastResultAt, publicUser, GEMDROP_DAILY_CAP, applyGameResult, pickResultFields, rateLimit, battle, adminLog } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const adminEventRouter = express.Router();
export const throneAdminRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 👑 管理者イベント — weekly, with per-player time slots
// ---------------------------------------------------------------------------

// Reservation counts + the shared world state, recomputed per request. There
// are no timers: everything derives from wall-clock time, so a redeploy in the
// middle of an event changes nothing.
export function adminEventView(user) {
  const schedule = getAeSchedule(db);
  if (!schedule.enabled) return null;
  const occ = aeCurrentOccurrence(schedule);
  if (!occ) return null;
  return aePlayerView(db, user, Date.now(), aeSlotCounts(db, occ));
}

adminEventRouter.get('/api/adminevent', (req, res) => {
  res.json({ event: adminEventView(req.user) });
});

adminEventRouter.post('/api/adminevent/reserve', requireAuth, maintenanceGuard, (req, res) => {
  const schedule = getAeSchedule(db);
  if (!schedule.enabled) return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  // 試運転中は運営以外、そもそも存在しないのと同じ扱いにする
  // （見えないのに予約だけ通る、という中途半端な状態を作らない）。
  if (schedule.staffOnly && !aeIsStaff(req.user)) {
    return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  }
  const occ = aeCurrentOccurrence(schedule);
  if (!occ) return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  const slotId = Math.floor(Number(req.body && req.body.slotId));
  const r = aeReserve(req.user, occ, slotId);
  if (r.error) return res.status(400).json({ error: r.error });
  saveDb();
  res.json({ event: adminEventView(req.user), user: publicUser(req.user) });
});

adminEventRouter.post('/api/adminevent/cancel', requireAuth, (req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  if (occ) aeCancelReservation(req.user, occ.dayKey);
  // 開催が無いときの後片付けも、実績は控えに残してから外す（開催中の経路と
  // 挙動を揃えないと、ここを通るだけで受取済みの記録が消えてしまう）。
  else if (req.user.adminEvent) {
    req.user.adminEventDay = { ...req.user.adminEvent };
    req.user.adminEvent = null;
  }
  saveDb();
  res.json({ event: adminEventView(req.user) });
});

// Finish one run of the exclusive mode. The score is folded into the SHARED
// world state (one boss / one gauge / one board per event day), so the 18:00
// crowd and the 21:00 crowd are demonstrably working on the same thing.
adminEventRouter.post('/api/adminevent/result', requireAuth, maintenanceGuard, (req, res) => {
  // /api/game/result と同じ回数制限。ここだけ無かったので、枠の30分間
  // ジェムを1回40個ずつ何度でも取れた（枠は誰でも自分で予約できる）。
  if (!rateLimit(`aeresult:${req.user.id}`, 30, 60 * 1000)
      || !rateLimit(`aeresulth:${req.user.id}`, 250, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます。しばらく待ってください' });
  }
  const schedule = getAeSchedule(db);
  // graceMs=125000: 固定120秒ランの結果が、枠終了ちょうどで走り切った直後でも
  // 受理されるよう猶予を与える(1ラン=120秒 + 送信/クロックの余白5秒)。
  // 枠の「開始前」は猶予対象外なので、早撃ちには使えない。
  const live = schedule.enabled ? aeLiveSlotFor(schedule, req.user, Date.now(), 125000) : null;
  if (!live) return res.status(403).json({ error: 'いまはあなたの枠の時間ではありません' });

  const { occ } = live;
  const counts = aeSlotCounts(db, occ);
  const run = aeEnsureRun(db, occ, Math.max(1, aeEntrantCount(counts)));

  // Same anti-cheat ceiling the normal result path uses, then the event's own
  // reward multiplier on top (🎁 お宝ラッシュ).
  const body = req.body || {};
  let duration = Math.max(1, Math.min(3600, Number(body.duration) || 1));
  // duration はクライアント申告なので、/api/game/result と同じく
  // 「前回の提出からの実経過時間」で頭を押さえる。ここが無かったので
  // duration:3600 を書くだけで毎回 score=1,000,000 を通せた。
  {
    // 基準の入れ方は applyGameResult 側と同じ（seedLastResultAt）。
    // ここだけ一律300秒にしていると、初参加の人の長い1回が切り詰められる。
    const now = Date.now();
    const last = seedLastResultAt(req.user);
    const elapsed = (now - last) / 1000 + 90;
    if (duration > elapsed) duration = Math.max(1, Math.floor(elapsed));
    req.user.stats.lastResultAt = now;
  }
  let score = Math.max(0, Math.min(1_000_000, Math.floor(Number(body.score) || 0)));
  if (score > duration * 500) score = Math.floor(duration * 500);

  const before = { hp: run.hp, tiersReached: run.tiersReached };
  const delta = aeContribute(run, req.user, score);

  const rewards = applyGameResult(req.user, {
    // ここも素通しにしない。`trusted` を自己申告で立てられてしまう。
    ...pickResultFields(body),
    mode: `ae_${run.modeId}`,
    score,
    duration,
    won: !!delta.killed,
    // duration の頭押さえは上で済ませてある。二度やると 45,000点 で
    // 頭打ちになる（このイベントは1枠180分あり、倍率も乗る）。
    preClamped: true,
  });

  // 🎁 お宝ラッシュ — the slot's own multiplier, paid on top of whatever the
  // normal pipeline granted, and reported separately so the result screen can
  // show where it came from.
  const mult = Math.max(1, schedule.rewardMult || 1);
  let chestCoins = 0, chestGems = 0;
  if (mult > 1 && rewards) {
    chestCoins = Math.round(rewards.coins * (mult - 1));
    // 💎は課金通貨。通常経路(applyGameResult の eventGems, GEMDROP_DAILY_CAP)
    // と同じ日次上限をここにも課す。ここだけ上限が無く、枠内で /result を連投
    // するとジェムを日次上限を超えて積み増せる穴だった。予算は st.eventGemDay
    // で通常ドロップと共有し、「1日に湧く💎総額」を一本化する。
    const st = req.user.stats;
    const today = jstDayKey();
    if (!st.eventGemDay || st.eventGemDay.day !== today) st.eventGemDay = { day: today, got: 0 };
    const room = Math.max(0, GEMDROP_DAILY_CAP - st.eventGemDay.got);
    const scoreGems = Math.min(Math.floor(score / 25_000), room);
    st.eventGemDay.got += scoreGems;
    // とどめ(+25)は1枠で最大1回、討伐という実イベントに紐づくので上限とは別枠。
    chestGems = scoreGems + (delta.killed ? 25 : 0);
    req.user.coins += chestCoins;
    req.user.gems += chestGems;
  }

  const r = req.user.adminEvent;
  if (r && r.dayKey === occ.dayKey) {
    r.playedAt = Date.now();
    r.runs = (r.runs || 0) + 1;
    r.best = Math.max(r.best || 0, score);
    r.contributed = (r.contributed || 0) + score;
    r.chests = (r.chests || 0) + 1;
  }
  // 👑 王座の欠片。参加ぶんは1日1回だけ ── 回すほど貯まると、
  // 専用ショップが「回数の店」になって、居合わせた意味が薄れるので。
  let shardGain = 0;
  if (r && r.dayKey === occ.dayKey && !r.shardJoin) { r.shardJoin = true; shardGain += AE_SHARD.join; }
  for (const idx of delta.tiersReached) {
    shardGain += AE_SHARD.tier[Math.min(idx, AE_SHARD.tier.length - 1)];
  }
  if (delta.killed) shardGain += AE_SHARD.bossKill;
  if (shardGain > 0) req.user.shards = (req.user.shards || 0) + shardGain;

  req.user.stats.aePlays = (req.user.stats.aePlays || 0) + 1;
  req.user.stats.aeBest = Math.max(req.user.stats.aeBest || 0, score);

  // 👑 Everyone who took part in the day the Admin fell keeps the badge — the
  // final blow is luck, the 120,000 HP was the group's work.
  let aeBadge = null;
  if (run.modeId === 'invasion' && run.killedAt) {
    for (const u of Object.values(db.users)) {
      const ur = u && u.adminEvent;
      if (!ur || ur.dayKey !== occ.dayKey || !ur.runs) continue;
      if (!u.badges.includes('adminevent')) {
        u.badges.push('adminevent');
        if (u.id === req.user.id) aeBadge = 'adminevent';
      }
    }
  }

  // World-scale moments go to everyone, not just the people currently in a slot.
  if (delta.killed) {
    const mode = aeModeById(run.modeId);
    battle.broadcastAll({
      type: 'announce',
      message: `「${req.user.username}」のとどめ！ ${mode ? mode.name : '管理者'}を全員で討ち取りました！`,
      messageEn: `"${req.user.username}" lands the final blow — everyone brought the Admin down together!`,
      from: '運営',
    });
    battle.crowd.feed({ icon: '👑', real: true, who: '運営',
      text: `管理者イベントのボスが討伐されました（とどめ: ${req.user.username}）`,
      textEn: `The Admin Event boss has been defeated (final blow: ${req.user.username})` });
  }
  for (const idx of delta.tiersReached) {
    const tier = run.tiers[idx];
    battle.broadcastAll({
      type: 'announce',
      message: `共同作業 目標${idx + 1}達成！ 参加者全員に コイン${tier.coins} ジェム${tier.gems}`,
      messageEn: `The Great Work cleared tier ${idx + 1}! Everyone who took part gets ${tier.coins} coins and ${tier.gems} gems`,
      from: '運営',
    });
  }

  saveDb();
  res.json({
    rewards, user: publicUser(req.user),
    chest: { coins: chestCoins, gems: chestGems, mult },
    delta: { gained: delta.gained, damage: delta.damage, killed: delta.killed, tiersReached: delta.tiersReached },
    shards: shardGain,
    aeBadge,
    before,
    event: adminEventView(req.user),
  });
});

// Community-goal payouts are claimed, not pushed — a player who was in the
// 18:00 slot can collect a tier the 21:00 crowd unlocked later.
adminEventRouter.post('/api/adminevent/claim', requireAuth, maintenanceGuard, (req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  const run = db.meta.adminEventRun;
  if (!run || run.modeId !== 'communal') return res.status(409).json({ error: '受け取れる報酬がありません' });
  const r = req.user.adminEvent;
  if (!r || r.dayKey !== run.dayKey || !r.runs) {
    return res.status(403).json({ error: 'この回に参加していません' });
  }
  const claimed = r.claimedTiers || (r.claimedTiers = []);
  // Nothing reached yet is NOT the same as already collected — saying
  // "受け取り済みです" to someone whose gauge simply has not filled is a lie.
  if (!run.tiersReached) {
    return res.status(409).json({ error: 'まだ目標に届いていません（ゲージを進めよう）' });
  }
  let coins = 0, gems = 0, badge = null;
  for (let i = 0; i < run.tiersReached; i++) {
    if (claimed.includes(i)) continue;
    claimed.push(i);
    coins += run.tiers[i].coins;
    gems += run.tiers[i].gems;
    if (run.tiers[i].badge && !req.user.badges.includes(run.tiers[i].badge)) {
      req.user.badges.push(run.tiers[i].badge);
      badge = run.tiers[i].badge;
    }
  }
  if (!coins && !gems && !badge) return res.status(409).json({ error: '受け取り済みです' });
  req.user.coins += coins;
  req.user.gems += gems;
  saveDb();
  res.json({ reward: { coins, gems, badge }, user: publicUser(req.user), event: adminEventView(req.user) });
});

// ---- admin side ----

adminEventRouter.get('/api/admin/adminevent', requireAuth, requireAdmin, (_req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  const counts = occ ? aeSlotCounts(db, occ) : {};
  const roster = [];
  if (occ) {
    for (const u of Object.values(db.users)) {
      const r = u && u.adminEvent;
      if (r && r.dayKey === occ.dayKey) {
        roster.push({ username: u.username, slotId: r.slotId, runs: r.runs || 0, best: r.best || 0 });
      }
    }
    roster.sort((a, b) => a.slotId - b.slotId || b.best - a.best);
  }
  res.json({
    schedule,
    modes: AE_MODES,
    weekdays: AE_WEEKDAYS_JA,
    occurrences: aeUpcoming(schedule, Date.now(), 2).map(o => ({
      dayKey: o.dayKey, modeId: o.modeId, opensAt: o.opensAt, closesAt: o.closesAt,
      slots: o.slots.map(s => ({ id: s.id, time: s.time, startsAt: s.startsAt, endsAt: s.endsAt, taken: counts[s.id] || 0 })),
    })),
    roster,
    run: db.meta.adminEventRun || null,
  });
});

adminEventRouter.post('/api/admin/adminevent', requireAuth, requireAdmin, (req, res) => {
  const prev = db.meta.adminEvent || null;
  const r = aeNormalizeSchedule(req.body || {}, prev);
  if (r.error) return res.status(400).json({ error: r.error });
  const wasEnabled = prev && prev.enabled;
  r.schedule.updatedAt = Date.now();
  r.schedule.updatedBy = req.user.username;
  db.meta.adminEvent = r.schedule;
  // Re-scheduling to a different day — or switching the mode — abandons the
  // old shared state; it belongs to the day+mode pair it was created for.
  const occ = r.schedule.enabled ? aeCurrentOccurrence(r.schedule) : null;
  const run = db.meta.adminEventRun;
  if (run && (!occ || run.dayKey !== occ.dayKey || run.modeId !== occ.modeId)) {
    db.meta.adminEventRun = null;
  }
  saveDb();
  // 🧾 週次イベントの日程変更。schedule.updatedBy は「最後に触った人」しか
  // 残らない（上書きされる）ので、履歴としては操作ログのほうに残す。
  adminLog(req, 'adminevent_schedule', r.schedule.enabled ? (occ ? occ.dayKey : 'enabled') : 'off', {
    enabled: !!r.schedule.enabled,
    rotation: r.schedule.rotation || null,
    modeId: occ ? occ.modeId : null,
    weekday: r.schedule.weekday,
    slots: Array.isArray(r.schedule.slots) ? r.schedule.slots.join('/') : null,
    runCleared: db.meta.adminEventRun === null && !!run,
  });

  if (r.schedule.enabled && !wasEnabled && occ) {
    const mode = aeModeById(occ.modeId);
    const times = r.schedule.slots.join(' / ');
    battle.broadcastAll({
      type: 'announce',
      message: `管理者イベント「${mode.name}」開催決定！ ${occ.dayKey} の ${times}（JST）— メニューから好きな時間帯を予約してね`,
      messageEn: `Admin Event "${mode.nameEn}" is scheduled for ${occ.dayKey} at ${times} JST — reserve the slot that suits you from the menu`,
      from: '運営',
    });
    battle.crowd.feed({ icon: '👑', real: true, who: '運営',
      text: `管理者イベント「${mode.name}」の予約受付がはじまりました`,
      textEn: `Reservations are open for the Admin Event "${mode.nameEn}"` });
  }
  res.json({ schedule: r.schedule });
});

// 👑 管理者イベント専用ショップの棚は、その人の財布ではなく世界がどこまで段を
// 割ったかで開く。だから「買えない」は「金が足りない」ではなく「まだ誰も
// 割っていない」になる（棚そのものは routes/shop.js の /api/throne/shop）。
//
// 世界の到達段を運営が動かす口。断罪を実際に回さないと進まない値なので、
// これが無いと宝物庫の棚を試すことも、事故で巻き戻ったときに戻すこともできない。
// 棚が開くのは世界全体に効くので、運営だけ・記録つきにしてある。
throneAdminRouter.post('/api/admin/throne', requireAuth, requireAdmin, (req, res) => {
  const n = Number(req.body.throneMax);
  if (!Number.isFinite(n) || n < 0 || n > 7) return res.status(400).json({ error: '0〜7 で指定してください' });
  const before = aeThroneMax(db);
  db.meta.throneMax = Math.trunc(n);
  saveDb();
  console.log(`[throne] ${req.user.username} が世界の到達段を ${before} → ${db.meta.throneMax} に変更`);
  // 🧾 宝物庫の棚は世界全体に効く。console.log はプロセスが死ねば消えるので、
  // 「事故で巻き戻ったときに戻す」ための証跡は操作ログのほうに残す。
  adminLog(req, 'throne_set', String(db.meta.throneMax), { before, after: db.meta.throneMax });
  res.json({ throneMax: db.meta.throneMax, before });
});
