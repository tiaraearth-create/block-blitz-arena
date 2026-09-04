// リポジトリのルートから:  node test/zerofinish.test.mjs
//
// 👁️ 断罪 ── 走行の「終わりぎわ」と、枠の長さにまつわる回帰。
//
// zero-session.js は db もソケットも触らず deps で受け取る設計なので、
// 偽のソケットと偽の時計を渡して本物の tick を回せる。ソース検査ではなく
// **実際に断罪を飛ばして数える**ことで確かめる。
//
// ここで守りたいこと:
//   ① 走行を終えた人は的から降りる（結果画面・伝言モーダルの間も撃たれない）
//   ② 席を立った人の断罪は「落とした」に数えない（段が回復しない・住人が死なない）
//   ③ でも席は残す ── 伝言は席が生きている間しか送れない
//   ④ 次の走行では必ず的に戻る
//   ⑤ 取引は、20分より短い枠でもちゃんと開く
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';
import {
  createSession, tick, topOut, addHuman, finishHuman, aliveHumans, seatedHumans, COUNTDOWN,
} from '../server/zero-session.js';
import { REVIVE_SEC, DEAL_AT_SEC, DEAL_SEC } from '../server/zero.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// ソースは CRLF。'\n' を含む検索が空振りしないよう、読むときに正規化する。
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// ---- 足場（zero-session.test.mjs と同じ作り）--------------------------------

let CLOCK = 1_000_000;
const now = () => CLOCK;
let SEED = 12345;
const random = () => { SEED = (SEED * 1103515245 + 12345) % 2147483648; return SEED / 2147483648; };

const fakeSock = name => ({ _name: name, readyState: 1, OPEN: 1 });
const sockName = ws => ws._name;
let personaN = 0;
const deps = () => {
  const sent = [];
  const said = [];
  const stats = [];
  return {
    Engine, chooseMove, sockName, now, random,
    uuid: () => 'sess-' + (++personaN),
    pickResidentBot: (level, used) => {
      const n = `住人${++personaN}`;
      return used.has(n) ? null : { id: 'r' + personaN, name: n };
    },
    pickPersona: () => ({ name: `ゲスト${++personaN}` }),
    emit: (e, msg) => sent.push({ to: e.name, ...msg }),
    say: (kind, dan, ctx) => said.push({ kind, dan, ...ctx }),
    attack: () => {},
    onDanBroken: () => {},
    onStat: (name, key) => stats.push({ name, key }),
    sent, said, stats,
  };
};

const freshRun = () => ({ dan: 0, dealt: 0, sealDealt: 0, cuts: 0, fallen: [], broken: [] });

// 断罪が飛んでくるまで回して、その1本を返す（出なければ null）
const spinUntilVerdict = (s, run, d, limit = 400) => {
  for (let i = 0; i < limit; i++) {
    CLOCK += 250;
    tick(s, run, d);
    if (s.verdicts.length) return s.verdicts[0];
  }
  return null;
};

// 「段のHPが回復していない」の見かた。
// run.dealt は住人が削るぶんで**上がり続ける**ので、前後の値を比べても意味が
// 無い（実際それで通ってしまう）。回復は run.dealt を Math.max(0, ...) で
// **下げる**唯一の経路なので、回している間に一度でも下がったかどうかを見る。
const spinWatchingHeal = (s, run, d, ticks) => {
  let healed = false;
  let prev = run.dealt || 0;
  for (let i = 0; i < ticks; i++) {
    CLOCK += 250;
    tick(s, run, d);
    const cur = run.dealt || 0;
    if (cur < prev) healed = true;
    prev = cur;
  }
  return healed;
};

