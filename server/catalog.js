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
  // ---- Ultimate skills (装備スロット: ult) ----
  // ゲージが満タンになると発動できる必殺技。1つだけ装備できる。
  { id: 'ult_blast',     cat: 'ult', icon: '💥', name: '破壊の衝撃波',   desc: 'いちばん埋まった2行2列を強制消去', price: 0,    currency: 'coins', default: true },
  { id: 'ult_purify',    cat: 'ult', icon: '🌊', name: '浄化の波動',     desc: 'お邪魔ブロック全消し＋下2行を消去', price: 2500, currency: 'coins' },
  { id: 'ult_overdrive', cat: 'ult', icon: '🔥', name: 'オーバードライブ', desc: '15秒間スコア3倍！',              price: 3500, currency: 'coins' },
  { id: 'ult_meteor',    cat: 'ult', icon: '☄️', name: 'メテオストライク', desc: 'ランダムな14マスを大爆発で粉砕',  price: 4200, currency: 'coins' },
  { id: 'ult_rainbow',   cat: 'ult', icon: '🌈', name: 'レインボーハンド', desc: '手持ちが必ず置ける最適ピースに変化', price: 150, currency: 'gems' },
  { id: 'ult_fortress',  cat: 'ult', icon: '🛡️', name: '不落の城塞',     desc: '30秒間コンボが途切れず妨害も無効',   price: 200, currency: 'gems' },
  { id: 'ult_timestop',  cat: 'ult', icon: '⏳', name: '時間停止',        desc: '制限時間+12秒／ボスの攻撃を20秒封印', price: 260, currency: 'gems' },
  { id: 'ult_judgement', cat: 'ult', icon: '⚡', name: '神の裁き',        desc: '盤面を完全消滅させ超特大スコア',     price: 400, currency: 'gems' },
  // ---- Gacha-exclusive gear (gachaOnly: never sold — SSR pull is the only way) ----
  { id: 'skin_prism',   cat: 'skin',  name: 'プリズム【ガチャ限定】',   desc: '光を分解する虹の結晶ブロック', price: 0, currency: 'gems', gachaOnly: true },
  { id: 'board_aurora', cat: 'board', name: 'オーロラ【ガチャ限定】',   desc: '極光が揺らめく夜のステージ',   price: 0, currency: 'gems', gachaOnly: true },
  { id: 'fx_comet',     cat: 'fx',    name: '彗星【ガチャ限定】',       desc: '尾を引く彗星が走る消去エフェクト', price: 0, currency: 'gems', gachaOnly: true },
  // ---- 👑 王座の欠片でしか買えない装備（throneOnly） ----
  // 管理者イベント専用ショップの品。コイン・ジェム・ガチャのどれでも手に入らない。
  // dan は「世界が第何段まで割ったら棚に並ぶか」。買えるかどうかが
  // 個人の財布ではなく世界の進捗で決まるのがこの棚の面白いところ。
  { id: 'skin_verdict',    cat: 'skin',  name: '断罪の刻印',   desc: '赤い判決線が走るブロック',       price: 0, currency: 'coins', throneOnly: true, dan: 1, shards: 120 },
  { id: 'board_throne',    cat: 'board', name: '七つの王座',   desc: '奪還した数だけ玉座が灯るステージ', price: 0, currency: 'coins', throneOnly: true, dan: 2, shards: 180 },
  { id: 'fx_seal',         cat: 'fx',    name: '封印砕き',     desc: '紫の封印が砕け散る消去エフェクト', price: 0, currency: 'coins', throneOnly: true, dan: 3, shards: 220 },
  { id: 'skin_zero',       cat: 'skin',  name: 'ゼロの眼',     desc: '見返してくる眼が埋まったブロック', price: 0, currency: 'coins', throneOnly: true, dan: 4, shards: 300 },
  { id: 'ult_condemn',     cat: 'ult',   icon: '👁️', name: '断罪の一撃', desc: '縦横1列ずつを問答無用で消し飛ばす', price: 0, currency: 'coins', throneOnly: true, dan: 5, shards: 400 },
  { id: 'board_chronicle', cat: 'board', name: '断罪録の間',   desc: '壁に名前が流れ続ける記録の間',     price: 0, currency: 'coins', throneOnly: true, dan: 6, shards: 500 },
  { id: 'fx_crown',        cat: 'fx',    name: '王冠還る',     desc: '砕けた王冠が組み上がる消去エフェクト', price: 0, currency: 'coins', throneOnly: true, dan: 7, shards: 700 },
  // ---- Admin-exclusive gear (adminOnly: hidden from everyone else, unbuyable) ----
  { id: 'skin_admin',    cat: 'skin',  name: 'レインボー【管理者】', desc: '虹色に輝く運営専用ブロック', price: 0, currency: 'coins', adminOnly: true },
  { id: 'board_admin',   cat: 'board', name: '王の間【管理者】',     desc: '黄金に輝く運営専用ステージ', price: 0, currency: 'coins', adminOnly: true },
  { id: 'fx_admin',      cat: 'fx',    name: '虹の祝福【管理者】',   desc: '虹の粒子が舞う運営専用エフェクト', price: 0, currency: 'coins', adminOnly: true },
  { id: 'ult_admin',     cat: 'ult',   icon: '👑', name: '全能【管理者】', desc: '盤面消滅＋ゲージ即再充填の運営専用奥義', price: 0, currency: 'coins', adminOnly: true },
];

