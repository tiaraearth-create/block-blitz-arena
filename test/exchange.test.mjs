// リポジトリのルートから:  node test/exchange.test.mjs
//
// 🔄 交換所 — コインとジェムの「使い道」。
//
// ■ なぜ要るのか
// この世界は蛇口ばかりで出口が無かった。1日に入るのはコイン最大150,000・
// ジェム120。対してショップの品は全52点あわせて 69,900🪙＋3,150💎 しかなく、
// 半日遊べば棚が空になる。交換所は「ここでしか手に入らない見た目」を週替わりで
// 並べる、恒久的な出口。
//
// ■ ここで守ること
//   A. 品揃えは**週の番号だけで決まる**（全員同じ・再起動しても同じ・db に書かない）
//   B. 全部の品が**同じ回数だけ順に回ってくる**（偏ると「永久に出ない品」ができる）
//   C. 交換所限定は**他の3経路（棚・ガチャ・図鑑）に漏れない**
//      ← このリポジトリでいちばん多い事故の形。経路を1つ足すと必ずどこか抜ける
//   D. 値段はサーバーのカタログからしか読まない（申告した金額を信じない）
//   E. 図鑑の母数に数えない（週替わり＝逃した週の品は取れないので、
//      数えると達成できない図鑑になる）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';
import { exchangeStock, EXCHANGE_SLOTS } from '../server/exchange.js';
import {
  SHOP_ITEMS, EXCHANGE_ITEMS, isBuyableGear, isGachaPoolGear, isCollectibleGear,
} from '../server/catalog.js';
import { BOARDS } from '../public/js/themes.js';
import { ParticleSystem } from '../public/js/particles.js';
import { CATALOG_EN } from '../public/js/catalog-en.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-exchange-test-${PORT}`);
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

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0', SESSION_SECRET: 'exchange-test', SEED_RESTORE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null) throw new Error(`サーバーが起動直後に終了しました (${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

// ===========================================================================
// A. 品揃えの決まり方（サーバー無しで確かめられる）
// ===========================================================================
check('A-0 交換所の品がカタログにある', EXCHANGE_ITEMS.length >= EXCHANGE_SLOTS,
  `${EXCHANGE_ITEMS.length}点 / 枠${EXCHANGE_SLOTS}`);
{
  const a = exchangeStock('W2954').map(i => i.id).join(',');
  const b = exchangeStock('W2954').map(i => i.id).join(',');
  check('A-1 同じ週なら何度呼んでも同じ（乱数を使っていない）', a === b, a);
  check('A-2 枠の数だけ並ぶ', exchangeStock('W2954').length === Math.min(EXCHANGE_SLOTS, EXCHANGE_ITEMS.length), a);
  const w1 = exchangeStock('W2954').map(i => i.id).join(',');
  const w2 = exchangeStock('W2955').map(i => i.id).join(',');
  check('A-3 週が変われば品揃えも変わる', w1 !== w2, `${w1} / ${w2}`);
  const dup = exchangeStock('W2954').map(i => i.id);
  check('A-4 同じ品が同じ週に2つ並ばない', new Set(dup).size === dup.length, dup.join(','));
}
{
  // ⚠ ここが本題。偏ると「何週待っても出ない品」ができる。
  const seen = new Map();
  const WEEKS = EXCHANGE_ITEMS.length * 4;
  for (let n = 3000; n < 3000 + WEEKS; n++) {
    for (const it of exchangeStock(`W${n}`)) seen.set(it.id, (seen.get(it.id) || 0) + 1);
  }
  const counts = EXCHANGE_ITEMS.map(i => seen.get(i.id) || 0);
  const lo = Math.min(...counts), hi = Math.max(...counts);
  check('A-5 全部の品が必ず順に回ってくる（出ない品が無い）', lo > 0,
    EXCHANGE_ITEMS.filter(i => !seen.get(i.id)).map(i => i.id).join(',') || 'なし');
  check('A-6 出現回数が偏らない', hi - lo <= 1, `最少${lo} 最多${hi}（${WEEKS}週）`);
}
{
  // 品揃えにカテゴリが混ざる週があること（全部 board の週ばかりだと、
  // エフェクト待ちの人が何週も待たされる）。
  let mixed = 0;
  for (let n = 3000; n < 3020; n++) {
    if (new Set(exchangeStock(`W${n}`).map(i => i.cat)).size > 1) mixed++;
  }
  check('A-7 カテゴリが混ざる週がほとんど', mixed >= 15, `20週中 ${mixed}週`);
}

// ===========================================================================
// B. 他の経路に漏れていないこと ← 事故が起きるとしたらここ
// ===========================================================================
check('B-1 通常の棚に並ばない', SHOP_ITEMS.filter(isBuyableGear).every(i => !i.exchangeOnly), '');
check('B-2 ガチャの抽選に入らない', SHOP_ITEMS.filter(isGachaPoolGear).every(i => !i.exchangeOnly), '');
check('B-3 図鑑の母数に数えない', SHOP_ITEMS.filter(isCollectibleGear).every(i => !i.exchangeOnly), '');
check('B-4 交換所の品はすべて 見た目だけ（強さに影響しない）',
  EXCHANGE_ITEMS.every(i => i.cat === 'board' || i.cat === 'fx' || i.cat === 'skin'),
  EXCHANGE_ITEMS.filter(i => !['board', 'fx', 'skin'].includes(i.cat)).map(i => i.id).join(','));
