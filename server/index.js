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
} from './auth.js';
import {
  SHOP_ITEMS, DEFAULT_OWNED, DEFAULT_EQUIPPED, BOOST_ITEMS, EQUIP_SLOTS,
  BP_TIERS, BP_XP_PER_TIER, BP_PREMIUM_PRICE_GEMS, BP_SEASON_DAYS,
  BOSSES, TITLES, earnedTitles, GEM_PACKS, THRONE_ITEMS,
  COLLECTION_SETS, collectionView, claimCollection,
} from './catalog.js';
import {
  syncMissions, trackMissions, missionsView, claimMission, claimMissionBonus,
} from './missions.js';
// 🎲 ミッションのリロールは missions.js 側が `rerollMission` を生やしたときだけ
// 動く。名前付き import にすると「まだ生えていない」時点で ES モジュールの
// リンクが失敗し、サーバーごと起動しなくなる（db.js の実測値ゲッターと同じ話）。
// 名前空間で受けて、実行時に有無を見る。
import * as missionsModule from './missions.js';
import { achievementsView, claimAchievement, ACHIEVEMENTS } from './achievements.js';
import {
  ghostRows, setLiveScale, getLiveScale, setCustom, getCustom, setWorldProvider, setTakenNamesProvider,
  rosterView, retiredResidents, crowdMood, ambientQueue, isQuietNow, DEFAULT_TOGGLES, ARCHETYPES,
  MAX_LIVE_SCALE, residentByName, clashingResidentIds, activeResidents, residentStats, archetype,
  boardResidents,
} from './ambient.js';
import { BADGE_NAMES } from './crowd.js';
import { enName } from '../public/js/catalog-en.js';   // 実況フィードの英語名（クライアントと同じ表）
import {
  GUILD_CREATE_COST, GUILD_ICONS, createGuild, findGuild, joinGuild, leaveGuild, kickMember,
  addGuildPoints, guildView, guildLevel, guildCoinBonus, ghostGuildViews, tagOfName, validateGuildInput,
  ghostGuildOfResident, trackGuildQuests, claimGuildQuest,
} from './guilds.js';
import { TRANSLATE_ENGINE, translateChat } from './translate.js';
import {
  validateBackup, applyRestore, snapshot, listSnapshots, readSnapshot, BACKUP_VERSION,
} from './backup.js';
import {
  EVENT_TYPES, makeEvent, eventBonus,
  scheduledEventFor, nextScheduledEvent, makeScheduledEvent, calendarView,
} from './events.js';
import {
  ensureSocial, healSocial, unfriendAll, friendsView, friendRow,
  sendRequest, acceptRequest, declineRequest, cancelRequest, unfriend,
  block as blockUser, unblock as unblockUser, socialDefaults,
  rivalBoard, sendChallenge, friendsOvertaken, CHALLENGE_COOLDOWN_MS,
} from './friends.js';
import {
  createPoll, eventPollOptions, vote as castVote, pollView, tickPoll, winnerOf, isOpen as pollOpen,
} from './polls.js';
import {
  AE_MODES, WEEKDAYS_JA as AE_WEEKDAYS_JA, jstDayKey,
  aeMode as aeModeById, getSchedule as getAeSchedule, normalizeSchedule as aeNormalizeSchedule,
  currentOccurrence as aeCurrentOccurrence, upcomingOccurrences as aeUpcoming,
  reserve as aeReserve, cancelReservation as aeCancelReservation, liveSlotFor as aeLiveSlotFor,
  ensureRun as aeEnsureRun, contribute as aeContribute, isStaff as aeIsStaff,
  playerView as aePlayerView, slotCounts as aeSlotCounts, entrantCount as aeEntrantCount,
  SHARD as AE_SHARD, throneMax as aeThroneMax, recordThrone as aeRecordThrone,
} from './adminevent.js';
import {
  DAILY_PIECES, DAILYC_COINS, DAILYC_GEMS, DAILYC_MAX_SCORE, DAILYC_ATTEMPT_MS,
  dailySeed, dailyModifierOf, dailyTargetOf, nextJstMidnight, blueprintFor,
} from './daily.js';
// 🛠 パズル工房の投稿検証は、クライアントとまったく同じ盤面ロジックで走らせる。
// 別実装を書くと「手元では解けるのに投稿できない（またはその逆）」が必ず起きる。
// server/battle.js も同じファイルを読んでいるので、依存が増えるわけではない。
import { Engine, SHAPES, SIZE } from '../public/js/engine.js';

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
app.set('trust proxy',
  _trustProxy == null || _trustProxy === '' ? 1
  : /^(0|false|off|no)$/i.test(_trustProxy.trim()) ? false
  : /^\d+$/.test(_trustProxy.trim()) ? Number(_trustProxy.trim())
  : _trustProxy.trim());
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
// 実在する復元ファイルは実測で 61KB 前後。12MB は2桁ぶん余裕がありすぎた。
// 4MB にしたのは backup.js の MAX_RESTORE_USERS（20,000件）と噛み合わせるため —
// これより絞ると「件数の上限」に到達する前にバイト数で落ちてしまい、
// 「ユーザー数が多すぎます」という具体的な案内が誰にも届かなくなる。
// なお OOM を止めているのは主にこの数字ではなく、下の同時実行数の上限。
const RESTORE_LIMIT_MB = 4;
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

