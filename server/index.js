// Block Blitz Arena — game server
// Express REST API (auth / leaderboard / shop / battle pass / admin) + WebSocket 1v1 battles.
import express from 'express';
import compression from 'compression';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';
import { fileURLToPath } from 'url';

import { loadDb, saveDb, flushDb, lastPersistError, DATA_DIR } from './db.js';
// 永続化の実測値（db.json のサイズ／直近保存の所要ms）は db.js 側のゲッターから
// 取る。名前付き import にすると「まだ生えていない」時点で ES モジュールの
// リンクが失敗してサーバーごと起動しなくなるので、名前空間で受けて実行時に
// 有無を見る。無ければその項目だけ出さない。
import * as dbModule from './db.js';
import { initBattle } from './battle.js';
import {
  hashPassword, verifyPassword, issueToken, revokeToken, revokeAllTokens,
  authMiddleware, requireAuth, requireAdmin, userFromToken, SESSIONS_PERSIST,
  sweepRevoked,
} from './auth.js';
import {
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED, BOOST_ITEMS,
  BP_TIERS, BP_XP_PER_TIER, BP_SEASON_DAYS,
  BOSSES, TITLES, earnedTitles,
} from './catalog.js';
import { trackMissions } from './missions.js';
import { ACHIEVEMENTS } from './achievements.js';
import {
  ghostRows, setLiveScale, getLiveScale, setCustom, getCustom, setWorldProvider, setTakenNamesProvider, crowdMood, ambientQueue, isQuietNow, residentByName, activeResidents, residentStats, archetype,
  boardResidents,
} from './ambient.js';
import { BADGE_NAMES } from './crowd.js';
import {
  leaveGuild, addGuildPoints, guildLevel, guildCoinBonus, tagOfName,
  ghostGuildOfResident, trackGuildQuests,
} from './guilds.js';
import { TRANSLATE_ENGINE, translateChat } from './translate.js';
// 住人の正体を隠す共通の関門（詳しい理由は server/sanitize.js の冒頭）。
import { secrecyMiddleware } from './sanitize.js';
import {
  validateBackup, applyRestore, snapshot, healGuildRosters,
} from './backup.js';
import {
  EVENT_TYPES, makeEvent, eventBonus,
  scheduledEventFor, nextScheduledEvent, makeScheduledEvent, calendarView,
} from './events.js';
import {
  ensureSocial, healSocial, unfriendAll, socialDefaults, friendsOvertaken,
} from './friends.js';
import {
  createPoll, eventPollOptions, vote as castVote, pollView, tickPoll, winnerOf, isOpen as pollOpen,
} from './polls.js';
import { jstDayKey } from './adminevent.js';
// 段位の帯（しきい値の唯一の正解）。migrateUser が「どこまで昇格を告知したか」の
// 初期値を作るのに使う。手書きの表を持たない ── server/battle.js と同じ理由。
import { bandOf } from '../public/js/ranks.js';
import {
  DAILYC_COINS, DAILYC_GEMS, DAILYC_MAX_SCORE, DAILYC_ATTEMPT_MS,
  dailyModifierOf, dailyTargetOf,
} from './daily.js';
// 🚚 ルート定義の引っ越し先。index.js は「起動と共通ヘルパー」に絞り、
// まとまりごとの API は routes/ に置く。共有依存は context.js 経由で渡すので、
// routes/ 側は index.js を import しない（＝循環参照しない）。
//
// ⚠ 各ルーターの `app.use(…)` は、元のルート定義があった場所にそのまま置いて
//    ある。Express はパスの照合を登録順にやるので、まとめて末尾に移すと
//    照合順序が変わる ── 位置は動かさないこと。並べ替えたくなったら、
//    先に「同じパスに当たるルートが他に無いか」を確かめること。
import { setContext } from './context.js';
import {
  initShopRoutes, purchaseRouter, shopRouter, throneShopRouter,
} from './routes/shop.js';
import { initMissionRoutes, missionsRouter } from './routes/missions.js';
import { initGuildRoutes, guildRouter, collectionRouter } from './routes/guild.js';
import { initSocialRoutes, socialRouter } from './routes/social.js';
// adminEventView は /api/status も使うので、こちらだけは routes → index の向きに
// 名前が戻る（ルーターの中身ではなく、画面に出す形を組み立てるだけの関数）。
import {
  initAdminEventRoutes, adminEventRouter, throneAdminRouter, adminEventView,
} from './routes/adminevent.js';
// captureDailyReplay は /api/game/result（この下に残っている）が呼ぶ。
// sanitizeReplay は🛠パズル工房も使うので、ここで受けて ctx に載せ直す
// （routes 同士を直接つながないため）。
import {
  initDailyRoutes, weeklyDailyRouter, dailyReplayRouter,
  captureDailyReplay, sanitizeReplay,
} from './routes/daily.js';
import { initWorkshopRoutes, workshopRouter } from './routes/workshop.js';
import { initAdminRoutes, adminRouter } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const db = loadDb();
setLiveScale(db.meta.popScale === undefined ? 1 : db.meta.popScale);
if (db.meta.ambient) setCustom(db.meta.ambient);

// 住人と実プレイヤーの同名を解消する（起動時に1回）。
//
// 名前の予約表は「これから登録・改名・名乗りする名前」を塞ぐだけなので、
// それより前に取られてしまった名前は db に残ったままになる。にぎわい倍率が
// 低いあいだは住人が64人しかいないため、r64〜r599 の名前は空いて見えた ──
// 管理者が倍率を上げた瞬間に同名の住人が湧き、
//   ・本人が言っていない発言が、その名前でロビーに流れる
//   ・タップすると本物のプレイヤーのプロフィールが出る＝なりすまし成立
//   ・username 一致で王冠まで付く
// という状態になる。人間のほうが先客なので、住人を退役させて譲る。
{
  const clash = [];
  for (const u of Object.values(db.users)) {
    const r = residentByName(u.username);
    if (r) clash.push(r);
  }
  if (clash.length) {
    const cur = getCustom();
    const removed = new Set(cur.removed);
    for (const r of clash) removed.add(r.id);
    setCustom({ ...cur, removed: [...removed] });
    db.meta.ambient = getCustom();
    saveDb();
    console.log(`[residents] 実プレイヤーと同名の住人${clash.length}人を退役させました: ${clash.map(r => r.name).join(', ')}`);
  }
}

// Heal guilds that account deletions already jammed. Until v2.11 a deleted
// account left its id in guild.members (counter stuck at 20/20, "ギルドは満員
// です" for every applicant) and, if it was the owner, in guild.ownerId — after
// which nothing could rename, re-open or kick. New deletions call leaveGuild;
// this repairs the damage that is sitting in the live db.json right now.
{
  let fixed = 0, disbanded = 0;
  for (const g of Object.values(db.guilds || {})) {
    const live = (g.members || []).filter(id => db.users[id]);
    if (live.length === (g.members || []).length) continue;
    g.members = live;
    fixed++;
    if (!live.length) { delete db.guilds[g.id]; disbanded++; continue; }
    if (!db.users[g.ownerId]) {
      g.ownerId = live.map(id => db.users[id])
        .sort((a, b) => (a.guildJoinedAt || 0) - (b.guildJoinedAt || 0))[0].id;
    }
  }
  if (fixed) console.log(`[guilds] 幽霊メンバーを掃除: ${fixed}件（解散 ${disbanded}件）`);
}

// A throw that escapes an async boundary used to take the process down AND
// discard everything the debounced writer had not flushed yet.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  try { flushDb(); } catch { /* nothing left to try */ }
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});
const app = express();
// trust proxy: 前段にLB/リバースプロキシがある構成(Render/Fly/Railway)では
// X-Forwarded-For 末尾を req.ip として採用するのが正しい。しかし前段プロキシの
// 無い直結公開(docker run -p 3000:3000 等)でこれを有効にすると、クライアントが
// XFF を自由に詐称して req.ip を偽装でき、IP依存のレート制限(認証総当たり防止・
// restore・bugreport)を丸ごと回避できる。既定は従来どおり1ホップ信頼(既存の
// 本番はLB前提)。プロキシ無しで直結公開する場合は TRUST_PROXY=0 を設定して
// XFF を無視させる。数値=ホップ数、'false'/'0'/'off'=無効、その他文字列は
// Express にそのまま渡す(サブネット指定 'loopback','10.0.0.0/8' 等)。
const _trustProxy = process.env.TRUST_PROXY;
const TRUST_PROXY = _trustProxy == null || _trustProxy === '' ? 1
  : /^(0|false|off|no)$/i.test(_trustProxy.trim()) ? false
  : /^\d+$/.test(_trustProxy.trim()) ? Number(_trustProxy.trim())
  : _trustProxy.trim();
app.set('trust proxy', TRUST_PROXY);

// WebSocket の接続元IP。Express の req.ip と同じ規則で解く。
//
// なぜ要るか: HTTP 側は上の trust proxy 設定のおかげで X-Forwarded-For から
// 本当のクライアントIPを取れていたが、WS のアップグレードは Express を通らず、
// battle.js が req.socket.remoteAddress を直に読んでいた。前段にLBがある本番
// (Render) では remoteAddress がプロキシの内部IPになるので、「同一IPあたり
// 12接続まで」の上限が“全プレイヤー合算”に効いてしまう。1人がチャット用と
// 対戦用で2本つなぐ設計なので、最悪プロキシIP1つあたり6人前後で新規プレイヤーが
// 「同時接続が多すぎます」で門前払いになる。ゲストのチャット制限キーも同じ IP
// なので、他人の発言まで巻き込んで止まる。
//
// proxy-addr は express の依存であって当プロジェクトの直接依存ではないので、
// ホップ数の解釈だけをここで実装する（Express と同じく、socket の相手を先頭に
// 置いた鎖の n 番目 = 信頼したホップ数ぶん遡った位置を採用する）。数値指定は
// これで Express の req.ip と完全に一致することを確認済み。
//
// サブネット指定('loopback','10.0.0.0/8' 等)の文字列は、鎖の各ホップが信頼集合に
// 入っているかを見ないと解けない ── そこだけ真似ると Express より**緩く**なり、
// 「信頼していない相手が付けた XFF を採用する」＝詐称が成立して、下の per-IP 上限も
// ゲストの連投制限も回避されてしまう。なので文字列指定のときは XFF を一切見ずに
// socket の相手を返す（Express より厳しい側に倒す）。厳しすぎて困る＝プロキシ背後で
// 壁が出る場合は、TRUST_PROXY をホップ数（数値）で指定すること。
function clientIpOf(req) {
  const raw = String((req && req.socket && req.socket.remoteAddress) || '?');
  if (TRUST_PROXY === false) return raw;          // 直結公開: XFF は詐称できるので見ない
  if (typeof TRUST_PROXY !== 'number') return raw; // サブネット指定は数値化できない
  const hops = TRUST_PROXY;
  if (hops <= 0) return raw;
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map(s => s.trim()).filter(Boolean).reverse();
  const chain = [raw, ...xff];
  return chain[Math.min(hops, chain.length - 1)] || raw;
}
app.use(compression());   // gzip — big win for overseas players on slow links
// Restore uploads a whole database dump, so it gets its own generous parser;
// every other route stays on the tight limit.
const jsonParser = express.json({
  limit: '64kb',
  // Keep the raw body for Stripe webhook signature verification.
  verify: (req, _res, buf) => { req.rawBody = buf; },
});
// 復元だけは本文が大きくなりうるので別枠。ただし 64MB は過大だった。
// この読み込みは認証より前に走るうえ、gzip の自動展開が効いていたので、
// 61KB のファイルが約63MB に膨らみ、20並列でメモリが 2.6GB まで伸びた
// （Render starter は 512MB）。実在しうる規模から充分離れた位置に下げ、
// 圧縮の自動展開も止める（正規の復元は素の JSON を送っている）。
// 実在する復元ファイルは実測で 61KB 前後。
//
// 4MB だったが、それは「この機体が育てるデータの大きさ」と噛み合っていなかった。
// 1人あたりの実測は 新規1,351B / 遊び込み2,403B / 全解放6,152B、ユーザー以外の
// 土台が約48KB なので、4MB に収まるのは 遊び込みで約1,700人。つまり
//   ・そこを越えると「自分で取ったバックアップを自分で戻せない」
//   ・書き出し側(routes/admin.js)は天井に収めるため中身を削り始める
// という壁に、1,700人という現実的な人数で当たる。しかも backup.js 側の
// MAX_RESTORE_USERS（当時20,000件）は最も軽い見積りでも27MBに相当するので、
// 「ユーザー数が多すぎます」という親切な案内は一度も出せなかった。
//
// そこで天井を 12MB（遊び込みで約5,000人ぶん）に上げ、件数の上限は
// backup.js 側でこの天井の内側に降ろした（あちらのコメント参照）。
// メモリは下の3枚の門で守る ── 特に同時実行数(RESTORE_MAX_INFLIGHT=2)と
// inflate:false が効いていて、以前 OOM を起こした「61KB の gzip が63MBに
// 展開されるのを20並列」は今は起こらない（12MB × 2本ぶんが最悪ケース）。
const RESTORE_LIMIT_MB = 12;
const restoreParser = express.json({ limit: `${RESTORE_LIMIT_MB}mb`, inflate: false });

// 大きい本文を読む前に立てる門。
//
// /api/admin/restore は requireAuth を通らない（＝誰でも到達できる）復旧経路で、
// しかもこのパーサは authMiddleware より前に走る。ハンドラの中にある
// rateLimit('restore:…') はパースが終わってからしか動かないので、本文の
// 読み込みそのものには何の歯止めにもなっていなかった。実測で、未認証のまま
// 12MB を20並列で投げると RSS が 510MB、40並列で 849MB まで伸びる
// （Render starter は 512MB＝OOMで強制終了。対戦中・プレイ中の記録が消える）。
//
// 門は3枚: ①Content-Length で読む前に落とす ②パース前のIPレート制限
// ③同時にパースする本数の上限。どれもメモリを確保する前に効く。
const RESTORE_MAX_BYTES = RESTORE_LIMIT_MB * 1024 * 1024;
const RESTORE_MAX_INFLIGHT = 2;
let restoreInflight = 0;
app.use((req, res, next) => {
  if (req.path !== '/api/admin/restore') return jsonParser(req, res, next);
  const len = Number(req.headers['content-length'] || 0);
  if (len > RESTORE_MAX_BYTES) {
    return res.status(413).json({ error: `ファイルが大きすぎます（最大${RESTORE_LIMIT_MB}MB）` });
  }
  if (!rateLimit(`restorebody:${req.ip}`, 5, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '復元の試行が多すぎます。しばらく待ってください' });
  }
  if (restoreInflight >= RESTORE_MAX_INFLIGHT) {
    return res.status(503).json({ error: '復元処理が混み合っています。少し待ってからやり直してください' });
  }
  restoreInflight++;
  let done = false;
  const release = () => { if (!done) { done = true; restoreInflight--; } };
  res.on('finish', release);
  res.on('close', release);
  restoreParser(req, res, (err) => { if (err) release(); next(err); });
});
// Body-parser failures must still answer JSON — the client shows `error`.
// 上限はルートによって違う（復元だけ別枠）ので、案内も実際の上限に合わせる。
// 以前はどのルートでも「最大12MB」と出ていて、64kb で弾かれた人に
// 10倍以上ずれた説明をしていた。
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    const isRestore = req.path === '/api/admin/restore';
    return res.status(413).json({
      error: isRestore ? `ファイルが大きすぎます（最大${RESTORE_LIMIT_MB}MB）` : 'データが大きすぎます（最大64KB）',
    });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSONとして読み取れませんでした' });
  return next(err);
});
// 🤝 フレンドの掃除。消えたアカウント、片側だけ残った関係、
// ブロックしている相手とのフレンド関係、期限切れの申請を落とす。
// 復元は「名前が同じレコード」を勝たせるとき id ごと差し替えるので、
// 相手側に残った古い id が宙に浮く。起動のたびに均す。
{
  const fixed = healSocial(db);
  const total = Object.values(fixed).reduce((a, b) => a + b, 0);
  if (total) {
    console.log(`[friends] 整理: フレンド${fixed.friends} 申請${fixed.requests} ブロック${fixed.blocked} 片側${fixed.oneWay} 断り${fixed.declines}`);
    saveDb();
  }
}

// 🖼 このゲームを外部サイトのページに埋め込ませたいときだけ、その相手を明示する。
//
// 既定は今までどおり「自分自身のページ以外には埋め込ませない」。ゲーム配信
// サイト（itch.io / CrazyGames 等）へ出すときだけ、そのサイトのオリジンを
// 空白区切りで FRAME_ANCESTORS に入れる:
//   FRAME_ANCESTORS="https://itch.io https://*.itch.io https://html-classic.itch.zone"
//
// 埋め込みを許すと、その相手のページの中でこのゲームが動く＝クリックジャッキング
// の余地が生まれる。だから「全部許す(*)」は受け付けず、必ず相手を名指しさせる。
// X-Frame-Options には複数オリジンを書く文法が無い（ALLOW-FROM は廃止済み）ので、
// 許可先を指定したときは CSP の frame-ancestors 一本に任せて XFO は落とす
// ── 両方出すと、古いブラウザが XFO を優先して結局埋め込めない。
// 許可先の形を厳密に見る。
//
// 以前は /^https?:\/\/[A-Za-z0-9.*\-:[\]]+$/ で通していたが、これは
// `https://*`（＝どのサイトからでも埋め込み可）も `https://*.*` も通した。
// しかも許可先を1つでも指定すると X-Frame-Options を落とす作りなので、
// 打ち間違い1つで「誰でも枠に入れられる」状態に開いてしまう。
//
// 通すのは「実在しうるホスト名」だけにする:
//   ・スキームは http/https のどちらか
//   ・ラベルは英数字とハイフン、最低2ラベル（example.com）
//   ・ワイルドカードは **先頭ラベル全体** のみ（*.itch.io は可、a*.com や
//     *.* や 裸の * は不可）── CSP の frame-ancestors もこの形しか解さない
//   ・末尾に :ポート を1つだけ許す
const HOST_OK = /^https?:\/\/(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:\d{1,5})?$/;
const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || '')
  .split(/\s+/).map(s => s.trim())
  .filter(s => {
    if (!s) return false;
    if (!HOST_OK.test(s)) {
      console.warn('[csp] FRAME_ANCESTORS の値を無視しました（ホスト名の形になっていません）:', s);
      return false;
    }
    return true;
  });
if (FRAME_ANCESTORS.length) {
  console.log('[csp] 外部サイトからの埋め込みを許可:', FRAME_ANCESTORS.join(' '));
}

