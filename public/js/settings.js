// Persistent user settings (localStorage) applied to audio / effects.
import { audio } from './audio.js';

const KEY = 'bba_settings';
const DEFAULTS = {
  sfxOn: true,
  musicOn: true,
  sfxVol: 0.9,
  musicVol: 0.6,
  shake: true,
  particles: 'normal',   // 'low' | 'normal' | 'high'
  chatTranslate: true,   // show foreign-language chat in your language
};

let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch { /* corrupted storage -> defaults */ }

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
  audio.setMusicEnabled(settings.musicOn);
}
