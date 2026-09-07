// Achievements (実績) — permanent, one-time goals evaluated from user stats.
// Progress is derived (never stored), so old accounts get credit retroactively;
// only the *claimed* list lives on the user record.

import { SHOP_ITEMS, isCollectibleGear } from './catalog.js';

const a = (id, icon, cat, goal, coins, gems, name, nameEn, desc, descEn, value) =>
  ({ id, icon, cat, goal, coins, gems, name, nameEn, desc, descEn, value });

// 収集系の上限は「一般プレイヤーが実際に持てるアイテム数」。
// ここを数字で直書きしていたせいで、カタログを削ったあと目標45に対して
// 実際は37種しか存在しない状態になり、この実績だけは誰にも達成できず、
// 進捗バーが 37/45 で永久に止まっていた。しかも理由はゲーム内のどこにも
// 書かれていないので、コンプリートを目指す人は原因不明のまま詰む。
// カタログから導出しておけば、今後アイテムが増減しても勝手に追従する。
//
// ⚠ 導出する式を**ここに手書きしていた**（`!i.adminOnly` だけ）ため、図鑑の
//   母数（catalog.js の isCollectibleGear）と食い違っていた。実測で
//   実績は 72種、図鑑は 51種 ── 同じ「集めきる」を数える2つの画面が
//   21種ずれていた。差は 既定4種・王座専用7種・交換所限定10種。
//   しかも進捗は owned.length（＝既定も王座も交換所も込みの丸ごとの数）
//   だったので、母数と分子で数えているものが最初から別だった。
//   catalog.js:139 が「判定はここにしか書かない」と言っているのは
//   まさにこの形の事故のこと。述語を輸入して、分子も同じ物差しで数える。
const COLLECTIBLE = SHOP_ITEMS.filter(isCollectibleGear);
const COLLECTIBLE_IDS = new Set(COLLECTIBLE.map(i => i.id));
const COLLECTIBLE_MAX = COLLECTIBLE.length;
/** 図鑑に数える品だけを、所持品の中から数える。 */
const collectedCount = u => (u.owned || []).reduce((n, id) => n + (COLLECTIBLE_IDS.has(id) ? 1 : 0), 0);

const S = u => u.stats || {};
const has = (u, b) => (u.badges || []).includes(b);

// 📈 実績は「一度でも届いたか」で決まる。
//
// レート・所持コイン・ギルド在籍は**いま**の値なので、そのまま条件にすると
// 1敗しただけ・買い物をしただけ・ギルドを抜けただけで解除が取り消され、
// 進捗バーが逆走する。未受取のまま条件を割ると 900🪙+7💎 〜 12,000🪙+100💎 が
// 取れなくなる ── 称号側（catalog.js）は同じ事故のあと Math.max(◯Best, いま)
// に直してあり、そのコメントは「実績側は既に最高値基準」と書いているが、
// 事実は逆だった。ここで揃える。
const bestRating = u => Math.max(S(u).ratingBest || 0, S(u).rating || 0);
const bestCoins = u => Math.max(S(u).coinsBest || 0, u.coins || 0);
// ギルドは最高値が無いので「一度でも入ったか」の印を見る（在籍中も真）。
const everJoinedGuild = u => (u.guildId || S(u).guildJoinedEver) ? 1 : 0;

export const ACH_CATS = [
  { id: 'play',    name: 'プレイ',   nameEn: 'Play' },
  { id: 'score',   name: 'スコア',   nameEn: 'Score' },
  { id: 'battle',  name: '対戦',     nameEn: 'Battle' },
  { id: 'explore', name: '探索',     nameEn: 'Explore' },
  { id: 'collect', name: '収集',     nameEn: 'Collection' },
  { id: 'legend',  name: '伝説',     nameEn: 'Legend' },
];

