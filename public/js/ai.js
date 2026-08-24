// Heuristic AI player for VS mode. Plays its own Engine instance.
import { SIZE, SHAPES, shapeSize } from './engine.js';

export const AI_LEVELS = {
  easy:   { name: '見習い', nameEn: 'Novice',  moveMs: 2600, noise: 0.5,  lookahead: false, avatar: '🤖' },
  normal: { name: '戦士',   nameEn: 'Warrior', moveMs: 1700, noise: 0.15, lookahead: false, avatar: '🦾' },
  hard:   { name: '達人',   nameEn: 'Master',  moveMs: 1100, noise: 0.02, lookahead: true,  avatar: '👑' },
  oni:    { name: '鬼',     nameEn: 'Oni',     moveMs: 700,  noise: 0,    lookahead: true,  deep: true, avatar: '👹' },
  // Hidden difficulty: only revealed by the secret command (↑↑↓↓←→←→BA / title x10).
  kami:   { name: '神',     nameEn: 'Kami',    moveMs: 520,  noise: 0,    exhaustive: true, avatar: '🔱', secret: true },
  // TRUE hidden difficulty: ultra-secret command only (↑↑↓↓←→←→BABA↓↑↓↑).
  souzou: { name: '創造神', nameEn: 'Creator God', moveMs: 380, noise: 0, exhaustive: true, beam: 14, avatar: '🌌', secret: true },
};

// Evaluate the grid after a hypothetical placement.
function evaluateGrid(grid) {
  let score = 0;
  let empty = 0;

  // Penalty for isolated empty cells (hard to fill).
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const k = r * SIZE + c;
      if (grid[k] !== 0) continue;
      empty++;
      let blockedSides = 0;
      if (r === 0 || grid[(r - 1) * SIZE + c]) blockedSides++;
      if (r === SIZE - 1 || grid[(r + 1) * SIZE + c]) blockedSides++;
      if (c === 0 || grid[r * SIZE + (c - 1)]) blockedSides++;
      if (c === SIZE - 1 || grid[r * SIZE + (c + 1)]) blockedSides++;
      if (blockedSides === 4) score -= 60;        // sealed hole
      else if (blockedSides === 3) score -= 18;   // pocket
    }
  }

  // Prefer keeping large open area.
  score += empty * 2;

  // Bumpiness: transitions between filled/empty cost flexibility.
  let transitions = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE - 1; c++) {
    if ((grid[r * SIZE + c] === 0) !== (grid[r * SIZE + c + 1] === 0)) transitions++;
  }
  for (let c = 0; c < SIZE; c++) for (let r = 0; r < SIZE - 1; r++) {
    if ((grid[r * SIZE + c] === 0) !== (grid[(r + 1) * SIZE + c] === 0)) transitions++;
  }
  score -= transitions * 2.2;

  return score;
}

// Simulate placing piece at (row, col) on a copy; returns { grid, lines }.
function simulate(grid, piece, row, col) {
  const g = grid.slice();
  for (const [dr, dc] of piece.cells) g[(row + dr) * SIZE + (col + dc)] = piece.color;
  const fullRows = [], fullCols = [];
  for (let r = 0; r < SIZE; r++) {
    let full = true;
    for (let c = 0; c < SIZE; c++) if (g[r * SIZE + c] === 0) { full = false; break; }
    if (full) fullRows.push(r);
  }
  for (let c = 0; c < SIZE; c++) {
    let full = true;
    for (let r = 0; r < SIZE; r++) if (g[r * SIZE + c] === 0) { full = false; break; }
    if (full) fullCols.push(c);
  }
  for (const r of fullRows) for (let c = 0; c < SIZE; c++) g[r * SIZE + c] = 0;
  for (const c of fullCols) for (let r = 0; r < SIZE; r++) g[r * SIZE + c] = 0;
  return { grid: g, lines: fullRows.length + fullCols.length };
}

// Best achievable single-placement value for a piece on a given grid.
function bestPlacementValue(grid, piece) {
  let rows = 0, cols = 0;
  for (const [r, c] of piece.cells) { rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1); }
  let best = -500; // no placement possible -> heavy penalty
  for (let r = 0; r <= SIZE - rows; r++) {
    for (let c = 0; c <= SIZE - cols; c++) {
      let ok = true;
      for (const [dr, dc] of piece.cells) {
        if (grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
      }
      if (!ok) continue;
      const sim = simulate(grid, piece, r, c);
      const v = sim.lines * 900 + evaluateGrid(sim.grid);
      if (v > best) best = v;
    }
  }
  return best;
}

