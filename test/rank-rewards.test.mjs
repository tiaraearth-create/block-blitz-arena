// Run from the repo root:  node test/rank-rewards.test.mjs  (needs a free port 3101)
// Integration test: weekly ranking rewards are granted at the week rollover,
// claimed exactly once, and the AI poll brain is deterministic.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createPoll, residentChoice, residentVoteAt, isSwingVoter } from '../server/polls.js';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
// 保存先にポートを混ぜる。固定名だと、run-all が同時に2つ走ったときに
// 両方が同じフォルダを使い、片方の rmSync がもう片方の db.json を消す
// （並列開発では実際に踏む）。理由の詳細は test/battle.test.mjs を参照。
const DIR = path.join(os.tmpdir(), `bba-rank-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};

let proc = null;
async function start(extraEnv = {}) {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, SESSION_SECRET: 'rank-test-secret', POP_SCALE: '0', SEED_RESTORE: '0', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await sleep(700);   // let the 250ms save debounce flush db.json
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---- AI poll brain (pure functions — no server needed) ----
{
  const { poll } = createPoll({ question: 'つぎの企画どれがいい？', options: ['ガチャ大放出', 'ボス討伐ウィーク', 'Speedrun Night'], minutes: 60 });
  const gachaFan = { id: 'r1', arch: 'gacha', lang: 'ja' };
  const explorer = { id: 'r2', arch: 'explorer', lang: 'ja' };
  check('residentChoice is deterministic per resident+poll',
    residentChoice(poll, gachaFan) === residentChoice(poll, gachaFan)
    && residentChoice(poll, explorer) === residentChoice(poll, explorer));
  // With many samples across residents, the gacha option should dominate for gacha fans.
  let gachaPicks = 0;
  for (let i = 0; i < 200; i++) {
    const r = { id: `g${i}`, arch: 'gacha', lang: 'ja' };
    if (residentChoice(poll, r) === poll.options[0].id) gachaPicks++;
  }
  check('gacha residents lean to the gacha option', gachaPicks > 100, `${gachaPicks}/200`);
  const at = residentVoteAt(poll, gachaFan);
  check('residentVoteAt is a fraction of the poll lifetime', at >= 0.02 && at <= 0.95 && at === residentVoteAt(poll, gachaFan), String(at));
  check('isSwingVoter is deterministic', isSwingVoter(poll, gachaFan) === isSwingVoter(poll, gachaFan));
  const excluded = residentChoice(poll, gachaFan, { exclude: residentChoice(poll, gachaFan) });
  check('exclude option forces a different choice', excluded !== null && excluded !== residentChoice(poll, gachaFan));
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const admin = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
  check('admin login', admin.status === 200);

  const a = await j('/api/register', { method: 'POST', body: { username: 'アリス', password: 'pass1234' } });
  const b = await j('/api/register', { method: 'POST', body: { username: 'ボブ', password: 'pass1234' } });
  check('two players registered', a.status === 200 && b.status === 200);

  await j('/api/game/result', { method: 'POST', body: { mode: 'weekly', score: 5000, lines: 12, maxCombo: 3, duration: 90 } }, a.token);
  await j('/api/game/result', { method: 'POST', body: { mode: 'weekly', score: 9000, lines: 20, maxCombo: 5, duration: 90 } }, b.token);

  const meMid = await j('/api/me', {}, b.token);
  check('no reward mid-week', meMid.status === 200 && meMid.user.rankRewards.length === 0);

  // ---- にぎわい倍率の上限 ----
  // 数字を直書きすると、上限を広げるたびにここだけ古くなる（実際そうなった）。
  // サーバーの定数を読んで「上限まで通り、その上はクランプされる」ことだけを見る。
  const { MAX_LIVE_SCALE } = await import('../server/ambient.js');
  const pop100 = await j('/api/admin/pop', { method: 'POST', body: { scale: 100 } }, admin.token);
  check('admin can set にぎわい ×100', pop100.status === 200 && pop100.scale === 100, `scale=${pop100.scale}`);
  const popMax = await j('/api/admin/pop', { method: 'POST', body: { scale: MAX_LIVE_SCALE } }, admin.token);
  check(`admin can set にぎわい ×${MAX_LIVE_SCALE}`, popMax.status === 200 && popMax.scale === MAX_LIVE_SCALE, `scale=${popMax.scale}`);
  const popOver = await j('/api/admin/pop', { method: 'POST', body: { scale: MAX_LIVE_SCALE * 2 + 1 } }, admin.token);
  check('上限を超えた倍率はクランプされる', popOver.status === 200 && popOver.scale === MAX_LIVE_SCALE, `scale=${popOver.scale}`);
  // 住人の実数が倍率でどう伸びるかは crowd.test.mjs 側で検証する
  // （このサーバーは POP_SCALE=0 で起動しているので、ここでは常に基本64人）。
  await j('/api/admin/pop', { method: 'POST', body: { scale: 0 } }, admin.token);

  // ---- simulate the week rolling over: rewind everyone's weekly record ----
  await stop();
  const dbFile = path.join(DIR, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  for (const u of Object.values(db.users)) {
    if (u.stats && u.stats.weekly) u.stats.weekly.week = 'W1000';
  }
  delete db.meta.lastRankRewardWeek;
  fs.writeFileSync(dbFile, JSON.stringify(db));
  await start();   // boot runs finalizeWeeklyRankings()

  const meB = await j('/api/me', {}, b.token);
  const rwB = meB.user.rankRewards;
  check('winner has 1 pending reward after rollover', meB.status === 200 && rwB.length === 1, JSON.stringify(rwB));
  check('winner is rank 1 with champion badge pending', rwB[0] && rwB[0].rank === 1 && rwB[0].badge === 'weekly1' && rwB[0].coins === 2000 && rwB[0].gems === 300, JSON.stringify(rwB[0]));
  // 🎭 v2.61: of（順位を決めた母集団の人数）は**本人にも渡さない**。
  //    順位報酬は住人を外した実プレイヤーだけで数え直しているので、
  //    そのまま返すと「3位 / 13人中」と出て、住人込みで100行あるランキングの
  //    残りが何なのか引き算で割れてしまう。記録（db.json）には残っている。
  check('順位報酬に母集団の人数が載っていない（住人の秘匿）',
    rwB[0] && rwB[0].of === undefined, JSON.stringify(rwB[0]));
  const meA = await j('/api/me', {}, a.token);
  check('runner-up is rank 2', meA.user.rankRewards.length === 1 && meA.user.rankRewards[0].rank === 2 && meA.user.rankRewards[0].coins === 1200, JSON.stringify(meA.user.rankRewards[0]));

  const news = await j('/api/news');
  check('results are announced in the news', (news.news || []).some(n => n.title.includes('結果発表')));

  const lb = await j('/api/leaderboard?board=weekly');
  check('weekly board ships the prize table', Array.isArray(lb.rewards) && lb.rewards[0].coins === 2000);
  const lbScore = await j('/api/leaderboard?board=score');
  check('other boards have no prize table', lbScore.rewards === undefined);

  // ---- restart again: finalize must be idempotent ----
  await stop();
  await start();
  const meB2 = await j('/api/me', {}, b.token);
  check('rewards are not granted twice across boots', meB2.user.rankRewards.length === 1, `pending=${meB2.user.rankRewards.length}`);

  // ---- claim ----
  const beforeB = (await j('/api/me', {}, b.token)).user;
  const claim = await j('/api/rank/claim', { method: 'POST', body: {} }, b.token);
  check('claim pays coins+gems+badge', claim.status === 200 && claim.reward.coins === 2000 && claim.reward.gems === 300 && claim.reward.badges.includes('weekly1'), JSON.stringify(claim.reward));
  check('user balance and badges updated', claim.user.coins === beforeB.coins + 2000 && claim.user.gems === beforeB.gems + 300 && claim.user.badges.includes('weekly1') && claim.user.rankRewards.length === 0);
  const again = await j('/api/rank/claim', { method: 'POST', body: {} }, b.token);
  check('second claim is refused', again.status === 409);

  const titles = await j('/api/titles', {}, b.token);
  check('週間王者 title unlocked by the badge', (titles.earned || []).includes('weeklyking'));

  const beforeA = (await j('/api/me', {}, a.token)).user;
  const claimA = await j('/api/rank/claim', { method: 'POST', body: {} }, a.token);
  check('runner-up claim pays the rank-2 tier', claimA.status === 200 && claimA.reward.coins === 1200 && claimA.reward.badges.length === 0 && claimA.user.coins === beforeA.coins + 1200, JSON.stringify(claimA.reward));

  // ---- 👑 AIプレイヤー（住人）の王座参戦 — にぎわいONのときだけ ----
  // 前段の clamp テストが live scale を 0 に戻しているので、env と admin の
  // 両方をONにして初めて residents が候補に入る（effectiveScale = env × live）。
  await stop();
  await start({ POP_SCALE: '1' });
  const admin2 = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
  await j('/api/admin/pop', { method: 'POST', body: { scale: 1 } }, admin2.token);
  const lbT = await j('/api/leaderboard?board=score');
  check('with crowd ON the score throne is never vacant', lbT.throne && lbT.throne.username, JSON.stringify(lbT.throne));
  check('…and an AI resident outranks the small real scores', lbT.throne && lbT.throne.username !== 'アリス' && lbT.throne.username !== 'ボブ', lbT.throne && lbT.throne.username);
  const crowned = (lbT.rows || []).find(r => r.throne);
  check('the crowned holder is a VISIBLE row on the board', !!crowned && crowned.username === lbT.throne.username, crowned && crowned.username);
  // v2.34: 非管理者には kind:'resident' を出さない（住人の正体になる）ので、
  // 一般の目には実プレイヤーとまったく同じ 'player' の名刺に見えるのが正しい。
  // 管理者トークンでだけ 'resident' が返り、王座も従来どおり載る。
  const profT = await j('/api/profile/' + encodeURIComponent(lbT.throne.username));
  check('AI throne holder looks like a normal player to everyone else',
    profT.status === 200 && profT.profile.kind === 'player' && (profT.profile.thrones || []).includes('score'),
    JSON.stringify(profT.profile && { kind: profT.profile.kind, thrones: profT.profile.thrones }));
  const profTAdmin = await j('/api/profile/' + encodeURIComponent(lbT.throne.username), {}, admin2.token);
  check('AI throne holder has a resident profile listing the throne (admin)',
    profTAdmin.status === 200 && profTAdmin.profile.kind === 'resident' && (profTAdmin.profile.thrones || []).includes('score'),
    JSON.stringify(profTAdmin.profile && { kind: profTAdmin.profile.kind, thrones: profTAdmin.profile.thrones }));
  // Crowd OFF (env 0) → residents lose eligibility, real players only.
  await stop();
  await start();
  const lbT2 = await j('/api/leaderboard?board=score');
  check('with crowd OFF the throne falls back to a real player', lbT2.throne && (lbT2.throne.username === 'アリス' || lbT2.throne.username === 'ボブ'), JSON.stringify(lbT2.throne));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
