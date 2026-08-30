// ---------------------------------------------------------------------------
// 📅 デイリーチャレンジの「その日の事実」を決める唯一の場所。
//
// お題・目標点・シードは日付から決定的に出す（全員同じ）。この表が
// server/index.js の中だけにあったころ、住人のスコアを作る residents.js は
// お題を知りようがなく、「極小の日（人間の理論値は約7千点）に住人が2万点」
// という不可能な行が並んでいた。表をここに出して両方から読ませる。
// ---------------------------------------------------------------------------

import { jstDayKey } from './adminevent.js';
// engine.js はクライアント側のファイルだが中身は純ロジック（DOM を触らない）で、
// server/battle.js も同じように直接 import している。形の定義を二重に持つと
// 「設計図どおりに置いたのにピースの形が違う」という最悪のズレが起きるので、
// ここでも SHAPES を本家から読む（コピーを作らない）。
import { Rng, SHAPES, SIZE } from '../public/js/engine.js';

export { jstDayKey };

export const DAILY_PIECES = 30;    // 1発勝負のピース数（ウィークリーの40より短距離）
export const DAILYC_TARGET = 5000; // クリア基準の基本値 — お題の target 係数で日ごとに変わる
export const DAILYC_COINS = 150;   // クリア報酬の基本値（ストリーク倍率 ×3 まで）
export const DAILYC_GEMS = 8;
// 30ピースの理論値を大きく越える申告の頭打ち。コンボの日の完璧な走りでも
// 6桁前半が限界なので、これを越える数字はボード占拠目的の偽装でしかない。
export const DAILYC_MAX_SCORE = 200000;

// 予約した挑戦の有効期限。30ピースは長くても数分で終わるので、2時間あれば
// 中断を挟んだ人でも十分に足りる。
//
// 期限が必要な理由: 予約だけして走らず、シードを覚えるまで練習で走り込み、
// 最後に取っておいた attemptId で最高記録だけを提出する、という手が通る。
// 日跨ぎ提出（前日の盤面を翌日に出す）で毎日ストリークを稼ぐのも同じ手筋。
// 期限はこれを「予約から2時間ぶん」に押し込めるだけで、根絶はしない —
// 完全に塞ぐには着手そのものをサーバーで再生・検証する必要がある。
export const DAILYC_ATTEMPT_MS = 2 * 60 * 60 * 1000;

// 日替わりのお題。効果の実装はクライアント側（id で引く）。gold だけは
// サーバーが報酬計算で扱う。選択は日付から決定的に出すので全員同じ。
//   target: クリア基準の係数。極小の日は理論上限が~7千点しかないので、
//           5,000のままだと正直に遊んだ全員のストリークが刈られる。
//   ghost:  住人のその日のスコア係数。お題を無視すると「極小の日に2万点」
//           という人間には不可能な数字がボードに並んでしまう。
export const DAILY_MODIFIERS = [
  { id: 'giant',   icon: '🧱', ja: '巨大の日',  en: 'Giant Day',   descJa: '大きいピースしか来ない',            descEn: 'Only big pieces drop',                 target: 1,    ghost: 1.1 },
  { id: 'mini',    icon: '🐜', ja: '極小の日',  en: 'Tiny Day',    descJa: '小さいピースしか来ない',            descEn: 'Only tiny pieces drop',                target: 0.5,  ghost: 0.3 },
  { id: 'combo',   icon: '🔥', ja: '連鎖の日',  en: 'Combo Day',   descJa: 'コンボボーナス2倍',                 descEn: 'Combo bonuses are doubled',            target: 1.2,  ghost: 1.5 },
  { id: 'rainbow', icon: '🌈', ja: '虹の日',    en: 'Rainbow Day', descJa: 'リロールが3回使える',               descEn: 'You get 3 rerolls',                    target: 1,    ghost: 1.05 },
  { id: 'rubble',  icon: '🧊', ja: '瓦礫の日',  en: 'Rubble Day',  descJa: '開幕から瓦礫が積もっている',        descEn: 'The board starts littered with rubble', target: 0.9,  ghost: 0.85 },
  { id: 'gold',    icon: '💰', ja: '黄金の日',  en: 'Golden Day',  descJa: 'クリア報酬のコイン2倍',             descEn: 'Clear rewards pay double coins',       target: 1,    ghost: 1 },
];

