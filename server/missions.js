// Daily / weekly missions.
//
// Each player gets their own deterministic pick from the pool (seeded by
// user id + date), so the set is stable all day but differs between players.
// Progress is fed by every finished game via `trackMissions()`.

// --- deterministic PRNG (mulberry32) + string hash ------------------------

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick `n` distinct entries from `pool`, deterministically for `seed`.
function pickN(pool, n, seed) {
  const rnd = rngFrom(seed);
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length));
}

// --- mission pools --------------------------------------------------------
// kind: 'sum' accumulates, 'max' keeps the best single run.
// track: which value a finished game contributes (see trackMissions).

const m = (id, track, kind, goal, coins, gems, name, nameEn) =>
  ({ id, track, kind, goal, coins, gems, name, nameEn });

export const DAILY_POOL = [
  m('d_play3',    'games',   'sum', 3,    300,  0,  '3回プレイする',              'Play 3 games'),
  m('d_play6',    'games',   'sum', 6,    550,  2,  '6回プレイする',              'Play 6 games'),
  m('d_lines40',  'lines',   'sum', 40,   350,  0,  'ラインを40本消す',            'Clear 40 lines'),
  m('d_lines100', 'lines',   'sum', 100,  650,  3,  'ラインを100本消す',           'Clear 100 lines'),
  m('d_score20k', 'score',   'max', 20000, 400, 0,  '1ゲームで20,000点',           'Score 20,000 in one game'),
  m('d_score50k', 'score',   'max', 50000, 700, 3,  '1ゲームで50,000点',           'Score 50,000 in one game'),
  m('d_combo5',   'combo',   'max', 5,    300,  0,  '5コンボを決める',             'Land a 5 combo'),
  m('d_combo8',   'combo',   'max', 8,    550,  2,  '8コンボを決める',             'Land an 8 combo'),
  m('d_win2',     'win',     'sum', 2,    450,  0,  '2回勝利する',                 'Win 2 games'),
  m('d_pvp1',     'pvpWin',  'sum', 1,    500,  2,  'オンラインで1勝する',          'Win 1 online battle'),
  m('d_ai2',      'aiWin',   'sum', 2,    450,  0,  'AIに2回勝つ',                 'Beat the AI twice'),
  m('d_boss1',    'bossWin', 'sum', 1,    500,  2,  'ボスを1体討伐する',            'Defeat 1 boss'),
  m('d_ult3',     'ults',    'sum', 3,    400,  0,  'アルティメットを3回発動',       'Use 3 ultimate skills'),
  m('d_ult6',     'ults',    'sum', 6,    650,  3,  'アルティメットを6回発動',       'Use 6 ultimate skills'),
  m('d_item2',    'items',   'sum', 2,    300,  0,  'アイテムを2個使う',            'Use 2 booster items'),
  m('d_floor5',   'floors',  'sum', 5,    450,  0,  'ダンジョンを5階クリア',         'Clear 5 dungeon floors'),
  m('d_pieces120','pieces',  'sum', 120,  350,  0,  'ブロックを120個置く',          'Place 120 blocks'),
  m('d_survive8', 'wave',    'max', 8,    500,  2,  'サバイバルでウェーブ8到達',      'Reach wave 8 in Survival'),
  m('d_sprint2',  'sprint',  'sum', 2,    400,  0,  'タイムアタックを2回遊ぶ',        'Play 2 Time Attack runs'),
  m('d_sprint10k','sprintScore', 'max', 10000, 550, 2, 'タイムアタックで10,000点',    'Score 10,000 in Time Attack'),
  m('d_coop1',    'coop',    'sum', 1,    500,  2,  '協力プレイを1回遊ぶ',            'Play 1 co-op run'),
  m('d_puzzle1',  'puzzle',  'sum', 1,    450,  0,  'パズル遺跡を1ステージクリア',     'Clear 1 Puzzle Ruins stage'),
  m('d_dig12',    'digDepth','max', 12,   500,  2,  '採掘場で深度12に到達',           'Reach depth 12 in the Mines'),
];

