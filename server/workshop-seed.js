// 🛠 パズル工房の初期ステージ
//
// 工房が0件だと「まだ誰も投稿していません」しか出ず、遊び方も伝わらない。
// 開店祝いに住人が置いていった数ステージを、**工房がまだ空のときだけ** 入れる。
//
// ここにあるのは「素材」だけ。実際に db へ積むのは routes/workshop.js の
// seedWorkshopStages() で、そのとき **投稿と同じ verifyWorkshopClear() を通す**。
// つまり初期ステージも「サーバーが再生してクリアできたもの」しか公開されない
// ── engine.js の規則が将来変わって解けなくなったステージは、静かに落ちる
// （解けないステージが並ぶくらいなら、少ないほうがまし）。
//
// 盤面は8行の文字列で書く。1文字＝1マスで
//   '.' = 空 / '1'〜'9' = 通常色・お邪魔 / 'a' = ❄️氷結(10) / 'b' = ひび割れ(11)
// ピースは public/js/engine.js の SHAPES の番号。solution は作者の模範解答
// （h = 手札の枠 0..2 / r,c = 置く左上）。
//
// ⚠ 作者は ambient.js の住人ロスターに実在する住人。id で引き直すので、
//   管理者がロスターの seed を変えていれば、そのときの同じ席の住人の名前になる。

import { getRoster } from './ambient.js';

// 初期ステージの版。文面や中身を入れ替えたくなったらここを上げる…のではなく、
// **1度入れたら二度と自動では触らない**（住人の投稿も、人が押した♡も、
// 起動のたびに上書きされてはたまらない）。この数字は「どの版を入れたか」の
// 記録専用で、db.meta.workshop.seedRev に残る。
export const WORKSHOP_SEED_REV = 1;

// 難易度は表示しない（工房のデータ構造に難易度欄が無い）。par で伝わる。
export const WORKSHOP_SEED_STAGES = [
  {
    // やさしい: 2×2 をはめると2行が同時に消える。工房の「はじめの1問」。
    code: 'K7RMDA',
    title: 'ふたつ並べて',
    titleEn: 'Two at Once',
    resident: { id: 'r0', name: 'ヨシキ42' },
    art: [
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '333333..',
      '333333..',
    ],
    pieces: [9, 0, 1],
    solution: [{ h: 0, r: 6, c: 6, t: 3400 }],
    likes: 12, plays: 41, at: Date.UTC(2026, 7, 19, 11, 20),
  },
  {
    // やさしい〜ふつう: 見た目は派手だが置き場所は1か所。3×3で6ライン。
    code: 'T6BFQ2',
    title: 'かどから六本',
    titleEn: 'Six from the Corner',
    resident: { id: 'r3', name: 'マグロ' },
    art: [
      '777.....',
      '777.....',
      '777.....',
      '777.....',
      '777.....',
      '...55555',
      '...55555',
      '...55555',
    ],
    pieces: [12, 0, 1],
    solution: [{ h: 0, r: 5, c: 0, t: 5200 }],
    likes: 17, plays: 36, at: Date.UTC(2026, 7, 21, 4, 5),
  },
  {
    // ふつう: 1手目で行はそろうが❄️氷結が止める。もう1手どこかに置いて
    // 判定をやり直させる、というのに気づけるかどうかの問題。
    code: 'P9VTKC',
    title: '氷をわる',
    titleEn: 'Crack the Ice',
    resident: { id: 'r17', name: 'まったり勢' },
    art: [
      '........',
      '........',
      '........',
      '........',
      '666a666.',
      '........',
      '........',
      '........',
    ],
    pieces: [0, 0, 3],
    solution: [{ h: 0, r: 4, c: 7, t: 6100 }, { h: 1, r: 0, c: 0, t: 12800 }],
    likes: 14, plays: 27, at: Date.UTC(2026, 7, 22, 12, 40),
  },
  {
    // ふつう: 1手目は何も消えない。ためてから一気に3行。
    code: 'M4XJZE',
    title: 'ためて、いっき',
    titleEn: 'Save It Up',
    resident: { id: 'r9', name: 'パズル王84' },
    art: [
      '........',
      '........',
      '........',
      '........',
      '........',
      '222.....',
      '222.....',
      '222.....',
    ],
    pieces: [12, 11, 0],
    solution: [{ h: 0, r: 5, c: 3, t: 4700 }, { h: 1, r: 5, c: 6, t: 9900 }],
    likes: 8, plays: 22, at: Date.UTC(2026, 7, 24, 9, 55),
  },
  {
    // ふつう: 段差に合う長さを選んで4連鎖。手札3枚の補充順も少しだけ効く。
    code: 'H3NQWB',
    title: 'かいだん',
    titleEn: 'Staircase',
    resident: { id: 'r4', name: 'サナ' },
    art: [
      '........',
      '........',
      '........',
      '........',
      '4444....',
      '44444...',
      '444444..',
      '4444444.',
    ],
    pieces: [5, 3, 1, 0],
    solution: [
      { h: 2, r: 6, c: 6, t: 4300 }, { h: 2, r: 7, c: 7, t: 8800 },
      { h: 1, r: 5, c: 5, t: 13200 }, { h: 0, r: 4, c: 4, t: 17600 },
    ],
    likes: 9, plays: 33, at: Date.UTC(2026, 7, 21, 23, 30),
  },
  {
    // むずかしい: 同じ1マスに二度置く。1手目で行は消えるが列は凍るだけ、
    // 空いた同じマスをもう一度埋めて今度は列を落とす。
    code: 'D8LSYK',
    title: '氷の壁',
    titleEn: 'The Ice Wall',
    resident: { id: 'r23', name: '深夜のブロッカー' },
    art: [
      '.......1',
      '.......1',
      '.......1',
      '.......a',
      '.......1',
      '.......1',
      '.......1',
      '1111111.',
    ],
    pieces: [0, 0, 1],
    solution: [{ h: 0, r: 7, c: 7, t: 7500 }, { h: 1, r: 7, c: 7, t: 15400 }],
    likes: 11, plays: 15, at: Date.UTC(2026, 7, 26, 15, 10),
  },
  {
    // むずかしい: 5手。長さの違う棒を、合う段に配り切るまで気が抜けない。
    code: 'W5GHNP',
    title: '大掃除',
    titleEn: 'Big Sweep',
    resident: { id: 'r27', name: 'コンボマスター' },
    art: [
      '8888888.',
      '........',
      '888888..',
      '........',
      '88888...',
      '........',
      '8888....',
      '888.....',
    ],
    pieces: [0, 1, 3, 5, 7],
    solution: [
      { h: 0, r: 0, c: 7, t: 5100 }, { h: 1, r: 2, c: 6, t: 11000 },
      { h: 2, r: 4, c: 5, t: 16700 }, { h: 0, r: 6, c: 4, t: 22400 },
      { h: 1, r: 7, c: 3, t: 28900 },
    ],
    likes: 6, plays: 19, at: Date.UTC(2026, 7, 27, 6, 45),
  },
];

