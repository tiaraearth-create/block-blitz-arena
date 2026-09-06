// リポジトリのルートから:  node test/polish.test.mjs
//
// 🧹 第3回横断監査の「中（25件）」と「小（27件）」ぶんの回帰。
//
// どれも落ちはしないが、**画面が嘘をつく／設定が効かない／指が届かない**という
// 形の不具合で、直したことがコードの見た目からは分かりにくい（数字を1つ変えた
// だけ、順番を入れ替えただけ、というものが多い）。だからここに固定する。
//
//   A. 盤面と描画      B. エフェクト・奥義     C. 音とBGM
//   D. 書き出し（クリップ / YouTube）           E. レイアウトと安全領域
//   F. オフライン（Service Worker）             G. 画面の作法
//   H. サーバー側
//
// ⚠ ここは実装の**本文**を見る静的テストなので、直すときは一緒に付け替える
//   こと。見ている性質（左の見出し）を変えないままなら、正規表現は自由に
//   書き換えてよい。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
// 自分で書いた説明文が根拠にならないように、コメントは落としてから見る。
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const game = strip(read('public/js/game.js'));
const modes = strip(read('public/js/modes.js'));
const screens = strip(read('public/js/screens.js'));
const mainJs = strip(read('public/js/main.js'));
const skills = strip(read('public/js/skills.js'));
const particles = strip(read('public/js/particles.js'));
const themes = strip(read('public/js/themes.js'));
const audioJs = read('public/js/audio.js');
const net = strip(read('public/js/net.js'));
const clip = strip(read('public/js/clipexport.js'));
const yt = strip(read('public/js/ytexport.js'));
const sw = strip(read('public/sw.js'));
const css = read('public/css/style.css');
const cssNo = strip(css);
const polls = strip(read('server/polls.js'));
const zeroSess = strip(read('server/zero-session.js'));
const adminEvent = strip(read('server/routes/adminevent.js'));
const catalog = read('server/catalog.js');
const catalogEn = read('public/js/catalog-en.js');

