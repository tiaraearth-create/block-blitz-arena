#!/usr/bin/env node
// 👁️ 断罪（管理者ゼロ）の数値を、実際のエンジンと実際のAIを走らせて詰める。
//
// なぜ最初にこれを書くか:
// 段のHP・住人の火力・封印の貫通率は、机上で決めると必ず外れる。外し方は
// 2通りしかなく、どちらも致命的:
//   * 軽すぎる → 段1が90秒で割れて、7段が1枠で終わる。緊張が消える
//   * 重すぎる → 30分で1段も割れない。何も起きないイベントになる
// バトルロイヤルのときも、AIの構成をこの方式で詰めてから実装した。
//
// 推測を混ぜないために、火力は**実測**する:
//   public/js/engine.js（本物の盤面）と public/js/ai.js（本物の思考）を
//   そのまま読み込み、住人ボットに実際に30分ぶん打たせてスコアを数える。
//
// 使い方:
//   node scripts/sim-zero.mjs            … 標準（1人/3人/12人/50人）
//   node scripts/sim-zero.mjs --fast     … 実測を1回に減らす（数十秒）
//   node scripts/sim-zero.mjs --tune     … 段HPの候補を何通りか比べる

import { Engine } from '../public/js/engine.js';
import { chooseMove, AI_LEVELS } from '../public/js/ai.js';

const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const TUNE = args.includes('--tune');

// ---------------------------------------------------------------------------
// 調整対象（ここを動かして結果を見る）
// ---------------------------------------------------------------------------

const SLOT_SEC = 30 * 60;          // 1枠 30分
const SLOTS_PER_DAY = 3;           // 18:00 / 19:00 / 21:00

// 段。HP は「点数で削れる7割」と「人間しか割れない3割」の合計。
// 実測して決めた値（--tune の自動探索の結果）。
// もとの設計案は段1=100,000 / 1斬り6% だったが、実際にエンジンとAIを走らせて
// 測ったら住人12体だけで1枠90万点出ることが分かり、7段合計129万点では
// 初心者がソロでも全部割れてしまった（＝緊張がゼロ）。約4倍に上げてある。
const DAN = [
  { n: 1, hp:   400_000, everyMs: 30_000, warnSec: 3.5, cut: 0.0130 },
  { n: 2, hp:   480_000, everyMs: 30_000, warnSec: 3.5, cut: 0.0142 },
  { n: 3, hp:   576_000, everyMs: 26_000, warnSec: 3.5, cut: 0.0153 },
  { n: 4, hp:   692_000, everyMs: 26_000, warnSec: 3.2, cut: 0.0165 },
  { n: 5, hp:   828_000, everyMs: 22_000, warnSec: 3.0, cut: 0.0177 },
  { n: 6, hp:   996_000, everyMs: 22_000, warnSec: 3.0, cut: 0.0188 },
  { n: 7, hp: 1_196_000, everyMs: 18_000, warnSec: 3.0, cut: 0.0200 },
];

const SEAL = 0.30;                 // 人間しか割れない割合
// 断罪を落とすとゼロが回復する（段HP比）。最初のモデルはこれを入れておらず、
// 実装して初めて破綻に気づいた: 2%だと1枠60回落として段HPの120%が回復し、
// 住人の火力が丸ごと消える。ここに入れておけば次からは机上で分かる。
const MISS_HEAL = 0.003;
const TOPOUT_HEAL = 0.010;
const SEATS_BASE = 12;             // 住人ぶんを含めた席数の下限
const SEATS_MAX = 24;
// 人が増えたぶん段を重くする係数と、同時に走る断罪の本数。
// この2つが噛み合っていないと「人が増えるほど進まない」逆転が起きる。
// HPは人数に比例して重くなるのに、斬る側の本数が頭打ちだったのが原因だった。
// 人数スケールも自動探索で決めた。もとの案（HP+35%/人・最大4本）だと、
// HPだけ人数に比例して重くなり斬る側が頭打ちになるので、
// 「人が増えるほど段が進まない」逆転が起きていた。
let HP_PER_EXTRA_HUMAN = 0.20;
let LANE_PER_HUMANS = 3;           // 何人につき断罪1本
let MAX_LANES = 10;

