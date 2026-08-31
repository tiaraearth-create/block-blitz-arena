// 🛠 パズル工房 — プレイヤーが作ったステージの投稿・配布・いいね・削除。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
import express from 'express';
import crypto from 'crypto';
import {
  saveDb,
} from '../db.js';
import {
  requireAuth, requireAdmin,
} from '../auth.js';
import {
  jstDayKey,
} from '../adminevent.js';
import {
  blueprintHasFullLine,
} from '../daily.js';
import {
  Engine, SHAPES, SIZE,
} from '../../public/js/engine.js';
import { ctx } from '../context.js';
import { buildWorkshopSeedStages, WORKSHOP_SEED_REV } from '../workshop-seed.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
// sanitizeReplay の実体は routes/daily.js にあるが、routes 同士を直接
// つながないため index.js がいったん受けて ctx に載せている。
let db, rateLimit, sanitizeReplay, adminLog, BUGREPORT_CAP;
export function initWorkshopRoutes() {
  ({ db, rateLimit, sanitizeReplay, adminLog, BUGREPORT_CAP } = ctx);
  seedWorkshopStages();
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const workshopRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 🛠 パズル工房 — プレイヤーが作ったステージの投稿と配布
//
// 投稿には「作者自身のクリアリプレイ」を必ず添えてもらう。サーバーは公開する
// 前に public/js/engine.js を実際に回してその着手を再生し、本当に光るマスが
// 全部消えることを確かめる。これが「解けないステージが投稿される」のを防ぐ
// 唯一の手段（盤面を眺めて解けるかどうかを判定するのは現実的でない）。
//
// ピースは「形の番号」だけを保存する。cells をクライアントに名乗らせると
// 存在しない形のピースを投稿できてしまうので、形はサーバー側で SHAPES から引く。
//
// 保存先は db.meta.workshop。db.meta 配下なのは 🎞リプレイと同じ理由
// （backup.js の復元がキーごと引き継ぐ／live 側で先に空を作らない）。
// ---------------------------------------------------------------------------

const WS_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // party.js と同じ（紛らわしい字を抜いた）
const WS_CODE_LEN = 6;                 // 合言葉ルームの4桁より広い（ずっと残る共有コードなので）
const WS_MAX_STAGES = 500;             // 全体の上限
const WS_MAX_PER_USER = 10;            // 1人あたりの上限
const WS_MAX_PIECES = 12;              // 配るピースの本数（遺跡の最大10より少しだけ広い）
const WS_MIN_CELLS = 4;                // 光るマスがこれ未満の盤面は「ステージ」と呼べない
const WS_TITLE_MAX = 24;
const WS_LIKE_MAX = 3000;              // 1ステージが受け付ける♡の総数の上限（表示カウンタの天井）
// 1ユーザーが「♡した」と覚えておくステージ数（二重♡防止の実体）。
// 工房に同時に存在しうるステージは WS_MAX_STAGES 件までなので、それより多く
// 覚えても原理的に使われない ── 以前の 1000 は必要な数のちょうど2倍で、
// 1レコード9KB（全上限を埋めた最悪ケースの2割強）をディスクに書き続けていた。
// 250msごとに db.json を丸ごと書く設計なので、ここは「機能として妥当か」より
// 「db 全体の予算に対して妥当か」で選ぶ。数値は写経せず定数を参照する。
const WS_USER_LIKED_MAX = WS_MAX_STAGES;
const WS_PLAY_COINS = 5;               // 1プレイあたり作者に還元するコイン
const WS_AUTHOR_COIN_DAY_CAP = 300;    // 作者1人が1日に受け取れる還元の上限（60プレイぶん）
const WS_LIST_MAX = 30;                // 1ページの既定件数（limit 未指定のとき）
const WS_LIST_HARD_MAX = 60;           // limit で広げられる上限（ページ送りの取りこぼしを防ぐ）
const WS_DUP_MS = 10 * 60 * 1000;      // これ以内の「まったく同じ投稿」は押し直しとみなす

function workshopStore() {
  const w = db.meta.workshop;
  return w && typeof w === 'object' && !Array.isArray(w) ? w : null;
}
function ensureWorkshop() {
  let w = workshopStore();
  if (!w) { db.meta.workshop = { stages: {}, payout: { day: jstDayKey(), by: {} } }; w = db.meta.workshop; }
  if (!w.stages || typeof w.stages !== 'object' || Array.isArray(w.stages)) w.stages = {};
  return w;
}
// 読み取り専用の入口。まだ誰も投稿していなければ空のまま（倉庫を作らない）。
function workshopStages() {
  const w = workshopStore();
  return w && w.stages && typeof w.stages === 'object' && !Array.isArray(w.stages) ? w.stages : {};
}
function workshopCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, WS_CODE_LEN);
}
function findWorkshopStage(raw) {
  const code = workshopCode(raw);
  if (code.length !== WS_CODE_LEN) return null;
  const s = workshopStages()[code];
  return s && typeof s === 'object' ? s : null;
}
// 共有コード。party.js / guilds.js と同じ流儀（紛らわしい字を抜いた表から引いて、
// 既存と衝突しなくなるまで引き直す）。
function makeWorkshopCode(stages) {
  for (let tries = 0; tries < 60; tries++) {
    let c = '';
    for (let i = 0; i < WS_CODE_LEN; i++) c += WS_CODE_CHARS[Math.floor(Math.random() * WS_CODE_CHARS.length)];
    if (!stages[c]) return c;
  }
  return null;
}