// ===========================================================================
// A. 盤面と描画
// ===========================================================================
// A-1 観測マス（👁）の roundRect が素通しだと、非対応ブラウザで
//     **その行から下（危険表示・手札・粒子）がフレームごと飛ぶ**。
{
  const at = game.indexOf('function drawEyeBlock');
  const fn = at >= 0 ? game.slice(at, at + 1200) : '';
  check('A-1 前提: drawEyeBlock を切り出せた', fn.includes('roundRect'), `${fn.length}文字`);
  check('A-2 観測マスの roundRect に分岐がある', /if \(ctx\.roundRect\)/.test(fn), '');
}
// A-3 素の roundRect（分岐なし）が game.js に残っていない。
{
  const bare = game.split('\n').filter(l => /ctx\.roundRect\(/.test(l)
    && !/if \(ctx\.roundRect\)/.test(l) && !/ctx\.roundRect \?/.test(l));
  check('A-3 分岐の無い ctx.roundRect が残っていない', bare.length === 0, bare.slice(0, 2).join(' | '));
}
// A-4 コマを掴んだら canvas にフォーカスを移す（キー操作が届かなくなる）。
check('A-4 掴んだら盤面にフォーカスを移す',
  /this\.canvas\.focus\(\{ preventScroll: true \}\)/.test(game), '');
// A-5 断罪の残り時間表示が textBaseline を戻す（浮き文字が全部ずれる）。
{
  const at = game.indexOf('drawDanger() {');
  const fn = at >= 0 ? game.slice(at, at + 2000) : '';
  check('A-5 前提: drawDanger を切り出せた', fn.includes('dangerUntil'), `${fn.length}文字`);
  check('A-6 残り時間の描画を save/restore で包んでいる',
    /if \(this\.dangerUntil && this\.dangerTotal\) \{\s*\n\s*ctx\.save\(\);/.test(fn)
    && /ctx\.restore\(\);\s*\n\s*\}\s*\n\s*ctx\.globalAlpha = 1;/.test(fn), '');
}
// A-7 運営ルーレットの目隠しが次のスピンで戻る。
{
  const at = modes.indexOf('clearWheelEffects() {');
  const fn = at >= 0 ? modes.slice(at, at + 900) : '';
  check('A-7 前提: clearWheelEffects を切り出せた', fn.includes('ghostFx'), `${fn.length}文字`);
  check('A-8 目隠し（assistOverride）も戻している',
    /view\.assistOverride = null;/.test(fn), '');
}
// A-9 幽霊屋敷のしおり復元が「もう隠れ終わった」値を入れる。
check('A-9 霧の復元で盤面が丸見えにならない',
  (modes.match(/hideAt\.set\(k, v0?\.time - 0\.01\)/g) || []).length === 2
  && !/hideAt\.set\(k, v0?\.time \+ 1\.2\)/.test(modes), '');

// ===========================================================================
// B. エフェクト・奥義
// ===========================================================================
check('B-1 断罪の一撃がコンボを二重に進めない',
  !/const res = clearLines\(engine, row \? \[row\.i\] : \[\], col \? \[col\.i\] : \[\]\);\s*\n\s*engine\.streak \+= 1;/.test(skills), '');
check('B-2 不落の城塞が残っている守りを切り詰めない',
  /engine\.fortressUntil = Math\.max\(engine\.fortressUntil \|\| 0, Date\.now\(\) \+ 30000\);/.test(skills), '');
check('B-3 浄化の波動が「お邪魔0個」と言わない',
  /garbage\.length\s*\n?\s*\? t\(`浄化の波動！お邪魔/.test(skills)
  && /洗い流した/.test(skills), '');
check('B-4 粒子の尾（trail）を実際に描いている',
  /if \(p\.trail\) \{/.test(particles) && /ctx\.lineTo\(p\.x - p\.vx/.test(particles), '');
check('B-5 色覚サポートの記号が明るい面で黒くなる',
  /const MARK_INK = \[/.test(themes)
  && /MARK_INK\[ci\] === '#000' \? 'rgba\(0,0,0,0\.92\)'/.test(themes), '');
check('B-6 奥義の倍率が実数で出る（×2 固定でない）',
  /content: attr\(data-ultrate\)/.test(css) && !/content: '×2'/.test(css)
  && /btn\.dataset\.ultrate = /.test(modes), '');
check('B-7 奥義祭の強調が無効な filter 値になっていない',
  !/filter: none [a-z-]+\(/.test(cssNo), (cssNo.match(/filter: none [a-z-]+\([^;]*/) || [''])[0]);
check('B-8 エフェクトのプレビューが設定の粒の量を見る',
  /ps\.intensity = particleFactor\(\);/.test(screens), '');
check('B-9 プレビューが「視差効果を減らす」を見る',
  /if \(prefersReducedMotion\(\)\) \{/.test(screens), '');
check('B-10 プレビューの粒が枠の大きさで撃たれる（枠外へ飛ばない）',
  /ps\.burstCell\(84, 100, 21, 6, item\.id\)/.test(screens)
  && !/ps\.burstCell\(84, 84, 84,/.test(screens), '');
check('B-11 棚のプレビューがオーロラの帯を描く',
  /if \(b\.aurora\) \{/.test(screens) && /\[160, 200, 285\]/.test(screens), '');
check('B-12 オーロラの粒だけ色を変えていない',
  !/b\.aurora \? '#7cf5c8'/.test(screens), '');
check('B-13 👁断罪のアイコンが実在の名前を指している',
  !/'mode_zero'/.test(modes) && !/'mode_zero'/.test(screens), '');
{
  const icons = read('public/js/icons.js');
  check('B-14 前提: 差し替え先（eye_zero）が実在する', /\n  eye_zero: \{/.test(icons), '');
}

// ===========================================================================
// C. 音とBGM
// ===========================================================================
check('C-1 ジュークボックス: 曲を決めてからBGMをONにする',
  /audio\.preview\(id\);\s*\n\s*if \(!getSettings\(\)\.musicOn\) \{/.test(screens), '');
check('C-2 ループ固定も同じ順番',
  /audio\.preview\(sel\);\s*\n\s*if \(!getSettings\(\)\.musicOn\) updateSettings/.test(screens), '');
check('C-3 効果音スライダーの試聴音を間引いている',
  /if \(now - lastSfxTick > 120\)/.test(screens), '');
check('C-4 ソロ曲の「どこで流れるか」からウィークリーを外した',
  !/where: 'ソロ・ウィークリー'/.test(audioJs), '');
// v2.65: ウィークリーもデイリーも**専用曲を持った**ので、対戦曲の説明から外れた。
//   ここで見るべきものは「一覧の説明が実態と食い違わないこと」に変わる ──
//   自分の曲を持ったモードの名前が、別の曲の『どこで流れるか』に残っていたら嘘になる。
//   （曲そのものの検査は test/tracks.test.mjs が全曲ぶん見ている）
check('C-5 自分の曲を持ったモードが、別の曲の説明に残っていない', (() => {
  const rows = [...audioJs.matchAll(/\{ id: '(\w+)',[^\n]*?where: '([^']*)'/g)].map(m => [m[1], m[2]]);
  if (rows.length < 40) return false;
  const owned = [['ウィークリー', 'weekly'], ['デイリー', 'daily'], ['連鎖', 'chain'],
    ['リプレイ', 'replay'], ['キメラ', 'chimera'], ['タイムアタック', 'sprint'],
    ['サバイバル', 'survival'], ['メルトダウン', 'meltdown'], ['カオス', 'chaos'],
    ['設計図', 'blueprint'], ['パズル工房', 'workshop']];
  //   ※ 「工房」だけで見ない。キメラ工房（chimera）とパズル工房（workshop）は別のモード。
  return owned.every(([word, id]) => rows.every(([rid, where]) => rid === id || !where.includes(word)));
})(), '');

// ===========================================================================
// D. 書き出し（クリップ / YouTube）
// ===========================================================================
check('D-1 受け取り待ちのクリップを捨てずに先へ渡す',
  /if \(clip\) \{ toast[\s\S]{0,200}?if \(pending\) flushPending\(\);/.test(clip), '');
check('D-2 完成の帯が ●REC と同じ id を使い回さない',
  /<span id="clipDone">/.test(clip) && /#clipBar #clipDone/.test(css), '');
check('D-3 録画の刻みがプロファイルの fps で回る',
  /function makeTicker\(onTick, everyMs = 33\)/.test(clip)
  && /Math\.round\(1000 \/ P\.fps\)/.test(clip), '');
check('D-4 Worker 側の刻みも同じ値を使う',
  /postMessage\(0\)\},\$\{step\}\)/.test(clip), '');
check('D-5 YouTube: 頭の小節を二度予約しない',
  !/audio\.preview\(sel\);\s*\n\s*audio\.restart\(\);/.test(yt), '');
check('D-6 YouTube: 隠れたまま録り終えたら自動停止をやり直す',
  (yt.match(/if \(typeof document !== 'undefined' && document\.hidden\) audio\.onVisibilityChange\(\);/g) || []).length === 2, '');
check('D-7 YouTube: BGM OFF の人にもプレビューを鳴らす',
  /const preview = \(\) => \{\s*\n\s*audio\.preview\(sel\);\s*\n\s*if \(!getSettings\(\)\.musicOn\)/.test(yt), '');
check('D-8 YouTube: rec.start() を try で囲んでいる',
  /try \{\s*\n\s*rec\.start\(1000\);\s*\n\s*\} catch \{/.test(yt), '');
check('D-9 YouTube: 閉じたら呼び出し元へ戻れる',
  /export function showYouTubeStudio\(onBack = null\)/.test(yt)
  && /if \(typeof onBack === 'function'\) \{ onBack\(\); return; \}/.test(yt), '');
check('D-10 サントラからスタジオへ潜ったら、閉じてサントラへ戻る',
  /showYouTubeStudio\(\(\) => showJukeboxModal\(\)\)/.test(screens), '');

// ===========================================================================
// E. レイアウトと安全領域
// ===========================================================================
check('E-1 録画帯が実測（--bba-clip-bottom）に追随する',
  /--bba-clip-bottom/.test(game) && /var\(--bba-clip-bottom, 150px\)/.test(css), '');
check('E-2 小さい画面の指定も同じ変数を使う',
  /var\(--bba-clip-bottom, 168px\)/.test(css), '');
check('E-3 エモートのパレットがノッチの下から始まる',
  /top: calc\(56px \+ env\(safe-area-inset-top, 0px\)\)/.test(css), '');
check('E-4 エモートのパレットが画面幅に収まる',
  /\.emote-picker \{[\s\S]{0,400}?max-width: calc\(100vw - 16px\); flex-wrap: wrap;/.test(css), '');
check('E-5 サブ画面の下端がホームバーを避ける',
  /\.sub-screen \{[\s\S]{0,300}?env\(safe-area-inset-bottom, 0px\)/.test(css), '');
check('E-6 ギルド会話の入力欄が16px',
  /\.gd-input input \{[\s\S]{0,300}?font-size: 16px;/.test(css), '');
check('E-7 パーティー会話の入力欄が16px',
  /\.pt-input input \{[\s\S]{0,300}?font-size: 16px;/.test(css), '');
check('E-8 フレンド検索と管理者検索に見た目がある',
  /\.fr-find input, #adminUserSearch \{/.test(css), '');
check('E-9 横持ちのパネルがノッチの内側に入る',
  /\.opp-panel \{ left: calc\(6px \+ env\(safe-area-inset-left, 0px\)\)/.test(css)
  && /\.boss-panel \{ right: calc\(6px \+ env\(safe-area-inset-right, 0px\)\)/.test(css), '');
check('E-10 味方表示の切り替えが 44×44 以上',
  /\.opp-density \{[\s\S]{0,400}?min-width: 44px; min-height: 44px;/.test(css), '');
check('E-11 暗色だと宣言している（白いスクロールバーを出さない）',
  /color-scheme: dark;/.test(css), '');
check('E-12 キメラの「置き場所なし」に見た目がある',
  /\.perk-btn\.off \{/.test(css), '');
check('E-13 名前が長くてもトップバーが壊れない（v2.63.2 と対）',
  /#userChip \{ min-width: 0; \}/.test(css), '');

// ===========================================================================
// F. オフライン（Service Worker）
// ===========================================================================
{
  const at = sw.indexOf('async function navigateFirst');
  const fn = at >= 0 ? sw.slice(at, at + 900) : '';
  check('F-1 前提: navigateFirst を切り出せた', fn.includes('offlineCard'), `${fn.length}文字`);
  check('F-2 5xx は圏外と同じ扱いにする（502のまま出さない）',
    /if \(res\.status >= 500\) throw new Error/.test(fn), '');
  check('F-3 404 はそのまま返す（本物の404を隠さない）',
    /if \(res\.status >= 500\) throw[\s\S]{0,60}?return res;/.test(fn), '');
  check('F-4 一式そろっている印を見てから控えの index を返す',
    /if \(await shellReadyFor\(\)\) \{/.test(fn), '');
  check('F-5 そろっていなければ案内カードを出す',
    /return offlineCard\(\);\s*\n\s*\}/.test(fn), '');
}

// ===========================================================================
// G. 画面の作法
// ===========================================================================
check('G-1 デイリーの「記録されなかった」に mode を渡す',
  /noteResultsDropped\(1, d\.reason \|\| 'expired', 'daily'\)/.test(net), '');
check('G-2 デイリーの練習は毎回サーバーへ聞きに行かない',
  /if \(info\.played && !\(kept && info\.inProgress\)\)/.test(modes), '');
check('G-3 「本日のピックアップ」がタブごと切り替える',
  /await openShop\(b\.dataset\.dealgo, \{ keepScreen: true \}\)/.test(screens), '');
check('G-4 押した品まで送って光らせる',
  /data-shop-id=/.test(screens) && /classList\.add\('deal-jump'\)/.test(screens)
  && /\.shop-item\.deal-jump/.test(css), '');
check('G-5 ピックアップの値段に通貨の絵が付く',
  /\? ic\('gems', 13\) : ic\('coins', 13\)/.test(screens), '');
check('G-6 ブースターの ×10 に合計額が出る',
  /×10 \$\{ic\('coins', 13\)\} \$\{fmt\(unitPrice \* 10\)\}/.test(screens), '');
check('G-7 ×10 はコインが足りなければ押せない',
  /session\.user && \(session\.user\.coins \|\| 0\) < unitPrice \* 10 \? ' disabled' : ''/.test(screens), '');
check('G-8 まとめ買いに1段の確認がある',
  /if \(n > 1 && !confirm\(tr\(/.test(screens), '');
check('G-9 殿堂の「いつの順位か」が英語でも英語で出る',
  /LANG === 'en' \? \(r\.seasonNameEn \|\| r\.seasonName\) : r\.seasonName/.test(screens), '');
check('G-10 死んだ「1.5x」の札が残っていない',
  !/event-live::after/.test(css) && !/content: '1\.5x'/.test(css)
  && !/toggle\('event-live'/.test(mainJs), '');

// ===========================================================================
// H. サーバー側
// ===========================================================================
check('H-1 管理者イベントの時間の頭押さえが予算式にそろっている',
  /req\.user\.stats\.lastResultAt = Math\.min\(now, last \+ Math\.ceil\(duration\) \* 1000\);/.test(adminEvent)
  && !/req\.user\.stats\.lastResultAt = now;/.test(adminEvent), '');
check('H-2 引退したカオスが住人の投票の好みに残っていない',
  !/chaos:/.test(polls), (polls.match(/.{0,40}chaos:.{0,20}/) || [''])[0]);
check('H-3 杭で買った警告延長も枠へ預ける',
  /run\.warnBonus = 1500;/.test(zeroSess)
  && /if \(Number\.isFinite\(run\.warnBonus\)\) s\.warnBonus = run\.warnBonus;/.test(zeroSess), '');
check('H-4 使ったら枠の控えも一緒に戻す',
  /if \(s\.warnBonus\) \{ s\.warnBonus = 0; if \(run\) run\.warnBonus = 0; \}/.test(zeroSess), '');
check('H-5 段を割ったら延長も片づける',
  /run\.stakes2 = 0;[^\n]*\n\s*run\.warnBonus = 0;/.test(zeroSess), '');
check('H-6 玉座/断罪録の説明が実装に合っている（日本語）',
  /玉座の金に染まり/.test(catalog) && /紫の封印色に沈んだ/.test(catalog)
  && !/奪還した数だけ玉座が灯る/.test(catalog) && !/壁に名前が流れ続ける/.test(catalog), '');
check('H-7 同じく英語側',
  /throne-gold/.test(catalogEn) && /violet of the seal/.test(catalogEn), '');

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