app.use(authMiddleware);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
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
    "frame-ancestors 'self'",
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
// `from './x.js'` と `import('./x.js')` の両形式。
const IMPORT_SPEC_RE = /(from\s*|import\s*\(\s*)(['"])(\.\/[\w.-]+\.js)(['"])/g;
const ASSET_NAME_RE = /^\/js\/([\w.-]+\.js)$/;

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
  try {
    const html = fs.readFileSync(ASSET_INDEX_HTML, 'utf8');
    assetIndexMtime = fs.statSync(ASSET_INDEX_HTML).mtimeMs;
    const mv = assetVer.get('main.js');
    if (mv) {
      const out = html.replace(/(src=")(\.?\/?js\/main\.js)(")/, `$1$2?v=${mv}$3`);
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
  if (req.path === '/' || req.path === '/index.html') {
    try {
      if (assetIndexMtime !== fs.statSync(ASSET_INDEX_HTML).mtimeMs) buildAssetHashes();
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
    coins: 500, gems: 50, xp: 0,
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
      history: [],
    },
    owned: [...DEFAULT_OWNED],
    items: { item_bomb: 1, item_cleaner: 1, item_fever: 1 },   // starter boosters
    equipped: { ...DEFAULT_EQUIPPED },
    equippedTitle: null,
    battlePass: { season: currentSeason().id, xp: 0, premium: false, claimed: [] },
    badges: [],
    achievements: [],
    missions: null,   // generated on first access (syncMissions)
    lastDaily: jstDayKey(),   // grantDaily と同じJST基準で揃える
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
  })) if (s[k] === undefined) s[k] = v;
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
function seedLastResultAt(user) {
  const s = user.stats;
  if (Number.isFinite(s.lastResultAt) && s.lastResultAt > 0) return s.lastResultAt;
  const now = Date.now();
  const age = Math.max(0, now - (Number.isFinite(user.createdAt) ? user.createdAt : now));
  s.lastResultAt = now - Math.min(age, FIRST_RESULT_GRACE_MS);
  return s.lastResultAt;
}

function levelOf(xp) { return 1 + Math.floor(xp / 1000); }

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
// 🐛報告箱の上限。バグ報告と通報が同じ配列を使うので、値は必ず1つに保つ。
const BUGREPORT_CAP = 300;
const SERVER_JUDGED_MODES = new Set(['royale', 'tournament', 'pvp', 'team', 'raid', 'coop', 'attack']);

function applyGameResult(user, { mode, score, lines, maxCombo, duration, won, drew, bossId, floor, wave, ults, items, pieces, floors, sprintDur, rank, depth, stage, day, attemptId, perfectClears, trusted, preClamped }) {
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
  perfectClears = clamp(perfectClears, 20);
  // 単数 floor（ダンジョン到達階）もクランプ。realm ブロックは別変数 fl で
  // クランプするが、到達フィード生成と `${mode}Prev` 書き込みは生 floor を
  // 使うため、ここで押さえないと F999999 の虚偽速報や dungeonPrev=Infinity
  // (保存で null 化) を通してしまう。fl(926)と二重になるが無害。
  floor = clamp(floor, 100);
  depth = clamp(depth, 9999);
  stage = clamp(stage, 9999);
  rank = ['S', 'A', 'B', 'C'].includes(rank) ? rank : null;
  score = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
  lines = Math.max(0, Math.min(5000, Math.floor(Number(lines) || 0)));
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
  if (!preClamped) {
    const now = Date.now();
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

  let coins = Math.min(1000, 20 + Math.floor(score / 100) + (won ? 50 : 0));
  if (mode === 'chaos') coins = Math.min(1500, Math.round(coins * 1.5));   // chaos-mode bonus
  let bpXp = Math.min(800, 30 + Math.floor(score / 60) + lines * 5 + (won ? 100 : 0));
  let accXp = Math.min(600, 20 + Math.floor(score / 100) + (won ? 80 : 0));

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
    const questsDone = trackGuildQuests(db, user, wk, {
      mode, won: !!won, lines, perfectClears, ults,
      floors: isDungeonMode ? floors : 0,
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
  const scoreboardEligible = mode !== 'meltdown' && mode !== 'daily' && !mode.startsWith('ae_');
  if (scoreboardEligible && score > s.bestScore) s.bestScore = score;
  // これらの累積カウンタは実績→💎(課金通貨)の原資になるが、値はすべて
  // クライアント申告なのでスコア/コインと同様に信頼しない。💎ドロップと同じ
  // 「実プレイの痕跡」(score/duration が実プレイ下限を超える) を通った回だけ
  // 反映する。正直に1プレイすれば必ず超える水準なので通常プレイの取り分は
  // 変わらないが、{maxCombo:200} 等のテレメトリだけを連投しても最上位実績に
  // 到達できない。maxCombo は monotonic set ではなく実プレイ判定を通した回のみ更新。
  const realPlay = score >= GEMDROP_MIN_SCORE && duration >= GEMDROP_MIN_SECONDS;
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
  // 📅 イベント自動運行。/api/status からも呼んでいるが、誰も画面を開いて
  // いない時間帯に枠(18:00 JST)へ入る日のために、こちらでも点火を見る。
  // 自動運行OFF（既定）なら比較1回で戻るだけ。
  try { syncAutoEvent(); } catch (err) { console.error('[events] 自動開催に失敗:', err && err.message); }
}, 600_000).unref?.();

function inMaintenance() { return !!db.meta.maintenance; }

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
  const exists = Object.values(db.users).some(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
  // AI住人と同名のアカウントは作れない — チャットの返信/プロフィールで
  // 住人と人間の区別がつかなくなる。
  if (residentByName(username)) return res.status(409).json({ error: 'その名前はアリーナの住人が使っています。別の名前でどうぞ' });
  // 👁️ 管理者ゼロ を騙れると、イベント中に偽の宣告を撒けてしまう。
  // 名前だけ見ている相手には本物と区別がつかない。
  if (RESERVED_NAMES.some(n => n.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'その名前は使えません。別の名前でどうぞ' });
  }

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
    const exists = Object.values(db.users).some(u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase());
    if (exists) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
    if (residentByName(username)) return res.status(409).json({ error: 'その名前はアリーナの住人が使っています。別の名前でどうぞ' });
    // 登録で塞いでも、改名で取れては意味がない。
    if (RESERVED_NAMES.some(n => n.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'その名前は使えません。別の名前でどうぞ' });
    }
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
const GUEST_ITEM_MAX = 9;
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
    byId: req.user ? req.user.id : null,
    ip: req.ip,
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
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.stats && u.stats.weekly) { delete u.stats.weekly; affected++; }
  }
  saveDb();
  res.json({ affected });
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
  if (r && r.registered) {
    const st = residentStats(r, Date.now());
    const a = archetype(r.arch);
    return res.json({ profile: {
      kind: 'resident', name: r.name, role: 'user',
      level: st.level, rating: st.rating, bestScore: st.bestScore,
      pvpWins: st.pvpWins, pvpLosses: st.pvpLosses, dungeonMax: st.dungeonMax,
      badges: st.badges, title: st.title,
      guildTag: tagOfName(db, r.name, null),
      archLabel: a.label, archLabelEn: a.labelEn,
      hours: r.hours, favMode: r.favMode,
      online: activeResidents().some(x => x.id === r.id),
      thrones: thronesOfName(r.name),
    } });
  }
  if (r) return res.json({ profile: { kind: 'guest', name: r.name } });
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
// Guilds (ギルド)
// ---------------------------------------------------------------------------

const curWeek = () => weekIdOf(currentWeekNum());

app.get('/api/guilds', (req, res) => {
  // /api/leaderboard と同じく無認証で全ギルド走査＋ゴースト合成する重い経路。
  // 同じIPレート制限で連打を抑える。
  if (!rateLimit(`guilds:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください' });
  const week = curWeek();
  const real = Object.values(db.guilds).map(g => guildView(db, g, week));
  const ghosts = getCustom().toggles.guilds ? ghostGuildViews(week).filter(g => !real.some(r => r.name === g.name || r.tag === g.tag)) : [];
  const rows = real.concat(ghosts).sort((a, b) => b.weeklyPoints - a.weeklyPoints).slice(0, 50).map((g, i) => ({ ...g, rank: i + 1 }));
  const mine = req.user && req.user.guildId && db.guilds[req.user.guildId]
    ? guildView(db, db.guilds[req.user.guildId], week, { detailed: true, viewerId: req.user.id, levelOf })
    : null;
  if (mine) mine.rank = rows.findIndex(r => r.id === mine.id) + 1 || null;
  res.json({ week, guilds: rows, mine, createCost: GUILD_CREATE_COST, icons: GUILD_ICONS });
});

app.get('/api/guilds/:id', (req, res) => {
  // `__proto__` や `constructor` を渡されると Object.prototype が返ってきて
  // truthy 判定を通り、そのあと g.members で落ちて 500 になっていた。
  const g = Object.prototype.hasOwnProperty.call(db.guilds, req.params.id) ? db.guilds[req.params.id] : null;
  if (g) return res.json({ guild: guildView(db, g, curWeek(), { detailed: true, viewerId: req.user && req.user.id, levelOf }) });
  const ghost = ghostGuildViews(curWeek()).find(x => x.id === req.params.id);
  if (ghost) return res.json({ guild: ghost });
  res.status(404).json({ error: 'ギルドが見つかりません' });
});

app.post('/api/guilds/create', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  if (user.role !== 'admin' && user.coins < GUILD_CREATE_COST) {
    return res.status(402).json({ error: `ギルド設立には🪙${GUILD_CREATE_COST}必要です` });
  }
  const out = createGuild(db, user, req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  if (user.role !== 'admin') user.coins -= GUILD_CREATE_COST;
  user.guildFounded = true;
  saveDb();
  battle.crowd.feed({ icon: out.guild.icon, real: true, who: user.username,
    text: `${user.username} がギルド「${out.guild.name}」を設立！`, textEn: `${user.username} founded the guild "${out.guild.name}"!` });
  res.json({ guild: guildView(db, out.guild, curWeek(), { detailed: true, viewerId: user.id, levelOf }), user: publicUser(user) });
});

app.post('/api/guilds/join', requireAuth, maintenanceGuard, (req, res) => {
  const b = req.body || {};
  const guild = findGuild(db, { id: b.id, code: b.code });
  if (!guild) return res.status(404).json({ error: b.code ? 'そのコードのギルドは見つかりません' : 'ギルドが見つかりません' });
  const out = joinGuild(db, req.user, guild, { viaCode: !!b.code });
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }), user: publicUser(req.user) });
});

app.post('/api/guilds/leave', requireAuth, (req, res) => {
  const out = leaveGuild(db, req.user);
  saveDb();
  res.json({ ok: true, disbanded: !!out.disbanded, user: publicUser(req.user) });
});

app.post('/api/guild/kick', requireAuth, (req, res) => {
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  const out = kickMember(db, guild, req.user, String(req.body.userId || ''));
  if (out.error) return res.status(403).json({ error: out.error });
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }) });
});

app.post('/api/guild/settings', requireAuth, (req, res) => {
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  if (guild.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'ギルドリーダーのみ変更できます' });
  const v = validateGuildInput(req.body || {}, { partial: true });
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.name && Object.values(db.guilds).some(g => g.id !== guild.id && g.name.toLowerCase() === v.name.toLowerCase())) {
    return res.status(409).json({ error: 'そのギルド名は使われています' });
  }
  if (v.tag && Object.values(db.guilds).some(g => g.id !== guild.id && g.tag === v.tag)) {
    return res.status(409).json({ error: 'そのタグは使われています' });
  }
  Object.assign(guild, v);
  saveDb();
  res.json({ guild: guildView(db, guild, curWeek(), { detailed: true, viewerId: req.user.id, levelOf }) });
});

// 🗡️ ギルド金庫 — 達成した週間クエストの宝箱を、メンバーが1人1回ずつ開ける。
//
// 報酬額はクライアントの申告を一切見ない。guilds.js が QUEST_POOL から
// 引き直したものだけを渡す（こちらは questId を取り次ぐだけ）。二重受取は
// guilds.js 側の user.guildQuests.claimed が止める。
// クエストの状態は guildView(detailed) の `quests` に載るので、専用のGETは要らない。
app.post('/api/guild/quest/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  if (!rateLimit('gquest:' + req.user.id, 20, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const guild = req.user.guildId ? db.guilds[req.user.guildId] : null;
  if (!guild) return res.status(404).json({ error: 'ギルドに所属していません' });
  const week = curWeek();
  const out = claimGuildQuest(db, req.user, week, String((req.body || {}).questId || (req.body || {}).id || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  // 3本すべて開けた人だけが手にする「ギルドの誉れ」。めったに出ないので告知する。
  if (out.badge) {
    battle.crowd.feed({ icon: '🎖️', real: true, who: req.user.username,
      text: `${req.user.username} がギルド週間クエストを完全制覇し「ギルドの誉れ」を獲得！`,
      textEn: `${req.user.username} cleared every weekly guild quest and earned Guild Honors!` });
  }
  res.json({
    reward: out,
    user: publicUser(req.user),
    guild: guildView(db, guild, week, { detailed: true, viewerId: req.user.id, levelOf }),
  });
});

app.delete('/api/admin/guilds/:id', requireAuth, requireAdmin, (req, res) => {
  // `__proto__` や `constructor` を渡されると Object.prototype が返ってきて
  // truthy 判定を通り、そのあと g.members で落ちて 500 になっていた。
  const g = Object.prototype.hasOwnProperty.call(db.guilds, req.params.id) ? db.guilds[req.params.id] : null;
  if (!g) return res.status(404).json({ error: 'ギルドが見つかりません' });
  for (const id of g.members) { const u = db.users[id]; if (u) u.guildId = null; }
  delete db.guilds[g.id];
  saveDb();
  res.json({ ok: true });
});

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
];

// ニュース本文の改訂番号。SEED_NEWS の文面を書き直したら1つ増やすと、
// すでに公開済みの投稿も次の起動で1度だけ差し替わる。
//
// これが無いと、一度出したお知らせは二度と直せなかった（seedNews は
// 英語の補完しかしないため）。実際、管理者向けの内容が載ってしまった
// v2.11.1 の本文を差し替えるのに必要になった。
const NEWS_BODY_REV = 8;   // v2.15: 英語面だけの改訂が公開されていなかったので出し直し

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
  const line = Math.max(0, Math.min(9_999_999, Math.floor(Number(b.line) || 0)));
  const col = Math.max(0, Math.min(9_999_999, Math.floor(Number(b.col) || 0)));
  const file = cut(b.file).trim();
  const where = file ? `${file}:${line}${col ? `:${col}` : ''}` : '';
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
    if (ua) found.ua = ua;
    if (lang) found.lang = lang;
    if (screen) found.screen = screen;
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
    .map(n => ({ id: n.id, title: n.title, titleEn: n.titleEn || null, body: n.body, bodyEn: n.bodyEn || null, pinned: !!n.pinned, at: n.at, by: n.by }));
}

app.get('/api/news', (_req, res) => {
  const list = newsView();
  res.json({ news: list, latestAt: list.reduce((a, n) => Math.max(a, n.at), 0) });
});

app.post('/api/admin/news', requireAuth, requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().replace(/[<>]/g, '').slice(0, 60);
  const body = String(req.body.body || '').trim().replace(/[<>]/g, '').slice(0, 2000);
  if (!title || !body) return res.status(400).json({ error: 'タイトルと本文を入力してください' });
  const n = { id: crypto.randomUUID(), title, body, pinned: !!req.body.pinned, by: req.user.username, at: Date.now() };
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

app.get('/api/weekly', (req, res) => {
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

app.get('/api/daily', (req, res) => {
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
app.post('/api/daily/start', requireAuth, maintenanceGuard, (req, res) => {
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
function sanitizeReplay(raw, opts = {}) {
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
function captureDailyReplay(user, body, rewards) {
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
app.get('/api/daily/blueprint', (req, res) => {
  if (!rateLimit(`dbp:${req.ip}`, 60, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const q = String(req.query.day || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : jstDayKey();
  const bp = blueprintFor(day);
  if (!bp) return res.status(404).json({ error: 'きょうの設計図がありません', errorEn: 'No blueprint for today' });
  res.json({ ...bp, pieces: bp.pieces.map(({ at, ...p }) => p) });
});

// 📅 その日のTOP3のリプレイ（本人の分も一緒に返す）。ログイン不要で読める
// 公開データなので、他の公開読み取りと同じIPレート制限をかける。
app.get('/api/daily/replays', (req, res) => {
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
app.post('/api/workshop/stages', requireAuth, maintenanceGuard, (req, res) => {
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
app.get('/api/workshop/stages', (req, res) => {
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
app.get('/api/workshop/stages/:code', (req, res) => {
  if (!rateLimit(`wsget:${req.ip}`, 120, 60000)) return res.status(429).json({ error: '少し待ってください', errorEn: 'Please slow down' });
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  res.json({ stage: workshopView(stage, req.user, { board: true }) });
});

// プレイ数の記録と、作者へのコイン還元。額も上限もサーバーが決める。
app.post('/api/workshop/stages/:code/play', requireAuth, maintenanceGuard, (req, res) => {
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
app.post('/api/workshop/stages/:code/like', requireAuth, maintenanceGuard, (req, res) => {
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
app.delete('/api/workshop/stages/:code', requireAuth, (req, res) => {
  const stage = findWorkshopStage(req.params.code);
  if (!stage) return res.status(404).json({ error: 'そのコードのステージは見つかりません', errorEn: 'No stage with that code' });
  if (stage.by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '自分が投稿したステージだけ削除できます', errorEn: 'You can only delete stages you published' });
  }
  delete ensureWorkshop().stages[stage.code];
  saveDb();
  res.json({ ok: true, code: stage.code });
});

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
  return { entrants: rows.length, top: rows.slice(0, 3).map((r, i) => ({ rank: i + 1, ...r })) };
}

function settleSeasonHallOfFame() {
  const cur = currentSeason();
  const prev = db.meta.seasonMark;
  if (prev && prev.id === cur.id) return;
  // 初回（この機能が入る前からある機体・復元直後）は刻印を置くだけ。
  // 直前のシーズンがどうだったかを知らないまま表彰しても嘘になる。
  if (!prev || !prev.id) { db.meta.seasonMark = seasonMarkOf(cur); saveDb(); return; }
  // 再デプロイ直後の空DB（復元待ち）では進めない。ここで印だけ進めると、
  // 復元されてくる人たちのシーズンが1回ぶん無言で飛ぶ。
  if (!Object.values(db.users).some(u => u.role !== 'admin' && !u.banned)) return;

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
    const { entrants, top } = hofTopOf(b.id);
    if (!top.length) continue;
    boards.push({ id: b.id, name: b.name, nameEn: b.nameEn, entrants, top: top.map(t => ({ rank: t.rank, username: t.username, value: t.value, resident: t.resident })) });
    for (const t of top) {
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
        rank: t.rank, of: entrants, best: t.value,
        coins: 0, gems, badge: t.rank === 1 ? badge : null,
        at: Date.now(),
      });
      if (t.rank === 1) winners.push({ username: u.username, board: b.name, boardEn: b.nameEn });
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
      body: `${prev.name}が終了しました。歴代の記録として殿堂に刻まれた顔ぶれです。\n\n${lineJa}\n\n各ボードの上位3名にはジェムを、1位にはシーズン刻印バッジをお届けしました（ゲームを開くと受け取れます）。新シーズンもよろしくお願いします！`,
      bodyEn: `${prev.nameEn} has ended — here are the names carved into the Hall of Fame.\n\n${lineEn}\n\nThe top 3 of each board received gems, and each #1 earned the season champion badge — open the game to claim. See you in the new season!`,
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
  const list = (Array.isArray(db.meta.hallOfFame) ? db.meta.hallOfFame : [])
    .slice()
    .sort((a, b) => (b.number || 0) - (a.number || 0))
    .slice(0, 50);
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
app.post('/api/game/result', requireAuth, maintenanceGuard, (req, res) => {
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
// 👑 管理者イベント — weekly, with per-player time slots
// ---------------------------------------------------------------------------

// Reservation counts + the shared world state, recomputed per request. There
// are no timers: everything derives from wall-clock time, so a redeploy in the
// middle of an event changes nothing.
function adminEventView(user) {
  const schedule = getAeSchedule(db);
  if (!schedule.enabled) return null;
  const occ = aeCurrentOccurrence(schedule);
  if (!occ) return null;
  return aePlayerView(db, user, Date.now(), aeSlotCounts(db, occ));
}

app.get('/api/adminevent', (req, res) => {
  res.json({ event: adminEventView(req.user) });
});

app.post('/api/adminevent/reserve', requireAuth, maintenanceGuard, (req, res) => {
  const schedule = getAeSchedule(db);
  if (!schedule.enabled) return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  // 試運転中は運営以外、そもそも存在しないのと同じ扱いにする
  // （見えないのに予約だけ通る、という中途半端な状態を作らない）。
  if (schedule.staffOnly && !aeIsStaff(req.user)) {
    return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  }
  const occ = aeCurrentOccurrence(schedule);
  if (!occ) return res.status(409).json({ error: 'いま開催予定の管理者イベントはありません' });
  const slotId = Math.floor(Number(req.body && req.body.slotId));
  const r = aeReserve(req.user, occ, slotId);
  if (r.error) return res.status(400).json({ error: r.error });
  saveDb();
  res.json({ event: adminEventView(req.user), user: publicUser(req.user) });
});

app.post('/api/adminevent/cancel', requireAuth, (req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  if (occ) aeCancelReservation(req.user, occ.dayKey);
  // 開催が無いときの後片付けも、実績は控えに残してから外す（開催中の経路と
  // 挙動を揃えないと、ここを通るだけで受取済みの記録が消えてしまう）。
  else if (req.user.adminEvent) {
    req.user.adminEventDay = { ...req.user.adminEvent };
    req.user.adminEvent = null;
  }
  saveDb();
  res.json({ event: adminEventView(req.user) });
});

// Finish one run of the exclusive mode. The score is folded into the SHARED
// world state (one boss / one gauge / one board per event day), so the 18:00
// crowd and the 21:00 crowd are demonstrably working on the same thing.
app.post('/api/adminevent/result', requireAuth, maintenanceGuard, (req, res) => {
  // /api/game/result と同じ回数制限。ここだけ無かったので、枠の30分間
  // ジェムを1回40個ずつ何度でも取れた（枠は誰でも自分で予約できる）。
  if (!rateLimit(`aeresult:${req.user.id}`, 30, 60 * 1000)
      || !rateLimit(`aeresulth:${req.user.id}`, 250, 60 * 60 * 1000)) {
    return res.status(429).json({ error: '送信が多すぎます。しばらく待ってください' });
  }
  const schedule = getAeSchedule(db);
  // graceMs=125000: 固定120秒ランの結果が、枠終了ちょうどで走り切った直後でも
  // 受理されるよう猶予を与える(1ラン=120秒 + 送信/クロックの余白5秒)。
  // 枠の「開始前」は猶予対象外なので、早撃ちには使えない。
  const live = schedule.enabled ? aeLiveSlotFor(schedule, req.user, Date.now(), 125000) : null;
  if (!live) return res.status(403).json({ error: 'いまはあなたの枠の時間ではありません' });

  const { occ } = live;
  const counts = aeSlotCounts(db, occ);
  const run = aeEnsureRun(db, occ, Math.max(1, aeEntrantCount(counts)));

  // Same anti-cheat ceiling the normal result path uses, then the event's own
  // reward multiplier on top (🎁 お宝ラッシュ).
  const body = req.body || {};
  let duration = Math.max(1, Math.min(3600, Number(body.duration) || 1));
  // duration はクライアント申告なので、/api/game/result と同じく
  // 「前回の提出からの実経過時間」で頭を押さえる。ここが無かったので
  // duration:3600 を書くだけで毎回 score=1,000,000 を通せた。
  {
    // 基準の入れ方は applyGameResult 側と同じ（seedLastResultAt）。
    // ここだけ一律300秒にしていると、初参加の人の長い1回が切り詰められる。
    const now = Date.now();
    const last = seedLastResultAt(req.user);
    const elapsed = (now - last) / 1000 + 90;
    if (duration > elapsed) duration = Math.max(1, Math.floor(elapsed));
    req.user.stats.lastResultAt = now;
  }
  let score = Math.max(0, Math.min(1_000_000, Math.floor(Number(body.score) || 0)));
  if (score > duration * 500) score = Math.floor(duration * 500);

  const before = { hp: run.hp, tiersReached: run.tiersReached };
  const delta = aeContribute(run, req.user, score);

  const rewards = applyGameResult(req.user, {
    // ここも素通しにしない。`trusted` を自己申告で立てられてしまう。
    ...pickResultFields(body),
    mode: `ae_${run.modeId}`,
    score,
    duration,
    won: !!delta.killed,
    // duration の頭押さえは上で済ませてある。二度やると 45,000点 で
    // 頭打ちになる（このイベントは1枠180分あり、倍率も乗る）。
    preClamped: true,
  });

  // 🎁 お宝ラッシュ — the slot's own multiplier, paid on top of whatever the
  // normal pipeline granted, and reported separately so the result screen can
  // show where it came from.
  const mult = Math.max(1, schedule.rewardMult || 1);
  let chestCoins = 0, chestGems = 0;
  if (mult > 1 && rewards) {
    chestCoins = Math.round(rewards.coins * (mult - 1));
    // 💎は課金通貨。通常経路(applyGameResult の eventGems, GEMDROP_DAILY_CAP)
    // と同じ日次上限をここにも課す。ここだけ上限が無く、枠内で /result を連投
    // するとジェムを日次上限を超えて積み増せる穴だった。予算は st.eventGemDay
    // で通常ドロップと共有し、「1日に湧く💎総額」を一本化する。
    const st = req.user.stats;
    const today = jstDayKey();
    if (!st.eventGemDay || st.eventGemDay.day !== today) st.eventGemDay = { day: today, got: 0 };
    const room = Math.max(0, GEMDROP_DAILY_CAP - st.eventGemDay.got);
    const scoreGems = Math.min(Math.floor(score / 25_000), room);
    st.eventGemDay.got += scoreGems;
    // とどめ(+25)は1枠で最大1回、討伐という実イベントに紐づくので上限とは別枠。
    chestGems = scoreGems + (delta.killed ? 25 : 0);
    req.user.coins += chestCoins;
    req.user.gems += chestGems;
  }

  const r = req.user.adminEvent;
  if (r && r.dayKey === occ.dayKey) {
    r.playedAt = Date.now();
    r.runs = (r.runs || 0) + 1;
    r.best = Math.max(r.best || 0, score);
    r.contributed = (r.contributed || 0) + score;
    r.chests = (r.chests || 0) + 1;
  }
  // 👑 王座の欠片。参加ぶんは1日1回だけ ── 回すほど貯まると、
  // 専用ショップが「回数の店」になって、居合わせた意味が薄れるので。
  let shardGain = 0;
  if (r && r.dayKey === occ.dayKey && !r.shardJoin) { r.shardJoin = true; shardGain += AE_SHARD.join; }
  for (const idx of delta.tiersReached) {
    shardGain += AE_SHARD.tier[Math.min(idx, AE_SHARD.tier.length - 1)];
  }
  if (delta.killed) shardGain += AE_SHARD.bossKill;
  if (shardGain > 0) req.user.shards = (req.user.shards || 0) + shardGain;

  req.user.stats.aePlays = (req.user.stats.aePlays || 0) + 1;
  req.user.stats.aeBest = Math.max(req.user.stats.aeBest || 0, score);

  // 👑 Everyone who took part in the day the Admin fell keeps the badge — the
  // final blow is luck, the 120,000 HP was the group's work.
  let aeBadge = null;
  if (run.modeId === 'invasion' && run.killedAt) {
    for (const u of Object.values(db.users)) {
      const ur = u && u.adminEvent;
      if (!ur || ur.dayKey !== occ.dayKey || !ur.runs) continue;
      if (!u.badges.includes('adminevent')) {
        u.badges.push('adminevent');
        if (u.id === req.user.id) aeBadge = 'adminevent';
      }
    }
  }

  // World-scale moments go to everyone, not just the people currently in a slot.
  if (delta.killed) {
    const mode = aeModeById(run.modeId);
    battle.broadcastAll({
      type: 'announce',
      message: `👑 「${req.user.username}」のとどめ！ ${mode ? mode.name : '管理者'}を全員で討ち取りました！`,
      messageEn: `👑 "${req.user.username}" lands the final blow — everyone brought the Admin down together!`,
      from: '運営',
    });
    battle.crowd.feed({ icon: '👑', real: true, who: '運営',
      text: `管理者イベントのボスが討伐されました（とどめ: ${req.user.username}）`,
      textEn: `The Admin Event boss has been defeated (final blow: ${req.user.username})` });
  }
  for (const idx of delta.tiersReached) {
    const tier = run.tiers[idx];
    battle.broadcastAll({
      type: 'announce',
      message: `🏛️ 共同作業 目標${idx + 1}達成！ 参加者全員に 🪙${tier.coins} 💎${tier.gems}`,
      messageEn: `🏛️ The Great Work cleared tier ${idx + 1}! Everyone who took part gets 🪙${tier.coins} 💎${tier.gems}`,
      from: '運営',
    });
  }

  saveDb();
  res.json({
    rewards, user: publicUser(req.user),
    chest: { coins: chestCoins, gems: chestGems, mult },
    delta: { gained: delta.gained, damage: delta.damage, killed: delta.killed, tiersReached: delta.tiersReached },
    shards: shardGain,
    aeBadge,
    before,
    event: adminEventView(req.user),
  });
});

// Community-goal payouts are claimed, not pushed — a player who was in the
// 18:00 slot can collect a tier the 21:00 crowd unlocked later.
app.post('/api/adminevent/claim', requireAuth, maintenanceGuard, (req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  const run = db.meta.adminEventRun;
  if (!run || run.modeId !== 'communal') return res.status(409).json({ error: '受け取れる報酬がありません' });
  const r = req.user.adminEvent;
  if (!r || r.dayKey !== run.dayKey || !r.runs) {
    return res.status(403).json({ error: 'この回に参加していません' });
  }
  const claimed = r.claimedTiers || (r.claimedTiers = []);
  // Nothing reached yet is NOT the same as already collected — saying
  // "受け取り済みです" to someone whose gauge simply has not filled is a lie.
  if (!run.tiersReached) {
    return res.status(409).json({ error: 'まだ目標に届いていません（ゲージを進めよう）' });
  }
  let coins = 0, gems = 0, badge = null;
  for (let i = 0; i < run.tiersReached; i++) {
    if (claimed.includes(i)) continue;
    claimed.push(i);
    coins += run.tiers[i].coins;
    gems += run.tiers[i].gems;
    if (run.tiers[i].badge && !req.user.badges.includes(run.tiers[i].badge)) {
      req.user.badges.push(run.tiers[i].badge);
      badge = run.tiers[i].badge;
    }
  }
  if (!coins && !gems && !badge) return res.status(409).json({ error: '受け取り済みです' });
  req.user.coins += coins;
  req.user.gems += gems;
  saveDb();
  res.json({ reward: { coins, gems, badge }, user: publicUser(req.user), event: adminEventView(req.user) });
});

// ---- admin side ----

app.get('/api/admin/adminevent', requireAuth, requireAdmin, (_req, res) => {
  const schedule = getAeSchedule(db);
  const occ = schedule.enabled ? aeCurrentOccurrence(schedule) : null;
  const counts = occ ? aeSlotCounts(db, occ) : {};
  const roster = [];
  if (occ) {
    for (const u of Object.values(db.users)) {
      const r = u && u.adminEvent;
      if (r && r.dayKey === occ.dayKey) {
        roster.push({ username: u.username, slotId: r.slotId, runs: r.runs || 0, best: r.best || 0 });
      }
    }
    roster.sort((a, b) => a.slotId - b.slotId || b.best - a.best);
  }
  res.json({
    schedule,
    modes: AE_MODES,
    weekdays: AE_WEEKDAYS_JA,
    occurrences: aeUpcoming(schedule, Date.now(), 2).map(o => ({
      dayKey: o.dayKey, modeId: o.modeId, opensAt: o.opensAt, closesAt: o.closesAt,
      slots: o.slots.map(s => ({ id: s.id, time: s.time, startsAt: s.startsAt, endsAt: s.endsAt, taken: counts[s.id] || 0 })),
    })),
    roster,
    run: db.meta.adminEventRun || null,
  });
});

app.post('/api/admin/adminevent', requireAuth, requireAdmin, (req, res) => {
  const prev = db.meta.adminEvent || null;
  const r = aeNormalizeSchedule(req.body || {}, prev);
  if (r.error) return res.status(400).json({ error: r.error });
  const wasEnabled = prev && prev.enabled;
  r.schedule.updatedAt = Date.now();
  r.schedule.updatedBy = req.user.username;
  db.meta.adminEvent = r.schedule;
  // Re-scheduling to a different day — or switching the mode — abandons the
  // old shared state; it belongs to the day+mode pair it was created for.
  const occ = r.schedule.enabled ? aeCurrentOccurrence(r.schedule) : null;
  const run = db.meta.adminEventRun;
  if (run && (!occ || run.dayKey !== occ.dayKey || run.modeId !== occ.modeId)) {
    db.meta.adminEventRun = null;
  }
  saveDb();

  if (r.schedule.enabled && !wasEnabled && occ) {
    const mode = aeModeById(occ.modeId);
    const times = r.schedule.slots.join(' / ');
    battle.broadcastAll({
      type: 'announce',
      message: `👑 管理者イベント「${mode.name}」開催決定！ ${occ.dayKey} の ${times}（JST）— メニューから好きな時間帯を予約してね`,
      messageEn: `👑 Admin Event "${mode.nameEn}" is scheduled for ${occ.dayKey} at ${times} JST — reserve the slot that suits you from the menu`,
      from: '運営',
    });
    battle.crowd.feed({ icon: '👑', real: true, who: '運営',
      text: `管理者イベント「${mode.name}」の予約受付がはじまりました`,
      textEn: `Reservations are open for the Admin Event "${mode.nameEn}"` });
  }
  res.json({ schedule: r.schedule });
});

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
  const taken = new Set(Object.values(db.users).map(u => u.username));
  const rows = realRows
    .concat(ghostRows(board, week, taken).map(r => ({ ...r, guildTag: tagOfName(db, r.username, null) })))
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

// ---------------------------------------------------------------------------
// 📕 コレクション図鑑（catalog.js の COLLECTION_SETS）
//
// セットごとの所持数/総数・未所持の id・入手経路・コンプ報酬の受取状態。
// 対象アイテムはカタログから導出されているので、新しいスキンを1つ足した日に
// 「全種コンプ」が静かに嘘になることはない。
// ---------------------------------------------------------------------------

// 未所持の品がどこで手に入るか。図鑑のマスに出すラベルの材料
// （文言そのものはクライアントが日英で持っている）。
function collectionSourceOf(kind, id) {
  if (kind === 'badge') return 'badge';
  if (kind === 'title') return 'title';
  if (kind === 'boost') return 'shop';
  const it = SHOP_ITEMS.find(i => i.id === id);
  if (!it) return 'shop';
  return it.throneOnly ? 'throne' : it.gachaOnly ? 'gacha' : 'shop';
}

app.get('/api/collection', requireAuth, (req, res) => {
  migrateUser(req.user);
  const view = collectionView(req.user);
  res.json({
    ...view,
    sets: view.sets.map(s => ({
      ...s,
      // 未所持ぶんだけ「どこで手に入るか」を添える（所持済みには要らない）。
      sources: s.missing.map(id => ({ id, source: collectionSourceOf(s.kind, id) })),
    })),
  });
});

// セットコンプ報酬の受け取り。id:'*' で受け取れるものをまとめて。
// 条件は必ずサーバー側で再判定し（claimCollection が collectionProgress を
// 引き直す）、報酬額も COLLECTION_SETS から計算する ── 申告は一切見ない。
// 二重受取を止めるフラグは **user.collections**（受け取り済みセットidの配列）。
app.post('/api/collection/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const id = String((req.body || {}).id || (req.body || {}).setId || '*');
  if (id !== '*' && !COLLECTION_SETS.some(s => s.id === id)) {
    return res.status(404).json({ error: 'そのセットはありません' });
  }
  const out = claimCollection(req.user, id);
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({ reward: out, user: publicUser(req.user), collection: collectionView(req.user) });
});

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
// Gem purchases (DEMO payment — no real money is charged)
// ---------------------------------------------------------------------------

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeEnabled = () => STRIPE_KEY.length > 0;

app.get('/api/gempacks', (_req, res) => {
  res.json({ packs: GEM_PACKS, mode: stripeEnabled() ? 'stripe' : 'coming_soon' });
});

// db.transactions は無上限に伸びる唯一の配列。db.json は保存のたびに丸ごと
// 書き直すので、放っておくと1件買われるたびに全履歴を JSON 化するコストが
// 増え続ける（そして保存が遅くなるほど、書いている途中で落ちる窓が広がる）。
// 一定数を超えたら古い分を DATA_DIR/transactions-YYYY.jsonl へ追記し、
// db の中には直近 TX_KEEP 件だけ残す。
const TX_KEEP = 200;
// ローテーションで db から外した extId の控え。Stripe の webhook 重複判定は
// db.transactions を見ているので、これが無いと「古い取引が書庫に移ったあとに
// 同じ webhook が再送されると二重に付与される」穴が開く。
const TX_EXTID_KEEP = 500;

function rotateTransactions() {
  try {
    if (!Array.isArray(db.transactions) || db.transactions.length <= TX_KEEP) return;
    db.meta = db.meta || {};
    const old = db.transactions.slice(0, db.transactions.length - TX_KEEP);
    // 取引は時系列で積まれるので、年ごとの塊は必ず連続する。先頭から順に
    // 書き、書けたぶんだけ db から外す ── 途中で失敗しても、二重に書庫入り
    // する取引は出ない（次回そこから再開する）。
    const groups = [];
    for (const t of old) {
      const y = new Date(Number(t && t.at) || Date.now()).getFullYear();
      const last = groups[groups.length - 1];
      if (last && last.year === y) last.rows.push(t);
      else groups.push({ year: y, rows: [t] });
    }
    let moved = 0;
    for (const g of groups) {
      const file = path.join(DATA_DIR, `transactions-${g.year}.jsonl`);
      const text = g.rows.map(t => JSON.stringify(t)).join('\n') + '\n';
      try {
        fs.appendFileSync(file, text);
      } catch (err) {
        console.error(`[tx] ${path.basename(file)} に書けません:`, err.message);
        break;   // ここから先は db に残したまま、次の機会に再挑戦する
      }
      moved += g.rows.length;
    }
    if (moved <= 0) return;
    const archived = old.slice(0, moved);
    // 売上は db から消えるので meta に移す。ここを忘れると管理画面の売上が
    // ローテーションのたびに減って見える。
    db.meta.revenueTotal = (db.meta.revenueTotal || 0) + archived.reduce((a, t) => a + (Number(t && t.jpy) || 0), 0);
    db.meta.revenueCount = (db.meta.revenueCount || 0) + archived.length;
    const ext = (db.meta.txExtIds || []).concat(archived.map(t => t && t.extId).filter(Boolean));
    db.meta.txExtIds = ext.slice(-TX_EXTID_KEEP);
    db.transactions = db.transactions.slice(moved);
    console.log(`[tx] 取引 ${moved} 件を書庫に移しました（残り ${db.transactions.length} 件）`);
  } catch (err) {
    // ここで投げると購入処理そのものが 500 になる。書庫は補助なので握りつぶす。
    console.error('[tx] ローテーションに失敗:', err.message);
  }
}

function grantPack(user, pack, status, extId = null) {
  const total = pack.gems + pack.bonus;
  user.gems += total;
  db.transactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    packId: pack.id,
    gems: total,
    jpy: pack.priceJpy,
    status,
    extId,
    at: Date.now(),
  });
  rotateTransactions();
  saveDb();
  return total;
}

app.post('/api/purchase', requireAuth, maintenanceGuard, async (req, res) => {
  if (!rateLimit(`buy:${req.user.id}`, 30, 5 * 60 * 1000)) {
    return res.status(429).json({ error: '購入リクエストが多すぎます' });
  }
  const pack = GEM_PACKS.find(p => p.id === req.body.packId);
  if (!pack) return res.status(404).json({ error: 'パックが見つかりません' });

  // Real payments: create a Stripe Checkout session. Card details are entered
  // on Stripe's hosted page; gems are granted ONLY by the verified webhook.
  if (stripeEnabled()) {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      const params = new URLSearchParams({
        mode: 'payment',
        success_url: `${base}/?purchase=success`,
        cancel_url: `${base}/?purchase=cancel`,
        'line_items[0][price_data][currency]': 'jpy',
        'line_items[0][price_data][product_data][name]': `Block Blitz Arena ジェム ${pack.gems + pack.bonus}個`,
        'line_items[0][price_data][unit_amount]': String(pack.priceJpy),
        'line_items[0][quantity]': '1',
        'metadata[userId]': req.user.id,
        'metadata[packId]': pack.id,
      });
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const session = await resp.json();
      if (!resp.ok || !session.url) {
        console.error('[stripe] session create failed:', session.error && session.error.message);
        return res.status(502).json({ error: '決済セッションの作成に失敗しました' });
      }
      return res.json({ checkoutUrl: session.url });
    } catch (err) {
      console.error('[stripe] error:', err.message);
      return res.status(502).json({ error: '決済サービスに接続できません' });
    }
  }

  // No payment provider configured — purchases are under construction.
  res.status(503).json({ error: '💳 課金機能は製作中です。もうしばらくお待ちください！' });
});

// Stripe webhook: the ONLY place real purchases grant gems.
app.post('/api/stripe/webhook', (req, res) => {
  if (!stripeEnabled() || !STRIPE_WEBHOOK_SECRET) return res.status(404).end();
  try {
    const sigHeader = String(req.headers['stripe-signature'] || '');
    const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
    const payload = `${parts.t}.${req.rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
    const given = Buffer.from(parts.v1 || '', 'hex');
    if (given.length !== 32 || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), given)) {
      return res.status(400).json({ error: 'bad signature' });
    }
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) {
      return res.status(400).json({ error: 'stale timestamp' });
    }
    const event = req.body;
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.metadata) {
        const user = db.users[session.metadata.userId];
        const pack = GEM_PACKS.find(p => p.id === session.metadata.packId);
        // 書庫に移った取引も見る。db.transactions だけだと、ローテーション後に
        // 同じイベントが再送されたときに二重付与になる。
        const already = db.transactions.some(t => t.extId === session.id)
          || (db.meta.txExtIds || []).includes(session.id);
        if (user && pack && !already) {
          grantPack(user, pack, 'stripe_completed', session.id);
          console.log(`[stripe] granted ${pack.id} to ${user.username}`);
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook error:', err.message);
    res.status(400).json({ error: 'webhook error' });
  }
});

app.get('/api/admin/transactions', requireAuth, requireAdmin, (_req, res) => {
  const tx = db.transactions.slice(-100).reverse();
  // 合計は「書庫に移したぶん(db.meta) ＋ db に残っているぶん」。ローテーションで
  // 売上と件数が減って見えないように、必ず両方を足す。
  const archivedJpy = Number(db.meta.revenueTotal) || 0;
  const archivedCount = Number(db.meta.revenueCount) || 0;
  const liveJpy = db.transactions.reduce((a, t) => a + (Number(t && t.jpy) || 0), 0);
  res.json({
    transactions: tx,
    totalCount: archivedCount + db.transactions.length,
    totalJpy: archivedJpy + liveJpy,
    // 内訳（一覧に出ているのは直近ぶんだけ、と管理者が分かるように）。
    liveCount: db.transactions.length,
    archivedCount,
    archivedJpy,
  });
});

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 🏷 日替わりピックアップ（セール）＋ 🎁 本日の無料ギフト
//
// セールは全員共通・日付だけで決まる。抽選は missions.js と同じ mulberry32 の
// シード式で、db に何も持たない（＝復元でズレない、再起動で変わらない）。
// 割引率も同じ乱数列から出すので、誰がいつ叩いても同じ答えになる。
//
// いちばん大事なのは「割引後の価格は購入APIが自分で計算し直す」こと。
// クライアントが割引価格を申告できる形にすると、90%引きの申告で何でも買える。
// ---------------------------------------------------------------------------

function strHash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEAL_COUNT = 2;
const DEAL_OFF_MIN = 20;
const DEAL_OFF_MAX = 30;
// 抽選の対象外: 管理者専用・👑王座専用・🎰ガチャ限定・既定所持品（価格0）。
function dealEligible(i) {
  return !i.adminOnly && !i.throneOnly && !i.gachaOnly && !i.default && i.price > 0;
}

let dealsMemo = { day: null, list: null };
function dailyDeals(dayKey = jstDayKey()) {
  if (dealsMemo.day === dayKey && dealsMemo.list) return dealsMemo.list;
  const pool = SHOP_ITEMS.filter(dealEligible);
  const rnd = mulberry32(strHash32(`bba-deal-${dayKey}`));
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const endsAt = nextJstMidnight();
  const list = arr.slice(0, Math.min(DEAL_COUNT, arr.length)).map(it => {
    const off = DEAL_OFF_MIN + Math.floor(rnd() * (DEAL_OFF_MAX - DEAL_OFF_MIN + 1));
    return {
      id: it.id, cat: it.cat, name: it.name, currency: it.currency,
      basePrice: it.price,
      off,
      price: Math.max(1, Math.round(it.price * (100 - off) / 100)),
      endsAt,
    };
  });
  dealsMemo = { day: dayKey, list };
  return list;
}

// 今この瞬間のこの品の実売価格。購入APIはここしか見ない。
function priceOf(item) {
  const d = dailyDeals().find(x => x.id === item.id);
  return d ? d.price : item.price;
}

// 🎁 本日の無料ギフト。1日1回。少額コイン／ブースター1個／低確率でジェム少量。
const GIFT_COINS_MIN = 300;
const GIFT_COINS_MAX = 600;
const GIFT_GEMS_MIN = 8;
const GIFT_GEMS_MAX = 20;
const GIFT_GEM_CHANCE = 0.08;    // 低確率
const GIFT_ITEM_CHANCE = 0.35;

function giftClaimedDay(user) {
  return (user.stats && user.stats.shopGiftDay) || null;
}

app.get('/api/shop', (req, res) => {
  // Admin-exclusive cosmetics are invisible to everyone else. Gacha-exclusive
  // gear is listed (so players know it exists) but marked and unbuyable.
  const isAdmin = req.user && req.user.role === 'admin';
  // throneOnly（👑専用ショップの品）もここには載せる ── 在庫画面が読むのが
  // このAPI なので、外すと買った本人が装備できなくなる。買えないことは
  // /api/shop/buy 側で弾いていて、画面もガチャ限定と同じ扱いで出す。
  const day = jstDayKey();
  res.json({
    items: SHOP_ITEMS.filter(i => !i.adminOnly || isAdmin),
    boosters: BOOST_ITEMS.filter(i => !i.adminOnly || isAdmin),
    // 🏷 本日のピックアップ（全員共通）。endsAt は各行にも入っている。
    deals: dailyDeals(day),
    dealsEndAt: nextJstMidnight(),
    // 🎁 本日の無料ギフトの受取状態。未ログインは常に false（受け取りは要ログイン）。
    gift: {
      day,
      available: !!req.user && giftClaimedDay(req.user) !== day,
      claimed: !!req.user && giftClaimedDay(req.user) === day,
      nextAt: nextJstMidnight(),
    },
  });
});

// 🎁 受け取りは1日1回。受取日は user.stats に dayKey で残すので、
// 連打しても2回目からは409になる。
app.post('/api/shop/gift', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`gift:${req.user.id}`, 10, 60 * 1000)) {
    return res.status(429).json({ error: '少し待ってください' });
  }
  migrateUser(req.user);
  const user = req.user;
  const today = jstDayKey();
  if (giftClaimedDay(user) === today) {
    return res.status(409).json({ error: '本日の無料ギフトは受け取り済みです', nextAt: nextJstMidnight() });
  }
  // 中身はサーバーで抽選する（クライアントの申告は一切見ない）。
  const roll = Math.random();
  let gift;
  if (roll < GIFT_GEM_CHANCE) {
    const amount = GIFT_GEMS_MIN + Math.floor(Math.random() * (GIFT_GEMS_MAX - GIFT_GEMS_MIN + 1));
    user.gems += amount;
    gift = { type: 'gems', amount, icon: '💎', name: 'ジェム', nameEn: 'Gems' };
  } else if (roll < GIFT_GEM_CHANCE + GIFT_ITEM_CHANCE) {
    const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
    const it = pool[Math.floor(Math.random() * pool.length)];
    user.items = user.items || {};
    user.items[it.id] = (user.items[it.id] || 0) + 1;
    gift = { type: 'item', id: it.id, amount: 1, icon: it.icon, name: it.name, nameEn: enName(it) };
  } else {
    const amount = GIFT_COINS_MIN + Math.floor(Math.random() * (GIFT_COINS_MAX - GIFT_COINS_MIN + 1));
    user.coins += amount;
    gift = { type: 'coins', amount, icon: '🪙', name: 'コイン', nameEn: 'Coins' };
  }
  user.stats.shopGiftDay = today;
  saveDb();
  res.json({ gift, user: publicUser(user), nextAt: nextJstMidnight() });
});

// ---- Booster items (consumables) ----

app.post('/api/items/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = BOOST_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用のアイテムです（非売品）' });
  const count = Math.max(1, Math.min(10, Math.floor(Number(req.body.count) || 1)));
  const cost = item.price * count;
  const user = req.user;
  if (user.role !== 'admin') {   // admins never pay
    if (user.coins < cost) return res.status(402).json({ error: 'コインが足りません' });
    user.coins -= cost;
  }
  user.items = user.items || {};
  user.items[item.id] = (user.items[item.id] || 0) + count;
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/items/use', requireAuth, (req, res) => {
  const user = req.user;
  user.items = user.items || {};
  const id = String(req.body.itemId || '');
  const def = BOOST_ITEMS.find(i => i.id === id);
  if (!def) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (def.adminOnly && user.role !== 'admin') return res.status(403).json({ error: '管理者専用のアイテムです' });
  // Admins have infinite boosters — nothing is consumed.
  if (user.role !== 'admin') {
    if ((user.items[id] || 0) <= 0) return res.status(409).json({ error: 'アイテムを持っていません' });
    user.items[id] -= 1;
    saveDb();
  }
  res.json({ user: publicUser(user) });
});

// ---- Capsule machine (coin gacha) ----

const GACHA_COST_1 = 500;
const GACHA_COST_10 = 4500;

// ガチャ2.0: floor で下限レアリティを底上げできる（87=SSR以上確定、72=SR以上確定）。
const GACHA_PITY = 40;   // 天井 — 40連以内にSSR以上が必ず出る

function gachaPull(user, lucky = false, floor = 0) {
  // 🍀 Lucky Day skews every roll upward (exponent < 1), so the rare tiers at
  // the top of the range come up more often: N 50%→37%, SSR+ 13%→18%.
  const roll = floor + (lucky ? Math.pow(Math.random(), 0.7) : Math.random()) * (100 - floor);
  if (roll < 50) {   // N: coins
    const amount = 150 + Math.floor(Math.random() * 6) * 50;
    user.coins += amount;
    return { type: 'coins', amount, rarity: 'N' };
  }
  if (roll < 72) {   // R: booster item (staff-only god items must never drop)
    const pool = BOOST_ITEMS.filter(i => !i.adminOnly);
    const it = pool[Math.floor(Math.random() * pool.length)];
    user.items[it.id] = (user.items[it.id] || 0) + 1;
    return { type: 'item', id: it.id, name: it.name, icon: it.icon, rarity: 'R' };
  }
  if (roll < 87) {   // SR: gems
    const amount = 15 + Math.floor(Math.random() * 6) * 5;
    user.gems += amount;
    return { type: 'gems', amount, rarity: 'SR' };
  }
  if (roll < 97) {   // SSR: unowned cosmetic (or big gems when complete)
    // adminOnly gear must never drop; gachaOnly gear drops ONLY here.
    // throneOnly をここに混ぜると「イベントでしか手に入らない」が嘘になる。
    const unowned = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly && !user.owned.includes(i.id));
    if (unowned.length === 0) {
      user.gems += 50;
      return { type: 'gems', amount: 50, rarity: 'SSR', complete: true };
    }
    const it = unowned[Math.floor(Math.random() * unowned.length)];
    user.owned.push(it.id);
    return { type: 'cosmetic', id: it.id, name: it.name, cat: it.cat, rarity: 'SSR', limited: !!it.gachaOnly };
  }
  // UR: jackpot gems
  user.gems += 150;
  return { type: 'gems', amount: 150, rarity: 'UR' };
}

app.post('/api/gacha', requireAuth, maintenanceGuard, (req, res) => {
  const count = Number(req.body.count) === 10 ? 10 : 1;
  const bonus = eventBonus(currentEvent());
  const base = count === 10 ? GACHA_COST_10 : GACHA_COST_1;
  const cost = Math.round(base * (bonus.gachaDiscount || 1));
  const user = req.user;
  if (user.role !== 'admin') {   // admins pull for free
    if (user.coins < cost) return res.status(402).json({ error: `コインが足りません（${fmtNum(cost)}必要）` });
    user.coins -= cost;
  }
  user.items = user.items || {};
  migrateUser(user);
  // ガチャ2.0: 天井（40連でSSR以上確定）＋ 10連はSR以上1枠確定。
  const isSRplus = r => r.rarity === 'SR' || r.rarity === 'SSR' || r.rarity === 'UR';
  const results = [];
  for (let i = 0; i < count; i++) {
    let floor = 0;
    if ((user.gachaPity || 0) >= GACHA_PITY - 1) floor = 87;                       // 天井到達: SSR以上
    else if (count === 10 && i === 9 && !results.some(isSRplus)) floor = 72;      // 10連保証: SR以上
    const r = gachaPull(user, !!bonus.gachaLuck, floor);
    user.gachaPity = (r.rarity === 'SSR' || r.rarity === 'UR') ? 0 : (user.gachaPity || 0) + 1;
    results.push(r);
  }
  user.stats.gachaPulls = (user.stats.gachaPulls || 0) + count;
  user.stats.gachaSSR = (user.stats.gachaSSR || 0) + results.filter(r => r.rarity === 'SSR' || r.rarity === 'UR').length;
  saveDb();
  // Big pulls make the live feed.
  const ur = results.find(r => r.rarity === 'UR');
  const ssr = results.find(r => r.rarity === 'SSR' && r.type === 'cosmetic');
  if (ur) postRealFeed(user, [{ icon: '🌟', ja: `${user.username} が UR を引き当てた！！`, en: `${user.username} hit the UR jackpot!!`, react: null }]);
  // 英語面に日本語のアイテム名が挿さっていた。カタログの英名を使う。
  else if (ssr) postRealFeed(user, [{ icon: '🎰', ja: `${user.username} がガチャで SSR「${ssr.name}」を引いた！`, en: `${user.username} pulled SSR "${enName(ssr)}"!` }]);
  const collectibles = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly);
  res.json({
    results, user: publicUser(user), cost, lucky: !!bonus.gachaLuck,
    pity: { count: user.gachaPity || 0, max: GACHA_PITY },
    collection: { owned: collectibles.filter(i => user.owned.includes(i.id)).length, total: collectibles.length },
  });
});

// Public gacha pricing so the UI can show the discounted cost.
app.get('/api/gacha/info', (req, res) => {
  const bonus = eventBonus(currentEvent());
  const mult = bonus.gachaDiscount || 1;
  const collectibles = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly);
  res.json({
    cost1: Math.round(GACHA_COST_1 * mult),
    cost10: Math.round(GACHA_COST_10 * mult),
    base1: GACHA_COST_1, base10: GACHA_COST_10,
    lucky: !!bonus.gachaLuck,
    discounted: mult !== 1,
    pityMax: GACHA_PITY,
    ...(req.user ? {
      pity: { count: req.user.gachaPity || 0, max: GACHA_PITY },
      collection: { owned: collectibles.filter(i => req.user.owned.includes(i.id)).length, total: collectibles.length },
    } : {}),
  });
});

function fmtNum(n) { return n.toLocaleString('ja-JP'); }

app.post('/api/shop/buy', requireAuth, maintenanceGuard, (req, res) => {
  const item = SHOP_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
  if (item.adminOnly) return res.status(403).json({ error: '管理者専用の装備です（非売品）' });
  if (item.throneOnly) return res.status(403).json({ error: '👑 管理者イベント専用ショップの品です（王座の欠片でのみ交換）' });
  if (item.gachaOnly) return res.status(403).json({ error: '🎰 ガチャ限定の装備です（SSRで入手）' });
  const user = req.user;
  if (user.owned.includes(item.id)) return res.status(409).json({ error: 'すでに所持しています' });
  // 🏷 セール価格は必ずここで引き直す。クライアントが送ってきた金額は見ない
  //（見た瞬間に「1コインで買った」と申告できる口ができる）。
  const price = priceOf(item);
  if (user[item.currency] < price) {
    return res.status(402).json({ error: item.currency === 'coins' ? 'コインが足りません' : 'ジェムが足りません' });
  }
  user[item.currency] -= price;
  user.owned.push(item.id);
  saveDb();
  res.json({ user: publicUser(user), paid: price, basePrice: item.price, discounted: price !== item.price });
});

// ---------------------------------------------------------------------------
// 👑 管理者イベント専用ショップ
// ---------------------------------------------------------------------------
// 棚が開くかどうかは、その人の財布ではなく世界がどこまで段を割ったかで決まる。
// だから「買えない」は「金が足りない」ではなく「まだ誰も割っていない」になる。

// 世界の到達段を運営が動かす口。断罪を実際に回さないと進まない値なので、
// これが無いと宝物庫の棚を試すことも、事故で巻き戻ったときに戻すこともできない。
// 棚が開くのは世界全体に効くので、運営だけ・記録つきにしてある。
app.post('/api/admin/throne', requireAuth, requireAdmin, (req, res) => {
  const n = Number(req.body.throneMax);
  if (!Number.isFinite(n) || n < 0 || n > 7) return res.status(400).json({ error: '0〜7 で指定してください' });
  const before = aeThroneMax(db);
  db.meta.throneMax = Math.trunc(n);
  saveDb();
  console.log(`[throne] ${req.user.username} が世界の到達段を ${before} → ${db.meta.throneMax} に変更`);
  res.json({ throneMax: db.meta.throneMax, before });
});

// ---------------------------------------------------------------------------
// 🤝 フレンド
// ---------------------------------------------------------------------------
// 連絡は必ず申請制。申請に自由文は載せられない（載せられると、申請そのものが
// 嫌がらせの配達手段になる）。断りの文言はどの理由でも同じにしてある ──
// 理由を出し分けると、この窓口が「ブロックされているか」を調べる道具になる。

const friendStatus = () => (battleReady && battle.presence ? battle.presence.statusOf : () => 'offline');

app.get('/api/friends', requireAuth, (req, res) => {
  migrateUser(req.user);
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

// 名前から探す。住人(AI)と予約名は弾く ── 登録/改名と同じ三段の確認。
app.post('/api/friends/search', requireAuth, (req, res) => {
  const name = String(req.body.username || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: '名前を入力してください' });
  if (!rateLimit('fsearch:' + req.user.id, 20, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const low = name.toLowerCase();
  const found = Object.values(db.users).find(u => u && u.username.toLowerCase() === low);
  // 見つからない理由は出し分けない（在籍の有無を総当たりで調べられる）。
  if (!found || found.id === req.user.id || found.banned) return res.json({ user: null });
  ensureSocial(req.user); ensureSocial(found);
  // ブロックしている/されている相手は「居ない」と同じ見え方にする。
  if ((req.user.blocked || []).includes(found.id) || (found.blocked || []).includes(req.user.id)) {
    return res.json({ user: null });
  }
  res.json({
    user: friendRow(db, found.id, levelOf, friendStatus()),
    already: (req.user.friends || []).includes(found.id),
    pending: (req.user.friendReqOut || []).includes(found.id),
  });
});

app.post('/api/friends/request', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  if (!rateLimit('freq:' + req.user.id, 10, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const target = userById(req.body.userId);
  if (!target) return res.status(404).json({ error: '申請できませんでした' });
  migrateUser(target);
  const r = sendRequest(db, req.user, target.id);
  if (r.error) return res.status(409).json({ error: r.error });
  saveDb();
  // 相手が今いるなら、その場で知らせる。
  // すれ違いでその場で成立した場合は「申請が届いた」ではなく
  // 「フレンドになった」を送る（申請はもう存在しない）。
  if (battleReady && battle.presence) {
    battle.presence.sendToUser(target.id,
      r.accepted
        ? { type: 'friend_accepted', by: req.user.username }
        : { type: 'friend_request', from: req.user.username },
      { primaryOnly: true });
  }
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

app.post('/api/friends/accept', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const r = acceptRequest(db, req.user, String(req.body.userId || ''));
  // 失敗した場合でも、途中まで直した内容（消えた申請の掃除など）は
  // 書き戻す。保存しないと、次の再起動で古い状態が戻ってくる。
  saveDb();
  if (r.error) return res.status(409).json({ error: r.error });
  if (battleReady && battle.presence && r.other) {
    battle.presence.sendToUser(r.other.id, { type: 'friend_accepted', by: req.user.username }, { primaryOnly: true });
  }
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

app.post('/api/friends/decline', requireAuth, (req, res) => {
  migrateUser(req.user);
  // 断ったことは相手に伝えない。伝えると、断る側が気まずさを負う。
  const r = declineRequest(db, req.user, String(req.body.userId || ''));
  saveDb();
  if (r.error) return res.status(409).json({ error: r.error });
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

app.post('/api/friends/cancel', requireAuth, (req, res) => {
  migrateUser(req.user);
  cancelRequest(db, req.user, String(req.body.userId || ''));
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

app.post('/api/friends/remove', requireAuth, (req, res) => {
  migrateUser(req.user);
  unfriend(db, req.user, String(req.body.userId || ''));
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

app.post('/api/friends/block', requireAuth, (req, res) => {
  migrateUser(req.user);
  const id = String(req.body.userId || '');
  const r = blockUser(db, req.user, id);
  if (r.error) return res.status(409).json({ error: r.error });
  saveDb();
  // 同席したままだと、ブロックが「見えないだけで同じ部屋にいる」になる。
  if (battleReady && battle.party) battle.party.splitOnBlock(req.user.id, id);
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

app.post('/api/friends/unblock', requireAuth, (req, res) => {
  migrateUser(req.user);
  unblockUser(db, req.user, String(req.body.userId || ''));
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

// 受け取りの設定。既定は「申請は誰からでも／招待はフレンドだけ」。
app.post('/api/friends/settings', requireAuth, (req, res) => {
  migrateUser(req.user);
  const b = req.body || {};
  if (['all', 'none'].includes(b.requests)) req.user.social.requests = b.requests;
  if (['friends', 'all', 'none'].includes(b.invites)) req.user.social.invites = b.invites;
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

// ---------------------------------------------------------------------------
// 🏁 ライバルボード / 🔔 挑戦状
// ---------------------------------------------------------------------------
// デイリーもウィークリーも全員が同じシード（同じピース順）なので、ここに出る
// 差はそのまま腕の差になる。読むのは既存の stats だけで、新しい保存は増やさない。

// rivalBoard の行を部門ごとの順位表にほどく。0点の人は載せない ──
// 未挑戦が「最下位」として並ぶと、遊んでいないことが晒される形になる。
function rivalSection(rows, valueOf) {
  return rows
    .filter(r => valueOf(r) > 0)
    .sort((a, b) => valueOf(b) - valueOf(a))
    .map(r => ({
      id: r.id, username: r.username, level: r.level, badges: r.badges, title: r.title,
      status: r.status, lastSeen: r.lastSeen, me: r.me,
      value: valueOf(r), score: valueOf(r), rating: r.rating,
      // 🔔 を出してよくなる時刻（送った直後は出さない）。
      cooldownUntil: r.challengedAt ? r.challengedAt + CHALLENGE_COOLDOWN_MS : 0,
    }));
}

app.get('/api/friends/board', requireAuth, (req, res) => {
  migrateUser(req.user);
  const board = rivalBoard(db, req.user, {
    dayKey: jstDayKey(), weekId: curWeek(), levelOf, statusOf: friendStatus(),
  });
  // rivalBoard は challengeOut の期限切れを掃除する（＝db を触る）ので書き戻す。
  saveDb();
  res.json({
    ...board,
    daily: rivalSection(board.rows, r => r.daily || 0),
    weekly: rivalSection(board.rows, r => r.weeklyBest || 0),
    rating: rivalSection(board.rows, r => r.rating || 0),
  });
});

// 🔔 挑戦状。定型のみで自由文は載らない（載せられると、挑戦状そのものが
// 嫌がらせの配達手段になる ── フレンド申請と同じ理屈）。
// クールダウン・上限・ブロック・フレンド判定は **すべて friends.js 側**が持つ。
// ここは日付キーを渡して、断られたらそのまま返すだけ。
app.post('/api/friends/challenge', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  if (!rateLimit('fchal:' + req.user.id, 10, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const target = userById(String((req.body || {}).userId || ''));
  if (!target) return res.status(404).json({ error: '挑戦状を送れませんでした' });
  migrateUser(target);
  const r = sendChallenge(db, req.user, target.id, jstDayKey());
  if (r.error) return res.status(409).json({ error: r.error });
  saveDb();
  // 相手が今いるなら、その場で知らせる。
  if (battleReady && battle.presence) {
    battle.presence.sendToUser(target.id, {
      type: 'announce',
      message: `🔔 ${req.user.username} から挑戦状が届きました — 今日のデイリーは ${fmtNum(r.score)}点。同じ盤面・同じピース順です`,
      messageEn: `🔔 ${req.user.username} challenged you — ${r.score.toLocaleString('en-US')} pts on today's Daily. Same board, same pieces.`,
      from: '運営',
    }, { primaryOnly: true });
  }
  res.json({
    ok: true, day: r.day, score: r.score, cleared: r.cleared,
    cooldownUntil: Date.now() + CHALLENGE_COOLDOWN_MS,
  });
});

// ---------------------------------------------------------------------------
// 👥 パーティーの通報と、運営の確認
// ---------------------------------------------------------------------------
// 新しい入れ物は作らず、既存の bugreports に kind:'party' で落とす。
// 復元がちゃんと取り込んでくれるし、管理画面もそのまま使える。
app.post('/api/party/report', requireAuth, (req, res) => {
  if (!battleReady || !battle.party) return res.status(503).json({ error: 'いまは受け付けられません' });
  if (!rateLimit('preport:' + req.user.id, 3, 600_000)) {
    return res.status(429).json({ error: '通報が多すぎます。すこし待ってください' });
  }
  const r = battle.party.report(req.user.id);
  if (r.error) return res.status(409).json({ error: r.error });
  db.bugreports = db.bugreports || [];
  db.bugreports.push({
    id: crypto.randomUUID(), kind: 'party', at: Date.now(),
    by: req.user.username, byId: req.user.id,
    text: String(req.body.reason || '').slice(0, 300),
    party: r.snapshot, status: 'open',
  });
  // 通報とバグ報告は同じ配列に積まれる。上限が 200 と 300 で食い違っていた
  // ため、201件を超えると通報1件ごとに最古の未処理バグ報告が必ず1件消えて
  // いた（`i >= 0 ? i : 0` のフォールバックが先頭＝最古を指す）。上限を揃え、
  // 捨てるのは処理済みだけにする。
  if (db.bugreports.length > BUGREPORT_CAP) {
    const doneIdx = db.bugreports.findIndex(x => x && x.status === 'done');
    if (doneIdx !== -1) {
      db.bugreports.splice(doneIdx, 1);
    } else {
      db.bugreports.pop();
      return res.status(503).json({ error: '報告箱がいっぱいです。少し時間をおいてからお願いします' });
    }
  }
  saveDb();
  res.json({ ok: true });
});

app.get('/api/mod/parties', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'mod') return res.status(403).json({ error: '権限がありません' });
  if (!battleReady || !battle.party) return res.json({ parties: [] });
  res.json({ parties: battle.party.modList() });   // 人数と合言葉だけ。本文は出さない
});