app.use(authMiddleware);
// 🎭 住人（AIプレイヤー）の正体を隠す関門。authMiddleware の**直後**に置く
// （req.user が要る）。/api/admin/* は経路ごとバイパスするので管理者パネルの
// 名簿・投票の内訳・殿堂の顔ぶれは従来どおり。管理者本人のリクエストは
// どの経路でも素通し。
app.use(secrecyMiddleware(req => !!(req.user && req.user.role === 'admin')));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 埋め込み先を指定したときだけ XFO を外す（理由は FRAME_ANCESTORS の注記）。
  if (!FRAME_ANCESTORS.length) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // このゲームは外部のスクリプトも外部への通信も使っていない（フォントも
  // 画像も自前）。だから許可先を自分自身だけに絞れる。万一どこかに文字列を
  // 差し込まれても、外へ持ち出す先が無くなる。
  //
  // WebSocket の行き先は「このページと同じホスト」だけ。
  // 以前は ws: wss: とスキーマごと許していたが、それは
  // **どのホストでも良い** という意味なので、上の「外へ持ち出す先が無い」
  // という狙いが WebSocket だけ素通しになっていた。
  // Host ヘッダーは client が名乗るものなので、そのまま header に
  // 差し込まない ── ホスト名として妥当な字だけを通す。
  const rawHost = String(req.headers.host || '');
  const wsHost = /^[A-Za-z0-9.\-:[\]]{1,120}$/.test(rawHost) ? rawHost : '';
  const wsSrc = wsHost ? ` ws://${wsHost} wss://${wsHost}` : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // 🎬 YouTubeスタジオの録画は、ページ自身が組み立てた Blob の Worker で
    // 時計を回している（タブが隠れても止まらないタイマーが要るため）。
    // worker-src を書かないと script-src に落ちて blob: が弾かれ、
    // **録画が丸ごと動かなくなる**。実際にそうなっていた。
    // blob: の Worker はページで動いているコードしか作れないので、
    // 外部スクリプトを締め出すという CSP の目的は損なわない。
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",   // インラインstyle属性を多用しているため
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${wsSrc}`,
    `frame-ancestors 'self'${FRAME_ANCESTORS.length ? ' ' + FRAME_ANCESTORS.join(' ') : ''}`,
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  // HTTPS でしか繋がないよう憶えさせる（本番のみ。ローカルのhttpを壊さない）。
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
// ---------------------------------------------------------------------------
// 🗂 静的アセットのコンテンツハッシュ・キャッシュ
//
// これまで public/js は全部 no-cache だった（更新を即座に届けるため）。つまり
// 起動のたびに 30本以上のモジュールを毎回取り直す。ETag の 304 で本文は返らない
// にせよ、往復そのものは必ず走るので、海外や電波の悪い回線では体感で効く。
//
// 起動時に各ファイルの内容から版数を出し、import 指定子に `?v=<hash>` を付けた
// 変換済みソースをメモリに持つ。`?v` が現行の版数と一致するリクエストだけを
// immutable（1年）にし、それ以外は今までどおり no-cache に落ちる ── 版数が
// 変わった瞬間にURLも変わるので、古いものを掴んだままにはならない。
//
// 版数は「自分の中身」だけでは足りない。依存先だけが変わった場合に自分のURLが
// 変わらず、immutable で抱えた古い依存を読み続けてしまうため、依存の版数も
// 混ぜて畳み込む（深さぶん回せば収束する）。
//
// ASSET_HASH=0 で丸ごと無効化できる（変換に不具合が出たときの逃げ道）。
// 置換に失敗したファイルは元のソースをそのまま配る。壊れるくらいなら効かない
// ほうがよい。
// ---------------------------------------------------------------------------
const ASSET_HASH_ENABLED = process.env.ASSET_HASH !== '0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ASSET_JS_DIR = path.join(PUBLIC_DIR, 'js');
const ASSET_INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
// スタイルシートにも版数を焼く。
//
// 以前は js だけに ?v= を付けていて、index.html の
// `<link rel="stylesheet" href="css/style.css">` は素のままだった。
// URL が永久に変わらないので:
//  ・Service Worker（public/sw.js）は ?v の無い要求を networkFirst で扱う。
//    通信が一瞬でも落ちると控えの**古い style.css** を返し、
//    そのとき js だけは新しい ── 見た目だけが前の版という混ざった状態になる。
//  ・端末の HTTP キャッシュも、no-cache とはいえ再検証待ちのあいだ古い絵を出す。
// 実際に v2.34 の点検中、CSS を直したのにブラウザが古いままという状態を踏んだ。
// js と同じ約束（中身が変わったら URL も変わる）に揃える。
const ASSET_CSS = path.join(PUBLIC_DIR, 'css', 'style.css');
const ASSET_CSS_URL = '/css/style.css';
// `from './x.js'` と `import('./x.js')` の両形式。
const IMPORT_SPEC_RE = /(from\s*|import\s*\(\s*)(['"])(\.\/[\w.-]+\.js)(['"])/g;
const ASSET_NAME_RE = /^\/js\/([\w.-]+\.js)$/;

let cssVer = null;      // style.css の版数
let cssBody = null;     // 読み込んだ中身
let cssMtime = null;

const assetVer = new Map();     // 'main.js' -> 版数
const assetBody = new Map();    // 'main.js' -> 変換済みソース
const assetMtime = new Map();   // 'main.js' -> 読んだ時点の mtimeMs
let assetIndexHtml = null;      // 変換済み index.html（null = 素のまま配る）
let assetIndexMtime = null;

function assetHash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10); }

function buildAssetHashes() {
  if (!ASSET_HASH_ENABLED) return;
  assetVer.clear(); assetBody.clear(); assetMtime.clear();
  assetIndexHtml = null;
  let names;
  try { names = fs.readdirSync(ASSET_JS_DIR).filter(f => f.endsWith('.js')); }
  catch { return; }
  const raw = new Map();
  for (const n of names) {
    try {
      const p = path.join(ASSET_JS_DIR, n);
      raw.set(n, fs.readFileSync(p, 'utf8'));
      assetMtime.set(n, fs.statSync(p).mtimeMs);
    } catch { /* 読めないものは対象外（express.static に落ちる） */ }
  }
  if (!raw.size) return;
  // 直接依存（同ディレクトリの相対 import だけ）
  const deps = new Map();
  for (const [n, text] of raw) {
    const set = new Set();
    for (const m of text.matchAll(IMPORT_SPEC_RE)) {
      const base = m[3].slice(2);
      if (raw.has(base) && base !== n) set.add(base);
    }
    deps.set(n, [...set].sort());
  }
  const own = new Map([...raw].map(([n, t]) => [n, assetHash(t)]));
  let ver = new Map(own);
  for (let pass = 0; pass < raw.size; pass++) {
    const next = new Map();
    for (const n of raw.keys()) {
      next.set(n, assetHash(`${own.get(n)}|${deps.get(n).map(d => ver.get(d) || '').join(',')}`));
    }
    ver = next;
  }
  for (const [n, v] of ver) assetVer.set(n, v);
  for (const [n, text] of raw) {
    let ok = true;
    const out = text.replace(IMPORT_SPEC_RE, (m, pre, q1, spec, q2) => {
      const v = assetVer.get(spec.slice(2));
      if (!v) { ok = false; return m; }
      return `${pre}${q1}${spec}?v=${v}${q2}`;
    });
    assetBody.set(n, ok ? out : text);
  }
  // style.css の版数も同じ回で作る（index.html の書き換えで使う）。
  try {
    cssBody = fs.readFileSync(ASSET_CSS, 'utf8');
    cssMtime = fs.statSync(ASSET_CSS).mtimeMs;
    cssVer = assetHash(cssBody);
  } catch { cssBody = null; cssVer = null; cssMtime = null; }

  try {
    const html = fs.readFileSync(ASSET_INDEX_HTML, 'utf8');
    assetIndexMtime = fs.statSync(ASSET_INDEX_HTML).mtimeMs;
    const mv = assetVer.get('main.js');
    if (mv) {
      let out = html.replace(/(src=")(\.?\/?js\/main\.js)(")/, `$1$2?v=${mv}$3`);
      // <link rel="modulepreload"> の href にも同じ ?v= を焼く。
      //
      // 焼かないと preload と実際の読み込みが**別のURL**になる ── preload は
      // 素の js/modes.js を取りに行き、main.js から辿る import は
      // ./modes.js?v=<hash> なので、ブラウザから見て別物になり、先読みした
      // 20本がまるごともう一度落ちてくる（先読みが速くするどころか、
      // 起動時の往復を倍にしていた）。名前が assetVer に無いものは
      // 素のまま残す（存在しない ?v= を付けて 404 にしないため）。
      out = out.replace(
        /(<link\b[^>]*\brel="modulepreload"[^>]*\bhref=")(\.?\/?js\/([A-Za-z0-9_-]+\.js))(")/g,
        (m, pre, href, name, post) => {
          const v = assetVer.get(name);
          return v ? `${pre}${href}?v=${v}${post}` : m;
        });
      // スタイルシートにも同じ ?v= を焼く（上の ASSET_CSS のコメント参照）。
      // 版数が出せなかったときは素のまま残す ── 存在しない ?v= を付けて
      // 見た目が丸ごと落ちるより、キャッシュが効きすぎるほうがまだ軽い。
      if (cssVer) {
        out = out.replace(
          /(<link\b[^>]*\brel="stylesheet"[^>]*\bhref=")(\.?\/?css\/style\.css)(")/,
          `$1$2?v=${cssVer}$3`);
      }
      assetIndexHtml = out === html ? null : out;   // 置換できなければ素のまま配る
    }
  } catch { assetIndexHtml = null; }
}
buildAssetHashes();

// 手元での編集を握りつぶさないための一手間。起動時に読んだきりだと、
// ファイルを直しても再起動するまで古い中身が配られる（no-cache でも
// サーバーが起動時の写しを返すため）。mtime が動いていたら組み直す。
function assetFresh(name) {
  try {
    const mt = fs.statSync(path.join(ASSET_JS_DIR, name)).mtimeMs;
    if (assetMtime.get(name) !== mt) buildAssetHashes();
  } catch { /* 消えていたら次の分岐で express.static に落ちる */ }
}

function sendAsset(req, res, body, type, version) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control',
    version && req.query && req.query.v === version
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
  res.send(body);
}

app.use((req, res, next) => {
  if (!ASSET_HASH_ENABLED) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const m = ASSET_NAME_RE.exec(req.path);
  if (m) {
    assetFresh(m[1]);
    const body = assetBody.get(m[1]);
    if (body == null) return next();
    return sendAsset(req, res, body, 'application/javascript; charset=utf-8', assetVer.get(m[1]));
  }
  // スタイルシートも js と同じ扱い ── ?v= が現行の版数と一致した要求だけ immutable。
  if (req.path === ASSET_CSS_URL) {
    try {
      if (cssMtime !== fs.statSync(ASSET_CSS).mtimeMs) buildAssetHashes();
    } catch { /* 消えていたら express.static に落ちる */ }
    if (cssBody != null) return sendAsset(req, res, cssBody, 'text/css; charset=utf-8', cssVer);
  }
  if (req.path === '/' || req.path === '/index.html') {
    try {
      // index.html 自身だけでなく **style.css の更新も見る**。
      // 焼き込んだ ?v= は index.html の中にあるので、CSS だけを直したときに
      // ここで気づかないと、古い版数のリンクを配り続ける
      // （＝直したはずの見た目が誰にも届かない）。
      const cssChanged = (() => {
        try { return cssMtime !== fs.statSync(ASSET_CSS).mtimeMs; } catch { return false; }
      })();
      if (cssChanged || assetIndexMtime !== fs.statSync(ASSET_INDEX_HTML).mtimeMs) buildAssetHashes();
    } catch { /* 読めなければ下の分岐で素のまま配られる */ }
    if (assetIndexHtml) return sendAsset(req, res, assetIndexHtml, 'text/html; charset=utf-8', null);
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  // Icons are immutable — cache a week. Everything else revalidates
  // (ETag 304) so client updates ship immediately.
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}icons${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newUser(username, password, role = 'user') {
  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  const user = {
    id, username, salt, passHash: hash, role,
    banned: false, createdAt: Date.now(),
    // 登録直後の所持金。500🪙 では 🛍ショップの外観カテゴリで買える品が
    // 1つも無かった（最安の盤面が1,000🪙、スキン1,200🪙、エフェクト1,800🪙。
    // 買えるのは消耗品の🧹クリーナー250🪙だけ）。ソロ1戦の実入りは
    // 20 + score/100 なので、初心者の3,000点＝約50🪙 ── 最初の1品まで約10戦。
    // 「登録した日にショップで何か買える」ところまでは持たせる。
    coins: 1000, gems: 50, xp: 0,
    shards: 0,          // 👑 王座の欠片。管理者イベントでしか増えない
    // 🤝 フレンド。db.friends のような新しい入れ物ではなく user の上に置く ──
    // 復元はトップレベルの未知のキーを黙って落とすので、別の入れ物にすると
    // ディスクが飛んだ再デプロイのたびに全部消える（friends.js 冒頭に詳細）。
    friends: [], friendReqIn: [], friendReqOut: [], blocked: [],
    friendDeclines: {}, social: socialDefaults(), lastSeen: 0,
    stats: {
      gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0,
      aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000, bossMax: 0,
      ultsUsed: 0, itemsUsed: 0, missionsDone: 0, piecesPlaced: 0,
      survivalWave: 0, winStreakBest: 0, loginStreak: 1, loginStreakBest: 1,
      sprintPlays: 0, coopPlays: 0, coopBest: 0, sprint: {},
      meltdownBest: 0, chimeraBest: 0,
      dailycPlays: 0, dailycBestStreak: 0,
      // 下の lastDaily を null にしたので、初回ログインボーナスは登録直後の
      // /api/me で出る。その1回目を数えるのはあちらなので、ここは0から始める
      //（1 にしておくと初日だけ2回ぶん数えてしまう）。
      dailyLogins: 0,
      history: [],
    },
    owned: [...DEFAULT_OWNED],
    // スターターのブースター。ゲスト（modes.js）は item_mini を含む4種を持って
    // 遊べるので、登録すると種類が1つ減る逆転が起きていた。そろえる。
    items: { item_bomb: 1, item_cleaner: 1, item_fever: 1, item_mini: 1 },
    equipped: { ...DEFAULT_EQUIPPED },
    equippedTitle: null,
    battlePass: { season: currentSeason().id, xp: 0, premium: false, claimed: [] },
    badges: [],
    achievements: [],
    missions: null,   // generated on first access (syncMissions)
    // 登録日を「もう受け取り済み」として作っていたので、登録初日だけ
    // ログインボーナス(100🪙+5💎)が出なかった ── 初日の手取りがいちばん薄いのに、
    // そこだけ支給を飛ばしていたことになる。null にすると、登録直後の
    // /api/me（クライアントが必ず呼ぶ）で初日ぶんが出る。連続ログインの計算は
    // 「lastDaily が昨日か」で見ているので、null でも streak は 1 から始まる。
    lastDaily: null,
  };
  db.users[id] = user;
  saveDb();
  return user;
}

// Bring accounts created before a feature shipped up to the current shape.
// Cheap and idempotent — called from publicUser + every progression path.
function migrateUser(user) {
  if (!user) return user;
  const s = user.stats || (user.stats = {});
  for (const [k, v] of Object.entries({
    ultsUsed: 0, itemsUsed: 0, missionsDone: 0, piecesPlaced: 0,
    survivalWave: 0, winStreakBest: 0, loginStreak: 1, loginStreakBest: 1,
    sprintPlays: 0, coopPlays: 0, coopBest: 0, abyssMax: 0, guildBestWeek: 0,
    meltdownBest: 0, chimeraBest: 0, rushDepth: 0,
    totalWins: 0, playSecs: 0, bossKills: 0, chaosPlays: 0, meltdownPlays: 0,
    chimeraPlays: 0, survivalPlays: 0, weeklyPlays: 0, dailyLogins: 1,
    gachaPulls: 0, gachaSSR: 0, chatMessages: 0, reactionsGiven: 0,
    weeklyWins: 0, puzzleStage: 0, puzzlePlays: 0, digDepth: 0, digPlays: 0,
    ghostBest: 0, ghostPlays: 0, dailycPlays: 0, dailycBestStreak: 0,
    // v2.16 以降に増えた累積カウンタ。読む側はどこも `|| 0` を通しているので
    // 実害は無いが、同種のカウンタだけがここに無いと、後から「合計」「平均」で
    // まとめて集計するコードが入ったときに undefined 混入で NaN になる。
    perfectClears: 0, guildQuestsClaimed: 0,
    // ⛓️🏗️🛠️ 新3モードの累積カウンタ。読む側（achievements.js / main.js）は
    // どれも `|| 0` を通しているので実害は無いが、同種のカウンタを欄として
    // 揃えておく（後から「合計」「平均」でまとめる集計が undefined で NaN に
    // ならないように）。
    chainPlays: 0, chainBest: 0, chainMax: 0,
    blueprintPlays: 0, blueprintClears: 0,
    workshopPlays: 0, workshopClears: 0,
  })) if (s[k] === undefined) s[k] = v;
  // 📈 段位の昇格を「どこまで全体告知したか」の印（battle.js が書く / 読む）。
  // 既存アカウントは、いま到達している帯を『告知ずみ』として始める ── 0 から
  // 始めると、この機能が入った日に上位帯の人が次の1戦で全員もう一度告知される。
  if (s.rankAnnounced === undefined) s.rankAnnounced = bandOf(s.ratingBest || s.rating || 0).min;
  if (!s.bossRanks || typeof s.bossRanks !== 'object') s.bossRanks = {};
  // 同じ汚染で stats に増えた永久ゴミキー（'undefined' と 'constructorPrev'
  // のようなプロトタイプ名由来の ~Prev）を落とす。放っておくと db.json が
  // 太り続けるだけで、誰も読まない。
  if (s.undefined !== undefined) delete s.undefined;
  for (const k of Object.keys(s)) {
    if (k.endsWith('Prev') && !k.startsWith('dungeon')) delete s[k];
  }
  if (user.guildId && !(db.guilds && db.guilds[user.guildId])) user.guildId = null;
  if (!s.sprint || typeof s.sprint !== 'object') s.sprint = {};
  if (!Array.isArray(s.history)) s.history = [];
  if (!Array.isArray(user.achievements)) user.achievements = [];
  if (!Array.isArray(user.rankRewards)) user.rankRewards = [];   // pending ランキング報酬
  if (typeof user.gachaPity !== 'number') user.gachaPity = 0;    // ガチャ天井カウンター
  if (!user.equipped) user.equipped = { ...DEFAULT_EQUIPPED };
  // Ultimate-skill slot (v2.0): everyone starts with the free 破壊の衝撃波.
  if (!user.equipped.ult) user.equipped.ult = DEFAULT_EQUIPPED.ult;
  if (!Array.isArray(user.owned)) user.owned = [...DEFAULT_OWNED];
  for (const id of DEFAULT_OWNED) if (!user.owned.includes(id)) user.owned.push(id);
  // Top-level fields, not just stats. Only `stats` was being repaired, so a
  // record from an older schema (or a hand-edited backup) reached
  // publicUser() → syncBattlePass() without a battlePass and 500'd the login.
  // The Number() guards also stop a corrupted value writing NaN back to disk,
  // which poisons every later read of that account.
  if (!Array.isArray(user.badges)) user.badges = [];
  // プロトタイプ汚染（mode:'constructor' 等）で badges に null / undefined が
  // 入ったレコードが実在しうる。画面側は badgeIcons[b] を引くだけなので、
  // 混ざったままだと空アイコンが並び、比較や重複判定も狂う。ここで掃除する。
  if (user.badges.some(b => typeof b !== 'string')) {
    user.badges = user.badges.filter(b => typeof b === 'string');
  }
  if (!user.items || typeof user.items !== 'object') user.items = {};
  for (const k of ['coins', 'gems', 'xp', 'shards']) {
    if (!Number.isFinite(user[k])) user[k] = 0;
  }
  if (!user.battlePass || typeof user.battlePass !== 'object') {
    user.battlePass = { season: currentSeason().id, xp: 0, premium: false, claimed: [] };
  }
  if (!Array.isArray(user.battlePass.claimed)) user.battlePass.claimed = [];
  // 欄をそろえるだけ。存在しない id の掃除はここではやらない ──
  // migrateUser は publicUser のたびに走るので、毎回全フレンドを
  // 走査することになる。掃除は起動時と復元後に healSocial でまとめて。
  ensureSocial(user);
  if (user.role !== 'admin' && user.role !== 'mod') user.role = 'user';
  return user;
}

// 結果送信の「前回はいつだったか」。まだ一度も送っていない人にも
// 必ず基準を与える ── 無いと初回だけ一律の猶予になり、
//   ・短すぎれば「初めての1回が長かった人」のスコアを切り詰める
//   ・長すぎれば新規アカウントが1リクエストで上限まで通せる
// の両方を同時に踏む。
//
// 基準は「アカウントが存在している時間」。誰も自分のアカウントより
// 長くは遊べないので偽装できない。ただし上限は30分 ── 青天井にすると、
// 何年も前に作って一度も遊んでいないアカウントが、その「初回」1回だけ
// スコア上限まで通せてしまう。
const FIRST_RESULT_GRACE_MS = 30 * 60 * 1000;
// 生涯の初回送信だけに効く、スコアの追加の頭押さえ。
//
// 上の「持ち時間」は 最大30分＋猶予90秒 ＝ 1,890秒。v2.14 で1秒あたりの上限
// (rateCap)を 500→2000 に上げたので、1,890 × 2,000 = 3,780,000 となり、
// 初回送信では壁時計クランプが**絶対上限(1,000,000)より先に効かなくなった**。
// つまり「まだ一度も結果を送っていないアカウント」── 登録から約7分経った
// 新規、あるいはバックアップから戻ってきて lastResultAt を持たない人 ── は、
// 1リクエストで100万点＝全ボードの首位を取れた。
//
// 持ち時間そのものを縮めると「初めての1回が長かった人」を切り詰めてしまう
// （それが理由で一律300秒をやめた経緯がある）ので、縮めるのは持ち時間では
// なく「初回1回で載せられるスコア」のほうにする。2回目以降は直前送信からの
// 実経過時間で縛られるので、この頭押さえは初回にだけ必要。
// 300,000 は、この世界の実在プレイヤーの生涯ベスト（500戦で300,000）と同じ
// 高さ。正直な初回プレイがここに触ることはまず無く、触っても記録は残る。
const FIRST_RESULT_SCORE_CAP = 300_000;
// 🧩 パズル遺跡の「その日そのステージ番号の勝利は1回まで」の印が覚える件数。
// backup.js の合流にも同名の頭押さえがある（あちらは細工したファイル対策）。
const PUZ_WIN_DAY_KEEP = 200;
function seedLastResultAt(user) {
  const s = user.stats;
  if (Number.isFinite(s.lastResultAt) && s.lastResultAt > 0) return s.lastResultAt;
  const now = Date.now();
  const age = Math.max(0, now - (Number.isFinite(user.createdAt) ? user.createdAt : now));
  s.lastResultAt = now - Math.min(age, FIRST_RESULT_GRACE_MS);
  return s.lastResultAt;
}

function levelOf(xp) { return 1 + Math.floor(xp / 1000); }

// 桁区切り。ライブフィードから通知・ショップまで散らばって使うので、
// ショップの章の中ではなくこの共通ヘルパーの並びに置く。
function fmtNum(n) { return n.toLocaleString('ja-JP'); }

// 今週の週ID。ギルドもフレンドのライバル表もこれを見るので、
// どちらかの章に置くと片方が相手の章を覗くことになる。共通の側に置く。
// （weekIdOf / currentWeekNum は関数宣言なので、定義より前でも呼べる）
const curWeek = () => weekIdOf(currentWeekNum());

// Season number/endsAt derive from a fixed epoch instead of stored state, so a
// redeploy (which wipes the DB on this hosting tier) computes the SAME season
// with the SAME id — no more "every update restarts the 30-day season", and no
// more battle-pass wipes (the pass is keyed by season id, which used to be a
// per-instance random UUID). Admin overrides live in db.meta.seasonOverride:
// { baseIndex, gen, numberOffset, name, startedAt, endsAt } — gen bumps force a
// reset, endsAt (while in the future) freezes the season past the 30-day grid.
const SEASON_MS = BP_SEASON_DAYS * 24 * 60 * 60 * 1000;
const SEASON_EPOCH = 1784782260770;   // maps the live S2 (ends 2026-09-20) exactly

function derivedSeasonIndex(now = Date.now()) {
  return Math.max(1, Math.floor((now - SEASON_EPOCH) / SEASON_MS) + 1);
}

function currentSeason() {
  const now = Date.now();
  const idx = derivedSeasonIndex(now);
  let o = db.meta.seasonOverride || null;
  // An admin-shortened season whose endsAt passed BEFORE the natural 30-day
  // boundary must actually end: roll it into a forced next season starting at
  // that moment (gen bump = new id = battle passes reset), not silently resume
  // the old one with a later end date. Lazy + idempotent, like the old rollover.
  while (o && o.endsAt && o.endsAt <= now && (o.baseIndex || idx) === idx) {
    o = db.meta.seasonOverride = {
      baseIndex: idx,
      gen: (o.gen || 0) + 1,
      numberOffset: (o.numberOffset || 0) + 1,
      name: null,
      startedAt: o.endsAt,
      endsAt: o.endsAt + SEASON_MS,
    };
    saveDb();
  }
  const extended = !!(o && o.endsAt && o.endsAt > now);
  const effIdx = extended ? (o.baseIndex || idx) : idx;
  const gen = o ? (o.gen || 0) : 0;
  const number = effIdx + (o ? (o.numberOffset || 0) : 0);
  const custom = o && o.name && effIdx === (o.baseIndex || idx);
  return {
    id: `s${effIdx}${gen ? '-' + gen : ''}`,
    number,
    name: custom ? o.name : `シーズン ${number}`,
    nameEn: custom ? o.name : `Season ${number}`,
    startedAt: extended && o.startedAt ? o.startedAt : SEASON_EPOCH + (effIdx - 1) * SEASON_MS,
    endsAt: extended ? o.endsAt : SEASON_EPOCH + effIdx * SEASON_MS,
  };
}

// Bridge from the stored-season era (and from restored backups): a legacy
// season object whose clock is still running IS today's season, so every
// battle pass pointing at its old UUID carries over instead of resetting.
function adoptLegacySeason(legacy) {
  if (!legacy || !legacy.id || typeof legacy.id !== 'string') return 0;
  const cur = currentSeason();
  if (legacy.id === cur.id || !(legacy.endsAt > Date.now())) return 0;
  let n = 0;
  for (const u of Object.values(db.users)) {
    if (u.battlePass && u.battlePass.season === legacy.id) { u.battlePass.season = cur.id; n++; }
  }
  return n;
}

// Reset a user's battle pass if the season rolled over.
function syncBattlePass(user) {
  const season = currentSeason();
  if (user.battlePass.season !== season.id) {
    user.battlePass = { season: season.id, xp: 0, premium: false, claimed: [] };
    saveDb();
  }
  return user.battlePass;
}

function publicUser(user) {
  if (!user) return null;
  migrateUser(user);
  const bp = syncBattlePass(user);
  const isAdmin = user.role === 'admin';
  // Admins own the whole shop and the fully-unlocked premium pass.
  const adminBp = isAdmin
    ? { ...bp, premium: true, xp: BP_TIERS.length * BP_XP_PER_TIER }
    : bp;
  return {
    id: user.id, username: user.username, role: user.role, banned: user.banned,
    coins: user.coins, gems: user.gems, xp: user.xp, level: levelOf(user.xp),
    shards: user.shards || 0,
    // 数だけ。id も配列もここには載せない ── publicUser は財布も stats も
    // 丸ごと入っていて、20近い経路から返る自分用の形なので。
    social: { friends: (user.friends || []).length, pending: (user.friendReqIn || []).length },
    stats: user.stats,
    owned: isAdmin ? SHOP_ITEMS.map(i => i.id) : user.owned,
    equipped: user.equipped,
    items: user.items || {},
    battlePass: adminBp, badges: user.badges,
    equippedTitle: user.equippedTitle || null,
    achievements: user.achievements,
    rankRewards: user.rankRewards || [],
    thrones: thronesOf(user.id),
    guild: user.guildId && db.guilds[user.guildId]
      ? { id: user.guildId, name: db.guilds[user.guildId].name, tag: db.guilds[user.guildId].tag, icon: db.guilds[user.guildId].icon, owner: db.guilds[user.guildId].ownerId === user.id }
      : null,
  };
}

// Sanity-check and apply a finished game's rewards. Returns the reward summary.
// サーバーが自分で勝敗を決めているモード。これらの結果は対戦の実処理
// （server/battle.js）からしか受け付けない。クライアントが /api/game/result に
// 「royale で勝った」と書いて送るだけで、その判定を丸ごと飛び越えられていた
// （実測: 新規アカウントが239msで4,875ジェム＋バッジ11種を取得）。
// スコアがクライアント申告なのは構造上そうだが、これは設計上の割り切りでは
// なく単なる抜け穴だった。
// 💎ジェムラッシュのドロップを受け取る最低条件。1プレイの実体があったと
// 言える下限で、正直に遊べば必ず超える（ソロの平均は数千点・1分以上）。
const GEMDROP_MIN_SCORE = 1000;
const GEMDROP_MIN_SECONDS = 20;
// 1日に💎ドロップで配る上限。gemDrop は1プレイ3個なので40プレイぶん —
// 普通に遊ぶ人が上限に当たることはまずないが、機械的な連投は必ずここで止まる。
const GEMDROP_DAILY_CAP = 120;
// 🪙/XP の1日あたりの上限。💎の GEMDROP_DAILY_CAP と同じ考え方の2枚目の歯止め。
//
// なぜ要るか: 固定ぶんを0にしても「スコアだけを申告する偽の結果」は残る。
// duration は『前回の提出からの実経過＋90秒』で押さえてあるが、レート上限
// いっぱい（250件/時＝14.4秒おき）に投げれば毎回 約104秒ぶん、rateCap 2,000/秒
// で 208,000点まで名乗れる ── 1試合の上限 1,000🪙 に毎回張り付いて
// 250,000🪙/時 が湧く。「1日にいくらまで湧くか」を決めないと歯止めにならない。
//
// 値の根拠（実測。engine.js + ai.js で120秒/60秒のプレイを回して報酬式に通した）:
//   ・実力上位の人のソロ無限: 中央値 8,639点/97秒 → 3,414🪙・15,878bpXp・3,414accXp /時
//   ・普通の人のソロ無限:     中央値 6,829点/105秒 → 2,636🪙・10,873bpXp・2,636accXp /時
//   ・毎試合が1試合上限に張り付く3分プレイ（奥義でスコアを盛った本気の走り）:
//     18,462🪙・14,769bpXp・11,077accXp /時 ← 現実的な「正直な上限」はここ
// その最速の取り分でも 8時間 連続でようやく届く高さに置く。実測の中央値
// （3,414🪙/時）なら44時間ぶんなので、普通に何時間か遊んで当たることはない。
// 一方、偽の結果の 250,000🪙/時 は 1日 150,000🪙 まで＝40分の1に落ちる。
//
// 環境変数で下げられるようにしてあるのは運用（と test/farming.test.mjs）のため。
// MATCH_SECONDS と同じ作法で「既定値はコードに、調整は環境に」。
const grindCap = (env, def) => (Number(process.env[env]) > 0 ? Number(process.env[env]) : def);
const GRIND_DAILY_CAP = {
  coins: grindCap('GRIND_COIN_DAY', 150000),
  bpXp: grindCap('GRIND_BPXP_DAY', 120000),
  accXp: grindCap('GRIND_ACCXP_DAY', 90000),
};
// 🐛報告箱の上限。バグ報告と通報が同じ配列を使うので、値は必ず1つに保つ。
const BUGREPORT_CAP = 300;
// サーバーが配りうるバッジの全一覧。管理画面の編集欄（routes/admin.js）と、
// 起動時に運営アカウントへ全部持たせる unlockEverythingForStaff の両方が読む。
// どちらか一方の持ち物にすると、もう片方が必ず取りこぼす。
const ADMIN_KNOWN_BADGES = ['bronze', 'silver', 'gold', 'oni', 'kami', 'souzou', 'maou', 'rush', 'dungeon', 'tourney', 'royale', 'adminevent', 'abyss', 'under', 'heaven', 'zero', 'zero7', 'weekly1', 'puzzle', 'dig', 'crown2', 'crown3', 'crown5', 'crown7', 'ghost', 'daily7', 'guildquest'];
const SERVER_JUDGED_MODES = new Set(['royale', 'tournament', 'pvp', 'team', 'raid', 'coop', 'attack']);

function applyGameResult(user, { mode, score, lines, maxCombo, maxChain, duration, won, drew, bossId, floor, wave, ults, items, pieces, floors, sprintDur, rank, depth, stage, day, attemptId, perfectClears, trusted, preClamped }) {
  const extraBossId = typeof bossId === 'string' ? bossId : null;
  // mode はキー生成にも使う（下の `${mode}Prev`）。クライアント申告なので、
  // 長さを切っておかないと巨大文字列で stats を無限に太らせられる（実測で
  // 1リクエストごとに ~60KB の永続キーが1個増え、やがて db.json の保存自体が
  // 静かに失敗しうる）。既知の mode はどれも十数文字なので32で十分。
  // String() は、JSON で作れる値でも例外を投げることがある:
  //   {"mode":{"toString":1,"valueOf":1}} → TypeError（原始値に変換できない）
  // 素通しだと 500 になり、既定のエラーハンドラがスタックトレースを返していた。
  // 文字列と数値だけを受け、それ以外は既定の 'solo' に落とす。
  mode = (typeof mode === 'string' || typeof mode === 'number') ? String(mode).slice(0, 32) : 'solo';
  if (!mode) mode = 'solo';
  // 対戦の実処理を経ていない申告は、ソロ扱いに落として報酬を出さない。
  if (!trusted && SERVER_JUDGED_MODES.has(mode)) {
    console.warn(`[cheat] ${user.username}: サーバー判定モード '${mode}' を直接申告（拒否）`);
    return { rejected: true, reason: 'mode', coins: 0, gems: 0, xp: 0, badge: null, missions: [], levelUp: null };
  }
  migrateUser(user);
  // Pay out last week's ranking BEFORE this game can overwrite a stale
  // stats.weekly record with the new week.
  finalizeWeeklyRankings();
  // v2.0 telemetry from the client — clamped like everything else.
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  wave = clamp(wave, 999);
  ults = clamp(ults, 200);
  items = clamp(items, 200);
  pieces = clamp(pieces, 20000);
  floors = clamp(floors, 100);
  // ✨全消し「昇華」の回数。1ランで現実的に出せるのはせいぜい数回なので、
  // ults/items と同じ作法で上限を切っておく（実績→💎の原資になるため）。
  // 上限20は「現実的に数回」という自分の但し書きと合っていなかった:
  // ach_pclear50(9,000🪙+80💎) までが 20秒あけた3リクエストで満額取れる。
  // 実プレイの物理に寄せて5回まで。下の lines 相関チェックと2枚重ねにする。
  perfectClears = clamp(perfectClears, 5);
  // 単数 floor（ダンジョン到達階）もクランプ。realm ブロックは別変数 fl で
  // クランプするが、到達フィード生成と `${mode}Prev` 書き込みは生 floor を
  // 使うため、ここで押さえないと F999999 の虚偽速報や dungeonPrev=Infinity
  // (保存で null 化) を通してしまう。fl(926)と二重になるが無害。
  floor = clamp(floor, 100);
  depth = clamp(depth, 9999);
  stage = clamp(stage, 9999);
  // ⛓️連鎖カスケードの最大連鎖数。chainMult の上限が ×64（= 2^(連鎖-1)）なので
  // 現実的な連鎖数は高々そのあたり。クライアント申告なので他のテレメトリと
  // 同じ作法で頭を押さえる（実績 ach_chain5/10 の原資になるため）。
  maxChain = clamp(maxChain, 64);
  rank = ['S', 'A', 'B', 'C'].includes(rank) ? rank : null;
  score = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
  lines = Math.max(0, Math.min(5000, Math.floor(Number(lines) || 0)));
  // 全消しは「盤面を空にした」瞬間なので、直前にそれなりの数のラインを
  // 消していないと成立しない。lines と相関させておけば、perfectClears だけを
  // 盛った申告は通らなくなる（lines も一緒に偽ると今度はスコアの
  // レート上限と実経過時間の側で引っかかる）。
  perfectClears = Math.min(perfectClears, Math.floor(lines / 8));
  maxCombo = Math.max(0, Math.min(200, Math.floor(Number(maxCombo) || 0)));
  duration = Math.max(1, Math.min(7200, Number(duration) || 1));
  // `duration` is CLIENT-DECLARED, and the rate cap below divides by it — so
  // claiming "I played for 7200 seconds" unlocked the full 1,000,000 ceiling on
  // a run that actually took a second. The wall clock since this account's last
  // submission is an upper bound nobody can forge: you cannot have played for
  // longer than the time that has passed. The first submission of a session has
  // no previous mark, so it gets the benefit of the doubt (capped at an hour).
  // preClamped: 呼び出し元が同じ計算をすでに済ませている場合（管理者イベント）。
  // 向こうで lastResultAt を先に更新しているので、ここでもう一度測ると
  // 経過時間が 0 になり、duration が猶予の 90秒 に落ちる。すると報酬計算の
  // スコアが必ず 90×500 = 45,000点 で頭打ちになり、どれだけ長く上手に
  // 遊んでもコインもXPもミッション進捗も 90秒ぶんしか付かなかった。
  // このアカウントが「まだ一度も結果を送っていない」か。seedLastResultAt は
  // 呼ぶと基準を書き込んでしまうので、その前に見ておく（下の初回上限で使う）。
  let firstEverResult = false;
  if (!preClamped) {
    const now = Date.now();
    firstEverResult = !(Number.isFinite(user.stats.lastResultAt) && user.stats.lastResultAt > 0);
    const last = seedLastResultAt(user);
    // +90s of slack: a run can start before the previous one is submitted
    // (menus, result screens), and clocks drift.
    // 初回だけ 3600秒 の猶予を与えていたので、3600×500=180万点 が上限を
    // 上回り、スコアの絶対上限100万点に対して**一度も発動しない**状態だった。
    // しかもこの「初回」はセッション初回ではなくアカウント生涯の初回。
    // 実測で、新規アカウントが1リクエストで王座を6つ独占できた。
    //
    // かといって初回を一律300秒にすると、今度は「初めての1回が長かった人」の
    // スコアを 300×500 = 150,000点 で切り詰めてしまう。
    // なので初回の基準は migrateUser が入れておく（アカウントの年齢に基づく、
    // 最大30分ぶんの持ち時間）。ここでは常にその基準からの経過を使う。
    const elapsed = (now - last) / 1000 + 90;
    if (duration > elapsed) duration = Math.max(1, Math.floor(elapsed));
    user.stats.lastResultAt = now;
  }
  // Cheat guard: cap plausible score rate. This is only a coarse "no human
  // scores THIS fast" backstop — the real anti-forge is the wall-clock clamp
  // above (you cannot have played longer than the time since your last result),
  // which cannot be beaten by claiming a big duration. So the rate cap can be
  // generous without opening a cheat: raising it does not let anyone forge a
  // score faster than real time passes.
  //
  // v2.14: the old 500/sec default was silently clipping legit SOLO runs. Solo
  // allows ultimate skills (メテオ +100,000, 神の裁き = full-board wipe for a
  // huge burst, オーバードライブ = ×3 for 15s), so a player's BEST games — the
  // record-setting ones — routinely blew past 500/sec and got cut, and their
  // high score plateaued ("I beat my score but the ranking never moves"). The
  // endless boards now get a ceiling high enough that honest ultimate-fueled
  // play always registers; the absolute 1,000,000 cap (above) still stands.
  // Time attack stays at 1000/sec ON PURPOSE: it disables items/ultimates for
  // fairness, so pure fast placement tops out near 1000/sec — that keeps the
  // 60,000 (60s) / 180,000 (180s) summit reachable but not forgeable, which is
  // exactly the ceiling the arena residents sit just under.
  const rateCap = mode === 'sprint' ? 1000 : mode === 'meltdown' ? 2000 : mode === 'chimera' ? 1000 : mode === 'dig' ? 2000 : 2000;
  if (score > duration * rateCap) score = Math.floor(duration * rateCap);
  // 生涯の初回だけ、さらに低い天井をかぶせる（FIRST_RESULT_SCORE_CAP のコメント）。
  // 持ち時間 1,890秒 × rateCap 2,000/秒 は絶対上限の 1,000,000 を上回るので、
  // ここが無いと「一度も送っていないアカウント」は1リクエストで首位を取れる。
  if (firstEverResult && score > FIRST_RESULT_SCORE_CAP) score = FIRST_RESULT_SCORE_CAP;

  // 「1プレイの実体があった」判定。score も duration もここで確定するので、
  // 以降どこからでも使える。💎ドロップ・累積カウンタ（下）に加えて、
  // 🗡️ギルド週間クエスト（すぐ下のギルドブロック）もこの門をくぐらせる。
  const realPlay = score >= GEMDROP_MIN_SCORE && duration >= GEMDROP_MIN_SECONDS;

  // 🏗️ブループリントは「その日じゅう全員同じ固定盤面」なので、一度解けば
  // 手順を覚えたまま何度でも won:true を送れる。📅デイリーは開始時の予約
  // (attemptId) で反復を塞いでいるが、ブループリントには何も無かった。
  // 勝利ぶんの上積み（+50🪙 / bpXp+100 / accXp+80 / ギルドpt+25 / totalWins /
  // ミッションの 'win'）だけを「その日の初回」に限る。2回目以降も普通に
  // 遊べて、汎用ミッション（games/lines/score）は今までどおり進む。
  if (mode === 'blueprint') {
    const today = jstDayKey();
    const bp = user.stats.bpDay;
    if (!bp || bp.day !== today) user.stats.bpDay = { day: today, cleared: false };
    if (won) {
      if (user.stats.bpDay.cleared) won = false;
      else user.stats.bpDay.cleared = true;
    }
  }
  // 🧩パズル遺跡も同じ性質。盤面は seed = ステージ番号だけで決まる決定論的な
  // 生成なので、ステージ1は誰にとっても毎回まったく同じ ── 手順を覚えれば
  // 十数秒で won:true を送り続けられる。💎とバッジは「自己ベスト更新のときだけ」
  // (下の puzzle ブロック)で守られているが、勝利の上積み（+50🪙 / bpXp+100 /
  // accXp+80 / ギルド週間pt+25 / totalWins / ミッションの 'win'）は素通しだった。
  // 結果送信の上限は250件/時なので、bpXp だけで約37,500/時＝バトルパス1シーズン
  // ぶん(30段×500=15,000)が30分弱で埋まる。
  // クライアントは既に stage を送っているので、ブループリントと同型のガードを
  // サーバー側だけで置ける: 同じステージ番号の勝利計上はJSTの1日1回まで。
  // 2回目以降も普通に遊べて、汎用ミッション（games/lines/score）も★も進行も
  // 今までどおり通る（練習で解き直す遊び方は壊さない）。
  if (mode === 'puzzle' && won) {
    const today = jstDayKey();
    let pw = user.stats.puzWinDay;
    if (!pw || pw.day !== today || !Array.isArray(pw.stages)) {
      pw = user.stats.puzWinDay = { day: today, stages: [] };
    }
    const st = Math.max(0, Math.min(999, Math.floor(stage) || 0));
    if (pw.stages.includes(st)) won = false;
    else {
      pw.stages.push(st);
      // 覚えておく数の上限。1日に200ステージを正直に解く人は現実にはいないが、
      // 細工した送信で配列を無限に伸ばされないように頭を押さえる（あふれたら
      // 古いほうから忘れる ── 忘れるまでに200ステージぶんの間隔が要るので、
      // 同じステージの連投という本題は塞がったまま）。
      if (pw.stages.length > PUZ_WIN_DAY_KEEP) pw.stages.splice(0, pw.stages.length - PUZ_WIN_DAY_KEEP);
    }
  }
  // 🛠️工房も同型（自作の1〜2手ステージを公開して自分で回せる）。本筋は
  // 結果に stage code を載せて「同じステージの初回だけ」にすることだが、
  // それはクライアント側の送信を変える必要があるので、暫定として勝利加算に
  // 1時間あたりの上限を置く。正直に色々なステージを遊ぶぶんには当たらない。
  if (mode === 'workshop' && won && !rateLimit(`wswin:${user.id}`, 10, 60 * 60 * 1000)) won = false;

  // 1回の送信ごとに付く「固定ぶん」（基礎 20🪙/30bpXp/20accXp と勝利ボーナス）は
  // プレイの長さを一切見ていなかった。スコア連動ぶんと違って回数だけで増えるので、
  // 1回が短いモードほど分あたりの実入りが良くなる ── 10秒で終わる🛠️工房の par1
  // ステージが最も割がよく、90秒の🏗️ブループリントや数分のソロ、まして数十分の
  // ⛓️連鎖が最も割に合わない、という「長く遊ぶほど損」な向きになっていた。
  //
  // そこで固定ぶんだけを「そのプレイの実体（duration）」に連動させる。duration は
  // 上で実経過時間により頭を押さえてあるので、申告で伸ばすことはできない。
  // 45秒以上のプレイは今までどおり満額。それより短い回は取り分が縮むが、
  // スコア連動ぶんは一切触らないので、短いステージの実入りが消えるわけではない。
  const BASE_FULL_SECONDS = 45;
  // ⚠ ここの下限 0.25 が「ソロを押してすぐ終了」を稼ぎに変えていた。
  //
  // 何もせずに結果だけ送っても paceScale が 0.25 で残るので、毎回
  // 5🪙 / 8bpXp / 5accXp が必ず入る。結果送信の上限は250件/時なので、
  // 放置で 1,250🪙/時・2,000bpXp/時・1,250accXp/時 が湧いていた。
  //
  // かといって既存の realPlay（1,000点以上 かつ 20秒以上）を門にすると、
  // 🛠️工房の10秒ステージのような「短いが本物のプレイ」まで固定ぶんが0になり、
  // 正直に短く遊んだ人の取り分を削ることになる（それは直したい向きの逆）。
  // だから判定は「遊んだ形跡が **無い** こと」だけに絞る ── スコアもラインも
  // ほとんど動いていない回を『遊んでいない』とみなし、そこだけ固定ぶんを落とす。
  // 1ライン消せば 8マス×1点＋100点で必ず超えるので、1手でも本当に遊んだ回が
  // ここに落ちることはない。スコア連動ぶん（score/100 など）は一切触らない。
  //
  // 200 という高さの理由: 0 にすると「ソロを開いて1マス置いてすぐ終了」を
  // 繰り返すだけで固定ぶんが取れてしまう（実クライアントで2タップの操作）。
  // 200 なら 2ラインぶんの実プレイが要る。
  //
  // 既知のトレードオフ: 🏗️ブループリントは「ラインを揃えてはいけない」ルールで、
  // 失敗した回のスコアは置いたマス数そのもの（設計図は27マス級なので最大でも
  // 30点前後・lines は必ず0）。つまり **失敗した回だけ** 固定ぶんが0になる。
  // 完成した回は完成ボーナス（マス数×40）で1,000点を超えるので影響なし。
  // 1日1回のパズルの、しかも失敗した回の 20🪙 なので許容した。気になるなら
  // ブループリント側で「置いたマス」に点を厚くするのが筋（報酬式ではなく
  // モードの得点設計の話 — public/js/modes.js の担当へ）。
  const NOPLAY_SCORE = 200;
  const idleResult = score < NOPLAY_SCORE && lines === 0;
  const paceScale = idleResult ? 0 : Math.max(0.25, Math.min(1, duration / BASE_FULL_SECONDS));
  const paced = n => Math.round(n * paceScale);
  let coins = Math.min(1000, paced(20) + Math.floor(score / 100) + (won ? paced(50) : 0));
  if (mode === 'chaos') coins = Math.min(1500, Math.round(coins * 1.5));   // chaos-mode bonus
  let bpXp = Math.min(800, paced(30) + Math.floor(score / 60) + lines * 5 + (won ? paced(100) : 0));
  let accXp = Math.min(600, paced(20) + Math.floor(score / 100) + (won ? paced(80) : 0));

  // Limited-time event multipliers.
  const bonus = eventBonus(currentEvent());
  const isBossMode = mode === 'boss' || mode === 'boss_rush' || mode === 'raid';
  let eventCoins = 0, eventGems = 0;
  const coinMult = (bonus.coin || 1) * (isBossMode && bonus.bossCoin ? bonus.bossCoin : 1);
  if (coinMult > 1) {
    const boosted = Math.round(coins * coinMult);
    eventCoins = boosted - coins;
    coins = boosted;
  }
  if (bonus.xp > 1) {
    bpXp = Math.round(bpXp * bonus.xp);
    accXp = Math.round(accXp * bonus.xp);
  }
  // 💎ジェムラッシュ: 1プレイごとの固定ドロップ。
  //
  // コインは「スコア連動」＋「実経過時間 × レート上限」で二重に頭を押さえて
  // いるのに、この💎はスコアも時間も見ずに送信1回ごとに払っていた。つまり
  // 空のボディ {} を投げるだけで満額入り、レート制限（250件/時）だけが上限
  // ＝ 遊ばずに 750💎/時。課金パック換算で1時間 ¥890 相当が湧く。
  //
  // 「遊んだ形跡」を条件にする。正直に1プレイすれば必ず超える水準なので、
  // 普通に遊んでいる人の取り分は変わらない。
  if (bonus.gemDrop > 0 && score >= GEMDROP_MIN_SCORE && duration >= GEMDROP_MIN_SECONDS) {
    // 2枚目の歯止め: 1日に配る総額の上限。
    //
    // 上の score/duration だけでは足りない。duration は「前回からの経過＋90秒の
    // 猶予」で押さえられるので、連投しても常に90秒ぶんは通ってしまい、
    // スコアを申告するだけの偽の結果は素通りする。💎は課金通貨なので、
    // 「1日にいくらまで湧くか」を決めておかないと歯止めにならない。
    // `s`（= user.stats）の宣言はこの下なので、ここでは使えない（一時的死角）。
    const st = user.stats;
    const today = jstDayKey();
    if (!st.eventGemDay || st.eventGemDay.day !== today) st.eventGemDay = { day: today, got: 0 };
    const room = Math.max(0, GEMDROP_DAILY_CAP - st.eventGemDay.got);
    eventGems = Math.min(Math.floor(bonus.gemDrop), room);
    if (eventGems > 0) {
      st.eventGemDay.got += eventGems;
      user.gems += eventGems;
    }
  }

  // Guild: every game feeds the weekly race, and the guild's level pays a
  // coin bonus back to its members.
  let guildPts = 0, guildBonus = 0;
  const guild = user.guildId ? db.guilds[user.guildId] : null;
  if (guild) {
    const wk = weekIdOf(currentWeekNum());
    guildPts = addGuildPoints(db, user, Math.floor(score / 400) + (won ? 25 : 0) + Math.floor(lines / 2), wk);
    // 🗡️ 週間クエストは addGuildPoints の「直後」でなければならない —— 'points'
    // クエストは加算済みの週間ptをそのまま読む（自前で足し直さない）ので、
    // 先に呼ぶと今回のぶんだけ1ゲーム遅れて達成することになる。
    //
    // ダンジョンの階数は、この地点ではまだ ownRealm(下で宣言) を使えないので
    // 4つの世界を直に見る。他モードの stray な floors をクエストに足さないため。
    const isDungeonMode = mode === 'dungeon' || mode === 'dungeon_under'
      || mode === 'dungeon_heaven' || mode === 'dungeon_abyss';
    // クエストの加算も実プレイ判定の門をくぐらせる。ここだけ門の外にあったので、
    // score:0 / duration:1 の空の結果を連投するだけで「ライン3,000本」等が
    // 達成状態になり、金庫の 🪙1200+💎6 がメンバー全員に配れてしまった。
    // 正直に1プレイすれば必ず超える水準なので、通常プレイの取り分は変わらない。
    // （'games' トラックは questContributions が固定で 1 を返すので、guilds.js
    //  側でも realPlay を見るまでは寄与が残る ── coordination に残した）
    const questsDone = trackGuildQuests(db, user, wk, {
      mode, won: !!won && realPlay, realPlay,
      lines: realPlay ? lines : 0,
      perfectClears: realPlay ? perfectClears : 0,
      ults: realPlay ? ults : 0,
      floors: realPlay && isDungeonMode ? floors : 0,
    });
    // 達成はギルド全体の手柄なので、ライブフィードで世界に知らせる（日英）。
    // 1ゲームで2本以上ぶら下がることは滅多にないが、念のため頭を押さえる。
    if (questsDone.length && battleReady) {
      for (const q of questsDone.slice(0, 2)) {
        battle.crowd.feed({
          icon: '🗡️', real: true, who: user.username,
          text: `ギルド「${guild.name}」が週間クエスト「${q.name}」を達成！ 金庫が開いた`,
          textEn: `Guild "${guild.name}" cleared the weekly quest "${q.nameEn || q.name}" — the vault is open!`,
        });
      }
    }
    guildBonus = Math.floor(coins * guildCoinBonus(guildLevel(guild.lifetime || 0)));
    coins += guildBonus;
    const mine = (guild.weekly[wk] && guild.weekly[wk].byMember[user.id]) || 0;
    if (mine > (user.stats.guildBestWeek || 0)) user.stats.guildBestWeek = mine;
  }

  // 1日あたりの上限で頭を押さえる（値の根拠は GRIND_DAILY_CAP のコメント）。
  // ここに置くのは「イベント倍率もギルド還元も乗せ終わった、実際に配る額」を
  // 数えたいから ── 倍率の前で数えると、イベント中だけ上限が実質2倍になる。
  // 日付は 💎ドロップと同じ JST の1日。`s`（= user.stats）の宣言はこの下なので
  // ここでは user.stats を直に見る（eventGemDay のブロックと同じ作法・一時的死角）。
  {
    const gs = user.stats;
    const gday = jstDayKey();
    if (!gs.grindDay || gs.grindDay.day !== gday) gs.grindDay = { day: gday, coins: 0, bpXp: 0, accXp: 0 };
    const take = (key, want) => {
      const got = Math.max(0, Math.min(Math.floor(want) || 0, GRIND_DAILY_CAP[key] - (Number(gs.grindDay[key]) || 0)));
      gs.grindDay[key] = (Number(gs.grindDay[key]) || 0) + got;
      return got;
    };
    coins = take('coins', coins);
    bpXp = take('bpXp', bpXp);
    accXp = take('accXp', accXp);
  }

  user.coins += coins;
  user.xp += accXp;
  syncBattlePass(user);
  user.battlePass.xp = Math.min(BP_TIERS.length * BP_XP_PER_TIER, user.battlePass.xp + bpXp);

  const s = user.stats;
  s.gamesPlayed += 1;
  s.totalScore += score;
  s.totalLines += lines;
  const prevBest = s.bestScore;
  const prevCombo = s.maxCombo;
  // Meltdown's critical-heat multiplier (×15+) makes its totals incomparable
  // to a plain game — it stays off the global score board (own best stat).
  // Chimera caps around ×3, same ballpark as chaos, so it counts.
  // 管理者イベントも同じ理由で除外: ルーレットは×5、襲来は妨害まみれで、
  // 「誰でも挑めるモードのハイスコア」と並べても意味がない。
  // デイリーはお題（コンボ2倍等）でスコアの物差しが日ごとに変わるので、
  // 通常ハイスコアとは比べない — 専用のその日限りランキングだけに載る。
  // ⛓️連鎖カスケードも同じ理由で除外: 倍率が最大×64（chainMult は 2^(連鎖-1)）
  // で、×15のメルトダウンを外した基準に照らせば明確に除外側。連鎖の自己ベストは
  // クライアント側の専用記録（bba_chain_best）が持っているので達成感は残る。
  const scoreboardEligible = mode !== 'meltdown' && mode !== 'chain' && mode !== 'daily' && !mode.startsWith('ae_');
  if (scoreboardEligible && score > s.bestScore) s.bestScore = score;
  // これらの累積カウンタは実績→💎(課金通貨)の原資になるが、値はすべて
  // クライアント申告なのでスコア/コインと同様に信頼しない。💎ドロップと同じ
  // 「実プレイの痕跡」(score/duration が実プレイ下限を超える) を通った回だけ
  // 反映する。正直に1プレイすれば必ず超える水準なので通常プレイの取り分は
  // 変わらないが、{maxCombo:200} 等のテレメトリだけを連投しても最上位実績に
  // 到達できない。maxCombo は monotonic set ではなく実プレイ判定を通した回のみ更新。
  // （realPlay の宣言はレート上限の直後に移した ── ギルド週間クエストの加算も
  //  同じ門をくぐらせる必要があり、そちらはこの行より前にあるため）
  if (realPlay && maxCombo > s.maxCombo) s.maxCombo = maxCombo;
  if (realPlay) {
    s.ultsUsed = (s.ultsUsed || 0) + ults;
    s.itemsUsed = (s.itemsUsed || 0) + items;
    s.piecesPlaced = (s.piecesPlaced || 0) + pieces;
    // ✨全消し「昇華」も同じ門をくぐらせる。ここも実績経由で💎が出るので、
    // {perfectClears:20} だけを連投して実績を取れないようにする。
    s.perfectClears = (s.perfectClears || 0) + perfectClears;
  }
  const newWaveBest = mode === 'survival' && realPlay && wave > (s.survivalWave || 0);
  if (newWaveBest) s.survivalWave = wave;
  if (mode === 'sprint') s.sprintPlays = (s.sprintPlays || 0) + 1;
  if (mode === 'coop') s.coopPlays = (s.coopPlays || 0) + 1;
  // Lifetime counters (v2.6) — cheap monotonic stats that power achievements.
  if (won) s.totalWins = (s.totalWins || 0) + 1;
  s.playSecs = (s.playSecs || 0) + duration;
  if (mode === 'boss' && won) s.bossKills = (s.bossKills || 0) + 1;
  if (mode === 'chaos') s.chaosPlays = (s.chaosPlays || 0) + 1;
  if (mode === 'meltdown') s.meltdownPlays = (s.meltdownPlays || 0) + 1;
  if (mode === 'chimera') s.chimeraPlays = (s.chimeraPlays || 0) + 1;
  if (mode === 'survival') s.survivalPlays = (s.survivalPlays || 0) + 1;
  if (mode === 'weekly') s.weeklyPlays = (s.weeklyPlays || 0) + 1;
  // Rolling score history powers the profile dashboard chart.
  if (!Array.isArray(s.history)) s.history = [];
  s.history.push({ t: Date.now(), m: String(mode).slice(0, 16), s: score, w: won ? 1 : 0 });
  if (s.history.length > 40) s.history = s.history.slice(-40);
  let badge = null;
  let gems = 0;
  // Ranked-duel win streak: bonus coins that grow with the streak.
  let streakBonus = 0;
  if (mode === 'pvp') {
    if (won) {
      s.winStreak = (s.winStreak || 0) + 1;
      if (s.winStreak > (s.winStreakBest || 0)) s.winStreakBest = s.winStreak;
      if (s.winStreak >= 2) {
        streakBonus = Math.min(200, s.winStreak * 20);
        coins += streakBonus;
        user.coins += streakBonus;
      }
    } else if (!drew) {
      s.winStreak = 0;
    }
  }
  if (mode.startsWith('ai') && won) s.aiWins += 1;
  if (mode === 'ai_oni' && won && !user.badges.includes('oni')) {
    user.badges.push('oni');
    badge = 'oni';
  }
  if (mode === 'ai_kami' && won && !user.badges.includes('kami')) {
    user.badges.push('kami');
    badge = 'kami';
  }
  if (mode === 'ai_souzou' && won && !user.badges.includes('souzou')) {
    user.badges.push('souzou');
    badge = 'souzou';
  }
  // Boss rush: clear all bosses back-to-back for a badge + one-time gems.
  if (mode === 'boss_rush' && won && !user.badges.includes('rush')) {
    user.badges.push('rush');
    badge = 'rush';
    gems = 300;
    user.gems += 300;
  }
  // Tournament: first championship earns a badge + one-time gems.
  if (mode === 'tournament' && won && !user.badges.includes('tourney')) {
    user.badges.push('tourney');
    badge = 'tourney';
    gems += 100;
    user.gems += 100;
  }
  // Battle royale: first #1 finish out of 100 earns a badge + one-time gems.
  if (mode === 'royale' && won && !user.badges.includes('royale')) {
    user.badges.push('royale');
    badge = 'royale';
    gems += 150;
    user.gems += 150;
  }
  // Time attack: one personal best per duration.
  if (mode === 'sprint') {
    const dur = [60, 180].includes(Number(sprintDur)) ? Number(sprintDur) : 60;
    s.sprint = s.sprint || {};
    const key = `s${dur}`;
    if (score > (s.sprint[key] || 0)) s.sprint[key] = score;
  }
  // Weekly challenge: per-week personal best.
  if (mode === 'weekly') {
    const w = weekIdOf(currentWeekNum());
    if (!s.weekly || s.weekly.week !== w) s.weekly = { week: w, best: 0 };
    if (score > s.weekly.best) s.weekly.best = score;
  }
  // 📅 デイリーチャレンジ: その日の最初の1回だけが記録（以降は練習扱い —
  // コインやミッションは普通に付くが、ランキングとストリークは動かない）。
  //
  // 敵対的レビューで出た2つの穴をここで塞ぐ:
  //   1. 日跨ぎ: 提出は「走った盤面の日」(クライアントが /api/daily で受けた
  //      day を送り返す) に記録する。23:58に始めて0:02に終わった回が翌日の
  //      1回ぶんを焼いたり、前日の丸暗記シードで翌日のボードに載ったりしない。
  //   2. 放棄リトライ: /api/daily/start が開始時点で挑戦を消費し attemptId を
  //      発行する。記録済み(pending)の日は、その attemptId を持つ提出だけが
  //      スコアを確定できる — リロードで何度でもやり直す抜け道は、開始した
  //      瞬間に「0点で消費済み」になることで消える。
  let daily = null;
  // 📅 この提出で追い抜いたフレンド（通知はこの関数の終わりでまとめて送る）。
  let overtook = null;
  if (mode === 'daily') {
    s.dailycPlays = (s.dailycPlays || 0) + 1;
    const today = jstDayKey();
    const yst = jstDayKey(Date.now() - 86400000);
    const claimed = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : today;
    const claimedAttempt = String(attemptId || '').slice(0, 64);
    const cur = s.dailyc;
    // 記録先の日。今日の盤面は今日へ。昨日の盤面は「昨日 pending 済み」
    // （＝日跨ぎで走っていた回）のときだけ昨日へ。それ以外の古い盤面は練習。
    const recordDay = claimed === today ? today
      : (claimed === yst && cur && cur.day === yst && cur.pending) ? yst
      : null;
    const finalize = (recDay, prevStreak) => {
      // 30ピースの理論値をはるかに越える申告は、その日のボードを永久占拠する
      // だけなので頭を押さえる（コイン等は共通経路の別クランプが既に見ている）。
      const recScore = Math.min(score, DAILYC_MAX_SCORE);
      // 追い抜き判定は「書き換える前の自分の点数」が要る（/api/daily/start が
      // 作る予約は score:0 なので、たいていは 0）。
      const prevScore = cur && cur.day === recDay ? (Number(cur.score) || 0) : 0;
      const target = dailyTargetOf(recDay);
      const cleared = recScore >= target;
      const streak = cleared ? prevStreak + 1 : 0;
      s.dailyc = { day: recDay, score: recScore, cleared, streak };
      if (streak > (s.dailycBestStreak || 0)) s.dailycBestStreak = streak;
      let bonusCoins = 0, bonusGems = 0;
      if (cleared) {
        // ログインボーナスと同じ倍率カーブ（連続日数で最大3倍）。
        const mult = Math.min(3, 1 + (streak - 1) * 0.35);
        bonusCoins = Math.round(DAILYC_COINS * mult);
        bonusGems = Math.round(DAILYC_GEMS * mult);
        if (dailyModifierOf(recDay).id === 'gold') bonusCoins *= 2;   // 💰 黄金の日
        coins += bonusCoins;
        user.coins += bonusCoins;
        gems += bonusGems;
        user.gems += bonusGems;
      }
      // 7日連続クリアで永久バッジ（一度きりのジェムボーナスつき）。
      if (streak >= 7 && !user.badges.includes('daily7')) {
        user.badges.push('daily7');
        badge = 'daily7';
        gems += 300;
        user.gems += 300;
      }
      daily = { recorded: true, reason: 'recorded', cleared, streak, target, bonusCoins, bonusGems };
      // 🏁 同じシード・同じピース順なので、追い抜きは純粋に腕の差。抜かれた側に
      // だけ知らせる（抜いた側には出さない ── 煽りの配達経路にしない）。
      const passed = friendsOvertaken(db, user, recDay, recScore, prevScore);
      if (passed.length) overtook = { day: recDay, score: recScore, rows: passed };
    };
    const reservedHere = !!(recordDay && cur && cur.day === recordDay
      && cur.pending && claimedAttempt && claimedAttempt === cur.pending);
    // 予約は2時間で切れる。切らないと、予約だけ取って一晩シードを研究し、
    // 覚えた盤面の最高記録をあとから提出できてしまう。
    const fresh = reservedHere && Date.now() - (cur.at || 0) <= DAILYC_ATTEMPT_MS;
    if (reservedHere && fresh) {
      // start で消費済みの挑戦を、本人の完走だけが確定できる。
      finalize(recordDay, cur.prevStreak || 0);
    } else if (reservedHere) {
      daily = { recorded: false, reason: 'expired', cleared: false, streak: 0, target: dailyTargetOf(recordDay), bonusCoins: 0, bonusGems: 0 };
    } else if (recordDay && cur && cur.day === recordDay) {
      // 予約済みの日の、予約と結びつかない提出＝練習。放棄した回の0点も
      // ここで確定したまま動かない（それが「開始で消費」の意味）。
      daily = { recorded: false, reason: 'practice', cleared: !!cur.cleared, streak: cur.streak || 0, target: dailyTargetOf(recordDay), bonusCoins: 0, bonusGems: 0 };
    } else if (recordDay === today) {
      // /api/daily/start を経ていない提出。ここを「その日の最初の1回」として
      // 記録していたころ、提出せずにリロードすれば同じシードを何度でも
      // 引き直せた（開始を登録しない限り挑戦が減らないため）。予約の無い
      // 申告は記録しない — これが放棄リトライを塞ぐ本体。
      daily = { recorded: false, reason: 'unreserved', cleared: false, streak: 0, target: dailyTargetOf(today), bonusCoins: 0, bonusGems: 0 };
    } else {
      // 日付の合わない盤面（古いタブ等）は記録しない — 今日の1回は残る。
      daily = { recorded: false, reason: 'stale', cleared: false, streak: 0, target: dailyTargetOf(today), bonusCoins: 0, bonusGems: 0 };
    }
  }
  // メルトダウン / キメラ工房: per-mode personal bests.
  if (mode === 'meltdown' && score > (s.meltdownBest || 0)) s.meltdownBest = score;
  if (mode === 'chimera' && score > (s.chimeraBest || 0)) s.chimeraBest = score;
  // 🧩 パズル遺跡: highest stage cleared + first-clear badge at stage 50.
  // stage/depth are client-declared (same trust level as floor/wave) — the gem
  // faucet is bounded like the dungeon's: decade payouts stop at stage 100, and
  // the stored stat is capped so a forged request can't own the leaderboard.
  if (mode === 'puzzle') {
    s.puzzlePlays = (s.puzzlePlays || 0) + 1;
    const st = Math.min(stage, 999);
    if (won && st > (s.puzzleStage || 0)) {
      const decades = Math.floor(Math.min(st, 100) / 10) - Math.floor(Math.min(s.puzzleStage || 0, 100) / 10);
      if (decades > 0) {
        gems += decades * 25;
        user.gems += decades * 25;
      }
      s.puzzleStage = st;
      if (st >= 50 && !user.badges.includes('puzzle')) {
        user.badges.push('puzzle');
        badge = 'puzzle';
        gems += 300;
        user.gems += 300;
      }
    }
  }
  // 👻 幽霊屋敷 (hidden): memory-mode best + badge at 15,000.
  if (mode === 'ghost') {
    s.ghostPlays = (s.ghostPlays || 0) + 1;
    if (score > (s.ghostBest || 0)) s.ghostBest = score;
    if (score >= 15000 && !user.badges.includes('ghost')) {
      user.badges.push('ghost');
      badge = 'ghost';
      gems += 250;
      user.gems += 250;
    }
  }
  // ⛏️ 採掘場: deepest dig + first-clear badge at 50m.
  if (mode === 'dig') {
    s.digPlays = (s.digPlays || 0) + 1;
    const dp = Math.min(depth, 999);
    if (dp > (s.digDepth || 0)) {
      s.digDepth = dp;
      if (dp >= 50 && !user.badges.includes('dig')) {
        user.badges.push('dig');
        badge = 'dig';
        gems += 300;
        user.gems += 300;
      }
    }
  }
  // ⛓️ 連鎖カスケード: 遊んだ回数・スコアの自己ベスト・最大連鎖数を記録。
  // score/maxChain はクライアント申告なので、💎ドロップや他の実績原資と同じ
  // 「実プレイの痕跡」(realPlay) を通った回だけ自己ベストを更新する。
  // chainBest は main.js が、chainMax は ach_chain5/10 が読む（chain は
  // scoreboardEligible=false なので通常ハイスコアには載らない → 専用ベストを持つ）。
  if (mode === 'chain') {
    s.chainPlays = (s.chainPlays || 0) + 1;
    if (realPlay && score > (s.chainBest || 0)) s.chainBest = score;
    if (realPlay && maxChain > (s.chainMax || 0)) s.chainMax = maxChain;
  }
  // 🏗️ ブループリント: 遊んだ回数と完成枚数。won は上のブロックで「その日の
  // 初回クリアだけ」に絞られている（丸暗記の再送を弾くため）ので、
  // blueprintClears はその日の初回にだけ増える。
  if (mode === 'blueprint') {
    s.blueprintPlays = (s.blueprintPlays || 0) + 1;
    if (won) s.blueprintClears = (s.blueprintClears || 0) + 1;
  }
  // 🛠️ 工房（遊ぶ側）: 遊んだ回数とクリア数。won は上のブロックで1時間あたりの
  // 上限を通したものだけ（同一ステージ連投の緩衝）。
  if (mode === 'workshop') {
    s.workshopPlays = (s.workshopPlays || 0) + 1;
    if (won) s.workshopClears = (s.workshopClears || 0) + 1;
  }
  // Dungeon tower: track highest floor cleared; gems for each newly reached
  // checkpoint decade, badge + big gem bonus for conquering all 100 floors.
  // The Abyss: the hardest realm — double gems per decade, a badge and a big
  // bonus for the bottom.
  // 4つの世界を1つの表で回す。
  //
  // 以前は 'dungeon' と 'dungeon_abyss' の分岐を手書きで2つ並べているだけで、
  // 地下(dungeon_under)と天国(dungeon_heaven)はどちらの分岐にも入らなかった。
  // メニューには4つ並んでいて、地下は「上級者向け。敵が硬く攻撃も速い」と
  // 書いてあるのに、100階を制覇してもジェム0・バッジ無し・到達階の記録すら
  // 残らない ——「難しいほうを選ぶと損をする」状態だった。
  // 表にしておけば、世界を足したときに報酬を書き忘れることがなくなる。
  const DUNGEON_REALMS = {
    dungeon:         { stat: 'dungeonMax', badge: 'dungeon', perDecade: 20, clear: 500 },
    dungeon_under:   { stat: 'underMax',   badge: 'under',   perDecade: 30, clear: 750 },
    dungeon_heaven:  { stat: 'heavenMax',  badge: 'heaven',  perDecade: 20, clear: 500 },
    dungeon_abyss:   { stat: 'abyssMax',   badge: 'abyss',   perDecade: 40, clear: 1000 },
  };
  // 自前キーのときだけ表を引くヘルパー。プロトタイプ上の名前は必ず null。
  const ownRealm = (m) => (Object.prototype.hasOwnProperty.call(DUNGEON_REALMS, m) ? DUNGEON_REALMS[m] : null);
  // mode はクライアントの自己申告なので、素の添字引きだと Object.prototype の
  // キー名（'constructor' / 'toString' / '__proto__' など）が truthy を返す。
  // 実測: mode:'constructor' を1回送るだけで realm が Object 関数になり、
  //   realm.perDecade が undefined → user.gems += NaN
  //   realm.stat    が undefined → s['undefined'] という永久ゴミキー
  //   realm.badge   が undefined → badges に null が混入
  // NaN になった残高は migrateUser の Number.isFinite ガードで 0 に潰され、
  // 💎5,200 が db.json ごと消えた（復旧不能）。自前キーだけを見る。
  const realm = ownRealm(mode);
  if (realm) {
    const fl = Math.max(0, Math.min(100, Math.floor(Number(floor) || 0)));
    const prevMax = s[realm.stat] || 0;
    if (fl > prevMax) {
      const decades = Math.floor(fl / 10) - Math.floor(prevMax / 10);
      if (decades > 0) {
        gems += decades * realm.perDecade;
        user.gems += decades * realm.perDecade;
      }
      s[realm.stat] = fl;
    }
    if (fl >= 100 && !user.badges.includes(realm.badge)) {
      user.badges.push(realm.badge);
      badge = realm.badge;
      gems += realm.clear;
      user.gems += realm.clear;
    }
  }
  // Boss battles: sequential progression + first-clear gem bonus + clear rank.
  if (mode === 'boss') {
    const idx = BOSSES.findIndex(b => b.id === extraBossId);
    if (idx !== -1 && won) {
      // 解放の進み具合（bossMax）と、初回討伐ボーナスを別々に持つ。
      // 以前は同じ数字で兼ねていたので、順番を飛ばして上のボスを先に倒すと
      // 下のボスのボーナスが未払いのまま永久に取れなくなっていた。
      // 引き継ぎは bossMax を進める「前」にやる。あとにすると、いま倒した
      // ボスまで「受け取りずみ」に含まれてしまい、初回ボーナスが消える。
      if (!s.bossFirst || typeof s.bossFirst !== 'object') {
        // 順番どおりに進んだ人はすでに受け取っているので、
        // これまでの bossMax より下は「受け取りずみ」として扱う（二重払い防止）。
        s.bossFirst = {};
        for (let i = 0; i < (s.bossMax || 0); i++) if (BOSSES[i]) s.bossFirst[BOSSES[i].id] = true;
      }
      if (idx >= (s.bossMax || 0)) s.bossMax = idx + 1;
      if (!s.bossFirst[BOSSES[idx].id]) {
        s.bossFirst[BOSSES[idx].id] = true;
        gems = BOSSES[idx].gemsFirst;
        user.gems += gems;
      }
      if (BOSSES[idx].id === 'maou' && !user.badges.includes('maou')) {
        user.badges.push('maou');
        badge = 'maou';
      }
      // 討伐ランク: ボスごとに最高ランクを保存（S > A > B > C）。
      if (rank) {
        if (!s.bossRanks || typeof s.bossRanks !== 'object') s.bossRanks = {};
        const order = { S: 4, A: 3, B: 2, C: 1 };
        if ((order[rank] || 0) > (order[s.bossRanks[extraBossId]] || 0)) s.bossRanks[extraBossId] = rank;
      }
    }
  }
  // 無限地獄ラッシュ: 深度（累計撃破数）のベストを記録。
  if (mode === 'boss_rush' && depth > (s.rushDepth || 0)) s.rushDepth = depth;
  // ---- Live feed + crowd reactions for notable real moments ----
  const feedNotes = [];
  const nm = user.username;
  if (scoreboardEligible && score > prevBest && prevBest > 0 && score >= 8000) {
    feedNotes.push({ icon: '⭐', ja: `${nm} が自己ベスト ${fmtNum(score)} 点を更新！`, en: `${nm} set a new best: ${score.toLocaleString('en-US')}!`,
      react: score >= 30000 ? ['record', { you: nm, score: fmtNum(score) }] : null });
  }
  if (maxCombo >= 10 && maxCombo > prevCombo) {
    feedNotes.push({ icon: '🔥', ja: `${nm} が ${maxCombo} コンボを達成！`, en: `${nm} landed a ${maxCombo} combo!` });
  }
  if (mode === 'tournament' && won) {
    feedNotes.push({ icon: '🏆', ja: `${nm} がトーナメントで優勝！`, en: `${nm} won the tournament!`, react: ['champion', { you: nm }] });
  } else if (mode === 'royale' && won) {
    feedNotes.push({ icon: '💯', ja: `${nm} がバトルロイヤルで1位！`, en: `${nm} took #1 in battle royale!`, react: ['royale_win', { you: nm }] });
  } else if (mode === 'ai_souzou' && won) {
    feedNotes.push({ icon: '🌌', ja: `${nm} が 創造神 を超えた！！！`, en: `${nm} surpassed the Creator God!!!` });
  } else if (mode === 'ai_kami' && won) {
    feedNotes.push({ icon: '🔱', ja: `${nm} が 神 を討伐！！`, en: `${nm} slew the Kami AI!!` });
  } else if (mode === 'ai_oni' && won) {
    feedNotes.push({ icon: '👹', ja: `${nm} が 鬼AI を撃破！`, en: `${nm} crushed the Oni AI!` });
  }
  if (badge && mode !== 'tournament' && mode !== 'royale') {
    const bn = BADGE_NAMES[badge] || badge;
    feedNotes.push({ icon: BADGE_ICONS[badge] || '🎖️', ja: `${nm} が「${bn}」を獲得！`, en: `${nm} earned "${BADGE_NAMES_EN[badge] || badge}"!`,
      // 言語中立で渡す（renderSlot が英語面では nameEn を選ぶ）
      react: ['badge', { you: nm, badge: { name: bn, nameEn: BADGE_NAMES_EN[badge] || badge } }] });
  }
  if (mode === 'boss' && won && gems > 0 && extraBossId) {
    const b = BOSSES.find(x => x.id === extraBossId);
    if (b) feedNotes.push({ icon: '🐲', ja: `${nm} が ${b.name} を初討伐！`, en: `${nm} defeated ${b.nameEn || b.name} for the first time!` });
  }
  // 到達フィードの「前回どこまで行ったか」を世界ごとに持つ。共通の1個だと、
  // 地下でB100まで行ったあと塔でF100に着いても『もう到達済み』扱いになり、
  // 速報が出なくなっていた。
  // 既知の4レルムだけがキーを作る。以前は startsWith('dungeon') で判定して
  // いたので、'dungeon' で始まる任意の申告が `${mode}Prev` という新しい
  // 永続キーを生み、stats を際限なく太らせられた。
  const prevKey = ownRealm(mode) ? `${mode}Prev` : null;
  const prevFloor = prevKey ? (s[prevKey] != null ? s[prevKey] : (mode === 'dungeon' ? s.dungeonPrev || 0 : 0)) : 0;
  if (prevKey && floor >= 10 && Math.floor(floor / 10) > Math.floor(prevFloor / 10)) {
    feedNotes.push({ icon: '🏰', ja: `${nm} がダンジョン F${Math.floor(Number(floor) || 0)} に到達`, en: `${nm} reached dungeon F${Math.floor(Number(floor) || 0)}` });
  }
  if (newWaveBest && wave >= 10) feedNotes.push({ icon: '💀', ja: `${nm} がサバイバル WAVE ${wave} に到達`, en: `${nm} survived to wave ${wave}` });
  if (mode === 'sprint' && score >= 8000 && s.sprint && score >= (s.sprint[`s${[60, 180].includes(Number(sprintDur)) ? sprintDur : 60}`] || 0)) {
    feedNotes.push({ icon: '⏱️', ja: `${nm} がタイムアタック${sprintDur === 180 ? '3分' : '60秒'}で ${fmtNum(score)} 点！`, en: `${nm} scored ${score.toLocaleString('en-US')} in the ${sprintDur === 180 ? '3 min' : '60s'} time attack!` });
  }
  if (prevKey) s[prevKey] = Math.max(prevFloor, Math.floor(Number(floor) || 0));
  postRealFeed(user, feedNotes);
  notifyDailyOvertaken(user, overtook);

  // Daily / weekly missions advance off the same event.
  const missionsCompleted = trackMissions(user, currentWeekNum(), {
    mode, score, maxCombo, lines, won: !!won,
    floors: ownRealm(mode) ? floors : 0,
    // Survival missions must not advance from other modes' stray wave fields.
    wave: mode === 'survival' ? wave : 0,
    stage: mode === 'puzzle' ? stage : 0,
    depth: mode === 'dig' ? depth : 0,
    // ⛓️ 連鎖数ベースのお題用。missions.js の contributions が maxChain を
    // 受ける（chain 以外は 0）。他モードの stray な maxChain を混ぜないよう
    // ここでも mode でゲートする。
    maxChain: mode === 'chain' ? maxChain : 0,
    ults, items, pieces,
  });
  saveDb();
  refreshThrones(true);   // 👑 did this run take (or defend) a #1 spot?
  return {
    coins, bpXp, accXp, score, badge, gems: gems + eventGems,
    streak: s.winStreak || 0, streakBonus,
    missionsCompleted,
    eventCoins, eventGems,
    guildPts, guildBonus,
    daily,
  };
}

