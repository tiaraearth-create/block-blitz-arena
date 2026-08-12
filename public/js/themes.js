// Visual definitions for block skins, board themes and clear effects.

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
};

// fx ids map to particle presets handled in particles.js
export const FX_IDS = ['fx_default', 'fx_fireworks', 'fx_thunder', 'fx_sakura'];

export function getSkin(id) { return SKINS[id] || SKINS.skin_default; }
export function getBoard(id) { return BOARDS[id] || BOARDS.board_default; }
