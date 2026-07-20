// Shop catalog + battle pass definition. Served to the client via /api/shop and /api/battlepass.

export const SHOP_ITEMS = [
  // ---- Block skins ----
  { id: 'skin_default',  cat: 'skin', name: 'クラシック',       desc: 'スタンダードなブロック', price: 0,    currency: 'coins', default: true },
  { id: 'skin_neon',     cat: 'skin', name: 'ネオングロウ',     desc: '発光するネオンブロック', price: 1200, currency: 'coins' },
  { id: 'skin_candy',    cat: 'skin', name: 'キャンディ',       desc: 'つやつやのキャンディ風', price: 1500, currency: 'coins' },
  { id: 'skin_pixel',    cat: 'skin', name: 'レトロピクセル',   desc: '8bitレトロスタイル',     price: 1800, currency: 'coins' },
  { id: 'skin_crystal',  cat: 'skin', name: 'クリスタル',       desc: '透き通る宝石ブロック',   price: 120,  currency: 'gems' },
  { id: 'skin_gold',     cat: 'skin', name: 'ゴールド',         desc: '輝く黄金ブロック',       price: 250,  currency: 'gems' },
  // ---- Board themes ----
  { id: 'board_default', cat: 'board', name: 'ミッドナイト',    desc: '標準の夜空テーマ',       price: 0,    currency: 'coins', default: true },
  { id: 'board_ocean',   cat: 'board', name: 'ディープオーシャン', desc: '深海のグラデーション', price: 1000, currency: 'coins' },
  { id: 'board_sunset',  cat: 'board', name: 'サンセット',      desc: '夕焼けの温かい色合い',   price: 1000, currency: 'coins' },
  { id: 'board_forest',  cat: 'board', name: 'フォレスト',      desc: '深い森の静けさ',         price: 1300, currency: 'coins' },
  { id: 'board_galaxy',  cat: 'board', name: 'ギャラクシー',    desc: '星雲ときらめく星々',     price: 150,  currency: 'gems' },
  // ---- Clear effects ----
  { id: 'fx_default',    cat: 'fx', name: 'スパーク',           desc: '標準の火花エフェクト',   price: 0,    currency: 'coins', default: true },
  { id: 'fx_fireworks',  cat: 'fx', name: '花火',               desc: 'ライン消去で花火が炸裂', price: 2000, currency: 'coins' },
  { id: 'fx_thunder',    cat: 'fx', name: 'サンダー',           desc: '稲妻が走る消去エフェクト', price: 2500, currency: 'coins' },
  { id: 'fx_sakura',     cat: 'fx', name: '桜吹雪',             desc: '花びらが舞い散る',       price: 180,  currency: 'gems' },
];

export const DEFAULT_OWNED = SHOP_ITEMS.filter(i => i.default).map(i => i.id);
export const DEFAULT_EQUIPPED = { skin: 'skin_default', board: 'board_default', fx: 'fx_default' };

// ---- Battle pass ----
export const BP_XP_PER_TIER = 500;
export const BP_PREMIUM_PRICE_GEMS = 500;
export const BP_SEASON_DAYS = 30;

function tier(n, free, premium) { return { tier: n, free, premium }; }
const c = amount => ({ type: 'coins', amount });
const g = amount => ({ type: 'gems', amount });
const item = id => ({ type: 'item', id });
const badge = id => ({ type: 'badge', id });

export const BP_TIERS = [
  tier(1,  c(100),  g(20)),
  tier(2,  c(150),  c(300)),
  tier(3,  null,    g(30)),
  tier(4,  c(200),  c(400)),
  tier(5,  g(10),   item('skin_neon')),
  tier(6,  c(200),  g(30)),
  tier(7,  null,    c(500)),
  tier(8,  c(250),  g(40)),
  tier(9,  c(250),  c(600)),
  tier(10, badge('bronze'), item('board_ocean')),
  tier(11, c(300),  g(40)),
  tier(12, null,    c(700)),
  tier(13, c(300),  g(50)),
  tier(14, c(350),  c(800)),
  tier(15, g(20),   item('fx_fireworks')),
  tier(16, c(350),  g(50)),
  tier(17, null,    c(900)),
  tier(18, c(400),  g(60)),
  tier(19, c(400),  c(1000)),
  tier(20, badge('silver'), item('skin_candy')),
  tier(21, c(450),  g(60)),
  tier(22, null,    c(1100)),
  tier(23, c(450),  g(70)),
  tier(24, c(500),  c(1200)),
  tier(25, g(30),   item('board_sunset')),
  tier(26, c(500),  g(80)),
  tier(27, null,    c(1300)),
  tier(28, c(550),  g(90)),
  tier(29, c(550),  c(1500)),
  tier(30, badge('gold'), item('skin_gold')),
];
