// リポジトリのルートから:  node test/chaosbonus.test.mjs
//
// 🌪️ カオスモードに **コインの倍率が付いていない** ことの回帰テスト。
//
// ■ 経緯
// もとは倍率がモードに直付けだった（`if (mode === 'chaos') coins *= 1.5`）。
// 当時はそれで釣り合っていた ── カオスはイベント中しか押せなかったので、
// 「1.5倍のモードが遊べる」こと自体がイベントの中身だったから。
// v2.48 で入口を常時開けたとき、この倍率だけが取り残された。結果、
// **いつでも遊べる 1.5倍のモード** ができ、コインの実入りで他の全モードを
// 恒常的に上回っていた（＝他を遊ぶ理由が減る）。
// v2.50.2 でイベント中だけに戻し、v2.53 で「1倍にしてほしい」という指示を受けて
// 倍率そのものをやめた。カオスは他のモードとまったく同じ実入りになる。
//
// ■ 通したい細い道（両側に失敗がある）
//   ・緩すぎる → カオスにだけ倍率が戻る（元の壊れた状態）
//   ・厳しすぎる → 他のモードに掛かるはずのイベント倍率まで、カオスだけ
//     掛からなくなる（コイン祭りの最中にカオスを遊んだ人だけ損をする）
//
// ■ ここで見るもの
//   1. イベントなし: chaos と solo が同じスコアで同じコイン
//   2. カオスタイム開催中でも chaos は等倍のまま
//   3. コイン祭り（bonus.coin 2倍）中は、chaos にも solo と同じ2倍が掛かる
//   4. ソースにカオスへ倍率を掛ける行が1つも残っていない
//   5. カオスタイムのイベントが数字の約束をしていない

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

  // -------------------------------------------------------------------------
  // 2. カオスタイム開催中でも等倍のまま
  // -------------------------------------------------------------------------
  const ev = await eventOn('chaos');
  check('カオスタイムを開催できた', !!(ev.event && ev.event.type === 'chaos'), String(ev.event && ev.event.type));
  const soloOn = await coinsFor('solo');
  const chaosOn = await coinsFor('chaos');
  check('開催中: ソロは据え置き', soloOn === soloOff, `${soloOff} → ${soloOn}`);
  check('開催中: カオスも等倍のまま', chaosOn === soloOn, `solo ${soloOn} / chaos ${chaosOn}`);

  // -------------------------------------------------------------------------
  // 3. 他のモードに掛かる倍率は、カオスにも同じだけ掛かる（塞ぎすぎていない）
  // -------------------------------------------------------------------------
  await eventOn('coinfes');
  const soloCoinfes = await coinsFor('solo');
  const chaosCoinfes = await coinsFor('chaos');
  check('コイン祭り中: ソロに倍率が乗る', soloCoinfes > soloOff, `${soloOff} → ${soloCoinfes}`);
  check('コイン祭り中: カオスにも同じだけ乗る', chaosCoinfes === soloCoinfes, `solo ${soloCoinfes} / chaos ${chaosCoinfes}`);

  // -------------------------------------------------------------------------
  // 4. 終わっても等倍のまま
  // -------------------------------------------------------------------------
  await eventOff();
  const chaosAfter = await coinsFor('chaos');
  check('終了後: カオスは等倍', chaosAfter === soloOff, `${chaosAfter} / solo ${soloOff}`);

  // -------------------------------------------------------------------------
  // 5. ソースに倍率の分岐が残っていない
  // -------------------------------------------------------------------------
  // ⚠ **コメントを落としてから**見る。この修正の経緯を説明するコメントには、
  //   もとのコード（`if (mode === 'chaos') coins *= 1.5`）と「1.5倍」という語が
  //   そのまま引用してある。素のまま正規表現に掛けると **自分の説明文に当たって**
  //   赤くなる（実際に一度なった）。見たいのは動くコードのほうだけ。
  const stripComments = src => src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const srcIndex = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n'));
  check('無条件の mode === chaos で倍率を掛けていない',
    !/if \(mode === 'chaos'\) coins/.test(srcIndex), '');
  check('イベント条件つきの倍率も残っていない',
    !/mode === 'chaos' && bonus\.chaos/.test(srcIndex), '');
  check('カオスにコインを掛ける行が1つも無い',
    !/mode === 'chaos'[^\n]*coins \*/.test(srcIndex), '');

  // -------------------------------------------------------------------------
  // 6. イベントが数字の約束をしていない
  // -------------------------------------------------------------------------
  const srcEvents = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'events.js'), 'utf8').replace(/\r\n/g, '\n'));
  const at = srcEvents.indexOf("id: 'chaos'");
  // 型の終わりは「2字下げの },」。`indexOf('},')` だと `bonus: {},` の中で
  // 先に当たってしまい、いちばん見たい行が切り落とされる（実際に一度なった）。
  const chaosType = srcEvents.slice(at, srcEvents.indexOf('\n  },', at));
  check('前提: カオスタイムの定義を切り出せた', at > 0 && /desc:/.test(chaosType), `${chaosType.length}文字`);
  check('カオスタイムの説明に「1.5倍」が残っていない', !/1\.5/.test(chaosType), chaosType.replace(/\s+/g, ' ').slice(0, 90));
  check('カオスタイムに報酬の bonus が付いていない', /bonus: \{\}/.test(chaosType), '');

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🌪️ カオスのコインは等倍\n');
for (const [m, n, d] of results) console.log(`${m} ${n}${d ? `  (${d})` : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
