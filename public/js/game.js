// GameView: canvas renderer + input controller for one board (player or spectator).
import { SIZE, shapeSize, ICE, ICE_CRACKED } from './engine.js';
import { PALETTE, getSkin, getBoard } from './themes.js';
import { ParticleSystem } from './particles.js';
import { audio } from './audio.js';
import { getSettings, particleFactor } from './settings.js';

// ---------------------------------------------------------------------------
// ❄️ 氷結ブロック (engine.js の ICE=10 / ICE_CRACKED=11)
// ---------------------------------------------------------------------------
// お邪魔(9)は PALETTE に1エントリ足すだけで済んだが、氷は「半透明＋質感」なので
// 色2本では表せない。PALETTE は 9 番までしか無く、10/11 をスキン関数に渡すと
// PALETTE[ci] の分割代入がその場で落ちる（描画が止まる）ので、
// 盤面のマス値を描く経路はすべて withIce() を通してここで横取りする。
// getSkin() の戻り値をそのまま包むので、色覚サポート（themes.js の
// withColorMarks ラッパ）とは二重にならない ── 氷は色 index を持たないため
// 記号を重ねる対象でもなく、包む順序に関係なく通常色だけに記号が付く。

// グラデーションは「セルサイズごとに1本」だけ作って使い回す。氷は盤面に
// 乗っているマスの数だけ毎フレーム描かれるので、ここで createLinearGradient を
// 毎回作ると一番重い部分を毎フレーム作り直すことになる（themes.js の
// markFont / withColorMarks と同じ「毎フレーム生成しない」方針にそろえた）。
// 座標はセル原点へ translate してから描くので、見た目は以前と同一。
const _iceGrads = new WeakMap();   // ctx -> Map(size -> CanvasGradient)
function iceGradient(ctx, size, pad, bs) {
  let bySize = _iceGrads.get(ctx);
  if (!bySize) { bySize = new Map(); _iceGrads.set(ctx, bySize); }
  let g = bySize.get(size);
  if (!g) {
    g = ctx.createLinearGradient(pad, pad, pad, pad + bs);
    g.addColorStop(0, 'rgba(236,251,255,0.72)');
    g.addColorStop(0.55, 'rgba(170,226,247,0.50)');
    g.addColorStop(1, 'rgba(112,182,222,0.62)');
    if (bySize.size > 8) bySize.clear();   // リサイズを繰り返しても膨らませない
    bySize.set(size, g);
  }
  return g;
}

export function drawIceBlock(ctx, x, y, s, cracked, alpha = 1) {
  const a = Math.max(0, Math.min(1, Number(alpha) >= 0 ? Number(alpha) : 1));
  if (a <= 0.02 || !(s > 0)) return;
  const pad = s * 0.06;
  // 以下はセル原点 (0,0) からの相対座標。ctx.translate(x, y) 済み。
  const bx = pad, by = pad, bs = s - pad * 2;
  const rad = s * 0.16;
  const body = () => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bs, bs, rad);
    else ctx.rect(bx, by, bs, bs);
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = a;
  ctx.fillStyle = iceGradient(ctx, s, pad, bs);
  body(); ctx.fill();
  // 厚みのある透明に見せる斜めのハイライト2本
  ctx.globalAlpha = a * 0.55;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.beginPath();
  ctx.moveTo(bx + bs * 0.18, by + bs * 0.74); ctx.lineTo(bx + bs * 0.60, by + bs * 0.14);
  ctx.moveTo(bx + bs * 0.54, by + bs * 0.88); ctx.lineTo(bx + bs * 0.86, by + bs * 0.46);
  ctx.stroke();
  ctx.globalAlpha = a;
  ctx.strokeStyle = 'rgba(226,248,255,0.85)';
  ctx.lineWidth = Math.max(1, s * 0.045);
  body(); ctx.stroke();
  if (cracked) {
    // ヒビ: 中心から3方向。白いフチ→濃い線の順に重ねて氷の上に浮かせる。
    ctx.lineCap = 'round';
    const cx = bx + bs * 0.44, cy = by + bs * 0.5;
    const crack = () => {
      ctx.beginPath();
      ctx.moveTo(bx + bs * 0.12, by + bs * 0.18); ctx.lineTo(cx, cy); ctx.lineTo(bx + bs * 0.30, by + bs * 0.92);
      ctx.moveTo(cx, cy); ctx.lineTo(bx + bs * 0.94, by + bs * 0.40);
      ctx.moveTo(cx, cy); ctx.lineTo(bx + bs * 0.74, by + bs * 0.94);
    };
    ctx.globalAlpha = a * 0.85;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(1.5, s * 0.10);
    crack(); ctx.stroke();
    ctx.strokeStyle = 'rgba(38,86,122,0.78)';
    ctx.lineWidth = Math.max(1, s * 0.05);
    crack(); ctx.stroke();
  }
  ctx.restore();
}