export const ACHIEVEMENTS = [
  // ---- プレイ ----
  a('ach_play1',    'mode_solo', 'play', 1,     200,  1,  'はじめの一歩',   'First Step',       '1回プレイする',        'Play 1 game',            u => S(u).gamesPlayed || 0),
  a('ach_play25',   'mode_solo', 'play', 25,    500,  3,  '常連プレイヤー', 'Regular',          '25回プレイする',       'Play 25 games',          u => S(u).gamesPlayed || 0),
  a('ach_play100',  'mode_solo', 'play', 100,   1200, 8,  '百戦の記憶',     'A Hundred Games',  '100回プレイする',      'Play 100 games',         u => S(u).gamesPlayed || 0),
  a('ach_play500',  'mode_solo', 'play', 500,   4000, 30, '不屈の挑戦者',   'Unyielding',       '500回プレイする',      'Play 500 games',         u => S(u).gamesPlayed || 0),
  a('ach_lines500', 'lines', 'play', 500,   600,  4,  'ライン職人見習い', 'Apprentice Liner', '累計500ライン消去',   'Clear 500 lines total',  u => S(u).totalLines || 0),
  a('ach_lines5k',  'lines', 'play', 5000,  2500, 18, 'ライン職人',     'Line Artisan',     '累計5,000ライン消去',  'Clear 5,000 lines total', u => S(u).totalLines || 0),
  a('ach_lines20k', 'lines', 'play', 20000, 8000, 60, 'ライン神',       'Line Deity',       '累計20,000ライン消去', 'Clear 20,000 lines total', u => S(u).totalLines || 0),
  a('ach_login7',   'calendar', 'play', 7,     900,  6,  '七日間の習慣',   'Seven-Day Habit',  '7日連続ログイン',      'Log in 7 days in a row', u => S(u).loginStreakBest || 0),
  a('ach_login30',  'calendar', 'play', 30,    4000, 35, '一ヶ月の絆',     'A Month Together', '30日連続ログイン',     'Log in 30 days in a row', u => S(u).loginStreakBest || 0),

  // ---- スコア ----
  a('ach_score10k', 'star', 'score', 10000,  300,  2,  '一万点突破',   'Ten Thousand',    '1ゲームで10,000点',  'Score 10,000 in one game',  u => S(u).bestScore || 0),
  a('ach_score50k', 'star', 'score', 50000,  800,  6,  '五万点突破',   'Fifty Thousand',  '1ゲームで50,000点',  'Score 50,000 in one game',  u => S(u).bestScore || 0),
  a('ach_score100k','star', 'score', 100000, 1500, 12, '十万点の壁',   'The 100K Wall',   '1ゲームで100,000点', 'Score 100,000 in one game', u => S(u).bestScore || 0),
  a('ach_score300k','star', 'score', 300000, 4000, 30, '三十万の伝説', 'Legend of 300K',  '1ゲームで300,000点', 'Score 300,000 in one game', u => S(u).bestScore || 0),
  a('ach_total1m',  'money', 'score', 1000000, 3000, 25, '億万長者への道', 'Road to Riches', '累計スコア1,000,000', 'Reach 1,000,000 total score', u => S(u).totalScore || 0),
  a('ach_combo5',   'fire', 'score', 5,   300,  2,  'コンボの芽',   'Combo Spark',     '5コンボ達成',        'Land a 5 combo',            u => S(u).maxCombo || 0),
  a('ach_combo10',  'fire', 'score', 10,  900,  7,  'コンボマスター', 'Combo Master',   '10コンボ達成',       'Land a 10 combo',           u => S(u).maxCombo || 0),
  a('ach_combo15',  'fire', 'score', 15,  2200, 16, 'コンボの神域', 'Combo Divinity',  '15コンボ達成',       'Land a 15 combo',           u => S(u).maxCombo || 0),
  a('ach_combo20',  'combo', 'score', 20,  6000, 45, 'コンボ超越者', 'Combo Transcendent', '20コンボ達成',    'Land a 20 combo',           u => S(u).maxCombo || 0),

  // ---- 対戦 ----
  a('ach_ai1',      'mode_ai', 'battle', 1,    250,  2,  'AI撃破',       'AI Slayer',        'AIに1回勝つ',        'Beat the AI once',        u => S(u).aiWins || 0),
  a('ach_ai25',     'mode_ai', 'battle', 25,   1200, 9,  'AIキラー',     'AI Killer',        'AIに25回勝つ',       'Beat the AI 25 times',    u => S(u).aiWins || 0),
  a('ach_pvp1',     'mode_online', 'battle', 1,    400,  3,  '初勝利',       'First Blood',      'オンラインで1勝',     'Win 1 online battle',     u => S(u).pvpWins || 0),
  a('ach_pvp10',    'mode_online', 'battle', 10,   1000, 8,  '常勝将軍',     'Undefeated',       'オンラインで10勝',    'Win 10 online battles',   u => S(u).pvpWins || 0),
  a('ach_pvp50',    'mode_online', 'battle', 50,   3500, 28, '百戦錬磨',     'Battle-Hardened',  'オンラインで50勝',    'Win 50 online battles',   u => S(u).pvpWins || 0),
  a('ach_streak5',  'mode_chain', 'battle', 5,    1500, 12, '連勝街道',     'Streak Rider',     'ランクマ5連勝',       'Win 5 ranked in a row',   u => S(u).winStreakBest || S(u).winStreak || 0),
  a('ach_rate1200', 'rating', 'battle', 1200, 900,  7,  'レジェンド',   'Legend',           'レート1200到達',      'Reach 1200 rating',       u => bestRating(u)),
  a('ach_rate1500', 'gems', 'battle', 1500, 2500, 20, 'ダイヤの誇り', 'Diamond Pride',    'レート1500到達',      'Reach 1500 rating',       u => bestRating(u)),
  a('ach_rate1700', 'rating', 'battle', 1700, 6000, 50, '頂のマスター', 'Peak Master',      'レート1700到達',      'Reach 1700 rating',       u => bestRating(u)),
  a('ach_tourney',  'leaderboard', 'battle', 1,    3000, 25, '大会王者',     'Tournament King',  'トーナメント優勝',     'Win a tournament',        u => has(u, 'tourney') ? 1 : 0),
  a('ach_royale',   'mode_royale', 'battle', 1,    3000, 25, '百人の頂点',   'Apex of 100',      'バトルロイヤル1位',    'Take #1 in Battle Royale', u => has(u, 'royale') ? 1 : 0),
  // v2.11 — battle royale grew a whole progression, so it gets goals that are
  // reachable without winning outright.
  a('ach_rl_top10', 'achievement', 'battle', 5,    1200, 9,  'ロワの常連',   'Royale Regular',   'バトルロイヤルでTOP10入り5回', 'Finish top 10 in Battle Royale 5 times', u => S(u).royaleTop10 || 0),
  a('ach_rl_ko10',  'skull', 'battle', 10,   1500, 12, '狩る者',       'The Hunter',       'バトルロイヤルで通算10KO', 'Knock out 10 rivals in Battle Royale', u => S(u).royaleKills || 0),
  a('ach_rl_ko3',   'cut', 'battle', 3,    2000, 16, '一狩り三殺',   'Triple Threat',    '1試合で3KO', 'Knock out 3 rivals in a single Battle Royale', u => S(u).royaleBestKills || 0),
  a('ach_rl_50',    'mode_royale', 'battle', 50,   3000, 24, '百戦のロワイヤル', 'Royale Veteran', 'バトルロイヤルに50回参加', 'Enter Battle Royale 50 times', u => S(u).royalePlays || 0),
  // v2.11 — 👑 管理者イベント
  a('ach_ae_join',  'mode_adminevent', 'battle', 1,    800,  6,  '招かれし者',   'Invited',          '管理者イベントに参加', 'Take part in an Admin Event', u => S(u).aePlays || 0),
  a('ach_ae_10',    'mode_adminevent', 'battle', 10,   2500, 20, '常連の来賓',   'Honoured Guest',   '管理者イベントで10回プレイ', 'Play 10 Admin Event runs', u => S(u).aePlays || 0),
  a('ach_ae_clear', 'hall', 'battle', 1,    4000, 32, '管理者イベント制覇', 'Event Conqueror', '管理者イベントの目標を達成', 'Complete an Admin Event objective', u => has(u, 'adminevent') ? 1 : 0),

  // ---- 探索 ----
  a('ach_boss1',    'mode_boss', 'explore', 1,   400,  3,  'ボス初討伐',   'First Kill',       'ボスを1体討伐',       'Defeat 1 boss',           u => S(u).bossMax || 0),
  a('ach_boss4',    'boss_maou', 'explore', 6,   2000, 16, '魔王を討ちし者', 'Demon Lord Slayer', '全6ボスを討伐',      'Defeat all 6 bosses',     u => S(u).bossMax || 0),
  a('ach_rush',     'mode_boss', 'explore', 1,   2500, 20, 'ボスラッシュ制覇', 'Rush Conqueror', 'ボスラッシュクリア', 'Clear Boss Rush',         u => has(u, 'rush') ? 1 : 0),
  a('ach_dun10',    'mode_dungeon', 'explore', 10,  500,  4,  '塔の来訪者',   'Tower Visitor',    'ダンジョンF10到達',    'Reach dungeon F10',       u => S(u).dungeonMax || 0),
  a('ach_dun50',    'mode_dungeon', 'explore', 50,  2000, 16, '塔の探検家',   'Tower Explorer',   'ダンジョンF50到達',    'Reach dungeon F50',       u => S(u).dungeonMax || 0),
  a('ach_dun100',   'badge_dungeon', 'explore', 100, 8000, 70, '百塔の覇者',   'Lord of 100 Floors', 'ダンジョンF100制覇', 'Conquer dungeon F100',    u => S(u).dungeonMax || 0),
  a('ach_wave10',   'mode_survival', 'explore', 10,  800,  6,  '生存者',       'Survivor',         'サバイバルW10到達',    'Reach Survival wave 10',  u => S(u).survivalWave || 0),
  a('ach_wave20',   'mode_survival', 'explore', 20,  2800, 22, '生存本能',     'Survival Instinct', 'サバイバルW20到達',   'Reach Survival wave 20',  u => S(u).survivalWave || 0),
  a('ach_oni',      'badge_oni', 'explore', 1,   1500, 12, '鬼退治',       'Oni Slayer',       '難易度「鬼」に勝利',   'Beat "Oni" difficulty',   u => has(u, 'oni') ? 1 : 0),
  a('ach_kami',     'badge_kami', 'explore', 1,   4000, 35, '神殺し',       'God Slayer',       '難易度「神」に勝利',   'Beat "Kami" difficulty',  u => has(u, 'kami') ? 1 : 0),
  a('ach_souzou',   'badge_souzou', 'explore', 1,   10000, 90, '創造を超えし者', 'Beyond Creation', '難易度「創造神」に勝利', 'Beat "Creator God"',     u => has(u, 'souzou') ? 1 : 0),

  // ---- 収集 ----
  // ⚠ 分子は collectedCount（図鑑に数える品だけ）。`owned.length` だと
  //   既定装備4点・王座専用7点・交換所限定10点まで数えるので、新規アカウントが
  //   交換所で1点引き換えるだけで「5種所持」が達成になる（図鑑側は 1/51 のまま）。
  //   v2.70 で ach_own45 だけ直して、この3つが取り残されていた。
  a('ach_own5',     'gift', 'collect', 5,   500,  4,  'コレクター見習い', 'Novice Collector', 'アイテムを5種所持',  'Own 5 catalog items',    collectedCount),
  a('ach_own15',    'gift', 'collect', 15,  1800, 14, 'コレクター',   'Collector',        'アイテムを15種所持',   'Own 15 catalog items',    collectedCount),
  a('ach_own30',    'collection', 'collect', 30,  5000, 45, '大コレクター', 'Grand Collector',  'アイテムを30種所持',   'Own 30 catalog items',    collectedCount),
  a('ach_coins10k', 'coins', 'collect', 10000, 1000, 8, '大富豪',      'Tycoon',           'コインを10,000所持',   'Hold 10,000 coins',       u => bestCoins(u)),
  a('ach_lv10',     'level_up', 'collect', 10,  800,  6,  'レベル10',     'Level 10',         'レベル10に到達',      'Reach level 10',          u => 1 + Math.floor((u.xp || 0) / 1000)),
  a('ach_lv30',     'level_up', 'collect', 30,  3000, 25, 'レベル30',     'Level 30',         'レベル30に到達',      'Reach level 30',          u => 1 + Math.floor((u.xp || 0) / 1000)),

  // ---- 探索（新モード） ----
  a('ach_sprint1',  'clock', 'explore', 1,     300,  2,  'ヨーイドン',   'On Your Marks',    'タイムアタック初挑戦',  'Play Time Attack once',   u => S(u).sprintPlays || 0),
  a('ach_sprint10k','clock', 'explore', 10000, 900,  7,  '瞬発力',       'Quick Draw',       'TA 60秒で10,000点',    'Score 10,000 in a 60s run', u => (S(u).sprint && S(u).sprint.s60) || 0),
  a('ach_sprint25k','mode_sprint', 'explore', 25000, 3000, 25, '光速のブロッカー', 'Speed of Light', 'TA 60秒で25,000点',   'Score 25,000 in a 60s run', u => (S(u).sprint && S(u).sprint.s60) || 0),
  a('ach_coop1',    'mode_coop', 'explore', 1,     400,  3,  'いい相棒',     'Good Partner',     '協力プレイ初挑戦',      'Play co-op once',         u => S(u).coopPlays || 0),
  a('ach_coop10',   'mode_coop', 'explore', 10,    1600, 13, '名コンビ',     'Great Duo',        '協力プレイを10回',      'Play 10 co-op runs',      u => S(u).coopPlays || 0),
  a('ach_coop20k',  'heart', 'explore', 20000, 2600, 22, '以心伝心',     'In Perfect Sync',  '協力で20,000点',       'Reach 20,000 in co-op',   u => S(u).coopBest || 0),

  a('ach_abyss10',  'mode_abyss', 'explore', 10,    1500, 12, '深淵の入口',   'Edge of the Abyss', '深淵 A10到達',          'Reach Abyss A10',         u => S(u).abyssMax || 0),
  a('ach_abyss50',  'mode_abyss', 'explore', 50,    5000, 45, '深淵を覗きし者', 'Abyss Walker',    '深淵 A50到達',          'Reach Abyss A50',         u => S(u).abyssMax || 0),
  a('ach_abyss100', 'badge_under', 'explore', 100,   20000, 200, '深淵の支配者', 'Lord of the Abyss', '深淵 A100制覇',       'Conquer Abyss A100',      u => S(u).abyssMax || 0),
  a('ach_guild',    'guild', 'collect', 1,     500,  4,  'ギルド加入',   'Guild Member',     'ギルドに加入する',      'Join a guild',            u => everJoinedGuild(u)),
  a('ach_guild2k',  'guild', 'collect', 2000,  2000, 16, 'ギルドのエース', 'Guild Ace',      'ギルドに週2,000pt貢献', 'Contribute 2,000 pts in a week', u => S(u).guildBestWeek || 0),

  // ---- 伝説（アルティメット & ミッション） ----
  a('ach_ult1',     'ultimate', 'legend', 1,    300,  2,  '奥義開眼',     'Awakening',        'アルティメット初発動',  'Use your first ultimate', u => S(u).ultsUsed || 0),
  a('ach_ult100',   'ultimate', 'legend', 100,  2500, 20, '極意の継承者', 'Heir of Mastery',  'アルティメット100回',   'Use 100 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_ult500',   'star', 'legend', 500,  9000, 80, '奥義を極めし者', 'Grand Master',   'アルティメット500回',   'Use 500 ultimates',       u => S(u).ultsUsed || 0),
  // ⚠ missionsDone を増やすのは claimMission（受け取り処理）の1か所だけで、
  //   達成しても受け取らなければ増えない（日が変わると未受取の達成は消える）。
  //   説明が「クリア」だったので、ミッション画面の「達成 3/3」を見た人には
  //   条件を満たしているのに進まない実績に見えていた。同じ値を読む
  //   ach_ach50（「実績を50個**受け取る**」）の言い方に揃える。
  a('ach_mis10',    'missions', 'legend', 10,   600,  5,  '任務開始',     'On Duty',          'ミッション報酬を10個受け取る',  'Claim 10 mission rewards',    u => S(u).missionsDone || 0),
  a('ach_mis50',    'missions', 'legend', 50,   2200, 18, '任務遂行者',   'Mission Runner',   'ミッション報酬を50個受け取る',  'Claim 50 mission rewards',    u => S(u).missionsDone || 0),
  a('ach_mis300',   'missions', 'legend', 300,  9000, 80, 'ミッションの鬼', 'Mission Demon',  'ミッション報酬を300個受け取る', 'Claim 300 mission rewards',   u => S(u).missionsDone || 0),

  // ==== v2.6 不滅アップデート: +37種で全100種 ====================================
  // ---- プレイ ----
  a('ach_play1000', 'mode_solo', 'play', 1000,  8000, 60, '千戦の勇者',   'Thousand Battles', '1,000回プレイする',     'Play 1,000 games',          u => S(u).gamesPlayed || 0),
  a('ach_pieces50k','block', 'play', 50000, 2000, 15, 'ブロックの海',  'Sea of Blocks',    '累計50,000ピース設置',  'Place 50,000 pieces',        u => S(u).piecesPlaced || 0),
  a('ach_time24h',  'perk_slow', 'play', 86400, 3000, 25, 'まる一日',      'A Full Day',       '累計プレイ24時間',      'Play for 24 hours total',    u => S(u).playSecs || 0),
  a('ach_wins100',  'achievement', 'play', 100,   1500, 12, '勝利の常連',    'Winning Regular',  '累計100勝する',         'Win 100 games total',        u => S(u).totalWins || 0),
  a('ach_login100', 'calendar', 'play', 100,   5000, 45, '百日の旅路',    'Hundred Days',     '通算100日ログイン',     'Log in on 100 different days', u => S(u).dailyLogins || 0),

  // ---- スコア ----
  a('ach_score500k','star', 'score', 500000,   8000,  70,  '五十万の彼方', 'Beyond 500K',     '1ゲームで500,000点',    'Score 500,000 in one game',  u => S(u).bestScore || 0),
  a('ach_total10m', 'money', 'score', 10000000, 9000,  80,  '一千万の軌跡', 'Ten Million Trail', '累計スコア10,000,000', 'Reach 10,000,000 total score', u => S(u).totalScore || 0),
  a('ach_combo30',  'combo', 'score', 30,       12000, 100, 'コンボの化身', 'Combo Incarnate',  '30コンボ達成',         'Land a 30 combo',            u => S(u).maxCombo || 0),

  // ---- 対戦 ----
  a('ach_pvp100',   'mode_online', 'battle', 100,  6000,  50,  '闘神',         'War God',          'オンラインで100勝',     'Win 100 online battles',    u => S(u).pvpWins || 0),
  a('ach_streak10', 'mode_chain', 'battle', 10,   4000,  35,  '無敗の風',     'Unbeaten Wind',    'ランクマ10連勝',        'Win 10 ranked in a row',    u => S(u).winStreakBest || S(u).winStreak || 0),
  a('ach_rate1900', 'rank_master', 'battle', 1900, 12000, 100, '孤高の頂',     'Lonely Summit',    'レート1900到達',        'Reach 1900 rating',         u => bestRating(u)),
  a('ach_weekly1',  'leaderboard', 'battle', 1,    3000,  25,  '週間王者',     'Weekly Champion',  '週間ランキング1位',     'Take #1 in the weekly ranking', u => has(u, 'weekly1') ? 1 : 0),

  // ---- 探索 ----
  a('ach_melt100k', 'mode_meltdown', 'explore', 100000, 1200, 9,  '臨界寸前',     'Near Critical',    'メルトダウンで100,000点', 'Score 100,000 in Meltdown', u => S(u).meltdownBest || 0),
  a('ach_melt500k', 'mode_meltdown', 'explore', 500000, 4000, 35, '炉心の支配者', 'Core Master',      'メルトダウンで500,000点', 'Score 500,000 in Meltdown', u => S(u).meltdownBest || 0),
  a('ach_chimera30k','mode_chimera','explore', 30000,  1200, 9,  '合成の初歩',   'First Fusion',     'キメラ工房で30,000点',   'Score 30,000 in Chimera Lab', u => S(u).chimeraBest || 0),
  a('ach_chimera100k','mode_chimera','explore',100000, 4000, 35, 'キメラの父',   'Chimera Father',   'キメラ工房で100,000点',  'Score 100,000 in Chimera Lab', u => S(u).chimeraBest || 0),
  a('ach_rush5',    'fire', 'explore', 5,      1500, 12, '地獄の五合目',  'Halfway to Hell',  '無限地獄ラッシュ深度5',  'Reach depth 5 in Hell Rush', u => S(u).rushDepth || 0),
  a('ach_rush12',   'mode_bossrush', 'explore', 12,     6000, 50, '地獄を駆ける者','Hellrunner',       '無限地獄ラッシュ深度12', 'Reach depth 12 in Hell Rush', u => S(u).rushDepth || 0),
  a('ach_allS',     'achievement', 'explore', 6,      8000, 70, '完全討伐',     'Perfect Hunter',   '全6ボスでSランク',      'Earn S rank on all 6 bosses', u => Object.values(S(u).bossRanks || {}).filter(r => r === 'S').length),
  a('ach_wave30',   'mode_survival', 'explore', 30,     6000, 50, '不死身',       'Deathless',        'サバイバルW30到達',     'Reach Survival wave 30',    u => S(u).survivalWave || 0),
  a('ach_sprint180','clock', 'explore', 30000,  2600, 20, '持久走の覇者',  'Marathon Champ',   'TA 180秒で30,000点',    'Score 30,000 in a 180s run', u => (S(u).sprint && S(u).sprint.s180) || 0),
  a('ach_puzzle10', 'mode_puzzle', 'explore', 10,     800,  6,  '遺跡の入口',    'Ruins Gate',       'パズル遺跡 ステージ10',  'Clear Puzzle Ruins stage 10', u => S(u).puzzleStage || 0),
  a('ach_puzzle30', 'mode_puzzle', 'explore', 30,     2500, 20, '遺跡の解読者',  'Ruins Decoder',    'パズル遺跡 ステージ30',  'Clear Puzzle Ruins stage 30', u => S(u).puzzleStage || 0),
  a('ach_puzzle60', 'badge_puzzle', 'explore', 60,     8000, 70, '古代の賢者',    'Ancient Sage',     'パズル遺跡 ステージ60',  'Clear Puzzle Ruins stage 60', u => S(u).puzzleStage || 0),
  a('ach_dig25',    'mode_dig', 'explore', 25,     800,  6,  '見習い採掘士',  'Rookie Miner',     '採掘場で深度25',        'Reach depth 25 in the Mines', u => S(u).digDepth || 0),
  a('ach_dig60',    'mode_dig', 'explore', 60,     2800, 22, 'ベテラン採掘士','Veteran Miner',    '採掘場で深度60',        'Reach depth 60 in the Mines', u => S(u).digDepth || 0),
  a('ach_dig100',   'gems', 'explore', 100,    9000, 80, '地底の王',      'King Underground', '採掘場で深度100',       'Reach depth 100 in the Mines', u => S(u).digDepth || 0),

  // ---- 探索（⛓️連鎖カスケード・🏗️ブループリント・🛠️パズル工房） ----
  // 追加モードには2〜3個ずつ実績があるのに、この3モードだけ0個だった
  // ＝「遊んでも図鑑が1マスも埋まらないモード」になっていた。
  // 参照する統計は applyGameResult（server/index.js）が積む3モードぶんの
  // 記録: s.chainPlays / s.chainMax / s.blueprintClears / s.workshopClears。
  // ほかの実績と同じく進捗は毎回 stats から計算されるので、統計が入りしだい
  // 過去に遊んだぶんもさかのぼって解除される。
  a('ach_chain1',   'mode_chain', 'explore', 1,   300,  2,  '連鎖のはじまり', 'First Cascade',    '連鎖カスケードを1回遊ぶ', 'Play Chain Cascade once',  u => S(u).chainPlays || 0),
  a('ach_chain5',   'mode_chain', 'explore', 5,   900,  7,  '五連鎖',        'Five in a Row',    '5連鎖を決める',          'Land a 5-chain cascade',   u => S(u).chainMax || 0),
  a('ach_chain10',  'combo', 'explore', 10,  3000, 25, '連鎖の使い手',   'Cascade Master',   '10連鎖を決める',          'Land a 10-chain cascade',  u => S(u).chainMax || 0),
  a('ach_blueprint1',  'mode_blueprint', 'explore', 1,  400,  3,  '設計図どおり',  'As Drawn',        '設計図を1枚完成させる',   'Complete 1 blueprint',     u => S(u).blueprintClears || 0),
  a('ach_blueprint10', 'badge_puzzle', 'explore', 10, 2500, 20, '製図の達人',    'Master Draughtsman', '設計図を10枚完成させる', 'Complete 10 blueprints',   u => S(u).blueprintClears || 0),
  a('ach_ws1',      'mode_workshop', 'explore', 1,   300,  2,  '工房の見学',     'Workshop Visitor', '工房のステージを1つクリア', 'Clear 1 Workshop stage',  u => S(u).workshopClears || 0),
  a('ach_ws20',     'mode_workshop', 'explore', 20,  2600, 22, '工房の常連',     'Workshop Regular', '工房のステージを20クリア', 'Clear 20 Workshop stages', u => S(u).workshopClears || 0),
  // 上の ach_ws1/ach_ws20 は「遊ぶ側」(workshopClears)。以下は「作る側」の実績で、
  // workshop.js が作者の stats に積む wsPublished / wsPlaysGot / wsLikesGot から導出する。
  // ほかと同じく保存済み統計から毎回計算されるので、過去ぶんもさかのぼって解除される。
  a('ach_ws_pub1',     'mode_blueprint', 'explore', 1,   400,  3,  '工房デビュー',   'Workshop Debut',   '自作ステージを初めて公開する', 'Publish your first Workshop stage', u => S(u).wsPublished || 0),
  // ⚠ **♡と遊ばれた回数は「他人の数」で決まる。** ♡を積めるのは登録済みの
  //   実プレイヤーだけで（住人は工房のAPIを叩かない）、作者本人は除外、
  //   二重♡も禁止。つまり1人の作者が受け取れる♡の上限は
  //   「自分以外の実プレイヤーの数 × 投稿数(最大10)」で、実プレイヤーが
  //   13人の世界では通算50♡は**供給そのものが足りない**（＝自分では
  //   どうにもできない実績として永久に残る）。世界の規模に合わせて下げる。
  //   ⚠ 人が増えたらここも上げ直してよい ── 難しさではなく「届くかどうか」の話。
  a('ach_ws_played100','play', 'explore', 50, 2500, 20, '遊ばれる作品',   'Played by Others', '自作が通算50回遊ばれる',      'Get 50 total plays on your stages', u => S(u).wsPlaysGot || 0),
  a('ach_ws_liked50',  'heart', 'explore', 10,  2000, 16, '♡をもらう人',    'Well Liked',       '自作が通算10♡もらう',        'Get 10 total likes on your stages', u => S(u).wsLikesGot || 0),

  // ---- 収集 ----
  a('ach_gacha10',  'gacha', 'collect', 10,  600,  5,  'ガチャデビュー', 'Gacha Debut',     'ガチャを10回引く',      'Pull the gacha 10 times',    u => S(u).gachaPulls || 0),
  a('ach_gacha100', 'gacha', 'collect', 100, 3000, 25, 'ガチャの申し子', 'Gacha Prodigy',   'ガチャを100回引く',     'Pull the gacha 100 times',   u => S(u).gachaPulls || 0),
  a('ach_ssr',      'rainbow', 'collect', 1,   1500, 12, '虹色の奇跡',    'Rainbow Miracle',  'SSR以上を引き当てる',   'Pull an SSR or better',      u => S(u).gachaSSR || 0),
  a('ach_own45',    'collection', 'collect', COLLECTIBLE_MAX, 8000, 70, '伝説の収集家',  'Legendary Collector',
    `アイテムを全${COLLECTIBLE_MAX}種そろえる`, `Own all ${COLLECTIBLE_MAX} catalog items`, collectedCount),
  a('ach_lv50',     'level_up', 'collect', 50,  6000, 55, 'レベル50',      'Level 50',         'レベル50に到達',        'Reach level 50',             u => 1 + Math.floor((u.xp || 0) / 1000)),

  // ---- 伝説 ----
  a('ach_ult1000',  'badge_souzou', 'legend', 1000, 15000, 120, '奥義の化身',   'Ultimate Incarnate', 'アルティメット1,000回', 'Use 1,000 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_items100', 'inventory', 'legend', 100,  2000,  16,  '道具マスター', 'Item Master',      'アイテムを100回使う',    'Use 100 boosters',          u => S(u).itemsUsed || 0),
  a('ach_chat100',  'chat', 'legend', 100,  1000,  8,   'ロビーの顔',   'Lobby Regular',    'チャットで100回発言',    'Send 100 chat messages',    u => S(u).chatMessages || 0),
  a('ach_react50',  'thumbup', 'legend', 50,   800,   6,   'リアクション名人', 'Reaction Artist', 'リアクションを50回送る', 'Send 50 reactions',       u => S(u).reactionsGiven || 0),
  a('ach_ach50',    'achievement', 'legend', 50,   5000,  45,  '実績ハンター', 'Achievement Hunter', '実績を50個受け取る',   'Claim 50 achievements',     u => (u.achievements || []).length),

  // ---- 👻 隠しモードのティーザー（実績欄そのものがヒントになる） ----
  a('ach_ghost1',   'mode_ghost', 'explore', 1,     666,  6,  'ソレは存在する',   'It Exists',       '「幽霊屋敷」を見つけて1回遊ぶ', 'Find and play the "Haunted House"', u => S(u).ghostPlays || 0),
  a('ach_ghost15k', 'badge_ghost', 'explore', 15000, 3000, 25, '見えないものが見える', 'Sixth Sense', '幽霊屋敷で15,000点',          'Score 15,000 in the Haunted House', u => S(u).ghostBest || 0),

  // ---- ✨ 全消し「昇華」 ----
  // 盤面を空にした通算回数（stats.perfectClears）。ほかの実績と同じく
  // 保存済み統計から毎回計算されるので、過去に空にした分もさかのぼって解除される。
  // ---- 👑 アリーナ最強の相手（ランキングの頂点で待っている 👑ちゃちゃまる） ----
  // 参照するのは対戦を裁く server/battle.js が endMatch で積む s.championWins。
  // ほかの実績と同じく進捗は保存済み統計から毎回計算されるので、統計さえ
  // 入っていれば過去に倒したぶんも遡って解除される。
  // ⚠ 文言に「AI」「ボット」を出さない（住人の正体は管理者以外に漏らさない）。
  // 相手が人間でもそのまま読める言い回しだけを使うこと。
  a('ach_champ1',   'throne', 'legend', 1,  6000,  50,  '王者を討ちし者', 'The Crown Taker',
    'アリーナ最強と呼ばれた相手に勝つ', 'Defeat the strongest player in the arena', u => S(u).championWins || 0),
  // ⚠ **その相手に会えるかどうかは自分の腕と無関係**（遭遇は抽選で、既定1%）。
  //   10回は「上手い人でも約1,000試合」で、進捗が 0/10 のまま何十時間も動かない。
  //   遭遇率（＝伝説枠という設計）は触らず、回数だけ届く高さへ下げる
  //   ── 3回でも約320試合ぶんの伝説枠なので、称号の重みは十分に残る。
  a('ach_champ10',  'throne', 'legend', 3, 20000, 160, '頂を獲りし者',   'Taker of the Summit',
    'アリーナ最強と呼ばれた相手に3回勝つ', 'Defeat the strongest player in the arena 3 times', u => S(u).championWins || 0),

  a('ach_pclear1',  'fx_default', 'legend', 1,  600,  5,  '昇華のはじまり', 'First Sublimation', '盤面を初めて空にする',  'Empty the board for the first time', u => S(u).perfectClears || 0),
  a('ach_pclear10', 'fx_default', 'legend', 10, 2800, 22, '無へ還す者',     'Into the Void',     '盤面を10回空にする',    'Empty the board 10 times',           u => S(u).perfectClears || 0),
  a('ach_pclear50', 'badge_under', 'legend', 50, 9000, 80, '無の求道者',     'Voidseeker',        '盤面を50回空にする',    'Empty the board 50 times',           u => S(u).perfectClears || 0),
];

