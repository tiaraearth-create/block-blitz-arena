// リポジトリのルートから:  node test/worldconsistency.test.mjs
//
// 🌍 「世界の辻褄が合っているか」を機械的に検算する。
//
// きっかけはユーザーの指摘:
//   「オンライン表示がとても多いのに、ランキングが100位まで表示されないのは
//     矛盾している気がします」
// 実測（既定の ×500 / 表示オンライン37万人）で、そのとおりだった:
//   ハイスコア100行 ／ レート75 ／ ダンジョン60 ／ タイムアタック55 ／
//   デイリー50 ／ **ウィークリー45行**
// 原因は ambient.js の行数の式が `Math.min(scale, 2.5)` で頭打ちだったこと。
// 表示人数は ×2000 まで伸びるのに行数だけ ×2.5 で止まる ＝ **人が増えるほど
// 矛盾が広がる**設計だった。
//
// このテストが見張るのは「数字どうしの辻褄」であって、値の中身ではない
// （中身は ranking-ai / champion が見ている）。具体的には:
//   ① 人数に見合う行数か（多いのに少ない／少ないのに多い、が無いか）
//   ② 倍率を下げたら行数も下がるか（頭打ちを別の頭打ちに替えていないか）
//   ③ 同じ日なら同じ顔ぶれ・同じ値か（既存の約束を壊していないか）
//   ④ にぎわいの「札」（mood）が人数と一緒に動くか
//   ⑤ 人数から出す係数（発言の速さ・席が埋まるまで）が人数で伸びるか
//
// サーバーは立てない（純ロジック）。
import {
  setLiveScale, effectiveScale, ambientOnline, peakOnline,
  ghostRows, boardResidents, boardRowCount, boardFill, BOARD_MAX_ROWS,
  crowdMood, crowdPace, MAX_CROWD_PACE, matchWaitMs, MATCH_WAIT_FLOOR_MS,
} from '../server/ambient.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// JST 21時（人口カーブの山）に固定。同じ JST 日のうちで動かす。
const PEAK_JST = Date.UTC(2026, 8, 1, 12, 0);
// 同じ JST 日（2026-09-01）の 04:00。UTC では前日の 19:00 になる ── ここを
// PEAK_JST と別の JST 日にすると、デイリーボードが引き直されて
// 「時刻で動かない」の検算が別の理由で落ちる。
const NIGHT_JST = Date.UTC(2026, 8, 0, 19, 0);
const BOARDS = ['score', 'rating', 'dungeon', 'weekly', 'sprint', 'daily', 'puzzle', 'dig'];

const rowsOf = (board, now = PEAK_JST) => ghostRows(board, 'W100', new Set(), now).length;
const allRows = (now = PEAK_JST) => BOARDS.map(b => rowsOf(b, now));

// ---------------------------------------------------------------------------
// ① 表示オンライン人数と行数が矛盾しない
// ---------------------------------------------------------------------------
{
  // 「これだけ人がいれば、どのボードも100位まで埋まっているはず」の線。
  // ピーク1万人 = ×12 前後。1万人の同時接続がある世界で「45位までしか
  // 記録が無い」は、どう説明しても嘘になる。
  const FULL_AT_PEAK_ONLINE = 10000;
  const short = [];
  for (const scale of [12, 20, 88, 200, 500, 1000, 2000]) {
    setLiveScale(scale);
    if (peakOnline() < FULL_AT_PEAK_ONLINE) continue;
    for (const b of BOARDS) {
      const n = rowsOf(b);
      if (n !== BOARD_MAX_ROWS) short.push(`×${scale} ${b}=${n}行`);
    }
  }
  check(`ピーク${FULL_AT_PEAK_ONLINE}人以上の世界では全ボードが${BOARD_MAX_ROWS}行`, short.length === 0, short.slice(0, 6).join(' / '));

  // 既定値（db.meta.popScale の実運用値）でも満杯であること。
  setLiveScale(500);
  const at500 = allRows();
  check('×500（実運用の既定）で全ボード100行',
    at500.every(n => n === BOARD_MAX_ROWS),
    `オンライン${ambientOnline(PEAK_JST).toLocaleString()}人 / ${BOARDS.map((b, i) => `${b}:${at500[i]}`).join(' ')}`);

  // 逆向き: 100行を超えて作らない（作っても公開側で捨てられるだけ・無駄な計算）。
  const over = [];
  for (const scale of [500, 2000]) {
    setLiveScale(scale);
    for (const b of BOARDS) if (rowsOf(b) > BOARD_MAX_ROWS) over.push(`${b}=${rowsOf(b)}`);
  }
  check(`${BOARD_MAX_ROWS}行を超える行は作らない`, over.length === 0, over.join(' '));

  // にぎわいONなら、どんなに小さい世界でもボードが空にはならない。
  const empty = [];
  for (const scale of [0.01, 0.1, 0.5]) {
    setLiveScale(scale);
    for (const b of BOARDS) if (rowsOf(b) < 1) empty.push(`×${scale} ${b}`);
  }
  check('にぎわいONならボードが空にならない（最小倍率でも1行以上）', empty.length === 0, empty.join(' '));
}

