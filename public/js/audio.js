// Synthesized SFX + generative BGM via WebAudio — no audio assets.
// The music engine is a 16th-note step sequencer with per-mode tracks,
// scheduled ahead on the AudioContext clock (immune to timer jitter).

// ---------------------------------------------------------------------------
// Track definitions
// ---------------------------------------------------------------------------
// Note helpers: frequencies for common notes
const N = {
  E1: 41.2, A1: 55, B1: 61.74, C2: 65.41, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98,
  A2: 110, Bb2: 116.54, B2: 123.47, C3: 130.81, Cs3: 138.59, D3: 146.83, E3: 164.81,
  F3: 174.61, Fs3: 185, G3: 196, A3: 220, B3: 246.94, C4: 261.63, Cs4: 277.18,
  D4: 293.66, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392, A4: 440, B4: 493.88,
  C5: 523.25, Cs5: 554.37, D5: 587.33, E5: 659.25, Fs5: 739.99, G5: 783.99, A5: 880,
  B5: 987.77, Cs6: 1108.73, E6: 1318.51,
};

// Each track: bpm, swing (0..0.3 on odd 16ths), bars (each bar = 16 steps):
//   chord: pad/arp notes, bass: root, riff: optional per-step bass melody
// drum patterns are step indexes within a bar.
const TRACKS = {
  menu: {
    bpm: 84, swing: 0, padType: 'sine', padVol: 0.16, arpType: 'triangle',
    kick: [], snare: [], hat: [0, 8], hatVol: 0.05,
    bassSteps: [0], bassLen: 3.6, bassType: 'sine', bassVol: 0.4,
    arpSteps: [0, 4, 8, 12], arpVol: 0.14, arpDelay: true,
    bars: [
      { chord: [N.A3, N.C4, N.E4, N.G4], bass: N.A2 },   // Am7
      { chord: [N.F3, N.A3, N.C4, N.E4], bass: N.F2 },   // Fmaj7
      { chord: [N.C4, N.E4, N.G4, N.B4], bass: N.C3 },   // Cmaj7
      { chord: [N.G3, N.B3, N.D4, N.E4], bass: N.G2 },   // G6
    ],
  },
  solo: {
    bpm: 100, swing: 0.22, padType: 'sine', padVol: 0.10, arpType: 'triangle',
    kick: [0, 10], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatVol: 0.08,
    bassSteps: [0, 8], bassLen: 1.6, bassType: 'triangle', bassVol: 0.5,
    arpSteps: [2, 6, 10, 14], arpVol: 0.16, arpDelay: true, melody: 0.3,
    bars: [
      { chord: [N.A3, N.C4, N.E4], bass: N.A2, scale: [N.A4, N.C5, N.D5, N.E5, N.G5] },
      { chord: [N.F3, N.A3, N.C4], bass: N.F2, scale: [N.A4, N.C5, N.D5, N.E5, N.G5] },
      { chord: [N.C4, N.E4, N.G4], bass: N.C3, scale: [N.G4, N.A4, N.C5, N.D5, N.E5] },
      { chord: [N.G3, N.B3, N.D4], bass: N.G2, scale: [N.G4, N.B4, N.D5, N.E5, N.G5] },
    ],
  },
  battle: {
    bpm: 128, swing: 0, padType: 'sawtooth', padVol: 0.05, arpType: 'square',
    kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15], hatVol: 0.07, openHat: [14],
    bassSteps: [2, 6, 10, 14], bassLen: 0.9, bassType: 'sawtooth', bassVol: 0.55, bassFilter: 700,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.10, arpDelay: true, stab: [0],
    bars: [
      { chord: [N.E4, N.G4, N.B4], bass: N.E2 },
      { chord: [N.C4, N.E4, N.G4], bass: N.C2 },
      { chord: [N.G3, N.B3, N.D4], bass: N.G2 },
      { chord: [N.D4, N.Fs4, N.A4], bass: N.D2 },
    ],
  },
  hard: {
    bpm: 138, swing: 0, padType: 'sawtooth', padVol: 0.05, arpType: 'square',
    kick: [0, 4, 7, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hatVol: 0.07, openHat: [6],
    bassSteps: [0, 2, 3, 6, 8, 10, 11, 14], bassLen: 0.7, bassType: 'sawtooth', bassVol: 0.5, bassFilter: 620,
    arpSteps: [0, 3, 6, 8, 11, 14], arpVol: 0.11, arpDelay: true, stab: [0, 8],
    bars: [
      { chord: [N.B3, N.D4, N.Fs4], bass: N.B1 },
      { chord: [N.G3, N.B3, N.D4], bass: N.G2 },
      { chord: [N.A3, N.Cs4, N.E4], bass: N.A1 },
      { chord: [N.Fs3, N.A3, N.Cs4], bass: N.Fs3 / 2 },
    ],
  },
  boss: {
    bpm: 118, swing: 0, padType: 'sawtooth', padVol: 0.05, arpType: 'sawtooth',
    kick: [0, 6, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatVol: 0.08,
    bassType: 'sawtooth', bassVol: 0.6, bassFilter: 420, detune: 10,
    riff: { 0: N.C2, 3: N.C2, 6: N.D2, 8: N.C2, 11: 77.78, 14: N.G2 / 2 },
    drone: N.C2 / 2, stab: [0], arpSteps: [], arpVol: 0,
    bars: [
      { chord: [N.C4, 311.13, N.G4], bass: N.C2 },
      { chord: [N.C4, N.F4, 415.3], bass: N.C2 },
    ],
  },
  oni: {
    bpm: 140, swing: 0, padType: 'sawtooth', padVol: 0.04, arpType: 'sawtooth',
    kick: [0, 3, 6, 8, 11, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatVol: 0.09,
    bassType: 'sawtooth', bassVol: 0.6, bassFilter: 500, detune: 8,
    riff: { 0: N.E2, 2: N.E2, 4: N.F2, 6: N.E2, 8: N.G2, 10: N.E2, 12: N.Bb2, 14: N.F2 },
    drone: N.E1, stab: [8], arpSteps: [], arpVol: 0,
    bars: [
      { chord: [N.E4, N.F4, N.B4], bass: N.E2 },
      { chord: [N.E4, N.G4, N.Bb2 * 4], bass: N.E2 },
    ],
  },
  // Dreamy pixel skies — an ORIGINAL floaty chiptune lullaby (square-wave
  // arps shimmering through delay over soft maj7 pads). Used by Battle
  // Royale and the Heavenly Ascent dungeon.
  pixel: {
    bpm: 108, swing: 0.1, padType: 'sine', padVol: 0.15, padVibrato: true, arpType: 'square',
    kick: [0, 8], snare: [12], hat: [2, 6, 10, 14], hatVol: 0.05,
    bassSteps: [0, 6, 8, 14], bassLen: 1.4, bassType: 'triangle', bassVol: 0.42,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.11, arpDelay: true, arpOctave: true, melody: 0.22,
    bars: [
      { chord: [N.C4, N.E4, N.G4, N.B4], bass: N.C3, scale: [N.E5, N.G5, N.A5, N.B5, N.D5] },   // Cmaj7
      { chord: [N.E4, N.G4, N.B4, N.D5], bass: N.E3, scale: [N.B4, N.D5, N.E5, N.G5, N.A5] },   // Em9
      { chord: [N.A3, N.C4, N.E4, N.G4], bass: N.A2, scale: [N.C5, N.D5, N.E5, N.G5, N.A5] },   // Am7
      { chord: [N.F3, N.A3, N.C4, N.E4], bass: N.F2, scale: [N.A4, N.C5, N.D5, N.E5, N.G5] },   // Fmaj7
    ],
  },
  kami: {
    bpm: 150, swing: 0, padType: 'sine', padVol: 0.14, padVibrato: true, arpType: 'triangle',
    kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hatVol: 0.06, openHat: [10],
    bassSteps: [0, 2, 4, 6, 8, 10, 12, 14], bassLen: 0.8, bassType: 'triangle', bassVol: 0.5,
    arpSteps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], arpVol: 0.12, arpDelay: true, arpOctave: true,
    bars: [
      { chord: [N.A4, N.Cs5, N.E5], bass: N.A2 },
      { chord: [N.Fs4, N.A4, N.Cs5], bass: N.Fs3 / 2 },
      { chord: [N.D4, N.Fs4, N.A4], bass: N.D2 },
      { chord: [N.E4, N.Gs4 || N.A4, N.B4], bass: N.E2 },
    ],
  },
};
// fix kami 4th chord (Gs4 not defined above)
TRACKS.kami.bars[3].chord = [N.E4, 415.3, N.B4];

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.delay = null;
    this.musicOn = true;
    this.sfxOn = true;
    this.sfxVol = 0.9;
    this.musicVol = 0.6;
    this.trackName = null;       // requested track ('menu', 'solo', ...)
    this.playing = null;         // currently scheduled track
    this.scheduler = null;
    this.step = 0;
    this.nextTime = 0;
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
      this.sfxGain.gain.value = this.sfxVol;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.45 * this.musicVol;
      this.musicGain.connect(this.master);
      // shared feedback delay for arps/leads
      this.delay = this.ctx.createDelay(1);
      this.delay.delayTime.value = 0.27;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.32;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.35;
      this.delay.connect(fb); fb.connect(this.delay);
      this.delay.connect(wet); wet.connect(this.musicGain);
      return true;
    } catch { return false; }
  }

  setSfx(on) { this.sfxOn = on; }

  setVolumes(sfxVol, musicVol) {
    this.sfxVol = sfxVol;
    this.musicVol = musicVol;
    if (this.ctx) {
      this.sfxGain.gain.value = sfxVol;
      this.musicGain.gain.value = 0.45 * musicVol;
    }
  }

  setMusicEnabled(on) {
    this.musicOn = on;
    if (!on) this.stopScheduler();
    else if (this.trackName) this.playTrack(this.trackName, true);
  }

  // -------------------------------------------------------------------------
  // Music engine
  // -------------------------------------------------------------------------

  playTrack(name, force = false) {
    this.trackName = name;
    if (!name) { this.stopScheduler(); return; }
    if (!this.musicOn || !this.ensure()) return;
    if (this.playing === name && !force) return;
    this.stopScheduler();
    this.playing = name;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.scheduler = setInterval(() => this.scheduleAhead(), 90);
    this.scheduleAhead();
  }

  stopMusic() { this.trackName = null; this.stopScheduler(); }

  stopScheduler() {
    if (this.scheduler) { clearInterval(this.scheduler); this.scheduler = null; }
    this.playing = null;
  }

  scheduleAhead() {
    const t = TRACKS[this.playing];
    if (!t || !this.ctx) return;
    const stepDur = 60 / t.bpm / 4;
    const total = t.bars.length * 16;
    while (this.nextTime < this.ctx.currentTime + 0.35) {
      const stepInBar = this.step % 16;
      const bar = t.bars[Math.floor(this.step / 16) % t.bars.length];
      let when = this.nextTime;
      if (t.swing && stepInBar % 2 === 1) when += stepDur * t.swing;
      this.scheduleStep(t, bar, stepInBar, when, stepDur);
      this.nextTime += stepDur;
      this.step = (this.step + 1) % total;
    }
  }

  scheduleStep(t, bar, s, when, stepDur) {
    // drums
    if (t.kick.includes(s)) this.kick(when);
    if (t.snare.includes(s)) this.snare(when);
    if (t.hat.includes(s)) this.hat(when, false, t.hatVol);
    if (t.openHat && t.openHat.includes(s)) this.hat(when, true, t.hatVol * 1.4);

    // bass: riff pattern or step pattern
    if (t.riff) {
      const f = t.riff[s];
      if (f) this.bassNote(when, f, stepDur * 1.8, t);
    } else if (t.bassSteps && t.bassSteps.includes(s)) {
      this.bassNote(when, bar.bass, stepDur * 4 * (t.bassLen || 1), t);
    }

    // sustained pad chord at bar start
    if (s === 0 && t.padVol > 0) this.pad(when, bar.chord, stepDur * 16, t);
    // low drone (oni)
    if (t.drone && s === 0) this.drone(when, t.drone, stepDur * 16);
    // chord stab
    if (t.stab && t.stab.includes(s)) {
      for (const f of bar.chord) this.pluck(when, f, stepDur * 1.2, 'sawtooth', 0.07, false);
    }
    // arpeggio
    if (t.arpSteps && t.arpSteps.includes(s) && t.arpVol > 0) {
      const idx = t.arpSteps.indexOf(s);
      let f = bar.chord[idx % bar.chord.length];
      if (t.arpOctave && idx % 2 === 1) f *= 2;
      this.pluck(when, f, stepDur * 2, t.arpType, t.arpVol, t.arpDelay);
    }
    // probabilistic melody (solo)
    if (t.melody && bar.scale && s % 2 === 0 && Math.random() < t.melody) {
      const f = bar.scale[(Math.random() * bar.scale.length) | 0];
      this.pluck(when, f, stepDur * 3, 'triangle', 0.15, true);
    }
  }

  // ---- music instruments ----

  env(gainNode, when, vol, attack, dur) {
    const g = gainNode.gain;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(vol, when + attack);
    g.exponentialRampToValueAtTime(0.0001, when + dur);
  }

  kick(when) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(42, when + 0.11);
    this.env(g, when, 0.55, 0.002, 0.16);
    osc.connect(g); g.connect(this.musicGain);
    osc.start(when); osc.stop(when + 0.2);
  }

  snare(when) {
    const len = Math.floor(this.ctx.sampleRate * 0.12);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    src.connect(bp); bp.connect(g); g.connect(this.musicGain);
    src.start(when);
    // body
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'triangle'; osc.frequency.value = 190;
    this.env(og, when, 0.12, 0.001, 0.08);
    osc.connect(og); og.connect(this.musicGain);
    osc.start(when); osc.stop(when + 0.1);
  }

  hat(when, open, vol = 0.07) {
    const dur = open ? 0.18 : 0.04;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(hp); hp.connect(g); g.connect(this.musicGain);
    src.start(when);
  }

  bassNote(when, freq, dur, t) {
    const osc = this.ctx.createOscillator();
    osc.type = t.bassType || 'sawtooth';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    this.env(g, when, t.bassVol || 0.5, 0.008, dur);
    let node = osc;
    if (t.bassFilter) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(t.bassFilter * 1.6, when);
      lp.frequency.exponentialRampToValueAtTime(t.bassFilter * 0.5, when + dur);
      lp.Q.value = 6;
      osc.connect(lp); node = lp;
    }
    node.connect(g); g.connect(this.musicGain);
    osc.start(when); osc.stop(when + dur + 0.05);
    if (t.detune) {
      const o2 = this.ctx.createOscillator();
      o2.type = osc.type; o2.frequency.value = freq; o2.detune.value = t.detune;
      const g2 = this.ctx.createGain();
      this.env(g2, when, (t.bassVol || 0.5) * 0.5, 0.008, dur);
      o2.connect(g2); g2.connect(this.musicGain);
      o2.start(when); o2.stop(when + dur + 0.05);
    }
  }

  pad(when, chord, dur, t) {
    for (const f of chord) {
      for (const det of [-4, 4]) {
        const osc = this.ctx.createOscillator();
        osc.type = t.padType || 'sine';
        osc.frequency.value = f;
        osc.detune.value = det;
        if (t.padVibrato) {
          const lfo = this.ctx.createOscillator();
          const lfoG = this.ctx.createGain();
          lfo.frequency.value = 5.2; lfoG.gain.value = 4;
          lfo.connect(lfoG); lfoG.connect(osc.detune);
          lfo.start(when); lfo.stop(when + dur);
        }
        const g = this.ctx.createGain();
        const vol = (t.padVol || 0.1) / chord.length;
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(vol, when + dur * 0.2);
        g.gain.setValueAtTime(vol, when + dur * 0.7);
        g.gain.linearRampToValueAtTime(0, when + dur);
        osc.connect(g); g.connect(this.musicGain);
        osc.start(when); osc.stop(when + dur + 0.05);
      }
    }
  }

  drone(when, freq, dur) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.28, when);
    g.gain.setValueAtTime(0.28, when + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, when + dur);
    osc.connect(g); g.connect(this.musicGain);
    osc.start(when); osc.stop(when + dur + 0.05);
  }

  pluck(when, freq, dur, type, vol, useDelay) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    this.env(g, when, vol, 0.004, dur);
    osc.connect(g);
    g.connect(this.musicGain);
    if (useDelay && this.delay) g.connect(this.delay);
    osc.start(when); osc.stop(when + dur + 0.05);
  }

  // -------------------------------------------------------------------------
  // SFX (one-shot)
  // -------------------------------------------------------------------------

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

  pickup()  { this.tone({ freq: 500, dur: 0.06, type: 'triangle', vol: 0.15 }); }
  putback() { this.tone({ freq: 300, dur: 0.08, type: 'triangle', vol: 0.12, sweep: -100 }); }
  place()   {
    this.tone({ freq: 220, dur: 0.08, type: 'square', vol: 0.10 });
    this.noise({ dur: 0.06, vol: 0.12, freq: 500 });
  }
  invalid() { this.tone({ freq: 160, dur: 0.12, type: 'sawtooth', vol: 0.10, sweep: -60 }); }

  clearLines(count, streak) {
    const base = [523, 659, 784, 1047];
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

  bossAttack() {
    // deep impact + growl
    this.tone({ freq: 70, dur: 0.4, type: 'sawtooth', vol: 0.28, sweep: -30 });
    this.tone({ freq: 110, dur: 0.3, type: 'square', vol: 0.12, sweep: -60, delay: 0.05 });
    this.noise({ dur: 0.35, vol: 0.2, freq: 300 });
  }

  bossDefeated() {
    [262, 330, 392, 523, 659, 784].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.3, type: 'triangle', vol: 0.2, delay: i * 0.1 }));
    this.noise({ dur: 0.8, vol: 0.12, freq: 2500, delay: 0.4 });
  }

  kamiDescend() {
    // divine shimmer: rising harmonics + noise sweep
    [440, 554, 659, 880, 1109, 1319].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.6, type: 'sine', vol: 0.14, delay: i * 0.09 }));
    this.noise({ dur: 1.2, vol: 0.08, freq: 6000, delay: 0.2 });
  }

  // legacy alias — some code paths call startMusic() without a track
  startMusic() { this.playTrack(this.trackName || 'solo'); }
}

export const audio = new AudioEngine();
