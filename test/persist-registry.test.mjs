// リポジトリのルートから:  node test/persist-registry.test.mjs
//
// 「永続データを1つ足したのに、付いて回る後始末を1つ忘れた」を機械的に止める。
//
// ■ なぜこのテストが要るのか
// 3回の横断監査で出た227件を分類したところ、いちばん被害が大きかった一群
// （17件）はすべて同じ形をしていた ── **新しい永続データを足したときに、
// その事実を知っている場所が5〜8箇所に手書きでコピーされていて、そのうち
// 1〜2箇所を書き忘れる**。忘れた瞬間に落ちるのではなく、
//
//   ・復元のたびに黙って消える（server/backup.js のマージ規則に足し忘れ）
//   ・二重に受け取れる（止め金だけが復元で落ちる）
//   ・退会した人の投稿や名前が公開面に残り続ける（削除経路の掃除に足し忘れ）
//   ・db.json が無限に伸びて保存がイベントループを止める（上限の決め忘れ）
//
// という形で、あとから気づく。しかもどれも「テストは全部緑」のまま起きる。
// 個別のバグを潰しても同じ形がまた生えるので、ここでは **入れ物を実コードから
// 数え上げて、付いて回るべき場所と突き合わせる**。
//
// ■ 書き方の方針（既存の modes-structure / clientwiring と同じ）
// 静的解析なので「たぶん危ない」は出さない。**確実に言えることだけ**を見る。
// 嘘の警告を出すテストは、そのうち誰も読まなくなって存在しないのと同じになる。
// 定数は実装から読み取る（写経しない ── 写経した定数が実装とズレて嘘を
// ついていたテストが実際にあった）。
//
// ■ 「いま既知の抜け」の扱い
// 実装の修正は別担当。ここで抜けを見つけたぶんは、下の許可リストに
// **理由と直すべき人を日本語で書いて** 入れてある。最初から赤いテストは
// 運用されなくなるので、緑から始めて「新しく増えたぶんだけ」が赤くなる形にする。
// 直したら許可リストから消すこと（消し忘れも C-2 / D-3 で赤くなる）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0, warned = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`❌ ${name} — ${detail}`); }
}
// 許可リストの掃除もれは ⚠ にとどめて落とさない。
// 抜けを **直した** 人のところでテストが赤くなるのがいちばん良くない
// （「直したらテストが壊れた」と受け取られた時点で、このテストは信用を失う）。
// 落ちはしないが、放っておくと許可リストが伸びて次の抜けが紛れ込むので、
// 気づいた人がその場で1行消せるように名指しで出す。
function warn(name, detail) { warned++; console.log(`⚠ ${name} — ${detail}`); }

// ---------------------------------------------------------------------------
// 下ごしらえ: server/**/*.js を集める
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'data' || e.name === 'node_modules') continue;   // db.json とスナップショットは対象外
      walk(p, out);
    } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const SERVER = path.join(root, 'server');
const FILES = walk(SERVER).map(p => ({
  rel: path.relative(root, p).replace(/\\/g, '/'),
  src: fs.readFileSync(p, 'utf8'),
}));
check('server の .js を読み込めた', FILES.length >= 15, `${FILES.length}ファイル`);

// コメントを落とした本体。「backup.js のコメントに名前が出ているだけ」を
// 「扱われている」と誤判定しないために要る（このファイルはコメントが厚い）。
const stripComments = s => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const BACKUP_SRC = read('server/backup.js');
const BACKUP_CODE = stripComments(BACKUP_SRC);

// 波括弧・丸括弧の対応で本体を切り出す（文字列とコメントを飛ばす）。
// 「次の app.delete まで」で切ると隣の経路まで巻き込んで誤検知するので、
// modes-structure.test.mjs と同じやり方できっちり数える。
function balancedFrom(source, startIdx, open, close) {
  let depth = 0, inStr = null, inCmt = null;
  for (let i = startIdx; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (inCmt) { if (inCmt === '//' && c === '\n') inCmt = null; else if (inCmt === '/*' && c === '*' && n === '/') { inCmt = null; i++; } continue; }
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inCmt = '//'; i++; continue; }
    if (c === '/' && n === '*') { inCmt = '/*'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return source.slice(startIdx, i + 1); }
  }
  return null;
}

