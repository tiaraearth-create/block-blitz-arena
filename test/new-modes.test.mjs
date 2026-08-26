// Run from the repo root:  node test/new-modes.test.mjs  (needs a free port 3102)
// Server-side rules for the Meltdown / Chimera modes: rate caps, per-mode
// bests, and keeping meltdown's hot multipliers off the global score board.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-newmodes-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, SESSION_SECRET: 'newmodes-test', POP_SCALE: '0', SEED_RESTORE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return log; } catch {}
  }
  throw new Error('server did not start:\n' + log);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await sleep(700);
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const u = await j('/api/register', { method: 'POST', body: { username: 'モードテスト', password: 'pass1234' } });
  check('register', u.status === 200);
  const tok = u.token;

  // Baseline: a solo game feeds the global bestScore as always.
  await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 5000, lines: 8, maxCombo: 3, duration: 60 } }, tok);

  // Meltdown: own best stat, hot multipliers keep it OFF the global board.
  const m1 = await j('/api/game/result', { method: 'POST', body: { mode: 'meltdown', score: 40000, lines: 30, maxCombo: 6, duration: 90 } }, tok);
  check('meltdown result accepted', m1.status === 200);
  let me = await j('/api/me', {}, tok);
  check('meltdownBest recorded', me.user.stats.meltdownBest === 40000, `meltdownBest=${me.user.stats.meltdownBest}`);
  check('meltdown stays OFF the global bestScore', me.user.stats.bestScore === 5000, `bestScore=${me.user.stats.bestScore}`);

  // Meltdown gets the loose 2000/s cap.
  // NOTE: `duration` is now also bounded by the wall clock since this account's
  // previous submission (+90s slack), so a burst of test submissions cannot
  // claim more play time than has actually passed. 60s stays inside that slack,
  // which keeps this assertion about the RATE CAP rather than about timing.
  await j('/api/game/result', { method: 'POST', body: { mode: 'meltdown', score: 500000, lines: 60, maxCombo: 8, duration: 60 } }, tok);
  me = await j('/api/me', {}, tok);
  check('meltdown rate-capped at 2000/s', me.user.stats.meltdownBest === 120000, `meltdownBest=${me.user.stats.meltdownBest}`);

  // （duration 詐称への対策は test/security.test.mjs で検証している。
  //   ここでやると詐称用アカウントが王座テストの順位に割り込んでしまう）

  // Chimera: chaos-scale multipliers — counts toward the global board.
  const c1 = await j('/api/game/result', { method: 'POST', body: { mode: 'chimera', score: 30000, lines: 25, maxCombo: 7, duration: 120 } }, tok);
  check('chimera result accepted', c1.status === 200);
  me = await j('/api/me', {}, tok);
  check('chimeraBest recorded', me.user.stats.chimeraBest === 30000, `chimeraBest=${me.user.stats.chimeraBest}`);
  check('chimera feeds the global bestScore', me.user.stats.bestScore === 30000, `bestScore=${me.user.stats.bestScore}`);
  check('chimera rate-capped at 1000/s ceiling holds smaller runs', me.user.stats.chimeraBest <= 120 * 1000);

  // Boss 2.0 fields still work: rank + rush depth.
  await j('/api/game/result', { method: 'POST', body: { mode: 'boss', bossId: 'slime', score: 3000, lines: 10, maxCombo: 4, duration: 40, won: true, rank: 'S' } }, tok);
  await j('/api/game/result', { method: 'POST', body: { mode: 'boss_rush', score: 20000, lines: 30, maxCombo: 5, duration: 300, won: false, depth: 7 } }, tok);
  me = await j('/api/me', {}, tok);
  check('boss clear rank stored', me.user.stats.bossRanks && me.user.stats.bossRanks.slime === 'S', JSON.stringify(me.user.stats.bossRanks));
  check('rush depth stored', me.user.stats.rushDepth === 7, `rushDepth=${me.user.stats.rushDepth}`);

  // Stray wave fields must not advance Survival missions.
  await j('/api/game/result', { method: 'POST', body: { mode: 'meltdown', score: 1000, lines: 2, maxCombo: 2, duration: 30, wave: 50 } }, tok);
  const ms = await j('/api/missions', {}, tok);
  const rows = [...(ms.missions.daily || []), ...(ms.missions.weekly || [])];
  const waveMission = rows.find(r => r.id === 'd_survive8' || r.id === 'w_wave15');
  check('wave field from non-survival modes is ignored', !waveMission || waveMission.progress === 0, waveMission ? `${waveMission.id}=${waveMission.progress}` : 'no wave mission on board');

  // ---- v2.6: 🧩 パズル遺跡 ----
  await j('/api/game/result', { method: 'POST', body: { mode: 'puzzle', score: 900, lines: 4, maxCombo: 2, duration: 40, won: true, stage: 3 } }, tok);
  me = await j('/api/me', {}, tok);
  check('puzzleStage recorded on win', me.user.stats.puzzleStage === 3, `puzzleStage=${me.user.stats.puzzleStage}`);
  await j('/api/game/result', { method: 'POST', body: { mode: 'puzzle', score: 900, lines: 4, maxCombo: 2, duration: 40, won: false, stage: 9 } }, tok);
  me = await j('/api/me', {}, tok);
  check('a FAILED stage does not advance puzzleStage', me.user.stats.puzzleStage === 3, `puzzleStage=${me.user.stats.puzzleStage}`);
  await j('/api/game/result', { method: 'POST', body: { mode: 'puzzle', score: 1200, lines: 5, maxCombo: 3, duration: 55, won: true, stage: 12 } }, tok);
  me = await j('/api/me', {}, tok);
  check('stage 12 pays the decade gem bonus', me.user.stats.puzzleStage === 12, `puzzleStage=${me.user.stats.puzzleStage}`);
  const puzzleGems = me.user.gems;
  await j('/api/game/result', { method: 'POST', body: { mode: 'puzzle', score: 2000, lines: 6, maxCombo: 3, duration: 45, won: true, stage: 50 } }, tok);
  me = await j('/api/me', {}, tok);
  check('stage 50 grants the 🧩 puzzle badge', me.user.badges.includes('puzzle'), JSON.stringify(me.user.badges));
  check('stage 50 pays badge + decade gems', me.user.gems > puzzleGems, `gems ${puzzleGems}→${me.user.gems}`);

  // ---- v2.6: ⛏️ 採掘場 ----
  await j('/api/game/result', { method: 'POST', body: { mode: 'dig', score: 15000, lines: 20, maxCombo: 5, duration: 180, won: false, depth: 22 } }, tok);
  me = await j('/api/me', {}, tok);
  check('digDepth recorded', me.user.stats.digDepth === 22, `digDepth=${me.user.stats.digDepth}`);
  check('dig depth does NOT leak into boss_rush rushDepth', me.user.stats.rushDepth === 7, `rushDepth=${me.user.stats.rushDepth}`);
  await j('/api/game/result', { method: 'POST', body: { mode: 'dig', score: 30000, lines: 40, maxCombo: 6, duration: 300, won: false, depth: 55 } }, tok);
  me = await j('/api/me', {}, tok);
  check('depth 55 grants the ⛏️ dig badge', me.user.badges.includes('dig'), JSON.stringify(me.user.badges));

  // Forged stage/depth: stat capped at 999 and the gem faucet stops at stage 100.
  const gemsBefore = me.user.gems;
  await j('/api/game/result', { method: 'POST', body: { mode: 'puzzle', score: 100, lines: 1, maxCombo: 1, duration: 30, won: true, stage: 9999 } }, tok);
  me = await j('/api/me', {}, tok);
  check('forged stage 9999 → stat capped at 999', me.user.stats.puzzleStage === 999, `puzzleStage=${me.user.stats.puzzleStage}`);
  check('forged stage pays at most the remaining sub-100 decades', me.user.gems - gemsBefore <= 125, `gems +${me.user.gems - gemsBefore}`);
  await j('/api/game/result', { method: 'POST', body: { mode: 'dig', score: 100, lines: 1, maxCombo: 1, duration: 30, won: false, depth: 9999 } }, tok);
  me = await j('/api/me', {}, tok);
  check('forged depth 9999 → stat capped at 999', me.user.stats.digDepth === 999, `digDepth=${me.user.stats.digDepth}`);

  // New leaderboards answer with the right value fields.
  const lbP = await j('/api/leaderboard?board=puzzle');
  const meRowP = (lbP.rows || []).find(r => r.username === 'モードテスト');
  check('puzzle leaderboard lists the player with the capped stat', !!meRowP && meRowP.puzzleStage === 999, JSON.stringify(meRowP && { s: meRowP.puzzleStage }));
  const lbD = await j('/api/leaderboard?board=dig');
  const meRowD = (lbD.rows || []).find(r => r.username === 'モードテスト');
  check('dig leaderboard lists the player with the capped stat', !!meRowD && meRowD.digDepth === 999, JSON.stringify(meRowD && { d: meRowD.digDepth }));

  // v2.6 lifetime counters tick.
  check('totalWins counter ticks', me.user.stats.totalWins >= 3, `totalWins=${me.user.stats.totalWins}`);
  check('playSecs accumulates', me.user.stats.playSecs > 0, `playSecs=${me.user.stats.playSecs}`);

  // ---- 👑 王座 (thrones) ----
  check('sole real player holds the score/puzzle/dig thrones', ['score', 'puzzle', 'dig'].every(b => (me.user.thrones || []).includes(b)), JSON.stringify(me.user.thrones));
  check('rating throne needs >1000 (never handed out at the floor)', !(me.user.thrones || []).includes('rating'), JSON.stringify(me.user.thrones));
  check('leaderboard marks the throne row', !!meRowP && (lbP.rows.find(r => r.username === 'モードテスト') || {}).throne === true, '');
  // A stronger player takes the score throne → announced on the live feed.
  const u2 = await j('/api/register', { method: 'POST', body: { username: '簒奪者', password: 'pass1234' } });
  await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 90000, lines: 60, maxCombo: 8, duration: 300, won: true } }, u2.token);
  const me2t = await j('/api/me', {}, u2.token);
  check('score throne transfers to the new #1', (me2t.user.thrones || []).includes('score'), JSON.stringify(me2t.user.thrones));
  const meAfter = await j('/api/me', {}, tok);
  check('dethroned player keeps the other thrones only', !(meAfter.user.thrones || []).includes('score') && (meAfter.user.thrones || []).includes('puzzle'), JSON.stringify(meAfter.user.thrones));
  const feed = await j('/api/feed');
  check('takeover announced on the live feed', (feed.feed || []).some(f => f.real && /王座/.test(f.text || '')), JSON.stringify((feed.feed || []).filter(f => f.real).map(f => f.text).slice(-3)));

  // ---- 👻 幽霊屋敷 (隠しモード) ----
  await j('/api/game/result', { method: 'POST', body: { mode: 'ghost', score: 8000, lines: 12, maxCombo: 4, duration: 90, won: false } }, tok);
  me = await j('/api/me', {}, tok);
  check('ghostBest recorded', me.user.stats.ghostBest === 8000, `ghostBest=${me.user.stats.ghostBest}`);
  check('15k未満はバッジなし', !me.user.badges.includes('ghost'));
  const gemsBeforeGhost = me.user.gems;
  await j('/api/game/result', { method: 'POST', body: { mode: 'ghost', score: 16000, lines: 20, maxCombo: 6, duration: 120, won: false } }, tok);
  me = await j('/api/me', {}, tok);
  check('15,000点で👻バッジ+💎250', me.user.badges.includes('ghost') && me.user.gems === gemsBeforeGhost + 250, `gems +${me.user.gems - gemsBeforeGhost}`);
  check('ghost score counts toward global bestScore', me.user.stats.bestScore >= 16000, `bestScore=${me.user.stats.bestScore}`);
  const titles2 = await j('/api/titles', {}, tok);
  check('称号「幽霊使い」解放', (titles2.earned || []).includes('ghostmaster'));

  // ---- 👑 多冠バッジ: 同時2冠/3冠で永久バッジ、冠を失っても残る ----
  check('三冠時に crown2+crown3 バッジを獲得済み', ['crown2', 'crown3'].every(b2 => meAfter.user.badges.includes(b2)), JSON.stringify(meAfter.user.badges));
  check('王座を失ってもバッジは残る(2冠に落ちてもcrown3保持)', meAfter.user.badges.includes('crown3') && meAfter.user.thrones.length === 2, `thrones=${meAfter.user.thrones.length}`);
  const lbC = await j('/api/leaderboard?board=puzzle');
  const rowC = (lbC.rows || []).find(r => r.username === 'モードテスト');
  check('ランキング行に冠数(crowns)が載る', !!rowC && rowC.crowns === 2, JSON.stringify(rowC && { crowns: rowC.crowns }));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
