// Lightweight i18n: Japanese (default) / English.
// Usage: t('日本語テキスト', 'English text') — inline pairs, no key tables.
// The language is stored in localStorage and auto-detected on first visit.

const KEY = 'bba_lang';

export const LANG = (() => {
  const saved = localStorage.getItem(KEY);
  if (saved === 'ja' || saved === 'en') return saved;
  return (navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en';
})();

export function setLang(lang) {
  if (lang === 'ja' || lang === 'en') localStorage.setItem(KEY, lang);
}

export function t(ja, en) {
  return LANG === 'en' && en !== undefined ? en : ja;
}

// ---------------------------------------------------------------------------
// Catalog translations: server data (shop/bosses/titles) ships Japanese
// names — the client swaps them by id when playing in English.
// ---------------------------------------------------------------------------

const CATALOG_EN = {
  // block skins
  skin_default: { name: 'Classic', desc: 'The standard blocks' },
  skin_neon: { name: 'Neon Glow', desc: 'Glowing neon blocks' },
  skin_candy: { name: 'Candy', desc: 'Glossy candy look' },
  skin_pixel: { name: 'Retro Pixel', desc: '8-bit retro style' },
  skin_crystal: { name: 'Crystal', desc: 'Translucent gem blocks' },
  skin_gold: { name: 'Gold', desc: 'Shining golden blocks' },
  skin_shadow: { name: 'Shadow', desc: 'Outlines that glow in the dark' },
  skin_pastel: { name: 'Pastel', desc: 'Soft flat design' },
  skin_magma: { name: 'Magma', desc: 'Rock blocks with molten cracks' },
  skin_dot: { name: 'Polka Dot', desc: 'Pop polka-dot blocks' },
  skin_prism: { name: 'Prism [Gacha]', desc: 'Light-splitting crystal blocks — gacha exclusive' },
  board_aurora: { name: 'Aurora [Gacha]', desc: 'Northern lights stage — gacha exclusive' },
  fx_comet: { name: 'Comet [Gacha]', desc: 'Streaking comets — gacha exclusive' },
  // boards
  board_default: { name: 'Midnight', desc: 'The standard night-sky theme' },
  board_ocean: { name: 'Deep Ocean', desc: 'Deep-sea gradient' },
  board_sunset: { name: 'Sunset', desc: 'Warm sunset hues' },
  board_forest: { name: 'Forest', desc: 'The calm of deep woods' },
  board_galaxy: { name: 'Galaxy', desc: 'Nebulae and sparkling stars' },
  board_sakura: { name: 'Sakura Room', desc: 'Cherry blossoms in full bloom' },
  board_volcano: { name: 'Volcano', desc: 'A scorching stage of embers' },
  board_snow: { name: 'Snowfield', desc: 'A silver world of falling snow' },
  board_cyber: { name: 'Cyberspace', desc: 'A neon grid in the digital world' },
  // clear effects
  fx_default: { name: 'Spark', desc: 'The standard spark effect' },
  fx_fireworks: { name: 'Fireworks', desc: 'Fireworks on line clears' },
  fx_thunder: { name: 'Thunder', desc: 'Lightning strikes on clears' },
  fx_sakura: { name: 'Sakura Storm', desc: 'Petals dance and scatter' },
  fx_bubble: { name: 'Bubble', desc: 'Soap bubbles pop' },
  fx_star: { name: 'Stardust', desc: 'Glittering stardust' },
  fx_flame: { name: 'Flame', desc: 'Fire roars on every clear' },
  // booster items
  item_bomb: { name: 'Smart Bomb', desc: 'Blows up the densest 3×3' },
  item_cleaner: { name: 'Cleaner', desc: 'Clears all garbage + the bottom row' },
  item_fever: { name: 'Fever', desc: '2× score for 15 seconds' },
  item_mini: { name: 'Mini Blocks', desc: 'Turns your hand into tiny pieces' },
  // ultimate skills
  ult_blast: { name: 'Destruction Shockwave', desc: 'Force-clears the two fullest rows and columns' },
  ult_purify: { name: 'Purifying Wave', desc: 'Erases all garbage + the bottom two rows' },
  ult_overdrive: { name: 'Overdrive', desc: 'Triple score for 15 seconds' },
  ult_meteor: { name: 'Meteor Strike', desc: 'Obliterates 14 random cells' },
  ult_rainbow: { name: 'Rainbow Hand', desc: 'Your hand becomes the best-fitting pieces' },
  ult_fortress: { name: 'Impregnable Fortress', desc: '30s of combo shield and garbage immunity' },
  ult_timestop: { name: 'Time Stop', desc: '+12s on the clock / freezes bosses for 20s' },
  ult_judgement: { name: 'Divine Judgement', desc: 'Annihilates the board for a colossal score' },
  ult_admin: { name: 'Omnipotence [Staff]', desc: 'Staff-only: board wipe + instant gauge refill' },
  // admin-exclusive gear
  skin_admin: { name: 'Rainbow [Staff]', desc: 'Staff-only blocks shimmering in rainbow' },
  board_admin: { name: 'Throne Room [Staff]', desc: 'A staff-only stage of royal gold' },
  fx_admin: { name: 'Rainbow Blessing [Staff]', desc: 'Staff-only rainbow particle burst' },
  // bosses
  slime: { name: 'Slime King' },
  golem: { name: 'Iron Golem' },
  dragon: { name: 'Dragon' },
  maou: { name: 'Demon Lord' },
  kraken: { name: 'Abyssal Kraken' },
  tiamat: { name: 'Tiamat the Dread Dragon' },
  hades: { name: 'Hades, Lord of the Dead' },
  // titles
  rookie: { name: 'Rookie Blocker', desc: 'Play 1 game' },
  addict: { name: 'Block Addict', desc: 'Play 50 games' },
  combo5: { name: 'Combo Prodigy', desc: 'Reach a 5 combo' },
  combo10: { name: 'Combo Master', desc: 'Reach a 10 combo' },
  score100k: { name: 'Beyond 100K', desc: 'Score 100,000' },
  pvp10: { name: 'Undefeated General', desc: 'Win 10 online battles' },
  rate1200: { name: 'Legend', desc: 'Reach 1200 rating' },
  rich: { name: 'Tycoon', desc: 'Hold 10,000 coins' },
  bosshunt: { name: 'Boss Hunter', desc: 'Defeat 2 bosses' },
  maoslayer: { name: 'Demon Lord Slayer', desc: 'Defeat the Demon Lord' },
  rushhero: { name: 'Rush Conqueror', desc: 'Clear Boss Rush' },
  onislayer: { name: 'Oni Slayer', desc: 'Beat "Oni" difficulty' },
  kamislayer: { name: 'God Slayer', desc: 'Beat "Kami" difficulty' },
  souzouslayer: { name: 'Beyond Creation', desc: 'Beat "Creator God" difficulty' },
  tourneyking: { name: 'Tournament King', desc: 'Win an online tournament' },
  apex100: { name: 'Apex of 100', desc: 'Take #1 in Battle Royale' },
  hunter: { name: 'The Hunter', desc: '25 lifetime knockouts in Battle Royale' },
  guest: { name: 'Honoured Guest', desc: 'Take part in 10 Admin Event runs' },
  streak5: { name: 'Streak Rider', desc: 'Win 5 ranked duels in a row' },
  diamond: { name: 'Diamond Pride', desc: 'Reach 1500 rating' },
  grandmaster: { name: 'Peak Master', desc: 'Reach 1700 rating' },
  veteran: { name: 'Born Blocker', desc: 'Play 200 games' },
  combo15: { name: 'Combo Divinity', desc: 'Reach a 15 combo' },
  score300k: { name: 'Legend of 300K', desc: 'Score 300,000' },
  liner: { name: 'Line Artisan', desc: 'Clear 5,000 total lines' },
  pvp50: { name: 'Hundred Battles', desc: 'Win 50 online battles' },
  explorer: { name: 'Tower Explorer', desc: 'Reach F50 in the Dungeon Tower' },
  towerlord: { name: 'Lord of 100 Floors', desc: 'Conquer all 100 tower floors' },
  ultimate: { name: 'Heir of Mastery', desc: 'Use 100 ultimate skills' },
  ultgod: { name: 'Grand Master of Arts', desc: 'Use 500 ultimate skills' },
  missionman: { name: 'Mission Runner', desc: 'Complete 50 missions' },
  missiongod: { name: 'Mission Demon', desc: 'Complete 300 missions' },
  achiever: { name: 'Trophy Hunter', desc: 'Unlock 20 achievements' },
  completionist: { name: 'Completionist', desc: 'Unlock 40 achievements' },
  loyal7: { name: 'Perfect Attendance', desc: 'Log in 7 days in a row' },
  loyal30: { name: 'Immovable Regular', desc: 'Log in 30 days in a row' },
  survivor: { name: 'Survival Instinct', desc: 'Reach wave 20 in Survival' },
  millionaire: { name: 'Millionaire', desc: 'Reach 1,000,000 total score' },
  sprinter: { name: 'Gale-Force Blocker', desc: 'Score 20,000 in a 60s Time Attack' },
  buddy: { name: 'Great Duo', desc: 'Play 10 co-op runs' },
  soulmate: { name: 'In Perfect Sync', desc: 'Reach 20,000 in co-op' },
  abysswalker: { name: 'Abyss Gazer', desc: 'Reach A50 in the Abyss Dungeon' },
  abysslord: { name: 'Lord of the Abyss', desc: 'Conquer A100 in the Abyss Dungeon' },
  guildfounder: { name: 'Guild Founder', desc: 'Found a guild' },
  guildace: { name: 'Guild Ace', desc: 'Contribute 2,000 guild points in a week' },
  weeklyking: { name: 'Weekly Sovereign', desc: 'Finish #1 in the weekly challenge' },
  bossmaster: { name: 'Perfect Slayer', desc: 'S-rank every boss' },
  hellrunner: { name: 'Hell Runner', desc: 'Reach depth 12 in Infinite Hell Rush' },
  ruinsage: { name: 'Ancient Sage', desc: 'Clear Puzzle Ruins stage 30' },
  miner: { name: 'Master Miner', desc: 'Reach depth 50 in the Mines' },
  gachaprince: { name: 'Gacha Prodigy', desc: 'Pull the gacha 100 times' },
  lobbyface: { name: 'Lobby Regular', desc: 'Send 300 chat messages' },
  ghostmaster: { name: 'Ghost Whisperer', desc: 'Score 15,000 in the Haunted House' },
  mecha: { name: 'Deus Ex Machina', desc: '' },
  frost: { name: 'Frost Queen Frione', desc: '' },
};

// Name/description for a catalog object ({id, name, desc}) in the UI language.
export function catName(obj) {
  if (LANG === 'en' && obj && CATALOG_EN[obj.id]) return CATALOG_EN[obj.id].name;
  return obj ? obj.name : '';
}
export function catDesc(obj) {
  if (LANG === 'en' && obj && CATALOG_EN[obj.id] && CATALOG_EN[obj.id].desc) return CATALOG_EN[obj.id].desc;
  return obj ? obj.desc : '';
}

// ---------------------------------------------------------------------------
// Server messages arrive in Japanese; translate the common ones client-side.
// ---------------------------------------------------------------------------

const SERVER_MSG_EN = {
  '投票は開催されていません': 'No poll is running',
  'この投票は終了しています': 'This poll has closed',
  '選択肢が見つかりません': 'That option no longer exists',
  'すでにその選択肢に投票済みです': 'You already voted for that option',
  '選択肢は2つ以上必要です': 'A poll needs at least 2 options',
  '質問を入力してください': 'Enter a question',
  'ミッションが見つかりません': 'Mission not found',
  'まだ達成していません': 'Not completed yet',
  'すでに受け取り済みです': 'Already claimed',
  'まだ全て達成していません': 'Not every mission is claimed yet',
  '受け取れる実績がありません': 'No achievements ready to claim',
  'まだ達成していないか、受け取り済みです': 'Not unlocked yet, or already claimed',
  'サーバーに接続できません': 'Cannot reach the server',
  'ログインが必要です': 'Please log in first',
  'このアカウントは凍結されています': 'This account is suspended',
  'アカウントが凍結されています': 'This account is suspended',
  'ユーザー名またはパスワードが違います': 'Wrong username or password',
  'ユーザー名は2〜16文字（英数字・日本語）で入力してください': 'Username must be 2–16 characters (letters, numbers, Japanese)',
  'パスワードは6文字以上にしてください': 'Password must be at least 6 characters',
  'そのユーザー名は既に使われています': 'That username is already taken',
  '現在と同じ名前です': 'That is already your name',
  'パスワードが違います': 'Wrong password',
  '試行回数が多すぎます。しばらく待ってください': 'Too many attempts — please wait a bit',
  '🛠 メンテナンス中です。しばらくお待ちください': '🛠 Under maintenance — please wait',
  'コインが足りません': 'Not enough coins',
  'ジェムが足りません': 'Not enough gems',
  'すでに所持しています': 'You already own this',
  'すでにプレミアムです': 'You already have Premium',
  'プレミアムパスが必要です': 'Premium pass required',
  'まだ解放されていません': 'Not unlocked yet',
  '受け取り済みです': 'Already claimed',
  '報酬がありません': 'No reward here',
  'ティアが見つかりません': 'Tier not found',
  'アイテムが見つかりません': 'Item not found',
  'アイテムを持っていません': "You don't have that item",
  '所持していないアイテムです': "You don't own that item",
  '不正なアイテムです': 'Invalid item',
  '不正なスロットです': 'Invalid slot',
  '称号が見つかりません': 'Title not found',
  'まだ獲得していない称号です': "You haven't earned that title yet",
  'ルームが見つかりません': 'Room not found',
  'ルームが満員です': 'The room is full',
  'ホストのみ開始できます': 'Only the host can start',
  '連投しすぎです。少し待ってください': "You're sending too fast — wait a moment",
  '🔇 管理者によりチャットが制限されています': '🔇 Chat restricted by an admin',
  '💳 課金機能は製作中です。もうしばらくお待ちください！': '💳 Payments are coming soon!',
  '決済サービスに接続できません': 'Could not reach the payment service',
  '決済セッションの作成に失敗しました': 'Failed to start the checkout session',
  '購入リクエストが多すぎます': 'Too many purchase requests',
  'パックが見つかりません': 'Pack not found',
  'ユーザーが見つかりません': 'User not found',
  // ---- v2.10 完全対応: セッション/プロフィール/バグ報告/ガチャ/ギルド ----
  'アカウントのデータが見つかりません（データ復元待ち）': 'Account data not found (restore pending)',
  'セッションが終了しました。もう一度ログインしてください': 'Your session has ended — please log in again',
  'その名前はアリーナの住人が使っています。別の名前でどうぞ': 'That name belongs to an Arena resident — please pick another',
  '少し待ってください': 'Please wait a moment',
  'プレイヤーが見つかりません': 'Player not found',
  '報告が多すぎます。少し待ってください': 'Too many reports — please wait a bit',
  'もう少し詳しく書いてください': 'Please add a little more detail',
  '受け取れるランキング報酬はありません': 'No ranking rewards to claim',
  '🎰 ガチャ限定の装備です（SSRで入手）': '🎰 Gacha-exclusive gear (SSR pull only)',
  'ギルド名は2〜16文字（英数字・日本語）で入力してください': 'Guild name must be 2–16 characters (letters, numbers, Japanese)',
  'タグは1〜4文字（英数字・カタカナ・漢字）で入力してください': 'Tag must be 1–4 characters (A–Z, 0–9, katakana, kanji)',
  'すでにギルドに所属しています': 'You are already in a guild',
  'すでにギルドに所属しています。先に脱退してください': 'You are already in a guild — leave it first',
  'そのギルド名は使われています': 'That guild name is taken',
  'そのタグは使われています': 'That tag is taken',
  'このギルドは招待制です（ルームコードが必要）': 'This guild is invite-only (code required)',
  '脱退から1時間はギルドに参加できません': 'You must wait 1 hour after leaving before joining a guild',
  'ギルドリーダーのみ操作できます': 'Only the guild leader can do that',
  'リーダーは除名できません': 'The leader cannot be kicked',
  'そのメンバーはいません': 'That member is not in the guild',
  'ギルドが見つかりません': 'Guild not found',
  'そのコードのギルドは見つかりません': 'No guild with that code',
  'ギルドに所属していません': 'You are not in a guild',
  'ギルドリーダーのみ変更できます': 'Only the guild leader can change settings',
  '管理者専用のアイテムです（非売品）': 'Staff-only item (not for sale)',
  '管理者専用のアイテムです': 'Staff-only item',
  '管理者専用の装備です（非売品）': 'Staff-only gear (not for sale)',
  '管理者専用の装備です': 'Staff-only gear',
  'ファイルが大きすぎます（最大64MB）': 'File is too large (max 64MB)',
  'JSONとして読み取れませんでした': 'Could not parse the file as JSON',
  '接続タイムアウト': 'Connection timed out',
  '対戦相手が見つかりません': 'Opponent not found',
  '再戦の相手はもういません': 'Your opponent has left — no rematch',
};

const SERVER_MSG_PATTERNS = [
  [/^名前変更は1日1回までです（あと約(\d+)時間）$/, (m) => `You can rename once per day (about ${m[1]}h left)`],
  [/^あと(\d+)人必要です（ボット補充をONにもできます）$/, (m) => `Need ${m[1]} more player(s) — or enable bot fill`],
  [/^この設定では最大(\d+)人です（チーム戦に変更してください）$/, (m) => `Max ${m[1]} players for this setup — switch to team mode`],
  [/^コインが足りません（([\d,]+)必要）$/, (m) => `Not enough coins (need ${m[1]})`],
  [/^ギルドは満員です（最大(\d+)人）$/, (m) => `The guild is full (max ${m[1]} members)`],
  [/^ギルド設立には🪙(\d+)必要です$/, (m) => `Founding a guild costs 🪙${m[1]}`],
];

export function trServer(msg) {
  if (LANG !== 'en' || !msg) return msg;
  if (SERVER_MSG_EN[msg]) return SERVER_MSG_EN[msg];
  for (const [re, fn] of SERVER_MSG_PATTERNS) {
    const m = String(msg).match(re);
    if (m) return fn(m);
  }
  return msg;
}

// Rewrites the static HTML (menu, nav, sub-screen chrome) for English.
// Japanese is the source of truth in index.html, so 'ja' is a no-op.
export function applyStaticI18n() {
  document.documentElement.lang = LANG;
  if (LANG !== 'en') return;

  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };

  // menu buttons
  set('#btnSolo', '▶ Solo Play');
  set('#btnVsAi', '🤖 VS AI');
  set('#btnBoss', '🐲 Boss Battle');
  set('#btnDungeon', '🏰 Dungeon');
  set('#btnSprint', '⏱️ Time Attack');
  set('#btnWeekly', '🎯 Weekly');
  set('#btnSurvival', '💀 Survival');
  set('#btnMeltdown', '☢️ Meltdown');
  set('#btnChimera', '🧬 Chimera Lab');
  set('#btnPuzzle', '🧩 Puzzle Ruins');
  set('#btnDig', '⛏️ The Mines');
  set('#btnGhost', '👻 Haunted House');
  set('#btnChaos', '🌪️ Chaos Mode');
  set('#btnOnline', '🌐 Online Battle');

  // in-game HUD tooltips
  const tips = {
    '#btnReroll': 'Redraw your pieces (once per game)',
    '#btnUlt': 'Ultimate: fire it once the gauge is full!',
    '#btnEmote': 'Send an emote',
    '[data-item="item_bomb"]': 'Smart Bomb: blows up the densest 3×3',
    '[data-item="item_cleaner"]': 'Cleaner: clears garbage + the bottom row',
    '[data-item="item_fever"]': 'Fever: 2× score for 15 seconds',
    '[data-item="item_mini"]': 'Mini Blocks: turns your hand into tiny pieces',
  };
  for (const [sel, tip] of Object.entries(tips)) {
    const el = document.querySelector(sel);
    if (el) el.title = tip;
  }

  // nav (each is <span>icon</span> + text node)
  const nav = { btnMissions: 'Missions', btnGuild: 'Guild', btnNews: 'News', btnLeaderboard: 'Ranking', btnShop: 'Shop', btnGacha: 'Gacha', btnGemShop: 'Gems', btnBattlePass: 'Pass', btnAdmin: 'Admin' };
  for (const [id, label] of Object.entries(nav)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const icon = el.querySelector('span') ? el.querySelector('span').outerHTML : '';
    const dot = el.querySelector('.nav-dot') ? el.querySelector('.nav-dot').outerHTML : '';
    el.innerHTML = `${icon}${label}${dot}`;
  }

  // online badge (keep the counter element)
  const badge = document.getElementById('onlineBadge');
  if (badge) {
    const n = document.getElementById('onlineCount')?.textContent || '0';
    badge.innerHTML = `🟢 Online: <b id="onlineCount">${n}</b><span id="moodTag" class="mood-tag"></span>`;
  }

  // sub-screen headers + tabs
  set('#screen-leaderboard .sub-header h2', '🏆 Ranking');
  set('[data-lb="score"]', 'High Score');
  set('[data-lb="rating"]', 'Rating');
  set('[data-lb="sprint"]', '⏱️Time Attack');
  set('[data-lb="dungeon"]', 'Dungeon');
  set('[data-lb="weekly"]', 'Weekly');
  set('[data-lb="puzzle"]', '🧩Puzzle Ruins');
  set('[data-lb="dig"]', '⛏️The Mines');
  // tooltips + document title
  const attr = (sel, name, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(name, val); };
  attr('#btnSettings', 'title', 'Settings');
  attr('#liveFeed', 'title', 'Live feed');
  attr('#chaosBar', 'title', 'Until the next rule change');
  attr('#chatReplyCancel', 'title', 'Cancel reply');
  document.title = 'Block Blitz Arena — Block Puzzle × Online Battles';
  set('#screen-shop .sub-header h2', '🛍️ Shop');
  set('[data-shop="skin"]', 'Blocks');
  set('[data-shop="board"]', 'Boards');
  set('[data-shop="fx"]', 'Effects');
  set('[data-shop="ult"]', '⚡Ultimates');
  set('[data-shop="item"]', 'Items');
  set('#screen-missions .sub-header h2', '📋 Missions');
  set('#screen-guild .sub-header h2', '🏰 Guild');
  set('[data-gd="mine"]', 'My Guild');
  set('[data-gd="rank"]', 'Ranking');
  set('[data-gd="find"]', 'Find');
  set('#screen-news .sub-header h2', '📰 News');
  set('#btnNewsPost', '✍️ Post');
  set('[data-ms="daily"]', 'Daily');
  set('[data-ms="weekly"]', 'Weekly');
  set('[data-ms="ach"]', '🏅 Achievements');
  set('#screen-battlepass .sub-header h2', '🎫 Battle Pass');
  set('#screen-room .sub-header h2', '🔧 Custom Room');

  // matchmaking
  set('#mmStatus', 'Looking for an opponent…');
  const mmSub = document.getElementById('mmSub');
  if (mmSub) mmSub.innerHTML = 'Online: <span id="mmOnline">-</span> players';
  set('#btnCancelQueue', 'Cancel');

  // custom room
  set('#btnCreateRoom', '➕ Create Room');
  set('#btnJoinRoom', 'Join');
  const codeInput = document.getElementById('roomCodeInput');
  if (codeInput) codeInput.placeholder = 'CODE';
  const joinNote = document.querySelector('#roomJoin .muted');
  if (joinNote) joinNote.innerHTML = 'Gather friends with the same code!<br>In team mode the first two players form Team A';
  const roomCode = document.querySelector('.room-code');
  if (roomCode) roomCode.innerHTML = `Room code <b id="roomCodeLabel">----</b>`;
  set('#btnLeaveRoom', 'Leave');
  set('#btnStartRoom', '🚀 Start!');

  // chat drawer
  const chatHead = document.querySelector('.chat-head');
  if (chatHead) chatHead.innerHTML = `💬 Global Chat <span id="chatOnline" class="muted"></span>`;
  const chatInput = document.getElementById('chatInput');
  if (chatInput) chatInput.placeholder = 'Message everyone…';
  set('#chatSend', 'Send');

  // splash + admin panel bits players never see stay Japanese
  set('.ts-tap', '▶ Tap to Start');
}
