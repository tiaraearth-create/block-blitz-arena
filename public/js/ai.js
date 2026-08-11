// Heuristic AI player for VS mode. Plays its own Engine instance.
import { SIZE } from './engine.js';

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
