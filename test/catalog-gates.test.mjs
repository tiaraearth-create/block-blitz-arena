// リポジトリのルートから:  node test/catalog-gates.test.mjs
//
// 🚪 入手経路の関門。**server/catalog.js:139 が名指しで「これが見張っている」と
//    書いているのに、このファイルは存在していなかった。**
//
// ■ 何を守るのか
//   装備の入手経路は5つあり、1つに属する品は他に出してはいけない。
//     既定(default) / 普通の棚 / 👑王座の欠片(throneOnly) /
//     🎰ガチャ限定(gachaOnly) / 🔄交換所限定(exchangeOnly) / 運営専用(adminOnly)
//   この条件は以前 18か所に手書きでコピーされていて、経路を1つ足すたびに
//   18か所を直すことになっていた。1つ忘れると
//     「ガチャで交換所限定が出る」「棚に並ぶのに買えない」
//   という形で**静かに**壊れる ── このリポジトリでいちばん多い事故の形。
//   なので判定は catalog.js の述語にしか書かない、という約束にしてある。
//
//   ★ このテストの本題は B節「述語を外で手書きしていないか」。
//     約束そのものを機械で確かめる唯一の場所なので、ここが緑でないなら
//     catalog.js の述語は飾りになっている。
//
// ■ 実際にこのテストが見つけた食い違い（v2.70 で修正）
//   server/achievements.js が母数を `!i.adminOnly` と手書きしていて、
//   実績「伝説の収集家」は 72種、図鑑は 51種 を数えていた（21種ずれ）。
//   しかも進捗は owned.length（既定も王座も交換所も込み）で、母数と分子が
//   最初から別の物差しだった。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHOP_ITEMS, BOOST_ITEMS, EXCHANGE_ITEMS,
  isBuyableGear, isGachaPoolGear, isCollectibleGear, isTalkableGear, isExchangeGear,
} from '../server/catalog.js';
import { ACHIEVEMENTS } from '../server/achievements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const ROUTES = ['default', 'adminOnly', 'throneOnly', 'gachaOnly', 'exchangeOnly'];
const routesOf = i => ROUTES.filter(k => !!i[k]);