export function achievementsView(user) {
  const claimed = new Set(user.achievements || []);
  const rows = ACHIEVEMENTS.map(ac => {
    const value = Math.max(0, Number(ac.value(user)) || 0);
    return {
      id: ac.id, icon: ac.icon, cat: ac.cat,
      name: ac.name, nameEn: ac.nameEn, desc: ac.desc, descEn: ac.descEn,
      goal: ac.goal, progress: Math.min(value, ac.goal),
      coins: ac.coins, gems: ac.gems,
      // 受け取り済みなら必ず「解除済み」。claimAchievement は value>=goal の
      // ものしか受け取らせないので、ふつうに遊んでいる限り claimed ⊆ done で
      // あり、この OR は何も変えない。効くのは管理者アカウントの起動時シード
      // （u.achievements に全124件を入れるが、進捗は全部までは満たさない）で、
      // 以前はヘッダが「解除 84 / 124 ・ 受取済 124」と受取が解除を上回って
      // いた。片方だけ作り話にしない ── 数字を2つ並べる以上、辻褄は合わせる。
      done: value >= ac.goal || claimed.has(ac.id), claimed: claimed.has(ac.id),
    };
  });
  return {
    cats: ACH_CATS,
    rows,
    unlocked: rows.filter(r => r.done).length,
    claimedCount: claimed.size,
    total: rows.length,
  };
}

