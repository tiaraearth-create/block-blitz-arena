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

// 🎭 お題（dailyModifierOf）の ghost は「住人のその日のスコア係数」── 完全に
// サーバー内部の数字で、画面は id / icon / ja / en / descJa / descEn / target しか
// 見ていない。フィールド名がそのまま「AIの成績をこちらで作っています」と
// 言っているので、配る形からは落とす（関門も落とすが、最初から出さない）。
const publicModifier = mod => { if (!mod) return mod; const { ghost, ...rest } = mod; return rest; };

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
    modifier: publicModifier(dailyModifierOf(day)),
    target: dailyTargetOf(day),
    endsAt: nextJstMidnight(),
    played: !!today,
    score: today ? today.score : null,
    cleared: today ? !!today.cleared : false,
    // 🔥 走っている最中に「連続クリア」を0にして見せない。
    //
    //    /api/daily/start は予約を `streak: 0` で作る（結果が出るまで確定
    //    しないため）ので、ここが素直に today.streak を返すと、**挑戦する**を
    //    押した瞬間に「連続クリア12日」が画面から消えていた。本当の日数は
    //    prevStreak に退避されていて失われていないのに、いちばん途切れさせたく
    //    ない数字が「もう失った」と読める。まだ結果の出ていない予約なら、
    //    退避してあるほうを返す（クリアすれば +1 されて確定する）。
    streak: today
      ? (today.pending && !today.cleared ? (today.prevStreak || 0) : today.streak)
      : (d && d.day === jstDayKey(Date.now() - 86400000) && d.cleared ? d.streak : 0),
    // 走行中かどうか。画面は「（挑戦中）」と添えて、伸びるのかリセットされるのか
    // を伝えられる。
    inProgress: !!(today && today.pending && !today.cleared),
    bestStreak: (req.user && req.user.stats.dailycBestStreak) || 0,
  });
});

// 📅 挑戦の開始登録。ここで今日の1回を消費し、attemptId を発行する。
// 完走の提出はこの attemptId を添えたものだけがスコアを確定できるので、
// 「提出前にリロードして同じシードを何度でもやり直す」抜け道が消える —
// 開始した瞬間に、その日は（放棄すれば0点のまま）挑戦済みになる。
// 再送は冪等: 同じ attemptId を添えて呼び直すと同じ予約が返る（下を参照）。
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
  // 冪等キー。クライアントが控えている attemptId を添えて再送すると、同じ
  // 予約をそのまま返す ── 応答だけがネットワークで落ちた1タップで、その日の
  // 挑戦が0点のまま焼けてしまうのを防ぐ。id が一致しないときは従来どおり
  // practice なので、「提出前にリロードして引き直す」抜け道は塞がったまま
  // （新しい予約は作らないし、既存の pending も教えない）。
  const claimedAttempt = String((req.body || {}).attemptId || '').slice(0, 64);
  const resumeId = /^[0-9A-Za-z_-]{8,64}$/.test(claimedAttempt) ? claimedAttempt : '';
  if (s.dailyc && s.dailyc.day === today) {
    if (resumeId && s.dailyc.pending && s.dailyc.pending === resumeId) {
      return res.json({ ok: true, practice: false, day: today, attemptId: s.dailyc.pending, resumed: true, startedAt: s.dailyc.at || 0 });
    }
    // なぜ今日はもう練習なのかを画面に出せるように、理由を日英で添える。
    return res.json({
      ok: true, practice: true, day: today,
      reason: 'already-started',
      note: 'きょうの挑戦はすでに開始済みです（記録に残るのは最初の1回だけ）',
      noteEn: 'You already started today’s challenge — only the first run is recorded',
      startedAt: s.dailyc.at || 0,
    });
  }
  // 昨日ぶんのストリークは、pending を作る時点で控えておく（上書きで消えるので）。
  const yst = jstDayKey(Date.now() - 86400000);
  const prevStreak = s.dailyc && s.dailyc.day === yst && s.dailyc.cleared ? (s.dailyc.streak || 0) : 0;
  const pending = resumeId || crypto.randomUUID();
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
// 🪨 瓦礫の初期配置を「その日の seed で全員同じ」に直した時刻（2026-09-04 JST）。
//    これより前に録った瓦礫の日の録画は、いまの盤面と食い違うので出さない。
//    録画の保持は2日ぶん（DAILY_REPLAY_DAYS）なので、この歯止めはすぐ空振りになる。
const RUBBLE_DETERMINISTIC_AT = Date.parse('2026-09-04T00:00:00+09:00');
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
    // 🔁 引き直し（リロール）の印。**着手と同じ列に混ぜて順番を保つ。**
    //    デイリーは1回だけ引き直せる（engine.rerolls = 1）のに、録画は置いた手
    //    しか残していなかった。引き直すと以降の手札が丸ごとズレるので、
    //    再生側は同じ枠番号（h）から**違うピース**を取り出す ── しかも
    //    たいてい置けてしまうので、途中で止まらずに最後まで進み、
    //    「本人の記録とは違う盤面・違う点数の走り」が本人の名前で流れていた
    //    （残像レースも同じ録画を使うので、存在しない相手と競っていた）。
    const tt = Math.floor(Number(m.t));
    const at = Number.isFinite(tt) ? Math.max(0, Math.min(REPLAY_MAX_MS, tt)) : 0;
    if (m.rr) { moves.push({ rr: 1, t: at }); continue; }
    const h = Math.floor(Number(m.h));
    const r = Math.floor(Number(m.r));
    const c = Math.floor(Number(m.c));
    if (!(h >= 0 && h <= 2)) return null;
    if (!(r >= 0 && r < SIZE) || !(c >= 0 && c < SIZE)) return null;
    moves.push({ h, r, c, t: at });
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

