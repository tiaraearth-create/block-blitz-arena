// リポジトリのルートから:  node test/throne.test.mjs
// 👑 王座の宝物庫（管理者イベント専用ショップ）のテスト。
//
// このショップの値打ちは「管理者イベントの中でしか手に入らない」に尽きるので、
// 守りたいのは主に抜け道の有無:
//   1. コイン／ジェムで買えないこと（通常ショップの購入口を通らない）
//   2. ガチャの抽選対象に混ざっていないこと
//   3. 世界がまだ割っていない段の品は、欠片が有り余っていても買えないこと
//   4. 買えば装備でき、在庫画面にも出ること（買い得な文鎮にならないこと）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';
import { THRONE_ITEMS, SHOP_ITEMS } from '../server/catalog.js';
import { SHARD, throneMax, recordThrone } from '../server/adminevent.js';

const PORT = await freePort();
// 保存先にポートを混ぜる。固定名だと、run-all が同時に2つ走ったときに
// 両方が同じフォルダを使い、片方の rmSync がもう片方の db.json を消す
// （並列開発では実際に踏む）。理由の詳細は test/battle.test.mjs を参照。
const DIR = path.join(os.tmpdir(), `bba-throne-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'throne-test', SEED_RESTORE: '0', ADMIN_PASSWORD: 'thronetestpassword',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了 (code=${proc.exitCode})`);
    try { const r = await fetch(`http://localhost:${PORT}/api/status`); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした');
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

fs.rmSync(DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 1. カタログの形（サーバー不要）
// ---------------------------------------------------------------------------
{
  check('王座ショップに品がある', THRONE_ITEMS.length >= 7, `${THRONE_ITEMS.length}種`);
  check('すべて throneOnly', THRONE_ITEMS.every(i => i.throneOnly === true), '');
  check('すべて欠片の値段を持つ', THRONE_ITEMS.every(i => i.shards > 0), '');
  check('すべて解放段を持つ（1〜7）',
    THRONE_ITEMS.every(i => i.dan >= 1 && i.dan <= 7), '');
  // コイン価格が残っていると、どこかの経路で「0コインで買える」になりかねない。
  check('コイン／ジェムの値段は 0 のまま', THRONE_ITEMS.every(i => i.price === 0), '');
  check('段が上がるほど高い',
    THRONE_ITEMS.slice().sort((a, b) => a.dan - b.dan).every((it, i, arr) => i === 0 || it.shards >= arr[i - 1].shards), '');
  // 装備スロットとして成立していないと、買っても付けられない。
  check('すべて装備できるカテゴリ',
    THRONE_ITEMS.every(i => ['skin', 'board', 'fx', 'ult'].includes(i.cat)), '');
  check('id が SHOP_ITEMS の中で一意',
    new Set(SHOP_ITEMS.map(i => i.id)).size === SHOP_ITEMS.length, '');

  const db = { meta: {} };
  check('王座の初期値は 0', throneMax(db) === 0, String(throneMax(db)));
  recordThrone(db, 3);
  check('割った段が記録される', throneMax(db) === 3, String(throneMax(db)));
  recordThrone(db, 2);
  check('低い段では下がらない', throneMax(db) === 3, String(throneMax(db)));
  recordThrone(db, 99);
  check('7 を超えない', throneMax(db) === 7, String(throneMax(db)));
  check('欠片のレートが全部そろっている',
    [SHARD.join, SHARD.cut, SHARD.keystone, SHARD.danPresent, SHARD.danFinish, SHARD.bossKill]
      .every(n => Number.isFinite(n) && n > 0) && Array.isArray(SHARD.tier) && SHARD.tier.length === 4, '');
}

// ---------------------------------------------------------------------------
// 2. 実サーバー
// ---------------------------------------------------------------------------
try {
  await start();

  const reg = await api('/api/register', { method: 'POST', body: { username: 'たろう', password: 'password123' } });
  const tk = reg.d.token;
  check('登録できる', !!tk, reg.d.error || '');

  // --- 通常ショップに買える形で並んでいないか ---
  const shop = await api('/api/shop', { token: tk });
  const listed = shop.d.items.filter(i => i.throneOnly);
  check('通常ショップの一覧には載る（在庫画面が読むため）', listed.length === THRONE_ITEMS.length, `${listed.length}種`);
  check('載っていても値段は 0 のまま', listed.every(i => i.price === 0), '');

  const target = THRONE_ITEMS[0];
  let r = await api('/api/shop/buy', { method: 'POST', token: tk, body: { itemId: target.id } });
  check('コイン／ジェムでは買えない', r.status === 403, `status=${r.status}`);

  // --- 欠片が 0 なら買えない ---
  r = await api('/api/throne/shop', { token: tk });
  check('宝物庫が開ける', r.status === 200, r.d.error || '');
  check('最初の所持欠片は 0', r.d.shards === 0, String(r.d.shards));
  check('最初は世界の到達段も 0', r.d.throneMax === 0, String(r.d.throneMax));
  check('段0では何ひとつ棚に並んでいない', r.d.items.every(i => !i.unlocked), '');

  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: target.id } });
  check('棚が開いていなければ買えない', r.status === 403, `status=${r.status}`);

  // --- 管理者として世界の段を進め、テスト用に欠片を配る ---
  const alogin = await api('/api/login', { method: 'POST', body: { username: 'るみまき', password: 'thronetestpassword' } });
  const atk = alogin.d.token;
  check('管理者でログインできる', !!atk, alogin.d.error || '');

  // 欠片は本来イベント内でしか増えないので、テストでは運営の付与口を使う。
  const users = await api('/api/admin/users', { token: atk });
  const me = (users.d.users || []).find(u => u.username === 'たろう');
  check('管理者からユーザーが見える', !!me, '');

  r = await api(`/api/admin/users/${me.id}`, { method: 'POST', token: atk, body: { grantShards: 1000 } });
  check('運営が欠片を配れる', r.status === 200, r.d.error || `status=${r.status}`);
  r = await api('/api/throne/shop', { token: tk });
  check('配った欠片が反映される', r.d.shards === 1000, String(r.d.shards));

  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: target.id } });
  check('段が開いていなければ、欠片が有り余っていても買えない', r.status === 403, `status=${r.status}`);

  // --- 世界が段を割ると棚が開く ---
  r = await api('/api/admin/throne', { method: 'POST', token: atk, body: { throneMax: target.dan } });
  check('運営が世界の到達段を動かせる', r.status === 200, r.d.error || `status=${r.status}`);
  r = await api('/api/admin/throne', { method: 'POST', token: tk, body: { throneMax: 7 } });
  check('一般ユーザーは世界の到達段を動かせない', r.status === 403, `status=${r.status}`);

  r = await api('/api/throne/shop', { token: tk });
  const openNow = r.d.items.filter(i => i.unlocked);
  check('割った段までの棚だけが開く',
    openNow.length > 0 && openNow.every(i => i.dan <= target.dan), `${openNow.length}種`);
  check('まだ割っていない段の品は閉じたまま',
    r.d.items.filter(i => i.dan > target.dan).every(i => !i.unlocked), '');

  // --- 買う ---
  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: target.id } });
  check('棚が開いていれば買える', r.status === 200, r.d.error || `status=${r.status}`);
  check('欠片がちゃんと減る', r.d.user.shards === 1000 - target.shards, String(r.d.user.shards));
  check('所持品に入る', (r.d.user.owned || []).includes(target.id), '');

  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: target.id } });
  check('二重購入はできない', r.status === 409, `status=${r.status}`);

  // --- 買ったものが装備できる（買えるのに使えない、が最悪なので） ---
  r = await api('/api/equip', { method: 'POST', token: tk, body: { slot: target.cat, itemId: target.id } });
  check('買った品を装備できる', r.status === 200, r.d.error || `status=${r.status}`);
  check('装備が反映される', r.d.user.equipped[target.cat] === target.id, r.d.user.equipped[target.cat]);

  // --- 欠片が足りなければ買えない ---
  // 残高任せだとたまたま足りて素通りするので、値段より 1 少ない状態を作る。
  const dear = THRONE_ITEMS.filter(i => i.id !== target.id).sort((a, b) => b.shards - a.shards)[0];
  await api('/api/admin/throne', { method: 'POST', token: atk, body: { throneMax: 7 } });
  let cur = (await api('/api/throne/shop', { token: tk })).d.shards;
  await api(`/api/admin/users/${me.id}`, { method: 'POST', token: atk, body: { grantShards: (dear.shards - 1) - cur } });
  cur = (await api('/api/throne/shop', { token: tk })).d.shards;
  check('残高をちょうど1足りない額に調整できた', cur === dear.shards - 1, `${cur} / ${dear.shards}`);
  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: dear.id } });
  check('1つ足りないだけでも買えない', r.status === 402, `status=${r.status}`);
  await api(`/api/admin/users/${me.id}`, { method: 'POST', token: atk, body: { grantShards: 1 } });
  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: dear.id } });
  check('ちょうど足りれば買える', r.status === 200, r.d.error || `status=${r.status}`);
  check('使い切って 0 になる', r.d.user.shards === 0, String(r.d.user.shards));
  // --- 在庫画面が読む一覧に、買ったものが載っている ---
  const shop2 = await api('/api/shop', { token: tk });
  check('買った品が在庫用の一覧に載っている',
    shop2.d.items.some(i => i.id === target.id), '');
  // --- ガチャに混ざっていないこと ---
  // 引ける母数から throneOnly が抜けているかを、母数の数で見る。
  const info = await api('/api/gacha/info', { token: tk });
  const expected = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly).length;
  check('ガチャのコレクション母数に王座の品が入っていない',
    info.d.collection && info.d.collection.total === expected,
    `total=${info.d.collection && info.d.collection.total} expected=${expected}`);

  // --- 存在しない品 ---
  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: 'skin_neon' } });
  check('宝物庫の品でないものは弾かれる', r.status === 404, `status=${r.status}`);
  r = await api('/api/throne/buy', { method: 'POST', token: tk, body: { itemId: '__proto__' } });
  check('__proto__ を投げても壊れない', r.status === 404, `status=${r.status}`);

  // --- 未ログインでは買えない ---
  r = await api('/api/throne/buy', { method: 'POST', body: { itemId: target.id } });
  check('未ログインでは買えない', r.status === 401, `status=${r.status}`);

} catch (err) {
  check('テストの土台', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