// ---------------------------------------------------------------------------
// ② 倍率を下げたら行数も下がる（別の頭打ちに置き換えていないか）
// ---------------------------------------------------------------------------
{
  // 頭打ち（100行）に届いていない帯で、厳密に単調であること。
  // weekly は基準18行でいちばん過疎なので、いちばん長く頭打ちの外に居る。
  const scales = [8, 4, 2, 1, 0.5, 0.25, 0.1];
  const weekly = scales.map(s => { setLiveScale(s); return boardRowCount('weekly'); });
  const strictlyDown = weekly.every((n, i) => i === 0 || n < weekly[i - 1]);
  check('倍率を下げると行数も下がる（ウィークリー・頭打ちの外）', strictlyDown,
    scales.map((s, i) => `×${s}:${weekly[i]}`).join(' → '));

  // 全ボードの合計でも減る一方であること（どこかの板だけ逆行しない）。
  const totals = scales.map(s => { setLiveScale(s); return BOARDS.reduce((a, b) => a + boardRowCount(b), 0); });
  check('全ボードの合計行数も単調に減る', totals.every((n, i) => i === 0 || n < totals[i - 1]),
    totals.join(' → '));

  // 回帰防止: 旧式は `Math.min(scale, 2.5)` で、×2.5 を超えると行数が
  // 1行も増えなかった。倍率が2桁変わって行数が同じ、が二度と起きないこと。
  setLiveScale(2.5); const w25 = boardRowCount('weekly');
  setLiveScale(100); const w100 = boardRowCount('weekly');
  check('×2.5 で頭打ちにならない（旧式の再発防止）', w100 > w25, `×2.5:${w25}行 → ×100:${w100}行`);

  // にぎわいOFF は従来どおり住人を1人も出さない。
  setLiveScale(0);
  check('にぎわいOFF（×0）は全ボード0行', allRows().every(n => n === 0) && boardFill() === 0, '');
  check('にぎわいOFF（×0）の mood は off', crowdMood(PEAK_JST).id === 'off', '');
}

// ---------------------------------------------------------------------------
// ③ 同じ日なら同じ値（既存の約束を壊していない）
// ---------------------------------------------------------------------------
{
  for (const scale of [1, 500]) {
    setLiveScale(scale);
    const drift = [];
    for (const b of BOARDS) {
      // 顔ぶれ（住人サブセット）
      const a = boardResidents(b, 'W100', PEAK_JST).map(r => r.id).join(',');
      const c = boardResidents(b, 'W100', PEAK_JST - 9 * 3600000).map(r => r.id).join(',');   // 同日12時
      if (a !== c) drift.push(`${b}:顔ぶれ`);
      // 行そのもの（値まで込み）
      const ra = JSON.stringify(ghostRows(b, 'W100', new Set(), PEAK_JST));
      const rc = JSON.stringify(ghostRows(b, 'W100', new Set(), PEAK_JST - 9 * 3600000));
      if (ra !== rc) drift.push(`${b}:値`);
    }
    check(`×${scale} 同じJST日なら顔ぶれも値も動かない`, drift.length === 0, drift.slice(0, 4).join(' '));
  }

  // 行数が時刻に依存しないこと（ambientOnline(now) で決めると深夜に
  // ランキングから住人が消える ── 行数は「世界の大きさ」で決めるという約束）。
  setLiveScale(500);
  const day = allRows(PEAK_JST).join(',');
  const night = allRows(NIGHT_JST).join(',');
  check('行数は時刻で動かない（深夜にランキングが縮まない）', day === night, `21時 ${day} / 04時 ${night}`);

  // 名前の重複が無いこと（100行に増やしたので、住人が枯れて埋め草と
  // 衝突していないかをここで押さえる）。
  const dupes = [];
  for (const scale of [1, 5, 500]) {
    setLiveScale(scale);
    for (const b of BOARDS) {
      const rows = ghostRows(b, 'W100', new Set(), PEAK_JST);
      if (new Set(rows.map(r => r.username)).size !== rows.length) dupes.push(`×${scale} ${b}`);
    }
  }
  check('どのボードにも同じ名前が2度出ない', dupes.length === 0, dupes.join(' '));
}

