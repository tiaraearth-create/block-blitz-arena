// 🛡 管理者パネル — ユーザー編集／シーズン／バックアップと復元／メンテナンス／
//    運営ログ／モデレーター用のチャット取り締まり／にぎわい調整／👁️管理者ゼロ。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
//
// ⚠ requireAuth / requireAdmin / requireMod の並びは分割前とまったく同じ。
//    ここは権限の境界そのものなので、順番も有無も動かさないこと。
//    /api/admin/restore に requireAuth が無いのは元からの設計（バックアップ内の
//    管理者パスワードで認証する復旧経路。ハンドラの中で検証している）。
import express from 'express';
import path from 'path';
import {
  saveDb, flushDb, lastPersistError,
} from '../db.js';
import {
  hashPassword, verifyPassword, revokeAllTokens, requireAuth, requireAdmin,
} from '../auth.js';
import {
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED, BOOST_ITEMS, EQUIP_SLOTS, BP_TIERS, BP_XP_PER_TIER, TITLES,
} from '../catalog.js';
import {
  syncMissions, missionsView,
} from '../missions.js';
import {
  achievementsView,
} from '../achievements.js';
import {
  setLiveScale, getLiveScale, setCustom, getCustom, rosterView, retiredResidents, crowdMood, isQuietNow, DEFAULT_TOGGLES, ARCHETYPES, MAX_LIVE_SCALE, clashingResidentIds, activeResidents,
  // マッチングの状況で「住人の待機数」を実プレイヤーと**別のキー**で返すのに使う。
  ambientQueue,
} from '../ambient.js';
import {
  leaveGuild,
} from '../guilds.js';
import {
  translateChat,
} from '../translate.js';
import {
  validateBackup, applyRestore, snapshot, listSnapshots, readSnapshot, BACKUP_VERSION,
} from '../backup.js';
import {
  healSocial, unfriendAll,
} from '../friends.js';
import {
  archivedTransactions, anonymizeUserTransactions, TX_ANON_NAME,
} from './shop.js';
import {
  purgeUserWorkshop,
} from './workshop.js';
import {
  purgeUserDailyReplays,
} from './daily.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, battle, battleReady,
  migrateUser, publicUser, userById, levelOf, sanitizeName,
  currentSeason, SEASON_MS, derivedSeasonIndex, adoptLegacySeason, syncBattlePass,
  currentWeekNum, refreshThrones, SEASON_BADGE_RE,
  rateLimit, adminLog, ADMIN_LOG_MAX, RESERVED_NAMES, ADMIN_KNOWN_BADGES;
export function initAdminRoutes() {
  ({ db, battle, battleReady,
    migrateUser, publicUser, userById, levelOf, sanitizeName,
    currentSeason, SEASON_MS, derivedSeasonIndex, adoptLegacySeason, syncBattlePass,
    currentWeekNum, refreshThrones, SEASON_BADGE_RE,
    rateLimit, adminLog, ADMIN_LOG_MAX, RESERVED_NAMES, ADMIN_KNOWN_BADGES } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const requireMod = (req, res, next) => ctx.requireMod(req, res, next);

// 🧩 退会の後始末（UGC・履歴・接続）── **削除経路が2本あるので1本にまとめてある**。
//
// 掃除するもの: 🛠工房のステージと♡、📅デイリーのゴースト、💎購入履歴の表示名、
// 🐛バグ報告とクライアントエラーの報告者名、💬全体チャット履歴の発言者名、
// 🚪その人の開いている WebSocket。
//
// レコードを消しただけだと、工房のステージ・📅デイリーのゴースト・💎購入履歴が
// 「投稿時の表示名スナップショット」で名前を出し続ける（どれも db.users から
// 引けないときの控えを持っている）。とくに作者不在のステージは
// WS_MAX_STAGES のグローバル枠を永久に食うのに、表示は byName へ
// フォールバックして壊れて見えないので、減っていることに誰も気づけない。
//
// 呼ぶのは DELETE /api/admin/users/:id（下）と DELETE /api/me（server/index.js）の
// 2本。以前は前者だけが3本を直接呼んでいて、実際に多いほうの経路（本人の退会）が
// 素通りしていた。次に後始末が1本増えたときに同じ非対称が再発しないよう、
// **足すのはこの関数の中だけ**にすること。
// （凍結 banned=true は別。あちらは workshop.js が公開面から隠すだけなので
//  ここは触らず、凍結解除でそのまま戻す。）
// レコードの削除より前でも後でもよい（どれも id で照合するだけ）。saveDb は
// しない ── 呼び出し側がレコード削除まで済ませてから1回だけ保存する。
export function purgeUserContent(userId, username) {
  const id = String(userId || '');
  if (!id) return { stages: 0, likes: 0, replays: 0, transactions: 0, reports: 0, errors: 0, chat: 0, sockets: 0, hof: 0, news: 0 };
  const ws = purgeUserWorkshop(id);
  if (ws.stages) console.log(`[workshop] 退会に伴い ${username || id} のステージ ${ws.stages} 件を削除しました`);
  const replays = purgeUserDailyReplays(id);
  const transactions = anonymizeUserTransactions(id);
  // 🐛 バグ報告と 💥 クライアントエラーは userId を持たず `by`（表示名）だけで
  // 記録される。件数と本文は運営の資産なので残し、名前だけ伏せる。
  // ⚠ 名前で照合するので、**改名より前に持っていた名前の行は残る**。
  //   ここを id で引けるようにするなら記録側（server/index.js の
  //   /api/bugreport と /api/clienterror）に userId を足すのが先。
  const name = String(username || '');
  // ID を持つ記録は ID で、持たない古い記録は名前で。名前だけで消すと、
  // 同じ名前を後から取った別人の記録まで巻き添えにする。
  const isMine = rec => !!rec && (rec.byId ? rec.byId === id : (!!name && rec.by === name));
  let reports = 0;
  if (Array.isArray(db.bugreports)) {
    for (const r of db.bugreports) {
      if (!isMine(r) || r.by === TX_ANON_NAME) continue;
      r.by = TX_ANON_NAME; r.byId = null; r.role = 'player'; r.deletedUser = true; reports++;
    }
  }
  let errors = 0;
  if (db.meta && Array.isArray(db.meta.clientErrors)) {
    for (const e of db.meta.clientErrors) {
      if (!isMine(e) || e.by === TX_ANON_NAME) continue;
      e.by = TX_ANON_NAME; e.byId = null; e.role = 'player'; e.deletedUser = true; errors++;
    }
  }
  // 🏛 殿堂に刻まれた名前。記録（順位と値）は歴代の事実なので残し、名前だけ伏せる。
  //    照合は userId 優先（同姓同名や、その名前を後から取った人を巻き込まない）。
  let hof = 0;
  if (db.meta && Array.isArray(db.meta.hallOfFame)) {
    for (const season of db.meta.hallOfFame) {
      for (const b of (season && Array.isArray(season.boards) ? season.boards : [])) {
        for (const t of (Array.isArray(b.top) ? b.top : [])) {
          const mine = t && (t.userId ? t.userId === id : (!!name && t.username === name));
          if (!mine || t.username === TX_ANON_NAME) continue;
          t.username = TX_ANON_NAME; t.userId = null; hof++;
        }
      }
    }
  }
  // 📰 お知らせ。未ログインでも読めるので、退会したのに名前だけ残るのは避けたい。
  //    ただし本文はただの文章なので、名前を無差別に文字列置換すると別の語の
  //    一部まで壊す（2文字の名前は他の語に埋まりうる）。
  //    そこで **自分たちが焼き込んだと分かっている記録だけ** を直す ──
  //    生成時に names を残してあり、書式も必ず「名前（値）」「name (value)」。
  //    直前が行頭か空白で、直後が開き括弧のときだけ置き換える。
  //    ⚠ names を持たない古いお知らせは触らない（壊すほうが害が大きい）。
  //    照合は names に焼いた userId で行う ── 本文は「当時の名前」のまま残す
  //    方針なので、改名 → 退会 の順で通られると今の名前では引けない。
  let news = 0;
  if (Array.isArray(db.news)) {
    const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const n of db.news) {
      if (!n) continue;
      if (name && n.by === name) { n.by = TX_ANON_NAME; news++; }
      if (!Array.isArray(n.names)) continue;
      // 古い形（名前だけの配列）も受ける。
      const rows = n.names.map(x => (typeof x === 'string' ? { name: x, userId: null } : x)).filter(Boolean);
      const mine = rows.filter(r => (r.userId ? r.userId === id : (!!name && r.name === name)));
      if (!mine.length) continue;
      for (const r of mine) {
        if (!r.name || r.name === TX_ANON_NAME) continue;
        // 自分たちが焼いた書式「名前（値）」「name (value)」だけを狙う。
        // 行頭か空白のあとで、直後が開き括弧のときにしか置き換えない。
        const re = new RegExp(`(^|\\s)${esc(r.name)}(?=[（(])`, 'gm');
        if (typeof n.body === 'string') n.body = n.body.replace(re, `$1${TX_ANON_NAME}`);
        if (typeof n.bodyEn === 'string') n.bodyEn = n.bodyEn.replace(re, `$1${TX_ANON_NAME}`);
      }
      n.names = rows.filter(r => !mine.includes(r));
      news++;
    }
  }
  // 💬 全体チャットの履歴と 🚪 開きっぱなしの socket。どちらも battle 側にしか
  // 実体が無いので、そちらの入口を借りる（battle がまだ立っていない起動途中や
  // 部分起動のテストでは何もしない）。
  let chat = 0, sockets = 0;
  if (battleReady && battle) {
    if (name && typeof battle.scrubDepartedName === 'function') {
      chat = battle.scrubDepartedName(name, TX_ANON_NAME);
    }
    if (typeof battle.disconnectUser === 'function') {
      sockets = battle.disconnectUser(id, 'このアカウントは削除されました');
    }
  }
  return { stages: ws.stages, likes: ws.likes, replays, transactions, reports, errors, chat, sockets, hof, news };
}

export const adminRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, role: u.role, banned: u.banned, muted: !!u.muted,
    coins: u.coins, gems: u.gems, level: levelOf(u.xp),
    stats: u.stats, createdAt: u.createdAt,
    // 🕒 既にレコードに入っているのに、どこからも返していなかった2つ。
    //   lastSeen  … 最後の接続が切れた時刻（battle.js が書く）
    //   lastDaily … ログインボーナスを最後に受け取った日
    // 「この人は最近来ているのか」を知るのに管理画面がいちばん欲しい値なのに、
    // 一覧にも編集画面にも出ていなかったので、運営は db.json を直接開くしか
    // 確かめる方法が無かった。集計は /api/admin/playerstats（下）が持つが、
    // 既存の一覧からも読めるようにしておく。
    lastSeen: Number(u.lastSeen) || 0,
    lastDaily: u.lastDaily || null,
  }));
  res.json({ users });
});

// 🎒 インベントリ編集 — one screen with everything an admin can put back.
//
// The list endpoint above deliberately stays light (it renders every account),
// so the editor asks for one player in full, plus the catalogue it needs to
// draw checkboxes for. Without this the client would have to guess what exists.
// The RAW record as the editor needs to see it. Deliberately not publicUser():
// that one hands admins the entire shop and infinite currency as a display
// fiction, which the editor must never read back as fact.
function adminUserView(u) {
  return {
    id: u.id, username: u.username, role: u.role,
    banned: !!u.banned, muted: !!u.muted,
    coins: u.coins, gems: u.gems, xp: u.xp, level: levelOf(u.xp),
    items: u.items || {}, owned: u.owned || [], equipped: u.equipped || {},
    equippedTitle: u.equippedTitle || null,
    badges: u.badges || [], achievements: u.achievements || [],
    battlePass: u.battlePass || null,
    createdAt: u.createdAt,
    // 🕒 一覧と同じ2つ。編集画面は「事故の後にこの人を元へ戻す」ための面なので、
    // 最後に来た日と、ログインボーナスをどこまで受け取ったかが読めないと
    // 「いつの状態へ戻せばいいのか」が決められない。
    lastSeen: Number(u.lastSeen) || 0,
    lastDaily: u.lastDaily || null,
    guildId: u.guildId || null,
    guildName: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].name : null,
    stats: u.stats,
  };
}

adminRouter.get('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  migrateUser(u);
  res.json({
    user: adminUserView(u),
    catalog: {
      shop: SHOP_ITEMS.map(i => ({ id: i.id, cat: i.cat, name: i.name, adminOnly: !!i.adminOnly, gachaOnly: !!i.gachaOnly })),
      boosters: BOOST_ITEMS.map(i => ({ id: i.id, name: i.name, adminOnly: !!i.adminOnly })),
      slots: EQUIP_SLOTS,
      titles: TITLES.map(t => ({ id: t.id, name: t.name, color: t.color })),
      badges: ADMIN_KNOWN_BADGES,
      // Only these stats are hand-editable. Everything else is a running total
      // the game maintains, and editing it just makes the numbers lie.
      stats: EDITABLE_STATS,
    },
  });
});

