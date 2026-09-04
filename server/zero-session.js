// 👁️ 断罪 ── セッション（アリーナ1部屋ぶんの進行）
//
// server/zero.js が「計算と台詞」だけを持つのに対して、こちらは
// 「いま部屋で何が起きているか」を持つ。ただし **db もソケットも直接は
// 触らない** —— 必要なものは全部 deps で受け取る。
//
// なぜ battle.js の中に書かなかったか:
// battle.js は initBattle という 2,300 行の単一クロージャで、send も
// broadcastAll も matches も全部その中のスコープにある。素直に書き足すと
// 2,800 行になり、断罪の進行だけを試すことができなくなる。
// deps で受け取る形にしておけば、偽のソケットを渡して進行そのものを
// テストできる（test/zero-session.test.mjs がそうしている）。
//
// ■ 段は世界で1本
// 段・封印・処刑された住人は db.meta.adminEventRun に入っていて、
// 18:00 の枠で段2まで割れば 19:00 の人は段3から始める。足し算ではなく直列。
// セッション（この部屋）は枠の間だけのメモリで、再デプロイされても
// 進行は1ミリも失われない（ゼロの盤面だけ引き直して再開する）。

import {
  DAN, danAt, danHpFor, sealHpFor, softCapFor, cutDamageFor,
  seatsFor, lanesFor, moodFor, pickVerdictCells, verdictAccepts,
  MIN_BOT_SEATS, REVIVE_SEC, EXECUTIONS_PER_SLOT, EXECUTIONS_PER_DAY, SIZE,
  MISS_HEAL, TOPOUT_HEAL, SEATS_MAX, missHealFor,
  GRID_FRESH_MS, HUMAN_DPM_CAP, HUMAN_BUDGET_MAX_SEC,
  makeDeal, dealTally, dealWinner, clearDealEffects, dealForDay,
  DEAL_AT_SEC, DEAL_SEC, HUMAN_VOTE_WEIGHT,
} from './zero.js';

export const ZERO_TICK = 250;
export const COUNTDOWN = 3;

// 席の構成。sim-zero.mjs で実測した火力に合わせてある。
export const SEAT_MIX = [
  { level: 'easy',   weight: 3, moveEvery: 2000 },
  { level: 'normal', weight: 4, moveEvery: 1700 },
  { level: 'hard',   weight: 3, moveEvery: 1350 },
  { level: 'oni',    weight: 1, moveEvery: 1150 },
];

function seatPlan(botSeats) {
  const total = SEAT_MIX.reduce((a, c) => a + c.weight, 0);
  const out = [];
  for (const cfg of SEAT_MIX) {
    const n = Math.round(botSeats * (cfg.weight / total));
    for (let i = 0; i < n; i++) out.push(cfg);
  }
  while (out.length < botSeats) out.push(SEAT_MIX[1]);
  return out.slice(0, botSeats);
}

// ---------------------------------------------------------------------------
// セッション
// ---------------------------------------------------------------------------

// 開幕の宣言を読み上げてよい間隔。
//
// なぜ「セッションに1回」ではないか: クライアントの1走行は120秒で、走行ごとに
// zero_leave → zero_join が飛んでセッションが作り直される。セッション側の
// フラグでは、ソロの人が枠の間ずっと2分おきに開幕宣言を浴びることになる。
// 世界で1本の run に「最後に読み上げた時刻」を持ち、この時間だけは黙る。
// （枠は既定30分。部屋が枠ごとに1つなら、実際に流れるのは枠の頭の1回だけ）
export const OPEN_COOLDOWN_MS = 15 * 60 * 1000;

// 開幕（複数人）と solo（実プレイヤーが1人）の宣言。
// ZERO_LINES には日英4行×3態度で用意されていたのに、どの kind からも
// 呼ばれておらず、管理者の動作確認API以外では一度も表に出ていなかった。
// open と solo で別のガードを持つ（片方が鳴っても、もう片方は鳴れる）。
function sayOpening(s, run, deps, t) {
  const { say } = deps;
  if (!say || !run) return null;
  const humans = seatedHumans(s).length;
  const kind = humans <= 1 ? 'solo' : 'open';
  const key = kind === 'solo' ? 'soloSaidAt' : 'openSaidAt';
  if (t - (run[key] || 0) < OPEN_COOLDOWN_MS) return null;
  run[key] = t;
  // {n} は「ここまでに返した王座の数」＝割れた段の数。
  say(kind, Math.min(DAN.length - 1, run.dan | 0), { n: run.dan | 0, seed: t });
  return kind;
}

export function createSession(deps, humanSocks, run = null) {
  const {
    Engine, chooseMove, pickResidentBot, pickPersona, sockName,
    now = () => Date.now(), random = Math.random, uuid,
  } = deps;

  // 席は人間も含めて上限24。住人の席も必ず MIN_BOT_SEATS 残す。
  // あふれた人は次の枠へ（呼び出し側が案内する）。
  const seated = humanSocks.slice(0, SEATS_MAX - MIN_BOT_SEATS);
  const humans = seated.length;
  const seats = seatsFor(humans);
  const botSeats = Math.max(MIN_BOT_SEATS, seats - humans);
  const seed = Math.floor(random() * 2 ** 31);
  const used = new Set(seated.map(sockName));
  // その日すでに処刑された住人は抽選から外す（説明文「その日はもう戻ってきません」）。
  // run を渡さない旧テスト等では従来どおり（除外なし）。
  if (run && Array.isArray(run.fallen)) for (const f of run.fallen) if (f && f.name) used.add(f.name);

  const entrants = seated.map(ws => ({
    ws, human: true, name: sockName(ws), score: 0, cuts: 0, missed: 0,
    alive: true, downUntil: 0, lastSeen: now(),
    // 盤面同期（zero_state）。届くまでは null ＝「サーバーは盤面を知らない」。
    grid: null, gridAt: 0, gridPrev: null, gridPrevAt: 0,
    syncScore: null, syncAt: 0, dealt: 0,
  }));

  const plan = seatPlan(botSeats);
  for (let i = 0; i < plan.length; i++) {
    const seat = plan[i];
    const res = random() < 0.7 ? pickResidentBot(seat.level, used) : null;
    const name = res ? res.name : pickPersona({ used }).name;
    used.add(name);
    entrants.push({
      human: false, name, level: seat.level, residentId: res ? res.id : null,
      engine: new Engine((seed + i * 7919) >>> 0),
      moveEvery: seat.moveEvery,
      nextMoveAt: now() + COUNTDOWN * 1000 + random() * seat.moveEvery,
      score: 0, alive: true, executed: false,
    });
  }

  // ゼロ自身も盤面を持って本当に打つ。HPバーではないことの実体。
  const zeroEngine = new Engine((seed + 104729) >>> 0);

  const s = {
    id: uuid(),
    overflow: humanSocks.slice(seated.length),
    entrants,
    startedAt: now(),
    ended: false,
    seed,
    // 人数。あとから合流した人のぶんは addHuman が足す。**抜けても下げない**
    // （理由は addHuman / zeroSeatOut の注記）。
    humans,
    zero: { engine: zeroEngine, nextMoveAt: now() + COUNTDOWN * 1000, score: 0, lines: 0 },
    verdicts: [],          // 進行中の断罪
    nextVerdictAt: now() + COUNTDOWN * 1000 + 25_000,
    lastState: 0,
    targetCol: Math.floor(random() * SIZE),
    stakes: [],            // このセッションで割れた段（枠の終わりに精算）
  };
  // 部屋ができた＝枠が開いた。ここが open / solo の唯一の発火点。
  sayOpening(s, run, deps, now());
  return s;
}