// ===========================================================================
// ① 走行を終えた人は的から降りる
//
// これが無かったとき: finish() は伝言を送るために席を残したまま結果画面へ
// 進む。サーバーからは「生きている人」に見えるので断罪が飛び続け、盤面を
// 触れない本人が必ず落とし、そのたびに段のHPが回復し、住人がその人の名前で
// 処刑され、断罪録に「落とした」が積まれていった。伝言モーダルは最長12秒
// 開いたままなので、予告3.5秒の段なら3回ぶん落ちる。
// ===========================================================================
{
  CLOCK = 2_000_000; SEED = 4242;
  const d = deps();
  const ws = fakeSock('終えた人');
  const s = createSession(d, [ws]);
  const run = freshRun();
  const me = s.entrants.find(e => e.human);

  const v = spinUntilVerdict(s, run, d);
  check('①-0(前提) 走行中は断罪が飛んでくる', !!v && v.target === '終えた人', v ? v.target : '飛ばなかった');

  // ここで走行が終わる（クライアントの finish() が zero_done を送る）
  const healBefore = run.dealt;
  const fallenBefore = run.fallen.length;
  finishHuman(s, ws);
  check('①-1 的から降りる', aliveHumans(s).length === 0, `${aliveHumans(s).length}人`);
  check('①-2 席は残る（伝言を送るため）', seatedHumans(s).length === 1, `${seatedHumans(s).length}席`);

  // 撃たれていた1本の予告時間を過ぎるまで回す
  const healed = spinWatchingHeal(s, run, d, 60);
  check('①-3 撃たれていた1本が「落とした」にならない', (me.missed || 0) === 0, `missed=${me.missed || 0}`);
  check('①-4 段のHPが回復しない', !healed, healed ? `${healBefore} から下がった` : '一度も下がらなかった');
  check('①-5 住人がその人の名前で処刑されない', run.fallen.length === fallenBefore,
    `${fallenBefore} → ${run.fallen.length}`);
  check('①-6 「落とした」の統計も付かない',
    !d.stats.some(x => x.name === '終えた人' && x.key === 'zeroMissed'), '');
  check('①-7 断罪録に「落とした」が残らない',
    !(run.log || []).some(x => x.kind === 'missed' && x.by === '終えた人'), '');

  // 結果画面にいる間ずっと（12秒どころか5分）撃たれ続けないこと
  const before = d.sent.filter(m => m.type === 'zero_verdict').length;
  for (let i = 0; i < 5 * 60 * 4; i++) { CLOCK += 250; tick(s, run, d); }
  check('①-8 そのあとも二度と撃たれない',
    d.sent.filter(m => m.type === 'zero_verdict').length === before, '');
  check('①-9 5分回しても「落とした」はゼロのまま', (me.missed || 0) === 0, `missed=${me.missed || 0}`);
}

// ===========================================================================
// ② 席を立った人（zero_leave 済み）の断罪も数えない
//
// zeroSeatOut は e.left を立てるので、以後 fireVerdicts は名指ししない。
// だが**撃ったあとに立った**場合、飛んでいる1本は残り、予告切れで「落とした」に
// なっていた。席がもう無いので e が見つからないことすらあり、そのときは
// e.missed も付かないまま段の回復と住人の処刑だけが起きていた。
// ===========================================================================
{
  CLOCK = 2_500_000; SEED = 606;
  const d = deps();
  const ws = fakeSock('立った人');
  const s = createSession(d, [ws]);
  const run = freshRun();
  const me = s.entrants.find(e => e.human);

  const v = spinUntilVerdict(s, run, d);
  check('②-0(前提) 断罪が飛んでいる', !!v, v ? v.target : 'なし');
  const healBefore = run.dealt;
  const fallenBefore = run.fallen.length;
  // zeroSeatOut と同じ状態にする
  me.alive = false; me.left = true;
  const healed2 = spinWatchingHeal(s, run, d, 60);
  check('②-1 席を立った人の断罪は「落とした」にならない', (me.missed || 0) === 0, `missed=${me.missed || 0}`);
  check('②-2 段のHPが回復しない', !healed2, healed2 ? `${healBefore} から下がった` : '一度も下がらなかった');
  check('②-3 住人が処刑されない', run.fallen.length === fallenBefore, `${fallenBefore} → ${run.fallen.length}`);
  check('②-4 飛んでいた断罪は片付く（溜まり続けない）', s.verdicts.length === 0, `${s.verdicts.length}本`);
}

// ===========================================================================
// ③ 見ていて斬らなかったときは、これまでどおり罰がある
//    （②の直しが効きすぎて「落とす」が消えていないこと）
// ===========================================================================
{
  CLOCK = 3_000_000; SEED = 31337;
  const d = deps();
  const s = createSession(d, [fakeSock('斬らない人')]);
  const run = freshRun();
  const me = s.entrants.find(e => e.human);
  const healed3 = spinWatchingHeal(s, run, d, 60 * 4);
  check('③-1 席に着いたまま斬らなければ「落とした」が付く', (me.missed || 0) > 0, `missed=${me.missed || 0}`);
  check('③-2 住人が処刑される', run.fallen.length > 0, `${run.fallen.length}人`);
  check('③-3 統計にも残る', d.stats.some(x => x.name === '斬らない人' && x.key === 'zeroMissed'), '');
  // ①-4／②-2 が「見張り方が壊れていて素通りしている」だけ、ということが
  // 無いように、回復する側もここで1回踏んでおく。
  check('③-4 このとき段のHPは実際に回復する（見張り方が効いている証拠）', healed3, '');
}

