// リポジトリのルートから:  node test/oppskin.test.mjs
//
// 🎨 相手の盤面を「相手が装備しているブロック」で描く。
//
// ■ なぜ住人にスキンを配るのが**先**なのか
// 住人（合成されたAIプレイヤー）にはスキンの欄が無かった。そのまま相手の
// スキンを見せるようにすると、実プレイヤーは色々着るのに住人だけが全員
// 既定 ── これは確率的な手がかりではなく **一方向に100%確実な判定** になる。
// 「既定しか着ない名前」の一覧が遊ぶほど積み上がり、残り全員が容疑者になる。
// このゲームで最も強い制約は「住人がAIだと悟られないこと」なので、
// 配るほうを先にやってから表示を入れた。
//
// ■ ここで守ること
//   A. 住人にスキンがあり、**既定ばかりではない**（★A-2 がこのテストの本題）
//   B. 名簿を1ビットも動かしていない（★B-1 ── makeResident の乱数列に
//      1回でも足すと、以降の住人の名前・強さ・参加日が全部ずれる）
//   C. 実プレイヤーが買える範囲だけを着せる（逆向きの判定器を作らない）
//   D. 欄は全席に必ずある（undefined は JSON から消えるので、欄の有無が名簿になる）
//   E. 知らないid・細工したidを受け取っても描画が壊れない
import crypto from 'node:crypto';
import { buildRoster, ROSTER_SIZE } from '../server/residents.js';
import { residentSkin, seatProfile } from '../server/ambient.js';
import { SHOP_ITEMS, isBuyableGear, DEFAULT_EQUIPPED } from '../server/catalog.js';
import { getSkin, getBoard, SKINS } from '../public/js/themes.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const roster = buildRoster();
const skins = roster.map(residentSkin);

// ===========================================================================
// A. 住人がスキンを持っている
// ===========================================================================
check('A-1 全員がスキンidの文字列を持つ',
  skins.every(s => typeof s === 'string' && s.length > 0),
  `${skins.filter(s => typeof s !== 'string').length}件が文字列でない`);

{
  // ★本題。既定ばかりだと「既定＝住人」の判定器になる。
  //   逆に全員が着替えていても「着替えていない人＝実プレイヤー」で割れるので、
  //   既定も**それなりに居る**こと。上下どちらにも寄っていないかを見る。
  const def = skins.filter(s => s === DEFAULT_EQUIPPED.skin).length;
  const rate = def / skins.length;
  check('A-2 ★既定ばかりでも、全員着替えでもない（0.15〜0.55）',
    rate >= 0.15 && rate <= 0.55, `既定 ${(rate * 100).toFixed(0)}%（${def}/${skins.length}）`);
}
{
  // 種類が偏っていると「この色＝住人」になる。半分以上の種類が使われること。
  const kinds = new Set(skins.filter(s => s !== DEFAULT_EQUIPPED.skin));
  const pool = SHOP_ITEMS.filter(i => i.cat === 'skin' && isBuyableGear(i));
  check('A-3 買えるスキンの半分以上が実際に使われている',
    kinds.size >= Math.ceil(pool.length / 2), `${kinds.size} / ${pool.length}種`);
}
{
  // 何度呼んでも同じ。試合ごとに変わると「装備が固定されない人＝住人」になる。
  const again = roster.map(residentSkin);
  check('A-4 何度呼んでも同じ（試合ごとに変わらない）',
    skins.join(',') === again.join(','), '');
}

// ===========================================================================
// B. ★名簿を動かしていない
// ===========================================================================
{
  // ⚠ residents.js の makeResident は、住人を1人作るごとに決まった回数だけ
  //   乱数を引く。スキンを決めるためにそこで**1回でも引く**と、以降の住人の
  //   名前・強さ・参加日・活動時間が全部ずれる（＝ある日いきなり
  //   「知っている名前が別人になる」）。residents.js が
  //   「乱数の消費順は変えていない」と繰り返し書いているのはこのため。
  //   だからスキンは**名前から決め打ち**していて、名簿には触れない。
  //   ここはその約束を、名簿そのものの指紋で押さえる。
  const sig = roster
    .map(x => [x.id, x.name, x.arch, x.skill, x.joinedDay, x.registered, x.hours.join('-')].join('|'))
    .join('\n');
  const got = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  // v2.72 時点の名簿。**スキンを足しても変わってはいけない。**
  // ここが変わったら、名簿の作り方そのものを変えている（意図的なら値を更新し、
  // 意図していないなら乱数の引き方を戻すこと）。
  const WANT = 'c6ce7ca70a264f2e';
  check('B-1 ★名簿が1ビットも変わっていない', got === WANT, `${got} / 期待 ${WANT}`);
  check('B-2 人数も変わっていない', roster.length === ROSTER_SIZE,
    `${roster.length} / ${ROSTER_SIZE}`);
}