// Real players' notable moments go on the live feed (starred), and the crowd
// may react. Capped per user so a hot streak doesn't flood the ticker.
const BADGE_ICONS = { oni: '👹', kami: '🔱', souzou: '🌌', maou: '😈', rush: '⚔️', dungeon: '🏰', under: '🕳️', heaven: '☁️', abyss: '🌑', zero: '👁️', tourney: '🏆', royale: '💯', adminevent: '👑', weekly1: '🏅', puzzle: '🧩', dig: '⛏️', crown2: '👑', crown3: '👑', crown5: '👑', crown7: '🌈', ghost: '👻', daily7: '📅' };
const BADGE_NAMES_EN = { oni: 'Oni Slayer badge', kami: 'God Slayer badge', souzou: 'Creator Slayer badge', maou: 'Demon Lord badge', rush: 'Boss Rush Clear', dungeon: 'Tower Conqueror', under: 'Depths Conqueror', heaven: 'Ascent Conqueror', abyss: 'Abyss Conqueror', zero: 'Condemned', tourney: 'Tournament Champion', royale: 'Royale #1', adminevent: 'Admin Event', weekly1: 'Weekly Champion', puzzle: 'Ruins Master', dig: 'Master Miner', crown2: 'Dual Crown', crown3: 'Triple Crown', crown5: 'Five Crowns', crown7: 'Total Domination', ghost: 'Haunted House', daily7: 'Daily Devotee' };
const feedAt = new Map();   // userId -> last feed timestamp
function postRealFeed(user, notes) {
  if (!notes.length) return;
  // battle は下のほうで作られる const なので、起動処理の途中から結果を
  // 通されると TDZ で落ちる。すぐ下の notifyDailyOvertaken は同じガードを
  // 持っているのに、ここだけ素で battle.crowd を触っていた。
  if (!battleReady || !battle.crowd) return;
  const last = feedAt.get(user.id) || 0;
  // Always let the rarest moments through; throttle the ordinary ones.
  const big = notes.filter(n => n.react);
  const now = Date.now();
  const allowed = big.length ? big.concat(notes.filter(n => !n.react)).slice(0, 2)
    : now - last < 45000 ? [] : notes.slice(0, 1);
  if (!allowed.length) return;
  feedAt.set(user.id, now);
  for (const n of allowed) {
    battle.crowd.feed({ icon: n.icon, real: true, who: user.username, text: n.ja, textEn: n.en });
    if (n.react) battle.crowd.react(n.react[0], n.react[1]);
  }
}

