// Run from the repo root:  node test/gacha.test.mjs  (needs a free port 3106)
// ガチャ2.0の大規模シミュレーション: 天井(40連SSR+確定)・10連SR+確定・
// レート分布・管理者装備の混入なし・ガチャ限定装備の入手・コンプ後のジェム変換。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-gacha-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, SESSION_SECRET: 'gacha-test', POP_SCALE: '0', SEED_RESTORE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
  for (let i = 0; i < 60; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch {} }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();
  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const admin = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
  const u = await j('/api/register', { method: 'POST', body: { username: 'ガチャ神', password: 'pass1234' } });
  check('setup ok', admin.status === 200 && u.status === 200);
  await j(`/api/admin/users/${u.user.id}`, { method: 'POST', body: { grantCoins: 3000000 } }, admin.token);

  // ---- 大規模シミュレーション: 10連 × 260 = 2,600連 ----
  const tally = { N: 0, R: 0, SR: 0, SSR: 0, UR: 0 };
  let ssrGaps = [];        // pulls between SSR+ hits (pity must cap at 40)
  let gap = 0;
  let tenPullViolations = 0;
  let adminGearLeak = 0;
  let limitedHits = 0;
  let completeConversions = 0;
  let lastPity = 0;
  const BATCHES = 260;
  for (let b = 0; b < BATCHES; b++) {
    const d = await j('/api/gacha', { method: 'POST', body: { count: 10 } }, u.token);
    if (d.status !== 200) { check('gacha batch failed', false, JSON.stringify(d).slice(0, 120)); break; }
    let srPlusInBatch = 0;
    for (const r of d.results) {
      tally[r.rarity] = (tally[r.rarity] || 0) + 1;
      if (r.rarity === 'SSR' || r.rarity === 'UR') { ssrGaps.push(gap + 1); gap = 0; } else gap++;
      if (r.rarity !== 'N' && r.rarity !== 'R') srPlusInBatch++;
      if ((r.type === 'cosmetic' || r.type === 'item') && /(_admin$|^item_god_)/.test(r.id || '')) adminGearLeak++;
      if (r.limited) limitedHits++;
      if (r.complete) completeConversions++;
    }
    if (srPlusInBatch === 0) tenPullViolations++;
    lastPity = d.pity ? d.pity.count : -1;
  }
  const total = Object.values(tally).reduce((a, b2) => a + b2, 0);
  const maxGap = Math.max(...ssrGaps, gap);
  check(`simulated ${total} pulls`, total === BATCHES * 10, `total=${total}`);
  check('天井: SSR+ の間隔が40連を超えない', maxGap <= 40, `maxGap=${maxGap} (hits=${ssrGaps.length})`);
  check('10連は毎回SR以上を含む', tenPullViolations === 0, `violations=${tenPullViolations}`);
  check('管理者装備は絶対に出ない', adminGearLeak === 0, `leaks=${adminGearLeak}`);
  check('ガチャ限定装備が実際に出る', limitedHits >= 1, `limited=${limitedHits}`);
  check('コンプ後はSSRがジェムに変換される', completeConversions >= 1, `conversions=${completeConversions}`);
  check('pityカウンターがレスポンスに載る', lastPity >= 0 && lastPity < 40, `pity=${lastPity}`);
  const ssrRate = ((tally.SSR + tally.UR) / total * 100).toFixed(1);
  check('SSR+率が天井込みで妥当(11〜21%)', ssrRate >= 11 && ssrRate <= 21, `SSR+ ${ssrRate}% | N ${tally.N} R ${tally.R} SR ${tally.SR} SSR ${tally.SSR} UR ${tally.UR}`);

  const me = await j('/api/me', {}, u.token);
  check('ガチャ限定3種を全て所持(コンプ)', ['skin_prism', 'board_aurora', 'fx_comet'].every(id => me.user.owned.includes(id)), '');
  check('gachaPulls統計が一致', me.user.stats.gachaPulls === total, `stat=${me.user.stats.gachaPulls}`);

  // ---- ショップ: ガチャ限定は買えない ----
  const buy = await j('/api/shop/buy', { method: 'POST', body: { itemId: 'skin_prism' } }, u.token);
  check('ショップでガチャ限定は購入拒否(403/409)', buy.status === 403 || buy.status === 409, `status=${buy.status}`);

  // ---- 🐛 バグ報告 ----
  const bug1 = await j('/api/bugreport', { method: 'POST', body: { text: '採掘場で地層が上がる瞬間に置くとスコア表示がずれます' } }, u.token);
  const bugGuest = await j('/api/bugreport', { method: 'POST', body: { text: 'ゲストですがチャットの王冠が二重に見えます' } });
  check('バグ報告: ログイン+ゲスト両方OK', bug1.status === 200 && bugGuest.status === 200);
  const bugShort = await j('/api/bugreport', { method: 'POST', body: { text: 'a' } });
  check('バグ報告: 短すぎは拒否', bugShort.status === 400);
  const list = await j('/api/admin/bugreports', {}, admin.token);
  check('管理者が報告一覧を見られる', list.status === 200 && list.reports.length === 2, `n=${list.reports && list.reports.length}`);
  const noAdmin = await j('/api/admin/bugreports', {}, u.token);
  check('一般ユーザーは一覧を見られない', noAdmin.status === 401 || noAdmin.status === 403);
  const done = await j(`/api/admin/bugreports/${list.reports[0].id}`, { method: 'POST', body: { status: 'done' } }, admin.token);
  const del = await j(`/api/admin/bugreports/${list.reports[1].id}`, { method: 'DELETE' }, admin.token);
  const list2 = await j('/api/admin/bugreports', {}, admin.token);
  check('処理済み+削除が反映される', done.status === 200 && del.status === 200 && list2.reports.length === 1 && list2.reports[0].status === 'done', JSON.stringify(list2.reports && list2.reports.map(b => b.status)));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
