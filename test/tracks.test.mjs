// リポジトリのルートから:  node test/tracks.test.mjs
//
// 🎵 BGM のトラック表を**機械で**検査する。
//
// 音楽は「鳴らしてみるまで分からない」ので、テストで守れるのは
// **鳴らないことが確実に分かる形**だけ。そこを全部潰しておく。
//
//   A. 契約どおりの形か（エンジンが読む欄しか書いていないか）
//   B. 周波数・ステップ番号が正気の範囲か
//   C. 噛み合わせ（melody には scale、riff と bassSteps の同居、など）
//   D. ジュークボックスの一覧（TRACK_INFO）と実装（TRACKS）が一致しているか
//   E. **使い回しをしていないか** ← 今回の本題
//
// ■ なぜ E が要るのか
// モードが増えるたびに「とりあえず battle でいいや」と借りていった結果、
// 12モードが4曲を回していた（ウィークリー・デイリー・連鎖・陣取り・チーム戦・
// トーナメントが全部 battle、ブループリントと工房が ruins、など）。
// 曲を足しただけでは元に戻るので、**借りた瞬間に赤くなる**ようにしておく。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKS, TRACK_INFO, N } from '../public/js/audio.js';
import { iconNames } from '../public/js/icons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// A. 契約どおりの形か
// ---------------------------------------------------------------------------
// エンジン（scheduleStep / pad / pluck / bassNote / drone）が実際に読む欄だけ。
// ここに無い欄を書いても **鳴らない** ので、それを当てにした曲は破綻する。
const TRACK_KEYS = new Set([
  'bpm', 'swing',
  'padType', 'padVol', 'padVibrato',
  'arpType', 'arpVol', 'arpDelay', 'arpOctave', 'arpSteps',
  'kick', 'snare', 'hat', 'hatVol', 'openHat',
  'bassSteps', 'bassLen', 'bassType', 'bassVol', 'bassFilter', 'detune',
  'riff', 'drone', 'stab', 'melody', 'bars',
]);
const BAR_KEYS = new Set(['chord', 'bass', 'scale']);
const WAVES = new Set(['sine', 'triangle', 'square', 'sawtooth']);

const ids = Object.keys(TRACKS);
check('A-0 トラックを読み込めた', ids.length >= 18, `${ids.length}曲`);

{
  const bad = [];
  for (const [id, t] of Object.entries(TRACKS)) {
    for (const k of Object.keys(t)) if (!TRACK_KEYS.has(k)) bad.push(`${id}.${k}`);
    for (const [i, b] of (t.bars || []).entries()) {
      for (const k of Object.keys(b)) if (!BAR_KEYS.has(k)) bad.push(`${id}.bars[${i}].${k}`);
    }
  }
  check('A-1 エンジンが読まない欄を書いていない', bad.length === 0, bad.slice(0, 5).join(', '));
}
{
  // kick / snare / hat は scheduleStep が無条件で `.includes` を呼ぶので、
  // 欠けていると **その曲を選んだ瞬間に例外**になる（音楽が止まる）。
  const miss = [];
  for (const [id, t] of Object.entries(TRACKS)) {
    for (const k of ['kick', 'snare', 'hat']) if (!Array.isArray(t[k])) miss.push(`${id}.${k}`);
    if (!Number.isFinite(t.bpm) || t.bpm < 50 || t.bpm > 220) miss.push(`${id}.bpm=${t.bpm}`);
    if (!Array.isArray(t.bars) || ![2, 4, 8].includes(t.bars.length)) miss.push(`${id}.bars=${t.bars && t.bars.length}`);
  }
  check('A-2 必須の欄がそろっている（kick/snare/hat・bpm・bars）', miss.length === 0, miss.slice(0, 5).join(', '));
}
{
  const bad = [];
  for (const [id, t] of Object.entries(TRACKS)) {
    for (const k of ['padType', 'arpType', 'bassType']) {
      if (t[k] !== undefined && !WAVES.has(t[k])) bad.push(`${id}.${k}=${t[k]}`);
    }
  }
  check('A-3 波形の名前が実在する', bad.length === 0, bad.join(', '));
}

