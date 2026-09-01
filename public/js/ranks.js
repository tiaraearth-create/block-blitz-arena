// ---------------------------------------------------------------------------
// ランク帯（段位）— このファイルが唯一の正解
//
// なぜ作ったか
//   同じしきい値が3か所に手書きで複製されていた:
//     ・public/js/dom.js  の rankOf()
//     ・server/battle.js  の RANK_TIERS
//     ・server/residents.js の帯の表
//   3つが一致しているうちは動くが、片方だけ触った瞬間に
//   「画面ではゴールドなのに、サーバーはプラチナとして扱う」が起きる。
//   帯を増やすとなれば触る回数も増えるので、先に1か所へ寄せる。
//
//   サーバーからも読める場所に置くのがポイント。public/js/catalog-en.js を
//   server/catalog.js が import している前例があるので、それに倣う
//   （依存ゼロの素の JS にしておくこと ── DOM も localStorage も触らない）。
//
// 帯の増やし方の方針（v2.34）
//   既存の6帯のしきい値は**1つも動かさない**。上に2帯を足し、
//   各帯を III → II → I の3段に割るだけにする。
//   こうすれば、いま遊んでいる人の段位が下がることが絶対に起きない
//   （降格は、本人が何もしていないのに起きると理不尽そのもの）。
//
//   6帯 → 8帯 × 3段 = 24段。「あと少しでゴールドII」という短い目標が
//   常に見えるので、レートが動いた実感が出る。レートの計算式（Elo・K=32）は
//   一切触らない ── 式を触ると過去の記録の意味が変わる。
// ---------------------------------------------------------------------------

// min は「その帯に入る最低レート」。上端は次の帯の min - 1。
// icon は public/js/icons.js のアイコン名。
//
// ⚠️ 先頭6件のしきい値は歴史的な値。動かすと全プレイヤーの段位が変わるので、
//    変えるときは「誰かが降格しないか」を必ず確かめること。
export const RANK_BANDS = [
  { id: 'bronze',      min: 0,    name: 'ブロンズ',         nameEn: 'Bronze',      icon: 'rank_bronze',      color: '#cd7f32' },
  { id: 'silver',      min: 950,  name: 'シルバー',         nameEn: 'Silver',      icon: 'rank_silver',      color: '#c9d4e4' },
  { id: 'gold',        min: 1100, name: 'ゴールド',         nameEn: 'Gold',        icon: 'rank_gold',        color: '#ffd75e' },
  { id: 'platinum',    min: 1300, name: 'プラチナ',         nameEn: 'Platinum',    icon: 'rank_platinum',    color: '#9fd8ff' },
  { id: 'diamond',     min: 1500, name: 'ダイヤ',           nameEn: 'Diamond',     icon: 'rank_diamond',     color: '#57e0ff' },
  { id: 'master',      min: 1700, name: 'マスター',         nameEn: 'Master',      icon: 'rank_master',      color: '#ff6bd4' },
  { id: 'grandmaster', min: 1900, name: 'グランドマスター', nameEn: 'Grandmaster', icon: 'rank_grandmaster', color: '#b06bff' },
  { id: 'legend',      min: 2100, name: 'レジェンド',       nameEn: 'Legend',      icon: 'rank_legend',      color: '#ff8a5c' },
];

// 各帯を何段に割るか。III が下、I が上（多くの対戦ゲームと同じ向き）。
export const DIVISIONS = ['III', 'II', 'I'];

// 最上位帯は上が開いているので、割り幅を決め打ちにする。
// これを超えたぶんは全部「レジェンド I」。
const TOP_DIVISION_WIDTH = 200;

/** 帯の上端（最上位帯は Infinity）。 */
function bandMax(i) {
  return i + 1 < RANK_BANDS.length ? RANK_BANDS[i + 1].min - 1 : Infinity;
}

/**
 * レートから段位を求める。
 * 返り値:
 *   { id, name, nameEn, icon, color, div, label, labelEn, min, max,
 *     nextAt, toNext, progress }
 *   nextAt … 次の段（II→I や 帯の昇格）に必要なレート。最上位なら null
 *   progress … いまの段の中での進み具合 0..1（ゲージ用）
 */
export function rankOf(rating) {
  const r = Math.max(0, Math.floor(Number(rating) || 0));
  let i = 0;
  for (let k = 0; k < RANK_BANDS.length; k++) if (r >= RANK_BANDS[k].min) i = k;
  const band = RANK_BANDS[i];
  const top = bandMax(i);

  // 段の幅。最上位帯だけは固定幅で、それより上は I に張り付く。
  const width = top === Infinity
    ? TOP_DIVISION_WIDTH
    : Math.max(1, Math.floor((top - band.min + 1) / DIVISIONS.length));

  let step = Math.floor((r - band.min) / width);
  if (step > DIVISIONS.length - 1) step = DIVISIONS.length - 1;
  const div = DIVISIONS[step];

  const divMin = band.min + step * width;
  const divMax = step === DIVISIONS.length - 1 ? top : divMin + width - 1;
  const nextAt = divMax === Infinity ? null : divMax + 1;

  return {
    id: band.id,
    name: band.name,
    nameEn: band.nameEn,
    icon: band.icon,
    color: band.color,
    div,
    // 表示名。「ゴールド II」のように帯と段をつなげる。
    label: `${band.name} ${div}`,
    labelEn: `${band.nameEn} ${div}`,
    min: divMin,
    max: divMax,
    nextAt,
    toNext: nextAt === null ? null : nextAt - r,
    progress: divMax === Infinity ? 1
      : Math.max(0, Math.min(1, (r - divMin) / Math.max(1, divMax - divMin + 1))),
  };
}

/** 帯だけが欲しいとき（アイコン・色）。 */
export function bandOf(rating) {
  const r = Math.max(0, Math.floor(Number(rating) || 0));
  let out = RANK_BANDS[0];
  for (const b of RANK_BANDS) if (r >= b.min) out = b;
  return out;
}

/**
 * ランク一覧画面のための全段リスト（下から上へ）。
 * [{ bandId, name, nameEn, icon, color, div, label, labelEn, min, max }]
 */
export function rankLadder() {
  const out = [];
  for (let i = 0; i < RANK_BANDS.length; i++) {
    const band = RANK_BANDS[i];
    const top = bandMax(i);
    const width = top === Infinity
      ? TOP_DIVISION_WIDTH
      : Math.max(1, Math.floor((top - band.min + 1) / DIVISIONS.length));
    for (let s = 0; s < DIVISIONS.length; s++) {
      const min = band.min + s * width;
      const max = s === DIVISIONS.length - 1 ? top : min + width - 1;
      out.push({
        bandId: band.id,
        name: band.name,
        nameEn: band.nameEn,
        icon: band.icon,
        color: band.color,
        div: DIVISIONS[s],
        label: `${band.name} ${DIVISIONS[s]}`,
        labelEn: `${band.nameEn} ${DIVISIONS[s]}`,
        min,
        max,
      });
    }
  }
  return out;
}
