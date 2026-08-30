// 🗓 ウィークリーチャレンジ／📅 デイリーチャレンジ／🎞 リプレイと🏗ブループリント。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
//
// ⚠ 名前が2つだけ逆向きに出ていく:
//   captureDailyReplay … /api/game/result（index.js に残る）が呼ぶ
//   sanitizeReplay     … 🛠パズル工房も同じ削り落としを使う。index.js が
//                        受け取って ctx に載せ、工房はそこから読む
//                        （routes 同士を直接つながないため）
import express from 'express';
import crypto from 'crypto';
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
  DAILY_PIECES, dailySeed, dailyModifierOf, dailyTargetOf, nextJstMidnight, blueprintFor,
} from '../daily.js';
import {
  SIZE,
} from '../../public/js/engine.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, migrateUser, applyGameResult, rateLimit, WEEK_MS, WEEKLY_PIECES, currentWeekNum, weekIdOf, weeklySeed, finalizeWeeklyRankings;
export function initDailyRoutes() {
  ({ db, migrateUser, applyGameResult, rateLimit, WEEK_MS, WEEKLY_PIECES, currentWeekNum, weekIdOf, weeklySeed, finalizeWeeklyRankings } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const weeklyDailyRouter = express.Router();
export const dailyReplayRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------

weeklyDailyRouter.get('/api/weekly', (req, res) => {
  finalizeWeeklyRankings();
  const n = currentWeekNum();
  const week = weekIdOf(n);
  const w = req.user && req.user.stats.weekly;
  res.json({
    week,
    seed: weeklySeed(week),
    pieces: WEEKLY_PIECES,
    endsAt: (n + 1) * WEEK_MS + 4 * 24 * 60 * 60 * 1000,
    best: w && w.week === week ? w.best : 0,
  });
});

// ---------------------------------------------------------------------------
// 📅 デイリーチャレンジ — 毎日変わるお題つき1発勝負
//
// ウィークリーと同じ「シード共有」方式: 全員が同じ盤面・同じピース順で戦う。
// 違いは (1) 記録されるのはその日の最初の1回だけ（以降は練習扱い）、
// (2) 日替わりのルール修飾（お題）が付く、(3) 目標スコアを越えると「クリア」で
// 連続クリア日数に応じたボーナス（ログインボーナスと同じ ×3 上限の倍率）。
// 週ではなくJST日（jstDayKey）で回る。ランキングもその日限り。
// ---------------------------------------------------------------------------

weeklyDailyRouter.get('/api/daily', (req, res) => {
  const day = jstDayKey();
  const d = req.user && req.user.stats.dailyc;
  const today = d && d.day === day ? d : null;
  res.json({
    day,
    seed: dailySeed(day),
    pieces: DAILY_PIECES,
    modifier: dailyModifierOf(day),
    target: dailyTargetOf(day),
    endsAt: nextJstMidnight(),
    played: !!today,
    score: today ? today.score : null,
    cleared: today ? !!today.cleared : false,
    streak: today ? today.streak : (d && d.day === jstDayKey(Date.now() - 86400000) && d.cleared ? d.streak : 0),
    bestStreak: (req.user && req.user.stats.dailycBestStreak) || 0,
  });
});

// 📅 挑戦の開始登録。ここで今日の1回を消費し、attemptId を発行する。
// 完走の提出はこの attemptId を添えたものだけがスコアを確定できるので、
// 「提出前にリロードして同じシードを何度でもやり直す」抜け道が消える —
// 開始した瞬間に、その日は（放棄すれば0点のまま）挑戦済みになる。
weeklyDailyRouter.post('/api/daily/start', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`dstart:${req.user.id}`, 10, 60 * 1000)) {
    return res.status(429).json({ error: '開始の連打はできません。少し待ってください' });
  }
  migrateUser(req.user);
  const today = jstDayKey();
  const claimed = String((req.body || {}).day || '');
  // 開いたまま日付を跨いだモーダルからの開始。古いシードで走らせても
  // 記録できないので、開き直してもらう。
  if (claimed && claimed !== today) return res.json({ ok: false, stale: true, day: today });
  const s = req.user.stats;
  if (s.dailyc && s.dailyc.day === today) {
    return res.json({ ok: true, practice: true, day: today });
  }
  // 昨日ぶんのストリークは、pending を作る時点で控えておく（上書きで消えるので）。
  const yst = jstDayKey(Date.now() - 86400000);
  const prevStreak = s.dailyc && s.dailyc.day === yst && s.dailyc.cleared ? (s.dailyc.streak || 0) : 0;
  const pending = crypto.randomUUID();
  s.dailyc = { day: today, score: 0, cleared: false, streak: 0, pending, prevStreak, at: Date.now() };
  saveDb();
  res.json({ ok: true, practice: false, day: today, attemptId: pending });
});

