// Persistent user settings (localStorage) applied to audio / effects.
import { audio, TRACK_INFO } from './audio.js';

const KEY = 'bba_settings';
const DEFAULTS = {
  sfxOn: true,
  musicOn: true,
  sfxVol: 0.9,
  musicVol: 0.6,
  shake: true,
  flash: true,           // full-screen white flash on big clears / chains / boss hits
  particles: 'normal',   // 'low' | 'normal' | 'high'
  chatTranslate: true,   // show foreign-language chat in your language
  bgmTrack: null,        // jukebox pin: track id to loop everywhere (null = auto per screen)
  colorMarks: false,     // colorblind aid: overlay a shape mark per block color
  haptics: true,         // 📳 短い振動で「置いた／消えた／置けなかった」を返す
};

let settings = { ...DEFAULTS };
let hadSaved = false;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    settings = { ...DEFAULTS, ...JSON.parse(raw) };
    hadSaved = true;
  }
} catch { settings = { ...DEFAULTS }; hadSaved = false; /* corrupted storage -> defaults */ }
// OS の「視差効果を減らす」設定は、まだ一度も保存していない人にだけ既定として反映する。
// 保存済みの設定は絶対に上書きしない（一度でも設定画面を触れば hadSaved=true）。
if (!hadSaved) {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settings.shake = false;
      settings.flash = false;
      settings.particles = 'low';
      settings.haptics = false;   // 振動も「余計な刺激」の側に入れておく
    }
  } catch { /* matchMedia 非対応環境 -> 既定のまま */ }
}
// A pinned track id that no longer exists (renamed/removed in an update)
// silently degrades to auto — the UI must never show a phantom pin.
if (settings.bgmTrack && !TRACK_INFO.some(t => t.id === settings.bgmTrack)) settings.bgmTrack = null;
// Volumes may boost to 200% (the engine's limiter keeps it clean).
settings.sfxVol = Math.max(0, Math.min(2, Number(settings.sfxVol) || 0));
settings.musicVol = Math.max(0, Math.min(2, Number(settings.musicVol) || 0));

export function getSettings() { return settings; }

export function particleFactor() {
  return settings.particles === 'low' ? 0.35 : settings.particles === 'high' ? 1.9 : 1;
}

export function updateSettings(patch) {
  Object.assign(settings, patch);
  localStorage.setItem(KEY, JSON.stringify(settings));
  applySettings();
}

export function applySettings() {
  audio.setSfx(settings.sfxOn);
  audio.setVolumes(settings.sfxVol, settings.musicVol);
  // Order matters: the engine boots with musicOn=true, so the enabled flag
  // must be corrected BEFORE the locked track is applied — otherwise a saved
  // {musicOn:false, bgmTrack:…} plays an unstoppable burst at page load.
  audio.setMusicEnabled(settings.musicOn);
  audio.setLockedTrack(settings.bgmTrack);
}