// ステージ名。ゲーム内で唯一「自由な文字がそのまま公開表示される永続テキスト」
// なので、ユーザー名・ギルド名ほど厳しくはしない（絵文字は通したい）かわりに、
// 表示を壊す種類の文字だけを落とす:
//   ・制御文字（改行・タブ・C1）… カードの行を割る
//   ・双方向制御（U+202A..202E, U+2066..2069, U+200E/200F, U+061C）… 周りの文字を反転させる
//   ・ゼロ幅（U+200B..200D, U+FEFF）… 見えない字で長さを稼ぐ
//   ・結合文字（いわゆる Zalgo）… カードの外へ縦に突き抜ける
// 濁点・半濁点（U+3099/309A）は落とさない ── 分解済みの日本語を壊すため。
// 先に NFC へ寄せておくと「が」のような分解表記が1文字に畳まれる。
// 長さは Array.from で数える（絵文字1つを1文字として扱う）。
const WS_TITLE_STRIP = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const WS_TITLE_COMBINING = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20F0\uFE20-\uFE2F]/g;
function sanitizeWorkshopTitle(raw) {
  let t = String(raw == null ? '' : raw);
  try { t = t.normalize('NFC'); } catch { /* 壊れたサロゲートでも投稿は続行 */ }
  // 改行・タブは「詰める」のではなく空白にする（単語がくっついて別の語に見えないように）。
  t = t.replace(/[\t\n\r\u000B\u000C\u0085\u2028\u2029]/g, ' ');
  t = t.replace(WS_TITLE_STRIP, '').replace(WS_TITLE_COMBINING, '').replace(/[<>"'`]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, WS_TITLE_MAX).join('');
}

// 退会・管理者削除の後始末。作者が db.users から消えると workshopView は
// byName（投稿時の表示名スナップショット）へフォールバックするので、何も
// しないと「退会したのに、自分の名前つきのステージが未認証でも読める一覧に
// 並び続ける」ことになる。両方の削除経路がこの1本を呼ぶ:
//   ① その人が投稿したステージを消す
//   ② 移行前の stage.likedBy に残っている生IDから、その人の分を外す
//      （likes はカウンタで別に持っているので表示数は動かない）
//   ③ その日のコイン還元台帳から行を落とす
// 判定できるのは「id で照合するだけ」なので、レコード削除の前でも後でもよい。
export function purgeUserWorkshop(userId) {
  const id = String(userId || '');
  const w = id ? workshopStore() : null;
  const stages = w && w.stages && typeof w.stages === 'object' && !Array.isArray(w.stages) ? w.stages : null;
  if (!stages) return { stages: 0, likes: 0 };
  let removed = 0, unliked = 0;
  for (const [code, s] of Object.entries(stages)) {
    if (!s) continue;
    if (s.by === id) { delete stages[code]; removed++; continue; }
    if (Array.isArray(s.likedBy)) {
      const i = s.likedBy.indexOf(id);
      if (i !== -1) { s.likedBy.splice(i, 1); unliked++; }
    }
  }
  if (w.payout && w.payout.by && typeof w.payout.by === 'object') delete w.payout.by[id];
  return { stages: removed, likes: unliked };
}

// 凍結された人の作品は公開面から引っ込める。db から導出しているだけなので、
// 凍結を解けばそのまま戻る（stages 側に印を足さないぶん、復元の合流も無傷）。
// ※ 退会・管理者削除でユーザーごと消えた場合は db.users から引けず、ここでは
//   判定できない。その掃除は上の purgeUserWorkshop() を削除経路から呼ぶ形。
function stageHidden(stage) {
  const author = stage ? db.users[stage.by] : null;
  return !!(author && author.banned);
}
const isAdminViewer = viewer => !!viewer && viewer.role === 'admin';

// 投稿された盤面。8x8 で、マスの値は engine.js が知っている範囲だけ:
// 0=空 / 1..8=通常色 / 9=お邪魔 / 10・11=❄️氷結（2段耐久）。
// 範囲外の数値は通さない ── 描画側が知らない値が盤面に居座ることになる。
// どの値を使っても「本当に解けるか」は下の再生検証が別途保証する。
const WS_CELL_MAX = 11;
function parseWorkshopBoard(raw) {
  if (!Array.isArray(raw) || raw.length !== SIZE * SIZE) return null;
  const board = new Array(SIZE * SIZE).fill(0);
  let filled = 0;
  for (let i = 0; i < board.length; i++) {
    const v = Math.floor(Number(raw[i]));
    if (!Number.isFinite(v) || v < 0 || v > WS_CELL_MAX) return null;
    board[i] = v;
    if (v !== 0) filled++;
  }
  if (filled < WS_MIN_CELLS) return null;
  if (filled >= board.length) return null;   // 全マス埋まりでは1手も置けない
  return { board, filled };
}
// 最初から揃っている行・列があるか。あると engine は最初の1手でそれを全部
// 消してしまう（63マス塗って1x1を1個置けば16ライン同時＝25,601点が1手で出る）。
// 判定は 📅デイリーの設計図とまったく同じ掟（daily.js の blueprintHasFullLine）
// を使い回す ── ステージも設計図も「置いて初めて揃う」ものだけを認める。
function boardHasFullLine(board) {
  const cells = [];
  for (let i = 0; i < board.length; i++) if (board[i] !== 0) cells.push(i);
  return blueprintHasFullLine(cells);
}
// 配るピース列は SHAPES の番号だけ。存在しない形は通さない。
function parseWorkshopPieces(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > WS_MAX_PIECES) return null;
  const out = [];
  for (const v of raw) {
    const i = Math.floor(Number(v));
    if (!(i >= 0 && i < SHAPES.length)) return null;
    out.push(i);
  }
  return out;
}

// 作者のクリアリプレイを実際に再生する。engine.js は決定的なので、同じ盤面・
// 同じピース列・同じ着手なら、誰がいつ走らせても同じ結果になる。
// 契約は 🧩パズル遺跡（modes.js の PuzzleMode）と同じ:
//   ・手札は3枚。1手置くたびに、その枠へ固定キューの先頭を補充する
//   ・ランダム補充もリロールも無い
//   ・勝ち = 最初から盤面にあったマスが全部消えた（あとから置いた自分のマスは残ってよい）
function verifyWorkshopClear(board, pieceIdx, moves) {
  const e = new Engine(1);
  e.grid = board.slice();
  e.rerolls = 0;
  e.refillHand = () => {};      // 固定キューだけがピースの供給源
  e.reroll = () => false;
  const queue = pieceIdx.map(i => ({ shape: i, cells: SHAPES[i].cells, color: SHAPES[i].color }));
  e.hand = [queue.shift() || null, queue.shift() || null, queue.shift() || null];
  const targets = new Set();
  for (let k = 0; k < board.length; k++) if (board[k] !== 0) targets.add(k);
  let used = 0;
  for (const mv of moves) {
    if (targets.size === 0) break;
    if (!e.hand[mv.h]) return { ok: false, reason: 'empty' };
    const r = e.place(mv.h, mv.r, mv.c);
    if (!r) return { ok: false, reason: 'illegal' };
    used++;
    e.hand[mv.h] = queue.shift() || null;
    for (const [rr, cc] of r.clearedCells) targets.delete(rr * SIZE + cc);
    // place() は補充前の手札で「もう置けない」を判定している。固定キューを
    // 補充したあとに判定し直す（PuzzleMode.intent と同じ）。
    e.over = false;
  }
  if (targets.size > 0) return { ok: false, reason: 'left', left: targets.size };
  return { ok: true, moves: used, score: e.score };
}

// ---------------------------------------------------------------------------
// 🏁 開店祝いの初期ステージ（server/workshop-seed.js）
//
// 起動時に一度だけ、**工房がまだ空のときだけ** 住人のステージを何本か置く。
// 空の工房は「まだ誰も投稿していません」しか出ず、遊び方も伝わらないため。
//
// 冪等性は二重の門で担保する:
//   ① db.meta.workshop.seedRev … 一度でも投入したら以後は何もしない。
//      これがあるので「初期ステージを全部消した」あとに再起動しても復活しない。
//   ② stages が1つでもあるなら触らない … 復元やバックアップで人の投稿が
//      入っている工房に、あとから開店祝いを足さない。
//   さらに ③ コードが既に埋まっているステージは飛ばす（多重防御）。
//
// 投入前に、投稿と**まったく同じ** verifyWorkshopClear() で作者の模範解答を
// 再生する。解けなかったものは入らない ── 「解けないステージが公開される」
// のを防ぐ仕組みを、運営が置くステージだけ素通りさせては意味がない。
// ---------------------------------------------------------------------------
function seedWorkshopStages() {
  const w = workshopStore();
  if (w && (w.seedRev || (w.stages && typeof w.stages === 'object' && Object.keys(w.stages).length > 0))) return;
  const seeded = buildWorkshopSeedStages(verifyWorkshopClear, (s, why) => {
    console.warn(`[workshop] 初期ステージ「${s.title}」は再生で解けなかったので入れませんでした (${why})`);
  });
  const store = ensureWorkshop();
  store.seedRev = WORKSHOP_SEED_REV;   // 落ちた場合も含めて「一度走った」印
  let added = 0;
  for (const s of seeded) {
    if (store.stages[s.code]) continue;
    store.stages[s.code] = s;
    added++;
  }
  saveDb();
  if (added) console.log(`[workshop] 🛠パズル工房に住人の初期ステージ ${added}件を並べました`);
}

// 配信する形。solution（作者の模範解答）は本人と管理者にしか出さない ──
// 誰でも読めると、工房のステージが全部「答えを見るだけ」になってしまう。
function workshopView(stage, viewer, opts = {}) {
  const mine = !!viewer && stage.by === viewer.id;
  const author = db.users[stage.by];
  const out = {
    code: stage.code,
    title: stage.title,
    author: author ? author.username : stage.byName,
    at: stage.at,
    pieces: stage.pieces,
    par: stage.par,
    bestScore: stage.score || 0,
    plays: stage.plays || 0,
    likes: stage.likes || 0,
    // 二重♡防止はユーザー側（viewer.wsLiked）へ移したが、移行前に stage.likedBy へ
    // 積まれた既存の♡も引き続き「済み」と見なす（新旧どちらかに印があれば liked）。
    liked: !!viewer && (
      (Array.isArray(viewer.wsLiked) && viewer.wsLiked.includes(stage.code))
      || (Array.isArray(stage.likedBy) && stage.likedBy.includes(viewer.id))
    ),
    mine,
  };
  // 英語のステージ名。プレイヤーの投稿には無い欄なので、持っているものだけ出す
  // （画面側 normalizeWorkshopStage は nameEn/titleEn を見て英語表示に使う）。
  if (stage.titleEn) out.titleEn = String(stage.titleEn);
  if (opts.board) out.board = stage.board;
  if (opts.board) out.targets = stage.board.reduce((a, v, i) => (v !== 0 ? (a.push(i), a) : a), []);
  if (mine || (viewer && viewer.role === 'admin')) out.solution = stage.solution;
  return out;
}

// 作者へのプレイ還元。額はサーバーが決める（クライアントは申告できない）。
// 1日の上限を必ず通すので、自作ステージを回し続けてもコインは無限に湧かない。
function workshopPayoutDay(w) {
  const today = jstDayKey();
  if (!w.payout || w.payout.day !== today || !w.payout.by || typeof w.payout.by !== 'object') {
    w.payout = { day: today, by: {} };
  }
  return w.payout;
}
function payWorkshopAuthor(w, stage) {
  const author = db.users[stage.by];
  if (!author || author.banned) return 0;
  const p = workshopPayoutDay(w);
  const got = Number(p.by[stage.by]) || 0;
  const coins = Math.min(WS_PLAY_COINS, Math.max(0, WS_AUTHOR_COIN_DAY_CAP - got));
  if (coins <= 0) return 0;
  p.by[stage.by] = got + coins;
  author.coins = (author.coins || 0) + coins;
  return coins;
}

// 投稿。作者のクリアリプレイを再生して、本当に解けるものだけ通す。
workshopRouter.post('/api/workshop/stages', requireAuth, maintenanceGuard, (req, res) => {
  // ミュート中は公開テキスト（ステージ名）を新たに出せない。requireAuth は
  // banned しか見ないので、ここで muted を弾く（play / like / delete は
  // 表に出る文字を伴わないので対象外）。HTTP は ws と違い errorEn を同梱する。
  if (req.user.muted) {
    return res.status(403).json({ error: '🔇 管理者により投稿が制限されています', errorEn: 'Publishing is restricted by an admin' });
  }
  // 入口の門は「乱打を止める」ぶんだけ。ここを 5回/時 の公開枠にしていたころは、
  // 盤面やリプレイの形式ミスで 400 になった回も枠を食い、数分かけて作った
  // ステージが「投稿が多すぎます」で1時間はねられた。公開枠（wspost）は
  // 検証を全部通って **実際に書き込む直前** で消費する。
  if (!rateLimit(`wspostip:${req.ip}`, 20, 60 * 60 * 1000)
      || !rateLimit(`wspostry:${req.user.id}`, 40, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '投稿が多すぎます。時間をおいてください', errorEn: 'Too many submissions — please try again later' });
  }
  const b = req.body || {};
  const title = sanitizeWorkshopTitle(b.title);
  if (Array.from(title).length < 2) {
    return res.status(400).json({ error: `ステージ名は2〜${WS_TITLE_MAX}文字で入力してください`, errorEn: `The stage name must be 2–${WS_TITLE_MAX} characters` });
  }
  const parsed = parseWorkshopBoard(b.board);
  if (!parsed) {
    return res.status(400).json({ error: `盤面が不正です（8×8・光るマスは${WS_MIN_CELLS}個以上）`, errorEn: `Invalid board (8×8, at least ${WS_MIN_CELLS} glowing cells)` });
  }
  if (boardHasFullLine(parsed.board)) {
    return res.status(400).json({
      error: '最初から揃っている行・列がある盤面は投稿できません（置く前に消えてしまいます）',
      errorEn: 'A board that already has a completed row or column cannot be published — it would clear before you place anything',
    });
  }
  const pieces = parseWorkshopPieces(b.pieces);
  if (!pieces) {
    return res.status(400).json({ error: `ピースは1〜${WS_MAX_PIECES}個で指定してください`, errorEn: `Provide 1–${WS_MAX_PIECES} pieces` });
  }
  const rep = sanitizeReplay(b.replay, { seed: 0 });
  if (!rep || rep.moves.length > pieces.length) {
    return res.status(400).json({ error: 'クリアの記録が読めません。もう一度自分でクリアしてから投稿してください', errorEn: 'That clear record is unreadable — clear the stage yourself once more, then submit' });
  }
  // ここが工房の要。作者の着手をサーバーで再生して、本当にクリアできるか見る。
  const verdict = verifyWorkshopClear(parsed.board, pieces, rep.moves);
  if (!verdict.ok) {
    return res.status(400).json({
      error: 'そのステージはサーバー側で再生してもクリアできませんでした（解けるステージだけ投稿できます）',
      errorEn: 'Replaying your clear on the server did not solve the stage — only solvable stages can be published',
      reason: verdict.reason,
    });
  }
  const w = ensureWorkshop();
  const stages = w.stages;
  const mine = Object.values(stages).filter(s => s && s.by === req.user.id);
  // 応答だけが落ちた投稿の押し直しで、同じステージが2件公開されるのを防ぐ。
  // 直近 WS_DUP_MS 以内の自分の投稿に「題名・盤面・ピース列がまったく同じ」
  // ものがあれば、新しく作らずそのコードを返す ── /api/collection/claim や ♡ と
  // 同じ「再送しても壊れない」形。上限の判定より前に置くのが要点で、枠が
  // 埋まった状態で押し直しても 409 ではなく元のコードが返る。
  const now = Date.now();
  const same = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]);
  const dup = mine.find(s => s.title === title
    && (now - (Number(s.at) || 0)) <= WS_DUP_MS
    && same(s.pieces, pieces) && same(s.board, parsed.board));
  if (dup) {
    return res.json({ ok: true, code: dup.code, duplicate: true, stage: workshopView(dup, req.user, { board: true }) });
  }
  if (mine.length >= WS_MAX_PER_USER) {
    return res.status(409).json({ error: `投稿できるのは1人${WS_MAX_PER_USER}ステージまでです。古いものを削除してください`, errorEn: `You can publish up to ${WS_MAX_PER_USER} stages — delete an old one first` });
  }
  if (Object.keys(stages).length >= WS_MAX_STAGES) {
    return res.status(503).json({ error: '工房がいっぱいです。しばらくしてからお試しください', errorEn: 'The workshop is full — please try again later' });
  }
  const code = makeWorkshopCode(stages);
  if (!code) return res.status(503).json({ error: '共有コードを発行できませんでした。もう一度お試しください', errorEn: 'Could not mint a share code — please try again' });
  // 公開枠はここで消費する（＝実際に1件増えるときだけ数える）。
  if (!rateLimit(`wspost:${req.user.id}`, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '投稿が多すぎます。時間をおいてください', errorEn: 'Too many submissions — please try again later' });
  }
  stages[code] = {
    code,
    title,
    by: req.user.id,
    byName: req.user.username,   // 退会後の表示用フォールバック（普段は db から引く）
    at: Date.now(),
    board: parsed.board,
    pieces,
    solution: rep.moves,         // 作者の模範解答（再検証にも使える）
    par: verdict.moves,          // 作者が使った手数
    score: verdict.score,        // 作者の解答スコア
    plays: 0,
    likes: 0,
    likedBy: [],
  };
  // 作った側の進行。実績（achievements.js）はこの統計から導出する。
  const st = req.user.stats || (req.user.stats = {});
  st.wsPublished = (Number(st.wsPublished) || 0) + 1;
  saveDb();
  res.json({ ok: true, code, stage: workshopView(stages[code], req.user, { board: true }) });
});