// ---------------------------------------------------------------------------
// 🎞 リプレイ — 着手ログだけでプレイを丸ごと再現する
//
// public/js/engine.js はシード決定的なので、「何手目に手札のどれを、どこへ
// 置いたか」さえ分かればその回は完全に再現できる。だから盤面のスナップショット
// は要らない: 1手 = { h:手札index, r:行, c:列, t:開始からのms } の4つの数字だけ。
// 30手でも 200バイト前後にしかならないので、その日のぶんを db に置いておける。
//
// これは 👻残像レース と 📅デイリーのゴーストリプレイの土台。
//
// ⚠ セキュリティ: リプレイはあくまで「再生用データ」で、スコアの検証には
// 使わない。壊れた・偽のリプレイが来ても捨てるだけで、その回のスコア・報酬・
// ストリークには一切影響しない（保存は applyGameResult の外・後段で行う）。
// 逆に「リプレイが無いと記録されない」ようにもしない ── 古いクライアントや
// 送信に失敗した端末の正当な1回を落としてしまう。
//
// db.meta 配下に置いているのは意図的: backup.js の復元は db.meta のキーを
// 「落とすキーの一覧」以外まるごと引き継ぐので、再デプロイでディスクが飛んでも
// 復元で戻ってくる。起動時に空で初期化しないのも同じ理由（live 側が先に値を
// 持っていると復元が採用しない）。実際に保存するときだけ作る。
// ---------------------------------------------------------------------------

const REPLAY_MAX_MOVES = 200;              // これを越える着手ログは丸ごと捨てる
const REPLAY_MAX_MS = 6 * 60 * 60 * 1000;  // t（経過ms）の頭打ち
const DAILY_REPLAY_TOP = 3;                // 公開するのはその日のTOP3
const DAILY_REPLAY_KEEP = 60;              // 1日ぶんに残す最大件数（TOP3＋本人分の控え）
const DAILY_REPLAY_DAYS = 2;               // 今日と昨日だけ。古い日は捨てる

// 外から来た着手ログを、保存してよい形に削り落とす。1つでも変な手が混ざって
// いたら null（＝保存しない）。score/seed は呼び出し元がサーバー側の値を渡す。
export function sanitizeReplay(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const src = Array.isArray(raw.moves) ? raw.moves : null;
  if (!src || !src.length) return null;
  if (src.length > REPLAY_MAX_MOVES) return null;
  const moves = [];
  for (const m of src) {
    if (!m || typeof m !== 'object') return null;
    const h = Math.floor(Number(m.h));
    const r = Math.floor(Number(m.r));
    const c = Math.floor(Number(m.c));
    if (!(h >= 0 && h <= 2)) return null;
    if (!(r >= 0 && r < SIZE) || !(c >= 0 && c < SIZE)) return null;
    const t = Math.floor(Number(m.t));
    moves.push({ h, r, c, t: Number.isFinite(t) ? Math.max(0, Math.min(REPLAY_MAX_MS, t)) : 0 });
  }
  const seed = Number.isFinite(Number(opts.seed)) ? Number(opts.seed) >>> 0
    : Number.isFinite(Number(raw.seed)) ? Number(raw.seed) >>> 0 : 0;
  const score = Number.isFinite(Number(opts.score)) ? Number(opts.score)
    : Number(raw.score) || 0;
  return {
    seed,
    moves,
    score: Math.max(0, Math.min(1_000_000, Math.floor(score) || 0)),
    at: Date.now(),
  };
}

// 保存済みの倉庫。まだ1件も保存していなければ null（作らない）。
function dailyReplayStore() {
  const m = db.meta.dailyReplays;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
}
function ensureDailyReplayStore() {
  if (!dailyReplayStore()) db.meta.dailyReplays = {};
  return db.meta.dailyReplays;
}

// 日替わりの掃除。今日と昨日以外の日はまるごと消す（メモリと db.json が
// 無限に育たないための唯一の歯止め）。
function pruneDailyReplayDays(store) {
  const keep = new Set();
  for (let i = 0; i < DAILY_REPLAY_DAYS; i++) keep.add(jstDayKey(Date.now() - i * 86400000));
  for (const k of Object.keys(store)) if (!keep.has(k)) delete store[k];
  return store;
}