// ---------------------------------------------------------------------------
// B. 周波数とステップ番号
// ---------------------------------------------------------------------------
// ⚠ いちばん多い事故は「N に無い音名を書いて undefined になる」。
//    undefined は OscillatorNode.frequency に入れると例外か無音になり、
//    しかも**その1音だけ**なので気づきにくい。
{
  const bad = [];
  const okFreq = (v, where) => {
    if (!Number.isFinite(v)) { bad.push(`${where}=${v}`); return; }
    if (v < 20 || v > 4200) bad.push(`${where}=${Math.round(v)}Hz`);
  };
  for (const [id, t] of Object.entries(TRACKS)) {
    if (t.drone !== undefined) okFreq(t.drone, `${id}.drone`);
    if (t.riff) for (const [s, f] of Object.entries(t.riff)) okFreq(f, `${id}.riff[${s}]`);
    for (const [i, b] of (t.bars || []).entries()) {
      okFreq(b.bass, `${id}.bars[${i}].bass`);
      for (const [j, f] of (b.chord || []).entries()) okFreq(f, `${id}.bars[${i}].chord[${j}]`);
      for (const [j, f] of (b.scale || []).entries()) okFreq(f, `${id}.bars[${i}].scale[${j}]`);
    }
  }
  check('B-1 周波数がすべて有限で可聴域にある', bad.length === 0, bad.slice(0, 5).join(', '));
}
{
  // ソース側でも見る。`N.Gs4` のように **表に無い名前**を書くと、値としては
  // undefined になるが、B-1 は「bars に入った値」しか見ないので、
  // 途中で握りつぶされている経路（`N.Gs4 || N.A4` など）を素通りしてしまう。
  const src = read('public/js/audio.js');
  const used = new Set([...src.matchAll(/\bN\.([A-Za-z]\w*)/g)].map(m => m[1]));
  const missing = [...used].filter(k => !(k in N));
  check('B-2 N に無い音名を参照していない', missing.length === 0, missing.join(', '));
}
{
  const bad = [];
  const okStep = (v, where) => { if (!Number.isInteger(v) || v < 0 || v > 15) bad.push(`${where}=${v}`); };
  for (const [id, t] of Object.entries(TRACKS)) {
    for (const k of ['kick', 'snare', 'hat', 'openHat', 'bassSteps', 'arpSteps', 'stab']) {
      for (const s of (t[k] || [])) okStep(s, `${id}.${k}`);
    }
    for (const s of Object.keys(t.riff || {})) okStep(Number(s), `${id}.riff`);
  }
  check('B-3 ステップ番号がすべて 0〜15 の整数', bad.length === 0, bad.slice(0, 5).join(', '));
}

// ---------------------------------------------------------------------------
// C. 噛み合わせ
// ---------------------------------------------------------------------------
{
  const bad = [];
  for (const [id, t] of Object.entries(TRACKS)) {
    // melody は bar.scale が無いと何も起きない（書いた本人は鳴っているつもりになる）
    if (t.melody > 0) {
      const noScale = (t.bars || []).filter(b => !Array.isArray(b.scale) || !b.scale.length).length;
      if (noScale) bad.push(`${id}: melody なのに scale の無い bar が ${noScale}個`);
    }
    // riff が勝つので bassSteps は死ぬ
    if (t.riff && t.bassSteps) bad.push(`${id}: riff と bassSteps の同居（bassSteps は鳴らない）`);
    // 鳴らす気なのに材料が無い
    if (t.arpVol > 0 && !(t.arpSteps || []).length) bad.push(`${id}: arpVol>0 なのに arpSteps が空`);
    if (t.padVol > 0 && (t.bars || []).some(b => !(b.chord || []).length)) bad.push(`${id}: padVol>0 なのに chord が空の bar`);
    if ((t.stab || []).length && (t.bars || []).some(b => !(b.chord || []).length)) bad.push(`${id}: stab があるのに chord が空の bar`);
    // bar に根音が無い（bassSteps を使うときだけ必要）
    if (t.bassSteps && (t.bars || []).some(b => !Number.isFinite(b.bass))) bad.push(`${id}: bassSteps なのに bass の無い bar`);
  }
  check('C-1 鳴らない組み合わせを書いていない', bad.length === 0, bad.slice(0, 5).join(' / '));
}
{
  // 音量の目安。全部足して大きすぎると、ライン消しの効果音がBGMに埋もれる。
  const loud = [];
  for (const [id, t] of Object.entries(TRACKS)) {
    const sum = (t.padVol || 0) + (t.arpVol || 0) + (t.bassVol || 0) + (t.hatVol || 0);
    if (sum > 0.95) loud.push(`${id}=${sum.toFixed(2)}`);
    if ((t.bassVol || 0) > 0.65) loud.push(`${id}.bassVol=${t.bassVol}`);
    if ((t.padVol || 0) > 0.2) loud.push(`${id}.padVol=${t.padVol}`);
  }
  check('C-2 音量が既存曲の帯からはみ出していない', loud.length === 0, loud.join(', '));
}