// ===========================================================================
// 【A】db.meta の入れ物 ── 復元規則の「形」を固定する
// ===========================================================================
//
// db.meta は世界の状態（開催中のイベント・投票・王座・殿堂・工房…）の置き場で、
// 復元の規則が一度「持ち込んでよいキーの許可リスト」だったせいで throneMax と
// newsUnpinned が漏れ、再デプロイのたびに 👑王座ショップが全品買えなくなり、
// 📌し直したお知らせが毎回剥がされていた（server/backup.js のコメントに顛末）。
// いまは「持ち込まないキーの除外リスト」に反転していて、書き足し忘れの既定が
// **持ち越す側**になっている。ここではその形そのものを固定する ── キーを1個ずつ
// 突き合わせるより、形が壊れないことのほうが確実に言えて、効き目も大きい。

// A-1. db.meta.<キー> への代入を数え上げる（backup.js 自身は復元処理なので除く）
const metaKeys = new Map();   // キー -> それを書いているファイル
for (const { rel, src } of FILES) {
  if (rel === 'server/backup.js') continue;
  for (const m of src.matchAll(/\bdb\.meta\.([A-Za-z_$][\w$]*)\s*(?:=[^=>]|\|\|=|\?\?=|\+=)/g)) {
    if (!metaKeys.has(m[1])) metaKeys.set(m[1], new Set());
    metaKeys.get(m[1]).add(rel);
  }
}
// 数え上げが壊れて0件になったら、以下の検査は全部「異常なし」と嘘をつく。
// 実数より充分に低い位置で早期警報を鳴らしておく。
check('A-1 db.meta の入れ物を数え上げられた', metaKeys.size >= 15,
  `${metaKeys.size}個: ${[...metaKeys.keys()].sort().join(', ')}`);

// A-2. 静的解析から逃げられる書き方が増えていないか
// db.meta[expr] = ... という動的なキーは、このテストでは追えない。いま
// そう書いているのは backup.js の復元ループだけ（外から来たキーを回すので当然）。
// ここが増えると、上の数え上げが黙って穴だらけになる。
{
  const dyn = [];
  for (const { rel, src } of FILES) {
    if (rel === 'server/backup.js') continue;
    for (const m of src.matchAll(/\bdb\.meta\[[^\]]+\]\s*=[^=]/g)) dyn.push(`${rel}: ${m[0].trim()}`);
  }
  check('A-2 db.meta[動的キー] への代入が backup.js の外に無い', dyn.length === 0, dyn.slice(0, 3).join(' / '));
}

