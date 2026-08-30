// 🛠 パズル工房 — プレイヤーが作ったステージの投稿・配布・いいね・削除。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
import express from 'express';
import {
  saveDb,
} from '../db.js';
import {
  requireAuth,
} from '../auth.js';
import {
  jstDayKey,
} from '../adminevent.js';
import {
  Engine, SHAPES, SIZE,
} from '../../public/js/engine.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
// sanitizeReplay の実体は routes/daily.js にあるが、routes 同士を直接
// つながないため index.js がいったん受けて ctx に載せている。
let db, rateLimit, sanitizeReplay;
export function initWorkshopRoutes() {
  ({ db, rateLimit, sanitizeReplay } = ctx);
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
const WS_LIKE_MAX = 3000;              // 1ステージが覚えておく「いいねした人」の上限
const WS_PLAY_COINS = 5;               // 1プレイあたり作者に還元するコイン
const WS_AUTHOR_COIN_DAY_CAP = 300;    // 作者1人が1日に受け取れる還元の上限（60プレイぶん）
const WS_LIST_MAX = 30;

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
    liked: !!viewer && Array.isArray(stage.likedBy) && stage.likedBy.includes(viewer.id),
    mine,
  };
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
  if (!rateLimit(`wspost:${req.user.id}`, 5, 60 * 60 * 1000)
      || !rateLimit(`wspostip:${req.ip}`, 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '投稿が多すぎます。時間をおいてください', errorEn: 'Too many submissions — please try again later' });
  }
  const b = req.body || {};
  const title = String(b.title || '').trim().replace(/[<>"'`]/g, '').slice(0, WS_TITLE_MAX);
  if (title.length < 2) {
    return res.status(400).json({ error: `ステージ名は2〜${WS_TITLE_MAX}文字で入力してください`, errorEn: `The stage name must be 2–${WS_TITLE_MAX} characters` });
  }
  const parsed = parseWorkshopBoard(b.board);
  if (!parsed) {
    return res.status(400).json({ error: `盤面が不正です（8×8・光るマスは${WS_MIN_CELLS}個以上）`, errorEn: `Invalid board (8×8, at least ${WS_MIN_CELLS} glowing cells)` });
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
  if (mine.length >= WS_MAX_PER_USER) {
    return res.status(409).json({ error: `投稿できるのは1人${WS_MAX_PER_USER}ステージまでです。古いものを削除してください`, errorEn: `You can publish up to ${WS_MAX_PER_USER} stages — delete an old one first` });
  }
  if (Object.keys(stages).length >= WS_MAX_STAGES) {
    return res.status(503).json({ error: '工房がいっぱいです。しばらくしてからお試しください', errorEn: 'The workshop is full — please try again later' });
  }
  const code = makeWorkshopCode(stages);
  if (!code) return res.status(503).json({ error: '共有コードを発行できませんでした。もう一度お試しください', errorEn: 'Could not mint a share code — please try again' });
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
  saveDb();
  res.json({ ok: true, code, stage: workshopView(stages[code], req.user, { board: true }) });
});

// 一覧。人気順（いいね→プレイ数）か新着順。ログイン不要で読める。
workshopRouter.get('/api/workshop/stages', (req, res) => {
  if (!rateLimit(`wslist:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const sort = req.query.sort === 'new' ? 'new' : req.query.sort === 'mine' ? 'mine' : 'popular';
  let rows = Object.values(workshopStages()).filter(Boolean);
  if (sort === 'mine') rows = req.user ? rows.filter(s => s.by === req.user.id) : [];
  rows.sort((a, b) => sort === 'new' || sort === 'mine'
    ? (b.at || 0) - (a.at || 0)
    : ((b.likes || 0) - (a.likes || 0)) || ((b.plays || 0) - (a.plays || 0)) || ((b.at || 0) - (a.at || 0)));
  res.json({
    sort,
    total: Object.keys(workshopStages()).length,
    stages: rows.slice(0, WS_LIST_MAX).map(s => workshopView(s, req.user)),
    limits: { perUser: WS_MAX_PER_USER, total: WS_MAX_STAGES, pieces: WS_MAX_PIECES },
  });
});

// 1ステージの取得（遊ぶのに必要な盤面・ピース列つき）。
workshopRouter.get('/api/workshop/stages/:code', (req, res) => {
  if (!rateLimit(`wsget:${req.ip}`, 120, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  res.json({ stage: workshopView(stage, req.user, { board: true }) });
});

// プレイ数の記録と、作者へのコイン還元。額も上限もサーバーが決める。
workshopRouter.post('/api/workshop/stages/:code/play', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`wsplay:${req.user.id}`, 60, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます。しばらく待ってください', errorEn: 'Too many requests — please wait a moment' });
  }
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  stage.plays = (stage.plays || 0) + 1;
  // 還元は「作者本人以外」かつ「同じ人が同じステージで1時間に1回まで」。
  // 自作ステージを回し続けるだけのコイン増殖を、上限の前にここで止める。
  let authorCoins = 0;
  if (stage.by !== req.user.id && rateLimit(`wspay:${req.user.id}:${stage.code}`, 1, 60 * 60 * 1000)) {
    authorCoins = payWorkshopAuthor(ensureWorkshop(), stage);
  }
  saveDb();
  res.json({ ok: true, plays: stage.plays, authorCoins });
});

// いいね。1人1回（取り消しは無し）。
workshopRouter.post('/api/workshop/stages/:code/like', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`wslike:${req.user.id}`, 30, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます。しばらく待ってください', errorEn: 'Too many requests — please wait a moment' });
  }
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  if (!Array.isArray(stage.likedBy)) stage.likedBy = [];
  if (stage.likedBy.includes(req.user.id)) {
    return res.status(409).json({ error: 'すでに♡を送っています', errorEn: 'You already liked this stage', likes: stage.likes || 0, liked: true });
  }
  if (stage.likedBy.length >= WS_LIKE_MAX) {
    return res.status(409).json({ error: '♡の受付は上限に達しました', errorEn: 'This stage has reached its like limit', likes: stage.likes || 0, liked: false });
  }
  stage.likedBy.push(req.user.id);
  stage.likes = stage.likedBy.length;
  saveDb();
  res.json({ ok: true, likes: stage.likes, liked: true });
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
  res.json({ ok: true, code: stage.code });
});