// ---------------------------------------------------------------------------
// ④ にぎわいの札（mood）が人数と一緒に動く
// ---------------------------------------------------------------------------
{
  const at = h => Date.UTC(2026, 8, 1, (h - 9 + 24) % 24, 0);
  const dayOf = scale => { setLiveScale(scale); return Array.from({ length: 24 }, (_, h) => crowdMood(at(h)).id); };

  // ×1 の1日は従来どおり calm / busy / party が全部出る（基準を変えていない）。
  const d1 = dayOf(1);
  check('×1 の1日に calm / busy / party が全部出る（従来どおり）',
    new Set(d1).size === 3, d1.join(''));

  // 大きい世界で party に貼り付かない。旧式は ×500 で24時間中19時間 party、
  // ×2000 では calm が一度も出なかった ＝ オンライン人数が1/10まで落ちる
  // 深夜も札は「大盛況」のまま固まっていた。
  for (const scale of [88, 500, 2000]) {
    const d = dayOf(scale);
    const party = d.filter(x => x === 'party').length;
    check(`×${scale} で mood が party に貼り付かない（24時間中${party}時間）`, party <= 12, d.join(''));
  }

  // 人数の増減と同じ向きに動く（深夜は夜より必ず静か）。
  const wrong = [];
  for (const scale of [1, 88, 500, 2000]) {
    setLiveScale(scale);
    const rank = { calm: 0, busy: 1, party: 2, off: -1 };
    const nightId = crowdMood(at(4)).id, peakId = crowdMood(at(21)).id;
    if (!(ambientOnline(at(4)) < ambientOnline(at(21)) && rank[nightId] < rank[peakId])) {
      wrong.push(`×${scale} 04時=${nightId} / 21時=${peakId}`);
    }
  }
  check('深夜の札は必ずピーク時より静か（人数と同じ向き）', wrong.length === 0, wrong.join(' / '));
}

// ---------------------------------------------------------------------------
// ⑤ 人数から出す係数が人数で伸びる（battle.js へ渡す口）
// ---------------------------------------------------------------------------
{
  // 発言の速さ。旧 popFactor は上限4で、×20 以上はどれだけ人を増やしても
  // まったく同じ速さだった（×20 も ×2000 も 1時間に320発）。
  const pace = s => { setLiveScale(s); return crowdPace(PEAK_JST); };
  const p1 = pace(1), p20 = pace(20), p500 = pace(500), p2000 = pace(2000);
  check('発言の速さが人数で伸び続ける（×20 と ×2000 が同じ値でない）',
    p2000 > p500 && p500 > p20 && p20 > p1, `×1:${p1.toFixed(2)} ×20:${p20.toFixed(2)} ×500:${p500.toFixed(2)} ×2000:${p2000.toFixed(2)}`);
  check('発言の速さに上限がある（読めない速さにしない）', p2000 <= MAX_CROWD_PACE, `${p2000.toFixed(2)} ≦ ${MAX_CROWD_PACE}`);
  // 深夜は静か（倍率が高くても時間帯の起伏が消えない）。旧式は ×500 だと
  // 深夜でも上限4に張り付き、午前4時が21時と同じ速さで喋っていた。
  setLiveScale(500);
  check('倍率が高くても深夜は静か', crowdPace(NIGHT_JST) < crowdPace(PEAK_JST) / 2,
    `04時 ${crowdPace(NIGHT_JST).toFixed(2)} / 21時 ${crowdPace(PEAK_JST).toFixed(2)}`);

  // 席が埋まるまでの時間。人が多いほど短く、ただし0にはしない。
  const wait = s => { setLiveScale(s); return matchWaitMs(4000, 5000, () => 0.5); };
  const w02 = wait(0.2), w1 = wait(1), w20 = wait(20), w500 = wait(500);
  check('人が多いほど席が早く埋まる', w02 > w1 && w1 > w20 && w20 >= w500,
    `×0.2:${w02}ms ×1:${w1}ms ×20:${w20}ms ×500:${w500}ms`);
  check('席が埋まるまでの下限を割らない（0秒成立で正体が割れない）',
    w500 >= MATCH_WAIT_FLOOR_MS, `${w500}ms ≧ ${MATCH_WAIT_FLOOR_MS}ms`);
  check('×1 の待ち時間は従来どおり（4〜9秒の真ん中 = 6.5秒）', w1 === 6500, `${w1}ms`);
}