// A-3. 復元規則が「除外リスト」のままであること（許可リストに戻さない）
{
  const hasDeny = /const\s+META_NOT_RESTORED\s*=\s*new Set\(/.test(BACKUP_CODE);
  check('A-3a 復元しないキーの一覧(META_NOT_RESTORED)がある', hasDeny, '');
  // ループが data.meta の全キーを回っていること。ここが固定の配列を回る形に
  // 変わったら、それは許可リストへの逆戻り。
  const loopsAll = /for\s*\(const\s+k\s+of\s+Object\.keys\(data\.meta\)\)/.test(BACKUP_CODE);
  check('A-3b meta の合流が data.meta の全キーを回っている', loopsAll,
    loopsAll ? '' : '許可リスト方式に戻っている疑い（新しい meta キーが黙って落ちる）');
  // 「許可リスト」の匂いがする名前が無いこと。
  const allowish = /META_(?:RESTORE|RESTORED|ALLOW|ALLOWED|KEEP|WHITELIST)\b/.test(BACKUP_CODE);
  check('A-3c meta の許可リストが復活していない', !allowish, '');
}

// A-4. 除外リストの中身が既知のものと一致するか
// 増えていたら「復元しない」と決めた新しいキーがあるということ。それ自体は
// 正しいこともあるが、**必ず理由をコメントに書いてからここを更新する**運用に
// したい（過去に理由の無い除外が事故を生んでいる）。
const KNOWN_NOT_RESTORED = new Set([
  'seedHash',           // この機体が同梱 seed を適用済みかの記録。巻き戻すと古い seed が再適用される
  'lastRankRewardWeek', // 復元後に消して週間報酬を再実行させるのが目的
  'backupAt',           // バックアップファイル自身の情報（世界の状態ではない）
  'backupVersion',      // 同上
  'backupTrimmed',      // 同上（書き出し側が何を落としたかの記録）
  'maintenance',        // 「今この機体を止めているか」の運用スイッチ。持ち込むとプレイヤーだけ締め出される
  // 🧾 結果送信の冪等キー（runId → 前回の応答）の控え。24時間で消える再送よけの
  // 帳面で、世界の状態ではない。持ち込むほうが危ない ── 復元はデータが飛んだ後に
  // 走るのでユーザーのレコードはバックアップ時点まで巻き戻るのに、「その runId は
  // 処理済み」という印だけが残ると、巻き戻った回を再送しても前回の応答が返るだけで
  // 報酬が永久に入らない。帳面は普通に遊べばすぐ作り直される。
  'resultRuns',
]);
{
  const m = BACKUP_CODE.match(/const\s+META_NOT_RESTORED\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const listed = m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
  const added = listed.filter(k => !KNOWN_NOT_RESTORED.has(k));
  const gone = [...KNOWN_NOT_RESTORED].filter(k => !listed.includes(k));
  check('A-4a 復元しないキーが勝手に増えていない', added.length === 0,
    added.length ? `新しく除外されたキー: ${added.join(', ')}（理由をコメントに書いてから、このテストの KNOWN_NOT_RESTORED に足すこと）` : `${listed.length}件`);
  check('A-4b 復元しないと決めたキーが外れていない', gone.length === 0, gone.join(', '));

  // A-5. 除外リストの綴りが実在するか。打ち間違えると、除外したつもりのキーが
  // 黙って復元される（seedHash を1文字間違えれば、古い seed が毎回被さる）。
  // backupAt / backupVersion / backupTrimmed は書き出し側 (routes/admin.js) が
  // dump.meta に付ける欄なので、db.meta ではなく「meta の欄として」実在を見る。
  const allSrc = FILES.map(f => f.src).join('\n');
  const typos = listed.filter(k => !new RegExp(`(?:db|dump|data)\\.meta\\.${k}\\b|\\bmeta:\\s*\\{[^}]*\\b${k}\\b`).test(allSrc) && !new RegExp(`\\b${k}:`).test(allSrc));
  check('A-5 復元しないキーの綴りが実在する', typos.length === 0,
    typos.length ? `実コードに見当たらない: ${typos.join(', ')}` : `${listed.length}件を照合`);
}

// A-6/A-7. 「片方だけを採る」では守れないキーが、突き合わせ合流に登録されているか
// db.meta の既定の規則は『live 側がまだ値を持っていないキーだけ採用する』。
// つまり、ディスクが飛んでから復元するまでの窓で誰か1人が触っただけで、
// バックアップ側の中身が丸ごと落ちる。プレイヤーの作品（🧩工房）と
// 👻ゴースト盤面（🎞デイリーリプレイ）はそれでは守れないので、中身を
// 突き合わせる専用の合流が要る。
const NEEDS_DEEP_MERGE = ['workshop', 'dailyReplays'];
{
  const m = BACKUP_CODE.match(/const\s+META_MERGED\s*=\s*new Map\(\[([\s\S]*?)\]\)/);
  const merged = m ? [...m[1].matchAll(/\['([^']+)'/g)].map(x => x[1]) : [];
  check('A-6 突き合わせ合流のキーが実在の db.meta キーである',
    merged.length > 0 && merged.every(k => metaKeys.has(k)),
    merged.length ? `${merged.join(', ')}` : 'META_MERGED が見つからない');
  const notMerged = NEEDS_DEEP_MERGE.filter(k => !merged.includes(k));
  check('A-7 プレイヤー生成物を抱える meta キーが突き合わせ合流に載っている', notMerged.length === 0,
    notMerged.length ? `${notMerged.join(', ')} が META_MERGED に無い（復元のたびに丸ごと消える）` : '');
}

// ===========================================================================
// 【B】db.meta の配列に上限があるか ── db.json が無限に伸びるのを止める
// ===========================================================================
//
// db.json は保存のたびに丸ごと書き出される（同期書き込み）。伸び続ける配列を
// 1本入れると、そのうち保存がイベントループを止めて、サーバー全体が
// 「たまに数秒固まる」状態になる。押し出しは1行で済むのに、足すときに
// いちばん忘れられる。
{
  // 配列として使っている meta キーだけを見る（オブジェクトは日付キーなどで
  // 別の押し出し方をするので、ここで一緒くたにすると誤検知になる）。
  const arrayish = [];
  for (const [key, owners] of metaKeys) {
    const pat = new RegExp(
      `db\\.meta\\.${key}\\s*\\.\\s*(?:push|unshift)\\s*\\(`
      + `|db\\.meta\\.${key}\\s*=\\s*\\[\\s*\\]`
      + `|Array\\.isArray\\(\\s*db\\.meta\\.${key}\\s*\\)`
      + `|db\\.meta\\.${key}\\s*\\|\\|\\s*\\[\\s*\\]`);
    if (FILES.some(f => pat.test(f.src))) arrayish.push([key, owners]);
  }
  check('B-1 配列として使う db.meta のキーを数え上げられた', arrayish.length >= 3,
    arrayish.map(([k]) => k).join(', '));

  for (const [key, owners] of arrayish) {
    // 上限とみなす形（どれか1つあればよい）:
    //   db.meta.K.splice( / .shift(       … 押し出している
    //   db.meta.K.length >  /  <          … 長さを見て何かしている
    //   db.meta.K = 〜.slice(             … 切り詰めて入れ直している
    //   const X = db.meta.K … X.splice( / X.shift( / X.length >
    //     （clientErrors は別名越しに押し出している。別名を追わないと嘘の警告になる）
    const direct = new RegExp(
      `db\\.meta\\.${key}\\s*\\.\\s*(?:splice|shift)\\s*\\(`
      + `|db\\.meta\\.${key}\\s*\\.\\s*length\\s*[<>]`
      + `|db\\.meta\\.${key}\\s*=[^\\n;]*\\.\\s*slice\\s*\\(`);
    const capped = [...owners].some(rel => {
      const src = FILES.find(f => f.rel === rel).src;
      if (direct.test(src)) return true;
      const aliases = [...src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*db\\.meta\\.${key}\\b`, 'g'))].map(m => m[1]);
      return aliases.some(a => new RegExp(
        `${a}\\s*\\.\\s*(?:splice|shift)\\s*\\(|${a}\\s*\\.\\s*length\\s*[<>]|${a}\\s*=[^\\n;]*\\.\\s*slice\\s*\\(`).test(src));
    });
    check(`B-2 db.meta.${key} に頭打ちがある`, capped,
      capped ? '' : `${[...owners].join(', ')} に push はあるが slice/shift/length> が無い（db.json が無限に伸びる）`);
  }
}

// ===========================================================================
// 【C】user レコードのトップレベル欄と、復元マージ
// ===========================================================================
//
// 復元の合流は「進行度の高いレコードが勝つ」で、負けたほうの欄は基本的に捨てる。
// だから **止め金（二重受取を防いでいる印）や、安全に関わる設定** は
// backup.js の mergeEarned で明示的に拾わないと、復元のたびに解ける。
// 実際にそうなっていた: 実績の再受取・BAN の消滅・ブロックの解除・
// 週間報酬の二重払い・ゲスト記録の再取り込み……（backup.js のコメントに全部ある）。
//
// ここでは「user のトップレベル欄を数え上げて、backup.js の本体に名前が
// 一度も出てこないもの」を洗い出す。名前が出ていれば必ず正しい、とまでは
// 言えないが、**一度も出てこない欄は確実に素通り**なので、そこだけを見る。
{
  const userKeys = new Map();
  for (const { rel, src } of FILES) {
    if (rel === 'server/backup.js') continue;
    for (const m of src.matchAll(/(?<![\w.])(?:user|u)\.([A-Za-z_][\w]*)\s*(?:=[^=>]|\|\|=|\?\?=|\+=|-=)/g)) {
      if (!userKeys.has(m[1])) userKeys.set(m[1], new Set());
      userKeys.get(m[1]).add(rel);
    }
  }
  check('C-1 user のトップレベル欄を数え上げられた', userKeys.size >= 25, `${userKeys.size}欄`);

  // ── 既知の抜け（TODO）。直すのは backup.js の担当者。
  // 直したら（＝backup.js が名前を扱ったら）この表から消すこと。消し忘れは C-3 で赤くなる。
  const UNMERGED_TODO = new Map([
    ['lastDaily', '🎁ログインボーナスの受取印（index.js grantDaily）。1日1回を止めているのはこれだけ。復元で落ちるともう一度受け取れる。【要修正・backup.js 担当】'],
    ['shards', '👑王座の欠片（通貨）。progressOf にも mergeEarned にも無いので、負けたレコードが持っていた分が丸ごと消える。【要修正・backup.js 担当】'],
    ['guildFounded', '🏰創設者バッジの判定に使う印（catalog.js）。稼いだものなので落とすとバッジが消える。【要修正・backup.js 担当】'],
    ['gachaPity', '🎰ガチャの天井カウンター。落ちると天井までの積み上げが消える（プレイヤー不利側）。【要検討・backup.js 担当】'],
    ['guildLeftAt', '🏰脱退から1時間の再加入制限（guilds.js）。落ちると制限を回避できる。【要検討・backup.js 担当】'],
    ['lastRename', '✏️改名のクールダウン。落ちると連続で改名できる。【要検討・backup.js 担当】'],
    ['equipped', '👕装備中の見た目。勝ったレコードのものが残るので消えはしない（負けた側で装備していた見た目が外れるだけ）。合流不要と判断。'],
    ['adminEventDay', '👑管理者イベントの「その日の予約」控え。日をまたぐと自分で捨てられる一時データ。合流不要と判断。'],
    ['lastSeen', '🕒最終ログイン時刻。表示専用。合流不要と判断。'],
    ['challengeIn', '⚔️対戦の申し込み（受）。一時データで、backup.js が「申請と断りの記録は合流させない」と決めているのと同じ性格。合流不要と判断。'],
    ['challengeOut', '⚔️対戦の申し込み（送）と連投クールダウン。同上。合流不要と判断。'],
    ['lastIpFp', '🔏最後に使った回線の指紋（凍結を回線まで効かせるのに使う）。ログインと接続のたびに書き直る一時データで、バックアップ側の古い値を持ち込むと「その人がもう使っていない回線」を凍結しかねない（＝無関係な人の巻き添え）。落ちても、その人が次に繋いだ時点で入り直す。合流不要と判断。'],
  ]);

  const unmerged = [...userKeys.keys()].filter(k => !new RegExp(`\\b${k}\\b`).test(BACKUP_CODE)).sort();
  const surprises = unmerged.filter(k => !UNMERGED_TODO.has(k));
  check('C-2 新しい user の欄が復元マージから漏れていない', surprises.length === 0,
    surprises.length
      ? `backup.js が一度も触っていない欄: ${surprises.join(', ')} — 二重受取の止め金や安全設定なら mergeEarned に足す。落として構わないなら理由を書いて test/persist-registry.test.mjs の UNMERGED_TODO へ`
      : `${unmerged.length}件の既知の抜けを許可中`);

  // C-3. 許可リストの掃除。直したのに表に残っていると、次の抜けをそこに
  // 紛れ込ませてしまう（許可リストは必ず短く保つ）。
  const stale = [...UNMERGED_TODO.keys()].filter(k => !unmerged.includes(k));
  if (stale.length) {
    warn('C-3 復元マージの許可リストに死んだ欄が残っている',
      `backup.js が扱うようになった（or 実装から消えた）ので UNMERGED_TODO から外すこと: ${stale.join(', ')}`);
  } else {
    check('C-3 復元マージの許可リストに死んだ欄が残っていない', true, '');
  }

  // ── C-4/C-5: user.stats の中の **日付つきの止め金**（`〜Day`）。
  //
  // C-1..C-3 は user のトップレベル欄しか数えていなかった。ところが
  // 「1日いくらまで」を止めている印はどれも user.stats の中に居る
  // （grindDay / eventGemDay / puzWinDay / wsWinDay / bpDay / shopGiftDay /
  //  champAnnDay / eyeShardDay）。ここが復元マージから落ちると、
  // **復元した日だけ上限が丸ごともう一本ぶん開く** ── しかも増えたぶんは
  // 正規の経路を通っているので、farming / idempotent / econguard の
  // どのテストにも引っかからない。実際 eyeShardDay は v2.53 で足したあと
  // backup.js に書き忘れたまま出荷されていた（v2.58 で追加）。
  //
  // 日付つきの止め金は名前で確実に見分けられる（`〜Day`）ので、
  // ここだけは許可リスト無しの全数一致にする。
  const DATE_METHODS = new Set(['getDay', 'getUTCDay', 'setDay']);
  const dayKeys = new Map();
  for (const { rel, src } of FILES) {
    if (rel === 'server/backup.js') continue;
    // user.stats は場所ごとに別名で持ち回っている（user.stats.bpDay / st.eventGemDay /
    // gs.grindDay / s.eyeShardDay …）ので、**受け皿の名前では絞らない**。
    // 頼るのは名前の付け方のほう ── 日付つきの止め金は必ず `〜Day` で終わる。
    // 受け皿の手前まで見ようとすると user.stats.bpDay のような二段の参照を
    // 取りこぼすので、`.〜Day` だけを見て、Date の組み込みメソッドだけ外す。
    for (const m of src.matchAll(/\.([A-Za-z_][\w]*Day)\b/g)) {
      if (DATE_METHODS.has(m[1])) continue;
      if (!dayKeys.has(m[1])) dayKeys.set(m[1], new Set());
      dayKeys.get(m[1]).add(rel);
    }
  }
  check('C-4 日付つきの止め金を数え上げられた', dayKeys.size >= 6, `${dayKeys.size}件: ${[...dayKeys.keys()].sort().join(', ')}`);
  // クライアント（画面）にしか無い一時的な日付印は対象外 ── ここで見ているのは
  // server が db.json に書くものだけ。いまのところ除外は要らない。
  const DAY_NOT_MERGED = new Map([
    ['adminEventDay', '👑管理者イベントの「その日の予約」控え。止め金ではなく、日をまたぐと自分で捨てられる一時データ（C-2 の許可理由と同じ）。'],
    ['joinedDay', '住人（server/residents.js）の在籍日数。seed から毎回組み立て直すので db.json に無く、復元とも無関係。'],
  ]);
  const dayMiss = [...dayKeys.keys()]
    .filter(k => !new RegExp(`\\b${k}\\b`).test(BACKUP_CODE) && !DAY_NOT_MERGED.has(k)).sort();
  check('C-5 日付つきの止め金が復元マージから漏れていない', dayMiss.length === 0,
    dayMiss.length
      ? `backup.js が一度も触っていない: ${dayMiss.join(', ')} — mergeEarned の「日付つきの止め金」の輪に足すこと（同じ日なら大きいほう／日が違えば新しいほう）`
      : `${dayKeys.size}件すべて backup.js が扱っている`);
}

// ===========================================================================
// 【D】退会・管理者削除の掃除
// ===========================================================================
//
// レコードを消しただけでは足りない。公開面には「投稿時の表示名スナップショット」を
// 持った控えが残っていて（🧩工房のステージ・📅デイリーのゴースト・💎購入履歴）、
// db.users から引けなくてもその控えで名前を出し続ける。退会した人の名前が
// 公開面に残るのは、この一群でいちばん見つけにくい抜け方だった。
//
// 掃除の関数は routes/*.js に export されている。**その一覧を登録簿として使い、
// 2つの削除経路が全部呼んでいるか** を突き合わせる。新しく purgeUserXxx を
// 足した人は、両方の経路に足すまでここが赤くなる。
{
  // D-1. 登録簿を作る
  const cleaners = new Map();   // 関数名 -> { rel, body }
  for (const { rel, src } of FILES) {
    for (const m of src.matchAll(/export\s+function\s+((?:purge|anonymize)User[A-Za-z0-9_]*)\s*\(/g)) {
      const parens = balancedFrom(src, src.indexOf('(', m.index + m[0].length - 1), '(', ')');
      const bodyStart = src.indexOf('{', m.index + m[0].length - 1 + (parens ? parens.length : 0));
      cleaners.set(m[1], { rel, body: (bodyStart >= 0 && balancedFrom(src, bodyStart, '{', '}')) || '' });
    }
  }
  check('D-1 退会時の掃除関数の登録簿を作れた', cleaners.size >= 3,
    [...cleaners.keys()].join(', '));

  // 掃除関数どうしの呼び出しを畳む。掃除は1本のまとめ役
  // （routes/admin.js の purgeUserContent）に集約されていて、削除経路は
  // それだけを呼ぶ形になっている。葉の関数まで「経路から直接呼べ」と
  // 要求すると、正しい書き方に嘘の警告を出すことになる。
  // ここで見たいのは **どこからも呼ばれていない掃除（根）** が、
  // 2つの経路の両方から呼ばれているか。新しい掃除を足した人は、
  // まとめ役に足すか、両方の経路に足すまでここが赤くなる。
  const roots = [...cleaners.keys()].filter(name =>
    ![...cleaners].some(([other, { body }]) => other !== name && new RegExp(`\\b${name}\\s*\\(`).test(body)));
  check('D-1b 掃除の入口（どこからも呼ばれていない掃除関数）が絞れた', roots.length >= 1, roots.join(', '));

  // D-2. 2つの削除経路の本体を切り出す
  const idx = read('server/index.js');
  const adm = read('server/routes/admin.js');
  const cutHandler = (src, marker) => {
    const at = src.indexOf(marker);
    if (at < 0) return null;
    return balancedFrom(src, src.indexOf('(', at), '(', ')');
  };
  const paths = [
    ['退会 DELETE /api/me', cutHandler(idx, "app.delete('/api/me'")],
    ['管理者削除 DELETE /api/admin/users/:id', cutHandler(adm, "adminRouter.delete('/api/admin/users/:id'")],
  ];
  for (const [label, body] of paths) {
    check(`D-2 ${label} の本体を切り出せた`, !!body && body.length > 200, body ? `${body.length}文字` : '見つからない');
  }

  // ── 既知の抜け（TODO）。"<経路>::<関数名>" で許可する。
  // 直すのは削除経路の担当者。直したら消すこと（D-4 で消し忘れも赤くなる）。
  // 申し送りは空。ここに載せてよいのは「まだ直していないと分かっている抜け」だけで、
  // 直したら**必ず外す**（残すと D-4 が⚠を出し続けて、本物の抜けが埋もれる）。
  // 直近では 退会 DELETE /api/me::purgeUserContent が v2.40 で埋まって外れた。
  const MISSING_CLEANUP_TODO = new Map([]);

  const gaps = [];
  for (const [label, body] of paths) {
    if (!body) continue;
    for (const fn of roots) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(body)) continue;
      gaps.push(`${label}::${fn}`);
    }
  }
  const surprises = gaps.filter(g => !MISSING_CLEANUP_TODO.has(g));
  check('D-3 削除経路が掃除を呼び忘れていない', surprises.length === 0,
    surprises.length
      ? `呼ばれていない: ${surprises.join(' / ')} — 退会と管理者削除の**両方**から呼ぶこと（片方だけだと、その経路で消えた人の名前や投稿が公開面に残る）`
      : `${gaps.length}件の既知の抜けを許可中`);
  const staleGaps = [...MISSING_CLEANUP_TODO.keys()].filter(g => !gaps.includes(g));
  if (staleGaps.length) {
    warn('D-4 掃除の許可リストに死んだ項目が残っている',
      `もう呼ばれているので MISSING_CLEANUP_TODO から外すこと: ${staleGaps.join(' / ')}`);
  } else {
    check('D-4 掃除の許可リストに死んだ項目が残っていない', true, '');
  }

  // D-5. どちらの経路でも欠かせない共通の手順。
  // leaveGuild / unfriendAll は **レコードが消える前** に呼ばないと、
  // 相手側に存在しない id が残る（ギルドの名簿が 20/20 のまま誰も入れなくなり、
  // 消えたのが所有者ならギルドが凍る ── 一度やらかしている）。
  // db.deleted への記録が無いと、古いバックアップの復元で退会者が生き返る。
  const MUST = ['revokeAllTokens', 'leaveGuild', 'unfriendAll'];
  for (const [label, body] of paths) {
    if (!body) continue;
    const miss = MUST.filter(fn => !new RegExp(`\\b${fn}\\s*\\(`).test(body));
    check(`D-5 ${label} が共通の後始末を踏んでいる`, miss.length === 0, miss.join(', '));
    check(`D-6 ${label} が墓標(db.deleted)を残している`,
      /db\.deleted\[[^\]]+\]\s*=/.test(body), '古いバックアップの復元で退会者が生き返る');
  }

  // D-7. leaveGuild / unfriendAll は「レコードを消す前」に走っているか。
  // どちらも消える本人のレコードを読んで相手を辿るので、delete db.users[...] の
  // 後ろに置くと静かに何もしなくなる（ギルドの名簿に幽霊 id が残り、
  // 20/20 のまま誰も入れず、その人が所有者ならギルドが凍る ── 実際に起きた）。
  // 掃除関数のほうは順序を問わない（id で照合するだけ）と実装が明記しているので、
  // ここでは縛らない ── 「静的に確実に言えること」だけを見る。
  for (const [label, body] of paths) {
    if (!body) continue;
    const delAt = body.search(/delete\s+db\.users\[/);
    if (delAt < 0) { check(`D-7 ${label} が db.users から消している`, false, 'delete db.users[...] が無い'); continue; }
    const late = MUST.filter(fn => {
      const m = body.search(new RegExp(`\\b${fn}\\s*\\(`));
      return m >= 0 && m > delAt;
    });
    check(`D-7 ${label} の縁切りがレコード削除より前にある`, late.length === 0,
      late.length ? `${late.join(', ')} が delete db.users[...] より後ろにある（何もしないまま通り過ぎる）` : '');
  }

  // D-8. 突き合わせ合流が要る meta キー（＝プレイヤー生成物を抱えるもの）には、
  // 対応する掃除関数があること。片方だけ足すと「復元では守られるのに、
  // 退会しても消えない」データができる。
  for (const key of NEEDS_DEEP_MERGE) {
    const owner = [...cleaners.values()].map(c => c.rel).find(rel => {
      const src = FILES.find(f => f.rel === rel).src;
      return new RegExp(`db\\.meta\\.${key}\\b`).test(src);
    });
    check(`D-8 db.meta.${key} を掃除する関数がある`, !!owner, owner || '掃除関数が見当たらない');
  }
}

// ===========================================================================
// 【E】user.stats の中で伸びうる入れ物
// ===========================================================================
//
// stats のカウンタは数値なので伸びない。危ないのは **配列を持たせたとき**で、
// これはユーザー数ぶんだけ db.json に効いてくる（1人40件でも1万人なら40万件）。
// stats 配下で push している配列に上限があるかだけを見る。
{
  const growing = new Map();   // キー -> ファイル
  for (const { rel, src } of FILES) {
    for (const m of src.matchAll(/(?<![\w.])(?:user|u|s|st|stats)\.(?:stats\.)?([A-Za-z_][\w]*)\s*\.\s*push\s*\(/g)) {
      // stats の欄だけを見たいので、newUser / migrateUser の既定形に
      // 載っている欄に絞る（実装から読み取る。写経しない）。
      if (!growing.has(m[1])) growing.set(m[1], new Set());
      growing.get(m[1]).add(rel);
    }
  }
  const idxSrc = read('server/index.js');
  const statsShape = new Set();
  const newUserBody = balancedFrom(idxSrc, idxSrc.indexOf('{', idxSrc.indexOf('stats: {')), '{', '}') || '';
  for (const m of newUserBody.matchAll(/([A-Za-z_][\w]*)\s*:/g)) statsShape.add(m[1]);
  check('E-1 stats の既定の形を読み取れた', statsShape.size >= 10, `${statsShape.size}欄`);

  const statsArrays = [...growing.keys()].filter(k => statsShape.has(k));
  check('E-2 stats 配下で push している配列を数え上げられた', statsArrays.length >= 1, statsArrays.join(', '));
  for (const key of statsArrays) {
    const capped = [...growing.get(key)].every(rel => {
      const src = FILES.find(f => f.rel === rel).src;
      return new RegExp(`\\.${key}\\s*\\.\\s*(?:splice|shift)\\s*\\(|\\.${key}\\s*\\.\\s*length\\s*[<>]|\\.${key}\\s*=[^\\n;]*\\.\\s*slice\\s*\\(`).test(src);
    });
    check(`E-3 user.stats.${key} に頭打ちがある`, capped,
      capped ? '' : `${[...growing.get(key)].join(', ')} に push はあるが切り詰めが無い（ユーザー数ぶんだけ db.json が太る）`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} persist-registry: ${pass} 件成功 / ${fail} 件失敗${warned ? ` / ${warned} 件の申し送り（⚠ は落としません）` : ''}`);
process.exitCode = fail === 0 ? 0 : 1;
