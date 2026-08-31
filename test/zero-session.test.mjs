// Run from the repo root:  node test/zero-session.test.mjs
//
// 👁️ 断罪 のセッション（アリーナ1部屋ぶんの進行）を、サーバーを立てずに検証する。
//
// server/zero-session.js は db もソケットも直接触らず、必要なものを deps で
// 受け取る形にしてある。おかげで偽のソケットと偽の時計を渡して、
// 30分ぶんの進行を数十ミリ秒で回せる。
//
// ここで守りたいのは、この設計が壊れていないこと:
//   * 点だけでは段が絶対に落ちない（住人が何点入れても封印は割れない）
//   * 人間が斬らないと何も起きない
//   * 住人の処刑に上限があり、席が空になるまで消えない
//   * 段は世界で1本（枠をまたいで引き継がれる）
import { Engine } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';
import {
  createSession, tick, submitCut, topOut, stateView, aliveHumans, liveBots, COUNTDOWN,
  submitStake, submitDealVote, dealView,
} from '../server/zero-session.js';
import {
  DAN, danHpFor, sealHpFor, softCapFor, cutDamageFor, EXECUTIONS_PER_SLOT, MIN_BOT_SEATS,
  DEAL_AT_SEC, DEAL_SEC, HUMAN_VOTE_WEIGHT, dealForDay,
} from '../server/zero.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---- 足場 ------------------------------------------------------------------

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
    sent, said,
  };
};

const freshRun = () => ({ dan: 0, dealt: 0, sealDealt: 0, cuts: 0, fallen: [], broken: [] });

// ---- 席 --------------------------------------------------------------------
{
  const d = deps();
  const s = createSession(d, [fakeSock('ひとり')]);
  check('ソロでも席が埋まる', s.entrants.length >= 12, `${s.entrants.length}席`);
  check('人間は1人', s.entrants.filter(e => e.human).length === 1, '');
  check('残りは全部住人', liveBots(s).length === s.entrants.length - 1, `${liveBots(s).length}体`);
  check('住人は本物の盤面を持っている', liveBots(s).every(e => e.engine && typeof e.engine.place === 'function'), '');
  check('ゼロも盤面を持っている', !!(s.zero.engine && s.zero.engine.snapshot), '');
  check('名前が重複しない', new Set(s.entrants.map(e => e.name)).size === s.entrants.length, '');

  const many = createSession(deps(), Array.from({ length: 30 }, (_, i) => fakeSock('人' + i)));
  check('人が多くても住人の席が残る', liveBots(many).length >= MIN_BOT_SEATS, `${liveBots(many).length}体`);
  check('席は24を超えない', many.entrants.length <= 24, `${many.entrants.length}席`);
}

// ---- 核: 点だけでは段が落ちない --------------------------------------------
{
  CLOCK = 1_000_000; SEED = 999;
  const d = deps();
  const s = createSession(d, [fakeSock('斬らない人')]);
  const run = freshRun();
  // 30分ぶん、住人に打たせるだけ（人間は一度も斬らない）
  for (let i = 0; i < 30 * 60 * 4; i++) { CLOCK += 250; tick(s, run, d); }

  const soft = softCapFor(0, 1);
  check('住人の火力だけで7割は削れる', run.dealt >= soft * 0.99, `${Math.round(run.dealt)}/${soft}`);
  check('しかし7割を超えては削れない', run.dealt <= soft + 0.5, `${Math.round(run.dealt)} ≤ ${soft}`);
  // ここがこの設計の全部
  check('★ 斬らなければ段は絶対に落ちない', run.dan === 0, `段${run.dan + 1}`);
  check('封印は1ミリも減っていない', (run.sealDealt || 0) === 0, `${run.sealDealt}`);
  check('30分で断罪は撃たれている', d.sent.some(m => m.type === 'zero_verdict'), '');
}

// ---- 斬れば割れる ----------------------------------------------------------
{
  CLOCK = 2_000_000; SEED = 4242;
  const d = deps();
  const s = createSession(d, [fakeSock('斬る人')]);
  const run = freshRun();
  let cut = 0, refused = 0;

  for (let i = 0; i < 30 * 60 * 4; i++) {
    CLOCK += 250;
    tick(s, run, d);
    // 自分に来た断罪を必ず斬る
    for (const v of s.verdicts.slice()) {
      if (v.target !== '斬る人' || v.resolved) continue;
      const r = submitCut(s, run, '斬る人', v.id, v.cells, d);
      if (r.ok) cut++; else refused++;
    }
  }
  check('斬った回数が記録される', cut > 10, `${cut}回`);
  check('斬れば封印が減る', (run.sealDealt || 0) > 0 || run.dan > 0, `sealDealt=${run.sealDealt} dan=${run.dan}`);
  check('★ 斬れば段が落ちる', run.dan >= 1, `段${run.dan}まで`);
  check('段が割れた記録が残る', run.broken.length >= 1, JSON.stringify(run.broken[0] || null));
  check('とどめを刺した人が記録される', run.broken[0] && run.broken[0].by === '斬る人', run.broken[0] && run.broken[0].by);
}

