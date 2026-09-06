// 🔄 交換所 — コインとジェムの「使い道」。
//
// ■ なぜ要るのか
// この世界は蛇口ばかりで出口が無かった。1日に入るのはコイン最大150,000・
// ジェム120。対してショップの品は**全52点あわせて 69,900🪙＋3,150💎** しかなく、
// 半日遊べば棚が空になる。以降コインの行き先はガチャだけで、そのガチャも
// 約半分の枠がコインを返すので、出口としては穴が空いている。
//
// ■ どう解くか
// ここでしか手に入らない見た目を、**週替わり**で並べる。
//   ・強さには一切影響しない（board / fx だけ）＝ 貯め込んだ人が有利にならない
//   ・品揃えは weekId から決まるので**全員同じ**（「自分だけ出ない」が無い）
//   ・db には何も書かない（在庫も抽選結果も持たない）＝ 復元やバックアップの
//     対象が1つも増えない
//
// ■ 図鑑には数えない
// 週替わりということは「逃した週の品は取れない」ということ。図鑑の母数に
// 入れると**達成できない図鑑**になるので、server/catalog.js の
// isCollectibleGear が exchangeOnly を外している。
import { EXCHANGE_ITEMS, BOOST_ITEMS, supplyPacks, SUPPLY_GEM_PACK } from './catalog.js';
import { unit } from './residents.js';

// 1週間に並べる数。増やすほど1週の出費は増えるが、品切れも早くなる。
export const EXCHANGE_SLOTS = 4;

/**
 * 今週の品揃え。weekId（'W2954' のような文字列）だけで決まる純粋関数。
 * 乱数を使わないので、誰がいつ何度呼んでも同じ答えになる。
 *
 * ■ 並べ方は「一定の順に並べた輪を、週ごとに4つぶん回す」。
 *
 *   最初はハッシュで並べ替えて先頭から取る形にしたが、それだと
 *   **出現回数が偏る**（20週で数えたら 10回出る品と4回しか出ない品ができた）。
 *   輪を回す形なら、全部の品が同じ回数だけ、順番に必ず回ってくる
 *   ── 「今週は逃したけど、あと何週かで戻ってくる」が本当になる。
 *
 * ■ カテゴリは輪の中で交互にしてある。
 *   id 順のまま切ると「4枠とも board」の週ができて、エフェクトを待っている
 *   人が何週も待たされる。カテゴリを順番に1つずつ取り出して輪を組むので、
 *   どこで4つ切っても board と fx が混ざる。
 */
export function exchangeStock(weekId, pool = EXCHANGE_ITEMS) {
  const list = pool.filter(i => i && i.exchangeOnly && Number(i.exPrice) > 0);
  if (!list.length) return [];

  // カテゴリごとに id 順（＝毎週変わらない土台）。
  const byCat = new Map();
  for (const i of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!byCat.has(i.cat)) byCat.set(i.cat, []);
    byCat.get(i.cat).push(i);
  }
  // カテゴリを順番に1つずつ取り出して輪を組む（board, fx, board, fx, …）。
  const cats = [...byCat.keys()].sort();
  const ring = [];
  for (let k = 0; ring.length < list.length; k++) {
    for (const c of cats) {
      const arr = byCat.get(c);
      if (k < arr.length) ring.push(arr[k]);
    }
  }

  // 週の番号ぶんだけ輪を回す。weekId は 'W2954' の形なので数字を取り出す
  // （形が変わっても止まらないよう、数字が無ければハッシュに落とす）。
  const digits = String(weekId).replace(/\D/g, '');
  const n = digits ? Number(digits) : Math.floor(unit(`exchange-week:${weekId}`, 'x') * 100000);
  const take = Math.min(EXCHANGE_SLOTS, ring.length);
  const start = ((n * take) % ring.length + ring.length) % ring.length;
  const out = [];
  for (let k = 0; k < take; k++) out.push(ring[(start + k) % ring.length]);
  return out;
}

/**
 * 🧰 補給の売り場。**週替わりではなく常設**。
 *
 * 週替わりの品は一度買えば終わりなので、出口としては必ず枯れる。
 * 消耗品は使えば減るので、いつでも買える場所に置いておくのが正しい。
 */
