// リポジトリのルートから:  node test/displaytruth.test.mjs
//
// 🪞 「見せた数字と、実際に起きたこと」がズレる不具合の回帰テスト。
//
// 遊べてはいるので気づきにくいが、プレイヤーから見ると
// **画面が嘘をついている**という、いちばん信用を削る壊れ方をする一群。
//
//   A. カオスが「コイン1.5倍！」と宣伝し続けていた（サーバーは v2.54 で倍率を廃止済み）
//   B. 練習試合（repeat）は「レートは動きません」と書きながら Elo が動いていた
//   C. デイリーの録画再生だけ「その日の種」を渡し忘れ、瓦礫の日は別の盤面で再生していた
//   D. ⭐フィーバーが、より強い倍率の最中は消費だけされて何も起きなかった
//   E. 奥義ゲージが 99.6% でも「MAX」と出て、押すと「足りません（100%）」と言われた
//   F. バトルパス満了後も「パスXP +N」と出続け、実際は1も入らなかった
//   G. 王座の欠片が日次上限に当たると、欄ごと消えて理由も出なかった
//   H. デイリーの結果画面にジェムの行が無く、7日連続の +300💎 が見えなかった
//   I. 協力プレイで、未登録プレイヤーは点が下がっても必ず「新記録！」と出た
//   J. ロイヤルで盤面を詰ませた最後の1手の得点がサーバーに届いていなかった
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
// 自分の書いた説明文を根拠にしない。
const stripComments = src => src.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const modesRaw = read('public/js/modes.js');
const modes = stripComments(modesRaw);
const mainJs = stripComments(read('public/js/main.js'));
const battle = stripComments(read('server/battle.js'));
const index = stripComments(read('server/index.js'));

// ===========================================================================
// A. カオスの「コイン1.5倍！」
// ===========================================================================
// サーバー側に倍率が無いことを先に確かめる（これが前提）。
check('A-0 サーバーにカオスのコイン倍率が無い',
  !/mode === 'chaos'[^\n]*coins/.test(index) && !/coins \*= 1\.5/.test(index), '');
// 画面のどこにも 1.5倍 の約束が残っていない。
const claims = [];
for (const [f, src] of [['public/js/modes.js', modes], ['public/js/main.js', mainJs]]) {
  for (const m of src.matchAll(/[^\n]*(?:コイン1\.5倍|1\.5x coins)[^\n]*/g)) claims.push(`${f}: ${m[0].trim().slice(0, 60)}`);
}
check('A-1 画面に「コイン1.5倍」の約束が残っていない', claims.length === 0, claims.join(' / '));
// 代わりに、サーバーが実際に上乗せした額から出す行がある。
check('A-2 イベント分は rewards.eventCoins（実際に上乗せされた額）から出す',
  /rewards\.eventCoins \?/.test(modes), '');
check('A-3 サーバーは eventCoins を「上乗せぶん」として返している',
  /eventCoins = boosted - coins;/.test(index) && /eventCoins, eventGems,/.test(index), '');