function countPlacements(grid, piece) {
  let n = 0;
  let rows = 0, cols = 0;
  for (const [r, c] of piece.cells) { rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1); }
  outer:
  for (let r = 0; r <= SIZE - rows; r++) {
    for (let c = 0; c <= SIZE - cols; c++) {
      let ok = true;
      for (const [dr, dc] of piece.cells) {
        if (grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
      }
      if (ok) n++;
    }
  }
  return n;
}

// Kami-level beam search: explores placements of the WHOLE hand in every order,
// keeping the best BEAM states per depth. Returns the first move of the best line.
// Probe shapes used to measure how "open" a final grid stays for future pieces.
const PROBES = [
  [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]], // 3x3
  [[0,0],[0,1],[0,2],[0,3],[0,4]],                          // 1x5
  [[0,0],[1,0],[2,0],[3,0],[4,0]],                          // 5x1
  [[0,0],[0,1],[1,0],[1,1]],                                // 2x2
];

function openness(grid) {
  let score = 0;
  for (const cells of PROBES) {
    let rows = 0, cols = 0;
    for (const [r, c] of cells) { rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1); }
    let n = 0;
    for (let r = 0; r <= SIZE - rows; r++) {
      for (let c = 0; c <= SIZE - cols; c++) {
        let ok = true;
        for (const [dr, dc] of cells) {
          if (grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
        }
        if (ok && ++n >= 10) break;
      }
      if (n >= 10) break;
    }
    score += n === 0 ? -120 : n * 9;
  }
  return score;
}

function beamSearch(engine, beamWidth = 10) {
  const BEAM = beamWidth;
  const handIdx = [];
  for (let i = 0; i < engine.hand.length; i++) if (engine.hand[i]) handIdx.push(i);
  if (!handIdx.length) return null;

  let states = [{ grid: engine.grid, used: 0, lines: 0, first: null, value: -Infinity }];
  for (let depth = 0; depth < handIdx.length; depth++) {
    const next = [];
    for (const st of states) {
      for (const i of handIdx) {
        if (st.used & (1 << i)) continue;
        const piece = engine.hand[i];
        let rows = 0, cols = 0;
        for (const [r, c] of piece.cells) { rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1); }
        for (let r = 0; r <= SIZE - rows; r++) {
          for (let c = 0; c <= SIZE - cols; c++) {
            let ok = true;
            for (const [dr, dc] of piece.cells) {
              if (st.grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
            }
            if (!ok) continue;
            const sim = simulate(st.grid, piece, r, c);
            const lines = st.lines + sim.lines;
            next.push({
              grid: sim.grid, used: st.used | (1 << i), lines,
              first: st.first || { index: i, row: r, col: c },
              value: lines * 900 + evaluateGrid(sim.grid),
            });
          }
        }
      }
    }
    if (!next.length) break;   // stuck mid-sequence — keep the best line so far
    next.sort((a, b) => b.value - a.value);
    states = next.slice(0, BEAM);
    // At the final depth, re-rank survivors by how open the board stays.
    if (depth === handIdx.length - 1) {
      for (const st of states) st.value += openness(st.grid);
      states.sort((a, b) => b.value - a.value);
    }
  }
  return states[0] ? states[0].first : null;
}

// ---------------------------------------------------------------------------
// Autopilot 5.0 — ♾️不滅 (Immortal) brain.
// Survival-first full-hand beam search. Differences from the souzou beam:
//  - survival pressure is applied WHILE pruning (souzou only re-ranks the
//    survivors at the very end, so safe lines are often discarded early)
//  - lines that strand a hand piece are heavily punished instead of being
//    silently kept "as the best line so far"
//  - the final board (= the refill boundary, where a random hand of 3 arrives)
//    is scored by the draw-weight share of shapes that could no longer be
//    placed anywhere — the direct proxy for "can the next hand kill me?"
// ---------------------------------------------------------------------------

const SHAPE_FITS = SHAPES.map(s => {
  const { rows, cols } = shapeSize(s.cells);
  return { cells: s.cells, rows, cols, w: s.w };
});
const AI_TOTAL_W = SHAPES.reduce((a, s) => a + s.w, 0);