// 📅 デイリーで追い抜かれた人にだけ、その場で知らせる。
//
// 送るのは既存の presence 経路（フレンド申請と同じ socket）で、文面は運営の
// 'announce'（クライアントが日英を出し分ける唯一の共通型）。新しい保存も
// 新しいポーリングも増やさない。
//
// フレンド上限は100人。全員を抜いた回に100通投げるのは通知としても処理としても
// 過剰なので、僅差の相手（friendsOvertaken が点数の高い順に並べてくれている ＝
// 「すぐ下にいた人」）から数人だけに絞る。
const DAILY_OVERTAKE_NOTIFY_MAX = 5;
function notifyDailyOvertaken(user, overtook) {
  if (!overtook || !overtook.rows.length) return;
  if (!battleReady || !battle.presence) return;
  for (const row of overtook.rows.slice(0, DAILY_OVERTAKE_NOTIFY_MAX)) {
    battle.presence.sendToUser(row.user.id, {
      type: 'announce',
      message: `🏁 ${user.username} が今日のデイリーであなたを抜きました（${fmtNum(overtook.score)}点）。同じ盤面・同じピース順です — 抜き返しますか？`,
      messageEn: `🏁 ${user.username} passed you on today's Daily (${overtook.score.toLocaleString('en-US')} pts). Same board, same pieces — care to take it back?`,
      from: '運営',
    }, { primaryOnly: true });
  }
}

// Simple in-memory rate limiter (per key, sliding window).
// Keyed by IP (and by user for some routes), so on a long-lived instance this
// grew for every address that ever touched the server and never shrank. Both
// this and feedAt are swept on a slow timer.
const rateMap = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { rateMap.set(key, arr); return false; }
  arr.push(now);
  rateMap.set(key, arr);
  return true;
}

setInterval(() => {
  const now = Date.now();
  // Nothing here has a window longer than an hour.
  for (const [k, arr] of rateMap) {
    if (!arr.length || now - arr[arr.length - 1] > 3600_000) rateMap.delete(k);
  }
  for (const [k, at] of feedAt) {
    if (now - at > 3600_000) feedAt.delete(k);
  }
  // 🔑 ログアウト済みトークン表も同じ理由でここに相乗りさせる（掃除が
  // revokeToken の中にしか無かったので、誰もログアウトしない期間は1件も
  // 減らなかった）。落ちる行が無ければ保存もしない。
  try {
    const swept = sweepRevoked();
    if (swept) console.log(`[auth] 失効済みトークンを${swept}件掃除しました`);
  } catch (err) { console.error('[auth] トークン掃除に失敗:', err && err.message); }
  // 📅 イベント自動運行。/api/status からも呼んでいるが、誰も画面を開いて
  // いない時間帯に枠(18:00 JST)へ入る日のために、こちらでも点火を見る。
  // 自動運行OFF（既定）なら比較1回で戻るだけ。
  try { syncAutoEvent(); } catch (err) { console.error('[events] 自動開催に失敗:', err && err.message); }
}, 600_000).unref?.();

// 🛠 メンテナンスのスイッチが入った時刻。db には残さない（この機体が
// 「いま止めているか」だけの運用状態で、backup.js も maintenance は
// 持ち込まない）。起動時にすでに ON だった場合は、最初の判定の時刻＝
// この機体でメンテが始まった時刻として扱う。
let maintenanceSince = 0;
function inMaintenance() {
  const on = !!db.meta.maintenance;
  if (on !== (maintenanceSince > 0)) maintenanceSince = on ? Date.now() : 0;
  return on;
}

// Moderators (or admins): chat policing only — no economy/user management.
function requireMod(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'mod')) {
    return res.status(403).json({ error: 'モデレーター権限が必要です' });
  }
  next();
}

// Blocks gameplay/economy endpoints for non-admins during maintenance.
function maintenanceGuard(req, res, next) {
  if (inMaintenance() && (!req.user || req.user.role !== 'admin')) {
    return res.status(503).json({ error: '🛠 メンテナンス中です。しばらくお待ちください' });
  }
  next();
}

// 結果送信だけは「猶予つき」で通す。
//
// メンテナンスのスイッチは押した瞬間に効くので、これまでは、そのとき遊んで
// いた全員の **まだ送っていない1回** が 503 で落ちていた（報酬ゼロ、📅デイリーは
// 予約だけ残って0点確定）。告知はチャット欄に1行積まれるだけでゲーム画面には
// 出ないため、プレイヤーには何が起きたのか分からない。
//
// 結果送信は「これから新しく遊び始める入口」ではなく「もう終わった1回の
// 着地点」なので、スイッチを入れてしばらくのあいだ通しても、新しい負荷も
// 不整合も増えない（着地しきったぶんだけバックアップの中身が正しくなる）。
// 猶予が切れたあとは今までどおり 503。
const MAINTENANCE_RESULT_GRACE_MS = 3 * 60 * 1000;
function maintenanceResultGuard(req, res, next) {
  if (inMaintenance() && maintenanceSince && Date.now() - maintenanceSince < MAINTENANCE_RESULT_GRACE_MS) {
    return next();
  }
  return maintenanceGuard(req, res, next);
}

const DAILY_COINS = 100;
const DAILY_GEMS = 5;