// 本文を読む窓口。読んだこと自体を記録に残す ── 非公開の会話を運営が
// 見るのなら、その操作も監査できないと約束が片手落ちになる。
app.get('/api/mod/party/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'mod') return res.status(403).json({ error: '権限がありません' });
  if (!battleReady || !battle.party) return res.status(503).json({ error: 'いまは読めません' });
  const r = battle.party.modRead(String(req.params.id), req.user.username);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json(r);
});

app.post('/api/mod/party/disband', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'mod') return res.status(403).json({ error: '権限がありません' });
  if (!battleReady || !battle.party) return res.status(503).json({ error: 'いまはできません' });
  const r = battle.party.disband(String(req.body.partyId || ''));
  if (r.error) return res.status(404).json({ error: r.error });
  adminLog(req, 'party_disband', String(req.body.partyId || ''));
  res.json({ ok: true });
});

app.get('/api/throne/shop', (req, res) => {
  const max = aeThroneMax(db);
  const user = req.user;
  const owned = user ? (user.role === 'admin' ? THRONE_ITEMS.map(i => i.id) : user.owned) : [];
  res.json({
    shards: user ? (user.shards || 0) : 0,
    throneMax: max,
    rates: AE_SHARD,
    items: THRONE_ITEMS.map(i => ({
      id: i.id, cat: i.cat, icon: i.icon || null, name: i.name, desc: i.desc,
      dan: i.dan, shards: i.shards,
      unlocked: max >= i.dan,
      owned: owned.includes(i.id),
    })),
  });
});