// 8行の文字列 → 64要素の盤面。読めない字が1つでもあれば null。
const ART_CHARS = { '.': 0, a: 10, b: 11 };
export function expandSeedBoard(art) {
  if (!Array.isArray(art) || art.length !== 8) return null;
  const board = [];
  for (const row of art) {
    if (typeof row !== 'string' || row.length !== 8) return null;
    for (const ch of row) {
      const v = ch in ART_CHARS ? ART_CHARS[ch] : Number(ch);
      if (!Number.isInteger(v) || v < 0 || v > 11) return null;
      board.push(v);
    }
  }
  return board;
}

// 作者名。住人ロスターから id で引き直し、admin がその席を消していれば
// 書いてある名前をそのまま使う（表示が空欄になるほうが困る）。
function residentName(spec) {
  try {
    const found = getRoster().find(r => r && r.id === spec.id);
    if (found && found.name) return String(found.name);
  } catch { /* ロスターが未初期化でも初期ステージは入れる */ }
  return spec.name;
}

// 作者id。実ユーザーのidは crypto.randomUUID() なので、この形と衝突しない。
// db.users には存在しないので workshopView は byName に落ちる（＝住人名が出る）。
// 還元コイン（payWorkshopAuthor）も db.users から引けず 0 になる ── 住人の
// ステージがコインを生まないのは意図どおり。
export function seedAuthorId(residentId) {
  return `resident:${residentId}`;
}

// 「♡を押した人」の控え。likes は likedBy.length で数え直されるので、
// 数だけ入れて配列を空にすると、次に誰かが♡した瞬間に 1 まで落ちる。
// 実在しない不透明なidを likes 個ぶん置いて、数と配列の長さを必ず一致させる。
function seedLikedBy(code, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`resident-like:${code}:${i}`);
  return out;
}

// 積める形に組み立てる。verify は routes/workshop.js の verifyWorkshopClear。
// 検証に落ちたステージは黙って捨てる（onDrop があれば理由を渡す）。
export function buildWorkshopSeedStages(verify, onDrop = null) {
  const out = [];
  for (const s of WORKSHOP_SEED_STAGES) {
    const board = expandSeedBoard(s.art);
    if (!board) { if (onDrop) onDrop(s, 'board'); continue; }
    const verdict = verify(board, s.pieces, s.solution);
    if (!verdict || !verdict.ok) { if (onDrop) onDrop(s, (verdict && verdict.reason) || 'verify'); continue; }
    out.push({
      code: s.code,
      title: s.title,
      titleEn: s.titleEn,
      by: seedAuthorId(s.resident.id),
      byName: residentName(s.resident),
      // 投稿日時は **固定値**。Date.now() から数えると機体ごとに別の値になり、
      // backup.js の合流が「同じ作品か」を by+at で見ているせいで、復元のたびに
      // 同じステージが別コードで増殖する。固定なら必ず1つに畳まれる。
      at: s.at,
      board,
      pieces: s.pieces.slice(),
      solution: s.solution.map(m => ({ h: m.h, r: m.r, c: m.c, t: m.t || 0 })),
      par: verdict.moves,
      score: verdict.score,
      plays: s.plays,
      likes: s.likes,
      likedBy: seedLikedBy(s.code, s.likes),
      seed: true,          // 「開店時に置いたもの」の目印
    });
  }
  return out;
}