// 席の再計算。人が増えたぶんだけ住人の席を減らす（**増やしはしない**）。
// 処刑済みの住人は席に残す ── 「その日はもう戻ってきません」を画面で見せる
// のがこのモードの見せ場なので、ここで消してはいけない。
function rebalanceBots(s) {
  const humans = Math.max(1, seatedHumans(s).length);
  const want = Math.max(MIN_BOT_SEATS, seatsFor(humans) - humans);
  let drop = liveBots(s).length - want;
  if (drop <= 0) return 0;
  let removed = 0;
  // あとから座った住人（配列の後ろ）から退席させる。
  for (let i = s.entrants.length - 1; i >= 0 && drop > 0; i--) {
    const e = s.entrants[i];
    if (e.human || e.executed) continue;
    s.entrants.splice(i, 1);
    drop--; removed++;
  }
  return removed;
}

// 途中合流。
//
// createSession は最初から複数人を受け取れる設計（seated / seats / botSeats を
// humanSocks.length から計算している）だったのに、あとから席を1つ増やす道が
// 無かった。そのため呼び出し側は毎回 1 ソケットで新しい部屋を作るしかなく、
// s.humans が恒久的に 1 になっていた ── 人数ぶんHPを重くする補正も、
// 回復量を断罪の本数で割る補正も、満席案内も、全部死んでいた。
//
// 返り値: 座れた席（entrant）／満席なら false（呼び出し側が案内を出す）
export function addHuman(s, ws, deps, run = null) {
  const { sockName, now = () => Date.now() } = deps;
  if (!s || s.ended || !ws) return false;
  const name = sockName(ws);

  // 同じソケット、または同じ名前の席が既にあるなら座り直す。走行のたびに
  // zero_leave → zero_join が来るので、実際にはこれが通常の経路になる。
  const seat = s.entrants.find(e => e.human && (e.ws === ws || e.name === name));
  if (seat) {
    // 席を外していた人が戻ってきた＝**新しい走行の始まり**（走行のたびに
    // zero_leave → zero_join が来る）。ここを見分けてから left を倒す。
    const rejoining = !!seat.left;
    seat.ws = ws;
    seat.left = false;
    // 前の走行の「終わった」印は必ず解く。残すと新しい走行で断罪が
    // 一度も飛ばず、斬るところが何も無いまま2分が過ぎる。
    seat.done = false;
    if (rejoining) {
      // 🪦 前の走行のダウンは持ち越さない。
      //    持ち越すと、新しい走行の**途中**で tick の復帰（zero_revive）が飛び、
      //    クライアントが reviveBoard() を走らせて盤面が全消しされる。しかも
      //    それまでの席は alive:false なので applyHumanScore が 0 を返し、
      //    その走行の点は段のHPに1ミリも入らない ── 何もしていないのに
      //    盤面が消えて「復帰しました」とだけ出る、という形で見えていた。
      //    連発の抑止は run.topoutAt（ユーザー単位・60秒）が別に持っているので、
      //    ここを戻しても回復を稼がれることはない。
      seat.downUntil = 0;
      seat.alive = true;
    } else if (!seat.downUntil) {
      // 同じ走行の中での座り直し（再接続）。トップアウトで落ちている最中の人は
      // そのまま（60秒の上限を回避させない）。復帰は tick が downUntil を見る。
      seat.alive = true;
    }
    seat.lastSeen = now();
    s.lastState = 0;
    return seat;
  }

  // 抜けたきり戻ってこない席（ソケットも閉じている）は片付ける。走行の合間に
  // いる人はソケットが生きているので消えない。
  for (let i = s.entrants.length - 1; i >= 0; i--) {
    const e = s.entrants[i];
    if (e.human && e.left && (!e.ws || e.ws.readyState !== e.ws.OPEN)) s.entrants.splice(i, 1);
  }

  // 席は人間も含めて上限24。住人の席も必ず MIN_BOT_SEATS 残す。
  const before = seatedHumans(s).length;
  if (before >= SEATS_MAX - MIN_BOT_SEATS) return false;

  const e = {
    ws, human: true, name, score: 0, cuts: 0, missed: 0,
    alive: true, downUntil: 0, lastSeen: now(),
    grid: null, gridAt: 0, gridPrev: null, gridPrevAt: 0,
    syncScore: null, syncAt: 0, dealt: 0,
  };
  s.entrants.push(e);
  // 一度上がった人数は下げない。抜けたぶんHPを下げるのは、与えたダメージを
  // 巻き戻すのと同じこと（既存方針と整合）。zeroSeatOut 側にも同じ注記がある。
  s.humans = Math.max(s.humans | 0, before + 1);
  rebalanceBots(s);
  // 席が変わったので、次の tick で全員へ状態を配り直す（既存の1秒配信に乗せる）。
  s.lastState = 0;
  sayOpening(s, run, deps, now());
  return e;
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------

// 🏁 走行が終わった（120秒を走りきった／✕で抜けた）。席は**残す** ──
//    伝言(zero_will)はソケットの ws.zeroId が生きている間しか送れないので、
//    ここで席ごと外すと、とどめを刺した人が伝言を書けなくなる。
//    的から降ろすことだけをする。席を畳むのは、このあと届く zero_leave。
//
//    これが無かったとき: 結果画面と伝言モーダル（最長12秒）を開いている間も
//    席は「生きている人」のままなので、断罪が飛び続けた。本人はもう盤面を
//    操作できないので必ず落ち、そのたびに段のHPが回復し、住人がその人の
//    名前で処刑され、断罪録に「落とした」が積まれていった。
export function finishHuman(s, ws) {
  if (!s || !ws) return null;
  const e = s.entrants.find(x => x.human && x.ws === ws);
  if (!e) return null;
  e.done = true;
  e.alive = false;
  return e;
}

export function aliveHumans(s) {
  // 席を外した人(e.left)は名指ししない。zeroSeatOut は alive も false にするが、
  // 断罪の的になるかどうかは席の有無で決まるべきなので、両方を見る。
  // e.done は「走行は終わったが、伝言を送るために席だけ残っている」状態。
  // ここを見ないと、結果画面や伝言モーダルを開いている人に断罪が飛ぶ。
  return s.entrants.filter(e => e.human && e.alive && !e.left && !e.done);
}
// 「いま席に座っている」人間。走行を終えて席を外した人(e.left)は数えないし、
// 配信もしない ── 部屋が枠ごとに1つになったことで、抜けた人の席は次の走行まで
// 残る。ここを見ないと、結果画面にいる人へ zero_state を送り続けてしまう。
export function seatedHumans(s) {
  return s.entrants.filter(e => e.human && !e.left);
}
export function liveBots(s) {
  return s.entrants.filter(e => !e.human && !e.executed);
}

// run は db.meta.adminEventRun（世界で1本の段の状態）
export function tick(s, run, deps) {
  const { chooseMove, now = () => Date.now(), random = Math.random, emit, say, attack } = deps;
  const t = now();
  const elapsed = (t - s.startedAt) / 1000 - COUNTDOWN;
  if (s.ended || elapsed < 0) return;

  const danIndex = run.dan | 0;
  // 七段すべて割れた。以降は静かに終わる（tick は何もしない）が、
  // 完全勝利を一度だけ知らせる ── 気づかれないまま終わるのが一番もったいない。
  if (danIndex >= DAN.length) {
    if (!run.allBroken) {
      run.allBroken = Date.now();
      if (deps.say) deps.say('wrap', DAN.length - 1, { n: DAN.length });
      // 部屋は枠ごとに1つなので、完全勝利の演出は「その枠にいる全員」に届く。
      // 1ソケット1部屋だった頃は、最初に条件を満たした部屋の人しか見られなかった。
      if (deps.emit) for (const x of seatedHumans(s)) {
        deps.emit(x, { type: 'zero_complete', dan: DAN.length });
      }
      // 👑 称号「七冠奪還」── 七段すべてが陥落したその場に居合わせた人にバッジ 'zero7'。
      if (deps.onZeroSevenBadge) deps.onZeroSevenBadge(seatedHumans(s).map(x => x.name));
    }
    return;
  }
  const dan = danAt(danIndex);
  const softCap = softCapFor(danIndex, danBasis(s, run), run);

  // --- 住人ボットが実際に打つ（これが段の7割を削る火力）---
  for (const e of liveBots(s)) {
    if (!e.engine) continue;
    let guard = 0;
    while (t >= e.nextMoveAt && !e.engine.over && guard++ < 4) {
      const mv = chooseMove(e.engine, e.level);
      if (!mv) { e.engine.over = true; break; }
      const before = e.engine.score;
      if (!e.engine.place(mv.index, mv.row, mv.col)) { e.engine.over = true; break; }
      e.nextMoveAt = t + e.moveEvery * (0.75 + random() * 0.5);
      const gained = e.engine.score - before;
      e.score += gained;
      // 点は封印の手前で必ず止まる。ここがこの設計の全部 ——
      // 住人が何点入れても、残り3割は人間が斬らないと1ミリも減らない。
      run.dealt = Math.min(softCap, (run.dealt || 0) + gained);
    }
    if (e.engine.over) { e.engine = new (deps.Engine)((s.seed + e.score) >>> 0); }
  }

  // --- ゼロも打つ。2列以上消したら参加者にゴミが降る ---
  {
    const z = s.zero;
    let guard = 0;
    while (t >= z.nextMoveAt && !z.engine.over && guard++ < 3) {
      const mv = chooseMove(z.engine, 'oni');
      if (!mv) { z.engine.over = true; break; }
      const res = z.engine.place(mv.index, mv.row, mv.col);
      z.nextMoveAt = t + 1100 * (0.8 + random() * 0.4);
      if (!res) break;
      z.score = z.engine.score;
      if (res.lineCount >= 2 && attack) attack(s, res.lineCount, res.streak || 0);
    }
    if (z.engine.over) {
      // 盤面が詰んだら組み直す。演出としてはそう見せる。
      z.engine = new (deps.Engine)((s.seed + t) >>> 0);
      if (say) say('revive', danIndex, {});
    }
  }

  // --- 断罪（人間しか斬れない）---
  resolveExpiredVerdicts(s, run, danIndex, deps);
  if (t >= s.nextVerdictAt) {
    fireVerdicts(s, run, danIndex, deps);
    s.nextVerdictAt = t + dan.everyMs;
  }

  // --- トップアウトからの復帰 ---
  // 席を外した人(e.left)は復帰させない。復帰させると aliveHumans に混ざり、
  // 画面を見ていない人へ断罪が飛んで、必ず落ちて（＝ゼロが回復して住人が処刑
  // される）しまう。次に座り直したとき addHuman が起こす。
  // 走行を終えた人(e.done)も同じ理由で起こさない。トップアウトの60秒が
  // 走行の終わりをまたぐと、席だけ残っている人が復帰扱いになって的に戻る。
  for (const e of s.entrants) {
    if (e.human && !e.left && !e.done && !e.alive && e.downUntil && t >= e.downUntil) {
      e.alive = true; e.downUntil = 0;
      if (emit) emit(e, { type: 'zero_revive' });
    }
  }

  // --- 🤝 取引（20分地点の60秒）---
  runDeal(s, run, danIndex, deps, elapsed, t);

  // --- 段が落ちたか ---
  const seal = sealHpFor(danIndex, danBasis(s, run), run);
  if ((run.dealt || 0) >= softCap - 0.5 && (run.sealDealt || 0) >= seal) {
    breakDan(s, run, danIndex, deps);
  }

  // --- 1秒ごとの状態配信 ---
  if (t - s.lastState >= 1000) {
    s.lastState = t;
    if (emit) {
      const view = stateView(s, run);
      // canWill は視聴者ごとに違う（とどめを刺して未記入の段があるか）。共有 view の
      // ハードコード null を上書きして配る ── 再接続後も伝言を書く権利を復元できる。
      // 席の「自分」印も視聴者ごとなので、seats だけ差し替える（view ごと作り直すと
      // 盤面のスナップショットを人数ぶん取り直すことになる）。
      const userIdOf = deps.userIdOf;
      for (const e of seatedHumans(s)) {
        const canWill = (run.broken || []).some(b => b.by === e.name && !b.will);
        // 🤝 取引に「もう投票したか」も視聴者ごとに載せる。走行をまたいで
        //    取引が出し直されるようになったので（クライアントの onState が
        //    view.deal を読む）、これが無いと投票済みの人にボタンが押せる形で
        //    出てしまい、押すと必ず「もう投票しました」のエラーになる。
        const voted = !!(run.deal && userIdOf && run.deal.humanVotes
          && run.deal.humanVotes[userIdOf(e.ws)]);
        emit(e, {
          ...view,
          seats: view.seats.map(x => (x.name === e.name ? { ...x, you: true } : x)),
          canWill,
          deal: view.deal ? { ...view.deal, voted } : null,
          you: youView(e),
        });
      }
    }
  }
}

// 予告時間を過ぎた断罪を「落とした」として処理する
function resolveExpiredVerdicts(s, run, danIndex, deps) {
  const { now = () => Date.now(), say, emit, random = Math.random } = deps;
  const t = now();
  for (const v of s.verdicts) {
    if (v.resolved || t <= v.at + v.warnMs) continue;
    v.resolved = true;
    const e = s.entrants.find(x => x.name === v.target);
    // 🪑 撃ったあとに席を立った／走行が終わった人の断罪は、無かったことにする。
    //    斬れなかったのは本人のせいではないのに「落とした」が1つ付き、段のHPが
    //    回復し、その人の名前で住人が1人処刑され、断罪録にも名前が残っていた。
    //    落とす罰は「見ていたのに斬らなかった」ときだけ意味がある。
    if (!e || e.left || e.done) continue;
    e.missed = (e.missed || 0) + 1;
    if (deps.onStat) deps.onStat(v.target, 'zeroMissed');
    // 落とすと段が少し回復し、住人が1人処刑される。
    const dan = danAt(danIndex);
    // 回復量はHPの重み（申込人数）で決まるが、missHealFor は同じ引数を
    // 「同時に走る断罪の本数」の分母にも使う。本数は実際に生きている人数で
    // 決まる（fireVerdicts と同じ）ので、そちらは lanes で明示的に上書きする。
    run.dealt = Math.max(0, (run.dealt || 0)
      - missHealFor(danIndex, danBasis(s, run), run, lanesFor(aliveHumans(s).length)));
    const victim = executeResident(s, run, deps, random);
    chronicle(run, 'missed', { by: v.target, victim: victim ? victim.name : null });
    if (say) say('missed', danIndex, { you: v.target, name: victim ? victim.name : undefined, seed: v.at });
    if (emit) {
      for (const x of seatedHumans(s)) {
        // 落とした本人には赤マス座標も送る ── モード説明「時間内に斬れないと
        // 赤マスがそのままお邪魔になる」を満たすため、クライアントは自分が target の
        // ときこの cells を盤面へお邪魔として書き込む。他人には座標は送らない。
        const mine = x.name === v.target;
        emit(x, {
          type: 'zero_missed', target: v.target, victim: victim ? victim.name : null,
          cells: mine ? v.cells : undefined, mine,
        });
      }
    }
  }
  s.verdicts = s.verdicts.filter(v => !v.resolved);
}

// 断罪を撃つ。人が多いと同時に複数本走る。
function fireVerdicts(s, run, danIndex, deps) {
  const { now = () => Date.now(), random = Math.random, say, emit } = deps;
  const t = now();
  const targets = aliveHumans(s);
  if (!targets.length) return;
  const dan = danAt(danIndex);
  const lanes = Math.min(lanesFor(targets.length), targets.length);

  // 直近に名指しされた人を避けて回す（同じ人ばかりにならないように）
  const order = targets.slice().sort((a, b) => (a.lastVerdictAt || 0) - (b.lastVerdictAt || 0));
  for (let i = 0; i < lanes; i++) {
    const e = order[i];
    e.lastVerdictAt = t;
    // 取引「今夜の的を八列すべてにしてやる」= 寄せる列を無効化する
    const mark = run.dealMarkAll ? -1 : s.targetCol;
    // zero_state で同期された盤面が新しければ、それを渡す ── 赤マスが
    // 「いま空いているマス」から選ばれる（pickVerdictCells の本来の設計）。
    // まだ届いていない／古いときだけ null（全マスから選ぶ・安全側）。
    const grid = e.grid && (t - (e.gridAt || 0)) <= GRID_FRESH_MS ? e.grid : null;
    let { cells, keystone } = pickVerdictCells(grid, danIndex, mark, random);
    // 盤面が満杯で空きマスが無いときは、的が1つも出せない＝その人だけ断罪が
    // 飛ばなくなる（＝落とす罰も受けない）。埋まった盤面はどのみち詰み寸前
    // なので、全マスから選び直して必ず名指しする。
    if (!cells.length && grid) ({ cells, keystone } = pickVerdictCells(null, danIndex, mark, random));
    if (!cells.length) continue;
    // 杭が効いていれば予告が伸びる。取引で縮むこともある。
    const warnMs = Math.max(1200, dan.warnMs + (s.warnBonus || 0) - (run.dealWarnCut || 0));
    if (s.warnBonus) s.warnBonus = 0;      // 1回ぶんだけ
    const v = {
      id: `${t}-${i}`, target: e.name, at: t, warnMs,
      cells, keystone, resolved: false,
    };
    s.verdicts.push(v);
    if (emit) emit(e, { type: 'zero_verdict', id: v.id, cells, keystone, warnMs });
    if (deps.onStat) deps.onStat(e.name, 'zeroNamed');
    if (say && i === 0) say('verdict', danIndex, { you: e.name, seed: t });
  }
}

// カットの申告。クライアント申告だが、時間で頭打ちになる（zero.js の注記参照）。
// 🪧 杭 ── 「今夜の的」の列を縦に消すと1本入り、3本で次の予告が伸びる。
//
// これが効くのは、特定の1列を縦に消すのが**点効率で損**だから。
// 横消しのほうがスコアは出る。つまり「点を稼ぐ置き方」と
// 「斬りやすくする置き方」が同じ手番の中で衝突する。
// 今の3モードには一度も無かった、盤面の中の選択。
export function submitStake(s, run, name, cols, deps) {
  const { emit } = deps;
  // 取引「八列すべてを的に」を飲んだ夜は、どの列を縦に消しても杭になる。
  // ここを直さないと、赤マスだけが散って杭は元の1列のまま＝ただの損だった。
  if (!Array.isArray(cols)) return { ok: false };
  if (!run.dealMarkAll && !cols.includes(s.targetCol)) return { ok: false };
  const need = run.dealStakeCost || 3;
  s.stakes2 = (s.stakes2 || 0) + 1;
  const ready = s.stakes2 >= need;
  if (ready) { s.stakes2 = 0; s.warnBonus = 1500; }
  if (emit) {
    for (const x of seatedHumans(s)) {
      emit(x, { type: 'zero_stake', by: name, have: s.stakes2, need, ready });
    }
  }
  return { ok: true, ready };
}

// ---------------------------------------------------------------------------
// 盤面同期（zero_state）
// ---------------------------------------------------------------------------
//
// バトルロイヤルの 'state' と同じ作法。クライアントが grid と score を定期的に
// （＋1手ごとに）送り、サーバーが席に保存する。レート制限は battle.js の
// sockRate が持つ（他の zero_* と同じ）。
//
// ■ 人間の点を段に入れる（住人＝火力／人間＝鍵 との関係）
// zero.js の役割分けは「住人が7割を削り、人間が残り3割の封印を斬る」。
// 人間の点も**7割の側にだけ**入れる ── 封印は今までどおり斬らないと1ミリも
// 減らないので、役割の壁はそのまま残る。変わるのは「自分の点が段のバーを
// 動かす」という手応えと、scripts/sim-zero.mjs が最初から前提にしていた
// 火力の式（住人＋人間）に実装が追いつくこと。
// 入れすぎて段が一瞬で溶けないよう、1人あたり毎分 HUMAN_DPM_CAP で頭打ちにする。
export function syncBoard(s, run, name, payload, deps = {}) {
  const { now = () => Date.now() } = deps;
  if (!s || s.ended || !payload) return { ok: false, why: 'no-session' };
  const t = now();
  const e = s.entrants.find(x => x.human && !x.left && x.name === name);
  if (!e) return { ok: false, why: 'no-seat' };
  e.lastSeen = t;

  let gotGrid = false;
  if (Array.isArray(payload.grid) && payload.grid.length >= SIZE * SIZE) {
    // 呼び出し側（battle.js）が sanitizeGrid 済みだが、単体でも安全にする。
    const g = new Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const v = Math.floor(Number(payload.grid[i]));
      g[i] = Number.isFinite(v) && v > 0 ? Math.min(9, v) : 0;
    }
    // 直近2枚を持つ（verdictAccepts が「置く前／置いた後」どちらの実装でも
    // 正しく裏づけを取れるようにするため。理由は zero.js の注記）。
    e.gridPrev = e.grid; e.gridPrevAt = e.gridAt || 0;
    e.grid = g; e.gridAt = t; gotGrid = true;
  }
  const dealt = applyHumanScore(s, run, e, payload.score, t);
  return { ok: true, grid: gotGrid, dealt };
}

