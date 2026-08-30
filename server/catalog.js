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
  // 2,500 と 3,500 のあいだが空いていた中価格帯。派手に消す奥義ではなく
  // 「散らかった盤面を整える」性格なので、この位置がちょうどいい。
  { id: 'ult_gravity',   cat: 'ult', icon: '🧲', name: '重力圧縮',       desc: '盤面を下へ圧縮し、そろった行を消す。散らかった盤面を片づけるのは自分の腕', price: 3000, currency: 'coins' },
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
// ---- Boss signature techniques (ボス専用技) ----
// The generic patterns (garbage / quake / breath_row / laser_col / curse_hand)
// are declared client-side in modes.js (BOSS_MOVES). A *signature* move belongs
// to exactly ONE boss, so its tuning lives here instead — the catalog stays the
// single source of truth and the numbers ride along to the client on the boss
// object itself (`boss.techs`, shipped by GET /api/bosses, which spreads each
// entry). modes.js only has to dispatch on the move id.
//   Shape: { id, name, nameEn, telegraph, ...params, msg/msgEn strings }
// The `${boss.emoji}` prefix used by the existing move toasts is added by the
// caller, exactly like BOSS_MOVES lines do — these strings carry no emoji of
// their own except the technique's own 🧊.
export const BOSS_TECHNIQUES = {
  // 🧊 絶対零度 — 氷雪女王フリオーネ専用。予告つき（＝赤マスをラインで切れば
  // 防げる）で、着弾したマスは「氷結ブロック」になる。お邪魔(9)より厄介で、
  // iceHp 回のライン消しに耐える想定。実処理は modes.js のボス技ハンドラ。
  freeze: {
    id: 'freeze',
    boss: 'frost',
    name: '絶対零度',
    nameEn: 'Absolute Zero',
    telegraph: true,          // BOSS_MOVES と同じ意味：予告 → 赤マス → 着弾
    cells: 5,                 // フェーズ1で氷結させる空きマス数
    cells2: 8,                // フェーズ2（HP50%以下）で氷結させる空きマス数
    iceHp: 2,                 // 氷が割れるまでに必要なライン消し回数（1=通常ブロック相当）
    cellValue: 5,             // 盤面に書き込む色番号。PALETTE[5]=シアンで氷に見える
                              // （専用スロットを足すなら public/js/themes.js が必要 — 担当外）
    shake: 16,                // view.shake に渡す推奨値
    flash: 0.35,              // view.screenFlash に渡す推奨値
    telegraphMsg:   '⚠️ 絶対零度の予告！赤マスをラインで切れ！',
    telegraphMsgEn: '⚠️ Absolute Zero incoming! Cut the red cells with a line!',
    hitMsg:         '🧊 絶対零度！盤面が凍りついた',
    hitMsgEn:       '🧊 Absolute Zero! The board freezes over',
    cutMsg:         '🧊 絶対零度を斬った！',
    cutMsgEn:       '🧊 You cut through Absolute Zero!',
  },
};

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
  // 看板ボスなので専用技 freeze（絶対零度）持ち。techs は BOSS_TECHNIQUES の
  // 同じオブジェクトを指しているだけ（/api/bosses でそのままクライアントへ）。
  // modes.js が freeze を未対応の間は BOSS_MOVES のフォールバックで
  // お邪魔弾扱いになるだけなので、既存プレイは壊れない。
  { id: 'frost',  name: '氷雪女王フリオーネ', nameEn: 'Frost Queen Frione', emoji: '🧊', hp: 60000, atkSec: 8, atkCells: 7, gemsFirst: 500,
    moves: ['garbage', 'curse_hand', 'freeze'], moves2: ['garbage', 'curse_hand2', 'breath_row', 'freeze'], atk2: 0.7,
    techs: { freeze: BOSS_TECHNIQUES.freeze } },
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
  // 🕳️ 隠し称号。条件はあえてぼかしてある（何回で取れるかは書かない）。
  // 全消し「昇華」を50回。ghostmaster と同じく、説明が達成のヒントを兼ねる。
  { id: 'voidseeker', name: '無の求道者',     color: '#7c3aed', desc: '盤面を空にした回数が一定に達した' },
  // 📕 コレクション図鑑のセットコンプ報酬（COLLECTION_SETS 参照）
  { id: 'ultcollector', name: '奥義蒐集家',   color: '#43d9e8', desc: '奥義をすべて集める' },
  { id: 'rainbowtrio',  name: '虹の三種',     color: '#ff6bd4', desc: 'ガチャ限定の装備をすべて集める' },
  { id: 'thronekeeper', name: '宝物庫の主',   color: '#ffd75e', desc: '👑王座の宝物庫の品をすべて集める' },
  { id: 'curator',      name: '図鑑の完成者', color: '#fff3b0', desc: '図鑑をすべて埋める' },
];