// Grant the once-per-day login bonus. Returns the bonus or null.
// Daily login bonus. Consecutive days build a streak that scales the reward
// (day 7 and beyond pay roughly triple day 1) — missing a day resets it.
function grantDaily(user) {
  // UTC の日付で判定していたので、日本のプレイヤーにとっては「日付が変わる」
  // のが朝9時だった（深夜にログインしても前日扱い、朝9時に急に切り替わる）。
  // 保存形式は 'YYYY-MM-DD' のままなので、移行もデータ変更も要らない。
  const today = jstDayKey();
  if (user.lastDaily === today) return null;
  migrateUser(user);
  const yesterday = jstDayKey(Date.now() - 86400000);
  const s = user.stats;
  s.loginStreak = user.lastDaily === yesterday ? (s.loginStreak || 0) + 1 : 1;
  if (s.loginStreak > (s.loginStreakBest || 0)) s.loginStreakBest = s.loginStreak;
  s.dailyLogins = (s.dailyLogins || 0) + 1;   // lifetime total, streak-independent
  user.lastDaily = today;
  const mult = Math.min(3, 1 + (s.loginStreak - 1) * 0.35);
  let coins = Math.round(DAILY_COINS * mult);
  let gems = Math.round(DAILY_GEMS * mult);
  // 👑 王座の俸給 — a throne holder collects extra with every daily bonus.
  // 多冠は段階ボーナス上乗せ（2冠+200🪙3💎 / 3冠+400🪙6💎 / 5冠+800🪙12💎 / 7冠+1600🪙24💎）。
  const thrones = thronesOf(user.id);
  let throneBonus = null;
  if (thrones.length) {
    const n = thrones.length;
    const tier = n >= 7 ? { coins: 1600, gems: 24, name: '全冠制覇' }
      : n >= 5 ? { coins: 800, gems: 12, name: '五冠' }
      : n >= 3 ? { coins: 400, gems: 6, name: '三冠' }
      : n >= 2 ? { coins: 200, gems: 3, name: '二冠' } : null;
    throneBonus = {
      coins: THRONE_DAILY_COINS * n + (tier ? tier.coins : 0),
      gems: THRONE_DAILY_GEMS * n + (tier ? tier.gems : 0),
      boards: thrones, tier: tier ? tier.name : null,
    };
    coins += throneBonus.coins;
    gems += throneBonus.gems;
  }
  user.coins += coins;
  user.gems += gems;
  saveDb();
  return { coins, gems, streak: s.loginStreak, throneBonus };
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 16).replace(/[<>"'`]/g, '');
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

app.post('/api/register', (req, res) => {
  if (!rateLimit(`auth:${req.ip}`, 20, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
  }
  if (inMaintenance()) return res.status(503).json({ error: '🛠 メンテナンス中です。しばらくお待ちください' });
  const username = sanitizeName(req.body.username);
  const password = String(req.body.password || '');
  if (!/^[\w\-ぁ-んァ-ヶ一-龠ー]{2,16}$/u.test(username)) {
    return res.status(400).json({ error: 'ユーザー名は2〜16文字（英数字・日本語）で入力してください' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  }
  // ⚠ 名前が使えない理由は **絶対に出し分けない**。
  //   ① すでに実プレイヤーが使っている
  //   ② AI住人と同名（チャットの返信/プロフィールで人間と区別がつかなくなる）
  //   ③ 予約名（👁️管理者ゼロ を騙れると、イベント中に偽の宣告を撒ける）
  // 以前は①②③で文言が違ったので、名前を投げ分けるだけで「これは住人」
  // 「これは実在プレイヤー」が判定できた ── 名簿を総当たりすれば住人が
  // 全員あぶり出せる列挙オラクルだった。同じ 409・同じ文言に統一する。
  const NAME_TAKEN = 'そのユーザー名は既に使われています';
  const exists = Object.values(db.users).some(u => u.username.toLowerCase() === username.toLowerCase());
  const isResident = !!residentByName(username);
  const isReserved = RESERVED_NAMES.some(n => n.toLowerCase() === username.toLowerCase());
  if (exists || isResident || isReserved) return res.status(409).json({ error: NAME_TAKEN });

  const user = newUser(username, password);
  const token = issueToken(user.id);
  // New arrivals show up on the live feed (real players are starred).
  battle.crowd.feed({ icon: '👋', real: true, who: user.username,
    text: `${user.username} が新しく参加しました！ようこそ！`, textEn: `${user.username} just joined — welcome!` });
  res.json({ token, user: publicUser(user) });
});

// Live feed snapshot (the menu ticker also receives pushes over the chat socket).
app.get('/api/feed', (_req, res) => {
  res.json({ feed: battle.crowd.feedHistory().slice(-30) });
});

app.post('/api/login', (req, res) => {
  if (!rateLimit(`auth:${req.ip}`, 20, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
  }
  const username = sanitizeName(req.body.username);
  const password = String(req.body.password || '');
  const user = Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.salt, user.passHash)) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  if (user.banned) return res.status(403).json({ error: 'このアカウントは凍結されています' });
  if (inMaintenance() && user.role !== 'admin') {
    return res.status(503).json({ error: '🛠 メンテナンス中です。しばらくお待ちください' });
  }
  const token = issueToken(user.id);
  const dailyBonus = grantDaily(user);
  res.json({ token, user: publicUser(user), dailyBonus });
});

app.post('/api/logout', requireAuth, (req, res) => {
  revokeToken(req.token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user && req.token) {
    // A signed session whose account is not here (yet): the client keeps the
    // token and re-attaches by itself once the data is restored.
    if (req.tokenStatus === 'missing') {
      // settled: the seed auto-restore has ALREADY run and this account still
      // isn't in it — it was created after the last backup and is not coming
      // back. The client stops waiting and offers a fresh start instead of
      // showing 復元待ち forever.
      return res.status(401).json({ error: 'アカウントのデータが見つかりません（データ復元待ち）', code: 'NO_USER', settled: !!db.meta.seedHash, season: currentSeason() });
    }
    // Logged out elsewhere, deleted, expired, or signed with another secret.
    return res.status(401).json({ error: 'セッションが終了しました。もう一度ログインしてください', code: 'SESSION_ENDED', season: currentSeason() });
  }
  finalizeWeeklyRankings();
  const dailyBonus = req.user && !req.user.banned ? grantDaily(req.user) : null;
  res.json({ user: publicUser(req.user), season: currentSeason(), dailyBonus, maintenance: inMaintenance() });
});

// Change own username (once per 24h; admins exempt from the cooldown).
app.post('/api/me/rename', requireAuth, (req, res) => {
  const user = req.user;
  const username = sanitizeName(req.body.username);
  if (!/^[\w\-ぁ-んァ-ヶ一-龠ー]{2,16}$/u.test(username)) {
    return res.status(400).json({ error: 'ユーザー名は2〜16文字（英数字・日本語）で入力してください' });
  }
  if (username.toLowerCase() !== user.username.toLowerCase()) {
    // /api/register とまったく同じ扱い ── 理由を出し分けると、こちらが
    // 住人の列挙オラクルとして残る（登録だけ塞いでも改名で総当たりできる）。
    const exists = Object.values(db.users).some(u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase());
    const isResident = !!residentByName(username);
    const isReserved = RESERVED_NAMES.some(n => n.toLowerCase() === username.toLowerCase());
    if (exists || isResident || isReserved) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
  }
  const DAY = 24 * 60 * 60 * 1000;
  if (user.role !== 'admin' && user.lastRename && Date.now() - user.lastRename < DAY) {
    const left = Math.ceil((user.lastRename + DAY - Date.now()) / 3600000);
    return res.status(429).json({ error: `名前変更は1日1回までです（あと約${left}時間）` });
  }
  if (username === user.username) return res.status(400).json({ error: '現在と同じ名前です' });
  user.username = username;
  user.lastRename = Date.now();
  saveDb();
  res.json({ user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// 📦 ゲスト時代の記録の引き継ぎ（1アカウント1回だけ）
//
// ゲストの記録はブラウザの localStorage にしか無いので、値は全部クライアント
// 申告になる。だから引き継げるものは厳しく絞ってある:
//
//   ・通貨とジェムは引き継がない。引き継げるようにした瞬間、この口が
//     「好きなだけ通貨を生む窓」になる。
//   ・ハイスコアは **ランキングに載る stats キーには絶対に書かない**。
//     ランキング／👑王座が読むのは bestScore・rating・dungeonMax・
//     weekly.best・sprint.s60/s180・puzzleStage・digDepth・dailyc.score。
//     引き継いだ値はこれらと混ぜず、stats.guestImport という別の入れ物に
//     「表示用のベスト」として置くだけにする（各モードの画面が
//     localStorage と同じ扱いで参照できる）。
//   ・すべてクランプ。1回しか通らないとはいえ、桁の壊れた値を永久に
//     持たせない。
//   ・1アカウント1回。2回目は409（済みフラグは user.stats に残す）。
// ---------------------------------------------------------------------------

const GUEST_PUZZLE_MAX = 50;
const GUEST_STARS_MAX = 150;
// 🎒 ブースターは「表示用」ではなく実際に在庫が増える唯一の引き継ぎ物なので、
// 上の「通貨は引き継がない」という線の内側に収める必要がある。1種9個 × 非運営
// 4種 = 36個は、ショップ価格に直すと 11,700🪙 相当が申告だけで湧く量だった。
// さらに図鑑の set_boost（各ブースターを1個以上持つ → 1,500🪙+12💎）が
// この在庫だけで解錠されるので、課金通貨にまで届いていた。ゲストの手持ちを
// 尊重する趣旨は残しつつ、換算額が線を越えない水準まで下げる。
const GUEST_ITEM_MAX = 3;
// 引き継げる「自己ベスト」と、その上限。ここに無いキーは黙って捨てる。
const GUEST_BEST_LIMITS = {
  solo: 1_000_000, chaos: 1_000_000, meltdown: 1_000_000, chimera: 1_000_000,
  ghost: 1_000_000, weekly: 1_000_000, daily: 200_000,
  sprint60: 200_000, sprint180: 400_000,
  survivalWave: 999, digDepth: 9999, dungeonMax: 100, rushDepth: 100, bossMax: 12,
};
const GUEST_UNLOCK_KEYS = ['kami', 'souzou', 'ghost'];

app.post('/api/me/import-guest', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`gimport:${req.user.id}`, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '少し待ってください' });
  }
  migrateUser(req.user);
  const user = req.user;
  const s = user.stats;
  if (s.guestImportedAt) {
    return res.status(409).json({ error: 'ゲスト記録の引き継ぎは1アカウント1回だけです（すでに実行済み）', at: s.guestImportedAt });
  }
  const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

  // 🧩 パズル遺跡の進行と★。進行は puzzleStage（ランキング＋王座の値）とは
  // 別枠に置く ── 申告だけで王座が取れてはいけない。
  const puzzleStage = int(b.puzzleStage, GUEST_PUZZLE_MAX);
  const stars = int(b.stars, GUEST_STARS_MAX);

  // 🎒 ブースター。運営専用は対象外、各9個まで。
  const items = {};
  const src = (b.items && typeof b.items === 'object' && !Array.isArray(b.items)) ? b.items : {};
  for (const def of BOOST_ITEMS) {
    if (def.adminOnly) continue;
    const n = int(src[def.id], GUEST_ITEM_MAX);
    if (n > 0) items[def.id] = n;
  }

  // 🔓 隠し難易度の解放フラグ（真偽値だけ）。
  const unlocks = {};
  const usrc = (b.unlocks && typeof b.unlocks === 'object' && !Array.isArray(b.unlocks)) ? b.unlocks : {};
  for (const k of GUEST_UNLOCK_KEYS) if (usrc[k]) unlocks[k] = true;

  // 🏅 各モードの自己ベスト（表示用）。
  const bests = {};
  const bsrc = (b.bests && typeof b.bests === 'object' && !Array.isArray(b.bests)) ? b.bests : {};
  for (const [k, max] of Object.entries(GUEST_BEST_LIMITS)) {
    const n = int(bsrc[k], k === 'bossMax' ? BOSSES.length : max);
    if (n > 0) bests[k] = n;
  }

  // 実際に効く（＝プレイに反映される）のはブースターだけ。あとは表示用。
  user.items = user.items || {};
  let itemsGiven = 0;
  for (const [id, n] of Object.entries(items)) {
    user.items[id] = (user.items[id] || 0) + n;
    itemsGiven += n;
  }
  s.guestImport = { at: Date.now(), puzzleStage, stars, unlocks, bests, items };
  s.guestImportedAt = Date.now();
  saveDb();
  res.json({
    ok: true,
    imported: { puzzleStage, stars, unlocks, bests, items, itemsGiven },
    user: publicUser(user),
  });
});

// Delete own account (password confirmation required).
app.delete('/api/me', requireAuth, (req, res) => {
  const user = req.user;
  const password = String((req.body && req.body.password) || '');
  if (!verifyPassword(password, user.salt, user.passHash)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  if (user.role === 'admin') {
    return res.status(400).json({ error: '管理者アカウントは削除できません（先に権限を外してください）' });
  }
  revokeAllTokens(user.id);
  // Must run BEFORE the record disappears: leaveGuild resolves the remaining
  // members to hand ownership over. Skipping it left a ghost id in
  // guild.members forever — the roster counter said 20/20 and nobody could
  // ever join again, and if the ghost was the owner the guild froze solid.
  leaveGuild(db, user);
  // フレンドも同じ理由で、レコードが消える前に外しておく。
  // やらないと相手のフレンド一覧に二度と現れない id が残り、
  // ギルドのときと同じことが起きる。パーティーからも抜けさせる
  // （リーダーが消えたパーティーが凍る）。
  unfriendAll(db, user);
  if (battleReady && battle.party) battle.party.ejectUser(user.id);
  delete db.users[user.id];
  db.deleted[user.id] = Date.now();
  saveDb();
  res.json({ ok: true });
});

// Limited-time event (admin-controlled), e.g. chaos mode.
//
// An event that runs out of time used to just stop being returned — no
// announcement, and the record sat in db.meta.event forever so every backup
// carried a stale one. Expiry is now noticed on the first read after the fact
// (there is no timer to lose across a restart).
let battleReady = false;

// ---------------------------------------------------------------------------
// 🧾 管理者操作の記録
//
// 🎒インベントリ編集で通貨も権限もバッジも自由に書けるようになった以上、
// 「誰がいつ何を変えたか」がどこにも残らないのは無理がある。アカウントを
// 共有したり、あとでモデレーターを増やしたときに効く。
// パスワードのような値そのものは絶対に残さない（変えた事実だけ）。
// ---------------------------------------------------------------------------
const ADMIN_LOG_MAX = 500;
const SECRET_FIELDS = new Set(['setPassword', 'password', 'passHash', 'salt']);

function adminLog(req, action, target, detail = {}) {
  if (!db.meta.adminLog) db.meta.adminLog = [];
  const safe = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_FIELDS.has(k)) { safe[k] = '(伏せ字)'; continue; }
    if (Array.isArray(v)) safe[k] = v.length > 8 ? `${v.length}件` : v;
    else if (v && typeof v === 'object') safe[k] = `${Object.keys(v).length}項目`;
    else safe[k] = v;
  }
  db.meta.adminLog.push({
    at: Date.now(),
    by: req.user ? req.user.username : '(未ログイン)',
    // IPアドレスは残さない。表示にも判定にも使っていない（管理画面の
    // 🧾操作ログは by / action / target / detail しか描かない）のに、
    // db.meta.adminLog は /api/admin/backup のダンプに丸ごと入り、その
    // ダンプは暗号化されて公開リポジトリにコミットされる。読まれない値の
    // ために、鍵が破られたときの被害面だけを広げていた。
    byId: req.user ? req.user.id : null,
    action,
    target: target || null,
    detail: safe,
  });
  if (db.meta.adminLog.length > ADMIN_LOG_MAX) {
    db.meta.adminLog.splice(0, db.meta.adminLog.length - ADMIN_LOG_MAX);
  }
  saveDb();
}

function currentEvent() {
  const e = db.meta.event;
  if (!e) return null;
  if (e.endsAt > Date.now()) return e;
  if (!e.expiredHandled) {
    e.expiredHandled = true;
    db.meta.event = null;
    saveDb();
    // `battle` is a const initialised near the bottom of this file, so it is in
    // the temporal dead zone during boot — the flag keeps that reference safe.
    if (battleReady) {
      battle.broadcastAll({
        type: 'announce',
        message: `${e.icon || '🌪️'} 期間限定イベント「${e.name}」は終了しました。おつかれさま！`,
        messageEn: `${e.icon || '🌪️'} The limited-time event "${e.nameEn || e.name}" has ended — thanks for playing!`,
        from: '運営',
      });
      battle.crowd.react('event_end');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 📅 イベント自動運行（events.js のカレンダー）
//
// 既定は **OFF**。db.meta.autoEvents が明示的に true のときだけ点火する ——
// 運営が管理画面で有効化するまで、これまでと挙動を1ミリも変えない
// （events.js の autoEventsEnabled は「未設定＝有効」に倒しているが、既存の
//  本番データを勝手にお祭りモードへ切り替えるわけにはいかないので、ここでは
//  明示 true のみを有効とする）。
//
// 【割り込まない】点火するのは db.meta.event が空のときだけ。手動開催
// （/api/admin/event）・投票で決まった開催（applyWinner）・👑管理者イベントが
// 走っているあいだは何もしない。走っているものを上書き・差し替えすることは
// 絶対にない。
function autoEventsOn() { return db.meta.autoEvents === true; }

function syncAutoEvent() {
  if (!autoEventsOn()) return null;
  // currentEvent() は期限切れを片づけて null を返す。走っているものがあるなら
  // （手動でも投票でも自動でも）ここで手を引く。
  if (currentEvent()) return null;
  const ev = makeScheduledEvent(scheduledEventFor(Date.now(), true));
  if (!ev) return null;
  db.meta.event = ev;
  saveDb();
  if (battleReady) {
    battle.broadcastAll({
      type: 'announce',
      message: `${ev.icon} 本日の定期イベント「${ev.name}」が始まりました！ ${ev.desc}`,
      messageEn: `${ev.icon} Today's scheduled event "${ev.nameEn || ev.name}" has begun! ${ev.descEn || ''}`,
      from: '運営',
    });
    battle.crowd.feed({ icon: ev.icon, real: true, who: '運営',
      text: `定期イベント「${ev.name}」が開幕！ ${ev.desc}`,
      textEn: `The scheduled event "${ev.nameEn || ev.name}" is live! ${ev.descEn || ev.desc}` });
    battle.crowd.react('event_start');
  }
  console.log(`[events] 自動開催: ${ev.name} (${ev.type}) — ${new Date(ev.endsAt).toISOString()} まで`);
  return ev;
}

// Public lightweight status (menu online counter + event).
// The client sends its bearer token, so the admin-event block below can be
// personalised (your slot, your countdown) without a second round trip.
app.get('/api/status', (req, res) => {
  refreshThrones();   // polled every ~25s by clients — keeps 👑 takeovers timely
  // 🏛 シーズン切替の検知もここに乗せる。25秒おきに必ず叩かれる口なので、
  // 誰も遊んでいない時間帯に切り替わっても取りこぼさない（同じシーズンなら
  // 比較1回で戻るだけ）。
  settleSeasonHallOfFame();
  // 📅 自動運行の点火もここに乗せる。自動運行OFF（既定）なら比較1回で戻る。
  syncAutoEvent();
  res.json({
    adminEvent: adminEventView(req.user),
    online: battle.displayOnline(),
    activeMatches: battle.displayMatches(),
    queueing: ambientQueue() + battle.queueSize(),
    mood: crowdMood().id,
    maintenance: inMaintenance(),
    // True when SESSION_SECRET is set, i.e. logins survive redeploys.
    sessionsPersist: SESSIONS_PERSIST,
    // db.json の現在のサイズ。外形監視（.github/workflows/watchdog.yml）が
    // このキーを読んでログに出しているのに、公開 /api/status は返していなかった
    // （dbBytes は管理者専用の /api/admin/stats 側にしかなかった）ため、監視ログに
    // 毎回 undefined が並び、本当に壊れたときの見落としにつながる。サイズ自体は
    // 秘匿情報ではないので、ここで返して監視側を成立させる。
    dbBytes: persistMetrics().dbBytes,
    // 💾 復元の天井（バイト）と、db.json がそれを越えていないか。外形監視が
    // 「戻せない大きさに育っている」ことを早期に拾えるよう公開側にも出す
    // （サイズ自体は秘匿情報ではない。dbBytes を既に返しているのと同じ扱い）。
    restoreLimitBytes: RESTORE_MAX_BYTES,
    dbOverRestoreLimit: persistMetrics().dbBytes != null && persistMetrics().dbBytes > RESTORE_MAX_BYTES,
    // 直近の保存が失敗していれば、その事実。null なら書けている。
    // 保存の失敗はこれまで完全に無音で、遊べてしまうぶんだけ気づけなかった
    // （メモリ上は正常なので、次の再起動で初めて「全部消えた」と分かる）。
    // 25秒おきに全クライアントが叩く口なので、ここに出しておけば必ず目に入る。
    // ただし生の fs 例外メッセージは絶対パスや環境情報(ENOSPC ... '/data/db.json'
    // 等)を含みうる。この口は無認証で誰にでも見えるので、一般には保存が失敗して
    // いる事実だけを返し(クライアントの警告表示は truthy で維持)、診断に必要な
    // 生メッセージは管理者にだけ返す。
    persistError: (() => {
      const e = lastPersistError();
      if (!e) return null;
      return (req.user && req.user.role === 'admin') ? e : 'サーバーの保存に問題が発生しています';
    })(),
    event: currentEvent(),
    // 📅 次の自動開催の予告（種類と開始時刻）。自動運行OFFなら null ——
    // 予告だけ出して何も始まらない、という嘘をつかないため。
    nextEvent: autoEventsOn() ? nextScheduledEvent(Date.now(), true) : null,
    // Menu badge only — the full poll (and the caller's own vote) comes from
    // /api/poll, which needs auth to know who is asking.
    poll: db.meta.poll && pollOpen(db.meta.poll)
      ? { id: db.meta.poll.id, question: db.meta.poll.question, questionEn: db.meta.poll.questionEn || null, endsAt: db.meta.poll.endsAt, voterCount: Object.keys(db.meta.poll.voters).length }
      : null,
  });
});

// Wipe everyone's weekly-challenge record (fresh week on demand).
app.post('/api/admin/weekly/reset', requireAuth, requireAdmin, (req, res) => {
  // Pay out any finished week first — deleting stale records here would
  // otherwise silently destroy the ranking rewards they still owe.
  finalizeWeeklyRankings();
  // 全員の週間記録をその場で消す破壊的な操作なのに、退避も記録も無かった。
  // 復元・巻き戻しの経路は必ず pre-restore / pre-rollback を撮ってから走る
  // のに、この経路だけ押した直後に「取り消す」手段が存在しなかった。
  // 撮れなかったとき(null)は応答でそう伝える ── 管理画面は「元に戻せません」を
  // 出せるし、少なくとも運営が知らないまま進むことはなくなる。
  const snap = snapshot(db, 'pre-weeklyreset');
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.stats && u.stats.weekly) { delete u.stats.weekly; affected++; }
  }
  adminLog(req, 'weekly_reset', null, { affected, snapshot: snap || '(失敗)' });   // adminLog が saveDb もする
  saveDb();
  res.json({ affected, snapshot: snap });
});

// ---------------------------------------------------------------------------
// Chat mini-profile: tap a name in chat — works for real players AND the AI
// residents (whose stats come from the same generator as the ghost boards, so
// the card matches what the rankings show).
// ---------------------------------------------------------------------------

app.get('/api/profile/:name', (req, res) => {
  if (!rateLimit(`profile:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください' });
  const name = String(req.params.name || '').slice(0, 20);
  const u = Object.values(db.users).find(x => x.username === name && !x.banned);
  if (u) {
    migrateUser(u);
    const s = u.stats;
    const tl = TITLES.find(x => x.id === u.equippedTitle);
    return res.json({ profile: {
      kind: 'player', name: u.username, role: u.role,
      level: levelOf(u.xp), rating: s.rating, bestScore: s.bestScore,
      pvpWins: s.pvpWins, pvpLosses: s.pvpLosses, dungeonMax: s.dungeonMax || 0,
      badges: u.badges, title: tl ? { id: tl.id, name: tl.name, color: tl.color } : null,
      guildTag: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].tag : null,
      thrones: thronesOf(u.id),
    } });
  }
  const r = residentByName(name);
  const admin = !!(req.user && req.user.role === 'admin');
  if (r && r.registered) {
    const st = residentStats(r, Date.now());
    const a = archetype(r.arch);
    // 🎭 非管理者に返す形は、上の実プレイヤーと **1キーもズレてはいけない**。
    // kind:'resident' はもちろん、archLabel / hours / favMode / online のような
    // 「実プレイヤーには存在しない欄」が1つでも残っていると、そのキーの有無だけで
    // 総当たりできてしまう（関門も落とすが、そもそも組み立てない）。
    // 管理者には従来どおり全部返す ── 名簿の突き合わせに要る。
    return res.json({ profile: {
      kind: admin ? 'resident' : 'player', name: r.name, role: 'user',
      level: st.level, rating: st.rating, bestScore: st.bestScore,
      pvpWins: st.pvpWins, pvpLosses: st.pvpLosses, dungeonMax: st.dungeonMax,
      badges: st.badges, title: st.title,
      guildTag: tagOfName(db, r.name, null),
      thrones: thronesOfName(r.name),
      ...(admin ? {
        archLabel: a.label, archLabelEn: a.labelEn,
        hours: r.hours, favMode: r.favMode,
        online: activeResidents().some(x => x.id === r.id),
      } : {}),
    } });
  }
  // 未登録の住人（＝ロビーには居るがランキングに載らない人）は、実在のゲストと
  // まったく同じ 404 にする。以前はここだけ kind:'guest' の名刺を返していたので、
  // 「404 が返らない名前＝住人」という総当たりの当たり判定になっていた
  // （本物のゲストは db.users にも住人名簿にも居ないので必ず 404）。
  // 管理者にだけは従来どおり名刺を返す。
  if (r && admin) return res.json({ profile: { kind: 'guest', name: r.name } });
  res.status(404).json({ error: 'プレイヤーが見つかりません' });
});

// ---------------------------------------------------------------------------
// Polls (投票)
// ---------------------------------------------------------------------------

// Close an expired poll and announce the result exactly once.
function syncPoll() {
  const poll = db.meta.poll;
  if (tickPoll(poll)) {
    const w = winnerOf(poll);
    battle.broadcastAll({
      type: 'announce',
      message: w
        ? `🗳️ 投票「${poll.question}」終了！ 1位は「${w.text}」（${w.votes}票）${w.tied ? '…同率でした！' : ''}`
        : `🗳️ 投票「${poll.question}」は投票ゼロで終了しました`,
      messageEn: w
        ? `🗳️ Poll "${poll.questionEn || poll.question}" closed! Winner: "${w.textEn || w.text}" (${w.votes} votes)${w.tied ? ' — a tie!' : ''}`
        : `🗳️ Poll "${poll.questionEn || poll.question}" closed with no votes`,
      from: '大会運営',
    });
    if (w) battle.crowd.react('poll_close', { winner: w });   // renderSlot が言語別に text/textEn を選ぶ
    saveDb();
  }
  return poll;
}

app.get('/api/poll', (req, res) => {
  const poll = syncPoll();
  res.json({ poll: pollView(poll, req.user && req.user.id, !!req.user && req.user.role === 'admin') });
});

app.post('/api/poll/vote', requireAuth, maintenanceGuard, (req, res) => {
  const poll = syncPoll();
  if (!poll) return res.status(404).json({ error: '投票は開催されていません' });
  const out = castVote(poll, req.user.id, String(req.body.optionId || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ poll: pollView(poll, req.user.id), changed: out.changed });
});

// Admin: create / close / delete a poll, or launch the winning event.
app.post('/api/admin/poll', requireAuth, requireAdmin, (req, res) => {
  const action = String(req.body.action || 'create');

  if (action === 'close') {
    if (!db.meta.poll) return res.status(404).json({ error: '投票がありません' });
    db.meta.poll.closed = true;
    const w = winnerOf(db.meta.poll);
    battle.broadcastAll({
      type: 'announce',
      message: w ? `🗳️ 投票終了！ 1位は「${w.text}」（${w.votes}票）` : '🗳️ 投票を締め切りました',
      messageEn: w ? `🗳️ Poll closed! Winner: "${w.textEn || w.text}" (${w.votes} votes)` : '🗳️ The poll has been closed',
      from: req.user.username,
    });
    if (w) battle.crowd.react('poll_close', { winner: w });   // renderSlot が言語別に text/textEn を選ぶ
    saveDb();
    return res.json({ poll: pollView(db.meta.poll, req.user.id, true) });
  }

  if (action === 'delete') {
    db.meta.poll = null;
    saveDb();
    return res.json({ poll: null });
  }

  if (action === 'applyWinner') {
    const poll = db.meta.poll;
    if (!poll) return res.status(404).json({ error: '投票がありません' });
    if (poll.kind !== 'event') return res.status(400).json({ error: 'イベント投票ではありません' });
    const w = winnerOf(poll);
    if (!w || !w.eventType) return res.status(409).json({ error: '有効な勝者がいません（投票ゼロ？）' });
    const minutes = Math.max(1, Math.min(14 * 24 * 60, Math.floor(Number(req.body.minutes) || 1440)));
    db.meta.event = makeEvent(w.eventType, '', minutes, req.user.username);
    poll.applied = true;
    poll.closed = true;
    const ev = db.meta.event;
    battle.broadcastAll({
      type: 'announce',
      message: `🗳️→${ev.icon} 投票で選ばれた「${ev.name}」を開催します！ ${ev.desc}`,
      messageEn: `🗳️→${ev.icon} The vote has spoken — "${ev.nameEn || ev.name}" is now live! ${ev.descEn || ''}`,
      from: req.user.username,
    });
    battle.crowd.feed({ icon: ev.icon, real: true, who: '運営', text: `投票で選ばれたイベント「${ev.name}」が開幕！`, textEn: `The voted event "${ev.nameEn || ev.name}" has begun!` });
    battle.crowd.react('poll_close', { winner: w });   // renderSlot が言語別に text/textEn を選ぶ
    setTimeout(() => battle.crowd.react('event_start'), 25000);
    saveDb();
    return res.json({ event: currentEvent(), poll: pollView(poll, req.user.id, true) });
  }

  // create
  const options = req.body.kind === 'event' && !Array.isArray(req.body.options)
    ? eventPollOptions(Number(req.body.optionCount) || 4)
    : req.body.options;
  const out = createPoll({
    question: req.body.question,
    options,
    minutes: req.body.minutes,
    kind: req.body.kind,
    createdBy: req.user.username,
  });
  if (out.error) return res.status(400).json({ error: out.error });
  db.meta.poll = out.poll;
  // 英語版を自動補完（イベント選択肢はcreatePollがネイティブ英語名を付与済み）。
  const pollRef = out.poll;
  let qReady = null;
  if (!pollRef.questionEn) {
    const qTr = translateChat(pollRef.question).then(tr2 => {
      if (tr2 && tr2.lang === 'en' && db.meta.poll && db.meta.poll.id === pollRef.id) { pollRef.questionEn = tr2.text; saveDb(); }
    }).catch(() => {});
    // アナウンスの英語文に日本語の質問文が残らないよう、翻訳を最大2秒だけ待つ
    qReady = Promise.race([qTr, new Promise(r => setTimeout(r, 2000))]);
  }
  for (const o of pollRef.options) {
    if (o.textEn) continue;
    translateChat(o.text).then(tr2 => {
      if (tr2 && tr2.lang === 'en' && db.meta.poll && db.meta.poll.id === pollRef.id) { o.textEn = tr2.text; saveDb(); }
    }).catch(() => {});
  }
  const announcePoll = () => {
    if (!db.meta.poll || db.meta.poll.id !== pollRef.id) return;   // 待機中に締切/削除されたら黙る
    battle.broadcastAll({
      type: 'announce',
      message: `🗳️ 投票受付中：「${pollRef.question}」 メニューの「🗳️ 投票」から参加しよう！`,
      messageEn: `🗳️ New poll: "${pollRef.questionEn || pollRef.question}" — vote from the 🗳️ Poll menu!`,
      from: req.user.username,
    });
    battle.crowd.react('poll_open');
  };
  if (qReady) qReady.then(announcePoll); else announcePoll();
  saveDb();
  res.json({ poll: pollView(out.poll, req.user.id, true) });
});

// Suggested event options for the admin's poll builder.
app.get('/api/admin/poll/suggest', requireAuth, requireAdmin, (_req, res) => {
  res.json({ options: eventPollOptions(EVENT_TYPES.length), types: EVENT_TYPES });
});

// ---------------------------------------------------------------------------
// Guilds (ギルド) — routes/guild.js
// ---------------------------------------------------------------------------
app.use(guildRouter);

// ---------------------------------------------------------------------------
// News (お知らせ)
// ---------------------------------------------------------------------------

// Fixed ids: a re-seeded post is THE SAME post, so backup merges dedupe it
// instead of multiplying the launch announcements on every restore. Every seed
// post is fully bilingual; boot also BACKFILLS titleEn/bodyEn onto copies that
// were stored before the fields existed (so production news heals itself).
// ⚠ ニュースはプレイヤーが読む場所。次のものは書かないこと:
//   * 管理者だけが使う機能の話（管理画面・権限・運営の設定）
//   * セキュリティ修正の中身。どこをどう塞いだかを公開すると、
//     次に狙う場所を教えることになる。直したこと自体を書く必要も無い
//   * 内部の実装用語。プレイヤーから見て何が変わるかだけを書く
//   * 住人（ロビーで喋り、ランキングに並び、対戦相手にもなる面々）がAIだという話。
//     「AIプレイヤー」「AI住人」「AI opponent」などと名指ししない。彼らはこの
//     アリーナの住人であって、正体を明かした瞬間に世界が薄っぺらくなる。
//     ニュースだけでなく、プレイヤーの目に触れる文面すべてに同じことが言える。
// 文面を直したいときは NEWS_BODY_REV を1つ増やす（公開済みも差し替わる）。
const SEED_NEWS = [
  { id: 'seed-1', pinned: true,
    title: '🎉 v2.0 超進化アップデート！', titleEn: '🎉 The v2.0 Mega Evolution Update!',
    body: '⚡アルティメットスキル（9種・ショップの「奥義」タブ）／📋デイリー・ウィークリーミッション／🏅実績58種／📊戦績ダッシュボード／⏱️タイムアタック／🤝協力プレイ（2人で1盤面）を追加しました。ラインを消して⚡ゲージを溜め、必殺技を撃とう！',
    bodyEn: 'Added: ⚡ Ultimate Skills (9 kinds — see the Ultimates tab in the shop), 📋 daily & weekly missions, 🏅 58 achievements, 📊 a stats dashboard, ⏱️ Time Attack, and 🤝 co-op (two players, one board). Clear lines to charge the ⚡ gauge and unleash your ultimate!' },
  { id: 'seed-2',
    title: '🎪 イベント＆🗳️投票スタート', titleEn: '🎪 Events & 🗳️ Polls are here',
    body: '期間限定イベントが8種類に！コイン祭り・経験値ブースト・ジェムラッシュ・ボス襲来・奥義祭・ラッキーデー…開催中はメニューにバナーが出ます。投票機能では次のイベントをみんなで決められます（投票するまで結果は秘密）。',
    bodyEn: 'Eight kinds of limited-time events: Coin Festival, XP Boost, Gem Rush, Boss Invasion, Ultimate Festival, Lucky Day and more — a banner appears on the menu while one is live. With polls, everyone decides the next event together (results stay hidden until you vote).' },
  { id: 'seed-3',
    title: '🏰 ギルド機能・🌑 深淵ダンジョン・📰 ニュース', titleEn: '🏰 Guilds, 🌑 the Abyss Dungeon & 📰 News',
    body: 'ギルドを作って週間ポイントを競おう（ギルドレベルでコインボーナス）。塔を制覇した猛者には過去最難関「深淵」が待っています。このニュース欄には運営からのお知らせが届きます。',
    bodyEn: 'Found a guild and race for weekly points (guild levels grant coin bonuses). For those who conquered the Tower, the hardest challenge yet — the Abyss — awaits. This news feed is where announcements from the team arrive.' },
  { id: 'seed-4',
    title: '🎭 にぎわい2.0 ＆ チャット自動翻訳', titleEn: '🎭 Crowd 2.0 & chat auto-translation',
    body: 'ロビーの住人たちが性格を持ちました。イベントや投票に反応し、対戦した相手はあとでチャットで話しかけてくることも。チャットは日本語⇄英語を自動翻訳します（設定でOFFにできます）。',
    bodyEn: 'The lobby residents now have personalities. They react to events and polls, and someone you just fought might message you afterwards. Chat auto-translates between Japanese and English (you can turn it off in Settings).' },
  { id: 'seed-v26', pinned: true,
    title: '🛡️ v2.6 不滅アップデート！', titleEn: '🛡️ The v2.6 Immortal Update!',
    body: 'アップデートでデータが消える時代は終わりです。シーズン・バトルパス・実績の受け取り状況・イベント・投票がすべて更新後も引き継がれるようになりました。さらに🏅実績が全100種に大増量、新モード「🧩パズル遺跡」（ステージ制パズル・星3評価）と「⛏️採掘場」（せり上がる地層を掘って鉱石を集めろ）が登場！チャットの住人たちも会話エンジン3.0に進化して、同じセリフの繰り返しがほぼなくなりました。',
    bodyEn: 'The era of updates wiping your data is over: seasons, battle pass, claimed achievements, events and polls all carry over now. Achievements grew to 100, and two new modes arrived — 🧩 Puzzle Ruins (stage-based puzzles with 3-star ratings) and ⛏️ The Mines (dig through rising strata for ore)! The chat residents also evolved to conversation engine 3.0 — repeated lines are nearly gone.' },
  { id: 'seed-throne', pinned: true,
    title: '👑 王座システム登場！', titleEn: '👑 The Throne System is here!',
    body: '各ランキング（スコア・レート・タイムアタック・ダンジョン・ウィークリー・パズル遺跡・採掘場）の現在1位は「王座」を保持します。王者はランキング・チャット・プロフィールに👑が輝き、王座1つにつき毎日のログインボーナスに+150🪙+2💎の俸給が上乗せ！王座が奪われるとライブフィードで全プレイヤーに速報が流れます。頂点を獲れ！',
    bodyEn: 'The current #1 of every leaderboard (Score, Rating, Time Attack, Dungeon, Weekly, Puzzle Ruins, The Mines) holds a Throne. Champions get a shining 👑 on rankings, in chat and on their profile — plus a daily stipend of +150🪙 +2💎 per throne! When a throne changes hands, the live feed announces it to everyone. Take the top!' },
  { id: 'seed-ghost',
    title: '👻 奇妙な報告が届いています', titleEn: '👻 Strange reports are coming in',
    body: '複数のプレイヤーから「メニューで何かに見られている気がする」という報告が届いています。運営で調査したところ、ロゴの周辺で不可解な現象を確認しました。じっと見つめていると、不吉な数字が頭に浮かぶそうです。……くれぐれも、その回数だけ触れたりしないように。実績欄に見慣れない👻が現れた方は、運営までご一報ください。',
    bodyEn: 'Several players report feeling watched on the menu screen. Our investigation confirmed something inexplicable near the logo. Those who stare at it say an unlucky number comes to mind… Whatever you do, please do not touch it that many times. If an unfamiliar 👻 has appeared in your achievements, contact the team immediately.' },
  { id: 'seed-v272', pinned: true,
    title: '🎰 ガチャ2.0 ＆ 👑多冠報酬アップデート！', titleEn: '🎰 Gacha 2.0 & 👑 Multi-Crown Rewards!',
    body: '【🎰ガチャ2.0】✨天井システム登場 — 40連以内にSSR以上が必ず出ます！10連はSR以上1枠確定。さらに🌈ガチャ限定装備3種（プリズム／オーロラ／彗星）が追加 — SSRからのみ入手できます。【👑多冠報酬】王座を2つ以上同時に持つと永久バッジ＋俸給ボーナス（二冠+200🪙3💎〜全冠+1,600🪙24💎）、名前の色も冠の数で豪華に（3冠以上は虹色！）。王者の住人はチャットに常駐するようになりました。【🐛バグ報告】設定→「バグ報告」から不具合を直接送れます！',
    bodyEn: '[🎰 Gacha 2.0] The ✨pity system is here — an SSR or better is guaranteed within 40 pulls, and every 10-pull guarantees at least one SR+. Three 🌈 gacha-exclusive items were added (Prism / Aurora / Comet) — SSR pulls only. [👑 Multi-Crown] Hold 2+ thrones at once for permanent badges and bigger stipends (up to +1,600🪙 24💎 for all seven) — and your name color gets fancier with each crown (3+ crowns = rainbow!). Champion residents now hang out in chat. [🐛 Bug Reports] Report issues directly from Settings → Report a bug!' },
  { id: 'seed-throne2', pinned: true,
    title: '👑 王座戦線に住人が参戦！', titleEn: '👑 The residents join the throne race!',
    body: 'ロビーの住人たちも王座を持つようになりました。いま各ランキングの👑は住人が守っています — 彼らの実力は日々変化するので、王座も自然に動きます。スコアで追い抜けばその瞬間あなたが王者。住人から王座を奪還して、俸給と栄光を手にしましょう！（住人はログインボーナスを受け取れないので、俸給はいつでも人間のもの）',
    bodyEn: 'The lobby residents can now hold thrones too. Right now the 👑 on each leaderboard is defended by a resident — their skills drift daily, so thrones naturally change hands. Beat their score and the crown is yours that instant. Reclaim the thrones from them for stipends and glory! (Residents can’t collect login bonuses, so the stipend always belongs to humans.)' },
  { id: 'seed-v210', pinned: true,
    title: '💥 オンライン対戦 超絶大型アップデート ＆ 🌐完全翻訳！', titleEn: '💥 Online Battle MEGA Update & 🌐 Full Translation!',
    body: '【💥アタック戦】新モード登場！2ライン以上を同時消しすると相手の盤面にお邪魔ブロックを送り込めます（3ライン=4個、4ライン+コンボで最大9個）。攻撃も防御も自分の腕次第 — オンラインメニューの「💥アタック戦」から！【🔁再戦】デュエル/アタック戦の結果画面に再戦ボタンが付きました。30秒以内なら同じ相手にリベンジできます。【📈昇格演出】レートが新しい帯（🥈シルバー〜👑グランドマスター）に到達すると紙吹雪でお祝い＋ゴールド以上は全体アナウンス！【🌐翻訳大型アップデート】ニュース・投票・イベント・チャットの住人の会話まで、英語表示が全面ネイティブ品質になりました。',
    bodyEn: '[💥 Attack Duel] New mode! Clear 2+ lines at once to send garbage blocks onto your opponent\'s board (3 lines = 4 cells, up to 9 with combos). Attack and defend with pure skill — find it under "💥 Attack Duel" in the online menu! [🔁 Rematch] Duel and Attack results now have a rematch button — get your revenge against the same opponent within 30 seconds. [📈 Promotions] Reaching a new rank tier (🥈 Silver through 👑 Grandmaster) triggers a confetti celebration, and Gold+ promotions are announced to everyone! [🌐 Translation Overhaul] News, polls, events and even the residents\' chat are now native-quality in English.' },
  { id: 'seed-v211', pinned: true,
    title: '👑 v2.11 管理者イベント開幕 ＆ 💯バトルロイヤル大改造！',
    titleEn: '👑 v2.11 — Admin Events & the Battle Royale Overhaul!',
    body: '【👑 管理者イベント（週1・予約制）】運営が主催する特別イベントがはじまります。ポイントは「開催時間を “あなたが” 選べる」こと — 18:00 / 19:00 / 21:00 のように複数の枠が用意され、メニューのバナーから好きな枠を予約すると、その時間にあなた専用の回が開幕します。予約が違ってもボスHP・共同ゲージ・ランキングは全員で共有。18時に遊んだ人と21時に遊んだ人が、同じ1体のボスを一緒に削ります。10分前と1分前にお知らせが出るので、うっかり寝過ごしても大丈夫。\n' +
      '【🎮 この枠でしか遊べない専用モード3種（週替わり）】👑管理者襲来＝管理者の分身が「お邪魔の雨」「盤面回転」「手札シャッフル」「目隠し」などをリアルタイムで撃ち込んでくる総力戦。全員の合計ダメージで巨大HPを削り切れ！／🎰運営ルーレット＝30秒ごとにルーレットが回り、スコア5倍・極小ブロックのみ・盤面回転・せり上がり・ラッキーセブンなど9種のルールに書き換わるカオス番組。／🏛️共同作業＝参加者全員のスコアが1本のゲージに合流し、段階目標を越えるたび全員に報酬。盤面に湧く🧱建材を回収すると大きく加速します。\n' +
      '【🎁 お宝ラッシュ】自分の枠の中は報酬が最大3倍。討伐に成功すると参加者全員に👑バッジ。\n' +
      '【💯 バトルロイヤル 大改造】99人のAIが「スコアが自動で増えるだけの数字」から、本当に盤面を持って打つプレイヤーになりました。弱いAIは実際に詰んで脱落します。さらに ①2ライン以上消すと生存者の誰かにお邪魔を送り込む殴り合い ②時間経過で全員に降りそそぐ🌩️ストーム ③「あと◯点で生き残れる」を数字で出す危険メーター ④脱落しても終わりじゃない観戦モード ⑤残り3人の盤面が並ぶファイナル ⑥順位別の報酬ラダー（1位🪙1,200💎40 〜 参加賞まで）⑦KO数・最高順位の記録と新実績7種・新称号2種。1回のトップアウトは「復活」、2回目で脱落です。\n' +
      '【🐲 レイド/2v2 の画面改善】仲間3人ぶんのミニ盤面が縦に積み上がって自分の盤面を圧迫していた問題を解消。仲間は1行のコンパクト表示になり、ボスHPも細いバーになりました。iPhone SE クラスの画面では自分の盤面が 210px → 347px（ソロと同じ大きさ）に。横画面では盤面が消えてしまう不具合も修正。仲間の盤面を見たい人は ▾ ボタンで元に戻せます。\n' +
      '【🌐 マッチング見直し】①レートの近い人から優先してマッチ（待つほど条件がゆるくなります）②AI相手の強さがあなたのレートに合わせて選ばれるように（今までは完全ランダムでした）③2v2で2人一緒に来たら必ず同じチーム ④待機画面に「経過時間・同じモードで待っている実人数・レート検索範囲・AIが参戦するまでの秒数」を正直に表示。\n' +
      '【🐛 バグ修正】通信エラーでサーバー全体が落ちうる不具合／対戦の結果待ち中に接続が切れると画面が固まって操作不能になる不具合／ゲーム終了後もピースを置けてしまう不具合／ドラッグ中に手札が変わると別のピースが置かれる不具合／アカウント削除でギルドが満員のまま壊れる不具合／協力プレイのスコアを改ざんできる不具合／アイテムが10個あると左端の4個が画面外で押せない不具合／オンライン対戦でピース数が記録されずミッションが進まない不具合 — ほか多数。',
    bodyEn: '[👑 Admin Events — weekly, and YOU pick the time] A special event hosted by the staff. The point of it is that you choose when to attend: several slots are offered (say 18:00 / 19:00 / 21:00 JST) and you reserve the one that suits you from the menu banner — your own session opens at that time. Different slots, one shared world: the boss HP, the community gauge and the leaderboard are common to everybody, so the 18:00 crowd and the 21:00 crowd chip away at the same boss together. You get a reminder 10 minutes and 1 minute before your slot.\n' +
      '[🎮 Three exclusive modes, rotating weekly] 👑 Admin Invasion — the admin\'s avatar meddles with your board in real time (garbage rain, board spin, hand shuffle, blindfold) while everyone\'s damage goes onto one enormous HP bar. 🎰 Operator Roulette — every 30 seconds the wheel is spun and the rules are rewritten: 5× score, tiny blocks only, a spinning board, a rising floor, Lucky 7 and more. 🏛️ The Great Work — every participant\'s score flows into a single gauge, and each tier cleared pays out to everyone; collect the 🧱 materials that appear on your board to speed it up.\n' +
      '[🎁 Treasure Rush] Rewards are multiplied (up to 3×) inside your slot, and defeating the objective earns a 👑 badge for everyone who took part.\n' +
      '[💯 Battle Royale rebuilt] The 99 AI entrants were score curves that could not be beaten fairly; they now run real boards with the real AI, and weak ones genuinely top out and die. Added: garbage warfare (clear 2+ lines to bury a survivor), a 🌩️ storm that rains garbage on everyone as the clock runs down, a danger meter that tells you exactly how many points you are from safety, spectating after you are knocked out, a finale showing the last three boards, a placement reward ladder (🪙1,200 💎40 for #1 down to a consolation prize), plus knockout/best-placement stats, 7 new achievements and 2 new titles. Your first top-out revives you; the second eliminates you.\n' +
      '[🐲 Raid / 2v2 screen] Three allies\' mini boards used to stack above your own and squeeze it flat. Allies are now a single compact row and the boss HP is a slim bar — on an iPhone SE-sized screen your board goes from 210px to 347px, the same size as in solo. The landscape bug that made the board vanish entirely is fixed. Tap ▾ to bring the ally boards back.\n' +
      '[🌐 Matchmaking] Players are now paired by rating (the search widens the longer you wait), your stand-in opponent\'s strength is chosen to match your rating instead of at random, two players who queue together for 2v2 always land on the same team, and the search screen honestly shows your elapsed time, how many real people are waiting in that mode, the rating range being searched, and exactly when a stand-in opponent will step in.\n' +
      '[🐛 Fixes] A socket error could take the whole server down; a dropped connection while waiting for results left an undismissable modal covering the app; pieces could still be placed after a run had ended; a hand change mid-drag placed a different piece than the one you were holding; deleting an account left a guild permanently stuck at "full"; co-op scores could be forged by a client; with 10 items the leftmost four sat off-screen and were unreachable; online modes recorded 0 pieces placed so those missions never advanced — and more.' },
  { id: 'seed-zero', pinned: true,
    title: '👁️ 断罪 ── 管理者ゼロが七つの王座を人質に取りました',
    titleEn: '👁️ CONDEMNED — Admin Zero has taken all seven thrones',
    body: '【👁️ 管理者ゼロが、七つの王座を人質に取りました】新しい管理者イベント「断罪」がはじまります。ゼロはHPバーではありません。画面の上であなたと同じように**本当にブロックを積んでいて**、列を消せばあなたの盤面にお邪魔が降り、名前を呼んで野次ってきます。段が進むごとに言葉づかいが崩れていきます。\n' +
      '【🔒 点をいくら稼いでも、段は落ちません】ここがこのイベントの全部です。段のHPは7割までしか点数で削れません。残り3割には「封印」があり、通常のダメージが一切通りません。封印を貫通できるのは、30秒ごとに来る【断罪】を斬った一撃だけ。住人には斬れません。つまり ── **住人＝火力／あなた＝鍵**。何点入れても、あなたが斬らなければ段は絶対に落ちません。\n' +
      '【⚔️ 断罪 ── 30秒ごとに来る山場】画面が赤く走り、あなたの名前が出て、盤面に赤いマスが3.5秒だけ点灯します。その赤マスを通るラインを消せば【斬った】。うち1つは金色の「急所」で、含めて斬れば貫通が倍になります。間に合わなければ赤マスがそのままお邪魔になり、ゼロが少し回復し、**アリーナの住人が1人、名前つきで処刑されます**。消えた住人はその日ずっと戻ってきません。\n' +
      '【🪧 今夜の的】段のはじめにゼロが1つの列を宣言します。断罪の赤マスの6割がその列に置かれるので、その列を縦に消すと「杭」が1本入り、3本で次の予告が3.5秒→5.0秒に伸びます。ただし特定の1列を縦に消すのは点効率が悪い ── **点を稼ぐ置き方と、斬りやすくする置き方がぶつかります。**\n' +
      '【🤝 取引 ── 60秒の生投票】20分地点でゼロが2択を持ちかけます。「この段のHPを半分にしてやる。かわりに予告を1秒縮める」。**あなたと、いまオンラインの住人全員が本当に投票します。** あなたの1票は住人5票ぶん。1人では決まりませんが、票が割れればあなたが決定打になります。住人は性格どおりに投票するので、毎回結果が違います。\n' +
      '【🕐 段は世界で1本】18:00の枠で段2まで割れば、19:00の人は段3から始めます。足し算ではなく直列です。処刑された住人も、次の枠に席が空いたまま引き継がれます ── **あなたの取りこぼしが、会ったことのない21:00の誰かの火力を削ります。**\n' +
      '【📜 断罪録】その日ゼロが誰に何を言ったかが、実名つきで時系列に残ります。メニューからいつでも読めます。段にとどめを刺した人は、次の枠へ**40字の伝言**を残せます。次の枠の開幕でゼロがそれを読み上げます。\n' +
      '【🏵️ 残るもの】段が割れた瞬間その場に居た人だけに👁️バッジ。あとから点を足しても手に入りません。称号は3つ ── 「断罪を斬りし者」（封印を破るとどめ）／「名指しの常連」（通算50回名指しされる）／「七冠奪還」（七段すべてが割れた日に居合わせる）。',
    bodyEn: '[👁️ Admin Zero has taken all seven thrones hostage] A new admin event, CONDEMNED, begins. Zero is not an HP bar. He plays a real board above yours, and when he clears lines the garbage lands on you for real. He calls you by name and heckles you — and the further you push him, the more his manners fall away.\n' +
      '[🔒 No amount of score will bring a stage down] This is the whole event. Only 70% of a stage can be worn away by score. The last 30% is sealed, and ordinary damage does not touch it. The seal yields only to a CONDEMNATION cut — one that arrives every 30 seconds, and one no resident can make. So: residents are the firepower, and you are the key. However many points go in, the stage will not fall unless you cut.\n' +
      '[⚔️ Condemnation — a moment that comes every 30 seconds] The screen runs red, your name appears, and cells light up on your board for 3.5 seconds. Clear a line through them and you have CUT. One of them is gold — the keystone — and including it doubles the damage. Miss, and the cells turn to garbage, Zero recovers a little, and a resident of the arena is executed by name. They do not come back for the rest of the day.\n' +
      '[🪧 Tonight\'s mark] At the start of each stage Zero names one column, and 60% of the condemnation cells will fall there. Clear that column vertically to drive a stake; three stakes stretch your next warning from 3.5s to 5.0s. But clearing one specific column vertically is poor for score — so the way to score and the way to stay alive pull against each other.\n' +
      '[🤝 The bargain — 60 seconds, live] Twenty minutes in, Zero offers a choice. "I will halve this stage. In exchange, your warning shrinks by one second." You vote, and so does every resident currently online — really. Your vote counts as five of theirs. You cannot decide it alone, but when they split, you decide it. Residents vote in character, so it lands differently every time.\n' +
      '[🕐 One stage for the whole world] If the 18:00 slot breaks through to stage 2, the 19:00 players start at stage 3. Not addition — a single line. Executed residents carry over too, their seats still empty. Your miss thins the firepower of someone at 21:00 you will never meet.\n' +
      '[📜 The Chronicle] Everything Zero said, and to whom, stays on record by name, in order. Readable from the menu at any time. Whoever lands the finishing blow on a stage may leave a 40-character message for the next slot — and Zero reads it aloud when they arrive.\n' +
      '[🏵️ What remains] The 👁️ badge goes only to those present the moment a stage falls; no amount of later scoring earns it. Three titles: Sealbreaker (land the blow that breaks a seal), Marked (be condemned 50 times), Seven Reclaimed (be there when all seven fall).' },
  { id: 'seed-v2111',
    title: '🛡️ v2.11.1 遊んだまま更新できるように ＆ 大量のバグ修正',
    titleEn: '🛡️ v2.11.1 — Updates Without Losing Your Run, and a Pile of Fixes',
    body: '【🛡️ 遊んだまま更新できるようになりました】アップデートでサーバーを入れ替えるとき、これまでは遊んでいる最中の人が黙って切断されていました。これからは全員に予告が出て、進行中のものがきちんと終わります — オンライン対戦は引き分け（記録も報酬も残り、勝敗はどちらにもつきません）、バトルロイヤルはその時点の順位で確定、ソロやダンジョンは自動で保存して終了します。\n' +
      '【🏰 ダンジョン全4世界に報酬がつきました】🕳️地下と☁️天国は、これまで100階まで登ってもジェムが1個も出ず、到達階すら記録に残っていませんでした。地下は「上級者向け」と書いてあるのに塔より損をする状態だったので、難しさに見合う報酬に直しました。10階ごとにジェム、100階制覇で新バッジ「地底踏破」「天界踏破」が手に入ります。（塔700💎／地下1,050💎／天国700💎／深淵1,400💎）\n' +
      '【🎁 共同作業の報酬を受け取れるようになりました】管理者イベント「🏛️共同作業」で、ゲージの段階目標を越えても報酬を受け取る場所がどこにも無く、実際には1枚も配られていませんでした。受け取りボタンを追加しました。\n' +
      '【🏵️ 達成できない実績を直しました】「伝説の収集家」はアイテム45種が目標でしたが、そもそもゲームに37種しかありませんでした。永久に埋まらない実績だったので、正しく「全37種そろえる」に直しました。\n' +
      '【🏰 住人のギルドが24個に】住人のギルドが8個から24個に増え、住人の数に応じて自然に増減するようになりました。これまでは600人いても8ギルド（160席）しか無く、大多数がどこにも所属できていませんでした。\n' +
      '【🗳️ 住人も投票します】投票が始まると、住人たちが自分の性格に沿って票を入れるようになりました。イベントの枠選びにも参加します。\n' +
      '【📈 ランキングの住人が強くなりました】住人の記録が「毎日ちょっとだけ動く数字」ではなく、本物の自己ベストのように伸びるようになりました — 伸び悩む時期があり、たまに一気に更新します。レートの上限も引き上げ（最高1900）、塔は95F止まり。100F制覇と時間の頂点は人間のものです。\n' +
      '【🎒 インベントリ】メニューに新しいインベントリ画面を追加。装備・アイテム・バッジ・王座を1か所で確認して、その場で着せ替えできます。\n' +
      '【🔊 ロビーがにぎやかに】ロビーの住人が最大600人までいるようになりました。\n' +
      '【🐛 バグ修正】バトルロイヤルで、スマホのアプリを切り替えただけで失格になっていた不具合（回線が切れていないのに20秒よそ見すると脱落していました）／同時に脱落したとき、スコアの低い人が良い順位を取ることがあった不具合／協力プレイで手札がズレると置けなくなる不具合／再戦のときに相手が別の部屋に入っていても引きずり出してしまう不具合／オンライン人数が実際の約2倍に見えていた不具合／チャットの履歴が再起動で消えていた不具合／英語表示に日本語のアイテム名・ボス名・称号・バッジ名がそのまま出ていた不具合／日付の変わり目が日本時間からずれていた不具合（ログインボーナスと連続ログイン）／深淵ダンジョンを制覇しても専用のお祝いが出なかった不具合 — ほか多数。',
    bodyEn: '[🛡️ Updates without losing your run] Swapping the server for an update used to disconnect everyone mid-game without a word. Now everybody is warned and whatever is in progress is closed out properly: online matches end in a draw (the run and its rewards are kept, and nobody takes a loss), a battle royale locks in your placement at that moment, and solo or dungeon runs are saved and ended automatically.\n' +
      '[🏰 All four dungeon realms now pay out] 🕳️ The Depths and ☁️ The Ascent gave no gems at all — not even a record of the floor you reached — no matter how far you climbed. The Depths is billed as the harder realm, yet clearing it paid strictly worse than the Tower. Rewards now match the difficulty: gems every 10 floors, plus the new badges Depths Conqueror and Ascent Conqueror for reaching floor 100. (Tower 700💎 / Depths 1,050💎 / Ascent 700💎 / Abyss 1,400💎)\n' +
      '[🎁 The Great Work rewards can finally be collected] Clearing a gauge tier in 🏛️ The Great Work had nowhere to actually claim the reward, so not a single coin was ever handed out. There is now a collect button.\n' +
      '[🏵️ An impossible achievement, fixed] Legendary Collector asked for 45 items when the game only has 37. It could never be completed, so it now correctly asks for all 37.\n' +
      '[🏰 24 resident guilds] Resident guilds grew from 8 to 24 and now scale with the population. With 600 residents there were only 8 guilds (160 seats), so most residents belonged nowhere.\n' +
      '[🗳️ Residents vote] When a poll opens, residents now cast votes in line with their personalities — including on which event slot to attend.\n' +
      '[📈 Stronger residents on the leaderboards] Resident records now grow like real personal bests instead of drifting a little every day: they plateau, then break through. The rating ceiling was raised (1900 max) and the tower caps at floor 95 — clearing 100F and the time-attack summit stay human territory.\n' +
      '[🎒 Inventory] A new inventory screen in the menu: gear, items, badges and thrones in one place, with equipping right there.\n' +
      '[🔊 A livelier lobby] Up to 600 residents now fill the lobby.\n' +
      '[🐛 Fixes] In Battle Royale, switching apps on a phone got you eliminated — your connection was fine, but looking away for 20 seconds knocked you out; when several players dropped at once the lower scorer could take the better placement; a co-op hand desync made you unable to place anything; a rematch could drag an opponent out of another room; the online player count read roughly double the real number; chat history vanished on restart; English text showed Japanese item, boss, title and badge names verbatim; the day rollover was not using Japan time (login bonus and streaks); conquering the Abyss gave no special celebration — and more.' },
  { id: 'seed-v214', pinned: true,
    title: '📈 v2.14 住人たちが本気を出しました', titleEn: '📈 v2.14 — The Residents Got Serious',
    body: '【📈 ランキングの住人が大幅強化】アリーナの住人たちが猛特訓を積み、ランキング上位の記録が化け物級になりました。ハイスコアは数十万点、レートは2000超え、塔は99階、タイムアタックも理論値ギリギリ — 各ランキングの頂は、もうこれまでの比ではありません。チャットで彼らが自慢してくる点数も本物です。\n' +
      '【👑 それでも頂は獲れます】どの記録にも、人間が到達できる余地は残してあります。同記録なら王座は必ず人間のもの。そして塔100階の制覇は、今までどおり人間だけに許された領域です。住人の記録は日々伸び続けます — 追い抜くなら、今日がいちばん易しい日。挑戦者を待っています。',
    bodyEn: '[📈 The leaderboard residents got a massive power-up] The arena residents have been training hard, and the top of every leaderboard is now monstrous: high scores in the hundreds of thousands, ratings beyond 2000, floor 99 of the Tower, and time-attack records scraping the theoretical limit. The summit of each board is nothing like it used to be — and the scores they brag about in chat are real.\n' +
      '[👑 The summit can still be taken] Every record leaves room for a human to reach it, and on a tie the throne always goes to the human. Conquering floor 100 of the Tower remains yours alone. The residents\' records keep growing by the day — today is the easiest day to pass them. We are waiting for challengers.' },
  { id: 'seed-v215', pinned: true,
    title: '📅 v2.15 デイリーチャレンジ開幕！', titleEn: '📅 v2.15 — The Daily Challenge begins!',
    body: '【📅 毎日変わる、1日1回の真剣勝負】新モード「デイリーチャレンジ」が始まります。全プレイヤーが同じ盤面・同じピース順で、30個のピースを使い切るスコアアタック。記録に残るのは<b>その日の最初の1回だけ</b> — 置き直しはできません。深呼吸してから挑みましょう（挑戦後も練習は何度でもできます）。\n' +
      '【🎲 日替わりのお題】その日のルールが毎日変わります — 🧱巨大の日（大きいピースだけ）／🐜極小の日／🔥連鎖の日（コンボボーナス2倍）／🌈虹の日（リロール3回）／🧊瓦礫の日（開幕から瓦礫）／💰黄金の日（クリア報酬コイン2倍）。お題は世界共通。今日の運命はみんな同じです。\n' +
      '【🔥 連続クリアでボーナス最大3倍】その日の<b>目標スコア</b>に届けば「クリア」。目標はお題に合わせて日ごとに変わります（極小の日は低く、連鎖の日は高め）— 挑戦前の画面に必ず出るので、そこで確認を。毎日続けてクリアするとボーナスがどんどん増えます（最大3倍）。<b>7日連続クリアで新バッジ「📅日課の鬼」＋💎300</b>！1日でも空けるとやり直し — 今日の1回を大切に。\n' +
      '【🏆 その日限りのランキング】ランキング画面に「📅デイリー」ボードが登場。毎日0時（日本時間）にまっさらになる、その日だけの勝負です。今日の頂点は誰の手に？',
    bodyEn: '[📅 One real attempt, every day] The new Daily Challenge is here. Every player gets the same board and the same piece order — a score attack with exactly 30 pieces. Only your FIRST attempt of the day counts, no do-overs. Take a breath before you start (practice runs are unlimited afterwards).\n' +
      '[🎲 A rule of the day] The rules change daily — 🧱 Giant Day (only big pieces), 🐜 Tiny Day, 🔥 Combo Day (double combo bonuses), 🌈 Rainbow Day (3 rerolls), 🧊 Rubble Day (the board starts littered), 💰 Golden Day (double coins on clear). The modifier is the same worldwide: everyone shares today\'s fate.\n' +
      '[🔥 Streaks pay up to 3×] Reach the day\'s <b>target score</b> and the day counts as CLEARED. The target shifts with the rule of the day (lower on Tiny Day, higher on Combo Day) — it is always shown before you start. Clear day after day and the reward multiplies (up to 3×). Clear 7 days in a row for the new 📅 Daily Devotee badge + 300💎! Miss a single day and the streak resets — make today\'s attempt count.\n' +
      '[🏆 A leaderboard that lives for one day] The ranking screen gains a 📅 Daily board, wiped clean at midnight JST. Who takes today\'s summit?' },
  // 📌 アップデートのたびに、ここへ1件足すこと（運営の決めごと）。
  //
  // 遊んでいる人から見ると、更新は「知らないうちに何かが変わった」でしかない。
  // 何が増えたのかをゲーム内で伝えないと、せっかく作った機能が気づかれずに
  // 終わる。書き方は3つだけ守る:
  //   ・バージョン番号ではなく「何ができるようになったか」を主語にする
  //   ・内部の事情（リファクタ・テスト・監査）は書かない ── 直したことは
  //     「〜が直りました」だけでよく、原因の説明は要らない
  //   ・日本語と英語の両方を書く（bodyEn を空にすると英語圏には無言の更新になる）
  { id: 'seed-v228', pinned: true,
    title: '🎬 プレイ動画の書き出し＆スコアのシェアができるようになりました',
    titleEn: '🎬 Record your clips and share your score',
    body: '【🎬 プレイ動画をその場で書き出せます】ゲーム中のHUDに <b>🎬</b> ボタンが増えました。押すと30秒、長押しで15秒／30秒／60秒を選んでプレイ映像を録画できます。書き出されるのは<b>そのままSNSに上げられる縦型の動画</b>で、スコア・モード名・あなたの名前が焼き込まれます。全消しの瞬間や、詰みかけからの逆転をぜひ残してみてください。\n' +
      '【📣 結果画面からスコアをシェア】ゲームが終わったあとの画面に「📣 スコアをシェアする」が出ます。スコアカードの画像が自動で作られるので、そのまま友達に見せられます。<b>アカウントが無くても使えます</b>。\n' +
      '【✨ そのほか】新しく参加した方が入りづらくなっていた不具合を直しました。ほかにも、全体チャットがまれに止まる問題や、イベントの進行がおかしくなる問題など、いくつかの不具合を修正しています。',
    bodyEn: '[🎬 Export your gameplay as a video] A new <b>🎬</b> button appears in the in-game HUD. Tap it for a 30-second clip, or long-press to choose 15 / 30 / 60 seconds. What you get is a <b>vertical video ready to post</b>, with your score, the mode and your name burned in. Perfect for that all-clear moment or a last-second comeback.\n' +
      '[📣 Share your score from the results screen] After a run you will see "📣 Share your score". A score card image is generated for you, ready to send to friends. <b>You do not need an account.</b>\n' +
      '[✨ Also in this update] Fixed an issue that could stop new players from connecting. Also fixed a rare problem where global chat could go silent, an event progression bug, and several smaller issues.' },
  { id: 'seed-v230', pinned: true,
    image: '/img/news/v230-skins.svg',
    imageAlt: '新しいブロック5種（アイス・ウッド・ゼリー・スチール・スターダスト）',
    imageAltEn: 'Five new block skins: Ice, Wood, Jelly, Steel and Stardust',
    title: '🛍 ショップに17品が入荷しました',
    titleEn: '🛍 17 new items in the shop',
    body: '【🧱 ブロック5種】🧊アイス（霜のひびが走る氷塊）／🪵ウッド（年輪の浮かぶ木彫り）／🫧ゼリー（ぷるんと透ける厚み）／⚙️スチール（リベット打ちの鋼鉄）／🌌スターダスト（夜空を閉じ込めた粒）。\n' +
      '【🎨 ステージ8種】深海／砂漠の夜／ミントの森／真夜中／ルビー／マトリクス／夜明け／星雲。ブロックとの組み合わせで、同じ盤面がまるで別のゲームに見えます。\n' +
      '【✨ 消去エフェクト4種】❄️スノウ（粉雪が舞い落ちる）／🍃リーフ（木の葉がひらひら）／💠プリズム（虹色の光片が弾ける）／🫧フォーム（泡が立ちのぼる）。\n' +
      '【👑 それと、ひとつお知らせ】アリーナでいちばん強いのは <b>ちゃちゃまる</b> です。ランキングの頂点で待っています — 挑んでみてください。',
    bodyEn: '[🧱 Five new block skins] 🧊 Ice (frost cracks), 🪵 Wood (visible grain), 🫧 Jelly (wobbly and translucent), ⚙️ Steel (riveted plating), 🌌 Stardust (a night sky inside each block).\n' +
      '[🎨 Eight new stages] Deep Sea, Desert Night, Mint Forest, Midnight, Ruby, Matrix, Sunrise and Nebula. Paired with a skin, the same board can feel like a different game.\n' +
      '[✨ Four new clear effects] ❄️ Snow, 🍃 Leaf, 💠 Prism and 🫧 Foam.\n' +
      '[👑 One more thing] The strongest player in the arena is <b>ちゃちゃまる</b>. They are waiting at the top of the ranking — come and take the crown.' },
];

// ニュース本文の改訂番号。SEED_NEWS の文面を書き直したら1つ増やすと、
// すでに公開済みの投稿も次の起動で1度だけ差し替わる。
//
// これが無いと、一度出したお知らせは二度と直せなかった（seedNews は
// 英語の補完しかしないため）。実際、管理者向けの内容が載ってしまった
// v2.11.1 の本文を差し替えるのに必要になった。
const NEWS_BODY_REV = 10;  // v2.30: ショップ入荷のお知らせ＋本文の <b> が文字で出ていたのを修正

// id で引いたユーザー。`__proto__` や `constructor` を渡されると
// Object.prototype が返り、そこへの書き込みが全オブジェクトに波及する
// （実測で、モデレーターが1回の操作で管理者を含む全員をミュートできた）。
// 自前のキーであることを確かめてから返す。
function userById(id) {
  const key = String(id == null ? '' : id);
  return Object.prototype.hasOwnProperty.call(db.users, key) ? db.users[key] : undefined;
}
function seedNews() {
  // ループ内で push すると2件目以降の判定が狂うので「元から空だったか」を先に確定
  const hadNews = db.news.length > 0;
  const refresh = (db.meta.newsBodyRev || 0) < NEWS_BODY_REV;
  let refreshed = 0;
  for (const p of SEED_NEWS) {
    const existing = db.news.find(n => n && (n.id === p.id || n.title === p.title));
    if (existing) {
      // 既存の日本語のみの投稿に英語を後から補完（本番が自己修復する）
      if (!existing.titleEn) existing.titleEn = p.titleEn;
      if (!existing.bodyEn) existing.bodyEn = p.bodyEn;
      // 画像は後から足すことが多い（文面が先、絵は後）。公開済みでも補完する。
      if (!existing.image && p.image) {
        existing.image = p.image;
        existing.imageAlt = p.imageAlt || null;
        existing.imageAltEn = p.imageAltEn || null;
      }
      // 文面の改訂。投稿日時（at）は変えない — 「新着」に戻して
      // 全員に赤い印を出し直すのは、直しただけなのに騒がしい。
      // 英語面も比較に入れる。日本語の body/title だけを見ていたので、
      // 「英語の文面だけを直した」改訂が永久に公開されなかった ── 実際、
      // 住人を "an AI player" と呼んでいた1件が、NEWS_BODY_REV を上げても
      // 本番に残り続けた（日本語面は元から問題が無く、変更が無かったため）。
      if (refresh && (existing.body !== p.body || existing.title !== p.title
        || existing.bodyEn !== p.bodyEn || existing.titleEn !== p.titleEn)) {
        existing.title = p.title;
        existing.titleEn = p.titleEn;
        existing.body = p.body;
        existing.bodyEn = p.bodyEn;
        refreshed++;
      }
      continue;
    }
    // seed-1..4 は初期ロビー用 — ニュースが既に流れているサーバーには足さない
    if (['seed-1', 'seed-2', 'seed-3', 'seed-4'].includes(p.id) && hadNews) continue;
    db.news.push({
      id: p.id, title: p.title, titleEn: p.titleEn, body: p.body, bodyEn: p.bodyEn,
      image: p.image || null, imageAlt: p.imageAlt || null, imageAltEn: p.imageAltEn || null,
      pinned: !!p.pinned, by: 'るみまき', at: Date.now(),
    });
  }
  if (refresh) {
    db.meta.newsBodyRev = NEWS_BODY_REV;
    if (refreshed) console.log(`[news] お知らせ ${refreshed}件の本文を最新版に差し替えました`);
  }
  unpinOldReleaseNotes();
}

// 更新のたびに新しいお知らせを📌にしてきた結果、12件中8件が📌になっていた。
// 全部が目立つということは、何も目立っていないのと同じで、しかも金枠の
// カードが8枚も積まれて、📌でない4件が画面のはるか下に押しやられていた。
// 過去の更新履歴の📌を一度だけ外し、最新版と常設のものだけを残す。
//
// 一度きり（db.meta.newsUnpinned で記録）。管理者があとで📌し直したものを
// 起動のたびに剥がしてしまわないため。
const KEEP_PINNED = ['seed-v215', 'seed-ghost'];   // 最新の更新 ＋ 常設の小ネタ
function unpinOldReleaseNotes() {
  // KEEP_PINNED を変えたら、もう一度だけ剥がし直す必要がある。
  if (db.meta.newsUnpinned === NEWS_BODY_REV) return;
  let n = 0;
  for (const item of db.news) {
    if (!item || !item.pinned) continue;
    if (KEEP_PINNED.includes(item.id)) continue;
    item.pinned = false;
    n++;
  }
  db.meta.newsUnpinned = NEWS_BODY_REV;
  if (n) console.log(`[news] 過去の更新履歴 ${n}件の📌を外しました（最新版のみ📌）`);
}

// ---------------------------------------------------------------------------
// 🐛 バグ報告 — ゲストでも送れる。管理者パネルで確認・処理。
// ---------------------------------------------------------------------------

app.post('/api/bugreport', (req, res) => {
  if (!rateLimit(`bug:${req.ip}`, 3, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '報告が多すぎます。少し待ってください' });
  }
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (text.length < 5) return res.status(400).json({ error: 'もう少し詳しく書いてください' });
  db.bugreports = db.bugreports || [];
  db.bugreports.push({
    id: crypto.randomUUID(),
    text,
    by: req.user ? req.user.username : 'ゲスト',
    role: req.user ? req.user.role : 'guest',
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    at: Date.now(),
    status: 'open',
  });
  // Cap eviction: processed reports go first — a spammer must not be able to
  // push the operator's PENDING reports out of the box.
  //
  // 以前は処理済みが尽きると shift() で「最も古い未処理」を捨てていたので、
  // 上の約束が守れるのは処理済みが残っているあいだだけだった。連投すれば
  // 運営がまだ読んでいない報告を確実に押し出せる。捨てるのは処理済みだけに
  // 限り、それが無いときは新規のほうを断る（受けた顔をして消すより正直）。
  if (db.bugreports.length > BUGREPORT_CAP) {
    const doneIdx = db.bugreports.findIndex(b => b && b.status === 'done');
    if (doneIdx !== -1) {
      db.bugreports.splice(doneIdx, 1);
    } else {
      db.bugreports.pop();   // いま積んだ自分のぶんを取り下げる
      return res.status(503).json({ error: '報告箱がいっぱいです。少し時間をおいてからお願いします' });
    }
  }
  saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/bugreports', requireAuth, requireAdmin, (_req, res) => {
  res.json({ reports: (db.bugreports || []).slice().reverse() });
});

app.post('/api/admin/bugreports/:id', requireAuth, requireAdmin, (req, res) => {
  const b = (db.bugreports || []).find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '報告が見つかりません' });
  b.status = req.body.status === 'open' ? 'open' : 'done';
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/bugreports/:id', requireAuth, requireAdmin, (req, res) => {
  db.bugreports = (db.bugreports || []).filter(x => x.id !== req.params.id);
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 💥 クライアントJSエラーの受け口
//
// これまで、プレイヤーの端末で例外が出ても運営には何も届かなかった（本人も
// 気づかないまま画面が固まるだけ）。バグ報告と違って、これは人が書いて送る
// ものではないので、同じ不具合が何百件も積み上がる。だから件数で束ねる:
//   メッセージ＋発生位置のハッシュを鍵にして、同じものは1行のカウントを増やす。
// 保持は上限200件のリング。捨てるのは解決済みからで、それが無ければ最古の行。
// 受け口は未認証でも通す（ログイン画面で落ちたら送れないと意味がない）。
// ---------------------------------------------------------------------------
const CLIENT_ERROR_CAP = 200;

app.post('/api/clienterror', (req, res) => {
  if (!rateLimit(`cerr:${req.ip}`, 5, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます' });
  }
  const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const cut = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  const message = cut(b.message).trim();
  if (!message) return res.status(400).json({ error: 'message が必要です' });
  // スタックは先頭だけ（1行目＝発生箇所が分かれば足りる。全文は500字でも
  // 溢れるうえ、200件ぶん抱えると db.json が無視できない大きさになる）。
  const stack = cut(String(b.stack || '').split('\n')[0]).trim();
  // 発生位置。クライアント（public/js/main.js）が送っているのは
  // where = "file:line:col" の1本の文字列で、file/line/col という欄は無い。
  // ここが b.file しか読んでいなかったので where は常に空になり、
  //   ・管理画面の「📄 発生位置」が一度も描画されない
  //   ・重複判定のハッシュが実質 message だけ ＝ 別ファイル別行の同名例外
  //     （"Cannot read properties of undefined" など）が全部1行に畳まれる
  // という、いちばん残すべきものだけが落ちる状態だった。
  // b.where を正とし、旧い形（file/line/col）も互換で受ける。
  const line = Math.max(0, Math.min(9_999_999, Math.floor(Number(b.line) || 0)));
  const col = Math.max(0, Math.min(9_999_999, Math.floor(Number(b.col) || 0)));
  const file = cut(b.file).trim();
  const where = (cut(b.where).trim() || (file ? `${file}:${line}${col ? `:${col}` : ''}` : '')).slice(0, 300);
  const ua = cut(b.ua || req.headers['user-agent']);
  const lang = cut(b.lang).slice(0, 40);
  const screen = cut(b.screen).slice(0, 40);

  const hash = crypto.createHash('sha1').update(`${message}|${where}`).digest('hex').slice(0, 12);
  if (!Array.isArray(db.meta.clientErrors)) db.meta.clientErrors = [];
  const list = db.meta.clientErrors;
  const found = list.find(e => e && e.hash === hash);
  if (found) {
    found.count = (found.count || 1) + 1;
    found.lastAt = Date.now();
    // 直近の環境で上書きする（同じ不具合でも端末が分かると当たりが付く）。
    //
    // 以前は ua/lang/screen だけを入れ替えて by（報告者名）は最初の1人のまま
    // だったので、管理画面には「◯◯さん ・ 412x915@3 ・ Android…」と、
    // **別人の端末指紋がその人の名前で** 並んでいた。1行の中で人と端末が
    // 食い違わないよう、必ず同じ1件のもので揃えて入れ替える。
    found.by = req.user ? req.user.username : 'ゲスト';
    found.role = req.user ? req.user.role : 'guest';
    found.ua = ua;
    found.lang = lang;
    found.screen = screen;
    if (!found.stack && stack) found.stack = stack;
    saveDb();
    return res.json({ ok: true, hash, count: found.count });
  }
  list.push({
    hash, message, stack, where, ua, lang, screen,
    by: req.user ? req.user.username : 'ゲスト',
    role: req.user ? req.user.role : 'guest',
    count: 1, at: Date.now(), lastAt: Date.now(), status: 'open',
  });
  if (list.length > CLIENT_ERROR_CAP) {
    // 解決済みを先に捨てる。無ければ最も古い行（未解決）を捨てる ──
    // ここはバグ報告と違い「人が書いた文」ではないので、押し出されても
    // 失われるのは重複しうる自動収集の1件だけ。受けた顔をして黙って消す
    // ほうが、送信側を壊すより害が小さい。
    const doneIdx = list.findIndex(e => e && e.status === 'done');
    if (doneIdx !== -1) list.splice(doneIdx, 1);
    else {
      let oldest = 0;
      for (let i = 1; i < list.length - 1; i++) {
        if ((list[i].lastAt || 0) < (list[oldest].lastAt || 0)) oldest = i;
      }
      list.splice(oldest, 1);
    }
  }
  saveDb();
  res.json({ ok: true, hash, count: 1 });
});

app.get('/api/admin/clienterrors', requireAuth, requireAdmin, (_req, res) => {
  const list = (Array.isArray(db.meta.clientErrors) ? db.meta.clientErrors : []).slice();
  list.sort((a, b) => (b.lastAt || b.at || 0) - (a.lastAt || a.at || 0));
  res.json({
    errors: list,
    open: list.filter(e => e && e.status !== 'done').length,
    total: list.reduce((a, e) => a + (e && e.count ? e.count : 0), 0),
    cap: CLIENT_ERROR_CAP,
  });
});

app.post('/api/admin/clienterrors/:hash', requireAuth, requireAdmin, (req, res) => {
  const e = (Array.isArray(db.meta.clientErrors) ? db.meta.clientErrors : []).find(x => x && x.hash === req.params.hash);
  if (!e) return res.status(404).json({ error: 'その記録が見つかりません' });
  e.status = req.body && req.body.status === 'open' ? 'open' : 'done';
  saveDb();
  res.json({ ok: true, status: e.status });
});

app.delete('/api/admin/clienterrors/:hash', requireAuth, requireAdmin, (req, res) => {
  const list = Array.isArray(db.meta.clientErrors) ? db.meta.clientErrors : [];
  // :hash に 'all' を渡すと全消し（解決済みが溜まったときの掃除用）。
  db.meta.clientErrors = req.params.hash === 'all' ? [] : list.filter(x => x && x.hash !== req.params.hash);
  saveDb();
  res.json({ ok: true, remaining: db.meta.clientErrors.length });
});

function newsView() {
  return db.news
    .slice()
    // pinned が undefined/null だと b.pinned - a.pinned が NaN になり、
    // 「0でも正でも負でもない」ので比較が黙って日付順に落ちる。
    // 今は全経路が !! で正規化しているので発火しないが、1件混ざるだけで
    // 📌が最上部に来なくなる。真偽値に落としてから引く。
    .sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.at - a.at))
    .slice(0, 40)
    // ⚠️ ここに書き足さないとクライアントへ届かない。画像を足したとき、
    //    保存はできているのに画面に出ず、原因がここだと気づくのに手間取った。
    .map(n => ({
      id: n.id, title: n.title, titleEn: n.titleEn || null,
      body: n.body, bodyEn: n.bodyEn || null,
      image: n.image || null, imageAlt: n.imageAlt || null, imageAltEn: n.imageAltEn || null,
      pinned: !!n.pinned, at: n.at, by: n.by,
    }));
}

app.get('/api/news', (_req, res) => {
  const list = newsView();
  res.json({ news: list, latestAt: list.reduce((a, n) => Math.max(a, n.at), 0) });
});

app.post('/api/admin/news', requireAuth, requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().replace(/[<>]/g, '').slice(0, 60);
  const body = String(req.body.body || '').trim().replace(/[<>]/g, '').slice(0, 2000);
  if (!title || !body) return res.status(400).json({ error: 'タイトルと本文を入力してください' });
  // 画像は「自分のサイトの /img/ 配下」だけ。CSP が img-src 'self' なので
  // 外部URLはプレイヤー側で読み込めず、管理画面でだけ見える壊れた枠になる。
  const rawImg = String(req.body.image || '').trim();
  const image = /^\/img\/[\w./-]+\.(png|jpe?g|webp|svg|gif)$/i.test(rawImg) ? rawImg : null;
  if (rawImg && !image) {
    return res.status(400).json({ error: '画像は /img/ 配下のパスで指定してください（例: /img/news/xxx.png）' });
  }
  const n = { id: crypto.randomUUID(), title, body, image,
    imageAlt: String(req.body.imageAlt || '').replace(/[<>]/g, '').slice(0, 120) || null,
    pinned: !!req.body.pinned, by: req.user.username, at: Date.now() };
  db.news.push(n);
  // 英語版を自動翻訳で補完（外部エンジン設定時は高品質、なければ辞書）。
  translateChat(title).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.titleEn = tr2.text; saveDb(); } }).catch(() => {});
  translateChat(body).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.bodyEn = tr2.text; saveDb(); } }).catch(() => {});
  if (db.news.length > 200) db.news.shift();
  saveDb();
  if (req.body.announce !== false) {
    battle.broadcastAll({ type: 'announce', message: `📰 お知らせ「${title}」を公開しました。メニューの「ニュース」から読めます`, messageEn: `📰 News posted: "${title}" — read it from the News menu`, from: req.user.username });
    battle.crowd.feed({ icon: '📰', real: true, who: '運営', text: `お知らせ「${title}」が公開された`, textEn: `News posted: "${title}"` });
  }
  battle.broadcastAll({ type: 'news', latestAt: n.at });
  res.json({ news: newsView() });
});

app.post('/api/admin/news/:id', requireAuth, requireAdmin, (req, res) => {
  const n = db.news.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'お知らせが見つかりません' });
  if (typeof req.body.title === 'string') {
    const v = req.body.title.trim().replace(/[<>]/g, '').slice(0, 60);
    if (v && v !== n.title) {
      n.title = v;
      // 本文が変わったら英語版も作り直す（古い自動翻訳が残り続けないように）
      n.titleEn = null;
      translateChat(v).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.titleEn = tr2.text; saveDb(); } }).catch(() => {});
    }
  }
  if (typeof req.body.body === 'string') {
    const v = req.body.body.trim().replace(/[<>]/g, '').slice(0, 2000);
    if (v && v !== n.body) {
      n.body = v;
      n.bodyEn = null;
      translateChat(v).then(tr2 => { if (tr2 && tr2.lang === 'en') { n.bodyEn = tr2.text; saveDb(); } }).catch(() => {});
    }
  }
  if (typeof req.body.pinned === 'boolean') n.pinned = req.body.pinned;
  saveDb();
  res.json({ news: newsView() });
});

app.delete('/api/admin/news/:id', requireAuth, requireAdmin, (req, res) => {
  const i = db.news.findIndex(x => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'お知らせが見つかりません' });
  db.news.splice(i, 1);
  saveDb();
  res.json({ news: newsView() });
});

// Catalogue of event types (admin picker).
app.get('/api/admin/event/types', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    types: EVENT_TYPES, event: currentEvent(),
    // 📅 自動運行の状態も同じ口で返す（管理画面のポーリングを増やさない）。
    autoEvents: autoEventsOn(),
    calendar: calendarView(),
    nextEvent: autoEventsOn() ? nextScheduledEvent(Date.now(), true) : null,
  });
});

// 📅 イベント自動運行の ON/OFF。既定は OFF ── 運営が明示的に有効化するまで、
// カレンダーは1件も点火しない。ONにしても、走っているイベント（手動・投票・
// 👑管理者イベント）には一切割り込まない。
app.post('/api/admin/event/auto', requireAuth, requireAdmin, (req, res) => {
  const on = !!req.body.on;
  db.meta.autoEvents = on;
  adminLog(req, 'event_auto', on ? 'on' : 'off');   // adminLog が saveDb もする
  // ONにした瞬間が枠の中なら、次のtickを待たずに点ける。
  const started = on ? syncAutoEvent() : null;
  res.json({
    autoEvents: on,
    calendar: calendarView(),
    event: currentEvent(),
    started: !!started,
    nextEvent: on ? nextScheduledEvent(Date.now(), true) : null,
  });
});

// Start / extend / stop a limited-time event.
app.post('/api/admin/event', requireAuth, requireAdmin, (req, res) => {
  const clampMinutes = v => Math.max(1, Math.min(24 * 14 * 60, Math.floor(v)));

  // Extend the running event without restarting it.
  if (req.body.extend) {
    const ev = currentEvent();
    if (!ev) return res.status(409).json({ error: '開催中のイベントがありません' });
    ev.endsAt += clampMinutes(Number(req.body.extend) || 60) * 60 * 1000;
    saveDb();
    return res.json({ event: currentEvent() });
  }

  if (req.body.on) {
    // Duration in minutes (1 min .. 14 days). Legacy clients may still send hours.
    const rawMinutes = Number(req.body.minutes);
    const legacyHours = Number(req.body.hours);
    const minutes = clampMinutes(
      Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes
        : Number.isFinite(legacyHours) && legacyHours > 0 ? legacyHours * 60
        : 24 * 60);
    // Legacy clients send no type at all — they always meant chaos.
    db.meta.event = makeEvent(String(req.body.type || 'chaos'), sanitizeName(req.body.name), minutes, req.user.username);
    const ev = db.meta.event;
    battle.broadcastAll({
      type: 'announce',
      message: `${ev.icon} 期間限定イベント「${ev.name}」開催！ ${ev.desc}`,
      messageEn: `${ev.icon} Limited-time event "${ev.nameEn || ev.name}" is live! ${ev.descEn || ''}`,
      from: req.user.username,
    });
    battle.crowd.feed({ icon: ev.icon, real: true, who: '運営', text: `イベント「${ev.name}」が始まった！ ${ev.desc}`, textEn: `Event "${ev.nameEn || ev.name}" is live! ${ev.descEn || ev.desc}` });
    battle.crowd.react('event_start');
  } else {
    const was = db.meta.event;
    db.meta.event = null;
    battle.broadcastAll({
      type: 'announce',
      message: `${was ? was.icon : '🌪️'} 期間限定イベントは終了しました。また次回！`,
      messageEn: `${was ? was.icon : '🌪️'} The limited-time event has ended — see you next time!`,
      from: req.user.username,
    });
    battle.crowd.react('event_end');
  }
  saveDb();
  res.json({ event: currentEvent() });
});

// ---------------------------------------------------------------------------
// Weekly challenge: one shared seed per week (Monday 00:00 UTC reset).
// Everyone gets the identical piece sequence — pure score attack.
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_PIECES = 40;

function currentWeekNum() {
  // Unix epoch was a Thursday; shift by 4 days so weeks flip on Monday UTC.
  return Math.floor((Date.now() - 4 * 24 * 60 * 60 * 1000) / WEEK_MS);
}
function weekIdOf(n) { return `W${n}`; }
function weeklySeed(weekId) {
  let h = 0;
  const s = `bba-weekly-${weekId}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0) & 0x7fffffff;
}

// 🗓 ウィークリー / 📅 デイリーチャレンジ — routes/daily.js
app.use(weeklyDailyRouter);

// 🎞 リプレイ / 🏗 ブループリント — routes/daily.js
app.use(dailyReplayRouter);

// ---------------------------------------------------------------------------
// 🛠 パズル工房 — routes/workshop.js
// ---------------------------------------------------------------------------
app.use(workshopRouter);

// ---------------------------------------------------------------------------
// Weekly ranking rewards (ランキング報酬)
//
// When the week rolls over, everyone who set a weekly-challenge score gets
// coins/gems by final rank — real players only, so the AI residents on the
// board never take a prize from a person. #1 also earns the 週間チャンピオン
// badge (and its title). Granted lazily from boot + the hot endpoints,
// because the free-tier server may well be asleep at Monday 00:00 UTC.
// ---------------------------------------------------------------------------

const WEEKLY_RANK_REWARDS = [
  { upTo: 1,        coins: 2000, gems: 300, badge: 'weekly1' },
  { upTo: 2,        coins: 1200, gems: 180 },
  { upTo: 3,        coins: 800,  gems: 120 },
  { upTo: 10,       coins: 500,  gems: 60 },
  { upTo: 30,       coins: 300,  gems: 30 },
  { upTo: Infinity, coins: 150,  gems: 10 },
];
function rankRewardFor(rank) {
  return WEEKLY_RANK_REWARDS.find(t => rank <= t.upTo) || WEEKLY_RANK_REWARDS[WEEKLY_RANK_REWARDS.length - 1];
}
// JSON-safe copy for the client (Infinity does not survive res.json).
const rankRewardsTable = () => WEEKLY_RANK_REWARDS.map(t => ({
  upTo: Number.isFinite(t.upTo) ? t.upTo : null, coins: t.coins, gems: t.gems, badge: t.badge || null,
}));

function finalizeWeeklyRankings() {
  const curW = weekIdOf(currentWeekNum());
  if (db.meta.lastRankRewardWeek === curW) return;
  // A fresh post-deploy DB has nobody to rank — don't burn the weekly stamp,
  // or the players about to be auto-restored would wait a full week for the
  // payout of their already-finished week.
  if (!Object.values(db.users).some(u => u.role !== 'admin' && !u.banned)) return;
  db.meta.lastRankRewardWeek = curW;
  // Stale weekly records (any past week — the server may have slept through
  // several) are grouped per week, ranked, and marked so a record is never
  // paid twice even across backup/restore cycles.
  const byWeek = new Map();
  for (const u of Object.values(db.users)) {
    const w = u.stats && u.stats.weekly;
    if (!w || w.week === curW || w.rewarded || !(w.best > 0)) continue;
    w.rewarded = true;
    if (u.banned || u.role === 'admin') continue;
    if (!byWeek.has(w.week)) byWeek.set(w.week, []);
    byWeek.get(w.week).push(u);
  }
  for (const [week, players] of byWeek) {
    players.sort((a, b) => b.stats.weekly.best - a.stats.weekly.best);
    players.forEach((u, i) => {
      migrateUser(u);
      const rank = i + 1;
      if (rank === 1) u.stats.weeklyWins = (u.stats.weeklyWins || 0) + 1;
      const t = rankRewardFor(rank);
      u.rankRewards.push({
        id: crypto.randomUUID(), board: 'weekly', week, rank, of: players.length,
        best: u.stats.weekly.best, coins: t.coins, gems: t.gems, badge: t.badge || null, at: Date.now(),
      });
    });
    const medals = ['🥇', '🥈', '🥉'];
    const top = players.slice(0, 3).map((u, i) => `${medals[i]} ${u.username}（${fmtNum(u.stats.weekly.best)}点）`);
    db.news.push({
      id: crypto.randomUUID(),
      title: `🏆 週間チャレンジ結果発表（${week}）`,
      titleEn: `🏆 Weekly Challenge results (${week})`,
      body: `先週の週間チャレンジの結果です（参加${players.length}人）！\n${top.join('\n')}\n\n参加者全員に順位に応じたコイン＆ジェムをお届けしました。ゲームを開くと受け取れます。今週のチャレンジも開催中！`,
      bodyEn: `Last week's Weekly Challenge results (${players.length} entrants)!\n${top.join('\n')}\n\nEveryone received coins & gems for their placement — open the game to claim. This week's challenge is already live!`,
      pinned: false, by: '運営', at: Date.now(),
    });
    if (db.news.length > 200) db.news.shift();
    battle.crowd.feed({
      icon: '🏆', real: true, who: '運営',
      text: `週間チャレンジ結果発表！1位は ${players[0].username}`,
      textEn: `Weekly challenge results are in — #1 is ${players[0].username}!`,
    });
    battle.crowd.react('champion', { you: players[0].username });
  }
  saveDb();
}

// ---------------------------------------------------------------------------
// 🏛 シーズン殿堂 (Hall of Fame)
//
// シーズンが切り替わったら、切替前シーズンの TOP3 を db.meta.hallOfFame に
// 永久保存する。週間精算（finalizeWeeklyRankings）とまったく同じ作法:
//   ・遅延実行（無料枠のサーバーは切替の瞬間に寝ている）
//   ・「済んだ」印を db.meta に持ち、二度払いしない
//   ・実プレイヤーが1人もいない機体では印を進めない（復元待ちを焼かない）
// 報酬は新しい配布経路を作らず、既存の rankRewards インボックスに積む
// （/api/rank/claim がまとめて受け取る）。
//
// 住人（ゴースト）も殿堂には載る ── ランキングと同じ合成を使うので、
// 「あのシーズンはあの人が強かった」という記憶がボードと食い違わない。
// ただし報酬はアカウントを持つ実プレイヤーにしか出ない。
// ---------------------------------------------------------------------------

const HOF_BOARDS = [
  { id: 'rating', name: 'レート',             nameEn: 'Rating' },
  { id: 'score',  name: 'ハイスコア',         nameEn: 'High Score' },
  { id: 'wins',   name: '週間チャレンジ優勝', nameEn: 'Weekly Challenge wins' },
];
const HOF_GEMS = [400, 200, 100];       // 1位 / 2位 / 3位
// 表彰に必要な実プレイヤーの最少人数。1人しか値を持たないボードで
// 無条件に 400💎 が出るのを防ぐ（rating は新規の初期値が1000なので、
// gamesPlayed>0 の全員が候補に入る = 少人数の機体では素通りしていた）。
const HOF_MIN_ENTRANTS = 3;
const HOF_MAX_SEASONS = 100;            // これを越えたら古い順に落とす（実質8年ぶん）
// シーズン刻印バッジ。ADMIN_KNOWN_BADGES に固定では書けない（シーズンごとに
// 増える）ので、形で許可する。
const SEASON_BADGE_RE = /^s\d{1,4}champ$/;

function seasonMarkOf(s) {
  return { id: s.id, number: s.number, name: s.name, nameEn: s.nameEn, startedAt: s.startedAt, endsAt: s.endsAt };
}

function hofValueOf(board, u) {
  const s = u.stats || {};
  return board === 'rating' ? (s.rating || 0)
    : board === 'score' ? (s.bestScore || 0)
    : (s.weeklyWins || 0);
}

// そのボードの上位3人（実プレイヤー＋住人）。
function hofTopOf(board) {
  const rows = [];
  for (const u of Object.values(db.users)) {
    if (u.banned || u.role === 'admin' || !u.stats || !(u.stats.gamesPlayed > 0)) continue;
    const value = hofValueOf(board, u);
    if (value > 0) rows.push({ username: u.username, value, resident: false, userId: u.id });
  }
  // 週間チャレンジの優勝回数は住人が持たない値なので、そこだけ実プレイヤーのみ。
  if (board !== 'wins') {
    const taken = new Set(Object.values(db.users).map(u => u.username));
    const week = weekIdOf(currentWeekNum());
    try {
      for (const r of ghostRows(board === 'score' ? 'score' : 'rating', week, taken)) {
        const value = board === 'score' ? (r.bestScore || 0) : (r.rating || 0);
        if (value > 0) rows.push({ username: r.username, value, resident: true, userId: null });
      }
    } catch (err) {
      console.warn('[halloffame] 住人の合成に失敗:', err && err.message);
    }
  }
  rows.sort((a, b) => b.value - a.value);
  // 表示用（top）は住人込み ── ボードの見た目はランキングと揃っていてほしい。
  // 報酬用（realTop）は住人を外してから順位を振り直す。以前は表示用の上位3人から
  // 住人を「飛ばす」だけだったので、住人が上位を占めた回は 400/200/100💎 が
  // 誰にも配られず消えていた（ニュースには住人が1位として載るのに、である）。
  const real = rows.filter(r => !r.resident);
  return {
    entrants: rows.length,
    top: rows.slice(0, 3).map((r, i) => ({ rank: i + 1, ...r })),
    realEntrants: real.length,
    realTop: real.slice(0, 3).map((r, i) => ({ rank: i + 1, ...r })),
  };
}

function settleSeasonHallOfFame() {
  const cur = currentSeason();
  const prev = db.meta.seasonMark;
  if (prev && prev.id === cur.id) return;
  // 再デプロイ直後の空DB（復元待ち）では、刻印すら置かずに戻る。この門は
  // 「初回は刻印を置くだけ」の分岐より **前** でなければならない ── backup.js の
  // メタ合流は `db.meta[k] == null` のときだけ backup 側を採用するので、
  // 復元前にここで印を置いてしまうと、復元で戻ってきた seasonMark は採用されず、
  // 直前シーズンの殿堂入り・上位3名の💎・1位の刻印バッジが二度と表彰されない。
  if (!Object.values(db.users).some(u => u.role !== 'admin' && !u.banned)) return;
  // 初回（この機能が入る前からある機体）は刻印を置くだけ。
  // 直前のシーズンがどうだったかを知らないまま表彰しても嘘になる。
  if (!prev || !prev.id) { db.meta.seasonMark = seasonMarkOf(cur); saveDb(); return; }

  if (!Array.isArray(db.meta.hallOfFame)) db.meta.hallOfFame = [];
  if (db.meta.hallOfFame.some(e => e && e.season === prev.id)) {
    db.meta.seasonMark = seasonMarkOf(cur);
    saveDb();
    return;
  }

  const badge = `s${prev.number}champ`;
  const boards = [];
  const winners = [];
  for (const b of HOF_BOARDS) {
    const { entrants, top, realTop, realEntrants } = hofTopOf(b.id);
    if (!top.length) continue;
    boards.push({ id: b.id, name: b.name, nameEn: b.nameEn, entrants, top: top.map(t => ({ rank: t.rank, username: t.username, value: t.value, resident: t.resident })) });
    // フィードの見出しはボードの表示どおり（住人が首位ならその名前）。
    if (top[0]) winners.push({ username: top[0].username, board: b.name, boardEn: b.nameEn });
    // 実プレイヤーが少なすぎるボードは表彰を見送る（1人で400💎を防ぐ）。
    if (realEntrants < HOF_MIN_ENTRANTS) continue;
    for (const t of realTop) {
      if (!t.userId) continue;                       // 住人には配らない
      const u = db.users[t.userId];
      if (!u) continue;
      migrateUser(u);
      const gems = HOF_GEMS[t.rank - 1] || HOF_GEMS[HOF_GEMS.length - 1];
      u.rankRewards.push({
        id: crypto.randomUUID(),
        board: `hof_${b.id}`,
        season: prev.id, seasonNumber: prev.number,
        seasonName: prev.name, seasonNameEn: prev.nameEn,
        boardName: b.name, boardNameEn: b.nameEn,
        // 順位は実プレイヤーだけで数え直したものなので、母数もそれに揃える。
        rank: t.rank, of: realEntrants, best: t.value,
        coins: 0, gems, badge: t.rank === 1 ? badge : null,
        at: Date.now(),
      });
    }
  }

  const entry = {
    season: prev.id, number: prev.number,
    name: prev.name, nameEn: prev.nameEn,
    startedAt: prev.startedAt || null, endsAt: prev.endsAt || Date.now(),
    at: Date.now(), badge, boards,
  };
  db.meta.hallOfFame.push(entry);
  if (db.meta.hallOfFame.length > HOF_MAX_SEASONS) {
    db.meta.hallOfFame.splice(0, db.meta.hallOfFame.length - HOF_MAX_SEASONS);
  }
  db.meta.seasonMark = seasonMarkOf(cur);

  if (boards.length) {
    const medals = ['🥇', '🥈', '🥉'];
    const lineJa = boards.map(b => `【${b.name}】\n${b.top.map(t => `${medals[t.rank - 1]} ${t.username}（${fmtNum(t.value)}）`).join('\n')}`).join('\n\n');
    const lineEn = boards.map(b => `[${b.nameEn}]\n${b.top.map(t => `${medals[t.rank - 1]} ${t.username} (${fmtNum(t.value)})`).join('\n')}`).join('\n\n');
    db.news.push({
      id: crypto.randomUUID(),
      title: `🏛 ${prev.name} 殿堂入り発表`,
      titleEn: `🏛 ${prev.nameEn} Hall of Fame`,
      body: `${prev.name}が終了しました。歴代の記録として殿堂に刻まれた顔ぶれです。\n\n${lineJa}\n\n各ボードで上位に入った挑戦者にはジェムを、その首位にはシーズン刻印バッジをお届けしました（ゲームを開くと受け取れます）。新シーズンもよろしくお願いします！`,
      bodyEn: `${prev.nameEn} has ended — here are the names carved into the Hall of Fame.\n\n${lineEn}\n\nThe top challengers on each board received gems, and the highest of them earned the season champion badge — open the game to claim. See you in the new season!`,
      pinned: false, by: '運営', at: Date.now(),
    });
    if (db.news.length > 200) db.news.shift();
    if (battleReady) {
      const head = winners[0];
      battle.crowd.feed({
        icon: '🏛', real: true, who: '運営',
        text: `${prev.name}が閉幕。殿堂入りが決まりました${head ? `（${head.board}の1位は ${head.username}）` : ''}`,
        textEn: `${prev.nameEn} has closed — the Hall of Fame is set${head ? ` (${head.boardEn} #1: ${head.username})` : ''}.`,
      });
      if (head) battle.crowd.react('champion', { you: head.username });
    }
  }
  saveDb();
  console.log(`[halloffame] ${prev.name}(${prev.id}) を殿堂に記録しました（${boards.length}ボード）`);
}

// 歴代の殿堂。未認証でも読める（ランキングと同じIPレート制限）。
app.get('/api/halloffame', (req, res) => {
  if (!rateLimit(`hof:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください' });
  settleSeasonHallOfFame();
  const admin = !!(req.user && req.user.role === 'admin');
  const list = (Array.isArray(db.meta.hallOfFame) ? db.meta.hallOfFame : [])
    .slice()
    .sort((a, b) => (b.number || 0) - (a.number || 0))
    .slice(0, 50)
    // 🎭 殿堂の各行には resident:true/false が焼かれている（db.meta.hallOfFame は
    // 保存されるので、過去のシーズンぶんも全部）。非管理者にはその印を落とす。
    // 関門も落とすが、保存済みのデータをそのまま流す経路なので、ここでも明示的に。
    .map(e => (admin ? e : {
      ...e,
      boards: (Array.isArray(e.boards) ? e.boards : []).map(b => ({
        ...b,
        top: (Array.isArray(b.top) ? b.top : []).map(({ resident, ...t }) => t),
      })),
    }));
  res.json({ seasons: list, current: currentSeason() });
});

// ---------------------------------------------------------------------------
// 👑 王座 (Thrones) — the CURRENT #1 real player of each leaderboard.
// Derived from stats on demand (memoized); db.meta.thrones only snapshots the
// holders so takeovers can be detected and announced. Holding a throne shows a
// crown on the leaderboard / in chat / on the profile, and pays a stipend on
// top of the daily login bonus. Admins, banned players and ghost residents
// can never hold one — this is for real players.
// ---------------------------------------------------------------------------

const THRONE_BOARDS = {
  score:   { name: 'スコア',         nameEn: 'Score',       value: u => u.stats.bestScore || 0 },
  rating:  { name: 'レート',         nameEn: 'Rating',      value: u => u.stats.rating || 0, min: 1001 },
  sprint:  { name: 'タイムアタック', nameEn: 'Time Attack', value: u => (u.stats.sprint && u.stats.sprint.s60) || 0 },
  dungeon: { name: 'ダンジョン',     nameEn: 'Dungeon',     value: u => u.stats.dungeonMax || 0 },
  weekly:  { name: 'ウィークリー',   nameEn: 'Weekly',      value: u => (u.stats.weekly && u.stats.weekly.week === weekIdOf(currentWeekNum()) ? u.stats.weekly.best : 0) },
  puzzle:  { name: 'パズル遺跡',     nameEn: 'Puzzle Ruins', value: u => u.stats.puzzleStage || 0 },
  dig:     { name: '採掘場',         nameEn: 'The Mines',   value: u => u.stats.digDepth || 0 },
};
const THRONE_DAILY_COINS = 150;
const THRONE_DAILY_GEMS = 2;

let thronesMemo = { at: 0, map: null };

function computeThrones() {
  const now = Date.now();
  if (thronesMemo.map && now - thronesMemo.at < 5000) return thronesMemo.map;
  const week = weekIdOf(currentWeekNum());
  const realCands = [];
  for (const u of Object.values(db.users)) {
    if (u.banned || u.role === 'admin' || !u.stats || !(u.stats.gamesPlayed > 0)) continue;
    realCands.push({ id: u.id, username: u.username, createdAt: u.createdAt || 0, resident: false, user: u });
  }
  // 実プレイヤーと同名の住人は王座戦線から外す。ghostRows は taken で同名住人を
  // ボードから隠すのに、王座計算だけ素通しだった ── 隠れた住人が王座を取ると、
  // ランキングは同名の実プレイヤーの行に👑を付ける一方、俸給もプロフィールの
  // 王座もその人には付かない（王座は res:<id> に紐づく）。誰も得しない幻の王冠。
  // 全 db.users 名で照合（ghostRows の taken と同じ広さ）。
  const realNames = new Set(Object.values(db.users).map(u => String(u.username || '').toLowerCase()));
  // 👑 住人（AIプレイヤー）も王座戦線に参戦 — 王座が空位のまま眠らないように。
  // 候補は「そのボードに実際に表示される住人サブセット」(boardResidents) 限定、
  // 値はゴースト行と同じ式 — 王冠が見えない行に付くことは構造的にない。
  // にぎわいOFF（scale 0 / ghostsトグルOFF）のときは従来どおり実プレイヤーのみ。
  const stCache = new Map();
  const residentValue = (r, board) => {
    let st = stCache.get(r.id);
    if (!st) { st = residentStats(r, now, week); stCache.set(r.id, st); }
    switch (board) {
      case 'score': return st.bestScore;
      case 'rating': return st.rating;
      case 'sprint': return st.sprintBest;
      case 'dungeon': return st.dungeonMax;
      case 'weekly': return st.weeklyBest;
      case 'puzzle': return Math.max(1, Math.round((st.dungeonMax || 8) * 0.55));
      case 'dig': return Math.max(3, Math.round((st.dungeonMax || 8) * 0.75));
      default: return 0;
    }
  };
  // Equal values: a real player beats a resident; among equals the older
  // account keeps the crown (the incumbent defends).
  const beats = (a, aV, b, bV) => aV > bV
    || (aV === bV && b && (b.resident && !a.resident || (b.resident === a.resident && a.createdAt < b.createdAt)));
  const map = {};
  for (const [board, def] of Object.entries(THRONE_BOARDS)) {
    const cands = realCands.slice();
    for (const r of boardResidents(board, week)) {
      if (realNames.has(String(r.name).toLowerCase())) continue;   // 同名の実プレイヤーがいる住人は除外
      cands.push({ id: `res:${r.id}`, username: r.name, createdAt: 0, resident: true, r });
    }
    let best = null, bestV = 0;
    for (const c of cands) {
      const v = Number(c.resident ? residentValue(c.r, board) : def.value(c.user)) || 0;
      if (v < (def.min || 1)) continue;
      if (!best || beats(c, v, best, bestV)) { best = c; bestV = v; }
    }
    if (best) map[board] = { userId: best.id, username: best.username, value: bestV, resident: best.resident };
  }
  thronesMemo = { at: now, map };
  return map;
}

// Diff against the stored holders and announce takeovers. The very first
// computation (fresh DB / just restored) seeds silently — no boot spam.
// force=true bypasses the memo — callers that just CHANGED stats use it, or a
// freshly-cached pre-change map would hide the takeover for a few seconds.
function refreshThrones(force = false) {
  if (force) thronesMemo.at = 0;
  const cur = computeThrones();
  const prev = db.meta.thrones;
  const next = {};
  let moved = false;
  for (const [board, t] of Object.entries(cur)) {
    const old = prev && prev[board];
    next[board] = { userId: t.userId, username: t.username, value: t.value, resident: !!t.resident, at: old && old.userId === t.userId ? old.at : Date.now() };
    if (!old || old.userId !== t.userId) moved = true;
    // Same holder under a NEW name (rename): persist the fresh snapshot so the
    // username-keyed displays (leaderboard crowns, chat presence) follow along
    // — but don't announce a takeover that didn't happen.
    else if (old.username !== t.username || old.value !== t.value) moved = true;
  }
  if (prev && Object.keys(prev).some(b => !next[b])) moved = true;
  if (!prev) { db.meta.thrones = next; saveDb(); return; }
  if (!moved) return;
  for (const [board, t] of Object.entries(next)) {
    const old = prev[board];
    if (old && old.userId === t.userId) continue;
    // 週間王座は毎週月曜にリセットされ、人間のスコアが0に戻る。その瞬間に
    // 住人が必ず「奪取」するので、これを毎週告知すると正当な週間王者が毎週
    // AIに公開処刑される。住人が週間王座を取る動きは黙って処理する（人間が
    // 取り返すときは告知される）。王座の保持自体は下で記録し表示は正しいまま。
    if (board === 'weekly' && t.resident) continue;
    const def = THRONE_BOARDS[board];
    battle.crowd.feed({
      icon: '👑', real: true, who: t.username,
      text: old ? `${t.username} が ${old.username} から${def.name}の王座を奪取！！` : `${t.username} が${def.name}の王座に就いた！`,
      textEn: old ? `${t.username} seized the ${def.nameEn} throne from ${old.username}!!` : `${t.username} claimed the ${def.nameEn} throne!`,
    });
    // 新王者が住人でも、当の本人が自分を祝わないように除外する。
    battle.crowd.react('throne', { you: t.username, board: { name: def.name, nameEn: def.nameEn }, notName: t.username });
  }
  db.meta.thrones = next;
  // 多冠の節目（2/3/5/7冠）に達した実プレイヤーへ永久バッジ。冠を失っても
  // バッジは残る — 「あの時代の王」の証。
  const counts = new Map();
  for (const t of Object.values(next)) if (!t.resident) counts.set(t.userId, (counts.get(t.userId) || 0) + 1);
  for (const [userId, n] of counts) {
    const u = db.users[userId];
    if (!u) continue;
    for (const [need, id] of [[2, 'crown2'], [3, 'crown3'], [5, 'crown5'], [7, 'crown7']]) {
      if (n >= need && !u.badges.includes(id)) {
        u.badges.push(id);
        battle.crowd.feed({
          icon: '👑', real: true, who: u.username,
          text: `${u.username} が${CROWN_TIER_NAMES[id]}を達成！バッジ獲得！`,
          textEn: `${u.username} earned the ${CROWN_TIER_NAMES_EN[id]} badge!`,
        });
      }
    }
  }
  saveDb();
}

const CROWN_TIER_NAMES = { crown2: '二冠', crown3: '三冠', crown5: '五冠', crown7: '全冠制覇' };
const CROWN_TIER_NAMES_EN = { crown2: 'Dual Crown', crown3: 'Triple Crown', crown5: 'Five Crowns', crown7: 'Total Domination' };

function thronesOf(userId) {
  if (!userId) return [];
  const map = db.meta.thrones || computeThrones();
  return Object.keys(map).filter(b => map[b] && map[b].userId === userId);
}

// Residents have no account id — their thrones are looked up by (unique) name.
function thronesOfName(username) {
  if (!username) return [];
  const map = db.meta.thrones || computeThrones();
  return Object.keys(map).filter(b => map[b] && map[b].username === username);
}

// Claim every pending ranking reward at once.
app.post('/api/rank/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  finalizeWeeklyRankings();
  const pending = req.user.rankRewards;
  if (!pending.length) return res.status(409).json({ error: '受け取れるランキング報酬はありません' });
  let coins = 0, gems = 0;
  const badges = [];
  for (const r of pending) {
    coins += r.coins || 0;
    gems += r.gems || 0;
    if (r.badge && !req.user.badges.includes(r.badge)) { req.user.badges.push(r.badge); badges.push(r.badge); }
  }
  req.user.coins += coins;
  req.user.gems += gems;
  const claimed = pending.slice();
  req.user.rankRewards = [];
  saveDb();
  res.json({ reward: { coins, gems, badges }, claimed, user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Game results & leaderboard
// ---------------------------------------------------------------------------

// Per-game rewards are capped (score rate, coin ceiling), but the ENDPOINT had
// no limit at all — a loop against it minted coins, gems, XP and badges as fast
// as the network allowed. A real game takes 20+ seconds, and even the fastest
// mode (a ★3 puzzle stage) tops out near 80 runs an hour, so these ceilings are
// far above legitimate play and still turn "unlimited" into "bounded".
app.post('/api/game/result', requireAuth, maintenanceResultGuard, (req, res) => {
  const tooFast = !rateLimit(`result:${req.user.id}`, 30, 60 * 1000)
    || !rateLimit(`resulth:${req.user.id}`, 250, 60 * 60 * 1000);
  if (tooFast) {
    return res.status(429).json({ error: '結果の送信が多すぎます。しばらく待ってください' });
  }
  // req.body をそのまま渡してはいけない。applyGameResult は
  // `trusted`（サーバー判定モードの申告を通す）と `preClamped`
  // （時間の頭押さえを飛ばす）という内部専用の鍵を読むので、
  // 素通しだと自己申告でどちらも立てられる。実測で
  //   { mode:'royale', won:true, trusted:true }  → バトロワの勝利バッジ＋150💎
  //   { score:1000000, duration:3600, preClamped:true } → 100万点がそのまま通る
  // が通っていた。クライアントが名乗ってよい欄だけを写して渡す。
  const rewards = applyGameResult(req.user, pickResultFields(req.body));
  // 🎞 リプレイ（着手ログ）は applyGameResult の「外」で受け取る。
  // 中に入れないのは、スコア・報酬・ストリークの計算に一切触れさせないため ──
  // 壊れたリプレイも偽のリプレイも、ここで黙って捨てられるだけで済む。
  // pickResultFields が replay を落としているのも同じ理由（申告できる欄にしない）。
  let replaySaved = false;
  try { replaySaved = captureDailyReplay(req.user, req.body, rewards); }
  catch (err) { console.warn('[replay] 保存に失敗:', err && err.message); }
  res.json({ rewards, user: publicUser(req.user), replaySaved });
});

// クライアントが申告してよい欄。ここに無いものは黙って捨てる。
// 新しい欄を applyGameResult に足したら、ここにも足すか判断すること
// （内部専用の鍵なら足さない）。
const RESULT_FIELDS = [
  'mode', 'score', 'lines', 'maxCombo', 'duration', 'won', 'drew',
  'bossId', 'floor', 'wave', 'ults', 'items', 'pieces', 'floors',
  'sprintDur', 'rank', 'depth', 'stage',
  // ⛓️ 連鎖カスケードの最大連鎖数。他のテレメトリと同じく実プレイ判定を
  // 通った回だけ反映される（applyGameResult 側で clamp(…,64)）ので名乗らせてよい。
  'maxChain',
  // ✨全消し「昇華」の回数。他のテレメトリと同じく実プレイ判定を通った回だけ
  // 累積される（applyGameResult 側）ので、名乗らせてよい。
  'perfectClears',
  // 📅 デイリー: 走った盤面の日と、開始時に発行した挑戦の証。どちらも
  // 「報酬を増やせる申告」ではなく、サーバーが持っている予約と突き合わせる
  // ための識別子なので、名乗らせてよい（day は形式を、attemptId は保存済みの
  // pending との一致を applyGameResult 側で必ず検証する）。
  'day', 'attemptId',
];
function pickResultFields(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const out = {};
  for (const k of RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 👑 管理者イベント（参加者側 ＋ 運営側）— routes/adminevent.js
// ---------------------------------------------------------------------------
app.use(adminEventRouter);

app.get('/api/leaderboard', (req, res) => {
  // 無認証だが、全 db.users を走査＋ゴースト合成＋ソートする O(ユーザー数) の
  // 重い経路。他の公開読み取り(/api/profile 等)と同じIPレート制限で連打を抑える。
  if (!rateLimit(`lb:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください' });
  finalizeWeeklyRankings();
  refreshThrones();   // Elo changes happen over websockets — catch up here
  const board = ['rating', 'dungeon', 'weekly', 'sprint', 'puzzle', 'dig', 'daily'].includes(req.query.board) ? req.query.board : 'score';
  const week = weekIdOf(currentWeekNum());
  const weeklyBestOf = u => (u.stats.weekly && u.stats.weekly.week === week ? u.stats.weekly.best : 0);
  // 📅 デイリーはその日の記録だけ（JST日が変わればボードごとリセット）。
  const dayKey = jstDayKey();
  const dailyOf = u => (u.stats.dailyc && u.stats.dailyc.day === dayKey ? u.stats.dailyc.score : 0);
  // Time attack ranks on the headline 60-second board.
  const sprintBestOf = u => (u.stats.sprint && u.stats.sprint.s60) || 0;
  // Admins are excluded from public rankings.
  let users = Object.values(db.users).filter(u => !u.banned && u.role !== 'admin' && u.stats.gamesPlayed > 0);
  if (board === 'dungeon') users = users.filter(u => (u.stats.dungeonMax || 0) > 0);
  if (board === 'weekly') users = users.filter(u => weeklyBestOf(u) > 0);
  if (board === 'sprint') users = users.filter(u => sprintBestOf(u) > 0);
  if (board === 'puzzle') users = users.filter(u => (u.stats.puzzleStage || 0) > 0);
  if (board === 'dig') users = users.filter(u => (u.stats.digDepth || 0) > 0);
  if (board === 'daily') users = users.filter(u => dailyOf(u) > 0);
  const titleOf = u => {
    const t = TITLES.find(x => x.id === u.equippedTitle);
    // id を落としていたので、画面側が英語名に引き当てられなかった。
    // 英語でプレイしていてもランキングの称号だけ日本語のままになる。
    return t ? { id: t.id, name: t.name, color: t.color } : null;
  };
  const realRows = users.map(u => ({
    username: u.username,
    guildTag: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].tag : null,
    abyssMax: u.stats.abyssMax || 0,
    level: levelOf(u.xp),
    bestScore: u.stats.bestScore,
    rating: u.stats.rating,
    pvpWins: u.stats.pvpWins,
    pvpLosses: u.stats.pvpLosses,
    dungeonMax: u.stats.dungeonMax || 0,
    weeklyBest: weeklyBestOf(u),
    sprintBest: sprintBestOf(u),
    sprint180: (u.stats.sprint && u.stats.sprint.s180) || 0,
    puzzleStage: u.stats.puzzleStage || 0,
    digDepth: u.stats.digDepth || 0,
    dailyScore: dailyOf(u),
    badges: u.badges,
    title: titleOf(u),
  }));
  // Ghost players pad the boards so rankings feel populated (weekly reshuffle).
  //
  // ゴースト行の🛡️タグを tagOfName で1行ずつ引くと、そのたびに
  // Object.values(db.users) を作り直して名前を線形検索することになり、
  // 計算量が O(行数 × ユーザー数) になる。行数は40〜100、走査対象は全アカウント
  // なので、人が増えるほどこの1リクエストの間だけイベントループが素で止まる
  // （投票側の battle.js:716 が先に踏んだのと同じ轍。あちらは db.users を見ない
  //  residentGuildTag に逃がして解決済みで、ランキングだけが古いままだった）。
  // `taken` を作るこの1周で「名前 → ギルドタグ」の索引も一緒に作り、ゴースト行は
  // それを引くだけにする。索引に無い名前（＝実プレイヤーではない住人）だけ
  // ghostGuildOfResident へ落とす。これで走査は1回、O(ユーザー数 + 行数) になる。
  const taken = new Set();
  const tagByName = new Map();
  for (const u of Object.values(db.users)) {
    taken.add(u.username);
    const g = u.guildId ? db.guilds[u.guildId] : null;
    if (g) tagByName.set(u.username, g.tag);
  }
  const ghostTagOf = (name) => {
    if (tagByName.has(name)) return tagByName.get(name);
    const g = ghostGuildOfResident(name);
    return g ? g.tag : null;
  };
  const rows = realRows
    .concat(ghostRows(board, week, taken).map(r => ({ ...r, guildTag: ghostTagOf(r.username) })))
    .sort((a, b) => board === 'rating' ? b.rating - a.rating
      : board === 'dungeon' ? b.dungeonMax - a.dungeonMax
      : board === 'weekly' ? b.weeklyBest - a.weeklyBest
      : board === 'sprint' ? (b.sprintBest || 0) - (a.sprintBest || 0)
      : board === 'puzzle' ? (b.puzzleStage || 0) - (a.puzzleStage || 0)
      : board === 'dig' ? (b.digDepth || 0) - (a.digDepth || 0)
      : board === 'daily' ? (b.dailyScore || 0) - (a.dailyScore || 0)
      : b.bestScore - a.bestScore)
    .slice(0, 100);
  // 👑 mark the throne holder's row + total crown counts (name colors scale).
  const throne = (db.meta.thrones || {})[board];
  if (throne) for (const r of rows) if (r.username === throne.username) r.throne = true;
  const crownCounts = new Map();
  for (const t of Object.values(db.meta.thrones || {})) if (t) crownCounts.set(t.username, (crownCounts.get(t.username) || 0) + 1);
  for (const r of rows) { const c = crownCounts.get(r.username); if (c) r.crowns = c; }
  // The weekly board pays prizes at the Monday reset — send the tier table.
  res.json({ board, rows, throne: throne ? { username: throne.username, since: throne.at } : null, ...(board === 'weekly' ? { rewards: rankRewardsTable() } : {}) });
});

// ---------------------------------------------------------------------------
// Titles (称号)
// ---------------------------------------------------------------------------

app.get('/api/titles', (req, res) => {
  res.json({
    titles: TITLES,
    earned: req.user ? earnedTitles(req.user) : [],
    equipped: req.user ? req.user.equippedTitle : null,
  });
});

app.post('/api/titles/equip', requireAuth, (req, res) => {
  const id = req.body.id === null ? null : String(req.body.id || '');
  if (id !== null) {
    if (!TITLES.some(t => t.id === id)) return res.status(404).json({ error: '称号が見つかりません' });
    if (!earnedTitles(req.user).includes(id)) return res.status(403).json({ error: 'まだ獲得していない称号です' });
  }
  req.user.equippedTitle = id;
  saveDb();
  res.json({ user: publicUser(req.user) });
});

// 📕 コレクション図鑑（catalog.js の COLLECTION_SETS）— routes/guild.js
app.use(collectionRouter);

// ---------------------------------------------------------------------------
// Boss battles
// ---------------------------------------------------------------------------

app.get('/api/bosses', (req, res) => {
  // 🐲 Boss Invasion softens every boss while it runs.
  const hpMult = eventBonus(currentEvent()).bossHp || 1;
  res.json({
    bosses: hpMult === 1 ? BOSSES : BOSSES.map(b => ({ ...b, hp: Math.round(b.hp * hpMult), weakened: true })),
    // Admins have everything unlocked, boss rush included.
    bossMax: req.user && req.user.role === 'admin' ? BOSSES.length
      : req.user ? (req.user.stats.bossMax || 0) : 0,
  });
});

// ---------------------------------------------------------------------------
// Gem purchases (DEMO payment — no real money is charged) — routes/shop.js
// ---------------------------------------------------------------------------
app.use(purchaseRouter);

// ---------------------------------------------------------------------------
// Shop（🏷 日替わりセール・🎁 本日のギフト・🎒 ブースター・🎰 ガチャ）
// ---------------------------------------------------------------------------
app.use(shopRouter);

// 世界の到達段を運営が動かす口（👑管理者イベント専用ショップの棚が開く条件）
// — routes/adminevent.js
app.use(throneAdminRouter);

// ---------------------------------------------------------------------------
// 🤝 フレンド / 🏁 ライバル表 / 🎉 パーティー — routes/social.js
// ---------------------------------------------------------------------------
app.use(socialRouter);

// 👑 王座の欠片ショップと装備の着せ替え — routes/shop.js
app.use(throneShopRouter);

// ---------------------------------------------------------------------------
// Missions (daily / weekly) / Achievements / Battle pass — routes/missions.js
// ---------------------------------------------------------------------------
app.use(missionsRouter);

// ---------------------------------------------------------------------------
// Admin API / Moderator API / にぎわい調整 — routes/admin.js
// ---------------------------------------------------------------------------
app.use(adminRouter);

// 永続化の健康診断。db.js がゲッターを出していればそれを使い、
// サイズだけは出ていなくても自前で stat して必ず見えるようにする
// （「db.json が肥大していないか」は管理者がいちばん先に知りたい値なので）。
function persistMetrics() {
  const out = { dbBytes: null, saveMs: null };
  const call = (names) => {
    for (const n of names) {
      const f = dbModule[n];
      if (typeof f !== 'function') continue;
      try {
        const v = Number(f());
        if (Number.isFinite(v)) return v;
      } catch { /* ゲッターが投げても管理画面は落とさない */ }
    }
    return null;
  };
  try {
    // db.js が {bytes, ms} のような1つの口でまとめて出す場合。
    for (const n of ['persistStats', 'dbStats', 'saveStats']) {
      if (typeof dbModule[n] !== 'function') continue;
      try {
        const o = dbModule[n]() || {};
        const b = Number(o.bytes ?? o.size ?? o.dbBytes);
        const m = Number(o.ms ?? o.saveMs ?? o.lastSaveMs);
        if (Number.isFinite(b)) out.dbBytes = b;
        if (Number.isFinite(m)) out.saveMs = m;
      } catch { /* 同上 */ }
      break;
    }
    if (out.dbBytes == null) out.dbBytes = call(['lastDbBytes', 'dbFileSize', 'dbSizeBytes', 'dbBytes', 'lastDbSize']);
    if (out.saveMs == null) out.saveMs = call(['lastSaveMs', 'lastSaveDuration', 'lastSaveDurationMs', 'lastWriteMs', 'lastPersistMs', 'saveDurationMs']);
    // ゲッターがまだ無いときの保険。DATA_DIR/db.json は db.js と同じ場所。
    if (out.dbBytes == null) {
      try { out.dbBytes = fs.statSync(path.join(DATA_DIR, 'db.json')).size; }
      catch { /* まだ1度も書かれていない */ }
    }
  } catch { /* ここで落ちても統計以外は返す */ }
  return out;
}

// ---------------------------------------------------------------------------
// 📈 イベントループ遅延とメモリの計測（計器だけ。自動退避はしない）
//
// Node は1本の処理列で動くので、「重い処理が何ms列を止めたか」がそのまま
// 全員の体感になる。db.json の同期保存（fsync まで待つ）やランキングの
// 全走査は、育つほど確実にここへ出る。RSS は無料枠の上限（512MB）に対する
// 余裕を見るため。
//
// 閾値を越えても、ここでは負荷退避（住人を減らす・対戦を絞る等）はしない。
// 挙動を勝手に変えるほうが事故として大きいので、まず console と管理ログに
// 残すだけにして、実際に何が起きているかを見てから決める。
// ---------------------------------------------------------------------------
// 注意: monitorEventLoopDelay の値には、OS のタイマー粒度ぶんの下駄が必ず乗る
// （Windows の既定は約15.6ms なので、無風でも p50 が 30ms 前後に出る）。
// 見るべきは絶対値ではなく「普段との差」。閾値はその下駄よりずっと上に置く。
const PERF_SAMPLE_MS = 30_000;
const PERF_LAG_WARN_MS = 200;     // p99 がこれを越えたら記録
const PERF_RSS_WARN_MB = 420;     // Render starter(512MB) に対する余裕
const PERF_WARN_COOLDOWN_MS = 10 * 60 * 1000;

let perfHist = null;
try {
  perfHist = monitorEventLoopDelay({ resolution: 20 });
  perfHist.enable();
} catch (err) {
  console.warn('[perf] イベントループ計測を開始できませんでした:', err && err.message);
  perfHist = null;
}

let perfSample = { at: 0, windowSec: PERF_SAMPLE_MS / 1000, lagP50: null, lagP99: null, lagMax: null, rss: null, heapUsed: null, heapTotal: null, external: null };
let perfLastWarnAt = 0;

// adminLog は req を要る（誰がやったか）ので、サーバー自身の記録は
// battle.js に渡しているのと同じ軽い形で積む。
function systemLog(action, detail) {
  try {
    db.meta.adminLog = db.meta.adminLog || [];
    db.meta.adminLog.push({ at: Date.now(), by: '(サーバー)', action, detail: detail || null });
    if (db.meta.adminLog.length > ADMIN_LOG_MAX) {
      db.meta.adminLog.splice(0, db.meta.adminLog.length - ADMIN_LOG_MAX);
    }
    saveDb();
  } catch { /* 記録できなくても計測は続ける */ }
}

setInterval(() => {
  const mem = process.memoryUsage();
  const ms = v => Math.round(v / 1e5) / 10;   // ns -> ms（小数第1位）
  const next = {
    at: Date.now(),
    windowSec: PERF_SAMPLE_MS / 1000,
    lagP50: perfHist ? ms(perfHist.percentile(50)) : null,
    lagP99: perfHist ? ms(perfHist.percentile(99)) : null,
    lagMax: perfHist ? ms(perfHist.max) : null,
    rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external,
  };
  if (perfHist) perfHist.reset();
  perfSample = next;
  const rssMb = Math.round(next.rss / 1048576);
  const lagBad = next.lagP99 != null && next.lagP99 > PERF_LAG_WARN_MS;
  const memBad = rssMb > PERF_RSS_WARN_MB;
  if ((lagBad || memBad) && Date.now() - perfLastWarnAt > PERF_WARN_COOLDOWN_MS) {
    perfLastWarnAt = Date.now();
    const line = `[perf] 遅延 p50=${next.lagP50}ms p99=${next.lagP99}ms max=${next.lagMax}ms / RSS=${rssMb}MB / 接続${battleReady ? battle.clients.size : 0}`;
    console.log(line);
    systemLog('perf-warn', line);
  }
}, PERF_SAMPLE_MS).unref?.();

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users);
  const persist = persistMetrics();
  res.json({
    totalUsers: users.length,
    bannedUsers: users.filter(u => u.banned).length,
    totalGames: users.reduce((a, u) => a + u.stats.gamesPlayed, 0),
    online: battle.clients.size,
    displayOnline: battle.displayOnline(),
    inQueue: battle.queueSize(),
    activeMatches: battle.matches.size,
    openRooms: battle.rooms.size,
    // 🔌 接続上限と、そこで断った回数。rejectedPerIp が増えているのに人数が
    // 少ないときは、IPの見え方（前段プロキシ・trust proxy 設定）を疑うこと。
    conn: battle.connStats ? battle.connStats() : null,
    // 👥 いま本当につないでいる人の一覧（住人・ボットを除いた実クライアント）。
    // displayOnline は住人を足した表示用の数なので、実態はこちらを見る。
    livePlayers: battle.livePlayers ? battle.livePlayers() : [],
    popScale: getLiveScale(),
    ambient: getCustom(),
    crowd: {
      mood: crowdMood(), activeResidents: battle.crowd.activeCount(),
      queueing: ambientQueue(), feedCount: battle.crowd.feedHistory().length, quietNow: isQuietNow(),
    },
    guilds: Object.keys(db.guilds).length,
    news: db.news.length,
    translate: TRANSLATE_ENGINE,
    maintenance: inMaintenance(),
    season: currentSeason(),
    sessionsPersist: SESSIONS_PERSIST,
    // 💾 永続化の状態。dbBytes は db.json の大きさ、saveMs は直近保存の所要ms
    // （db.js に計測の口が無ければ null）。txLive/txArchived は取引ログの
    // ローテーション具合。
    dbBytes: persist.dbBytes,
    saveMs: persist.saveMs,
    // 💾 復元の天井（バイト）と、db.json がそれを越えていないか。越えていると
    // 「自分で取ったバックアップを自分で戻せない」大きさに育っている（書き出し側
    // は塊を落として収めるが、事前に気づけるよう管理画面へフラグを出す）。
    restoreLimitBytes: RESTORE_MAX_BYTES,
    dbOverRestoreLimit: persist.dbBytes != null && persist.dbBytes > RESTORE_MAX_BYTES,
    persistError: lastPersistError(),
    txLive: Array.isArray(db.transactions) ? db.transactions.length : 0,
    txArchived: Number(db.meta.revenueCount) || 0,
    // 📈 直近30秒のイベントループ遅延（ms）とメモリ。閾値超過は console と
    // 管理ログにも残している（自動退避はしていない）。
    perf: {
      ...perfSample,
      uptimeSec: Math.round(process.uptime()),
      lagWarnMs: PERF_LAG_WARN_MS,
      rssWarnMb: PERF_RSS_WARN_MB,
    },
    // 🐛 プレイヤーからの報告箱（バグ報告・工房通報・パーティー通報が全部ここに
    // 落ちる）。届いたことを知らせる仕組みが1つも無く、未処理件数を知れるのは
    // 「管理者パネルを開いてモーダルを押したあとの見出し」だけだった。しかも
    // cap に達すると、処理済みが1件も無ければ新規報告を 503 で断る ──
    // 「運営が数日開かない → 箱が埋まる → 以後の通報が全部拒否される」が、
    // どこにも出ないまま起きる。clientErrors と同じ形で件数を出しておけば、
    // 管理画面のカードにもボタンのバッジにも出せる。
    // full は「あと1件も入らない」（＝新規報告が断られる）状態。
    bugreports: (() => {
      const rows = Array.isArray(db.bugreports) ? db.bugreports : [];
      const open = rows.filter(b => b && b.status !== 'done').length;
      return { open, total: rows.length, cap: BUGREPORT_CAP, full: rows.length >= BUGREPORT_CAP && open === rows.length };
    })(),
    // 💥 クライアント側のJSエラー（未処理の件数だけ。中身は /api/admin/clienterrors）
    clientErrors: {
      rows: Array.isArray(db.meta.clientErrors) ? db.meta.clientErrors.length : 0,
      open: (Array.isArray(db.meta.clientErrors) ? db.meta.clientErrors : []).filter(e => e && e.status !== 'done').length,
    },
    // 🏛 殿堂に記録済みのシーズン数
    hallOfFame: Array.isArray(db.meta.hallOfFame) ? db.meta.hallOfFame.length : 0,
    assetHash: ASSET_HASH_ENABLED ? assetVer.size : 0,
  });
});

// ---------------------------------------------------------------------------
// WebSocket battles: matchmaking (1v1 / 2v2), custom rooms, server bots
// ---------------------------------------------------------------------------

const MATCH_DURATION = Number(process.env.MATCH_SECONDS) || 120;  // seconds

const server = http.createServer(app);
const battle = initBattle(server, {
  db, saveDb, applyGameResult, publicUser, levelOf, sanitizeName, userFromToken,
  MATCH_DURATION,
  // 予約名（運営/管理者ゼロ 等）判定。ゲストがWSでこれらを名乗れないように
  // battle.js の hello から使う。クロージャなので RESERVED_NAMES 定義後
  // （＝実際に呼ばれる hello 受信時）に評価される。
  reservedName: (n) => {
    const s = String(n == null ? '' : n).trim().toLowerCase();
    return !!s && RESERVED_NAMES.some(r => r.toLowerCase() === s);
  },
  isMaintenance: inMaintenance,
  // WSの接続元IP。HTTP側の req.ip と同じ規則で解く（上の clientIpOf のコメント参照）。
  clientIp: clientIpOf,
  guildTagOf: (name, user) => tagOfName(db, name, user),
  // AI-vote guild solidarity: ghost-guild tag only (never scans db.users).
  residentGuildTag: (name) => { const g = ghostGuildOfResident(name); return g ? g.tag : null; },
  // パーティーチャットはアカウント単位でも制限する。socket ごとだけだと、
  // 1アカウント6接続ぶんまで発言できてしまう。
  rateLimit,
  adminLog: (action, byName) => {
    db.meta.adminLog = db.meta.adminLog || [];
    db.meta.adminLog.push({ at: Date.now(), by: byName || '運営', action });
    if (db.meta.adminLog.length > 500) db.meta.adminLog.shift();
    saveDb();
  },

});

battleReady = true;

// The crowd reads the live event / open poll through this (no import cycle).
setWorldProvider(() => ({
  event: currentEvent(),
  poll: db.meta.poll && pollOpen(db.meta.poll) ? db.meta.poll : null,
  // 👑 住人が保持している王座名だけ — 王者住人はチャットに常駐し王者らしい発言を
  // する。実プレイヤーの王座名を混ぜると、たまたま同名の住人が常駐して「王座は
  // 渡さない」と一人称で自慢し、実在プレイヤーになりすます形になっていた。
  thrones: Object.values(db.meta.thrones || {}).filter(t => t && t.resident).map(t => t.username),
}));

// 住人ボット/ロビー発言のなりすまし対策: pickPersona のフォールバックが実在
// プレイヤー名(db.users)を避けられるよう、現在の登録名の集合を供給する。
// スナップショットではなく関数を渡し、毎回評価させる(新規登録・改名を追従)。
setTakenNamesProvider(() => new Set(Object.values(db.users).map(u => (u.username || '').toLowerCase())));

// ---------------------------------------------------------------------------
// Bootstrap: seed admin account, start server
// ---------------------------------------------------------------------------

const ADMIN_NAME = 'るみまき';
// 誰にも取らせない名前。ゼロはイベント中に名指しで宣告するので、
// 騙られると偽の宣告が撒ける。改名(/api/me/rename)でも同じ検査をする。
const RESERVED_NAMES = ['管理者ゼロ', 'ゼロ', 'ZERO', '管理者', '運営', '大会運営', 'admin'];

// With ADMIN_PASSWORD set (e.g. on Render), the admin password is pinned to it
// on every boot — it survives redeploys and data resets.
function pinAdminPassword() {
  const pinned = process.env.ADMIN_PASSWORD;
  if (!pinned || pinned.length < 8) {
    // 短いと黙って無視していたので、「変えたのにログインできない」の原因が
    // ログを読まない限り分からなかった。何文字だったかまで出す（値は出さない）。
    if (pinned) {
      console.warn('┌──────────────────────────────────────────────────────────────');
      console.warn(`│ [admin] ADMIN_PASSWORD が短すぎます（${pinned.length}文字／8文字以上が必要）`);
      console.warn('│ 無視したので、管理者パスワードは 変わっていません。');
      console.warn('│ 8文字以上にして再デプロイしてください。');
      console.warn('└──────────────────────────────────────────────────────────────');
    } else {
      console.warn('[admin] ADMIN_PASSWORD 未設定 — 管理者パスワードは固定されません');
    }
    return;
  }
  // 管理者が複数いると「db.users で最初に見つかった管理者」に当たってしまい、
  // 起動のたびに対象が変わりうる（復元やマージで並び順は変わる）。
  // ADMIN_PASSWORD が固定したいのは本来の運営アカウント一つだけ。
  const admins = Object.values(db.users).filter(u => u.role === 'admin');
  const admin = admins.find(u => u.username === ADMIN_NAME) || admins[0];
  if (!admin) return;
  // 実際に変わったときだけ書き換える。毎起動で無条件に差し替えると、下の
  // revokeAllTokens が毎回走って正規のログインまで切れてしまう。
  const changed = !verifyPassword(pinned, admin.salt, admin.passHash);
  if (!changed) return;
  const { salt, hash } = hashPassword(pinned);
  admin.salt = salt;
  admin.passHash = hash;
  // パスワードを変えたら、古いパスワードで出したトークンは殺す。
  //
  // ここが抜けていた。SESSION_SECRET は再デプロイをまたいで維持する設計なので、
  // 発行済みの Bearer トークンは1年生き続ける。つまり「乗っ取られたので
  // ADMIN_PASSWORD を変えて再デプロイする」という唯一の対処を実行しても、
  // 攻撃者のセッションだけは無傷で残っていた。同じことをする
  // /api/admin/users/:id の setPassword は revokeAllTokens を呼んでいる。
  revokeAllTokens(admin.id);
  saveDb();
  console.log(`[admin] 管理者パスワードを環境変数 ADMIN_PASSWORD に固定しました（対象: ${admin.username} / 発行済みトークンは失効）`);
}

// 管理者は「表示だけ全部持っている」状態だった: publicUser が owned を丸ごと
// 差し替え、バトルパスをプレミアム扱いで返すだけで、レコードの中身は空。
// そのためインベントリのように user.owned / badges / achievements を素直に
// 読む画面では何も出ない（見えているものが実在しない）。
// ここで実データとして全部持たせる。ランキングは元から管理者を除外している
// ので、統計を最大にしても順位表は汚れない。
function unlockEverythingForStaff() {
  const admins = Object.values(db.users).filter(u => u.role === 'admin');
  for (const u of admins) {
    migrateUser(u);
    const before = (u.owned || []).length + (u.badges || []).length;
    // ショップ・ガチャ限定・管理者専用まで全部
    u.owned = [...new Set([...(u.owned || []), ...SHOP_ITEMS.map(i => i.id)])];
    u.badges = [...new Set([...(u.badges || []), ...ADMIN_KNOWN_BADGES])];
    // 全実績を解除済みに（受け取り済みリストなので、進捗は統計側で満たす）
    u.achievements = [...new Set([...(u.achievements || []), ...ACHIEVEMENTS.map(a => a.id)])];
    // ブースターは無限のかわりに大量に持たせる（0だと使えない画面がある）
    u.items = u.items || {};
    for (const it of BOOST_ITEMS) u.items[it.id] = Math.max(u.items[it.id] || 0, 999);
    // 称号・実績・モード解放はすべて統計から導出されるので、そこを満たす。
    const s = u.stats;
    const atLeast = (k, v) => { if ((s[k] || 0) < v) s[k] = v; };
    atLeast('gamesPlayed', 500); atLeast('bestScore', 300000); atLeast('totalScore', 5000000);
    atLeast('totalLines', 20000); atLeast('maxCombo', 20); atLeast('rating', 1700);
    atLeast('pvpWins', 100); atLeast('winStreakBest', 10);
    atLeast('bossMax', BOSSES.length); atLeast('dungeonMax', 100); atLeast('abyssMax', 100);
    atLeast('survivalWave', 30); atLeast('puzzleStage', 60); atLeast('digDepth', 60);
    atLeast('loginStreakBest', 30); atLeast('sprintPlays', 50); atLeast('coopPlays', 20);
    atLeast('ultsUsed', 600); atLeast('itemsUsed', 600); atLeast('piecesPlaced', 30000);
    atLeast('gachaPulls', 100); atLeast('gachaSSR', 20); atLeast('ghostBest', 20000);
    atLeast('royalePlays', 50); atLeast('royaleTop10', 10); atLeast('royaleKills', 50);
    atLeast('royaleBestKills', 5); atLeast('aePlays', 20);
    // 残り9称号ぶんの条件（連勝・奥義500・ミッション300・協力2万点・
    // ギルド週2000pt・全ボスSランク・無限地獄深度12・チャット300回）
    atLeast('winStreak', 10); atLeast('missionsDone', 300); atLeast('coopBest', 30000);
    atLeast('guildBestWeek', 3000); atLeast('rushDepth', 20); atLeast('chatMessages', 300);
    if (!s.royaleBest || s.royaleBest > 1) s.royaleBest = 1;
    s.bossRanks = s.bossRanks || {};
    for (const b of BOSSES) s.bossRanks[b.id] = 'S';
    s.sprint = s.sprint || {};
    s.sprint.s60 = Math.max(s.sprint.s60 || 0, 20000);
    s.sprint.s180 = Math.max(s.sprint.s180 || 0, 60000);
    // バトルパスも実データとしてプレミアム＋最大XPに
    u.battlePass = u.battlePass || {};
    u.battlePass.premium = true;
    u.battlePass.xp = Math.max(u.battlePass.xp || 0, BP_TIERS.length * BP_XP_PER_TIER);
    const after = u.owned.length + u.badges.length;
    if (after !== before) {
      console.log(`[admin] ${u.username}: 所持品${u.owned.length}種・バッジ${u.badges.length}種・実績${u.achievements.length}件を解放`);
    }
  }
  if (admins.length) saveDb();
}

function seedAdmin() {
  // One-time migration: rename a legacy "admin" account to the new name.
  const legacy = Object.values(db.users).find(u => u.role === 'admin' && u.username === 'admin');
  if (legacy && !Object.values(db.users).some(u => u.username === ADMIN_NAME)) {
    legacy.username = ADMIN_NAME;
    saveDb();
    const credFile = path.join(DATA_DIR, 'admin-credentials.txt');
    try {
      const old = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
      fs.writeFileSync(credFile, old.replace(/username: .*/, `username: ${ADMIN_NAME}`));
    } catch { /* ignore */ }
    console.log(`[admin] 管理者アカウント名を「${ADMIN_NAME}」に変更しました（パスワードは変更なし）`);
  }
  const hasAdmin = Object.values(db.users).some(u => u.role === 'admin');
  if (hasAdmin) return;
  const password = crypto.randomBytes(9).toString('base64url');
  newUser(ADMIN_NAME, password, 'admin');
  const credFile = path.join(DATA_DIR, 'admin-credentials.txt');
  fs.writeFileSync(credFile, `username: ${ADMIN_NAME}\npassword: ${password}\n`);
  // パスワードそのものは標準出力に出さない。ホスティング事業者のログ基盤に
  // 流れて保持され、あとから回収も回転もできないため（ファイル側は
  // .gitignore で覆われた server/data/ 配下なので追跡はされない）。
  console.log('='.repeat(60));
  console.log('  管理者アカウントを作成しました');
  console.log(`  ユーザー名: ${ADMIN_NAME}`);
  console.log(`  パスワードは ${credFile} に保存しました（この画面には出しません）`);
  console.log('='.repeat(60));
}

// Seed backup — automatic self-heal on boot. The repo carries a recent
// production backup at server/seed-backup.json (refresh it with
// `npm run backup:pull` before pushing); a fresh post-deploy instance merges
// it in with no manual /?restore=1 step.
//
// SAFETY: a given seed file is applied AT MOST ONCE (its hash is remembered in
// db.meta.seedHash). Without that gate, a host whose disk survives restarts
// would re-merge the stale seed on every boot — refunding spent currency,
// reverting bans/password changes and resurrecting deleted accounts each time
// the process bounced. Re-pulling a fresh seed (new hash) applies again.
const SEED_BACKUP_FILE = process.env.SEED_BACKUP_FILE || path.join(__dirname, 'seed-backup.json');
function autoRestoreFromSeed() {
  if (process.env.SEED_RESTORE === '0') return;
  let data, seedHash;
  try {
    if (!fs.existsSync(SEED_BACKUP_FILE)) return;
    const rawBytes = fs.readFileSync(SEED_BACKUP_FILE);
    seedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    if (db.meta.seedHash === seedHash) return;   // this exact seed is already in
    data = JSON.parse(rawBytes.toString('utf8'));
  } catch (err) {
    console.warn('[seed] seed-backup.json を読み込めませんでした:', err.message);
    return;
  }
  // The repo is public, so the committed seed is encrypted (scripts/pull-backup.mjs).
  //
  // 鍵はこれまで「ログイン用の管理者パスワード」そのものだった。中身は db 丸ごと
  // ＝全ユーザーの salt / passHash が入った完全ダンプで、しかも公開リポジトリに
  // 毎日コミットされる ── つまり ADMIN_PASSWORD（下限8文字）1つの強度が、
  // オフラインで何度でも試せる相手に対する全プレイヤーの資格情報の防壁に
  // なっていた。バックアップ専用の合言葉 BACKUP_PASSPHRASE（十分に長い
  // ランダム値）を優先して読む。設定されていなければ従来どおり
  // ADMIN_PASSWORD に落ちる（既にコミット済みのファイルが開けなくならない）。
  if (data && data.enc === 'aes-256-gcm') {
    const pw = process.env.BACKUP_PASSPHRASE || process.env.ADMIN_PASSWORD;
    if (!pw) {
      console.warn('[seed] seed-backup.json は暗号化されていますが BACKUP_PASSPHRASE / ADMIN_PASSWORD 環境変数が未設定のため復元できません');
      return;
    }
    if (!process.env.BACKUP_PASSPHRASE && pw.length < 24) {
      console.warn('[seed] バックアップの鍵に ADMIN_PASSWORD を使っています。'
        + `（${pw.length}文字）このファイルは全ユーザーの資格情報を含み、公開リポジトリに置かれます。`
        + ' 専用の BACKUP_PASSPHRASE（32文字以上のランダム値）を設定してください');
    }
    try {
      const salt = Buffer.from(data.salt, 'base64');
      const iv = Buffer.from(data.iv, 'base64');
      const key = crypto.scryptSync(pw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
      console.warn('[seed] seed-backup.json の復号に失敗しました（BACKUP_PASSPHRASE / ADMIN_PASSWORD がバックアップ取得時と一致していません）');
      return;
    }
  }
  const check = validateBackup(data);
  if (!check.ok) { console.warn('[seed] seed-backup.json が不正です:', check.error); return; }
  // 他の復元経路と同じく丸ごと退避してから実行する。ここは起動時に走るので、
  // 半端にマージされた db のまま立ち上がると、そのまま全プレイヤーに配られる。
  // 失敗したら「seed を当てなかった」状態へ戻すのが正しい（seedHash も立てない
  // ので、seed を直せば次の起動でやり直せる）。
  const rollback = structuredClone(db);
  try {
    // The instance's OWN stored legacy season must be adopted before the merge
    // can overwrite user records — and definitely before db.season is nulled.
    const adoptedLocal = adoptLegacySeason(db.season);
    const report = applyRestore(db, data, 'merge');
    for (const u of Object.values(db.users)) migrateUser(u);
  // 🤝 復元のあとは必ず均す。名前で照合したときに id が入れ替わるので、
  // 付け替えの取りこぼし・片側だけになった関係・消えた相手への申請が残る。
  // 起動時に一度やるだけでは、復元で作った歪みはその起動の間ずっと残る。
  healSocial(db);
    const adopted = adoptedLocal + adoptLegacySeason(data.season);
    db.season = null;   // stored seasons are legacy — everything derives from SEASON_EPOCH now
    db.meta.seedHash = seedHash;
    setLiveScale(db.meta.popScale ?? 1);
    setCustom(db.meta.ambient);
    // Synchronous write, not the debounced saveDb: if the process dies before
    // a debounced write lands (SIGTERM flush doesn't run on every platform),
    // the seedHash is lost and the next boot re-applies the whole seed.
    flushDb();
    console.log(`[seed] 同梱バックアップを自動復元: 追加${report.added} 更新${report.updated} 維持${report.kept} → 合計${report.after}人${adopted ? `（バトルパス引き継ぎ${adopted}件）` : ''}`);
  } catch (err) {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, rollback);        // db.js が同じ参照を握っているので in-place で戻す
    console.error('[seed] 自動復元に失敗（seed を当てる前の状態に戻しました）:', err.message);
  }
}

autoRestoreFromSeed();
const seasonAdopted = adoptLegacySeason(db.season);
if (db.season) { db.season = null; saveDb(); }
if (seasonAdopted) console.log(`[season] 旧シーズンIDからバトルパスを引き継ぎました（${seasonAdopted}件）`);
currentSeason();
seedAdmin();
pinAdminPassword();
// 🧹 すでに記録に残っている操作者のIPアドレスを一度だけ落とす（adminLog は
// もう残さない。理由はそちらのコメント参照）。ダンプは公開リポジトリに
// コミットされるので、過去ぶんを抱えたままにしない。
{
  let wiped = 0;
  for (const e of (Array.isArray(db.meta.adminLog) ? db.meta.adminLog : [])) {
    if (e && e.ip !== undefined) { delete e.ip; wiped++; }
  }
  if (wiped) { saveDb(); console.log(`[admin] 操作ログ${wiped}件からIPアドレスを削除しました`); }
}
unlockEverythingForStaff();
seedNews();
finalizeWeeklyRankings();   // pay out any week that ended while we were down
settleSeasonHallOfFame();   // 🏛 寝ているあいだに終わったシーズンを殿堂へ
// 👑 Thrones exist from second zero (silent first computation), and the seeded
// chat history — built before the restore above — gets its crowns stamped.
refreshThrones();
battle.crowd.restampCrowns();
console.log(`[chat] 自動翻訳エンジン: ${TRANSLATE_ENGINE === 'api' ? '外部API (TRANSLATE_URL)' : '内蔵フレーズ辞書'}`);

// 🏰 ギルド名簿の幽霊掃除。復元/マージ経路（backup.js）と同じ関数をここでも
// 1回通す ── すでに幽霊を抱えている本番の db は、復元が走らない限り自動では
// 直らないため（満員判定は名簿の生の length を見るので、幽霊が枠を占めたまま
// 「20/20 なのに誰も居ない」が続く）。
{
  const gf = healGuildRosters(db);
  if (gf.ghosts || gf.disbanded || gf.owners || gf.pointers) {
    console.log(`[guild] 名簿を整理: 幽霊${gf.ghosts} 解散${gf.disbanded} 代替わり${gf.owners} 所属${gf.pointers}`);
    saveDb();
  }
}

// A boot snapshot means a bad restore is always one click away from undo.
if (Object.keys(db.users).length > 0) snapshot(db, 'boot');

// 自動のスナップショットは起動時のこの1回だけで、定期実行が無かった。
// 永続ディスクのプランでプロセスが数週間上がりっぱなしになると、最新の
// 復旧点は数週間前のものになる（その間に db.json が壊れたら、そのぶん丸ごと
// 失う）。1時間ごとに1枚撮っておけば、失うのは最大1時間ぶんで済む。
// 保持は backup.js の prune がラベルごとの枠で面倒を見る（hourly は6枚まで
// なので、退避(pre-*/manual)を押し出さない）。
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  try {
    if (Object.keys(db.users).length > 0) snapshot(db, 'hourly');
  } catch (err) { console.error('[backup] 定期スナップショットに失敗:', err && err.message); }
}, SNAPSHOT_INTERVAL_MS).unref?.();

// ---------------------------------------------------------------------------
// 🚚 切り出したルーターへ共有依存を渡す
//
// ルーター自体は上のほうで（元のルート定義があった位置で）すでに app.use 済み
// なので、ルートの照合順序は分割前と完全に同じ。ここでやるのは「index.js の
// モジュールスコープにしか無い値」を routes/ 側の束縛に流し込むことだけ。
//
// ⚠ ここを server.listen より前から動かさないこと。battle は下のほうで作られる
//    ので、これより早く呼ぶと routes/ が undefined を掴む。逆に listen より後に
//    すると、最初のリクエストが依存の入っていないハンドラに当たりうる。
// ---------------------------------------------------------------------------
setContext({
  // 土台
  db, battle, battleReady,
  // ユーザーの読み書き
  migrateUser, publicUser, userById, levelOf, sanitizeName, fmtNum,
  // 門番と関所
  // maintenanceResultGuard は「もう終わった1回の着地点」専用の猶予つき関所。
  // routes/adminevent.js の /api/adminevent/result も同じ性格なので、あちらも
  // maintenanceGuard からこれに差し替えてよい。
  rateLimit, maintenanceGuard, maintenanceResultGuard, requireMod,
  // 期間もの（イベント・シーズン・週・日）
  currentEvent, currentSeason, SEASON_MS, derivedSeasonIndex, adoptLegacySeason,
  syncBattlePass, settleSeasonHallOfFame, SEASON_BADGE_RE,
  WEEK_MS, WEEKLY_PIECES, currentWeekNum, weekIdOf, weeklySeed, curWeek,
  finalizeWeeklyRankings, refreshThrones,
  // 結果送信の共通処理
  applyGameResult, pickResultFields, seedLastResultAt, GEMDROP_DAILY_CAP, sanitizeReplay,
  // 知らせるもの・残すもの
  postRealFeed, adminLog, ADMIN_LOG_MAX, BUGREPORT_CAP,
  // 運営まわりの語彙
  RESERVED_NAMES, ADMIN_KNOWN_BADGES,
  // 💾 復元の天井（MB）。routes/admin.js のバックアップ書き出しが同じ天井を
  // 共有するために読む（載っていなければ向こうの既定値4にフォールバック）。
  RESTORE_LIMIT_MB,
});
initShopRoutes();
initMissionRoutes();
initGuildRoutes();
initSocialRoutes();
initAdminEventRoutes();
initDailyRoutes();
initWorkshopRoutes();
initAdminRoutes();

// Unknown paths (shared links, typos) land on the game instead of an error.
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    // 変換済みの index.html があるならそちらを返す。ここだけ素の HTML を配ると
    // 共有リンク経由（/xxxx）で開いた人にだけ `?v` の付かない main.js が渡り、
    // トップから開いた人と別のURLを掴むことになる。
    if (assetIndexHtml) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(assetIndexHtml);
    }
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  res.status(404).json({ error: 'Not found' });
});

