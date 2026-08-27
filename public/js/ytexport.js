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
import { ghostUnlocked } from './modes.js';

// 📐 出力の形。横型は普通のYouTube、縦型は YouTube ショート／TikTok／Reels。
// ショート系はどこも 9:16 が正で、これを外すと上下に黒帯が入るか、
// 中央を勝手に切り抜かれて文字が欠ける。
const FORMATS = {
  wide:  { w: 1280, h: 720,  label: '横型', labelEn: 'Wide', note: 'YouTube', durs: [30, 60, 120, 180] },
  short: { w: 1080, h: 1920, label: '縦型', labelEn: 'Vertical', note: 'ショート / TikTok / Reels', durs: [15, 30, 45, 60] },
};
// 既定は横型。W/H は「いま選んでいる形」で、下の drawFrame が参照する。
let FMT = FORMATS.wide;
let W = FMT.w, H = FMT.h;
function setFormat(key) {
  FMT = FORMATS[key] || FORMATS.wide;
  W = FMT.w; H = FMT.h;
  return FMT;
}
const GAME_URL = 'https://block-blitz-arena.onrender.com';

// 曲ごとの雰囲気カラー（背景グラデ + EQバー）
const MOODS = {
  menu: ['#141a33', '#0b0e1f', '#5b8bff'], solo: ['#16324a', '#081521', '#43d9e8'],
  battle: ['#3a1430', '#12060f', '#ff6bd4'], hard: ['#40180c', '#150602', '#ff8a5c'],
  boss: ['#2a0d12', '#0d0306', '#ff5d5d'], oni: ['#33070f', '#100205', '#ff3b4d'],
  pixel: ['#0f2e18', '#04140a', '#5ee86e'], kami: ['#4a3a10', '#171004', '#ffd75e'],
  ruins: ['#20332a', '#0a1410', '#7cf5c8'], mine: ['#2e2013', '#120a04', '#ffb02e'],
  royal: ['#3c2a58', '#140a22', '#ffd75e'], ghost: ['#1e1b4b', '#0b0a1a', '#a78bfa'],
};
const moodOf = id => MOODS[id] || (id.startsWith('blast') ? ['#1c2440', '#0a0d1c', '#8ab4ff'] : MOODS.menu);

let studioState = null;   // { raf, analyser, dest, rec, timer, worker, wakeLock, onVis } — 掃除用

// バックグラウンドでも止まらないタイマー: rAFはタブが隠れると停止し、
// ページのsetIntervalも1秒に制限されるが、Worker内のタイマーは動き続ける。
// 録画中の描画とフレーム送出はこのWorkerが駆動する。
// ⚠️ Blob から作った Worker は **非同期に** 死ぬことがある。
// CSP が worker-src を許していないと、コンストラクタは成功して返ってくるのに
// そのあと onerror で止まる。try/catch では捕まえられないので、
// 「Worker が返ってきた＝動いている」と信じてはいけない。
// 実際にこれで録画が丸ごと死んでいた（描画もフレーム送出も進行管理も
// この Worker が駆動しているため、状態表示が空のまま何も起きなくなる）。
function makeTickWorker(onTick, onFail) {
  try {
    const src = 'let iv=null;onmessage=e=>{if(e.data==="start"&&!iv)iv=setInterval(()=>postMessage(0),33);if(e.data==="stop"&&iv){clearInterval(iv);iv=null}}';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = onTick;
    w.onerror = () => { try { w.terminate(); } catch { /* gone */ } if (onFail) onFail(); };
    w.postMessage('start');
    return w;
  } catch { if (onFail) onFail(); return null; }
}

function stopStudio() {
  if (!studioState) return;
  const s = studioState;
  studioState = null;
  cancelAnimationFrame(s.raf);
  clearInterval(s.timer);
  if (s.gone) { try { s.gone.disconnect(); } catch { /* gone */ } }
  if (s.worker) { try { s.worker.postMessage('stop'); s.worker.terminate(); } catch { /* gone */ } }
  if (s.wakeLock) { try { s.wakeLock.release(); } catch { /* released */ } }
  if (s.stream) { try { s.stream.getTracks().forEach(tr => tr.stop()); } catch { /* ok */ } }
  if (s.onVis) document.removeEventListener('visibilitychange', s.onVis);
  audio.lookahead = 0.35;
  try { if (s.rec && s.rec.state !== 'inactive') s.rec.stop(); } catch { /* already stopped */ }
  try { if (s.analyser) audio.musicGain.disconnect(s.analyser); } catch { /* not connected */ }
  try { if (s.dest) audio.musicGain.disconnect(s.dest); } catch { /* not connected */ }
  audio.stopPreview();
}

