// Achievements (実績) — permanent, one-time goals evaluated from user stats.
// Progress is derived (never stored), so old accounts get credit retroactively;
// only the *claimed* list lives on the user record.

const a = (id, icon, cat, goal, coins, gems, name, nameEn, desc, descEn, value) =>
  ({ id, icon, cat, goal, coins, gems, name, nameEn, desc, descEn, value });

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

  // ---- 探索 ----
  a('ach_boss1',    '🐲', 'explore', 1,   400,  3,  'ボス初討伐',   'First Kill',       'ボスを1体討伐',       'Defeat 1 boss',           u => S(u).bossMax || 0),
  a('ach_boss4',    '😈', 'explore', 4,   2000, 16, '魔王を討ちし者', 'Demon Lord Slayer', '全ボスを討伐',      'Defeat every boss',       u => S(u).bossMax || 0),
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

  // ---- 伝説（アルティメット & ミッション） ----
  a('ach_ult1',     '⚡', 'legend', 1,    300,  2,  '奥義開眼',     'Awakening',        'アルティメット初発動',  'Use your first ultimate', u => S(u).ultsUsed || 0),
  a('ach_ult100',   '⚡', 'legend', 100,  2500, 20, '極意の継承者', 'Heir of Mastery',  'アルティメット100回',   'Use 100 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_ult500',   '🌠', 'legend', 500,  9000, 80, '奥義を極めし者', 'Grand Master',   'アルティメット500回',   'Use 500 ultimates',       u => S(u).ultsUsed || 0),
  a('ach_mis10',    '📋', 'legend', 10,   600,  5,  '任務開始',     'On Duty',          'ミッション10個クリア',  'Complete 10 missions',    u => S(u).missionsDone || 0),
  a('ach_mis50',    '📋', 'legend', 50,   2200, 18, '任務遂行者',   'Mission Runner',   'ミッション50個クリア',  'Complete 50 missions',    u => S(u).missionsDone || 0),
  a('ach_mis300',   '📋', 'legend', 300,  9000, 80, 'ミッションの鬼', 'Mission Demon',  'ミッション300個クリア', 'Complete 300 missions',   u => S(u).missionsDone || 0),
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
