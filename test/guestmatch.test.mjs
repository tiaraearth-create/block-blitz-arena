// リポジトリのルートから:  node test/guestmatch.test.mjs
//
// 🤝 オンライン対戦で「ゲストに当たったとき」に何が起きるか、を固定する。
//
// ■ 何が壊れていたか
//   Elo は昔からゲスト相手では動かない（endMatch の oppRating が null になる）。
//   ところが **勝ち星・連勝・コイン・ミッション・実績だけは無条件に入って**いた。
//   3つの判断が食い違っていたので、シークレットウィンドウをゲストとして開いて
//   わざと負けるだけで、PvP勝利数・勝利系ミッション・実績・報酬を無限に量産できた
//   （ゲストは登録が要らない＝いくらでも・ただで作れる）。
//   合言葉ルームも同じ形で、rated:false なのに勝利報酬だけは通っていた。
//
// ■ 通したい細い道
//   ・厳しすぎる → ゲストと当たっただけで「遊んだ事実」まで消えるのは行き過ぎ。
//     参加報酬・プレイ回数・ライン数のミッションは今までどおり入るべき。
//   ・緩すぎる → 勝ち星が入る＝上のとおり無限に量産できる。
//   通した道: **勝敗に紐づくものだけ**を落とし、参加ぶんは残す（＝練習試合）。
//
// ■ ここで見るもの
//   ① ゲストとログイン済みは同じ列に並び、ちゃんとマッチする（締め出さない）
//   ② ゲストに勝っても 勝ち星・敗け星・レート・連勝 が動かない
//   ③ でも「遊んだ事実」は残る（プレイ回数と参加報酬は入る）
//   ④ 結果に理由が載る（friendly:'guest'）＝画面が「なぜ0なのか」を説明できる
//   ⑤ 合言葉ルームの対戦も練習試合（friendly:'room'）
//   ⑥ 巻き添えが無い（席が埋まる相手との1戦）── 練習試合の印が付かず、勝敗が残る
//   ⑦ 巻き添えが無い（登録済み2人の1戦）── 勝敗もレートも連勝も今までどおり動く
//
// ⑥と⑦を分けてあるのは、席を埋める相手が **未登録** だった回は Elo が動かないのが
// 正しいから（battle.js の Bot は未登録の席に rating を持たせない）。引きで落ちる
// テストにしないため、レートの増減は⑦の実戦だけで見る。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-guestmatch-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なし */ }
  return { status: r.status, ...d };
};
const statsOf = async token => ((await j('/api/me', {}, token)).user || {}).stats || {};
const walletOf = async token => { const u = (await j('/api/me', {}, token)).user || {}; return { coins: u.coins || 0, gems: u.gems || 0 }; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'guestmatch-test', SEED_RESTORE: '0', MATCH_SECONDS: '5',
      TOURNEY_SECS: '6,6,6',
    },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    }
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

// 型別に受信を貯める小さなWSクライアント（test/battle.test.mjs と同じ作法）。
function makeClient(guestName, token = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    async wait(type, timeout = 25000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) {
          throw new Error(`timeout waiting for ${type} (got: ${Object.keys(inbox).filter(k => inbox[k].length).join(',') || 'nothing'})`);
        }
        await sleep(60);
      }
    },
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => c.send(token ? { type: 'hello', token } : { type: 'hello', guestName }));
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 8000); res(c); })().catch(rej);
  });
}