function drawFrame(ctx2d, info, an, freqBuf, elapsed, total, recording) {
  const [c1, c2, accent] = moodOf(info.id);
  const tall = H > W;                    // 縦型（ショート）か
  const k = tall ? W / 1080 : W / 1280;  // 文字とバーの倍率（幅を基準にする）

  const g = ctx2d.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  ctx2d.fillStyle = g;
  ctx2d.fillRect(0, 0, W, H);

  const now = performance.now() / 1000;
  // 浮遊パーティクル。縦は面積が広いので数を増やさないとスカスカに見える。
  const dots = tall ? 44 : 26;
  for (let i = 0; i < dots; i++) {
    const px = ((i * 197) % W + now * (8 + (i % 5) * 4)) % W;
    const py = (i * 131 + Math.sin(now * 0.5 + i) * 30) % H;
    ctx2d.globalAlpha = 0.10 + 0.08 * Math.sin(now + i);
    ctx2d.fillStyle = accent;
    ctx2d.beginPath();
    ctx2d.arc(px, py, (2 + (i % 3)) * k, 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.globalAlpha = 1;

  // EQバー。縦型は画面のまんなかに置く ── ショートは下端に再生バーや
  // アカウント名が重なるので、下に置くと隠れる。
  const eqBase = tall ? H * 0.72 : H - 60;
  if (an) {
    an.getByteFrequencyData(freqBuf);
    const bars = tall ? 32 : 48;
    const bw = W / bars;
    const maxH = tall ? 320 * k : 210;
    for (let i = 0; i < bars; i++) {
      const v = freqBuf[Math.floor(i * (freqBuf.length * 0.7) / bars)] / 255;
      const bh = 24 * k + v * maxH;
      ctx2d.globalAlpha = 0.75;
      ctx2d.fillStyle = accent;
      ctx2d.fillRect(i * bw + 3, eqBase - bh, bw - 6, bh);
      ctx2d.globalAlpha = 0.22;
      ctx2d.fillRect(i * bw + 3, eqBase + 2, bw - 6, 22 * k);   // 反射
    }
    ctx2d.globalAlpha = 1;
  }

  // タイトル類。縦型は上下の端を大きく空ける ── ショートは上に
  // タイトル、下に説明とボタンが乗るので、そこに置くと必ず隠れる。
  ctx2d.textAlign = 'center';
  const topY = tall ? H * 0.20 : 86;
  ctx2d.fillStyle = 'rgba(255,255,255,0.92)';
  ctx2d.font = `700 ${Math.round((tall ? 34 : 30) * k)}px system-ui, sans-serif`;
  ctx2d.fillText(tall ? 'BLOCK BLITZ ARENA' : 'BLOCK BLITZ ARENA — ORIGINAL SOUNDTRACK', W / 2, topY);
  if (tall) {
    ctx2d.font = `600 ${Math.round(24 * k)}px system-ui, sans-serif`;
    ctx2d.fillStyle = accent;
    ctx2d.fillText('ORIGINAL SOUNDTRACK', W / 2, topY + 40 * k);
  }
  ctx2d.fillStyle = 'rgba(255,255,255,0.92)';
  ctx2d.font = `${Math.round((tall ? 150 : 110) * k)}px system-ui, sans-serif`;
  ctx2d.fillText(info.icon, W / 2, tall ? H * 0.34 : 250);
  // 曲名は遊んでいる言語のほうを大きく出す。英語で遊んでいても
  // 日本語しか出ていなかった（下の行と同じ文字が2回並ぶこともあった）。
  const primary = t(info.name, info.nameEn);
  const secondary = t(info.nameEn, info.name);
  ctx2d.font = `800 ${Math.round((tall ? 78 : 64) * k)}px system-ui, sans-serif`;
  ctx2d.fillStyle = '#ffffff';
  ctx2d.fillText(primary, W / 2, tall ? H * 0.42 : 350);
  ctx2d.font = `500 ${Math.round((tall ? 38 : 34) * k)}px system-ui, sans-serif`;
  ctx2d.fillStyle = accent;
  ctx2d.fillText(secondary === primary ? `${info.bpm} BPM` : `${secondary} ・ ${info.bpm} BPM`, W / 2, tall ? H * 0.47 : 402);
  // 縦型だけ、遊べる場所を焼き込む（ショートは説明文を読まれない）
  if (tall) {
    ctx2d.font = `600 ${Math.round(26 * k)}px system-ui, sans-serif`;
    ctx2d.fillStyle = 'rgba(255,255,255,0.62)';
    ctx2d.fillText('block-blitz-arena.onrender.com', W / 2, H * 0.80);
  }

  // 録画プログレス
  if (recording && total > 0) {
    const p = Math.min(1, elapsed / total);
    const pad = tall ? 90 : 140;
    const y = tall ? H * 0.86 : H - 28;
    ctx2d.fillStyle = 'rgba(255,255,255,0.18)';
    ctx2d.fillRect(pad, y, W - pad * 2, 8 * k);
    ctx2d.fillStyle = accent;
    ctx2d.fillRect(pad, y, (W - pad * 2) * p, 8 * k);
  }
}

export function showYouTubeStudio() {
  // 前のスタジオが生き残っていたら必ず畳んでから開く。
  // 畳まないと、前回の描画ループとアナライザーが繋がったまま残り、
  // 開くたびに増えていく。
  stopStudio();
  audio.ensure();
  if (!audio.ctx || !audio.musicGain) {
    toast(t('画面を一度タップしてから開いてください（音声の準備中）', 'Tap the screen once first (audio is warming up)'), 'err', 2500);
    return;
  }
  // 実際に書き出せる形式を先に決める。MediaRecorder と captureStream が
  // 「ある」だけでは足りない ── Safari は両方あるのに webm を録れないので、
  // ボタンが押せてしまい、押すとコンストラクタが例外を投げて何も起きない。
  // しかもそのとき音楽は強制ONにされたまま残っていた。
  const MIME = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported)
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(x => MediaRecorder.isTypeSupported(x)) || null
    : null;
  const canRecord = !!MIME && !!HTMLCanvasElement.prototype.captureStream;
  const tracks = TRACK_INFO.filter(x => !x.hidden || ghostUnlocked());

  let sel = tracks[0].id;
  setFormat('wide');          // 開いたときは必ず横型から
  let dur = 120;
  const m = showModal(`
    <h2>🎬 ${t('YouTube スタジオ', 'YouTube Studio')}</h2>
    <p class="muted center" style="font-size:12px;margin-bottom:8px">
      ${t('サントラを<b>そのままYouTubeにアップできる動画</b>（映像＋音声・最高音質320kbps）として書き出します。録画は実時間です。',
          'Export the soundtrack as a <b>ready-to-upload YouTube video</b> (visuals + audio, top-quality 320kbps). Recording runs in real time.')}
    </p>
    <div class="yt-stage"><canvas id="ytCanvas" width="${W}" height="${H}"></canvas></div>
    <div class="settings-row" style="margin-top:8px">
      <label>📐 ${t('形', 'Format')}</label>
      <span class="seg" id="ytFmt">
        <button data-f="wide" class="active">🖥️ ${t('横型', 'Wide')} 16:9</button>
        <button data-f="short">📱 ${t('縦型', 'Vertical')} 9:16</button>
      </span>
    </div>
    <p id="ytFmtNote" class="muted center" style="font-size:11px;margin:-2px 0 6px">1280×720 ・ YouTube</p>
    <div class="settings-row">
      <label>🎵 ${t('曲', 'Track')}</label>
      <select id="ytTrack" style="max-width:210px">${tracks.map(x => `<option value="${x.id}">${x.icon} ${t(x.name, x.nameEn)}</option>`).join('')}</select>
    </div>
    <div class="settings-row">
      <label>⏱️ ${t('長さ', 'Length')}</label>
      <span class="seg" id="ytDur"></span>
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

  const draw = () => {
    const info = tracks.find(x => x.id === sel) || tracks[0];
    drawFrame(ctx2d, info, analyser, freqBuf, recording ? (performance.now() - recStart) / 1000 : 0, dur, recording);
  };
  // プレビュー中はrAFで滑らかに。録画中はWorkerが描画を駆動する（下記）。
  const loop = () => {
    if (!studioState) return;
    if (!recording) draw();
    studioState.raf = requestAnimationFrame(loop);
  };
  loop();

  // 長さの選択肢は形で変わる。ショートは60秒までが実質の上限なので、
  // 3分を出したままにしておくと「選べるのに使えない」ものが並ぶ。
  const durLabel = sec => (sec % 60 === 0 && sec >= 60
    ? `${sec / 60}${t('分', 'min')}`
    : `${sec}${t('秒', 's')}`);
  const renderDurs = () => {
    const box = m.querySelector('#ytDur');
    if (!FMT.durs.includes(dur)) dur = FMT.durs[FMT.durs.length - 1];
    box.innerHTML = FMT.durs.map(d =>
      `<button data-d="${d}" class="${d === dur ? 'active' : ''}">${durLabel(d)}</button>`).join('');
    box.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        if (recording || starting) return;
        box.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        dur = Number(b.dataset.d);
      };
    });
  };

  const applyFormat = (key) => {
    const f = setFormat(key);
    canvas.width = f.w; canvas.height = f.h;
    // プレビューの見た目も縦横で変える（縦のときに横長の箱に入れない）
    canvas.style.aspectRatio = `${f.w} / ${f.h}`;
    m.querySelector('#ytFmtNote').textContent = `${f.w}×${f.h} ・ ${key === 'short' ? t('ショート / TikTok / Reels', 'Shorts / TikTok / Reels') : 'YouTube'}`;
    m.querySelectorAll('#ytFmt button').forEach(x => x.classList.toggle('active', x.dataset.f === key));
    renderDurs();
    draw();
  };

  const status = msg => { m.querySelector('#ytStatus').textContent = msg; };
  const preview = () => { audio.preview(sel); };
  preview();   // 開いた瞬間から選択曲が流れる

  const trackSel = m.querySelector('#ytTrack');
  trackSel.onchange = e => {
    // 録画中は曲を変えさせない。変えると sel だけが動いて、
    // 映像は新しい曲・音は古い曲・ファイル名も新しい曲、という
    // ちぐはぐな動画が出来上がる（音は preview() を呼ばないので変わらない）。
    if (recording || starting) {
      e.target.value = sel;
      toast(t('録画中は曲を変えられません', 'You cannot change track while recording'), 'err', 2200);
      return;
    }
    sel = e.target.value;
    preview();
  };
  m.querySelectorAll('#ytFmt button').forEach(b => {
    b.onclick = () => {
      // 録画中に形を変えると、canvas を作り直すことになって
      // captureStream のトラックが死ぬ（映像が途中で止まった動画になる）。
      if (recording || starting) {
        toast(t('録画中は形を変えられません', 'You cannot change format while recording'), 'err', 2200);
        return;
      }
      applyFormat(b.dataset.f);
    };
  });
  applyFormat('wide');

  const download = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  m.querySelector('#ytThumb').onclick = () => {
    // 録画中に押すと進行バーごと写るので、別紙に描き直してから出す。
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    drawFrame(off.getContext('2d'), tracks.find(x => x.id === sel) || tracks[0], analyser, freqBuf, 0, 0, false);
    off.toBlob(b => { if (b) { download(b, `bba-ost-${sel}-${W}x${H}-thumbnail.png`); toast(t('🖼️ サムネイルを保存しました', '🖼️ Thumbnail saved'), 'ok', 2000); } }, 'image/png');
  };

  m.querySelector('#ytCopy').onclick = async () => {
    const info = tracks.find(x => x.id === sel);
    const text = `【Block Blitz Arena OST】${info.name} (${info.nameEn})\n\n` +
      `ブロックパズルゲーム「Block Blitz Arena」のオリジナルサウンドトラックです。\n` +
      `The original soundtrack of the puzzle game "Block Blitz Arena".\n\n` +
      `🎮 いますぐ遊ぶ / Play free: ${GAME_URL}\n` +
      `🎵 ${info.bpm} BPM ・ WebAudioによる完全合成（音声素材なし）\n\n` +
      // 縦型のときは #Shorts を先頭に付ける。YouTube はこのタグを
      // ショート判定の手がかりにするので、付け忘れると9:16でも
      // 普通の動画として扱われることがある。
      (FMT === FORMATS.short
        ? `#Shorts #BlockBlitzArena #ゲーム音楽 #GameMusic #chiptune #OST`
        : `#BlockBlitzArena #ゲーム音楽 #GameMusic #chiptune #OST`);
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
  // 「押したけどまだ録画は始まっていない」状態。頭出しの待ち時間のあいだ、
  // recording はまだ false なので、曲や形の切り替えが素通りしてしまう。
  let starting = false;

  // 🎯 頭出しの下ごしらえ。
  // audio.restart() が止められるのは「これから予約する音」だけで、すでに
  // AudioContext に積んだ音までは止められない。スタジオを開いた瞬間から
  // 試聴が流れているので、そのまま録り始めると **前の小節の残りが
  // 1小節目にかぶった状態** で頭が始まる。
  // 「試聴を止める → 予約ずみが鳴り終わるのを待つ → 録画と同時に1小節目から」
  // の順にすれば、頭がきれいになる。待つのは先読みぶん＋余裕。
  const startRec = () => {
    if (!studioState) return;
    if (recording) return;
    if (!MIME) {
      toast(t('このブラウザは録画に対応していません（Chrome推奨）', 'This browser cannot record (use Chrome)'), 'err', 3500);
      return;
    }
    const session = studioState;
    // stopPreview() ではなく hush()。stopPreview() は「試聴をやめる」だけなので、
    // 固定曲や画面のBGMに落ちて **別の曲が鳴り出す** ── 静かにするどころか、
    // 待っている間にメニュー曲が頭に混ざる。hush() は予約だけ止める。
    audio.hush();
    starting = true;              // recording はまだ false。この間も操作を止める
    status(t('準備中…', 'Getting ready…'));
    btnRec.disabled = true;
    setTimeout(() => {
      btnRec.disabled = false;
      starting = false;
      if (studioState !== session || recording) { status(''); return; }   // 待つ間に閉じられた
      beginRec();
    }, Math.round((audio.lookahead || 0.35) * 1000) + 120);
  };

  const beginRec = () => {
    if (!studioState) { status(''); return; }
    if (!MIME) {
      // ここに来るのは canRecord を無視して押された場合だけだが、
      // 例外を投げて音楽を掴んだまま放置するよりは、断って何もしない。
      status('');
      toast(t('このブラウザは録画に対応していません（Chrome推奨）', 'This browser cannot record (use Chrome)'), 'err', 3500);
      return;
    }
    const wasMusicOn = audio.musicOn;
    audio.setMusicEnabled(true);
    const dest = audio.ctx.createMediaStreamDestination();
    audio.musicGain.connect(dest);
    studioState.dest = dest;
    // captureStream(0)+requestFrame: フレーム送出を自前のタイマーで駆動する。
    // rAF任せの captureStream(30) はタブが隠れると映像が凍る（事故報告の原因）。
    const vStream = canvas.captureStream(0);
    const vTrack = vStream.getVideoTracks()[0];
    const manualFrames = typeof vTrack.requestFrame === 'function';
    if (!manualFrames) { vTrack.stop(); }
    const stream = new MediaStream([
      ...(manualFrames ? [vTrack] : canvas.captureStream(30).getVideoTracks()),
      ...dest.stream.getAudioTracks(),
    ]);
    // 最高音質: opus 320kbps + 6Mbps 映像（YouTubeの再エンコードに強い）。
    // MIME は開いた時点で「実際に録れる形式」を選んである。
    // それでも作成に失敗したら、音楽の乗っ取りを解いてから諦める ──
    // 例外がそのまま抜けると、音楽がONのまま dest が繋がりっぱなしになる。
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 320_000 });
    } catch (err) {
      try { audio.musicGain.disconnect(dest); } catch { /* ok */ }
      try { stream.getTracks().forEach(tr => tr.stop()); } catch { /* ok */ }
      if (studioState) studioState.dest = null;
      if (!wasMusicOn) audio.setMusicEnabled(false);
      status('');   // 「準備中…」のまま固まらせない
      toast(t('録画を開始できませんでした（このブラウザでは非対応かもしれません）',
        'Could not start recording — this browser may not support it'), 'err', 4000);
      return;
    }
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      if (studioState) {
        // 0 に戻さないと、次の録画で fallback() が「もう張ってある」と
        // 判断して二度と時計を回さない（2回目だけ無反応になる）。
        clearInterval(studioState.timer);
        studioState.timer = 0;
        studioState.rec = null;
        if (studioState.worker) { try { studioState.worker.postMessage('stop'); studioState.worker.terminate(); } catch { /* gone */ } studioState.worker = null; }
        if (studioState.wakeLock) { try { studioState.wakeLock.release(); } catch { /* released */ } studioState.wakeLock = null; }
        if (studioState.onVis) { document.removeEventListener('visibilitychange', studioState.onVis); studioState.onVis = null; }
      }
      audio.lookahead = 0.35;
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (blob.size > 0) {
        download(blob, `bba-ost-${sel}-${FMT === FORMATS.short ? 'short-' : ''}${dur}s.webm`);
        toast(t('🎬 動画を保存しました！このままYouTubeにアップできます', '🎬 Video saved — upload it to YouTube as-is!'), 'ok', 4500);
      } else {
        // 空だったことを伝える。黙って終わると「保存できたのに
        // ファイルが無い」に見えて、原因を探しようがない。
        toast(t('録画データが空でした。もう一度お試しください', 'The recording came out empty — please try again'), 'err', 4000);
      }
      // フェードアウトを解除して音量を元に戻す（エンジンは 0.45×musicVol で駆動）
      try {
        // 一気に戻すとプツッと鳴る。0.12秒かけて戻す。
        const g = audio.musicGain.gain, now = audio.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0.45 * audio.musicVol, now + 0.12);
      } catch { /* engine owns it */ }
      try { audio.musicGain.disconnect(dest); } catch { /* ok */ }
      // canvas を掴んでいる録画トラックを解放する。止めないと
      // 押すたびに live なトラックが増えていく。
      try { stream.getTracks().forEach(tr => tr.stop()); } catch { /* ok */ }
      chunks.length = 0;
      if (studioState) { studioState.dest = null; studioState.stream = null; }
      if (!wasMusicOn) audio.setMusicEnabled(false);
      recording = false;
      currentRec = null;
      fadeArmed = false;
      btnRec.textContent = `🔴 ${t('録画開始', 'Record')}`;
      m.querySelector('#ytClose').disabled = false;
      status('');
    };
    studioState.stream = stream;   // 終わったときにトラックを止めるため
    studioState.rec = currentRec = rec;
    rec.start(1000);
    recording = true;
    fadeArmed = false;
    recStart = performance.now();
    // 🎯 頭出し: レコーダー始動の直後に曲を1小節目から流し直す。
    // これで「音楽が途中から始まっている」動画にならない。
    audio.preview(sel);
    audio.restart();
    // 📵 画面スリープ防止（モバイルで画面が消えると録画ごと止まるため）。
    // 取るのは常に1つだけ。以前は「開始時に1つ」と「直後の onVis でもう1つ」で
    // 2つ取れていて、片方は参照ごと上書きされて解放されなかった。
    // 解放されない札が1枚でも残っていると画面は永久に眠らない ──
    // バッテリーを守るために入れた仕掛けが、逆に食い続ける状態だった。
    const mySession = studioState;
    const takeWakeLock = () => {
      if (!navigator.wakeLock || !navigator.wakeLock.request) return;
      if (!studioState || studioState !== mySession || studioState.wakeLock || studioState.wakeLockPending) return;
      studioState.wakeLockPending = true;
      navigator.wakeLock.request('screen').then(wl => {
        // 待っている間に録画が終わっていたら、その場で返す。
        // このとき pending を戻し忘れると、同じスタジオでの2回目以降が
        // 「取得中」のまま永久に札を取れなくなる。
        if (studioState !== mySession || !recording) {
          if (studioState === mySession) studioState.wakeLockPending = false;
          try { wl.release(); } catch { /* ok */ }
          return;
        }
        studioState.wakeLockPending = false;
        if (studioState.wakeLock) { try { wl.release(); } catch { /* ok */ } return; }
        studioState.wakeLock = wl;
      }).catch(() => { if (studioState === mySession) studioState.wakeLockPending = false; });
    };
    takeWakeLock();
    // タブが隠れている間は音の先読みを4秒に拡大（背景ではタイマーが1秒間隔に
    // 制限されるため、0.35秒先読みのままだと音が途切れる）。
    const onVis = () => {
      if (document.hidden) {
        audio.lookahead = 4;
        try { audio.scheduleAhead(); } catch { /* ok */ }
      } else {
        audio.lookahead = 0.35;
        // 画面が戻ったら取り直す（ブラウザが自動で手放すため）。
        // takeWakeLock は既に持っていれば何もしない。
        if (studioState) studioState.wakeLock = null;
        if (recording) takeWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    studioState.onVis = onVis;
    onVis();
    btnRec.textContent = `⏹ ${t('停止して保存', 'Stop & save')}`;
    m.querySelector('#ytClose').disabled = true;
    // 録画中の描画・フレーム送出・進行管理はWorkerタイマーが駆動
    // （タブを切り替えても止まらない）。Worker不可の環境はintervalに退避。
    let ticked = 0;
    const tick = () => {
      if (!studioState || rec.state === 'inactive') return;
      ticked++;
      const el = (performance.now() - recStart) / 1000;
      draw();
      if (manualFrames) { try { vTrack.requestFrame(); } catch { /* track ended */ } }
      // 手動でフレームを送れる環境でだけ「切り替えてOK」と言う。
      // requestFrame が無い環境（Firefox）では rAF 任せなので、
      // タブを隠すと映像が凍った動画になる。嘘をつかない。
      status(manualFrames
        ? t(`🔴 録画中… ${Math.floor(el)} / ${dur}秒（別の画面に切り替えてもOK）`, `🔴 Recording… ${Math.floor(el)} / ${dur}s (switching tabs is fine)`)
        : t(`🔴 録画中… ${Math.floor(el)} / ${dur}秒（この画面を開いたままにしてください）`, `🔴 Recording… ${Math.floor(el)} / ${dur}s (keep this tab visible)`));
      // 最後の1.5秒はフェードアウト（動画の終わりがブツ切りにならない）
      if (!fadeArmed && el >= dur - 1.5) {
        fadeArmed = true;
        try {
          audio.musicGain.gain.setValueAtTime(audio.musicGain.gain.value, audio.ctx.currentTime);
          audio.musicGain.gain.linearRampToValueAtTime(0.0001, audio.ctx.currentTime + Math.max(0.2, dur - el));
        } catch { /* ok */ }
      }
      if (el >= dur) rec.stop();
    };
    // Worker が使えなければ setInterval に退避する。
    // 時計は常に1本だけ。Worker と interval が両方動くと、1フレームぶんの
    // 描画とフレーム送出が二重になって、映像が倍速のように詰まる。
    const fallback = () => {
      if (!studioState) return;
      if (studioState.worker) {
        try { studioState.worker.postMessage('stop'); studioState.worker.terminate(); } catch { /* gone */ }
        studioState.worker = null;
      }
      clearInterval(studioState.timer);
      studioState.timer = setInterval(tick, 33);
    };
    studioState.worker = makeTickWorker(tick, fallback);
    if (!studioState.worker) fallback();
    // 最後の保険。onerror が来ない環境でも、300ms 動かなければ切り替える。
    // ここが無いと「ボタンは録画中なのに何も起きない」で詰む。
    setTimeout(() => { if (ticked === 0) fallback(); }, 300);
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

  // このモーダルが他の機能のモーダルに差し替えられたら、スタジオも畳む。
  // 放っておくと画面だけ消えて録画は裏で回り続け、止める手段がどこにも
  // 無いまま、しばらくして勝手にファイルが降ってくる。音楽も乗っ取られたまま。
  // パーティーの招待や「部屋ができました」で実際に起きる。
  const gone = new MutationObserver(() => {
    if (document.contains(canvas)) return;
    gone.disconnect();
    if (!studioState) return;
    const wasRecording = recording;
    stopStudio();       // 録画中ならここまでのぶんが保存される
    if (wasRecording) {
      toast(t('🎬 画面が切り替わったので録画を終了しました（ここまでのぶんは保存されます）',
        '🎬 Recording stopped because the screen changed — what was captured is saved'), 'err', 5000);
    }
  });
  gone.observe(document.getElementById('modal-root'), { childList: true, subtree: true });
  studioState.gone = gone;
}
