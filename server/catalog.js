// Shop catalog + battle pass definition. Served to the client via /api/shop and /api/battlepass.

export const SHOP_ITEMS = [
  // ---- Block skins ----
  { id: 'skin_default',  cat: 'skin', name: 'クラシック',       desc: 'スタンダードなブロック', price: 0,    currency: 'coins', default: true },
  { id: 'skin_neon',     cat: 'skin', name: 'ネオングロウ',     desc: '発光するネオンブロック', price: 1200, currency: 'coins' },
  { id: 'skin_candy',    cat: 'skin', name: 'キャンディ',       desc: 'つやつやのキャンディ風', price: 1500, currency: 'coins' },
  { id: 'skin_pixel',    cat: 'skin', name: 'レトロピクセル',   desc: '8bitレトロスタイル',     price: 1800, currency: 'coins' },
  { id: 'skin_crystal',  cat: 'skin', name: 'クリスタル',       desc: '透き通る宝石ブロック',   price: 120,  currency: 'gems' },
  { id: 'skin_gold',     cat: 'skin', name: 'ゴールド',         desc: '輝く黄金ブロック',       price: 250,  currency: 'gems' },
  { id: 'skin_shadow',   cat: 'skin', name: 'シャドウ',         desc: '闇に光る輪郭ブロック',   price: 3000, currency: 'coins' },
  { id: 'skin_pastel',   cat: 'skin', name: 'パステル',         desc: 'やさしいフラットデザイン', price: 2200, currency: 'coins' },
  { id: 'skin_magma',    cat: 'skin', name: 'マグマ',           desc: '亀裂から灼熱が覗く岩ブロック', price: 3500, currency: 'coins' },
  { id: 'skin_dot',      cat: 'skin', name: 'みずたま',         desc: 'ポップな水玉もようブロック',   price: 2600, currency: 'coins' },
  // ---- Board themes ----
  { id: 'board_default', cat: 'board', name: 'ミッドナイト',    desc: '標準の夜空テーマ',       price: 0,    currency: 'coins', default: true },
  { id: 'board_ocean',   cat: 'board', name: 'ディープオーシャン', desc: '深海のグラデーション', price: 1000, currency: 'coins' },
  { id: 'board_sunset',  cat: 'board', name: 'サンセット',      desc: '夕焼けの温かい色合い',   price: 1000, currency: 'coins' },
  { id: 'board_forest',  cat: 'board', name: 'フォレスト',      desc: '深い森の静けさ',         price: 1300, currency: 'coins' },
  { id: 'board_galaxy',  cat: 'board', name: 'ギャラクシー',    desc: '星雲ときらめく星々',     price: 150,  currency: 'gems' },
  { id: 'board_sakura',  cat: 'board', name: '桜の間',          desc: '春爛漫の桜色ステージ',   price: 2000, currency: 'coins' },
  { id: 'board_volcano', cat: 'board', name: 'ボルケーノ',      desc: '火の粉舞う灼熱ステージ', price: 200,  currency: 'gems' },
  { id: 'board_snow',    cat: 'board', name: 'スノーフィールド', desc: '静かに雪が降る銀世界',   price: 1600, currency: 'coins' },
  { id: 'board_cyber',   cat: 'board', name: 'サイバー空間',    desc: '電脳世界のネオングリッド', price: 180, currency: 'gems' },
  // ---- Clear effects ----
  { id: 'fx_default',    cat: 'fx', name: 'スパーク',           desc: '標準の火花エフェクト',   price: 0,    currency: 'coins', default: true },
  { id: 'fx_fireworks',  cat: 'fx', name: '花火',               desc: 'ライン消去で花火が炸裂', price: 2000, currency: 'coins' },
  { id: 'fx_thunder',    cat: 'fx', name: 'サンダー',           desc: '稲妻が走る消去エフェクト', price: 2500, currency: 'coins' },
  { id: 'fx_sakura',     cat: 'fx', name: '桜吹雪',             desc: '花びらが舞い散る',       price: 180,  currency: 'gems' },
  { id: 'fx_bubble',     cat: 'fx', name: 'バブル',             desc: 'シャボン玉がはじける',   price: 1800, currency: 'coins' },
  { id: 'fx_star',       cat: 'fx', name: 'スターダスト',       desc: '星屑がきらめき散る',     price: 220,  currency: 'gems' },
  { id: 'fx_flame',      cat: 'fx', name: 'フレイム',           desc: '炎が燃え上がる消去エフェクト', price: 2400, currency: 'coins' },
  // ---- Admin-exclusive gear (adminOnly: hidden from everyone else, unbuyable) ----
  { id: 'skin_admin',    cat: 'skin',  name: 'レインボー【管理者】', desc: '虹色に輝く運営専用ブロック', price: 0, currency: 'coins', adminOnly: true },
  { id: 'board_admin',   cat: 'board', name: '王の間【管理者】',     desc: '黄金に輝く運営専用ステージ', price: 0, currency: 'coins', adminOnly: true },
  { id: 'fx_admin',      cat: 'fx',    name: '虹の祝福【管理者】',   desc: '虹の粒子が舞う運営専用エフェクト', price: 0, currency: 'coins', adminOnly: true },
];

