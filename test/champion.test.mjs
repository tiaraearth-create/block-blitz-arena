// リポジトリのルートから:  node test/champion.test.mjs
//
// 👑 ちゃちゃまる（住人の頂点）がランキングの全ボードに載り、住人の中で1位に
// なっていることを見張る。運営の明示要求なので、壊れたら気づけるようにしておく。
//
// ■ 何が起きていたか
// レート部門では1位なのに、ハイスコア部門には1件も出てこないボードがあった。
// 原因は2つ:
//   1. server/ambient.js の boardResidents() が、そのボードに出す住人を
//      unit(`${r.id}-${board}`, bucket) の抽選で決めていて、王者もふつうに
//      漏れていた（＝ボードによっては存在ごと消える）
//   2. 強さを決めているのは skill と天井の帯だけで、得意分野・練習の間隔と
//      当たり外れ・調子・週や日の運・参加日は全部ふつうの乱数だった。
//      だから抽選に残っても、運だけで格下に抜かれる日が普通にあった
//
// ■ ここで見るもの（実プレイヤーが上回ったらその人が1位、は壊さない）
//   A. 全ボードに必ず載る（しかも住人の並びの先頭 ＝ 同点は王者が上）
//   B. どのボードでも住人の中で1位（複数のシード・名簿の大きさ・日付で）
//   C. 同じ日なら値が安定している（ランキングが読むたびに揺れない）
//   D. 王者は1人しかいない（名前がぶつかった「2人目」が湧かない）
//   E. 147勝0敗のような作り物の成績になっていない
import {
  buildRoster, residentStats, residentDailyScore, isChampion, CHAMPION,
} from '../server/residents.js';
import { boardResidents, ghostRows, setLiveScale } from '../server/ambient.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const DAY = 86400000;
// JST 正午に固定（+数時間しても同じJST日 ＝ 日付境界を踏まない）。
const NOON_JST = Date.UTC(2026, 7, 26, 3, 0);

// /api/leaderboard が並べているキー（server/index.js の sort と同じ）。
// 🧩パズル遺跡と⛏️採掘場は ghostRows が dungeonMax から作るので、行から読む。
const BOARD_KEY = {
  score: r => r.bestScore,
  rating: r => r.rating,
  dungeon: r => r.dungeonMax,
  weekly: r => r.weeklyBest,
  sprint: r => r.sprintBest,
  puzzle: r => r.puzzleStage,
  dig: r => r.digDepth,
  daily: r => r.dailyScore,
};
const BOARDS = Object.keys(BOARD_KEY);

// ---------------------------------------------------------------------------
// A. 全ボードに載る（＋住人の並びの先頭）
// ---------------------------------------------------------------------------
{
  setLiveScale(1);
  const missing = [], notFirst = [];
  for (const board of BOARDS) {
    const list = boardResidents(board, 'W100', NOON_JST);
    if (!list.some(isChampion)) missing.push(board);
    else if (!isChampion(list[0])) notFirst.push(board);
  }
  check('A-1 全ボードの住人サブセットに王者がいる', missing.length === 0, missing.length ? `抜け: ${missing.join(', ')}` : `${BOARDS.length}ボード`);
  check('A-2 王者は住人の並びの先頭（同点なら王者が上に来る）', notFirst.length === 0, notFirst.join(', '));

  // にぎわいの倍率を変えても抜けない（倍率でサブセットの件数が変わるため）。
  const missing2 = [];
  for (const scale of [0.5, 1, 2.5, 10]) {
    setLiveScale(scale);
    for (const board of BOARDS) {
      if (!boardResidents(board, 'W100', NOON_JST).some(isChampion)) missing2.push(`${scale}:${board}`);
    }
  }
  setLiveScale(1);
  check('A-3 にぎわいの倍率を変えても全ボードに載る', missing2.length === 0, missing2.slice(0, 5).join(', '));

  // にぎわいOFF（scale 0）は従来どおり住人を1人も出さない。
  setLiveScale(0);
  const off = BOARDS.every(b => boardResidents(b, 'W100', NOON_JST).length === 0);
  setLiveScale(1);
  check('A-4 にぎわいOFFのときは住人を1人も出さない（従来どおり）', off, '');
}

// ---------------------------------------------------------------------------
// B. 実際にボードへ流し込んだ行で、住人の中の1位が王者であること
//    （ghostRows は名無しの埋め草も混ぜるので、そこも含めて確かめる）
// ---------------------------------------------------------------------------
{
  setLiveScale(1);
  const notTop = [];
  for (const board of BOARDS) {
    const rows = ghostRows(board, 'W100', new Set(), NOON_JST);
    const key = BOARD_KEY[board];
    const sorted = rows.slice().sort((a, b) => (key(b) || 0) - (key(a) || 0));
    if (!sorted.length || sorted[0].username !== CHAMPION.name) {
      notTop.push(`${board}: ${sorted.length ? `${sorted[0].username}(${key(sorted[0])}) > ${CHAMPION.name}` : '行なし'}`);
    }
  }
  check('B-1 ゴースト行を並べ替えると全ボードで王者が1位', notTop.length === 0, notTop.join(' / '));

  // 実プレイヤーと同名なら従来どおり住人のほうが消える（なりすまし防止の既存規則）。
  const hidden = ghostRows('score', 'W100', new Set([CHAMPION.name]), NOON_JST);
  check('B-2 同名の実プレイヤーがいるときは王者の行を出さない（既存の除外規則）',
    !hidden.some(r => r.username === CHAMPION.name), '');
}