// ===========================================================================
// B. 練習試合でレートが動く
// ===========================================================================
check('B-1 Elo の更新が friendly を見ている',
  /if \(oppRating != null && !friendly\) \{/.test(battle), '');
// friendly の宣言より後で使っていること（順番が逆だと ReferenceError）。
const declAt = battle.indexOf('const friendly =');
const useAt = battle.indexOf('oppRating != null && !friendly');
check('B-2 friendly の宣言のあとで見ている', declAt > 0 && useAt > declAt, `decl=${declAt} use=${useAt}`);
// 勝ち星と報酬の側は今までどおり friendly を見る（片側だけ直していない）。
check('B-3 勝敗記録も今までどおり friendly を見る',
  /if \(match\.rated && match\.mode !== 'raid' && !friendly\)/.test(battle), '');
check('B-4 報酬側も今までどおり unrated を渡す', /unrated: !!friendly,/.test(battle), '');

// ===========================================================================
// C. デイリーの録画再生の種
// ===========================================================================
check('C-1 再生も「その日の種」を渡す',
  /applyDailyModifier\(this\.engine, this\.meta\.modifier, this\.replay\.seed\)/.test(modes), '');
check('C-2 種に既定値を置いていない（渡し忘れが静かに通らない）',
  /function applyDailyModifier\(engine, mod, seed\) \{/.test(modes), '');
// 3か所すべてが種を渡している。
const modCalls = [...modes.matchAll(/applyDailyModifier\(([^)]*)\)/g)]
  .map(m => m[1]).filter(a => !a.startsWith('engine, mod'));
check('C-3 applyDailyModifier の呼び出しが全部3引数',
  modCalls.length >= 3 && modCalls.every(a => a.split(',').length === 3),
  modCalls.map(a => a.split(',').length).join(','));

// ===========================================================================
// D/E. フィーバーと奥義ゲージ
// ===========================================================================
check('D-1 効き目が入らないフィーバーは消費させず先に返す',
  /if \(2 < cur\) \{[\s\S]{0,220}?return;\s*\}/.test(modes), '');
check('D-2 15秒後の消灯は「いまの状態」を見る',
  /const cu = currentMode && currentMode\.engine;\s*\n\s*if \(cu && cu\.feverUntil > Date\.now\(\)\) return;/.test(modes), '');
check('E-1 奥義ゲージの表示が生の値で ready を決める',
  /const ready = e\.ult >= 100;/.test(modes), '');
check('E-2 数字は切り捨て（未満を100と書かない）',
  /const pct = Math\.max\(0, Math\.min\(100, ready \? 100 : Math\.floor\(e\.ult\)\)\);/.test(modes), '');
check('E-3 MAX・光り方・押せるかが全部同じ ready を見る',
  /textContent = ready \? 'MAX'/.test(modes)
  && /toggle\('ult-ready', ready\)/.test(modes)
  && /toggle\('off', !ready\)/.test(modes), '');
// 発動側の判定は変えていない（表示だけを合わせた）。
check('E-4 発動側の判定は生の値のまま', /if \(e\.ult < 100\) \{/.test(modes), '');

// 実際に境界を通してみる（表示と発動が同じ答えを出すか）。
{
  const shown = v => {
    const ready = v >= 100;
    return { ready, label: ready ? 'MAX' : Math.max(0, Math.min(100, Math.floor(v))) };
  };
  const bad = [];
  // engine.chargeUlt は1手 1.2 ずつなので .2/.4/.6/.8 の端数が必ず出る。
  for (let i = 0; i <= 1000; i++) {
    const v = i * 0.2;
    const s = shown(v);
    const canFire = v >= 100;
    if (s.ready !== canFire) bad.push(v);
    if (!canFire && s.label === 100) bad.push(v);
  }
  check('E-5 0〜200% を 0.2 刻みで通しても、見た目と発動が食い違わない',
    bad.length === 0, bad.slice(0, 5).join(','));
}

// ===========================================================================
// F/G. バトルパス満了と王座の欠片の上限
// ===========================================================================
check('F-1 実際に入ったパスXPだけを返す',
  /bpXp = user\.battlePass\.xp - bpBefore;/.test(index), '');
check('F-2 満了は理由として返す', /bpFull \? \{ capped: 'bp_full' \}/.test(index), '');
check('F-3 画面に満了の行がある', /kind === 'bp_full'/.test(modes), '');
check('G-1 欠片の上限に当たった回は理由を返す',
  /eyeCapped \? \{ capped: 'eyeshard_day' \}/.test(index), '');
check('G-2 画面に欠片の上限の行がある', /kind === 'eyeshard_day'/.test(modes), '');
check('G-3 上限に当たった日も「潰した数」は数える',
  /\}\s*\n\s*s\.eyesCaught = \(s\.eyesCaught \|\| 0\) \+ eyes;/.test(index), '');

// ===========================================================================
// H. デイリーの結果画面
// ===========================================================================
{
  const daily = modes.match(/mode: 'daily', score: e\.score[\s\S]*?rAgain'\)\.onclick/);
  check('H-0 デイリーの結果画面を取り出せる', !!daily, '');
  if (daily) {
    check('H-1 ジェムの行がある', /rewards\.gems \?/.test(daily[0]), '');
    check('H-2 王座の欠片の行がある', /rewards\.shards \?/.test(daily[0]), '');
    check('H-3 上限の理由の行がある', /cappedRow\(rewards\.capped\)/.test(daily[0]), '');
    check('H-4 7日連続のバッジを祝う', /rewards\.badge === 'daily7'/.test(daily[0]), '');
    check('H-5 デイリーボーナスは「うち」と書く（上乗せに読ませない）',
      /デイリーボーナス[\s\S]{0,120}?うち/.test(daily[0]), '');
  }
}
check('H-6 連勝ボーナスも「うち」と書く',
  /連勝ボーナス[\s\S]{0,200}?うち \+\$\{fmt\(rewards\.streakBonus\)\}/.test(modes), '');

// ===========================================================================
// I. 協力プレイの「新記録！」
// ===========================================================================
check('I-1 端末の控えも見て、書き込む前に判定する',
  /const prevCoopBest = Math\.max\(c\.best \|\| 0, localBest\);[\s\S]{0,120}?const isBest = c\.score > 0 && c\.score > prevCoopBest;/.test(modes), '');
{
  // ⚠ indexOf は見つからないと -1 を返す。両方が「見つかっている」ことまで見ないと、
  //    直っていない版でも -1 < N で緑になる。
  const judgeAt = modes.indexOf('const isBest = c.score > 0 && c.score > prevCoopBest;');
  const writeAt = modes.indexOf("localStorage.setItem('bba_coop_best'");
  check('I-2 判定より後に localStorage を書く',
    judgeAt > 0 && writeAt > 0 && judgeAt < writeAt, `judge=${judgeAt} write=${writeAt}`);
}
{
  // ゲスト（サーバーの best が常に 0）で、前より低い点でも「新記録」にならない。
  const judge = (serverBest, localBest, score) => {
    const prev = Math.max(serverBest || 0, localBest);
    return score > 0 && score > prev;
  };
  check('I-3 ゲストが前回より低い点でも新記録にならない',
    judge(0, 12000, 8000) === false, '');
  check('I-4 同点も新記録にしない（サーバーの更新条件と同じ）',
    judge(0, 12000, 12000) === false, '');
  check('I-5 本当に更新したときは新記録になる',
    judge(0, 12000, 12001) === true, '');
}

// ===========================================================================
// J. ロイヤルの最後の1手
// ===========================================================================
check('J-1 詰ませた1手ぶんを royale_topout に載せる',
  /type: 'royale_topout',\s*\n\s*score: this\.engine\.score,/.test(modes), '');
check('J-2 サーバーが取り込みを関数にまとめている',
  /function royaleMergeState\(r, e, msg\) \{/.test(battle), '');
// 呼び出しだけを数える（末尾の `;` で定義行と分ける）。
const mergeCalls = (battle.match(/royaleMergeState\(r, e, msg\);/g) || []).length;
check('J-3 state と topout の両方から通している', mergeCalls === 2, String(mergeCalls));
check('J-4 罰（-10%）と順位確定より前に取り込む',
  /royaleMergeState\(r, e, msg\);[\s\S]{0,260}?royaleTopOut\(r, e, blame\);/.test(battle), '');
check('J-5 上限は state と同じものを通す（申告し放題にしていない）',
  /const cap = Math\.floor\(secs \* 500\);/.test(battle)
  && /const ceil = \(e\.reviveAt && Date\.now\(\) - e\.reviveAt < 2500\) \? e\.score : cap;/.test(battle), '');

// ===========================================================================
// K. しおりの復元に失敗したときの後始末（自分で見つけたぶん）
// ===========================================================================
check('K-1 復元に失敗したらメニューまで戻す',
  /const bail = \(\) => \{ endToMenu\(\); return false; \};/.test(modes)
  && /if \(!m \|\| !m\.engine\) return bail\(\);/.test(modes)
  && /if \(!m\.engine\.restoreState\(bm\.engine\)\) return bail\(\);/.test(modes), '');

for (const [mark, name, detail] of results) console.log(mark, name, detail ? `— ${detail}` : '');
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
