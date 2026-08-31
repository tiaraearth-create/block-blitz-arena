// 🎬 プレイクリップの書き出し — SNS（Shorts / TikTok / Reels）用の縦型動画。
//
// なぜ別ファイルか: ytexport.js は「サントラのビジュアライザー」を録るためのもので、
// 録画の作法（Worker駆動タイマー・WakeLock・captureStream の分岐）はそのまま使えるが、
// 中身は showYouTubeStudio() という1つの巨大クロージャに閉じていて外から呼べない。
// 切り出して共通化するのが筋に見えるが、test/ytexport.test.mjs の約50件が
// **ytexport.js のソース文字列** に正規表現を当てる検査（例: wakeLock.request の
// 出現回数が1であること）なので、移動した瞬間に実装が正しいままCIが赤くなる。
// ここでは作法だけを引き写し、クリップに必要な形へ作り替える。
//
// ytexport との決定的な違い3点:
//   ① 録るのは #gameCanvas ではなく **自前の合成canvas**。GameView.resize() が
//      canvas.width を書き換えると captureStream のトラックが死ぬ（＝映像が途中で
//      止まった動画になる）。resize は ResizeObserver と描画ループの15フレーム保険から
//      呼ばれ、スマホのアドレスバーが伸縮しただけで走る。
//   ② 音は musicGain ではなく **audio.limiter** をタップする。musicGain だと
//      ライン消し・コンボ・破砕音が1つも入らない。クリップの快感は半分が音。
//   ③ タブが隠れたら即停止して保存する。隠れると render() が止まり（update だけ動く）、
//      Worker でフレームを送り続けても静止画が焼き込まれるだけになるため。
import { getViewRef, getCurrentMode, modeDisplayName } from './modes.js';
import { $, showModal, closeModal, toast, fmt } from './dom.js';
import { audio } from './audio.js';
import { t } from './i18n.js';
import { session } from './net.js';

// 出力プロファイル。ゲーム画面は色数が多くパーティクルで動きも激しいので、
// 低スペック端末では素直に解像度とビットレートを落とす
// （落とさないとエンコードがゲーム本体のフレームを食う）。
const PROFILES = {
  hi: { w: 1080, h: 1920, fps: 30, vbr: 6_000_000 },
  lo: { w: 720, h: 1280, fps: 20, vbr: 3_000_000 },
};
const pickProfile = () => {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  return (cores <= 4 || mem <= 4) ? PROFILES.lo : PROFILES.hi;
};

const MIME = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported)
  ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(x => MediaRecorder.isTypeSupported(x)) || null
  : null;

export const canRecordClip = () =>
  !!MIME && typeof HTMLCanvasElement !== 'undefined'
  && !!HTMLCanvasElement.prototype.captureStream;

const LENGTHS = [15, 30, 60];
let clip = null;          // 録画中の状態。同時に1本だけ。

// ---------------------------------------------------------------------------
// タイマー（ytexport.js の作法を引き写す）
//
// タブが隠れると rAF は止まり、ページの setInterval も1秒に制限される。
// Worker の setInterval はその制限を受けないので、フレーム送出と残り時間の計算を
// こちらに載せる。
// Blob Worker は **非同期に死ぬ** ── CSP が worker-src を許していないと
// コンストラクタは成功して返ってくるのに、そのあと onerror で止まり try/catch では
// 捕まえられない。だから onerror の退避と「300ms 経っても1回も動いていなければ退避」を
// **セットで** 持つ。片方だけだと「録画中の表示なのに何も起きない」で詰む。
// 逆に Worker と setInterval が両方動くと送出が二重になって映像が倍速に詰まるので、
// 退避するときは必ず先に terminate する。
function makeTicker(onTick) {
  let worker = null, timer = 0, ticked = 0;
  const fallback = () => {
    if (timer) return;
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
    timer = setInterval(() => { ticked++; onTick(); }, 33);
  };
  try {
    const src = 'setInterval(function(){postMessage(0)},33)';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);       // 読み込みは開始済み。捨てないと録画ごとに1つ残る
    worker.onmessage = () => { ticked++; onTick(); };
    worker.onerror = fallback;
  } catch { fallback(); }
  setTimeout(() => { if (ticked === 0) fallback(); }, 300);
  return {
    stop() {
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      if (timer) { clearInterval(timer); timer = 0; }
    },
  };
}