// ---- 📕 コレクション図鑑（セットコンプ報酬） ----
// 対象アイテムは必ずカタログから導出する。id を直書きすると、新しいスキンを
// 1つ足した日に「全種コンプ」が静かに嘘になり、しかも誰も気づけない
// （achievements.js の COLLECTIBLE_MAX が同じ理由で導出になっている）。
//
// kind でどこを見るかが決まる:
//   item  … user.owned      （買った装備。減らない）
//   boost … user.items[id]>0（消費品。使うと在庫が0になりうる）
//   badge … user.badges
//   title … earnedTitles(user)

// 一般プレイヤーが普通に買える装備（管理者専用・ガチャ限定・王座限定を除く）。
const normalGear = cat => SHOP_ITEMS
  .filter(i => i.cat === cat && !i.adminOnly && !i.gachaOnly && !i.throneOnly)
  .map(i => i.id);

const cset = (id, icon, kind, ids, name, nameEn, desc, descEn, coins, gems, title = null) =>
  ({ id, icon, kind, ids, name, nameEn, desc, descEn, coins, gems, title });

export const COLLECTION_SETS = [
  cset('set_skin',  '🎨', 'item', normalGear('skin'),
    'スキン全種', 'Skin Collection', 'ブロックスキンをすべて集める', 'Own every block skin', 6000, 50),
  cset('set_board', '🖼️', 'item', normalGear('board'),
    'ボード全種', 'Board Collection', 'ボードテーマをすべて集める', 'Own every board theme', 6000, 50),
  cset('set_fx',    '✨', 'item', normalGear('fx'),
    'エフェクト全種', 'Effect Collection', '消去エフェクトをすべて集める', 'Own every clear effect', 5000, 40),
  cset('set_ult',   '⚡', 'item', normalGear('ult'),
    '奥義全種', 'Arts Collection', 'アルティメットをすべて集める', 'Own every ultimate skill', 8000, 70, 'ultcollector'),
  cset('set_boost', '🎒', 'boost', BOOST_ITEMS.filter(i => !i.adminOnly).map(i => i.id),
    '道具棚コンプ', 'Booster Shelf', 'ブースターを1個以上ずつ持つ', 'Hold at least one of every booster', 1500, 12),
  cset('set_gacha', '🎰', 'item', SHOP_ITEMS.filter(i => i.gachaOnly).map(i => i.id),
    'ガチャ限定コンプ', 'Gacha Exclusives', 'ガチャ限定の装備をすべて集める', 'Own all gacha-exclusive gear', 10000, 90, 'rainbowtrio'),
  cset('set_throne', '👑', 'item', THRONE_ITEMS.map(i => i.id),
    '王座の宝物庫コンプ', 'The Throne Vault', '👑王座の欠片で交換できる品をすべて集める', 'Own every item from the 👑 vault', 15000, 150, 'thronekeeper'),
  cset('set_trial', '⚔️', 'badge', ['oni', 'kami', 'souzou'],
    '三難関の証', 'Marks of the Three Trials', '鬼・神・創造神のバッジを集める', 'Earn the Oni, Kami and Creator God badges', 5000, 40),
  cset('set_slayer', '🗡️', 'title', ['bosshunt', 'maoslayer', 'rushhero'],
    '討伐者の称号', 'Slayer Titles', 'ボス討伐の称号をすべて得る', 'Earn every boss-slaying title', 4000, 30),
  // 図鑑そのもの。管理者専用だけを除いた全装備（ガチャ限定・王座限定も含む）。
  cset('set_master', '📕', 'item', SHOP_ITEMS.filter(i => !i.adminOnly).map(i => i.id),
    '図鑑コンプリート', 'Full Catalog', 'カタログの装備をすべて集める', 'Own every item in the catalog', 30000, 300, 'curator'),
];

