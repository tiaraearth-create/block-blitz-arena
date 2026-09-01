// リポジトリのルートから:  node test/ranks.test.mjs
//
// 段位（ランク帯）の唯一の正解が public/js/ranks.js であることを見張る。
//
// ■ なぜ要るのか
// 同じしきい値が3か所に手書きで複製されていた:
//   ・public/js/dom.js  の rankOf()
//   ・server/battle.js  の RANK_TIERS
//   ・server/residents.js の帯の表
// 3つが一致しているうちは動くが、片方だけ触った瞬間に
// 「画面ではゴールドなのに、サーバーはシルバーとして扱う」が起きる。しかも
// **どのテストも落ちない**（それぞれ自分の表と一致しているので）。
// 実際 ranks.js が8帯になった後も server 側の2つは6帯のままで、レート1900以上の
// 住人が全員「マスター」に丸められていた。
//
// ■ ここで見るもの
//   1. ranks.js の24段に穴も重なりも無いこと
//   2. 旧6帯の境界（0/950/1100/1300/1500/1700）で帯名が変わらないこと
//      ＝ いま遊んでいる人の段位が下がらない
//   3. server が手書きの表を持たず、ranks.js の関数を使っていること（ソース検査）
//   4. 昇格の全体告知が「帯が上がったときだけ」で、往復では繰り返さないこと
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RANK_BANDS, DIVISIONS, rankOf, bandOf, rankLadder } from '../public/js/ranks.js';
import { tierOf } from '../server/residents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---------------------------------------------------------------------------
// 1. 24段に穴も重なりも無い
// ---------------------------------------------------------------------------
{
  const ladder = rankLadder();
  check('1-1 段の総数が 帯×段 と一致する', ladder.length === RANK_BANDS.length * DIVISIONS.length,
    `${ladder.length}段 = ${RANK_BANDS.length}帯 × ${DIVISIONS.length}段`);

  // 隣り合う段が「前の段の max + 1」から始まる（＝穴も重なりも無い）。
  const gaps = [];
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].min !== ladder[i - 1].max + 1) gaps.push(`${ladder[i - 1].label}(…${ladder[i - 1].max}) → ${ladder[i].label}(${ladder[i].min}…)`);
  }
  check('1-2 段のあいだに穴も重なりも無い', gaps.length === 0, gaps.slice(0, 3).join(' / '));
  check('1-3 いちばん下は 0 から始まる', ladder[0].min === 0, `${ladder[0].min}`);
  check('1-4 いちばん上は開いている', ladder[ladder.length - 1].max === Infinity, `${ladder[ladder.length - 1].max}`);

  // どのレートも「ちょうど1つの段」に入る。表と rankOf が食い違っていないこと。
  const bad = [];
  for (let r = 0; r <= 3000; r++) {
    const hit = ladder.filter(x => r >= x.min && r <= x.max);
    if (hit.length !== 1) { bad.push(`${r}pt が ${hit.length}段`); continue; }
    const got = rankOf(r);
    if (got.label !== hit[0].label) bad.push(`${r}pt: rankOf=${got.label} / 表=${hit[0].label}`);
    if (bandOf(r).id !== hit[0].bandId) bad.push(`${r}pt: bandOf=${bandOf(r).id} / 表=${hit[0].bandId}`);
  }
  check('1-5 0〜3000pt のどれもちょうど1段に入り、rankOf / bandOf と一致する',
    bad.length === 0, bad.slice(0, 3).join(' / '));

  // 段位は単調（レートが上がって段位が下がることはない）。
  let inversions = 0;
  let prev = -1;
  for (let r = 0; r <= 3000; r++) {
    const i = ladder.findIndex(x => r >= x.min && r <= x.max);
    if (i < prev) inversions++;
    prev = i;
  }
  check('1-6 レートが上がると段位も上がる（逆転が無い）', inversions === 0, `${inversions}件`);
}

// ---------------------------------------------------------------------------
// 2. 旧6帯の境界で帯名が変わらない ＝ 既存プレイヤーが降格しない
// ---------------------------------------------------------------------------
{
  // 旧実装（v2.33 以前）の帯。ここは意図的に「歴史的な値」を書く ── これは
  // 実装から読む定数ではなく、「過去に配ってしまった段位」という動かせない事実。
  const LEGACY = [
    [0, 'ブロンズ', 'Bronze'], [950, 'シルバー', 'Silver'], [1100, 'ゴールド', 'Gold'],
    [1300, 'プラチナ', 'Platinum'], [1500, 'ダイヤ', 'Diamond'], [1700, 'マスター', 'Master'],
  ];
  const legacyBand = r => {
    let out = LEGACY[0];
    for (const t of LEGACY) if (r >= t[0]) out = t;
    return out;
  };
  const moved = [];
  // 旧実装の最上帯は上が開いていたので、1700以上は「マスター以上」に上がるのは
  // 構わない（昇格は誰も困らない）。降格だけを見る。
  const order = RANK_BANDS.map(b => b.id);
  const legacyIndex = { 'ブロンズ': 0, 'シルバー': 1, 'ゴールド': 2, 'プラチナ': 3, 'ダイヤ': 4, 'マスター': 5 };
  for (let r = 0; r <= 3000; r++) {
    const want = legacyBand(r);
    const got = bandOf(r);
    if (order.indexOf(got.id) < legacyIndex[want[1]]) moved.push(`${r}pt: ${want[1]} → ${got.name}`);
  }
  check('2-1 どのレートでも旧6帯より下がらない（＝降格が起きない）', moved.length === 0, moved.slice(0, 3).join(' / '));

  // 境界そのものが動いていない。
  const shifted = [];
  for (const [min, name, nameEn] of LEGACY) {
    const b = bandOf(min);
    if (b.name !== name || b.nameEn !== nameEn) shifted.push(`${min}pt: ${name} のはずが ${b.name}`);
    if (min > 0 && bandOf(min - 1).name === name) shifted.push(`${min - 1}pt で既に ${name} になっている`);
  }
  check('2-2 旧6帯の境界（0/950/1100/1300/1500/1700）が1ptも動いていない',
    shifted.length === 0, shifted.slice(0, 3).join(' / '));

  // 上に足した2帯が、旧最上帯の外側にあること。
  check('2-3 足した2帯は旧最上帯(1700)より上にある',
    RANK_BANDS.slice(6).every(b => b.min > 1700) && RANK_BANDS.length === 8,
    RANK_BANDS.slice(6).map(b => `${b.name}:${b.min}`).join(', '));
}