app.post('/api/throne/buy', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const item = THRONE_ITEMS.find(i => i.id === req.body.itemId);
  if (!item) return res.status(404).json({ error: 'そんな品はありません' });
  const user = req.user;
  if (user.owned.includes(item.id)) return res.status(409).json({ error: 'すでに持っています' });
  const max = aeThroneMax(db);
  if (max < item.dan) {
    return res.status(403).json({ error: `まだ棚に並んでいません（第${item.dan}段が割れるまで）` });
  }
  if ((user.shards || 0) < item.shards) {
    return res.status(402).json({ error: `👑 王座の欠片が足りません（${item.shards} 必要）` });
  }
  user.shards -= item.shards;
  user.owned.push(item.id);
  saveDb();
  res.json({ user: publicUser(user), got: { id: item.id, name: item.name, cat: item.cat } });
});

app.post('/api/equip', requireAuth, (req, res) => {
  const { slot, itemId } = req.body;
  if (!EQUIP_SLOTS.includes(slot)) return res.status(400).json({ error: '不正なスロットです' });
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item || item.cat !== slot) return res.status(400).json({ error: '不正なアイテムです' });
  // Admins implicitly own the entire catalog; admin gear stays admin-only.
  if (item.adminOnly) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '管理者専用の装備です' });
  } else if (req.user.role !== 'admin' && !req.user.owned.includes(itemId)) {
    return res.status(403).json({ error: '所持していないアイテムです' });
  }
  req.user.equipped[slot] = itemId;
  saveDb();
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Missions (daily / weekly)
// ---------------------------------------------------------------------------