// 元のスキン関数ごとにラッパを1つだけ作って使い回す（毎フレーム生成しない）。
// themes.js 側も同じ流儀でキャッシュしているので、getSkin() の戻り値の
// 同一性は保たれ、ここの Map も膨らまない。
const _iceSkins = new Map();
function withIce(draw) {
  let wrapped = _iceSkins.get(draw);
  if (!wrapped) {
    wrapped = function (ctx, x, y, s, ci, alpha = 1) {
      if (ci === ICE || ci === ICE_CRACKED) { drawIceBlock(ctx, x, y, s, ci === ICE_CRACKED, alpha); return; }
      draw(ctx, x, y, s, ci, alpha);
    };
    _iceSkins.set(draw, wrapped);
  }
  return wrapped;
}

// 盤面のマス値（engine.grid 由来）を描くときは必ずこれを通す。
// 手札・ゴーストは piece.color(1..8) しか出さないので素の getSkin() で足りる。
export function boardSkin(skinId) { return withIce(getSkin(skinId)); }

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
    this._screenFlash = 0;          // 実体。読み書きは下のアクセサ経由（設定でゲート）
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
    this.keystoneCell = -1;         // 👁️断罪の急所。含めて斬れば貫通が倍
    this.coolCells = null;          // Set of r*8+c pulsing cyan (meltdown coolant)
    this.onTrayDrop = null;         // callback(fromSlot, toSlot) -> true to handle (chimera weld)

    this.running = false;
    this.lastTs = 0;

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    // 画面の回転だけでなく、上のパネルが1行伸び縮みしただけでも測り直す。
    // これが無いと canvas の CSS 高さだけが変わって view.H が古いまま残り、
    // 盤面が縦に潰れた長方形として描かれ、手札の当たり判定も置き去りになる
    // （見えているピースの上半分をタップしても掴めない、という形で出る）。
    // #gameCanvas は CSS で width/height:100% なので、resize() が
    // canvas.width（ビットマップ側）を書き換えても再帰しない。
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    }
    this.resize();
    this.initDeco();

    if (this.interactive) this.bindInput();
  }

  destroy() {
    this.running = false;
    window.removeEventListener('resize', this._resize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  // ✨ 全画面フラッシュ（白）は設定「画面フラッシュ」で完全に切れる。
  // 連鎖・ボス・スキルなど view.screenFlash へ直接代入する経路が各所にあるので、
  // 代入側を触らずに済むようアクセサで一括して受ける（揺れの getSettings().shake
  // ゲートと同じ扱い）。OS の「視差効果を減らす」が ON の人は初回既定で false。
  get screenFlash() { return this._screenFlash || 0; }
  set screenFlash(v) {
    const n = Number(v);
    if (!(n > 0)) { this._screenFlash = 0; return; }
    let on = true;
    try { on = getSettings().flash !== false; } catch { /* 設定が読めなければ従来どおり */ }
    this._screenFlash = on ? n : 0;
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
    this.dangerUntil = 0;
    this.dangerTotal = 0;
    this.keystoneCell = -1;
    this.coolCells = null;
    this.oreCells = null;
    this.ghostFx = null;
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
    // 寸法が変わっていなければ何もしない。ResizeObserver は小数の揺れでも
    // 鳴るので、ここで止めないと毎フレーム作り直しかねない。
    // dpr も見る ── 外部ディスプレイに移したときは箱の大きさが同じでも
    // 画素密度だけが変わるので、これを見ないと絵がぼやけたままになる。
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (rect.width === this._lastW && rect.height === this._lastH && dpr === this.dpr) return;
    this._lastW = rect.width; this._lastH = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.dpr = dpr;
    this.W = rect.width;
    this.H = rect.height;

    // 横持ちかどうかで手札の置き場所を変える。
    // 縦なら盤面の下、横なら盤面の右。横持ちで下に置くと高さが足りず、
    // 実測 812x375 で盤面228px・コマ12pxまで潰れていた（横幅は576px余り）。
    this.sideTray = this.showTray && this.W > this.H * 1.25;

    if (this.sideTray) {
      // 盤面は高さで頭打ちになるので、先に盤面を決めてから手札を隣に置く。
      // そのあと2つまとめて中央に寄せる ── 先に手札の幅を確保すると、
      // 余った幅がぜんぶ手札側に付いて、間延びした帯になる。
      let side = Math.min(this.H - 12, this.W - 130);
      const trayW = Math.max(96, Math.min(side * 0.45, 170));
      // 横に細長くない画面（比が1.25をわずかに超える程度）では、
      // 高さで決めた盤面と手札を並べると横にはみ出す。幅にも収める。
      if (side + 10 + trayW > this.W - 12) side = Math.max(96, this.W - 22 - trayW);
      const total = side + 10 + trayW;
      this.cell = side / SIZE;
      this.boardSize = side;
      this.boardX = Math.max(6, (this.W - total) / 2);
      this.boardY = (this.H - side) / 2;
      this.trayX = this.boardX + side + 10;
      this.trayW = trayW;
      // 縦持ちの側が使う値も、参照されたときに破綻しないように埋めておく。
      this.trayY = 0;
      this.trayH = this.H;
    } else {
      const trayH = this.showTray ? Math.min(this.H * 0.24, 130) : 0;
      const side = Math.min(this.W - 12, this.H - trayH - 16);
      this.cell = side / SIZE;
      this.boardX = (this.W - side) / 2;
      this.boardY = this.showTray ? 6 : (this.H - side) / 2;
      this.boardSize = side;
      this.trayX = 0;
      this.trayW = this.W;
      this.trayY = this.boardY + side + 8;
      this.trayH = Math.max(0, this.H - this.trayY - 4);
    }
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
      // Already dragging with another pointer? A second finger / the palm
      // touching the canvas must not hijack or replace the active drag.
      if (this.drag) return;
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
        this.drag = { index: slot, piece: this.engine.hand[slot], px: x, py: y, pointerId: e.pointerId };
        audio.pickup();
        e.preventDefault();
      }
    });

    this.canvas.addEventListener('pointermove', e => {
      // Only the pointer that started the drag may move it — a second finger's
      // movement must not drag the held piece to its position.
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { x, y } = pos(e);
      this.drag.px = x;
      this.drag.py = y;
    });

    const drop = e => {
      // Only the pointer that started the drag may release it — a second
      // finger's pointerup must not drop the held piece.
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { x, y } = pos(e);
      const anchor = this.dragAnchor();
      const { index, piece } = this.drag;
      this.drag = null;
      // pointerdown checks inputLocked, but the lock can land DURING a drag —
      // the timer expiring, the run ending, the result already submitted. A
      // release after that used to still place the piece and move the score.
      if (this.inputLocked || !this.running || !this.engine || this.engine.over) {
        audio.putback();
        return;
      }
      // Chimera welding: the drag preview (drawDrag) uses the same predicate,
      // so whenever the weld highlight is showing, releasing welds — and
      // whenever a board ghost is showing, releasing places. Never both.
      const wslot = this.weldTargetAt(x, y, index);
      if (wslot !== -1 && this.onTrayDrop(index, wslot)) return;
      // The hand can be rewritten mid-drag (a boss move, a co-op broadcast,
      // the admin's 🎴 hand shuffle). dragAnchor() ghosts the piece you picked
      // UP, so placing hand[index] blind would drop a different shape than the
      // one under your finger.
      if (this.engine.hand[index] !== piece) {
        audio.putback();
        return;
      }
      if (anchor && this.engine.canPlace(piece, anchor.r, anchor.c)) {
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
    this.canvas.addEventListener('pointercancel', e => { if (this.drag && e.pointerId === this.drag.pointerId) { this.drag = null; audio.putback(); } });
  }

  trayHit(x, y) {
    if (!this.engine) return -1;
    if (this.sideTray) {
      // 横持ちは縦に3つ並ぶ。盤面の右側「だけ」が手札 ──
      // 右端を見ていないと、手札の右にある余白でもピースを掴んでしまう。
      if (x < this.trayX || x > this.trayX + this.trayW) return -1;
      const slotH = this.H / 3;
      return Math.max(0, Math.min(2, Math.floor(y / slotH)));
    }
    const slotW = this.W / 3;
    if (y < this.trayY) return -1;
    return Math.max(0, Math.min(2, Math.floor(x / slotW)));
  }

  // Chimera: which tray slot a drag at (x,y) would weld onto, or -1.
  // Bottom-row placements hover the finger just past the tray's top edge, so
  // welding needs the finger clearly inside the tray.
  weldTargetAt(x, y, index) {
    if (!this.onTrayDrop || !this.engine) return -1;
    // 手札の縁ぎりぎりは「盤面の一番下に置こうとした指」なので、
    // 溶接の対象にしない。横持ちのときは縁が左右になる。
    if (this.sideTray) {
      if (x <= this.trayX + Math.min(40, this.trayW * 0.3)) return -1;
    } else if (y <= this.trayY + Math.min(40, this.trayH * 0.3)) return -1;
    const slot = this.trayHit(x, y);
    if (slot === -1 || slot === index || !this.engine.hand[slot]) return -1;
    return slot;
  }

  // Piece floats above the pointer for finger visibility.
  // ただし盤面の下に余白が無いと、持ち上げたぶん最下行に指が届かなくなる。
  // 横持ちは盤面が画面いっぱいなので、実測で最下行(7段目)が
  // 1行ピースでは絶対に置けない状態だった。余白に合わせて縮める。
  // 判定側(dragAnchor)と描画側(drawDrag)で必ず同じ値を使わないと、
  // 指の上に浮くピースとゴースト／実際の落下位置が縦にずれる
  // （横長キャンバスで実測 0.6〜0.7マス）。だから1か所にまとめる。
  liftAmount() {
    const room = this.H - this.boardY - this.boardSize + this.cell * 0.45;
    return Math.min(this.cell * 1.2, Math.max(this.cell * 0.35, room));
  }

  // Current drag → board anchor cell (top-left of the piece), or null.
  dragAnchor() {
    if (!this.drag) return null;
    const { piece } = this.drag;
    const { rows, cols } = shapeSize(piece.cells);
    const pw = cols * this.cell, ph = rows * this.cell;
    const lift = this.liftAmount();
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

    // ❄️ 氷結: 揃ったのに消えなかった線を水色で光らせ、ヒビが入ったマスを
    // 一度弾ませる。文字は出さない ── 「消えない」ことは絵で伝わるほうが速い。
    if (result.frozenCount > 0) {
      for (const r of result.frozenRows) this.flashes.push({ kind: 'row', index: r, t: now, color: '#9be3ff' });
      for (const c of result.frozenCols) this.flashes.push({ kind: 'col', index: c, t: now, color: '#9be3ff' });
      for (const [r, c] of result.crackedCells) {
        this.spawnAnim.set(r * SIZE + c, now);
        this.particles.ring(this.boardX + (c + 0.5) * this.cell, this.boardY + (r + 0.5) * this.cell, this.cell * 0.9, '#9be3ff');
      }
      if (getSettings().shake) this.shake = Math.max(this.shake, 4);
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
      // ResizeObserver が主。これは保険で、Observer が来ない環境でも
      // 0.25秒以内には気づけるようにしてある。resize() は寸法が同じなら
      // 即 return するので、実質の負担は計測1回ぶん。
      if ((this._sizeTick = (this._sizeTick || 0) + 1) >= 15) { this._sizeTick = 0; this.resize(); }
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
      this.drawOre();
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

    // Aurora board: translucent light ribbons waving across the upper sky.
    if (theme.aurora) {
      const hues = [160, 200, 285];
      for (let b = 0; b < 3; b++) {
        ctx.globalAlpha = 0.10 + 0.05 * Math.sin(this.time * 0.7 + b * 2.1);
        ctx.fillStyle = `hsl(${hues[b] + 12 * Math.sin(this.time * 0.3 + b)}, 90%, 60%)`;
        ctx.beginPath();
        const baseY = this.H * (0.10 + b * 0.09);
        ctx.moveTo(-20, baseY);
        for (let px = -20; px <= this.W + 20; px += 24) {
          ctx.lineTo(px, baseY + Math.sin(px * 0.012 + this.time * (0.8 + b * 0.25) + b * 3) * this.H * 0.05);
        }
        for (let px = this.W + 20; px >= -20; px -= 24) {
          ctx.lineTo(px, baseY + this.H * (0.10 + b * 0.02) + Math.sin(px * 0.010 + this.time * 0.6 + b) * this.H * 0.04);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

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
    const skin = boardSkin(this.skinId);
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
        // 👻 幽霊屋敷: 置いたブロックはやがて透明になる。ライン消しの瞬間
        // (revealUntil) と消える予告グロー中だけは見える。
        let alpha = 1;
        if (this.ghostFx && !glow && this.time >= this.ghostFx.revealUntil) {
          const h = this.ghostFx.hideAt.get(key);
          if (h !== undefined) alpha = Math.max(0, Math.min(1, (h - this.time) / 0.35));
        }
        if (alpha <= 0.02) continue;
        this.drawScaledBlock(skin, x, y, cell, v, alpha, scale, glow);
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

  // Dig-mode ore: a Map(cellKey → 'gold'|'crystal'|'rainbow') drawn as a
  // glinting icon over the rock block underneath.
  drawOre() {
    if (!this.oreCells || !this.oreCells.size) return;
    const { ctx, cell } = this;
    const TINT = { gold: '#ffd75e', crystal: '#4dd0ff', rainbow: '#ff6bd4' };
    const ICON = { gold: '🪙', crystal: '💠', rainbow: '🌈' };
    const glint = 0.16 + 0.12 * Math.sin(this.time * 3);
    for (const [k, type] of this.oreCells) {
      const r = (k / SIZE) | 0, c = k % SIZE;
      const x = this.boardX + c * cell, y = this.boardY + r * cell;
      ctx.globalAlpha = glint;
      ctx.fillStyle = TINT[type] || '#ffd75e';
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.globalAlpha = 1;
      ctx.font = `${cell * 0.52}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ICON[type] || '🪙', x + cell / 2, y + cell / 2);
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
      // 👁️ 断罪の急所（金マス）。ここを含めて斬れば貫通が倍になるので、
      // 赤マスの中から一目で見分けられないと意味がない。
      const key = this.keystoneCell === k;
      ctx.globalAlpha = key ? Math.min(1, pulse + 0.25) : pulse;
      ctx.fillStyle = key ? '#f0b429' : '#ff3b3b';
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.globalAlpha = Math.min(1, pulse + 0.35);
      ctx.strokeStyle = key ? '#ffd75e' : '#ff6b6b';
      ctx.lineWidth = key ? 3 : 2;
      ctx.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
    }
    // 残り時間の輪。締切がどこにも出ておらず、落とすと住人が処刑される
    // のに、あと何秒あるのか分からなかった。急所（金マス）の上に描く。
    if (this.dangerUntil && this.dangerTotal) {
      const left = Math.max(0, this.dangerUntil - Date.now());
      const p = left / this.dangerTotal;
      const k = this.keystoneCell >= 0 ? this.keystoneCell : [...this.dangerCells][0];
      const r = (k / SIZE) | 0, c = k % SIZE;
      const cx = this.boardX + (c + 0.5) * cell, cy = this.boardY + (r + 0.5) * cell;
      const rad = cell * 0.42;
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = p > 0.35 ? '#ffffff' : '#ff3b3b';
      ctx.lineWidth = Math.max(2.5, cell * 0.09);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${Math.round(cell * 0.4)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((left / 1000).toFixed(1), cx, cy);
    }
    ctx.globalAlpha = 1;
  }

  ghostInfo() {
    const anchor = this.dragAnchor();
    if (!anchor) return null;
    const piece = this.engine.hand[this.drag.index];
    // 掴んだままの枠を自分以外が消化する（協力プレイのサーバー代打ち、
    // オートパイロット）と hand[index] が null になる。canPlace(null) は
    // piece.cells で TypeError を投げ、それが render() の中なので
    // requestAnimationFrame の再登録に届かず描画が永久に止まる。
    // drawDrag は同じ読み出しに既にガードを持っているので、そちらに揃える。
    if (!piece) return null;
    const valid = this.engine.canPlace(piece, anchor.r, anchor.c);
    const willRows = new Set(), willCols = new Set();
    // ❄️ 氷結: 揃っても氷があると消えない線。白く光らせると「消える」と嘘に
    // なるので、別の集合に分けて水色で見せる（resolveLines の判定と同じ規則）。
    const freezeRows = new Set(), freezeCols = new Set();
    if (valid) {
      // simulate: which rows/cols become full?
      const g = this.engine.grid;
      const temp = new Set(piece.cells.map(([dr, dc]) => (anchor.r + dr) * SIZE + (anchor.c + dc)));
      for (let r = 0; r < SIZE; r++) {
        let full = true, ice = false;
        for (let c = 0; c < SIZE; c++) {
          const k = r * SIZE + c;
          if (!g[k] && !temp.has(k)) { full = false; break; }
          if (g[k] === ICE) ice = true;
        }
        if (full) (ice ? freezeRows : willRows).add(r);
      }
      for (let c = 0; c < SIZE; c++) {
        let full = true, ice = false;
        for (let r = 0; r < SIZE; r++) {
          const k = r * SIZE + c;
          if (!g[k] && !temp.has(k)) { full = false; break; }
          if (g[k] === ICE) ice = true;
        }
        if (full) (ice ? freezeCols : willCols).add(c);
      }
    }
    return { anchor, piece, valid, willRows, willCols, freezeRows, freezeCols };
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
      // 枠の寸法も横持ち／縦持ちで変わる。幅を W/3 のままにしていると、
      // 横持ちで盤面の上まで紫の枠が伸びていた。
      const slotW = this.sideTray ? this.trayW : this.W / 3;
      const slotH = this.sideTray ? this.H / 3 : this.trayH;
      const sx = this.sideTray ? this.trayX + 4 : wslot * slotW + 4;
      const sy = this.sideTray ? wslot * slotH + 2 : this.trayY + 2;
      const pulse = 0.25 + 0.15 * Math.sin(this.time * 6);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#b06bff';
      ctx.fillRect(sx, sy, slotW - 8, slotH - 6);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#b06bff';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, slotW - 8, slotH - 6);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 印も枠と同じ場所へ。y を trayY(=0) のままにしていると、
      // 横持ちでは盤面の上に 🧬 が浮いていた。
      ctx.fillText('🧬', sx + (slotW - 8) / 2, sy + 14);
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
      // 揃うけれど氷で止まる線は水色で。「白く光ったのに消えない」を防ぐ。
      if (valid && ghost.freezeRows && (ghost.freezeRows.size || ghost.freezeCols.size)) {
        const pulse = 0.18 + 0.12 * Math.sin(this.time * 8);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = '#9be3ff';
        for (const r of ghost.freezeRows) ctx.fillRect(this.boardX, this.boardY + r * cell, this.boardSize, cell);
        for (const c of ghost.freezeCols) ctx.fillRect(this.boardX + c * cell, this.boardY, cell, this.boardSize);
        ctx.globalAlpha = 1;
      }
    }

    // floating piece above finger
    const { rows, cols } = shapeSize(piece.cells);
    const pw = cols * cell, ph = rows * cell;
    const lift = this.liftAmount();   // dragAnchor と同じ値でないと絵と落下位置がずれる
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
    // 消えるのは盤面のマスなので、ヒビ(11)が混ざりうる ── boardSkin を使う。
    const skin = boardSkin(this.skinId);
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
      ctx.fillStyle = f.color || '#ffffff';   // 氷で止まった線は水色（既定は従来どおり白）
      if (f.kind === 'row') ctx.fillRect(this.boardX, this.boardY + f.index * cell, this.boardSize, cell);
      else ctx.fillRect(this.boardX + f.index * cell, this.boardY, cell, this.boardSize);
    }
    ctx.globalAlpha = 1;
  }

  drawTray() {
    const { ctx } = this;
    const skin = getSkin(this.skinId);
    // 横持ちは縦に3つ、縦持ちは横に3つ。
    const slotW = this.sideTray ? this.trayW : this.W / 3;
    const slotH = this.sideTray ? this.H / 3 : this.trayH;
    for (let i = 0; i < 3; i++) {
      const piece = this.engine.hand[i];
      if (!piece || (this.drag && this.drag.index === i)) continue;
      const { rows, cols } = shapeSize(piece.cells);
      const maxCell = Math.min((slotW - 20) / cols, (slotH - 14) / rows, this.cell * 0.6);
      const pw = cols * maxCell, ph = rows * maxCell;
      const ox = this.sideTray
        ? this.trayX + (slotW - pw) / 2
        : i * slotW + (slotW - pw) / 2;
      const oy = this.sideTray
        ? i * slotH + (slotH - ph) / 2
        : this.trayY + (this.trayH - ph) / 2;
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
    const skin = boardSkin(this.skinId);
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
