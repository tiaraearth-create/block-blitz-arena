// リポジトリのルートから:  node test/painpoints.test.mjs
//
// 😖 「痛い場所」の回帰テスト。
//
// コードは意図どおり動いているのに、遊んでいて理不尽・面倒・分かりにくい
// ところ。とくに **実プレイヤーが13人しかいない世界**で、到達不能な目標や
// 「自分の落ち度でないのに損をする」形になっていたぶんを見張る。
//
//   A. 難易度「神」「創造神」が人間の手の速さでは勝てない（実績と称号がその勝利を要求）
//   B. ロイヤルだけ再接続を1回も試さない／猶予中にロビーごと消える
//   C. ボスラッシュは解放数が増えるほど制覇が遠のく
//   D. ダンジョンのチェックポイント再開が、通しで登った人より桁違いに弱い
//   E. 上限に当たった理由が出ない（イベントのジェム）
//   F. 世界の規模で到達できない目標（王者10回・自作50♡）
//   G. ソロの BEST が他モードの点に汚染される
//   H. しおりで消えるもの（幽霊屋敷の霧・ソロの👁）
//   I. 何が動くのか（レート・戦績）が選択画面に書かれていない
//   J. ギルド週間クエストが1人ギルドでは永久に開かない
//   K. 押しても必ず失敗するボタン／閉じ口の無い画面／打ち直しになる検索
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_LEVELS } from '../public/js/ai.js';
import * as guilds from '../server/guilds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const stripComments = src => src.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const modes = stripComments(read('public/js/modes.js'));
const mainJs = stripComments(read('public/js/main.js'));
const rulesJs = stripComments(read('public/js/rules.js'));
const screens = stripComments(read('public/js/screens.js'));
const friendsCli = stripComments(read('public/js/friends.js'));
const dom = stripComments(read('public/js/dom.js'));
const net = stripComments(read('public/js/net.js'));
const index = stripComments(read('server/index.js'));
const battle = stripComments(read('server/battle.js'));
const ach = stripComments(read('server/achievements.js'));
const shop = stripComments(read('server/routes/shop.js'));

// ===========================================================================
// A. AI の強さは「手の質」で作る（速さで人間を締め出さない）
// ===========================================================================
{
  // 王者ボットが人間の帯として選んだ値（server/battle.js のコメント）。
  const HUMAN_MS = 700;
  check('A-1 神が人間の帯まで下りている', AI_LEVELS.kami.moveMs >= 600, `${AI_LEVELS.kami.moveMs}ms`);
  check('A-2 創造神も人間の帯', AI_LEVELS.souzou.moveMs >= 600, `${AI_LEVELS.souzou.moveMs}ms`);
  check('A-3 鬼より速くしていない（順番が壊れていない）',
    AI_LEVELS.kami.moveMs >= HUMAN_MS - 40 && AI_LEVELS.souzou.moveMs >= HUMAN_MS - 40,
    `oni=${AI_LEVELS.oni.moveMs} kami=${AI_LEVELS.kami.moveMs} souzou=${AI_LEVELS.souzou.moveMs}`);
  // 難易度の順は「手の質」で保たれていること（速さではなく思考で強い）。
  check('A-4 上ほど思考が深い', !AI_LEVELS.oni.exhaustive && AI_LEVELS.kami.exhaustive
    && AI_LEVELS.souzou.exhaustive && AI_LEVELS.souzou.beam > 0,
    `kami.exhaustive=${!!AI_LEVELS.kami.exhaustive} souzou.beam=${AI_LEVELS.souzou.beam}`);
  check('A-5 勝利を要求する実績はそのまま（救済で薄めていない）',
    /has\(u, 'kami'\)|has\(u,'kami'\)/.test(ach) || /'kami'/.test(ach), '');
}

// ===========================================================================
// B. ロイヤルの再接続
// ===========================================================================
check('B-1 ロイヤルも「試合中」に数える',
  /msg\.type === 'royale_found' \|\| msg\.type === 'royale_resumed'/.test(net), '');
check('B-2 終わったら降ろす（繋ぎ直しを繰り返さない）',
  /msg\.type === 'result' \|\| msg\.type === 'royale_over'/.test(net), '');
check('B-3 切断は即確定させず猶予を置く',
  /const until = Math\.min\(Date\.now\(\) \+ RECONNECT_GRACE_MS, endAt\);/.test(battle)
  && /e\.dcUntil = until;/.test(battle), '');
