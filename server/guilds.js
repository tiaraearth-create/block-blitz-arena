// Guilds (ギルド): small player clubs with a tag, a weekly points race and a
// coin bonus that grows with the guild's level.
//
// Points come from every finished game of every member (see applyGameResult),
// bucketed per ISO week so the leaderboard resets on Mondays while the
// lifetime total keeps raising the guild's level. Ghost guilds made of crowd
// residents pad the ranking and give the residents tags in chat.

import crypto from 'crypto';
import { getRoster, residentStats, effectiveScale, getCustom } from './ambient.js';
import { unit, strHash, mulberry32 } from './residents.js';
import { anonId } from './sanitize.js';

export const GUILD_CREATE_COST = 2000;
export const GUILD_MAX_MEMBERS = 20;
export const GUILD_ICONS = ['🏰', '⚔️', '🐉', '🌙', '🔥', '❄️', '🌸', '⚡', '🦊', '🐺', '🌊', '👑', '🍀', '💎', '🎯', '🛡️', '🦄', '🌈', '🎮', '🧱'];
const MAX_PTS_PER_GAME = 400;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(db) {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!Object.values(db.guilds).some(g => g.code === c)) return c;
  }
}

export function guildLevel(lifetime) {
  return Math.max(1, Math.min(50, 1 + Math.floor(Math.sqrt(Math.max(0, lifetime) / 800))));
}
// Coin bonus for members: +1% per level, capped at +20%.
export function guildCoinBonus(level) { return Math.min(0.2, level * 0.01); }

export function validateGuildInput(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ');
    if (!/^[\w\-ぁ-んァ-ヶ一-龠ー ]{2,16}$/u.test(name)) return { error: 'ギルド名は2〜16文字（英数字・日本語）で入力してください' };
    out.name = name;
  }
  if (!partial || input.tag !== undefined) {
    const tag = String(input.tag || '').trim().toUpperCase();
    if (!/^[A-Z0-9ァ-ヶ一-龠]{1,4}$/u.test(tag)) return { error: 'タグは1〜4文字（英数字・カタカナ・漢字）で入力してください' };
    out.tag = tag;
  }
  if (input.icon !== undefined) out.icon = GUILD_ICONS.includes(input.icon) ? input.icon : GUILD_ICONS[0];
  if (input.desc !== undefined) out.desc = String(input.desc || '').trim().replace(/[<>]/g, '').slice(0, 60);
  if (input.open !== undefined) out.open = !!input.open;
  return out;
}

export function createGuild(db, owner, input) {
  const v = validateGuildInput(input);
  if (v.error) return v;
  if (owner.guildId && db.guilds[owner.guildId]) return { error: 'すでにギルドに所属しています' };
  const lower = v.name.toLowerCase();
  if (Object.values(db.guilds).some(g => g.name.toLowerCase() === lower)) return { error: 'そのギルド名は使われています' };
  if (Object.values(db.guilds).some(g => g.tag === v.tag)) return { error: 'そのタグは使われています' };
  const guild = {
    id: crypto.randomUUID(),
    name: v.name, tag: v.tag, icon: v.icon || GUILD_ICONS[0], desc: v.desc || '',
    open: v.open !== false,
    ownerId: owner.id,
    members: [owner.id],
    createdAt: Date.now(),
    code: makeCode(db),
    weekly: {},        // weekId -> { total, byMember: { userId: pts } }
    lifetime: 0,
  };
  db.guilds[guild.id] = guild;
  owner.guildId = guild.id;
  owner.guildJoinedAt = Date.now();
  markGuildEver(owner);
  return { guild };
}

// 🏅 実績「ギルド加入」は**一度でも入ったか**で決まる。
//    在籍中かどうか（user.guildId）で判定していたので、脱退や除名で
//    未受取の 500🪙+4💎 が取り消され、進捗バーが逆走していた。
//    ここで「一度入った」を刻む（stats に置くのは backup の統合が
//    stats を最高値でまとめてくれるため）。
function markGuildEver(user) {
  user.stats = user.stats || {};
  if (!user.stats.guildJoinedEver) user.stats.guildJoinedEver = Date.now();
}

export function findGuild(db, { id, code, name } = {}) {
  if (id && Object.prototype.hasOwnProperty.call(db.guilds, id)) return db.guilds[id];
  if (code) {
    const c = String(code).trim().toUpperCase();
    return Object.values(db.guilds).find(g => g.code === c) || null;
  }
  if (name) {
    const n = String(name).trim().toLowerCase();
    return Object.values(db.guilds).find(g => g.name.toLowerCase() === n) || null;
  }
  return null;
}

export function joinGuild(db, user, guild, { viaCode = false } = {}) {
  if (user.guildId && db.guilds[user.guildId]) return { error: 'すでにギルドに所属しています。先に脱退してください' };
  if (!guild.open && !viaCode) return { error: 'このギルドは招待制です（ルームコードが必要）' };
  if (guild.members.length >= GUILD_MAX_MEMBERS) return { error: `ギルドは満員です（最大${GUILD_MAX_MEMBERS}人）` };
  if (user.guildLeftAt && Date.now() - user.guildLeftAt < 60 * 60 * 1000) {
    return { error: '脱退から1時間はギルドに参加できません' };
  }
  // 除名されたときは「元のギルドへの出戻り」だけ1時間断る（上のコメント参照）。
  if (user.guildKickedAt && user.guildKickedFrom === guild.id
      && Date.now() - user.guildKickedAt < 60 * 60 * 1000) {
    return { error: '除名されたギルドには1時間参加できません' };
  }
  guild.members.push(user.id);
  user.guildId = guild.id;
  user.guildJoinedAt = Date.now();
  markGuildEver(user);
  return { guild };
}

export function leaveGuild(db, user) {
  const guild = user.guildId ? db.guilds[user.guildId] : null;
  user.guildId = null;
  user.guildLeftAt = Date.now();
  if (!guild) return { ok: true };
  guild.members = guild.members.filter(id => id !== user.id);
  if (!guild.members.length) {
    delete db.guilds[guild.id];
    return { ok: true, disbanded: true };
  }
  if (guild.ownerId === user.id) {
    // Ownership passes to the longest-standing member.
    guild.ownerId = guild.members
      .map(id => db.users[id]).filter(Boolean)
      .sort((a, b) => (a.guildJoinedAt || 0) - (b.guildJoinedAt || 0))[0]?.id || guild.members[0];
  }
  return { ok: true, guild };
}

