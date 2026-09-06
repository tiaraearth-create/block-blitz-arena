// Synthesized SFX + generative BGM via WebAudio — no audio assets.
// The music engine is a 16th-note step sequencer with per-mode tracks,
// scheduled ahead on the AudioContext clock (immune to timer jitter).

// ---------------------------------------------------------------------------
// Track definitions
// ---------------------------------------------------------------------------
// Note helpers: frequencies for common notes
// ⚠ N と TRACKS は test/tracks.test.mjs が直接読む（正規表現で写し取ると、
//   表と実装がズレたときにテストが嬉しい嘘をつく）。
export const N = {
  E1: 41.2, A1: 55, B1: 61.74, C2: 65.41, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98,
  A2: 110, Bb2: 116.54, B2: 123.47, C3: 130.81, Cs3: 138.59, D3: 146.83, E3: 164.81,
  F3: 174.61, Fs3: 185, G3: 196, A3: 220, B3: 246.94, C4: 261.63, Cs4: 277.18,
  D4: 293.66, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392, A4: 440, B4: 493.88,
  C5: 523.25, Cs5: 554.37, D5: 587.33, E5: 659.25, Fs5: 739.99, G5: 783.99, A5: 880,
  B5: 987.77, Cs6: 1108.73, E6: 1318.51,
  Bb1: 58.27, Bb3: 233.08, Eb4: 311.13, Bb4: 466.16, F5: 698.46,
  // G#4。表に無いまま `N.Gs4 || N.A4` と書かれていて、**実際には常に A4 側**が
  // 選ばれていた（そのあと下の1行で E-G#-B に上書きしていたので音は正しかったが、
  // 「表に無い音名を書く」という事故の形がそのまま残っていた）。
  Gs4: 415.3,
};