// 席に座る住人の構成。実測した住人の総数64人・同時オンライン14人前後に合わせ、
// ロイヤル(99体)ほど強くはしない。
const SEAT_MIX = [
  { level: 'easy',   weight: 3, moveEvery: 2000 },
  { level: 'normal', weight: 4, moveEvery: 1700 },
  { level: 'hard',   weight: 3, moveEvery: 1350 },
  { level: 'oni',    weight: 1, moveEvery: 1150 },
];

// 人間の断罪成功率。腕前ごとに。ここは実測できないので幅を持たせて全部見る。
const HUMAN_SKILL = [
  { name: '初心者',   cut: 0.35, scorePerMin: 2_600 },
  { name: 'ふつう',   cut: 0.60, scorePerMin: 4_200 },
  { name: '上手い人', cut: 0.85, scorePerMin: 6_500 },
];

// ---------------------------------------------------------------------------
// 実測: 本物のエンジン＋本物のAIを走らせて、1分あたりのスコアを測る
// ---------------------------------------------------------------------------

// 決定的な乱数（実行ごとに結果が揺れると調整にならない）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1体を minutes 分だけ実際に打たせる。トップアウトしたら復活して続ける
// （本番も60秒後に自動復帰する）。返すのは合計スコア。
function measureBot(level, moveEvery, minutes, seed) {
  const rnd = mulberry32(seed);
  const realRandom = Math.random;
  Math.random = rnd;                       // engine と ai の乱数を固定する
  try {
    let total = 0;
    let e = new Engine();
    const moves = Math.floor((minutes * 60 * 1000) / moveEvery);
    let last = 0;
    for (let i = 0; i < moves; i++) {
      if (e.over) {                        // 復活（本番と同じく盤面を一部消す）
        total += e.score - last;
        e = new Engine();
        last = 0;
        continue;
      }
      const mv = chooseMove(e, level);
      if (!mv) { e.over = true; continue; }
      if (!e.place(mv.index, mv.row, mv.col)) { e.over = true; continue; }
    }
    total += e.score - last;
    return total;
  } finally {
    Math.random = realRandom;
  }
}

function measureAll(minutes) {
  const out = {};
  const runs = FAST ? 1 : 3;
  for (const cfg of SEAT_MIX) {
    let sum = 0;
    for (let r = 0; r < runs; r++) sum += measureBot(cfg.level, cfg.moveEvery, minutes, 1234 + r * 977);
    out[cfg.level] = Math.round(sum / runs / minutes);   // 1分あたり
  }
  return out;
}

// ---------------------------------------------------------------------------
// シミュレーション本体
// ---------------------------------------------------------------------------

// 席は最低でも住人4人ぶんを残す。人間が席を全部埋めてしまうと
// 「住人＝火力」が消えて、段が永久に落ちなくなる。
const MIN_BOT_SEATS = 4;
function seatsFor(humans) {
  return Math.min(SEATS_MAX, Math.max(SEATS_BASE, humans + MIN_BOT_SEATS));
}

// 住人の1分あたり合計火力
function residentDpm(humans, perMin) {
  const seats = seatsFor(humans);
  const botSeats = Math.max(MIN_BOT_SEATS, seats - humans);
  const totalWeight = SEAT_MIX.reduce((a, c) => a + c.weight, 0);
  let dpm = 0;
  for (const cfg of SEAT_MIX) {
    const n = botSeats * (cfg.weight / totalWeight);
    dpm += n * perMin[cfg.level];
  }
  return dpm;
}

function hpFor(dan, humans) {
  return Math.round(dan.hp * (1 + HP_PER_EXTRA_HUMAN * Math.max(0, humans - 1)));
}