// 申告スコアの増分を段のHPに入れる。増分だけを見るので、走行が変わって
// スコアが 0 に戻っても（クライアントの1走行は120秒）巻き戻らない。
function applyHumanScore(s, run, e, rawScore, t) {
  const score = Math.floor(Number(rawScore));
  if (!Number.isFinite(score) || score < 0) return 0;
  const last = e.syncAt || 0;
  const prev = e.syncScore;
  e.syncAt = t;
  e.syncScore = score;
  // 初回、または新しい走行（スコアが下がった）＝基準を取り直すだけ。
  if (prev == null || score < prev) return 0;
  const gained = score - prev;
  if (gained <= 0) return 0;
  e.score = (e.score || 0) + gained;      // 席の一覧に出る、この枠での累計
  if (!run || !e.alive) return 0;
  const danIndex = run.dan | 0;
  if (danIndex >= DAN.length) return 0;
  // 前回の同期からの経過時間ぶんだけ。黙っていた時間は繰り越さない。
  const span = Math.max(0, Math.min(HUMAN_BUDGET_MAX_SEC * 1000, last ? t - last : 0));
  const budget = Math.floor(HUMAN_DPM_CAP * span / 60_000);
  const add = Math.min(gained, budget);
  if (add <= 0) return 0;
  const softCap = softCapFor(danIndex, danBasis(s, run), run);
  const before = run.dealt || 0;
  // 点は封印の手前で必ず止まる（住人の火力とまったく同じ扱い）。
  run.dealt = Math.min(softCap, before + add);
  const applied = run.dealt - before;
  e.dealt = (e.dealt || 0) + applied;
  return applied;
}