// The stats an admin can sensibly restore. Anything derived (level from xp,
// titles from stats, achievement progress) is deliberately absent — those
// recompute themselves from what is set here.
const EDITABLE_STATS = [
  { key: 'bestScore', label: 'ハイスコア', max: 100_000_000 },
  { key: 'rating', label: 'レート', max: 5000 },
  { key: 'gamesPlayed', label: 'プレイ回数', max: 1_000_000 },
  { key: 'totalScore', label: '累計スコア', max: 1_000_000_000 },
  { key: 'totalLines', label: '累計ライン', max: 10_000_000 },
  { key: 'maxCombo', label: '最大コンボ', max: 999 },
  { key: 'pvpWins', label: 'PvP勝利', max: 1_000_000 },
  { key: 'pvpLosses', label: 'PvP敗北', max: 1_000_000 },
  { key: 'dungeonMax', label: '塔 最高階', max: 100 },
  { key: 'underMax', label: '地下 最高階', max: 100 },
  { key: 'heavenMax', label: '天国 最高階', max: 100 },
  { key: 'abyssMax', label: '深淵 最高階', max: 100 },
  { key: 'bossMax', label: 'ボス討伐数', max: 6 },
  { key: 'puzzleStage', label: 'パズル遺跡ステージ', max: 9999 },
  { key: 'digDepth', label: '採掘深度', max: 9999 },
  { key: 'survivalWave', label: 'サバイバルWAVE', max: 999 },
  { key: 'loginStreakBest', label: '最長連続ログイン', max: 3650 },
  // 順位なので 1 が最高。0 は「記録なし」を意味するので下限は 0 のまま。
  { key: 'royaleBest', label: 'ロイヤル最高順位（0=記録なし）', max: 100 },
  { key: 'royaleKills', label: 'ロイヤル通算KO', max: 1_000_000 },
  // 👑 王者撃破の回数。称号 crownfeller/summittaker と実績 ach_champ1/10 が
  // これを毎回読み直して判定するので、事故で消えたときに手で戻せる口が要る。
  { key: 'championWins', label: '王者撃破', max: 1_000_000 },
  // 📊 プレイヤー統計（/api/admin/playerstats）が並べ替えの鍵に使う4つ。
  // 画面に出す数字は、事故で消えたときに運営が戻せないと「表に出したのに
  // 直せない」状態になる ── 出す側と直す側は必ず同時に足すこと。
  // どれも「積み上がるだけのカウンター」で、他の値から計算し直せない
  // （＝derived ではない）ので、ここに置いてよい種類のもの。
  { key: 'logins', label: 'ログイン回数', max: 10_000_000 },
  { key: 'playSecs', label: '累計プレイ時間（秒）', max: 1_000_000_000 },
  { key: 'dailyLogins', label: 'ログインした日数', max: 36_500 },
  { key: 'loginStreak', label: '連続ログイン（現在）', max: 3650 },
  { key: 'totalWins', label: '総勝利数', max: 1_000_000 },
  { key: 'aiWins', label: 'AI戦勝利', max: 1_000_000 },
];

// ADMIN_KNOWN_BADGES（サーバーが配りうるバッジの全一覧）は index.js に置いたまま
// ctx で受け取る。起動時の unlockEverythingForStaff も同じ表を使うので、
// 「サーバーが知っているバッジ」は管理画面の持ち物ではなく共通の語彙。
adminRouter.post('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = userById(req.params.id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  // Repair FIRST, not last: the branches below assume a complete record, and a
  // legacy or restored one could make them throw a 500 or write NaN before the
  // repair at the end of the handler ever ran.
  migrateUser(target);
  const b = req.body || {};
  // `typeof v === 'number'` lets Infinity through — JSON.parse('1e400') is
  // Infinity, and `coins + Infinity` serialises to null, which permanently
  // corrupts that account.
  const delta = (v, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.max(-max, Math.min(max, Math.trunc(v)));
  };
  // これらの「即時適用」系(grant*/権限/パスワード/称号など)は、以前は検証の
  // 直後にその場で target を書き換えていた。ところが後段の set*(絶対値設定)は
  // 「全部検証してから適用」する設計で、後段が1つでも400を投げると、既に
  // 書き換わった grant* の変更がメモリ上の db.users[id] に残り、当該リクエストは
  // 保存されないものの次の saveDb()(他リクエスト)がその半端な変更を焼き付けて
  // しまった(管理者は『エラー＝何も起きていない』と誤認)。そこで即時適用系も
  // 検証だけ先に済ませ、実際の書き換えは applies に積み、set* の検証まで全て
  // 通ってから一括適用する。これで経路全体が set* と同じ「全検証→適用」の
  // 不変条件を満たし、後段の400が grant* を残さない。
  const applies = [];
  // set* の管理者専用チェックは、同じリクエストで role を変えるならその新しい
  // role を見る必要がある(従来は role を即時適用してから set* を検証していた)。
  // 適用を後回しにするので、検証時に見るべき「実効 role」をここで確定しておく。
  const roleValid = ['admin', 'mod', 'user'].includes(b.role);
  const effectiveRole = roleValid ? b.role : target.role;
  if (b.grantCoins !== undefined) {
    const n = delta(b.grantCoins, 1_000_000_000);
    if (n === null) return res.status(400).json({ error: 'コイン付与額が不正です' });
    applies.push(() => { target.coins = Math.max(0, Math.min(1_000_000_000, target.coins + n)); });
  }
  if (b.grantGems !== undefined) {
    const n = delta(b.grantGems, 100_000_000);
    if (n === null) return res.status(400).json({ error: 'ジェム付与額が不正です' });
    applies.push(() => { target.gems = Math.max(0, Math.min(100_000_000, target.gems + n)); });
  }
  // 👑 王座の欠片。イベントの外では増えないので、配れるのは運営だけ。
  // 上限を低めに置いてあるのは、この通貨は「量」ではなく「どこで得たか」に
  // 意味がある通貨だから ── 配りすぎると宝物庫の意味が消える。
  if (b.grantShards !== undefined) {
    const n = delta(b.grantShards, 1_000_000);
    if (n === null) return res.status(400).json({ error: '欠片付与数が不正です' });
    applies.push(() => { target.shards = Math.max(0, Math.min(1_000_000, (target.shards || 0) + n)); });
  }
  if (b.grantItems !== undefined) {
    // grant N of every booster (negative to confiscate)
    const n = delta(b.grantItems, 999);
    if (n === null) return res.status(400).json({ error: 'アイテム付与数が不正です' });
    applies.push(() => {
      target.items = target.items || {};
      for (const it of BOOST_ITEMS) target.items[it.id] = Math.max(0, Math.min(999, (target.items[it.id] || 0) + n));
    });
  }
  if (typeof b.banned === 'boolean') {
    if (target.role === 'admin' && b.banned) return res.status(400).json({ error: '管理者は凍結できません' });
    applies.push(() => {
      target.banned = b.banned;
      if (!b.banned) {
        // 🔓 解除したら、その人のせいで止めた回線も一緒に戻す。戻さないと
        //    「凍結を解いたのに、その家からは誰も新規登録できない」が2週間続く。
        const freed = ctx.clearIpBansFor ? ctx.clearIpBansFor(target.id, target.username) : 0;
        if (freed) console.log(`[ban] ${target.username} の凍結解除に伴い、回線 ${freed}件を戻しました`);
        return;
      }
      // 🚫 回線ごとの凍結。トークンを捨ててゲストとして入り直す道を塞ぐ。
      //    止めるのは「ゲストとしての参加」と「新規登録」だけで、その回線の
      //    **ログイン済みアカウントは素通し**（同じ回線には家族・学校・寮の
      //    別人がいるのがふつう）。2週間で自動失効する。
      //    ⚠ 回線を集めるのは切断より **前**。切ったあとでは socket が
      //      消えていて、いま繋いでいる回線が分からなくなる。
      const fps = new Set();
      if (battleReady && battle && typeof battle.ipFingerprintsOf === 'function') {
        for (const fp of battle.ipFingerprintsOf(target.id)) fps.add(fp);
      }
      if (target.lastIpFp) fps.add(target.lastIpFp);   // 今つないでいなくても効かせる
      const banned = ctx.addIpBans ? ctx.addIpBans([...fps], req.user && req.user.username, target.username, target.id) : 0;
      if (banned) console.log(`[ban] ${target.username} の回線 ${banned}件を2週間ゲスト参加不可にしました`);
      // 🚪 凍結はその場で効かせる。gateSocket は **メッセージを受け取ったとき
      //    にしか** 走らないので、黙って座っている socket は凍結後もそのまま
      //    生きていた ── 進行中の試合は最後まで遊べるし、全体チャットの受信も
      //    続く。開いている口を閉じるところまでが凍結。
      if (battleReady && battle && typeof battle.disconnectUser === 'function') {
        battle.disconnectUser(target.id, 'このアカウントは管理者により凍結されました');
      }
    });
  }
  if (typeof b.muted === 'boolean') {
    if ((target.role === 'admin' || target.role === 'mod') && b.muted) {
      return res.status(400).json({ error: '運営メンバーはミュートできません' });
    }
    applies.push(() => { target.muted = b.muted; });
  }
  if (typeof b.setPassword === 'string') {
    if (b.setPassword.length < 6) return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
    const { salt, hash } = hashPassword(b.setPassword);
    applies.push(() => {
      target.salt = salt;
      target.passHash = hash;
      // force re-login everywhere with the new password
      revokeAllTokens(target.id);
    });
  }
  const KNOWN_BADGES = ADMIN_KNOWN_BADGES;   // 一箇所で管理（編集画面と同じ一覧）
  if (typeof b.grantBadge === 'string') {
    if (!KNOWN_BADGES.includes(b.grantBadge)) return res.status(400).json({ error: `バッジIDが不正です（${KNOWN_BADGES.join(' / ')}）` });
    applies.push(() => { if (!target.badges.includes(b.grantBadge)) target.badges.push(b.grantBadge); });
  }
  if (typeof b.revokeBadge === 'string') {
    applies.push(() => { target.badges = target.badges.filter(x => x !== b.revokeBadge); });
  }
  if (typeof b.setRating === 'number') applies.push(() => { target.stats.rating = Math.max(0, Math.min(5000, Math.floor(b.setRating))); });
  if (typeof b.setLevel === 'number') {
    // levelOf(xp) = 1 + floor(xp/1000)  →  xp for level L is (L-1)*1000
    const lv = Math.max(1, Math.min(999, Math.floor(b.setLevel)));
    applies.push(() => { target.xp = (lv - 1) * 1000; });
  }
  if (roleValid) {
    if (target.id === req.user.id && b.role !== 'admin') {
      return res.status(400).json({ error: '自分の権限は下げられません（別の管理者に依頼してください）' });
    }
    applies.push(() => { target.role = b.role; });
  }
  if (b.resetStats === true) {
    applies.push(() => { target.stats = { gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0, aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000 }; });
  }

  // ---- 🎒 インベントリ編集（絶対値で設定する系） ----
  //
  // The grant* fields above ADD; these SET. Two rules make this safe enough to
  // expose in a browser:
  //
  //  1. VALIDATE EVERYTHING FIRST, then apply. Writing as we validated meant a
  //     later field's 400 left the earlier fields already written to the live
  //     record, and the next saveDb() persisted that half-applied edit while
  //     the admin saw an error and assumed nothing happened.
  //  2. Reject rather than coerce. `Number(null)` is 0, so a stray null in the
  //     JSON used to silently wipe a player's currency and answer ok:true.
  const patch = {};
  const intIn = (v, max, min = 0) => {
    if (typeof v === 'string' ? v.trim() === '' : typeof v !== 'number') return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
  };
  const bad = msg => { throw Object.assign(new Error(msg), { userError: true }); };

  try {
    if (b.setCoins !== undefined) {
      const n = intIn(b.setCoins, 1_000_000_000);
      if (n === null) bad('コインの値が不正です');
      patch.coins = n;
    }
    if (b.setGems !== undefined) {
      const n = intIn(b.setGems, 100_000_000);
      if (n === null) bad('ジェムの値が不正です');
      patch.gems = n;
    }
    // setLevel rounds XP down to the floor of that level, which throws away
    // partial progress — setXp restores the exact value.
    if (b.setXp !== undefined) {
      const n = intIn(b.setXp, 998_000);
      if (n === null) bad('XPの値が不正です');
      patch.xp = n;
    }

    if (b.setItems !== undefined) {
      if (!b.setItems || typeof b.setItems !== 'object' || Array.isArray(b.setItems)) bad('アイテムの指定が不正です');
      const known = new Map(BOOST_ITEMS.map(i => [i.id, i]));
      const next = {};
      for (const [id, v] of Object.entries(b.setItems)) {
        const def = known.get(id);
        if (!def) bad(`不明なアイテムです: ${String(id).slice(0, 32)}`);
        if (def.adminOnly && effectiveRole !== 'admin') bad('管理者専用アイテムは付与できません');
        const n = intIn(v, 999);
        if (n === null) bad(`アイテム個数が不正です: ${id}`);
        if (n > 0) next[id] = n;
      }
      patch.items = next;
    }

    // Owned cosmetics. The defaults are always re-added so a player can never
    // be left with nothing equippable.
    if (b.setOwned !== undefined) {
      if (!Array.isArray(b.setOwned)) bad('所持品の指定が不正です');
      const known = new Map(SHOP_ITEMS.map(i => [i.id, i]));
      for (const id of b.setOwned) {
        const it = known.get(id);
        if (!it) bad(`不明なアイテムです: ${String(id).slice(0, 32)}`);
        if (it.adminOnly && effectiveRole !== 'admin') bad('管理者専用の装備は付与できません');
      }
      patch.owned = [...new Set([...DEFAULT_OWNED, ...b.setOwned])];
    }

    // Equipping something the player does not own renders as a blank board, so
    // this is checked against the owned list AFTER any change in this same
    // request — not the stale one.
    if (b.setEquipped !== undefined) {
      if (!b.setEquipped || typeof b.setEquipped !== 'object' || Array.isArray(b.setEquipped)) bad('装備の指定が不正です');
      const owned = new Set(patch.owned || target.owned || []);
      const next = { ...(target.equipped || {}) };
      for (const [slot, id] of Object.entries(b.setEquipped)) {
        if (!EQUIP_SLOTS.includes(slot)) bad(`不明な装備スロットです: ${String(slot).slice(0, 16)}`);
        const item = SHOP_ITEMS.find(i => i.id === id);
        if (!item || item.cat !== slot) bad(`${slot} に装備できないアイテムです`);
        if (!owned.has(id)) bad('所持していないアイテムは装備できません（先に所持品に追加してください）');
        next[slot] = id;
      }
      patch.equipped = next;
    }

    if (b.setTitle !== undefined) {
      if (b.setTitle === null || b.setTitle === '') patch.equippedTitle = null;
      else if (!TITLES.some(t => t.id === b.setTitle)) bad('不明な称号です');
      else patch.equippedTitle = b.setTitle;
    }

    if (b.setBadges !== undefined) {
      if (!Array.isArray(b.setBadges)) bad('バッジの指定が不正です');
      for (const id of b.setBadges) {
        // 🏛 シーズン刻印バッジ（s3champ 等）はシーズンごとに増えるので、
        // 固定の一覧ではなく形で許可する。ここで弾いていると、殿堂入りした
        // アカウントを編集した瞬間に「不明なバッジです」で保存できなくなる。
        if (!ADMIN_KNOWN_BADGES.includes(id) && !SEASON_BADGE_RE.test(String(id))) {
          bad(`不明なバッジです: ${String(id).slice(0, 32)}`);
        }
      }
      patch.badges = [...new Set(b.setBadges)];
    }

    // A premium battle pass was PAID for with gems, so restoring an account
    // has to be able to give it back. The season is not editable: it must stay
    // whatever currentSeason() says, or syncBattlePass wipes the record.
    if (b.setPass !== undefined) {
      if (!b.setPass || typeof b.setPass !== 'object' || Array.isArray(b.setPass)) bad('バトルパスの指定が不正です');
      const bp = { ...(target.battlePass || {}) };
      if (b.setPass.xp !== undefined) {
        const n = intIn(b.setPass.xp, BP_TIERS.length * BP_XP_PER_TIER);
        if (n === null) bad('バトルパスXPの値が不正です');
        bp.xp = n;
      }
      if (b.setPass.premium !== undefined) {
        if (typeof b.setPass.premium !== 'boolean') bad('プレミアムの指定が不正です');
        bp.premium = b.setPass.premium;
      }
      patch.battlePass = bp;
    }

    if (b.setStats !== undefined) {
      if (!b.setStats || typeof b.setStats !== 'object' || Array.isArray(b.setStats)) bad('統計の指定が不正です');
      const next = {};
      for (const [key, v] of Object.entries(b.setStats)) {
        const def = EDITABLE_STATS.find(s => s.key === key);
        if (!def) bad(`編集できない項目です: ${String(key).slice(0, 32)}`);
        const n = intIn(v, def.max, def.min || 0);
        if (n === null) bad(`${def.label} の値が不正です`);
        next[key] = n;
      }
      patch.stats = next;
    }
  } catch (err) {
    if (err && err.userError) return res.status(400).json({ error: err.message });
    throw err;
  }

  // ---- everything validated: apply ----
  // 即時適用系(grant*/権限/パスワード等)を先に流す。set* の絶対値はこの後に
  // 上書き適用されるので、両方が来たときは従来どおり set* が勝つ。
  for (const fn of applies) fn();
  for (const k of ['coins', 'gems', 'xp', 'items', 'owned', 'equippedTitle', 'badges', 'battlePass']) {
    if (patch[k] !== undefined) target[k] = patch[k];
  }
  if (patch.equipped) target.equipped = patch.equipped;
  if (patch.stats) {
    target.stats = target.stats || {};
    Object.assign(target.stats, patch.stats);
  }

  // Reconcile the equipped-must-be-owned invariant no matter WHICH field moved:
  // dropping an item from the owned list while it was equipped used to leave
  // the player staring at a board that renders nothing.
  target.owned = target.owned || [];
  for (const slot of EQUIP_SLOTS) {
    const cur = target.equipped && target.equipped[slot];
    const item = SHOP_ITEMS.find(i => i.id === cur);
    if (!item || item.cat !== slot || !target.owned.includes(cur)) {
      target.equipped = target.equipped || {};
      target.equipped[slot] = DEFAULT_EQUIPPED[slot];
    }
  }

  // Leave the record in a shape the rest of the server can read.
  migrateUser(target);
  adminLog(req, 'user_edit', target.username, b);
  saveDb();
  // NOT publicUser(): for an admin target that view fakes the entire shop as
  // owned, and echoing it back would let the editor write that fiction in.
  res.json({ ok: true, user: adminUserView(target) });
});

