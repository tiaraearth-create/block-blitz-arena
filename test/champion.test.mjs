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
//   E. 0敗（無敗）であること ＝ ユーザーの明示要求
//   F. 対戦相手として出るときは専用の最強AI（souzou）で、遭遇率が1か所で決まること
//
// ■ E が「少数の負けを持たせる」から「0敗」に変わった理由（v2.35）
// 前の波では「147勝0敗は作り物に見える」と判断して 2% の負けを足していた。
// ユーザーの決定はその逆で、**負けを足して取り繕うのではなく、本当に負けない
// 強さを与えて0敗を実態にする**。強さの裏取りが F。
import {
  buildRoster, residentStats, residentDailyScore, isChampion, CHAMPION,
} from '../server/residents.js';
import {
  boardResidents, ghostRows, setLiveScale, pickChampionBot, pickResidentBot, CHAMPION_ENCOUNTER,
} from '../server/ambient.js';
import { Engine } from '../public/js/engine.js';
import { chooseMove, AI_LEVELS } from '../public/js/ai.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';

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
// E. 0敗（無敗）であること — ユーザーの明示要求
// ---------------------------------------------------------------------------
{
  const roster = buildRoster('v1', 240);
  const champ = roster.find(isChampion);
  const bad = [];
  for (const days of [0, 30, 200, 1000]) {
    const s = residentStats(champ, NOON_JST + days * DAY, 'W100');
    if (s.pvpLosses !== 0) bad.push(`+${days}日: ${s.pvpWins}勝${s.pvpLosses}敗`);
    if (s.pvpWins <= 0) bad.push(`+${days}日: 勝ち数が ${s.pvpWins}`);
  }
  check('E-1 王者は0敗（無敗）', bad.length === 0, bad.join(' / '));
  // 他の住人まで無敗になっていない（＝式ごと壊していない）ことの裏取り。
  const others = roster.filter(r => r.registered && !isChampion(r))
    .map(r => residentStats(r, NOON_JST + 200 * DAY, 'W100'));
  check('E-2 無敗なのは王者だけ（他の住人は負けている）',
    others.some(s => s.pvpLosses > 0), `0敗の住人 ${others.filter(s => s.pvpLosses === 0).length}/${others.length}人`);
  const s0 = residentStats(champ, NOON_JST, 'W100');
  check('E-3 成績は決定論的（同じ日なら同じ）',
    s0.pvpLosses === residentStats(champ, NOON_JST + 60000, 'W100').pvpLosses
    && s0.pvpWins === residentStats(champ, NOON_JST + 60000, 'W100').pvpWins,
    `${s0.pvpWins}勝${s0.pvpLosses}敗`);
}