// 画面を眠らせない札。**常に1枚だけ**持つ。
// 解決を待っている間に録画が終わっていたらその場で返す。pending を戻し忘れると
// 2枚目以降が永久に取れなくなる（ytexport で実際に起きたバグの再発防止）。
async function takeWakeLock(state) {
  if (!navigator.wakeLock || state.wakeLock || state.wakeLockPending) return;
  state.wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (state.gone) { try { await lock.release(); } catch { /* ignore */ } }
    else state.wakeLock = lock;
  } catch { /* 取れない環境（iOS等）は諦める */ }
  finally { state.wakeLockPending = false; }
}

// ---------------------------------------------------------------------------
// 9:16 への合成
//
// 盤面canvas をそのまま録ると (a) Shorts の縦型に合わない (b) スコア・コンボ・
// 残り時間は **全部 DOM** なので数字が1つも映らない (c) URL が入らず宣伝にならない。
// 合成canvas を1枚持ち、背景と文字は録画開始時に1回だけ焼いてキャッシュ、
// 毎ティックは「キャッシュを貼る → 盤面を貼る → 動く数字だけ描く」の3手で済ませる。
// ---------------------------------------------------------------------------

function boardRect(view) {
  // 盤面＋手札を、演出がはみ出すぶんの余白ごと切り出す。
  // confetti は上へ大きく飛び、コンボの ring は盤面の 0.95 倍まで広がり、
  // 画面ゆれ中は ctx 全体が最大 ±11px ずれる。ぴったり切ると演出が欠ける。
  const m = Math.max(18, (view.cell || 20) * 1.6);
  const dpr = view.dpr || 1;
  const x = Math.max(0, view.boardX - m);
  const y = Math.max(0, view.boardY - m);
  const w = view.sideTray
    ? (view.trayX + view.trayW) - view.boardX + m * 2
    : view.boardSize + m * 2;
  const h = view.sideTray
    ? view.boardSize + m * 2
    : (view.trayY + view.trayH) - view.boardY + m * 2;
  return {
    sx: x * dpr,
    sy: y * dpr,
    sw: Math.min(view.canvas.width - x * dpr, w * dpr),
    sh: Math.min(view.canvas.height - y * dpr, h * dpr),
  };
}

function drawStatic(P, info) {
  const c = document.createElement('canvas');
  c.width = P.w; c.height = P.h;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, P.h);
  bg.addColorStop(0, '#141a2e'); bg.addColorStop(1, '#241a38');
  g.fillStyle = bg; g.fillRect(0, 0, P.w, P.h);
  g.textAlign = 'center';
  g.fillStyle = '#8fa0c4';
  g.font = `600 ${Math.round(P.w * 0.033)}px system-ui, sans-serif`;
  g.fillText('BLOCK BLITZ ARENA', P.w / 2, P.h * 0.055);
  g.fillStyle = '#ffffff';
  g.font = `bold ${Math.round(P.w * 0.05)}px system-ui, sans-serif`;
  g.fillText(info.mode, P.w / 2, P.h * 0.148);
  if (info.who) {
    g.fillStyle = '#7f8db0';
    g.font = `${Math.round(P.w * 0.03)}px system-ui, sans-serif`;
    g.fillText(info.who, P.w / 2, P.h * 0.185);
  }
  g.fillStyle = '#93a3c6';
  g.font = `600 ${Math.round(P.w * 0.036)}px system-ui, sans-serif`;
  g.fillText(info.host, P.w / 2, P.h * 0.955);
  return c;
}

