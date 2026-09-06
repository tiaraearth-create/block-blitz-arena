// リポジトリのルートから:  node test/nigiwai.test.mjs
//
// 🎪 にぎわい倍率。**上げても増えなかった天井**と、混んだ世界でだけ開く秘匿の穴。
//
// ■ 分かっていたこと（v2.80 の前の実測）
//   ・住人の実数は ×88 で 600人に張り付き、そこから先は倍率をいくつにしても
//     1人も増えなかった（管理画面は ×2000 まで選べるのに、×88 と ×2000 が
//     まったく同じ世界だった）。
//   ・×316 以上でマッチング待ちが **20,000回引いても1種類（毎回きっかり1200ms）**。
//     下限を置いた理由が「0秒で成立すると用意されていた席だと分かるから」なのに、
//     定数になった時点で同じことを言っている。
//   ・名簿に追随しない上限が2つ残っていた（chatgen の記憶・住人の戦績台帳）。
//     chatgen.js 冒頭が「240→600 のとき追随し忘れた」と書いているのと同じ形。
//
// ★ 本題は A-2（待ち時間が定数にならない）と C-1（加入率が統計にならない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setLiveScale, getRoster, activeResidents, matchWaitMs, residentById,
  MATCH_WAIT_FLOOR_MS,
} from '../server/ambient.js';
import { MAX_ROSTER, MAX_EXTRA_RESIDENTS, RESIDENT_RECORD_MAX } from '../server/residents.js';
import { ghostGuilds, GUILD_MAX_MEMBERS } from '../server/guilds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};
const EVE = Date.UTC(2026, 8, 6, 12);   // JST 21時（ピーク）

// ===========================================================================
// A. 倍率を上げたら本当に増えるか／待ち時間が定数にならないか
// ===========================================================================
{
  const at = s => { setLiveScale(s); return getRoster().length; };
  const r88 = at(88), r316 = at(316), r977 = at(977);
  check('A-1 ★×88 より上でも住人が増える（昔はここで頭打ちだった）',
    r316 > r88 && r977 > r316, `×88=${r88} ×316=${r316} ×977=${r977}`);

  // ★本題。混んだ世界で待ち時間が「毎回まったく同じ秒数」になっていた。
  //   0秒で成立するのと同じくらいはっきり「用意されていた席」だと言っている。
  const kinds = s => {
    setLiveScale(s);
    const v = new Set();
    for (let i = 0; i < 20000; i++) v.add(matchWaitMs(4000, 5000));
    return v;
  };
  const k316 = kinds(316), k2000 = kinds(2000);
  check('A-2 ★混んだ世界でも待ち時間が定数にならない',
    k316.size > 50 && k2000.size > 50,
    `×316=${k316.size}種 ×2000=${k2000.size}種`);
  check('A-2b 下限そのものは守る（0秒で成立しない）',
    Math.min(...k2000) >= MATCH_WAIT_FLOOR_MS, `最小 ${Math.min(...k2000)}ms`);
  // ×1 の世界は今までと1msも変えない（既定の体感を壊さない）。
  const k1 = kinds(1);
  check('A-3 ×1 の待ち時間は従来どおり 4〜9秒',
    Math.min(...k1) >= 4000 && Math.max(...k1) <= 9000,
    `${Math.min(...k1)}〜${Math.max(...k1)}ms`);
}
{
  setLiveScale(2000);
  const n = activeResidents(EVE).length;
  check('A-4 大きい世界ではロビーにも大勢いる', n > 500, `${n}人`);
}

// ===========================================================================
// B. 名簿に追随しない上限を残さない
// ===========================================================================
{
  // ⚠ 数字を2か所に書くと、片方だけ上げたときに古い住人から静かに記憶が消える。
  //   実際 chatgen が 240→600 のときに取り残された（chatgen.js 冒頭の注記）。
  const chat = src('server/chatgen.js');
  check('B-1 ★chatgen が名簿の上限を輸入している（数字を書き写さない）',
    /import \{ MAX_ROSTER, MAX_EXTRA_RESIDENTS \} from '\.\/residents\.js';/.test(chat), '');
  check('B-2 ★記憶の上限が名簿から決まる',
    /const ALL_RESIDENTS = MAX_ROSTER \+ MAX_EXTRA_RESIDENTS;/.test(chat)
    && /pruneMap\(spokeAt, ALL_RESIDENTS\);/.test(chat), '');
  check('B-3 記憶の上限に生の数字が残っていない',
    !/pruneMap\(spokeAt, \d+\)/.test(chat) && !/const MAX_RESIDENT_MEMORY = \d+;/.test(chat), '');

  const amb = src('server/ambient.js');
  check('B-4 ambient も同じ出どころを見る（自前で定義し直さない）',
    !/^const MAX_ROSTER = \d+;/m.test(amb) && /MAX_ROSTER,/.test(amb), '');

  // 住人の戦績台帳。名簿より小さいと「人間につけられた1敗」が古い順に消える。
  check('B-5 戦績台帳が名簿の規模に見合っている',
    RESIDENT_RECORD_MAX >= 600, `${RESIDENT_RECORD_MAX}行 / 名簿 ${MAX_ROSTER}人`);
}

