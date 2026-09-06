// リポジトリのルートから:  node test/progress.test.mjs
//
// 🧱 「進行できなくなる／記録が消える」系の回帰テスト。
//
// どれも “遊んだのに残らない・遊べないまま終わる” 種類の不具合で、
// 見た目には何も壊れていないので、画面を見ているだけでは気づけない。
//
//   A. ロイヤルの報酬が**接続が生きているかで**決まっていた。切断ハンドラから
//      同じ関数を呼ぶので、回線が切れた人は3分走った報酬も記録も一切もらえない。
//   B. デイリーの録画に**引き直し（リロール）が残っていない**。引き直した回は
//      再生すると手札がズレて、本人の名前で別の走りが流れていた。
//   C. ボスの呪縛が、すでに凍っている枠を空き扱いして数えていたので、
//      二重呪縛と重なると**手札3枠すべてが凍って**操作できなくなった。
//   D. しおりが「ここまで遊んだ長さ」を預けていない。続きは duration が
//      数十秒として送られ、サーバーのレート上限でスコアが切り詰められ、
//      サバイバルは到達ウェーブが realPlay の門に弾かれて記録されなかった。
//   E. 大会のブラケット画面の「離脱する」に onclick が付いていなかった
//      （showModal の戻り値を受けずに m.querySelector と書いていた）。
//   F. サーバー更新の確定送信が、AI対戦を**その瞬間の点差**で締めていた。
//      先行していれば「鬼に勝った」ことになり、バッジも解禁も告知も付いた。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';
import { sanitizeReplay } from '../server/routes/daily.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-progress-test-${PORT}`);
const ROYALE_SECS = 30;
const GRACE_MS = 1200;   // ロイヤルの切断確定までの猶予（テスト用に短くする）
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なしもある */ }
  return { status: r.status, ...d };
};

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
// 説明のコメントを検査に引っかけない（自分の書いた文が根拠になってしまう）。
const stripComments = src => src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'progress-test', SEED_RESTORE: '0', ROYALE_SECS: String(ROYALE_SECS),
      // 🔌 v2.63 でロイヤルにも再接続の猶予が入った（1v1と同じ RECONNECT_GRACE_MS）。
      //    ここで見たいのは「切断でも報酬が入るか」なので、猶予を短くして
      //    確定を待つ ── 猶予そのものは royale の別テストが見ている。
      RECONNECT_GRACE_MS: String(GRACE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(proc, BASE);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

function makeClient(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws,
    inbox,
    send: o => ws.send(JSON.stringify(o)),
    last: type => (inbox[type] || []).slice(-1)[0] || null,
    wait: (type, ms = 8000) => new Promise((res, rej) => {
      const had = (inbox[type] || []).length;
      const to = setTimeout(() => { clearInterval(iv); rej(new Error(`timeout ${type}`)); }, ms);
      const iv = setInterval(() => {
        const list = inbox[type] || [];
        if (list.length > had) { clearInterval(iv); clearTimeout(to); res(list[list.length - 1]); }
      }, 60);
    }),
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => c.send({ type: 'hello', token }));
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 8000); res(c); })().catch(rej);
  });
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });

  // ===========================================================================
  // B. デイリーの録画に引き直しが残るか（サーバー不要・関数を直接叩く）
  // ===========================================================================
  const withRr = sanitizeReplay({
    seed: 7,
    moves: [
      { h: 0, r: 0, c: 0, t: 100 },
      { rr: 1, t: 500 },
      { h: 2, r: 3, c: 4, t: 900 },
    ],
  });
  check('B-1 引き直しの印が録画に残る',
    !!withRr && withRr.moves.length === 3 && withRr.moves[1].rr === 1,
    withRr ? JSON.stringify(withRr.moves) : 'null');
  check('B-2 引き直しの印は時刻だけを持つ（盤面の座標を持たない）',
    !!withRr && withRr.moves[1].h === undefined && withRr.moves[1].t === 500,
    withRr ? JSON.stringify(withRr.moves[1]) : '');
  check('B-3 前後の着手はそのまま残る',
    !!withRr && withRr.moves[0].h === 0 && withRr.moves[2].c === 4, '');
  // 壊れた入力は今までどおり弾く（印を足したせいで検査が緩くなっていないか）。
  check('B-4 枠番号が範囲外の着手は今までどおり弾く',
    sanitizeReplay({ seed: 1, moves: [{ h: 9, r: 0, c: 0, t: 1 }] }) === null, '');
  check('B-5 盤外の座標も今までどおり弾く',
    sanitizeReplay({ seed: 1, moves: [{ h: 0, r: 99, c: 0, t: 1 }] }) === null, '');

  const modesSrc = read('public/js/modes.js');
  const modes = stripComments(modesSrc);
  check('B-6 引き直しを録画に足す口がある（recordReroll）',
    /recordReroll\(\)\s*\{[\s\S]{0,200}?moves\.push\(\{ rr: 1/.test(modes), '');
  check('B-7 引き直しの実行からその口を呼んでいる',
    /currentMode\.recordReroll === 'function'\) currentMode\.recordReroll\(\)/.test(modes), '');
  check('B-8 再生側が印を見て引き直す（ReplayMode）',
    /if \(mv\.rr\) \{[\s\S]{0,120}?e\.reroll\(\);/.test(modes), '');
  check('B-9 残像レースも同じ印を見る',
    /if \(mv\.rr\) \{[\s\S]{0,140}?this\.ghostEngine\.reroll\(\);/.test(modes), '');
  check('B-10 クライアント側の削り落としも印を通す',
    /if \(m\.rr\) \{ moves\.push\(\{ rr: 1/.test(modes), '');

  // ===========================================================================
  // C. 呪縛が手札を全部凍らせないか（**出荷される式をそのまま走らせる**）
  // ===========================================================================
  // 候補の変数名（free / 旧 idxs）どちらでも取り出す ── 名前で弾いてしまうと、
  // 直っていない版で C-1..C-3 が「実行されないまま緑」になる。
  const curse = modesSrc.match(/const (?:free|idxs) = e\.hand\.map[\s\S]*?frozen\+\+;\n {4}\}/);
  check('C-0 呪縛の式を取り出せる', !!curse, curse ? '' : '見つからない');
  if (curse) {
    // eslint-disable-next-line no-new-func
    const run = new Function('e', 'n', 'now', `${curse[0]}\nreturn frozen;`);
    let worstFree = 3;
    let ranN = 0;
    for (let i = 0; i < 400; i++) {
      const now = 1_000_000;
      // 1枠はすでに凍っている（前の呪縛が明けていない）。ここに二重呪縛が来る。
      const e = { hand: [{ frozenUntil: now + 5000 }, { frozenUntil: 0 }, { frozenUntil: 0 }] };
      run(e, 2, now);
      const free = e.hand.filter(p => !(p.frozenUntil > now)).length;
      worstFree = Math.min(worstFree, free);
      ranN++;
    }
    check('C-1 二重呪縛が前の呪縛と重なっても、必ず1枠は動かせる',
      worstFree >= 1, `${ranN}回中の最小の空き枠 = ${worstFree}`);
    // すでに凍っている枠を選び直していない（＝凍結の数が増えすぎない）。
    let doubled = 0;
    for (let i = 0; i < 200; i++) {
      const now = 2_000_000;
      const e = { hand: [{ frozenUntil: now + 5000 }, { frozenUntil: 0 }, { frozenUntil: 0 }] };
      if (run(e, 2, now) !== 1) doubled++;
    }
    check('C-2 空き2枠に二重呪縛が来たら凍らせるのは1枠だけ',
      doubled === 0, `違った回 = ${doubled}/200`);
    // 手札が全部空いているときは、2枠まで凍らせてよい（効き目を弱めていない）。
    let n2 = 0;
    for (let i = 0; i < 200; i++) {
      const now = 3_000_000;
      const e = { hand: [{ frozenUntil: 0 }, { frozenUntil: 0 }, { frozenUntil: 0 }] };
      if (run(e, 2, now) === 2) n2++;
    }
    check('C-3 まっさらな手札なら二重呪縛は2枠を凍らせる（弱体化していない）',
      n2 === 200, `${n2}/200`);
  }

  // ===========================================================================
  // D. しおりが「ここまで遊んだ長さ」を預けるか
  // ===========================================================================
  check('D-1 しおりに playedMs を預けている',
    /playedMs: Math\.max\(0, Math\.min\(7200_000, Date\.now\(\) - \(Number\(mode\.startedAt\)/.test(modes), '');
  check('D-2 続きから始めるとき startedAt を同じぶん戻している',
    /if \(Number\.isFinite\(m\.startedAt\)\) m\.startedAt -= playedMs;/.test(modes), '');
  check('D-3 読み出し側でも 7200 秒で頭を押さえている',
    /const playedMs = Math\.max\(0, Math\.min\(7200_000, Number\(bm\.playedMs\) \|\| 0\)\);/.test(modes), '');
  // サバイバルの到達ウェーブは realPlay（duration 20秒以上）の内側で保存される。
  check('D-4 サバイバルのウェーブ保存が実プレイの門の内側にある（前提の確認）',
    /const newWaveBest = mode === 'survival' && realPlay && wave >/.test(stripComments(read('server/index.js'))), '');

  // ===========================================================================
  // E. 大会ブラケットの「離脱する」が本当に押せるか
  // ===========================================================================
  const tq = modes.match(/onTourneyState\(msg\) \{[\s\S]*?\n {2}\}/);
  check('E-0 onTourneyState を取り出せる', !!tq, '');
  if (tq) {
    check('E-1 showModal の戻り値を受けている',
      /const modal = showModal\(/.test(tq[0]), '');
    check('E-2 離脱ボタンをその戻り値から引いている',
      /modal\.querySelector\('#tqLeave'\)/.test(tq[0]), '');
    check('E-3 宣言していない名前を使っていない',
      !/(?<![\w$.])m\.[A-Za-z_$]/.test(tq[0]), '');
    check('E-4 押したら本当に抜ける',
      /leave\.onclick = \(\) => \{[^}]*this\.quit\(\);/.test(tq[0]), '');
  }

  // ===========================================================================
  // F. サーバー更新の確定送信が勝ちを作らないか
  // ===========================================================================
  const saveNow = modes.match(/window\.__bbaSaveNow = \(\) => \{[\s\S]*?\n\};/);
  check('F-0 __bbaSaveNow を取り出せる', !!saveNow, '');
  if (saveNow) {
    check('F-1 中断の印を立ててから締めている',
      /m\.aborted = true;[\s\S]{0,120}?m\.finish\(false\)/.test(saveNow[0]), '');
    check('F-2 finish に何も渡さない呼び方が残っていない',
      !/m\.finish\(\)/.test(saveNow[0]), '');
  }
  // 印が立っていれば AI対戦は引き分けで締まる（勝敗を点差で作らない）。
  check('F-3 AI対戦の勝敗判定が中断の印を先に見る',
    /const outcome = this\.aborted \? 'draw' :/.test(modes), '');

  // ===========================================================================
  // A. ロイヤルの報酬が、接続ではなくアカウントに入るか（統合）
  // ===========================================================================
  await start();
  const reg = await j('/api/register', { method: 'POST', body: { username: 'ロイヤル切断', password: 'pw-progress-1' } });
  if (!reg.token) throw new Error(`登録できません: ${JSON.stringify(reg)}`);
  const tok = reg.token;
  const before = (await j('/api/me', {}, tok)).user || {};

  const A = await makeClient(tok);
  A.send({ type: 'queue', mode: 'royale' });
  const found = await A.wait('royale_found', 20000);
  await sleep((found.countdown + 1) * 1000);
  A.send({ type: 'state', score: 24000, lines: 60, combo: 5, pieces: 120 });
  await sleep(2500);
  // ここで「回線が切れる」。結果モーダルは受け取れないが、報酬は入るべき。
  A.ws.close();
  // 猶予が明けて、次の tick が席を外すまで待つ（tick は 250ms 間隔）。
  await sleep(GRACE_MS + 2000);

  const after = (await j('/api/me', {}, tok)).user || {};
  const bs = before.stats || {};
  const as = after.stats || {};
  check('A-1 切断でもロイヤルの参加が記録される',
    (as.royalePlays || 0) === (bs.royalePlays || 0) + 1,
    `${bs.royalePlays || 0} → ${as.royalePlays || 0}`);
  check('A-2 切断でも順位報酬のコインが入る',
    (after.coins || 0) > (before.coins || 0), `${before.coins || 0} → ${after.coins || 0}`);
  check('A-3 切断でも自己ベスト順位が残る',
    typeof as.royaleBest === 'number' && as.royaleBest > 0, `royaleBest=${as.royaleBest}`);
  const battle = stripComments(read('server/battle.js'));
  check('A-4 報酬の有無を接続状態で決めていない',
    !/payoutGranted = !!\(me && e\.ws\.readyState/.test(battle)
    && /const payoutGranted = !!me;/.test(battle), '');
} catch (err) {
  check('テストが最後まで走る', false, err && err.message);
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [mark, name, detail] of results) console.log(mark, name, detail ? `— ${detail}` : '');
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
