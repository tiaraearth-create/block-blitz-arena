// リポジトリのルートから:  node test/residentrecord.test.mjs
//
// 🗒 住人（AIプレイヤー）の戦績が「実際に起きたこと」を映すか。
//
// ■ なぜこのテストがあるのか
// 住人の成績はずっと「種＋日付」から丸ごと計算していた。つまり
// **人間が住人に勝っても、相手の戦績は1ミリも動かなかった**。
// ランキングに並ぶ名前を実際に倒したのに、翌日その人の勝敗が何も変わって
// いない ── これがいちばん強い「AIだとバレる手がかり」だった。
//
//     表示される値 ＝ 計算で作る基準値（今までどおり日々動く）
//                   ＋ 実際に起きたことの差分（db.meta.residentRecords）
//
// 全部を実記録に置き換えないのは、住人が対戦するのは人間と当たったときだけ
// だから ── 置き換えると600人のほとんどが「何日経っても1戦も増えない」という
// 別の不自然さになる。なのでここでは相反する2つを同時に押さえる:
//   動くこと（勝てば敗が増え、レートが Elo どおり下がる）と、
//   壊れないこと（同じ日なら値が揺れない・自己ベストは下がらない・
//   db.json が無限に伸びない・差分の中身が非管理者に漏れない）。
//
// 定数は実装から読む（写経した定数が実装とズレて嘘をつくのを避ける）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// backup.js は読み込み時に DATA_DIR（= db.js）を解決してスナップショット置き場を
// 決める。他のテストと踏み合わないよう、自分専用の場所を先に指しておく。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bba-residentrecord-'));
process.env.DATA_DIR = TMP;

