// リポジトリのルートから:  node test/onlinelog.test.mjs
//
// 🕒 在席区間ログ（server/battle.js の hello / close）を実サーバーで見る。
//
// ■ なにが欲しかったのか
// user.lastSeen は「最後に見かけた時刻」の1点しか無いので、
// 「誰がいつからいつまでオンラインだったか」には答えられない。
// 区間 [{ at, ms }] と通算セッション数を残す。読み出す API は別担当なので、
// ここで見るのは **記録側の性質** だけ:
//   ① 区間と通算セッション数が積まれる
//   ② 短すぎる区間は積まない（リロードのたびに輪バッファが埋まらない）
//   ③ 複数タブで区間が切れない（最後の1本が閉じたときだけ閉じる）
//   ④ 上限を超えない（db.json は保存のたび丸ごと書き出される）
//   ⑤ バックアップの合流で消えない
//
// 上限と「短すぎる」の基準は環境変数で縮めて回す。既定値は
// server/backup.js の ONLINE_SPANS_MAX と server/battle.js の
// ONLINE_SPAN_MIN_MS（写経せず、下で実体から読む）。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

const PORT = await freePort();
const DIR = path.join(os.tmpdir(), `bba-onlinelog-test-${PORT}`);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// テスト用に縮めた値。
const SPAN_MIN_MS = 800;
const SPANS_MAX = 6;

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'onlinelog-test', SEED_RESTORE: '0',
      ONLINE_SPAN_MIN_MS: String(SPAN_MIN_MS),
      ONLINE_SPANS_MAX: String(SPANS_MAX),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    }
    try { const r = await fetch(`${BASE}/api/status`); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

async function register(username, password) {
  const r = await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(x => x.json());
  if (!r.token) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.token;
}
// stats は publicUser がそのまま返す（自分ぶんだけ）。
async function stats(token) {
  const r = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } }).then(x => x.json());
  return (r.user && r.user.stats) || {};
}

