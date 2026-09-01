// リポジトリのルートから:  node test/idempotent.test.mjs
//
// 🧾 結果送信（POST /api/game/result）が冪等であること。
//
// ■ 何が壊れていたか
// 同じ結果を2回受けると **2回ぶん加算していた**。効いていたのは2つ:
//   ・通信が不安定なときの再送（応答だけ落ちた回）で、こっそり報酬が二重になる
//   ・「オフライン中の記録をあとから送る」仕組みを入れられない原因になる
//     （入れると、二重加算が“事故のとき”から“毎回”に格上げされる）
//
// ■ 通したい細い道（ここも両側に失敗がある）
//   ・緩すぎる → 同じ runId を弾かず、再送で報酬が二重に入る
//   ・厳しすぎる → runId を持たない古いクライアントを 4xx で切ってしまう
//                  （＝アップデート前の端末で、その回の報酬が全部消える）
// 通した道: runId があれば覚えて前回の応答をそのまま返す。無ければ従来どおり。
//
// ■ ここで見るもの
//   A. サーバー（実際に立てて HTTP で叩く）
//      1. 同じ runId を2回 → コイン/XP/プレイ回数が1回ぶんしか増えない
//      2. 2回目の応答が1回目と同じ内容
//      3. runId 無しは従来どおり毎回処理される
//      4. 中身を変えて同じ runId で送っても、前回の結果が返る（＝連投の口を塞ぐ）
//      5. 覚える件数の上限を超えると古い runId から落ちる
//         （落ちたあとは再加算される＝上限は本当に効いている）
//   B. 数字としての性質（実装から読み取る。写経しない）
//      上限と寿命が「現実的な再送の窓」より充分に広いこと、そして
//      クライアント側の控えの寿命がサーバー側の寿命の**内側**にあること。
//   C. クライアント（public/js/net.js の控え送り）
//      圏外で落ちた結果を控え、つながったら送ること。そして
//      **控えを手で書き換えても報酬は増えない**こと（localStorage は
//      プレイヤーが自由に書ける ── そこが捏造の経路にならないかを実際に試す）。

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
// ⚠ 保存先にポートを混ぜる。固定名だと、run-all が同時に2本走ったときに
// 両方が同じフォルダを使い、片方の rmSync がもう片方の db.json を消す。
const DIR = path.join(os.tmpdir(), `bba-idempotent-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 覚える件数の上限。既定（2000件）を実際に超えさせるには結果送信のレート上限
// （250件/時）に何時間もかかるので、テストの機体だけ下げて挙動を見る。
// 既定値そのものが充分に大きいかは B で別に検算する。
const RUN_MAX = 4;

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

async function post(p, body, token) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  return { status: r.status, data };
}
async function get(p, token) {
  const r = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  return { status: r.status, data };
}

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'idempotent-test', SEED_RESTORE: '0',
      RESULT_RUN_MAX: String(RUN_MAX),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

// 1プレイぶんの、正直な結果。realPlay（1,000点以上・20秒以上）を満たす形。
const RUN = (extra = {}) => ({ mode: 'solo', score: 1500, lines: 6, duration: 25, ...extra });
const walletOf = u => ({ coins: u.coins, xp: u.xp, games: u.stats.gamesPlayed, bpXp: u.battlePass.xp });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const reg = async name => {
    const r = await post('/api/register', { username: name, password: 'pw-idem-0001' });
    if (!r.data.token) throw new Error(`登録できません: ${JSON.stringify(r.data)}`);
    return r.data.token;
  };
  const meOf = async token => (await get('/api/me', token)).data.user;

  // =========================================================================
  // A-1/A-2. 同じ runId を2回 → 1回ぶんしか増えない・応答は同じ
  // =========================================================================
  const tok = await reg('ふくそう');
  const before = walletOf(await meOf(tok));

  const first = await post('/api/game/result', RUN({ runId: 'run-aaa-0001' }), tok);
  check('1回目が通る', first.status === 200 && !!first.data.rewards, `status=${first.status}`);
  const afterFirst = walletOf(await meOf(tok));
  check('1回目でちゃんと加算される',
    afterFirst.games === before.games + 1 && afterFirst.coins > before.coins,
    `🪙${before.coins}→${afterFirst.coins} / ${before.games}→${afterFirst.games}戦`);

  const second = await post('/api/game/result', RUN({ runId: 'run-aaa-0001' }), tok);
  const afterSecond = walletOf(await meOf(tok));
  check('2回目も 200 で返る（エラーにしない＝冪等）', second.status === 200, `status=${second.status}`);
  check('A-1 同じ runId の2回目で報酬が増えない', same(afterFirst, afterSecond),
    `${JSON.stringify(afterFirst)} → ${JSON.stringify(afterSecond)}`);
  check('A-2 2回目の応答が1回目と同じ内容',
    same(first.data.rewards, second.data.rewards) && first.data.replaySaved === second.data.replaySaved,
    `1回目 ${JSON.stringify(first.data.rewards)}`);
  // user だけは「いまの姿」で返す（前回の写しを返すと、その間の買い物などが
  // 画面上で巻き戻って見える）。冪等の対象は報酬であって残高表示ではない。
  check('2回目の応答にも今の user が載っている',
    !!second.data.user && second.data.user.coins === afterSecond.coins, '');

  // =========================================================================
  // A-3. runId 無しは従来どおり（古いクライアントを切らない）
  // =========================================================================
  const noIdA = await post('/api/game/result', RUN(), tok);
  const afterNo1 = walletOf(await meOf(tok));
  const noIdB = await post('/api/game/result', RUN(), tok);
  const afterNo2 = walletOf(await meOf(tok));
  check('A-3 runId 無しは 200 で通る', noIdA.status === 200 && noIdB.status === 200, '');
  check('A-3 runId 無しは毎回処理される（従来どおり）',
    afterNo1.games === afterSecond.games + 1 && afterNo2.games === afterNo1.games + 1,
    `${afterSecond.games} → ${afterNo1.games} → ${afterNo2.games}戦`);

  // =========================================================================
  // A-4. 中身を変えて同じ runId → 前回の結果が返る
  //      ここを「中身も一致したときだけ冪等」にすると、runId を固定したまま
  //      中身だけ変えて連投する経路が残ってしまう。
  // =========================================================================
  const rich = await post('/api/game/result', RUN({ runId: 'run-aaa-0001', score: 999999, lines: 4000 }), tok);
  const afterRich = walletOf(await meOf(tok));
  check('A-4 中身を変えても同じ runId なら前回の結果が返る',
    rich.status === 200 && same(rich.data.rewards, first.data.rewards), '');
  check('A-4 中身を変えた連投で報酬が増えない',
    same(afterNo2, afterRich), `${JSON.stringify(afterNo2)} → ${JSON.stringify(afterRich)}`);

  // =========================================================================
  // A-5. 上限を超えると古い runId から落ちる
  //      落ちたあとは再加算される ＝ 上限が本当に効いていることの裏取り。
  //      （このサーバーは RESULT_RUN_MAX=4 で起動している）
  // =========================================================================
  let games = afterRich.games;
  for (let i = 0; i < RUN_MAX; i++) {
    const r = await post('/api/game/result', RUN({ runId: `run-push-${i}` }), tok);
    check(`A-5 押し出し用の送信 ${i + 1}/${RUN_MAX} が通る`, r.status === 200, `status=${r.status}`);
  }
  const afterPush = walletOf(await meOf(tok));
  check('A-5 押し出し用の送信がすべて加算されている',
    afterPush.games === games + RUN_MAX, `${games} → ${afterPush.games}戦`);
  // ここまでで、いちばん古い run-aaa-0001 は上限からあふれて忘れられている。
  const revived = await post('/api/game/result', RUN({ runId: 'run-aaa-0001' }), tok);
  const afterRevived = walletOf(await meOf(tok));
  check('A-5 上限からあふれた runId は忘れられ、もう一度処理される',
    revived.status === 200 && afterRevived.games === afterPush.games + 1,
    `${afterPush.games} → ${afterRevived.games}戦`);
  // 直近の runId は覚えたまま（＝落ちるのは古いほうだけ）。
  const stillKnown = await post('/api/game/result', RUN({ runId: `run-push-${RUN_MAX - 1}` }), tok);
  const afterStill = walletOf(await meOf(tok));
  check('A-5 新しい runId は覚えたまま（落ちるのは古いほうだけ）',
    stillKnown.status === 200 && afterStill.games === afterRevived.games,
    `${afterRevived.games} → ${afterStill.games}戦`);

  // 別人の runId とはぶつからない（キーは userId ごとに分けてある）。
  const tok2 = await reg('となりのひと');
  const otherBefore = walletOf(await meOf(tok2));
  const other = await post('/api/game/result', RUN({ runId: 'run-aaa-0001' }), tok2);
  const otherAfter = walletOf(await meOf(tok2));
  check('別の人が同じ runId を使っても、その人の結果は普通に処理される',
    other.status === 200 && otherAfter.games === otherBefore.games + 1, '');

  // =========================================================================
  // B. 数字としての性質 — 実装から読み取る（写経しない）
  // =========================================================================
  const SRV = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const NET = fs.readFileSync(path.join(ROOT, 'public', 'js', 'net.js'), 'utf8');

  const maxM = SRV.match(/const RESULT_RUN_MAX = Number\(process\.env\.RESULT_RUN_MAX\)[\s\S]{0,140}?:\s*(\d+);/);
  check('B 覚える件数の既定を実装から読めた', !!maxM,
    maxM ? `${maxM[1]}件` : 'RESULT_RUN_MAX の形が変わった — このテストを実装に合わせて直すこと');
  const ttlM = SRV.match(/const RESULT_RUN_TTL_MS = (\d+) \* 60 \* 60 \* 1000/);
  check('B 覚える寿命を実装から読めた', !!ttlM,
    ttlM ? `${ttlM[1]}時間` : 'RESULT_RUN_TTL_MS の形が変わった');
  const rateM = SRV.match(/rateLimit\(`resulth:\$\{req\.user\.id\}`,\s*(\d+),/);
  check('B 1時間あたりの送信上限を実装から読めた', !!rateM,
    rateM ? `${rateM[1]}件/時` : 'resulth のレート上限の形が変わった');

  const RUN_DEFAULT = maxM ? Number(maxM[1]) : NaN;
  const TTL_H = ttlM ? Number(ttlM[1]) : NaN;
  const PER_HOUR = rateM ? Number(rateM[1]) : NaN;
  // 「現実的な再送の窓」より充分に大きいか。1人がレート上限いっぱいに投げ続けても
  // 数時間ぶんの runId を覚えていられること（再送は普通は数秒〜数分の話）。
  check('B 覚える件数が、再送の窓より桁違いに広い',
    RUN_DEFAULT / PER_HOUR >= 2, `${RUN_DEFAULT}件 ÷ ${PER_HOUR}件/時 = 全速力でも${(RUN_DEFAULT / PER_HOUR).toFixed(1)}時間ぶん`);
  check('B 覚える寿命が半日以上ある', TTL_H >= 12, `${TTL_H}時間`);
  // db.json は保存のたび丸ごと書き出す。1件300B前後として、上限に張り付いても
  // 復元の上限（RESTORE_LIMIT_MB）の一部で収まること。
  const limitM = SRV.match(/RESTORE_LIMIT_MB\s*=\s*(\d+)/);
  const limitMb = limitM ? Number(limitM[1]) : 4;
  check('B 上限まで溜まっても db.json が復元の天井を圧迫しない',
    (RUN_DEFAULT * 300) / (1024 * 1024) <= limitMb * 0.25,
    `${((RUN_DEFAULT * 300) / (1024 * 1024)).toFixed(2)}MB ≦ 天井 ${limitMb}MB の1/4`);

  // クライアントの控えの寿命は、サーバーが runId を覚えている寿命の**内側**。
  // 外に出ると「サーバーが忘れたあとに届く」＝二重加算になりうる。
  const qTtlM = NET.match(/const RESULT_QUEUE_TTL_MS = (\d+) \* 60 \* 60 \* 1000/);
  check('B クライアントの控えの寿命を実装から読めた', !!qTtlM, qTtlM ? `${qTtlM[1]}時間` : '');
  check('B 控えの寿命がサーバーの記憶の内側にある',
    !!qTtlM && Number(qTtlM[1]) < TTL_H, `控え ${qTtlM ? qTtlM[1] : '?'}時間 < サーバー ${TTL_H}時間`);

  // =========================================================================
  // C. クライアント（public/js/net.js）の控え送り
  // =========================================================================
  // ブラウザの持ち物を最小限だけ用意して、本物の net.js を読み込む。
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  if (!globalThis.navigator || !globalThis.navigator.language) {
    try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'ja' }, configurable: true }); }
    catch { /* Node 側の navigator をそのまま使う */ }
  }
  globalThis.window = { addEventListener() {}, dispatchEvent() { return true; } };
  // net.js は '/api/...' という相対パスで叩く（ブラウザなら今いるオリジン）。
  // Node の fetch は基準が無いので、テストの機体に向ける薄い包みを噛ませる。
  const nodeFetch = globalThis.fetch;
  const baseFetch = (input, init) => nodeFetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);
  globalThis.fetch = baseFetch;

  const net = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'net.js')).href);
  const tok3 = await reg('けんがい');
  net.setToken(tok3);
  await net.refreshMe();
  // refreshMe の成功で「つながったら送る」が1本予約される（控えは空なので
  // 空振りする）。それが自分の検査に混ざらないよう、先に済ませておく。
  await sleep(1500);
  const cBefore = walletOf(await meOf(tok3));

  // --- 圏外にする -----------------------------------------------------------
  globalThis.fetch = () => Promise.reject(new TypeError('offline'));
  let threw = false;
  try {
    await net.api('/api/game/result', { method: 'POST', body: RUN({ runId: 'off-run-1' }) });
  } catch { threw = true; }
  check('C 圏外の結果送信はエラーになる（勝手に成功扱いしない）', threw, '');
  check('C 圏外の結果が控えに入る', net.queuedResultCount() === 1, `${net.queuedResultCount()}件`);

  // ⚠ ここがこの仕組みの生命線: 冪等キーの無い結果は控えない。
  try {
    await net.api('/api/game/result', { method: 'POST', body: RUN() });
  } catch { /* 圏外なので当然落ちる */ }
  check('C runId の無い結果は控えない（控えたら再送＝二重加算に戻る）',
    net.queuedResultCount() === 1, `${net.queuedResultCount()}件`);

  // --- つながった -----------------------------------------------------------
  globalThis.fetch = baseFetch;
  const sent = await net.flushResultQueue();
  const cAfter = walletOf(await meOf(tok3));
  check('C つながったら控えを送る', sent === 1 && net.queuedResultCount() === 0, `送信${sent}件 / 残り${net.queuedResultCount()}件`);
  check('C 控えの結果が1回ぶんだけ入る', cAfter.games === cBefore.games + 1,
    `${cBefore.games} → ${cAfter.games}戦`);

  // --- 控えを手で書き換えたら？ ---------------------------------------------
  // localStorage はプレイヤーが自由に書ける。同じ runId のまま中身を盛って
  // 送り直しても、サーバーが前回の結果を返すので1円も増えない。
  store.set('bba_result_queue', JSON.stringify([{
    uid: net.session.user.id, at: Date.now(),
    body: RUN({ runId: 'off-run-1', score: 999999, lines: 4000 }),
  }]));
  const sent2 = await net.flushResultQueue();
  const cForged = walletOf(await meOf(tok3));
  check('C 控えを書き換えて送り直しても報酬は増えない',
    sent2 === 1 && same(cAfter, cForged), `${JSON.stringify(cAfter)} → ${JSON.stringify(cForged)}`);

  // 期限切れの控えは送らない（サーバーが runId を忘れたあとに届くのを防ぐ）。
  store.set('bba_result_queue', JSON.stringify([{
    uid: net.session.user.id, at: Date.now() - (Number(qTtlM ? qTtlM[1] : 12) + 1) * 60 * 60 * 1000,
    body: RUN({ runId: 'off-run-old' }),
  }]));
  check('C 期限切れの控えは読み捨てる', net.queuedResultCount() === 0, `${net.queuedResultCount()}件`);
  const sent3 = await net.flushResultQueue();
  const cOld = walletOf(await meOf(tok3));
  check('C 期限切れの控えは送らない', sent3 === 0 && same(cForged, cOld), '');
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${failed === 0 ? '✅' : '❌'} idempotent: ${results.length - failed} 件成功 / ${failed} 件失敗`);
