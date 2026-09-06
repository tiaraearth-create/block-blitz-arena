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
  Bb1: 58.27, Bb3: 233.08, Eb4: 311.13, Bb4: 466.16, F5: 698.46,
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
  // PIXELATION-inspired (Sol's RNG / t+pazolite "CENSORED!" energy):
  // an ORIGINAL high-speed chiptune rush — racing square arps, pounding
  // four-on-the-floor, octave-jumping bleeps. No melodies borrowed.
  pixel: {
    bpm: 182, swing: 0, padType: 'square', padVol: 0.035, arpType: 'square',
    kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hatVol: 0.07, openHat: [2, 10],
    bassSteps: [0, 2, 4, 6, 8, 10, 12, 14], bassLen: 0.5, bassType: 'square', bassVol: 0.42, bassFilter: 900,
    arpSteps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], arpVol: 0.12, arpDelay: true, arpOctave: true, melody: 0.35, stab: [0, 8],
    bars: [
      { chord: [N.A3, N.C4, N.E4], bass: N.A2, scale: [N.A4, N.C5, N.E5, N.G5, N.A5] },   // Am
      { chord: [N.F3, N.A3, N.C4], bass: N.F2, scale: [N.A4, N.C5, N.D5, N.E5, N.G5] },   // F
      { chord: [N.G3, N.B3, N.D4], bass: N.G2, scale: [N.G4, N.B4, N.D5, N.E5, N.G5] },   // G
      { chord: [N.E4, N.G4, N.B4], bass: N.E2, scale: [N.E5, N.G5, N.A5, N.B5, N.E6] },   // Em
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
  // ---- v2.8 new-mode originals ----
  // 🧩 遺跡の囁き — ancient puzzle chambers: slow dorian wander, marimba-ish
  // triangle plucks echoing off stone, a raised-6th D major that keeps the
  // mystery warm instead of sad.
  ruins: {
    bpm: 92, swing: 0.18, padType: 'sine', padVol: 0.13, arpType: 'triangle',
    kick: [0], snare: [], hat: [4, 12], hatVol: 0.04,
    bassSteps: [0, 10], bassLen: 2.2, bassType: 'sine', bassVol: 0.42,
    arpSteps: [0, 3, 6, 8, 11, 14], arpVol: 0.15, arpDelay: true, melody: 0.22,
    bars: [
      { chord: [N.A3, N.C4, N.E4, N.G4], bass: N.A2, scale: [N.A4, N.B4, N.C5, N.E5, N.Fs5] },  // Am7
      { chord: [N.C4, N.E4, N.G4, N.B4], bass: N.C3, scale: [N.A4, N.B4, N.C5, N.E5, N.G5] },   // Cmaj7
      { chord: [N.D4, N.Fs4, N.A4],      bass: N.D3, scale: [N.A4, N.B4, N.D5, N.E5, N.Fs5] },  // D (dorian lift)
      { chord: [N.A3, N.C4, N.E4],       bass: N.A2, scale: [N.E4, N.A4, N.B4, N.C5, N.E5] },   // Am
    ],
  },
  // ⛏️ 地底のハンマー — the mines: pounding industrial hammer-work, a dark
  // Em→Cm chromatic drop like a tunnel opening under your feet.
  mine: {
    bpm: 122, swing: 0, padType: 'sawtooth', padVol: 0.045, arpType: 'sawtooth',
    kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatVol: 0.08, openHat: [14],
    bassType: 'sawtooth', bassVol: 0.58, bassFilter: 380, detune: 9,
    riff: { 0: N.E2, 3: N.E2, 6: N.G2, 8: N.E2, 10: N.Bb2, 12: N.D2 * 2, 14: N.E2 },
    drone: N.E1, stab: [0, 8], arpSteps: [], arpVol: 0,
    bars: [
      { chord: [N.E4, N.G4, N.B4],   bass: N.E2 },        // Em
      { chord: [N.C4, N.Eb4, N.G4],  bass: N.C2 },        // Cm — the tunnel drops
    ],
  },
  // 👑 王座の間 — the throne room: stately D-major procession, fanfare arps
  // sparkling an octave up, quarter-note hats like guards keeping time.
  royal: {
    bpm: 108, swing: 0, padType: 'sine', padVol: 0.15, arpType: 'triangle',
    kick: [0, 8], snare: [4, 12], hat: [0, 4, 8, 12], hatVol: 0.06,
    bassSteps: [0, 6, 8, 14], bassLen: 1.4, bassType: 'triangle', bassVol: 0.5,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.14, arpDelay: true, arpOctave: true, melody: 0.18,
    bars: [
      { chord: [N.D4, N.Fs4, N.A4],       bass: N.D2, scale: [N.D5, N.E5, N.Fs5, N.A5, N.B5] },  // D
      { chord: [N.A3, N.Cs4, N.E4],       bass: N.A1, scale: [N.A4, N.B4, N.Cs5, N.E5, N.Fs5] }, // A
      { chord: [N.B3, N.D4, N.Fs4],       bass: N.B1, scale: [N.B4, N.D5, N.E5, N.Fs5, N.A5] },  // Bm
      { chord: [N.G3, N.B3, N.D4, N.E4],  bass: N.G2, scale: [N.G4, N.A4, N.B4, N.D5, N.E5] },   // G6
    ],
  },
  // 👻 幽霊屋敷のオルゴール — the hidden mode's music box: sparse high
  // triangle plucks drifting over a B-diminished creep, barely any pulse.
  ghost: {
    bpm: 76, swing: 0.12, padType: 'sine', padVol: 0.09, arpType: 'triangle',
    kick: [], snare: [], hat: [0], hatVol: 0.03,
    bassSteps: [0], bassLen: 3.4, bassType: 'sine', bassVol: 0.34,
    arpSteps: [0, 5, 9, 14], arpVol: 0.16, arpDelay: true, melody: 0.16,
    bars: [
      { chord: [N.A4, N.C5, N.E5], bass: N.A2, scale: [N.A4, N.B4, N.C5, N.E5, N.F5] },   // Am — the music box turns
      { chord: [N.F4, N.A4, N.C5], bass: N.F2, scale: [N.A4, N.C5, N.D5, N.F5] },          // F
      { chord: [N.B3, N.D4, N.F4], bass: N.B1, scale: [N.B4, N.D5, N.F5] },                // Bdim — something is here
      { chord: [N.E4, N.B4, N.E5], bass: N.E2, scale: [N.E5, N.B4, N.A4, N.C5] },          // E5 hollow
    ],
  },
  // ---- Guest tracks ported from ブロックブラスト (Block Blast) ----
  // Faithful to the original's sequencer: arp cycles root→3rd→5th→3rd an
  // octave above the chord on every 8th note, bass hits beats 1 & 3 an octave
  // below, kick on 1 & 3, hat on offbeats. Chords/tempo/waveforms are the
  // originals; only volumes are re-balanced for this engine's gain staging.
  blastMenu: {
    bpm: 92, swing: 0, padType: 'sine', padVol: 0, arpType: 'sine',
    kick: [], snare: [], hat: [], hatVol: 0.05,
    bassSteps: [0, 8], bassLen: 1, bassType: 'triangle', bassVol: 0.27,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.2, arpDelay: false,
    bars: [
      { chord: [N.A4, N.C5, N.E5, N.C5], bass: N.A2 },    // Am
      { chord: [N.F4, N.A4, N.C5, N.A4], bass: N.F2 },    // F
      { chord: [N.C5, N.E5, N.G5, N.E5], bass: N.C3 },    // C
      { chord: [N.G4, N.B4, N.D5, N.B4], bass: N.G2 },    // G
    ],
  },
  blastGame: {
    bpm: 118, swing: 0, padType: 'sine', padVol: 0, arpType: 'square',
    kick: [0, 8], snare: [], hat: [2, 6, 10, 14], hatVol: 0.06,
    bassSteps: [0, 8], bassLen: 1, bassType: 'triangle', bassVol: 0.32,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.13, arpDelay: false,
    bars: [
      { chord: [N.C5, N.E5, N.G5, N.E5], bass: N.C3 },    // C
      { chord: [N.G4, N.B4, N.D5, N.B4], bass: N.G2 },    // G
      { chord: [N.A4, N.C5, N.E5, N.C5], bass: N.A2 },    // Am
      { chord: [N.F4, N.A4, N.C5, N.A4], bass: N.F2 },    // F
    ],
  },
  blastVs: {
    bpm: 128, swing: 0, padType: 'sine', padVol: 0, arpType: 'sawtooth',
    kick: [0, 8], snare: [], hat: [2, 6, 10, 14], hatVol: 0.06,
    bassSteps: [0, 8], bassLen: 1, bassType: 'sawtooth', bassVol: 0.25,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.1, arpDelay: false,
    bars: [
      { chord: [N.D5, N.F5, N.A5, N.F5], bass: N.D3 },    // Dm
      { chord: [N.Bb4, N.D5, N.F5, N.D5], bass: N.Bb2 },  // Bb
      { chord: [N.C5, N.F5, N.A5, N.F5], bass: N.C3 },    // F/C
      { chord: [N.C5, N.E5, N.G5, N.E5], bass: N.C3 },    // C
    ],
  },
  blastGod: {
    bpm: 142, swing: 0, padType: 'sine', padVol: 0, arpType: 'sawtooth',
    kick: [0, 8], snare: [], hat: [2, 6, 10, 14], hatVol: 0.07,
    bassSteps: [0, 8], bassLen: 1, bassType: 'square', bassVol: 0.27,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.12, arpDelay: false,
    bars: [
      { chord: [N.D5, N.Fs5, N.A5, N.Fs5], bass: N.D3 },  // D
      { chord: [N.A4, N.Cs5, N.E5, N.Cs5], bass: N.A2 },  // A
      { chord: [N.B4, N.D5, N.Fs5, N.D5], bass: N.B2 },   // Bm
      { chord: [N.G4, N.B4, N.D5, N.B4], bass: N.G2 },    // G
    ],
  },
  blastBoss: {
    bpm: 76, swing: 0, padType: 'sine', padVol: 0, arpType: 'sawtooth',
    kick: [0, 8], snare: [], hat: [], hatVol: 0.06,
    bassSteps: [0, 8], bassLen: 1, bassType: 'sawtooth', bassVol: 0.45,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.09, arpDelay: false,
    bars: [
      { chord: [N.D4, N.F4, N.A4, N.F4], bass: N.D2 },    // Dm
      { chord: [N.Bb3, N.D4, N.F4, N.D4], bass: N.Bb1 },  // Bb
      { chord: [N.C4, N.Eb4, N.G4, N.Eb4], bass: N.C2 },  // Cm
      { chord: [N.A3, N.C4, N.E4, N.C4], bass: N.A1 },    // Am
    ],
  },
  blastBoss2: {
    bpm: 148, swing: 0, padType: 'sine', padVol: 0, arpType: 'sawtooth',
    kick: [0, 8], snare: [], hat: [2, 6, 10, 14], hatVol: 0.07,
    bassSteps: [0, 8], bassLen: 1, bassType: 'sawtooth', bassVol: 0.5,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.11, arpDelay: false,
    bars: [
      { chord: [N.D4, N.F4, N.A4, N.F4], bass: N.D2 },    // Dm
      { chord: [N.Bb3, N.D4, N.F4, N.D4], bass: N.Bb1 },  // Bb
      { chord: [N.E4, N.G4, N.Bb4, N.G4], bass: N.E2 },   // Edim
      { chord: [N.A3, N.C4, N.E4, N.C4], bass: N.A1 },    // Am
    ],
  },
};
// fix kami 4th chord (Gs4 not defined above)
TRACKS.kami.bars[3].chord = [N.E4, 415.3, N.B4];