// ---- カットの受付 ----------------------------------------------------------
{
  CLOCK = 3_000_000; SEED = 77;
  const d = deps();
  const s = createSession(d, [fakeSock('A'), fakeSock('B')]);
  const run = freshRun();
  // 断罪は予告時間(3.5秒)を過ぎると「落とした」として片付けられ、一覧から
  // 消える。回しきってから見ると必ず空なので、出た瞬間を捕まえる。
  let v = null;
  for (let i = 0; i < 400 && !v; i++) { CLOCK += 250; tick(s, run, d); v = s.verdicts[0] || null; }
  if (!v) { check('断罪が出る', false, '出なかった'); }
  else {
    check('断罪が出る', true, `${v.target} に ${v.cells.length}マス`);
    check('他人の断罪は斬れない',
      !submitCut(s, run, v.target === 'A' ? 'B' : 'A', v.id, v.cells, d).ok, '');
    check('赤マスを外すと通らない',
      !submitCut(s, run, v.target, v.id, [999], d).ok, '');
    const ok = submitCut(s, run, v.target, v.id, v.cells, d);
    check('正しく斬れば通る', ok.ok, `${ok.damage}ダメージ`);
    check('同じ断罪は二度斬れない', !submitCut(s, run, v.target, v.id, v.cells, d).ok, '');
  }
}

// ---- 処刑 ------------------------------------------------------------------
{
  CLOCK = 4_000_000; SEED = 31337;
  const d = deps();
  const s = createSession(d, [fakeSock('落とす人')]);
  const run = freshRun();
  // 一度も斬らずに回すと、断罪が落ち続けて住人が処刑される
  for (let i = 0; i < 30 * 60 * 4; i++) { CLOCK += 250; tick(s, run, d); }
  check('落とすと住人が処刑される', run.fallen.length > 0, `${run.fallen.length}人`);
  check('1枠の処刑に上限がある', run.fallen.length <= EXECUTIONS_PER_SLOT, `${run.fallen.length} ≤ ${EXECUTIONS_PER_SLOT}`);
  check('席が空になるまで消さない', liveBots(s).length >= MIN_BOT_SEATS, `${liveBots(s).length}体`);
  check('処刑された住人の名前が残る', run.fallen.every(f => f.name), JSON.stringify(run.fallen.map(f => f.name)));
  check('ゼロが処刑を口に出す', d.said.some(x => x.kind === 'missed'), '');
}

// ---- 段は世界で1本（枠をまたぐ）--------------------------------------------
{
  CLOCK = 5_000_000; SEED = 5150;
  const run = freshRun();
  // 1枠目: 斬って段を進める
  const d1 = deps();
  const s1 = createSession(d1, [fakeSock('18時の人')]);
  for (let i = 0; i < 30 * 60 * 4; i++) {
    CLOCK += 250; tick(s1, run, d1);
    for (const v of s1.verdicts.slice()) if (!v.resolved) submitCut(s1, run, v.target, v.id, v.cells, d1);
  }
  const after1 = run.dan;
  check('1枠目で段が進む', after1 >= 1, `段${after1}まで`);

  // 2枠目: 別の部屋、同じ run
  const d2 = deps();
  const s2 = createSession(d2, [fakeSock('21時の人')]);
  const view = stateView(s2, run);
  check('★ 次の枠は続きから始まる', view.dan === after1 + 1, `段${view.dan}から`);
  check('処刑された住人が引き継がれる', view.fallen.length === run.fallen.length, `${view.fallen.length}人`);
  check('段が進むと重くなる', danHpFor(after1, 1) > danHpFor(0, 1), '');
}

// ---- 画面に送る形 ----------------------------------------------------------
{
  CLOCK = 6_000_000; SEED = 8080;
  const d = deps();
  const s = createSession(d, [fakeSock('見る人')]);
  const run = freshRun();
  for (let i = 0; i < 100; i++) { CLOCK += 250; tick(s, run, d); }
  const v = stateView(s, run);
  check('段の情報が入る', v.dan === 1 && v.danMax === 7, `${v.dan}/${v.danMax}`);
  check('封印の残りが入る', typeof v.sealLeft === 'number' && v.sealLeft > 0, `${v.sealLeft}`);
  check('ゼロの盤面が入る', Array.isArray(v.zeroGrid) && v.zeroGrid.length === 64, `${v.zeroGrid && v.zeroGrid.length}マス`);
  check('席の一覧が入る', v.seats.length === s.entrants.length, `${v.seats.length}席`);
  check('「今夜の的」の列が入る', v.targetCol >= 0 && v.targetCol < 8, `第${v.targetCol}列`);
  check('残りHPが全体を超えない', v.left <= v.hp && v.left >= 0, `${v.left}/${v.hp}`);
  check('状態が1秒ごとに配信される', d.sent.some(m => m.type === 'zero_state'), '');
}