// hello_ok まで待って返す小さなWSクライアント。
function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('hello_ok timeout')), 8000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'hello_ok') { clearTimeout(to); res(ws); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
}
// close が**サーバー側で**処理されるまで待つ。ここを待たずに /api/me を
// 叩くと、まだ区間が閉じていないタイミングを拾って偽の失敗になる。
async function closeAndSettle(ws) {
  await new Promise(res => { ws.on('close', res); ws.close(); });
  await sleep(300);
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();
  const tok = await register('ざいせきさん', 'passw0rd');

  // =========================================================================
  // ① 区間と通算セッション数が積まれる
  // =========================================================================
  {
    const ws = await connect(tok);
    await sleep(SPAN_MIN_MS + 500);
    await closeAndSettle(ws);
    const s = await stats(tok);
    check('① 通算セッション数が数えられている', s.sessions === 1, `sessions=${s.sessions}`);
    check('① 在席区間が1件積まれる', Array.isArray(s.online) && s.online.length === 1,
      JSON.stringify(s.online));
    const span = (s.online || [])[0] || {};
    check('① 区間は開始時刻と長さを持つ',
      Number.isFinite(span.at) && span.at > 0 && Number.isFinite(span.ms) && span.ms >= SPAN_MIN_MS,
      JSON.stringify(span));
  }

  // =========================================================================
  // ② 短すぎる区間は積まない（リロードで輪バッファが埋まらない）
  // =========================================================================
  {
    const ws = await connect(tok);
    await closeAndSettle(ws);   // ほぼ即閉じ
    const s = await stats(tok);
    check('② 短い区間は積まれない', s.online.length === 1, `${s.online.length}件`);
    check('② それでもセッション数は数える', s.sessions === 2, `sessions=${s.sessions}`);
  }

  // =========================================================================
  // ③ 複数タブ／複数端末で区間が切れない
  // =========================================================================
  {
    const before = await stats(tok);
    const w1 = await connect(tok);
    const w2 = await connect(tok);   // 2本目（対戦画面に入ったときと同じ形）
    await sleep(SPAN_MIN_MS + 400);
    await closeAndSettle(w1);        // 1本目だけ閉じる
    const mid = await stats(tok);
    check('③ 1本閉じただけでは区間が閉じない', mid.online.length === before.online.length,
      `${before.online.length} → ${mid.online.length}`);
    check('③ 2本目の接続はセッションとして二重に数えない', mid.sessions === before.sessions + 1,
      `${before.sessions} → ${mid.sessions}`);
    await sleep(400);
    await closeAndSettle(w2);        // 最後の1本
    const after = await stats(tok);
    check('③ 最後の1本が閉じたときに1件だけ積まれる', after.online.length === before.online.length + 1,
      `${before.online.length} → ${after.online.length}`);
    const last = after.online[after.online.length - 1];
    check('③ 区間は2本ぶんをまたいだ長さになる', last.ms >= SPAN_MIN_MS + 700, `${last.ms}ms`);
  }

  // =========================================================================
  // ④ 上限を超えない
  // =========================================================================
  {
    for (let i = 0; i < SPANS_MAX + 3; i++) {
      const ws = await connect(tok);
      await sleep(SPAN_MIN_MS + 150);
      await closeAndSettle(ws);
    }
    const s = await stats(tok);
    check('④ 在席区間は上限を超えない', s.online.length === SPANS_MAX,
      `${s.online.length}件 / 上限 ${SPANS_MAX}`);
    // 押し出しは古いほうから。時系列に並んでいることも一緒に見る。
    const sorted = s.online.every((v, i, a) => i === 0 || a[i - 1].at <= v.at);
    check('④ 古い区間から押し出されている（時系列のまま）', sorted, JSON.stringify(s.online.map(x => x.at)));
  }

  const finalStats = await stats(tok);

  // =========================================================================
  // ⑤ バックアップの合流で消えない（applyRestore を直接呼ぶ）
  // =========================================================================
  {
    // backup.js は import した時点で ONLINE_SPANS_MAX を決めるので、
    // 環境変数を合わせてから読み込む。
    process.env.ONLINE_SPANS_MAX = String(SPANS_MAX);
    const bk = await import('../server/backup.js');
    check('⑤ 上限の定数を実体から読めた', bk.ONLINE_SPANS_MAX === SPANS_MAX, String(bk.ONLINE_SPANS_MAX));

    const mkUser = (over, online, sessions) => ({
      id: 'u1', username: 'ざいせきさん', passHash: 'x', salt: 'y',
      stats: { gamesPlayed: over, totalScore: 0, online, sessions },
    });
    // 「ディスクが飛んでから復元するまでの窓で1回だけ遊んだ」新しいレコードが
    // 進行度で勝つ形。ここで負けた側の在席ログが落ちると、復元したのに
    // 履歴が無い＝いちばん困る結末になる。
    const live = {
      users: { u1: mkUser(9, [{ at: 5000, ms: 1000 }], 1) },
      tokens: {}, revoked: {}, deleted: {}, guilds: {}, news: [], season: null,
      transactions: [], bugreports: [], meta: { createdAt: 1, seedHash: 'CURRENT' },
    };
    const file = {
      users: { u9: mkUser(1, [{ at: 1000, ms: 100 }, { at: 2000, ms: 200 }, { at: 3000, ms: 300 }], 42) },
      tokens: {}, meta: { createdAt: 1 },
    };
    bk.applyRestore(live, file, 'merge');
    const merged = Object.values(live.users)[0].stats;
    const ats = (merged.online || []).map(x => x.at);
    check('⑤ 合流で古い在席区間が消えない', ats.includes(1000) && ats.includes(2000) && ats.includes(3000),
      JSON.stringify(ats));
    check('⑤ 生きている側の区間も残る', ats.includes(5000), JSON.stringify(ats));
    check('⑤ 通算セッション数は多いほうを採る', merged.sessions === 42, String(merged.sessions));

    // 合流でも上限を超えない（細工したファイルで配列を伸ばさせない）。
    const many = Array.from({ length: 500 }, (_, i) => ({ at: 100000 + i, ms: 10 }));
    const live2 = {
      users: { u1: mkUser(9, [{ at: 5000, ms: 1000 }], 1) },
      tokens: {}, revoked: {}, deleted: {}, guilds: {}, news: [], season: null,
      transactions: [], bugreports: [], meta: { createdAt: 1 },
    };
    bk.applyRestore(live2, { users: { u9: mkUser(1, many, 2) }, tokens: {}, meta: {} }, 'merge');
    const m2 = Object.values(live2.users)[0].stats.online;
    check('⑤ 合流後も上限を超えない', m2.length === SPANS_MAX, `${m2.length}件`);
    // 壊れた行（at や ms が無い／0）は持ち込まない。
    const live3 = {
      users: { u1: mkUser(9, [{ at: 5000, ms: 1000 }], 1) },
      tokens: {}, revoked: {}, deleted: {}, guilds: {}, news: [], season: null,
      transactions: [], bugreports: [], meta: { createdAt: 1 },
    };
    bk.applyRestore(live3, {
      users: { u9: mkUser(1, [null, 'x', { at: 0, ms: 5 }, { at: 7000 }, { at: 8000, ms: 80 }], 1) },
      tokens: {}, meta: {},
    }, 'merge');
    const m3 = Object.values(live3.users)[0].stats.online;
    check('⑤ 壊れた行は持ち込まない',
      m3.every(x => Number.isFinite(x.at) && x.at > 0 && Number.isFinite(x.ms) && x.ms > 0)
        && m3.some(x => x.at === 8000),
      JSON.stringify(m3));
  }

  // =========================================================================
  // ⑥ 上限そのものは環境変数で外せない（db.json を無限に伸ばさせない）
  // =========================================================================
  {
    // backup.js は import 時に環境変数を読むので、クエリを変えて別インスタンス
    // として読み直す（test/dbsafety.test.mjs と同じ作法）。
    // ⚠ 指定子は必ずテンプレートリテラルで組むこと。文字列リテラルで
    //   '?spans=…' と書くと api-contract.test.mjs の「import 先が実在するか」
    //   検査がクエリごとファイル名として解決しようとして落ちる。
    let reimport = 0;
    const freshBackup = () => import(`../server/backup.js?spans=${++reimport}`);
    process.env.ONLINE_SPANS_MAX = '999999';
    const huge = await freshBackup();
    check('⑥ 途方もない値でも頭打ちになる', huge.ONLINE_SPANS_MAX <= 200, String(huge.ONLINE_SPANS_MAX));
    delete process.env.ONLINE_SPANS_MAX;
    const def = await freshBackup();
    check('⑥ 既定値は「直近N件」として妥当な範囲',
      def.ONLINE_SPANS_MAX >= 10 && def.ONLINE_SPANS_MAX <= 100, String(def.ONLINE_SPANS_MAX));
  }

  check('（参考）記録された在席区間', true, JSON.stringify(finalStats.online));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
