// Run from the repo root:  node test/useredit.test.mjs  (needs a free port 3111)
// 🎒 管理者のインベントリ編集（GET/POST /api/admin/users/:id）のテスト。
//
// この画面はブラウザから任意の値をユーザーレコードに書き込めるので、
// 「意図した編集が通ること」と同じくらい「壊れた値が弾かれること」が重要。
// NaN や未知のIDが1つでも通ると db.json が汚染され、後日まったく関係のない
// 読み出しで落ちるようになる。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), 'bba-useredit-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* empty */ }
  return { status: r.status, ...d };
};

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0', SESSION_SECRET: 'useredit-test', SEED_RESTORE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* not up */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const atk = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  const victim = await j('/api/register', { method: 'POST', body: { username: 'はっひー', password: 'pass1234' } });
  const uid = victim.user.id;
  const vtok = victim.token;
  check('編集対象を用意', !!uid, victim.error || '');

  // ---- 読み出し ----
  let r = await j(`/api/admin/users/${uid}`, {}, atk);
  check('編集用の全体像が取れる', r.status === 200 && !!r.user && !!r.catalog, r.error || '');
  check('カタログが揃っている', r.catalog.shop.length > 0 && r.catalog.boosters.length > 0
    && r.catalog.titles.length > 0 && r.catalog.badges.length > 0 && r.catalog.stats.length > 0,
    `shop=${r.catalog.shop.length} titles=${r.catalog.titles.length} badges=${r.catalog.badges.length}`);
  check('一般ユーザーは編集画面を開けない', (await j(`/api/admin/users/${uid}`, {}, vtok)).status === 403);

  // 既定で持っているものを選ぶと「未所持を所持に追加して装備する」経路を
  // 通らないので、明示的に既定外のIDを指定する。
  const shop = r.catalog.shop;
  const skin = shop.find(i => i.id === 'skin_neon');
  const board = shop.find(i => i.id === 'board_galaxy');
  check('テスト用の既定外アイテムが存在する', !!skin && !!board, `${skin && skin.id} / ${board && board.id}`);

  // ---- 実際の復旧作業（はっひーさんを Lv5 に戻す） ----
  r = await j(`/api/admin/users/${uid}`, {
    method: 'POST',
    body: {
      setCoins: 50000, setGems: 1000, setLevel: 5,
      setItems: { item_bomb: 9, item_fever: 3 },
      setOwned: [skin.id, board.id],
      setEquipped: { skin: skin.id, board: board.id },
      setBadges: ['gold', 'oni'],
      setTitle: 'rookie',
      setStats: { bestScore: 123456, rating: 1420, gamesPlayed: 40 },
    },
  }, atk);
  check('まとめて保存できる', r.status === 200, r.error || '');

  const me = await j('/api/me', {}, vtok);
  const u = me.user;