// ---------------------------------------------------------------------------
// 📊 プレイヤー統計 — 「誰が・いつオンラインだったか」を運営が読む面
// ---------------------------------------------------------------------------
//
// 記録そのものは前からあった。lastSeen（最後に接続が切れた時刻）も
// playSecs（累計プレイ秒）も stats.history（直近40戦）も db.json には入って
// いて、ただ **どこからも返していなかった**。運営が「最近この人来てる？」を
// 確かめる手段が db.json を直接開くことしか無い、という状態だったので、
// 集計と一覧をここに1本まとめる。
//
// ⚠ この章の3つの約束
//  1. 全部 /api/admin/* に置き、requireAuth → requireAdmin の順で通す。
//     /api/admin/* は sanitize.js の関門を**経路ごとバイパス**する
//     （secrecyMiddleware の bypass）ので、ここに載せた値は素のまま出る。
//     裏を返すと、この章のハンドラを1本でも /api/admin の外へ動かすと、
//     住人の内訳まで丸ごと非管理者へ漏れる。動かさないこと。
//  2. 住人（AI）と実プレイヤーは **入れ物ごと分ける**。同じ配列に混ぜて
//     行ごとのフラグで区別する形にすると、次に誰かが1行足したときに
//     区別が消える。summary.players / summary.residents の2箱に分ける。
//  3. 一度に全員を返さない。db.users は上限なしに増える（復元の上限だけで
//     8,000件）ので、必ず offset / limit で切る。
//
// 「在席区間」(stats.online = [{at, ms}]) と stats.sessions を積むのは別の
// 担当。まだ入っていない機体でも壊れないよう、読む側は必ず配列かどうかから
// 確かめる。

const PS_LIMIT_DEFAULT = 50;
const PS_LIMIT_MAX = 200;          // 1リクエストで返す行の上限
const PS_ONLINE_KEEP = 120;        // 個人の詳細で返す在席区間の本数
const PS_TREND_DAYS = 14;          // 推移グラフの日数
const PS_MODES_KEEP = 16;          // モード別の内訳で返す行数
const PS_REPORTS_KEEP = 30;        // 個人の詳細に添える通報／バグ報告の件数
const PS_LOG_KEEP = 30;            // 同上・運営の操作ログ
const PS_DAY_MS = 24 * 60 * 60 * 1000;

// JST の日付（'YYYY-MM-DD'）。jstDay() は「JSTの日」の通し番号を返すので、
// その番号 × 1日 を UTC の 0 時として読むと、そのまま JST の日付になる。
function psDayLabel(dayNum) {
  return new Date(dayNum * PS_DAY_MS).toISOString().slice(0, 10);
}

