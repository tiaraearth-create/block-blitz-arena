// 🎬 YouTube スタジオ — サウンドトラックを「そのままYouTubeにアップできる」
// 動画ファイル(webm: 映像+音声)として書き出す。
//
// 仕組み: ジュークボックスの試聴システム(最優先trackソース)で曲を実時間再生
// しながら、musicGain を MediaStreamAudioDestinationNode へタップし、720pの
// ビジュアライザーCanvas(captureStream)と合流させて MediaRecorder で録画する。
// 音はWebAudioの完全合成なので、録れたものがゲーム内とビット単位で同じ音。
// おまけ: サムネイルPNGの書き出しと、コピペ用のタイトル/説明文も用意。
import { audio, TRACK_INFO } from './audio.js';
import { showModal, closeModal, toast } from './dom.js';
import { t } from './i18n.js';

const W = 1280, H = 720;
const GAME_URL = 'https://block-blitz-arena.onrender.com';

// 曲ごとの雰囲気カラー（背景グラデ + EQバー）
const MOODS = {
  menu: ['#141a33', '#0b0e1f', '#5b8bff'], solo: ['#16324a', '#081521', '#43d9e8'],
  battle: ['#3a1430', '#12060f', '#ff6bd4'], hard: ['#40180c', '#150602', '#ff8a5c'],
  boss: ['#2a0d12', '#0d0306', '#ff5d5d'], oni: ['#33070f', '#100205', '#ff3b4d'],
  pixel: ['#0f2e18', '#04140a', '#5ee86e'], kami: ['#4a3a10', '#171004', '#ffd75e'],
  ruins: ['#20332a', '#0a1410', '#7cf5c8'], mine: ['#2e2013', '#120a04', '#ffb02e'],
  royal: ['#3c2a58', '#140a22', '#ffd75e'],
};
const moodOf = id => MOODS[id] || (id.startsWith('blast') ? ['#1c2440', '#0a0d1c', '#8ab4ff'] : MOODS.menu);

let studioState = null;   // { raf, analyser, dest, rec, timer } — 掃除用

function stopStudio() {
  if (!studioState) return;
  const s = studioState;
  studioState = null;
  cancelAnimationFrame(s.raf);
  clearInterval(s.timer);
  try { if (s.rec && s.rec.state !== 'inactive') s.rec.stop(); } catch { /* already stopped */ }
  try { if (s.analyser) audio.musicGain.disconnect(s.analyser); } catch { /* not connected */ }
  try { if (s.dest) audio.musicGain.disconnect(s.dest); } catch { /* not connected */ }
  audio.stopPreview();
}

