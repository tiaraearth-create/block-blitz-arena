// GameView: canvas renderer + input controller for one board (player or spectator).
import { SIZE, shapeSize, ICE, ICE_CRACKED, EYE } from './engine.js';
import { PALETTE, getSkin, getBoard } from './themes.js';
import { ParticleSystem } from './particles.js';
import { audio } from './audio.js';
import { getSettings, particleFactor, motionFactor, prefersReducedMotion, onSettingsChange, onReducedMotionChange, showPlaceGhost, showClearHint } from './settings.js';
import { t } from './i18n.js';

// 🔥 コンボの段位 0=streak 2-4 / 1=5-9 / 2=10-19 / 3=20+ ごとの演出強度。
// スコアの comboMult は上限なしで伸びるのに、演出側は揺れも音も文字も
// streak 7 前後で全部天井に当たっていた。段ごとに開ける値をここにまとめる。
const COMBO_SHAKE_CAP = [14, 17, 20, 22];
const COMBO_FLASH = [0.15, 0.26, 0.38, 0.5];
const COMBO_SIZE = [1.8, 2.1, 2.45, 2.8];
const COMBO_COLOR = ['#ffe14d', '#ffa93d', '#ff5b5b', '#ff7bf0'];

// 🧊 氷が割れる音。audio.js 側に氷用の一発物が無いので、公開されている
// tone/noise だけで組み立てる（どちらも sfxOn と ensure() を自分で見るので、
// 音量ゼロ・音OFF・AudioContext 未生成でも安全に空振りする）。
// ICE→ヒビ（crack）と ヒビ→消滅（shatter）で音を分け、氷を2段階で崩している
// 手応えが耳にも残るようにする。割れたマス数だけ少しずつ遅らせて重ねる。
function sfxIce(count, shatter = false) {
  const n = Math.max(1, Math.min(4, Math.round(count) || 1));
  for (let i = 0; i < n; i++) {
    const d = i * 0.045;
    audio.noise({ dur: shatter ? 0.26 : 0.18, vol: shatter ? 0.15 : 0.13, freq: (shatter ? 6400 : 5200) + i * 400, delay: d });
    audio.tone({
      freq: (shatter ? 1320 : 880) + i * 60, dur: shatter ? 0.2 : 0.14,
      type: 'triangle', vol: shatter ? 0.14 : 0.12, sweep: -260, delay: d,
    });
  }
  // 落ちる低音。割れた（消えなかった）ときは鈍く、砕けた（消えた）ときは短く。
  audio.tone({ freq: shatter ? 420 : 320, dur: shatter ? 0.16 : 0.2, type: 'sine', vol: 0.08, sweep: -120, delay: 0.04 });
}

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

// ---------------------------------------------------------------------------
// 👁️ 観測マス（engine.js の EYE=12）
// ---------------------------------------------------------------------------
// 氷とまったく同じ理由でスキン関数を横取りする（PALETTE は 9 番までしか無く、
// 12 を渡すと PALETTE[ci] の分割代入がその場で落ちる ── しかも render() の
// 例外は握り潰されるので、**盤面だけが黙って白くなる**）。
// ⚠ 包む順は withEye を**いちばん外側**にすること。内側に入れると
//   withIce が先に 12 を素の draw へ渡してしまい、上の事故がそのまま起きる。
export function drawEyeBlock(ctx, x, y, s, alpha = 1, phase = 0) {
  const a = Math.max(0, Math.min(1, Number(alpha) >= 0 ? Number(alpha) : 1));
  if (a <= 0.02 || !(s > 0)) return;
  const pad = Math.max(1, s * 0.06);
  const bs = s - pad * 2;
  const cx = x + s / 2, cy = y + s / 2;
  ctx.save();
  ctx.globalAlpha = a;
  // 台。盤面から浮かないよう、暗い石の色に寄せる。
  ctx.fillStyle = 'rgba(18,16,28,0.92)';
  ctx.beginPath();
  const r = Math.max(2, bs * 0.18);
  ctx.roundRect(x + pad, y + pad, bs, bs, r);
  ctx.fill();
  // 眼。開き具合は phase（0=閉じ 1=見開き）。
  const open = Math.max(0.08, Math.min(1, Number(phase) || 0));
  const ew = bs * 0.42;
  const eh = ew * (0.16 + 0.62 * open);
  ctx.beginPath();
  ctx.ellipse(cx, cy, ew, eh, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(232,226,255,0.94)';
  ctx.fill();
  // 瞳。開くほど締まる。
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, eh * 0.62), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(28,10,42,0.96)';
  ctx.fill();
  ctx.restore();
}

const _eyeSkins = new WeakMap();
function withEye(draw) {
  let wrapped = _eyeSkins.get(draw);
  if (!wrapped) {
    wrapped = function (ctx, x, y, s, ci, alpha = 1) {
      if (ci === EYE) { drawEyeBlock(ctx, x, y, s, alpha, eyePhase()); return; }
      draw(ctx, x, y, s, ci, alpha);
    };
    _eyeSkins.set(draw, wrapped);
  }
  return wrapped;
}
// 開き具合はモード側（EyeWatch）が動かす。描画側は読むだけ。
let _eyePhase = 0;
export function setEyePhase(v) { _eyePhase = Math.max(0, Math.min(1, Number(v) || 0)); }
function eyePhase() { return _eyePhase; }