// Claim one achievement (or all ready ones when id is '*').
export function claimAchievement(user, id) {
  if (!user.achievements) user.achievements = [];
  const claimed = new Set(user.achievements);
  const ready = ACHIEVEMENTS.filter(ac =>
    (id === '*' || ac.id === id) && !claimed.has(ac.id) && (Number(ac.value(user)) || 0) >= ac.goal);
  if (!ready.length) {
    return { error: id === '*' ? '受け取れる実績がありません' : 'まだ達成していないか、受け取り済みです' };
  }
  // 📜 1日に受け取れる**金額**の上限。
  //
  // ⚠ id:'*' の一括受け取りは、条件を満たしている実績を**1リクエストで満額**
  //   払っていた。全実績の合計は 418,916🪙＋3,509💎 で、図鑑（90,500🪙＋612💎）の
  //   4倍以上あるのに、絞りは金額の小さい図鑑側にだけ付いていた
  //   （catalog.js の COLLECTION_CLAIM_PER_DAY）。実績を追加した日に、
  //   条件をすでに満たしている古参が一斉に満額を受け取ることになる。
  //
  // ★ 件数ではなく**金額**で絞る。件数だと、小さな実績（600🪙）まで
  //   何日も待たされて「達成したのに受け取れない」体験になる。
  //   金額で絞れば、細かいものは今日まとめて片付き、大物だけが翌日に回る。
  // ★ 受け取れる権利は消えない（明日また受け取れる）。数日に均すだけ。
  const q = achievementQuota(user);
  const roomC = Math.max(0, ACH_CLAIM_COIN_DAY - q.coins);
  const roomG = Math.max(0, ACH_CLAIM_GEM_DAY - q.gems);

  // 安い順に片付ける（小さいものを人質に取らない）。
  const order = ready.slice().sort((a, b) =>
    (a.coins + a.gems * GEM_IN_COINS) - (b.coins + b.gems * GEM_IN_COINS));

  let coins = 0, gems = 0;
  const taken = [];
  for (const ac of order) {
    // ★ 詰み防止の保険は「**単品で1日の枠に収まらない実績**」だけに効かせる。
    //
    // ⚠ もとは `taken.length === 0`（＝1リクエストにつき必ず1件）だった。
    //   これだと**リクエストを分けるだけで上限がまるごと消える**:
    //     ・"*" を43回押す → 287,150🪙 / 2,396💎（上限の9.6倍 / 8.0倍）
    //     ・実績カードの個別「受取」は ready が常に1件なので、上限が一度も効かない
    //   💎は user.gems に直接足すので、GEMDROP_DAILY_CAP(120💎/日) も通らない。
    //   実績を追加した日に、条件を満たしている古参が一斉に満額を受け取れてしまう
    //   ── 絞りを入れた当の目的がそのまま抜けていた。
    //
    //   本来の意図は「1日の枠より高い実績が**永久に**受け取れなくなるのを防ぐ」。
    //   それは『単品で枠に収まらない』ものにだけ効かせれば足りる。
    //   さらに『その日まだ1円も受け取っていない』ことも条件にする ── そうしないと、
    //   小さいものを取ったあとに大物を足して枠を越えられる。
    //   （いまの表には枠を超える実績は1つも無いので、この枝は将来の保険）
    const cannotEverFit = ac.coins > ACH_CLAIM_COIN_DAY || ac.gems > ACH_CLAIM_GEM_DAY;
    const forced = cannotEverFit && taken.length === 0 && q.coins === 0 && q.gems === 0;
    if (!forced && (coins + ac.coins > roomC || gems + ac.gems > roomG)) continue;
    user.achievements.push(ac.id);
    coins += ac.coins;
    gems += ac.gems;
    taken.push(ac.id);
  }
  q.coins += coins;
  q.gems += gems;
  user.coins += coins;
  user.gems += gems;
  // 取り切れなかった件数を返す（画面が「あと◯件は明日」と言えるように）。
  return { coins, gems, ids: taken, left: ready.length - taken.length };
}

