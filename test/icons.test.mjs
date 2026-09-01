// リポジトリのルートから:  node test/icons.test.mjs
//
// 「商品を足したのに、アイコン表を更新し忘れる」を構造的に止める検査。
//
// ■ なぜ要るのか
// ショップの絵は長いあいだ絵文字だった。絵文字は**別の商品に同じ絵を割り当てても
// 誰も止めてくれない**ので、実際にこうなっていた:
//   ・エフェクト15品のうち8品が同じ ✨
//   ・ガチャの結果はカテゴリ共通アイコン（スキン19品すべて 🧊 /
//     ボード21品すべて 🖼️ / エフェクト15品すべて ✨）
//   ・🛡️ が奥義「不落の城塞」と管理者ブースター「絶対防御」の両方
//   ・👑 が管理者イベント・二冠・三冠・五冠のバッジで4重
// 棚に並べても画面は壊れないし、例外も出ない。だから遊んでも気づけない。
// 気づくのはプレイヤーが「どれがどれだか分からない」と言ったときだけだった。
//
// ■ この検査の方針
// 定数は書き写さない。**必要な id はすべて実装から読む**
//   ・装備とブースター … server/catalog.js を import する
//   ・ボス            … 同じく BOSSES / RAID_BOSSES
//   ・バッジ          … public/js/screens.js の BADGE_ORDER をソースから読む
// なので「商品を1つ足す」と、アイコンを足すまでこのテストが赤くなる。
// 書き写した一覧を持つと、その一覧ごと更新を忘れて検査が嘘をつくようになる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHOP_ITEMS, BOOST_ITEMS, BOSSES, RAID_BOSSES } from '../server/catalog.js';
import * as icons from '../public/js/icons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
// screens.js は LF、他は CRLF で保存されているファイルがある。
// 改行を揃えてから正規表現にかけないと、片方だけ0件になって検査が黙って死ぬ。
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`❌ ${name} — ${detail}`); }
}

// ---------------------------------------------------------------------------
// 1. 商品の id すべてに固有アイコンがあるか
// ---------------------------------------------------------------------------
// エフェクトと奥義は「1品ずつ絵が違う」ことに意味がある棚なので、
// カテゴリ共通アイコンへの取りこぼしを許さない（hasIcon が id そのものに
// 当たること）。スキンとボードは themes.js の canvas 描画と CSS グラデーションで
// すでに1品ずつ違う絵になっているので、ここでは見ない。
for (const cat of ['fx', 'ult']) {
  const ids = SHOP_ITEMS.filter(i => i.cat === cat).map(i => i.id);
  const missing = ids.filter(id => !icons.hasIcon(id));
  check(`${cat} の全商品にアイコンがある（${ids.length}品）`, missing.length === 0,
    missing.length ? `public/js/icons.js に足りない: ${missing.join(', ')}` : `${ids.length}品すべて`);
}

const boostMissing = BOOST_ITEMS.map(i => i.id).filter(id => !icons.hasIcon(id));
check(`ブースター全品にアイコンがある（${BOOST_ITEMS.length}品）`, boostMissing.length === 0,
  boostMissing.length ? `足りない: ${boostMissing.join(', ')}` : `${BOOST_ITEMS.length}品すべて`);

// ボス。戦闘中の #bossEmoji は画面でいちばん大きい絵なので、
// 端末ごとに顔が変わる絵文字のままにしておけない。
const bossIds = [...BOSSES, ...RAID_BOSSES].map(b => b.id);
const bossMissing = bossIds.filter(id => !icons.hasIcon(`boss_${id}`));
check(`ボス全体にアイコンがある（${bossIds.length}体）`, bossMissing.length === 0,
  bossMissing.length ? `boss_<id> が足りない: ${bossMissing.join(', ')}` : `${bossIds.length}体すべて`);

