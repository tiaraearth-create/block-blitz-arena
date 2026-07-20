// Synthesized SFX + BGM via WebAudio — no audio assets needed.

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.musicOn = true;
    this.sfxOn = true;
    this.musicTimer = null;
    this.step = 0;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.9;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.22;
      this.musicGain.connect(this.master);
      return true;
    } catch { return false; }
  }

  setSfx(on) { this.sfxOn = on; }
  setMusic(on) {
    this.musicOn = on;
    if (on) this.startMusic(); else this.stopMusic();
  }

  tone({ freq = 440, dur = 0.15, type = 'sine', vol = 0.3, attack = 0.005, sweep = 0, delay = 0 }) {
    if (!this.sfxOn || !this.ensure()) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + sweep), t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  noise({ dur = 0.2, vol = 0.25, freq = 1200, delay = 0 }) {
    if (!this.sfxOn || !this.ensure()) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter); filter.connect(gain); gain.connect(this.sfxGain);
    src.start(t0);
  }

  // ---- game SFX ----
  pickup()  { this.tone({ freq: 500, dur: 0.06, type: 'triangle', vol: 0.15 }); }
  putback() { this.tone({ freq: 300, dur: 0.08, type: 'triangle', vol: 0.12, sweep: -100 }); }
  place()   {
    this.tone({ freq: 220, dur: 0.08, type: 'square', vol: 0.10 });
    this.noise({ dur: 0.06, vol: 0.12, freq: 500 });
  }
  invalid() { this.tone({ freq: 160, dur: 0.12, type: 'sawtooth', vol: 0.10, sweep: -60 }); }

  clearLines(count, streak) {
    const base = [523, 659, 784, 1047]; // C5 E5 G5 C6
    for (let i = 0; i < Math.min(count + 1, 4); i++) {
      this.tone({ freq: base[i] * (1 + 0.06 * Math.min(streak, 6)), dur: 0.22, type: 'triangle', vol: 0.22, delay: i * 0.05 });
    }
    this.noise({ dur: 0.25, vol: 0.18, freq: 2000 });
    if (count >= 2) this.tone({ freq: 1568, dur: 0.4, type: 'sine', vol: 0.15, delay: 0.15 });
  }

  combo(streak) {
    const f = 440 * Math.pow(1.12, Math.min(streak, 10));
    this.tone({ freq: f, dur: 0.15, type: 'sine', vol: 0.2 });
    this.tone({ freq: f * 1.5, dur: 0.2, type: 'sine', vol: 0.12, delay: 0.06 });
  }

  gameOver() {
    const seq = [392, 330, 262, 196];
    seq.forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'triangle', vol: 0.2, delay: i * 0.18 }));
  }

  victory() {
    const seq = [523, 659, 784, 1047, 1319];
    seq.forEach((f, i) => this.tone({ freq: f, dur: 0.25, type: 'triangle', vol: 0.22, delay: i * 0.12 }));
    this.noise({ dur: 0.5, vol: 0.1, freq: 3000, delay: 0.5 });
  }

  countdown(final) {
    this.tone({ freq: final ? 880 : 440, dur: final ? 0.4 : 0.12, type: 'square', vol: 0.15 });
  }

  coin() {
    this.tone({ freq: 988, dur: 0.08, type: 'square', vol: 0.12 });
    this.tone({ freq: 1319, dur: 0.18, type: 'square', vol: 0.12, delay: 0.08 });
  }

  click() { this.tone({ freq: 600, dur: 0.04, type: 'sine', vol: 0.1 }); }
  error() { this.tone({ freq: 180, dur: 0.2, type: 'sawtooth', vol: 0.12, sweep: -80 }); }
  levelUp() {
    [523, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'sine', vol: 0.2, delay: i * 0.1 }));
  }

  // ---- BGM: generative loop ----
  startMusic() {
    if (!this.musicOn || !this.ensure() || this.musicTimer) return;
    const bpm = 96;
    const stepDur = 60 / bpm / 2; // 8th notes
    // A minor pentatonic-ish progression, chill puzzle vibe
    const bassLine = [110, 110, 87.3, 87.3, 98, 98, 73.4, 82.4];
    const chords = [
      [220, 261.6, 329.6], [220, 261.6, 329.6],
      [174.6, 220, 261.6], [174.6, 220, 261.6],
      [196, 246.9, 293.7], [196, 246.9, 293.7],
      [146.8, 174.6, 220], [164.8, 196, 246.9],
    ];
    const melodyPool = [440, 523.3, 587.3, 659.3, 784, 880];
    this.step = 0;
    const tick = () => {
      if (!this.musicOn || !this.ctx) return;
      const t = this.ctx.currentTime + 0.05;
      const bar = Math.floor(this.step / 8) % 8;
      const beat = this.step % 8;
      // bass on beats 0/4
      if (beat % 4 === 0) this.musicTone(bassLine[bar], t, stepDur * 3.5, 'triangle', 0.5);
      // chord pad on beat 0
      if (beat === 0) for (const f of chords[bar]) this.musicTone(f, t, stepDur * 7, 'sine', 0.16);
      // sparse melody
      if (Math.random() < 0.35 && beat % 2 === 1) {
        const f = melodyPool[(Math.random() * melodyPool.length) | 0];
        this.musicTone(f, t, stepDur * 1.8, 'triangle', 0.22);
      }
      // hat
      if (beat % 2 === 0) this.musicNoiseTick(t);
      this.step++;
    };
    this.musicTimer = setInterval(tick, stepDur * 1000);
  }

  musicTone(freq, t, dur, type, vol) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain); gain.connect(this.musicGain);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  musicNoiseTick(t) {
    const len = Math.floor(this.ctx.sampleRate * 0.03);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) * 0.3;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6000;
    const g = this.ctx.createGain();
    g.gain.value = 0.15;
    src.connect(filter); filter.connect(g); g.connect(this.musicGain);
    src.start(t);
  }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }
}

export const audio = new AudioEngine();