// ===========================================================================
// A. 経路が重なっていない・穴が開いていない
// ===========================================================================
{
  const multi = SHOP_ITEMS.filter(i => routesOf(i).length > 1)
    .map(i => `${i.id}(${routesOf(i).join('+')})`);
  check('A-1 1つの品が2つの経路に属していない', multi.length === 0, multi.join(' '));
}
{
  // 経路の印が無い＝普通の棚。値段が無いと「並ぶのに買えない」品になる。
  const plain = SHOP_ITEMS.filter(i => routesOf(i).length === 0);
  const noPrice = plain.filter(i => !(Number(i.price) > 0)).map(i => i.id);
  check('A-2 普通の棚の品には値段がある', noPrice.length === 0, noPrice.join(','));
  check('A-3 普通の棚 = isBuyableGear', plain.length === SHOP_ITEMS.filter(isBuyableGear).length,
    `${plain.length} / ${SHOP_ITEMS.filter(isBuyableGear).length}`);
}
{
  // 交換所限定には exPrice が要る（exchangeStock が exPrice>0 で絞るので、
  // 付け忘れた品は**どの週にも並ばない**＝二度と手に入らない）。
  const bad = SHOP_ITEMS.filter(isExchangeGear).filter(i => !(Number(i.exPrice) > 0)).map(i => i.id);
  check('A-4 交換所限定には交換値段がある（無いと一生並ばない）', bad.length === 0, bad.join(','));
  check('A-5 EXCHANGE_ITEMS と述語が一致',
    EXCHANGE_ITEMS.length === SHOP_ITEMS.filter(isExchangeGear).length,
    `${EXCHANGE_ITEMS.length} / ${SHOP_ITEMS.filter(isExchangeGear).length}`);
}
{
  // 4つの述語が、経路の定義どおりに効いているか（1品ずつ突き合わせる）。
  const wrong = [];
  for (const i of SHOP_ITEMS) {
    const r = routesOf(i);
    const want = {
      buy: r.length === 0,
      gacha: !i.default && !i.adminOnly && !i.throneOnly && !i.exchangeOnly,
      coll: !i.default && !i.adminOnly && !i.throneOnly && !i.exchangeOnly,
      ex: !!i.exchangeOnly,
    };
    if (isBuyableGear(i) !== want.buy) wrong.push(`${i.id}:buy`);
    if (isGachaPoolGear(i) !== want.gacha) wrong.push(`${i.id}:gacha`);
    if (isCollectibleGear(i) !== want.coll) wrong.push(`${i.id}:coll`);
    if (isExchangeGear(i) !== want.ex) wrong.push(`${i.id}:ex`);
  }
  check('A-6 述語が経路の定義どおり', wrong.length === 0, wrong.slice(0, 5).join(' '));
}
{
  // 交換所限定が他の3経路に漏れていないか（exchange.test.mjs と同じ本題を
  // 述語の側から見る。あちらは棚・ガチャ・図鑑の**出力**を見ている）。
  const ex = SHOP_ITEMS.filter(isExchangeGear);
  check('A-7 交換所限定は棚に出ない', ex.every(i => !isBuyableGear(i)), '');
  check('A-8 交換所限定はガチャに出ない', ex.every(i => !isGachaPoolGear(i)), '');
  check('A-9 交換所限定は図鑑に数えない', ex.every(i => !isCollectibleGear(i)), '');
  check('A-10 交換所限定は住人の話題にしない', ex.every(i => !isTalkableGear(i)), '');
}
{
  // 運営専用は「どこにも出ない」が唯一の正解。
  const admin = SHOP_ITEMS.filter(i => i.adminOnly);
  const leak = admin.filter(i => isBuyableGear(i) || isGachaPoolGear(i) || isCollectibleGear(i) || isExchangeGear(i));
  check('A-11 運営専用はどの経路にも出ない', leak.length === 0, leak.map(i => i.id).join(','));
  check('A-12 ブースターの運営専用も値段が無い',
    BOOST_ITEMS.filter(i => i.adminOnly).every(i => !i.price), '');
}

// ===========================================================================
// B. ★本題 — 述語を catalog.js の外で手書きしていないか
// ===========================================================================
//
// 手書きの見分け方: 経路フラグを2つ以上、1つの式の中で並べて否定しているもの。
// （`!i.adminOnly` 単独は「運営専用を隠す」正当な用途が多いので数えない。
//   ずれが起きるのは**組み合わせ**を書き写したときなので、そこだけ見る。）
//
// ⚠ 否定は「1個の !」だけを拾う。`!!i.adminOnly` は否定ではなく**真偽値への
//   変換**で、旗を応答にそのまま写しているだけ（server/routes/admin.js:428 が
//   まさにそれ）。ここを見分けないと、正しいコードを不正解にしてしまう
//   ── このテスト自身の初回で実際に起きた。
const NOT = '(?<!!)!(?!!)';
const FLAG = '[\\w.]*\\.(?:adminOnly|throneOnly|gachaOnly|exchangeOnly|default)\\b';
const GATE_RE = new RegExp(`${NOT}${FLAG}[^;\\n]{0,120}?${NOT}${FLAG}`, 'g');

// 手書きしてよい唯一の例外。クライアントはサーバーの catalog.js を import
// できない（素のJSを直で配っていて、server/ は配信していない）ので、
// screens.js だけは写しを持つ。そのぶん C節で server と一致するか照合する。
const ALLOWED = new Set(['public/js/screens.js']);