// 🎁 /api/me は初回アクセス時にログインボーナス（100🪙+5💎）を配ることがある
// （登録初日にも出るよう lastDaily を null 始まりにした）。ここで見たいのは
// 「set* が加算ではなく **絶対値** で入るか」なので、ボーナス1回ぶんだけ
// 許容する。加算バグならこの幅では収まらない（元の値ごと足されるため）。
const DAILY_BONUS_COINS = 100, DAILY_BONUS_GEMS = 5;
const absSet = (got, want, slack) => got === want || got === want + slack;
check('コイン/ジェムが絶対値で入る',
  absSet(u.coins, 50000, DAILY_BONUS_COINS) && absSet(u.gems, 1000, DAILY_BONUS_GEMS),
  `🪙${u.coins} 💎${u.gems}（50000/1000 ＋ログインボーナスぶんまで許容）`);
  check('レベルが設定される', u.level === 5, `Lv.${u.level} (xp=${u.xp})`);
  check('アイテムが個別に入る', (u.items || {}).item_bomb === 9 && (u.items || {}).item_fever === 3, JSON.stringify(u.items));
  check('所持品が入る（既定品も維持）', u.owned.includes(skin.id) && u.owned.includes(board.id) && u.owned.includes('skin_default'), `${u.owned.length}件`);
  check('装備が反映される', u.equipped.skin === skin.id && u.equipped.board === board.id, JSON.stringify(u.equipped));
  check('バッジが入る', u.badges.includes('gold') && u.badges.includes('oni') && u.badges.length === 2, JSON.stringify(u.badges));
  check('称号が入る', u.equippedTitle === 'rookie', String(u.equippedTitle));
  check('記録が入る', u.stats.bestScore === 123456 && u.stats.rating === 1420 && u.stats.gamesPlayed === 40,
    `best=${u.stats.bestScore} R=${u.stats.rating} n=${u.stats.gamesPlayed}`);

  // ---- 壊れた値は必ず弾く ----
  const bad = [
    ['コインにNaN', { setCoins: 'あ' }],
    ['未知のアイテムID', { setItems: { item_nonexistent: 1 } }],
    ['アイテム個数がNaN', { setItems: { item_bomb: 'x' } }],
    ['未知の所持品ID', { setOwned: ['skin_does_not_exist'] }],
    ['所持品が配列でない', { setOwned: 'skin_neon' }],
    ['未知の装備スロット', { setEquipped: { hat: 'skin_neon' } }],
    ['スロット違いの装備', { setEquipped: { skin: 'board_galaxy' } }],
    ['未所持アイテムの装備', { setEquipped: { fx: 'fx_comet' } }],
    ['未知のバッジ', { setBadges: ['not_a_badge'] }],
    ['バッジが配列でない', { setBadges: 'gold' }],
    ['未知の称号', { setTitle: 'not_a_title' }],
    ['編集できない統計', { setStats: { secretField: 1 } }],
    ['統計にNaN', { setStats: { bestScore: 'なし' } }],
  ];
  let rejected = 0;
  for (const [label, body] of bad) {
    const res = await j(`/api/admin/users/${uid}`, { method: 'POST', body }, atk);
    if (res.status === 400) rejected++;
    else check(`拒否されるべき: ${label}`, false, `status=${res.status}`);
  }
  check('壊れた値をすべて拒否する', rejected === bad.length, `${rejected}/${bad.length}件`);

  // 拒否されたあとも、元の値が壊れていないこと（部分適用されていないこと）
  const after = (await j('/api/me', {}, vtok)).user;
  check('拒否後もデータが壊れていない', absSet(after.coins, 50000, DAILY_BONUS_COINS) && after.badges.length === 2 && after.stats.bestScore === 123456,
    `🪙${after.coins} badges=${after.badges.length} best=${after.stats.bestScore}`);

  // 保存されたJSONにNaNが混ざっていないこと（混ざると以後ずっと壊れる）
  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setCoins: 1 } }, atk);
  await sleep(600);
  const raw = fs.readFileSync(path.join(DIR, 'db.json'), 'utf8');
  check('db.json に NaN / null 汚染がない', !/:\s*(NaN|Infinity)/.test(raw), '');

  // ---- 上限クランプ ----
  r = await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setStats: { rating: 999999 } } }, atk);
  const clamped = (await j('/api/me', {}, vtok)).user;
  check('上限を超える値はクランプされる', clamped.stats.rating === 5000, `R=${clamped.stats.rating}`);
  r = await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setCoins: -5 } }, atk);
  check('マイナスは0に丸められる', (await j('/api/me', {}, vtok)).user.coins === 0, '');

  // ---- 一般ユーザーは書き込めない ----
  check('一般ユーザーは編集できない',
    (await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setCoins: 999999 } }, vtok)).status === 403);

  // -------------------------------------------------------------------------
  // 監査で見つかった穴の回帰テスト
  // -------------------------------------------------------------------------

  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setCoins: 7777, setBadges: ['gold'] } }, atk);

  // null は「0」ではなく「不正」。Number(null) が 0 になるため、以前は
  // 所持金を黙って全部消して ok:true を返していた。
  for (const v of [null, '', [], false]) {
    const res = await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setCoins: v } }, atk);
    check(`setCoins:${JSON.stringify(v)} は拒否される`, res.status === 400, `status=${res.status}`);
  }
  check('拒否後もコインが残っている', (await j('/api/me', {}, vtok)).user.coins === 7777, '');

  // 検証エラー時に、それより前のフィールドが書き込まれたまま残らないこと。
  const before = (await j('/api/me', {}, vtok)).user;
  const partial = await j(`/api/admin/users/${uid}`, {
    method: 'POST',
    body: { setCoins: 111111, setGems: 222, setBadges: ['not_a_badge'] },   // 最後だけ不正
  }, atk);
  const afterPartial = (await j('/api/me', {}, vtok)).user;
  check('エラー時は途中まで書き込まれない', partial.status === 400
    && afterPartial.coins === before.coins && afterPartial.gems === before.gems,
    `status=${partial.status} 🪙${before.coins}→${afterPartial.coins} 💎${before.gems}→${afterPartial.gems}`);

  // JSON の 1e400 は Infinity。typeof は 'number' なので古い判定を素通りし、
  // coins + Infinity が保存され null になってアカウントが壊れていた。
  const inf = await j(`/api/admin/users/${uid}`, { method: 'POST', body: { grantCoins: 1e400 } }, atk);
  check('grantCoins に Infinity は通らない', inf.status === 400, `status=${inf.status}`);
  check('Infinity 拒否後もコインが有限', Number.isFinite((await j('/api/me', {}, vtok)).user.coins), '');

  // 装備したまま所持品から外すと、盤面が何も描画されなくなる。
  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setOwned: ['skin_neon'], setEquipped: { skin: 'skin_neon' } } }, atk);
  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setOwned: [] } }, atk);   // neon を剥奪
  const eq = (await j('/api/me', {}, vtok)).user;
  check('装備品を剥奪すると既定装備に戻る', eq.equipped.skin === 'skin_default' && eq.owned.includes(eq.equipped.skin),
    `equipped=${eq.equipped.skin}`);

  // 管理者専用装備を一般プレイヤーに配れてしまわないこと。
  const staffGear = await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setOwned: ['skin_admin'] } }, atk);
  check('管理者専用の装備は一般ユーザーに付与できない', staffGear.status === 400, `status=${staffGear.status} ${staffGear.error || ''}`);
  const staffItem = await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setItems: { item_god_wipe: 1 } } }, atk);
  check('管理者専用アイテムも付与できない', staffItem.status === 400, `status=${staffItem.status}`);

  // setLevel は XP を切り捨てる。端数を残したいときのための setXp。
  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setXp: 4640 } }, atk);
  const xp = (await j('/api/me', {}, vtok)).user;
  check('setXp は端数を保持する', xp.xp === 4640 && xp.level === 5, `xp=${xp.xp} Lv.${xp.level}`);
  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setLevel: 5 } }, atk);
  check('setLevel は従来どおり切り捨てる', (await j('/api/me', {}, vtok)).user.xp === 4000, '');

  // ジェムで買ったプレミアムパスを戻せること。
  await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setPass: { premium: true, xp: 1200 } } }, atk);
  const bp = (await j('/api/me', {}, vtok)).user.battlePass;
  check('プレミアムパスを復元できる', bp.premium === true && bp.xp === 1200, JSON.stringify(bp));
  check('パスのシーズンは書き換えさせない',
    (await j(`/api/admin/users/${uid}`, { method: 'POST', body: { setPass: { premium: 'yes' } } }, atk)).status === 400, '');
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