function compose(state) {
  const { g, P, statik } = state;
  g.drawImage(statik, 0, 0);
  const view = getViewRef();
  const src = view && view.canvas;
  if (src && src.width && src.height) {
    const r = boardRect(view);
    // 盤面は縦位置 0.21〜0.91 の帯に、縦横比を保って収める。
    const top = P.h * 0.19, boxH = P.h * 0.74, boxW = P.w * 0.96;
    if (r.sw > 0 && r.sh > 0) {
      const scale = Math.min(boxW / r.sw, boxH / r.sh);
      const dw = r.sw * scale, dh = r.sh * scale;
      try {
        g.drawImage(src, r.sx, r.sy, r.sw, r.sh,
          (P.w - dw) / 2, top + (boxH - dh) / 2, dw, dh);
      } catch { /* リサイズの一瞬 width=0 になることがある。次のティックで戻る */ }
    }
  }
  // 動く数字。スコアもコンボも DOM 側にしか無いので、ここで焼かないと映らない。
  const mode = getCurrentMode();
  const e = mode && mode.engine;
  if (e) {
    g.textAlign = 'center';
    g.fillStyle = '#ffd93d';
    g.font = `bold ${Math.round(P.w * 0.1)}px system-ui, sans-serif`;
    g.fillText(fmt(Math.round(e.score || 0)), P.w / 2, P.h * 0.105);
    if ((e.streak || 0) >= 2) {
      g.fillStyle = '#ff8f4f';
      g.font = `bold ${Math.round(P.w * 0.044)}px system-ui, sans-serif`;
      g.fillText(`${e.streak} COMBO`, P.w / 2, P.h * 0.932);
    }
  }
}

// ---------------------------------------------------------------------------
// 録画
// ---------------------------------------------------------------------------

function removeBar() {
  const bar = document.getElementById('clipBar');
  if (bar) bar.remove();
}

function cleanup(state) {
  state.gone = true;
  if (state.ticker) { state.ticker.stop(); state.ticker = null; }
  if (state.onVis) { document.removeEventListener('visibilitychange', state.onVis); state.onVis = null; }
  if (state.screenObs) { state.screenObs.disconnect(); state.screenObs = null; }
  if (state.wakeLock) { try { state.wakeLock.release(); } catch { /* ignore */ } state.wakeLock = null; }
  if (state.tap) { try { audio.limiter.disconnect(state.tap); } catch { /* ignore */ } state.tap = null; }
  if (state.stream) { try { state.stream.getTracks().forEach(tr => tr.stop()); } catch { /* ignore */ } state.stream = null; }
  removeBar();
  if (clip === state) clip = null;
}

function stopClip(state) {
  if (!state || state.stopping) return;
  state.stopping = true;
  try { state.rec.stop(); } catch { cleanup(state); }
}

function showBar(state) {
  removeBar();
  const bar = document.createElement('div');
  bar.id = 'clipBar';
  bar.innerHTML = `<span id="clipLeft">●REC</span>
    <button class="btn btn-sm btn-ghost" id="clipStop">${t('⏹ 停止して保存', '⏹ Stop &amp; save')}</button>`;
  document.body.appendChild(bar);
  bar.querySelector('#clipStop').onclick = () => stopClip(state);
}

function modeTitle(mode) {
  return modeDisplayName(mode && mode.mode);
}

