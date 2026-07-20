// Heuristic AI player for VS mode. Plays its own Engine instance.
import { SIZE } from './engine.js';

export const AI_LEVELS = {
  easy:   { name: 'かんたん', moveMs: 2600, noise: 0.5,  lookahead: false, avatar: '🤖' },
  normal: { name: 'ふつう',   moveMs: 1700, noise: 0.15, lookahead: false, avatar: '🦾' },
  hard:   { name: 'つよい',   moveMs: 1100, noise: 0.02, lookahead: true,  avatar: '👑' },
  // Hidden difficulty: unlocked by beating "hard" or tapping the AI modal title 5 times.
  oni:    { name: 'おに',     moveMs: 700,  noise: 0,    lookahead: true,  deep: true, avatar: '👹', secret: true },
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

// Choose the AI's next move: { index, row, col } or null if stuck.
export function chooseMove(engine, level) {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
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