// 💎をコイン換算する重み（ガチャの実効レート）。安い順に並べるためだけに使う。
const GEM_IN_COINS = 22.8;
// 1日に受け取れる実績報酬の上限。図鑑のいちばん大きなセット（30,000🪙＋300💎）と
// 同じ高さにそろえてある ── どちらも「まとめて配ると一度に効きすぎる」ための歯止め。
export const ACH_CLAIM_COIN_DAY = 30000;
export const ACH_CLAIM_GEM_DAY = 300;

// JST 0時区切り。catalog.js の collectionDayKey と同じ計算。
function achDayKey(ts = Date.now()) {
  return new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// きょういくら受け取ったか。user を書き換える（受け取り時にだけ呼ぶ）。
function achievementQuota(user) {
  const day = achDayKey();
  // ⚠ 置き場は **user.stats の下**。grindDay / eventGemDay / eyeShardDay と
  //   同じ棚に置かないと、復元マージ（server/backup.js の「日付つきの止め金」の
  //   輪）が拾わず、**復元した日だけ上限がもう1本ぶん開く**。
  //   test/persist-registry.test.mjs の C-2/C-5 がそれを見張っている。
  const st = user.stats || (user.stats = {});
  let q = st.achClaimDay;
  if (!q || typeof q !== 'object' || q.day !== day) q = st.achClaimDay = { day, coins: 0, gems: 0 };
  q.coins = Math.max(0, Number(q.coins) || 0);
  q.gems = Math.max(0, Number(q.gems) || 0);
  return q;
}

/** 画面向け（書き換えない）。きょうあといくら受け取れるか。 */
export function achievementClaimRoom(user) {
  const q = user && user.stats && user.stats.achClaimDay;
  const on = q && q.day === achDayKey();
  return {
    coins: Math.max(0, ACH_CLAIM_COIN_DAY - (on ? Number(q.coins) || 0 : 0)),
    gems: Math.max(0, ACH_CLAIM_GEM_DAY - (on ? Number(q.gems) || 0 : 0)),
  };
}
