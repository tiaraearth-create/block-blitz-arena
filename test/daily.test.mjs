// Run from the repo root:  node test/daily.test.mjs
//
// 📅 デイリーチャレンジ (v2.15) のサーバー側ルールを検証する:
//   ・/api/daily の形と決定性（同じ日は何度呼んでも同じシード・同じお題）
//   ・記録は「予約した1回」だけ — /api/daily/start を経ない提出は記録しない
//   ・開始した時点で今日の1回を消費する（放棄しても0点で確定＝リトライ不可）
//   ・予約は2時間で失効する（一晩研究してから提出、を防ぐ）
//   ・日跨ぎの回は「走った盤面の日」に記録され、翌日の1回を焼かない
//   ・クリア（目標以上）でストリークが伸び、倍率つきボーナスが出る
//   ・昨日クリアしていればストリーク継続、未クリア/空白日はリセット
//   ・7日連続クリアで daily7 バッジ
//   ・デイリーボードに本人と住人（ゴースト行）が並び、rewards は付かない
//   ・デイリーのスコアは通常のハイスコアには入らない
//   ・住人のその日の点は、お題の ghost 係数に従う（人間が届く範囲に収まる）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-daily-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};
// サーバーの jstDayKey と同じ計算（+9時間してUTC日付を読む）。
const jstKey = ts => new Date(ts + 9 * 3600000).toISOString().slice(0, 10);

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, SESSION_SECRET: 'daily-test', POP_SCALE: '1', SEED_RESTORE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (p.exitCode !== null) return;   // もう終わっている（'exit' は二度と来ない）
  // Windows では SIGTERM ハンドラが走らず gracefulShutdown/flushDb が呼ばれない。
  // 250ms のデバウンス保存がディスクに落ちるだけの猶予を、終了要求の前に必ず取る。
  // ここを飛ばすと editDb が db.json を ENOENT で読めず、以降の回が undefined になる。
  await sleep(700);
  await new Promise(res => {
    let t = null;
    const done = () => { if (t) clearTimeout(t); res(); };
    p.on('exit', done);
    p.kill();
    // kill() が届かないことがある（Windows では SIGTERM ハンドラも走らない）。
    // 待ちっぱなしにするとランナーの時間切れになるので、5秒で強制終了に切り替える。
    t = setTimeout(() => {
      if (process.platform === 'win32' && p.pid) {
        try { spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { /* 下の SIGKILL にまかせる */ }
      }
      try { p.kill('SIGKILL'); } catch { /* もう死んでいる */ }
      res();
    }, 5000);
  });
  await sleep(300);
}
// 停止中の db.json を直接書き換えて「昨日プレイした状態」を作る。
// JST日付は実時間でしか進まないので、過去の記録はこうして注入するしかない。
function editDb(fn) {
  const file = path.join(DIR, 'db.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(db);
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}

// 実クライアント（public/js/modes.js の DailyMode）と同じ手順:
//   1. /api/daily/start で挑戦を予約し attemptId を受け取る
//   2. 走った盤面の day と attemptId を添えて /api/game/result に提出
const playDaily = async (tok, score, over = {}) => {
  const st = await j('/api/daily/start', { method: 'POST', body: over.startDay ? { day: over.startDay } : {} }, tok);
  const body = {
    mode: 'daily', score, lines: 20, maxCombo: 5, duration: 60,
    day: over.day || st.day,
    ...(st.attemptId ? { attemptId: st.attemptId } : {}),
  };
  const res = await j('/api/game/result', { method: 'POST', body }, tok);
  return { st, res, daily: res.rewards && res.rewards.daily };
};

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const today = jstKey(Date.now());
  const yesterday = jstKey(Date.now() - 86400000);

  // ---- /api/daily の形と決定性 --------------------------------------------
  const a = await j('/api/daily');
  check('未ログインでも /api/daily が読める', a.status === 200);
  check('day が今日(JST)', a.day === today, `${a.day} vs ${today}`);
  check('seed が正の整数', Number.isInteger(a.seed) && a.seed > 0, String(a.seed));
  check('pieces=30', a.pieces === 30, `pieces=${a.pieces}`);
  check('target はお題の係数どおり', a.target === Math.round(5000 * a.modifier.target / 100) * 100, `target=${a.target} (${a.modifier.id})`);
  check('お題が bilingual', !!(a.modifier && a.modifier.id && a.modifier.ja && a.modifier.en && a.modifier.descJa && a.modifier.descEn), JSON.stringify(a.modifier));
  // v2.34: 住人係数 ghost は **配らない**。名前がそのまま「AIの成績をこちらで
  // 作っています」と言っているフィールドで、画面も一切使っていない。
  // 係数が生きていること自体は下（そして末尾の全お題チェック）で、サーバー内部の
  // dailyModifierOf を直接読んで確かめる。
  const { dailyModifierOf: modOf } = await import('../server/daily.js');
  const ghostFactor = modOf(today).ghost;
  check('お題に住人係数 ghost がある（サーバー内部）', typeof ghostFactor === 'number' && ghostFactor > 0, String(ghostFactor));
  check('住人係数 ghost はAPIから見えない', a.modifier.ghost === undefined, JSON.stringify(a.modifier));
  check('endsAt が24時間以内の未来', a.endsAt > Date.now() && a.endsAt <= Date.now() + 86400000, String(a.endsAt));
  check('未プレイ状態', a.played === false && a.score === null && a.streak === 0);
  const b = await j('/api/daily');
  check('同じ日は同じシード・同じお題', b.seed === a.seed && b.modifier.id === a.modifier.id);
  const goldMult = a.modifier.id === 'gold' ? 2 : 1;   // 💰黄金の日はコイン2倍
  const TARGET = a.target;

  // ---- 予約しない提出は記録されない（放棄リトライ対策の本体） ---------------
  const cheat = await j('/api/register', { method: 'POST', body: { username: 'ノー予約太郎', password: 'pass1234' } });
  const rawSubmit = await j('/api/game/result', { method: 'POST', body: { mode: 'daily', score: 99999, lines: 40, maxCombo: 20, duration: 60, day: today } }, cheat.token);
  check('/api/daily/start を経ない提出は記録されない',
    rawSubmit.rewards && rawSubmit.rewards.daily && rawSubmit.rewards.daily.recorded === false && rawSubmit.rewards.daily.reason === 'unreserved',
    JSON.stringify(rawSubmit.rewards && rawSubmit.rewards.daily));
  const cheatMe = await j('/api/me', {}, cheat.token);
  check('予約なしの申告はボードに残らない', !cheatMe.user.stats.dailyc, JSON.stringify(cheatMe.user.stats.dailyc));

  // ---- 1回目だけが記録・2回目は練習 ---------------------------------------
  const u = await j('/api/register', { method: 'POST', body: { username: 'デイリー一郎', password: 'pass1234' } });
  check('register', u.status === 200);
  const tok = u.token;
  const p1 = await playDaily(tok, 3000);
  check('予約が attemptId を返す', !!p1.st.attemptId && p1.st.practice === false, JSON.stringify(p1.st));
  check('初回は recorded=true / 未クリアで streak=0', p1.daily && p1.daily.recorded === true && p1.daily.cleared === false && p1.daily.streak === 0, JSON.stringify(p1.daily));
  check('未クリアはボーナス0', p1.daily.bonusCoins === 0 && p1.daily.bonusGems === 0);
  const p2 = await playDaily(tok, 9999);
  check('2回目の予約は practice', p2.st.practice === true && !p2.st.attemptId, JSON.stringify(p2.st));
  check('2回目は練習 (recorded=false)', p2.daily && p2.daily.recorded === false && p2.daily.reason === 'practice', JSON.stringify(p2.daily));
  const me1 = await j('/api/me', {}, tok);
  check('記録は初回の3000のまま', me1.user.stats.dailyc && me1.user.stats.dailyc.score === 3000, JSON.stringify(me1.user.stats.dailyc));
  check('挑戦回数は2回', me1.user.stats.dailycPlays === 2, String(me1.user.stats.dailycPlays));
  check('デイリーは通常ハイスコアに入らない', me1.user.stats.bestScore === 0, `bestScore=${me1.user.stats.bestScore}`);
  const d1 = await j('/api/daily', {}, tok);
  check('/api/daily が挑戦済みを返す', d1.played === true && d1.score === 3000);

  // ---- 開始したら消費される: 放棄しても今日はもう記録できない ---------------
  const quit = await j('/api/register', { method: 'POST', body: { username: '途中離脱くん', password: 'pass1234' } });
  const qs = await j('/api/daily/start', { method: 'POST', body: {} }, quit.token);
  check('放棄する回も予約は取れる', qs.practice === false && !!qs.attemptId);
  const qd = await j('/api/daily', {}, quit.token);
  check('開始しただけで挑戦済み・0点になる', qd.played === true && qd.score === 0, JSON.stringify({ played: qd.played, score: qd.score }));
  const qRetry = await j('/api/daily/start', { method: 'POST', body: {} }, quit.token);
  check('放棄後の再開始は練習あつかい', qRetry.practice === true && !qRetry.attemptId, JSON.stringify(qRetry));
  const qSubmit = await j('/api/game/result', { method: 'POST', body: { mode: 'daily', score: 50000, lines: 40, maxCombo: 20, duration: 60, day: today } }, quit.token);
  check('放棄後にリロードして出し直しても記録されない', qSubmit.rewards.daily.recorded === false && qSubmit.rewards.daily.reason === 'practice', JSON.stringify(qSubmit.rewards.daily));
  const qMe = await j('/api/me', {}, quit.token);
  check('放棄した回は0点のまま確定', qMe.user.stats.dailyc.score === 0, JSON.stringify(qMe.user.stats.dailyc));

  // ---- attemptId を取り違えた提出は通らない --------------------------------
  const forge = await j('/api/register', { method: 'POST', body: { username: '偽装さん', password: 'pass1234' } });
  await j('/api/daily/start', { method: 'POST', body: {} }, forge.token);
  const forged = await j('/api/game/result', { method: 'POST', body: { mode: 'daily', score: 60000, lines: 40, maxCombo: 20, duration: 60, day: today, attemptId: '00000000-0000-0000-0000-000000000000' } }, forge.token);
  check('他人の/でたらめな attemptId では記録できない', forged.rewards.daily.recorded === false, JSON.stringify(forged.rewards.daily));

  // ---- 日付の合わない開始は stale として弾かれる ---------------------------
  const staleStart = await j('/api/daily/start', { method: 'POST', body: { day: yesterday } }, forge.token);
  check('昨日の day で開始しようとすると stale', staleStart.stale === true && staleStart.day === today, JSON.stringify(staleStart));

  // ---- デイリーボード: 本人＋住人、rewards なし -----------------------------
  const lb = await j('/api/leaderboard?board=daily');
  check('board=daily が返る', lb.board === 'daily');
  const mine = lb.rows.find(r => r.username === 'デイリー一郎');
  check('本人が dailyScore=3000 で載る', !!mine && mine.dailyScore === 3000, JSON.stringify(mine && { d: mine.dailyScore }));
  check('0点で放棄した人はボードに出ない', !lb.rows.some(r => r.username === '途中離脱くん'));
  const ghosts = lb.rows.filter(r => r.username !== 'デイリー一郎');
  check('住人（ゴースト行）が並ぶ', ghosts.length >= 5, `${ghosts.length}人`);
  check('全行に dailyScore がある', lb.rows.every(r => typeof r.dailyScore === 'number' && Number.isFinite(r.dailyScore)));
  const sorted = lb.rows.every((r, i) => i === 0 || (lb.rows[i - 1].dailyScore || 0) >= (r.dailyScore || 0));
  check('dailyScore の降順に並ぶ', sorted);
  check('デイリーには rewards 表が付かない（週間だけの約束）', lb.rewards === undefined);
  // お題を無視して住人が点を出すと、極小の日に「人間には不可能な行」が並ぶ。
  // 生の式の上限は約22,900点。お題の係数が効いていれば必ずその範囲に収まる。
  const topGhost = Math.max(...ghosts.map(r => r.dailyScore || 0));
  check('住人の点がお題の係数の範囲に収まる', topGhost <= Math.ceil(22900 * ghostFactor) + 1,
    `top=${topGhost} 上限=${Math.ceil(22900 * ghostFactor)} (${a.modifier.id} ghost=${ghostFactor})`);

  // ---- ストリーク: 昨日クリア→継続 / 未クリア→リセット / 7日でバッジ -------
  const u2 = await j('/api/register', { method: 'POST', body: { username: 'デイリー六段', password: 'pass1234' } });
  const u3 = await j('/api/register', { method: 'POST', body: { username: 'デイリー復帰組', password: 'pass1234' } });
  await stop();
  editDb(db => {
    for (const usr of Object.values(db.users)) {
      if (usr.username === 'デイリー一郎') usr.stats.dailyc = { day: yesterday, score: 8000, cleared: true, streak: 3 };
      if (usr.username === 'デイリー六段') usr.stats.dailyc = { day: yesterday, score: 9000, cleared: true, streak: 6 };
      if (usr.username === 'デイリー復帰組') usr.stats.dailyc = { day: yesterday, score: 2000, cleared: false, streak: 0 };
    }
  });
  await start();

  // 目標ちょうどはクリア扱い。昨日streak3 → 今日4日目。
  const p3 = await playDaily(tok, TARGET);
  const dd = p3.daily;
  check('目標ちょうどでクリア', dd && dd.cleared === true, JSON.stringify(dd));
  check('昨日クリア済みならストリーク継続 (3→4)', dd && dd.streak === 4);
  const mult4 = Math.min(3, 1 + (4 - 1) * 0.35);
  check('ボーナスがストリーク倍率どおり', dd && dd.bonusCoins === Math.round(150 * mult4) * goldMult && dd.bonusGems === Math.round(8 * mult4),
    `coins=${dd && dd.bonusCoins} gems=${dd && dd.bonusGems} (期待 ${Math.round(150 * mult4) * goldMult}/${Math.round(8 * mult4)})`);

  // 6日 → 7日目のクリアで daily7 バッジ + 💎300
  const before7 = await j('/api/me', {}, u2.token);
  const p7 = await playDaily(u2.token, Math.max(7777, TARGET));
  const after7 = await j('/api/me', {}, u2.token);
  check('7日連続で daily7 バッジ', after7.user.badges.includes('daily7'), JSON.stringify(after7.user.badges));
  check('バッジは結果にも載る', p7.res.rewards.badge === 'daily7');
  check('ベストストリークが7で記録される', after7.user.stats.dailycBestStreak === 7, String(after7.user.stats.dailycBestStreak));
  check('バッジの💎300が入っている', after7.user.gems >= (before7.user.gems || 0) + 300, `${before7.user.gems}→${after7.user.gems}`);

  // 昨日「未クリア」だった人は、今日クリアしても1日目から
  const pr = await playDaily(u3.token, Math.max(6000, TARGET));
  check('昨日未クリアならストリークは1から', pr.daily.cleared === true && pr.daily.streak === 1, JSON.stringify(pr.daily));

  await stop();

  // ---- 2日空けたらリセット（day-2 のクリアは継続しない） --------------------
  const dayBefore = jstKey(Date.now() - 2 * 86400000);
  editDb(db => {
    for (const usr of Object.values(db.users)) {
      if (usr.username === 'デイリー復帰組') usr.stats.dailyc = { day: dayBefore, score: 9000, cleared: true, streak: 5 };
    }
  });
  await start();
  const pg = await playDaily(u3.token, Math.max(6000, TARGET));
  check('1日空けるとストリークは1から', pg.daily.streak === 1, JSON.stringify(pg.daily));
  await stop();

  // ---- 日跨ぎ: 昨日の盤面は昨日に記録され、今日の1回は残る ------------------
  await start();
  const night = await j('/api/register', { method: 'POST', body: { username: '夜更かし', password: 'pass1234' } });
  const nightStart = await j('/api/daily/start', { method: 'POST', body: {} }, night.token);
  await stop();
  // 「23:58に開始し、日付を跨いで0:02に提出した」状態を作る。
  editDb(db => {
    for (const usr of Object.values(db.users)) {
      if (usr.username === '夜更かし') usr.stats.dailyc = { ...usr.stats.dailyc, day: yesterday };
    }
  });
  await start();
  const crossed = await j('/api/game/result', { method: 'POST', body: { mode: 'daily', score: Math.max(9000, TARGET), lines: 30, maxCombo: 8, duration: 90, day: yesterday, attemptId: nightStart.attemptId } }, night.token);
  check('日跨ぎの回は走った日(昨日)に記録される', crossed.rewards.daily.recorded === true, JSON.stringify(crossed.rewards.daily));
  const nightMe = await j('/api/me', {}, night.token);
  check('記録先が昨日になっている', nightMe.user.stats.dailyc.day === yesterday, JSON.stringify(nightMe.user.stats.dailyc));
  const nightToday = await j('/api/daily', {}, night.token);
  check('今日の1回は焼かれていない', nightToday.played === false, JSON.stringify({ played: nightToday.played }));
  check('昨日クリアぶんがストリークとして今日に引き継がれる', nightToday.streak === 1, String(nightToday.streak));
  await stop();

  // ---- 予約は2時間で失効する ------------------------------------------------
  await start();
  const slow = await j('/api/register', { method: 'POST', body: { username: 'のんびり屋', password: 'pass1234' } });
  const slowStart = await j('/api/daily/start', { method: 'POST', body: {} }, slow.token);
  await stop();
  editDb(db => {
    for (const usr of Object.values(db.users)) {
      if (usr.username === 'のんびり屋') usr.stats.dailyc.at = Date.now() - 3 * 60 * 60 * 1000;
    }
  });
  await start();
  const expired = await j('/api/game/result', { method: 'POST', body: { mode: 'daily', score: 80000, lines: 40, maxCombo: 20, duration: 60, day: today, attemptId: slowStart.attemptId } }, slow.token);
  check('2時間を過ぎた予約では記録できない', expired.rewards.daily.recorded === false && expired.rewards.daily.reason === 'expired', JSON.stringify(expired.rewards.daily));
  const slowMe = await j('/api/me', {}, slow.token);
  check('失効した回も0点のまま（1日は消費済み）', slowMe.user.stats.dailyc.score === 0, JSON.stringify(slowMe.user.stats.dailyc));

  // ---- 住人のその日の点は、お題の係数に必ず従う -----------------------------
  const [{ buildRoster, residentDailyScore }, { DAILY_MODIFIERS, dailyModifierOf, jstDayKey }] = await Promise.all([
    import('../server/residents.js'),
    import('../server/daily.js'),
  ]);
  const roster = buildRoster();
  // お題ごとに、その係数が実際に効いているかを1日ずつ確かめる。
  // 生の式の上限は 400 + 21000 + 1500 = 22,900 点。
  const seen = new Set();
  let ghostOk = true, ghostDetail = '';
  for (let d = 0; d < 40 && seen.size < DAILY_MODIFIERS.length; d++) {
    const when = Date.now() + d * 86400000;
    const mod = dailyModifierOf(jstDayKey(when));
    if (seen.has(mod.id)) continue;
    seen.add(mod.id);
    const top = Math.max(...roster.map(r => residentDailyScore(r, when)));
    const cap = Math.ceil(22900 * mod.ghost) + 1;
    if (top > cap) { ghostOk = false; ghostDetail += `${mod.id}: ${top}>${cap} `; }
  }
  check('全お題で住人の点が係数の範囲に収まる', ghostOk && seen.size === DAILY_MODIFIERS.length,
    ghostDetail || `${seen.size}/${DAILY_MODIFIERS.length}種を検査`);
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
