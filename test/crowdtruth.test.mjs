// リポジトリのルートから:  node test/crowdtruth.test.mjs
//
// 🗣 住人の口が、板の上の事実と食い違っていないか。
//
// ■ なぜ要るのか
// このゲームの最強の制約は「住人が AI だと悟られないこと」。
// 速報・実績スロット・称号スロット・順位表では不変条件をきちんと止めてあるのに、
// **チャットの層だけ関門が無かった**。
//
// 実際に見つかった形（v2.82 で修正）:
//   ・深淵ダンジョンは住人が**構造的に入れない**（板から全員除外・記録は常に0・
//     塔は98階止まり＝百塔踏破バッジは永久に付かない。「頂は人間に残す」）。
//     ところが深淵の話題9本のうち6本が一人称の体験談で、うち1本は
//     **「塔100階クリアで解放された瞬間叫んだ」**と、絶対に持てない記録を名乗る。
//   ・会話劇にも「深淵クリアした」があった。
//   → 深淵を語る名前を控えて板と突き合わせるだけで、住人が確定する。
//
// ★ 本題は A-1（入れない場所を一人称で語らない）と B-1（言う数字が板に収まる）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS } from '../server/chatgen-content.js';
import { buildRoster, residentStats } from '../server/residents.js';
import * as A from '../server/ambient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};
const ja = l => (typeof l === 'string' ? l : (l && l.ja) || '');

// ===========================================================================
// A. ★住人が「行けない場所」を一人称で語らない
// ===========================================================================
const roster = buildRoster();
{
  // まず前提を確かめる ── 本当に入れないのか。
  let tower = 0, abyss = 0, badge = 0;
  for (const r of roster) {
    const st = residentStats(r);
    tower = Math.max(tower, st.dungeonMax || 0);
    abyss = Math.max(abyss, st.abyssMax || 0);
    if ((st.badges || []).includes('dungeon')) badge++;
  }
  check('A-0 前提: 住人は塔100階に届かない', tower < 100, `最高 ${tower}階`);
  check('A-0b 前提: 住人の深淵の記録は常に0', abyss === 0, `最高 ${abyss}`);
  check('A-0c 前提: 百塔踏破バッジを持つ住人が居ない', badge === 0, `${badge}人`);

  // ★本題。深淵の話題に「やった／行った」と読める一人称が混ざっていないか。
  //   質問・伝聞・憧れなら、行ったことが無くても自然に話せる。
  const DID = /(?:した|してきた|できた|見つけた|叫んだ|帰ってきた|到達|クリア)(?:$|[、。！!？?\s])/;
  const guilty = TOPICS.abyss.filter(l => DID.test(ja(l))).map(ja);
  check('A-1 ★深淵を一人称で語っていない', guilty.length === 0, guilty.join(' / '));

  // いちばん強い嘘 ── 絶対に持てない記録を名乗る。
  const claim = TOPICS.abyss.filter(l => /塔100階(?:を)?クリアした|100階.*解放された瞬間/.test(ja(l))).map(ja);
  check('A-2 ★持てない記録（塔100階クリア）を名乗っていない', claim.length === 0, claim.join(' / '));

  // 話題そのものは残す（消すと「誰も触れないモード」になる）。
  check('A-3 深淵の話題は残っている（消してはいない）', TOPICS.abyss.length >= 8, `${TOPICS.abyss.length}本`);
}
{
  // 会話劇にも同じ関門をかける。
  const crowd = src('server/crowd.js');
  check('A-4 ★会話劇に「深淵クリアした」が無い',
    !crowd.includes('深淵クリアした'), '');
  check('A-5 差し替え先は住人が本当に持てる記録',
    crowd.includes('地下100階クリアした'), '');
}

// ===========================================================================
// B. ★チャットで言う数字が、板に出る数字と食い違わない
// ===========================================================================
{
  A.setLiveScale(1);
  const range = (board, key) => {
    const rs = A.ghostRows(board, 'W2954', [], Date.now()).map(r => r[key]);
    return [Math.min(...rs), Math.max(...rs)];
  };
  // {depth} は塔の進みから作る（採掘場だけが使う）。crowd.js の式と同じ。
  //
  // ⚠ 見るのは**上限だけ**。板は上位N行しか出さないので、チャットで低い数字を
  //   言うのは何の手がかりにもならない（板に載っていない人はいくらでも居る）。
  //   危ないのは逆で、**板の1位より大きい数字を言う**こと ── その名前を板で
  //   探しても居ない、が確定する。ここを両側で見ると、実装が正しくても
  //   下限で赤くなる（実際に一度そうなった）。
  let hi = -Infinity;
  for (const r of roster) {
    const d = residentStats(r).dungeonMax || 8;
    hi = Math.max(hi, Math.max(3, Math.round(d * 0.75) + 3));
  }
  const [, dHi] = range('dig', 'digDepth');
  check('B-1 ★採掘で言う深度が板の1位を超えない',
    hi <= dHi, `チャットの最大 ${hi} / 板の1位 ${dHi}`);

  // ⚠ ボスラッシュの板は上限12。{depth}（70台）を使うと桁が違う。
  //   residentStats は rushDepth を持たないので正しい数字は作れない ──
  //   だからラッシュの台詞は**数字を言わない**形にしてある。
  const [rLo, rHi] = range('rush', 'rushDepth');
  const rushLines = TOPICS.rush.map(ja).filter(t => /\{depth\}|\{rushdepth\}/.test(t));
  check('B-2 ★ラッシュの台詞が深度の数字を言っていない',
    rushLines.length === 0, `板は ${rLo}〜${rHi} / ${rushLines.join(' / ')}`);
}
{
  // 使っていないスロットを残さない（残すと次の人が「使える」と思って使う）。
  const crowd = src('server/crowd.js');
  const slots = [...crowd.matchAll(/case '(\w+)':/g)].map(m => m[1]);
  const used = new Set();
  for (const list of Object.values(TOPICS)) {
    for (const l of list) for (const m of ja(l).matchAll(/\{(\w+)\}/g)) used.add(m[1]);
  }
  // crowd.js の case は差し込み以外にも使われるので、差し込み用の名前だけ見る。
  const fillOnly = ['depth', 'stage', 'floor', 'rushdepth'];
  const dead = fillOnly.filter(k => slots.includes(k) && !used.has(k));
  check('B-3 使われていない差し込みスロットが残っていない', dead.length === 0, dead.join(','));
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