// ---- トップアウト ----------------------------------------------------------
{
  CLOCK = 7_000_000; SEED = 606;
  const d = deps();
  const s = createSession(d, [fakeSock('詰む人')]);
  const run = freshRun();
  for (let i = 0; i < 60; i++) { CLOCK += 250; tick(s, run, d); }
  run.dealt = 50_000;
  check('トップアウトできる', topOut(s, run, '詰む人', d), '');
  check('落ちると段が少し回復する', run.dealt < 50_000, `50000→${Math.round(run.dealt)}`);
  check('落ちている間は名指しされない', aliveHumans(s).length === 0, '');
  check('二重には落ちない', !topOut(s, run, '詰む人', d), '');
  // 60秒後に自動復帰
  CLOCK += 61_000; tick(s, run, d);
  check('60秒で自動復帰する', aliveHumans(s).length === 1, '');
  check('復帰が通知される', d.sent.some(m => m.type === 'zero_revive'), '');
}

// ---- 🪧 杭（盤面の中の選択）------------------------------------------------
{
  CLOCK = 8_000_000; SEED = 1212;
  const d = deps();
  const sess = createSession(d, [fakeSock('杭を打つ人')]);
  const run = freshRun();
  for (let i = 0; i < 60; i++) { CLOCK += 250; tick(sess, run, d); }
  const mark = sess.targetCol;
  check('今夜の的の列が決まっている', mark >= 0 && mark < 8, `第${mark}列`);
  check('違う列を縦に消しても杭は入らない',
    !submitStake(sess, run, '杭を打つ人', [(mark + 1) % 8], d).ok, '');
  const a = submitStake(sess, run, '杭を打つ人', [mark], d);
  check('的の列を縦に消すと杭が入る', a.ok && !a.ready, `${sess.stakes2}本`);
  submitStake(sess, run, '杭を打つ人', [mark], d);
  const c = submitStake(sess, run, '杭を打つ人', [mark], d);
  check('3本たまると予告が伸びる', c.ready && sess.warnBonus > 0, `+${sess.warnBonus}ms`);
  check('たまったら数え直す', sess.stakes2 === 0, `${sess.stakes2}`);
}

// ---- 🤝 取引 --------------------------------------------------------------
{
  CLOCK = 9_000_000; SEED = 3434;
  const d = deps();
  // 住人が本当に投票する。polls.js の仕掛けをそのまま渡す。
  const voters = Array.from({ length: 14 }, (_, i) => ({ id: 'rv' + i, name: '住民' + i, arch: 'casual', lang: 'ja' }));
  d.residentVoters = () => voters;
  d.residentChoice = (poll, r) => (Number(r.id.slice(2)) % 3 === 0 ? 'yes' : 'no');
  const sess = createSession(d, [fakeSock('決める人')]);
  const run = freshRun();
  run.dayKey = '2026-08-29';

  // 20分地点まで進める
  const need = Math.ceil((DEAL_AT_SEC + COUNTDOWN + 2) * 4);
  for (let i = 0; i < need; i++) { CLOCK += 250; tick(sess, run, d); }
  check('20分で取引が始まる', !!run.deal, run.deal ? run.deal.dealId : 'なし');
  check('取引がプレイヤーに届く', d.sent.some(m => m.type === 'zero_deal'), '');
  check('ゼロが取引を持ちかける', d.said.some(x => x.kind === 'deal'), '');

  if (run.deal) {
    const v = dealView(run.deal);
    check('2択で出る', v.options.length === 2, v.options.map(o => o.id).join('/'));
    check('日英そろっている', !!(v.q && v.qEn), '');
    // 人間の1票は住人5票ぶん
    const r1 = submitDealVote(run, 'u1', 'yes');
    check('人間が投票できる', r1.ok, JSON.stringify(r1.tally));
    check('人間の1票は住人5票ぶん', r1.tally.yes >= HUMAN_VOTE_WEIGHT, `yes=${r1.tally.yes}`);
    check('二度は投票できない', !submitDealVote(run, 'u1', 'no').ok, '');
    check('でたらめな選択は通らない', !submitDealVote(run, 'u2', 'maybe').ok, '');

    // 締切まで進める（住人が投票していく）
    for (let i = 0; i < DEAL_SEC * 4 + 8; i++) { CLOCK += 250; tick(sess, run, d); }
    check('締切で決着する', run.deal.settled, '');
    check('住人が実際に投票した', Object.keys(run.deal.residentVoted).length > 0,
      `${Object.keys(run.deal.residentVoted).length}人`);
    check('結果が届く', d.sent.some(m => m.type === 'zero_deal_done'), '');
    check('締切後は投票できない', !submitDealVote(run, 'u9', 'yes').ok, '');

    // 「飲む」が通っていれば効果が乗る
    const applied = run.dealHalve || run.dealRevive || run.dealMarkAll;
    const win = d.sent.filter(m => m.type === 'zero_deal_done').pop();
    check('飲めば効果が乗り、断れば乗らない',
      win && (win.win === 'yes' ? !!applied : !applied), win ? win.win : '?');
  }
}