// ---------------------------------------------------------------------------
// F. 「0敗」を名乗れる実態があること
//    F-1..F-3: 遭遇の入り口が1本だけで、遭遇率が1か所で決まる
//    F-4:      その専用AIが、上手いプレイヤー相当(鬼)に実測で負けない
// ---------------------------------------------------------------------------
{
  setLiveScale(1);
  const realRandom = Math.random;
  try {
    // 必ず当たる引き（0）と、必ず外れる引き（1に近い値）で入り口を確かめる。
    Math.random = () => 0;
    const hit = pickChampionBot(new Set(), NOON_JST);
    check('F-1 遭遇の目が出れば王者が対戦相手として出る',
      !!hit && hit.name === CHAMPION.name, hit ? hit.name : 'null');
    Math.random = () => 0.999999;
    check('F-2 目が出なければ出てこない（＝遭遇率はこの1か所で決まる）',
      pickChampionBot(new Set(), NOON_JST) === null, `rate=${CHAMPION_ENCOUNTER}`);
    // 通常の住人抽選からは、どの強さの帯を引いても王者は出てこない。
    // ここが漏れていると「遭遇率を1か所で決める」という設計が崩れる。
    Math.random = realRandom;
    let leaked = 0;
    for (const level of ['easy', 'normal', 'hard', 'oni']) {
      for (let i = 0; i < 200; i++) {
        const r = pickResidentBot(level, new Set(), NOON_JST);
        if (r && r.name === CHAMPION.name) leaked++;
      }
    }
    check('F-3 通常の住人抽選には王者が混ざらない（800回）', leaked === 0, `漏れ${leaked}件`);
    check('F-3b 遭遇率は0〜1の値で、常時遭遇ではない',
      CHAMPION_ENCOUNTER > 0 && CHAMPION_ENCOUNTER < 0.2, `CHAMPION_ENCOUNTER=${CHAMPION_ENCOUNTER}`);
  } finally {
    Math.random = realRandom;
  }

  // --- F-4 実測: 王者(souzou/380ms) vs 上手いプレイヤー相当(oni/820ms) ---
  // battle.js の Bot.startPlay と同じ回し方（手番間隔の揺らぎ 0.75〜1.25 と
  // 8%の長考、トップアウトしたら盤面リセット）を時計なしで再現する。
  // 手番間隔は写経せず、王者は ai.js の定義から、鬼は battle.js の実装から読む。
  const oniMs = (() => {
    const src = fs.readFileSync(new URL('../server/battle.js', import.meta.url), 'utf8');
    const m = src.match(/BOT_MOVE_MS\s*=\s*\{[^}]*\boni\s*:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  })();
  check('F-4 鬼の手番間隔を実装から読めた', Number.isFinite(oniMs) && oniMs > 0, `oni=${oniMs}ms`);

  const mulberry32 = a => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const play = (level, moveMs, secs, seed, rnd) => {
    const e = new Engine(seed);
    let t = 0;
    while (t < secs * 1000) {
      if (e.over) e.reviveBoard();
      const mv = chooseMove(e, level);
      if (!mv) break;
      e.place(mv.index, mv.row, mv.col);
      t += moveMs * (0.75 + rnd() * 0.5) + (rnd() < 0.08 ? 1200 + rnd() * 2200 : 0);
    }
    return e.score;
  };
  // 王者の手番間隔は **battle.js の CHAMPION_MOVE_MS** を読む。
  // ai.js の souzou.moveMs（380ms）ではない ── 380ms は毎秒2.6手で、
  // 2分間これを続けられる人間が居ないため「速すぎてボットだと分かる」。
  // 強さは速さではなく手の質で作る、というのがこの設定の要点なので、
  // テストも実装が実際に使う値で測らないと意味が無い。
  const champMs = (() => {
    const src = fs.readFileSync(new URL('../server/battle.js', import.meta.url), 'utf8');
    const m = src.match(/CHAMPION_MOVE_MS\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  })();
  check('F-4b 王者の手番間隔を実装から読めた', Number.isFinite(champMs) && champMs > 0, `champion=${champMs}ms`);

  // ★ 正体がバレない速さであること。
  //   実効の間隔はゆらぎ（0.75〜1.25倍）と8%の長考が乗るので、
  //   基準 600ms でも毎秒 約1.3手。これを超えて速くすると人間には届かなくなる。
  //   ここを緩めると「0敗にしたい」という要望のために速度を上げる誘惑に
  //   負けやすいので、下限として固定しておく。
  check('F-4c 王者の手番間隔が人間に届く範囲（600ms以上）', champMs >= 600,
    `${champMs}ms ＝ 生の毎秒 ${(1000 / champMs).toFixed(2)} 手`);

  const SECS = 60, RUNS = 24;
  let wins = 0, champScores = [], oniScores = [];
  for (let i = 0; i < RUNS; i++) {
    const seed = 1000 + i * 7919;
    const a = play('souzou', champMs, SECS, seed, mulberry32(seed));
    const b = play('oni', oniMs, SECS, seed, mulberry32(seed + 1));
    if (a > b) wins++;
    champScores.push(a);
    oniScores.push(b);
  }
  // 人間の速さに合わせた以上、全勝にはならない（実測 60秒で 91.7% / 120秒で 95.0%）。
  // このゲームはスコアがほぼ手数で決まり、souzou の思考が上乗せするのは1手あたり
  // 約7%しかないため、「人間の速度で絶対に負けない」は原理的に作れない。
  // ユーザーの決定は「速さを人間の範囲に収め、戦績は実態に合わせる」。
  // ここで見るのは「圧倒的に強いが、超人ではない」という位置づけ。
  const rate = wins / RUNS;
  check(`F-5 ${SECS}秒×${RUNS}戦で王者が圧倒（勝率85%以上）`, rate >= 0.85,
    `${wins}/${RUNS}勝 = ${(rate * 100).toFixed(1)}%`);
  // 「たまたま勝った」ではなく「地力の差」であることを中央値で見る。
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const cm = med(champScores), om = med(oniScores);
  check('F-6 王者の中央値が鬼の1.15倍以上', cm >= om * 1.15, `王者 ${cm} / 鬼 ${om}（${(cm / om).toFixed(2)}倍）`);

  // 専用AIを使う配線が battle.js に残っていること（レベル名の写経ではなく、
  // ai.js に実在する段であることまで見る）。
  const bsrc = fs.readFileSync(new URL('../server/battle.js', import.meta.url), 'utf8');
  const lvl = (bsrc.match(/CHAMPION_AI\s*=\s*'([a-z]+)'/) || [])[1];
  check('F-7 王者だけ専用AIに差し替えている', !!lvl && !!AI_LEVELS[lvl], `CHAMPION_AI=${lvl}`);
  check('F-8 その段は通常のボット段(BOT_LEVELS)に混ぜていない',
    !!lvl && !new RegExp(`BOT_LEVELS\\s*=\\s*\\[[^\\]]*'${lvl}'`).test(bsrc), `BOT_LEVELS に ${lvl} が無いこと`);
}

// ---------------------------------------------------------------------------
// G. 通しで確かめる: 王者が本当に対戦相手として出て、倒すと result に印が付く
//    （印のフィールド名は別タスク＝称号とアナウンスが読む契約なので、
//     ここが緑であることが「約束した形で出ている」の唯一の裏取りになる）
// ---------------------------------------------------------------------------
{
  const PORT = await freePort();
  const BASE = `http://localhost:${PORT}`;
  const DIR = path.join(os.tmpdir(), `bba-champion-test-${PORT}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let proc = null;
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
    proc = spawn(process.execPath, ['server/index.js'], {
      env: {
        ...process.env, PORT: String(PORT), DATA_DIR: DIR,
        SESSION_SECRET: 'champion-test', SEED_RESTORE: '0',
        // POP_SCALE=1 … 住人を有効にする（0だと王者ごと居なくなる）
        // CHAMPION_RATE=1 … 遭遇の目を必ず出す（＝入り口が実際に通ることを見る）
        // MATCH_SECONDS=5 … 5秒で決着
        POP_SCALE: '1', CHAMPION_RATE: '1', MATCH_SECONDS: '5',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(proc, BASE);

    const reg = await (await fetch(`${BASE}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'おうじゃ狩り', password: 'pw-champion-test' }),
    })).json();
    check('G-0 対戦するアカウントを作れた', !!(reg && reg.token), reg && reg.error ? reg.error : '');

    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const inbox = {};
    ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } (inbox[m.type] = inbox[m.type] || []).push(m); });
    const wait = async (type, timeout = 25000) => {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type}`);
        await sleep(60);
      }
    };
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'hello', token: reg.token }));
    await wait('hello_ok', 8000);

    ws.send(JSON.stringify({ type: 'queue', mode: 'duel' }));
    // ボット補充は 4〜9秒待ってから入る（人間を待つ演出）。
    const mf = await wait('match_found', 25000);
    const opp = (mf.players || []).find(p => !p.isYou);
    check('G-1 遭遇の目が出れば王者が対戦相手として出てくる',
      !!opp && opp.name === CHAMPION.name, opp ? opp.name : 'none');
    // 正体を明かすキーが対戦相手の行に載っていないこと（既存の約束の再確認）。
    check('G-2 対戦相手の行に正体は載らない',
      !!opp && !('isBot' in opp) && !('resident' in opp), opp ? Object.keys(opp).join(',') : '');

    await sleep((mf.countdown + 1) * 1000);
    // 勝ちにいく。申告スコアはサーバー側で 500点/秒 に丸められるので、
    // 「あり得ない点」ではなく「時間相応の上限」で勝つ。
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: 'state', score: 400 * (i + 1), lines: i + 1, combo: 1 }));
      await sleep(700);
    }
    ws.send(JSON.stringify({ type: 'finish', score: 3000, lines: 10, combo: 3 }));
    const res = await wait('result', 25000);
    check('G-3 王者に勝てた（サーバーの判定）', res.outcome === 'win', `outcome=${res.outcome}`);
    check('G-4 result に「王者を倒した」印が載る', res.beatChampion === true, `beatChampion=${res.beatChampion}`);
    check('G-5 印は生涯回数も返す', res.championWins === 1, `championWins=${res.championWins}`);
    // 印の名前が「相手が誰か」を明かしていないこと（beatBot のような名前は不可）。
    const badKey = Object.keys(res).find(k => /bot|resident|ai\b|npc|ghost/i.test(k));
    check('G-6 印の名前が正体を明かしていない', !badKey, badKey || '');

    const me = await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${reg.token}` } })).json();
    check('G-7 回数がアカウントに残る（称号が再ログインで消えない）',
      (((me.user || {}).stats || {}).championWins || 0) === 1,
      String(((me.user || {}).stats || {}).championWins));

    // -----------------------------------------------------------------------
    // 全体速報。index.js が announceChampionFall を用意していても、battle.js が
    // 呼ばなければ**永遠に鳴らない** ── 並列開発でいちばん抜けやすい「担当と
    // 担当のつなぎ目」そのものなので、鳴ったことを実フレームで見張る。
    // -----------------------------------------------------------------------
    const anns = (inbox.announce || []).filter(m =>
      typeof m.message === 'string' && m.message.includes(CHAMPION.name));
    check('G-8 王者を倒すと全体速報が流れる（battle.js → index.js のつなぎ）',
      anns.length === 1, `announce=${anns.length}件 / ${anns[0] ? anns[0].message : ''}`);
    // 速報の文面からも正体は漏らさない（住人の秘匿はここでも同じ）。
    const annTxt = `${anns[0] ? anns[0].message : ''} ${anns[0] ? anns[0].messageEn || '' : ''}`;
    check('G-9 速報の文面が住人をAI/ボットと明かしていない',
      !/\bAI\b|ボット|bot\b/i.test(annTxt), annTxt.slice(0, 120));
    // 連発防止の印。これが立たないと、同じ人が同じ日に何度倒しても鳴り続ける。
    // ⚠ 印は server/backup.js の合流にも要る（落とすと復元した日にもう一度鳴る）。
    check('G-10 連発防止の印(champAnnDay)が立っている',
      /^\d{4}-\d{2}-\d{2}$/.test(String(((me.user || {}).stats || {}).champAnnDay || '')),
      String(((me.user || {}).stats || {}).champAnnDay));
    try { ws.close(); } catch { /* ignore */ }
  } catch (err) {
    check('G-* 通しの検査', false, (err && err.stack) || String(err));
  } finally {
    if (proc) {
      const p = proc; proc = null;
      await new Promise(res => { p.on('exit', res); p.kill(); });
      await sleep(300);
    }
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
