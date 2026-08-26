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

export function createSession(deps, humanSocks) {
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

  const entrants = seated.map(ws => ({
    ws, human: true, name: sockName(ws), score: 0, cuts: 0, missed: 0,
    alive: true, downUntil: 0, lastSeen: now(),
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

  return {
    id: uuid(),
    overflow: humanSocks.slice(seated.length),
    entrants,
    startedAt: now(),
    ended: false,
    seed,
    humans,
    zero: { engine: zeroEngine, nextMoveAt: now() + COUNTDOWN * 1000, score: 0, lines: 0 },
    verdicts: [],          // 進行中の断罪
    nextVerdictAt: now() + COUNTDOWN * 1000 + 25_000,
    lastState: 0,
    targetCol: Math.floor(random() * SIZE),
    stakes: [],            // このセッションで割れた段（枠の終わりに精算）
  };
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------

export function aliveHumans(s) {
  return s.entrants.filter(e => e.human && e.alive);
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
  if (danIndex >= DAN.length) return;          // 7段すべて割れている
  const dan = danAt(danIndex);
  const softCap = softCapFor(danIndex, s.humans);

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
  for (const e of s.entrants) {
    if (e.human && !e.alive && e.downUntil && t >= e.downUntil) {
      e.alive = true; e.downUntil = 0;
      if (emit) emit(e, { type: 'zero_revive' });
    }
  }

  // --- 段が落ちたか ---
  const seal = sealHpFor(danIndex, s.humans);
  if ((run.dealt || 0) >= softCap - 0.5 && (run.sealDealt || 0) >= seal) {
    breakDan(s, run, danIndex, deps);
  }

  // --- 1秒ごとの状態配信 ---
  if (t - s.lastState >= 1000) {
    s.lastState = t;
    if (emit) {
      const view = stateView(s, run);
      for (const e of s.entrants) if (e.human) emit(e, { ...view, you: youView(e) });
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
    if (e) e.missed = (e.missed || 0) + 1;
    // 落とすと段が少し回復し、住人が1人処刑される。
    const dan = danAt(danIndex);
    run.dealt = Math.max(0, (run.dealt || 0) - missHealFor(danIndex, s.humans));
    const victim = executeResident(s, run, deps, random);
    if (say) say('missed', danIndex, { you: v.target, name: victim ? victim.name : undefined, seed: v.at });
    if (emit) {
      for (const x of s.entrants) if (x.human) {
        emit(x, { type: 'zero_missed', target: v.target, victim: victim ? victim.name : null });
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
    const { cells, keystone } = pickVerdictCells(e.grid, danIndex, s.targetCol, random);
    if (!cells.length) continue;
    const v = {
      id: `${t}-${i}`, target: e.name, at: t, warnMs: dan.warnMs,
      cells, keystone, resolved: false,
    };
    s.verdicts.push(v);
    if (emit) emit(e, { type: 'zero_verdict', id: v.id, cells, keystone, warnMs: dan.warnMs });
    if (say && i === 0) say('verdict', danIndex, { you: e.name, seed: t });
  }
}

// カットの申告。クライアント申告だが、時間で頭打ちになる（zero.js の注記参照）。
export function submitCut(s, run, name, verdictId, clearedCells, deps) {
  const { now = () => Date.now(), say, emit } = deps;
  const t = now();
  const v = s.verdicts.find(x => x.id === verdictId && x.target === name);
  const r = verdictAccepts(v, t, clearedCells);
  if (!r.ok) return { ok: false, why: r.why };
  v.resolved = true;
  s.verdicts = s.verdicts.filter(x => !x.resolved);

  const e = s.entrants.find(x => x.name === name);
  if (e) e.cuts = (e.cuts || 0) + 1;
  const danIndex = run.dan | 0;
  const dmg = cutDamageFor(danIndex, s.humans, { keystone: r.keystone });
  run.sealDealt = (run.sealDealt || 0) + dmg;
  run.cuts = (run.cuts || 0) + 1;
  if (say) say('cut', danIndex, { you: name, seed: t });
  if (emit) {
    for (const x of s.entrants) if (x.human) {
      emit(x, { type: 'zero_cut', by: name, keystone: !!r.keystone, damage: dmg });
    }
  }
  return { ok: true, keystone: !!r.keystone, damage: dmg };
}

// トップアウト。回数無制限だが、そのたびにゼロが回復する。
export function topOut(s, run, name, deps) {
  const { now = () => Date.now(), say } = deps;
  const e = s.entrants.find(x => x.human && x.name === name);
  if (!e || !e.alive) return false;
  e.alive = false;
  e.downUntil = now() + REVIVE_SEC * 1000;
  const danIndex = run.dan | 0;
  run.dealt = Math.max(0, (run.dealt || 0) - Math.round(danHpFor(danIndex, s.humans) * TOPOUT_HEAL));
  if (say) say('revive', danIndex, { you: name, seed: now() });
  return true;
}

// 住人の処刑。1枠3人・1日9人の上限つき。永久には消さない（翌日戻る）。
function executeResident(s, run, deps, random) {
  run.fallen = run.fallen || [];
  s.executed = s.executed || 0;
  if (s.executed >= EXECUTIONS_PER_SLOT) return null;
  if (run.fallen.length >= EXECUTIONS_PER_DAY) return null;
  const pool = liveBots(s);
  if (pool.length <= MIN_BOT_SEATS) return null;   // 席を空にしすぎない
  const victim = pool[Math.floor(random() * pool.length)];
  victim.executed = true;
  victim.alive = false;
  s.executed++;
  run.fallen.push({ name: victim.name, id: victim.residentId || null, at: Date.now() });
  return victim;
}

// 段が割れた。王座が1つ返ってくる。
function breakDan(s, run, danIndex, deps) {
  const { say, emit, onDanBroken, now = () => Date.now() } = deps;
  run.dan = danIndex + 1;
  run.dealt = 0;
  run.sealDealt = 0;
  run.broken = run.broken || [];
  const top = aliveHumans(s).sort((a, b) => (b.cuts || 0) - (a.cuts || 0))[0];
  const rec = { dan: danIndex + 1, at: now(), by: top ? top.name : null };
  run.broken.push(rec);
  s.stakes.push(rec);
  if (say) say('danBroken', danIndex, { dan: danIndex + 1, seed: rec.at });
  if (emit) {
    for (const x of s.entrants) if (x.human) {
      emit(x, { type: 'zero_dan', dan: danIndex + 1, by: rec.by, next: run.dan < DAN.length ? run.dan + 1 : null });
    }
  }
  if (onDanBroken) onDanBroken(rec, s);
}

// ---------------------------------------------------------------------------
// 画面に送る形
// ---------------------------------------------------------------------------

export function stateView(s, run) {
  const danIndex = Math.min(DAN.length - 1, run.dan | 0);
  const hp = danHpFor(danIndex, s.humans);
  const seal = sealHpFor(danIndex, s.humans);
  const soft = softCapFor(danIndex, s.humans);
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
    zeroGrid: s.zero.engine ? s.zero.engine.snapshot() : null,
    seats: s.entrants.map(e => ({
      name: e.name, human: !!e.human, score: Math.floor(e.score || 0),
      alive: !!e.alive, executed: !!e.executed,
    })),
  };
}

function youView(e) {
  return { cuts: e.cuts || 0, missed: e.missed || 0, alive: !!e.alive };
}
