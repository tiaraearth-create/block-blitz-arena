// Ultimate skills (アルティメット) — v2.0.
//
// The gauge fills from line clears (engine.chargeUlt); at 100 the player can
// unleash the one skill they have equipped. Effects mutate the engine directly
// and then hand a *synthetic* place-result to the view, so scoring, particles,
// boss damage and combo text all flow through the exact same pipeline as a
// normal placement.

import { SIZE, SHAPES, shapeSize } from './engine.js';
import { audio } from './audio.js';
import { t } from './i18n.js';

export const DEFAULT_ULT = 'ult_blast';

// Presentation only — the shop catalog (names/prices) lives on the server.
export const ULT_META = {
  ult_blast:     { icon: '💥', color: '#ffa93d' },
  ult_purify:    { icon: '🌊', color: '#43d9e8' },
  ult_overdrive: { icon: '🔥', color: '#ff5d5d' },
  ult_meteor:    { icon: '☄️', color: '#ff6bd4' },
  ult_rainbow:   { icon: '🌈', color: '#5ee86e' },
  ult_fortress:  { icon: '🛡️', color: '#9fd8ff' },
  ult_timestop:  { icon: '⏳', color: '#b06bff' },
  ult_judgement: { icon: '⚡', color: '#fff3b0' },
  ult_condemn:   { icon: '👁️', color: '#e03546' },
  ult_admin:     { icon: '👑', color: '#ffd75e' },
};

export function ultIcon(id) { return (ULT_META[id] || ULT_META[DEFAULT_ULT]).icon; }
export function ultColor(id) { return (ULT_META[id] || ULT_META[DEFAULT_ULT]).color; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cellsOf(engine, pred) {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const v = engine.grid[r * SIZE + c];
    if (pred(v, r, c)) out.push([r, c, v]);
  }
  return out;
}

// Score a set of forced row/col clears exactly like Engine.place() would,
// then build the result object the view expects.
function clearLines(engine, rows, cols, { comboStep = 1 } = {}) {
  const seen = new Set();
  const clearedCells = [];
  const push = (r, c) => {
    const k = r * SIZE + c;
    // 空マスは消滅演出の対象にしない。半端に埋まった行を強制消去するとき
    // （浄化の下2行・衝撃波/断罪の密度行など）に、存在しないブロックの
    // 幻の消滅アニメが出ていた。
    if (seen.has(k) || engine.grid[k] === 0) return;
    seen.add(k);
    clearedCells.push([r, c, engine.grid[k]]);
  };
  for (const r of rows) for (let c = 0; c < SIZE; c++) push(r, c);
  for (const c of cols) for (let r = 0; r < SIZE; r++) push(r, c);
  for (const [r, c] of clearedCells) engine.grid[r * SIZE + c] = 0;

  const lineCount = rows.length + cols.length;
  engine.streak += comboStep;
  if (engine.streak > engine.maxCombo) engine.maxCombo = engine.streak;
  engine.linesCleared += lineCount;
  const comboMult = 1 + 0.5 * (engine.streak - 1);
  let gained = Math.round(lineCount * lineCount * 100 * comboMult);
  gained = applyMultipliers(engine, gained);
  engine.score += gained;
  return { rows, cols, clearedCells, lineCount, gained };
}

function applyMultipliers(engine, gained) {
  if (engine.scoreMult !== 1) gained = Math.round(gained * engine.scoreMult);
  if (engine.feverUntil && Date.now() < engine.feverUntil) gained = Math.round(gained * (engine.feverMult || 2));
  return gained;
}

// Award raw points (no line clears) and keep multipliers consistent.
function awardPoints(engine, base) {
  const gained = applyMultipliers(engine, Math.round(base));
  engine.score += gained;
  return gained;
}

// Hand the effect to the view/mode as if it were a placement.
function emit(ctx, { clearedCells = [], rows = [], cols = [], lineCount = 0, gained = 0, anchor }) {
  const { engine, view } = ctx;
  engine.refillHand();
  if (!engine.hasAnyMove()) engine.over = true;
  const placed = anchor || (clearedCells.length ? [clearedCells[0][0], clearedCells[0][1]] : [0, 0]);
  view.applyResult({
    placedCells: [placed],
    color: 1,
    fullRows: rows, fullCols: cols, clearedCells,
    lineCount, gained, streak: engine.streak,
    over: engine.over,
  });
}