// Each track: bpm, swing (0..0.3 on odd 16ths), bars (each bar = 16 steps):
//   chord: pad/arp notes, bass: root, riff: optional per-step bass melody
// drum patterns are step indexes within a bar.
export const TRACKS = {
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
      { chord: [N.E4, N.Gs4, N.B4], bass: N.E2 },        // E
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
  // ---- v2.65: モード専用曲 ----------------------------------------------
  // 「とりあえず battle でいいや」で借り続けた結果、12モードが4曲を回していた。
  // ここから下は**そのモードのためだけに書いた曲**。借り手が増えたら曲も増やすこと
  // （test/tracks.test.mjs の E-1 が、借りた瞬間に赤くなる）。
  // 🔥 炉心のカウントダウン — メルトダウン。Bbm→Bm→Cm→C#dim と1小節ごとに半音ずつ
  // 迫り上がり、4小節目は5度が G4 のまま上がりきらず減三和音になる ＝ 臨界。ループ頭で
  // 3半音ぶん落ちるのは事故ではなく、冷却セルを消したときの一気の冷え込みそのもの。
  // 「じりじり上がって、どんと落ちる」熱ゲージの体感にそろえてある。
  // ⚠ riff は足さないこと。毎小節同じ音形なので、半音ずつ動くこの4小節では必ず濁る。
  meltdown: {
    // pad だけ sawtooth。square にすると padType/arpType/bassType の三つ組が pixel と
    // 完全一致する（padVol の 0.035 まで同じだった）。saw/square/square は既存18曲に無い。
    bpm: 158, swing: 0, padType: 'sawtooth', padVol: 0.05, arpType: 'square',
    // ⏱ カウントは**小節の内側**で数える。エンジンは4小節すべてに同じステップ集合を当てる
    //   （bar ごとの上書きは契約に無い）ので、均一な16分だと「速い曲」で終わってしまう。
    //   キックは間隔が 6→4→3→2 と詰まり、step15 と次の小節の 0 が 95ms の二度打ちになる。
    //   ハットは前半8分／後半16分にして、境目の 7 のオープンを倍速の合図にした。
    //   ここを平らに均すと曲名が嘘になる。
    kick: [0, 6, 10, 13, 15], snare: [4, 12],
    hat: [0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14], hatVol: 0.055, openHat: [7, 15],
    // 音長 1.28ステップの「単発→二連」ガロップ。detune 30 は既存（boss 10 / oni 8 /
    // mine 9）より深いが、あちらはドローンが下で伸びている ── 無いこの曲では浅いと
    // 何も足されない。狙いは基音のうなり（約1Hz。音1つ 0.12秒では回りきらない）ではなく、
    // bassNote でローパスを通らず直挿しされる裏オシレータの上倍音のざらつき
    // （15倍音で音1つあたり約1.9周期）。
    bassSteps: [0, 3, 4, 7, 8, 11, 12, 15], bassLen: 0.32, bassType: 'square', bassVol: 0.5,
    bassFilter: 760, detune: 30,
    // chord は4音 [root, 3rd, 5th, 3rd]。arp は chord[arpSteps.indexOf(s) % chord.length]
    // なので 8個 ÷ 4音 で同じ音形が1小節にちょうど2回、arpOctave が奇数番目（＝2つの 3rd）
    // を1オクターブ上げて「低い root/5th ↔ 高い 3rd」を往復する警報になる。3音にすると
    // 周期が 6（3音 × オクターブ2）で8スロットに収まらず、小節内で一度も繰り返さない
    // バラバラの分散和音（実測6音）になる。代償として pad と stab は 3rd が二重に鳴って
    // 短3度が前に出るが、警報としてはむしろ好都合なのでそのまま使っている。
    arpSteps: [0, 1, 4, 5, 8, 9, 12, 13], arpVol: 0.11, arpDelay: true, arpOctave: true,
    // stab はエンジン側で 'sawtooth' 固定・音量 0.07 固定。square だけの曲ではない。
    stab: [0, 12],
    bars: [
      { chord: [N.Bb3, N.Cs4, N.F4,  N.Cs4], bass: N.Bb1 },     // Bbm   — 平常運転
      { chord: [N.B3,  N.D4,  N.Fs4, N.D4],  bass: N.B1 },      // Bm    — 半音上がる
      { chord: [N.C4,  N.Eb4, N.G4,  N.Eb4], bass: N.C2 },      // Cm    — さらに半音
      { chord: [N.Cs4, N.E4,  N.G4,  N.E4],  bass: N.Cs3 / 2 }, // C#dim — 5度が上がらず臨界
    ],
  },
  // 🌊 押し寄せる波 — サバイバル。2小節の形が4回来る。前半4小節は三和音で、アルペジオが
  // 根音→3度→5度→根音と折り返して下がる。5・6小節は1・2小節と同じ声部に7thを1音足した
  // だけの和音で、chord が4音になるぶん折り返さず7thまで昇りきる（F5=698Hz が曲の最高音）。
  // 7小節は Cm7 で根音が曲の最低音 C2 まで落ち、8小節は三和音の D＝引き波。V→i で輪が閉じる。
  // chord は全小節 bass のちょうど2オクターブ上（揃っていないと上の対応が耳に出ない）。
  survival: {
    bpm: 117, swing: 0, padType: 'triangle', padVol: 0.10, arpType: 'sine',
    // 🥁 スネアは8だけのハーフタイム。キックは頭以外を表拍から外して転がす。ハットは
    //    3ステップ刻み（3,6,9,12）で4/4の上をずれて流れ、最後だけ 14→openHat15 と詰めて
    //    小節線に崩れ込む。hat は arpSteps と1つも重ならず、空きは 1・4・7 の3ステップだけ。
    kick: [0, 6, 11, 14], snare: [8], hat: [3, 6, 9, 12, 14], hatVol: 0.045, openHat: [15],
    // 低音は1音6ステップ（1拍半）。0 のあと 9・12 と小節の後ろ半分に寄せてあり、9 の減衰の
    // 尾に 12 が重なる＝後ろ半分で足元が重くなる。フィルタは1音ごとに 480→150Hz（Q6）まで
    // 落ちるので、同じ根音でも打つたび沈む。detune は2本目だけ +6セント＝G2 で約0.3Hz のうねり。
    bassSteps: [0, 9, 12], bassLen: 1.5, bassType: 'triangle', bassVol: 0.46,
    bassFilter: 300, detune: 6,
    // arpVol は padVol より上。pad と arp は同じ bar.chord を鳴らす＝音程が同じなので、
    // 倍音の少ない sine が triangle パッドに埋もれるとこの曲の主題そのものが消える。
    // arpOctave は使わない（奇数番目だけ1オクターブ上がる仕様で、折り返しの形が壊れる）。
    // melody の pluck はエンジン側で triangle・vol 0.15 固定なので、scale は chord のおおむね
    // 1オクターブ下（175〜370Hz）に置いて伴流にまわす。後半だけ4音→5音に増える。
    arpSteps: [2, 5, 10, 13], arpVol: 0.18, arpDelay: true, melody: 0.12,
    bars: [
      // ── 前半：三和音。arpSteps が4つ・chord が3音なので 根音→3度→5度→根音 と折り返す ──
      { chord: [N.G4, N.Bb4, N.D5],        bass: N.G2,  scale: [N.G3, N.Bb3, N.D4, N.F4] },        // Gm
      { chord: [N.Eb4, N.G4, N.Bb4],       bass: 77.78, scale: [N.G3, N.Bb3, N.C4, N.F4] },        // Eb（根音 Eb2＝77.78Hz。N に Eb2 が無い）
      { chord: [N.G4, N.Bb4, N.D5],        bass: N.G2,  scale: [N.G3, N.Bb3, N.D4, N.F4] },        // Gm
      { chord: [N.F4, N.A4, N.C5],         bass: N.F2,  scale: [N.F3, N.A3, N.C4, N.D4] },         // F（bVII）
      // ── 後半：chord が4音になり、アルペジオは折り返さず 根音→3度→5度→7度 と昇りきる ──
      { chord: [N.G4, N.Bb4, N.D5, N.F5],  bass: N.G2,  scale: [N.G3, N.Bb3, N.C4, N.D4, N.F4] },  // Gm7   ＝1小節目＋F5。ここが満潮
      { chord: [N.Eb4, N.G4, N.Bb4, N.D5], bass: 77.78, scale: [N.G3, N.Bb3, N.C4, N.Eb4, N.F4] }, // Ebmaj7 ＝2小節目＋D5
      { chord: [N.C4, N.Eb4, N.G4, N.Bb4], bass: N.C2,  scale: [N.G3, N.Bb3, N.C4, N.Eb4, N.F4] }, // Cm7   — 根音 C2 が曲の最低音。上が下がり、床が抜ける
      { chord: [N.D4, N.Fs4, N.A4],        bass: N.D2,  scale: [N.A3, N.C4, N.D4, N.Fs4] },        // D（V）— 三和音に戻って折り返す＝引き波。scale の C が D7 の色で Gm に引き戻す
    ],
  },
  // ⏱ 秒針 — タイムアタック。時計はこちらの都合を聞かない、という曲。
  // 4分の刻みは 動く音→C5→動く音→C5 の交替（カチ・コチ）で、C5 は4小節どこでも
  // 同じ高さ。136BPM なので 0.88 秒ごとに戻る＝1秒よりわずかに速い秒針。
  // Fm→Cm→D♭→C。D♭ では動かない C5 が長7度になって軋み、最後の小節だけ
  // 頭に E♮（F の導音）が落ちて主音へ半音でもたれる＝残り時間が締めつける。
  sprint: {
    bpm: 136, swing: 0, padType: 'triangle', padVol: 0.06, arpType: 'square',
    // step 4 と 12 には打楽器のアタックもベースのアタックも置かない。
    // 秒針の C5 が1小節に2回、そこだけ裸で立つ場所。
    kick: [0, 6, 8, 14], snare: [2, 10],
    hat: [3, 7, 11], hatVol: 0.04, openHat: [15],
    bassSteps: [0, 3, 8, 11], bassLen: 0.5, bassType: 'sawtooth', bassVol: 0.36, bassFilter: 260,
    // arpDelay:false ＝ 機械の音に残響は無い。arpOctave は付けない ── 付けると
    // chord[1] と chord[3]（どちらも C5）が両方 C6 に飛び、秒針が 1047Hz の
    // 細い音になってしまう。
    arpSteps: [0, 4, 8, 12], arpVol: 0.15, arpDelay: false,
    bars: [
      // chord = [動く音, 秒針C5, 動く音, 秒針C5]。arp は arpSteps.indexOf(step) で
      // chord を頭から順に読むので、この並びがそのまま鳴る順になる。
      // ⚠ C5 が2つあるのは意図。stab は持たせない（stab は chord をまるごと
      //   pluck する実装なので、同じ C5 の saw が2本立って そこだけ +6dB になる）。
      //   pad は chord を等分するので C5 だけ他の2音の2倍の重み＝秒針が
      //   パッドの中でも芯として残る。
      { chord: [N.F4,  N.C5, N.Gs4, N.C5], bass: N.F2 },      // Fm（N.Gs4 = A♭4）
      { chord: [N.Eb4, N.C5, N.G4,  N.C5], bass: N.C2 },      // Cm
      { chord: [N.Gs4, N.C5, N.F4,  N.C5], bass: N.Cs3 / 2 }, // D♭maj7（Cs3/2 = D♭2）
      { chord: [N.E4,  N.C5, N.G4,  N.C5], bass: N.C2 },      // C — E♮ が小節頭で導音に
    ],
  },
  // 🌀 気まぐれの盤 — カオスモード。ルール変化は20/15/8秒から選ぶが、この曲は1周
  // 17.3秒の8小節なので、どの間隔とも周期がずれ続ける。ト短調で始まり、4小節目のD7で
  // 「Gmへ帰る」と思わせて5小節目にホ長調へ丸ごと飛び、B→Gm7で何事もなかった顔に戻る。
  // ハイハットは奇数ステップだけ＝全部ウラ（7だけオープン）、キックは 3-3-5-3-2 で、
  // 拍2(step4)と拍3(step8)はメロディ以外まるごと空く。荒れるのはリズムと調だけ。
  chaos: {
    // swing 0.24 で奇数16分＝ウラ側が32ms遅れる。melody は偶数ステップにしか出ない
    // エンジン仕様なので、いちばん上の声部だけが遅れずグリッドに残る。
    bpm: 111, swing: 0.24, padType: 'triangle', padVol: 0.09, padVibrato: true, arpType: 'sine',
    kick: [0, 3, 6, 11, 14], snare: [5, 12], hat: [1, 3, 5, 9, 11, 13, 15], hatVol: 0.055, openHat: [7],
    bassSteps: [0, 3, 6, 11], bassLen: 0.6, bassType: 'square', bassVol: 0.42, bassFilter: 560,
    // stab は置かない ── scheduleStep は stab を sawtooth 固定で鳴らすので、ここだけ
    // 音色が浮いて曲中いちばん硬い音になる（step6 のアクセントはキックとベースが持つ）。
    arpSteps: [0, 2, 5, 7, 10, 13], arpVol: 0.15, arpDelay: true, arpOctave: true, melody: 0.22,
    // アルペジオは 6ステップ ÷ 3音でちょうど2周し、奇数番目だけ arpOctave で上がる
    // （1小節目は D4→G5→Bb4→D5→G4→Bb5）。8小節目は4音なので 0,1,2,3,0,1 と回るが、
    // Bb4 が4番目なので頂点は Bb5 のまま。830.61=G#5 / 622.26=D#5 は N に無い音。
    bars: [
      { chord: [N.D4, N.G4, N.Bb4],       bass: N.G2,      scale: [N.G4, N.Bb4, N.C5, N.D5, N.F5] },      // Gm
      { chord: [N.D4, N.F4, N.Bb4],       bass: N.Bb2,     scale: [N.Bb4, N.C5, N.D5, N.F5, N.G5] },      // Bb
      { chord: [N.C4, N.F4, N.A4],        bass: N.F2,      scale: [N.A4, N.C5, N.D5, N.F5, N.G5] },       // F
      { chord: [N.D4, N.Fs4, N.A4],       bass: N.D2,      scale: [N.A4, N.C5, N.D5, N.E5, N.Fs5] },      // D7 — Gmへ帰ると思わせて
      { chord: [N.E4, N.Gs4, N.B4],       bass: N.E2,      scale: [N.B4, N.Cs5, N.E5, N.Fs5, 830.61] },   // E — ここで調が飛ぶ
      { chord: [N.Cs4, N.E4, N.Gs4],      bass: N.Cs3 / 2, scale: [N.B4, N.Cs5, N.E5, N.Fs5, N.A5] },     // C#m
      { chord: [N.B3, N.Eb4, N.Fs4],      bass: N.B2,      scale: [N.B4, N.Cs5, 622.26, N.Fs5, 830.61] }, // B
      { chord: [N.D4, N.G4, N.F5, N.Bb4], bass: N.G2,      scale: [N.G4, N.Bb4, N.C5, N.D5, N.F5] },      // Gm7 — 何事もなかった顔で帰る
    ],
  },
  // 🧬 継ぎはぎ工房 — 別々のブロックを溶接する工房。ヘ長調リディアン（F–G–Am7）の
  // 明るい3小節に、最後だけ拾ってきた変ホ長調を縫い付ける（B♮→B♭ が継ぎ目）。
  // 音色も揃えない：三角パッド＋鋸歯アルペジオ＋正弦ベース＋三角の旋律。
  // ドラムも別々の型紙で、ハット 3-2-3-3-2-3・ベース5ステップ刻み・キックは 3 で
  // つまずく。キックとベースと arp が揃うのは頭だけ、15 だけ誰も踏まない。
  chimera: {
    bpm: 104, swing: 0, padType: 'triangle', padVol: 0.11, arpType: 'sawtooth',
    kick: [0, 3, 8], snare: [6, 12], hat: [1, 4, 6, 9, 12, 14], hatVol: 0.05, openHat: [13],
    bassSteps: [0, 5, 10], bassLen: 0.9, bassType: 'sine', bassVol: 0.36,
    arpSteps: [0, 2, 4, 7, 9, 11, 14], arpVol: 0.11, arpDelay: true, melody: 0.24,
    // chord は [5度, 根音, (7度,) 3度] の順。arp はこの順に鳴るので、どの小節も
    // 「5度下降 → 跳ね返り」で始まる。音数 4→3→4→3 に対し arpSteps は7個なので
    // f = chord[idx % chord.length] は 4音の小節で 0123|012 と途中で切れ、3音の小節で
    // 012|012|0 と1音余る（idx = arpSteps.indexOf(s) ＝ 小節ごとに 0 に戻るので、
    // 小節をまたぐズレは作れない）。E♭2/E♭5 は N に無いので N.Eb4 から作る。
    bars: [
      { chord: [N.C5, N.F4, N.E5, N.A4], bass: N.F2,      scale: [N.A4, N.C5, N.D5, N.E5, N.B5] },       // Fmaj7 — 旋律の B5 が伸びた和音の上で #4 になる
      { chord: [N.D5, N.G4, N.B4],       bass: N.G2,      scale: [N.A4, N.B4, N.D5, N.E5, N.G5] },       // G — リディアンを名乗る明るいII。B♮ が和音の中に居る
      { chord: [N.E5, N.A4, N.G5, N.C5], bass: N.A2,      scale: [N.A4, N.C5, N.E5, N.G5, N.B5] },       // Am7 — 7度は上へ。G4 を下に敷くと A4 と団子になってうなる
      { chord: [N.Bb4, N.Eb4, N.G4],     bass: N.Eb4 / 4, scale: [N.Bb4, N.C5, N.Eb4 * 2, N.F5, N.G5] }, // E♭ — 拾ってきた別部品。B♭ が前の小節の B♮ を打ち消す
    ],
  },
  // ⛓️ 転がる連鎖 — 消したラインが次を呼ぶカスケード。変ロ長調 Bb-Dm/A-Gm-F は表で唯一、
  // sine パッド + sawtooth アルペジオ + triangle ベース（フィルタ付き）も他に無い組み合わせ。
  // 和音を [高,低,中,最低] と並べ、arpOctave（arpSteps の奇数番目を1オクターブ上げる）と
  // 噛み合わせて、実際に鳴る音を F5-D5-Bb4-F4 の下降階段にしてある。和音4音 × arpSteps8個
  // なので階段は1小節に2回、4小節とも形は同じで床だけ一段ずつ下がっていく。
  chain: {
    bpm: 134, swing: 0, padType: 'sine', padVol: 0.10, arpType: 'sawtooth',
    kick: [0, 8, 11, 14], snare: [4, 12],
    // 8分ハットのうち 10 だけをオープンに。9-10 の休みの終わりで開き、下降へ雪崩れ込む。
    hat: [0, 2, 4, 6, 8, 12, 14], hatVol: 0.06, openHat: [10],
    // ベースは小節の中は同じ音の 3-3-2 連打。下がるのは小節が変わるときだけ ──
    // 転がっているのはアルペジオで、床を一段ずつ下げるのがベース。
    bassSteps: [0, 3, 6, 8, 11, 14], bassLen: 0.45, bassType: 'triangle', bassVol: 0.44, bassFilter: 900,
    // 間隔が 4-2-2 →（9,10 を休む）→ 1-1-1 と詰まり、2回目の最低音が step14 のキック＆
    // ベースと同時に着地して、次の小節の一段低い和音へ転がり込む。
    // stab はエンジンが bar.chord を同じ時刻に一斉に鳴らす塊なので、下降の途中に置くと
    // 階段を塗り潰す。小節頭に置いて、立ち上がりの遅い sine パッドに頭を与える役にする。
    arpSteps: [0, 4, 6, 8, 11, 12, 13, 14], arpVol: 0.10, arpDelay: true, arpOctave: true, stab: [0],
    bars: [
      { chord: [N.F5, N.D4, N.Bb4, N.F3], bass: N.Bb2 },  // Bb   → F5-D5-Bb4-F4
      { chord: [N.F5, N.D4, N.A4, N.F3],  bass: N.A2 },   // Dm/A → F5-D5-A4-F4
      { chord: [N.D5, N.Bb3, N.G4, N.D3], bass: N.G2 },   // Gm   → D5-Bb4-G4-D4
      { chord: [N.C5, N.A3, N.F4, N.C3],  bass: N.F2 },   // F    → C5-A4-F4-C4、床が一番下
    ],
  },
  // 📅 今日の一手 — デイリーチャレンジ。朝いちばんの盤面に、今日はみんなが
  // 同じ一手を置きにくる。F メジャーの I–IV–ii7–V を F3〜G5 に大きく開いて置き、
  // その四音をサインの鐘が下から上へ舐める（arpSteps 8個 ÷ chord 4音 ＝ 1小節に2周）。
  // 支えるのは丸いサイン波のベース、付点8分の 3+3+2（16分の連打ではない）。
  // スネアはゼロ、キックは3発だけ ── 勝負曲ではなく、朝の曲にする。
  daily: {
    bpm: 112, swing: 0.16, padType: 'square', padVol: 0.06, arpType: 'sine',
    kick: [0, 8, 14], snare: [], hat: [2, 3, 10, 11], hatVol: 0.05, openHat: [7],
    bassSteps: [0, 3, 8, 11], bassLen: 0.75, bassType: 'sine', bassVol: 0.44,
    arpSteps: [0, 2, 5, 7, 8, 10, 13, 15], arpVol: 0.16, arpDelay: true, melody: 0.12,
    // ⚠ 跳ねは **奇数ステップにしか乗らない**（scheduleAhead の stepInBar % 2 === 1）。
    //   ハットが 2-3 / 10-11 の「偶数＋奇数」の対なのはそのためで、後ろ側だけが
    //   遅れて「チッ・カ」と転がる。偶数だけに戻すと swing を書いても無音になる。
    //   ベースの 3/11、オープンハットの 7、アルペジオの 5/7/13/15 も同じ側。
    // ⚠ chord は pad と arp の**両方**が読む（scheduleStep）。1オクターブに固めると
    //   ベース（F2〜C3）との間が空いたまま pad が鐘のアタックを食うので、F3 から
    //   一音ずつ開き、いちばん上の一音だけを鐘に残した（bass との差は 7〜12半音）。
    //   scale は chord の上ではなく、開いた**真ん中**（F4〜F5）を通す。上へ抜くと
    //   melody（triangle 0.15 固定）が鐘より高く鳴って、主役を奪う。
    // ※ コード名は pad の積み方ではなく bass（＝耳に聞こえる低音）で読むこと。
    bars: [
      { chord: [N.F3, N.C4, N.A4,  N.G5], bass: N.F2,  scale: [N.F4, N.G4, N.A4, N.C5, N.D5] },  // Fadd9 — 朝の光
      { chord: [N.F3, N.D4, N.Bb4, N.F5], bass: N.Bb2, scale: [N.F4, N.G4, N.Bb4, N.C5, N.D5] }, // Bb（根音は Bb2。F は pad の最低声部）
      { chord: [N.G3, N.D4, N.Bb4, N.F5], bass: N.G2,  scale: [N.G4, N.Bb4, N.C5, N.D5, N.F5] }, // Gm7
      { chord: [N.G3, N.E4, N.C5,  N.G5], bass: N.C3,  scale: [N.G4, N.A4, N.C5, N.D5, N.E5] },  // C（同じく根音の C3）— さあどうぞ
    ],
  },
  // 🏆 今週の頂 — ウィークリーチャレンジ。デイリーの平行短調（ニ短調・♭1つ）へ
  // 重心を落とした 96BPM、i–III–iv–V。根音 D2→F2→G2→A2、和音の頂 D4→F4→G4→A4 と
  // 4小節かけて完全5度ぶん登る「積み上げ」。三角波アルペジオは付点8分（3/6/9/12）で
  // 根音→3度→5度→オクターブを1小節に1本、不均等なキック（0/5/8/13）とは一度も
  // 同じステップに来ない。ハットは前半8分4つ→後半16分8つ（末尾15はオープン）で倍、スネアは8だけ。
  weekly: {
    bpm: 96, swing: 0, padType: 'square', padVol: 0.05, arpType: 'triangle',
    kick: [0, 5, 8, 13], snare: [8],
    hat: [0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14], hatVol: 0.05, openHat: [15],
    bassSteps: [0, 5, 8, 13], bassLen: 0.7, bassType: 'sawtooth', bassVol: 0.55, bassFilter: 320, detune: 7,
    arpSteps: [3, 6, 9, 12], arpVol: 0.16, arpDelay: true, stab: [0],
    bars: [
      { chord: [N.D3, N.F3, N.A3, N.D4],  bass: N.D2 },  // Dm — 月曜、いちばん下から
      { chord: [N.F3, N.A3, N.C4, N.F4],  bass: N.F2 },  // F  — 一段
      { chord: [N.G3, N.Bb3, N.D4, N.G4], bass: N.G2 },  // Gm — もう一段
      { chord: [N.A3, N.Cs4, N.E4, N.A4], bass: N.A2 },  // A  — 今週の頂。導音 C# が来週の D を呼ぶ
    ],
  },
  // 🤝 二人の盤 — 協力プレイ。1〜2小節の「呼びかけ」を、3〜4小節でまるごと完全4度上へ
  // 移した「応答」にする（和音の積み方も音階もベースも、全音きっかり +5半音）。二人の声は
  // 16分の偶奇で分けてある ── 矩形波アルペジオは奇数だけで swing 0.15 のぶん後ろへもたれ、
  // 三角波メロディは偶数にしか出ない（エンジンの s % 2 === 0）ので、同じマスで喋らない。
  // ハイハットも奇数だけ。等間隔なので「跳ねる」のではなく一律に後ろへ寄る、ゆるい拍。
  coop: {
    bpm: 104, swing: 0.15, padType: 'sine', padVol: 0.09, arpType: 'square',
    kick: [0, 8, 11], snare: [4, 12], hat: [1, 3, 5, 7, 9, 11, 13], hatVol: 0.05, openHat: [15],
    // 2発目の 7 は拍3の16分先取り。奇数なので swing 側に落ち、もたれたまま前へ出る。
    bassSteps: [0, 7], bassLen: 1.6, bassType: 'sine', bassVol: 0.4,
    // 4個ちょうどで chord を1周（根音→3度→5度→7度/オクターブ）。6個や8個にすると
    // chord[arpSteps.indexOf(s) % chord.length] が回り込み、後半が前半の再演になる。
    arpSteps: [1, 5, 9, 13], arpVol: 0.15, arpDelay: true, melody: 0.3,
    bars: [
      { chord: [N.G3, N.B3, N.D4, N.G4],  bass: N.G2, scale: [N.G4, N.A4, N.B4, N.D5, N.E5] },   // G   ── 呼びかけ
      { chord: [N.B3, N.D4, N.Fs4, N.A4], bass: N.B2, scale: [N.Fs4, N.A4, N.B4, N.D5, N.Fs5] }, // Bm7 ── 4音目が7th（A4）
      { chord: [N.C4, N.E4, N.G4, N.C5],  bass: N.C3, scale: [N.C5, N.D5, N.E5, N.G5, N.A5] },   // C   ── 応答（完全4度上）
      { chord: [N.E4, N.G4, N.B4, N.D5],  bass: N.E3, scale: [N.B4, N.D5, N.E5, N.G5, N.B5] },   // Em7 ── 応答（完全4度上・7th は D5）
    ],
  },
  // 🏗 設計図の線 — その日の図案を、決まった手順どおりになぞる場所。和音は
  // 「根音・4度・5度・オクターブ」ひとつの形だけで、C→D→E→F と1小節ずつ
  // 平行に持ち上がる ── 定規の形は変えず、置く場所だけをずらしていく。乾いた
  // サイン波のアルペジオがその形を小節に2回ずつ上り、0.035の16分ハットが方眼紙。
  // ベースは常に和音の最低音の1オクターブ下、4分の等間隔＝目盛り。melody は無し。
  blueprint: {
    bpm: 104, swing: 0, padType: 'square', padVol: 0.05, arpType: 'sine',
    kick: [0, 8], snare: [12],
    hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hatVol: 0.035,
    bassSteps: [0, 4, 8, 12], bassLen: 0.9, bassType: 'triangle', bassVol: 0.4,
    arpSteps: [0, 2, 4, 6, 8, 10, 12, 14], arpVol: 0.16, arpDelay: false,
    // 根音は C3(131Hz) から F3(175Hz) まで。D2(73Hz) のような低い根音を1本でも
    // 混ぜると、その小節だけヘッドホンで膨らみ、ノートPCやスマホでは逆に
    // 目盛りが1本消える（80Hz以下は小さいスピーカーが出せない）。
    bars: [
      { chord: [N.C4, N.F4, N.G4, N.C5],  bass: N.C3 },   // Csus4 — 紙の左上、線を引き始める
      { chord: [N.D4, N.G4, N.A4, N.D5],  bass: N.D3 },   // Dsus4 — 同じ形のまま1段上げる
      { chord: [N.E4, N.A4, N.B4, N.E5],  bass: N.E3 },   // Esus4 — もう1段
      { chord: [N.F4, N.Bb4, N.C5, N.F5], bass: N.F3 },   // Fsus4 — B♭は平行移動の帰結。F3→C3 で左端に戻る
    ],
  },
  // 🔨 工房の朝 — 誰かが作った盤面を、木の台の上でひとつずつ直していく朝。
  // ヘ長調 F→Gm→B♭→C。根音 F2→G2→B♭2→C3 と、和音の最上声 F4→G4→B♭4→C5 が
  // 一緒に上がっていく（朝が明けていく）。ループの頭で C5→F4 と落ちて、また次の朝。
  // pad / arp / bass は全部 triangle ── 木と紙の手ざわり。melody もエンジン側で
  // triangle 固定なので実際は四点あり、濁らないよう鳴る高さで役を分けてある。
  workshop: {
    bpm: 126, swing: 0.14, padType: 'triangle', padVol: 0.09, arpType: 'triangle',
    kick: [0, 6, 8], snare: [4, 12], hat: [0, 3, 4, 7, 8, 11, 12], hatVol: 0.05, openHat: [15],
    // ベースは 3・11 ＝ 奇数ステップに置いてある。swing が掛かるのは奇数だけなので、
    // ここでハットだけでなく低音まで跳ねる。detune 6 は「うねり」ではなく厚み ──
    // bassLen 0.6 の音は 0.29秒しかなく、F2 の 6cent は周期3.3秒だから一周する前に
    // 消える。実際に起きるのは同波形オシレータが増えて実効1.5倍になることなので、
    // bassVol はそのぶん下げてある（0.32 × 1.5 ＝ 0.48。フィルタ無しの royal/solo/
    // kami の 0.5 とほぼ同じ重さ）。
    bassSteps: [0, 3, 8, 11, 14], bassLen: 0.6, bassType: 'triangle', bassVol: 0.32, detune: 6,
    // arpOctave: arpSteps の奇数番目（step 2/7/10/15）が1オクターブ上がり、低・高の
    // 交互になる（1小節目なら A3 C5 F4 A4 C4 F5 A3 C5）。これが無いと pad と同じ波形・
    // 同じ音・同じ高さで、arp が pad の打ち直しにしか聞こえない。swing が乗る 7/15 も
    // 上の音になるので、跳ねが低音に埋もれない。
    arpSteps: [0, 2, 4, 7, 8, 10, 12, 15], arpVol: 0.15, arpDelay: true, arpOctave: true, melody: 0.24,
    bars: [
      // chord は転回した配置だが bass は根音のまま ── 鳴っているのは F/Gm/B♭/C であって
      // 分数コードではない。bass を A2/B♭2 に“直す”と上昇線 F2→G2→B♭2→C3 が壊れる。
      // scale（melody）は pad より上の C5〜A5。トライアングル同士の団子を避けるため。
      { chord: [N.A3, N.C4, N.F4],  bass: N.F2,  scale: [N.C5, N.D5, N.F5, N.G5, N.A5] },   // F（A-C-F の配置）— 作業台に朝日
      { chord: [N.Bb3, N.D4, N.G4], bass: N.G2,  scale: [N.Bb4, N.C5, N.D5, N.F5, N.G5] },  // Gm（B♭-D-G の配置）
      { chord: [N.D4, N.F4, N.Bb4], bass: N.Bb2, scale: [N.Bb4, N.C5, N.D5, N.F5, N.A5] },  // B♭ — 光が高くなる（melody の A で B♭maj7 に色づく）
      { chord: [N.E4, N.G4, N.C5],  bass: N.C3,  scale: [N.C5, N.D5, N.E5, N.G5, N.A5] },   // C — ひと仕事が一周する
    ],
  },
  // 🚩 陣取り — 区画を奪い合う行進曲。ト短調112BPM・8小節。攻めの4小節は和音が4音でラッパが
  // 根→3度→5度→8va と登り切らずに次へこぼれ、引きの2小節は3音に痩せて三和音を2周し小節内で
  // 収まる（頂点 G4→G4→C5→D5｜F4→F4→C5→D5／最低音は全小節 G3〜D4、arpOctave は使わない）。
  // 刻みは付点3+1 ── arp が 0,3,4/8,11,12、hat はそこに 7,15 を足した8つ。pad は square で、
  // battle / hard の sawtooth 族から音色を離した、リードオルガンめいた楽隊の鳴りにしてある。
  land: {
    bpm: 112, swing: 0, padType: 'square', padVol: 0.06, arpType: 'square',
    kick: [0, 8, 10], snare: [4, 6, 12, 14, 15],
    hat: [0, 3, 4, 7, 8, 11, 12, 15], hatVol: 0.05,
    bassSteps: [0, 4, 8, 12], bassLen: 0.5, bassType: 'square', bassVol: 0.46, bassFilter: 800, detune: 12,
    arpSteps: [0, 3, 4, 8, 11, 12], arpVol: 0.12, arpDelay: false, stab: [0, 14],
    bars: [
      // 攻め — 4音。arp の idx 0..5 が 根・3度・5度・8va・根・3度 になり、
      // 登り切る前に小節が終わる＝そのまま次の一手へ押し出される。
      { chord: [N.G3, N.Bb3, N.D4, N.G4],  bass: N.G2 },       // Gm — 自陣から
      { chord: [N.G3, N.Bb3, N.Eb4, N.G4], bass: N.Eb4 / 4 },  // E♭ — 動くのは内声の D4→E♭4 だけ（根音 E♭2 は N に無い）
      { chord: [N.C4, N.Eb4, N.G4, N.C5],  bass: N.C2 },       // Cm — 隊列ごと一歩前へ
      { chord: [N.D4, N.Fs4, N.A4, N.D5],  bass: N.D2 },       // D — 導音 F♯ まで押し切る
      // 引き — 3音。arp は 根・3度・5度 をちょうど2周して小節内で収まり、
      // 8va に届かない＝音域も厚みも自動で痩せる。ベースも上がって重さが抜ける。
      { chord: [N.Bb3, N.D4, N.F4],        bass: N.Bb2 },      // B♭ — F♯→F♮ に落ちて取り返される
      { chord: [N.A3, N.C4, N.F4],         bass: N.F2 },       // F — 上声部を保ったまま内声が1段下がる
      // 押し返し — 3・4小節目と同じ切り返しで4音に戻る。
      { chord: [N.C4, N.Eb4, N.G4, N.C5],  bass: N.C2 },       // Cm — もう一度前へ
      { chord: [N.D4, N.Fs4, N.A4, N.D5],  bass: N.D2 },       // D — Gm へ帰る
    ],
  },
  // 🤝 肩を並べて — チーム戦(2v2)。イ長調の行進讃歌。和音も上声も低音も
  // A→B→C#→D と一段ずつ**同時に**上がる（平行進行は狙い ── 直すと主題が消える）。
  // 誰も先に行かない、が主題。四つ打ちは使わず、ハットが各拍を
  // 16分・16分・8分＝「タタッ・タン」で刻む。ベースの6発は全部キックかスネアと
  // 重なっていて、単独で鳴る足音がひとつも無い ── いつも2人ぶん揃って踏む。
  team: {
    // 音色は square パッド＋triangle アルペジオ＋triangle ベース。この3点セットは
    // 既存18曲のどれとも一致しない（square パッドは pixel だけ、あちらは3つとも square）。
    bpm: 115, swing: 0, padType: 'square', padVol: 0.07, arpType: 'triangle',
    kick: [0, 6, 8, 14], snare: [4, 12], hat: [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14], hatVol: 0.05, openHat: [7, 15],
    // bassFilter は付けない。エンジンは detune 側の第2オシレータを lowpass に通さず
    // musicGain へ直結するので、フィルタを足すと2枚の音色がずれる。7セントのうねりは
    // A2 でおよそ2秒に1回 ── これが「肩を並べた2人ぶん」の厚み。
    bassSteps: [0, 4, 6, 8, 12, 14], bassLen: 0.5, bassType: 'triangle', bassVol: 0.46, detune: 7,
    // arpOctave は付けない。和音4声に対して arpSteps が8個＝割り切れるので、
    // `idx % 2` の判定が毎周おなじ度数に当たり、3度と最高音だけが上がる固定形になる
    // （行進の線が消えて機械的なジグザグになる）。付けなければ 根音→3度→5度→
    // オクターブ の上行が1小節に2回。裏に置いた8音は、共有ディレイ0.27秒
    // （115BPMで16分2.07個＝ほぼ8分）の残響が残り8ステップにちょうど落ちて埋まる。
    arpSteps: [1, 2, 5, 6, 9, 10, 13, 14], arpVol: 0.12, arpDelay: true, stab: [0, 6],
    bars: [
      // I–ii–iii–IV の上り階段。使い古された I–vi–IV–V（menu/solo/royal/blast系）とも、
      // 同じイ長調の kami（A–F#m–D–E / 150 / 四つ打ち）とも別物。最後は IV→I で頭へ戻る。
      { chord: [N.A3, N.Cs4, N.E4, N.A4],   bass: N.A2 },   // A — 隊列を組む
      { chord: [N.B3, N.D4, N.Fs4, N.B4],   bass: N.B2 },   // Bm — 一段上がる
      { chord: [N.Cs4, N.E4, N.Gs4, N.Cs5], bass: N.Cs3 },  // C#m — もう一段
      { chord: [N.D4, N.Fs4, N.A4, N.D5],   bass: N.D3 },   // D — 頂きから、また A へ
    ],
  },
  // 🏆 勝ち上がり — トーナメントの階段。根音が Bb→D→Eb→F→G と一段ずつ上がり、
  // Eb→F7 で助走して、最後は1オクターブ上の Bb へ着地＝優勝（8小節目のベースと
  // 和音は1小節目のちょうど2倍）。毎小節おしまいの16分ロール（スネア14,15）が
  // 次の一戦を煽り、stab がファンファーレ。テンポの近い rush(164/Gm)・
  // meltdown(158/Bbm) とは、長調・triangle のアルペジオとベース・8分の薄いハットで離す。
  tourney: {
    bpm: 160, swing: 0, padType: 'square', padVol: 0.04, arpType: 'triangle',
    kick: [0, 8, 10], snare: [4, 12, 14, 15], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatVol: 0.05, openHat: [6],
    bassSteps: [0, 4, 8, 12], bassLen: 0.9, bassType: 'triangle', bassVol: 0.45, detune: 7,
    // 16分3つ×4組。3音の和音では chord[idx % chord.length] の idx が 0,1,2,0,1,2… と
    // 回るので、1拍がそのまま駆け上がりになる（4音の7小節目だけ拍をまたぐ ── 下記）。
    // arpOctave は使わない ── 奇数番だけ2倍になって音域が上下し、拍ごとの上りが埋もれる。
    arpSteps: [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14], arpVol: 0.11, arpDelay: true,
    stab: [0, 12], melody: 0.15,
    // scale は必ず上行で書く。低い方へ折り返すと melody が毎回そこから拾うので、
    // 段を上がるはずの小節が前の小節より低く鳴る。Eb5/Bb5/C6/D6/Eb6/F6 は N に無い
    // ので N.Eb4 * 2 のように倍・半で書く（表に無い名前は undefined ＝その1音だけ無音）。
    bars: [
      // ── 準々決勝
      { chord: [N.Bb3, N.D4, N.F4],  bass: N.Bb2,     scale: [N.Bb4, N.D5, N.F5, N.G5] },              // Bb  一段目
      { chord: [N.D4, N.F4, N.A4],   bass: N.D3,      scale: [N.D5, N.F5, N.G5, N.A5] },               // Dm  二段目
      { chord: [N.Eb4, N.G4, N.Bb4], bass: N.Eb4 / 2, scale: [N.Eb4 * 2, N.F5, N.G5, N.Bb4 * 2] },     // Eb  三段目
      // ── 準決勝
      { chord: [N.F4, N.A4, N.C5],   bass: N.F3,      scale: [N.F5, N.G5, N.A5, N.C5 * 2] },           // F   四段目
      { chord: [N.G4, N.Bb4, N.D5],  bass: N.G3,      scale: [N.G5, N.Bb4 * 2, N.C5 * 2, N.D5 * 2] },  // Gm  五段目・階段の頂上
      // ── 決勝
      { chord: [N.Eb4, N.G4, N.Bb4], bass: N.Eb4 / 2, scale: [N.Eb4 * 2, N.G5, N.Bb4 * 2, N.C5 * 2] }, // Eb  一段下りて助走
      // ため。第7音 Eb は chord にも入れる ── pad/stab/arp が読むのは chord だけなので、
      // scale だけだと属七がどこからも鳴らず、4小節目の F と同じ音になる。ここだけ4音で
      // アルペジオが拍をまたいで回り（349-440-523｜622-349-440｜523-622-349｜440-523-622）、
      // 決勝直前の1小節が落ち着かないまま Eb で終わる。
      { chord: [N.F4, N.A4, N.C5, N.Eb4 * 2], bass: N.F3, scale: [N.F5, N.A5, N.C5 * 2, N.Eb4 * 4] },  // F7  ため
      // 優勝。ベースも和音も1小節目のちょうど2倍（116.54→233.08 / 233.08→466.16）。
      // 3音のままにして、最後の1小節まで毎拍の駆け上がりを崩さない。
      { chord: [N.Bb4, N.D5, N.F5],  bass: N.Bb3,     scale: [N.Bb4 * 2, N.C5 * 2, N.D5 * 2, N.F5 * 2] }, // Bb  優勝
    ],
  },
  // 🐉 総力戦 — レイド: 全員で1体の巨影を削る行進。ト短調・96BPM の重い歩幅。
  // kick・hat・riff が同じ 0,3,4,8,11,12 を踏む＝大勢の足音が揃う。
  // stab（エンジンの stab は常に saw）は 0,4,8 の3回だけ。4拍目は攻撃せず、
  // square のアルペジオ（2,6,10 と小節後半の 12,14）に明け渡す＝味方の呼応。
  // 低域は riff と G1 ドローンの専有。和音は D4–C5 に開き、pad は triangle。
  raid: {
    bpm: 96, swing: 0, padType: 'triangle', padVol: 0.10, arpType: 'square',
    kick: [0, 3, 4, 8, 11, 12], snare: [4, 12, 14],
    hat: [0, 3, 4, 8, 11, 12, 15], hatVol: 0.05, openHat: [7],
    // bassVol は 0.5。0.6 のままだと キック6発が riff と完全ユニゾンで重なるうえに、
    // detune の第2オシレータ（bassNote を見ると分かるとおりフィルタを通らず素通し）が
    // 上乗せされ、既定音量でもマスターリミッター（-6dB）に届いてしまう。
    // bassFilter は既存で最も暗い 300 のまま（mine の 380 とも別値）。原因は音量のほう。
    bassType: 'sawtooth', bassVol: 0.5, bassFilter: 300, detune: 12,
    riff: { 0: N.G2, 3: N.G2, 4: N.G2, 7: N.Bb2, 8: N.G2, 11: N.G2, 12: N.C3, 14: N.D3 },
    drone: N.G2 / 2, stab: [0, 4, 8],
    // arp は chord[arpSteps.indexOf(s) % 3] なので毎小節 chord[0],[1],[2],[0],[1]。
    // 12 で figure が振り出しに戻り、返しのまま次の小節へ踏み出す。
    arpSteps: [2, 6, 10, 12, 14], arpVol: 0.09, arpDelay: true,
    // riff がある曲では engine は bar.bass を読まない（riff が勝つ）。この欄は
    // test/tracks.test.mjs の B-1 が要求するので、鳴らないことを承知で根音を書く。
    // 実際に鳴っている低音は riff の G ペダルなので、和音は下の転回形で聞こえる。
    bars: [
      { chord: [N.D4, N.G4, N.Bb4],  bass: N.G2 },    // Gm — 隊列が組み上がる
      { chord: [N.Eb4, N.G4, N.Bb4], bass: 77.78 },   // Eb/G — 影が覆いかぶさる（Eb2 は N に無いので生値）
      { chord: [N.Eb4, N.G4, N.C5],  bass: N.C2 },    // Cm/G — 影が動く
      { chord: [N.D4, N.F4, N.Bb4],  bass: N.Bb1 },   // Bb／G ペダル上では Gm7 — F4 が開いて息を継ぐ
    ],
  },
  // 👊 連戦 — ボスラッシュ。164BPM、Gマイナー。まっすぐな8分のベースの上を
  // キックが 3-4-3-3-3 で転び、付点8分のアルペジオが1音も重ならずに斜めへ走る。
  // 拍頭で太鼓が着地するのは 0 と 4 だけで、8 と 12 は穴のまま。和音は
  // Gm→E♭→F→F♯dim7 と重心を上げ続け（241→247→277→291Hz）、ベースが
  // F2→F♯2→G2 と半音で駆け上がって、休む間もなく次の Gm へ蹴り戻す。
  rush: {
    bpm: 164, swing: 0, padType: 'triangle', padVol: 0.09, arpType: 'sawtooth',
    // step 8 を踏まないのが肝。スネアも 12 ではなく 14 で、4拍目の裏打ちが
    // 8分ぶん遅れて転ぶ。オープンハットは 9 と 12 ── キックもスネアも無い穴に
    // 置いて、床が抜けていることをそこで聞かせる。
    kick: [0, 3, 7, 10, 13], snare: [4, 14],
    hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hatVol: 0.06, openHat: [9, 12],
    // 唯一まっすぐな層。0.38（＝0.14秒）で毎回切るので8分ごとに隙間ができる。
    // detune は付けない ── 14cent の唸りは周期1.26秒で、この長さでは立つ前に
    // 音が終わり、実質ただの音量増しにしかならない。
    bassSteps: [0, 2, 4, 6, 8, 10, 12, 14], bassLen: 0.38,
    bassType: 'square', bassVol: 0.55, bassFilter: 420,
    // 付点8分を step 2 から。16 は 3 で割り切れないので毎小節ぶつ切りにされ、
    // キック [0,3,7,10,13] とは1音も重ならない。stab も 8 ではなく 11 に置いて、
    // 来ない4拍目の手前で和音を突き出す。
    arpSteps: [2, 5, 8, 11, 14], arpVol: 0.10, arpDelay: true, arpOctave: true, stab: [0, 11],
    // ⚠ chord の**並び順がそのままアルペジオの形**になる（chord[idx % 音数]、
    //    idx が奇数なら1オクターブ上）。3音の小節は [0]→[1]↑→[2]→[0]↑→[1]、
    //    4音の最終小節だけ [0]→[1]↑→[2]→[3]↑→[0] に変わって曲中の最高音
    //    F♯5(740Hz) まで跳ね上がる ── ループの継ぎ目がそこだけフィルになる。
    bars: [
      { chord: [N.G3, N.Bb3, N.D4],         bass: N.G2 },       // Gm
      { chord: [N.G3, N.Bb3, N.Eb4],        bass: N.Eb4 / 4 },  // E♭/G — D4→E♭4 の半音だけ動く（bass は E♭2 = 77.78Hz）
      { chord: [N.A3, N.C4,  N.F4],         bass: N.F2 },       // F/A — 3声そろって全音上へ
      { chord: [N.A3, N.C4,  N.Eb4, N.Fs4], bass: N.Fs3 / 2 },  // F♯dim7/A — F4→F♯4 の半音、増えた E♭4 は次の D4 へ落ちる
    ],
  },
  // 👁 断罪 — ゼロの卓（管理者イベント）。感情のない機械の儀式。G1 のペダル音の上を
  // 根音が半音ずつ Cs→C→B→Bb と降りる＝判決文が1行ずつ読み上げられていく。和音は
  // 三全音と空虚五度だけで長三度が無く、表情が出ない（3小節目だけペダルの G と和音の
  // B が長三度になるが、次が C ではなく Bb なので属七として解決しない。ペダル点の
  // 副産物として許容している）。根音は1行読んで黙り、あとはペダルだけが残る。
  zero: {
    bpm: 66, swing: 0, padType: 'triangle', padVol: 0.09, arpType: 'sine',
    // hat は刺し(0,8)の2ステップ前＝機械が振りかぶる予備動作。[4,12] は ruins と
    // 同じ位置なので裏の8分へ。0.04 は既存の最小帯（ghost 0.03 / ruins 0.04）で、
    // この曲で拍を刻む音はこれだけ（0.028 だと既存のどの曲より小さく聴こえない）。
    kick: [0, 8], snare: [], hat: [6, 14], hatVol: 0.04,
    // ⚠ 根音は chord の根音のちょうど1オクターブ下（Cs3〜Bb2）に置くこと。ドローンの
    //   G1(49Hz) と同じオクターブまで下ろすと差が 3〜6半音になり、9〜20Hz のうなりで
    //   低音が団子になったうえ、主役の半音下降が音程として聴き取れなくなる。
    //   bassLen 1.75 は小節の44%。残りは黙る＝1行読んでから間が空く。
    bassSteps: [0], bassLen: 1.75, bassType: 'square', bassVol: 0.32, bassFilter: 380,
    // melody はエンジン側で音量 0.15 固定（scheduleStep）。scale を各小節1音に絞って
    // あるので「音程は毎回同じ・鳴る時だけ不定」＝機械が決まった信号を気まぐれに出す
    // 音になる。scale に音を足すと気ままなリードになり、無表情が壊れる。
    arpSteps: [2, 7, 11], arpVol: 0.12, arpDelay: true, arpOctave: true, melody: 0.08,
    drone: N.G2 / 2, stab: [0, 8],
    // scale は根音のちょうど3オクターブ上（1109→1046→988→932Hz）。同じ半音下降を、
    // 小さいスピーカーでも聴こえる高さでもう一度なぞる。どれも和音構成音で三度は無い。
    bars: [
      { chord: [N.Cs4, N.G4, N.Cs5],  bass: N.Cs3, scale: [N.Cs6] },      // Cs+三全音 — 罪状
      { chord: [N.C4,  N.G4, N.C5],   bass: N.C3,  scale: [N.C5 * 2] },   // C 空虚五度 — 沈黙
      { chord: [N.B3,  N.F4, N.B4],   bass: N.B2,  scale: [N.B5] },       // B+三全音 — 判決
      { chord: [N.Bb3, N.F4, N.Bb4],  bass: N.Bb2, scale: [N.Bb4 * 2] },  // Bb 空虚五度 — 執行
    ],
  },
  // 👑 運営の舞台 — 運営が開く祭りであり、同時に儀式。ヘ長調・8小節、Gm7→C7→F で閉じる。
  // pad は triangle の膨らみ、arp は square のファンファーレ（和音4音 × arpSteps 8個で
  // 根音→3度→5度→頂点を1小節に2周）。キックの 0,3,8,11 は 3-3-2 の骨で、抜けた 6/14 はベースが踏む。
  // stab の 4/12 は2・4拍のバックビート（音色はエンジン側で sawtooth 固定。square にはならない）。
  // scale は melody が確率で1音引く袋で、順序は音にならない ── 昇順に書き、和音の長7度は入れない。
  arena: {
    bpm: 120, swing: 0.08, padType: 'triangle', padVol: 0.13, arpType: 'square',
    kick: [0, 3, 8, 11], snare: [4, 12], hat: [2, 5, 6, 10, 13, 14], hatVol: 0.06, openHat: [7, 15],
    bassSteps: [0, 3, 6, 8, 11, 14], bassLen: 0.55, bassType: 'triangle', bassVol: 0.5,
    arpSteps: [0, 3, 4, 7, 8, 11, 12, 14], arpVol: 0.11, arpDelay: true, melody: 0.16,
    stab: [4, 12],
    bars: [
      { chord: [N.F4, N.A4, N.C5, N.F5],   bass: N.F2,  scale: [N.C5, N.D5, N.F5, N.G5, N.A5] },   // F — 開幕
      { chord: [N.Bb3, N.D4, N.F4, N.Bb4], bass: N.Bb2, scale: [N.Bb4, N.C5, N.D5, N.F5, N.G5] },  // B♭
      { chord: [N.C4, N.E4, N.G4, N.C5],   bass: N.C3,  scale: [N.C5, N.D5, N.E5, N.G5, N.A5] },   // C
      // Dm — まだ終わらせない。C を外す（入れると1小節目の F と音の袋が完全に同じになり、
      // melody はランダム抽選なので前半の折り返しが聞き分けられなくなる）。
      { chord: [N.D4, N.F4, N.A4, N.D5],   bass: N.D3,  scale: [N.D5, N.F5, N.G5, N.A5] },
      // ここから後半。頂点音が Bb4→A4→G4 と下りるので、scale も G4 起点に一段落として音域をそろえる。
      { chord: [N.Bb3, N.D4, N.F4, N.Bb4], bass: N.Bb2, scale: [N.G4, N.Bb4, N.C5, N.D5, N.F5] },  // B♭
      { chord: [N.A3, N.C4, N.F4, N.A4],   bass: N.A2,  scale: [N.G4, N.A4, N.C5, N.D5, N.F5] },   // F/A — 行列が下りる（E は入れない）
      { chord: [N.Bb3, N.D4, N.F4, N.G4],  bass: N.G2,  scale: [N.G4, N.Bb4, N.D5, N.F5, N.G5] },  // Gm7
      { chord: [N.C4, N.E4, N.G4, N.Bb4],  bass: N.C3,  scale: [N.G4, N.Bb4, N.C5, N.D5, N.E5] },  // C7 — 頭の F へ引き戻す
    ],
  },
  // 🎞 他人の走り — 自分は操作しない。観客席の距離で、他人の手つきを眺めている時間。
  // 変ホ長調の8小節。終止は B♭sus4 のまま解決させない＝話が自分のところで完結しない。
  // 動かないのはベースではなく和音の底。chord[0] は8小節中5小節が E♭4、残り3小節が F4。
  // 根音は5音を行き来する（向こう側では話が進んでいる）が、底が動かないので景色が寄ってこない。
  // 打楽器はキック2発とハットだけ。arp は小節頭(0)を踏まず pad と同じ4音を下から上へ一度撫でる。
  replay: {
    bpm: 90, swing: 0, padType: 'sine', padVol: 0.16, arpType: 'sine',
    // 頭の 0 は和音の変わり目の錨。心拍に聞こえるのは bass(9)→kick(10) の対のほう
    // （90BPM の16分＝167ms で、S1-S2 の間隔に近い）。
    kick: [0, 10], snare: [], hat: [4, 12], hatVol: 0.035, openHat: [14],
    // bassLen 2.4 ＝ 4×2.4 ＝ 9.6ステップ。0 の音が 9 の音に届き、9 の音は小節線を
    // 2.6ステップまたぐので低音が途切れない。1.6（6.4ステップ）だと 6.4〜9 と
    // 15.4〜16 に穴が空き、2音は一度も重ならなかった。
    bassSteps: [0, 9], bassLen: 2.4, bassType: 'sine', bassVol: 0.42,
    // arpSteps 4個 × chord 4音 → idx 0,1,2,3 がそのまま chord[0..3]。間隔 4,3,5 は不揃い。
    arpSteps: [3, 7, 10, 15], arpVol: 0.13, arpDelay: true, melody: 0.14,
    // 77.78=E♭2 / 103.83=A♭2 / 415.3=A♭4 / 622.25=E♭5 / 932.33=B♭5。変ホ長調なので
    // A♭ と綴りたいが N には G♯ 名（N.Gs4）しか無い。boss が N.Eb4 のある今でも
    // 311.13 / 415.3 を直書きしているのと同じ様式で、この曲も数値で書く。
    bars: [
      { chord: [N.Eb4, N.G4, N.Bb4, N.D5],  bass: 77.78,  scale: [N.Bb4, N.C5, N.D5, 622.25, N.G5] },  // E♭maj7
      { chord: [N.Eb4, N.G4, N.Bb4, N.C5],  bass: N.C2,   scale: [N.Bb4, N.C5, N.D5, 622.25, N.G5] },  // Cm7 — 和音は D5→C5 の1音しか動かない
      { chord: [N.F4, 415.3, N.C5, 622.25], bass: N.F2,   scale: [N.C5, N.D5, 622.25, N.F5, N.G5] },   // Fm7（scale の D♮ は13度＝Fドリアン）
      { chord: [N.F4, N.Bb4, N.C5, 622.25], bass: N.Bb2,  scale: [N.Bb4, N.C5, 622.25, N.F5, N.G5] },  // B♭sus4 — 解決しない。長3度の D は scale にも置かない
      { chord: [N.Eb4, N.G4, N.Bb4, N.D5],  bass: 77.78,  scale: [N.G4, N.Bb4, N.C5, N.D5, N.G5] },   // E♭maj7 — step15 の arp(D5) が次の頭に食い込み A♭ の♯11になる
      { chord: [N.Eb4, 415.3, N.C5, N.G5],  bass: 103.83, scale: [N.C5, 622.25, N.F5, N.G5, 932.33] }, // A♭maj7 — 唯一の持ち上がり。932.33 は和音の頂点 G5 より上
      { chord: [N.Eb4, N.G4, N.Bb4, N.C5],  bass: N.C2,   scale: [N.Bb4, N.C5, N.D5, 622.25, N.G5] },  // Cm7
      { chord: [N.F4, N.Bb4, N.C5, 622.25], bass: N.Bb2,  scale: [N.G4, N.Bb4, N.C5, 622.25, N.F5] },  // B♭sus4 — D を外し天井も F5 まで下げ、宙に浮いたまま頭へ戻る
    ],
  },
  // 🌌 創造神 — 神(kami 150)の上に立つ相手。速さを捨て、静けさと圧で押す。
  // F♯1(46.25Hz)のドローンが4つの和音すべての下に居座り、和音は下3音を低〜中域に
  // 固めて4音目だけ遥か上に置く。arpSteps [0,6,11,14] は和音の4音と1対1なので、
  // 毎小節「低→中→高」と踏んでから 14 で遠い高音が返る ── pad と drone は
  // 小節の末尾（7〜8割）から薄くなるので、その1音はちょうど空いた場所に落ちる。
  souzou: {
    bpm: 58, swing: 0, padType: 'sine', padVol: 0.17, arpType: 'triangle',
    // hat は空。hatVol は openHat の音量にも使われる（hat(when, true, hatVol * 1.4)）ので死んでいない。
    kick: [0, 8, 11], snare: [], hat: [], hatVol: 0.03, openHat: [4, 14],
    // ⚠ detune は付けないこと。bassNote() は本体だけをローパスに通し（osc→lp→g）、
    //   detune 側は o2→g2 で musicGain に直結する。boss/oni/mine は riff＝0.2秒の
    //   刺しなので気にならないが、この曲のベースは小節いっぱい鳴り続けるので、
    //   フィルタを通らないノコギリ波が鳴りっぱなしになり bassFilter 240 が無意味になる。
    // ⚠ bassLen は 4。env() は指数減衰で、1ステップあたり bassLen 2 は約 -9.4dB、
    //   4 は約 -4.7dB。2 だと4ステップ（約1秒）で -37dB まで落ちて次の音まで低音が
    //   消える。4 なら次の音が入るところでちょうど落ち切る（それ以上伸ばすと、
    //   前の小節の根音が新しい和音の下に残る）。
    bassSteps: [0, 8], bassLen: 4, bassType: 'sawtooth', bassVol: 0.55, bassFilter: 240,
    arpSteps: [0, 6, 11, 14], arpVol: 0.12, arpDelay: true, melody: 0.12,
    // stab は bar.chord を全部叩くので、遠い4音目もステップ0で一度鳴る。14 はその
    // 音の初出ではなく、三角波1音＋ディレイでの再登場。
    drone: N.Fs3 / 4, stab: [0],
    // ベースはドローンの1オクターブ上（F♯2 / D3 / B2 / E3）。D2/B1/E2 だと 46.25Hz と
    // 15〜36Hz しか離れず、持続音どうしが和音ではなく唸りになる。しかも bassFilter は
    // Q6 で 384→120Hz へ落ちるので、B1 はどのみち第2倍音が持ち上がって B2 に聞こえる。
    bars: [
      { chord: [N.Fs3, N.A3, N.Cs4, N.Cs6], bass: N.Fs3 / 2, scale: [N.Fs5, N.A5, N.B5, N.Cs6, N.E6] }, // F♯m — ドローンが根音。4小節で唯一の基本形＝ここだけが家
      { chord: [N.Fs3, N.A3, N.D4, N.A5],   bass: N.D3,      scale: [N.D5, N.Fs5, N.A5, N.Cs6, N.E6] }, // D — ドローンが3度。D/F♯ の第1転回で浮く
      { chord: [N.Fs3, N.B3, N.D4, N.Fs5],  bass: N.B2,      scale: [N.D5, N.E5, N.Fs5, N.A5, N.B5] },  // Bm — ドローンが5度。Bm/F♯ でいちばん座りが悪い
      { chord: [N.E3, N.B3, N.Gs4, N.E6],   bass: N.E3,      scale: [N.E5, N.Fs5, N.B5, N.Cs6, N.E6] }, // E — ドローンが9度。V が無いので終止せず環へ戻る
    ],
  },

  // ---- v2.65: ダンジョンのフロア（バンド）専用曲 --------------------------
  // 39フロアが5曲を回していて、苔の洞窟と忘れられた坑道が同じ曲だった。
  // 場所の曲なので、モードの曲とは別の棚に置く（ジュークボックスの group も別）。
  // 🦴 静寂の墓所 — 亡霊の城・骨の回廊・静寂の墓所と、深淵の嘆きの回廊・狂気の鏡殿。
  // 80BPM、Fs フリジアン。四つ打ちのキックは踊りではなく石床の足音（80BPMは歩調そのもの）。
  // スネアも閉じハットも置かず、裏のオープンハットだけが回廊の反響として残り、その16分
  // あとにアルペジオがこだまで返る。ghost(76・オルゴール・拍がほぼ無い)に対し、こちらは
  // 拍が歩いている。怖がらせにこない、ただ埃っぽくて寂しい。
  crypt: {
    // padVol: square の和音は pad() が1音につき2オシレータ立て、pad 側に lowpass は
    // 無い。スネア無し・ハット2発・arp 4発のこの薄さで 0.055 まで上げると「石造りの
    // オルガン」ではなくブザーに倒れる（明るい波形のパッドは saw 0.04〜0.05、
    // square は pixel の 0.035）。
    bpm: 80, swing: 0.08, padType: 'square', padVol: 0.04, arpType: 'triangle',
    // 閉じハットは置かない。hat[2,10] を足すと裏拍が {2,6,10,14} で全部埋まり、
    // blastGame / blastVs / blastGod と同じ裏8分の普通のノリになる。この曲で唯一
    // 18曲に無い「四つ打ちなのにスネアが無い」が、それだと聞こえなくなる。
    // hat が空でも hatVol は要る（openHat が hatVol*1.4＝0.063 で鳴る）。
    kick: [0, 4, 8, 12], snare: [], hat: [], hatVol: 0.045, openHat: [6, 14],
    // ⚠ bassFilter は detune 側のオシレータには掛からない（bassNote は o2 を
    //   musicGain へ直結する）。triangle は倍音が薄いので今回は結果的に狙いどおり
    //   だが、「両方に効いている」前提で 300 をいじると破綻する。
    bassSteps: [0, 8], bassLen: 1.7, bassType: 'triangle', bassVol: 0.4, bassFilter: 300, detune: 6,
    // arp は4本とも奇数ステップ。swing は奇数16分にしか効かず、この曲は arp 以外が
    // 全部偶数なので、swing 0.08 は arp 4本を一律 15ms 遅らせるだけ＝4本が揃って
    // 後ろに転ぶ。15 は openHat[14] の16分あと＝ハットの返事で、小節線を跨いで
    // 次の足音(step 0)へ倒れ込む。14 に置くと openHat と同時に鳴って返事にならず、
    // しかも偶数なのでその1本だけ swing が乗らない。
    arpSteps: [3, 7, 11, 15], arpVol: 0.13, arpDelay: true, arpOctave: true, melody: 0.14,
    // ⚠ 進行は i→bVI→bvii→bII。bII(G) を **ループの継ぎ目** に置くのが肝で、
    //   G→Fsm でベースが G2(98) → Fs2(92.5) と半音落ちる一回がフリジアンの正体。
    //   i→bII→bvii→bVI（Fsm→G→Em→D）に並べ替えると後半 G–Em–D が D major の
    //   IV–ii–I に化け、曲中の最低音 D2 に着地して royal / blastGod と同じ
    //   D major の3曲目に聞こえる。順番は触らないこと。
    // ⚠ アルペジオは scale ではなく chord を読む（scheduleStep の
    //   `bar.chord[idx % bar.chord.length]`、arpOctave は idx が奇数の音だけ ×2）。
    //   和音を4音＝根音・3度・5度・オクターブにしてあるので arpSteps 4本と噛み合い、
    //   どの小節も 根音→3度(8va)→5度→根音(2oct) の同じ音形になる
    //   （185→440→277→740 / 147→370→220→587 / 165→392→247→659 / 196→494→294→784Hz）。
    //   三和音のままだと4本目が根音の1オクターブ上（bar1 なら 370Hz）に落ちて square
    //   パッドの帯に埋まり、arpDelay でさらに団子になる。
    // ⚠ ベースは4小節ともその和音の最低音のちょうど1オクターブ下。
    // scale は melody の抽選表。全部 Fs フリジアン {Fs,G,A,B,Cs,D,E} から5音ずつ。
    bars: [
      // Fsm（i）。scale の G4 が b2 ＝ この曲の匂い。pad の Fs4(370) と短2度でぶつかる
      // が、pad の1音は padVol/4 を2本で 0.02、melody は固定 0.15。軋みではなく古い
      // オルガンの唸りとして残る（狙い）。ここを外すとただの Fsm になる。
      { chord: [N.Fs3, N.A3,  N.Cs4, N.Fs4], bass: N.Fs3 / 2, scale: [N.Fs4, N.G4, N.A4, N.Cs5, N.Fs5] }, // Fs2 は N に無いので Fs3/2＝92.5Hz
      // D（bVI）— 廊下の奥へ降りていく。ベースも和音も arp も、この小節が曲中で最も低い。
      // scale の G4 が乗ると Dsus4 になって空洞に鳴る。
      { chord: [N.D3,  N.Fs3, N.A3,  N.D4],  bass: N.D2,      scale: [N.G4, N.A4, N.D5, N.E5, N.Fs5] },
      // Em（bvii）— 階段を戻る。scale の A4 は11th、D5 は Em7 の7th。
      { chord: [N.E3,  N.G3,  N.B3,  N.E4],  bass: N.E2,      scale: [N.G4, N.A4, N.B4, N.D5, N.E5] },
      // G（bII）— ここが曲の頂点。scale の Fs5 は bII の上に乗った主音で、次の小節の
      // Fsm ではそのまま和音の一員になる。半音落ちるのはベース（G2→Fs2）。
      { chord: [N.G3,  N.B3,  N.D4,  N.G4],  bass: N.G2,      scale: [N.G4, N.B4, N.D5, N.E5, N.Fs5] },
    ],
  },
  // 🌊 海底神殿 — 海底神殿・地底湖・毒の沼窟のフロアとゴーレム戦。BPM 70 は全曲で最も遅い。
  // B♭マイナー／5音和音（m9・maj9）／triangle パッド／シンバル皆無 ── どれもこの曲だけ。
  // B♭1 のドローンが水圧、sine のアルペジオが泡。engine の drone() は音量 0.28 固定で、
  // 小節頭でいきなりそこへ跳ね、最後の20%で 0 まで降りる（1小節 3.43秒＝遅いうねり）。
  // 下の kick[0] と bass の高さは、そのドローンの都合で決まっている（各行の注記を参照）。
  ocean: {
    bpm: 70, swing: 0.08, padType: 'triangle', padVol: 0.17, padVibrato: true, arpType: 'sine',
    // 打楽器はキック2発だけ＝1小節2打点（これより薄いのは ghost と blastMenu だけ）。
    // hat() は highpass 7500Hz の白色ノイズ＝水中でいちばん嘘になる音なので hat/openHat は空。
    // step 0 のキックは外さないこと。小節頭でドローンが 0.28 へ跳ぶ段差を隠しているのはこれ。
    kick: [0, 11], snare: [], hat: [],
    // bass は必ず 116Hz（ドローン B♭1＝58Hz のオクターブ上）以上に置く。58Hz の純サインに
    // 3度や4度を重ねると音程に融けず唸る（B♭1+D♭2 なら毎秒11回のビート）。B♭2→G♭3→E♭3→
    // D♭3 と回り、次の周の B♭2 で主音に着く。step 11 の1.6秒がドローンの降下（2.74秒〜）を埋める。
    bassSteps: [0, 11], bassLen: 1.9, bassType: 'sine', bassVol: 0.36, detune: 7,
    // 6ステップ × 5音なので idx は 0,1,2,3,4,0 と回り、奇数番だけオクターブ上へ跳ぶ
    // ＝［根音, 3rd↑, 5th, 7th↑, 9th, 根音↑］。1小節目は B♭3→D♭5→F4→A♭5→C5→B♭4。
    // 4小節とも同じ形で、最後は根音のオクターブ上に着いて泡が消える。step 0 は空ける。
    arpSteps: [1, 4, 6, 7, 11, 13], arpVol: 0.13, arpDelay: true, arpOctave: true,
    // melody は engine 側で triangle・音量 0.15 固定＝arp より目立つ別音色。1小節に約1音。
    drone: N.Bb1, melody: 0.12,
    bars: [
      // B♭m9。ドローンを足すと B♭-D♭-F-A♭-C ＝ 曲名どおりの「B♭マイナー9th」。
      { chord: [N.Bb3, N.Cs4, N.F4, N.Gs4, N.C5],     bass: N.Bb2,     scale: [N.Bb4, N.C5, N.Cs5, N.F5] },
      // G♭maj9。ここだけ bass を根音のオクターブ下（92.5Hz）にしない ── ドローンとの差
      // 34Hz がいちばん粗く聞こえる帯なので、G♭3 のままパッド最低音と同度に置く。
      { chord: [N.Fs3, N.Bb3, N.F4, N.Gs4, N.Cs5],    bass: N.Fs3,     scale: [N.Bb4, N.Cs5, N.F5, N.Fs5] },
      // E♭m9 — 配置がひと回り上がって光が差す。上声部 C5→D♭5→F5→E♭5 の頂点。
      { chord: [N.Eb4, N.Fs4, N.Bb4, N.Cs5, N.F5],    bass: N.Eb4 / 2, scale: [N.Bb4, N.Cs5, N.F5, N.Fs5] },
      // D♭maj9。ドローンの上では B♭m11。全5声が半音／全音で下りてここへ着き、
      // 1小節目とは共通音4つ＝継ぎ目が立たないまま輪が閉じる。
      { chord: [N.Cs4, N.F4, N.Gs4, N.C5, N.Eb4 * 2], bass: N.Cs3,     scale: [N.Bb4, N.C5, N.Cs5, N.F5] },
    ],
  },

  // 🌸 桜の迷宮 — 花びらの舞う回廊と虹の花園。Dm に ♭II の E♭ を差した都節（陰音階）。
  // 旋律は D・E♭・G・A・B♭ だけを歩き、F は和音の側（矩形波パッド＝笙とアルペジオ）に置く。
  // E♮ と C♯ が開くのは「扉」の4・8小節目だけ。キックとベースを 0/8 に置いて4拍の柱にし、
  // アルペジオ(0/3/6/9/12)とハット(2/5/8/11/14)だけを3ステップ刻みで走らせた ── 柱に合流
  // するのはアルペジオの 0 とハットの 8 だけ。和音は3音と4音を混ぜ、再訪で音形が変わる。
  sakura: {
    bpm: 98, swing: 0, padType: 'square', padVol: 0.04, arpType: 'sine',
    kick: [0, 8], snare: [], hat: [2, 5, 8, 11, 14], hatVol: 0.04,
    bassSteps: [0, 8], bassLen: 2, bassType: 'triangle', bassVol: 0.4,
    arpSteps: [0, 3, 6, 9, 12], arpVol: 0.16, arpDelay: true, melody: 0.24,
    bars: [
      { chord: [N.D4, N.F4, N.A4],          bass: N.D2,      scale: [N.D5, N.Eb4 * 2, N.G5, N.A5] },       // Dm    — 3音: D-F-A-D-F
      { chord: [N.Bb3, N.Eb4, N.G4, N.Bb4], bass: N.Eb4 / 4, scale: [N.Eb4 * 2, N.G5, N.Bb4 * 2, N.D5] },  // E♭    — 都節の♭II。4音: B♭-E♭-G-B♭-B♭（bass E♭2）
      { chord: [N.G3, N.Bb3, N.D4],         bass: N.G2,      scale: [N.D5, N.G5, N.A5, N.Bb4 * 2] },       // Gm    — 奥へ
      { chord: [N.A3, N.D4, N.E4],          bass: N.A2,      scale: [N.A4, N.Bb4, N.D5, N.E5] },           // Asus4 — 開かない扉。ここだけ E♮
      { chord: [N.A3, N.D4, N.F4, N.A4],    bass: N.D2,      scale: [N.D5, N.Eb4 * 2, N.G5, N.Bb4 * 2] },  // Dm    — 4音: A-D-F-A-A。1小節目と違う形で戻る
      { chord: [N.Bb3, N.D4, N.F4],         bass: N.Bb2,     scale: [N.D5, N.G5, N.A5, N.Bb4 * 2] },       // B♭
      { chord: [N.Eb4, N.G4, N.Bb4],        bass: N.Eb4 / 4, scale: [N.Eb4 * 2, N.G5, N.Bb4 * 2, N.D5] },  // E♭    — 3音: E♭-G-B♭-E♭-G。2小節目と違う形
      { chord: [N.A3, N.Cs4, N.E4],         bass: N.A2,      scale: [N.A4, N.Cs5, N.E5, N.G5] },           // A     — C♯ が一瞬光り、G♮ が Dm へ引き戻す
    ],
  },
  // 🏜️ 黄昏の砂漠 — Fハーモニックマイナー（Fm→B♭m→D♭→C7）。締めの C7 が鳴らす
  // C-D♭-E-G のフリジアン・ドミナントが砂漠の匂いで、♭9 の D♭5 は 4小節目の chord に
  // 置いてある（パッドが1小節持続し、arp も C4→E4→B♭4→D♭5 と登って終わる）。
  // 他の3小節は C4〜B♭4 の3声を半音・全音だけで動かし、ローパス矩形ベースと帯域を分けた。
  // 敷き詰めた16分ハットは砂粒、キック 0/6/11 とスネア 4/14 のずれが落ちる長い影。
  desert: {
    bpm: 86, swing: 0, padType: 'triangle', padVol: 0.10, arpType: 'square',
    kick: [0, 6, 11], snare: [4, 14],
    hat: [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14], hatVol: 0.05, openHat: [7, 15],
    // ゲンブリ（弦の低音）。detune は付けない — bassNote() の第2オシレータは
    // ローパスを通らず素の矩形波が出るので、520Hz で濾した狙いが逆になる。
    bassSteps: [0, 3, 8, 11], bassLen: 0.7, bassType: 'square', bassVol: 0.44, bassFilter: 520,
    arpSteps: [2, 5, 10, 13], arpVol: 0.12, arpDelay: true, melody: 0.22,
    bars: [
      { chord: [N.C4, N.F4, N.Gs4],        bass: N.F2,  scale: [N.C5, N.F5, N.G5, N.Gs4 * 2] },  // Fm/C（N.Gs4*2 = A♭5）
      { chord: [N.Cs4, N.F4, N.Bb4],       bass: N.Bb2, scale: [N.Bb4, N.Cs5, N.F5, N.C5] },     // B♭m/D♭
      { chord: [N.Cs4, N.F4, N.Gs4],       bass: N.Cs3, scale: [N.Cs5, N.F5, N.C5, N.Gs4 * 2] }, // D♭
      { chord: [N.C4, N.E4, N.Bb4, N.Cs5], bass: N.C2,  scale: [N.Bb4, N.Cs5, N.E5, N.G5] },     // C7(♭9) — 長い影
    ],
  },
  // 🌋 灼熱火山 — 溶岩脈と血の沼。F フリギア／113BPM。F1 のサイン波ドローンの上に、
  // ♭II（G♭）が半音上からのしかかる。V を置かないので、4小節目から1小節目へ戻るのは
  // 「解決」ではなく半音の崩落 ── ループの継ぎ目がいちばん重い。息を継げるのは iv の
  // 3小節目だけ。既存の i-♭VI-♭VII（hard/pixel）にも i-♭VI-III-♭VII（menu/solo/
  // blastMenu）にも触れず、♭II を持つ和音進行は他に無い。
  volcano: {
    // 同じ 110 台の曲とはテンポでは離れきれないので、調（F フリギア）・音色（唸る鋸ベース
    // ＋F1 ドローン）・リズム密度（1小節9打・ハットは裏16分だけ）の3点で離してある。
    // padVibrato は kami と同じ 5.2Hz/4セント（エンジン固定）。違うのは波形と音域と音量
    // だけなので、0.07 では三角波の奇数倍音が出ず sine と区別がつかない ── 0.10 で置く。
    bpm: 113, swing: 0.1, padType: 'triangle', padVol: 0.10, padVibrato: true, arpType: 'sawtooth',
    // ハットは16分の裏（3/7/11/15）だけ。奇数ステップは swing 0.1 で 13ms 遅れるので、
    // ハットは毎回そのぶん遅れ、拍のあとから熱気が追いかけてくる（kick 5・bass 3/5/13・
    // arp 7/15・openHat 13 も同じ）。
    kick: [0, 5, 10], snare: [8], hat: [3, 7, 11, 15], hatVol: 0.04, openHat: [13],
    // bassFilter 340（544→170Hz へ閉じる）。bassNote() の detune 側オシレータは lowpass を
    // 通らずに出る＝ベース音量の 1/3 は生のノコギリなので、260 まで絞ると「暗いサブ」と
    // 「素のブザー」の二層に割れる。bassLen 0.75（0.398秒）が前の音に重なるのは 3→5 の
    // 2ステップだけで、そのとき前の音は指数減衰で 0.3% まで落ちている。
    bassSteps: [0, 3, 5, 10, 13], bassLen: 0.75, bassType: 'sawtooth', bassVol: 0.5, bassFilter: 340, detune: 16,
    // arpSteps 4個 × arpOctave なので音形は chord[0] → chord[1]×2 → chord[2] → chord[3 か 0]×2。
    // 実測 F4-A♭5-C5-F5 ／ G♭4-B♭5-D♭5-G♭5 ／ B♭4-D♭6-F5-B♭5 ／ G♭4-B♭5-F5-D♭6（天井 1108.7Hz）。
    arpSteps: [2, 7, 10, 15], arpVol: 0.09, arpDelay: true, arpOctave: true, melody: 0.14, stab: [0, 10],
    drone: 43.65,   // F1 — 地鳴り。sine で倍音を持たないので、上の G♭2 と鳴っても低域は濁らない。
    // ♭ の音は N に名前が無いので実数で書く（G♭ のつもりで N.Fs4 と書くと、N.Gs4 のときと
    // 同じ「名前が嘘をつく」形になる）。369.99=G♭4 415.3=A♭4 554.37=D♭5 622.25=E♭5 92.50=G♭2
    bars: [
      // i（Fm）— 熱源。ドローンと足元が揃う唯一の小節。scale の G♭4 はフリギアの ♭2 で、
      // パッドの F4 と短2度で擦れる ── これがこの曲の印なので意図的に残した（melody 0.14
      // ＝ 1小節に1音程度のちらつき）。それ以外の短2度は全部外してある。
      { chord: [N.F4, 415.3, N.C5],           bass: N.F2,  scale: [N.F4, 369.99, 415.3, N.Bb4, N.C5] },
      // ♭II（G♭）— F ドローンの半音上。「抜けない圧」の正体はこの和音。
      { chord: [369.99, N.Bb4, 554.37],       bass: 92.50, scale: [369.99, N.Bb4, 554.37, N.F5] },
      // iv（B♭m）— F が和音の5度に収まる、ひと息だけの逃げ場。音域もここで上がる。
      { chord: [N.Bb4, 554.37, N.F5],         bass: N.Bb2, scale: [415.3, N.Bb4, 554.37, N.F5] },
      // ♭IImaj7（G♭maj7）— 3小節目の B♭m を上に残したまま、下から G♭ が滑り込む。F を
      // 抱えたまま終わるので、1小節目へは解決ではなく崩落として戻る。並びを昇順にせず
      // 最高音 F5 を偶数番目に置いたのは、arpOctave の天井を D♭6 に揃えるため。
      { chord: [369.99, N.Bb4, N.F5, 554.37], bass: 92.50, scale: [369.99, N.Bb4, 554.37, 622.25, N.F5] },
    ],
  },

  // ❄️ 氷結洞窟 — 音の少なさが寒さ。和音は第5〜6オクターブ（554〜1318Hz）、低音は55〜104Hz、
  // 中域には音程のあるものを一つも置いていない（そこを通るのはドラムの当たりだけ）。
  // 進行は C#m7 – Amaj9 – Dmaj7 – C#m11/G#。2小節目は和音の4音がそのままで、下りるベースだけが
  // 意味を変える。3小節目の D♮（♭II）だけが調の外で、終わりは根音を鳴らさないので解決しない。
  // 4声は三度か四度でしか積まない ── stab が小節末に和音の全音を0.07のノコギリで刺すので、2度は必ず濁る。
  frost: {
    bpm: 96, swing: 0, padType: 'triangle', padVol: 0.075, arpType: 'square',
    kick: [0, 11], snare: [6], hat: [2, 10], hatVol: 0.03, openHat: [3],
    bassSteps: [0, 8], bassLen: 1.1, bassType: 'triangle', bassVol: 0.32, bassFilter: 300,
    arpSteps: [0, 4, 7, 12], arpVol: 0.12, arpDelay: true, arpOctave: true, melody: 0.12, stab: [14],
    bars: [
      // chord の並び＝つららが落ちる順。arpOctave が idx1・idx3（＝chord[1] と chord[3]）を
      // 2倍にするので、その2つには低い側だけを置いてある（最高音は bar3/4 の F#6 = 1480Hz）。
      // C#m7 — G#5 → C#6 → B5 → E6
      { chord: [N.Gs4 * 2, N.Cs5, N.B5, N.E5], bass: N.Cs3 / 2,
        scale: [N.Cs5, N.E5, N.Fs5, N.Gs4 * 2, N.B5] },
      // Amaj9 — 和音は1小節目と同じ4音のまま。C#2→A1 と下りるベースだけが色を変える
      // （落ちる順だけ入れ替えた: B5 → E6 → G#5 → C#6）
      { chord: [N.B5, N.E5, N.Gs4 * 2, N.Cs5], bass: N.A1,
        scale: [N.Cs5, N.E5, N.Fs5, N.Gs4 * 2, N.B5] },
      // Dmaj7 — ♭II。D♮ はこの曲で唯一の調外音、開けてはいけない方の扉
      { chord: [N.Cs6, N.D5, N.A5, N.Fs5], bass: N.D2,
        scale: [N.D5, N.E5, N.Fs5, N.A5, N.Cs6] },
      // C#m11/G# — 四度積み（C#-F#-B-E）を5度の上に浮かせる。根音が無いので解決せず1小節目へ
      { chord: [N.B5, N.Cs5, N.E6, N.Fs5], bass: N.Gs4 / 4,
        scale: [N.Cs5, N.E5, N.Fs5, N.Gs4 * 2, N.B5] },
    ],
  },
  // ⚡ 雷雲の頂 — 吹きさらしの16分ハイハットが風、裏拍16分だけを走るのこぎり波の
  // アルペジオが渦。強拍は 0/5/11 と不規則に落ち、7と13でオープンハットと和音の
  // 刺しが重なって稲光になる。和声は Gm - Cm - A♭ - D（i - iv - ♭II - V）。ベースは
  // G2→C2→A♭2→D2 と歩き、3小節目のナポリが初小節の G2 の半音上に着地してから
  // D2 へ三全音落ちる。4小節目が V のまま終わるので、解決は必ずループの継ぎ目で起きる。
  storm: {
    bpm: 132, swing: 0, padType: 'square', padVol: 0.045, arpType: 'sawtooth',
    kick: [0, 5, 11], snare: [8, 13], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hatVol: 0.055, openHat: [2, 7, 13],
    // ⚠ ベースは riff ではなく bassSteps。riff があると scheduleStep は bar.bass を
    //   完全に無視して毎小節おなじ音を鳴らすので、進行が動く曲では必ずどこかで
    //   ぶつかる（原稿の riff の F は D の F♯ と、G は A♭ と衝突していた）。
    //   ステップ [0,5,8,11,14] は riff と同じ位置、bassLen 0.45 は stepDur×4×0.45＝
    //   stepDur×1.8 で riff と同じ音長。突風のリズムはそのまま、音程だけ和音に従う。
    bassSteps: [0, 5, 8, 11, 14], bassLen: 0.45, bassType: 'sawtooth', bassVol: 0.5, bassFilter: 520, detune: 6,
    arpSteps: [1, 3, 5, 7, 9, 11, 13, 15], arpVol: 0.1, arpDelay: true, arpOctave: true, stab: [7, 13],
    // ⚠ 和音は転回で G3〜A4 の帯に収めること。arpOctave は arpSteps の奇数番目を
    //   1オクターブ上げるので、和音ごと上げるとその小節だけアルペジオが 900Hz超で
    //   鳴り続け、16分ハットと重なって金切り声になる。この並びでの頂点は
    //   587→622→831→880Hz の上行アーチ（各小節の和音の最高音が idx5 で倍になる）。
    bars: [
      { chord: [N.G3, N.Bb3, N.D4],  bass: N.G2 },       // Gm
      { chord: [N.G3, N.C4, N.Eb4],  bass: N.C2 },       // Cm — G3 を残したまま下がる
      { chord: [N.C4, N.Eb4, N.Gs4], bass: N.Gs4 / 4 },  // A♭/C（ナポリ）— N.Gs4＝A♭4、bass は A♭2
      { chord: [N.D4, N.Fs4, N.A4],  bass: N.D2 },       // D — E♭4→F♯4 の増2度が稲光の色
    ],
  },

  // ☁️ 天界の門 — 雲の階段を一段ずつ登る8小節。F リディアン（親音階は C 長調で
  // ♭を1つも使わない。F から見た ♯4 の B ナチュラルが全8小節に居て、空が抜ける）。
  // ベース F2→F3・和音の最低音 F3→F4・旋律の最低音 F4→F5 の3層が、同じ音階を
  // そろって1オクターブ登り切る。8小節目の根音は1小節目のちょうど1オクターブ上、
  // つまり終止ではないので、ループでそのまま次の階段の一段目に落ちてまた登る。
  heaven: {
    bpm: 66, swing: 0, padType: 'triangle', padVol: 0.15, arpType: 'sine',
    // 足音は 0/6/10 の 3+2+3。四つ打ちにもバックビートにもしない（スネア無し）。
    // ハットは足音の合間（3/8/13）だけを撫でる蹴込み板。オープンハットは置かない
    // ── openHat を持つのは battle/hard/mine/pixel/kami の速い曲だけで、
    //    66BPM の雲の階段に毎小節入れるとドラムマシンの側に寄る。
    kick: [0, 6, 10], snare: [], hat: [3, 8, 13], hatVol: 0.035,
    // 根音は1小節に1つだけ、小節の8割（16分×12.8）伸ばして残りは無音。
    // 踏む → 余韻 → 次の段。bassSteps[0] は menu/ghost と同じだが、あちらは
    // sine の 3.6/3.4。こちらは triangle の 3.2 で、根音が毎小節上がっていく。
    bassSteps: [0], bassLen: 3.2, bassType: 'triangle', bassVol: 0.36,
    // sine の鐘。エンジンは chord[arpSteps.indexOf(step) % chord.length] なので、
    // 5音 ÷ 4和音 ＝「和音を下から順に登って最後に根音へ戻る」形が毎小節そろう。
    // 7 と 11 は足音（6 と 10）の16分あと ＝ 一段踏むたびに鐘が答える。
    // melody のプラックは scheduleStep 側で triangle・音量 0.15 のベタ書き（曲から
    // 変えられない）。主役を鐘にするため arpVol はその上に取り、melody は薄くする。
    arpSteps: [0, 4, 7, 11, 14], arpVol: 0.17, arpDelay: true, melody: 0.14,
    // scale は「その小節で旋律が拾ってよい音」。最低音がその小節の根音で、8小節
    // かけて F4→F5 と上がる。**必ず和音に無い音を1つは入れる**こと（構成音だけに
    // すると melody が pad をなぞるだけになり、その小節から旋律が消える）。
    // 各行のコメント末尾がその「和音に無い音」。
    bars: [
      { chord: [N.F3, N.C4, N.E4, N.G4], bass: N.F2, scale: [N.F4, N.G4, N.A4, N.B4, N.C5] },  // Fmaj9（三度抜き）— 一段目。旋律の A が三度、B が F の ♯4
      { chord: [N.G3, N.D4, N.E4, N.A4], bass: N.G2, scale: [N.G4, N.A4, N.B4, N.D5, N.E5] },  // G6/9（三度抜き）— 雲の隙間。旋律の B が三度
      { chord: [N.A3, N.E4, N.G4, N.B4], bass: N.A2, scale: [N.A4, N.B4, N.C5, N.E5, N.G5] },  // Am9（三度抜き）— 三段目。旋律の C が三度
      { chord: [N.B3, N.F4, N.A4, N.D5], bass: N.B2, scale: [N.B4, N.D5, N.E5, N.F5, N.A5] },  // Bm7♭5 — ♯4 の踏み板。ここが曲の正体。旋律の E が11th
      { chord: [N.C4, N.G4, N.B4, N.D5], bass: N.C3, scale: [N.C5, N.D5, N.E5, N.G5, N.B5] },  // Cmaj9（三度抜き）— 雲を抜ける。旋律の E が三度
      { chord: [N.D4, N.A4, N.C5, N.E5], bass: N.D3, scale: [N.D5, N.E5, N.F5, N.A5, N.B5] },  // Dm9（三度抜き）— 六段目。旋律の F が三度
      { chord: [N.E4, N.B4, N.D5, N.G5], bass: N.E3, scale: [N.E5, N.G5, N.A5, N.B5] },        // Em7 — 最上段の手前。旋律の A が11th。scale が7半音に狭まり空気が薄い
      { chord: [N.F4, N.C5, N.D5, N.A5], bass: N.F3, scale: [N.F5, N.G5, N.A5, N.B5] },        // F6/9 — 門が開く。根音は1小節目の1オクターブ上。旋律の B が F の ♯4
    ],
  },
  // 🕳️ 深淵 — 底の無い最深部。全音音階（C D E F# G# A#）の増三和音だけで組んで
  // あるのでどこにも解決しない。和音は D+{D,F#,A#} と C+{C,E,G#} の2集合が
  // 交替するだけで、3声とも毎小節きっかり全音ずつ下がり、4小節目から三全音で
  // 振り出しへ戻る。52BPM は全曲中最遅、swing 0.3（上限）で奇数ステップが
  // 86.5ms 遅れて拍が溶ける。⚠ 1小節だけ差し替えると全音下降の対称が壊れる。
  abyssdeep: {
    bpm: 52, swing: 0.3,
    // pad はこの曲の身元（増三和音）を鳴らす唯一の声部（stab は無し）。square は
    // 倍音が多いので、sine パッド勢（ruins 0.13 / royal 0.15）より低い 0.11 で釣り合う。
    padType: 'square', padVol: 0.11, padVibrato: true, arpType: 'triangle',
    kick: [0], snare: [], hat: [11], hatVol: 0.035, openHat: [6],   // 小節頭に1発、あとは水滴が2つ
    // 低音は和音の根音の2オクターブ下に置く。ドローン F#1(46.25) との間隔が
    // 短6度→三全音→長3度→長2度（27.2→19.2→12.0→5.66Hz）と毎小節詰まり、
    // 4小節目で低域が 5.7Hz で揺れる ── 「沈むほど濁る」の正体なので上げない。
    // bassFilter は 512Hz→160Hz を 2.77秒かけて降りる（Q=6 の山がそのまま
    // 「沈む」動きになる）。190 まで下げると倍音ごと 100Hz 以下に閉じてしまい、
    // ノートPCやスマホのスピーカーでは低音レイヤーが丸ごと消える。
    bassSteps: [0, 9], bassLen: 2.4, bassType: 'sawtooth', bassVol: 0.38, bassFilter: 320, detune: 14,
    // 一定のうなりを作っているのは detune: 14（既存最大）。2本目のサウが 14セント
    // 上なので 51.9〜73.4Hz では 0.42〜0.60Hz、1.7〜2.4秒に1回うねる。消すと底が静止する。
    // arp は arpSteps 3個 × chord 3音がちょうど噛み合い、毎小節
    // 「根音 → 第3音を1オクターブ上 → 第5音」の同じ形になる（arpOctave は idx 奇数だけ）。
    // melody の一撃は engine 側で triangle/0.15 固定＝この曲で最大の音なので、
    // 音量ではなく確率で抑える。0.07 なら1小節あたり 0.56 発＝たまに落ちる一滴。
    arpSteps: [2, 13, 15], arpVol: 0.12, arpDelay: true, arpOctave: true, melody: 0.07,
    // F#1。engine の drone() は小節の 80% まで 0.28 で鳴らし、残り 0.92秒で 0 へ
    // 落として次の小節頭で鳴らし直す ── 鳴り続けではなく1小節ごとに息をする。
    drone: 46.25,
    // 各 bar の scale は「その和音の3音＋全音音階の隣の1音」。melody はここから拾う。
    bars: [
      { chord: [N.D4, N.Fs4, N.Bb4],  bass: N.D2,  scale: [N.D5, N.Fs5, 932.33, 1046.5] },  // D+  — 落ち始める（A#5, C6）
      { chord: [N.C4, N.E4, N.Gs4],   bass: N.C2,  scale: [N.D5, N.E5, 830.61, 1046.5] },   // C+  — 全音下がる（G#5, C6）
      { chord: [N.Bb3, N.D4, N.Fs4],  bass: N.Bb1, scale: [N.D5, N.E5, N.Fs5, 932.33] },    // B♭+ — D+ と同じ集合を一段下で
      { chord: [207.65, N.C4, N.E4],  bass: 51.91, scale: [N.E5, N.Fs5, 830.61, 1046.5] },  // G#+ — G#3/G#1。三全音で振り出しへ
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

// Jukebox metadata: titles + where each track normally plays.
// bpm is read from TRACKS so the two never drift apart.
// 絵は iconName（public/js/icons.js の名前）。以前は 🏠 のような絵文字を直に
// 持っていて、ジュークボックスの一覧で端末ごとに絵が変わっていた。
// → 描画は public/js/screens.js の .jb-icon （innerHTML）。
export const TRACK_INFO = [
  // ── 基本 ──
  { id: 'menu',   iconName: 'mode_room', name: 'やすらぎのロビー', nameEn: 'Cozy Lobby',      where: 'メニュー',                 whereEn: 'Menu', group: 'core' },
  { id: 'solo',   iconName: 'mode_solo', name: 'ブロックさんぽ',   nameEn: 'Block Stroll',    where: 'ソロ・見習いAI',             whereEn: 'Solo / Apprentice AI', group: 'core' },
  { id: 'battle', iconName: 'mode_online', name: 'アリーナの熱気',   nameEn: 'Arena Heat',      where: 'ランクマ・カスタム戦', whereEn: 'Ranked / Custom rooms', group: 'core' },
  { id: 'hard',   iconName: 'fire', name: '限界突破',         nameEn: 'Limit Break',     where: '達人AI',     whereEn: 'Master AI', group: 'core' },
  { id: 'boss',   iconName: 'mode_boss', name: '巨影せまる',       nameEn: 'Looming Giant',   where: 'ボス戦',                   whereEn: 'Boss fights', group: 'core' },
  { id: 'oni',    iconName: 'foe_oni', name: '鬼の巣窟',         nameEn: "Oni's Den",       where: '鬼AI・鬼の巣窟・神殺しの祭壇',                 whereEn: 'Oni AI / Oni Den', group: 'core' },
  { id: 'pixel',  iconName: 'mode_royale', name: 'PIXEL RUSH 182',   nameEn: 'PIXEL RUSH 182',  where: 'バトルロイヤル・機械神',           whereEn: 'Battle Royale / Mecha boss', group: 'core' },
  { id: 'kami',   iconName: 'badge_kami', name: '天上の光',         nameEn: 'Celestial Light', where: '神AI・星屑の橋・神々の回廊',       whereEn: 'Kami AI / celestial floors', group: 'core' },
  // ── モード専用 ──
  { id: 'ruins',  iconName: 'mode_puzzle', name: '遺跡の囁き',       nameEn: 'Whisper of Ruins', where: 'パズル遺跡・苔の洞窟', whereEn: 'Puzzle Ruins / Mossy Cave', group: 'mode' },
  { id: 'mine',   iconName: 'mode_dig', name: '地底のハンマー',   nameEn: 'Hammer Below',     where: '採掘場・地下坑道',                  whereEn: 'The Mines / underground shafts', group: 'mode' },
  { id: 'meltdown', iconName: 'mode_meltdown', name: '炉心のカウントダウン', nameEn: 'Core Countdown', where: 'メルトダウン', whereEn: 'Meltdown', group: 'mode' },
  { id: 'survival', iconName: 'mode_survival', name: '押し寄せる波', nameEn: 'Rising Tide', where: 'サバイバル', whereEn: 'Survival', group: 'mode' },
  { id: 'sprint', iconName: 'mode_sprint', name: '秒針', nameEn: 'Second Hand', where: 'タイムアタック', whereEn: 'Time Attack', group: 'mode' },
  { id: 'chaos',  iconName: 'mode_chaos', name: '気まぐれの盤', nameEn: 'Fickle Board', where: 'カオスモード', whereEn: 'Chaos Mode', group: 'mode' },
  { id: 'chimera', iconName: 'mode_chimera', name: '継ぎはぎの怪物', nameEn: 'Patchwork Beast', where: 'キメラ工房', whereEn: 'Chimera Lab', group: 'mode' },
  { id: 'chain',  iconName: 'mode_chain', name: '転がる連鎖', nameEn: 'Tumbling Chain', where: '連鎖カスケード', whereEn: 'Chain Cascade', group: 'mode' },
  { id: 'daily',  iconName: 'mode_daily', name: '今日の一手', nameEn: "Today's Move", where: 'デイリーチャレンジ', whereEn: 'Daily Challenge', group: 'mode' },
  { id: 'weekly', iconName: 'mode_weekly', name: '今週の頂', nameEn: "This Week's Peak", where: 'ウィークリーチャレンジ', whereEn: 'Weekly Challenge', group: 'mode' },
  { id: 'coop',   iconName: 'mode_coop', name: '二人の盤',       nameEn: 'One Board, Two Hands', where: '協力プレイ（2人で1つの盤面）', whereEn: 'Co-op (two players, one board)', group: 'mode' },
  { id: 'blueprint', iconName: 'mode_blueprint', name: '設計図の線', nameEn: 'Blueprint Lines', where: 'ブループリント', whereEn: 'Blueprint', group: 'mode' },
  { id: 'workshop', iconName: 'mode_workshop', name: '工房の朝', nameEn: 'Workshop Morning', where: 'パズル工房', whereEn: 'Workshop', group: 'mode' },
  { id: 'land',   iconName: 'flag', name: '旗の行進', nameEn: 'March of Flags', where: '陣取りデュエル', whereEn: 'Land Grab duel', group: 'mode' },
  { id: 'team',   iconName: 'friends', name: '肩を並べて', nameEn: 'Shoulder to Shoulder', where: '2v2チーム戦', whereEn: '2v2 Team Battle', group: 'mode' },
  { id: 'tourney', iconName: 'mode_tourney', name: '勝ち上がり', nameEn: 'Climbing the Bracket', where: 'トーナメント', whereEn: 'Tournament', group: 'mode' },
  { id: 'raid',   iconName: 'mode_raid', name: '総力戦',           nameEn: 'All Hands',        where: 'レイド',                  whereEn: 'Raid', group: 'mode' },
  { id: 'rush',   iconName: 'mode_bossrush', name: '連戦',   nameEn: 'Gauntlet',   where: 'ボスラッシュ',   whereEn: 'Boss Rush', group: 'mode' },
  { id: 'zero',   iconName: 'badge_zero', name: '断罪', nameEn: 'Judgement', where: 'ゼロの卓（断罪）・審判の間', whereEn: "Zero's Table / Hall of Judgment", group: 'mode' },
  { id: 'arena',  iconName: 'mode_adminevent', name: '運営の舞台', nameEn: "The Host's Stage", where: '運営イベント', whereEn: 'Admin events', group: 'mode' },
  { id: 'replay', iconName: 'seat_watch', name: '他人の走り', nameEn: "Someone Else's Run", where: 'リプレイ再生', whereEn: 'Replay playback', group: 'mode' },
  { id: 'souzou', iconName: 'badge_souzou', name: '創造の重力', nameEn: 'Gravity of Creation', where: '創造神・創造の玉座', whereEn: 'Creator God / Throne of Creation', group: 'mode' },
  // ── ダンジョン ──
  { id: 'crypt',  iconName: 'foe_undead', name: '静寂の墓所', nameEn: 'Silent Crypt', where: 'ダンジョン：亡霊の城・骨の回廊・静寂の墓所／深淵：嘆きの回廊・狂気の鏡殿', whereEn: 'Dungeon: Haunted Castle / Bone Gallery / Silent Crypt; Abyss: Lament / Mad Mirrors', group: 'dungeon' },
  { id: 'ocean',  iconName: 'fx_bubble', name: '海底神殿',         nameEn: 'Sunken Temple',    where: 'ダンジョン：海底神殿・地底湖・毒の沼窟／ボス：ゴーレム', whereEn: 'Dungeon: Sunken Temple / Sunless Lake / Venom Grotto; Golem boss', group: 'dungeon' },
  { id: 'sakura', iconName: 'fx_sakura', name: '桜の迷宮', nameEn: 'Sakura Labyrinth', where: 'ダンジョン：桜の迷宮・虹の花園', whereEn: 'Dungeon: Sakura Labyrinth / Rainbow Garden', group: 'dungeon' },
  { id: 'desert', iconName: 'ore_gold', name: '黄昏の砂漠', nameEn: 'Twilight Desert', where: 'ダンジョン：黄昏の砂漠', whereEn: 'Dungeon: Twilight Desert', group: 'dungeon' },
  { id: 'volcano', iconName: 'fx_flame', name: '灼熱火山', nameEn: 'Molten Caldera', where: 'ダンジョン：灼熱火山・溶岩脈・血の沼／ボス：火竜', whereEn: 'Dungeon: volcanic floors / Fire dragon', group: 'dungeon' },
  { id: 'frost',  iconName: 'fx_snow', name: '氷結洞窟', nameEn: 'Frozen Cavern', where: '氷結洞窟・水晶の洞・氷獄／氷雪女王戦', whereEn: 'Frozen Cavern / Crystal Hollow / Frozen Hell / Frost Queen', group: 'dungeon' },
  { id: 'storm',  iconName: 'storm', name: '雷雲の頂', nameEn: 'Thunderhead Peak', where: 'ダンジョン：雷雲の頂・天雷の峰', whereEn: 'Dungeon: Thunderhead Peak / Peak of Holy Thunder', group: 'dungeon' },
  { id: 'heaven', iconName: 'badge_heaven', name: '天界の門', nameEn: 'Heavenly Gate', where: 'ダンジョン：天界の門・雲の階段', whereEn: 'Dungeon: Heavenly Gate / Stairway of Clouds', group: 'dungeon' },
  { id: 'abyssdeep', iconName: 'badge_abyss', name: '底無しの深淵', nameEn: 'Bottomless Abyss', where: '深淵ダンジョン', whereEn: 'The Abyss', group: 'dungeon' },
  { id: 'royal',  iconName: 'throne', name: '王座の間',         nameEn: 'Throne Room',      where: '黄金の大聖堂', whereEn: 'The Golden Cathedral', group: 'dungeon' },
  // ── 特別 ──
  { id: 'ghost',  iconName: 'mode_ghost', name: '幽霊屋敷のオルゴール', nameEn: 'Haunted Music Box', where: '？？？', whereEn: '???', hidden: true, group: 'special' },
  // ── ゲスト（ブロックブラスト） ──
  { id: 'blastMenu',  iconName: 'block', name: 'ブラスト・ホーム', nameEn: 'Blast Home',       where: 'ブロックブラストより：メニュー', whereEn: 'From Block Blast: menu', group: 'guest' },
  { id: 'blastGame',  iconName: 'ore_crystal', name: 'ブラスト・パズル', nameEn: 'Blast Puzzle',     where: 'ブロックブラストより：ソロ',     whereEn: 'From Block Blast: solo', group: 'guest' },
  { id: 'blastVs',    iconName: 'mode_ai', name: 'ブラスト・バトル', nameEn: 'Blast Battle',     where: 'ブロックブラストより：対戦',     whereEn: 'From Block Blast: versus', group: 'guest' },
  { id: 'blastGod',   iconName: 'ultimate', name: 'ゴッドラッシュ',   nameEn: 'God Rush',         where: 'ブロックブラストより：神モード', whereEn: 'From Block Blast: God mode', group: 'guest' },
  { id: 'blastBoss',  iconName: 'mode_abyss', name: '終焉のテーマ',     nameEn: 'Theme of the End', where: 'ブロックブラストより：終焉戦',   whereEn: 'From Block Blast: final boss', group: 'guest' },
  { id: 'blastBoss2', iconName: 'combo', name: '終焉・覚醒',       nameEn: 'The End Awakened', where: 'ブロックブラストより：覚醒形態', whereEn: 'From Block Blast: awakened', group: 'guest' },
].map(t => ({ ...t, bpm: TRACKS[t.id].bpm }));

// 🎵 ジュークボックスの見出し。TRACK_INFO の group 欄と対で、並び順もこの順。
//    47曲を平坦に並べると「メルトダウンの曲どれだっけ」が探せないので棚に分ける。
//    ここに無い group の曲は最後にまとめて出る（増やしたらここにも足すこと）。
export const TRACK_GROUPS = [
  { id: 'core', ja: '基本', en: 'Core' },
  { id: 'mode', ja: 'モード専用', en: 'Mode themes' },
  { id: 'dungeon', ja: 'ダンジョン', en: 'Dungeon' },
  { id: 'special', ja: '特別', en: 'Special' },
  { id: 'guest', ja: 'ゲスト（ブロックブラスト）', en: 'Guest (Block Blast)' },
];

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
