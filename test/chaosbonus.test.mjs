// リポジトリのルートから:  node test/chaosbonus.test.mjs
//
// 🌪️ カオスモードの「コイン1.5倍」が、イベント中だけに掛かることの回帰テスト。
//
// ■ 何が起きていたか
// もともと倍率はモードに直付けだった（`if (mode === 'chaos') coins *= 1.5`）。
// 当時はそれで釣り合っていた ── カオスはイベント中しか押せなかったので、
// 「1.5倍のモードが遊べる」こと自体がイベントの中身だったから。
// v2.48 でカオスの入口を常時開けたとき、この倍率だけが取り残された。結果、
// **いつでも遊べる 1.5倍のモード** ができ、コインの実入りで他の全モードを
// 恒常的に上回っていた（＝他を遊ぶ理由が減る）。
//
// ■ 通したい細い道
//   ・緩すぎる → 常時1.5倍（元の壊れた状態）
//   ・厳しすぎる → イベント中も1.5倍が乗らない。イベントの説明文は
//     「カオスモードが全員に開放！コイン1.5倍」で倍率を約束しているので、
//     開催中に乗らないのは約束破り
//
// ■ ここで見るもの
//   1. イベントなし: chaos と solo が同じスコアで同じコイン
//   2. カオスタイム開催中: chaos だけが 1.5倍（solo は据え置き）
//   3. 別のイベント（コイン祭り = bonus.coin 2倍）中: chaos に 1.5倍は乗らない
//      ── 倍率は「カオスタイム」に紐づく。どのイベントでもいい訳ではない
//   4. イベント終了後: 1 の状態に戻る
//   5. ソースに無条件の分岐が残っていない

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
const DIR = path.join(os.tmpdir(), `bba-chaosbonus-test-${PORT}`);
const ADMIN_PW = 'chaos-bonus-test-pw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      SESSION_SECRET: 'chaosbonus-test', SEED_RESTORE: '0',
      ADMIN_PASSWORD: ADMIN_PW,
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

// 同じ「遊び」を別モードで投げて、返ってきたコインだけを見る。
// 毎回まっさらなアカウントを使う ── 連勝・実績・日次の上限など、
// 履歴に依存する加算を挟ませないため。
const PLAY = { score: 60000, lines: 40, maxCombo: 5, duration: 120, pieces: 90 };
let seq = 0;
async function coinsFor(mode) {
  const name = `かおす検証${++seq}`;
  const reg = await j('/api/register', { method: 'POST', body: { username: name, password: 'pw-chaosbonus-1' } });
  if (!reg.token) throw new Error(`登録できません: ${JSON.stringify(reg)}`);
  const r = await j('/api/game/result', { method: 'POST', body: { ...PLAY, mode } }, reg.token);
  if (r.status !== 200) throw new Error(`結果が通りません (${mode}): ${JSON.stringify(r)}`);
  return (r.rewards && r.rewards.coins) || 0;
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const login = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: ADMIN_PW } });
  if (!login.token) throw new Error(`管理者でログインできません: ${JSON.stringify(login)}`);
  const admin = login.token;
  const eventOn = ty => j('/api/admin/event', { method: 'POST', body: { on: true, type: ty, minutes: 60 } }, admin);
  const eventOff = () => j('/api/admin/event', { method: 'POST', body: { on: false } }, admin);

  // -------------------------------------------------------------------------
  // 1. イベントなし
  // -------------------------------------------------------------------------
  await eventOff();
  const soloOff = await coinsFor('solo');
  const chaosOff = await coinsFor('chaos');
  check('イベントなし: カオスとソロのコインが同じ', chaosOff === soloOff, `solo ${soloOff} / chaos ${chaosOff}`);
  check('イベントなし: カオスに1.5倍が乗っていない', chaosOff < Math.round(soloOff * 1.4), `chaos ${chaosOff}`);

  // -------------------------------------------------------------------------
  // 2. カオスタイム開催中
  // -------------------------------------------------------------------------
  const ev = await eventOn('chaos');
  check('カオスタイムを開催できた', !!(ev.event && ev.event.type === 'chaos'), String(ev.event && ev.event.type));
  const soloOn = await coinsFor('solo');
  const chaosOn = await coinsFor('chaos');
  check('開催中: ソロは据え置き', soloOn === soloOff, `${soloOff} → ${soloOn}`);
  check('開催中: カオスは1.5倍', chaosOn === Math.min(1500, Math.round(soloOn * 1.5)), `solo ${soloOn} / chaos ${chaosOn}`);
  check('開催中: カオスがソロを上回っている', chaosOn > soloOn, `${soloOn} → ${chaosOn}`);

  // -------------------------------------------------------------------------
  // 3. 別のイベント中は乗らない（倍率は「カオスタイム」に紐づく）
  // -------------------------------------------------------------------------
  await eventOn('coinfes');
  const soloCoinfes = await coinsFor('solo');
  const chaosCoinfes = await coinsFor('chaos');
  check('コイン祭り中: ソロにも倍率が乗る', soloCoinfes > soloOff, `${soloOff} → ${soloCoinfes}`);
  check('コイン祭り中: カオスに1.5倍は乗らない', chaosCoinfes === soloCoinfes, `solo ${soloCoinfes} / chaos ${chaosCoinfes}`);

  // -------------------------------------------------------------------------
  // 4. 終わったら元に戻る
  // -------------------------------------------------------------------------
  await eventOff();
  const chaosAfter = await coinsFor('chaos');
  check('終了後: カオスはまた等倍', chaosAfter === soloOff, `${chaosAfter} / solo ${soloOff}`);

  // -------------------------------------------------------------------------
  // 5. ソースに無条件の分岐が残っていない
  // -------------------------------------------------------------------------
  const srcIndex = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  check('無条件の mode === chaos で倍率を掛けていない',
    !/if \(mode === 'chaos'\) coins/.test(srcIndex), '');
  check('倍率はイベントの bonus.chaos を見ている',
    /mode === 'chaos' && bonus\.chaos/.test(srcIndex), '');

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🌪️ カオスの1.5倍コイン\n');
for (const [m, n, d] of results) console.log(`${m} ${n}${d ? `  (${d})` : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