export function kickMember(db, guild, actor, targetId) {
  if (guild.ownerId !== actor.id && actor.role !== 'admin') return { error: 'ギルドリーダーのみ操作できます' };
  if (targetId === guild.ownerId) return { error: 'リーダーは除名できません' };
  if (!guild.members.includes(targetId)) return { error: 'そのメンバーはいません' };
  guild.members = guild.members.filter(id => id !== targetId);
  const t = db.users[targetId];
  // 🚪 除名では guildLeftAt を刻まない。
  //    自分では抜けていないのに1時間どのギルドにも入れず（コインボーナスも
  //    週間ptの加算も無し）、しかも理由が「脱退から1時間はギルドに参加
  //    できません」と嘘になる。除名の確認ダイアログにもその副作用は
  //    書かれていない。即出戻りを防ぐのは元のギルドにだけで足りるので、
  //    別の欄に刻んで joinGuild 側でそこだけ断る。
  if (t) {
    t.guildId = null;
    t.guildKickedAt = Date.now();
    t.guildKickedFrom = guild.id;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 💬 ギルドチャット
//
// 20人が集まる場所なのに、**喋る手立てが1つも無かった**。名前とptだけが並ぶ
// 名簿で、いっしょに何かをした実感が生まれない ── 実プレイヤーどうしを繋ぐ
// 経路が、このゲームにいちばん足りていない。
//
// パーティーのチャット（server/party.js の chat）と同じ作りにする。違うのは
// 保存先だけ: パーティーはメモリの上（畳めば消える）だが、ギルドは何ヶ月も
// 続くので guild.chat に置いてディスクへ残す。
//
// 上限は50件。ここを緩めると db.json がギルドの数だけ太る（復元の天井にも
// 効いてくる）。読み返す場所ではなく「いま居る人と喋る場所」なので50で足りる。
export const GUILD_CHAT_RING = 50;
export const GUILD_CHAT_MAX = 200;

export function guildChat(db, user, text, deps = {}) {
  const { uuid, now = () => Date.now(), rateLimit, translateLocal } = deps;
  const guild = user && user.guildId ? db.guilds[user.guildId] : null;
  if (!guild) return { error: 'ギルドに所属していません' };
  // ミュートはここでも見る（全体チャット・パーティーと同じ扱い）。
  if (user.muted) return { error: '管理者によりチャットが制限されています' };
  if (rateLimit && !rateLimit(`gchat:${user.id}`, 20, 10_000)) return { error: 'すこし早すぎます' };
  const body = String(text || '').trim().slice(0, GUILD_CHAT_MAX);
  if (!body) return { error: '' };
  guild.chat = Array.isArray(guild.chat) ? guild.chat : [];
  const entry = {
    id: uuid ? uuid() : `${now()}-${guild.chat.length}`,
    from: user.username, fromId: user.id, text: body, at: now(),
  };
  guild.chat.push(entry);
  if (guild.chat.length > GUILD_CHAT_RING) guild.chat.splice(0, guild.chat.length - GUILD_CHAT_RING);
  // 翻訳は後追い。待ってから配ると発言の順番が入れ替わる（全体チャットで実際に起きた）。
  let tr = null;
  if (translateLocal) {
    const r = translateLocal(body);
    const txt = typeof r === 'string' ? r : (r && typeof r.text === 'string' ? r.text : null);
    if (txt && txt !== body) tr = txt;
  }
  return { ok: true, guild, entry, tr };
}

export function guildChatHistory(db, user) {
  const guild = user && user.guildId ? db.guilds[user.guildId] : null;
  if (!guild) return [];
  return (Array.isArray(guild.chat) ? guild.chat : []).slice(-GUILD_CHAT_RING);
}

export function addGuildPoints(db, user, pts, weekId) {
  const guild = user.guildId ? db.guilds[user.guildId] : null;
  if (!guild) return 0;
  pts = Math.max(0, Math.min(MAX_PTS_PER_GAME, Math.floor(pts)));
  if (!pts) return 0;
  const w = guild.weekly[weekId] || (guild.weekly[weekId] = { total: 0, byMember: {} });
  w.total += pts;
  w.byMember[user.id] = (w.byMember[user.id] || 0) + pts;
  guild.lifetime = (guild.lifetime || 0) + pts;
  // keep only the last 8 weeks
  // weekId は 'W2954' のような文字列。桁数が同じ間は辞書順=数値順だが、桁が
  // 変わる境界（'W9999' → 'W10000'）では 'W10000' < 'W9999' となり、辞書順ソート
  // だと最新週が先頭に来て shift() で消えてしまう。数値部で比べて古い週から落とす。
  const wkNum = k => { const n = parseInt(String(k).replace(/^\D+/, ''), 10); return Number.isFinite(n) ? n : Infinity; };
  const keys = Object.keys(guild.weekly).sort((a, b) => wkNum(a) - wkNum(b));
  while (keys.length > 8) delete guild.weekly[keys.shift()];
  return pts;
}

export function guildView(db, guild, weekId, { detailed = false, viewerId = null, levelOf = () => 1 } = {}) {
  const w = guild.weekly[weekId] || { total: 0, byMember: {} };
  const level = guildLevel(guild.lifetime || 0);
  const base = {
    id: guild.id, name: guild.name, tag: guild.tag, icon: guild.icon, desc: guild.desc, open: guild.open,
    level, bonusPct: Math.round(guildCoinBonus(level) * 100),
    memberCount: guild.members.length, maxMembers: GUILD_MAX_MEMBERS,
    weeklyPoints: w.total, lifetime: guild.lifetime || 0,
    createdAt: guild.createdAt, ghost: false,
    ...guildQuestSummary(guild, weekId),
  };
  if (!detailed) return base;
  const isOwner = viewerId === guild.ownerId;
  const viewer = viewerId && Object.prototype.hasOwnProperty.call(db.users, viewerId) ? db.users[viewerId] : null;
  return {
    ...base,
    quests: guildQuestView(guild, weekId, viewer),
    ownerId: guild.ownerId,
    code: isOwner ? guild.code : null,
    members: guild.members.map(id => db.users[id]).filter(Boolean).map(u => ({
      id: u.id, username: u.username, level: levelOf(u.xp || 0),
      role: u.id === guild.ownerId ? 'owner' : 'member',
      weeklyPts: w.byMember[u.id] || 0,
      rating: u.stats ? u.stats.rating : 1000,
      joinedAt: u.guildJoinedAt || guild.createdAt,
    })).sort((a, b) => (b.role === 'owner') - (a.role === 'owner') || b.weeklyPts - a.weeklyPts),
  };
}

// ---------------------------------------------------------------------------
// 🗡️ Weekly guild quests + the guild vault (ギルド週間クエスト＆ギルド金庫)
//
// Three quests per guild per week, picked deterministically from the pool with
// the guild id + week id as the seed (same mulberry32 / shuffle-and-slice
// recipe as server/missions.js, so the set never moves once the week starts and
// survives a restart with an empty data dir).
//
// Progress is the SUM of every member's finished games — fed by
// trackGuildQuests() from applyGameResult, right next to addGuildPoints().
// Every completed quest opens the guild vault: each member may claim that
// quest's chest exactly once, and the payout is recomputed here from the pool
// (the client only ever names a quest id). Claiming all three grants a
// guild-only badge.
// ---------------------------------------------------------------------------

// Reward + goal live in the pool, never in the request.
const gq = (id, track, goal, coins, gems, name, nameEn) => ({ id, track, goal, coins, gems, name, nameEn });

export const QUEST_POOL = [
  gq('gq_lines3000',  'lines',   3000,  1200, 6, 'ギルド全員でラインを3,000本消す',      'Clear 3,000 lines as a guild'),
  gq('gq_boss20',     'bossWin', 20,    1400, 8, 'ギルド全員でボスを20体討伐する',        'Defeat 20 bosses as a guild'),
  gq('gq_pts15000',   'points',  15000, 1500, 8, '今週のギルドptを15,000ためる',          'Bank 15,000 guild points this week'),
  gq('gq_perfect30',  'perfect', 30,    1300, 7, 'ギルド全員で全消しを30回決める',        'Land 30 perfect clears as a guild'),
  gq('gq_games200',   'games',   200,   1000, 5, 'ギルド全員で200回プレイする',           'Play 200 games as a guild'),
  gq('gq_ults150',    'ults',    150,   1100, 6, 'ギルド全員でアルティメットを150回発動', 'Use 150 ultimate skills as a guild'),
  gq('gq_floors200',  'floors',  200,   1300, 7, 'ギルド全員でダンジョンを200階クリア',   'Clear 200 dungeon floors as a guild'),
  gq('gq_pvp40',      'pvpWin',  40,    1400, 8, 'ギルド全員でオンライン40勝する',        'Win 40 online battles as a guild'),
];

export const GUILD_QUEST_COUNT = 3;
// 3本コンプでもらえるギルド限定バッジ。
export const GUILD_QUEST_BADGE = 'guildquest';
const KEEP_QUEST_WEEKS = 8;

function questDefOf(id) {
  return QUEST_POOL.find(d => d.id === id) || null;
}

// Deterministic pick of GUILD_QUEST_COUNT quests for (guild, week).
// missions.js の pickN と同じ「シードでシャッフルして先頭から取る」流儀。
function pickQuestIds(guildId, weekId) {
  const rnd = mulberry32(strHash(`${guildId}:${weekId}:quests`));
  const arr = QUEST_POOL.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(GUILD_QUEST_COUNT, arr.length)).map(d => d.id);
}

const own = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const numAt = (o, k) => (own(o, k) && Number.isFinite(Number(o[k])) ? Number(o[k]) : 0);

// Read-only view of a guild's quest row — never writes, so plain GETs
// (ギルドランキングは50件走査する) don't dirty the db.
function readGuildQuests(guild, weekId) {
  const stored = own(guild.quests, weekId) ? guild.quests[weekId] : null;
  const ids = stored && Array.isArray(stored.ids) && stored.ids.length ? stored.ids : pickQuestIds(guild.id, weekId);
  // size は目標を縮める人数（questGoalOf）。刻まれていない古い週は今の人数で読む。
  const size = stored && Number.isFinite(stored.size)
    ? stored.size : Math.max(1, (guild.members || []).length);
  return { ids, p: (stored && stored.p) || {}, done: (stored && stored.done) || {}, size };
}

// Progress of one quest. 'points' は週間ptそのものなので guild.weekly から引く
// （加算で二重に数えない）。
// minus: 「この1ゲームで足したぶん」。'points' の“達成前”の値を出すのに使う
// （詳しくは trackGuildQuests の注記）。
// 🏰 **そのギルドの人数ぶんに縮めた目標。**
//
//    QUEST_POOL の goal は「ラインを3,000本」「200回プレイ」…と 20人で割る前提の
//    数字で、人数がどこにも掛かっていなかった。実プレイヤーが13人しかいない
//    この世界では、ギルドを建てれば必ず1人ギルドになる（住人のギルドは
//    open:false で参加できない）ので、1週間まるごと遊んでも3本とも未達成のまま
//    金庫もバッジも一度も開かなかった。隣に並ぶ住人のギルド（ghostQuestState）は
//    最初から人数で進みが変わる式なので、実ギルド側だけ重み付けが抜けていた。
//    ⚠ 人数は**週の初めに刻んで固定する**（q.size）── 週の途中で人が増減する
//      たびに目標が動くと、達成したはずの行が未達成に戻る。
export function questGoalOf(def, size) {
  const n = Math.max(1, Math.min(Number(size) || 1, GUILD_MAX_MEMBERS));
  return Math.max(1, Math.ceil(def.goal * n / GUILD_MAX_MEMBERS));
}

function questProgress(guild, weekId, q, def, minus = 0) {
  if (def.track === 'points') {
    const total = (guild.weekly[weekId] && guild.weekly[weekId].total) || 0;
    return Math.max(0, total - (minus || 0));
  }
  return numAt(q.p, def.id);
}

// Writable version: creates this week's row and prunes old weeks.
function syncGuildQuests(guild, weekId) {
  if (!guild.quests || typeof guild.quests !== 'object' || Array.isArray(guild.quests)) guild.quests = {};
  let q = own(guild.quests, weekId) ? guild.quests[weekId] : null;
  if (!q || typeof q !== 'object' || !Array.isArray(q.ids) || !q.ids.length) {
    q = guild.quests[weekId] = {
      ids: pickQuestIds(guild.id, weekId), p: {}, done: {},
      // 目標を縮める人数。作った時点で固定する（questGoalOf のコメント）。
      size: Math.max(1, (guild.members || []).length),
    };
  }
  // 古い週の行には size が無い。そのときは今の人数で読む（読み取り専用の既定）。
  if (!Number.isFinite(q.size)) q.size = Math.max(1, (guild.members || []).length);
  if (!q.p || typeof q.p !== 'object') q.p = {};
  if (!q.done || typeof q.done !== 'object') q.done = {};
  // weekly と同じ理由（'W9999' → 'W10000' の桁またぎ）で数値部で比べて古い週から落とす。
  const wkNum = k => { const n = parseInt(String(k).replace(/^\D+/, ''), 10); return Number.isFinite(n) ? n : Infinity; };
  const keys = Object.keys(guild.quests).sort((a, b) => wkNum(a) - wkNum(b));
  while (keys.length > KEEP_QUEST_WEEKS) delete guild.quests[keys.shift()];
  return q;
}

// 1ゲームがクエストに足せる上限。値はすべてクライアント申告なので、
// ミッションと同じく「正直に遊べば必ず届く」水準で頭を押さえておく。
const QUEST_PER_GAME_CAP = { lines: 400, bossWin: 1, perfect: 20, games: 1, ults: 40, floors: 40, pvpWin: 1 };

function questContributions(event = {}) {
  const mode = String(event.mode || '');
  const won = !!event.won;
  const isPvp = mode === 'pvp' || mode === 'tournament' || mode === 'royale' || mode === 'team';
  const isBoss = mode === 'boss' || mode === 'boss_rush' || mode === 'raid';
  const raw = {
    lines: event.lines,
    bossWin: isBoss && won ? 1 : 0,
    perfect: event.perfectClears,
    // 'games' は空の結果を連投しても進んでしまう唯一のトラックだった。
    // index.js が実プレイ判定を event.realPlay で渡すので、偽プレイ(false)は
    // 0 に落とす。realPlay 未指定の呼び出しは従来どおり 1（後方互換）。
    games: event.realPlay === false ? 0 : 1,
    ults: event.ults,
    floors: event.floors,
    pvpWin: isPvp && won ? 1 : 0,
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Math.floor(Number(v) || 0);
    out[k] = Math.max(0, Math.min(QUEST_PER_GAME_CAP[k] || 0, n));
  }
  return out;
}

// Apply one finished game to the member's guild quests.
// Returns the quest defs that were completed BY THIS GAME (for the crowd feed).
// applyGameResult から addGuildPoints の直後に呼ぶこと（'points' クエストが
// 加算後の週間ptを読むため）。
export function trackGuildQuests(db, user, weekId, event = {}) {
  const guild = user && user.guildId ? db.guilds[user.guildId] : null;
  if (!guild) return [];
  const q = syncGuildQuests(guild, weekId);
  const contrib = questContributions(event);
  const completed = [];
  // 🗡 'points' クエストだけは「加算する側」がここではない。呼び出し側
  //    （index.js）が addGuildPoints を**先に**済ませてから来るので、
  //    guild.weekly の合計はもう今回のぶんを含んでいる。そのまま before に
  //    使うと was と after が必ず同じ値になり、`!was && after >= goal` が
  //    一度も真にならない ＝「ギルドptを15,000ためる」の達成が永久に検出
  //    されなかった（報酬の受け取りは live 判定なので通るが、達成日時も
  //    ライブフィードへの告知も出ない ── 3本中いちばん達成しやすい1本で、
  //    ギルド全体の手柄を世界に知らせる仕組みだけが死んでいた）。
  //    直前に足したぶんを引いて「達成前」を復元する。
  const justAdded = Math.max(0, Number(event.points) || 0);
  for (const id of q.ids) {
    const def = questDefOf(id);
    if (!def) continue;
    const before = questProgress(guild, weekId, q, def, def.track === 'points' ? justAdded : 0);
    const goal = questGoalOf(def, q.size);
    const was = before >= goal;
    if (def.track !== 'points') {
      const add = contrib[def.track] || 0;
      if (add) q.p[def.id] = Math.min(goal, before + add);
    }
    const after = questProgress(guild, weekId, q, def);
    if (!was && after >= goal) {
      q.done[def.id] = Date.now();
      completed.push(def);
    }
  }
  return completed;
}

// --- guild vault (ギルド金庫): one claim per member, per quest ---------------

// 受取記録はメンバー側に持つ。今週ぶんだけ持てば十分なので、週が変われば作り直す
// （勝手に肥らない）。gid は「今週はこのギルドで受け取った」印で、ギルドを渡り
// 歩いて同じ週に何度も金庫を開ける抜け道をふさぐ。
function memberQuestRec(user, weekId, guildId) {
  let rec = user.guildQuests;
  if (!rec || typeof rec !== 'object' || rec.week !== weekId || !Array.isArray(rec.claimed)) {
    rec = user.guildQuests = { week: weekId, gid: guildId, claimed: [], badge: false };
  }
  return rec;
}

function readMemberRec(user, weekId, guildId) {
  const rec = user && user.guildQuests;
  if (!rec || rec.week !== weekId || rec.gid !== guildId || !Array.isArray(rec.claimed)) return null;
  return rec;
}

// Claim one opened chest. Reward は必ずここでプールから引き直す。
export function claimGuildQuest(db, user, weekId, questId) {
  const guild = user && user.guildId ? db.guilds[user.guildId] : null;
  if (!guild) return { error: 'ギルドに所属していません' };
  const def = questDefOf(String(questId || ''));
  if (!def) return { error: 'そのクエストは見つかりません' };
  const q = syncGuildQuests(guild, weekId);
  if (!q.ids.includes(def.id)) return { error: 'そのクエストは今週のものではありません' };
  if (questProgress(guild, weekId, q, def) < questGoalOf(def, q.size)) return { error: 'ギルドがまだ達成していません' };

  const rec = memberQuestRec(user, weekId, guild.id);
  if (rec.gid !== guild.id) {
    if (rec.claimed.length || rec.badge) return { error: '今週は別のギルドで金庫を開けています' };
    rec.gid = guild.id;
  }
  if (rec.claimed.includes(def.id)) return { error: 'すでに受け取り済みです' };
  rec.claimed.push(def.id);

  user.coins = (user.coins || 0) + def.coins;
  user.gems = (user.gems || 0) + def.gems;
  if (user.stats) user.stats.guildQuestsClaimed = (user.stats.guildQuestsClaimed || 0) + 1;

  // 3本すべて達成＆すべて受け取ったらギルド限定バッジ。
  let badge = null;
  // ⚠ 目標は questGoalOf（人数ぶんに縮めたもの）で見る。素の d.goal のままだと、
  //    3本とも受け取れているのにバッジだけ永久に出ない（20人未満のギルドは
  //    素の goal に届かないため）。guildQuestView の done とそろえる。
  const allDone = q.ids.every(id => {
    const d = questDefOf(id);
    return d && questProgress(guild, weekId, q, d) >= questGoalOf(d, q.size);
  });
  if (allDone && q.ids.every(id => rec.claimed.includes(id))) {
    if (!Array.isArray(user.badges)) user.badges = [];
    if (!user.badges.includes(GUILD_QUEST_BADGE)) { user.badges.push(GUILD_QUEST_BADGE); badge = GUILD_QUEST_BADGE; }
    rec.badge = true;
  }
  return { coins: def.coins, gems: def.gems, badge, questId: def.id, name: def.name, nameEn: def.nameEn };
}

// Serialisable quest state for the client (/api/guild 系から使う).
// viewer を渡すと「自分が受け取ったか」も入る。読み取り専用。
export function guildQuestView(guild, weekId, viewer = null) {
  const q = readGuildQuests(guild, weekId);
  const rec = readMemberRec(viewer, weekId, guild.id);
  // 🏰 **今週すでに「別のギルドで」金庫を開けているか。**
  //    readMemberRec は gid が違うと null を返すので、ギルドを移った人は
  //    claimed も false・claimable も true になり、画面は押せる「受取」を描いていた。
  //    ところが claimGuildQuest は同じ記録を見て必ず 409 を返す
  //    （「今週は別のギルドで金庫を開けています」）── 押せるのに必ず失敗する
  //    ボタンになっていた。表示側にも同じ事実を渡す。
  const other = viewer && viewer.guildQuests;
  const lockedByOtherGuild = !!(other && other.week === weekId && other.gid && other.gid !== guild.id
    && ((Array.isArray(other.claimed) && other.claimed.length) || other.badge));
  const quests = q.ids.map(id => {
    const def = questDefOf(id);
    if (!def) return null;
    const p = questProgress(guild, weekId, q, def);
    return {
      id: def.id, name: def.name, nameEn: def.nameEn,
      goal: questGoalOf(def, q.size), progress: Math.min(questGoalOf(def, q.size), Math.max(0, Math.floor(p))),
      coins: def.coins, gems: def.gems,
      done: p >= questGoalOf(def, q.size),
      doneAt: numAt(q.done, def.id) || null,
      claimed: !!(rec && rec.claimed.includes(def.id)),
    };
  }).filter(Boolean);
  const doneCount = quests.filter(r => r.done).length;
  return {
    week: weekId, quests,
    total: quests.length, doneCount,
    allDone: quests.length > 0 && doneCount === quests.length,
    badge: GUILD_QUEST_BADGE,
    badgeName: 'ギルドの誉れ', badgeNameEn: 'Guild Honors',
    badgeEarned: !!(rec && rec.badge),
    claimable: !lockedByOtherGuild && quests.some(r => r.done && !r.claimed),
    // 受け取れない理由。画面はボタンの代わりにこれを出せる。
    lockedByOtherGuild,
  };
}

// Quest headline for the ranking rows (どのギルドが何本開けたか).
export function guildQuestSummary(guild, weekId) {
  const q = readGuildQuests(guild, weekId);
  let done = 0, total = 0;
  for (const id of q.ids) {
    const def = questDefOf(id);
    if (!def) continue;
    total++;
    if (questProgress(guild, weekId, q, def) >= questGoalOf(def, q.size)) done++;
  }
  return { questsDone: done, questTotal: total };
}

// ---------------------------------------------------------------------------
// Ghost guilds: crowd residents grouped into clubs, stable per roster.
// ---------------------------------------------------------------------------

const GHOST_DEFS = [
  { name: '深夜ブロッカーズ', tag: 'NIGHT', icon: '🌙', desc: '寝ない。積む。' },
  { name: 'Pixel Knights',    tag: 'PXK',   icon: '⚔️', desc: 'gg or nothing' },
  { name: 'コンボ同盟',       tag: 'COMBO', icon: '🔥', desc: '10コンボ未満は帰れ' },
  { name: 'ぷにぷに軍団',     tag: 'PUNI',  icon: '🌸', desc: 'ゆるく楽しく' },
  { name: 'Tetra Legion',     tag: 'TETRA', icon: '🧱', desc: 'line clears only' },
  { name: '天界騎士団',       tag: 'HEAVN', icon: '👑', desc: '天国ダンジョン攻略中' },
  { name: 'ガチ勢連合',       tag: 'GACHI', icon: '⚡', desc: 'レート1500以上推奨' },
  { name: 'エンジョイ部',     tag: 'ENJOY', icon: '🍀', desc: '初心者歓迎！' },
  // v2.11: 住人が600人まで増えたので、受け皿もそのぶん要る。8ギルドでは
  // 160席しかなく、残り440人が全員無所属になっていた。
  { name: '朝活ブロック部',   tag: 'MORN',  icon: '☀️', desc: '出勤前に1戦' },
  { name: 'Crystal Cascade', tag: 'CRYST', icon: '💠', desc: 'chase the perfect clear' },
  { name: '塔の踏破者たち',   tag: 'TOWER', icon: '🏰', desc: '100Fの先へ' },
  { name: 'ぬるま湯同盟',     tag: 'NURU',  icon: '♨️', desc: '勝敗は気にしない' },
  { name: 'タイムアタック党', tag: 'SPRNT', icon: '⏱️', desc: '60秒に全部賭ける' },
  { name: 'Midnight Mochi',  tag: 'MOCHI', icon: '🍡', desc: 'snacks and stacks' },
  { name: '深淵探検隊',       tag: 'ABYSS', icon: '🌑', desc: '帰ってこれた者だけ' },
  { name: 'ガチャの民',       tag: 'GACHA', icon: '🎰', desc: '爆死報告はこちら' },
  { name: 'パズル研究会',     tag: 'RUINS', icon: '🧩', desc: '★3以外は認めない' },
  { name: '採掘ギルド',       tag: 'MINE',  icon: '⛏️', desc: '虹鉱石を掘り当てろ' },
  { name: 'Royale Rumble',   tag: 'RUMBL', icon: '💯', desc: 'last one standing' },
  { name: 'コンボ研究所',     tag: 'LAB',   icon: '🧪', desc: '連鎖の理論を解明する' },
  { name: 'のんびり夜長',     tag: 'YONAG', icon: '🌌', desc: '寝る前に数戦だけ' },
  { name: 'Sunrise Squad',   tag: 'SUNRS', icon: '🌅', desc: 'early birds only' },
  { name: '不屈の挑戦者',     tag: 'GRIT',  icon: '🔥', desc: '負けても次がある' },
  { name: 'ブロック美学会',   tag: 'ARTS',  icon: '🎨', desc: '積み方に品を' },
  // v2.80: 住人が2,000人まで増えたので、受け皿もそのぶん要る。
  //
  // ⚠ 24ギルドでは 24×20＝480席しかなく、2,000人のうち**76%が無所属**に
  //   なっていた（実測 24.0%）。一方、使い捨ての席は「ギルドに入っている住人から
  //   タグを借りる」経路なので加入率が下がらず 32.5%。
  //   test/personaparity.test.mjs の A-5 が z=-4.95 で赤くした ──
  //   **ギルドに入っているかどうかが、住人と使い捨てを見分ける統計になる**。
  //   席を増やして直すのが正しい。ゴーストだけ GUILD_MAX_MEMBERS を超えると
  //   順位表に「26/20」と出て、それはそれで一発の目印になる。
  { name: '週末ブロッカーズ', tag: 'WKEND', icon: '📅', desc: '土日だけ本気' },
  { name: 'Neon Drift',      tag: 'NEOND', icon: '🌃', desc: 'city lights, clean lines' },
  { name: '一手入魂',         tag: 'ISSHU', icon: '🎯', desc: '置く前に3秒考える' },
  { name: 'まったり積み隊',   tag: 'MATTA', icon: '🫖', desc: 'お茶を淹れてから' },
  { name: 'Frost Circuit',   tag: 'FROST', icon: '❄️', desc: 'keep it cold, keep it clean' },
  { name: '無心の会',         tag: 'MUSHN', icon: '🧘', desc: '考えるな、感じろ' },
  { name: '通勤電車部',       tag: 'TRAIN', icon: '🚃', desc: '片手で3駅ぶん' },
  { name: 'Ember Union',     tag: 'EMBER', icon: '🔥', desc: 'burn slow, burn long' },
  { name: '積み木の国',       tag: 'KUNI',  icon: '🧸', desc: 'こどもの頃を思い出す' },
  { name: '深夜2時の会',      tag: 'AM2',   icon: '🌙', desc: 'あと1戦だけ、を10回' },
  { name: 'Lucky Seven',     tag: 'LUCK7', icon: '🍀', desc: 'we roll and we pray' },
  { name: '完全消去主義',     tag: 'PERFC', icon: '✨', desc: '盤面を空にして終わる' },
  { name: 'ひとやすみ島',     tag: 'ISLND', icon: '🏝️', desc: '疲れたらここへ' },
  { name: 'Aurora Line',     tag: 'AUROR', icon: '🌈', desc: 'seven colors, one line' },
  { name: '猫の手クラブ',     tag: 'NEKO',  icon: '🐈', desc: '気まぐれに強い' },
  { name: '真夜中の設計者',   tag: 'ARCHT', icon: '📐', desc: '崩さない積み方を探す' },
  { name: 'Steady Hands',    tag: 'STEDY', icon: '🤝', desc: 'no panic, no rush' },
  { name: '雷速連鎖団',       tag: 'RAIJN', icon: '⚡', desc: '考える前に指が動く' },
  { name: 'おやつ休憩所',     tag: 'OYATU', icon: '🍩', desc: '1戦ごとに一口' },
  { name: 'Deep Blue Div.',  tag: 'DEEPB', icon: '🌊', desc: 'dive until it clears' },
  { name: '不夜城ギルド',     tag: 'FUYA',  icon: '🏙️', desc: '灯りは消さない' },
  { name: '石橋を叩く会',     tag: 'BRIDG', icon: '🪨', desc: '安全な手しか置かない' },
  { name: 'Comet Tail',      tag: 'COMET', icon: '☄️', desc: 'one long streak' },
  { name: '和菓子同盟',       tag: 'WAGSH', icon: '🍵', desc: '甘いものと積み木' },
  { name: '逆転狙い隊',       tag: 'REVRS', icon: '🔄', desc: '最後の10秒が本番' },
  { name: 'Iron Stack',      tag: 'IRONS', icon: '🛡️', desc: 'defense wins games' },
  { name: '朝焼け同好会',     tag: 'DAWN',  icon: '🌄', desc: '徹夜明けの1戦' },
  { name: '積読ならぬ積木',   tag: 'TUMKI', icon: '📚', desc: '崩さず積むのが趣味' },
  { name: 'Silent Runners',  tag: 'SILNT', icon: '🤫', desc: 'no chat, just clears' },
  { name: '七色の階段',       tag: 'STAIR', icon: '🪜', desc: '色を並べて登る' },
  { name: '負けず嫌いの集い', tag: 'MAKEZ', icon: '😤', desc: '連敗しても抜けない' },
  { name: 'Paper Lantern',   tag: 'LNTRN', icon: '🏮', desc: 'warm light, cool head' },
  { name: '定石研究部',       tag: 'JOSEK', icon: '📖', desc: '最善手を持ち寄る' },
  { name: 'ゆるふわ連合',     tag: 'YURUF', icon: '☁️', desc: '順位は見ない主義' },
  { name: 'Last Second',     tag: 'LASTS', icon: '⏳', desc: 'clutch or bust' },
  { name: '鉄壁の守り',       tag: 'TEPPK', icon: '🧊', desc: 'お邪魔は全部返す' },
  { name: '花火職人',         tag: 'HANAB', icon: '🎆', desc: '派手に消すのが好き' },
  { name: 'Quiet Storm',     tag: 'QSTRM', icon: '🌀', desc: 'calm face, fast hands' },
  { name: '駆け出しの丘',     tag: 'HILL',  icon: '🌱', desc: 'はじめての人はここへ' },
  { name: '職人気質',         tag: 'SHOKU', icon: '🔨', desc: '一手一手ていねいに' },
  { name: 'Moonlit Path',    tag: 'MOONP', icon: '🌜', desc: 'walk it slow' },
  { name: '大器晩成会',       tag: 'BANSE', icon: '🌾', desc: '伸びるのはこれから' },
  { name: '連鎖美術館',       tag: 'MUSEM', icon: '🖼️', desc: '美しい連鎖を展示中' },
  { name: 'Cold Brew Crew',  tag: 'CBREW', icon: '🧋', desc: 'chill and stack' },
  { name: '一発逆転党',       tag: 'IPPTS', icon: '🎲', desc: '大技しか撃たない' },
  { name: '積み上げ日和',     tag: 'BIYOR', icon: '🌤️', desc: '天気のいい日に1戦' },
  { name: 'Prism Works',     tag: 'PRISM', icon: '🔷', desc: 'split the light' },
  { name: '深呼吸クラブ',     tag: 'BREAT', icon: '🫁', desc: '焦ったら一度手を止める' },
  { name: '灯台守',           tag: 'TODAI', icon: '🗼', desc: '静かに、確実に' },
  { name: 'Final Piece',     tag: 'FINAL', icon: '🧩', desc: 'the last one always fits' },
];

let ghostCache = null;
let ghostCacheKey = '';
export function ghostGuilds() {
  const roster = getRoster();
  const key = roster.map(r => r.id).join(',');
  if (ghostCache && ghostCacheKey === key) return ghostCache;
  // ギルド数も人口に合わせる。小さい世界に24個の過疎ギルドが並ぶのも、
  // 大きい世界で8個が満員のまま440人が無所属なのも、どちらも不自然。
  // 1ギルドおよそ14人になるように選び、4〜GHOST_DEFS.length の範囲に収める。
  const want = Math.max(4, Math.min(GHOST_DEFS.length, Math.round(roster.length * 0.7 / 14)));
  // 🎭 公開する id は `ghost0` のような連番にしない ── 形を見ただけで
  // 「生成物＝住人のギルド」と分かってしまう。実ギルドと同じ UUID 形の
  // 不透明な値にする（sanitize.js の anonId）。
  //
  // ただし **数字を決めている種は seedKey のまま**にする。週間ポイントも
  // 週間クエストの進み具合も id をシードにしているので、起動ごとに変わる
  // 公開 id をそのまま使うと、再起動のたびにゴーストギルドの成績が飛ぶ
  // （このコードベースがいちばん嫌う「数字が嘘をつく」やつ）。
  const guilds = GHOST_DEFS.slice(0, want).map((d, i) => ({
    ...d, id: anonId(`ghost-guild:${i}`), seedKey: `ghost${i}`, members: [], ghost: true,
  }));
  for (const r of roster) {
    const h = unit(r.id, 'guild');
    if (h < 0.3) continue;                          // ~30% of residents are guildless
    const g = guilds[Math.floor((h - 0.3) / 0.7 * guilds.length) % guilds.length];
    // Ghost guilds obey the same member cap as real ones — a scale-grown
    // roster (up to 240 residents) must not show "26/20" or quadruple the
    // ghosts' weekly points on the ranking. Overflow residents stay guildless.
    if (g.members.length < GUILD_MAX_MEMBERS) g.members.push(r);
  }
  ghostCache = guilds;
  ghostCacheKey = key;
  return guilds;
}

export function ghostGuildOfResident(name) {
  return ghostGuilds().find(g => g.members.some(r => r.name === name)) || null;
}

function ghostWeekly(guild, weekId, now) {
  let total = 0;
  for (const r of guild.members) {
    const st = residentStats(r, now, weekId);
    total += Math.round((600 + r.skill * 2600) * (0.6 + unit(`${r.id}-gpts`, weekId) * 0.8) * (st.level > 10 ? 1.1 : 1));
  }
  return total;
}

// ゴーストギルドの週間クエストも決定的に。抽選は本物と同じ pickQuestIds、
// 進み具合は (ギルドid, クエストid, 週) のノイズ × 人数と実力 × 週の経過。
// db には何も書かないので、いつ誰が見ても同じ数字になる。
function ghostQuestState(guild, weekId, now) {
  const days = now / 86400000;                       // 月曜0時UTC＝weekIdの区切り
  const weekFrac = Math.min(1, ((days + 3) % 7) / 7 + 0.15);
  const size = guild.members.length / GUILD_MAX_MEMBERS;
  const skill = guild.members.length
    ? guild.members.reduce((a, r) => a + (r.skill || 0), 0) / guild.members.length
    : 0;
  const power = 0.6 + size * 0.5 + skill * 0.5;
  // シードは seedKey（`ghost0` …）で引く。公開 id は起動ごとに変わるので、
  // そちらを種にすると再起動でクエストの抽選も進捗も別物になる。
  const seedKey = guild.seedKey || guild.id;
  // 🕵 目標は **実ギルドとまったく同じ式**（questGoalOf）で縮める。
  //    ここだけ素の def.goal を返していたので、「20人未満なのに目標が満額の
  //    ギルド＝住人のギルド」という総当たりの判別器になっていた
  //    （実ギルドは v2.63 から必ず人数ぶんに縮む）。
  const quests = pickQuestIds(seedKey, weekId).map(id => {
    const def = questDefOf(id);
    if (!def) return null;
    const goal = questGoalOf(def, guild.members.length);
    const ratio = (0.35 + unit(`${seedKey}-${def.id}`, weekId) * 0.95) * power * weekFrac;
    const progress = Math.max(0, Math.min(goal, Math.round(goal * ratio)));
    return {
      id: def.id, name: def.name, nameEn: def.nameEn,
      goal, progress, coins: def.coins, gems: def.gems,
      done: progress >= goal, doneAt: null, claimed: false,
    };
  }).filter(Boolean);
  const doneCount = quests.filter(r => r.done).length;
  return {
    week: weekId, quests, total: quests.length, doneCount,
    allDone: quests.length > 0 && doneCount === quests.length,
    // 🕵 欄をそろえる。guildQuestView が返すのにこちらに無い欄は、
    //    それだけで「住人のギルド」の目印になる（ghostGuildViews の注記と同じ）。
    lockedByOtherGuild: false,
    badge: GUILD_QUEST_BADGE, badgeName: 'ギルドの誉れ', badgeNameEn: 'Guild Honors',
    badgeEarned: quests.length > 0 && doneCount === quests.length,
    claimable: false,
  };
}

// detailed: guildView(..., { detailed: true }) と同じ深さで返すかどうか。
// 一覧（/api/guilds）は実ギルドを浅い形で返すので、ゴーストだけ members や
// quests を持っていると **持ち物の多さ**が指紋になる。深さも実ギルドに合わせる。
export function ghostGuildViews(weekId, now = Date.now(), { detailed = false } = {}) {
  // 🎭 にぎわいが止まっているなら、住人のギルドは**存在しない**。
  //
  // ⚠ ここを route 側だけで見ていたので、3つの入口で判断がバラバラだった:
  //     一覧 GET /api/guilds        … toggles.guilds を見ていた
  //     詳細 GET /api/guilds/:id    … 何も見ていない
  //     参加 POST /api/guilds/join  … 何も見ていない
  //   結果、にぎわいを止めても **id を知っていれば詳細が引け**、参加しようと
  //   すると「このギルドは招待制です」という住人のギルド専用の返事が来た。
  //   一覧に無いのに 409 が返る、は住人のギルドの判別器そのもの。
  //   しかも「完全オフ」プリセットは scale:0 しか設定せず toggles を触らないので、
  //   にぎわいを全部止めたつもりでも4件が一覧に残っていた（実測）。
  //   判断はここ1か所に置く ── 入口を1つ足すたびに増える形にしない。
  if (!(effectiveScale() > 0)) return [];
  let on = true;
  try { on = getCustom().toggles.guilds !== false; } catch { /* 既定は出す */ }
  if (!on) return [];
  return ghostGuilds().map(g => {
    const seedKey = g.seedKey || g.id;
    const weeklyPoints = ghostWeekly(g, weekId, now);
    const quests = ghostQuestState(g, weekId, now);
    // lifetime も seedKey で（公開 id は起動ごとに変わるため）。
    const lifetime = Math.round(weeklyPoints * (6 + (strHash(seedKey) % 9)));
    const level = guildLevel(lifetime);
    // 🎭 実ギルドの detailed ビュー（guildView）と **同じ欄をそろえる**。
    // 欠けている欄が1つでもあると、「createdAt が無いギルド＝住人のギルド」
    // という形の指紋になる。createdAt はロースターと同じく決定的に作る。
    const createdAt = Date.UTC(2026, 6, 20) + (strHash(`${seedKey}-born`) % 60) * 86400000;
    const base = {
      id: g.id, name: g.name, tag: g.tag, icon: g.icon, desc: g.desc,
      // 🎭 住人のギルドは全部「招待制」にする。以前は 1/3 が公開募集だったので、
      // 加入を試すと必ず 404（＝そのギルドは実在しない）が返り、「加入だけ絶対に
      // 失敗するギルド＝住人のギルド」という総当たり判定になっていた。招待制なら、
      // 実在する招待制ギルドとまったく同じ断り方（ルームコードが要る）になる
      // ── コードは誰も知らないので、結果として誰も入れないことは変わらない。
      open: false,
      level, bonusPct: Math.round(guildCoinBonus(level) * 100),
      memberCount: g.members.length, maxMembers: GUILD_MAX_MEMBERS,
      weeklyPoints, lifetime, createdAt, ghost: true,
      questsDone: quests.doneCount, questTotal: quests.total,
    };
    if (!detailed) return base;
    // 名簿は詳細を開いたときだけ組む（一覧で毎回 residentStats を人数ぶん
    // 回すと、ギルド一覧が住人の数だけ重くなる）。
    const members = g.members.map((r, mi) => {
      const st = residentStats(r, now, weekId);
      return {
        id: anonId(`ghost-member:${seedKey}:${r.id}`),
        username: r.name, level: st.level,
        role: mi === 0 ? 'owner' : 'member',
        weeklyPts: Math.round((600 + r.skill * 2600) * 0.9),
        rating: st.rating,
        joinedAt: createdAt,
      };
    });
    return {
      ...base,
      quests,
      // 実ギルドの detailed ビューが持つ欄。code は「リーダー本人以外は null」
      // なので、他人のギルドを覗いたときと同じ null になる。
      ownerId: members.length ? members[0].id : null,
      code: null,
      members,
    };
  });
}

// Tag for a chat/leaderboard name: real guild first, then ghost guild.
export function tagOfName(db, name, user) {
  const u = user || Object.values(db.users).find(x => x.username === name);
  if (u && u.guildId && db.guilds[u.guildId]) return db.guilds[u.guildId].tag;
  const g = ghostGuildOfResident(name);
  return g ? g.tag : null;
}
