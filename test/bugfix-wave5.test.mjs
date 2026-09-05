// リポジトリのルートから:  node test/bugfix-wave5.test.mjs
//
// 🐛 バグ修正 第5波 ── 「進行不能・盤面が壊れる」。
//
// この波の共通点は、**プレイヤーが自力で抜け出せなくなる**こと。
// 閉じ口の無いモーダル・止まらない時計・消えない行。どれも「損をする」より
// 手前の、遊べなくなる種類の壊れ方なので、機械で見張っておく。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../public/js/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// ソースは CRLF。'\n' を含む検索が空振りしないよう、読むときに正規化する。
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const modes = read('public/js/modes.js');
const main = read('public/js/main.js');
const dom = read('public/js/dom.js');
const battle = read('server/battle.js');
const zs = read('server/zero-session.js');

// ===========================================================================
// ① メルトダウン ── 湧いた冷却セルが行を埋めたら、その場で消す
//
// engine の resolveLines() を通さないと、揃った8マスが盤面に居座る。次に
// どこか1手を置いた人が、その行の得点・コンボ・ライン数・熱をまとめて
// 受け取ってしまう（熱はライン数で上がるので炉心爆発が想定より早く来る）。
// addGarbage() も bossImpact() も必ず通しているのに、ここだけ通っていなかった。
// ===========================================================================
{
  const i = modes.indexOf('  spawnCool() {');
  const body = i < 0 ? '' : modes.slice(i, modes.indexOf('\n  }\n', i));
  check('①-0(前提) spawnCool を切り出せた', body.length > 100, `${body.length}文字`);
  const iRes = body.indexOf('e.resolveLines()');
  const iMove = body.indexOf('e.hasAnyMove()');
  check('①-1 湧かせたら行を片付ける', iRes >= 0, '');
  check('①-2 片付けは詰み判定より前', iRes >= 0 && iMove >= 0 && iRes < iMove,
    `resolve@${iRes} / hasAnyMove@${iMove}`);
  check('①-3 消えた冷却セルを Set に残さない', /this\.pruneCool\(\);/.test(body), '');
  check('①-4 自分ごと消えた回は Set に足さない', /if \(e\.grid\[k\] !== 6\) return;/.test(body), '');

  // engine 側の性質を実物で確かめる ── 1マス足すと行が揃う盤面を作り、
  // resolveLines() が本当にその行を消すこと（＝直しが効くこと）を見る。
  const e = new Engine(1234);
  for (let c = 0; c < 7; c++) e.grid[0 * 8 + c] = 3;   // 0行目を7マス埋める
  e.grid[0 * 8 + 7] = 6;                               // 冷却セルが湧いて8マス目
  const before = e.grid.slice(0, 8).filter(v => v).length;
  const r = e.resolveLines();
  const after = e.grid.slice(0, 8).filter(v => v).length;
  check('①-5 resolveLines は揃った行を実際に消す', before === 8 && after === 0 && r.lineCount === 1,
    `${before}マス → ${after}マス / lineCount=${r.lineCount}`);
  check('①-6 消しても得点は動かない（置いた人の手柄にしない）', e.score === 0, `score=${e.score}`);
}

