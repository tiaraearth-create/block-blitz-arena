// Limited-time events.
//
// An event is a single object on db.meta.event with a `type` drawn from
// EVENT_TYPES. Each type carries a `bonus` block; the server applies the
// economy parts (coins / XP / gems / gacha) and ships the whole block to the
// client, which applies the gameplay parts (chaos access, gauge rate, boss HP).

// 時刻まわりは 👑管理者イベント と同じ道具を使う（JSTは固定オフセット。
// tzデータベースに頼らないので Node のバージョン差で揺れない）。
// adminevent.js は何も import していないので循環参照にはならない。
import { jstParts, jstDayKey, JST_OFFSET_MS, WEEKDAYS_JA, WEEKDAYS_EN } from './adminevent.js';

export const EVENT_TYPES = [
  {
    id: 'chaos', icon: '🌪️', name: 'カオスタイム', nameEn: 'Chaos Time',
    desc: 'カオスモードが全員に開放！コイン1.5倍',
    descEn: 'Chaos Mode opens up for everyone — 1.5× coins',
    bonus: { chaos: true },
  },
  {
    id: 'coinfes', icon: '🪙', name: 'コイン祭り', nameEn: 'Coin Festival',
    desc: 'すべてのモードで獲得コイン2倍！',
    descEn: 'Double coins in every mode!',
    bonus: { coin: 2 },
  },
  {
    id: 'xpboost', icon: '⭐', name: '経験値ブースト', nameEn: 'XP Boost',
    desc: 'パスXP・アカウントXPが2倍',
    descEn: 'Double battle-pass and account XP',
    bonus: { xp: 2 },
  },
  {
    id: 'gemrush', icon: '💎', name: 'ジェムラッシュ', nameEn: 'Gem Rush',
    desc: '1プレイごとにジェムが3個ドロップ',
    descEn: 'Every game drops 3 gems',
    bonus: { gemDrop: 3 },
  },
  {
    id: 'bossraid', icon: '🐲', name: 'ボス襲来', nameEn: 'Boss Invasion',
    // 「報酬2倍」だと初回討伐ジェム(gemsFirst)も2倍になると読めるが、2倍に
    // なるのはコインだけ。ジェムは課金通貨なので意図的に倍にしていない
    // （インフレさせない）。約束のほうを実態に合わせる。
    // HP-20% はソロのボス（index.js の /api/bosses）とレイド（battle.js の
    // createMatch）の両方に効く。
    desc: 'ボス戦のコイン報酬2倍＋ボスHP-20%',
    descEn: 'Double boss coin rewards and bosses have 20% less HP',
    bonus: { bossCoin: 2, bossHp: 0.8 },
  },
  {
    id: 'ultfes', icon: '⚡', name: '奥義祭', nameEn: 'Ultimate Festival',
    desc: 'アルティメットゲージが2倍速で溜まる',
    descEn: 'The ultimate gauge charges twice as fast',
    bonus: { ultRate: 2 },
  },
  {
    id: 'lucky', icon: '🍀', name: 'ラッキーデー', nameEn: 'Lucky Day',
    desc: 'ガチャが20%オフ＋レア確率アップ',
    descEn: '20% off gacha pulls and better rare odds',
    bonus: { gachaDiscount: 0.8, gachaLuck: true },
  },
  {
    id: 'doubletrouble', icon: '🔥', name: '倍々デー', nameEn: 'Double Trouble',
    desc: 'コインもXPも2倍！最大級のお祭り',
    descEn: 'Double coins AND double XP — the big one',
    bonus: { coin: 2, xp: 2 },
  },
];

export function eventType(id) {
  return EVENT_TYPES.find(e => e.id === id) || null;
}

// The bonus block of the live event, or an empty object.
export function eventBonus(ev) {
  return (ev && ev.bonus) || {};
}