app.get('/api/missions', requireAuth, (req, res) => {
  migrateUser(req.user);
  syncMissions(req.user, currentWeekNum());
  saveDb();
  res.json({
    missions: missionsView(req.user, currentWeekNum()),
    // 🎲 引き直しの残り回数と次の値段。missions.js に rerollMission が
    // 無い間は available:false を返し、クライアントはボタンごと隠せる。
    reroll: rerollViewOf(req.user, currentWeekNum()),
  });
});

app.post('/api/missions/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const id = String(req.body.id || '');
  const out = id === 'daily_bonus' || id === 'weekly_bonus'
    ? claimMissionBonus(req.user, currentWeekNum(), id === 'daily_bonus' ? 'daily' : 'weekly')
    : claimMission(req.user, currentWeekNum(), id);
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  res.json({
    reward: out,
    missions: missionsView(req.user, currentWeekNum()),
    user: publicUser(req.user),
  });
});

// 🎲 ミッションのリロール（引き直し）。1日の1回目は無料、以降は有料。
//
// 引き直しそのものは missions.js の rerollMission が行う ── お題のプールも、
// その日に何回使ったか（ms.rerolls[dayKey]）も、値段表も向こうが持っている。
// ここは薄い口:
//   ・呼ぶ前に何も減らさない（向こうが残高不足を見て断ってくれる）
//   ・**引き落とすのはサーバー。金額は向こうが返した cost しか信じない**
//     （クライアントの申告する値段は一切見ない）
//   ・回数の加算も向こうが済ませているので、ここでは触らない
// 保存は引き直しが成った後に1回。失敗した経路では db に触れていない。
//
// 予備の値段。rerollMission が cost を返さない実装だった場合だけ使う。
const MISSION_REROLL_COST = 500;
const MISSION_REROLL_FREE = 1;

// 画面向けの残り回数と次の値段。missions.js が rerollInfo を持っていれば
// そちらが正（値段表を知っているのは向こうなので）。無ければ簡易版で答える。
function rerollViewOf(user, weekNum) {
  const available = typeof missionsModule.rerollMission === 'function';
  if (!available) return { available: false };
  if (typeof missionsModule.rerollInfo === 'function') {
    try { return { available: true, ...missionsModule.rerollInfo(user, weekNum) }; }
    catch { /* 落ちても画面は出す */ }
  }
  return { available: true, freePerDay: MISSION_REROLL_FREE, price: MISSION_REROLL_COST };
}

app.post('/api/missions/reroll', requireAuth, maintenanceGuard, (req, res) => {
  if (!rateLimit(`reroll:${req.user.id}`, 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: '引き直しが多すぎます。少し待ってください' });
  }
  const fn = missionsModule.rerollMission;
  if (typeof fn !== 'function') {
    return res.status(501).json({ error: 'ミッションの引き直しはまだ使えません' });
  }
  migrateUser(req.user);
  const weekNum = currentWeekNum();
  syncMissions(req.user, weekNum);
  const id = String((req.body || {}).id || '').slice(0, 40);
  if (!id) return res.status(400).json({ error: 'ミッションを選んでください' });

  let out;
  try {
    out = fn(req.user, weekNum, id);
  } catch (err) {
    console.error('[missions] rerollMission が失敗:', err && err.message);
    return res.status(500).json({ error: '引き直しに失敗しました' });
  }
  if (!out || out.error) {
    const msg = (out && out.error) || 'このミッションは引き直せません';
    // 残高不足は 400（画面が「コインが足りない」を出し分けられるように）。
    return res.status(/コインが足りません/.test(msg) ? 400 : 409).json({ error: msg });
  }

  // 💰 引き落としはここでだけ行う。金額はサーバー（missions.js）が決めた値。
  // 管理者は無料（ショップ・ガチャと同じ扱い）。
  let cost = Math.max(0, Math.floor(Number(out.cost) || 0));
  if (req.user.role === 'admin') cost = 0;
  if (cost > 0) {
    if ((req.user.coins || 0) < cost) {
      // ここに来るのは、向こうの残高確認と食い違ったときだけ（本来起きない）。
      // 盤面は書き換わってしまっているので、引き直し自体は成立させ、
      // 取れるぶんだけ取る（マイナス残高は作らない）。
      console.warn(`[missions] ${req.user.username}: 引き直しの残高が不足（cost=${cost} coins=${req.user.coins}）`);
      cost = Math.max(0, req.user.coins || 0);
    }
    req.user.coins -= cost;
  }
  saveDb();
  res.json({
    missions: out.missions || missionsView(req.user, weekNum),
    user: publicUser(req.user),
    reroll: { cost, scope: out.scope || null, from: out.from || id, to: out.to || null, ...rerollViewOf(req.user, weekNum) },
  });
});

// ---------------------------------------------------------------------------
// Achievements (実績)
// ---------------------------------------------------------------------------

app.get('/api/achievements', (req, res) => {
  if (!req.user) {
    // Guests still get to browse the list (progress reads as zero).
    return res.json({ achievements: achievementsView({ stats: {}, badges: [], owned: [], achievements: [], coins: 0, xp: 0 }) });
  }
  migrateUser(req.user);
  res.json({ achievements: achievementsView(req.user) });
});

app.post('/api/achievements/claim', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const out = claimAchievement(req.user, String(req.body.id || ''));
  if (out.error) return res.status(409).json({ error: out.error });
  saveDb();
  // The rarest achievements are worth a line on the feed.
  const top = ACHIEVEMENTS.filter(a => out.ids.includes(a.id)).sort((a, b) => b.gems - a.gems)[0];
  if (top && top.gems >= 15) {
    postRealFeed(req.user, [{ icon: top.icon, ja: `${req.user.username} が実績「${top.name}」を解除！`, en: `${req.user.username} unlocked "${top.nameEn}"!` }]);
  }
  res.json({ reward: out, achievements: achievementsView(req.user), user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Battle pass
// ---------------------------------------------------------------------------

app.get('/api/battlepass', (req, res) => {
  settleSeasonHallOfFame();   // 🏛 シーズンの切替はここでも拾う
  res.json({
    season: currentSeason(),
    tiers: BP_TIERS,
    xpPerTier: BP_XP_PER_TIER,
    premiumPriceGems: BP_PREMIUM_PRICE_GEMS,
    progress: req.user ? syncBattlePass(req.user) : null,
  });
});

app.post('/api/battlepass/premium', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  if (bp.premium) return res.status(409).json({ error: 'すでにプレミアムです' });
  if (user.gems < BP_PREMIUM_PRICE_GEMS) return res.status(402).json({ error: 'ジェムが足りません' });
  user.gems -= BP_PREMIUM_PRICE_GEMS;
  bp.premium = true;
  saveDb();
  res.json({ user: publicUser(user) });
});

app.post('/api/battlepass/claim', requireAuth, maintenanceGuard, (req, res) => {
  const user = req.user;
  const bp = syncBattlePass(user);
  const tierNum = Math.floor(Number(req.body.tier));
  const track = req.body.track === 'premium' ? 'premium' : 'free';
  const tierDef = BP_TIERS.find(t => t.tier === tierNum);
  if (!tierDef) return res.status(404).json({ error: 'ティアが見つかりません' });
  const reward = tierDef[track];
  if (!reward) return res.status(400).json({ error: '報酬がありません' });
  if (track === 'premium' && !bp.premium) return res.status(403).json({ error: 'プレミアムパスが必要です' });
  const unlockedTier = Math.floor(bp.xp / BP_XP_PER_TIER);
  if (tierNum > unlockedTier) return res.status(403).json({ error: 'まだ解放されていません' });
  const key = `${tierNum}:${track}`;
  if (bp.claimed.includes(key)) return res.status(409).json({ error: '受け取り済みです' });

  bp.claimed.push(key);
  if (reward.type === 'coins') user.coins += reward.amount;
  else if (reward.type === 'gems') user.gems += reward.amount;
  else if (reward.type === 'item') { if (!user.owned.includes(reward.id)) user.owned.push(reward.id); }
  else if (reward.type === 'badge') { if (!user.badges.includes(reward.id)) user.badges.push(reward.id); }
  saveDb();
  res.json({ user: publicUser(user), reward });
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, role: u.role, banned: u.banned, muted: !!u.muted,
    coins: u.coins, gems: u.gems, level: levelOf(u.xp),
    stats: u.stats, createdAt: u.createdAt,
  }));
  res.json({ users });
});

