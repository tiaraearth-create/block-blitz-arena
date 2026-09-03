// リポジトリのルートから:  node test/boardquality.test.mjs
//
// 🏆 「上位100位」が、その世界の規模に見合った顔ぶれになっているか。
//
// ■ 何が起きていたか
//   boardResidents は登録済み住人を **一様乱数** で並べて先頭 count 件を取っていた。
//   つまり出していたのは上位100人ではなく「無作為な100人」で、その最弱は名簿の底。
//   本番（表示オンライン108万人・名簿600人/登録521人）の実測:
//       ハイスコア #1 1,000,000 / #50 105,840 / #90 19,508 / #100 8,309
//       レート     #100 1,000（＝初期値）  ダンジョン #100 3階  パズル #100 1面
//       レベルは最小1。#89 は「9勝9敗・ダンジョン4階」なのに Lv.4。
//   「100万人オンライン」と出している世界で、全体100位が Lv.1・8,309点 では嘘が見える。
//
// ■ 通したい細い道（両側に失敗がある）
//   ・弱すぎる → 上のとおり。世界の規模と噛み合わない。
//   ・強すぎる／固定しすぎ → 毎週まったく同じ顔ぶれになって世界が止まる。
//     住人が上限に張り付くと「頂は人間に残す」も壊れる。
//   通した道: 成績の上位から選び、順位に ±(定員×0.25) の揺らぎだけ許す。
//
// ■ ここで見るもの
//   ① 板の下限が「その世界の住人の中で上位」と言える高さにある
//   ② レベルが行の中身と噛み合う（Lv.1〜5 が全体100位に出てこない）
//   ③ 永久に新人のままの住人（joinedDay=null → age≦14日）が上位100位に出ない
//   ④ 世界を大きくすると板の中身も強くなる（行数だけが伸びる非対称を作らない）
//   ⑤ 巻き添えが無い ── 王者は先頭／同じ週なら不変／週が変われば入れ替わる
//   ⑥ 頂は人間に残る（住人は上限を超えない）
//   ⑦ パズル遺跡・採掘場・塔が「同じ順位表の使い回し」になっていない
//
// サーバーを立てないので安い組に置いてよい。
process.env.POP_SCALE = process.env.POP_SCALE || '1';
const amb = await import('../server/ambient.js');
const res = await import('../server/residents.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const NOW = Date.UTC(2026, 8, 3, 12);   // 固定の瞬間（住人の値は日で決まる）
const WEEK = 'W1';
// 本番相当の倍率（表示オンライン ≒ 850 × これ）。
const LIVE = 1276;

const BOARDS = ['score', 'rating', 'dungeon', 'weekly', 'sprint', 'puzzle', 'dig'];
const valueOf = (board, st, r) => (
  board === 'score' ? st.bestScore
    : board === 'rating' ? st.rating
      : board === 'dungeon' ? st.dungeonMax
        : board === 'weekly' ? st.weeklyBest
          : board === 'sprint' ? st.sprintBest
            : board === 'puzzle' ? amb.puzzleStageOf(r, st)
              : amb.digDepthOf(r, st));

function boardOf(board, week = WEEK, now = NOW) {
  return amb.boardResidents(board, week, now).map(r => ({ r, st: res.residentStats(r, now, week) }));
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };

amb.setLiveScale(LIVE);
const registered = amb.getRoster().filter(r => r.registered);
check('下ごしらえ: 本番規模の名簿が組めた', registered.length > 300, `登録済み ${registered.length}人`);

// ---------------------------------------------------------------------------
// ①②③ 板の下限・レベル・新人
// ---------------------------------------------------------------------------
for (const board of BOARDS) {
  const rows = boardOf(board);
  const vals = rows.map(x => valueOf(board, x.st, x.r)).sort((a, b) => b - a);
  const all = registered.map(r => valueOf(board, res.residentStats(r, NOW, WEEK), r)).sort((a, b) => b - a);

  // ① 板の最下位が、住人全体の上から数えてどのあたりか。
  //    一様抽選だと最下位は名簿の底（＝分位1.0近く）に落ちる。
  const worst = vals[vals.length - 1];
  const rankOfWorst = all.filter(v => v > worst).length;
  const pct = rankOfWorst / all.length;
  check(`① ${board}: 最下位が住人全体の上位${Math.round(pct * 100)}%以内`, pct <= 0.45,
    `最下位=${worst} / 全${all.length}人中 ${rankOfWorst + 1}位`);

  // ② レベル。行の中身（対戦数・到達階）と噛み合わない Lv.1〜5 を上位100位に出さない。
  const lv = rows.map(x => x.st.level);
  check(`② ${board}: レベルの最小が6以上`, Math.min(...lv) >= 6,
    `最小Lv.${Math.min(...lv)} / 中央Lv.${q(lv, 0.5)}`);

  // ③ 永久に新人のままの住人（joinedDay=null）は age が1〜14日に張り付く。
  const rookies = rows.filter(x => x.st.age <= 14);
  check(`③ ${board}: 参加2週間以内の住人が上位100位に出ない`, rookies.length === 0,
    rookies.map(x => `${x.r.name}(${x.st.age}日/Lv.${x.st.level})`).slice(0, 3).join(' '));
}

// ---------------------------------------------------------------------------
// ④ 世界を大きくすると、行数だけでなく中身も強くなる
// ---------------------------------------------------------------------------
{
  const at = scale => {
    amb.setLiveScale(scale);
    const rows = boardOf('score');
    const vals = rows.map(x => x.st.bestScore).sort((a, b) => b - a);
    return { rows: rows.length, worst: vals[vals.length - 1], median: q(vals, 0.5) };
  };
  const small = at(1);
  const big = at(1276);
  check('④ 世界が大きいほど板の行数が多い', big.rows >= small.rows, `×1:${small.rows}行 → ×1276:${big.rows}行`);
  check('④ 世界が大きいほど板の最下位も強い', big.worst > small.worst,
    `×1 最下位 ${small.worst} → ×1276 最下位 ${big.worst}（行数だけ伸ばす非対称を作らない）`);
  amb.setLiveScale(LIVE);
}

// ---------------------------------------------------------------------------
// ⑤ 巻き添えが無い
// ---------------------------------------------------------------------------
{
  for (const board of BOARDS) {
    const first = amb.boardResidents(board, WEEK, NOW)[0];
    check(`⑤ ${board}: 王者が先頭にいる`, !!first && res.isChampion(first), first ? first.name : 'なし');
  }
  const a = amb.boardResidents('score', WEEK, NOW).map(r => r.id).join();
  const b = amb.boardResidents('score', WEEK, NOW).map(r => r.id).join();
  check('⑤ 同じ週・同じ日なら顔ぶれも順序も動かない', a === b, '');

  const next = amb.boardResidents('score', 'W2', NOW).map(r => r.id);
  const moved = a.split(',').filter(id => !next.includes(id)).length;
  check('⑤ 週が変われば顔ぶれが入れ替わる（世界が止まって見えない）', moved > 0, `${moved}人が入れ替わり`);
  check('⑤ ただし総入れ替えにはならない（板が毎週別世界にならない）', moved < 60, `${moved}人`);
}

// ---------------------------------------------------------------------------
// ⑥ 頂は人間に残す
// ---------------------------------------------------------------------------
{
  const rows = boardOf('score');
  const top = Math.max(...rows.map(x => x.st.bestScore));
  check('⑥ 住人のハイスコアは上限（900,000）を超えない', top <= 900000, `最高 ${top}`);
  const rt = Math.max(...boardOf('rating').map(x => x.st.rating));
  check('⑥ 住人のレートは上限（2,600）を超えない', rt <= 2600, `最高 ${rt}`);
  const dg = Math.max(...boardOf('dungeon').map(x => x.st.dungeonMax));
  check('⑥ 住人の塔は99階止まり（100F制覇は人間だけ）', dg <= 99, `最高 ${dg}階`);
}

// ---------------------------------------------------------------------------
// ⑦ パズル遺跡・採掘場・塔が同じ順位表の使い回しでない
// ---------------------------------------------------------------------------
{
  const ids = b => amb.boardResidents(b, WEEK, NOW).map(r => r.id).join();
  const [pz, dg, dn] = ['puzzle', 'dig', 'dungeon'].map(ids);
  check('⑦ パズル遺跡と採掘場の顔ぶれが違う', pz !== dg, '');
  check('⑦ パズル遺跡と塔の顔ぶれが違う', pz !== dn, '');
  check('⑦ 採掘場と塔の顔ぶれが違う', dg !== dn, '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🏆 ランキングの顔ぶれ  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