{
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'data') walk(rel); }
      else if (e.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('server'); walk('public/js');

  const offenders = [];
  for (const f of files) {
    if (f === 'server/catalog.js' || ALLOWED.has(f)) continue;
    const src = strip(read(f));
    const hits = src.match(GATE_RE);
    if (hits) offenders.push(`${f}(${hits.length})`);
  }
  check('B-1 ★経路の組み合わせを catalog.js の外で手書きしていない',
    offenders.length === 0, offenders.join(' '));
  check('B-2 前提: 走査したファイルがある', files.length > 20, `${files.length}本`);
}
{
  // catalog.js 自身は、述語をちゃんと export しているか
  // （名前を変えて中身だけ残すと、上の走査は緑のまま外の写しが復活する）。
  const cat = read('server/catalog.js');
  for (const n of ['isBuyableGear', 'isGachaPoolGear', 'isCollectibleGear', 'isTalkableGear', 'isExchangeGear']) {
    check(`B-3 ${n} を export している`, new RegExp(`export const ${n} =`).test(cat), '');
  }
  check('B-4 catalog.js がこのテストを名指ししている（約束が両方向にある）',
    /catalog-gates\.test\.mjs/.test(cat), '');
}

// ===========================================================================
// C. 母数を数える3か所が同じ物差しを使っているか
// ===========================================================================
{
  // ★ ここが実際に食い違っていた（実績72 / 図鑑51）。
  const want = SHOP_ITEMS.filter(isCollectibleGear).length;
  const ach = ACHIEVEMENTS.find(a => a.id === 'ach_own45');
  check('C-1 ★実績「伝説の収集家」の母数が図鑑と一致', !!ach && ach.goal === want,
    `実績 ${ach ? ach.goal : '無し'} / 図鑑 ${want}`);
  check('C-2 実績の文言の数字も一致', !!ach && ach.desc.includes(String(want)),
    ach ? ach.desc : '');
}
{
  // 分子（進捗）も同じ物差しか。図鑑に数えない品を持っても進まないこと。
  const ach = ACHIEVEMENTS.find(a => a.id === 'ach_own45');
  const notCounted = SHOP_ITEMS.filter(i => !isCollectibleGear(i)).slice(0, 6).map(i => i.id);
  const counted = SHOP_ITEMS.filter(isCollectibleGear).slice(0, 2).map(i => i.id);
  const v = ach ? ach.value({ owned: [...notCounted, ...counted] }) : -1;
  check('C-3 ★進捗も図鑑と同じ物差しで数える（所持の丸ごとの数ではない）',
    v === counted.length, `${notCounted.length}個の対象外＋${counted.length}個の対象 → ${v}`);
}
{
  // クライアントの写し（screens.js）が、サーバーの述語と同じ条件か。
  // 文字列で照合する ── 実行して比べられない（ブラウザ用のモジュール）ため。
  const sc = strip(read('public/js/screens.js'));
  const pick = name => {
    const m = sc.match(new RegExp(`const ${name} = ([^;]+);`));
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };
  const norm = s => (s || '').replace(/\s+/g, ' ').replace(/\bi\./g, '.').trim();
  const buy = pick('buyableGear'), coll = pick('collectibleGear');
  check('C-4 前提: クライアントの写しを取り出せた', !!buy && !!coll, `${buy} | ${coll}`);
  // サーバー側の式を catalog.js のソースから取り出して比べる。
  const cat = strip(read('server/catalog.js'));
  const sBuy = (cat.match(/export const isBuyableGear = ([^;]+);/) || [])[1];
  const sColl = (cat.match(/export const isCollectibleGear = ([^;]+);/) || [])[1];
  check('C-5 買える品の判定が サーバー と クライアント で同じ',
    norm(buy) === norm(sBuy), `client: ${norm(buy)}\n      server: ${norm(sBuy)}`);
  check('C-6 図鑑の母数の判定が サーバー と クライアント で同じ',
    norm(coll) === norm(sColl), `client: ${norm(coll)}\n      server: ${norm(sColl)}`);
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
