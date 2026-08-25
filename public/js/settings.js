// Persistent user settings (localStorage) applied to audio / effects.
import { audio, TRACK_INFO } from './audio.js';

const KEY = 'bba_settings';
const DEFAULTS = {
  sfxOn: true,
  musicOn: true,
  sfxVol: 0.9,
  musicVol: 0.6,
  shake: true,
  particles: 'normal',   // 'low' | 'normal' | 'high'
  chatTranslate: true,   // show foreign-language chat in your language
  bgmTrack: null,        // jukebox pin: track id to loop everywhere (null = auto per screen)
};

let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch { /* corrupted storage -> defaults */ }
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
