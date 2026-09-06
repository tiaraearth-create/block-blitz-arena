// 🛒 ショップまわり — 💎ジェム購入（Stripe）／🏷 日替わりセール／🎁 本日のギフト
//    ／🎒 ブースター／🎰 ガチャ／👑 王座の欠片ショップ／装備の着せ替え。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存（db・publicUser など index.js のモジュールスコープにしか無いもの）は
// server/context.js 経由で受け取る。向きは index.js → context → ここ の一方向。
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {
  saveDb, DATA_DIR,
} from '../db.js';
import {
  requireAuth, requireAdmin,
} from '../auth.js';
import {
  SHOP_ITEMS, BOOST_ITEMS, EQUIP_SLOTS, GEM_PACKS, THRONE_ITEMS,
} from '../catalog.js';
import {
  eventBonus,
} from '../events.js';
import {
  jstDayKey, SHARD as AE_SHARD, throneMax as aeThroneMax,
} from '../adminevent.js';
import {
  nextJstMidnight,
} from '../daily.js';
import { enName } from '../../public/js/catalog-en.js';   // ライブフィード/ギフトの英語名
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, migrateUser, fmtNum, publicUser, postRealFeed, rateLimit, currentEvent, GEMDROP_DAILY_CAP;
export function initShopRoutes() {
  ({ db, migrateUser, fmtNum, publicUser, postRealFeed, rateLimit, currentEvent, GEMDROP_DAILY_CAP } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const purchaseRouter = express.Router();
export const shopRouter = express.Router();
export const throneShopRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gem purchases (DEMO payment — no real money is charged)
// ---------------------------------------------------------------------------

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeEnabled = () => STRIPE_KEY.length > 0;

purchaseRouter.get('/api/gempacks', (_req, res) => {
  res.json({ packs: GEM_PACKS, mode: stripeEnabled() ? 'stripe' : 'coming_soon' });
});

// db.transactions は無上限に伸びる唯一の配列。db.json は保存のたびに丸ごと
// 書き直すので、放っておくと1件買われるたびに全履歴を JSON 化するコストが
// 増え続ける（そして保存が遅くなるほど、書いている途中で落ちる窓が広がる）。
// 一定数を超えたら古い分を DATA_DIR/transactions-YYYY.jsonl へ追記し、
// db の中には直近 TX_KEEP 件だけ残す。
const TX_KEEP = 200;
// ローテーションで db から外した extId の控え。Stripe の webhook 重複判定は
// db.transactions を見ているので、これが無いと「古い取引が書庫に移ったあとに
// 同じ webhook が再送されると二重に付与される」穴が開く。
const TX_EXTID_KEEP = 500;

function rotateTransactions() {
  try {
    if (!Array.isArray(db.transactions) || db.transactions.length <= TX_KEEP) return;
    db.meta = db.meta || {};
    const old = db.transactions.slice(0, db.transactions.length - TX_KEEP);
    // 取引は時系列で積まれるので、年ごとの塊は必ず連続する。先頭から順に
    // 書き、書けたぶんだけ db から外す ── 途中で失敗しても、二重に書庫入り
    // する取引は出ない（次回そこから再開する）。
    const groups = [];
    for (const t of old) {
      const y = new Date(Number(t && t.at) || Date.now()).getFullYear();
      const last = groups[groups.length - 1];
      if (last && last.year === y) last.rows.push(t);
      else groups.push({ year: y, rows: [t] });
    }
    let moved = 0;
    for (const g of groups) {
      const file = path.join(DATA_DIR, `transactions-${g.year}.jsonl`);
      const text = g.rows.map(t => JSON.stringify(t)).join('\n') + '\n';
      try {
        fs.appendFileSync(file, text);
      } catch (err) {
        console.error(`[tx] ${path.basename(file)} に書けません:`, err.message);
        break;   // ここから先は db に残したまま、次の機会に再挑戦する
      }
      moved += g.rows.length;
    }
    if (moved <= 0) return;
    const archived = old.slice(0, moved);
    // 売上は db から消えるので meta に移す。ここを忘れると管理画面の売上が
    // ローテーションのたびに減って見える。
    db.meta.revenueTotal = (db.meta.revenueTotal || 0) + archived.reduce((a, t) => a + (Number(t && t.jpy) || 0), 0);
    db.meta.revenueCount = (db.meta.revenueCount || 0) + archived.length;
    const ext = (db.meta.txExtIds || []).concat(archived.map(t => t && t.extId).filter(Boolean));
    db.meta.txExtIds = ext.slice(-TX_EXTID_KEEP);
    db.transactions = db.transactions.slice(moved);
    console.log(`[tx] 取引 ${moved} 件を書庫に移しました（残り ${db.transactions.length} 件）`);
  } catch (err) {
    // ここで投げると購入処理そのものが 500 になる。書庫は補助なので握りつぶす。
    console.error('[tx] ローテーションに失敗:', err.message);
  }
}

// 書庫（transactions-YYYY.jsonl）の読み戻し。
//
// 書き出す口（rotateTransactions）だけがあって読む口がどこにも無かったので、
// TX_KEEP を超えて書庫に移った取引は「管理画面から消えた ＝ どこにも無い」に
// 見えていた（バックアップにも入らない）。ここが唯一の読み口。
// 直近 limit 件を **新しい順** で返す。壊れた行は黙って飛ばす。
export function archivedTransactions(limit = 100) {
  const want = Math.max(0, Math.min(2000, Math.floor(Number(limit) || 0)));
  if (!want) return [];
  const out = [];
  try {
    const files = fs.readdirSync(DATA_DIR)
      .map(name => {
        const m = /^transactions-(\d{4})\.jsonl$/.exec(name);
        return m ? { name, year: Number(m[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.year - a.year);   // 新しい年から
    for (const f of files) {
      if (out.length >= want) break;
      let text;
      try {
        text = fs.readFileSync(path.join(DATA_DIR, f.name), 'utf8');
      } catch (err) {
        console.error(`[tx] ${f.name} を読めません:`, err.message);
        continue;
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < want; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object') out.push(row);
        } catch { /* 壊れた行は飛ばす（書庫は補助なので止めない） */ }
      }
    }
  } catch (err) {
    console.error('[tx] 書庫を読めません:', err.message);
  }
  return out;
}

// 退会・管理者削除の後始末。会計として残す意味があるのは「いつ・いくら・
// どの取引IDか」までで、そこに表示名を併記し続ける理由は無い。削除経路が
// これを呼んで、db に残っている行の username だけを伏せ字に置き換える
// （金額・取引ID・日時・件数は動かさないので、管理画面の売上集計は無傷）。
// ※ 書庫（DATA_DIR/transactions-YYYY.jsonl）は追記専用なのでここでは触らない。
//    保持年数の運用は README 側の宿題（coordination 参照）。
// 退会者の伏せ字。💎購入履歴・🐛バグ報告・クライアントエラー・全体チャットの
// 履歴が同じ文字列を使う（表記が経路ごとに割れると、管理画面で「これは同じ
// 状態なのか」が読めなくなる）。増やすときはここを import すること。
export const TX_ANON_NAME = '(退会済み / deleted)';
export function anonymizeUserTransactions(userId) {
  const id = String(userId || '');
  if (!id || !Array.isArray(db.transactions)) return 0;
  let n = 0;
  for (const t of db.transactions) {
    if (!t || t.userId !== id || t.username === TX_ANON_NAME) continue;
    t.username = TX_ANON_NAME;
    t.deletedUser = true;
    n++;
  }
  return n;
}

function grantPack(user, pack, status, extId = null) {
  const total = pack.gems + pack.bonus;
  user.gems += total;
  db.transactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    packId: pack.id,
    gems: total,
    jpy: pack.priceJpy,
    status,
    extId,
    at: Date.now(),
  });
  rotateTransactions();
  saveDb();
  return total;
}

purchaseRouter.post('/api/purchase', requireAuth, maintenanceGuard, async (req, res) => {
  if (!rateLimit(`buy:${req.user.id}`, 30, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '購入リクエストが多すぎます' });
  }
  const pack = GEM_PACKS.find(p => p.id === req.body.packId);
  if (!pack) return res.status(404).json({ error: 'パックが見つかりません' });

  // Real payments: create a Stripe Checkout session. Card details are entered
  // on Stripe's hosted page; gems are granted ONLY by the verified webhook.
  if (stripeEnabled()) {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      const params = new URLSearchParams({
        mode: 'payment',
        success_url: `${base}/?purchase=success`,
        cancel_url: `${base}/?purchase=cancel`,
        'line_items[0][price_data][currency]': 'jpy',
        'line_items[0][price_data][product_data][name]': `Block Blitz Arena ジェム ${pack.gems + pack.bonus}個`,
        'line_items[0][price_data][unit_amount]': String(pack.priceJpy),
        'line_items[0][quantity]': '1',
        'metadata[userId]': req.user.id,
        'metadata[packId]': pack.id,
      });
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const session = await resp.json();
      if (!resp.ok || !session.url) {
        console.error('[stripe] session create failed:', session.error && session.error.message);
        return res.status(502).json({ error: '決済セッションの作成に失敗しました' });
      }
      return res.json({ checkoutUrl: session.url });
    } catch (err) {
      console.error('[stripe] error:', err.message);
      return res.status(502).json({ error: '決済サービスに接続できません' });
    }
  }

  // No payment provider configured — purchases are under construction.
  res.status(503).json({ error: '課金機能は製作中です。もうしばらくお待ちください！' });
});

// Stripe webhook: the ONLY place real purchases grant gems.
purchaseRouter.post('/api/stripe/webhook', (req, res) => {
  if (!stripeEnabled() || !STRIPE_WEBHOOK_SECRET) return res.status(404).end();
  try {
    const sigHeader = String(req.headers['stripe-signature'] || '');
    const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
    const payload = `${parts.t}.${req.rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
    const given = Buffer.from(parts.v1 || '', 'hex');
    if (given.length !== 32 || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), given)) {
      return res.status(400).json({ error: 'bad signature' });
    }
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) {
      return res.status(400).json({ error: 'stale timestamp' });
    }
    const event = req.body;
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.metadata) {
        const user = db.users[session.metadata.userId];
        const pack = GEM_PACKS.find(p => p.id === session.metadata.packId);
        // 書庫に移った取引も見る。db.transactions だけだと、ローテーション後に
        // 同じイベントが再送されたときに二重付与になる。
        const already = db.transactions.some(t => t.extId === session.id)
          || (db.meta.txExtIds || []).includes(session.id);
        if (user && pack && !already) {
          grantPack(user, pack, 'stripe_completed', session.id);
          console.log(`[stripe] granted ${pack.id} to ${user.username}`);
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook error:', err.message);
    res.status(400).json({ error: 'webhook error' });
  }
});

const TX_PAGE = 100;

purchaseRouter.get('/api/admin/transactions', requireAuth, requireAdmin, (_req, res) => {
  const live = db.transactions.slice(-TX_PAGE).reverse();
  // db に残っているぶんだけでは 100件に届かないとき（＝ローテーション済み）は
  // 書庫から足りないぶんを補う。「誰がいつ何を買ったか」が管理画面から
  // 消えてしまわないように、必ずここで書庫も見る。
  const fromArchive = live.length < TX_PAGE
    ? archivedTransactions(TX_PAGE - live.length).map(t => ({ ...t, archived: true }))
    : [];
  const tx = live.concat(fromArchive);
  // 合計は「書庫に移したぶん(db.meta) ＋ db に残っているぶん」。ローテーションで
  // 売上と件数が減って見えないように、必ず両方を足す。
  const archivedJpy = Number(db.meta.revenueTotal) || 0;
  const archivedCount = Number(db.meta.revenueCount) || 0;
  const liveJpy = db.transactions.reduce((a, t) => a + (Number(t && t.jpy) || 0), 0);
  res.json({
    transactions: tx,
    totalCount: archivedCount + db.transactions.length,
    totalJpy: archivedJpy + liveJpy,
    // 内訳（一覧に出ているのは直近ぶんだけ、と管理者が分かるように）。
    liveCount: db.transactions.length,
    archivedCount,
    archivedJpy,
    // このページのうち、書庫から読み戻した件数。
    archivedShown: fromArchive.length,
  });
});

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 🏷 日替わりピックアップ（セール）＋ 🎁 本日の無料ギフト
//
// セールは全員共通・日付だけで決まる。抽選は missions.js と同じ mulberry32 の
// シード式で、db に何も持たない（＝復元でズレない、再起動で変わらない）。
// 割引率も同じ乱数列から出すので、誰がいつ叩いても同じ答えになる。
//
// いちばん大事なのは「割引後の価格は購入APIが自分で計算し直す」こと。
// クライアントが割引価格を申告できる形にすると、90%引きの申告で何でも買える。
// ---------------------------------------------------------------------------

function strHash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEAL_COUNT = 2;
const DEAL_OFF_MIN = 20;
const DEAL_OFF_MAX = 30;
// 抽選の対象外: 管理者専用・👑王座専用・🎰ガチャ限定・既定所持品（価格0）。
function dealEligible(i) {
  return !i.adminOnly && !i.throneOnly && !i.gachaOnly && !i.default && i.price > 0;
}

let dealsMemo = { day: null, list: null };
// 🏷️ その日のセール。住人の世界観（crowd.js の ctx.sale）にも渡す ──
//    セール用のセリフ13本と専用リアクションが全部そろっているのに、
//    ctx.sale を供給する場所がどこにも無く、**一度も出ていなかった**。
//    「今これ安いよ」は宣伝ではなく、遊んでいる人が普通にする話。
//    CTX_OK が「セールが実際に開催中のときだけ」に絞っているので、
//    無い日は今までどおり黙る。
export function currentDeals() { return dailyDeals(); }
function dailyDeals(dayKey = jstDayKey()) {
  if (dealsMemo.day === dayKey && dealsMemo.list) return dealsMemo.list;
  const pool = SHOP_ITEMS.filter(dealEligible);
  const rnd = mulberry32(strHash32(`bba-deal-${dayKey}`));
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const endsAt = nextJstMidnight();
  const list = arr.slice(0, Math.min(DEAL_COUNT, arr.length)).map(it => {
    const off = DEAL_OFF_MIN + Math.floor(rnd() * (DEAL_OFF_MAX - DEAL_OFF_MIN + 1));
    return {
      id: it.id, cat: it.cat, name: it.name, currency: it.currency,
      basePrice: it.price,
      off,
      price: Math.max(1, Math.round(it.price * (100 - off) / 100)),
      endsAt,
    };
  });
  dealsMemo = { day: dayKey, list };
  return list;
}

// 今この瞬間のこの品の実売価格。購入APIはここしか見ない。
function priceOf(item) {
  const d = dailyDeals().find(x => x.id === item.id);
  return d ? d.price : item.price;
}

// 🎁 本日の無料ギフト。1日1回。少額コイン／ブースター1個／低確率でジェム少量。
const GIFT_COINS_MIN = 300;
const GIFT_COINS_MAX = 600;
const GIFT_GEMS_MIN = 8;
const GIFT_GEMS_MAX = 20;
const GIFT_GEM_CHANCE = 0.08;    // 低確率
const GIFT_ITEM_CHANCE = 0.35;

function giftClaimedDay(user) {
  return (user.stats && user.stats.shopGiftDay) || null;
}

shopRouter.get('/api/shop', (req, res) => {
  // Admin-exclusive cosmetics are invisible to everyone else. Gacha-exclusive
  // gear is listed (so players know it exists) but marked and unbuyable.
  const isAdmin = req.user && req.user.role === 'admin';
  // throneOnly（👑専用ショップの品）もここには載せる ── 在庫画面が読むのが
  // このAPI なので、外すと買った本人が装備できなくなる。買えないことは
  // /api/shop/buy 側で弾いていて、画面もガチャ限定と同じ扱いで出す。
  const day = jstDayKey();
  res.json({
    items: SHOP_ITEMS.filter(i => !i.adminOnly || isAdmin),
    boosters: BOOST_ITEMS.filter(i => !i.adminOnly || isAdmin),
    // 🏷 本日のピックアップ（全員共通）。endsAt は各行にも入っている。
    deals: dailyDeals(day),
    dealsEndAt: nextJstMidnight(),
    // 🎁 本日の無料ギフトの受取状態。未ログインは常に false（受け取りは要ログイン）。
    gift: {
      day,
      available: !!req.user && giftClaimedDay(req.user) !== day,
      claimed: !!req.user && giftClaimedDay(req.user) === day,
      nextAt: nextJstMidnight(),
    },
  });
});

// 🎁 受け取りは1日1回。受取日は user.stats に dayKey で残すので、
// 連打しても2回目からは409になる。
shopRouter.post('/api/shop/gift', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`gift:${req.user.id}`, 10, 60 * 1000)) {
    return res.status(429).json({ error: '少し待ってください' });
  }
  migrateUser(req.user);
  const user = req.user;
  const today = jstDayKey();
  if (giftClaimedDay(user) === today) {
    return res.status(409).json({ error: '本日の無料ギフトは受け取り済みです', nextAt: nextJstMidnight() });
  }
  // 中身はサーバーで抽選する（クライアントの申告は一切見ない）。
  const roll = Math.random();
  let gift;
  if (roll < GIFT_GEM_CHANCE) {
    const amount = GIFT_GEMS_MIN + Math.floor(Math.random() * (GIFT_GEMS_MAX - GIFT_GEMS_MIN + 1));
    user.gems += amount;
    // icon（絵文字）は返さない。受け取りの知らせはトースト（textContent）で、
    // 絵文字を混ぜても端末任せの絵になるだけだった。
    gift = { type: 'gems', amount, name: 'ジェム', nameEn: 'Gems' };
  } else if (roll < GIFT_GEM_CHANCE + GIFT_ITEM_CHANCE) {
    const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
    const it = pool[Math.floor(Math.random() * pool.length)];
    user.items = user.items || {};
    user.items[it.id] = (user.items[it.id] || 0) + 1;
    gift = { type: 'item', id: it.id, amount: 1, name: it.name, nameEn: enName(it) };
  } else {
    const amount = GIFT_COINS_MIN + Math.floor(Math.random() * (GIFT_COINS_MAX - GIFT_COINS_MIN + 1));
    user.coins += amount;
    gift = { type: 'coins', amount, name: 'コイン', nameEn: 'Coins' };
  }
  user.stats.shopGiftDay = today;
  saveDb();
  res.json({ gift, user: publicUser(user), nextAt: nextJstMidnight() });
});

// ---- Booster items (consumables) ----

shopRouter.post('/api/items/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = BOOST_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用のアイテムです（非売品）' });
  const count = Math.max(1, Math.min(10, Math.floor(Number(req.body.count) || 1)));
  const cost = item.price * count;
  const user = req.user;
  if (user.role !== 'admin') {   // admins never pay
    if (user.coins < cost) return res.status(402).json({ error: 'コインが足りません' });
    user.coins -= cost;
  }
  user.items = user.items || {};
  user.items[item.id] = (user.items[item.id] || 0) + count;
  saveDb();
  res.json({ user: publicUser(user) });
});

shopRouter.post('/api/items/use', requireAuth, (req, res) => {
  const user = req.user;
  user.items = user.items || {};
  const id = String(req.body.itemId || '');
  const def = BOOST_ITEMS.find(i => i.id === id);
  if (!def) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (def.adminOnly && user.role !== 'admin') return res.status(403).json({ error: '管理者専用のアイテムです' });
  // Admins have infinite boosters — nothing is consumed.
  if (user.role !== 'admin') {
    if ((user.items[id] || 0) <= 0) return res.status(409).json({ error: 'アイテムを持っていません' });
    user.items[id] -= 1;
    saveDb();
  }
  res.json({ user: publicUser(user) });
});

// ---- Capsule machine (coin gacha) ----

const GACHA_COST_1 = 500;
const GACHA_COST_10 = 4500;

// ガチャ2.0: floor で下限レアリティを底上げできる（87=SSR以上確定、72=SR以上確定）。
const GACHA_PITY = 40;   // 天井 — 40連以内にSSR以上が必ず出る

function gachaPull(user, lucky = false, floor = 0, gemBudget = null) {
  // 💎ジェムは全産出源で1日の総額(GEMDROP_DAILY_CAP)を共有する。ガチャの💎も
  // その残額(gemBudget.room)からしか出さない ── コインで確実に💎を買える
  // 両替機にしないため。予算が尽きていれば 0💎 になる（＝配りきり）。
  // ⚠ 削ったかどうかを呼び出し側へ伝える（short）。0 のときだけ受け皿へ落ちる
  //   作りだったので、150💎 のはずの UR が「7💎」になっても理由がどこにも出ず、
  //   いちばん珍しい3%の当たりがふつうの SR より安く見えていた。
  let gemShort = false;
  const takeGems = (want) => {
    if (!gemBudget) { user.gems += want; return want; }
    const give = Math.max(0, Math.min(want, gemBudget.room));
    gemShort = give < want;
    user.gems += give;
    gemBudget.room -= give;
    return give;
  };
  // 🍀 Lucky Day skews every roll upward (exponent < 1), so the rare tiers at
  // the top of the range come up more often: N 50%→37%, SSR+ 13%→18%.
  const roll = floor + (lucky ? Math.pow(Math.random(), 0.7) : Math.random()) * (100 - floor);
  if (roll < 50) {   // N: coins
    const amount = 150 + Math.floor(Math.random() * 6) * 50;
    user.coins += amount;
    return { type: 'coins', amount, rarity: 'N' };
  }
  if (roll < 72) {   // R: booster item (staff-only god items must never drop)
    const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
    const it = pool[Math.floor(Math.random() * pool.length)];
    user.items[it.id] = (user.items[it.id] || 0) + 1;
    return { type: 'item', id: it.id, name: it.name, rarity: 'R' };
  }
  // 💠 予算切れの受け皿。
  //
  // takeGems() は日次予算の残りしか払わないので、その日の💎が配りきりだと
  // SR も UR も **中身0** で返っていた。UR は虹枠と全体フィードまで出たうえで
  // 0💎。しかも下の呼び出し側は rarity だけを見て天井をリセットするので、
  // 最大39連ぶんの積み上げまで一緒に消えていた。
  // SSR帯には「コンプ済みなら非通貨のブースター束」という代替が既にあるので、
  // 同じ考え方で SR / UR にも受け皿を用意する（通貨は配らない＝両替機化しない）。
  const boosterFallback = (qty, rarity) => {
    const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
    const it = pool[Math.floor(Math.random() * pool.length)];
    user.items = user.items || {};
    user.items[it.id] = (user.items[it.id] || 0) + qty;
    return { type: 'item', id: it.id, name: it.name, amount: qty, rarity, budgetOut: true };
  };
  if (roll < 87) {   // SR: gems
    const amount = takeGems(15 + Math.floor(Math.random() * 6) * 5);
    if (amount <= 0) return boosterFallback(2, 'SR');
    return { type: 'gems', amount, rarity: 'SR', ...(gemShort ? { budgetOut: true } : {}) };
  }
  if (roll < 97) {   // SSR: unowned cosmetic (or a booster bundle when complete)
    // adminOnly gear must never drop; gachaOnly gear drops ONLY here.
    // throneOnly をここに混ぜると「イベントでしか手に入らない」が嘘になる。
    const unowned = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly && !user.owned.includes(i.id));
    if (unowned.length === 0) {
      // 図鑑コンプ済み。ここで💎を確実に配ると、コイン→💎の両替レートが
      // 固定される（22.8🪙/💎）＝実質の両替機になる。通貨は配らず、
      // 非通貨のブースター束を代わりに配る。
      const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
      const it = pool[Math.floor(Math.random() * pool.length)];
      const qty = 3;
      user.items = user.items || {};
      user.items[it.id] = (user.items[it.id] || 0) + qty;
      return { type: 'item', id: it.id, name: it.name, amount: qty, rarity: 'SSR', complete: true };
    }
    const it = unowned[Math.floor(Math.random() * unowned.length)];
    user.owned.push(it.id);
    return { type: 'cosmetic', id: it.id, name: it.name, cat: it.cat, rarity: 'SSR', limited: !!it.gachaOnly };
  }
  // UR: jackpot gems
  const amount = takeGems(150);
  if (amount <= 0) return boosterFallback(5, 'UR');
  return { type: 'gems', amount, rarity: 'UR', ...(gemShort ? { budgetOut: true } : {}) };
}

shopRouter.post('/api/gacha', requireAuth, maintenanceGuard, (req, res) => {
  // ここには意図的に回数レート制限を置かない。ガチャの唯一の悪用は「💎の
  // 印刷」だが、それは (1) 💎産出を GEMDROP_DAILY_CAP に相乗りさせた takeGems()
  // と (2) 図鑑コンプ時のフォールバックを非通貨（ブースター束）にした2点で
  // 既に塞いである。ガチャ自体はコイン消費＝経済のシンクなので、速く回すほど
  // 自分のコインが減るだけで、貯めたコインを一気に使いたい人を毎時上限で止める
  // 副作用のほうが大きい（分布・天井のテストも機械速度では上限に当たる）。
  const count = Number(req.body.count) === 10 ? 10 : 1;
  const bonus = eventBonus(currentEvent());
  const base = count === 10 ? GACHA_COST_10 : GACHA_COST_1;
  const cost = Math.round(base * (bonus.gachaDiscount || 1));
  const user = req.user;
  if (user.role !== 'admin') {   // admins pull for free
    if (user.coins < cost) return res.status(402).json({ error: `コインが足りません（${fmtNum(cost)}必要）` });
    user.coins -= cost;
  }
  user.items = user.items || {};
  migrateUser(user);
  // 💎の産出は「1日に湧く総額」を全経路で共有する（通常ドロップ／お宝ラッシュと
  // 同じ user.stats.eventGemDay / GEMDROP_DAILY_CAP）。ガチャの💎もこの残額から
  // しか出さないことで、コイン→💎の両替機化を塞ぐ。
  const st = user.stats;
  const today = jstDayKey();
  if (!st.eventGemDay || st.eventGemDay.day !== today) st.eventGemDay = { day: today, got: 0 };
  const gemBudget = { room: Math.max(0, GEMDROP_DAILY_CAP - st.eventGemDay.got) };
  const startRoom = gemBudget.room;
  // ガチャ2.0: 天井（40連でSSR以上確定）＋ 10連はSR以上1枠確定。
  const isSRplus = r => r.rarity === 'SR' || r.rarity === 'SSR' || r.rarity === 'UR';
  const results = [];
  for (let i = 0; i < count; i++) {
    let floor = 0;
    if ((user.gachaPity || 0) >= GACHA_PITY - 1) floor = 87;                       // 天井到達: SSR以上
    else if (count === 10 && i === 9 && !results.some(isSRplus)) floor = 72;      // 10連保証: SR以上
    const r = gachaPull(user, !!bonus.gachaLuck, floor, gemBudget);
    user.gachaPity = (r.rarity === 'SSR' || r.rarity === 'UR') ? 0 : (user.gachaPity || 0) + 1;
    results.push(r);
  }
  // 今回ガチャで払い出した💎を日次予算に記帳（通常ドロップと合算される）。
  st.eventGemDay.got += (startRoom - gemBudget.room);
  user.stats.gachaPulls = (user.stats.gachaPulls || 0) + count;
  user.stats.gachaSSR = (user.stats.gachaSSR || 0) + results.filter(r => r.rarity === 'SSR' || r.rarity === 'UR').length;
  saveDb();
  // Big pulls make the live feed.
  const ur = results.find(r => r.rarity === 'UR');
  const ssr = results.find(r => r.rarity === 'SSR' && r.type === 'cosmetic');
  // 🌟 UR は必ず流す（3%・虹枠つきの、いちばん珍しい瞬間）。react:null は
  //    「住人には反応させない」という元からの意思なので、そちらは変えない。
  if (ur) postRealFeed(user, [{ icon: '🌟', ja: `${user.username} が UR を引き当てた！！`, en: `${user.username} hit the UR jackpot!!`, react: null, always: true }]);
  // 英語面に日本語のアイテム名が挿さっていた。カタログの英名を使う。
  else if (ssr) postRealFeed(user, [{ icon: '🎰', ja: `${user.username} がガチャで SSR「${ssr.name}」を引いた！`, en: `${user.username} pulled SSR "${enName(ssr)}"!` }]);
  const collectibles = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly);
  res.json({
    results, user: publicUser(user), cost, lucky: !!bonus.gachaLuck,
    pity: { count: user.gachaPity || 0, max: GACHA_PITY },
    collection: { owned: collectibles.filter(i => user.owned.includes(i.id)).length, total: collectibles.length },
  });
});

// Public gacha pricing so the UI can show the discounted cost.
shopRouter.get('/api/gacha/info', (req, res) => {
  const bonus = eventBonus(currentEvent());
  const mult = bonus.gachaDiscount || 1;
  const collectibles = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly);
  res.json({
    cost1: Math.round(GACHA_COST_1 * mult),
    cost10: Math.round(GACHA_COST_10 * mult),
    base1: GACHA_COST_1, base10: GACHA_COST_10,
    lucky: !!bonus.gachaLuck,
    discounted: mult !== 1,
    pityMax: GACHA_PITY,
    ...(req.user ? {
      pity: { count: req.user.gachaPity || 0, max: GACHA_PITY },
      collection: { owned: collectibles.filter(i => req.user.owned.includes(i.id)).length, total: collectibles.length },
    } : {}),
  });
});

shopRouter.post('/api/shop/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = SHOP_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用の装備です（非売品）' });
  if (item.throneOnly) return res.status(403).json({ error: '管理者イベント専用ショップの品です（王座の欠片でのみ交換）' });
  if (item.gachaOnly) return res.status(403).json({ error: 'ガチャ限定の装備です（SSRで入手）' });
  const user = req.user;
  if (user.owned.includes(item.id)) return res.status(409).json({ error: 'すでに所持しています' });
  // 🏷 セール価格は必ずここで引き直す。クライアントが送ってきた金額は見ない
  //（見た瞬間に「1コインで買った」と申告できる口ができる）。
  const price = priceOf(item);
  if (user[item.currency] < price) {
    return res.status(402).json({ error: item.currency === 'coins' ? 'コインが足りません' : 'ジェムが足りません' });
  }
  user[item.currency] -= price;
  user.owned.push(item.id);
  saveDb();
  res.json({ user: publicUser(user), paid: price, basePrice: item.price, discounted: price !== item.price });
});

throneShopRouter.get('/api/throne/shop', (req, res) => {
  const max = aeThroneMax(db);
  const user = req.user;
  const owned = user ? (user.role === 'admin' ? THRONE_ITEMS.map(i => i.id) : user.owned) : [];
  res.json({
    shards: user ? (user.shards || 0) : 0,
    throneMax: max,
    rates: AE_SHARD,
    items: THRONE_ITEMS.map(i => ({
      id: i.id, cat: i.cat, name: i.name, desc: i.desc,
      dan: i.dan, shards: i.shards,
      unlocked: max >= i.dan,
      owned: owned.includes(i.id),
    })),
  });
});

throneShopRouter.post('/api/throne/buy', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const item = THRONE_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'そんな品はありません' });
  const user = req.user;
  if (user.owned.includes(item.id)) return res.status(409).json({ error: 'すでに持っています' });
  const max = aeThroneMax(db);
  if (max < item.dan) {
    return res.status(403).json({ error: `まだ棚に並んでいません（第${item.dan}段が割れるまで）` });
  }
  if ((user.shards || 0) < item.shards) {
    return res.status(402).json({ error: `王座の欠片が足りません（${item.shards} 必要）` });
  }
  user.shards -= item.shards;
  user.owned.push(item.id);
  saveDb();
  res.json({ user: publicUser(user), got: { id: item.id, name: item.name, cat: item.cat } });
});

throneShopRouter.post('/api/equip', requireAuth, (req, res) => {
  const { slot, itemId } = req.body;
  if (!EQUIP_SLOTS.includes(slot)) return res.status(400).json({ error: '不正なスロットです' });
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item || item.cat !== slot) return res.status(400).json({ error: '不正なアイテムです' });
  // Admins implicitly own the entire catalog; admin gear stays admin-only.
  if (item.adminOnly) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '管理者専用の装備です' });
  } else if (req.user.role !== 'admin' && !req.user.owned.includes(itemId)) {
    return res.status(403).json({ error: '所持していないアイテムです' });
  }
  req.user.equipped[slot] = itemId;
  saveDb();
  res.json({ user: publicUser(req.user) });
});