export const WEEKLY_POOL = [
  m('w_play25',    'games',   'sum', 25,     2000, 10, '25回プレイする',            'Play 25 games'),
  m('w_play50',    'games',   'sum', 50,     3500, 20, '50回プレイする',            'Play 50 games'),
  m('w_lines600',  'lines',   'sum', 600,    2400, 12, 'ラインを600本消す',          'Clear 600 lines'),
  m('w_score150k', 'score',   'max', 150000, 3000, 15, '1ゲームで150,000点',        'Score 150,000 in one game'),
  m('w_combo12',   'combo',   'max', 12,     2600, 14, '12コンボを決める',           'Land a 12 combo'),
  m('w_pvp5',      'pvpWin',  'sum', 5,      3000, 15, 'オンラインで5勝する',         'Win 5 online battles'),
  m('w_boss4',     'bossWin', 'sum', 4,      2800, 14, 'ボスを4体討伐する',          'Defeat 4 bosses'),
  m('w_ult25',     'ults',    'sum', 25,     2400, 12, 'アルティメットを25回発動',    'Use 25 ultimate skills'),
  m('w_floor30',   'floors',  'sum', 30,     2600, 14, 'ダンジョンを30階クリア',      'Clear 30 dungeon floors'),
  m('w_wave15',    'wave',    'max', 15,     2800, 14, 'サバイバルでウェーブ15到達',   'Reach wave 15 in Survival'),
  m('w_weekly1',   'weekly',  'sum', 1,      2000, 10, 'ウィークリーに挑戦する',       'Play the weekly challenge'),
  m('w_pieces1500','pieces',  'sum', 1500,   2200, 11, 'ブロックを1,500個置く',       'Place 1,500 blocks'),
  m('w_sprint10',  'sprint',  'sum', 10,     2400, 12, 'タイムアタックを10回遊ぶ',     'Play 10 Time Attack runs'),
  m('w_coop5',     'coop',    'sum', 5,      2600, 14, '協力プレイを5回遊ぶ',          'Play 5 co-op runs'),
  m('w_puzzle5',   'puzzle',  'sum', 5,      2400, 12, 'パズル遺跡を5ステージクリア',   'Clear 5 Puzzle Ruins stages'),
  m('w_dig35',     'digDepth','max', 35,     2800, 14, '採掘場で深度35に到達',          'Reach depth 35 in the Mines'),
];

export const DAILY_COUNT = 3;
export const WEEKLY_COUNT = 4;
// Bonus for finishing every mission in a set.
export const DAILY_ALL_BONUS = { coins: 800, gems: 5 };
export const WEEKLY_ALL_BONUS = { coins: 5000, gems: 40 };

// --- period helpers -------------------------------------------------------