// ===========================================================================
// ④ トップアウトの60秒が走行の終わりをまたいでも、起こさない
//
// tick の復帰ループは downUntil を過ぎた席を alive に戻す。終えた印を見て
// いないと、結果画面にいる人が的に戻り、①の問題がそのまま再発する。
// ===========================================================================
{
  CLOCK = 4_000_000; SEED = 8888;
  const d = deps();
  const ws = fakeSock('詰んだ人');
  const s = createSession(d, [ws]);
  const run = freshRun();
  const me = s.entrants.find(e => e.human);
  for (let i = 0; i < 20; i++) { CLOCK += 250; tick(s, run, d); }   // カウントダウンを抜ける

  check('④-0(前提) トップアウトで倒れる', topOut(s, run, '詰んだ人', d, 'u1') && me.alive === false, '');
  check('④-0(前提) 復帰の予約が立つ', me.downUntil > CLOCK, '');
  finishHuman(s, ws);            // 復帰を待たずに走行が終わった
  const revivesBefore = d.sent.filter(m => m.type === 'zero_revive').length;
  for (let i = 0; i < (REVIVE_SEC + 20) * 4; i++) { CLOCK += 250; tick(s, run, d); }
  check('④-1 終えた席は起こさない', me.alive === false, `alive=${me.alive}`);
  check('④-2 復帰の通知も飛ばさない',
    d.sent.filter(m => m.type === 'zero_revive').length === revivesBefore, '');
  check('④-3 的にも戻らない', aliveHumans(s).length === 0, `${aliveHumans(s).length}人`);
}

// ===========================================================================
// ⑤ 次の走行では必ず的に戻る
//
// 終えた印を残したままにすると、新しい走行で断罪が一度も飛ばず、
// 斬るところが何も無いまま120秒が過ぎる（＝モードが成立しない）。
// ===========================================================================
{
  CLOCK = 5_000_000; SEED = 2468;
  const d = deps();
  const ws = fakeSock('もう一度の人');
  const s = createSession(d, [ws]);
  const run = freshRun();
  const me = s.entrants.find(e => e.human);
  for (let i = 0; i < 20; i++) { CLOCK += 250; tick(s, run, d); }

  finishHuman(s, ws);
  me.left = true;                       // zero_leave
  const ws2 = fakeSock('もう一度の人');  // 次の走行の新しいソケット
  const seat = addHuman(s, ws2, d, run);
  check('⑤-1 同じ席に座り直す', seat === me, '');
  check('⑤-2 終えた印が解ける', me.done === false, `done=${me.done}`);
  check('⑤-3 生き返っている', me.alive === true && me.left === false, '');
  const v = spinUntilVerdict(s, run, d);
  check('⑤-4 新しい走行でも断罪が飛んでくる', !!v && v.target === 'もう一度の人', v ? v.target : '飛ばなかった');
}