// ===========================================================================
// ② 確認ダイアログの裏で、時計もボスの攻撃も止まる
//
// ✕（＝端末の戻る）の暗幕は盤面を覆うので指は届かないのに、予告技は着弾し、
// 波は降り、時計は進んでいた。「続ける」を選ぶつもりで文面を読んでいる
// 数秒で走行が終わる ── 何もしていないのに負ける、いちばん理不尽な負け方。
// ===========================================================================
{
  const i = modes.indexOf('export function pauseModeForDialog() {');
  const body = i < 0 ? '' : modes.slice(i, modes.indexOf('\n}\n', i));
  check('②-0 一時停止の口がある', body.length > 200, `${body.length}文字`);
  check('②-1 オンラインでは止めない（相手を待たせない）',
    /if \(m\.client \|\| m\.mode === 'pvp' \|\| m\.mode === 'zero' \|\| m\.kind\) return null;/.test(body), '');
  check('②-2 終わった走行では何もしない', /if \(!m \|\| m\.ended \|\| m\._dialogPaused\) return null;/.test(body), '');
  check('②-3 止めた時間ぶん期限を後ろへずらす', /m\[key\] \+= delta;/.test(body), '');
  // ⏱ 「閉じたときにまとめて足す」だけでは足りない。開いている間は画面の
  //    時計が減り続け（実測: 5秒読んだら 57→45秒）、startTimer の刻みが
  //    timeLeft<=0 に届いて**読んでいる最中に走行が終わる**。開いている間
  //    ずっと押し続けること。
  check('②-3b 開いている間ずっと押し続ける（読んでいる最中に終わらせない）',
    /const iv = setInterval\(\(\) => \{[\s\S]{0,160}?shift\(now - last\);/.test(body), '');
  check('②-3c 閉じたら見張りを止めて端数も足す',
    /clearInterval\(iv\);\n\s+shift\(Date\.now\(\) - last\);/.test(body), '');
  for (const key of ['endAt', 'nextAt', 'nextAtk', 'startedAt', 'playStartedAt']) {
    check(`②-4 ${key} を送らせる対象に入れている`,
      new RegExp(`'${key}'`).test(modes.slice(modes.indexOf('const PAUSABLE_DEADLINES'), i)), '');
  }
  check('②-5 効果の残り時間（フィーバー・要塞）も延ばす',
    /'feverUntil', 'fortressUntil'/.test(body), '');
  check('②-6 入力ロックを元に戻す（勝手に操作不能にしない）',
    /v\.inputLocked = m\._dialogLockWas === true;/.test(body), '');
  // v2.52: 控えはクロージャではなく**モードの欄**に持たせる。
  //   ダイアログを開いているあいだに 3-2-1 が終わることがあり（暗幕越しでも
  //   ✕ は押せる）、そのとき afterCountdown が控えを false に書き直す。
  //   直さないと閉じたときにカウントダウン中の施錠が戻り、**盤面が二度と触れなくなる**
  //   （AI戦・ボス・ボスラッシュ・ダンジョン・カオス・タイムアタック・管理者イベントの7モード）。
  check('②-6b カウントダウンが裏で終わったら、控えも直す',
    /if \(mode\._dialogPaused\) \{\s*mode\._dialogLockWas = false;/.test(modes), '');

  // 3か所すべてが繋がっていること
  check('②-7 ✕ の確認が止める', /const resume = pauseModeForDialog\(\);/.test(main), '');
  check('②-8 ダンジョンの撤退確認も止める',
    /const resume = pauseModeForDialog\(\);[\s\S]{0,400}?ダンジョンから撤退しますか/.test(modes), '');
  check('②-9 カオスの中断確認も止める',
    /const resume = pauseModeForDialog\(\);[\s\S]{0,400}?カオスモードを中断しますか/.test(modes), '');

  // 閉じ方はボタンだけではない（枠外タップ・Esc・端末の戻る）。
  // onModalClosed を通さないと、止めた時計が止まったまま＝永久に無敵になる。
  check('②-10 閉じ方によらず必ず戻す（onModalClosed）',
    (main.match(/if \(resume\) onModalClosed\(resume\);/g) || []).length === 1
    && (modes.match(/if \(resume\) onModalClosed\(resume\);/g) || []).length === 2, '');
  check('②-11 dom.js に閉じたときの口がある', /export function onModalClosed\(fn\) \{/.test(dom), '');
  check('②-12 中身が消えたときに必ず流す', /if \(had\) runModalClosedHooks\(\);/.test(dom), '');
  check('②-13 一度きりで流す（同じ後始末を二度走らせない）',
    /const hooks = modalClosedHooks;\n  modalClosedHooks = \[\];/.test(dom), '');
}

// ===========================================================================
// ③ Space / q がモーダルを貫通しない
// ===========================================================================
{
  const i = main.indexOf("if (e.code !== 'Space' && e.key !== 'q') return;");
  const body = i < 0 ? '' : main.slice(i, main.indexOf('\n});', i));
  const iModal = body.indexOf("getElementById('modal-root')");
  const iPrevent = body.indexOf('e.preventDefault();');
  check('③-1 モーダル中は奥義を撃たない', iModal >= 0, '');
  check('③-2 しかも preventDefault より前で降りる（Space でボタンを押せる）',
    iModal >= 0 && iPrevent >= 0 && iModal < iPrevent, `modal@${iModal} / prevent@${iPrevent}`);
  check('③-3 押しっぱなしの自動リピートで連発しない', /if \(e\.repeat\) return;/.test(body), '');
  check('③-4 入力欄でも撃たない（contentEditable 込み）',
    /e\.target\.isContentEditable/.test(body), '');
}

// ===========================================================================
// ④ トーナメント ── 不戦勝の優勝者を閉じ込めない
// ===========================================================================
{
  check('④-1 優勝フレームに受け口がある',
    /\.on\('tourney_champion', msg => this\.onTourneyChampion\(msg\)\)/.test(modes), '');
  const i = modes.indexOf('  onTourneyChampion(msg = {}) {');
  const body = i < 0 ? '' : modes.slice(i, modes.indexOf('\n  }\n', i));
  check('④-2 優勝モーダルを出す', body.length > 200, `${body.length}文字`);
  check('④-3 出口が2つある（メニュー／もう一度）',
    /id="rMenu"/.test(body) && /id="rAgain"/.test(body), '');
  check('④-4 付いた報酬を上部バーに反映する',
    /session\.user = msg\.user; updateTopbar\(\);/.test(body), '');
  check('④-5 実際に何が入ったかを出す', /rewardsRows\(msg\.rewards\)/.test(body), '');
  check('④-6 決勝を戦って勝った回は結果画面を上書きしない',
    /if \(document\.querySelector\('\.modal \.result-stats'\)\) return;/.test(body), '');
  check('④-7 ブラケットにも出口を1つ置く', /id="tqLeave"/.test(modes), '');
}

// ===========================================================================
// ⑤ 更新の準備で、大会にも必ず通知する
// ===========================================================================
{
  const i = battle.indexOf('  function endAllForShutdown() {');
  const body = i < 0 ? '' : battle.slice(i, battle.indexOf('\n  }\n', i));
  check('⑤-1 大会の参加者へ中止を送る', /type: 'tourney_cancelled'/.test(body), '');
  check('⑤-2 理由も添える', /サーバー更新のためトーナメントを中止しました/.test(body), '');
  const iSend = body.indexOf("type: 'tourney_cancelled'");
  const iEnd = body.indexOf('endTourney(t);');
  check('⑤-3 畳む前に送る（送り先が消えてからでは届かない）',
    iSend >= 0 && iEnd >= 0 && iSend < iEnd, `send@${iSend} / end@${iEnd}`);
  check('⑤-4 住人（ボット）には送らない', /if \(!p \|\| p\.isBot\) continue;/.test(body), '');
  check('⑤-5 クライアントに受け口がある',
    /\.on\('tourney_cancelled', \(\) => this\.onTourneyCancelled\(\)\)/.test(modes), '');
  const j = modes.indexOf('  onTourneyCancelled() {');
  const cbody = j < 0 ? '' : modes.slice(j, modes.indexOf('\n  }\n', j));
  check('⑤-6 受け口はモーダルを閉じてメニューへ返す',
    /closeModal\(\);/.test(cbody) && /endToMenu\(\);/.test(cbody), '');
}

// ===========================================================================
// ⑥ 合言葉ルームの「再戦」── 断るなら必ずそう言う
// ===========================================================================
{
  const i = battle.indexOf("case 'rematch': {");
  const body = i < 0 ? '' : battle.slice(i, battle.indexOf('\n        }', i));
  // 「取り込み中」の判定で無言 return していた行が、必ず返事をするようになったこと
  check('⑥-1 在籍中の再戦は無言で捨てない',
    /if \(ws\.matchId \|\| ws\.roomCode \|\| ws\.tourneyId \|\| ws\.royaleId \|\| ws\.zeroId\) \{\n\s+send\(ws, \{ type: 'rematch_gone' \}\);\n\s+return;\n\s+\}/.test(body), '');
  check('⑥-2 合言葉ルームでは「再戦」を出さない（押しても必ず空振りだった）',
    /\$\{msg\.rematchId && this\.kind !== 'custom' &&/.test(modes), '');
}

// ===========================================================================
// ⑦ 断罪の取引 ── 走行をまたいでも合流できる
// ===========================================================================
{
  check('⑦-1 席に着いた瞬間に取引を拾う',
    /onFound\(m\) \{[\s\S]{0,600}?this\.syncDeal\(m\.deal\);/.test(modes), '');
  check('⑦-2 毎秒の状態でも拾う',
    /onState\(m\) \{[\s\S]{0,500}?this\.syncDeal\(m\.deal\);/.test(modes), '');
  const i = modes.indexOf('  syncDeal(deal) {');
  const body = i < 0 ? '' : modes.slice(i, modes.indexOf('\n  }\n', i));
  check('⑦-3 合流の口がある', body.length > 100, `${body.length}文字`);
  check('⑦-4 締切済み・期限切れは出さない',
    /if \(!deal \|\| deal\.settled \|\| deal\.closesAt <= Date\.now\(\)\) return;/.test(body), '');
  check('⑦-5 もう出ているなら二重に出さない', /if \(\$\('#zeroDeal'\)\) return;/.test(body), '');
  check('⑦-6 投票済みなら押せる形で出さない', /if \(deal\.voted\)/.test(body), '');
  check('⑦-7 サーバーが視聴者ごとに投票済みを返す',
    /deal: view\.deal \? \{ \.\.\.view\.deal, voted \} : null,/.test(zs), '');
  check('⑦-8 席に着いた瞬間のフレームにも載せる',
    /deal: found\.deal[\s\S]{0,240}?humanVotes\[e\.ws\.user\.id\]/.test(battle), '');
}

// ===========================================================================
// ⑧ 結果モーダルがメニューへ戻ったあとに割り込まない
//
// 他モードの finish() は await の直後にそろって同じガードを置いている
// （閉じ口の無い結果画面がメニューを覆うのを防ぐため）。管理者イベントと
// 断罪の2つだけ無条件に出していた。断罪は伝言の待ちが最長12秒あるので窓が広い。
// ===========================================================================
{
  const grab = (anchor) => {
    const a = modes.indexOf(anchor);
    if (a < 0) return '';
    const s0 = modes.lastIndexOf('async finish() {', a);
    return s0 < 0 ? '' : modes.slice(s0, a);
  };
  const ae = grab("if (res && res.event && window.__bbaAeRefresh) {");
  check('⑧-1 管理者イベントにガードが入った',
    /if \(currentMode !== this\) return;/.test(ae), `${ae.length}文字`);
  const zero = grab("const e = this.engine;\n    let res = null;");
  check('⑧-2 断罪にもガードが入った', /if \(currentMode !== this\) return;/.test(zero),
    `${zero.length}文字`);
  // ただし席の後始末は必ず通すこと（ガードが先だと席が残って断罪が飛び続ける）
  const iLeave = zero.indexOf("type: 'zero_leave'");
  const iGuard = zero.indexOf('if (currentMode !== this) return;');
  check('⑧-3 断罪は席を畳んでからガードする',
    iLeave >= 0 && iGuard >= 0 && iLeave < iGuard, `leave@${iLeave} / guard@${iGuard}`);
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🐛 バグ修正 第5波 ── 進行不能  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
