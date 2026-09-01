// リポジトリのルートから:  node test/farming.test.mjs
//
// 「ソロプレイを押してすぐ終了、を繰り返すと簡単にコインやXPが貯まる」
// というユーザーの訴えの回帰テスト。
//
// ■ 何が起きていたか
// 1回の結果送信ごとに付く「固定ぶん」（基礎 20🪙/30bpXp/20accXp と勝利ボーナス）は
// プレイの長さに応じて縮む（paceScale）ようになっていたが、その下限が 0.25 だった。
// つまり **何もせずに終了しても毎回 5🪙 / 8bpXp / 5accXp が必ず入る**。
// 結果送信の上限は250件/時なので、放置で 1,250🪙/時・2,000bpXp/時 が湧く。
//
// ■ 通したい細い道（ここも resultclamp と同じで、両側に失敗がある）
//   ・緩すぎる → 空の結果を投げるだけで貯まる（上の状態）
//   ・厳しすぎる → 既存の realPlay（1,000点以上 かつ 20秒以上）を門にすると、
//     🛠️工房の10秒ステージのような「短いが本物のプレイ」まで0になり、
//     正直に短く遊んだ人の取り分を削ってしまう
// 通した道: 判定は「遊んだ形跡が **無い** こと」だけに絞る（スコアもラインも
// ほぼ動いていない回）。加えて1日あたりの上限を置き、偽の結果の連投を頭打ちにする。
//
// ■ ここで見るもの
//   1. 空の結果を50回投げても 🪙/XP/bpXp が1も増えない（＝ちゃんと処理された上で0）
//   2. 正直な短いプレイ（1,500点・6ライン・12秒）ではちゃんと入る
//   3. 1日あたりの上限に当たると止まる（上限は環境変数で下げて確かめる）
//   4. 既定の上限が「普通に何時間か遊んでも当たらない」高さにある

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-farming-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 上限に当たるところまでを現実的な件数で確かめるため、テストの機体だけ上限を下げる。
// 1試合の上限は 1,000🪙 / 800bpXp / 600accXp なので、2件で当たる高さにしておく。
const TEST_CAP = { coins: 1200, bpXp: 1000, accXp: 800 };

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* empty body */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'farming-test', SEED_RESTORE: '0',
      GRIND_COIN_DAY: String(TEST_CAP.coins),
      GRIND_BPXP_DAY: String(TEST_CAP.bpXp),
      GRIND_ACCXP_DAY: String(TEST_CAP.accXp),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* not up yet */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const wallet = u => ({ coins: u.coins, xp: u.xp, bpXp: u.battlePass.xp, games: u.stats.gamesPlayed });

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const reg = async (name) => {
    const r = await j('/api/register', { method: 'POST', body: { username: name, password: 'pw-farming-1' } });
    if (!r.token) throw new Error(`登録できません: ${JSON.stringify(r)}`);
    return r.token;
  };

  // -------------------------------------------------------------------------
  // 1. 空の結果を50回 — 1🪙も1XPも増えない
  //
  // 結果送信のレート制限は「1人あたり 30件/分」なので、50件を1人で投げると
  // 途中から 429 で弾かれ、「増えなかったのは上限のおかげ」という別の理由でも
  // 緑になってしまう（テストが嘘をつく）。2人に分けて、全50件を **サーバーに
  // 実際に処理させた上で** 0であることを見る。処理されたことは gamesPlayed が
  // 件数ぶん増えたかで確かめる。
  // -------------------------------------------------------------------------
  const EMPTY = { mode: 'solo', score: 0, lines: 0, duration: 1 };
  let sent = 0;
  for (const [name, n] of [['からうち', 30], ['からうち2', 20]]) {
    const tok = await reg(name);
    const before = wallet((await j('/api/me', {}, tok)).user);
    let accepted = 0, gained = 0;
    for (let i = 0; i < n; i++) {
      const r = await j('/api/game/result', { method: 'POST', body: EMPTY }, tok);
      if (r.status === 200) { accepted++; gained += (r.rewards.coins || 0) + (r.rewards.bpXp || 0) + (r.rewards.accXp || 0); }
    }
    sent += accepted;
    const after = wallet((await j('/api/me', {}, tok)).user);
    check(`空の結果 ${n}件がすべて受理された（弾かれて0ではない）`, accepted === n, `${accepted}/${n}件`);
    check(`空の結果 ${n}件はちゃんと1プレイとして数えられている`, after.games - before.games === n, `${after.games - before.games}戦`);
    check(`空の結果 ${n}件で報酬の返り値が全部0`, gained === 0, `合計 ${gained}`);
    check(`空の結果 ${n}件でコインが増えない`, after.coins === before.coins, `${before.coins} → ${after.coins}`);
    check(`空の結果 ${n}件で累計XPが増えない`, after.xp === before.xp, `${before.xp} → ${after.xp}`);
    check(`空の結果 ${n}件でバトルパスXPが増えない`, after.bpXp === before.bpXp, `${before.bpXp} → ${after.bpXp}`);
  }
  check('空の結果を50回投げた', sent === 50, `${sent}件`);

  // -------------------------------------------------------------------------
  // 2. 正直な短いプレイ（工房の短いステージ相当）はちゃんと入る
  // -------------------------------------------------------------------------
  {
    const tok = await reg('しょうじきもの');
    const before = wallet((await j('/api/me', {}, tok)).user);
    const r = await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1500, lines: 6, duration: 12 } }, tok);
    const after = wallet((await j('/api/me', {}, tok)).user);
    check('正直な短いプレイ: コインが入る', r.rewards.coins > 0 && after.coins > before.coins, `+${after.coins - before.coins}🪙`);
    check('正直な短いプレイ: バトルパスXPが入る', r.rewards.bpXp > 0 && after.bpXp > before.bpXp, `+${after.bpXp - before.bpXp}bpXp`);
    check('正直な短いプレイ: 累計XPが入る', r.rewards.accXp > 0 && after.xp > before.xp, `+${after.xp - before.xp}accXp`);
  }

  // 2b. 「1手でも遊べば形跡あり」の境目。1ライン消せば最低でも 8マス×1点＋100点
  // なので、判定の下限（200点）を必ず超える ── 短いプレイが巻き添えで0にならない。
  {
    const tok = await reg('いちらいん');
    const r = await j('/api/game/result', { method: 'POST', body: { mode: 'workshop', score: 108, lines: 1, duration: 8 } }, tok);
    check('1ラインだけ消した超短時間のプレイも0にはならない', r.rewards.coins + r.rewards.bpXp + r.rewards.accXp > 0,
      `${r.rewards.coins}🪙 / ${r.rewards.bpXp}bpXp / ${r.rewards.accXp}accXp`);
  }

  // -------------------------------------------------------------------------
  // 3. 1日あたりの上限に当たると止まる
  //
  // 固定ぶんを0にしても「スコアだけを申告する偽の結果」は残る。1試合の上限
  // （1,000🪙）に毎回張り付く申告を連投して、日次の上限で止まることを見る。
  // -------------------------------------------------------------------------
  {
    const tok = await reg('つみかさね');
    const BIG = { mode: 'solo', score: 120000, lines: 400, duration: 90 };
    const got = [];
    for (let i = 0; i < 4; i++) {
      const r = await j('/api/game/result', { method: 'POST', body: BIG }, tok);
      check(`日次上限テスト ${i + 1}件目が受理された`, r.status === 200, JSON.stringify(r.error || ''));
      got.push({ coins: r.rewards.coins, bpXp: r.rewards.bpXp, accXp: r.rewards.accXp });
    }
    const sum = k => got.reduce((a, x) => a + x[k], 0);
    const me = (await j('/api/me', {}, tok)).user;
    for (const k of ['coins', 'bpXp', 'accXp']) {
      check(`日次上限（${k}）を1枚も超えて配らない`, sum(k) <= TEST_CAP[k], `合計 ${sum(k)} / 上限 ${TEST_CAP[k]}`);
      check(`日次上限（${k}）に当たったら以降は0`, got[got.length - 1][k] === 0, `最後の1件で ${got[got.length - 1][k]}`);
      check(`日次上限（${k}）にちゃんと到達している`, sum(k) === TEST_CAP[k], `合計 ${sum(k)}`);
    }
    check('その日いくら受け取ったかが stats に残る（復元で消えないための記録）',
      !!me.stats.grindDay && typeof me.stats.grindDay.day === 'string'
      && me.stats.grindDay.coins === sum('coins') && me.stats.grindDay.bpXp === sum('bpXp') && me.stats.grindDay.accXp === sum('accXp'),
      JSON.stringify(me.stats.grindDay));
    // 上限に当たっても「遊べなくなる」わけではない（記録・実績は普通に進む）。
    check('上限に当たってもプレイ自体は記録される', me.stats.gamesPlayed === 4, `${me.stats.gamesPlayed}戦`);
  }
} catch (e) {
  check('テストが最後まで走った', false, String((e && e.message) || e));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. 既定の上限の高さ ── ソースから読む（写経しない）
//
// 「普通に何時間か遊んでも当たらない」を機械が見張れる形にする。1試合あたりの
// 上限（Math.min の第1引数）も実装から読み、日次の上限がその何試合ぶんかを数える。
// 100試合ぶんより低くなったら、それは正直なプレイに当たりうる高さ。
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const capOf = (key) => {
    const m = src.match(new RegExp(`${key}:\\s*grindCap\\('[A-Z_]+',\\s*(\\d+)\\)`));
    return m ? Number(m[1]) : NaN;
  };
  const perGame = {
    coins: Number((src.match(/let coins = Math\.min\((\d+),/) || [])[1]),
    bpXp: Number((src.match(/let bpXp = Math\.min\((\d+),/) || [])[1]),
    accXp: Number((src.match(/let accXp = Math\.min\((\d+),/) || [])[1]),
  };
  check('1試合あたりの上限を実装から読めた',
    Object.values(perGame).every(Number.isFinite),
    JSON.stringify(perGame));
  for (const k of ['coins', 'bpXp', 'accXp']) {
    const cap = capOf(k);
    const games = cap / perGame[k];
    check(`既定の日次上限（${k}）が100試合ぶん以上ある`, Number.isFinite(cap) && games >= 100,
      `${cap} = 満額の${Math.round(games)}試合ぶん`);
  }
  // 下限 0.25 そのものは残っていてよい（正直な短いプレイの取り分を守っている）。
  // 消えてはいけないのは「遊んだ形跡が無い回はその手前で0にする」という門のほう。
  // 門を外した書き方（素の Math.max(0.25, …) に戻す）に逆戻りしたら赤くなる。
  check('「遊んだ形跡が無い回」の判定が実装にある', /const idleResult\s*=/.test(src), '');
  check('固定ぶんの倍率がその判定をくぐっている',
    /const paceScale = idleResult \? 0 :/.test(src),
    '素の Math.max(0.25, …) に戻っていないか');
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