const open = [];
try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const reg = await j('/api/register', { method: 'POST', body: { username: 'とうろくずみ', password: 'toroku-pass-1' } });
  check('下ごしらえ: アカウントを作れた', !!reg.token, reg.error || '');
  const tok = reg.token;

  const base = await statsOf(tok);
  const baseWallet = await walletOf(tok);
  check('下ごしらえ: 最初は 0勝0敗・レート1000・連勝0',
    (base.pvpWins || 0) === 0 && (base.pvpLosses || 0) === 0 && base.rating === 1000 && (base.winStreakBest || 0) === 0,
    `${base.pvpWins}勝${base.pvpLosses}敗 R${base.rating} 連勝${base.winStreakBest}`);

  // =========================================================================
  // ①〜④ ゲスト相手のレート戦
  // =========================================================================
  {
    const me = await makeClient(null, tok); open.push(me);
    const guest = await makeClient('とおりすがり'); open.push(guest);
    me.send({ type: 'queue', mode: 'duel' });
    guest.send({ type: 'queue', mode: 'duel' });

    const mf = await me.wait('match_found', 15000);
    await guest.wait('match_found', 15000);
    check('① ゲストとログイン済みは同じ列でマッチする', mf.mode === 'duel' && mf.players.length === 2,
      `mode=${mf.mode} players=${mf.players.map(p => p.name).join(',')}`);
    const names = mf.players.map(p => p.name);
    check('① 相手はボットではなく、名乗ったゲスト本人', names.includes('とおりすがり'), JSON.stringify(names));

    // カウントダウン明けに点を入れて、こちらが勝つ形にする。
    await sleep(3500);
    me.send({ type: 'state', score: 4000, lines: 6, combo: 2 });
    await sleep(400);

    const r = await me.wait('result', 25000);
    check('（前提）こちらの勝ちで終わっている', r.outcome === 'win', `outcome=${r.outcome}`);
    check('④ 結果に「練習試合（ゲスト相手）」の理由が載る', r.friendly === 'guest', `friendly=${r.friendly}`);
    check('② レートは動かない（従来どおり）', r.ratingDelta === 0, `ratingDelta=${r.ratingDelta}`);

    await sleep(600);
    const after = await statsOf(tok);
    const wallet = await walletOf(tok);
    check('② 勝ち星が増えない', (after.pvpWins || 0) === 0, `pvpWins=${after.pvpWins}`);
    check('② 敗け星も増えない', (after.pvpLosses || 0) === 0, `pvpLosses=${after.pvpLosses}`);
    check('② レートは1000のまま', after.rating === 1000, `rating=${after.rating}`);
    check('② 連勝も伸びない（連勝ボーナス稼ぎを塞ぐ）', (after.winStreakBest || 0) === 0,
      `winStreakBest=${after.winStreakBest}`);
    check('③ でも遊んだ事実は残る（プレイ回数）', (after.gamesPlayed || 0) > (base.gamesPlayed || 0),
      `${base.gamesPlayed} → ${after.gamesPlayed}`);
    check('③ 参加ぶんの報酬は入る（遊び損にしない）', wallet.coins > baseWallet.coins,
      `${baseWallet.coins} → ${wallet.coins}🪙`);

    // ゲスト側は今までどおり「報酬なし」。
    const rg = await guest.wait('result', 25000);
    check('③ ゲスト側には報酬が付かない（従来どおり）', !rg.rewards, JSON.stringify(rg.rewards));

    me.ws.close(); guest.ws.close();
    await sleep(400);
  }

  // =========================================================================
  // ⑤ 合言葉ルームの対戦も練習試合
  // =========================================================================
  {
    const r2 = await j('/api/register', { method: 'POST', body: { username: 'あいことばA', password: 'aikotoba-1' } });
    const r3 = await j('/api/register', { method: 'POST', body: { username: 'あいことばB', password: 'aikotoba-2' } });
    check('下ごしらえ: ルーム用の2アカウント', !!r2.token && !!r3.token, `${r2.error || ''} ${r3.error || ''}`);

    const host = await makeClient(null, r2.token); open.push(host);
    const mate = await makeClient(null, r3.token); open.push(mate);
    host.send({ type: 'create_room', settings: { mode: 'duel' } });
    const room = await host.wait('room_update', 10000);
    mate.send({ type: 'join_room', code: room.code });
    await mate.wait('room_update', 10000);
    await sleep(300);
    host.send({ type: 'room_start' });
    await host.wait('match_found', 12000);
    await mate.wait('match_found', 12000);

    await sleep(3500);
    host.send({ type: 'state', score: 5000, lines: 7, combo: 3 });
    await sleep(400);

    const rh = await host.wait('result', 25000);
    check('（前提）ルームの対戦でホストが勝った', rh.outcome === 'win', `outcome=${rh.outcome}`);
    check('⑤ ルームの対戦は練習試合として届く', rh.friendly === 'room', `friendly=${rh.friendly}`);

    await sleep(600);
    const hs = await statsOf(r2.token);
    check('⑤ ルームで勝っても勝ち星は増えない', (hs.pvpWins || 0) === 0, `pvpWins=${hs.pvpWins}`);
    check('⑤ ルームで勝っても連勝は伸びない', (hs.winStreakBest || 0) === 0, `winStreakBest=${hs.winStreakBest}`);

    host.ws.close(); mate.ws.close();
    await sleep(400);
  }

  // =========================================================================
  // ⑥ 巻き添えが無い ── ふつうのレート戦（席が埋まる相手）では今までどおり
  // =========================================================================
  {
    const solo = await makeClient(null, tok); open.push(solo);
    solo.send({ type: 'queue', mode: 'duel' });
    const mf = await solo.wait('match_found', 20000);   // 4〜9秒で席が埋まる
    check('⑥（前提）1人で並ぶと相手が用意される', mf.players.length === 2, `players=${mf.players.length}`);

    await sleep(3500);
    solo.send({ type: 'state', score: 900000, lines: 60, combo: 9 });
    await sleep(400);
    const r = await solo.wait('result', 25000);
    check('⑥ ふつうのレート戦には練習試合の印が付かない', !('friendly' in r), `friendly=${r.friendly}`);

    await sleep(600);
    const after = await statsOf(tok);
    const moved = (after.pvpWins || 0) + (after.pvpLosses || 0);
    check('⑥ 勝敗がちゃんと記録される', moved === 1, `${after.pvpWins}勝${after.pvpLosses}敗`);
    // ⚠ ここでレートの増減までは見ない。席を埋める相手が **未登録** だった回は
    //   Elo が動かないのが正しい（server/battle.js の Bot は
    //   `rating = persona.registered ? ... : null` で、null なら endMatch の
    //   oppRating が null になり Elo を回さない）。引きによって落ちるテストに
    //   なるので、レートが動くことは下の⑦で **登録済み2人** の実戦で見る。
    solo.ws.close();
    await sleep(400);
  }

  // =========================================================================
  // ⑦ 巻き添えが無い（決定的な版）── 登録済み2人のふつうのレート戦は
  //    勝ち星もレートも連勝も今までどおり動く。
  //    ここが落ちたら、練習試合の判定が効きすぎている。
  //    同じ回線でも **3戦目までは数える**ので、1戦のこのテストは影響を受けない
  //    （連戦の打ち切りは test/moderation.test.mjs の E で見ている）。
  // =========================================================================
  {
    const p = await j('/api/register', { method: 'POST', body: { username: 'ふつうのＰ', password: 'futsu-p-1234' } });
    const qy = await j('/api/register', { method: 'POST', body: { username: 'ふつうのＱ', password: 'futsu-q-1234' } });
    check('⑦ 下ごしらえの2アカウント', !!p.token && !!qy.token, `${p.error || ''} ${qy.error || ''}`);

    const cp = await makeClient(null, p.token); open.push(cp);
    const cq = await makeClient(null, qy.token); open.push(cq);
    cp.send({ type: 'queue', mode: 'duel' });
    cq.send({ type: 'queue', mode: 'duel' });
    await cp.wait('match_found', 20000);
    await cq.wait('match_found', 20000);

    await sleep(3500);
    cp.send({ type: 'state', score: 7000, lines: 9, combo: 3 });
    await sleep(400);
    const rp = await cp.wait('result', 25000);
    check('⑦ 登録済みどうしの1戦に練習試合の印が付かない', !('friendly' in rp), `friendly=${rp.friendly}`);
    check('⑦ レートの増減が返る', rp.ratingDelta !== 0, `ratingDelta=${rp.ratingDelta}`);

    await sleep(600);
    const sp = await statsOf(p.token);
    check('⑦ 勝敗が記録される', (sp.pvpWins || 0) + (sp.pvpLosses || 0) === 1, `${sp.pvpWins}勝${sp.pvpLosses}敗`);
    check('⑦ レートが動く', sp.rating !== 1000, `rating=${sp.rating}`);
    if ((sp.pvpWins || 0) === 1) {
      check('⑦ 勝ったなら連勝も伸びる', (sp.winStreakBest || 0) === 1, `winStreakBest=${sp.winStreakBest}`);
    } else {
      check('⑦ 負けたときは連勝が伸びない（これも従来どおり）', (sp.winStreakBest || 0) === 0,
        `winStreakBest=${sp.winStreakBest}`);
    }
    cp.ws.close(); cq.ws.close();
  }

  // =========================================================================
  // ⑦ 🏆トーナメントを練習試合にしない（実装中に一度踏んだ穴の見張り）
  //
  // トーナメントの1試合も rated:false の 'duel' として作られる（Elo を動かさない
  // ため）。「rated でなければ練習試合」と素直に書くと、**優勝のバッジと
  // ボーナスが出なくなる** ── レート戦でないことと、勝ちに意味が無いことは別。
  // ここが逆戻りしたら落ちるようにしておく。
  // =========================================================================
  {
    const t = await makeClient(null, tok); open.push(t);
    t.send({ type: 'queue', mode: 'tourney' });
    const mf = await t.wait('match_found', 25000);   // 5〜10秒で他の席が埋まる
    check('⑦（前提）トーナメントの1回戦が始まる', !!mf.tourney, `tourney=${JSON.stringify(mf.tourney)}`);

    await sleep(3500);
    t.send({ type: 'state', score: 800000, lines: 50, combo: 8 });
    await sleep(400);
    const r = await t.wait('result', 30000);
    check('⑦ トーナメントの試合に練習試合の印が付かない', !('friendly' in r),
      `friendly=${r.friendly}（付くと優勝のバッジとボーナスが消える）`);
    check('⑦ 報酬の計算そのものは走っている', !!r.rewards, JSON.stringify(r.rewards));
    t.ws.close();
  }
} catch (err) {
  check('テストが最後まで走った', false, String((err && err.stack) || err));
} finally {
  for (const c of open) { try { c.ws.close(); } catch { /* もう閉じている */ } }
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🤝 ゲスト相手の対戦  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
