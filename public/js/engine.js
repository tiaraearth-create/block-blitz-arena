// Pure game logic for Block Blitz — no DOM, no canvas.
// Seeded RNG so online battles share identical piece sequences.

export const SIZE = 8;

// mulberry32 — fast deterministic PRNG
export class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
}

// Shape definitions: cells as [row, col] offsets. Color is tied to the shape family.
function line(n, vertical) {
  const cells = [];
  for (let i = 0; i < n; i++) cells.push(vertical ? [i, 0] : [0, i]);
  return cells;
}

export const SHAPES = [
  { cells: [[0, 0]],                          color: 1, w: 5 },  // 1x1
  { cells: line(2, false),                    color: 2, w: 8 },
  { cells: line(2, true),                     color: 2, w: 8 },
  { cells: line(3, false),                    color: 3, w: 8 },
  { cells: line(3, true),                     color: 3, w: 8 },
  { cells: line(4, false),                    color: 4, w: 6 },
  { cells: line(4, true),                     color: 4, w: 6 },
  { cells: line(5, false),                    color: 5, w: 4 },
  { cells: line(5, true),                     color: 5, w: 4 },
  { cells: [[0,0],[0,1],[1,0],[1,1]],         color: 6, w: 9 },  // 2x2
  { cells: [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2]], color: 7, w: 5 }, // 2x3
  { cells: [[0,0],[1,0],[0,1],[1,1],[2,0],[2,1]], color: 7, w: 5 }, // 3x2
  { cells: [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]], color: 8, w: 3 }, // 3x3
  // L / J variants (2x2 corners)
  { cells: [[0,0],[1,0],[1,1]],               color: 1, w: 6 },
  { cells: [[0,1],[1,0],[1,1]],               color: 1, w: 6 },
  { cells: [[0,0],[0,1],[1,0]],               color: 1, w: 6 },
  { cells: [[0,0],[0,1],[1,1]],               color: 1, w: 6 },
  // Big L (3x3 corners)
  { cells: [[0,0],[1,0],[2,0],[2,1],[2,2]],   color: 2, w: 4 },
  { cells: [[0,2],[1,2],[2,0],[2,1],[2,2]],   color: 3, w: 4 },
  { cells: [[0,0],[0,1],[0,2],[1,0],[2,0]],   color: 4, w: 4 },
  { cells: [[0,0],[0,1],[0,2],[1,2],[2,2]],   color: 5, w: 4 },
  // T shapes
  { cells: [[0,0],[0,1],[0,2],[1,1]],         color: 6, w: 4 },
  { cells: [[1,0],[1,1],[1,2],[0,1]],         color: 6, w: 4 },
  { cells: [[0,0],[1,0],[2,0],[1,1]],         color: 7, w: 4 },
  { cells: [[0,1],[1,1],[2,1],[1,0]],         color: 7, w: 4 },
  // S / Z
  { cells: [[0,1],[0,2],[1,0],[1,1]],         color: 8, w: 3 },
  { cells: [[0,0],[0,1],[1,1],[1,2]],         color: 8, w: 3 },
];

const TOTAL_WEIGHT = SHAPES.reduce((a, s) => a + s.w, 0);

export function shapeSize(cells) {
  let rows = 0, cols = 0;
  for (const [r, c] of cells) { rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1); }
  return { rows, cols };
}

export class Engine {
  constructor(seed = (Math.random() * 2 ** 31) | 0) {
    this.rng = new Rng(seed);
    this.grid = new Array(SIZE * SIZE).fill(0);   // 0 empty, 1..8 color index
    this.hand = [null, null, null];
    this.score = 0;
    this.streak = 0;          // consecutive clearing placements
    this.linesCleared = 0;
    this.maxCombo = 0;
    this.piecesPlaced = 0;
    this.rerolls = 1;         // hand rerolls left this game
    this.scoreMult = 1;       // chaos-event score multiplier
    this.chaosBig = false;    // chaos-event: draw only big pieces
    this.over = false;
    this.refillHand();
  }

  // Replace the whole hand with fresh pieces (once per game power-up).
  reroll() {
    if (this.over || this.rerolls <= 0) return false;
    this.rerolls--;
    for (let i = 0; i < 3; i++) this.hand[i] = this.drawPiece();
    if (!this.hasAnyMove()) this.over = true;
    return true;
  }

  drawPiece() {
    if (this.chaosBig) {
      const bigs = [];
      for (let i = 0; i < SHAPES.length; i++) if (SHAPES[i].cells.length >= 5) bigs.push(i);
      const i = bigs[this.rng.int(bigs.length)];
      return { shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color };
    }
    let roll = this.rng.next() * TOTAL_WEIGHT;
    for (let i = 0; i < SHAPES.length; i++) {
      roll -= SHAPES[i].w;
      if (roll <= 0) return { shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color };
    }
    return { shape: 0, cells: SHAPES[0].cells, color: SHAPES[0].color };
  }