function drawFrame(ctx2d, info, an, freqBuf, elapsed, total, recording) {
  const [c1, c2, accent] = moodOf(info.id);
  const g = ctx2d.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  ctx2d.fillStyle = g;
  ctx2d.fillRect(0, 0, W, H);

  const now = performance.now() / 1000;
  // 浮遊パーティクル
  for (let i = 0; i < 26; i++) {
    const px = ((i * 197) % W + now * (8 + (i % 5) * 4)) % W;
    const py = (i * 131 + Math.sin(now * 0.5 + i) * 30) % H;
    ctx2d.globalAlpha = 0.10 + 0.08 * Math.sin(now + i);
    ctx2d.fillStyle = accent;
    ctx2d.beginPath();
    ctx2d.arc(px, py, 2 + (i % 3), 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.globalAlpha = 1;

  // EQバー（下部）
  if (an) {
    an.getByteFrequencyData(freqBuf);
    const bars = 48;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const v = freqBuf[Math.floor(i * (freqBuf.length * 0.7) / bars)] / 255;
      const bh = 24 + v * 210;
      ctx2d.globalAlpha = 0.75;
      ctx2d.fillStyle = accent;
      ctx2d.fillRect(i * bw + 3, H - 60 - bh, bw - 6, bh);
      ctx2d.globalAlpha = 0.22;
      ctx2d.fillRect(i * bw + 3, H - 58, bw - 6, 22);   // 反射
    }
    ctx2d.globalAlpha = 1;
  }

  // タイトル類
  ctx2d.textAlign = 'center';
  ctx2d.fillStyle = 'rgba(255,255,255,0.92)';
  ctx2d.font = '700 30px system-ui, sans-serif';
  ctx2d.fillText('BLOCK BLITZ ARENA — ORIGINAL SOUNDTRACK', W / 2, 86);
  ctx2d.font = '110px system-ui, sans-serif';
  ctx2d.fillText(info.icon, W / 2, 250);
  ctx2d.font = '800 64px system-ui, sans-serif';
  ctx2d.fillStyle = '#ffffff';
  ctx2d.fillText(info.name, W / 2, 350);
  ctx2d.font = '500 34px system-ui, sans-serif';
  ctx2d.fillStyle = accent;
  ctx2d.fillText(`${info.nameEn} ・ ${info.bpm} BPM`, W / 2, 402);

  // 録画プログレス
  if (recording && total > 0) {
    const p = Math.min(1, elapsed / total);
    ctx2d.fillStyle = 'rgba(255,255,255,0.18)';
    ctx2d.fillRect(140, H - 28, W - 280, 8);
    ctx2d.fillStyle = accent;
    ctx2d.fillRect(140, H - 28, (W - 280) * p, 8);
  }
}

export function showYouTubeStudio() {
  audio.ensure();
  if (!audio.ctx || !audio.musicGain) {
    toast(t('画面を一度タップしてから開いてください（音声の準備中）', 'Tap the screen once first (audio is warming up)'), 'err', 2500);
    return;
  }
  const canRecord = typeof MediaRecorder !== 'undefined' && HTMLCanvasElement.prototype.captureStream;

  let sel = TRACK_INFO[0].id;
  let dur = 120;
  const m = showModal(`
    <h2>🎬 ${t('YouTube スタジオ', 'YouTube Studio')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">
      ${t('サントラを<b>そのままYouTubeにアップできる動画</b>（映像＋音声・最高音質320kbps）として書き出します。録画は実時間です。',
          'Export the soundtrack as a <b>ready-to-upload YouTube video</b> (visuals + audio, top-quality 320kbps). Recording runs in real time.')}
    </p>
    <canvas id="ytCanvas" width="${W}" height="${H}" style="width:100%;border-radius:10px;border:1px solid rgba(255,255,255,0.15)"></canvas>
    <div class="settings-row" style="margin-top:8px">
      <label>🎵 ${t('曲', 'Track')}</label>
      <select id="ytTrack" style="max-width:210px">${TRACK_INFO.map(x => `<option value="${x.id}">${x.icon} ${t(x.name, x.nameEn)}</option>`).join('')}</select>
    </div>
    <div class="settings-row">
      <label>⏱️ ${t('長さ', 'Length')}</label>
      <span class="seg" id="ytDur">
        <button data-d="30">30${t('秒', 's')}</button>
        <button data-d="60">1${t('分', 'min')}</button>
        <button data-d="120" class="active">2${t('分', 'min')}</button>
        <button data-d="180">3${t('分', 'min')}</button>
      </span>
    </div>
    <p id="ytStatus" class="muted center" style="font-size:12px;min-height:16px"></p>
    <div class="modal-buttons" style="flex-wrap:wrap">
      <button class="btn btn-ghost" id="ytClose">${t('閉じる', 'Close')}</button>
      <button class="btn btn-ghost" id="ytThumb">🖼️ ${t('サムネ保存', 'Thumbnail')}</button>
      <button class="btn btn-ghost" id="ytCopy">📋 ${t('タイトル&説明', 'Title & desc')}</button>
      <button class="btn btn-primary" id="ytRec" ${canRecord ? '' : 'disabled'}>🔴 ${t('録画開始', 'Record')}</button>
    </div>
    ${canRecord ? '' : `<p class="muted center" style="font-size:11px">${t('このブラウザは録画非対応です（Chrome推奨）', 'This browser cannot record (use Chrome)')}</p>`}
  `, { dismissable: false });

  const canvas = m.querySelector('#ytCanvas');
  const ctx2d = canvas.getContext('2d');

  // アナライザーは常時接続（プレビューでもEQが動く）
  const analyser = audio.ctx.createAnalyser();
  analyser.fftSize = 256;
  const freqBuf = new Uint8Array(analyser.frequencyBinCount);
  audio.musicGain.connect(analyser);

  studioState = { raf: 0, analyser, dest: null, rec: null, timer: 0 };
  let recording = false, recStart = 0;

  const loop = () => {
    if (!studioState) return;
    const info = TRACK_INFO.find(x => x.id === sel) || TRACK_INFO[0];
    drawFrame(ctx2d, info, analyser, freqBuf, recording ? (performance.now() - recStart) / 1000 : 0, dur, recording);
    studioState.raf = requestAnimationFrame(loop);
  };
  loop();

  const status = msg => { m.querySelector('#ytStatus').textContent = msg; };
  const preview = () => { audio.preview(sel); };
  preview();   // 開いた瞬間から選択曲が流れる

  m.querySelector('#ytTrack').onchange = e => { sel = e.target.value; if (!recording) preview(); };
  m.querySelectorAll('#ytDur button').forEach(b => {
    b.onclick = () => {
      if (recording) return;
      m.querySelectorAll('#ytDur button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      dur = Number(b.dataset.d);
    };
  });

  const download = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  m.querySelector('#ytThumb').onclick = () => {
    canvas.toBlob(b => { if (b) { download(b, `bba-ost-${sel}-thumbnail.png`); toast(t('🖼️ サムネイルを保存しました', '🖼️ Thumbnail saved'), 'ok', 2000); } }, 'image/png');
  };

  m.querySelector('#ytCopy').onclick = async () => {
    const info = TRACK_INFO.find(x => x.id === sel);
    const text = `【Block Blitz Arena OST】${info.name} (${info.nameEn})\n\n` +
      `ブロックパズルゲーム「Block Blitz Arena」のオリジナルサウンドトラックです。\n` +
      `The original soundtrack of the puzzle game "Block Blitz Arena".\n\n` +
      `🎮 いますぐ遊ぶ / Play free: ${GAME_URL}\n` +
      `🎵 ${info.bpm} BPM ・ WebAudioによる完全合成（音声素材なし）\n\n` +
      `#BlockBlitzArena #ゲーム音楽 #GameMusic #chiptune #OST`;
    try {
      await navigator.clipboard.writeText(text);
      toast(t('📋 タイトルと説明文をコピーしました', '📋 Title & description copied'), 'ok', 2200);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast(t('📋 コピーしました', '📋 Copied'), 'ok', 2000);
    }
  };

  const btnRec = m.querySelector('#ytRec');
  let currentRec = null;
  let fadeArmed = false;

  const startRec = () => {
    if (!studioState) return;
    const wasMusicOn = audio.musicOn;
    audio.setMusicEnabled(true);
    preview();
    const dest = audio.ctx.createMediaStreamDestination();
    audio.musicGain.connect(dest);
    studioState.dest = dest;
    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    // 最高音質: opus 320kbps + 6Mbps 映像（YouTubeの再エンコードに強い）
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 320_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      clearInterval(studioState && studioState.timer);
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (blob.size > 0) {
        download(blob, `bba-ost-${sel}-${dur}s.webm`);
        toast(t('🎬 動画を保存しました！このままYouTubeにアップできます', '🎬 Video saved — upload it to YouTube as-is!'), 'ok', 4500);
      }
      // フェードアウトを解除して音量を元に戻す（エンジンは 0.45×musicVol で駆動）
      try {
        audio.musicGain.gain.cancelScheduledValues(audio.ctx.currentTime);
        audio.musicGain.gain.value = 0.45 * audio.musicVol;
      } catch { /* engine owns it */ }
      try { audio.musicGain.disconnect(dest); } catch { /* ok */ }
      if (studioState) studioState.dest = null;
      if (!wasMusicOn) audio.setMusicEnabled(false);
      recording = false;
      currentRec = null;
      fadeArmed = false;
      btnRec.textContent = `🔴 ${t('録画開始', 'Record')}`;
      m.querySelector('#ytClose').disabled = false;
      status('');
    };
    studioState.rec = currentRec = rec;
    rec.start(1000);
    recording = true;
    fadeArmed = false;
    recStart = performance.now();
    btnRec.textContent = `⏹ ${t('停止して保存', 'Stop & save')}`;
    m.querySelector('#ytClose').disabled = true;
    studioState.timer = setInterval(() => {
      if (!studioState || rec.state === 'inactive') return;
      const el = (performance.now() - recStart) / 1000;
      status(t(`🔴 録画中… ${Math.floor(el)} / ${dur}秒（そのままお待ちください）`, `🔴 Recording… ${Math.floor(el)} / ${dur}s (please wait)`));
      // 最後の1.5秒はフェードアウト（動画の終わりがブツ切りにならない）
      if (!fadeArmed && el >= dur - 1.5) {
        fadeArmed = true;
        try {
          audio.musicGain.gain.setValueAtTime(audio.musicGain.gain.value, audio.ctx.currentTime);
          audio.musicGain.gain.linearRampToValueAtTime(0.0001, audio.ctx.currentTime + Math.max(0.2, dur - el));
        } catch { /* ok */ }
      }
      if (el >= dur) rec.stop();
    }, 250);
  };

  btnRec.onclick = () => {
    if (recording) {
      if (currentRec && currentRec.state !== 'inactive') currentRec.stop();
      return;
    }
    startRec();
  };

  m.querySelector('#ytClose').onclick = () => {
    stopStudio();
    closeModal();
  };
}
