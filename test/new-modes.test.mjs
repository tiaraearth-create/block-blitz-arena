// Run from the repo root:  node test/new-modes.test.mjs  (needs a free port 3102)
// Server-side rules for the Meltdown / Chimera modes: rate caps, per-mode
// bests, and keeping meltdown's hot multipliers off the global score board.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3102;
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
  await j('/api/game/result', { method: 'POST', body: { mode: 'meltdown', score: 500000, lines: 60, maxCombo: 8, duration: 100 } }, tok);
  me = await j('/api/me', {}, tok);
  check('meltdown rate-capped at 2000/s', me.user.stats.meltdownBest === 200000, `meltdownBest=${me.user.stats.meltdownBest}`);

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
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
