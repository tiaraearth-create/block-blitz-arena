// Particle system with per-effect presets (spark / fireworks / thunder / sakura).
import { PALETTE } from './themes.js';

// 演出の総数の頭打ち。掃除は update() の中にしかなく、update() は
// requestAnimationFrame からしか呼ばれない ── オートパイロットのように
// setTimeout で回る経路がタブの裏で撒き続けると、誰も片付けないまま
// 際限なく伸びる（実測で100秒に12万個）。上限を超えたぶんは古いものから
// 捨てる。1手で出る最大（64マス × 花火14粒 × 濃さ1.9 ≒ 1700）より
// 十分に大きいので、まともな遊び方では1粒も間引かれない。
const MAX_PARTICLES = 4000;
const MAX_RINGS = 200;
const MAX_BOLTS = 120;

export class ParticleSystem {
  constructor() {
    this.particles = [];
    this.bolts = [];      // lightning bolts (fx_thunder)
    this.rings = [];      // expanding shockwave rings
    this.intensity = 1;   // particle amount multiplier (settings)
  }

  // Expanding shockwave ring (line clears, big events).
  ring(x, y, maxR, color = '#ffffff') {
    this.rings.push({ x, y, r: maxR * 0.15, maxR, life: 1, color });
    this.trim();
  }

  // 上限を超えたぶんを古いものから捨てる（撒く側から必ず通る）。
  trim() {
    const over = this.particles.length - MAX_PARTICLES;
    if (over > 0) this.particles.splice(0, over);
    const ro = this.rings.length - MAX_RINGS;
    if (ro > 0) this.rings.splice(0, ro);
    const bo = this.bolts.length - MAX_BOLTS;
    if (bo > 0) this.bolts.splice(0, bo);
  }

  n(base) { return Math.max(1, Math.round(base * this.intensity)); }

  clear() { this.particles.length = 0; this.bolts.length = 0; this.rings.length = 0; }

  // Emit a burst for one cleared cell.
  burstCell(x, y, size, colorIndex, fxId) {
    const [light, dark] = PALETTE[colorIndex] || PALETTE[6];
    switch (fxId) {
      case 'fx_fireworks': this.fireworks(x, y, size, light); break;
      case 'fx_thunder': this.thunder(x, y, size, light); break;
      case 'fx_sakura': this.sakura(x, y, size); break;
      case 'fx_bubble': this.bubbles(x, y, size); break;
      case 'fx_star': this.stars(x, y, size); break;
      case 'fx_flame': this.flames(x, y, size); break;
      case 'fx_comet': this.comet(x, y, size); break;
      case 'fx_seal': this.sealBreak(x, y, size); break;
      case 'fx_crown': this.crown(x, y, size); break;
      case 'fx_admin': this.rainbow(x, y, size); break;
      case 'fx_snow': this.snowfall(x, y, size); break;
      case 'fx_leaf': this.leaves(x, y, size); break;
      case 'fx_prism': this.prism(x, y, size); break;
      case 'fx_foam': this.foam(x, y, size); break;
      case 'fx_ink': this.ink(x, y, size); break;
      case 'fx_shatter': this.shatter(x, y, size); break;
      case 'fx_ripple': this.ripple(x, y, size); break;
      case 'fx_spark': this.sparkler(x, y, size); break;
      default: this.spark(x, y, size, light, dark);
    }
    this.trim();
  }

