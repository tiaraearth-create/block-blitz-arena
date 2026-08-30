// Guilds (ギルド): small player clubs with a tag, a weekly points race and a
// coin bonus that grows with the guild's level.
//
// Points come from every finished game of every member (see applyGameResult),
// bucketed per ISO week so the leaderboard resets on Mondays while the
// lifetime total keeps raising the guild's level. Ghost guilds made of crowd
// residents pad the ranking and give the residents tags in chat.

import crypto from 'crypto';
import { getRoster, residentStats } from './ambient.js';
import { unit, strHash } from './residents.js';

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
  return { guild };
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
  guild.members.push(user.id);
  user.guildId = guild.id;
  user.guildJoinedAt = Date.now();
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
  if (t) { t.guildId = null; t.guildLeftAt = Date.now(); }
  return { ok: true };
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
  };
  if (!detailed) return base;
  const isOwner = viewerId === guild.ownerId;
  return {
    ...base,
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
  const guilds = GHOST_DEFS.slice(0, want).map((d, i) => ({ ...d, id: `ghost${i}`, members: [], ghost: true }));
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

export function ghostGuildViews(weekId, now = Date.now()) {
  return ghostGuilds().map((g, i) => {
    const weeklyPoints = ghostWeekly(g, weekId, now);
    const lifetime = Math.round(weeklyPoints * (6 + (strHash(g.id) % 9)));
    const level = guildLevel(lifetime);
    return {
      id: g.id, name: g.name, tag: g.tag, icon: g.icon, desc: g.desc, open: i % 3 !== 0,
      level, bonusPct: Math.round(guildCoinBonus(level) * 100),
      memberCount: g.members.length, maxMembers: GUILD_MAX_MEMBERS,
      weeklyPoints, lifetime, ghost: true,
      members: g.members.map(r => { const st = residentStats(r, now, weekId); return { username: r.name, level: st.level, rating: st.rating, weeklyPts: Math.round((600 + r.skill * 2600) * 0.9) }; }),
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
