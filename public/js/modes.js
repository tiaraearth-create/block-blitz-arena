// Game mode controllers: Solo, VS AI, Online (1v1 / 2v2 team / custom rooms),
// plus the admin-only autopilot.
import { Engine, shapeSize, Rng, SHAPES, ICE, ICE_CRACKED } from './engine.js';
import { GameView, MiniBoard } from './game.js';
// 🧩 工房のエディタが盤面・ピースを DOM の小さなグリッドで描くのに使う。
// engine.grid のマス値を canvas に描く経路は game.js の boardSkin() が担当
// （PALETTE には 10/11 が無いので、そちらへ渡してはいけない）。
import { PALETTE } from './themes.js';
import { chooseMove, AI_LEVELS, planImmortalMove } from './ai.js';
import { audio } from './audio.js';
// queuedResultCount は「圏外で落ちた結果が控えに入ったか」を確かめるために引く。
// 結果画面が「報酬は付いていません」と「あとで自動で送ります」を取り違えないため。
import { session, api, refreshMe, BattleClient, queuedResultCount } from './net.js';
import { $, showScreen, showModal, closeModal, toast, countdownOverlay, fmt, updateTopbar, confettiBurst, rankOf, rankBadge, rankLabel, staffExtras , applyScoreFit, onModalClosed, enterIsLive } from './dom.js';
import { t, trServer, catName } from './i18n.js';
// ショップに並ぶ英語名の出典。HUD・トーストが名前を自前で手書きしていたため、
// 同じ物に英語名が2つある状態になっていた（ショップ「God Strike」＝発動トースト
// 「Divine Strike!」）。名前はこの表からだけ引く。
import { CATALOG_EN } from './catalog-en.js';
// 独自SVGアイコン。端末ごとに絵が変わる絵文字を「アイコンとして使っている所」
// だけを置き換えるために使う（文章の飾りの絵文字はそのまま）。
// hasIcon はダンジョンの敵の系統表（FOE_FAMILIES）を読み込み時に突き合わせる
// ために引く ── 表に書いた系統の絵が icons.js に無いことを黙って見逃さない。
import { icon, hasIcon, itemIconName, bossIconName, medalIconName } from './icons.js';
// 攻撃の量の式。サーバー（server/battle.js の attackCells）と同じものを
// rules.js が持っている ── 試合中に「何個送ったか」を先に見せるために引く。
// 数字をここへ書き写さない（写した瞬間、サーバーとズレても誰も気づけなくなる）。
// onlineModeName は試合前の対戦カードが「いま何の試合か」を1語で出すために引く。
// 表の名前を画面側で手書きすると、選択画面（rules.js）と食い違う。
import { attackCellsFor, onlineModeName } from './rules.js';
// ultIcon（絵文字）はもう引かない ── 奥義の絵は icons.js の ult_* から出す。
import { fireUlt, ultColor, ultExists, DEFAULT_ULT } from './skills.js';
// 常時つながっているチャットの socket に相乗りするための口。
// サーバーの shard() は「そのユーザーの最初のソケット」に送るので、
// ページ読み込み時に張るこちらへ届くことがある（下の ZeroMode を参照）。
// chat.js は modes.js を import していないので循環しない（party.js と同じ）。
import { registerHandler, showProfileCard } from './chat.js';

const MATCH_SECONDS = 120;

let view = null;
let currentMode = null;

// ---------------------------------------------------------------------------
// 開始入口のレース避け
//
// 通信を await している間もメニューは押せる。回線が遅いときに
// 「🏗を押す → 待ちきれず⛓️を押す」と、先に始まった⛓️を後から届いた🏗が
// 黙って destroy して奪ってしまう。await をまたぐ入口は
//   const tk = beginModeStart();  ...await...  if (modeStartStale(tk)) return;
// を通し、待っている間に別のモードが始まっていたら何もせず降りる。
// （各モードの finish() にある `if (currentMode !== this) return;` と同じ考え方）
// ---------------------------------------------------------------------------
let modeStartGen = 0;
function beginModeStart() {
  modeStartGen++;
  return { gen: modeStartGen, prev: currentMode };
}
function modeStartStale(tk) {
  // 別の入口があとから走った／待っている間に currentMode が入れ替わった
  return !tk || tk.gen !== modeStartGen || currentMode !== tk.prev;
}

// NOTE: this is a mutating accessor — every call re-applies a theme and
// re-measures the canvas. That is deliberate (it keeps the board in sync with
// a shop purchase or a rotation), but it used to slam the player's OWN theme
// back over a stage a mode had chosen: firing an ultimate during Chaos, or
// calling getView() anywhere in a boss/admin-event run, reverted the board to
// the equipped skin. Modes that pick a stage set `setModeTheme` and it wins
// until the mode ends.
function getView() {
  if (!view) {
    view = new GameView($('#gameCanvas'), { interactive: true });
    view.onRescue = () => autoRescue();   // autopilot 5.0 guard (checks its own eligibility)
    installPerfectHook(view);             // 全消し「昇華」を全モード共通で拾う
    window.__bbaView = view;   // debug/testing hook
  }
  view.setTheme(view.modeTheme || equippedTheme());
  view.resize();
  return view;
}

// A mode claiming the stage. Cleared by endToMenu().
function setModeTheme(theme) {
  const v = getView();
  v.modeTheme = theme;
  v.setTheme(theme);
  return v;
}

function equippedTheme() {
  const eq = (session.user && session.user.equipped) || {};
  return {
    skinId: eq.skin || 'skin_default',
    boardId: eq.board || 'board_default',
    fxId: eq.fx || 'fx_default',
  };
}

// A quit during the 3-2-1 runs destroy() BEFORE the countdown's callback
// fires. Without this guard the callback then re-armed timers and view hooks
// that nothing would ever clear again.
function afterCountdown(mode, fn) {
  return () => { if (mode.ended || currentMode !== mode) return; fn(); };
}

// 3-2-1 と入場演出（鬼／神／創造神）は自前の setTimeout で動いていて、外から
// 止める口が無い。演出中に中断すると、結果モーダルやメニューの下に全画面の
// カウントダウンが残って数字が動き続けていた（暗幕越しに透ける／メニューに
// 戻ると素で見える）。せめて中断した時点で画面からは消す。
// ※ 音も一緒に止まる。dom.js の countdownOverlay は「要素が DOM から外れたら
//    自分から止まる」作りになったので、remove() だけで鳴り切らない。
//    確実に止めたいときは dom.js の cancelCountdowns() を呼んでもよい。
function clearIntroOverlays() {
  // .vs-card は 3-2-1 に重ねて出す対戦カード（第5波）。同じ寿命のものなので
  // 同じ掃除機に入れる ── 別々にすると、片方だけメニューの上に残る。
  for (const el of document.querySelectorAll('.countdown-overlay, .oni-intro, .kami-intro, .vs-card')) el.remove();
}

function guestBest() { return Number(localStorage.getItem('bba_best') || 0); }
function setGuestBest(v) { localStorage.setItem('bba_best', String(v)); }

// How much room the OTHER players get in raid / 2v2. 'strip' is the default
// for crowds because their mini boards were costing the player's own board
// more height than the boards were worth.
const OPP_DENSITY_KEY = 'bba_opp_density';
function oppDensity() { return localStorage.getItem(OPP_DENSITY_KEY) === 'cards' ? 'cards' : 'strip'; }
function setOppDensity(v) { localStorage.setItem(OPP_DENSITY_KEY, v); }

// スコアが動いたときの一拍（HUD の数字が跳ねる）。同じ3行が各モードの
// updateHud() に散っていて、書き忘れたモードだけ点が入っても数字が無反応
// だった。増える一方なので1箇所に畳んでおく。
function bumpScore(el) {
  if (!el) return;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 文章の頭に置くアイコン（HTML 文字列に差し込む用の短縮形）。
// 絵文字1文字が座っていた場所と同じ「文字ぐらいの大きさ」を既定にしてある。
//
// ⚠️ 使ってよいのは innerHTML / showModal / toast 以外の HTML を組む所だけ。
//    textContent・addFloatText（canvas）・toast() の文言に混ぜると、
//    そのまま「<svg …>」という文字列が画面に出る。そこは絵文字を
//    落として言葉だけにする（この波の取り決め）。
const ic = (name, size = 16) => icon(name, { size });

// ---------------------------------------------------------------------------
// 絵文字の枠に独自SVGアイコンを入れる
//
// 絵文字を置いていた枠（#bossEmoji / #ultIcon / アイテムバーの .ib-icon）は
// どれも「文字」として大きさが決まっていた。SVG は文字ではないので、
// そのまま入れると2つズレる:
//   ・font-size は効かない（icon() は width/height を px で焼く）
//   ・.bba-ic の vertical-align: -0.15em ぶん、行の中で沈んで枠が伸びる
// アイコンは箱として置きたいだけなので、枠を inline-flex にして行から外す。
//
// ⚠️ アニメーション（.boss-hit / .boss-atk / .boss-dead / .boss-enrage /
//    .ult-ready のバウンド）は枠そのものに transform / filter を掛けている。
//    中身を SVG に替えても掛かる先は枠のままなので、演出はそのまま効く。
//    枠は flex コンテナ（.boss-panel / .chip）の子なので block 化されており、
//    inline 要素だと transform が効かない問題も起きない。
//
// tint（{ a, b }）を渡すとアイコンの2色を上書きする。ダンジョンの敵が
// 「系統アイコン ＋ 帯の色」で描き分かるための口で、渡さなければ
// icons.js の定義色そのまま＝今までの呼び出しは見た目が変わらない。
function paintIcon(el, name, size, tint = null) {
  if (!el) return null;
  el.style.display = 'inline-flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.innerHTML = icon(name, tint ? { size, a: tint.a, b: tint.b } : { size });
  return el;
}

// ボスの顔（#bossEmoji）。画面でいちばん大きい絵なので、端末ごとに顔が
// 変わる絵文字はここがいちばん惜しかった。
// className を毎回 'boss-emoji' に戻すのは元からの作法 ── 前の戦いの
// .boss-dead / .boss-enrage を次のボスへ持ち越さないため。
// size は通常のボスパネルが 44px の絵文字だったので 40、レイドや管理者
// イベントの1行パネル（.boss-panel.slim, 24px）では 24 を渡す。
const BOSS_FACE_SLIM = 24;
function setBossFace(el, iconName, size = 40, tint = null) {
  if (!el) return null;
  el.className = 'boss-emoji';
  return paintIcon(el, iconName, size, tint);
}

// ---------------------------------------------------------------------------
// 冪等キー（runId）
//
// /api/game/result はいま「同じ結果を2回受けると2回ぶん加算する」。そのせいで
// **送信の再試行がどこにも入れられない** ── 応答だけ落ちたときに再送すると
// コイン・XP・ミッション進捗を二重取りできてしまうので、submitResult() は
// 失敗しても黙って諦めるしかなかった（offline 中の記録の後送りも同じ理由で
// 入れられていない）。サーバーが「同じ runId は1回だけ数える」ようになれば
// 再送を足せるので、先にキーを載せる。
//
// ⚠️ runId は「1回のプレイ」に紐づく。**同じ試合を再送するときは同じ値**で
//    なければ意味がない ── 毎回作り直すと、サーバーから見て別の試合になる。
//    そこでモードのインスタンス（＝1回のプレイで1つ作られる）に持たせ、
//    **結果を送った時点で手放す**（submitResult の中で null に戻す）。
//    以前はここに「リトライでは startXxx() が必ず新しく作り直す」と書いて
//    あったが、実際には同じインスタンスのまま start() を呼び直す書き方が
//    6モードにあり、その2回目以降が丸ごとサーバーに捨てられていた ──
//    コメントの約束を、書き方に依存しない形（送ったら手放す）に置き換えた。
//    currentMode を見るのは、
//    submitResult() を呼ぶのが必ず「いま走っているモードの finish()」で、
//    直後の `if (currentMode !== this) return;` がそれを前提にしているため。
// ---------------------------------------------------------------------------
let runIdSeq = 0;
function newRunId() {
  const c = globalThis.crypto;
  // randomUUID は「安全なコンテキスト」でしか生えない（http:// の LAN 配信など
  // では undefined）。getRandomValues はもう少し広く使えるので二段構え。
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* 実装によっては投げる。下へ落とす */ }
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;   // version 4
    b[8] = (b[8] & 0x3f) | 0x80;   // variant 10
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // 最後の砦。UUID の形にはしない ── 本物の乱数で作ったものと区別が付かないと、
  // 「この端末では衝突しうる」ことがログから読めなくなる。
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${(++runIdSeq).toString(36)}`;
}

/** いま走っているプレイの runId（無ければその場で1つだけ発行して持たせる）。 */
function currentRunId() {
  const m = currentMode;
  if (!m || typeof m !== 'object') return newRunId();
  if (!m.runId) m.runId = newRunId();
  return m.runId;
}

async function submitResult(payload) {
  if (!session.user) return null;
  // Per-run telemetry the mission system feeds on — filled in centrally so
  // every mode reports it without repeating itself.
  const e = currentMode && currentMode.engine;
  // perfectClears は全消し「昇華」の回数（celebratePerfect() が数えている）。
  const tele = e
    ? { ults: e.ultUses || 0, items: e.itemUses || 0, pieces: e.piecesPlaced || 0, perfectClears: e.perfectClears || 0 }
    : null;
  // runId は先頭に置く＝呼び出し側が明示的に渡したときはそちらが勝つ
  // （将来「同じ回をもう一度送る」経路を足すときのため）。
  const body = { runId: currentRunId(), ...tele, ...payload };
  // 🧾 この runId は「いまの1回」ぶんとして **使い切った**。ここで手放す。
  //
  // ■ 手放さないと何が起きるか
  //   結果画面の「もう一度」には2つの書き方がある:
  //     ① destroy() して startXxx() … インスタンスごと作り直す ＝ runId も新品
  //     ② this.ended = false; this.start() … **同じインスタンスを使い回す**
  //   ②の書き方（ソロ・メルトダウン・キメラ工房・採掘場・幽霊屋敷・パズル工房）
  //   では runId がインスタンスに貼り付いたままなので、2回目以降が1回目と
  //   同じ runId で飛ぶ。サーバーはそれを冪等キーとして見ているので
  //   （server/index.js の recallResultRun）、applyGameResult を通らずに
  //   **前回の応答をそのまま 200 で返す** ── コインもXPもミッションも
  //   自己ベストも1つも入らないのに、結果画面には1回目の報酬額が出る。
  //   しかも api() が応答の user を session.user に書き戻すので、
  //   「+52🪙 と出ているのに残高が増えない」が必ず目に見える形で起きる。
  //
  // ■ ここで手放してよい理由
  //   圏外で落ちた回の控え（net.js の queueOfflineResult）は body ごと
  //   localStorage に持っていくので、「同じ回の再送は同じ runId」は保たれる。
  //   手放すのは「次のプレイ」に持ち越さないためだけ。
  //   ⚠ 1回のプレイで submitResult を2回呼ぶモードを作らないこと。作るなら
  //     runId を明示的に payload へ渡す（先頭に置いてあるので上書きできる）。
  if (currentMode && typeof currentMode === 'object') currentMode.runId = null;
  // この回が「サーバーに残る初めての1戦」かどうか。あとで受け取り先を案内する。
  const firstEver = !!(session.user.stats && (session.user.stats.gamesPlayed || 0) === 0);
  try {
    const data = await api('/api/game/result', { method: 'POST', body });
    updateTopbar();
    // 📋バッジ（#missionDot）は実績の未受取ぶんも数えている。以前はここの更新が
    // announceMissions() の中だけ＝デイリー/ウィークリーが完了したときにしか
    // 走らず、実績だけが達成された初戦では点かなかった（他の更新契機は120秒
    // 間隔の定期実行だけ）。結果を送ったら必ず数え直す。
    if (window.__bbaRefreshMissionDot) window.__bbaRefreshMissionDot();
    if (data.rewards && data.rewards.missionsCompleted && data.rewards.missionsCompleted.length) {
      announceMissions(data.rewards.missionsCompleted.length);
    } else if (firstEver) {
      // 初戦で必ず達成する実績（🎮「はじめの一歩」）は自動付与ではなく手動受取。
      // 何も案内しないと「1戦終わった → 何も起きない」で終わってしまう。
      setTimeout(() => {
        audio.coin();
        toast(t('実績を達成！メニューの「ミッション」→「実績」から報酬を受け取ろう',
          'Achievement unlocked! Claim it from Missions → Achievements'), 'announce', 5000);
      }, 1400);
    }
    return data.rewards;
  } catch (err) {
    console.warn('result submit failed:', err.message);
    // 「未ログイン」と同じ null にしてはいけない。通信断・レート制限(429)・
    // メンテナンス(503) でも報酬は付かないのに、ログイン中の人にまで
    // 「報酬を受け取るにはログイン」と出て、その回のコイン／XP／ミッション
    // 進捗が消えたことが console 以外どこにも出ていなかった。
    // ここで区別して返し、結果画面には本当のことを出す。
    //
    // 📴 「圏外で落ちた回」と「サーバーが断った回」はさらに別物。
    // net.js は runId を持つ結果に限って控えを取り、つながったら送り直す。
    // 控えに入った回まで「報酬は付いていません」と言い切ると、**あとから
    // 本当に入る報酬** を「消えた」と伝えることになる（逆に、控えに入って
    // いない回を「あとで送ります」と言うのはもっと悪い）。
    // 見分け方は net.js の約束そのまま:
    //   ・status 0 …… 通信が届かなかった回（netError）。控えの対象。
    //   ・それ以外 … サーバーが返事をした回（429/503/400…）。控えない。
    // 実際に控えられたかは queuedResultCount() で確かめてから言う。
    const offline = err && err.status === 0;
    const queued = offline && queuedResultCount() > 0;
    if (queued) {
      toast(t('通信が切れています。この回の結果は、つながったら自動で送ります',
        // 'announce'（紫の枠）にするのは、これが「失敗の報せ」ではなく
        // 「見落とされたら困る案内」だから。css に .toast.warn は無い。
        'You are offline — this run will be submitted automatically once you reconnect'), 'announce', 4500);
      return { queued: true };
    }
    toast(t('結果を送信できませんでした。この回の報酬は付いていません',
      'Could not submit your result — no rewards were granted for this run'), 'err', 4500);
    return { failed: true };
  }
}

function announceMissions(n) {
  setTimeout(() => {
    audio.coin();
    toast(t(`ミッションを${n}個達成！メニューの「ミッション」から報酬を受け取ろう`,
      `${n} mission(s) complete! Claim the rewards from the Missions menu`), 'announce', 4500);
    if (window.__bbaRefreshMissionDot) window.__bbaRefreshMissionDot();
  }, 1400);
}

function rewardsRows(rewards) {
  // 送信に失敗した回。ログインしているのに「ログインしてください」と出すと、
  // 直せる問題（通信・メンテ）を直しようのない問題に見せてしまう。
  // 📴 圏外で控えに入った回はここに混ぜる（出口を増やさない）。報酬の金額は
  // サーバーが決めるのでまだ出せないが、「消えた」と「あとで入る」は
  // プレイヤーにとって全く違う話なので、文言だけは必ず分ける。
  if (rewards && (rewards.failed || rewards.queued)) {
    const row = rewards.queued
      ? `${ic('offline')} ${t('未送信 — つながったら自動で送ります（報酬はそのとき入ります）', 'Not sent yet — it will be submitted automatically when you reconnect')}`
      : `${ic('warn')} ${t('送信に失敗しました — この回の報酬は付いていません', 'Submission failed — no rewards for this run')}`;
    return `<div class="rs-row"><span>${row}</span></div>${shareRow()}`;
  }
  if (!rewards) {
    // ゲストの結果はサーバーへ送られない＝コイン・ジェム・パスXP・ミッション
    // 進捗がすべて 0 のまま。以前はそれを押せないテキスト1行で伝えていたので、
    // 「何回やっても数字が増えない」に気づいた人の行き先が無かった。
    // 金額は書かない（登録特典の額はサーバーが決めるので、写すと必ずズレる）。
    return `
      <div class="rs-row"><span>${t('この回の報酬は受け取れませんでした', 'No rewards were earned for this run')}</span></div>
      <button class="btn btn-gold" data-bba-signup style="width:100%;margin-top:8px">
        ${t('アカウントを作って報酬を受け取る', 'Create an account to earn rewards')}
      </button>
      ${shareRow()}`;
  }
  return `
    ${/* 🛠 上限に当たって勝利ぶんが付かなかった回。黙って0にすると
          「クリアしたのに数えられない」が原因不明の不具合に見える。
          参加ぶんの報酬（下の行）は入っているので、そこは打ち消さない。 */''}
    ${rewards.capped === 'workshop' ? `<div class="rs-row"><span>${ic('warn')} ${t('工房のクリア報酬は1時間あたりの上限に達しました', 'Workshop clear rewards have hit the hourly cap')}</span><b class="muted">${t('時間をおくと戻ります', 'It returns after a while')}</b></div>` : ''}
    <div class="rs-row"><span>${ic('coins')} ${t('コイン', 'Coins')}</span><b>+${fmt(rewards.coins)}</b></div>
    ${rewards.streakBonus ? `<div class="rs-row"><span>${ic('fire')} ${t(`${rewards.streak}連勝ボーナス`, `${rewards.streak}-win streak bonus`)}</span><b>+${fmt(rewards.streakBonus)} ${ic('coins', 14)}</b></div>` : ''}
    ${/* サーバーの gems は「初回討伐」だけではない ── イベントの💎ドロップも
          バッジ報酬（デイリー7日・ダンジョン制覇・ロイヤル初1位…）も同じ欄に
          合算されて来る。討伐が存在しないソロやデイリーでも「初回討伐ボーナス」
          と出ていたので、中立の表記にする。内訳を出すにはサーバーが
          eventGems / badge の内訳を返す必要がある。 */''}
    ${rewards.gems ? `<div class="rs-row"><span>${ic('gems')} ${t('ジェム', 'Gems')}</span><b>+${fmt(rewards.gems)}</b></div>` : ''}
    <div class="rs-row"><span>${ic('battlepass')} ${t('パスXP', 'Pass XP')}</span><b>+${fmt(rewards.bpXp)}</b></div>
    <div class="rs-row"><span>${ic('xp')} ${t('アカウントXP', 'Account XP')}</span><b>+${fmt(rewards.accXp)}</b></div>
    ${shareRow()}`;
}

export function quitCurrent() {
  if (currentMode) currentMode.quit();
}

// ⏸ 確認ダイアログを開いている間、走行の時計を止める。
//
// ✕（＝端末の戻る）の「ゲームを終了しますか？」は暗幕で盤面を覆うので**指は
// 届かない**のに、ボスの予告技は着弾し、サバイバルの波は降り、タイムアタックの
// 時計は進んでいた。「続ける」を選ぶつもりで文面を読んでいる数秒のあいだに
// 走行が終わる ── 何もしていないのに負ける、いちばん理不尽な負け方だった。
//
// 進行はすべて「いつまで」の絶対時刻で持っているので（背景タブでも狂わない
// ように、そう作ってある）、止めている間の時間ぶんだけ期限を後ろへずらせば
// 元の残り時間で再開できる。
const PAUSABLE_DEADLINES = [
  'endAt',        // 制限時間つきの走行すべて（startTimer）
  'nextAt',       // サバイバルの次の波
  'nextAtk',      // ボスの次の一手
  'nextModAt',    // カオスの次のお題
  'nextSpinAt',   // カオスのルーレット
  'startedAt',    // サーバーへ送る duration の起点
  'playStartedAt', // タイムアタックの毎秒スコアの起点
];

export function pauseModeForDialog() {
  const m = currentMode;
  if (!m || m.ended || m._dialogPaused) return null;
  // 🌐 サーバーが進行を持っているモードは**止めない**。こちらの時計だけ
  //    遅らせても相手もサーバーも待ってくれないので、ズレて損をするだけ。
  //    相手のいる試合で自分だけ時間を稼げてしまうのも、当然まずい。
  if (m.client || m.mode === 'pvp' || m.mode === 'zero' || m.kind) return null;
  m._dialogPaused = true;
  const v = getView();
  const lockWas = v ? v.inputLocked : false;
  if (v) v.inputLocked = true;

  // ⏱ 期限は「閉じたときにまとめて」ではなく、**開いている間ずっと**
  //    進む時間ぶんだけ押し続ける。
  //
  //    最初は閉じるときに一度だけ足す形にしたが、それだと開いている間は
  //    画面の時計が減り続ける（実測: 5秒読んだら残りが 57→45 秒に見えた）。
  //    見た目が怖いだけでなく、startTimer の刻みが timeLeft<=0 に到達して
  //    **ダイアログを読んでいる最中に走行が終わる** ── 直したかったこと
  //    そのものが起きる。押し続ければ、残り時間・ボスの予告バー・波の
  //    カウントダウンが全部そのまま凍る（読む側に特別な対応が要らない）。
  const shift = (delta) => {
    if (delta <= 0) return;
    for (const key of PAUSABLE_DEADLINES) {
      if (typeof m[key] === 'number' && m[key] > 0) m[key] += delta;
    }
    // 効果の残り時間（フィーバー・要塞・無敵・危険表示）も同じだけ後ろへ。
    // ここを忘れると、止めている間に効果だけが切れる。
    const e = m.engine;
    if (e) {
      for (const key of ['feverUntil', 'fortressUntil']) {
        if (typeof e[key] === 'number' && e[key] > 0) e[key] += delta;
      }
      // ボスの呪縛（コマごとの氷結）も止まっていた時間ぶん延びる。
      if (Array.isArray(e.hand)) {
        for (const p of e.hand) {
          if (p && typeof p.frozenUntil === 'number' && p.frozenUntil > 0) p.frozenUntil += delta;
        }
      }
    }
    if (v) {
      for (const key of ['godInvincibleUntil', 'dangerUntil']) {
        if (typeof v[key] === 'number' && v[key] > 0) v[key] += delta;
      }
    }
  };

  let last = Date.now();
  const iv = setInterval(() => {
    const now = Date.now();
    shift(now - last);
    last = now;
  }, 100);

  return () => {
    if (!m._dialogPaused) return;
    m._dialogPaused = false;
    clearInterval(iv);
    shift(Date.now() - last);   // 最後の端数（刻みの残り）
    if (v) v.inputLocked = lockWas;
  };
}

// 🚪 ログアウト・アカウント削除のときに呼ぶ。オンラインのモードだけを畳む。
//
// 対戦用の WebSocket は hello のときのトークンで身元が決まる。ログアウトで
// localStorage のトークンを捨てても、**既に開いているソケットはそのまま生きて
// いる** ので、マッチング画面や合言葉ルームからログアウトすると、前の
// アカウントのまま試合が成立して勝敗・レート・報酬がそのアカウントに入る。
// （トップバーは対戦中は隠れているので、到達できるのはマッチング/ルーム画面。）
//
// ソロやボスなど、サーバーに身元を預けていないモードは畳まない ── 遊んでいる
// 途中のプレイを、設定を触っただけで失わせない。
export function leaveOnlineOnSignOut() {
  const m = currentMode;
  if (!m || !m.client) return false;
  try { m.client.close(); } catch { /* もう閉じている */ }
  try { if (typeof m.destroy === 'function') m.destroy(); } catch { /* 片付けの失敗で画面を止めない */ }
  currentMode = null;
  return true;
}

// 結果画面の「アカウントを作る」ボタン。rewardsRows() は十数個のモーダルから
// 使われるので、配線は委譲リスナー1本にまとめる。screens.js の showAuthModal を
// import すると screens.js ⇄ modes.js の循環になるため、main.js が既に配線して
// いるトップバーの #userChip をそのまま叩く（開くのは「新規登録」タブ）。
// 先にメニューへ戻すのは、登録モーダルを閉じた人が固まった盤面に取り残されない
// ようにするため（結果モーダルは dismissable:false）。
document.addEventListener('click', ev => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-bba-signup]') : null;
  if (!btn) return;
  audio.click();
  closeModal();
  endToMenu();
  const chip = document.getElementById('userChip');
  if (chip) chip.click();
});

// ---------------------------------------------------------------------------
// 📣 スコアのシェア
//
// 遊んだ人自身に広めてもらうための出口。個人開発で広告費ゼロなら、これが
// いちばん効く導線になる（勝敗や記録をシェアできる対戦ゲームが伸びた実例は
// 多い）。だから **ゲストにも出す** ── むしろ、まだアカウントを作っていない人
// ほど「友達に見せる」動機で戻ってくる。
//
// 置き場所は rewardsRows() の中ひとつだけ。結果モーダルは18個あるが、全部が
// この関数を通るので、ここに足せば全モードに一度に乗る（既存の
// data-bba-signup ボタンとまったく同じ作法）。呼ばれる時点では currentMode の
// 差し替えガードを通った直後なので、スコアは currentMode.engine から読める。
// ---------------------------------------------------------------------------

// シェア文に出すモード名。screens.js の MODE_LABEL を import すると
// screens.js ⇄ modes.js の循環になるので、ここに短い対訳だけ持つ。
// キーは各モードクラスの this.mode（'pvp' は kind で 1v1/2v2/カスタムに分かれるが、
// シェア文では細かく分けても伝わらないので「オンライン対戦」にまとめる）。
// ここに無いモードは「プレイ」に落ちるだけで壊れない（安全側）。
const SHARE_MODE_NAME = {
  solo: ['ソロプレイ', 'Solo'], ai: ['AI対戦', 'vs AI'], boss: ['ボス戦', 'Boss'],
  dungeon: ['ダンジョン', 'Dungeon'], survival: ['サバイバル', 'Survival'],
  sprint: ['タイムアタック', 'Time Attack'], weekly: ['ウィークリー', 'Weekly'],
  daily: ['デイリー', 'Daily'], chaos: ['カオスモード', 'Chaos'],
  meltdown: ['メルトダウン', 'Meltdown'], chimera: ['キメラ工房', 'Chimera'],
  chain: ['連鎖カスケード', 'Chain Cascade'], blueprint: ['ブループリント', 'Blueprint'],
  puzzle: ['パズル遺跡', 'Puzzle Ruins'], dig: ['採掘場', 'Dig Site'],
  ghost: ['幽霊屋敷', 'Ghost House'], workshop: ['パズル工房', 'Workshop'],
  replay: ['リプレイ', 'Replay'], pvp: ['オンライン対戦', 'Online Battle'],
  ae: ['管理者イベント', 'Live Event'], zero: ['断罪', 'Judgement'],
};
const shareModeName = id => {
  const p = SHARE_MODE_NAME[id];
  return p ? t(p[0], p[1]) : t('プレイ', 'a run');
};
// クリップの焼き込みでも同じ名前を使う（表が2つに割れると必ず片方が古くなる）。
// 見出しに出すので、未知のモードは「プレイ」より無難な「ゲーム」に寄せる。
export function modeDisplayName(id) {
  const p = SHARE_MODE_NAME[id];
  return p ? t(p[0], p[1]) : t('ゲーム', 'Gameplay');
}

// シェアに使う「いまの成績」。currentMode から読むので引数が要らない。
function shareSnapshot() {
  const m = currentMode;
  const e = m && m.engine;
  if (!e) return null;
  const score = Math.max(0, Math.round(e.score || 0));
  if (score <= 0) return null;              // 0点は誘わない（宣伝にならない）
  return {
    score,
    lines: e.linesCleared || 0,
    combo: e.maxCombo || 0,
    mode: shareModeName(m.mode),
    floor: typeof m.floor === 'number' ? m.floor : null,
    wave: typeof m.wave === 'number' ? m.wave : null,
  };
}

function shareRow() {
  if (!shareSnapshot()) return '';
  return `<button class="btn btn-share" data-bba-share style="width:100%;margin-top:8px">
    ${t('スコアをシェアする', 'Share your score')}
  </button>`;
}

const SHARE_URL = `${location.origin}/?ref=share`;

function shareText(s) {
  const extra = s.floor ? t(`（${s.floor}階）`, ` (floor ${s.floor})`)
    : s.wave ? t(`（Wave ${s.wave}）`, ` (wave ${s.wave})`) : '';
  return t(
    `Block Blitz Arena の${s.mode}で ${fmt(s.score)}点${extra}！\n最大コンボ ${s.combo} / ${fmt(s.lines)}ライン消し\n\n無料・登録なしでブラウザですぐ遊べます 👇\n${SHARE_URL}\n#BlockBlitzArena #ブロックパズル`,
    `Scored ${fmt(s.score)} in ${s.mode}${extra} on Block Blitz Arena!\nBest combo ${s.combo} / ${fmt(s.lines)} lines cleared\n\nFree in your browser, no signup 👇\n${SHARE_URL}\n#BlockBlitzArena`);
}

// シェア用の画像を1枚描く。文字だけより圧倒的に目に留まるので、
// 画像を渡せる環境（Web Share API level 2）では画像も一緒に送る。
function drawShareCard(s) {
  const W = 1200, H = 630;                    // OGP と同じ比率（SNSでの見え方が安定する）
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#141a2e'); bg.addColorStop(1, '#251b3a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // 背景に薄くブロックを散らす（このゲームらしさ）。決定的に並べるので毎回同じ絵。
  const cols = ['#4f8cff', '#ffd93d', '#6bd968', '#ff6b6b', '#b06bff', '#3ecfd5'];
  // roundRect は比較的新しいAPI。無い環境で呼ぶと例外が出て、canvasToBlob が
  // null になり「シェアできませんでした」だけが出る（本文コピーにも進まない）。
  // 角丸は飾りなので、無ければ四角で描く。
  const roundOk = typeof g.roundRect === 'function';
  for (let i = 0; i < 22; i++) {
    const x = ((i * 137) % (W - 90)) + 20;
    const y = ((i * 271) % (H - 90)) + 20;
    const sz = 34 + (i % 3) * 16;
    g.globalAlpha = 0.09;
    g.fillStyle = cols[i % cols.length];
    g.beginPath();
    if (roundOk) g.roundRect(x, y, sz, sz, 8); else g.rect(x, y, sz, sz);
    g.fill();
  }
  g.globalAlpha = 1;

  g.textAlign = 'center';
  g.fillStyle = '#9fb0d0';
  g.font = 'bold 34px system-ui, sans-serif';
  g.fillText('BLOCK BLITZ ARENA', W / 2, 96);

  g.fillStyle = '#ffffff';
  g.font = 'bold 40px system-ui, sans-serif';
  g.fillText(s.mode, W / 2, 176);

  g.fillStyle = '#ffd93d';
  g.font = 'bold 168px system-ui, sans-serif';
  g.fillText(fmt(s.score), W / 2, 350);

  g.fillStyle = '#c8d4ea';
  g.font = '36px system-ui, sans-serif';
  const sub = s.floor ? t(`${s.floor}階 到達`, `Floor ${s.floor}`)
    : s.wave ? t(`Wave ${s.wave} 到達`, `Wave ${s.wave}`)
    : t(`最大コンボ ${s.combo} ・ ${fmt(s.lines)} ライン`, `${s.combo} combo · ${fmt(s.lines)} lines`);
  g.fillText(sub, W / 2, 420);

  g.fillStyle = '#7f8db0';
  g.font = '30px system-ui, sans-serif';
  g.fillText(location.host, W / 2, 552);
  return c;
}

const canvasToBlob = c => new Promise(res => c.toBlob(res, 'image/png'));

async function doShare() {
  const s = shareSnapshot();
  if (!s) return;
  const text = shareText(s);
  const title = 'Block Blitz Arena';

  // ① 画像つきで共有できるなら、それがいちばん強い（スマホの共有シート）。
  try {
    const blob = await canvasToBlob(drawShareCard(s));
    if (blob) {
      const file = new File([blob], 'block-blitz-score.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title });
        return;
      }
    }
  } catch (err) {
    // 共有シートを閉じただけ（AbortError）はエラーではない。黙って終わる。
    if (err && err.name === 'AbortError') return;
  }
  // ② 画像なしの共有シート（古いスマホ）。
  try {
    if (navigator.share) { await navigator.share({ text, title }); return; }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  // ③ PC: 文面をコピーしてから X の投稿画面を開く。
  //    どちらか片方でも成功したら「何も起きない」を避けられる。
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text); copied = true;
    }
  } catch { /* 下で案内する */ }
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  // 'noopener' を features に渡すと、開けた場合でも戻り値が null になる仕様。
  // それを「開けなかった」と読んでいたので、正常に開いた回にも失敗の案内が出ていた。
  // 代わりに rel と opener の手当てを自前で行い、戻り値で成否を判断する。
  const w = window.open(intent, '_blank');
  if (w) { try { w.opener = null; } catch { /* クロスオリジンでは触れないが害は無い */ } }
  if (!w) {
    toast(copied
      ? t('シェア文をコピーしました。好きな場所に貼り付けてください', 'Copied — paste it anywhere')
      : t('シェアできませんでした', 'Could not share'), copied ? 'ok' : 'err', 3200);
  }
}

document.addEventListener('click', ev => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-bba-share]') : null;
  if (!btn) return;
  audio.click();
  doShare();
});


// ---------------------------------------------------------------------------
// 全消し「昇華」
//
// engine.place() が返す result.perfect ＝「その1手でラインを消し、その結果
// 盤面が完全に空になった」。狙って出せるものではないので、ゲーム内のどこにも
// 説明を置かない隠し要素にしてある（気づいた人だけのごほうび）。
//
// 拾う場所: 配置結果の共通路は game.js の applyResult() → view.onPlace(result)
// ひとつだけで、その onPlace は十数個のモードがそれぞれ自前の関数で上書きして
// いく。全モードの代入箇所を書き換えると差分も事故も増えるので、代入そのものを
// 横取りして「昇華の演出 → モード本来の onPlace」の順に走らせる。モード側の
// 書き味（v.onPlace = r => this.onPlace(r) / v.onPlace = null）は変わらない。
// ---------------------------------------------------------------------------

const PERFECT_ULT_CHARGE = 35;   // 昇華ぶんの奥義ゲージ（通常の1ライン消しの約2倍）

function installPerfectHook(v) {
  let inner = null;
  const wrapped = result => {
    if (result && result.perfect) celebratePerfect(result);
    if (inner) inner(result);
  };
  try {
    Object.defineProperty(v, 'onPlace', {
      configurable: true,
      get() { return wrapped; },
      set(fn) { inner = typeof fn === 'function' ? fn : null; },
    });
  } catch { /* 定義できない環境では演出だけ諦める（進行には影響しない） */ }
}

function celebratePerfect(result) {
  const m = currentMode;
  const e = m && m.engine;
  if (!e) return;

  // 通算回数。submitResult() がここから拾ってサーバーへ送る（stats.perfectClears）。
  e.perfectClears = (e.perfectClears || 0) + 1;

  // ボーナスは「その手の消去点と同額」＝実質2倍。engine の加点経路には触らず、
  // アイテムと同じくモード側で score に足すだけにする。result.gained 自体は
  // 書き換えない ── ボス系がそのままダメージ量として使っているため。
  const bonus = Math.max(0, Math.round(result.gained || 0));
  if (bonus) e.score += bonus;
  e.chargeUlt(PERFECT_ULT_CHARGE);

  const v = view;
  if (v && v.boardSize) {
    const cx = v.boardX + v.boardSize / 2;
    const cy = v.boardY + v.boardSize * 0.45;
    v.screenFlash = Math.max(v.screenFlash || 0, 0.8);
    v.shake = Math.max(v.shake || 0, 16);
    if (v.particles) {
      v.particles.confetti(cx, cy, v.cell, 80);
      v.particles.stars(cx, cy, v.cell);
      v.particles.ring(cx, cy, v.boardSize * 0.95, '#ffe14d');
      v.particles.ring(cx, cy, v.boardSize * 0.7, '#ffffff');
    }
    v.addFloatText(cx, cy - v.cell, t('昇華！', 'ASCENSION!'), '#ffe14d', 2.2);
    if (bonus) v.addFloatText(cx, cy + v.cell * 0.9, `+${fmt(bonus)}`, '#ffffff', 1.5);
  }
  confettiBurst(70);

  // 昇華ジングル（audio.js の完全合成）。古い名前でも拾えるようにしてあるが、
  // 無い環境では既存の派手な音で代用する（勝利ファンファーレ＋高コンボ音）。
  if (typeof audio.ascend === 'function') audio.ascend();
  else if (typeof audio.ascension === 'function') audio.ascension();
  else { audio.victory(); audio.combo(9); }

  toast(t('昇華！', 'ASCENSION!'), 'announce', 2200);
  updateUltHud();
}

// ---------------------------------------------------------------------------
// Reroll power-up (1 per game)
// ---------------------------------------------------------------------------

// 「このモードは公平のためにブースターを切っている」の唯一の宣言口。
// 各モードは start() で showItemBar(false) と表明済みなので、その最後の表明を
// 覚えておき、リロールの運営特典もここを読む。宣言が2箇所に分かれていると、
// アイテムと奥義だけ止まってリロールだけ素通りする、という穴が開く。
let boostersBlocked = false;
function modeBlocksBoosters() { return boostersBlocked; }

function updateRerollHud(engine) {
  const btn = $('#btnReroll');
  btn.classList.remove('hidden');
  // 運営の∞リロール。showItemBar と同じ2つの条件を通す:
  //   ・スタッフ特典トグル（staffExtras）で運営自身が切れること
  //     ── 切れないと「素の状態を確認する」ための検証にならない
  //   ・モードが公平のためにブースターを切っている（modeBlocksBoosters）なら
  //     運営でも立てない。ランクデュエルは同一シード＝同じピース列が前提で、
  //     Elo は相手に本当に加算される。片側だけ手札を引き直せてはいけない。
  // ここは「立てない」だけで false には落とさない（カオスのルールや admintools が
  // 意図して立てた∞を消してしまうため）。
  if (session.user && session.user.role === 'admin' && staffExtras() && !modeBlocksBoosters()) {
    engine.infiniteReroll = true;
  }
  if (engine.infiniteReroll) {
    $('#rerollLeft').textContent = '∞';
    btn.classList.remove('off');
  } else {
    $('#rerollLeft').textContent = engine.rerolls;
    btn.classList.toggle('off', engine.rerolls <= 0);
  }
}

function handleEngineOver() {
  if (!currentMode) return;
  if (autoRescue()) return;   // autopilot 5.0: the guard saved the board
  if (currentMode.onTopOut) currentMode.onTopOut();
  else currentMode.finish();
}

export function rerollCurrent() {
  if (!currentMode || !currentMode.engine || !view || view.inputLocked) return;
  const e = currentMode.engine;
  if (!e.reroll()) {
    audio.error();
    toast(t('リロールは使い切りました', 'No rerolls left'), 'err', 1400);
    return;
  }
  audio.coin();
  toast(t('ピースを引き直しました！', 'New pieces drawn!'), 'ok', 1400);
  updateRerollHud(e);
  if (e.over) handleEngineOver();
}

// ---------------------------------------------------------------------------
// Ultimate skills: one equipped skill, fired when the gauge hits 100.
// Available wherever booster items are (PvE + chaos) — never in the fair-seed
// modes (AI / online / weekly), where only one side would have them.
// ---------------------------------------------------------------------------

const ULT_KEY = 'bba_ult';

export function equippedUlt() {
  const eq = session.user && session.user.equipped;
  const id = (eq && eq.ult) || localStorage.getItem(ULT_KEY) || DEFAULT_ULT;
  return ultExists(id) ? id : DEFAULT_ULT;
}

// Guests keep their choice locally; logged-in players use the server slot.
export function setGuestUlt(id) { localStorage.setItem(ULT_KEY, id); }

let ultTicker = null;

export function showUltBar(on) {
  const btn = $('#btnUlt');
  btn.classList.toggle('hidden', !on);
  clearInterval(ultTicker);
  ultTicker = null;
  if (!on) return;
  // 奥義の絵も独自アイコンへ。ショップ・ガチャ・遊び方はすでに icons.js の
  // ult_* を出しているのに、試合中のボタンだけ絵文字（💥＝ult_blast）で、
  // 同じ 💥 を使う管理者ブースター「神の一撃」と見分けが付かなかった。
  paintIcon($('#ultIcon'), itemIconName(equippedUlt()), 16);
  btn.style.setProperty('--ult-color', ultColor(equippedUlt()));
  updateUltHud();
  // Cheap poll: catches gauge changes from placements, items and timed effects
  // without threading a callback through all ten mode controllers.
  ultTicker = setInterval(updateUltHud, 120);
}

function updateUltHud() {
  const e = currentMode && currentMode.engine;
  const btn = $('#btnUlt');
  if (!e || btn.classList.contains('hidden')) return;
  // ⚡奥義祭 event: pick the charge rate up live, even mid-game. Modes can
  // stack their own bonus (rush の雷の遺物) via mode.ultRateBonus — this poll
  // must multiply it in, not clobber it.
  const ev = window.__bbaEvent;
  e.ultRate = (((ev && ev.bonus && ev.bonus.ultRate) || 1) * ((currentMode && currentMode.ultRateBonus) || 1));
  btn.classList.toggle('ult-boosted', e.ultRate > 1);
  // Admins run a permanently charged gauge.
  if (session.user && session.user.role === 'admin' && staffExtras()) e.ult = 100;
  const pct = Math.max(0, Math.min(100, Math.round(e.ult)));
  btn.style.setProperty('--ult-p', `${pct}%`);
  $('#ultPct').textContent = pct >= 100 ? 'MAX' : pct;
  btn.classList.toggle('ult-ready', pct >= 100);
  btn.classList.toggle('off', pct < 100);
}

export function fireUltCurrent() {
  const m = currentMode;
  if (!m || !m.engine || !view || view.inputLocked || m.ended) return;
  // パズル遺跡: 固定ピースの詰将棋 — 奥義は盤面契約を壊すので誰でも不可
  // (スタッフ装備の強制表示や Space/q ショートカット経由もここで止める)。
  if (m.noItems) { audio.error(); return; }
  if ($('#btnUlt').classList.contains('hidden')) return;
  const e = m.engine;
  if (e.ult < 100) {
    audio.error();
    toast(t(`ゲージが足りません（${Math.round(e.ult)}%）ラインを消して溜めよう！`,
      `Gauge not full yet (${Math.round(e.ult)}%) — clear lines to charge it!`), 'err', 1800);
    return;
  }
  const id = equippedUlt();
  const out = fireUlt(id, { engine: e, view, mode: m });
  if (out.error) {
    audio.error();
    toast(out.error, 'err', 1600);
    return;   // nothing happened — keep the gauge
  }
  e.consumeUlt();
  // Board changed: a stale game-over flag would end the run unfairly.
  if (e.over && e.hasAnyMove()) e.over = false;
  $('#btnUlt').classList.remove('ult-fire');
  void $('#btnUlt').offsetWidth;
  $('#btnUlt').classList.add('ult-fire');
  toast(out.msg, 'announce', 2600);
  updateUltHud();
  if (e.over) handleEngineOver();
}

// ---------------------------------------------------------------------------
// Booster items (consumables): usable in solo / boss / rush / dungeon / chaos.
// Logged-in inventories live on the server; guests use localStorage.
// ---------------------------------------------------------------------------

// 英語名はショップのカタログ（catalog-en.js）から id で引く。カタログ側は
// 運営専用の目印として名前の末尾に [Staff] を付けているので、HUD やトーストでは
// そこだけ外す（バーの中に出ている時点で運営専用なのは分かる）。
// 表に無い id は、ここに書いた予備の名前をそのまま使う。
function enItemName(id, fallback = '') {
  const e = CATALOG_EN[id];
  const n = e && e.name;
  return n ? n.replace(/\s*\[Staff\]\s*$/, '') : fallback;
}

const N_BOMB = enItemName('item_bomb', 'Smart Bomb');
const N_CLEANER = enItemName('item_cleaner', 'Cleaner');
const N_FEVER = enItemName('item_fever', 'Fever');
const N_MINI = enItemName('item_mini', 'Mini Blocks');
const N_WIPE = enItemName('item_god_wipe', 'God Strike');
const N_TIME = enItemName('item_god_time', 'Time Mastery');
const N_HAND = enItemName('item_god_hand', 'Creator’s Hand');
const N_MULT = enItemName('item_god_mult', 'Divine Might');
const N_SHIELD = enItemName('item_god_shield', 'Absolute Guard');
const N_NUKE = enItemName('item_god_nuke', 'Cataclysm');

// 絵は持たせない ── バーの絵は icons.js の item_* を id で引く
// （renderItemBar / itemIconName）。ここに絵文字を控えると「ショップの絵」と
// 「バーの絵」が二重管理になり、実際 💥 が神の一撃と奥義 ult_blast の
// 両方に出ていた。名前と説明だけを持つ表にする。
const ITEM_DEFS = {
  item_bomb:    { name: 'スマートボム', nameEn: N_BOMB, tip: 'スマートボム：いちばん埋まった3×3を爆破', tipEn: `${N_BOMB}: blows up the densest 3×3` },
  item_cleaner: { name: 'クリーナー', nameEn: N_CLEANER, tip: 'クリーナー：お邪魔＋最下行を掃除', tipEn: `${N_CLEANER}: clears garbage + the bottom row` },
  item_fever:   { name: 'フィーバー', nameEn: N_FEVER, tip: 'フィーバー：15秒間スコア2倍', tipEn: `${N_FEVER}: 2× score for 15 seconds` },
  item_mini:    { name: 'ミニブロック', nameEn: N_MINI, tip: 'ミニブロック：手持ちが極小ピースに変化', tipEn: `${N_MINI}: turns your hand into tiny pieces` },
  // ---- staff only (infinite, every mode) ----
  item_god_wipe:   { name: '神の一撃', nameEn: N_WIPE, admin: true, tip: '神の一撃：盤面消滅＋50,000点', tipEn: `${N_WIPE}: wipe the board, +50,000` },
  item_god_time:   { name: '時の支配', nameEn: N_TIME, admin: true, tip: '時の支配：+120秒／敵の攻撃を60秒封印', tipEn: `${N_TIME}: +120s / freeze enemies 60s` },
  item_god_hand:   { name: '創造の手札', nameEn: N_HAND, admin: true, tip: '創造の手札：最適手札＋12手は大型ピース', tipEn: `${N_HAND}: perfect hand + 12 big draws` },
  item_god_mult:   { name: '神威', nameEn: N_MULT, admin: true, tip: '神威：30秒間スコア10倍', tipEn: `${N_MULT}: 10× score for 30s` },
  item_god_shield: { name: '絶対防御', nameEn: N_SHIELD, admin: true, tip: '絶対防御：60秒間 無敵・お邪魔無効・コンボ永続', tipEn: `${N_SHIELD}: 60s invincible, no garbage, combo lock` },
  item_god_nuke:   { name: '天変地異', nameEn: N_NUKE, admin: true, tip: '天変地異：敵HPを99%削る（敵なしなら+100,000点）', tipEn: `${N_NUKE}: 99% enemy HP (or +100,000)` },
};

// Build the HUD item buttons for the current player (staff see their gear).
function renderItemBar() {
  const bar = $('#itemBar');
  const admin = session.user && session.user.role === 'admin' && staffExtras();
  const ids = Object.keys(ITEM_DEFS).filter(id => !ITEM_DEFS[id].admin || admin);
  const key = ids.join(',');
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  bar.innerHTML = ids.map(id => {
    const d = ITEM_DEFS[id];
    // title のツールチップはスマホでは絶対に読めない（指を乗せ続けられない）。
    // 何のボタンなのか分からないまま、買ったアイテムが使われずに終わっていた。
    // 短い名前を下に常時出す。
    // 絵は独自アイコン（icons.js）から id で引く ── ショップの棚と同じ絵。
    return `<button class="chip icon-btn item-btn ${d.admin ? 'admin-item' : ''}" data-item="${id}" title="${t(d.tip, d.tipEn)}">`
      + `<span class="ib-icon">${icon(itemIconName(id), { size: 18 })}<b>0</b></span>`
      + `<span class="ib-label">${t(d.name, d.nameEn)}</span>`
      + '</button>';
  }).join('');
  bar.querySelectorAll('[data-item]').forEach(b => { b.onclick = () => useGameItem(b.dataset.item); });
}


function getItemCounts() {
  // Admins carry infinite boosters.
  if (session.user && session.user.role === 'admin') {
    const inf = {};
    for (const id of Object.keys(ITEM_DEFS)) inf[id] = Infinity;
    return inf;
  }
  if (session.user) return session.user.items || {};
  try {
    const v = JSON.parse(localStorage.getItem('bba_items'));
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  const gift = { item_bomb: 1, item_cleaner: 1, item_fever: 1, item_mini: 1 };   // guest starter gift
  localStorage.setItem('bba_items', JSON.stringify(gift));
  return gift;
}

function spendItem(id) {
  if (session.user && session.user.role === 'admin') return;   // ∞ — nothing to spend
  if (session.user) {
    session.user.items = session.user.items || {};
    session.user.items[id] = Math.max(0, (session.user.items[id] || 0) - 1);
    api('/api/items/use', { method: 'POST', body: { itemId: id } })
      .then(d => { if (d.user) session.user = d.user; updateItemBar(); })
      .catch(() => refreshMe().then(updateItemBar).catch(() => {}));
  } else {
    const c = getItemCounts();
    c[id] = Math.max(0, (c[id] || 0) - 1);
    localStorage.setItem('bba_items', JSON.stringify(c));
  }
}

// Boosters and ultimates share the same "PvE only" rule, so one switch drives
// both bars — they can never drift apart.
export function showItemBar(on) {
  // 運営は自分の装備をどのモードでも持ち歩ける（設定のトグル）。
  // ただし、モードが「このモードではアイテム無し」と明示している場合は
  // それを上書きしない。上書きしていた頃は2つ問題が出ていた:
  //   ・公平のためにアイテムを切っているモード（順位戦・PvP・タイムアタック・
  //     断罪）で、運営だけアイテムと奥義が使えてしまう
  //   ・アイテムバー37px ＋ HUD の折り返し24px = 61px ぶん盤面が縮む。
  //     運営アカウントで遊ぶと全モードで盤面が小さくなっていた。
  // 運営トグル（staffExtras）は renderItemBar の側で「バーの中に運営専用
  // アイテムを出すかどうか」を既に担当している。バーを出すか出さないかは
  // モードの決定に任せる ── ここで2つを混ぜていたのが原因だった。
  const show = on;
  // モードの表明を1箇所に控える（updateRerollHud の運営特典がこれを読む）。
  boostersBlocked = !on;
  renderItemBar();
  $('#itemBar').classList.toggle('hidden', !show);
  if (show) updateItemBar();
  showUltBar(show);
}

export function updateItemBar() {
  const counts = getItemCounts();
  document.querySelectorAll('#itemBar [data-item]').forEach(b => {
    const id = b.dataset.item;
    const n = counts[id] || 0;
    b.querySelector('b').textContent = n === Infinity ? '∞' : n;
    b.classList.toggle('off', n <= 0);
  });
}

export function useGameItem(id) {
  const m = currentMode;
  if (!m || !m.engine || !view || view.inputLocked || m.ended) return;
  if (m.noItems) { audio.error(); return; }   // puzzle: fixed-piece contract
  if (!ITEM_DEFS[id]) return;
  if (ITEM_DEFS[id].admin && !(session.user && session.user.role === 'admin')) return;
  const counts = getItemCounts();
  if ((counts[id] || 0) <= 0) {
    audio.error();
    toast(t('アイテムがありません。ショップやガチャで入手！', 'No items left — get more in the Shop or Gacha!'), 'err', 2200);
    return;
  }
  const e = m.engine;

  if (id === 'item_bomb') {
    // find the densest 3x3 window and blow it up
    let best = null, bestCount = 0;
    for (let r = 0; r <= 5; r++) for (let c = 0; c <= 5; c++) {
      let n = 0;
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        if (e.grid[(r + dr) * 8 + c + dc]) n++;
      }
      if (n > bestCount) { bestCount = n; best = [r, c]; }
    }
    if (!bestCount) { audio.error(); toast(t('盤面が空です！', 'The board is empty!'), 'err', 1500); return; }
    const [br, bc] = best;
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
      const r = br + dr, c = bc + dc;
      if (e.grid[r * 8 + c]) {
        e.grid[r * 8 + c] = 0;
        view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 14, 'fx_default');
      }
    }
    audio.bossAttack();
    view.shake = 14;
    toast(t('ドカーン！', 'KABOOM!'), 'ok', 1400);
  } else if (id === 'item_cleaner') {
    let n = 0;
    for (let i = 0; i < 64; i++) if (e.grid[i] === 9) { e.grid[i] = 0; n++; }
    for (let c = 0; c < 8; c++) { const k = 7 * 8 + c; if (e.grid[k]) { e.grid[k] = 0; n++; } }
    if (n === 0) { audio.error(); toast(t('掃除するものがありません！', 'Nothing to clean up!'), 'err', 1500); return; }
    view.reviveFlash();
    audio.coin();
    toast(t(`${n}マスを掃除しました！`, `Cleaned up ${n} cells!`), 'ok', 1500);
  } else if (id === 'item_fever') {
    // すでに強い倍率がかかっているなら下げない。以前は上書きしていたので、
    // 🔥オーバードライブ(×3)の最中に⭐フィーバー(400🪙)を使うと ×2 に
    // 下がっていた ── お金を払って弱くなる、という状態だった。
    // さらに、より強い倍率が生きている間は窓も延長しない ── 以前はアイテムの
    // ×2でも必ず +15秒していたため、⭐を連打すれば×3を事実上無期限に維持
    // できた。アイテムの倍率(2)が現在有効な倍率以上のときだけ延長する。
    const feverOn = e.feverUntil > Date.now();
    const cur = feverOn ? (e.feverMult || 1) : 1;
    if (2 >= cur) {
      e.feverMult = Math.max(cur, 2);
      e.feverUntil = Math.max(e.feverUntil || 0, Date.now() + 15000);
    }
    view.screenFlash = 0.35;
    $('#hudScore').classList.add('fever');
    audio.combo(6);
    toast(t('フィーバー！15秒間スコア2倍！！', 'FEVER! 2x score for 15 seconds!!'), 'announce', 2400);
    setTimeout(() => {
      $('#hudScore').classList.remove('fever');
      if (currentMode === m && !m.ended) toast(t('フィーバー終了', 'Fever over'), '', 1200);
    }, 15000);
  } else if (id === 'item_mini') {
    // swap the whole hand for tiny 1-3 cell pieces (escape hatch!)
    const prevMini = e.chaosMini;
    e.chaosMini = true;
    e.hand = [e.drawPiece(), e.drawPiece(), e.drawPiece()];
    e.chaosMini = prevMini;
    view.reviveFlash();
    audio.coin();
    toast(t('手持ちがミニピースに変化した！', 'Your hand turned into mini pieces!'), 'ok', 1800);
  } else if (id === 'item_god_wipe') {
    const filled = [];
    for (let i = 0; i < 64; i++) if (e.grid[i]) { filled.push(i); e.grid[i] = 0; }
    for (const i of filled) view.particles.burstCell(view.boardX + ((i % 8) + 0.5) * view.cell, view.boardY + (Math.floor(i / 8) + 0.5) * view.cell, view.cell, 14, 'fx_default');
    const gained = Math.round(50000 * (e.scoreMult || 1) * (e.feverUntil > Date.now() ? (e.feverMult || 2) : 1));
    e.score += gained;
    if (m.onPlace) m.onPlace({ placedCells: [[0, 0]], color: 1, fullRows: [], fullCols: [], clearedCells: [], lineCount: 0, gained, streak: e.streak, over: false });
    view.shake = 22; view.screenFlash = 0.7; audio.bossDefeated();
    toast(t(`神の一撃！ +${fmt(gained)}`, `${N_WIPE}! +${fmt(gained)}`), 'announce', 2000);
  } else if (id === 'item_god_time') {
    if (m.endAt !== undefined && m.timerInt) { m.endAt += 120000; m.timeLeft += 120; if (m.updateTimerHud) m.updateTimerHud(); }
    if (m.nextAtk) m.nextAtk += 60000;
    if (m.nextAt) m.nextAt += 60000;
    if (m.endAt === undefined && !m.nextAtk && !m.nextAt) e.rerolls += 10;
    view.screenFlash = 0.4; audio.combo(7);
    toast(t('時の支配！時間+120秒／敵を60秒封印', `${N_TIME}! +120s / enemies frozen 60s`), 'announce', 2000);
  } else if (id === 'item_god_hand') {
    const out = fireUlt('ult_rainbow', { engine: e, view, mode: m });
    e.godDraws = 12;
    if (out.error) toast(out.error, 'err', 1500);
    else toast(t('創造の手札！次の12手は大型ピース', `${N_HAND}! 12 big draws incoming`), 'announce', 2000);
  } else if (id === 'item_god_mult') {
    e.feverUntil = Date.now() + 30000;
    e.feverMult = 10;
    $('#hudScore').classList.add('fever');
    view.screenFlash = 0.5; audio.combo(9);
    toast(t('神威！30秒間スコア10倍！！', `${N_MULT}! 10× score for 30s!!`), 'announce', 2400);
    setTimeout(() => { if (e.feverMult === 10) { e.feverMult = 2; $('#hudScore').classList.remove('fever'); } }, 30000);
  } else if (id === 'item_god_shield') {
    view.godInvincibleUntil = Date.now() + 60000;
    e.fortressUntil = Math.max(e.fortressUntil || 0, Date.now() + 60000);
    e.streakShield = true;
    view.reviveFlash(); view.screenFlash = 0.4; audio.combo(6);
    toast(t('絶対防御！60秒間 無敵・お邪魔無効・コンボ永続', `${N_SHIELD}! 60s invincible, no garbage, combo lock`), 'announce', 2400);
  } else if (id === 'item_god_nuke') {
    if (typeof m.hp === 'number' && (m.mode === 'boss' || m.mode === 'dungeon' || m.raidBoss)) {
      const dmg = Math.max(0, m.hp - Math.ceil(m.hp * 0.01));
      m.hp -= dmg;
      e.score += dmg;
      if (m.updateHpBar) m.updateHpBar();
      if (m.updateRaidHp) m.updateRaidHp();
      if (m.damageFloat) m.damageFloat(dmg, true);
      view.shake = 24; view.screenFlash = 0.8; audio.bossAttack();
      toast(t(`天変地異！ -${fmt(dmg)}`, `${N_NUKE}! -${fmt(dmg)}`), 'announce', 2000);
    } else {
      e.score += 100000;
      if (m.updateHud) m.updateHud(); else if (m.updateMyHud) m.updateMyHud(e);
      view.shake = 24; view.screenFlash = 0.8; audio.bossDefeated();
      toast(t('天変地異！ +100,000', `${N_NUKE}! +100,000`), 'announce', 2000);
    }
  }

  // survivors of a bomb/clean: board changed, over-state may be stale
  if (e.over && e.hasAnyMove()) e.over = false;
  e.itemUses = (e.itemUses || 0) + 1;
  spendItem(id);
  updateItemBar();
  // 逆向きも見る。ここは片方向（over を下ろすだけ）で、詰みを立て直す側が
  // 無かった。🧩ミニブロックは engine を通さず e.hand を直接差し替えるため、
  // 差し替わった3枚がどこにも入らないと over が立たないまま止まる ──
  // place() は呼ばれず onGameOver も走らないので、置けない・終われない・
  // スコアも送られない状態で取り残される（脱出用アイテムが詰みを作る）。
  // 手札を書き換えたら判定し直すのは、キメラ・穴掘り・奥義と同じ作法。
  if (!e.over && !e.hasAnyMove()) { e.over = true; handleEngineOver(); }
}

// ---------------------------------------------------------------------------
// Autopilot 5.0 (admin only): the strongest AI plays your board, any mode.
// The ♾️不滅 (immortal) brain plans for survival, and the 🚑 guard layer pulls
// dead boards back to life before the game-over pipeline ever sees them.
// ---------------------------------------------------------------------------

export const autopilot = {
  on: false, speed: 1, timer: null,
  brain: 'immortal', style: 'normal', guard: true, lastPlan: null,
  autoItems: true, autoUlt: true, autoContinue: false, autoPerks: true, targetScore: 0,
  stats: { moves: 0, clears: 0, rescues: 0, thinkMs: 0, started: 0 },
};

function isAdmin() { return !!session.user && session.user.role === 'admin'; }

export function getCurrentMode() { return currentMode; }
export function getViewRef() { return view; }

function updateAutoBtn() {
  const btn = $('#btnAuto');
  const show = staffExtras();
  btn.classList.toggle('hidden', !show);
  $('#autoState').textContent = autopilot.on ? `x${autopilot.speed}` : 'OFF';
  btn.classList.toggle('auto-on', autopilot.on);
  $('#btnAdminCmd').classList.toggle('hidden', !show);
}

// Kept for older callers: tap cycles on → faster → off.
export function toggleAutopilot() {
  if (!isAdmin()) return;
  audio.click();
  if (!autopilot.on) {
    autopilot.on = true;
    toast(t('オートパイロット起動（長押しで設定）', 'Autopilot on (hold for settings)'), 'ok', 2000);
  } else if (autopilot.speed < 32) {
    autopilot.speed *= 2;
    toast(`x${autopilot.speed}`, '', 1000);
  } else {
    stopAutopilot();
    return;
  }
  updateAutoBtn();
  runAutopilot();
}

// Autopilot fires boosters like a pro: cleaner for garbage floods, bomb for
// clogged boards, fever whenever the board is open enough to combo. In an
// emergency (5.0): cooldowns collapse and items become life support.
function autoUseItems(m) {
  const e = m.engine;
  const plan = autopilot.lastPlan;
  const emergency = plan && (plan.stranded > 0 || plan.missingW > 0.25);
  if (Date.now() - (autopilot.itemAt || 0) < (emergency ? 600 : 2500)) return;
  if ($('#itemBar').classList.contains('hidden')) return;
  // Ultimates first: a charged gauge is always the strongest button available.
  if (autopilot.autoUlt !== false && e.ult >= 100
    && Date.now() - (autopilot.ultAt || 0) > (emergency ? 900 : 3000)) {
    autopilot.itemAt = autopilot.ultAt = Date.now();
    fireUltCurrent();
    return;
  }
  if (autopilot.autoItems === false) return;
  const counts = getItemCounts();
  const filled = e.grid.reduce((a, x) => a + (x ? 1 : 0), 0);
  const garbage = e.grid.reduce((a, x) => a + (x === 9 ? 1 : 0), 0);
  if (emergency) {
    if (garbage >= 3 && (counts.item_cleaner || 0) > 0) {
      autopilot.itemAt = Date.now();
      useGameItem('item_cleaner');
      return;
    }
    if (filled >= 20 && (counts.item_bomb || 0) > 0) {
      autopilot.itemAt = Date.now();
      useGameItem('item_bomb');
      return;
    }
    if (plan.stranded > 0 && (counts.item_mini || 0) > 0) {
      autopilot.itemAt = Date.now();
      useGameItem('item_mini');
      return;
    }
  }
  if (garbage >= 8 && (counts.item_cleaner || 0) > 0) {
    autopilot.itemAt = Date.now();
    useGameItem('item_cleaner');
  } else if (filled >= 44 && (counts.item_bomb || 0) > 0) {
    autopilot.itemAt = Date.now();
    useGameItem('item_bomb');
  } else if ((counts.item_fever || 0) > 0 && !(e.feverUntil > Date.now())
    && filled < 30 && Date.now() - (autopilot.feverAt || 0) > 20000) {
    autopilot.itemAt = autopilot.feverAt = Date.now();
    useGameItem('item_fever');
  }
}

// ---------------------------------------------------------------------------
// 🚑 Auto-rescue (autopilot 5.0): called from every game-over entry point in
// the local PvE modes. When the board dies it redraws / detonates its way back
// to a playable state BEFORE the finish pipeline runs. Fair-seed and
// server-authoritative modes (AI / online / weekly / co-op / intent) never
// qualify — the whitelist below is deliberate.
// ---------------------------------------------------------------------------

const RESCUE_MODES = new Set(['solo', 'boss', 'dungeon', 'chaos', 'survival', 'sprint', 'dig', 'ghost']);
let rescueBusy = false;

function autoRescue() {
  if (!autopilot.on || autopilot.guard === false || rescueBusy) return false;
  const m = currentMode;
  if (!m || !m.engine || m.ended || !view) return false;
  if (m.usesIntent || m.isCoop || !RESCUE_MODES.has(m.mode)) return false;
  const e = m.engine;
  const alive = () => {
    if (e.over && e.hasAnyMove()) e.over = false;
    return !e.over;
  };
  if (alive()) return true;   // stale flag — nothing to do
  rescueBusy = true;
  try {
    // 1) Redraw the hand. engine.reroll() refuses on a dead board by design,
    //    so the guard lifts the flag first — this is a staff tool, and exactly
    //    the moment infinite rerolls exist for.
    const redraw = tries => {
      while (!alive() && tries-- > 0) {
        e.over = false;
        if (!e.reroll()) { e.over = !e.hasAnyMove(); break; }
      }
    };
    redraw(e.infiniteReroll ? 16 : Math.max(0, e.rerolls));
    // 2) Open the board with items, then redraw once more.
    if (!alive() && !$('#itemBar').classList.contains('hidden')) {
      const counts = getItemCounts();
      for (const id of ['item_bomb', 'item_mini', 'item_cleaner']) {
        if (alive()) break;
        if ((counts[id] || 0) > 0) useGameItem(id);
      }
      redraw(e.infiniteReroll ? 8 : Math.max(0, e.rerolls));
    }
    if (!alive()) return false;
    autopilot.stats.rescues = (autopilot.stats.rescues || 0) + 1;
    updateRerollHud(e);
    if (view.reviveFlash) view.reviveFlash();
    toast(t('オートレスキュー！', 'Auto-rescue!'), 'ok', 1200);
    return true;
  } finally {
    rescueBusy = false;
  }
}

// Try a move on a scratch engine; returns { lineCount, filled, mobility }.
function simMove(engine, index, row, col) {
  const s = new Engine(1);
  s.grid = engine.grid.slice();
  s.hand = engine.hand.map(p => (p ? { ...p } : null));
  s.streakShield = true;
  const r = s.place(index, row, col);
  if (!r) return null;
  const filled = s.grid.reduce((a, x) => a + (x ? 1 : 0), 0);
  let mobility = 0;
  for (const p of s.hand) if (p) mobility += s.placements(p).length;
  return { lineCount: r.lineCount, filled, mobility };
}

// Style layer on top of the brain: bias the chosen move toward the goal.
function pickAutoMove(engine) {
  const brain = autopilot.brain || 'immortal';
  if (brain === 'immortal') {
    // 5.0 brain: styles are weights inside the search, not an override on top.
    const plan = planImmortalMove(engine, autopilot.style || 'normal');
    autopilot.lastPlan = plan;
    autopilot.stats.thinkMs = Math.round(plan.ms * 10) / 10;
    return plan.move;
  }
  autopilot.lastPlan = null;
  const base = chooseMove(engine, brain);
  const style = autopilot.style || 'normal';
  if (style === 'normal' || !base) return base;
  let best = base, bestScore = -Infinity;
  for (let i = 0; i < engine.hand.length; i++) {
    const p = engine.hand[i];
    if (!p) continue;
    for (const [r, c] of engine.placements(p)) {
      const sim = simMove(engine, i, r, c);
      if (!sim) continue;
      const score = style === 'clear' ? -sim.filled * 10 + sim.lineCount * 5
        : style === 'combo' ? sim.lineCount * 1000 + sim.mobility
        : /* safe */ sim.mobility * 10 - sim.filled + sim.lineCount * 50;
      if (score > bestScore) { bestScore = score; best = { index: i, row: r, col: c }; }
    }
  }
  // Never let a style pick a move the brain thinks is a blunder when a clear
  // was available: combo/clear styles only override on a real gain.
  if (style === 'combo') {
    const b = simMove(engine, base.index, base.row, base.col);
    const s = simMove(engine, best.index, best.row, best.col);
    if (b && s && s.lineCount <= b.lineCount) return base;
  }
  return best;
}

export function runAutopilot() {
  clearTimeout(autopilot.timer);
  if (!autopilot.on) return;
  if (!autopilot.stats.started) autopilot.stats.started = Date.now();
  autopilot.timer = setTimeout(() => {
    const m = currentMode;
    if (m && m.engine && view && view.running && !view.inputLocked && !m.engine.over && !m.ended) {
      if (autopilot.targetScore && m.engine.score >= autopilot.targetScore) {
        stopAutopilot();
        toast(t(`目標スコア ${fmt(autopilot.targetScore)} に到達したので停止`, `Target score ${fmt(autopilot.targetScore)} reached — stopped`), 'ok', 2600);
        return;
      }
      autoUseItems(m);
      const mv = pickAutoMove(m.engine);
      const plan = autopilot.lastPlan;
      if (plan && plan.stranded > 0 && (m.engine.infiniteReroll || m.engine.rerolls > 0)
        && !m.usesIntent && !m.isCoop) {
        // 5.0: the search proved no order places this hand. Redraw NOW —
        // placing first can flip `over`, and a dead board refuses rerolls.
        m.engine.reroll();
        updateRerollHud(m.engine);
        if (m.engine.over) handleEngineOver();
      } else if (mv) {
        if ((m.isCoop || m.usesIntent) && view.onIntentPlace) {
          view.onIntentPlace(mv.index, mv.row, mv.col);   // mode-authoritative placement
        } else {
          const r = m.engine.place(mv.index, mv.row, mv.col);
          if (r) {
            // 5.0 guard: pull a dead refill back to life before the game-over
            // pipeline (applyResult → onGameOver) ever sees it.
            if (r.over && autoRescue()) r.over = false;
            view.applyResult(r);
            autopilot.stats.moves++; autopilot.stats.clears += r.lineCount;
          }
        }
      } else if (m.engine.rerolls > 0 || m.engine.infiniteReroll) {
        m.engine.reroll();
        updateRerollHud(m.engine);
        if (m.engine.over) handleEngineOver();
      }
    } else if (autopilot.autoContinue && m && m.ended) {
      // Keep going: "play again" / "next floor" / "revenge" on the result modal.
      const again = document.querySelector('#modal-root #rAgain');
      if (again) again.click();
    }
    runAutopilot();
  }, autopilot.speed >= 32 ? 15 : 700 / autopilot.speed);
}

export function stopAutopilot() {
  autopilot.on = false;
  autopilot.speed = 1;
  autopilot.lastPlan = null;
  autopilot.stats = { moves: 0, clears: 0, rescues: 0, thinkMs: 0, started: 0 };
  clearTimeout(autopilot.timer);
  updateAutoBtn();
}

// ---------------------------------------------------------------------------
// Solo (endless)
// ---------------------------------------------------------------------------

class SoloMode {
  constructor() { this.mode = 'solo'; }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('solo');
  }

  best() {
    return session.user ? Math.max(session.user.stats.bestScore, guestBest()) : guestBest();
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `BEST ${fmt(Math.max(this.best(), this.engine.score))}`;
  }

  onPlace() { this.updateHud(); }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    if (e.score > guestBest()) setGuestBest(e.score);
    const rewards = await submitResult({
      mode: 'solo', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら、結果モーダルをメニューの上に
    // 出さない（currentMode 無しで start() する壊れた run を防ぐ）。
    if (currentMode !== this) return;
    const isBest = e.score >= this.best();
    if (isBest && e.score > 0) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }
  destroy() {}
}

// ---------------------------------------------------------------------------
// ☢️ メルトダウン: ライン消しで炉心温度＝スコア倍率が上がり、100%で爆発。
// 盤面に湧く冷却セル(❄️)を含むラインを消すと熱が下がる — 稼ぐペダルと
// ブレーキが同じペダル。臨界(90%+)で置くと倍率さらに1.5倍。
// ---------------------------------------------------------------------------

class MeltdownMode {
  constructor() {
    this.mode = 'meltdown';
    this.usesIntent = true;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.remove('hidden');   // 熱ゲージとして流用
    showItemBar(false);   // 純スコアタ — アイテム/奥義なし
    this.startedAt = Date.now();
    this.ended = false;
    this.heat = 0;
    this.maxHeat = 0;
    this.placedSince = 0;
    this.coolCells = new Set();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.coolCells = this.coolCells;
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('oni');
    this.alarmInt = setInterval(() => this.alarmTick(), 600);
    // トーストは textContent に入るので、盤面の冷却セルは絵ではなく言葉で指す。
    toast(t('消すほど熱く、熱いほど稼げる。100%で爆発！青い冷却セルごと消せば冷える！', 'Clears heat the core — heat multiplies your score. 100% = boom! Clear the blue coolant cells to cool it down!'), 'announce', 3200);
  }

  mult() {
    const base = 1 + this.heat / 10;
    return Math.round(base * (this.heat >= 90 ? 1.5 : 1) * 10) / 10;
  }

  // 神モードの盤面リセットやスタッフアイテムはグリッドを直接書き換える —
  // Set がグリッドとズレたら幻の❄️や不正な冷却になるので、毎手同期する。
  pruneCool() {
    const e = this.engine;
    for (const k of [...this.coolCells]) if (e.grid[k] !== 6) this.coolCells.delete(k);
  }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    this.pruneCool();
    const v = getView();
    const save = e.scoreMult;
    e.scoreMult = save * this.mult();
    const result = e.place(index, row, col);
    e.scoreMult = save;
    if (!result) return true;
    let cooled = 0;
    if (result.lineCount) {
      for (const [r, c] of result.clearedCells) {
        const k = r * 8 + c;
        if (this.coolCells.has(k)) { this.coolCells.delete(k); cooled++; }
      }
      this.heat = Math.max(0, Math.min(100, this.heat + 4 + 5 * result.lineCount - cooled * 35));
    }
    v.applyResult(result);
    if (cooled) {
      // canvas に描く文字なので SVG は置けない。言葉だけにする。
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.3, t(`冷却 -${cooled * 35}%`, `COOLED -${cooled * 35}%`), '#4dd0ff', 1.6);
      audio.coin();
    }
    this.maxHeat = Math.max(this.maxHeat, this.heat);
    this.placedSince++;
    if (this.placedSince >= 3) { this.placedSince = 0; this.spawnCool(); }
    this.updateHud();
    if (this.ended) return true;
    if (this.heat >= 100) this.meltdown();
    return true;
  }

  // 3手ごとに冷却セルが湧く。置き場を奪って窒息させたら本末転倒なので、
  // 湧いた結果ノーモーブになるときは取り消す。
  spawnCool() {
    const e = this.engine;
    const empty = [];
    for (let k = 0; k < 64; k++) if (!e.grid[k]) empty.push(k);
    if (empty.length < 6) return;
    const k = empty[(Math.random() * empty.length) | 0];
    e.grid[k] = 6;
    // 湧いた1マスが行や列を完成させることがある。その場で消さないと、
    // 揃った8マスが盤面に居座り、**次にどこかへ1手置いた人**がその行の
    // 得点・コンボ・ライン数・熱をまとめて受け取ってしまう（熱は
    // ライン数で上がるので、炉心爆発が想定より早く来る）。
    // addGarbage() と bossImpact() は必ず resolveLines() を通しているのに、
    // ここだけ通っていなかった。hasAnyMove() より**前**に消すこと ──
    // 順番が逆だと、消えれば8マス空く盤面で「窒息する」と誤判定して
    // せっかくの冷却セルを取り消してしまう。
    const cleared = e.resolveLines();
    if (!e.hasAnyMove()) { e.grid[k] = 0; this.pruneCool(); return; }
    // 消えた行に載っていた冷却セル（今回の1マスも含む）は、もう盤面に無い。
    // Set に残すと幻の❄️になるので、グリッドと突き合わせて捨てる。
    if (cleared && cleared.lineCount) this.pruneCool();
    if (e.grid[k] !== 6) return;      // 湧いた瞬間に自分ごと消えた
    this.coolCells.add(k);
    const v = getView();
    v.spawnAnim.set(k, v.time);
  }

  alarmTick() {
    if (this.ended) return;
    const v = getView();
    if (this.heat >= 85) v.screenFlash = Math.max(v.screenFlash, 0.1);
    if (this.heat >= 95) audio.countdown(false);
  }

  meltdown() {
    const v = getView();
    v.screenFlash = 0.8;
    v.shake = 22;
    audio.bossAttack();
    confettiBurst(60);
    toast(t('炉心爆発！！', 'CORE MELTDOWN!!'), 'err', 2500);
    this.finish(true);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = `×${this.mult().toFixed(1)} ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`;
    const timer = $('#hudTimer');
    // 炉心温度。🔥 は「熱」を表す絵なので独自アイコン（fire）に差し替える。
    // textContent では SVG が文字列のまま出てしまうため innerHTML にする。
    timer.innerHTML = `${ic('fire', 15)} ${Math.round(this.heat)}%`;
    timer.classList.toggle('urgent', this.heat >= 85);
    const fill = $('#chaosBarFill');
    fill.style.width = `${Math.round(this.heat)}%`;
    fill.style.background = this.heat < 50 ? '#43d9e8' : this.heat < 85 ? '#ffa93d' : '#ff3b3b';
  }

  best() {
    const local = Number(localStorage.getItem('bba_meltdown_best') || 0);
    return session.user ? Math.max(local, session.user.stats.meltdownBest || 0) : local;
  }

  async finish(exploded = false) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.alarmInt);
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_meltdown_best') || 0);
    const isBest = e.score > 0 && e.score >= Math.max(localBest, this.best());
    if (e.score > localBest) localStorage.setItem('bba_meltdown_best', String(e.score));
    const rewards = await submitResult({
      mode: 'meltdown', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : exploded ? 'lose' : 'draw'}">${isBest ? 'NEW RECORD!' : exploded ? `${ic('mode_meltdown', 26)} ${t('炉心爆発…', 'MELTDOWN…')}` : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${ic('fire')} ${t('最高熱', 'Peak heat')}</span><b>${Math.round(this.maxHeat)}%</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    clearInterval(this.alarmInt);
    const timer = $('#hudTimer');
    timer.classList.add('hidden');
    timer.classList.remove('urgent');
    $('#chaosBar').classList.add('hidden');
    const fill = $('#chaosBarFill');
    fill.style.background = '';
    fill.style.width = '0%';
    if (view) { view.onIntentPlace = null; view.coolCells = null; }
  }
}

// ---------------------------------------------------------------------------
// 🧬 キメラ工房: 手札のピースをドラッグで溶接して怪物ピースを錬成。
// 合体数がそのままスコア倍率（2体=×2、3体=×3）。手札は全部置くまで
// 補充されないので、合体は常に窒息リスクとの取引になる。
// ---------------------------------------------------------------------------

function chimeraMerge(aCells, bCells, how) {
  const { rows: ar, cols: ac } = shapeSize(aCells);
  const off = how === 'side' ? [0, ac] : how === 'down' ? [ar, 0] : [ar, ac];
  const merged = [
    ...aCells.map(([r, c]) => [r, c]),
    ...bCells.map(([r, c]) => [r + off[0], c + off[1]]),
  ];
  const { rows, cols } = shapeSize(merged);
  if (rows > 8 || cols > 8) return null;
  return merged;
}

function chimeraCellsHtml(cells) {
  const { rows, cols } = shapeSize(cells);
  const on = new Set(cells.map(([r, c]) => r * cols + c));
  let inner = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) inner += `<i class="${on.has(r * cols + c) ? 'on' : ''}"></i>`;
  }
  return `<span class="deck-piece" style="grid-template-columns:repeat(${cols},9px)">${inner}</span>`;
}

class ChimeraMode {
  constructor() {
    this.mode = 'chimera';
    this.usesIntent = true;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    showItemBar(false);   // ミニブロック等は錬成した手札を壊してしまう
    this.startedAt = Date.now();
    this.ended = false;
    this.welds = 0;
    this.maxWeld = 1;
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onTrayDrop = (from, to) => this.tryWeld(from, to);
    v.onPlace = null;
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('solo');
    toast(t('ピースをピースにドラッグで溶接！大きいほど高倍率！', 'Drag a piece onto another to weld them — bigger means bigger multipliers!'), 'announce', 3200);
  }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    const v = getView();
    const weld = piece.weld || 1;
    const save = e.scoreMult;
    e.scoreMult = save * weld;
    const result = e.place(index, row, col);
    e.scoreMult = save;
    if (!result) return true;
    v.applyResult(result);
    if (weld > 1 && result.lineCount) {
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.3, t(`キメラ ×${weld}！`, `CHIMERA ×${weld}!`), '#b06bff', 1.8);
      audio.combo(6 + weld);
    }
    this.updateHud();
    return true;
  }

  // ピースをピースに落とすと溶接候補（横/縦/斜め）を提示。
  tryWeld(from, to) {
    const e = this.engine;
    const base = e.hand[to];
    const add = e.hand[from];
    if (!base || !add || from === to || this.ended) return false;
    const opts = [
      ['side', t('→ 横に接合', '→ weld right')],
      ['down', t('↓ 縦に接合', '↓ weld below')],
      ['diag', t('↘ 斜めに接合', '↘ weld diagonal')],
    ].map(([how, label]) => ({ how, label, cells: chimeraMerge(base.cells, add.cells, how) }))
      .filter(o => o.cells);
    if (!opts.length) {
      toast(t('大きすぎて溶接できない！', 'Too big to weld!'), 'err', 1500);
      return true;
    }
    const v = getView();
    v.inputLocked = true;
    const m = showModal(`
      <h2>${ic('mode_chimera', 22)} ${t('溶接する？', 'Weld them?')}</h2>
      <div class="form-col">
        ${opts.map((o, i) => `
          <button class="btn btn-ghost perk-btn" data-perk="${i}">
            <span class="perk-icon">${ic('mode_chimera', 26)}</span>
            <span class="perk-body"><b>${o.label} ${chimeraCellsHtml(o.cells)}</b><small>${t(`${o.cells.length}マスの怪物ピース ・ 倍率×${(base.weld || 1) + (add.weld || 1)}`, `${o.cells.length}-cell monster ・ ×${(base.weld || 1) + (add.weld || 1)} multiplier`)}</small></span>
          </button>`).join('')}
      </div>
      <div class="modal-buttons"><button class="btn btn-ghost" id="wldCancel">${t('やめる', 'Cancel')}</button></div>`,
      { dismissable: false });
    const done = () => { v.inputLocked = false; closeModal(); };
    m.querySelector('#wldCancel').onclick = () => { audio.click(); done(); };
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => {
        const o = opts[Number(b.dataset.perk)];
        const weld = (base.weld || 1) + (add.weld || 1);
        e.hand[to] = { shape: -1, cells: o.cells, color: base.color, weld };
        e.hand[from] = null;
        this.welds++;
        this.maxWeld = Math.max(this.maxWeld, weld);
        audio.levelUp();
        done();
        // 巨大ピースで詰んだ扱いにしない — 置けるかは手札次第で判定し直す
        if (!e.hasAnyMove()) { e.over = true; this.finish(); }
        else e.over = false;
        this.updateHud();
      };
    });
    return true;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').innerHTML = ic('mode_chimera', 13) + ' ' + t(`合体${this.welds}回 ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`, `${this.welds} welds ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`);
  }

  best() {
    const local = Number(localStorage.getItem('bba_chimera_best') || 0);
    return session.user ? Math.max(local, session.user.stats.chimeraBest || 0) : local;
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_chimera_best') || 0);
    const isBest = e.score > 0 && e.score >= Math.max(localBest, this.best());
    if (e.score > localBest) localStorage.setItem('bba_chimera_best', String(e.score));
    const rewards = await submitResult({
      mode: 'chimera', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${ic('mode_chimera')} ${t('溶接回数', 'Welds')}</span><b>${fmt(this.welds)}</b></div>
        <div class="rs-row"><span>${ic('mode_chimera')} ${t('最大キメラ', 'Biggest chimera')}</span><b>×${fmt(this.maxWeld)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  destroy() {
    this.ended = true;
    if (view) { view.onIntentPlace = null; view.onTrayDrop = null; }
  }
}

// ---------------------------------------------------------------------------
// 🧩 パズル遺跡 (v2.6) — stage-based puzzle rooms. Each stage is built by
// REVERSE CONSTRUCTION: fill a band of rows (or columns), then carve whole
// pieces out of it. The player gets exactly those carved pieces, so placing
// each piece back in its home completes every line — a solution always
// exists. Win = every ORIGINAL cell cleared (leftover player cells are fine;
// this is what keeps mid-solve line clears from ever dead-locking a stage).
// ---------------------------------------------------------------------------

function puzzleStars() {
  try { return JSON.parse(localStorage.getItem('bba_puzzle_stars') || '{}'); } catch { return {}; }
}
export function puzzleBestStage() {
  const local = Number(localStorage.getItem('bba_puzzle_stage') || 0);
  return session.user ? Math.max(local, session.user.stats.puzzleStage || 0) : local;
}

// Deterministic stage layout — every player gets the same ruins.
function genPuzzleStage(stage) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = new Rng(((stage * 2654435761) ^ (attempt * 40503) ^ 0x9e3779) >>> 0);
    const vertical = rng.next() < 0.5;
    const band = Math.min(5, 2 + Math.floor((stage - 1) / 8));      // 2..5 lines
    const p0 = rng.int(8 - band + 1);
    const wantPieces = Math.min(10, 3 + Math.floor((stage - 1) / 4)); // 3..10 pieces
    const grid = new Array(64).fill(0);
    const inBand = (r, c) => vertical ? (c >= p0 && c < p0 + band) : (r >= p0 && r < p0 + band);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (inBand(r, c)) grid[r * 8 + c] = 1 + ((vertical ? c : r) % 8);
    }
    const pieces = [];
    let guard = 260;
    while (pieces.length < wantPieces && guard-- > 0) {
      const si = rng.int(SHAPES.length);
      const cells = SHAPES[si].cells;
      const { rows, cols } = shapeSize(cells);
      const r0 = rng.int(Math.max(1, 8 - rows + 1));
      const c0 = rng.int(Math.max(1, 8 - cols + 1));
      let ok = true;
      for (const [dr, dc] of cells) {
        const r = r0 + dr, c = c0 + dc;
        if (r >= 8 || c >= 8 || !inBand(r, c) || grid[r * 8 + c] === 0) { ok = false; break; }
      }
      if (!ok) continue;
      for (const [dr, dc] of cells) grid[(r0 + dr) * 8 + (c0 + dc)] = 0;
      pieces.push({ shape: si, cells, color: SHAPES[si].color });
    }
    if (pieces.length < 2) continue;   // degenerate carve — reroll deterministically
    // A fully-carved line would clear as soon as an unrelated line completes
    // nothing — more importantly it has no originals, which is fine. But a
    // band line with only 1-2 originals left is a nice puzzle; no extra work.
    for (let i = pieces.length - 1; i > 0; i--) {   // deterministic shuffle
      const k = rng.int(i + 1);
      [pieces[i], pieces[k]] = [pieces[k], pieces[i]];
    }
    const targets = new Set();
    for (let k = 0; k < 64; k++) if (grid[k] !== 0) targets.add(k);
    return { grid, pieces, targets, band, vertical };
  }
  // Unreachable in practice; a 1-piece fallback stage keeps the mode alive.
  const grid = new Array(64).fill(0);
  for (let c = 0; c < 7; c++) grid[7 * 8 + c] = 1 + (c % 8);
  return { grid, pieces: [{ shape: 0, cells: SHAPES[0].cells, color: SHAPES[0].color }], targets: new Set([56, 57, 58, 59, 60, 61, 62]), band: 1, vertical: false };
}

class PuzzleMode {
  constructor(stage = 1) {
    this.mode = 'puzzle';
    this.usesIntent = true;
    this.noItems = true;   // fixed queue — items/ults would break solvability
    this.stage = Math.max(1, Math.floor(stage));
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.add('hidden');
    showItemBar(false);   // 固定ピースのパズル — アイテム/奥義は無効
    $('#btnReroll').classList.add('hidden');   // リロールも遺跡では禁止
    this.startedAt = Date.now();
    this.ended = false;
    const st = genPuzzleStage(this.stage);
    this.targets = st.targets;
    this.queue = st.pieces.slice();
    this.total = st.pieces.length;
    const v = getView();
    this.engine = new Engine();
    this.engine.grid = st.grid.slice();
    this.engine.rerolls = 0;
    this.engine.refillHand = () => {};        // the queue is the only source
    this.engine.reroll = () => false;
    this.engine.hand = [this.queue.shift() || null, this.queue.shift() || null, this.queue.shift() || null];
    v.setEngine(this.engine);
    v.glowCells = this.targets;               // originals shimmer = what to clear
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateAutoBtn();
    v.start();
    audio.playTrack('ruins');
    toast(t(`ステージ${this.stage}：光るブロックをすべて消そう！ピースは使い切り！`,
      `Stage ${this.stage}: clear every glowing block — no piece refills!`), 'announce', 3200);
  }

  remaining() { return this.queue.length + this.engine.hand.filter(Boolean).length; }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    const result = e.place(index, row, col);
    if (!result) return true;
    e.hand[index] = this.queue.shift() || null;   // fixed queue, no random refills
    for (const [r, c] of result.clearedCells) this.targets.delete(r * 8 + c);
    // place() judged "no moves" against the pre-refill hand — re-judge after
    // the queue refill so applyResult doesn't fire a phantom game over.
    e.over = false;
    result.over = false;
    getView().applyResult(result);
    this.updateHud();
    if (this.ended) return true;
    if (this.targets.size === 0) { this.finish(true); return true; }
    if (!e.hasAnyMove()) {
      e.over = true;
      this.finish(false);
    }
    return true;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    bumpScore(el);
    $('#hudSub').textContent = t(`ステージ${this.stage} ・ 残り${this.targets.size}マス`, `Stage ${this.stage} — ${this.targets.size} left`);
    $('#hudTimer').innerHTML = `${ic('mode_puzzle', 15)} ${this.remaining()}`;
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const secs = (Date.now() - this.startedAt) / 1000;
    const stars = won ? (secs <= 45 ? 3 : secs <= 90 ? 2 : 1) : 0;
    let firstClear = false;
    if (won) {
      const all = puzzleStars();
      if ((all[this.stage] || 0) < stars) { all[this.stage] = stars; localStorage.setItem('bba_puzzle_stars', JSON.stringify(all)); }
      const localBest = Number(localStorage.getItem('bba_puzzle_stage') || 0);
      firstClear = this.stage > localBest;
      if (firstClear) localStorage.setItem('bba_puzzle_stage', String(this.stage));
      confettiBurst(stars >= 3 ? 60 : 30);
      audio.victory();
    } else {
      // 手詰まりは intent() が result.over を消してから applyResult に渡すので、
      // game.js の audio.gameOver() 経路には絶対に入らない。ここで鳴らさないと
      // 「❌ 失敗…」のモーダルが完全に無音で出る。
      audio.gameOver();
    }
    const rewards = await submitResult({
      mode: 'puzzle', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      // ⭐ ステージ評価も預ける。これまで localStorage にしか無かったので、
      //    端末やブラウザを変えると解放だけ引き継がれて★が全部 ☆☆☆ に
      //    戻っていた（プレイヤーには「記録が下がった」としか見えない）。
      duration: secs, won, stage: this.stage, stars,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const starStr = won ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '';
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : 'lose'}">${won ? `${t('遺跡クリア！', 'ROOM CLEARED!')} ${starStr}` : `${ic('close', 24)} ${t('失敗…', 'FAILED…')}`}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('ステージ', 'Stage')}</span><b>${this.stage}</b></div>
        <div class="rs-row"><span>${t('タイム', 'Time')}</span><b>${secs.toFixed(1)}s</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t('残りブロック', 'Blocks left')}</span><b>${this.targets.size}</b></div>`}
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${won ? t('次のステージ', 'Next stage') : t('リトライ', 'Retry')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      this.destroy();
      startPuzzle(won ? this.stage + 1 : this.stage);
    };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    $('#hudTimer').classList.add('hidden');
    if (view) { view.onIntentPlace = null; view.glowCells = null; }
  }
}

export function startPuzzle(stage = 1) {
  if (currentMode) currentMode.destroy();
  currentMode = new PuzzleMode(stage);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// ⛏️ 採掘場 (v2.6) — the ground rises. Every few placements the whole board
// shifts up one row and a fresh rock layer (with ore) slides in at the bottom.
// Clear lines through the rock to collect 🪙金鉱石 / 💠クリスタル / 🌈虹鉱石
// for score. Anything touching the ceiling when the ground moves = crushed.
// ---------------------------------------------------------------------------

// 鉱石の3種。icon（絵文字）はやめて iconName（icons.js）と名前に分けた:
//   ・HUD・結果の内訳は innerHTML なので iconName を SVG で出せる
//   ・盤面に浮かぶ数字（addFloatText）は **canvas** なので SVG を置けない。
//     そこは名前（言葉）を出す。盤面の粒自体は
//     public/js/game.js の drawOreMark() が形（丸/菱/弧）で描き分けている。
const DIG_ORES = {
  gold:    { iconName: 'ore_gold',    ja: '金',       en: 'Gold',    tint: '#ffd75e', base: 150 },
  crystal: { iconName: 'ore_crystal', ja: 'クリスタル', en: 'Crystal', tint: '#4dd0ff', base: 400 },
  rainbow: { iconName: 'ore_rainbow', ja: '虹',       en: 'Rainbow', tint: '#ff6bd4', base: 1200 },
};
const DIG_STEP = 4;   // placements per layer rise

class DigMode {
  constructor() {
    this.mode = 'dig';
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.remove('hidden');   // 地層の上昇ゲージとして流用
    showItemBar(false);
    this.startedAt = Date.now();
    this.ended = false;
    this.depth = 0;
    this.placedSince = 0;
    this.ores = new Map();
    this.mined = { gold: 0, crystal: 0, rainbow: 0 };
    this.rng = new Rng((Math.random() * 2 ** 31) | 0);
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.oreCells = this.ores;
    v.inputLocked = false;
    v.onIntentPlace = null;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.initStrata();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('mine');
    toast(t('地層がせり上がる！ラインを消して鉱石を回収しろ！天井に触れたら終わり！',
      'The ground is rising! Clear lines to mine ore — touch the ceiling and it\'s over!'), 'announce', 3400);
  }

  oreValue(type) {
    return Math.round(DIG_ORES[type].base * (1 + this.depth / 25));
  }

  // Fill one row with rock + ore rolls. Used for the starting strata (rows
  // 5-7) and for every fresh stratum entering at the bottom.
  fillLayerRow(row, density) {
    const e = this.engine;
    const v = getView();
    const cols = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = cols.length - 1; i > 0; i--) { const k = this.rng.int(i + 1); [cols[i], cols[k]] = [cols[k], cols[i]]; }
    for (let c = 0; c < 8; c++) { e.grid[row * 8 + c] = 0; this.ores.delete(row * 8 + c); }
    for (const c of cols.slice(0, density)) {
      const k = row * 8 + c;
      e.grid[k] = 9;
      const roll = this.rng.next();
      const crystalP = 0.05 + Math.min(0.06, this.depth * 0.0015);
      if (roll < 0.012) this.ores.set(k, 'rainbow');
      else if (roll < 0.012 + crystalP) this.ores.set(k, 'crystal');
      else if (roll < 0.012 + crystalP + 0.13) this.ores.set(k, 'gold');
      v.spawnAnim.set(k, v.time);
    }
  }

  layerDensity() {
    return Math.min(7, 5 + (this.depth >= 15 ? 1 : 0) + (this.depth >= 40 ? 1 : 0));
  }

  // Three starting strata, loosest on top — the mine face you dig into.
  initStrata() {
    this.fillLayerRow(5, 3);
    this.fillLayerRow(6, 4);
    this.fillLayerRow(7, 5);
  }

  // The ground rises: rows shift up one, a fresh stratum enters at the bottom.
  pushLayer() {
    const e = this.engine;
    for (let c = 0; c < 8; c++) {
      if (e.grid[c] !== 0) { this.crushed(); return; }   // top row occupied = crushed
    }
    e.grid.copyWithin(0, 8);
    const shifted = new Map();
    for (const [k, type] of this.ores) if (k >= 8) shifted.set(k - 8, type);
    this.ores.clear();
    for (const [k, type] of shifted) this.ores.set(k, type);
    this.fillLayerRow(7, this.layerDensity());
    this.depth++;
    const v = getView();
    v.shake = Math.max(v.shake, 6);
    audio.countdown(false);
    if (this.depth % 10 === 0) {
      toast(t(`深度${this.depth}m 到達！鉱石が濃くなってきた…`, `Depth ${this.depth}m! The veins are getting richer…`), 'announce', 2200);
      confettiBurst(20);
    }
    // 新しい地層は grid の直書き（copyWithin + fillLayerRow）なので、engine が
    // ラインを見てくれない。行が満杯になることは無い（density は最大7）が、
    // 列は埋まりきる ── 上7段が埋まっている列の一番下に岩が入った瞬間が
    // それで、消えないまま残ると (1) 次に置いた1手がその列消しの加点と
    // コンボを横取りし、(2) 消えれば続けられる盤面で hasAnyMove() が false に
    // なって不当に潰される。鉱石は onPlace と同じ collectOre() で回収するので
    // this.ores との整合も崩れない（消すだけだと鉱石が黙って消滅する）。
    this.collectOre(e.resolveLines().clearedCells);
    if (!e.hasAnyMove()) { e.over = true; handleEngineOver(); }
  }

  // 消えたマスに埋まっていた鉱石を回収して加点する。ラインを消したのが
  // プレイヤーの1手でも、せり上がりでたまたま揃った列でも扱いは同じ。
  collectOre(clearedCells) {
    const e = this.engine;
    const v = getView();
    let bonus = 0;
    for (const [r, c] of clearedCells) {
      const k = r * 8 + c;
      const type = this.ores.get(k);
      if (!type) continue;
      this.ores.delete(k);
      this.mined[type]++;
      const val = this.oreValue(type);
      bonus += val;
      v.addFloatText(v.boardX + (c + 0.5) * v.cell, v.boardY + (r + 0.5) * v.cell,
        `${t(DIG_ORES[type].ja, DIG_ORES[type].en)} +${fmt(val)}`, DIG_ORES[type].tint, type === 'rainbow' ? 1.8 : 1.3);
    }
    if (bonus) {
      e.score += bonus;
      audio.coin();
    }
    // Items/ults may wipe cells without a "clear" — drop orphaned ore markers.
    for (const k of [...this.ores.keys()]) if (e.grid[k] === 0) this.ores.delete(k);
    return bonus;
  }

  crushed() {
    if (this.ended) return;
    const v = getView();
    v.shake = 20;
    v.screenFlash = 0.5;
    audio.bossAttack();
    toast(t('天井に押しつぶされた…', 'Crushed against the ceiling…'), 'err', 2400);
    this.finish();
  }

  onPlace(result) {
    if (this.ended) return;
    // Collect ore that was inside the cleared lines.
    this.collectOre(result.clearedCells);
    // Cadence: each placement pushes toward the next rise; clears buy time.
    this.placedSince += 1 - Math.min(1, result.lineCount);
    if (this.placedSince >= DIG_STEP) {
      this.placedSince = 0;
      clearTimeout(this.riseTimer);
      this.riseTimer = setTimeout(() => { if (!this.ended) { this.pushLayer(); this.updateHud(); } }, 260);
    }
    this.updateHud();
  }

  best() {
    const local = Number(localStorage.getItem('bba_dig_best') || 0);
    return session.user ? Math.max(local, session.user.stats.digDepth || 0) : local;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    bumpScore(el);
    // BEST は深度が単位。走行中に自己ベストを追い越したら一緒に伸ばす。
    // HUD は textContent なので SVG を置けない ── 鉱石の種類は言葉で出す。
    $('#hudSub').textContent = t(
      `金${this.mined.gold} クリ${this.mined.crystal} 虹${this.mined.rainbow} ・ BEST ${Math.max(this.best(), this.depth)}m`,
      `Gold ${this.mined.gold} Cry ${this.mined.crystal} Rbw ${this.mined.rainbow} ・ BEST ${Math.max(this.best(), this.depth)}m`);
    $('#hudTimer').innerHTML = `${ic('mode_dig', 15)} ${this.depth}m`;
    const fill = $('#chaosBarFill');
    const pct = Math.round((this.placedSince / DIG_STEP) * 100);
    fill.style.width = `${pct}%`;
    fill.style.background = pct >= 75 ? '#ff9d3b' : '#a7793b';
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.riseTimer);
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_dig_best') || 0);
    const isBest = this.depth > 0 && this.depth >= Math.max(localBest, this.best());
    if (this.depth > localBest) localStorage.setItem('bba_dig_best', String(this.depth));
    const rewards = await submitResult({
      mode: 'dig', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      duration: (Date.now() - this.startedAt) / 1000, won: false, depth: this.depth,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${ic('mode_dig')} ${t('到達深度', 'Depth reached')}</span><b>${this.depth}m</b></div>
        <div class="rs-row"><span>${ic('ore_gold')} ${t('金鉱石', 'Gold ore')}</span><b>${this.mined.gold}</b></div>
        <div class="rs-row"><span>${ic('ore_crystal')} ${t('クリスタル', 'Crystal')}</span><b>${this.mined.crystal}</b></div>
        ${this.mined.rainbow ? `<div class="rs-row"><span>${ic('ore_rainbow')} ${t('虹鉱石', 'Rainbow ore')}</span><b>${this.mined.rainbow}</b></div>` : ''}
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  destroy() {
    this.ended = true;
    clearTimeout(this.riseTimer);
    const timer = $('#hudTimer');
    timer.classList.add('hidden');
    $('#chaosBar').classList.add('hidden');
    const fill = $('#chaosBarFill');
    fill.style.background = '';
    fill.style.width = '0%';
    if (view) { view.onPlace = null; view.oreCells = null; }
  }
}

export function startDig() {
  if (currentMode) currentMode.destroy();
  currentMode = new DigMode();
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 初回ガイド（I17）。ソロ以外を最初に押した人にも同じ説明が届くように、
  // ふつうの盤面の1人用モードからも呼ぶ（すでに見た人には中で何もしない）。
  maybeStartTutorial(currentMode);
}

// ---------------------------------------------------------------------------
// 👻 幽霊屋敷 (HIDDEN — メニューのロゴを13回タップで解放)
// 置いたブロックは約1.2秒で透明になる記憶力スコアアタック。ライン消しの
// 瞬間だけ盤面全体が姿を現す。ドラッグ中の設置プレビュー(置けない場所は
// 置けない)が唯一の手がかり。
// ---------------------------------------------------------------------------

export function ghostUnlocked() {
  return localStorage.getItem('bba_ghost') === '1' || (session.user && session.user.role === 'admin');
}

class GhostMode {
  constructor() {
    this.mode = 'ghost';
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    showItemBar(false);   // 記憶力の純粋勝負 — アイテム/奥義なし
    this.startedAt = Date.now();
    this.ended = false;
    this.ghostFx = { hideAt: new Map(), revealUntil: 0 };
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.ghostFx = this.ghostFx;
    v.inputLocked = false;
    v.onIntentPlace = null;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('ghost');
    toast(t('置いたブロックは消えていく…記憶だけが頼り。ラインを消せば一瞬だけ見える！',
      'Placed blocks fade away… memory is all you have. Clears reveal the board for a moment!'), 'announce', 3600);
  }

  onPlace(result) {
    if (this.ended) return;
    const v = getView();
    for (const [r, c] of result.placedCells) this.ghostFx.hideAt.set(r * 8 + c, v.time + 1.2);
    if (result.lineCount) {
      for (const [r, c] of result.clearedCells) this.ghostFx.hideAt.delete(r * 8 + c);
      this.ghostFx.revealUntil = v.time + 0.8;   // 全盤面リビール
    }
    // 神モードの盤面リセット等でグリッドが空いたセルの残骸を掃除
    for (const k of [...this.ghostFx.hideAt.keys()]) if (this.engine.grid[k] === 0) this.ghostFx.hideAt.delete(k);
    this.updateHud();
  }

  best() {
    const local = Number(localStorage.getItem('bba_ghost_best') || 0);
    return session.user ? Math.max(local, session.user.stats.ghostBest || 0) : local;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    // 走行中に自己ベストを追い越したら BEST も一緒に伸ばす（ソロと同じ扱い）。
    const b = fmt(Math.max(this.best(), this.engine.score));
    $('#hudSub').innerHTML = ic('mode_ghost', 13) + ' ' + t(`見えないブロック ${this.ghostFx.hideAt.size}個 ・ BEST ${b}`,
      `${this.ghostFx.hideAt.size} hidden blocks — BEST ${b}`);
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const localBest = Number(localStorage.getItem('bba_ghost_best') || 0);
    const isBest = e.score > 0 && e.score >= Math.max(localBest, this.best());
    if (e.score > localBest) localStorage.setItem('bba_ghost_best', String(e.score));
    const rewards = await submitResult({
      mode: 'ghost', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : `${ic('mode_ghost', 26)} ${t('屋敷に呑まれた…', 'The house claims you…')}`}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  destroy() {
    this.ended = true;
    if (view) { view.onPlace = null; view.ghostFx = null; }
  }
}

export function startGhost() {
  if (currentMode) currentMode.destroy();
  currentMode = new GhostMode();
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Timed versus base (shared by AI battles and online battles)
// ---------------------------------------------------------------------------

class VersusBase {
  setupHud(duration) {
    showScreen('game');
    $('#oppPanel').classList.remove('hidden');
    $('#hudTimer').classList.remove('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#teamTotals').classList.add('hidden');
    this.timeLeft = duration;
    this.updateTimerHud();
    this.scores = {};       // slot -> latest score of others
    this.miniBoards = {};   // slot -> MiniBoard
    // ⚠ 盤面の控えも一緒に捨てること。ここだけ残していたので、再戦と
    //   トーナメントの次ラウンド（どちらも destroy() を通らず同じ
    //   OnlineMode を使い続ける）で、相手パネルに **前の試合＝前の相手の盤面**
    //   がそのまま出ていた。最初の zero_state / opp_state が届くまでの数秒、
    //   別人の盤面を「いまの相手」として見せることになる。
    this.lastGrids = {};    // slot -> 直近に届いた盤面（届くまでの見た目に使う）
    this.updateBars(0, 0);
  }

  // others: [{ slot, name, isAlly }]
  //
  // With 2+ other players (raid, 2v2) the mini-board cards cost ~116px of
  // height each and squeezed the player's OWN board down to 210px on a
  // 375x667 phone. Those crowds default to the one-row strip; the ⤢ button
  // brings the boards back and the choice is remembered.
  buildPanels(others) {
    const cards = $('#oppCards');
    this.clearComboTimers();
    cards.innerHTML = '';
    this.oppList = others.slice();
    // Your own side first: in 2v2 the partner used to render between the two
    // opponents, which reads as "the middle one is an enemy".
    this.oppList.sort((a, b) => (b.isAlly ? 1 : 0) - (a.isAlly ? 1 : 0));
    cards.classList.toggle('compact', this.oppList.length > 1);
    for (const o of this.oppList) {
      const card = document.createElement('div');
      card.className = `opp-card ${o.isAlly ? 'ally' : ''}`;
      card.dataset.slot = o.slot;
      card.innerHTML = `
        <canvas></canvas>
        <div class="opp-name" data-who="${escapeHtml(o.name)}">${o.isAlly ? ic('mode_coop', 13) + ' ' : ''}${escapeHtml(o.name)}</div>
        <div class="opp-score" data-slot-score="${o.slot}">0</div>
        <div class="opp-combo" data-slot-combo="${o.slot}"></div>`;
      cards.appendChild(card);
      this.scores[o.slot] = 0;
    }
    // 👤 相手の名前をタップするとプロフィールが開く（＝そこからフレンドに誘える）。
    //    ロビーのチャットでは前から名前をタップできたのに、**対戦カードだけ
    //    できなかった** ── いま戦っている相手こそ、いちばん誘いたい人なのに。
    for (const el of cards.querySelectorAll('.opp-name[data-who]')) {
      el.style.cursor = 'pointer';
      el.onclick = (ev) => { ev.stopPropagation(); showProfileCard(el.dataset.who); };
    }
    // 1対1 も設定どおりに扱う。以前は相手が1人だと強制的に cards になり、
    // しかも ⤢ ボタンも隠れていたので、いちばん人が遊ぶ 1対1 だけが
    // 全モード中いちばん盤面の小さいモードで、直す手段も無かった。
    // ただし README は「1v1で相手の盤面をライブ表示」を謳うので、明示的な
    // 設定が無い 1対1 の初期値は cards（相手盤を表示）にする。⤢ボタンで strip に
    // 切り替えられる点は従来どおり。crowd（味方入り/複数）は従来どおり strip 既定。
    const storedDensity = localStorage.getItem(OPP_DENSITY_KEY);
    const is1v1 = this.oppList.length === 1 && !this.oppList[0].isAlly;
    const initialDensity = storedDensity === 'cards' ? 'cards'
      : storedDensity === 'strip' ? 'strip'
      : (is1v1 ? 'cards' : 'strip');
    this.applyOppDensity(initialDensity);
    const btn = $('#btnOppDensity');
    btn.classList.remove('hidden');
    btn.onclick = () => {
      audio.click();
      const next = this.density === 'strip' ? 'cards' : 'strip';
      setOppDensity(next);
      this.applyOppDensity(next);
      getView().resize();
    };
  }

  // Mini boards only exist in card mode — in strip mode they are neither
  // rendered nor allocated, so the ~1/s relay redraw disappears too.
  applyOppDensity(density) {
    this.density = density;
    const cards = $('#oppCards');
    cards.classList.toggle('strip', density === 'strip');
    const btn = $('#btnOppDensity');
    if (btn) {
      btn.textContent = density === 'strip' ? '⤢' : '▾';
      btn.title = density === 'strip'
        ? t('仲間の盤面を表示', 'Show ally boards')
        : t('コンパクト表示にする', 'Switch to compact');
    }
    for (const o of (this.oppList || [])) {
      const canvas = cards.querySelector(`.opp-card[data-slot="${o.slot}"] canvas`);
      if (!canvas) continue;
      if (density === 'strip') {
        delete this.miniBoards[o.slot];
      } else if (!this.miniBoards[o.slot]) {
        this.miniBoards[o.slot] = new MiniBoard(canvas);
        this.miniBoards[o.slot].setGrid(this.lastGrids && this.lastGrids[o.slot] ? this.lastGrids[o.slot] : new Array(64).fill(0));
      }
    }
  }

  updateOpp(slot, state) {
    this.scores[slot] = state.score || 0;
    const sc = document.querySelector(`[data-slot-score="${slot}"]`);
    if (sc) sc.textContent = fmt(state.score || 0);
    if (state.combo >= 2) {
      const cb = document.querySelector(`[data-slot-combo="${slot}"]`);
      if (cb) {
        // 文字を空にするのではなく見せ消しにする。空文字にすると行ボックスの
        // 高さが 14px→12px と動き、その2pxで盤面のキャンバスが作り直されて
        // 1フレーム真っ白になっていた（AI対戦のチカチカの主犯）。
        cb.textContent = `${state.combo} COMBO!`;
        cb.style.visibility = 'visible';
        // タイマーはスロットに1本だけ。使い捨てにしていたころは、AIの手番
        // （鬼700ms・創造神380ms）が消去の1200msより短いせいで、前の手の
        // タイマーが新しいコンボを消してしまい表示がストロボしていた。
        this.comboTimers = this.comboTimers || {};
        clearTimeout(this.comboTimers[slot]);
        this.comboTimers[slot] = setTimeout(() => { cb.style.visibility = 'hidden'; }, 1200);
      }
    }
    // Kept even while the strip hides the boards, so ⤢ can show the CURRENT
    // board instead of an empty grid that fills in a second later.
    if (state.grid) {
      this.lastGrids = this.lastGrids || {};
      this.lastGrids[slot] = state.grid;
      if (this.miniBoards[slot]) this.miniBoards[slot].setGrid(state.grid);
    }
  }

  updateTimerHud() {
    const t = Math.max(0, Math.ceil(this.timeLeft));
    const mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
    const el = $('#hudTimer');
    el.textContent = `${mm}:${ss}`;
    el.classList.toggle('urgent', t <= 10);
  }

  startTimer(onEnd) {
    // Wall-clock based: stays accurate even when background tabs throttle timers.
    if (this.timerInt) clearInterval(this.timerInt);
    this.endAt = Date.now() + this.timeLeft * 1000;
    this.timerInt = setInterval(() => {
      this.timeLeft = Math.max(0, (this.endAt - Date.now()) / 1000);
      this.updateTimerHud();
      if (this.timeLeft <= 0) {
        clearInterval(this.timerInt);
        this.timerInt = null;
        onEnd();
      }
    }, 250);
  }

  stopTimer() {
    if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; }
    this.clearComboTimers();
  }

  // 試合が終わったあとに残ったコンボ消去タイマーは、次の試合のコンボを
  // 消しに来る（同じ [data-slot-combo] を掴んでいるため）。始めるときと
  // 終わるときの両方で必ず捨てる。
  clearComboTimers() {
    for (const id of Object.values(this.comboTimers || {})) clearTimeout(id);
    this.comboTimers = {};
  }

  updateBars(me, opp) {
    const total = me + opp;
    const pct = total === 0 ? 50 : Math.round((me / total) * 100);
    $('#vsBarMe').style.width = `${pct}%`;
  }

  updateMyHud(engine) {
    const el = $('#hudScore');
    el.textContent = fmt(engine.score);
    applyScoreFit(el, fmt(engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = engine.streak >= 2 ? `${engine.streak} COMBO` : 'SCORE';
  }
}

// ---------------------------------------------------------------------------
// VS AI
// ---------------------------------------------------------------------------

// Per-difficulty stage presentation: board theme + music track.
const DIFF_THEME = {
  easy:   { board: 'board_forest',  track: 'solo' },
  normal: { board: 'board_default', track: 'battle' },
  hard:   { board: 'board_sunset',  track: 'hard' },
  oni:    { board: 'board_oni',     track: 'oni' },
  kami:   { board: 'board_kami',    track: 'kami' },
  souzou: { board: 'board_galaxy',  track: 'kami' },
};

class AiMode extends VersusBase {
  constructor(level) {
    super();
    this.mode = 'ai';
    this.level = level;
    this.cfg = AI_LEVELS[level];
  }

  // 名前は対戦パネルに textContent で入るので絵は入れられない。言葉だけにする。
  aiLabel() { return `AI (${t(this.cfg.name, this.cfg.nameEn)})`; }

  start() {
    const seed = (Math.random() * 2 ** 31) | 0;
    this.setupHud(MATCH_SECONDS);
    showItemBar(false);   // fair fight: same pieces, no boosters
    this.buildPanels([{ slot: 1, name: this.aiLabel(), isAlly: false }]);
    this.startedAt = Date.now();
    const v = getView();
    const stage = DIFF_THEME[this.level] || DIFF_THEME.normal;
    setModeTheme({ ...equippedTheme(), boardId: stage.board });
    this.engine = new Engine(seed);
    this.aiEngine = new Engine(seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(stage.track);

    const begin = () => countdownOverlay(3, afterCountdown(this, () => {
      v.inputLocked = false;
      this.startTimer(() => this.finish());
      this.aiLoop();
    }), audio);

    if (this.level === 'oni') this.oniIntro(begin);
    else if (this.level === 'kami') this.kamiIntro(begin);
    else if (this.level === 'souzou') this.souzouIntro(begin);
    else begin();
  }

  // Cosmic entrance for the TRUE hidden difficulty.
  souzouIntro(next) {
    const el = document.createElement('div');
    el.className = 'kami-intro souzou';
    el.innerHTML = `
      <div class="kami-rays"></div>
      <div class="kami-face">${ic('badge_souzou', 110)}</div>
      <div class="kami-text">${t('創造神が 目覚めた————', 'The Creator God has awakened————')}</div>`;
    document.body.appendChild(el);
    audio.kamiDescend();
    audio.bossAttack();
    if (view) view.shake = 16;
    // タイマーを持っておく。保持していなかったころは、演出中に中断しても
    // 1.9〜2.6秒後に begin() が走って新しいカウントダウンを作り直し、
    // 終わったはずの画面の上に 3-2-1 が音付きで出ていた。
    this.introTimer = setTimeout(() => { el.remove(); next(); }, 2600);
  }

  // Dramatic entrance for the hidden difficulty.
  oniIntro(next) {
    const el = document.createElement('div');
    el.className = 'oni-intro';
    el.innerHTML = `<div class="oni-face">${ic('badge_oni', 110)}</div><div class="oni-text">${t('おにが あらわれた！', 'The Oni appears!')}</div>`;
    document.body.appendChild(el);
    audio.gameOver();
    if (view) view.shake = 14;
    this.introTimer = setTimeout(() => { el.remove(); next(); }, 1900);
  }

  // Divine entrance for the ultimate hidden difficulty.
  kamiIntro(next) {
    const el = document.createElement('div');
    el.className = 'kami-intro';
    el.innerHTML = `
      <div class="kami-rays"></div>
      <div class="kami-face">${ic('badge_kami', 110)}</div>
      <div class="kami-text">${t('神が 降臨した——', 'A God descends——')}</div>`;
    document.body.appendChild(el);
    audio.kamiDescend();
    if (view) view.shake = 8;
    this.introTimer = setTimeout(() => { el.remove(); next(); }, 2300);
  }

  aiLoop() {
    const jitter = 0.75 + Math.random() * 0.5;
    this.aiTimer = setTimeout(() => {
      if (this.ended) return;
      if (this.aiEngine.over) this.aiEngine.reviveBoard();
      const move = chooseMove(this.aiEngine, this.level);
      let combo = 0;
      if (move) {
        const r = this.aiEngine.place(move.index, move.row, move.col);
        if (r && r.lineCount > 0) combo = r.streak;
      }
      this.updateOpp(1, {
        score: this.aiEngine.score, combo,
        grid: this.aiEngine.snapshot(),
      });
      this.updateBars(this.engine.score, this.aiEngine.score);
      this.aiLoop();
    }, this.cfg.moveMs * jitter);
  }

  onPlace() {
    this.updateMyHud(this.engine);
    this.updateBars(this.engine.score, this.aiEngine.score);
  }

  onTopOut() {
    if (this.ended) return;
    toast(t('ボードリセット！スコアは維持されます', 'Board reset! Your score is kept'), '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    clearTimeout(this.aiTimer);
    // 入場演出／3-2-1 の途中で中断されたときの後始末。ここで消さないと、
    // 結果モーダルの裏で全画面のカウントダウンが動き続ける。
    clearTimeout(this.introTimer);
    clearIntroOverlays();
    getView().inputLocked = true;
    const me = this.engine.score, opp = this.aiEngine.score;
    // Quitting early is ALWAYS a draw — never counted as a defeat.
    const outcome = this.aborted ? 'draw' : me > opp ? 'win' : me < opp ? 'lose' : 'draw';
    if (!this.aborted) {
      if (outcome === 'win') { audio.victory(); confettiBurst(); } else audio.gameOver();
    }

    const modeName = { oni: 'ai_oni', kami: 'ai_kami', souzou: 'ai_souzou' }[this.level] || 'ai';
    const rewards = await submitResult({
      mode: modeName, score: me, lines: this.engine.linesCleared,
      // 途中終了でも実経過時間を送る（120秒固定だとプレイ時間統計が水増しされる）。
      // フルマッチでも上限は MATCH_SECONDS なのでそこで頭打ちにする。
      maxCombo: this.engine.maxCombo,
      duration: Math.min(MATCH_SECONDS, (Date.now() - this.startedAt) / 1000), won: outcome === 'win',
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (rewards && rewards.badge === 'oni') {
      setTimeout(() => toast(t('バッジ「おに退治」を獲得！', 'Badge earned: Oni Slayer!'), 'announce', 4000), 1200);
    }
    if (rewards && rewards.badge === 'kami') {
      setTimeout(() => toast(t('バッジ「神殺し」を獲得！！', 'Badge earned: God Slayer!!'), 'announce', 5000), 1200);
    }
    if (rewards && rewards.badge === 'souzou') {
      setTimeout(() => { toast(t('バッジ「創造を超えし者」を獲得！！！', 'Badge earned: Beyond Creation!!!'), 'announce', 6000); confettiBurst(80); }, 1200);
    }

    const banners = { win: 'YOU WIN!', lose: 'YOU LOSE…', draw: this.aborted ? t('引き分け（中断）', 'Draw (aborted)') : 'DRAW' };
    const m = showModal(`
      <div class="result-banner ${outcome}">${banners[outcome]}</div>
      ${this.aborted ? `<p class="muted center">${t('途中終了は引き分け扱いです。敗北にはなりません', 'Quitting early counts as a draw, not a loss')}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('あなた', 'You')}</span><b>${fmt(me)}</b></div>
        <div class="rs-row"><span>${this.aiLabel()}</span><b>${fmt(opp)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('再戦', 'Rematch')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startVsAi(this.level); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.aborted = true;
    this.finish();
  }

  destroy() {
    this.ended = true;
    this.stopTimer();
    clearTimeout(this.aiTimer);
    clearTimeout(this.introTimer);
    clearIntroOverlays();
  }
}

// ---------------------------------------------------------------------------
// Boss battles (PvE): deal damage with points, survive the boss's attacks.
// ---------------------------------------------------------------------------

const BOSS_STAGE = {
  slime:  { board: 'board_forest', track: 'battle' },
  golem:  { board: 'board_ocean',  track: 'boss' },
  dragon: { board: 'board_sunset', track: 'boss' },
  maou:   { board: 'board_oni',    track: 'oni' },
  mecha:  { board: 'board_cyber',  track: 'pixel' },
  frost:  { board: 'board_snow',   track: 'kami' },
};

// ---------------------------------------------------------------------------
// ボス共通戦闘システム — 技テーブル・予告&カット・フェーズ制。
// BossMode（単体戦）と BossRushMode（無限地獄）が共有する。
// 予告技は着弾マスが赤く点滅し、そのマスを通るラインを消すと『カット』：
// 攻撃キャンセル＋反撃ダメージ＋奥義ゲージ加速。
// ---------------------------------------------------------------------------

const TELEGRAPH_MS = 4200;

const BOSS_MOVES = {
  garbage:     { name: 'お邪魔弾',       nameEn: 'Garbage Shot',   telegraph: true },
  breath_row:  { name: '火炎ブレス',     nameEn: 'Flame Breath',   telegraph: true },
  laser_col:   { name: '縦断レーザー',   nameEn: 'Piercing Laser', telegraph: true },
  laser_col2:  { name: 'ダブルレーザー', nameEn: 'Twin Lasers',    telegraph: true },
  quake:       { name: '大地震',         nameEn: 'Quake',          telegraph: false },
  curse_hand:  { name: '呪縛',           nameEn: 'Hand Curse',     telegraph: false },
  curse_hand2: { name: '二重呪縛',       nameEn: 'Double Curse',   telegraph: false },
  // 🧊 ボス専用技（server/catalog.js の BOSS_TECHNIQUES）。名前と文言は
  // m.boss.techs.freeze から引くが、技を持たないボスに freeze が回ってきても
  // 落ちないよう既定値をここにも持たせておく。
  freeze:      { name: '絶対零度',       nameEn: 'Absolute Zero',  telegraph: true, ice: true },
};

// そのボスが持っている専用技の定義。持っていなければ null。
// 参照の形は仕様書どおり（m.boss.techs は frost 以外 undefined）。
function bossTech(m, moveId) {
  const techs = m && m.boss && m.boss.techs;
  return (techs && techs[moveId]) || null;
}

function bossAtkMs(m) {
  return m.boss.atkSec * 1000 * (m.phase2 ? (m.boss.atk2 || 0.75) : 1);
}

function bossTelegraphMs(m) {
  return m.phase2 ? TELEGRAPH_MS * 0.8 : TELEGRAPH_MS;
}

// Target cells for a telegraphed move (empty cells only — filling a target
// yourself also defuses that cell).
function bossMoveCells(m, moveId) {
  const e = m.engine;
  const empty = [];
  for (let i = 0; i < 64; i++) if (!e.grid[i]) empty.push(i);
  if (moveId === 'breath_row') {
    const r = (Math.random() * 8) | 0;
    return empty.filter(k => ((k / 8) | 0) === r);
  }
  if (moveId === 'laser_col' || moveId === 'laser_col2') {
    const n = moveId === 'laser_col2' ? 2 : 1;
    const cols = [...Array(8).keys()];
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(cols.splice((Math.random() * cols.length) | 0, 1)[0]);
    return empty.filter(k => picked.includes(k % 8));
  }
  // 🧊 絶対零度: 空きマスから tech.cells（第二形態は cells2）個を抽選。
  // お邪魔弾と同じ「ばらまき」だが、数はボスの atkCells ではなく技の定義。
  if (moveId === 'freeze') {
    const tech = bossTech(m, 'freeze');
    const want = Math.max(1, (m.phase2 ? (tech && tech.cells2) : (tech && tech.cells)) || 5);
    const out = [];
    for (let i = 0; i < want && empty.length; i++) out.push(empty.splice((Math.random() * empty.length) | 0, 1)[0]);
    return out;
  }
  const n = Math.max(1, m.boss.atkCells + (m.atkCellsDelta || 0));
  const out = [];
  for (let i = 0; i < n && empty.length; i++) out.push(empty.splice((Math.random() * empty.length) | 0, 1)[0]);
  return out;
}

function bossBeginMove(m) {
  if (m.ended || !m.engine || view.inputLocked || m.relicOpen || m.pendingAtk) return;
  const list = (m.phase2 && m.boss.moves2) || m.boss.moves || ['garbage'];
  const moveId = list[(Math.random() * list.length) | 0];
  const def = BOSS_MOVES[moveId] || BOSS_MOVES.garbage;
  if (!def.telegraph) {
    bossInstantMove(m, moveId);
    m.nextAtk = Date.now() + bossAtkMs(m);
    return;
  }
  const cells = bossMoveCells(m, moveId);
  if (!cells.length) { m.nextAtk = Date.now() + bossAtkMs(m); return; }
  m.pendingAtk = { cells, moveId };
  m.nextAtk = Date.now() + bossTelegraphMs(m);
  view.dangerCells = new Set(cells);
  audio.countdown(false);
  // 専用技は自前の予告文言を持っている（絵文字は文言側に含まれるので、
  // 呼び出し側で付けるのはボスの顔だけ ── 仕様書の取り決めどおり）。
  const tech = bossTech(m, moveId);
  if (tech && tech.telegraphMsg) {
    toast(t(tech.telegraphMsg, tech.telegraphMsgEn || tech.telegraphMsg), 'err', 1700);
  } else {
    toast(t(`${def.name}の予告！赤マスをラインで切れ！`, `${def.nameEn} incoming! Cut the red cells with a line!`), 'err', 1700);
  }
}

function bossInstantMove(m, moveId) {
  const e = m.engine;
  // 絶対防御/フォートレスは予告技と同様に即時技も完全無効化する。
  if (e.fortressActive && e.fortressActive()) {
    toast(t('絶対防御が攻撃を無効化！', 'Absolute Guard nullified the attack!'), 'ok', 1500);
    m.afterAttack();
    return;
  }
  audio.bossAttack();
  const em = $('#bossEmoji');
  em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
  if (moveId === 'quake') {
    // 全列が下へ崩落（カオスの重力と同じ）＋お邪魔2個
    for (let c = 0; c < 8; c++) {
      const col = [];
      for (let r = 0; r < 8; r++) { const cv = e.grid[r * 8 + c]; if (cv) col.push(cv); }
      for (let r = 0; r < 8; r++) {
        const k = r * 8 + c;
        const nv = r < 8 - col.length ? 0 : col[r - (8 - col.length)];
        if (e.grid[k] !== nv) { e.grid[k] = nv; if (nv) view.spawnAnim.set(k, view.time); }
      }
    }
    const cells = e.addGarbage(2);
    m.garbageTaken = (m.garbageTaken || 0) + cells.length;
    view.shake = 14;
    toast(t('大地震！ブロックが崩落！', 'Quake! The board collapses!'), 'err', 1500);
  } else if (moveId === 'curse_hand' || moveId === 'curse_hand2') {
    const n = moveId === 'curse_hand2' ? 2 : 1;
    const idxs = e.hand.map((p, i) => (p ? i : -1)).filter(i => i >= 0);
    let frozen = 0;
    // 最低1枠は自由に残す — 完全ロックは理不尽
    for (let i = 0; i < n && idxs.length > 1; i++) {
      const slot = idxs.splice((Math.random() * idxs.length) | 0, 1)[0];
      e.hand[slot].frozenUntil = Date.now() + 8000;
      frozen++;
    }
    if (frozen) {
      view.screenFlash = 0.25;
      toast(t(`呪縛！ピース${frozen}個が凍結（8秒）`, `Curse! ${frozen} piece(s) frozen (8s)`), 'err', 1800);
    }
  }
  m.afterAttack();
}

function bossImpact(m) {
  const e = m.engine;
  const pa = m.pendingAtk;
  m.pendingAtk = null;
  view.dangerCells = null;
  // 予告時間ぶんを次の攻撃間隔から差し引く — 予告の追加で実質の攻撃頻度が
  // 旧仕様より下がらないように。
  m.nextAtk = Date.now() + Math.max(2500, bossAtkMs(m) - bossTelegraphMs(m));
  if (e.fortressActive && e.fortressActive()) {
    toast(t('絶対防御が攻撃を無効化！', 'Absolute Guard nullified the attack!'), 'ok', 1500);
    return;
  }
  // 🧊 絶対零度だけは、お邪魔(9)ではなく氷結ブロックを書き込む。
  // iceHp は engine の2段階（ICE → ICE_CRACKED → 消滅）にそのまま対応する:
  //   iceHp>=2 → ICE(10) を置く（ライン2回で割れる）
  //   iceHp<=1 → ICE_CRACKED(11) を置く（ライン1回で消える＝通常ブロック相当）
  // catalog の cellValue（シアン5）は、氷が engine/描画に無かった頃の
  // 代替色なので使わない ── 10/11 は game.js の boardSkin が氷として描く。
  const tech = bossTech(m, pa.moveId);
  const isFreeze = pa.moveId === 'freeze';
  const fill = isFreeze ? ((tech && tech.iceHp <= 1) ? ICE_CRACKED : ICE) : 9;
  const landed = [];
  for (const k of pa.cells) {
    if (!e.grid[k]) { e.grid[k] = fill; landed.push(k); }
  }
  m.garbageTaken = (m.garbageTaken || 0) + landed.length;
  audio.bossAttack();
  const em = $('#bossEmoji');
  em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
  for (const k of landed) {
    const r = (k / 8) | 0, c = k % 8;
    view.spawnAnim.set(k, view.time);
    // 氷は水色（PALETTE の 5）の粒で弾けさせる。burstCell は色 index しか
    // 受けないので 10/11 は渡さない（PALETTE に無い値で落ちるのを避ける）。
    view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, isFreeze ? 5 : 9, 'fx_default');
  }
  view.shake = isFreeze ? ((tech && tech.shake) || 16) : 12;
  if (isFreeze) view.screenFlash = Math.max(view.screenFlash || 0, (tech && tech.flash) || 0.35);
  const def = BOSS_MOVES[pa.moveId] || BOSS_MOVES.garbage;
  if (isFreeze && tech && tech.hitMsg) {
    toast(t(tech.hitMsg, tech.hitMsgEn || tech.hitMsg), 'err', 1800);
  } else {
    toast(t(`${def.name}が直撃！`, `${def.nameEn} hits!`), 'err', 1300);
  }
  // 直書きで埋まった行・列はここで消す。addGarbage() と違って engine を
  // 通らないので、これが無いと満杯の行が居座ったままになる ──
  // ブレスは「ある行の空きマス全部」、レーザーは「ある列の空きマス全部」を
  // 撃つので、着弾＝必ずその行/列が満杯になる経路がいちばん太い。
  // 必ず hasAnyMove() より前に。順番が逆だと、消えれば8マス空いて続けられる
  // 盤面で不当にゲームオーバーになる。加点しないのは、ボスの妨害で埋まった
  // ぶんを被害者の得点にしないため（engine.resolveLines と同じ方針）。
  e.resolveLines();
  // Direct grid writes bypass engine.place's game-over check.
  if (!e.hasAnyMove()) e.over = true;
  m.afterAttack();
}

// Clearing a line through a telegraphed cell = CUT: cancel + counter damage.
function bossTryCut(m, result) {
  const pa = m.pendingAtk;
  if (!pa || result.lineCount === 0) return 0;
  const hit = pa.cells.some(k => {
    const r = (k / 8) | 0, c = k % 8;
    return result.fullRows.includes(r) || result.fullCols.includes(c);
  });
  if (!hit) return 0;
  m.pendingAtk = null;
  view.dangerCells = null;
  m.cuts = (m.cuts || 0) + 1;
  // 専用技を切ったときは、その技の「切った」文言を出す。
  const cutTech = bossTech(m, pa.moveId);
  if (cutTech && cutTech.cutMsg) {
    toast(t(cutTech.cutMsg, cutTech.cutMsgEn || cutTech.cutMsg), 'ok', 1800);
  }
  m.nextAtk = Date.now() + Math.max(2500, bossAtkMs(m) - bossTelegraphMs(m));
  const dmg = Math.round((200 + m.maxHp * 0.018) * (m.counterMult || 1));
  m.hp -= dmg;
  m.engine.chargeUlt(12);
  audio.combo(9);
  view.screenFlash = 0.3;
  view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize * 0.18, 'COUNTER!', '#43d9e8', 2);
  m.damageFloat(dmg, true);
  return dmg;
}

function bossCheckPhase(m) {
  if (m.phase2 || m.hp > m.maxHp / 2 || m.hp <= 0 || m.ended) return;
  m.phase2 = true;
  $('#bossEmoji').classList.add('boss-enrage');
  view.screenFlash = 0.45;
  view.shake = 16;
  audio.kamiDescend();
  toast(t(`${m.boss.name} 第二形態！攻撃が激化する！`, `${catName(m.boss)} enters phase 2! Attacks intensify!`), 'announce', 2600);
}

// 討伐ランク: 速さ・カット数・被弾数・コンボから S/A/B/C。
function bossRankFor(m) {
  const dur = (Date.now() - m.startedAt) / 1000;
  const par = m.maxHp / 110 + 25;
  let pts = 100;
  pts -= Math.max(0, dur / par - 1) * 45;
  pts += Math.min(30, (m.cuts || 0) * 6);
  pts -= (m.garbageTaken || 0) * 1.1;
  if (m.engine.maxCombo >= 8) pts += 8;
  return pts >= 96 ? 'S' : pts >= 72 ? 'A' : pts >= 45 ? 'B' : 'C';
}

function bossRankHtml(rank) {
  return `<div class="boss-rank-wrap"><span class="boss-rank rank-${rank}">${rank}</span><small>${t('討伐ランク', 'Clear rank')}</small></div>`;
}

class BossMode {
  constructor(boss, bossIndex, bossCount) {
    this.mode = 'boss';
    this.boss = boss;
    this.bossIndex = bossIndex;
    this.bossCount = bossCount;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden', 'slim');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    setBossFace($('#bossEmoji'), bossIconName(this.boss.id));
    $('#bossName').textContent = catName(this.boss);
    showItemBar(true);
    this.hp = this.boss.hp;
    this.maxHp = this.boss.hp;
    this.phase2 = false;
    this.pendingAtk = null;
    this.cuts = 0;
    this.garbageTaken = 0;
    this.updateHpBar();
    this.startedAt = Date.now();

    const v = getView();
    const stage = BOSS_STAGE[this.boss.id] || {};
    setModeTheme({ ...equippedTheme(), boardId: stage.board || 'board_default' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(stage.track || 'boss');

    countdownOverlay(3, afterCountdown(this, () => {
      v.inputLocked = false;
      this.nextAtk = Date.now() + bossAtkMs(this);
      this.atkInt = setInterval(() => this.tickAttack(), 100);
    }), audio);
  }

  afterAttack() {
    if (this.engine.over) this.finish(false);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = t('与ダメージ', 'Damage dealt');
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.boss.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.hp))} / ${fmt(this.boss.hp)}`;
  }

  onPlace(result) {
    this.updateHud();
    const dmg = result.gained;
    this.hp -= dmg;
    this.damageFloat(dmg, result.lineCount > 0);
    bossTryCut(this, result);
    bossCheckPhase(this);
    this.updateHpBar();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.finish(true);
  }

  damageFloat(dmg, big) {
    const span = document.createElement('span');
    span.className = `dmg-float ${big ? 'big' : ''}`;
    span.textContent = `-${fmt(dmg)}`;
    span.style.left = `${30 + Math.random() * 40}%`;
    $('#bossPanel').appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  tickAttack() {
    if (this.ended) return;
    const total = this.pendingAtk ? bossTelegraphMs(this) : bossAtkMs(this);
    const remain = Math.max(0, this.nextAtk - Date.now());
    const bar = $('#bossAtkBar');
    bar.style.width = `${Math.max(0, Math.min(100, (1 - remain / total) * 100))}%`;
    bar.classList.toggle('danger', !!this.pendingAtk);
    if (remain <= 0) {
      if (this.pendingAtk) bossImpact(this);
      else bossBeginMove(this);
    }
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    view.inputLocked = true;
    view.dangerCells = null;
    $('#bossAtkBar').classList.remove('danger');
    const dur = (Date.now() - this.startedAt) / 1000;
    const rank = won ? bossRankFor(this) : null;
    if (won) {
      audio.bossDefeated();
      confettiBurst(60);
      $('#bossEmoji').classList.add('boss-dead');
    } else if (!this.aborted) {
      audio.gameOver();
    }

    if (won) {
      const cur = Number(localStorage.getItem('bba_boss_max') || 0);
      if (this.bossIndex + 1 > cur) localStorage.setItem('bba_boss_max', String(this.bossIndex + 1));
    }
    const rewards = await submitResult({
      mode: 'boss', bossId: this.boss.id, score: this.engine.score,
      lines: this.engine.linesCleared, maxCombo: this.engine.maxCombo,
      duration: dur, won, rank,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (rewards && rewards.badge === 'maou') {
      setTimeout(() => toast(t('バッジ「魔王討伐」を獲得！', 'Badge earned: Demon Lord Slain!'), 'announce', 4000), 1200);
    }

    const hasNext = won && this.bossIndex + 1 < this.bossCount;
    // 帯は innerHTML なので、ボスの絵はここだけ独自アイコンに置き換えられる。
    const bossIc = icon(bossIconName(this.boss.id), { size: 26 });
    const banner = won ? `${bossIc} ${t('討伐成功！', 'Boss defeated!')}` : this.aborted ? t('中断（引き分け）', 'Aborted (draw)') : t('やられた…', 'Defeated…');
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      ${won ? bossRankHtml(rank) : ''}
      ${this.aborted ? `<p class="muted center">${t('途中終了は引き分け扱いです。敗北にはなりません', 'Quitting early counts as a draw, not a loss')}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('与えたダメージ', 'Damage dealt')}</span><b>${fmt(this.engine.score)}</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t(`${this.boss.name}の残りHP`, `${catName(this.boss)}'s HP left`)}</span><b>${fmt(Math.max(0, this.hp))}</b></div>`}
        <div class="rs-row"><span>${t('討伐タイム', 'Clear time')}</span><b>${Math.round(dur)}${t('秒', 's')}</b></div>
        <div class="rs-row"><span>${t('攻撃カット', 'Attacks cut')}</span><b>${fmt(this.cuts)}</b></div>
        <div class="rs-row"><span>${t('被弾お邪魔', 'Garbage taken')}</span><b>${fmt(this.garbageTaken)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(this.engine.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn ${won ? 'btn-primary' : 'btn-ai'}" id="rAgain">${hasNext ? t('次のボスへ', 'Next boss') : won ? t('もう一度', 'Play again') : this.aborted ? t('もう一度', 'Play again') : t('リベンジ', 'Revenge!')}</button>
      </div>`, { dismissable: false, peekable: true });
    if (won) setTimeout(() => { const el = m.querySelector('.boss-rank'); if (el) { el.classList.add('show'); audio.victory(); } }, 500);
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      if (hasNext && window.__bbaOpenBossSelect) {
        // 先にメニューへ戻してから選ばせる。ゲーム画面のままボス選択を開くと、
        // それを閉じた人（背景タップ／端末の戻る／通信が切れてモーダルすら
        // 出ないとき）が、固まった盤面だけの画面に取り残されていた ──
        // destroy() 済みなので ✕→「終了する」も finish() の即 return で効かず、
        // リロード以外に抜ける手が無かった。
        endToMenu();
        window.__bbaOpenBossSelect(this.bossIndex + 1);
      } else {
        this.destroy();
        startBoss(this.boss, this.bossIndex, this.bossCount);
      }
    };
  }

  quit() {
    // 他モードと同じ退避。結果まで進んでいると finish() は先頭で即 return
    // するので、ここで戻さないと ✕ を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.aborted = true;
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#bossAtkBar').classList.remove('danger');
    if (view) view.dangerCells = null;
  }
}

export function startBoss(boss, bossIndex, bossCount) {
  if (currentMode) currentMode.destroy();
  currentMode = new BossMode(boss, bossIndex, bossCount);
  window.__bbaMode = currentMode;   // debug/testing hook
  currentMode.start();
}

// ---------------------------------------------------------------------------
// ⚔️ 無限地獄ラッシュ: 全ボス連戦のローグライク。撃破ごとに遺物を1つ選んで
// ビルドを組み、全ボスを撃破したら2周目へ（HP倍増・攻撃加速）。深度＝累計
// 撃破数が記録になる。1ミス終了 — ただし不死鳥の羽があれば一度だけ蘇る。
// ---------------------------------------------------------------------------

const RUSH_RELICS = [
  { id: 'atk',     iconName: 'relic_atk', name: '剛力の遺物',   nameEn: 'Relic of Might',   desc: '与ダメージ+40%（累積可）',        descEn: 'Damage +40% (stacks)', w: 10 },
  { id: 'counter', iconName: 'relic_counter', name: '火薬の遺物',   nameEn: 'Relic of Powder',  desc: 'カット反撃ダメージ2倍（累積可）', descEn: 'Counter damage ×2 (stacks)', w: 8 },
  { id: 'reroll',  iconName: 'relic_reroll', name: '風の遺物',     nameEn: 'Relic of Wind',    desc: 'リロール+2',                      descEn: '+2 rerolls', w: 9 },
  { id: 'ult',     iconName: 'relic_ult', name: '雷の遺物',     nameEn: 'Relic of Thunder', desc: '奥義ゲージの溜まり1.5倍（累積可）', descEn: 'Ult charge ×1.5 (stacks)', w: 8 },
  { id: 'heal',    iconName: 'relic_heal', name: '慈悲の遺物',   nameEn: 'Relic of Mercy',   desc: '下2行とお邪魔を全消去',           descEn: 'Clear bottom rows + garbage', w: 9 },
  { id: 'calm',    iconName: 'relic_calm', name: '静寂の遺物',   nameEn: 'Relic of Calm',    desc: 'ボスの攻撃セル-1（最低1）',       descEn: 'Boss attack cells -1 (min 1)', w: 7 },
  { id: 'shield',  iconName: 'relic_shield', name: '城壁の遺物',   nameEn: 'Relic of Walls',   desc: 'コンボが途切れなくなる',          descEn: 'Your combo never breaks', w: 6, unique: true },
  { id: 'phoenix', iconName: 'relic_phoenix', name: '不死鳥の羽',   nameEn: 'Phoenix Feather',  desc: '一度だけ窒息から復活する',        descEn: 'Revive once from a top-out', w: 5, unique: true },
];

// 所持している遺物を横一列で見せる帯。同じ遺物を複数持てる（累積可）ので、
// 拾った順にそのまま並べる ── 「何を何個積んだか」がビルドの説明そのもの。
// ⚠ 返すのは SVG 文字列なので innerHTML に入る場所だけで使うこと。
function relicStrip(ids, size = 18) {
  return ids.map(id => {
    const r = RUSH_RELICS.find(x => x.id === id);
    return r ? ic(r.iconName, size) : '';
  }).join('');
}

class BossRushMode {
  constructor(bosses) {
    this.mode = 'boss';        // shares boss-panel admin command (HP halve)
    this.bosses = bosses;
    this.kills = 0;            // 深度 = 累計撃破数
    this.relics = [];
  }

  lap() { return Math.floor(this.kills / this.bosses.length); }

  // 周回でHPが倍々に、攻撃間隔が少しずつ短く。
  scaledBoss() {
    const base = this.bosses[this.kills % this.bosses.length];
    const lap = this.lap();
    return {
      ...base,
      hp: Math.round(base.hp * (1 + lap)),
      atkSec: Math.max(4, base.atkSec * Math.pow(0.94, lap)),
    };
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden', 'slim');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    showItemBar(true);
    this.kills = 0;
    this.relics = [];
    this.counterMult = 1;
    this.atkCellsDelta = 0;
    this.ultRateBonus = 1;
    this.phoenix = false;
    this.relicOpen = false;
    this.cuts = 0;
    this.garbageTaken = 0;
    this.boss = this.scaledBoss();
    this.applyBossPanel();
    this.startedAt = Date.now();

    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_oni' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('boss');
    toast(t('無限地獄ラッシュ！倒すほど深く、敵は強く。遺物でビルドを組め！', 'Infinite Hell Rush! The deeper you go, the stronger they get. Build with relics!'), 'announce', 3200);

    countdownOverlay(3, afterCountdown(this, () => {
      v.inputLocked = false;
      this.nextAtk = Date.now() + bossAtkMs(this);
      this.atkInt = setInterval(() => this.tickAttack(), 100);
    }), audio);
  }

  afterAttack() {
    if (this.engine.over) this.onTopOut();
  }

  damageFloat(dmg, big) {
    const span = document.createElement('span');
    span.className = `dmg-float ${big ? 'big' : ''}`;
    span.textContent = `-${fmt(dmg)}`;
    span.style.left = `${30 + Math.random() * 40}%`;
    $('#bossPanel').appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  tickAttack() {
    if (this.ended || this.relicOpen) return;
    const total = this.pendingAtk ? bossTelegraphMs(this) : bossAtkMs(this);
    const remain = Math.max(0, this.nextAtk - Date.now());
    const bar = $('#bossAtkBar');
    bar.style.width = `${Math.max(0, Math.min(100, (1 - remain / total) * 100))}%`;
    bar.classList.toggle('danger', !!this.pendingAtk);
    if (remain <= 0) {
      if (this.pendingAtk) bossImpact(this);
      else bossBeginMove(this);
    }
  }

  applyBossPanel() {
    this.hp = this.boss.hp;
    this.maxHp = this.boss.hp;
    this.phase2 = false;
    this.pendingAtk = null;
    if (view) view.dangerCells = null;
    setBossFace($('#bossEmoji'), bossIconName(this.boss.id));
    const lapTxt = this.lap() > 0 ? t(`（${this.lap() + 1}周目）`, ` (lap ${this.lap() + 1})`) : '';
    $('#bossName').textContent = `${catName(this.boss)}${lapTxt}`;
    this.updateHpBar();
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').innerHTML = ic('mode_bossrush', 13) + ' ' + t(`深度${this.kills + 1} ・ 遺物${this.relics.length}`, `Depth ${this.kills + 1} ・ ${this.relics.length} relics`);
  }

  updateHpBar() {
    const pct = Math.max(0, (this.hp / this.maxHp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.hp))} / ${fmt(this.maxHp)}`;
  }

  onPlace(result) {
    this.updateHud();
    this.hp -= result.gained;
    bossTryCut(this, result);
    bossCheckPhase(this);
    this.updateHpBar();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.bossDown();
  }

  bossDown() {
    this.kills++;
    this.pendingAtk = null;
    if (view) view.dangerCells = null;
    audio.bossDefeated();
    confettiBurst(30);
    if (view) view.shake = 12;
    // 遺物を選んでから次のボスへ（選択中は攻撃停止）。
    this.relicOpen = true;
    view.inputLocked = true;
    this.offerRelic(() => {
      this.boss = this.scaledBoss();
      this.applyBossPanel();
      this.updateHud();
      this.relicOpen = false;
      view.inputLocked = false;
      this.nextAtk = Date.now() + bossAtkMs(this);
      const lapUp = this.kills % this.bosses.length === 0;
      toast(lapUp
        ? t(`${this.lap() + 1}周目突入！ボスが強化された！`, `Lap ${this.lap() + 1}! The bosses grow stronger!`)
        : t(`つぎは ${this.boss.name}！`, `Next up: ${catName(this.boss)}!`), 'announce', 2400);
      // とどめの一手が同時に手詰まりだった場合、bossDown 中は relicOpen ガードで
      // 保留していたトップアウト判定をここで再評価する。heal 遺物は盤面を開けても
      // e.over を下ろさないため、useGameItem 末尾と同じ over 解除を先に行う。
      const e = this.engine;
      if (e.over && e.hasAnyMove()) e.over = false;
      if (e.over) this.onTopOut();
    });
  }

  relicChoices() {
    const pool = RUSH_RELICS.filter(r =>
      !(r.unique && (r.id === 'shield' ? this.engine.streakShield : this.phoenix)));
    const out = [];
    const bag = pool.slice();
    while (out.length < 3 && bag.length) {
      const total = bag.reduce((a, r) => a + r.w, 0);
      let x = Math.random() * total;
      for (let i = 0; i < bag.length; i++) {
        x -= bag[i].w;
        if (x <= 0) { out.push(bag.splice(i, 1)[0]); break; }
      }
    }
    return out;
  }

  offerRelic(next) {
    const choices = this.relicChoices();
    const m = showModal(`
      <h2>${icon(bossIconName(this.boss.id), { size: 22 })} ${t('撃破！', 'Down!')} <small class="muted">${t(`深度${this.kills}`, `depth ${this.kills}`)}</small></h2>
      <p class="muted center" style="margin-bottom:10px">${t('遺物を1つ選べ', 'Choose a relic')}</p>
      <div class="form-col">
        ${choices.map(r => `
          <button class="btn btn-ghost perk-btn" data-perk="${r.id}">
            <span class="perk-icon">${ic(r.iconName, 26)}</span>
            <span class="perk-body"><b>${t(r.name, r.nameEn)}</b><small>${t(r.desc, r.descEn)}</small></span>
          </button>`).join('')}
      </div>
      <p class="muted center deck-strip">${this.relics.length ? `${t('所持遺物', 'Relics')}: ${relicStrip(this.relics, 18)}` : ''}</p>`,
      { dismissable: false });
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => { this.applyRelic(b.dataset.perk); closeModal(); next(); };
    });
    if (autopilot.on && autopilot.autoPerks !== false) {
      setTimeout(() => {
        const b = m.querySelector('[data-perk]');
        if (b && document.body.contains(b)) b.click();
      }, 800);
    }
  }

  applyRelic(id) {
    const e = this.engine;
    audio.coin();
    this.relics.push(id);
    switch (id) {
      case 'atk':     e.scoreMult = Math.round((e.scoreMult + 0.4) * 100) / 100; break;
      case 'counter': this.counterMult *= 2; break;
      case 'reroll':  e.rerolls += 2; updateRerollHud(e); break;
      // updateUltHud rewrites e.ultRate every 120ms — the bonus must live on
      // the mode where that poll multiplies it in.
      case 'ult':     this.ultRateBonus *= 1.5; break;
      case 'heal': {
        for (let i = 0; i < 64; i++) if (e.grid[i] === 9) e.grid[i] = 0;
        for (let r = 6; r < 8; r++) for (let c = 0; c < 8; c++) e.grid[r * 8 + c] = 0;
        view.reviveFlash();
        break;
      }
      case 'calm':    this.atkCellsDelta--; break;
      case 'shield':  e.streakShield = true; break;
      case 'phoenix': this.phoenix = true; break;
    }
  }

  // 戻り値 true ＝「復活したので死亡音は鳴らさないで」（game.js の handleOver）。
  onTopOut() {
    if (this.ended || this.relicOpen) return true;
    if (autoRescue()) return true;   // autopilot 5.0 guard — before burning the phoenix
    if (this.phoenix) {
      this.phoenix = false;
      this.engine.reviveBoard();
      view.reviveFlash();
      confettiBurst(40);
      audio.levelUp();
      toast(t('不死鳥の羽が燃え尽きた！盤面リセットで復活！', 'The Phoenix Feather burns out — board reset, you live!'), 'announce', 3000);
      this.updateHud();
      updateRerollHud(this.engine);
      return true;
    }
    // 同上 ── finish(false) の中で鳴らす。
    this.finish(false);
    return true;
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    view.inputLocked = true;
    view.dangerCells = null;
    $('#bossAtkBar').classList.remove('danger');
    // 「制覇」= 1周（全ボス撃破）以上。深度がそのまま記録になる。
    const conquered = this.kills >= this.bosses.length;
    if (!this.aborted) audio.gameOver();
    const localDepth = Number(localStorage.getItem('bba_rush_depth') || 0);
    // 別端末ではサーバー統計にしか最深記録が無いので、両者の最大と比べる
    // （localStorage だけだと新端末で虚偽の「最深記録更新！」が出る）。
    const bestDepth = session.user ? Math.max(localDepth, session.user.stats.rushDepth || 0) : localDepth;
    const isBest = this.kills > 0 && this.kills > bestDepth;
    if (this.kills > localDepth) localStorage.setItem('bba_rush_depth', String(this.kills));
    const rewards = await submitResult({
      mode: 'boss_rush', score: this.engine.score,
      lines: this.engine.linesCleared, maxCombo: this.engine.maxCombo,
      duration: (Date.now() - this.startedAt) / 1000, won: conquered, depth: this.kills,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (rewards && rewards.badge === 'rush') {
      setTimeout(() => toast(t('バッジ「ボスラッシュ制覇」を獲得！ ジェム+300', 'Badge earned: Boss Rush Conqueror! +300 gems'), 'announce', 5000), 1200);
    }
    if (isBest) confettiBurst(50);
    const bossIc = icon(bossIconName(this.boss.id), { size: 26 });
    const banner = isBest ? `${ic('mode_bossrush', 26)} ${t('最深記録更新！', 'New depth record!')}`
      : this.aborted ? t('中断', 'Aborted')
      : `${bossIc} ${t('に敗北…', 'defeated you…')}`;
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${ic('mode_bossrush')} ${t('深度', 'Depth')}</span><b>${fmt(this.kills)}${t('体', '')} ${this.lap() > 0 || conquered ? t(`（${this.lap() + 1}周目）`, ` (lap ${this.lap() + 1})`) : ''}</b></div>
        <div class="rs-row"><span>${t('集めた遺物', 'Relics collected')}</span><b>${relicStrip(this.relics, 20) || t('なし', 'none')}</b></div>
        <div class="rs-row"><span>${t('総ダメージ', 'Total damage')}</span><b>${fmt(this.engine.score)}</b></div>
        <div class="rs-row"><span>${t('攻撃カット', 'Attacks cut')}</span><b>${fmt(this.cuts)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ai" id="rAgain">${t('もう一度潜る', 'Dive again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startBossRush(this.bosses); };
  }

  quit() {
    // ボス戦（BossMode）と同じ退避。結果まで進んでいると finish() は先頭で
    // 即 return するので、ここで戻さないと出口の無い画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.aborted = true;
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#bossAtkBar').classList.remove('danger');
    if (view) view.dangerCells = null;
  }
}

export function startBossRush(bosses) {
  if (currentMode) currentMode.destroy();
  currentMode = new BossRushMode(bosses);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Weekly challenge: everyone worldwide gets the same seed and 40 pieces.
// Pure score attack — resets every Monday 00:00 UTC.
// ---------------------------------------------------------------------------

class WeeklyMode {
  constructor(info) {
    this.mode = 'weekly';
    this.info = info;   // { week, seed, pieces, endsAt, best }
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);   // fair play: no boosters
    this.startedAt = Date.now();
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_galaxy' });
    this.engine = new Engine(this.info.seed);
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = () => this.onPlace();
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('battle');
    toast(t(`ウィークリーチャレンジ！${this.info.pieces}個のピースで限界に挑め！`, `Weekly Challenge! Push your limit with ${this.info.pieces} pieces!`), 'announce', 2800);
  }

  piecesLeft() { return Math.max(0, this.info.pieces - this.engine.piecesPlaced); }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    // ベストは走行中に伸びる（ソロ／メルトダウン／キメラと同じ扱い）。this.best()
    // だけだと、自己ベストを超えたあとも現在スコアより小さい数字が「ベスト」として
    // 並び続ける。
    const shownBest = fmt(Math.max(this.best(), this.engine.score));
    // innerHTML にしたので、サーバー由来の週 id もそのまま流さず必ず通す。
    $('#hudSub').innerHTML = ic('mode_weekly', 13) + ' ' + escapeHtml(t(`${this.info.week} ・ ベスト ${shownBest}`, `${this.info.week} ・ Best ${shownBest}`));
    const tm = $('#hudTimer');
    tm.textContent = t(`残り${this.piecesLeft()}個`, `${this.piecesLeft()} left`);
    tm.classList.toggle('urgent', this.piecesLeft() <= 5);
  }

  best() {
    const local = this.localBest();
    return Math.max(this.info.best || 0, local);
  }

  localBest() {
    try {
      const v = JSON.parse(localStorage.getItem('bba_weekly_best'));
      if (v && v.week === this.info.week) return v.best || 0;
    } catch { /* ignore */ }
    return 0;
  }

  onPlace() {
    this.updateHud();
    if (this.piecesLeft() <= 0 && !this.ended) this.finish();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const prevBest = this.best();
    const isBest = e.score > prevBest;
    if (e.score > this.localBest()) {
      localStorage.setItem('bba_weekly_best', JSON.stringify({ week: this.info.week, best: e.score }));
    }
    if (isBest && e.score > 0) { audio.victory(); confettiBurst(50); } else { audio.gameOver(); }
    const rewards = await submitResult({
      mode: 'weekly', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const usedAll = e.piecesPlaced >= this.info.pieces;
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${ic('mode_weekly', 26)} ${isBest ? t('今週のベスト更新！', 'New weekly best!') : t('チャレンジ終了', 'Challenge complete')}</div>
      ${usedAll ? '' : `<p class="muted center">${t('ピースを置く場所がなくなりました', 'No room left to place a piece')}</p>`}
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}${isBest ? ' ' + ic('medal_1', 14) : ''}</b></div>
        <div class="rs-row"><span>${t('今週のベスト', "This week's best")}</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>${t('使ったピース', 'Pieces used')}</span><b>${fmt(e.piecesPlaced)} / ${this.info.pieces}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
        ${session.user ? '' : `<div class="rs-row"><span>${t('ランキング掲載にはログイン', 'Log in to appear on the ranking')}</span></div>`}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rRank">${ic('leaderboard', 15)} ${t('順位を見る', 'Standings')}</button>
        <button class="btn btn-weekly" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rRank').onclick = () => {
      closeModal(); endToMenu();
      if (window.__bbaOpenLeaderboard) window.__bbaOpenLeaderboard('weekly');
    };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startWeekly({ ...this.info, best: Math.max(this.info.best || 0, e.score) }); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }
  destroy() { this.ended = true; }
}

export function startWeekly(info) {
  if (currentMode) currentMode.destroy();
  currentMode = new WeeklyMode(info);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// 📅 Daily challenge: same seed + 30 pieces for everyone, a rule-of-the-day
// modifier, and ONE recorded attempt per JST day (later runs are practice).
// ---------------------------------------------------------------------------

// お題の効果はすべて決定的に適用する。Engine(seed) を作った直後に全員が
// 同じ順番で同じ操作（手札引き直し・瓦礫）をするので、乱数列は世界共通のまま。
// 📅 お題ぶんの乱数。engine.rng（＝ピース列の共有シード）とは別に持つ。
//    ここで engine.rng を回すと、リプレイと残像レースがピース列ごとズレる。
//    種は「その日の seed」なので、全員が必ず同じ瓦礫を踏む。
function dailyRng(seed) {
  let s = (Number(seed) || 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function applyDailyModifier(engine, mod, seed = 0) {
  const id = mod && mod.id;
  if (id === 'giant') engine.chaosBig = true;
  if (id === 'mini') engine.chaosMini = true;
  if (id === 'combo') engine.comboBonusMult = 2;
  if (id === 'rainbow') engine.rerolls = 3;
  // 初期手札はコンストラクタで通常プールから引かれている — お題のプールで
  // 引き直す（3回ぶん乱数を消費するが、全員同じなので公平）。
  if (id === 'giant' || id === 'mini') {
    for (let i = 0; i < 3; i++) engine.hand[i] = engine.drawPiece();
  }
  // 🪨 置き場所も seed で決める（全員が同じ盤面から始まる）。
  if (id === 'rubble') engine.addGarbage(10, dailyRng(seed));
}

function dailyLocalRecord(day) {
  try {
    const v = JSON.parse(localStorage.getItem('bba_daily_record'));
    if (v && v.day === day) return v;
  } catch { /* ignore */ }
  return null;
}

class DailyMode {
  constructor(info, attempt) {
    this.mode = 'daily';
    this.info = info;   // { day, seed, pieces, modifier, target, endsAt, played, score, streak }
    // 「記録になる回」かどうかは開始時点で確定させる。ログイン中の記録回は
    // startDaily() が /api/daily/start で予約済みで、その attemptId を添えた
    // 提出だけがサーバーに記録される。
    this.attemptId = (attempt && attempt.attemptId) || null;
    this.practice = attempt
      ? !!attempt.practice
      : (!!info.played || (!session.user && !!dailyLocalRecord(info.day)));
    // 🎞 I16: この回の着手ログ。結果送信に replay として同梱する。
    this.moves = [];
    // 📼 I1: 隣で走らせる残像（{ replay, username, score } / 無ければ null）。
    // 既定は null なので、従来のデイリーの挙動は1ミリも変わらない。
    this.ghost = (attempt && attempt.ghost) || null;
  }

  // 着手を1つ記録する。サーバーの上限（200手）を超えたぶんは捨てる
  // ── 送っても丸ごと破棄されるだけなので、送信量を無駄に増やさない。
  recordMove(index, row, col) {
    if (this.moves.length >= DAILY_REPLAY_MAX_MOVES) return;
    this.moves.push({ h: index | 0, r: row | 0, c: col | 0, t: Math.max(0, Date.now() - this.startedAt) });
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);   // fair play: no boosters / ultimates
    this.startedAt = Date.now();
    this.moves = [];
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_sunset' });
    this.engine = new Engine(this.info.seed);
    applyDailyModifier(this.engine, this.info.modifier, this.info.seed);
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = () => this.onPlace();
    // 🎞 着手の記録だけを取る「見張り」。false を返すので、game.js は
    // これまでどおり自分で place() → applyResult() を続ける（進行は不変）。
    v.onIntentPlace = (i, r, c) => { this.recordMove(i, r, c); return false; };
    v.onGameOver = () => this.finish();
    if (this.ghost) this.startGhostRace();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('battle');
    const mod = this.info.modifier || {};
    toast(t(
      `${mod.ja || ''}！${this.info.pieces}個で${fmt(this.info.target)}点を狙え！${this.practice ? '（練習）' : ''}`,
      `${mod.en || ''}! Chase ${fmt(this.info.target)} with ${this.info.pieces} pieces!${this.practice ? ' (practice)' : ''}`,
    ), 'announce', 3200);
  }

  piecesLeft() { return Math.max(0, this.info.pieces - this.engine.piecesPlaced); }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const mod = this.info.modifier || {};
    $('#hudSub').innerHTML = ic('mode_daily', 13) + ' ' + escapeHtml(t(
      `${mod.ja || ''} ・ 目標 ${fmt(this.info.target)}${this.practice ? ' ・ 練習' : ''}`,
      `${mod.en || ''} ・ Target ${fmt(this.info.target)}${this.practice ? ' ・ practice' : ''}`,
    ));
    const tm = $('#hudTimer');
    tm.textContent = t(`残り${this.piecesLeft()}個`, `${this.piecesLeft()} left`);
    tm.classList.toggle('urgent', this.piecesLeft() <= 5);
    if (this.ghost) this.updateGhostHud();
  }

  onPlace() {
    this.updateHud();
    if (this.piecesLeft() <= 0 && !this.ended) this.finish();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const cleared = e.score >= this.info.target;
    if (cleared && e.score > 0) { audio.victory(); confettiBurst(50); } else { audio.gameOver(); }
    // ゲストは記録がサーバーに残らないので、その日の初回だけローカルに控える。
    if (!session.user && !this.practice) {
      try { localStorage.setItem('bba_daily_record', JSON.stringify({ day: this.info.day, score: e.score })); } catch { /* ignore */ }
    }
    const rewards = await submitResult({
      mode: 'daily', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
      // 走った盤面の日を必ず添える。これが無いとサーバーは「提出時点の日」に
      // 記録してしまい、23:58に始めて0:02に終わった回が翌日の1回を焼く。
      day: this.info.day,
      // 開始時に予約した挑戦の証。記録回はこれが一致したときだけ確定する。
      ...(this.attemptId ? { attemptId: this.attemptId } : {}),
      // 🎞 I16 ゴーストリプレイ。報酬計算には一切渡らない追加欄なので、
      // 壊れていても・送らなくても従来どおり動く（seed はサーバーが上書きする）。
      ...(this.moves.length ? { replay: { seed: this.info.seed, moves: this.moves, score: e.score } } : {}),
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    // 送信そのものが失敗した回。サーバーには開始時の予約（0点）が残ったまま
    // なので、記録もされないし今日はもう挑戦し直せない ── ここを「練習」と
    // 言ってしまうと、いちばん説明が要る場面で嘘をつくことになる。
    const sendFailed = !!(rewards && rewards.failed);
    // 📴 圏外で控えに入った回は「失敗」ではない ── net.js がつながったときに
    // 同じ runId で送り直すので、記録もそのとき付く。ここを sendFailed と
    // ひとまとめにすると「記録に残りません」と嘘をつくし、素通しにすると
    // 下の既定文（＝「今日の記録はもう確定している練習回」）になって、
    // これから記録される回を練習だと言ってしまう。
    const sendQueued = !!(rewards && rewards.queued);
    const d = rewards && rewards.daily;
    const recorded = d ? d.recorded : (session.user ? false : !this.practice);
    const streak = d ? d.streak : 0;
    const usedAll = e.piecesPlaced >= this.info.pieces;
    // 記録されなかった理由はサーバーが返す。まとめて「練習」と言ってしまうと、
    // 日付を跨いだ回や予約の取れていない回に嘘の説明をすることになる。
    const notRecordedNote = sendQueued
      ? t('通信が切れています。この回はつながったときに送られ、そのとき記録されます',
          'You are offline — this run will be submitted and recorded once you reconnect')
      : sendFailed
      ? t('結果を送信できませんでした。この回は記録もランキングにも残りません',
          'Your result could not be submitted — this run is not recorded or ranked')
      : {
        stale: t('日付が変わったため、この回は記録されません', 'The day rolled over — this run was not recorded'),
        unreserved: t('挑戦の登録ができていないため記録されません。メニューから開き直してください',
          'This run was not registered, so it is not recorded — please reopen it from the menu'),
        expired: t('開始から時間が経ちすぎたため記録されません', 'Too long since you started — this run was not recorded'),
      }[d && d.reason] || t('この回は練習 — 今日の記録はすでに確定しています', 'Practice run — today\'s record is already locked in');
    const m = showModal(`
      <div class="result-banner ${cleared ? 'win' : 'draw'}">${ic('mode_daily', 26)} ${cleared ? t('デイリークリア！', 'Daily cleared!') : t('挑戦終了', 'Challenge over')}</div>
      ${usedAll ? '' : `<p class="muted center">${t('ピースを置く場所がなくなりました', 'No room left to place a piece')}</p>`}
      ${recorded ? '' : `<p class="muted center">${notRecordedNote}</p>`}
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)} / ${fmt(this.info.target)}</b></div>
        ${recorded && d ? `<div class="rs-row"><span>${ic('fire')} ${t('連続クリア', 'Clear streak')}</span><b>${d.cleared ? t(`${streak}日目`, `Day ${streak}`) : t('リセット…', 'Reset…')}</b></div>` : ''}
        ${d && d.bonusCoins ? `<div class="rs-row"><span>${ic('mode_daily')} ${t('デイリーボーナス', 'Daily bonus')}</span><b>+${fmt(d.bonusCoins)} ${ic('coins', 14)}${d.bonusGems ? ` +${fmt(d.bonusGems)} ${ic('gems', 14)}` : ''}</b></div>` : ''}
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${sendQueued
          ? `<div class="rs-row"><span>${ic('offline')} ${t('未送信 — つながったら自動で送ります（報酬はそのとき入ります）', 'Not sent yet — it will be submitted automatically when you reconnect')}</span></div>`
          : sendFailed
          ? `<div class="rs-row"><span>${ic('warn')} ${t('送信に失敗しました — この回の報酬は付いていません', 'Submission failed — no rewards for this run')}</span></div>`
          : rewards ? `
        <div class="rs-row"><span>${ic('coins')} ${t('コイン', 'Coins')}</span><b>+${fmt(rewards.coins)}</b></div>
        <div class="rs-row"><span>${ic('battlepass')} ${t('パスXP', 'Pass XP')}</span><b>+${fmt(rewards.bpXp)}</b></div>
        <div class="rs-row"><span>${ic('xp')} ${t('アカウントXP', 'Account XP')}</span><b>+${fmt(rewards.accXp)}</b></div>`
        : `<div class="rs-row"><span>${t('記録とランキングにはログイン', 'Log in for records & the ranking')}</span></div>`}
        ${/* デイリーだけ報酬欄を自前で組んでいるので、rewardsRows() を通らず
             シェアが出ていなかった。毎日みんなが同じ盤面で競う回こそ
             見せ合いたいのに、ここだけ導線が無いのは惜しい。 */ shareRow()}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rGhosts">${ic('clip', 15)} ${t('みんなの走り', 'Ghosts')}</button>
        <button class="btn btn-ghost" id="rRank">${ic('leaderboard', 15)} ${t('順位を見る', 'Standings')}</button>
        <button class="btn btn-daily" id="rAgain">${t('もう一度（練習）', 'Again (practice)')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rRank').onclick = () => {
      closeModal(); endToMenu();
      if (window.__bbaOpenLeaderboard) window.__bbaOpenLeaderboard('daily');
    };
    // 👻 その日のTOP3のリプレイ。走り終えた直後がいちばん見たい瞬間。
    const gb = m.querySelector('#rGhosts');
    if (gb) gb.onclick = () => { closeModal(); this.destroy(); endToMenu(); openDailyReplays(this.info.day); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startDaily({ ...this.info, played: true }); };
  }

  // ✕ の確認モーダルに出す文面。デイリーの記録回は1日1回きりで、開始時に
  // サーバーへ予約済み ── 1手も置いていなくても、ここで終了するとその日の
  // 記録がこのスコアで確定する。汎用の「ここまでのスコアで記録されます」では
  // 取り返しがつかないことが読み取れない。練習回は何度でも走れるので対象外。
  // （読み手は main.js の ✕ 確認モーダル。所見Q25の quitWarning と同じ口。）
  quitWarning() {
    if (this.practice) return null;
    return t('今日の記録回はこの1回です。ここで終了すると、<b style="color:var(--red)">このスコアで今日の記録が確定</b>します',
      'This is your one recorded run for today — quitting now <b style="color:var(--red)">locks in this score</b>');
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  // ---- 📼 I1 残像レース（this.ghost があるときだけ動く） ----------------
  //
  // 隣のミニ盤面で、選んだ人の走りを実時間で再生する。相手は録画なので
  // 干渉は一切なく、こちらの盤面・シード・お題はふだんのデイリーのまま。

  startGhostRace() {
    const g = this.ghost;
    const rep = g && g.replay;
    if (!rep || !Array.isArray(rep.moves) || !rep.moves.length) { this.ghost = null; return; }
    // 残像の盤面は「同じ種・同じお題」で作り直す。engine.js は決定的なので
    // これだけで録画どおりに再現できる。
    this.ghostEngine = new Engine(this.info.seed);
    applyDailyModifier(this.ghostEngine, this.info.modifier, this.info.seed);
    this.ghostIdx = 0;
    this.ghostScore = 0;
    const panel = $('#oppPanel');
    panel.classList.remove('hidden');
    const cards = $('#oppCards');
    cards.classList.remove('strip', 'compact');
    cards.innerHTML = `
      <div class="opp-card" data-slot="ghost">
        <canvas></canvas>
        <div class="opp-name">${ic('clip', 13)} ${escapeHtml(g.username || t('残像', 'Ghost'))}</div>
        <div class="opp-score" id="ghostScore">0</div>
        <div class="opp-combo" id="ghostDiff"></div>
      </div>`;
    const btn = $('#btnOppDensity');
    if (btn) btn.classList.add('hidden');
    this.ghostBoard = new MiniBoard(cards.querySelector('canvas'));
    this.ghostBoard.setGrid(this.ghostEngine.snapshot());
    getView().resize();
    this.ghostTimer = setTimeout(() => this.ghostStep(), Math.max(200, rep.moves[0].t || 600));
    toast(t(`${g.username || '残像'} の走りと同時対走！`, `Racing ${g.username || 'the ghost'}'s replay!`), 'announce', 2600);
  }

  ghostStep() {
    if (this.ended || !this.ghostEngine) return;
    const rep = this.ghost.replay;
    const mv = rep.moves[this.ghostIdx];
    if (!mv) { this.ghostFinished = true; this.updateGhostHud(); return; }
    // 録画が壊れていても止まらない。打てない手が来たらそこで再生を終える。
    this.ghostEngine.over = false;
    const res = this.ghostEngine.place(mv.h, mv.r, mv.c);
    if (!res) { this.ghostFinished = true; this.updateGhostHud(); return; }
    this.ghostScore = this.ghostEngine.score;
    this.ghostIdx++;
    if (this.ghostBoard) this.ghostBoard.setGrid(this.ghostEngine.snapshot());
    this.updateGhostHud();
    const next = rep.moves[this.ghostIdx];
    // 録画の t（開始からの経過ms）どおりの間合いで進める。極端な間は詰める。
    const wait = next ? Math.min(4000, Math.max(160, (next.t || 0) - (mv.t || 0))) : 0;
    if (next) this.ghostTimer = setTimeout(() => this.ghostStep(), wait);
    else { this.ghostFinished = true; this.updateGhostHud(); }
  }

  updateGhostHud() {
    const sc = $('#ghostScore');
    if (sc) sc.textContent = fmt(this.ghostScore || 0);
    const df = $('#ghostDiff');
    if (!df) return;
    const diff = (this.engine ? this.engine.score : 0) - (this.ghostScore || 0);
    df.textContent = diff >= 0
      ? t(`+${fmt(diff)} リード`, `+${fmt(diff)} ahead`)
      : t(`${fmt(diff)} 差`, `${fmt(diff)} behind`);
    df.style.color = diff >= 0 ? '#6bd97b' : '#ff6b6b';
  }

  stopGhostRace() {
    clearTimeout(this.ghostTimer);
    this.ghostTimer = null;
    this.ghostEngine = null;
    this.ghostBoard = null;
    const cards = $('#oppCards');
    if (cards && cards.querySelector('.opp-card[data-slot="ghost"]')) cards.innerHTML = '';
    $('#oppPanel').classList.add('hidden');
  }

  destroy() {
    this.ended = true;
    this.stopGhostRace();
    // 着手の見張りを次のモードへ持ち越さない。
    if (view) view.onIntentPlace = null;
  }
}

// 挑戦の予約。ログイン中で、まだ今日の記録が無い回だけサーバーに登録する。
//
// ここを通さずに始めていたころ、「引きが悪かったら提出せずリロード」で同じ
// シードを何度でも引き直せた（サーバーは提出を見るまで挑戦を消費しない）。
// 開始時に消費することでその抜け道が閉じる代わりに、放棄＝0点で確定する。
//
// 戻り値: { practice, attemptId } / 日付が変わっていれば null（呼び直す）。
let dailyStarting = false;
async function reserveDailyAttempt(info) {
  // ゲストの記録はサーバーに残らない（localStorage に控えるだけ）ので、
  // 「今日の初回かどうか」もローカルの控えで決める。
  if (!session.user) return { practice: !!dailyLocalRecord(info.day), attemptId: null };
  // 練習だと分かっている回はサーバーに聞かない — 連打で開始のレート制限に
  // 当たると、練習すらできなくなる。
  if (info.played) return { practice: true, attemptId: null };
  const res = await api('/api/daily/start', { method: 'POST', body: { day: info.day } });
  // モーダルを開いたままJST 0:00 を跨いだ。古いシードで走らせても記録できない。
  if (res && res.stale) return null;
  return { practice: !!(res && res.practice), attemptId: (res && res.attemptId) || null };
}

// opts.ghost = { username, score, replay } を渡すと 📼残像レース になる。
// 省略時は従来どおりのデイリー（挙動は完全に同じ）。
export async function startDaily(info, opts = {}) {
  if (dailyStarting) return;   // 「挑戦する」の二度押しで1日を2回消費させない
  dailyStarting = true;
  try {
    let cur = info;
    let attempt = null;
    // 日跨ぎで仕切り直すのは一度だけ。二度目も跨ぐことは無く、
    // 万一サーバーが stale を返し続けても無限ループにしない。
    for (let tries = 0; tries < 2; tries++) {
      try {
        attempt = await reserveDailyAttempt(cur);
      } catch (err) {
        // 予約できなかった回を走らせると、遊んだのに記録されない（あるいは
        // 記録されたか分からない）。走らせる前に止めて理由を見せる。
        toast(err.message || t('デイリーを開始できませんでした', 'Could not start the Daily'), 'err');
        return;
      }
      if (attempt) break;
      // 日付が変わった — 今日のお題を取り直して仕切り直す。
      toast(t('日付が変わりました。今日のお題を読み込みます', 'The day rolled over — loading today\'s challenge'), 'info');
      try {
        cur = await api('/api/daily');
      } catch {
        toast(t('サーバーに接続できません', 'Cannot reach the server'), 'err');
        return;
      }
    }
    if (!attempt) { toast(t('デイリーを開始できませんでした', 'Could not start the Daily'), 'err'); return; }
    if (currentMode) currentMode.destroy();
    currentMode = new DailyMode(cur, { ...attempt, ghost: opts.ghost || null });
    window.__bbaMode = currentMode;
    currentMode.start();
  } finally {
    dailyStarting = false;
  }
}

// ---------------------------------------------------------------------------
// Dungeon tower (PvE roguelite): climb 100 floors. Each floor is a foe with
// HP and periodic garbage attacks; every 10th floor is a boss + checkpoint.
// After each floor you pick 1 of 3 perks that stack for the whole run.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 敵の「系統」対応表
//
// 敵は 4世界 × 10帯 × 5体（雑魚4 ＋ 区画ボス1）＝ 200体いる。ここは画面に
// 残っていた最後の大きな絵文字だった（#bossEmoji は戦闘中いちばん大きい絵で、
// 端末ごとに顔が変わっていた）。200枚描くのは無理、かといって1枚の共通絵に
// まとめると「200体ぜんぶ同じ顔」＝ icons.js が潰した重複の作り直しになる。
//
// そこで敵を**系統**に分け、系統ごとに1枚（icons.js の foe_*）を描き、
// 1体ずつの見分けは「系統アイコン ＋ 帯の色」で付ける。
// 色は foeTint() が「世界 × 階の深さ」から作るので、同じスライムでも
// F1 と B100 では別の色になる（＝強さが色で分かる）。
//
// 系統は下の band 表の**1つ目の欄**に1体ずつ書いてある（以前そこに絵文字が
// 入っていた）。「どの敵がどの系統か」はその表を横に読めば分かる。
// 系統名として書けるのは FOE_FAMILIES の鍵だけ。
//
// 表を作るときの決めごと:
//   ・同じ帯の雑魚4体は**必ず別の系統**にする。同じ帯の敵は色がほとんど同じ
//     なので、系統まで同じだと2体が完全に同じ絵になってしまう。
//   ・区画ボスは雑魚と系統が被ってよい（キングスライム＝スライム系のように、
//     被ることに意味がある）。ボスは色が帯の先へ進むので見分けが付く。
// ---------------------------------------------------------------------------
const FOE_FAMILIES = {
  slime:    { icon: 'foe_slime',    ja: 'スライム系',   en: 'Ooze' },
  beast:    { icon: 'foe_beast',    ja: '獣系',         en: 'Beast' },
  bird:     { icon: 'foe_bird',     ja: '有翼系',       en: 'Winged' },
  bug:      { icon: 'foe_bug',      ja: '蟲系',         en: 'Vermin' },
  crab:     { icon: 'foe_crab',     ja: '甲殻系',       en: 'Crustacean' },
  aqua:     { icon: 'foe_aqua',     ja: '水棲系',       en: 'Aquatic' },
  tentacle: { icon: 'foe_tentacle', ja: '軟体系',       en: 'Tentacled' },
  serpent:  { icon: 'foe_serpent',  ja: '蛇系',         en: 'Serpent' },
  dragon:   { icon: 'foe_dragon',   ja: '竜系',         en: 'Dragon' },
  undead:   { icon: 'foe_undead',   ja: '不死系',       en: 'Undead' },
  ghost:    { icon: 'foe_ghost',    ja: '霊体系',       en: 'Spirit' },
  // 鬼・悪魔系だけは既にある foe_oni を使い回す（同じ顔を2枚描かないため）。
  oni:      { icon: 'foe_oni',      ja: '鬼・悪魔系',   en: 'Demon' },
  angel:    { icon: 'foe_angel',    ja: '天使系',       en: 'Angel' },
  golem:    { icon: 'foe_golem',    ja: '岩石・像系',   en: 'Golem' },
  flame:    { icon: 'foe_flame',    ja: '炎系',         en: 'Flame' },
  frost:    { icon: 'foe_frost',    ja: '氷雪系',       en: 'Frost' },
  storm:    { icon: 'foe_storm',    ja: '雷嵐系',       en: 'Storm' },
  plant:    { icon: 'foe_plant',    ja: '植物・菌系',   en: 'Flora' },
  arcane:   { icon: 'foe_arcane',   ja: '魔術系',       en: 'Arcane' },
  star:     { icon: 'foe_star',     ja: '星辰系',       en: 'Astral' },
  void:     { icon: 'foe_void',     ja: '虚無系',       en: 'Void' },
  blade:    { icon: 'foe_blade',    ja: '武具系',       en: 'Armament' },
  royal:    { icon: 'foe_royal',    ja: '王侯・術者系', en: 'Sovereign' },
  eye:      { icon: 'foe_eye',      ja: '邪眼系',       en: 'Evil Eye' },
  mask:     { icon: 'foe_mask',     ja: '仮面系',       en: 'Masked' },
};

function foeIconName(family) {
  const f = FOE_FAMILIES[family];
  // 知らない系統は placeholder（見慣れない箱）に落とす。ここで「敵の共通
  // アイコン」に落とすと、表を書き間違えても画面上は普通に見えてしまい、
  // 気づけないまま「同じ顔の敵」が増えていく。
  return f && hasIcon(f.icon) ? f.icon : 'placeholder';
}

// 世界ごとの色の道筋。h0 から span ぶん色相を進めながら、彩度と明度も動かす。
// 「深いほど強い」を色だけで言い切るための表なので、
//   ・塔　　… 苔の緑から血の赤へ
//   ・地下　… 苔の黄緑から錆・血・毒の紫へ（明度をいちばん落とす）
//   ・天国　… 空の青から黄金へ（明るいまま色相だけ一周する）
//   ・深淵　… 菫から血の色へ（彩度を上げ、明度を沈める）
// span は 360 を跨いでよい（最後に 0..359 へ畳む）。
const FOE_TINTS = {
  tower:  { h0: 128, span:  232, s0: 54, s1: 70, l0: 62, l1: 54 },
  under:  { h0:  92, span: -142, s0: 46, s1: 64, l0: 56, l1: 44 },
  heaven: { h0: 200, span:  208, s0: 62, s1: 90, l0: 74, l1: 64 },
  abyss:  { h0: 276, span:  104, s0: 48, s1: 76, l0: 54, l1: 40 },
};

const pctClamp = n => Math.max(6, Math.min(94, Math.round(n)));

/**
 * 敵の2色（{ a, b }）を階層の深さから作る。
 *
 * @param realm    DUNGEON_REALMS の1つ
 * @param bandIdx  何番目の帯か（0始まり）
 * @param slot     帯の中で何番目の雑魚か（0始まり。ボスは無視される）
 * @param isBoss   区画ボスか
 *
 * 帯だけでなく帯の中の順番でも少しずつ色が進む。こうしておくと
 * 「同じ帯・同じ系統」が並んでも別の色になるし、色の並びは階数の順のまま
 * （F1 → F100 で一方向に進む）なので「深い色＝強い」が崩れない。
 */
function foeTint(realm, bandIdx, slot, isBoss) {
  const T = FOE_TINTS[realm.id] || FOE_TINTS.tower;
  const bands = Math.max(1, realm.bands.length);
  // 帯の中の位置は 0.1 / 0.3 / 0.5 / 0.7、ボスはいちばん奥の 0.9。
  const step = bandIdx + (isBoss ? 0.9 : Math.min(0.8, slot * 0.2 + 0.1));
  const k = Math.min(1, step / bands);
  const h = ((Math.round(T.h0 + T.span * k) % 360) + 360) % 360;
  const s = T.s0 + (T.s1 - T.s0) * k + (isBoss ? 10 : 0);
  const l = T.l0 + (T.l1 - T.l0) * k + (isBoss ? -4 : 0);
  return {
    a: `hsl(${h}, ${pctClamp(s)}%, ${pctClamp(l)}%)`,
    // 差し色は同じ色相の深い影。形の中の目・牙・輪郭がこれで出る。
    b: `hsl(${h}, ${pctClamp(s + 14)}%, ${pctClamp(l * 0.36)}%)`,
  };
}

const DUNGEON_BANDS = [
  { name: '苔の洞窟',   nameEn: 'Mossy Cave',       board: 'board_forest',  track: 'battle', foes: [['bird', 'コウモリ', 'Bat'], ['beast', '大ネズミ', 'Giant Rat'], ['slime', 'スライム', 'Slime'], ['bug', '毒グモ', 'Venom Spider']], boss: ['slime', 'キングスライム', 'King Slime'] },
  { name: '海底神殿',   nameEn: 'Sunken Temple',    board: 'board_ocean',   track: 'battle', foes: [['tentacle', 'タコ兵', 'Octopus Trooper'], ['crab', '鉄カニ', 'Iron Crab'], ['aqua', 'トゲフグ', 'Spike Puffer'], ['beast', 'サメ傭兵', 'Shark Mercenary']], boss: ['royal', '海の女王', 'Queen of the Sea'] },
  { name: '桜の迷宮',   nameEn: 'Sakura Labyrinth', board: 'board_sakura',  track: 'solo',   foes: [['beast', '妖狐', 'Fox Spirit'], ['serpent', '花蛇', 'Blossom Snake'], ['bug', '幻蝶', 'Phantom Butterfly'], ['bird', '怪鳥', 'Dread Bird']], boss: ['oni', '大天狗', 'Great Tengu'] },
  { name: '黄昏の砂漠', nameEn: 'Twilight Desert',  board: 'board_sunset',  track: 'hard',   foes: [['crab', '大サソリ', 'Giant Scorpion'], ['beast', '護衛ラクダ', 'Guard Camel'], ['bird', 'ハゲタカ', 'Vulture'], ['serpent', '砂大蛇', 'Sand Serpent']], boss: ['royal', 'スフィンクス', 'Sphinx'] },
  { name: '灼熱火山',   nameEn: 'Scorching Volcano', board: 'board_volcano', track: 'hard',  foes: [['flame', '火の精', 'Fire Sprite'], ['serpent', '溶岩トカゲ', 'Lava Lizard'], ['beast', 'マグマ猪', 'Magma Boar'], ['golem', '岩人形', 'Stone Golem']], boss: ['dragon', '火竜グレンド', 'Grend the Fire Dragon'] },
  { name: '氷結洞窟',   nameEn: 'Frozen Cavern',    board: 'board_default', track: 'boss',   foes: [['golem', '雪人形', 'Snow Golem'], ['bird', '氷ペンギン兵', 'Ice Penguin Trooper'], ['aqua', '氷セイウチ', 'Ice Walrus'], ['frost', '氷の精', 'Frost Sprite']], boss: ['beast', 'フロストベア', 'Frost Bear'] },
  { name: '雷雲の頂',   nameEn: 'Thunderhead Peak', board: 'board_galaxy',  track: 'boss',   foes: [['storm', '雷精', 'Storm Sprite'], ['bird', '雷鷲', 'Thunder Eagle'], ['ghost', '雲魔', 'Cloud Fiend'], ['void', '竜巻魔', 'Tornado Fiend']], boss: ['bird', 'サンダーバード', 'Thunderbird'] },
  { name: '亡霊の城',   nameEn: 'Haunted Castle',   board: 'board_oni',     track: 'oni',    foes: [['ghost', '亡霊', 'Wraith'], ['undead', 'スケルトン', 'Skeleton'], ['blade', 'ゾンビ騎士', 'Zombie Knight'], ['bird', '吸血コウモリ', 'Vampire Bat']], boss: ['royal', 'ヴァンパイア卿', 'Lord Vampire'] },
  { name: '鬼の巣窟',   nameEn: 'Oni Den',          board: 'board_oni',     track: 'oni',    foes: [['oni', '赤鬼', 'Red Oni'], ['mask', '青鬼', 'Blue Oni'], ['flame', '鬼火', 'Ghost Flame'], ['undead', '骨武者', 'Bone Samurai']], boss: ['oni', '鬼神ラセツ', 'Rasetsu the Oni God'] },
  { name: '天界の門',   nameEn: 'Heavenly Gate',    board: 'board_kami',    track: 'kami',   foes: [['angel', '堕天使', 'Fallen Angel'], ['blade', '神殿騎士', 'Temple Knight'], ['star', '星霊', 'Star Spirit'], ['arcane', '法陣魔', 'Rune Fiend']], boss: ['oni', '魔神ゼルガドス', 'Zelgados the Demon God'] },
];

// Underground realm (B1–B100): tougher, faster, rubble on every floor.
const UNDER_BANDS = [
  { name: '苔むす地下道', nameEn: 'Mossy Underpass',  board: 'board_forest',  track: 'battle', foes: [['serpent', '大ミミズ', 'Giant Worm'], ['bug', '洞窟蚊', 'Cave Gnat'], ['plant', '毒キノコ', 'Toxic Shroom'], ['slime', '岩ナメクジ', 'Rock Slug']], boss: ['serpent', '地底大蛇', 'Tunnel Serpent'] },
  { name: '忘れられた坑道', nameEn: 'Forgotten Mineshaft', board: 'board_default', track: 'battle', foes: [['ghost', '亡霊坑夫', 'Ghost Miner'], ['bird', '洞窟コウモリ', 'Cave Bat'], ['bug', '坑道グモ', 'Shaft Spider'], ['beast', 'トロル', 'Troll']], boss: ['golem', 'ゴーレム親方', 'Golem Foreman'] },
  { name: '地底湖',       nameEn: 'Sunless Lake',     board: 'board_ocean',   track: 'battle', foes: [['aqua', '盲目魚', 'Blind Fish'], ['crab', '白ザリガニ', 'Pale Crayfish'], ['slime', '洞窟ガエル', 'Cave Toad'], ['tentacle', '地底クラゲ', 'Deep Jelly']], boss: ['dragon', '地底湖の主', 'Lord of the Sunless Lake'] },
  { name: '水晶の洞',     nameEn: 'Crystal Hollow',   board: 'board_galaxy',  track: 'hard',   foes: [['beast', 'クリスタル獣', 'Crystal Beast'], ['star', '光の精', 'Light Wisp'], ['crab', '水晶サソリ', 'Crystal Scorpion'], ['golem', '晶石人形', 'Geode Golem']], boss: ['royal', '水晶の女王', 'Crystal Queen'] },
  { name: '骨の回廊',     nameEn: 'Bone Gallery',     board: 'board_oni',     track: 'boss',   foes: [['undead', '骸骨兵', 'Bone Soldier'], ['beast', '骨犬', 'Bone Hound'], ['ghost', '地縛霊', 'Earthbound Ghost'], ['oni', '屍鬼', 'Ghoul']], boss: ['royal', '骸骨王', 'Skeleton King'] },
  { name: '溶岩脈',       nameEn: 'Lava Vein',        board: 'board_volcano', track: 'hard',   foes: [['bug', 'マグマ虫', 'Magma Grub'], ['serpent', '火蜥蜴', 'Flame Newt'], ['oni', '炎鬼', 'Flame Oni'], ['flame', '噴煙魔', 'Smoke Fiend']], boss: ['dragon', '地竜バルガ', 'Balga the Earth Dragon'] },
  { name: '毒の沼窟',     nameEn: 'Venom Grotto',     board: 'board_forest',  track: 'oni',    foes: [['serpent', '毒蛇', 'Viper'], ['slime', '猛毒スライム', 'Toxic Ooze'], ['bug', '母グモ', 'Brood Spider'], ['crab', '死のサソリ', 'Death Scorpion']], boss: ['dragon', '毒竜ドクロア', 'Dokuroa the Venom Drake'] },
  { name: '静寂の墓所',   nameEn: 'Silent Crypt',     board: 'board_oni',     track: 'oni',    foes: [['ghost', '棺の霊', 'Coffin Wraith'], ['undead', '血吸い', 'Blood Fiend'], ['void', '影人', 'Shade'], ['flame', '呪い火', 'Curse Flame']], boss: ['royal', '墓所の王', 'Crypt King'] },
  { name: '奈落への橋',   nameEn: 'Bridge to the Abyss', board: 'board_galaxy', track: 'kami', foes: [['ghost', '闇の使徒', 'Dark Apostle'], ['bird', '深淵鷲', 'Abyss Eagle'], ['blade', '鎖の獄卒', 'Chain Warden'], ['void', '虚無魔', 'Void Fiend']], boss: ['eye', '奈落の番人', 'Warden of the Abyss'] },
  { name: '深淵の玉座',   nameEn: 'Throne of the Abyss', board: 'board_oni',  track: 'kami',   foes: [['oni', '深淵の魔兵', 'Abyssal Soldier'], ['void', '無貌のもの', 'The Faceless'], ['tentacle', '深淵の触手', 'Abyssal Tendril'], ['undead', '奈落騎士', 'Abyss Knight']], boss: ['eye', '深淵神アビソス', 'Abysos the Abyss God'] },
];

// Heaven realm (H1–H100): slower but heavier attacks; bosses grant blessings.
const HEAVEN_BANDS = [
  { name: '雲の階段',     nameEn: 'Stairway of Clouds', board: 'board_default', track: 'solo', foes: [['beast', '雲ひつじ', 'Cloud Sheep'], ['bird', '白鳩兵', 'Dove Trooper'], ['storm', '風の精', 'Wind Sprite'], ['angel', '鈴天使', 'Chime Cherub']], boss: ['bird', '白鳥の守護者', 'Swan Guardian'] },
  { name: '虹の花園',     nameEn: 'Rainbow Garden',   board: 'board_sakura',  track: 'solo',   foes: [['bug', '虹蝶', 'Rainbow Butterfly'], ['angel', '蜜天蜂', 'Honeybee Cherub'], ['plant', '花の精', 'Flower Sprite'], ['star', '星てんとう', 'Star Ladybug']], boss: ['royal', '花園の女王', 'Queen of the Garden'] },
  { name: '星屑の橋',     nameEn: 'Stardust Bridge',  board: 'board_galaxy',  track: 'battle', foes: [['star', '星の子', 'Starling'], ['beast', '流星獣', 'Meteor Beast'], ['arcane', '環の精', 'Ring Spirit'], ['ghost', '光塵魔', 'Gleam Fiend']], boss: ['royal', '星織りの賢者', 'Sage of Woven Stars'] },
  { name: '月光の泉',     nameEn: 'Moonlit Spring',   board: 'board_ocean',   track: 'solo',   foes: [['beast', '月ウサギ', 'Moon Rabbit'], ['angel', '泡天使', 'Bubble Cherub'], ['aqua', '天空イルカ', 'Sky Dolphin'], ['bird', '月孔雀', 'Moon Peacock']], boss: ['royal', '月の巫女', 'Priestess of the Moon'] },
  { name: '審判の間',     nameEn: 'Hall of Judgment', board: 'board_kami',    track: 'boss',   foes: [['golem', '天秤の番人', 'Scale Keeper'], ['arcane', '律法の霊', 'Law Spirit'], ['blade', '裁きの剣', 'Judging Blade'], ['eye', '監視者', 'The Watcher']], boss: ['beast', '審判者レオン', 'Leon the Adjudicator'] },
  { name: '竪琴の雲海',   nameEn: 'Sea of Harp Clouds', board: 'board_sunset', track: 'kami',  foes: [['arcane', '音符精', 'Note Sprite'], ['angel', 'ラッパ天使', 'Trumpet Cherub'], ['beast', '有翼獅子', 'Winged Lion'], ['bird', '聖鳩', 'Holy Dove']], boss: ['royal', '大聖歌長', 'Grand Cantor'] },
  { name: '黄金の大聖堂', nameEn: 'Golden Cathedral', board: 'board_kami',    track: 'kami',   foes: [['blade', '聖堂騎士', 'Cathedral Knight'], ['golem', '光の衛兵', 'Light Sentinel'], ['flame', '聖火の精', 'Sacred Flame'], ['arcane', '祈りの霊', 'Prayer Spirit']], boss: ['angel', '大天使ミカエラ', 'Archangel Michaela'] },
  { name: '天雷の峰',     nameEn: 'Peak of Holy Thunder', board: 'board_galaxy', track: 'oni', foes: [['storm', '天雷精', 'Skybolt Sprite'], ['bird', '神鷲', 'Divine Eagle'], ['arcane', '雷雲魔', 'Storm Halo'], ['blade', '雷槍兵', 'Thunder Lancer']], boss: ['bird', '不死鳥フェニクス', 'Phoenix'] },
  { name: '神々の回廊',   nameEn: 'Corridor of the Gods', board: 'board_kami', track: 'kami',  foes: [['golem', '神像兵', 'Idol Soldier'], ['beast', '聖獣ユニコーン', 'Unicorn'], ['dragon', '天竜', 'Sky Dragon'], ['angel', '熾天使', 'Seraph']], boss: ['royal', '虹神殿の主', 'Master of the Rainbow Shrine'] },
  { name: '創造の玉座',   nameEn: 'Throne of Creation', board: 'board_kami',  track: 'kami',   foes: [['angel', '大熾天使', 'High Seraph'], ['star', '太陽の化身', 'Avatar of the Sun'], ['ghost', '星幽体', 'Astral Being'], ['royal', '王冠の霊', 'Crown Spirit']], boss: ['star', '至高神ルミナス', 'Luminus the Supreme'] },
];

// 🌑 The Abyss — the hardest realm. Unlocked by conquering the tower.
const ABYSS_BANDS = [
  { name: '忘却の入口',   nameEn: 'Gate of Oblivion',   board: 'board_oni',     track: 'oni',  foes: [['flame', '消えかけの灯', 'Dying Light'], ['bird', '影蝙蝠', 'Shade Bat'], ['ghost', '墓守', 'Gravekeeper'], ['serpent', '黒蛇', 'Black Serpent']], boss: ['undead', '忘却の番人', 'Warden of Oblivion'] },
  { name: '嘆きの回廊',   nameEn: 'Corridor of Lament', board: 'board_oni',     track: 'oni',  foes: [['ghost', '嘆きの霊', 'Lamenting Spirit'], ['bug', '毒蜘蛛', 'Venom Spider'], ['blade', '錆びた鍵守', 'Rusted Keyholder'], ['void', '瘴気', 'Miasma']], boss: ['royal', '嘆きの王', 'King of Lament'] },
  { name: '血の沼',       nameEn: 'Blood Marsh',        board: 'board_volcano', track: 'oni',  foes: [['slime', '血の滴', 'Blood Drop'], ['aqua', '沼の顎', 'Marsh Jaw'], ['undead', '吸血鬼', 'Vampire'], ['bug', '吸血蚊の群れ', 'Mosquito Swarm']], boss: ['dragon', '血竜ヴァルグ', 'Valg the Blood Dragon'] },
  { name: '虚無の階段',   nameEn: 'Stairs of the Void', board: 'board_cyber',   track: 'kami', foes: [['golem', '虚無の欠片', 'Void Shard'], ['arcane', '歪み', 'Distortion'], ['eye', '無の眼', 'Eye of Nothing'], ['void', '落とし穴', 'Pitfall']], boss: ['royal', '虚無の支配者', 'Master of the Void'] },
  { name: '狂気の鏡殿',   nameEn: 'Hall of Mad Mirrors', board: 'board_cyber',  track: 'oni',  foes: [['ghost', '鏡像', 'Mirror Image'], ['mask', '狂道化', 'Mad Jester'], ['oni', '二面鬼', 'Two-Faced Oni'], ['arcane', '惑わしの珠', 'Orb of Delusion']], boss: ['royal', '狂王ジョーカー', 'The Mad Joker'] },
  { name: '氷獄',         nameEn: 'Frozen Hell',        board: 'board_snow',    track: 'oni',  foes: [['undead', '氷の亡者', 'Frozen Wraith'], ['beast', '氷狼', 'Ice Wolf'], ['frost', '吹雪の精', 'Blizzard Sprite'], ['golem', '凍てつく像', 'Frozen Idol']], boss: ['royal', '氷獄の魔女', 'Witch of Frozen Hell'] },
  { name: '灼熱の底',     nameEn: 'Scorched Depths',    board: 'board_volcano', track: 'oni',  foes: [['slime', '溶岩魔', 'Lava Fiend'], ['beast', '噴火獣', 'Eruption Beast'], ['dragon', '火蜥蜴', 'Fire Lizard'], ['flame', '爆炎の精', 'Blast Sprite']], boss: ['oni', '灼熱鬼イフリート', 'Ifrit the Scorching'] },
  { name: '星喰いの巣',   nameEn: 'Nest of the Star-Eater', board: 'board_galaxy', track: 'kami', foes: [['bug', '星の糸', 'Star Silk'], ['tentacle', '宇宙蛸', 'Cosmic Squid'], ['star', '落星', 'Fallen Star'], ['void', '暗黒球', 'Dark Sphere']], boss: ['tentacle', '星喰いヨグ', 'Yog the Star-Eater'] },
  { name: '神殺しの祭壇', nameEn: 'Altar of Godslaying', board: 'board_kami',   track: 'kami', foes: [['angel', '堕天騎士', 'Fallen Knight'], ['blade', '弑逆の刃', 'Regicide Blade'], ['arcane', '異端僧', 'Heretic Monk'], ['bird', '黒翼', 'Black Wing']], boss: ['oni', '堕神ルシファル', 'Lucifal the Fallen'] },
  { name: '深淵の玉座',   nameEn: 'Throne of the Abyss', board: 'board_oni',    track: 'kami', foes: [['eye', '深淵の視線', 'Gaze of the Abyss'], ['star', '終焉の兆し', 'Omen of the End'], ['void', '奈落', 'Naraka'], ['ghost', '無慈悲', 'Mercilessness']], boss: ['royal', '深淵王アビスゼロ', 'Abyss Zero, King of the Deep'] },
];

// 表を書き間違えても画面は「見慣れない箱」が出るだけで、遊べてしまう。
// 読み込み時に一度だけ突き合わせて、間違いを console に出しておく。
// （このファイルは DOM 前提なのでテストから import できない ── 気づける口が
//   ここ以外に無い。正しいときは何も言わないので、普段は静かなまま）
{
  const bad = new Set();
  for (const bands of [DUNGEON_BANDS, UNDER_BANDS, HEAVEN_BANDS, ABYSS_BANDS]) {
    for (const band of bands) {
      for (const [family] of [...band.foes, band.boss]) {
        if (!FOE_FAMILIES[family] || !hasIcon(FOE_FAMILIES[family].icon)) bad.add(family);
      }
      // 同じ帯の雑魚が同じ系統だと、色もほぼ同じなので2体が同じ絵になる。
      const fams = band.foes.map(f => f[0]);
      if (new Set(fams).size !== fams.length) bad.add(`${band.name}:雑魚の系統が重複`);
    }
  }
  if (bad.size) console.warn('[dungeon] 系統の対応表がおかしい:', [...bad].join(', '));
}

// One curse per Abyss floor (deterministic, so a floor feels like "that floor").
const ABYSS_CURSES = [
  { id: 'none', w: 3 },
  { id: 'noreroll', name: '封印の呪い', nameEn: 'Curse of Sealing',    desc: 'このフロアはリロール不可', descEn: 'No rerolls on this floor', w: 2 },
  { id: 'mini',     name: '矮小の呪い', nameEn: 'Curse of Dwindling',  desc: '極小ピースしか来ない', descEn: 'Only tiny pieces', w: 2 },
  { id: 'big',      name: '巨大の呪い', nameEn: 'Curse of Bulk',       desc: '大型ピースしか来ない', descEn: 'Only big pieces', w: 2 },
  { id: 'rain',     name: '瓦礫の雨',   nameEn: 'Rubble Rain',         desc: '8秒ごとにお邪魔が2個降る', descEn: '2 garbage cells every 8s', w: 2 },
  { id: 'haste',    name: '加速の呪い', nameEn: 'Curse of Haste',      desc: '敵の攻撃が30%速い', descEn: 'Attacks 30% faster', w: 2 },
  { id: 'blind',    name: '盲目の呪い', nameEn: 'Curse of Blindness',  desc: '敵のHPが見えない', descEn: 'Enemy HP is hidden', w: 1 },
  { id: 'greed',    name: '強欲の呪い', nameEn: 'Curse of Greed',      desc: '与ダメージ半減', descEn: 'Half damage dealt', w: 1 },
];

function abyssCurse(f, isBoss) {
  let h = (f * 2654435761) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  const pool = ABYSS_CURSES.filter(c => !(isBoss && c.id === 'greed'));
  const total = pool.reduce((a, c) => a + c.w, 0);
  let x = (h >>> 0) % total;
  for (const c of pool) { x -= c.w; if (x < 0) return c; }
  return pool[0];
}

// Realm definitions: the tower is the classic; the others remix the rules.
const DUNGEON_REALMS = {
  tower: {
    id: 'tower', iconName: 'badge_dungeon', name: 'ダンジョン塔', nameEn: 'Dungeon Tower',
    prefix: 'F', floors: 100, bands: DUNGEON_BANDS,
    hpMult: 1, atkSecMult: 1, extraAtkCells: 0,
    // statKey = サーバー側の到達階の欄（server/index.js の realm 表と同じもの）。
    // モード内の best() が localStorage とこれの最大を取るために使う。
    bestKey: 'bba_dungeon_max', statKey: 'dungeonMax', resultMode: 'dungeon',
    desc: '王道の100階。10階ごとにボス＆チェックポイント',
    descEn: 'The classic 100-floor climb. Boss + checkpoint every 10 floors',
  },
  under: {
    id: 'under', iconName: 'badge_under', name: '地下ダンジョン', nameEn: 'Underground Depths',
    prefix: 'B', floors: 100, bands: UNDER_BANDS,
    hpMult: 1.25, atkSecMult: 0.85, extraAtkCells: 0, startGarbage: true,
    bestKey: 'bba_dungeon_under_max', statKey: 'underMax', resultMode: 'dungeon_under',
    desc: '上級者向け。敵が硬く攻撃も速い。毎フロア、床にガレキが積もっている…',
    descEn: 'For veterans: tougher foes, faster attacks, and rubble litters every floor…',
  },
  heaven: {
    id: 'heaven', iconName: 'badge_heaven', name: '天国ダンジョン', nameEn: 'Heavenly Ascent',
    prefix: 'H', floors: 100, bands: HEAVEN_BANDS,
    hpMult: 0.9, atkSecMult: 1.15, extraAtkCells: 1, blessing: true,
    bestKey: 'bba_dungeon_heaven_max', statKey: 'heavenMax', resultMode: 'dungeon_heaven',
    desc: '攻撃はゆっくり大ぶり。ボスを倒すたび「天使の祝福」で残機+1',
    descEn: "Slow but heavy attacks. Every boss grants an angel's blessing: +1 life",
  },
  abyss: {
    id: 'abyss', iconName: 'badge_abyss', name: '深淵ダンジョン', nameEn: 'The Abyss',
    prefix: 'A', floors: 100, bands: ABYSS_BANDS,
    hpMult: 1.7, atkSecMult: 0.6, extraAtkCells: 2, startGarbage: true, garbageBase: 5, garbageDiv: 15,
    bossEvery: 5, finalMult: 4, curses: true, phases: true, unlock: 'tower100',
    bestKey: 'bba_dungeon_abyss_max', statKey: 'abyssMax', resultMode: 'dungeon_abyss',
    desc: '過去最難関。5階ごとにボス、毎フロアに呪い、最深部には三段階の魔神。塔100F制覇者のみ挑める',
    descEn: 'The hardest realm: a boss every 5 floors, a curse on every floor, a three-phase demon at the bottom. Tower conquerors only',
  },
};

function dungeonFloor(f, realm = DUNGEON_REALMS.tower) {
  const bands = realm.bands;
  const bandIdx = Math.min(bands.length - 1, Math.floor((f - 1) / 10));
  const band = bands[bandIdx];
  const isBoss = f % (realm.bossEvery || 10) === 0;
  const isFinal = f === realm.floors;
  const slot = (f - 1) % band.foes.length;
  const [family, name, nameEn] = isBoss ? band.boss : band.foes[slot];
  let hp = Math.round((260 + f * 95 + f * f * 1.15) * realm.hpMult);
  if (isBoss) hp = Math.round(hp * (isFinal ? (realm.finalMult || 3) : 2.1));
  const atkSec = Math.max(4.5, (15 - f * 0.09) * realm.atkSecMult) * (isBoss ? 1.25 : 1);
  const atkCells = Math.min(8, 1 + Math.floor(f / 12) + (isBoss ? 2 : 0) + realm.extraAtkCells);
  // 敵の顔は「系統アイコン ＋ 階の深さで決まる色」。
  // 深淵の最下層（深淵王アビスゼロ）だけは物語の主役なので専用の絵があり、
  // その絵は色まで含めて描いてあるので tint を当てない（null）。
  const special = realm.id === 'abyss' && isFinal;
  const iconName = special ? bossIconName('abysszero') : foeIconName(family);
  const tint = special ? null : foeTint(realm, bandIdx, slot, isBoss);
  return { floor: f, band, bandIdx, isBoss, isFinal, family, iconName, tint, name, nameEn, hp, atkSec, atkCells };
}

const DUNGEON_PERKS = [
  { id: 'atk',    iconName: 'perk_atk', name: '攻撃力アップ',     nameEn: 'Attack Up',     desc: '与ダメージ +60%（重ねがけOK）', descEn: '+60% damage (stacks)', w: 5 },
  { id: 'reroll', iconName: 'perk_reroll', name: 'リロール補充',     nameEn: 'Reroll Refill', desc: 'リロール +3回', descEn: '+3 rerolls', w: 4 },
  { id: 'heal',   iconName: 'perk_heal', name: '応急修理',         nameEn: 'Field Repair',  desc: '下2行とお邪魔ブロックを消す', descEn: 'Clears the bottom 2 rows + all garbage', w: 4 },
  { id: 'slow',   iconName: 'perk_slow', name: 'スロウの呪文',     nameEn: 'Slow Spell',    desc: '敵の攻撃間隔 +25%（重ねがけOK）', descEn: 'Enemy attacks 25% slower (stacks)', w: 3 },
  { id: 'life',   iconName: 'perk_life', name: '追加ライフ',       nameEn: 'Extra Life',    desc: '残機 +1（ボードが埋まっても復活）', descEn: '+1 life (revive when the board fills)', w: 2 },
  { id: 'shield', iconName: 'perk_shield', name: 'コンボプロテクト', nameEn: 'Combo Protect', desc: 'コンボが途切れなくなる（永続）', descEn: 'Your combo never breaks (permanent)', w: 2 },
];

function pickPerks(mode) {
  const bag = DUNGEON_PERKS.filter(p => !(p.id === 'shield' && mode.engine.streakShield));
  const out = [];
  while (out.length < 3 && bag.length) {
    const total = bag.reduce((a, p) => a + p.w, 0);
    let roll = Math.random() * total;
    let idx = bag.length - 1;
    for (let i = 0; i < bag.length; i++) { roll -= bag[i].w; if (roll <= 0) { idx = i; break; } }
    out.push(bag.splice(idx, 1)[0]);
  }
  return out;
}

class DungeonMode {
  constructor(startFloor = 1, realmId = 'tower') {
    this.mode = 'dungeon';
    this.realm = DUNGEON_REALMS[realmId] || DUNGEON_REALMS.tower;
    // 開始階の上限は「最後のチェックポイント」＝ボス1区間ぶんは必ず登らせる。
    // 10刻みを決め打ちしていたので、深淵（bossEvery: 5）で最後の A96 を選ぶと
    // 黙って A91 に落とされ、選んだ階と違う階から始まっていた。
    const step = this.realm.bossEvery || 10;
    this.startFloor = Math.max(1, Math.min(this.realm.floors - step + 1, startFloor));
    this.floor = this.startFloor;
    this.lives = 1;
    this.atkSlow = 1;   // >1 = slower enemy attacks (perk)
  }

  // localStorage だけだと、別端末や localStorage を消したあとに到達階が 0 に
  // 見えて、実際には更新していないのに「最深記録更新」相当の表示が出る。
  // サーバーは4つの世界すべてを記録している（realm.statKey）ので統合する。
  best() {
    const local = Number(localStorage.getItem(this.realm.bestKey) || 0);
    const key = this.realm.statKey;
    const srv = key && session.user && session.user.stats ? Number(session.user.stats[key] || 0) : 0;
    return Math.max(local, srv);
  }
  // 控えの書き込みは localStorage 単体と比べる（サーバーの方が高いときに
  // 端末側の控えが永久に更新されなくなるのを防ぐ）。
  setBest(v) { if (v > Number(localStorage.getItem(this.realm.bestKey) || 0)) localStorage.setItem(this.realm.bestKey, String(v)); }

  // Underground floors start half-buried in rubble.
  realmFloorStart() {
    if (!this.realm.startGarbage) return;
    const n = (this.realm.garbageBase || 3) + Math.floor(this.floor / (this.realm.garbageDiv || 25));
    this.engine.addGarbage(n);
    if (this.engine.over && !this.engine.hasAnyMove()) { this.engine.reviveBoard(); }
    else this.engine.over = false;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#bossPanel').classList.remove('hidden', 'slim');
    document.querySelector('.boss-atkbar').classList.remove('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    // Checkpoint head start: rough stand-in for the perks a fresh run would
    // have accumulated by this floor.
    // 刻み幅はレルムごと（深淵は bossEvery: 5）。ここだけ 10 の決め打ちだったので、
    // 深淵で A6〜A10 から再開した人はボーナスが**ゼロ**、以降も2つのチェック
    // ポイントで同じ強化になっていた。選択画面の「強化ボーナス付き」の表示とも
    // 食い違う。ボーナスは「そこまでに通ったであろうボスの数」の代わりなので、
    // そのレルムのボス間隔で数えるのが正しい（深淵はボスが倍あるぶん多く付く）。
    const step = this.realm.bossEvery || 10;
    const k = Math.floor((this.startFloor - 1) / step);
    if (k > 0) {
      this.engine.scoreMult = 1 + 0.35 * k;
      this.engine.rerolls += k;
      this.lives += Math.floor(k / 3);
    }
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.loadFloor(this.floor, true);
    this.realmFloorStart();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    const R = this.realm;
    // 文面は「再開かどうか」で決める（ボーナスの有無ではない）。k で分岐して
    // いたので、ボーナスが 0 になる階から再開した人には「挑戦開始！」と出て、
    // 1階からやり直しに見えていた。
    toast(this.startFloor > 1
      ? t(`${R.prefix}${this.startFloor} から再開！${k > 0 ? '（強化ボーナス付き）' : ''}`,
        `Resuming from ${R.prefix}${this.startFloor}!${k > 0 ? ' (bonus perks included)' : ''}`)
      : t(`${R.name}に挑戦開始！${R.prefix}${R.floors}を目指せ！`, `${R.nameEn} begins! Reach ${R.prefix}${R.floors}!`), 'announce', 2600);
    countdownOverlay(3, afterCountdown(this, () => {
      v.inputLocked = false;
      this.armAttack();
    }), audio);
  }

  loadFloor(f, silent) {
    this.info = dungeonFloor(f, this.realm);
    this.hp = this.info.hp;
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: this.info.band.board });
    audio.playTrack(this.info.band.track);
    // 系統の絵に、その階の色をかぶせる（深淵王だけは tint が null＝専用の色）。
    setBossFace($('#bossEmoji'), this.info.iconName, 40, this.info.tint);
    $('#bossName').textContent = t(`${this.realm.prefix}${f} ${this.info.band.name}：${this.info.name}`, `${this.realm.prefix}${f} ${this.info.band.nameEn}: ${this.info.nameEn}`);
    this.phase = 1;
    this.applyCurse(f);
    this.updateHpBar();
    this.updateHud();
    if (silent) return;
    if (this.info.isFinal) {
      toast(t(`最深部——${this.info.name}が待ち受ける！！`, `The last floor — ${this.info.nameEn} awaits!!`), 'announce', 3000);
      audio.bossAttack();
      v.shake = 16;
    } else if (this.info.isBoss) {
      toast(t(`ボス階！${this.info.name}が立ちはだかる！`, `Boss floor! ${this.info.nameEn} blocks your path!`), 'announce', 2400);
      audio.bossAttack();
      v.shake = 12;
    } else {
      toast(t(`${this.info.name}が あらわれた！`, `${this.info.nameEn} appears!`), '', 1400);
    }
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const curse = this.curse ? ABYSS_CURSES.find(c => c.id === this.curse) : null;
    $('#hudSub').textContent = `${this.realm.prefix}${this.floor}/${this.realm.floors}`
      + t(` ・ 残機×${this.lives}`, ` ・ Lives×${this.lives}`)
      + (this.engine.scoreMult > 1 ? t(` ・ 攻×${this.engine.scoreMult.toFixed(1)}`, ` ・ Atk×${this.engine.scoreMult.toFixed(1)}`) : '')
      + (curse ? t(` ・ 呪い：${curse.name}`, ` ・ Curse: ${curse.nameEn || curse.name}`) : '');
  }

  updateHpBar() {
    const blind = this.curse === 'blind';
    const pct = Math.max(0, (this.hp / this.info.hp) * 100);
    // 🕶 盲目の呪いは「敵のHPが見えない」。数字だけ伏せてバーの長さを正確に
    //    出していたので、呪いが実質何もしていなかった（バーを見れば残量が
    //    分かるし、与ダメージのフロート表示を足しても分かる）。
    //    バーは満タンのまま固定し、フロート表示も伏せる。8種の呪いのうち
    //    1つが丸ごと機能していない状態を、深淵の売り（毎フロアに呪い）として
    //    放っておかない。
    $('#bossHp').style.width = blind ? '100%' : `${pct}%`;
    $('#bossHpText').textContent = blind ? '？？？ / ？？？' : `${fmt(Math.max(0, this.hp))} / ${fmt(this.info.hp)}`;
  }

  damageFloat(dmg, big) {
    const span = document.createElement('span');
    span.className = `dmg-float ${big ? 'big' : ''}`;
    // 呪いで隠しているときは数字も出さない（足せば残量が読めてしまう）。
    span.textContent = this.curse === 'blind' ? '-???' : `-${fmt(dmg)}`;
    span.style.left = `${30 + Math.random() * 40}%`;
    $('#bossPanel').appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  armAttack() {
    clearInterval(this.atkInt);
    this.nextAtk = Date.now() + this.atkMs();
    this.atkInt = setInterval(() => this.tickAttack(), 100);
  }

  atkMs() { return this.info.atkSec * 1000 * this.atkSlow * (this.curseHaste || 1); }

  tickAttack() {
    if (this.ended || this.perkOpen) return;
    const total = this.atkMs();
    const remain = Math.max(0, this.nextAtk - Date.now());
    $('#bossAtkBar').style.width = `${(1 - remain / total) * 100}%`;
    if (remain <= 0) {
      this.nextAtk = Date.now() + total;
      this.attack();
    }
  }

  attack() {
    if (this.ended || !this.engine || view.inputLocked) return;
    const cells = this.engine.addGarbage(this.info.atkCells);
    audio.bossAttack();
    const em = $('#bossEmoji');
    em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
    }
    view.shake = 10;
    // トーストは textContent なので SVG を差し込めない（dom.js の toast()）。
    // 絵文字を頭に付けていた名残りは落として、名前だけを出す。
    toast(t(`${this.info.name}の攻撃！`, `${this.info.nameEn} attacks!`), 'err', 1100);
    if (this.engine.over) this.onTopOut();
  }

  onPlace(result) {
    this.updateHud();
    const dmg = this.curseGreed ? Math.ceil(result.gained / 2) : result.gained;
    this.hp -= dmg;
    this.updateHpBar();
    this.damageFloat(dmg, result.lineCount > 0);
    this.checkPhases();
    if (result.lineCount > 0) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
    if (this.hp <= 0 && !this.ended) this.floorCleared();
  }

  // ---- Abyss: a curse on every floor + a three-phase final boss ----
  applyCurse(f) {
    clearInterval(this.rainInt);
    const e = this.engine;
    // 封印（noreroll）明けは「戻す」だけでは足りなかった。
    //  ・Math.max で戻していたので、封印フロアの報酬に「🔄リロール補充(+3)」を
    //    選ぶと ── 適用時点はまだ封印中で e.rerolls は 0、0+3=3 ── 次フロアで
    //    max(3, 控え) になり、控えが3以下なら丸ごと消えていた。加算に変え、
    //    控えは使い切りにする。
    //  ・掛ける側にしか updateRerollHud が無く、明けても HUD は 🔄0 の灰色
    //    （#btnReroll.off）のまま。実際には押せるのに押せないように見え、
    //    ランが終わるまで直らなかった。
    if (this.curse === 'noreroll') {
      e.rerolls += this.savedRerolls || 0;
      this.savedRerolls = 0;
      updateRerollHud(e);
    }
    this.curse = null; this.curseHaste = 1; this.curseGreed = false;
    e.chaosMini = false; e.chaosBig = false;
    if (!this.realm.curses) return;
    const pick = abyssCurse(f, this.info.isBoss);
    if (!pick || pick.id === 'none') { $('#hudSub').classList.remove('cursed'); return; }
    this.curse = pick.id;
    switch (pick.id) {
      case 'noreroll': this.savedRerolls = e.rerolls; e.rerolls = 0; updateRerollHud(e); break;
      case 'mini': e.chaosMini = true; break;
      case 'big': e.chaosBig = true; break;
      case 'haste': this.curseHaste = 0.7; break;
      case 'greed': this.curseGreed = true; break;
      case 'rain':
        this.rainInt = setInterval(() => {
          if (this.ended || this.perkOpen || getView().inputLocked) return;
          const cells = e.addGarbage(2);
          const v = getView();
          for (const [r, c] of cells) { v.spawnAnim.set(r * 8 + c, v.time); v.particles.burstCell(v.boardX + (c + 0.5) * v.cell, v.boardY + (r + 0.5) * v.cell, v.cell, 9, 'fx_default'); }
          if (e.over) this.onTopOut();
        }, 8000);
        break;
      default: break;
    }
    toast(t(`呪い ── ${pick.name}：${pick.desc}`, `Curse — ${pick.nameEn}: ${pick.descEn}`), 'err', 2400);
    this.updateHpBar();
  }

  checkPhases() {
    if (!this.realm.phases || !this.info.isFinal || this.hp <= 0) return;
    const pct = this.hp / this.info.hp;
    const phase = pct < 0.33 ? 3 : pct < 0.66 ? 2 : 1;
    const prev = this.phase || 1;
    if (phase > prev) {
      this.phase = phase;
      const v = getView();
      // 一撃で複数段階を跨いでも、各形態の加速・お邪魔・演出を段階ごとに適用する。
      // （HP66%超から一撃で33%未満へ削ると 1→3 に飛び、以前は0.72が1回・お邪魔6個で
      //   済み第二形態演出も出なかった。段階ごとに 0.72² と 4+6 個を掛ける。）
      for (let p = prev + 1; p <= phase; p++) {
        this.atkSlow *= 0.72;
        const cells = this.engine.addGarbage(p === 3 ? 6 : 4);
        for (const [r, c] of cells) v.spawnAnim.set(r * 8 + c, v.time);
        toast(p === 3
          ? t(`${this.info.name}が真の姿に…！！攻撃がさらに加速！`, `${this.info.nameEn} reveals its true form!! Even faster attacks!`)
          : t(`${this.info.name}が第二形態に！攻撃が加速する！`, `${this.info.nameEn} enters phase 2! Attacks speed up!`), 'announce', 2800);
      }
      v.shake = 18; v.screenFlash = 0.5; audio.bossAttack();
      $('#bossEmoji').classList.add('boss-atk');
      this.armAttack();
      if (this.engine.over) this.onTopOut();
    }
  }

  floorCleared() {
    clearInterval(this.atkInt);
    audio.bossDefeated();
    $('#bossEmoji').classList.add('boss-dead');
    // Progressive best: floors cleared count even if the run ends later.
    this.setBest(this.floor);
    if (this.floor >= this.realm.floors) { this.finish(true); return; }
    confettiBurst(this.info.isBoss ? 45 : 12);
    if (this.info.isBoss) {
      toast(t(`ボス撃破！チェックポイント到達（次回から${this.realm.prefix}${this.floor + 1}で再開可能）`, `Boss down! Checkpoint reached (you can restart from ${this.realm.prefix}${this.floor + 1})`), 'announce', 3000);
      if (this.realm.blessing) {
        this.lives++;
        setTimeout(() => toast(t('天使の祝福！残機 +1', "An angel's blessing! +1 life"), 'announce', 2400), 1200);
      }
    }
    view.inputLocked = true;
    this.perkOpen = true;
    this.offerPerk(() => {
      this.perkOpen = false;
      this.floor++;
      this.loadFloor(this.floor);
      this.realmFloorStart();
      const e = this.engine;
      // Mercy: never enter a floor without a legal move.
      if (!e.hasAnyMove()) { e.reviveBoard(); view.reviveFlash(); }
      else e.over = false;
      view.inputLocked = false;
      this.updateHud();
      this.armAttack();
    });
  }

  offerPerk(next) {
    const choices = pickPerks(this);
    const m = showModal(`
      ${/* 🗺 領域の記号を使う。ここだけ「F」を直書きしていたので、地下(B)・
            天国(H)・深淵(A)でも塔の記号が出ていた。非ボス階のたびに出るので、
            地下100階なら1周で90回この食い違いを見ることになる。
            同じクラスの他の表示（4456・4472・4497 ほか）はすべて realm.prefix。 */''}
      <h2>${ic('check', 20)} ${this.info.isBoss ? t('ボス撃破！', 'Boss defeated!') : t(`${this.realm.prefix}${this.floor} クリア！`, `Floor ${this.floor} cleared!`)}</h2>
      <p class="muted center" style="margin-bottom:10px">${t('ごほうびを1つ選ぼう', 'Pick one reward')}</p>
      <div class="form-col">
        ${choices.map(p => `
          <button class="btn btn-ghost perk-btn" data-perk="${p.id}">
            <span class="perk-icon">${ic(p.iconName, 26)}</span>
            <span class="perk-body"><b>${t(p.name, p.nameEn)}</b><small>${t(p.desc, p.descEn)}</small></span>
          </button>`).join('')}
      </div>`, { dismissable: false });
    m.querySelectorAll('[data-perk]').forEach(b => {
      b.onclick = () => { this.applyPerk(b.dataset.perk); closeModal(); next(); };
    });
    // Autopilot keeps climbing on its own — it grabs a perk and moves on.
    if (autopilot.on && autopilot.autoPerks !== false) {
      setTimeout(() => {
        const b = m.querySelector('[data-perk]');
        if (b && document.body.contains(b)) b.click();
      }, 800);
    }
  }

  applyPerk(id) {
    const e = this.engine;
    audio.coin();
    switch (id) {
      case 'atk':
        e.scoreMult = Math.round((e.scoreMult + 0.6) * 100) / 100;
        break;
      case 'reroll':
        e.rerolls += 3;
        updateRerollHud(e);
        break;
      case 'heal': {
        for (let i = 0; i < 64; i++) if (e.grid[i] === 9) e.grid[i] = 0;
        for (let r = 6; r < 8; r++) for (let c = 0; c < 8; c++) e.grid[r * 8 + c] = 0;
        view.reviveFlash();
        break;
      }
      case 'slow':
        this.atkSlow *= 1.25;
        break;
      case 'life':
        this.lives++;
        break;
      case 'shield':
        e.streakShield = true;
        break;
    }
    this.updateHud();
  }

  // 戻り値 true ＝「復活したので死亡音は鳴らさないで」（game.js の handleOver）。
  onTopOut() {
    if (this.ended || this.perkOpen) return true;
    if (autoRescue()) return true;   // autopilot 5.0 guard — before spending a life
    if (this.lives > 1) {
      this.lives--;
      this.engine.reviveBoard();
      getView().reviveFlash();
      toast(t(`残機を使って復活！のこり×${this.lives}`, `Life used — revived! ×${this.lives} left`), 'announce', 2200);
      this.updateHud();
      return true;
    }
    // finish(false) が自分で死亡音を鳴らすので、ここでは鳴らさせない（true）。
    this.finish(false);
    return true;
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.atkInt);
    clearInterval(this.rainInt);
    getView().inputLocked = true;
    const R = this.realm;
    const cleared = won ? R.floors : this.floor - 1;
    this.setBest(cleared);
    if (won) {
      audio.victory();
      confettiBurst(100);
      $('#bossEmoji').classList.add('boss-dead');
    } else if (!this.aborted) {
      audio.gameOver();
    }
    const e = this.engine;
    const rewards = await submitResult({
      mode: R.resultMode, floor: cleared, score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won,
      // Floors beaten in THIS run (missions count progress, not absolute depth).
      floors: Math.max(0, cleared - this.startFloor + 1),
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    // 以前は 'dungeon' 決め打ちだったので、深淵・地下・天国を制覇しても
    // 専用の祝いが出なかった。世界ごとの名前とジェム額をそのまま出す。
    const CLEAR_BADGE = {
      dungeon: { ja: '百塔踏破', en: 'Hundred-Floor Conqueror', gems: 500 },
      under:   { ja: '地底踏破', en: 'Depths Conqueror',        gems: 750 },
      heaven:  { ja: '天界踏破', en: 'Ascent Conqueror',        gems: 500 },
      abyss:   { ja: '深淵踏破', en: 'Abyss Conqueror',         gems: 1000 },
    };
    const cb = rewards && CLEAR_BADGE[rewards.badge];
    if (cb) {
      setTimeout(() => {
        toast(t(`バッジ「${cb.ja}」を獲得！ ジェム+${cb.gems}`,
                `Badge earned: ${cb.en}! +${cb.gems} gems`), 'announce', 6000);
        confettiBurst(80);
      }, 1200);
    }
    // 再開点＝チェックポイント＝ボス階。10 固定にしていたので、深淵
    // （bossEvery: 5）で A5 / A15 / A25 … を撃破したときの
    // 「次回から A6 で再開可能」という宣言が全部嘘になっていた（実際は A1 に
    // 戻される＝ボス＋数フロアぶんの進行が消えたように見える）。
    // 宣言している側（floorCleared のトースト）に計算を合わせる。
    const step = R.bossEvery || 10;
    const cp = Math.floor(cleared / step) * step + 1;
    const P = R.prefix;
    const banner = won ? `${ic('leaderboard', 26)} ${t(`${R.name} 完全制覇！！`, `${R.nameEn} conquered!!`)}`
      : this.aborted ? `${ic('quit', 24)} ${t(`リタイア（${P}${this.floor}）`, `Retired (${P}${this.floor})`)}`
      : t(`${P}${this.floor} で力尽きた…`, `Fell on ${P}${this.floor}…`);
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : this.aborted ? 'draw' : 'lose'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('クリアした階', 'Floors cleared')}</span><b>${won ? t(`全${R.floors}階！`, `All ${R.floors}!`) : `${P}${fmt(cleared)}`}</b></div>
        <div class="rs-row"><span>${t('総ダメージ', 'Total damage')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t('次回の再開地点', 'Next run resumes at')}</span><b>${P}${cp}</b></div>`}
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-dungeon" id="rAgain">${won ? t('もう一周', 'Run it again') : t(`${P}${cp}から再挑戦`, `Retry from ${P}${cp}`)}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startDungeon(won ? 1 : cp, R.id); };
  }

  quit() {
    // 結果まで進んでいたら撤退の確認を出す相手がもういない。何もせず戻ると
    // ✕ →「終了する」を押しても動かない画面に取り残されるので、他モードと
    // 同じ退避（結果モーダルを閉じてメニューへ）にする。
    if (this.ended) { closeModal(); endToMenu(); return; }
    // ⏸ 読んでいる間は盤面もボスも時計も止める（main.js の ✕ 確認と同じ）。
    const resume = pauseModeForDialog();
    const m = showModal(`
      <h2>${ic('mode_dungeon', 20)} ${t('ダンジョンから撤退しますか？', 'Retreat from the dungeon?')}</h2>
      <p class="muted center" style="margin-bottom:10px">${t('ここまでにクリアした階は記録されます', 'Floors cleared so far will be saved')}</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="dqResume">${t('続ける', 'Keep going')}</button>
        <button class="btn btn-ai" id="dqQuit">${t('撤退する', 'Retreat')}</button>
      </div>`);
    m.querySelector('#dqResume').onclick = () => { audio.click(); closeModal(); };
    m.querySelector('#dqQuit').onclick = () => {
      audio.click();
      closeModal();
      this.aborted = true;
      this.finish(false);
    };
    if (resume) onModalClosed(resume);
  }

  destroy() {
    this.ended = true;
    clearInterval(this.atkInt);
    clearInterval(this.rainInt);
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
  }
}

export function startDungeon(startFloor = 1, realmId = 'tower') {
  if (currentMode) currentMode.destroy();
  currentMode = new DungeonMode(startFloor, realmId);
  window.__bbaMode = currentMode;
  currentMode.start();
}

export { DUNGEON_REALMS };

// ---------------------------------------------------------------------------
// Chaos mode (limited-time event, admin-controlled): the rules mutate on an
// interval the player chooses. Duration is also player-chosen (min/sec).
// Pure mayhem, bonus coins.
// ---------------------------------------------------------------------------

const CHAOS_BOARDS = ['board_default', 'board_ocean', 'board_sunset', 'board_forest', 'board_galaxy', 'board_oni', 'board_kami', 'board_sakura', 'board_volcano'];
const CHAOS_MODS = {
  // ここはすべて toast() へ渡る文言（textContent）なので、絵は混ぜず言葉だけ。
  fever:   t('フィーバー！スコア3倍！', 'Fever! 3x score!'),
  rain:    t('お邪魔ブロックの雨！', 'Garbage rain!'),
  giant:   t('巨大ブロック時代！', 'Age of giant blocks!'),
  mini:    t('ミニブロック時代！', 'Age of mini blocks!'),
  heaven:  t('天の恵み！全消し！', 'Divine gift! Board cleared!'),
  shuffle: t('大シャッフル！', 'Grand shuffle!'),
  reroll:  t('リロール無限！', 'Infinite rerolls!'),
  bomb:    t('爆撃！ボードに大穴！', 'Bombing run! Holes everywhere!'),
  freeze:  t('時間停止！残り+10秒！', 'Time freeze! +10 seconds!'),
  gravity: t('重力発生！ブロック落下！', 'Gravity! Blocks fall!'),
  cleanse: t('お邪魔ブロック浄化！', 'Garbage purged!'),
  shield:  t('コンボプロテクト！', 'Combo protect!'),
};

class ChaosMode extends VersusBase {
  constructor(opts = {}) {
    super();
    this.mode = 'chaos';
    this.duration = Math.max(30, Math.min(1800, Math.floor(Number(opts.duration) || 120)));
    this.interval = Math.max(5, Math.min(60, Math.floor(Number(opts.interval) || 15)));
  }

  start() {
    this.setupHud(this.duration);
    $('#oppPanel').classList.add('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    this.modCount = 0;
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_galaxy' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = () => this.onPlace();
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('boss');
    toast(t(`カオスモード！${this.interval}秒ごとにルールが変わるぞ！`, `Chaos Mode! The rules change every ${this.interval} seconds!`), 'announce', 3000);

    countdownOverlay(3, afterCountdown(this, () => {
      v.inputLocked = false;
      this.startTimer(() => this.finish());
      this.nextModifier();
      this.modInt = setInterval(() => this.nextModifier(), this.interval * 1000);
      // slim progress bar counting down to the next rule mutation
      $('#chaosBar').classList.remove('hidden');
      getView().resize();   // the bar just took height off the canvas box
      this.barInt = setInterval(() => {
        const remain = Math.max(0, (this.nextModAt || 0) - Date.now());
        $('#chaosBarFill').style.width = `${(remain / (this.interval * 1000)) * 100}%`;
      }, 100);
    }), audio);
  }

  nextModifier() {
    if (this.ended) return;
    const e = this.engine;
    this.nextModAt = Date.now() + this.interval * 1000;
    this.modCount++;
    // clear the previous modifier
    clearInterval(this.rainInt);
    e.scoreMult = 1;
    e.chaosBig = false;
    e.chaosMini = false;
    e.streakShield = false;
    if (e.infiniteReroll) { e.infiniteReroll = false; updateRerollHud(e); }

    const ids = Object.keys(CHAOS_MODS);
    let id = ids[(Math.random() * ids.length) | 0];
    if (id === this.currentMod) id = ids[(ids.indexOf(id) + 1) % ids.length];
    // freeze makes no sense twice in a row and cleanse needs garbage to shine —
    // reroll them once if they'd be a dud.
    if (id === 'cleanse' && !e.grid.includes(9)) id = ids[(Math.random() * ids.length) | 0];
    this.currentMod = id;
    this.modName = CHAOS_MODS[id];

    // visual chaos: new random stage + flash + shake
    setModeTheme({ ...equippedTheme(), boardId: CHAOS_BOARDS[(Math.random() * CHAOS_BOARDS.length) | 0] });
    view.screenFlash = 0.3;
    view.shake = 10;
    audio.combo(8);
    toast(this.modName, 'announce', 2400);
    $('#hudSub').textContent = this.modName;

    switch (id) {
      case 'fever':
        e.scoreMult = 3;
        break;
      case 'rain':
        this.rainInt = setInterval(() => {
          if (this.ended || !view || view.inputLocked || view.drag) return;
          const cells = e.addGarbage(2);
          for (const [r, c] of cells) {
            view.spawnAnim.set(r * 8 + c, view.time);
            view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
          }
          audio.place();
          if (e.over) this.onTopOut();
        }, 3000);
        break;
      case 'giant':
        e.chaosBig = true;
        if (!view.drag) e.hand = e.hand.map(p => (p ? e.drawPiece() : null));
        break;
      case 'mini':
        e.chaosMini = true;
        if (!view.drag) e.hand = e.hand.map(p => (p ? e.drawPiece() : null));
        break;
      case 'heaven':
        e.grid.fill(0);
        view.reviveFlash();
        confettiBurst(30);
        break;
      case 'shuffle': {
        const values = [];
        for (let i = 0; i < 64; i++) { if (e.grid[i]) values.push(e.grid[i]); }
        e.grid.fill(0);
        const spots = [...Array(64).keys()];
        for (const v2 of values) {
          const k = spots.splice((Math.random() * spots.length) | 0, 1)[0];
          e.grid[k] = v2;
          view.spawnAnim.set(k, view.time);
        }
        view.shake = 14;
        // シャッフルは埋まっているマスを別の場所へ配り直すので、たまたま行が
        // 揃うことがある。重力と同じ理由でここで消す（居座ると次の1手が
        // その行消しの加点とコンボを受け取ってしまう）。
        e.resolveLines();
        if (!e.hasAnyMove()) { e.grid.fill(0); }   // shuffle never kills you
        break;
      }
      case 'reroll':
        // TRULY infinite while this modifier is active — the button never runs out.
        e.infiniteReroll = true;
        updateRerollHud(e);
        break;
      case 'bomb': {
        // two friendly 3x3 explosions carve holes in the board
        for (let b = 0; b < 2; b++) {
          const cr = 1 + ((Math.random() * 6) | 0), cc = 1 + ((Math.random() * 6) | 0);
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const r = cr + dr, c = cc + dc;
            const k = r * 8 + c;
            if (e.grid[k]) {
              e.grid[k] = 0;
              view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 12, 'fx_default');
            }
          }
        }
        audio.bossAttack();
        view.shake = 14;
        break;
      }
      case 'freeze':
        this.endAt += 10000;
        this.timeLeft += 10;
        this.updateTimerHud();
        break;
      case 'gravity': {
        // every column falls to the bottom
        for (let c = 0; c < 8; c++) {
          const col = [];
          for (let r = 0; r < 8; r++) { const cv = e.grid[r * 8 + c]; if (cv) col.push(cv); }
          for (let r = 0; r < 8; r++) {
            const k = r * 8 + c;
            const nv = r < 8 - col.length ? 0 : col[r - (8 - col.length)];
            if (e.grid[k] !== nv) { e.grid[k] = nv; if (nv) view.spawnAnim.set(k, view.time); }
          }
        }
        view.shake = 12;
        // 崩落で埋まった行・列を消す。engine を通らない直書きなので、これが
        // 無いと満杯の行が残り、次に置いた1手が（無関係なのに）その行消しの
        // 加点とコンボを横取りする。hasAnyMove() より前に呼ぶこと。
        e.resolveLines();
        if (!e.hasAnyMove()) { e.grid.fill(0); }   // gravity never kills you
        break;
      }
      case 'cleanse': {
        let n = 0;
        for (let i = 0; i < 64; i++) if (e.grid[i] === 9) { e.grid[i] = 0; n++; }
        if (n > 0) {
          view.reviveFlash();
        } else {
          e.score += 300;   // no garbage? take a consolation bonus
          this.updateMyHud(e);
          view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize / 2, '+300', '#43d9e8', 1.2);
        }
        break;
      }
      case 'shield':
        e.streakShield = true;
        break;
    }
  }

  onPlace() {
    this.updateMyHud(this.engine);
    $('#hudSub').textContent = this.modName || t('カオス', 'Chaos');
  }

  onTopOut() {
    if (this.ended) return;
    if (autoRescue()) return;   // autopilot 5.0 guard — keeps the combo streak alive
    toast(t('ボードリセット！スコアは維持されます', 'Board reset! Your score is kept'), '', 1600);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    clearInterval(this.modInt);
    clearInterval(this.rainInt);
    clearInterval(this.barInt);
    $('#chaosBar').classList.add('hidden');
    getView().inputLocked = true;
    audio.victory();
    confettiBurst(40);
    const e = this.engine;
    const prevBest = Number(localStorage.getItem('bba_chaos_best') || 0);
    const isBest = e.score > prevBest;
    if (isBest) localStorage.setItem('bba_chaos_best', String(e.score));
    const rewards = await submitResult({
      mode: 'chaos', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const m = showModal(`
      <div class="result-banner win">${ic('mode_chaos', 26)} ${isBest ? t('カオス新記録！！', 'New chaos record!!') : t('カオス終了！', 'Chaos over!')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}${isBest ? ' ' + ic('medal_1', 14) : ''}</b></div>
        <div class="rs-row"><span>${t('自己ベスト', 'Personal best')}</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>${t('発動したルール', 'Rules triggered')}</span><b>${t(`${fmt(this.modCount)}回`, `${fmt(this.modCount)}`)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${/* submitResult は失敗した回に { failed } / 圏外の回に { queued } を返す。
              どちらも truthy なので、素の `rewards ?` だと「報酬は付いていません」の
              すぐ隣に「コイン1.5倍！」が並んでいた。実際に報酬が入った回だけ出す。 */''}
        ${rewards && !rewards.failed && !rewards.queued ? `<div class="rs-row"><span>${t('イベントボーナス', 'Event bonus')}</span><b>${t('コイン1.5倍！', '1.5x coins!')}</b></div>` : ''}
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-chaos" id="rAgain">${t('もう一回！', 'One more!')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startChaos({ duration: this.duration, interval: this.interval }); };
  }

  quit() {
    // 同上。結果まで進んでいたら中断の選択肢を出す意味がないので、
    // 結果モーダルを閉じてメニューへ戻す（出口を残す）。
    if (this.ended) { closeModal(); endToMenu(); return; }
    // ⏸ 同上。お題の差し替えもルーレットもこの間は回らない。
    const resume = pauseModeForDialog();
    // Mid-run cancel: let the player abort (no record), cash out early, or resume.
    const m = showModal(`
      <h2>${ic('mode_chaos', 20)} ${t('カオスモードを中断しますか？', 'Stop the chaos run?')}</h2>
      <p class="muted center" style="margin-bottom:10px">${t('「中断する」は記録なしでメニューに戻ります。<br>「終了して集計」はここまでのスコアで報酬を受け取ります。', '"Abort" returns to the menu with no record.<br>"Finish &amp; score" collects rewards for your score so far.')}</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="cqResume">${t('続ける', 'Keep playing')}</button>
        <button class="btn btn-ghost" id="cqAbort">${t('中断する（記録なし）', 'Abort (no record)')}</button>
        <button class="btn btn-chaos" id="cqFinish">${t('終了して集計', 'Finish & score')}</button>
      </div>`);
    m.querySelector('#cqResume').onclick = () => { audio.click(); closeModal(); };
    m.querySelector('#cqAbort').onclick = () => {
      audio.click();
      closeModal();
      this.ended = true;
      this.destroy();
      toast(t('カオスモードを中断しました（記録なし）', 'Chaos run aborted (no record)'), '', 2200);
      endToMenu();
    };
    m.querySelector('#cqFinish').onclick = () => { audio.click(); closeModal(); this.finish(); };
    if (resume) onModalClosed(resume);
  }

  destroy() {
    this.ended = true;
    this.stopTimer();
    clearInterval(this.modInt);
    clearInterval(this.rainInt);
    clearInterval(this.barInt);
    $('#chaosBar').classList.add('hidden');
  }
}

export function startChaos(opts) {
  if (currentMode) currentMode.destroy();
  currentMode = new ChaosMode(opts);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// Online: 1v1 duel / 2v2 team / custom rooms — all via the battle server.
// ---------------------------------------------------------------------------

class OnlineMode extends VersusBase {
  constructor(kind) {
    super();
    this.mode = 'pvp';
    this.kind = kind;               // 'duel' | 'team' | 'custom'
    this.client = new BattleClient();
  }

  async start() {
    if (this.kind === 'custom') {
      showScreen('room');
      this.showJoinView();
      this.wireRoomButtons();
    } else {
      showScreen('matchmaking');
      $('#mmStatus').textContent = t('サーバーに接続中…', 'Connecting to server…');
    }
    try {
      const hello = await this.client.connect(localStorage.getItem('bba_guest_name') || undefined);
      this.onlineCount = hello.online;
      // パーティーからの起動。つながった直後に部屋を作る／入る。
      if (this._autoCreate) { const o = this._autoCreate; this._autoCreate = null; this.client.createRoom(o); }
      else if (this._autoJoin) { const cd = this._autoJoin; this._autoJoin = null; this.client.joinRoom(cd); }
      // 万一この要素が無くても、オンライン対戦ごと死なせない。
      const onlineEl = $('#mmOnline');
      if (onlineEl) onlineEl.textContent = hello.online;
      // hello.queueing（このモードの待ち人数）は受け取るが画面には出さない。
      // 理由は onQueued() のコメント参照。
      if (!session.user) localStorage.setItem('bba_guest_name', hello.name);
    } catch (err) {
      toast(err.message, 'err');
      endToMenu();
      return;
    }

    this.client
      .on('match_found', msg => this.onMatchFound(msg))
      .on('opp_state', msg => this.onOppState(msg))
      .on('result', msg => this.onResult(msg))
      // The chat drawer already picks messageEn; the in-match toast did not,
      // so English players got Japanese announcements mid-game.
      .on('announce', msg => toast(t(msg.message, msg.messageEn || msg.message), 'announce', 5000))
      .on('room_update', msg => this.onRoomUpdate(msg))
      .on('room_error', msg => { audio.error(); toast(trServer(msg.error), 'err'); })
      .on('raid_state', msg => this.onRaidState(msg))
      .on('raid_attack', msg => this.onRaidAttack(msg))
      .on('garbage', msg => this.onGarbage(msg))
      .on('rematch_offer', msg => toast(t(`${msg.from} が再戦を希望しています！`, `${msg.from} wants a rematch!`), 'announce', 4000))
      .on('rematch_gone', () => {
        if (this.inMatch) return;   // 進行中の試合には古いオファー失効を触らせない
        this.ended = true;          // 再戦不成立 — 結果画面の待機状態に戻す
        toast(t('再戦の相手はもういません', 'Your opponent has left — no rematch'), 'err', 2500);
        const b = document.querySelector('#rRematch');
        if (b) { b.disabled = true; b.textContent = t('相手が離脱', 'Opponent left'); }
      })
      // OnlineMode には error の受け口が無く、サーバーが送っても無反応だった。
      .on('error', m => { if (m.error) toast(trServer(m.error), 'err', 3000); })
      // 🔌 再接続まわりの4フレーム。第4波までサーバー（battle.js）と net.js
      // だけが実装されていて、画面側の受け口が丸ごと無かった。
      .on('reconnecting', m => this.onReconnecting(m))
      .on('match_resumed', m => this.onMatchResumed(m))
      .on('opp_unstable', m => this.onOppUnstable(m))
      .on('opp_back', m => this.onOppBack(m))
      .on('coop_state', msg => this.onCoopState(msg))
      .on('coop_reject', msg => this.onCoopReject(msg))
      // 🚩 陣取りデュエル（協力プレイと同じサーバー権威の1盤面）
      .on('land_state', msg => this.onLandState(msg))
      .on('land_reject', msg => this.onLandReject(msg))
      .on('coop_partner_left', () => toast(t('相棒が離脱しました。残りはサーバーが代打します！', 'Your partner left — the server will play their turns!'), 'err', 4000))
      .on('emote', msg => this.showEmote(msg.slot, msg.emoji))
      .on('tourney_state', msg => this.onTourneyState(msg))
      .on('tourney_champion', msg => this.onTourneyChampion(msg))
      // 🏆 大会が外から中止された（管理者の「更新の準備」など）。
      .on('tourney_cancelled', () => this.onTourneyCancelled())
      .on('royale_found', msg => this.onRoyaleFound(msg))
      .on('royale_state', msg => this.onRoyaleState(msg))
      .on('royale_cut', msg => this.onRoyaleCut(msg))
      .on('royale_result', msg => this.onRoyaleResult(msg))
      .on('royale_garbage', msg => this.onRoyaleGarbage(msg))
      .on('royale_kill', msg => this.onRoyaleKill(msg))
      .on('royale_revive', msg => this.onRoyaleRevive(msg))
      .on('royale_feed', msg => this.onRoyaleFeed(msg))
      .on('royale_finale', msg => this.onRoyaleFinaleStart(msg))
      .on('royale_over', msg => this.onRoyaleOver(msg))
      // The server has always sent these; nothing on the client listened.
      .on('queued', msg => this.onQueued(msg))
      .on('queue_cancelled', () => {
        this.queueInfo = null;
        // 自分でキャンセルしたぶんは quit() が後始末済み（leftOnPurpose）。
        // 拾いたいのはサーバー都合で待ち行列が解散されたとき
        //（endAllForShutdown / prepare-update）── 検索画面の経過時間は
        // server push（queued）でしか更新されないので、放っておくと
        // 止まった時計の前で待ち続けることになる。
        // このあとサーバーは error も送ってくるが、こちらが socket を閉じると
        // 届かないことがあるので、理由はここでも出す。
        if (this.ended || this.leftOnPurpose || this.inMatch) return;
        closeModal();
        toast(t('マッチングは中止されました', 'Matchmaking was cancelled'), 'err', 3000);
        this.ended = true;
        this.destroy();
        endToMenu();
      })
      .on('online', msg => {
        this.onlineCount = msg.online;
        const el = $('#mmOnline');
        if (el) el.textContent = msg.online;
        // msg.queueing（モード別の待ち人数）は表示しない ── onQueued() 参照。
      })
      .on('close', () => {
        if (this.ended) return;
        // A drop during the "⌛ 集計中…" wait used to leave that modal — which
        // is deliberately non-dismissable — sitting over the menu forever,
        // with the 20s fallback already disarmed by this.ended. The app was
        // unusable until a reload.
        if (this.leftOnPurpose) { closeModal(); return; }
        // 以前は inMatch / custom / tourney のときしか後始末をしていなかった。
        // duel・attack・team・raid・coop・royale はマッチング画面で
        // inMatch=false のまま待つので、そこで切れると何も起きず ── 毎秒の
        // queued も止まり、経過時間が凍ったままの検索画面に
        // 置き去りになっていた。BattleClient に再接続は
        // 無く、サーバー側のキューも切断で消えるので待っても永久にマッチしない。
        // 切れたら kind に関係なくメニューへ戻す。
        closeModal();
        toast(t('サーバーとの接続が切れました', 'Lost connection to the server'), 'err');
        this.ended = true;
        this.destroy();
        endToMenu();
      });

    if (this.kind !== 'custom') {
      $('#mmStatus').textContent = this.kind === 'team'
        ? t('チームメンバーを探しています…', 'Looking for teammates…')
        : this.kind === 'raid'
        ? t('レイドパーティを募集しています…', 'Gathering a raid party…')
        : this.kind === 'tourney'
        ? t('トーナメント参加者を募集しています…', 'Gathering tournament entrants…')
        : this.kind === 'royale'
        ? t('バトルロイヤル参加者を募集しています…', 'Gathering battle-royale contenders…')
        : this.kind === 'coop'
        ? t('いっしょに遊ぶ相棒を探しています…', 'Looking for a co-op partner…')
        // 🏷 表の名前は rules.js の ONLINE_MODES が唯一の正解。ここで
        //    文言を書くと名前が2つになる ── 実際「1v1 ランクマッチ」を
        //    押したのに待ち合わせ画面だけ旧名「アタック戦」のままだった。
        //    onlineModeName() は知らない kind に空文字を返すので、
        //    そのときは下の汎用文に落ちる。
        : onlineModeName(this.kind)
        ? t(`「${onlineModeName(this.kind)}」の相手を探しています…`,
            `Looking for a ${onlineModeName(this.kind)} opponent…`)
        : t('対戦相手を探しています…', 'Looking for an opponent…');
      // 接続人数は #mmOnlineLine が持っている。ここで作り直すと id が重複する。
      $('#mmSub').textContent = t('対戦相手を検索中…', 'Searching…');
      const oe = $('#mmOnline');
      if (oe) oe.textContent = this.onlineCount ?? '-';
      // #mmQueue は「あと N 秒」「このモードで待っている人」を出していた枠。
      // どちらも出さなくなったので、前の検索の残りが見えないよう空にする。
      const q = $('#mmQueue');
      if (q) q.textContent = '';
      this.client.queue(this.kind);
    }
  }

  // 検索画面に出してよいのは「本物のマッチングでも出せること」だけ。
  //
  // 以前はここで
  //   ・あと <N> 秒で対戦相手が見つかります
  //   ・このモードで待っている人: <N>人
  // を出していた。この2つは並ぶと住人の正体を割ってしまう ── 本物の
  // マッチングは相手が来る時刻を予告できない（予告できるのは、その秒数後に
  // 出すと先に決まっているから）。しかも「待っている人 0人」と同時に出るので、
  // 「0人待ちなのに 12 秒後に相手が来る」と読めてしまう。
  //
  // 残すのは経過時間だけ。これは本物の待ち行列でも出るので手がかりにならない。
  // 画面上部の「オンライン: N人」(#mmOnlineLine) は**ゲーム全体の接続人数**で、
  // このモードの待ち人数ではないのでそのまま出す（ユーザーの明示要求）。
  //
  // ⚠️ msg.matchInSec / msg.humans / msg.rating / msg.band は消さない。
  //    サーバーは今も送っていて、管理画面がそれを見る（別担当）。
  //    ここは「受け取るが画面には出さない」だけにする。
  onQueued(msg) {
    const st = $('#mmStatus');
    const sub = $('#mmSub');
    if (!st || !sub) return;
    this.queueInfo = msg;   // 中身は保持（管理画面・デバッグ用）。表示はしない。
    const mins = Math.floor((msg.waited || 0) / 60);
    const secs = (msg.waited || 0) % 60;
    const clock = mins ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}${t('秒', 's')}`;
    // ⏱️ は時計のアイコンが icons.js に無いので、絵を足さず言葉だけにする。
    sub.textContent = t(`${clock} 経過`, `${clock} elapsed`);
  }

  // ---- custom room lobby ----

  showJoinView() {
    $('#roomJoin').classList.remove('hidden');
    $('#roomLobby').classList.add('hidden');
  }

  wireRoomButtons() {
    $('#btnCreateRoom').onclick = () => { audio.click(); this.client.createRoom({}); };
    const join = () => {
      const code = $('#roomCodeInput').value.trim();
      if (code.length !== 4) { toast(t('4文字のコードを入力してください', 'Enter the 4-letter code'), 'err'); return; }
      audio.click();
      this.client.joinRoom(code);
    };
    $('#btnJoinRoom').onclick = join;
    $('#roomCodeInput').onkeydown = e => { if (enterIsLive(e)) join(); };
    $('#btnLeaveRoom').onclick = () => { audio.click(); this.client.leaveRoom(); this.showJoinView(); };
    $('#btnStartRoom').onclick = () => { audio.click(); this.client.startRoom(); };
    $('#btnRoomBack').onclick = () => { audio.click(); this.quit(); };
  }

  // 席の割り当て。サーバー（server/battle.js の broadcastRoom）が
  //   seats … 対戦席の数（1v1/協力/陣取り=2・2v2=4）
  //   max   … 部屋の定員（ROOM_MAX=8）
  //   players[].seat … 'play' | 'watch'
  // を送ってくる。それが唯一の正解なので、来ていればそのまま使う。
  // 来ていない場合（古いサーバー）だけ「先に入った人から対戦席」で代用する ──
  // 古い startRoom も join 順で席を決めていたので、見た目と実際がズレない。
  roomSeatPlan(msg) {
    const s = msg.settings || {};
    const mode = s.mode || (s.team ? 'team' : 'duel');
    const declared = Number(msg.seats);
    const playSeats = Number.isFinite(declared) && declared > 0
      ? declared : (mode === 'team' ? 4 : 2);
    const play = [], watch = [];
    (msg.players || []).forEach((p, i) => {
      const seat = p.seat === 'watch' || p.seat === 'play'
        ? p.seat : (i < playSeats ? 'play' : 'watch');
      (seat === 'play' ? play : watch).push(p);
    });
    // 部屋そのものの定員（サーバーの ROOM_MAX）。送ってこない実装なら
    // 「いま居る人数」で代用する（＝定員の表示が嘘にならない）。
    const max = Number(msg.max) > 0 ? Number(msg.max) : (msg.players || []).length;
    return { mode, playSeats, play, watch, max };
  }

  // ルームの席を「対戦席」と「観戦席」に分けて描く。ホストにだけ席の
  // 入れ替えボタンを出す（ホスト以外に出すと、押せるのに何も起きない
  // ボタンになる ── サーバーが弾くのが正しいが、押せること自体が嘘）。
  renderRoomSeats(msg) {
    const { mode, playSeats, play, watch, max } = this.roomSeatPlan(msg);
    const host = !!msg.youAreHost;
    const teamMark = n => (mode === 'team'
      ? `<i class="rp-chip ${n < 2 ? 'a' : 'b'}"></i>`
      : ic('seat_play', 18));
    const full = play.length >= playSeats;
    const row = (p, n, seat) => `
      <div class="room-player${p.isYou ? ' me' : ''}${seat === 'watch' ? ' watcher' : ''}">
        <span class="rp-team">${seat === 'play' ? teamMark(n) : ic('seat_watch', 18)}</span>
        <span class="rp-name">${escapeHtml(p.name)}${p.isYou ? t('（あなた）', ' (you)') : ''}</span>
        ${p.isHost ? `<span class="rp-host">${ic('host_crown', 14)} ${t('ホスト', 'Host')}</span>` : ''}
        ${host ? `<button class="rp-seat" data-seat-name="${escapeHtml(p.name)}"
            data-seat-to="${seat === 'play' ? 'watch' : 'play'}"
            ${seat === 'watch' && full ? 'disabled' : ''}
            title="${seat === 'play' ? t('観戦席へ移す', 'Move to the spectator seats') : t('対戦席へ移す', 'Move to a player seat')}"
          >${seat === 'play' ? `${ic('seat_watch', 14)} ${t('観戦席へ', 'Watch')}` : `${ic('seat_play', 14)} ${t('対戦席へ', 'Play')}`}</button>` : ''}
      </div>`;
    const openSeat = `
      <div class="room-player open">
        <span class="rp-team">${ic('seat_open', 18)}</span>
        <span class="rp-name">${t('空き席', 'Open seat')}</span>
      </div>`;
    $('#roomPlayers').innerHTML = `
      <div class="room-seat-group">
        <div class="room-seat-title">${ic('seat_play', 14)} ${t('対戦席', 'Player seats')}<b>${play.length}/${playSeats}</b></div>
        ${play.map((p, n) => row(p, n, 'play')).join('')}
        ${openSeat.repeat(Math.max(0, playSeats - play.length))}
      </div>
      <div class="room-seat-group">
        <div class="room-seat-title">${ic('seat_watch', 14)} ${t('観戦席', 'Spectator seats')}<b>${watch.length}</b>
          <span class="rs-cap">${t(`この部屋は ${play.length + watch.length}/${max} 人`, `${play.length + watch.length}/${max} in this room`)}</span>
        </div>
        ${watch.length ? watch.map(p => row(p, 0, 'watch')).join('')
          : `<p class="muted center rs-empty">${t('対戦席に入りきらない人はここで観戦します', 'Anyone who does not fit in a player seat watches from here')}</p>`}
      </div>`;
    if (!host) return;
    $('#roomPlayers').querySelectorAll('[data-seat-name]').forEach(b => {
      b.onclick = () => {
        audio.click();
        // server/battle.js の case 'room_seat' と同じ形。断られたときは
        // room_error が返るので、こちらで先読みして席を動かさない
        // （動かすと、サーバーが弾いた席割りが一瞬だけ本物に見える）。
        this.client.send({ type: 'room_seat', name: b.dataset.seatName, seat: b.dataset.seatTo });
      };
    });
  }

  // 👀 「観戦している」ときに片づける物を1か所にまとめたもの。
  //    ルームの観戦席（onRoomSpectate）とロイヤルの脱落後観戦（royaleDead）は
  //    どちらも「自分の試合はもう無い」状態なのに、片づけがルーム側にしか
  //    書かれていなかった ── ロイヤルの観戦中はリロール（残数つき）が出たまま
  //    残り、押しても何も起きない死にボタンになっていた。
  //    ⚠ 2か所に同じ列挙を書かないこと（片方だけ直る事故が起きる）。
  enterSpectatorHud() {
    $('#oppPanel').classList.add('hidden');
    $('#bossPanel').classList.add('hidden');
    $('#coopBar').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    // 自分の試合が無いのだから、自分の試合の道具は出さない。
    // 引き直しも奥義も、押しても何も起きないボタンになる。
    $('#btnReroll').classList.add('hidden');
    $('#btnUlt').classList.add('hidden');
    showItemBar(false);
    // 自分は打たない。GameView は観戦ビューに完全に覆われるが、
    // 入力だけは閉じておく（覆いの隙間から触れる端末を作らない）。
    getView().inputLocked = true;
    $('#hudScore').textContent = '-';
  }

  // カスタムルームの観戦席。試合が始まったあとも room_update が届き、
  // そこに watch / watchable が載る（この波の取り決め）。ロビーの更新では
  // ないので、部屋の画面ではなく観戦ビューへ回す。
  onRoomSpectate(msg) {
    if (this.ended) return;
    if (!this.spectatingRoom) {
      this.spectatingRoom = true;
      this.inMatch = true;
      showScreen('game');
      this.enterSpectatorHud();
      $('#hudSub').innerHTML = ic('spectate', 13) + ' ' + t('観戦席', 'SPECTATING');
      toast(t('観戦席から試合を見ています', 'Watching from the spectator seats'), 'announce', 2600);
    }
    const w = msg.watch || null;
    const parts = [];
    if (w) parts.push(fmt(w.score));
    if (typeof msg.remain === 'number') parts.push(`${msg.remain}s`);
    this.updateSpectateView({
      name: w ? w.name : '',
      score: w ? w.score : 0,
      grid: w ? w.grid : null,
      sub: parts.join(' ・ '),
      // 観戦ビューは name / score / alive しか読まない（取り決めどおり）。
      watchable: Array.isArray(msg.watchable)
        ? msg.watchable.slice(0, this.watchListMax).map(r => ({
            name: r.name, score: Number(r.score) || 0, alive: r.alive !== false,
          }))
        : (w ? [{ name: w.name, score: Number(w.score) || 0, alive: true }] : []),
    });
  }

  // 観戦していた試合が終わった。ルーム画面へ返す ── 観戦席の人は部屋に
  // 残ったままなので、そのまま次の試合を組める（サーバーの endRoomSpectate が
  // 席を組み直して broadcastRoom してくる）。
  leaveRoomSpectate() {
    this.clearSpectateView();   // spectatingRoom もここで false に戻る
    this.inMatch = false;
    // 観戦のあいだ隠した自分用のボタンを戻す（次の試合で自分が出るときに
    // 消えたままだと、引き直しも奥義も使えない試合になる）。
    $('#btnReroll').classList.remove('hidden');
    $('#hudSub').textContent = 'SCORE';
    showScreen('room');
    toast(t('観戦が終わりました。ルームに戻ります', 'The match is over — back to the room'), 'ok', 2600);
  }

  onRoomUpdate(msg) {
    // 試合中の観戦席には、同じ room_update に inMatch / watch / watchable が
    // 載って届く（server/battle.js の roomWatchExtra）。ロビーの更新ではない
    // ので、先に振り分ける ── 下のロビー描画に流すと、試合の最中に部屋の
    // 画面が出てきて盤面を覆ってしまう。
    if (msg.inMatch || msg.watch !== undefined || msg.watchable !== undefined) {
      this.onRoomSpectate(msg);
      return;
    }
    // 試合が終わると inMatch:false のふつうの部屋フレームに戻る。観戦を畳んで
    // ルーム画面へ返す（放っておくと、盤面の上に前の試合の観戦窓が残る）。
    if (this.spectatingRoom) this.leaveRoomSpectate();
    this.roomInfo = msg;
    // パーティーから作った部屋なら、合言葉を待っている人がいる。
    if (this._onRoomCode) this._onRoomCode(msg.code);
    $('#roomJoin').classList.add('hidden');
    $('#roomLobby').classList.remove('hidden');
    $('#roomCodeLabel').textContent = msg.code;

    // 対戦席と観戦席を分けて描く（席の入れ替えはホストだけ）。
    this.renderRoomSeats(msg);

    const host = msg.youAreHost;
    const s = msg.settings;
    const mode = s.mode || (s.team ? 'team' : 'duel');
    const dis = host ? '' : 'disabled';
    $('#roomSettings').innerHTML = `
      <div class="settings-row ${mode === 'coop' ? 'hidden' : ''}"><label>${t('試合時間', 'Match time')}</label><div class="seg" data-rs="duration">
        ${[60, 120, 180].map(d => `<button data-v="${d}" ${s.duration === d ? 'class="active"' : ''} ${dis}>${d / 60}${t('分', 'min')}</button>`).join('')}
      </div></div>
      <div class="settings-row"><label>${t('モード', 'Mode')}</label><div class="seg" data-rs="mode">
        ${[['duel', '1v1'], ['attack', t('攻撃戦', 'Attack')], ['team', t('2v2チーム', '2v2 Team')], ['coop', t('協力', 'Co-op')], ['land', t('陣取り', 'Land Grab')]].map(([v, l]) =>
          `<button data-v="${v}" ${mode === v ? 'class="active"' : ''} ${dis}>${l}</button>`).join('')}
      </div></div>
      ${mode === 'attack' ? `<p class="muted center" style="font-size:11px">${t('2ライン以上を同時に消すと、相手の盤面にお邪魔ブロックが飛びます', 'Clearing 2+ lines at once dumps garbage on your opponent')}</p>` : ''}
      ${mode === 'coop' ? `<p class="muted center" style="font-size:11px">${t('2人で1つの盤面を交互に操作。ボット補充ONなら1人でも遊べます', 'Two players share one board, taking turns. Bot fill lets you play solo')}</p>` : ''}
      ${mode === 'land' ? `<p class="muted center" style="font-size:11px">${t('2人で1つの盤面を交互に操作。消したライン8マスが自分の色になり、領土が広いほうが勝ち（合言葉ルーム専用）', 'Two players share one board, taking turns. Every line you clear paints 8 squares your colour — most territory wins (code rooms only)')}</p>` : ''}
      <div class="settings-row"><label>${ic('mode_ai', 14)} ${t('ボット補充', 'Fill with bots')}</label><input type="checkbox" id="rsBotFill" ${s.botFill ? 'checked' : ''} ${dis}></div>
      <div class="settings-row"><label>${t('ボットの強さ', 'Bot strength')}</label><div class="seg" data-rs="botLevel">
        ${[['random', t('おまかせ', 'Any')], ['easy', t('弱', 'Easy')], ['normal', t('中', 'Mid')], ['hard', t('強', 'Hard')], ['oni', t('鬼', 'Oni')]].map(([v, l]) =>
          `<button data-v="${v}" ${s.botLevel === v ? 'class="active"' : ''} ${dis}>${l}</button>`).join('')}
      </div></div>`;
    $('#btnStartRoom').classList.toggle('hidden', !host);

    if (host) {
      $('#roomSettings').querySelectorAll('.seg button').forEach(b => {
        b.onclick = () => {
          const key = b.parentElement.dataset.rs;
          let v = b.dataset.v;
          if (key === 'duration') v = Number(v);
          audio.click();
          this.client.setRoom({ [key]: v });
        };
      });
      const bf = $('#rsBotFill');
      if (bf) bf.onchange = e => this.client.setRoom({ botFill: e.target.checked });
    }
  }

  // ---- 💯 battle royale (v2.11) ----
  //
  // 100 entrants who actually play, garbage flying between survivors, a rising
  // storm, a live KO feed, a danger meter that says how far you are from the
  // cut, spectating after you die, and a three-way finale.

  onRoyaleFound(msg) {
    if (this.inMatch || this.ended) return;
    closeModal();
    this.inMatch = true;
    this.isRoyale = true;
    this.royaleKills = 0;
    this.royaleDead = false;
    this.sawRoyaleResult = false;
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);
    this.timeLeft = msg.duration;
    this.updateTimerHud();
    const v = getView();
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onRoyalePlace(r);
    v.onGameOver = () => this.onRoyaleTopOut();
    this.updateRoyaleHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('pixel');
    this.showRoyaleBar();
    toast(t('バトルロイヤル開始！2ライン以上消して相手を潰せ！', 'Battle Royale! Clear 2+ lines to bury your rivals!'), 'announce', 3000);
    countdownOverlay(msg.countdown || 3, afterCountdown(this, () => {
      // The mode may have been quit during the 3-2-1 — re-arming timers here
      // would leak them past destroy().
      if (this.ended || currentMode !== this) return;
      v.inputLocked = false;
      this.startTimer(() => { getView().inputLocked = true; });   // the server calls the finish
      this.stateInt = setInterval(() => this.pushState(), 700);
    }), audio);
  }

  // A slim strip above the board: rank, survivors, KOs, storm, and the danger
  // meter. Built once, updated from royale_state.
  showRoyaleBar() {
    const panel = $('#oppPanel');
    panel.classList.remove('hidden');
    panel.classList.add('royale-panel');
    $('#teamTotals').classList.add('hidden');
    $('#btnOppDensity').classList.add('hidden');
    document.querySelector('.vs-bar').classList.add('hidden');
    $('#oppCards').className = '';
    $('#oppCards').innerHTML = `
      <div class="rl-bar">
        <div class="rl-row">
          <span class="rl-alive">${ic('mode_royale', 14)} <b id="rlAlive">100</b></span>
          <span class="rl-rank">#<b id="rlRank">-</b></span>
          <span class="rl-kills">KO <b id="rlKills">0</b></span>
          <span class="rl-storm hidden" id="rlStorm">${ic('warn', 14)} ${t('嵐', 'STORM')}</span>
        </div>
        <div class="rl-danger" id="rlDanger"></div>
        <div class="rl-feed" id="rlFeed"></div>
      </div>`;
    getView().resize();   // the strip just took height off the canvas box
  }

  updateRoyaleHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = this.royaleRank
      ? `RANK ${this.royaleRank}/${this.royaleAlive}` : 'SCORE';
  }

  onRoyalePlace(r) {
    this.updateRoyaleHud();
    this.pushState();
    // 2+ lines buries somebody. The server picks the target (often the leader).
    if (r && r.lineCount >= 2 && this.inMatch && !this.ended && !this.royaleDead) {
      this.client.send({ type: 'royale_attack', lines: r.lineCount, combo: r.streak });
      const cells = attackCellsFor(r.lineCount, r.streak);
      // ここは1手ごとに撃てるのに、以前は毎回トーストを出していた。トーストは
      // 同時3件で頭打ちなので、脱落・KO・ストーム・復活といった「見逃すと困る
      // 通知」を自分の攻撃で押し出していた。盤面のフロートテキストへ移す。
      const v = getView();
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.18,
        t('攻撃！', 'ATTACK!'), '#ff8a5c', 1.5);
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.18 + v.cell,
        t(`お邪魔 +${cells}`, `+${cells} garbage`), '#ffd75e', 1.05);
      attackLesson('sent', { lines: r.lineCount, cells });
    }
  }

  // The server owns the consequence — first top-out revives, the second is
  // elimination — so it is told, not asked.
  onRoyaleTopOut() {
    if (this.ended || this.royaleDead) return;
    // ⚠ 復活の返事を待っている間は二度送らない。
    //
    //   1回目のトップアウトを送ってから royale_revive が届くまでの数百ミリ秒、
    //   盤面はまだ埋まったまま（engine.over が true）。そこへお邪魔が1つ届くと
    //   onRoyaleGarbage の末尾がもう一度ここを呼び、**2通目の royale_topout**が
    //   飛ぶ。サーバーは「2回目＝脱落」と決めているので、本人からは
    //   「復活！」のトーストが出た直後に順位が確定したようにしか見えず、
    //   順位報酬まで丸ごと変わってしまう。
    if (this.royaleTopoutPending) return;
    this.royaleTopoutPending = true;
    this.client.send({ type: 'royale_topout' });
    getView().inputLocked = true;   // unlocked again by royale_revive
  }

  onRoyaleRevive(msg) {
    if (this.ended) return;
    this.royaleTopoutPending = false;
    this.engine.reviveBoard();
    this.engine.score = msg.score;
    getView().reviveFlash();
    getView().inputLocked = false;
    audio.levelUp();
    this.updateRoyaleHud();
    updateRerollHud(this.engine);
    toast(t('復活！ただし次に潰れたら脱落です（スコア-10%）',
      'Revived! Next top-out eliminates you (−10% score)'), 'announce', 3200);
  }

  onRoyaleGarbage(msg) {
    if (this.ended || !this.engine) return;
    const cells = this.engine.addGarbage(Math.max(0, Math.min(12, msg.cells || 0)));
    const v = getView();
    for (const [r, c] of cells) {
      v.spawnAnim.set(r * 8 + c, v.time);
      v.particles.burstCell(v.boardX + (c + 0.5) * v.cell, v.boardY + (r + 0.5) * v.cell, v.cell, 9, 'fx_default');
    }
    v.shake = 9;
    audio.bossAttack();
    if (msg.from) toast(t(`${msg.from} の攻撃！ お邪魔${cells.length}個`, `Hit by ${msg.from}! ${cells.length} garbage`), 'err', 1500);
    // ⚡ストームは from が null で降ってくる。誰かの攻撃ではないので、
    // 「相手がラインを消した」と教えると嘘になる（レッスンの回数も無駄に減る）。
    if (msg.from) attackLesson('taken', { lines: Number(msg.lines) || 0, cells: cells.length });
    if (this.engine.over) this.onRoyaleTopOut();
  }

  onRoyaleKill(msg) {
    this.royaleKills = msg.kills;
    const k = $('#rlKills');
    if (k) k.textContent = msg.kills;
    audio.victory();
    toast(t(`${msg.victim} を脱落させた！（${msg.kills}KO）`, `You knocked out ${msg.victim}! (${msg.kills} KOs)`), 'announce', 2200);
  }

  royaleFeedLine(html) {
    const feed = $('#rlFeed');
    if (!feed) return;
    const el = document.createElement('div');
    el.className = 'rl-feed-line';
    el.innerHTML = html;
    feed.prepend(el);
    while (feed.children.length > 3) feed.lastChild.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
  }

  onRoyaleFeed(msg) {
    if (msg.kind === 'ko') {
      this.royaleFeedLine(ic('quit', 13) + ' ' + (msg.by
        ? `<b>${escapeHtml(msg.by)}</b> → ${escapeHtml(msg.victim)}`
        : t(`${escapeHtml(msg.victim)} 脱落`, `${escapeHtml(msg.victim)} is out`)));
    } else if (msg.kind === 'left') {
      this.royaleFeedLine(ic('close', 13) + ' ' + t(`${escapeHtml(msg.victim)} が離脱`, `${escapeHtml(msg.victim)} left`));
    } else if (msg.kind === 'storm') {
      audio.bossAttack();
      if (view) view.screenFlash = 0.35;
      toast(t(`ストームが来る！ 全員にお邪魔${msg.cells}個が定期的に降ります`,
        `The storm closes in — ${msg.cells} garbage on everyone, on a timer`), 'err', 3200);
    } else if (msg.kind === 'cut') {
      this.royaleFeedLine(ic('warn', 13) + ' ' + t(`足切り ${msg.eliminated}人 — 残り${msg.alive}`, `Cut: ${msg.eliminated} out — ${msg.alive} left`));
    } else if (msg.kind === 'finale') {
      // 🏁 トーストは royale_finale 側の1本にまとめる。
      //    サーバーは同じ瞬間に royale_finale と royale_feed{kind:'finale'} の
      //    両方を送るので、いちばん盛り上がる場面でトースト枠を2つ食い、
      //    直後の脱落・KO・ストーム通知を押し出していた。
      //    しかも「残り3人の盤面が見えます」は嘘 ── 3枚並べは
      //    「生存中の本人に出すと手札に重なって置けなくなる」ので廃止済み。
      //    ここは音と、流れて消えるフィードの1行だけにする。
      audio.victory();
      this.royaleFeedLine(ic('fire', 13) + ' ' + t('ファイナル', 'FINALE'));
    }
  }

  onRoyaleState(msg) {
    this.royaleRank = msg.rank;
    this.royaleAlive = msg.alive;
    if (!msg.spectating) this.updateRoyaleHud();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#rlAlive', msg.alive);
    set('#rlRank', msg.rank || '-');
    set('#rlKills', msg.kills || 0);
    const storm = $('#rlStorm');
    if (storm) storm.classList.toggle('hidden', !msg.storm);

    // Danger meter: a number you can act on, not a vague warning.
    const d = $('#rlDanger');
    // 脱落したら、危険メーターは**消す**。以前は「観戦中は更新しない」だけの
    // 分岐だったので、死ぬ直前に見えていた「⚠️ 脱落圏！ あと 359 点で生き残れる」
    // が観戦中ずっと貼り付いたままだった（もう自分の点は動かないのに）。
    if (d && msg.spectating) {
      d.className = 'rl-danger';
      d.textContent = '';
    } else if (d) {
      if (msg.safeBy == null || msg.nextKeep == null) {
        d.className = 'rl-danger';
        d.textContent = '';
      } else if (msg.safeBy >= 0) {
        d.className = 'rl-danger safe';
        d.innerHTML = ic('check', 13) + ' ' + escapeHtml(t(`安全圏まで +${fmt(msg.safeBy)} の余裕（上位${msg.nextKeep}人が残る・あと${msg.nextCutIn}秒）`,
          `${fmt(msg.safeBy)} clear of the cut (top ${msg.nextKeep} survive, ${msg.nextCutIn}s)`));
      } else {
        d.className = 'rl-danger risk';
        d.innerHTML = ic('warn', 13) + ' ' + escapeHtml(t(`脱落圏！ あと ${fmt(-msg.safeBy)} 点で生き残れる（あと${msg.nextCutIn}秒）`,
          `IN THE CUT! ${fmt(-msg.safeBy)} points from safety (${msg.nextCutIn}s)`));
      }
    }

    // 観戦は「盤面の箱を丸ごと使う1枚」に統一した。ファイナル（残り3人）の
    // 3枚並べは renderRoyaleSpectate の一覧に畳んである ── 両方出すと
    // 375x667 で盤面が潰れるうえ、生存中の本人に出すと手札に重なって
    // 最後の3人でブロックを置けなくなっていた。
    if (msg.spectating) this.renderRoyaleSpectate(msg);
  }

  // ---- 👀 観戦ビュー（バトルロイヤル／カスタムルームの観戦席で共用） ------
  //
  // 以前の観戦は .game-canvas-wrap の右上に 84px（スマホ 64px）の窓を出すだけ
  // だった。8x8 の盤面を 84px に詰めると1マス 10.5px ── 何が起きているのか
  // 読めない大きさで、しかも見る相手はサーバーが選んだ首位に固定だった。
  // 脱落した人にはもう自分の盤面が要らないのだから、盤面の箱を丸ごと明け渡す。
  //
  // 通信の形は royale_state / room_update で共通（この波の取り決め）:
  //   → { type: 'watch', target: string|null }   null は「おまかせ（首位）」
  //   ← watch:     { name, score, grid } | null
  //   ← watchable: [{ name, score, alive }]      順位順・上位20人まで
  // watchable には正体に関わる欄（isBot など）を載せない取り決めなので、
  // こちらも name / score / alive の3つ以外は読まない（読まなければ、将来
  // 誤って足された欄も画面には出ない）。

  // 一覧に並べる札の上限。サーバーの WATCHABLE_MAX（20）の写しではなく、
  // **画面側の都合**の上限 ── 横スクロールの帯に何百枚も札を作らないための
  // 保険。片方だけ増えても「短いほうで切れる」だけで、ズレて困ることはない。
  get watchListMax() { return 20; }

  mountSpectateView() {
    let box = document.querySelector('.rl-spectate');
    if (box) return box;
    const wrap = document.querySelector('.game-canvas-wrap');
    if (!wrap) return null;
    box = document.createElement('div');
    box.className = 'rl-spectate';
    box.innerHTML = `
      <div class="rl-spec-bar">
        <div class="rl-spec-head"></div>
        <div class="rl-spec-sub"></div>
      </div>
      <div class="rl-spec-stage"><canvas class="rl-spec-canvas" aria-label="観戦中の盤面"></canvas></div>
      <div class="rl-spec-picker" role="group" aria-label="観戦する相手"></div>`;
    wrap.appendChild(box);
    this.specBoard = new MiniBoard(box.querySelector('.rl-spec-canvas'));
    // 一覧のボタンは順位が動くたびに作り直すので、押される側ではなく箱で受ける。
    box.querySelector('.rl-spec-picker').addEventListener('click', e => {
      const b = e.target.closest('[data-watch-name]');
      if (!b || b.disabled) return;
      audio.click();
      // data-* は文字列しか持てない。「おまかせ」は空文字で表し、
      // サーバーへは取り決めどおり null を送る。
      const name = b.dataset.watchName;
      this.requestWatch(name === '' ? null : name);
    });
    // 盤面は「入る箱の短いほう」に合わせた正方形にする。CSS の aspect-ratio
    // では、幅と高さの両方に上限がある状況で正方形を保てない（片方の制約に
    // 負けて長方形になり、MiniBoard は短辺基準の正方形を左上に寄せて描くので
    // 中央からずれる）。実測して px で決める。
    if (typeof ResizeObserver === 'function') {
      this.specRO = new ResizeObserver(() => this.sizeSpectateBoard());
      this.specRO.observe(box.querySelector('.rl-spec-stage'));
    }
    this.sizeSpectateBoard();
    return box;
  }

  // 観戦の箱を畳む。ResizeObserver を切らないと、破棄されたモードの
  // MiniBoard が画面の回転のたびに生き返る。
  clearSpectateView() {
    if (this.specRO) { this.specRO.disconnect(); this.specRO = null; }
    const el = document.querySelector('.rl-spectate');
    if (el) el.remove();
    this.specBoard = null;
    this.specSide = 0;
    this.specPickerSig = null;
    this.specPickShown = null;
    this.watchTarget = null;
    this.watchWait = 0;
    this.spectatingRoom = false;
  }

  sizeSpectateBoard() {
    const box = document.querySelector('.rl-spectate');
    const stage = box && box.querySelector('.rl-spec-stage');
    const cv = stage && stage.querySelector('.rl-spec-canvas');
    if (!cv) return;
    const r = stage.getBoundingClientRect();
    const side = Math.floor(Math.max(0, Math.min(r.width, r.height)));
    // 同じ値を代入し直さない。ResizeObserver の中で子の大きさを変えるので、
    // 毎回書くと「観測 → 変更 → 観測」で鳴りっぱなしになりうる。
    if (!side || side === this.specSide) return;
    this.specSide = side;
    cv.style.width = `${side}px`;
    cv.style.height = `${side}px`;
    if (this.specBoard) this.specBoard.render();
  }

  // 見たい相手をサーバーへ頼む。返事（watch.name）が来るまでは「頼んだだけ」
  // なので、見出しも一覧の選択も**サーバーが送ってきた名前**で描く。
  // 先に自分で選択を動かすと、サーバーがまだ対応していない実装のときに
  // 「選んだのに別の人の盤面が出ている」という嘘の画面になる。
  requestWatch(target) {
    this.watchTarget = target;
    this.client.send({ type: 'watch', target: target || null });
    const box = document.querySelector('.rl-spectate');
    if (box) box.classList.add('waiting');
  }

  /**
   * 観戦ビューの中身を更新する。royale_state / room_update の両方から呼ぶ。
   * info: { name, score, grid, sub, watchable, finale, note }
   */
  updateSpectateView(info) {
    const box = this.mountSpectateView();
    if (!box) return;
    const name = info.name || '';
    const rows = info.watchable || [];
    // 頼んだ相手に切り替わるまでは「待機」。ただし**待ちっぱなしにしない**:
    //  ・見たかった相手が一覧から消えた（脱落・離脱）なら、サーバーは勝手に
    //    おまかせ（首位）へ戻す（server/battle.js の pickWatch）。こちらが
    //    希望を握ったままだと、薄暗い待機の盤面から二度と戻らない。
    //  ・一覧に居るのに5回（≒5秒）待っても切り替わらないなら、その希望は
    //    サーバーに届いていない。映っている盤面を素直に見せるほうがまし。
    if (this.watchTarget && this.watchTarget !== name) {
      this.watchWait = (this.watchWait || 0) + 1;
      const gone = rows.length && !rows.some(r => r.name === this.watchTarget);
      if (gone || this.watchWait >= 5) { this.watchTarget = null; this.watchWait = 0; }
    } else {
      this.watchWait = 0;
    }
    box.classList.toggle('waiting', !!this.watchTarget && this.watchTarget !== name);
    box.querySelector('.rl-spec-head').innerHTML = ic('spectate', 15) + ' ' + (name
      ? t(`観戦中: <b>${escapeHtml(name)}</b>`, `Spectating <b>${escapeHtml(name)}</b>`)
      : t('観戦できる相手を探しています…', 'Looking for someone to watch…'));
    box.querySelector('.rl-spec-sub').textContent = info.sub || '';
    box.querySelector('.rl-spec-stage').classList.toggle('empty', !name);
    this.sizeSpectateBoard();
    // grid が来ていない回は前の盤面を残す（MiniBoard.setGrid が長さを見て弾く）。
    // name と grid は同じ watch オブジェクトで届くので、名前だけ変わって
    // 盤面が前の人のまま、という食い違いは起きない。
    if (this.specBoard && Array.isArray(info.grid)) this.specBoard.setGrid(info.grid);
    this.renderWatchPicker(box, name, rows, info.note || '');
  }

  // 観戦相手の一覧。スマホの縦持ちで盤面を潰さないよう、高さを固定した
  // 横スクロール1行に収める（折り返す形にすると、人数が増えたぶんだけ
  // 盤面が縮んでいく）。
  renderWatchPicker(box, watching, rows, note) {
    const list = box.querySelector('.rl-spec-picker');
    // 顔ぶれ・生死・選択が変わらない限り作り直さない。1秒ごとに innerHTML を
    // 差し替えると、横スクロールの位置が毎秒先頭へ戻って下位の人を押せなくなる。
    // watchTarget も鍵に入れる。首位を見ているときに「おまかせ」を押すと
    // watching は変わらないが、選択の印は移らないといけない。
    const pick = `${watching}|${this.watchTarget || ''}`;
    const sig = `${pick}|${note}|${rows.map(r => `${r.name}:${r.alive === false ? 0 : 1}`).join(',')}`;
    if (sig !== this.specPickerSig) {
      this.specPickerSig = sig;
      // 「見ている相手が変わったか」は別に持つ。順位は毎秒入れ替わるので、
      // 作り直したこと自体を「選び直した」とみなすと、下で毎秒スクロールを
      // 動かしてしまう。
      const pickChanged = pick !== this.specPickShown;
      this.specPickShown = pick;
      // 「おまかせ」＝ target:null。見ていた人が脱落しても、サーバーが
      // 勝手に首位へ移してくれる席。
      // 印は active ではなく on。active は「いま画面に映っている盤面」の印で、
      // おまかせで首位を見ていると相手の札と2つ同時に点き、どちらが盤面なのか
      // 読めなくなる（実機で実際にそうなった）。
      const auto = !this.watchTarget;
      const chips = [
        `<button class="rl-spec-chip auto${auto ? ' on' : ''}" data-watch-name="" aria-pressed="${auto ? 'true' : 'false'}">
           <span class="rl-chip-name">${t('おまかせ', 'Auto')}</span>
           <span class="rl-chip-note">${t('首位', 'Leader')}</span>
         </button>`,
      ];
      rows.forEach((r, i) => {
        const dead = r.alive === false;
        const on = r.name === watching;
        const rank = i + 1;
        const medal = medalIconName(rank);
        chips.push(`
          <button class="rl-spec-chip${on ? ' active' : ''}${dead ? ' dead' : ''}"
                  data-watch-name="${escapeHtml(r.name)}" ${dead ? 'disabled' : ''}
                  aria-pressed="${on ? 'true' : 'false'}">
            <span class="rl-chip-rank">${medal ? icon(medal, { size: 14 }) : `#${rank}`}</span>
            <span class="rl-chip-name">${escapeHtml(r.name)}</span>
            <b class="rl-chip-score" data-score-for="${escapeHtml(r.name)}">${fmt(r.score || 0)}</b>
            ${dead ? `<span class="rl-chip-dead">${icon('close', { size: 12 })}</span>`
                   : on ? `<span class="rl-chip-on">${icon('check', { size: 12 })}</span>` : ''}
          </button>`);
      });
      // 横スクロールの位置は自力で持ち帰る。innerHTML の差し替えは中身ごと
      // 作り直すので scrollLeft が 0 に戻る ── ロイヤルでは上位20人の順位が
      // 毎秒入れ替わる＝毎秒作り直すので、下位まで送った帯が1秒ごとに先頭へ
      // 跳ね返って**そもそも下の人を押せなくなる**。
      const keep = list.scrollLeft;
      list.innerHTML = (note ? `<span class="rl-spec-note">${escapeHtml(note)}</span>` : '') + chips.join('');
      list.scrollLeft = keep;
      // 見ている相手が変わったときだけ、その札を目に入れる。しかも**はみ出して
      // いるときだけ**動かす ── scrollIntoView({inline:'center'}) は見えていても
      // 中央へ寄せるので、先頭の「🔥 ファイナル」と「おまかせ」を押し出していた
      // （実機で確認: 札を出した直後から scrollLeft が 77px 進んでいた）。
      const act = pickChanged ? list.querySelector('.rl-spec-chip.active') : null;
      if (act) {
        const lr = list.getBoundingClientRect(), ar = act.getBoundingClientRect();
        if (ar.left < lr.left) list.scrollLeft -= (lr.left - ar.left) + 12;
        else if (ar.right > lr.right) list.scrollLeft += (ar.right - lr.right) + 12;
      }
    } else {
      // 作り直さない回でも点数だけは動かす（毎秒更新される唯一の値）。
      for (const r of rows) {
        const el = list.querySelector(`[data-score-for="${CSS.escape(r.name)}"]`);
        if (el) el.textContent = fmt(r.score || 0);
      }
    }
  }

  // ---- 💯 バトルロイヤルの観戦 --------------------------------------------
  //
  // ファイナル（残り3人）の3枚並べは廃止した。観戦ビューと同時に出すと、
  // 375x667 では盤面の下 1/4 を潰し、しかも1枚 54px（1マス 6.75px）で
  // 「何かが動いている」以上のことは読めなかった。残り3人は下の一覧に
  // 🔥 の印で出し、盤面はいつでも1枚を大きく見せる ── 見たい人は一覧で
  // 切り替えられるので、情報としては3枚並べより多い。
  renderRoyaleSpectate(msg) {
    const rows = this.royaleWatchable(msg);
    // ファイナル中は3人ぶんの盤面が finale で届く。サーバーが target を
    // まだ見ていない実装でも、選んだ相手の盤面をここで差し替えられる。
    let shown = msg.watch || null;
    if (this.watchTarget && Array.isArray(msg.finale)) {
      const f = msg.finale.find(p => p && p.name === this.watchTarget);
      if (f) shown = f;
    }
    const name = shown ? shown.name : '';
    const rank = rows.findIndex(r => r.name === name) + 1;
    const parts = [];
    if (shown) parts.push(fmt(shown.score));
    if (rank) parts.push(`#${rank}`);
    parts.push(t(`残り${msg.alive}人`, `${msg.alive} alive`));
    parts.push(`${msg.remain}s`);
    this.updateSpectateView({
      name,
      score: shown ? shown.score : 0,
      grid: shown ? shown.grid : null,
      sub: parts.join(' ・ '),
      watchable: rows,
      note: msg.finale && msg.finale.length ? ic('fire', 13) + ' ' + t('ファイナル', 'FINALE') : '',
    });
  }

  // 一覧の元ネタ。サーバーが watchable を送ってくればそれが正（順位順・
  // 上位20人）。まだ送ってこない間も一覧を空にしないよう、royale_state が
  // 前から積んでいる finale（残り3人）・top（上位3人）・いま見ている人から
  // 組み立てて代用する。どちらの経路も name / score / alive しか触らない。
  royaleWatchable(msg) {
    if (Array.isArray(msg.watchable)) {
      return msg.watchable.slice(0, this.watchListMax).map(r => ({
        name: r.name, score: Number(r.score) || 0, alive: r.alive !== false,
      }));
    }
    const seen = new Map();
    const add = (name, score) => {
      if (!name || seen.has(name)) return;
      seen.set(name, { name, score: Number(score) || 0, alive: true });
    };
    for (const p of msg.finale || []) add(p.name, p.score);
    for (const p of msg.top || []) add(p.name, p.score);
    if (msg.watch) add(msg.watch.name, msg.watch.score);
    return [...seen.values()].sort((a, b) => b.score - a.score);
  }

  onRoyaleCut(msg) {
    audio.bossAttack();
    if (view) view.shake = 8;
    toast(t(`足切り！${msg.eliminated}人脱落 — 残り${msg.alive}人`, `The cut! ${msg.eliminated} eliminated — ${msg.alive} remain`), 'announce', 2400);
  }

  onRoyaleFinaleStart(msg) {
    toast(t(`ファイナル！ 残り${msg.players.length}人`, `FINALE — ${msg.players.length} left`), 'announce', 3000);
  }

  // Everyone learns who actually won — including the people cut at 30 seconds.
  onRoyaleOver(msg) {
    this.clearRoyaleOverlays();
    if (!msg.winner) return;
    // royale_result lands microseconds before this. Opening a second modal
    // here wiped the player's OWN placement, KOs and payout off the screen
    // before they could read it — fold the champion into that card instead.
    // (The result card deliberately does NOT show a "🥇 leader" row of its own:
    // that was a snapshot of the standings at the moment you were knocked out,
    // so an early leader who got buried saw "🥇 you" above "#70 / 100". The
    // champion row appended here is the real answer.)
    const open = document.querySelector('.modal .result-stats');
    if (open && this.sawRoyaleResult) {
      const row = document.createElement('div');
      row.className = 'rs-row';
      row.innerHTML = `<span>${ic('medal_1')} ${t('優勝', 'Champion')}</span><b>${escapeHtml(msg.winner.name)} — ${fmt(msg.winner.score)}${msg.winner.kills ? ` ・ ${msg.winner.kills}KO` : ''}</b>`;
      open.appendChild(row);
      return;
    }
    const rows = (msg.top || []).map((x, i) => `
      <div class="rs-row"><span>${medalIconName(i + 1) ? icon(medalIconName(i + 1), { size: 18 }) : `#${i + 1}`} ${escapeHtml(x.name)}</span><b>${fmt(x.score)}${x.kills ? ` ・ ${x.kills}KO` : ''}</b></div>`).join('');
    const m = showModal(`
      <div class="result-banner win">${ic('medal_1', 26)} ${escapeHtml(msg.winner.name)}</div>
      <p class="muted center">${t('100人の頂点', 'Last one standing of 100')}</p>
      <div class="result-stats">${rows}</div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-oni" id="rAgain">${t('もう一度参戦', 'Drop in again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline('royale'); };
  }

  clearRoyaleOverlays() {
    this.clearSpectateView();
    $('#oppPanel').classList.remove('royale-panel');
    const vs = document.querySelector('.vs-bar');
    if (vs) vs.classList.remove('hidden');
  }

  onRoyaleResult(msg) {
    // Being eliminated is not the end of the session any more: unless this was
    // the final standing, the socket stays open so you can watch the finish.
    const spectate = !!msg.spectate;
    this.royaleDead = true;
    this.sawRoyaleResult = true;   // royale_over folds into this card, not over it
    if (!spectate) this.ended = true;
    clearInterval(this.stateInt);
    this.stopTimer();
    getView().inputLocked = true;
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    const win = msg.placement === 1;
    if (win) { audio.victory(); confettiBurst(90); }
    else if (msg.placement <= 10) audio.victory();
    else audio.gameOver();
    if (msg.rewards && msg.rewards.badge === 'royale') {
      setTimeout(() => toast(t('バッジ「百人の頂点」を獲得！ ジェム+150', 'Badge earned: Apex of 100! +150 gems'), 'announce', 5000), 1200);
    }
    const banner = win ? `${ic('medal_1', 26)} ${t('1位！VICTORY!', '#1 VICTORY!')}` : `#${msg.placement} / ${msg.players}`;
    const tierName = {
      champion: t('優勝', 'Champion'), podium: t('表彰台', 'Podium'),
      top10: t('TOP10', 'Top 10'), top25: t('TOP25', 'Top 25'),
      top50: t('TOP50', 'Top 50'), entrant: t('参加', 'Entrant'),
    }[msg.payout ? msg.payout.tier : 'entrant'];
    const m = showModal(`
      <div class="result-banner ${win ? 'win' : msg.placement <= 10 ? 'draw' : 'lose'}">${banner}</div>
      ${msg.placement <= 10 && !win ? `<p class="muted center">${t('TOP10入り！すごい！', 'Top 10 finish — amazing!')}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('最終順位', 'Final placement')}</span><b>#${msg.placement} / ${msg.players}</b></div>
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(msg.score)}</b></div>
        <div class="rs-row"><span>${t('KO数', 'Knockouts')}</span><b>${msg.kills || 0}</b></div>
        ${/* 順位の帯（優勝／表彰台…）は誰にでも出す。金額は **実際に入ったときだけ**
              出す ── ゲストには1枚も入らないのに「+1200🪙 +40💎」と書いてあり、
              残高が動かないのを見た人には不具合にしか見えなかった。
              古いサーバー（payoutGranted を送ってこない）では従来どおり出す。 */''}
        ${msg.payout && (msg.payoutGranted !== false)
          ? `<div class="rs-row"><span>${ic('leaderboard')} ${t('順位報酬', 'Placement reward')}（${tierName}）</span><b>+${fmt(msg.payout.coins)} ${ic('coins', 14)}${msg.payout.gems ? ` +${fmt(msg.payout.gems)} ${ic('gems', 14)}` : ''}</b></div>`
          : msg.payout
            ? `<div class="rs-row"><span>${ic('leaderboard')} ${t('順位', 'Placement')}（${tierName}）</span><b class="muted">${t('報酬はアカウントが必要です', 'An account is needed to earn rewards')}</b></div>`
            : ''}
        ${rewardsRows(msg.rewards)}
      </div>
      ${spectate ? `<div class="modal-buttons">
        <button class="btn btn-online" id="rWatch">${ic('spectate', 15)} ${t('決着を見届ける', 'Watch the finish')}</button>
      </div>` : ''}
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-oni" id="rAgain">${t('もう一度参戦', 'Drop in again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.ended = true; this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = true; this.destroy(); startOnline('royale'); };
    const w = m.querySelector('#rWatch');
    if (w) w.onclick = () => {
      closeModal();
      // ルームの観戦席とまったく同じ後始末をする（リロール・奥義・エモート・
      // アイテムバーを隠し、入力を閉じる）。ここに書かないと、脱落後の観戦中に
      // リロールが残数つきで出たまま、押しても何も起きないボタンになる。
      this.enterSpectatorHud();
      $('#hudSub').innerHTML = ic('spectate', 13) + ' ' + t('観戦中', 'SPECTATING');
      toast(t('観戦モード — 決着がついたら結果が出ます', 'Spectating — the result appears when it is over'), 'announce', 3000);
    };
  }


  // ---- tournament bracket (between rounds) ----

  tourneyRoundName(pairCount) {
    return pairCount === 4 ? t('準々決勝', 'Quarterfinal')
      : pairCount === 2 ? t('準決勝', 'Semifinal')
      : t('決勝', 'Final');
  }

  onTourneyState(msg) {
    if (this.ended) return;
    this.inMatch = false;   // between rounds — ready for the next match_found
    const mark = e => `${e.you ? ic('user', 13) + '<b>' : ''}${escapeHtml(e.name)}${e.you ? '</b>' : ''}${e.rating != null ? ` <small class="muted">R${e.rating}</small>` : ''}`;
    const rows = msg.pairs.map(p =>
      `<div class="rs-row"><span>${mark(p[0])}</span><span style="opacity:.6">${ic('seat_play', 14)}</span><span>${mark(p[1])}</span></div>`).join('');
    showModal(`
      <h2>${ic('mode_tourney', 22)} ${t('トーナメント', 'Tournament')} — ${this.tourneyRoundName(msg.pairs.length)}</h2>
      <div class="result-stats">${rows}</div>
      <p class="muted center" style="margin-top:8px">${t('まもなく対戦開始…', 'Match starting soon…')}</p>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="tqLeave">${t('離脱する', 'Leave')}</button>
      </div>`, { dismissable: false });
    // 出口を必ず1つ残す。このモーダルは画面を覆うので、ボタンが一つも無いと
    // ✕ さえ押せない ── 次の対戦が永久に来ない経路（不戦勝の優勝・外からの
    // 中止）に入ると、リロードしか逃げ道が無かった。
    const leave = m.querySelector('#tqLeave');
    if (leave) leave.onclick = () => { audio.click(); closeModal(); this.quit(); };
    audio.click();
  }

  // 🏆 大会が外から中止された。ラウンド間なら閉じ口の無い
  // ブラケットの前で固まっているので、こちらから畑む。
  onTourneyCancelled() {
    if (this.ended) return;
    this.ended = true;
    this.inMatch = false;
    closeModal();
    this.destroy();
    toast(t('サーバー更新のためトーナメントは中止になりました',
      'The tournament was cancelled for a server update'), 'err', 5000);
    endToMenu();
  }

  // 🏆 優勝した。
  //
  // ふつうは決勝が endMatch を通るので、その result が優勝の結果画面になる。
  // ところが**決勝の相手が切断すると不戦勝**になり、endMatch を通らないので
  // result が1つも来ない。ここで紙吹雪だけ上げていたので、直前に出ている
  // ブラケット（dismissable:false・ボタン0個・「まもなく対戦開始…」）が
  // そのまま残り、優勝者はリロードするまで**閉じ口の無い画面に閉じ込められ**、
  // しかも実際に付いたバッジと💎が画面に一度も出なかった。
  onTourneyChampion(msg = {}) {
    confettiBurst(70);
    audio.victory();
    this.inMatch = false;
    this.ended = true;
    // サーバーが不戦勝ぶんの報酬を付けてくれている。上部バーに反映する。
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    // 決勝を戦って勝った場合は、その result モーダルが既に出ている。
    // 上書きすると自分のスコアや相手が消えるので、紙吹雪だけ足す
    // （ロイヤルの sawRoyaleResult と同じ作法）。
    if (document.querySelector('.modal .result-stats')) return;
    const m = showModal(`
      <div class="result-banner win">${ic('medal_1', 26)} ${t('優勝！', 'CHAMPION!')}</div>
      <p class="muted center">${t('オンライントーナメントを制した', 'You won the online tournament')}</p>
      ${msg.rewards ? `<div class="result-stats">${rewardsRows(msg.rewards)}</div>` : ''}
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-gold" id="rAgain">${t('もう一度', 'Again')}</button>
      </div>`, { dismissable: false });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline('tourney'); };
  }

  // ---- match ----

  // ---- 🤝 Co-op: two players, one board, alternating turns -----------------
  //
  // The server owns the board. We keep a mirror Engine on the same seed and
  // replay each confirmed move, so placements animate exactly like solo ones
  // while staying byte-identical on both clients.

  setupCoop(msg) {
    this.isCoop = true;
    const me = msg.players.find(p => p.isYou);
    const partner = msg.players.find(p => !p.isYou);
    this.mySlot = msg.you.slot;
    this.partnerName = partner ? partner.name : '???';
    this.coopTurn = 0;
    this.coopTurnRemain = 0;
    this.coopTurnMs = 15000;

    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#hudTimer').classList.add('hidden');
    $('#coopBar').classList.remove('hidden');
    showItemBar(false);   // shared board: no boosters, no ultimates

    const v = getView();
    v.setTheme(equippedTheme());
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onGameOver = () => { /* the server decides when a co-op run is over */ };
    v.onPlace = () => this.updateCoopHud();
    // Hand every drop to the server instead of applying it locally.
    v.onIntentPlace = (index, row, col) => {
      if (this.coopTurn !== this.mySlot || this.ended) {
        audio.error();
        toast(t(`いまは${this.partnerName}さんの番です`, `It's ${this.partnerName}'s turn`), 'err', 1200);
        return true;
      }
      this.client.send({ type: 'coop_place', index, row, col });
      v.inputLocked = true;          // lock until the server confirms
      return true;
    };
    // 協力プレイの手札はサーバーが持ち主。ローカルのミラー engine だけを引き直すと
    // 盤面/手札が desync するため、パズル遺跡と同じくリロールを二重に封じる。
    $('#btnReroll').classList.add('hidden');
    this.engine.rerolls = 0;
    this.engine.reroll = () => false;
    updateAutoBtn();
    v.start();
    audio.playTrack('solo');
    this.updateCoopHud();

    const emoteBtn = $('#btnEmote');
    emoteBtn.classList.remove('hidden');
    emoteBtn.onclick = () => this.toggleEmotePicker();

    toast(t(`${this.partnerName}さんと協力プレイ！交互にピースを置いて高得点を狙おう`,
      `Co-op with ${this.partnerName}! Take turns placing pieces for a shared high score`), 'announce', 4000);

    countdownOverlay(msg.countdown || 3, afterCountdown(this, () => {
      if (this.ended) return;
      this.coopStarted = true;
      this.applyCoopTurn();
      this.coopInt = setInterval(() => this.tickCoopBar(), 120);
    }), audio);
  }

  onCoopState(msg) {
    if (this.ended || !this.engine) return;
    // Replay the confirmed move on the mirror board.
    if (msg.move) {
      const result = this.engine.place(msg.move.index, msg.move.row, msg.move.col);
      if (result) {
        getView().applyResult(result);
        if (msg.move.slot !== this.mySlot) {
          const el = $('#hudSub');
          el.classList.remove('coop-flash'); void el.offsetWidth; el.classList.add('coop-flash');
        } else if (msg.move.auto) {
          // 自分の手番が時間切れでサーバーに置かれた。今まで何の断りも
          // 無く石が置かれていて、何が起きたのか分からなかった。
          audio.error();
          toast(t('時間切れ ── かわりに置きました', 'Out of time — the server placed it for you'), 'err', 2600);
        }
      }
    }
    // Authoritative resync — cheap insurance against any drift.
    if (Array.isArray(msg.grid)) {
      const mine = this.engine.snapshot();
      if (msg.grid.some((v, i) => v !== mine[i])) {
        for (let i = 0; i < msg.grid.length; i++) this.engine.grid[i] = msg.grid[i];
        console.warn('[coop] board resynced from server');
      }
    }
    this.applyCoopHand(msg.hand);
    if (typeof msg.score === 'number') this.engine.score = msg.score;
    this.coopTurn = msg.turn;
    this.coopTurnRemain = msg.turnRemain || 0;
    this.coopTurnMs = msg.turnMs || 15000;
    this.coopTurnAt = Date.now();
    this.coopMoves = msg.moves || 0;
    this.applyCoopTurn();
    this.updateCoopHud();
  }

  // 手札もサーバーが持ち主。盤面と違って自前で描いているだけなので、
  // ズレたまま置こうとすると永久に弾かれる。番号から作り直す。
  applyCoopHand(hand) {
    if (!Array.isArray(hand) || !this.engine) return;
    // getView() ではなくモジュール変数を見る。getView() はテーマの再適用と
    // resize を伴う mutating accessor で、手が変わるたびに呼ぶものではない。
    const v = view;
    // 掴んだままの枠がサーバー側で入れ替わっていたら、そのドラッグは捨てる。
    // 指の下の絵は「掴んだときのピース」のまま、engine.hand[i] は別物になるので、
    // 離しても game.js の `hand[index] !== piece` ガードで必ず弾かれる ──
    // 置けない物を掴ませ続けても、嘘のゴーストを見せるだけで意味がない。
    // （自分の手番が時間切れでサーバーに代打ちされた回がこれ。putback の音は
    //  呼び出し元の onCoopState / onCoopReject が既に鳴らしているので鳴らさない）
    const dropDrag = i => { if (v && v.drag && v.drag.index === i) v.drag = null; };
    for (let i = 0; i < 3; i++) {
      const idx = hand[i];
      const cur = this.engine.hand[i];
      if (idx == null) { dropDrag(i); this.engine.hand[i] = null; continue; }
      const def = SHAPES[idx];
      if (!def) continue;
      // 同じ形が同じ枠にあるならオブジェクトを作り直さない ── 作り直すと
      // 掴んでいるピースと実体が別物になり、置けなくなる。
      if (cur && cur.shape === idx) continue;
      dropDrag(i);
      this.engine.hand[i] = { shape: idx, cells: def.cells, color: def.color };
    }
  }

  onCoopReject(msg) {
    if (!this.engine) return;
    if (Array.isArray(msg.grid)) {
      for (let i = 0; i < msg.grid.length; i++) this.engine.grid[i] = msg.grid[i];
    }
    this.applyCoopHand(msg.hand);
    this.coopTurn = msg.turn;
    this.applyCoopTurn();
    audio.putback();
    // 無言で盤面が戻ると「バグった」ようにしか見えない。理由を出す。
    toast(t('その手は間に合いませんでした（盤面を合わせ直しました）',
      'That move did not make it in time — the board has been resynced'), 'err', 2400);
  }

  applyCoopTurn() {
    if (!this.coopStarted || this.ended) return;
    getView().inputLocked = this.coopTurn !== this.mySlot;
  }

  updateCoopHud() {
    if (!this.engine) return;
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const mine = this.coopTurn === this.mySlot;
    if (this.engine.streak >= 2) {
      $('#hudSub').textContent = t(`${this.engine.streak} コンボ！`, `${this.engine.streak} COMBO!`);
    } else {
      $('#hudSub').innerHTML = ic('mode_coop', 13) + ' ' + t('きょうりょくスコア', 'SHARED SCORE');
    }
    const label = $('#coopTurnLabel');
    label.textContent = mine
      ? t('あなたの番！', 'Your turn!')
      : t(`${this.partnerName}さんの番…`, `${this.partnerName} is thinking…`);
    label.classList.toggle('mine', mine);
  }

  tickCoopBar() {
    if (this.ended) return;
    const total = this.coopTurnMs || 15000;
    const elapsed = Date.now() - (this.coopTurnAt || Date.now());
    const remain = Math.max(0, (this.coopTurnRemain || 0) - elapsed);
    const fill = $('#coopTurnFill');
    fill.style.width = `${Math.max(0, Math.min(100, (remain / total) * 100))}%`;
    fill.classList.toggle('urgent', remain < 4000 && this.coopTurn === this.mySlot);
  }

  // ---- 🚩 陣取りデュエル (mode 'land') ------------------------------------
  //
  // 協力プレイと同じ「サーバー権威の1盤面・交互の手番」だが、消したライン
  // 8マスがそのまま自分の領土になる（相手の色は上塗りできる）。勝敗は
  // 領土数 → 同数ならスコア。判定はすべてサーバーが持っているので、こちらは
  // ミラー Engine に確定手を再生して描き、領土を色で重ねるだけ。

  setupLand(msg) {
    this.isLand = true;
    const opp = msg.players.find(p => !p.isYou);
    this.mySlot = msg.you.slot;
    this.myOwner = msg.you.slot + 1;    // owner の値は 0=中立 / 1=slot0 / 2=slot1
    this.oppName = opp ? opp.name : '???';
    this.landTurn = 0;
    this.landTurnRemain = 0;
    this.landTurnMs = 12000;
    this.landCounts = [0, 0];
    this.landScores = [0, 0];
    this.landEndsIn = (msg.duration || MATCH_SECONDS) * 1000;

    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#coopBar').classList.remove('hidden');
    showItemBar(false);   // 共有盤面: アイテムも奥義も無し

    const v = getView();
    v.setTheme(equippedTheme());
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = null;
    v.onGameOver = () => { /* 終わりを決めるのはサーバー */ };
    // 置く操作はすべてサーバーへ投げる。確定手は land_state で返ってくる。
    v.onIntentPlace = (index, row, col) => {
      if (this.ended) return true;
      if (this.landTurn !== this.mySlot) {
        audio.error();
        toast(t(`いまは${this.oppName}さんの番です`, `It's ${this.oppName}'s turn`), 'err', 1200);
        return true;
      }
      this.client.send({ type: 'land_place', index, row, col });
      v.inputLocked = true;          // サーバーの返事が来るまで固定
      return true;
    };
    // 手札もサーバーが持ち主。協力プレイと同じくリロールを二重に封じる。
    $('#btnReroll').classList.add('hidden');
    this.engine.rerolls = 0;
    this.engine.reroll = () => false;
    this.landOverlay = new CellOverlay();
    updateAutoBtn();
    v.start();
    audio.playTrack('battle');
    this.updateLandHud();

    const emoteBtn = $('#btnEmote');
    emoteBtn.classList.remove('hidden');
    emoteBtn.onclick = () => this.toggleEmotePicker();

    toast(t(`${this.oppName}さんと陣取り！ ラインを消したマスがあなたの色になる ── 広いほうが勝ち！`,
      `Land Grab vs ${this.oppName}! Every square you clear turns your colour — most territory wins!`), 'announce', 4200);

    countdownOverlay(msg.countdown || 3, afterCountdown(this, () => {
      if (this.ended || currentMode !== this) return;
      this.landStarted = true;
      this.applyLandTurn();
      this.landInt = setInterval(() => this.tickLandBar(), 120);
    }), audio);
  }

  onLandState(msg) {
    if (this.ended || !this.engine || !this.isLand) return;
    // 確定した1手をミラー盤面に再生する（協力プレイとまったく同じ作法）。
    if (msg.move) {
      const result = this.engine.place(msg.move.index, msg.move.row, msg.move.col);
      if (result) {
        getView().applyResult(result);
        if (msg.move.slot === this.mySlot && msg.move.auto) {
          audio.error();
          toast(t('時間切れ ── かわりに置きました', 'Out of time — the server placed it for you'), 'err', 2600);
        }
        if (msg.move.took) {
          const mine = msg.move.slot === this.mySlot;
          const v = getView();
          v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.24,
            t(`${msg.move.took}マス獲得`, `+${msg.move.took} squares`),
            mine ? '#6bd97b' : '#ff6b6b', 1.5);
          if (mine) audio.coin();
        }
      }
    }
    // 権威の再同期 — ズレへの保険（協力プレイと同じ）。
    if (Array.isArray(msg.grid)) {
      const mine = this.engine.snapshot();
      if (msg.grid.some((v, i) => v !== mine[i])) {
        for (let i = 0; i < msg.grid.length; i++) this.engine.grid[i] = msg.grid[i];
        console.warn('[land] board resynced from server');
      }
    }
    this.applyCoopHand(msg.hand);   // 手札の作り直しは協力プレイと共通
    if (Array.isArray(msg.owner)) this.paintLand(msg.owner);
    if (Array.isArray(msg.counts)) this.landCounts = msg.counts;
    if (Array.isArray(msg.scores)) {
      this.landScores = msg.scores;
      this.engine.score = msg.scores[this.mySlot] || 0;
    }
    this.landTurn = msg.turn;
    this.landTurnRemain = msg.turnRemain || 0;
    this.landTurnMs = msg.turnMs || 12000;
    this.landTurnAt = Date.now();
    this.landEndsIn = msg.endsIn || 0;
    this.landEndsAt = Date.now() + this.landEndsIn;
    this.applyLandTurn();
    this.updateLandHud();
  }

  onLandReject(msg) {
    if (this.ended || !this.engine || !this.isLand) return;
    if (Array.isArray(msg.grid)) {
      for (let i = 0; i < msg.grid.length; i++) this.engine.grid[i] = msg.grid[i];
    }
    if (Array.isArray(msg.owner)) this.paintLand(msg.owner);
    if (Array.isArray(msg.scores)) this.landScores = msg.scores;
    this.applyCoopHand(msg.hand);
    this.landTurn = msg.turn;
    this.applyLandTurn();
    audio.putback();
    // 無言で盤面が戻ると「バグった」ようにしか見えない。理由を出す。
    toast(t('その手は通りませんでした（盤面を合わせ直しました）',
      'That move did not go through — the board has been resynced'), 'err', 2400);
  }

  // 領土を盤面の上に重ねる。自分＝--land-p1 の実線＋●、相手＝--land-p2 の破線＋✕
  // （色の見分けがつきにくい人にも持ち主が読めるよう、形でも分けている）。
  paintLand(owner) {
    if (!this.landOverlay) return;
    const marks = new Map();
    for (let k = 0; k < 64; k++) {
      const o = owner[k] | 0;
      if (!o) continue;
      marks.set(k, o === this.myOwner ? 'own_me' : 'own_foe');
    }
    this.landOverlay.set(marks);
  }

  applyLandTurn() {
    if (!this.landStarted || this.ended) return;
    getView().inputLocked = this.landTurn !== this.mySlot;
  }

  updateLandHud() {
    if (!this.engine) return;
    const el = $('#hudScore');
    const sc = this.engine.score;
    el.textContent = fmt(sc);
    applyScoreFit(el, fmt(sc));
    // ⚠ 点が動いたときだけ跳ねさせる。tickLandBar が 0.12秒ごとにここを呼ぶので、
    //    無条件に bumpScore すると 0.25秒のアニメが頭から再生され続け、
    //    数字がずっと1.2倍・黄色で震えたままになる ── 「点が入った合図」が
    //    常時鳴っている状態なので、実際に領土を取った瞬間の合図が埋もれる。
    if (sc !== this._lastLandScore) { this._lastLandScore = sc; bumpScore(el); }
    const mineCount = this.landCounts[this.mySlot] || 0;
    const foeCount = this.landCounts[1 - this.mySlot] || 0;
    $('#hudSub').textContent = t(`あなた ${mineCount} ・ ${this.oppName} ${foeCount}`,
      `You ${mineCount} ・ ${this.oppName} ${foeCount}`);
    const tm = $('#hudTimer');
    const left = Math.max(0, Math.ceil((this.landEndsAt ? this.landEndsAt - Date.now() : this.landEndsIn) / 1000));
    tm.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    tm.classList.toggle('urgent', left <= 15);
    const mine = this.landTurn === this.mySlot;
    const label = $('#coopTurnLabel');
    label.textContent = mine
      ? t('あなたの番！', 'Your turn!')
      : t(`${this.oppName}さんの番…`, `${this.oppName} is thinking…`);
    label.classList.toggle('mine', mine);
  }

  tickLandBar() {
    if (this.ended) return;
    const total = this.landTurnMs || 12000;
    const elapsed = Date.now() - (this.landTurnAt || Date.now());
    const remain = Math.max(0, (this.landTurnRemain || 0) - elapsed);
    const fill = $('#coopTurnFill');
    fill.style.width = `${Math.max(0, Math.min(100, (remain / total) * 100))}%`;
    fill.classList.toggle('urgent', remain < 4000 && this.landTurn === this.mySlot);
    this.updateLandHud();
  }

  onMatchFound(msg) {
    // 「敗退表示のまま次のラウンドが来た」回だけ、下の2つのガードを飛び越える。
    //
    // ended だけを緩めても効かない。onResult の敗退分岐は inMatch を true の
    // まま残し、次に来る tourney_state も onTourneyState 冒頭の
    // `if (this.ended) return;` で捨てられるので、inMatch は下がる機会が無い。
    // つまり手前の重複ガードで必ず弾かれて、緩めた意味が消えていた。
    // revive は ended が立っている＝result を受けた後にしか真にならないので、
    // 試合中の重複 match_found（inMatch=true / ended=false）は今までどおり弾ける。
    const revive = this.ended && !!msg.tourney;
    if (this.inMatch && !revive) return;      // guard against duplicates
    // 大会の次ラウンドだけは this.ended でも受ける。onResult は
    // 「outcome が 'win' 以外＝敗退」で ended を立てるが、サーバーが引き分けを
    // 送ってくる経路（同点処理の順番、更新前の畳み込みなど）はこの先も
    // あり得る。そこで ended のまま次の match_found を捨てると、勝ち上がって
    // いる人が0点で不戦敗になる ── 一番高い代償を払う取りこぼしなので、
    // クライアント側にも受け皿を残しておく。
    // なお「引き分けも勝ち上がり扱いにする」直し方は採らない。更新のための
    // 停止（server/battle.js の endAllForShutdown）は意図的に引き分けで畳んで
    // 大会自体も終わらせるため、勝ち上がり扱いにすると閉じられない
    //「次のラウンドを待っています…」の前で固まるほうに倒れる。
    if (this.ended && !revive) return;
    this.ended = false;
    closeModal();                             // clear the bracket between rounds
    // 💬 前の試合のリアクション欄を必ず閉じる。
    // 「再戦」は destroy を通らない（WSを保ったまま次の試合に入る）ので、
    // ここで閉じないと reactState が開いたまま次の試合に持ち越され、
    // 試合中のエモートが盤面ではなく**消えたモーダルの中**へ吸い込まれる。
    clearReactionBar();
    this.inMatch = true;
    this.matchInfo = msg;
    this.matchMode = msg.mode;
    this.you = msg.you;
    this.isTeam = msg.mode === 'team';
    this.isRaid = msg.mode === 'raid';
    if (msg.mode === 'coop') { this.setupCoop(msg); return; }
    if (msg.mode === 'land') { this.setupLand(msg); return; }

    const others = msg.players.filter(p => !p.isYou).map(p => ({
      slot: p.slot,
      // ここは buildPanels 側で escapeHtml を通る「ただの文字」なので、
      // アイコン（SVG）を混ぜてはいけない。段位は名前で書く。
      name: `${p.name}${p.rating != null ? ` (${rankLabel(p.rating)} R${p.rating})` : ''}`,
      isAlly: (this.isTeam && p.team === msg.you.team) || this.isRaid,
    }));
    this.setupHud(msg.duration || MATCH_SECONDS);
    showItemBar(false);   // no boosters in PvP
    this.buildPanels(others);
    // ⚔️ 攻撃の駆け引きの帯。アタック戦だけ（他のモードにお邪魔は飛ばないので、
    // 出すと「0 / 0」が動かないまま盤面の高さだけ削ることになる）。
    // buildPanels のあと・getView() の前に生やすのが肝心 ── #oppPanel の高さが
    // 変わるので、canvas の採寸（下の getView()）より先でないと1回ぶんズレる。
    this.atkSent = 0;
    this.atkTaken = 0;
    // 前のラウンド（トーナメントは destroy を挟まずに次の match_found が来る）で
    // 予告中だったお邪魔を、配列ごと差し替えて取りこぼさない。
    this.clearGarbageTimers();
    if (this.matchMode === 'attack') {
      mountAtkStrip();
      updateAtkStrip(0, 0);
    } else {
      clearAtkStrip();
    }
    if (this.isTeam) {
      $('#teamTotals').classList.remove('hidden');
      this.refreshTeamHud();
    }
    if (this.isRaid && msg.boss) {
      this.raidBoss = msg.boss;
      this.raidHp = msg.boss.hp;
      // Raid already spends height on the ally strip — the boss gets the
      // one-line bar rather than the 72px block solo boss fights use.
      $('#bossPanel').classList.remove('hidden');
      $('#bossPanel').classList.add('slim');
      setBossFace($('#bossEmoji'), bossIconName(msg.boss.id), BOSS_FACE_SLIM);
      $('#bossName').textContent = t(msg.boss.name, catName(msg.boss));
      document.querySelector('.boss-atkbar').classList.add('hidden');
      this.updateRaidHp();
    }

    const v = getView();
    this.engine = new Engine(msg.seed);
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(this.isRaid ? 'boss' : 'battle');

    // Emotes: quick reactions relayed to everyone in the match.
    const emoteBtn = $('#btnEmote');
    emoteBtn.classList.remove('hidden');
    emoteBtn.onclick = () => this.toggleEmotePicker();

    // 🪪 対戦カード。3-2-1 の裏に重ねる（数字が前に出るように z-index を下げてある）。
    // 1対1のときだけ出る ── 中で players.length を見て自分で決める。
    const cardShown = showVersusCard(msg);
    // 「マッチしました！」のトーストは、カードが出たときだけ**出さない**。
    // トーストの置き場所は盤面の上端（＝カードの相手側のちょうど上）なので、
    // 重ねると2.6秒のあいだ相手の名前が読めなくなる ── いちばん見せたいものを
    // 自分で隠すことになる。カードは同じことを、もっと詳しく言っている。
    if (!cardShown) {
      toast(this.isRaid ? t(`レイド開始！${this.raidBoss ? this.raidBoss.name : ''}を倒せ！`, `Raid start! Take down ${this.raidBoss ? catName(this.raidBoss) : 'the boss'}!`)
        : this.isTeam ? t('チーム戦スタート！', 'Team battle start!') : t('マッチしました！', 'Match found!'), 'ok');
    }

    countdownOverlay(msg.countdown || 3, afterCountdown(this, () => {
      // カウントダウン中に不戦勝などで終わった試合を蘇らせない（タイマー/interval漏れ防止）
      if (this.ended || !this.inMatch) return;
      clearInterval(this.stateInt);
      v.inputLocked = false;
      this.startTimer(() => this.timeUp());
      this.stateInt = setInterval(() => this.pushState(), 900);
    }), audio);

    // 🎓 初めての対戦だけ、短いガイドを重ねる。攻撃の説明を出すかどうかは
    // matchMode で決まる（クラシック・2v2・トーナメントでは出さない）。
    // 3-2-1 の裏では読めないので、出るのは操作できるようになってから。
    maybeStartVersusTutorial(this, this.matchMode);
  }

  toggleEmotePicker() {
    const existing = document.querySelector('.emote-picker');
    if (existing) { existing.remove(); return; }
    const picker = document.createElement('div');
    picker.className = 'emote-picker';
    for (const e of ['👍', '🔥', '😂', '😭', '🎉', '😱', '💪', '😎', '👏', '🤯']) {
      const b = document.createElement('button');
      b.textContent = e;
      b.onclick = () => {
        this.client.send({ type: 'emote', emoji: e });
        this.floatEmote(e, 'me');
        audio.click();
        picker.remove();
      };
      picker.appendChild(b);
    }
    $('#screen-game').appendChild(picker);
    setTimeout(() => picker.remove(), 6000);
  }

  // ---- 🔌 再接続（server/battle.js の猶予 ＋ public/js/net.js の繋ぎ直し）----
  //
  // 4つとも「試合中にしか意味が無い」ので、まず inMatch / ended で門を閉める。
  // 結果画面まで来てから遅れて届いたぶんが、閉じた盤面の上に帯を残さないため。

  /** 自分が繋ぎ直しに行っている（net.js が刻みごとに1回ずつ上げる）。 */
  onReconnecting(msg) {
    if (this.ended || !this.inMatch) return;
    // 何回目かは出さない。「3回目」と言われても人にできることは無く、
    // 数字が増えるほど見捨てられた気持ちになるだけなので、状態だけを言う。
    // 盤面は動いたままなので「置き続けてよい」ことも一緒に伝える
    // ── ここで手を止めると、戻れたときに数十秒ぶん損をする。
    showNetBanner(
      `${ic('warn', 14)} <b>${t('接続が切れました', 'Connection lost')}</b>`
      + `<span>${t('つなぎ直しています… そのまま置いて大丈夫です', 'Reconnecting… keep playing, your board is safe')}</span>`,
      'warn'
    );
  }

  /** 自分が試合に戻れた。 */
  onMatchResumed(msg) {
    if (this.ended || !this.inMatch) return;
    flashNetBanner(`${ic('check', 14)} <b>${t('接続が戻りました', 'Back online')}</b>`);
    audio.pickup();
    // ⏱ 時計の合わせ直し。サーバーは猶予のあいだも試合の時計を止めていない
    // ので、こちらの endAt がズレていたら**サーバーが正しい**。
    // msg.elapsedMs は match.startedAt（＝match_found を送った瞬間）からの
    // 経過で、本当の終わりは startedAt + (countdown + duration) 秒。
    const cd = Number(msg.countdown);
    const dur = Number(msg.duration);
    const el = Number(msg.elapsedMs);
    if (Number.isFinite(cd) && Number.isFinite(dur) && Number.isFinite(el)) {
      const remain = (cd + dur) - el / 1000;
      // すでに時間切れなら触らない ── timeUp() が自分で走って結果を待つ。
      // 動いている時計（timerInt）があるときだけ差し替える。カウントダウン中に
      // 復帰した場合は startTimer がまだ呼ばれておらず、endAt を書いても
      // そのあとの startTimer が this.timeLeft から引き直して上書きするため。
      if (remain > 0 && this.timerInt) {
        this.timeLeft = remain;
        this.endAt = Date.now() + remain * 1000;
        this.updateTimerHud();
      }
    }
    // 相手の点は猶予のあいだ届いていない。復帰のフレームが今の点を持って
    // いるので、パネルをその場で合わせておく（次の opp_state を待つと、
    // 相手が置くまで古い点が出たままになる）。
    if (Array.isArray(msg.players)) {
      for (const p of msg.players) {
        if (p.isYou || typeof p.score !== 'number') continue;
        // grid / combo は載っていないので、点だけを渡す。updateOpp は
        // 欠けた欄には触らない（盤面のミニ表示は次の opp_state で埋まる）。
        this.updateOpp(p.slot, { score: p.score });
      }
      // 2v2 の合計欄は updateOpp では動かない（onOppState が別に呼んでいる）。
      // ここで呼ばないと、味方の点だけ猶予に入る前の数字で止まって見える。
      if (!this.isRaid) this.refreshTeamHud();
    }
  }

  /** 相手が猶予に入った（＝いま繋ぎ直しに行っている）。 */
  onOppUnstable(msg) {
    if (this.ended || !this.inMatch) return;
    // ⚠ 秘匿: 相手が誰なのかには触れない。席と残り秒だけ。
    const sec = Math.max(0, Math.floor(Number(msg.sec) || 0));
    // 🤝 味方が切れたのか、敵が切れたのかを見分ける。
    //
    // サーバーは敵味方の区別なく全員へ送るので、以前は 2v2 でもレイドでも
    // 「戻らなければあなたの勝ちです」と出ていた。showNetBanner は自動で
    // 消えないので、味方が戻らなければ**残り時間ずっと嘘を見せ続ける** ──
    // 粘る意味がある場面で「もう勝ち確定」と誤解させる、いちばん代償の
    // 高い嘘だった。レイドはそもそも「相手」が居ない。
    const who = (this.oppList || []).find(o => o.slot === msg.slot);
    const ally = !!(who && who.isAlly) || this.kind === 'raid';
    const head = ally
      ? t('味方の接続が不安定です', 'Your teammate’s connection is unstable')
      : t('相手の接続が不安定です', 'Opponent’s connection is unstable');
    const body = ally
      ? t('サーバーが席を埋めます（そのぶんの点は止まります）',
        'The server is covering their turns — their score is paused')
      : sec > 0
        ? t(`${sec}秒ほど待ちます。戻らなければあなたの勝ちです`, `Waiting about ${sec}s — if they don’t return, you win`)
        : t('少しだけ待っています…', 'Waiting a moment…');
    showNetBanner(`${ic('warn', 14)} <b>${head}</b><span>${body}</span>`, 'warn');
  }

  /** 相手が戻ってきた。 */
  onOppBack(msg) {
    if (this.ended || !this.inMatch) return;
    flashNetBanner(`${ic('check', 14)} <b>${t('相手が戻ってきました', 'Opponent is back')}</b>`);
  }

  showEmote(slot, emoji) {
    // 決着後のリアクション欄が開いている間は、盤面の上に浮かせるのではなく
    // そちらの吹き出しに入れる（結果モーダルが盤面を覆っているので、
    // 浮かせても暗幕の裏で誰にも見えない）。
    if (reactionIncoming(emoji)) return;
    this.floatEmote(emoji, slot);
    audio.pickup();
  }

  floatEmote(emoji, from) {
    const el = document.createElement('div');
    el.className = 'emote-float';
    let x = window.innerWidth / 2, y = window.innerHeight * 0.55;
    if (from === 'me') {
      y = window.innerHeight * 0.6;
      x = window.innerWidth * 0.25;
    } else {
      const scoreEl = document.querySelector(`[data-slot-score="${from}"]`);
      const card = scoreEl && scoreEl.closest('.opp-card');
      if (card) {
        const r = card.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
    }
    el.style.left = `${x - 27}px`;
    el.style.top = `${y - 27}px`;
    el.textContent = emoji;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }

  teamTotalsCalc() {
    const my = this.engine ? this.engine.score : 0;
    let allies = 0, theirs = 0;
    for (const p of this.matchInfo.players) {
      if (p.isYou) continue;
      const s = this.scores[p.slot] || 0;
      if (this.isTeam && p.team === this.you.team) allies += s;
      else theirs += s;
    }
    return { mine: my + allies, theirs };
  }

  refreshTeamHud() {
    const { mine, theirs } = this.teamTotalsCalc();
    this.updateBars(mine, theirs);
    if (this.isTeam) {
      $('#teamTotals').innerHTML =
        `<b class="tt-a">${fmt(mine)}</b><span class="muted"> vs </span><b class="tt-b">${fmt(theirs)}</b>`;
    }
  }

  pushState() {
    if (!this.engine || this.ended) return;
    // 復活ペナルティの巻き戻し防止 ── topout でロック中（復活待ち）や engine.over の
    // 間は「没収前スコア」を送らない。royale_topout 送信〜復活受信の窓で再申告されると
    // サーバーの1割ペナルティが巻き戻ってしまう。
    if (this.engine.over || (view && view.inputLocked)) return;
    this.client.sendState(this.engine.score, this.engine.streak, this.engine.linesCleared,
      this.engine.snapshot(), this.engine.piecesPlaced);
  }

  onPlace(result) {
    this.updateMyHud(this.engine);
    // レイドは全員が同じボスを殴る協力戦。onOppState が isRaid で vs-bar 更新を
    // 避けているのと同様、onPlace 側もスキップする（味方を敵側に描く綱引きを防ぐ）。
    if (!this.isRaid) this.refreshTeamHud();
    this.pushState();
    // 💥 アタック戦: 2ライン以上の消去は相手への攻撃になる
    if (this.matchMode === 'attack' && result && result.lineCount >= 2 && this.inMatch && !this.ended) {
      this.client.send({ type: 'attack', lines: result.lineCount, combo: result.streak });
      // 送った量は rules.js の attackCellsFor（＝サーバーの attackCells と同じ式）で
      // 先に出せる。実際に送る量を決めるのはサーバーなので、これは表示専用。
      const cells = attackCellsFor(result.lineCount, result.streak);
      const v = getView();
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.18,
        t('攻撃！', 'ATTACK!'), '#ff8a5c', 1.5);
      // 「何個送ったか」を2行目に。1行に混ぜると盤面の幅（8マス）を超える。
      v.addFloatText(v.boardX + v.boardSize / 2, v.boardY + v.boardSize * 0.18 + v.cell,
        t(`お邪魔 +${cells}`, `+${cells} garbage`), '#ffd75e', 1.05);
      attackLesson('sent', { lines: result.lineCount, cells });
      // 常設の帯にも足す。フロートテキストは1秒で消えるので「この試合で
      // どれだけ押しているのか」は数えていないと分からなかった。
      // ⚠️ ここで数えているのは**自己申告ぶん**。サーバーは捏造攻撃よけの
      //    バジェット（atkCellsCap）で削ることがあるので、相手に本当に
      //    届いた数と一致しない回がありうる。それでも出すのは
      //    「まとめて消すほど強い」を体で覚えるための目安だから。
      this.atkSent = (this.atkSent || 0) + cells;
      updateAtkStrip(this.atkSent, this.atkTaken || 0);
      audio.combo(2);
    }
  }

  onOppState(msg) {
    this.updateOpp(msg.slot, msg);
    if (!this.isRaid) this.refreshTeamHud();
  }

  updateRaidHp() {
    if (!this.raidBoss) return;
    const pct = Math.max(0, (this.raidHp / this.raidBoss.hp) * 100);
    $('#bossHp').style.width = `${pct}%`;
    $('#bossHpText').textContent = `${fmt(Math.max(0, this.raidHp))} / ${fmt(this.raidBoss.hp)}`;
  }

  onRaidState(msg) {
    if (!this.isRaid) return;
    const prev = this.raidHp;
    this.raidHp = msg.hp;
    this.updateRaidHp();
    if (msg.hp < prev) {
      const em = $('#bossEmoji');
      em.classList.remove('boss-hit'); void em.offsetWidth; em.classList.add('boss-hit');
    }
  }

  onRaidAttack(msg) {
    if (!this.isRaid || this.ended || !this.engine || !view || view.inputLocked) return;
    const cells = this.engine.addGarbage(msg.cells || 3);
    audio.bossAttack();
    const em = $('#bossEmoji');
    em.classList.remove('boss-atk'); void em.offsetWidth; em.classList.add('boss-atk');
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
    }
    view.shake = 12;
    toast(t(`${this.raidBoss.name}の攻撃！`, `${catName(this.raidBoss)} attacks!`), 'err', 1300);
    if (this.engine.over) this.onTopOut();
  }

  // 💥 アタック戦: 相手からのお邪魔ブロックが降ってくる
  //
  // 以前はこのフレームを受けた瞬間に盤面へ積んでいたので、遊んでいる側からは
  // 「突然ブロックが増えた」としか見えなかった（原因も量も画面に出ない）。
  // 受信 → **予告** → 着弾 の3段に割り、予告の一瞬だけ帯を光らせる。
  //
  // ⚠️ 量を決めるのはサーバー。ここは受け取った cells をそのまま運ぶだけで、
  //    rules.js の attackCellsFor は一切使わない（使うと二重の真実になる）。
  onGarbage(msg) {
    if (this.matchMode !== 'attack' || this.ended || !this.inMatch || !this.engine || !view) return;
    const cells = Math.max(1, Math.min(9, Number(msg.cells) || 2));
    const lines = Math.max(0, Math.min(8, Number(msg.lines) || 0));
    flashIncoming(cells, lines, GARBAGE_TELEGRAPH_MS);
    // 予告の音。エラー音・ボス攻撃音とは別の「近づいてくる」音にしておかないと、
    // 着弾（audio.bossAttack）と区別が付かない。
    audio.tone({ freq: 230, dur: 0.13, type: 'square', vol: 0.08, sweep: -50 });
    this.garbageTimers = this.garbageTimers || [];
    const id = setTimeout(() => {
      this.garbageTimers = (this.garbageTimers || []).filter(x => x !== id);
      this.landGarbage(cells, lines);
    }, GARBAGE_TELEGRAPH_MS);
    this.garbageTimers.push(id);
  }

  // 着弾。予告のあいだに試合が終わっていたら**降らせない**（もう関係ない盤面に
  // 積むと、結果モーダルの裏でブロックが増えて見えるだけになる）。
  landGarbage(cellCount, lines) {
    clearIncoming();
    if (this.ended || !this.inMatch || !this.engine || !view) return;
    const cells = this.engine.addGarbage(cellCount);
    audio.bossAttack();
    for (const [r, c] of cells) {
      view.spawnAnim.set(r * 8 + c, view.time);
      view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 9, 'fx_default');
    }
    view.shake = 10;
    view.addFloatText(view.boardX + view.boardSize / 2, view.boardY + view.boardSize * 0.3,
      t(`妨害 +${cells.length}！`, `+${cells.length} garbage!`), '#ff5d5d', 1.5);
    this.atkTaken = (this.atkTaken || 0) + cells.length;
    updateAtkStrip(this.atkSent || 0, this.atkTaken);
    // 何をされたのか（相手が何ラインまとめて消したのか）を最初の数回だけ教える。
    // 個数からの逆算は原理的にできない（3ライン＋コンボ6 と 4ライン はどちらも
    // 6個）ので、サーバーの 'garbage' が lines を載せている。載っていない古い
    // サーバーが相手なら 0 で来て「2ライン以上」までしか言わない（嘘は教えない）。
    attackLesson('taken', { lines, cells: cells.length });
    this.pushState();
    if (this.engine.over) this.onTopOut();
  }

  // 予告中のお邪魔を全部捨てる。試合が終わる／離脱する経路から必ず呼ぶこと。
  clearGarbageTimers() {
    for (const id of (this.garbageTimers || [])) clearTimeout(id);
    this.garbageTimers = [];
    clearIncoming();
  }

  onTopOut() {
    if (this.ended) return;
    // ロイヤルはリロール由来のトップアウトでもサーバー裁定（復活-10%/脱落）を
    // 経由させる。ここで無償の盤面ワイプにすると royale_topout が送られず抜け穴になる。
    if (this.isRoyale) return this.onRoyaleTopOut();
    toast(t('ボードリセット！スコアは維持されます', 'Board reset! Your score is kept'), '', 1800);
    this.engine.reviveBoard();
    getView().reviveFlash();
  }

  timeUp() {
    if (this.ended) return;
    getView().inputLocked = true;
    clearInterval(this.stateInt);
    this.client.finish(this.engine.score, this.engine.linesCleared, this.engine.maxCombo);
    showModal(`
      <h2>${t('集計中…', 'Tallying…')}</h2>
      <p class="muted center">${t('全員の結果を待っています', 'Waiting for all results')}</p>`, { dismissable: false });
    this.resultTimeout = setTimeout(() => {
      if (!this.ended) {
        this.ended = true;
        this.destroy();
        closeModal();
        toast(t('結果を受信できませんでした', 'Could not receive the results'), 'err');
        endToMenu();
      }
    }, 20000);
  }

  onCoopResult(msg) {
    this.ended = true;
    clearTimeout(this.resultTimeout);
    clearInterval(this.stateInt);
    clearInterval(this.coopInt);
    this.stopTimer();
    getView().inputLocked = true;
    $('#coopBar').classList.add('hidden');
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    const c = msg.coop;
    const isBest = c.score >= (c.best || 0) && c.score > 0;
    const localBest = Number(localStorage.getItem('bba_coop_best') || 0);
    if (c.score > localBest) localStorage.setItem('bba_coop_best', String(c.score));
    if (isBest) { audio.victory(); confettiBurst(70); } else audio.gameOver();
    const mine = msg.players.find(p => p.slot === msg.you.slot);
    const partner = msg.players.find(p => p.slot !== msg.you.slot);
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${ic('mode_coop', 26)} ${isBest ? t('新記録！', 'NEW RECORD!') : t('おつかれさま！', 'GOOD GAME!')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('きょうりょくスコア', 'Shared score')}</span><b>${fmt(c.score)}</b></div>
        <div class="rs-row"><span>${t('自己ベスト', 'Personal best')}</span><b>${fmt(Math.max(c.best || 0, localBest, c.score))}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(c.lines)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(c.combo)}</b></div>
        <div class="rs-row"><span>${t('置いたピース', 'Pieces placed')}</span><b>${t(`あなた ${mine ? mine.moves : 0} ・ ${partner ? escapeHtml(partner.name) : '?'} ${partner ? partner.moves : 0}`,
          `You ${mine ? mine.moves : 0} ・ ${partner ? escapeHtml(partner.name) : '?'} ${partner ? partner.moves : 0}`)}</b></div>
        ${rewardsRows(msg.rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-online" id="rAgain">${ic('mode_coop', 15)} ${this.kind === 'custom' ? t('ルームでもう一度', 'Team up in room') : t('もう一度組む', 'Team up again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    // カスタムルーム（4文字コード）で組んだ場合はルームへ戻す。公開キューに
    // 入れると同じ相棒と組める保証がないため this.kind をそのまま使う。
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startOnline(this.kind === 'custom' ? 'custom' : 'coop'); };
  }

  onResult(msg) {
    if (this.ended) return;
    // 🔌 接続の帯は「試合が続いているあいだ」の話なので、決着したら必ず畳む。
    // destroy() の clearBattleUi() まで待つと、再戦（destroy を通らない経路）
    // では結果モーダルの上に前の試合の警告が残ったままになる。
    clearNetBanner();

    // Tournament round won (not the final): stay in — the bracket and the
    // next match arrive from the server momentarily.
    if (msg.tourney && !msg.tourney.final && msg.outcome === 'win') {
      clearTimeout(this.resultTimeout);
      clearInterval(this.stateInt);
      this.stopTimer();
      getView().inputLocked = true;
      this.inMatch = false;
      if (msg.user) { session.user = msg.user; updateTopbar(); }
      audio.victory();
      const opp = msg.players.find(p => p.slot !== msg.you.slot);
      showModal(`
        <div class="result-banner win">${t('勝利！', 'Victory!')}</div>
        <div class="result-stats">
          <div class="rs-row"><span>${t('あなた', 'You')}</span><b>${fmt(msg.players.find(p => p.slot === msg.you.slot).score)}</b></div>
          ${opp ? `<div class="rs-row"><span>${escapeHtml(opp.name)}</span><b>${fmt(opp.score)}</b></div>` : ''}
        </div>
        <p class="muted center" style="margin-top:8px">${ic('mode_tourney', 15)} ${t('勝ち上がり！次のラウンドを待っています…', 'Advancing! Waiting for the next round…')}</p>`, { dismissable: false });
      return;
    }

    // Co-op: no winner, just a shared score and a shared personal best.
    if (msg.coop) { this.onCoopResult(msg); return; }

    this.ended = true;
    clearTimeout(this.resultTimeout);
    clearInterval(this.stateInt);
    clearInterval(this.landInt);
    // 予告中のお邪魔は捨てる（結果画面の裏で盤面が動くのを防ぐ）。
    this.clearGarbageTimers();
    this.stopTimer();
    getView().inputLocked = true;
    if (msg.user) { session.user = msg.user; updateTopbar(); }
    if (msg.outcome === 'win') { audio.victory(); confettiBurst(); } else audio.gameOver();
    // 📈 段位の昇格/降格
    //
    // to.name は「帯」ではなく**段**の表示名（『ゴールド II』）になった。
    // 「帯」を付けたままだと『ゴールド II帯に昇格！！』という日本語にならない
    // 文になるので落とす。帯だけが要るときは to.band.name を見ること。
    // 英語面（Promoted to Gold II!!）はもともと正しいのでそのまま。
    //
    // ⚠️ 昇格/降格の**トーストは出さない**（第5波で外した）。
    //   結果モーダルの見出し直下に resultRankBlock() が「ゴールド III ▲
    //   ゴールド II 昇格」を大きく出すようになったので、同じことを言う
    //   トーストは重複するだけでなく、置き場所（盤面の上端＝モーダルの
    //   ちょうど真ん中あたり）が **レート変動の数字に丸かぶり** していた。
    //   祝いの紙吹雪と音は残す ── 気づかせる役はそちらで足りる。
    if (msg.tierChange && msg.tierChange.up) {
      setTimeout(() => {
        confettiBurst(80);
        audio.levelUp();
      }, 700);
    }
    // 👑 王者撃破のお祝い。段位の昇格と重なっても潰し合わないよう、
    // 少し後ろにずらす（toast は同時3〜4件で頭打ちになる）。
    if (msg.beatChampion) {
      setTimeout(() => {
        confettiBurst(120);
        audio.levelUp();
        toast(t('アリーナ最強を破った！', 'You beat the strongest in the arena!'), 'announce', 5000);
      }, 1200);
    }

    const banners = msg.tourney
      ? { win: `${ic('mode_tourney', 26)} ${t('トーナメント優勝！！', 'TOURNAMENT CHAMPION!!')}`, lose: t('敗退…', 'Eliminated…'), draw: 'DRAW' }
      : msg.mode === 'raid'
      ? { win: `${icon(msg.boss ? bossIconName(msg.boss.id) : 'mode_raid', { size: 26 })} ${t('レイドボス討伐！', 'Raid boss down!')}`, lose: t('討伐失敗…', 'Raid failed…'), draw: 'DRAW' }
      : { win: 'YOU WIN!', lose: 'YOU LOSE…', draw: 'DRAW' };
    const roundNames = [t('準々決勝', 'the quarterfinal'), t('準決勝', 'the semifinal'), t('決勝', 'the final')];
    const tourneyNote = msg.tourney && msg.outcome !== 'win'
      ? `<p class="muted center">${t(`${roundNames[msg.tourney.round] || ''}で敗退しました`, `Knocked out in ${roundNames[msg.tourney.round] || 'the bracket'}`)}</p>`
      : msg.tourney ? `<p class="muted center">${t('8人トーナメントを制覇！', 'You conquered the 8-player bracket!')}</p>` : '';
    const reasonNote = tourneyNote + (
      msg.reason === 'forfeit' ? `<p class="muted center">${t('相手が切断しました', 'Your opponent disconnected')}</p>` :
      msg.reason === 'abandoned' ? `<p class="muted center">${t('対戦が中断されました', 'The match was abandoned')}</p>` : '');

    let scoreRows;
    if (msg.mode === 'raid') {
      const total = msg.players.reduce((a, p) => a + p.score, 0);
      scoreRows = `
        <div class="rs-row"><span>${msg.boss ? escapeHtml(catName(msg.boss)) : t('ボス', 'Boss')} HP</span><b>${fmt(msg.boss ? msg.boss.hp : 0)}</b></div>
        <div class="rs-row"><span>${t('パーティ総ダメージ', 'Party total damage')}</span><b>${fmt(total)}</b></div>
        ${msg.players.map(p => `<div class="rs-row"><span>${p.slot === msg.you.slot ? `<b>${t('あなた', 'You')}</b>` : escapeHtml(p.name)}</span><b>${fmt(p.score)}</b></div>`).join('')}`;
    } else if (msg.mode === 'team') {
      const teamRow = tm => {
        const members = msg.players.filter(p => p.team === tm);
        const names = members.map(p => (p.slot === msg.you.slot ? `<b>${escapeHtml(p.name)}</b>` : escapeHtml(p.name)) + ` ${fmt(p.score)}`).join('<br>');
        const label = tm === msg.you.team ? t('あなたのチーム', 'Your team') : t('相手チーム', 'Enemy team');
        return `<div class="rs-row team-row"><span>${label}<br><small class="muted">${names}</small></span><b>${fmt(msg.teamScores[tm])}</b></div>`;
      };
      scoreRows = teamRow(msg.you.team) + teamRow(1 - msg.you.team);
    } else {
      scoreRows = msg.players
        .sort((a, b) => (a.slot === msg.you.slot ? -1 : b.slot === msg.you.slot ? 1 : 0))
        .map(p => `<div class="rs-row"><span>${p.slot === msg.you.slot ? t('あなた', 'You') : escapeHtml(p.name)}</span><b>${fmt(p.score)}</b></div>`)
        .join('');
    }

    // 🚩 陣取り: 勝敗を決めたのは点ではなく領土なので、その内訳を先頭に出す。
    if (msg.land && Array.isArray(msg.land.counts)) {
      const mineN = msg.land.counts[msg.you.slot] || 0;
      const foeN = msg.land.counts[1 - msg.you.slot] || 0;
      scoreRows = `
        <div class="rs-row"><span>${t('あなたの領土', 'Your territory')}</span><b>${mineN}</b></div>
        <div class="rs-row"><span>${t('相手の領土', 'Their territory')}</span><b>${foeN}</b></div>
        <div class="rs-row"><span>${t('置いたピース', 'Pieces placed')}</span><b>${fmt(msg.land.moves || 0)}</b></div>
        ${scoreRows}`;
    }

    // 👑 王者を倒した。印は server/battle.js が endMatch で載せる
    //   beatChampion … true のときだけ載る（false は載せない ＝「この試合だけ
    //                  false が付く」ことも相手が誰かの手がかりになるため）
    //   championWins … 生涯の撃破回数（user.stats.championWins と同値）
    // 文面は「相手が誰か」ではなく「何を成し遂げたか」で書く ── 住人の正体は
    // 管理者以外に明かさないので、相手が人間でもそのまま成立する言い回しだけ。
    const championNote = msg.beatChampion
      ? `<p class="center champion-fell">${ic('throne', 18)} ${t('頂に土をつけた！', 'You toppled the summit!')}`
        + ((msg.championWins || 0) > 1
          ? `<br><small class="muted">${t(`通算 ${fmt(msg.championWins)} 回目`, `${fmt(msg.championWins)} times total`)}</small>` : '')
        + '</p>'
      : '';

    // 🤝 練習試合だった理由。サーバー（server/battle.js の endMatch）が
    //    friendly:'guest'|'room'|'self' を載せてきたときだけ出す。
    //    以前はゲスト相手だと ratingDelta が 0 になってレートの行ごと消え、
    //    「なぜ何も動かないのか」がどこにも書いていなかった。黙って0にするより、
    //    理由を1行出したほうが「壊れている」と誤解されない。
    //    ※ 'guest' は相手が本物の未登録プレイヤーのときだけ来る（住人は必ず
    //      レートを持つので該当しない）＝この文面で正体は漏れない。
    const FRIENDLY_NOTE = {
      guest: ['相手が未登録のプレイヤー（ゲスト）のため、レート・戦績・勝利報酬は動きません',
        'Your opponent is an unregistered (guest) player, so rating, record and win rewards do not change'],
      room: ['合言葉ルームの対戦では、レート・戦績・勝利報酬は動きません',
        'Private room matches do not change rating, record or win rewards'],
      self: ['同じアカウント同士の対戦のため、レート・戦績・勝利報酬は動きません',
        'Both sides are the same account, so rating, record and win rewards do not change'],
      repeat: ['同じ回線の同じ相手と短時間に何度も対戦しているため、ここからはレート・戦績・勝利報酬が動きません（時間をおくと戻ります）',
        'You have played the same opponent on the same connection many times in a short window, so rating, record and win rewards pause here — they return after a while'],
    };
    const friendlyNote = FRIENDLY_NOTE[msg.friendly]
      ? `<p class="center muted" style="font-size:12px;margin:6px 0 2px">${ic('warn', 13)} ${t('練習試合', 'Friendly match')} — ${t(FRIENDLY_NOTE[msg.friendly][0], FRIENDLY_NOTE[msg.friendly][1])}</p>`
      : '';

    const myRating = msg.user && msg.user.stats ? msg.user.stats.rating : null;
    const tier = myRating != null ? rankOf(myRating) : null;
    // 増減そのものは resultRankBlock() が見出しの下に大きく出すようになったので、
    // この行は「いまいくつなのか」を出す ── 絶対値はどこにも出ていなかった数字で、
    // 「あと何点で次の段か」を考えるにはこちらが要る。
    // 段位が取れないとき（ゲスト・古いサーバー）だけ、従来どおり増減を出す。
    const ratingRow = !msg.ratingDelta ? ''
      : myRating != null
      ? `<div class="rs-row"><span>${t('現在のレート', 'Your rating')}</span><b>${fmt(myRating)}${tier ? ` ${rankBadge(myRating)}` : ''}</b></div>`
      : `<div class="rs-row"><span>${t('レート変動', 'Rating')}</span><b style="color:${msg.ratingDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${msg.ratingDelta >= 0 ? '+' : ''}${msg.ratingDelta}</b></div>`;

    const m = showModal(`
      <div class="result-banner ${msg.outcome}">${banners[msg.outcome]}</div>
      ${/* 📈 段位が動いた／レートが動いた／連勝している、を見出しのすぐ下に
            大きく出す。以前はレート変動が .rs-row 1行に埋もれていて、
            昇格したことに気づかないまま次の試合に行く人がいた
            （昇格トーストは0.7秒後に出るが、同時に3〜4件出ると押し出される）。 */''}
      ${resultRankBlock(msg)}
      ${reasonNote}
      ${championNote}
      ${friendlyNote}
      <div class="result-stats">
        ${scoreRows}
        ${ratingRow}
        ${rewardsRows(msg.rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <!-- 合言葉ルームでは「再戦」を出さない。サーバー側はルーム在籍中の再戦を
             受け付けない作りで（ゴースト部屋が残るため）、しかも観戦者が居ると
             endMatch が結果より先に roomCode を戻すので、押しても必ず空振りだった。
             この場面の導線は隣の「ルームへ」が既に担っている。 -->
        ${msg.rematchId && this.kind !== 'custom' && (msg.mode === 'duel' || msg.mode === 'attack')
          ? `<button class="btn btn-gold" id="rRematch">${t('再戦', 'Rematch')}</button>` : ''}
        <button class="btn btn-primary" id="rAgain">${this.kind === 'custom' ? t('ルームへ', 'To room') : t('もう一戦', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    // 💬 決着後のリアクション。対戦カードを出したのと同じ「向かい合う2人」の
    // 試合だけ（レイドは味方同士、2v2は宛先が2人いて誰への一言か決まらない）。
    if (VS_CARD_MODES.has(msg.mode) && Array.isArray(msg.players) && msg.players.length === 2) {
      mountReactionBar(m, emoji => this.client.send({ type: 'emote', emoji }));
    }
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      // 🚪 合言葉ルームの「ルームへ」は、**部屋に残る**のが正しい。
      //
      //    ここは長らく destroy() → startOnline('custom') だった ── つまり
      //    接続を捨てて合言葉の入力画面からやり直させていた。ところが
      //    サーバーは試合が終わると出場者をちゃんと部屋へ戻して room_update を
      //    送っている（server/battle.js の endRoomSpectate。コメントも
      //    「戻さないと1試合ごとに2人が部屋から落ちる」と書いてある）。
      //    クライアントが自分から抜けていたので、部屋で続けて遊ぶ導線が
      //    お客さん側から辿れなかった（ホストだけが部屋に残る）。
      if (this.kind === 'custom') {
        this.inMatch = false;
        this.ended = false;
        showScreen('room');
        return;
      }
      this.destroy();
      startOnline(this.kind);
    };
    const rBtn = m.querySelector('#rRematch');
    if (rBtn) rBtn.onclick = () => {
      // 🔁 接続を保ったまま同じ相手に再挑戦（destroyするとWSが切れる）
      rBtn.disabled = true;
      rBtn.textContent = t('相手を待っています…', 'Waiting for opponent…');
      this.ended = false;
      this.inMatch = false;
      this.client.send({ type: 'rematch', rematchId: msg.rematchId });
      audio.click();
    };
  }

  // ✕ の確認モーダルに出す「ここでやめると何が起きるか」。
  // OnlineMode は協力プレイ・ロイヤル・レイド・陣取りも全部 mode='pvp' なので、
  // mode だけで文面を決めると quit() の実際の挙動と正反対のことを言ってしまう
  // （協力プレイは敗北にならないのに「敗北になります」と出ていた）。
  // 分岐の順序は下の quit() のトーストと同じ ── 片方だけ直る事故を防ぐため、
  // 確認文はここ1箇所から読む（読み手は main.js の ✕ 確認モーダル）。
  quitWarning() {
    if (!this.inMatch || this.ended) return null;   // マッチング待ちは失うものが無い
    // 👀 カスタムルームの観戦席。onRoomSpectate が inMatch を立てるので、
    //    ここで先に外さないと「試合中のプレイヤー」として扱われ、観戦を
    //    やめるだけの人に「離脱は敗北になります」と嘘の警告が出る
    //    （レートも戦績も実際には1も動かない）。ロイヤルの観戦
    //    （royaleDead）は下で正しく出し分けているのに、ここだけ抜けていた。
    //    ⚠ quit() のトーストと必ず同じ順序で分岐すること。
    if (this.spectatingRoom) return null;   // 観戦をやめるだけ＝失うものが無い
    if (this.isCoop) {
      return t('協力プレイの離脱は<b>敗北になりません</b>（相棒はそのまま続けられます）',
        'Leaving a co-op run is <b>not a loss</b> — your partner can keep going');
    }
    if (this.isRoyale) {
      return this.royaleDead
        ? t('順位はすでに確定しています。観戦をやめるだけです',
            'Your placement is already final — you would just stop spectating')
        : t('生存中の離脱は<b style="color:var(--red)">そのときの生存者の中で最下位</b>扱いになります',
            'Leaving while alive is recorded as <b style="color:var(--red)">last among the current survivors</b>');
    }
    return t('離脱は<b style="color:var(--red)">敗北</b>になります', 'Leaving counts as a <b style="color:var(--red)">loss</b>');
  }

  quit() {
    if (this.inMatch && !this.ended) {
      this.ended = true;
      // ⚠ 何だったのかを **destroy() より前に** 控える。
      //   destroy() は clearSpectateView() を通って spectatingRoom を false に
      //   戻すので、下のトーストの分岐をそのまま書くと、観戦をやめただけの人にも
      //   「対戦から離脱しました（敗北扱い・相手の不戦勝）」の赤いトーストが出る。
      //   forfeit の判定（すぐ下）は destroy の前にあるので元から正しく、
      //   **文面だけ**が実際の裁定と食い違っていた。
      const wasSpectating = this.spectatingRoom;
      const wasRoyaleDead = this.royaleDead;
      // 🚪 「自分で降りた」ことをサーバーへ伝えてから閉じる。伝えないと
      //    回線事故と同じ扱い（再接続の猶予25秒）になり、相手が待たされる。
      //    観戦をやめるだけの回は試合に出ていないので送らない。
      if (!wasSpectating && this.client) {
        try { this.client.forfeit(); } catch { /* 閉じかけなら何もしない */ }
      }
      this.destroy();
      toast(wasSpectating
        // 👀 ルームの観戦席（上の quitWarning と同じ順序で分岐すること）。
        //    観戦をやめるだけなので、敗北でも不戦勝でもない。
        ? t('観戦を終了しました', 'Stopped spectating')
        : this.isCoop
        ? t('協力プレイから離脱しました（敗北にはなりません）', 'You left the co-op run (no loss recorded)')
        : this.isRoyale
        // ロイヤルには「相手」がいないので、敗北でも不戦勝でもない。
        // すでに脱落・順位確定して観戦中（royaleDead）なら順位は動かないので、
        // 「最下位扱い」ではなく観戦終了として伝える。生存中の離脱だけが最下位扱い。
        ? (wasRoyaleDead
            ? t('観戦を終了しました（順位は確定済みです）',
                'Stopped spectating (your placement is already final)')
            : t('バトルロイヤルから離脱しました（そのときの生存者の中で最下位扱い）',
                'You left the royale (recorded as last among the survivors at that moment)'))
        : t('対戦から離脱しました（敗北扱い・相手の不戦勝）', 'You left the match (counts as a loss)'),
        // 観戦をやめただけの回は警告色(err)にしない ── 何も失っていない。
        // '' は素のトースト（CSS にあるのは err と ok だけ）。
        (this.spectatingRoom || (this.isRoyale && this.royaleDead)) ? '' : 'err', 2600);
      endToMenu();
    } else {
      this.client.cancelQueue();
      this.client.leaveRoom();
      this.destroy();
      endToMenu();
    }
  }

  destroy() {
    // destroy() closes the socket on purpose, and the resulting 'close' must
    // not be reported to the player as "サーバーとの接続が切れました" — that is
    // what cancelling a tournament queue or backing out of a room used to do.
    this.leftOnPurpose = true;
    this.stopTimer();
    clearInterval(this.stateInt);
    clearInterval(this.coopInt);
    clearInterval(this.landInt);
    // ⚔️ 第5波の表示物。予告中のお邪魔（setTimeout）を残すと、次のモードの
    // 盤面に前の試合のブロックが降る。カード・帯・リアクション欄も畳む。
    this.clearGarbageTimers();
    clearBattleUi();
    if (this.landOverlay) { this.landOverlay.destroy(); this.landOverlay = null; }
    clearTimeout(this.resultTimeout);
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#bossPanel').classList.remove('slim');
    $('#coopBar').classList.add('hidden');
    $('#btnOppDensity').classList.add('hidden');
    if (this.isRoyale) this.clearRoyaleOverlays();
    // ルームの観戦席は isRoyale ではないので、こちらは無条件に畳む
    // （残すと次のモードの盤面の上に前の試合の観戦窓が乗ったままになる）。
    this.clearSpectateView();
    if (view) view.onIntentPlace = null;
    this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Survival: endless garbage waves on an accelerating timer. How long can
// you keep the board alive?
// ---------------------------------------------------------------------------

class SurvivalMode {
  constructor() {
    this.mode = 'survival';
    this.wave = 0;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(true);
    this.startedAt = Date.now();
    const v = getView();
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onPlace = () => this.updateHud();
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('hard');
    this.nextAt = Date.now() + 15000;
    this.int = setInterval(() => this.tick(), 200);
    toast(t('15秒ごとにお邪魔ブロックが降ってくる！生き延びろ！', 'Garbage drops every 15s — survive!'), 'announce', 3000);
  }

  // スコアのベストはサーバーに欄が無い（stats に survivalBest 相当が無い）ので
  // localStorage だけ。ウェーブは stats.survivalWave があるので、別端末でも
  // 正しい記録が出るように統合する ── メニュー側（main.js の 💀 セットアップ）が
  // 同じ統合をしているのに、モード内だけ localStorage を見ていた。
  best() { return Number(localStorage.getItem('bba_survival_best') || 0); }
  bestWave() {
    const local = Number(localStorage.getItem('bba_survival_wave') || 0);
    return session.user ? Math.max(local, session.user.stats.survivalWave || 0) : local;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    // 走行中に自己ベストを追い越したら BEST も一緒に伸ばす（ソロと同じ扱い）。
    const bw = Math.max(this.bestWave(), this.wave);
    $('#hudSub').textContent = `WAVE ${this.wave}${bw ? ` ・ BEST W${bw}` : ''}`;
  }

  tick() {
    if (this.ended) return;
    const remain = Math.max(0, this.nextAt - Date.now());
    const el = $('#hudTimer');
    // 次の波までの秒読み。☠ は独自アイコン（mode_survival）に置き換える。
    el.innerHTML = `${ic('mode_survival', 15)} ${Math.ceil(remain / 1000)}`;
    el.classList.toggle('urgent', remain <= 3000);
    if (remain <= 0) this.dropWave();
  }

  dropWave() {
    this.wave++;
    const cells = Math.min(2 + Math.floor(this.wave / 2), 7);
    const added = this.engine.addGarbage(cells);
    audio.bossAttack();
    if (view) {
      view.shake = 10;
      for (const [r, c] of added) {
        view.spawnAnim.set(r * 8 + c, view.time);
        view.particles.burstCell(view.boardX + (c + 0.5) * view.cell, view.boardY + (r + 0.5) * view.cell, view.cell, 8, 'fx_default');
      }
    }
    toast(t(`WAVE ${this.wave}！お邪魔${cells}個`, `WAVE ${this.wave}! ${cells} garbage blocks`), 'err', 1300);
    const interval = Math.max(5, 15 - this.wave * 0.6);
    this.nextAt = Date.now() + interval * 1000;
    this.updateHud();
    if ((this.engine.over || !this.engine.hasAnyMove()) && !autoRescue()) this.finish();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.int);
    getView().inputLocked = true;
    const e = this.engine;
    const survived = Math.round((Date.now() - this.startedAt) / 1000);
    // 🏅 このモードが祝うのは **到達ウェーブ**。画面に出している記録
    //    （HUDの「BEST W..」・メニューの「最高ウェーブ」・サーバーの
    //    stats.survivalWave・実績の survivalWave）は全部ウェーブなのに、
    //    帯の判定と紙吹雪だけが bba_survival_best（どこにも表示されない
    //    スコア記録）で決まっていた。そのせいで
    //      ・最高ウェーブを更新しても「生存終了…」のまま祝われない
    //      ・大した回でなくてもスコアさえ上回れば NEW RECORD! が出る
    //    という、記録の辻褄が合わない状態になっていた。ソロ・メルトダウン・
    //    キメラ・タイムアタックはどれも「画面に出している記録＝帯の判定」で
    //    揃っているので、サバイバルだけ規則が違った。
    //    ⚠ 書き込む前に読むこと（下の setItem より先に判定する）。
    const isBest = this.wave > this.bestWave();
    const scoreBest = e.score > this.best();
    if (scoreBest) localStorage.setItem('bba_survival_best', String(e.score));
    if (isBest) localStorage.setItem('bba_survival_wave', String(this.wave));
    if (isBest && this.wave > 0) confettiBurst();
    audio.gameOver();
    const rewards = await submitResult({
      mode: 'survival', score: e.score, lines: e.linesCleared,
      maxCombo: e.maxCombo, duration: survived, won: false, wave: this.wave,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : t('生存終了…', 'You were buried…')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('到達ウェーブ', 'Wave reached')}</span><b>W${this.wave}</b></div>
        <div class="rs-row"><span>${t('生存時間', 'Time survived')}</span><b>${Math.floor(survived / 60)}:${String(survived % 60).padStart(2, '0')}</b></div>
        ${/* スコアの自己ベストも「見えない記録」にしない。帯はウェーブで決まるので、
              スコアだけ伸びた回は行の横で伝える。 */''}
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}${scoreBest && e.score > 0 ? ` <small style="color:var(--gold)">${t('自己ベスト', 'best')}</small>` : ''}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-oni" id="rAgain">${t('もう一度生き残る', 'Survive again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startSurvival(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }
  destroy() { this.ended = true; clearInterval(this.int); }
}

// ---------------------------------------------------------------------------
// ⏱️ Time Attack (sprint): a fixed clock, pure scoring.
//
// Boosters and ultimates are OFF here on purpose — this mode has its own
// leaderboard, and paid consumables would decide it.
// ---------------------------------------------------------------------------

export const SPRINT_DURATIONS = [60, 180];

function sprintKey(dur) { return `bba_sprint_${dur}`; }

export function sprintBest(dur) {
  const local = Number(localStorage.getItem(sprintKey(dur)) || 0);
  const srv = session.user && session.user.stats && session.user.stats.sprint
    ? Number(session.user.stats.sprint[`s${dur}`] || 0) : 0;
  return Math.max(local, srv);
}

class SprintMode {
  constructor(duration) {
    this.mode = 'sprint';
    this.duration = SPRINT_DURATIONS.includes(duration) ? duration : 60;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    showItemBar(false);            // fair leaderboard: no boosters, no ultimates
    this.ended = false;
    this.startedAt = Date.now();
    const v = getView();
    v.setTheme(equippedTheme());
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = () => this.onPlace();
    v.onGameOver = () => this.finish('topout');
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('hard');

    countdownOverlay(3, afterCountdown(this, () => {
      if (this.ended) return;
      v.inputLocked = false;
      // ⏱ 「実際に遊び始めた時刻」。startedAt は 3-2-1 のオーバーレイ（3.3秒）
      //    より前に打っているので、そちらを分母にすると毎秒スコアが常に低く出る
      //    （60秒で約5%、180秒で約2%）。このモードで唯一の腕前の指標なのに、
      //    コメントは「実プレイ時間で割る」と宣言していた。
      //    サーバーへ送る duration も同じ時計にそろえる。
      this.playStartedAt = Date.now();
      this.endAt = Date.now() + this.duration * 1000;
      this.tickInt = setInterval(() => this.tick(), 200);
      this.tick();
    }), audio);
  }

  tick() {
    if (this.ended) return;
    const remain = Math.max(0, this.endAt - Date.now());
    const s = Math.ceil(remain / 1000);
    const el = $('#hudTimer');
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', s <= 10);
    if (remain <= 0) this.finish('time');
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    // 走行中に自己ベストを追い越したら BEST も一緒に伸ばす（ソロと同じ扱い）。
    const best = Math.max(sprintBest(this.duration), this.engine.score);
    // 分母は「遊び始めてから」。3-2-1 の 3.3秒を含めると、序盤ほど大きく低く出る
    // （開始1秒目は score/4.3 になる）。結果画面の毎秒スコアと同じ時計にそろえる。
    const rate = Math.round(this.engine.score / Math.max(1, (Date.now() - (this.playStartedAt || this.startedAt)) / 1000));
    $('#hudSub').textContent = t(`${this.duration}秒 ・ BEST ${fmt(best)} ・ ${fmt(rate)}/秒`,
      `${this.duration}s ・ BEST ${fmt(best)} ・ ${fmt(rate)}/s`);
  }

  onPlace() { this.updateHud(); }

  async finish(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.tickInt);
    getView().inputLocked = true;
    $('#hudTimer').classList.add('hidden');
    const e = this.engine;
    const prevBest = sprintBest(this.duration);
    const isBest = e.score > prevBest;
    if (isBest) localStorage.setItem(sprintKey(this.duration), String(e.score));
    if (isBest && e.score > 0) { confettiBurst(60); audio.victory(); }
    else audio.gameOver();

    const rewards = await submitResult({
      mode: 'sprint', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      // 3-2-1 のぶんは遊んでいない。playStartedAt が無いのは
      // カウントダウン中に抜けた回だけなので、そのときは 1秒に丸める。
      duration: Math.max(1, (Date.now() - (this.playStartedAt || Date.now())) / 1000), won: false,
      sprintDur: this.duration,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const banner = isBest ? 'NEW RECORD!' : reason === 'topout' ? t('盤面が埋まった…', 'Board filled up…') : reason === 'quit' ? t('中断', 'Aborted') : 'TIME UP!';
    // 毎秒スコアは HUD の実レートと同じく実プレイ時間で割る（途中終了で制限時間固定だと過小になる）。
    // ⚠ 分母は playStartedAt（3-2-1 が明けた時刻）。startedAt はオーバーレイの
    //   前なので、遊べない3.3秒まで数えて常に低く出ていた。
    const elapsed = Math.max(1, (Date.now() - (this.playStartedAt || this.startedAt)) / 1000);
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${banner}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('自己ベスト', 'Personal best')}</span><b>${fmt(Math.max(prevBest, e.score))}</b></div>
        <div class="rs-row"><span>${t('毎秒スコア', 'Score per second')}</span><b>${fmt(Math.round(e.score / elapsed))}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        <div class="rs-row"><span>${t('最大コンボ', 'Max combo')}</span><b>${fmt(e.maxCombo)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rRank">${ic('leaderboard', 15)} ${t('順位', 'Ranking')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rRank').onclick = () => {
      closeModal();
      endToMenu();
      if (window.__bbaOpenLeaderboard) window.__bbaOpenLeaderboard('sprint');
    };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startSprint(this.duration); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish('quit');
  }
  destroy() { this.ended = true; clearInterval(this.tickInt); $('#hudTimer').classList.add('hidden'); }
}

export function startSprint(duration = 60) {
  if (currentMode) currentMode.destroy();
  currentMode = new SprintMode(duration);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ---------------------------------------------------------------------------
// 👑 管理者イベント専用モード（3種・週替わり）
//
// These exist ONLY inside a reserved admin-event slot — that is the whole point
// of booking one. All three share the same shell (a 2-minute run on your own
// board, folded into the day's SHARED world state on the server) and differ in
// what happens to you while you play.
// ---------------------------------------------------------------------------

const AE_RUN_SECONDS = 120;

// 3種のイベントの絵。サーバーは ae.mode.icon に絵文字（👑 / 🎰 / 🏛️）を
// 載せてくるが、端末ごとに絵が変わるうえ 👑 は段位マスター・管理者奥義・
// バッジと重複していた。id から icons.js を引く形にそろえる。
//   invasion（管理者襲来）→ admin（盾＋王冠）
//   roulette（運営ルーレット）→ gacha（回して当てる機械）
//   communal（共同作業）→ hall（列柱＝みんなで建てるもの）
//   zero（👁️断罪）→ badge_zero。ここが抜けていて、断罪の回だけ
//   共同作業（hall）の絵が出ていた。public/js/adminevent.js の
//   AE_MODE_ICONS と同じ対応にそろえてある。
const AE_ICON_BY_MODE = { invasion: 'admin', roulette: 'gacha', communal: 'hall', zero: 'badge_zero' };
function aeIconName(modeId) {
  return AE_ICON_BY_MODE[modeId] || 'mode_adminevent';
}

// ---- board surgery used by 管理者襲来 / 運営ルーレット ----

function aeRotateGrid(engine) {
  const g = engine.grid, n = 8, out = new Array(64).fill(0);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[c * n + (n - 1 - r)] = g[r * n + c];
  for (let i = 0; i < 64; i++) g[i] = out[i];
  if (!engine.hasAnyMove()) engine.over = true;
}

function aeGravity(engine) {
  const g = engine.grid, n = 8;
  for (let c = 0; c < n; c++) {
    const col = [];
    for (let r = 0; r < n; r++) if (g[r * n + c]) col.push(g[r * n + c]);
    for (let r = n - 1, i = col.length - 1; r >= 0; r--, i--) g[r * n + c] = i >= 0 ? col[i] : 0;
  }
  // 崩落で埋まった行はここで消す。直書きなので engine が面倒を見てくれない。
  // hasAnyMove() より前でないと、消えれば続けられる盤面で不当に終わる。
  engine.resolveLines();
  if (!engine.hasAnyMove()) engine.over = true;
}

// A garbage row shoved in from the bottom, pushing everything up.
function aeRiseRow(engine, holes = 2) {
  const g = engine.grid, n = 8;
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n; c++) g[r * n + c] = g[(r + 1) * n + c];
  const gap = new Set();
  while (gap.size < holes) gap.add(Math.floor(engine.rng.next() * n));
  for (let c = 0; c < n; c++) g[(n - 1) * n + c] = gap.has(c) ? 0 : 9;
  // せり上がりで列が埋まりきることがある（下1マスが塞がって上7段が埋まっている列）。
  // 直書きなので engine は消してくれない。同じ理由で hasAnyMove() より前に。
  engine.resolveLines();
  if (!engine.hasAnyMove()) engine.over = true;
}

function aeShuffleHand(engine) {
  for (let i = 0; i < 3; i++) engine.hand[i] = engine.drawPiece();
  if (!engine.hasAnyMove()) engine.over = true;
}

// ---- the interference the admin (or their avatar) throws at you ----

const AE_STRIKES = [
  { id: 'rain',    ja: 'お邪魔の雨',     en: 'Garbage rain',   run: m => m.engine.addGarbage(4) },
  { id: 'seal',    ja: '封印',           en: 'Seal',           run: m => m.engine.addGarbage(3) },
  { id: 'shuffle', ja: '手札シャッフル', en: 'Hand shuffle',   run: m => aeShuffleHand(m.engine) },
  { id: 'spin',    ja: '盤面回転',       en: 'Board spin',     run: m => aeRotateGrid(m.engine) },
  { id: 'gravity', ja: '重力',           en: 'Gravity',        run: m => aeGravity(m.engine) },
  { id: 'rise',    ja: 'せり上がり',     en: 'Rising floor',   run: m => aeRiseRow(m.engine) },
  { id: 'blind',   ja: '目隠し',         en: 'Blindfold',      run: m => m.blindFor(3200) },
  // 管理者は気まぐれ — たまに褒美をくれる。
  { id: 'gift',    ja: '気まぐれの褒美', en: 'A fickle gift',  run: m => { m.engine.grid.fill(0); m.engine.score += 500; }, good: true },
];

// ---- 運営ルーレット: the wheel ----

const AE_WHEEL = [
  { id: 'jackpot', ja: '一攫千金（スコア5倍・お邪魔つき）',   en: 'Jackpot (5× score, with garbage)' },
  { id: 'mini',    ja: '極小ブロックのみ',                   en: 'Tiny blocks only' },
  { id: 'giant',   ja: '極大ブロックのみ',                   en: 'Giant blocks only' },
  { id: 'spin',    ja: '回転盤（10秒ごとに回る）',           en: 'Spin cycle (rotates every 10s)' },
  { id: 'treasure',ja: '大盤振る舞い（消すたびボーナス）',   en: 'Treasure run (bonus on every clear)' },
  { id: 'blind',   ja: '目隠し（ゴースト消灯）',             en: 'Blindfold (no ghost preview)' },
  { id: 'rise',    ja: 'せり上がり（8秒ごと）',              en: 'Rising floor (every 8s)' },
  { id: 'lucky7',  ja: 'ラッキーセブン（7手ごとに大当たり）', en: 'Lucky 7 (jackpot every 7th piece)' },
  { id: 'blessing',ja: '天の恵み（全消し＋フィーバー）',      en: 'Blessing (clear board + fever)' },
];

class AdminEventMode extends VersusBase {
  constructor(ae) {
    super();
    this.mode = 'ae';
    this.ae = ae;
    this.modeId = (ae && ae.mode && ae.mode.id) || 'invasion';
    this.timers = [];
  }

  // Every timer this mode starts goes through here, so destroy() can be sure.
  every(ms, fn) { const id = setInterval(fn, ms); this.timers.push(id); return id; }
  after(ms, fn) { const id = setTimeout(fn, ms); this.timers.push(id); return id; }

  start() {
    // 枠の残り時間に run を切り詰める。残りが極端に短いときは開始せず戻す
    //（枠終了間際に始めて結果が没収されるのを避ける。サーバー側にも猶予がある）。
    const ae = this.ae;
    const slotLeft = (ae && ae.live) ? Math.floor((ae.live.endsAt - Date.now()) / 1000) - 4 : AE_RUN_SECONDS;
    if (slotLeft < 15) {
      toast(t('枠の残り時間が足りません', 'Not enough time left in this slot'), 'err', 3000);
      endToMenu();
      return;
    }
    const runSecs = Math.min(AE_RUN_SECONDS, slotLeft);
    this.setupHud(runSecs);
    $('#oppPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    showItemBar(false);            // 公平のため: この枠ではアイテムは使えない
    showUltBar(false);
    this.startedAt = Date.now();
    this.contribution = 0;
    this.strikes = 0;

    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: this.modeId === 'invasion' ? 'board_oni' : this.modeId === 'roulette' ? 'board_galaxy' : 'board_sakura' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.finish();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack(this.modeId === 'invasion' ? 'oni' : this.modeId === 'roulette' ? 'boss' : 'solo');

    this.setupWorldPanel();
    // ae.mode.icon（サーバーが送る絵文字）は出さない ── トーストは textContent。
    toast(`${t(this.ae.mode.name, this.ae.mode.nameEn)} — ${t(this.ae.mode.tagline, this.ae.mode.taglineEn)}`, 'announce', 3200);

    countdownOverlay(3, afterCountdown(this, () => {
      if (this.ended || currentMode !== this) return;   // 開始前に抜けた
      v.inputLocked = false;
      this.startTimer(() => this.finish());
      if (this.modeId === 'invasion') this.scheduleStrike();
      if (this.modeId === 'roulette') this.startWheel();
      if (this.modeId === 'communal') this.startMaterials();
    }), audio);
  }

  // The shared world state gets the slim boss bar: one HP/gauge line that the
  // whole day is pushing on together.
  setupWorldPanel() {
    const w = this.ae.world;
    const panel = $('#bossPanel');
    if (this.modeId === 'roulette' || !w) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.classList.add('slim');
    document.querySelector('.boss-atkbar').classList.add('hidden');
    // 👑＝管理者、🏛️＝共同作業。どちらも「絵として意味を持つ」ので独自アイコンへ。
    // 👑 は段位マスター・管理者奥義・複数のバッジと重複していた絵文字でもある。
    setBossFace($('#bossEmoji'), aeIconName(this.modeId), BOSS_FACE_SLIM);
    $('#bossName').textContent = this.modeId === 'invasion'
      ? t('管理者', 'The Admin') : t('共同作業', 'Great Work');
    this.updateWorldPanel();
  }

  updateWorldPanel() {
    const w = this.ae.world;
    if (!w || this.modeId === 'roulette') return;
    if (this.modeId === 'invasion') {
      // Projected locally: your damage lands on the shared bar the instant you
      // score it, and the server confirms the real number when the run ends.
      const hp = Math.max(0, (w.hp || 0) - this.engine.score);
      const pct = w.maxHp ? Math.max(0, (hp / w.maxHp) * 100) : 0;
      $('#bossHp').style.width = `${pct}%`;
      $('#bossHpText').textContent = `${fmt(hp)} / ${fmt(w.maxHp || 0)}`;
    } else {
      const goal = w.tiers && w.tiers.length ? w.tiers[w.tiers.length - 1].at : 1;
      const total = (w.total || 0) + this.engine.score;
      $('#bossHp').style.width = `${Math.min(100, (total / goal) * 100)}%`;
      $('#bossHpText').textContent = `${fmt(total)} / ${fmt(goal)}`;
    }
  }

  // VersusBase writes 'SCORE' into #hudSub on every placement, which wiped the
  // roulette's current-rule label a moment after each spin. Combos still win
  // the slot (they are the more urgent thing to know), the rule comes back.
  updateMyHud(engine) {
    const el = $('#hudScore');
    el.textContent = fmt(engine.score);
    applyScoreFit(el, fmt(engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = engine.streak >= 2 ? `${engine.streak} COMBO`
      : (this.modeId === 'roulette' && this.spinLabel) ? this.spinLabel
      : 'SCORE';
  }

  onPlace(r) {
    this.updateMyHud(this.engine);
    this.updateWorldPanel();
    if (this.modeId === 'roulette') this.rouletteOnPlace(r);
    if (this.modeId === 'communal') this.communalOnPlace(r);
  }

  blindFor(ms) {
    const wrap = document.querySelector('.game-canvas-wrap');
    if (!wrap) return;
    wrap.classList.add('ae-blind');
    this.after(ms, () => wrap.classList.remove('ae-blind'));
  }

  // ---- 👑 管理者襲来 ----

  scheduleStrike() {
    const delay = 6500 + Math.random() * 5500;
    this.after(delay, () => {
      if (this.ended) return;
      this.fireStrike();
      this.scheduleStrike();
    });
  }

  fireStrike() {
    if (this.ended || !this.engine || this.engine.over) return;
    // 気まぐれの褒美は控えめに。
    const pool = AE_STRIKES.filter(s => !s.good || Math.random() < 0.18);
    const s = pool[(Math.random() * pool.length) | 0] || AE_STRIKES[0];
    this.strikes++;
    s.run(this);
    if (view) { view.shake = s.good ? 4 : 11; view.screenFlash = s.good ? 0.2 : 0.35; }
    if (s.good) audio.coin(); else audio.bossAttack();
    // 原文『管理者の◯◯！』は技名。裸のコロン形（The Admin: …）は発言者ラベル
    // ＝管理者のセリフに読めてしまうので、出どころだと分かる形にする。
    // （所有格 The Admin's … は 'A fickle gift' に付くと英語として壊れるので採らない。
    //   ASCII のアポストロフィはテンプレート内で modes-structure テストの
    //   クラス切り出しも壊す ── catalog-en.js と同じく曲線 ’ を使うこと。）
    toast(t(`管理者の${s.ja}！`, `From the Admin: ${s.en}!`), s.good ? 'ok' : 'err', 1800);
    if (this.engine.over) this.finish();
  }

  // ---- 🎰 運営ルーレット ----

  startWheel() {
    $('#chaosBar').classList.remove('hidden');
    getView().resize();   // same reason as Chaos: measure AFTER the reveal
    this.spin();
    this.every(30000, () => this.spin());
    this.every(100, () => {
      const remain = Math.max(0, (this.nextSpinAt || 0) - Date.now());
      $('#chaosBarFill').style.width = `${(remain / 30000) * 100}%`;
    });
  }

  clearWheelEffects() {
    const e = this.engine;
    e.scoreMult = 1;
    e.chaosBig = false;
    e.chaosMini = false;
    if (this.spinInt) { clearInterval(this.spinInt); this.spinInt = null; }
    if (this.riseInt) { clearInterval(this.riseInt); this.riseInt = null; }
    if (this.rainInt) { clearInterval(this.rainInt); this.rainInt = null; }
    this.treasure = false;
    this.lucky7 = false;
    if (view) view.ghostFx = null;
    const wrap = document.querySelector('.game-canvas-wrap');
    if (wrap) wrap.classList.remove('ae-blind');
  }

  spin() {
    if (this.ended) return;
    this.clearWheelEffects();
    this.nextSpinAt = Date.now() + 30000;
    let pick = AE_WHEEL[(Math.random() * AE_WHEEL.length) | 0];
    if (pick.id === this.lastSpin) pick = AE_WHEEL[(AE_WHEEL.indexOf(pick) + 1) % AE_WHEEL.length];
    this.lastSpin = pick.id;
    const e = this.engine;

    switch (pick.id) {
      case 'jackpot':
        e.scoreMult = 5;
        // 詰みを拾って終わらせる。over が立つと place() は必ず null を返し、
        // applyResult も onGameOver も走らない ── AE ではリロールもアイテムも
        // 奥義も無効なので、残り時間ずっと動かない盤面を見せられていた。
        // 次のスピンでも復帰しない（clearWheelEffects は over を戻さない）。
        this.rainInt = setInterval(() => {
          if (this.ended || e.over) return;
          e.addGarbage(2);
          if (e.over) this.finish();
        }, 4000);
        this.timers.push(this.rainInt);
        break;
      case 'mini': e.chaosMini = true; break;
      case 'giant': e.chaosBig = true; break;
      case 'spin':
        this.spinInt = setInterval(() => {
          if (this.ended || e.over || (view && (view.inputLocked || view.drag))) return;
          aeRotateGrid(e);
          if (view) view.shake = 8;
          // aeRotateGrid は末尾で詰みを判定して over を立てる。'rise' と同じく
          // ここで終わらせないと、置けない・終われない盤面のまま放置される。
          if (e.over) this.finish();
        }, 10000);
        this.timers.push(this.spinInt);
        break;
      case 'treasure': this.treasure = true; break;
      // 30秒も手札ごと真っ黒にすると、ただ何もできない時間になる。
      // ルーレットの他の効果と同じ尺（数秒）に揃える。
      case 'blind': this.blindFor(4000); break;
      case 'rise':
        this.riseInt = setInterval(() => {
          if (this.ended || e.over || (view && (view.inputLocked || view.drag))) return;
          aeRiseRow(e);
          if (view) view.shake = 6;
          if (e.over) this.finish();
        }, 8000);
        this.timers.push(this.riseInt);
        break;
      case 'lucky7': this.lucky7 = true; this.luckyCount = 0; break;
      case 'blessing':
        e.grid.fill(0);
        e.feverUntil = Date.now() + 12000;
        e.feverMult = 3;
        break;
    }

    if (view) { view.screenFlash = 0.45; view.shake = 12; }
    audio.combo(8);
    toast(t(pick.ja, pick.en), 'announce', 2600);
    this.spinLabel = t(pick.ja, pick.en).split('（')[0].split(' (')[0];
    $('#hudSub').textContent = this.spinLabel;
  }

  rouletteOnPlace(r) {
    const e = this.engine;
    if (this.treasure && r && r.lineCount > 0) {
      e.score += 300 * r.lineCount;
      toast(`+${300 * r.lineCount}`, 'ok', 900);
    }
    if (this.lucky7) {
      this.luckyCount = (this.luckyCount || 0) + 1;
      if (this.luckyCount % 7 === 0) {
        e.score += 3000;
        if (view) view.screenFlash = 0.5;
        audio.victory();
        toast(t('ラッキーセブン！ +3,000', 'Lucky 7! +3,000'), 'announce', 1800);
      }
    }
  }

  // ---- 🏛️ 共同作業 ----

  startMaterials() {
    this.materials = new Set();
    this.dropMaterial();
    this.every(9000, () => this.dropMaterial());
  }

  // 建材 (golden cells): clearing a line that contains one is worth extra to
  // the community gauge. They mark EMPTY cells, so they never block a move.
  dropMaterial() {
    if (this.ended || !this.engine) return;
    const empties = [];
    for (let i = 0; i < 64; i++) if (!this.engine.grid[i] && !this.materials.has(i)) empties.push(i);
    if (!empties.length) return;
    const k = empties[(Math.random() * empties.length) | 0];
    this.materials.add(k);
    if (view) {
      // Set のまま渡す。配列を渡していたころ、drawBlocks() の
      // `glowCells.has(key)` が TypeError で落ち、render() が投げた時点で
      // 次フレームの requestAnimationFrame が予約されず描画ループごと死んだ
      // （running は true のままなので start() でも復帰できない）＝1手置いた
      // 次のフレームで盤面が凍り、共同作業の枠が毎回プレイ不能になっていた。
      view.glowCells = new Set(this.materials);
      view.screenFlash = 0.12;
    }
  }

  communalOnPlace(r) {
    if (!r || !this.materials) return;
    let hit = 0;
    for (const [row, col] of (r.clearedCells || [])) {
      const k = row * 8 + col;
      if (this.materials.has(k)) { this.materials.delete(k); hit++; }
    }
    // 置いたマスが建材の上でも回収できる（塞いで損、をなくす）。
    for (const [row, col] of (r.placedCells || [])) {
      const k = row * 8 + col;
      if (this.materials.has(k)) { this.materials.delete(k); hit++; }
    }
    if (hit) {
      this.engine.score += 400 * hit;
      audio.coin();
      toast(t(`建材 ×${hit} 回収！ +${fmt(400 * hit)}`, `${hit} material(s)! +${fmt(400 * hit)}`), 'ok', 1200);
      this.updateMyHud(this.engine);
      this.updateWorldPanel();
    }
    if (view) view.glowCells = new Set(this.materials);   // 同上: 描画側は Set 前提
  }

  // ---- finish ----

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    this.clearTimers();
    getView().inputLocked = true;
    const e = this.engine;

    let res = null;
    try {
      res = await api('/api/adminevent/result', {
        method: 'POST',
        body: {
          score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
          duration: (Date.now() - this.startedAt) / 1000,
          ults: e.ultUses || 0, items: 0, pieces: e.piecesPlaced || 0,
        },
      });
      updateTopbar();
    } catch (err) {
      toast(err.message, 'err', 4000);
    }

    // 🚪 待っている間にメニューへ戻っていたら、結果は出さない。
    //    他モードの finish() は await の直後にそろってこのガードを置いている
    //    （15か所）のに、管理者イベントと断罪の2つだけ無条件に
    //    dismissable:false のモーダルを出していた ── メニューを触っている
    //    ところへ閉じ口の無い結果画面が割り込んでくる。
    if (currentMode !== this) return;

    if (res && res.event && window.__bbaAeRefresh) {
      // Everyone's shared bar moved — re-read it rather than trusting the
      // projection this run was drawing.
      this.ae = res.event;
    }

    const d = res ? res.delta : null;
    const chest = res ? res.chest : null;
    const w = res && res.event ? res.event.world : null;
    const killed = d && d.killed;
    if (killed) { audio.victory(); confettiBurst(90); }

    const worldRow = this.modeId === 'invasion' && w
      ? `<div class="rs-row"><span>${t('管理者の残りHP', 'Admin HP left')}</span><b>${fmt(Math.max(0, w.hp))} / ${fmt(w.maxHp)}</b></div>`
      : this.modeId === 'communal' && w
        ? `<div class="rs-row"><span>${t('みんなの合計', 'Community total')}</span><b>${fmt(w.total)}</b></div>`
        : '';

    const m = showModal(`
      <div class="result-banner ${killed ? 'win' : 'draw'}">${ic(aeIconName(this.modeId), 26)} ${killed ? t('討伐！', 'DEFEATED!') : t('おつかれさま', 'Nice run')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        ${this.modeId === 'invasion' ? `<div class="rs-row"><span>${t('与ダメージ', 'Damage dealt')}</span><b>${fmt(d ? d.damage : 0)}</b></div>` : ''}
        ${this.modeId === 'invasion' ? `<div class="rs-row"><span>${t('妨害を受けた回数', 'Times disrupted')}</span><b>${this.strikes}</b></div>` : ''}
        ${this.modeId === 'communal' ? `<div class="rs-row"><span>${t('ゲージへの貢献', 'Added to the gauge')}</span><b>${fmt(d ? d.gained : 0)}</b></div>` : ''}
        ${worldRow}
        ${rewardsRows(res ? res.rewards : null)}
        ${chest && (chest.coins || chest.gems) ? `<div class="rs-row"><span>${t(`お宝ラッシュ（${chest.mult}倍）`, `Treasure Rush (${chest.mult}×)`)}</span><b>+${fmt(chest.coins)} ${ic('coins', 14)} +${fmt(chest.gems)} ${ic('gems', 14)}</b></div>` : ''}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-gold" id="rAgain">${t('もう一度挑む', 'Run it again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      const ae = this.ae;
      this.destroy();
      // 枠が終わっていたら、無言で締め出さずに理由を出す。
      if (!ae || !ae.live || ae.live.endsAt <= Date.now()) {
        toast(t('あなたの枠は終了しました。またの参加をお待ちしています！', 'Your slot has ended — see you next time!'), 'announce', 4000);
        endToMenu();
        return;
      }
      startAdminEventMode(ae);
    };
  }

  clearTimers() {
    for (const id of this.timers) { clearInterval(id); clearTimeout(id); }
    this.timers = [];
    this.spinInt = this.riseInt = this.rainInt = null;
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  destroy() {
    this.ended = true;
    this.stopTimer();
    this.clearTimers();
    $('#chaosBar').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#bossPanel').classList.remove('slim');
    const wrap = document.querySelector('.game-canvas-wrap');
    if (wrap) wrap.classList.remove('ae-blind');
    if (view) view.glowCells = null;
  }
}


// ---------------------------------------------------------------------------
// 👁️ 断罪 ── 管理者ゼロ
// ---------------------------------------------------------------------------
//
// 他の管理者イベントと違い、これはサーバー権威のセッション。
// 段のHP・封印・処刑された住人はサーバーが持っていて、こちらは
// 「見せる」ことと「斬った申告を送る」ことだけをする。
//
// 中核の演出（盤面に赤マスが出て、そこを通るラインを消すとカウンター）は
// ボス戦の予告技として既に出荷済みで、view.dangerCells がそのまま使える。
// 新しく要るのは「誰を狙うかをサーバーが決める」配線だけだった。
class ZeroMode extends VersusBase {
  constructor(ae) {
    super();
    this.mode = 'zero';
    this.ae = ae;
    this.timers = [];
    this.client = null;
    this.verdict = null;        // いま来ている断罪
    this.myCuts = 0;
    this.myMissed = 0;
    this.state = null;
    this.mini = null;
    this.shardsGained = 0;      // 走行中に WebSocket で届いた 👑（HTTP の res.shards とは別勘定）
    this.canWill = false;       // 段にとどめを刺した＝次の枠へ伝言を残せる
    this._willResolve = null;
  }

  every(ms, fn) { const id = setInterval(fn, ms); this.timers.push(id); return id; }
  after(ms, fn) { const id = setTimeout(fn, ms); this.timers.push(id); return id; }
  clearTimers() { for (const id of this.timers) { clearInterval(id); clearTimeout(id); } this.timers = []; }

  async start() {
    // 枠の残り時間に run を切り詰める。残りが極端に短いときは開始せず戻す
    //（枠終了間際に始めて結果が没収されるのを避ける。サーバー側にも猶予がある）。
    const ae = this.ae;
    const slotLeft = (ae && ae.live) ? Math.floor((ae.live.endsAt - Date.now()) / 1000) - 4 : AE_RUN_SECONDS;
    if (slotLeft < 15) {
      toast(t('枠の残り時間が足りません', 'Not enough time left in this slot'), 'err', 3000);
      endToMenu();
      return;
    }
    const runSecs = Math.min(AE_RUN_SECONDS, slotLeft);
    this.setupHud(runSecs);
    $('#oppPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    showItemBar(false);
    showUltBar(false);
    this.startedAt = Date.now();

    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_shadow' });
    this.engine = new Engine();
    v.setEngine(this.engine);
    v.inputLocked = true;
    v.onPlace = r => this.onPlace(r);
    v.onGameOver = () => this.onTopOut();
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('oni');

    this.buildArena();

    this.client = new BattleClient();
    this.client
      .on('zero_found', m => this.onFound(m))
      .on('zero_state', m => this.onState(m))
      .on('zero_verdict', m => this.onVerdict(m))
      .on('zero_cut', m => this.onSomeoneCut(m))
      .on('zero_missed', m => this.onSomeoneMissed(m))
      .on('zero_dan', m => this.onDanBroken(m))
      .on('zero_garbage', m => this.onGarbage(m))
      .on('zero_deal', m => this.onDeal(m.deal))
      .on('zero_deal_vote', m => this.onDealVote(m))
      .on('zero_deal_done', m => this.onDealDone(m))
      .on('zero_stake', m => this.onStake(m))
      .on('zero_revive', () => this.onRevived())
      // 👑 王座の欠片は「斬った瞬間」に battle.js から流れてくる。受け口が
      // 無かったので走行中も結果画面も数字が動かず、宝物庫の残高だけが
      // 増えていた（＝斬っても意味がないように見えていた）。
      // ただし送り先は下の registerHandler のコメントのとおり、この
      // ソケットとは限らない。両方に受け口を置く（サーバーは1本にしか
      // 送らないので二重計上にはならない）。
      .on('shards', m => this.onShards(m))
      // 📝 伝言が保存された合図。これも受け口が無かった。
      .on('zero_will_ok', () => this.onWillOk())
      // 👁️ 七段すべて陥落。ゲーム世界で一度きりしか送られない通知で、
      // 受け口が無いまま二度と再送されない（run.allBroken が立つ）ので、
      // この演出はこれまで一度も出ていなかった。
      .on('zero_complete', m => this.onAllBroken(m))
      // 生の文字列を出さない。英語で遊んでいる人に日本語のトーストが出る。
      .on('error', m => toast(trServer(m.error) || t('エラー', 'Error'), 'err', 3000))
      .on('close', () => { if (!this.ended) toast(t('接続が切れました', 'Disconnected'), 'err'); });

    // 👑 の実際の宛先。server/battle.js の shard() は
    // `[...clients].find(c => sockName(c) === name)` ＝そのユーザーの
    // **最初の** ソケットに送る。clients は接続順の Set で、チャットの常時接続は
    // ページ読み込み時、この BattleClient はモード開始時なので、ふつうは
    // チャット側が先に並ぶ ── つまり上の .on('shards') は一度も呼ばれず、
    // chat.js は知らない type を黙って捨てていた（走行中のトーストも出ず、
    // 結果画面も「初回10」のままだった）。チャット側にも受け口を置いて拾う。
    this._offShards = registerHandler('shards', m => this.onShards(m));

    try {
      await this.client.connect();
      this.client.send({ type: 'zero_join' });
    } catch (err) {
      toast(err.message, 'err', 4000);
      this.finish();
      return;
    }

    // 盤面同期を開始する。カウントダウン中から送っておくと、最初の1手を
    // 斬ったときにもサーバーが「直前の盤面」を1枚持っている状態になる。
    this.pushState();
    this.every(850, () => this.pushState());

    countdownOverlay(3, afterCountdown(this, () => {
      if (this.ended || currentMode !== this) return;
      v.inputLocked = false;
      this.startTimer(() => this.finish());
    }), audio);
  }

  // ---- アリーナ（席・ゼロの盤面・段のバー）----

  buildArena() {
    // #bossPanel の中身を innerHTML で置き換えると、index.html に書いてある
    // ボス戦用の要素(#bossEmoji / #bossName / #bossHp …)が永久に消え、
    // 同じタブでボス戦を始めたときに落ちる。専用の箱を足して、
    // 元の中身は隠すだけにする。
    const panel = $('#bossPanel');
    panel.classList.remove('hidden');
    panel.classList.add('zero-panel');
    for (const el of [...panel.children]) el.classList.add('hidden');
    let box = $('#zeroArena');
    if (!box) { box = document.createElement('div'); box.id = 'zeroArena'; panel.appendChild(box); }
    box.classList.remove('hidden');
    box.innerHTML = [
      '<div class="zero-top">',
      '  <canvas id="zeroBoard" class="zero-board" width="120" height="120"></canvas>',
      '  <div class="zero-bars">',
      '    <div class="zero-title"><span id="zeroDan"></span><span id="zeroTarget"></span></div>',
      '    <div class="zero-hp"><div class="zero-hp-open" id="zeroOpen"></div><div class="zero-hp-seal" id="zeroSeal"></div></div>',
      // 席の開閉ボタンは残りHPの行に相乗りさせる。独立した行にすると
      // それだけで24px、そのぶん手札が削られるので。
      '    <div class="zero-sub"><span id="zeroHpText"></span><span id="zeroCuts"></span>',
      '      <button class="zero-seats-toggle" id="zeroSeatsBtn">▾ 席</button></div>',
      '  </div>',
      '</div>',
      // 席は既定で畳む。開いたままだと手札の場所が半分になり、
      // ピースが小さくなって掴みづらい（レイドで同じことが起きた）。
      '<div class="zero-seats hidden" id="zeroSeats"></div>',
    ].join('');
    this.mini = new MiniBoard($('#zeroBoard'), { skinId: 'skin_shadow' });
    const seatsBtn = $('#zeroSeatsBtn');
    if (seatsBtn) seatsBtn.onclick = () => {
      const box = $('#zeroSeats');
      const open = box.classList.toggle('hidden');
      seatsBtn.textContent = open ? t('▾ 席', '▾ Seats') : t('▴ とじる', '▴ Close');
      if (view) view.resize();      // 手札の高さが変わるので測り直す
    };
  }

  onFound(m) {
    this.state = m;
    // 再接続時も伝言権を復元する ── サーバーが視聴者ごとに載せる canWill が真なら
    // 立てておく（zero_dan を取りこぼしても伝言を書けるように）。真のときだけ立てる。
    if (m.canWill || (m.you && m.you.canWill)) this.canWill = true;
    this.renderState(m);
    this.syncDeal(m.deal);
    toast(t(`席につきました（${m.seats.length}席）── 段${m.dan}`,
      `Seated (${m.seats.length}) — Stage ${m.dan}`), 'announce', 3000);
  }

  onState(m) {
    this.state = m;
    if (m.you) { this.myCuts = m.you.cuts; this.myMissed = m.you.missed; }
    // 次の走行・再接続でも伝言権を失わないよう、state の canWill から復元する。
    if (m.canWill || (m.you && m.you.canWill)) this.canWill = true;
    this.renderState(m);
    this.syncDeal(m.deal);
  }

  // 🤝 開催中の取引に、あとから合流する。
  //
  // 取引UIの入口は zero_deal の1本だけだった。サーバーは席に着いた瞬間の
  // zero_found にも毎秒の zero_state にも deal を必ず載せている（dealView）のに、
  // クライアントが一度も読んでいなかった。走行は120秒・取引は60秒なので、
  // **走行の切れ目に当たっただけで1票も投じられない**。人間の1票は住人5票ぶん
  // ＝ソロなら決定打なので、これは取引という仕掛けそのものが不発になる。
  syncDeal(deal) {
    if (this.ended) return;
    if (!deal || deal.settled || deal.closesAt <= Date.now()) return;
    if ($('#zeroDeal')) return;          // もう出ている
    this.onDeal(deal);
    // すでに投票済みなら、押せる形で出さない（押すと必ずエラーになる）。
    if (deal.voted) {
      this.dealVoted = true;
      const wrap = $('#zeroDeal');
      if (wrap) wrap.querySelectorAll('.zd-btn').forEach(b => { b.disabled = true; });
    }
  }

  renderState(m) {
    if (!m || this.ended) return;
    // 帯は「点で削れる7割」と「人間しか割れない3割」を別の色で見せる。
    // これが伝わらないとイベントの意味が伝わらないので、ここは省かない。
    const hp = m.hp || 1;
    const openLeft = Math.max(0, m.left - m.sealLeft);
    const el = id => $('#' + id);
    if (el('zeroOpen')) el('zeroOpen').style.width = `${Math.min(100, (openLeft / hp) * 100)}%`;
    if (el('zeroSeal')) el('zeroSeal').style.width = `${Math.min(100, (m.sealLeft / hp) * 100)}%`;
    if (el('zeroDan')) el('zeroDan').textContent = t(`段 ${m.dan}/${m.danMax}`, `Stage ${m.dan}/${m.danMax}`);
    if (el('zeroTarget')) {
      el('zeroTarget').textContent = t(`今夜の的：第${m.targetCol + 1}列`, `Mark: col ${m.targetCol + 1}`);
    }
    if (el('zeroHpText')) {
      el('zeroHpText').textContent = t(`残り ${fmt(m.left)} ／ 封印 ${fmt(m.sealLeft)}`,
        `${fmt(m.left)} left / seal ${fmt(m.sealLeft)}`);
    }
    if (el('zeroTarget') && m.stakes) {
      el('zeroTarget').textContent = t(
        '今夜の的：第' + (m.targetCol + 1) + '列　杭' + m.stakes.have + '/' + m.stakes.need,
        'Mark: col ' + (m.targetCol + 1) + '  stakes ' + m.stakes.have + '/' + m.stakes.need);
    }
    if (el('zeroCuts')) {
      el('zeroCuts').textContent = t(`斬 ${this.myCuts} ／ 落 ${this.myMissed}`,
        `cut ${this.myCuts} / miss ${this.myMissed}`);
    }
    if (this.mini && Array.isArray(m.zeroGrid)) this.mini.setGrid(m.zeroGrid);
    const seats = el('zeroSeats');
    if (seats && m.seats) {
      seats.innerHTML = m.seats.map(s => {
        const cls = ['zero-seat'];
        // サーバーが seats[].human を廃止し、受信者本人の席だけ you:true を
        // 立てるようになった。human は「人間全員」に 'me' が付いていて挙動と
        // しても誤りだったので、you に読み替える（＝自分の席だけ光る）。
        if (s.you) cls.push('me');
        if (s.executed) cls.push('gone');
        else if (!s.alive) cls.push('down');
        return `<span class="${cls.join(' ')}">${escapeHtml(s.name)}</span>`;
      }).join('');
    }
  }

  // ---- 断罪 ----

  onVerdict(m) {
    if (this.ended) return;
    this.verdict = m;
    const v = getView();
    v.dangerCells = new Set(m.cells);
    v.keystoneCell = m.keystone;
    // 締切を渡す。残り時間が見えないと、間に合わせようがない。
    v.dangerUntil = Date.now() + m.warnMs;
    v.dangerTotal = m.warnMs;
    v.screenFlash = 0.45;
    audio.countdown(false);
    const name = (session.user && session.user.username) || t('あなた', 'you');
    toast(t(`断罪 ── ${name}　赤マスをラインで斬れ！`,
      `CONDEMNED ── ${name}. Cut the red cells!`), 'err', m.warnMs);
    // 予告時間で自動的に消える（サーバー側も同じ時刻で締める）
    this.after(m.warnMs + 200, () => {
      if (this.verdict && this.verdict.id === m.id) {
        this.verdict = null;
        v.dangerCells = null;
        v.keystoneCell = -1;
        v.dangerUntil = 0;
      }
    });
  }

  // 👁️ U18 / U29 / C22: 盤面と点をサーバーへ同期する。
  //
  // これを送らないと、サーバー側の3つの仕組みが「安全側の何もしない」まま
  // 眠り続ける ── 斬った申告は無検証で通り、人間の点は段のHPに入らず、
  // 赤マスは埋まっているマスからも選ばれてしまう。
  // 送るのは ①1手置くごと ②850ms ごと の2経路。
  // レート制限は10秒で40回なので、850ms間隔（約11回）＋着手ぶんで十分収まる。
  pushState() {
    if (this.ended || !this.client || !this.engine) return;
    try {
      this.client.send({ type: 'zero_state', grid: this.engine.snapshot(), score: this.engine.score });
    } catch { /* 切れていれば次の周期で送り直せばよい */ }
  }

  onPlace(result) {
    this.handlePlace(result);
    // 同期は「斬った」申告の *あと* に送る。先に送ると、サーバーが裏づけに使う
    // 直近の盤面が「線が消えた後」になり、消せる形だったのかが分からなくなる
    // （赤マスはもともと空きマスに点くので、消えた後の盤面には手がかりが無い）。
    this.pushState();
  }

  // 置いた結果、赤マスを通るラインを消していたら「斬った」。
  // 判定はボス戦の予告技とまったく同じ形。
  handlePlace(result) {
    this.updateMyHud(this.engine);
    updateRerollHud(this.engine);
    // 🪧 今夜の的の列を縦に消したら杭が入る。
    // 縦消しは点効率で損なので、ここで「点を取るか、斬りやすくするか」の
    // 選択がそのまま手番の中に生まれる。
    if (result && result.fullCols && result.fullCols.length) {
      this.client.send({ type: 'zero_stake', cols: result.fullCols });
    }
    const v = this.verdict;
    if (!v || !result || result.lineCount === 0) return;
    const hit = v.cells.filter(k => {
      const r = (k / 8) | 0, c = k % 8;
      return result.fullRows.includes(r) || result.fullCols.includes(c);
    });
    if (!hit.length) return;
    this.verdict = null;
    const view2 = getView();
    view2.dangerCells = null;
    view2.keystoneCell = -1;
    // どのマスを消したかをそのまま送る。サーバーが予告時間内かどうかを見る。
    this.client.send({ type: 'zero_cut', id: v.id, cells: hit });
  }

  // ---- 🤝 取引（60秒の生投票）----
  //
  // ゼロが2択を出し、あなたと住人全員が本当に投票する。
  // 票が割れていく60秒がそのまま見世物になるので、途中経過を出し続ける。
  onDeal(deal) {
    if (!deal || this.ended) return;
    this.deal = deal;
    this.dealVoted = false;
    audio.countdown(false);
    const wrap = document.createElement('div');
    wrap.className = 'zero-deal';
    wrap.id = 'zeroDeal';
    wrap.innerHTML = [
      '<div class="zd-q">' + escapeHtml(t(deal.q, deal.qEn)) + '</div>',
      '<div class="zd-bar"><div class="zd-yes" id="zdYes"></div><div class="zd-no" id="zdNo"></div></div>',
      '<div class="zd-tally" id="zdTally"></div>',
      '<div class="zd-btns">',
      deal.options.map(function (o) {
        return '<button class="btn btn-ghost zd-btn" data-pick="' + o.id + '">' + escapeHtml(t(o.text, o.textEn)) + '</button>';
      }).join(''),
      '</div>',
      '<div class="zd-left" id="zdLeft"></div>',
    ].join('');
    document.body.appendChild(wrap);
    const self = this;
    wrap.querySelectorAll('.zd-btn').forEach(function (btn) {
      btn.onclick = function () {
        if (self.dealVoted) return;
        self.dealVoted = true;
        audio.click();
        self.client.send({ type: 'zero_vote', pick: btn.dataset.pick });
        wrap.querySelectorAll('.zd-btn').forEach(function (b2) { b2.disabled = true; });
        btn.classList.add('picked');
      };
    });
    this.renderTally(deal.tally);
    // 残り時間
    this.dealTimer = this.every(250, function () {
      const left = Math.max(0, deal.closesAt - Date.now());
      const el = $('#zdLeft');
      if (el) el.textContent = t('残り ' + Math.ceil(left / 1000) + '秒', Math.ceil(left / 1000) + 's left');
      if (left <= 0) clearInterval(self.dealTimer);
    });
  }

  renderTally(tally) {
    if (!tally) return;
    const total = Math.max(1, tally.yes + tally.no);
    const y = $('#zdYes'), n = $('#zdNo'), tl = $('#zdTally');
    if (y) y.style.width = (tally.yes / total * 100) + '%';
    if (n) n.style.width = (tally.no / total * 100) + '%';
    if (tl) tl.textContent = t('飲む ' + tally.yes + ' ／ 断る ' + tally.no,
      'take ' + tally.yes + ' / refuse ' + tally.no);
  }

  onDealVote(m) {
    this.renderTally(m.tally);
    // zero_deal_vote から human が消えた（住人の票にだけ印が無い＝人間の
    // 一覧表になっていたため）。ここで human を見ていると投票トーストが
    // 1つも出なくなるので、誰の票でも同じように出す。
    toast(t(m.by + ' が投票した', m.by + ' voted'), 'ok', 1200);
  }

  onDealDone(m) {
    const el = $('#zeroDeal');
    if (el) el.remove();
    if (this.dealTimer) clearInterval(this.dealTimer);
    this.deal = null;
    const yes = m.win === 'yes';
    audio[yes ? 'victory' : 'putback']();
    toast(yes
      ? t('取引成立 ── ' + m.tally.yes + ' 対 ' + m.tally.no, 'Deal struck — ' + m.tally.yes + ' to ' + m.tally.no)
      : t('取引は断られた ── ' + m.tally.no + ' 対 ' + m.tally.yes, 'Refused — ' + m.tally.no + ' to ' + m.tally.yes),
      'announce', 4000);
  }

  onStake(m) {
    if (m.ready) {
      audio.victory();
      toast(t('杭 ' + m.need + '本！ 次の断罪は予告が長くなる', m.need + ' stakes! Longer warning next time'), 'ok', 2400);
    } else {
      toast(t('杭 ' + m.have + '/' + m.need, 'stakes ' + m.have + '/' + m.need), 'ok', 1100);
    }
  }

  onSomeoneCut(m) {
    const me = session.user && m.by === session.user.username;
    if (me) {
      audio.combo(9);
      const v2 = getView();
      v2.screenFlash = 0.3;
      v2.addFloatText(v2.boardX + v2.boardSize / 2, v2.boardY + v2.boardSize * 0.18,
        m.keystone ? 'KEYSTONE!' : 'CUT!', m.keystone ? '#f0b429' : '#43d9e8', 2);
      this.engine.chargeUlt(12);
    }
    toast(m.keystone
      ? t(`${m.by} が急所を斬った！ 封印 −${fmt(m.damage)}`, `${m.by} hit the keystone! seal −${fmt(m.damage)}`)
      : t(`${m.by} が斬った ── 封印 −${fmt(m.damage)}`, `${m.by} cut — seal −${fmt(m.damage)}`),
      'ok', 1600);
  }

  onSomeoneMissed(m) {
    if (!m.victim) return;
    audio.bossAttack();
    toast(t(`${m.victim} が処刑された（${m.target} が落とした）`,
      `${m.victim} was executed (${m.target} let it slip)`), 'err', 2600);
    // 👁️ 自分が時間内に斬れなかった赤マスは、自分の盤面へお邪魔として返ってくる。
    // engine には座標指定でお邪魔を置く口が無いので、onGarbage と同じ経路
    // （addGarbage は resolveLines と over 判定も内部で行う）で個数だけ再現する。
    // 他人のミス（mine が真でない）や、自分が断罪プレイ中でない場合は誤爆させない。
    if (m.mine === true && Array.isArray(m.cells) && m.cells.length && !this.ended && this.engine) {
      this.engine.addGarbage(m.cells.length);
      getView().screenFlash = 0.25;
      if (this.engine.over) this.onTopOut();
    }
  }

  onDanBroken(m) {
    audio.victory();
    confettiBurst(90);
    toast(t(`第${m.dan}段 陥落！ 王座がひとつ返ってきた${m.by ? `（とどめ：${m.by}）` : ''}`,
      `Stage ${m.dan} has fallen — one throne returns${m.by ? ` (by ${m.by})` : ''}`), 'announce', 5000);
    // とどめを刺した本人だけが、次の枠へ40字残せる（サーバーの submitWill と
    // 同じ条件）。ここで覚えておかないと、席を外す前に聞く機会が無くなる。
    if (m.by && session.user && m.by === session.user.username) this.canWill = true;
  }

  // 👁️ 七段すべて陥落 ── 一度きりの完全勝利。
  onAllBroken(m) {
    const n = (m && m.dan) || 7;
    audio.victory();
    confettiBurst(150);
    toast(t(`${n}段すべて陥落 ── 王座はすべて還った`,
      `All ${n} stages have fallen — every throne is reclaimed`), 'announce', 8000);
  }

  // 👑 王座の欠片が増えた（斬った／急所／段に居合わせた／とどめ）。
  // 結果画面の res.shards は「その日はじめて席に着いた」ぶんしか含まないので、
  // ここで積んでおいて最後に足す。
  onShards(m) {
    const n = m ? Math.max(0, m.gained | 0) : 0;
    if (!n) return;
    this.shardsGained += n;
    if (session.user && typeof m.total === 'number') session.user.shards = m.total;
    audio.coin();
    toast(t(`王座の欠片 +${fmt(n)}`, `Throne Shards +${fmt(n)}`), 'ok', 1400);
  }

  // 📝 伝言が保存された。
  onWillOk() {
    toast(t('伝言を残しました ── 次の枠の開幕でゼロが読み上げます',
      'Message saved — Zero will read it out when the next slot opens'), 'ok', 3200);
    if (this._willResolve) this._willResolve();
  }

  // 📝 伝言を書いてもらう。サーバー側（battle.js の zero_will / zero-session の
  // submitWill）は揃っているのに、クライアントに送る口がひとつも無く、この機能は
  // 一度も発火していなかった（告知には「40字の伝言を残せます」と出ている）。
  // zero_leave を送ると ws.zeroId が消えてサーバーが席を見失い、zero_will は
  // 黙って捨てられる ── だから必ずソケットを閉じる前に聞く。
  askWill() {
    return new Promise(resolve => {
      if (!this.canWill || !this.client || !this.client.connected) { resolve(); return; }
      let done = false;
      let waitId = null;
      const end = () => {
        if (done) return;
        done = true;
        this._willResolve = null;
        clearTimeout(waitId);
        closeModal();
        resolve();
      };
      this._willResolve = end;
      const m = showModal(`
        <h2>${t('次の枠へ伝言を残す', 'Leave a message for the next slot')}</h2>
        <p class="muted center" style="margin-bottom:10px">${t(
          'とどめを刺したあなただけが書けます。40字まで ── 次の枠の開幕でゼロが読み上げます。',
          'Only the one who landed the final blow may write. Up to 40 characters — Zero reads it out when the next slot opens.')}</p>
        <input id="zeroWillText" type="text" maxlength="40" autocomplete="off"
          placeholder="${t('例：七段目、右の列に気をつけて', 'e.g. Watch the right column on stage seven')}">
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="zeroWillSkip">${t('残さない', 'Skip')}</button>
          <button class="btn btn-gold" id="zeroWillSend">${t('残す', 'Leave it')}</button>
        </div>`, { dismissable: false });
      // 返事が来なくても先へ進める。ここで詰まると結果画面すら出せない。
      waitId = setTimeout(end, 12000);
      const input = m.querySelector('#zeroWillText');
      let sent = false;
      const send = () => {
        // 二度押しで送らない。サーバー側は 3回/分で弾くので、連打すると
        // 本命の1通が捨てられる。
        if (sent) return;
        const text = (input && input.value || '').trim();
        if (!text) { audio.error(); return; }
        sent = true;
        audio.click();
        this.client.send({ type: 'zero_will', text });
      };
      if (input) {
        setTimeout(() => { try { input.focus(); } catch { /* 端末による */ } }, 60);
        input.onkeydown = ev => { if (enterIsLive(ev)) send(); };
      }
      m.querySelector('#zeroWillSkip').onclick = () => { audio.click(); end(); };
      m.querySelector('#zeroWillSend').onclick = send;
    });
  }

  onGarbage(m) {
    if (this.ended || !this.engine) return;
    const n = Math.max(0, Math.min(9, m.cells | 0));
    if (!n) return;
    this.engine.addGarbage(n);
    audio.bossAttack();
    getView().screenFlash = 0.25;
    toast(t(`ゼロの一手 ── お邪魔 ${n}個`, `Zero's move — ${n} garbage`), 'err', 1500);
  }

  onTopOut() {
    if (this.ended) return;
    this.client.send({ type: 'zero_topout' });
    getView().inputLocked = true;
    toast(t('盤面が詰みました。60秒後に復帰します', 'Board full — back in 60s'), 'err', 4000);
  }

  onRevived() {
    if (this.ended || !this.engine) return;
    this.engine.reviveBoard();
    getView().inputLocked = false;
    audio.victory();
    toast(t('復帰しました', 'You are back'), 'ok', 2000);
  }

  // ---- 終わり ----

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    this.clearTimers();
    const v = getView();
    if (v) { v.dangerCells = null; v.keystoneCell = -1; v.inputLocked = true; }
    const dl0 = $('#zeroDeal'); if (dl0) dl0.remove();
    // 🏁 まず「走行は終わった」とだけ伝える。席は残る（伝言を送るのに要る）。
    //    これを送らないと、結果画面と伝言モーダル（最長12秒）を開いている間も
    //    サーバーからは「生きている人」に見えるので断罪が飛び続け、盤面を
    //    触れない本人が毎回落として、段のHPが回復し、住人がその人の名前で
    //    処刑されていた。席を畳むのは伝言のあとの zero_leave。
    if (this.client && this.client.connected) {
      try { this.client.send({ type: 'zero_done' }); } catch { /* もう閉じている */ }
    }
    // 📝 伝言は席を外す前にしか送れない（zero_leave の後はサーバーが席を
    // 見失って zero_will を捨てる）。権利のある人にだけ、閉じる直前に聞く。
    await this.askWill();
    if (this.client) {
      try { this.client.send({ type: 'zero_leave' }); this.client.ws.close(); } catch { /* もう閉じている */ }
    }
    // 🚪 伝言を待っている間（最長12秒）にメニューへ戻っていたら、そこまで。
    //    席の後始末（zero_leave）だけは必ず通してから降りる。
    if (currentMode !== this) return;

    const e = this.engine;
    let res = null;
    try {
      res = await api('/api/adminevent/result', {
        method: 'POST',
        body: {
          score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
          duration: (Date.now() - this.startedAt) / 1000,
          pieces: e.piecesPlaced || 0,
        },
      });
      updateTopbar();
    } catch (err) {
      toast(err.message, 'err', 4000);
    }
    if (res && res.event) this.ae = res.event;

    // 👑 HTTP が返す res.shards は「その日はじめて席に着いた」ぶん（初回10・
    // 以降0）しかない。斬って稼いだぶんは WebSocket で届いていて、それを
    // 積んだのが shardsGained。足さないと、数百稼いだ回でも「+10」か
    // 行ごと消えて、宝物庫の残高だけが増える ── 実際の獲得と食い違う。
    const shards = (res && res.shards ? res.shards : 0) + (this.shardsGained || 0);
    const st = this.state;
    showModal([
      `<h2>${t('断罪 ── 記録', 'Condemned — record')}</h2>`,
      '<div class="zero-result">',
      `  <div><b>${this.myCuts}</b><span>${t('斬った', 'cut')}</span></div>`,
      `  <div><b>${this.myMissed}</b><span>${t('落とした', 'missed')}</span></div>`,
      `  <div><b>${fmt(e.score)}</b><span>${t('スコア', 'score')}</span></div>`,
      '</div>',
      // 何をもらったのかを出す。ここが空だと、斬っても落としても
      // 画面の見た目が変わらず「やっても意味がない」ように見える。
      '<div class="result-stats">',
      rewardsRows(res ? res.rewards : null),
      shards ? `<div class="rs-row"><span>${ic('shards')} ${t('王座の欠片', 'Throne Shards')}</span><b>+${fmt(shards)}</b></div>` : '',
      res && res.chest && (res.chest.coins || res.chest.gems)
        ? `<div class="rs-row"><span>${t(`お宝ラッシュ（${res.chest.mult}倍）`, `Treasure Rush (${res.chest.mult}×)`)}</span><b>+${fmt(res.chest.coins)} ${ic('coins', 14)} +${fmt(res.chest.gems)} ${ic('gems', 14)}</b></div>`
        : '',
      '</div>',
      st ? `<p class="muted">${t(`段 ${st.dan}/${st.danMax} ／ 封印の残り ${fmt(st.sealLeft)}`,
        `Stage ${st.dan}/${st.danMax} — seal ${fmt(st.sealLeft)} left`)}</p>` : '',
      st && st.fallen && st.fallen.length
        ? `<p class="zero-fallen">${t('今日、消えた住人', 'Lost today')}: ${st.fallen.map(escapeHtml).join('、')}</p>` : '',
      '<div class="modal-buttons">',
      `  <button class="btn btn-ghost" id="zeroChron">${t('断罪録', 'Chronicle')}</button>`,
      `  <button class="btn btn-primary" id="zeroClose">${t('メニュー', 'Menu')}</button>`,
      `  <button class="btn btn-gold" id="zeroAgain">${t('もう一度', 'Again')}</button>`,
      '</div>',
    // 枠外タップでは閉じさせない。閉じてしまうと動かない盤面だけが残り、
    // メニューに戻る手段が画面から消える（リロードしかなくなる）。
    // 👁 は「押している間だけ透ける」だけなので、閉じない約束は保たれる。
    ].join(''), { dismissable: false, peekable: true });
    // ここでも元に戻す。destroy() は次のモードを始めるまで呼ばれないので、
    // 結果画面からメニューに戻った直後にボス戦を始めると壊れたままになる。
    this.restoreBossPanel();
    const btn = $('#zeroClose');
    // 他モードの結果画面と同じく endToMenu() を通す。showScreen だけだと
    // 断罪が占有した board_shadow と 'oni' の BGM がメニューにも次のモードにも
    // 残り、隠れたキャンバスの描画ループも回りっぱなしになる。
    if (btn) btn.onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    // 枠が生きている間はその場から再入場できるようにする。
    // 無いと再挑戦のたびにメニュー最下部までスクロールし直しになる。
    const again = $('#zeroAgain');
    if (again) again.onclick = () => {
      const ae = this.ae;
      closeModal();
      this.destroy();
      if (!ae || !ae.live || ae.live.endsAt <= Date.now()) {
        toast(t('あなたの枠は終了しました。またの参加をお待ちしています！', 'Your slot has ended — see you next time!'), 'announce', 4000);
        endToMenu();   // 同上: テーマ・BGM・描画ループを解放して戻る
        return;
      }
      startAdminEventMode(ae);
    };
    const ch = $('#zeroChron');
    // adminevent.js は modes.js を import しているので、静的に取ると循環する。
    // 押されたときに読み込めば順序の問題は起きない。
    if (ch) ch.onclick = async () => {
      const mod = await import('./adminevent.js');
      mod.openChronicle();
    };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は何もしない。
    // ここで戻さないと、結果モーダルを閉じた人が画面に取り残される。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  // #bossPanel を、隠しただけの元の中身に戻す。
  restoreBossPanel() {
    const zp = $('#bossPanel');
    if (!zp) return;
    const za = $('#zeroArena');
    if (za) za.remove();
    zp.classList.remove('zero-panel');
    for (const el of [...zp.children]) el.classList.remove('hidden');
    zp.classList.add('hidden');
  }
  destroy() {
    this.ended = true;
    this.stopTimer();
    this.clearTimers();
    // 伝言の入力を待っている最中に畳まれたら、待たせずに解く。
    // 放っておくと finish() が最大12秒後に、もう関係のない画面へ結果モーダルを
    // 出してくる。
    if (this._willResolve) this._willResolve();
    // チャット socket に置いた 👑 の受け口を必ず外す。残すと次の枠・次の
    // モードでも古い ZeroMode が生き続け、トーストと shardsGained が二重になる。
    if (this._offShards) { this._offShards(); this._offShards = null; }
    if (this.client && this.client.ws) { try { this.client.ws.close(); } catch { /* 既に閉じている */ } }
    const v = getView();
    if (v) { v.dangerCells = null; v.keystoneCell = -1; }
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    // ボス戦がまた使えるよう、隠しただけの元の中身を戻す
    this.restoreBossPanel();
  }
}


export function startAdminEventMode(ae) {
  // 枠終了直後の取りこぼしを塞ぐ ──「もう一度挑む」ボタンと同じ判定に揃える。
  if (!ae || !ae.live || ae.live.endsAt <= Date.now()) {
    toast(t('いまはあなたの枠の時間ではありません', 'This is not your slot right now'), 'err');
    return;
  }
  if (currentMode) currentMode.destroy();
  // 断罪だけはサーバー権威のセッション（他の3モードはクライアント完結）。
  currentMode = (ae.mode && ae.mode.id === 'zero') ? new ZeroMode(ae) : new AdminEventMode(ae);
  window.__bbaMode = currentMode;
  currentMode.start();
}

export function startSurvival() {
  if (currentMode) currentMode.destroy();
  currentMode = new SurvivalMode();
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 初回ガイド（I17）。ソロ以外を最初に押した人にも同じ説明が届くように、
  // ふつうの盤面の1人用モードからも呼ぶ（すでに見た人には中で何もしない）。
  maybeStartTutorial(currentMode);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// サーバーが更新で落ちる直前に呼ばれる（chat.js の server_shutdown）。
// いま遊んでいる run を、その時点のスコアで正式に終わらせて送信する。
// 対戦はサーバー側が引き分けで畳むので、ここで触るのはソロ系だけ。
window.__bbaSaveNow = () => {
  const m = currentMode;
  if (!m || m.ended) return;
  if (m.mode === 'pvp') return;   // 対戦(pvp)はサーバーが引き分けで畳む。AE等のクライアント完結モードは下で finish() 送信する
  // 送る run を持たないモード（👻再生・🛠️作者の試遊）は finish() が
  // 「完走した結果モーダル」や「クリア失敗」を出すだけで、救えるものが何も無い。
  // モード名の羅列にせず、noItems と同じ流儀のフラグで見る。
  if (m.savable === false) return;
  try {
    if (view) view.inputLocked = true;
    if (typeof m.finish === 'function') m.finish();
  } catch (err) {
    console.warn('shutdown save failed:', err && err.message);
  }
};

// メニューへ戻る唯一の正規ルート。showScreen('menu') だけで戻ると画面は
// 切り替わるが、モードが占有したもの（盤面テーマ・BGM・描画ループ・
// view のフック）は何ひとつ解放されない ── getView() が毎回
// `view.modeTheme || equippedTheme()` を再適用するので、次に始めたソロが
// 前のモードの盤面で始まり、BGM も鳴りっぱなし、隠れたキャンバスの rAF も
// 回り続ける。各モードの quit() / 結果画面の「メニュー」は必ずここを通す。
function endToMenu() {
  if (currentMode) { currentMode.destroy(); currentMode = null; }
  // Mode-installed view hooks/overlays must never leak into the next mode.
  if (view) {
    view.modeTheme = null;   // release the stage a mode claimed
    view.onIntentPlace = null;
    view.onTrayDrop = null;
    view.glowCells = null;
    view.dangerCells = null;
    view.coolCells = null;
    view.oreCells = null;
    view.ghostFx = null;
  }
  if (view) view.stop();
  stopAutopilot();
  stopTutorial();   // 🎓 コーチマークをメニューへ持ち越さない
  clearAtkLesson(); // 💥 攻撃の実地レッスンの帯も持ち越さない
  clearBattleUi();  // ⚔️ 対戦カード・攻撃の帯・リアクション欄（第5波）
  // どのモードでも、3-2-1 の途中で抜けるとオーバーレイだけがメニューの上に
  // 残っていた（countdownOverlay は中断できないため）。ここで必ず片付ける。
  clearIntroOverlays();
  const picker = document.querySelector('.emote-picker');
  if (picker) picker.remove();
  // ⏱ HUDのタイマーを畳む。**urgent（赤＋点滅）を必ず外すこと。**
  //    サバイバル・ウィークリー・デイリーの destroy() は urgent を戻して
  //    いなかったので、残り3秒を切った状態で終わると、次に始めたモードの
  //    HUD（採掘場の深度・パズル遺跡の残り手数・工房の手数）が赤いまま
  //    0.5秒周期で点滅し続けていた。メルトダウンの臨界やタイムアタックの
  //    残り10秒と同じ見た目なので、警告表示そのものが信用できなくなる。
  //    各モードの start() が必要に応じて出し直すので、ここで畳んでよい。
  const hudTimer = $('#hudTimer');
  if (hudTimer) { hudTimer.classList.add('hidden'); hudTimer.classList.remove('urgent'); }
  $('#btnEmote').classList.add('hidden');
  showItemBar(false);
  audio.playTrack('menu');
  showScreen('menu');
}

export function startSolo() {
  if (currentMode) currentMode.destroy();
  currentMode = new SoloMode();
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 いちばん最初の1戦だけ、盤面の上にガイドを重ねる（I17）。
  // モード本体には一切触らない ── 監視は setInterval のポーリングだけで、
  // engine / view のフックは奪わない。
  maybeStartTutorial(currentMode);
}

export function startMeltdown() {
  if (currentMode) currentMode.destroy();
  currentMode = new MeltdownMode();
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 初回ガイド（I17）。ソロ以外を最初に押した人にも同じ説明が届くように、
  // ふつうの盤面の1人用モードからも呼ぶ（すでに見た人には中で何もしない）。
  maybeStartTutorial(currentMode);
}

export function startChimera() {
  if (currentMode) currentMode.destroy();
  currentMode = new ChimeraMode();
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 初回ガイド（I17）。ソロ以外を最初に押した人にも同じ説明が届くように、
  // ふつうの盤面の1人用モードからも呼ぶ（すでに見た人には中で何もしない）。
  maybeStartTutorial(currentMode);
}

export function startVsAi(level) {
  if (currentMode) currentMode.destroy();
  currentMode = new AiMode(level);
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 対戦の初回ガイド。AI戦には攻撃が無い（同じピースが両者に配られる
  // スコア勝負）ので、攻撃の説明は出さない。
  maybeStartVersusTutorial(currentMode, 'ai');
}

export function startOnline(kind = 'duel') {
  if (currentMode) currentMode.destroy();
  currentMode = new OnlineMode(kind);
  window.__bbaMode = currentMode;
  currentMode.start();
}

// 👥 パーティー用。部屋を作るのはリーダーの画面で、できた合言葉を
// サーバーへ返して全員に配ってもらう。こうすると create_room / join_room /
// startRoom を1行も触らずに済む（あそこはいちばん壊しやすい場所なので）。
export function createPartyRoom(mode) {
  return new Promise((resolve) => {
    if (currentMode) currentMode.destroy();
    currentMode = new OnlineMode('custom');
    window.__bbaMode = currentMode;
    // 合言葉が room_update で返ってきたら1回だけ拾う。
    currentMode._onRoomCode = code => { currentMode._onRoomCode = null; resolve(code); };
    currentMode._autoCreate = { team: mode === 'team', mode };
    currentMode.start();
    // 返事が来ない場合に呼び出し側を待たせっぱなしにしない。
    setTimeout(() => resolve(null), 9000);
  });
}

export function joinPartyRoom(code) {
  if (currentMode) currentMode.destroy();
  currentMode = new OnlineMode('custom');
  window.__bbaMode = currentMode;
  currentMode._autoJoin = code;
  currentMode.start();
}

export function cancelMatchmaking() {
  if (currentMode && currentMode.mode === 'pvp') currentMode.quit();
  else endToMenu();
}

export { endToMenu };

export { updateRerollHud, handleEngineOver, updateAutoBtn };

// ===========================================================================
// 🎓 I17 初回インタラクティブチュートリアル
// ===========================================================================
// 初めてソロを始めた人にだけ、実際に遊んでいる盤面の上へ吹き出しを重ねる。
//
// 設計の要点:
//  ・ソロの進行に一切割り込まない。engine.place / view.onPlace / onIntentPlace は
//    どれも奪わず、160ms のポーリングで「置いた／消した」を観測するだけにする。
//    こうしておけば、途中でチュートリアルが例外を投げてもソロは無傷で続く。
//  ・どのステップにも必ず「スキップ」がある（＝詰まない）。
//  ・完了／スキップで localStorage の bba_tut_done を立て、二度と出さない。
//    ゲームオーバーで終わったときは立てない（まだ何も学べていないため）。
//  ・CSS は第1波の #tutTip / .tut-top / .tut-btns / .tut-pulse をそのまま使う。
//    #tutTip は transform: translateX(-50%) を既定で持つので、inline の left は
//    「吹き出しの中心をどこに置くか」を渡すこと（ここでは left は触らない）。
// ---------------------------------------------------------------------------

const TUT_KEY = 'bba_tut_done';

export function tutorialDone() {
  // localStorage が使えない環境（プライベートモード等）では「済み」扱いにして
  // 出さない。出せないガイドを出そうとして例外を投げるより無害。
  try { return localStorage.getItem(TUT_KEY) === '1'; } catch { return true; }
}

function markTutorialDone() {
  try { localStorage.setItem(TUT_KEY, '1'); } catch { /* 保存できなくても進行は止めない */ }
}

// デバッグ／やり直し用。メニューから呼ぶ導線は別担当（main.js）。
//
// 「チュートリアルをやり直す」で戻るのは1人用ガイドだけ…にはしない。
// 初回だけ出すガイドはこのあと3つになった（1人用・対戦・攻撃の実地レッスン）ので、
// ここで全部戻す。片方だけ戻る「やり直す」は、押した人には壊れて見える。
export function resetTutorial() {
  for (const k of [TUT_KEY, VS_TUT_KEY, ATK_SENT_KEY, ATK_TAKEN_KEY]) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

let activeTutorial = null;

export function stopTutorial() {
  if (activeTutorial) activeTutorial.teardown(false);
  activeTutorial = null;
}

// 初回ガイドを出してよいモード。「ふつうの8×8盤面に手札3枚をドラッグして置き、
// そろった列が消える」がそのまま通じる1人用モードだけを入れる（対戦・固定ピースの
// パズル系は説明が噛み合わないので入れない）。メニューには初見で押せるモード
// ボタンが並んでいるので、ソロ限定にしていた頃は ⛏️ や ⛓️ を最初に押した人が
// ルール説明を一度も見られなかった。
const TUT_MODES = new Set(['solo', 'meltdown', 'chimera', 'dig', 'chain', 'survival']);

function maybeStartTutorial(mode) {
  stopTutorial();   // 前の回の吹き出しを絶対に持ち越さない
  if (tutorialDone()) return;
  if (!mode || !TUT_MODES.has(mode.mode)) return;
  const tut = new Tutorial(mode);
  activeTutorial = tut;
  // 盤面のレイアウト（resize）が終わってから測る。
  setTimeout(() => { if (activeTutorial === tut) tut.start(); }, 420);
}

class Tutorial {
  constructor(mode) {
    this.mode = mode;
    this.tip = null;
    this.step = 0;
    this.poll = null;
    this.pulsed = [];
    this.stopped = false;
    this.basePlaced = 0;
    this.baseLines = 0;
    this.hintKey = '';
  }

  // ---- 出入り口 ----------------------------------------------------------

  start() {
    if (this.tip || this.stopped) return;
    const e = this.mode && this.mode.engine;
    if (!e) { this.teardown(false); return; }
    this.basePlaced = e.piecesPlaced || 0;
    this.baseLines = e.linesCleared || 0;
    this.watchResize();
    const tip = document.createElement('div');
    tip.id = 'tutTip';
    // ③④の吹き出しは画面の下側に立つ。縦持ちの手札トレイは最下部の高々130pxに
    // 描かれるので、吹き出し（見出し＋本文＋補足＋ボタン2つ）が手札にかぶり、
    // 読みながら置こうとしたタップを吹き出しが吸っていた。本体は触れないように
    // して、押せる必要があるボタン群（.tut-btns）だけを受け口に戻す。
    tip.style.pointerEvents = 'none';
    document.body.appendChild(tip);
    this.tip = tip;
    this.step = 0;
    this.render();
    this.poll = setInterval(() => this.tick(), 160);
  }

  teardown(completed) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.poll);
    this.poll = null;
    this.clearPulse();
    if (view && view.glowCells) view.glowCells = null;
    if (this.tip) { this.tip.remove(); this.tip = null; }
    this.unwatchResize();
    if (activeTutorial === this) activeTutorial = null;
    if (completed) markTutorialDone();
  }

  skip() {
    audio.click();
    this.teardown(true);
    toast(t('チュートリアルを閉じました', 'Tutorial closed'), 'info', 1800);
  }

  finishAll() {
    audio.coin();
    this.teardown(true);
    toast(t('準備完了！たくさん消して自己ベストを狙おう！',
      'You are ready — clear lines and chase your best score!'), 'ok', 3000);
  }

  // ---- ハイライト --------------------------------------------------------

  pulse(sel) {
    const el = $(sel);
    // 隠れているボタンに枠だけ付けても意味がないので、見えている物だけ。
    if (!el || el.classList.contains('hidden')) return null;
    el.classList.add('tut-pulse');
    this.pulsed.push(el);
    return el;
  }

  clearPulse() {
    for (const el of this.pulsed) el.classList.remove('tut-pulse');
    this.pulsed = [];
  }

  // 「あと1手で1列そろう」置き方をひとつ探す。engine.placements() をそのまま
  // 使うので、盤面の判定はエンジンと必ず一致する。
  lineHint() {
    const e = this.mode && this.mode.engine;
    if (!e || e.over) return null;
    // 吹き出しは盤面の上端2行あたりを隠す位置に立つことがある。列（たて）は
    // 必ず見えるので、隠れうる 0〜1 行目の「よこ」は次点あつかいにして、
    // 見える候補があるならそちらを光らせる。
    let fallback = null;
    const take = h => {
      if (h.kind === 'col' || h.line >= 2) return h;
      if (!fallback) fallback = h;
      return null;
    };
    for (let i = 0; i < 3; i++) {
      const p = e.hand[i];
      if (!p) continue;
      for (const [row, col] of e.placements(p)) {
        const filled = new Set();
        for (const [dr, dc] of p.cells) filled.add((row + dr) * 8 + (col + dc));
        const rows = new Set(), cols = new Set();
        for (const [dr, dc] of p.cells) { rows.add(row + dr); cols.add(col + dc); }
        for (const r of rows) {
          let full = true;
          for (let c = 0; c < 8; c++) { const k = r * 8 + c; if (!e.grid[k] && !filled.has(k)) { full = false; break; } }
          if (full) { const h = take({ kind: 'row', line: r, row, col, index: i }); if (h) return h; }
        }
        for (const c of cols) {
          let full = true;
          for (let r = 0; r < 8; r++) { const k = r * 8 + c; if (!e.grid[k] && !filled.has(k)) { full = false; break; } }
          if (full) { const h = take({ kind: 'col', line: c, row, col, index: i }); if (h) return h; }
        }
      }
    }
    return fallback;
  }

  // 対象の行／列のうち「すでに埋まっているマス」を光らせる。
  // view.glowCells は drawBlocks が『マスに値があるとき』にだけ拾うので、
  // 空マスを入れても描かれない（入れても無害だが、入れない方が誠実）。
  showHint(hint) {
    const e = this.mode && this.mode.engine;
    const v = view;
    if (!e || !v) return;
    const cells = new Set();
    for (let n = 0; n < 8; n++) {
      const k = hint.kind === 'row' ? hint.line * 8 + n : n * 8 + hint.line;
      if (e.grid[k]) cells.add(k);
    }
    v.glowCells = cells;
  }

  // ---- 本文 --------------------------------------------------------------

  stepCount() { return 4; }

  content() {
    const n = this.step;
    if (n === 0) {
      return {
        top: true,
        title: t('① まずは1手おいてみよう（1/4）', '1. Place your first block (1/4)'),
        body: t('下の3つが「手札」。指でつかんで盤面へドラッグ！',
          'Those three pieces are your hand — drag one onto the board!'),
        hint: null,
        next: null,
      };
    }
    if (n === 1) {
      return {
        top: true,
        title: t('② 1列そろえて消す（2/4）', '2. Fill a line to clear it (2/4)'),
        body: t('たて or よこの8マスが埋まると、その列がまるごと消えて大量得点！',
          'Fill all 8 squares of a row or column and it clears for big points!'),
        hint: this.hintKey
          ? t('光っている列を完成させよう！', 'Complete the glowing line!')
          : null,
        next: t('わかった', 'Got it'),
      };
    }
    if (n === 2) {
      return {
        top: false,
        title: t('③ ゴーストとコンボ', '3. Ghost preview & combos'),
        body: t('ドラッグ中は落ちる位置が半透明の「ゴースト」で見える。消える列は白く光って予告されるので、置く前に確かめよう。',
          'While dragging, a translucent ghost shows the landing spot. Lines that will clear glow white before you drop.'),
        hint: t('続けて消すと「コンボ」！ 連続するほど倍率が上がってスコアが跳ね上がる。',
          'Clear on consecutive placements for a COMBO — the multiplier climbs fast.'),
        next: t('次へ', 'Next'),
      };
    }
    // 奥義バーはモードによって出ない（公平のためにブースターを切っているモード
    // など）。出ていないボタンの説明をすると、探しても見つからない。
    const ultBtn = $('#btnUlt');
    const hasUlt = !!ultBtn && !ultBtn.classList.contains('hidden');
    return {
      top: false,
      title: hasUlt ? t('④ 2つの切り札', '4. Your two lifelines')
        : t('④ 切り札', '4. Your lifeline'),
      body: t('リロール：置く場所が無くなりそうなとき、手札を丸ごと引き直せる（1ゲーム1回）。',
        'Reroll: swap your whole hand when you are running out of room (once per game).'),
      hint: hasUlt
        ? t('奥義：ラインを消すとゲージが溜まり、100%で必殺技が撃てる。',
          'Ultimate: clearing lines charges the gauge — fire it at 100%.')
        : null,
      next: t('はじめる！', 'Start playing!'),
    };
  }

  // 盤面を触ってもらうステップでは、吹き出しが「盤面も手札も隠さない」場所に
  // 立つのが理想。縦持ちだと盤面の下と手札の間がふつう大きく空くので、
  // 入るならそこへ。入らなければ HUD のすぐ下（✕/🔄/⚡ だけは必ず押せる位置）。
  positionTip(preferTop) {
    const tip = this.tip;
    if (!tip) return;
    if (!preferTop) { tip.classList.remove('tut-top'); tip.style.top = ''; return; }
    tip.classList.add('tut-top');
    const canvas = $('#gameCanvas');
    const v = view;
    const h = tip.offsetHeight || 170;
    if (canvas && v && v.cell) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width) {
        const boardBottom = rect.top + v.boardY + v.boardSize;
        // 手札の枠(trayY..trayY+trayH)は縦に広いが、コマ自体はその中央あたりに
        // 描かれる（game.js の drawTray）。上端で測ると使える隙間をほぼ全部
        // 捨ててしまうので、コマが始まるあたりまでを空きとみなす。
        // 横持ちは手札が盤面の右なので、下は canvas の底まで空いている。
        const trayTop = v.sideTray ? (rect.top + rect.height) : (rect.top + v.trayY + v.trayH * 0.38);
        if (trayTop - boardBottom >= h + 12) {
          tip.style.top = `${Math.round(boardBottom + 8)}px`;
          return;
        }
      }
    }
    const hud = document.querySelector('#screen-game .game-hud');
    const r = hud && hud.getBoundingClientRect();
    tip.style.top = r && r.height ? `${Math.round(r.bottom + 8)}px` : '';
  }

  render() {
    const tip = this.tip;
    if (!tip) return;
    const c = this.content();
    tip.innerHTML = [
      `<b>${escapeHtml(c.title)}</b>`,
      `<p>${escapeHtml(c.body)}</p>`,
      c.hint ? `<small>${escapeHtml(c.hint)}</small>` : '',
      '<div class="tut-btns">',
      `<button class="btn btn-ghost" id="tutSkip">${t('スキップ', 'Skip')}</button>`,
      c.next ? `<button class="btn btn-primary" id="tutNext">${escapeHtml(c.next)}</button>` : '',
      '</div>',
      // 盤面を触ってもらう①②は、吹き出しが盤面と手札の間に収まるかどうかが
      // 高さで決まる。番号は見出しに入れてあるので、この2つでは行を足さない。
      c.top ? '' : `<small>${this.step + 1} / ${this.stepCount()}</small>`,
    ].join('');
    // 本体は pointer-events: none（手札を覆っても操作を吸わない）。押せないと
    // 困るのはボタンだけなので、そこだけ受け口に戻す。
    const btns = tip.querySelector('.tut-btns');
    if (btns) btns.style.pointerEvents = 'auto';
    const skip = tip.querySelector('#tutSkip');
    if (skip) skip.onclick = () => this.skip();
    const next = tip.querySelector('#tutNext');
    if (next) next.onclick = () => this.advance();
    // 高さが決まってから置き場所を決める（中身によって高さが変わるため）。
    this.positionTip(!!c.top);
    // 📐 いまの段の「上/下」を覚えておく。画面が回ったときに引き直すのに要る。
    this.tipPreferTop = !!c.top;
  }

  // 📱 端末の回転・画面幅の変化で置き直す。
  //
  //   positionTip はインラインの top を px で焼くだけで、tick（160ms）も
  //   resize / orientationchange も呼び直していなかった。横持ちでは手札が
  //   盤面の右（sideTray）に来るので被り方も変わるうえ、.tut-btns だけ
  //   pointer-events:auto なので、下の手札を狙ったタップを吸う ──
  //   **いちばん最初に遊ぶ人が、最初の1手でコマを掴めなくなる。**
  //   dom.js:381 のトーストが同じ手当てをしているので、それに揃える。
  watchResize() {
    if (this._onResize) return;
    this._onResize = () => {
      if (this.stopped || !this.tip) return;
      // 回転直後はまだ古い寸法が返ることがある。次のフレームで測り直す。
      requestAnimationFrame(() => {
        if (!this.stopped && this.tip) this.positionTip(!!this.tipPreferTop);
      });
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
  }

  unwatchResize() {
    if (!this._onResize) return;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this._onResize = null;
  }

  advance() {
    audio.click();
    if (this.step >= this.stepCount() - 1) { this.finishAll(); return; }
    this.step++;
    this.clearPulse();
    if (view) view.glowCells = null;
    this.hintKey = '';
    if (this.step === 3) {
      // 実際のボタンを光らせる。奥義バーが出ていないモードでは何も起きない。
      this.pulse('#btnReroll');
      this.pulse('#btnUlt');
    }
    this.render();
  }

  // ---- 監視（ポーリング）------------------------------------------------

  tick() {
    const m = this.mode;
    // モードが差し替わった／終わったら、記録は立てずに静かに畳む。
    if (!m || m.ended || currentMode !== m || !m.engine) { this.teardown(false); return; }
    // 結果モーダルなど、上に何か出ているときは黙る。
    const e = m.engine;
    if (this.step === 0) {
      if ((e.piecesPlaced || 0) > this.basePlaced) {
        audio.coin();
        this.advance();
      }
      return;
    }
    if (this.step === 1) {
      if ((e.linesCleared || 0) > this.baseLines) {
        // 実際に消せた ── いちばん伝わる瞬間なので、そこで次へ。
        this.advance();
        return;
      }
      const hint = this.lineHint();
      const key = hint ? `${hint.kind}:${hint.line}` : '';
      if (key !== this.hintKey) {
        this.hintKey = key;
        if (hint) this.showHint(hint);
        else if (view) view.glowCells = null;
        this.render();
      }
    }
  }
}

// ===========================================================================
// 💥 攻撃の実地レッスン（アタック戦・バトルロイヤル）
// ===========================================================================
// 何が問題だったか:
//   2ライン以上まとめて消すと相手にお邪魔が飛ぶ。それがこのゲームの対戦の
//   中心なのに、画面に出るのは「💥 攻撃！」の4文字だけだった。
//   **何をしたから攻撃になったのか**（＝まとめて消したこと）も、
//   **何個送ったのか**も分からないので、何試合遊んでもルールを覚えられない。
//   受けた側も「💥 妨害 +2！」だけで、相手が何をしたのかが見えなかった。
//
// 出し方の加減（ここが肝）:
//   ・毎回      … 盤面のフロートテキスト（「💥 攻撃！」＋「お邪魔 +2」）。
//   ・最初の数回 … 文になった小さい帯を HUD の下に出す。
//   ・いちばん最初の1回だけ … トースト。
//   トーストは同時3件で頭打ち・同じ文言は「×N」にまとまる仕様なので、
//   攻撃のたびに撃つと脱落・KO・切断といった見逃せない通知を押し出す。
//   だから主役はフロートテキストと帯にして、トーストは1回に絞る。
//
// 回数は localStorage（既存の bba_tut_done と同じ流儀）。送った側／受けた側で
// 別々に数える ── ずっと殴られっぱなしの人が「受けた側の説明」を
// 一度も読めないまま打ち止めになるのを避けるため。
// ---------------------------------------------------------------------------

const ATK_SENT_KEY = 'bba_atk_lesson_sent';
const ATK_TAKEN_KEY = 'bba_atk_lesson_taken';
const ATK_LESSON_MAX = 3;   // これだけ見たら、もう邪魔なので出さない

function atkLessonSeen(key) {
  // localStorage が使えない環境では「見終わった」扱い。出せないガイドを
  // 出そうとして例外を投げるより無害（tutorialDone と同じ考え方）。
  try { return Number(localStorage.getItem(key)) || 0; } catch { return ATK_LESSON_MAX; }
}

function bumpAtkLesson(key, seen) {
  try { localStorage.setItem(key, String(seen + 1)); } catch { /* 保存できなくても進行は止めない */ }
}

// HUD のすぐ下に出す小さい帯。
// ⚠️ 見た目を inline style で書いているのは、この波では public/css/style.css が
//    別担当の担当ファイルで触れないため。CSS へ移すときは .atk-lesson を作って
//    ここを className だけにできる（forOthers に出してある）。
function showAtkLessonBanner(title, body, hint) {
  if (!document.body) return;
  const old = document.querySelector('.atk-lesson');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'atk-lesson';
  // 盤面も手札も指で触れなくならないように、帯自体は入力を吸わない。
  el.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)',
    'z-index:95',                       // トースト(90)より上、チュートリアル(150)より下
    'pointer-events:none',
    'width:min(340px,calc(100vw - 28px))',
    'box-sizing:border-box',
    'padding:9px 13px', 'border-radius:14px',
    'background:linear-gradient(160deg,rgba(58,26,20,0.96),rgba(24,14,30,0.96))',
    'border:1px solid #ff8a5c',
    'box-shadow:0 12px 32px rgba(0,0,0,0.55),0 0 18px rgba(255,138,92,0.28)',
    'font-size:12.5px', 'line-height:1.55', 'font-weight:700', 'text-align:center',
    'color:#fff',
  ].join(';');
  const b = document.createElement('b');
  b.style.cssText = 'display:block;color:#ffb27a;font-size:13.5px;font-weight:900';
  b.textContent = title;
  const p = document.createElement('span');
  p.style.cssText = 'display:block';
  p.textContent = body;
  el.appendChild(b);
  el.appendChild(p);
  if (hint) {
    const s = document.createElement('small');
    s.style.cssText = 'display:block;margin-top:3px;color:#c9c2d8;font-size:11px;font-weight:600';
    s.textContent = hint;
    el.appendChild(s);
  }
  document.body.appendChild(el);
  // 置き場所は「相手パネルの下」。攻撃した／されたその瞬間に相手の盤面を
  // 隠してしまうと、いちばん見たいもの（自分が送ったお邪魔が積もる様子）が
  // 見えない。相手パネルが無い場面では HUD の下に落とす。
  // 盤面の上端には少しかぶるが、帯は入力を吸わないので置く手はそのまま通る。
  const anchor = (() => {
    const opp = $('#oppPanel');
    if (opp && !opp.classList.contains('hidden')) return opp;
    return document.querySelector('#screen-game .game-hud');
  })();
  const r = anchor && anchor.getBoundingClientRect();
  el.style.top = r && r.height ? `${Math.round(r.bottom + 6)}px` : '96px';
  // CSS を触れないぶん、出入りのアニメは Web Animations API で。
  // 非対応環境（el.animate が無い）ではただ出て消えるだけで、破綻はしない。
  if (el.animate) {
    el.animate([{ opacity: 0, transform: 'translateX(-50%) translateY(-8px)' },
      { opacity: 1, transform: 'translateX(-50%) translateY(0)' }], { duration: 180, easing: 'ease-out' });
  }
  setTimeout(() => el.remove(), 2800);
}

// メニューへ戻るとき（endToMenu）に必ず片付ける。position: fixed なので、
// 残ると次の画面の上に浮いたままになる。
function clearAtkLesson() {
  const el = document.querySelector('.atk-lesson');
  if (el) el.remove();
}

/**
 * 攻撃した／された瞬間に「いま何が起きたか」を教える。
 * @param {'sent'|'taken'} dir  送った側か受けた側か
 * @param {{lines:number, cells:number}} info  ライン数と、お邪魔の個数
 */
function attackLesson(dir, info) {
  const cells = Math.max(0, Number(info && info.cells) || 0);
  if (!cells) return;
  const lines = Math.max(0, Number(info && info.lines) || 0);
  const key = dir === 'sent' ? ATK_SENT_KEY : ATK_TAKEN_KEY;
  const seen = atkLessonSeen(key);
  if (seen >= ATK_LESSON_MAX) return;
  bumpAtkLesson(key, seen);

  let title, body;
  if (dir === 'sent') {
    title = t(`${lines}ライン同時消し！`, `${lines} lines at once!`);
    body = t(`相手の盤面にお邪魔を ${cells}個 送り込んだ`,
      `You dumped ${cells} garbage blocks on your opponent`);
  } else {
    title = t(`お邪魔を ${cells}個 受けた`, `You took ${cells} garbage blocks`);
    // 受けた側は、サーバーが lines を載せてくれる場合だけライン数まで言う。
    // 個数から逆算はできない（3ライン＋コンボと4ラインが同じ個数になる）。
    body = lines >= 2
      ? t(`相手の${lines}ライン同時消し`, `Your opponent cleared ${lines} lines at once`)
      : t('相手が2ライン以上をまとめて消した', 'Your opponent cleared 2 or more lines at once');
  }
  // 1回目だけ「ではどうすればいいのか」を足す。2回目以降は起きたことだけ。
  const hint = seen === 0
    ? (dir === 'sent'
      ? t(`2ライン→${attackCellsFor(2)}個 / 3ライン→${attackCellsFor(3)}個 / 4ライン→${attackCellsFor(4)}個（1ラインでは飛ばない）`,
        `2 lines → ${attackCellsFor(2)} / 3 → ${attackCellsFor(3)} / 4 → ${attackCellsFor(4)} (a single line sends nothing)`)
      : t('お邪魔は単独では消えない。それを含む列を8マス埋めれば消える',
        'Garbage never clears on its own — fill the whole line that contains it'))
    : '';
  showAtkLessonBanner(title, body, hint);

  // トーストはいちばん最初の1回だけ（同時3件の枠を攻撃で埋めない）。
  if (seen === 0) {
    toast(dir === 'sent'
      ? t('まとめて消すと相手を攻撃できる！', 'Clearing lines together attacks your opponent!')
      : t('攻撃された！ 2ライン以上まとめて消すと撃ち返せる',
        'You were attacked! Clear 2+ lines at once to strike back'), 'announce', 3000);
  }
}

// ===========================================================================
// ⚔️ オンライン対戦を「見える」ようにする（第5波）
// ===========================================================================
// 遊んでいる人の側から見て、オンライン対戦は次の3つが画面に出ていなかった。
//   ① 誰と戦っているのか … 相手パネルに「名前 (段位 R1234)」の1行だけ
//   ② 何が飛んできたのか … お邪魔が予告なく降る（量も原因も分からない）
//   ③ 何が起きたのか     … 結果画面がレート変動の1行で終わる
// この節はその3つぶんの**表示だけ**を持つ。守っている約束:
//   ・進行に触らない（engine / view.onPlace のフックを奪わない）
//   ・サーバーへ新しいフレームを作らない（既存の 'emote' に相乗りするだけ）
//   ・要素はすべて自分で片付ける（endToMenu の clearBattleUi が最後の砦）
//
// 🔒 住人の秘匿 — この節でいちばん大事なこと
//   相手の情報を増やすほど「情報が少ない側＝住人」という手がかりになる。
//   対戦カードは match_found の players[] に来た欄しか描かず、任意の欄
//   （称号・ギルド・戦績）は **カードに並ぶ全員がその欄を持つときだけ** 出す。
//   片方にしか無い欄は、値ではなく**行の有無そのもの**が正体を明かすため。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. 対戦カード（3-2-1 の裏で「誰と戦うのか」を見せる）
// ---------------------------------------------------------------------------

// 任意の欄。サーバーが載せてくれた日に**勝手に出る**ように書いてある
// （今の match_found には無いので、いまは1つも出ない）。
// value() は必ず「文字だけ」を返すこと ── 描く直前に escapeHtml を通すので、
// アイコン(SVG)を混ぜるとタグがそのまま画面に出る。
const VS_CARD_EXTRAS = [
  {
    label: () => t('称号', 'Title'),
    // 称号はサーバー側の既存の形（index.js の titleOf / residents.js のどちらも
    // { id, name, color }）をそのまま受けられるようにしておく。id が付いていれば
    // catName が英語名まで引ける ── 文字列だけで来ても壊れない。
    value: p => {
      const v = p.title;
      if (typeof v === 'string') return v || null;
      if (v && typeof v === 'object' && typeof v.name === 'string') return catName(v) || v.name;
      return null;
    },
  },
  {
    label: () => t('ギルド', 'Guild'),
    // ギルドはタグ（🛡️の4文字）でも名前でも来うる。文字列だけを受ける。
    value: p => {
      const v = p.guild;
      if (typeof v === 'string') return v || null;
      if (v && typeof v === 'object' && typeof v.tag === 'string') return v.tag || null;
      return null;
    },
  },
  {
    label: () => t('直近', 'Recent'),
    // { w, l } で来る想定。数字以外が来たら**出さない**（欄が壊れて片方だけ
    // 消えると、それがそのまま正体の手がかりになる）。
    value: p => {
      const r = p.record;
      if (!r || typeof r !== 'object') return null;
      const w = Number(r.w), l = Number(r.l);
      if (!Number.isFinite(w) || !Number.isFinite(l)) return null;
      return t(`${w}勝 ${l}敗`, `${w}W ${l}L`);
    },
  },
];

// カードを出してよい対戦。「向かい合う2人がいて、勝敗が付く」形のものだけ。
//   raid  … 2人でも**味方**同士（1体のボスを削る協力戦）。「対戦相手」と
//           書いたら嘘になるので必ず外す
//   team  … 4人なので下の players.length で落ちるが、意図を名前で残す
//   coop / land … onMatchFound の手前で別の setup へ抜けるのでここには来ない
const VS_CARD_MODES = new Set(['attack', 'duel', 'tourney']);

let vsCardTimers = [];

/** 対戦カードを畳む（3-2-1 の中断・離脱・メニュー復帰のどこからでも呼べる）。 */
function clearVersusCard() {
  for (const id of vsCardTimers) clearTimeout(id);
  vsCardTimers = [];
  for (const el of document.querySelectorAll('.vs-card')) el.remove();
}

// カード1枚ぶん。**両者まったく同じ関数から作る**のが肝心で、
// 「自分の側だけ豪華」にすると相手側の情報の少なさが目立ってしまう。
function vsCardSideHtml(p, extras, side) {
  const rating = Number.isFinite(p.rating) ? p.rating : null;
  const level = Number.isFinite(p.level) ? p.level : null;
  // レートが無いのはゲスト。段位の欄を消すのではなく「―」で埋める ──
  // 行が消えると、カードの高さが左右で変わって不揃いになる。
  const rank = rating != null
    ? rankBadge(rating)
    : `<span class="vsc-unranked">${t('段位なし', 'Unranked')}</span>`;
  return `
    <div class="vsc-side vsc-${side}">
      <div class="vsc-who">${side === 'me' ? t('あなた', 'YOU') : t('対戦相手', 'OPPONENT')}</div>
      <div class="vsc-name">${escapeHtml(String(p.name == null ? '?' : p.name))}</div>
      <div class="vsc-rank">${rank}</div>
      <div class="vsc-meta">
        <span>Lv <b>${level != null ? level : '―'}</b></span>
        <span>R <b>${rating != null ? rating : '―'}</b></span>
      </div>
      ${extras.map(x => `<div class="vsc-extra"><span>${x.label()}</span><b>${escapeHtml(String(x.value(p)))}</b></div>`).join('')}
    </div>`;
}

/**
 * 試合開始の 3-2-1 に重ねて、両者を並べたカードを出す。
 *
 * @param {object} msg  match_found のフレームそのもの
 * @returns {boolean}   出したかどうか
 *
 * 3人以上（2v2・レイド・トーナメントの観客込み）では出さない。並べる相手が
 * 増えるほど1枚が小さくなり、375x667 では読めない大きさになるため
 * ── そちらは従来どおり相手パネルの担当。
 *
 * 置き場所は body 直下の position:fixed。dom.js の countdownOverlay は
 * z-index 40 の別要素なので、こちらを 39 にして数字を前に出す。カードの
 * 真ん中は数字のために空けてある（.vsc-gap）。
 */
function showVersusCard(msg) {
  clearVersusCard();
  if (!VS_CARD_MODES.has(msg && msg.mode)) return false;
  const players = Array.isArray(msg && msg.players) ? msg.players : [];
  if (players.length !== 2) return false;
  const me = players.find(p => p.isYou) || players[0];
  const foe = players.find(p => p !== me);
  if (!foe) return false;
  // 🔒 全員が持っている欄だけを出す（節の冒頭のコメント参照）。
  const extras = VS_CARD_EXTRAS.filter(x => players.every(p => {
    const v = x.value(p);
    return v != null && v !== '';
  }));
  const modeName = onlineModeName(msg.mode);

  const el = document.createElement('div');
  el.className = 'vs-card';
  el.innerHTML = `
    <div class="vsc-inner">
      ${/* 見出しは必ず「全幅の行 → その中で中央寄せの丸バッジ」の2枚重ねにする。
            バッジ自身を全幅の flex アイテムにすると、横持ち（左右に並べる指定）で
            枠だけが画面いっぱいに伸びて帯に見えてしまう。 */''}
      ${modeName ? `<div class="vsc-head"><span class="vsc-mode">${escapeHtml(modeName)}</span></div>` : ''}
      ${vsCardSideHtml(foe, extras, 'foe')}
      <div class="vsc-gap"><span class="vsc-vs">VS</span></div>
      ${vsCardSideHtml(me, extras, 'me')}
    </div>`;
  document.body.appendChild(el);

  // 3-2-1 と同じ長さで消す。countdownOverlay は「数字 n 回 × 900ms ＋ GO! 600ms」
  // なので、GO! と入れ違いに消えるよう終わりから少し手前でフェードを始める。
  const n = Math.max(1, Math.min(10, Number(msg.countdown) || 3));
  const life = n * 900;
  vsCardTimers.push(setTimeout(() => el.classList.add('out'), Math.max(300, life - 250)));
  vsCardTimers.push(setTimeout(() => el.remove(), life + 450));
  return true;
}

// ---------------------------------------------------------------------------
// 2. 攻撃の駆け引きの帯（.atk-strip）
// ---------------------------------------------------------------------------
// アタック戦だけに出る1行。ふだんは「撃った数／受けた数」を数えているだけで、
// お邪魔が飛んできた瞬間だけ**予告**に化ける。1つの帯に兼ねさせたのは高さの
// ため ── 375x667 では盤面が 210〜260px しかなく、帯を2本足すと盤面が縮む。

// 着弾までの猶予。予告は「読む時間」と「身構える時間」の両方が要るので、
// 短すぎると点滅にしか見えず、長すぎると自分の盤面とサーバーの認識がずれる。
// ⚠️ これは**表示のための遅延**であって、量を決めるのはサーバー。
//    猶予の間に試合が終わったら、そのお邪魔は落とさずに捨てる（もう関係ない）。
const GARBAGE_TELEGRAPH_MS = 700;

function atkStripEl() { return document.querySelector('.atk-strip'); }

function clearAtkStrip() {
  const el = atkStripEl();
  if (el) el.remove();
}

/**
 * 帯を相手パネルの中に生やす。#oppPanel は index.html の持ち物なので、
 * 中身を作り替えるのではなく**子を1つ足すだけ**にしてある
 *（buildPanels が触るのは #oppCards の innerHTML だけなので衝突しない）。
 */
function mountAtkStrip() {
  clearAtkStrip();
  const panel = $('#oppPanel');
  if (!panel) return null;
  const el = document.createElement('div');
  el.className = 'atk-strip';
  el.innerHTML = `
    <span class="as-out" title="${t('送ったお邪魔', 'Garbage sent')}">${ic('relic_atk', 12)} <b>0</b></span>
    <span class="as-warn" aria-live="polite"></span>
    <span class="as-in" title="${t('受けたお邪魔', 'Garbage taken')}">${ic('rubble', 12)} <b>0</b></span>`;
  panel.appendChild(el);
  return el;
}

/** 累計の書き換え（sent / taken はモード側が持っている）。 */
function updateAtkStrip(sent, taken) {
  const el = atkStripEl();
  if (!el) return;
  const o = el.querySelector('.as-out b');
  const i = el.querySelector('.as-in b');
  if (o) o.textContent = sent;
  if (i) i.textContent = taken;
  el.classList.toggle('as-lead', sent > taken);
}

/**
 * 予告を灯す。ms のあいだだけ帯が赤く光り、内側のバーが縮んで着弾を数える。
 * lines は「相手が何ラインまとめて消したか」（サーバーが載せてくれた場合のみ）。
 */
function flashIncoming(cells, lines, ms) {
  const el = atkStripEl();
  if (!el) return;
  const warn = el.querySelector('.as-warn');
  if (!warn) return;
  el.classList.add('incoming');
  // 個数からライン数は逆算できない（3ライン＋コンボ6 と 4ライン はどちらも
  // 6個）。載っていないときは量だけを言う ── 嘘は教えない。
  warn.innerHTML = `${ic('warn', 12)} <b>+${cells}</b>${lines >= 2 ? ` <small>${t(`${lines}ライン`, `${lines} lines`)}</small>` : ''}
    <i class="as-fuse" style="animation-duration:${ms}ms"></i>`;
}

/** 着弾（または試合終了）で予告を消す。 */
function clearIncoming() {
  const el = atkStripEl();
  if (!el) return;
  el.classList.remove('incoming');
  const warn = el.querySelector('.as-warn');
  if (warn) warn.innerHTML = '';
}

// ---------------------------------------------------------------------------
// 3. 決着後のリアクション
// ---------------------------------------------------------------------------
// 文字入力は置かない（暴言対策）。定型5つだけ、しかも短い時間だけ開く。
//
// ■ 既存のエモートに相乗りする
//   試合中のエモート（#btnEmote → client.send({type:'emote'})）がそのまま
//   使える…と思ったが、server/battle.js の case 'emote' は
//   `if (!match || match.ended || !me) return;` で**決着後を弾く**。
//   つまり今のサーバーでは、送っても相手には届かない（捨てられるだけで、
//   レート制限にも当たらないので害はない）。それでも送るのは、サーバーが
//   決着後の中継を開いた日に**クライアントを直さずそのまま繋がる**ため。
//   → 中継してほしい旨は forOthers に出してある。
//
// ■ 相手の返事について（正直に書いておく）
//   住人（server/battle.js の scheduleEmote）も match.ended で止まるので、
//   いまは誰からも返事が来ない。それでは「送っても無反応」で終わるので、
//   **返事が来なかったときだけ**クライアントが返す。
//   ⚠️ ここで大事なのは「相手が誰であっても同じ確率・同じ間で返る」こと。
//      クライアントは相手が住人かどうかを知らない（知ってはいけない）ので、
//      この作りは構造的に秘匿を破れない。逆に「住人にだけ返事を用意する」
//      実装にすると、その瞬間に返事の有無が正体の手がかりになる。
const POST_REACTIONS = [
  // emoji は server/battle.js の EMOJIS ホワイトリストの中から選ぶこと
  // （外れた絵文字は '👍' に丸められて、意味が変わってしまう）。
  { emoji: '👍', label: () => t('ナイス！', 'Nice!') },
  { emoji: '🔥', label: () => t('つよい…', 'Too strong…') },
  { emoji: '😭', label: () => t('惜しい！', 'So close!') },
  { emoji: '🎉', label: () => t('またやろう', 'GG, again!') },
  { emoji: '👏', label: () => t('ありがとう', 'Thanks!') },
];

// 開いている時間。長すぎると結果画面が「返事待ち」の場になってしまうので、
// ひと呼吸ぶんだけ。
const REACT_WINDOW_MS = 14000;
// 連打よけ。サーバーのレート制限（5秒に3回）より内側に置く。
const REACT_COOLDOWN_MS = 2000;

let reactState = null;   // { root, timers:[], gotReply, closed }

function clearReactionBar() {
  if (!reactState) return;
  for (const id of reactState.timers) clearTimeout(id);
  reactState = null;
  for (const el of document.querySelectorAll('.react-bar')) el.remove();
}

/** リアクション欄が開いているか（試合中のエモート表示と行き先を分けるため）。 */
function reactionBarOpen() { return !!(reactState && !reactState.closed); }

/** 吹き出しを1つ置く。who は 'me' か 'foe'。 */
function reactionBubble(who, emoji, text) {
  if (!reactState) return;
  const lane = reactState.root.querySelector(`.rx-lane.rx-${who}`);
  if (!lane) return;
  const b = document.createElement('div');
  b.className = 'rx-bubble';
  // emoji は POST_REACTIONS 由来か、サーバーのホワイトリスト由来の1文字。
  // それでも textContent で入れる（将来ここに別の経路がつながっても安全なように）。
  const span = document.createElement('span');
  span.textContent = emoji;
  b.appendChild(span);
  if (text) {
    const s = document.createElement('small');
    s.textContent = text;
    b.appendChild(s);
  }
  lane.appendChild(b);
  while (lane.children.length > 2) lane.firstChild.remove();
}

/** 相手から本当に届いたリアクション（サーバーが中継を開いた日に効く）。 */
function reactionIncoming(emoji) {
  if (!reactionBarOpen()) return false;
  reactState.gotReply = true;
  const known = POST_REACTIONS.find(r => r.emoji === emoji);
  reactionBubble('foe', emoji, known ? known.label() : '');
  audio.pickup();
  return true;
}

/**
 * 結果モーダルの中にリアクション欄を作る。
 * @param {HTMLElement} modal   showModal が返した要素
 * @param {(emoji:string)=>void} send  実際の送信（モード側が client を持っている）
 */
function mountReactionBar(modal, send) {
  clearReactionBar();
  if (!modal) return null;
  const root = document.createElement('div');
  root.className = 'react-bar';
  root.innerHTML = `
    <div class="rx-title">${t('相手にひとこと', 'Say something')}</div>
    <div class="rx-lanes"><div class="rx-lane rx-foe"></div><div class="rx-lane rx-me"></div></div>
    <div class="rx-btns"></div>`;
  const btns = root.querySelector('.rx-btns');
  for (const r of POST_REACTIONS) {
    const b = document.createElement('button');
    b.className = 'rx-btn';
    b.type = 'button';
    // 絵文字＋定型文。textContent で組むので、文言に何が入っても HTML にならない。
    const e = document.createElement('span');
    e.className = 'rx-emoji';
    e.textContent = r.emoji;
    const l = document.createElement('small');
    l.textContent = r.label();
    b.appendChild(e);
    b.appendChild(l);
    b.onclick = () => {
      if (!reactState || reactState.closed) return;
      audio.click();
      try { send(r.emoji); } catch (err) { console.warn('reaction send failed:', err && err.message); }
      reactionBubble('me', r.emoji, r.label());
      reactState.lastSent = r.emoji;
      // 連打よけ。押せない見た目にしておかないと「効いていない」と思われる。
      for (const x of btns.querySelectorAll('.rx-btn')) x.disabled = true;
      reactState.timers.push(setTimeout(() => {
        if (!reactState || reactState.closed) return;
        for (const x of btns.querySelectorAll('.rx-btn')) x.disabled = false;
      }, REACT_COOLDOWN_MS));
      scheduleReactionReply();
    };
    btns.appendChild(b);
  }
  // 報酬欄の下（＝ボタン列の手前）に差し込む。結果の数字より前に出すと、
  // いちばん見たいもの（勝敗とレート）がリアクションに押し下げられる。
  const anchor = modal.querySelector('.modal-buttons');
  if (anchor) anchor.parentNode.insertBefore(root, anchor);
  else modal.appendChild(root);

  reactState = { root, timers: [], gotReply: false, closed: false, lastSent: null };
  // 受付終了。畳むだけで、結果画面そのものはそのまま残る。
  reactState.timers.push(setTimeout(() => {
    if (!reactState) return;
    reactState.closed = true;
    root.classList.add('out');
    reactState.timers.push(setTimeout(() => { if (reactState) reactState.root.remove(); }, 400));
  }, REACT_WINDOW_MS));
  return root;
}

// 返事。**本物が来ていないときだけ**返す（節の冒頭のコメント参照）。
// 間と確率を散らすのは、毎回同じ 1.2 秒で同じ絵が返ると仕掛けが見えるから。
function scheduleReactionReply() {
  if (!reactState) return;
  const delay = 800 + Math.random() * 1600;
  const id = setTimeout(() => {
    if (!reactionBarOpen() || reactState.gotReply) return;
    if (Math.random() >= 0.8) return;   // いつも返るとかえって嘘くさい
    // 送ったものと**同じ**は返さない。オウム返しは会話に見えないうえ、
    // 「送った絵がそのまま返ってくる」＝仕掛けが一目で分かってしまう。
    const pool = POST_REACTIONS.filter(x => x.emoji !== reactState.lastSent);
    const r = pool[Math.floor(Math.random() * pool.length)];
    if (!r) return;
    reactState.gotReply = true;
    reactionBubble('foe', r.emoji, r.label());
    audio.pickup();
  }, delay);
  reactState.timers.push(id);
}

// ---------------------------------------------------------------------------
// 4. 結果画面の「大きく見せる」ぶん
// ---------------------------------------------------------------------------

/**
 * 段位が動いた／レートが動いた／連勝している、を結果の見出しの直下に置く。
 * 出典はすべて result フレーム:
 *   msg.tierChange … { up, from, to }（from/to は { min, icon, name, nameEn }）
 *   msg.ratingDelta … 符号つきの増減
 *   msg.rewards.streak … 連勝数（server/index.js の applyGameResult が返す）
 * どれも来ない試合（フレンド戦・トーナメント途中）では空文字を返す。
 */
function resultRankBlock(msg) {
  const tc = msg.tierChange;
  const delta = Number(msg.ratingDelta) || 0;
  const streak = Math.max(0, Math.floor(Number(msg.rewards && msg.rewards.streak) || 0));
  let out = '';

  if (tc && tc.to) {
    const up = !!tc.up;
    // アイコン名はサーバーが ranks.js の band.icon をそのまま送ってくる。
    const face = (tier, size) => `${tier && tier.icon ? icon(tier.icon, { size }) : ''}<span>${escapeHtml(t(tier && tier.name || '', tier && tier.nameEn || ''))}</span>`;
    out += `
      <div class="result-tier ${up ? 'up' : 'down'}">
        <div class="rt-word">${up ? t('昇格', 'PROMOTED') : t('降格', 'DEMOTED')}</div>
        <div class="rt-line">
          <span class="rt-from">${face(tc.from, 20)}</span>
          <span class="rt-arrow">${up ? '▲' : '▼'}</span>
          <span class="rt-to">${face(tc.to, 34)}</span>
        </div>
      </div>`;
  }

  if (delta) {
    out += `<div class="result-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}<small>${t('レート', 'RATING')}</small></div>`;
  }

  // 連勝は「勝った回」にしか意味がない（負けた回の streak は 0 に戻っている）。
  if (streak >= 2) {
    out += `<div class="result-streak">${ic('fire', 16)} ${t(`${streak}連勝中`, `${streak} wins in a row`)}</div>`;
  }
  return out;
}

// メニューへ戻るときに、この節が作ったものを全部畳む。
// position:fixed のカードと、#oppPanel に生やした帯は、放っておくと次の
// 画面の上に残る（結果モーダルの中のリアクション欄は closeModal で消えるが、
// タイマーは残るので必ずここも通す）。
function clearBattleUi() {
  clearVersusCard();
  clearAtkStrip();
  clearReactionBar();
  clearNetBanner();
}

// ===========================================================================
// 🔌 接続が切れているあいだの見え方（第5波・統合フェーズ）
// ===========================================================================
// サーバーは「切断＝即敗北」をやめ、猶予（server/battle.js の
// RECONNECT_GRACE_MS = 25秒）のあいだ席を残すようになった。net.js も
// そのあいだ黙って繋ぎ直す。ところが**画面側に受け口が1つも無かった**ので、
// 本人には何も起きていないように見えていた ── 盤面はローカルで回り続けるため、
//   ・置いた手がサーバーに届いていないこと
//   ・戻ってこられたのか、もう負けているのか
// のどちらも分からないまま最大15秒が過ぎる。相手側だけが battle.js の
// 「つなぎ」の announce でトーストを見ている、という片側だけの状態だった。
//
// ここで4つのフレームを受ける:
//   reconnecting  {attempt, waitMs} … net.js。自分が繋ぎ直しに行っている
//   match_resumed {elapsedMs, ...}  … battle.js。自分が試合に戻れた
//   opp_unstable  {slot, sec}       … battle.js。相手が猶予に入った
//   opp_back      {slot}            … battle.js。相手が戻ってきた
//
// ⚠ 住人の秘匿: 文言に「人間だから切れた」と読める言い方をしない
//   （battle.js 側の同じ注意書きと対）。出すのは席（slot）と残り秒だけで、
//   相手が誰なのかには一切触れない。
const NET_BANNER_ID = 'netBanner';

function netBannerEl() { return document.getElementById(NET_BANNER_ID); }

/**
 * 盤面の上端に細い帯を1本出す。トーストではなく帯なのは、状態が続いている
 * あいだ**出しっぱなしにする**必要があるため（トーストは数秒で消えるので、
 * 「まだ切れている」のか「もう戻った」のかが読めない）。
 * kind: 'warn'（切れている・待っている） / 'ok'（戻った）
 */
function showNetBanner(html, kind = 'warn') {
  const host = $('#screen-game');
  if (!host) return null;
  let el = netBannerEl();
  if (!el) {
    el = document.createElement('div');
    el.id = NET_BANNER_ID;
    el.className = 'net-banner';
    el.setAttribute('aria-live', 'polite');
    host.appendChild(el);
  }
  el.classList.toggle('ok', kind === 'ok');
  el.innerHTML = html;
  return el;
}

function clearNetBanner() {
  const el = netBannerEl();
  if (el) el.remove();
  clearTimeout(netBannerTimer);
  netBannerTimer = null;
}
let netBannerTimer = null;

/** 少しだけ出してから自分で消える帯（「戻りました」用）。 */
function flashNetBanner(html, ms = 2600) {
  showNetBanner(html, 'ok');
  clearTimeout(netBannerTimer);
  netBannerTimer = setTimeout(() => {
    netBannerTimer = null;
    const el = netBannerEl();
    // 消すのは「自分が出したものがまだ出ているとき」だけ。あいだに
    // 新しい警告（また切れた）が来ていたら、それを消してはいけない。
    if (el && el.classList.contains('ok')) el.remove();
  }, ms);
}

// ===========================================================================
// 🎓 対戦モードの初回ガイド
// ===========================================================================
// 既存の Tutorial は1人用モード専用（TUT_MODES）で、対戦のルールは一言も
// 出てこなかった。オンライン対戦・AI対戦を初めて開いた人は、
//   ・上に出ているのが相手の盤面と得点だということ
//   ・まとめて消すと相手を攻撃できること
//   ・時間内のスコア勝負で、盤面が埋まっても終わりではないこと
//   ・✕ で抜けたときに何が起きるか
// のどれも知らないまま2分を終えていた。
//
// 既存 Tutorial の作法をそのまま守る:
//   ・進行に一切割り込まない（engine.place / view.onPlace / onIntentPlace を
//     どれも奪わない）。見ているのは「モードがまだ生きているか」だけ。
//   ・どのステップにも必ず「スキップ」がある（＝詰まない）。
//   ・完了／スキップで localStorage に印を付け、二度と出さない。
//   ・吹き出しは第1波の #tutTip / .tut-top / .tut-btns / .tut-pulse を使う。
//   ・本体は pointer-events: none。押せる必要があるボタンだけ受け口に戻す。
//
// ⚠️ 攻撃の無いモード（クラシック・2v2・トーナメント・AI戦）では②を出さない。
//    出すと嘘を教えることになる（そこでは何ライン消しても相手に何も飛ばない）。
// ---------------------------------------------------------------------------

const VS_TUT_KEY = 'bba_tut_vs_done';

export function versusTutorialDone() {
  try { return localStorage.getItem(VS_TUT_KEY) === '1'; } catch { return true; }
}

function markVersusTutorialDone() {
  try { localStorage.setItem(VS_TUT_KEY, '1'); } catch { /* 保存できなくても進行は止めない */ }
}

// ガイドを出してよい対戦。「相手の盤面と得点が並び、制限時間内のスコアで
// 勝負が決まる」がそのまま通じる形のものだけを入れる。
//   raid   … 1体のボスを全員で削る協力戦。「相手の得点」も「引き分け」も噛み合わない
//   royale … #oppPanel に出るのは相手の盤面ではなく順位・生存数・KO数の帯。
//            攻撃はあるが①の説明が嘘になるので、こちらは実地レッスン
//            （attackLesson）に任せる
//   coop / land … 1つの盤面を2人で操作する別ゲーム。説明が丸ごと違う
const VS_TUT_MODES = new Set(['attack', 'duel', 'team', 'tourney']);
// このうち「2ライン以上で相手を攻撃できる」のは1v1ランクマッチだけ
// （rules.js の battle 節と同じ区別。クラシック・2v2・トーナメントは攻撃なし）。
const VS_TUT_ATTACK_MODES = new Set(['attack']);

// 対戦から呼ぶ入口。matchMode は match_found の msg.mode（AI戦は 'ai'）。
function maybeStartVersusTutorial(mode, matchMode) {
  stopTutorial();   // 前の回の吹き出しを絶対に持ち越さない
  if (versusTutorialDone()) return;
  if (!mode) return;
  const isAi = matchMode === 'ai';
  if (!isAi && !VS_TUT_MODES.has(matchMode)) return;
  const tut = new VersusTutorial(mode, {
    hasAttack: VS_TUT_ATTACK_MODES.has(matchMode),
    // ⚠️ 「途中終了は引き分け」が本当なのは AI戦だけ。
    //    オンラインの離脱は敗北（相手の不戦勝）── OnlineMode.quit() と
    //    quitWarning() がそう言っている。ここで引き分けと教えると、
    //    それを信じて抜けた人がレートを落とす。いちばん高い代償の嘘なので、
    //    出典（quit のトースト）と同じ向きの文だけを出す。
    quitIsDraw: isAi,
  });
  activeTutorial = tut;
  tut.start();
}

class VersusTutorial {
  constructor(mode, opts = {}) {
    this.mode = mode;
    this.hasAttack = !!opts.hasAttack;
    this.quitIsDraw = !!opts.quitIsDraw;
    this.steps = this.buildSteps();
    this.step = 0;
    this.tip = null;
    this.poll = null;
    this.pulsed = [];
    this.stopped = false;
  }

  // 文言は「押す前に何が起きるか分かる」ことがすべてなので、雰囲気ではなく
  // ルールそのものを書く（rules.js の方針と同じ）。
  // 攻撃の数字は attackCellsFor から出す ── 書き写すとサーバーとズレたときに
  // 誰も気づけない。
  buildSteps() {
    const steps = [
      {
        pulse: '#oppPanel',
        title: t('相手のようす', 'Watch your opponent'),
        // 2v2 では味方の盤面もここに並ぶので「相手の」と言い切らない。
        body: t('ほかのプレイヤーの盤面と得点はここに出ます。上のバーが、どちらが勝っているかの目安。',
          "The other players' boards and scores appear here. The bar above shows who is ahead."),
        hint: '',
      },
    ];
    if (this.hasAttack) {
      steps.push({
        pulse: '',
        title: t('まとめて消すと攻撃になる', 'Clear together to attack'),
        body: t('2ライン以上を同時に消すと、相手の盤面にお邪魔ブロックが飛びます。1ラインでは飛びません。',
          'Clearing 2 or more lines at once dumps garbage blocks on your opponent. A single line does nothing.'),
        hint: t(`2ライン→${attackCellsFor(2)}個 / 3ライン→${attackCellsFor(3)}個 / 4ライン→${attackCellsFor(4)}個。コンボ3回ごとに+1個。`,
          `2 lines → ${attackCellsFor(2)} blocks / 3 → ${attackCellsFor(3)} / 4 → ${attackCellsFor(4)}. Every 3 combo adds one more.`),
      });
    }
    steps.push({
      pulse: '#hudTimer',
      title: t('勝ち方', 'How you win'),
      body: t('制限時間内にスコアが高いほうが勝ちです。盤面が埋まっても終わりではなく、スコアを持ったまま盤面だけリセットされます。',
        'The higher score when time runs out wins. Filling your board does not end the run — it resets the board and keeps your score.'),
      hint: '',
    });
    steps.push(this.quitIsDraw ? {
      pulse: '#btnQuit',
      title: t('途中でやめても負けにならない', 'Leaving early is not a loss'),
      body: t('AI戦は ✕ で抜けても引き分け扱いです。気軽に試して大丈夫。',
        'In a match against the AI, quitting with ✕ counts as a draw. Feel free to experiment.'),
      hint: '',
    } : {
      pulse: '#btnQuit',
      title: t('最後まで粘ろう', 'See it through'),
      body: t('✕ で抜けると敗北扱い（相手の不戦勝）になります。盤面が埋まっても終わりではないので、時間いっぱい粘るのが得です。',
        'Quitting with ✕ counts as a loss — your opponent takes the win. Filling your board is not the end, so play out the clock.'),
      hint: '',
    });
    return steps;
  }

  // ---- 出入り口 ----------------------------------------------------------

  start() {
    if (this.stopped) return;
    // 3-2-1 のカウントダウン（と鬼／神／創造神の入場演出）は全画面を覆うので、
    // その裏に吹き出しを出しても読めない。時間で待つのではなく
    // 「操作できるようになったか」を見る ── 演出の長さが変わっても壊れない。
    this.poll = setInterval(() => this.tick(), 200);
  }

  teardown(completed) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.poll);
    this.poll = null;
    this.clearPulse();
    if (this.tip) { this.tip.remove(); this.tip = null; }
    this.unwatchResize();
    if (activeTutorial === this) activeTutorial = null;
    if (completed) markVersusTutorialDone();
  }

  skip() {
    audio.click();
    this.teardown(true);
    toast(t('チュートリアルを閉じました', 'Tutorial closed'), 'info', 1800);
  }

  finishAll() {
    audio.coin();
    this.teardown(true);
    toast(this.hasAttack
      ? t('まとめて消して殴り合おう！', 'Clear them together and fight!')
      : t('準備完了！スコアで勝とう！', 'You are ready — outscore them!'), 'ok', 2600);
  }

  // ---- ハイライト --------------------------------------------------------

  pulse(sel) {
    if (!sel) return null;
    const el = $(sel);
    // 隠れているボタンに枠だけ付けても意味がないので、見えている物だけ。
    if (!el || el.classList.contains('hidden')) return null;
    el.classList.add('tut-pulse');
    this.pulsed.push(el);
    return el;
  }

  clearPulse() {
    for (const el of this.pulsed) el.classList.remove('tut-pulse');
    this.pulsed = [];
  }

  // ---- 置き場所 ----------------------------------------------------------

  // ①で見せたい「相手の盤面と得点」（#oppPanel）と、指で触る手札を
  // どちらも隠さない場所を探す。縦持ちだと盤面の下と手札の間がふつう大きく
  // 空くので、入るならそこへ。入らなければ相手パネルのすぐ下へ。
  positionTip() {
    const tip = this.tip;
    if (!tip) return;
    tip.classList.add('tut-top');   // bottom 固定を外して top で置く
    const h = tip.offsetHeight || 170;
    const canvas = $('#gameCanvas');
    const v = view;
    if (canvas && v && v.cell) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width) {
        const boardBottom = rect.top + v.boardY + v.boardSize;
        // 手札の枠は縦に広いが、コマ自体はその中央あたりに描かれる
        // （game.js の drawTray）。横持ちは手札が盤面の右なので下は canvas の底まで空く。
        const trayTop = v.sideTray ? (rect.top + rect.height) : (rect.top + v.trayY + v.trayH * 0.38);
        if (trayTop - boardBottom >= h + 12) {
          tip.style.top = `${Math.round(boardBottom + 8)}px`;
          return;
        }
      }
    }
    const opp = $('#oppPanel');
    const r = opp && !opp.classList.contains('hidden') ? opp.getBoundingClientRect() : null;
    if (r && r.height) { tip.style.top = `${Math.round(r.bottom + 8)}px`; return; }
    const hud = document.querySelector('#screen-game .game-hud');
    const hr = hud && hud.getBoundingClientRect();
    tip.style.top = hr && hr.height ? `${Math.round(hr.bottom + 8)}px` : '';
  }

  // ---- 本文 --------------------------------------------------------------

  render() {
    const tip = this.tip;
    if (!tip) return;
    const c = this.steps[this.step];
    const last = this.step >= this.steps.length - 1;
    tip.innerHTML = [
      `<b>${escapeHtml(`${c.title}（${this.step + 1}/${this.steps.length}）`)}</b>`,
      `<p>${escapeHtml(c.body)}</p>`,
      c.hint ? `<small>${escapeHtml(c.hint)}</small>` : '',
      '<div class="tut-btns">',
      `<button class="btn btn-ghost" id="tutSkip">${t('スキップ', 'Skip')}</button>`,
      `<button class="btn btn-primary" id="tutNext">${escapeHtml(last ? t('はじめる！', 'Start playing!') : t('次へ', 'Next'))}</button>`,
      '</div>',
    ].join('');
    const btns = tip.querySelector('.tut-btns');
    if (btns) btns.style.pointerEvents = 'auto';
    const skip = tip.querySelector('#tutSkip');
    if (skip) skip.onclick = () => this.skip();
    const next = tip.querySelector('#tutNext');
    if (next) next.onclick = () => this.advance();
    this.clearPulse();
    this.pulse(c.pulse);
    // 高さが決まってから置き場所を決める（中身によって高さが変わるため）。
    this.positionTip();
    // 📱 回転・画面幅の変化でも置き直す（ソロのチュートリアルと同じ理由）。
    this.watchResize();
  }

  watchResize() {
    if (this._onResize) return;
    this._onResize = () => {
      if (this.stopped || !this.tip) return;
      requestAnimationFrame(() => { if (!this.stopped && this.tip) this.positionTip(); });
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
  }

  unwatchResize() {
    if (!this._onResize) return;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this._onResize = null;
  }

  advance() {
    audio.click();
    if (this.step >= this.steps.length - 1) { this.finishAll(); return; }
    this.step++;
    this.render();
  }

  // ---- 監視（ポーリング）------------------------------------------------

  tick() {
    const m = this.mode;
    // モードが差し替わった／終わったら、記録は立てずに静かに畳む。
    // （何も読めていないのに「見た」ことにしない）
    if (!m || m.ended || currentMode !== m) { this.teardown(false); return; }
    if (this.tip) return;
    // まだ 3-2-1 の最中／入場演出の最中。操作できるようになるまで待つ。
    if (!view || view.inputLocked) return;
    if (document.querySelector('.countdown-overlay')) return;
    const tip = document.createElement('div');
    tip.id = 'tutTip';
    // 本体は入力を吸わない ── 読みながら置こうとしたタップを奪わないため。
    // 押せる必要があるのは .tut-btns だけなので、そこだけ render() で戻す。
    tip.style.pointerEvents = 'none';
    document.body.appendChild(tip);
    this.tip = tip;
    this.render();
  }
}

// ---------------------------------------------------------------------------
// game.js の applyResult() は「ラインが消える＝ごほうび」を前提に音を鳴らす
// （冒頭の置いた音、消えたときの上昇音とコンボ音）。その前提が成り立たない
// 呼び出しが2つある:
//   ⛓️ 連鎖の各波 … ピースを1つも置いていない合成 result なのに置いた音が鳴る
//   🏗️ 崩壊      … 揃えてはいけないモードなので、消去のごほうび音は真逆の合図
// game.js に分岐を増やさず、この1回の呼び出しの間だけ鳴らしたくない音を黙らせる。
// applyResult は同期なので、finally で必ず元に戻る。
function applyResultMuted(v, result, keys) {
  const saved = keys.map(k => [k, Object.prototype.hasOwnProperty.call(audio, k) ? audio[k] : null]);
  for (const k of keys) audio[k] = () => {};
  try {
    v.applyResult(result);
  } finally {
    for (const [k, own] of saved) {
      if (own) audio[k] = own; else delete audio[k];   // 元はプロトタイプ側のメソッド
    }
  }
}

// ===========================================================================
// ⛓️ I3 連鎖カスケード
// ===========================================================================
// 盤面に「重力」がある専用モード。1手ごとに残ったブロックが下へ落ち、
// 落下で行が揃えばそれも自動で消え、また落ちる ── これを繰り返すのが「連鎖」。
//
// エンジンには何も足していない。compactDown() を guard 付きのループで回し、
// 消去だけをこのモード専用の resolveOneLine()（1波1ライン）に差し替える。
// 差し替えるのは ChainMode が持つ engine インスタンスのプロパティだけなので、
// engine.js も他モードも1ミリも変わらない。
//
// なぜ1波1ラインなのか（ここがこのモードの心臓部）:
//   engine の resolveLines() は揃った線をまとめて全部消す。全下詰めのあとの
//   盤面には穴が無いので、満杯の行は必ず「下から min(列の高さ) 段」ちょうど。
//   それを全部まとめて消すと、いちばん浅い列が空になって新しい満杯行は
//   原理的に作れず、連鎖は必ず2で止まっていた（×4以上が到達不能な死に倍率）。
//   1本ずつ消すと「下の1本が消える→全部が1段落ちる→次の1本がまた揃う」が
//   続き、n段ぶん積んで揃えた手は n連鎖になる。縦5ラインを1列だけ空けた
//   壁に落とせば5連鎖(×16)まで届く（検証済み）。
//
// 倍率: 1連鎖 ×1 / 2連鎖 ×2 / 3連鎖 ×4 …（2のべき乗、×64 で頭打ち）。
// 「置いた瞬間の消去」を1連鎖目と数えるので、置いた手が何も消さずに
// 落下してはじめて揃った回は 1連鎖（×1）── 落ちただけで倍率は付かない。
// ---------------------------------------------------------------------------

const CHAIN_GUARD = 16;                 // 無限ループよけ（1波1ラインなので最大16本）
const CHAIN_STEP_MS = 420;              // 1連鎖ぶんの見せ時間
const CHAIN_COLORS = ['#ffffff', '#ffe14d', '#ffa93d', '#ff6bd4', '#43d9e8', '#9be3ff'];

// 揃った線を1本だけ消す（⛓️専用）。engine.resolveLines() と同じ形を返すので、
// engine.place() の中の消去もそのままこれを通せる。
// 選ぶ順は「いちばん下の満杯行 → いちばん左の満杯列」。下から消すと、
// 上に載っているものが必ず落ちるので雪崩が続く。
// ❄️氷結(ICE) は⛓️では盤に置かれないため、凍結の欄は常に空で返す。
function resolveOneLine(grid) {
  const none = { frozenRows: [], frozenCols: [], frozenCount: 0, crackedCells: [] };
  for (let r = 7; r >= 0; r--) {
    let full = true;
    for (let c = 0; c < 8; c++) if (!grid[r * 8 + c]) { full = false; break; }
    if (!full) continue;
    const clearedCells = [];
    for (let c = 0; c < 8; c++) {
      const k = r * 8 + c;
      clearedCells.push([r, c, grid[k]]);
      grid[k] = 0;
    }
    return { fullRows: [r], fullCols: [], clearedCells, lineCount: 1, ...none };
  }
  for (let c = 0; c < 8; c++) {
    let full = true;
    for (let r = 0; r < 8; r++) if (!grid[r * 8 + c]) { full = false; break; }
    if (!full) continue;
    const clearedCells = [];
    for (let r = 0; r < 8; r++) {
      const k = r * 8 + c;
      clearedCells.push([r, c, grid[k]]);
      grid[k] = 0;
    }
    return { fullRows: [], fullCols: [c], clearedCells, lineCount: 1, ...none };
  }
  return { fullRows: [], fullCols: [], clearedCells: [], lineCount: 0, ...none };
}

// 連鎖専用の音。audio.combo() は streak 10 で音程が頭打ちになるので、
// 連鎖の階段には使えない（見た目だけ盛り上がって音がついてこない）。
// 既存の audio.tone() だけで組む ── audio.js には何も足していない。
function chainHit(chainNo) {
  const f = 392 * Math.pow(1.09, Math.min(chainNo, 12));
  const dur = Math.max(0.07, 0.17 - chainNo * 0.008);
  audio.tone({ freq: f, dur, type: 'triangle', vol: 0.2 });
  audio.tone({ freq: f * 1.5, dur: dur * 0.8, type: 'sine', vol: 0.11, delay: 0.05 });
}

function chainMult(chainNo) {
  if (chainNo <= 1) return 1;
  return Math.min(64, Math.pow(2, chainNo - 1));
}

function chainColor(chainNo) {
  return CHAIN_COLORS[Math.min(CHAIN_COLORS.length - 1, Math.max(0, chainNo - 1))];
}

class ChainMode {
  constructor() {
    this.mode = 'chain';
    this.usesIntent = true;
    // 重力で盤面が丸ごと動くモードなので、盤面を直接書き換えるアイテムや
    // 奥義とは相性が悪い（浮いたブロックが残る）。純粋な連鎖勝負にする。
    this.noItems = true;
    this.timers = [];
  }

  after(ms, fn) { const id = setTimeout(fn, ms); this.timers.push(id); return id; }
  clearTimers() { for (const id of this.timers) clearTimeout(id); this.timers = []; }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.add('hidden');
    showItemBar(false);
    this.startedAt = Date.now();
    this.ended = false;
    this.cascading = false;
    this.guard = 0;
    this.chainNo = 0;
    this.maxChain = 0;
    this.chainScore = 0;
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_ocean' });
    this.engine = new Engine();
    // ⛓️ だけの規則: 揃った線は1本ずつ消える（このインスタンスのみ差し替え）。
    // engine.place() の中の消去もここを通るので、置いた瞬間に何本揃っていても
    // 消えるのは1本 ── 残りは落下のあとに次の波として消え、連鎖になる。
    this.engine.resolveLines = () => resolveOneLine(this.engine.grid);
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish();
    this.updateHud();
    updateRerollHud(this.engine);
    updateAutoBtn();
    v.start();
    audio.playTrack('battle');
    toast(t('ブロックは必ず下へ落ちる！ 揃った列は1本ずつ消えるので、まとめて揃えるほど連鎖が伸びる！',
      'Everything falls! Full lines clear one at a time — set up several at once and the chain keeps going!'), 'announce', 3600);
  }

  best() {
    // localStorage だけを見ていると、別端末や localStorage を消したあとに
    // BEST 0 から始まって「実際には更新していないのに NEW RECORD!」が出る。
    // main.js の開始画面（modeStatBest('chainBest')）と同じ統合をここでもする。
    const local = Number(localStorage.getItem('bba_chain_best') || 0);
    return session.user ? Math.max(local, session.user.stats.chainBest || 0) : local;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    $('#hudSub').textContent = t(
      `最大${this.maxChain}連鎖 ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`,
      `Best chain ${this.maxChain} ・ BEST ${fmt(Math.max(this.best(), this.engine.score))}`);
    const tm = $('#hudTimer');
    tm.innerHTML = ic('mode_chain', 15) + ' ' + (this.cascading && this.chainNo >= 1 ? this.chainNo : this.maxChain);
    tm.classList.toggle('urgent', this.cascading && this.chainNo >= 3);
  }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    // 連鎖の演出中は次の手を受けない（受けると落下途中の盤面に置ける）。
    if (!piece || this.ended || this.cascading || !e.canPlace(piece, row, col)) return true;
    const result = e.place(index, row, col);
    if (!result) return true;
    const v = getView();
    // 落下はこのあと回すので、この時点の「詰み」判定は当てにならない。
    // 連鎖が終わってから hasAnyMove() で判定し直す。
    result.over = false;
    e.over = false;
    v.applyResult(result);
    // 置いた手そのものの消去が1連鎖目。何も消えなかったなら 0 から数え直す
    // （落ちて初めて揃った回に倍率を付けないため）。
    this.chainNo = result.lineCount > 0 ? 1 : 0;
    this.guard = 0;
    this.cascading = true;
    v.inputLocked = true;
    this.updateHud();
    this.cascadeStep();
    return true;
  }

  // 連鎖1波ぶん（compactDown → resolveLines（1本だけ） → guard）。
  cascadeStep() {
    if (this.ended) return;
    const e = this.engine;
    const v = getView();
    if (this.guard++ >= CHAIN_GUARD) { this.endCascade(); return; }
    const before = e.grid.slice();
    if (e.compactDown() > 0) {
      // 落下でマスが動くと spawnAnim の key と実セルがズレる。捨てて張り直す。
      v.spawnAnim.clear();
      for (let k = 0; k < 64; k++) {
        if (e.grid[k] && !before[k]) v.spawnAnim.set(k, v.time);
      }
    }
    // 1マスも動かなくても、まだ揃ったままの線が残っていることがある
    // （列を丸ごと消した回など）。落下の有無ではなく「消す線がもう無い」で畳む。
    const r = e.resolveLines();
    if (r.lineCount === 0) { this.endCascade(); return; }
    this.chainNo++;
    const mult = chainMult(this.chainNo);
    const gained = Math.round((r.lineCount * r.lineCount * 100 + r.clearedCells.length) * mult);
    e.score += gained;
    e.linesCleared += r.lineCount;
    e.streak++;
    if (e.streak > e.maxCombo) e.maxCombo = e.streak;
    this.chainScore += gained;
    this.maxChain = Math.max(this.maxChain, this.chainNo);
    // 演出は既存の applyResult に丸ごと任せる（消去パーティクル・ライン点滅・
    // 効果音まで同じ経路になる）。合成 result なので frozenCount は付けない。
    // ただし置いた音だけは黙らせる ── この波でピースは1つも置いていない。
    applyResultMuted(v, {
      placedCells: [],
      color: 0,
      fullRows: r.fullRows, fullCols: r.fullCols,
      clearedCells: r.clearedCells, lineCount: r.lineCount,
      gained, streak: e.streak,
      // 連鎖で盤面が空になったら、それは正真正銘の全消し（昇華）。
      perfect: e.grid.every(x => x === 0),
      over: false,
    }, ['place']);
    if (this.chainNo >= 2) {
      const cx = v.boardX + v.boardSize / 2;
      const cy = v.boardY + v.boardSize * 0.22;
      v.addFloatText(cx, cy, t(`${this.chainNo}連鎖！ ×${mult}`, `${this.chainNo} CHAIN! ×${mult}`),
        chainColor(this.chainNo), 1.6 + Math.min(1, this.chainNo * 0.12));
      v.screenFlash = Math.max(v.screenFlash || 0, Math.min(0.5, 0.12 + this.chainNo * 0.06));
      chainHit(this.chainNo);   // 連鎖が伸びるほど高く・短く畳みかける
    }
    this.updateHud();
    // 連鎖が伸びるほど少しずつ詰めて畳みかける（1波1ラインなので波数が増えた ──
    // 等速のままだと長い連鎖で操作できない時間が伸びすぎる）。
    this.after(Math.max(220, CHAIN_STEP_MS - this.chainNo * 30), () => this.cascadeStep());
  }

  endCascade() {
    if (this.ended) return;
    const e = this.engine;
    const v = getView();
    this.cascading = false;
    if (this.chainNo >= 3) {
      confettiBurst(20 + this.chainNo * 8);
      toast(t(`${this.chainNo}連鎖！ ×${chainMult(this.chainNo)}`,
        `${this.chainNo}-chain! ×${chainMult(this.chainNo)}`), 'announce', 2000);
    }
    this.chainNo = 0;
    // 落下で空きが増えることがあるので、判定はここで1回だけ。
    if (!e.hasAnyMove()) {
      e.over = true;
      v.inputLocked = true;
      this.updateHud();
      this.finish();
      return;
    }
    e.over = false;
    v.inputLocked = false;
    this.updateHud();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    getView().inputLocked = true;
    const e = this.engine;
    // 判定はサーバー統合済みのベスト、控えの書き込みは localStorage 単体と比べる
    // （サーバーの方が高いときに端末の控えが更新されないままになるのを防ぐ）。
    const prevBest = this.best();
    const localBest = Number(localStorage.getItem('bba_chain_best') || 0);
    const isBest = e.score > 0 && e.score >= prevBest;
    // main.js の開始画面が読む2つの控え（bba_chain_best / bba_chain_max）。
    try {
      if (e.score > localBest) localStorage.setItem('bba_chain_best', String(e.score));
      if (this.maxChain > Number(localStorage.getItem('bba_chain_max') || 0)) {
        localStorage.setItem('bba_chain_max', String(this.maxChain));
      }
    } catch { /* 保存できなくても結果表示は続ける */ }
    const rewards = await submitResult({
      mode: 'chain', score: e.score, lines: e.linesCleared, maxChain: this.maxChain,
      maxCombo: e.maxCombo, duration: (Date.now() - this.startedAt) / 1000, won: false,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    if (isBest) confettiBurst();
    const m = showModal(`
      <div class="result-banner ${isBest ? 'win' : 'draw'}">${isBest ? 'NEW RECORD!' : 'GAME OVER'}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${ic('mode_chain')} ${t('最大連鎖', 'Longest chain')}</span><b>${this.maxChain}</b></div>
        <div class="rs-row"><span>${t('連鎖で稼いだ点', 'Points from chains')}</span><b>${fmt(this.chainScore)}</b></div>
        <div class="rs-row"><span>${t('消したライン', 'Lines cleared')}</span><b>${fmt(e.linesCleared)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Play again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.destroy(); startChain(); };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish();
  }

  destroy() {
    this.ended = true;
    this.clearTimers();
    $('#hudTimer').classList.add('hidden');
    $('#hudTimer').classList.remove('urgent');
    if (view) { view.onIntentPlace = null; view.inputLocked = false; }
  }
}

export function startChain() {
  if (currentMode) currentMode.destroy();
  currentMode = new ChainMode();
  window.__bbaMode = currentMode;
  currentMode.start();
  // 🎓 初回ガイド（I17）。ソロ以外を最初に押した人にも同じ説明が届くように、
  // ふつうの盤面の1人用モードからも呼ぶ（すでに見た人には中で何もしない）。
  maybeStartTutorial(currentMode);
}

// main.js 側がどちらの名前で繋いでも動くように別名も出しておく。
export { startChain as startChainMode };

// main.js のメニューは import ではなく window から名前を引く（callModeEntry）。
// 候補の先頭から順に探すので、実際に呼ばれるのは startChainMode。
window.startChainMode = () => startChain();
window.startChain = () => startChain();

// ===========================================================================
// 🏗️ I2 ブループリント（日替わりの「組み立て」パズル）
// ===========================================================================
// 配られたピースを設計図どおりに置いて、その日の作品を完成させる。
// 遺跡（PuzzleMode）と同じ「固定キュー」の骨格だが、勝利条件が真逆:
//   ・遺跡  = 光るマスを *消す*
//   ・設計図 = 光るマスを *埋める*。ラインが揃うと作品が崩れる（＝揃えてはいけない）
// 設計図には満杯の行・列が無いことがサーバー側で保証されているので、
// 設計図どおりに置いている限りラインは絶対に揃わない。
// ---------------------------------------------------------------------------

// JST の日付キー。server/adminevent.js の jstDayKey() と同じ形。
function jstDayKeyClient(ts = Date.now()) {
  const d = new Date(ts + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// server/daily.js の blueprintSeed() と同じ文字列ハッシュ（照合用・フォールバック用）。
function blueprintSeedClient(dayKey) {
  let h = 0;
  const s = `bba-blueprint-${dayKey}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0) & 0x7fffffff;
}

// マス集合に満杯の行・列があるか（server/daily.js の blueprintHasFullLine と同義）。
function blueprintHasFullLine(cells) {
  const rows = new Array(8).fill(0);
  const cols = new Array(8).fill(0);
  for (const k of cells) { rows[(k / 8) | 0]++; cols[k % 8]++; }
  return rows.some(n => n >= 8) || cols.some(n => n >= 8);
}

// サーバーの戻り値を、このモードが使う形にそろえる。
// 形が違う／壊れているものは null にして、呼び出し側が次の手段へ進めるようにする。
function normalizeBlueprint(raw) {
  const bp = raw && raw.blueprint ? raw.blueprint : raw;
  if (!bp || !Array.isArray(bp.cells) || !Array.isArray(bp.pieces)) return null;
  const cells = bp.cells.map(n => n | 0).filter(n => n >= 0 && n < 64);
  if (!cells.length || !bp.pieces.length) return null;
  const pieces = [];
  for (const p of bp.pieces) {
    const si = (p && p.shape) | 0;
    if (!SHAPES[si]) return null;   // 知らない形が混じっていたら信用しない
    pieces.push({ shape: si, color: SHAPES[si].color, cells: SHAPES[si].cells });
  }
  return {
    dayKey: String(bp.dayKey || jstDayKeyClient()),
    id: String(bp.id || 'figure'),
    // icon（サーバーが送る絵文字）は取り込まない ── 画面には出さないので
    // 控えておくと「使われない2つ目の絵」になる。設計図の絵は
    // icons.js の mode_blueprint が受け持つ。
    name: String(bp.name || '設計図'),
    nameEn: String(bp.nameEn || bp.name || 'Blueprint'),
    cells,
    pieces,
    local: false,
  };
}

// 配信口がまだ無いときの控え。ピースをランダムに（重ならないように）並べ、
// その和集合をその日の設計図にする ── 絵柄にはならないが、
//   ・必ず組める（ピースの配置がそのまま模範解答）
//   ・満杯の行・列を持たない
// というルールは満たすので、モードとしては完全に成立する。
// 本番の絵柄（ハート・剣・王冠…）は server/daily.js の blueprintFor() が持っている。
function localBlueprint(dayKey) {
  const seed = blueprintSeedClient(dayKey);
  for (let attempt = 0; attempt < 24; attempt++) {
    const rng = new Rng(((seed ^ (attempt * 0x9e3779b9)) >>> 0) || 1);
    const grid = new Array(64).fill(false);
    const pieces = [];
    const want = 6 + rng.int(3);   // 6〜8個
    let guard = 400;
    while (pieces.length < want && guard-- > 0) {
      const si = rng.int(SHAPES.length);
      const cells = SHAPES[si].cells;
      const { rows, cols } = shapeSize(cells);
      const r0 = rng.int(Math.max(1, 8 - rows + 1));
      const c0 = rng.int(Math.max(1, 8 - cols + 1));
      let ok = true;
      for (const [dr, dc] of cells) {
        const r = r0 + dr, c = c0 + dc;
        if (r >= 8 || c >= 8 || grid[r * 8 + c]) { ok = false; break; }
      }
      if (!ok) continue;
      for (const [dr, dc] of cells) grid[(r0 + dr) * 8 + (c0 + dc)] = true;
      pieces.push({ shape: si, color: SHAPES[si].color, cells });
    }
    if (pieces.length < 4) continue;
    const list = [];
    for (let k = 0; k < 64; k++) if (grid[k]) list.push(k);
    if (blueprintHasFullLine(list)) continue;   // 揃ってはいけないので作り直し
    for (let i = pieces.length - 1; i > 0; i--) {   // 決定的にシャッフル
      const j = rng.int(i + 1);
      const tmp = pieces[i]; pieces[i] = pieces[j]; pieces[j] = tmp;
    }
    return {
      // icon は持たない（HUD の絵は mode_blueprint 一本にそろえた）。
      dayKey, id: 'local',
      name: '今日の設計図', nameEn: "Today's Blueprint",
      cells: list, pieces, local: true,
    };
  }
  return null;
}

// 設計図を手に入れる。専用の配信口 → 今日のお題に相乗り → ローカル生成 の順。
// ※ server/index.js に `GET /api/daily/blueprint` が入れば ① で本番の絵柄になる。
export async function fetchBlueprint() {
  try {
    const bp = normalizeBlueprint(await api('/api/daily/blueprint'));
    if (bp) return bp;
  } catch { /* 未実装なら次へ */ }
  try {
    const day = await api('/api/daily');
    const bp = normalizeBlueprint(day && day.blueprint);
    if (bp) return bp;
    if (day && day.day) return localBlueprint(String(day.day));
  } catch { /* オフラインでも遊べるように次へ */ }
  return localBlueprint(jstDayKeyClient());
}

// ---------------------------------------------------------------------------
// 盤面に重ねる薄色のガイド
//
// game.js の view.glowCells は「値の入っているマス」しか光らせないので、
// これから埋める *空きマス* を示すのには使えない。CSS も担当外なので、
// canvas の実寸（view.boardX / boardY / cell）に合わせた position:fixed の
// 小さな div を並べて重ねる。pointer-events:none なのでドラッグは素通りする。
// ---------------------------------------------------------------------------

// 🚩 陣取りの陣営色は style.css の --land-p1 / --land-p2 が正 ──
// 帯・数字と盤面のオーバーレイがバラバラの色にならないよう、ここから読む。
// テーマ切替でトークンが変わることもあるので、値は set() のたびに取り直す。
const LAND_FALLBACK_ME = '#5b8bff';
const LAND_FALLBACK_FOE = '#ff6bd4';
let landTone = { me: LAND_FALLBACK_ME, foe: LAND_FALLBACK_FOE };

function readCssColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : fallback;
  } catch { return fallback; }
}

function hexRgba(hex, a) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function refreshLandTone() {
  landTone = {
    me: readCssColor('--land-p1', LAND_FALLBACK_ME),
    foe: readCssColor('--land-p2', LAND_FALLBACK_FOE),
  };
}

class CellOverlay {
  constructor() {
    const root = document.createElement('div');
    root.id = 'bpOverlay';
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:6';
    document.body.appendChild(root);
    this.root = root;
    this.marks = new Map();     // cellIndex -> 'want' | 'stray'
    this.nodes = new Map();     // cellIndex -> HTMLElement
    this.int = setInterval(() => this.sync(), 200);
  }

  // 🚩 領土は色だけで分けない ── 自分＝実線＋●／相手＝破線＋✕ と
  // 形でも違えて、色の見分けがつきにくい人にも持ち主が読めるようにする。
  static mark(kind) {
    if (kind === 'own_me') return '●';
    if (kind === 'own_foe') return '✕';
    return '';
  }

  static style(kind) {
    // 🏗️ 設計図: これから埋めるマス／はみ出したマス
    if (kind === 'stray') return 'background:rgba(255,59,59,0.20);border:1px solid rgba(255,107,107,0.75);';
    // 🚩 陣取り: 自分の領土／相手の領土。ブロックの上に薄く重ねる。
    if (kind === 'own_me') {
      return `background:${hexRgba(landTone.me, 0.34)};border:2px solid ${hexRgba(landTone.me, 0.95)};`
        + 'color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.85);';
    }
    if (kind === 'own_foe') {
      return `background:${hexRgba(landTone.foe, 0.30)};border:2px dashed ${hexRgba(landTone.foe, 0.95)};`
        + 'color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.85);';
    }
    return 'background:rgba(155,227,255,0.15);border:1px dashed rgba(155,227,255,0.6);';
  }

  set(marks) {
    refreshLandTone();
    this.marks = marks;
    for (const [k, el] of this.nodes) {
      if (!marks.has(k)) { el.remove(); this.nodes.delete(k); }
    }
    this.sync();
  }

  sync() {
    const v = view;
    const canvas = $('#gameCanvas');
    if (!v || !canvas || !v.cell) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const s = Math.max(1, v.cell - 2);
    for (const [k, kind] of this.marks) {
      let el = this.nodes.get(k);
      if (!el) {
        el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.borderRadius = '4px';
        this.root.appendChild(el);
        this.nodes.set(k, el);
      }
      const r = (k / 8) | 0, c = k % 8;
      const x = Math.round(rect.left + v.boardX + c * v.cell + 1);
      const y = Math.round(rect.top + v.boardY + r * v.cell + 1);
      const w = Math.round(s);
      const glyph = CellOverlay.mark(kind);
      const glyphCss = glyph
        ? `display:flex;align-items:center;justify-content:center;line-height:1;font-weight:900;font-size:${Math.max(8, Math.round(w * 0.5))}px;`
        : '';
      const next = `position:absolute;border-radius:4px;box-sizing:border-box;left:${x}px;top:${y}px;width:${w}px;height:${w}px;${glyphCss}${CellOverlay.style(kind)}`;
      // 200ms ごとに回るので、変わっていないときは触らない（再レイアウトを避ける）。
      if (el.dataset.css !== next) { el.setAttribute('style', next); el.dataset.css = next; }
      if (el.dataset.glyph !== glyph) { el.textContent = glyph; el.dataset.glyph = glyph; }
    }
  }

  destroy() {
    clearInterval(this.int);
    this.int = null;
    if (this.root) { this.root.remove(); this.root = null; }
    this.nodes.clear();
  }
}

// 🏗️ の記録（その日の★）。
function blueprintRecord() {
  try { return JSON.parse(localStorage.getItem('bba_blueprint_record') || '{}') || {}; } catch { return {}; }
}

class BlueprintMode {
  constructor(bp) {
    this.mode = 'blueprint';
    this.usesIntent = true;
    this.noItems = true;   // 固定キューの詰将棋 — アイテム／奥義は盤面契約を壊す
    this.bp = bp;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.add('hidden');
    showItemBar(false);
    $('#btnReroll').classList.add('hidden');   // 引き直しは設計図を壊す
    this.startedAt = Date.now();
    this.ended = false;
    this.crumbles = 0;
    this.doomed = false;   // 「残りのピースではもう埋まらない」と分かった回
    this.strayCells = new Set();
    this.want = new Set(this.bp.cells);
    this.queue = this.bp.pieces.slice();
    this.total = this.queue.length;
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_default' });
    this.engine = new Engine();
    this.engine.rerolls = 0;
    this.engine.refillHand = () => {};        // キューだけが供給源
    this.engine.reroll = () => false;
    this.engine.hand = [this.queue.shift() || null, this.queue.shift() || null, this.queue.shift() || null];
    v.setEngine(this.engine);
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish(false);
    this.overlay = new CellOverlay();
    this.paint();
    this.updateHud();
    updateAutoBtn();
    v.start();
    audio.playTrack('ruins');
    toast(t(`「${this.bp.name}」を組み立てよう！ 光る形どおりに置く ── 列を揃えると崩れるぞ！`,
      `Build "${this.bp.nameEn}"! Fill the glowing shape — completing a line makes it crumble!`), 'announce', 4000);
  }

  remaining() { return this.queue.length + this.engine.hand.filter(Boolean).length; }

  // まだ埋まっていない設計図のマス。
  missing() {
    const e = this.engine;
    let n = 0;
    for (const k of this.want) if (!e.grid[k]) n++;
    return n;
  }

  // 手札＋キューに残っているマス数。missing() を下回ったら完成は不可能。
  cellsLeft() {
    let n = 0;
    for (const p of this.queue) n += p.cells.length;
    for (const p of this.engine.hand) if (p) n += p.cells.length;
    return n;
  }

  paint() {
    if (!this.overlay) return;
    const e = this.engine;
    const marks = new Map();
    for (const k of [...this.strayCells]) if (!e.grid[k]) this.strayCells.delete(k);
    for (const k of this.want) if (!e.grid[k]) marks.set(k, 'want');
    for (const k of this.strayCells) if (e.grid[k]) marks.set(k, 'stray');
    this.overlay.set(marks);
  }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    const placed = [];
    for (const [dr, dc] of piece.cells) placed.push((row + dr) * 8 + (col + dc));
    const result = e.place(index, row, col);
    if (!result) return true;
    e.hand[index] = this.queue.shift() || null;   // 固定キュー、ランダム補充なし
    // place() は補充前の手札で「詰み」を判定している。補充後に判定し直す。
    e.over = false;
    result.over = false;
    const v = getView();
    // 揃えてはいけないモードなので、揃ってしまった回に「消せた！」の音を
    // 鳴らすと耳だけを頼りにしている人へ真逆の合図になる（直後に鳴る
    // bossAttack が本当の合図）。絵は残したまま、その2音だけ黙らせる。
    if (result.lineCount > 0) applyResultMuted(v, result, ['clearLines', 'combo']);
    else v.applyResult(result);
    // 設計図の外へ出たマス。ここが1つでもあると完成形にはならないので、
    // 赤く出して「いま何が起きたか」をその場で見せる。
    let stray = 0;
    for (const k of placed) if (!this.want.has(k)) { this.strayCells.add(k); stray++; }
    if (stray) {
      audio.error();
      toast(t(`設計図の外に${stray}マスはみ出した`, `${stray} square(s) outside the blueprint`), 'err', 1600);
    }
    // ラインが揃った ＝ 作品が崩れた。設計図には満杯の行・列が無いので、
    // これは必ず「設計図の外に置いた」結果として起きる。
    if (result.lineCount > 0) {
      this.crumbles++;
      const penalty = 300 * result.lineCount;
      e.score = Math.max(0, e.score - penalty);
      v.screenFlash = Math.max(v.screenFlash || 0, 0.5);
      v.shake = Math.max(v.shake || 0, 18);
      audio.bossAttack();
      toast(t(`作品が崩れた！ −${fmt(penalty)}点（列を揃えてはいけない）`,
        `The build crumbled! −${fmt(penalty)} (never complete a line)`), 'err', 2600);
      // 消えたマスは設計図の控えからも外れる ── 埋め直せるように印を戻す。
      for (const [r, c] of result.clearedCells) this.strayCells.delete(r * 8 + c);
    }
    this.paint();
    this.updateHud();
    if (this.ended) return true;
    if (this.missing() === 0 && this.strayCells.size === 0) { this.finish(true); return true; }
    // もう埋めきれない／置く場所が無い ＝ そこで終わり。
    if (this.missing() > this.cellsLeft() || this.remaining() === 0 || !e.hasAnyMove()) {
      this.finish(false);
      return true;
    }
    // マス数の足し算ではまだ足りていても、形の都合でもう組めないことがある。
    // 黙ったまま2〜3手進ませないよう、分かった瞬間に伝える。
    // はみ出しの音が既に鳴った手では重ねない（同じ1手で2回エラー音は騒がしい）。
    this.checkDoomed(stray > 0);
    return true;
  }

  // 残りのピース（手札＋キュー）で、まだ空いている設計図のマスを
  // ちょうど埋めきれるか。true=埋められる / false=もう無理 / null=打ち切り（判断しない）。
  // 置き場所が重ならない解なら、キューの順どおりに置いても必ず成立するので、
  // 「どの順で来るか」は考えなくてよい（＝形の敷き詰め問題そのもの）。
  canStillFill() {
    const e = this.engine;
    const need = [];
    for (const k of this.want) if (!e.grid[k]) need.push(k);
    if (!need.length) return true;
    const shapes = [];
    for (const p of e.hand) if (p) shapes.push(p.cells);
    for (const p of this.queue) shapes.push(p.cells);
    let stock = 0;
    for (const cells of shapes) stock += cells.length;
    if (stock < need.length) return false;
    // 同じ形はまとめる（探索が指数で膨らむのを防ぐ）。
    const kinds = new Map();
    for (const cells of shapes) {
      const key = cells.map(([r, c]) => `${r},${c}`).join(' ');
      const cur = kinds.get(key);
      if (cur) cur.n++; else kinds.set(key, { cells, n: 1 });
    }
    const list = [...kinds.values()];
    const open = new Set(need);
    let budget = 40000;   // 最悪でも一瞬で戻す。使い切ったら「分からない」を返す。
    const solve = (left) => {
      if (left === 0) return true;
      if (budget-- <= 0) return null;
      // いちばん若い番号の空きマスは必ずどれかのピースが覆う ── そこだけ試す。
      let anchor = -1;
      for (const k of open) if (anchor < 0 || k < anchor) anchor = k;
      const ar = (anchor / 8) | 0, ac = anchor % 8;
      let cut = false;
      for (const kind of list) {
        if (kind.n === 0) continue;
        for (const [dr, dc] of kind.cells) {
          const r0 = ar - dr, c0 = ac - dc;
          const put = [];
          let ok = true;
          for (const [er, ec] of kind.cells) {
            const rr = r0 + er, cc = c0 + ec;
            if (rr < 0 || cc < 0 || rr > 7 || cc > 7) { ok = false; break; }
            const kk = rr * 8 + cc;
            if (!open.has(kk)) { ok = false; break; }
            put.push(kk);
          }
          if (!ok) continue;
          for (const kk of put) open.delete(kk);
          kind.n--;
          const res = solve(left - put.length);
          kind.n++;
          for (const kk of put) open.add(kk);
          if (res === true) return true;
          if (res === null) cut = true;
        }
      }
      return cut ? null : false;
    };
    return solve(need.length);
  }

  checkDoomed(quiet) {
    if (this.doomed || this.ended) return;
    if (this.canStillFill() !== false) return;
    this.doomed = true;
    if (!quiet) audio.error();
    this.updateHud();
    toast(t('残りのピースでは、この設計図はもう埋めきれません ── やり直すと同じ図柄・同じ順で挑戦できます',
      'The remaining pieces can no longer fill this blueprint — a retry gives you the same shape and the same order'),
    'err', 4200);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    bumpScore(el);
    const name = t(this.bp.name, this.bp.nameEn);
    $('#hudSub').innerHTML = ic('mode_blueprint', 13) + ' ' + escapeHtml(t(`${name} ・ 残り${this.missing()}マス${this.crumbles ? ` ・ 崩壊${this.crumbles}` : ''}`,
      `${name} — ${this.missing()} left${this.crumbles ? ` ・ ${this.crumbles} crumble(s)` : ''}`));
    const tm = $('#hudTimer');
    tm.innerHTML = `${ic('mode_blueprint', 15)} ${this.remaining()}`;
    tm.classList.toggle('urgent', this.doomed || this.missing() > this.cellsLeft());
  }

  stars(secs) {
    if (this.crumbles === 0 && this.strayCells.size === 0 && secs <= 90) return 3;
    if (this.crumbles <= 1 && secs <= 210) return 2;
    return 1;
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const secs = (Date.now() - this.startedAt) / 1000;
    const stars = won ? this.stars(secs) : 0;
    if (won) {
      // 完成ボーナス: マス数 × 40 ＋ ★ボーナス。
      e.score += this.want.size * 40 + stars * 500;
      confettiBurst(stars >= 3 ? 70 : 40);
      audio.victory();
      try {
        const rec = blueprintRecord();
        const first = !rec[this.bp.dayKey];
        if ((rec[this.bp.dayKey] || 0) < stars) {
          rec[this.bp.dayKey] = stars;
          localStorage.setItem('bba_blueprint_record', JSON.stringify(rec));
        }
        // main.js の開始画面が読む「これまでに何枚完成させたか」。
        // 同じ日の再挑戦では増やさない（枚数であって回数ではない）。
        if (first) {
          const n = Number(localStorage.getItem('bba_blueprint_clears') || 0) + 1;
          localStorage.setItem('bba_blueprint_clears', String(n));
        }
      } catch { /* 保存できなくても進行は止めない */ }
    } else {
      audio.gameOver();
    }
    const rewards = await submitResult({
      mode: 'blueprint', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      duration: secs, won,
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const starStr = won ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '';
    // なぜ終わったのかを一行で言う。ピースは設計図ちょうどぶんしか配られない
    // ので、外に置いた時点で「もう足りない」が確定して終わる ── その理由を
    // 出さないと、プレイヤーには理不尽な打ち切りに見える。
    const why = won ? '' : (this.missing() > this.cellsLeft()
      ? t('残りのピースでは設計図を埋めきれなくなりました（はみ出したぶんが足りません）',
          'The remaining pieces can no longer fill the blueprint — the squares you spilled outside are the ones you now need')
      : (this.remaining() === 0
        ? t('ピースを使い切りました', 'You ran out of pieces')
        : t('もう置ける場所がありません', 'No legal moves left')));
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : 'lose'}">${ic('mode_blueprint', 26)} ${won ? `${t('完成！', 'BUILT!')} ${starStr}` : t('未完成…', 'UNFINISHED…')}</div>
      <p class="muted center">${escapeHtml(t(this.bp.name, this.bp.nameEn))}</p>
      ${why ? `<p class="muted center" style="font-size:13px">${escapeHtml(why)}</p>` : ''}
      <div class="result-stats">
        <div class="rs-row"><span>${t('タイム', 'Time')}</span><b>${secs.toFixed(1)}s</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t('残りマス', 'Squares left')}</span><b>${this.missing()}</b></div>`}
        <div class="rs-row"><span>${t('崩壊', 'Crumbles')}</span><b>${this.crumbles}</b></div>
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Try again')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => {
      closeModal();
      this.destroy();
      currentMode = new BlueprintMode(this.bp);
      window.__bbaMode = currentMode;
      currentMode.start();
    };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    $('#hudTimer').classList.add('hidden');
    $('#hudTimer').classList.remove('urgent');
    $('#btnReroll').classList.remove('hidden');
    if (this.overlay) { this.overlay.destroy(); this.overlay = null; }
    if (view) view.onIntentPlace = null;
  }
}

let blueprintStarting = false;

export async function startBlueprint() {
  if (blueprintStarting) return;   // 二度押しで2回取りに行かせない
  blueprintStarting = true;
  const tk = beginModeStart();
  try {
    const bp = await fetchBlueprint();
    if (!bp) {
      toast(t('今日の設計図を読み込めませんでした', 'Could not load today\'s blueprint'), 'err', 3000);
      return;
    }
    // 待っている間に別のモードが始まっていたら、そちらを壊さずに降りる。
    if (modeStartStale(tk)) return;
    if (currentMode) currentMode.destroy();
    currentMode = new BlueprintMode(bp);
    window.__bbaMode = currentMode;
    currentMode.start();
  } finally {
    blueprintStarting = false;
  }
}

// main.js のメニューは window から名前を引く（callModeEntry）。
window.startBlueprint = () => startBlueprint();

// ===========================================================================
// 👻 I16 デイリーのゴーストリプレイ ／ 📼 I1 残像レース
// ===========================================================================
// 記録は着手ログだけ（{h, r, c, t}）。engine.js が決定的なので、
// new Engine(seed) を作って同じお題を適用し、moves を順に place() するだけで
// その人の走りが完全に再現できる。t は再生の間合い（演出）にしか使わない。
// ---------------------------------------------------------------------------

// サーバー側の上限と同じ。超えたぶんは送っても丸ごと捨てられる。
const DAILY_REPLAY_MAX_MOVES = 200;

// お題によっては録画を再現できない。
//
// 🪨瓦礫（rubble）は長らくここで封じていた ── 初期配置を engine.addGarbage() が
// Math.random() で決めていて（対戦で攻撃を受けた側だけ乱数列が進まないための
// 意図的な仕様）、シードから復元できなかったため。保存される録画は {h,r,c,t}
// だけなので、配置を後から取り戻す手段も無かった。
//
// これは applyDailyModifier に **その日の seed から作る専用の乱数**（dailyRng）を
// 渡すことで解決した。engine.rng には触らないのでピース列はズレず、全員が
// 同じ瓦礫を踏む ── デイリー本来の「全員同じ盤面」がようやく6日目にも
// 成り立つようになったので、再生も残像レースもこの日に開ける。
//
// いまここで断るお題は無い。関数は残す（次にお題を足したときに、再現できる
// かどうかを1か所で判断できる場所として要る）。
function replayReproducible(mod) {
  return true;
}

// 壊れた／古い形の録画で再生側が落ちないように、必ずここを通す。
function sanitizeReplayClient(rep) {
  if (!rep || !Array.isArray(rep.moves)) return null;
  const moves = [];
  for (const m of rep.moves.slice(0, DAILY_REPLAY_MAX_MOVES)) {
    if (!m) continue;
    const h = m.h | 0, r = m.r | 0, c = m.c | 0;
    if (h < 0 || h > 2 || r < 0 || r > 7 || c < 0 || c > 7) return null;
    moves.push({ h, r, c, t: Math.max(0, m.t | 0) });
  }
  if (!moves.length) return null;
  return { seed: rep.seed | 0, moves, score: Math.max(0, rep.score | 0) };
}

export async function fetchDailyReplays(day) {
  try {
    const q = day ? `?day=${encodeURIComponent(day)}` : '';
    return await api(`/api/daily/replays${q}`);
  } catch {
    return null;
  }
}

// 👻 その日の走りの一覧。TOP3 ＋（あれば）自分の回。
export async function openDailyReplays(day) {
  audio.click();
  const m = showModal(`<h2>${ic('clip', 22)} ${t('みんなの走り', 'Ghost replays')}</h2><p class="muted center">${t('読み込み中…', 'Loading…')}</p>`);
  const data = await fetchDailyReplays(day);
  if (!m.isConnected) return;   // 閉じられた後に描き込まない
  const rows = (data && Array.isArray(data.rows)) ? data.rows.slice() : [];
  if (data && data.mine && !rows.some(r => r.you)) rows.push(data.mine);
  const meta = data ? { day: data.day, seed: data.seed, modifier: data.modifier } : null;
  if (!rows.length) {
    m.innerHTML = `
      <h2>${ic('clip', 22)} ${t('みんなの走り', 'Ghost replays')}</h2>
      <p class="ms-empty">${t('まだ今日の記録がありません。いちばん乗りになろう！', 'No runs recorded today yet — be the first!')}</p>
      <div class="modal-buttons"><button class="btn btn-primary" id="grClose">${t('閉じる', 'Close')}</button></div>`;
    const b = m.querySelector('#grClose');
    if (b) b.onclick = () => { audio.click(); closeModal(); };
    return;
  }
  const mod = (data && data.modifier) || {};
  const playable = replayReproducible(mod);
  m.innerHTML = `
    <h2>${ic('clip', 22)} ${t('みんなの走り', 'Ghost replays')}</h2>
    <p class="muted center">${escapeHtml(`${data.day} ${t(mod.ja || '', mod.en || '')}`)}</p>
    ${playable ? '' : `<p class="muted center">${t('この日のお題は瓦礫の位置がひとりずつ違うため、走りを再生できません',
      'On rubble day the debris layout differs per player, so runs cannot be replayed')}</p>`}
    <div class="ms-list" id="grList"></div>
    <div class="modal-buttons"><button class="btn btn-primary" id="grClose">${t('閉じる', 'Close')}</button></div>`;
  const list = m.querySelector('#grList');
  rows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'ms-row';
    // 順位の絵は icons.js（medal_1/2/3）。4位以降は #N のまま。
    const medal = medalIconName(row.rank) ? icon(medalIconName(row.rank), { size: 18 }) : `#${row.rank}`;
    el.innerHTML = `
      <div class="ms-info">
        <div class="ms-name">${medal} ${escapeHtml(row.username || '???')}${row.you ? ` <small>(${t('あなた', 'you')})</small>` : ''}</div>
        <div class="ms-prog">${fmt(row.score)}${t('点', ' pts')}</div>
      </div>
      ${playable ? `<button class="btn btn-ghost" data-watch="${i}">${ic('spectate', 14)} ${t('観る', 'Watch')}</button>
      <button class="btn btn-primary" data-race="${i}">${ic('clip', 14)} ${t('対走', 'Race')}</button>` : ''}`;
    list.appendChild(el);
  });
  list.querySelectorAll('[data-watch]').forEach(b => {
    b.onclick = () => {
      const row = rows[b.dataset.watch | 0];
      audio.click();
      closeModal();
      startDailyReplay(row, { ...meta, username: row.username });
    };
  });
  list.querySelectorAll('[data-race]').forEach(b => {
    b.onclick = () => {
      const row = rows[b.dataset.race | 0];
      audio.click();
      closeModal();
      startDailyRace(row);
    };
  });
  const close = m.querySelector('#grClose');
  if (close) close.onclick = () => { audio.click(); closeModal(); };
}

// 📼 その人の残像と同時対走する。デイリー本体はふだんどおりの手続き
// （/api/daily で今日のお題を取り直し → 予約 → 開始）を通す。
export async function startDailyRace(row) {
  const rep = sanitizeReplayClient(row && row.replay);
  if (!rep) { toast(t('この走りは再生できません', 'This run cannot be replayed'), 'err', 2600); return; }
  let info = null;
  const tk = beginModeStart();
  try {
    info = await api('/api/daily');
  } catch {
    toast(t('サーバーに接続できません', 'Cannot reach the server'), 'err');
    return;
  }
  // 待っている間に別のモードが始まっていたら、そちらを壊さずに降りる。
  // （デイリーの回数を消費するのは startDaily の予約なので、その手前で止める）
  if (modeStartStale(tk)) return;
  if (!replayReproducible(info && info.modifier)) {
    toast(t('今日のお題では残像レースができません（瓦礫の位置がひとりずつ違うため）',
      'No ghost racing today — the rubble layout differs per player'), 'err', 3600);
    return;
  }
  startDaily(info, { ghost: { username: row.username, score: row.score, replay: rep } });
}

// ---------------------------------------------------------------------------
// 👻 再生専用モード。盤面はふだんの GameView をそのまま使い、
// inputLocked で読み取り専用にする（＝描画・演出の経路は本編と同じ）。
// ---------------------------------------------------------------------------

class ReplayMode {
  constructor(replay, meta) {
    this.mode = 'replay';
    // 他人の走りを見ているだけ。送る結果は無いので、サーバー更新の
    // 確定送信(__bbaSaveNow)で途中の手数のまま結果モーダルを出させない。
    this.savable = false;
    this.replay = replay;
    this.meta = meta || {};
    this.speed = 1;
    this.timer = null;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.add('hidden');
    showItemBar(false);
    $('#btnReroll').classList.add('hidden');
    this.ended = false;
    this.idx = 0;
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_sunset' });
    this.engine = new Engine(this.replay.seed);
    applyDailyModifier(this.engine, this.meta.modifier);
    v.setEngine(this.engine);
    v.inputLocked = true;          // 読み取り専用 ── 触っても盤面は動かない
    v.onPlace = null;
    v.onIntentPlace = null;
    v.onGameOver = null;
    this.updateHud();
    v.start();
    audio.playTrack('battle');
    this.buildBar();
    toast(t(`${this.meta.username || ''}さんの走りを再生中`, `Replaying ${this.meta.username || 'this run'}`), 'announce', 2600);
    this.timer = setTimeout(() => this.step(), 700);
  }

  // 速度と閉じるのボタン。既存の .zero-deal と同じ「盤面の下に置く帯」の作法。
  buildBar() {
    const wrap = document.createElement('div');
    wrap.id = 'replayBar';
    wrap.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:60;display:flex;gap:8px;align-items:center';
    wrap.innerHTML = `
      <button class="btn btn-ghost" id="rpSpeed">${t('等速', '1×')}</button>
      <button class="btn btn-primary" id="rpClose">${t('閉じる', 'Close')}</button>`;
    document.body.appendChild(wrap);
    this.bar = wrap;
    const sp = wrap.querySelector('#rpSpeed');
    sp.onclick = () => {
      audio.click();
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      sp.textContent = this.speed === 1 ? t('等速', '1×') : `${this.speed}×`;
    };
    wrap.querySelector('#rpClose').onclick = () => { audio.click(); this.quit(); };
  }

  step() {
    if (this.ended) return;
    const mv = this.replay.moves[this.idx];
    if (!mv) { this.finish(); return; }
    const e = this.engine;
    // 固定の録画なので、詰み判定で止めない（次の手が本当に打てるかで判断する）。
    e.over = false;
    const res = e.place(mv.h, mv.r, mv.c);
    if (!res) { this.finish(); return; }
    res.over = false;
    getView().applyResult(res);
    this.idx++;
    this.updateHud();
    const next = this.replay.moves[this.idx];
    if (!next) { this.timer = setTimeout(() => this.finish(), 900); return; }
    const gap = Math.min(3000, Math.max(150, (next.t || 0) - (mv.t || 0)));
    this.timer = setTimeout(() => this.step(), gap / this.speed);
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    $('#hudSub').innerHTML = ic('clip', 13) + ' ' + escapeHtml(t(`${this.meta.username || '記録'} の走り`, `${this.meta.username || 'Recorded'} run`));
    $('#hudTimer').textContent = `${this.idx}/${this.replay.moves.length}`;
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    // 操作バーは結果モーダル(z-index 50)より手前(60)に浮くので、
    // 残したままだと「閉じる」がモーダルの上に重なって見える。先に畳む。
    if (this.bar) { this.bar.remove(); this.bar = null; }
    const e = this.engine;
    const m = showModal(`
      <div class="result-banner draw">${ic('clip', 26)} ${t('再生おわり', 'Replay finished')}</div>
      <div class="result-stats">
        <div class="rs-row"><span>${t('走った人', 'Runner')}</span><b>${escapeHtml(this.meta.username || '???')}</b></div>
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}</b></div>
        <div class="rs-row"><span>${t('手数', 'Moves')}</span><b>${this.idx}</b></div>
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rList">${ic('clip', 15)} ${t('ほかの走り', 'Other runs')}</button>
        <button class="btn btn-primary" id="rRace">${ic('spectate', 15)} ${t('この人と対走', 'Race this run')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); this.destroy(); endToMenu(); };
    m.querySelector('#rList').onclick = () => { closeModal(); this.destroy(); endToMenu(); openDailyReplays(this.meta.day); };
    m.querySelector('#rRace').onclick = () => {
      closeModal(); this.destroy(); endToMenu();
      startDailyRace({ username: this.meta.username, score: e.score, replay: this.replay });
    };
  }

  quit() {
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.ended = true;
    clearTimeout(this.timer);
    this.destroy();
    endToMenu();
  }

  destroy() {
    this.ended = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.bar) { this.bar.remove(); this.bar = null; }
    $('#hudTimer').classList.add('hidden');
    $('#btnReroll').classList.remove('hidden');
  }
}

export function startDailyReplay(row, meta) {
  const rep = sanitizeReplayClient(row && row.replay);
  if (!rep) { toast(t('この走りは再生できません', 'This run cannot be replayed'), 'err', 2600); return; }
  if (!replayReproducible(meta && meta.modifier)) {
    toast(t('この日のお題は再生に対応していません', 'Runs from this day cannot be replayed'), 'err', 3000);
    return;
  }
  if (currentMode) currentMode.destroy();
  currentMode = new ReplayMode(rep, { ...(meta || {}), username: row.username });
  window.__bbaMode = currentMode;
  currentMode.start();
}

// ===========================================================================
// 🧩 I6 パズル工房 — 共有ステージのプレイと、投稿用エディタ
// ===========================================================================
// 遊ぶ側の契約は 🧩パズル遺跡（PuzzleMode）とまったく同じにしてある:
//   ・手札3枚。1手置いたら、その枠へ固定キューの先頭を補充
//   ・リロール／ランダム補充／アイテム／奥義は無し
//   ・補充のあとに e.over = false で「詰み」を判定し直す
// サーバーの投稿検証（verifyWorkshopClear）もこの契約で動いているので、
// ここがズレると「手元では解けたのに投稿が弾かれる」が起きる。
// ---------------------------------------------------------------------------

const WS_MAX_PIECES = 12;      // server/index.js の WS_MAX_PIECES と同じ
const WS_MIN_CELLS = 4;        // 同 WS_MIN_CELLS
const WS_TITLE_MAX = 24;       // 同 WS_TITLE_MAX

// 盤面の1マスの色。10/11（氷）は PALETTE に無いので水色で代用する
// ── エディタが出せるのは 1..9 だけだが、他人のステージには氷が入りうる。
function wsCellColor(v) {
  if (v === ICE || v === ICE_CRACKED) return '#9be3ff';
  const p = PALETTE[v];
  return p ? p[0] : 'transparent';
}

// 8×8 を DOM の CSS グリッドで描く（canvas を持ち出さずに済む小さな絵）。
// 幅は style.css の .ws-edit-grid に任せる（min(288px,74vw) ／ 狭幅は
// min(268px,82vw)）── 26px 固定だと 375px 端末で 100px 以上を捨てていた。
// 1マスは 1fr + aspect-ratio で伸び縮みするので、タップ対象も広がる。
function wsBoardHtml(board) {
  const cells = [];
  for (let k = 0; k < 64; k++) {
    const v = board[k] | 0;
    cells.push(`<i data-k="${k}" class="ws-edit-cell${v ? ' on' : ''}"${v ? ` style="background:${wsCellColor(v)}"` : ''}></i>`);
  }
  return `<div class="ws-edit-grid">${cells.join('')}</div>`;
}

// SHAPES の1つを小さく描く。
function wsShapeHtml(si, size = 9) {
  const cells = SHAPES[si].cells;
  const { rows, cols } = shapeSize(cells);
  const set = new Set(cells.map(([r, c]) => r * 8 + c));
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const on = set.has(r * 8 + c);
      out.push(`<i style="display:block;border-radius:2px;background:${on ? wsCellColor(SHAPES[si].color) : 'transparent'}"></i>`);
    }
  }
  return `<span style="display:inline-grid;grid-template-columns:repeat(${cols},${size}px);grid-auto-rows:${size}px;gap:1px;vertical-align:middle">${out.join('')}</span>`;
}

// サーバーの1件を、このモードが使う形にそろえる。
function normalizeWorkshopStageForPlay(raw) {
  const s = (raw && raw.stage) ? raw.stage : (raw && raw.raw ? raw.raw : raw);
  if (!s || !Array.isArray(s.board) || s.board.length !== 64) return null;
  if (!Array.isArray(s.pieces) || !s.pieces.length) return null;
  const pieces = [];
  for (const i of s.pieces) {
    const si = i | 0;
    if (!SHAPES[si]) return null;
    pieces.push({ shape: si, cells: SHAPES[si].cells, color: SHAPES[si].color });
  }
  return {
    code: String(s.code || '').toUpperCase(),
    title: String(s.title || s.name || '???'),
    author: String(s.author || '???'),
    par: s.par | 0,
    bestScore: s.bestScore | 0,
    board: s.board.map(v => v | 0),
    pieces,
  };
}

class WorkshopMode {
  // stage: normalizeWorkshopStageForPlay() の戻り値
  // opts.onCleared(moves, score) を渡すと、投稿用の「作者のクリア」取りにも使える
  constructor(stage, opts = {}) {
    this.mode = 'workshop';
    this.usesIntent = true;
    this.noItems = true;   // 固定キューの契約 — アイテム／奥義は解を壊す
    this.stage = stage;
    this.authoring = !!opts.authoring;
    // 作者の試遊はスコアを送らない。ここで finish() を呼ばれると引数なし＝
    // won undefined で「❌ クリアできませんでした」になり、投稿に必要な
    // 解答手順まで捨ててしまう（下書きは残る）。確定送信の対象から外す。
    this.savable = !this.authoring;
    this.onCleared = opts.onCleared || null;
  }

  start() {
    showScreen('game');
    $('#oppPanel').classList.add('hidden');
    const dl = $('#zeroDeal'); if (dl) dl.remove();
    $('#bossPanel').classList.add('hidden');
    $('#btnEmote').classList.add('hidden');
    $('#hudTimer').classList.remove('hidden');
    $('#chaosBar').classList.add('hidden');
    showItemBar(false);
    $('#btnReroll').classList.add('hidden');
    this.startedAt = Date.now();
    this.ended = false;
    this.moves = [];
    this.targets = new Set();
    for (let k = 0; k < 64; k++) if (this.stage.board[k]) this.targets.add(k);
    this.queue = this.stage.pieces.slice();
    this.total = this.queue.length;
    const v = getView();
    setModeTheme({ ...equippedTheme(), boardId: 'board_default' });
    this.engine = new Engine();
    this.engine.grid = this.stage.board.slice();
    this.engine.rerolls = 0;
    this.engine.refillHand = () => {};        // 固定キューだけが供給源
    this.engine.reroll = () => false;
    this.engine.hand = [this.queue.shift() || null, this.queue.shift() || null, this.queue.shift() || null];
    v.setEngine(this.engine);
    v.glowCells = this.targets;               // 消すべき光るマス
    v.inputLocked = false;
    v.onIntentPlace = (i, r, c) => this.intent(i, r, c);
    v.onPlace = null;
    v.onGameOver = () => this.finish(false);
    this.updateHud();
    updateAutoBtn();
    v.start();
    audio.playTrack('ruins');
    // プレイ数と作者への還元はサーバーが数える（金額はクライアントから指定できない）。
    if (!this.authoring && session.user && this.stage.code) {
      api(`/api/workshop/stages/${encodeURIComponent(this.stage.code)}/play`, { method: 'POST' })
        .catch(() => { /* 数えられなくても遊びは続く */ });
    }
    toast(this.authoring
      ? t('自分でクリアしてみよう！ この手順がそのまま投稿の「解けます」の証明になります',
        'Clear it yourself — this run becomes the proof that your stage is solvable')
      : t(`「${this.stage.title}」光るブロックをすべて消そう！`, `"${this.stage.title}" — clear every glowing block!`),
      'announce', 3400);
  }

  remaining() { return this.queue.length + this.engine.hand.filter(Boolean).length; }

  intent(index, row, col) {
    const e = this.engine;
    const piece = e.hand[index];
    if (!piece || this.ended || !e.canPlace(piece, row, col)) return true;
    const result = e.place(index, row, col);
    if (!result) return true;
    this.moves.push({ h: index | 0, r: row | 0, c: col | 0, t: Math.max(0, Date.now() - this.startedAt) });
    e.hand[index] = this.queue.shift() || null;   // 固定キュー、ランダム補充なし
    for (const [r, c] of result.clearedCells) this.targets.delete(r * 8 + c);
    // place() は補充前の手札で判定している。補充後に判定し直す。
    e.over = false;
    result.over = false;
    getView().applyResult(result);
    this.updateHud();
    if (this.ended) return true;
    if (this.targets.size === 0) { this.finish(true); return true; }
    if (!e.hasAnyMove()) {
      e.over = true;
      this.finish(false);
    }
    return true;
  }

  updateHud() {
    const el = $('#hudScore');
    el.textContent = fmt(this.engine.score);
    applyScoreFit(el, fmt(this.engine.score));
    bumpScore(el);
    $('#hudSub').innerHTML = ic('mode_workshop', 13) + ' ' + escapeHtml(t(`${this.stage.title} ・ 残り${this.targets.size}マス`,
      `${this.stage.title} — ${this.targets.size} left`));
    $('#hudTimer').innerHTML = `${ic('mode_workshop', 15)} ${this.remaining()}`;
  }

  async finish(won) {
    if (this.ended) return;
    this.ended = true;
    getView().inputLocked = true;
    const e = this.engine;
    const secs = (Date.now() - this.startedAt) / 1000;
    if (won) { confettiBurst(40); audio.victory(); } else { audio.gameOver(); }
    // 投稿用の試遊はここで折り返す（スコア送信もしない）。
    if (this.authoring) {
      const cb = this.onCleared;
      const moves = this.moves.slice();
      const score = e.score;
      if (won && cb) { cb(moves, score); return; }
      const m = showModal(`
        <div class="result-banner lose">${ic('close', 24)} ${t('クリアできませんでした', 'Not solved')}</div>
        <p class="muted center">${t('投稿するには、自分で1回クリアする必要があります。', 'You must clear it once yourself before publishing.')}</p>
        <p class="muted center">${t(`残り${this.targets.size}マス`, `${this.targets.size} squares left`)}</p>
        <div class="modal-buttons">
          <button class="btn btn-ghost" id="wsBack">${ic('mode_workshop', 15)} ${t('作りなおす', 'Back to editor')}</button>
          <button class="btn btn-primary" id="wsRetry">${t('もう一度挑戦', 'Try again')}</button>
        </div>`, { dismissable: false });
      m.querySelector('#wsRetry').onclick = () => { closeModal(); this.ended = false; this.start(); };
      m.querySelector('#wsBack').onclick = () => { closeModal(); this.destroy(); endToMenu(); openWorkshopEditor(this.stage); };
      return;
    }
    const rewards = await submitResult({
      mode: 'workshop', score: e.score, lines: e.linesCleared, maxCombo: e.maxCombo,
      duration: secs, won,
      // どのステージを解いたかの6文字共有コード。サーバーはこれで
      // 「同じ code の初回クリアだけ勝利扱い」に切り替えられる（暫定の
      // 勝利加算レート上限の置き換え）。金額・勝敗はサーバー側で再判定するので、
      // ここは識別子を名乗るだけ。空なら送らない（作者試遊はここに来ない）。
      ...(this.stage.code ? { stageCode: this.stage.code } : {}),
    });
    // await 中に✕→終了でメニューへ戻っていたら結果モーダルを出さない。
    if (currentMode !== this) return;
    const m = showModal(`
      <div class="result-banner ${won ? 'win' : 'lose'}">${won ? `${ic('mode_puzzle', 26)} ${t('クリア！', 'SOLVED!')}` : `${ic('close', 24)} ${t('失敗…', 'FAILED…')}`}</div>
      <p class="muted center">${escapeHtml(`${this.stage.title} — ${this.stage.author}`)}</p>
      <div class="result-stats">
        <div class="rs-row"><span>${t('タイム', 'Time')}</span><b>${secs.toFixed(1)}s</b></div>
        <div class="rs-row"><span>${t('使った手数', 'Moves used')}</span><b>${this.moves.length}${this.stage.par ? ` / ${t('作者', 'author')} ${this.stage.par}` : ''}</b></div>
        ${won ? '' : `<div class="rs-row"><span>${t('残りブロック', 'Blocks left')}</span><b>${this.targets.size}</b></div>`}
        <div class="rs-row"><span>${t('スコア', 'Score')}</span><b>${fmt(e.score)}${this.stage.bestScore ? ` / ${fmt(this.stage.bestScore)}` : ''}</b></div>
        ${rewardsRows(rewards)}
      </div>
      <div class="modal-buttons">
        <button class="btn btn-ghost" id="rMenu">${t('メニュー', 'Menu')}</button>
        <button class="btn btn-ghost" id="rList">${ic('mode_workshop', 15)} ${t('工房へ', 'Workshop')}</button>
        <button class="btn btn-primary" id="rAgain">${t('もう一度', 'Retry')}</button>
      </div>`, { dismissable: false, peekable: true });
    m.querySelector('#rMenu').onclick = () => { closeModal(); endToMenu(); };
    m.querySelector('#rAgain').onclick = () => { closeModal(); this.ended = false; this.start(); };
    m.querySelector('#rList').onclick = () => {
      closeModal(); this.destroy(); endToMenu();
      if (window.openWorkshop) window.openWorkshop();
    };
  }

  quit() {
    // すでに結果まで進んでいるなら finish() は先頭で即 return するので、
    // ここで戻さないと ✕ →「終了する」を押しても何も起きない画面に残る。
    if (this.ended) { closeModal(); endToMenu(); return; }
    this.finish(false);
  }

  destroy() {
    this.ended = true;
    $('#hudTimer').classList.add('hidden');
    $('#btnReroll').classList.remove('hidden');
    if (view) { view.onIntentPlace = null; view.glowCells = null; }
  }
}

let workshopStarting = false;

// screens.js の「▶ 遊ぶ」がこの名前で呼ぶ（第2引数は一覧の生ステージ、無ければ null）。
export async function startWorkshopStage(code, stage) {
  if (workshopStarting) return;   // 二度押しで2回取りに行かせない
  workshopStarting = true;
  const tk = beginModeStart();
  try {
    let st = normalizeWorkshopStageForPlay(stage);
    if (!st || !st.board) {
      // 一覧には board が入っていない（軽くするため）ので個別取得する。
      try {
        st = normalizeWorkshopStageForPlay(await api(`/api/workshop/stages/${encodeURIComponent(String(code || '').toUpperCase())}`));
      } catch {
        st = null;
      }
    }
    if (!st) {
      toast(t('このステージを読み込めませんでした', 'Could not load that stage'), 'err', 3000);
      return;
    }
    // 待っている間に別のモードが始まっていたら、そちらを壊さずに降りる。
    if (modeStartStale(tk)) return;
    if (currentMode) currentMode.destroy();
    currentMode = new WorkshopMode(st);
    window.__bbaMode = currentMode;
    currentMode.start();
  } finally {
    workshopStarting = false;
  }
}

// ---------------------------------------------------------------------------
// 🛠️ 投稿エディタ
//
// 手順は3つだけ:
//   ① 盤面を塗る（光るマスが「消すべきマス」になる）
//   ② 配るピースを並べる（この順で配られる ＝ 固定キュー）
//   ③ 自分でクリアする → その手順を replay として添えて投稿
// サーバーは③を再生して「本当に解ける」ことを確かめてから公開する。
// ---------------------------------------------------------------------------

// 作りかけを持ち回るための下書き（モーダルを閉じても消えない）。
let wsDraft = null;

function wsNewDraft() {
  return { board: new Array(64).fill(0), pieces: [], color: 1, title: '' };
}

export function openWorkshopEditor(fromStage) {
  if (!session.user) {
    // screens.js 側でログイン確認済みだが、直接呼ばれたときの保険。
    toast(t('ステージの投稿にはアカウントが必要です', 'You need an account to publish a stage'), 'err', 3000);
    return;
  }
  if (fromStage && Array.isArray(fromStage.board)) {
    // 「作りなおす」で戻ってきたとき ── 下書きをそのまま復元する。
    wsDraft = wsDraft || wsNewDraft();
    wsDraft.board = fromStage.board.slice();
    wsDraft.pieces = fromStage.pieces.map(p => p.shape);
  }
  if (!wsDraft) wsDraft = wsNewDraft();
  wsEditorStep1();
}

// ---- ① 盤面 ----
function wsEditorStep1() {
  const d = wsDraft;
  const swatches = [];
  for (let v = 1; v <= 9; v++) {
    // 色見本も指で押せる大きさに下限を切る（中身が空のボタンなので padding 任せにしない）。
    swatches.push(`<button class="btn btn-ghost ws-sw" data-color="${v}" style="min-width:44px;min-height:34px;padding:6px 8px;background:${wsCellColor(v)}"></button>`);
  }
  const m = showModal(`
    <h2>${ic('mode_workshop', 22)} ${t('ステージを作る（1/3）', 'Create a stage (1/3)')}</h2>
    <p class="muted center">${t('光らせたマスが「消すべきブロック」になります（4マス以上）。タップで塗る／もう一度で消す。なぞってまとめて塗れます。',
      'The squares you paint become the blocks to clear (4 or more). Tap to paint, tap again to erase — or drag to paint several at once.')}</p>
    <div id="wsBoardWrap">${wsBoardHtml(d.board)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:10px">${swatches.join('')}</div>
    <p class="muted center" id="wsCount"></p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wsClear">${t('全消し', 'Clear all')}</button>
      <button class="btn btn-ghost" id="wsCancel">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-primary" id="wsNext">${t('次へ', 'Next')}</button>
    </div>`, { dismissable: false });

  const count = () => d.board.reduce((a, v) => a + (v ? 1 : 0), 0);
  const refreshCount = () => {
    const n = count();
    m.querySelector('#wsCount').textContent = t(`光るマス ${n} / 64（${WS_MIN_CELLS}以上・全マスは不可）`,
      `${n} / 64 glowing (need ${WS_MIN_CELLS}+, cannot be all 64)`);
  };
  const wrap = m.querySelector('#wsBoardWrap');
  const paint = () => {
    wrap.innerHTML = wsBoardHtml(d.board);
    refreshCount();
  };
  // 1マス塗る／消す（DOM も一緒に更新する。再描画はしない）。
  const setCell = (k, on) => {
    d.board[k] = on ? d.color : 0;
    const el = wrap.querySelector(`[data-k="${k}"]`);
    if (!el) return;
    el.classList.toggle('on', !!d.board[k]);
    el.style.background = d.board[k] ? wsCellColor(d.board[k]) : '';
  };
  // なぞって塗る。押した場所が空きなら「塗る」、埋まっていれば「消す」に決まり、
  // 指を離すまでその向きを保つ（塗り／消しが交互に暴れない）。
  // セルは innerHTML で作り直されるので、拾うのは入れ物側で1回だけにする。
  let dragOn = null;
  let lastBeep = 0;
  const cellAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !wrap.contains(el) || el.dataset.k == null) return -1;
    return el.dataset.k | 0;
  };
  const touchCell = (k) => {
    if (k < 0 || dragOn === null) return;
    const want = dragOn ? d.color : 0;
    if ((d.board[k] | 0) === want) return;   // 変わらないなら触らない
    setCell(k, dragOn);
    const now = Date.now();
    if (now - lastBeep > 60) { audio.pickup(); lastBeep = now; }   // なぞりで鳴り続けない
    refreshCount();
  };
  const bindCells = () => {
    wrap.addEventListener('pointerdown', e => {
      const k = cellAt(e.clientX, e.clientY);
      if (k < 0) return;
      dragOn = !(d.board[k] | 0);
      e.preventDefault();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 取れなくても move は拾える */ }
      touchCell(k);
    });
    wrap.addEventListener('pointermove', e => {
      if (dragOn === null) return;
      // 盤の外で指／ボタンを離したときの保険（押していなければ塗らない）。
      if (!e.buttons) { dragOn = null; return; }
      touchCell(cellAt(e.clientX, e.clientY));
    });
    const endDrag = () => { dragOn = null; };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
  };
  const markSwatch = () => {
    m.querySelectorAll('.ws-sw').forEach(b => {
      b.style.outline = (b.dataset.color | 0) === d.color ? '3px solid #fff' : 'none';
    });
  };
  m.querySelectorAll('.ws-sw').forEach(b => {
    b.onclick = () => { d.color = b.dataset.color | 0; audio.click(); markSwatch(); };
  });
  m.querySelector('#wsClear').onclick = () => { audio.click(); d.board.fill(0); paint(); };
  m.querySelector('#wsCancel').onclick = () => { audio.click(); closeModal(); if (window.openWorkshop) window.openWorkshop(); };
  m.querySelector('#wsNext').onclick = () => {
    const n = count();
    if (n < WS_MIN_CELLS) { audio.error(); toast(t(`光るマスを${WS_MIN_CELLS}個以上にしてください`, `Paint at least ${WS_MIN_CELLS} squares`), 'err', 2200); return; }
    if (n >= 64) { audio.error(); toast(t('全マスを埋めることはできません', 'The board cannot be completely full'), 'err', 2200); return; }
    audio.click();
    closeModal();
    wsEditorStep2();
  };
  bindCells();
  refreshCount();
  markSwatch();
}

// ---- ② ピース ----
function wsEditorStep2() {
  const d = wsDraft;
  // 1×1 のピースでも指で押せるよう、ボタンの下限を 44px 角で切る。
  const picker = SHAPES.map((s, i) => `<button class="btn btn-ghost" data-shape="${i}" style="min-width:44px;min-height:44px;padding:6px;display:inline-flex;align-items:center;justify-content:center">${wsShapeHtml(i, 8)}</button>`).join('');
  const m = showModal(`
    <h2>${ic('mode_workshop', 22)} ${t('ステージを作る（2/3）', 'Create a stage (2/3)')}</h2>
    <p class="muted center">${t(`配るピースを並べます（この順に配られます・最大${WS_MAX_PIECES}個）。`,
      `Pick the pieces in the order they will be dealt (up to ${WS_MAX_PIECES}).`)}</p>
    <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:center;max-height:150px;overflow:auto">${picker}</div>
    <p class="muted center">${t('▼ 配る順', '▼ Deal order')}</p>
    <div id="wsQueue" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;min-height:26px"></div>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wsBack">${t('盤面へ', 'Board')}</button>
      <button class="btn btn-ghost" id="wsPop">${t('1つ戻す', 'Undo')}</button>
      <button class="btn btn-primary" id="wsPlay">${t('自分でクリアする', 'Clear it yourself')}</button>
    </div>`, { dismissable: false });

  const drawQueue = () => {
    m.querySelector('#wsQueue').innerHTML = d.pieces.length
      ? d.pieces.map((si, i) => `<span title="${i + 1}">${wsShapeHtml(si, 7)}</span>`).join('')
      : `<span class="muted">${t('まだ1つも選んでいません', 'No pieces chosen yet')}</span>`;
  };
  m.querySelectorAll('[data-shape]').forEach(b => {
    b.onclick = () => {
      if (d.pieces.length >= WS_MAX_PIECES) { audio.error(); toast(t(`ピースは${WS_MAX_PIECES}個までです`, `Up to ${WS_MAX_PIECES} pieces`), 'err', 2000); return; }
      d.pieces.push(b.dataset.shape | 0);
      audio.pickup();
      drawQueue();
    };
  });
  m.querySelector('#wsPop').onclick = () => { audio.click(); d.pieces.pop(); drawQueue(); };
  m.querySelector('#wsBack').onclick = () => { audio.click(); closeModal(); wsEditorStep1(); };
  m.querySelector('#wsPlay').onclick = () => {
    if (!d.pieces.length) { audio.error(); toast(t('ピースを1つ以上選んでください', 'Choose at least one piece'), 'err', 2200); return; }
    audio.click();
    closeModal();
    wsEditorTestRun();
  };
  drawQueue();
}

// ---- ③ 自分でクリア → 投稿 ----
function wsEditorTestRun() {
  const d = wsDraft;
  const stage = {
    code: '', title: t('作成中のステージ', 'Draft stage'), author: (session.user && session.user.username) || '',
    par: 0, bestScore: 0,
    board: d.board.slice(),
    pieces: d.pieces.map(si => ({ shape: si, cells: SHAPES[si].cells, color: SHAPES[si].color })),
  };
  if (currentMode) currentMode.destroy();
  currentMode = new WorkshopMode(stage, {
    authoring: true,
    onCleared: (moves, score) => wsPublishPrompt(moves, score),
  });
  window.__bbaMode = currentMode;
  currentMode.start();
}

function wsPublishPrompt(moves, score) {
  const d = wsDraft;
  const m = showModal(`
    <div class="result-banner win">${ic('mode_puzzle', 26)} ${t('クリア！ 投稿できます', 'Solved — ready to publish')}</div>
    <p class="muted center">${t(`手数 ${moves.length} ・ スコア ${fmt(score)}`, `${moves.length} moves ・ ${fmt(score)} pts`)}</p>
    <div class="settings-row">
      <label for="wsTitle">${t('ステージ名', 'Stage name')}</label>
      <input id="wsTitle" type="text" maxlength="${WS_TITLE_MAX}" value="${escapeHtml(d.title || '')}" placeholder="${t('2〜24文字', '2–24 characters')}">
    </div>
    <p class="muted center">${t('この手順をサーバーが再生して、本当に解けることを確かめてから公開されます。',
      'The server replays your clear to confirm the stage is solvable before publishing.')}</p>
    <div class="modal-buttons">
      <button class="btn btn-ghost" id="wsAbort">${t('やめる', 'Cancel')}</button>
      <button class="btn btn-ghost" id="wsEdit">${ic('mode_workshop', 15)} ${t('直す', 'Edit')}</button>
      <button class="btn btn-primary" id="wsPublish">${t('投稿する', 'Publish')}</button>
    </div>`, { dismissable: false });
  const input = m.querySelector('#wsTitle');
  m.querySelector('#wsAbort').onclick = () => { audio.click(); closeModal(); endToMenu(); };
  m.querySelector('#wsEdit').onclick = () => { audio.click(); closeModal(); endToMenu(); wsEditorStep1(); };
  m.querySelector('#wsPublish').onclick = async () => {
    const title = String(input.value || '').trim();
    if (title.length < 2) { audio.error(); toast(t('ステージ名を2文字以上で入力してください', 'The stage name needs at least 2 characters'), 'err', 2400); return; }
    d.title = title;
    const btn = m.querySelector('#wsPublish');
    btn.disabled = true;
    btn.textContent = t('送信中…', 'Publishing…');
    try {
      const res = await api('/api/workshop/stages', {
        method: 'POST',
        body: { title, board: d.board, pieces: d.pieces, replay: { moves } },
      });
      audio.coin();
      closeModal();
      endToMenu();
      wsDraft = null;   // 公開できた下書きは捨てる
      toast(t(`公開しました！ 共有コード: ${res.code}`, `Published! Share code: ${res.code}`), 'ok', 6000);
      if (window.openWorkshop) window.openWorkshop('new');
    } catch (err) {
      audio.error();
      btn.disabled = false;
      btn.textContent = t('投稿する', 'Publish');
      toast(err.message || t('投稿できませんでした', 'Could not publish'), 'err', 4000);
    }
  };
  setTimeout(() => { try { input.focus(); } catch { /* ignore */ } }, 120);
}

// screens.js が window 経由で呼ぶ約束になっている2つ。
// main.js から import しても使えるよう export もしてある。
window.startWorkshopStage = (code, stage) => { startWorkshopStage(code, stage); };
window.openWorkshopEditor = () => { openWorkshopEditor(); };
