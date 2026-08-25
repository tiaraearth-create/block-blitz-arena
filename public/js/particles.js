// Particle system with per-effect presets (spark / fireworks / thunder / sakura).
import { PALETTE } from './themes.js';

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
  }

  n(base) { return Math.max(1, Math.round(base * this.intensity)); }

  clear() { this.particles.length = 0; this.bolts.length = 0; }

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
      case 'fx_admin': this.rainbow(x, y, size); break;
      default: this.spark(x, y, size, light, dark);
    }
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
        drift: size * (0.5 + Math.random()),
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
  }

  update(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= p.decay * dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.vy += (p.g || 0) * dt * 10;
      if (p.drift) {
        p.phase += dt * 3;
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