// ===========================================================================
// C. 着せてよい範囲だけ
// ===========================================================================
{
  // 実プレイヤーが買えない物（運営専用・王座専用・ガチャ限定・交換所限定）を
  // 着ていると、**逆向きに**「手に入らないはずの物を着ている人」で一発で割れる。
  const ok = new Set([DEFAULT_EQUIPPED.skin,
    ...SHOP_ITEMS.filter(i => i.cat === 'skin' && isBuyableGear(i)).map(i => i.id)]);
  const bad = [...new Set(skins)].filter(s => !ok.has(s));
  check('C-1 ★入手できないスキンを着ていない', bad.length === 0, bad.join(','));

  const real = [...new Set(skins)].filter(s => !SKINS[s]);
  check('C-2 実在するスキンだけ（描画関数がある）', real.length === 0, real.join(','));
}
{
  // 未登録（ゲスト表示）の住人は既定。本物のゲストは買い物ができないので、
  // ここで着替えさせると「ゲスト名なのに買った見た目＝人間ではない」になる。
  const guests = roster.filter(r => r.registered === false);
  const dressed = guests.filter(r => residentSkin(r) !== DEFAULT_EQUIPPED.skin);
  check('C-3 ゲスト表示の住人は既定のまま',
    dressed.length === 0, dressed.map(r => r.name).join(','));
  check('C-4 前提: ゲスト表示の住人が実際に居る', guests.length > 0, `${guests.length}人`);
}

// ===========================================================================
// D. 欄は全席に必ずある
// ===========================================================================
{
  // ⚠ 送信は JSON.stringify なので undefined のキーは出力から**消える**。
  //   「skin 欄がある席／無い席」の差は、値の差より分かりやすい名簿になる。
  const cases = [
    ['住人', { resident: roster[0], name: roster[0].name }],
    ['使い捨て', { name: 'ためし太郎', level: 'normal' }],
    ['ゲスト席', { name: 'ゲスト123', registered: false }],
    ['名前なし', {}],
  ];
  const bad = [];
  for (const [label, arg] of cases) {
    const p = seatProfile(arg);
    if (!('skin' in p)) bad.push(`${label}: 欄が無い`);
    else if (typeof p.skin !== 'string' || !p.skin) bad.push(`${label}: ${JSON.stringify(p.skin)}`);
  }
  check('D-1 ★どの席でも skin が文字列で返る（null / undefined にしない）',
    bad.length === 0, bad.join(' / '));

  const keys = cases.map(([, a]) => Object.keys(seatProfile(a)).sort().join(','));
  check('D-2 席の種類が違っても欄の集合が同じ',
    new Set(keys).size === 1, keys.join(' vs '));
}

// ===========================================================================
// E. 受け取る側が壊れない
// ===========================================================================
{
  // ⚠ SKINS は素のオブジェクトなので Object.prototype を継承している。
  //   `SKINS[id] || SKINS.skin_default` と書いていると、'constructor' や
  //   'toString' で **Object.prototype の関数** が返り（真値なのでフォールバックを
  //   すり抜ける）、'__proto__' なら関数ですらない object が返って呼んだ瞬間に
  //   TypEError。盤面は毎フレーム描くので、細工した1つの値で画面が落ち続ける。
  //   スキンidが**通信で外から届くようになった**ので、受け取る側で塞ぐ。
  const nasty = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
    'skin_nope', '', null, undefined, 42, {}, []];
  const bad = nasty.filter(id => typeof getSkin(id) !== 'function');
  check('E-1 ★細工したidでも必ず関数が返る', bad.length === 0,
    bad.map(x => String(x)).join(','));
  const badB = nasty.filter(id => { const b = getBoard(id); return !b || !b.bg; });
  check('E-2 ボードも同じ', badB.length === 0, badB.map(x => String(x)).join(','));
  // 既定に落ちていること（別のスキンが返ってきたら、それはそれで事故）
  check('E-3 知らないidは既定のスキンに落ちる',
    getSkin('__proto__') === getSkin('skin_default'), '');
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