export function startClip(seconds) {
  if (clip) { toast(t('もう録画しています', 'Already recording'), '', 1800); return; }
  if (!canRecordClip()) {
    toast(t('この端末では録画に対応していません', 'Recording is not supported on this device'), 'err', 3000);
    return;
  }
  const view = getViewRef();
  const mode = getCurrentMode();
  if (!view || !mode || !view.canvas) {
    toast(t('ゲーム中に押してください', 'Start a game first'), '', 2200);
    return;
  }
  const P = pickProfile();
  const dur = LENGTHS.includes(seconds) ? seconds : 30;

  const out = document.createElement('canvas');   // DOMに挿さなくても captureStream は動く
  out.width = P.w; out.height = P.h;
  const g = out.getContext('2d');

  const state = {
    P, g, out, dur, gone: false, stopping: false,
    startedAt: 0, chunks: [], tap: null, wakeLock: null, wakeLockPending: false,
    statik: drawStatic(P, {
      mode: modeTitle(mode),
      host: location.host,
      who: session.user ? session.user.username : '',
    }),
  };

  // 音は limiter から取る。master をタップすると録音側だけリミッターを通らず、
  // 音量を上げている人の録音だけが割れる。musicGain だと効果音が1つも入らない。
  let dest = null;
  try {
    audio.ensure();
    dest = audio.ctx.createMediaStreamDestination();
    state.tap = audio.ctx.createGain();
    audio.limiter.connect(state.tap);
    state.tap.connect(dest);
  } catch { dest = null; state.tap = null; }

  // captureStream(0) + requestFrame なら、こちらが描いた瞬間だけ1枚送れる。
  // requestFrame が無い環境（Firefox）は fps 指定に落とす。
  const vs = out.captureStream(0);
  const firstTrack = vs.getVideoTracks()[0];
  state.manual = !!(firstTrack && typeof firstTrack.requestFrame === 'function');
  let stream = vs;
  if (!state.manual) {
    try { firstTrack.stop(); } catch { /* ignore */ }
    stream = out.captureStream(P.fps);
  }
  state.vTrack = stream.getVideoTracks()[0];
  if (dest) for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  state.stream = stream;

  try {
    state.rec = new MediaRecorder(stream, {
      mimeType: MIME, videoBitsPerSecond: P.vbr, audioBitsPerSecond: 192_000,
    });
  } catch {
    // 生成に失敗したら、音の乗っ取りを必ず解いてから諦める。
    if (state.tap) { try { audio.limiter.disconnect(state.tap); } catch { /* ignore */ } }
    try { stream.getTracks().forEach(tr => tr.stop()); } catch { /* ignore */ }
    toast(t('録画を開始できませんでした', 'Could not start recording'), 'err', 3000);
    return;
  }

  state.rec.ondataavailable = ev => { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
  state.rec.onstop = () => {
    const blob = new Blob(state.chunks, { type: 'video/webm' });
    state.chunks.length = 0;
    const title = modeTitle(mode);
    cleanup(state);
    if (!blob.size) {
      toast(t('録画データが空でした', 'The recording came out empty'), 'err', 3200);
      return;
    }
    showClipResult(blob, title);
  };

  clip = state;
  state.startedAt = Date.now();
  state.rec.start(1000);
  showBar(state);
  takeWakeLock(state);

  // 隠れたら即止める。隠れている間は render() が走らないので、
  // フレームを送り続けても静止画が焼き込まれるだけになる。
  state.onVis = () => { if (document.hidden) stopClip(state); };
  document.addEventListener('visibilitychange', state.onVis);

  // ゲーム画面から離れたら畳む。endToMenu は view.stop() を呼ぶだけなので、
  // 見張らないと凍った絵のまま録り続ける。
  state.screenObs = new MutationObserver(() => {
    if (document.body.dataset.screen !== 'game') stopClip(state);
  });
  state.screenObs.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

  state.ticker = makeTicker(() => {
    if (state.gone) return;
    const el = (Date.now() - state.startedAt) / 1000;
    compose(state);
    if (state.manual && state.vTrack && state.vTrack.requestFrame) state.vTrack.requestFrame();
    const left = document.getElementById('clipLeft');
    if (left) left.textContent = `●REC ${Math.max(0, Math.ceil(dur - el))}`;
    if (el >= dur) stopClip(state);
  });
  toast(t(`🎬 ${dur}秒 録画中`, `🎬 Recording ${dur}s`), 'ok', 1800);
  // 横持ち（PC・タブレット）だと盤面が横長の帯になり、縦型の枠に対して
  // 上下が大きく余る。同じ操作でも縦画面のほうが見栄えが段違いなので、
  // 1回だけ教える（毎回言うとうるさいので、この端末で一度きり）。
  if (view.sideTray && !localStorage.getItem('bba_clip_hint')) {
    try { localStorage.setItem('bba_clip_hint', '1'); } catch { /* ignore */ }
    setTimeout(() => toast(t('💡 スマホの縦画面で録ると、盤面が画面いっぱいに映ります',
      '💡 Recording on a portrait phone fills the frame much better'), '', 4200), 2200);
  }
}

// ---------------------------------------------------------------------------
// できあがったクリップ
// ---------------------------------------------------------------------------

function showClipResult(blob, mode) {
  const url = URL.createObjectURL(blob);
  const mb = (blob.size / 1048576).toFixed(1);
  // dismissable:false ── 背景タップで閉じられると Blob URL を解放できない。
  const m = showModal(`
    <h2>${t('🎬 クリップができました', '🎬 Clip ready')}</h2>
    <video src="${url}" controls playsinline autoplay muted loop
      style="width:100%;max-height:50vh;border-radius:12px;background:#000"></video>
    <p class="muted center" style="font-size:12px;margin:8px 0">
      ${mode} ・ ${mb}MB ・ webm<br>
      ${t('Shorts / TikTok にそのまま上げられます', 'Ready for Shorts / TikTok')}
    </p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="clipClose">${t('閉じる', 'Close')}</button>
      <button class="btn btn-share" id="clipShare">${t('📣 共有', '📣 Share')}</button>
      <button class="btn btn-primary" id="clipSave">${t('⬇ 保存', '⬇ Save')}</button>
    </div>`, { dismissable: false });

  m.querySelector('#clipClose').onclick = () => { URL.revokeObjectURL(url); closeModal(); };
  m.querySelector('#clipSave').onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `block-blitz-${Date.now()}.webm`;
    document.body.appendChild(a);      // 挿してから click することを要求する環境がある
    a.click();
    a.remove();
    toast(t('保存しました', 'Saved'), 'ok', 2000);
  };
  m.querySelector('#clipShare').onclick = async () => {
    const text = t(
      `Block Blitz Arena の${mode}！\n無料・登録なしでブラウザで遊べます 👇\n${location.origin}/?ref=clip\n#BlockBlitzArena`,
      `${mode} on Block Blitz Arena!\nFree in your browser, no signup 👇\n${location.origin}/?ref=clip\n#BlockBlitzArena`);
    try {
      const file = new File([blob], 'block-blitz-clip.webm', { type: 'video/webm' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title: 'Block Blitz Arena' });
        return;
      }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    // 動画を渡せない環境では、文面だけでも持たせる（動画は「⬇ 保存」から）。
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast(t('📋 文面をコピーしました。動画は「⬇ 保存」から', '📋 Text copied — save the video with ⬇'), 'ok', 3400);
        return;
      }
    } catch { /* 下へ */ }
    toast(t('この端末では共有できません。「⬇ 保存」をお使いください', 'Sharing is unavailable — use ⬇ Save'), '', 3400);
  };
}

