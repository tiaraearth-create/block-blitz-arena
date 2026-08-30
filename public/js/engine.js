// Pure game logic for Block Blitz — no DOM, no canvas.
// Seeded RNG so online battles share identical piece sequences.

export const SIZE = 8;

// grid のマス値。0=空 / 1..8=通常色 / 9=お邪魔 は既存の規則で、
// 10・11 はここで足した❄️氷結ブロックの2段耐久。
//   ICE(10)         … 揃った行・列に1つでもあると、その線は消えずに ICE_CRACKED へ降格する
//   ICE_CRACKED(11) … 通常のブロックとして消える（＝2回目のライン成立で消滅）
// 氷を盤に置くのはモード側の責務（e.grid[r * SIZE + c] = ICE）。
// 氷を1つも置かないモードでは grid に 10/11 が入らないので、
// resolveLines() の判定は素通りし、従来どおりの挙動になる。
export const ICE = 10;
export const ICE_CRACKED = 11;

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
    this.grid = new Array(SIZE * SIZE).fill(0);   // 0 empty, 1..8 color index, 9 garbage, 10/11 ice
    this.hand = [null, null, null];
    this.score = 0;
    this.streak = 0;          // consecutive clearing placements
    this.linesCleared = 0;
    this.maxCombo = 0;
    this.piecesPlaced = 0;
    this.rerolls = 1;         // hand rerolls left this game
    this.infiniteReroll = false; // chaos-event: rerolls cost nothing while active
    this.scoreMult = 1;       // chaos-event score multiplier
    this.feverUntil = 0;      // booster: timestamp until which score is multiplied
    this.feverMult = 2;       // 2 for the fever item, 3 for the overdrive ultimate
    this.chaosBig = false;    // chaos-event: draw only big pieces
    this.chaosMini = false;   // chaos-event: draw only tiny pieces
    this.comboBonusMult = 1;  // 📅 daily 'combo day': combo-bonus multiplier
    this.streakShield = false; // chaos-event: combo never breaks
    this.ult = 0;             // ultimate gauge, 0..100 (100 = ready)
    this.ultRate = 1;         // ⚡奥義祭 event: charge multiplier
    this.ultUses = 0;         // ultimates fired this game (reported to the server)
    this.fortressUntil = 0;   // ult_fortress: combo shield + garbage immunity
    this.over = false;
    this.refillHand();
  }

  // ---- Ultimate gauge ----------------------------------------------------
  // Fills from clears (and slowly from raw placements) so every mode can
  // reach it, but big combos get there dramatically faster.
  chargeUlt(n) {
    this.ult = Math.max(0, Math.min(100, this.ult + n * (this.ultRate || 1)));
    return this.ult;
  }

  get ultReady() { return this.ult >= 100; }

  // Spend a full gauge. Returns false when it isn't charged yet.
  consumeUlt() {
    if (this.ult < 100) return false;
    this.ult = 0;
    this.ultUses++;
    return true;
  }

  fortressActive() { return this.fortressUntil > Date.now(); }

  // Replace the whole hand with fresh pieces (once per game power-up).
  reroll() {
    if (this.over) return false;
    if (!this.infiniteReroll) {
      if (this.rerolls <= 0) return false;
      this.rerolls--;
    }
    for (let i = 0; i < 3; i++) this.hand[i] = this.drawPiece();
    if (!this.hasAnyMove()) this.over = true;
    return true;
  }

  drawPiece() {
    // 創造の手札 (staff item): the next draws are all big line-clearing shapes.
    if (this.godDraws > 0) {
      this.godDraws--;
      const bigs = [];
      for (let i = 0; i < SHAPES.length; i++) if (SHAPES[i].cells.length >= 5) bigs.push(i);
      const i = bigs[this.rng.int(bigs.length)];
      return { shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color };
    }
    if (this.chaosMini) {
      const minis = [];
      for (let i = 0; i < SHAPES.length; i++) if (SHAPES[i].cells.length <= 3) minis.push(i);
      const i = minis[this.rng.int(minis.length)];
      return { shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color };
    }
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

  // 満杯になった行・列を消して、消えたセルを返す。加点・コンボは呼び出し側の責任。
  // place() の中にしか無かったので、お邪魔ブロックや盤面の直書きで行が埋まっても
  // 消えずに居座り、そのあと無関係な1手を置いた人が「自分の手柄」として
  // 加点とコンボを受け取っていた。さらに消えないまま hasAnyMove() が走るので、
  // 本来は8マス空くはずの盤面で不当にゲームオーバー（バトルロイヤルでは脱落）になる。
  // 加点をここに入れないのは、妨害で埋まった行を消した分まで攻撃された側の
  // 得点にすると、攻撃が相手への贈り物になってしまうため。
  resolveLines() {
    // ❄️ 氷結: 揃った線に ICE(10) が1つでもあると、その線は消えず、
    // その線の氷が ICE_CRACKED(11) に降格するだけ。11 は普通に消える。
    // 氷は自分の行と列の両方を止めるので、「消える線」と「凍って止まった線」が
    // 交差するマスが氷になることはない ── だから降格と消去を同じ回で
    // まとめて処理しても取り合いにならない。
    const fullRows = [], fullCols = [];
    const frozenRows = [], frozenCols = [];
    const crackKeys = new Set();
    const crackedCells = [];

    for (let r = 0; r < SIZE; r++) {
      let full = true, ice = false;
      for (let c = 0; c < SIZE; c++) {
        const v = this.grid[r * SIZE + c];
        if (v === 0) { full = false; break; }
        if (v === ICE) ice = true;
      }
      if (!full) continue;
      if (!ice) { fullRows.push(r); continue; }
      frozenRows.push(r);
      for (let c = 0; c < SIZE; c++) {
        const k = r * SIZE + c;
        if (this.grid[k] === ICE && !crackKeys.has(k)) { crackKeys.add(k); crackedCells.push([r, c]); }
      }
    }
    for (let c = 0; c < SIZE; c++) {
      let full = true, ice = false;
      for (let r = 0; r < SIZE; r++) {
        const v = this.grid[r * SIZE + c];
        if (v === 0) { full = false; break; }
        if (v === ICE) ice = true;
      }
      if (!full) continue;
      if (!ice) { fullCols.push(c); continue; }
      frozenCols.push(c);
      for (let r = 0; r < SIZE; r++) {
        const k = r * SIZE + c;
        if (this.grid[k] === ICE && !crackKeys.has(k)) { crackKeys.add(k); crackedCells.push([r, c]); }
      }
    }
    // 行と列の両方を見終わってから書き換える。途中で降格させると、
    // 行で 11 にした氷を列の判定が「氷なし」と読んで列だけ消えてしまう。
    for (const k of crackKeys) this.grid[k] = ICE_CRACKED;

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

    // fullRows / fullCols / clearedCells / lineCount は「実際に消えた分」だけ。
    // 凍って消えなかった線は frozen* 側に出す（加点やコンボの扱いはモード側の責務）。
    return {
      fullRows, fullCols, clearedCells,
      lineCount: fullRows.length + fullCols.length,
      frozenRows, frozenCols,
      frozenCount: frozenRows.length + frozenCols.length,
      crackedCells,
    };
  }

  // 全列を下詰めして、ブロックを下端へ落とす（🧲 重力圧縮）。
  // 消去も加点もここではしない ── 呼び出し側が resolveLines() を回して
  // 通常の消去・加点経路にそのまま乗せられるようにするため。
  // 戻り値は実際に動いたマス数。0 なら盤面は1マスも変わっていない。
  compactDown() {
    let moved = 0;
    for (let c = 0; c < SIZE; c++) {
      let write = SIZE - 1;                       // 次にブロックを置く行（下から詰める）
      for (let r = SIZE - 1; r >= 0; r--) {
        const v = this.grid[r * SIZE + c];
        if (v === 0) continue;
        if (write !== r) {
          this.grid[write * SIZE + c] = v;
          this.grid[r * SIZE + c] = 0;
          moved++;
        }
        write--;
      }
    }
    return moved;
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

    const {
      fullRows, fullCols, clearedCells, lineCount,
      frozenRows, frozenCols, frozenCount, crackedCells,
    } = this.resolveLines();
    // 全消し「昇華」: この1手でラインを消し、その結果 盤面が完全に空になった。
    // 消去直後に見るのがポイント（このあと refillHand() が走っても grid は動かない）。
    const perfect = lineCount > 0 && this.grid.every(v => v === 0);
    let gained = placedCells.length;               // 1 point per placed cell
    if (lineCount > 0) {
      this.streak++;
      const comboMult = 1 + 0.5 * (this.streak - 1) * (this.comboBonusMult || 1);
      gained += Math.round(lineCount * lineCount * 100 * comboMult);
      this.linesCleared += lineCount;
      if (this.streak > this.maxCombo) this.maxCombo = this.streak;
      this.chargeUlt(lineCount * 13 + (this.streak - 1) * 4);
    } else if (!this.streakShield && !this.fortressActive()) {
      this.streak = 0;
    }
    this.chargeUlt(1.2);   // slow trickle so quiet boards still build toward it
    if (this.scoreMult !== 1) gained = Math.round(gained * this.scoreMult);
    if (this.feverUntil && Date.now() < this.feverUntil) gained = Math.round(gained * (this.feverMult || 2));
    this.score += gained;

    this.refillHand();
    if (!this.hasAnyMove()) this.over = true;

    return {
      placedCells, color: piece.color,
      fullRows, fullCols, clearedCells,
      lineCount, gained, streak: this.streak,
      perfect,
      // ❄️ 氷結を使わないモードでは frozenCount は常に 0、配列は常に空。
      frozenRows, frozenCols, frozenCount, crackedCells,
      over: this.over,
    };
  }

  // Fill n random empty cells with garbage (boss attacks). Returns the cells.
  // 戻り値は「置いたマス」。お邪魔で行が埋まった場合はこの中に
  // すぐ消えたマスも混ざる（呼び出し側の spawnAnim は空マスを描かないので無害）。
  addGarbage(n) {
    if (this.fortressActive()) return [];   // ult_fortress: interference is void
    const empties = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (this.grid[r * SIZE + c] === 0) empties.push([r, c]);
    }
    const added = [];
    for (let i = 0; i < n && empties.length > 0; i++) {
      // お邪魔マスの選択に共有シードRNG(this.rng)を使うと、攻撃を受けた側だけ
      // 乱数ストリームが進み、以後の drawPiece() のピース列が相手とズレて
      // 「同一シードのピース列を両者に配布」という公平化が崩れる。
      // 妨害配置は盤面公平性に無関係なので Math.random() を使う。
      const k = Math.floor(Math.random() * empties.length);
      const [r, c] = empties.splice(k, 1)[0];
      this.grid[r * SIZE + c] = 9;
      added.push([r, c]);
    }
    // お邪魔が行を完成させたらその場で消す。必ず hasAnyMove() より前に。
    // 順番が逆だと、消えれば8マス空いて続けられる盤面で over になる。
    this.resolveLines();
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

  // Compact grid snapshot (0..9 通常 / 10・11 は氷結モードのみ) for network relay.
  // 注意: server/battle.js の sanitizeGrid() は 9 までしか通さないので、
  // 対戦の相手ミニ盤面に氷を映したいならサーバー側の上限も上げる必要がある。
  snapshot() { return this.grid.slice(); }
}
