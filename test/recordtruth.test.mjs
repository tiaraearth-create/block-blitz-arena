// リポジトリのルートから:  node test/recordtruth.test.mjs
//
// 🧾 「判定と記録がズレる」不具合の回帰テスト。
//
// displaytruth が「画面が嘘をつく」側を見るのに対し、こちらは
// **サーバーの数え方そのものが意図と違っていた**ぶんを見る。
//
//   A. 大会の準々決勝・準決勝で勝っても、勝利系ミッションも totalWins も進まない
//   B. 決勝が不戦勝で終わった優勝者は、コイン・パスXP・XP が全部 0
//   C. パズル遺跡は同じ日に解き直すと★がサーバーに保存されない
//   D. ブループリントの1日1回が「提出が届いた時刻」で数えられ、日跨ぎで翌日の枠を食う
//   E. 図鑑「道具棚コンプ」はブースターを1個使うだけで達成が剥がれる
//   F. しおりで中断・再開すると、その走行のアイテム使用数と全消し回数が消える
//   G. デイリーの冪等キーがクライアントから送られておらず、復帰路が到達不能だった
//   H. その日もう達成できないミッション（設計図）を引き直しで引かされる
//   I. バトルパスのバッジ段は、既に持っていると何も入らないのに「受け取りました」
//   J. ライバルボードの順位が、同点でも 1位/2位 に割れる
//   K. ミッション画面の「達成 N / M」が受取済み数だった
//   L. 殿堂の報酬行が「undefined」／表彰を見送ったボードにも「お届けしました」
//   M. 失効した予約が「（挑戦中）」のまま残る
//   N. ギルドを移った週は、押しても必ず失敗する「受取」ボタンが出る
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../public/js/engine.js';
// ⚠ 名前つき import にすると、目的の関数がまだ無い木では
//   SyntaxError でファイルごと走らなくなり、**1件も赤くならない**
//   （「直す前は落ちる」の確かめができない）。名前空間で受けて自分で見る。
import * as catalog from '../server/catalog.js';
const { COLLECTION_SETS, collectionProgress } = catalog;
const noteCollectionSets = catalog.noteCollectionSets || (() => false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const stripComments = src => src.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const index = stripComments(read('server/index.js'));
const battle = stripComments(read('server/battle.js'));
const modes = stripComments(read('public/js/modes.js'));
const screens = stripComments(read('public/js/screens.js'));
const guilds = stripComments(read('server/guilds.js'));
const missionsSrc = stripComments(read('server/missions.js'));
const dailyRoute = stripComments(read('server/routes/daily.js'));
const social = stripComments(read('server/routes/social.js'));
const friendsCli = stripComments(read('public/js/friends.js'));
const bpClaim = stripComments(read('server/routes/missions.js'));

// ===========================================================================
// A. 大会は「勝ったか」と「優勝したか」を分ける
// ===========================================================================
check('A-1 endMatch は勝ちをそのまま won で渡す',
  /won: friendly \? false : outcome === 1,/.test(battle), '');
check('A-2 優勝は別の欄（tourneyFinal）で渡す',
  /tourneyFinal: !!\(match\.tourney && match\.tourney\.final\),/.test(battle), '');
check('A-3 決勝限定の判定が won ではなく tourneyFinal を見ている',
  !/match\.tourney \? \(outcome === 1 && !!match\.tourney\.final\)/.test(battle), '');
check('A-4 優勝バッジは tourneyFinal で絞る',
  /mode === 'tournament' && won && tourneyFinal && !user\.badges\.includes\('tourney'\)/.test(index), '');
check('A-5 「優勝！」の全体速報も tourneyFinal で絞る',
  /mode === 'tournament' && won && tourneyFinal\) \{/.test(index), '');
check('A-6 tourneyFinal はクライアントから名乗れない（RESULT_FIELDS に無い）',
  !/'tourneyFinal'/.test(index), '');

// ===========================================================================
// B. 不戦勝の優勝でも参加ぶんの報酬が付く
// ===========================================================================
check('B-1 埋め合わせ呼び出しに決勝ぶんの持ち時間を渡す',
  /duration: TOURNEY_ROUND_SECS\[TOURNEY_ROUND_SECS\.length - 1\]/.test(battle), '');
check('B-2 サーバーが裁いた勝ちは「遊んだ形跡ゼロ」にしない',
  /const idleResult = score < NOPLAY_SCORE && lines === 0 && !\(trusted && won\);/.test(index), '');
check('B-3 trusted もクライアントから名乗れない',
  !/'trusted'/.test(index), '');
{
  // 実際の式を通す（score 0 / lines 0 / trusted な勝ちで報酬が 0 にならないか）。
  const NOPLAY = 200;
  const BASE = Number((index.match(/BASE_FULL_SECONDS = (\d+)/) || [])[1] || 45);
  const coinsOf = (score, lines, duration, won, trusted) => {
    const idle = score < NOPLAY && lines === 0 && !(trusted && won);
    const paceScale = idle ? 0 : Math.max(0.25, Math.min(1, duration / BASE));
    const paced = n => Math.round(n * paceScale);
    return Math.min(1000, paced(20) + Math.floor(score / 100) + (won ? paced(50) : 0));
  };
  check('B-4 不戦勝の優勝でコインが 0 にならない',
    coinsOf(0, 0, 90, true, true) > 0, `${coinsOf(0, 0, 90, true, true)}🪙`);
  check('B-5 空の結果（勝ちでもサーバー裁定でもない）は今までどおり 0',
    coinsOf(0, 0, 3600, false, false) === 0, `${coinsOf(0, 0, 3600, false, false)}🪙`);
  check('B-6 クライアント申告の「勝った」だけでは素通りしない',
    coinsOf(0, 0, 3600, true, false) === 0, `${coinsOf(0, 0, 3600, true, false)}🪙`);
}

// ===========================================================================
// C/D. 遺跡の★とブループリントの1日1回
// ===========================================================================
check('C-1 ★の保存は門にかかる前の申告（wonClaimed）を見る',
  /const wonClaimed = !!won;/.test(index) && /if \(wonClaimed && st >= 1 && starsGot > 0\)/.test(index), '');
check('C-2 wonClaimed は門より前に控える',
  index.indexOf('const wonClaimed = !!won;') > 0
  && index.indexOf('const wonClaimed = !!won;') < index.indexOf("workshopCapped = 'puzzle_day'"), '');
check('D-1 ブループリントの枠は申告された設計図の日で数える',
  /const bpDay = \(day === today \|\| day === yday\) \? day : today;/.test(index), '');
check('D-2 古い日付を名乗っても枠は増えない（今日か昨日だけ）',
  /const yday = jstDayKey\(Date\.now\(\) - 86400000\);/.test(index), '');
check('D-3 クライアントが遊んだ設計図の日を添えている',
  /mode: 'blueprint'[\s\S]{0,300}?day: this\.bp\.dayKey,/.test(modes), '');

// ===========================================================================
// E. 図鑑「道具棚コンプ」（実物の関数を通す）
// ===========================================================================
{
  const boostSet = COLLECTION_SETS.find(s => s.kind === 'boost');
  check('E-0 ブースターのセットがある', !!boostSet, boostSet ? boostSet.id : 'none');
  if (boostSet) {
    const full = () => {
      const items = {};
      for (const id of boostSet.ids) items[id] = 1;
      return { id: 'u1', items, owned: [], badges: [], collections: [], stats: {} };
    };
    const u = full();
    const rowOf = user => collectionProgress(user).find(r => r.id === boostSet.id);
    check('E-1 そろえた時点で達成になる', rowOf(u).done === true, '');
    // 図鑑を開いた（＝画面に 4/4 と出した）瞬間を印にする。
    check('E-2 そろっていれば印が付く', noteCollectionSets(u) === true, '');
    check('E-3 印は stats.setEver に入る', !!(u.stats.setEver && u.stats.setEver[boostSet.id]), JSON.stringify(u.stats.setEver || {}));
    // ここで1個使う（在庫を減らす）。
    u.items[boostSet.ids[0]] = 0;
    check('E-4 1個使っても達成は取り消されない', rowOf(u).done === true, '');
    check('E-5 二度目は書き込まない（冪等）', noteCollectionSets(u) === false, '');
    // 印が無い人は今までどおり在庫で判定する。
    const v = full();
    v.items[boostSet.ids[0]] = 0;
    check('E-6 一度もそろえていない人は達成にならない',
      collectionProgress(v).find(r => r.id === boostSet.id).done === false, '');
    check('E-7 そろっていない人には印を付けない', noteCollectionSets(v) === false, '');
  }
}
check('E-8 進捗も受け取りも同じ判定（collectionSetDone）を通る',
  /done: collectionSetDone\(user, set\),/.test(stripComments(read('server/catalog.js'))), '');
check('E-9 印を書く場所が結果送信にもある（図鑑を開かない人のため）',
  /noteCollectionSets\(user\);/.test(index), '');

// ===========================================================================
// F. しおりのテレメトリ（実物の Engine を通す）
// ===========================================================================
{
  const e = new Engine(12345);
  e.itemUses = 4;
  e.perfectClears = 2;
  const st = e.saveState();
  const e2 = new Engine(1);
  const ok = e2.restoreState(st);
  check('F-1 復元できる', ok === true, '');
  check('F-2 使ったアイテム数が引き継がれる', e2.itemUses === 4, `itemUses=${e2.itemUses}`);
  check('F-3 全消し回数が引き継がれる', e2.perfectClears === 2, `perfectClears=${e2.perfectClears}`);
  const fresh = new Engine(7);
  check('F-4 新しい走行では 0 から始まる',
    fresh.itemUses === 0 && fresh.perfectClears === 0, `${fresh.itemUses}/${fresh.perfectClears}`);
}

// ===========================================================================
// G. デイリーの冪等キー
// ===========================================================================
check('G-1 クライアントが attemptId を作って控える',
  /keepDailyAttempt\(info\.day, attemptId\);/.test(modes), '');
check('G-2 送る前に控える（送信中に落ちても次で出せる）',
  modes.indexOf('keepDailyAttempt(info.day, attemptId);')
    < modes.indexOf("api('/api/daily/start', { method: 'POST', body: { day: info.day, attemptId } })"), '');
check('G-3 予約を添えて送る',
  /body: \{ day: info\.day, attemptId \}/.test(modes), '');
check('G-4 控えがあれば played でも聞き直す',
  /if \(info\.played && !kept\) return \{ practice: true, attemptId: null \};/.test(modes), '');
check('G-5 サーバー側の復帰路は前からある（形が合っているか）',
  /resumeId && s\.dailyc\.pending && s\.dailyc\.pending === resumeId/.test(dailyRoute), '');
check('G-6 端末の持ち主が変わったら一緒に仕舞う',
  /'bba_daily_attempt',/.test(stripComments(read('public/js/localdata.js'))), '');

// ===========================================================================
// H/I. ミッションの引き直しとバトルパスのバッジ段
// ===========================================================================
check('H-1 その日もう達成できない設計図のお題を引かせない',
  /!\(bpDone && d\.id === 'd_blueprint1'\)/.test(missionsSrc), '');
check('H-2 判定は今日の bpDay を見る',
  /user\.stats\.bpDay\.day === todayId\(\) && user\.stats\.bpDay\.cleared/.test(missionsSrc), '');
check('H-3 引き直しの使い切りは daily/weekly で文言を分ける',
  /scope === 'weekly' \? '今週の引き直しは使い切りました' : 'きょうの引き直しは使い切りました'/.test(missionsSrc), '');
check('I-1 すでに持っているバッジ段は通貨に振り替える',
  /reward\.type === 'badge'[\s\S]{0,320}?paid = \{ type: 'coins', amount, insteadOf: reward\.id \}/.test(bpClaim), '');

// ===========================================================================
// J. ライバルボードの同点順位（実装した式をそのまま通す）
// ===========================================================================
check('J-1 サーバーが順位を載せている', /rank: rankOfIdx\[i\],/.test(social), '');
check('J-2 画面はその順位を使う（添字ではない）',
  /const rank = Number\.isFinite\(Number\(e\.rank\)\) && Number\(e\.rank\) > 0 \? Number\(e\.rank\) : i \+ 1;/.test(friendsCli)
  && /const mi = medalIconName\(rank\);/.test(friendsCli), '');
{
  const src = read('server/routes/social.js').replace(/\r\n/g, '\n');
  const m = src.match(/let rank = 0;[\s\S]*?return rank;\n {2}\}\);/);
  check('J-0 順位付けの式を取り出せる', !!m, '');
  if (m) {
    // eslint-disable-next-line no-new-func
    const run = new Function('sorted', 'valueOf', `${m[0]}\nreturn rankOfIdx;`);
    const vals = [900, 700, 700, 700, 500, 100];
    const got = run(vals.map(v => ({ v })), r => r.v);
    check('J-3 同点は同順位・その次は飛ぶ（1,2,2,2,5,6）',
      JSON.stringify(got) === JSON.stringify([1, 2, 2, 2, 5, 6]), JSON.stringify(got));
    const all = run([{ v: 5 }, { v: 5 }, { v: 5 }], r => r.v);
    check('J-4 全員同点なら全員1位', JSON.stringify(all) === JSON.stringify([1, 1, 1]), JSON.stringify(all));
    check('J-5 空でも落ちない', JSON.stringify(run([], r => r.v)) === '[]', '');
  }
}

