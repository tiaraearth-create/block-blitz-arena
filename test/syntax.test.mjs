// リポジトリのルートから:  node test/syntax.test.mjs
//
// public/js の全ファイルを「本当にJSとして読めるか」だけ確かめる。
//
// なぜ要るか: このプロジェクトにはビルド工程が無く、public/js/*.js は書いた
// ままの姿でブラウザへ配られる。つまり modes.js（483KB）に閉じ括弧を1つ落とす
// と、その1文字でゲームは起動しなくなる ── しかも既存のテストは全部素通しする。
// サーバー側は各テストが index.js を起動するので実質パースされているが、
// クライアント側にはその守りが1本も無く、CI が緑のまま git push → 本番へ
// 自動デプロイ → 全プレイヤーが画面を開けない、という経路が開いていた。
//
// ここでやるのは構文検査だけで、実行はしない（DOM も window も無いので
// import すると別の理由で落ちる）。node --check 相当を子プロセスなしで行うため、
// vm.SourceTextModule ではなく「new Function で包む」でもなく、Node が持って
// いる構文解析をそのまま使う: ESM は import 文があるので Module として、
// それ以外（sw.js のような classic script）は Script として読む。
//
// 数百ミリ秒で終わる。いちばん安いのに、いちばん大きい事故を止められる。

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// 検査対象を集める。public/js 配下の .js 全部 ＋ Service Worker。
// 「一覧に書き忘れたファイルが検査されない」を避けるため、名前は列挙せず走査する。
function collect() {
  const files = [];
  const jsDir = path.join(ROOT, 'public', 'js');
  for (const name of fs.readdirSync(jsDir)) {
    if (name.endsWith('.js')) files.push(path.join(jsDir, name));
  }
  const sw = path.join(ROOT, 'public', 'sw.js');
  if (fs.existsSync(sw)) files.push(sw);
  return files.sort();
}

const files = collect();
check('検査対象を見つけられた', files.length >= 15, `${files.length} ファイル`);

// import / export を持つものは ESM。sw.js のような classic script と
// 解析ルールが違う（ESM は常に strict、トップレベル await が許される等）ので、
// ファイルごとに正しいほうで読む。
const isModule = src => /(^|\n)\s*(import\s|export\s|import\()/.test(src);

let modules = 0, scripts = 0, bytes = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  bytes += Buffer.byteLength(src);
  let ok = true, detail = '';
  try {
    if (isModule(src)) {
      modules++;
      // vm.SourceTextModule は --experimental-vm-modules が要る。素の Node でも
      // 動くように、構文解析だけは node --check に投げる（ESM は拡張子で判定
      // されるので --input-type=module を付ける）。
      execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: src, stdio: ['pipe', 'ignore', 'pipe'],
      });
    } else {
      scripts++;
      new vm.Script(src, { filename: rel });   // 実行はしない。構文解析だけ。
    }
  } catch (err) {
    ok = false;
    const msg = String((err && (err.stderr || err.message)) || err);
    // node --check の出力は長いので、原因の1行だけ拾う。
    const line = msg.split('\n').find(l => /SyntaxError|Error:/.test(l)) || msg.split('\n')[0];
    detail = line.trim().slice(0, 160);
  }
  check(`${rel} が構文として読める`, ok, detail || `${(Buffer.byteLength(src) / 1024).toFixed(0)}KB`);
}

// classic script の本数はリポジトリの都合で 0 になりうる（sw.js を module 化する等）。
// 「両方の経路が動く」ことは下の自己テストで直接確かめるので、ここは ESM だけ必須にする。
check('ESM を検査した', modules > 0, `ESM ${modules} / script ${scripts}`);
// 解析そのものが機能していることの自己テスト。検査が no-op になっていたら
// 全ファイル正常でも気づけないので、故意に壊したものが両経路で落ちるかを見る。
let esmCaught = false, scriptCaught = false;
try { execFileSync(process.execPath, ['--input-type=module', '--check'], { input: 'export const a = (;', stdio: ['pipe', 'ignore', 'pipe'] }); }
catch { esmCaught = true; }
try { new vm.Script('var a = (;', { filename: 'selftest.js' }); } catch { scriptCaught = true; }
check('壊れた ESM を検出できる', esmCaught, '');
check('壊れた classic script を検出できる', scriptCaught, '');

// import 先が実在するか。node --check は指定子を解決しないので、'./scrreens.js'
// のような打ち間違いは構文検査を素通りし、ブラウザでだけ404＝真っ白になる。
// index.html の script タグは1本だけで、残りは main.js からの芋づる読み込み。
let specs = 0, broken = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    specs++;
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) broken.push(path.relative(ROOT, file) + ' → ' + m[1]);
  }
}
check('相対 import の指定子を集められた', specs > 0, `${specs} 本`);
check('import 先のファイルがすべて実在する', broken.length === 0, broken.slice(0, 5).join(' / ') || `${specs} 本すべて実在`);
check('巨大ファイルも対象に入っている', bytes > 500 * 1024, `合計 ${(bytes / 1024).toFixed(0)}KB`);

// index.html が読み込む <script src> が実在するか。パスを打ち間違えると
// 404 で機能だけが静かに消える（構文エラーと違って何も言わずに壊れる）。
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1])
  .filter(s => !/^https?:/.test(s));
check('index.html に script タグがある', srcs.length > 0, `${srcs.length} 本`);
for (const s of srcs) {
  const clean = s.split('?')[0].replace(/^\//, '');
  const p = path.join(ROOT, 'public', clean);
  check(`index.html の ${s} が実在する`, fs.existsSync(p), '');
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