  // 👑 封印砕き: 紫の破片が外へ弾け、割れ目の白が一瞬だけ残る。
  sealBreak(x, y, size) {
    const hues = ['#8b6cff', '#5b46b8', '#c9b6ff', '#ffffff'];
    for (let i = 0; i < this.n(9); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.9 + Math.random() * 1.5) * size * 4;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 2.2, life: 1, decay: 1.3 + Math.random() * 0.7,
        size: size * (0.09 + Math.random() * 0.11),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'square', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 14,
      });
    }
  }

  // 👑 王冠還る: 金の粒が中心にいったん集まってから、上へ抜ける。
  crown(x, y, size) {
    const hues = ['#f0b429', '#ffe6a3', '#c98f10', '#fff8e1'];
    for (let i = 0; i < this.n(10); i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = size * (0.5 + Math.random() * 0.9);
      this.particles.push({
        x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad,
        vx: -Math.cos(a) * size * 2.2, vy: -Math.sin(a) * size * 2.2 - size * 3.4,
        g: -size * 0.8, life: 1, decay: 1.0 + Math.random() * 0.6,
        size: size * (0.07 + Math.random() * 0.08),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'glow', trail: true,
      });
    }
  }


  // ---- 🔄 交換所限定のエフェクト（v2.67）--------------------------------
  // 🖌 墨飛沫: 墨の粒がゆっくり広がって沈み、にじんで消える。
  //    ⚠ 色を明るい側へ寄せてある。BOARDS は23枚とも暗色（bg[1] は
  //      #010603〜#1f1206）で、'glow' は shadowColor が p.color と同じ
  //      ＝暗い粒には暗いにじみしか付かない。元案の '#0b0e1c' は
  //      board_default の bg[1] '#0b0e1f' と差3、'#151b33' は bg[0]
  //      '#141a33' と差1 ── どちらも盤と同色で1粒も見えなかった。
  //      淡墨〜中墨を主役にして、深墨は「陰」として少数だけ混ぜる。
  ink(x, y, size) {
    // 0〜2 が主役（どの盤より明るいので必ず出る）、3 は陰の深墨。
    const sumi = ['#7f8bb4', '#a2adcf', '#ccd4e9', '#39406b'];
    for (let i = 0; i < this.n(9); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.2 + Math.random() * 0.5) * size * 2;      // ほとんど飛ばない
      this.particles.push({
        x: x + Math.cos(a) * size * 0.2, y: y + Math.sin(a) * size * 0.2,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 1.8,                                        // ゆっくり沈む
        life: 1, decay: 0.8 + Math.random() * 0.5,            // 長めに残って滲む
        size: size * (0.10 + Math.random() * 0.16),
        // ⚠ 色を粒番号（i % 4）で決めない。設定「粒少なめ」は
        //    particleFactor()=0.35 → n(9)=3 で i が 0,1,2 しか回らず、
        //    4粒に1粒のはずの色が一度も出なくなる。数に依らない抽選にする。
        color: (Math.random() < 0.25) ? sumi[3] : sumi[(Math.random() * 3) | 0],
        kind: 'glow', rot: 0, vr: 0,
      });
    }
    this.trim();
  }
  // 🪟 硝子片: 割れた破片が四方へ弾け、大きく回りながら落ちる。
  //    ・スパーク（g=size*14・decay 1.8〜3.0）より落ちが遅く、長く残る
  //    ・プリズム（虹色・粒 0.08〜0.18・初速 最大 size*13.2）に対して、
  //      色は氷白〜青灰だけ、初速は最大 size*6（半分以下）、
  //      粒は 0.07〜0.22（大小の比 3.1倍。プリズムは 2.25倍）
  //    ・回転は vr ±9 rad/s（既存の最大は封印砕きの ±7）。寿命のあいだに
  //      およそ1回転して「重い破片が転がりながら落ちる」に見える
  //    ⚠ 粒の下限を 0.07 より小さくしないこと。棚のプレビューは 168px の
  //      canvas を CSS 84px に縮めて出すので（style.css の .shop-preview）、
  //      size=21 のとき 0.05 は 0.5 CSS px になり、棚では消えてしまう。
  shatter(x, y, size) {
    const glass = ['rgba(232,246,255,0.95)', 'rgba(255,255,255,0.90)', 'rgba(160,208,238,0.85)', 'rgba(110,166,205,0.80)'];
    for (let i = 0; i < this.n(10); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random() * 1.0) * size * 4;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size * 1.5,   // いったん浮いてから落ちる
        g: size * 4,
        life: 1, decay: 1.2 + Math.random() * 0.5,
        size: size * (0.07 + Math.random() * 0.15),                // 大小の比 3.1倍（棚でも消えない下限）
        color: glass[(Math.random() * glass.length) | 0],
        kind: 'square', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 18,
      });
    }
    this.trim();
  }
  // 〰 波紋: 上下にはほとんど動かず、左右へ静かに広がって消える輪。
  //    他の14種が全部「飛び散る」ので、これだけ重力をほぼ 0 にしてある。
  //    ⚠ kind:'bubble' は draw() が「輪＋左上の白いハイライト」しか描けない
  //      ＝ fx_bubble / fx_foam と**絵そのものは同じ**。見分けられるのは動きと
  //      色だけなので、色は水色の2品（160,220,255 / 210,240,255）から外した
  //      深い青緑＋白い波頭にし、粒も一回り大きくして「少数の大きな輪」に寄せた。
  ripple(x, y, size) {
    const water = ['rgba(88,206,214,0.80)', 'rgba(42,146,186,0.72)', 'rgba(226,252,255,0.85)'];
    // 左右へ同数ずつ。this.n(8) は設定で奇数になる（少なめ=3・多め=15）ので、
    // 半分を数えてから2倍する ── そのまま i%2 で振ると片側だけ1粒多くなり、
    // 粒が3個しかない「少なめ」では左2・右1 とはっきり偏って見える。
    const half = Math.max(1, Math.round(this.n(8) / 2));
    for (let i = 0; i < half * 2; i++) {
      const dir = (i % 2) ? 1 : -1;                     // 左右に同数ずつ
      const sp = (0.5 + Math.random() * 0.9) * size * 3;
      this.particles.push({
        x, y: y + (Math.random() - 0.5) * size * 0.5,
        vx: dir * sp, vy: (Math.random() - 0.5) * size * 0.25,
        g: size * 0.12,                                 // ほぼ無重力。わずかに沈むだけ
        life: 1, decay: 0.9 + Math.random() * 0.4,
        size: size * (0.15 + Math.random() * 0.17),
        color: water[(Math.random() * water.length) | 0],
        kind: 'bubble', rot: 0, vr: 0,
      });
    }
    this.trim();
  }
  // 🎇 線香花火: 中心の火球から、細かい火花が短く何度も弾ける。
  //    ⚠ メソッド名は sparkler。既存の spark(x, y, size, light, dark)（fx_default）と
  //      衝突するため。id は fx_spark、呼び出しは this.sparkler(...)。
  sparkler(x, y, size) {
    const hues = ['#ffd98a', '#ff9d3d', '#fff6d0', '#ff6a2a'];
    // 中心に残る火球（1粒だけ、火花より少し長生き）
    this.particles.push({
      x, y, vx: 0, vy: -size * 0.3, g: size * 0.8,
      life: 1, decay: 1.5, size: size * 0.08,
      color: '#ffb347', kind: 'glow', rot: 0, vr: 0,
    });
    for (let i = 0; i < this.n(14); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.9) * size * 3;     // 小さく短く
      const r = size * (0.1 + Math.random() * 0.35);         // 弾ける位置をずらして
      this.particles.push({                                  // 何段にも弾けて見せる
        x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 2,
        life: 1, decay: 2.2 + Math.random() * 1.4,           // すぐ消える＝密度で見せる
        size: size * (0.04 + Math.random() * 0.05),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'glow', trail: true, rot: 0, vr: 0,
      });
    }
    this.trim();
  }
  // ガチャ限定: 長い尾を引く彗星が斜めに走り抜ける
  comet(x, y, size) {
    const hues = ['#9be8ff', '#d0f4ff', '#7cc8ff', '#fff3c4'];
    for (let i = 0; i < this.n(7); i++) {
      const a = -Math.PI * (0.15 + Math.random() * 0.25);   // up-right streaks
      const sp = (1.2 + Math.random() * 1.6) * size * 5;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp * (Math.random() < 0.5 ? 1 : -1), vy: Math.sin(a) * sp,
        g: size * 1.5, life: 1, decay: 1.0 + Math.random() * 0.8,
        size: size * (0.06 + Math.random() * 0.09),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'glow', trail: true,
      });
    }
  }

  rainbow(x, y, size) {
    for (let i = 0; i < this.n(12); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.6 + Math.random() * 1.2) * size * 5;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size,
        g: size * 5, life: 1, decay: 1.1 + Math.random() * 0.9,
        size: size * (0.07 + Math.random() * 0.1),
        color: `hsl(${(Math.random() * 360) | 0}, 95%, 65%)`,
        kind: 'glow', trail: Math.random() < 0.4,
      });
    }
  }

  flames(x, y, size) {
    const hues = ['#ff8a5c', '#ff5d3d', '#ffb347', '#ffe14d'];
    for (let i = 0; i < this.n(9); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.2 + Math.random() * 0.5) * size * 3;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp * 0.6, vy: Math.sin(a) * sp - size * (3 + Math.random() * 3),
        g: -size * 3,   // fire rises
        // drift を持つ粒は update() で phase を加算される。初期値が無いと
        // undefined + dt → NaN → vx も x も NaN になり、arc() が非有限座標で
        // 何も描かずに返るため炎が1粒も見えなくなる（bubbles/sakura と同じ初期化）。
        drift: size * (0.5 + Math.random()), phase: Math.random() * Math.PI * 2,
        life: 1, decay: 1.4 + Math.random() * 1.0,
        size: size * (0.09 + Math.random() * 0.13),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'glow',
      });
    }
  }

  bubbles(x, y, size) {
    const hues = ['rgba(160,220,255,0.9)', 'rgba(200,240,255,0.9)', 'rgba(140,200,255,0.9)'];
    for (let i = 0; i < this.n(6); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.6) * size * 2.5;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size * 2.5,
        g: -size * 2, drift: size * (1 + Math.random()), life: 1, decay: 0.9 + Math.random() * 0.7,
        size: size * (0.08 + Math.random() * 0.14),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'bubble', phase: Math.random() * Math.PI * 2,
      });
    }
  }

  // --- v2.30 追加エフェクト ---------------------------------------------------
  // 新しい描画種別（kind）は増やさない。既存の bubble / glow / petal / sparkle /
  // square の組み合わせと初速・重力・寿命だけで別物を作る ── kind を足すと
  // draw() の分岐が増え、粒子1つあたりの判定が全エフェクトに乗るため。

  // ❄️ 雪あられ。ゆっくり落ちて、横に流れる。
  snowfall(x, y, size) {
    for (let i = 0; i < this.n(9); i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const sp = (0.3 + Math.random() * 0.6) * size * 3;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp + (Math.random() - 0.5) * size, vy: Math.sin(a) * sp,
        g: size * 2.2, life: 1, decay: 0.7 + Math.random() * 0.4,
        size: size * (0.07 + Math.random() * 0.09),
        color: Math.random() < 0.4 ? '#dff1ff' : '#ffffff',
        kind: 'sparkle', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 3,
      });
    }
    this.trim();
  }

  // 🍃 木の葉。ひらひらと舞って、ゆっくり落ちる。
  leaves(x, y, size) {
    for (let i = 0; i < this.n(7); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.4 + Math.random() * 0.8) * size * 3;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size,
        g: size * 3, life: 1, decay: 0.8 + Math.random() * 0.5,
        size: size * (0.12 + Math.random() * 0.1),
        color: ['#7ad46b', '#4fae52', '#c8d94f'][Math.floor(Math.random() * 3)],
        kind: 'petal', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 7,
      });
    }
    this.trim();
  }

  // 💠 プリズム。四角い光片が勢いよく散る。
  prism(x, y, size) {
    for (let i = 0; i < this.n(10); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 1.4) * size * 6;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 6, life: 1, decay: 1.6 + Math.random(),
        size: size * (0.08 + Math.random() * 0.1),
        color: ['#8ef0ff', '#ff9ee8', '#fff2a0', '#a8ffcf'][Math.floor(Math.random() * 4)],
        kind: 'square', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 10,
      });
    }
    this.trim();
  }

  // 🫧 泡沫。ふわりと上がって消える、静かな消去。
  foam(x, y, size) {
    for (let i = 0; i < this.n(8); i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
      const sp = (0.4 + Math.random() * 0.9) * size * 3.5;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: -size * 1.2, life: 1, decay: 1.0 + Math.random() * 0.6,
        size: size * (0.1 + Math.random() * 0.14),
        color: 'rgba(210,240,255,0.85)',
        kind: 'bubble', rot: 0, vr: 0,
      });
    }
    this.trim();
  }

  stars(x, y, size) {
    for (let i = 0; i < this.n(7); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random() * 1.2) * size * 4;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 4, life: 1, decay: 1.2 + Math.random() * 0.8,
        size: size * (0.09 + Math.random() * 0.12),
        color: Math.random() < 0.5 ? '#ffe9a8' : '#fff6d8',
        kind: 'sparkle', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 6,
      });
    }
    this.trim();   // modes.js が burstCell を通さず直接呼ぶ唯一の経路
  }

  spark(x, y, size, light, dark) {
    for (let i = 0; i < this.n(8); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random()) * size * 5;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size * 2,
        g: size * 14, life: 1, decay: 1.8 + Math.random() * 1.2,
        size: size * (0.08 + Math.random() * 0.12),
        color: Math.random() < 0.6 ? light : dark,
        kind: 'square', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 8,
      });
    }
  }

  fireworks(x, y, size, color) {
    const hues = [color, '#ffd75e', '#ffffff', '#ff6bd4'];
    for (let i = 0; i < this.n(14); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 1.4) * size * 6;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 6, life: 1, decay: 1.0 + Math.random() * 1.0,
        size: size * (0.05 + Math.random() * 0.09),
        color: hues[(Math.random() * hues.length) | 0],
        kind: 'glow', trail: true,
      });
    }
  }

  thunder(x, y, size, color) {
    // few bright sparks + a lightning bolt
    for (let i = 0; i < this.n(6); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random()) * size * 4;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: 0, life: 1, decay: 3 + Math.random() * 2,
        size: size * 0.07, color: '#eaf6ff', kind: 'glow',
      });
    }
    if (Math.random() < 0.5) {
      const pts = [];
      let px = x, py = y - size * (2 + Math.random() * 2);
      pts.push([px, py]);
      const steps = 5 + (Math.random() * 4 | 0);
      for (let i = 0; i < steps; i++) {
        px += (Math.random() - 0.5) * size * 1.4;
        py += size * (0.5 + Math.random() * 0.7);
        pts.push([px, py]);
      }
      pts.push([x, y]);
      this.bolts.push({ pts, life: 1, decay: 5, color, width: size * 0.08 });
    }
  }

  sakura(x, y, size) {
    const pinks = ['#ffc0dc', '#ff9ecb', '#ffd7e8', '#ff8ab8'];
    for (let i = 0; i < this.n(7); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.7) * size * 3;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size,
        g: size * 2.5, drift: size * (1.5 + Math.random() * 2),
        life: 1, decay: 0.7 + Math.random() * 0.5,
        size: size * (0.10 + Math.random() * 0.10),
        color: pinks[(Math.random() * pinks.length) | 0],
        kind: 'petal', rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 6,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  // Celebration burst (combo, victory).
  confetti(x, y, size, count = 40) {
    const colors = ['#ff5d5d', '#ffa93d', '#ffe14d', '#5ee86e', '#43d9e8', '#5b8bff', '#b06bff', '#ff6bd4'];
    for (let i = 0; i < this.n(count); i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const sp = (0.8 + Math.random() * 1.6) * size * 8;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: size * 12, life: 1, decay: 0.8 + Math.random() * 0.6,
        size: size * (0.07 + Math.random() * 0.10),
        color: colors[(Math.random() * colors.length) | 0],
        kind: 'square', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
      });
    }
    this.trim();
  }

  update(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= p.decay * dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.vy += (p.g || 0) * dt * 10;
      if (p.drift) {
        // phase の初期化漏れで NaN が伝播しないよう、ここでも既定値を入れる。
        // 一度 NaN になると座標が戻らず、その粒は寿命まで不可視のまま残る。
        p.phase = (p.phase || 0) + dt * 3;
        p.vx += Math.sin(p.phase) * p.drift * dt * 6;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.vr) p.rot += p.vr * dt;
    }
    const bs = this.bolts;
    for (let i = bs.length - 1; i >= 0; i--) {
      bs[i].life -= bs[i].decay * dt;
      if (bs[i].life <= 0) bs.splice(i, 1);
    }
    const rs = this.rings;
    for (let i = rs.length - 1; i >= 0; i--) {
      const r = rs[i];
      r.life -= 2.4 * dt;
      r.r += (r.maxR - r.r) * dt * 9;
      if (r.life <= 0) rs.splice(i, 1);
    }
    this.trim();
  }

  draw(ctx) {
    for (const p of this.particles) {
      const a = Math.max(0, Math.min(1, p.life));
      ctx.globalAlpha = a;
      switch (p.kind) {
        case 'glow': {
          ctx.save();
          ctx.shadowColor = p.color;
          ctx.shadowBlur = p.size * 4;
          ctx.fillStyle = p.color;
          // ☄ 尾。trail は comet / rainbow が立てているのに **draw が一度も
          //   読んでいなかった**ので、「尾を引く彗星」に尾が無かった。
          //   速度の逆向きに1本引くだけ（新しい kind は増やさない）。
          if (p.trail) {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = Math.max(1, p.size * 0.9);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'bubble': {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath();
          ctx.arc(p.x - p.size * 0.3, p.y - p.size * 0.3, p.size * 0.22, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'sparkle': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot || 0);
          ctx.shadowColor = p.color;
          ctx.shadowBlur = p.size * 2;
          ctx.fillStyle = p.color;
          // 4-point star
          const s4 = p.size;
          ctx.beginPath();
          ctx.moveTo(0, -s4 * 1.6);
          ctx.quadraticCurveTo(s4 * 0.22, -s4 * 0.22, s4 * 1.6, 0);
          ctx.quadraticCurveTo(s4 * 0.22, s4 * 0.22, 0, s4 * 1.6);
          ctx.quadraticCurveTo(-s4 * 0.22, s4 * 0.22, -s4 * 1.6, 0);
          ctx.quadraticCurveTo(-s4 * 0.22, -s4 * 0.22, 0, -s4 * 1.6);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'petal': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        default: { // square
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot || 0);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        }
      }
    }
    for (const r of this.rings) {
      ctx.globalAlpha = Math.max(0, r.life) * 0.7;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * Math.max(0.2, r.life);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const b of this.bolts) {
      ctx.globalAlpha = Math.max(0, b.life);
      ctx.save();
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = b.width;
      ctx.beginPath();
      ctx.moveTo(b.pts[0][0], b.pts[0][1]);
      for (let i = 1; i < b.pts.length; i++) ctx.lineTo(b.pts[i][0], b.pts[i][1]);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