// デイリーの区切りは日本時間の0時。UTC のままだと朝9時に切り替わり、
// ログインボーナス（JST 0時）と半日ずれる ── 夜に遊ぶ人は毎日
// ミッションを1セット取り逃していた。
// jstDayKey と同じ計算をここで持つ（missions.js は依存を持たない方針なので）。
export function todayId(ts = Date.now()) {
  const d = new Date(ts + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 次のJST0時までの残り（画面のカウントダウン用）
export function msUntilDailyReset(ts = Date.now()) {
  const jst = ts + 9 * 3600 * 1000;
  const dayMs = 24 * 3600 * 1000;
  return dayMs - (jst % dayMs);
}

// ISO week number, matching the weekly-challenge rollover (Monday 00:00 UTC).
export function weekIdFor(weekNum) { return `W${weekNum}`; }

// --- state ----------------------------------------------------------------

function buildSet(pool, count, seedStr) {
  return pickN(pool, count, hashStr(seedStr)).map(def => ({ id: def.id, p: 0, claimed: false }));
}

// Ensure user.missions matches the current day/week, regenerating on rollover.
export function syncMissions(user, weekNum) {
  if (!user.missions) user.missions = {};
  const ms = user.missions;
  const day = todayId();
  const week = weekIdFor(weekNum);
  if (ms.day !== day) {
    ms.day = day;
    ms.daily = buildSet(DAILY_POOL, DAILY_COUNT, `${user.id}:${day}`);
    ms.dailyBonusClaimed = false;
    ms.rerolls = {};   // 引き直しの使用回数も日付で戻る
  }
  if (ms.week !== week) {
    ms.week = week;
    ms.weekly = buildSet(WEEKLY_POOL, WEEKLY_COUNT, `${user.id}:${week}`);
    ms.weeklyBonusClaimed = false;
  }
  return ms;
}

function defOf(id) {
  return DAILY_POOL.find(d => d.id === id) || WEEKLY_POOL.find(d => d.id === id) || null;
}

// Contribution of one finished game, per track key.
function contributions({ mode, score, lines, maxCombo, won, floors, wave, ults, items, pieces, stage, depth }) {
  const isPvp = mode === 'pvp' || mode === 'tournament' || mode === 'royale' || mode === 'team';
  return {
    games: 1,
    score,
    lines,
    combo: maxCombo,
    win: won ? 1 : 0,
    pvpWin: isPvp && won ? 1 : 0,
    aiWin: mode.startsWith('ai') && won ? 1 : 0,
    bossWin: (mode === 'boss' || mode === 'boss_rush' || mode === 'raid') && won ? 1 : 0,
    floors,
    wave,
    ults,
    items,
    pieces,
    weekly: mode === 'weekly' ? 1 : 0,
    sprint: mode === 'sprint' ? 1 : 0,
    sprintScore: mode === 'sprint' ? score : 0,
    coop: mode === 'coop' ? 1 : 0,
    puzzle: mode === 'puzzle' && won ? 1 : 0,
    digDepth: mode === 'dig' ? (depth || 0) : 0,
  };
}

// Apply a finished game to every active mission. Returns ids newly completed.
export function trackMissions(user, weekNum, event) {
  const ms = syncMissions(user, weekNum);
  const contrib = contributions(event);
  const completed = [];
  for (const set of [ms.daily, ms.weekly]) {
    for (const row of set) {
      const def = defOf(row.id);
      if (!def) continue;
      const was = row.p >= def.goal;
      const add = contrib[def.track] || 0;
      if (!add) continue;
      row.p = def.kind === 'max' ? Math.max(row.p, add) : Math.min(def.goal, row.p + add);
      if (!was && row.p >= def.goal) completed.push(row.id);
    }
  }
  return completed;
}

// --- reroll (お題の引き直し) ----------------------------------------------

// 1日に引き直せる回数と、その n 回目の値段（🪙コイン）。先頭が 0 なので
// 「1日1回は無料」。デイリーとウィークリーは別枠で数える。
// 実際の引き落としは呼び出し側（server/index.js）が行う。
export const REROLL_COSTS = {
  daily: [0, 400, 800],
  weekly: [0, 1500, 3000],
};

function rerollScopes() { return ['daily', 'weekly']; }

// ms.rerolls = { '<dayKey>': { daily: n, weekly: n } }
// 当日ぶんだけ残す（古い日付が溜まっても誰も読まず db.json が太るだけ）。
function rerollCounts(ms) {
  const day = ms.day;
  if (!ms.rerolls || typeof ms.rerolls !== 'object') ms.rerolls = {};
  for (const k of Object.keys(ms.rerolls)) if (k !== day) delete ms.rerolls[k];
  let c = ms.rerolls[day];
  if (!c || typeof c !== 'object') c = ms.rerolls[day] = { daily: 0, weekly: 0 };
  for (const s of rerollScopes()) {
    const n = Number(c[s]);
    c[s] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return c;
}

// 画面向けの残り回数と次の値段。
function rerollInfoFrom(ms) {
  const c = rerollCounts(ms);
  const out = {};
  for (const s of rerollScopes()) {
    const costs = REROLL_COSTS[s];
    const used = Math.min(c[s], costs.length);
    out[s] = {
      used, max: costs.length, left: costs.length - used,
      cost: used < costs.length ? costs[used] : null,
      free: used < costs.length && costs[used] === 0,
    };
  }
  return out;
}

export function rerollInfo(user, weekNum) {
  return rerollInfoFrom(syncMissions(user, weekNum));
}

// お題を1件引き直す。コインは引き落とさず「いくら要るか」を返すだけ
// （引き落としは index.js 側）。成功: { ok:true, cost, scope, from, to, missions }
export function rerollMission(user, weekNum, id) {
  const ms = syncMissions(user, weekNum);
  const scope = ms.daily.some(r => r.id === id) ? 'daily'
    : ms.weekly.some(r => r.id === id) ? 'weekly' : null;
  if (!scope) return { error: 'ミッションが見つかりません' };
  const set = scope === 'daily' ? ms.daily : ms.weekly;
  const idx = set.findIndex(r => r.id === id);
  const row = set[idx];
  if (row.claimed) return { error: '受け取り済みのミッションは引き直せません' };

  const counts = rerollCounts(ms);
  const costs = REROLL_COSTS[scope];
  const used = counts[scope];
  if (used >= costs.length) return { error: 'きょうの引き直しは使い切りました' };
  const cost = costs[used];
  // 引き落とすのは index.js だが、払えないのに差し替えると巻き戻せない。
  // ここでも残高を見て、足りなければ盤面に触らず断る。
  if (cost > 0 && (Number(user.coins) || 0) < cost) {
    return { error: `コインが足りません（${cost.toLocaleString('en-US')}必要）` };
  }

  // 「いま出ていないお題」から抽選する。defOf が引けない孤児行（プールから
  // 消えた id）もここでは普通に引き直せる ── むしろ掃除できて都合がよい。
  const pool = scope === 'daily' ? DAILY_POOL : WEEKLY_POOL;
  const taken = new Set(set.map(r => r.id));
  const cands = pool.filter(d => !taken.has(d.id));
  if (!cands.length) return { error: '引き直せるお題がもうありません' };

  // 同じ日に何度引いても同じ物が出ないよう、使用回数と対象行もシードに混ぜる。
  const next = pickN(cands, 1, hashStr(`${user.id}:${ms.day}:reroll:${scope}:${used}:${id}`))[0];
  set[idx] = { id: next.id, p: 0, claimed: false };
  counts[scope] = used + 1;

  return {
    ok: true, cost, scope, from: id, to: next.id,
    missions: missionsView(user, weekNum),
  };
}

// Serialisable view for the client.
export function missionsView(user, weekNum) {
  const ms = syncMissions(user, weekNum);
  const row = r => {
    const def = defOf(r.id);
    if (!def) return null;
    return {
      id: def.id, name: def.name, nameEn: def.nameEn,
      goal: def.goal, progress: Math.min(r.p, def.goal),
      coins: def.coins, gems: def.gems,
      done: r.p >= def.goal, claimed: !!r.claimed,
    };
  };
  const daily = ms.daily.map(row).filter(Boolean);
  const weekly = ms.weekly.map(row).filter(Boolean);
  return {
    day: ms.day, week: ms.week,
    daily, weekly,
    dailyAllDone: daily.every(r => r.claimed),
    weeklyAllDone: weekly.every(r => r.claimed),
    dailyBonusClaimed: !!ms.dailyBonusClaimed,
    weeklyBonusClaimed: !!ms.weeklyBonusClaimed,
    dailyBonus: DAILY_ALL_BONUS,
    weeklyBonus: WEEKLY_ALL_BONUS,
    // 引き直しの残り回数と次の値段（デイリー/ウィークリー別）。
    rerolls: rerollInfoFrom(ms),
    // Milliseconds until each set regenerates.
    dailyResetIn: msUntilDailyReset(),
  };
}

// Claim one mission. Returns { coins, gems } or an error string.
export function claimMission(user, weekNum, id) {
  const ms = syncMissions(user, weekNum);
  const set = ms.daily.find(r => r.id === id) ? ms.daily : ms.weekly;
  const row = set.find(r => r.id === id);
  const def = defOf(id);
  if (!row || !def) return { error: 'ミッションが見つかりません' };
  if (row.p < def.goal) return { error: 'まだ達成していません' };
  if (row.claimed) return { error: 'すでに受け取り済みです' };
  row.claimed = true;
  user.coins += def.coins;
  user.gems += def.gems;
  user.stats.missionsDone = (user.stats.missionsDone || 0) + 1;
  return { coins: def.coins, gems: def.gems };
}

// Claim the "all missions complete" bonus for a set.
export function claimMissionBonus(user, weekNum, scope) {
  const ms = syncMissions(user, weekNum);
  const daily = scope === 'daily';
  const set = daily ? ms.daily : ms.weekly;
  const bonus = daily ? DAILY_ALL_BONUS : WEEKLY_ALL_BONUS;
  const flag = daily ? 'dailyBonusClaimed' : 'weeklyBonusClaimed';
  if (ms[flag]) return { error: 'すでに受け取り済みです' };
  // プール変更でプールから消えた id（defOf が null）は view から除かれ、
  // 受け取りもできない孤児行。全達成判定も view と同じ母集合に揃えないと、
  // 見えない未受取行がコンプリートボーナスを永久に塞ぐ。
  if (!set.filter(r => defOf(r.id)).every(r => r.claimed)) return { error: 'まだ全て達成していません' };
  ms[flag] = true;
  user.coins += bonus.coins;
  user.gems += bonus.gems;
  return { ...bonus };
}