// ===========================================================================
// K/L/M/N. 画面の数え方まわり
// ===========================================================================
check('K-1 ミッションの「達成」は done を数える',
  /const doneCount = rows\.filter\(r => r\.done\)\.length;/.test(screens), '');
check('K-2 受取数は別に出す',
  /const claimedCount = rows\.filter\(r => r\.claimed\)\.length;/.test(screens)
  && /受取 \$\{claimedCount\}/.test(screens), '');
check('L-1 殿堂の行は week が無ければシーズン名を出す',
  /const rrWhen = r => r\.week \|\| r\.seasonName \|\| r\.boardName \|\| '';/.test(screens), '');
check('L-2 「点」は週間チャレンジの行だけ',
  /r\.week \? `\$\{fmt\(r\.best\)\}\$\{tr\('点', ' pts'\)\}`/.test(screens), '');
check('L-3 表彰したかをボードごとに残す', /const awarded = realEntrants >= HOF_MIN_ENTRANTS;/.test(index), '');
check('L-4 「お届けしました」は実際に配ったボードだけ',
  /const paidBoards = boards\.filter\(b => b\.awarded\);/.test(index)
  && /const skipped = boards\.filter\(b => !b\.awarded\);/.test(index), '');
check('M-1 失効した予約は「挑戦中」にしない',
  /inProgress: !!\(today && today\.pending && !today\.cleared && !attemptExpired\),/.test(dailyRoute), '');
check('M-2 期限は提出側と同じ物差し（DAILYC_ATTEMPT_MS）',
  /Date\.now\(\) - \(today\.at \|\| 0\) > DAILYC_ATTEMPT_MS/.test(dailyRoute), '');
check('M-3 画面が理由を出せる', /info\.attemptExpired \?/.test(stripComments(read('public/js/main.js'))), '');
check('N-1 別ギルドで開けている週は受取不可を返す',
  /lockedByOtherGuild,/.test(guilds) && /claimable: !lockedByOtherGuild &&/.test(guilds), '');
check('N-2 画面は押せるボタンを出さない',
  /quest\.done && q\.lockedByOtherGuild/.test(screens), '');

for (const [mark, name, detail] of results) console.log(mark, name, detail ? `— ${detail}` : '');
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