export function submitCut(s, run, name, verdictId, clearedCells, deps) {
  const { now = () => Date.now(), say, emit } = deps;
  const t = now();
  const v = s.verdicts.find(x => x.id === verdictId && x.target === name);
  const e = s.entrants.find(x => x.name === name);
  // 同期済みの盤面があれば、それを裏づけに使う（zero.js の verdictAccepts 参照）。
  const board = e && e.grid
    ? { grid: e.grid, at: e.gridAt || 0, prev: e.gridPrev || null, prevAt: e.gridPrevAt || 0 }
    : null;
  const r = verdictAccepts(v, t, clearedCells, board);
  if (!r.ok) return { ok: false, why: r.why };
  v.resolved = true;
  s.verdicts = s.verdicts.filter(x => !x.resolved);

  if (e) e.cuts = (e.cuts || 0) + 1;
  if (deps.onStat) deps.onStat(name, 'zeroCuts');
  // 👑 王座の欠片。急所ごと斬れば上乗せ。
  if (deps.shard) deps.shard(name, (deps.SHARD ? deps.SHARD.cut : 3) + (r.keystone ? (deps.SHARD ? deps.SHARD.keystone : 5) : 0));
  const danIndex = run.dan | 0;
  const dmg = cutDamageFor(danIndex, danBasis(s, run), { keystone: r.keystone, run });
  run.sealDealt = (run.sealDealt || 0) + dmg;
  run.cuts = (run.cuts || 0) + 1;
  chronicle(run, 'cut', { by: name, keystone: !!r.keystone, dan: danIndex + 1 });
  if (say) say('cut', danIndex, { you: name, seed: t });
  if (emit) {
    for (const x of seatedHumans(s)) {
      emit(x, { type: 'zero_cut', by: name, keystone: !!r.keystone, damage: dmg });
    }
  }
  return { ok: true, keystone: !!r.keystone, damage: dmg };
}