export const DEFAULT_OWNED = SHOP_ITEMS.filter(i => i.default).map(i => i.id);
export const DEFAULT_EQUIPPED = { skin: 'skin_default', board: 'board_default', fx: 'fx_default' };

// ---- Booster items (consumables) — usable in solo / boss / dungeon / chaos ----
export const BOOST_ITEMS = [
  { id: 'item_bomb',    icon: '💣', name: 'スマートボム', desc: 'いちばん埋まっている3×3を爆破', price: 300, currency: 'coins' },
  { id: 'item_cleaner', icon: '🧹', name: 'クリーナー',   desc: 'お邪魔ブロック全部＋最下行を掃除', price: 250, currency: 'coins' },
  { id: 'item_fever',   icon: '⭐', name: 'フィーバー',   desc: '15秒間スコア2倍', price: 400, currency: 'coins' },
  { id: 'item_mini',    icon: '🧩', name: 'ミニブロック', desc: '手持ち3つが極小ピースに変化', price: 350, currency: 'coins' },
];

// ---- Boss battles ----
export const BOSSES = [
  { id: 'slime',  name: 'スライムキング',   emoji: '🟢', hp: 3000,  atkSec: 12, atkCells: 3, gemsFirst: 50 },
  { id: 'golem',  name: 'アイアンゴーレム', emoji: '🗿', hp: 8000,  atkSec: 10, atkCells: 4, gemsFirst: 80 },
  { id: 'dragon', name: 'ドラゴン',         emoji: '🐉', hp: 15000, atkSec: 9,  atkCells: 5, gemsFirst: 120 },
  { id: 'maou',   name: 'まおう',           emoji: '😈', hp: 25000, atkSec: 8,  atkCells: 6, gemsFirst: 200 },
];

// Raid-exclusive bosses: never appear in the solo boss mode.
// Tougher than anything there — more HP (further scaled by party size)
// and harder-hitting, faster attacks.
export const RAID_BOSSES = [
  { id: 'kraken',  name: '深海のクラーケン', emoji: '🐙', hp: 35000, atkSec: 7, atkCells: 7 },
  { id: 'tiamat',  name: '魔竜ティアマト',   emoji: '🐲', hp: 45000, atkSec: 7, atkCells: 8 },
  { id: 'hades',   name: '冥王ハデス',       emoji: '💀', hp: 60000, atkSec: 6, atkCells: 8 },
];