function boardCenter(view) {
  return [view.boardX + view.boardSize / 2, view.boardY + view.boardSize * 0.42];
}

function burst(view, r, c, colorIndex) {
  view.particles.burstCell(
    view.boardX + (c + 0.5) * view.cell,
    view.boardY + (r + 0.5) * view.cell,
    view.cell, colorIndex, view.fxId,
  );
}

// Density of every row and column (used by 破壊の衝撃波).
function densities(engine) {
  const rows = [], cols = [];
  for (let i = 0; i < SIZE; i++) { rows.push({ i, n: 0 }); cols.push({ i, n: 0 }); }
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (engine.grid[r * SIZE + c]) { rows[r].n++; cols[c].n++; }
  }
  return { rows, cols };
}

// Scratch-board helpers for 🌈 (planning ahead without touching the real grid).
function simCanPlace(sim, cells, row, col) {
  for (const [dr, dc] of cells) {
    const r = row + dr, c = col + dc;
    if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return false;
    if (sim.grid[r * SIZE + c] !== 0) return false;
  }
  return true;
}

// Play a piece on the scratch board and resolve any lines it completes.
function simPlace(sim, cells, row, col, color) {
  for (const [dr, dc] of cells) sim.grid[(row + dr) * SIZE + col + dc] = color;
  const fullRows = [], fullCols = [];
  for (let r = 0; r < SIZE; r++) {
    let full = true;
    for (let c = 0; c < SIZE; c++) if (!sim.grid[r * SIZE + c]) { full = false; break; }
    if (full) fullRows.push(r);
  }
  for (let c = 0; c < SIZE; c++) {
    let full = true;
    for (let r = 0; r < SIZE; r++) if (!sim.grid[r * SIZE + c]) { full = false; break; }
    if (full) fullCols.push(c);
  }
  for (const r of fullRows) for (let c = 0; c < SIZE; c++) sim.grid[r * SIZE + c] = 0;
  for (const c of fullCols) for (let r = 0; r < SIZE; r++) sim.grid[r * SIZE + c] = 0;
}

// Best placement for a given shape: prefers completing lines, then coverage.
function scorePlacement(engine, cells, row, col) {
  const touched = new Set();
  for (const [dr, dc] of cells) touched.add((row + dr) * SIZE + col + dc);
  let lines = 0;
  const rowsSeen = new Set(cells.map(([dr]) => row + dr));
  const colsSeen = new Set(cells.map(([, dc]) => col + dc));
  for (const r of rowsSeen) {
    let full = true;
    for (let c = 0; c < SIZE; c++) if (!engine.grid[r * SIZE + c] && !touched.has(r * SIZE + c)) { full = false; break; }
    if (full) lines++;
  }
  for (const c of colsSeen) {
    let full = true;
    for (let r = 0; r < SIZE; r++) if (!engine.grid[r * SIZE + c] && !touched.has(r * SIZE + c)) { full = false; break; }
    if (full) lines++;
  }
  return lines * 1000 + cells.length;
}

// ---------------------------------------------------------------------------
// Skill implementations
// ---------------------------------------------------------------------------