// Jukebox metadata: titles + where each track normally plays.
// bpm is read from TRACKS so the two never drift apart.
// 絵は iconName（public/js/icons.js の名前）。以前は 🏠 のような絵文字を直に
// 持っていて、ジュークボックスの一覧で端末ごとに絵が変わっていた。
// → 描画は public/js/screens.js の .jb-icon （innerHTML）。
export const TRACK_INFO = [
  { id: 'menu',   iconName: 'mode_room', name: 'やすらぎのロビー', nameEn: 'Cozy Lobby',      where: 'メニュー',                 whereEn: 'Menu' },
  { id: 'solo',   iconName: 'mode_solo', name: 'ブロックさんぽ',   nameEn: 'Block Stroll',    where: 'ソロ・キメラ',             whereEn: 'Solo / Chimera' },
  { id: 'battle', iconName: 'mode_online', name: 'アリーナの熱気',   nameEn: 'Arena Heat',      where: 'オンライン対戦・連鎖・リプレイ・ウィークリー・デイリー', whereEn: 'Online / Chain / Replay / Weekly / Daily' },
  { id: 'hard',   iconName: 'fire', name: '限界突破',         nameEn: 'Limit Break',     where: '達人・タイムアタック',     whereEn: 'Expert / Time Attack' },
  { id: 'boss',   iconName: 'mode_boss', name: '巨影せまる',       nameEn: 'Looming Giant',   where: 'ボス戦',                   whereEn: 'Boss fights' },
  { id: 'oni',    iconName: 'foe_oni', name: '鬼の巣窟',         nameEn: "Oni's Den",       where: '鬼・深淵',                 whereEn: 'Oni / Abyss' },
  { id: 'pixel',  iconName: 'mode_royale', name: 'PIXEL RUSH 182',   nameEn: 'PIXEL RUSH 182',  where: 'バトルロイヤル',           whereEn: 'Battle Royale' },
  { id: 'kami',   iconName: 'badge_kami', name: '天上の光',         nameEn: 'Celestial Light', where: '神・天国ダンジョン',       whereEn: 'Kami / Heaven' },
  { id: 'ruins',  iconName: 'mode_puzzle', name: '遺跡の囁き',       nameEn: 'Whisper of Ruins', where: 'パズル遺跡・設計図・工房', whereEn: 'Puzzle Ruins / Blueprint / Workshop' },
  { id: 'mine',   iconName: 'mode_dig', name: '地底のハンマー',   nameEn: 'Hammer Below',     where: '採掘場',                  whereEn: 'The Mines' },
  { id: 'royal',  iconName: 'throne', name: '王座の間',         nameEn: 'Throne Room',      where: '王者のテーマ（ジュークボックス限定）', whereEn: 'Champions (jukebox exclusive)' },
  { id: 'ghost',  iconName: 'mode_ghost', name: '幽霊屋敷のオルゴール', nameEn: 'Haunted Music Box', where: '？？？', whereEn: '???', hidden: true },
  { id: 'blastMenu',  iconName: 'block', name: 'ブラスト・ホーム', nameEn: 'Blast Home',       where: 'ブロックブラストより：メニュー', whereEn: 'From Block Blast: menu' },
  { id: 'blastGame',  iconName: 'ore_crystal', name: 'ブラスト・パズル', nameEn: 'Blast Puzzle',     where: 'ブロックブラストより：ソロ',     whereEn: 'From Block Blast: solo' },
  { id: 'blastVs',    iconName: 'mode_ai', name: 'ブラスト・バトル', nameEn: 'Blast Battle',     where: 'ブロックブラストより：対戦',     whereEn: 'From Block Blast: versus' },
  { id: 'blastGod',   iconName: 'ultimate', name: 'ゴッドラッシュ',   nameEn: 'God Rush',         where: 'ブロックブラストより：神モード', whereEn: 'From Block Blast: God mode' },
  { id: 'blastBoss',  iconName: 'mode_abyss', name: '終焉のテーマ',     nameEn: 'Theme of the End', where: 'ブロックブラストより：終焉戦',   whereEn: 'From Block Blast: final boss' },
  { id: 'blastBoss2', iconName: 'combo', name: '終焉・覚醒',       nameEn: 'The End Awakened', where: 'ブロックブラストより：覚醒形態', whereEn: 'From Block Blast: awakened' },
].map(t => ({ ...t, bpm: TRACKS[t.id].bpm }));

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
    this.trackName = null;       // what the game asked for ('menu', 'solo', ...)
    this.lockedTrack = null;     // jukebox pin: overrides the game's choice everywhere
    this.previewTrack = null;    // jukebox modal preview: overrides everything while open
    this.playing = null;         // currently scheduled track
    this.scheduler = null;
    this.step = 0;
    this.nextTime = 0;
    // 先読み秒数。通常0.35秒。YouTubeスタジオが録画中にタブが隠れたとき、
    // タイマーが1秒間隔に制限されても音が途切れないよう一時的に増やす。
    this.lookahead = 0.35;
    // 🔇 タブが隠れている間の自動停止まわりの状態
    this.hiddenTimer = null;      // 「隠れた」→ 実際に止めるまでの猶予タイマー
    this.pausedHidden = false;    // 自動停止で止めた（＝復帰時に戻す責任がある）
    this.wasScheduling = false;   // 止めた時点でBGMが鳴っていたか
    // 録画など「隠れても鳴らし続けたい」処理はこれを true にする（外部から設定可）。
    this.keepAliveWhileHidden = false;
  }

  // 再生中の曲を1小節目から流し直す（録画の頭出し用）。
  restart() { this.syncTrack(true); }

  ensure() {
    if (this.ctx) {
      // 🔇 自動停止で止めている最中（かつ本当にまだ隠れている）なら resume しない。
      // ここで無条件に戻すと、裏で鳴った効果音ひとつで AudioContext が復活し、
      // バックグラウンドから音が漏れる（⛓️連鎖の自走中など）。
      // 復帰は resumeFromHidden() の責務 ── あちらは pausedHidden を false に
      // してから resume するのでここを通り抜ける。
      const stillHidden = this.pausedHidden
        && typeof document !== 'undefined' && document.hidden
        && !this.keepSoundWhileHidden();
      if (this.ctx.state === 'suspended' && !stillHidden) this.ctx.resume();
      return true;
    }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      // 🎚️ マスターリミッター（高音質化）— 音量が100%を超えてブーストされても
      // 音割れせず、全体の音圧もまとまる。master → limiter → destination。
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 5;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.16;
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
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
    // 200%までのブーストを許可（リミッターが音割れを防ぐ）。
    this.sfxVol = Math.max(0, Math.min(2, Number(sfxVol) || 0));
    this.musicVol = Math.max(0, Math.min(2, Number(musicVol) || 0));
    sfxVol = this.sfxVol;
    musicVol = this.musicVol;
    if (this.ctx) {
      this.sfxGain.gain.value = sfxVol;
      this.musicGain.gain.value = 0.45 * musicVol;
    }
  }

  setMusicEnabled(on) {
    this.musicOn = on;
    if (!on) this.stopScheduler();
    // No force: re-applying settings (e.g. dragging a volume slider) must not
    // restart the current track from the top.
    else this.syncTrack();
  }

  // -------------------------------------------------------------------------
  // Music engine
  // -------------------------------------------------------------------------
  // Which track actually sounds: jukebox preview > jukebox pin > game request.

  playTrack(name, force = false) {
    this.trackName = name;
    this.syncTrack(force);
  }

  // Jukebox (サウンドトラック): preview while the modal is open, or pin one
  // track so screen changes stop switching the music (ループ固定).
  preview(name) { this.previewTrack = TRACKS[name] ? name : null; this.syncTrack(); }
  stopPreview() { this.previewTrack = null; this.syncTrack(); }
  // 予約を止めるだけ。すでに積んだ音は最後まで鳴らす ──
  // 「蛇口を閉めて、管に残っているぶんは流し切る」。
  // stopPreview() だと lockedTrack/trackName に落ちて **別の曲が鳴り出す** ので、
  // 本当に静かにしたいときはこちらを使う（YouTubeスタジオの頭出し）。
  hush() { this.previewTrack = null; this.stopScheduler(); }
  setLockedTrack(name) { this.lockedTrack = name && TRACKS[name] ? name : null; this.syncTrack(); }

  syncTrack(force = false) {
    const name = this.previewTrack || this.lockedTrack || this.trackName;
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

  stopMusic() { this.trackName = null; this.syncTrack(); }

  stopScheduler() {
    if (this.scheduler) { clearInterval(this.scheduler); this.scheduler = null; }
    this.playing = null;
  }

  // -------------------------------------------------------------------------
  // 🔇 バックグラウンド時の自動停止（タブ/アプリが隠れたら鳴らさない）
  // -------------------------------------------------------------------------
  // 隠れても鳴らし続けたい場面（YouTubeスタジオの録画中）は先読みが広げられる。
  // その間は絶対に止めない ── 止めると録画に無音が焼き込まれてしまう。
  keepSoundWhileHidden() {
    return this.keepAliveWhileHidden === true || (this.lookahead || 0.35) > 0.4;
  }

  onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      // すぐには止めない。同じイベントで先読みを広げる処理（録画）が走るので、
      // 少し待ってから「本当に止めてよいか」を判断する。一瞬の切り替えでも
      // 音が途切れないという副作用つき。
      if (this.hiddenTimer) return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        if (document.hidden) this.pauseForHidden();
      }, 300);
    } else {
      if (this.hiddenTimer) { clearTimeout(this.hiddenTimer); this.hiddenTimer = null; }
      this.resumeFromHidden();
    }
  }

  pauseForHidden() {
    // ctx 未生成（ユーザー操作前）や録画中は何もしない。
    if (!this.ctx || this.pausedHidden || this.keepSoundWhileHidden()) return;
    this.wasScheduling = !!this.scheduler;
    this.stopScheduler();
    this.pausedHidden = true;
    try {
      const p = this.ctx.suspend();
      if (p && p.catch) p.catch(() => { /* すでに閉じている等 */ });
    } catch { /* 古い実装 */ }
  }

  resumeFromHidden() {
    // 自分で止めたときだけ戻す（止めていないのに曲を貼り直すと、タブを
    // 切り替えるたびに1小節目に巻き戻ってしまう）。
    if (!this.pausedHidden || !this.ctx) return;
    this.pausedHidden = false;
    // 隠れている間に別の曲が予約されていた場合、その nextTime は止まった時計を
    // 基準にしていて過去になっている。どちらの場合も貼り直しが必要。
    const wanted = this.wasScheduling || !!this.scheduler;
    this.wasScheduling = false;
    const back = () => {
      if (!this.ctx || (typeof document !== 'undefined' && document.hidden)) return;
      // syncTrack(force) が nextTime を ctx.currentTime 基準に引き直すので、
      // 溜まった音が復帰直後に一斉に鳴ることはない。
      if (wanted) this.syncTrack(true);
    };
    try {
      const p = this.ctx.resume();
      if (p && p.then) p.then(back, back); else back();
    } catch { back(); }
  }

  scheduleAhead() {
    const t = TRACKS[this.playing];
    if (!t || !this.ctx) return;
    const stepDur = 60 / t.bpm / 4;
    const total = t.bars.length * 16;
    while (this.nextTime < this.ctx.currentTime + (this.lookahead || 0.35)) {
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

  // 🔇 タブが裏に回っている間の効果音は鳴らさない。⛓️連鎖のように隠れていても
  // 自走する処理があるので、ここで止めないと裏から音が聞こえてしまう。
  // 録画中（keepSoundWhileHidden）は従来どおり鳴らす。
  sfxSuppressed() {
    return typeof document !== 'undefined' && document.hidden && !this.keepSoundWhileHidden();
  }

  tone({ freq = 440, dur = 0.15, type = 'sine', vol = 0.3, attack = 0.005, sweep = 0, delay = 0 }) {
    if (!this.sfxOn || this.sfxSuppressed() || !this.ensure()) return;
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
    if (!this.sfxOn || this.sfxSuppressed() || !this.ensure()) return;
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
    // ピッチ上げの頭打ちが streak 6 と早すぎて、長い連鎖が短い連鎖と同じに
    // 聞こえていた。10 まで開ける（上げ幅は 0.06→0.05 に緩めて音程の暴れを抑える）。
    const lift = 1 + 0.05 * Math.min(streak, 10);
    for (let i = 0; i < Math.min(count + 1, 4); i++) {
      this.tone({ freq: base[i] * lift, dur: 0.22, type: 'triangle', vol: 0.22, delay: i * 0.05 });
    }
    this.noise({ dur: 0.25, vol: 0.18, freq: 2000 });
    if (count >= 2) this.tone({ freq: 1568, dur: 0.4, type: 'sine', vol: 0.15, delay: 0.15 });
  }

  combo(streak) {
    // 以前は Math.min(streak, 10) で頭打ち ── streak 10 と 25 が同じ音だった。
    // 16 まで開け、さらに上の段では倍音を1本足して「まだ伸びている」を耳で返す。
    // 上の段は上げ幅を緩める（1.12 のまま 16 まで伸ばすと耳に刺さる）。
    const n = Math.max(0, Math.min(Number(streak) || 0, 16));
    const f = 440 * Math.pow(1.12, Math.min(n, 10)) * Math.pow(1.06, Math.max(0, n - 10));
    this.tone({ freq: f, dur: 0.15, type: 'sine', vol: 0.2 });
    this.tone({ freq: f * 1.5, dur: 0.2, type: 'sine', vol: 0.12, delay: 0.06 });
    if (streak >= 10) this.tone({ freq: f * 2, dur: 0.24, type: 'triangle', vol: 0.09, delay: 0.12 });
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

  // ✨ 全消し「昇華」— 盤面が完全に空になった瞬間の短いジングル（1秒以内）。
  // 上昇アルペジオ（Cメジャー）＋到達点のきらめき。
  ascend() {
    [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => {
      this.tone({ freq: f, dur: 0.26, type: 'triangle', vol: 0.2, delay: i * 0.07 });
      this.tone({ freq: f * 2, dur: 0.16, type: 'sine', vol: 0.06, delay: i * 0.07 });
    });
    // きらめき: 高いベル2発＋空気感のノイズ
    this.tone({ freq: 1567.98, dur: 0.45, type: 'sine', vol: 0.15, delay: 0.36 });
    this.tone({ freq: 2093, dur: 0.4, type: 'sine', vol: 0.09, delay: 0.44 });
    this.noise({ dur: 0.45, vol: 0.07, freq: 7000, delay: 0.3 });
  }

  // legacy alias — some code paths call startMusic() without a track
  startMusic() { this.playTrack(this.trackName || 'solo'); }
}

export const audio = new AudioEngine();

// 全消しジングル: audio.ascend() でも、この関数でも呼べる（modes.js 用）。
export function sfxAscend() { audio.ascend(); }

// タブ/アプリが隠れたらBGMを止め、戻ったら再開する。
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => audio.onVisibilityChange());
}