// ---------------------------------------------------------------------------
// 3. server が手書きの表を持っていない（＝ ranks.js の関数を使っている）
// ---------------------------------------------------------------------------
{
  const stripComments = s => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const targets = ['server/battle.js', 'server/residents.js'];
  for (const rel of targets) {
    const code = stripComments(read(rel));
    check(`3-1 ${rel} が public/js/ranks.js を import している`,
      /from\s+'\.\.\/public\/js\/ranks\.js'/.test(code), '');
    // 手書きの表の痕跡: しきい値がリテラルとして並んでいないこと。
    const literals = [950, 1100, 1300, 1500, 1700, 1900, 2100]
      .filter(n => new RegExp(`min:\\s*${n}\\b|\\[\\s*${n}\\s*,`).test(code));
    check(`3-2 ${rel} に帯のしきい値が手書きで残っていない`,
      literals.length === 0, literals.length ? `見つかった値: ${literals.join(', ')}` : '');
  }
  // 旧実装の名前がそのまま残っていないか（表を消し忘れの検出）。
  check('3-3 server/battle.js の RANK_TIERS が消えている',
    !/RANK_TIERS/.test(stripComments(read('server/battle.js'))), '');
  check('3-4 server/residents.js の TIERS 表が消えている',
    !/const\s+TIERS\s*=/.test(stripComments(read('server/residents.js'))), '');

  // 実際に同じ答えを返しているか（ソース検査だけだと「import したが使っていない」を見逃す）。
  const diff = [];
  for (let r = 0; r <= 3000; r += 7) {
    const t = tierOf(r);
    const b = bandOf(r);
    if (t.name !== b.name || t.nameEn !== b.nameEn) diff.push(`${r}pt: ${t.name} / ${b.name}`);
  }
  check('3-5 residents.tierOf と ranks.bandOf が同じ答えを返す', diff.length === 0, diff.slice(0, 3).join(' / '));
  // 住人の帯が6帯で止まっていないこと（レート1900超の住人がマスターに丸められていた）。
  check('3-6 レート1900以上がマスターに丸められていない',
    tierOf(1900).name === bandOf(1900).name && tierOf(1900).name !== 'マスター',
    `1900pt → ${tierOf(1900).name}`);
}

// ---------------------------------------------------------------------------
// 4. 昇格アナウンス — 帯が上がったときだけ・往復では繰り返さない
// ---------------------------------------------------------------------------
{
  const code = read('server/battle.js');
  check('4-1 全体告知は帯（band）の移動で判定している',
    /afterTier\.band\.min > beforeTier\.band\.min/.test(code), '');
  check('4-2 どこまで告知したかを stats に残している',
    /me\.stats\.rankAnnounced = afterTier\.band\.min/.test(code)
    && /afterTier\.band\.min > \(Number\(me\.stats\.rankAnnounced\) \|\| 0\)/.test(code), '');
  // 本人向けの表示（tierChange）は24段ぶん出す。
  check('4-3 本人向けの表示は24段ぶん（段が動いたら出す）',
    /if \(afterTier\.min !== beforeTier\.min\)/.test(code), '');
  // 復元で印が落ちないこと（落ちると同じ昇格がもう一度全体配信される）。
  check('4-4 rankAnnounced が復元の合流に入っている',
    /rankAnnounced/.test(read('server/backup.js')), '');
  check('4-5 grindDay（1日の稼ぎの上限カウンタ）も復元の合流に入っている',
    /grindDay/.test(read('server/backup.js')), '');

  // 告知の回数を、実装と同じ規則で数え上げてみる。1700付近を10往復しても
  // 「マスターへの昇格」は1回しか流れないこと。
  const announceMin = RANK_BANDS.find(b => b.id === 'gold').min;
  let announced = 0;
  let mark = bandOf(1000).min;   // 新規アカウント（レート1000）は自分の帯を告知ずみとして始める
  let rating = 1690;
  const step = (next) => {
    const before = bandOf(rating), after = bandOf(next);
    rating = next;
    if (after.min > before.min && after.min >= announceMin && after.min > mark) { mark = after.min; announced++; }
  };
  for (let i = 0; i < 10; i++) { step(1710); step(1690); }
  check('4-6 しきい値を10往復しても全体告知は1回だけ', announced === 1, `${announced}回`);
  // そのうえで、本当に上の帯へ進んだらちゃんと鳴る。
  step(1910);
  check('4-7 さらに上の帯へ上がればちゃんと鳴る', announced === 2, `${announced}回`);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