  refillHand() {
    if (this.hand.every(p => p === null)) {
      for (let i = 0; i < 3; i++) this.hand[i] = this.drawPiece();
    }
  }

  at(r, c) { return this.grid[r * SIZE + c]; }

  canPlace(piece, row, col) {
    for (const [dr, dc] of piece.cells) {
      const r = row + dr, c = col + dc;
      if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return false;
      if (this.grid[r * SIZE + c] !== 0) return false;
    }
    return true;
  }

  // All valid anchor positions for a piece.
  placements(piece) {
    const { rows, cols } = shapeSize(piece.cells);
    const out = [];
    for (let r = 0; r <= SIZE - rows; r++) {
      for (let c = 0; c <= SIZE - cols; c++) {
        if (this.canPlace(piece, r, c)) out.push([r, c]);
      }
    }
    return out;
  }

  hasAnyMove() {
    return this.hand.some(p => p && this.placements(p).length > 0);
  }

  // Place hand[index] at (row, col). Returns a result object for rendering/audio,
  // or null if the move is illegal.
  place(index, row, col) {
    const piece = this.hand[index];
    if (!piece || this.over || !this.canPlace(piece, row, col)) return null;

    const placedCells = [];
    for (const [dr, dc] of piece.cells) {
      const r = row + dr, c = col + dc;
      this.grid[r * SIZE + c] = piece.color;
      placedCells.push([r, c]);
    }
    this.hand[index] = null;
    this.piecesPlaced++;

    // Detect full rows / cols.
    const fullRows = [], fullCols = [];
    for (let r = 0; r < SIZE; r++) {
      let full = true;
      for (let c = 0; c < SIZE; c++) if (this.grid[r * SIZE + c] === 0) { full = false; break; }
      if (full) fullRows.push(r);
    }
    for (let c = 0; c < SIZE; c++) {
      let full = true;
      for (let r = 0; r < SIZE; r++) if (this.grid[r * SIZE + c] === 0) { full = false; break; }
      if (full) fullCols.push(c);
    }

    const clearedCells = [];
    const seen = new Set();
    for (const r of fullRows) for (let c = 0; c < SIZE; c++) {
      const k = r * SIZE + c;
      if (!seen.has(k)) { seen.add(k); clearedCells.push([r, c, this.grid[k]]); }
    }
    for (const c of fullCols) for (let r = 0; r < SIZE; r++) {
      const k = r * SIZE + c;
      if (!seen.has(k)) { seen.add(k); clearedCells.push([r, c, this.grid[k]]); }
    }
    for (const [r, c] of clearedCells) this.grid[r * SIZE + c] = 0;

    const lineCount = fullRows.length + fullCols.length;
    let gained = placedCells.length;               // 1 point per placed cell
    if (lineCount > 0) {
      this.streak++;
      const comboMult = 1 + 0.5 * (this.streak - 1);
      gained += Math.round(lineCount * lineCount * 100 * comboMult);
      this.linesCleared += lineCount;
      if (this.streak > this.maxCombo) this.maxCombo = this.streak;
    } else {
      this.streak = 0;
    }
    if (this.scoreMult !== 1) gained = Math.round(gained * this.scoreMult);
    this.score += gained;

    this.refillHand();
    if (!this.hasAnyMove()) this.over = true;

    return {
      placedCells, color: piece.color,
      fullRows, fullCols, clearedCells,
      lineCount, gained, streak: this.streak,
      over: this.over,
    };
  }

  // Fill n random empty cells with garbage (boss attacks). Returns the cells.
  addGarbage(n) {
    const empties = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (this.grid[r * SIZE + c] === 0) empties.push([r, c]);
    }
    const added = [];
    for (let i = 0; i < n && empties.length > 0; i++) {
      const k = Math.floor(this.rng.next() * empties.length);
      const [r, c] = empties.splice(k, 1)[0];
      this.grid[r * SIZE + c] = 9;
      added.push([r, c]);
    }
    if (!this.hasAnyMove()) this.over = true;
    return added;
  }

  // Reset the board but keep score — used in timed battles when a player tops out.
  reviveBoard() {
    this.grid.fill(0);
    this.streak = 0;
    this.over = false;
    this.hand = [null, null, null];
    this.refillHand();
  }

  // Compact grid snapshot (0..8 per cell) for network relay.
  snapshot() { return this.grid.slice(); }
}