// トップアウト。回数無制限だが、そのたびにゼロが回復する。
export function topOut(s, run, name, deps, userId = null) {
  const { now = () => Date.now(), say } = deps;
  const e = s.entrants.find(x => x.human && x.name === name);
  if (!e || !e.alive) return false;
  const t = now();
  // 🪦 席は **必ず** 倒す。詰んだのは盤面の事実で、ここで断ると復帰を面倒みる
  //    tick の条件（e.downUntil が立っていること／上の 320行）に一生入らない。
  //    クライアントは zero_topout を送った時点で入力を止めて
  //    「60秒後に復帰します」と出すので、断られた人は**その画面のまま最大2分**
  //    置き去りになる（✕で降りるしか出口が無い）。
  e.alive = false;
  e.downUntil = t + REVIVE_SEC * 1000;

  // 断るのは「ゼロの回復」だけにする。
  // クールダウンはユーザー単位で run（世界で1本の共有進捗）に持つ。席単位の
  // e.alive だけだと、zero_leave→zero_join で新セッションの alive:true な席を
  // 即座に得られ、60秒に1回の上限を回避して共有進捗を巻き戻せた（griefing）。
  // ── 守りたいのはこの巻き戻しであって、本人を動けなくすることではない。
  let heal = true;
  if (userId) {
    run.topoutAt = run.topoutAt || {};
    if (t - (run.topoutAt[userId] || 0) < REVIVE_SEC * 1000) heal = false;
    else run.topoutAt[userId] = t;
  }
  const danIndex = run.dan | 0;
  if (heal) {
    run.dealt = Math.max(0, (run.dealt || 0) - Math.round(danHpFor(danIndex, danBasis(s, run), run) * TOPOUT_HEAL));
  }
  if (say) say('revive', danIndex, { you: name, seed: now() });
  return true;
}

