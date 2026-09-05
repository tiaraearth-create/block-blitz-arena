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
  // 👻 配置プレビューの段。'full' | 'light' | 'off'
  //   'full'  … いまと同じ。落ちる位置のゴースト／消える線の白帯／氷の水色帯／置けない赤
  //   'light' … 落ちる位置と「置けない」だけ。**どの線が消えるかは自分で読む**
  //   'off'   … 何も出さない
  // 落ちる位置のゴーストは**入力手段の都合**（コマは指より上に浮くので、
  // 無いとどのマスを狙っているのか分かりにくい ── liftAmount のコメント参照）。
  // 白帯・水色帯は**結果の予告**＝手助けなので、切れるのはそちらが主。
  // 既定を 'full' にしてあるのは、いま遊んでいる人の手触りを勝手に変えないため。
  placePreview: 'full',
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
// ♿ OS の「視差効果を減らす」。問い合わせは1本だけ持ち、初回既定にも
// 実行中の追随にも同じものを使う（matchMedia をあちこちで作らない）。
let rmQuery = null;
let reducedMotion = false;
try {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    rmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = !!rmQuery.matches;
  }
} catch { rmQuery = null; reducedMotion = false; /* matchMedia 非対応環境 -> 既定のまま */ }

// OS の「視差効果を減らす」設定は、まだ一度も保存していない人にだけ既定として反映する。
// 保存済みの設定は絶対に上書きしない（一度でも設定画面を触れば hadSaved=true）。
// あとから OS 側が切り替わっても、ここは二度と走らない ── 保存済みの値を
// 後出しで書き換えないため。実行中の追随は prefersReducedMotion() を
// 見る側（背景装飾など）の仕事にしてある。
if (!hadSaved && reducedMotion) {
  settings.shake = false;
  settings.flash = false;
  settings.particles = 'low';
  settings.haptics = false;   // 振動も「余計な刺激」の側に入れておく
}
// A pinned track id that no longer exists (renamed/removed in an update)
// silently degrades to auto — the UI must never show a phantom pin.
if (settings.bgmTrack && !TRACK_INFO.some(t => t.id === settings.bgmTrack)) settings.bgmTrack = null;
// Volumes may boost to 200% (the engine's limiter keeps it clean).
settings.sfxVol = Math.max(0, Math.min(2, Number(settings.sfxVol) || 0));
settings.musicVol = Math.max(0, Math.min(2, Number(settings.musicVol) || 0));
// 👻 壊れた値・知らない値は『いまと同じ見え方』へ倒す。
//   下の showClearHint() は `=== 'full'` なので、正規化が無いと undefined や
//   打ち間違いが**黙って「控えめ」に落ちる**（設定画面のボタンもどれも光らない）。
//   particleFactor が未知の値で normal＝既定へ落ちるのと同じ向きにそろえる。
if (!['full', 'light', 'off'].includes(settings.placePreview)) settings.placePreview = 'full';

export function getSettings() { return settings; }

export function particleFactor() {
  return settings.particles === 'low' ? 0.35 : settings.particles === 'high' ? 1.9 : 1;
}

// 👻 配置プレビューの段の規則は、この2本だけが持つ。
//   描画側は7か所で参照するので、生の文字列比較を散らすと1か所ズレても誰も気づかない。
//   showPlaceGhost … 落ちる位置（ゴースト本体・置けない赤・カーソルの色分け）
//   showClearHint  … 結果の予告（消える線の白帯・氷の水色帯・盤面ブロックの白いグロー）
export function showPlaceGhost() { return settings.placePreview !== 'off'; }
export function showClearHint() { return settings.placePreview === 'full'; }

// OS の「視差効果を減らす」が今 ON か。読み込み時の値ではなく、
// 実行中に切り替えられたら追随する（下の change 監視で更新している）。
export function prefersReducedMotion() { return reducedMotion; }

// 🎚️ 動きの「速さ」の係数。particleFactor は粒の数の係数なので、
// これだけを下げても1粒あたりの瞬きの速さは変わらず、体感はほとんど変わらない
// （背景の明滅・流れが「低」でも同じ速さで瞬いていた）。角速度にはこちらを掛ける。
// 「視差効果を減らす」なら 0 ＝ 動きが完全に止まる（粒そのものは消さない）。
export function motionFactor() {
  if (reducedMotion) return 0;
  return settings.particles === 'low' ? 0.45 : 1;
}

// 設定の変更／OS 側の変更を、画面が受け取れるようにする。
// 粒の数のように「作り直さないと反映されない」ものがあるので、
// 変わった瞬間を知る手段が要る（毎フレーム数え直すのは無駄）。
const settingSubs = new Set();
const motionSubs = new Set();

export function onSettingsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  settingSubs.add(fn);
  return () => settingSubs.delete(fn);
}

export function onReducedMotionChange(fn) {
  if (typeof fn !== 'function') return () => {};
  motionSubs.add(fn);
  return () => motionSubs.delete(fn);
}

// 購読側が投げても他の購読者と呼び出し元を巻き込まない。
function fire(subs, arg) {
  for (const fn of [...subs]) { try { fn(arg); } catch { /* 購読側の事故は握りつぶす */ } }
}

try {
  if (rmQuery) {
    const onRm = e => {
      const now = !!(e && typeof e.matches === 'boolean' ? e.matches : rmQuery.matches);
      if (now === reducedMotion) return;
      reducedMotion = now;
      // ここでは settings を書き換えない（上の hadSaved の約束）。
      fire(motionSubs, now);
    };
    if (typeof rmQuery.addEventListener === 'function') rmQuery.addEventListener('change', onRm);
    else if (typeof rmQuery.addListener === 'function') rmQuery.addListener(onRm);   // 旧 Safari
  }
} catch { /* 監視できない環境 -> 読み込み時の値のまま */ }

export function updateSettings(patch) {
  Object.assign(settings, patch);
  localStorage.setItem(KEY, JSON.stringify(settings));
  // 音の適用が転んでも購読側（背景装飾の粒数など）には必ず知らせる。
  // 片方の失敗で「設定を変えたのに絵だけ変わらない」を作らない。
  try { applySettings(); } finally { fire(settingSubs, settings); }
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
