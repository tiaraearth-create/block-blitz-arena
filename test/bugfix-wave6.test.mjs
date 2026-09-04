// リポジトリのルートから:  node test/bugfix-wave6.test.mjs
//
// 🐛 バグ修正 第6波 ──「数が合わない」「嘘の表示」「操作・端末差」。
//
// 第5波（進行不能）の次に重いのがこの3種類。どれも遊べてはいるので気づき
// にくいが、報酬が入らない／画面が嘘をつく／指が思ったとおりに動かない、
// という形で毎回すこしずつ損をする。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../public/js/engine.js';
import { translateLocal } from '../server/translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const modes = read('public/js/modes.js');
const game = read('public/js/game.js');
const dom = read('public/js/dom.js');
const chat = read('public/js/chat.js');
const party = read('public/js/party.js');
const screens = read('public/js/screens.js');
const friendsJs = read('public/js/friends.js');
const net = read('public/js/net.js');
const battle = read('server/battle.js');
const idx = read('server/index.js');
const guilds = read('server/guilds.js');
const ach = read('server/achievements.js');
const crowd = read('server/crowd.js');
const catalog = read('server/catalog.js');
const backup = read('server/backup.js');
const friendsSrv = read('server/friends.js');
const partySrv = read('server/party.js');

// ===========================================================================
// A. 報酬・記録の数が合う
// ===========================================================================
{
  // A-1 バトルパス: もう持っている装備品が当たったら、同じ値段ぶんを払う
  const i = read('server/routes/missions.js').indexOf("missionsRouter.post('/api/battlepass/claim'");
  const bp = i < 0 ? '' : read('server/routes/missions.js').slice(i, i + 2600);
  check('A-1 所持済みの装備品は通貨に振り替えて必ず払う',
    /const shopItem = SHOP_ITEMS\.find\(x => x\.id === reward\.id\);/.test(bp)
    && /user\[cur\] = \(user\[cur\] \|\| 0\) \+ amount;/.test(bp), '');
  check('A-2 何が入ったかを返す（トーストが嘘をつかない）',
    /paid = \{ type: cur, amount, insteadOf: reward\.id \};/.test(bp)
    && /res\.json\(\{ user: publicUser\(user\), reward: paid \}\);/.test(bp), '');

  // A-3 実績は「一度でも届いたか」で決まる
  check('A-3 レートは到達最高で見る', /const bestRating = u => Math\.max\(S\(u\)\.ratingBest \|\| 0, S\(u\)\.rating \|\| 0\);/.test(ach), '');
  check('A-4 コインも到達最高で見る', /const bestCoins = u => Math\.max\(S\(u\)\.coinsBest \|\| 0, u\.coins \|\| 0\);/.test(ach), '');
  check('A-5 ギルドは「一度でも入ったか」', /const everJoinedGuild = u => \(u\.guildId \|\| S\(u\)\.guildJoinedEver\) \? 1 : 0;/.test(ach), '');
  check('A-6 いまの値を見る書き方が残っていない',
    !/u => S\(u\)\.rating \|\| 0/.test(ach) && !/u => u\.coins \|\| 0\)/.test(ach)
    && !/u => u\.guildId \? 1 : 0/.test(ach), '');
  check('A-7 加入したら印を刻む', /markGuildEver\(user\);/.test(guilds) && /markGuildEver\(owner\);/.test(guilds), '');

  // A-8 練習試合で連勝を消さない
  check('A-8 勝敗を判定しない試合に印がある', /unrated: !!friendly,/.test(battle), '');
  check('A-9 その回は連勝を触らない', /if \(mode === 'pvp' && !unrated\) \{/.test(idx), '');
  check('A-10 陣取りも1対1の扱いに入れる',
    /match\.mode === 'duel' \|\| match\.mode === 'attack' \|\| match\.mode === 'land'/.test(battle), '');

  // A-11 ガチャの予算切れ
  const shop = read('server/routes/shop.js');
  check('A-11 予算切れの受け皿がある', /const boosterFallback = \(qty, rarity\) =>/.test(shop), '');
  check('A-12 SR が0のときブースターに振り替える', /if \(amount <= 0\) return boosterFallback\(2, 'SR'\);/.test(shop), '');
  check('A-13 UR が0のときも振り替える', /if \(amount <= 0\) return boosterFallback\(5, 'UR'\);/.test(shop), '');
  check('A-14 個数と理由を画面に出す', /r\.budgetOut \? tr\('（本日のジェム上限）'/.test(screens), '');

  // A-15 ボスラッシュの討伐数
  const missions = read('server/missions.js');
  check('A-15 ラッシュは撃破数で数える',
    /bossWin: mode === 'boss_rush' \? Math\.max\(0, Number\(bossKills\) \|\| 0\)/.test(missions), '');
  check('A-16 呼び出し側が撃破数を渡す', /bossKills: mode === 'boss_rush' \? depth : 0,/.test(idx), '');

  // A-17 道具棚コンプは使っても消えない
  check('A-17 そろえた印を残す', /user\.stats\.setEver\[set\.id\] = Date\.now\(\);/.test(catalog), '');
  check('A-18 印があれば在庫0でも達成のまま',
    /if \(set\.kind === 'boost' && user && user\.stats && user\.stats\.setEver\n\s+&& user\.stats\.setEver\[set\.id\]\) return true;/.test(catalog), '');

  // A-19 パズル遺跡の★をサーバーが預かる
  check('A-19 ★を送る', /duration: secs, won, stage: this\.stage, stars,/.test(modes), '');
  check('A-20 サーバーが高いほうだけ残す',
    /if \(\(Number\(s\.puzzleStars\[key\]\) \|\| 0\) < starsGot\) s\.puzzleStars\[key\] = starsGot;/.test(idx), '');
  check('A-21 ★にも頭押さえがある', /stars = clamp\(stars, 3\);/.test(idx), '');
  check('A-22 復元でも★を落とさない', /ws\.puzzleStars\[k\] = Math\.max/.test(backup), '');
  check('A-23 ギルドの印も復元で落とさない', /ws\.guildJoinedEver = loser\.stats\.guildJoinedEver;/.test(backup), '');
}

// ===========================================================================
// B. フレンド・パーティー・挑戦状
// ===========================================================================
{
  check('B-1 期限切れの申請は受信箱に出さない',
    /incoming: user\.friendReqIn\n\s+\.filter\(r => r && Date\.now\(\) - \(r\.at \|\| 0\) < REQ_EXPIRE_MS\)/.test(friendsSrv), '');
  check('B-2 期限切れを断っても7日ロックを刻まない',
    /const had = me\.friendReqIn\.some\(r => r\.from === fromId\n\s+&& Date\.now\(\) - \(r\.at \|\| 0\) < REQ_EXPIRE_MS\);/.test(friendsSrv), '');
  check('B-3 すれ違い成立も期限を見る',
    /if \(from\.friendReqIn\.some\(r => r\.from === toId && Date\.now\(\) - \(r\.at \|\| 0\) < REQ_EXPIRE_MS\)\)/.test(friendsSrv), '');

  check('B-4 除名で「脱退から1時間」を刻まない',
    /t\.guildKickedAt = Date\.now\(\);/.test(guilds) && !/t\.guildLeftAt = Date\.now\(\)/.test(guilds), '');
  check('B-5 断るのは元のギルドへの出戻りだけ',
    /user\.guildKickedFrom === guild\.id/.test(guilds), '');

  check('B-6 パーティーの状態は全部の画面へ配る',
    /function broadcast\(p, msg\) \{\n\s+for \(const m of p\.members\) sendToUser\(m\.userId, msg, \{ primaryOnly: false \}\);/.test(partySrv)
    && /function pushState\(p\) \{\n\s+for \(const m of p\.members\) sendToUser\(m\.userId, viewFor\(p, m\.userId\), \{ primaryOnly: false \}\);/.test(partySrv), '');
  check('B-7 一過性の通知だけ primary に残っている',
    (partySrv.match(/primaryOnly: true/g) || []).length === 7,
    `${(partySrv.match(/primaryOnly: true/g) || []).length}件`);

  check('B-8 挑戦状の受信箱がある', /届いている挑戦状/.test(friendsJs), '');
  check('B-9 消す口がサーバーにある',
    /'\/api\/friends\/challenge\/dismiss'/.test(read('server/routes/social.js')), '');
  check('B-10 通知ドットにも数える',
    /\(data\.incoming \|\| \[\]\)\.length \+ \(data\.challenges \|\| \[\]\)\.length/.test(friendsJs), '');

  check('B-11 招待は1件ずつ持つ（2通目で詰まらない）', /const pendingInvites = new Set\(\);/.test(party), '');
  check('B-12 出せなかったら次へ進める', /if \(modalOpen\(\)\) return;   \/\/ 出た/.test(party), '');
}

// ===========================================================================
// C. 嘘の表示・文言
// ===========================================================================
{
  // C-1 英→日の訳し残し
  check('C-1 訳し残しの英文は配らない',
    translateLocal('i finally beat the demon king', 'ja') === null, '');
  check('C-2 同上（別の例）',
    translateLocal('can someone explain how mines work', 'ja') === null, '');
  const nice = translateLocal('good game', 'ja');
  check('C-3 ちゃんと訳せる文は今までどおり', !!nice && nice.text === 'ナイスゲーム',
    nice ? nice.text : '(訳さない)');
  const en = translateLocal('すごい', 'en');
  check('C-4 日→英もこれまでどおり', !!en, en ? en.text : '(訳さない)');

  // C-5 味方の切断
  check('C-5 味方か敵かで文面を出し分ける',
    /const ally = !!\(who && who\.isAlly\) \|\| this\.kind === 'raid';/.test(modes), '');
  check('C-6 味方なら「あなたの勝ち」と言わない',
    /サーバーが席を埋めます（そのぶんの点は止まります）/.test(modes), '');

  // C-7 図鑑の金色ボタン
  check('C-7 上限に達したら金色を出さない', /claimable && session\.user && claimsLeft !== 0/.test(screens), '');
  check('C-8 各セットも押せる形で出さない', /claimsLeft === 0 \? tr\('あすまで', 'Tomorrow'\)/.test(screens), '');

  // C-9 引き直しの単位
  check('C-9 デイリー／ウィークリーで単位を出し分ける',
    /const per = daily \? tr\('本日', 'today'\) : tr\('今週', 'this week'\);/.test(screens), '');
  check('C-10 「本日」の直書きが残っていない',
    !/引き直しは本日ぶんを使い切りました/.test(screens) && !/引き直し 本日1回無料/.test(screens), '');

  // C-11 住人の返信
  check('C-11 中身の無い行をプールから外す判定がある', /export function lineUsable\(/.test(crowd), '');
  check('C-12 返信のプールがそれを通る', /const pool = usable\(\(lang === 'en' && spec\.en\)/.test(crowd), '');
  check('C-13 2人目・名指しのプールも通る',
    /const lines = usable\(useEn \? spec\.en : spec\.ja\);/.test(crowd)
    && /const pool2 = usable\(/.test(crowd), '');

  // C-14 ロイヤルのファイナル
  // 実際に**トーストとして出していない**ことを見る（コメントの中の引用は数えない）。
  check('C-14 トーストを1本に寄せた',
    !/toast\(t\('ファイナル！ 残り3人の盤面が見えます'/.test(modes)
    && /this\.royaleFeedLine\(ic\('fire', 13\) \+ ' ' \+ t\('ファイナル', 'FINALE'\)\);/.test(modes), '');

  // C-15 デイリーの連続クリア
  check('C-15 走行中は退避した日数を返す',
    /today\.pending && !today\.cleared \? \(today\.prevStreak \|\| 0\) : today\.streak/.test(read('server/routes/daily.js')), '');
  check('C-16 「（挑戦中）」を添える', /info\.inProgress \? `<small class="muted"> \$\{t\('（挑戦中）'/.test(read('public/js/main.js')), '');

  // C-17 ダンジョンの見出し
  check('C-17 領域の記号を使う', /\$\{this\.realm\.prefix\}\$\{this\.floor\} クリア！/.test(modes), '');
  check('C-18 「F」の直書きが残っていない', !/t\(`F\$\{this\.floor\} クリア！`/.test(modes), '');

  // C-19 ミュートは絵文字にも効く
  check('C-19 ミュート判定が1本にまとまった', /function isMuted\(ws\) \{/.test(battle), '');
  check('C-20 絵文字にも効く',
    /case 'emote': \{[\s\S]{0,600}?if \(isMuted\(ws\)\) return;/.test(battle), '');

  // C-21 管理者のブースター棚
  check('C-21 運営専用は買うボタンを出さない', /tr\('運営専用', 'Staff only'\)/.test(screens), '');
  check('C-22 所持数も ∞ で出す', /×\$\{staffItem \? '∞' : fmt\(count\)\}/.test(screens), '');
}

// ===========================================================================
// D. 操作・端末差
// ===========================================================================
{
  check('D-1 Enter の判定が1本にまとまった', /export function enterIsLive\(e\) \{/.test(dom), '');
  check('D-2 変換確定の Enter で送らない',
    /!e\.isComposing && e\.keyCode !== 229/.test(dom.slice(dom.indexOf('export function enterIsLive'))), '');
  for (const [name, src] of [['チャット', chat], ['パーティー', party], ['フレンド検索', friendsJs],
    ['ルーム/伝言', modes], ['ログイン/合言葉/検索', screens]]) {
    check(`D-3 ${name} が enterIsLive を通る`, /enterIsLive\(/.test(src), '');
  }
  check('D-4 素の Enter 判定が残っていない',
    ![chat, party, friendsJs, screens].some(s => /if \([a-z]+\.key === 'Enter'\)/.test(s)), '');

  check('D-5 左ボタン以外では掴まない', /if \(e\.button !== 0 \|\| e\.isPrimary === false\) return;/.test(game), '');
  check('D-6 盤面で右クリックメニューを出さない',
    /addEventListener\('contextmenu', e => e\.preventDefault\(\)\)/.test(game), '');

  check('D-7 掴んだときのコマを描く', /dragPiece\(\) \{/.test(game), '');
  check('D-8 すり替わったらドラッグを捨てる',
    /if \(live !== this\.drag\.piece\) \{\n\s+this\.drag = null;/.test(game), '');
  check('D-9 ゴーストも描画も同じ口を通る',
    (game.match(/this\.dragPiece\(\)/g) || []).length >= 2, '');

  check('D-10 氷結の判定が「必ず通る1本道」にある',
    /commitPlace\(index, piece, r, c\) \{[\s\S]{0,900}?if \(piece\.frozenUntil > Date\.now\(\)\) \{/.test(game), '');
  check('D-11 凍った枠の選択は落とす',
    /if \(this\.sel && this\.sel\.index === index\) this\.sel = null;/.test(game), '');

  check('D-12 無敵の残り時間を試合ごとに消す',
    /setEngine\(engine\) \{[\s\S]{0,1400}?this\.godInvincibleUntil = 0;/.test(game), '');

  check('D-13 復活する回は死亡音を鳴らさない',
    /const revived = this\.onGameOver \? this\.onGameOver\(\) === true : false;\n\s+if \(!revived\) audio\.gameOver\(\);/.test(game), '');
  check('D-14 モード側が「復活した」を返す',
    (modes.match(/\/\/ 戻り値 true ＝「復活したので死亡音は鳴らさないで」/g) || []).length === 2, '');

  check('D-15 戻るで履歴を積み直さない（空押しを溜めない）',
    /const to = screenStack\.pop\(\) \|\| 'menu';\n\s+poppingBack = true;\n\s+showScreen\(to, \{ push: false \}\);\n\s+poppingBack = false;\n\s+\}\);/.test(dom), '');

  check('D-16 チャットは読み返し中に引き戻さない',
    /const wasAtBottom = me \|\| box\.scrollHeight - box\.scrollTop - box\.clientHeight <= NEAR_BOTTOM;/.test(chat), '');
  check('D-16b 自分の一言だけは必ず下まで追う',
    /const wasAtBottom = me \|\|/.test(chat), '');
  check('D-16c 上を読んでいる間は、先頭を削ったぶんの位置を補正する',
    /if \(!wasAtBottom\) box\.scrollTop = Math\.max\(0, box\.scrollTop - h\);/.test(chat), '');
  check('D-17 新着の合図を出す', /function showChatNewBadge\(box\) \{/.test(chat), '');
  check('D-18 合図の見た目がある', /\.chat-new \{/.test(read('public/css/style.css')), '');
  check('D-19 ゲストも自分の吹き出しになる', /const me = msg\.from === myChatName\(\);/.test(chat), '');
  check('D-20 名前は hello_ok から控える', /if \(msg\.name\) myName = String\(msg\.name\);/.test(chat), '');

  check('D-21 チュートリアルが回転で置き直す',
    (modes.match(/window\.addEventListener\('orientationchange', this\._onResize\);/g) || []).length === 2, '');
  check('D-22 片付けで見張りを外す',
    (modes.match(/this\.unwatchResize\(\);/g) || []).length === 2, '');

  check('D-23 セールの時計はショップを離れたら止まる',
    /const onShop = document\.body\.dataset\.screen === 'shop';/.test(screens), '');
  check('D-24 日をまたいだら棚ごと引き直す',
    /if \(ended\) \{[\s\S]{0,200}?shopFetchedAt = 0;[\s\S]{0,80}?openShop\(shopTab, \{ keepScreen: true \}\);/.test(screens), '');
  check('D-25 ショップを離れた人を引き戻さない',
    /if \(keepScreen && document\.body\.dataset\.screen !== 'shop'\) return;/.test(screens)
    && (screens.match(/openShop\(shopTab, \{ keepScreen: true \}\)/g) || []).length === 2, '');
}

// ===========================================================================
// E. 圏外の控え
// ===========================================================================
{
  check('E-1 デイリーの控えは寿命が短い', /const DAILY_QUEUE_TTL_MS = 2 \* 60 \* 60 \* 1000;/.test(net), '');
  check('E-2 種類ごとに寿命を選ぶ', /const ttlFor = entry =>/.test(net), '');
  check('E-3 捨てたら必ず知らせる', /function noteResultsDropped\(count, reason\) \{/.test(net), '');
  check('E-4 寿命切れも知らせる', /if \(dropped > 0\) noteResultsDropped\(dropped, 'expired'\);/.test(net), '');
  check('E-5 401/400 で捨てたときも知らせる',
    /noteResultsDropped\(1, err\.status === 401 \|\| err\.status === 403 \? 'auth' : 'rejected'\);/.test(net), '');
  check('E-6 デイリーとして記録されなかった回も知らせる',
    /if \(d && d\.recorded === false\) noteResultsDropped\(1, d\.reason \|\| 'expired'\);/.test(net), '');
  check('E-7 画面に受け口がある', /'bba:results-dropped'/.test(read('public/js/main.js')), '');
}

// ===========================================================================
// F. デイリーの瓦礫は全員同じ
// ===========================================================================
{
  const engine = read('public/js/engine.js');
  check('F-1 addGarbage が乱数を受け取れる', /addGarbage\(n, rng = null\) \{/.test(engine), '');
  check('F-2 渡されたらそれを使う', /const pick = typeof rng === 'function' \? rng : Math\.random;/.test(engine), '');
  check('F-3 デイリー専用の乱数がある', /function dailyRng\(seed\) \{/.test(modes), '');
  check('F-4 瓦礫だけ seed で置く', /if \(id === 'rubble'\) engine\.addGarbage\(10, dailyRng\(seed\)\);/.test(modes), '');
  check('F-5 呼び出し側が seed を渡す',
    (modes.match(/applyDailyModifier\((this\.engine|this\.ghostEngine), this\.info\.modifier, this\.info\.seed\)/g) || []).length === 2, '');
  check('F-6 再生と残像レースの封印を解いた', /function replayReproducible\(mod\) \{\n  return true;\n\}/.test(modes), '');
  check('F-7 直す前の録画は出さない', /const rubble = dailyModifierOf\(day\)\.id === 'rubble';/.test(read('server/routes/daily.js')), '');

  // 同じ seed なら同じ場所に置かれること（＝全員同じ盤面）を実物で確かめる。
  const layout = (seed) => {
    const e = new Engine(seed);
    // dailyRng と同じ式（テストが実装を写しているのではなく、性質を確かめる）。
    let s = (seed >>> 0);
    const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    e.addGarbage(10, rng);
    return e.grid.join('');
  };
  check('F-8 同じ日なら全員同じ配置になる', layout(12345) === layout(12345), '');
  check('F-9 日が変われば配置も変わる', layout(12345) !== layout(54321), '');
}

// ===========================================================================
// G. 死蔵していた仕掛けを繋ぐ／同じ文を「訳」として配らない
// ===========================================================================
{
  check('G-1 その日のセールを住人の世界観へ渡す', /sale: \{ items: currentDeals\(\) \}/.test(idx), '');
  check('G-2 受け口も繋がっている', /sale: w\.sale \|\| null,/.test(read('server/ambient.js')), '');
  check('G-3 セールが無い日は今までどおり黙る', /case 'sale': return !!ctx\.sale;/.test(crowd), '');

  check('G-4 原文と同じものを「訳」にしない',
    /const same = !other \|\| other === text;/.test(crowd), '');
  check('G-5 返信・リアクションでも同じ判定をする',
    /if \(!text \|\| \(srcText && text\.trim\(\) === String\(srcText\)\.trim\(\)\)\) return null;/.test(crowd), '');
  check('G-6 日本語訳のはずが英語のままなら配らない',
    /if \(otherLang === 'ja' && !\/\[ぁ-んァ-ヶ一-龠ー\]\/\.test\(text\)\) return null;/.test(crowd), '');

  check('G-7 UR の速報は必ず流す', /n\.react \|\| n\.always/.test(idx), '');
  check('G-8 UR 側が印を立てている', /react: null, always: true/.test(read('server/routes/shop.js')), '');

  check('G-9 「必ず本人が答える」という嘘のコメントを直した',
    !/always gets an answer from that resident/.test(battle), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🐛 バグ修正 第6波  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
