// GameView: canvas renderer + input controller for one board (player or spectator).
import { SIZE, shapeSize } from './engine.js';
import { PALETTE, getSkin, getBoard } from './themes.js';
import { ParticleSystem } from './particles.js';
import { audio } from './audio.js';
import { getSettings, particleFactor } from './settings.js';

export class GameView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = null;
    this.interactive = opts.interactive !== false;
    this.showTray = opts.showTray !== false;
    this.skinId = opts.skinId || 'skin_default';
    this.boardId = opts.boardId || 'board_default';
    this.fxId = opts.fxId || 'fx_default';

    this.particles = new ParticleSystem();
    this.spawnAnim = new Map();     // cellIndex -> spawn time
    this.dying = [];                // {r,c,color,t}
    this.flashes = [];              // {kind:'row'|'col', index, t}
    this.floatTexts = [];           // {x,y,text,color,t,life,size}
    this.shake = 0;
    this.time = 0;
    this.deco = [];                 // background decorations (stars etc.)

    this.drag = null;               // {index, piece, px, py}
    this.inputLocked = false;
    this.onPlace = null;            // callback(result)
    this.onIntentPlace = null;      // callback(index,row,col) -> true to take over the move
    this.onGameOver = null;
    this.onRescue = null;           // callback() -> true if a guard revived the board (autopilot 5.0)
    this.onIllegal = null;
    this.glowCells = null;          // Set of r*8+c a mode wants highlighted
    this.dangerCells = null;        // Set of r*8+c flashing red (boss attack telegraph)
    this.coolCells = null;          // Set of r*8+c pulsing cyan (meltdown coolant)
    this.onTrayDrop = null;         // callback(fromSlot, toSlot) -> true to handle (chimera weld)

    this.running = false;
    this.lastTs = 0;

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
    this.initDeco();

    if (this.interactive) this.bindInput();
  }

  destroy() {
    this.running = false;
    window.removeEventListener('resize', this._resize);
  }

  setEngine(engine) {
    this.engine = engine;
    this.spawnAnim.clear();
    this.dying.length = 0;
    this.flashes.length = 0;
    this.floatTexts.length = 0;
    this.particles.clear();
    this.drag = null;
    this.glowCells = null;
    this.dangerCells = null;
    this.coolCells = null;
  }

  setTheme({ skinId, boardId, fxId }) {
    if (skinId) this.skinId = skinId;
    if (boardId) this.boardId = boardId;
    if (fxId) this.fxId = fxId;
    this.initDeco();
  }

  // ------------------------------------------------------------------
  // Layout
  // ------------------------------------------------------------------

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.dpr = dpr;
    this.W = rect.width;
    this.H = rect.height;

    const trayH = this.showTray ? Math.min(this.H * 0.24, 130) : 0;
    const side = Math.min(this.W - 12, this.H - trayH - 16);
    this.cell = side / SIZE;
    this.boardX = (this.W - side) / 2;
    this.boardY = this.showTray ? 6 : (this.H - side) / 2;
    this.boardSize = side;
    this.trayY = this.boardY + side + 8;
    this.trayH = Math.max(0, this.H - this.trayY - 4);
  }

  initDeco() {
    const theme = getBoard(this.boardId);
    this.deco = [];
    const n = theme.nebula ? 70 : 40;
    for (let i = 0; i < n; i++) {
      this.deco.push({
        x: Math.random(), y: Math.random(),
        r: Math.random() * 1.8 + 0.4,
        tw: Math.random() * Math.PI * 2,
        sp: 0.3 + Math.random() * 1.2,
      });
    }
  }

  // ------------------------------------------------------------------
  // Input (drag & drop)
  // ------------------------------------------------------------------

  bindInput() {
    const pos = e => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.canvas.addEventListener('pointerdown', e => {
      if (!this.engine || this.engine.over || !this.running || this.inputLocked) return;
      const { x, y } = pos(e);
      const slot = this.trayHit(x, y);
      if (slot !== -1 && this.engine.hand[slot]) {
        // Boss curse: a frozen piece can't be picked up until the ice melts.
        if (this.engine.hand[slot].frozenUntil > Date.now()) {
          audio.invalid();
          return;
        }
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        this.drag = { index: slot, piece: this.engine.hand[slot], px: x, py: y };
        audio.pickup();
        e.preventDefault();
      }
    });

    this.canvas.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const { x, y } = pos(e);
      this.drag.px = x;
      this.drag.py = y;
    });

    const drop = e => {
      if (!this.drag) return;
      const { x, y } = pos(e);
      const anchor = this.dragAnchor();
      const { index } = this.drag;
      this.drag = null;
      // Chimera welding: the drag preview (drawDrag) uses the same predicate,
      // so whenever the weld highlight is showing, releasing welds — and
      // whenever a board ghost is showing, releasing places. Never both.
      const wslot = this.weldTargetAt(x, y, index);
      if (wslot !== -1 && this.onTrayDrop(index, wslot)) return;
      if (anchor && this.engine.canPlace(this.engine.hand[index], anchor.r, anchor.c)) {
        // Co-op runs on a server-authoritative board: the hook forwards the
        // move and returns true, and the real placement arrives as a broadcast.
        if (this.onIntentPlace && this.onIntentPlace(index, anchor.r, anchor.c)) return;
        const result = this.engine.place(index, anchor.r, anchor.c);
        if (result) this.applyResult(result);
      } else {
        audio.putback();
      }
    };
    this.canvas.addEventListener('pointerup', drop);
    this.canvas.addEventListener('pointercancel', () => { if (this.drag) { this.drag = null; audio.putback(); } });
  }

  trayHit(x, y) {
    if (!this.engine) return -1;
    const slotW = this.W / 3;
    if (y < this.trayY) return -1;
    return Math.max(0, Math.min(2, Math.floor(x / slotW)));
  }

  // Chimera: which tray slot a drag at (x,y) would weld onto, or -1.
  // Bottom-row placements hover the finger just past the tray's top edge, so
  // welding needs the finger clearly inside the tray.
  weldTargetAt(x, y, index) {
    if (!this.onTrayDrop || !this.engine) return -1;
    if (y <= this.trayY + Math.min(40, this.trayH * 0.3)) return -1;
    const slot = this.trayHit(x, y);
    if (slot === -1 || slot === index || !this.engine.hand[slot]) return -1;
    return slot;
  }

  // Current drag → board anchor cell (top-left of the piece), or null.
  dragAnchor() {
    if (!this.drag) return null;
    const { piece } = this.drag;
    const { rows, cols } = shapeSize(piece.cells);
    const pw = cols * this.cell, ph = rows * this.cell;
    // Piece floats above the pointer for finger visibility.
    const lift = this.cell * 1.2;
    const left = this.drag.px - pw / 2;
    const top = this.drag.py - ph - lift + ph / 2;
    const c = Math.round((left - this.boardX) / this.cell);
    const r = Math.round((top - this.boardY) / this.cell);
    if (r < -1 || c < -1 || r > SIZE || c > SIZE) return null;
    return { r: Math.max(0, Math.min(SIZE - rows, r)), c: Math.max(0, Math.min(SIZE - cols, c)) };
  }

  // ------------------------------------------------------------------
  // Game events
  // ------------------------------------------------------------------

  applyResult(result) {
    const now = this.time;
    this.particles.intensity = particleFactor();   // rAF may be throttled; set at emit time too
    for (const [r, c] of result.placedCells) this.spawnAnim.set(r * SIZE + c, now);
    audio.place();

    if (result.lineCount > 0) {
      for (const [r, c, color] of result.clearedCells) {
        this.dying.push({ r, c, color, t: now });
        const cx = this.boardX + (c + 0.5) * this.cell;
        const cy = this.boardY + (r + 0.5) * this.cell;
        this.particles.burstCell(cx, cy, this.cell, color, this.fxId);
      }
      for (const r of result.fullRows) this.flashes.push({ kind: 'row', index: r, t: now });
      for (const c of result.fullCols) this.flashes.push({ kind: 'col', index: c, t: now });

      // shockwave rings along each cleared line
      for (const r of result.fullRows) {
        this.particles.ring(this.boardX + this.boardSize / 2, this.boardY + (r + 0.5) * this.cell, this.boardSize * 0.55, '#ffffff');
      }
      for (const c of result.fullCols) {
        this.particles.ring(this.boardX + (c + 0.5) * this.cell, this.boardY + this.boardSize / 2, this.boardSize * 0.55, '#ffffff');
      }
      // full-screen flash on multi-line clears / hot streaks
      if (result.lineCount >= 2) this.screenFlash = Math.min(0.45, 0.18 + result.lineCount * 0.09);
      else if (result.streak >= 3) this.screenFlash = 0.15;

      if (getSettings().shake) this.shake = Math.min(14, 4 + result.lineCount * 3 + result.streak);
      audio.clearLines(result.lineCount, result.streak);

      const centerX = this.boardX + this.boardSize / 2;
      const centerY = this.boardY + this.boardSize * 0.4;
      this.addFloatText(centerX, centerY, `+${result.gained}`, '#ffffff', 1.4);
      if (result.streak >= 2) {
        this.addFloatText(centerX, centerY - this.cell * 1.3, `${result.streak} COMBO!`, '#ffe14d', 1.8);
        audio.combo(result.streak);
        this.particles.confetti(centerX, centerY, this.cell, 10 + result.streak * 6);
      }
      const praise = result.lineCount >= 4 ? 'LEGENDARY!' : result.lineCount === 3 ? 'AMAZING!' : result.lineCount === 2 ? 'GREAT!' : null;
      if (praise) this.addFloatText(centerX, centerY + this.cell, praise, '#43d9e8', 1.5);
    } else {
      const [r, c] = result.placedCells[0];
      this.addFloatText(
        this.boardX + (c + 0.5) * this.cell,
        this.boardY + r * this.cell,
        `+${result.gained}`, 'rgba(255,255,255,0.75)', 0.9,
      );
    }

    if (this.onPlace) this.onPlace(result);
    if (result.over) {
      // Staff "invincible" switch / 絶対防御 item: the board resets instead.
      if (this.godInvincible || this.godInvincibleUntil > Date.now()) {
        this.engine.reviveBoard();
        this.reviveFlash();
        this.addFloatText(this.boardX + this.boardSize / 2, this.boardY + this.boardSize / 2, 'INVINCIBLE!', '#ffd75e', 1.6);
        return;
      }
      // Autopilot 5.0 guard: a rescue may redraw the hand / clear cells instead.
      if (this.onRescue && this.onRescue()) return;
      audio.gameOver();
      if (this.onGameOver) this.onGameOver();
    }
  }

  addFloatText(x, y, text, color, size = 1) {
    this.floatTexts.push({ x, y, text, color, t: this.time, life: 1.1, size });
  }

  // ------------------------------------------------------------------
  // Render loop
  // ------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTs = performance.now();
    const loop = ts => {
      if (!this.running) return;
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      this.time += dt;
      this.update(dt);
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  update(dt) {
    this.particles.intensity = particleFactor();
    this.particles.update(dt);
    this.shake = Math.max(0, this.shake - dt * 40);
    this.screenFlash = Math.max(0, (this.screenFlash || 0) - dt * 1.6);
    const now = this.time;
    this.dying = this.dying.filter(d => now - d.t < 0.35);
    this.flashes = this.flashes.filter(f => now - f.t < 0.4);
    this.floatTexts = this.floatTexts.filter(f => now - f.t < f.life);
  }

  render() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);

    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.drawBackground();
    this.drawGrid();
    if (this.engine) {
      this.drawBlocks();
      this.drawDanger();
      this.drawCool();
      this.drawDying();
      this.drawFlashes();
      if (this.drag) this.drawDrag();
      if (this.showTray) this.drawTray();
    }
    this.particles.draw(ctx);
    this.drawFloatTexts();
    if (this.screenFlash > 0) {
      ctx.globalAlpha = this.screenFlash;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-20, -20, this.W + 40, this.H + 40);
      ctx.globalAlpha = 1;
    }
  }

  drawBackground() {
    const { ctx } = this;
    const theme = getBoard(this.boardId);
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, theme.bg[0]);
    g.addColorStop(1, theme.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, this.W + 40, this.H + 40);

    // animated decorations
    for (const d of this.deco) {
      let x = d.x * this.W;
      let y = d.y * this.H;
      let alpha = 0.3 + 0.3 * Math.sin(this.time * d.sp + d.tw);
      let color = '#cfe0ff';
      let r = d.r;
      if (theme.fireflies) color = '#b8ff9e';
      else if (theme.nebula) color = '#d9b8ff';
      if (theme.bubbles || theme.fireflies) {
        y = ((d.y - this.time * 0.01 * d.sp) % 1 + 1) % 1 * this.H;
      } else if (theme.embers) {
        // rising embers with flicker and drift
        y = ((d.y - this.time * 0.03 * d.sp) % 1 + 1) % 1 * this.H;
        x += Math.sin(this.time * 2 + d.tw) * 10;
        color = Math.sin(this.time * 6 + d.tw) > 0 ? '#ff8a5c' : '#ff5d5d';
        alpha = 0.35 + 0.35 * Math.sin(this.time * 5 + d.tw);
      } else if (theme.petals) {
        // falling sakura petals with sway
        y = ((d.y + this.time * 0.025 * d.sp) % 1) * this.H;
        x += Math.sin(this.time * 1.6 + d.tw) * 16;
        color = Math.sin(d.tw) > 0 ? '#ffc0dc' : '#ff9ecb';
        alpha = 0.45 + 0.25 * Math.sin(this.time * 2 + d.tw);
        r = d.r * 1.4;
      } else if (theme.holy) {
        // slow golden sparkles that swell and fade
        color = '#ffe9a8';
        const tw = Math.sin(this.time * d.sp * 1.5 + d.tw);
        alpha = Math.max(0, tw) * 0.8;
        r = d.r * (1 + Math.max(0, tw));
      } else if (theme.snow) {
        // gently falling snowflakes with sway
        y = ((d.y + this.time * 0.018 * d.sp) % 1) * this.H;
        x += Math.sin(this.time * 1.2 + d.tw) * 12;
        color = '#eaf4ff';
        alpha = 0.5 + 0.3 * Math.sin(this.time * 1.5 + d.tw);
        r = d.r * 1.2;
      } else if (theme.digital) {
        // cyber rain: glyphs streaking downward
        y = ((d.y + this.time * 0.08 * d.sp) % 1) * this.H;
        color = Math.sin(d.tw) > 0.3 ? '#5ee86e' : '#9effc0';
        alpha = 0.25 + 0.35 * Math.sin(this.time * 4 + d.tw);
      }
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawGrid() {
    const { ctx, cell } = this;
    const theme = getBoard(this.boardId);
    ctx.fillStyle = theme.cell;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const x = this.boardX + c * cell, y = this.boardY + r * cell;
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      }
    }
    ctx.strokeStyle = theme.cellLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.boardX - 2, this.boardY - 2, this.boardSize + 4, this.boardSize + 4);
  }

  drawBlocks() {
    const { ctx, cell } = this;
    const skin = getSkin(this.skinId);
    const ghost = this.drag && this.weldTargetAt(this.drag.px, this.drag.py, this.drag.index) === -1
      ? this.ghostInfo() : null;

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = this.engine.at(r, c);
        if (!v) continue;
        const x = this.boardX + c * cell, y = this.boardY + r * cell;
        const key = r * SIZE + c;
        const st = this.spawnAnim.get(key);
        let scale = 1;
        if (st !== undefined) {
          const p = (this.time - st) / 0.22;
          if (p >= 1) this.spawnAnim.delete(key);
          else scale = 1.25 - 0.25 * this.easeOut(p);
        }
        // highlight blocks in lines about to clear, or mode-flagged cells
        let glow = 0;
        if (ghost && ghost.valid && (ghost.willRows.has(r) || ghost.willCols.has(c))) glow = 1;
        if (!glow && this.glowCells && this.glowCells.has(key)) glow = 1;
        this.drawScaledBlock(skin, x, y, cell, v, 1, scale, glow);
      }
    }
  }

  drawScaledBlock(skin, x, y, s, color, alpha, scale = 1, glow = 0) {
    const { ctx } = this;
    if (scale !== 1) {
      ctx.save();
      ctx.translate(x + s / 2, y + s / 2);
      ctx.scale(scale, scale);
      ctx.translate(-(x + s / 2), -(y + s / 2));
    }
    if (glow) {
      ctx.save();
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = s * 0.5;
      skin(ctx, x, y, s, color, alpha);
      ctx.restore();
    } else {
      skin(ctx, x, y, s, color, alpha);
    }
    if (scale !== 1) ctx.restore();
  }

  // Meltdown coolant: mode-flagged cells shimmer cyan.
  drawCool() {
    if (!this.coolCells || !this.coolCells.size) return;
    const { ctx, cell } = this;
    const pulse = 0.25 + 0.2 * Math.sin(this.time * 4);
    for (const k of this.coolCells) {
      const r = (k / SIZE) | 0, c = k % SIZE;
      const x = this.boardX + c * cell, y = this.boardY + r * cell;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#4dd0ff';
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.globalAlpha = 1;
      ctx.font = `${cell * 0.5}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('❄️', x + cell / 2, y + cell / 2);
    }
    ctx.globalAlpha = 1;
  }

  // Boss telegraph: target cells pulse red until the attack lands (or is cut).
  drawDanger() {
    if (!this.dangerCells || !this.dangerCells.size) return;
    const { ctx, cell } = this;
    const pulse = 0.22 + 0.2 * Math.sin(this.time * 7);
    for (const k of this.dangerCells) {
      const r = (k / SIZE) | 0, c = k % SIZE;
      const x = this.boardX + c * cell, y = this.boardY + r * cell;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ff3b3b';
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.globalAlpha = Math.min(1, pulse + 0.35);
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
    }
    ctx.globalAlpha = 1;
  }

  ghostInfo() {
    const anchor = this.dragAnchor();
    if (!anchor) return null;
    const piece = this.engine.hand[this.drag.index];
    const valid = this.engine.canPlace(piece, anchor.r, anchor.c);
    const willRows = new Set(), willCols = new Set();
    if (valid) {
      // simulate: which rows/cols become full?
      const g = this.engine.grid;
      const temp = new Set(piece.cells.map(([dr, dc]) => (anchor.r + dr) * SIZE + (anchor.c + dc)));
      for (let r = 0; r < SIZE; r++) {
        let full = true;
        for (let c = 0; c < SIZE; c++) { const k = r * SIZE + c; if (!g[k] && !temp.has(k)) { full = false; break; } }
        if (full) willRows.add(r);
      }
      for (let c = 0; c < SIZE; c++) {
        let full = true;
        for (let r = 0; r < SIZE; r++) { const k = r * SIZE + c; if (!g[k] && !temp.has(k)) { full = false; break; } }
        if (full) willCols.add(c);
      }
    }
    return { anchor, piece, valid, willRows, willCols };
  }

  drawDrag() {
    const { ctx, cell } = this;
    const skin = getSkin(this.skinId);
    const piece = this.engine.hand[this.drag.index];
    if (!piece) return;

    // Weld zone: highlight the target slot INSTEAD of a board ghost, so the
    // preview always matches what releasing will do.
    const wslot = this.weldTargetAt(this.drag.px, this.drag.py, this.drag.index);
    const ghost = wslot === -1 ? this.ghostInfo() : null;
    if (wslot !== -1) {
      const slotW = this.W / 3;
      const pulse = 0.25 + 0.15 * Math.sin(this.time * 6);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#b06bff';
      ctx.fillRect(wslot * slotW + 4, this.trayY + 2, slotW - 8, this.trayH - 6);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#b06bff';
      ctx.lineWidth = 2;
      ctx.strokeRect(wslot * slotW + 4, this.trayY + 2, slotW - 8, this.trayH - 6);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🧬', wslot * slotW + slotW / 2, this.trayY + 14);
    }

    // ghost on board
    if (ghost) {
      const { anchor, valid } = ghost;
      for (const [dr, dc] of piece.cells) {
        const x = this.boardX + (anchor.c + dc) * cell;
        const y = this.boardY + (anchor.r + dr) * cell;
        if (valid) {
          skin(ctx, x, y, cell, piece.color, 0.35);
        } else {
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = '#ff4444';
          ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
          ctx.globalAlpha = 1;
        }
      }
      // pulse rows/cols that would clear
      if (valid && (ghost.willRows.size || ghost.willCols.size)) {
        const pulse = 0.25 + 0.15 * Math.sin(this.time * 8);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = '#ffffff';
        for (const r of ghost.willRows) ctx.fillRect(this.boardX, this.boardY + r * cell, this.boardSize, cell);
        for (const c of ghost.willCols) ctx.fillRect(this.boardX + c * cell, this.boardY, cell, this.boardSize);
        ctx.globalAlpha = 1;
      }
    }

    // floating piece above finger
    const { rows, cols } = shapeSize(piece.cells);
    const pw = cols * cell, ph = rows * cell;
    const lift = cell * 1.2;
    const left = this.drag.px - pw / 2;
    const top = this.drag.py - ph - lift + ph / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 10;
    for (const [dr, dc] of piece.cells) {
      skin(ctx, left + dc * cell, top + dr * cell, cell, piece.color, 0.95);
    }
    ctx.restore();
    if (piece.weld > 1) this.drawPieceTag(left, top, pw, ph, `×${piece.weld}`, '#b06bff');
  }

  drawDying() {
    const { ctx, cell } = this;
    const skin = getSkin(this.skinId);
    for (const d of this.dying) {
      const p = (this.time - d.t) / 0.35;
      const x = this.boardX + d.c * cell, y = this.boardY + d.r * cell;
      this.drawScaledBlock(skin, x, y, cell, d.color, 1 - p, 1 + p * 0.4);
    }
  }

  drawFlashes() {
    const { ctx, cell } = this;
    for (const f of this.flashes) {
      const p = (this.time - f.t) / 0.4;
      ctx.globalAlpha = (1 - p) * 0.5;
      ctx.fillStyle = '#ffffff';
      if (f.kind === 'row') ctx.fillRect(this.boardX, this.boardY + f.index * cell, this.boardSize, cell);
      else ctx.fillRect(this.boardX + f.index * cell, this.boardY, cell, this.boardSize);
    }
    ctx.globalAlpha = 1;
  }

  drawTray() {
    const { ctx } = this;
    const skin = getSkin(this.skinId);
    const slotW = this.W / 3;
    for (let i = 0; i < 3; i++) {
      const piece = this.engine.hand[i];
      if (!piece || (this.drag && this.drag.index === i)) continue;
      const { rows, cols } = shapeSize(piece.cells);
      const maxCell = Math.min((slotW - 20) / cols, (this.trayH - 14) / rows, this.cell * 0.6);
      const pw = cols * maxCell, ph = rows * maxCell;
      const ox = i * slotW + (slotW - pw) / 2;
      const oy = this.trayY + (this.trayH - ph) / 2;
      const placeable = this.engine.placements(piece).length > 0;
      const alpha = placeable ? 1 : 0.3;
      // subtle idle bobbing
      const bob = Math.sin(this.time * 2 + i * 1.7) * 2;
      const frozen = piece.frozenUntil > Date.now();
      for (const [dr, dc] of piece.cells) {
        skin(ctx, ox + dc * maxCell, oy + dr * maxCell + bob, maxCell, piece.color, frozen ? 0.45 : alpha);
      }
      if (piece.weld > 1) this.drawPieceTag(ox, oy + bob, pw, ph, `×${piece.weld}`, '#b06bff', alpha);
      if (frozen) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = '#9bd8ff';
        ctx.fillRect(ox - 3, oy + bob - 3, pw + 6, ph + 6);
        ctx.globalAlpha = 1;
        ctx.font = `${Math.max(16, maxCell)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('❄️', ox + pw / 2, oy + bob + ph / 2);
      }
    }
  }

  // Glowing frame + corner label on a special hand piece (chimera welds).
  drawPieceTag(x, y, w, h, text, color, alpha = 1) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 + 3 * Math.sin(this.time * 4);
    ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    const bw = Math.max(18, text.length * 8 + 6);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - 6, y - 10, bw, 14, 5) : ctx.rect(x - 6, y - 10, bw, 14);
    ctx.fill();
    ctx.fillStyle = '#0b0e1f';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x - 6 + bw / 2, y - 3);
    ctx.restore();
  }

  drawFloatTexts() {
    const { ctx } = this;
    for (const f of this.floatTexts) {
      const p = (this.time - f.t) / f.life;
      const y = f.y - p * this.cell * 1.6;
      const alpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      const scale = p < 0.15 ? 0.6 + (p / 0.15) * 0.4 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(f.x, y);
      ctx.scale(scale, scale);
      ctx.font = `800 ${Math.round(this.cell * 0.55 * f.size)}px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(f.text, 0, 0);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
  }

  easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  // Board revive animation (versus mode top-out)
  reviveFlash() {
    this.particles.confetti(this.boardX + this.boardSize / 2, this.boardY + this.boardSize / 2, this.cell, 24);
    if (getSettings().shake) this.shake = 10;
  }
}

// ---------------------------------------------------------------------------
// MiniBoard: tiny spectator renderer for the opponent's grid (no engine).
// ---------------------------------------------------------------------------

export class MiniBoard {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.grid = new Array(SIZE * SIZE).fill(0);
    this.skinId = opts.skinId || 'skin_default';
  }

  setGrid(grid) {
    if (Array.isArray(grid) && grid.length === SIZE * SIZE) this.grid = grid;
    this.render();
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = Math.min(rect.width, rect.height) / SIZE;
    const skin = getSkin(this.skinId);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      ctx.fillRect(c * cell + 0.5, r * cell + 0.5, cell - 1, cell - 1);
    }
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const v = this.grid[r * SIZE + c];
      if (v) skin(ctx, c * cell, r * cell, cell, v, 1);
    }
  }
}