// 🎒 インベントリ編集 — one screen with everything an admin can put back.
//
// The list endpoint above deliberately stays light (it renders every account),
// so the editor asks for one player in full, plus the catalogue it needs to
// draw checkboxes for. Without this the client would have to guess what exists.
// The RAW record as the editor needs to see it. Deliberately not publicUser():
// that one hands admins the entire shop and infinite currency as a display
// fiction, which the editor must never read back as fact.
function adminUserView(u) {
  return {
    id: u.id, username: u.username, role: u.role,
    banned: !!u.banned, muted: !!u.muted,
    coins: u.coins, gems: u.gems, xp: u.xp, level: levelOf(u.xp),
    items: u.items || {}, owned: u.owned || [], equipped: u.equipped || {},
    equippedTitle: u.equippedTitle || null,
    badges: u.badges || [], achievements: u.achievements || [],
    battlePass: u.battlePass || null,
    createdAt: u.createdAt,
    guildId: u.guildId || null,
    guildName: u.guildId && db.guilds[u.guildId] ? db.guilds[u.guildId].name : null,
    stats: u.stats,
  };
}

app.get('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  migrateUser(u);
  res.json({
    user: adminUserView(u),
    catalog: {
      shop: SHOP_ITEMS.map(i => ({ id: i.id, cat: i.cat, name: i.name, icon: i.icon || null, adminOnly: !!i.adminOnly, gachaOnly: !!i.gachaOnly })),
      boosters: BOOST_ITEMS.map(i => ({ id: i.id, name: i.name, icon: i.icon, adminOnly: !!i.adminOnly })),
      slots: EQUIP_SLOTS,
      titles: TITLES.map(t => ({ id: t.id, name: t.name, color: t.color })),
      badges: ADMIN_KNOWN_BADGES,
      // Only these stats are hand-editable. Everything else is a running total
      // the game maintains, and editing it just makes the numbers lie.
      stats: EDITABLE_STATS,
    },
  });
});

// The stats an admin can sensibly restore. Anything derived (level from xp,
// titles from stats, achievement progress) is deliberately absent — those
// recompute themselves from what is set here.
const EDITABLE_STATS = [
  { key: 'bestScore', label: 'ハイスコア', max: 100_000_000 },
  { key: 'rating', label: 'レート', max: 5000 },
  { key: 'gamesPlayed', label: 'プレイ回数', max: 1_000_000 },
  { key: 'totalScore', label: '累計スコア', max: 1_000_000_000 },
  { key: 'totalLines', label: '累計ライン', max: 10_000_000 },
  { key: 'maxCombo', label: '最大コンボ', max: 999 },
  { key: 'pvpWins', label: 'PvP勝利', max: 1_000_000 },
  { key: 'pvpLosses', label: 'PvP敗北', max: 1_000_000 },
  { key: 'dungeonMax', label: '塔 最高階', max: 100 },
  { key: 'underMax', label: '地下 最高階', max: 100 },
  { key: 'heavenMax', label: '天国 最高階', max: 100 },
  { key: 'abyssMax', label: '深淵 最高階', max: 100 },
  { key: 'bossMax', label: 'ボス討伐数', max: 6 },
  { key: 'puzzleStage', label: 'パズル遺跡ステージ', max: 9999 },
  { key: 'digDepth', label: '採掘深度', max: 9999 },
  { key: 'survivalWave', label: 'サバイバルWAVE', max: 999 },
  { key: 'loginStreakBest', label: '最長連続ログイン', max: 3650 },
  // 順位なので 1 が最高。0 は「記録なし」を意味するので下限は 0 のまま。
  { key: 'royaleBest', label: 'ロイヤル最高順位（0=記録なし）', max: 100 },
  { key: 'royaleKills', label: 'ロイヤル通算KO', max: 1_000_000 },
];

const ADMIN_KNOWN_BADGES = ['bronze', 'silver', 'gold', 'oni', 'kami', 'souzou', 'maou', 'rush', 'dungeon', 'tourney', 'royale', 'adminevent', 'abyss', 'under', 'heaven', 'zero', 'weekly1', 'puzzle', 'dig', 'crown2', 'crown3', 'crown5', 'crown7', 'ghost', 'daily7', 'guildquest'];

app.post('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = userById(req.params.id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  // Repair FIRST, not last: the branches below assume a complete record, and a
  // legacy or restored one could make them throw a 500 or write NaN before the
  // repair at the end of the handler ever ran.
  migrateUser(target);
  const b = req.body || {};
  // `typeof v === 'number'` lets Infinity through — JSON.parse('1e400') is
  // Infinity, and `coins + Infinity` serialises to null, which permanently
  // corrupts that account.
  const delta = (v, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.max(-max, Math.min(max, Math.trunc(v)));
  };
  // これらの「即時適用」系(grant*/権限/パスワード/称号など)は、以前は検証の
  // 直後にその場で target を書き換えていた。ところが後段の set*(絶対値設定)は
  // 「全部検証してから適用」する設計で、後段が1つでも400を投げると、既に
  // 書き換わった grant* の変更がメモリ上の db.users[id] に残り、当該リクエストは
  // 保存されないものの次の saveDb()(他リクエスト)がその半端な変更を焼き付けて
  // しまった(管理者は『エラー＝何も起きていない』と誤認)。そこで即時適用系も
  // 検証だけ先に済ませ、実際の書き換えは applies に積み、set* の検証まで全て
  // 通ってから一括適用する。これで経路全体が set* と同じ「全検証→適用」の
  // 不変条件を満たし、後段の400が grant* を残さない。
  const applies = [];
  // set* の管理者専用チェックは、同じリクエストで role を変えるならその新しい
  // role を見る必要がある(従来は role を即時適用してから set* を検証していた)。
  // 適用を後回しにするので、検証時に見るべき「実効 role」をここで確定しておく。
  const roleValid = ['admin', 'mod', 'user'].includes(b.role);
  const effectiveRole = roleValid ? b.role : target.role;
  if (b.grantCoins !== undefined) {
    const n = delta(b.grantCoins, 1_000_000_000);
    if (n === null) return res.status(400).json({ error: 'コイン付与額が不正です' });
    applies.push(() => { target.coins = Math.max(0, Math.min(1_000_000_000, target.coins + n)); });
  }
  if (b.grantGems !== undefined) {
    const n = delta(b.grantGems, 100_000_000);
    if (n === null) return res.status(400).json({ error: 'ジェム付与額が不正です' });
    applies.push(() => { target.gems = Math.max(0, Math.min(100_000_000, target.gems + n)); });
  }
  // 👑 王座の欠片。イベントの外では増えないので、配れるのは運営だけ。
  // 上限を低めに置いてあるのは、この通貨は「量」ではなく「どこで得たか」に
  // 意味がある通貨だから ── 配りすぎると宝物庫の意味が消える。
  if (b.grantShards !== undefined) {
    const n = delta(b.grantShards, 1_000_000);
    if (n === null) return res.status(400).json({ error: '欠片付与数が不正です' });
    applies.push(() => { target.shards = Math.max(0, Math.min(1_000_000, (target.shards || 0) + n)); });
  }
  if (b.grantItems !== undefined) {
    // grant N of every booster (negative to confiscate)
    const n = delta(b.grantItems, 999);
    if (n === null) return res.status(400).json({ error: 'アイテム付与数が不正です' });
    applies.push(() => {
      target.items = target.items || {};
      for (const it of BOOST_ITEMS) target.items[it.id] = Math.max(0, Math.min(999, (target.items[it.id] || 0) + n));
    });
  }
  if (typeof b.banned === 'boolean') {
    if (target.role === 'admin' && b.banned) return res.status(400).json({ error: '管理者は凍結できません' });
    applies.push(() => { target.banned = b.banned; });
  }
  if (typeof b.muted === 'boolean') {
    if ((target.role === 'admin' || target.role === 'mod') && b.muted) {
      return res.status(400).json({ error: '運営メンバーはミュートできません' });
    }
    applies.push(() => { target.muted = b.muted; });
  }
  if (typeof b.setPassword === 'string') {
    if (b.setPassword.length < 6) return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
    const { salt, hash } = hashPassword(b.setPassword);
    applies.push(() => {
      target.salt = salt;
      target.passHash = hash;
      // force re-login everywhere with the new password
      revokeAllTokens(target.id);
    });
  }
  const KNOWN_BADGES = ADMIN_KNOWN_BADGES;   // 一箇所で管理（編集画面と同じ一覧）
  if (typeof b.grantBadge === 'string') {
    if (!KNOWN_BADGES.includes(b.grantBadge)) return res.status(400).json({ error: `バッジIDが不正です（${KNOWN_BADGES.join(' / ')}）` });
    applies.push(() => { if (!target.badges.includes(b.grantBadge)) target.badges.push(b.grantBadge); });
  }
  if (typeof b.revokeBadge === 'string') {
    applies.push(() => { target.badges = target.badges.filter(x => x !== b.revokeBadge); });
  }
  if (typeof b.setRating === 'number') applies.push(() => { target.stats.rating = Math.max(0, Math.min(5000, Math.floor(b.setRating))); });
  if (typeof b.setLevel === 'number') {
    // levelOf(xp) = 1 + floor(xp/1000)  →  xp for level L is (L-1)*1000
    const lv = Math.max(1, Math.min(999, Math.floor(b.setLevel)));
    applies.push(() => { target.xp = (lv - 1) * 1000; });
  }
  if (roleValid) {
    if (target.id === req.user.id && b.role !== 'admin') {
      return res.status(400).json({ error: '自分の権限は下げられません（別の管理者に依頼してください）' });
    }
    applies.push(() => { target.role = b.role; });
  }
  if (b.resetStats === true) {
    applies.push(() => { target.stats = { gamesPlayed: 0, bestScore: 0, totalScore: 0, totalLines: 0, maxCombo: 0, aiWins: 0, pvpWins: 0, pvpLosses: 0, rating: 1000 }; });
  }

  // ---- 🎒 インベントリ編集（絶対値で設定する系） ----
  //
  // The grant* fields above ADD; these SET. Two rules make this safe enough to
  // expose in a browser:
  //
  //  1. VALIDATE EVERYTHING FIRST, then apply. Writing as we validated meant a
  //     later field's 400 left the earlier fields already written to the live
  //     record, and the next saveDb() persisted that half-applied edit while
  //     the admin saw an error and assumed nothing happened.
  //  2. Reject rather than coerce. `Number(null)` is 0, so a stray null in the
  //     JSON used to silently wipe a player's currency and answer ok:true.
  const patch = {};
  const intIn = (v, max, min = 0) => {
    if (typeof v === 'string' ? v.trim() === '' : typeof v !== 'number') return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
  };
  const bad = msg => { throw Object.assign(new Error(msg), { userError: true }); };

  try {
    if (b.setCoins !== undefined) {
      const n = intIn(b.setCoins, 1_000_000_000);
      if (n === null) bad('コインの値が不正です');
      patch.coins = n;
    }
    if (b.setGems !== undefined) {
      const n = intIn(b.setGems, 100_000_000);
      if (n === null) bad('ジェムの値が不正です');
      patch.gems = n;
    }
    // setLevel rounds XP down to the floor of that level, which throws away
    // partial progress — setXp restores the exact value.
    if (b.setXp !== undefined) {
      const n = intIn(b.setXp, 998_000);
      if (n === null) bad('XPの値が不正です');
      patch.xp = n;
    }

    if (b.setItems !== undefined) {
      if (!b.setItems || typeof b.setItems !== 'object' || Array.isArray(b.setItems)) bad('アイテムの指定が不正です');
      const known = new Map(BOOST_ITEMS.map(i => [i.id, i]));
      const next = {};
      for (const [id, v] of Object.entries(b.setItems)) {
        const def = known.get(id);
        if (!def) bad(`不明なアイテムです: ${String(id).slice(0, 32)}`);
        if (def.adminOnly && effectiveRole !== 'admin') bad('管理者専用アイテムは付与できません');
        const n = intIn(v, 999);
        if (n === null) bad(`アイテム個数が不正です: ${id}`);
        if (n > 0) next[id] = n;
      }
      patch.items = next;
    }

    // Owned cosmetics. The defaults are always re-added so a player can never
    // be left with nothing equippable.
    if (b.setOwned !== undefined) {
      if (!Array.isArray(b.setOwned)) bad('所持品の指定が不正です');
      const known = new Map(SHOP_ITEMS.map(i => [i.id, i]));
      for (const id of b.setOwned) {
        const it = known.get(id);
        if (!it) bad(`不明なアイテムです: ${String(id).slice(0, 32)}`);
        if (it.adminOnly && effectiveRole !== 'admin') bad('管理者専用の装備は付与できません');
      }
      patch.owned = [...new Set([...DEFAULT_OWNED, ...b.setOwned])];
    }

    // Equipping something the player does not own renders as a blank board, so
    // this is checked against the owned list AFTER any change in this same
    // request — not the stale one.
    if (b.setEquipped !== undefined) {
      if (!b.setEquipped || typeof b.setEquipped !== 'object' || Array.isArray(b.setEquipped)) bad('装備の指定が不正です');
      const owned = new Set(patch.owned || target.owned || []);
      const next = { ...(target.equipped || {}) };
      for (const [slot, id] of Object.entries(b.setEquipped)) {
        if (!EQUIP_SLOTS.includes(slot)) bad(`不明な装備スロットです: ${String(slot).slice(0, 16)}`);
        const item = SHOP_ITEMS.find(i => i.id === id);
        if (!item || item.cat !== slot) bad(`${slot} に装備できないアイテムです`);
        if (!owned.has(id)) bad('所持していないアイテムは装備できません（先に所持品に追加してください）');
        next[slot] = id;
      }
      patch.equipped = next;
    }

    if (b.setTitle !== undefined) {
      if (b.setTitle === null || b.setTitle === '') patch.equippedTitle = null;
      else if (!TITLES.some(t => t.id === b.setTitle)) bad('不明な称号です');
      else patch.equippedTitle = b.setTitle;
    }

    if (b.setBadges !== undefined) {
      if (!Array.isArray(b.setBadges)) bad('バッジの指定が不正です');
      for (const id of b.setBadges) {
        // 🏛 シーズン刻印バッジ（s3champ 等）はシーズンごとに増えるので、
        // 固定の一覧ではなく形で許可する。ここで弾いていると、殿堂入りした
        // アカウントを編集した瞬間に「不明なバッジです」で保存できなくなる。
        if (!ADMIN_KNOWN_BADGES.includes(id) && !SEASON_BADGE_RE.test(String(id))) {
          bad(`不明なバッジです: ${String(id).slice(0, 32)}`);
        }
      }
      patch.badges = [...new Set(b.setBadges)];
    }

    // A premium battle pass was PAID for with gems, so restoring an account
    // has to be able to give it back. The season is not editable: it must stay
    // whatever currentSeason() says, or syncBattlePass wipes the record.
    if (b.setPass !== undefined) {
      if (!b.setPass || typeof b.setPass !== 'object' || Array.isArray(b.setPass)) bad('バトルパスの指定が不正です');
      const bp = { ...(target.battlePass || {}) };
      if (b.setPass.xp !== undefined) {
        const n = intIn(b.setPass.xp, BP_TIERS.length * BP_XP_PER_TIER);
        if (n === null) bad('バトルパスXPの値が不正です');
        bp.xp = n;
      }
      if (b.setPass.premium !== undefined) {
        if (typeof b.setPass.premium !== 'boolean') bad('プレミアムの指定が不正です');
        bp.premium = b.setPass.premium;
      }
      patch.battlePass = bp;
    }

    if (b.setStats !== undefined) {
      if (!b.setStats || typeof b.setStats !== 'object' || Array.isArray(b.setStats)) bad('統計の指定が不正です');
      const next = {};
      for (const [key, v] of Object.entries(b.setStats)) {
        const def = EDITABLE_STATS.find(s => s.key === key);
        if (!def) bad(`編集できない項目です: ${String(key).slice(0, 32)}`);
        const n = intIn(v, def.max, def.min || 0);
        if (n === null) bad(`${def.label} の値が不正です`);
        next[key] = n;
      }
      patch.stats = next;
    }
  } catch (err) {
    if (err && err.userError) return res.status(400).json({ error: err.message });
    throw err;
  }

  // ---- everything validated: apply ----
  // 即時適用系(grant*/権限/パスワード等)を先に流す。set* の絶対値はこの後に
  // 上書き適用されるので、両方が来たときは従来どおり set* が勝つ。
  for (const fn of applies) fn();
  for (const k of ['coins', 'gems', 'xp', 'items', 'owned', 'equippedTitle', 'badges', 'battlePass']) {
    if (patch[k] !== undefined) target[k] = patch[k];
  }
  if (patch.equipped) target.equipped = patch.equipped;
  if (patch.stats) {
    target.stats = target.stats || {};
    Object.assign(target.stats, patch.stats);
  }

  // Reconcile the equipped-must-be-owned invariant no matter WHICH field moved:
  // dropping an item from the owned list while it was equipped used to leave
  // the player staring at a board that renders nothing.
  target.owned = target.owned || [];
  for (const slot of EQUIP_SLOTS) {
    const cur = target.equipped && target.equipped[slot];
    const item = SHOP_ITEMS.find(i => i.id === cur);
    if (!item || item.cat !== slot || !target.owned.includes(cur)) {
      target.equipped = target.equipped || {};
      target.equipped[slot] = DEFAULT_EQUIPPED[slot];
    }
  }

  // Leave the record in a shape the rest of the server can read.
  migrateUser(target);
  adminLog(req, 'user_edit', target.username, b);
  saveDb();
  // NOT publicUser(): for an admin target that view fakes the entire shop as
  // owned, and echoing it back would let the editor write that fiction in.
  res.json({ ok: true, user: adminUserView(target) });
});