// 1日ぶんの行を「TOP3は必ず残し、それ以外は新しいものから DAILY_REPLAY_KEEP 件まで」に絞る。
function pruneDailyReplayRows(rows) {
  const sorted = rows.slice().sort((a, b) => (b.score - a.score) || (a.at - b.at));
  if (sorted.length <= DAILY_REPLAY_KEEP) return sorted;
  const top = sorted.slice(0, DAILY_REPLAY_TOP);
  const rest = sorted.slice(DAILY_REPLAY_TOP)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, DAILY_REPLAY_KEEP - DAILY_REPLAY_TOP));
  return top.concat(rest).sort((a, b) => (b.score - a.score) || (a.at - b.at));
}

// 📅 デイリーの結果送信からリプレイを受け取る。記録された1回（reason:'recorded'）
// だけを保存する ── 練習の回まで貯めるとその日の行が無限に増えるうえ、
// ボードに載っていない点数のゴーストが並んでしまう。
// 戻り値は保存できたかどうか。false でもスコアには何の影響も無い。
export function captureDailyReplay(user, body, rewards) {
  const daily = rewards && rewards.daily;
  if (!daily || !daily.recorded) return false;
  const raw = body && body.replay;
  if (!raw) return false;
  const rec = user.stats && user.stats.dailyc;
  if (!rec || !rec.day) return false;
  // seed はクライアントの申告ではなくサーバーがその日から出した値で上書きする
  // （偽の seed を保存すると、再生したとき誰の画面でも盤面が合わない）。
  const rep = sanitizeReplay(raw, { seed: dailySeed(rec.day), score: rec.score });
  if (!rep) return false;
  const store = pruneDailyReplayDays(ensureDailyReplayStore());
  const prev = Array.isArray(store[rec.day]) ? store[rec.day] : [];
  const rows = prev.filter(r => r && r.uid !== user.id);   // 本人の古い回は置き換える
  rows.push({ uid: user.id, name: user.username, score: rep.score, at: rep.at, moves: rep.moves });
  store[rec.day] = pruneDailyReplayRows(rows);
  saveDb();
  return true;
}

// 保存した行 → 配信する形。名前は送るときに db から読む（改名しても古い名前で
// 出さないため。控えの name は退会済みアカウント用のフォールバック）。
function dailyReplayView(row, day, rank, viewerId) {
  const u = db.users[row.uid];
  return {
    rank,
    username: u ? u.username : row.name,
    score: row.score,
    at: row.at,
    you: !!viewerId && row.uid === viewerId,
    replay: { seed: dailySeed(day), moves: row.moves, score: row.score, at: row.at },
  };
}

// 🏗 その日のブループリント（設計図）。全員が同じ図柄を解くので、日付から
// 決定的に生成したものをそのまま配る。模範解答 at はクライアントが使わない
// ので落として送る ── 送ると「今日の答え」がそのまま見えてしまう。
dailyReplayRouter.get('/api/daily/blueprint', (req, res) => {
  if (!rateLimit(`dbp:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const q = String(req.query.day || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : jstDayKey();
  const bp = blueprintFor(day);
  if (!bp) return res.status(404).json({ error: 'きょうの設計図がありません', errorEn: 'No blueprint for today' });
  res.json({ ...bp, pieces: bp.pieces.map(({ at, ...p }) => p) });
});

// 📅 その日のTOP3のリプレイ（本人の分も一緒に返す）。ログイン不要で読める
// 公開データなので、他の公開読み取りと同じIPレート制限をかける。
dailyReplayRouter.get('/api/daily/replays', (req, res) => {
  if (!rateLimit(`drep:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const q = String(req.query.day || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : jstDayKey();
  const store = dailyReplayStore();
  const all = store && Array.isArray(store[day]) ? store[day] : [];
  const sorted = all.slice().sort((a, b) => (b.score - a.score) || (a.at - b.at));
  // BAN された人のゴーストは公開ボードに出さない（ランキングと同じ扱い）。
  const publicRows = sorted.filter(r => { const u = db.users[r.uid]; return !u || !u.banned; });
  const viewerId = req.user ? req.user.id : null;
  const rows = publicRows.slice(0, DAILY_REPLAY_TOP)
    .map((r, i) => dailyReplayView(r, day, i + 1, viewerId));
  let mine = null;
  if (viewerId) {
    const idx = sorted.findIndex(r => r.uid === viewerId);
    if (idx >= 0) mine = dailyReplayView(sorted[idx], day, idx + 1, viewerId);
  }
  res.json({
    day,
    seed: dailySeed(day),
    pieces: DAILY_PIECES,
    modifier: dailyModifierOf(day),
    rows,
    mine,
    max: DAILY_REPLAY_TOP,
  });
});
