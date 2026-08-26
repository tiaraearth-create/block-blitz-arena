// Run from the repo root:  node test/adminevent.test.mjs  (needs a free port 3108)
// 👑 管理者イベント（週1・プレイヤーが枠を予約）の統合テスト。
//
// 押さえたいのは3点:
//   1. 枠の時刻計算がJSTで正しく、翌週へロールオーバーすること
//   2. 予約した人だけが自分の枠の時間に遊べること
//   3. 別々の枠の参加者が「同じ1つの進捗」を共有すること — この形式の核心
// さらに、復元でスケジュールと予約が消えないことも見る（v2.11以前は
// db.meta の許可リストに載っていないキーが復元で丸ごと落ちていた）。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';
import {
  normalizeSchedule, currentOccurrence, reserve, liveSlotFor,
  ensureRun, contribute, bossHpFor, jstDayKey, weekModeId, AE_MODES,
} from '../server/adminevent.js';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const DIR = path.join(os.tmpdir(), 'bba-ae-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'ae-test', SEED_RESTORE: '0', ADMIN_PASSWORD: 'aetestpassword',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(`http://localhost:${PORT}/api/status`); if (r.ok) return; } catch { /* not up yet */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const api = async (p, o = {}) => {
  const r = await fetch(`http://localhost:${PORT}${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, d: await r.json().catch(() => ({})) };
};

// ---------------------------------------------------------------------------
// 1. pure schedule maths (no server needed)
// ---------------------------------------------------------------------------

{
  const bad = normalizeSchedule({ enabled: true, weekday: 6, slots: ['18:00', '18:20'], durationMin: 30 });
  check('枠が重なる設定は拒否される', !!bad.error, bad.error || '');

  const overnight = normalizeSchedule({ enabled: true, weekday: 6, slots: ['23:50'], durationMin: 30 });
  check('日をまたぐ枠は拒否される', !!overnight.error, overnight.error || '');

  const tooMany = normalizeSchedule({ enabled: true, weekday: 6, slots: ['01:00', '03:00', '05:00', '07:00', '09:00', '11:00', '13:00'], durationMin: 30 });
  check('枠は最大6個まで', !!tooMany.error, tooMany.error || '');

  const { schedule } = normalizeSchedule({ enabled: true, weekday: 6, slots: ['21:00', '18:00', '19:00'], durationMin: 30 });
  check('枠は時刻順に整列される', schedule.slots.join(',') === '18:00,19:00,21:00', schedule.slots.join(','));

  // 2026-08-26 12:00 JST is a Wednesday; the next Saturday is 2026-08-29.
  const wed = Date.UTC(2026, 7, 26, 3, 0);
  const occ = currentOccurrence(schedule, wed);
  check('次の開催日が正しく求まる(土曜)', occ.dayKey === '2026-08-29', occ.dayKey);
  check('枠の絶対時刻がJSTで一致する', jstDayKey(occ.slots[0].startsAt) === '2026-08-29', jstDayKey(occ.slots[0].startsAt));

  // Past the final slot, the answer must be NEXT week — not "closed".
  const after = currentOccurrence(schedule, occ.closesAt + 1000);
  check('最終枠を過ぎたら翌週に繰り上がる', (after.opensAt - occ.opensAt) === 7 * 86400000, `+${(after.opensAt - occ.opensAt) / 86400000}日`);

  // モードを足しても壊れないよう、数は決め打ちしない。
  // 「全種類を1周してから最初に戻る」ことだけを見る。
  const N = AE_MODES.length;
  const modes = Array.from({ length: N + 1 }, (_, w) => weekModeId({ rotation: 'auto' }, occ.opensAt + w * 7 * 86400000));
  check(`モードは週替わりで${N}種を巡回する`,
    new Set(modes.slice(0, N)).size === N && modes[0] === modes[N], modes.join('→'));

  // Reserving, and who may actually play.
  const user = { id: 'u1', username: 'A', role: 'user' };
  reserve(user, occ, 1, wed);
  check('予約が保存される', user.adminEvent.slotId === 1 && user.adminEvent.dayKey === occ.dayKey, JSON.stringify(user.adminEvent && { s: user.adminEvent.slotId }));
  check('枠の前は入場できない', !liveSlotFor(schedule, user, wed));
  check('枠の中は入場できる', !!liveSlotFor(schedule, user, occ.slots[1].startsAt + 60000));
  check('枠の後は入場できない', !liveSlotFor(schedule, user, occ.slots[1].endsAt + 1000));
  const other = { id: 'u2', username: 'B', role: 'user' };
  check('予約していない人は入場できない', !liveSlotFor(schedule, other, occ.slots[1].startsAt + 60000));

  // The shared world: two people in DIFFERENT slots hit one boss.
  const db = { meta: {}, users: {} };
  const invOcc = { ...occ, modeId: 'invasion' };
  const run = ensureRun(db, invOcc, 2);
  check('ボスHPは参加人数でスケールする', run.maxHp === bossHpFor(2), `${run.maxHp} vs ${bossHpFor(2)}`);
  const d1 = contribute(run, { id: 'u1', username: 'A' }, 40000);
  const d2 = contribute(run, { id: 'u2', username: 'B' }, 50000);
  check('別々の枠の2人が同じHPを削る', run.hp === run.maxHp - 90000, `hp=${run.hp} max=${run.maxHp}`);
  check('与ダメージが返る', d1.damage === 40000 && d2.damage === 50000, `${d1.damage}/${d2.damage}`);
  const d3 = contribute(run, { id: 'u1', username: 'A' }, run.maxHp);
  check('削り切ると討伐フラグが立つ', d3.killed && run.hp === 0 && run.killedBy === 'A', `killedBy=${run.killedBy}`);
  check('討伐後の追撃はHPを負にしない', contribute(run, { id: 'u2', username: 'B' }, 9999).damage === 0, `hp=${run.hp}`);
}

// ---------------------------------------------------------------------------
// 2. the live server
// ---------------------------------------------------------------------------

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const admin = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: 'aetestpassword' } });
  check('管理者ログイン', admin.status === 200, admin.d.error || '');
  const atk = admin.d.token;

  // Schedule TODAY, with a slot that opened a minute ago → live right now.
  const pad = n => String(n).padStart(2, '0');
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  // 実時刻に依存するので、分の引き算ではなく「1分前」の実インスタントから
  // 組み立てる（`HH:(MM-1)` は MM=0 のとき HH:00 になり、30分枠だと実行時刻に
  // よっては既に終わっていた — 分によって落ちるテストになっていた）。
  const oneMinAgo = new Date(Date.now() - 60000 + 9 * 3600000);
  const liveMin = oneMinAgo.getUTCHours() * 60 + oneMinAgo.getUTCMinutes();
  const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  // 枠は JST の同じ日に収まっていないとサーバーに弾かれる（予約日と
  // 開催日がズレないための仕様）。23時台に流すと 30分枠が入らないので、
  // 深夜は枠を短くする。ここを固定30分にしていたので、夜遅くに走らせた
  // ときだけ全部落ちるテストになっていた。
  const DUR = Math.min(30, 24 * 60 - liveMin);
  // 2枠目は DUR 以上あけ、かつ日をまたがないところに置く。
  let laterMin = liveMin + 120;
  if (laterMin + DUR > 24 * 60) laterMin = liveMin + DUR;
  const twoSlots = laterMin + DUR <= 24 * 60;   // 深夜すぎると2枠は作れない
  if (DUR < 5) {
    // 日付が変わる直前。ここだけは実時刻を動かさない限り再現できない。
    console.log('  （JST 23:55以降のためスキップ。数分後に再実行してください）');
    for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
    await stop();
    process.exit(0);
  }
  const liveAt = hhmm(liveMin);
  const later = hhmm(laterMin);
  const slots = twoSlots ? [liveAt, later] : [liveAt];
  if (!twoSlots) console.log('  （JSTが深夜のため2枠目のテストはスキップ）');
  let r = await api('/api/admin/adminevent', {
    method: 'POST', token: atk,
    body: { enabled: true, weekday: oneMinAgo.getUTCDay(), slots, durationMin: DUR, rotation: 'invasion', rewardMult: 2 },
  });
  check('スケジュールを保存できる', r.status === 200, r.d.error || `slots=${slots.join(',')}`);

  r = await api('/api/adminevent');
  check('未ログインでも予定は見える', r.status === 200 && !!r.d.event, r.d.event ? r.d.event.dayKey : 'null');
  check('最初のプレイ前でも共有HPが見える', !!(r.d.event && r.d.event.world && r.d.event.world.maxHp > 0), `maxHp=${r.d.event && r.d.event.world && r.d.event.world.maxHp}`);

  const p1 = await api('/api/register', { method: 'POST', body: { username: '早番さん', password: 'password123' } });
  const p2 = await api('/api/register', { method: 'POST', body: { username: '遅番さん', password: 'password123' } });
  const t1 = p1.d.token, t2 = p2.d.token;

  // Nobody may play without a reservation.
  r = await api('/api/adminevent/result', { method: 'POST', token: t1, body: { score: 5000, duration: 120 } });
  check('予約なしでは遊べない(403)', r.status === 403, r.d.error || '');

  // 早番さん takes the live slot; 遅番さん takes the later one.
  r = await api('/api/adminevent/reserve', { method: 'POST', token: t1, body: { slotId: 0 } });
  check('早番さんが開催中の枠を予約', r.status === 200 && r.d.event.mine.slotId === 0, r.d.error || '');
  if (twoSlots) {
    r = await api('/api/adminevent/reserve', { method: 'POST', token: t2, body: { slotId: 1 } });
    check('遅番さんが後の枠を予約', r.status === 200 && r.d.event.mine.slotId === 1, r.d.error || '');
    r = await api('/api/adminevent/result', { method: 'POST', token: t2, body: { score: 5000, duration: 120 } });
    check('自分の枠が来る前は遊べない(403)', r.status === 403, r.d.error || '');
  }

  const before = (await api('/api/me', { token: t1 })).d.user.coins;
  r = await api('/api/adminevent/result', { method: 'POST', token: t1, body: { score: 9000, lines: 30, maxCombo: 5, duration: 120, pieces: 60 } });
  check('自分の枠では遊べる', r.status === 200, r.d.error || '');
  check('与ダメージが共有HPに乗る', r.d.event.world.hp === r.d.event.world.maxHp - 9000, `hp=${r.d.event.world.hp}/${r.d.event.world.maxHp}`);
  check('🎁お宝ラッシュが上乗せされる', r.d.chest.mult === 2 && r.d.chest.coins > 0, JSON.stringify(r.d.chest));
  const after = (await api('/api/me', { token: t1 })).d.user.coins;
  check('コインが実際に増える', after > before, `${before}→${after}`);

  // Anti-cheat: the same rate ceiling the normal result path uses.
  r = await api('/api/adminevent/result', { method: 'POST', token: t1, body: { score: 999999, duration: 10 } });
  check('スコアレート上限でクリップされる', r.d.delta.gained <= 10 * 500, `gained=${r.d.delta.gained}`);

  // /api/status carries the personalised block (this is what the banner reads).
  r = await api('/api/status', { token: t1 });
  check('/api/status に自分の枠が載る', !!(r.d.adminEvent && r.d.adminEvent.live && r.d.adminEvent.mine), JSON.stringify(r.d.adminEvent && r.d.adminEvent.mine));
  if (twoSlots) {
    r = await api('/api/status', { token: t2 });
    check('枠が来ていない人には live が出ない', !!(r.d.adminEvent && !r.d.adminEvent.live && r.d.adminEvent.mine), '');
  }

  // Switching the mode mid-day must not keep grinding the old mode's state.
  r = await api('/api/admin/adminevent', { method: 'POST', token: atk, body: { rotation: 'communal' } });
  check('モードを共同作業に切替', r.status === 200, r.d.error || '');
  r = await api('/api/adminevent/result', { method: 'POST', token: t1, body: { score: 30000, duration: 180 } });
  check('モード切替で進捗が作り直される', r.d.event.world.tiers.length > 0 && r.d.event.world.total === 30000,
    `tiers=${r.d.event.world.tiers.length} total=${r.d.event.world.total}`);

  // Not there yet must not be reported as "already collected".
  r = await api('/api/adminevent/claim', { method: 'POST', token: t1 });
  check('未達成なら「まだ届いていない」と言う', r.status === 409 && /まだ/.test(r.d.error || ''), r.d.error || '');

  // 500/sec is the score ceiling, so 180s runs are how the gauge actually fills.
  for (let i = 0; i < 3; i++) r = await api('/api/adminevent/result', { method: 'POST', token: t1, body: { score: 90000, duration: 180 } });
  check('段階目標が達成される', r.d.event.world.tiersReached >= 1, `reached=${r.d.event.world.tiersReached} total=${r.d.event.world.total} tier1=${r.d.event.world.tiers[0].at}`);

  r = await api('/api/adminevent/claim', { method: 'POST', token: t1 });
  check('段階報酬を受け取れる', r.status === 200 && r.d.reward.coins > 0, JSON.stringify(r.d.reward || r.d.error));
  r = await api('/api/adminevent/claim', { method: 'POST', token: t1 });
  check('二重受け取りはできない', r.status === 409 && /済み/.test(r.d.error || ''), r.d.error || '');
  r = await api('/api/adminevent/claim', { method: 'POST', token: t2 });
  check('参加していない人は受け取れない', r.status === 403, r.d.error || '');

  // Backup / restore: the schedule lives in db.meta and the reservation on the
  // user record — both used to be dropped by a merge restore.
  const backup = (await api('/api/admin/backup', { token: atk })).d;
  check('バックアップにスケジュールが入る', !!(backup.meta && backup.meta.adminEvent), '');
  const stored = Object.values(backup.users).find(u => u.username === '早番さん');
  check('バックアップに予約が入る(ユーザーレコード側)', !!(stored && stored.adminEvent), stored && stored.adminEvent ? stored.adminEvent.dayKey : '');

  r = await api('/api/admin/restore', {
    method: 'POST', token: atk,
    body: { data: backup, mode: 'merge', password: 'aetestpassword' },
  });
  check('マージ復元が通る', r.status === 200, r.d.error || '');
  r = await api('/api/status', { token: t1 });
  check('復元後もスケジュールが残る', !!(r.d.adminEvent && r.d.adminEvent.dayKey), '');
  check('復元後も予約が残る', !!(r.d.adminEvent && r.d.adminEvent.mine), '');

  // Turning it off hides it from everyone.
  r = await api('/api/admin/adminevent', { method: 'POST', token: atk, body: { enabled: false } });
  r = await api('/api/status', { token: t1 });
  check('OFFにすると誰にも見えなくなる', !r.d.adminEvent, JSON.stringify(r.d.adminEvent));

  check('専用モードがすべて日英そろっている',
    AE_MODES.length >= 3 && AE_MODES.every(m => m.id && m.icon && m.name && m.nameEn && m.desc && m.descEn && m.tagline && m.taglineEn),
    AE_MODES.map(m => m.id).join(','));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