export function supplyView(user) {
  const coins = Math.max(0, Number(user && user.coins) || 0);
  const gems = Math.max(0, Number(user && user.gems) || 0);
  const have = (user && user.items) || {};
  return {
    packs: supplyPacks().map(p => ({
      ...p, afford: coins >= p.price, held: Math.max(0, Number(have[p.itemId]) || 0),
    })),
    gemPack: {
      ...SUPPLY_GEM_PACK,
      // 中身は運営専用でない消耗品ぜんぶを qty 個ずつ。
      items: BOOST_ITEMS.filter(i => i && !i.adminOnly && Number(i.price) > 0).map(i => i.id),
      afford: gems >= SUPPLY_GEM_PACK.price,
    },
  };
}

/**
 * 補給を買う。**値段も個数もサーバーのカタログからしか読まない。**
 * （交換所の品と同じ作法 ── クライアントの申告した金額は一切見ない）
 */
export function buySupply(user, packId) {
  const id = String(packId || '');
  if (id === SUPPLY_GEM_PACK.id) {
    const price = SUPPLY_GEM_PACK.price;
    const have = Math.max(0, Number(user.gems) || 0);
    if (have < price) return { error: 'ジェムが足りません' };
    const kit = BOOST_ITEMS.filter(i => i && !i.adminOnly && Number(i.price) > 0);
    if (!kit.length) return { error: 'いま補給できる品がありません' };
    user.gems = have - price;
    user.items = user.items || {};
    for (const i of kit) user.items[i.id] = (Number(user.items[i.id]) || 0) + SUPPLY_GEM_PACK.qty;
    return {
      ok: true,
      got: kit.map(i => ({ id: i.id, name: i.name, qty: SUPPLY_GEM_PACK.qty })),
      spent: { currency: 'gems', amount: price },
    };
  }
  const pack = supplyPacks().find(p => p.id === id);
  if (!pack) return { error: 'その補給はありません' };
  const have = Math.max(0, Number(user.coins) || 0);
  if (have < pack.price) return { error: 'コインが足りません' };
  user.coins = have - pack.price;
  user.items = user.items || {};
  user.items[pack.itemId] = (Number(user.items[pack.itemId]) || 0) + pack.qty;
  return {
    ok: true,
    got: [{ id: pack.itemId, name: pack.name, qty: pack.qty }],
    spent: { currency: 'coins', amount: pack.price },
  };
}

/** 画面に返す形。owned は「もう持っているか」。 */
export function exchangeView(user, weekId, endsAt) {
  const owned = new Set((user && Array.isArray(user.owned)) ? user.owned : []);
  const coins = Math.max(0, Number(user && user.coins) || 0);
  const gems = Math.max(0, Number(user && user.gems) || 0);
  return {
    week: String(weekId),
    endsAt: Number(endsAt) || 0,
    slots: EXCHANGE_SLOTS,
    supply: supplyView(user),
    items: exchangeStock(weekId).map(i => ({
      id: i.id, cat: i.cat, name: i.name, desc: i.desc,
      price: Math.floor(Number(i.exPrice) || 0),
      currency: i.exCurrency === 'gems' ? 'gems' : 'coins',
      owned: owned.has(i.id),
      // 「足りない」を画面がサーバーに聞き直さずに出せるように。
      afford: (i.exCurrency === 'gems' ? gems : coins) >= Math.floor(Number(i.exPrice) || 0),
      exchangeOnly: true,
    })),
  };
}

/**
 * 引き換える。**値段はサーバーのカタログからしか読まない**
 * （クライアントの申告した金額は一切見ない）。
 */
export function buyExchange(user, weekId, itemId) {
  const item = exchangeStock(weekId).find(i => i.id === String(itemId || ''));
  // 今週並んでいない品は買えない。ここを緩めると「交換所限定なのに
  // いつでも買える」になって、週替わりの意味が消える。
  if (!item) return { error: '今週の交換所には並んでいない品です' };
  if (!Array.isArray(user.owned)) user.owned = [];
  if (user.owned.includes(item.id)) return { error: 'すでに持っています' };

  const currency = item.exCurrency === 'gems' ? 'gems' : 'coins';
  const price = Math.max(0, Math.floor(Number(item.exPrice) || 0));
  if (!price) return { error: 'この品は引き換えできません' };
  const have = Math.max(0, Number(user[currency]) || 0);
  if (have < price) {
    return { error: currency === 'gems' ? 'ジェムが足りません' : 'コインが足りません' };
  }
  user[currency] = have - price;
  user.owned.push(item.id);
  return {
    ok: true,
    item: { id: item.id, cat: item.cat, name: item.name },
    spent: { currency, amount: price },
  };
}