// 住人の処刑。1枠3人・1日9人の上限つき。永久には消さない（翌日戻る）。
function executeResident(s, run, deps, random) {
  run.fallen = run.fallen || [];
  // 🪦 「1枠3人」の数はセッション（s）ではなく **枠（run.slotStartsAt）** に紐づける。
  //
  //    セッションに持たせていたころは、その枠から全員がいなくなると部屋が畳まれ
  //    （battle.js の「誰も見ていない部屋は畳む」）、次に誰かが入った時点で
  //    新しいセッションになって s.executed が 0 に戻っていた。つまり
  //    枠の途中で一度みんなが抜けるだけで、1枠に何人でも処刑できた。
  //    run は枠をまたいで生きている（世界で1本の共有進捗）ので、そちらに
  //    「どの枠で何人落ちたか」を刻む。
  //    ⚠ run.fallen は1日ぶんの記録で、翌日に空にされる（下の日またぎ処理）。
  //      枠の判別は slotStartsAt（adminevent が書き込む枠の開始時刻）。
  const slotKey = run.slotStartsAt || 0;
  const inThisSlot = run.fallen.filter(f => f && (f.slot || 0) === slotKey).length;
  if (inThisSlot >= EXECUTIONS_PER_SLOT) return null;
  if (run.fallen.length >= EXECUTIONS_PER_DAY) return null;
  const pool = liveBots(s);
  if (pool.length <= MIN_BOT_SEATS) return null;   // 席を空にしすぎない
  const victim = pool[Math.floor(random() * pool.length)];
  victim.executed = true;
  victim.alive = false;
  s.executed = (s.executed || 0) + 1;   // 表示・ログ用（上限の判定には使わない）
  run.fallen.push({ name: victim.name, id: victim.residentId || null, at: Date.now(), slot: slotKey });
  return victim;
}