export function dailySeed(dayKey) {
  let h = 0;
  const s = `bba-daily-${dayKey}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0) & 0x7fffffff;
}

export function dailyModifierOf(dayKey) {
  return DAILY_MODIFIERS[dailySeed(dayKey) % DAILY_MODIFIERS.length];
}

// その日のクリア基準（100点単位に丸める）。
export function dailyTargetOf(dayKey) {
  return Math.round(DAILYC_TARGET * (dailyModifierOf(dayKey).target || 1) / 100) * 100;
}

// 住人のスコアに掛ける、その日のお題の係数。
export function dailyGhostFactor(now = Date.now()) {
  return dailyModifierOf(jstDayKey(now)).ghost || 1;
}

// 次のJST 0:00 のエポックms — デイリーの締め切り表示に使う。
export function nextJstMidnight(now = Date.now()) {
  return Math.floor((now + 9 * 3600000) / 86400000 + 1) * 86400000 - 9 * 3600000;
}

// ---------------------------------------------------------------------------
// 🧩 ブループリント（設計図パズル）の日替わり生成
//
// 「盤面に薄く映った設計図どおりに、渡されたピースだけで寸分違わず組み上げる」
// 逆パズル。ライン成立で作品が崩れる＝揃えてはいけない、というルールなので
// 設計図そのものに満杯の行・列があってはならない。
//
// 生成は逆算式: 図柄のシルエットを先に決め → それを実ピース（SHAPES）で
// 敷き詰め → 敷き詰めに使ったピースをそのまま手札として配る。ランダムに配って
// 解けるか試す方式だと「その日だけ誰も解けない」が起こりうるので採らない。
// 敷き詰めは 1x1 が SHAPES にある以上どんな連結形でも必ず最後まで進むため、
// 「組めない設計図」は原理的に出てこない。
// ---------------------------------------------------------------------------

// 図柄のシルエット。8行×8文字、'#' が設計図のマス（'.' は空き）。
// 掟: どの行も8マス埋めない／どの列も8マス埋めない（＝完成させてもラインが
// 揃わない）。読みやすさのために絵で持つ。追加するときも同じ掟を守ること —
// 破っていても下の BLUEPRINT_FIGURES で弾かれるだけで落ちはしないが、
// その図柄は永久に出番が無くなる。
const BLUEPRINT_ART = [
  { id: 'heart', icon: '💗', ja: 'ハート', en: 'Heart', rows: [
    '........',
    '.##.##..',
    '#######.',
    '#######.',
    '.#####..',
    '..###...',
    '...#....',
    '........',
  ] },
  { id: 'sword', icon: '🗡️', ja: '剣', en: 'Sword', rows: [
    '........',
    '...##...',
    '...##...',
    '...##...',
    '.######.',
    '...##...',
    '...##...',
    '..####..',
  ] },
  { id: 'crown', icon: '👑', ja: '王冠', en: 'Crown', rows: [
    '........',
    '#..#..#.',
    '#.###.#.',
    '#######.',
    '#######.',
    '#######.',
    '........',
    '........',
  ] },
  { id: 'star', icon: '⭐', ja: '星', en: 'Star', rows: [
    '........',
    '...#....',
    '..###...',
    '#######.',
    '.#####..',
    '..###...',
    '.##.##..',
    '........',
  ] },
  { id: 'tree', icon: '🌲', ja: '木', en: 'Tree', rows: [
    '........',
    '...#....',
    '..###...',
    '.#####..',
    '#######.',
    '.#####..',
    '...#....',
    '...#....',
  ] },
  { id: 'house', icon: '🏠', ja: '家', en: 'House', rows: [
    '........',
    '...##...',
    '..####..',
    '.######.',
    '.######.',
    '.##..##.',
    '.##..##.',
    '........',
  ] },
  { id: 'gem', icon: '💎', ja: '宝石', en: 'Gem', rows: [
    '........',
    '..###...',
    '.#####..',
    '#######.',
    '#######.',
    '.#####..',
    '..###...',
    '........',
  ] },
  { id: 'bolt', icon: '⚡', ja: '稲妻', en: 'Bolt', rows: [
    '....###.',
    '...###..',
    '..###...',
    '.######.',
    '..####..',
    '..###...',
    '.###....',
    '........',
  ] },
];

function cellsOfArt(rows) {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    const line = rows[r] || '';
    for (let c = 0; c < SIZE; c++) if (line[c] === '#') out.push(r * SIZE + c);
  }
  return out;
}

// セル集合に満杯の行・列があるか。設計図の合否判定と、後続の「置いた結果が
// 崩れないか」の確認の両方に使えるように export する。
export function blueprintHasFullLine(cells) {
  const rows = new Array(SIZE).fill(0), cols = new Array(SIZE).fill(0);
  for (const i of cells) { rows[(i / SIZE) | 0]++; cols[i % SIZE]++; }
  return rows.some(n => n >= SIZE) || cols.some(n => n >= SIZE);
}

// 出題に使える図柄だけを残す。掟を破った図柄（＝完成させるとラインが揃う）は
// ここで落ちるので、blueprintFor() が崩れる設計図を返すことはない。
export const BLUEPRINT_FIGURES = BLUEPRINT_ART
  .map(f => ({ id: f.id, icon: f.icon, ja: f.ja, en: f.en, cells: cellsOfArt(f.rows) }))
  .filter(f => f.cells.length > 0 && !blueprintHasFullLine(f.cells));

// 設計図の種。お題（dailySeed）と同じ流儀の文字列ハッシュだが、図柄が
// お題と連動して回ってしまわないように別の接頭辞で取る。
export function blueprintSeed(dayKey) {
  let h = 0;
  const s = `bba-blueprint-${dayKey}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0) & 0x7fffffff;
}