// 在席区間 [{at, ms}] を安全に読む。記録するのは別の担当なので
// 「まだ無い」「壊れている」の両方で落ちない形にしておく。
function psOnlineSpans(u) {
  const raw = u && u.stats && u.stats.online;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const at = Number(s.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    out.push({ at, ms: Math.max(0, Number(s.ms) || 0) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

// 「最後にオンラインだった時刻」。
//
// user.lastSeen は battle.js が **最後の接続が切れたとき** に書く値なので、
// いま繋ぎっぱなしの人は 0 のままでも不思議ではない（一度も切断していない）。
// ログインした時刻・在席区間の終わり・直近の結果送信も突き合わせて、
// いちばん新しいものを採る。これをしないと「今まさに遊んでいる人」や
// 「ログインしただけで一度も遊んでいない人」が一覧の最下段に落ちる。
function psLastOnline(u, spans) {
  const s = (u && u.stats) || {};
  let t = Math.max(
    Number(u.lastSeen) || 0,
    Number(s.lastResultAt) || 0,
    Number(s.lastLoginAt) || 0,
  );
  const last = spans.length ? spans[spans.length - 1] : null;
  if (last) t = Math.max(t, last.at + last.ms);
  return t;
}

// 履歴（stats.history の1件）を読む。index.js の書き込みは
// `{ t, m, s, w }`（時刻／モード／スコア／勝ったか）。
function psHistoryRow(h) {
  if (!h || typeof h !== 'object') return null;
  const t = Number(h.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  return {
    t,
    mode: String(h.m || '?').slice(0, 16),
    score: Math.max(0, Number(h.s) || 0),
    won: !!h.w,
  };
}

// 一覧の1行。数字は全部 Number() を通す ── 復元されたレコードには
// 文字列や undefined が混ざりうるので、並べ替えの鍵に生値を使うと
// 「なぜかこの人だけ先頭に来る」が起きる。
//
// ⚠ ここでは migrateUser を **呼ばない**。一覧は全アカウントぶん回るので、
//    1リクエストで数千件を補修することになる（しかも読むだけの画面が
//    db.users を書き換える）。上の Number() で欠けた欄は全部埋まるので、
//    補修は個人の詳細（1件だけ）に任せる。
function psRow(u, onlineIds) {
  const s = u.stats || {};
  const spans = psOnlineSpans(u);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    banned: !!u.banned,
    muted: !!u.muted,
    createdAt: Number(u.createdAt) || 0,
    lastOnline: psLastOnline(u, spans),
    lastSeen: Number(u.lastSeen) || 0,
    lastLoginAt: Number(s.lastLoginAt) || 0,
    lastDaily: u.lastDaily || null,
    lastResultAt: Number(s.lastResultAt) || 0,
    playSecs: Math.max(0, Number(s.playSecs) || 0),
    gamesPlayed: Math.max(0, Number(s.gamesPlayed) || 0),
    // ログイン回数は v2.37 から数え始めた（server/auth.js の recordLogin）。
    // それ以前からのアカウントは 0 のまま ＝「まだ数えていない」なので、
    // 画面では「—」と出して 0 回と区別すること。
    logins: Math.max(0, Number(s.logins) || 0),
    dailyLogins: Math.max(0, Number(s.dailyLogins) || 0),
    loginStreak: Math.max(0, Number(s.loginStreak) || 0),
    loginStreakBest: Math.max(0, Number(s.loginStreakBest) || 0),
    sessions: Math.max(0, Number(s.sessions) || 0),
    spans: spans.length,
    rating: Math.max(0, Number(s.rating) || 0),
    level: levelOf(Number(u.xp) || 0),
    // 「いま繋いでいるか」は保存された値ではなく生の接続から。
    online: onlineIds.has(u.id),
  };
}

// いま実際に繋いでいる実プレイヤーの userId。battle がまだ立ち上がって
// いない／livePlayers を持たない機体でも空集合で通す。
function psOnlineIds() {
  const ids = new Set();
  try {
    for (const p of (battleReady && battle.livePlayers ? battle.livePlayers() : [])) {
      if (p && p.userId) ids.add(p.userId);
    }
  } catch { /* 接続の集計が取れないだけ。統計そのものは返す */ }
  return ids;
}

// 並べ替えの鍵。ここに無い名前が来たら既定（最終オンライン）に落とす
// ── 任意の文字列でレコードの中を覗けるようにはしない。
//
// ⚠ 素のオブジェクトではなく Map。`?sort=__proto__` を投げられると、
//    オブジェクトの添字引きは Object.prototype（真）を返すので
//    「知らない鍵なのに既定へ落ちない」→ 関数でない値を呼んで 500、になる。
//    Map は継承した名前を持たないので、この一群の事故を形ごと断てる。
const PS_SORTS = new Map([
  ['lastOnline', r => r.lastOnline],
  ['playSecs', r => r.playSecs],
  ['games', r => r.gamesPlayed],
  ['logins', r => r.logins],
  ['streak', r => r.loginStreakBest],
  ['rating', r => r.rating],
  ['createdAt', r => r.createdAt],
  ['level', r => r.level],
  ['name', r => r.username.toLowerCase()],
]);

adminRouter.get('/api/admin/playerstats', requireAuth, requireAdmin, (req, res) => {
  const now = Date.now();
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 32);
  const sortKey = PS_SORTS.has(String(req.query.sort || '')) ? String(req.query.sort) : 'lastOnline';
  const asc = String(req.query.order || '') === 'asc';
  const limit = Math.max(1, Math.min(PS_LIMIT_MAX, Math.floor(Number(req.query.limit)) || PS_LIMIT_DEFAULT));
  const offsetRaw = Math.floor(Number(req.query.offset));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const onlineIds = psOnlineIds();
  const all = Object.values(db.users);

  // 集計は「全員ぶん」で採る（ページを送っても数字が動かないように）。
  // 行の組み立ては絞り込んだあとだけにしたいが、集計にも同じ値が要るので
  // ここで1回だけ作って使い回す。8,000件 × 履歴40件でも一瞬で終わる。
  const rows = all.map(u => psRow(u, onlineIds));

  const dayNow = Math.floor((now + 9 * 3600000) / PS_DAY_MS);
  const signupsByDay = new Map();
  const activeByDay = new Map();     // day -> Set(userId)
  const modeAgg = new Map();         // mode -> { plays, wins, best, total }
  let totalPlaySecs = 0, totalGames = 0, totalLogins = 0;
  let activeToday = 0, activeWeek = 0, activeMonth = 0;
  let newToday = 0, newWeek = 0, newMonth = 0;
  let banned = 0, muted = 0, admins = 0, mods = 0;

  const bump = (map, key) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key);
  };

  for (let i = 0; i < all.length; i++) {
    const u = all[i], r = rows[i];
    totalPlaySecs += r.playSecs;
    totalGames += r.gamesPlayed;
    totalLogins += r.logins;
    if (r.banned) banned++;
    if (r.muted) muted++;
    if (r.role === 'admin') admins++;
    else if (r.role === 'mod') mods++;
    const sinceSeen = now - r.lastOnline;
    if (r.lastOnline > 0) {
      if (sinceSeen < PS_DAY_MS) activeToday++;
      if (sinceSeen < 7 * PS_DAY_MS) activeWeek++;
      if (sinceSeen < 30 * PS_DAY_MS) activeMonth++;
    }
    if (r.createdAt > 0) {
      const age = now - r.createdAt;
      if (age < PS_DAY_MS) newToday++;
      if (age < 7 * PS_DAY_MS) newWeek++;
      if (age < 30 * PS_DAY_MS) newMonth++;
      const d = Math.floor((r.createdAt + 9 * 3600000) / PS_DAY_MS);
      if (dayNow - d < PS_TREND_DAYS) signupsByDay.set(d, (signupsByDay.get(d) || 0) + 1);
    }
    // 日別のアクティブ人数と、モード別の人気。どちらも stats.history が
    // 出どころ（直近40戦しか残っていないので「直近2週間の傾向」までが読める
    // 上限。それ以上を出したいなら履歴の保持数から変えること）。
    const hist = Array.isArray(u.stats && u.stats.history) ? u.stats.history : [];
    for (const raw of hist) {
      const h = psHistoryRow(raw);
      if (!h) continue;
      const d = Math.floor((h.t + 9 * 3600000) / PS_DAY_MS);
      if (dayNow - d < PS_TREND_DAYS && d <= dayNow) bump(activeByDay, d).add(u.id);
      const m = modeAgg.get(h.mode) || { id: h.mode, plays: 0, wins: 0, best: 0, total: 0 };
      m.plays++;
      if (h.won) m.wins++;
      if (h.score > m.best) m.best = h.score;
      m.total += h.score;
      modeAgg.set(h.mode, m);
    }
    // 在席区間があるなら、そちらも「その日いた人」に数える（遊ばずに
    // ログインしただけの日を落とさないため）。
    for (const sp of psOnlineSpans(u)) {
      const d = Math.floor((sp.at + 9 * 3600000) / PS_DAY_MS);
      if (dayNow - d < PS_TREND_DAYS && d <= dayNow) bump(activeByDay, d).add(u.id);
    }
  }

  const trend = [];
  for (let d = dayNow - (PS_TREND_DAYS - 1); d <= dayNow; d++) {
    trend.push({
      day: psDayLabel(d),
      signups: signupsByDay.get(d) || 0,
      actives: (activeByDay.get(d) || new Set()).size,
    });
  }

  const modes = [...modeAgg.values()]
    .sort((a, b) => b.plays - a.plays)
    .slice(0, PS_MODES_KEEP);

  // 🎭 住人（AI）。**実プレイヤーとは別の箱**に入れる。運営には
  // 区別が要る（にぎわいの数字と実際の客足を取り違えると判断を誤る）が、
  // 混ぜて1つの数にすると二度と分けられない。
  const roster = rosterView(now);
  const residents = {
    total: roster.length,
    online: roster.filter(r => r.online).length,
    // 実プレイヤーと当たったぶんの記録を持っている住人の数と、その通算。
    withRecord: roster.filter(r => r.record).length,
    wins: roster.reduce((a, r) => a + (r.record ? r.record.w : 0), 0),
    losses: roster.reduce((a, r) => a + (r.record ? r.record.l : 0), 0),
  };

  const filtered = q ? rows.filter(r => r.username.toLowerCase().includes(q)) : rows;
  const pick = PS_SORTS.get(sortKey);
  const sorted = filtered.slice().sort((a, b) => {
    const av = pick(a), bv = pick(b);
    let c = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
    if (!c) c = a.username.localeCompare(b.username);   // 同点の並びを固定する
    return asc ? c : -c;
  });

  res.json({
    at: now,
    sort: sortKey, order: asc ? 'asc' : 'desc', q,
    offset, limit, limitMax: PS_LIMIT_MAX,
    total: rows.length,
    matched: sorted.length,
    users: sorted.slice(offset, offset + limit),
    summary: {
      // 実プレイヤー（db.users にレコードがある人）だけの数。
      players: {
        total: rows.length, banned, muted, admins, mods,
        online: onlineIds.size,
        activeToday, activeWeek, activeMonth,
        newToday, newWeek, newMonth,
        totalPlaySecs, totalGames, totalLogins,
      },
      residents,
      modes,
      trend,
      trendDays: PS_TREND_DAYS,
      // 履歴は1人40戦までしか残らない。集計の読み方を画面が間違えないよう、
      // 「どこまで遡れるのか」を数字で添える。
      historyKeep: 40,
    },
  });
});

adminRouter.get('/api/admin/playerstats/:id', requireAuth, requireAdmin, (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  migrateUser(u);
  const now = Date.now();
  const s = u.stats || {};
  const onlineIds = psOnlineIds();
  const spans = psOnlineSpans(u);

  // モード別の内訳（この人ぶん）。全体のと同じ形にそろえておくと、
  // 画面が1つの描画関数を使い回せる。
  const modeAgg = new Map();
  const history = [];
  for (const raw of (Array.isArray(s.history) ? s.history : [])) {
    const h = psHistoryRow(raw);
    if (!h) continue;
    history.push(h);
    const m = modeAgg.get(h.mode) || { id: h.mode, plays: 0, wins: 0, best: 0, total: 0 };
    m.plays++;
    if (h.won) m.wins++;
    if (h.score > m.best) m.best = h.score;
    m.total += h.score;
    modeAgg.set(h.mode, m);
  }
  history.reverse();   // 新しい順

  // 🐛 この人が出した通報／バグ報告。db.bugreports は
  // バグ報告・工房通報・パーティー通報が全部落ちる1本の箱。
  //
  // 📌 照合は **ID優先・名前はフォールバック**。表示名だけで引いていたころは、
  //    誰かが改名した瞬間に「その名前を今持っている別人」の履歴として出ていた
  //    （改名は1日1回できるので、狙って他人の通報履歴に化けることもできた）。
  //    byId / targetId は途中から記録し始めた欄なので、それを持たない古い記録は
  //    今までどおり名前で拾う ── ただし **byId が入っていて別人を指している
  //    記録は名前が一致しても拾わない**（そこが改名の穴だった）。
  const ownedBy = (rec, idField) => (rec && rec[idField] ? rec[idField] === u.id : rec && rec.by === u.username);
  const reports = (Array.isArray(db.bugreports) ? db.bugreports : [])
    .filter(b => ownedBy(b, 'byId'))
    .slice(-PS_REPORTS_KEEP).reverse()
    .map(b => ({ id: b.id, at: b.at, status: b.status, text: String(b.text || '').slice(0, 300) }));

  // 🧾 運営がこの人に対して何をしたか（同上。target は表示名、targetId がID）。
  const adminActions = (Array.isArray(db.meta.adminLog) ? db.meta.adminLog : [])
    .filter(l => (l && l.targetId ? l.targetId === u.id : l && l.target === u.username))
    .slice(-PS_LOG_KEEP).reverse()
    .map(l => ({ at: l.at, by: l.by, action: l.action, detail: l.detail }));

  res.json({
    at: now,
    user: adminUserView(u),
    live: {
      online: onlineIds.has(u.id),
      lastOnline: psLastOnline(u, spans),
      lastSeen: Number(u.lastSeen) || 0,
      lastLoginAt: Number(s.lastLoginAt) || 0,
      lastResultAt: Number(s.lastResultAt) || 0,
      lastDaily: u.lastDaily || null,
      playSecs: Math.max(0, Number(s.playSecs) || 0),
      logins: Math.max(0, Number(s.logins) || 0),
      sessions: Math.max(0, Number(s.sessions) || 0),
      dailyLogins: Math.max(0, Number(s.dailyLogins) || 0),
      loginStreak: Math.max(0, Number(s.loginStreak) || 0),
      loginStreakBest: Math.max(0, Number(s.loginStreakBest) || 0),
    },
    // 在席区間（いつからいつまで居たか）。新しい順に PS_ONLINE_KEEP 本まで。
    // 記録が始まる前のアカウントでは空配列で来る ── 画面は「0件」ではなく
    // 「まだ記録がありません」と出すこと（無いのと居なかったのは別）。
    online: spans.slice(-PS_ONLINE_KEEP).reverse(),
    onlineTotal: spans.length,
    history,
    modes: [...modeAgg.values()].sort((a, b) => b.plays - a.plays),
    reports,
    adminActions,
  });
});

adminRouter.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = userById(req.params.id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin') return res.status(400).json({ error: '管理者は削除できません' });
  revokeAllTokens(req.params.id);
  adminLog(req, 'user_delete', target.username, { id: req.params.id });
  leaveGuild(db, target);   // same reason as DELETE /api/me — before the record goes
  unfriendAll(db, target);  // フレンド側も同じ（DELETE /api/me と同じ理由）
  if (battleReady && battle.party) battle.party.ejectUser(target.id);
  // 🧩 UGC と履歴の後始末。DELETE /api/me もこの同じ1本を呼ぶ
  // （purgeUserContent のコメント参照）。
  purgeUserContent(target.id, target.username);
  if (Object.prototype.hasOwnProperty.call(db.users, String(req.params.id))) delete db.users[String(req.params.id)];
  db.deleted[req.params.id] = Date.now();
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 🚫 回線ごとの凍結の一覧と解除
// ---------------------------------------------------------------------------
// 凍結の副作用として自動で積まれるので、**運営が中身を見られないと解除できない**
// （誤って家庭の回線を止めてしまったときに戻す手段が無い、が最悪）。
// 出すのは指紋の先頭だけ。指紋そのものを画面に流しても意味が無いうえ、
// /api/admin/* は秘匿の関門を経路ごとバイパスするので、出す量は必要最小限にする。
adminRouter.get('/api/admin/ipbans', requireAuth, requireAdmin, (req, res) => {
  if (ctx.sweepIpBans) ctx.sweepIpBans();
  const t = (ctx.ipBansTable ? ctx.ipBansTable() : {});
  const rows = Object.entries(t).map(([fp, r]) => ({
    id: fp,
    short: fp.slice(0, 8),
    at: r && r.at ? r.at : null,
    until: r && r.until ? r.until : null,
    by: r && r.by ? r.by : null,
    target: r && r.target ? r.target : null,
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
  res.json({ bans: rows });
});

adminRouter.delete('/api/admin/ipbans/:id', requireAuth, requireAdmin, (req, res) => {
  const t = (ctx.ipBansTable ? ctx.ipBansTable() : {});
  const id = String(req.params.id || '');
  if (id === 'all') {
    const n = Object.keys(t).length;
    for (const k of Object.keys(t)) delete t[k];
    adminLog(req, 'ipban_clear_all', null, { count: n });
    saveDb();
    return res.json({ ok: true, removed: n });
  }
  if (!Object.prototype.hasOwnProperty.call(t, id)) {
    return res.status(404).json({ error: 'その回線凍結は見つかりません' });
  }
  const rec = t[id];
  delete t[id];
  adminLog(req, 'ipban_clear', rec && rec.target ? rec.target : id.slice(0, 8), {});
  saveDb();
  res.json({ ok: true, removed: 1 });
});

// Force a brand-new season starting now (everyone's battle pass resets — that
// is the point of this button). Implemented as an override generation bump so
// it survives redeploys via the backup's meta.
adminRouter.post('/api/admin/season/new', requireAuth, requireAdmin, (req, res) => {
  const cur = currentSeason();
  const idx = derivedSeasonIndex();
  const o = db.meta.seasonOverride || {};
  db.meta.seasonOverride = {
    baseIndex: idx,
    gen: (o.gen || 0) + 1,
    numberOffset: (cur.number + 1) - idx,
    name: sanitizeName(req.body.name) || null,
    startedAt: Date.now(),
    endsAt: Date.now() + SEASON_MS,
  };
  saveDb();
  // 🧾 全員のバトルパスが飛ぶ操作なので必ず残す（adminLog が saveDb もする）。
  adminLog(req, 'season_new', db.meta.seasonOverride.name || null, {
    number: currentSeason().number, gen: db.meta.seasonOverride.gen,
  });
  res.json({ season: currentSeason() });
});

// Change the current season — supports reverting the number/name WITHOUT
// resetting everyone's battle pass progress (keepProgress, default true).
adminRouter.post('/api/admin/season/set', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const cur = currentSeason();
  const number = Math.max(1, Math.min(999, Math.floor(Number(b.number) || cur.number)));
  const name = sanitizeName(b.name) || null;
  const days = Math.max(1, Math.min(365, Math.floor(Number(b.days) || 0)));
  const keepProgress = b.keepProgress !== false;
  const effIdx = Number(cur.id.slice(1).split('-')[0]) || derivedSeasonIndex();
  const o = db.meta.seasonOverride || {};
  db.meta.seasonOverride = {
    baseIndex: effIdx,
    gen: (o.gen || 0) + (keepProgress ? 0 : 1),
    numberOffset: number - effIdx,
    name,
    startedAt: keepProgress ? (o.startedAt || cur.startedAt) : Date.now(),
    // Only pin an endsAt when the admin actually chose a duration — otherwise
    // stay on the natural 30-day grid so seasons keep rolling on schedule.
    endsAt: b.days ? Date.now() + days * 24 * 60 * 60 * 1000 : (keepProgress ? (o.endsAt || null) : Date.now() + SEASON_MS),
  };
  saveDb();
  // 🧾 keepProgress:false は全員のバトルパスを飛ばす。どちらにせよ世界に効く。
  adminLog(req, 'season_set', name, { number, days: b.days ? days : null, keepProgress });
  res.json({ season: currentSeason(), progressKept: keepProgress });
});

// Reset competitive stats for all users (scores, ratings, PvP records).
adminRouter.post('/api/admin/leaderboard/reset', requireAuth, requireAdmin, (req, res) => {
  adminLog(req, 'leaderboard_reset', null, {});
  let count = 0;
  for (const u of Object.values(db.users)) {
    u.stats.bestScore = 0;
    u.stats.totalScore = 0;
    u.stats.rating = 1000;
    u.stats.pvpWins = 0;
    u.stats.pvpLosses = 0;
    count++;
  }
  saveDb();
  res.json({ ok: true, affected: count });
});

// 💾 バックアップと復元は同じ天井を共有しなければならない。
//
// /api/admin/restore は本文が RESTORE_LIMIT_MB を超えていたら**読む前に**
// 413 で落とす。ダンプ側にはその制限が無かったので、db が育つほど
// 「自分で取ったバックアップを自分で戻せない」状態に静かに入り、しかも
// それに気づくのは復旧が必要になった当日だった。
// そこで書き出し側にも同じ天井を持たせ、越えるときだけ「消えても作り直せる／
// 無くても世界が壊れない」塊から順に落として、必ず戻せるファイルにする。
//
// 値は server/index.js の RESTORE_LIMIT_MB と同じ。あちらが ctx に載せたら
// 自動でそれに追従する（載っていない間は同じ既定値を使う）。
const BACKUP_LIMIT_MB_DEFAULT = 4;
function restoreLimitBytes() {
  const mb = Number(ctx.RESTORE_LIMIT_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : BACKUP_LIMIT_MB_DEFAULT) * 1024 * 1024;
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Full database backup download.
adminRouter.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="block-blitz-backup-${stamp}.json"`);
  // Stamp the dump so the restore dialog can show when it was taken.
  // meta は作り直した器なので、ここから消しても live の db.meta は動かない
  // （入れ子を削るときだけ、その階層も作り直している）。
  const dump = { ...db, meta: { ...db.meta, backupAt: Date.now(), backupVersion: BACKUP_VERSION } };
  // 🧾 取引の書庫（transactions-*.jsonl）。TX_KEEP を越えて db.transactions から
  // 書庫へ移った過去の購入明細は db に無いので、これまでバックアップに一切
  // 入らず、復元すると古い購入履歴だけが永久に消えていた。ここで新しい順に
  // 最大2000件を同梱し、復元側(backup.js)がアーカイブへ追記マージする。
  // 売上の合計金額・件数は db.meta.revenueTotal / revenueCount が別に保持して
  // いるので、この明細が(下の天井調整で)落ちても金額表示は狂わない。
  try {
    const arch = archivedTransactions(2000);
    if (arch.length) dump.txArchive = arch;
  } catch (err) {
    console.error('[backup] 取引の書庫を読めませんでした:', err.message);
  }
  // 🧾 結果送信の冪等キーの控え（db.meta.resultRuns）は**無条件に落とす**。
  //   復元側は必ず捨てる（backup.js の META_NOT_RESTORED）ので、積んでも
  //   ダンプが最大0.6MB 太るだけの純粋な無駄。しかも中身は
  //   `${userId}:${runId}` の一覧＝「誰がいつ何回遊んだか」なので、
  //   持ち出す理由が無いなら持ち出さないほうがよい。
  //   ⚠ 下の天井調整（over() で削っていく列）より**前**に置くこと。
  //     容量に余裕があるときだけ残す、では意味が無い。
  if (dump.meta && dump.meta.resultRuns != null) delete dump.meta.resultRuns;

  const limit = restoreLimitBytes();
  let body = JSON.stringify(dump);
  const fullBytes = Buffer.byteLength(body);
  const dropped = [];
  const over = () => Buffer.byteLength(body) > limit;

  // 🎞 その日のゴーストリプレイ。今日と昨日ぶんしか持たず2日で自動的に消える
  // 見せ物で、落ちてもスコア・報酬・ストリークには一切効かない。
  if (over() && dump.meta.dailyReplays != null) {
    delete dump.meta.dailyReplays;
    dropped.push('dailyReplays');
    body = JSON.stringify(dump);
  }
  // 💥 クライアントのJSエラー。障害調査用のログで、世界の状態ではない。
  if (over() && dump.meta.clientErrors != null) {
    delete dump.meta.clientErrors;
    dropped.push('clientErrors');
    body = JSON.stringify(dump);
  }
  // 🧾 取引の書庫（過去の購入明細）。合計金額・件数は db.meta.revenue* が
  // 別に保持しているので、明細が落ちても売上表示は狂わない。明細はまとまった
  // 大きさになりうるので、ログ類の次・工房データより先に外す。
  if (over() && dump.txArchive != null) {
    delete dump.txArchive;
    dropped.push('txArchive');
    body = JSON.stringify(dump);
  }
  // ❤️ 工房の「いいね済み」名簿。二重いいねを止めている唯一の記録なので、
  // 他を削っても足りないときの最後の手段。♡の数は表示用に残す。
  if (over() && isObj(dump.meta.workshop) && isObj(dump.meta.workshop.stages)) {
    const stages = {};
    let n = 0;
    for (const [code, s] of Object.entries(dump.meta.workshop.stages)) {
      if (isObj(s) && Array.isArray(s.likedBy) && s.likedBy.length) {
        const { likedBy, ...rest } = s;
        stages[code] = { ...rest, likes: Math.max(Number(s.likes) || 0, likedBy.length) };
        n += likedBy.length;
      } else stages[code] = s;
    }
    if (n) {
      dump.meta.workshop = { ...dump.meta.workshop, stages };
      dropped.push('workshop.likedBy');
      body = JSON.stringify(dump);
    }
  }

  if (dropped.length) {
    // ファイル自身にも「何を落としたか」を残す（復元側は backup.js の
    // META_NOT_RESTORED で読み捨てるので、db には入らない）。
    dump.meta.backupTrimmed = { at: Date.now(), dropped, fullBytes, limitBytes: limit };
    body = JSON.stringify(dump);
  }
  const bytes = Buffer.byteLength(body);
  // 気づける状態にしておく。天井の8割を越えたら（＝削らずに済んでいても）
  // 運営ログに残す ── ここが唯一の早期警告になる。
  if (dropped.length || bytes > limit * 0.8 || fullBytes > limit * 0.8) {
    adminLog(req, 'backup', null, {
      bytes, fullBytes, limitBytes: limit,
      dropped: dropped.length ? dropped.join(',') : 'なし',
      overLimit: bytes > limit,
    });
  }
  res.setHeader('X-Backup-Bytes', String(bytes));
  res.setHeader('X-Backup-Limit-Bytes', String(limit));
  if (dropped.length) res.setHeader('X-Backup-Trimmed', dropped.join(','));
  res.type('application/json').send(body);
});

// Restore a backup file. Defaults to a merge so players who signed up after a
// data loss are not thrown away; the live DB is snapshotted first either way.
// Two ways in: a logged-in admin, OR anyone holding the backup file who can
// prove they know the admin password *inside that backup*. The second path is
// what makes a post-wipe restore painless — after a redeploy the fresh
// instance has a brand-new admin password nobody knows yet.
adminRouter.post('/api/admin/restore', (req, res) => {
  const body = req.body || {};
  const data = body.data || body;          // accept a bare dump or { data, mode }
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const check = validateBackup(data);
  if (!check.ok) return res.status(400).json({ error: check.error });

  // Authorisation, in three tiers.
  //
  // This endpoint is deliberately reachable without a session: the whole point
  // of /?restore=1 is to recover a server nobody can log into. But it used to
  // accept ANY uploaded file whose own admin hash matched the typed password —
  // and the attacker supplies that file, so they supply the hash too. Anyone
  // who could reach the URL could overwrite a live server with a forged dump.
  //
  //   1. a signed-in admin                          → always allowed
  //   2. the password of a LIVE admin account       → allowed
  //   3. the password of the FILE's admin           → only onto a server with
  //      no player data yet, and merge only. That is exactly the post-deploy
  //      wipe this flow exists for, and it is worthless to an attacker because
  //      there is nothing there to take over.
  let actor = req.user && req.user.role === 'admin' ? { username: req.user.username } : null;
  // ファイル内パスワードで通した復元では、生きているアカウントの
  // パスワード・権限をファイル側に奪わせない（下の applyRestore へ渡す）。
  let protectLiveCredentials = false;
  if (!actor) {
    if (!rateLimit(`restore:${req.ip}`, 10, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
    }
    const pw = String(body.password || '');
    if (!pw) return res.status(401).json({ error: '管理者パスワードを入力してください' });

    const liveAdmins = Object.values(db.users).filter(u => u.role === 'admin').slice(0, 8);
    const liveMatch = liveAdmins.find(u => verifyPassword(pw, u.salt, u.passHash));
    if (liveMatch) {
      actor = { username: liveMatch.username };
    } else {
      // 🔒 第3層は「まだ誰も居ないサーバー」専用。
      //
      // 上のコメントはずっとそう書いてあったのに、その判定がコードに存在して
      // いなかった。実際に効いていたのは mode !== 'merge' だけで、稼働中の
      // 本番に対しても第3層が通っていた。ファイル内のパスワードは
      // **アップロードする側が決められる**ので、これは事実上「誰でも通る認証」
      // だった。監査で、未認証の1リクエストで管理者アカウントを奪取できることが
      // 実サーバー上で再現されている。
      //
      // この経路が本当に必要なのは「再デプロイでデータが飛び、誰もログイン
      // できないサーバーを復旧する」場面だけ。そこにはまだ守るべきものが無い。
      const realPlayers = Object.values(db.users).filter(u => u.role !== 'admin').length;
      if (realPlayers > 0) {
        console.warn(`[restore] 拒否(第3層/稼働中): ip=${req.ip} 既存プレイヤー${realPlayers}人`);
        return res.status(401).json({
          error: 'このサーバーには既にプレイヤーデータがあります。現在の管理者パスワードを入力してください',
        });
      }

      // 照合1回につき pbkdf2 が約13ms かかり、その間サーバーは他の処理を
      // 一切できない（Node は1本の処理列で動く）。管理者を大量に詰めた
      // ファイルを1回投げるだけで数分〜十数分の完全停止を作れた。
      // 正規のバックアップに管理者が何十人も入ることはないので、頭を打たせる。
      const fileAdmins = Object.values(data.users).filter(u => u.role === 'admin').slice(0, 8);
      const fileMatch = fileAdmins.find(u => verifyPassword(pw, u.salt, u.passHash));
      // `replace` destroys whatever is live. Doing that needs the CURRENT
      // password, not one supplied inside the file being uploaded.
      if (!fileMatch || mode !== 'merge') {
        console.warn(`[restore] 拒否: ip=${req.ip} mode=${mode} fileMatch=${!!fileMatch}`);
        return res.status(401).json({ error: !fileAdmins.length
          ? 'このバックアップに管理者アカウントが含まれていません'
          : mode !== 'merge'
            ? '置き換え復元には現在の管理者パスワードが必要です（マージ復元は可能です）'
            : 'バックアップ内の管理者パスワードが違います（バックアップを取った時点のパスワードを入力してください）' });
      }
      actor = { username: fileMatch.username, fromBackup: true };
      // The password that authorised this came out of the uploaded file, so the
      // uploader controls it — and therefore must not be able to hand
      // themselves staff.
      //
      // 以前は「この機体に既に居るスタッフと同じ名前なら降格しない」だったが、
      // 管理者名は公開情報（クレジット画面・チャットの🛡️）なので、
      // その名前を騙るだけで admin のまま取り込ませることができた。
      // ファイル由来の昇格は一切認めない — 例外を作らない。
      let demoted = 0;
      for (const u of Object.values(data.users)) {
        if (u.role === 'admin' || u.role === 'mod') { u.role = 'user'; demoted++; }
      }
      if (demoted) console.warn(`[restore] バックアップ内の管理者/モデレーター ${demoted}件を一般ユーザーとして取り込みました`);
      // 生きているアカウントの資格情報を、ファイル側で上書きさせない。
      // merge の勝敗判定(progressOf)は進行度で決まるので、巨大な stats を
      // 積んだ偽レコードを送れば本物に勝ててしまう。ここで守る。
      protectLiveCredentials = true;
    }
  }

  // Dry run: let the admin see what would happen before committing.
  // 下見。以前は管理者名（誰のパスワードが当たったか）まで返していたので、
  // 未ログインからパスワードの当たり判定と管理者名の両方を引き出せた。
  // 名前は返さず、記録も残す。
  if (body.dryRun) {
    adminLog(req, 'restore-dryrun', actor.username, { mode, fromBackup: !!actor.fromBackup, users: check.stats.users });
    return res.json({ preview: check.stats, mode });
  }

  adminLog(req, 'restore', actor.username, { mode, fromBackup: !!actor.fromBackup, users: check.stats.users });
  const snap = snapshot(db, 'pre-restore');
  let report;
  // applyRestore は db をその場で書き換える。途中で落ちると「変更は保存されて
  // いません」と返しながら、実際には半分マージされた db がメモリに残り、次の
  // saveDb() でそれがディスクに焼かれてしまう。丸ごと退避してから実行する。
  const rollback = structuredClone(db);
  // ロールバックの内側には「db を書き換えうる処理」を全部入れる。
  // applyRestore だけを囲っていたころ、そのすぐ下の migrateUser / healSocial /
  // adoptLegacySeason が同じ db を触っているのに保護の外にあった。壊れた
  // レコード（例: stats が文字列）が1件混ざるだけで migrateUser が投げ、
  // 上のコメントが警告しているとおりの事故 ──「保存されていません」と返し
  // ながら半端にマージされた db がメモリに残り、次の saveDb() でディスクへ ──
  // がそのまま起きていた。
  try {
    report = applyRestore(db, data, mode, { protectLiveCredentials });
    // Every restored account is brought up to the current schema right away.
    for (const u of Object.values(db.users)) migrateUser(u);
    // 🤝 復元のあとは必ず均す。名前で照合したときに id が入れ替わるので、
    // 付け替えの取りこぼし・片側だけになった関係・消えた相手への申請が残る。
    // 起動時に一度やるだけでは、復元で作った歪みはその起動の間ずっと残る。
    healSocial(db);
    // Battle passes minted under the old UUID-season scheme carry over, and the
    // restored world state (crowd scale, ambient config) takes effect now.
    adoptLegacySeason(data.season);
    db.season = null;
  } catch (err) {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, rollback);          // db.js が同じ参照を握っているので in-place で戻す
    console.error('[restore] failed:', err);
    return res.status(500).json({ error: '復元中にエラーが発生しました。変更は保存されていません' });
  }
  setLiveScale(db.meta.popScale ?? 1);
  setCustom(db.meta.ambient);
  // 書けたかどうかを見る。以前は戻り値を捨てていたので、ディスクに1バイトも
  // 書けていなくても「💾 データを復元しました」と返していた。メモリ上は
  // 復元済みなので画面は正しく見えるが、次の再起動で全部消える ── 復元を
  // する場面はたいてい「一度データを失った直後」なので、これがいちばん
  // 誤解させてはいけない場所だった。
  if (!flushDb()) {
    console.error('[restore] メモリには適用したが保存に失敗:', lastPersistError());
    return res.status(500).json({
      error: `復元はメモリ上に適用しましたが、ディスクに保存できませんでした（${lastPersistError() || '原因不明'}）。この状態で再起動すると失われます`,
      report,
    });
  }
  console.log(`[restore] ${mode} by ${actor.username}${actor.fromBackup ? ' (backup password)' : ''}: +${report.added} 更新${report.updated} 維持${report.kept} → 合計${report.after}人`);
  battle.broadcastAll({
    type: 'announce',
    message: 'データを復元しました。ページを再読み込みすると反映されます',
    messageEn: 'Data restored — reload the page to see it',
    from: actor.username,
  });
  // 第3層（ファイル内の管理者パスワードで通す復旧経路）では、絶対にトークンを
  // 発行しない。
  //
  // ここは以前「復元した管理者アカウントでそのままログインさせる」親切をして
  // いた。ところが第3層で照合しているパスワードは **アップロードした側が自分で
  // 決めたもの**（ファイルの中の salt/passHash）なので、実質「誰でも名乗れる」。
  // プレイヤー0人のサーバー（＝再デプロイ直後）に、管理者名を騙る偽レコードを
  // 1件入れた未認証リクエストを投げるだけで、有効期限1年の管理者トークンが
  // 手に入っていた。監査で実機再現済み — そのまま /api/admin/backup を叩けば
  // 全ユーザーの salt+passHash が抜ける。
  //
  // 復旧の目的は「データを戻すこと」であって「ログインさせること」ではない。
  // 正規の持ち主は、戻したあとログイン画面から現在の管理者パスワードで入れる
  // （同名で衝突した管理者の資格情報は、生きている側＝この機体のものが残る）。
  // relogin: 復旧経路で来た人に「もう一度ログインしてください」と出すための印。
  res.json({ report, snapshot: snap, source: check.stats, token: null, user: null, relogin: !!actor.fromBackup });
});

// Local snapshots (same instance only — they die with the filesystem too).
adminRouter.get('/api/admin/snapshots', requireAuth, requireAdmin, (_req, res) => {
  res.json({ snapshots: listSnapshots() });
});

adminRouter.post('/api/admin/snapshots/restore', requireAuth, requireAdmin, (req, res) => {
  const data = readSnapshot(String(req.body.name || ''));
  if (!data) return res.status(404).json({ error: 'スナップショットが見つかりません' });
  const check = validateBackup(data);
  if (!check.ok) return res.status(400).json({ error: check.error });
  // 戻り値を捨てない。撮れなかったとき（ディスクが一杯・権限が無い等）に
  // 黙って進むと、「巻き戻したが、その前の状態はもうどこにも無い」という
  // 取り返しのつかない状態になる。画面に警告を出せるよう応答に載せる。
  const snap = snapshot(db, 'pre-rollback');
  // /api/admin/restore と同じ理由で丸ごと退避する。applyRestore は db を
  // その場で書き換えるので、途中で落ちると半端な db がメモリに残り、
  // 次の saveDb() でディスクに焼かれる。この経路だけ保護が無かった。
  const rollback = structuredClone(db);
  let report;
  try {
    report = applyRestore(db, data, 'replace');
    for (const u of Object.values(db.users)) migrateUser(u);
    // 🤝 復元のあとは必ず均す（下の2か所と同じ理由）。
    healSocial(db);
  } catch (err) {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, rollback);        // db.js が同じ参照を握っているので in-place で戻す
    console.error('[snapshot-restore] failed:', err);
    return res.status(500).json({ error: '復元中にエラーが発生しました。変更は保存されていません' });
  }
  adoptLegacySeason(data.season);
  db.season = null;
  setLiveScale(db.meta.popScale ?? 1);
  setCustom(db.meta.ambient);
  // 🧾 DB丸ごとの巻き戻し。/api/admin/restore と同じ破壊力なのに、こちらだけ
  // 無記録だった。記録は **適用後** に置く ── replace は db.meta ごと差し替わる
  // ので、先に積んだ行はそのまま消える（この直後の flushDb でディスクへ）。
  adminLog(req, 'snapshot_restore', String(req.body.name || ''), {
    users: check.stats.users, snapshot: snap || null,
  });
  if (!flushDb()) {
    console.error('[snapshot-restore] メモリには適用したが保存に失敗:', lastPersistError());
    return res.status(500).json({
      error: `復元はメモリ上に適用しましたが、ディスクに保存できませんでした（${lastPersistError() || '原因不明'}）。この状態で再起動すると失われます`,
      report,
    });
  }
  res.json({ report, snapshot: snap });
});

adminRouter.post('/api/admin/snapshots/create', requireAuth, requireAdmin, (_req, res) => {
  const name = snapshot(db, 'manual');
  if (!name) return res.status(500).json({ error: 'スナップショットの作成に失敗しました' });
  res.json({ name, snapshots: listSnapshots() });
});

// Maintenance mode: blocks play/shop/login for non-admins.
adminRouter.post('/api/admin/maintenance', requireAuth, requireAdmin, (req, res) => {
  db.meta.maintenance = !!req.body.on;
  saveDb();
  // 🧾 全プレイヤーの締め出し。「昨日誰が入れっぱなしにしたか」を追える形に。
  adminLog(req, 'maintenance', db.meta.maintenance ? 'on' : 'off', { on: db.meta.maintenance });
  battle.broadcastAll({
    type: 'announce',
    message: db.meta.maintenance ? 'まもなくメンテナンスを開始します' : 'メンテナンスが終了しました',
    messageEn: db.meta.maintenance ? 'Maintenance is starting shortly' : 'Maintenance is over',
    from: req.user.username,
  });
  res.json({ maintenance: db.meta.maintenance });
});

// 🧾 管理者操作の履歴（新しい順）
adminRouter.get('/api/admin/log', requireAuth, requireAdmin, (_req, res) => {
  const log = (db.meta.adminLog || []).slice().reverse();
  res.json({ log, max: ADMIN_LOG_MAX });
});

// 🔧 更新の準備 — 進行中の対戦を引き分けで終わらせ、ソロの人に保存を促す。
// デプロイ時は SIGTERM で自動的に同じ処理が走るが、Windows のように信号が
// 届かない環境や、push の前に手動で人を逃がしたいときのために残してある。
adminRouter.post('/api/admin/prepare-update', requireAuth, requireAdmin, (_req, res) => {
  const ended = battle.endAllForShutdown();
  console.log(`[shutdown] 管理者操作で${ended}件の対戦を終了しました`);
  res.json({ ok: true, ended });
});

// ---------------------------------------------------------------------------
// マッチングの状況（管理者専用）
//
// ■ なぜここに移したか
// マッチング画面から「あと N 秒で対戦相手が見つかります」「このモードで
// 待っている人: N人」を消した。プレイヤー側では、外れた予告が「壊れている」
// に見えるうえ、人数がそのまま「誰が本物か」の手がかりにもなる。
// ただし**運営には必要な数字**（並んでいるのに成立していないのか、そもそも
// 誰も並んでいないのか、席が埋まるまでどれだけ余裕があるのか）なので、
// 消すのではなくこちらへ移す。
//
// ■ 絶対に管理者以外へ出さないこと
// ・この1本にも requireAuth + requireAdmin を必ず付ける（他の /api/admin/* と同じ並び）。
// ・/api/admin/* は server/sanitize.js の関門を **経路ごとバイパス** する
//   （secrecyMiddleware の bypass）。つまりここで返した値は一切削られない。
// ・だから住人（にぎわい）の数は実プレイヤーと同じ器に入れない。混ざったまま
//   別の画面へ流用されると、そこから正体が漏れる。キーを最初から分けてある。
// ---------------------------------------------------------------------------

// キューの id → 画面に出す名前。battle.js の queues と同じ7本。
const MM_MODES = [
  ['duel', '1on1'], ['attack', 'アタック'], ['team', 'チーム戦'],
  ['raid', 'レイド'], ['tourney', 'トーナメント'], ['royale', 'バトルロイヤル'],
  ['coop', '協力プレイ'],
];

// battle.js（別担当）が queueBreakdown() を持っていればそれを使う。
// 形のゆらぎ（配列 / { mode: [entry] } / { mode: 人数 }）はここで吸収する。
// 持っていない間は null を返し、呼び出し側が「取れる範囲」で組み立てる。
function mmBreakdown() {
  const fn = battle && typeof battle.queueBreakdown === 'function' ? battle.queueBreakdown : null;
  if (!fn) return null;
  let raw = null;
  try { raw = fn(); } catch { return null; }
  if (!raw) return null;
  const out = new Map();
  const take = (id, value) => {
    if (!id) return;
    if (typeof value === 'number') { out.set(String(id), { waiting: Math.max(0, value | 0), entries: [] }); return; }
    const list = Array.isArray(value) ? value : Array.isArray(value && value.entries) ? value.entries : [];
    const entries = list.filter(Boolean).map(e => ({
      name: String(e.name || e.username || '—').slice(0, 24),
      // 秒。どちらもサーバーが持っている値をそのまま（ms で来たら秒に直す）。
      waited: Math.max(0, Math.round(Number(e.waited ?? e.waitedSec ?? (Number(e.since) ? (Date.now() - e.since) / 1000 : 0)) || 0)),
      matchInSec: Math.max(0, Math.round(Number(e.matchInSec ?? (Number(e.botAt) ? (e.botAt - Date.now()) / 1000 : 0)) || 0)),
      rating: Number.isFinite(Number(e.rating)) ? Number(e.rating) : null,
      guest: !!(e.guest ?? (e.userId === null || e.userId === undefined ? undefined : false)),
    }));
    const n = Number.isFinite(Number(value && value.waiting)) ? Number(value.waiting) : entries.length;
    out.set(String(id), { waiting: Math.max(0, n), entries });
  };
  if (Array.isArray(raw)) for (const row of raw) take(row && (row.mode || row.id), row);
  else if (typeof raw === 'object') for (const [k, v] of Object.entries(raw)) take(k, v);
  return out.size ? out : null;
}

adminRouter.get('/api/admin/matchmaking', requireAuth, requireAdmin, (_req, res) => {
  const detail = mmBreakdown();

  // 進行中の試合はモード別に数えられる（match.mode を持っている）。
  const matchesByMode = {};
  let activeMatches = 0;
  try {
    for (const m of battle.matches.values()) {
      if (!m || m.ended) continue;
      activeMatches++;
      const k = String(m.mode || 'other');
      matchesByMode[k] = (matchesByMode[k] || 0) + 1;
    }
  } catch { activeMatches = battle.matches ? battle.matches.size : 0; }

  const modes = MM_MODES.map(([id, label]) => {
    const d = detail ? detail.get(id) : null;
    return {
      id, label,
      waiting: d ? d.waiting : null,          // null = まだ内訳が取れない
      entries: d ? d.entries : [],
      matches: matchesByMode[id] || 0,
    };
  });
  // 上の7本に無いモード（ルーム発・管理者イベント等）の試合も落とさない。
  for (const [k, n] of Object.entries(matchesByMode)) {
    if (!MM_MODES.some(([id]) => id === k)) modes.push({ id: k, label: k, waiting: null, entries: [], matches: n });
  }

  // 内訳が取れないときの控え: いま「待機中」の実プレイヤーだけは livePlayers()
  // から分かる（ただしモードも待ち秒も分からない。接続からの分だけ）。
  const waitingPlayers = detail ? [] : (() => {
    try {
      return (battle.livePlayers ? battle.livePlayers() : [])
        .filter(p => p.where === 'queue')
        .map(p => ({ name: p.name, minutes: p.minutes, guest: !!p.guest, rating: p.rating ?? null }));
    } catch { return []; }
  })();

  res.json({
    at: Date.now(),
    // 内訳（モード別・待ち秒・成立までの秒）が取れているか。false のときは
    // 画面に「まだ取れない」と出す ── 0 と「不明」を同じ顔で出さないため。
    detailed: !!detail,
    totals: {
      // 実プレイヤーの待機総数（全7キュー）。
      queueing: typeof battle.queueSize === 'function' ? battle.queueSize() : null,
      activeMatches,
      openRooms: battle.rooms ? battle.rooms.size : 0,
      online: battle.clients ? battle.clients.size : 0,
    },
    // ⚠ 住人の数はキーを分ける。実プレイヤーの数と足した値は返さない。
    crowd: { queueing: ambientQueue(), activeResidents: battle.crowd ? battle.crowd.activeCount() : 0 },
    modes,
    waitingPlayers,
  });
});

// ---------------------------------------------------------------------------
// 👀 いま誰がオンラインか（管理者専用）
//
// ■ なぜ要るのか
// これまで運営が見られたのは「オンライン人数」という数字だけで、しかもそれは
// 住人（にぎわい）を足した表示用の数だった。実際に誰が来ているのか・その人が
// 何をしているのかは、どの画面からも分からなかった。
//
// ■ 出すもの（ユーザーの指定）
//   ・名前 … 実プレイヤーと住人の別も（**管理者にだけ**）
//   ・接続してからの時間 … いつ繋いだか（since）と経過（ms）
//   ・いま何をしているか … メニュー／マッチング待ち（モード・待ち秒）／
//     対戦中（モード・経過秒）／ルームで待機（合言葉）／観戦中／断罪の席
//
// ■ 分からないこと（画面にもそう書く）
//   ソロ・タイムアタック・工房などの1人用は、遊んでいる最中にサーバーへ
//   何も送らない（知るのは POST /api/result の1回だけ）。だから
//   「メニュー」と「ソロで遊んでいる」は原理的に区別できない。
//   対戦画面の2本目（role:'battle'）が開いているかだけは分かるので、
//   そこは「対戦画面」として別に出す。
//
// ■ 絶対に管理者以外へ出さないこと
//   ・requireAuth + requireAdmin を必ず付ける（他の /api/admin/* と同じ並び）。
//   ・/api/admin/* は server/sanitize.js の関門を経路ごとバイパスする。
//     つまりここで返した値は一切削られない。
//   ・住人の席は players と**別の入れ物**（residents）に入れる。混ぜた1本の
//     配列にすると、この行を誰かが非管理者の画面へ持って行った瞬間に
//     正体ごと漏れる（プレイヤー統計が summary.players / summary.residents を
//     分けているのと同じ理由）。
// ---------------------------------------------------------------------------

// 一度に返す行数。人数が増えたときに応答が膨れないよう必ず頭を押さえる。
const ONLINE_LIMIT_DEFAULT = 100;
const ONLINE_LIMIT_MAX = 500;

// act（battle.js が返す状態の id）→ 画面の言葉と、人単位にまとめるときの重み。
// 重みが大きいほど「具体的」── 同じ人が複数タブで繋いでいるとき、いちばん
// 具体的な状態をその人の状態にする（チャット用の1本が menu でも、もう1本が
// 対戦中なら「対戦中」と出す）。
const ONLINE_ACTS = new Map([
  ['menu', { w: 0, label: 'メニュー' }],
  ['online', { w: 1, label: '対戦画面' }],
  ['queue', { w: 2, label: 'マッチング待ち' }],
  ['room', { w: 3, label: 'ルームで待機' }],
  ['room_watch', { w: 4, label: 'ルームで観戦中' }],
  ['royale_watch', { w: 4, label: '観戦中（脱落）' }],
  ['zero_watch', { w: 4, label: '断罪を観戦中' }],
  ['tourney', { w: 5, label: 'トーナメント進行中' }],
  ['match', { w: 6, label: '対戦中' }],
  ['zero', { w: 6, label: '断罪の席' }],
]);

// モード id → 画面の言葉。MM_MODES に無いもの（ルーム発の陣取り・断罪）も拾う。
const ONLINE_MODE_LABEL = new Map([
  ...MM_MODES,
  ['land', '陣取り'], ['zero', '断罪'], ['boss', 'ボス'], ['dungeon', 'ダンジョン'],
]);
const onlineModeLabel = m => (m ? ONLINE_MODE_LABEL.get(String(m)) || String(m) : null);

// battle.js が返す1件を、画面がそのまま出せる形に直す。
// ⚠ 知らない act は「不明」に落とす（勝手に埋めない）── 運営が
//    「分かっていないこと」と「メニューに居ること」を取り違えないため。
function onlineActView(a) {
  if (!a || typeof a !== 'object') return { act: 'unknown', label: '不明', detail: '' };
  const meta = ONLINE_ACTS.get(String(a.act));
  if (!meta) return { act: 'unknown', label: '不明', detail: '' };
  const mode = onlineModeLabel(a.mode);
  const bits = [];
  if (mode) bits.push(mode);
  if (a.act === 'queue' && Number.isFinite(Number(a.waited))) bits.push(`${Math.max(0, Math.round(Number(a.waited)))}秒待機`);
  if (a.act === 'match' && Number.isFinite(Number(a.secs))) bits.push(`経過${Math.max(0, Math.round(Number(a.secs)))}秒`);
  if (a.tourney) bits.push('トーナメント戦');
  if (a.room) bits.push(`合言葉 ${String(a.room).slice(0, 12)}`);
  if (a.host) bits.push('ホスト');
  if (a.seat === 'watch') bits.push('観戦席');
  if (Number.isFinite(Number(a.round))) bits.push(`${Math.max(1, Math.round(Number(a.round)))}回戦`);
  return { act: String(a.act), label: meta.label, mode: a.mode || null, detail: bits.join(' ・ ') };
}

// 数字の欄。「無い（ゲストなのでアカウントが無い）」と「0」を混ぜない。
const onlineNum = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// 同じ人の複数接続から「いちばん具体的な状態」を1つ選ぶ。
function pickAct(acts) {
  let best = null, bestW = -1;
  for (const a of Array.isArray(acts) ? acts : []) {
    const meta = ONLINE_ACTS.get(String(a && a.act));
    const w = meta ? meta.w : -1;
    if (w > bestW) { bestW = w; best = a; }
  }
  return onlineActView(best);
}

adminRouter.get('/api/admin/online', requireAuth, requireAdmin, (req, res) => {
  const now = Date.now();
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 32);
  const limit = Math.max(1, Math.min(ONLINE_LIMIT_MAX, Math.floor(Number(req.query.limit)) || ONLINE_LIMIT_DEFAULT));
  // 住人は既定で「試合に座っている席」だけ出す。ロビーで喋っているだけの住人は
  // にぎわい倍率しだいで数百人になるので、見たいときだけ crowd=1 で足す。
  const withCrowd = String(req.query.crowd || '') === '1';
  // 実プレイヤーだけを見たいとき（人数が多いときの絞り込み）。
  const only = ['players', 'residents'].includes(String(req.query.only || '')) ? String(req.query.only) : 'all';

  let raw = null;
  if (battleReady && battle && typeof battle.onlineBreakdown === 'function') {
    try { raw = battle.onlineBreakdown(); } catch { raw = null; }
  }
  // battle がまだ立ち上がっていない機体でも 200 で通す（画面が落ちない）。
  const src = raw || { at: now, sockets: 0, players: [], seats: [] };

  const hit = name => !q || String(name || '').toLowerCase().includes(q);

  const allPlayers = (src.players || []).filter(Boolean).map(p => {
    const a = pickAct(p.acts);
    return {
      name: String(p.name || '—').slice(0, 24),
      userId: p.userId || null,
      guest: !!p.guest,
      role: p.role || null,
      admin: !!p.admin,
      // ⚠ null を Number() に通さないこと。Number(null) は 0 なので
      //    Number.isFinite が真になり、アカウントの無いゲストが
      //    「Lv.0 ・ R0」と表示される（＝レベル0・レート0の人が居るように見える）。
      //    無いものは無いまま null で返し、画面が欄ごと出さないようにする。
      level: onlineNum(p.level),
      rating: onlineNum(p.rating),
      games: onlineNum(p.games),
      // 接続本数（同じ人の複数タブ／端末をまとめた数）。
      conns: Math.max(1, Number(p.conns) || 1),
      // 接続してからの時間。since は「その人のいちばん古い接続」。
      since: Number(p.since) || null,
      ms: Math.max(0, Number(p.ms) || 0),
      ...a,
    };
  });
  const players = allPlayers.filter(p => hit(p.name)).sort((a, b) => a.since - b.since);

  // --- 住人（**運営だけに見せる**） -----------------------------------------
  // 席に座っている住人。接続時間は無い（socket を持たないので、そもそも
  // 「いつ繋いだか」が存在しない）。画面では「—」と出す。
  const seatRows = (src.seats || []).filter(Boolean).map(s => ({
    name: String(s.name || '—').slice(0, 24),
    ...onlineActView(s),
    since: null, ms: null, conns: null,
  }));
  // ロビーに居るだけの住人（にぎわい）。crowd=1 のときだけ。
  const lobbyRows = withCrowd ? (() => {
    try {
      const seatedNames = new Set(seatRows.map(r => r.name));
      return activeResidents(now)
        .filter(r => r && !seatedNames.has(r.name))
        .map(r => ({ name: String(r.name).slice(0, 24), act: 'menu', label: 'ロビー', mode: null, detail: '', since: null, ms: null, conns: null }));
    } catch { return []; }
  })() : [];
  const allResidents = [...seatRows, ...lobbyRows];
  const residentRows = allResidents.filter(r => hit(r.name));

  res.json({
    at: now,
    // 実際に開いている WebSocket の本数（人数ではない）。
    sockets: Number(src.sockets) || 0,
    // 内訳が取れたか。false のときは画面に「まだ取れない」と出す
    // ── 0人と「分からない」を同じ顔で出さないため。
    detailed: !!raw,
    totals: {
      // 人単位。ゲストも含む実プレイヤー。
      people: allPlayers.length,
      guests: allPlayers.filter(p => p.guest).length,
      conns: allPlayers.reduce((a, p) => a + p.conns, 0),
      // ⚠ 住人の数は実プレイヤーと足さない。別のキーのまま出す。
      // battle 側は席の配列に上限を掛けているので、本当の席数は seatTotal から。
      residentSeats: Number.isFinite(Number(src.seatTotal)) ? Number(src.seatTotal) : seatRows.length,
      residentLobby: lobbyRows.length,
      crowdActive: (() => { try { return battle.crowd ? battle.crowd.activeCount() : 0; } catch { return 0; } })(),
    },
    // 絞り込み前の件数（「200人中50人を表示」と出せるように）。
    matched: { players: players.length, residents: residentRows.length },
    limit, q, crowd: withCrowd, only,
    players: only === 'residents' ? [] : players.slice(0, limit),
    residents: only === 'players' ? [] : residentRows.slice(0, limit),
    // 画面に出す注意書き。「分からないこと」を運営が読み違えないように、
    // 文面もサーバー側に置いて1か所にしておく。
    caveats: [
      'ソロ・タイムアタックなどの1人用は、遊んでいる最中にサーバーへ何も送らないので「メニュー」と区別できません。',
      '住人（AI）に接続時間はありません（socket を持たないため）。',
    ],
  });
});

adminRouter.post('/api/admin/broadcast', requireAuth, requireAdmin, async (req, res) => {
  const message = String(req.body.message || '').slice(0, 200);
  if (!message) return res.status(400).json({ error: 'メッセージが空です' });
  // /api/admin/news already auto-translates; a broadcast did not, so English
  // players got a raw Japanese banner. An explicit messageEn always wins.
  let messageEn = String(req.body.messageEn || '').slice(0, 200) || null;
  if (!messageEn) {
    try {
      const tr = await translateChat(message);
      if (tr && tr.lang === 'en' && tr.text) messageEn = tr.text;
    } catch { /* dictionary fallback failed — ship the original */ }
  }
  battle.broadcastAll({ type: 'announce', message, messageEn, from: req.user.username });
  // 🧾 運営名義で全員に届いた文面。何を流したかが残らないと後から追えない。
  adminLog(req, 'broadcast', null, { message: message.slice(0, 80) });
  res.json({ ok: true, delivered: battle.clients.size });
});

// ---------------------------------------------------------------------------
// Moderator API (mods + admins): chat policing tools only
// ---------------------------------------------------------------------------

adminRouter.get('/api/mod/users', requireAuth, requireMod, (_req, res) => {
  const users = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, role: u.role, muted: !!u.muted, banned: !!u.banned,
  }));
  res.json({ users });
});

adminRouter.post('/api/mod/mute', requireAuth, requireMod, (req, res) => {
  const target = userById(req.body.id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin' || target.role === 'mod') {
    return res.status(400).json({ error: '運営メンバーはミュートできません' });
  }
  target.muted = !!req.body.muted;
  saveDb();
  // 🧾 モデレーターの処分行為。mod 権限は付与できるのに、mod にできる処分だけ
  // 無記録なのは非対称だった（chat/clear も同じ理由で下に残している）。
  adminLog(req, 'mute', target.username, { muted: target.muted });
  res.json({ ok: true, muted: target.muted });
});

adminRouter.post('/api/mod/chat/clear', requireAuth, requireMod, (req, res) => {
  battle.chatOps.clear();
  adminLog(req, 'chat_clear', 'mod', {});
  res.json({ ok: true });
});

// Gift coins/gems to every active (non-banned) account at once.
adminRouter.post('/api/admin/grant-all', requireAuth, requireAdmin, (req, res) => {
  const coins = Math.max(0, Math.min(1_000_000, Math.floor(Number(req.body.coins) || 0)));
  const gems = Math.max(0, Math.min(100_000, Math.floor(Number(req.body.gems) || 0)));
  if (!coins && !gems) return res.status(400).json({ error: 'コインかジェムを指定してください' });
  adminLog(req, 'grant_all', null, { coins, gems });
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.banned) continue;
    u.coins += coins;
    u.gems += gems;
    affected++;
  }
  saveDb();
  // 通貨は日英それぞれ言葉で書く。以前は 🪙/💎 の絵文字を1本の文字列にして
  // 日英どちらにも差し込んでいたが、この文面はクライアントで textContent に
  // 入るので絵は出せず、端末によって別の絵にもなる。
  const partsJa = [coins ? `${coins}コイン` : '', gems ? `${gems}ジェム` : ''].filter(Boolean).join(' ');
  const partsEn = [coins ? `${coins} coins` : '', gems ? `${gems} gems` : ''].filter(Boolean).join(' ');
  battle.broadcastAll({
    type: 'announce',
    message: `運営から全員に ${partsJa} をプレゼント！（再ログインまたは画面更新で反映）`,
    messageEn: `A gift for everyone from the team: ${partsEn}! (relog or refresh to receive)`,
    from: req.user.username,
  });
  res.json({ ok: true, affected, coins, gems });
});

// Live crowd (にぎわい) control: scale, chattiness, custom names & lines.
// One-click crowd moods.
const CROWD_PRESETS = {
  off:    { scale: 0 },
  quiet:  { scale: 0.5, chatPace: 0.5, toggles: { ...DEFAULT_TOGGLES, dialogues: false, greetings: false }, quiet: null },
  normal: { scale: 1,   chatPace: 1,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  party:  { scale: 3,   chatPace: 2.5, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  fever:  { scale: 25,  chatPace: 3.5, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 住人が増え続ける上限は ×88（MAX_ROSTER）。それより上は表示人数だけが伸びる。
  mega:   { scale: 88,  chatPace: 4,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  ultra:  { scale: 500, chatPace: 4,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  night:  { scale: 0.7, chatPace: 0.75, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  silent: { scale: 1,   chatPace: 1,   toggles: { ...DEFAULT_TOGGLES, chat: false, dialogues: false, feed: false, greetings: false, reactions: false }, quiet: null },

  // --- 性格プリセット（v2.16 追加） ------------------------------------------
  // 上の9つは「どれだけ賑わっているか」を1本の軸で並べたもの。ここから下は
  // **同じ人口でも空気が違う世界**をトグルの組み合わせで作る。倍率だけを
  // 増やしても「同じ世界が濃くなる」だけで、雰囲気の作り分けはできなかった。
  //
  // toggles は9項目すべてを明示すること。1つでも欠けると setCustom が
  // その項目を「現状維持」にするので、直前のプリセットの設定が残り、
  // 同じボタンを押しても押す順番で結果が変わる（＝再現しない）。
  // quiet の from/to は JST の「時」。null で静かな時間帯そのものを無効化する。

  // 🌅 人の出入りは多いが誰も腰を据えない朝。挨拶だけが流れる。
  commute:  { scale: 1.5, chatPace: 0.5,  toggles: { ...DEFAULT_TOGGLES, dialogues: false }, quiet: null },
  // 🏆 主役はランキングとギルド。雑談は絞り、対戦とフィードで場を持たせる。
  eve:      { scale: 8,   chatPace: 0.75, toggles: { ...DEFAULT_TOGGLES, dialogues: false, greetings: false }, quiet: null },
  // 🌃 人数は少ないのに1人1人がよく喋る、明け方の濃い空気。
  dawn:     { scale: 0.35, chatPace: 3,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 👀 人口は多いのに誰も対戦しない。フィードだけが流れる観戦者の街。
  spectate: { scale: 12,  chatPace: 2,    toggles: { ...DEFAULT_TOGGLES, chat: false, dialogues: false, greetings: false, bots: false }, quiet: null },
  // 🎆 賑わいの余韻。結果は流れ続けるが新しい会話は始まらない。
  afterparty: { scale: 5, chatPace: 0.35, toggles: { ...DEFAULT_TOGGLES, chat: false, dialogues: false }, quiet: null },
  // 🌍 日本の日中を静かな時間帯にして、夜型・海外時間の世界にする。
  overseas: { scale: 2,   chatPace: 1.25, toggles: { ...DEFAULT_TOGGLES }, quiet: { from: 9, to: 18 } },
  // 🤖 チャット系を全部落とし、対戦相手とランキングだけを生かす。
  arena:    { scale: 4,   chatPace: 1,    toggles: { ...DEFAULT_TOGGLES, chat: false, dialogues: false, feed: false, greetings: false, reactions: false, votes: false }, quiet: null },
  // 🏰 ギルドとランキングを前に出した週末の抗争ムード。
  guildwar: { scale: 20,  chatPace: 1.5,  toggles: { ...DEFAULT_TOGGLES, dialogues: false, greetings: false }, quiet: null },
  // 📺 配信映え。チャットは出るが被らず、フィードと反応で画面が動く。
  stream:   { scale: 6,   chatPace: 1.5,  toggles: { ...DEFAULT_TOGGLES, dialogues: false }, quiet: null },
  // 🌸 ゆっくりした会話と多めの挨拶。休日の昼下がり。
  sunday:   { scale: 2,   chatPace: 0.5,  toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // ⚡ 人口は普段どおりなのに会話だけが限界速度。瞬間最大風速。
  gust:     { scale: 1,   chatPace: 8,    toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 🐣 開店直後。ロビーには人がいるが、ランキング・対戦・ギルドは実プレイヤーだけ。
  opening:  { scale: 0.2, chatPace: 0.75, toggles: { ...DEFAULT_TOGGLES, ghosts: false, bots: false, votes: false, guilds: false }, quiet: null },
  // 🧑 記録は人間だけのもの。ロビーは賑やかなまま、住人を成績から外す。
  humanonly:{ scale: 1.5, chatPace: 1,    toggles: { ...DEFAULT_TOGGLES, ghosts: false, bots: false, votes: false, guilds: false }, quiet: null },
  // 🏢 深夜〜朝は完全に静か。日中だけ動く「営業時間」の世界。
  officehours: { scale: 3, chatPace: 1.25, toggles: { ...DEFAULT_TOGGLES }, quiet: { from: 0, to: 9 } },
  // 🗳️ 投票と反応が主役の住民集会。対戦ボットは引っ込める。
  townhall: { scale: 6,   chatPace: 2,    toggles: { ...DEFAULT_TOGGLES, greetings: false, bots: false }, quiet: null },
  // 🔍 動作確認用。住人を最少にしたまま9機能すべてオン＋会話は最速。
  // ×0.2 より下げても住人は減らない（popFactor の下限 0.3 で頭打ち）のに、
  // 表示人数だけが落ちて「表示12人／住人13人オンライン」という
  // ありえない並びになる。住人が最少になる範囲でいちばん高い倍率を選ぶ。
  debug:    { scale: 0.2, chatPace: 8,    toggles: { ...DEFAULT_TOGGLES }, quiet: null },

  // --- 拡張した範囲を使うプリセット（v2.29 追加） -----------------------------
  // 人口倍率は 0.1〜500、チャット頻度は 0.1〜16 まで刻めるようになったので、
  // これまで「最大」と「最小」で頭打ちだった両端に段を足す。

  // 🫧 いるのは分かるが誰も喋らない。深夜の作業通話のような距離感。
  ghosttown: { scale: 0.1,  chatPace: 0.1,  toggles: { ...DEFAULT_TOGGLES, dialogues: false, greetings: false }, quiet: null },
  // 🐣 開店直後。人はまばらだが、来た人には必ず挨拶が飛ぶ。
  cozy:      { scale: 0.75, chatPace: 1.5,  toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 🏙️ 平日夕方の駅前。人は多いが1人あたりは静か。
  rushhour:  { scale: 20,   chatPace: 0.75, toggles: { ...DEFAULT_TOGGLES, dialogues: false }, quiet: null },
  // 🎊 全部を最大に振り切る。動作確認と「見せる」用。
  carnival:  { scale: 120,  chatPace: 12,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 💥 上限の上限。負荷の当たりを見るための極端値（常用しないこと）。
  overload:  { scale: 500,  chatPace: 16,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 🌍 世界規模。表示だけが伸びる帯（住人の実数は 600 で頭打ちなので負荷は同じ）。
  world:     { scale: 1000, chatPace: 8,    toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 🌎 100万人。数字を見せるためのプリセット。
  million:   { scale: 2000, chatPace: 10,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
};

function crowdStatus() {
  return {
    scale: getLiveScale(), ambient: getCustom(),
    online: battle.displayOnline(), activeMatches: battle.displayMatches(),
    mood: crowdMood(), activeResidents: battle.crowd.activeCount(), quietNow: isQuietNow(),
  };
}

adminRouter.post('/api/admin/pop', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.preset && CROWD_PRESETS[b.preset]) {
    const p = CROWD_PRESETS[b.preset];
    b.scale = p.scale;
    if (p.chatPace !== undefined) patch.chatPace = p.chatPace;
    if (p.toggles) patch.toggles = p.toggles;
    if (p.quiet !== undefined) patch.quiet = p.quiet;
  }
  if (b.scale !== undefined) {
    const scale = Math.max(0, Math.min(MAX_LIVE_SCALE, Number(b.scale)));
    if (!Number.isFinite(scale)) return res.status(400).json({ error: `0〜${MAX_LIVE_SCALE}の数値で指定してください` });
    db.meta.popScale = scale;
    setLiveScale(scale);
  }
  if (b.chatPace !== undefined) patch.chatPace = b.chatPace;
  if (Array.isArray(b.names)) patch.names = b.names;
  if (Array.isArray(b.lines)) patch.lines = b.lines;
  if (b.toggles && typeof b.toggles === 'object') patch.toggles = b.toggles;
  if (b.quiet !== undefined) patch.quiet = b.quiet;

  // Cast management.
  const cur = getCustom();
  if (typeof b.removeResident === 'string' && b.removeResident) {
    patch.removed = [...new Set([...cur.removed, b.removeResident])];
  }
  if (typeof b.restoreResident === 'string' && b.restoreResident) {
    // 退役中の住人の名前は「空き」として扱われる（管理者が外した名前を永久に
    // 塞ぎ続けないため）。その隙にプレイヤーがその名前を取っていることがあるので、
    // 戻す前に必ず確かめる ── 確かめずに戻すと、同名の住人が湧いて
    // なりすまし状態が再発する。addResident が既にやっているのと同じ検査。
    const back = retiredResidents().find(r => r.id === b.restoreResident);
    if (back && Object.values(db.users).some(u => u.username.toLowerCase() === back.name.toLowerCase())) {
      return res.status(409).json({ error: `「${back.name}」は実在するプレイヤーが使っています。この住人は戻せません` });
    }
    patch.removed = (patch.removed || cur.removed).filter(id => id !== b.restoreResident);
  }
  if (b.addResident && typeof b.addResident.name === 'string') {
    const name = sanitizeName(b.addResident.name);
    if (name.length < 2) return res.status(400).json({ error: '住人の名前は2文字以上にしてください' });
    if (Object.values(db.users).some(u => u.username.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: '実在するプレイヤーと同じ名前は使えません' });
    }
    if (cur.extra.some(x => x.name === name)) return res.status(409).json({ error: 'その住人はすでにいます' });
    patch.extra = [...cur.extra, { name, arch: String(b.addResident.arch || 'casual'), lang: b.addResident.lang === 'en' ? 'en' : 'ja' }];
  }
  if (typeof b.removeExtra === 'string' && b.removeExtra) {
    patch.extra = (patch.extra || cur.extra).filter(x => x.name !== b.removeExtra);
  }
  if (b.reseed) {
    patch.rosterSeed = `v${Date.now().toString(36)}`;
    // 名簿を引き直すと600人の名前が総入れ替えになる。名前の予約表は
    // 「登録・改名・名乗り」のときにしか働かないので、**名簿のほうが後から
    // 変わる**この経路だけは、ここで衝突を潰しておく必要がある。
    // removed を空にするのは正しい（idの意味が変わるため）が、空にしたまま
    // だと実プレイヤーと同名の住人がそのまま生まれる。
    patch.removed = clashingResidentIds(patch.rosterSeed, Object.values(db.users).map(u => u.username));
    if (patch.removed.length) {
      console.log(`[residents] 名簿の引き直しで実プレイヤーと同名になった住人${patch.removed.length}人を退役させました`);
    }
  }

  if (Object.keys(patch).length) {
    setCustom(patch);
    db.meta.ambient = getCustom();   // persist the sanitized version
  }
  saveDb();
  // 🧾 にぎわい設定。とくに reseed は住人600人を総入れ替えする（＝世界の見た目が
  // 別物になる）ので、いつ誰が引き直したかが残らないと後から説明できない。
  adminLog(req, 'crowd_pop', b.preset || null, {
    scale: b.scale !== undefined ? db.meta.popScale : undefined,
    reseed: b.reseed ? true : undefined,
    addResident: b.addResident && b.addResident.name ? String(b.addResident.name).slice(0, 24) : undefined,
    removeResident: b.removeResident || undefined,
    restoreResident: b.restoreResident || undefined,
    removeExtra: b.removeExtra || undefined,
  });
  // Scale / ghost-toggle / roster changes alter throne ELIGIBILITY — recompute
  // now, or the 5s memo serves a stale champion map to the next request.
  refreshThrones(true);
  res.json(crowdStatus());
});

// The cast, with live stats, for the admin roster editor.
adminRouter.get('/api/admin/residents', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    residents: rosterView(),
    retired: retiredResidents(),
    archetypes: ARCHETYPES.map(a => ({ id: a.id, label: a.label, labelEn: a.labelEn })),
    status: crowdStatus(),
  });
});

// Fire one crowd action right now (admin preview).
adminRouter.post('/api/admin/crowd/test', requireAuth, requireAdmin, (req, res) => {
  const what = String(req.body.what || 'line');
  const out = battle.crowd.test(what);
  if (out.error) return res.status(409).json({ error: out.error });
  res.json(out);
});

// Wipe the global chat for everyone (history + connected clients).
adminRouter.post('/api/admin/chat/clear', requireAuth, requireAdmin, (req, res) => {
  battle.chatOps.clear();
  adminLog(req, 'chat_clear', 'admin', {});
  res.json({ ok: true });
});

// Make an AI player speak (given text, or a random line when empty).
adminRouter.post('/api/admin/chat/say', requireAuth, requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  const entry = battle.chatOps.say(text || undefined);
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// 📜 断罪録 ── メニューからいつでも読める公開アーカイブ。
//
// その日ゼロが何を誰に向けて言ったかが、実名つきで時系列に残る。
// 次の枠の人はこれを読んでから戦場に入る。ログインは要らない ——
// 「自分の名前が世界の歴史に載る」ので、誰でも読めることに意味がある。
adminRouter.get('/api/zero/chronicle', (_req, res) => {
  const run = db.meta.adminEventRun;
  if (!run || run.modeId !== 'zero') return res.json({ run: null });
  res.json({
    run: {
      dayKey: run.dayKey,
      dan: (run.dan | 0) + 1,
      broken: run.broken || [],
      // 慰霊碑: その日消えた住人と、誰の取りこぼしで消えたか
      fallen: (run.fallen || []).map(x => ({ name: x.name, at: x.at })),
      wills: run.wills || [],
      log: (run.log || []).slice(-200),
    },
  });
});

// 👁️ 憑依 ── 管理者ゼロの口から、るみまきさんが打った言葉をそのまま出す。
//
// ゼロの自動台詞は必ず尽きる。同じ台詞を2回目に見た瞬間にキャラクターは
// 死ぬので、生の言葉が入る口を先に用意しておく。実装はほぼ無いのに、
// 「今日のゼロ、なんか喋りが違う」が起きるのはこちら。
//
// 名前は RESERVED_NAMES で予約してあるので、他人がゼロを騙ることはできない。
adminRouter.post('/api/admin/zero/say', requireAuth, requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: '言わせたい言葉を入力してください' });
  // 英訳を添えられる（省略可）。ゼロは日英どちらの画面にも出る。
  const tr = String(req.body.en || '').trim().slice(0, 300) || undefined;
  const entry = battle.zero.say(text, tr);
  adminLog(req, 'zero-say', battle.zero.name, { text: text.slice(0, 80) });
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// 台詞テーブルから喋らせる（動作確認用）。
adminRouter.post('/api/admin/zero/speak', requireAuth, requireAdmin, (req, res) => {
  const kind = String(req.body.kind || 'verdict');
  const dan = Math.max(0, Math.min(6, Math.floor(Number(req.body.dan) || 0)));
  const entry = battle.zero.speak(kind, dan, {
    you: String(req.body.you || req.user.username).slice(0, 24),
    name: String(req.body.name || '').slice(0, 24) || undefined,
    n: Number(req.body.n) || undefined,
    dan: dan + 1,
    seed: Date.now(),
  });
  if (!entry) return res.status(400).json({ error: `そんな台詞は無い: ${kind}` });
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// Test tools: instantly finish the caller's own mission board / achievements.
adminRouter.post('/api/admin/missions/complete', requireAuth, requireAdmin, (req, res) => {
  migrateUser(req.user);
  const ms = syncMissions(req.user, currentWeekNum());
  for (const row of [...ms.daily, ...ms.weekly]) row.p = Number.MAX_SAFE_INTEGER;
  saveDb();
  res.json({ missions: missionsView(req.user, currentWeekNum()), user: publicUser(req.user) });
});

adminRouter.post('/api/admin/achievements/reset', requireAuth, requireAdmin, (req, res) => {
  migrateUser(req.user);
  req.user.achievements = [];
  saveDb();
  res.json({ achievements: achievementsView(req.user), user: publicUser(req.user) });
});