function fitsAnywhere(grid, f) {
  for (let r = 0; r <= SIZE - f.rows; r++) {
    for (let c = 0; c <= SIZE - f.cols; c++) {
      let ok = true;
      for (const [dr, dc] of f.cells) {
        if (grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}

// Draw-weight share (0..1) of shapes that no longer fit anywhere. Game over is
// a refill hand of 3 with no fits, so death probability ≈ (this share)³.
export function missingDrawWeight(grid) {
  let missing = 0;
  for (const f of SHAPE_FITS) if (!fitsAnywhere(grid, f)) missing += f.w;
  return missing / AI_TOTAL_W;
}

// Cheap mid-depth probes: losing the 3x3 pocket or both long lanes is what
// actually corners a board, so tax those states before they enter the beam.
const RISK_PROBES = [
  { cells: [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]], rows: 3, cols: 3, pen: 1500 },
  { cells: [[0,0],[0,1],[0,2],[0,3],[0,4]], rows: 1, cols: 5, pen: 450 },
  { cells: [[0,0],[1,0],[2,0],[3,0],[4,0]], rows: 5, cols: 1, pen: 450 },
];

function quickRisk(grid) {
  let risk = 0;
  for (const p of RISK_PROBES) if (!fitsAnywhere(grid, p)) risk += p.pen;
  return risk;
}

// Style layer for the immortal brain: weights inside the search, never a
// single-ply override on top of it.
const IMMORTAL_STYLES = {
  normal: { line: 900,  survive: 5200, open: 1,   future: 4500 },
  combo:  { line: 1500, survive: 4200, open: 1,   future: 3800 },
  clear:  { line: 900,  survive: 4600, open: 1,   future: 4200, empty: 6 },
  safe:   { line: 700,  survive: 8000, open: 1.4, future: 7000, empty: 3 },
};

const popcount = x => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Weighted random shape (same distribution the engine draws from).
function sampleShapeFit() {
  let roll = Math.random() * AI_TOTAL_W;
  for (let i = 0; i < SHAPE_FITS.length; i++) {
    roll -= SHAPE_FITS[i].w;
    if (roll <= 0) return SHAPE_FITS[i];
  }
  return SHAPE_FITS[0];
}

// Can this 3-piece hand be fully placed (clears included, any order/anchor)?
// Bounded DFS: running out of budget counts as "no" — that only happens on
// tight boards, where pessimism is exactly what we want.
function canPlaceHand(grid, fits, budget) {
  if (!fits.length) return true;
  if (budget.n <= 0) return false;
  for (let i = 0; i < fits.length; i++) {
    const f = fits[i];
    for (let r = 0; r <= SIZE - f.rows && budget.n > 0; r++) {
      for (let c = 0; c <= SIZE - f.cols && budget.n > 0; c++) {
        let ok = true;
        for (const [dr, dc] of f.cells) {
          if (grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
        }
        if (!ok) continue;
        budget.n--;
        const sim = simulate(grid, { cells: f.cells, color: 1 }, r, c);
        const rest = fits.slice(0, i).concat(fits.slice(i + 1));
        if (canPlaceHand(sim.grid, rest, budget)) return true;
      }
    }
  }
  return false;
}

// Fraction of sampled future hands that survive on this board (0..1).
function futureSurvivalRate(grid, sampledHands) {
  let ok = 0;
  for (const hand of sampledHands) {
    if (canPlaceHand(grid, hand, { n: 70 })) ok++;
  }
  return ok / sampledHands.length;
}

const FUTURE_HANDS = 12;   // sampled refills scored per candidate final board

let beamAuto = 26;   // self-tunes to the device so x32 ticks never fall behind

export function planImmortalMove(engine, style = 'normal') {
  const t0 = nowMs();
  const W = IMMORTAL_STYLES[style] || IMMORTAL_STYLES.normal;
  const handIdx = [];
  for (let i = 0; i < engine.hand.length; i++) if (engine.hand[i]) handIdx.push(i);
  if (!handIdx.length) {
    return { move: null, stranded: 0, missingW: missingDrawWeight(engine.grid), ms: 0 };
  }

  let states = [{ grid: engine.grid, used: 0, lines: 0, first: null, value: 0 }];
  const deadEnds = [];   // lines where some hand piece can never be placed
  let completed = true;
  for (let depth = 0; depth < handIdx.length; depth++) {
    const next = [];
    for (const st of states) {
      let children = 0;
      for (const i of handIdx) {
        if (st.used & (1 << i)) continue;
        const piece = engine.hand[i];
        const { rows, cols } = shapeSize(piece.cells);
        for (let r = 0; r <= SIZE - rows; r++) {
          for (let c = 0; c <= SIZE - cols; c++) {
            let ok = true;
            for (const [dr, dc] of piece.cells) {
              if (st.grid[(r + dr) * SIZE + (c + dc)] !== 0) { ok = false; break; }
            }
            if (!ok) continue;
            const sim = simulate(st.grid, piece, r, c);
            const lines = st.lines + sim.lines;
            children++;
            next.push({
              grid: sim.grid, used: st.used | (1 << i), lines,
              first: st.first || { index: i, row: r, col: c },
              value: lines * W.line + evaluateGrid(sim.grid),
            });
          }
        }
      }
      if (!children && st.first) deadEnds.push(st);
    }
    if (!next.length) { completed = false; break; }
    // Two-stage prune: cheap value first, then survival probes on the
    // shortlist — safe lines reach the beam BEFORE they can be discarded.
    next.sort((a, b) => b.value - a.value);
    const shortlist = next.slice(0, Math.max(beamAuto * 3, 36));
    for (const st of shortlist) st.value -= quickRisk(st.grid);
    shortlist.sort((a, b) => b.value - a.value);
    states = shortlist.slice(0, beamAuto);
    if (depth === handIdx.length - 1) {
      for (const st of states) {
        st.missing = missingDrawWeight(st.grid);
        st.value += openness(st.grid) * W.open
          - st.missing * W.survive
          - (st.missing > 0.45 ? 2600 : 0);
        if (W.empty) {
          let e0 = 0;
          for (let k = 0; k < SIZE * SIZE; k++) if (!st.grid[k]) e0++;
          st.value += e0 * W.empty;
        }
      }
      states.sort((a, b) => b.value - a.value);
      // Expectimax-lite: play the SAME sampled refills against each finalist
      // board and score the survival rate directly. This is what per-shape
      // fit checks can't see — three pieces that fit alone but not together.
      const finalists = states.slice(0, Math.min(states.length, 10));
      const hands = [];
      for (let h = 0; h < FUTURE_HANDS; h++) {
        hands.push([sampleShapeFit(), sampleShapeFit(), sampleShapeFit()]);
      }
      for (const st of finalists) {
        st.value += (futureSurvivalRate(st.grid, hands) - 1) * W.future;
      }
      finalists.sort((a, b) => b.value - a.value);
      states = finalists;
    }
  }

  let best = completed && states[0] && states[0].first ? states[0] : null;
  let stranded = 0;
  if (!best && deadEnds.length) {
    // No order places the whole hand. Take the line that strands the fewest
    // pieces and leaves the safest board — the guard layer handles the rest.
    for (const st of deadEnds) st.left = handIdx.length - popcount(st.used);
    deadEnds.sort((a, b) => (a.left - b.left) || (b.value - a.value));
    const top = deadEnds.slice(0, 6);
    for (const st of top) {
      st.missing = missingDrawWeight(st.grid);
      st.value -= st.missing * W.survive;
    }
    top.sort((a, b) => (a.left - b.left) || (b.value - a.value));
    best = top[0];
    stranded = best.left;
  }

  const ms = nowMs() - t0;
  if (ms > 10 && beamAuto > 12) beamAuto -= 2;
  else if (ms < 5 && beamAuto < 40) beamAuto += 1;

  return {
    move: best ? best.first : null,
    stranded,
    missingW: best && best.missing != null ? best.missing : missingDrawWeight(engine.grid),
    ms,
  };
}

// Choose the AI's next move: { index, row, col } or null if stuck.
export function chooseMove(engine, level) {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  if (cfg.exhaustive) {
    const mv = beamSearch(engine, cfg.beam || 10);
    if (mv) return mv;
  }
  const candidates = [];

  for (let i = 0; i < engine.hand.length; i++) {
    const piece = engine.hand[i];
    if (!piece) continue;
    for (const [r, c] of engine.placements(piece)) {
      const sim = simulate(engine.grid, piece, r, c);
      let value = sim.lines * 900 + evaluateGrid(sim.grid);

      if (cfg.lookahead) {
        // Keep options open for the rest of the hand.
        let optionScore = 0;
        for (let j = 0; j < engine.hand.length; j++) {
          if (j === i || !engine.hand[j]) continue;
          const n = countPlacements(sim.grid, engine.hand[j]);
          optionScore += n === 0 ? -400 : Math.min(n, 20) * 6;
        }
        value += optionScore;
      }
      candidates.push({ index: i, row: r, col: c, value });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.value - a.value);

  // Oni: 2-step chain search — re-rank the top candidates by the best follow-up
  // placement value of each remaining hand piece.
  if (cfg.deep) {
    const top = candidates.slice(0, 8);
    for (const cand of top) {
      const piece = engine.hand[cand.index];
      const sim = simulate(engine.grid, piece, cand.row, cand.col);
      let chain = 0;
      for (let j = 0; j < engine.hand.length; j++) {
        if (j === cand.index || !engine.hand[j]) continue;
        chain += bestPlacementValue(sim.grid, engine.hand[j]);
      }
      cand.value += chain * 0.45;
    }
    top.sort((a, b) => b.value - a.value);
    return top[0];
  }

  // Noise: occasionally pick a weaker move.
  if (Math.random() < cfg.noise) {
    const pool = candidates.slice(0, Math.max(2, Math.ceil(candidates.length * 0.5)));
    return pool[(Math.random() * pool.length) | 0];
  }
  return candidates[0];
}
