// 🏰 ギルド（設立・加入・脱退・追放・設定・🗡️週間クエストの金庫）と
// 📕 コレクション図鑑。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
import express from 'express';
import {
  saveDb,
} from '../db.js';
import {
  requireAuth, requireAdmin,
} from '../auth.js';
import {
  SHOP_ITEMS, COLLECTION_SETS, collectionView, claimCollection,
} from '../catalog.js';
import {
  getCustom,
} from '../ambient.js';
import {
  GUILD_CREATE_COST, GUILD_ICONS, createGuild, findGuild, joinGuild, leaveGuild, kickMember, guildView, ghostGuildViews, validateGuildInput, claimGuildQuest,
} from '../guilds.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, migrateUser, levelOf, curWeek, publicUser, rateLimit, battle;
export function initGuildRoutes() {
  ({ db, migrateUser, levelOf, curWeek, publicUser, rateLimit, battle } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const guildRouter = express.Router();
export const collectionRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Guilds (ギルド)
// ---------------------------------------------------------------------------

guildRouter.get('/api/guilds', (req, res) => {
  // /api/leaderboard と同じく無認証で全ギルド走査＋ゴースト合成する重い経路。
  // 同じIPレート制限で連打を抑える。
  if (!rateLimit(`guilds:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください' });
  const week = curWeek();
  const real = Object.values(db.guilds).map(g => guildView(db, g, week));
  // 🎭 一覧は実ギルドと同じ「浅い」形で（detailed を渡さない）。ゴーストだけ
  // members / quests を抱えていると、持ち物の多さでどれが住人のギルドか分かる。
  const ghosts = getCustom().toggles.guilds ? ghostGuildViews(week).filter(g => !real.some(r => r.name === g.name || r.tag === g.tag)) : [];
  const rows = real.concat(ghosts).sort((a, b) => b.weeklyPoints - a.weeklyPoints).slice(0, 50).map((g, i) => ({ ...g, rank: i + 1 }));
  const mine = req.user && req.user.guildId && db.guilds[req.user.guildId]
    ? guildView(db, db.guilds[req.user.guildId], week, { detailed: true, viewerId: req.user.id, levelOf })
    : null;
  if (mine) mine.rank = rows.findIndex(r => r.id === mine.id) + 1 || null;
  res.json({ week, guilds: rows, mine, createCost: GUILD_CREATE_COST, icons: GUILD_ICONS });
});

guildRouter.get('/api/guilds/:id', (req, res) => {
  // `__proto__` や `constructor` を渡されると Object.prototype が返ってきて
  // truthy 判定を通り、そのあと g.members で落ちて 500 になっていた。
  const g = Object.prototype.hasOwnProperty.call(db.guilds, req.params.id) ? db.guilds[req.params.id] : null;
  if (g) return res.json({ guild: guildView(db, g, curWeek(), { detailed: true, viewerId: req.user && req.user.id, levelOf }) });
  // 詳細は実ギルドと同じ深さ（members / quests / ownerId / code つき）で返す。
  const ghost = ghostGuildViews(curWeek(), Date.now(), { detailed: true }).find(x => x.id === req.params.id);
  if (ghost) return res.json({ guild: ghost });
  res.status(404).json({ error: 'ギルドが見つかりません' });
});

guildRouter.post('/api/guilds/create', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  if (user.role !== 'admin' && user.coins < GUILD_CREATE_COST) {
    return res.status(402).json({ error: `ギルド設立にはコイン${GUILD_CREATE_COST}が必要です` });
  }
  const out = createGuild(db, user, req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  if (user.role !== 'admin') user.coins -= GUILD_CREATE_COST;
  user.guildFounded = true;
  saveDb();
  battle.crowd.feed({ icon: out.guild.icon, real: true, who: user.username,
    text: `${user.username} がギルド「${out.guild.name}」を設立！`, textEn: `${user.username} founded the guild "${out.guild.name}"!` });
  res.json({ guild: guildView(db, out.guild, curWeek(), { detailed: true, viewerId: user.id, levelOf }), user: publicUser(user) });
});

guildRouter.post('/api/guilds/join', requireAuth, maintenanceGuard, (req, res) => {
  const b = req.body || {};
  const guild = findGuild(db, { id: b.id, code: b.code });
  if (!guild) {
    // 🎭 一覧に並んでいる住人のギルドに加入を試したとき、「そんなギルドは無い」
    // と返すと、それだけで住人のギルドが特定できる（実在するのに存在しない、は
    // 住人にしか起きない）。招待制の実ギルドとまったく同じ断り方にそろえる
    // ── ゴーストは open:false なので、これが本来出るはずの文言でもある。
    if (b.id && ghostGuildViews(curWeek()).some(g => g.id === String(b.id))) {
      return res.status(409).json({ error: 'このギルドは招待制です（ルームコードが必要）' });
    }
    return res.status(404).json({ error: b.code ? 'そのコードのギルドは見つかりません' : 'ギルドが見つかりません' });
  }
  const out = joinGuild(db, req.user, guild, { viaCode: !!b.code });
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }), user: publicUser(req.user) });
});

guildRouter.post('/api/guilds/leave', requireAuth, (req, res) => {
  const out = leaveGuild(db, req.user);
  saveDb();
  res.json({ ok: true, disbanded: !!out.disbanded, user: publicUser(req.user) });
});

guildRouter.post('/api/guild/kick', requireAuth, (req, res) => {
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  const out = kickMember(db, guild, req.user, String(req.body.userId || ''));
  if (out.error) return res.status(403).json({ error: out.error });
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }) });
});

guildRouter.post('/api/guild/settings', requireAuth, (req, res) => {
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  if (guild.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'ギルドリーダーのみ変更できます' });
  const v = validateGuildInput(req.body || {}, { partial: true });
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.name && Object.values(db.guilds).some(g => g.id !== guild.id && g.name.toLowerCase() === v.name.toLowerCase())) {
    return res.status(409).json({ error: 'そのギルド名は使われています' });
  }
  if (v.tag && Object.values(db.guilds).some(g => g.id !== guild.id && g.tag === v.tag)) {
    return res.status(409).json({ error: 'そのタグは使われています' });
  }
  Object.assign(guild, v);
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }) });
});

// 🗡️ ギルド金庫 — 達成した週間クエストの宝箱を、メンバーが1人1回ずつ開ける。
//
// 報酬額はクライアントの申告を一切見ない。guilds.js が QUEST_POOL から
// 引き直したものだけを渡す（こちらは questId を取り次ぐだけ）。二重受取は
// guilds.js 側の user.guildQuests.claimed が止める。
// クエストの状態は guildView(detailed) の `quests` に載るので、専用のGETは要らない。
guildRouter.post('/api/guild/quest/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  if (!rateLimit('gquest:' + req.user.id, 20, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  const week = curWeek();
  const out = claimGuildQuest(db, req.user, week, String((req.body || {}).questId || (req.body || {}).id || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  // 3本すべて開けた人だけが手にする「ギルドの誉れ」。めったに出ないので告知する。
  if (out.badge) {
    battle.crowd.feed({ icon: '🎖️', real: true, who: req.user.username,
      text: `${req.user.username} がギルド週間クエストを完全制覇し「ギルドの誉れ」を獲得！`,
      textEn: `${req.user.username} cleared every weekly guild quest and earned Guild Honors!` });
  }
  res.json({
    reward: out,
    user: publicUser(req.user),
    guild: guildView(db, guild, week, { detailed: true, viewerId: req.user.id, levelOf }),
  });
});

guildRouter.delete('/api/admin/guilds/:id', requireAuth, requireAdmin, (req, res) => {
  // `__proto__` や `constructor` を渡されると Object.prototype が返ってきて
  // truthy 判定を通り、そのあと g.members で落ちて 500 になっていた。
  const g = Object.prototype.hasOwnProperty.call(db.guilds, req.params.id) ? db.guilds[req.params.id] : null;
  if (!g) return res.status(404).json({ error: 'ギルドが見つかりません' });
  for (const id of g.members) { const u = db.users[id]; if (u) u.guildId = null; }
  delete db.guilds[g.id];
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 📕 コレクション図鑑（catalog.js の COLLECTION_SETS）
//
// セットごとの所持数/総数・未所持の id・入手経路・コンプ報酬の受取状態。
// 対象アイテムはカタログから導出されているので、新しいスキンを1つ足した日に
// 「全種コンプ」が静かに嘘になることはない。
// ---------------------------------------------------------------------------

// 未所持の品がどこで手に入るか。図鑑のマスに出すラベルの材料
// （文言そのものはクライアントが日英で持っている）。
function collectionSourceOf(kind, id) {
  if (kind === 'badge') return 'badge';
  if (kind === 'title') return 'title';
  if (kind === 'boost') return 'shop';
  const it = SHOP_ITEMS.find(i => i.id === id);
  if (!it) return 'shop';
  return it.throneOnly ? 'throne' : it.gachaOnly ? 'gacha' : 'shop';
}

collectionRouter.get('/api/collection', requireAuth, (req, res) => {
  migrateUser(req.user);
  const view = collectionView(req.user);
  res.json({
    ...view,
    sets: view.sets.map(s => ({
      ...s,
      // 未所持ぶんだけ「どこで手に入るか」を添える（所持済みには要らない）。
      sources: s.missing.map(id => ({ id, source: collectionSourceOf(s.kind, id) })),
    })),
  });
});

// セットコンプ報酬の受け取り。id:'*' で受け取れるものをまとめて。
// 条件は必ずサーバー側で再判定し（claimCollection が collectionProgress を
// 引き直す）、報酬額も COLLECTION_SETS から計算する ── 申告は一切見ない。
// 二重受取を止めるフラグは **user.collections**（受け取り済みセットidの配列）。
collectionRouter.post('/api/collection/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const id = String((req.body || {}).id || (req.body || {}).setId || '*');
  if (id !== '*' && !COLLECTION_SETS.some(s => s.id === id)) {
    return res.status(404).json({ error: 'そのセットはありません' });
  }
  const out = claimCollection(req.user, id);
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ reward: out, user: publicUser(req.user), collection: collectionView(req.user) });
});
