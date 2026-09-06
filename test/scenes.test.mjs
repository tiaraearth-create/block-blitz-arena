// リポジトリのルートから:  node test/scenes.test.mjs
//
// 🌳 盤面の「動く風景」と、🏮 運営専用の新しい装備。
//
// ■ 風景（scene）で守ること
//  1. **盤面が読めなくなる濃さにしない。** 盤面に重ねる合図（消える線の白帯
//     α0.25〜0.40 / 置けないマスの赤 / 空きマスの白）は α が game.js に
//     ベタ書きで盤面ごとに変えられない。風景が濃いと、その合図が地に沈む。
//     ⚠ 「globalAlpha は 0.30 まで」という約束だけでは足りなかった ──
//       図形どうしが重なった画素では α が二重に乗る（実測で 街0.48 / 鳥居0.41 /
//       波0.32）。だから drawScene は**別の紙に描いてから1回だけ薄くして重ねる**。
//       この仕組みが外れていないかを、ここで見る。
//  2. **乱数を使わない。** Math.random を呼ぶと毎フレーム形が変わってちらつく。
//  3. **渡された時計だけを見る。** Date.now / performance.now を使うと、
//     設定「視差効果を減らす」で風景が止まらなくなる。
//
// ■ 濃さそのものは Node では測れない（canvas が無い）。
//   実機で測った結果は 0.11〜0.278（上限 0.28）。ここで見るのは**仕組みが
//   生きているか**で、実際の濃さは画面で確かめること。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, drawScene, SCENE_ALPHA, BOARDS, SKINS } from '../public/js/themes.js';
import { ParticleSystem } from '../public/js/particles.js';
import { SHOP_ITEMS, BOOST_ITEMS } from '../server/catalog.js';
import { CATALOG_EN } from '../public/js/catalog-en.js';
import * as icons from '../public/js/icons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const themes = read('public/js/themes.js');
const themesNo = strip(themes);
// 風景の実装だけを切り出す（drawScene 本体や他のコメントを巻き込まないため）
const sceneSrc = (() => {
  const a = themesNo.indexOf('SCENES.');
  const b = themesNo.indexOf('export const SCENE_ALPHA');
  return a >= 0 && b > a ? themesNo.slice(a, b) : '';
})();

// ===========================================================================
// A. 風景の仕組み
// ===========================================================================
const sceneIds = Object.keys(SCENES);
check('A-0 風景がある', sceneIds.length >= 4, `${sceneIds.length}種: ${sceneIds.join(',')}`);
check('A-1 前提: 風景の実装を切り出せた', sceneSrc.length > 500, `${sceneSrc.length}文字`);
check('A-2 すべて関数', sceneIds.every(id => typeof SCENES[id] === 'function'), '');

// ⚠ ここが濃さの唯一の歯止め。
check('A-3 濃さの上限がある', Number.isFinite(SCENE_ALPHA) && SCENE_ALPHA > 0 && SCENE_ALPHA <= 0.30,
  String(SCENE_ALPHA));
check('A-4 別の紙に描いてから1回だけ重ねている（重なりで濃くならない）',
  /_sceneBuf/.test(themesNo) && /ctx\.globalAlpha = SCENE_ALPHA;\s*\n\s*ctx\.drawImage\(_sceneBuf, 0, 0\);/.test(themesNo), '');
check('A-5 紙は大きさが変わったときだけ作り直す（毎コマ作らない）',
  /if \(_sceneBuf\.width !== W \|\| _sceneBuf\.height !== H\)/.test(themesNo), '');