// 最後の受け皿。ここが無いと、ルートの中で投げた例外は Express 既定の
// エラーページに落ちる ── 本番でも HTML でスタックトレースを丸出しにし、
// サーバー上の絶対パス（C:\Users\… や /opt/render/…）まで誰にでも見せていた。
// 実際 mode にオブジェクトを渡すだけで String() が投げて、この画面が出た。
//
// 4引数であることが Express にとってのエラーハンドラの目印。引数を減らすと
// ただのミドルウェアとして扱われ、静かに無効になるので触らないこと。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'サーバー内部でエラーが発生しました' });
});

// Render free tier spins down after ~15min idle (50s cold start + the
// in-memory data dies with the instance). Pinging our own public URL
// keeps the instance warm. RENDER_EXTERNAL_URL is set by Render.
const KEEPALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
if (KEEPALIVE_URL) {
  setInterval(() => {
    fetch(`${KEEPALIVE_URL}/api/status`).catch(() => { /* transient — retry next tick */ });
  }, 10 * 60 * 1000);
  console.log(`[keepalive] ${KEEPALIVE_URL} を10分ごとにpingしてスリープを防止します`);
}

server.listen(PORT, () => {
  console.log(`Block Blitz Arena server: http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// 永続ディスクを付けた副作用で、Render は新旧インスタンスを同時に動かせない
// （ディスクは1つにしかマウントできない）ため、更新のたびに必ず停止時間が出る。
// 以前はプロセスがそのまま消えて、対戦中の人は原因不明の切断、ソロプレイ中の
// 人は結果送信が失敗して1回ぶんの記録が黙って消えていた。
//
// 停止する前に:
//   ・オンライン対戦は「引き分け」で正式に終わらせる（記録も報酬も残る）
//   ・ソロなどの人には「保存して終了して」と伝え、送信を待ってから落ちる
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — 対戦を引き分けで終了し、プレイ中の人に保存を促します`);
  let ended = 0;
  try {
    ended = battle.endAllForShutdown();
  } catch (err) {
    console.error('[shutdown] 対戦の終了に失敗:', err && err.message);
  }
  // 待つ理由があるのは「誰か繋がっているとき」だけ。無人なら即終了する
  // （テストや手元の再起動を5秒ずつ遅くしても意味がない）。
  const waiting = battle.clients.size > 0;
  const graceMs = waiting ? 5000 : 0;
  console.log(`[shutdown] ${ended}件の対戦を終了。${waiting ? '5秒待ってから' : 'すぐに'}停止します`);
  setTimeout(() => {
    flushDb();
    console.log('[shutdown] 保存完了。終了します');
    process.exit(0);
  }, graceMs).unref?.();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