// ===========================================================================
// ⑥ 取引は、20分より短い枠でも開く
//
// 発火点は「枠の20分地点」の決め打ちだったが、1枠は管理画面で 10〜180分まで
// 動かせる（AE_MIN_DURATION / AE_MAX_DURATION）。20分より短い枠にすると、
// この地点に到達する前に枠が終わるので、取引は構造的に一度も開かなかった。
// ===========================================================================
{
  // --- 10分枠（下限）---
  CLOCK = 6_000_000; SEED = 1357;
  const d = deps();
  d.residentVoters = () => [];
  d.residentChoice = () => null;
  const s = createSession(d, [fakeSock('短い枠の人')]);
  const run = freshRun();
  run.dayKey = '2026-09-04';
  run.slotStartsAt = CLOCK;                 // いまが枠の開始
  run.slotEndsAt = CLOCK + 10 * 60 * 1000;  // 10分枠

  let openedAt = null;
  for (let i = 0; i < 10 * 60 * 4; i++) {
    CLOCK += 250;
    tick(s, run, d);
    if (run.deal && openedAt === null) openedAt = (CLOCK - run.slotStartsAt) / 1000;
  }
  check('⑥-1 10分枠でも取引が開く', !!run.deal, openedAt === null ? '開かなかった' : `${Math.round(openedAt)}秒地点`);
  check('⑥-2 投票の60秒が枠の中に収まる',
    !!run.deal && run.deal.closesAt <= run.slotEndsAt,
    run.deal ? `締切まで残り ${Math.round((run.slotEndsAt - run.deal.closesAt) / 1000)}秒` : '');
  check('⑥-3 枠の中で締め切られる', !!run.deal && run.deal.settled === true, '');

  // --- 30分枠（既定）── これまでと1秒も変えない ---
  CLOCK = 7_000_000; SEED = 1357;
  const d2 = deps();
  d2.residentVoters = () => [];
  d2.residentChoice = () => null;
  const s2 = createSession(d2, [fakeSock('既定の枠の人')]);
  const run2 = freshRun();
  run2.dayKey = '2026-09-04';
  run2.slotStartsAt = CLOCK;
  run2.slotEndsAt = CLOCK + 30 * 60 * 1000;

  let openedAt2 = null;
  for (let i = 0; i < 25 * 60 * 4; i++) {
    CLOCK += 250;
    tick(s2, run2, d2);
    if (run2.deal && openedAt2 === null) { openedAt2 = (CLOCK - run2.slotStartsAt) / 1000; break; }
  }
  check('⑥-4 既定の30分枠は これまでどおり20分地点',
    openedAt2 !== null && Math.abs(openedAt2 - DEAL_AT_SEC) <= 1,
    openedAt2 === null ? '開かなかった' : `${Math.round(openedAt2)}秒（期待 ${DEAL_AT_SEC}秒）`);

  // --- 枠の情報が無い run（古いデータ・テストからの直接呼び出し）---
  CLOCK = 8_000_000; SEED = 1357;
  const d3 = deps();
  d3.residentVoters = () => [];
  d3.residentChoice = () => null;
  const s3 = createSession(d3, [fakeSock('枠なしの人')]);
  const run3 = freshRun();
  run3.dayKey = '2026-09-04';
  let openedAt3 = null;
  for (let i = 0; i < 25 * 60 * 4; i++) {
    CLOCK += 250;
    tick(s3, run3, d3);
    if (run3.deal && openedAt3 === null) { openedAt3 = i / 4; break; }
  }
  check('⑥-5 枠の情報が無くても従来どおり動く', openedAt3 !== null,
    openedAt3 === null ? '開かなかった' : `${Math.round(openedAt3)}秒`);
}

// ===========================================================================
// ⑦ 配線 ── クライアントが送り、サーバーが受ける
// ===========================================================================
{
  const modes = read('public/js/modes.js');
  const battle = read('server/battle.js');
  const ae = read('server/adminevent.js');

  // ZeroMode の finish() を切り出す。`async finish() {` はどのモードにもある
  // ので、断罪にしか無い一行（取引パネルの片付け）を目印にして手前から拾う。
  const anchor = modes.indexOf("const dl0 = $('#zeroDeal');");
  const finStart = modes.lastIndexOf('async finish() {', anchor);
  const finBody = modes.slice(finStart, modes.indexOf('\n    const e = this.engine;', anchor));
  check('⑦-0(前提) ZeroMode の finish() を切り出せた', anchor > 0 && finStart > 0 && finBody.length > 100,
    `${finBody.length}文字`);
  const iDone = finBody.indexOf("type: 'zero_done'");
  const iWill = finBody.indexOf('await this.askWill()');
  const iLeave = finBody.indexOf("type: 'zero_leave'");
  check('⑦-1 走行の終わりに zero_done を送る', iDone >= 0, '');
  check('⑦-2 伝言を聞く前に送る（モーダルの間も撃たれない）', iDone >= 0 && iWill >= 0 && iDone < iWill,
    `done@${iDone} / will@${iWill}`);
  check('⑦-3 席を畳むのは伝言のあと', iWill >= 0 && iLeave >= 0 && iWill < iLeave,
    `will@${iWill} / leave@${iLeave}`);
  check('⑦-4 サーバーに受け口がある', /case 'zero_done': \{/.test(battle), '');
  // case の中身だけを取り出して見る。正規表現の [\s\S]{0,N} だと、すぐ下の
  // case 'zero_leave' の zeroSeatOut まで届いてしまい、否定の判定が嘘になる。
  const doneAt = battle.indexOf("case 'zero_done': {");
  const doneBody = doneAt < 0 ? '' : battle.slice(doneAt, battle.indexOf("case 'zero_leave'", doneAt));
  check('⑦-5 受け口は席から降ろすだけ', /zeroFinishHuman\(sess, ws\);/.test(doneBody), '');
  check('⑦-6 受け口は席を畳まない（zeroSeatOut を呼ばない）',
    doneBody.length > 20 && !/zeroSeatOut/.test(doneBody), `${doneBody.length}文字`);
  check('⑦-7 枠の終了時刻を run に持たせる', /run\.slotEndsAt = slot \? slot\.endsAt : occ\.closesAt;/.test(ae), '');
  check('⑦-8 作成時にも持たせる', /slotEndsAt: curSlot \? curSlot\.endsAt : occ\.closesAt,/.test(ae), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n👁️ 断罪 ── 走行の終わりぎわ  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
