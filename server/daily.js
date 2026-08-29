// ---------------------------------------------------------------------------
// 📅 デイリーチャレンジの「その日の事実」を決める唯一の場所。
//
// お題・目標点・シードは日付から決定的に出す（全員同じ）。この表が
// server/index.js の中だけにあったころ、住人のスコアを作る residents.js は
// お題を知りようがなく、「極小の日（人間の理論値は約7千点）に住人が2万点」
// という不可能な行が並んでいた。表をここに出して両方から読ませる。
// ---------------------------------------------------------------------------

import { jstDayKey } from './adminevent.js';

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