// ---------------------------------------------------------------------------
// 2. バッジ（screens.js の BADGE_ORDER をソースから読む）
// ---------------------------------------------------------------------------
const screensSrc = read('public/js/screens.js');
const badgeOrderM = /const BADGE_ORDER\s*=\s*\[([\s\S]*?)\]/.exec(screensSrc);
if (!badgeOrderM) {
  // 読めないまま素通りさせない。0件で緑になる検査は、存在しないのと同じどころか
  // 「見張られている」と勘違いさせるぶん有害。
  check('screens.js の BADGE_ORDER を読める', false,
    'const BADGE_ORDER = [...] が見つからない。表を動かしたなら test/icons.test.mjs の正規表現も直すこと');
} else {
  const badgeIds = [...badgeOrderM[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
  check('BADGE_ORDER を読めた', badgeIds.length > 0, `${badgeIds.length}種`);
  const badgeMissing = badgeIds.filter(id => !icons.hasIcon(`badge_${id}`));
  check(`バッジ全種にアイコンがある（${badgeIds.length}種）`, badgeMissing.length === 0,
    badgeMissing.length ? `badge_<id> が足りない: ${badgeMissing.join(', ')}` : `${badgeIds.length}種すべて`);
  // 🏛 シーズン刻印（s12champ のように毎シーズン増える id）は1つに集約する。
  check('シーズン刻印がまとめアイコンに落ちる',
    icons.badgeIconName('s12champ') === 'badge_season' && icons.hasIcon('badge_season'),
    `badgeIconName('s12champ') = ${icons.badgeIconName('s12champ')}`);
}

// ---------------------------------------------------------------------------
// 3. ランク6帯
// ---------------------------------------------------------------------------
// しきい値は dom.js rankOf / server/battle.js RANK_TIERS と揃える約束なので、
// 帯が1つでも欠けると「レートはあるのに段位の絵が出ない」になる。
const RANKS = ['rank_bronze', 'rank_silver', 'rank_gold', 'rank_platinum', 'rank_diamond', 'rank_master'];
const rankMissing = RANKS.filter(n => !icons.hasIcon(n));
check('ランク6帯がそろっている', rankMissing.length === 0,
  rankMissing.length ? `足りない: ${rankMissing.join(', ')}` : RANKS.join(' / '));
// 帯ごとに絵が違うこと（色だけの違いだと白黒で潰れる）は 5. の重複検査が見る。
check('rankIconName がレートで6帯を返し分ける',
  ['rank_bronze', 'rank_silver', 'rank_gold', 'rank_platinum', 'rank_diamond', 'rank_master']
    .every((want, i) => icons.rankIconName([0, 950, 1100, 1300, 1500, 1700][i]) === want),
  '0 / 950 / 1100 / 1300 / 1500 / 1700');

// ---------------------------------------------------------------------------
// 4. すべてのアイコンが中身を持っている
// ---------------------------------------------------------------------------
const names = icons.iconNames();
check('アイコンが1つ以上ある', names.length > 0, `${names.length}個`);

// icon() が返す <svg ...>…</svg> の中身だけを取り出す。
const bodyOf = name => icons.icon(name).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

const empty = names.filter(n => !/<(path|circle|rect|ellipse)\b/.test(bodyOf(n)));
check('すべてのアイコンが空でない', empty.length === 0,
  empty.length ? `中身が無い: ${empty.join(', ')}` : `${names.length}個すべてに図形がある`);

// ---------------------------------------------------------------------------
// 5. 同じ絵が2つの名前に付いていないか
// ---------------------------------------------------------------------------
// これがこのファイルの本題。エフェクト15品が「値段だけ違う同じ絵」で
// 並んでいたのを、二度と起こさないための番人。
const byShape = new Map();
const dupes = [];
for (const n of names) {
  const key = bodyOf(n).replace(/\s+/g, ' ').trim();
  if (byShape.has(key)) dupes.push(`${byShape.get(key)} = ${n}`);
  else byShape.set(key, n);
}
check('同じ図形を持つアイコンが無い', dupes.length === 0,
  dupes.length ? `絵が同じ: ${dupes.join(' / ')}` : `${names.length}個すべて別の絵`);

// エフェクトだけは名指しでもう一度見る（ここが元の不具合そのもの）。
const fxIds = SHOP_ITEMS.filter(i => i.cat === 'fx').map(i => i.id);
const fxShapes = new Set(fxIds.filter(id => icons.hasIcon(id)).map(id => bodyOf(id).replace(/\s+/g, ' ').trim()));
check('エフェクト全品が別々の絵', fxShapes.size === fxIds.length,
  `${fxIds.length}品 / 異なる絵 ${fxShapes.size}種`);

// ---------------------------------------------------------------------------
// 6. 絵文字からの逆引きが復活していないか
// ---------------------------------------------------------------------------
// 絵文字→アイコンの1対1対応は原理的に作れない。「同じ絵文字が複数の意味で
// 使われている」ことが元の不具合なので、絵文字を鍵にすると ✨ の8品が
// また同じアイコンに戻る。生やし直されていないことを見張る。
check('iconForEmoji がエクスポートされていない', !('iconForEmoji' in icons),
  '絵文字→アイコンの逆引きは新しい重複を作るので復活させないこと');
check('EMOJI_MAP がエクスポートされていない', !('EMOJI_MAP' in icons), '同上');
check('rankIcon / rankIconName は残っている',
  typeof icons.rankIcon === 'function' && typeof icons.rankIconName === 'function',
  '他の画面が段位表示に使う');

// ---------------------------------------------------------------------------
// 7. id 引きの入口（itemIconName / bossIconName）
// ---------------------------------------------------------------------------
check('itemIconName が固有アイコンを優先する',
  icons.itemIconName({ id: 'fx_sakura', cat: 'fx' }) === 'fx_sakura'
  && icons.itemIconName('ult_meteor') === 'ult_meteor',
  'id に絵があるならカテゴリ共通へ落とさない');
check('itemIconName が未知の id でカテゴリ共通へ落ちる',
  icons.itemIconName({ id: 'skin_notyet', cat: 'skin' }) === 'cat_skin'
  && icons.itemIconName('board_notyet') === 'cat_board',
  '新商品が「絵の無い空欄」にならない');
check('bossIconName が未知のボスでも描ける',
  icons.bossIconName('slime') === 'boss_slime' && icons.hasIcon(icons.bossIconName('nosuchboss')),
  `未知は ${icons.bossIconName('nosuchboss')} に落ちる`);

// ---------------------------------------------------------------------------
console.log('');
console.log(`${fail ? '❌' : '✅'} ${pass} 件成功 / ${fail} 件失敗`);
if (fail) process.exitCode = 1;