// ---------------------------------------------------------------------------
// D. ジュークボックスの一覧と実装
// ---------------------------------------------------------------------------
{
  const infoIds = TRACK_INFO.map(t => t.id);
  const dupes = infoIds.filter((v, i) => infoIds.indexOf(v) !== i);
  check('D-1 TRACK_INFO に重複が無い', dupes.length === 0, dupes.join(', '));
  const orphanInfo = infoIds.filter(id => !TRACKS[id]);
  check('D-2 一覧に載っているのに実装が無い曲は無い', orphanInfo.length === 0, orphanInfo.join(', '));
  const orphanTrack = ids.filter(id => !infoIds.includes(id));
  check('D-3 実装があるのに一覧に載っていない曲は無い（ジュークボックスから聴けない）',
    orphanTrack.length === 0, orphanTrack.join(', '));
  const names = new Set(iconNames());
  const badIcon = TRACK_INFO.filter(t => !names.has(t.iconName)).map(t => `${t.id}:${t.iconName}`);
  check('D-4 アイコン名が icons.js に実在する', badIcon.length === 0, badIcon.join(', '));
  const noWhere = TRACK_INFO.filter(t => !t.where || !t.whereEn || !t.name || !t.nameEn).map(t => t.id);
  check('D-5 曲名と「どこで流れるか」が日英そろっている', noWhere.length === 0, noWhere.join(', '));
  const badBpm = TRACK_INFO.filter(t => t.bpm !== TRACKS[t.id].bpm).map(t => t.id);
  check('D-6 一覧の BPM が実装と一致（写経していない）', badBpm.length === 0, badBpm.join(', '));
}

// ---------------------------------------------------------------------------
// E. 使い回しをしていないか  ← 本題
// ---------------------------------------------------------------------------
// modes.js の `audio.playTrack('◯◯')`（リテラル指定だけ）を、囲っている
// class ごとに拾う。式で決めているもの（stage.track / band.track など）は
// 下の E-3 で別に見る。
const modes = read('public/js/modes.js');
const literalUses = (() => {
  const out = [];
  let cls = '(top)';
  modes.split('\n').forEach((l, i) => {
    const c = l.match(/^(?:export )?class (\w+)/);
    if (c) cls = c[1];
    const p = l.match(/audio\.playTrack\('(\w+)'\)/);
    if (p) out.push({ cls, id: p[1], line: i + 1 });
  });
  return out;
})();
check('E-0 前提: playTrack のリテラル指定を拾えた', literalUses.length >= 15, `${literalUses.length}件`);

{
  // 借りてよい例外。**理由を書けないものは足さないこと。**
  const SHARED_OK = {
    // メニューへ戻るときの1本。モードのテーマではない。
    menu: 'メニューへ戻る合図（モードの曲ではない）',
  };
  const byTrack = new Map();
  for (const u of literalUses) {
    if (!byTrack.has(u.id)) byTrack.set(u.id, new Set());
    byTrack.get(u.id).add(u.cls);
  }
  const shared = [...byTrack.entries()]
    .filter(([id, set]) => set.size > 1 && !SHARED_OK[id])
    .map(([id, set]) => `${id} ← ${[...set].join(' / ')}`);
  check('E-1 1つの曲を2つ以上のモードが使い回していない', shared.length === 0, shared.join(' | '));
}
{
  // 専用曲を持っているべきモードの一覧。ここに足したら曲も足すこと。
  const NEED_OWN = [
    ['SoloMode', 'solo'], ['MeltdownMode', 'meltdown'], ['ChimeraMode', 'chimera'],
    ['PuzzleMode', 'ruins'], ['DigMode', 'mine'], ['GhostMode', 'ghost'],
    ['BossRushMode', 'rush'], ['WeeklyMode', 'weekly'], ['DailyMode', 'daily'],
    ['ChaosMode', 'chaos'], ['SurvivalMode', 'survival'], ['SprintMode', 'sprint'],
    ['ChainMode', 'chain'], ['BlueprintMode', 'blueprint'], ['WorkshopMode', 'workshop'],
    ['ZeroMode', 'zero'],
  ];
  const wrong = NEED_OWN.filter(([cls, id]) => !literalUses.some(u => u.cls === cls && u.id === id))
    .map(([cls, id]) => `${cls}→${id}`);
  check('E-2 主要モードが自分の曲を鳴らしている', wrong.length === 0, wrong.join(', '));
  const missing = NEED_OWN.filter(([, id]) => !TRACKS[id]).map(([, id]) => id);
  check('E-2b その曲が実装されている', missing.length === 0, missing.join(', '));
}
{
  // 表で持っている割り当て（AIの相手・ボス・ダンジョンのフロア）は、
  // 「全部 battle」になっていないことだけ見る。
  const tableTracks = tag => {
    const at = modes.indexOf(tag);
    if (at < 0) return [];
    const body = modes.slice(at, at + 6000);
    return [...body.matchAll(/track: '(\w+)'/g)].map(m => m[1]);
  };
  const ai = tableTracks('const AI_STAGES');
  const bands = [...modes.matchAll(/track: '(\w+)'/g)].map(m => m[1]);
  const distinct = new Set(bands);
  check('E-3 前提: 表の割り当てを拾えた', bands.length >= 20, `${bands.length}件`);
  check('E-4 表の割り当てが1〜2曲に偏っていない', distinct.size >= 8,
    `${distinct.size}種類: ${[...distinct].sort().join(',')}`);
  const unknown = [...distinct].filter(id => !TRACKS[id]);
  check('E-5 表が実在しない曲を指していない', unknown.length === 0, unknown.join(', '));
  if (ai.length) check('E-6 AI の相手ごとに曲が割り当たっている', new Set(ai).size >= 4, ai.join(','));
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
