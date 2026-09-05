// 👑 管理者イベント (Admin Event) — a weekly, admin-hosted event that every
// player attends in a TIME SLOT THEY CHOSE.
//
// Why slots: this world usually has a handful of real humans online, spread
// across timezones and school/work hours. A single fixed start time means most
// of the roster is asleep for it. So the admin publishes one event DAY with
// several slots (18:00 / 19:00 / 21:00 JST …); each player reserves ONE, and
// their personal 30-minute window opens at that time.
//
// The slots are not isolated rooms. All of the day's slots feed the SAME
// world state — one shared boss HP bar, one shared community gauge, one
// shared leaderboard — so the 18:00 crowd and the 21:00 crowd are visibly
// working on the same thing. Async co-op, essentially.
//
// Everything here is pure data + math over `db.meta.adminEvent`. There are no
// in-memory timers: "is the event live for this user right now?" is always
// recomputed from wall-clock time, so a server restart (or a redeploy in the
// middle of the event) changes nothing.

// ---------------------------------------------------------------------------
// Time (JST). Render runs the server in UTC; the players are in Japan. JST has
// no DST, so a fixed offset is exactly right — and, unlike a tz database, it
// cannot drift between Node versions.
// ---------------------------------------------------------------------------

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Wall-clock JST parts of an instant.
export function jstParts(ts = Date.now()) {
  const d = new Date(ts + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(),
    wd: d.getUTCDay(), hh: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}

// The instant of a JST wall-clock moment.
function jstEpoch(y, mo, d, hh = 0, mi = 0) {
  return Date.UTC(y, mo, d, hh, mi, 0, 0) - JST_OFFSET_MS;
}

// 'YYYY-MM-DD' of the JST day an instant falls in. This is the identity of an
// occurrence: reservations, the shared boss and the day's board all key off it.
export function jstDayKey(ts = Date.now()) {
  const p = jstParts(ts);
  return `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
export const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 'HH:MM' -> minutes since JST midnight, or null when malformed.
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const hh = Number(m[1]), mi = Number(m[2]);
  if (hh < 0 || hh > 23 || mi < 0 || mi > 59) return null;
  return hh * 60 + mi;
}
export function fmtHHMM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The three exclusive modes. They exist ONLY inside an admin-event slot —
// that is the whole point of the reservation.
// ---------------------------------------------------------------------------

// icon（絵文字）をやめて iconName（public/js/icons.js の名前）にした。
// 👑 は段位マスター・王座・管理者奧義・二/三/五冠バッジと重なっていて、
// 「管理者イベント」だとは見分けが付かなかった。
// ※ 選択肢（<option>）には SVG を置けないので、管理画面のプルダウンは
//   名前だけを出す（public/js/screens.js）。
export const AE_MODES = [
  {
    id: 'invasion', iconName: 'mode_adminevent',
    name: '管理者襲来', nameEn: 'Admin Invasion',
    tagline: '全員 vs 管理者',
    taglineEn: 'Everyone vs the Admin',
    desc: '管理者の分身が盤面に干渉してくる総力戦。その日の参加者全員の合計ダメージで巨大HPを削り切れ！',
    descEn: 'A total war against the admin’s avatar, who meddles with your board in real time. Every participant of the day chips at one enormous HP bar — break it together!',
  },
  {
    id: 'roulette', iconName: 'gacha',
    name: '運営ルーレット', nameEn: 'Operator Roulette',
    tagline: '30秒ごとにルールが変わる',
    taglineEn: 'The rules rewrite every 30s',
    desc: '30秒ごとに運営がルーレットを回し、盤面のルールが書き換わるカオス番組。何が出るかは運営次第。',
    descEn: 'Every 30 seconds the house spins the wheel and rewrites the rules of your board. A chaos game show — nobody knows what comes next.',
  },
  {
    id: 'communal', iconName: 'hall',
    name: '共同作業', nameEn: 'The Great Work',
    tagline: '全員のスコアが1本のゲージに',
    taglineEn: 'Every score feeds one gauge',
    desc: 'その日の参加者全員のスコアが1本のゲージに合流。段階目標を越えるたび、参加者全員に報酬が降ります。',
    descEn: 'Every participant’s score of the day flows into a single gauge. Each tier you clear pays out to everyone who took part.',
  },
  {
    id: 'zero', iconName: 'badge_zero',
    // 🧪 試験中。自動ローテーションには入らない（rotation:'zero' と
    // 明示したときだけ動く）。実際に自分で一度回して、数字と手触りを
    // 確かめてからこの行を消す。消し忘れても全員に出てしまうことはない。
    trial: true,
    name: '断罪', nameEn: 'Condemned',
    tagline: '人間しか封印を割れない',
    taglineEn: 'Only humans can break the seal',
    desc: '管理者ゼロが七つの王座を人質に取った。段のHPは7割までしか点数で削れず、残り3割の「封印」を貫通できるのは、30秒ごとに来る【断罪】を斬った一撃だけ。住人は斬れない。鍵を持っているのは生身の人間だけです。\n\n【断罪のしかた】赤いマスが3.5秒だけ点灯します。そのマスを通るラインを消せば「斬った」。金色のマスは急所で、含めて斬ると貫通が倍になります。\n【落とすとどうなるか】時間内に斬れないと、赤マスがそのままお邪魔になり、アリーナの住人が1人、名前つきで処刑されます。その日はもう戻ってきません。',
    descEn: 'Admin Zero has taken all seven thrones hostage. Only 70% of each stage can be worn down by score — the remaining 30% is sealed, and the seal yields only to a CONDEMNATION cut, which arrives every 30 seconds and which no resident can make. The key is held by living players alone.\n\n[How to cut] Red cells light up for 3.5 seconds. Clear a line through them and you have cut. The gold cell is the keystone — include it and the damage doubles.\n[If you miss] The red cells turn to garbage, and one resident of the arena is executed by name. They do not come back for the rest of the day.',
  },
];

export function aeMode(id) {
  return AE_MODES.find(m => m.id === id) || null;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export const AE_MAX_SLOTS = 6;
export const AE_MIN_DURATION = 10;
export const AE_MAX_DURATION = 180;

export function defaultSchedule() {
  return {
    enabled: false,
    // 🔒 試運転。true の間は運営（admin/mod）にしか見えず、参加もできない。
    // 新しいモードを本番で自分だけ確かめるための軸。
    staffOnly: false,
    weekday: 6,                              // Saturday (JST)
    slots: ['18:00', '19:00', '21:00'],      // JST wall clock
    durationMin: 30,
    // 'auto' rotates the three modes week by week; a concrete id pins one.
    rotation: 'auto',
    // Rewards inside your own slot. お宝ラッシュ.
    rewardMult: 2,
    note: '',
    updatedAt: null,
    updatedBy: null,
  };
}

// Validate + clamp admin input into a storable schedule.
export function normalizeSchedule(input = {}, prev = null) {
  const base = prev ? { ...defaultSchedule(), ...prev } : defaultSchedule();
  const out = { ...base };

  if (input.enabled !== undefined) out.enabled = !!input.enabled;

  if (input.weekday !== undefined) {
    const wd = Math.floor(Number(input.weekday));
    if (!Number.isFinite(wd) || wd < 0 || wd > 6) {
      return { error: '曜日が不正です（0=日曜〜6=土曜）' };
    }
    out.weekday = wd;
  }

  if (input.slots !== undefined) {
    if (!Array.isArray(input.slots)) return { error: '時間枠のリストが不正です' };
    const mins = [];
    for (const raw of input.slots) {
      const m = parseHHMM(raw);
      if (m === null) return { error: `時間枠「${String(raw).slice(0, 8)}」が不正です（HH:MM 形式）` };
      if (!mins.includes(m)) mins.push(m);
    }
    if (mins.length === 0) return { error: '時間枠を1つ以上えらんでください' };
    if (mins.length > AE_MAX_SLOTS) return { error: `時間枠は最大${AE_MAX_SLOTS}個までです` };
    mins.sort((a, b) => a - b);
    out.slots = mins.map(fmtHHMM);
  }

  if (input.durationMin !== undefined) {
    const d = Math.floor(Number(input.durationMin));
    if (!Number.isFinite(d) || d < AE_MIN_DURATION || d > AE_MAX_DURATION) {
      return { error: `1枠の長さは${AE_MIN_DURATION}〜${AE_MAX_DURATION}分です` };
    }
    out.durationMin = d;
  }

  if (input.rotation !== undefined) {
    const r = String(input.rotation);
    if (r !== 'auto' && !aeMode(r)) return { error: 'モードの指定が不正です' };
    out.rotation = r;
  }

  if (input.rewardMult !== undefined) {
    const r = Number(input.rewardMult);
    if (!Number.isFinite(r) || r < 1 || r > 5) return { error: '報酬倍率は1〜5倍です' };
    out.rewardMult = Math.round(r * 10) / 10;
  }

  if (input.staffOnly !== undefined) out.staffOnly = !!input.staffOnly;
  if (input.note !== undefined) out.note = String(input.note || '').slice(0, 140);

  // Slots must not overlap each other, or a player could sit in two at once
  // and the "which session am I in" answer stops being well defined.
  const mins = out.slots.map(parseHHMM);
  for (let i = 1; i < mins.length; i++) {
    if (mins[i] - mins[i - 1] < out.durationMin) {
      return { error: `枠が重なっています（${out.slots[i - 1]} と ${out.slots[i]} は${out.durationMin}分以上あけてください）` };
    }
  }
  // The last slot must still end on the same JST day, so a slot's day key can
  // never disagree with the day the player reserved.
  if (mins.length && mins[mins.length - 1] + out.durationMin > 24 * 60) {
    return { error: `最後の枠が日をまたぎます（${out.slots[mins.length - 1]} + ${out.durationMin}分）` };
  }
  return { schedule: out };
}

export function getSchedule(db) {
  const raw = db.meta && db.meta.adminEvent;
  return raw ? { ...defaultSchedule(), ...raw } : defaultSchedule();
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

// The JST midnight instant of the Nth event weekday at or after `from`.
function eventDayStart(schedule, from) {
  const p = jstParts(from);
  const todayMidnight = jstEpoch(p.y, p.mo, p.d);
  let delta = (schedule.weekday - p.wd + 7) % 7;
  return todayMidnight + delta * DAY_MS;
}

function slotsOf(schedule, dayStart) {
  return schedule.slots.map((hhmm, i) => {
    const startsAt = dayStart + parseHHMM(hhmm) * 60000;
    return {
      id: i,
      time: hhmm,
      startsAt,
      endsAt: startsAt + schedule.durationMin * 60000,
    };
  });
}

// Build the occurrence for the event day that `dayStart` opens.
function occurrenceAt(schedule, dayStart) {
  const slots = slotsOf(schedule, dayStart);
  return {
    dayKey: jstDayKey(dayStart + 12 * 60 * 60 * 1000),   // noon anchor: never a boundary
    weekday: schedule.weekday,
    slots,
    opensAt: slots[0].startsAt,
    closesAt: slots[slots.length - 1].endsAt,
    modeId: weekModeId(schedule, dayStart),
  };
}

// The occurrence players should be looking at: the one running now, else the
// next one whose last slot has not finished.
export function currentOccurrence(schedule, now = Date.now()) {
  if (!schedule.enabled || !schedule.slots.length) return null;
  let dayStart = eventDayStart(schedule, now);
  // `now` may sit past the final slot of today's occurrence — then the answer
  // is next week, not a closed event.
  for (let i = 0; i < 2; i++) {
    const occ = occurrenceAt(schedule, dayStart);
    if (occ.closesAt > now) return occ;
    dayStart += 7 * DAY_MS;
  }
  return null;
}

// Two occurrences ahead — used by the admin panel preview.
export function upcomingOccurrences(schedule, now = Date.now(), count = 2) {
  const out = [];
  const cur = currentOccurrence(schedule, now);
  if (!cur) return out;
  let dayStart = cur.opensAt - parseHHMM(schedule.slots[0]) * 60000;
  for (let i = 0; i < count; i++) {
    out.push(occurrenceAt(schedule, dayStart));
    dayStart += 7 * DAY_MS;
  }
  return out;
}

// Weekly rotation of the exclusive mode. Anchored on the occurrence itself, so
// two players looking at the same event day always see the same mode no matter
// when they ask.
export function weekModeId(schedule, dayStart) {
  if (schedule.rotation && schedule.rotation !== 'auto' && aeMode(schedule.rotation)) {
    return schedule.rotation;
  }
  // 試験中(trial)のモードは自動ローテーションに入れない。
  // 入れてしまうと、まだ確かめていないモードがその週いきなり全員に出る。
  // 出したいときは rotation にそのIDを明示する。
  const pool = AE_MODES.filter(m => !m.trial);
  const list = pool.length ? pool : AE_MODES;
  const weeks = Math.floor(dayStart / (7 * DAY_MS));
  return list[((weeks % list.length) + list.length) % list.length].id;
}

// ---------------------------------------------------------------------------
// Reservations. Stored on the USER record (`user.adminEvent`) so a backup
// merge carries them with the account instead of stranding them in meta.
// ---------------------------------------------------------------------------

export function reservationOf(user, dayKey) {
  const r = user && user.adminEvent;
  if (!r || r.dayKey !== dayKey) return null;
  return r;
}

// 予約が指している枠を引き当てる。
//
// slotId は slotsOf が振る **配列の添字** で、slots は保存のたび HH:MM 昇順に
// 並べ直される。だから運営が枠を1つ足す／消すだけで、既存の予約がまるごと
// 別の時刻へ黙ってずれていた（18:00 を取った人が 17:00 の枠に移り、18:00 に
// 来ても「いまはあなたの枠の時間ではありません」で弾かれる）。
//
// そこで予約には時刻そのもの（slotTime）を持たせ、引き当てはこれを正とする。
// 枠の並びが変わっても 18:00 は 18:00 のままで、その枠自体が消えたときだけ
// 「枠なし」になる（消えた枠の人を勝手に別の時刻へ移さない）。
//
// 古い予約（slotTime を持たない）は従来どおり添字で引き、見つけた時刻を
// 書き戻して以後ずれないようにする。逆に slotTime があって添字だけ古い場合は
// 添字を貼り替える —— 運営画面の予約者一覧など、まだ slotId を見ている側も
// これで正しい時刻を出せる。
export function reservedSlot(occ, r) {
  if (!r || !occ) return null;
  if (r.slotTime) {
    const byTime = occ.slots.find(s => s.time === r.slotTime) || null;
    if (byTime && r.slotId !== byTime.id) r.slotId = byTime.id;
    return byTime;
  }
  const byId = occ.slots.find(s => s.id === r.slotId) || null;
  if (byId) r.slotTime = byId.time;
  return byId;
}

export function reserve(user, occ, slotId, now = Date.now()) {
  const slot = occ.slots.find(s => s.id === slotId);
  if (!slot) return { error: 'その時間枠は存在しません' };
  if (slot.endsAt <= now) return { error: 'その枠はもう終わっています' };
  // 取り消し中でも、その日の実績（受取済みの段・欠片の支払い印）は控えに残る。
  const prev = reservationOf(user, occ.dayKey)
    || (user && user.adminEventDay && user.adminEventDay.dayKey === occ.dayKey ? user.adminEventDay : null);
  // いちど遊んだあとに別の枠へ移ると、お宝ラッシュの倍率つき枠を二重に消化できる。
  // 移り先が開催中でも、前の枠が終わったあとでも同じ抜け道になるので、
  // 「まだ遊んでいない同日内の乗り換え」だけを許し、プレイ済みなら一律に断る。
  // 同じ枠かどうかは（添字ではなく）時刻で見る。添字は枠の編集でずれる。
  const sameSlot = prev && (prev.slotTime ? prev.slotTime === slot.time : prev.slotId === slotId);
  if (prev && !sameSlot && prev.playedAt) {
    return { error: 'すでに参加した日は枠を変更できません' };
  }
  user.adminEvent = {
    // その日の実績は「まるごと」引き継ぐ。残す欄を1つずつ書き出していたころ、
    // あとから足した shardJoin（参加ぶんの王座の欠片を1日1回だけ払う印）が
    // 引き継ぎ表から漏れ、同じ枠を予約し直すだけで +10 欠片を無限に稼げた。
    // 列挙をやめれば、次に欄が増えても同じ漏れ方はしない。
    ...(prev || {}),
    dayKey: occ.dayKey,
    slotId,
    // 枠の同定はこちらが正（slotId は表示・並べ替え用の添字）。
    slotTime: slot.time,
    modeId: occ.modeId,
    reservedAt: now,
    // Progress inside the slot survives a reslot within the same day.
    playedAt: prev ? prev.playedAt || null : null,
    runs: prev ? prev.runs || 0 : 0,
    best: prev ? prev.best || 0 : 0,
    contributed: prev ? prev.contributed || 0 : 0,
    chests: prev ? prev.chests || 0 : 0,
    claimedTiers: prev ? prev.claimedTiers || [] : [],
    reminded: false,
  };
  // 予約に取り込んだので、取り消し中の控えは役目を終える。
  if (user.adminEventDay && user.adminEventDay.dayKey === occ.dayKey) user.adminEventDay = null;
  return { reservation: user.adminEvent, slot };
}

export function cancelReservation(user, dayKey) {
  if (user && user.adminEvent && user.adminEvent.dayKey === dayKey) {
    // 「枠を手放す」ことと「その日に得たものを無かったことにする」ことは別。
    // ここで丸ごと捨てていたので、取り消して予約し直すと claimedTiers が空に
    // 戻り、共闘イベントの段報酬を何度でも受け取れた（実測で1周あたり
    // +1,700🪙 +17💎 が無制限に増え続ける）。枠だけ返して実績は控えておく。
    user.adminEventDay = { ...user.adminEvent };
    user.adminEvent = null;
    return true;
  }
  return false;
}

// The slot a user may PLAY in right now, or null. Admins are always let in —
// they have to be able to test the thing they are hosting.
export function liveSlotFor(schedule, user, now = Date.now(), graceMs = 0) {
  // 試運転中は運営以外、枠が来ていても「あなたの時間ではない」と同じ扱い。
  if (schedule && schedule.staffOnly && !isStaff(user)) return null;
  // graceMs は「結果受付だけ」の猶予。枠終了の間際に始めた 120 秒ランの結果が
  // 枠を数十秒はみ出しても没収しないために使う。終了判定だけ緩め、参加開始・
  // 予約の判定は現行どおり厳格（graceMs 既定 0 なので他の呼び出しは無影響）。
  // その日の最終枠のはみ出しも拾えるよう、日の同定も同じ猶予ぶんずらす。
  const occ = currentOccurrence(schedule, now - graceMs);
  if (!occ) return null;
  const isAdmin = !!user && user.role === 'admin';
  if (isAdmin) {
    const any = occ.slots.find(s => now >= s.startsAt && now < s.endsAt + graceMs);
    if (any) return { occ, slot: any, viaAdmin: true };
  }
  const r = reservationOf(user, occ.dayKey);
  if (!r) return null;
  const slot = reservedSlot(occ, r);
  if (!slot) return null;
  if (now < slot.startsAt || now >= slot.endsAt + graceMs) return null;
  return { occ, slot, reservation: r };
}

// ---------------------------------------------------------------------------
// Shared world state for one occurrence (`db.meta.adminEventRun`).
//
// One record per event DAY, shared by every slot of that day. This is what
// makes 18:00 and 21:00 feel like the same event.
// ---------------------------------------------------------------------------

// Boss HP scales with how many people signed up, so a three-player week is
// still winnable and a busy week is still a fight.
export function bossHpFor(entrants) {
  return 120_000 + Math.max(0, entrants - 1) * 45_000;
}

// 👑 王座の欠片。管理者イベントの中でしか増えない。
// 「参加した」ではなく「何をしたか」に付くようにしてある ──
// 座っているだけで貯まると、専用ショップが時給の店になってしまうので。
export const SHARD = {
  join:      10,   // その日はじめて席についた（1日1回）
  cut:        3,   // 断罪を斬った
  keystone:   5,   // 急所ごと斬った（cut に上乗せ）
  danPresent: 40,  // 段が割れた瞬間その場に居た
  danFinish:  80,  // その段にとどめを刺した（danPresent に上乗せ）
  tier:      [25, 60, 120, 250],   // 共闘ゲージの各段
  bossKill:  120,  // 侵攻ボスを倒した回に居合わせた
};

// 世界がこれまでに割った最高段。専用ショップの棚がこれで開く。
// run は日ごとに作り直されるので、db.meta 側に別で残す必要がある。
export function throneMax(db) {
  return Math.max(0, Math.min(7, (db.meta && db.meta.throneMax) | 0));
}
export function recordThrone(db, dan) {
  const n = Math.max(0, Math.min(7, dan | 0));
  if (n > throneMax(db)) { db.meta.throneMax = n; return true; }
  return false;
}

// Community gauge tiers, likewise sized off the turnout.
export function communalTiers(entrants) {
  const unit = 60_000 + Math.max(0, entrants - 1) * 25_000;
  return [
    { at: unit,     coins: 500,  gems: 5 },
    { at: unit * 3, coins: 1200, gems: 12 },
    { at: unit * 6, coins: 2500, gems: 25 },
    { at: unit * 10, coins: 5000, gems: 50, badge: 'adminevent' },
  ];
}

// A run belongs to a day AND a mode. Matching on the day alone meant that an
// admin switching the mode mid-event kept grinding the old mode's state — a
// communal gauge with no tiers, because the record was still an invasion.
export function getRun(db, occ) {
  const cur = db.meta.adminEventRun;
  if (cur && cur.dayKey === occ.dayKey && cur.modeId === occ.modeId) return cur;
  return null;
}

// A run record that has not been stored yet — what the day looks like before
// the first play lands. Never written; playerView uses it so the shared bar is
// visible from the moment the event opens.
export function virtualRun(occ, entrants) {
  const n = Math.max(1, entrants);
  return {
    dayKey: occ.dayKey, modeId: occ.modeId, entrants: n,
    startedAt: occ.opensAt, total: 0, byUser: {}, board: [],
    maxHp: occ.modeId === 'invasion' ? bossHpFor(n) : 0,
    hp: occ.modeId === 'invasion' ? bossHpFor(n) : 0,
    killedAt: null, killedBy: null,
    tiers: occ.modeId === 'communal' ? communalTiers(n) : [],
    tiersReached: 0,
  };
}

export function ensureRun(db, occ, entrants) {
  let run = getRun(db, occ);
  if (run) {
    // 🕒 いまが何枠目か。**毎回引き直す。**
    //
    // run はその日ぶん（dayKey）で1本なので、slotStartsAt を「作ったとき」に
    // 一度書くだけだと、2枠目・3枠目になっても1枠目の開始時刻を指したままになる。
    // 👁️断罪の取引は「枠の20分地点」を run.slotStartsAt からの経過で測るので
    // （zero-session.js の runDeal）、2枠目以降は席に着いた瞬間にもう20分を
    // 超えていて、**枠の開始直後に開いて誰も気づかないうちに閉じる**。
    // 取引は段のHP半減・住人の復活・的の列変更まで動かすので、結果も片寄る。
    // 枠が変わったら取引の「この段はもう済み」の印も解いて、次の枠でもう一度
    // 開けるようにする（印は段ごと＝dealDoneFor なので、枠をまたぐと居座る）。
    const nowMs2 = Date.now();
    const slot = (occ.slots || []).find(x => nowMs2 >= x.startsAt && nowMs2 < x.endsAt);
    const startsAt = slot ? slot.startsAt : occ.opensAt;
    if (run.slotStartsAt !== startsAt) {
      run.slotStartsAt = startsAt;
      run.dealDoneFor = undefined;
      run.deal = null;
    }
    // 枠の終わりも渡す。取引の発火点は「20分地点」の決め打ちだが、1枠は
    // 管理画面で 10〜180分まで動かせる（AE_MIN/MAX_DURATION）。20分より短い
    // 枠にすると取引は構造的に一度も開かないので、runDeal 側が枠の長さに
    // 合わせて前倒しできるように、終了時刻もここで持たせる。
    run.slotEndsAt = slot ? slot.endsAt : occ.closesAt;
    // Late sign-ups grow the target — but never below what has been dealt.
    if (entrants > (run.entrants || 0)) {
      run.entrants = entrants;
      if (run.modeId === 'invasion' && !run.killedAt) {
        const maxHp = bossHpFor(entrants);
        if (maxHp > run.maxHp) { run.hp += maxHp - run.maxHp; run.maxHp = maxHp; }
      }
      if (run.modeId === 'communal') {
        // 侵攻ボスの「一度与えたダメージは巻き戻さない」と同じ方針を共闘にも。
        // 閾値だけ上げて tiersReached を据え置くと、達成済みの段のラインが総計を
        // 追い越し「目標 1/4 達成」の表示とゲージが食い違う。達成済みの段は元の
        // ラインを保ち、未達の段だけ引き上げて整合させる。
        const grown = communalTiers(entrants);
        const reached = run.tiersReached || 0;
        run.tiers = grown.map((t, i) =>
          (i < reached && run.tiers[i]) ? run.tiers[i] : t);
      }
    }
    return run;
  }
  const modeId = occ.modeId;
  // この回が「どの枠で」始まったか（開始時刻ms）。battle-zero が取引の発火基準に読む。
  // 作成時に生きている枠を採用し、なければその日の開場時刻にフォールバックする。
  const nowMs = Date.now();
  const curSlot = occ.slots.find(s => nowMs >= s.startsAt && nowMs < s.endsAt);
  run = {
    dayKey: occ.dayKey,
    modeId,
    entrants,
    startedAt: occ.opensAt,
    slotStartsAt: curSlot ? curSlot.startsAt : occ.opensAt,
    slotEndsAt: curSlot ? curSlot.endsAt : occ.closesAt,
    total: 0,
    byUser: {},          // userId -> { name, score, runs }
    board: [],           // [{ name, score }] top of the day
    // invasion
    maxHp: modeId === 'invasion' ? bossHpFor(entrants) : 0,
    hp: modeId === 'invasion' ? bossHpFor(entrants) : 0,
    killedAt: null,
    killedBy: null,
    // communal
    tiers: modeId === 'communal' ? communalTiers(entrants) : [],
    tiersReached: 0,
  };
  db.meta.adminEventRun = run;
  return run;
}

// Fold one finished play into the shared state. Returns what changed so the
// caller can announce it.
export function contribute(run, user, score) {
  const gained = Math.max(0, Math.floor(score) || 0);
  const rec = run.byUser[user.id] || (run.byUser[user.id] = { name: user.username, score: 0, runs: 0 });
  rec.name = user.username;
  rec.score += gained;
  rec.runs += 1;
  run.total += gained;

  const out = { gained, damage: 0, killed: false, tiersReached: [] };

  if (run.modeId === 'invasion' && !run.killedAt) {
    out.damage = Math.min(run.hp, gained);
    run.hp -= out.damage;
    if (run.hp <= 0) {
      run.hp = 0;
      run.killedAt = Date.now();
      run.killedBy = user.username;
      out.killed = true;
    }
  }

  if (run.modeId === 'communal') {
    const before = run.tiersReached;
    let reached = 0;
    for (const t of run.tiers) if (run.total >= t.at) reached++;
    if (reached > before) {
      run.tiersReached = reached;
      for (let i = before; i < reached; i++) out.tiersReached.push(i);
    }
  }

  // Day board: best single run per person.
  const b = run.board.find(x => x.id === user.id);
  if (b) { if (gained > b.score) b.score = gained; }
  else run.board.push({ id: user.id, name: user.username, score: gained });
  run.board.sort((a, b2) => b2.score - a.score);
  if (run.board.length > 20) run.board.length = 20;

  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function slotView(slot, now, taken) {
  return {
    id: slot.id,
    time: slot.time,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    live: now >= slot.startsAt && now < slot.endsAt,
    over: now >= slot.endsAt,
    taken: taken || 0,
  };
}

// What every client needs to render the banner, the reservation sheet and the
// live session. `user` may be null (guests see the schedule but cannot book).
// 試運転中は運営だけ。ここ1か所で止めれば、バナーも予約も参加も結果送信も
// まとめて閉じる（playerView が null なら画面に何も出ず、liveSlotFor も
// 別途 staffOnly を見るので API 側も通らない）。
function schedule0(db) { return getSchedule(db); }

export function isStaff(user) {
  return !!(user && (user.role === 'admin' || user.role === 'mod'));
}

export function playerView(db, user, now = Date.now(), counts = null) {
  if (schedule0(db).staffOnly && !isStaff(user)) return null;
  const schedule = getSchedule(db);
  if (!schedule.enabled) return null;
  const occ = currentOccurrence(schedule, now);
  if (!occ) return null;
  const mode = aeMode(occ.modeId) || AE_MODES[0];
  const r = reservationOf(user, occ.dayKey);
  const mySlot = reservedSlot(occ, r);
  const live = liveSlotFor(schedule, user, now);
  // The stored run only appears once somebody FINISHES a play. Without a
  // fallback the very first player of the week saw no boss bar and no gauge —
  // the headline mechanic was invisible until after their first run. This is
  // the same record `ensureRun` would build, computed read-only.
  const run = getRun(db, occ) || virtualRun(occ, entrantCount(counts || slotCounts(db, occ)));
  const p = jstParts(occ.opensAt);

  return {
    dayKey: occ.dayKey,
    date: { y: p.y, mo: p.mo + 1, d: p.d, wd: occ.weekday },
    weekdayJa: WEEKDAYS_JA[occ.weekday],
    weekdayEn: WEEKDAYS_EN[occ.weekday],
    durationMin: schedule.durationMin,
    rewardMult: schedule.rewardMult,
    note: schedule.note || '',
    mode: {
      // 🖼 AE_MODES が持っているのは `iconName`（icons.js の名前）。`mode.icon` は
      //    存在しない欄なので、この行はずっと undefined を配っていた。
      //    いまはクライアントが AE_MODE_ICONS で id から自前に引いているので
      //    実害は出ていないが、欄を出す以上は正しい値にする。
      id: mode.id, icon: mode.iconName || null, iconName: mode.iconName || null,
      name: mode.name, nameEn: mode.nameEn,
      tagline: mode.tagline, taglineEn: mode.taglineEn,
      desc: mode.desc, descEn: mode.descEn,
    },
    slots: occ.slots.map(s => slotView(s, now, counts ? counts[s.id] : 0)),
    opensAt: occ.opensAt,
    closesAt: occ.closesAt,
    // 予約中の枠は時刻から引き直す。枠が編集で消えていたら slotId は null に
    // なり、画面は「予約なし」として扱える（存在しない添字を返さない）。
    mine: r ? {
      slotId: mySlot ? mySlot.id : null,
      slotTime: mySlot ? mySlot.time : (r.slotTime || null),
      runs: r.runs || 0, best: r.best || 0, chests: r.chests || 0, claimedTiers: r.claimedTiers || [],
    } : null,
    live: live ? { slotId: live.slot.id, endsAt: live.slot.endsAt, viaAdmin: !!live.viaAdmin } : null,
    world: run ? {
      total: run.total,
      entrants: run.entrants,
      players: Object.keys(run.byUser).length,
      hp: run.hp, maxHp: run.maxHp, killedAt: run.killedAt, killedBy: run.killedBy,
      tiers: run.tiers, tiersReached: run.tiersReached,
      board: run.board.slice(0, 10).map(x => ({ name: x.name, score: x.score })),
    } : null,
  };
}

// Reservation tallies per slot, for "3人がこの枠にいます".
export function slotCounts(db, occ) {
  const counts = {};
  for (const u of Object.values(db.users || {})) {
    const r = u && u.adminEvent;
    if (!r || r.dayKey !== occ.dayKey) continue;
    // 時刻で引き直してから数える（添字のままだと枠を編集した週に、
    // 誰もいない枠が「3人います」と出る）。消えた枠の予約はどこにも数えない。
    const slot = reservedSlot(occ, r);
    if (slot) counts[slot.id] = (counts[slot.id] || 0) + 1;
  }
  return counts;
}

export function entrantCount(counts) {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}