// 1日（3枠）を回して、どこまで段が進んだかを返す。
function runDay(humans, skill, perMin, danTable = DAN) {
  let danIdx = 0;
  let dealt = 0;              // いまの段に入れた通常ダメージ
  let cuts = 0;               // いまの段で斬った回数
  const log = [];
  let idleSec = 0, liveSec = 0;

  for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
    let t = 0;
    let nextVerdict = 25;     // 最初の断罪は0:25
    const startDan = danIdx;
    let slotCuts = 0, slotMiss = 0;
    // 点が満タンで封印待ちの秒数（住人の火力が無意味になっている時間）

    while (t < SLOT_SEC && danIdx < danTable.length) {
      const dan = danTable[danIdx];
      const hp = hpFor(dan, humans);
      const softCap = hp * (1 - SEAL);          // 点数で削れる上限
      const step = 1;                            // 1秒刻み
      t += step;

      // --- 火力（住人＋人間）---
      const dpmR = residentDpm(humans, perMin);
      const dpmH = humans * skill.scorePerMin;
      dealt = Math.min(softCap, dealt + (dpmR + dpmH) / 60);

      // --- 断罪 ---
      if (t >= nextVerdict) {
        nextVerdict = t + dan.everyMs / 1000;
        // 人が多いと同時に複数本走る（4人ごとに1本、最大4本）
        const lanes = Math.max(1, Math.min(MAX_LANES, Math.ceil(humans / LANE_PER_HUMANS)));
        for (let l = 0; l < lanes && l < Math.max(1, humans); l++) {
          if (Math.random() < skill.cut) { cuts++; slotCuts++; }
          else {
            slotMiss++;
            // 落とすとゼロが回復する ＝ 点で削った分が戻る
            dealt = Math.max(0, dealt - hp * MISS_HEAL / lanes);
          }
        }
      }

      // 点が上限に張り付いているのに封印が割れていない = 火力が無意味な時間
      if (dealt >= softCap - 0.5) idleSec += step; else liveSec += step;

      // --- 段が落ちるか ---
      const sealBroken = cuts * dan.cut >= SEAL;
      if (dealt >= softCap - 0.5 && sealBroken) {
        log.push({ slot: slot + 1, dan: dan.n, at: Math.round(t) });
        danIdx++; dealt = 0; cuts = 0;
      }
    }
    log.push({ slot: slot + 1, endDan: danIdx + 1, gained: danIdx - startDan, cuts: slotCuts, miss: slotMiss });
  }
  return { reached: danIdx, log, idleSec, liveSec };
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

const bar = (n, max, w = 22) => {
  const f = Math.round((n / max) * w);
  return '█'.repeat(Math.max(0, f)) + '░'.repeat(Math.max(0, w - f));
};

console.log('');
console.log('👁️  断罪 ── 数値シミュレーション');
console.log('   本物のエンジンと本物のAIを実際に走らせて火力を測っています');
console.log('');