check('B-5 値段が入っている', EXCHANGE_ITEMS.every(i => Number(i.exPrice) > 0),
  EXCHANGE_ITEMS.filter(i => !(Number(i.exPrice) > 0)).map(i => i.id).join(','));
{
  // 実際に描けること。定義だけ足して絵が無い＝灰色の四角、が起きないように。
  const missBoard = EXCHANGE_ITEMS.filter(i => i.cat === 'board' && !BOARDS[i.id]).map(i => i.id);
  check('B-6 board が themes.js に実在する', missBoard.length === 0, missBoard.join(','));
  const ps = new ParticleSystem();
  const missFx = EXCHANGE_ITEMS.filter(i => i.cat === 'fx').filter(i => {
    ps.particles.length = 0;
    ps.burstCell(10, 10, 20, 6, i.id);
    return ps.particles.length === 0;
  }).map(i => i.id);
  check('B-7 fx が実際に粒を出す（burstCell に繋がっている）', missFx.length === 0, missFx.join(','));
  const missEn = EXCHANGE_ITEMS.filter(i => !CATALOG_EN[i.id]).map(i => i.id);
  check('B-8 英語名がある', missEn.length === 0, missEn.join(','));
}

// ===========================================================================
// B2. 引き換えそのもの（関数を直接通す）
// ===========================================================================
// 成功経路はサーバーを立てなくても見られる。
// ★ ここで守るのは「**値段はカタログからしか読まない**」こと。
{
  const { buyExchange } = await import('../server/exchange.js');
  const week = 'W2954';
  const it = exchangeStock(week)[0];
  const priceOf = i => Math.floor(Number(i.exPrice) || 0);
  const cur = it.exCurrency === 'gems' ? 'gems' : 'coins';

  const rich = { coins: 999999, gems: 9999, owned: [] };
  const out = buyExchange(rich, week, it.id);
  check('B2-1 買える', !!out.ok, JSON.stringify(out).slice(0, 90));
  check('B2-2 持ち物に入る', rich.owned.includes(it.id), rich.owned.join(','));
  check('B2-3 カタログの値段ちょうど引かれる',
    rich[cur] === (cur === 'gems' ? 9999 : 999999) - priceOf(it), `${cur}=${rich[cur]}`);
  const again = buyExchange(rich, week, it.id);
  check('B2-4 二度買いは断る', !!again.error, JSON.stringify(again).slice(0, 70));

  // ★ クライアントが金額を名乗っても見ない。
  const cheat = { coins: 999999, gems: 9999, owned: [] };
  buyExchange(cheat, week, it.id, { price: 1 });
  check('B2-5 申告された金額を見ない',
    cheat[cur] === (cur === 'gems' ? 9999 : 999999) - priceOf(it), `${cur}=${cheat[cur]}`);

  const broke = { coins: 0, gems: 0, owned: [] };
  const no = buyExchange(broke, week, it.id);
  check('B2-6 足りなければ引かない', !!no.error && broke[cur] === 0, JSON.stringify(no).slice(0, 70));
}

// ===========================================================================
// C. API（サーバーを立てて実際に叩く）
// ===========================================================================
try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const reg = await j('/api/register', { method: 'POST', body: { username: '交換所検証', password: 'pw-exchange-1' } });
  check('C-0 前提: 登録できた', !!reg.token, JSON.stringify(reg).slice(0, 80));
  const tok = reg.token;

  const anon = await j('/api/exchange');
  check('C-1 未ログインでは見られない', anon.status === 401 || anon.status === 403, String(anon.status));

  const view = await j('/api/exchange', {}, tok);
  check('C-2 品揃えを返す', view.status === 200 && Array.isArray(view.items), JSON.stringify(view).slice(0, 90));
  check('C-3 今週が終わる時刻を返す', view.endsAt > Date.now(), String(view.endsAt));
  check('C-4 全員に同じ品揃え（サーバーの週の番号だけで決まる）',
    view.items.map(i => i.id).join(',') === exchangeStock(view.week).map(i => i.id).join(','),
    view.items.map(i => i.id).join(','));

  const target = view.items.find(i => i.currency === 'coins') || view.items[0];
  check('C-5 前提: 買う品を選べた', !!target, '');

  // お金が無ければ買えない（新規は 1,000🪙 前後）。
  const poor = await j('/api/exchange/buy', { method: 'POST', body: { itemId: target.id } }, tok);
  check('C-6 足りなければ断る', poor.status === 400 && /足りません/.test(poor.error || ''), JSON.stringify(poor).slice(0, 90));

  // 今週並んでいない品は買えない（週替わりの意味が消えるので、ここは固い）。
  const notListed = EXCHANGE_ITEMS.find(i => !view.items.some(v => v.id === i.id));
  if (notListed) {
    const off = await j('/api/exchange/buy', { method: 'POST', body: { itemId: notListed.id } }, tok);
    check('C-7 今週並んでいない品は買えない', off.status === 400, JSON.stringify(off).slice(0, 90));
  }
  const bogus = await j('/api/exchange/buy', { method: 'POST', body: { itemId: 'board_default' } }, tok);
  check('C-8 交換所の品でないものは買えない', bogus.status === 400, JSON.stringify(bogus).slice(0, 80));

  // 通常のショップからは買えない（経路の混線を止める）。
  const viaShop = await j('/api/shop/buy', { method: 'POST', body: { itemId: target.id } }, tok);
  check('C-9 通常のショップからは買えない', viaShop.status === 403 || viaShop.status === 400,
    `${viaShop.status} ${viaShop.error || ''}`);
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