// 退会・管理者削除の後始末。控えの name は「db から引けないとき」の
// フォールバックなので、レコードを消しただけだと退会した人の表示名が
// /api/daily/replays（ログイン不要で読める）に残り続ける。両方の削除経路が
// ここを呼んで、その人のゴーストごと落とす。戻り値は消した行数。
export function purgeUserDailyReplays(userId) {
  const id = String(userId || '');
  const store = id ? dailyReplayStore() : null;
  if (!store) return 0;
  let removed = 0;
  for (const day of Object.keys(store)) {
    const rows = store[day];
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter(r => !r || r.uid !== id);
    if (kept.length !== rows.length) {
      removed += rows.length - kept.length;
      store[day] = kept;
    }
  }
  return removed;
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

// ?day= の受け取り。形（YYYY-MM-DD）だけを見ていたので 9999-99-99 のような
// 暦に無い日付でも「その日の設計図」を決定的に作って配ってしまっていた。
// 見るのは3つ:
//   1. 形       … 従来どおり
//   2. 実在する日か … `new Date('2026-02-31T00:00:00+09:00')` は Invalid Date。
//                    念のため JST の日付キーへ戻して一致も確かめる
//   3. 今日か昨日か … リプレイの保持期間（DAILY_REPLAY_DAYS）と同じ窓。
//                    未来の設計図を先に配らないための歯止め
// どれかを外れたら従来の挙動どおり「今日」に落とす（400 は返さない ──
// 既存クライアントは今日か昨日しか渡さないので、壊す側の変更にしない）。
function requestedDay(raw) {
  const today = jstDayKey();
  const q = String(raw || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q)) return today;
  const ts = Date.parse(`${q}T00:00:00+09:00`);
  if (!Number.isFinite(ts)) return today;
  if (jstDayKey(ts) !== q) return today;
  for (let i = 0; i < DAILY_REPLAY_DAYS; i++) {
    if (jstDayKey(Date.now() - i * 86400000) === q) return q;
  }
  return today;
}

// 🏗 その日のブループリント（設計図）。全員が同じ図柄を解くので、日付から
// 決定的に生成したものをそのまま配る。模範解答 at はクライアントが使わない
// ので落として送る ── 送ると「今日の答え」がそのまま見えてしまう。
dailyReplayRouter.get('/api/daily/blueprint', (req, res) => {
  if (!rateLimit(`dbp:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const day = requestedDay(req.query.day);
  const bp = blueprintFor(day);
  if (!bp) return res.status(404).json({ error: 'きょうの設計図がありません', errorEn: 'No blueprint for today' });
  res.json({ ...bp, pieces: bp.pieces.map(({ at, ...p }) => p) });
});

// 📅 その日のTOP3のリプレイ（本人の分も一緒に返す）。ログイン不要で読める
// 公開データなので、他の公開読み取りと同じIPレート制限をかける。
dailyReplayRouter.get('/api/daily/replays', (req, res) => {
  if (!rateLimit(`drep:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const day = requestedDay(req.query.day);
  const store = dailyReplayStore();
  const all = store && Array.isArray(store[day]) ? store[day] : [];
  // 🪨 瓦礫の日の「古い録画」は出さない。
  //
  // 以前は瓦礫の初期配置が Math.random() で、ひとりずつ違った（＝録画を
  // 再生しても盤面が合わない）。いまは その日の seed から決めるので全員同じ
  // だが、直し**より前**に録った行だけは、その日の配置と食い違う。
  // 保存済みの `at` で見分けて落とす（保持は2日ぶんなので、この歯止めは
  // 自然に空振りになる）。
  const rubble = dailyModifierOf(day).id === 'rubble';
  const fresh = all.filter(r => !rubble || (r && r.at >= RUBBLE_DETERMINISTIC_AT));
  const sorted = fresh.slice().sort((a, b) => (b.score - a.score) || (a.at - b.at));
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
    modifier: publicModifier(dailyModifierOf(day)),
    rows,
    mine,
    max: DAILY_REPLAY_TOP,
  });
});