// ---- Titles (称号) — earned from stats, one equippable ----
export const TITLES = [
  { id: 'rookie',   name: 'かけだしブロッカー', color: '#9aa3c7', desc: '1回プレイする' },
  { id: 'addict',   name: 'ブロック中毒',       color: '#43d9e8', desc: '50回プレイする' },
  { id: 'combo5',   name: 'コンボの申し子',     color: '#5ee86e', desc: '5コンボを達成' },
  { id: 'combo10',  name: 'コンボマスター',     color: '#ffe14d', desc: '10コンボを達成' },
  { id: 'score100k',name: '十万点の壁の向こう', color: '#ffa93d', desc: 'スコア100,000を達成' },
  { id: 'pvp10',    name: '常勝将軍',           color: '#ff6bd4', desc: 'オンライン対戦で10勝' },
  { id: 'rate1200', name: 'レジェンド',         color: '#b06bff', desc: 'レート1200に到達' },
  { id: 'rich',     name: '大富豪',             color: '#ffd75e', desc: 'コインを10,000枚所持' },
  { id: 'bosshunt', name: 'ボスハンター',       color: '#ff5d5d', desc: 'ボスを2体討伐' },
  { id: 'maoslayer',name: '魔王を討ちし者',     color: '#ff5d5d', desc: 'まおうを討伐' },
  { id: 'rushhero', name: 'ボスラッシュ制覇',   color: '#ffa93d', desc: 'ボスラッシュをクリア' },
  { id: 'onislayer',name: '鬼退治',             color: '#c22f3d', desc: '難易度「鬼」に勝利' },
  { id: 'kamislayer', name: '神殺し',           color: '#fff3b0', desc: '難易度「神」に勝利' },
  { id: 'souzouslayer', name: '創造を超えし者', color: '#b06bff', desc: '難易度「創造神」に勝利' },
  { id: 'tourneyking', name: '大会王者',        color: '#ffd75e', desc: 'オンライントーナメントで優勝' },
  { id: 'apex100',  name: '百人の頂点',         color: '#ff5d5d', desc: 'バトルロイヤルで1位' },
  { id: 'streak5',  name: '連勝街道',           color: '#ffa93d', desc: 'ランクマッチ5連勝' },
  { id: 'diamond',  name: 'ダイヤの誇り',       color: '#43d9e8', desc: 'レート1500に到達' },
  { id: 'grandmaster', name: '頂のマスター',    color: '#fff3b0', desc: 'レート1700に到達' },
  { id: 'veteran',  name: '生粋のブロッカー',   color: '#5ee86e', desc: '200回プレイする' },
  { id: 'combo15',  name: 'コンボの神域',       color: '#ff6bd4', desc: '15コンボを達成' },
  { id: 'score300k',name: '三十万の伝説',       color: '#b06bff', desc: 'スコア300,000を達成' },
  { id: 'liner',    name: 'ライン職人',         color: '#43d9e8', desc: '累計5,000ライン消去' },
  { id: 'pvp50',    name: '百戦錬磨',           color: '#ff5d5d', desc: 'オンライン対戦で50勝' },
  { id: 'explorer', name: '塔の探検家',         color: '#ffa93d', desc: 'ダンジョン塔F50到達' },
  { id: 'towerlord',name: '百塔の覇者',         color: '#ffd75e', desc: 'ダンジョン塔100F制覇' },
];

export function earnedTitles(user) {
  const s = user.stats;
  const out = [];
  const has = id => user.badges.includes(id);
  if (s.gamesPlayed >= 1) out.push('rookie');
  if (s.gamesPlayed >= 50) out.push('addict');
  if (s.maxCombo >= 5) out.push('combo5');
  if (s.maxCombo >= 10) out.push('combo10');
  if (s.bestScore >= 100000) out.push('score100k');
  if (s.pvpWins >= 10) out.push('pvp10');
  if (s.rating >= 1200) out.push('rate1200');
  if (user.coins >= 10000) out.push('rich');
  if ((s.bossMax || 0) >= 2) out.push('bosshunt');
  if (has('maou')) out.push('maoslayer');
  if (has('rush')) out.push('rushhero');
  if (has('oni')) out.push('onislayer');
  if (has('kami')) out.push('kamislayer');
  if (has('souzou')) out.push('souzouslayer');
  if (has('tourney')) out.push('tourneyking');
  if (has('royale')) out.push('apex100');
  if ((s.winStreak || 0) >= 5) out.push('streak5');
  if (s.rating >= 1500) out.push('diamond');
  if (s.rating >= 1700) out.push('grandmaster');
  if (s.gamesPlayed >= 200) out.push('veteran');
  if (s.maxCombo >= 15) out.push('combo15');
  if (s.bestScore >= 300000) out.push('score300k');
  if ((s.totalLines || 0) >= 5000) out.push('liner');
  if (s.pvpWins >= 50) out.push('pvp50');
  if ((s.dungeonMax || 0) >= 50) out.push('explorer');
  if (has('dungeon')) out.push('towerlord');
  return out;
}

// ---- Gem packs (demo payments — swap in a real PSP for production) ----
export const GEM_PACKS = [
  { id: 'gems_s',  gems: 120,  bonus: 0,   priceJpy: 160 },
  { id: 'gems_m',  gems: 550,  bonus: 50,  priceJpy: 650 },
  { id: 'gems_l',  gems: 1200, bonus: 180, priceJpy: 1400 },
  { id: 'gems_xl', gems: 2600, bonus: 520, priceJpy: 2900 },
];

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