// 一覧。人気順（いいね→プレイ数）か新着順。ログイン不要で読める。
// limit / offset でページ送りできる ── 以前は常に先頭30件だけを返していたので、
// 31件目以降に沈んだステージは6文字の共有コードを知っている人以外どこからも
// 到達できなかった（自分の作品も、運営が消したい作品も）。
workshopRouter.get('/api/workshop/stages', (req, res) => {
  if (!rateLimit(`wslist:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const sort = req.query.sort === 'new' ? 'new' : req.query.sort === 'mine' ? 'mine' : 'popular';
  const rawLimit = Math.floor(Number(req.query.limit));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, WS_LIST_HARD_MAX) : WS_LIST_MAX;
  const rawOffset = Math.floor(Number(req.query.offset));
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, WS_MAX_STAGES) : 0;
  let rows = Object.values(workshopStages()).filter(Boolean);
  // 凍結中の人の作品は公開面に出さない（管理者には見えたままにする）。
  if (!isAdminViewer(req.user)) rows = rows.filter(s => !stageHidden(s));
  if (sort === 'mine') rows = req.user ? rows.filter(s => s.by === req.user.id) : [];
  rows.sort((a, b) => sort === 'new' || sort === 'mine'
    ? (b.at || 0) - (a.at || 0)
    : ((b.likes || 0) - (a.likes || 0)) || ((b.plays || 0) - (a.plays || 0)) || ((b.at || 0) - (a.at || 0)));
  const page = rows.slice(offset, offset + limit);
  res.json({
    sort,
    total: Object.keys(workshopStages()).length,
    matched: rows.length,                        // この並び順で見えている総数（ページ送りの終点）
    offset,
    limit,
    more: offset + page.length < rows.length,
    stages: page.map(s => workshopView(s, req.user)),
    limits: { perUser: WS_MAX_PER_USER, total: WS_MAX_STAGES, pieces: WS_MAX_PIECES },
  });
});

// 管理者用の全件一覧。公開一覧はページ送りが要るので、通報を受けて「今どんな
// ものが公開されているか」を棚卸しする用に、新着順で丸ごと返す口を1本置く。
// 盤面も模範解答も返さない（消すのに要るのはコードと見出しだけ）。
workshopRouter.get('/api/admin/workshop/stages', requireAuth, requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = Object.values(workshopStages()).filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .map(s => {
      const author = db.users[s.by];
      return {
        code: s.code,
        title: s.title,
        titleEn: s.titleEn || null,
        author: author ? author.username : s.byName,
        by: s.by,
        at: s.at || 0,
        plays: s.plays || 0,
        likes: s.likes || 0,
        par: s.par || 0,
        seed: !!s.seed,
        banned: !!(author && author.banned),      // 凍結中＝公開面からは既に隠れている
        orphan: !author,                          // 退会・削除済み（byName だけが残っている）
      };
    })
    .filter(r => !q || r.code.toLowerCase().includes(q)
      || String(r.title || '').toLowerCase().includes(q)
      || String(r.author || '').toLowerCase().includes(q));
  res.json({ total: rows.length, stages: rows });
});

// 1ステージの取得（遊ぶのに必要な盤面・ピース列つき）。
workshopRouter.get('/api/workshop/stages/:code', (req, res) => {
  if (!rateLimit(`wsget:${req.ip}`, 120, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const stage = findWorkshopStage(req.params.code);
  if (!stage || (stageHidden(stage) && !isAdminViewer(req.user))) {
    return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  }
  res.json({ stage: workshopView(stage, req.user, { board: true }) });
});

// プレイ数の記録と、作者へのコイン還元。額も上限もサーバーが決める。
workshopRouter.post('/api/workshop/stages/:code/play', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`wsplay:${req.user.id}`, 60, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます。しばらく待ってください', errorEn: 'Too many requests — please wait a moment' });
  }
  const stage = findWorkshopStage(req.params.code);
  if (!stage || (stageHidden(stage) && !isAdminViewer(req.user))) {
    return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  }
  // 数えるのは「作者本人以外」かつ「同じ人が同じステージで1時間に1回まで」。
  // 還元コインだけでなく **プレイ数そのもの** をこの門に通す ── 人気順は
  // ♡が同数なら plays で決まるので、遊ばずに叩くだけで自作を上位へ押し上げ
  // られてしまう。「もう一度」で数が増え続けるのも同じ門で止まる。
  const counted = stage.by !== req.user.id && rateLimit(`wspay:${req.user.id}:${stage.code}`, 1, 60 * 60 * 1000);
  let authorCoins = 0;
  if (counted) {
    stage.plays = (stage.plays || 0) + 1;
    const author = db.users[stage.by];
    if (author && !author.banned) {
      const st = author.stats || (author.stats = {});
      st.wsPlaysGot = (Number(st.wsPlaysGot) || 0) + 1;   // 作った側の進行（実績の材料）
    }
    authorCoins = payWorkshopAuthor(ensureWorkshop(), stage);
    saveDb();
  }
  res.json({ ok: true, plays: stage.plays || 0, counted, authorCoins });
});

// いいね。1人1回（取り消しは無し）。
workshopRouter.post('/api/workshop/stages/:code/like', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`wslike:${req.user.id}`, 30, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます。しばらく待ってください', errorEn: 'Too many requests — please wait a moment' });
  }
  const stage = findWorkshopStage(req.params.code);
  if (!stage || (stageHidden(stage) && !isAdminViewer(req.user))) {
    return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  }
  // 二重♡防止はユーザー側で覚える（6文字コードを上限つきで持つ）。以前は
  // ステージが「♡した人」の UUID を最大3000件ずつ抱えていて、ステージ数×
  // ユーザー数で db.json が数十MBまで伸びうる形だった。印をユーザー側へ移し、
  // ステージは likes カウンタだけを持つ（O(ユーザー数×ステージ数)→O(ユーザー数)）。
  // 移行前に stage.likedBy へ積まれた既存の♡もそのまま「済み」として扱う。
  const liker = req.user;
  if (!Array.isArray(liker.wsLiked)) liker.wsLiked = [];
  const already = liker.wsLiked.includes(stage.code)
    || (Array.isArray(stage.likedBy) && stage.likedBy.includes(liker.id));
  if (already) {
    return res.status(409).json({ error: 'すでに♡を送っています', errorEn: 'You already liked this stage', likes: stage.likes || 0, liked: true });
  }
  if ((stage.likes || 0) >= WS_LIKE_MAX) {
    return res.status(409).json({ error: '♡の受付は上限に達しました', errorEn: 'This stage has reached its like limit', likes: stage.likes || 0, liked: false });
  }
  liker.wsLiked.push(stage.code);
  // 覚えておく上限。古いものからこぼす（ずっと積み増して db を太らせない）。
  if (liker.wsLiked.length > WS_USER_LIKED_MAX) {
    liker.wsLiked.splice(0, liker.wsLiked.length - WS_USER_LIKED_MAX);
  }
  stage.likes = (stage.likes || 0) + 1;
  const author = db.users[stage.by];
  if (author && author.id !== req.user.id && !author.banned) {
    const st = author.stats || (author.stats = {});
    st.wsLikesGot = (Number(st.wsLikesGot) || 0) + 1;     // 作った側の進行（実績の材料）
  }
  saveDb();
  res.json({ ok: true, likes: stage.likes, liked: true });
});

// 🚩 通報。UGC で最初に要るのは「見つけた人が知らせる口」なので、パーティー
// 通報（routes/social.js の /api/party/report）と同じ形をそのまま使う ──
// 新しい入れ物は作らず、既存の db.bugreports に kind:'workshop' で落とす。
// 復元（backup.js）も管理画面の🐛モーダルもそのまま読める。
// ステージのコード・題名・作者を運営側で付ける（本人の申告に頼らない）。
workshopRouter.post('/api/workshop/stages/:code/report', requireAuth, (req, res) => {
  if (!rateLimit(`wsreport:${req.user.id}`, 3, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '通報が多すぎます。すこし待ってください', errorEn: 'Too many reports — please wait a little' });
  }
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  const author = db.users[stage.by];
  db.bugreports = db.bugreports || [];
  db.bugreports.push({
    id: crypto.randomUUID(), kind: 'workshop', at: Date.now(),
    by: req.user.username, byId: req.user.id,
    text: String((req.body || {}).reason || '').slice(0, 300),
    stage: {
      code: stage.code,
      title: stage.title,
      author: author ? author.username : stage.byName,
      by: stage.by,
    },
    status: 'open',
  });
  // 上限の詰め方はバグ報告・パーティー通報と同じ（捨てるのは処理済みだけ）。
  if (db.bugreports.length > (BUGREPORT_CAP || 300)) {
    const doneIdx = db.bugreports.findIndex(x => x && x.status === 'done');
    if (doneIdx !== -1) {
      db.bugreports.splice(doneIdx, 1);
    } else {
      db.bugreports.pop();
      return res.status(503).json({ error: '報告箱がいっぱいです。少し時間をおいてからお願いします', errorEn: 'The report box is full — please try again later' });
    }
  }
  saveDb();
  res.json({ ok: true });
});

// 削除は作者本人と管理者だけ。1人10ステージの上限に当たった人が、
// 作り直せずに詰むのを防ぐ。
workshopRouter.delete('/api/workshop/stages/:code', requireAuth, (req, res) => {
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  if (stage.by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '自分が投稿したステージだけ削除できます', errorEn: 'You can only delete stages you published' });
  }
  delete ensureWorkshop().stages[stage.code];
  saveDb();
  // 他人の作品を消したときは誰がやったかを残す（🧾管理者操作の記録）。
  // 自分の作品の消し直しは日常の操作なので記録しない。
  if (stage.by !== req.user.id && typeof adminLog === 'function') {
    adminLog(req, 'workshop_delete', stage.code, { title: stage.title, by: stage.byName || stage.by });
  }
  res.json({ ok: true, code: stage.code });
});