// セットのうち、いま所持している id。純粋関数。
function collectionOwnedIds(user, set) {
  if (!user) return [];
  if (set.kind === 'boost') {
    const stock = user.items || {};
    return set.ids.filter(id => (Number(stock[id]) || 0) > 0);
  }
  if (set.kind === 'badge') {
    const badges = user.badges || [];
    return set.ids.filter(id => badges.includes(id));
  }
  if (set.kind === 'title') {
    const earned = earnedTitles(user);
    return set.ids.filter(id => earned.includes(id));
  }
  const owned = user.owned || [];
  return set.ids.filter(id => owned.includes(id));
}

function collectionSetDone(user, set) {
  return set.ids.length > 0 && collectionOwnedIds(user, set).length >= set.ids.length;
}

// 図鑑の中身。各セットの所持数/総数と、まだ足りない id を返す純粋関数
// （user は一切書き換えない）。API も画面もここを読めば足りる。
export function collectionProgress(user) {
  const claimed = new Set((user && user.collections) || []);
  return COLLECTION_SETS.map(set => {
    const ownedIds = collectionOwnedIds(user, set);
    const title = set.title ? TITLES.find(t => t.id === set.title) : null;
    return {
      id: set.id, icon: set.icon, kind: set.kind,
      name: set.name, nameEn: set.nameEn, desc: set.desc, descEn: set.descEn,
      ids: set.ids, ownedIds,
      missing: set.ids.filter(id => !ownedIds.includes(id)),
      owned: ownedIds.length, total: set.ids.length,
      done: ownedIds.length >= set.ids.length && set.ids.length > 0,
      claimed: claimed.has(set.id),
      coins: set.coins, gems: set.gems,
      title: set.title, titleName: title ? title.name : null,
    };
  });
}

// 図鑑タブ1画面ぶんのまとめ。GET /api/collection はこれをそのまま返せばよい。
export function collectionView(user) {
  const sets = collectionProgress(user);
  const owned = sets.reduce((n, s) => n + s.owned, 0);
  const total = sets.reduce((n, s) => n + s.total, 0);
  return {
    sets,
    done: sets.filter(s => s.done).length,
    claimable: sets.filter(s => s.done && !s.claimed).length,
    claimed: sets.filter(s => s.claimed).length,
    total: sets.length,
    // 収集率（全セットの合計。図鑑の見出しに出す用）
    owned, slots: total,
    rate: total ? Math.round((owned / total) * 100) : 0,
  };
}

// セットコンプ報酬の受け取り（id が '*' なら受け取れるものを全部）。
// 報酬額は必ずここで COLLECTION_SETS から計算する ── クライアントの申告は
// 一切見ない。user.collections が二重受取を止める唯一のフラグ。
export function claimCollection(user, id) {
  if (!Array.isArray(user.collections)) user.collections = [];
  const claimed = new Set(user.collections);
  const ready = collectionProgress(user)
    .filter(r => (id === '*' || r.id === id) && r.done && !claimed.has(r.id));
  if (!ready.length) {
    return { error: id === '*' ? '受け取れるセットがありません' : 'まだコンプしていないか、受け取り済みです' };
  }
  let coins = 0, gems = 0;
  const titles = [];
  for (const r of ready) {
    user.collections.push(r.id);
    coins += r.coins;
    gems += r.gems;
    if (r.title) titles.push(r.title);
  }
  user.coins = (user.coins || 0) + coins;
  user.gems = (user.gems || 0) + gems;
  return { coins, gems, titles, ids: ready.map(r => r.id) };
}

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
  // 全消し「昇華」の通算回数。統計は減らないので、一度取れば剥がれない。
  if ((s.perfectClears || 0) >= 50) out.push('voidseeker');
  // 📕 図鑑のセットコンプ称号。所持装備は減らないのでコンプ自体が剥がれることは
  // ないが、受け取り済み（user.collections）も無条件に認める ── 消費できる
  // ブースターを含むセットに将来称号を付けても、在庫を使い切った瞬間に
  // 獲得済みの称号が未獲得へ戻る（そして 403 で二度と装備できなくなる）
  // 事故が起きないように。streak5 で実際に踏んだのと同じ穴。
  // kind:'title' のセットはここから外す。判定に earnedTitles を使うので、
  // 称号報酬を付けると自分自身を呼び戻して無限再帰になる。
  const claimedSets = new Set(user.collections || []);
  for (const set of COLLECTION_SETS) {
    if (!set.title || set.kind === 'title') continue;
    if (claimedSets.has(set.id) || collectionSetDone(user, set)) out.push(set.title);
  }
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
