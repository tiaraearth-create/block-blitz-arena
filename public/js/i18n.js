// Lightweight i18n: Japanese (default) / English.
// Usage: t('日本語テキスト', 'English text') — inline pairs, no key tables.
// The language is stored in localStorage and auto-detected on first visit.

import { CATALOG_EN } from './catalog-en.js';

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
// Catalog translations: server data (shop/bosses/titles) ships Japanese names
// — the client swaps them by id. 表そのものは catalog-en.js（サーバーと共用）。
// ---------------------------------------------------------------------------

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
  // v2.12: 英語面に日本語のトーストが出ていたぶんをまとめて追加。
  // trServer は表に無い文字列をそのまま返すので、抜けても壊れない ──
  // だから気づかれないまま残る。増やしたら必ずここも足すこと。
  'ファイルが大きすぎます（最大4MB）': 'That file is too large (4MB max)',
  'その名前は使えません。別の名前でどうぞ': 'That name is not available — please pick another',
  '名前を入力してください': 'Enter a name',
  'メッセージが空です': 'Your message is empty',
  'すこし待ってからお試しください': 'Please wait a moment and try again',
  'すこし早すぎます': 'A little too fast — slow down',
  '連投しすぎです。少し待ってください': 'Too many messages in a row — please wait a moment',
  '通信エラーが発生しました': 'A connection error occurred',
  '権限がありません': 'You do not have permission',
  'モデレーター権限が必要です': 'Moderator permission is required',
  '接続数が上限に達しています。しばらくしてからお試しください': 'The server is at capacity — please try again shortly',
  '同時接続が多すぎます': 'Too many simultaneous connections',
  '同じアカウントの接続が多すぎます': 'Too many connections from this account',
  'その名前は使えません。別の名前になりました': 'That name is taken — you have been given another',
  '結果の送信が多すぎます。しばらく待ってください': 'Too many results submitted — please wait a moment',
  '送信が多すぎます。しばらく待ってください': 'Too many submissions — please wait a moment',
  'アイテムを持っていません': 'You do not have that item',
  '所持していないアイテムです': 'You do not own that item',
  'まだ獲得していない称号です': 'You have not earned that title yet',
  'アリーナが満席です。次の枠でお待ちしています': 'The arena is full — see you in the next slot',
  'いま開催予定の管理者イベントはありません': 'No Admin Event is scheduled right now',
  'いまはあなたの枠の時間ではありません': 'This is not your slot',
  '受け取れる報酬がありません': 'There is nothing to claim',
  'この回に参加していません': 'You did not take part in this one',
  'まだ目標に届いていません（ゲージを進めよう）': 'The goal has not been reached yet — keep filling the gauge',
  '開催中のイベントがありません': 'No event is running',
  '👑 管理者イベント専用ショップの品です（王座の欠片でのみ交換）': '👑 Admin Event exclusive — only Throne Shards can buy this',
  'そんな品はありません': 'No such item',
  'すでに持っています': 'You already have it',
  'フレンド機能を使うにはアカウント登録が必要です': 'You need an account to use friends',
  '申請できませんでした': 'The request could not be sent',
  '自分には申請できません': 'You cannot send yourself a request',
  'すでにフレンドです': 'You are already friends',
  '申請ずみです': 'Already requested',
  'その申請はありません': 'There is no such request',
  '相手が見つかりません': 'That player could not be found',
  '相手のフレンドがいっぱいです': 'Their friend list is full',
  '自分はブロックできません': 'You cannot block yourself',
  'すでにパーティーにいます': 'You are already in a party',
  'いまパーティーがいっぱいです。少し待ってください': 'All party slots are busy — please wait a moment',
  'パーティーを作れませんでした': 'The party could not be created',
  'そのパーティーは見つかりません': 'No party with that code',
  'パーティーがいっぱいです': 'That party is full',
  'そのパーティーには参加できません': 'You cannot join that party',
  'パーティーにいません': 'You are not in a party',
  'リーダーだけができます': 'Only the leader can do that',
  '自分は追い出せません': 'You cannot remove yourself',
  'その人はいません': 'They are not in the party',
  'パーティーから外れました': 'You were removed from the party',
  'その人はすでに別のパーティーにいます': 'They are already in another party',
  '招待できませんでした': 'The invite could not be sent',
  'その人はいまオフラインです': 'They are offline right now',
  'その招待は見つかりません': 'That invite no longer exists',
  'その招待は期限切れです': 'That invite has expired',
  'そのパーティーは解散しています': 'That party has broken up',
  'そのパーティーはありません': 'No such party',
  'パーティーは運営により解散されました': 'Staff broke up this party',
  'パーティーは時間切れで解散しました': 'The party broke up after everyone went offline',
  '対戦中のメンバーがいます。終わるまで待ってください': 'Someone is still in a match — wait until they finish',
  '部屋を作れませんでした。もう一度お試しください': 'Could not open the room — please try again',
  'サーバーの更新のため、パーティーを解散しました': 'The party was disbanded for a server update',
  '通報が多すぎます。すこし待ってください': 'Too many reports — please wait a moment',
  'いまは受け付けられません': 'That cannot be accepted right now',
  'いまは読めません': 'That cannot be read right now',
  'いまはできません': 'That cannot be done right now',
  '報告が見つかりません': 'Report not found',
  'お知らせが見つかりません': 'That notice no longer exists',
  'タイトルと本文を入力してください': 'Enter a title and a body',
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
  // 'アイテムを持っていません' / '所持していないアイテムです' /
  // 'まだ獲得していない称号です' / '連投しすぎです。少し待ってください' は
  // この表の上（v2.12 の追加ぶん）に既にある。オブジェクトリテラルの重複キーは
  // 後勝ちなので、ここに二重に書くと上の訳が黙って死ぬ。増やすときは必ず
  // 既にあるか確かめること（表全体は非短縮形で揃えてある）。
  '不正なアイテムです': 'Invalid item',
  '不正なスロットです': 'Invalid slot',
  '称号が見つかりません': 'Title not found',
  'ルームが見つかりません': 'Room not found',
  'ルームが満員です': 'The room is full',
  'ホストのみ開始できます': 'Only the host can start',
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
  // v2.34: 登録／改名で名前が弾かれる理由の出し分けをやめたので、この文は
  // サーバーから出なくなった。この1行だけで「住人」という別種の名前枠がある
  // ことが読み取れてしまうため、死んだ対訳ごと消す。
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
  'データが大きすぎます（最大64KB）': 'That data is too large (64KB max)',
  'JSONとして読み取れませんでした': 'Could not parse the file as JSON',
  '接続タイムアウト': 'Connection timed out',
  '対戦相手が見つかりません': 'Opponent not found',
  '再戦の相手はもういません': 'Your opponent has left — no rematch',
  // v2.16: trServer は通るのに表に無かったプレイヤー向け固定文言を追加。
  '🛠 サーバー更新のためマッチングを中止しました。少し待ってからもう一度お試しください': '🛠 Matchmaking was cancelled for a server update — please wait a moment and try again',
  'その時間枠は存在しません': 'That time slot does not exist',
  'その枠はもう終わっています': 'That slot has already ended',
  '開催中の枠からは変更できません': 'You cannot switch away from a slot that is live',
  '開始の連打はできません。少し待ってください': 'You are starting too fast — please wait a moment',
  '報告箱がいっぱいです。少し時間をおいてからお願いします': 'The report box is full — please try again a little later',
  'サーバー内部でエラーが発生しました': 'An internal server error occurred',
  '投票がありません': 'No poll is running',
  // 👁️ 断罪（管理者ゼロ）── 取引投票と伝言まわりのサーバー送信文言。
  'もう投票しました': 'You have already voted',
  '投票を受け付けられません': 'Your vote could not be accepted',
  '伝言は、段にとどめを刺した人だけが残せます': 'Only the player who landed the finishing blow on a tier can leave a message',
  '伝言を入力してください': 'Enter a message',
  // ---- 🔁 ミッションの引き直し（missions.js / index.js の /api/missions/reroll）----
  '受け取り済みのミッションは引き直せません': 'A claimed mission cannot be rerolled',
  'きょうの引き直しは使い切りました': 'No mission rerolls left today',
  '引き直せるお題がもうありません': 'No other missions left to draw',
  'ミッションを選んでください': 'Pick a mission first',
  'このミッションは引き直せません': 'That mission cannot be rerolled',
  'ミッションの引き直しはまだ使えません': 'Mission rerolls are not available yet',
  '引き直しが多すぎます。少し待ってください': 'Too many rerolls — please wait a moment',
  '引き直しに失敗しました': 'The reroll failed',
  // ---- 🏰 ギルドクエストの金庫（guilds.js）----
  'そのクエストは見つかりません': 'Quest not found',
  'そのクエストは今週のものではありません': 'That quest is not part of this week',
  'ギルドがまだ達成していません': 'Your guild has not completed it yet',
  '今週は別のギルドで金庫を開けています': 'You already opened another guild vault this week',
  // ---- 📕 コレクション図鑑（catalog.js の claimCollection）----
  '受け取れるセットがありません': 'No collection sets ready to claim',
  'まだコンプしていないか、受け取り済みです': 'Not complete yet, or already claimed',
  '図鑑の報酬は1日1セットまでです（残りはまた明日）': 'You can claim one collection set per day — the rest are waiting tomorrow',
  // ---- 🔔 挑戦状（friends.js）----
  '挑戦状を送れませんでした': 'The challenge could not be sent',
  '自分には送れません': 'You cannot send that to yourself',
  '今日のデイリーチャレンジの記録がまだありません': 'You have no Daily Challenge record today yet',
  'この相手にはもう送っています': 'You have already sent one to this player',
  'その挑戦状はありません': 'There is no such challenge',
  // ---- 🎁 本日の無料ギフト / 🧳 ゲスト記録の引き継ぎ（index.js）----
  '本日の無料ギフトは受け取り済みです': 'The free gift for today has already been claimed',
  'ゲスト記録の引き継ぎは1アカウント1回だけです（すでに実行済み）': 'Guest progress can be imported only once per account (already done)',
  // ---- 🧩 パズル工房（index.js の /api/workshop/*）----
  // 英文は server/index.js が同じ応答に載せている errorEn とそろえてある
  // （どちらの経路で拾っても同じ文が出る）。数が入る文言は下の
  // SERVER_MSG_PATTERNS 側。
  '投稿が多すぎます。時間をおいてください': 'Too many submissions — please try again later',
  'クリアの記録が読めません。もう一度自分でクリアしてから投稿してください': 'That clear record is unreadable — clear the stage yourself once more, then submit',
  'そのステージはサーバー側で再生してもクリアできませんでした（解けるステージだけ投稿できます）': 'Replaying your clear on the server did not solve the stage — only solvable stages can be published',
  '工房がいっぱいです。しばらくしてからお試しください': 'The workshop is full — please try again later',
  '共有コードを発行できませんでした。もう一度お試しください': 'Could not mint a share code — please try again',
  'そのコードのステージは見つかりません': 'No stage with that code',
  'すでに♡を送っています': 'You already liked this stage',
  '♡の受付は上限に達しました': 'This stage has reached its like limit',
  '自分が投稿したステージだけ削除できます': 'You can only delete stages you published',
};