// ===========================================================================
// C. ★ギルドの受け皿が名簿に追いついているか
// ===========================================================================
{
  // ⚠ 席が足りないと「ギルドに入っているか」が住人と使い捨てを見分ける
  //   統計になる。実測で 24.0% vs 32.5%（z=-4.95）まで開いていた。
  //   test/personaparity.test.mjs の A-5 がそれを見張っているが、
  //   ここでは**原因側（席数）**を直接押さえる。
  const rate = s => {
    setLiveScale(s);
    const g = ghostGuilds();
    const roster = getRoster().length;
    const inG = g.reduce((a, x) => a + x.members.length, 0);
    return { roster, guilds: g.length, seats: g.length * GUILD_MAX_MEMBERS, pct: inG / roster };
  };
  const small = rate(1), big = rate(2000);
  check('C-1 ★どの倍率でも加入率が変わらない（±10%以内）',
    Math.abs(small.pct - big.pct) < 0.10,
    `×1=${(small.pct * 100).toFixed(1)}% ×2000=${(big.pct * 100).toFixed(1)}%`);
  check('C-2 席が名簿を受け止められる',
    big.seats >= big.roster * 0.65,
    `席 ${big.seats} / 名簿 ${big.roster}`);
  // ゴーストだけ定員を超えると、順位表に「26/20」と出て一発の目印になる。
  setLiveScale(2000);
  const over = ghostGuilds().filter(g => g.members.length > GUILD_MAX_MEMBERS);
  check('C-3 ★ゴーストも定員を超えない（26/20 と出さない）',
    over.length === 0, over.map(g => `${g.tag}=${g.members.length}`).join(','));
}
{
  // 名前とタグは実ギルドと同じ土俵に並ぶので、重複させない。
  const defs = [...src('server/guilds.js').matchAll(/\{ name: '([^']+)',\s*tag: '([^']+)'/g)]
    .map(m => ({ name: m[1], tag: m[2] }));
  check('C-4 前提: ギルドの定義を読めた', defs.length >= 70, `${defs.length}件`);
  check('C-5 名前が重複していない', new Set(defs.map(d => d.name)).size === defs.length, '');
  check('C-6 タグが重複していない', new Set(defs.map(d => d.tag)).size === defs.length, '');
  check('C-7 タグの長さが実ギルドの決まり（5文字以内）に収まる',
    defs.every(d => d.tag.length <= 5), defs.filter(d => d.tag.length > 5).map(d => d.tag).join(','));
}

// ===========================================================================
// D. 引く速さ・倍率0・起動と復元の食い違い
// ===========================================================================
{
  // ⚠ residentById は線形 find だった。投票の集計は投票者ぶん呼ぶので
  //   O(投票者×名簿)。名簿の上限を上げるとそのまま効いてくる。
  setLiveScale(2000);
  const ids = getRoster().map(r => r.id);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) residentById(ids[i % ids.length]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('D-1 ★名簿が大きくても id で速く引ける（線形探索でない）',
    ms < 15, `2万回 ${ms.toFixed(1)}ms（名簿 ${ids.length}人）`);
  check('D-2 無い id は null', residentById('nope') === null, '');
}
{
  setLiveScale(0);
  check('D-3 倍率0では住人が誰も居ない', activeResidents(EVE).length === 0, '');
  check('D-4 倍率0でも落ちない（待ち時間は既定に戻る）',
    Number.isFinite(matchWaitMs(4000, 5000)), '');
}
{
  // ⚠ 起動時と復元で null の扱いが違った（0 と 1）。同じ db.json を読んで
  //   「にぎわいOFFで起動」「×1 で復元」に分かれる。
  const idx = src('server/index.js');
  check('D-5 ★起動時と復元で popScale の読み方がそろっている',
    /setLiveScale\(db\.meta\.popScale \?\? 1\);/.test(idx)
    && !/popScale === undefined \? 1 :/.test(idx), '');
}
{
  // 案内の数字は実装と合わせる（README は運営が見る唯一の説明）。
  const readme = src('README.md');
  check('D-6 README の倍率の説明が実装と合っている',
    readme.includes('×0〜×2000') && !readme.includes('×0〜×500'), '');
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