// ---------------------------------------------------------------------------
// B'. 素の成績でも、住人の中で1位であること
//     名簿のシード・大きさ・日付を変えても崩れないこと（＝運では抜かれない）
// ---------------------------------------------------------------------------
{
  const STAT_KEY = {
    'ハイスコア': s => s.bestScore,
    'レート': s => s.rating,
    'ダンジョン': s => s.dungeonMax,
    'ウィークリー': s => s.weeklyBest,
    'タイムアタック60秒': s => s.sprintBest,
    'タイムアタック3分': s => s.sprint180,
    'サバイバル': s => s.survivalWave,
  };
  const losses = [];
  let compared = 0;
  for (const seed of ['v1', 'v2', 'abc', 'seed9']) {
    for (const size of [64, 240, 600]) {
      const roster = buildRoster(seed, size);
      const champ = roster.find(isChampion);
      if (!champ) { losses.push(`${seed}/${size}: 王者がいない`); continue; }
      for (const days of [-60, 0, 45, 365, 2000]) {
        const at = NOON_JST + days * DAY;
        const wk = `W${100 + days}`;
        const st = roster.filter(r => r.registered).map(r => ({ r, s: residentStats(r, at, wk) }));
        const mine = st.find(x => x.r === champ).s;
        for (const [label, f] of Object.entries(STAT_KEY)) {
          compared++;
          const top = Math.max(...st.filter(x => x.r !== champ).map(x => f(x.s)));
          if (f(mine) < top) losses.push(`${seed}/${size}/+${days}日 ${label}: ${f(mine)} < ${top}`);
        }
        compared++;
        const dayTop = Math.max(...roster.filter(r => r.registered && r !== champ).map(r => residentDailyScore(r, at)));
        if (residentDailyScore(champ, at) < dayTop) losses.push(`${seed}/${size}/+${days}日 デイリー: ${residentDailyScore(champ, at)} < ${dayTop}`);
      }
    }
  }
  check('B-3 名簿のシード・大きさ・日付を変えても、全部門で住人の1位',
    losses.length === 0, losses.length ? losses.slice(0, 4).join(' / ') : `${compared}通りを照合`);
}

// ---------------------------------------------------------------------------
// C. 同じ日なら値が安定している（ランキングが読むたびに揺れない）
// ---------------------------------------------------------------------------
{
  const roster = buildRoster('v1', 240);
  const champ = roster.find(isChampion);
  const snap = t => JSON.stringify(residentStats(champ, t, 'W100')) + '|' + residentDailyScore(champ, t);
  const a = snap(NOON_JST);
  check('C-1 1分後も同じ値', a === snap(NOON_JST + 60000), '');
  check('C-2 同じJST日の23時でも同じ値', a === snap(NOON_JST + 11 * 3600000), '');
  setLiveScale(1);
  const listA = boardResidents('score', 'W100', NOON_JST).map(r => r.id).join(',');
  const listB = boardResidents('score', 'W100', NOON_JST + 3600000).map(r => r.id).join(',');
  check('C-3 同じ日ならボードの顔ぶれも変わらない', listA === listB, '');
  // 自己ベストは下がらない（王者だけ別式にしていないことの裏取り）。
  let down = 0, prev = null;
  for (let d = 0; d < 120; d++) {
    const s = residentStats(champ, NOON_JST + d * DAY, 'W100');
    if (prev) for (const k of ['bestScore', 'sprintBest', 'sprint180', 'survivalWave', 'dungeonMax']) if (s[k] < prev[k]) down++;
    prev = s;
  }
  check('C-4 王者の自己ベストも一度も下がらない（120日）', down === 0, `違反${down}件`);
}

// ---------------------------------------------------------------------------
// D. 王者は1人だけ
// ---------------------------------------------------------------------------
{
  const bad = [];
  for (const seed of ['v1', 'v2', 'abc', 'seed9', 'hello', '2026']) {
    for (const size of [64, 120, 240, 600]) {
      const roster = buildRoster(seed, size);
      const champs = roster.filter(isChampion);
      if (champs.length !== 1) bad.push(`${seed}/${size}: ${champs.length}人 (${champs.map(r => r.name).join(',')})`);
      else if (champs[0].name !== CHAMPION.name) bad.push(`${seed}/${size}: 名前が ${champs[0].name}`);
    }
  }
  check('D-1 どの名簿でも王者はちょうど1人（連番付きの偽者が湧かない）', bad.length === 0, bad.slice(0, 3).join(' / '));
}

// ---------------------------------------------------------------------------
// E. 対戦成績が作り物に見えないこと
//    以前は 147勝0敗。1敗もしていない成績は、それだけで計算式だと分かる。
// ---------------------------------------------------------------------------
{
  const roster = buildRoster('v1', 240);
  const champ = roster.find(isChampion);
  const bad = [];
  for (const days of [0, 30, 200, 1000]) {
    const s = residentStats(champ, NOON_JST + days * DAY, 'W100');
    const rate = s.pvpWins / Math.max(1, s.pvpWins + s.pvpLosses);
    if (s.pvpLosses < 1) bad.push(`+${days}日: ${s.pvpWins}勝${s.pvpLosses}敗（無敗）`);
    if (rate < 0.9) bad.push(`+${days}日: 勝率${(rate * 100).toFixed(1)}%（低すぎる）`);
  }
  check('E-1 王者にも少数の敗北がある（勝率は90%以上のまま）', bad.length === 0, bad.join(' / '));
  const s0 = residentStats(champ, NOON_JST, 'W100');
  check('E-2 敗北数も決定論的（同じ日なら同じ）',
    s0.pvpLosses === residentStats(champ, NOON_JST + 60000, 'W100').pvpLosses,
    `${s0.pvpWins}勝${s0.pvpLosses}敗`);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