// 盤面のマス値（engine.grid 由来）を描くときは必ずこれを通す。
// 手札・ゴーストは piece.color(1..8) しか出さないので素の getSkin() で足りる。
export function boardSkin(skinId) { return withEye(withIce(getSkin(skinId))); }

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
    this._shake = 0;                // 実体。読み書きは下のアクセサ経由（設定でゲート）
    this._screenFlash = 0;          // 実体。読み書きは下のアクセサ経由（設定でゲート）
    this.time = 0;
    this.deco = [];                 // background decorations (stars etc.)
    // 装飾だけの時計。本体の time に係数を掛けると、設定を変えた瞬間に位相が
    // 飛んで背景が瞬間移動する。積分しておけば係数が変わっても連続につながる。
    this._decoTime = 0;

    this.drag = null;               // {index, piece, px, py}
    // ♿ 掴んで運ぶ以外の置きかた（手札をタップ／1〜3で選び、盤面をタップ／
    // 矢印キー＋Enter で置く）。ドラッグと併存し、どちらも同じ commitPlace() へ。
    this.sel = null;                // {index, piece, r, c}
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
    // 👻 モードが一時的にプレビューを落とす（運営ルーレットの「目隠し」）。
    //    プレイヤー設定より強い。null なら設定どおり。
    this.assistOverride = null;

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

    // 設定「エフェクト量」と OS の「視差効果を減らす」に追随する。
    // 明滅の速さは motionFactor() を毎コマ見れば済むが、粒の数だけは
    // 作り直さないと変わらないので、変わった瞬間を購読しておく。
    this._offSettings = onSettingsChange(() => this.syncDeco());
    this._offMotion = onReducedMotionChange(() => this.syncDeco());

    if (this.interactive) this.bindInput();
  }

  destroy() {
    this.running = false;
    this.stopIdleSweep();
    window.removeEventListener('resize', this._resize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    // 購読を残すと、破棄された view が設定変更のたびに生き返る。
    if (this._offSettings) { this._offSettings(); this._offSettings = null; }
    if (this._offMotion) { this._offMotion(); this._offMotion = null; }
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

  // 💥 画面の揺れも同じ形で一括ゲートする。モード・スキル側には
  // view.shake = N の直接代入が38箇所あり（modes.js 33 / skills.js 5）、
  // そのどれもが設定「画面の揺れ」を素通りしていた ── OS の「視差効果を減らす」で
  // 既定 false になっている人でも、ボス攻撃では 24 の最大級の揺れが出ていた。
  // フラッシュだけ消えて揺れだけ残ると、スイッチが壊れて見える。
  // 代入側は一切触らず、ここで受けて 0 に落とす。
  get shake() { return this._shake || 0; }
  set shake(v) {
    const n = Number(v);
    if (!(n > 0)) { this._shake = 0; return; }
    let on = true;
    try { on = getSettings().shake !== false; } catch { /* 設定が読めなければ従来どおり */ }
    this._shake = on ? n : 0;
  }

  setEngine(engine) {
    this.engine = engine;
    this.spawnAnim.clear();
    this.dying.length = 0;
    this.flashes.length = 0;
    this.floatTexts.length = 0;
    this.particles.clear();
    this.drag = null;
    this.sel = null;
    this.glowCells = null;
    this.dangerCells = null;
    this.dangerUntil = 0;
    this.dangerTotal = 0;
    this.keystoneCell = -1;
    this.coolCells = null;
    this.oreCells = null;
    this.ghostFx = null;
    // 👻 モードが落としたプレビューも試合ごとに戻す。view は使い回しなので、
    //    ここで消さないと**目隠しを引いた人が次の試合以降ずっとゴースト無し**になる
    //    （すぐ下の godInvincibleUntil がまさにその形の事故だった）。
    this.assistOverride = null;
    // 🛡 絶対防御の無敵は「1試合ぶん」の約束。同じアイテムの他の2効果
    //    （fortressUntil / streakShield）は engine 側にあるので試合ごとに
    //    消えるが、これだけ使い回しの view 側にあり、ここにも endToMenu にも
    //    無かったので**最大60秒ぶん次の試合へ持ち越して**いた。
    //    ⚠ 運営トグルの godInvincible（試合をまたいで効かせる意図がある）
    //      には触らない。消すのは残り時間のほうだけ。
    this.godInvincibleUntil = 0;
  }

  setTheme({ skinId, boardId, fxId }) {
    if (skinId) this.skinId = skinId;
    if (boardId) this.boardId = boardId;
    if (fxId) this.fxId = fxId;
    // 装飾は「盤面テーマが変わったとき」だけ組み直す。以前は無条件に呼んでいたので、
    // setTheme を通るたび（modes.js の getView() は毎回通る＝トップアウト・復帰・
    // スキル発動のたび）に星や火の粉40粒が全部その場で瞬間移動していた。
    if (this._decoBoard !== this.boardId || !this.deco.length) this.initDeco();
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
    if (rect.width === this._lastW && rect.height === this._lastH && dpr === this.dpr) {
      // 大きさは同じでも、上のアイテム帯が1行増えれば canvas は下へ「ずれる」。
      // ResizeObserver は位置の変化では鳴らないので、下の CSS 変数（画面座標）
      // だけが古いまま残り、それを見て置いたトーストが手札に重なる。
      // レイアウト計算は要らないので、変数の出し直しだけをここで拾う。
      if (rect.top !== this._lastTop || rect.left !== this._lastLeft) {
        this._lastTop = rect.top; this._lastLeft = rect.left;
        this.publishMetrics(rect);
      }
      return;
    }
    this._lastW = rect.width; this._lastH = rect.height;
    this._lastTop = rect.top; this._lastLeft = rect.left;
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

    // 📐 手札と盤面の位置を CSS 変数として公開する（画面座標の px 文字列）。
    // トーストやクリップバーが bottom:96px のような px 直打ちで置かれていて、
    // 端末によっては手札に丸かぶりしていた（縦持ちの手札帯は最大130px＋余白、
    // 横持ちでは下ではなく右にいる）。CSS 側が実測値で避けられるようにする。
    this.publishMetrics(rect);

    // ★ 作り直した直後に必ず描き直す。
    //   canvas.width への代入はビットマップを全消去する。ResizeObserver の
    //   コールバックは同じフレームの requestAnimationFrame の**後**に走るので、
    //   ここで描き直さないと「消去されたまま」の透明な板がそのフレームに出る
    //   ＝画面全体が一瞬消える。AI対戦のコンボ表示で毎回起きていたのがこれ。
    //   resize() は寸法が変わったときしか最後まで来ないので、追加の負担はない。
    //   （画面の回転・アドレスバーの出入り・ソフトキーボードでも同じ）
    if (this.running) {
      try { this.render(); } catch { /* 描けない状態なら次のコマに任せる */ }
    }
  }

  // 手札・盤面の位置を :root の CSS 変数として出す。
  //   --bba-hand-top     手札帯の上端（縦持ち＝盤面の下の帯の上端／横持ち＝帯の上端）
  //   --bba-hand-left    手札帯の左端（横持ち＝盤面の右の帯の左端／縦持ち＝全幅なので左端）
  //   --bba-board-bottom 盤面の下端
  // どれも **画面座標**（canvas.getBoundingClientRect() を足した値）の px 文字列。
  // キャンバス内座標のまま出すと、canvas が画面の途中から始まっている
  // （上にスコア帯がある）ぶんだけズレて、CSS からは使えない。
  // 手札を持たないモード（観戦・リプレイ）は帯が無いので、キャンバスの
  // 下端／右端＝「避けなくてよい」を出す。
  publishMetrics(rect) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const r = rect || this.canvas.getBoundingClientRect();
    const px = v => `${Math.round(v)}px`;
    const handTop = this.showTray ? Math.min(r.bottom, r.top + this.trayY) : r.bottom;
    const handLeft = this.showTray ? Math.min(r.right, r.left + this.trayX) : r.right;
    const boardBottom = Math.min(r.bottom, r.top + this.boardY + this.boardSize);
    try {
      const s = document.documentElement.style;
      s.setProperty('--bba-hand-top', px(handTop));
      s.setProperty('--bba-hand-left', px(handLeft));
      s.setProperty('--bba-board-bottom', px(boardBottom));
      s.setProperty('--bba-hand-piece-top', px(r.top + this.handPieceTop()));
    } catch { /* 差し替えられた document スタブなど */ }
  }

  // コマが実際に描かれ始める高さ（キャンバス内座標）。
  //
  // --bba-hand-top は「帯の上端」だが、drawTray はコマを**帯の中央**に描くので、
  // 盤面の下端と帯の上端のあいだではなく、**盤面の下端とコマの上端**のあいだが
  // 本当の空きになる。背の高い端末ではここが100px以上あって、通知を置くのに
  // ちょうどよい（盤面にも手札にも被らない唯一の場所）。
  //
  // いちばん背の高いコマ（縦5連 と 3×3）で計算する ── 実際に配られるコマで
  // 測ると、手札が変わるたびに通知の位置が飛ぶ。いちばん厳しい形に合わせておけば
  // どの手札でも被らない。式は drawTray と同じものを使うこと。
  handPieceTop() {
    if (!this.showTray) return this.H;
    if (this.sideTray) return 0;               // 横持ちは帯が右。縦方向の空きは別で見る
    const slotW = this.W / 3, slotH = this.trayH;
    const phOf = (rows, cols) => {
      const maxCell = Math.min((slotW - 20) / cols, (slotH - 14) / rows, this.cell * 0.6);
      return rows * maxCell;
    };
    const ph = Math.max(phOf(5, 1), phOf(3, 3));   // 縦5連 / 3×3 のうち背の高いほう
    return this.trayY + Math.max(0, (this.trayH - ph) / 2);
  }

  // 背景装飾の数。設定「エフェクト量」に素直に従う。
  // 以前は無条件に 70/40 個を撒いていたので、「低」にしても背景の星・火の粉は
  // 1粒も減らなかった（設定で止められない騒がしさとして残っていた）。
  // 「視差効果を減らす」ならさらに半分 ── 動きは motionFactor() 側で止まるが、
  // 止まった粒がびっしり乗っているのも視覚的な雑音なので数も落とす。
  decoCount() {
    const theme = getBoard(this.boardId);
    const base = theme.nebula ? 70 : 40;
    // 「高」は粒子と同じ 1.9 倍だが、背景まで2倍近くにすると賑やかを通り越すので
    // 1.4 で頭打ちにする（前景の粒子と違って背景は常時全部が見えているため）。
    let n = Math.round(base * Math.min(1.4, Math.max(0, particleFactor())));
    if (prefersReducedMotion()) n = Math.round(n * 0.5);
    return Math.max(6, n);
  }

  // 数が変わるときだけ組み直す。設定変更のたびに initDeco() を呼ぶと
  // 位置が全部引き直されて、背景がまるごと瞬間移動して見える。
  syncDeco() {
    if (this._decoBoard !== this.boardId || this.deco.length !== this.decoCount()) this.initDeco();
  }

  initDeco() {
    this._decoBoard = this.boardId;
    this.deco = [];
    const n = this.decoCount();
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
  // Input (drag & drop / tap to place / keyboard)
  // ------------------------------------------------------------------

  bindInput() {
    const pos = e => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // ♿ キーボードだけの人・長いドラッグを保てない人（片手操作、震え、
    // スイッチ操作）のために、canvas を Tab で到達できるようにする。
    // #gameCanvas は index.html 側に tabindex を持たないので、ここで付ける。
    try {
      if (!this.canvas.hasAttribute('tabindex')) this.canvas.setAttribute('tabindex', '0');
      this.canvas.setAttribute('role', 'application');
      this.canvas.setAttribute('aria-label', t(
        'ブロック盤面。1〜3キーで手札を選び、矢印キーで動かし、Enterで置く。Escで選択解除。手札をタップして選び、盤面をタップして置くこともできる。',
        'Block board. Press 1-3 to pick a piece, arrow keys to move it, Enter to place, Esc to cancel. You can also tap a piece then tap the board.',
      ));
    } catch { /* 差し替えられた canvas スタブなど */ }

    // 🖱 右クリックのメニューは盤面の上では出さない。
    //    掴んだままメニューが盤面を覆い、閉じるつもりの左クリックで意図しない
    //    1手を消費していた。
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    this.canvas.addEventListener('pointerdown', e => {
      // 🖱 左ボタン（＝主ポインタ）だけを受ける。
      //    右クリックでも掴めてしまい、中クリックは Windows Chrome の
      //    自動スクロールに pointerup を持っていかれるので、下の
      //    `if (this.drag) return;` に永久に阻まれて**以後どのコマも
      //    掴めなくなる**（固まったように見える）。
      //    e.button は touch/pen でも 0 になるので、指の操作は影響を受けない。
      if (e.button !== 0 || e.isPrimary === false) return;
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
        // sx/sy と moved は「掴んで運んだ」のか「つまんで離しただけ（タップ）」
        // なのかの判定用。ここで sel を消さないのは、同じ枠をもう一度タップして
        // 選択を解除できるようにするため（実際に運び始めた時点で消える）。
        this.drag = { index: slot, piece: this.engine.hand[slot], px: x, py: y, pointerId: e.pointerId, sx: x, sy: y, moved: false };
        audio.pickup();
        e.preventDefault();
        return;
      }
      // 👆 タップで置く: 手札を選んだ状態で盤面をタップしたら、そこへ置く。
      if (this.sel) { if (this.tapPlace(x, y)) e.preventDefault(); }
    });

    this.canvas.addEventListener('pointermove', e => {
      // Only the pointer that started the drag may move it — a second finger's
      // movement must not drag the held piece to its position.
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { x, y } = pos(e);
      this.drag.px = x;
      this.drag.py = y;
      if (!this.drag.moved && Math.abs(x - this.drag.sx) + Math.abs(y - this.drag.sy) > 8) {
        this.drag.moved = true;
        this.sel = null;          // 運び始めた＝従来どおりのドラッグ。選択は捨てる。
      }
    });

    const drop = e => {
      // Only the pointer that started the drag may release it — a second
      // finger's pointerup must not drop the held piece.
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { x, y } = pos(e);
      const anchor = this.dragAnchor();
      const { index, piece } = this.drag;
      // 動かさずに同じ枠で離した＝タップ選択。従来はここで dragAnchor() が
      // null になり「putback の音だけ鳴って何も起きない」空振りだった。
      const tapped = !this.drag.moved && this.trayHit(x, y) === index;
      this.drag = null;
      // pointerdown checks inputLocked, but the lock can land DURING a drag —
      // the timer expiring, the run ending, the result already submitted. A
      // release after that used to still place the piece and move the score.
      if (this.inputLocked || !this.running || !this.engine || this.engine.over) {
        audio.putback();
        return;
      }
      if (tapped && this.engine.hand[index] === piece) { this.setSel(index, piece, true); return; }
      // Chimera welding: the drag preview (drawDrag) uses the same predicate,
      // so whenever the weld highlight is showing, releasing welds — and
      // whenever a board ghost is showing, releasing places. Never both.
      const wslot = this.weldTargetAt(x, y, index);
      if (wslot !== -1 && this.onTrayDrop(index, wslot)) return;
      // The hand can be rewritten mid-drag (a boss move, a co-op broadcast,
      // the admin's 🎴 hand shuffle). dragAnchor() ghosts the piece you picked
      // UP, so placing hand[index] blind would drop a different shape than the
      // one under your finger.
      if (anchor) this.commitPlace(index, piece, anchor.r, anchor.c);
      else audio.putback();
    };
    this.canvas.addEventListener('pointerup', drop);
    this.canvas.addEventListener('pointercancel', e => { if (this.drag && e.pointerId === this.drag.pointerId) { this.drag = null; audio.putback(); } });

    // ⌨️ キーボード操作。1〜3 で手札、矢印で移動、Enter で設置、Esc で解除。
    // Space は必殺技（main.js の window keydown）に割り当て済みなので触らない。
    // 矢印は preventDefault だけして伝播は止めない（コナミコマンド等はそのまま）。
    this.canvas.addEventListener('keydown', e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!this.engine || this.engine.over || !this.running || this.inputLocked) return;
      const k = e.key;
      if (k === '1' || k === '2' || k === '3') { this.selectSlot(Number(k) - 1); e.preventDefault(); return; }
      if (k === 'Escape') { if (this.sel) { this.sel = null; audio.putback(); e.preventDefault(); } return; }
      const dr = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      const dc = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
      if (dr || dc) {
        if (!this.sel && !this.selectFirstPlayable()) return;
        this.moveSel(dr, dc);
        e.preventDefault();
        return;
      }
      if (k === 'Enter') {
        if (this.sel) { this.commitSel(); e.preventDefault(); }
        else if (this.selectFirstPlayable()) e.preventDefault();
      }
    });
  }

  // ドラッグ・タップ・キーボードの3経路が最後に必ず通る1本道。
  // 「置けたか（＝手を消費したか）」を返す。false のときは選択を残す。
  commitPlace(index, piece, r, c) {
    if (this.inputLocked || !this.running || !this.engine || this.engine.over) { audio.putback(); return false; }
    // 掴んでいる/選んでいる間に手札が書き換わることがある（ボスの技、協力プレイの
    // 配信、管理者の🎴シャッフル）。別の形を置いてしまわないよう同一性を見る。
    // ❄️ ボスの呪縛（8秒の氷結）は、ここで見る。
    //    判定が入口3か所（pointerdown / selectSlot / selectFirstPlayable）に
    //    しか無かったので、**凍る前に掴んで／選んでいれば無視して置けた** ──
    //    ドラッグ操作の人だけが罰を受け、タップ選択の人は受けない、という
    //    不公平にもなっていた。このコメントの下の行が自分で「最後に必ず通る
    //    1本道」と言っているとおり、判定はここに置くのが正しい。
    //    入口側の判定は、掴む前に分かる即時のフィードバックとして残す。
    if (piece.frozenUntil > Date.now()) {
      audio.invalid();
      // 選んだままの枠が凍ったら、選択も落とす（凍った枠を選び続けさせない）。
      if (this.sel && this.sel.index === index) this.sel = null;
      return false;
    }
    if (this.engine.hand[index] !== piece) { audio.putback(); return false; }
    // 🚫 置けない場所へ落とした。
    //    onIllegal は宣言だけあって、代入も呼び出しも一度も無かった（死んだ口）。
    //    「置けない場所へ続けて落としている＝盤面が読めていない」は、詰みの
    //    予兆としてもチュートリアルの助け舟としても一番素直な合図なので、
    //    ここで鳴らして使えるようにする。モードが何も繋がなければ従来どおり。
    if (!(r >= 0 && c >= 0) || !this.engine.canPlace(piece, r, c)) {
      audio.putback();
      if (this.onIllegal) { try { this.onIllegal(index, r, c); } catch { /* 合図で走行を止めない */ } }
      return false;
    }
    // Co-op runs on a server-authoritative board: the hook forwards the
    // move and returns true, and the real placement arrives as a broadcast.
    if (this.onIntentPlace && this.onIntentPlace(index, r, c)) return true;
    const result = this.engine.place(index, r, c);
    if (result) this.applyResult(result);
    return true;
  }

  // ------------------------------------------------------------------
  // ♿ 選択カーソル（タップ選択 / キーボード）
  // ------------------------------------------------------------------

  // 手札の枠を選ぶ。同じ枠をもう一度選ぶと解除（トグル）。
  // quiet: pointerdown 側で既に pickup が鳴っているタップ経路用（音の二重鳴り防止）。
  setSel(slot, piece, quiet = false) {
    if (!piece) return false;
    if (this.sel && this.sel.index === slot && this.sel.piece === piece) { this.sel = null; audio.putback(); return false; }
    const { rows, cols } = shapeSize(piece.cells);
    let r, c;
    if (this.sel) { r = this.sel.r; c = this.sel.c; }   // 持ち替えてもカーソルは動かさない
    else {
      // 最初の1手でいきなり赤いゴーストを出さないよう、置ける場所へ寄せる。
      // 👻 ただしこれは盤面全体を走査した**結果**（合法手を1つ配っている）なので、
      //    結果の層に従う。「控えめ＝結果は出さない」と言った以上、ここも止める。
      const spots = (this.engine && this.showClear()) ? this.engine.placements(piece) : [];
      if (spots.length) { r = spots[0][0]; c = spots[0][1]; }
      else { r = (SIZE - rows) >> 1; c = (SIZE - cols) >> 1; }
    }
    this.sel = {
      index: slot, piece,
      r: Math.max(0, Math.min(SIZE - rows, r)),
      c: Math.max(0, Math.min(SIZE - cols, c)),
    };
    if (!quiet) audio.pickup();
    return true;
  }

  selectSlot(slot) {
    if (!this.engine || this.engine.over || !this.running || this.inputLocked) return false;
    const piece = this.engine.hand[slot];
    if (!piece) { audio.invalid(); return false; }
    if (piece.frozenUntil > Date.now()) { audio.invalid(); return false; }   // ボスの氷結
    return this.setSel(slot, piece);
  }

  // 矢印キーをいきなり押した人のために、掴める枠を1つ選んでおく。
  selectFirstPlayable() {
    if (!this.engine) return false;
    for (let i = 0; i < 3; i++) {
      const p = this.engine.hand[i];
      if (p && !(p.frozenUntil > Date.now())) return this.selectSlot(i);
    }
    return false;
  }

  moveSel(dr, dc) {
    const s = this.sel;
    if (!s) return;
    const { rows, cols } = shapeSize(s.piece.cells);
    s.r = Math.max(0, Math.min(SIZE - rows, s.r + dr));
    s.c = Math.max(0, Math.min(SIZE - cols, s.c + dc));
  }

  commitSel() {
    const s = this.sel;
    if (!s) return false;
    if (!this.commitPlace(s.index, s.piece, s.r, s.c)) return false;
    this.sel = null;
    return true;
  }

  // 盤面タップ → 選んでいるピースの中心をそこへ合わせて置く。
  // ドラッグの持ち上げ（liftAmount）は掛けない ── 指の位置がそのまま置き場所。
  // 盤面から大きく外れたタップは無視する（余白の誤タップで消費させない）。
  tapPlace(x, y) {
    const s = this.sel;
    if (!s || !this.engine) return false;
    // 🖐 手札の帯に入ったタップは「盤面のタップ」ではない。
    //    使い終わって空になった枠を叩くと、上の pointerdown は
    //    `hand[slot]` が無いので掴まずに素通りし、ここへ落ちてくる。
    //    下の余白の許容（cell×0.75）が帯と重なっているので、そのまま
    //    最下段へ置かれていた ── 置くつもりのない1手を消費する。
    //    帯の当たり判定は trayHit が持っているので、そのまま借りる
    //    （縦持ち・横持ちの違いもあちらが面倒を見ている）。
    if (this.trayHit(x, y) !== -1) return false;
    const m = this.cell * 0.75;
    if (x < this.boardX - m || x > this.boardX + this.boardSize + m
      || y < this.boardY - m || y > this.boardY + this.boardSize + m) return false;
    const { rows, cols } = shapeSize(s.piece.cells);
    const c = Math.round((x - this.boardX - cols * this.cell / 2) / this.cell);
    const r = Math.round((y - this.boardY - rows * this.cell / 2) / this.cell);
    s.r = Math.max(0, Math.min(SIZE - rows, r));
    s.c = Math.max(0, Math.min(SIZE - cols, c));
    this.commitSel();
    return true;
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

  // 👻 配置プレビューの2層。設定（settings.js）とモードの上書きを合わせた答え。
  //    設定が読めない環境では従来どおり全部出す（screenFlash / shake と同じ流儀）。
  showGhost() {
    if (this.assistOverride === 'off') return false;
    try { return showPlaceGhost(); } catch { return true; }
  }
  showClear() {
    if (this.assistOverride === 'off') return false;
    try { return showClearHint(); } catch { return true; }
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
      // 🔥 コンボの段位。加点側（engine.js の comboMult）は青天井なのに、
      // 演出は streak 7 前後でほぼ全部が天井に当たっていた ── streak 8 と
      // streak 25 が音も画面も同じで、いちばん盛り上がる所で演出が黙る。
      // 段（2-4 / 5-9 / 10-19 / 20+）ごとに揺れ・フラッシュ・文字を伸ばす。
      const tier = result.streak >= 20 ? 3 : result.streak >= 10 ? 2 : result.streak >= 5 ? 1 : 0;

      // full-screen flash on multi-line clears / hot streaks
      // 以前は streak 側が 0.15 固定で、どれだけ繋いでも明るくならなかった。
      const lineFlash = result.lineCount >= 2 ? Math.min(0.45, 0.18 + result.lineCount * 0.09) : 0;
      const comboFlash = result.streak >= 3 ? COMBO_FLASH[tier] : 0;
      const flash = Math.max(lineFlash, comboFlash);
      if (flash > 0) this.screenFlash = flash;

      // 揺れの上限も段で開ける（14 → 22）。1ライン消しだと streak 7 で天井だった。
      if (getSettings().shake) this.shake = Math.min(COMBO_SHAKE_CAP[tier], 4 + result.lineCount * 3 + result.streak);
      audio.clearLines(result.lineCount, result.streak);
      // 🧊 ヒビの入った氷(11)が実際に砕けた回だけ、通常のライン音に
      // 高い破砕音を重ねる。「割った → 砕いた」の2段階が耳でも分かる。
      const shattered = result.clearedCells.reduce((n, cc) => n + (cc[2] === ICE_CRACKED ? 1 : 0), 0);
      if (shattered > 0) sfxIce(shattered, true);

      const centerX = this.boardX + this.boardSize / 2;
      const centerY = this.boardY + this.boardSize * 0.4;
      this.addFloatText(centerX, centerY, `+${result.gained}`, '#ffffff', 1.4);
      if (result.streak >= 2) {
        // 文字も段で大きく・熱く（黄→橙→赤→桃）。以前はサイズ1.8固定だった。
        this.addFloatText(centerX, centerY - this.cell * 1.3, `${result.streak} COMBO!`, COMBO_COLOR[tier], COMBO_SIZE[tier]);
        audio.combo(result.streak);
        this.particles.confetti(centerX, centerY, this.cell, 10 + result.streak * 6);
      }
      // 称号は lineCount だけで決まっていたので、長く繋いでも一言も出なかった。
      // 高い段では streak 側の称号を優先して出す。
      const streakPraise = tier >= 3 ? 'UNREAL!' : tier >= 2 ? 'UNSTOPPABLE!' : null;
      const praise = streakPraise
        || (result.lineCount >= 4 ? 'LEGENDARY!' : result.lineCount === 3 ? 'AMAZING!' : result.lineCount === 2 ? 'GREAT!' : null);
      if (praise) {
        this.addFloatText(centerX, centerY + this.cell, praise,
          streakPraise ? COMBO_COLOR[tier] : '#43d9e8', streakPraise ? 1.8 : 1.5);
      }
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
      // 音が無いと、盤面で一番緊張する瞬間と何も起きていない1手が
      // 耳には同じに聞こえていた（凍った線は lineCount に入らないので
      // audio.clearLines() も鳴らない）。割れた手応えをここで返す。
      sfxIce(result.crackedCells.length);
      for (const r of result.frozenRows) this.flashes.push({ kind: 'row', index: r, t: now, color: '#9be3ff' });
      for (const c of result.frozenCols) this.flashes.push({ kind: 'col', index: c, t: now, color: '#9be3ff' });
      for (const [r, c] of result.crackedCells) {
        this.spawnAnim.set(r * SIZE + c, now);
        this.particles.ring(this.boardX + (c + 0.5) * this.cell, this.boardY + (r + 0.5) * this.cell, this.cell * 0.9, '#9be3ff');
      }
      if (getSettings().shake) this.shake = Math.max(this.shake, 4);
    }

    if (this.onPlace) this.onPlace(result);
    // ⚠ handleOver() を直接呼ばないこと。_checkOver を通すと「一度鳴らした」印
    //   （_wasOver）が立つので、次のコマの見張りが同じ死を二度鳴らさない。
    if (result.over) this._checkOver();
  }

  // 盤面が死んだときの共通処理。置いた直後（applyResult）と、毎コマの見張り
  // （update の _checkOver）の両方から通る。
  handleOver() {
    if (!this.engine) return;
    // Staff "invincible" switch / 絶対防御 item: the board resets instead.
    if (this.godInvincible || this.godInvincibleUntil > Date.now()) {
      this.engine.reviveBoard();
      this.reviveFlash();
      this.addFloatText(this.boardX + this.boardSize / 2, this.boardY + this.boardSize / 2, 'INVINCIBLE!', '#ffd75e', 1.6);
      return;
    }
    // Autopilot 5.0 guard: a rescue may redraw the hand / clear cells instead.
    if (this.onRescue && this.onRescue()) return;
    // 💀 死亡ジングルは「本当に終わったとき」だけ。
    //
    //    以前はここで無条件に鳴らしてから onGameOver() を呼んでいたので、
    //    ダンジョンの残機・無限地獄ラッシュの不死鳥の羽で**復活する回も、
    //    必ず死亡音が鳴り切ってから「復活！」のトーストが出て**いた
    //    （天国は5階ごとに残機が増えるので、何度も起きる）。
    //    モード側が「復活した」を返せるようにして、その回は鳴らさない
    //    ── onRescue と同じ扱いにそろえる。
    const revived = this.onGameOver ? this.onGameOver() === true : false;
    if (!revived) audio.gameOver();
  }

  // 🪦 盤面が死んだことに気づく口が、長らく「置いた直後」しか無かった。
  //
  // engine.over は place() だけでなく **addGarbage() でも立つ**（engine.js:371）。
  // ところが onGameOver を鳴らすのは applyResult＝1手置いたときだけなので、
  // お邪魔で埋まって詰んだ場合は「置けない → applyResult が二度と走らない →
  // 誰も気づかない」で走行が固まる。お邪魔を受ける経路は11か所あり、
  // そのうち自前で over を見ていたのは4か所だけだった。
  //
  // いちばん重かったのが 👁️断罪 ── サーバー側の席は生きたままなので、
  // 動けない本人に断罪が飛び続け、斬れないので毎回「落とした」になり、
  // 段のHPが回復し、住人がその人の名前で処刑されていった。
  //
  // 個別に足すと必ず漏れる（モードもお邪魔の経路も増え続ける）ので、
  // 盤面を見ているここで1回だけ拾う。false→true の変化でだけ鳴らすので、
  // reviveBoard() で生き返ったあとの2度目もちゃんと鳴る。
  _checkOver() {
    const over = !!(this.engine && this.engine.over);
    if (over && !this._wasOver) { this._wasOver = true; this.handleOver(); }
    else if (!over) this._wasOver = false;
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
    this.startIdleSweep();
    const loop = ts => {
      if (!this.running) return;
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      this.time += dt;
      // ResizeObserver が主。これは保険で、Observer が来ない環境でも
      // 0.25秒以内には気づけるようにしてある。resize() は寸法が同じなら
      // 即 return するので、実質の負担は計測1回ぶん。
      if ((this._sizeTick = (this._sizeTick || 0) + 1) >= 15) { this._sizeTick = 0; this.resize(); }
      // ★ 次のコマの予約を「描く前」に済ませる。
      //   以前は update()→render() のあとに requestAnimationFrame していたので、
      //   描画のどこかで1度でも例外が飛ぶと再予約に届かず、盤面が二度と動かなく
      //   なった（実際に起きていた: 画面が隠れている等で W/H が 0 になると
      //   drawBackground() の createLinearGradient が
      //   "The provided double value is non-finite" を投げ、そこで永久停止する）。
      //   先に予約しておけば、1コマ落ちても次のコマで復帰できる。
      requestAnimationFrame(loop);
      try {
        this.update(dt);
        this.render();
      } catch (err) {
        // 毎コマ同じ例外が出るとコンソールが埋まって本当の原因が見えなくなる。
        // 最初の1回だけ出す。
        if (!this._drawErrShown) { this._drawErrShown = true; console.error('[render]', err); }
      }
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; this.stopIdleSweep(); }

  // 🧹 タブが隠れている間の掃除。
  // 演出の間引きは update() の中にしか無く、update() は requestAnimationFrame
  // からしか呼ばれない。ところがオートパイロットは setTimeout の連鎖で回るので、
  // タブが隠れると「撒くだけ撒いて誰も片付けない」状態になり、粒子・消滅演出・
  // 浮き文字が際限なく伸びる（実測で100秒に粒子12万個／ヒープ +33MB）。
  // 隠れている間だけ、時計を進めて間引くだけの軽い経路をタイマーで回す
  // （描画はしない）。表示中は rAF がやるので何もしない。
  startIdleSweep() {
    if (this._idleTimer || typeof document === 'undefined') return;
    this._idleTs = performance.now();
    this._idleTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, Math.max(0, (now - this._idleTs) / 1000));
      this._idleTs = now;
      if (!this.running || !document.hidden) return;
      this.time += dt;
      this.update(dt);
    }, 250);
  }

  stopIdleSweep() {
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
  }

  update(dt) {
    // 置いた以外の理由（お邪魔で埋まる等）で盤面が死んでいないか。詳しくは _checkOver。
    this._checkOver();
    this.particles.intensity = particleFactor();
    this.particles.update(dt);
    // 💥 揺れの減衰。以前は一律 40/秒だったので、ボス攻撃の 24 は 0.6秒も
    // 揺れ続けていた（弱い揺れは 0.1秒で終わるのに、強い揺れだけが尾を引く）。
    // 振幅に比例した項を足して、大きい揺れほど速く収まるようにする。
    this.shake = Math.max(0, this.shake - dt * (40 + this.shake * 2.2));
    this.stepShake(dt);
    // 装飾の時計は設定の係数を掛けて別に積む（drawBackground が使う）。
    this._decoTime = (this._decoTime || 0) + dt * motionFactor();
    this.screenFlash = Math.max(0, (this.screenFlash || 0) - dt * 1.6);
    const now = this.time;
    this.dying = this.dying.filter(d => now - d.t < 0.35);
    this.flashes = this.flashes.filter(f => now - f.t < 0.4);
    this.floatTexts = this.floatTexts.filter(f => now - f.t < f.life);
    // 選んだ枠を他所（ボスの技、協力プレイの配信、🎴シャッフル、オートパイロット）が
    // 書き換えたら選択は捨てる。commitPlace も同一性を見るので二重の保険。
    if (this.sel && this.engine && this.engine.hand[this.sel.index] !== this.sel.piece) this.sel = null;
    // 上限を超えたぶんは古いものから捨てる。上の間引きが効かない経路が
    // また生えても、同じ壊れ方（際限なく伸びる）はしない。
    if (this.dying.length > 900) this.dying.splice(0, this.dying.length - 900);
    if (this.floatTexts.length > 200) this.floatTexts.splice(0, this.floatTexts.length - 200);
    if (this.flashes.length > 200) this.flashes.splice(0, this.flashes.length - 200);
  }

  // 💥 揺れの向きを「前のコマから続くもの」にする。
  // 以前は render のたびに独立した一様乱数を translate に渡していた。中身は
  // 白色雑音（毎コマ無関係な位置へ飛ぶ）なので、同じ振幅でも数倍うるさく見え、
  // 「チカチカする」の一因になっていた。20Hz で目標点を引き直し、そこへ
  // 寄せていくと、振れ幅はそのままでも「揺れ」として読める動きになる。
  // 目標は前回と逆側に取る ── 同じ側へ続けて飛ぶと片寄った滑りに見えるため。
  stepShake(dt) {
    if (!(this.shake > 0)) { this._shakeX = 0; this._shakeY = 0; this._shakeAcc = 0; return; }
    this._shakeAcc = (this._shakeAcc || 0) + dt;
    if (!this._shakeTx || this._shakeAcc >= 0.05) {
      this._shakeAcc = 0;
      const flip = v => (v > 0 ? -1 : 1) * (0.175 + Math.random() * 0.325);   // ±0.175〜0.5（従来の振れ幅と同じ）
      this._shakeTx = flip(this._shakeTx || 0);
      this._shakeTy = flip(this._shakeTy || 0);
    }
    const k = Math.min(1, dt * 22);   // 目標へ寄せる速さ（60fps で約3コマぶん）
    this._shakeX = (this._shakeX || 0) + (this._shakeTx - (this._shakeX || 0)) * k;
    this._shakeY = (this._shakeY || 0) + (this._shakeTy - (this._shakeY || 0)) * k;
  }

  render() {
    const { ctx } = this;
    // 画面が隠れている・まだ寸法が付いていないときは W/H が 0 や NaN になる。
    // そのまま描くとグラデーションの生成が例外を投げるので、寸法が付くまで待つ。
    // （描かなくても状態は update() が進めているので、見えるようになった時点で
    //   正しい絵が出る）
    if (!(this.W > 0) || !(this.H > 0)) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);

    if (this.shake > 0) {
      // 乱数は stepShake() が持っている（render は描くだけ）。
      ctx.translate((this._shakeX || 0) * this.shake, (this._shakeY || 0) * this.shake);
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
      else if (this.sel) this.drawSelection();
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
    // 🎚️ 装飾の時計。設定「エフェクト量」と OS の「視差効果を減らす」で
    // 進み方に係数が掛かっている（update() で積んでいる）。
    // 粒の数を減らすだけでは1粒あたりの瞬きの速さは変わらないので、
    // 明滅・流れ・オーロラの角速度はすべてこちらを見る。
    // 「視差効果を減らす」では係数が 0 になり、この時計が止まる＝装飾が静止する。
    const t0 = this._decoTime || 0;
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, theme.bg[0]);
    g.addColorStop(1, theme.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, this.W + 40, this.H + 40);

    // Aurora board: translucent light ribbons waving across the upper sky.
    if (theme.aurora) {
      const hues = [160, 200, 285];
      for (let b = 0; b < 3; b++) {
        ctx.globalAlpha = 0.10 + 0.05 * Math.sin(t0 * 0.7 + b * 2.1);
        ctx.fillStyle = `hsl(${hues[b] + 12 * Math.sin(t0 * 0.3 + b)}, 90%, 60%)`;
        ctx.beginPath();
        const baseY = this.H * (0.10 + b * 0.09);
        ctx.moveTo(-20, baseY);
        for (let px = -20; px <= this.W + 20; px += 24) {
          ctx.lineTo(px, baseY + Math.sin(px * 0.012 + t0 * (0.8 + b * 0.25) + b * 3) * this.H * 0.05);
        }
        for (let px = this.W + 20; px >= -20; px -= 24) {
          ctx.lineTo(px, baseY + this.H * (0.10 + b * 0.02) + Math.sin(px * 0.010 + t0 * 0.6 + b) * this.H * 0.04);
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
      let alpha = 0.3 + 0.3 * Math.sin(t0 * d.sp + d.tw);
      let color = '#cfe0ff';
      let r = d.r;
      if (theme.fireflies) color = '#b8ff9e';
      else if (theme.nebula) color = '#d9b8ff';
      if (theme.bubbles || theme.fireflies) {
        y = ((d.y - t0 * 0.01 * d.sp) % 1 + 1) % 1 * this.H;
      } else if (theme.embers) {
        // 立ちのぼる火の粉。
        // 以前はここだけ極端に騒がしく、鬼ステージ（AI対戦の「鬼」）で
        // 「画面がチカチカする」原因の一つになっていた:
        //   ・色を Math.sin(t*6)>0 で2色に**切り替えて**いた
        //     → 1粒あたり毎秒1.91回の急変、40粒で毎秒76回のちらつき
        //   ・明るさが 0.35+0.35*sin(t*5) で毎秒0.8回の全消え全点き
        //     （他のステージは 0.05〜0.36回/秒。桁が違う）
        //   ・しかも色(6rad/s)と明るさ(5rad/s)で周波数がズレていたので
        //     6.28秒周期のうなりが出て、点き方が不規則に見えていた
        // いまは同じ角速度でゆっくり揺らし、色は切り替えず補間する。
        // 「揺らめく火の粉」の印象は保ったまま、瞬きだけが消える。
        y = ((d.y - t0 * 0.03 * d.sp) % 1 + 1) % 1 * this.H;
        x += Math.sin(t0 * 2 + d.tw) * 10;
        const heat = 0.5 + 0.5 * Math.sin(t0 * 1.8 + d.tw);   // 0..1
        color = `rgb(${Math.round(255)},${Math.round(93 + 45 * heat)},${Math.round(93 - 1 * heat)})`;
        alpha = 0.42 + 0.22 * Math.sin(t0 * 1.8 + d.tw);      // 消えきらない
      } else if (theme.petals) {
        // falling sakura petals with sway
        y = ((d.y + t0 * 0.025 * d.sp) % 1) * this.H;
        x += Math.sin(t0 * 1.6 + d.tw) * 16;
        color = Math.sin(d.tw) > 0 ? '#ffc0dc' : '#ff9ecb';
        alpha = 0.45 + 0.25 * Math.sin(t0 * 2 + d.tw);
        r = d.r * 1.4;
      } else if (theme.holy) {
        // ゆっくり膨らんで消える金色のきらめき。
        // 以前は alpha が半周期まるごと 0（完全消灯）で、しかも半径が2倍まで
        // 膨らんでいたので「点滅」に見えていた。下限を持たせて、ふくらみも控えめに。
        color = '#ffe9a8';
        const tw = Math.sin(t0 * d.sp * 1.5 + d.tw);
        alpha = 0.16 + 0.5 * Math.max(0, tw);
        r = d.r * (1 + 0.5 * Math.max(0, tw));
      } else if (theme.snow) {
        // gently falling snowflakes with sway
        y = ((d.y + t0 * 0.018 * d.sp) % 1) * this.H;
        x += Math.sin(t0 * 1.2 + d.tw) * 12;
        color = '#eaf4ff';
        alpha = 0.5 + 0.3 * Math.sin(t0 * 1.5 + d.tw);
        r = d.r * 1.2;
      } else if (theme.digital) {
        // 電脳の雨。色は粒ごとに固定（d.tw は時間で変わらないので点滅しない）。
        // 明滅だけ 4rad/s → 1.9rad/s に落として、他のステージと同じ落ち着きに揃える。
        y = ((d.y + t0 * 0.08 * d.sp) % 1) * this.H;
        color = Math.sin(d.tw) > 0.3 ? '#5ee86e' : '#9effc0';
        alpha = 0.3 + 0.28 * Math.sin(t0 * 1.9 + d.tw);
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
    const ghost = this.drag
      ? (this.weldTargetAt(this.drag.px, this.drag.py, this.drag.index) === -1 ? this.ghostInfo() : null)
      : (this.sel ? this.selGhost() : null);

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
      this.drawFrostMark(x + cell / 2, y + cell / 2, cell * 0.26);
    }
    ctx.globalAlpha = 1;
  }

  // Dig-mode ore: a Map(cellKey → 'gold'|'crystal'|'rainbow') drawn as a
  // glinting icon over the rock block underneath.
  drawOre() {
    if (!this.oreCells || !this.oreCells.size) return;
    const { ctx, cell } = this;
    const TINT = { gold: '#ffd75e', crystal: '#4dd0ff', rainbow: '#ff6bd4' };
    const glint = 0.16 + 0.12 * Math.sin(this.time * 3);
    for (const [k, type] of this.oreCells) {
      const r = (k / SIZE) | 0, c = k % SIZE;
      const x = this.boardX + c * cell, y = this.boardY + r * cell;
      ctx.globalAlpha = glint;
      ctx.fillStyle = TINT[type] || '#ffd75e';
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.globalAlpha = 1;
      this.drawOreMark(x + cell / 2, y + cell / 2, cell * 0.26, type);
    }
    ctx.globalAlpha = 1;
  }

  // 鉱石の粒。以前は 🪙 / 💠 / 🌈 を fillText で描いていたが、canvas に出る
  // 絵文字は端末のフォント任せで、Windows では 🌈 が横に潰れて 💠 と見分けが
  // 付かなかった（盤面でいちばん判断に使う印なのに）。3種を **形** で描き分ける:
  //   金＝丸 / クリスタル＝菱形 / 虹＝三重の弧
  // icons.js の SVG は canvas に直接は置けないので、ここは同じ意匠を手で描く。
  drawOreMark(cx, cy, r, type) {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, r * 0.34);
    ctx.lineCap = 'round';
    if (type === 'crystal') {
      ctx.fillStyle = '#eaf9ff';
      ctx.strokeStyle = '#0e5c7d';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (type === 'rainbow') {
      // 三重の弧。色を落としても「重なった弧」で虹だと分かる。
      const bands = ['#ff6bd4', '#ffd75e', '#4dd0ff'];
      ctx.lineWidth = Math.max(1.4, r * 0.3);
      bands.forEach((col, i) => {
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy + r * 0.55, r * (1 - i * 0.3), Math.PI, 0);
        ctx.stroke();
      });
    } else {
      ctx.fillStyle = '#ffd75e';
      ctx.strokeStyle = '#8a5a00';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // 氷の印（メルトダウンの冷却セル・凍結した手持ち）。
  // ❄️ は端末で絵が大きく違い、小さいセルではつぶれて青い点になっていた。
  drawFrostMark(cx, cy, r) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = '#eaf9ff';
    ctx.lineWidth = Math.max(1.4, r * 0.26);
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (Math.PI / 3) * i;
      const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
      ctx.beginPath();
      ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy);
      ctx.stroke();
      // 枝。これが無いと「米印」に見えて雪だと分からない。
      for (const sgn of [-1, 1]) {
        const bx = cx + dx * 0.6 * sgn, by = cy + dy * 0.6 * sgn;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - dy * 0.3 - dx * 0.2 * sgn, by + dx * 0.3 - dy * 0.2 * sgn);
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + dy * 0.3 - dx * 0.2 * sgn, by - dx * 0.3 - dy * 0.2 * sgn);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // キメラ工房の溶接ピースの印。二重らせん（交差する2本の弧）。
  drawWeldMark(cx, cy, r) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx - r * sgn, cy - r);
      ctx.bezierCurveTo(cx + r * sgn, cy - r * 0.4, cx - r * sgn, cy + r * 0.4, cx + r * sgn, cy + r);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.7, cy); ctx.lineTo(cx + r * 0.7, cy);
    ctx.stroke();
    ctx.restore();
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

  // 👆 いま掴んでいるコマ。**掴んだときのもの**が正。
  //
  // 置く側（drop / commitPlace）は this.drag.piece で同一性を見ているのに、
  // 描く側は engine.hand[index] を読んでいたので、掴んでいる最中に手札が
  // 書き換わると（管理者イベントの手札シャッフルは6.5〜12秒ごと、
  // レインボーハンド、ミニピース）**指の下の絵とゴーストだけが別のコマに
  // すり替わる**。緑の（置ける）ゴーストが出ているのに、離すと putback が
  // 鳴るだけ。背の高いコマに化けると赤いマスが手札の帯の上まではみ出す。
  // すり替わりに気づいたら、そのドラッグは捨てる（掴み直してもらう）。
  dragPiece() {
    if (!this.drag || !this.engine) return null;
    const live = this.engine.hand[this.drag.index];
    // 掴んだままの枠を自分以外が消化する（協力プレイのサーバー代打ち、
    // オートパイロット）と hand[index] が null になる。canPlace(null) は
    // piece.cells で TypeError を投げ、それが render() の中なので
    // requestAnimationFrame の再登録に届かず描画が永久に止まる。
    if (!live) return null;
    if (live !== this.drag.piece) {
      this.drag = null;
      audio.putback();
      return null;
    }
    return live;
  }

  ghostInfo() {
    const anchor = this.dragAnchor();
    if (!anchor) return null;
    const piece = this.dragPiece();
    if (!piece) return null;
    return this.ghostAt(piece, anchor);
  }

  // 選択カーソル（タップ選択／キーボード）のゴースト。ドラッグと同じ形で返す。
  selGhost() {
    const s = this.sel;
    if (!s || !this.engine) return null;
    const piece = this.engine.hand[s.index];
    if (!piece || piece !== s.piece) return null;
    return this.ghostAt(piece, { r: s.r, c: s.c });
  }

  ghostAt(piece, anchor) {
    const valid = this.engine.canPlace(piece, anchor.r, anchor.c);
    const willRows = new Set(), willCols = new Set();
    // ❄️ 氷結: 揃っても氷があると消えない線。白く光らせると「消える」と嘘に
    // なるので、別の集合に分けて水色で見せる（resolveLines の判定と同じ規則）。
    const freezeRows = new Set(), freezeCols = new Set();
    // 👻 「結果」の層はここ1か所で止める。4つの Set が空のまま返ると、
    //    読み手（drawBlocks のグロー / 白帯 / 水色帯、ドラッグ側と選択側で計9か所）が
    //    **全部いっしょに**黙る。表示側に個別の if を書くと、1つ書き忘れたときに
    //    「入力手段によって見え方が違う」といういちばん悪い形になる。
    //    valid（置けるかどうか）は位置の層なので、ここでは落とさない。
    if (valid && this.showClear()) {
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
    // 掴んだときのコマを描く（すり替わっていたら dragPiece が捨てる）。
    const piece = this.dragPiece();
    if (!piece) return;

    // Weld zone: highlight the target slot INSTEAD of a board ghost, so the
    // preview always matches what releasing will do.
    const wslot = this.weldTargetAt(this.drag.px, this.drag.py, this.drag.index);
    // 👻 「なし」ではゴーストを出さない。指の上に浮くコマ（下の 1589〜）は
    //    手札の中身であって予告ではないので、どの段でも必ず描く。
    const ghost = (wslot === -1 && this.showGhost()) ? this.ghostInfo() : null;
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
      // 印も枠と同じ場所へ。y を trayY(=0) のままにしていると、
      // 横持ちでは盤面の上に印が浮いていた。
      // 絵文字の 🧬 をやめて二重らせんを直接描く（端末によっては
      // モノクロの四角い箱になり、何の印か分からなかった。
      this.drawWeldMark(sx + (slotW - 8) / 2, sy + 14, 7);
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

  // ♿ 選択カーソルの表示。ドラッグのゴーストと同じ見せ方（置ける＝半透明の
  // ピース／置けない＝赤、揃う線は白、氷で止まる線は水色）に、
  // 「いまここを狙っている」枠を足しただけ。指の位置が無いので枠が必要。
  drawSelection() {
    const { ctx, cell } = this;
    const s = this.sel;
    const ghost = this.selGhost();
    if (!ghost) { this.sel = null; return; }
    const { piece, valid } = ghost;
    const skin = getSkin(this.skinId);
    // 👻 「なし」でもマスそのものは描く。**消しても何も隠せないから。**
    //    下の枠は shapeSize の外接長方形なので、L字やS字ではどのマスを占めるか
    //    分からない。ところが手札側は選択中のコマを普通に描いていて（drawTray が
    //    伏せるのはドラッグ中の枠だけ）、黄色の枠でどれを選んでいるかも出ている。
    //    **外接長方形＋手札の形＝占有マスは一意に決まる**ので、ここを消しても
    //    情報は1ビットも減らず、読みにくくなるだけ。隠すのは色分け（置ける／
    //    置けない）のほうだけにする。
    const tell = this.showGhost();
    for (const [dr, dc] of piece.cells) {
      const x = this.boardX + (s.c + dc) * cell;
      const y = this.boardY + (s.r + dr) * cell;
      if (!tell) {
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
        ctx.globalAlpha = 1;
      } else if (valid) {
        skin(ctx, x, y, cell, piece.color, 0.45);
      } else {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#ff4444';
        ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
        ctx.globalAlpha = 1;
      }
    }
    if (valid && (ghost.willRows.size || ghost.willCols.size)) {
      const pulse = 0.25 + 0.15 * Math.sin(this.time * 8);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ffffff';
      for (const r of ghost.willRows) ctx.fillRect(this.boardX, this.boardY + r * cell, this.boardSize, cell);
      for (const c of ghost.willCols) ctx.fillRect(this.boardX + c * cell, this.boardY, cell, this.boardSize);
      ctx.globalAlpha = 1;
    }
    if (valid && (ghost.freezeRows.size || ghost.freezeCols.size)) {
      const pulse = 0.18 + 0.12 * Math.sin(this.time * 8);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#9be3ff';
      for (const r of ghost.freezeRows) ctx.fillRect(this.boardX, this.boardY + r * cell, this.boardSize, cell);
      for (const c of ghost.freezeCols) ctx.fillRect(this.boardX + c * cell, this.boardY, cell, this.boardSize);
      ctx.globalAlpha = 1;
    }
    const { rows, cols } = shapeSize(piece.cells);
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(this.time * 6);
    // 枠そのものは**どの段でも必ず描く** ── タップ／キーボードには
    // 指の位置が無いので、これが唯一の手掛かり。色分けだけ段に従う。
    ctx.strokeStyle = (!this.showGhost() || valid) ? '#ffffff' : '#ff6b6b';
    ctx.lineWidth = Math.max(2, cell * 0.07);
    ctx.strokeRect(this.boardX + s.c * cell + 1, this.boardY + s.r * cell + 1, cols * cell - 2, rows * cell - 2);
    ctx.restore();
    ctx.globalAlpha = 1;
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
      // 👻 「このコマはどこにも入らない」も盤面を全部走査した結果。
      //    「なし」では出さない ── ついでに毎フレームの placements() 3回ぶんが消える
      //    （手札3枚 × 全アンカーの canPlace。この関数でいちばん重い行）。
      const placeable = this.showGhost() ? this.engine.placements(piece).length > 0 : true;
      const alpha = placeable ? 1 : 0.3;
      // subtle idle bobbing
      const bob = Math.sin(this.time * 2 + i * 1.7) * 2;
      const frozen = piece.frozenUntil > Date.now();
      for (const [dr, dc] of piece.cells) {
        skin(ctx, ox + dc * maxCell, oy + dr * maxCell + bob, maxCell, piece.color, frozen ? 0.45 : alpha);
      }
      if (piece.weld > 1) this.drawPieceTag(ox, oy + bob, pw, ph, `×${piece.weld}`, '#b06bff', alpha);
      // ♿ タップ選択／キーボードで選んでいる枠。掴んでいないので、
      // どれを持っているのかは枠でしか分からない。
      if (this.sel && this.sel.index === i && this.sel.piece === piece) {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(this.time * 6);
        ctx.strokeStyle = '#ffe14d';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(ox - 6, oy + bob - 6, pw + 12, ph + 12);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      if (frozen) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = '#9bd8ff';
        ctx.fillRect(ox - 3, oy + bob - 3, pw + 6, ph + 6);
        ctx.globalAlpha = 1;
        this.drawFrostMark(ox + pw / 2, oy + bob + ph / 2, Math.max(8, maxCell * 0.42));
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
    // 寸法が変わっていないなら代入しない。canvas.width への代入は、同じ値でも
    // ビットマップを作り直して中身を消す（＝正しさの問題でもある: 代入と描画の
    // 間で例外が出れば空の板が残る）。MiniBoard は setGrid のたび、つまり
    // AIの手番ごとに描かれるので、120x120@2dpr なら毎回 57.6KB を確保し直して
    // いた。寸法が変わったときだけ作り直し、消去は下の clearRect に任せる。
    const bw = Math.round(rect.width * dpr), bh = Math.round(rect.height * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
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
