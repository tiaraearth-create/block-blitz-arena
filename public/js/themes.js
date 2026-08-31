// Visual definitions for block skins, board themes and clear effects.
import { getSettings } from './settings.js';

// Base palette: colorIndex 1..8
export const PALETTE = [
  null,
  ['#ff5d5d', '#c22f3d'], // red
  ['#ffa93d', '#d8721a'], // orange
  ['#ffe14d', '#dfa11f'], // yellow
  ['#5ee86e', '#27a83c'], // green
  ['#43d9e8', '#1a8fb8'], // cyan
  ['#5b8bff', '#2f4fd0'], // blue
  ['#b06bff', '#7434d0'], // purple
  ['#ff6bd4', '#c72b96'], // pink
  ['#8d97ad', '#4a5265'], // 9: garbage (boss attacks)
];

export const BOARDS = {
  board_default: {
    bg: ['#141a33', '#0b0e1f'],
    cell: 'rgba(255,255,255,0.055)',
    cellLine: 'rgba(255,255,255,0.07)',
    accent: '#5b8bff',
    stars: true,
  },
  board_ocean: {
    bg: ['#04365c', '#021423'],
    cell: 'rgba(120,220,255,0.08)',
    cellLine: 'rgba(120,220,255,0.10)',
    accent: '#43d9e8',
    bubbles: true,
  },
  board_sunset: {
    bg: ['#5c2a4d', '#1f0f2e'],
    cell: 'rgba(255,180,120,0.09)',
    cellLine: 'rgba(255,180,120,0.10)',
    accent: '#ffa93d',
    stars: true,
  },
  board_forest: {
    bg: ['#12402a', '#06180f'],
    cell: 'rgba(150,255,180,0.07)',
    cellLine: 'rgba(150,255,180,0.09)',
    accent: '#5ee86e',
    fireflies: true,
  },
  board_galaxy: {
    bg: ['#2b1655', '#08041a'],
    cell: 'rgba(200,150,255,0.09)',
    cellLine: 'rgba(200,150,255,0.11)',
    accent: '#b06bff',
    stars: true,
    nebula: true,
  },
  board_sakura: {
    bg: ['#5c3a52', '#241322'],
    cell: 'rgba(255,190,220,0.10)',
    cellLine: 'rgba(255,190,220,0.12)',
    accent: '#ff9ecb',
    petals: true,
  },
  board_volcano: {
    bg: ['#4a1e08', '#160702'],
    cell: 'rgba(255,150,90,0.10)',
    cellLine: 'rgba(255,150,90,0.12)',
    accent: '#ff8a5c',
    embers: true,
  },
  board_snow: {
    bg: ['#2e4460', '#0e1826'],
    cell: 'rgba(220,240,255,0.09)',
    cellLine: 'rgba(220,240,255,0.11)',
    accent: '#bfe3ff',
    snow: true,
  },
  board_cyber: {
    bg: ['#03251a', '#010a07'],
    cell: 'rgba(94,232,110,0.08)',
    cellLine: 'rgba(94,232,110,0.13)',
    accent: '#5ee86e',
    digital: true,
  },
  // ガチャ限定ステージ
  board_aurora: {
    bg: ['#0a2438', '#050914'],
    cell: 'rgba(140,255,220,0.08)',
    cellLine: 'rgba(140,255,220,0.11)',
    accent: '#7cf5c8',
    aurora: true,
    stars: true,
  },
  // Admin-exclusive stage
  board_admin: {
    bg: ['#3c2a58', '#120a20'],
    cell: 'rgba(255,215,94,0.10)',
    cellLine: 'rgba(255,215,94,0.16)',
    accent: '#ffd75e',
    holy: true,
    stars: true,
  },
  // Special stage themes (not purchasable — used by difficulties / bosses)
  board_oni: {
    bg: ['#4a0d12', '#120306'],
    cell: 'rgba(255,110,110,0.10)',
    cellLine: 'rgba(255,110,110,0.13)',
    accent: '#ff5d5d',
    embers: true,
  },
  board_kami: {
    bg: ['#5a4a15', '#171004'],
    cell: 'rgba(255,230,150,0.10)',
    cellLine: 'rgba(255,230,150,0.14)',
    accent: '#ffd75e',
    holy: true,
  },
  // 👑 王座の宝物庫。第2段を割った世界でだけ棚に並ぶ。
  board_throne: {
    bg: ['#3a2c08', '#120c02'],
    cell: 'rgba(240,180,41,0.075)',
    cellLine: 'rgba(240,180,41,0.11)',
    accent: '#f0b429',
    stars: true,
  },
  // 断罪録の間。紫の封印色で、記録がずっと流れている壁。
  board_chronicle: {
    bg: ['#241a4a', '#0a0714'],
    cell: 'rgba(139,108,255,0.08)',
    cellLine: 'rgba(139,108,255,0.12)',
    accent: '#8b6cff',
    nebula: true,
  },
  // --- v2.30 追加ステージ -----------------------------------------------------
  // 装飾フラグ（stars / bubbles / fireflies / nebula / petals / embers / snow /
  // digital / aurora / holy）は既存の描画をそのまま使う。新しい絵を足すのでは
  // なく、配色と装飾の組み合わせで「別の場所」を作る ── 描画を増やすと低スペック
  // 端末の負荷が増えるが、配色だけなら追加コストがゼロで済む。
  board_deepsea: {
    bg: ['#021d33', '#000a14'],
    cell: 'rgba(90,190,255,0.07)',
    cellLine: 'rgba(90,190,255,0.10)',
    accent: '#3aa0e8',
    bubbles: true,
  },
  board_desert: {
    bg: ['#5a3d18', '#1c1206'],
    cell: 'rgba(255,214,150,0.09)',
    cellLine: 'rgba(255,214,150,0.12)',
    accent: '#e8b25c',
    embers: true,
  },
  board_mint: {
    bg: ['#123f3a', '#061715'],
    cell: 'rgba(160,255,235,0.08)',
    cellLine: 'rgba(160,255,235,0.11)',
    accent: '#5fe8cf',
    fireflies: true,
  },
  board_midnight: {
    bg: ['#161a2e', '#05060d'],
    cell: 'rgba(190,200,255,0.06)',
    cellLine: 'rgba(190,200,255,0.09)',
    accent: '#8f9dff',
    stars: true,
    snow: true,
  },
  board_ruby: {
    bg: ['#4a0f2c', '#170410'],
    cell: 'rgba(255,140,190,0.09)',
    cellLine: 'rgba(255,140,190,0.12)',
    accent: '#ff5d8f',
    petals: true,
  },
  board_matrix: {
    bg: ['#04140a', '#010603'],
    cell: 'rgba(80,255,140,0.07)',
    cellLine: 'rgba(80,255,140,0.14)',
    accent: '#3cff8a',
    digital: true,
    stars: true,
  },
  board_sunrise: {
    bg: ['#5c3410', '#1f1206'],
    cell: 'rgba(255,200,140,0.10)',
    cellLine: 'rgba(255,200,140,0.13)',
    accent: '#ffb35c',
    holy: true,
  },
  board_nebula: {
    bg: ['#1d0e42', '#070316'],
    cell: 'rgba(180,140,255,0.08)',
    cellLine: 'rgba(180,140,255,0.12)',
    accent: '#a06bff',
    nebula: true,
    aurora: true,
  },
};