// ---------------------------------------------------------------------------
// ⑥ 速さ（ランキングは頻繁に叩かれる。100行に増やしたぶんの検算）
// ---------------------------------------------------------------------------
{
  setLiveScale(500);
  ghostRows('score', 'W100', new Set(), PEAK_JST);      // 名簿のキャッシュを温める
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) for (const b of BOARDS) ghostRows(b, 'W100', new Set(), PEAK_JST);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  check('×500 で全8ボードぶんの行生成が20ms未満', ms < 20, `${ms.toFixed(2)}ms / 8ボード`);
}

// ---------------------------------------------------------------------------
// ⑦ 「作ったのに誰も使っていない」を止める（配線の検査）
// ---------------------------------------------------------------------------
//
// 上の ⑤ は crowdPace / matchWaitMs の**式**が正しいことしか見ていない。
// 式が正しくても battle.js が呼んでいなければ、実際のロビーは前のまま
// ── 数字だけ直って世界は何も変わらない、といういちばん質の悪い直り方をする。
// 実際にこの2つは第7波で「ambient.js に置いたが battle.js が採用しなかった」
// 状態で1度コミット手前まで来た。ソースを読んで接続そのものを見張る。
{
  const fs = await import('fs');
  const path = await import('path');
  const url = await import('url');
  const root = path.dirname(url.fileURLToPath(import.meta.url));
  const battle = fs.readFileSync(path.join(root, '..', 'server', 'battle.js'), 'utf8');
  // ⚠ コメントを外してから見る。「なぜ置き換えたか」の説明文には**旧式がそのまま
  //   引用されている**（それが読み手に要る情報なので消せない）ので、素の
  //   ソースに当てると説明文のほうを実コードと読み違えて赤くなる。
  const battleCode = battle.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  check('battle.js が ambient.js から crowdPace / matchWaitMs を取り込んでいる',
    /import\s*\{[\s\S]*?crowdPace[\s\S]*?\}\s*from\s*'\.\/ambient\.js'/.test(battleCode)
    && /import\s*\{[\s\S]*?matchWaitMs[\s\S]*?\}\s*from\s*'\.\/ambient\.js'/.test(battleCode), '');

  // 発言・フィードの間隔が crowdPace 由来か。旧式の clamp が残っていたら赤。
  const oldClamp = /Math\.min\(\s*4\s*,\s*popFactor\(\)\s*\)/.test(battleCode);
  check('ロビーの発言間隔に旧 popFactor の上限4が残っていない', !oldClamp,
    oldClamp ? 'Math.min(4, popFactor()) が残っている' : '');
  const gapUses = [...battleCode.matchAll(/const gap = Math\.max\(chatFloorMs\([^)]*\),[^;]*;/g)].map(m => m[0]);
  check('発言・フィードの間隔がどちらも群衆の勢いで割られている',
    gapUses.length === 2 && gapUses.every(g => /crowdDiv\(\)|crowdPace\(/.test(g)), `${gapUses.length}箇所`);

  // 席が埋まるまで。固定値の式が復活していないか。
  for (const [name, fn] of [['duelBotWait', /const duelBotWait = \(\) => ([^;]+);/],
    ['teamBotWait', /const teamBotWait = \(\) => ([^;]+);/],
    ['coopBotWait', /const coopBotWait = \(\) => ([^;]+);/]]) {
    const m = battleCode.match(fn);
    check(`${name} が matchWaitMs から出ている`, !!m && /matchWaitMs\(/.test(m[1]), m ? m[1].trim() : '見つからない');
  }

  // ⚠ crowdPace() は ×0 で 0 を返す。除数にするなら下限が要る（0除算で gap が
  //   Infinity になり、setTimeout が 1ms に丸めてタイマーが空回りする）。
  const div = battleCode.match(/const crowdDiv = \(\) => ([^;]+);/);
  check('群衆の勢いで割るときに下限がある（×0 で 0除算しない）',
    !!div && /Math\.max\(\s*0?\.5\s*,/.test(div[1]), div ? div[1].trim() : 'crowdDiv が無い');
  // 式ではなく挙動でも確かめる: にぎわいOFF でも間隔が有限であること。
  setLiveScale(0);
  const offGap = 20000 / 1 / Math.max(0.5, crowdPace(PEAK_JST));
  check('にぎわいOFF でも発言間隔が有限（Infinity にならない）',
    Number.isFinite(offGap) && offGap > 0, `${Math.round(offGap)}ms`);
}

setLiveScale(1);
void effectiveScale;
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
