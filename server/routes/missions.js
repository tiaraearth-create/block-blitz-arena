// 📋 ミッション（デイリー／ウィークリー・🎲引き直し）・🏅実績・🎫バトルパス。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
import express from 'express';
import {
  saveDb,
} from '../db.js';
import {
  requireAuth,
} from '../auth.js';
import {
  BP_TIERS, BP_XP_PER_TIER, BP_PREMIUM_PRICE_GEMS,
} from '../catalog.js';
// 🎲 ミッションのリロールは missions.js 側が `rerollMission` を生やしたときだけ
// 動く。名前付き import にすると「まだ生えていない」時点で ES モジュールの
// リンクが失敗し、サーバーごと起動しなくなる（db.js の実測値ゲッターと同じ話）。
// 名前空間で受けて、実行時に有無を見る。
import * as missionsModule from '../missions.js';
import {
  syncMissions, missionsView, claimMission, claimMissionBonus,
} from '../missions.js';
import {
  achievementsView, claimAchievement, ACHIEVEMENTS,
} from '../achievements.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, migrateUser, currentSeason, syncBattlePass, publicUser, postRealFeed, rateLimit, currentWeekNum, settleSeasonHallOfFame;
export function initMissionRoutes() {
  ({ db, migrateUser, currentSeason, syncBattlePass, publicUser, postRealFeed, rateLimit, currentWeekNum, settleSeasonHallOfFame } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const missionsRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Missions (daily / weekly)
// ---------------------------------------------------------------------------

missionsRouter.get('/api/missions', requireAuth, (req, res) => {
  migrateUser(req.user);
  // ログイン中のクライアントは全員が120秒ごとにここを叩く。無条件に saveDb()
  // すると、誰も遊んでいない待機中でも db.json 全体の書き直しが走り続ける。
  // 実際に書き換わるのは「日／週が変わってお題を作り直したとき」だけなので、
  // その時だけ保存する（index.js の syncPoll と同じ作法）。
  const ms0 = req.user.missions || {};
  const before = `${ms0.day || ''}|${ms0.week || ''}`;
  const ms = syncMissions(req.user, currentWeekNum());
  if (`${ms.day || ''}|${ms.week || ''}` !== before) saveDb();
  res.json({
    missions: missionsView(req.user, currentWeekNum()),
    // 🎲 引き直しの残り回数と次の値段。missions.js に rerollMission が
    // 無い間は available:false を返し、クライアントはボタンごと隠せる。
    reroll: rerollViewOf(req.user, currentWeekNum()),
  });
});

missionsRouter.post('/api/missions/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const id = String(req.body.id || '');
  const out = id === 'daily_bonus' || id === 'weekly_bonus'
    ? claimMissionBonus(req.user, currentWeekNum(), id === 'daily_bonus' ? 'daily' : 'weekly')
    : claimMission(req.user, currentWeekNum(), id);
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({
    reward: out,
    missions: missionsView(req.user, currentWeekNum()),
    user: publicUser(req.user),
  });
});

// 🎲 ミッションのリロール（引き直し）。1日の1回目は無料、以降は有料。
//
// 引き直しそのものは missions.js の rerollMission が行う ── お題のプールも、
// その日に何回使ったか（ms.rerolls[dayKey]）も、値段表も向こうが持っている。
// ここは薄い口:
//   ・呼ぶ前に何も減らさない（向こうが残高不足を見て断ってくれる）
//   ・**引き落とすのはサーバー。金額は向こうが返した cost しか信じない**
//     （クライアントの申告する値段は一切見ない）
//   ・回数の加算も向こうが済ませているので、ここでは触らない
// 保存は引き直しが成った後に1回。失敗した経路では db に触れていない。
//
// 予備の値段。rerollMission が cost を返さない実装だった場合だけ使う。
const MISSION_REROLL_COST = 500;
const MISSION_REROLL_FREE = 1;

// 画面向けの残り回数と次の値段。missions.js が rerollInfo を持っていれば
// そちらが正（値段表を知っているのは向こうなので）。無ければ簡易版で答える。
function rerollViewOf(user, weekNum) {
  const available = typeof missionsModule.rerollMission === 'function';
  if (!available) return { available: false };
  if (typeof missionsModule.rerollInfo === 'function') {
    try { return { available: true, ...missionsModule.rerollInfo(user, weekNum) }; }
    catch { /* 落ちても画面は出す */ }
  }
  return { available: true, freePerDay: MISSION_REROLL_FREE, price: MISSION_REROLL_COST };
}

missionsRouter.post('/api/missions/reroll', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`reroll:${req.user.id}`, 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '引き直しが多すぎます。少し待ってください' });
  }
  const fn = missionsModule.rerollMission;
  if (typeof fn !== 'function') {
    return res.status(501).json({ error: 'ミッションの引き直しはまだ使えません' });
  }
  migrateUser(req.user);
  const weekNum = currentWeekNum();
  syncMissions(req.user, weekNum);
  const id = String((req.body || {}).id || '').slice(0, 40);
  if (!id) return res.status(400).json({ error: 'ミッションを選んでください' });
  // 💎払いは明示したときだけ（既定は今までどおり🪙コイン）。値段はここでも
  // 決めない ── missions.js が返した costGems しか信じない。
  const currency = (req.body || {}).currency === 'gems' ? 'gems' : 'coins';

  let out;
  try {
    out = fn(req.user, weekNum, id, { currency });
  } catch (err) {
    console.error('[missions] rerollMission が失敗:', err && err.message);
    return res.status(500).json({ error: '引き直しに失敗しました' });
  }
  if (!out || out.error) {
    const msg = (out && out.error) || 'このミッションは引き直せません';
    // 残高不足は 400（画面が「コイン／ジェムが足りない」を出し分けられるように）。
    return res.status(/(コイン|ジェム)が足りません/.test(msg) ? 400 : 409).json({ error: msg });
  }

  // 💰 引き落としはここでだけ行う。金額はサーバー（missions.js）が決めた値。
  // 通貨も向こうが確定させた out.currency を見る（クライアントの申告は
  // 「どちらで払うか」の希望まで。値段は一切見ない）。
  // 管理者は無料（ショップ・ガチャと同じ扱い）。
  const paidWith = out.currency === 'gems' ? 'gems' : 'coins';
  const listed = paidWith === 'gems' ? out.costGems : out.cost;
  let cost = Math.max(0, Math.floor(Number(listed) || 0));
  if (req.user.role === 'admin') cost = 0;
  if (cost > 0) {
    const have = Math.max(0, Number(req.user[paidWith]) || 0);
    if (have < cost) {
      // ここに来るのは、向こうの残高確認と食い違ったときだけ（本来起きない）。
      // 盤面は書き換わってしまっているので、引き直し自体は成立させ、
      // 取れるぶんだけ取る（マイナス残高は作らない）。
      console.warn(`[missions] ${req.user.username}: 引き直しの残高が不足（cost=${cost} ${paidWith}=${have}）`);
      cost = have;
    }
    req.user[paidWith] -= cost;
  }
  saveDb();
  res.json({
    missions: out.missions || missionsView(req.user, weekNum),
    user: publicUser(req.user),
    reroll: {
      cost: paidWith === 'coins' ? cost : 0,
      gems: paidWith === 'gems' ? cost : 0,
      currency: paidWith,
      scope: out.scope || null, from: out.from || id, to: out.to || null,
      ...rerollViewOf(req.user, weekNum),
    },
  });
});

