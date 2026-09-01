// Run from the repo root:  node test/inventory.test.mjs  (needs a free port 3105)
//
// 🎒 インベントリ画面が依存している契約を押さえる。
//
// このリポジトリのテストは全部サーバー側なので DOM は触らない。代わりに
//   (1) 画面が読むエンドポイントが必要なものを返しているか
//   (2) クライアント側の表だけに存在する情報（バッジの名前・解除条件）が
//       サーバーの実態とズレていないか
// を見る。(2) がいちばん壊れやすい: サーバーが新しいバッジを配れるように
// なったのにクライアントの表に無いと、プレイヤーには名前のない空欄が出る。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { freePort } from './_port.mjs';

// ポート固定をやめた理由は test/_port.mjs を参照（他人のサーバーを
// 自分のものと誤認して、緑のまま嘘をつく可能性があった）。
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
// 保存先にポートを混ぜる。固定名だと、run-all が同時に2つ走ったときに
// 両方が同じフォルダを使い、片方の rmSync がもう片方の db.json を消す
// （並列開発では実際に踏む）。理由の詳細は test/battle.test.mjs を参照。
const DIR = path.join(os.tmpdir(), `bba-inventory-test-${PORT}`);
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

// ---------------------------------------------------------------------------
// 1. クライアントの表 vs サーバーの実態（サーバー起動不要）
// ---------------------------------------------------------------------------
{
  const screens = fs.readFileSync('public/js/screens.js', 'utf8');
  const server = fs.readFileSync('server/index.js', 'utf8');

  const orderM = screens.match(/const BADGE_ORDER = \[([^\]]+)\]/);
  const knownM = server.match(/const ADMIN_KNOWN_BADGES = \[([^\]]+)\]/);
  check('BADGE_ORDER / ADMIN_KNOWN_BADGES が見つかる', !!orderM && !!knownM);
  const ids = s => s[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const clientIds = ids(orderM);
  const serverIds = ids(knownM);

  const missing = serverIds.filter(id => !clientIds.includes(id));
  check('サーバーが配れるバッジはすべて画面に出せる', missing.length === 0, missing.join(',') || 'なし');
  const extra = clientIds.filter(id => !serverIds.includes(id));
  check('画面にサーバーが知らないバッジが混ざっていない', extra.length === 0, extra.join(',') || 'なし');

  // 名前と解除条件が全部埋まっているか（空欄のバッジが出ないこと）
  const infoM = screens.match(/const BADGE_INFO = \{([\s\S]*?)\n\};/);
  check('BADGE_INFO が見つかる', !!infoM);
  const described = [...infoM[1].matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
  const undescribed = clientIds.filter(id => !described.includes(id));
  check('全バッジに名前と解除条件がある', undescribed.length === 0, undescribed.join(',') || 'なし');
  const blanks = [...infoM[1].matchAll(/(\w+):\s*\{[^}]*\}/g)]
    .filter(m => !/ja:\s*'[^']+'/.test(m[0]) || !/cja:\s*'[^']+'/.test(m[0]) || !/en:\s*'[^']+'/.test(m[0]) || !/cen:\s*'[^']+'/.test(m[0]))
    .map(m => m[1]);
  check('日本語と英語の両方が埋まっている', blanks.length === 0, blanks.join(',') || 'なし');

  // 画面が無言で真っ白になる典型的な事故
  const dom = fs.readFileSync('public/js/dom.js', 'utf8');
  check("SCREENS に 'inventory' が入っている", /const SCREENS = \[[^\]]*'inventory'/.test(dom));
  const html = fs.readFileSync('public/index.html', 'utf8');
  check('#screen-inventory と 4タブが存在する',
    html.includes('id="screen-inventory"') && (html.match(/data-inv="/g) || []).length === 4,
    `${(html.match(/data-inv="/g) || []).length}タブ`);
  const main = fs.readFileSync('public/js/main.js', 'utf8');
  check('タブ配線が $$ で書かれている（$ だと forEach で落ちる）',
    /\$\$\('\[data-inv\]'\)/.test(main) && /\$\$\('\[data-shop\]'\)/.test(main));
}

// ---------------------------------------------------------------------------
// 2. 画面が読むエンドポイント
// ---------------------------------------------------------------------------
let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0', SESSION_SECRET: 'inv-test', SEED_RESTORE: '0' },
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

  const u = await j('/api/register', { method: 'POST', body: { username: 'コレクター', password: 'pass1234' } });
  const tok = u.token;
  check('プレイヤーを用意', !!tok, u.error || '');

  // 装備タブが読むもの
  const shop = await j('/api/shop', {}, tok);
  check('/api/shop がカタログを返す', shop.status === 200 && shop.items.length > 0 && Array.isArray(shop.boosters),
    `items=${shop.items.length} boosters=${(shop.boosters || []).length}`);
  check('カタログの各項目に cat と name がある', shop.items.every(i => i.cat && i.name), '');
  const slots = new Set(shop.items.map(i => i.cat));
  check('4スロットぶんそろっている', ['skin', 'board', 'fx', 'ult'].every(s => slots.has(s)), [...slots].join(','));

  // インベントリの「コレクション n/33」は非既定・非管理者専用の数と一致する
  // インベントリの「n / 33」とガチャの「n / 33」がズレると、同じものを数えて
  // いるのに違う数字が2画面に出る。母数はサーバー側の定義に合わせる。
  // throneOnly（👑管理者イベント専用ショップの品）は、ショップでもガチャでも
  // 手に入らない。分母に入れると「あと7種」がいつまでも減らない見え方になる。
  const collectibles = shop.items.filter(i => !i.adminOnly && !i.throneOnly && !i.default).length;
  const gacha = await j('/api/gacha/info', {}, tok);
  check('ガチャがコレクション集計を返す', !!(gacha.collection && typeof gacha.collection.total === 'number'),
    JSON.stringify(gacha.collection));
  check('コレクション母数がガチャの集計と一致する',
    gacha.collection.total === collectibles, `inv=${collectibles} gacha=${gacha.collection.total}`);
  // 上の規則は画面側にも同じ形で入っていなければ意味がない。
  const screensSrc = fs.readFileSync('public/js/screens.js', 'utf8');
  check('在庫画面の母数も throneOnly を外している',
    screensSrc.includes('!i.adminOnly && !i.throneOnly && !i.default'), '');
  check('在庫の「あと何種」も throneOnly を数えていない',
    screensSrc.includes('!i.adminOnly && !i.throneOnly).length'), '');

  // 称号タブ
  const titles = await j('/api/titles', {}, tok);
  check('/api/titles が一覧と獲得状況を返す',
    titles.status === 200 && titles.titles.length > 0 && Array.isArray(titles.earned),
    `titles=${(titles.titles || []).length} earned=${(titles.earned || []).length}`);
  check('称号に解除条件の文言がある', titles.titles.every(t => t.desc && t.name), '');

  // 装備の付け替え（インベントリからも同じ経路を使う）
  const me0 = await j('/api/me', {}, tok);
  check('初期装備が入っている', !!me0.user.equipped.skin, JSON.stringify(me0.user.equipped));
  const locked = shop.items.find(i => i.cat === 'skin' && !i.default && !i.adminOnly);
  const bad = await j('/api/equip', { method: 'POST', body: { slot: 'skin', itemId: locked.id } }, tok);
  check('未所持のアイテムは装備できない', bad.status >= 400, `status=${bad.status}`);

  // 管理者の🎒編集で持たせてから装備する（両機能の結合確認）
  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const atk = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;
  await j(`/api/admin/users/${me0.user.id}`, { method: 'POST', token: atk, body: { setOwned: [locked.id] } }, atk);
  const ok = await j('/api/equip', { method: 'POST', body: { slot: 'skin', itemId: locked.id } }, tok);
  check('所持していれば装備できる', ok.status === 200, `${ok.status} ${ok.error || ''}`);
  const me1 = await j('/api/me', {}, tok);
  check('装備が反映される', me1.user.equipped.skin === locked.id, me1.user.equipped.skin);
  check('所持品リストにも入っている', me1.user.owned.includes(locked.id), '');

  // アイテムタブが読むもの
  check('publicUser に items が含まれる', typeof me1.user.items === 'object', JSON.stringify(me1.user.items));
  check('publicUser に badges が含まれる', Array.isArray(me1.user.badges), '');
  check('publicUser に thrones が含まれる（王座タブ用）', Array.isArray(me1.user.thrones), JSON.stringify(me1.user.thrones));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
