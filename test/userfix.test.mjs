// リポジトリのルートから:  node test/userfix.test.mjs
//
// 🙋 ユーザー報告（2026-09-06）ぶんの回帰テスト。4件まとめて。
//
//   A. 👻 配置プレビューの3段（標準／控えめ／なし）
//      「ゴーストってチートじゃないですか？」から。位置のゴーストは入力手段の
//      都合（コマは指より上に浮くので、無いとどのマスを狙っているか分かりにくい）だが、
//      消える線の白帯・氷の水色帯は**結果を教えている**＝手助け。切れるようにした。
//      ⚠ 結果の層は ghostAt の1か所で止める。表示側は9か所あり、そこに個別の if を
//        書くと1つ書き忘れたときに「ドラッグとタップで見え方が違う」という最悪の形になる。
//
//   B. 📘 チュートリアルが一度消しても また出てくる
//      完了とスキップのときしか印を立てていなかった。①の吹き出しには「次へ」が無く
//      「スキップ」しかないので、普通に遊んでゲームオーバーになった人は印が立たず、
//      6モードを渡り歩くたびに 1/4 から出直していた。**出した瞬間**に立てる。
//
//   C. 🔖 しおりを挟むとボタンの大きさが崩れる
//      カードが2列グリッドの1マスに入り、nowrap の文字幅でトラックを押し広げていた
//      （実測 375px 幅で 369.5px / 130.3px ＝ メニュー18本すべてが画面外）。
//      加えて確認ダイアログの「しおりをはさむ」が CSS に明記された予算
//      （1本あたり約98px・全角4文字）を破り、隣のボタンに字が潜っていた。
//
//   D. 🔓 隠し要素が開放できない
//      保存・表示・復元は生きていた。切れていたのは**実力で開く道**だけ。
//      AI戦は120秒で鬼が171手置き、スコアは実質「置いた手数」で決まるので、
//      勝つには 0.70秒に1回ノーミスでドラッグし続ける必要があった（実測0勝15敗）。
//      隠しコマンドを打てない人のための道として書かれているのに閉じていた。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort, waitForServer } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-userfix-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
// 経緯を説明するコメントには、直す前のコードや文言がそのまま引用してある。
// 素のまま正規表現に掛けると **自分の説明文に当たって** 赤くなるので落とす。
const code = f => read(f).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

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
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'userfix-test', SEED_RESTORE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(proc, BASE);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