// その段のHP基準になる人数。
//
// ここを s.humans（＝いま部屋にいる人数）から直に取っていたのが、
// 「誰も打っていないのに段が割れる」バグの正体だった。閾値（softCap / seal）は
// 人数に比例して重くなるのに、削った量（run.dealt / run.sealDealt）は
// db.meta.adminEventRun 側に日単位の絶対値で残る。最後の人間が抜けると部屋は
// 破棄されるので、6人で貯めたあと1人が入り直すと閾値だけが半分近くまで縮み、
// 入った瞬間の tick でいきなり陥落 ── その人が「とどめ」として欠片もバッジも
// 伝言権も持っていってしまう。全員退室→再入場で意図的にも再現できた。
//
// 直し方は「部屋の寿命に左右されない値を分母にする」こと。run.entrants はその回の
// 申込人数で、adminevent.js の ensureRun が持ち、遅い申込でだけ増える（部屋を
// 畳んでも減らない）。段の進捗と同じ run に載っているので、これでようやく
// 「削った量」と「目標」が同じものさしに乗る。
//
// あえて「段の開始時に人数を焼き付ける」やり方は採らない。焼き付けは
//   (a) その日の最初の段が「最初に読んだ人」＝1人基準に確定してしまう
//       （実際の呼び出し順は zeroSeatIn → stateView なので必ず1人になる）
//   (b) s.humans は部屋のピーク人数で退席では下がらないため、賑わった枠の
//       人数が次の枠へ居座って「1人では絶対に割れない段」を作る
//   (c) 焼き付けの無い既存の run では、移行の瞬間に同じ事故がもう一度起きる
// という別の穴を開ける。申込人数は最初から安定しているので焼き付ける必要がない。
//
// 副作用を持たない（run を書き換えない）ことも大事 ── stateView は「画面に送る
// 形を作るだけ」の関数で、そこが共有状態の最初の書き手になってはいけない。
// 同時にアリーナへ入れる人数（席の上限）。申込がこれを超えても、実際に殴れる
// 火力はここで頭打ちになるので、基準だけが青天井に伸びると「誰も割れない段」に
// なる。SEATS_MAX と同じ数を上限にして、目標と火力の物差しを合わせる。
const MAX_BASIS = SEATS_MAX;
function danBasis(s, run) {
  const signed = Math.min(MAX_BASIS, Math.max(0, (run && run.entrants) | 0));
  if (signed >= 1) return signed;
  // 申込数を持たない run（テストからの直接呼び出しなど）だけ、部屋の人数に頼る。
  return Math.max(1, (s && s.humans) | 0);
}

// 段が割れた。王座が1つ返ってくる。
function breakDan(s, run, danIndex, deps) {
  const { say, emit, onDanBroken, now = () => Date.now() } = deps;
  run.dan = danIndex + 1;
  run.dealt = 0;
  run.sealDealt = 0;
  // 取引は1段ぶん。段が変わったら効果は切れる。
  clearDealEffects(run);
  delete run.deal;
  delete run.dealDoneFor;
  s.stakes2 = 0; s.warnBonus = 0;
  run.broken = run.broken || [];
  const top = aliveHumans(s).sort((a, b) => (b.cuts || 0) - (a.cuts || 0))[0];
  const rec = { dan: danIndex + 1, at: now(), by: top ? top.name : null };
  run.broken.push(rec);
  chronicle(run, 'dan', { dan: danIndex + 1, by: rec.by });
  s.stakes.push(rec);
  if (say) say('danBroken', danIndex, { dan: danIndex + 1, seed: rec.at });
  if (emit) {
    for (const x of seatedHumans(s)) {
      emit(x, { type: 'zero_dan', dan: danIndex + 1, by: rec.by, next: run.dan < DAN.length ? run.dan + 1 : null });
    }
  }
  // 段が割れた瞬間そこに居た人だけにバッジ。あとから点を足しても手に入らない。
  if (deps.onDanBadge) deps.onDanBadge(seatedHumans(s).map(x => x.name));
  // 欠片も同じ扱い ── 居合わせた人だけ。とどめを刺した人はさらに上乗せ。
  if (deps.shard) {
    const P = deps.SHARD ? deps.SHARD.danPresent : 40;
    const F = deps.SHARD ? deps.SHARD.danFinish : 80;
    for (const x of seatedHumans(s)) {
      deps.shard(x.name, P + (rec.by === x.name ? F : 0));
    }
  }
  if (onDanBroken) onDanBroken(rec, s);
}

// ---------------------------------------------------------------------------
// 📜 断罪録
// ---------------------------------------------------------------------------
//
// その日の出来事を、実名つきで時系列に残す。実装は配列に足すだけだが、
// 「あいつがあの時ああした」が保存される場所はここしかない。
// 次の枠の人はこれを読んでから入る。

export const CHRONICLE_MAX = 400;

export function chronicle(run, kind, data) {
  run.log = run.log || [];
  run.log.push({ at: Date.now(), kind, ...data });
  // 1日ぶんなので上限は緩くてよいが、無制限にすると db.json が太る。
  if (run.log.length > CHRONICLE_MAX) run.log.splice(0, run.log.length - CHRONICLE_MAX);
}

// 📝 伝言 ── 段にとどめを刺した人が、次の枠へ1行残せる。
// 40字。次の枠の開幕でゼロが読み上げて茶々を入れる。
export const WILL_MAX = 40;

export function submitWill(run, name, text) {
  run.wills = run.wills || [];
  // とどめを刺した人だけが書ける（書ける権利は1段につき1回）
  const rec = (run.broken || []).slice().reverse().find(b => b.by === name && !b.will);
  if (!rec) return { ok: false, why: 'not-earned' };
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, WILL_MAX);
  if (!clean) return { ok: false, why: 'empty' };
  rec.will = clean;
  run.wills.push({ by: name, text: clean, dan: rec.dan, at: Date.now() });
  if (run.wills.length > 30) run.wills.splice(0, run.wills.length - 30);
  chronicle(run, 'will', { by: name, text: clean, dan: rec.dan });
  return { ok: true };
}