// 装備スロット一覧（/api/equip が受け付けるスロット）
// 👑 王座の欠片で買えるものだけ。ここに入ったものは /api/shop にも
// ガチャの抽選対象にも絶対に出さない（出したら専用の意味が消える）。
export const THRONE_ITEMS = SHOP_ITEMS.filter(i => i.throneOnly);

export const EQUIP_SLOTS = ['skin', 'board', 'fx', 'ult'];

export const DEFAULT_OWNED = SHOP_ITEMS.filter(i => i.default).map(i => i.id);
export const DEFAULT_EQUIPPED = { skin: 'skin_default', board: 'board_default', fx: 'fx_default', ult: 'ult_blast' };

// ---- Booster items (consumables) — usable in solo / boss / dungeon / chaos ----
export const BOOST_ITEMS = [
  { id: 'item_bomb',    icon: '💣', name: 'スマートボム', desc: 'いちばん埋まっている3×3を爆破', price: 300, currency: 'coins' },
  { id: 'item_cleaner', icon: '🧹', name: 'クリーナー',   desc: 'お邪魔ブロック全部＋最下行を掃除', price: 250, currency: 'coins' },
  { id: 'item_fever',   icon: '⭐', name: 'フィーバー',   desc: '15秒間スコア2倍', price: 400, currency: 'coins' },
  { id: 'item_mini',    icon: '🧩', name: 'ミニブロック', desc: '手持ち3つが極小ピースに変化', price: 350, currency: 'coins' },
  // ---- Staff-only gear (adminOnly: never sold, never shown to players, infinite for admins) ----
  { id: 'item_god_wipe',   icon: '💥', name: '神の一撃【管理者】',   desc: '盤面を消滅させ +50,000点（倍率適用）',        price: 0, currency: 'coins', adminOnly: true },
  { id: 'item_god_time',   icon: '⌛', name: '時の支配【管理者】',   desc: '制限時間+120秒／敵の攻撃を60秒封印',          price: 0, currency: 'coins', adminOnly: true },
  { id: 'item_god_hand',   icon: '🎴', name: '創造の手札【管理者】', desc: '最適な3ピース＋次の12手がライン消し向けの大型ピース', price: 0, currency: 'coins', adminOnly: true },
  { id: 'item_god_mult',   icon: '🔱', name: '神威【管理者】',       desc: '30秒間スコア10倍',                            price: 0, currency: 'coins', adminOnly: true },
  { id: 'item_god_shield', icon: '🛡️', name: '絶対防御【管理者】',   desc: '60秒間ゲームオーバー無効・お邪魔無効・コンボ永続', price: 0, currency: 'coins', adminOnly: true },
  { id: 'item_god_nuke',   icon: '☄️', name: '天変地異【管理者】',   desc: '敵のHPを99%削る（敵がいなければ +100,000点）',   price: 0, currency: 'coins', adminOnly: true },
];