const {
  buildRoster, residentStats, residentRating, isChampion, CHAMPION,
  setResidentRecordSource, recordResidentMatch, residentRecord, pruneResidentRecords,
  RESIDENT_RECORD_MAX, jstDay,
} = await import('../server/residents.js');
const { applyRestore } = await import('../server/backup.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const DAY = 86400000;
// JST 正午。+数時間しても同じ JST 日のままなので、日付境界の影響を受けない。
const NOON_JST = Date.UTC(2026, 7, 26, 3, 0);
const WK = 'W100';

const roster = buildRoster('v1', 240);
const champ = roster.find(isChampion);
const target = roster.find(r => r.registered && !isChampion(r) && r.skill > 0.6) || roster[0];

// 台帳をテストの中で差し替えられるようにする。実サーバーでは battle.js が
// db.meta.residentRecords を渡す（create のときだけ入れ物を作る）。
let table = null;
setResidentRecordSource(create => {
  if (!table) { if (!create) return null; table = {}; }
  return table;
});
const withTable = t => { table = t; };
const noTable = () => { table = null; };

// Elo の式。battle.js の eloUpdate はクロージャの中なので import できない。
// 「Eloどおりか」を見るのが目的なので、教科書どおりの式をここに置いて
// 実装の出す値と突き合わせる（写経ではなく、独立した第2の計算）。
const elo = (ra, rb, sa, k = 32) => Math.round(k * (sa - 1 / (1 + Math.pow(10, (rb - ra) / 400))));

// ---------------------------------------------------------------------------
// A. 差分が無いあいだは、今までと1ビットも変わらない
//    （誰とも当たっていない住人の世界が凍らない／既存テストの前提を壊さない）
// ---------------------------------------------------------------------------
{
  noTable();
  const before = roster.map(r => JSON.stringify(residentStats(r, NOON_JST, WK)));
  withTable({});                                   // 空の台帳を渡しても同じ
  const withEmpty = roster.map(r => JSON.stringify(residentStats(r, NOON_JST, WK)));
  check('A-1 差分が無ければ従来どおりの計算値', before.every((v, i) => v === withEmpty[i]));

  // 台帳に載っていない住人は、載っている住人が居ても影響を受けない。
  withTable({ [target.name]: { w: 0, l: 5, rd: -80, bs: 0, at: NOON_JST, d: 0, dn: 0 } });
  const drifted = roster.filter((r, i) =>
    r.id !== target.id && JSON.stringify(residentStats(r, NOON_JST, WK)) !== before[i]);
  check('A-2 他の住人には波及しない', drifted.length === 0, `${drifted.length}人がずれた`);
  check('A-2b 載っている住人だけが動く',
    JSON.stringify(residentStats(target, NOON_JST, WK)) !== before[roster.indexOf(target)]);

  // 明日も、明後日も、基準値は今までどおり日々動く（世界が止まらない）。
  noTable();
  const d0 = roster.map(r => JSON.stringify(residentStats(r, NOON_JST, WK)));
  const d1 = roster.map(r => JSON.stringify(residentStats(r, NOON_JST + DAY, WK)));
  const moved = d0.filter((v, i) => v !== d1[i]).length;
  check('A-3 誰とも当たっていない住人も日々動き続ける', moved === roster.length, `${moved}/${roster.length}人`);
}

// ---------------------------------------------------------------------------
// B. 人間が勝つと、住人の表示戦績が実際に変わる
// ---------------------------------------------------------------------------
{
  noTable();
  const base = residentStats(target, NOON_JST, WK);
  withTable({});
  const d = recordResidentMatch(target, {
    outcome: 0,                                    // 住人の負け（＝人間の勝ち）
    ratingDelta: elo(base.rating, 1500, 0),
    score: 1000,
    now: NOON_JST,
  });
  const after = residentStats(target, NOON_JST, WK);
  check('B-1 人間が勝つと住人の敗が1つ増える', after.pvpLosses === base.pvpLosses + 1,
    `${base.pvpLosses} → ${after.pvpLosses}`);
  check('B-2 勝ちの数は増えない', after.pvpWins === base.pvpWins, `${base.pvpWins} → ${after.pvpWins}`);
  check('B-3 レートが Elo どおり下がる', after.rating === base.rating + elo(base.rating, 1500, 0),
    `${base.rating} → ${after.rating}（Elo ${elo(base.rating, 1500, 0)}）`);
  check('B-4 変装レート（対戦相手として出る数字）も同じだけ動く',
    residentRating(target, NOON_JST) === after.rating,
    `${residentRating(target, NOON_JST)} vs ${after.rating}`);
  check('B-5 最終プレイ時刻が残る', d && d.at === NOON_JST, String(d && d.at));

  // 住人が勝った側も同じように積む。
  withTable({});
  const b2 = residentStats(target, NOON_JST, WK);
  recordResidentMatch(target, { outcome: 1, ratingDelta: elo(b2.rating, 1500, 1), score: 0, now: NOON_JST });
  const w2 = residentStats(target, NOON_JST, WK);
  check('B-6 住人が勝てば勝ちが増え、レートは上がる',
    w2.pvpWins === b2.pvpWins + 1 && w2.pvpLosses === b2.pvpLosses && w2.rating > b2.rating,
    `${b2.pvpWins}勝${b2.pvpLosses}敗/${b2.rating} → ${w2.pvpWins}勝${w2.pvpLosses}敗/${w2.rating}`);

  // 引き分けはどちらにも数えない（レートだけ動く）。
  withTable({});
  const b3 = residentStats(target, NOON_JST, WK);
  recordResidentMatch(target, { outcome: 0.5, ratingDelta: elo(b3.rating, 2000, 0.5), score: 0, now: NOON_JST });
  const d3 = residentStats(target, NOON_JST, WK);
  check('B-7 引き分けは勝敗に数えない',
    d3.pvpWins === b3.pvpWins && d3.pvpLosses === b3.pvpLosses, `${d3.pvpWins}勝${d3.pvpLosses}敗`);
}

// ---------------------------------------------------------------------------
// C. 👑 王者も同じ扱い（0敗は「初期値」であって不変条件ではない）
// ---------------------------------------------------------------------------
{
  noTable();
  const base = residentStats(champ, NOON_JST, WK);
  check('C-1 誰にも負けていないうちは 0敗のまま', base.pvpLosses === 0, `${base.pvpWins}勝${base.pvpLosses}敗`);
  withTable({});
  recordResidentMatch(champ, { outcome: 0, ratingDelta: -18, score: 0, now: NOON_JST });
  const after = residentStats(champ, NOON_JST, WK);
  check('C-2 実際に負けたら王者にも敗が付く', after.pvpLosses === 1, `${after.pvpWins}勝${after.pvpLosses}敗`);
  check('C-3 王者の名前で記録されている', champ.name === CHAMPION.name, champ.name);
}

// ---------------------------------------------------------------------------
// D. 同じ日なら揺れない（ランキングが読むたびに並び替わらない）
// ---------------------------------------------------------------------------
{
  withTable({ [target.name]: { w: 3, l: 7, rd: -55, bs: 250000, at: NOON_JST, d: 0, dn: 0 } });
  const a = JSON.stringify(residentStats(target, NOON_JST, WK));
  check('D-1 同一JST日で安定（1分後）', a === JSON.stringify(residentStats(target, NOON_JST + 60000, WK)));
  check('D-2 同一JST日で安定（11時間後・同日23時）',
    a === JSON.stringify(residentStats(target, NOON_JST + 11 * 3600000, WK)));
  // 台帳を触らなければ翌日も差分は同じ（基準値だけが動く）。
  const rec = residentRecord(target);
  const t1 = residentStats(target, NOON_JST + DAY, WK);
  check('D-3 翌日も差分は同じだけ乗る（基準値だけが動く）',
    residentRecord(target).rd === rec.rd && t1.pvpLosses >= 7, `敗${t1.pvpLosses}`);
}

// ---------------------------------------------------------------------------
// E. 自己ベストは下がらない
// ---------------------------------------------------------------------------
{
  noTable();
  const base = residentStats(target, NOON_JST, WK);
  // 低い点で対戦しても、自己ベストは1点も下がらない。
  withTable({});
  recordResidentMatch(target, { outcome: 0, ratingDelta: -20, score: 1, now: NOON_JST });
  check('E-1 低い点の試合でベストは下がらない',
    residentStats(target, NOON_JST, WK).bestScore === base.bestScore,
    `${base.bestScore} → ${residentStats(target, NOON_JST, WK).bestScore}`);
  // 基準値を超える点を出したら、その日から自己ベストになる（上がるときだけ）。
  const big = base.bestScore + 50000;
  recordResidentMatch(target, { outcome: 1, ratingDelta: 12, score: big, now: NOON_JST });
  const up = residentStats(target, NOON_JST, WK);
  check('E-2 基準値を超える点を出したら自己ベストが伸びる', up.bestScore >= base.bestScore, `${base.bestScore} → ${up.bestScore}`);
  // 天井（capOf）は素の式と同じものが掛かる ＝「頂は人間に残す」は保たれる。
  recordResidentMatch(target, { outcome: 1, ratingDelta: 1, score: 1000000, now: NOON_JST });
  check('E-3 上限（900,000）を超えない', residentStats(target, NOON_JST, WK).bestScore <= 900000,
    String(residentStats(target, NOON_JST, WK).bestScore));
  // 日をまたいでも単調（基準値も台帳も増える一方なので、最大値も減らない）。
  let prev = 0, downs = 0;
  for (let d = 0; d < 40; d++) {
    const v = residentStats(target, NOON_JST + d * DAY, WK).bestScore;
    if (v < prev) downs++;
    prev = v;
  }
  check('E-4 40日のあいだ一度も下がらない', downs === 0, `${downs}回下落`);
  // ダンジョン・タイムアタックは人間が干渉しない領域なので、基準値のまま。
  noTable();
  const pure = residentStats(target, NOON_JST, WK);
  withTable({ [target.name]: { w: 0, l: 9, rd: -200, bs: 800000, at: NOON_JST, d: 0, dn: 0 } });
  const mixed = residentStats(target, NOON_JST, WK);
  check('E-5 ダンジョン/タイムアタック/サバイバルは基準値のまま',
    mixed.dungeonMax === pure.dungeonMax && mixed.sprintBest === pure.sprintBest
    && mixed.sprint180 === pure.sprint180 && mixed.survivalWave === pure.survivalWave);
}

// ---------------------------------------------------------------------------
// F. 際限なく削られない（同じ住人を狩り続けてもランキングから消えない）
// ---------------------------------------------------------------------------
{
  noTable();
  const base = residentStats(target, NOON_JST, WK);
  withTable({});
  // 同じ日に100連戦で狩り続ける。
  for (let i = 0; i < 100; i++) recordResidentMatch(target, { outcome: 0, ratingDelta: -32, score: 0, now: NOON_JST });
  const after = residentStats(target, NOON_JST, WK);
  check('F-1 レートに下限がある', after.rating >= base.rating - 300 && after.rating >= 700,
    `${base.rating} → ${after.rating}`);
  check('F-2 それでも変装候補の帯に残る（700以上）', after.rating >= 700, String(after.rating));
  check('F-3 敗の数はごまかさずに積む（100戦なら100敗）',
    after.pvpLosses === base.pvpLosses + 100, `${base.pvpLosses} → ${after.pvpLosses}`);

  // 逓減: 同じ日に何度も当たるほど、レートへの効きだけが小さくなる。
  withTable({});
  recordResidentMatch(target, { outcome: 0, ratingDelta: -30, now: NOON_JST });
  const first = residentRecord(target).rd;
  withTable({});
  for (let i = 0; i < 7; i++) recordResidentMatch(target, { outcome: 0, ratingDelta: -30, now: NOON_JST });
  const seven = residentRecord(target).rd;
  check('F-4 同じ日に狩り続けるとレートへの効きが逓減する',
    seven > first * 7, `1戦 ${first} / 7戦 ${seven}（そのままなら ${first * 7}）`);

  // 日が変われば効きは戻る（別の日にちゃんと戦えば、ちゃんと動く）。
  withTable({});
  for (let i = 0; i < 3; i++) recordResidentMatch(target, { outcome: 0, ratingDelta: -30, now: NOON_JST });
  const day1 = residentRecord(target).rd;
  recordResidentMatch(target, { outcome: 0, ratingDelta: -30, now: NOON_JST + DAY });
  check('F-5 日が変われば効きが戻る', residentRecord(target).rd === day1 - 30,
    `${day1} → ${residentRecord(target).rd}`);
  check('F-6 日をまたぐと当日カウンタがリセットされる',
    residentRecord(target).d === jstDay(NOON_JST + DAY) && residentRecord(target).dn === 1,
    `d=${residentRecord(target).d} dn=${residentRecord(target).dn}`);
}

// ---------------------------------------------------------------------------
// G. 差分の表に上限が効いている（db.json が無限に伸びない）
// ---------------------------------------------------------------------------
{
  check('G-0 上限が実装から読めている', Number.isInteger(RESIDENT_RECORD_MAX) && RESIDENT_RECORD_MAX > 0,
    String(RESIDENT_RECORD_MAX));
  const t = {};
  withTable(t);
  // 名簿より多い人数ぶん記録する（住人1人1行なので、実際はここまで増えない）。
  const many = buildRoster('v1', RESIDENT_RECORD_MAX + 120);
  many.forEach((r, i) => recordResidentMatch(r, { outcome: 0, ratingDelta: -5, now: NOON_JST + i * 1000 }));
  check('G-1 行数が上限で頭打ちになる', Object.keys(t).length === RESIDENT_RECORD_MAX,
    `${Object.keys(t).length}行 / 上限 ${RESIDENT_RECORD_MAX}`);
  // 落ちるのは「最後に対戦したのがいちばん古い」行。新しい行は残る。
  const last = many[many.length - 1];
  check('G-2 落ちるのは古い順（直近に戦った住人は残る）', !!t[last.name], `${last.name} が残っているか`);
  check('G-3 いちばん古い行が落ちている', !t[many[0].name], `${many[0].name}`);
  // 直接呼んでも同じ（backup.js の合流がこれを使う）。
  const over = {};
  for (let i = 0; i < RESIDENT_RECORD_MAX + 50; i++) over[`名前${i}`] = { w: 0, l: 1, rd: -1, bs: 0, at: i };
  const dropped = pruneResidentRecords(over);
  check('G-4 pruneResidentRecords が超過ぶんを落とす',
    dropped === 50 && Object.keys(over).length === RESIDENT_RECORD_MAX,
    `${dropped}行落として ${Object.keys(over).length}行`);
}

// ---------------------------------------------------------------------------
// H. 引く経路が違っても同じ行に当たる（キーが id ではなく名前である理由）
// ---------------------------------------------------------------------------
//
// 住人の id（r21）は「名簿の何番目か」でしかない。buildRoster は最後に
// 「王者が引かれなかったら**いちばん強い住人**を差し替える」ので、名簿の
// 大きさが違えば同じ人でも id が変わる。実サーバーでは /api/profile が
// 600人で組んだ名簿から、🏆ランキングが倍率ぶんの人数で組んだ名簿から
// 同じ住人を引く ── id をキーにすると、通しで確かめたときに
// 「ランキングには1敗が出るのにプロフィールでは0敗のまま」になった。
{
  const small = buildRoster('v1', 64).find(r => r.name === CHAMPION.name);
  const big = buildRoster('v1', 600).find(r => r.name === CHAMPION.name);
  check('H-0 名簿の大きさで同じ住人の id が変わる（id をキーにできない理由）',
    !!small && !!big && small.id !== big.id, `64人=${small && small.id} / 600人=${big && big.id}`);
  withTable({});
  recordResidentMatch(small, { outcome: 0, ratingDelta: -25, score: 0, now: NOON_JST });
  check('H-1 片方の経路で付けた1敗が、もう片方の経路でも見える',
    residentStats(big, NOON_JST, WK).pvpLosses === 1
    && residentStats(small, NOON_JST, WK).pvpLosses === 1,
    `600人側 ${residentStats(big, NOON_JST, WK).pvpLosses}敗 / 64人側 ${residentStats(small, NOON_JST, WK).pvpLosses}敗`);
  check('H-2 台帳のキーは住人の名前', Object.keys(table)[0] === CHAMPION.name, Object.keys(table).join(','));

  // 運営が付けた危ない名前でプロトタイプを触らせない。
  const danger = { ...target, name: '__proto__' };
  withTable({});
  check('H-3 "__proto__" という名前の住人は記録しない',
    recordResidentMatch(danger, { outcome: 0, ratingDelta: -10, now: NOON_JST }) === null
    && Object.keys(table).length === 0 && ({}).w === undefined);
}

// ---------------------------------------------------------------------------
// I. 復元で消えない（server/backup.js の合流）
// ---------------------------------------------------------------------------
{
  const live = {
    users: {}, tokens: {}, revoked: {}, deleted: {}, guilds: {}, news: [],
    transactions: [], bugreports: [],
    // ディスクが飛んだあと、復元までの窓で1戦だけ終わった状態。
    meta: { createdAt: 1, residentRecords: { ミナト: { w: 0, l: 1, rd: -12, bs: 0, at: 200, d: 0, dn: 1 } } },
  };
  const file = {
    users: {}, tokens: {},
    meta: {
      createdAt: 999,
      residentRecords: {
        ミナト: { w: 2, l: 4, rd: -40, bs: 300000, at: 100, d: 0, dn: 0 },
        ファイルだけの人: { w: 1, l: 1, rd: 5, bs: 1000, at: 50, d: 0, dn: 0 },
      },
    },
  };
  applyRestore(live, file, 'merge');
  const rr = live.meta.residentRecords;
  check('I-1 ライブ側に1行あってもバックアップの戦績が丸ごと落ちない',
    !!rr['ファイルだけの人'], Object.keys(rr).join(','));
  check('I-2 勝敗は両側の大きいほう（足し算で水増ししない）',
    rr['ミナト'].w === 2 && rr['ミナト'].l === 4, `${rr['ミナト'].w}勝${rr['ミナト'].l}敗`);
  check('I-3 自己ベストも両側の大きいほう', rr['ミナト'].bs === 300000, String(rr['ミナト'].bs));
  check('I-4 レートの差分は新しい側（at が大きいほう）', rr['ミナト'].rd === -12, String(rr['ミナト'].rd));
  check('I-5 最終プレイ時刻は新しいほう', rr['ミナト'].at === 200, String(rr['ミナト'].at));

  // 復元したものが、そのまま表示戦績に効くこと（＝復元の意味がある）。
  withTable(rr);
  const name = CHAMPION.name;
  const live2 = { users: {}, tokens: {}, meta: {} };
  applyRestore(live2, { users: {}, tokens: {}, meta: { residentRecords: { [name]: { w: 0, l: 3, rd: -50, bs: 0, at: 1 } } } }, 'merge');
  withTable(live2.meta.residentRecords);
  check('I-6 復元した戦績がそのまま表示に効く',
    residentStats(champ, NOON_JST, WK).pvpLosses === 3,
    `${residentStats(champ, NOON_JST, WK).pvpLosses}敗`);

  // 細工したファイルで db.json を膨らませられない。
  const huge = {};
  for (let i = 0; i < RESIDENT_RECORD_MAX + 400; i++) huge[`名前${i}`] = { w: 0, l: 1, rd: -1, bs: 0, at: i };
  const live3 = { users: {}, tokens: {}, meta: {} };
  applyRestore(live3, JSON.parse(JSON.stringify({ users: {}, tokens: {}, meta: { residentRecords: huge } })), 'merge');
  check('I-7 復元でも行数の上限が効く',
    Object.keys(live3.meta.residentRecords).length <= RESIDENT_RECORD_MAX,
    `${Object.keys(live3.meta.residentRecords).length}行`);

  // "__proto__" を持つファイルでプロトタイプが差し替わらない。
  const live4 = { users: {}, tokens: {}, meta: { residentRecords: {} } };
  applyRestore(live4, JSON.parse('{"users":{},"tokens":{},"meta":{"residentRecords":{"__proto__":{"polluted":"yes"}}}}'), 'merge');
  check('I-8 "__proto__" でプロトタイプが差し替わらない',
    Object.getPrototypeOf(live4.meta.residentRecords) === Object.prototype && ({}).polluted === undefined);
}

// ---------------------------------------------------------------------------
// J. 差分の中身が非管理者に漏れていない
// ---------------------------------------------------------------------------
//
// 台帳の中身（w / l / rd / at / 台帳そのもの）は運営の数字。住人の側に
// 「実際の対戦記録が別枠で付いている」と分かるだけで、それは実プレイヤーには
// 存在しない属性 ＝ 総当たりで住人を割り出せる印になる。
// 非管理者に出るのは **差分を足したあとの合計値だけ** であること。
{
  withTable({ [target.name]: { w: 3, l: 7, rd: -55, bs: 250000, at: NOON_JST, d: 1, dn: 2 } });
  const st = residentStats(target, NOON_JST, WK);
  const LEDGER_KEYS = ['w', 'l', 'rd', 'bs', 'at', 'd', 'dn', 'record', 'records', 'residentRecords', 'lastAt'];
  const leaked = LEDGER_KEYS.filter(k => Object.prototype.hasOwnProperty.call(st, k));
  check('J-1 residentStats は合計値だけを返す（内訳を載せない）', leaked.length === 0, leaked.join(','));
  check('J-2 直列化しても台帳の形が出てこない',
    !JSON.stringify(st).includes('"dn"') && !JSON.stringify(st).includes('"rd"'));

  // 台帳を触るのは battle.js（記録）と backup.js（復元の合流）だけ。
  // 公開APIの側（index.js / routes/*.js）から見えていないことをソースで確かめる。
  const PUBLIC_FILES = ['server/index.js', 'server/routes/social.js', 'server/routes/admin.js']
    .filter(p => fs.existsSync(path.join(root, p)));
  const routesDir = path.join(root, 'server/routes');
  if (fs.existsSync(routesDir)) {
    for (const f of fs.readdirSync(routesDir)) {
      if (f.endsWith('.js') && !PUBLIC_FILES.includes(`server/routes/${f}`)) PUBLIC_FILES.push(`server/routes/${f}`);
    }
  }
  const owners = PUBLIC_FILES.filter(p => /residentRecords|residentRecord\s*\(/.test(read(p)));
  check('J-3 公開APIのファイルが台帳を直接触っていない', owners.length === 0, owners.join(', '));

  // 運営向けの一覧（rosterView）にだけ内訳が載る。その一覧を返す口が
  // /api/admin/ 配下であること ＝ sanitize.js の関門をバイパスしてよい面。
  const ambient = read('server/ambient.js');
  check('J-4 内訳を載せているのは運営向けの一覧だけ',
    /export function rosterView[\s\S]*?residentRecord\(r\)[\s\S]*?record:/.test(ambient),
    'ambient.js の rosterView');
  const admin = read('server/routes/admin.js');
  const at = admin.indexOf('rosterView(');
  const routeBefore = admin.lastIndexOf("'/api/admin/", at);
  check('J-5 その一覧を返すのは /api/admin/ の口', at > 0 && routeBefore > 0,
    admin.slice(routeBefore, routeBefore + 40).split('\n')[0]);
}

// ---------------------------------------------------------------------------
// K. 記録する場所の配線（server/battle.js の endMatch）
// ---------------------------------------------------------------------------
//
// 実際の対戦を1本通すのは battle.test.mjs / champion.test.mjs の仕事。
// ここでは「記録が正しい条件でだけ走るように書かれているか」を見る ──
// 条件を1つ落とすと、協力プレイや未登録の住人にまで戦績が付いてしまう。
{
  const src = read('server/battle.js');
  check('K-1 endMatch が住人の戦績を記録している', /recordResidentMatch\s*\(/.test(src));
  const at = src.indexOf('recordResidentMatch(');
  const block = src.slice(Math.max(0, at - 1600), at);
  check('K-2 レート戦の1対1のときだけ（duel2）', /if\s*\(duel2\)/.test(block));
  check('K-3 相手が住人の変装で、登録済み（レートを持つ）ときだけ',
    /p\.sock\.isBot\s*&&\s*p\.sock\.resident\s*&&\s*p\.sock\.rating\s*!=\s*null/.test(block));
  check('K-4 人間が居るときだけ', /!p\.sock\.isBot/.test(block) && /humanUsers\[/.test(block));
  check('K-5 レートは試合前の値どうしで引き直す（Elo）',
    /eloUpdate\(\s*resSide\.sock\.rating\s*,\s*humanRating/.test(src.slice(at - 200, at + 400)));
  check('K-6 台帳の読み口を residents.js に渡している',
    /setResidentRecordSource\(/.test(src) && /db\.meta\.residentRecords\s*=/.test(src));
  // 記録のあとに保存が走ること（走らないと再起動で消える）。
  const save = src.indexOf('saveDb();', at);
  check('K-7 記録のあとに保存される', save > at, `endMatch の saveDb() 位置 ${save}`);
}

// ---------------------------------------------------------------------------
for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(bad ? `\n${bad} 件失敗` : `\n全 ${results.length} 件成功`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 後片付けは best effort */ }