// 次の枠の開幕で読み上げる、直近の伝言
export function latestWill(run) {
  const w = run.wills || [];
  return w.length ? w[w.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 🤝 取引
// ---------------------------------------------------------------------------

function runDeal(s, run, danIndex, deps, elapsed, t) {
  const { emit, say, residentVoters, residentChoice, random = Math.random } = deps;
  // 発火はセッション基準の elapsed ではなく「枠(スロット)の20分地点」で測る。
  // クライアントの1走行は120秒でセッションが作り直されるため、セッション基準では
  // DEAL_AT_SEC(=1200秒) に構造的に到達できず、取引が本番で一度も発動しなかった。
  // run.slotStartsAt（現在スロットの開始時刻, ms）を adminevent 側が書き込む。
  // 無い場合は後方互換でセッション基準にフォールバックする。
  const slotElapsed = run.slotStartsAt ? (t - run.slotStartsAt) / 1000 : elapsed;
  // 🕒 発火点は「20分地点」だが、1枠の長さは管理画面で 10〜180分まで動かせる
  //    （adminevent.js の AE_MIN_DURATION / AE_MAX_DURATION、既定は30分）。
  //    20分より短い枠にすると、この地点に到達する前に枠が終わるので、取引は
  //    **構造的に一度も開かない**。枠が短いときだけ前倒しして、投票の60秒と
  //    締切後の余韻ぶんが枠の中に必ず収まるようにする。既定の30分枠では
  //    min(1200, 1800-80) = 1200 で、これまでと1秒も変わらない。
  const slotSec = (run.slotEndsAt && run.slotStartsAt)
    ? (run.slotEndsAt - run.slotStartsAt) / 1000 : 0;
  const dealAt = slotSec > 0
    ? Math.max(30, Math.min(DEAL_AT_SEC, slotSec - DEAL_SEC - 20))
    : DEAL_AT_SEC;
  // 開幕
  if (!run.deal && slotElapsed >= dealAt && run.dealDoneFor !== danIndex) {
    run.deal = makeDeal(run.dayKey || 'x', danIndex, t);
    if (say) say('deal', danIndex, { seed: t });
    if (emit) for (const x of seatedHumans(s)) emit(x, { type: 'zero_deal', deal: dealView(run.deal) });
    return;
  }
  if (!run.deal || run.deal.settled) return;

  // 住人が本当に投票する。誰がいつ入れるかは polls.js の仕掛けに任せる ——
  // 同調・逆張り・ギルド連帯・締切間際の鞍替えが全部そのまま効く。
  if (residentVoters && residentChoice) {
    const left = run.deal.closesAt - t;
    const frac = 1 - Math.max(0, left) / (DEAL_SEC * 1000);
    for (const r of residentVoters()) {
      if (run.deal.residentVoted[r.id]) continue;
      // 締切に近いほど入りやすい（票が割れていく60秒が見世物になる）
      if (random() > 0.02 + frac * 0.06) continue;
      const pick = residentChoice(run.deal, r);
      if (!pick) continue;
      run.deal.residentVoted[r.id] = true;
      const o = run.deal.options.find(x => x.id === pick);
      if (o) o.votes++;
      if (emit) for (const x of seatedHumans(s)) {
        emit(x, { type: 'zero_deal_vote', by: r.name, pick, tally: dealTally(run.deal) });
      }
    }
  }

  // 締切
  if (t >= run.deal.closesAt) {
    run.deal.settled = true;
    run.dealDoneFor = danIndex;
    const win = dealWinner(run.deal);
    if (win === 'yes') {
      dealForDay(run.dayKey || 'x').apply(run);
      // 「処刑した住人を全員returnさせる」は席にも反映する
      if (run.dealRevive) {
        for (const x of s.entrants) if (!x.human && x.executed) { x.executed = false; x.alive = true; }
        run.fallen = [];
        s.executed = 0;
      }
    }
    if (emit) for (const x of seatedHumans(s)) {
      emit(x, { type: 'zero_deal_done', win, tally: dealTally(run.deal) });
    }
    chronicle(run, 'deal', { win, tally: dealTally(run.deal), q: run.deal.q });
    if (say) say(win === 'yes' ? 'dealYes' : 'dealNo', danIndex, { seed: t });
  }
}

export function dealView(deal) {
  if (!deal) return null;
  return {
    id: deal.id, q: deal.q, qEn: deal.qEn,
    options: deal.options.map(o => ({ id: o.id, text: o.text, textEn: o.textEn })),
    closesAt: deal.closesAt, settled: !!deal.settled,
    tally: dealTally(deal), humanWeight: HUMAN_VOTE_WEIGHT,
  };
}

// 人間の1票は住人5票ぶん。1人1回だけ。
export function submitDealVote(run, userId, pick) {
  if (!run || !run.deal || run.deal.settled) return { ok: false, why: 'closed' };
  if (pick !== 'yes' && pick !== 'no') return { ok: false, why: 'bad' };
  if (run.deal.humanVotes[userId]) return { ok: false, why: 'already' };
  run.deal.humanVotes[userId] = pick;
  return { ok: true, tally: dealTally(run.deal) };
}

// ---------------------------------------------------------------------------
// 画面に送る形
// ---------------------------------------------------------------------------

// viewerName: 受け取る人の名前。席の「自分」印だけに使う（省略すると誰にも付かない）。
export function stateView(s, run, viewerName = null) {
  const danIndex = Math.min(DAN.length - 1, run.dan | 0);
  // 表示も判定とまったく同じ基準を使う（片方だけ人数で動くと、ゲージが
  // 満タンなのに割れない／空なのに割れる、が起きる）。
  const basis = danBasis(s, run);
  const hp = danHpFor(danIndex, basis, run);
  const seal = sealHpFor(danIndex, basis, run);
  const soft = softCapFor(danIndex, basis, run);
  return {
    type: 'zero_state',
    dan: danIndex + 1,
    danMax: DAN.length,
    hp,
    // 残りHP = 全体 − 点で削った分 − 封印を割った分
    left: Math.max(0, hp - Math.min(soft, run.dealt || 0) - Math.min(seal, run.sealDealt || 0)),
    soft,
    seal,
    sealLeft: Math.max(0, seal - (run.sealDealt || 0)),
    targetCol: s.targetCol,
    mood: moodFor(danIndex),
    cuts: run.cuts || 0,
    fallen: (run.fallen || []).map(f => f.name),
    deal: run.deal && !run.deal.settled ? dealView(run.deal) : null,
    stakes: { have: s.stakes2 || 0, need: run.dealStakeCost || 3 },
    will: latestWill(run),
    // とどめを刺してまだ伝言を残していない段があれば、書く権利がある
    canWill: null,
    zeroGrid: s.zero.engine ? s.zero.engine.snapshot() : null,
    // 席順。以前は human:true/false をそのまま載せていたので、断罪の席次表が
    // そのまま「誰が人間で誰が住人か」の一覧になっていた（画面もそれを見て
    // 人間の席だけ色を変えていた）。載せるのは「自分の席かどうか」だけにする
    // ── 画面がやりたかったのは元々そちらで、正体は要らない。
    // ⚠ クライアント側（public/js/modes.js の zeroSeats）も s.human → s.you に
    // 追随が要る。
    seats: s.entrants.map(e => ({
      name: e.name, you: !!viewerName && e.name === viewerName,
      score: Math.floor(e.score || 0),
      alive: !!e.alive, executed: !!e.executed,
    })),
  };
}

function youView(e) {
  return { cuts: e.cuts || 0, missed: e.missed || 0, alive: !!e.alive };
}