// ---- Boss battles ----
// moves / moves2: attack-pattern ids for phase 1 / phase 2 (HP <= 50%),
// dispatched client-side (modes.js BOSS_MOVES). atk2 = phase-2 attack-interval
// multiplier. Telegraphed moves flash their target cells first and can be CUT
// by clearing a line through them.
// `nameEn` mirrors CATALOG_EN in public/js/i18n.js (which is what the CLIENT
// renders). The server needs its own copy because it writes English live-feed
// lines — without it, English readers got "X defeated スライムキング".
export const BOSSES = [
  { id: 'slime',  name: 'スライムキング',   nameEn: 'Slime King',       emoji: '🟢', hp: 3000,  atkSec: 12, atkCells: 3, gemsFirst: 50,
    moves: ['garbage'], moves2: ['garbage'], atk2: 0.75 },
  { id: 'golem',  name: 'アイアンゴーレム', nameEn: 'Iron Golem',       emoji: '🗿', hp: 8000,  atkSec: 10, atkCells: 4, gemsFirst: 80,
    moves: ['garbage', 'quake'], moves2: ['garbage', 'quake'], atk2: 0.75 },
  { id: 'dragon', name: 'ドラゴン',         nameEn: 'Dragon',           emoji: '🐉', hp: 15000, atkSec: 9,  atkCells: 5, gemsFirst: 120,
    moves: ['garbage', 'breath_row'], moves2: ['breath_row', 'garbage'], atk2: 0.75 },
  { id: 'maou',   name: 'まおう',           nameEn: 'Demon Lord',       emoji: '😈', hp: 25000, atkSec: 8,  atkCells: 6, gemsFirst: 200,
    moves: ['garbage', 'curse_hand'], moves2: ['garbage', 'curse_hand', 'breath_row'], atk2: 0.7 },
  { id: 'mecha',  name: '機械神エクスマキナ', nameEn: 'Deus Ex Machina', emoji: '⚙️', hp: 40000, atkSec: 8, atkCells: 6, gemsFirst: 300,
    moves: ['garbage', 'laser_col', 'quake'], moves2: ['laser_col', 'laser_col2', 'quake'], atk2: 0.72 },
  { id: 'frost',  name: '氷雪女王フリオーネ', nameEn: 'Frost Queen Frione', emoji: '🧊', hp: 60000, atkSec: 8, atkCells: 7, gemsFirst: 500,
    moves: ['garbage', 'curse_hand'], moves2: ['garbage', 'curse_hand2', 'breath_row'], atk2: 0.7 },
];

// Raid-exclusive bosses: never appear in the solo boss mode.
// Tougher than anything there — more HP (further scaled by party size)
// and harder-hitting, faster attacks.
export const RAID_BOSSES = [
  { id: 'kraken',  name: '深海のクラーケン', nameEn: 'Abyssal Kraken',            emoji: '🐙', hp: 35000, atkSec: 7, atkCells: 7 },
  { id: 'tiamat',  name: '魔竜ティアマト',   nameEn: 'Tiamat the Dread Dragon',   emoji: '🐲', hp: 45000, atkSec: 7, atkCells: 8 },
  { id: 'hades',   name: '冥王ハデス',       nameEn: 'Hades, Lord of the Dead',   emoji: '💀', hp: 60000, atkSec: 6, atkCells: 8 },
];