app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = userById(req.params.id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin') return res.status(400).json({ error: '管理者は削除できません' });
  revokeAllTokens(req.params.id);
  adminLog(req, 'user_delete', target.username, { id: req.params.id });
  leaveGuild(db, target);   // same reason as DELETE /api/me — before the record goes
  unfriendAll(db, target);  // フレンド側も同じ（DELETE /api/me と同じ理由）
  if (battleReady && battle.party) battle.party.ejectUser(target.id);
  if (Object.prototype.hasOwnProperty.call(db.users, String(req.params.id))) delete db.users[String(req.params.id)];
  db.deleted[req.params.id] = Date.now();
  saveDb();
  res.json({ ok: true });
});

// Force a brand-new season starting now (everyone's battle pass resets — that
// is the point of this button). Implemented as an override generation bump so
// it survives redeploys via the backup's meta.
app.post('/api/admin/season/new', requireAuth, requireAdmin, (req, res) => {
  const cur = currentSeason();
  const idx = derivedSeasonIndex();
  const o = db.meta.seasonOverride || {};
  db.meta.seasonOverride = {
    baseIndex: idx,
    gen: (o.gen || 0) + 1,
    numberOffset: (cur.number + 1) - idx,
    name: sanitizeName(req.body.name) || null,
    startedAt: Date.now(),
    endsAt: Date.now() + SEASON_MS,
  };
  saveDb();
  res.json({ season: currentSeason() });
});

// Change the current season — supports reverting the number/name WITHOUT
// resetting everyone's battle pass progress (keepProgress, default true).
app.post('/api/admin/season/set', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const cur = currentSeason();
  const number = Math.max(1, Math.min(999, Math.floor(Number(b.number) || cur.number)));
  const name = sanitizeName(b.name) || null;
  const days = Math.max(1, Math.min(365, Math.floor(Number(b.days) || 0)));
  const keepProgress = b.keepProgress !== false;
  const effIdx = Number(cur.id.slice(1).split('-')[0]) || derivedSeasonIndex();
  const o = db.meta.seasonOverride || {};
  db.meta.seasonOverride = {
    baseIndex: effIdx,
    gen: (o.gen || 0) + (keepProgress ? 0 : 1),
    numberOffset: number - effIdx,
    name,
    startedAt: keepProgress ? (o.startedAt || cur.startedAt) : Date.now(),
    // Only pin an endsAt when the admin actually chose a duration — otherwise
    // stay on the natural 30-day grid so seasons keep rolling on schedule.
    endsAt: b.days ? Date.now() + days * 24 * 60 * 60 * 1000 : (keepProgress ? (o.endsAt || null) : Date.now() + SEASON_MS),
  };
  saveDb();
  res.json({ season: currentSeason(), progressKept: keepProgress });
});

// Reset competitive stats for all users (scores, ratings, PvP records).
app.post('/api/admin/leaderboard/reset', requireAuth, requireAdmin, (req, res) => {
  adminLog(req, 'leaderboard_reset', null, {});
  let count = 0;
  for (const u of Object.values(db.users)) {
    u.stats.bestScore = 0;
    u.stats.totalScore = 0;
    u.stats.rating = 1000;
    u.stats.pvpWins = 0;
    u.stats.pvpLosses = 0;
    count++;
  }
  saveDb();
  res.json({ ok: true, affected: count });
});