const SERVER_MSG_PATTERNS = [
  [/^名前変更は1日1回までです（あと約(\d+)時間）$/, (m) => `You can rename once per day (about ${m[1]}h left)`],
  [/^あと(\d+)人必要です（ボット補充をONにもできます）$/, (m) => `Need ${m[1]} more player(s) — or enable bot fill`],
  [/^この設定では最大(\d+)人です（チーム戦に変更してください）$/, (m) => `Max ${m[1]} players for this setup — switch to team mode`],
  [/^コインが足りません（([\d,]+)必要）$/, (m) => `Not enough coins (need ${m[1]})`],
  [/^ギルドは満員です（最大(\d+)人）$/, (m) => `The guild is full (max ${m[1]} members)`],
  [/^ギルド設立には🪙(\d+)必要です$/, (m) => `Founding a guild costs 🪙${m[1]}`],
  [/^このモードは(\d+)人までです（いま(\d+)人）$/, (m) => `This mode is for up to ${m[1]} players (you have ${m[2]} now)`],
  // 🧩 パズル工房の投稿検査。数はサーバーの定数（WS_TITLE_MAX / WS_MIN_CELLS /
  // WS_MAX_PIECES / WS_MAX_PER_USER）から埋まるので、上限を調整しても英訳が
  // 死なないように正規表現で受ける。
  [/^ステージ名は(\d+)〜(\d+)文字で入力してください$/, (m) => `The stage name must be ${m[1]}–${m[2]} characters`],
  [/^盤面が不正です（8×8・光るマスは(\d+)個以上）$/, (m) => `Invalid board (8×8, at least ${m[1]} glowing cells)`],
  [/^ピースは(\d+)〜(\d+)個で指定してください$/, (m) => `Provide ${m[1]}–${m[2]} pieces`],
  [/^投稿できるのは1人(\d+)ステージまでです。古いものを削除してください$/, (m) => `You can publish up to ${m[1]} stages — delete an old one first`],
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

  const set = (sel, text) => {
    const el = document.querySelector(sel);
    if (!el) return;
    // 通知ドット(.nav-dot)を内包する要素は textContent 代入だとドットごと消える。
    // ドット要素を退避してからテキストを入れ、差し戻す（id/hidden 状態を保つ）。
    const dot = el.querySelector('.nav-dot');
    el.textContent = text;
    if (dot) el.appendChild(dot);
  };

  // menu buttons
  set('#btnSolo', '▶ Solo Play');
  set('#btnVsAi', '🤖 VS AI');
  set('#btnBoss', '🐲 Boss Battle');
  set('#btnDungeon', '🏰 Dungeon');
  set('#btnSprint', '⏱️ Time Attack');
  set('#btnWeekly', '🎯 Weekly');
  set('#btnDaily', '📅 Daily');
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
  // btnRules（📖 遊び方）はナビの先頭。ここに無いと、英語で遊ぶ人だけ
  // 唯一のルール説明の入口が日本語のまま残る。
  const nav = { btnRules: 'How to Play', btnMissions: 'Missions', btnFriends: 'Friends', btnGuild: 'Guild', btnNews: 'News', btnLeaderboard: 'Ranking', btnInventory: 'Items', btnShop: 'Shop', btnGacha: 'Gacha', btnGemShop: 'Gems', btnBattlePass: 'Pass', btnAdmin: 'Admin' };
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
  set('[data-lb="daily"]', '📅Daily');
  set('[data-lb="puzzle"]', '🧩Puzzle Ruins');
  set('[data-lb="dig"]', '⛏️The Mines');
  // tooltips + document title
  const attr = (sel, name, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(name, val); };
  attr('#btnSettings', 'title', 'Settings');
  // ⚙️ は起動時に icons.js のアイコン（aria-hidden）へ差し替わるので、
  // 名前は aria-label だけが持つ。title と両方を英語にしておくこと。
  attr('#btnSettings', 'aria-label', 'Settings');
  attr('#liveFeed', 'title', 'Live feed');
  attr('#chaosBar', 'title', 'Until the next rule change');
  attr('#chatReplyCancel', 'title', 'Cancel reply');
  // 絵文字だけのボタンは、読み上げでは名前が無いと「✕ ボタン」としか出ない。
  // 日本語面の名前は index.html 側に置いてある。
  attr('#btnQuit', 'title', 'Quit');
  attr('#btnQuit', 'aria-label', 'Quit');
  attr('#chatToggle', 'title', 'Global chat');
  attr('#chatToggle', 'aria-label', 'Open global chat');
  // 試合が始まると game.js がもっと詳しい名前へ差し替える（こちらは控え）。
  attr('#gameCanvas', 'aria-label', 'Game board');
  for (const el of document.querySelectorAll('[data-back], #btnRoomBack')) {
    el.setAttribute('title', 'Back');
    el.setAttribute('aria-label', 'Back');
  }
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
  // 🎒 インベントリはここに1行も無く、英語で遊ぶと画面ごと日本語のままだった。
  set('#screen-inventory .sub-header h2', '🎒 Inventory');
  set('[data-inv="gear"]', 'Gear');
  set('[data-inv="item"]', 'Items');
  set('[data-inv="title"]', 'Titles');
  set('[data-inv="badge"]', 'Badges');
  // 🤝 フレンド（v2.12 で追加）
  set('#screen-friends .sub-header h2', '🤝 Friends');
  set('[data-fr="list"]', 'Friends');
  // 「申請」タブは中に通知ドット(#frReqDot)を内包しているが、set() が
  // ドットを退避・差し戻すので textContent 代入でも消えない。
  set('[data-fr="requests"]', 'Requests');
  set('[data-fr="find"]', 'Find');
  set('[data-fr="settings"]', 'Settings');
  set('#screen-news .sub-header h2', '📰 News');
  set('#btnNewsPost', '✍️ Post');
  set('[data-ms="daily"]', 'Daily');
  set('[data-ms="weekly"]', 'Weekly');
  set('[data-ms="ach"]', '🏅 Achievements');
  set('#screen-battlepass .sub-header h2', '🎫 Battle Pass');
  set('#screen-room .sub-header h2', '🔧 Custom Room');

  // matchmaking
  set('#mmStatus', 'Looking for an opponent…');
  // 人数の行は #mmSub ではなく #mmOnlineLine が持っている（#mmSub は待ち時間表示で
  // innerHTML ごと差し替わるため、id を外へ出した経緯が index.html にある）。
  // ここで #mmSub に書いていたせいで、実際に見えている #mmOnlineLine は日本語のまま
  // 残り、そのうえ id="mmOnline" が一時的に2個できていた。
  const mmOnlineLine = document.getElementById('mmOnlineLine');
  if (mmOnlineLine) {
    const n = document.getElementById('mmOnline')?.textContent || '-';
    mmOnlineLine.innerHTML = `Online: <span id="mmOnline">${n}</span> players`;
  }
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
