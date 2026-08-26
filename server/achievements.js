// Achievements (実績) — permanent, one-time goals evaluated from user stats.
// Progress is derived (never stored), so old accounts get credit retroactively;
// only the *claimed* list lives on the user record.

import { SHOP_ITEMS } from './catalog.js';

const a = (id, icon, cat, goal, coins, gems, name, nameEn, desc, descEn, value) =>
  ({ id, icon, cat, goal, coins, gems, name, nameEn, desc, descEn, value });

// 収集系の上限は「一般プレイヤーが実際に持てるアイテム数」。
// ここを数字で直書きしていたせいで、カタログを削ったあと目標45に対して
// 実際は37種しか存在しない状態になり、この実績だけは誰にも達成できず、
// 進捗バーが 37/45 で永久に止まっていた。しかも理由はゲーム内のどこにも
// 書かれていないので、コンプリートを目指す人は原因不明のまま詰む。
// カタログから導出しておけば、今後アイテムが増減しても勝手に追従する。
const COLLECTIBLE_MAX = SHOP_ITEMS.filter(i => !i.adminOnly).length;

const S = u => u.stats || {};
const has = (u, b) => (u.badges || []).includes(b);

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
  a('ach_play1',    '🎮', 'play', 1,     200,  1,  'はじめの一歩',   'First Step',       '1回プレイする',        'Play 1 game',            u => S(u).gamesPlayed || 0),
  a('ach_play25',   '🎮', 'play', 25,    500,  3,  '常連プレイヤー', 'Regular',          '25回プレイする',       'Play 25 games',          u => S(u).gamesPlayed || 0),
  a('ach_play100',  '🎮', 'play', 100,   1200, 8,  '百戦の記憶',     'A Hundred Games',  '100回プレイする',      'Play 100 games',         u => S(u).gamesPlayed || 0),
  a('ach_play500',  '🎮', 'play', 500,   4000, 30, '不屈の挑戦者',   'Unyielding',       '500回プレイする',      'Play 500 games',         u => S(u).gamesPlayed || 0),
  a('ach_lines500', '📏', 'play', 500,   600,  4,  'ライン職人見習い', 'Apprentice Liner', '累計500ライン消去',   'Clear 500 lines total',  u => S(u).totalLines || 0),
  a('ach_lines5k',  '📏', 'play', 5000,  2500, 18, 'ライン職人',     'Line Artisan',     '累計5,000ライン消去',  'Clear 5,000 lines total', u => S(u).totalLines || 0),
  a('ach_lines20k', '📏', 'play', 20000, 8000, 60, 'ライン神',       'Line Deity',       '累計20,000ライン消去', 'Clear 20,000 lines total', u => S(u).totalLines || 0),
  a('ach_login7',   '📅', 'play', 7,     900,  6,  '七日間の習慣',   'Seven-Day Habit',  '7日連続ログイン',      'Log in 7 days in a row', u => S(u).loginStreakBest || 0),
  a('ach_login30',  '📅', 'play', 30,    4000, 35, '一ヶ月の絆',     'A Month Together', '30日連続ログイン',     'Log in 30 days in a row', u => S(u).loginStreakBest || 0),

  // ---- スコア ----
  a('ach_score10k', '⭐', 'score', 10000,  300,  2,  '一万点突破',   'Ten Thousand',    '1ゲームで10,000点',  'Score 10,000 in one game',  u => S(u).bestScore || 0),
  a('ach_score50k', '⭐', 'score', 50000,  800,  6,  '五万点突破',   'Fifty Thousand',  '1ゲームで50,000点',  'Score 50,000 in one game',  u => S(u).bestScore || 0),
  a('ach_score100k','🌟', 'score', 100000, 1500, 12, '十万点の壁',   'The 100K Wall',   '1ゲームで100,000点', 'Score 100,000 in one game', u => S(u).bestScore || 0),
  a('ach_score300k','💫', 'score', 300000, 4000, 30, '三十万の伝説', 'Legend of 300K',  '1ゲームで300,000点', 'Score 300,000 in one game', u => S(u).bestScore || 0),
  a('ach_total1m',  '💰', 'score', 1000000, 3000, 25, '億万長者への道', 'Road to Riches', '累計スコア1,000,000', 'Reach 1,000,000 total score', u => S(u).totalScore || 0),
  a('ach_combo5',   '🔥', 'score', 5,   300,  2,  'コンボの芽',   'Combo Spark',     '5コンボ達成',        'Land a 5 combo',            u => S(u).maxCombo || 0),
  a('ach_combo10',  '🔥', 'score', 10,  900,  7,  'コンボマスター', 'Combo Master',   '10コンボ達成',       'Land a 10 combo',           u => S(u).maxCombo || 0),
  a('ach_combo15',  '🔥', 'score', 15,  2200, 16, 'コンボの神域', 'Combo Divinity',  '15コンボ達成',       'Land a 15 combo',           u => S(u).maxCombo || 0),
  a('ach_combo20',  '💥', 'score', 20,  6000, 45, 'コンボ超越者', 'Combo Transcendent', '20コンボ達成',    'Land a 20 combo',           u => S(u).maxCombo || 0),

  // ---- 対戦 ----
  a('ach_ai1',      '🤖', 'battle', 1,    250,  2,  'AI撃破',       'AI Slayer',        'AIに1回勝つ',        'Beat the AI once',        u => S(u).aiWins || 0),
  a('ach_ai25',     '🤖', 'battle', 25,   1200, 9,  'AIキラー',     'AI Killer',        'AIに25回勝つ',       'Beat the AI 25 times',    u => S(u).aiWins || 0),
  a('ach_pvp1',     '⚔️', 'battle', 1,    400,  3,  '初勝利',       'First Blood',      'オンラインで1勝',     'Win 1 online battle',     u => S(u).pvpWins || 0),
  a('ach_pvp10',    '⚔️', 'battle', 10,   1000, 8,  '常勝将軍',     'Undefeated',       'オンラインで10勝',    'Win 10 online battles',   u => S(u).pvpWins || 0),
  a('ach_pvp50',    '⚔️', 'battle', 50,   3500, 28, '百戦錬磨',     'Battle-Hardened',  'オンラインで50勝',    'Win 50 online battles',   u => S(u).pvpWins || 0),
  a('ach_streak5',  '🔗', 'battle', 5,    1500, 12, '連勝街道',     'Streak Rider',     'ランクマ5連勝',       'Win 5 ranked in a row',   u => S(u).winStreakBest || S(u).winStreak || 0),
  a('ach_rate1200', '📈', 'battle', 1200, 900,  7,  'レジェンド',   'Legend',           'レート1200到達',      'Reach 1200 rating',       u => S(u).rating || 0),
  a('ach_rate1500', '💎', 'battle', 1500, 2500, 20, 'ダイヤの誇り', 'Diamond Pride',    'レート1500到達',      'Reach 1500 rating',       u => S(u).rating || 0),
  a('ach_rate1700', '👑', 'battle', 1700, 6000, 50, '頂のマスター', 'Peak Master',      'レート1700到達',      'Reach 1700 rating',       u => S(u).rating || 0),
  a('ach_tourney',  '🏆', 'battle', 1,    3000, 25, '大会王者',     'Tournament King',  'トーナメント優勝',     'Win a tournament',        u => has(u, 'tourney') ? 1 : 0),
  a('ach_royale',   '💯', 'battle', 1,    3000, 25, '百人の頂点',   'Apex of 100',      'バトルロイヤル1位',    'Take #1 in Battle Royale', u => has(u, 'royale') ? 1 : 0),
  // v2.11 — battle royale grew a whole progression, so it gets goals that are
  // reachable without winning outright.
  a('ach_rl_top10', '🎖️', 'battle', 5,    1200, 9,  'ロワの常連',   'Royale Regular',   'バトルロイヤルでTOP10入り5回', 'Finish top 10 in Battle Royale 5 times', u => S(u).royaleTop10 || 0),
  a('ach_rl_ko10',  '💀', 'battle', 10,   1500, 12, '狩る者',       'The Hunter',       'バトルロイヤルで通算10KO', 'Knock out 10 rivals in Battle Royale', u => S(u).royaleKills || 0),
  a('ach_rl_ko3',   '🔪', 'battle', 3,    2000, 16, '一狩り三殺',   'Triple Threat',    '1試合で3KO', 'Knock out 3 rivals in a single Battle Royale', u => S(u).royaleBestKills || 0),
  a('ach_rl_50',    '💯', 'battle', 50,   3000, 24, '百戦のロワイヤル', 'Royale Veteran', 'バトルロイヤルに50回参加', 'Enter Battle Royale 50 times', u => S(u).royalePlays || 0),
  // v2.11 — 👑 管理者イベント
  a('ach_ae_join',  '👑', 'battle', 1,    800,  6,  '招かれし者',   'Invited',          '管理者イベントに参加', 'Take part in an Admin Event', u => S(u).aePlays || 0),
  a('ach_ae_10',    '👑', 'battle', 10,   2500, 20, '常連の来賓',   'Honoured Guest',   '管理者イベントで10回プレイ', 'Play 10 Admin Event runs', u => S(u).aePlays || 0),
  a('ach_ae_clear', '🏛️', 'battle', 1,    4000, 32, '管理者イベント制覇', 'Event Conqueror', '管理者イベントの目標を達成', 'Complete an Admin Event objective', u => has(u, 'adminevent') ? 1 : 0),

  // ---- 探索 ----
  a('ach_boss1',    '🐲', 'explore', 1,   400,  3,  'ボス初討伐',   'First Kill',       'ボスを1体討伐',       'Defeat 1 boss',           u => S(u).bossMax || 0),
  a('ach_boss4',    '😈', 'explore', 6,   2000, 16, '魔王を討ちし者', 'Demon Lord Slayer', '全6ボスを討伐',      'Defeat all 6 bosses',     u => S(u).bossMax || 0),
  a('ach_rush',     '⚔️', 'explore', 1,   2500, 20, 'ボスラッシュ制覇', 'Rush Conqueror', 'ボスラッシュクリア', 'Clear Boss Rush',         u => has(u, 'rush') ? 1 : 0),
  a('ach_dun10',    '🏰', 'explore', 10,  500,  4,  '塔の来訪者',   'Tower Visitor',    'ダンジョンF10到達',    'Reach dungeon F10',       u => S(u).dungeonMax || 0),
  a('ach_dun50',    '🏰', 'explore', 50,  2000, 16, '塔の探検家',   'Tower Explorer',   'ダンジョンF50到達',    'Reach dungeon F50',       u => S(u).dungeonMax || 0),
  a('ach_dun100',   '🏯', 'explore', 100, 8000, 70, '百塔の覇者',   'Lord of 100 Floors', 'ダンジョンF100制覇', 'Conquer dungeon F100',    u => S(u).dungeonMax || 0),
  a('ach_wave10',   '💀', 'explore', 10,  800,  6,  '生存者',       'Survivor',         'サバイバルW10到達',    'Reach Survival wave 10',  u => S(u).survivalWave || 0),
  a('ach_wave20',   '☠️', 'explore', 20,  2800, 22, '生存本能',     'Survival Instinct', 'サバイバルW20到達',   'Reach Survival wave 20',  u => S(u).survivalWave || 0),
  a('ach_oni',      '👹', 'explore', 1,   1500, 12, '鬼退治',       'Oni Slayer',       '難易度「鬼」に勝利',   'Beat "Oni" difficulty',   u => has(u, 'oni') ? 1 : 0),
  a('ach_kami',     '🔱', 'explore', 1,   4000, 35, '神殺し',       'God Slayer',       '難易度「神」に勝利',   'Beat "Kami" difficulty',  u => has(u, 'kami') ? 1 : 0),
  a('ach_souzou',   '🌌', 'explore', 1,   10000, 90, '創造を超えし者', 'Beyond Creation', '難易度「創造神」に勝利', 'Beat "Creator God"',     u => has(u, 'souzou') ? 1 : 0),

  // ---- 収集 ----
  a('ach_own5',     '🎁', 'collect', 5,   500,  4,  'コレクター見習い', 'Novice Collector', 'アイテムを5種所持',  'Own 5 catalog items',    u => (u.owned || []).length),
  a('ach_own15',    '🎁', 'collect', 15,  1800, 14, 'コレクター',   'Collector',        'アイテムを15種所持',   'Own 15 catalog items',    u => (u.owned || []).length),
  a('ach_own30',    '🏵️', 'collect', 30,  5000, 45, '大コレクター', 'Grand Collector',  'アイテムを30種所持',   'Own 30 catalog items',    u => (u.owned || []).length),
  a('ach_coins10k', '🪙', 'collect', 10000, 1000, 8, '大富豪',      'Tycoon',           'コインを10,000所持',   'Hold 10,000 coins',       u => u.coins || 0),
  a('ach_lv10',     '⬆️', 'collect', 10,  800,  6,  'レベル10',     'Level 10',         'レベル10に到達',      'Reach level 10',          u => 1 + Math.floor((u.xp || 0) / 1000)),
  a('ach_lv30',     '⬆️', 'collect', 30,  3000, 25, 'レベル30',     'Level 30',         'レベル30に到達',      'Reach level 30',          u => 1 + Math.floor((u.xp || 0) / 1000)),

  // ---- 探索（新モード） ----
  a('ach_sprint1',  '⏱️', 'explore', 1,     300,  2,  'ヨーイドン',   'On Your Marks',    'タイムアタック初挑戦',  'Play Time Attack once',   u => S(u).sprintPlays || 0),
  a('ach_sprint10k','⏱️', 'explore', 10000, 900,  7,  '瞬発力',       'Quick Draw',       'TA 60秒で10,000点',    'Score 10,000 in a 60s run', u => (S(u).sprint && S(u).sprint.s60) || 0),
  a('ach_sprint25k','🚀', 'explore', 25000, 3000, 25, '光速のブロッカー', 'Speed of Light', 'TA 60秒で25,000点',   'Score 25,000 in a 60s run', u => (S(u).sprint && S(u).sprint.s60) || 0),
  a('ach_coop1',    '🤝', 'explore', 1,     400,  3,  'いい相棒',     'Good Partner',     '協力プレイ初挑戦',      'Play co-op once',         u => S(u).coopPlays || 0),
  a('ach_coop10',   '🤝', 'explore', 10,    1600, 13, '名コンビ',     'Great Duo',        '協力プレイを10回',      'Play 10 co-op runs',      u => S(u).coopPlays || 0),
  a('ach_coop20k',  '💞', 'explore', 20000, 2600, 22, '以心伝心',     'In Perfect Sync',  '協力で20,000点',       'Reach 20,000 in co-op',   u => S(u).coopBest || 0),

  a('ach_abyss10',  '🌑', 'explore', 10,    1500, 12, '深淵の入口',   'Edge of the Abyss', '深淵 A10到達',          'Reach Abyss A10',         u => S(u).abyssMax || 0),
  a('ach_abyss50',  '🌑', 'explore', 50,    5000, 45, '深淵を覗きし者', 'Abyss Walker',    '深淵 A50到達',          'Reach Abyss A50',         u => S(u).abyssMax || 0),
  a('ach_abyss100', '🕳️', 'explore', 100,   20000, 200, '深淵の支配者', 'Lord of the Abyss', '深淵 A100制覇',       'Conquer Abyss A100',      u => S(u).abyssMax || 0),
  a('ach_guild',    '🏰', 'collect', 1,     500,  4,  'ギルド加入',   'Guild Member',     'ギルドに加入する',      'Join a guild',            u => u.guildId ? 1 : 0),
  a('ach_guild2k',  '🏰', 'collect', 2000,  2000, 16, 'ギルドのエース', 'Guild Ace',      'ギルドに週2,000pt貢献', 'Contribute 2,000 pts in a week', u => S(u).guildBestWeek || 0),

  // ---- 伝説（アルティメット & ミッション） ----
  a('ach_ult1',     '⚡', 'legend', 1,    300,  2,  '奥義開眼',     'Awakening',        'アルティメット初発動',  'Use your first ultimate', u => S(u).ultsUsed || 0),
  a('ach_ult100',   '⚡', 'legend', 100,  2500, 20, '極意の継承者', 'Heir of Mastery',  'アルティメット100回',   'Use 100 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_ult500',   '🌠', 'legend', 500,  9000, 80, '奥義を極めし者', 'Grand Master',   'アルティメット500回',   'Use 500 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_mis10',    '📋', 'legend', 10,   600,  5,  '任務開始',     'On Duty',          'ミッション10個クリア',  'Complete 10 missions',    u => S(u).missionsDone || 0),
  a('ach_mis50',    '📋', 'legend', 50,   2200, 18, '任務遂行者',   'Mission Runner',   'ミッション50個クリア',  'Complete 50 missions',    u => S(u).missionsDone || 0),
  a('ach_mis300',   '📋', 'legend', 300,  9000, 80, 'ミッションの鬼', 'Mission Demon',  'ミッション300個クリア', 'Complete 300 missions',   u => S(u).missionsDone || 0),

  // ==== v2.6 不滅アップデート: +37種で全100種 ====================================
  // ---- プレイ ----
  a('ach_play1000', '🎮', 'play', 1000,  8000, 60, '千戦の勇者',   'Thousand Battles', '1,000回プレイする',     'Play 1,000 games',          u => S(u).gamesPlayed || 0),
  a('ach_pieces50k','🧱', 'play', 50000, 2000, 15, 'ブロックの海',  'Sea of Blocks',    '累計50,000ピース設置',  'Place 50,000 pieces',        u => S(u).piecesPlaced || 0),
  a('ach_time24h',  '⏳', 'play', 86400, 3000, 25, 'まる一日',      'A Full Day',       '累計プレイ24時間',      'Play for 24 hours total',    u => S(u).playSecs || 0),
  a('ach_wins100',  '🏅', 'play', 100,   1500, 12, '勝利の常連',    'Winning Regular',  '累計100勝する',         'Win 100 games total',        u => S(u).totalWins || 0),
  a('ach_login100', '📅', 'play', 100,   5000, 45, '百日の旅路',    'Hundred Days',     '通算100日ログイン',     'Log in on 100 different days', u => S(u).dailyLogins || 0),

  // ---- スコア ----
  a('ach_score500k','🌠', 'score', 500000,   8000,  70,  '五十万の彼方', 'Beyond 500K',     '1ゲームで500,000点',    'Score 500,000 in one game',  u => S(u).bestScore || 0),
  a('ach_total10m', '💰', 'score', 10000000, 9000,  80,  '一千万の軌跡', 'Ten Million Trail', '累計スコア10,000,000', 'Reach 10,000,000 total score', u => S(u).totalScore || 0),
  a('ach_combo30',  '💥', 'score', 30,       12000, 100, 'コンボの化身', 'Combo Incarnate',  '30コンボ達成',         'Land a 30 combo',            u => S(u).maxCombo || 0),

  // ---- 対戦 ----
  a('ach_pvp100',   '⚔️', 'battle', 100,  6000,  50,  '闘神',         'War God',          'オンラインで100勝',     'Win 100 online battles',    u => S(u).pvpWins || 0),
  a('ach_streak10', '🔗', 'battle', 10,   4000,  35,  '無敗の風',     'Unbeaten Wind',    'ランクマ10連勝',        'Win 10 ranked in a row',    u => S(u).winStreakBest || S(u).winStreak || 0),
  a('ach_rate1900', '🏔️', 'battle', 1900, 12000, 100, '孤高の頂',     'Lonely Summit',    'レート1900到達',        'Reach 1900 rating',         u => S(u).rating || 0),
  a('ach_weekly1',  '🏆', 'battle', 1,    3000,  25,  '週間王者',     'Weekly Champion',  '週間ランキング1位',     'Take #1 in the weekly ranking', u => has(u, 'weekly1') ? 1 : 0),

  // ---- 探索 ----
  a('ach_melt100k', '☢️', 'explore', 100000, 1200, 9,  '臨界寸前',     'Near Critical',    'メルトダウンで100,000点', 'Score 100,000 in Meltdown', u => S(u).meltdownBest || 0),
  a('ach_melt500k', '☢️', 'explore', 500000, 4000, 35, '炉心の支配者', 'Core Master',      'メルトダウンで500,000点', 'Score 500,000 in Meltdown', u => S(u).meltdownBest || 0),
  a('ach_chimera30k','🧬','explore', 30000,  1200, 9,  '合成の初歩',   'First Fusion',     'キメラ工房で30,000点',   'Score 30,000 in Chimera Lab', u => S(u).chimeraBest || 0),
  a('ach_chimera100k','🧬','explore',100000, 4000, 35, 'キメラの父',   'Chimera Father',   'キメラ工房で100,000点',  'Score 100,000 in Chimera Lab', u => S(u).chimeraBest || 0),
  a('ach_rush5',    '🔥', 'explore', 5,      1500, 12, '地獄の五合目',  'Halfway to Hell',  '無限地獄ラッシュ深度5',  'Reach depth 5 in Hell Rush', u => S(u).rushDepth || 0),
  a('ach_rush12',   '🌋', 'explore', 12,     6000, 50, '地獄を駆ける者','Hellrunner',       '無限地獄ラッシュ深度12', 'Reach depth 12 in Hell Rush', u => S(u).rushDepth || 0),
  a('ach_allS',     '🎖️', 'explore', 6,      8000, 70, '完全討伐',     'Perfect Hunter',   '全6ボスでSランク',      'Earn S rank on all 6 bosses', u => Object.values(S(u).bossRanks || {}).filter(r => r === 'S').length),
  a('ach_wave30',   '☠️', 'explore', 30,     6000, 50, '不死身',       'Deathless',        'サバイバルW30到達',     'Reach Survival wave 30',    u => S(u).survivalWave || 0),
  a('ach_sprint180','⏱️', 'explore', 30000,  2600, 20, '持久走の覇者',  'Marathon Champ',   'TA 180秒で30,000点',    'Score 30,000 in a 180s run', u => (S(u).sprint && S(u).sprint.s180) || 0),
  a('ach_puzzle10', '🧩', 'explore', 10,     800,  6,  '遺跡の入口',    'Ruins Gate',       'パズル遺跡 ステージ10',  'Clear Puzzle Ruins stage 10', u => S(u).puzzleStage || 0),
  a('ach_puzzle30', '🧩', 'explore', 30,     2500, 20, '遺跡の解読者',  'Ruins Decoder',    'パズル遺跡 ステージ30',  'Clear Puzzle Ruins stage 30', u => S(u).puzzleStage || 0),
  a('ach_puzzle60', '🗿', 'explore', 60,     8000, 70, '古代の賢者',    'Ancient Sage',     'パズル遺跡 ステージ60',  'Clear Puzzle Ruins stage 60', u => S(u).puzzleStage || 0),
  a('ach_dig25',    '⛏️', 'explore', 25,     800,  6,  '見習い採掘士',  'Rookie Miner',     '採掘場で深度25',        'Reach depth 25 in the Mines', u => S(u).digDepth || 0),
  a('ach_dig60',    '⛏️', 'explore', 60,     2800, 22, 'ベテラン採掘士','Veteran Miner',    '採掘場で深度60',        'Reach depth 60 in the Mines', u => S(u).digDepth || 0),
  a('ach_dig100',   '💎', 'explore', 100,    9000, 80, '地底の王',      'King Underground', '採掘場で深度100',       'Reach depth 100 in the Mines', u => S(u).digDepth || 0),

  // ---- 収集 ----
  a('ach_gacha10',  '🎰', 'collect', 10,  600,  5,  'ガチャデビュー', 'Gacha Debut',     'ガチャを10回引く',      'Pull the gacha 10 times',    u => S(u).gachaPulls || 0),
  a('ach_gacha100', '🎰', 'collect', 100, 3000, 25, 'ガチャの申し子', 'Gacha Prodigy',   'ガチャを100回引く',     'Pull the gacha 100 times',   u => S(u).gachaPulls || 0),
  a('ach_ssr',      '🌈', 'collect', 1,   1500, 12, '虹色の奇跡',    'Rainbow Miracle',  'SSR以上を引き当てる',   'Pull an SSR or better',      u => S(u).gachaSSR || 0),
  a('ach_own45',    '🏵️', 'collect', COLLECTIBLE_MAX, 8000, 70, '伝説の収集家',  'Legendary Collector',
    `アイテムを全${COLLECTIBLE_MAX}種そろえる`, `Own all ${COLLECTIBLE_MAX} catalog items`, u => (u.owned || []).length),
  a('ach_lv50',     '⬆️', 'collect', 50,  6000, 55, 'レベル50',      'Level 50',         'レベル50に到達',        'Reach level 50',             u => 1 + Math.floor((u.xp || 0) / 1000)),

  // ---- 伝説 ----
  a('ach_ult1000',  '🌌', 'legend', 1000, 15000, 120, '奥義の化身',   'Ultimate Incarnate', 'アルティメット1,000回', 'Use 1,000 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_items100', '🎒', 'legend', 100,  2000,  16,  '道具マスター', 'Item Master',      'アイテムを100回使う',    'Use 100 boosters',          u => S(u).itemsUsed || 0),
  a('ach_chat100',  '💬', 'legend', 100,  1000,  8,   'ロビーの顔',   'Lobby Regular',    'チャットで100回発言',    'Send 100 chat messages',    u => S(u).chatMessages || 0),
  a('ach_react50',  '👍', 'legend', 50,   800,   6,   'リアクション名人', 'Reaction Artist', 'リアクションを50回送る', 'Send 50 reactions',       u => S(u).reactionsGiven || 0),
  a('ach_ach50',    '🏅', 'legend', 50,   5000,  45,  '実績ハンター', 'Achievement Hunter', '実績を50個受け取る',   'Claim 50 achievements',     u => (u.achievements || []).length),

  // ---- 👻 隠しモードのティーザー（実績欄そのものがヒントになる） ----
  a('ach_ghost1',   '👻', 'explore', 1,     666,  6,  'ソレは存在する',   'It Exists',       '「幽霊屋敷」を見つけて1回遊ぶ', 'Find and play the "Haunted House"', u => S(u).ghostPlays || 0),
  a('ach_ghost15k', '🕯️', 'explore', 15000, 3000, 25, '見えないものが見える', 'Sixth Sense', '幽霊屋敷で15,000点',          'Score 15,000 in the Haunted House', u => S(u).ghostBest || 0),
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
      done: value >= ac.goal, claimed: claimed.has(ac.id),
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
  let coins = 0, gems = 0;
  for (const ac of ready) {
    user.achievements.push(ac.id);
    coins += ac.coins;
    gems += ac.gems;
  }
  user.coins += coins;
  user.gems += gems;
  return { coins, gems, ids: ready.map(r => r.id) };
}