// Build a stored event record from admin input.
export function makeEvent(typeId, name, minutes, username) {
  const type = eventType(typeId) || EVENT_TYPES[0];
  return {
    id: type.id,          // legacy field name kept for older clients
    type: type.id,
    icon: type.icon,
    name: name || type.name,
    // 管理者が独自名を付けたときはそれを両言語で使う（誤訳よりマシ）。
    nameEn: name && name !== type.name ? name : type.nameEn,
    desc: type.desc,
    descEn: type.descEn,
    bonus: type.bonus,
    startedAt: Date.now(),
    endsAt: Date.now() + minutes * 60 * 1000,
    startedBy: username || null,
  };
}

// ---------------------------------------------------------------------------
// 📅 イベント自動運行カレンダー
//
// 管理者が手で点火しないかぎり世界が無風になる、という問題への答え。曜日ごとに
// 「その日はこれをやる」を決めておき、サーバーの定期処理が勝手に点火する。
//
// 【優先順位】自動開催は db.meta.event が空のときだけ点火する。
//   手動開催（/api/admin/event）・投票で決まった開催（polls.js の applyWinner）・
//   👑管理者イベント は常に自動開催より優先される。走っているイベントを自動開催が
//   上書きしたり、途中で差し替えたりすることは絶対にない。管理者が止めた（=空に
//   した）その日は、窓が残っていれば次のtickで同じ枠がまた点く点にだけ注意。
//   完全に止めたいときは db.meta.autoEvents を false にする。
//
// ここは全て純粋関数。db は一切見ず、必要なフラグは引数で受け取る（db を触るのは
// index.js 担当）。ゆえにテストも「時刻を渡すだけ」でできる。
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

// 開催枠はプライムタイム固定 — 18:00 JST から 24:00 JST まで。
// （👑管理者イベントの枠 18:00/19:00/21:00 と同じ「みんながいる時間」。
//  一日中2倍にすると経済が壊れるので、あえてお祭りの時間帯だけに絞る。）
export const AUTO_EVENT_START_HOUR = 18;
export const AUTO_EVENT_MINUTES = 6 * 60;

// 残りがこれ未満なら点火しない。23:57 に「6時間のお祭り開催！」と告知して
// 3分で終わる、という間抜けを防ぐため。
const AUTO_EVENT_MIN_MINUTES = 20;

// 曜日(JST) -> 開催するイベント。0=日 … 6=土。null の曜日は自動開催なし。
// **必ず EVENT_TYPES の id だけ**を書くこと（存在しない id は無視される）。
export const CALENDAR = [
  'doubletrouble', // 日 🔥 倍々デー — 週末の〆
  null,            // 月
  null,            // 火
  'ultfes',        // 水 ⚡ 奥義祭 — 週の真ん中に一発
  null,            // 木
  'gemrush',       // 金 💎 ジェムラッシュ
  'coinfes',       // 土 🪙 コイン祭り
];

// その曜日の枠 [開始, 終了) を JST 18:00 起点で組み立てる。
// dayOffset は「今日から何日後か」。
function windowFor(now, dayOffset) {
  const p = jstParts(now);
  const jstMidnight = Date.UTC(p.y, p.mo, p.d, 0, 0, 0, 0) - JST_OFFSET_MS;
  const startsAt = jstMidnight + dayOffset * DAY_MS + AUTO_EVENT_START_HOUR * 60 * 60 * 1000;
  return { startsAt, endsAt: startsAt + AUTO_EVENT_MINUTES * 60 * 1000 };
}

// 曜日の型 -> 予告や管理画面が使える表示用の塊。type が未知なら null。
function calendarEntry(weekday, win) {
  const type = eventType(CALENDAR[weekday]);
  if (!type) return null;
  return {
    type: type.id,
    icon: type.icon,
    name: type.name,
    nameEn: type.nameEn,
    desc: type.desc,
    descEn: type.descEn,
    bonus: type.bonus,
    weekday,
    weekdayJa: WEEKDAYS_JA[weekday],
    weekdayEn: WEEKDAYS_EN[weekday],
    startsAt: win.startsAt,
    endsAt: win.endsAt,
    dayKey: jstDayKey(win.startsAt),
    auto: true,
  };
}