// シルエットを SHAPES だけで過不足なく敷き詰める。毎回「まだ空いている
// 一番若いマス」を必ず覆う置き方の中から選ぶので、置き逃しは起きない。
// 大きいピースを優先しつつ乱数で揺らして、日ごとに手札の顔ぶれを変える。
function tileCells(cells, rng) {
  const free = new Set(cells);
  const out = [];
  while (free.size) {
    let target = Infinity;
    for (const i of free) if (i < target) target = i;
    const tr = (target / SIZE) | 0, tc = target % SIZE;
    const seen = new Set();
    let best = null, bestW = -1;
    for (let si = 0; si < SHAPES.length; si++) {
      const sc = SHAPES[si].cells;
      for (const [ar, ac] of sc) {
        const r0 = tr - ar, c0 = tc - ac;
        if (r0 < 0 || c0 < 0) continue;
        const key = `${si}:${r0}:${c0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let ok = true;
        for (const [dr, dc] of sc) {
          const r = r0 + dr, c = c0 + dc;
          if (r >= SIZE || c >= SIZE || !free.has(r * SIZE + c)) { ok = false; break; }
        }
        if (!ok) continue;
        // 大きさ1段ぶんの差は乱数で覆るが、2段ぶんは覆らない重み付け。
        // 手札が 1x1 だらけの「作業」にならないようにしつつ、日ごとの顔ぶれは変える。
        const w = sc.length * 1.5 + rng.next() * 1.9;
        if (w > bestW) { bestW = w; best = { shape: si, at: [r0, c0] }; }
      }
    }
    // SHAPES に 1x1 がある限りここは通らない。将来 1x1 が消されたときに
    // 静かに壊れないよう、諦めて null を返す（呼び出し側が次の図柄へ移る）。
    if (!best) return null;
    for (const [dr, dc] of SHAPES[best.shape].cells) free.delete((best.at[0] + dr) * SIZE + best.at[1] + dc);
    out.push(best);
  }
  return out;
}

// 配る順が「置く順」そのものだと答えが透けるので混ぜる。どの順でも組めるのは
// 敷き詰めが互いに重ならないから（置く順序は解に影響しない）。
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// その日の設計図。同じ dayKey なら何度呼んでも同じものを返す（全員が同じ図を解く）。
export function blueprintFor(dayKey) {
  const seed = blueprintSeed(dayKey);
  const n = BLUEPRINT_FIGURES.length;
  for (let k = 0; k < n; k++) {
    const fig = BLUEPRINT_FIGURES[(seed + k) % n];
    const rng = new Rng((seed ^ 0x5f3a1c9) >>> 0);
    const laid = tileCells(fig.cells, rng);
    if (!laid) continue;
    shuffleInPlace(laid, rng);
    const pieces = laid.map(p => ({
      shape: p.shape,
      color: SHAPES[p.shape].color,
      cells: SHAPES[p.shape].cells.map(([r, c]) => [r, c]),
      at: [p.at[0], p.at[1]],
    }));
    return {
      dayKey,
      seed,
      id: fig.id,
      icon: fig.icon,
      name: fig.ja,
      nameEn: fig.en,
      cells: fig.cells.slice(),
      cellCount: fig.cells.length,
      pieces,
      pieceCount: pieces.length,
    };
  }
  return null; // 図柄がゼロ件のときだけ。BLUEPRINT_FIGURES が空でない限り起きない。
}

// 設計図の自己点検。テストと、繋ぎ込み側の「おかしなものを出さない」確認用。
// 返り値: { ok, reasons } — reasons は日本語の理由（開発者向け、UIには出さない）。
export function verifyBlueprint(bp) {
  const reasons = [];
  if (!bp) return { ok: false, reasons: ['設計図が空'] };
  if (!bp.cells || !bp.cells.length) reasons.push('マスが空');
  if (blueprintHasFullLine(bp.cells || [])) reasons.push('完成形でラインが揃ってしまう');
  const covered = new Set();
  for (const p of bp.pieces || []) {
    const [r0, c0] = p.at;
    for (const [dr, dc] of p.cells) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) { reasons.push('ピースが盤外にはみ出す'); continue; }
      const i = r * SIZE + c;
      if (covered.has(i)) reasons.push('ピースが重なる');
      covered.add(i);
    }
  }
  const want = new Set(bp.cells || []);
  for (const i of want) if (!covered.has(i)) { reasons.push('設計図に届かないマスがある'); break; }
  for (const i of covered) if (!want.has(i)) { reasons.push('設計図の外に出るマスがある'); break; }
  return { ok: reasons.length === 0, reasons };
}