// ---- Titles (称号) — earned from stats, one equippable ----
export const TITLES = [
  // 👁️ 断罪。負け側の勲章（名指しの常連）もあえて置いてある ——
  // 落とした回数しか誇れない日もあるので。
  { id: 'zerocut',   name: '断罪を斬りし者', color: '#e03546', desc: '封印を破るとどめを入れる' },
  { id: 'zeronamed', name: '名指しの常連',   color: '#8b6cff', desc: '通算50回 名指しされる' },
  { id: 'zeroseven', name: '七冠奪還',       color: '#f0b429', desc: '七段すべてが割れた日に参加している' },
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
  { id: 'hunter',   name: '狩る者',             color: '#ff6bd4', desc: 'バトルロイヤルで通算25KO' },
  { id: 'guest',    name: '招かれし来賓',       color: '#ffd75e', desc: '管理者イベントに10回参加' },
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
  { id: 'ultimate', name: '極意の継承者',     color: '#43d9e8', desc: 'アルティメットを100回発動' },
  { id: 'ultgod',   name: '奥義を極めし者',   color: '#b06bff', desc: 'アルティメットを500回発動' },
  { id: 'missionman', name: '任務遂行者',     color: '#5ee86e', desc: 'ミッションを50個クリア' },
  { id: 'missiongod', name: 'ミッションの鬼', color: '#ff6bd4', desc: 'ミッションを300個クリア' },
  { id: 'achiever', name: 'トロフィーハンター', color: '#ffa93d', desc: '実績を20個解除' },
  { id: 'completionist', name: '完全主義者',  color: '#fff3b0', desc: '実績を40個解除' },
  { id: 'loyal7',   name: '皆勤賞',           color: '#43d9e8', desc: '7日連続ログイン' },
  { id: 'loyal30',  name: '不動の常連',       color: '#ffd75e', desc: '30日連続ログイン' },
  { id: 'survivor', name: '生存本能',         color: '#c22f3d', desc: 'サバイバルでウェーブ20到達' },
  { id: 'millionaire', name: '億万長者',      color: '#ffd75e', desc: '累計スコア1,000,000達成' },
  { id: 'sprinter', name: '疾風のブロッカー', color: '#ffa93d', desc: 'タイムアタック60秒で20,000点' },
  { id: 'buddy',    name: '名コンビ',         color: '#5ee86e', desc: '協力プレイを10回遊ぶ' },
  { id: 'soulmate', name: '以心伝心',         color: '#ff6bd4', desc: '協力プレイで20,000点' },
  { id: 'abysswalker', name: '深淵を覗きし者', color: '#7c3aed', desc: '深淵ダンジョン A50到達' },
  { id: 'abysslord', name: '深淵の支配者',     color: '#c026d3', desc: '深淵ダンジョン A100制覇' },
  { id: 'guildfounder', name: 'ギルド創設者', color: '#f59e0b', desc: 'ギルドを設立する' },
  { id: 'guildace', name: 'ギルドのエース',   color: '#22d3ee', desc: 'ギルドに週2,000ポイント貢献' },
  { id: 'weeklyking', name: '週間王者',       color: '#ffd75e', desc: '週間チャレンジで週間1位に輝く' },
  { id: 'bossmaster', name: '完全討伐者',     color: '#ff5d5d', desc: '全ボスをSランクで討伐する' },
  { id: 'hellrunner', name: '地獄を駆ける者', color: '#c026d3', desc: '無限地獄ラッシュで深度12に到達' },
  { id: 'ruinsage',  name: '古代の賢者',      color: '#a3e635', desc: 'パズル遺跡でステージ30をクリア' },
  { id: 'miner',     name: 'マスター採掘士',  color: '#f59e0b', desc: '採掘場で深度50に到達' },
  { id: 'gachaprince', name: 'ガチャの申し子', color: '#ff6bd4', desc: 'ガチャを100回引く' },
  { id: 'lobbyface', name: 'ロビーの顔',      color: '#43d9e8', desc: 'チャットで300回発言する' },
  { id: 'ghostmaster', name: '幽霊使い',      color: '#a78bfa', desc: '幽霊屋敷で15,000点（見えない何かと心を通わせた）' },
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
  if (Math.max(s.ratingBest || 0, s.rating) >= 1200) out.push('rate1200');
  if (user.coins >= 10000) out.push('rich');
  if ((s.bossMax || 0) >= 2) out.push('bosshunt');
  if (has('maou')) out.push('maoslayer');
  if (has('rush')) out.push('rushhero');
  if (has('oni')) out.push('onislayer');
  if (has('kami')) out.push('kamislayer');
  if (has('souzou')) out.push('souzouslayer');
  if (has('tourney')) out.push('tourneyking');
  if (has('royale')) out.push('apex100');
  if ((s.royaleKills || 0) >= 25) out.push('hunter');
  // 👁️ 断罪
  if ((s.zeroCuts || 0) >= 1) out.push('zerocut');      // 封印を破るとどめ
  if ((s.zeroNamed || 0) >= 50) out.push('zeronamed');  // 名指しされた回数（負け側の勲章）
  if (has('zero7')) out.push('zeroseven');
  if ((s.aePlays || 0) >= 10) out.push('guest');
  // 到達したら剥がれない称号にする。現在連勝（s.winStreak）だけを見ていたので、
  // ランクマッチで1敗した瞬間に獲得済みの「連勝街道」が未獲得に戻り、
  // /api/titles/equip の 403 で二度と付け直せなくなっていた（装備したままなら
  // 表示は残るのに、インベントリではロック表示、という食い違いも起きる）。
  // 説明文は「ランクマッチ5連勝」＝到達条件。実績側（achievements.js）と
  // 連続ログイン称号（loginStreakBest）は既に最高値基準なので、そこに揃える。
  // winStreakBest は後から足したフィールドなので、連勝中の既存アカウントが
  // winStreakBest=0 / winStreak>0 になりうる。Math.max で両方を見る。
  if (Math.max(s.winStreakBest || 0, s.winStreak || 0) >= 5) out.push('streak5');
  if (Math.max(s.ratingBest || 0, s.rating) >= 1500) out.push('diamond');
  if (Math.max(s.ratingBest || 0, s.rating) >= 1700) out.push('grandmaster');
  if (s.gamesPlayed >= 200) out.push('veteran');
  if (s.maxCombo >= 15) out.push('combo15');
  if (s.bestScore >= 300000) out.push('score300k');
  if ((s.totalLines || 0) >= 5000) out.push('liner');
  if (s.pvpWins >= 50) out.push('pvp50');
  if ((s.dungeonMax || 0) >= 50) out.push('explorer');
  if (has('dungeon')) out.push('towerlord');
  if ((s.ultsUsed || 0) >= 100) out.push('ultimate');
  if ((s.ultsUsed || 0) >= 500) out.push('ultgod');
  if ((s.missionsDone || 0) >= 50) out.push('missionman');
  if ((s.missionsDone || 0) >= 300) out.push('missiongod');
  if ((user.achievements || []).length >= 20) out.push('achiever');
  if ((user.achievements || []).length >= 40) out.push('completionist');
  if ((s.loginStreakBest || 0) >= 7) out.push('loyal7');
  if ((s.loginStreakBest || 0) >= 30) out.push('loyal30');
  if ((s.survivalWave || 0) >= 20) out.push('survivor');
  if ((s.totalScore || 0) >= 1000000) out.push('millionaire');
  if (((s.sprint && s.sprint.s60) || 0) >= 20000) out.push('sprinter');
  if ((s.coopPlays || 0) >= 10) out.push('buddy');
  if ((s.coopBest || 0) >= 20000) out.push('soulmate');
  if ((s.abyssMax || 0) >= 50) out.push('abysswalker');
  if (has('abyss')) out.push('abysslord');
  if (user.guildFounded) out.push('guildfounder');
  if ((s.guildBestWeek || 0) >= 2000) out.push('guildace');
  if (has('weekly1')) out.push('weeklyking');
  if (BOSSES.every(b => (s.bossRanks || {})[b.id] === 'S')) out.push('bossmaster');
  if ((s.rushDepth || 0) >= 12) out.push('hellrunner');
  if ((s.puzzleStage || 0) >= 30) out.push('ruinsage');
  if ((s.digDepth || 0) >= 50) out.push('miner');
  if ((s.gachaPulls || 0) >= 100) out.push('gachaprince');
  if ((s.chatMessages || 0) >= 300) out.push('lobbyface');
  if ((s.ghostBest || 0) >= 15000) out.push('ghostmaster');
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