// いま自動開催すべきイベント（枠の中にいるか）。無ければ null。
// **呼び出し側は db.meta.event が空のときだけこれを使うこと** — 手動・投票・
// 👑管理者イベントが走っているあいだは自動開催は一切割り込まない。
// enabled は db.meta.autoEvents（未設定なら有効）を index.js が渡す。
// 返り値の minutes は「枠の終わりまでの残り分数」なので、
// makeEvent(x.type, '', x.minutes, null) がそのまま枠にぴったり収まる。
export function scheduledEventFor(now = Date.now(), enabled = true) {
  if (!enabled) return null;
  // 昨日の枠は 24:00 JST で閉じるので、見るのは今日の枠だけでよい。
  const win = windowFor(now, 0);
  if (now < win.startsAt || now >= win.endsAt) return null;
  const entry = calendarEntry(jstParts(now).wd, win);
  if (!entry) return null;
  const minutes = Math.floor((win.endsAt - now) / 60000);
  if (minutes < AUTO_EVENT_MIN_MINUTES) return null;
  return { ...entry, minutes };
}

// scheduledEventFor の返り値から、db.meta.event に入れる記録を作る。
// 形は makeEvent と完全に同じ（既存のクライアント・battle.js・/api/status は
// 何も変えずに読める）。違いは startedBy が null で auto:true が付くことだけ。
export function makeScheduledEvent(sched) {
  if (!sched) return null;
  const ev = makeEvent(sched.type, '', sched.minutes, null);
  ev.auto = true;               // 予告バナー／管理画面が「自動開催」と出せるように
  ev.endsAt = sched.endsAt;     // 枠の終わり（24:00 JST）にぴったり揃える
  return ev;
}

// 次に来る自動開催（「明日は◯◯開催」の予告用）。今まさに開催中の枠は返さず、
// これから始まる枠だけを返す。カレンダーが全部 null なら null。
// enabled=false のときも null（予告する意味がないので）。
export function nextScheduledEvent(now = Date.now(), enabled = true) {
  if (!enabled) return null;
  for (let i = 0; i <= 7; i++) {
    const win = windowFor(now, i);
    if (win.startsAt <= now) continue;          // 今日の枠はもう始まっている
    const weekday = (jstParts(now).wd + i) % 7;
    const entry = calendarEntry(weekday, win);
    if (!entry) continue;
    return {
      ...entry,
      minutes: AUTO_EVENT_MINUTES,
      // 予告バナーが「今日の18時から」「明日は」を出し分けるための材料。
      inDays: i,
      startsInMs: win.startsAt - now,
    };
  }
  return null;
}

// 管理画面（週の一覧）用。曜日順の7件、開催なしの曜日は null。
export function calendarView() {
  return CALENDAR.map((id, wd) => {
    const type = eventType(id);
    return type ? {
      weekday: wd, weekdayJa: WEEKDAYS_JA[wd], weekdayEn: WEEKDAYS_EN[wd],
      type: type.id, icon: type.icon, name: type.name, nameEn: type.nameEn,
      desc: type.desc, descEn: type.descEn,
      startHour: AUTO_EVENT_START_HOUR, minutes: AUTO_EVENT_MINUTES,
    } : { weekday: wd, weekdayJa: WEEKDAYS_JA[wd], weekdayEn: WEEKDAYS_EN[wd], type: null };
  });
}

// db.meta.autoEvents の読み方をここに一本化する。**未設定は無効**。
// 自動運行は既存の世界の挙動を変えるので、運営が管理者パネルで明示的に
// ONにするまで点火しない（index.js の autoEventsOn() と同じ判定 ──
// 既定を変えるならここと index.js の両方を必ず揃えること）。
// db そのものは引数で受け取るだけで、書き換えない。
export function autoEventsEnabled(db) {
  return !!(db && db.meta && db.meta.autoEvents === true);
}