// Full database backup download.
app.get('/api/admin/backup', requireAuth, requireAdmin, (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="block-blitz-backup-${stamp}.json"`);
  // Stamp the dump so the restore dialog can show when it was taken.
  res.json({ ...db, meta: { ...db.meta, backupAt: Date.now(), backupVersion: BACKUP_VERSION } });
});

// Restore a backup file. Defaults to a merge so players who signed up after a
// data loss are not thrown away; the live DB is snapshotted first either way.
// Two ways in: a logged-in admin, OR anyone holding the backup file who can
// prove they know the admin password *inside that backup*. The second path is
// what makes a post-wipe restore painless — after a redeploy the fresh
// instance has a brand-new admin password nobody knows yet.
app.post('/api/admin/restore', (req, res) => {
  const body = req.body || {};
  const data = body.data || body;          // accept a bare dump or { data, mode }
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const check = validateBackup(data);
  if (!check.ok) return res.status(400).json({ error: check.error });

  // Authorisation, in three tiers.
  //
  // This endpoint is deliberately reachable without a session: the whole point
  // of /?restore=1 is to recover a server nobody can log into. But it used to
  // accept ANY uploaded file whose own admin hash matched the typed password —
  // and the attacker supplies that file, so they supply the hash too. Anyone
  // who could reach the URL could overwrite a live server with a forged dump.
  //
  //   1. a signed-in admin                          → always allowed
  //   2. the password of a LIVE admin account       → allowed
  //   3. the password of the FILE's admin           → only onto a server with
  //      no player data yet, and merge only. That is exactly the post-deploy
  //      wipe this flow exists for, and it is worthless to an attacker because
  //      there is nothing there to take over.
  let actor = req.user && req.user.role === 'admin' ? { username: req.user.username } : null;
  // ファイル内パスワードで通した復元では、生きているアカウントの
  // パスワード・権限をファイル側に奪わせない（下の applyRestore へ渡す）。
  let protectLiveCredentials = false;
  if (!actor) {
    if (!rateLimit(`restore:${req.ip}`, 10, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
    }
    const pw = String(body.password || '');
    if (!pw) return res.status(401).json({ error: '管理者パスワードを入力してください' });

    const liveAdmins = Object.values(db.users).filter(u => u.role === 'admin').slice(0, 8);
    const liveMatch = liveAdmins.find(u => verifyPassword(pw, u.salt, u.passHash));
    if (liveMatch) {
      actor = { username: liveMatch.username };
    } else {
      // 🔒 第3層は「まだ誰も居ないサーバー」専用。
      //
      // 上のコメントはずっとそう書いてあったのに、その判定がコードに存在して
      // いなかった。実際に効いていたのは mode !== 'merge' だけで、稼働中の
      // 本番に対しても第3層が通っていた。ファイル内のパスワードは
      // **アップロードする側が決められる**ので、これは事実上「誰でも通る認証」
      // だった。監査で、未認証の1リクエストで管理者アカウントを奪取できることが
      // 実サーバー上で再現されている。
      //
      // この経路が本当に必要なのは「再デプロイでデータが飛び、誰もログイン
      // できないサーバーを復旧する」場面だけ。そこにはまだ守るべきものが無い。
      const realPlayers = Object.values(db.users).filter(u => u.role !== 'admin').length;
      if (realPlayers > 0) {
        console.warn(`[restore] 拒否(第3層/稼働中): ip=${req.ip} 既存プレイヤー${realPlayers}人`);
        return res.status(401).json({
          error: 'このサーバーには既にプレイヤーデータがあります。現在の管理者パスワードを入力してください',
        });
      }

      // 照合1回につき pbkdf2 が約13ms かかり、その間サーバーは他の処理を
      // 一切できない（Node は1本の処理列で動く）。管理者を大量に詰めた
      // ファイルを1回投げるだけで数分〜十数分の完全停止を作れた。
      // 正規のバックアップに管理者が何十人も入ることはないので、頭を打たせる。
      const fileAdmins = Object.values(data.users).filter(u => u.role === 'admin').slice(0, 8);
      const fileMatch = fileAdmins.find(u => verifyPassword(pw, u.salt, u.passHash));
      // `replace` destroys whatever is live. Doing that needs the CURRENT
      // password, not one supplied inside the file being uploaded.
      if (!fileMatch || mode !== 'merge') {
        console.warn(`[restore] 拒否: ip=${req.ip} mode=${mode} fileMatch=${!!fileMatch}`);
        return res.status(401).json({ error: !fileAdmins.length
          ? 'このバックアップに管理者アカウントが含まれていません'
          : mode !== 'merge'
            ? '置き換え復元には現在の管理者パスワードが必要です（マージ復元は可能です）'
            : 'バックアップ内の管理者パスワードが違います（バックアップを取った時点のパスワードを入力してください）' });
      }
      actor = { username: fileMatch.username, fromBackup: true };
      // The password that authorised this came out of the uploaded file, so the
      // uploader controls it — and therefore must not be able to hand
      // themselves staff.
      //
      // 以前は「この機体に既に居るスタッフと同じ名前なら降格しない」だったが、
      // 管理者名は公開情報（クレジット画面・チャットの🛡️）なので、
      // その名前を騙るだけで admin のまま取り込ませることができた。
      // ファイル由来の昇格は一切認めない — 例外を作らない。
      let demoted = 0;
      for (const u of Object.values(data.users)) {
        if (u.role === 'admin' || u.role === 'mod') { u.role = 'user'; demoted++; }
      }
      if (demoted) console.warn(`[restore] バックアップ内の管理者/モデレーター ${demoted}件を一般ユーザーとして取り込みました`);
      // 生きているアカウントの資格情報を、ファイル側で上書きさせない。
      // merge の勝敗判定(progressOf)は進行度で決まるので、巨大な stats を
      // 積んだ偽レコードを送れば本物に勝ててしまう。ここで守る。
      protectLiveCredentials = true;
    }
  }

  // Dry run: let the admin see what would happen before committing.
  // 下見。以前は管理者名（誰のパスワードが当たったか）まで返していたので、
  // 未ログインからパスワードの当たり判定と管理者名の両方を引き出せた。
  // 名前は返さず、記録も残す。
  if (body.dryRun) {
    adminLog(req, 'restore-dryrun', actor.username, { mode, fromBackup: !!actor.fromBackup, users: check.stats.users });
    return res.json({ preview: check.stats, mode });
  }

  adminLog(req, 'restore', actor.username, { mode, fromBackup: !!actor.fromBackup, users: check.stats.users });
  const snap = snapshot(db, 'pre-restore');
  let report;
  // applyRestore は db をその場で書き換える。途中で落ちると「変更は保存されて
  // いません」と返しながら、実際には半分マージされた db がメモリに残り、次の
  // saveDb() でそれがディスクに焼かれてしまう。丸ごと退避してから実行する。
  const rollback = structuredClone(db);
  // ロールバックの内側には「db を書き換えうる処理」を全部入れる。
  // applyRestore だけを囲っていたころ、そのすぐ下の migrateUser / healSocial /
  // adoptLegacySeason が同じ db を触っているのに保護の外にあった。壊れた
  // レコード（例: stats が文字列）が1件混ざるだけで migrateUser が投げ、
  // 上のコメントが警告しているとおりの事故 ──「保存されていません」と返し
  // ながら半端にマージされた db がメモリに残り、次の saveDb() でディスクへ ──
  // がそのまま起きていた。
  try {
    report = applyRestore(db, data, mode, { protectLiveCredentials });
    // Every restored account is brought up to the current schema right away.
    for (const u of Object.values(db.users)) migrateUser(u);
    // 🤝 復元のあとは必ず均す。名前で照合したときに id が入れ替わるので、
    // 付け替えの取りこぼし・片側だけになった関係・消えた相手への申請が残る。
    // 起動時に一度やるだけでは、復元で作った歪みはその起動の間ずっと残る。
    healSocial(db);
    // Battle passes minted under the old UUID-season scheme carry over, and the
    // restored world state (crowd scale, ambient config) takes effect now.
    adoptLegacySeason(data.season);
    db.season = null;
  } catch (err) {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, rollback);          // db.js が同じ参照を握っているので in-place で戻す
    console.error('[restore] failed:', err);
    return res.status(500).json({ error: '復元中にエラーが発生しました。変更は保存されていません' });
  }
  setLiveScale(db.meta.popScale ?? 1);
  setCustom(db.meta.ambient);
  // 書けたかどうかを見る。以前は戻り値を捨てていたので、ディスクに1バイトも
  // 書けていなくても「💾 データを復元しました」と返していた。メモリ上は
  // 復元済みなので画面は正しく見えるが、次の再起動で全部消える ── 復元を
  // する場面はたいてい「一度データを失った直後」なので、これがいちばん
  // 誤解させてはいけない場所だった。
  if (!flushDb()) {
    console.error('[restore] メモリには適用したが保存に失敗:', lastPersistError());
    return res.status(500).json({
      error: `復元はメモリ上に適用しましたが、ディスクに保存できませんでした（${lastPersistError() || '原因不明'}）。この状態で再起動すると失われます`,
      report,
    });
  }
  console.log(`[restore] ${mode} by ${actor.username}${actor.fromBackup ? ' (backup password)' : ''}: +${report.added} 更新${report.updated} 維持${report.kept} → 合計${report.after}人`);
  battle.broadcastAll({
    type: 'announce',
    message: '💾 データを復元しました。ページを再読み込みすると反映されます',
    messageEn: '💾 Data restored — reload the page to see it',
    from: actor.username,
  });
  // 第3層（ファイル内の管理者パスワードで通す復旧経路）では、絶対にトークンを
  // 発行しない。
  //
  // ここは以前「復元した管理者アカウントでそのままログインさせる」親切をして
  // いた。ところが第3層で照合しているパスワードは **アップロードした側が自分で
  // 決めたもの**（ファイルの中の salt/passHash）なので、実質「誰でも名乗れる」。
  // プレイヤー0人のサーバー（＝再デプロイ直後）に、管理者名を騙る偽レコードを
  // 1件入れた未認証リクエストを投げるだけで、有効期限1年の管理者トークンが
  // 手に入っていた。監査で実機再現済み — そのまま /api/admin/backup を叩けば
  // 全ユーザーの salt+passHash が抜ける。
  //
  // 復旧の目的は「データを戻すこと」であって「ログインさせること」ではない。
  // 正規の持ち主は、戻したあとログイン画面から現在の管理者パスワードで入れる
  // （同名で衝突した管理者の資格情報は、生きている側＝この機体のものが残る）。
  // relogin: 復旧経路で来た人に「もう一度ログインしてください」と出すための印。
  res.json({ report, snapshot: snap, source: check.stats, token: null, user: null, relogin: !!actor.fromBackup });
});

// Local snapshots (same instance only — they die with the filesystem too).
app.get('/api/admin/snapshots', requireAuth, requireAdmin, (_req, res) => {
  res.json({ snapshots: listSnapshots() });
});

app.post('/api/admin/snapshots/restore', requireAuth, requireAdmin, (req, res) => {
  const data = readSnapshot(String(req.body.name || ''));
  if (!data) return res.status(404).json({ error: 'スナップショットが見つかりません' });
  const check = validateBackup(data);
  if (!check.ok) return res.status(400).json({ error: check.error });
  // 戻り値を捨てない。撮れなかったとき（ディスクが一杯・権限が無い等）に
  // 黙って進むと、「巻き戻したが、その前の状態はもうどこにも無い」という
  // 取り返しのつかない状態になる。画面に警告を出せるよう応答に載せる。
  const snap = snapshot(db, 'pre-rollback');
  // /api/admin/restore と同じ理由で丸ごと退避する。applyRestore は db を
  // その場で書き換えるので、途中で落ちると半端な db がメモリに残り、
  // 次の saveDb() でディスクに焼かれる。この経路だけ保護が無かった。
  const rollback = structuredClone(db);
  let report;
  try {
    report = applyRestore(db, data, 'replace');
    for (const u of Object.values(db.users)) migrateUser(u);
    // 🤝 復元のあとは必ず均す（下の2か所と同じ理由）。
    healSocial(db);
  } catch (err) {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, rollback);        // db.js が同じ参照を握っているので in-place で戻す
    console.error('[snapshot-restore] failed:', err);
    return res.status(500).json({ error: '復元中にエラーが発生しました。変更は保存されていません' });
  }
  adoptLegacySeason(data.season);
  db.season = null;
  setLiveScale(db.meta.popScale ?? 1);
  setCustom(db.meta.ambient);
  if (!flushDb()) {
    console.error('[snapshot-restore] メモリには適用したが保存に失敗:', lastPersistError());
    return res.status(500).json({
      error: `復元はメモリ上に適用しましたが、ディスクに保存できませんでした（${lastPersistError() || '原因不明'}）。この状態で再起動すると失われます`,
      report,
    });
  }
  res.json({ report, snapshot: snap });
});

app.post('/api/admin/snapshots/create', requireAuth, requireAdmin, (_req, res) => {
  const name = snapshot(db, 'manual');
  if (!name) return res.status(500).json({ error: 'スナップショットの作成に失敗しました' });
  res.json({ name, snapshots: listSnapshots() });
});

// Maintenance mode: blocks play/shop/login for non-admins.
app.post('/api/admin/maintenance', requireAuth, requireAdmin, (req, res) => {
  db.meta.maintenance = !!req.body.on;
  saveDb();
  battle.broadcastAll({
    type: 'announce',
    message: db.meta.maintenance ? '🛠 まもなくメンテナンスを開始します' : '✅ メンテナンスが終了しました',
    messageEn: db.meta.maintenance ? '🛠 Maintenance is starting shortly' : '✅ Maintenance is over',
    from: req.user.username,
  });
  res.json({ maintenance: db.meta.maintenance });
});

// 🧾 管理者操作の履歴（新しい順）
app.get('/api/admin/log', requireAuth, requireAdmin, (_req, res) => {
  const log = (db.meta.adminLog || []).slice().reverse();
  res.json({ log, max: ADMIN_LOG_MAX });
});

// 🔧 更新の準備 — 進行中の対戦を引き分けで終わらせ、ソロの人に保存を促す。
// デプロイ時は SIGTERM で自動的に同じ処理が走るが、Windows のように信号が
// 届かない環境や、push の前に手動で人を逃がしたいときのために残してある。
app.post('/api/admin/prepare-update', requireAuth, requireAdmin, (_req, res) => {
  const ended = battle.endAllForShutdown();
  console.log(`[shutdown] 管理者操作で${ended}件の対戦を終了しました`);
  res.json({ ok: true, ended });
});

app.post('/api/admin/broadcast', requireAuth, requireAdmin, async (req, res) => {
  const message = String(req.body.message || '').slice(0, 200);
  if (!message) return res.status(400).json({ error: 'メッセージが空です' });
  // /api/admin/news already auto-translates; a broadcast did not, so English
  // players got a raw Japanese banner. An explicit messageEn always wins.
  let messageEn = String(req.body.messageEn || '').slice(0, 200) || null;
  if (!messageEn) {
    try {
      const tr = await translateChat(message);
      if (tr && tr.lang === 'en' && tr.text) messageEn = tr.text;
    } catch { /* dictionary fallback failed — ship the original */ }
  }
  battle.broadcastAll({ type: 'announce', message, messageEn, from: req.user.username });
  res.json({ ok: true, delivered: battle.clients.size });
});

// ---------------------------------------------------------------------------
// Moderator API (mods + admins): chat policing tools only
// ---------------------------------------------------------------------------

app.get('/api/mod/users', requireAuth, requireMod, (_req, res) => {
  const users = Object.values(db.users).map(u => ({
    id: u.id, username: u.username, role: u.role, muted: !!u.muted, banned: !!u.banned,
  }));
  res.json({ users });
});

app.post('/api/mod/mute', requireAuth, requireMod, (req, res) => {
  const target = userById(req.body.id);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.role === 'admin' || target.role === 'mod') {
    return res.status(400).json({ error: '運営メンバーはミュートできません' });
  }
  target.muted = !!req.body.muted;
  saveDb();
  res.json({ ok: true, muted: target.muted });
});

app.post('/api/mod/chat/clear', requireAuth, requireMod, (_req, res) => {
  battle.chatOps.clear();
  res.json({ ok: true });
});

// Gift coins/gems to every active (non-banned) account at once.
app.post('/api/admin/grant-all', requireAuth, requireAdmin, (req, res) => {
  const coins = Math.max(0, Math.min(1_000_000, Math.floor(Number(req.body.coins) || 0)));
  const gems = Math.max(0, Math.min(100_000, Math.floor(Number(req.body.gems) || 0)));
  if (!coins && !gems) return res.status(400).json({ error: 'コインかジェムを指定してください' });
  adminLog(req, 'grant_all', null, { coins, gems });
  let affected = 0;
  for (const u of Object.values(db.users)) {
    if (u.banned) continue;
    u.coins += coins;
    u.gems += gems;
    affected++;
  }
  saveDb();
  const parts = [coins ? `${coins}🪙` : '', gems ? `${gems}💎` : ''].filter(Boolean).join(' ');
  battle.broadcastAll({
    type: 'announce',
    message: `🎁 運営から全員に ${parts} をプレゼント！（再ログインまたは画面更新で反映）`,
    messageEn: `🎁 A gift for everyone from the team: ${parts}! (relog or refresh to receive)`,
    from: req.user.username,
  });
  res.json({ ok: true, affected, coins, gems });
});

// Live crowd (にぎわい) control: scale, chattiness, custom names & lines.
// One-click crowd moods.
const CROWD_PRESETS = {
  off:    { scale: 0 },
  quiet:  { scale: 0.5, chatPace: 0.5, toggles: { ...DEFAULT_TOGGLES, dialogues: false, greetings: false }, quiet: null },
  normal: { scale: 1,   chatPace: 1,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  party:  { scale: 3,   chatPace: 2.5, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  fever:  { scale: 25,  chatPace: 3.5, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  // 住人が増え続ける上限は ×88（MAX_ROSTER）。それより上は表示人数だけが伸びる。
  mega:   { scale: 88,  chatPace: 4,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  ultra:  { scale: 500, chatPace: 4,   toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  night:  { scale: 0.7, chatPace: 0.75, toggles: { ...DEFAULT_TOGGLES }, quiet: null },
  silent: { scale: 1,   chatPace: 1,   toggles: { ...DEFAULT_TOGGLES, chat: false, dialogues: false, feed: false, greetings: false, reactions: false }, quiet: null },
};

function crowdStatus() {
  return {
    scale: getLiveScale(), ambient: getCustom(),
    online: battle.displayOnline(), activeMatches: battle.displayMatches(),
    mood: crowdMood(), activeResidents: battle.crowd.activeCount(), quietNow: isQuietNow(),
  };
}

app.post('/api/admin/pop', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.preset && CROWD_PRESETS[b.preset]) {
    const p = CROWD_PRESETS[b.preset];
    b.scale = p.scale;
    if (p.chatPace !== undefined) patch.chatPace = p.chatPace;
    if (p.toggles) patch.toggles = p.toggles;
    if (p.quiet !== undefined) patch.quiet = p.quiet;
  }
  if (b.scale !== undefined) {
    const scale = Math.max(0, Math.min(MAX_LIVE_SCALE, Number(b.scale)));
    if (!Number.isFinite(scale)) return res.status(400).json({ error: `0〜${MAX_LIVE_SCALE}の数値で指定してください` });
    db.meta.popScale = scale;
    setLiveScale(scale);
  }
  if (b.chatPace !== undefined) patch.chatPace = b.chatPace;
  if (Array.isArray(b.names)) patch.names = b.names;
  if (Array.isArray(b.lines)) patch.lines = b.lines;
  if (b.toggles && typeof b.toggles === 'object') patch.toggles = b.toggles;
  if (b.quiet !== undefined) patch.quiet = b.quiet;

  // Cast management.
  const cur = getCustom();
  if (typeof b.removeResident === 'string' && b.removeResident) {
    patch.removed = [...new Set([...cur.removed, b.removeResident])];
  }
  if (typeof b.restoreResident === 'string' && b.restoreResident) {
    // 退役中の住人の名前は「空き」として扱われる（管理者が外した名前を永久に
    // 塞ぎ続けないため）。その隙にプレイヤーがその名前を取っていることがあるので、
    // 戻す前に必ず確かめる ── 確かめずに戻すと、同名の住人が湧いて
    // なりすまし状態が再発する。addResident が既にやっているのと同じ検査。
    const back = retiredResidents().find(r => r.id === b.restoreResident);
    if (back && Object.values(db.users).some(u => u.username.toLowerCase() === back.name.toLowerCase())) {
      return res.status(409).json({ error: `「${back.name}」は実在するプレイヤーが使っています。この住人は戻せません` });
    }
    patch.removed = (patch.removed || cur.removed).filter(id => id !== b.restoreResident);
  }
  if (b.addResident && typeof b.addResident.name === 'string') {
    const name = sanitizeName(b.addResident.name);
    if (name.length < 2) return res.status(400).json({ error: '住人の名前は2文字以上にしてください' });
    if (Object.values(db.users).some(u => u.username.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: '実在するプレイヤーと同じ名前は使えません' });
    }
    if (cur.extra.some(x => x.name === name)) return res.status(409).json({ error: 'その住人はすでにいます' });
    patch.extra = [...cur.extra, { name, arch: String(b.addResident.arch || 'casual'), lang: b.addResident.lang === 'en' ? 'en' : 'ja' }];
  }
  if (typeof b.removeExtra === 'string' && b.removeExtra) {
    patch.extra = (patch.extra || cur.extra).filter(x => x.name !== b.removeExtra);
  }
  if (b.reseed) {
    patch.rosterSeed = `v${Date.now().toString(36)}`;
    // 名簿を引き直すと600人の名前が総入れ替えになる。名前の予約表は
    // 「登録・改名・名乗り」のときにしか働かないので、**名簿のほうが後から
    // 変わる**この経路だけは、ここで衝突を潰しておく必要がある。
    // removed を空にするのは正しい（idの意味が変わるため）が、空にしたまま
    // だと実プレイヤーと同名の住人がそのまま生まれる。
    patch.removed = clashingResidentIds(patch.rosterSeed, Object.values(db.users).map(u => u.username));
    if (patch.removed.length) {
      console.log(`[residents] 名簿の引き直しで実プレイヤーと同名になった住人${patch.removed.length}人を退役させました`);
    }
  }

  if (Object.keys(patch).length) {
    setCustom(patch);
    db.meta.ambient = getCustom();   // persist the sanitized version
  }
  saveDb();
  // Scale / ghost-toggle / roster changes alter throne ELIGIBILITY — recompute
  // now, or the 5s memo serves a stale champion map to the next request.
  refreshThrones(true);
  res.json(crowdStatus());
});

// The cast, with live stats, for the admin roster editor.
app.get('/api/admin/residents', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    residents: rosterView(),
    retired: retiredResidents(),
    archetypes: ARCHETYPES.map(a => ({ id: a.id, label: a.label, labelEn: a.labelEn })),
    status: crowdStatus(),
  });
});

// Fire one crowd action right now (admin preview).
app.post('/api/admin/crowd/test', requireAuth, requireAdmin, (req, res) => {
  const what = String(req.body.what || 'line');
  const out = battle.crowd.test(what);
  if (out.error) return res.status(409).json({ error: out.error });
  res.json(out);
});

// Wipe the global chat for everyone (history + connected clients).
app.post('/api/admin/chat/clear', requireAuth, requireAdmin, (_req, res) => {
  battle.chatOps.clear();
  res.json({ ok: true });
});

// Make an AI player speak (given text, or a random line when empty).
app.post('/api/admin/chat/say', requireAuth, requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  const entry = battle.chatOps.say(text || undefined);
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// 📜 断罪録 ── メニューからいつでも読める公開アーカイブ。
//
// その日ゼロが何を誰に向けて言ったかが、実名つきで時系列に残る。
// 次の枠の人はこれを読んでから戦場に入る。ログインは要らない ——
// 「自分の名前が世界の歴史に載る」ので、誰でも読めることに意味がある。
app.get('/api/zero/chronicle', (_req, res) => {
  const run = db.meta.adminEventRun;
  if (!run || run.modeId !== 'zero') return res.json({ run: null });
  res.json({
    run: {
      dayKey: run.dayKey,
      dan: (run.dan | 0) + 1,
      broken: run.broken || [],
      // 慰霊碑: その日消えた住人と、誰の取りこぼしで消えたか
      fallen: (run.fallen || []).map(x => ({ name: x.name, at: x.at })),
      wills: run.wills || [],
      log: (run.log || []).slice(-200),
    },
  });
});

// 👁️ 憑依 ── 管理者ゼロの口から、るみまきさんが打った言葉をそのまま出す。
//
// ゼロの自動台詞は必ず尽きる。同じ台詞を2回目に見た瞬間にキャラクターは
// 死ぬので、生の言葉が入る口を先に用意しておく。実装はほぼ無いのに、
// 「今日のゼロ、なんか喋りが違う」が起きるのはこちら。
//
// 名前は RESERVED_NAMES で予約してあるので、他人がゼロを騙ることはできない。
app.post('/api/admin/zero/say', requireAuth, requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: '言わせたい言葉を入力してください' });
  // 英訳を添えられる（省略可）。ゼロは日英どちらの画面にも出る。
  const tr = String(req.body.en || '').trim().slice(0, 300) || undefined;
  const entry = battle.zero.say(text, tr);
  adminLog(req, 'zero-say', battle.zero.name, { text: text.slice(0, 80) });
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// 台詞テーブルから喋らせる（動作確認用）。
app.post('/api/admin/zero/speak', requireAuth, requireAdmin, (req, res) => {
  const kind = String(req.body.kind || 'verdict');
  const dan = Math.max(0, Math.min(6, Math.floor(Number(req.body.dan) || 0)));
  const entry = battle.zero.speak(kind, dan, {
    you: String(req.body.you || req.user.username).slice(0, 24),
    name: String(req.body.name || '').slice(0, 24) || undefined,
    n: Number(req.body.n) || undefined,
    dan: dan + 1,
    seed: Date.now(),
  });
  if (!entry) return res.status(400).json({ error: `そんな台詞は無い: ${kind}` });
  res.json({ ok: true, from: entry.from, text: entry.text });
});

// Test tools: instantly finish the caller's own mission board / achievements.
app.post('/api/admin/missions/complete', requireAuth, requireAdmin, (req, res) => {
  migrateUser(req.user);
  const ms = syncMissions(req.user, currentWeekNum());
  for (const row of [...ms.daily, ...ms.weekly]) row.p = Number.MAX_SAFE_INTEGER;
  saveDb();
  res.json({ missions: missionsView(req.user, currentWeekNum()), user: publicUser(req.user) });
});

app.post('/api/admin/achievements/reset', requireAuth, requireAdmin, (req, res) => {
  migrateUser(req.user);
  req.user.achievements = [];
  saveDb();
  res.json({ achievements: achievementsView(req.user), user: publicUser(req.user) });
});

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
  console.log('='.repeat(60));
  console.log('  管理者アカウントを作成しました');
  console.log(`  ユーザー名: ${ADMIN_NAME} / パスワード: ${password}`);
  console.log(`  (${credFile} にも保存済み)`);
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
  // The repo is public, so the committed seed is encrypted with the admin
  // password (scripts/pull-backup.mjs). ADMIN_PASSWORD must match to open it.
  if (data && data.enc === 'aes-256-gcm') {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) {
      console.warn('[seed] seed-backup.json は暗号化されていますが ADMIN_PASSWORD 環境変数が未設定のため復元できません');
      return;
    }
    try {
      const salt = Buffer.from(data.salt, 'base64');
      const iv = Buffer.from(data.iv, 'base64');
      const key = crypto.scryptSync(pw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
      console.warn('[seed] seed-backup.json の復号に失敗しました（ADMIN_PASSWORD がバックアップ取得時と一致していません）');
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
unlockEverythingForStaff();
seedNews();
finalizeWeeklyRankings();   // pay out any week that ended while we were down
settleSeasonHallOfFame();   // 🏛 寝ているあいだに終わったシーズンを殿堂へ
// 👑 Thrones exist from second zero (silent first computation), and the seeded
// chat history — built before the restore above — gets its crowns stamped.
refreshThrones();
battle.crowd.restampCrowns();
console.log(`[chat] 自動翻訳エンジン: ${TRANSLATE_ENGINE === 'api' ? '外部API (TRANSLATE_URL)' : '内蔵フレーズ辞書'}`);

// A boot snapshot means a bad restore is always one click away from undo.
if (Object.keys(db.users).length > 0) snapshot(db, 'boot');

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