// ---------------------------------------------------------------------------
// Block skins: each is a draw(ctx, x, y, s, colorIndex, alpha) function.
// ---------------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawClassic(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.04, r = s * 0.18;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // top gloss
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  roundRect(ctx, x + pad + s * 0.08, y + pad + s * 0.06, s - pad * 2 - s * 0.16, s * 0.22, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawNeon(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.10, r = s * 0.2;
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.shadowColor = light;
  ctx.shadowBlur = s * 0.45;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.strokeStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawCandy(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.32;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(x + s * 0.35, y + s * 0.3, s * 0.1, x + s * 0.5, y + s * 0.55, s * 0.75);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(x + s * 0.34, y + s * 0.28, s * 0.14, s * 0.09, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPixel(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = Math.max(1, s * 0.06);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = dark;
  ctx.fillRect(x + pad, y + pad, s - pad * 2, s - pad * 2);
  ctx.fillStyle = light;
  const b = Math.max(2, s * 0.12);
  ctx.fillRect(x + pad, y + pad, s - pad * 2, b);                    // top light bevel
  ctx.fillRect(x + pad, y + pad, b, s - pad * 2);                    // left
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + pad, y + s - pad - b, s - pad * 2, b);            // bottom shade
  ctx.fillRect(x + s - pad - b, y + pad, b, s - pad * 2);            // right
  ctx.globalAlpha = 1;
}

function drawCrystal(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.07, r = s * 0.14;
  ctx.globalAlpha = alpha * 0.9;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, light); g.addColorStop(0.5, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // facets
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + pad, y + s * 0.5); ctx.lineTo(x + s * 0.5, y + pad);
  ctx.moveTo(x + s * 0.5, y + s - pad); ctx.lineTo(x + s - pad, y + s * 0.5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(x + s * 0.28, y + pad + 1);
  ctx.lineTo(x + s * 0.52, y + pad + 1);
  ctx.lineTo(x + pad + 1, y + s * 0.52);
  ctx.lineTo(x + pad + 1, y + s * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawGold(ctx, x, y, s, ci, alpha = 1) {
  const pad = s * 0.05, r = s * 0.18;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, '#fff3b0');
  g.addColorStop(0.35, '#ffd75e');
  g.addColorStop(0.6, '#c8871a');
  g.addColorStop(1, '#ffdf7e');
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // tint by color so pieces remain distinguishable
  const [light] = PALETTE[ci];
  ctx.globalAlpha = alpha * 0.30;
  ctx.fillStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(120,70,0,0.55)';
  ctx.lineWidth = Math.max(1, s * 0.035);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawShadow(ctx, x, y, s, ci, alpha = 1) {
  const [light] = PALETTE[ci];
  const pad = s * 0.08, r = s * 0.2;
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.fillStyle = '#0c0e18';
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.shadowColor = light;
  ctx.shadowBlur = s * 0.3;
  ctx.lineWidth = Math.max(1.5, s * 0.055);
  ctx.strokeStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  // inner spark
  ctx.shadowBlur = 0;
  ctx.fillStyle = light;
  ctx.globalAlpha = alpha * 0.6;
  ctx.beginPath();
  ctx.arc(x + s * 0.5, y + s * 0.5, s * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawPastel(ctx, x, y, s, ci, alpha = 1) {
  const [light] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.3;
  ctx.globalAlpha = alpha;
  // soften the base color toward white
  ctx.fillStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = light;
  ctx.globalAlpha = alpha * 0.85;
  roundRect(ctx, x + pad + s * 0.1, y + pad + s * 0.1, s - pad * 2 - s * 0.2, s - pad * 2 - s * 0.2, r * 0.7);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawMagma(ctx, x, y, s, ci, alpha = 1) {
  const [light] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.16;
  ctx.globalAlpha = alpha;
  // dark volcanic rock base
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, '#3a2724'); g.addColorStop(1, '#17100e');
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // glowing cracks, tinted by the piece color so pieces stay readable
  ctx.save();
  ctx.shadowColor = light;
  ctx.shadowBlur = s * 0.25;
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.2, s * 0.05);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, y + s * 0.75);
  ctx.lineTo(x + s * 0.42, y + s * 0.5);
  ctx.lineTo(x + s * 0.35, y + s * 0.28);
  ctx.moveTo(x + s * 0.42, y + s * 0.5);
  ctx.lineTo(x + s * 0.72, y + s * 0.62);
  ctx.moveTo(x + s * 0.6, y + s * 0.22);
  ctx.lineTo(x + s * 0.72, y + s * 0.62);
  ctx.lineTo(x + s * 0.82, y + s * 0.8);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawDot(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.26;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // polka dots
  ctx.fillStyle = light;
  const dr = s * 0.09;
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.55], [0.3, 0.78], [0.7, 0.78]]) {
    ctx.beginPath();
    ctx.arc(x + s * fx, y + s * fy, dr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  roundRect(ctx, x + pad + s * 0.07, y + pad + s * 0.05, s - pad * 2 - s * 0.14, s * 0.16, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ガチャ限定: 光を分解するプリズム — 面ごとに色相のずれた輝面を持つ宝石カット
function drawPrism(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.14;
  const hue = Math.round(((x * 0.9 + y * 1.3) / 2.6) % 360);
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, dark);
  g.addColorStop(1, '#1a1030');
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // three refracted facets, hue-shifted like split light
  const facets = [
    [[0.5, 0.12], [0.88, 0.5], [0.5, 0.5]],
    [[0.5, 0.5], [0.88, 0.5], [0.5, 0.88]],
    [[0.12, 0.5], [0.5, 0.12], [0.5, 0.88]],
  ];
  facets.forEach((f, i) => {
    ctx.fillStyle = `hsla(${(hue + i * 55) % 360}, 90%, 62%, 0.55)`;
    ctx.beginPath();
    ctx.moveTo(x + s * f[0][0], y + s * f[0][1]);
    ctx.lineTo(x + s * f[1][0], y + s * f[1][1]);
    ctx.lineTo(x + s * f[2][0], y + s * f[2][1]);
    ctx.closePath();
    ctx.fill();
  });
  // piece-color rim keeps shapes readable
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.4, s * 0.055);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  roundRect(ctx, x + pad + s * 0.08, y + pad + s * 0.05, s - pad * 2 - s * 0.16, s * 0.14, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawAdminRainbow(ctx, x, y, s, ci, alpha = 1) {
  const pad = s * 0.05, r = s * 0.2;
  ctx.globalAlpha = alpha;
  // position-shifted rainbow so the board shimmers across cells
  const hue = Math.round(((x + y) / 2.2) % 360);
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, `hsl(${hue}, 92%, 62%)`);
  g.addColorStop(0.5, `hsl(${(hue + 70) % 360}, 92%, 58%)`);
  g.addColorStop(1, `hsl(${(hue + 140) % 360}, 92%, 60%)`);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // piece-color ring keeps shapes readable
  const [light] = PALETTE[ci];
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.5, s * 0.06);
  roundRect(ctx, x + pad + s * 0.03, y + pad + s * 0.03, s - pad * 2 - s * 0.06, s - pad * 2 - s * 0.06, r * 0.8);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  roundRect(ctx, x + pad + s * 0.08, y + pad + s * 0.06, s - pad * 2 - s * 0.16, s * 0.2, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// 👑 断罪の刻印: 赤い判決線が斜めに1本、どのブロックにも入っている。
// スキンの呼び出し規約は (ctx, x, y, s, colorIndex, alpha)。ここだけ6番目を
// 角丸半径として受け取っていたため、ゴースト(0.35)・ライン消しのフェード・
// 置けない手札の減光(0.3)がすべて無効化され、ついでに角丸半径が
// alpha の値(1px未満)になって直角の四角に見えていた。他スキンに揃える。
function drawVerdict(ctx, x, y, s, colorIndex, alpha = 1) {
  const [light, dark] = PALETTE[colorIndex] || PALETTE[6];
  const r = s * 0.18;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, dark); g.addColorStop(1, '#14060a');
  ctx.fillStyle = g;
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.fill();
  ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, s * 0.05);
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.stroke();
  ctx.save();
  ctx.beginPath(); roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r); ctx.clip();
  ctx.strokeStyle = '#e03546'; ctx.lineWidth = Math.max(1.4, s * 0.09);
  ctx.globalAlpha = alpha * 0.9;   // 判決線だけ少し薄い。alpha を掛けないと半透明時に線だけ濃く残る
  ctx.beginPath(); ctx.moveTo(x + s * 0.12, y + s * 0.82); ctx.lineTo(x + s * 0.88, y + s * 0.18); ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 👁️ ゼロの眼: 見返してくる。虹彩の色だけピースの色に染まる。
// drawVerdict と同じく6番目が alpha（角丸半径ではない）。
function drawZeroEye(ctx, x, y, s, colorIndex, alpha = 1) {
  const [light, dark] = PALETTE[colorIndex] || PALETTE[6];
  const r = s * 0.18;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#120d16';
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.fill();
  ctx.strokeStyle = dark; ctx.lineWidth = Math.max(1, s * 0.05);
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.stroke();
  const cx = x + s / 2, cy = y + s / 2;
  ctx.fillStyle = '#efeaf5';
  ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.34, s * 0.21, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = light;
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.155, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0a0610';
  ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.055, s * 0.135, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

// --- v2.30 追加スキン ---------------------------------------------------------
// 既存と同じ約束: (ctx, x, y, s, ci, alpha) を受け、PALETTE[ci] の [light, dark]
// だけで色を作る。パレットを直に書かないのは、色覚サポート（colorMarks）や
// テーマ切り替えが PALETTE 側で効くようにするため。

// 🧊 氷塊。角が透けて、内側に霜のひび。
function drawIce(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.14;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, light); g.addColorStop(0.55, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = Math.max(1, s * 0.035);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.28, y + s * 0.18);
  ctx.lineTo(x + s * 0.52, y + s * 0.54);
  ctx.lineTo(x + s * 0.38, y + s * 0.82);
  ctx.moveTo(x + s * 0.62, y + s * 0.3);
  ctx.lineTo(x + s * 0.52, y + s * 0.54);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// 🪵 木彫り。年輪が浅く入った、あたたかい面。
function drawWood(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.12;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.save();
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.clip();
  ctx.strokeStyle = light;
  ctx.globalAlpha = alpha * 0.35;
  ctx.lineWidth = Math.max(1, s * 0.05);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x + s * 0.18, y + s * 0.85, s * (0.28 + i * 0.24), -0.9, 0.35);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = alpha * 0.9;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// 🫧 ゼリー。ぷるんとした厚みと、下に落ちるハイライト。
function drawJelly(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.07, r = s * 0.3;
  ctx.globalAlpha = alpha * 0.92;
  const g = ctx.createLinearGradient(x, y + s, x, y);
  g.addColorStop(0, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillStyle = light;
  roundRect(ctx, x + pad * 1.8, y + s * 0.52, s - pad * 3.6, s * 0.3, r * 0.7);
  ctx.fill();
  ctx.globalAlpha = alpha * 0.75;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.ellipse(x + s * 0.36, y + s * 0.3, s * 0.16, s * 0.1, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ⚙️ 鋼鉄。斜めのヘアラインと、四隅のリベット。
function drawSteel(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.1;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, light); g.addColorStop(0.5, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.save();
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.clip();
  ctx.globalAlpha = alpha * 0.18;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, s * 0.025);
  for (let i = -1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(x + s * (i * 0.3), y);
    ctx.lineTo(x + s * (i * 0.3 + 0.5), y + s);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = alpha * 0.7;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const rv = s * 0.055;
  for (const [dx, dy] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
    ctx.beginPath();
    ctx.arc(x + s * dx, y + s * dy, rv, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// 🌌 星屑。夜空を閉じ込めた、粒の浮かぶ面。粒の位置は色ごとに固定（毎フレーム
// 抽選すると盤面がチカチカして酔う）。
const STARDUST_PTS = [[0.28, 0.3], [0.62, 0.22], [0.44, 0.55], [0.74, 0.62], [0.3, 0.74]];
function drawStardust(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.2;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(x + s * 0.5, y + s * 0.5, s * 0.05, x + s * 0.5, y + s * 0.5, s * 0.7);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < STARDUST_PTS.length; i++) {
    const [px, py] = STARDUST_PTS[(i + ci) % STARDUST_PTS.length];
    ctx.globalAlpha = alpha * (i % 2 ? 0.55 : 0.85);
    ctx.beginPath();
    ctx.arc(x + s * px, y + s * py, s * (i % 2 ? 0.028 : 0.042), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export const SKINS = {
  skin_default: drawClassic,
  skin_neon: drawNeon,
  skin_candy: drawCandy,
  skin_pixel: drawPixel,
  skin_crystal: drawCrystal,
  skin_gold: drawGold,
  skin_shadow: drawShadow,
  skin_pastel: drawPastel,
  skin_magma: drawMagma,
  skin_dot: drawDot,
  skin_prism: drawPrism,
  skin_admin: drawAdminRainbow,
  skin_verdict: drawVerdict,
  skin_zero: drawZeroEye,
  skin_ice: drawIce,
  skin_wood: drawWood,
  skin_jelly: drawJelly,
  skin_steel: drawSteel,
  skin_stardust: drawStardust,
};

// fx ids map to particle presets handled in particles.js
export const FX_IDS = ['fx_default', 'fx_fireworks', 'fx_thunder', 'fx_sakura'];

// ---------------------------------------------------------------------------
// 色覚サポート: 色 index ごとの記号をブロック中央に薄く重ねる。
// 設定 colorMarks が ON のときだけ、getSkin() が返す描画関数をラップして
// 適用する。こうすると盤面・ゴースト・手札・ミニ盤面・ショップのプレビューまで
// getSkin() 経由の描画すべてに自動で波及し、呼び出し側は一切触らずに済む。
// ---------------------------------------------------------------------------

// PALETTE と同じ添字（0 は未使用 / 9 は妨害ブロック）。
const COLOR_MARKS = [null, '▲', '●', '■', '◆', '✚', '★', '▼', '◐', '✕'];

// フォント文字列の組み立ては毎セル走るのでサイズ単位でキャッシュする。
let _markPx = -1, _markFont = '';
function markFont(s) {
  const px = Math.max(6, Math.round(s * 0.46));
  if (px !== _markPx) { _markPx = px; _markFont = `${px}px "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif`; }
  return _markFont;
}

// 記号はテキスト描画1回だけ（影・縁取りなし）でコストを抑える。
function drawColorMark(ctx, x, y, s, ci, alpha) {
  const mark = COLOR_MARKS[ci];
  if (!mark || !(s > 0)) return;
  const a = Math.max(0, Math.min(1, Number(alpha) >= 0 ? Number(alpha) : 1));
  if (a <= 0.02) return;
  ctx.save();
  ctx.shadowBlur = 0;                       // ライン消し前のグロー描画に巻き込まれないように
  ctx.globalAlpha = a * 0.5;                // 「薄く重ねる」: 元の絵柄を潰さない濃さ
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = markFont(s);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(mark, x + s / 2, y + s / 2);
  ctx.restore();
}

// 元の描画関数ごとにラッパを1つだけ作って使い回す（毎フレーム生成しない）。
const _markedSkins = new Map();
function withColorMarks(draw) {
  let wrapped = _markedSkins.get(draw);
  if (!wrapped) {
    wrapped = function (ctx, x, y, s, ci, alpha = 1) {
      draw(ctx, x, y, s, ci, alpha);
      drawColorMark(ctx, x, y, s, ci, alpha);
    };
    _markedSkins.set(draw, wrapped);
  }
  return wrapped;
}

export function getSkin(id) {
  const draw = SKINS[id] || SKINS.skin_default;
  let on = false;
  try { on = getSettings().colorMarks === true; } catch { /* 設定が読めなければ素のスキン */ }
  return on ? withColorMarks(draw) : draw;
}
export function getBoard(id) { return BOARDS[id] || BOARDS.board_default; }