// ---- 取引でHPが半分になる ---------------------------------------------------
{
  const base = danHpFor(0, 1, null);
  const halved = danHpFor(0, 1, { dealHalve: true });
  check('取引でHPが半分になる', halved === Math.round(base / 2), `${base}→${halved}`);
  const seal = sealHpFor(0, 1, null);
  const bigger = sealHpFor(0, 1, { dealSeal: 0.40 });
  check('取引で封印が4割に上がる', bigger > seal, `${seal}→${bigger}`);
  check('でたらめな割合は無視される', sealHpFor(0, 1, { dealSeal: 9 }) === seal, '');
}


// ---- 🔌 段の重さは「部屋」ではなく「その回の申込人数」で決まる -------------
//
// 回帰対象: 段の閾値（softCap / seal）を s.humans（いま部屋にいる人数）から
// 取っていたため、進捗（run.dealt / run.sealDealt は日単位で持ち越す絶対値）は
// そのままなのに閾値だけが縮み、大人数で貯めたあと1人が入り直すと**誰も1手も
// 打たないまま段が割れて**、その人が「とどめ」の欠片とバッジを持っていった。
// 全員退室→再入場で意図的にも再現できた。
{
  CLOCK = 9_000_000; SEED = 4242;
  // 6人が申し込んだ回。閾値は申込人数で決まるので、部屋の人数には左右されない。
  const run = { ...freshRun(), entrants: 6 };
  const softCap6 = softCapFor(0, 6);
  const seal6 = sealHpFor(0, 6);

  // 6人ぶんの目標の「ほぼ手前」まで進めた状態を作る（陥落条件は未達）。
  run.dealt = softCap6;
  run.sealDealt = Math.floor(seal6 * 0.6);

  // 全員が抜けて部屋が消え、次に1人だけが入り直す＝作り直された新しい部屋。
  const d = deps();
  const s1 = createSession(d, [fakeSock('入り直した人')]);
  check('作り直した部屋は1人から始まる', s1.humans === 1, `${s1.humans}人`);

  const view = stateView(s1, run);
  check('★ 部屋を作り直しても段の重さが縮まない',
    view.hp === danHpFor(0, 6) && view.seal === seal6,
    `hp ${view.hp} / 6人基準 ${danHpFor(0, 6)}`);

  // カウントダウンぶんも含めて回し、無プレイのまま段が割れないことを見る。
  const danBefore = run.dan;
  for (let i = 0; i < 4 * 20; i++) { CLOCK += 250; tick(s1, run, d); }
  check('★ 誰も斬っていないのに段が割れることはない',
    run.dan === danBefore, `段${run.dan}（開始時 ${danBefore}）`);
  check('とどめの記録が勝手に増えない', run.broken.length === 0, `${run.broken.length}件`);

  // 申込が増えれば目標は重くなるが、削った量は保たれる（巻き戻さない）。
  const dealtBefore = run.dealt;
  run.entrants = 10;
  const view10 = stateView(s1, run);
  check('申込が増えたら目標も重くなる', view10.hp === danHpFor(0, 10), `hp ${view10.hp}`);
  check('削った量は巻き戻らない', run.dealt === dealtBefore, `${run.dealt}`);

  // 部屋の人数が段の重さに影響しないこと（申込人数だけが効く）を直接確かめる。
  const d2 = deps();
  const s3 = createSession(d2, [fakeSock('A'), fakeSock('B'), fakeSock('C')]);
  const viewRoom3 = stateView(s3, { ...freshRun(), entrants: 6 });
  const viewRoom1 = stateView(s1, { ...freshRun(), entrants: 6 });
  check('★ 同じ申込人数なら部屋の人数が違っても目標は同じ',
    viewRoom3.hp === viewRoom1.hp, `${viewRoom3.hp} vs ${viewRoom1.hp}`);

  // stateView は「画面に送る形を作るだけ」で、共有される run を書き換えない。
  const snapshot = JSON.stringify(run);
  stateView(s1, run);
  check('stateView は run を書き換えない', JSON.stringify(run) === snapshot, '');
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
