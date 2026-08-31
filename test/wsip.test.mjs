// リポジトリのルートから:  node test/wsip.test.mjs
//
// 🔌「6人の壁」の回帰テスト。
//
// 症状: 前段にLB/リバースプロキシがある本番(Render)では、WSアップグレードの
// req.socket.remoteAddress がプロキシの内部IPになる。battle.js はそれを直に
// 読んで「同一IPあたり12接続まで」を数えていたので、上限が“全プレイヤー合算”に
// 効いていた。1人がチャット用と対戦用で2本つなぐ設計なので、最悪プロキシIP
// ひとつあたり6人前後で新規プレイヤーが「同時接続が多すぎます」で門前払いになる。
// HTTP側は trust proxy のおかげで正しく数えられていたので、WS側だけの不整合。
//
// ここで確かめること:
//   ① プロキシ越し（同じ接続元・別の X-Forwarded-For）なら12本を超えても入れる
//   ② それでも「同じ実IP」からの本数は今までどおり12本で止まる
//   ③ TRUST_PROXY=0（プロキシ無しの直結公開）では XFF を信用しない
//      ── ここが緩むと、ヘッダを付け替えるだけで上限を回避できてしまう
//   ④ 本番（TRUST_PROXY=1）で効いている安全性の根拠そのもの:
//      プロキシは XFF に実IPを**追記**するので、クライアントが自分で書いた値は
//      鎖の途中に入って採用されない。ここが崩れると①が通ったまま詐称できる
//   ⑤ サブネット指定（'loopback' 等）では XFF を見ない（Express より緩くしない）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const PER_IP = 12;   // server/battle.js の MAX_SOCKETS_PER_IP と揃える

const dataDirs = [];
async function startServer(extraEnv, tag) {
  const port = await freePort();
  // 他のサーバー系テストと同じ作法で、使う前に必ず空にする。名前がエフェメラル
  // ポート由来なので、掃除しないと使い回しのときに前回の db.json が残る。
  const dir = path.join(os.tmpdir(), `bba-wsip-${port}`);
  fs.rmSync(dir, { recursive: true, force: true });
  dataDirs.push(dir);
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      POP_SCALE: '0', SESSION_SECRET: `wsip-test-${tag}`, SEED_RESTORE: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(proc, `http://127.0.0.1:${port}`);
  return { port, proc };
}

// 1本つないで hello まで通し、通ったか断られたかを返す。
function tryConnect(port, xff, i) {
  return new Promise(resolve => {
    const headers = xff ? { 'x-forwarded-for': xff } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const done = (result, detail) => resolve({ ws: result === 'ok' ? ws : null, result, detail });
    const timer = setTimeout(() => { try { ws.close(); } catch {} done('timeout'); }, 15000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', guestName: `Probe${i}` })));
    ws.on('message', buf => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.type === 'hello_ok') { clearTimeout(timer); done('ok'); }
      // 「拒否」と数えてよいのは接続上限で断られたときだけ。サーバーは名前の
      // 差し替え通知などでも type:'error' を送るが、そのあと hello_ok が続く
      // （閉じない）。それを拒否に数えると、無関係な理由でこのテストが落ちて
      // 「IP解決が壊れた」と読める失敗メッセージが出る。
      else if (m.type === 'error' && /同時接続|接続数が上限/.test(String(m.error || ''))) {
        clearTimeout(timer); try { ws.close(); } catch {} done('rejected', m.error);
      }
    });
    ws.on('error', e => { clearTimeout(timer); done('err', String(e.message).slice(0, 60)); });
  });
}

async function connectMany(port, n, xffFor) {
  const open = [];
  const out = { ok: 0, rejected: 0, other: 0, messages: new Set() };
  for (let i = 0; i < n; i++) {
    const r = await tryConnect(port, xffFor(i), i);
    if (r.result === 'ok') { out.ok++; open.push(r.ws); }
    else if (r.result === 'rejected') { out.rejected++; out.messages.add(r.detail); }
    else out.other++;
  }
  out.close = () => { for (const ws of open) { try { ws.close(); } catch {} } };
  return out;
}

const servers = [];
try {
  // --- ① プロキシ越し: 接続元は同じ、実IPだけが違う ---
  const proxied = await startServer({}, 'proxy');
  servers.push(proxied);
  const many = await connectMany(proxied.port, PER_IP + 8, i => `203.0.113.${10 + i}`);
  check('プロキシ越しでも実IPが違えば12本を超えて入れる',
    many.ok === PER_IP + 8 && many.rejected === 0,
    `成功 ${many.ok} / 拒否 ${many.rejected}${many.messages.size ? ` (${[...many.messages].join(' , ')})` : ''}`);
  many.close();
  await sleep(500);

  // --- ② 同じ実IPからの本数は今までどおり止まる ---
  const same = await connectMany(proxied.port, PER_IP + 4, () => '198.51.100.7');
  check('同じ実IPからは12本で打ち止めになる',
    same.ok === PER_IP && same.rejected === 4,
    `成功 ${same.ok} / 拒否 ${same.rejected}`);
  check('断るときは理由を伝えている',
    [...same.messages].some(m => /同時接続/.test(String(m))),
    [...same.messages].join(' , ') || '(メッセージ無し)');
  same.close();
  await sleep(500);

  // --- ③ プロキシ無し構成では XFF を信用しない ---
  const direct = await startServer({ TRUST_PROXY: '0' }, 'direct');
  servers.push(direct);
  const spoof = await connectMany(direct.port, PER_IP + 4, i => `203.0.113.${10 + i}`);
  check('TRUST_PROXY=0 では XFF を付け替えても上限を回避できない',
    spoof.ok === PER_IP && spoof.rejected === 4,
    `成功 ${spoof.ok} / 拒否 ${spoof.rejected}`);
  spoof.close();
  await sleep(300);

  // --- ④ プロキシが追記した実IPが採られ、クライアントの自称は無視される ---
  // 左＝クライアントが勝手に書いた値／右＝プロキシが追記した本物。
  // 1ホップ信頼なら右が採られるので、左をいくら振っても12本で止まるはず。
  const appended = await connectMany(proxied.port, PER_IP + 4,
    i => `9.9.9.${i}, 198.51.100.42`);
  check('クライアントが自称した XFF では上限を回避できない（採られるのはプロキシ追記の実IP）',
    appended.ok === PER_IP && appended.rejected === 4,
    `成功 ${appended.ok} / 拒否 ${appended.rejected}`);
  appended.close();
  await sleep(300);

  // --- ⑤ サブネット指定は XFF を見ない（Express より緩くならない） ---
  const subnet = await startServer({ TRUST_PROXY: 'loopback' }, 'subnet');
  servers.push(subnet);
  const bySubnet = await connectMany(subnet.port, PER_IP + 4, i => `203.0.113.${10 + i}`);
  check('TRUST_PROXY にサブネット指定を入れても XFF で上限を回避できない',
    bySubnet.ok === PER_IP && bySubnet.rejected === 4,
    `成功 ${bySubnet.ok} / 拒否 ${bySubnet.rejected}`);
  bySubnet.close();
  await sleep(300);
} finally {
  for (const s of servers) { try { s.proc.kill(); } catch {} }
  await sleep(400);
  for (const dir of dataDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