const MEASURE_MIN = FAST ? 2 : 5;
process.stdout.write(`   住人の火力を実測中（${MEASURE_MIN}分 × ${FAST ? 1 : 3}回 × 4段階）… `);
const t0 = Date.now();
const perMin = measureAll(MEASURE_MIN);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}秒`);
console.log('');
console.log('   ── 住人ボット1体あたりの実測火力（1分） ──');
for (const cfg of SEAT_MIX) {
  const v = perMin[cfg.level];
  console.log(`     ${AI_LEVELS[cfg.level].name.padEnd(4)} (${cfg.level.padEnd(6)}) ${String(v).padStart(6)} 点/分  ${bar(v, 9000)}`);
}
console.log('');

// 段の構成
console.log('   ── 段の構成 ──');
console.log('     段   HP        点で削れる  封印(人間のみ)  断罪間隔  1斬りの貫通  必要な斬り数');
for (const d of DAN) {
  const need = Math.ceil(SEAL / d.cut);
  console.log(`     ${d.n}   ${String(d.hp).padStart(7)}   ${String(Math.round(d.hp * (1 - SEAL))).padStart(7)}     ${String(Math.round(d.hp * SEAL)).padStart(6)}        ${String(d.everyMs / 1000).padStart(4)}秒     ${(d.cut * 100).toFixed(1)}%        ${need}回`);
}
console.log('');

// 人数ごと
const CASES = [1, 3, 12, 50];
console.log('   ── 1日（30分×3枠）でどこまで進むか ──');
console.log('');
for (const humans of CASES) {
  const seats = seatsFor(humans);
  const bots = Math.max(MIN_BOT_SEATS, seats - humans);
  const seated = Math.min(humans, seats - MIN_BOT_SEATS);
  console.log(`   👤 実プレイヤー ${humans}人  （席${seats} ＝ 人間${seated}${humans > seated ? `(+${humans - seated}人は次の枠へ)` : ""} ＋ 住人${bots}）`);
  for (const skill of HUMAN_SKILL) {
    // 決定的にするため乱数を固定
    const real = Math.random;
    let s = 20260827 + humans * 7;
    Math.random = mulberry32(s);
    const r = runDay(humans, skill, perMin);
    Math.random = real;
    const ok = r.reached >= 2 && r.reached <= 6;
    const total = r.log.filter(x => x.cuts !== undefined);
    const cuts = total.reduce((a, x) => a + x.cuts, 0);
    const miss = total.reduce((a, x) => a + x.miss, 0);
    console.log(`      ${skill.name.padEnd(5)}(斬り率${(skill.cut * 100).toFixed(0)}%)  → 段${r.reached}まで  ${bar(r.reached, 7, 14)} ${ok ? '' : ' ⚠'}  斬${cuts}/落${miss}`);
  }
  console.log('');
}

console.log('   ── 判定 ──');
console.log('     ねらい: 1日で 段2〜6。7段全部は「断罪をほぼ完璧に斬った日」だけ。');
console.log('     ⚠ が付いた行は、軽すぎる(段7到達)か重すぎる(段1止まり)。');
console.log('');

if (TUNE) {
  // 段HPと1斬りの貫通率を自動で探す。
  // ねらい: ふつうの腕前の人が1人で1日回して 段3〜5。
  //         上手い人でも段7は「ほぼ完璧に斬った日」だけ。
  //         初心者でも段2までは行ける（何も起きない日を作らない）。
  console.log('   ── 適正値の自動探索（--tune）──');
  console.log('');
  const score = (idleRatio, rMid, rHi, rBeg) => {
    let p = 0;
    p += Math.abs(rMid - 4) * 3;          // ふつう1人 → 段4 が中心
    p += rHi > 6 ? (rHi - 6) * 4 : 0;     // 上手い人が毎回7段は軽すぎ
    p += rBeg < 2 ? (2 - rBeg) * 4 : 0;   // 初心者が段1止まりは重すぎ
    p += rHi < rMid ? 5 : 0;              // 腕前と結果が逆転したら破綻
    // 点が満タンで封印待ちの時間が長いほど、住人の火力が飾りになる。
    // 3割を超えたら罰する（＝両方が効いている配分を選ばせる）。
    p += idleRatio > 0.30 ? (idleRatio - 0.30) * 30 : 0;
    return p;
  };
  let best = null;
  // 人数スケールも一緒に探す。1人・3人・12人・50人で段の到達が
  // 逆転しないこと（増えるほど不利にならないこと）を条件に入れる。
  const SCALES = [
    { hp: 0.10, per: 3, max: 8 },
    { hp: 0.15, per: 3, max: 8 },
    { hp: 0.15, per: 4, max: 6 },
    { hp: 0.20, per: 3, max: 10 },
    { hp: 0.25, per: 2, max: 12 },
    { hp: 0.35, per: 4, max: 4 },   // 元の設計
  ];
  for (let mult = 2; mult <= 14; mult += 0.5) {
    for (const cut of [0.010, 0.013, 0.016, 0.020, 0.025, 0.030, 0.040]) {
     for (const sc of SCALES) {
      HP_PER_EXTRA_HUMAN = sc.hp; LANE_PER_HUMANS = sc.per; MAX_LANES = sc.max;
      const t = DAN.map((d, k) => ({ ...d, hp: Math.round(d.hp * mult), cut: cut * (1 + k * 0.09) }));
      const run = (skill) => {
        const real = Math.random; Math.random = mulberry32(4242);
        const r = runDay(1, skill, perMin, t); Math.random = real; return r.reached;
      };
      const runFull = (skill) => {
        const real = Math.random; Math.random = mulberry32(4242);
        const r = runDay(1, skill, perMin, t); Math.random = real; return r;
      };
      const fBeg = runFull(HUMAN_SKILL[0]), fMid = runFull(HUMAN_SKILL[1]), fHi = runFull(HUMAN_SKILL[2]);
      const rBeg = fBeg.reached, rMid = fMid.reached, rHi = fHi.reached;
      const idleRatio = fMid.idleSec / Math.max(1, fMid.idleSec + fMid.liveSec);
      // 人数を振って逆転が無いか見る（ふつうの腕前で固定）
      const byCount = CASES.map(h => {
        const real = Math.random; Math.random = mulberry32(4242 + h);
        const r = runDay(h, HUMAN_SKILL[1], perMin, t); Math.random = real; return r.reached;
      });
      let flip = 0;
      for (let k = 1; k < byCount.length; k++) if (byCount[k] < byCount[k - 1]) flip += (byCount[k - 1] - byCount[k]);
      let p = score(idleRatio, rMid, rHi, rBeg);
      p += flip * 6;                       // 人が増えて不利になるのは重い欠陥
      p += Math.abs(byCount[3] - byCount[0]) * 1.5;   // 極端に差がつくのも避ける
      if (!best || p < best.p) best = { p, mult, cut, rBeg, rMid, rHi, idleRatio, sc, byCount };
     }
    }
  }
  console.log(`     いちばん良かった組み合わせ:`);
  console.log(`       段HP  = いまの ×${best.mult}`);
  console.log(`       貫通率 = ${(best.cut * 100).toFixed(1)}% から段ごとに +9%ずつ`);
  console.log(`       → 初心者 段${best.rBeg} ／ ふつう 段${best.rMid} ／ 上手い人 段${best.rHi}`);
  console.log(`       封印待ちの時間 = ${(best.idleRatio * 100).toFixed(0)}%  （低いほど住人の火力が効いている）`);
  console.log(`       人数スケール = HP +${(best.sc.hp * 100).toFixed(0)}%/人 ／ 断罪は${best.sc.per}人につき1本（最大${best.sc.max}本）`);
  console.log(`       人数を振ると（ふつうの腕前）: ${CASES.map((h, k) => `${h}人→段${best.byCount[k]}`).join('  ')}`);
  console.log('');
  HP_PER_EXTRA_HUMAN = best.sc.hp; LANE_PER_HUMANS = best.sc.per; MAX_LANES = best.sc.max;
  const t = DAN.map((d, k) => ({ ...d, hp: Math.round(d.hp * best.mult), cut: best.cut * (1 + k * 0.09) }));
  console.log('     ── この値での段の構成 ──');
  console.log('       段   HP         点で削れる   封印       1斬り   必要な斬り数');
  for (const d of t) {
    const need = Math.ceil(SEAL / d.cut);
    console.log(`       ${d.n}   ${String(d.hp).padStart(8)}   ${String(Math.round(d.hp * (1 - SEAL))).padStart(9)}   ${String(Math.round(d.hp * SEAL)).padStart(7)}   ${(d.cut * 100).toFixed(2)}%   ${String(need).padStart(3)}回`);
  }
  console.log('');
  console.log('     ── この値で人数を振ってみる ──');
  for (const h of CASES) {
    const line = HUMAN_SKILL.map(sk => {
      const real = Math.random; Math.random = mulberry32(4242 + h);
      const r = runDay(h, sk, perMin, t); Math.random = real;
      return `${sk.name}→段${r.reached}`;
    }).join('  ');
    console.log(`       ${String(h).padStart(2)}人:  ${line}`);
  }
  console.log('');
}