try {
  const settings = code('public/js/settings.js');
  const game = code('public/js/game.js');
  const screens = code('public/js/screens.js');
  const modes = code('public/js/modes.js');
  const main = code('public/js/main.js');
  const css = read('public/css/style.css');
  const localdata = code('public/js/localdata.js');
  const idx = code('server/index.js');

  // =========================================================================
  // A. 👻 配置プレビューの3段
  // =========================================================================
  check('A-1 設定に段がある（既定は今までどおり）', /placePreview: 'full',/.test(settings), '');
  check('A-2 壊れた値は「標準」へ倒す（黙って控えめに落ちない）',
    /\['full', 'light', 'off'\]\.includes\(settings\.placePreview\)\) settings\.placePreview = 'full'/.test(settings), '');
  check('A-3 段の規則は2本の述語だけが持つ',
    /export function showPlaceGhost\(\) \{ return settings\.placePreview !== 'off'; \}/.test(settings)
    && /export function showClearHint\(\) \{ return settings\.placePreview === 'full'; \}/.test(settings), '');
  check('A-4 描画側が2本を取り込んでいる', /showPlaceGhost, showClearHint \} from '\.\/settings\.js'/.test(game), '');
  check('A-5 描画側の窓口が2つある', /showGhost\(\) \{/.test(game) && /showClear\(\) \{/.test(game), '');
  check('A-6 モードの上書きが窓口より強い',
    (game.match(/if \(this\.assistOverride === 'off'\) return false;/g) || []).length === 2, '');

  // ★ ここが本丸。結果の層は1か所で止める。
  check('A-7 「結果」の層は ghostAt の1か所で止まる',
    /if \(valid && this\.showClear\(\)\) \{/.test(game), '');
  const displayIfs = (game.match(/willRows\.size[^\n]*showClear|showClear\(\)[^\n]*willRows/g) || []).length;
  check('A-8 表示側に個別の if を散らしていない（1つ書き忘れると入力手段で見え方が変わる）',
    displayIfs === 0, `${displayIfs}件`);
  check('A-9 ドラッグのゴーストは位置の層',
    /const ghost = \(wslot === -1 && this\.showGhost\(\)\) \? this\.ghostInfo\(\) : null;/.test(game), '');
  check('A-10 タップ選択の枠はどの段でも消さない（唯一の手掛かり）',
    /ctx\.strokeStyle = \(!this\.showGhost\(\) \|\| valid\) \? '#ffffff' : '#ff6b6b';/.test(game), '');
  check('A-11 「なし」でもタップ選択のマスは描く（消しても何も隠せないため）',
    /const tell = this\.showGhost\(\);/.test(game) && /if \(!tell\) \{/.test(game), '');
  check('A-12 手札の「置けない」淡色化は計算ごと省く',
    /const placeable = this\.showGhost\(\) \? this\.engine\.placements\(piece\)\.length > 0 : true;/.test(game), '');
  check('A-13 view の使い回しで次の試合へ漏れない（setEngine で戻す）',
    /this\.ghostFx = null;[\s\S]{0,400}this\.assistOverride = null;/.test(game), '');
  check('A-14 設定画面に3段の選択がある', /id="setPreview"/.test(screens)
    && ['full', 'light', 'off'].every(k => screens.includes(`data-pv="${k}"`)), '');
  check('A-15 段ごとの説明が出る（「アシスト」だけでは何が変わるか伝わらない）',
    /const PV_NOTE = \{/.test(screens) && /id="setPvNote"/.test(screens), '');
  check('A-16 運営ルーレットの「ゴースト消灯」が名前どおりになった',
    /case 'blind': this\.assistOff\(\); break;/.test(modes) && /assistOff\(\) \{/.test(modes), '');
  check('A-17 ただし管理者の攻撃「目隠し」は真っ暗のまま（別物・触らない）',
    /run: m => m\.blindFor\(3200\)/.test(modes), '');
  check('A-18 深淵の呪い blind も無傷（既存テストが見張っている別物）',
    /const blind = this\.curse === 'blind';/.test(modes), '');

  // =========================================================================
  // B. 📘 チュートリアル
  // =========================================================================
  check('B-1 1人用は出した瞬間に印を立てる',
    /this\.tip = tip;\n\s*markTutorialDone\(\);/.test(modes), '');
  check('B-2 対戦も出した瞬間に印を立てる',
    /this\.tip = tip;\n\s*markVersusTutorialDone\(\);/.test(modes), '');
  check('B-3 設定に「やり直す」がある（一度きりにする以上、読み直す口が要る）',
    /id="setTutReset"/.test(screens) && /resetTutorial\(\)/.test(screens), '');
  check('B-4 resetTutorial を取り込んでいる（export だけで誰も呼んでいなかった）',
    /resetTutorial \} from '\.\/modes\.js'/.test(screens), '');

  // =========================================================================
  // C. 🔖 しおりのUI
  // =========================================================================
  check('C-1 メニューの列が中身で膨らまない',
    /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/.test(css), '');
  check('C-2 しおりのカードは行いっぱい', /#bookmarkCard \{ grid-column: 1 \/ -1; \}|#bookmarkCard.*grid-column: 1 \/ -1/.test(css)
    || /\.menu-buttons #btnSolo, \.menu-buttons #btnOnline, \.menu-buttons #bookmarkCard \{ grid-column: 1 \/ -1; \}/.test(css), '');
  check('C-3 カードだけ折り返しを許す（他のモード名は nowrap のまま）',
    /#bookmarkCard \{ white-space: normal;/.test(css) && /\.menu-buttons \.btn-big \{ white-space: nowrap; \}/.test(css), '');
  check('C-4 幅の指定を JS から外した（CSS に任せる）',
    !/el\.style\.width = '100%';/.test(code('public/js/main.js')), '');
  check('C-5 確認ダイアログのラベルが予算内（全角4文字まで）',
    /id="qMark">\$\{t\('しおり', 'Bookmark'\)\}/.test(main), '');

  // =========================================================================
  // D. 🔓 隠し要素
  // =========================================================================
  check('D-1 鬼は「勝つ」か「肉薄する」で開く',
    /mode === 'ai_oni' && \(won \|\| score >= ONI_CLOSE\)/.test(idx), '');
  check('D-2 神も同じ', /mode === 'ai_kami' && \(won \|\| score >= KAMI_CLOSE\)/.test(idx), '');
  check('D-3 しきい値が相手の平均より下にある（届く高さ）',
    /const ONI_CLOSE = (\d+);/.test(idx) && Number(idx.match(/const ONI_CLOSE = (\d+);/)[1]) < 10000, '');
  check('D-4 まだ開いていない段も一覧に出る（消すと在ることすら伝わらない）',
    /data-locked="\$\{key\}" disabled/.test(main) && /？？？/.test(main), '');
  check('D-5 ロゴのヒントがゲストにも出る（端末側の回数も見る）',
    /Math\.max\(server, local\) >= 30/.test(main), '');
  check('D-6 端末側のプレイ回数を数えている', /localStorage\.setItem\('bba_plays'/.test(modes), '');
  check('D-7 数えるのはログインの有無に関わらず（ゲストの前で数える）',
    /bba_plays[\s\S]{0,200}if \(!session\.user\) return null;/.test(modes), '');
  check('D-8 その端末キーが仕舞う対象に登録されている', /'bba_plays',/.test(localdata), '');

  // -------------------------------------------------------------------------
  // 実サーバーで「肉薄すると開く」を通す
  // -------------------------------------------------------------------------
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();
  const tok = (await j('/api/register', { method: 'POST', body: { username: 'かくしようそ', password: 'pw-userfix-1' } })).token;
  check('D-9 下ごしらえ: アカウントを作れた', !!tok, '');
  const me0 = await j('/api/me', {}, tok);
  check('D-10 最初は何も開いていない', !((me0.user.stats.unlocks || []).includes('kami')),
    JSON.stringify(me0.user.stats.unlocks || []));

  // 負けたが肉薄した回（won:false）
  const close = await j('/api/game/result', { method: 'POST', body: {
    mode: 'ai_oni', won: false, score: 9000, lines: 30, duration: 120, pieces: 150,
  } }, tok);
  // 解放の一覧は rewards の中（server/index.js の applyGameResult の返り値）。
  const unlockedOf = r => (r && r.rewards && r.rewards.unlocked) || [];
  check('D-11 鬼に肉薄したら神が開く（勝てなくても）',
    unlockedOf(close).includes('kami'), JSON.stringify(unlockedOf(close)));

  const tok2 = (await j('/api/register', { method: 'POST', body: { username: 'とどかない', password: 'pw-userfix-1' } })).token;
  const far = await j('/api/game/result', { method: 'POST', body: {
    mode: 'ai_oni', won: false, score: 3000, lines: 10, duration: 120, pieces: 60,
  } }, tok2);
  check('D-12 届かなければ開かない（塞ぎすぎ・緩すぎの両側を見る）',
    !unlockedOf(far).includes('kami'), JSON.stringify(unlockedOf(far)));

  const kami = await j('/api/game/result', { method: 'POST', body: {
    mode: 'ai_kami', won: false, score: 13000, lines: 40, duration: 120, pieces: 200,
  } }, tok);
  check('D-13 神に肉薄したら創造神が開く',
    unlockedOf(kami).includes('souzou'), JSON.stringify(unlockedOf(kami)));

  const me1 = await j('/api/me', {}, tok);
  check('D-14 解放がアカウントに残る',
    ['kami', 'souzou'].every(k => (me1.user.stats.unlocks || []).includes(k)),
    JSON.stringify(me1.user.stats.unlocks || []));

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🙋 ユーザー報告ぶん\n');
for (const [m, n, d] of results) console.log(`${m} ${n}${d ? `  (${d})` : ''}`);
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