// ⚠ 猶予は**無条件に配ってはいけない**。1v1 と同じ回数の関門（takeGraceQuota）を
//   通さないと、切るたびに 25秒 の無敵が何度でも手に入る ── しかも猶予中に
//   飛んできたお邪魔は閉じたソケットへ送られて捨てられるので、生存を競う
//   モードで「切断が最強の防御」になっていた。預かって、戻ったら降らせる。
check('B-3b 猶予にも1日の回数の関門がある',
  /takeGraceQuota\(user\)[\s\S]{0,80}?e\.dcUntil = until;/.test(battle), '');
check('B-3c 猶予中のお邪魔を捨てずに預かる',
  /target\.pending\.push\(\{ cells, from: from \? from\.name : null, lines \}\);/.test(battle), '');
check('B-3d 戻ってきたら預かったぶんを降らせる',
  /for \(const g of held\) send\(ws, \{ type: 'royale_garbage', \.\.\.g \}\);/.test(battle), '');
check('B-4 猶予が明けたら今までどおり確定する',
  /if \(e\.dcUntil && now < e\.dcUntil\) continue;/.test(battle), '');
check('B-5 **猶予中はロビーを畳まない**（ここが抜けると報酬がゼロになる）',
  /const inGrace = r\.entrants\.some\(e => e\.human && e\.alive && e\.dcUntil && now < e\.dcUntil\);/.test(battle)
  && /if \(!watching && !inGrace\) \{/.test(battle), '');
check('B-6 戻ってきたら席を返す', /function resumeRoyale\(ws, userId\) \{/.test(battle)
  && /if \(!resumeMatch\(ws, user\.id\)\) resumeRoyale\(ws, user\.id\);/.test(battle), '');
check('B-7 順位の裁定は変えていない（離脱＝生存者中の最下位）',
  /endRoyaleFor\(e, r, royaleAlive\(r\)\.length, ranked\);/.test(battle), '');

// ===========================================================================
// C/D. ボスラッシュとダンジョン
// ===========================================================================
check('C-1 1周の長さが固定（解放数で変わらない）', /const RUSH_LAP = 4;/.test(modes), '');
check('C-2 制覇の判定がその固定値を見る', /const conquered = this\.kills >= RUSH_LAP;/.test(modes), '');
check('C-3 周回のHP倍率も同じ物差し', /lap\(\) \{ return Math\.floor\(this\.kills \/ RUSH_LAP\); \}/.test(modes), '');
check('D-1 チェックポイントの見積もりが「通ったフロア数」',
  /const passed = Math\.max\(0, this\.startFloor - 1\);/.test(modes), '');
check('D-2 攻撃間隔にも効く（前は攻撃倍率だけだった）',
  /this\.atkSlow = Math\.pow\(1\.25, passed \* ADOPT_SLOW\);/.test(modes), '');
{
  // 通しで登った人を追い越さないこと（採用率の見積もりは控えめであること）。
  const A = 0.3, S = 0.18;          // 実装の ADOPT_ATK / ADOPT_SLOW
  const FULL_A = 0.5, FULL_S = 0.25; // 通しの人が半分ほど取ったときの見積もり
  const bad = [];
  for (const f of [11, 31, 51, 71, 91]) {
    const p = f - 1;
    if (1 + 0.6 * p * A > 1 + 0.6 * p * FULL_A) bad.push(`F${f} atk`);
    if (Math.pow(1.25, p * S) > Math.pow(1.25, p * FULL_S)) bad.push(`F${f} slow`);
  }
  check('D-3 どの階でも通しの人を追い越さない', bad.length === 0, bad.join(','));
}

// ===========================================================================
// E. 上限に当たった理由
// ===========================================================================
check('E-1 イベントのジェム上限に理由を付ける', /if \(eventGems < Math\.floor\(bonus\.gemDrop\)\) gemCapped = true;/.test(index), '');
check('E-2 返り値の理由に混ぜている', /gemCapped \? \{ capped: 'gem_day' \}/.test(index), '');
check('E-3 画面に行がある', /kind === 'gem_day'/.test(modes), '');
check('E-4 ガチャのジェムも削られたら言う', /gemShort \? \{ budgetOut: true \} : \{\}/.test(shop), '');
check('E-5 画面もそれを出す', /r\.budgetOut \? '（本日のジェム上限）' : ''/.test(screens), '');

// ===========================================================================
// F. 世界の規模で届く目標か
// ===========================================================================
{
  const goalOf = id => {
    const m = ach.match(new RegExp(`a\\('${id}',[^,]*,[^,]*,\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  check('F-1 王者撃破の回数が現実的', goalOf('ach_champ10') !== null && goalOf('ach_champ10') <= 3,
    String(goalOf('ach_champ10')));
  check('F-2 ♡の目標が世界の供給内', goalOf('ach_ws_liked50') !== null && goalOf('ach_ws_liked50') <= 12,
    String(goalOf('ach_ws_liked50')));
  check('F-3 遊ばれた回数も', goalOf('ach_ws_played100') !== null && goalOf('ach_ws_played100') <= 50,
    String(goalOf('ach_ws_played100')));
  // 実プレイヤー13人 → 自分以外12人 × 10ステージ = 理論上限120。
  check('F-4 ♡は理論上限のはるか内側', (goalOf('ach_ws_liked50') || 999) <= 12 * 10 * 0.15,
    `${goalOf('ach_ws_liked50')} / 上限120`);
}

// ===========================================================================
// G/H. ソロの記録と、しおりで消えるもの
// ===========================================================================
check('G-1 ソロ専用の記録欄がある', /mode === 'solo' && score > \(s\.soloBest \|\| 0\)/.test(index), '');
check('G-2 画面がそれを見る', /Math\.max\(session\.user\.stats\.soloBest \|\| 0, guestBest\(\)\)/.test(modes), '');
check('G-3 ランキング用の bestScore は触っていない',
  /if \(scoreboardEligible && score > s\.bestScore\) s\.bestScore = score;/.test(index), '');
check('H-1 幽霊屋敷が霧を預ける', /bookmarkExtra\(\) \{ return \{ fog: \[\.\.\.this\.ghostFx\.hideAt\.keys\(\)\] \}; \}/.test(modes), '');
check('H-2 戻すときに貼り直す', /for \(const k of x\.fog\) if \(Number\.isInteger\(k\)\)/.test(modes), '');
check('H-3 ソロが👁の追跡を預ける', /eye: \{ cell: e\.cell, age: e\.age, since: e\.since, caught: e\.caught, missed: e\.missed \}/.test(modes), '');
check('H-4 開き具合も戻す', /setEyePhase\(this\.eye\.cell >= 0 \? Math\.min\(1, this\.eye\.age \/ EYE_OPEN_MOVES\) : 0\);/.test(modes), '');

// ===========================================================================
// I. 何が動くのかを選択画面に書く
// ===========================================================================
check('I-1 出どころが1か所にある', /export const STAKES_LABEL = \{/.test(rulesJs), '');
check('I-2 選択画面がそれを出す', /STAKES_LABEL\[stakesOf\(mode\)\]\(\)/.test(mainJs), '');
{
  const src = read('public/js/rules.js').replace(/\r\n/g, '\n');
  const block = src.split('export const ONLINE_MODES')[1] || '';
  const kinds = [...block.matchAll(/kind: '(\w+)'/g)].map(m => m[1]);
  const stakeOf = k => {
    const seg = block.split(`kind: '${k}'`)[1].split('kind:')[0];
    const st = (seg.match(/stakes: '(\w+)'/) || [])[1];
    return st || (/rated: true/.test(seg) ? 'rating' : 'none');
  };
  check('I-3 全モードに何が動くかが決まっている', kinds.length >= 8 && kinds.every(k => stakeOf(k)),
    kinds.map(k => `${k}=${stakeOf(k)}`).join(' '));
  // Elo が動くのは1対1のレート戦だけ（server/battle.js の duel2）。
  check('I-4 レートが動くと言っているのは 1v1 のレート戦だけ',
    kinds.filter(k => stakeOf(k) === 'rating').sort().join(',') === 'attack,duel',
    kinds.filter(k => stakeOf(k) === 'rating').join(','));
  check('I-5 2v2 は「戦績だけ」と正しく書いている', stakeOf('team') === 'record', stakeOf('team'));
}

// ===========================================================================
// J. ギルド週間クエストの目標（実物の関数を通す）
// ===========================================================================
{
  const goalOf = typeof guilds.questGoalOf === 'function' ? guilds.questGoalOf : () => null;
  const def = { goal: 3000 };
  check('J-1 目標を縮める口がある', typeof guilds.questGoalOf === 'function', '');
  check('J-2 1人ギルドは 1/20 に縮む', goalOf(def, 1) === 150, String(goalOf(def, 1)));
  check('J-3 満員（20人）なら元の目標', goalOf(def, 20) === 3000, String(goalOf(def, 20)));
  check('J-4 上限を超えても増えない', goalOf(def, 99) === 3000, String(goalOf(def, 99)));
  check('J-5 0人や undefined でも1以上', goalOf(def, 0) >= 1 && goalOf({ goal: 1 }, 1) >= 1, '');
  check('J-6 人数は週の初めに固定する（途中で目標が動かない）',
    /size: Math\.max\(1, \(guild\.members \|\| \[\]\)\.length\),/.test(stripComments(read('server/guilds.js'))), '');
}

// ===========================================================================
// K. 押しても必ず失敗するボタン／閉じ口／打ち直し
// ===========================================================================
check('K-1 自分の記録が無いときは挑戦状を押させない',
  /boardData && boardData\.canChallenge === false/.test(friendsCli), '');
check('K-2 自分側の事情ではクールダウンを付けない',
  /if \(!mine\) challengeCooldown\.set\(id, Date\.now\(\) \+ 60000\);/.test(friendsCli), '');
check('K-3 日をまたいだ挑戦状は受けさせない', /const stale = !!f\.day && f\.day !== jstToday\(\);/.test(friendsCli), '');
check('K-4 追う点数を出す', /goal \? t\(`\$\{num\(goal\)\}点`/.test(friendsCli), '');
check('K-5 検索結果を消さない（断られたらボタンだけ戻す）',
  /b\.disabled = false;   \/\/ 断られた/.test(read('public/js/friends.js')), '');
check('K-6 勝ち上がりのモーダルに出口がある', /id="tqLeave2"/.test(modes), '');
check('K-7 閉じられないモーダルにも逃げ道を印付けする',
  /b\.setAttribute\('data-modal-dismiss', '1'\);/.test(dom), '');
check('K-8 その文言が「何をすればいいか」を言う', /下のボタンから選んでください/.test(dom), '');
check('K-9 走行中に設定へ行ける', /function ensureHudSettings\(\)/.test(mainJs)
  && /btnHudSettings: 'settings',/.test(mainJs), '');
check('K-10 その設定も走行の時計を止める',
  /const resume = pauseModeForDialog\(\);\s*\n\s*showSettingsModal\(\);/.test(mainJs), '');
// ⚠ 再開を onModalClosed にそのまま渡すと **盤面が覆われたまま再開する**。
//   フックは「次のモーダルに入れ替わったとき」にも流れる（showModal が先頭で
//   closeModal を呼ぶ）ので、設定の子（ジュークボックス・クレジット・改名…）
//   6本のどれを押しても、その瞬間に走行の時計が動き出していた。
//   モーダルが1枚も無くなるまで先送りすること。
check('K-10b 子ダイアログへ移っただけでは再開しない',
  /if \(root && root\.firstChild\) \{ onModalClosed\(later\); return; \}/.test(mainJs), '');
check('K-11 採掘場の天井に印が出る', /markCeiling\(\) \{/.test(modes) && /v\.dangerCells = cells\.size \? cells : null;/.test(modes), '');
check('K-12 キメラの置けない候補が分かる', /fits: this\.engine\.placements\(\{ cells: o\.cells \}\)\.length > 0/.test(modes), '');
check('K-13 ブースターをまとめて買える', /body: \{ itemId: item\.id, count: n \}/.test(screens), '');
check('K-14 セールの一覧が棚の先頭に出る', /function appendDealBanner\(grid\)/.test(screens), '');
check('K-15 ミッションをまとめて受け取れる', /id="msClaimAll"/.test(screens), '');
check('K-16 タブの往復で取り直さない', /if \(tab !== 'ach' && missionsCache && session\.user\) \{ renderMissions\(\); return; \}/.test(screens), '');
check('K-17 遊び方の印がチュートリアルで消えない',
  /dot\.classList\.toggle\('hidden', rulesSeen\(\)\);/.test(mainJs), '');
check('K-18 エフェクトは実物を撃って見せる', /ps\.burstCell\(84, 84, 84, 6, item\.id\);/.test(screens), '');
// ⚠ K-19/K-20 は実機で踏んだ形。renderPreview は grid.appendChild より**前**に
//   呼ばれるので、最初のフレームは canvas.isConnected が false のまま ──
//   そこで止めると**一度も描かれず真っ白**になる（テストでは見えない）。
//   「一度つながったあとに外れた」ときだけ止めること。
check('K-19 つながる前に止めない（真っ白にしない）',
  /if \(canvas\.isConnected\) \{[\s\S]{0,40}?if \(!seen\) \{ seen = true; until = now \+ 1600; \}/.test(screens), '');
check('K-20 棚から離れたら止める', /\} else if \(seen\) \{ stop\(\); return; \}/.test(screens), '');

for (const [mark, name, detail] of results) console.log(mark, name, detail ? `— ${detail}` : '');
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