check('A-6 風景が落ちても盤面は描く', /catch \{[\s\S]{0,200}?_sceneBuf = null;/.test(themesNo), '');

{
  // 乱数と実時計。ちらつきと「視差効果を減らす」が効かなくなる原因。
  // ⚠ コメントを外してから見る。「Math.random は使わない」と**書いてある**注意書きに
  //   引っかかって、正しい実装を不正解にしてしまった（このテスト自身の初回で発生）。
  const body = id => strip(String(SCENES[id]));
  const rnd = sceneIds.filter(id => /Math\.random/.test(body(id)));
  check('A-7 風景が乱数を使っていない（毎コマ形が変わらない）', rnd.length === 0, rnd.join(','));
  const clock = sceneIds.filter(id => /Date\.now|performance\.now/.test(body(id)));
  check('A-8 風景が実時計を見ていない（視差効果を減らす で止まる）', clock.length === 0, clock.join(','));
}
{
  // 毎フレーム走るので、ループの中でグラデーションを作らない。
  const bad = sceneIds.filter(id => {
    const s = strip(String(SCENES[id]));
    const at = s.search(/for\s*\(/);
    return at >= 0 && /createLinearGradient|createRadialGradient|createPattern/.test(s.slice(at));
  });
  check('A-9 ループの中でグラデーションを作っていない', bad.length === 0, bad.join(','));
}
{
  // 描いても落ちないこと。ctx を模した受け皿に通すだけでも、
  // 「無い関数を呼んでいる」「w/h が 0 で無限ループ」は捕まえられる。
  const calls = [];
  const stub = new Proxy({}, {
    get: (o, k) => {
      if (k === 'canvas') return { width: 400, height: 800 };
      if (k === 'globalAlpha' || k === 'lineWidth') return 1;
      if (typeof k === 'symbol') return undefined;
      return (...a) => { calls.push(k); return { addColorStop() {} }; };
    },
    set: () => true,
  });
  const broke = [];
  for (const id of sceneIds) {
    for (const [w, h] of [[390, 740], [812, 375], [320, 480], [1366, 768]]) {
      try { SCENES[id](stub, w, h, 3.7, { accent: '#5ee86e', scene: id }); } catch (e) { broke.push(`${id}@${w}x${h}: ${e.message}`); }
    }
  }
  check('A-10 どの画面サイズでも落ちない', broke.length === 0, broke.slice(0, 2).join(' / '));
  check('A-11 実際に描いている', calls.length > 50, `${calls.length}命令`);
}
{
  // 盤面が指す風景が実在するか（打ち間違えると黙って何も出ない）。
  const bad = Object.entries(BOARDS).filter(([, b]) => b.scene && !SCENES[b.scene])
    .map(([k, b]) => `${k}→${b.scene}`);
  check('A-12 盤面が実在しない風景を指していない', bad.length === 0, bad.join(','));
  const withScene = Object.entries(BOARDS).filter(([, b]) => b.scene);
  check('A-13 風景の付いた盤面がある', withScene.length >= 10, `${withScene.length}枚`);
  const used = new Set(withScene.map(([, b]) => b.scene));
  const unused = sceneIds.filter(id => !used.has(id));
  check('A-14 どの風景にも持ち場がある', unused.length === 0, unused.join(','));
}
{
  // 棚の絵と実物を合わせる（過去に2回、同じ形の食い違いを直している）。
  const screens = strip(read('public/js/screens.js'));
  check('A-15 棚のプレビューも同じ関数で風景を描く',
    /drawScene\(ctx, size, size, [\d.]+, b\);/.test(screens), '');
}

// ===========================================================================
// B. 運営専用の新しい装備
// ===========================================================================
const admin = SHOP_ITEMS.filter(i => i.adminOnly);
const adminBoost = BOOST_ITEMS.filter(i => i.adminOnly);
check('B-0 運営専用の装備がある', admin.length >= 15, `装備${admin.length} / ブースター${adminBoost.length}`);
check('B-1 名前が【管理者】で終わっている',
  [...admin, ...adminBoost].every(i => /【管理者】$/.test(i.name)),
  [...admin, ...adminBoost].filter(i => !/【管理者】$/.test(i.name)).map(i => i.id).join(','));
check('B-2 どれも 0円（買えない）', [...admin, ...adminBoost].every(i => !i.price),
  [...admin, ...adminBoost].filter(i => i.price).map(i => i.id).join(','));
{
  const miss = [...admin, ...adminBoost].filter(i => !CATALOG_EN[i.id]).map(i => i.id);
  check('B-3 英語名がある', miss.length === 0, miss.join(','));
}
{
  const noSkin = admin.filter(i => i.cat === 'skin' && !SKINS[i.id]).map(i => i.id);
  check('B-4 ブロックが themes.js に実在する', noSkin.length === 0, noSkin.join(','));
  const noBoard = admin.filter(i => i.cat === 'board' && !BOARDS[i.id]).map(i => i.id);
  check('B-5 ボードが themes.js に実在する', noBoard.length === 0, noBoard.join(','));
  const ps = new ParticleSystem();
  const noFx = admin.filter(i => i.cat === 'fx').filter(i => {
    ps.particles.length = 0;
    ps.burstCell(10, 10, 20, 6, i.id);
    return ps.particles.length === 0;
  }).map(i => i.id);
  check('B-6 エフェクトが実際に粒を出す', noFx.length === 0, noFx.join(','));
}
{
  // 奥義とブースターは「効果の本体」と「表の登録」が別ファイルなので、両方見る。
  const skills = strip(read('public/js/skills.js'));
  const modes = strip(read('public/js/modes.js'));
  const noEffect = admin.filter(i => i.cat === 'ult')
    .filter(i => !new RegExp(`\\n  ${i.id}\\(ctx\\)`).test(skills)).map(i => i.id);
  check('B-7 奥義に効果の本体がある', noEffect.length === 0, noEffect.join(','));
  const noColor = admin.filter(i => i.cat === 'ult')
    .filter(i => !new RegExp(`${i.id}:\\s*\\{ color`).test(skills)).map(i => i.id);
  check('B-8 奥義に色がある（ULT_META）', noColor.length === 0, noColor.join(','));
  const noDef = adminBoost.filter(i => !new RegExp(`${i.id}:\\s*\\{ name`).test(modes)).map(i => i.id);
  check('B-9 ブースターが ITEM_DEFS にある', noDef.length === 0, noDef.join(','));
  const noUse = adminBoost.filter(i => !new RegExp(`id === '${i.id}'`).test(modes)).map(i => i.id);
  check('B-10 ブースターに効果の本体がある（useGameItem）', noUse.length === 0, noUse.join(','));
}
{
  // 「1品ずつ絵が違う」棚（エフェクト・奥義）とブースターは固有アイコンが要る。
  const need = [...admin.filter(i => i.cat === 'fx' || i.cat === 'ult'), ...adminBoost];
  const miss = need.filter(i => !icons.hasIcon(i.id)).map(i => i.id);
  check('B-11 エフェクト・奥義・ブースターに固有アイコンがある', miss.length === 0, miss.join(','));
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