// ---------------------------------------------------------------------------
// Achievements (実績)
// ---------------------------------------------------------------------------

missionsRouter.get('/api/achievements', (req, res) => {
  if (!req.user) {
    // Guests still get to browse the list (progress reads as zero).
    return res.json({ achievements: achievementsView({ stats: {}, badges: [], owned: [], achievements: [], coins: 0, xp: 0 }) });
  }
  migrateUser(req.user);
  res.json({ achievements: achievementsView(req.user) });
});

missionsRouter.post('/api/achievements/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const out = claimAchievement(req.user, String(req.body.id || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  // The rarest achievements are worth a line on the feed.
  const top = ACHIEVEMENTS.filter(a => out.ids.includes(a.id)).sort((a, b) => b.gems - a.gems)[0];
  if (top && top.gems >= 15) {
    postRealFeed(req.user, [{ icon: top.icon, ja: `${req.user.username} が実績「${top.name}」を解除！`, en: `${req.user.username} unlocked "${top.nameEn}"!` }]);
  }
  res.json({ reward: out, achievements: achievementsView(req.user), user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Battle pass
// ---------------------------------------------------------------------------

missionsRouter.get('/api/battlepass', (req, res) => {
  settleSeasonHallOfFame();   // 🏛 シーズンの切替はここでも拾う
  res.json({
    season: currentSeason(),
    tiers: BP_TIERS,
    xpPerTier: BP_XP_PER_TIER,
    premiumPriceGems: BP_PREMIUM_PRICE_GEMS,
    progress: req.user ? syncBattlePass(req.user) : null,
  });
});

missionsRouter.post('/api/battlepass/premium', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  if (bp.premium) return res.status(409).json({ error: 'すでにプレミアムです' });
  if (user.gems < BP_PREMIUM_PRICE_GEMS) return res.status(402).json({ error: 'ジェムが足りません' });
  user.gems -= BP_PREMIUM_PRICE_GEMS;
  bp.premium = true;
  saveDb();
  res.json({ user: publicUser(user) });
});

missionsRouter.post('/api/battlepass/claim', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  const tierNum = Math.floor(Number(req.body.tier));
  const track = req.body.track === 'premium' ? 'premium' : 'free';
  const tierDef = BP_TIERS.find(t => t.tier === tierNum);
  if (!tierDef) return res.status(404).json({ error: 'ティアが見つかりません' });
  const reward = tierDef[track];
  if (!reward) return res.status(400).json({ error: '報酬がありません' });
  if (track === 'premium' && !bp.premium) return res.status(403).json({ error: 'プレミアムパスが必要です' });
  const unlockedTier = Math.floor(bp.xp / BP_XP_PER_TIER);
  if (tierNum > unlockedTier) return res.status(403).json({ error: 'まだ解放されていません' });
  const key = `${tierNum}:${track}`;
  if (bp.claimed.includes(key)) return res.status(409).json({ error: '受け取り済みです' });

  bp.claimed.push(key);
  if (reward.type === 'coins') user.coins += reward.amount;
  else if (reward.type === 'gems') user.gems += reward.amount;
  else if (reward.type === 'item') { if (!user.owned.includes(reward.id)) user.owned.push(reward.id); }
  else if (reward.type === 'badge') { if (!user.badges.includes(reward.id)) user.badges.push(reward.id); }
  saveDb();
  res.json({ user: publicUser(user), reward });
});