const EFFECTS = {
  // 💥 Force-clear the two fullest rows and the two fullest columns.
  ult_blast(ctx) {
    const { engine, view } = ctx;
    const { rows, cols } = densities(engine);
    const pickRows = rows.filter(r => r.n > 0).sort((a, b) => b.n - a.n).slice(0, 2).map(r => r.i);
    const pickCols = cols.filter(c => c.n > 0).sort((a, b) => b.n - a.n).slice(0, 2).map(c => c.i);
    if (!pickRows.length && !pickCols.length) return { error: t('盤面が空です！', 'The board is empty!') };
    const res = clearLines(engine, pickRows, pickCols);
    view.shake = 18;
    view.screenFlash = 0.5;
    audio.bossAttack();
    emit(ctx, { ...res, rows: pickRows, cols: pickCols });
    return { msg: t('💥 破壊の衝撃波！盤面を薙ぎ払った！', '💥 Destruction Shockwave — the board is swept clean!') };
  },

  // 🌊 Wipe every garbage cell plus the bottom two rows.
  ult_purify(ctx) {
    const { engine, view } = ctx;
    const garbage = cellsOf(engine, v => v === 9);
    for (const [r, c] of garbage) { engine.grid[r * SIZE + c] = 0; burst(view, r, c, 9); }
    // 下2行のうち、実際にブロックが残っている行だけを消す。空の行を無条件に
    // 消していたため、下2行が空でも lineCount=2 として400点×コンボ倍率＋
    // streak＋linesCleared が入っていた。
    const rows = [SIZE - 2, SIZE - 1].filter(r => {
      for (let c = 0; c < SIZE; c++) if (engine.grid[r * SIZE + c] !== 0) return true;
      return false;
    });
    // お邪魔も無く消せる行も無いなら、他の盤面系奥義と同じくゲージを温存する。
    if (!garbage.length && !rows.length) return { error: t('盤面が空です！', 'The board is empty!') };
    const res = rows.length
      ? clearLines(engine, rows, [])
      : { rows: [], cols: [], clearedCells: [], lineCount: 0, gained: 0 };
    const bonus = awardPoints(engine, garbage.length * 60);
    view.reviveFlash();
    view.screenFlash = 0.4;
    audio.coin();
    emit(ctx, { ...res, gained: res.gained + bonus, rows });
    return { msg: t(`🌊 浄化の波動！お邪魔${garbage.length}個を消し飛ばした！`, `🌊 Purifying Wave — ${garbage.length} garbage cells erased!`) };
  },

  // 🔥 Triple score for 15 seconds.
  ult_overdrive(ctx) {
    const { engine, view } = ctx;
    // こちらも同じ。弱いフィーバーが先に効いていても ×3 まで引き上げるだけで、
    // 残り時間も短いほうに切り詰めない。
    const on = engine.feverUntil > Date.now();
    engine.feverMult = Math.max(on ? (engine.feverMult || 1) : 1, 3);
    engine.feverUntil = Math.max(engine.feverUntil || 0, Date.now() + 15000);
    view.screenFlash = 0.45;
    audio.combo(8);
    document.querySelector('#hudScore').classList.add('fever');
    // Fires 15s later, by which time the run may be over and a NEW run (with a
    // new engine) may be on screen — leaving the old score glowing gold and
    // resetting a multiplier that belongs to nobody. Both effects expire on
    // their own via feverUntil, so the timeout only has to tidy up, and only
    // if it is still the same run.
    setTimeout(() => {
      // 発動した run のフィーバーが切れていれば、その run のズレた倍率を戻す。
      if (engine.feverUntil <= Date.now()) engine.feverMult = 2;
      // 金色グローは「今表示中のエンジン」がフィーバー中でなければ外す。
      // 発動 run が15秒以内に終わって別 run（別エンジン）が始まっていても
      // 確実に掃除する ── 以前は発動エンジンとの同一性で判定していたため、
      // 新 run では金色が固着していた。
      const cur = window.__bbaMode && window.__bbaMode.engine;
      const inFever = cur && cur.feverUntil > Date.now();
      if (!inFever) {
        const el = document.querySelector('#hudScore');
        if (el) el.classList.remove('fever');
      }
    }, 15000);
    const [cx, cy] = boardCenter(view);
    view.addFloatText(cx, cy, 'OVERDRIVE!', '#ff5d5d', 2);
    view.particles.confetti(cx, cy, view.cell, 60);
    return { msg: t('🔥 オーバードライブ！15秒間スコア3倍！！', '🔥 OVERDRIVE! Triple score for 15 seconds!!') };
  },

  // ☄️ Shatter 14 random filled cells.
  ult_meteor(ctx) {
    const { engine, view } = ctx;
    const filled = cellsOf(engine, v => v !== 0);
    if (!filled.length) return { error: t('盤面が空です！', 'The board is empty!') };
    for (let i = filled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filled[i], filled[j]] = [filled[j], filled[i]];
    }
    const hit = filled.slice(0, 14);
    for (const [r, c, v] of hit) {
      engine.grid[r * SIZE + c] = 0;
      burst(view, r, c, v);
      view.particles.ring(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell * 1.8, '#ff6bd4');
    }
    const gained = awardPoints(engine, hit.length * 90);
    view.shake = 20;
    view.screenFlash = 0.5;
    audio.bossAttack();
    emit(ctx, { clearedCells: hit, gained, anchor: [hit[0][0], hit[0][1]] });
    return { msg: t(`☄️ メテオストライク！${hit.length}マスを粉砕！`, `☄️ Meteor Strike — ${hit.length} cells obliterated!`) };
  },

  // 🌈 Rebuild the hand out of the three best-fitting pieces available.
  // Each pick is chosen against the board as it would look *after* the
  // previous pick is played, so the three pieces chain instead of repeating.
  ult_rainbow(ctx) {
    const { engine, view } = ctx;
    const sim = { grid: engine.grid.slice() };
    const hand = [];
    for (let slot = 0; slot < 3; slot++) {
      let best = null, bestScore = -1, bestAt = null;
      for (let si = 0; si < SHAPES.length; si++) {
        const cells = SHAPES[si].cells;
        const { rows, cols } = shapeSize(cells);
        for (let r = 0; r <= SIZE - rows; r++) for (let c = 0; c <= SIZE - cols; c++) {
          if (!simCanPlace(sim, cells, r, c)) continue;
          const sc = scorePlacement(sim, cells, r, c);
          if (sc > bestScore) { bestScore = sc; best = si; bestAt = [r, c]; }
        }
      }
      if (best === null) break;
      hand.push({ shape: best, cells: SHAPES[best].cells, color: SHAPES[best].color });
      simPlace(sim, SHAPES[best].cells, bestAt[0], bestAt[1], SHAPES[best].color);
    }
    if (!hand.length) return { error: t('置ける場所がありません！', 'Nowhere left to place!') };
    while (hand.length < 3) hand.push(engine.drawPiece());
    engine.hand = hand;
    if (engine.over && engine.hasAnyMove()) engine.over = false;
    view.reviveFlash();
    audio.coin();
    const [cx, cy] = boardCenter(view);
    view.addFloatText(cx, cy, 'RAINBOW HAND!', '#5ee86e', 1.8);
    return { msg: t('🌈 レインボーハンド！最適なピースが降ってきた！', '🌈 Rainbow Hand — perfect pieces, delivered!') };
  },

  // 🛡️ 30 seconds of combo shield + garbage immunity.
  ult_fortress(ctx) {
    const { engine, view } = ctx;
    engine.fortressUntil = Date.now() + 30000;
    view.screenFlash = 0.35;
    view.reviveFlash();
    audio.combo(5);
    const [cx, cy] = boardCenter(view);
    view.addFloatText(cx, cy, 'FORTRESS!', '#9fd8ff', 1.8);
    return { msg: t('🛡️ 不落の城塞！30秒間コンボ継続＆妨害無効！', '🛡️ Impregnable Fortress — 30s of combo shield and garbage immunity!') };
  },

  // ⏳ Buys time, in whatever currency the current mode uses.
  ult_timestop(ctx) {
    const { engine, view, mode } = ctx;
    let msg;
    if (mode && mode.endAt && mode.timerInt) {
      mode.endAt += 12000;
      mode.timeLeft = Math.max(0, (mode.endAt - Date.now()) / 1000);
      mode.updateTimerHud && mode.updateTimerHud();
      msg = t('⏳ 時間停止！制限時間+12秒！', '⏳ Time Stop — +12 seconds!');
    } else if (mode && mode.nextAtk) {
      mode.nextAtk += 20000;
      msg = t('⏳ 時間停止！ボスの攻撃を20秒封印！', '⏳ Time Stop — the boss is frozen for 20s!');
    } else if (mode && mode.nextAt) {
      mode.nextAt += 20000;
      msg = t('⏳ 時間停止！次の波を20秒遅らせた！', '⏳ Time Stop — the next wave is delayed 20s!');
    } else {
      engine.rerolls += 3;
      msg = t('⏳ 時間停止！リロール+3！', '⏳ Time Stop — +3 rerolls!');
    }
    view.screenFlash = 0.4;
    audio.combo(7);
    const [cx, cy] = boardCenter(view);
    view.addFloatText(cx, cy, 'TIME STOP!', '#b06bff', 1.8);
    return { msg };
  },

  // ⚡ Annihilate the whole board for an enormous payout.
  ult_judgement(ctx) {
    const { engine, view } = ctx;
    const filled = cellsOf(engine, v => v !== 0);
    if (!filled.length) return { error: t('盤面が空です！', 'The board is empty!') };
    for (const [r, c, v] of filled) {
      engine.grid[r * SIZE + c] = 0;
      burst(view, r, c, v);
    }
    engine.streak += 2;
    if (engine.streak > engine.maxCombo) engine.maxCombo = engine.streak;
    engine.linesCleared += 4;
    const comboMult = 1 + 0.5 * (engine.streak - 1);
    const gained = awardPoints(engine, filled.length * 130 + 1600 * comboMult);
    view.shake = 24;
    view.screenFlash = 0.75;
    audio.bossDefeated();
    const [cx, cy] = boardCenter(view);
    view.particles.ring(cx, cy, view.boardSize, '#fff3b0');
    view.particles.confetti(cx, cy, view.cell, 90);
    emit(ctx, { clearedCells: filled, gained, anchor: [filled[0][0], filled[0][1]] });
    return { msg: t('⚡ 神の裁き！！盤面が消滅した！！', '⚡ DIVINE JUDGEMENT — the board is no more!!') };
  },

  // 👁️ 断罪の一撃。いちばん埋まった縦1列と横1列を、埋まり具合に関係なく
  // 問答無用で消し飛ばす ── 断罪の「通るか通らないか」をそのまま持ち込んだ技。
  // 消える量は多くないが、狙った1列を必ず通せるのが値打ち。
  ult_condemn(ctx) {
    const { engine, view } = ctx;
    const { rows, cols } = densities(engine);
    const row = rows.filter(r => r.n > 0).sort((a, b) => b.n - a.n)[0];
    const col = cols.filter(c => c.n > 0).sort((a, b) => b.n - a.n)[0];
    if (!row && !col) return { error: t('盤面が空です！', 'The board is empty!') };
    const res = clearLines(engine, row ? [row.i] : [], col ? [col.i] : []);
    // 断罪は通れば必ず刺さる。コンボを1つぶん確実に繋ぐのがその表現。
    engine.streak += 1;
    if (engine.streak > engine.maxCombo) engine.maxCombo = engine.streak;
    view.shake = 20;
    view.screenFlash = 0.6;
    audio.bossAttack();
    const [cx, cy] = boardCenter(view);
    view.particles.ring(cx, cy, view.boardSize * 0.7, '#e03546');
    emit(ctx, { ...res, rows: row ? [row.i] : [], cols: col ? [col.i] : [] });
    return { msg: t('👁️ 断罪の一撃！ 縦横を斬り抜いた！', '👁️ Condemnation — cut clean through!') };
  },

  // 👑 Staff-only: judgement, and the gauge refills instantly.
  ult_admin(ctx) {
    const out = EFFECTS.ult_judgement(ctx);
    // 呼び出し元 fireUltCurrent は fireUlt の直後に consumeUlt() でゲージを
    // 0 に戻すため、ここで同期的に 100 にしても即座に消される。消費のあとに
    // 効くよう次のタスクで再充填し、トーストの「ゲージ再充填」を実態に一致させる。
    setTimeout(() => { ctx.engine.ult = 100; }, 0);
    if (out.error) {
      return { msg: t('👑 全能：ゲージを再充填した', '👑 Omnipotence: gauge refilled') };
    }
    return { msg: t('👑 全能！！盤面消滅＋ゲージ再充填！', '👑 OMNIPOTENCE — board erased, gauge refilled!') };
  },
};

// Fire the equipped ultimate. Returns { msg } on success or { error } when the
// skill could not do anything (the gauge is NOT spent in that case).
export function fireUlt(id, ctx) {
  const fn = EFFECTS[id] || EFFECTS[DEFAULT_ULT];
  return fn(ctx) || {};
}

export function ultExists(id) { return !!EFFECTS[id]; }