// ---------------------------------------------------------------------------
// HUD の 🎬 ボタン
// ---------------------------------------------------------------------------

export function initClipHud() {
  const btn = $('#btnClip');
  if (!btn) return;
  // 録れない端末では出さない（押しても何も起きないボタンは不信を生む）。
  if (!canRecordClip()) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.onclick = () => {
    if (clip) { stopClip(clip); return; }
    // モーダルは盤面を隠す＝録りたいものが消えるので、既定の長さで即開始する。
    startClip(30);
  };
  // 長押し / 右クリックで長さを選ぶ（録画前だけ）。
  btn.oncontextmenu = ev => {
    ev.preventDefault();
    if (clip) return;
    const m = showModal(`
      <h2>${t('🎬 クリップの長さ', '🎬 Clip length')}</h2>
      <p class="muted center" style="font-size:12px">${t('SNS向けの縦型動画で書き出します', 'Exports a vertical video for social')}</p>
      <div class="modal-buttons">
        ${LENGTHS.map(n => `<button class="btn btn-primary" data-len="${n}">${n}${t('秒', 's')}</button>`).join('')}
      </div>`);
    m.querySelectorAll('[data-len]').forEach(b => {
      b.onclick = () => { closeModal(); startClip(Number(b.dataset.len)); };
    });
  };
}

export function clipBusy() { return !!clip; }
