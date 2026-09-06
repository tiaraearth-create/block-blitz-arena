// Multiplayer battle system: matchmaking (1v1 / 2v2 team), custom rooms,
// and server-side bot players that fill empty seats.
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { Engine } from '../public/js/engine.js';
// AI_LEVELS も読む。王者専用の手番間隔を写経せず souzou の定義から取るため
// （ai.js を調整したときにサーバー側だけ古い値のまま残る、を作らない）。
import { chooseMove, AI_LEVELS } from '../public/js/ai.js';
// TITLES は実プレイヤーの称号を match_found に載せるために要る（index.js の
// titleOf と同じ引き方 ── 表を写経せず、同じ定義から引く）。
import { RAID_BOSSES, TITLES, SHOP_ITEMS, DEFAULT_EQUIPPED } from './catalog.js';
// 段位（帯・24段）の唯一の正解。手書きの表をここに持たない ── サーバーと画面で
// しきい値がズレると「画面ではゴールドなのにサーバーはシルバー扱い」が起きる。
import { rankOf, bandOf, RANK_BANDS } from '../public/js/ranks.js';
import {
  effectiveScale, pickPersona, pickResidentBot, pickChampionBot,
  // 🎭 席の称号・ギルド・戦績。住人と使い捨てを同じ関数から作るための入口。
  seatProfile,
  residentLine, residentById, residentByName,
  ambientOnline, ambientMatches, ambientQueue, crowdMood, chooseReplies, chatPaceFactor, chatFloorMs, getRoster,
  toggles, isQuietNow, popFactor, worldCtx,
  // 🧮 人数と辻褄を合わせる係数。ambient.js が「世界の大きさ」の唯一の
  //    出どころなので、発言の速さも席が埋まる速さもそこから貰う。
  //    詳しい理由は ambient.js の crowdPace / matchWaitMs のコメント。
  crowdPace, matchWaitMs,
} from './ambient.js';

// 群衆の勢いで割るときの除数。
//
// ⚠ crowdPace() は **にぎわいOFF（×0）のとき 0 を返す**。0 で割ると gap が
//   Infinity になり、setTimeout は Infinity を「1ms」に丸めるので（Node の
//   TimeoutOverflowWarning）、静かにするつもりのスイッチが逆に毎ミリ秒の
//   空回りを生む。置き換え前の `Math.max(0.5, Math.min(4, popFactor()))` は
//   下限 0.5 で clamp していたのでこの穴が無かった。同じ下限をここで残す。
const crowdDiv = () => Math.max(0.5, crowdPace());
// 🗒 住人の戦績の差分（実際に起きたことの記録）。置き場は db.meta で、
// residents.js は db を知らないので読み口をここから渡す。
import { setResidentRecordSource, recordResidentMatch } from './residents.js';
import { composeDialogue, composeFeed, composeReaction } from './crowd.js';
import { zeroSay, moodFor } from './zero.js';
import { createSession as createZeroSession, tick as tickZero, submitCut as zeroCut,
  submitStake as zeroStake, submitDealVote as zeroDealVote,
  submitWill as zeroWill, latestWill as zeroLatestWill, addHuman as zeroAddHuman,
  topOut as zeroTopOut, stateView as zeroStateView, syncBoard as zeroSyncBoard,
  finishHuman as zeroFinishHuman,
  ZERO_TICK } from './zero-session.js';
import { eventBonus } from './events.js';
import { danAt, DAN as ZERO_DAN } from './zero.js';
import { createParties } from './party.js';
import { getSchedule as getAeSchedule, liveSlotFor as aeLiveSlotFor,
  ensureRun as aeEnsureRun, slotCounts as aeSlotCounts, entrantCount as aeEntrantCount,
  SHARD as AE_SHARD, recordThrone as aeRecordThrone, jstDayKey } from './adminevent.js';
// 🕒 在席区間ログの上限。記録するのはこのファイル、合流するのは backup.js。
// 2箇所で違う数を持つと復元のたびに件数が動くので、定数は1つだけ持つ
// （どちらに置くかの理由は backup.js の ONLINE_SPANS_MAX のコメント）。
import { ONLINE_SPANS_MAX } from './backup.js';
import { translateChat, translateLocal, detectLang, TRANSLATE_ENGINE } from './translate.js';
// 💬 ギルドチャット（20人が集まる場所なのに、喋る手立てが1つも無かった）。
import { guildChat, guildChatHistory } from './guilds.js';
import { isOpen as pollIsOpen, vote as pollVote, residentChoice, residentVoteAt, isSwingVoter } from './polls.js';
// 住人の正体を隠す共通の関門（詳しい理由は server/sanitize.js の冒頭）。
import { scrubFor } from './sanitize.js';

const COUNTDOWN = 3;
// ms alone in queue before an AI player fills the seat (randomized per entry
// so joins don't feel mechanical)
// 🧮 人数に見合った速さで埋まるように ambient.js の matchWaitMs に寄せた。
//    以前は倍率に関係なく 4〜9秒 / 5〜10秒 / 6〜11秒 の固定で、メニューに
//    「待機中 18,640人」と出ている世界でも毎回きっちり数秒待たされた
//    ── これだけ並んでいる列が数秒かかるなら、人数のほうが嘘だと言っている
//    のと同じ。×1 の世界では従来と1msも変わらない（matchWaitMs の除数が 1）。
//    下限 1200ms は秘匿の要求（0秒で成立すると席が用意されていたと分かる）。
const duelBotWait = () => matchWaitMs(4000, 5000);
// 🏆 バトルロイヤルもこれを使う（下の queueInfo は royale を team 側に流す）。
const teamBotWait = () => matchWaitMs(5000, 5000);
const DURATIONS = [60, 120, 180];

// Online tournament: 8 entrants, 3 knockout rounds. TOURNEY_SECS env
// overrides round lengths for testing (e.g. "6,6,8").
const TOURNEY_ROUND_SECS = (process.env.TOURNEY_SECS || '60,60,90')
  .split(',').map(n => Math.max(5, Number(n) || 60));
const TOURNEY_INTERMISSION = 7000;
// Co-op: one shared board, alternating turns.
const COOP_TURN_MS = Number(process.env.COOP_TURN_MS) || 15000;
const COOP_BOT_THINK_MS = 1800;
// Hard stop so a run can't hang forever (env-overridable for tests).
const COOP_MAX_SECS = Number(process.env.COOP_MAX_SECS) || 600;
const coopBotWait = () => matchWaitMs(6000, 5000);
// Bot strength rises with the round: QF easy/normal, SF normal/hard, F hard/oni.
const TOURNEY_BOT_LEVELS = [['easy', 'normal'], ['normal', 'hard'], ['hard', 'oni']];

// 環境変数から数を読む。`Number(x) || def` だと "0" が def に化けるので、
// テストが 0 を渡せるようにここで分けておく。
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

// ---------------------------------------------------------------------------
// 🔌 再接続の猶予 — 「切断＝即敗北」をやめる
// ---------------------------------------------------------------------------
// これまでは WS が閉じた瞬間に forfeit だった。電車がトンネルに入る・
// Wi-Fi が切り替わる・スマホが画面を消す、それだけでレートが落ちる。
// これがある限り、シーズンランクも BO3 も「登る気にならない階段」になる。
//
// ⚠ 猶予のあいだも試合の時計は**止めない**。止めると
//   ・相手が何もできない空白ができる（切断が時間稼ぎの道具になる）
//   ・「残り30秒」の意味が人によって変わる
// ので、提供するのは「戻ってきたら続きから遊べる」だけ。戻らなければ
// 従来どおり負ける（逃げ得にしない）。
const RECONNECT_GRACE_MS = Math.max(1000, Math.min(60_000, envNum('RECONNECT_GRACE_MS', 25_000)));
// 猶予を開くのに最低限必要な残り時間。あと1秒の試合に猶予を出しても
// 誰も戻ってこられないので、その場合は従来どおりその場で決着させる。
const RECONNECT_GRACE_MIN_MS = 2000;
// 1日（JST）に猶予を受けられる回数。超えた人は従来どおり即敗北 ──
// 「不利になったら切る」を戦術にさせないための唯一の歯止め。
// 数えるのは「猶予を開いた回数」で、戻ってきたかどうかは問わない
// （相手を待たせたという事実のほうが、こちらの都合より重い）。
const RECONNECT_GRACE_PER_DAY = Math.max(0, Math.min(50, envNum('RECONNECT_GRACE_PER_DAY', 3)));

// ---------------------------------------------------------------------------
// 🕒 在席区間ログ — 「誰がいつオンラインだったか」
// ---------------------------------------------------------------------------
// user.lastSeen は「最後に見かけた時刻」の1点しか持たないので、
// 「いつからいつまで居たか」は答えられなかった。区間で残す。
// ⚠ 記録するところまで。読み出す API は別担当（表示は管理者だけ）。
//
// 短すぎる区間を積まない理由: リロード・画面遷移・対戦画面に入るたびの
// 2本目の接続で、数秒の区間がいくらでも生える。30件の輪バッファが
// 「さっきのリロード30回」で埋まると、ログとして何の役にも立たない。
const ONLINE_SPAN_MIN_MS = Math.max(0, envNum('ONLINE_SPAN_MIN_MS', 20_000));

export function initBattle(server, deps) {
  const { db, saveDb, applyGameResult, publicUser, levelOf, sanitizeName, MATCH_DURATION } = deps;
  // 1日の枠を数える口。index.js に1本化してある（別々に数えると上限が実質2倍になる）。
  // 古い index.js と組み合わせても落ちないよう、無ければ素通しにする。
  const grindTake = deps.grindTake || ((u, k, want) => Math.max(0, Math.floor(want) || 0));
  const gemTake = deps.gemTake || ((u, want) => Math.max(0, Math.floor(want) || 0));
  // 予約名判定（無ければ何も予約しない安全側デフォルト）。index.js が渡す。
  const reservedName = deps.reservedName || (() => false);
  // 🪪 名乗る名前の正規化と文字種検査（server/index.js の claimName /
  //    isClaimableName）。渡ってこない組み方（部分起動のテスト）では、
  //    従来どおり sanitizeName だけに落ちる ── 落ちても壊れないが、
  //    なりすまし対策は効かなくなるので本番では必ず渡すこと。
  const claimName = deps.claimName || sanitizeName;
  const isClaimableName = deps.isClaimableName || (n => !!String(n || '').trim());
  // 🚫 回線ごとの凍結。渡ってこない組み方（部分起動のテスト）では素通し。
  const isIpBanned = deps.isIpBanned || (() => false);
  const ipFingerprintOf = deps.ipFingerprint || (() => null);
  const noteUserIp = deps.noteUserIp || (() => {});
  // 🔍 ゲスト名の照会は「名前を変えたとき」だけ数える。
  //    hello は何度でも送れるので、名前を変えながら繋ぎ直すだけで
  //    「その名前は使われているか」を無制限に調べられた（登録者と住人の名簿を
  //    総当たりで作れる）。ただし素朴にIPで回数制限を掛けると、電波の悪い人が
  //    再接続を繰り返しただけで枠を使い切る（再接続は1回の切断で最大6本走る）。
  //    **同じ名前での名乗り直しは無料**にして、名前を変えたときだけ数える ──
  //    総当たりは名前を変えることでしか成立しないので、これで狙いは外さない。
  const lastGuestNameByIp = new Map();   // ip -> 直近に名乗った名前

  // 🏠 同じ回線の2アカウントが、レート戦で何度も当たっている組み合わせ。
  //    マッチングでは同一回線を後回しにしてあるが、他に誰も並んでいなければ
  //    従来どおり組まれる。そこを無制限にすると、2つ目のアカウントを作って
  //    交互に勝つだけでレートを押し上げられる。数えて、続きは練習試合に落とす。
  //    ⚠ 同一回線というだけでは落とさない（家族・学校・寮でふつうに起きる）。
  //      「同じ回線 × 同じ相手 × 短時間に何度も」の3つが揃ったときだけ。
  //    メモリにしか持たない ── 再起動で消えてよい程度の重みの判定で、
  //    db.json を太らせるほうが害が大きい。
  const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000;
  const REPEAT_FREE = 3;                 // ここまでは今までどおり数える
  const pairHistory = new Map();         // 'idA|idB' -> [終わった時刻]
  // 👑 「王者を破った」の全体速報。連発防止（1人1日1回・印は stats.champAnnDay）と
  // 日英の文面は index.js の announceChampionFall が持っているので、こちらは
  // endMatch で beatChampion が立った直後に呼ぶだけでよい。何度呼んでも二重には
  // 鳴らない。テストの部分起動など deps が来ない環境では何もしない。
  const announceChampionFall = deps.announceChampionFall || (() => false);
  // 🗒 住人の戦績の差分表（db.meta.residentRecords）の読み口を residents.js に渡す。
  //
  // ・毎回 db.meta を引き直す。参照を1回だけ渡すと、/api/admin/restore が
  //   db.meta を丸ごと差し替えたあとも古いオブジェクトを掴んだままになり、
  //   復元した記録が見えないうえ、新しい記録は保存されない入れ物へ落ちる。
  // ・入れ物を作るのは書くとき（create）だけ。読むだけの経路
  //   （ランキング1行ごとに呼ばれる）で db.meta に空の欄を生やさない。
  // ・中身の検査（オブジェクトか・行の形）は residents.js 側でやる。
  setResidentRecordSource(create => {
    if (!db.meta) {
      if (!create) return null;
      db.meta = {};
    }
    if (!db.meta.residentRecords) {
      if (!create) return null;
      db.meta.residentRecords = {};
    }
    return db.meta.residentRecords;
  });

  // アカウント（未ログインはIP）単位の流量制限。sockRate は ws のプロパティに
  // カウンタを置くので、接続を増やすと持ち分もそのまま増える。
  // index.js から渡らない環境（テストの部分起動など）では素通しにする。
  const userRate = (key, limit, windowMs) =>
    (deps.rateLimit ? deps.rateLimit(key, limit, windowMs) : true);

  // 開催中の期間限定イベントの bonus ブロック。
  // index.js の currentEvent() は同ファイル内のクロージャ（期限切れの後片付けと
  // 終了アナウンスも兼ねている）なので import できない。読むだけならここでも
  // 同じ判定ができるので、db.meta.event を直接見て、倍率の取り出しだけを
  // events.js の eventBonus に任せる（index.js:/api/bosses と同じ作法）。
  // index.js が deps.currentEvent を渡してくれるならそちらを優先する。
  const liveEventBonus = () => {
    if (deps.currentEvent) return eventBonus(deps.currentEvent());
    const ev = db.meta && db.meta.event;
    return ev && ev.endsAt > Date.now() ? eventBonus(ev) : {};
  };

  // maxPayload: the default is 100 MiB per frame, which on a single free-tier
  // instance is a cheap way to exhaust memory. The largest legitimate message
  // here is a chat line or a 64-cell grid.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('error', err => console.error('[wss]', err && err.message));
  const clients = new Set();
  // userId -> その人が今つないでいる socket 全部。
  // 今まではこれが無く、`[...clients].find(c => sockName(c) === name)` で
  // 名前から1本だけ拾っていた。名前は hello 時点の控えなので改名すると
  // 引けなくなるし、複数つないでいる人には最初の1本しか届かなかった。
  // 通知は必ず「その人」に届いてほしいので、id で引ける表を持つ。
  const userSockets = new Map();

  function trackSocket(ws) {
    if (!ws.user) return;
    let set = userSockets.get(ws.user.id);
    if (!set) { set = new Set(); userSockets.set(ws.user.id, set); }
    set.add(ws);
  }
  function untrackSocket(ws) {
    if (!ws.user) return;
    const set = userSockets.get(ws.user.id);
    if (!set) return;
    set.delete(ws);
    if (!set.size) userSockets.delete(ws.user.id);
  }
  function socketsOf(userId) {
    const set = userSockets.get(userId);
    if (!set) return [];
    // 閉じ損ねた socket を掃除しながら返す（心拍でも掃除される）。
    const live = [];
    for (const w of set) {
      // 開いているだけでなく「本当にこの人の socket か」も見る。
      // hello は何度でも送れるので、1本の socket を別のアカウントで
      // 名乗り直すと、古い方の表に残ったまま生きて見えてしまう。
      const mine = w.user && w.user.id === userId;
      if (mine && w.readyState === w.OPEN) live.push(w);
      else set.delete(w);
    }
    if (!set.size) userSockets.delete(userId);
    return live;
  }
  function isOnline(userId) { return socketsOf(userId).length > 0; }
  // 何をしている最中か。パーティーの一覧と、いっしょに遊ぶ判定に使う。
  function statusOf(userId) {
    const live = socketsOf(userId);
    if (!live.length) return 'offline';
    for (const w of live) {
      // roomId ではなく roomCode。roomId はこのコードベースのどこにも
      // 代入が無いので、合言葉ルームにいる人がずっと「メニュー」に見えていた。
      if (w.matchId || w.royaleId || w.zeroId || w.tourneyId) return 'playing';
    }
    // 🚪 部屋にいるだけなら 'room'。以前は 'playing' と同じ値に潰していたので、
    //   **先に部屋を開けて友達を呼ぶ**という一番自然な順番が通らなかった：
    //   ロビーで待っているだけの人がフレンド一覧に「対戦中」と出、招待も
    //   「いっしょに遊ぶ」も『対戦中のメンバーがいます』で断られる。
    //   （招待ボタンは offline 以外で出るので、押せるのに必ず失敗していた。）
    //   観戦席の人もここに入る ── 盤面を持っていないので呼ばれて困らない。
    for (const w of live) if (w.roomCode) return 'room';
    return 'menu';
  }
  // 通知は primaryOnly で送ること。対戦画面に入ると同じ人が2本つなぐので、
  // 全部に送ると招待が1つの画面に二重に出る。
  function sendToUser(userId, msg, { primaryOnly = false } = {}) {
    const live = socketsOf(userId);
    if (!live.length) return false;
    if (!primaryOnly) { for (const w of live) send(w, msg); return true; }
    const primary = live.find(w => !w.secondary) || live[0];
    send(primary, msg);
    return true;
  }
  // 接続の上限。以前は認証も上限も無く、無言のソケットを何本でも張れた
  // （実測で200本つないでオンライン人数を 0→200 に水増しできた）。
  // これが土台になって、リアクションの増幅・チャット制限のすり抜け・
  // 対戦報酬の並列採掘が成立していた。
  const MAX_SOCKETS = 400;              // 全体
  //   合言葉ルームの定員を16人にしたので、**同じ回線から16人が入れる**高さにする。
  //   1人が対戦用とチャット用で2本つなぐ設計なので、16人＝32本＋予備。
  const MAX_SOCKETS_PER_IP = 40;        // 同一IPあたり（家族・学校・16人ルームを考慮）
  const MAX_SOCKETS_PER_USER = 6;       // 同一アカウントあたり（PC＋スマホ＋予備）
  const HELLO_GRACE_MS = 20_000;        // 名乗らない接続を切るまで
  const sockIp = ws => (ws && ws._ip) || '?';
  // 接続元IP。index.js が Express の req.ip と同じ規則（trust proxy）で解いた
  // 関数を渡してくる。渡ってこない組み方（テストの部分起動など）では従来どおり
  // socket の相手をそのまま使う。
  //
  // ここを remoteAddress 直読みにしていたのが「6人の壁」の正体だった。前段に
  // LB がある本番では全員がプロキシの内部IPに見えるので、下の per-IP 上限が
  // “全プレイヤー合算”に効く。1人がチャット用＋対戦用の2本をつなぐ設計なので、
  // プロキシIP1つあたり6人前後で新規プレイヤーが門前払いになっていた。
  const ipOf = req => (deps.clientIp
    ? String(deps.clientIp(req) || '?')
    : String((req && req.socket && req.socket.remoteAddress) || '?'));
  // 上限で断った回数。壁に当たり始めたことを運営が事前に気づけるように数える
  // （断ること自体は正しい動作なので、ログではなく管理画面の数字として出す）。
  // 上限は3つ（全体・IPごと・アカウントごと）あるので、カウンタも3つ並べて
  // total はその合計にする ── total が「全体上限ぶんだけ」だと、IP上限で毎分
  // 断られていても total=0 と表示され、いちばん見たい数字を読み違える。
  const connRejects = { total: 0, max: 0, perIp: 0, perUser: 0, lastAt: null };
  const noteReject = kind => { connRejects[kind]++; connRejects.total++; connRejects.lastAt = Date.now(); };
  const matches = new Map();               // matchId -> match
  // 🔌 猶予中の席。userId -> { matchId, slot, until, timer }
  // 鍵が userId なのは意図的 ── 復帰を許すのは「同じアカウント」だけで、
  // 名前でもゲスト名でも socket でもない（下の resumeMatch のコメント参照）。
  const dcHolds = new Map();
  // 🕒 いま在席が始まっている人。userId -> 開始時刻。
  // メモリにしか持たない ── サーバーが落ちれば開きっぱなしの区間は捨てる。
  // 「終わりの分からない区間」を db に残すほうが、記録として質が悪い。
  const onlineSince = new Map();
  const rooms = new Map();                 // code -> room
  const tourneys = new Map();              // id -> tournament
  const royales = new Map();               // id -> battle royale
  const queues = { duel: [], attack: [], team: [], raid: [], tourney: [], royale: [], coop: [] };   // entries: { ws, since, botAt }
  // 全体チャットを「発言順」で配るための直列化チェーン（翻訳完了順のズレを防ぐ）。
  let chatChain = Promise.resolve();
  // チェーンの中で落ちた回数。catch で復帰するようになったぶん「静かに落ち
  // 続けている」状態に気づけるよう、数だけ管理画面へ出す。
  let chatChainErrors = 0;

  // 🎭 その socket の持ち主が運営か。ws.user は hello 時点の控え（id と名前だけ）
  // なので、権限は毎回 db から引き直す ── 降格した人の socket が張りっぱなしでも
  // 権限だけ残る、を作らない。
  const sockAdmin = sock => !!(sock && sock.user && db.users[sock.user.id] && db.users[sock.user.id].role === 'admin');

  // WebSocket の唯一の出口。ここを通らないフレームは無いので、
  // 住人の正体を明かすキー（isBot / human / real …）はここで最後に落とす。
  // 個別の送信箇所でも組み立てない（match_found など）が、フレームは数十種類
  // あって今後も増えるので、機械的に落とす関門を必ず1枚かませる。
  function send(sock, msg) {
    if (sock.isBot) return;
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(scrubFor(sockAdmin(sock), msg)));
  }
  function broadcastAll(msg) { for (const ws of clients) send(ws, msg); }

  // Displayed population = real sockets + simulated ambient players.
  const realClients = () => { let n = 0; for (const c of clients) if (!c.secondary) n++; return n; };
  const displayOnline = () => realClients() + ambientOnline();
  const displayMatches = () => matches.size + ambientMatches();

  // ---- global chat (in-memory history) ----
  // チャット履歴。以前はメモリだけに置いていたので、更新のたびに会話が全部
  // 消えて、戻ってきた人には空のチャットが出迎えていた。db.meta.chatLog に
  // 直近ぶんを残し、起動時に読み直す（ディスクがあるので更新をまたげる）。
  // 実プレイヤーの発言だけを残す — 住人のセリフは無限に作れるので、
  // 保存するとただの水増しになる。
  const chatHistory = (db.meta.chatLog || []).slice(-60);   // { type:'chat', from, role, text, at }
  const feedHistory = [];   // { icon, text, textEn, at, real, who }
  let chatSaveTimer = null;
  const persistChat = () => {
    if (chatSaveTimer) return;
    chatSaveTimer = setTimeout(() => {
      chatSaveTimer = null;
      db.meta.chatLog = chatHistory.filter(e => e && e.human).slice(-40);
      saveDb();
    }, 4000);
    chatSaveTimer.unref?.();
  };

  // =========================================================================
  // Crowd director — the simulated residents live here.
  //
  // Single lines, two-person dialogues, a live activity feed, greetings for
  // arriving players, and reactions to real-world moments (events, polls,
  // match results). Everything respects the admin toggles + quiet hours and
  // only runs while at least one real client is connected.
  // =========================================================================

  const crowdOn = (key) => effectiveScale() > 0 && clients.size > 0 && !isQuietNow() && (!key || toggles()[key]);

  // Names of real people online — residents may greet them.
  // 同上。名前も重複すると住民が同じ人に二度あいさつする。
  const humanNames = () => [...new Set([...clients].filter(c => !c.isBot).map(sockName).filter(Boolean))];

  // Guild tag shown next to a name in chat ([TAG]); residents carry their
  // ghost guild's tag so the crowd looks like it belongs to guilds too.
  const tagOf = (name, user) => {
    if (deps.guildTagOf) return deps.guildTagOf(name, user) || null;
    return null;
  };

  // autoTr: 素材にネイティブ対訳が無いとき、translate.js の部分文字列置換で
  // 埋め合わせるかどうか。住人の自動発言では **必ず false**（既定）――
  // 置換テーブルは英語でも日本語でもない文字列を作り、それが
  // 「auto-translated」の札つきで英語プレイヤーに届く。壊れた英語より原文の
  // ままのほうが読み手には親切で、「翻訳が無い」ことも正しく伝わる。
  // true にするのは運営が自由文で打った台詞（zeroChat / postAmbient）だけ。
  function postChat(name, text, extra = {}) {
    const { autoTr = false, ...rest } = extra;
    const entry = { type: 'chat', id: crypto.randomUUID(), from: name, role: 'user', text, at: Date.now(), tag: tagOf(name, null), ...rest };
    // 👑 王座を持つ住人（AIプレイヤー）の発言にも王冠（名前は一意・なりすまし不可）
    const crowns = db.meta.thrones ? Object.values(db.meta.thrones).filter(t => t && t.username === name).length : 0;
    if (crowns) entry.crown = crowns;
    // 翻訳: 会話エンジンが「人間が書いたネイティブ対訳」を同梱してきたら
    // それを最優先。対訳の無い素材は翻訳を付けずに原文のまま出す
    // （autoTr を立てた運営の自由文だけ、辞書翻訳で埋め合わせる）。
    if (!entry.tr && autoTr) {
      const tr = translateLocal(text, detectLang(text) === 'ja' ? 'en' : 'ja');
      if (tr) entry.tr = tr;
    }
    pushHistory(entry);
    broadcastAll(entry);
    return entry;
  }

  // ---- 👁️ 断罪 のセッション ----
  //
  // 進行そのものは server/zero-session.js（deps で受け取る形なので単体で
  // テストできる）。ここは「ソケットと db をそこへ繋ぐ」だけを持つ。
  //
  // 段の状態は db.meta.adminEventRun にあり、枠をまたいで引き継がれる。
  // セッションはこの枠の間だけのメモリなので、再デプロイされても
  // 進行は失われない（ゼロの盤面だけ引き直して再開する）。
  const zeroSessions = new Map();          // id -> session

  // 共有 run（世界で1本の段の状態）。
  // 以前は「あれば返す」だけだったので、その日まだ誰も結果を送っていない
  // 最初の参加者がセッションを作れなかった（run は結果送信で初めて
  // 作られる仕組みだったため）。ここでも作る。
  function zeroRun(user) {
    const schedule = getAeSchedule(db);
    if (!schedule.enabled) return null;
    const live = user ? aeLiveSlotFor(schedule, user) : null;
    // 枠を取れていない人には null を返す。以前はここで共有runをそのまま
    // 返していたので、予約なしでも枠の時間外でも参加できてしまった。
    if (!live) return null;
    const counts = aeSlotCounts(db, live.occ);
    // 断罪の回でなければ、この導線は使えない（他の3モードは別経路）
    if (live.occ.modeId !== 'zero') return null;
    return aeEnsureRun(db, live.occ, Math.max(1, aeEntrantCount(counts)));
  }

  // そのソケットの持ち主が、いま自分の枠にいるか（＝断罪に参加できるか）
  function zeroUserOf(ws) {
    return ws.user ? db.users[ws.user.id] || null : null;
  }

  // 👥 パーティー。db には保存しない（理由は party.js の冒頭）。
  const party = createParties({
    db, sendToUser, isOnline, statusOf,
    uuid: () => crypto.randomUUID(),
    rateLimit: (...args) => (deps.rateLimit ? deps.rateLimit(...args) : true),
    adminLog: (...args) => (deps.adminLog ? deps.adminLog(...args) : undefined),
    // 翻訳は必ず手元の対訳表だけ。外部の翻訳サーバー(translateChat)には
    // 絶対に渡さない ── 4人だけの私語が箱の外に出る。
    // translateLocal は { lang, text, engine } を返す。文字列だけ取り出す
    // （そのまま渡すと画面に [object Object] が出る）。
    translateLocal: (text) => {
      const tr = translateLocal(text, detectLang(text) === 'ja' ? 'en' : 'ja');
      return tr && tr.text ? tr.text : null;
    },
  });

  function zeroDeps(sess) {
    return {
      Engine, chooseMove, sockName,
      // 🤝 取引の「もう投票したか」を視聴者ごとに返すために使う。
      // 票はユーザーidで数えている（席や名前ではない）。
      userIdOf: ws => (ws && ws.user ? ws.user.id : null),
      SHARD: AE_SHARD,
      pickResidentBot, pickPersona,
      uuid: () => crypto.randomUUID(),
      emit: (e, msg) => { if (e.human && e.ws && e.ws.readyState === e.ws.OPEN) send(e.ws, msg); },
      say: (kind, danIndex, ctx) => zeroSpeak(kind, danIndex, ctx),
      // 👑 王座の欠片。管理者イベントの中でしか増えないので、
      // 配るのもここ（HTTP 側ではなく、実際に斬った瞬間）でやる。
      shard: (name, n) => {
        if (!n) return;
        // 送り先は「断罪の席に座っているソケット」でなければならない。
        // 以前は clients から そのユーザーの**最初の**ソケットを拾っていたが、
        // clients は接続順の Set で、chat.js の常時接続はページ読み込み時に
        // 張られる＝断罪の BattleClient(role:'battle') より必ず先にいる。
        // その結果 'shards' は断罪の画面を持たないソケットへ飛び、
        // chat 側の dispatch が知らない type として黙って捨てていた
        //（ZeroMode の .on('shards') が一度も呼ばれず、走行中のトーストも
        //  獲得数の積算も出ないまま結果画面が「初回10」を表示していた）。
        const seat = sess && sess.entrants
          ? sess.entrants.find(x => x.human && x.ws && x.ws.user && x.name === name)
          : null;
        const sock = (seat && seat.ws)
          || [...clients].find(c => !c.isBot && c.user && sockName(c) === name);
        const u = sock && sock.user ? db.users[sock.user.id] : null;
        if (!u) return;
        u.shards = (u.shards || 0) + n;
        const msg = { type: 'shards', gained: n, total: u.shards };
        // 席が生きていればそこへ1通だけ。席が無い／もう閉じている場合
        //（再接続直後など）だけ、そのアカウントの生存ソケット全部へ回して
        // 通知が行方不明になるのを防ぐ。両方へ送るとクライアント側の
        // 積算が二重になるので、必ずどちらか一方。
        if (seat && seat.ws.readyState === seat.ws.OPEN) send(seat.ws, msg);
        else sendToUser(u.id, msg);
        saveDb();
      },
      // 出来事をプレイヤーの記録に残す。これが無いと称号もバッジも解除されない。
      onStat: (name, key, n = 1) => {
        const sock = [...clients].find(c => !c.isBot && c.user && sockName(c) === name);
        const u = sock && sock.user ? db.users[sock.user.id] : null;
        if (!u || !u.stats) return;
        u.stats[key] = (u.stats[key] || 0) + n;
        saveDb();
      },
      // 段を割った回に居合わせた人全員にバッジ
      onDanBadge: (names) => {
        for (const nm of names) {
          const sock = [...clients].find(c => !c.isBot && c.user && sockName(c) === nm);
          const u = sock && sock.user ? db.users[sock.user.id] : null;
          if (!u) continue;
          if (!u.badges.includes('zero')) u.badges.push('zero');
        }
        saveDb();
      },
      // 👑 七段すべて陥落に居合わせた人へ称号「七冠奪還」のバッジ 'zero7'。
      // 段ごとの 'zero' はそのまま（別物）。称号側の判定は catalog.js を has('zero7') に。
      onZeroSevenBadge: (names) => {
        for (const nm of names) {
          const sock = [...clients].find(c => !c.isBot && c.user && sockName(c) === nm);
          const u = sock && sock.user ? db.users[sock.user.id] : null;
          if (!u) continue;
          if (!u.badges.includes('zero7')) u.badges.push('zero7');
        }
        saveDb();
      },
      // ゼロが2列以上消したら、席にいる人間の盤面にゴミが降る。
      // 既存の対戦の攻撃経路をそのまま使う。
      attack: (sx, lines, combo) => {
        const cells = attackCells(lines, combo);
        if (!cells) return;
        for (const e of sx.entrants) {
          if (!e.human || !e.alive || !e.ws || e.ws.readyState !== e.ws.OPEN) continue;
          send(e.ws, { type: 'zero_garbage', cells });
        }
      },
      // 取引の投票。誰がどう入れるかは polls.js の仕掛けをそのまま使う ——
      // 同調・逆張り・ギルド連帯・締切間際の鞍替えが全部効くので、
      // 同じ2択でも毎回結果が違う。
      residentVoters: () => (worldCtx().active || []).slice(0, 40),
      residentChoice: (poll, r) => residentChoice(poll, r),
      onDanBroken: (rec) => {
        // 世界の最高到達段。管理者イベント専用ショップの棚がこれで開く。
        aeRecordThrone(db, rec.dan);
        saveDb();
        broadcastAll({
          type: 'announce',
          message: `断罪 ── 第${rec.dan}段が陥落！ 王座がひとつ返ってきました${rec.by ? `（とどめ: ${rec.by}）` : ''}`,
          messageEn: `CONDEMNED ── Stage ${rec.dan} has fallen. One throne returns${rec.by ? ` (finished by ${rec.by})` : ''}`,
          from: '管理者ゼロ',
        });
      },
    };
  }

  // 席に着いた人へ、いまの状態を1通で渡す。新しく部屋を作ったときも、
  // 生きている部屋へ途中合流したときも、作法は同じ。
  function zeroSeatIn(e, sess, run) {
    e.ws.zeroId = sess.id;
    // 状態を展開すると type:'zero_state' が入っているので、
    // 後に置かないと zero_found が上書きされて消える（実際に消えた）。
    // 前の枠の誰かが残した伝言があれば、ゼロが読み上げて茶々を入れる。
    // 会ったことのない18時の人からの言伝が、21時の人に届く。
    // 伝言の読み上げガードは run 側に持つ（セッションは120秒ごとに作り直され、
    // sess.willRead では同じ伝言が本人の再入場のたびに全体チャットへ再放送された）。
    // 同じ伝言（will.at で識別）は世界で一度だけ読む。
    const will = zeroLatestWill(run);
    if (will && run.willReadAt !== will.at) {
      run.willReadAt = will.at;
      zeroChat(`……前の方が言伝を残しています。「${will.text}」 ── ${will.by} より`,
        `…The last one left you a message. "${will.text}" — from ${will.by}`);
    }
    const found = zeroStateView(sess, run, e.name);
    send(e.ws, {
      ...found,
      type: 'zero_found',
      id: sess.id, seed: sess.seed, countdown: 3,
      // 再接続（新セッション）でも、とどめを刺して未記入の段があれば伝言を書ける。
      canWill: (run.broken || []).some(b => b.by === e.name && !b.will),
      // 🤝 開催中の取引は席に着いた瞬間にも出す（毎秒の zero_state と同じ形）。
      //    走行は120秒・取引は60秒なので、走行の切れ目に当たっただけで
      //    1票も投じられないままだった（人間1票＝住人5票ぶん）。
      deal: found.deal
        ? { ...found.deal, voted: !!(run.deal && run.deal.humanVotes && e.ws.user
            && run.deal.humanVotes[e.ws.user.id]) }
        : null,
    });
  }

  // 枠(スロット)ごとに1部屋。run は世界で1本なので、同じ run で生きている
  // セッションがあれば、それがその枠の部屋。
  // 再読み込みなどで run オブジェクトが差し替わっても、同じ日の同じモードなら
  // 同じ枠として扱う（dayKey + modeId で識別）。
  function zeroLiveSessionFor(run) {
    if (!run) return null;
    for (const sess of zeroSessions.values()) {
      if (sess.ended || !sess.run) continue;
      if (sess.run === run) return sess;
      if (sess.run.dayKey === run.dayKey && sess.run.modeId === run.modeId) return sess;
    }
    return null;
  }

  function startZeroSession(humanSocks, run) {
    if (!run) return null;
    if (!run.dayKey) run.dayKey = String(run.dayKey || '');
    // 枠(スロット)ごとに1部屋。生きている部屋があれば作り直さず**合流**する。
    //
    // ここで毎回 createSession していたせいで、同じ枠にN人いるとN個の別部屋が
    // でき、各部屋が11体の住人を抱えて同じ共有HPを削っていた（火力はほぼN倍
    // なのにHPは1人ぶん）。s.humans が恒久的に 1 だったので、人数ぶんHPを重く
    // する補正も、回復量を断罪の本数で割る補正も、満席案内も、完全勝利の演出も、
    // 全部そこで死んでいた。
    const live = zeroLiveSessionFor(run);
    if (live) {
      for (const ws of humanSocks) {
        const seat = zeroAddHuman(live, ws, zeroDeps(live), run);
        // 入れなかった人には正直に伝える（黙って落とさない）
        if (!seat) { send(ws, { type: 'error', error: 'アリーナが満席です。次の枠でお待ちしています' }); continue; }
        zeroSeatIn(seat, live, run);
      }
      return live;
    }
    // run を渡すと、処刑済みの住人（run.fallen）が同じ日のうちに再着席しないよう
    // 抽選から除外できる（説明文「その日はもう戻ってきません」との整合）。
    const sess = createZeroSession(zeroDeps(null), humanSocks, run);
    // どの枠の部屋かを覚えておく（zeroLiveSessionFor が合流先を探すのに使う）
    sess.run = run;
    zeroSessions.set(sess.id, sess);
    for (const e of sess.entrants) {
      if (!e.human) continue;
      zeroSeatIn(e, sess, run);
    }
    // 入れなかった人には正直に伝える（黙って落とさない）
    for (const ws of sess.overflow || []) {
      send(ws, { type: 'error', error: 'アリーナが満席です。次の枠でお待ちしています' });
    }
    sess.tick = setInterval(() => {
      const r = db.meta.adminEventRun;
      if (!r || sess.ended) { endZeroSession(sess); return; }
      // run が差し替わった（日が変わった／別モードの回になった）ら、この部屋は
      // もう別の枠のもの。畳んで新しい部屋に譲る ── 残しておくと、この tick が
      // 新しい run を削り始めて、2部屋が同じ共有HPを叩く状態（C4 で直したもの）に
      // 戻ってしまう。zeroLiveSessionFor の「生きている部屋＝同じ枠」も
      // この後始末があって初めて成り立つ。
      if (sess.run && (sess.run.dayKey !== r.dayKey || sess.run.modeId !== r.modeId)) {
        endZeroSession(sess); return;
      }
      // 誰も見ていない部屋は畳む（住人だけの部屋を回し続けない）
      // 抜けた人(e.left)は「見ている」に数えない。数えていたので、
      // 席に印が付いただけの部屋が永久に回り続けていた。
      const watching = sess.entrants.some(e => e.human && !e.left && e.ws && e.ws.readyState === e.ws.OPEN);
      if (!watching) { endZeroSession(sess); return; }
      try { tickZero(sess, r, zeroDeps(sess)); } catch (err) { console.error('[zero] tick:', err && err.message); }
    }, ZERO_TICK);
    return sess;
  }

  // 席を外れる／部屋を畳む。以前は zero_leave も切断も「席に印を付ける」
  // だけで、tick を止めておらず zeroSessions からも消していなかった。
  // 畳む判定も e.left を見ていなかったので、1本のソケットから5部屋が
  // 同時に生き続けることを実測で確認している。
  function zeroSeatOut(ws) {
    const sess = ws.zeroId ? zeroSessions.get(ws.zeroId) : null;
    ws.zeroId = null;
    if (!sess) return;
    const e = sess.entrants.find(x => x.ws === ws);
    if (e) { e.alive = false; e.left = true; }
    // 1人抜けても、まだ誰かが見ているなら部屋は畳まない（枠ごとに1部屋）。
    // sess.humans は**下げない** ── 段のHPは人数ぶん重くなっており、抜けた
    // ぶんだけHPを下げると、すでに与えたダメージを巻き戻すのと同じことになる。
    // 「一度与えたダメージは巻き戻さない」という既存方針（adminevent の侵攻ボス
    // ・共闘の閾値と同じ）に合わせて据え置く。
    //
    // 生身が誰も居なくなったら、その場で畳む（次の tick を待たない）
    if (!sess.entrants.some(x => x.human && !x.left && x.ws && x.ws.readyState === x.ws.OPEN)) {
      endZeroSession(sess);
    }
  }

  function endZeroSession(sess) {
    if (!sess || sess.ended) return;
    sess.ended = true;
    if (sess.tick) clearInterval(sess.tick);
    sess.tick = null;
    zeroSessions.delete(sess.id);
  }

  function zeroSessionOf(ws) {
    return ws.zeroId ? zeroSessions.get(ws.zeroId) || null : null;
  }

  // ---- 👁️ 管理者ゼロ の声 ----
  //
  // ゼロはHPバーではなくキャラクターなので、喋る口が要る。実体は postChat の
  // from を差し替えるだけ。名前は登録できないよう予約してあるので、
  // 他人がゼロを騙ることはできない。
  //
  // 憑依: るみまきさんが管理画面から打った文字は、この同じ口から出る。
  // 自動台詞より先にこれを作るのが正しい順序 —— 実装はほぼ無いのに、
  // 「今日のゼロ、なんか喋りが違う」が起きるのはこちらだけ。
  const ZERO_NAME = '管理者ゼロ';
  function zeroChat(text, en) {
    if (!text) return null;
    // tr は { lang, text, engine } の形。素の文字列を渡していたので、
    // 英語面でゼロの発言だけ翻訳が出ていなかった。
    return postChat(ZERO_NAME, String(text).slice(0, 300), {
      role: 'zero',
      // 憑依（運営の自由文）には対訳が無い。ここだけは辞書翻訳でも出したほうが
      // 英語側に何も届かないよりましなので、自動翻訳を許す。
      autoTr: !en,
      // engine は実プレイヤーの翻訳と同じ値にそろえる（crowd.js の注記と同じ理由 ──
      // ここだけ別の値だと「翻訳」「簡易翻訳」のラベルで話者の素性が割れる）。
      ...(en ? { tr: { lang: 'en', text: String(en).slice(0, 300), engine: TRANSLATE_ENGINE } } : {}),
    });
  }
  // 台詞テーブルから1行選んで喋る（日英そろって出る）
  function zeroSpeak(kind, danIndex, ctx = {}) {
    const line = zeroSay(kind, moodFor(danIndex | 0), ctx);
    if (!line) return null;
    return zeroChat(line.ja, line.en);
  }

  // ---- reactions (絵文字スタンプ) ----
  // One reaction per person per message; picking the same emoji again removes
  // it, a different one moves it. Ownership is keyed by a STABLE identity
  // (account id / connection id / resident id) kept server-side only, so a
  // guest who renames themselves to match another player cannot forge or
  // remove that player's reactions. Display names are just labels.
  const REACT_EMOJI = ['👍', '😂', '🔥', '💖', '😮', '🎉', '😭', '👏'];
  const reactOwners = new Map();   // msgId -> Map(ownerKey -> { emoji, name })

  function pushHistory(entry) {
    chatHistory.push(entry);
    if (chatHistory.length > 60) {
      const old = chatHistory.shift();
      if (old && old.id) reactOwners.delete(old.id);
    }
    persistChat();
  }

  // 盤面は長さ64だけを見て中身は素通しだった。巨大な文字列を64個詰めれば
  // 1回約250KB を他人へ中継させられる。数値以外は落とす。
  // 上限は 9 まで。8 で切っていたので、お邪魔ブロック（engine.js が 9 を
  // 書き込む・PALETTE の 9 番が灰色のお邪魔）が中継の途中で 0＝空きマスに
  // 化けていた。ボットの盤面は snapshot() を素通しで 9 が残るため、
  // 同じ画面で「人間の盤面だけお邪魔が見えない」という食い違いになり、
  // 相手を埋めるのが全ての💥アタック戦で攻撃が刺さったか読めなくなる。
  // PALETTE は 9 番までしか無いので、これ以上は広げないこと。
  function sanitizeGrid(g) {
    if (!Array.isArray(g)) return null;
    const out = new Array(64);
    for (let i = 0; i < 64; i++) {
      const v = Math.floor(Number(g[i]));
      out[i] = Number.isFinite(v) && v >= 0 && v <= 9 ? v : 0;
    }
    return out;
  }

  function reactOwnerKey(ws) {
    if (ws.user) return `u:${ws.user.id}`;
    if (!ws.reactId) ws.reactId = crypto.randomUUID();
    return `g:${ws.reactId}`;
  }

  function applyReaction(entry, ownerKey, name, emoji) {
    let owners = reactOwners.get(entry.id);
    if (!owners) { owners = new Map(); reactOwners.set(entry.id, owners); }
    // 参加者数に上限。以前は無制限で、1リアクションごとに全所有者名の配列を
    // 全クライアントへ再送していたため、接続を増やすだけで送信量を膨らませられた
    // （500接続で1人あたり約1MB）。
    if (owners.size >= 200 && !owners.has(ownerKey)) return;
    const prev = owners.get(ownerKey);
    if (prev && prev.emoji === emoji) owners.delete(ownerKey);
    else owners.set(ownerKey, { emoji, name });
    const reacts = {};
    for (const { emoji: em, name: nm } of owners.values()) (reacts[em] = reacts[em] || []).push(nm);
    entry.reacts = reacts;
    broadcastAll({ type: 'react', msgId: entry.id, reacts });
  }

  // A real player's message draws resident stamps — the chat feels watched
  // (in the good way). Emoji choice loosely follows the message's vibe.
  function reactEmojiFor(text) {
    if (/gg|おつ|勝った|かった|win|clear|クリア|できた|update|更新|おめ/i.test(text)) return ['🎉', '👏', '🔥', '💖'];
    if (/負け|まけた|むり|無理|つら|しんど|lose|dead/i.test(text)) return ['😭', '💖', '😮'];
    if (/[wｗ]{2,}|草|笑|lol|haha|lmao/i.test(text)) return ['😂', '😂', '👍'];
    return ['👍', '🔥', '💖', '😂', '😮'];
  }

  function maybeResidentReacts(entry) {
    if (!crowdOn('reactions') || Math.random() > 0.5) return;
    const active = worldCtx().active;
    if (!active.length) return;
    const pool = active.slice();
    const emojis = reactEmojiFor(entry.text);
    const n = 1 + (Math.random() < 0.35 ? 1 : 0) + (Math.random() < 0.12 ? 1 : 0);
    for (let i = 0; i < n && pool.length; i++) {
      const r = pool.splice((Math.random() * pool.length) | 0, 1)[0];
      setTimeout(() => {
        try {
          if (!crowdOn('reactions')) return;
          const cur = chatHistory.find(e2 => e2.id === entry.id);
          if (cur) applyReaction(cur, `r:${r.id}`, r.name, emojis[(Math.random() * emojis.length) | 0]);
        } catch (err) { console.error('[crowd] react failed:', err.message); }
      }, 2500 + Math.random() * 12000);
    }
  }

  // Replying to a resident's message asks *that* resident to answer — when
  // they are still around. Residents have online hours, so one who has gone
  // for the night is not in ctx.active and someone else picks it up instead.
  // （「必ず本人が答える」と書いていたが、実装はそうではなかった。住人に
  //   在席の時間帯があるのは世界設定として正しく、名簿全体から強制的に
  //   喋らせると「常に居る」ことになって秘匿の方向にも逆行する ── 直すのは
  //   実態に合わせるこのコメントのほう。）
  // The category/language are judged from the RAW text (a prefixed name would
  // break the ^-anchored reply rules and language detection); the target is
  // forced via chooseReplies' mention slot. Per-socket cooldown keeps a
  // rapid-fire replier from turning the cast into an echo chamber.
  function forceResidentReply(ws, name, text) {
    if (!crowdOn('reactions')) return;
    if (Date.now() - (ws.forcedReplyAt || 0) < 5000) return;
    ws.forcedReplyAt = Date.now();
    const replies = chooseReplies(text, Date.now(), name);
    if (replies.length) performScript(replies, 'reactions');
  }

  // Legacy entry point (admin "say"): a resident says `text`, or improvises.
  function postAmbient(text) {
    const line = residentLine();
    // 運営が文面を指定したときだけ辞書翻訳を許す（住人の自動発言は素材の
    // ネイティブ対訳だけを使う）。
    return postChat(line.name, text || line.text,
      text ? { autoTr: true } : (line.tr ? { tr: line.tr } : {}));
  }

  // Run a scripted list of [{ resident|name, text, delay }] with its timing.
  // force: 運営の「テスト」ボタン専用。静かな時間帯（isQuietNow）も迂回する。
  //   key に null を渡せばトグルは迂回できたが、crowdOn の `!isQuietNow()` は
  //   迂回できず、「いますぐ1つ流して動作を確かめます」と書いてあるボタンが
  //   結果欄には成功と出しながらチャットには1行も流さない、という状態だった
  //   （'line' と 'feed' は postChat / postFeed を直接叩くので動いていて、
  //    押した3つだけ壊れているように見えた）。
  function performScript(script, key = 'chat', force = false) {
    for (const s of script) {
      setTimeout(() => {
        if (!force && !crowdOn(key)) return;
        postChat(s.resident ? s.resident.name : s.name, s.text, s.tr ? { tr: s.tr } : {});
      }, s.delay);
    }
  }

  // Seed a little back-history so the chat never looks dead on first open.
  if (effectiveScale()) {
    let t = Date.now() - 25 * 60 * 1000;
    const ctx = worldCtx({ now: t });
    for (let i = 0; i < 8; i++) {
      t += (1.5 + Math.random() * 3) * 60 * 1000;
      const line = residentLine(null, t);
      const entry = { type: 'chat', id: crypto.randomUUID(), from: line.name, role: 'user', text: line.text, at: Math.min(t, Date.now() - 30000) };
      if (line.tr) entry.tr = line.tr;
      // 起動時のシード履歴でも王者には王冠を（ライブ発言と見た目を揃える）
      const crowns = db.meta.thrones ? Object.values(db.meta.thrones).filter(th => th && th.username === line.name).length : 0;
      if (crowns) entry.crown = crowns;
      chatHistory.push(entry);
    }
    // ⏱ 必ず時刻順に並べ直す。
    //
    //    chatHistory には、この上でディスクから戻した**実プレイヤーの発言**が
    //    既に入っている（db.meta.chatLog）。そこへ 25分前〜30秒前のシードを
    //    push しただけだと、古い住人の発言が新しい実発言の**後ろ**に並ぶ。
    //    クライアント（public/js/chat.js の hello_ok）は配列順にそのまま積むので、
    //    再起動直後に繋いだ人の画面ではタイムスタンプが逆行し、自分の直前の
    //    発言が古い発言より上に出る（返信の引用も一緒にずれる）。
    chatHistory.sort((a, b) => (a.at || 0) - (b.at || 0));
    // 読み込み時と同じ上限に収め直す（8本足したぶんだけ古い側を落とす）。
    if (chatHistory.length > 60) chatHistory.splice(0, chatHistory.length - 60);
    void ctx;
  }

  // Chat cadence: busier crowd → shorter gaps. Dialogues are rarer.
  let lastDialogueAt = 0;
  const directChat = () => {
    // Absolute floor keeps a ×100 crowd lively without a broadcast storm.
    // 🧮 popFactor は内部で 4 に張り付くので、×20 以上はどれだけ人数を増やしても
    //    発言間隔が 11.3秒 で固定だった（37万人でも150万人でも 1時間に320発）。
    //    しかも高倍率では深夜も上限4に届くため、午前4時のロビーが21時と
    //    同じ速さで喋っていた。crowdPace は「時間帯の起伏 × 世界の大きさ」なので
    //    人数で伸び続け、夜は必ず静かになる（×1 は従来と完全に同値）。
    const gap = Math.max(chatFloorMs(2500), (20000 + Math.random() * 50000) / chatPaceFactor() / crowdDiv());
    setTimeout(() => {
      try {
        if (crowdOn('chat')) {
          const wantDialogue = toggles().dialogues && Date.now() - lastDialogueAt > 150000 && Math.random() < 0.3;
          const script = wantDialogue ? composeDialogue(worldCtx({ humans: humanNames() })) : null;
          if (script) {
            lastDialogueAt = Date.now();
            performScript(script, 'chat');
          } else {
            const line = residentLine();
            postChat(line.name, line.text, line.tr ? { tr: line.tr } : {});
          }
        }
      } catch (err) { console.error('[crowd] chat tick failed:', err.message); }
      directChat();
    }, gap);
  };
  directChat();

  // Live feed: what residents are "doing" around the arena.
  function postFeed(item) {
    const entry = { type: 'feed', ...item, at: item.at || Date.now() };
    feedHistory.push(entry);
    if (feedHistory.length > 40) feedHistory.shift();
    broadcastAll(entry);
    return entry;
  }
  const directFeed = () => {
    // 🧮 ライブフィードも発言と同じ理由で crowdPace に寄せる（上の directChat のコメント参照）。
    const gap = Math.max(chatFloorMs(6000), (25000 + Math.random() * 60000) / chatPaceFactor() / crowdDiv());
    setTimeout(() => {
      try {
        if (crowdOn('feed')) {
          const item = composeFeed(worldCtx());
          if (item) postFeed(item);
        }
      } catch (err) { console.error('[crowd] feed tick failed:', err.message); }
      directFeed();
    }, gap);
  };
  directFeed();
  // A handful of items so the ticker isn't empty on first load.
  if (effectiveScale()) {
    let t = Date.now() - 20 * 60 * 1000;
    for (let i = 0; i < 6; i++) {
      t += (2 + Math.random() * 3) * 60 * 1000;
      const item = composeFeed(worldCtx({ now: t }));
      if (item) feedHistory.push({ type: 'feed', ...item, at: Math.min(t, Date.now() - 20000) });
    }
  }

  // Residents vote in open polls with real opinions: archetype + keyword
  // tastes, a stable personal lean, bandwagon/contrarian streaks, guild
  // solidarity and per-resident timing (early birds vs deadline voters).
  // Swing voters defect late when their pick is losing, and someone calls out
  // the deadline. Unlike chat, votes keep trickling in even while no real
  // player is connected — a long poll shouldn't come back empty.
  const votesOn = () => effectiveScale() > 0 && !isQuietNow() && toggles().votes;

  // Votes already cast by the resident's ghost-guildmates ({optionId: n}).
  // Uses deps.residentGuildTag (pure ghost-guild lookup, no db.users scan)
  // memoized per tick — the naive per-voter tagOfName walk measurably stalled
  // the event loop once the roster grew and accounts piled up.
  const guildVotesFor = (poll, resident, tagMemo) => {
    if (!deps.residentGuildTag) return null;
    const tagOfResident = (name) => {
      if (!tagMemo.has(name)) tagMemo.set(name, deps.residentGuildTag(name));
      return tagMemo.get(name);
    };
    const myTag = tagOfResident(resident.name);
    if (!myTag) return null;
    const votes = {};
    let any = false;
    for (const [voter, opt] of Object.entries(poll.voters)) {
      if (!voter.startsWith('r:')) continue;
      const other = residentById(voter.slice(2));
      if (!other || other.id === resident.id) continue;
      if (tagOfResident(other.name) === myTag) { votes[opt] = (votes[opt] || 0) + 1; any = true; }
    }
    return any ? votes : null;
  };

  // Cast (or change) a resident's vote, remember their archetype for the
  // admin breakdown, and sometimes have them say so in chat.
  const castResidentVote = (poll, r, optionId, ctx, kind) => {
    if (!optionId || !pollVote(poll, `r:${r.id}`, optionId).ok) return false;
    if (!poll.voterMeta) poll.voterMeta = {};
    poll.voterMeta[`r:${r.id}`] = r.arch;
    deps.saveDb();
    if (Math.random() < 0.18) {
      const opt = poll.options.find(o => o.id === optionId);
      // opt はオブジェクトで渡す — renderSlot が言語別に text/textEn を選ぶ
      performScript(composeReaction(kind, ctx, { opt: opt || '', only: [r.id] }, 1), 'chat');
    }
    return true;
  };

  const directVotes = () => {
    setTimeout(() => {
      try {
        const poll = deps.db.meta.poll;
        if (votesOn() && poll && pollIsOpen(poll)) {
          const ctx = worldCtx();
          const elapsed = (Date.now() - poll.createdAt) / Math.max(1, poll.endsAt - poll.createdAt);
          // Fresh voters whose personal moment has arrived (a busier arena
          // lets more of them through per tick).
          const tagMemo = new Map();
          // 投票は「いま画面の前にいる住人」ではなく、登録済みの住人ぜんぶが
          // 対象。投票は一日のうちの自分のタイミングで済ませるものなので、
          // オンライン中の数十人に絞ると票数が実人口とかけ離れて少なくなる。
          // （residentVoteAt が投票期間内に一人ずつ散らしてくれる）
          const voters = getRoster().filter(r => r.registered);
          const due = voters.filter(r => !poll.voters[`r:${r.id}`] && elapsed >= residentVoteAt(poll, r));
          const burst = Math.min(due.length, 2 + Math.floor(popFactor() * 2));
          for (let i = 0; i < burst && due.length; i++) {
            if (Math.random() > 0.75) continue;
            const r = due.splice(Math.floor(Math.random() * due.length), 1)[0];
            castResidentVote(poll, r, residentChoice(poll, r, { guildVotes: guildVotesFor(poll, r, tagMemo) }), ctx, 'poll_voted');
          }
          // Deadline call-out, once per poll — only consumed while someone is
          // actually connected to hear it (performScript's chat gate would
          // otherwise drop the lines and the flag would burn for nothing).
          if (elapsed >= 0.82 && !poll.lastCall && clients.size > 0) {
            poll.lastCall = true;
            deps.saveDb();
            performScript(composeReaction('poll_lastcall', ctx, {}, 2), 'chat');
          }
          // Swing voters: near the end, someone on a clearly-losing option
          // defects to the leader (it reads social, not random).
          if (elapsed >= 0.7 && elapsed < 0.97 && Math.random() < 0.25) {
            const votesOf = id => { const o = poll.options.find(x => x.id === id); return o ? o.votes : 0; };
            const leader = poll.options.reduce((a, o) => (o.votes > a.votes ? o : a), poll.options[0]);
            if (leader.votes > 0) {
              const cands = ctx.active.filter(r => {
                const cur = poll.voters[`r:${r.id}`];
                return cur && cur !== leader.id && votesOf(cur) * 2 <= leader.votes && isSwingVoter(poll, r);
              });
              if (cands.length) {
                const r = cands[Math.floor(Math.random() * cands.length)];
                castResidentVote(poll, r, leader.id, ctx, 'poll_swing');
              }
            }
          }
        }
      } catch (err) { console.error('[crowd] vote tick failed:', err.message); }
      directVotes();
    }, 15000 + Math.random() * 25000);
  };
  directVotes();

  // Residents answer real messages (rate-limited so they never spam).
  let replyCooldownUntil = 0;
  function maybeAmbientReply(text) {
    if (!crowdOn('reactions')) return;
    if (Date.now() < replyCooldownUntil) return;
    if (Math.random() > 0.85) return;
    const replies = chooseReplies(text);
    if (!replies.length) return;
    replyCooldownUntil = Date.now() + 12000;
    performScript(replies, 'reactions');
  }

  // Someone real just arrived: maybe a resident says hi.
  let lastGreetAt = 0;
  function maybeGreet(ws) {
    if (!crowdOn('greetings')) return;
    if (Date.now() - lastGreetAt < 150000 || Math.random() > 0.45) return;
    lastGreetAt = Date.now();
    const named = !!ws.user && Math.random() < 0.6;
    const script = composeReaction(named ? 'greet_named' : 'greet_plain', worldCtx(), { you: sockName(ws) }, 1);
    performScript(script, 'greetings');
  }

  // Reactions to world moments: events, polls, real players' achievements.
  function react(kind, extra = {}, count) {
    if (!crowdOn('reactions')) return [];
    const n = count || (kind === 'event_start' ? 3 : kind === 'poll_open' ? 2 : kind === 'champion' ? 2 : 1);
    const script = composeReaction(kind, worldCtx(), extra, n);
    performScript(script, 'reactions');
    return script;
  }

  // After a match: the resident who played as a bot comments on the human.
  let lastMatchReactAt = 0;
  function reactToMatch(resident, humanName, outcome, mode) {
    if (!crowdOn('reactions')) return;
    if (Date.now() - lastMatchReactAt < 45000 || Math.random() > 0.4) return;
    lastMatchReactAt = Date.now();
    const kind = mode === 'coop' ? 'coop_done' : outcome === 'human_won' ? 'lost_to' : outcome === 'draw' ? 'drew' : 'beat';
    const script = composeReaction(kind, worldCtx(), { you: humanName, only: [resident.id] }, 1);
    if (script.length) {
      script[0].delay = 8000 + Math.random() * 30000;
      performScript(script, 'reactions');
    }
  }

  // Live population sync: keep every client's counters in agreement.
  setInterval(() => {
    if (clients.size > 0) {
      broadcastAll({ type: 'online', online: displayOnline(), matches: displayMatches(), queueing: ambientQueue() + queueSizeAll(), mood: crowdMood().id });
    }
  }, 25000);
  function queueSizeAll() { return Object.values(queues).reduce((a, q) => a + q.length, 0); }

  // 🔇 このソケットの持ち主がミュートされているか。
  //    同じ式を3か所に書き写していたので、4か所目（絵文字）だけ書き忘れて
  //    抜け穴になっていた。以後は必ずここを通す。
  function isMuted(ws) {
    const u = ws && ws.user ? db.users[ws.user.id] : null;
    return !!(u && u.muted);
  }

  function sockRate(ws, key, limit, windowMs) {
    const now = Date.now();
    ws[key] = (ws[key] || []).filter(t => now - t < windowMs);
    if (ws[key].length >= limit) return false;
    ws[key].push(now);
    return true;
  }

  function sockName(s) { return s.isBot ? s.name : (s.user ? s.user.username : s.guestName); }
  function sockLevel(s) {
    if (s.isBot) return s.fakeLevel;
    return s.user && db.users[s.user.id] ? levelOf(db.users[s.user.id].xp) : 1;
  }
  function sockRating(s) {
    if (s.isBot) return s.rating;
    return s.user && db.users[s.user.id] ? db.users[s.user.id].stats.rating : null;
  }

  // -------------------------------------------------------------------------
  // 🎭 対戦カードの任意欄（称号・ギルドタグ・直近の戦績）
  // -------------------------------------------------------------------------
  // 画面（public/js/modes.js の VS_CARD_EXTRAS）は「並ぶ全員がその欄を持つとき
  // だけ行ごと出す」。つまり **片側にだけ欄がある状態を作らない**ことが、この
  // 3つを出してよい条件そのもの。だから席の種類（実プレイヤー／住人／使い捨て）
  // で分岐せず、下の3つを **全席に必ず同じ規則で**載せる。
  // 値が null になるのは「アカウントを持っていない席（ゲスト）」と
  // 「その欄を持っていない人」だけで、どちらも人間にも普通に起きる。
  //
  // ボット側の値は Bot のコンストラクタが ambient.seatProfile で作る（住人でも
  // 使い捨てでも同じ関数を通る）。ここは実プレイヤーぶんの出典を index.js と
  // そろえるだけ。
  function sockUser(s) {
    return !s.isBot && s.user && db.users[s.user.id] ? db.users[s.user.id] : null;
  }
  function sockTitle(s) {
    if (s.isBot) return s.title || null;
    const u = sockUser(s);
    if (!u) return null;
    // index.js の titleOf と同じ。id を落とすと画面が英語名を引けない。
    const t = TITLES.find(x => x.id === u.equippedTitle);
    return t ? { id: t.id, name: t.name, color: t.color } : null;
  }
  function sockGuild(s) {
    if (s.isBot) return s.guild || null;
    const u = sockUser(s);
    const g = u && u.guildId ? db.guilds[u.guildId] : null;
    // 出すのはタグ（4文字）だけ。ギルドの実体を渡すと ghost:true が混ざる。
    return g && typeof g.tag === 'string' ? g.tag : null;
  }
  function sockRecord(s) {
    if (s.isBot) return s.record || null;
    const u = sockUser(s);
    if (!u || !u.stats) return null;
    return { w: u.stats.pvpWins || 0, l: u.stats.pvpLosses || 0 };
  }
  // 🎨 その席が装備しているブロック。**必ず文字列を返す**（null にしない）。
  //    送信は JSON.stringify なので undefined のキーは消える ── 欄の有無が
  //    そのまま「実プレイヤー／住人」の選り分けになる。値が既定でもキーは残す。
  //    住人側は seatProfile が名前から決め打ちしたものを sock.skin に持っている。
  function sockSkin(s) {
    if (s.isBot) return s.skin || DEFAULT_EQUIPPED.skin;
    const u = sockUser(s);
    const id = u && u.equipped && u.equipped.skin;
    // 実プレイヤー側も、持っていない物を装備したままの記録が来たら既定に落とす
    // （復元や手編集で入りうる。受け取る側の themes.js でも弾いているが、
    //  そもそも配らないほうが早い）。
    const item = SHOP_ITEMS.find(i => i.id === id && i.cat === 'skin');
    if (!item) return DEFAULT_EQUIPPED.skin;
    if (!u.owned || !u.owned.includes(id)) return DEFAULT_EQUIPPED.skin;
    return id;
  }

  // -------------------------------------------------------------------------
  // Bots — disguised as normal players: human-like persona names, a fake
  // rating/level that matches their strength, and randomized strength.
  // -------------------------------------------------------------------------

  const BOT_LEVELS = ['easy', 'normal', 'hard', 'oni'];
  function randomBotLevel() {
    const r = Math.random();
    return r < 0.28 ? 'easy' : r < 0.62 ? 'normal' : r < 0.88 ? 'hard' : 'oni';
  }
  const BOT_RATING = { easy: [720, 1020], normal: [980, 1300], hard: [1240, 1600], oni: [1520, 1950] };
  const BOT_LVL = { easy: [1, 7], normal: [5, 16], hard: [12, 30], oni: [22, 48] };
  const BOT_MOVE_MS = { easy: 2600, normal: 1700, hard: 1050, oni: 820 };
  // 👑 王者専用の段。BOT_LEVELS には**足さない** ── 足すと randomBotLevel や
  // 部屋の botLevel 設定から引けてしまい、「王者以外がこの強さで出る」ことに
  // なる。ここに置いてあるのは王者1人ぶんの例外で、他の住人の強さ
  // （BOT_LEVELS / BOT_MOVE_MS / BOT_RATING）は一切変えていない。
  //
  // souzou（創造神）= public/js/ai.js の最強手。手札の全順列を読むビームサーチ
  // （beam:14）で、鬼(oni)の約1.5倍のスコアを出す。手番間隔も ai.js の定義から
  // 読む（写経すると ai.js を触ったときにここだけ古くなる）。
  const CHAMPION_AI = 'souzou';
  // ⚠️ 手番間隔は ai.js の 380ms を**そのまま使わない**。
  //
  // 380ms は毎秒2.6手。2分間ミスなくこれを打ち続けられる人間は居ないので、
  // 「速すぎてボットだと分かる」という、このゲームで最も避けたい正体の露出に
  // 直結する（ユーザーからの指摘で判明）。強さは速さではなく手の質で作る。
  //
  // 700ms を選んだ根拠（120秒・21回試行の実測）:
  //   ・実効の間隔は Bot.startPlay のゆらぎ（0.75〜1.25倍）と8%の考え込み
  //     （1.2〜3.4秒）が乗るので、平均 約884ms ＝ 毎秒1.1手。
  //   ・いま既に居る最強ボット「鬼」が 820ms 基準＝毎秒1.00手なので、
  //     王者だけが不自然に速い、という見え方にならない。
  //   ・その条件で souzou の思考は鬼に対して勝率 92%。しかも比較相手の「鬼」は
  //     AIの完璧な置き方なので、実在の人間が相手ならさらに上回る。
  //
  // 注意: このゲームではスコアがほぼ手数で決まる（souzou の思考が上乗せするのは
  // 1手あたり約7%）。つまり「人間の速度で絶対に負けない」は原理的に作れない。
  // ユーザーの決定は「速さを人間の範囲に収め、戦績は実態に合わせる」。
  const CHAMPION_MOVE_MS = 700;
  const EMOTE_SET = ['👍', '🔥', '😂', '😭', '🎉', '😱', '💪', '😎', '👏', '🤯'];

  class Bot {
    constructor(level = 'random', used) {
      this.isBot = true;
      this.level = BOT_LEVELS.includes(level) ? level : randomBotLevel();
      // 👑 まれに王者が現れる（伝説枠）。ふつうの住人抽選からは外してあるので、
      // この1行を通らないかぎり対戦相手としては出てこない。遭遇率は
      // ambient.js の CHAMPION_ENCOUNTER で決める。
      const champ = pickChampionBot(used);
      // Prefer a resident whose rating matches this strength — the name you
      // beat in ranked is the same one chatting in the lobby and sitting on
      // the leaderboard. Fall back to a throwaway persona otherwise.
      const res = champ || (Math.random() < 0.7 ? pickResidentBot(this.level, used) : null);
      // アカウント持ちの席かどうか。両方の枝で決まるので手前に置いておく
      // （this に持たせない ── `registered` は sanitize.js が落とすキー名で、
      //  ソケットの持ち物としては正体を指す名前になってしまう）。
      let hasAccount = true;
      if (res) {
        this.resident = res.resident;
        this.name = res.name;
        this.rating = res.rating;
        this.fakeLevel = res.level;
        hasAccount = !!res.registered;
        // 王者だけ、引いた席の強さを捨てて専用AIに差し替える。
        // champion は「この socket が王者か」を endMatch が見る印でもある
        // （フィールド名に bot/ai/resident を使わないこと ── 送信フレームには
        //  載せないが、うっかり載せたときに正体を明かす名前にしておかない）。
        if (champ) {
          this.champion = true;
          this.aiLevel = CHAMPION_AI;
          this.moveMs = CHAMPION_MOVE_MS;
          // level は「BOT_LEVELS のどれか」を前提にしている読み手がいる
          // （大会のボット同士のコイン投げが rank 表で引く）。既知の最上位に
          // 揃えておかないと、王者が easy 席の抽選値のまま不戦敗しうる。
          this.level = 'oni';
        }
      } else {
        this.resident = null;
        const persona = pickPersona({ used });
        this.name = persona.name;
        const [rLo, rHi] = BOT_RATING[this.level];
        this.rating = persona.registered ? rLo + crypto.randomInt(rHi - rLo) : null;
        const [lLo, lHi] = BOT_LVL[this.level];
        this.fakeLevel = persona.registered ? lLo + crypto.randomInt(lHi - lLo) : 1;
        hasAccount = !!persona.registered;
      }
      // 🎭 称号・ギルドタグ・直近の戦績。**住人の席も使い捨ての席もここ1本**で
      // 作る ── 分けた瞬間に「欄の揃い方」で正体が割れる（第5波でこの3つを
      // 対戦カードから外したのがまさにその理由）。ゲスト表示の席（レート無し）は
      // 3つとも null になり、本物のゲストと見分けが付かなくなる。
      const prof = seatProfile({
        resident: this.resident,
        name: this.name,
        level: this.level,
        registered: hasAccount,
        guildTagOf: deps.residentGuildTag || null,
      });
      this.title = prof.title;
      this.guild = prof.guild;
      this.record = prof.record;
      this.skin = prof.skin;
      this.timer = null;
      this.emoteTimer = null;
    }

    startPlay(match, slot) {
      this.engine = new Engine(match.seed);
      // 👑 王者は aiLevel/moveMs を持つ（他の住人は従来どおり level から引く）。
      const aiLevel = this.aiLevel || this.level;
      const moveMs = this.moveMs || BOT_MOVE_MS[this.level] || 1700;
      const endAt = match.startedAt + (COUNTDOWN + match.duration) * 1000;
      const tick = () => {
        if (match.ended) return;
        if (Date.now() >= endAt) {
          finishPlayer(match, slot, this.engine.score, this.engine.linesCleared, this.engine.maxCombo);
          return;
        }
        if (this.engine.over) this.engine.reviveBoard();
        const mv = chooseMove(this.engine, aiLevel);
        if (mv) {
          const r = this.engine.place(mv.index, mv.row, mv.col);
          const p = match.players[slot];
          p.score = this.engine.score;
          p.lines = this.engine.linesCleared;
          // ⚔️ アタック戦ではボットも攻撃してくる
          if (r && match.mode === 'attack' && r.lineCount >= 2 && !match.ended) {
            const cells = attackCells(r.lineCount, r.streak);
            for (const q of match.players) {
              if (q.slot === slot || q.team === p.team) continue;
              deliverAttack(match, slot, q, cells, r.lineCount);
            }
          }
          broadcastState(match, slot, {
            score: this.engine.score,
            combo: r ? r.streak : 0,
            lines: this.engine.linesCleared,
            grid: this.engine.snapshot(),
          });
        }
        // Human-ish pacing: jitter plus an occasional longer "thinking" pause.
        const pause = Math.random() < 0.08 ? 1200 + Math.random() * 2200 : 0;
        this.timer = setTimeout(tick, moveMs * (0.75 + Math.random() * 0.5) + pause);
      };
      this.timer = setTimeout(tick, COUNTDOWN * 1000 + moveMs);
      this.scheduleEmote(match, slot);
    }

    scheduleEmote(match, slot) {
      this.emoteTimer = setTimeout(() => {
        if (match.ended) return;
        if (Math.random() < 0.55 && Date.now() > match.startedAt + COUNTDOWN * 1000) {
          const emoji = EMOTE_SET[crypto.randomInt(EMOTE_SET.length)];
          for (const p of match.players) {
            if (!p.sock.isBot) send(p.sock, { type: 'emote', slot, emoji });
          }
        }
        this.scheduleEmote(match, slot);
      }, 14000 + Math.random() * 26000);
    }

    stop() { clearTimeout(this.timer); clearTimeout(this.emoteTimer); }
  }

  // -------------------------------------------------------------------------
  // Matches (2 or 4 players, humans and/or bots)
  // -------------------------------------------------------------------------

  function createMatch({ mode, entries, duration, rated = true, tourney = null }) {
    const id = crypto.randomUUID();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const match = {
      id, mode, seed, rated, tourney,
      duration: duration || MATCH_DURATION,
      startedAt: Date.now(),
      ended: false,
      players: entries.map((e, i) => ({
        sock: e.sock, team: e.team, slot: i,
        // 試合開始時点の身分を固定する。試合中に token 無しの hello を送って
        // ゲスト化すると endMatch が p.sock.user を null と解決し、敗北・Elo・
        // pvpLosses を丸ごと回避（別 token なら他アカウントへ付け替え）できた。
        userId: (!e.sock.isBot && e.sock.user) ? e.sock.user.id : null,
        score: 0, lines: 0, maxCombo: 0, finished: false, forfeited: false,
        // 🔌 再接続の猶予中だけ入る札（openReconnectGrace / clearHold）。
        // 送信するフレームには載せないこと（タイマーを抱えている）。
        dc: null,
      })),
    };
    // Co-op: ONE board, alternating turns, refereed by the server.
    if (mode === 'coop') {
      match.engine = new Engine(seed);
      match.turn = 0;
      match.moves = 0;
      match.turnEndsAt = Date.now() + (COUNTDOWN * 1000) + COOP_TURN_MS;
    }
    // 🚩 陣取り: 協力と同じ1盤面だが、点は個人・消したラインは領土。
    if (mode === 'land') {
      match.engine = new Engine(seed);
      match.turn = 0;
      match.moves = 0;
      match.owner = new Array(LAND_CELLS).fill(0);
      match.turnEndsAt = Date.now() + (COUNTDOWN * 1000) + LAND_TURN_MS;
      match.landEndsAt = Date.now() + (COUNTDOWN + match.duration) * 1000;
    }
    // Raid: everyone fights one shared boss whose HP scales with party size.
    if (mode === 'raid') {
      const def = RAID_BOSSES[crypto.randomInt(RAID_BOSSES.length)];
      // 🐲 ボス襲来（期間限定イベント）の「ボスHP-20%」はレイドにも効かせる。
      // 同じイベントのもう一方の効果（コイン2倍）は applyGameResult の
      // isBossMode が 'raid' を含むのでレイドにも効いていたのに、HP のほうは
      // ソロのボス一覧（index.js の /api/bosses）にしか掛かっておらず、
      // 「同じイベントなのにレイドは半分だけ対象」という状態だった。
      // レイドは協力プレイでレート競技ではないので、公平性の問題も起きない。
      const hpMult = liveEventBonus().bossHp || 1;
      match.boss = { ...def, hp: Math.max(1, Math.round(def.hp * match.players.length * hpMult)) };
      match.bossDead = false;
    }
    matches.set(id, match);
    for (const p of match.players) {
      if (p.sock.isBot) continue;
      p.sock.matchId = id;
      // roomCode を代入で消すと room.players からは外れないので、その部屋は
      // 人数が 0 にならず rooms から永久に消えない（合言葉も再利用できない）。
      // 席から本当に外す。room 経由の開始は startRoom が先に部屋を畳んで
      // roomCode も null にしているので、ここは何もしない。
      leaveRoom(p.sock);
      send(p.sock, {
        type: 'match_found',
        matchId: id, mode, seed, duration: match.duration, countdown: COUNTDOWN,
        tourney: tourney ? { round: tourney.round, final: tourney.final } : null,
        boss: match.boss || null,
        you: { slot: p.slot, team: p.team },
        // isBot は運営にだけ載せる。関門（send）も落とすが、そもそも
        // 組み立てないのが正しい ── 対戦相手が住人かどうかは、盤面の外から
        // 分かってはいけない一番の情報。
        // 🎭 title / guild / record は**全席に必ず載せる**（値が null でも
        // キーは消さない）。欄の有無が席ごとに違うと、その差だけで
        // 「実プレイヤー／住人／使い捨て」を選り分けられてしまう。
        // 出典は sockTitle / sockGuild / sockRecord に1本化してある。
        players: match.players.map(q => ({
          slot: q.slot, team: q.team, name: sockName(q.sock),
          level: sockLevel(q.sock), rating: sockRating(q.sock),
          title: sockTitle(q.sock), guild: sockGuild(q.sock), record: sockRecord(q.sock),
          skin: sockSkin(q.sock),
          isYou: q === p,
          ...(sockAdmin(p.sock) ? { isBot: !!q.sock.isBot } : {}),
        })),
      });
    }
    // Co-op bots wait their turn instead of playing their own board.
    for (const p of match.players) if (p.sock.isBot && mode !== 'coop' && mode !== 'land') p.sock.startPlay(match, p.slot);
    if (mode === 'coop') {
      match.coopTick = setInterval(() => coopTick(match), 400);
      setTimeout(() => { if (!match.ended) coopBroadcast(match, null); }, COUNTDOWN * 1000);
    }
    // 🚩 陣取りも同じ作法（自分の盤面は持たず、手番を待つ）
    if (mode === 'land') {
      match.landTick = setInterval(() => landTick(match), 400);
      setTimeout(() => { if (!match.ended) landBroadcast(match, null); }, COUNTDOWN * 1000);
    }
    if (mode === 'raid') {
      // Server-driven boss attacks + HP sync.
      match.raidAtk = setInterval(() => {
        if (match.ended || match.bossDead) return;
        if (Date.now() - match.startedAt < COUNTDOWN * 1000) return;
        for (const p of match.players) {
          if (!p.sock.isBot && !p.forfeited) {
            send(p.sock, { type: 'raid_attack', cells: match.boss.atkCells });
          }
        }
      }, match.boss.atkSec * 1000);
      match.raidSync = setInterval(() => {
        if (match.ended) return;
        const hp = Math.max(0, match.boss.hp - totalDamage(match));
        for (const p of match.players) {
          if (!p.sock.isBot) send(p.sock, { type: 'raid_state', hp });
        }
        if (hp <= 0 && !match.bossDead) {
          match.bossDead = true;
          endMatch(match, 'boss_down');
        }
      }, 1000);
    }
    match.timer = setTimeout(() => endMatch(match, 'timeout'), (COUNTDOWN + match.duration + 12) * 1000);
    return match;
  }

  function totalDamage(match) {
    return match.players.reduce((a, p) => a + p.score, 0);
  }

  // -------------------------------------------------------------------------
  // Co-op: two players, one board, alternating turns.
  //
  // The server owns the engine so the two clients can never disagree. Clients
  // keep a mirror Engine seeded identically and replay each confirmed move, so
  // every placement animates locally exactly as a solo one would.
  // -------------------------------------------------------------------------

  function coopBroadcast(match, move) {
    const e = match.engine;
    for (const p of match.players) {
      if (p.sock.isBot) continue;
      send(p.sock, {
        type: 'coop_state',
        move,                                  // { slot, index, row, col } or null
        turn: match.turn,
        // Clocks differ between machines — ship a remaining duration, not a
        // timestamp, so the turn bar is right on every client.
        turnRemain: Math.max(0, match.turnEndsAt - Date.now()),
        turnMs: COOP_TURN_MS,
        score: e.score,
        lines: e.linesCleared,
        combo: e.streak,
        moves: match.moves,
        over: e.over,
        grid: e.snapshot(),                    // resync safety net
        // 盤面だけ直しても手札がズレたままだと、クライアントは持っていない
        // ピースを置こうとし続けてサーバーに弾かれる（時間切れまで詰む）。
        // 形の番号だけ送れば十分（cells/color は SHAPES から引ける）。
        hand: e.hand.map(p => (p ? p.shape : null)),
      });
    }
  }

  // Apply one move to the shared board. Returns false when it is illegal.
  function coopApply(match, slot, index, row, col, opts = {}) {
    const e = match.engine;
    if (match.ended || e.over) return false;
    if (match.turn !== slot) return false;
    if (Date.now() < match.startedAt + COUNTDOWN * 1000) return false;
    const piece = e.hand[index];
    if (!piece || !e.canPlace(piece, row, col)) return false;

    const result = e.place(index, row, col);
    if (!result) return false;
    match.moves++;
    // The score is shared, so both players carry the same totals; only the
    // per-player move count records who did what.
    match.players[slot].moves = (match.players[slot].moves || 0) + 1;
    for (const q of match.players) {
      q.score = e.score;
      q.lines = e.linesCleared;
      q.maxCombo = Math.max(q.maxCombo, e.maxCombo);
    }
    match.turn = (slot + 1) % match.players.length;
    match.turnEndsAt = Date.now() + COOP_TURN_MS;
    coopBroadcast(match, { slot, index, row, col, auto: !!opts.auto });
    if (e.over) {
      clearInterval(match.coopTick);
      setTimeout(() => endMatch(match, 'coop_over'), 900);
    }
    return true;
  }

  // Play the best move available for whoever's turn it is (bot turn, timeout,
  // or a disconnected partner) so a co-op run never deadlocks.
  function coopAutoMove(match) {
    const e = match.engine;
    const level = match.players[match.turn].sock.isBot ? (match.players[match.turn].sock.level || 'normal') : 'hard';
    const mv = chooseMove(e, level);
    if (!mv) {
      e.over = true;
      clearInterval(match.coopTick);
      coopBroadcast(match, null);
      setTimeout(() => endMatch(match, 'coop_over'), 900);
      return;
    }
    // 「サーバーが代わりに置いた」と分かるように印をつける。
    // これが無いと、自分の手番なのに勝手に石が置かれる。
    coopApply(match, match.turn, mv.index, mv.row, mv.col, { auto: true });
  }

  function coopTick(match) {
    if (match.ended || match.engine.over) return;
    if (Date.now() < match.startedAt + COUNTDOWN * 1000) return;
    const cur = match.players[match.turn];
    const isBot = cur.sock.isBot;
    // 切断済みの相棒はボット同様に即代打する（「残りはサーバーが代打します」）。
    // これを due 判定より前に見ないと、切断者の手番が毎回15秒フルに空転していた。
    const gone = !isBot && cur.sock.readyState !== cur.sock.OPEN;
    // Bots (and a disconnected partner) "think" for a beat; live humans get the full turn clock.
    const due = (isBot || gone)
      ? Date.now() >= match.turnEndsAt - COOP_TURN_MS + (COOP_BOT_THINK_MS)
      : Date.now() >= match.turnEndsAt;
    if (!due) return;
    coopAutoMove(match);
  }

  // -------------------------------------------------------------------------
  // 🚩 陣取りデュエル — 2人・1つの盤面・交互に打つ。消したラインが領土になる。
  //
  // 上の協力プレイ（サーバー権威の1盤面 ＋ クライアント側のミラー Engine ＋
  // 確定手のブロードキャスト）をそのまま**複製**したもの。違いは3つだけ:
  //   * 点は共有ではなく「打った人のもの」（協力は共有スコアが仕様）
  //   * ラインを消すと、その行／列の8マスが自分の色の領土になる。
  //     相手の領土も上塗りで奪える ── だから終盤まで逆転が残る。
  //   * 勝敗は時間切れ時の「領土数 → 同数ならスコア」
  // 協力側に mode 分岐を足さずに複製したのは、協力の「絶対にズレない」を
  // 一切触らないため。あちらは共有スコアが仕様で、こちらは per-player が仕様。
  //
  // owner は 64 要素（0=中立 / 1=slot0 / 2=slot1）。盤面のブロックとは別物で、
  // ラインが消えてマスが空になっても領土は残る。
  // -------------------------------------------------------------------------

  const LAND_TURN_MS = Number(process.env.LAND_TURN_MS) || 12000;
  const LAND_BOT_THINK_MS = 1500;
  const LAND_CELLS = 64;

  function landCounts(match) {
    const c = [0, 0];
    if (!match.owner) return c;
    for (const o of match.owner) { if (o === 1) c[0]++; else if (o === 2) c[1]++; }
    return c;
  }

  function landBroadcast(match, move) {
    const e = match.engine;
    const counts = landCounts(match);
    for (const p of match.players) {
      if (p.sock.isBot) continue;
      send(p.sock, {
        type: 'land_state',
        move,                                  // { slot, index, row, col, took } or null
        turn: match.turn,
        // 時計は機械ごとに違うので、協力と同じく「残り時間」で送る。
        turnRemain: Math.max(0, match.turnEndsAt - Date.now()),
        turnMs: LAND_TURN_MS,
        endsIn: Math.max(0, match.landEndsAt - Date.now()),
        scores: match.players.map(q => q.score),
        moves: match.moves,
        over: e.over,
        grid: e.snapshot(),                    // ズレたときの復旧用
        owner: match.owner.slice(),            // 領土（0/1/2）
        counts,                                // [slot0の領土数, slot1の領土数]
        hand: e.hand.map(q => (q ? q.shape : null)),
      });
    }
  }

  // 1手を共有盤面へ適用する。違法手なら false。
  function landApply(match, slot, index, row, col, opts = {}) {
    const e = match.engine;
    if (match.ended || e.over) return false;
    if (match.turn !== slot) return false;
    if (Date.now() < match.startedAt + COUNTDOWN * 1000) return false;
    const piece = e.hand[index];
    if (!piece || !e.canPlace(piece, row, col)) return false;

    const result = e.place(index, row, col);
    if (!result) return false;
    match.moves++;
    const p = match.players[slot];
    p.moves = (p.moves || 0) + 1;
    // 点は打った人のもの。engine.score は共有なので差分では取れない
    // （相手の手ぶんまで自分に入る）— 1手ぶんの gained をそのまま使う。
    p.score += result.gained || 0;
    p.lines = (p.lines || 0) + (result.lineCount || 0);
    p.maxCombo = Math.max(p.maxCombo, e.maxCombo);

    // 消した行／列の8マスを自分の領土にする。相手の領土も上塗りで奪う。
    const mark = slot + 1;
    let took = 0;
    for (const r of result.fullRows || []) {
      for (let c = 0; c < 8; c++) { const k = r * 8 + c; if (match.owner[k] !== mark) took++; match.owner[k] = mark; }
    }
    for (const c of result.fullCols || []) {
      for (let r = 0; r < 8; r++) { const k = r * 8 + c; if (match.owner[k] !== mark) took++; match.owner[k] = mark; }
    }

    match.turn = (slot + 1) % match.players.length;
    match.turnEndsAt = Date.now() + LAND_TURN_MS;
    landBroadcast(match, { slot, index, row, col, took, auto: !!opts.auto });
    // 盤面が詰んだら、そこで打ち切って領土で決める（時間切れを待たない）。
    if (e.over) {
      clearInterval(match.landTick);
      setTimeout(() => endMatch(match, 'land_over'), 900);
    }
    return true;
  }

  // 手番の人の代わりに打つ（ボットの手番／時間切れ／切断した相手）。
  // これが無いと1手で止まる。
  function landAutoMove(match) {
    const e = match.engine;
    const cur = match.players[match.turn];
    const level = cur.sock.isBot ? (cur.sock.level || 'normal') : 'hard';
    const mv = chooseMove(e, level);
    if (!mv) {
      e.over = true;
      clearInterval(match.landTick);
      landBroadcast(match, null);
      setTimeout(() => endMatch(match, 'land_over'), 900);
      return;
    }
    landApply(match, match.turn, mv.index, mv.row, mv.col, { auto: true });
  }

  function landTick(match) {
    if (match.ended) return;
    if (Date.now() >= match.landEndsAt) { endMatch(match, 'timeout'); return; }
    if (match.engine.over) return;
    if (Date.now() < match.startedAt + COUNTDOWN * 1000) return;
    const cur = match.players[match.turn];
    const isBot = cur.sock.isBot;
    // 切断した相手の手番はサーバーが即代打する（協力と同じ作法）。
    const gone = !isBot && cur.sock.readyState !== cur.sock.OPEN;
    const due = (isBot || gone)
      ? Date.now() >= match.turnEndsAt - LAND_TURN_MS + LAND_BOT_THINK_MS
      : Date.now() >= match.turnEndsAt;
    if (!due) return;
    landAutoMove(match);
  }

  function broadcastState(match, fromSlot, state) {
    // 👀 観戦席のために、最後の盤面をここで控える。ここは人間（'state'）も
    // ボット（startPlay）も必ず通る唯一の合流点なので、控える場所は1つで足りる。
    const from = match.players[fromSlot];
    if (from && Array.isArray(state.grid)) from.grid = state.grid;
    for (const p of match.players) {
      if (p.slot === fromSlot || p.sock.isBot) continue;
      send(p.sock, { type: 'opp_state', slot: fromSlot, ...state });
    }
  }

  // Anti-forge: a client cannot have scored faster than the match has actually
  // run. Same 500/sec ceiling royale (above) and the REST result path apply.
  // Without it, a rated duel / attack / team / tourney match decided its winner
  // — and the Elo, rank tier and win/loss both players took — purely from a
  // client-declared score, so one { type:'finish', score:999999 } (or a single
  // forged 'state' frame) stole the win and tanked the honest opponent's rating
  // every time. Bots feed their own authoritative engine score, so only
  // client-declared scores are capped.
  function matchScoreCap(match) {
    return Math.floor(Math.max(1, (Date.now() - match.startedAt) / 1000) * 500);
  }

  // 申告ライン数の上限。score だけ matchScoreCap で抑えて lines は素通しだった
  // ので、`state` を一度 { lines: 999999 } で送るだけで 'attack' 側の捏造対策
  //（atkLinesUsed が申告済み lines を超えられない）が丸ごと無意味になり、
  // 1ラインも消さずに 10秒で 108セルのお邪魔を相手の 8×8 盤へ流し込めた。
  // レート戦なので、そのまま Elo と pvpWins が正規に加算される。
  //
  // 毎秒5ラインという値はスコア上限から導いている: エンジンは1回の消去で
  // 必ず lineCount²×100（コンボ倍率は1以上）を加算するので、消したライン数の
  // 合計は常に score/100 以下。score が 500/秒 で頭打ちなら、ライン数は
  // どう積んでも 5/秒 を超えられない。開始直後の3秒はカウントダウンで
  // 誰も置けないぶんが丸ごと余裕になるので、正規プレイが引っかかることはない。
  const MAX_LINES_PER_SEC = 5;
  function linesCap(startedAt) {
    return Math.floor(Math.max(1, (Date.now() - startedAt) / 1000) * MAX_LINES_PER_SEC);
  }

  // ⚔️ 攻撃「威力」のバジェット。
  //
  // 上の linesCap（毎秒5ライン）だけでは 'attack' の突き合わせが一度も効かない。
  // attackCells は lines>=4 なら威力が頭打ち（base 6 ＋ コンボ最大3 ＝ 9セル）
  // なので、捏造する側は lines:8 ではなく lines:4 と申告するだけで、同じ9セルを
  // 半分の消費で撃てる。'attack' のレート制限は 12発/10秒＝1.2発/秒 だから
  // 消費は 1.2×4＝4.8ライン/秒 で上限 5ライン/秒 に届かず、バジェットは
  // 永久に尽きない ── 1ピースも置かないクライアントが毎秒 10.8セル
  //（＝1.2発×9セル）を相手の 8×8 盤へ流し込め、レート戦なので Elo も
  // pvpWins もそのまま成立していた。ライン申告の頭打ちは報酬側
  //（applyGameResult のライン系ミッション）の防御としては効いているので残し、
  // ここでは「実際に降らせたセル数」そのものを時間比例で縛る。
  //
  // 毎秒2セルの根拠（正直に遊んでいる人が絶対に届かない水準）:
  //   public/js/engine.js を実際に回して「攻撃セルの合計だけを最大化する」
  //   ビーム探索でプレイさせると 0.17セル/手。連続10手の最大でも 0.6セル/手、
  //   80手平均では 0.33セル/手。お邪魔が降ってくる実戦条件（毎手1〜3セル）
  //   ではさらに下がって 0.12〜0.07セル/手。人の設置速度は速い人でも毎秒1〜2手
  //   なので、正直な上限はおよそ 0.3〜1.2セル/秒。2セル/秒 はその2〜10倍の余裕。
  //   しかも linesCap と同じく「試合開始からの累積」なので、序盤に貯まった分で
  //   短いバーストはそのまま通る（毎秒の瞬間値では縛らない）。
  //   捏造側は 10.8 → 2セル/秒 と 8割減る。
  const MAX_ATK_CELLS_PER_SEC = 2;
  // 立ち上がりの余裕。攻撃はカウントダウン(3秒)明けまで弾かれるので実際は
  // 3×2＝6セルが最初から積まれているが、それに加えて最大威力(9セル)の初弾が
  // 必ず通るようにしておく。正直な人の攻撃が黙って消える（画面には「攻撃！」と
  // 出るのに相手に何も降らない）のが一番たちが悪いため。
  const ATK_CELLS_GRACE = 9;
  function atkCellsCap(startedAt) {
    return ATK_CELLS_GRACE + Math.floor(Math.max(0, (Date.now() - startedAt) / 1000) * MAX_ATK_CELLS_PER_SEC);
  }

  function finishPlayer(match, slot, score, lines = 0, maxCombo = 0) {
    const p = match.players[slot];
    if (!p || p.finished || match.ended) return;
    p.finished = true;
    let s = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
    if (!p.sock.isBot) s = Math.min(s, matchScoreCap(match));
    p.score = Math.max(p.score, s);   // monotonic — never below the last live frame
    // lines も score と同じ扱い。ここは報酬（applyGameResult のライン系ミッション）
    // に直結するので、締めの1フレームだけ捏造されると素通しになっていた。
    // ボットは自分の Engine の実測値を渡すので、頭打ちは人間の申告だけに効かせる。
    if (lines) {
      let l = Math.max(0, Math.floor(Number(lines) || 0));
      if (!p.sock.isBot) l = Math.min(l, linesCap(match.startedAt));
      p.lines = Math.max(p.lines, l);
    }
    if (maxCombo) p.maxCombo = Math.max(p.maxCombo, Math.floor(maxCombo));
    if (match.players.every(q => q.finished)) endMatch(match, 'finished');
  }

  function teamScores(match) {
    const t = [0, 0];
    for (const p of match.players) t[p.team] += p.score;
    return t;
  }

  function eloUpdate(ra, rb, scoreA /* 1 win, 0.5 draw, 0 loss */) {
    const K = 32;
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    return Math.round(K * (scoreA - ea));
  }
  // -------------------------------------------------------------------------
  // ⚔️ アタック戦 — ライン消しが相手へのお邪魔ブロックになる
  // -------------------------------------------------------------------------

  // 2ライン=2個 / 3ライン=4個 / 4ライン以上=6個、コンボで最大+3。1ラインは攻撃なし。
  function attackCells(lines, combo) {
    if (lines < 2) return 0;
    const base = lines >= 4 ? 6 : lines === 3 ? 4 : 2;
    return Math.min(9, base + Math.min(3, Math.floor(combo / 3)));
  }

  // lines = 撃った側が同時に消したライン数。**個数からは逆算できない**ので
  // 載せる ── attackCells(3, 6) と attackCells(4, 0) はどちらも6個になるため、
  // cells だけを見ている受け手は「相手が2ライン以上をまとめて消した」までしか
  // 言えなかった（public/js/modes.js の attackLesson が msg.lines を待っている）。
  function deliverAttack(match, fromSlot, p, cells, lines = 0) {
    if (!cells || match.ended) return;
    if (p.sock.isBot) {
      if (p.sock.engine) {
        p.sock.engine.addGarbage(cells);
        // 攻撃が刺さった盤面を即ミニボードへ（ボットの次ティックを待たない）
        broadcastState(match, p.slot, {
          score: p.sock.engine.score,
          combo: p.sock.engine.streak,
          lines: p.sock.engine.linesCleared,
          grid: p.sock.engine.snapshot(),
        });
      }
    } else {
      send(p.sock, { type: 'garbage', from: fromSlot, cells, lines });
    }
  }

  // 段位。しきい値は public/js/ranks.js が唯一の正解で、ここには表を持たない。
  // 以前は同じ数字を手書きで写していたので、帯を足したり動かしたりした瞬間に
  // 「画面ではグランドマスターなのに、サーバーはマスターとして扱う」が起きる
  // 状態だった（実際 ranks.js は8帯なのに、この表は6帯のまま止まっていた）。
  //
  // 帯の絵は ranks.js の band.icon（＝public/js/icons.js のアイコン名。
  // 'rank_gold' など）をそのまま送る。以前はここに絵文字の対応表を
  // 持っていたが、👑（マスター）は王座・管理者奧義・冠バッジと四重で、
  // 💠（プラチナ）は採掘場のクリスタルと同じだった。帯を足したときに
  // この表だけ更新を忘れる問題も同時に消える（ranks.js が唯一の正解）。
  // 全体告知の下限。この帯より上に **上がったとき** だけ世界に流す。
  const ANNOUNCE_FROM = 'gold';
  const announceMin = (RANK_BANDS.find(b => b.id === ANNOUNCE_FROM) || RANK_BANDS[0]).min;
  // 本人向けの表示は24段ぶん（ゴールドIII→II のような小さな昇格も出す）。
  // 全体告知は帯（8種）が上がったときだけ ── 段まで告知すると、告知の量が
  // そのまま3倍になってロビーが昇格通知で埋まる。
  const rankInfoOf = (r) => {
    const rk = rankOf(r);
    const band = bandOf(r);
    return {
      // クライアント(modes.js)が読む形。min は昇格/降格の向きの判定に使う。
      min: rk.min, icon: band.icon,
      name: rk.label, nameEn: rk.labelEn,
      // 全体告知に使う帯そのもの
      band: { id: band.id, min: band.min, name: band.name, nameEn: band.nameEn, icon: band.icon },
    };
  };

  // -------------------------------------------------------------------------
  // 🔁 再戦（リマッチ） — 対戦直後に同じ相手へ再挑戦
  // -------------------------------------------------------------------------
  const rematchOffers = new Map();   // id -> { mode, duration, until, sides: [{sock|null(bot), level, team, ready}] }

  function sweepRematches() {
    const now = Date.now();
    for (const [id, o] of rematchOffers) if (o.until < now) {
      // 待ちっぱなしの側に失効を通知（ボタンが永遠に「相手を待っています…」にならない）
      for (const sd of o.sides) {
        if (sd.ready && sd.sock && sd.sock.readyState === sd.sock.OPEN) send(sd.sock, { type: 'rematch_gone' });
      }
      rematchOffers.delete(id);
    }
  }

  function dropRematchesFor(ws, notifyOther = true) {
    for (const [id, o] of rematchOffers) {
      if (o.sides.some(sd => sd.sock === ws)) {
        if (notifyOther) {
          const other = o.sides.find(sd => sd.sock && sd.sock !== ws);
          if (other) send(other.sock, { type: 'rematch_gone' });
        }
        rematchOffers.delete(id);
      }
    }
  }


  function endMatch(match, reason) {
    if (match.ended) return;
    match.ended = true;
    clearTimeout(match.timer);
    clearInterval(match.raidAtk);
    clearInterval(match.raidSync);
    clearInterval(match.coopTick);
    clearInterval(match.landTick);
    matches.delete(match.id);
    // 🔌 猶予の途中で試合が終わったら、そこで打ち切る。
    // ⚠ 「戻ってこなかった」と同じ扱い（forfeited）にすること。ここを素通しに
    //   すると、勝っている側が終了直前に切れば **点数で勝ったまま**終われる
    //   ── 切断＝敗北という元の規則が守っていた「逃げ得にしない」が、猶予の
    //   導入で丸ごと外れてしまう。
    //   例外は 'shutdown' だけ。あれは誰のせいでもないので必ず引き分けにする
    //   （下の winTeam = -1 と揃える。切れていた人だけ敗北、にはしない）。
    // 🩹 ここで forfeited を立てた人が居たかを控える。下の裁定で使う ──
    //   猶予の終わりは min(now+猶予, ハード終了) なので、終了間際の切断では
    //   猶予切れ(reason='forfeit')ではなく **ハード終了(reason='timeout')の
    //   タイマーが先に鳴る**。reason だけを見ていると、切れた人が点でリード
    //   したまま勝ち、最後まで遊んだ側が敗北として記録されていた（実測: 残り
    //   17秒で切断 → 残った側が outcome=lose / rating-16）。
    let graceForfeit = false;
    for (const p of match.players) {
      if (!p.dc) continue;
      clearHold(p);
      if (reason === 'shutdown') continue;
      p.forfeited = true;
      p.finished = true;
      graceForfeit = true;
    }
    for (const p of match.players) if (p.sock.isBot) p.sock.stop();
    // 👀 観戦室（カスタムルームの観戦席）を畳んで、ふつうの部屋に戻す。
    // 1秒ごとの specTick も同じ判定で畳むが、そちらは最大1秒遅れるので
    // ここで即座に閉じる（結果を見せる前に観戦画面を残さない）。
    if (match.roomCode) { try { endRoomSpectate(rooms.get(match.roomCode)); } catch (err) { console.error('[room] spectate end', err); } }

    const ts = teamScores(match);
    let winTeam = ts[0] > ts[1] ? 0 : ts[1] > ts[0] ? 1 : -1;   // -1 = draw
    // 🚩 陣取りは点ではなく領土で決める（同数のときだけ点で割る）。
    // 棄権・切断の上書きより前に置くこと ── 逃げ得にしない。
    if (match.mode === 'land' && match.owner && match.players.length === 2) {
      const lc = landCounts(match);
      const [a, b] = match.players;
      winTeam = lc[0] > lc[1] ? a.team : lc[1] > lc[0] ? b.team
        : a.score > b.score ? a.team : b.score > a.score ? b.team : -1;
    }
    // 棄権・切断の裁定。reason だけでなく「猶予切れで forfeited を立てた人が
    // 居たか(graceForfeit)」も見る ── 終了間際の切断はハード終了のタイマーが
    // 先に鳴って reason='timeout' で来るため、reason だけだと逃げ得になる。
    //
    // ⚠ graceForfeit のほうは **1対1のときだけ**に効かせる。この上書きは
    //   「残っている人間の側の勝ち」という 1対1 の理屈で書かれていて、
    //   3人以上（2v2・大会の同時進行）では『players の並びで最初に見つかった
    //   人間の team』という意味のない側へ倒れてしまう ── 2v2 で味方が1人
    //   切れただけで、点で負けている自分の側が勝ちになりうる。
    //   reason==='forfeit' のほうは forfeitPlayer が 2人の試合でしか
    //   立てないので、そちらは今までどおりでよい。
    const soloForfeit = graceForfeit && match.players.length === 2;
    if (reason === 'forfeit' || soloForfeit) {
      const alive = match.players.find(p => !p.forfeited && !p.sock.isBot);
      if (alive) winTeam = alive.team;
    }
    // Raid is co-op: everyone wins if the boss fell, loses otherwise.
    if (match.mode === 'raid') winTeam = match.bossDead ? 0 : -2;
    // Co-op has no opponent — it is a shared run, never a win or a loss.
    if (match.mode === 'coop') winTeam = -1;
    // 🏆 大会のブラケットは同点でも必ず片方を勝ち上がらせる（tourneyMatchEnd）。
    // その判定を result 送信より後に走らせていたので、同点で終わると
    // 勝ち上がった本人にも outcome:'draw' が届いていた。クライアントは
    // 大会継続の分岐に 'win' しか入れていないので this.ended = true になり、
    //「準々決勝で敗退しました」を出したまま次ラウンドの match_found を
    // 無視して、勝っているはずの人が0点で不戦敗になっていた。
    // 勝者を先に決めて、その結果を result に載せる。
    let tourneyWinIdx = null;
    if (match.tourney && match.players.length === 2) {
      tourneyWinIdx = tourneyWinnerIdx(match);
      winTeam = match.players[tourneyWinIdx].team;
    }
    // 更新のためにサーバーを落とすとき。誰のせいでもないので必ず引き分け
    // （スコアで勝っていた人が敗北になる、の逆もない）。記録と報酬は残る。
    if (reason === 'shutdown') winTeam = match.mode === 'raid' ? -2 : -1;

    // 結果画面の並び。isBot は載せない（match_found と同じ理由）。
    // 運営には下の送信時に足す ── 1本を全員へ配るので、ここでは持たせない。
    const playersInfo = match.players.map(p => ({
      slot: p.slot, team: p.team, name: sockName(p.sock),
      score: p.score, moves: p.moves || 0,
    }));
    const playersInfoAdmin = playersInfo.map((row, i) => ({ ...row, isBot: !!match.players[i].sock.isBot }));

    // 👑 この試合に王者（ちゃちゃまる）が出ていたか。
    // 印の名前は「相手が誰か」ではなく「何を成し遂げたか」で付ける ──
    // beatBot のような名前は、その1語で住人の正体を明かしてしまう。
    const championSide = match.players.find(p => p.sock.isBot && p.sock.champion) || null;

    // 試合開始時に固定した userId で人物を解決する（p.sock.user を見ない）。
    // 終了時点の名乗りで引くと、ゲスト化・別token での戦績回避／付け替えが通る。
    const humanUsers = match.players.map(p =>
      (!p.sock.isBot && p.userId) ? db.users[p.userId] : null);

    // 🏠 同じ回線の2アカウントで、短時間に何度も当たっている組み合わせか。
    //    ここで数えるのは **試合ごとに1回**（下は選手ごとのループなので、
    //    そちらで数えると1試合で2回積んでしまう）。
    let repeatPair = false;
    if ((match.mode === 'duel' || match.mode === 'attack') && match.rated && match.players.length === 2
        && humanUsers[0] && humanUsers[1] && humanUsers[0].id !== humanUsers[1].id) {
      const ipA = sockIp(match.players[0].sock);
      const ipB = sockIp(match.players[1].sock);
      if (ipA !== '?' && ipA === ipB) {
        const key = [humanUsers[0].id, humanUsers[1].id].sort().join('|');
        const now = Date.now();
        const hist = (pairHistory.get(key) || []).filter(t => now - t < REPEAT_WINDOW_MS);
        repeatPair = hist.length >= REPEAT_FREE;
        hist.push(now);
        pairHistory.set(key, hist);
        // 窓から出た組み合わせは捨てる（際限なく増やさない）。
        if (pairHistory.size > 500) {
          for (const [k, v] of pairHistory) {
            if (!v.length || now - v[v.length - 1] > REPEAT_WINDOW_MS) pairHistory.delete(k);
          }
        }
      }
    }
    // 🔁 デュエル/アタックの2人戦は再戦オファーを用意（30秒有効）。
    let rematchId = null;
    if ((match.mode === 'duel' || match.mode === 'attack') && match.players.length === 2
        && !match.tourney && match.players.some(p => !p.sock.isBot && !p.forfeited)
        // 相手が切断/棄権済みなら成立し得ないオファーは出さない（死んだ🔁ボタン防止）
        && match.players.every(p => p.sock.isBot || (!p.forfeited && p.sock.readyState === p.sock.OPEN))) {
      rematchId = crypto.randomUUID();
      rematchOffers.set(rematchId, {
        mode: match.mode, rated: !!match.rated, duration: match.duration, until: Date.now() + 30000,
        sides: match.players.map(p => ({
          sock: p.sock.isBot ? null : p.sock,
          // 🎭 **その席そのもの**を控える。強さ（level）だけを控えて座り直させると、
          //    名前・レート・称号・ギルド・戦績が全部引き直され、再戦した相手が
          //    別人になる ── 人間相手の再戦では必ず同じ人が座るので、
          //    「名前が変わった＝さっきの相手はボットだった」の判定器になっていた
          //    （実測9/9で別人。ゲストとして遊ぶと R1042・称号あり → レート無し・
          //     称号なし、と露骨に劣化することもあった）。
          bot: p.sock.isBot ? p.sock : null,
          isBot: !!p.sock.isBot, level: p.sock.level || null,
          name: sockName(p.sock), team: p.team, ready: false,
        })),
      });
    }
    // Rated 1v1: vs another account, or vs a "registered" AI player (its fake
    // rating drives a real Elo update so ranked works even when nobody's on).
    const duel2 = match.rated && (match.mode === 'duel' || match.mode === 'attack') && match.players.length === 2;
    // Elo は「試合前」のレート同士で対称に計算する（1人目を先に更新した後の
    // 新レートで2人目を計算すると deltas がゼロサムにならない）
    const preRatings = [];
    for (const p of match.players) {
      preRatings[p.slot] = humanUsers[p.slot] ? humanUsers[p.slot].stats.rating
        : (p.sock.rating != null ? p.sock.rating : null);
    }

    for (const p of match.players) {
      if (p.sock.isBot) continue;
      const me = humanUsers[p.slot];
      // Disconnecting/quitting a PvP match is ALWAYS a loss for the quitter.
      const outcome = p.forfeited && match.mode !== 'raid' ? 0
        : winTeam === -2 ? 0
        : winTeam === -1 ? 0.5
        : p.team === winTeam ? 1 : 0;
      let ratingDelta = 0;
      let rewards = null;
      let tierChange = null;
      // 同一アカウントの2ソケットによる自己対戦。Elo は既に oppUser.id !== me.id で
      // 除外済みだが、pvpWins/pvpLosses と PvP 報酬は無条件に走っていた。unrated 扱いに落とす。
      const selfPlay = !!(me && duel2 && humanUsers[1 - p.slot] && humanUsers[1 - p.slot].id === me.id);
      // 🤝 練習試合（friendly）── 1対1だが「レート戦として成立していない」試合。
      //
      // なぜ要るか
      //   Elo は昔からゲスト相手では動かない（下の oppRating が null になる）。
      //   ところが **勝ち星・コイン・ミッション・実績・称号だけは無条件に入って
      //   いた**ので、3つの判断が食い違っていた。この食い違いがそのまま抜け道で、
      //   シークレットウィンドウをゲストとして開いてわざと負けるだけで、
      //   PvP勝利数・勝利系ミッション・実績・報酬を無限に量産できた（ゲストは
      //   登録が要らないので、いくらでも・ただで作れる）。
      //   合言葉ルームも同じ形。rated:false なので Elo と勝ち星は元から動かない
      //   のに、applyGameResult の won だけは通っていた。
      //   ここで「Elo が動かない1対1では勝ち星も勝利報酬も動かない」に揃える。
      //
      // 付かないのは **勝敗に紐づくもの** だけで、参加そのものの報酬・プレイ回数・
      // ライン数・ピース数のミッションは今までどおり入る（遊んだ事実は消さない）。
      //
      // ⚠ 2v2（team）は対象外。4人のうち1人がゲストでも試合全体は成立している
      //   ので、1対1のようには落とせない。
      // ⚠ 🏆トーナメントも rated:false の 'duel' として作られる（Elo を動かさない
      //   ため）。ここを素直に「rated でなければ練習試合」と書くと、**優勝の
      //   バッジとボーナスが出なくなる** ── レート戦でないことと、勝ちに意味が
      //   無いことは別。合言葉ルームだけを練習試合にするため tourney を除く。
      //   （rated:false の1対1を作るのは、この2本しかない。）
      // 🚩 陣取りデュエルもここに入れる。1対1でレートを動かさない試合なのに
      //    duel1v1 に無かったので、mode:'pvp' の won:true として届いていた ──
      //    連勝ボーナス（最大200🪙）・d_pvp1 / w_pvp5・ach_streak5/10・称号
      //    「連勝街道」・totalWins が全部つき、2人で勝ちを譲り合えば無限だった。
      //    「Elo が動かない1対1では勝ち星も勝利報酬も動かない」の対象に揃える。
      const duel1v1 = (match.mode === 'duel' || match.mode === 'attack' || match.mode === 'land')
        && match.players.length === 2;
      // 🚪 合言葉ルームの試合は **人数にもモードにもよらず** 練習試合。
      //
      //    以前は duel1v1（duel/attack/land の2人戦）だけを見ていたので、
      //    2v2 や3人以上の部屋では friendly が付かず、勝ち星・連勝ボーナス・
      //    totalWins・勝利系ミッション/実績/称号が全部入っていた。
      //    実測: 席2の部屋で勝つと totalWins 0→0 のまま、席16の部屋で勝つと 0→1。
      //    席数を選べるようにすると「1人＋ボット15人で必勝ボタン」になる。
      //    下の宣言（Elo が動かない場所では勝ちに意味を持たせない）を、
      //    部屋の試合ぜんたいへ広げる。match.roomCode は startRoom が張り、
      //    endMatch でも消えない。
      const inRoom = !!match.roomCode && !match.rated && !match.tourney;
      const oppSlot = 1 - p.slot;
      const friendly = !me ? null
        : inRoom ? 'room'
          : !duel1v1 ? null
            : selfPlay ? 'self'
              : (!match.rated && !match.tourney) ? 'room'
                : (!match.rated ? null
                  // 🎭 判定は「相手がボットか」ではなく **「相手にレートがあるか」**。
                  //
                  //   以前は `!isBot && !humanUsers[opp]` だったので、本物のゲストには
                  //   練習試合の注記が出て勝ち星も付かないのに、**レートを持たない
                  //   ボットの席**（未登録の住人・ゲスト風の使い捨て）では注記が出ず
                  //   pvpWins だけが増えていた。対戦カードの見え方は
                  //   「段位なし / Lv ― / R ―」で本物のゲストと完全に同一なので、
                  //   『段位なしの相手 × 注記なし』の2条件で住人だと100%言い当てられた。
                  //   実測: ランクマ60戦のうち20%が段位なしの相手で、そのうち9人は
                  //   「ゲストNNNN」ではない名簿の住人。
                  //
                  //   Elo が動く条件（下の oppRating）は元から `rating != null` なので、
                  //   そちらに揃える。これで **見え方・裁定・注記** の3つが必ず一致する。
                  : sockRating(match.players[oppSlot].sock) == null ? 'guest'
                    : repeatPair ? 'repeat'
                      : null);
      if (me) {
        if (duel2) {
          const oppUser = humanUsers[1 - p.slot];
          const oppSock = match.players[1 - p.slot].sock;
          const oppRating = oppUser && oppUser.id !== me.id ? preRatings[1 - p.slot]
            : oppSock.isBot && oppSock.rating != null ? oppSock.rating : null;
          // ⚖️ **練習試合では Elo を動かさない。**
          //
          //    friendly の4つの枝のうち、'self'/'guest'/'room' はたまたま
          //    oppRating が null になるか duel2 が偽になるのでここまで来ないが、
          //    'repeat'（同じ回線の同じ相手と REPEAT_FREE 回を超えた）だけは
          //    **match.rated の枝で相手も登録ユーザー**なので普通に到達する。
          //    そのため、結果画面に「練習試合 — レート・戦績・勝利報酬が
          //    動きません」と出しながら、同じモーダルに「+16 レート」と
          //    「現在のレート 1,016」が並び、実際に Elo も帯も動いていた
          //    （帯をまたげば全体告知まで流れる）。
          //    止めていたのは下の pvpWins/pvpLosses と applyGameResult（unrated）だけで、
          //    Elo のブロックは friendly を一度も見ていなかった。
          //    「勝ち星が動かない試合ではレートも動かない」を逆向きにも守る。
          if (oppRating != null && !friendly) {
            const beforeTier = rankInfoOf(me.stats.rating);
            ratingDelta = eloUpdate(me.stats.rating, oppRating, outcome);
            me.stats.rating = Math.max(0, me.stats.rating + ratingDelta);
            // レート系称号が下振れで剥がれないよう、到達最高レートを残す。
            me.stats.ratingBest = Math.max(me.stats.ratingBest || 0, me.stats.rating);
            const afterTier = rankInfoOf(me.stats.rating);
            // 24段のどれかが動いたら本人には知らせる（結果画面のトースト）。
            if (afterTier.min !== beforeTier.min) {
              tierChange = { up: afterTier.min > beforeTier.min, from: beforeTier, to: afterTier };
            }
            // 📈 全体アナウンス + 住人のお祝いは「帯（8種）が上がったとき」だけ。
            //
            // 段が III/II/I に割れて24段になったので、段ごとに流すと告知が3倍に
            // なってロビーが昇格通知で埋まる。帯の移動だけに絞る。
            //
            // さらに、以前は「今回の1戦で帯が変わったか」しか見ていなかったので、
            // しきい値の上下を往復するだけで（例: 1700付近で勝ち負けを繰り返す）
            // 何度でも全体配信できた ── 同じ人の同じ昇格が一晩に何十回も流れる。
            // 「どこまで告知したか」を本人の stats に残し、そこを **超えたときだけ**
            // 流す。降格しても記録は下げない（＝往復では二度と鳴らない）。
            // ⚠ この stats キーは server/backup.js の合流にも入れてある。
            //    落とすと復元のたびに昇格告知がもう一度鳴る。
            if (afterTier.band.min > beforeTier.band.min && afterTier.band.min >= announceMin
                && afterTier.band.min > (Number(me.stats.rankAnnounced) || 0)) {
              me.stats.rankAnnounced = afterTier.band.min;
              const b = afterTier.band;
              broadcastAll({
                type: 'announce',
                // 全体告知の文面はクライアントで textContent に入る。
                // b.icon は **アイコン名**（'rank_gold'）なので文面に差してはいけない。
                message: `「${me.username}」が${b.name}帯に昇格！`,
                messageEn: `"${me.username}" was promoted to ${b.nameEn}!`,
                from: '大会運営',
              });
              // tier はオブジェクトで渡す — renderSlot が言語別に name/nameEn を選ぶ
              react('rankup', { you: me.username, tier: b, notName: me.username });
            }
          }
        }
        if (match.rated && match.mode !== 'raid' && !friendly) {
          if (outcome === 1) me.stats.pvpWins += 1;
          else if (outcome === 0) me.stats.pvpLosses += 1;
        }
        if (match.mode === 'coop') {
          me.stats = me.stats || {};
          if (p.score > (me.stats.coopBest || 0)) me.stats.coopBest = p.score;
        }
        if (!p.forfeited) {
          rewards = applyGameResult(me, {
            trusted: true,   // サーバーが勝敗を決めている
            mode: match.tourney ? 'tournament'
              : match.mode === 'team' ? 'team' : match.mode === 'raid' ? 'raid'
              : match.mode === 'coop' ? 'coop' : 'pvp',
            score: p.score, lines: p.lines, maxCombo: p.maxCombo,
            duration: match.mode === 'coop' ? Math.max(1, (Date.now() - match.startedAt) / 1000) : match.duration,
            // `match.moves` only exists on the co-op shared board; every other
            // online mode reported 0 pieces, which quietly froze the
            // piece-count missions and achievements for online players.
            // 協力は盤面共有だが、ピース数は「誰が置いたか」を記録する per-player の
            // p.moves を渡す。共有の match.moves を渡すと両者に総手数が二重計上され、
            // ボット/代打の手まで人間の実績（s.piecesPlaced）に入っていた。
            // 🚩 陣取りも共有盤面なので、置いた数は per-player の p.moves で数える。
            pieces: (match.mode === 'coop' || match.mode === 'land') ? (p.moves || 0) : (p.pieces || 0),
            // 🏆 大会は「勝ったか」と「優勝したか」を**別の欄**で渡す。
            //    以前は won 自体を決勝限定にしていたので、準々決勝・準決勝で勝っても
            //    勝利系ミッション（win / pvpWin）も totalWins も1つも進まなかった
            //    ── 結果画面には「勝利！」と出て、勝ち上がりの演出まで出るのに。
            //    バッジ・優勝ボーナス・全体速報は index.js 側が tourneyFinal で絞る。
            // 自己対戦は勝敗を付けない（PvP勝利系ミッション/実績・勝利報酬を稼がせない）。
            won: friendly ? false : outcome === 1,
            tourneyFinal: !!(match.tourney && match.tourney.final),
            drew: friendly ? false : outcome === 0.5,
            // 🏳️ 「この試合は勝敗を判定しない」。
            //    won:false / drew:false のまま渡すと mode:'pvp' の「負け」の枝に
            //    落ちて、**罰だけ**が通っていた ── 合言葉ルームの練習1試合や
            //    ゲスト相手の勝利で、ランクマの10連勝が無言で0に戻る。
            //    battle.js のこの上のコメントは「付かないのは勝敗に紐づくもの
            //    だけ／遊んだ事実は消さない」と宣言しているのに、連勝だけが
            //    消えていた。drew:true の流用は結果画面の表示と食い違うので、
            //    専用の欄で「触るな」と伝える。
            unrated: !!friendly,
          });
        }
      }
      // 👑 王者を倒したか（称号とアナウンスの実装は別タスク。ここは印だけ）。
      //   ・王者と**別チーム**で、そのチームが勝ったときだけ
      //   ・協力/レイドは相手ではなく共闘なので対象外
      //   ・棄権・切断で転がり込んだ勝ちは含めない（逃げ得で称号は付かない）
      const beatChampion = !!(championSide && !p.sock.isBot && !p.forfeited
        && p.team !== championSide.team && outcome === 1
        && match.mode !== 'coop' && match.mode !== 'raid'
        && !championSide.forfeited);
      // 生涯カウンター。称号は「一度でも倒したか」で決まるので、結果フレームの
      // 印だけだと再ログインで消える。⚠ server/backup.js の合流にも入れてある
      // （落とすと復元のたびに称号が消える）。
      if (beatChampion && me) {
        me.stats = me.stats || {};
        me.stats.championWins = (me.stats.championWins || 0) + 1;
        // 全体速報。ここで鳴らすのは applyGameResult より **後ろ** で
        // beatChampion が決まるため（上の applyGameResult 呼び出しに
        // beatChampion を渡すには判定を前に動かす必要がある）。
        // 数えるのはこの1か所だけ ── announceChampionFall はカウンタを
        // 触らないので二重計上にならない。
        announceChampionFall(me);
      }
      if (p.forfeited) continue;   // quitter is gone — stats recorded, nothing to send
      send(p.sock, {
        type: 'result',
        // 👑 王者に勝った（false は載せない ── 「この試合だけ false が付く」も情報）
        ...(beatChampion ? { beatChampion: true, championWins: me ? me.stats.championWins : 1 } : {}),
        outcome: outcome === 1 ? 'win' : outcome === 0 ? 'lose' : 'draw',
        reason, mode: match.mode,
        tourney: match.tourney ? { round: match.tourney.round, final: match.tourney.final } : null,
        teamScores: ts,
        boss: match.boss || null,
        bossDead: !!match.bossDead,
        coop: match.mode === 'coop'
          ? { score: match.engine.score, lines: match.engine.linesCleared, combo: match.engine.maxCombo, moves: match.moves, best: me ? (me.stats.coopBest || 0) : 0 }
          : null,
        // 🚩 陣取り: 最終盤の領土と内訳（結果画面がそのまま描ける形）
        land: match.mode === 'land' && match.owner
          ? { owner: match.owner.slice(), counts: landCounts(match), yours: p.slot + 1, moves: match.moves }
          : null,
        you: { slot: p.slot, team: p.team },
        players: sockAdmin(p.sock) ? playersInfoAdmin : playersInfo,
        // 🤝 練習試合だった理由（'guest' / 'room' / 'self'）。結果画面が
        //    「なぜレートも勝ち星も動かないのか」を出すのに使う。付かない試合
        //    では欄ごと落とす（false を載せると、その有無が別の情報になる）。
        //    ⚠ 'guest' が出るのは相手が本物の未登録プレイヤーのときだけで、
        //      住人（ボット）は必ずレートを持つのでここには来ない＝正体は漏れない。
        ...(friendly ? { friendly } : {}),
        ratingDelta, rewards, tierChange, rematchId,
        user: me ? publicUser(me) : null,
      });
    }
    // -----------------------------------------------------------------------
    // 🗒 住人の戦績を「実際に起きたこと」として残す
    // -----------------------------------------------------------------------
    // これまで住人の成績は種＋日付から丸ごと計算していたので、人間が勝っても
    // 相手の戦績は1ミリも動かなかった ── いちばん強い「AIだとバレる手がかり」。
    // ここで付けた差分は residentStats / residentRating が基準値に足すので、
    // ランキングでもプロフィールでも、変装して出てくるときのレートでも、
    // 同じ1敗が見える。
    //
    // 記録するのは **レート戦の1対1で、片方が人間・片方が住人の変装** のときだけ。
    //   ・sock.rating が null（未登録の住人）は Elo も走らないので対象外
    //   ・棄権・切断で終わった試合も記録する。人間側には敗北と Elo が付くので、
    //     相手の勝ちだけ無かったことにすると帳尻が合わない（逃げ得になる）
    //   ・レート増減は人間の delta の符号違いではなく Elo をそのまま引き直す。
    //     人間側は下限クランプ（rating が 0 未満にならない）を通っているため。
    if (duel2) {
      const resSide = match.players.find(p => p.sock.isBot && p.sock.resident && p.sock.rating != null);
      const humanSide = resSide ? match.players.find(p => p !== resSide && !p.sock.isBot) : null;
      const humanRating = humanSide && humanUsers[humanSide.slot] ? preRatings[humanSide.slot] : null;
      if (resSide && humanSide && humanRating != null) {
        // 住人から見た結果。人間が棄権したらその人の負け＝住人の勝ち。
        const hOutcome = humanSide.forfeited ? 0
          : winTeam === -1 ? 0.5 : humanSide.team === winTeam ? 1 : 0;
        const resOutcome = 1 - hOutcome;
        try {
          recordResidentMatch(resSide.sock.resident, {
            outcome: resOutcome,
            ratingDelta: eloUpdate(resSide.sock.rating, humanRating, resOutcome),
            score: resSide.score,
          });
        } catch (err) {
          // 台帳の失敗で試合の締めを止めない（報酬も結果送信も既に済んでいる）。
          console.error('[resident] 戦績の記録に失敗', err && err.message);
        }
      }
    }

    // A resident who played as a bot may talk about the human afterwards.
    if (match.mode === 'duel' || match.mode === 'attack' || match.mode === 'coop') {
      const human = match.players.find(p => !p.sock.isBot && !p.forfeited);
      const bot = match.players.find(p => p.sock.isBot && p.sock.resident);
      if (human && bot) {
        const hOut = match.mode === 'coop' ? 'coop'
          : winTeam === -1 ? 'draw' : human.team === winTeam ? 'human_won' : 'human_lost';
        reactToMatch(bot.sock.resident, sockName(human.sock), hOut, match.mode);
      }
    }
    for (const p of match.players) {
      if (!p.sock.isBot && p.sock.matchId === match.id) p.sock.matchId = null;
    }
    saveDb();
    // 勝者は上で決めてある（result と食い違わせない）。
    if (match.tourney) tourneyMatchEnd(match, tourneyWinIdx);
  }

  // -------------------------------------------------------------------------
  // Matchmaking queues
  // -------------------------------------------------------------------------

  // メンテナンスに切り替わった瞬間に居合わせた人を、黙って「棄権」にしない。
  // 対戦中のクライアントは 700〜900ms ごとに state を送るので、管理者が
  // メンテを ON にした次の1秒で全員が gateSocket に踏まれて ws.close() され、
  // close ハンドラが p.forfeited = true → endMatch(match,'forfeit') を走らせて
  // いた。本人の落ち度はゼロなのに Elo マイナスと pvpLosses が確定し、相手には
  // 不戦勝が付く。サーバー停止（reason:'shutdown'）はわざわざ引き分けにして
  // 記録を守っているのに、メンテ切替だけこの配慮が抜けていた。
  // 切る前に shutdown と同じ経路を通し、記録と報酬を正しく締める。
  function endForMaintenance(ws) {
    const m = ws.matchId ? matches.get(ws.matchId) : null;
    // 'shutdown' は winTeam を必ず引き分けにする（1件の失敗で切断処理を止めない）
    if (m && !m.ended) { try { endMatch(m, 'shutdown'); } catch { /* ignore */ } }
    if (ws.royaleId) {
      const r = royales.get(ws.royaleId);
      if (r && !r.ended) {
        const e = r.entrants.find(x => x.ws === ws);
        // ロイヤルは「その時点で立っていた順位」で確定（endAllForShutdown と同じ）
        if (e && e.alive) {
          const ranked = royaleRanked(r);
          try { endRoyaleFor(e, r, ranked.length, ranked); } catch { /* ignore */ }
        }
      }
      ws.royaleId = null;
    }
  }

  // Re-checked on every inbound message, not just 'hello': a client that never
  // says hello used to slip past the ban and maintenance checks entirely, and
  // a player banned mid-session kept playing until they reconnected. (Mute is
  // already re-checked per message in the chat/react cases.)
  // Returns false (and closes) when the socket may not act.
  function gateSocket(ws) {
    const u = ws.user ? db.users[ws.user.id] : null;
    if (u && u.banned) {
      send(ws, { type: 'error', error: 'アカウントが凍結されています' });
      ws.close();
      return false;
    }
    if (deps.isMaintenance && deps.isMaintenance() && (!u || u.role !== 'admin')) {
      endForMaintenance(ws);
      send(ws, { type: 'error', error: 'メンテナンス中です。しばらくお待ちください' });
      ws.close();
      return false;
    }
    return true;
  }

  // ---- rating-aware matchmaking (v2.11) -----------------------------------
  //
  // Duel and attack pair on ARRIVAL ORDER only, despite a full Elo ladder
  // existing — a 1,800 could be handed a 900 and both ratings moved as if that
  // meant something. Pairing now prefers the closest rating, inside a band that
  // widens the longer you wait, so a small population still matches quickly.
  const ratingOf = (ws) => {
    const u = ws && ws.user ? db.users[ws.user.id] : null;
    return u && u.stats ? (u.stats.rating || 1000) : 1000;
  };
  // 0s: ±120 → 30s: ±420 → 60s+: anyone.
  const ratingBand = (waitedMs) => 120 + Math.floor(waitedMs / 1000) * 10;

  // Pick the best-matched pair currently in `q`, or null.
  //
  // 🏠 同じ回線どうしは「最後の手段」にする。自分の2窓（シークレットウィンドウで
  //    ゲスト、あるいは2つ目のアカウント）を並べて自己対戦を仕込む、がいちばん
  //    安いブースト手段で、以前はそれを避ける仕組みが1つも無かった。
  //    ただし **禁止はしない** ── 同一IPは家族・学校・寮でふつうに起きる
  //    （MAX_SOCKETS_PER_IP を 12 に緩めてあるのは、まさにそれを想定してのこと）。
  //    禁止すると「兄弟が同時に並ぶと永久に待つ」になるので、他に相手がいる
  //    ときだけ避け、いなければ従来どおり組む。
  function bestPair(q, now) {
    let best = null;        // 別回線どうし（優先）
    let fallback = null;    // 同一回線どうし（他に相手がいないときだけ）
    for (let i = 0; i < q.length; i++) {
      for (let j = i + 1; j < q.length; j++) {
        // 同一アカウントの2ソケットを組ませない（自己対戦の多重防御）。
        if (q[i].ws.user && q[j].ws.user && q[i].ws.user.id === q[j].ws.user.id) continue;
        const gap = Math.abs(ratingOf(q[i].ws) - ratingOf(q[j].ws));
        const allowed = Math.max(ratingBand(now - q[i].since), ratingBand(now - q[j].since));
        if (gap > allowed) continue;
        const sameIp = sockIp(q[i].ws) !== '?' && sockIp(q[i].ws) === sockIp(q[j].ws);
        if (sameIp) {
          if (!fallback || gap < fallback.gap) fallback = { i, j, gap };
        } else if (!best || gap < best.gap) {
          best = { i, j, gap };
        }
      }
    }
    return best || fallback;
  }

  // The bot that fills an empty seat is drawn to MATCH the human, not at
  // random. Previously the ladder mostly measured which bot you happened to
  // draw: an oni bot against a bronze player, or an easy bot against a master.
  function botLevelFor(rating) {
    if (rating >= 1500) return Math.random() < 0.65 ? 'oni' : 'hard';
    if (rating >= 1250) return Math.random() < 0.6 ? 'hard' : (Math.random() < 0.5 ? 'oni' : 'normal');
    if (rating >= 1050) return Math.random() < 0.6 ? 'normal' : 'hard';
    if (rating >= 900) return Math.random() < 0.65 ? 'normal' : 'easy';
    return Math.random() < 0.7 ? 'easy' : 'normal';
  }
  const botFor = (ws, used) => new Bot(botLevelFor(ratingOf(ws)), used || new Set([sockName(ws)]));

  function queueInfo(entry, mode) {
    const waited = Date.now() - entry.since;
    return {
      type: 'queued', mode,
      waited: Math.round(waited / 1000),
      // 「あと何秒でマッチが成立するか」。中身は今までどおり entry.botAt
      // （席を埋める瞬間）だが、フィールド名を botInSec のままにすると
      // **名前そのものが「相手はボットです」と言っている**。値は正直なまま、
      // 呼び名だけ中立にする。⚠ クライアント側（public/js/modes.js）も
      // matchInSec に追随が要る。
      matchInSec: Math.max(0, Math.round((entry.botAt - Date.now()) / 1000)),
      humans: queues[mode].length,
      band: ratingBand(waited),
      rating: ratingOf(entry.ws),
    };
  }

  function joinQueue(ws, mode) {
    if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId || ws.zeroId) return;
    leaveQueues(ws);
    // 同一アカウントの2本目のソケットが同じキューに並ぶと、bestPair が
    // レート差0の自分同士を最優先で成立させ、自己対戦で PvP 勝利・報酬を
    // 量産できた。ログイン済みは user.id 単位で先着1本だけ残す（古い方を外す）。
    // ゲストは従来どおり ws 単位。
    if (ws.user) {
      const uid = ws.user.id;
      queues[mode] = queues[mode].filter(e => !(e.ws.user && e.ws.user.id === uid));
    }
    const wait = mode === 'duel' || mode === 'attack' ? duelBotWait() : mode === 'coop' ? coopBotWait() : teamBotWait();
    const entry = { ws, since: Date.now(), botAt: Date.now() + wait };
    queues[mode].push(entry);
    send(ws, queueInfo(entry, mode));
    sweepQueues();
  }

  // Keep everyone waiting informed — an elapsed clock and a real countdown to
  // the AI fill, instead of a frozen "searching…" that ends without warning.
  setInterval(() => {
    for (const mode of Object.keys(queues)) {
      for (const e of queues[mode]) {
        if (e.ws.readyState === e.ws.OPEN) send(e.ws, queueInfo(e, mode));
      }
    }
  }, 1000);

  function leaveQueues(ws) {
    for (const q of Object.values(queues)) {
      const i = q.findIndex(e => e.ws === ws);
      if (i !== -1) q.splice(i, 1);
    }
  }

  function sweepQueues() {
    for (const mode of ['duel', 'attack', 'team', 'raid', 'tourney', 'royale', 'coop']) {
      queues[mode] = queues[mode].filter(e => e.ws.readyState === e.ws.OPEN && !e.ws.matchId);
    }
    // tournament: start with up to 8 humans once the first entrant has waited
    while (queues.tourney.length >= 8) {
      const eight = queues.tourney.splice(0, 8);
      startTourney(eight.map(e => e.ws));
    }
    if (queues.tourney.length > 0 && Date.now() >= queues.tourney[0].botAt) {
      const humans = queues.tourney.splice(0, queues.tourney.length);
      startTourney(humans.map(e => e.ws));
    }
    // battle royale: everyone waiting boards the same 100-player lobby
    if (queues.royale.length > 0 && (queues.royale.length >= ROYALE_SIZE - 1 || Date.now() >= queues.royale[0].botAt)) {
      const humans = queues.royale.splice(0, Math.min(ROYALE_SIZE - 1, queues.royale.length));
      startRoyale(humans.map(e => e.ws));
    }
    // ⚔️ Duel and 💥 attack: closest-rated pair first (band widens with wait),
    // and the bot that fills a lone seat is drawn to match that player.
    const now = Date.now();
    for (const mode of ['duel', 'attack']) {
      for (;;) {
        const pair = bestPair(queues[mode], now);
        if (!pair) break;
        const [a, b] = [queues[mode][pair.i], queues[mode][pair.j]];
        queues[mode] = queues[mode].filter(e => e !== a && e !== b);
        createMatch({ mode, entries: [{ sock: a.ws, team: 0 }, { sock: b.ws, team: 1 }] });
      }
      // Everyone whose bot timer expired gets a match — not just the head of
      // the queue.
      for (const e of queues[mode].filter(x => now >= x.botAt)) {
        queues[mode] = queues[mode].filter(x => x !== e);
        createMatch({ mode, entries: [{ sock: e.ws, team: 0 }, { sock: botFor(e.ws), team: 1 }] });
      }
    }
    while (queues.team.length >= 4) {
      const four = queues.team.splice(0, 4);
      // 到着順に前2人を A、後2人を B へ。`i % 2` だと隣接＝一緒に来た2人が
      // 別チームに割れる（2v2 が存在する意味そのものを壊す）。ボット補充経路と揃える。
      createMatch({ mode: 'team', entries: four.map((e, i) => ({ sock: e.ws, team: i < 2 ? 0 : 1 })) });
    }
    if (queues.team.length > 0 && Date.now() >= queues.team[0].botAt) {
      const humans = queues.team.splice(0, queues.team.length);
      // Two friends who queued together were split onto OPPOSING teams by
      // `i % 2` — the one thing 2v2 exists to avoid. Humans fill team A first.
      const entries = humans.map((e, i) => ({ sock: e.ws, team: i < 2 ? 0 : 1 }));
      const used = new Set(humans.map(e => sockName(e.ws)));
      // Both sides drew independent random bots, so one team could get an oni
      // and the other an easy. Pick ONE strength for the fill, matched to the
      // humans present, and give every seat the same one.
      const avg = humans.reduce((a, e) => a + ratingOf(e.ws), 0) / Math.max(1, humans.length);
      const fillLevel = botLevelFor(avg);
      while (entries.length < 4) {
        entries.push({ sock: new Bot(fillLevel, used), team: entries.filter(x => x.team === 0).length < 2 ? 0 : 1 });
      }
      createMatch({ mode: 'team', entries });
    }
    // co-op: pairs share one board; a bot partner joins after the wait
    while (queues.coop.length >= 2) {
      const [a, b] = queues.coop.splice(0, 2);
      createMatch({
        mode: 'coop', duration: COOP_MAX_SECS, rated: false,
        entries: [{ sock: a.ws, team: 0 }, { sock: b.ws, team: 0 }],
      });
    }
    if (queues.coop.length === 1 && Date.now() >= queues.coop[0].botAt) {
      const [a] = queues.coop.splice(0, 1);
      createMatch({
        mode: 'coop', duration: COOP_MAX_SECS, rated: false,
        entries: [{ sock: a.ws, team: 0 }, { sock: botFor(a.ws), team: 0 }],
      });
    }
    // raid: co-op party of 4 (all on team 0), bots fill after the wait
    while (queues.raid.length >= 4) {
      const four = queues.raid.splice(0, 4);
      createMatch({ mode: 'raid', entries: four.map(e => ({ sock: e.ws, team: 0 })), rated: false });
    }
    if (queues.raid.length > 0 && Date.now() >= queues.raid[0].botAt) {
      const humans = queues.raid.splice(0, queues.raid.length);
      const entries = humans.map(e => ({ sock: e.ws, team: 0 }));
      const used = new Set(humans.map(e => sockName(e.ws)));
      const raidLevel = botLevelFor(humans.reduce((a, e) => a + ratingOf(e.ws), 0) / Math.max(1, humans.length));
      while (entries.length < 4) entries.push({ sock: new Bot(raidLevel, used), team: 0 });
      createMatch({ mode: 'raid', entries, rated: false });
    }
  }
  // パーティーの掃除（招待の期限・全員オフラインの猶予・12時間で店じまい）も
  // 同じループに相乗りさせる。タイマーは増やさない。
  setInterval(() => {
    sweepQueues(); sweepRematches();
    try { party.sweep(); } catch (err) { console.error('[party] sweep', err); }
  }, 2000);

  // -------------------------------------------------------------------------
  // Custom rooms
  // -------------------------------------------------------------------------

  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function roomOf(ws) { return ws.roomCode ? rooms.get(ws.roomCode) : null; }

  // mode: 'duel' (1v1) | 'team' (2v2) | 'coop' (two players, one board)
  //     | 'land' (🚩 陣取りデュエル: 2人・1盤面・交互・消したラインが領土)
  // `team` is kept in sync for older clients that only know the boolean.
  function cleanSettings(s = {}) {
    // ⚔️ 'attack'（お邪魔を送り合う1v1）はマッチングでしか遊べなかった。
    //    合言葉ルームは「友達と好きな形で遊ぶ場所」なのに、対戦の主役である
    //    攻撃戦だけ選べない ── 実装は duel と同じ経路なので、選べる一覧に
    //    入っていなかっただけ。roomSeats も duel と同じ2席になる。
    let mode = ['duel', 'attack', 'team', 'coop', 'land'].includes(s.mode) ? s.mode : (s.team ? 'team' : 'duel');
    if (s.team === true && s.mode === undefined) mode = 'team';
    if (s.team === false && s.mode === undefined) mode = 'duel';
    // 💺 対戦席の数。モードごとに「遊んで成立する」上限が違う。
    //
    //   duel … 何人でも成立する（各自の盤面で点を競うだけ）
    //   team … 2チームに分かれるだけなので何人でも成立する
    //   attack … **2人固定**。お邪魔は `p.team !== me.team` の全員へ同じだけ配られ、
    //     上限は撃つ側にしかない（MAX_ATK_CELLS_PER_SEC=2）。8v8 では受け側が
    //     最大16セル/秒 ＝ 64マスの盤面が約4秒で埋まる。受け側の上限を作るまで開けない。
    //   coop / land … **2人固定**。1つの盤面を交互に使う作りで、
    //     とくに陣取りは landCounts が owner の 1 と 2 しか数えず（3人目の領土は
    //     どこにも入らない）、勝敗の裁定も players.length === 2 の中にある。
    //   ⚠ ここを緩めるときは、上に挙げた実装のほうを先に直すこと。
    const seatMax = mode === 'duel' || mode === 'team' ? ROOM_MAX : 2;
    const seatMin = 2;
    const seatWant = Number.isFinite(Number(s.seats)) ? Math.floor(Number(s.seats))
      : (mode === 'team' ? 4 : 2);
    return {
      duration: DURATIONS.includes(Number(s.duration)) ? Number(s.duration) : MATCH_DURATION,
      mode,
      team: mode === 'team',
      seats: Math.max(seatMin, Math.min(seatMax, seatWant)),
      botFill: s.botFill !== false,
      botLevel: ['random', 'easy', 'normal', 'hard', 'oni'].includes(s.botLevel) ? s.botLevel : 'random',
    };
  }
  // 対戦席の数。ホストが選んだ値（cleanSettings がモードごとに丸めてある）。
  const roomSeats = room => (room.settings && room.settings.seats) || (room.settings.mode === 'team' ? 4 : 2);
  // 部屋の定員（対戦席＋観戦席）。以前は対戦席ぶんしか入れず、あふれた人は
  // 「ルームが満員です」で**入室すらできなかった** ── 5人で集まって2人だけ
  // 遊ぶ、ができない。定員を8にして、あふれたぶんは観戦席に座らせる。
  //    16人まで（2026-09-06 ユーザー要望）。上げたときに何が壊れるかは
  //    実測済み ── 試合そのものは16人で最後まで成立し、全員が試合後に部屋へ戻る。
  //    ⚠ 同一回線からの実効上限は MAX_SOCKETS_PER_IP。家や学校のように
  //      みんなが同じ回線から入る場合はそちらが先に効くので、16人ぶんに上げてある。
  const ROOM_MAX = 16;
  const roomPlaying = room => room.players.filter(p => !room.watch.has(p));

  // 📍 部屋の中で人を指す。**席番号（broadcastRoom の players[].idx）が正**。
  //    表示名はゲストどうしで重複できる（名前の予約は登録ユーザー・予約名・
  //    住人名しか弾かない）ので、名前で引くと同名の先頭に当たり、
  //    ホストが押した行と別の人が動く。古いクライアントのために名前も残す。
  function roomTargetOf(room, msg) {
    const i = Math.floor(Number(msg && msg.idx));
    if (Number.isFinite(i) && i >= 0 && i < room.players.length) return room.players[i];
    const name = String((msg && msg.name) == null ? '' : msg.name).slice(0, 40);
    return name ? (room.players.find(p => sockName(p) === name) || null) : null;
  }

  // 👑 ホストは「配列の0番目」ではなく、部屋が覚えている1人（room.host）。
  //
  //   以前は players[0] だった。ところが startRoom は対戦席の人を splice で
  //   抜き、endRoomSpectate は**末尾に** push して戻す ── つまりホストが
  //   自分で1試合遊ぶだけで、王冠は観戦席の先頭へ黙って移り、戻ってこない。
  //   譲渡もキックも無いので取り返す手段もなく、画面には理由も出ない
  //   （王冠の位置と「対戦開始！」の有無が入れ替わるだけ）。
  //   server/party.js の leaderId には「『配列の先頭が偉い』にしておくと、
  //   並び替えたときに壊れる」と、まさにこの罠がコメントで残っている。
  //
  //   席の並び順（＝交代で遊ぶ順番）はこれまでどおり配列順のまま。
  //   動かさないのは王冠だけ。
  function ensureHost(room) {
    const away = Array.isArray(room.away) ? room.away : [];
    const alive = p => p && p.readyState === p.OPEN;
    // 試合中はホストが away 側にいる（対戦席の人は部屋から抜けている）。
    if (room.host && alive(room.host) && (room.players.includes(room.host) || away.includes(room.host))) {
      return room.host;
    }
    // いなくなったら、いま部屋にいるいちばん古い人へ。試合中なら出場者も候補。
    room.host = room.players.concat(away).find(alive) || null;
    return room.host;
  }
  const isRoomHost = (room, ws) => ensureHost(room) === ws;

  // 席の整え直し。入室順に対戦席を埋め、あふれたら観戦席へ落とす。
  // ホストが明示的に観戦席へ回した人（benched）は繰り上げない ── 自動で
  // 戻すと「ホストが決めた席割り」を機械が上書きしてしまう。
  function reseat(room) {
    // 🩹 試合中は席を組み直さない。部屋に残っているのは**全員が観戦者**で、
    //    対戦席の人は startRoom で room.players から抜けている。
    //    ここで組み直すと観戦者の先頭が「対戦席」に繰り上がり、
    //    yourSeat が play になって画面の説明と食い違う（以前はそのうえ
    //    case 'watch' の門にも弾かれて、観戦相手を切り替えられなかった）。
    //    reseat は誰かが抜けたときにも呼ばれるので、判定はここ1か所に置く。
    //    席の組み直しは試合が終わったとき endRoomSpectate がやる。
    if (room.matchId) { for (const p of room.players) room.watch.add(p); return; }
    const need = roomSeats(room);
    let n = 0;
    for (const p of room.players) {
      if (room.benched.has(p)) { room.watch.add(p); continue; }
      if (n < need) { room.watch.delete(p); n++; }
      else room.watch.add(p);
    }
  }

  // 試合中の観戦席へ配る中身（watch / watchable）。ロイヤルと同じ取り決め。
  function roomWatchExtra(room, ws) {
    const match = room.matchId ? matches.get(room.matchId) : null;
    if (!match || match.ended) return null;
    const list = matchWatchable(match);
    const target = pickWatch(list, ws);
    return {
      inMatch: true,
      remain: Math.max(0, Math.round((match.startedAt + (COUNTDOWN + match.duration) * 1000 - Date.now()) / 1000)),
      // 🎨 見ている相手のスキン。**この1人ぶんだけ**（watchable には載せない）
      //    ── 一覧に載せると、観戦者全員が「名前→スキン」の対応表を常時持つ。
      //    見ていない相手の見た目まで配る必要は無い。
      watch: target
        ? { name: target.name, score: target.score, skin: watchSkinOf(match, target.slot),
          grid: matchGridOf(match, target.slot) }
        : null,
      watchable: list.map(x => ({ name: x.name, score: x.score, alive: x.alive })),
    };
  }

  function broadcastRoom(room) {
    const seats = roomSeats(room);
    const hostSock = ensureHost(room);
    for (const ws of room.players) {
      if (ws.readyState !== ws.OPEN) continue;
      send(ws, {
        type: 'room_update',
        code: room.code,
        settings: room.settings,
        youAreHost: hostSock === ws,
        // 席の内訳。クライアントは seats（対戦席の数）と max（定員）で
        // 「◯/8人・対戦席2」のような表示ができる。
        seats, max: ROOM_MAX,
        yourSeat: room.watch.has(ws) ? 'watch' : 'play',
        // 🏴 idx（席の連番）と team を載せる。
        //    ⚠ 人を指すのに **表示名を使わない**。ゲスト名は重複できるので
        //      （名前の予約は登録ユーザー・予約名・住人名しか弾かない）、
        //      名前で引くと同名の先頭に当たって「押した行と別の人が動く」。
        //    team は sanitize.js の SECRET_KEYS に無いので関門で落ちない
        //    （チーム分けは全員に見えてよい情報）。
        players: room.players.map((p, i) => ({
          idx: i,
          name: sockName(p), isHost: p === hostSock, isYou: p === ws,
          seat: room.watch.has(p) ? 'watch' : 'play',
          team: room.teams && room.teams.has(p) ? room.teams.get(p) : null,
        })),
        ...(roomWatchExtra(room, ws) || { inMatch: false }),
      });
    }
  }

  function leaveRoom(ws, notify = true) {
    const room = roomOf(ws);
    ws.roomCode = null;
    ws.watchTarget = null;
    if (!room) return;
    const i = room.players.indexOf(ws);
    if (i !== -1) room.players.splice(i, 1);
    room.watch.delete(ws);
    room.benched.delete(ws);
    if (room.teams) room.teams.delete(ws);
    // 試合中の部屋は、観戦者が全員抜けても消さない ── 対戦席の人たちが
    // room.away に控えていて、試合が終わったらここへ戻ってくる。
    // 消すと彼らは戻る先を失う（endRoomSpectate が rooms.has で引き返す）。
    // 誰も戻らなかったときの片付けは endRoomSpectate がやる。
    if (room.players.length === 0 && !room.matchId) { clearInterval(room.specTick); rooms.delete(room.code); }
    else { reseat(room); if (notify) broadcastRoom(room); }
  }

  function startRoom(ws) {
    const room = roomOf(ws);
    // 無言 return だった。部屋が消えたあとも画面は見た目がそのまま残るので
    // （クライアントは showScreen するだけ）、押しても音だけ鳴って何も起きない──
    // 何が起きているのか分からない。理由を返す。
    if (!room) { send(ws, { type: 'room_error', error: 'ルームが見つかりません' }); return; }
    if (!isRoomHost(room, ws)) { send(ws, { type: 'room_error', error: 'ホストのみ開始できます' }); return; }
    if (room.matchId) { send(ws, { type: 'room_error', error: 'まだ試合中です' }); return; }
    const need = roomSeats(room);
    const coop = room.settings.mode === 'coop';
    const land = room.settings.mode === 'land';
    reseat(room);   // 設定変更の直後などに席がズレたままにしない
    const play = roomPlaying(room);
    // 対戦席が空っぽ（全員が観戦席）だと、ボットだけの試合を観るだけになる。
    if (!play.length) {
      send(ws, { type: 'room_error', error: '対戦席に誰もいません（観戦席から誰かを対戦席へ）' });
      return;
    }
    if (play.length < need && !room.settings.botFill) {
      send(ws, { type: 'room_error', error: `あと${need - play.length}人必要です（ボット補充をONにもできます）` });
      return;
    }
    // 🏴 チーム分け。ホストが席ごとに決めていればそれを使い、
    //    決めていない席は既定式（**前半A・後半B**）で埋める。
    //    以前の既定は `i < 2 ? 0 : 1` で、席を4より増やすと必ず 2 vs N-2 になっていた
    //    （実測 seats=6 で teams=[0,0,1,1,1,1]）。
    //    協力プレイは1つの盤面を共有するので全員チーム0のまま。
    const half = Math.ceil(need / 2);
    const teamOf = (p, i) => {
      if (coop) return 0;
      if (p && room.teams && room.teams.has(p)) return room.teams.get(p);
      return room.settings.team ? (i < half ? 0 : 1) : i % 2;
    };
    const entries = play.map((p, i) => ({ sock: p, team: teamOf(p, i) }));
    // 観戦者の名前もボットの名前空間から外す（同名の対戦相手が出ると
    // 観戦席の本人が盤面に二重に現れて見える）。
    const used = new Set(room.players.map(p => sockName(p)));
    // 🤖 ボットは**人数の少ないチーム**へ入れる。既定式のまま添字で決めると、
    //    ホストが手で決めた席割りとズレて 3 vs 1 のような試合になる。
    while (entries.length < need) {
      let team = 0;
      if (!coop) {
        const a = entries.filter(e => e.team === 0).length;
        const b = entries.filter(e => e.team === 1).length;
        team = room.settings.team ? (a <= b ? 0 : 1) : entries.length % 2;
      }
      entries.push({ sock: new Bot(room.settings.botLevel, used), team });
    }
    // 対戦席の人だけ部屋から出す（従来どおり）。観戦席の人は部屋に残り、
    // 部屋そのものが観戦のための入れ物になる ── 試合中も room_update が
    // 届き続けるので、watch / watchable をそこに載せられる。
    for (const p of play) {
      const i = room.players.indexOf(p);
      if (i !== -1) room.players.splice(i, 1);
      room.watch.delete(p);
      room.benched.delete(p);
      p.roomCode = null;
    }
    // 🔁 出ていった人を控えておく。試合が終わったら endRoomSpectate が部屋へ
    //   戻す ── 戻さないと1試合ごとに2人が部屋から落ち、遊び方画面が謳う
    //   「交代で遊ぶ」に合言葉の入り直しが要る。
    room.away = play.slice();
    const watchers = room.players.slice();
    // 🚪 観戦者がゼロでも部屋を消さない。
    //
    //   ここは長らく `if (!watchers.length) rooms.delete(room.code)` だった。
    //   ところが **友達2人で 1v1** は両方とも対戦席に座るので watchers は
    //   必ず空 ── つまりこの機能のいちばん普通な使い方で、「対戦開始！」を
    //   押した瞬間に部屋が消えていた。match.roomCode も張られないので
    //   endRoomSpectate も一度も走らず、結果画面の「ルームへ」はもう無い
    //   部屋の画面を見せ、「対戦開始！」を押しても無言で何も起きなかった。
    //   （3人以上で集まった人だけが連戦できていた。）
    //   空の部屋が残り続けることはない ── specTick が試合の終わりを見て
    //   endRoomSpectate を呼び、そこで誰も戻らなければ部屋を消す。
    const match = createMatch({
      // ⚔️ 'attack' の枝が無かった。部屋で「攻撃戦」を選べるようにしたとき
      //    cleanSettings には追加したのにこちらを忘れていて、attack は
      //    team=false なので**必ず duel** に落ちていた（お邪魔が一度も飛ばない）。
      //    受け側（case 'attack' と match.mode === 'attack'）はもとから揃っている。
      mode: coop ? 'coop' : land ? 'land' : room.settings.mode === 'attack' ? 'attack'
        : room.settings.team ? 'team' : 'duel',
      entries,
      // 陣取りは時間制。部屋で選んだ長さ（60/120/180秒）をそのまま使う。
      duration: coop ? COOP_MAX_SECS : room.settings.duration,
      rated: false,
    });
    // 部屋を試合の「観戦室」にする。観戦者がいなくても張る ──
    // match.roomCode が無いと、試合後に出場者を部屋へ戻せない。
    room.matchId = match.id;
    match.roomCode = room.code;
    for (const p of watchers) p.watchTarget = null;   // 既定は「おまかせ＝首位」
    // 残った人は全員が観戦者。room.matchId を立てたあとなので、reseat は
    // 上の門で「全員 watch」にして返る（席の組み直しは試合が終わってから）。
    reseat(room);
    broadcastRoom(room);
    clearInterval(room.specTick);
    room.specTick = setInterval(() => {
      const m = room.matchId ? matches.get(room.matchId) : null;
      if (!m || m.ended) { endRoomSpectate(room); return; }
      broadcastRoom(room);
    }, 1000);
  }

  // 試合が終わったら観戦を畳んで、ふつうの部屋に戻す。
  function endRoomSpectate(room) {
    if (!room) return;
    clearInterval(room.specTick);
    room.specTick = null;
    room.matchId = null;
    if (!rooms.has(room.code)) { room.away = null; return; }
    for (const p of room.players) p.watchTarget = null;
    // 🔁 試合に出ていた人を部屋へ戻す（出ていった順のまま末尾に付ける）。
    //   観戦していた人が room.players の前に居るので、次の試合は自然に
    //   その人たちが対戦席に座る ＝「交代で遊ぶ」が回る。
    const away = Array.isArray(room.away) ? room.away : [];
    room.away = null;
    for (const p of away) {
      if (!p || p.readyState !== p.OPEN) continue;   // 切れた人は戻さない
      if (p.roomCode) continue;                      // 別の部屋へ移った人も戻さない
      if (room.players.includes(p)) continue;
      if (room.players.length >= ROOM_MAX) break;
      p.roomCode = room.code;
      room.players.push(p);
    }
    // 対戦席は空になったので、観戦席の人が繰り上がって次の試合を組める。
    // ⚠ benched（ホストが「観戦席へ」と決めた人）は消さない ── 消すと
    //   ホストの席割りが毎試合リセットされ、ホスト自身が毎回対戦席に戻る。
    room.watch.clear();
    // 試合中に全員が切れた（または別の部屋へ移った）とき、ここで部屋を畳む。
    // 観戦者ゼロでも部屋を残すようにしたので（startRoom）、掃き口はここだけ。
    if (room.players.length === 0) { clearInterval(room.specTick); room.specTick = null; rooms.delete(room.code); return; }
    reseat(room);
    broadcastRoom(room);
  }

  // -------------------------------------------------------------------------
  // 試合（room 経由）の観戦データ
  // -------------------------------------------------------------------------
  // ロイヤルと同じ形（name / score / alive）。**正体に関わる値は入れない**。
  // 観戦している1人のスキン。**必ず文字列**（null にしない）── キーの有無や
  // null かどうかで席が選り分けられると、それがそのまま正体になる。
  function watchSkinOf(match, slot) {
    const p = match.players.find(x => x.slot === slot);
    return p ? sockSkin(p.sock) : DEFAULT_EQUIPPED.skin;
  }

  function matchWatchable(match) {
    return match.players
      .map(p => ({
        slot: p.slot, name: sockName(p.sock),
        score: Math.floor(p.score || 0),
        alive: !p.finished && !p.forfeited,
      }))
      // 順位順（まだ打っている人が上、その中で点の高い順）。
      .sort((a, b) => (Number(b.alive) - Number(a.alive)) || (b.score - a.score))
      .slice(0, WATCHABLE_MAX);
  }

  // 見ている1人ぶんの盤面だけを取り出す。
  //   ・協力/陣取りは1盤面（サーバー権威）なのでそれを返す
  //   ・それ以外は各プレイヤーの最後の盤面（broadcastState が控えている）
  function matchGridOf(match, slot) {
    if (match.engine) return match.engine.snapshot();
    const p = match.players[slot];
    return p && Array.isArray(p.grid) ? p.grid : null;
  }

  // -------------------------------------------------------------------------
  // Online tournament: 8 entrants (humans seeded apart, AI players fill),
  // 3 knockout rounds run as real server matches. Bot-vs-bot pairs resolve
  // by weighted coin flip so the whole bracket stays believable.
  // -------------------------------------------------------------------------

  function entrantAlive(s) { return s.isBot || (s.readyState === s.OPEN); }

  function startTourney(humanSocks) {
    const id = crypto.randomUUID();
    const used = new Set(humanSocks.map(s => sockName(s)));
    // Humans at bracket slots 0,2,4,6 first — they can't meet before the SF.
    const positions = [0, 2, 4, 6, 1, 3, 5, 7];
    const slots = new Array(8).fill(null);
    humanSocks.slice(0, 8).forEach((ws, i) => { slots[positions[i]] = ws; });
    for (let i = 0; i < 8; i++) if (!slots[i]) slots[i] = new Bot('random', used);
    // 🎭 組の中の左右を入れ替える。
    //
    //    上の positions は「人間どうしが準決勝より前に当たらない」ためのもので、
    //    その性質は組の**中**で入れ替えても保たれる（同じ組の2人が誰かは変わらない）。
    //    ところが入れ替えないと、人間は必ず各組の左に置かれる ── 参加した人間が
    //    4人以下なら**右列の4つの名前は毎回100%AI**。友達2人で同時に並べば
    //    2人とも自分の行の左に出ることが確認でき、以後どの大会でも同じなので
    //    「右列＝AI」が確定する。
    for (let i = 0; i < 8; i += 2) {
      if (crypto.randomInt(2)) { const tmp = slots[i]; slots[i] = slots[i + 1]; slots[i + 1] = tmp; }
    }
    const t = { id, round: 0, alive: slots, ended: false, pending: 0, results: [], timers: [] };
    tourneys.set(id, t);
    for (const ws of humanSocks) ws.tourneyId = id;
    broadcastTourney(t, { next: 2500 });
    t.timers.push(setTimeout(() => runTourneyRound(t), 2500));
  }

  function broadcastTourney(t, extra = {}) {
    for (const s of t.alive) {
      if (s.isBot) continue;
      const pairs = [];
      for (let i = 0; i < t.alive.length; i += 2) {
        pairs.push([t.alive[i], t.alive[i + 1]].map(e => ({
          name: sockName(e), rating: sockRating(e), you: e === s,
        })));
      }
      send(s, {
        type: 'tourney_state',
        round: t.round, rounds: TOURNEY_ROUND_SECS.length,
        roundSecs: TOURNEY_ROUND_SECS[t.round],
        pairs, ...extra,
      });
    }
  }

  function runTourneyRound(t) {
    if (t.ended) return;
    const secs = TOURNEY_ROUND_SECS[t.round];
    const final = t.alive.length === 2;
    t.results = new Array(t.alive.length / 2).fill(null);
    t.pending = 0;
    for (let p = 0; p < t.alive.length; p += 2) {
      const a = t.alive[p], b = t.alive[p + 1];
      // Rising difficulty: an AI player facing a human plays at round strength.
      const lv = TOURNEY_BOT_LEVELS[Math.min(t.round, TOURNEY_BOT_LEVELS.length - 1)];
      for (const s of [a, b]) {
        // 👑 王者だけはラウンドの強さに引き下げない（専用AIのまま）。
        if (s.isBot && !s.champion) s.level = lv[crypto.randomInt(lv.length)];
      }
      const aLive = entrantAlive(a), bLive = entrantAlive(b);
      if (!aLive || !bLive) {
        // A disconnected human loses on the spot (bot walks over too).
        t.results[p / 2] = aLive ? a : bLive ? b : (a.isBot ? a : b);
        // 決勝が不戦勝で終わると createMatch を通らず endMatch の優勝報酬が走らない。
        // finishTourneyRound で埋め合わせるため印を残す。
        if (final) t.walkoverFinal = true;
        continue;
      }
      if (a.isBot && b.isBot) {
        const rank = { easy: 0, normal: 1, hard: 2, oni: 3 };
        const pa = 0.5 + 0.18 * ((rank[a.level] || 0) - (rank[b.level] || 0));
        t.results[p / 2] = Math.random() < pa ? a : b;
        continue;
      }
      t.pending++;
      createMatch({
        mode: 'duel', rated: false, duration: secs,
        entries: [{ sock: a, team: 0 }, { sock: b, team: 1 }],
        tourney: { id: t.id, pair: p / 2, round: t.round, final },
      });
    }
    if (t.pending === 0) finishTourneyRound(t);
  }

  // ブラケットの勝者を決める。同点でも必ず片方を返す（勝ち上がりが止まると
  // 大会が進まないため）。endMatch が result を作る「前」にこれを呼ぶので、
  // 判定は endMatch と共有できるよう関数に切り出してある。
  function tourneyWinnerIdx(match) {
    const ts = teamScores(match);
    let winIdx = ts[0] > ts[1] ? 0 : ts[1] > ts[0] ? 1 : null;
    if (match.players[0].forfeited && !match.players[1].forfeited) winIdx = 1;
    else if (match.players[1].forfeited && !match.players[0].forfeited) winIdx = 0;
    if (winIdx === null) {
      // Tie: a human beats an AI player; human-vs-human ties flip a coin.
      const aHuman = !match.players[0].sock.isBot, bHuman = !match.players[1].sock.isBot;
      winIdx = aHuman && !bHuman ? 0 : bHuman && !aHuman ? 1 : (Math.random() < 0.5 ? 0 : 1);
    }
    return winIdx;
  }

  // winIdx は endMatch が先に決めたもの。コイン投げをここでもう一度やると
  // 本人に送った result と逆の側が勝ち上がりかねないので、必ず受け取る。
  function tourneyMatchEnd(match, winIdx) {
    const t = tourneys.get(match.tourney.id);
    if (!t || t.ended) return;
    if (winIdx == null) winIdx = tourneyWinnerIdx(match);
    const loser = match.players[1 - winIdx].sock;
    if (!loser.isBot) loser.tourneyId = null;
    t.results[match.tourney.pair] = match.players[winIdx].sock;
    t.pending--;
    if (t.pending === 0) finishTourneyRound(t);
  }

  function finishTourneyRound(t) {
    if (t.ended) return;
    t.alive = t.results.slice();
    t.round++;
    if (t.alive.length === 1) {
      const champ = t.alive[0];
      const walkover = !!t.walkoverFinal;
      endTourney(t);
      if (!champ.isBot) {
        // 通常は決勝が endMatch を通って優勝報酬（バッジ 'tourney'+100💎・totalWins・
        // 履歴）が付くが、決勝が不戦勝だと endMatch を通らないのでここで付ける。
        const cu = walkover && champ.user ? db.users[champ.user.id] : null;
        if (cu) {
          // 🏆 不戦勝の優勝。**duration 0 を渡してはいけない** ──
          //    applyGameResult は duration を 1秒に丸めたうえ、score 0 / lines 0 で
          //    idleResult（＝遊んだ形跡なし）と見なして paceScale を 0 に落とすので、
          //    コインもパスXPもアカウントXPも全部 0 になっていた。
          //    「決勝を戦って勝った人」と同じ土俵にするため、決勝ラウンドの
          //    持ち時間を実体として渡す（順位報酬に相当するバッジと💎は別枠で付く）。
          const rewards = applyGameResult(cu, {
            trusted: true, mode: 'tournament', won: true, drew: false, tourneyFinal: true,
            score: 0, lines: 0, maxCombo: 0,
            duration: TOURNEY_ROUND_SECS[TOURNEY_ROUND_SECS.length - 1], pieces: 0,
          });
          saveDb();
          send(champ, { type: 'tourney_champion', rewards, user: publicUser(cu) });
        } else {
          send(champ, { type: 'tourney_champion' });
        }
        champ.tourneyId = null;
      }
      broadcastAll({
        type: 'announce',
        message: `オンライントーナメントで「${sockName(champ)}」が優勝！`,
        messageEn: `"${sockName(champ)}" wins the online tournament!`,
        from: '大会運営',
      });
      return;
    }
    if (!t.alive.some(s => !s.isBot && entrantAlive(s))) {
      // every human is gone — no point simulating the rest
      endTourney(t);
      return;
    }
    broadcastTourney(t, { next: TOURNEY_INTERMISSION });
    t.timers.push(setTimeout(() => runTourneyRound(t), TOURNEY_INTERMISSION));
  }

  function endTourney(t) {
    t.ended = true;
    for (const timer of t.timers) clearTimeout(timer);
    for (const s of t.alive) if (!s.isBot && s.tourneyId === t.id) s.tourneyId = null;
    tourneys.delete(t.id);
  }

  // -------------------------------------------------------------------------
  // 💯 Battle Royale (v2.11 rewrite)
  //
  // What changed and why:
  //  * The 99 AI entrants used to be pure score curves (`score += rate`). Their
  //    ceiling sat ABOVE what a human can physically reach in 180 seconds, so
  //    winning was luck. They now run the SAME Engine and the SAME chooseMove
  //    the AI-duel bots use — measured at ~0.2ms per move, so a full field of
  //    99 costs about 2% of one core. Weak bots now genuinely top out and die,
  //    which is where most of the early attrition comes from.
  //  * Survivors interact: clearing 2+ lines sends garbage at someone else,
  //    reusing the attack-duel pipeline verbatim. Being buried is how you die.
  //  * A rising storm pressures everyone as the clock runs down.
  //  * Elimination is by PLACEMENT, not "rank among survivors" — leaving early
  //    while ahead now gives you the place you actually left in.
  //  * Dying is not the end of the session: you drop into spectator mode with
  //    the leader's live board and the standings.
  // -------------------------------------------------------------------------

  const ROYALE_SIZE = 100;
  const ROYALE_DURATION = Math.max(30, Number(process.env.ROYALE_SECS) || 180);
  const ROYALE_TICK = 250;
  // At these fractions of the match, the field is cut down TO `keep` players.
  const ROYALE_CUTS = [
    { at: 1 / 6, keep: 70 }, { at: 2 / 6, keep: 45 }, { at: 3 / 6, keep: 25 },
    { at: 4 / 6, keep: 12 }, { at: 5 / 6, keep: 5 },
  ];
  // 🌩️ The storm: from this fraction onward everyone still alive takes a pulse
  // of garbage every `everyMs`, and it gets worse. This is the block-puzzle
  // equivalent of a closing circle — a shrinking grid cannot work here because
  // a blocked outer ring would make every row permanently unclearable.
  const ROYALE_STORM = [
    { at: 0.34, cells: 2, everyMs: 9000 },
    { at: 0.58, cells: 3, everyMs: 7000 },
    { at: 0.78, cells: 4, everyMs: 5000 },
    { at: 0.90, cells: 5, everyMs: 3500 },
  ];
  // Field composition, tuned by simulating the whole 180 seconds offline:
  // with the storm running, 15 of 99 bots survive to the end, the best bot
  // lands around 11,000-12,000, and a human placing ~9,000 finishes top 10
  // while ~12,000 wins it. (The old score curves topped out near 19,000 —
  // above what a human can physically reach in 180s.) Cost: 0.5% of one core.
  const ROYALE_FIELD = [
    { level: 'easy',   n: 26, moveEvery: 2000 },
    { level: 'normal', n: 28, moveEvery: 1700 },
    { level: 'hard',   n: 26, moveEvery: 1350 },
    { level: 'oni',    n: 13, moveEvery: 1150 },
    { level: 'kami',   n: 6,  moveEvery: 950 },
  ];

  function royaleBotSeats() {
    const seats = [];
    for (const f of ROYALE_FIELD) for (let i = 0; i < f.n; i++) seats.push(f);
    return seats;
  }

  function startRoyale(humanSocks) {
    const id = crypto.randomUUID();
    const used = new Set(humanSocks.map(s => sockName(s)));
    const seed = Math.floor(Math.random() * 2 ** 31);
    // 🎨 スキンは**人も住人も同じ欄**に持たせる。片方にしか無いと、
    //    観戦の応答で欄の有無が割れて、そのまま正体になる。
    const entrants = humanSocks.map(ws => ({
      ws, human: true, name: sockName(ws), score: 0, lines: 0, combo: 0,
      skin: sockSkin(ws),
      alive: true, placement: null, kills: 0, revives: 1, grid: null, lastSeen: Date.now(),
    }));

    const seats = royaleBotSeats();
    // Shuffle so the strong seats are not always the same slots.
    for (let i = seats.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
    let si = 0;
    while (entrants.length < ROYALE_SIZE) {
      const seat = seats[si++ % seats.length];
      const res = Math.random() < 0.6 ? pickResidentBot(seat.level, used) : null;
      const name = res ? res.name : pickPersona({ used }).name;
      used.add(name);
      entrants.push({
        human: false, name, level: seat.level,
        // 住人・使い捨てのスキンは seatProfile（1本化してある唯一の場所）から。
        skin: seatProfile({
          resident: res, name, level: seat.level,
          registered: res ? res.registered !== false : true,
        }).skin,
        // Humans all share `seed` (that is the fairness guarantee, and the old
        // code broke it by seeding each human separately). Bots get their own
        // streams on purpose: an identical sequence made same-level bots play
        // the same game and finish on identical scores.
        engine: new Engine((seed + si * 7919) >>> 0),
        moveEvery: seat.moveEvery,
        nextMoveAt: Date.now() + COUNTDOWN * 1000 + Math.random() * seat.moveEvery,
        score: 0, lines: 0, combo: 0, alive: true, placement: null, kills: 0, revives: 1,
      });
    }

    const r = {
      id, entrants, startedAt: Date.now(), ended: false,
      cutIdx: 0, stormIdx: 0, nextStormAt: 0, lastState: 0, finale: false, seed,
    };
    royales.set(id, r);
    for (const e of entrants) {
      if (!e.human) continue;
      e.ws.royaleId = id;
      send(e.ws, {
        type: 'royale_found',
        duration: ROYALE_DURATION, countdown: COUNTDOWN, players: ROYALE_SIZE,
        seed,
      });
    }
    r.tick = setInterval(() => tickRoyale(r), ROYALE_TICK);
  }

  const royaleAlive = r => r.entrants.filter(e => e.alive);
  function royaleRanked(r) {
    return royaleAlive(r).sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // 👀 観戦（バトルロイヤル と カスタムルームの観戦席で「同じ仕組み」を使う）
  // -------------------------------------------------------------------------
  // 取り決め（この波の3タスク共通・勝手に変えない）:
  //   クライアント → { type:'watch', target: string|null }   null は「おまかせ＝首位」
  //   サーバー   → watch:     { name, score, grid } | null    いま見ている相手
  //               watchable: [{ name, score, alive }]        選べる相手（順位順）
  //
  // 守ること:
  //   ・watchable に正体（isBot/resident/…）を**絶対に載せない**。名前・点・
  //     生死だけ。送信の関門（send → scrubFor）でも落ちるが、そもそも作らない。
  //   ・多いと帯域を食うので上位20人で切る。
  //   ・盤面（64マス）を送るのは「その観戦者が見ている1人ぶん」だけ。
  //     100人ぶんを毎秒配ると 100観戦者 × 100盤面 になって現実的でない。
  const WATCHABLE_MAX = 20;
  // 見たい相手の名前は socket に持つ（1本の socket はロイヤルかルームの
  // どちらか一方にしか居ないので、置き場所は1つで足りる）。
  const watchNameOf = ws => (ws && ws.watchTarget) || null;

  // 指名が居ない／脱落したら黙って固まらせず、自動で首位へ戻す。
  function pickWatch(list, ws) {
    const want = watchNameOf(ws);
    if (want) {
      const hit = list.find(x => x.name === want);
      if (hit) return hit;
      ws.watchTarget = null;   // もう見られない相手 → おまかせ（首位）へ
    }
    return list[0] || null;
  }

  // ロイヤルの「選べる相手」。順位順（＝強い人が上）で上位20人。
  function royaleWatchable(ranked) {
    return ranked.slice(0, WATCHABLE_MAX)
      .map(e => ({ name: e.name, score: Math.floor(e.score), alive: true }));
  }

  // Everyone still in, plus everyone watching, gets world events.
  function royaleBroadcast(r, msg, { spectators = true } = {}) {
    for (const e of r.entrants) {
      if (!e.human || e.ws.readyState !== e.ws.OPEN) continue;
      if (!e.alive && !spectators) continue;
      send(e.ws, msg);
    }
  }

  function royaleFeed(r, item) {
    royaleBroadcast(r, { type: 'royale_feed', ...item });
  }

  // ---- garbage warfare -----------------------------------------------------
  //
  // A 2+ line clear buries someone else. Targeting is deliberate: most of the
  // time it hits the current leader (a bounty that keeps #1 honest), otherwise
  // a random survivor. Never yourself.
  // lines は deliverAttack と同じ理由で持ち回す（個数からは逆算できない）。
  function royaleAttack(r, from, cells, lines = 0) {
    if (!cells || r.ended) return;
    const others = royaleAlive(r).filter(e => e !== from);
    if (!others.length) return;
    const leader = others.reduce((a, b) => (b.score > a.score ? b : a), others[0]);
    // Bounty rate: at 45% an early leader drew fire from ~99 attackers at once
    // and was reliably buried before halfway — leading has to be dangerous,
    // not fatal. 25% keeps the pressure and leaves the lead survivable.
    const target = (Math.random() < 0.25 && leader !== from) ? leader
      : others[Math.floor(Math.random() * others.length)];
    royaleHit(r, target, cells, from, lines);
  }

  // 🎭 「直前に誰のお邪魔を受けたか」。人間が潰れたときの帰属に使う。
  //    これが無かったころ、矢印つきの撃破ログ（A → B）は**Bが住人のときだけ**
  //    作られていた。人間が誰かのお邪魔で潰れても必ず「名前 脱落」としか出ず、
  //    直前に「◯◯の攻撃！」のトーストで攻撃者まで見えているのに帰属が付かない。
  //    KOトーストも同じで、自分のKO数に数えられる相手は全員住人だった ──
  //    つまり矢印の右に出た名前・KOに出た名前は例外なく住人だと確定できた。
  const ROYALE_BLAME_MS = 6000;   // これより前のお邪魔は「そのせいで潰れた」と見なさない
  function royaleHit(r, target, cells, from, lines = 0) {
    if (!target || !target.alive) return;
    if (from && from !== target) { target.lastHitBy = from; target.lastHitAt = Date.now(); }
    if (target.human) {
      if (target.ws.readyState === target.ws.OPEN) {
        send(target.ws, { type: 'royale_garbage', cells, from: from ? from.name : null, lines });
      } else if (Array.isArray(target.pending) && target.dcUntil && Date.now() < target.dcUntil) {
        // 🔌 **繋ぎ直しの猶予中に飛んできたお邪魔は、捨てずに預かる。**
        //    閉じたソケットへ送って落としていたので、切断している間だけ
        //    誰の攻撃も当たらなかった ── 生存を competing するモードで
        //    「止まっている＝無傷」は、そのまま**切断が最強の防御**になる。
        //    戻ってきた瞬間にまとめて降らせれば、待った得も損も消える。
        //    上限は暴走よけ（猶予は最長25秒なので普通はここまで溜まらない）。
        if (target.pending.length < 12) {
          target.pending.push({ cells, from: from ? from.name : null, lines });
        }
      }
      return;
    }
    const added = target.engine.addGarbage(cells);
    target.grid = null;
    if (target.engine.over && added.length >= 0) royaleTopOut(r, target, from);
  }

  // A top-out is not automatically the end: the first one is a revive (board
  // wiped, 10% of the score burned). The second is elimination — which is what
  // makes burying someone worth doing.
  function royaleTopOut(r, e, by) {
    if (!e.alive || r.ended) return;
    if (e.revives > 0) {
      e.revives--;
      e.score = Math.floor(e.score * 0.9);
      // 復活直後の猶予窓。この間は 'state' の申告でスコアを上げさせない ——
      // topout〜revive の 1RTT に 700ms 周期の pushState が挟まると、没収前の
      // 旧スコアが単調 Math.max で復元され、1割ペナルティが巻き戻っていた。
      e.reviveAt = Date.now();
      if (e.engine) { e.engine.reviveBoard(); e.engine.score = e.score; }
      if (e.human && e.ws.readyState === e.ws.OPEN) {
        send(e.ws, { type: 'royale_revive', score: e.score });
      }
      return;
    }
    const alive = royaleAlive(r).length;
    if (by) {
      by.kills++;
      if (by.human && by.ws.readyState === by.ws.OPEN) {
        send(by.ws, { type: 'royale_kill', victim: e.name, kills: by.kills, alive: alive - 1 });
      }
    }
    royaleFeed(r, {
      kind: 'ko', victim: e.name, by: by ? by.name : null, alive: alive - 1,
    });
    endRoyaleFor(e, r, alive, royaleRanked(r));
  }

  // ---- rewards -------------------------------------------------------------
  //
  // Finishing #2 of 100 used to pay exactly what #97 paid. The ladder is the
  // reason to keep playing when you know you cannot win this one.
  function royalePayout(placement) {
    if (placement === 1) return { coins: 1200, gems: 40, tier: 'champion' };
    if (placement <= 3) return { coins: 700, gems: 20, tier: 'podium' };
    if (placement <= 10) return { coins: 400, gems: 10, tier: 'top10' };
    if (placement <= 25) return { coins: 220, gems: 4, tier: 'top25' };
    if (placement <= 50) return { coins: 120, gems: 1, tier: 'top50' };
    return { coins: 50, gems: 0, tier: 'entrant' };
  }

  // 💯 ロイヤルの申告を取り込む。**'state' と 'royale_topout' の両方から通す。**
  //
  //    切り出した理由: 盤面を詰ませた**最後の1手の得点がサーバーに一度も届いていなかった**。
  //    engine.place() は戻り値を返す前に over を立てるので、その手の
  //    onPlace から呼ばれる pushState は先頭の
  //    `if (this.engine.over || view.inputLocked) return;` で必ず引き返す。
  //    対戦モードには時間切れに client.finish(score) を送る経路があるが、
  //    ロイヤルには無く、royale_topout にもスコアが乗っていなかったので、
  //    順位も順位報酬も「最後に state を送れた時点」の点で確定していた。
  //    ⚙ 上限は元のまま（経過時間 × 500/秒／復活直後の工取り防止の天井）。
  function royaleMergeState(r, e, msg) {
    // Same rate ceiling the REST endpoint applies. Royale scores
    // used to be client-declared with no cross-check at all, and a
    // single forged frame could trigger a server-wide announcement.
    const secs = Math.max(1, (Date.now() - r.startedAt) / 1000);
    const cap = Math.floor(secs * 500);
    const claimed = Math.min(1_000_000, Math.floor(Number(msg.score) || 0));
    // 復活直後の猶予窓では没収後スコアより上げない（1割ペナルティの巻き戻し防止）。
    const ceil = (e.reviveAt && Date.now() - e.reviveAt < 2500) ? e.score : cap;
    e.score = Math.max(e.score, Math.min(claimed, ceil));
    // lines も時間比例で頭打ちにする（下の royale_attack の
    // 攻撃バジェットがこの値を元にするので、素通しだと
    // 「1ラインも消さずに最大威力のお邪魔を撃ち続ける」が通る）
    e.lines = Math.max(e.lines, Math.min(Math.floor(Number(msg.lines) || 0), linesCap(r.startedAt)));
    e.combo = Math.max(e.combo, Math.floor(Number(msg.combo) || 0));
    e.pieces = Math.max(e.pieces || 0, Math.min(20000, Math.floor(Number(msg.pieces) || 0)));
    if (Array.isArray(msg.grid)) e.grid = sanitizeGrid(msg.grid);
    e.lastSeen = Date.now();
  }

  function endRoyaleFor(e, r, placement, ranked) {
    if (!e.alive) return;
    e.alive = false;
    e.placement = placement;
    if (!e.human) return;
    const me = e.ws.user ? db.users[e.ws.user.id] : null;
    let rewards = null;
    const payout = royalePayout(placement);
    // 順位報酬が**実際に入ったか**。ゲスト（アカウント無し）には1枚も入らないのに
    // 結果画面は payout をそのまま描いていたので、未登録の人が1位を取ると
    // 「+1200🪙 +40💎」と表示されたうえで残高が1も動かなかった。
    // 帯の名前（優勝／入賞…）は出したいので payout 自体は送り、
    // 金額を出してよいかだけを別の印で伝える。
    //
    //    ⚠ **接続が生きているかで判定してはいけない。**
    //      ここに readyState === OPEN を入れていたので、回線が切れた人は
    //      3分間走ったロイヤルの報酬を**一枚も受け取れなかった** ──
    //      コインもジェムもXPもミッション進捗も、royalePlays /
    //      royaleKills / royaleBest の記録も、一切付かない。この経路は
    //      切断ハンドラからも呼ばれるので、携帯の画面ロック・
    //      電波の切れ目・Wi-Fiの切り替わりで普通に踏む。
    //      途中離脱は「生存者の中で最下位」という順位で既に罰しているので
    //      （上の close ハンドラのコメント）、その順位の報酬を渡しても
    //      抗えない。報酬は**アカウント**に入るもので、ソケットに入るものではない。
    //      （下の send は閉じたソケットを当然に無視するので、流して問題ない。）
    const payoutGranted = !!me;
    if (payoutGranted) {
      rewards = applyGameResult(me, {
        trusted: true,   // サーバーが順位を決めている（クライアント申告ではない）
        mode: 'royale', score: e.score, lines: e.lines, maxCombo: e.combo,
        pieces: e.pieces || 0,
        duration: Math.max(1, (Date.now() - r.startedAt) / 1000), won: placement === 1,
      });
      // Placement ladder on top of the normal per-run payout.
      //
      // ⚠ ここは applyGameResult の**外**なので、素直に足すと1日の上限
      //   （150,000🪙 / 120💎）をまるごと素通りする。ロイヤルは待ち時間さえ
      //   切れれば何度でも走れるので、1位 1,200🪙+40💎 が無制限に湧いていた。
      //   💎は1日120個の設計なのに、ロイヤル3勝で使い切る量が上限の外から
      //   入っていたことになる。順位報酬も「繰り返し稼げる」ものなので枠を通す。
      //   （バッジ付きの一度きりの節目は別。あちらは通さない。）
      const paidCoins = grindTake(me, 'coins', payout.coins);
      const paidGems = gemTake(me, payout.gems);
      me.coins += paidCoins;
      me.gems += paidGems;
      const s = me.stats;
      s.royalePlays = (s.royalePlays || 0) + 1;
      s.royaleKills = (s.royaleKills || 0) + (e.kills || 0);
      s.royaleBestKills = Math.max(s.royaleBestKills || 0, e.kills || 0);
      if (!s.royaleBest || placement < s.royaleBest) s.royaleBest = placement;
      if (placement === 1) s.royaleWins = (s.royaleWins || 0) + 1;
      if (placement <= 10) s.royaleTop10 = (s.royaleTop10 || 0) + 1;
      saveDb();
    }
    // Spectating: the socket stays in the royale so the player can watch the
    // finish. It is cleared for real when the match ends or they leave.
    send(e.ws, {
      type: 'royale_result',
      placement, players: ROYALE_SIZE, score: e.score, kills: e.kills || 0,
      payout, payoutGranted,
      top: ranked.slice(0, 5).map(x => ({ name: x.name, score: Math.floor(x.score) })),
      rewards, user: me ? publicUser(me) : null,
      spectate: placement > 1 && !r.ended,
    });
  }

  // ---- the tick ------------------------------------------------------------

  function tickRoyale(r) {
    if (r.ended) return;
    const now = Date.now();
    const elapsed = (now - r.startedAt) / 1000 - COUNTDOWN;
    if (elapsed < 0) return;

    // --- 落ちた人を席から外す ---
    // 回線が切れても FIN が届かないことがあり（電波が切れた端末など）、
    // readyState はしばらく OPEN のまま。その間その人は「生存者」として
    // ランキングに居座り、カットの生き残り枠や優勝まで奪ってしまう。
    // 本命の判定は readyState。死んだソケットは 30秒ごとの ping/pong で
    // terminate されるので、そこで OPEN でなくなる。
    //
    // 無音時間はあくまで保険で、しきい値は長くとる。lastSeen を更新するのは
    // クライアントの state 送信（700ms ごとの setInterval）だけで、スマホで
    // アプリを切り替えたり画面をロックすると、その setInterval はブラウザに
    // 止められる。回線は生きているのにタイマーだけ凍る状態で、ここを短く
    // すると「席を外しただけで失格」になってしまう。ping への応答は
    // ブラウザ本体が返すので readyState 側は正しく生きたままになる。
    const gone = [];
    for (const e of r.entrants) {
      if (!e.alive || !e.human) continue;
      // 🔌 繋ぎ直しの猶予中は席を残す（close ハンドラが e.dcUntil を立てる）。
      //    期限が過ぎたらここで確定する ── 順位の決まり方は今までどおり。
      if (e.dcUntil && now < e.dcUntil) continue;
      const dead = e.ws.readyState !== e.ws.OPEN;
      const silent = now - (e.lastSeen || now) > 90000;
      if (!dead && !silent) continue;
      gone.push(e);
    }
    if (gone.length) {
      // まとめて外れるときは、スコアの低い人から先に確定させる。
      // 以前は r.entrants の並び順で決めていたので、スコアの低いほうが
      // 良い順位を取ることがあった。順位は報酬と戦績（royaleBest /
      // royaleWins / royaleTop10）に残るので、実害のあるズレだった。
      // 足切り（下の royale_cut）と同じ「下位から先に」に揃える。
      const ranked = royaleRanked(r);
      gone.sort((a, b) => a.score - b.score);
      for (const e of gone) {
        endRoyaleFor(e, r, royaleAlive(r).length, ranked);
        // 🎭 'left' は使わない（close ハンドラの注記 ── 実プレイヤーの目印になる）。
        royaleFeed(r, { kind: 'ko', victim: e.name });
      }
    }

    // --- AI entrants actually play ---
    for (const e of r.entrants) {
      if (!e.alive || e.human || !e.engine) continue;
      let guard = 0;
      while (now >= e.nextMoveAt && !e.engine.over && guard++ < 4) {
        const mv = chooseMove(e.engine, e.level);
        if (!mv) { e.engine.over = true; break; }
        const res = e.engine.place(mv.index, mv.row, mv.col);
        e.nextMoveAt = now + e.moveEvery * (0.75 + Math.random() * 0.5);
        if (!res) break;
        e.score = e.engine.score;
        e.lines = e.engine.linesCleared;
        e.combo = Math.max(e.combo, e.engine.maxCombo);
        e.grid = null;
        if (res.lineCount >= 2) royaleAttack(r, e, attackCells(res.lineCount, res.streak), res.lineCount);
      }
      if (e.engine.over) royaleTopOut(r, e, null);
    }

    // --- 🌩️ the storm ---
    const storm = ROYALE_STORM[r.stormIdx];
    if (storm && elapsed >= ROYALE_DURATION * storm.at) {
      if (!r.nextStormAt) {
        r.nextStormAt = now;
        royaleFeed(r, { kind: 'storm', cells: storm.cells });
      }
      if (now >= r.nextStormAt) {
        r.nextStormAt = now + storm.everyMs;
        for (const e of royaleAlive(r)) royaleHit(r, e, storm.cells, null);
      }
      const next = ROYALE_STORM[r.stormIdx + 1];
      if (next && elapsed >= ROYALE_DURATION * next.at) { r.stormIdx++; r.nextStormAt = 0; }
    }

    // --- scheduled cuts ---
    const cut = ROYALE_CUTS[r.cutIdx];
    if (cut && elapsed >= ROYALE_DURATION * cut.at) {
      r.cutIdx++;
      const ranked = royaleRanked(r);
      if (ranked.length > cut.keep) {
        const dropped = ranked.slice(cut.keep);
        // Bottom-first, so the last person cut takes the better placement.
        for (let i = dropped.length - 1; i >= 0; i--) {
          endRoyaleFor(dropped[i], r, cut.keep + 1 + i, ranked);
        }
        royaleBroadcast(r, { type: 'royale_cut', eliminated: dropped.length, alive: cut.keep });
        royaleFeed(r, { kind: 'cut', eliminated: dropped.length, alive: cut.keep });
      }
    }

    // --- 🔥 finale: down to the last 3, everyone sees everyone ---
    const aliveNow = royaleAlive(r);
    if (!r.finale && aliveNow.length <= 3 && aliveNow.length > 1) {
      r.finale = true;
      royaleBroadcast(r, {
        type: 'royale_finale',
        players: aliveNow.map(x => ({ name: x.name, score: Math.floor(x.score) })),
      });
      royaleFeed(r, { kind: 'finale', alive: aliveNow.length });
    }

    // --- the end ---
    const humansLeft = r.entrants.some(e => e.alive && e.human && e.ws.readyState === e.ws.OPEN);
    const watching = r.entrants.some(e => e.human && e.ws.readyState === e.ws.OPEN);
    // Nobody is in it and nobody is watching — do not keep simulating a field
    // of bots for three minutes and then announce a "winner" to the world.
    // 🔌 繋ぎ直しの猟予中の人が居るあいだは畳まない。
    //
    //    この行は「誰も見ていないロビーをボットだけで3分回さない」ためのものだが、
    //    readyState しか見ていないので、回線が切れた瞬間の次の tick で
    //    **猟予が明ける前にロビーごと消していた** ―― そのため上の
    //    「落ちた人を席から外す」ブロックが一度も走らず、順位も報酬も確定しないまま
    //    消えていた（切断ハンドラがその場で締めていたころは顔を出さなかった問題）。
    const inGrace = r.entrants.some(e => e.human && e.alive && e.dcUntil && now < e.dcUntil);
    if (!watching && !inGrace) {
      clearInterval(r.tick);
      royales.delete(r.id);
      return;
    }
    if (elapsed >= ROYALE_DURATION || aliveNow.length <= 1) {
      r.ended = true;
      clearInterval(r.tick);
      const ranked = royaleRanked(r);
      for (let i = ranked.length - 1; i >= 0; i--) endRoyaleFor(ranked[i], r, i + 1, ranked);
      const winner = ranked[0];
      // Everyone, including the eliminated, learns who actually won.
      royaleBroadcast(r, {
        type: 'royale_over',
        winner: winner ? { name: winner.name, score: Math.floor(winner.score), kills: winner.kills || 0 } : null,
        top: ranked.slice(0, 5).map(x => ({ name: x.name, score: Math.floor(x.score), kills: x.kills || 0 })),
      });
      for (const e of r.entrants) {
        if (e.human && e.ws.royaleId === r.id) e.ws.royaleId = null;
      }
      // 🎭 告知は**勝者の種類で出し分けない**。
      //
      //    以前は winner.human のときだけ流していた。ところが結果カードには
      //    優勝者の名前とKO数が全員に出るので、プレイヤーはそれをチャットに
      //    流れた告知と見比べるだけでよく、**告知が来なければその優勝者は住人**と
      //    確定できた。100人ロビーではたいてい自分が先に落ちるので、毎試合この
      //    照合ができる。告知の中身は名前・点・KO数だけなので、住人が優勝した回に
      //    流しても正体を明かすことにはならない。
      //    「人が誰も居なかったロビーの結果まで流したくない」を残すなら、
      //    勝者の種類ではなく **そのロビーに人間が居たか** で切ること。
      const hadHuman = r.entrants.some(e => e.human);
      if (winner && hadHuman) {
        broadcastAll({
          type: 'announce',
          message: `バトルロイヤルで「${winner.name}」が100人の頂点に！（${winner.kills || 0}KO）`,
          messageEn: `"${winner.name}" is the last one standing out of 100 in Battle Royale! (${winner.kills || 0} KOs)`,
          from: '大会運営',
        });
      }
      royales.delete(r.id);
      return;
    }

    // --- state sync (1s) ---
    if (now - r.lastState >= 1000) {
      r.lastState = now;
      const ranked = royaleRanked(r);
      const nextCut = ROYALE_CUTS[r.cutIdx];
      // 基準は「最後の生存者」ranked[keep-1]。ranked[keep]（＝切られる側の先頭）を
      // 基準にすると、その本人が safeBy=0 → クライアントの safeBy>=0 判定で「✅安全圏」と
      // 表示されたまま脱落し、下位者への「あと◯点」も足りない値になっていた。
      const cutLine = nextCut && ranked.length > nextCut.keep && nextCut.keep >= 1
        ? ranked[nextCut.keep - 1] : null;
      const top = ranked.slice(0, 3).map(x => ({ name: x.name, score: Math.floor(x.score), kills: x.kills || 0 }));
      // 観戦者に配る「選べる相手」の一覧は1試合ぶんを1回だけ作る（人数ぶん
      // 作り直すと、100人ロビーでは毎秒 100×20 個のオブジェクトになる）。
      const watchable = royaleWatchable(ranked);
      for (let i = 0; i < r.entrants.length; i++) {
        const e = r.entrants[i];
        if (!e.human || e.ws.readyState !== e.ws.OPEN) continue;
        const rank = e.alive ? ranked.indexOf(e) + 1 : null;
        // 観戦中の人だけ「誰を見ているか」を解決する。盤面はここで1人ぶんだけ
        // 取り出す（royaleGridOf は entrant ごとに1tickキャッシュするので、
        // 同じ相手を10人が見ても snapshot は1回で済む）。
        const target = e.alive ? null : pickWatch(ranked, e.ws);
        const watchEntry = target
          ? {
            name: target.name, score: Math.floor(target.score),
            // 🎨 見ている1人ぶんだけ。watchable（一覧）には**載せない**。
            skin: (typeof target.skin === 'string' && target.skin) || DEFAULT_EQUIPPED.skin,
            grid: royaleGridOf(target),
          }
          : null;
        send(e.ws, {
          type: 'royale_state',
          rank, alive: ranked.length, score: Math.floor(e.score),
          kills: e.kills || 0,
          spectating: !e.alive,
          remain: Math.max(0, Math.round(ROYALE_DURATION - elapsed)),
          top,
          // "You are 1,240 points from safety" beats "a cut is coming".
          safeBy: e.alive && cutLine ? Math.round(e.score - cutLine.score) : null,
          nextCutIn: nextCut ? Math.max(0, Math.round(ROYALE_DURATION * nextCut.at - elapsed)) : null,
          nextKeep: nextCut ? nextCut.keep : null,
          storm: ROYALE_STORM[r.stormIdx] && elapsed >= ROYALE_DURATION * ROYALE_STORM[r.stormIdx].at
            ? ROYALE_STORM[r.stormIdx].cells : 0,
          // 👀 観戦: 既定は首位、`watch` で相手を切り替えられる。
          watch: watchEntry,
          // 選べる相手の一覧（観戦者にだけ配る ── 生存者に渡すと、他人の点を
          // 常時20人ぶん見ながら戦えることになる）。
          watchable: e.alive ? null : watchable,
          finale: r.finale
            ? royaleAlive(r).map(x => ({ name: x.name, score: Math.floor(x.score), grid: royaleGridOf(x) }))
            : null,
        });
      }
    }
    void humansLeft;
  }

  // Bots hold a live Engine; humans relay their grid through 'state'.
  function royaleGridOf(e) {
    if (e.grid) return e.grid;
    if (e.engine) { e.grid = e.engine.snapshot(); return e.grid; }
    return null;
  }


  // -------------------------------------------------------------------------
  // 🔌 再接続の猶予 / 🕒 在席区間ログ
  // -------------------------------------------------------------------------

  // stats の入れ物。index.js の migrateUser が作る形に頼らず、無ければ作る
  // （復元で流れ込んだ古いレコードには stats が無いことがある）。
  const statsOf = u => (u.stats && typeof u.stats === 'object' ? u.stats : (u.stats = {}));

  // 猶予をあと1回使えるか。使えるならその場で回数を1つ進めて true を返す。
  //
  // 数えるのは「猶予を開いた回数」であって「戻ってこられた回数」ではない。
  // 相手を待たせたという事実は、戻ってきたかどうかと関係なく発生するし、
  // 「戻らなかったぶんは数えない」にすると、切って捨てるのがいちばん安く
  // なってしまう（それは対策したい行為そのもの）。
  function takeGraceQuota(user) {
    if (RECONNECT_GRACE_PER_DAY <= 0) return false;
    const st = statsOf(user);
    const day = jstDayKey();
    const rec = (st.dcGrace && typeof st.dcGrace === 'object' && !Array.isArray(st.dcGrace))
      ? st.dcGrace : (st.dcGrace = { day, n: 0, total: 0 });
    if (rec.day !== day) { rec.day = day; rec.n = 0; }
    const n = Math.max(0, Math.floor(Number(rec.n) || 0));
    if (n >= RECONNECT_GRACE_PER_DAY) return false;   // 常習者：猶予なし
    rec.n = n + 1;
    rec.total = Math.max(0, Math.floor(Number(rec.total) || 0)) + 1;
    saveDb();
    return true;
  }

  // 試合が必ず終わる時刻。createMatch の match.timer と同じ式を組み立てる
  // （数字を写すとどちらかを直したときに黙ってズレる）。
  const matchHardEndAt = m => m.startedAt + (COUNTDOWN + m.duration + 12) * 1000;

  // 猶予を開く。開けたら true（＝この切断ではまだ負けにしない）。
  function openReconnectGrace(match, p) {
    if (!match || match.ended || !p || p.finished || p.forfeited || p.dc) return false;
    // 協力プレイは切断しても負けにならない（サーバーが代打する）ので対象外。
    if (match.mode === 'coop') return false;
    // ⚠ ゲストには猶予を出さない。
    //   戻ってきた人が同じ人だと確かめる手段が userId しか無いのに、
    //   ゲストは名乗った名前しか持たない。名前で復帰を許すと
    //   「負けそうになったら切って、同じ名前のゲストで入り直す」が通り、
    //   battle.js が hello の名乗り直しを禁じている理由（敗北・Elo 回避）を
    //   自分で開け直すことになる。
    if (!p.userId) return false;
    const user = db.users[p.userId];
    if (!user || user.banned) return false;
    // 残り時間が無い試合に猶予を出しても戻ってこられない。
    const until = Math.min(Date.now() + RECONNECT_GRACE_MS, matchHardEndAt(match));
    if (until - Date.now() < RECONNECT_GRACE_MIN_MS) return false;
    // 回数の判定は、表をいじる前に済ませる（断るときに古い席の後始末を
    // 壊さないため）。
    if (!takeGraceQuota(user)) return false;
    // 同じ人が別の試合で猶予中、は起こらないはず（1人1試合）だが、
    // 残っていたら古いほうを畳んでから開く（表に2つ入ると復帰先が決まらない）。
    // ⚠ タイマーを消すだけにしてはいけない ── 古い試合の席は p.dc が立った
    //   ままで、猶予切れを鳴らす人が誰も居なくなる。実測では「切断 → すぐ別の
    //   試合に入って切断」で1試合目がハード終了まで宙吊りになり、相手が44秒
    //   余分に待たされた。古い札を捨てる前に、その席を必ず確定させる。
    const old = dcHolds.get(p.userId);
    if (old) {
      clearTimeout(old.timer);
      dcHolds.delete(old.userId);
      const om = matches.get(old.matchId);
      const op = om && !om.ended ? om.players[old.slot] : null;
      // p.dc を先に外す（forfeitPlayer → clearHold が消した札を見に行かない）。
      if (op && op.dc === old) op.dc = null;
      if (op) forfeitPlayer(om, op);
    }

    const hold = { userId: p.userId, matchId: match.id, slot: p.slot, until, timer: null };
    hold.timer = setTimeout(() => {
      dcHolds.delete(hold.userId);
      p.dc = null;
      if (match.ended) return;
      forfeitPlayer(match, p);          // 戻ってこなかった＝従来どおりの敗北
    }, Math.max(0, until - Date.now()));
    // タイマーがイベントループを掴んで、終了時にプロセスが落ちないのを防ぐ。
    if (hold.timer.unref) hold.timer.unref();
    dcHolds.set(p.userId, hold);
    p.dc = hold;

    // 相手への知らせ。⚠ 正体に触れない文言にすること（誰が切れたかは slot
    // だけで足り、「人間だから切れた」と読める言い方をしない）。
    // 既知の割り切り: 住人は切断しないので、この知らせが出た相手は実プレイヤー
    // だと分かる。逆（出ない＝住人）は言えないうえ、実際の切断はごく稀なので、
    // 再接続を諦めるほどの漏れ方ではないと判断した。
    for (const q of match.players) {
      if (q === p || q.sock.isBot) continue;
      // 第5波の統合で modes.js に onOppUnstable() の受け口が付いたので、
      // ここに添えていた「つなぎ」の announce は外した（残すと同じことを
      // 帯とトーストが二重に言う）。
      send(q.sock, { type: 'opp_unstable', slot: p.slot, sec: Math.ceil((until - Date.now()) / 1000) });
    }
    return true;
  }

  // 猶予を畳む（復帰・試合終了・作り直しの共通後始末）。
  function clearHold(p) {
    if (!p || !p.dc) return;
    clearTimeout(p.dc.timer);
    if (dcHolds.get(p.dc.userId) === p.dc) dcHolds.delete(p.dc.userId);
    p.dc = null;
  }

  // 切断・棄権をその場で確定させる。close ハンドラが直接書いていた処理を
  // 関数にしたもの（猶予切れのタイマーからも同じ判定を通したいため）。
  function forfeitPlayer(match, p) {
    if (!match || match.ended || !p || p.finished) return;
    clearHold(p);
    p.forfeited = true;
    p.finished = true;
    const otherHumans = match.players.filter(q => q !== p && !q.sock.isBot && !q.forfeited);
    // 🚩 陣取りも1対1なので、抜けたらその場で終わり（残った人の勝ち）。
    if ((match.mode === 'duel' || match.mode === 'attack' || match.mode === 'land')
        && match.players.length === 2 && otherHumans.length === 1) {
      endMatch(match, 'forfeit');
    } else if (otherHumans.length === 0) {
      endMatch(match, 'abandoned');
    } else if (match.players.every(q => q.finished)) {
      endMatch(match, 'finished');
    }
  }

  // 猶予中の試合へ戻る。hello から呼ぶ。
  //
  // ⚠ 許可の条件は「userId の完全一致」ひとつだけ。hello の名乗り直し禁止
  //   （ws.matchId があるソケットは hello を無視する）は緩めていない ──
  //   復帰するのは**新しいソケット**で、そちらは matchId を持たないので
  //   あの門とは無関係。ゲスト・別アカウントでは dcHolds に鍵が無いので
  //   ここまで来ても何も起きない。
  //
  // ⚠ 呼ぶのは hello に `resume:true` と `role:'battle'` の両方が付いていた
  //   ときだけ（呼び出し側で判定）。理由は2つとも実害がある:
  //   ・role を見ないと、同じ人の**チャット用ソケット**が先に再接続した
  //     ときに席を奪ってしまう（盤面の更新がチャット側へ流れ、対戦画面は
  //     何も届かないまま固まる）。回線が切れると2本とも落ちて2本とも
  //     戻ってくるので、これは珍しい事故ではない。
  //   ・resume を見ないと、いったんメニューへ戻ってから新しく対戦を始めた
  //     人が、開いた瞬間に前の試合へ引き戻される（本人は待ち合わせ画面の
  //     つもりなので、何も起きないまま固まったように見える）。
  function resumeMatch(ws, userId) {
    const hold = dcHolds.get(userId);
    // 猶予の札が無いときの保険。電波が消えた端末は FIN を送らないので、
    // 心拍が死んだ socket を掃除する（30秒×2＝最大60秒）まで close が
    // 届かず、その間 dcHolds には何も入らない。本人が先に戻ってくるほうが
    // 普通なので、生きている席を userId で直接引き当てて拾う。
    // ⚠ こちらは猶予の札を通っていないので、ここで回数を1つ使う
    //   （使わないと「FIN を出さずに切る」が回数制限のすり抜けになる）。
    if (!hold) return adoptLiveSeat(ws, userId);
    const match = matches.get(hold.matchId);
    const p = match && !match.ended ? match.players[hold.slot] : null;
    // 席がすり替わっていないか（試合開始時に固定した userId で照合する）。
    if (!match || !p || p.userId !== userId || p.finished || p.forfeited) {
      clearTimeout(hold.timer);
      dcHolds.delete(userId);
      if (p) p.dc = null;
      return false;
    }
    if (Date.now() > hold.until) {
      // 期限切れ。タイマーが先に走っているはずだが、念のため同じ結末にする。
      clearHold(p);
      forfeitPlayer(match, p);
      return false;
    }
    clearHold(p);
    return seatSocket(match, p, ws);
  }

  // 🔌 ロイヤルの席を返す。対戦の resumeMatch と同じ入口から呼ぶ。
  //    盤面はクライアント側で走り続けているので、返すのは「席」だけでよい
  //    ── 700ms ごとの state がまた流れ始めれば、順位も危険メーターも戻る。
  function resumeRoyale(ws, userId) {
    for (const r of royales.values()) {
      if (r.ended) continue;
      const e = r.entrants.find(x => x.human && x.alive
        && x.ws && x.ws.user && x.ws.user.id === userId);
      if (!e) continue;
      e.ws = ws;
      e.dcUntil = null;
      e.lastSeen = Date.now();
      ws.royaleId = r.id;
      // クライアントは「繋ぎ直しが成功したか」を見て、失敗なら諦める作りなので、
      // 席が返ったことを必ず1本返す（返さないと RESUME_WAIT_MS で切られる）。
      send(ws, {
        type: 'royale_resumed',
        secs: Math.max(0, Math.round(ROYALE_DURATION + COUNTDOWN - (Date.now() - r.startedAt) / 1000)),
        alive: royaleAlive(r).length,
      });
      // 🔌 猶予中に預かったお邪魔をまとめて降らせる（royaleHit の注記）。
      //    席は差し替えただけでクライアント側の engine は生きているので、
      //    royale_garbage をそのまま流せば普通に積まれる。
      const held = Array.isArray(e.pending) ? e.pending : [];
      e.pending = [];
      for (const g of held) send(ws, { type: 'royale_garbage', ...g });
      return true;
    }
    return false;
  }

  // close がまだ届いていない席を、同じ userId の新しいソケットで引き継ぐ。
  function adoptLiveSeat(ws, userId) {
    for (const match of matches.values()) {
      if (match.ended) continue;
      const p = match.players.find(q => q.userId === userId);
      if (!p || p.sock === ws || p.finished || p.forfeited) continue;
      const user = db.users[userId];
      if (!user || !takeGraceQuota(user)) return false;   // 常習者はここも通さない
      const stale = p.sock;
      const ok = seatSocket(match, p, ws);
      // 取り残された古いソケットは畳む。放っておくと同時接続の上限
      // （MAX_SOCKETS_PER_USER）を食い続け、心拍が来るまで消えない。
      try { stale.close(); } catch { /* もう閉じている */ }
      return ok;
    }
    return false;
  }

  // 席の socket を差し替えて、両者に知らせる。
  function seatSocket(match, p, ws) {
    // 以後 broadcastState も result も新しい方へ届く。
    p.sock = ws;
    ws.matchId = match.id;
    // 復帰した本人へ「いまどうなっているか」。クライアントは自分の盤面を
    // ローカルで回し続けているので、必要なのは残り時間と席の情報だけ。
    send(ws, {
      type: 'match_resumed',
      matchId: match.id, mode: match.mode, seed: match.seed,
      duration: match.duration,
      // 時計は止めていないので、経過ぶんを渡して続きから合わせてもらう。
      elapsedMs: Math.max(0, Date.now() - match.startedAt),
      countdown: COUNTDOWN,
      boss: match.boss || null,
      you: { slot: p.slot, team: p.team },
      players: match.players.map(q => ({
        slot: q.slot, team: q.team, name: sockName(q.sock),
        level: sockLevel(q.sock), rating: sockRating(q.sock),
        // 🎨 再接続でも同じ欄を返す。ここを抜くと、再接続した人にだけ
        //    全員が既定スキンで描かれる（本人にしか分からない食い違い）。
        skin: sockSkin(q.sock),
        score: q.score, isYou: q === p,
      })),
    });
    for (const q of match.players) {
      if (q === p || q.sock.isBot) continue;
      // opp_unstable と同じ理由で、つなぎの announce は外した
      // （modes.js の onOppBack() が受ける）。
      send(q.sock, { type: 'opp_back', slot: p.slot });
    }
    return true;
  }

  // ---- 🕒 在席区間 ---------------------------------------------------------
  //
  // 同時接続数が 0 → 1 になった瞬間に開き、1 → 0 になった瞬間に閉じる。
  // ⚠ 1本閉じるたびに区間を切ってはいけない。1人が最大6本つなぐ設計で
  //   （チャット用＋対戦用、PC＋スマホ）、対戦画面は入退室のたびに2本目を
  //   開け閉めするので、socket 単位で数えると「3時間の在席」が
  //   「数分の区間20本」に砕けて、ログとして読めなくなる。
  function noteOnlineArrival(userId) {
    if (!userId || onlineSince.has(userId)) return;
    onlineSince.set(userId, Date.now());
    const u = db.users[userId];
    if (!u) return;
    const st = statsOf(u);
    st.sessions = Math.max(0, Math.floor(Number(st.sessions) || 0)) + 1;
    saveDb();
  }

  function closeOnlineSpan(userId) {
    const at = onlineSince.get(userId);
    if (!at) return;
    onlineSince.delete(userId);
    const ms = Date.now() - at;
    // 短すぎる区間は積まない（リロードのたびに輪バッファが埋まる）。
    if (ms < ONLINE_SPAN_MIN_MS) return;
    const u = db.users[userId];
    if (!u) return;
    const st = statsOf(u);
    if (!Array.isArray(st.online)) st.online = [];
    st.online.push({ at, ms });
    // ⚠ 上限は必ず要る。db.json は保存のたびに丸ごと書き出されるので、
    //   伸び続ける配列を1本入れると保存がイベントループを止める。
    // 別名（const arr = st.online）越しに切り詰めないこと ──
    // test/persist-registry.test.mjs の E-3 は「stats 配下の push に
    // 切り詰めが付いているか」を素の名前で探すので、別名にすると
    // 見えない＝検査されない配列になる。
    if (st.online.length > ONLINE_SPANS_MAX) {
      st.online.splice(0, st.online.length - ONLINE_SPANS_MAX);
    }
    saveDb();
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  wss.on('connection', (ws, req) => {
    // ws は ECONNRESET・不正フレーム・ping 失敗といった普通の事象で 'error' を
    // 出す。リスナが1本も無い EventEmitter が 'error' を出すとプロセスごと落ちる
    // ので、**何よりも先に**付ける。以前は下の上限チェックより後ろに付けていた
    // ため、「断った接続」だけがこの保護の外にいた（close() は閉じ終わるまで受信を
    // 続けるので、そこでエラーが出ると全試合を道連れに落ちうる）。
    ws.on('error', err => console.error('[ws] socket error:', err && err.code ? err.code : '', err && err.message));
    const ip = ipOf(req);
    ws._ip = ip;
    ws._since = Date.now();   // 管理画面の「実プレイヤー一覧」で滞在時間を出す
    if (clients.size >= MAX_SOCKETS) {
      noteReject('max');
      try { send(ws, { type: 'error', error: '接続数が上限に達しています。しばらくしてからお試しください' }); ws.close(); } catch { /* ignore */ }
      return;
    }
    // 同一IPの本数も「いま本当に開いている socket」で数える。以前は接続時に
    // 足して close で引くカウンタだったので、電波が切れた端末のように close が
    // 遅れて届く socket（心拍が掃除するまで最大60秒）が数に居座り、共有回線＋
    // モバイルの組み合わせだと入り直せなくなることがあった。clients は最大でも
    // MAX_SOCKETS 本なので、接続のたびに数え直しても十分軽い。
    let sameIp = 0;
    for (const c of clients) if (sockIp(c) === ip && c.readyState === c.OPEN) sameIp++;
    if (sameIp >= MAX_SOCKETS_PER_IP) {
      noteReject('perIp');
      try { send(ws, { type: 'error', error: '同時接続が多すぎます' }); ws.close(); } catch { /* ignore */ }
      return;
    }
    // 名乗らないまま居座る接続を切る。gateSocket は message 受信時にしか
    // 走らないので、無言のソケットは ban もメンテナンスもすり抜けていた。
    ws._helloTimer = setTimeout(() => {
      if (!ws.greeted && !ws.user && !ws.guestName) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }, HELLO_GRACE_MS);
    ws.on('close', () => clearTimeout(ws._helloTimer));
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      // Anything below can throw on drifted data (a user record without
      // `stats`, a crowd line with a missing slot). Unhandled, that both
      // crashed the server AND left the surviving players holding a matchId
      // for a match that endMatch had already deleted — after which joinQueue
      // silently refused them for the rest of the connection.
      try {
        handleMessage(ws, msg);
      } catch (err) {
        console.error('[ws] handler failed for', msg.type, '-', err && err.message);
        try { send(ws, { type: 'error', error: '通信エラーが発生しました' }); } catch { /* socket already gone */ }
      }
    });

    function handleMessage(ws, msg) {
      const match = ws.matchId ? matches.get(ws.matchId) : null;
      const me = match ? match.players.find(p => p.sock === ws) : null;

      // Ban / mute / maintenance used to be checked only inside 'hello'. A
      // client that simply never sends 'hello' skipped all three and could
      // queue, chat and play. Re-check them on every message instead.
      if (msg.type !== 'hello' && !gateSocket(ws)) return;

      switch (msg.type) {
        case 'hello': {
          // 対戦中の名乗り直しは敗北・Elo回避の抜け道だった。userId は試合開始時に
          // 固定してあるので endMatch はもう欺けないが、身分の書き換えそのものを塞ぐ。
          if (ws.matchId) return;
          const user = deps.userFromToken(msg.token);
          if (user && user.banned) { send(ws, { type: 'error', error: 'アカウントが凍結されています' }); ws.close(); return; }
          if (deps.isMaintenance && deps.isMaintenance() && (!user || user.role !== 'admin')) {
            send(ws, { type: 'error', error: 'メンテナンス中です。しばらくお待ちください' });
            ws.close();
            return;
          }
          // 対戦画面に入った人は chat.js の常時接続と合わせて2本つないでいる。
          // 2本目を数えると「オンライン○人」が実人数の倍近くまで膨らむ。
          // 同じアカウントで何十本も繋いで対戦を並列に回されると、
          // REST 側の回数制限を迂回してコインを稼げてしまう（実測で8試合同時）。
          // 数えるのは「いま本当に開いている socket」だけ。clients を素で走査すると、
          // 電波が切れた端末の閉じ損ねた socket が心拍に掃除されるまで（30秒×2＝
          // 最大60秒）生きているものとして数に入り、張り直すたびに上限へ近づいて
          // 自分のアカウントから締め出されていた。socketsOf は生存判定のついでに
          // 死んだ socket を表から外すので、ゾンビは数えた瞬間に消える。
          if (user) {
            const mine = socketsOf(user.id).filter(w => w !== ws).length;
            if (mine >= MAX_SOCKETS_PER_USER) {
              noteReject('perUser');
              send(ws, { type: 'error', error: '同じアカウントの接続が多すぎます' });
              ws.close();
              return;
            }
          }
          // 名乗り直しに備えて、先に前の身分の表から外す。
          // ws.user を書き換えたあとに外すと、外れるのは「新しい方」なので
          // 古い方が表に残り、在席が嘘になって通知も古い宛先へ流れる。
          untrackSocket(ws);
          ws.secondary = msg.role === 'battle';
          ws.user = user ? { id: user.id, username: user.username } : null;
          // 登録済みの名前をゲストが名乗れてしまうと、チャットで管理者や
          // 他人になりすませる（🛡️ の表示は role で出るので付かないが、
          // 名前だけ見ている相手には区別がつかない）。使われている名前は避ける。
          // 予約名（運営/管理者ゼロ 等）とアリーナ住人の名前も同様に弾く ——
          // これらは登録できないので db.users には載らず、衝突チェックだけでは
          // 常にすり抜けた。断罪イベント中に偽の「運営」告知を流せる穴だった。
          if (!user) {
            // 🚫 凍結された回線からは、ゲストとしても入れない。
            //    ここが開いていると、凍結された人はトークンを捨てるだけで
            //    そのまま全体チャットへ戻ってこられる（凍結・ミュートの判定は
            //    db.users を引くので、レコードを名乗らなければ走らない）。
            //    ログイン済み（この分岐の外）は素通し ── 同じ回線の家族や
            //    同居人まで巻き添えにしない。
            if (isIpBanned(sockIp(ws))) {
              send(ws, { type: 'error', error: 'この回線からは現在ご利用いただけません' });
              try { ws.close(); } catch { /* すでに閉じている */ }
              return;
            }
            // 🪪 登録と**まったく同じ**正規化と文字種検査を通す。
            //   以前は sanitizeName（切って記号を落とすだけ）だったので、
            //   ・「運営」＋ゼロ幅スペース … 予約名の検査に当たらないのに見た目は同じ
            //   ・全角の「ａｄｍｉｎ」    … 同上
            //   ・キリル文字の "аdmin"    … 登録では通らない文字なのに名乗れた
            //   ・空白1文字／絵文字だけ    … 名前の無い相手、表示崩し
            //   が全部通っていた。登録できない見た目をゲストなら名乗れる、という
            //   非対称そのものが穴なので、門を1本に揃える。
            const want = claimName(msg.guestName) || '';
            const ip = sockIp(ws);
            // 同じ名前での名乗り直し（＝再接続）は数えない。名前を変えたときだけ
            // 枠を消費する。使い切ったら **照会そのものをやめて** 無条件に
            // ゲスト名を振る ── 断り方を変えるだけだと、断られたこと自体が
            // 「その名前は存在する」という答えになる。
            const sameAsBefore = want && lastGuestNameByIp.get(ip) === want;
            const mayCheck = !want || sameAsBefore || userRate(`gname:${ip}`, 12, 10 * 60 * 1000);
            const bad = want && !isClaimableName(want);
            const taken = want && mayCheck && (
              Object.values(db.users).some(u => u.username.toLowerCase() === want.toLowerCase())
              || reservedName(want)
              || !!residentByName(want)
            );
            // 🎭 番号帯を住人側とそろえる（1000〜9999 の4桁）。
      //    実在のプレイヤーには 0〜9998 を振っていたのに、住人・埋め草の
      //    ゲスト風の名前は pickPersona が必ず 1000〜9999 の4桁を作る。
      //    つまり「ゲスト7」「ゲスト538」のように**3桁以下なら必ず生身の人間**で、
      //    住人には構造上そう名乗れなかった。対戦カード・ブラケット・ロイヤルの
      //    一覧・部屋の参加者一覧など、ゲスト風の名前が並ぶどの画面でも同じ判定が
      //    できてしまう（1対1では相手が実在のプレイヤーかどうかが名前だけで確定）。
      ws.guestName = (want && mayCheck && !bad && !taken) ? want : `ゲスト${1000 + Math.floor(Math.random() * 9000)}`;
            if (want && mayCheck && !bad && !taken) {
              // 覚えておくのは「その回線が直前に名乗った名前」1つだけ。
              // 上限を置かないと、接続元の数だけ際限なく増える入れ物になる
              // （落としても困らない ── 忘れた回線は次の1回だけ枠を消費する）。
              if (lastGuestNameByIp.size > 2000) lastGuestNameByIp.clear();
              lastGuestNameByIp.set(ip, want);
            }
            // 断る理由は出し分けない（「使われている」と「形が悪い」を分けると、
            // 名前を投げ分けるだけで登録者と住人を炙り出す列挙オラクルになる ──
            // /api/register が同じ理由で1文言に統一してある）。
            // 枠を使い切ったときだけは別の文面にする。こちらは名前について何も
            // 言っていない（＝答えになっていない）ので、出しても漏れない。
            if (want && !mayCheck) {
              send(ws, { type: 'error', error: '名前の変更が多すぎます。しばらくしてからお試しください' });
            } else if (want && (bad || taken)) {
              send(ws, { type: 'error', error: 'その名前は使えません。別の名前になりました' });
            }
          } else {
            ws.guestName = null;
          }
          trackSocket(ws);
          // 🔏 ログイン済みの接続元を控える（凍結時に「どの回線か」を知るため）。
          //    保存済みトークンでの再訪は /api/login を通らないので、ここでも拾う。
          if (user) noteUserIp(user.id, sockIp(ws));
          if (user) {
            // 5分に1回だけ書く。毎回書くと接続のたびにディスクを叩く。
            const live = db.users[user.id];
            if (live && Date.now() - (live.lastSeen || 0) > 300_000) { live.lastSeen = Date.now(); saveDb(); }
            // 🕒 いま何本つないでいるか（trackSocket 済みなので自分も入る）。
            // 0→1 になった今回だけが「来た」＝区間の始まり。
            if (socketsOf(user.id).length === 1) noteOnlineArrival(user.id);
          }
          send(ws, {
            type: 'hello_ok',
            name: user ? user.username : ws.guestName,
            online: displayOnline(),
            queueing: ambientQueue() + queueSizeAll(),
            mood: crowdMood().id,
            chat: chatHistory.slice(-40),
            feed: feedHistory.slice(-20),
          });
          // Only a fresh arrival gets greeted, not a reconnecting chat socket
          // — nor the 2本目 that opens when the same person enters online play.
          if (!ws.greeted && !ws.secondary) { ws.greeted = true; maybeGreet(ws); }
          // 再接続でもパーティーは続いている（所属は socket ではなく人に付く）。
          if (ws.user) party.socketArrived(ws.user.id);
          // 🔌 猶予中の試合があれば、そこへ戻す（許可は userId の完全一致だけ）。
          // hello_ok のあとに送るのは、クライアントが hello_ok で
          // connect() を解決してから受け口を張るため。
          // resume / role の2条件が要る理由は resumeMatch のコメント。
          if (user && msg.resume === true && ws.secondary) {
            // 対戦とロイヤルの両方を見る（片方しか見ていなかったので、
            // ロイヤルは再接続の仕組みに一度も乗っていなかった）。
            if (!resumeMatch(ws, user.id)) resumeRoyale(ws, user.id);
          }
          break;
        }
        case 'queue': {
          const mode = ['team', 'raid', 'tourney', 'royale', 'coop', 'attack'].includes(msg.mode) ? msg.mode : 'duel';
          joinQueue(ws, mode);
          break;
        }
        case 'cancel_queue': {
          leaveQueues(ws);
          send(ws, { type: 'queue_cancelled' });
          break;
        }
        case 'state': {
          // 唯一レート制限が付いていなかった高頻度メッセージ。
          // 正規のクライアントは 700〜900ms 間隔なので、余裕を持って毎秒4回。
          if (!sockRate(ws, 'stateTimes', 40, 10_000)) return;
          // Battle royale: no match object — just track the live score.
          if (ws.royaleId) {
            const r = royales.get(ws.royaleId);
            if (r && !r.ended) {
              const e = r.entrants.find(x => x.ws === ws);
              if (e && e.alive) royaleMergeState(r, e, msg);
            }
            return;
          }
          if (!match || match.ended || !me) return;
          // Co-op runs on a SERVER-OWNED board and a server-owned score (that
          // is the whole promise of the mode: "絶対にズレない"). Accepting a
          // client 'state' there let one player dictate the shared score and
          // write it into the other player's coopBest.
          if (match.mode === 'coop') return;
          // 🚩 陣取りも同じくサーバー権威の1盤面。点は landApply が付ける。
          if (match.mode === 'land') return;
          // A finished player's score is already locked in for Elo — a late
          // frame must not move it.
          if (me.finished) return;
          // Same anti-forge cap as finishPlayer: bound the running score by the
          // time the match has actually run, so a single forged frame can't
          // dictate the winner. Monotonic — scores only ever climb.
          me.score = Math.max(me.score, Math.min(matchScoreCap(match), Math.min(1_000_000, Math.floor(Number(msg.score) || 0))));
          // ライン数にも同じ時間比例の頭打ちを入れる。ここが素通しだったせいで、
          // 下の 'attack' の「申告済み累計ラインを超えた攻撃は捏造」という
          // ガードが、同じクライアントの自己申告と比べているだけの循環になり
          // 実効を失っていた（lines:999999 を1回送れば撃ち放題だった）。
          me.lines = Math.max(me.lines, Math.min(Math.floor(Number(msg.lines) || 0), linesCap(match.startedAt)));
          me.maxCombo = Math.max(me.maxCombo, Math.floor(Number(msg.combo) || 0));
          // Online modes reported 0 pieces placed, which froze three missions
          // and the matching achievements for anyone who mostly plays online.
          me.pieces = Math.max(me.pieces || 0, Math.min(20000, Math.floor(Number(msg.pieces) || 0)));
          broadcastState(match, me.slot, {
            score: me.score,
            combo: Math.floor(Number(msg.combo) || 0),
            lines: me.lines,
            grid: sanitizeGrid(msg.grid),
          });
          break;
        }
        // 💯 Royale: the client reports its own top-out, and the SERVER decides
        // what it costs — the same revive-then-eliminate rule the bots follow.
        // Without this humans were immortal while bots died, which made
        // burying someone pointless.
        // 👁️ 断罪 — 参加
        case 'zero_join': {
          if (ws.zeroId || ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId || ws.zeroId) return;
          const zu = zeroUserOf(ws);
          if (!zu) { send(ws, { type: 'error', error: 'ログインが必要です' }); return; }
          const zrun = zeroRun(zu);
          if (!zrun) { send(ws, { type: 'error', error: 'いまはあなたの枠の時間ではありません' }); return; }
          if (!sockRate(ws, 'zeroJoinTimes', 5, 30_000)) return;
          zeroSeatOut(ws);                 // 念のため。前の部屋を残さない
          startZeroSession([ws], zrun);    // 枠ごとに1部屋（生きた部屋があれば合流）
          return;
        }
        // 👁️ 断罪 — 盤面同期。
        //
        // バトルロイヤルの 'state'（上の case）とまったく同じ作法で、人間の盤面と
        // スコアをサーバーが持つ。これが無かったせいで
        //   * 「斬った」申告に裏づけが取れない（点灯セルを返すだけで必ず成功した）
        //   * 赤マスを空きマスから選べない
        //   * 人間の点が段のHPに一切入らない（sim-zero.mjs の前提と食い違う）
        // の3つが同時に起きていた。
        // クライアントは1手ごと＋700〜900ms間隔で送る想定。上限はロイヤルと同じ
        // 10秒で40回（正規の使い方なら十分に余裕がある）。
        case 'zero_state': {
          if (!sockRate(ws, 'zeroStateTimes', 40, 10_000)) return;
          const sess = zeroSessionOf(ws);
          const run = db.meta.adminEventRun;
          if (!sess || !run) return;
          zeroSyncBoard(sess, run, sockName(ws), {
            grid: sanitizeGrid(msg.grid),
            score: Math.min(1_000_000, Math.floor(Number(msg.score) || 0)),
          }, zeroDeps(sess));
          return;
        }
        // 断罪を斬った申告
        case 'zero_cut': {
          const sess = zeroSessionOf(ws);
          const run = db.meta.adminEventRun;
          if (!sess || !run) return;
          if (!sockRate(ws, 'zeroCutTimes', 20, 10_000)) return;
          const cells = Array.isArray(msg.cells) ? msg.cells.slice(0, 64).map(n => n | 0) : [];
          zeroCut(sess, run, sockName(ws), String(msg.id || ''), cells, zeroDeps(sess));
          saveDb();
          return;
        }
        // 🪧 今夜の的の列を縦に消した
        case 'zero_stake': {
          const sess = zeroSessionOf(ws);
          const run = db.meta.adminEventRun;
          if (!sess || !run) return;
          if (!sockRate(ws, 'zeroStakeTimes', 20, 10_000)) return;
          const cols = Array.isArray(msg.cols) ? msg.cols.slice(0, 8).map(n => n | 0) : [];
          zeroStake(sess, run, sockName(ws), cols, zeroDeps(sess));
          return;
        }
        // 🤝 取引への投票
        case 'zero_vote': {
          const sess = zeroSessionOf(ws);
          const run = db.meta.adminEventRun;
          if (!sess || !run || !ws.user) return;
          if (!sockRate(ws, 'zeroVoteTimes', 5, 10_000)) return;
          const r = zeroDealVote(run, ws.user.id, String(msg.pick || ''));
          if (r.ok) {
            saveDb();
            for (const e of sess.entrants) if (e.human && e.ws && e.ws.readyState === e.ws.OPEN) {
              // human: true は付けない。住人の票（zero-session.js の同名フレーム）
              // にだけ無い印になるので、これが「誰が人間か」の一覧表になっていた。
              send(e.ws, { type: 'zero_deal_vote', by: sockName(ws), pick: msg.pick, tally: r.tally });
            }
          } else {
            send(ws, { type: 'error', error: r.why === 'already' ? 'もう投票しました' : '投票を受け付けられません' });
          }
          return;
        }
        // 📝 伝言 ── 段にとどめを刺した人だけが、次の枠へ40字残せる
        case 'zero_will': {
          const run = db.meta.adminEventRun;
          if (!run || !zeroSessionOf(ws)) return;
          if (!sockRate(ws, 'zeroWillTimes', 3, 60_000)) return;
          // ミュートは伝言にも効く（モデレーションの抜け穴防止）。伝言は run に
          // 残って次の枠の開幕で全員に読まれる公開テキストなので、チャットを
          // 止められている人がここから書けてしまうと規制の意味が無くなる。
          if (isMuted(ws)) {
            send(ws, { type: 'error', error: '管理者によりチャットが制限されています' });
            return;
          }
          const r = zeroWill(run, sockName(ws), String(msg.text || ''));
          if (r.ok) {
            saveDb();
            send(ws, { type: 'zero_will_ok' });
            // 伝言はその場の全員にも見せる（次の枠の人は開幕で読む）
            broadcastAll({
              type: 'announce',
              message: `${sockName(ws)} が次の枠へ伝言を残した`,
              messageEn: `${sockName(ws)} left a message for the next slot`,
              from: '管理者ゼロ',
            });
          } else {
            send(ws, { type: 'error', error: r.why === 'not-earned'
              ? '伝言は、段にとどめを刺した人だけが残せます' : '伝言を入力してください' });
          }
          return;
        }
        case 'zero_topout': {
          // ここだけレート制限が無く、連打でゼロを回復させ放題だった。
          if (!sockRate(ws, 'zeroTopTimes', 6, 60_000)) return;
          const sess = zeroSessionOf(ws);
          const run = db.meta.adminEventRun;
          if (!sess || !run) return;
          // クールダウンはユーザー単位で run に持つ（席単位だと leave→join の
          // 新セッションで即 alive:true になり60秒上限を回避できた）。
          zeroTopOut(sess, run, sockName(ws), zeroDeps(sess), ws.user ? ws.user.id : null);
          return;
        }
        // 🏁 走行が終わった。席は残したまま的から降ろす ── このあと伝言
        //    (zero_will) を送ってから zero_leave が来る。詳しくは
        //    zero-session.js の finishHuman を参照。
        case 'zero_done': {
          const sess = zeroSessionOf(ws);
          if (!sess) return;
          zeroFinishHuman(sess, ws);
          return;
        }
        case 'zero_leave': {
          zeroSeatOut(ws);
          return;
        }
        case 'royale_topout': {
          if (!ws.royaleId) return;
          const r = royales.get(ws.royaleId);
          if (!r || r.ended) return;
          const e = r.entrants.find(x => x.ws === ws);
          // 🎭 人間が潰れた回にも帰属を付ける（上の royaleHit のコメント）。
          //    直前のお邪魔から一定時間内のときだけ「そのせいで潰れた」と見なす
          //    ので、自分で詰ませた回は今までどおり「脱落」のまま。
          if (e && e.alive) {
            // 💯 詰ませた最後の1手ぶんを、罰（-10%）や順位確定より**先に**取り込む
            //    （royaleMergeState のコメント）。上限は state と同じものを通す。
            royaleMergeState(r, e, msg);
            const blame = (e.lastHitBy && e.lastHitBy.alive
              && Date.now() - (e.lastHitAt || 0) <= ROYALE_BLAME_MS) ? e.lastHitBy : null;
            royaleTopOut(r, e, blame);
          }
          return;
        }
        // A 2+ line clear buries somebody. Line count is bounded the same way
        // the attack duel bounds it, so a forged frame cannot nuke the lobby.
        case 'royale_attack': {
          if (!ws.royaleId) return;
          const r = royales.get(ws.royaleId);
          if (!r || r.ended) return;
          const e = r.entrants.find(x => x.ws === ws);
          if (!e || !e.alive) return;
          // カウントダウン中は誰もピースを置けない＝攻撃も出ないはず。
          // 1v1 の 'attack' には同じ判定があるのに、ここだけ抜けていた。
          if (Date.now() - r.startedAt < COUNTDOWN * 1000) return;
          if (!sockRate(ws, 'royaleAtkTimes', 12, 5000)) return;
          const lines = Math.max(0, Math.min(4, Math.floor(Number(msg.lines) || 0)));
          const combo = Math.max(0, Math.min(30, Math.floor(Number(msg.combo) || 0)));
          if (lines < 2) return;
          // 1v1 の 'attack' と同じ突き合わせ。ここには何も無かったので、
          // ピースを1つも置かずに { lines:4, combo:30 }（＝常に上限の9セル）を
          // 5秒に12回送り続けるだけで、生存者を最大威力で埋め続けられた。
          // 突き合わせ先の e.lines は 'state' 側で時間比例に頭打ちしてあるので、
          // これは自己申告との循環ではなく実効のあるバジェットになる。
          // 正規クライアントは onRoyalePlace で pushState → royale_attack の
          // 順に送るので、ライン数は常に先着している。
          e.atkLinesUsed = e.atkLinesUsed || 0;
          if (e.atkLinesUsed + lines > e.lines) return;
          const rCells = attackCells(lines, combo);
          if (!rCells) return;
          // 1v1 と同じ威力バジェット。ロイヤルのレート制限は 12発/5秒＝2.4発/秒 と
          // さらに緩く、lines:2（消費2・威力5セル）を選べば消費 4.8ライン/秒 で
          // 上限5に届かないまま毎秒12セルを撃てた。ライン申告だけでは塞がらない。
          e.atkCells = e.atkCells || 0;
          if (e.atkCells + rCells > atkCellsCap(r.startedAt)) return;
          e.atkLinesUsed += lines;
          e.atkCells += rCells;
          royaleAttack(r, e, rCells, lines);
          return;
        }
        case 'attack': {
          // ⚔️ アタック戦: 2ライン以上の消去が相手へのお邪魔ブロックになる。
          if (!match || !me || match.mode !== 'attack' || match.ended) return;
          if (me.finished || Date.now() - match.startedAt < COUNTDOWN * 1000) return;
          if (!sockRate(ws, 'atkTimes', 12, 10000)) return;
          const aLines = Math.max(0, Math.min(8, Math.floor(Number(msg.lines) || 0)));
          const aCombo = Math.max(0, Math.min(60, Math.floor(Number(msg.combo) || 0)));
          // 主張ライン数は state で申告済みの累計ライン数を超えられない（捏造攻撃対策。
          // クライアントは pushState → attack の順で送るので lines は常に先着している）
          me.atkLinesUsed = me.atkLinesUsed || 0;
          if (me.atkLinesUsed + aLines > me.lines) return;
          const cells = attackCells(aLines, aCombo);
          if (!cells) return;
          // 威力そのもののバジェット（atkCellsCap の長いコメント参照）。
          // ライン申告の突き合わせは lines:4 経路だと消費 4.8ライン/秒 <上限5 で
          // 一度も効かないため、ここが実効のある唯一の歯止めになる。
          me.atkCells = me.atkCells || 0;
          if (me.atkCells + cells > atkCellsCap(match.startedAt)) return;
          // 消費は「実際に撃てると決まってから」まとめて引く。以前は
          // atkLinesUsed だけ先に引いていたので、威力0（lines<2）で弾かれた
          // 分まで正直なプレイヤーのライン残高が減っていた。
          me.atkLinesUsed += aLines;
          me.atkCells += cells;
          for (const p of match.players) {
            if (p.slot === me.slot || p.team === me.team) continue;
            deliverAttack(match, me.slot, p, cells, aLines);
          }
          break;
        }
        case 'rematch': {
          if (!sockRate(ws, 'rmTimes', 6, 10000)) return;
          const offer = rematchOffers.get(String(msg.rematchId || ''));
          if (!offer || offer.until < Date.now()) { send(ws, { type: 'rematch_gone' }); return; }
          // joinQueue と同じガード — ルーム/トーナメント/ロイヤル在籍中の再戦受諾は
          // rooms Map にゴースト部屋を残す（createMatch が roomCode を黙って消すため）
          //
          // ⚠ ここを**無言 return** にしていたのが致命的だった。観戦者の居る
          //    合言葉ルームでは endMatch が結果フレームより先に p.roomCode を
          //    戻すので、ルームの試合の「再戦」は必ずこの行で落ちる。
          //    rematch_offer も rematch_gone も返らないため、ボタンは
          //    「相手を待っています…」のまま**永久に**固まり、30秒の
          //    sweepRematches も通らなかった。断るなら必ずそう言うこと。
          if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId || ws.zeroId) {
            send(ws, { type: 'rematch_gone' });
            return;
          }
          const mine = offer.sides.find(sd => sd.sock === ws);
          if (!mine) return;
          mine.ready = true;
          const other = offer.sides.find(sd => sd !== mine);
          if (other.isBot) {
            rematchOffers.delete(String(msg.rematchId));
            // 🎭 **同じ席に座り直してもらう**。控えてある Bot をそのまま使う
            //    （startPlay が毎回 Engine とタイマーを作り直すので使い回せる）。
            //    控えが失われているときだけ、従来どおり同じ強さで作り直す。
            const seat = other.bot || new Bot(other.level || 'random', new Set([sockName(ws)]));
            // ⏱ 人間相手の再戦は「相手が承諾するまで」待つ（押した側の画面は
            //    『相手を待っています…』）。ボットだけ押した瞬間に成立していたので、
            //    **待ち時間の有無**でも正体が分かった（実測46〜48ms）。人が承諾する
            //    のと同じくらいの間を置く。
            const waitMs = 900 + crypto.randomInt(1300);
            setTimeout(() => {
              // 待っているあいだにメニューへ戻った／別の試合に入った／切れた。
              if (!ws || ws.readyState !== ws.OPEN) return;
              if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId || ws.zeroId) return;
              createMatch({ mode: offer.mode, rated: offer.rated, duration: offer.duration, entries: [
                { sock: ws, team: 0 },
                { sock: seat, team: 1 },
              ] });
            }, waitMs);
            return;
          }
          // matchId だけを見ていたので、相手が待っている間にルーム/大会/
          // ロイヤルへ入っていると、そこから引きはがして再戦を始めてしまった。
          // 参加を弾く条件（1949行目）と同じ「取り込み中」判定を使う。
          const busy = other.sock && (other.sock.matchId || other.sock.roomCode || other.sock.tourneyId || other.sock.royaleId);
          if (!other.sock || other.sock.readyState !== other.sock.OPEN || busy) {
            rematchOffers.delete(String(msg.rematchId));
            send(ws, { type: 'rematch_gone' });
            return;
          }
          if (other.ready) {
            rematchOffers.delete(String(msg.rematchId));
            createMatch({ mode: offer.mode, rated: offer.rated, duration: offer.duration, entries: [
              { sock: mine.sock, team: 0 }, { sock: other.sock, team: 1 },
            ] });
          } else {
            send(other.sock, { type: 'rematch_offer', from: mine.name });
          }
          break;
        }
        case 'rematch_decline': {
          dropRematchesFor(ws);
          break;
        }
        case 'finish': {
          if (!match || match.ended || !me) return;
          if (match.mode === 'coop') return;   // co-op ends when the shared board tops out
          // 🚩 陣取りは時間切れ（または盤面の詰み）でサーバーが終わらせる。
          // クライアント申告の finish を通すと、点も領土もサーバーが持っている
          // のに終了だけ相手より先に宣言できてしまう。
          if (match.mode === 'land') return;
          finishPlayer(match, me.slot, msg.score, msg.lines, msg.combo);
          break;
        }
        // 🚪 自分の意思で降りた（クライアントの ✕ →「終了する」）。
        //    これが無かったころは離脱がソケットの close だけで伝わっていて、
        //    サーバーからは回線事故と区別が付かなかった。実害は2つ:
        //      (1) 相手が最大25秒（RECONNECT_GRACE_MS）、動かない盤面を相手に
        //          戦い続ける。離脱した本人の画面は即「敗北扱い」でメニューへ
        //          戻っているのに、である（猶予を入れる前は即決着だった＝退行）。
        //      (2) 1日3回の猶予枠(RECONNECT_GRACE_PER_DAY)を自分の離脱で使い切る。
        //          takeGraceQuota の趣旨は「切断を戦術に使う人に猶予を出さない」で
        //          あって、「自分で画面を閉じた回数」を数えることではない。
        //    ここで受けた席は猶予を通さず、その場で棄権として裁く（従来どおりの
        //    敗北・相手の不戦勝）。このフレームを送らない古いクライアントは
        //    今までどおり close ハンドラの猶予に落ちるので、後方互換も保てる。
        case 'forfeit': {
          if (!match || match.ended || !me || me.finished) return;
          // 協力プレイは切断しても負けにならない（サーバーが代打する）ので、
          // close ハンドラと同じくここでも棄権にしない。
          if (match.mode === 'coop') return;
          forfeitPlayer(match, me);
          break;
        }
        // 🚩 陣取りデュエル: 共有盤面へ1手。作法は coop_place と同じ。
        case 'land_place': {
          if (!match || match.ended || !me || match.mode !== 'land') return;
          if (!sockRate(ws, '_landRate', 40, 10000)) return;
          const ok = landApply(match, me.slot, Number(msg.index), Number(msg.row), Number(msg.col));
          // 弾いたとき（手番違い／盤面がズレている）は権威の状態を送り直す。
          if (!ok) send(ws, {
            type: 'land_reject', turn: match.turn,
            grid: match.engine.snapshot(),
            owner: match.owner ? match.owner.slice() : null,
            scores: match.players.map(q => q.score),
            hand: match.engine.hand.map(q => (q ? q.shape : null)),
          });
          break;
        }
        case 'coop_place': {
          if (!match || match.ended || !me || match.mode !== 'coop') return;
          if (!sockRate(ws, '_coopRate', 40, 10000)) return;
          const ok = coopApply(match, me.slot, Number(msg.index), Number(msg.row), Number(msg.col));
          // Rejected (not your turn / stale board): resend authoritative state.
          if (!ok) send(ws, { type: 'coop_reject', turn: match.turn, grid: match.engine.snapshot(), score: match.engine.score, hand: match.engine.hand.map(p => (p ? p.shape : null)) });
          break;
        }
        case 'create_room': {
          // matchId しか見ていなかった。大会のラウンド間（matchId は null に
          // 戻るが tourneyId は残る 7秒間）やロイヤル在籍中でも部屋を作れて、
          // そのあと次ラウンドの createMatch が走ると席に居たまま部屋から
          // 引きはがされ、誰も居ないのに消えないゴースト部屋が残っていた。
          // rematch には同じガードが後付けしてある（同じ障害）。
          // roomCode は入れない — 部屋を作り直す／別の部屋へ移るのは正規の
          // 導線で、直下の leaveRoom がその面倒を見ている。
          if (ws.matchId || ws.tourneyId || ws.royaleId || ws.zeroId) return;
          leaveQueues(ws);
          leaveRoom(ws);
          const code = makeCode();
          // watch … いま観戦席にいる socket / benched … ホストが自分で観戦席へ
          // 回した socket（対戦席が空いても勝手に繰り上げない印）。
          rooms.set(code, {
            code, players: [ws], settings: cleanSettings(msg.settings),
            // 👑 作った人がホスト。配列の順番とは別に覚えておく（ensureHost）。
            host: ws,
            watch: new Set(), benched: new Set(), matchId: null, specTick: null,
            // 🏴 席ごとのチーム（socket → 0|1）。ホストが決めたぶんだけ入る。
            //    入っていない席は startRoom の既定式（前半A・後半B）で決まる。
            //    watch / benched と同じ「socket を鍵にした集合」の作法。
            teams: new Map(),
            // away … いま試合に出ていて部屋を離れている socket。
            //   endRoomSpectate が試合後に部屋へ戻す（交代で遊ぶための控え）。
            away: null,
          });
          ws.roomCode = code;
          ws.watchTarget = null;
          broadcastRoom(rooms.get(code));
          break;
        }
        case 'join_room': {
          // create_room と同じ理由（大会/ロイヤル/断罪の在籍中に入ると
          // 次の createMatch でゴースト部屋になる）。roomCode は同上で除く。
          if (ws.matchId || ws.tourneyId || ws.royaleId || ws.zeroId) return;
          // party_join と同等のレート制限。合言葉（32^4）を機械的に走査して
          // 他人のカスタムルームへ乱入されるのを防ぐ（従来ここだけ制限が無かった）。
          if (!sockRate(ws, 'roomJoinTimes', 5, 10_000)) { send(ws, { type: 'room_error', error: 'すこし早すぎます。少し待ってください' }); return; }
          const code = String(msg.code || '').trim().toUpperCase();
          const room = rooms.get(code);
          if (!room) { send(ws, { type: 'room_error', error: 'ルームが見つかりません' }); return; }
          // 定員は対戦席ではなく部屋そのもの（8人）。対戦席があふれた人は
          // 下の reseat が観戦席へ回す ── 入室できない、にはしない。
          if (room.players.length >= ROOM_MAX) { send(ws, { type: 'room_error', error: `ルームが満員です（最大${ROOM_MAX}人）` }); return; }
          leaveQueues(ws);
          leaveRoom(ws);
          room.players.push(ws);
          ws.roomCode = code;
          ws.watchTarget = null;
          // 試合中の部屋に入ってきた人は、そのまま観戦席へ。
          // ⚠ benched（＝ホストが手で観戦席へ回した印）には**入れない**。
          //   試合中に繰り上がらないことは reseat 側の matchId の門が保証して
          //   いるし、benched は試合をまたいで残る（ホストの席割りを引き継ぐ）
          //   ので、ここで付けると途中参加した人だけ次の試合でも観戦席のまま
          //   になり、ホストが手で戻すまで永久に遊べない。
          if (room.matchId) room.watch.add(ws);
          else reseat(room);
          broadcastRoom(room);
          break;
        }
        case 'room_set': {
          const room = roomOf(ws);
          // 無言 return をやめる（startRoom と同じ理由）。
          if (!room) { send(ws, { type: 'room_error', error: 'ルームが見つかりません' }); return; }
          if (!isRoomHost(room, ws)) { send(ws, { type: 'room_error', error: 'ホストのみ設定を変更できます' }); return; }
          if (room.matchId) { send(ws, { type: 'room_error', error: '試合中は設定を変更できません' }); return; }
          room.settings = cleanSettings({ ...room.settings, ...msg.settings });
          // モードが変わると対戦席の数が変わる（1v1=2 ⇄ 2v2=4）ので席を組み直す。
          reseat(room);
          broadcastRoom(room);
          break;
        }
        // 👑 ホストが「誰を対戦席に出すか」を入れ替える。
        //   { type:'room_seat', idx:<席番号>, seat:'play'|'watch' }
        // ホスト以外が叩いても効かない（下の1行目で弾く）。
        // ⚠ 人を指すのは **席番号（broadcastRoom の players[].idx）**。
        //   表示名で引いていたころは、ゲスト名が重複できるせいで
        //   同名の先頭に当たり「押した行と別の人が動く」ことがあった。
        //   古いクライアントのために name も受け付ける（見つからなければ従来どおり断る）。
        case 'room_seat': {
          const room = roomOf(ws);
          if (!room) { send(ws, { type: 'room_error', error: 'ルームが見つかりません' }); return; }
          if (!isRoomHost(room, ws)) { send(ws, { type: 'room_error', error: 'ホストのみ席を変更できます' }); return; }
          if (room.matchId) { send(ws, { type: 'room_error', error: '試合中は席を変更できません' }); return; }
          const seat = msg.seat === 'watch' ? 'watch' : 'play';
          const target = roomTargetOf(room, msg);
          if (!target) { send(ws, { type: 'room_error', error: 'その人はこのルームにいません' }); return; }
          if (seat === 'watch') {
            room.watch.add(target);
            room.benched.add(target);   // 席が空いても勝手に戻さない
          } else {
            // 対戦席が埋まっているのに新しく上げようとしたら断る。
            // 黙って reseat に落とさせると「押したのに戻る」ように見えるので、
            // 理由を返す（先に誰かを観戦席へ回してもらう）。
            const alreadyPlaying = !room.watch.has(target);
            if (!alreadyPlaying && roomPlaying(room).length >= roomSeats(room)) {
              send(ws, { type: 'room_error', error: `対戦席は${roomSeats(room)}人までです（先に誰かを観戦席へ）` });
              return;
            }
            room.watch.delete(target);
            room.benched.delete(target);
          }
          reseat(room);
          broadcastRoom(room);
          break;
        }
        // 🏴 ホストが席のチーム（A/B）を決める。
        //   { type:'room_team', idx:<席番号>, team:0|1 }
        //   決めなかった席は startRoom の既定式（前半A・後半B）で埋まる。
        case 'room_team': {
          const room = roomOf(ws);
          if (!room) { send(ws, { type: 'room_error', error: 'ルームが見つかりません' }); return; }
          if (!isRoomHost(room, ws)) { send(ws, { type: 'room_error', error: 'ホストのみ席を変更できます' }); return; }
          if (room.matchId) { send(ws, { type: 'room_error', error: '試合中は席を変更できません' }); return; }
          if (room.settings.mode !== 'team') {
            send(ws, { type: 'room_error', error: 'チーム分けは2v2チームのときだけです' });
            return;
          }
          const target = roomTargetOf(room, msg);
          if (!target) { send(ws, { type: 'room_error', error: 'その人はこのルームにいません' }); return; }
          if (!room.teams) room.teams = new Map();
          // 0/1 以外（未指定に戻す）は覚えている値を消す＝既定式に戻る。
          if (msg.team === 0 || msg.team === 1) room.teams.set(target, msg.team);
          else room.teams.delete(target);
          broadcastRoom(room);
          break;
        }
        // 👀 観戦する相手を選ぶ（ロイヤル / ルームの観戦席で共通）。
        //   { type:'watch', target: string|null }   null は「おまかせ＝首位」
        // ⚠ 観戦者以外からの watch は無視する。生存者が他人の盤面を覗けると
        //   （次に何が来るか・どこが埋まっているかが分かるので）不正になる。
        case 'watch': {
          if (!sockRate(ws, 'watchTimes', 20, 10_000)) return;
          const target = msg.target == null ? null : String(msg.target).slice(0, 40);
          if (ws.royaleId) {
            const r = royales.get(ws.royaleId);
            const e = r ? r.entrants.find(x => x.ws === ws) : null;
            if (!r || r.ended || !e || e.alive) return;   // 生存者・部外者は無視
            ws.watchTarget = target;
            return;
          }
          const room = roomOf(ws);
          // 部屋が試合中なら、部屋に残っている人は**全員が観戦者**
          // （対戦席の人は startRoom で room.players から抜けている）。
          // 席(room.watch)で判定すると、席の組み直し次第で観戦者が弾かれる。
          if (room && room.matchId) {
            ws.watchTarget = target;
            // 押した手応えをすぐ返す（次の1秒待ちにしない）。
            broadcastRoom(room);
            return;
          }
          return;
        }
        case 'room_leave': {
          leaveRoom(ws);
          send(ws, { type: 'room_left' });
          break;
        }
        case 'room_start': {
          startRoom(ws);
          break;
        }
        case 'chat': {
          const text = String(msg.text || '').trim().slice(0, 200);
          if (!text) return;
          // ⚠ u はこのあと（role / 実績カウンター / 王冠 / tagOf）でも使う。
          //    ミュート判定を isMuted(ws) に寄せたときに、うっかりこの行ごと
          //    消すと chatHistory へ積む entry の中身が丸ごと壊れる。
          const u = ws.user ? db.users[ws.user.id] : null;
          if (isMuted(ws)) {
            send(ws, { type: 'error', error: '管理者によりチャットが制限されています' });
            return;
          }
          // 連投制限をアカウント（未ログインはIP）単位でも数える。sockRate は
          // カウンタを ws のプロパティに持つので、1アカウント6本・1IP12本 の
          // 接続上限ぶんだけ持ち分が増え、実効 30通/10秒（ゲストは同一IPから
          // 60通/10秒）が素通しだった。対戦画面に入るともう1本つながるので、
          // 普通に遊んでいる人でも枠が2倍になっていた。ミュートはユーザー単位で
          // 効いているのに、流量だけ抜けていたということ。
          // ソケット単位の判定も残す — deps.rateLimit が無い組み方をされたときに
          // 無制限になるより、従来どおりの下限が残るほうが安全。
          if (!sockRate(ws, 'chatTimes', 5, 10_000)
              || !userRate(`chat:${ws.user ? ws.user.id : sockIp(ws)}`, 5, 10_000)) {
            send(ws, { type: 'error', error: '連投しすぎです。少し待ってください' });
            return;
          }
          const role = u ? u.role : 'guest';
          if (u) {
            u.stats = u.stats || {};
            u.stats.chatMessages = (u.stats.chatMessages || 0) + 1;   // 実績用の生涯カウンター
          }
          // human: 本物のプレイヤーの発言。更新をまたいで残すのはこれだけ
          // （住人のセリフは無限に作れるので、保存しても水増しにしかならない）。
          const entry = { type: 'chat', id: crypto.randomUUID(), from: sockName(ws), role, text, at: Date.now(), tag: tagOf(sockName(ws), u), human: true };
          // 👑 王座ホルダーはチャットでも王冠つき — 個数で名前の色も変わる
          if (u && db.meta.thrones) {
            const cn = Object.values(db.meta.thrones).filter(t2 => t2 && t2.userId === u.id).length;
            if (cn) entry.crown = cn;
          }
          // 返信: 引用元のスニペットを載せる。相手が住人なら必ず返事が来る。
          const replyTarget = msg.replyTo ? chatHistory.find(e2 => e2.id === String(msg.replyTo)) : null;
          if (replyTarget) {
            entry.reply = { id: replyTarget.id, from: replyTarget.from, text: String(replyTarget.text).slice(0, 60) };
          }
          // Real messages get the best translation available (external engine
          // when configured, phrase table otherwise) before they go out.
          // 翻訳の完了順ではなく発言順で配る。翻訳を待ってから配ると、外部翻訳
          // エンジン設定時に発言の順番が入れ替わる。翻訳は待つが、配信は到着順に
          // 直列化する（translateChat は 2.5秒でタイムアウトするので詰まらない）。
          // ⚠️ このチェーンは必ず catch で閉じること。
          // ここは「発言順を守るため」に全員ぶんの発言を1本の Promise チェーンへ
          // 直列につないでいる。翻訳以外（履歴・配信・住人の返信生成）は素なので、
          // どれか1つが投げるとチェーンが rejected のまま固定され、以後 .then() の
          // 中身が二度と走らない ＝ 全プレイヤーの発言が、レート制限と統計だけ
          // 通って誰にも届かないまま消える。住人のセリフは postChat 直呼びで
          // ここを通らないのでチャット欄は動き続け、気づくのが決定的に遅れる
          // （復旧は再デプロイのみ）。catch を付ければチェーンは fulfilled に
          // 戻り、1件の失敗が後続の発言を巻き込まなくなる。
          chatChain = chatChain.then(async () => {
            let tr = null;
            try { tr = await translateChat(text); } catch { /* ignore */ }
            if (tr) entry.tr = tr;
            pushHistory(entry);
            broadcastAll(entry);
            const repliedResident = replyTarget && residentByName(replyTarget.from);
            if (repliedResident) forceResidentReply(ws, replyTarget.from, text);
            else maybeAmbientReply(text);
            maybeResidentReacts(entry);
          }).catch(err => { chatChainErrors++; console.error('[chat] chain:', err); });
          break;
        }
        case 'react': {
          const emoji = String(msg.emoji || '');
          if (!REACT_EMOJI.includes(emoji)) return;
          // ミュートはリアクションにも効く（モデレーションの抜け穴防止）。
          const ru = ws.user ? db.users[ws.user.id] : null;
          if (isMuted(ws)) return;
          // ⚠ チャットと同じ二段にする。sockRate はカウンタを ws に持つので、
          //    タブを2つ開くだけで持ち分が倍になる（配られるフレーム数も倍）。
          //    party_chat / guild_chat には既に userRate を足してあり、
          //    react だけ取り残されていた。
          if (!sockRate(ws, 'reactTimes', 12, 10000)
            || !userRate(`react:${ws.user ? ws.user.id : sockIp(ws)}`, 12, 10_000)) return;
          const who = sockName(ws);
          const entry = chatHistory.find(e2 => e2.id === String(msg.msgId || ''));
          if (!who || !entry) return;
          if (ru) {
            ru.stats = ru.stats || {};
            ru.stats.reactionsGiven = (ru.stats.reactionsGiven || 0) + 1;
          }
          applyReaction(entry, reactOwnerKey(ws), who, emoji);
          break;
        }
        case 'emote': {
          if (!match || match.ended || !me) return;
          // 🔇 ミュートは絵文字にも効く。
          //    chat は明示的に断り、react もコメント付きでミュートを見て
          //    （「モデレーションの抜け穴防止」）、party_chat も見ているのに、
          //    **いちばん当たりの強い場所**だけ塞がれていなかった ── 5秒に3回、
          //    試合をまたいで何度でも、相手にはブロック手段が無い。
          //    エラーは返さない（黙って落とす）。ミュートされていることを
          //    本人に毎回知らせても、規制の意味が薄れるだけ。
          if (isMuted(ws)) return;
          if (!sockRate(ws, 'emoteTimes', 3, 5000)) return;
          const EMOJIS = ['👍', '🔥', '😂', '😭', '🎉', '😱', '💪', '😎', '👏', '🤯'];
          const emoji = EMOJIS.includes(msg.emoji) ? msg.emoji : '👍';
          for (const p of match.players) {
            if (p.sock !== ws && !p.sock.isBot) {
              send(p.sock, { type: 'emote', slot: me.slot, emoji });
            }
          }
          break;
        }
        // ---- 👥 パーティー ----------------------------------------------
        // 全部アカウント限定。ゲストは名前が毎回変わってミュートも
        // ブロックも効かないので、4人だけの非公開の場には入れない。
        case 'party_create':
        case 'party_join':
        case 'party_leave':
        case 'party_kick':
        case 'party_invite':
        case 'party_invite_accept':
        case 'party_invite_decline':
        case 'party_chat':
        case 'party_play':
        case 'party_code': {
          if (!ws.user) {
            send(ws, { type: 'party_error', error: 'フレンド機能を使うにはアカウント登録が必要です' });
            break;
          }
          const uid = ws.user.id;
          const live = db.users[uid];
          if (!live) { send(ws, { type: 'party_error', error: 'ログインが必要です' }); break; }
          let r = { error: '' };
          switch (msg.type) {
            case 'party_create': r = party.create(uid); break;
            case 'party_join':
              // 合言葉の総当たりを防ぐ。join_room には今も制限が無い。
              if (!sockRate(ws, 'partyJoinTimes', 5, 10_000)) { r = { error: 'すこし早すぎます' }; break; }
              r = party.join(uid, String(msg.code || '').slice(0, 12));
              break;
            case 'party_leave': r = party.leave(uid); break;
            case 'party_kick': r = party.kick(uid, String(msg.userId || '')); break;
            case 'party_invite':
              if (!sockRate(ws, 'partyInviteTimes', 6, 20_000)) { r = { error: 'すこし早すぎます' }; break; }
              r = party.invite(uid, String(msg.userId || ''));
              break;
            case 'party_invite_accept': r = party.acceptInvite(uid, String(msg.inviteId || '')); break;
            case 'party_invite_decline': r = party.declineInvite(uid, String(msg.inviteId || '')); break;
            case 'party_chat':
              // 全体チャットと同じ持ち分を使う。別枠にすると、
              // パーティーに入るだけで発言できる量が倍になる。
              // アカウント単位の持ち分も全体チャットと共有する（ソケット単位
              // だけだと、接続を増やすだけで「同じ持ち分」が守られない）。
              if (!sockRate(ws, 'chatTimes', 5, 10_000)
                  || !userRate(`chat:${uid}`, 5, 10_000)) { r = { error: 'すこし早すぎます' }; break; }
              r = party.chat(uid, msg.text);
              break;
            case 'party_play': r = party.play(uid, String(msg.mode || ''), Number(msg.seats) || 0); break;
            case 'party_code': r = party.launchCode(uid, String(msg.code || '').slice(0, 12)); break;
          }
          if (r && r.error) send(ws, { type: 'party_error', error: r.error });
          break;
        }
        // 💬 ギルドチャット。20人が集まる場所なのに喋る手立てが1つも無かった。
        //    パーティーと同じ持ち分（全体チャットと共有）を使う ── 別枠にすると、
        //    ギルドに入るだけで発言できる量が倍になる。
        case 'guild_chat_hello': {
          if (!ws.user) break;
          const live = db.users[ws.user.id];
          if (!live) break;
          send(ws, { type: 'guild_chat_history', chat: guildChatHistory(db, live) });
          break;
        }
        case 'guild_chat': {
          if (!ws.user) {
            send(ws, { type: 'guild_error', error: 'ギルド機能を使うにはアカウント登録が必要です' });
            break;
          }
          const live = db.users[ws.user.id];
          if (!live) { send(ws, { type: 'guild_error', error: 'ログインが必要です' }); break; }
          if (!sockRate(ws, 'chatTimes', 5, 10_000) || !userRate(`chat:${ws.user.id}`, 5, 10_000)) {
            send(ws, { type: 'guild_error', error: 'すこし早すぎます。少し待ってください' });
            break;
          }
          const r = guildChat(db, live, msg.text, {
            uuid: () => crypto.randomUUID(),
            rateLimit: userRate,
            // パーティーと同じく、翻訳は手元の対訳表だけ。外部の翻訳サーバーには
            // 渡さない（ギルド内の私語が箱の外に出る）。
            translateLocal: (s) => {
              const tr = translateLocal(s, detectLang(s) === 'ja' ? 'en' : 'ja');
              return tr && tr.text ? tr.text : null;
            },
          });
          if (r.error) { if (r.error) send(ws, { type: 'guild_error', error: r.error }); break; }
          saveDb();
          // ギルド員全員へ。**全部の画面へ配る**（パーティーの状態と同じ理由 ──
          // PCとスマホの2つ目のタブで喋れないのは、繋ぐための機能として本末転倒）。
          for (const id of r.guild.members) {
            sendToUser(id, { type: 'guild_chat', msg: r.entry }, { primaryOnly: false });
            if (r.tr) sendToUser(id, { type: 'guild_chat_tr', id: r.entry.id, text: r.tr }, { primaryOnly: false });
          }
          break;
        }
        case 'ping': send(ws, { type: 'pong' }); break;
      }
    }

    ws.on('close', () => {
      clients.delete(ws);
      untrackSocket(ws);
      // フレンド一覧の「最終ログイン」。これまで user.lastSeen を書いていたのは
      // hello の1箇所（しかも5分スロットル）だけだったので、表示していたのは
      // 「最後に見かけた時刻」ではなく「最後に接続した時刻」だった。
      // 3時間つなぎっぱなしで遊んだ人がたった今抜けても「⚫ オフライン 3時間前」
      // と出る（長く遊んだ人ほど大きくずれる）。最後の1本が閉じた時点で刻む。
      // socketsOf は readyState で絞るので、閉じたこの socket は数えない。
      if (ws.user) {
        const live = db.users[ws.user.id];
        if (socketsOf(ws.user.id).length === 0) {
          if (live) { live.lastSeen = Date.now(); saveDb(); }
          // 🕒 最後の1本が閉じたときだけ在席区間を閉じる。
          // （タブを1つ閉じるたびに切ると、ログが意味を失う）
          closeOnlineSpan(ws.user.id);
        }
      }
      // パーティーの所属はここでは落とさない。1人が最大6本つなぐし、
      // 対戦用の socket は試合から抜けるたびに閉じる。落とすと点滅する。
      if (ws.user) party.socketGone(ws.user.id);
      leaveQueues(ws);
      leaveRoom(ws);
      dropRematchesFor(ws);   // 🔁 相手が消えたら再戦オファーも消える
      if (ws.zeroId) zeroSeatOut(ws);   // 👁️断罪の席から外し、無人なら部屋を畳む
      // Battle royale: leaving eliminates you where you actually stood — LAST
      // among the current survivors. Awarding rank-among-survivors made
      // quitting while ahead score better than playing the round out.
      if (ws.royaleId) {
        const r = royales.get(ws.royaleId);
        if (r && !r.ended) {
          const e = r.entrants.find(x => x.ws === ws);
          if (e && e.alive) {
            // 🔌 **ログインしている人には、対戦と同じ猶予を置く。**
            //    いちばん長くて（180秒）いちばん切断の代償が大きいモードなのに、
            //    ここだけ猶予がゼロで、電車で1〜2秒切れただけで
            //    「そのとき生きていた全員の中で最下位」が即確定していた。
            //    しかも結果カードは閉じたソケットへ送られて捨てられるので、
            //    本人は自分が何位だったかも、何がもらえたかも分からない。
            //    順位の裁定（離脱＝生存者中最下位）そのものは変えないので、
            //    「逃げ得にしない」設計は保たれる ── 待つのは確定の**時刻**だけ。
            //    ⚠ ただし猶予は **対戦とまったく同じ関門**をくぐらせる。
            //      ここだけ無条件で 25秒 を配っていたので、1日の回数
            //      （RECONNECT_GRACE_PER_DAY／openReconnectGrace が守っているもの）を
            //      素通りできた ── 切るたびに無敵時間が何度でも手に入る。
            let held = false;
            if (ws.user) {
              // 試合が終わる時刻を越えて待っても戻ってこられない。
              const endAt = r.startedAt + (COUNTDOWN + ROYALE_DURATION) * 1000;
              const until = Math.min(Date.now() + RECONNECT_GRACE_MS, endAt);
              const user = db.users[ws.user.id];
              if (user && !user.banned
                && until - Date.now() >= RECONNECT_GRACE_MIN_MS
                && takeGraceQuota(user)) {
                e.dcUntil = until;
                e.pending = [];       // 猶予中のお邪魔の預かり箱（royaleHit）
                held = true;
              }
            }
            if (!held) {
              const ranked = royaleRanked(r);
              endRoyaleFor(e, r, ranked.length, ranked);
              // 🎭 「離脱」は **実プレイヤーにしか起きない出来事**だった。
              //    住人は席を立たない（潰れて 'ko' になるだけ）ので、
              //    速報に「◯◯ が離脱」と出た名前は例外なく実プレイヤー ──
              //    ⭐印（real:true）を消したのとまったく同じ形の漏れ。
              //    攻撃者のいない 'ko'（＝「◯◯ 脱落」）は住人の topout と
              //    見分けが付かないので、そちらに寄せる。
              royaleFeed(r, { kind: 'ko', victim: e.name });
            }
          }
        }
        ws.royaleId = null;
      }
      const match = ws.matchId ? matches.get(ws.matchId) : null;
      // Co-op: a dropped partner doesn't end the run — the server plays their
      // turns so whoever is still there can finish the board.
      if (match && !match.ended && match.mode === 'coop') {
        const p = match.players.find(q => q.sock === ws);
        if (p) p.finished = true;
        const stillHere = match.players.some(q => q !== p && !q.sock.isBot && q.sock.readyState === q.sock.OPEN);
        if (!stillHere) endMatch(match, 'abandoned');
        else {
          for (const q of match.players) {
            if (q !== p && !q.sock.isBot) send(q.sock, { type: 'coop_partner_left' });
          }
        }
        ws.matchId = null;
        return;
      }
      if (match && !match.ended) {
        const p = match.players.find(q => q.sock === ws);
        if (p && !p.finished) {
          // 🔌 まず猶予を試す。開けたらこの切断ではまだ負けにしない
          //（時計は動いたまま。戻らなければ猶予切れで下と同じ結末になる）。
          if (!openReconnectGrace(match, p)) forfeitPlayer(match, p);
        }
      }
    });
  });

  // Heartbeat: drop dead connections.
  setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);

  // 更新で落ちる前に、進行中のものを正式に終わらせる。
  // 対戦は引き分け（記録も報酬も残る）、ロイヤルはその時点の順位で確定、
  // ソロなど対戦していない人には「保存して終わって」と伝える。
  function endAllForShutdown() {
    let ended = 0;
    // 先に全員へ通知しておく。クライアントはこれを見てソロを畳み、結果を送る。
    broadcastAll({ type: 'server_shutdown', graceSec: 5 });
    for (const m of [...matches.values()]) {
      if (m.ended) continue;
      try { endMatch(m, 'shutdown'); ended++; } catch { /* 1件の失敗で全部止めない */ }
    }
    for (const r of [...royales.values()]) {
      if (r.ended) continue;
      try {
        r.ended = true;
        clearInterval(r.tick);
        const ranked = royaleRanked(r);
        for (let i = ranked.length - 1; i >= 0; i--) endRoyaleFor(ranked[i], r, i + 1, ranked);
        royales.delete(r.id);
        ended++;
      } catch { /* 同上 */ }
    }
    for (const t of [...tourneys.values()]) {
      try {
        // 🏆 大会だけ、1フレームも送らずに消していた。
        //    対戦は endMatch(m,'shutdown')、ロイヤルは endRoyaleFor、待ち行列は
        //    queue_cancelled で必ず知らせているのに、ここだけ無言。SIGTERM 経由なら
        //    5秒後にソケットが切れて救われるが、この関数は
        //    /api/admin/prepare-update からも呼ばれ、そちらはサーバーが**動き続ける**。
        //    ラウンド間の人は「まもなく対戦開始…」（閉じ口の無いモーダル）の前で
        //    完全に固まり、リロードするしか出口が無かった。
        for (const p of (t.alive || [])) {
          if (!p || p.isBot) continue;
          send(p, { type: 'tourney_cancelled' });
          send(p, { type: 'error', error: 'サーバー更新のためトーナメントを中止しました' });
        }
        endTourney(t); ended++;
      } catch { /* 同上 */ }
    }
    // 待ち行列だけ通知なしで捨てていた。SIGTERM 経由なら5秒後に落ちるので
    // 目立たないが、この関数は /api/admin/prepare-update からも呼ばれ、
    // そちらはサーバーが動き続ける。待っていた人は1秒ごとの queued が
    // 止まるだけで「🎯 レート … あと N 秒で AIプレイヤーが参戦します」を
    // 表示したまま凍り、何分待ってもマッチもAI補充も起きなかった。
    for (const q of Object.values(queues)) {
      for (const e of q) {
        send(e.ws, { type: 'queue_cancelled' });
        send(e.ws, { type: 'error', error: 'サーバー更新のためマッチングを中止しました。少し待ってからもう一度お試しください' });
      }
      q.length = 0;
    }
    return ended;
  }

  // 🚪 退会・管理者削除の後始末（その1）── その人の socket を全部閉じる。
  //
  // 閉じないと、レコードが消えたあとも socket は生き続ける。ws.user は hello の
  // ときに取った控え（id と名前だけ）なので db から引けなくなっても残り、
  // 退会したはずの名前でチャットを続けられた。しかも凍結・ミュートの判定は
  // db.users[id] を引いて決めるので、**レコードが無い＝制限も掛からない** ──
  // 「退会すると取り締まりから外れる」という逆向きの穴になっていた。
  //
  // 進行中の試合は forfeit させず、close に任せる（切断の扱いは既存の
  // onclose が持っており、そちらのほうが賢い）。
  // 🔏 いまその人が繋いでいる回線の指紋。凍結したときに「どの回線を止めるか」を
  //    決めるのに使う。**生のIPは返さない** ── 呼び出し側（管理者パネル）に
  //    渡ってしまえば、db に残さない方針が意味を失う。
  function ipFingerprintsOf(userId) {
    const out = new Set();
    for (const w of socketsOf(String(userId || ''))) {
      const fp = ipFingerprintOf(sockIp(w));
      if (fp) out.add(fp);
    }
    return [...out];
  }

  function disconnectUser(userId, reason) {
    const live = socketsOf(String(userId || ''));
    for (const w of live) {
      try {
        if (reason) send(w, { type: 'error', error: reason });
        w.user = null;              // 閉じ切るまでの隙間で名乗れないようにする
        w.close();
      } catch { /* すでに閉じている */ }
    }
    return live.length;
  }

  // 🚪 退会・管理者削除の後始末（その2）── 全体チャットの履歴から名前を伏せる。
  //
  // chatHistory は接続のたびに丸ごと配られる（hello_ok の chat: 欄）。退会者の
  // 発言をそのまま残すと、アカウントを消したあとも名前つきの発言が新規接続の
  // 全員に配られ続ける。発言そのものは会話の流れとして残す価値があるので、
  // 消すのではなく名前だけ伏せる（💎購入履歴の TX_ANON_NAME と同じ考え方）。
  // メモリ側（chatHistory）とディスク側（db.meta.chatLog）の両方を直すこと ──
  // 片方だけだと、再起動でもう一方から名前が戻ってくる。
  function scrubDepartedName(username, replacement) {
    const name = String(username || '');
    if (!name) return 0;
    let n = 0;
    // 🧹 発言の名前だけでなく、**リアクションの持ち主一覧**も伏せる。
    //    entry.reacts = { '👍': ['名前', …] } は別の欄なので e.from の書き換えでは
    //    直らず、退会した人の名前がスタンプの長押しツールチップに残っていた
    //    （db.meta.chatLog にも入るので再起動後も残り、hello_ok で全員に配られる）。
    //    ⚠ 他人の発言に押したスタンプが対象なので、e.from の一致とは**独立に**回す。
    const scrubReacts = e => {
      if (!e || !e.reacts) return;
      for (const k of Object.keys(e.reacts)) {
        if (!Array.isArray(e.reacts[k])) continue;
        e.reacts[k] = e.reacts[k].map(x => (x === name ? replacement : x));
      }
    };
    for (const e of chatHistory) {
      if (e && e.from === name) { e.from = replacement; e.role = 'player'; n++; }
      scrubReacts(e);
    }
    if (Array.isArray(db.meta.chatLog)) {
      for (const e of db.meta.chatLog) {
        if (e && e.from === name) { e.from = replacement; e.role = 'player'; }
        scrubReacts(e);
      }
    }
    // メモリ側の所有者表も直す（次の付け外しで名前が戻らないように）。
    for (const owners of reactOwners.values()) {
      for (const [k, v] of owners) {
        if (v && v.name === name) owners.set(k, { ...v, name: replacement });
      }
    }
    return n;
  }

  return {
    clients,
    party,
    presence: { isOnline, statusOf, sendToUser },
    disconnectUser, scrubDepartedName, ipFingerprintsOf,
    matches, rooms,
    endAllForShutdown,
    queueSize: queueSizeAll,   // all seven queues — duel+team alone under-reported

    // 🔒 マッチング待ちの内訳（**運営専用**）。
    //
    // なぜ要るのか
    //   v2.36 でマッチング画面から「あと N 秒で対戦相手が見つかります」と
    //   「このモードで待っている人: N人」を消した。本物のマッチングは相手の
    //   到着時刻を予告できないし、0人待ちとカウントダウンが同時に出た瞬間に
    //   「相手は用意されたもの」だと分かってしまうため（＝住人の秘匿と衝突）。
    //   ただし運営はこの数字が見えないと、キューが詰まっているのか誰も並んで
    //   いないのかを切り分けられない。だから **画面からは消し、運営には残す**。
    //
    // ⚠ 出してよいのは /api/admin/matchmaking（requireAuth + requireAdmin）だけ。
    //   /api/status のような公開の口に混ぜてはいけない ── matchInSec は
    //   「席が埋まる時刻」そのもので、住人の正体に直結する。
    //   ⚠ /api/admin/* は server/sanitize.js の関門を経路ごとバイパスするので、
    //     ここに足した欄は削られずにそのまま出る。増やすときはその前提で。
    //
    // 形は server/routes/admin.js の mmBreakdown() が受け取る契約に合わせてある:
    //   { [mode]: [{ name, waited(秒), matchInSec(秒), rating, guest }] }
    queueBreakdown: () => {
      const now = Date.now();
      const out = {};
      for (const [mode, q] of Object.entries(queues)) {
        out[mode] = q
          // 席埋めの Bot はキューに並ばない（botAt で直接入る）が、
          // 将来並ぶようになっても運営の画面が水増しされないよう弾いておく。
          .filter(e => e && e.ws && !e.ws.isBot)
          .map(e => ({
            name: sockName(e.ws) || '—',
            waited: Math.max(0, Math.round((now - e.since) / 1000)),
            matchInSec: Math.max(0, Math.round((e.botAt - now) / 1000)),
            rating: ratingOf(e.ws),
            // 未ログイン（ゲスト）は user を持たない。運営が
            // 「登録者が待っているのか」を見分けるための印。
            guest: !e.ws.user,
          }));
      }
      return out;
    },
    displayOnline, displayMatches,
    // 👥 いま本当につないでいる人。
    //
    // 「オンライン人数」は住人（にぎわい）を足した表示用の数なので、実際に誰が
    // 遊んでいるのかは今までどこからも見えなかった。ここは**実クライアントだけ**を
    // 返す（isBot と、名乗っていない接続は除く）。
    //
    // 1人が対戦画面に入るとチャット用と対戦用で2本つなぐので、素直に socket を
    // 並べると同じ人が2行出る。人単位にまとめ、本数は conns として持たせる。
    // IPは出さない（運営に必要なのは「誰が」であって「どこから」ではない。
    // 必要になったら別途 addr を足す判断をすること）。
    livePlayers: () => {
      const byKey = new Map();
      for (const c of clients) {
        if (c.isBot) continue;
        const name = sockName(c);
        if (!name) continue;                      // まだ名乗っていない接続
        const key = c.user ? 'u:' + c.user.id : 'g:' + name;
        const cur = byKey.get(key);
        const since = c._since || Date.now();
        if (cur) {
          cur.conns++;
          if (since < cur.since) cur.since = since;
          if (!cur.playing) cur.playing = !!(c.matchId || c.royaleId || c.zeroId || c.tourneyId || c.roomCode);
          continue;
        }
        byKey.set(key, {
          name,
          userId: c.user ? c.user.id : null,
          guest: !c.user,
          conns: 1,
          since,
          playing: !!(c.matchId || c.royaleId || c.zeroId || c.tourneyId || c.roomCode),
          queueing: [...Object.values(queues)].some(q => q.some(e => e.ws === c)),
        });
      }
      const now = Date.now();
      return [...byKey.values()]
        .map(p => {
          const u = p.userId ? db.users[p.userId] : null;
          return {
            ...p,
            minutes: Math.max(0, Math.round((now - p.since) / 60000)),
            // ⚠ levelOf は index.js の `levelOf(xp)` で **数値そのもの** を返す
            // （オブジェクトではない）。`levelOf(u).level` と書いていたため
            // NaN.level = undefined になり、JSON では欄ごと落ちて管理者パネルの
            // 『実プレイヤー一覧』が全員レベル空欄だった。xp を渡すのが正しい。
            level: u ? levelOf(u.xp) : null,
            rating: u && u.stats ? (u.stats.rating || null) : null,
            games: u && u.stats ? (u.stats.gamesPlayed || 0) : null,
            admin: !!(u && u.role === 'admin'),
            where: p.playing ? 'playing' : (p.queueing ? 'queue' : 'menu'),
          };
        })
        .sort((a, b) => a.since - b.since);
    },

    // 👀 いま誰がオンラインで、何をしているか（**運営専用**）。
    //
    // ■ livePlayers() との違い
    //   livePlayers() の状態は playing / queue / menu の3値しかない。
    //   運営が知りたいのは「1on1で対戦中」「チーム戦のマッチング待ち42秒」
    //   「合言葉ルーム ABCD で待機」「ロイヤルで落ちて観戦中」「断罪の席」
    //   ── ここまでの粒度なので、socket が持っている手掛かり
    //   （matchId / royaleId / tourneyId / zeroId / roomCode とキューの中身）を
    //   全部読んで1行にまとめる。livePlayers() は既に別の画面（/api/admin/stats・
    //   /api/admin/playerstats の online 判定）が使っているので**触らない**。
    //
    // ■ 分からないこと（画面にもそう出すこと）
    //   ソロ・タイムアタック・工房などの1人用は、遊んでいる最中に何も送って
    //   こない（サーバーが知るのは POST /api/result の1回だけ）。つまり
    //   「メニュー」と「ソロで遊んでいる」は原理的に区別できない。
    //   secondary（対戦画面の2本目）が開いているかだけは分かるので、
    //   act:'online' として区別しておく。
    //
    // ■ 絶対に公開APIへ出さないこと
    //   queueBreakdown と同じ理由。seats（住人が座っている席）が同じ応答に
    //   入っている時点で正体に直結する。出してよいのは
    //   /api/admin/online（requireAuth + requireAdmin）だけ。
    //   ⚠ /api/admin/* は server/sanitize.js の関門を経路ごとバイパスするので、
    //     ここに足した欄は削られずにそのまま出る。
    onlineBreakdown: () => {
      const now = Date.now();

      // socket 1本ぶんの「いま何をしているか」。act は画面の言葉に直す前の id で、
      // 言葉と重み付け（人単位にまとめるときの優先順）は routes/admin.js が持つ。
      const activityOf = (ws) => {
        // 👁️ 断罪（管理者イベント）の席。落ちた人はそのまま観戦に回る。
        if (ws.zeroId) {
          const sess = zeroSessions.get(ws.zeroId);
          if (sess && !sess.ended) {
            const e = sess.entrants.find(x => x.ws === ws);
            return { act: e && !e.alive ? 'zero_watch' : 'zero', mode: 'zero' };
          }
        }
        // 🏆 バトルロイヤル。脱落しても部屋には残る（観戦）。
        if (ws.royaleId) {
          const r = royales.get(ws.royaleId);
          if (r && !r.ended) {
            const e = r.entrants.find(x => x.ws === ws);
            return {
              act: e && !e.alive ? 'royale_watch' : 'match', mode: 'royale',
              secs: Math.max(0, Math.round((now - r.startedAt) / 1000)),
              alive: !!(e && e.alive),
            };
          }
        }
        // ⚔️ ふつうの試合。トーナメントの1回戦も実体はこれ。
        if (ws.matchId) {
          const m = matches.get(ws.matchId);
          if (m && !m.ended) {
            return {
              act: 'match', mode: m.mode, tourney: !!m.tourney,
              secs: Math.max(0, Math.round((now - m.startedAt) / 1000)),
            };
          }
        }
        // 🏅 トーナメントの合間（次の組み合わせ待ち）。試合中は上で拾われる。
        if (ws.tourneyId) {
          const t = tourneys.get(ws.tourneyId);
          if (t && !t.ended) return { act: 'tourney', mode: 'tourney', round: (t.round || 0) + 1 };
        }
        // 🚪 合言葉ルーム。room.matchId が立っていれば、その部屋は観戦室。
        if (ws.roomCode) {
          const room = rooms.get(ws.roomCode);
          if (room) {
            const watch = room.watch && room.watch.has(ws);
            return {
              act: room.matchId ? 'room_watch' : 'room',
              room: room.code,
              host: ensureHost(room) === ws,
              seat: watch ? 'watch' : 'play',
              mode: room.settings ? room.settings.mode || (room.settings.team ? 'team' : 'duel') : null,
            };
          }
        }
        // 🎯 マッチング待ち。待ち時間はキューの entry が持っている。
        for (const [mode, q] of Object.entries(queues)) {
          const e = q.find(x => x && x.ws === ws);
          if (e) return { act: 'queue', mode, waited: Math.max(0, Math.round((now - e.since) / 1000)) };
        }
        // それ以外。2本目（対戦画面）が開いているかどうかだけは分かる。
        return { act: ws.secondary ? 'online' : 'menu' };
      };

      // --- 実プレイヤー（人単位。同じ人の複数タブ／端末は1行にまとめる） ---
      const byKey = new Map();
      for (const c of clients) {
        if (c.isBot) continue;                    // clients に bot は入らないが念のため
        const name = sockName(c);
        if (!name) continue;                      // まだ名乗っていない接続
        // ゲストは userId を持たないので名前で束ねる（同名ゲストは1人に見えるが、
        // hello の重複名チェックで同名は基本作られない）。
        const key = c.user ? 'u:' + c.user.id : 'g:' + name;
        const since = c._since || now;
        const a = activityOf(c);
        let row = byKey.get(key);
        if (!row) {
          const u = c.user ? db.users[c.user.id] : null;
          row = {
            name,
            userId: c.user ? c.user.id : null,
            guest: !c.user,
            role: u ? u.role || 'user' : null,
            admin: !!(u && u.role === 'admin'),
            level: u ? levelOf(u.xp) : null,
            rating: u && u.stats ? (u.stats.rating || null) : null,
            games: u && u.stats ? (u.stats.gamesPlayed || 0) : null,
            conns: 0,
            since,
            acts: [],
          };
          byKey.set(key, row);
        }
        row.conns++;
        if (since < row.since) row.since = since;   // いちばん古い接続＝その人の滞在開始
        row.acts.push(a);
      }
      const players = [...byKey.values()].map(r => ({
        ...r,
        ms: Math.max(0, now - r.since),
      }));

      // --- 住人が座っている席（**運営専用**。実プレイヤーとは器を分ける） ---
      // 「接続時間」は無い ── 住人は socket を持たないので、分かるのは
      // 「いまどの試合に座っているか」と「その試合が始まってから何秒か」だけ。
      //
      // ⚠ 上限を付ける理由。players は clients（＝ MAX_SOCKETS 本）が天井なので
      //   放っておいても膨らまないが、席のほうは天井が無い ── ロイヤルは1本
      //   あたり最大 ROYALE_SIZE 席で、その大半が住人。同時に何本も走ると
      //   数千行の配列を5秒ごとに組むことになる。切り詰めても本当の数は
      //   seatTotal で返すので、画面は「N席中M席を表示」と正しく言える。
      const SEAT_CAP = 2000;
      const seats = [];
      let seatTotal = 0;
      const seatPush = (name, a) => {
        if (!name) return;
        seatTotal++;
        if (seats.length < SEAT_CAP) seats.push({ name, ...a });
      };
      // 試合に座っている席の実体（Bot インスタンス）を控える。トーナメントの
      // t.alive には同じ Bot がそのまま入っているので、これが無いと1回戦の
      // あいだ同じ住人が「対戦中」と「トーナメント」で二重に並ぶ。
      // ⚠ Bot は matchId を持たない（createMatch は isBot をスキップする）ので、
      //   `!s.matchId` では弾けない ── 参照そのもので照合する。
      const seated = new Set();
      for (const m of matches.values()) {
        if (!m || m.ended) continue;
        const secs = Math.max(0, Math.round((now - m.startedAt) / 1000));
        for (const p of m.players) {
          if (p.sock && p.sock.isBot) { seated.add(p.sock); seatPush(p.sock.name, { act: 'match', mode: m.mode, secs }); }
        }
      }
      for (const r of royales.values()) {
        if (!r || r.ended) continue;
        const secs = Math.max(0, Math.round((now - r.startedAt) / 1000));
        for (const e of r.entrants) {
          if (!e.human) seatPush(e.name, { act: e.alive ? 'match' : 'royale_watch', mode: 'royale', secs, alive: !!e.alive });
        }
      }
      for (const t of tourneys.values()) {
        if (!t || t.ended) continue;
        for (const s of t.alive) {
          // 試合中の席は上の matches 側で既に拾っている（二重に並べない）。
          if (s && s.isBot && !seated.has(s)) seatPush(s.name, { act: 'tourney', mode: 'tourney', round: (t.round || 0) + 1 });
        }
      }
      for (const sess of zeroSessions.values()) {
        if (!sess || sess.ended) continue;
        for (const e of sess.entrants) {
          if (!e.human && !e.left) seatPush(e.name, { act: e.alive ? 'zero' : 'zero_watch', mode: 'zero' });
        }
      }

      return { at: now, sockets: clients.size, players, seats, seatTotal };
    },
    // 🔌 接続の上限まわり。断った回数が増え始めたら、上限そのものを見直す合図。
    connStats: () => ({
      max: MAX_SOCKETS, perIp: MAX_SOCKETS_PER_IP, perUser: MAX_SOCKETS_PER_USER,
      open: clients.size,
      // いま開いている socket が何種類のIPに見えているか。前段プロキシの設定が
      // ずれていると、人数が多いのにここが 1 に張り付く（＝また壁が出る合図）。
      distinctIps: new Set([...clients].map(sockIp)).size,
      rejectedTotal: connRejects.total,
      rejectedMax: connRejects.max, rejectedPerIp: connRejects.perIp, rejectedPerUser: connRejects.perUser,
      lastRejectAt: connRejects.lastAt,
      chatChainErrors,
    }),
    broadcastAll,
    zero: {
      name: ZERO_NAME,
      // 憑依（管理画面から）
      say: (text, tr) => zeroChat(text, tr),
      // 台詞テーブルから
      speak: (kind, danIndex, ctx) => zeroSpeak(kind, danIndex, ctx),
    },
    chatOps: {
      clear: () => {
        chatHistory.length = 0;
        reactOwners.clear();   // 消えた発言に紐づくリアクションの所有者表も一緒に畳む
        // ディスク側（db.meta.chatLog）も同時に空にする。以前はメモリの配列を
        // 空にするだけで、db.meta.chatLog を書き換えるのは persistChat＝
        // 「新しい発言があったとき」だけだった。つまり消したあと誰も発言しない
        // うちに再起動（デプロイ、スピンダウン復帰、SIGTERM）が挟まると、
        // hello_ok の chat: に実プレイヤーの発言が最大40件そのまま復活する。
        // 消さなければならなかった発言ほど黙って戻ってくるので実害がある。
        // 予約済みの persistChat は空の履歴を書くだけだが、打ち消しておく。
        if (chatSaveTimer) { clearTimeout(chatSaveTimer); chatSaveTimer = null; }
        db.meta.chatLog = [];
        saveDb();
        broadcastAll({ type: 'chat_clear' });
      },
      say: (text) => postAmbient(text),
    },
    crowd: {
      react,
      feed: (item) => postFeed(item),
      feedHistory: () => feedHistory.slice(),
      // Boot ordering: the seeded history is built BEFORE the seed auto-restore
      // computes thrones — index.js calls this afterwards so the 8 seed
      // messages get their crowns too.
      restampCrowns: () => {
        for (const e of chatHistory) {
          if (!e || !e.from) continue;
          const n = db.meta.thrones ? Object.values(db.meta.thrones).filter(th => th && th.username === e.from).length : 0;
          if (n) e.crown = n; else delete e.crown;
        }
      },
      // Admin test hooks: fire one thing right now, bypassing the cadence.
      test: (what) => {
        const ctx = worldCtx({ humans: humanNames() });
        if (what === 'dialogue') {
          const s = composeDialogue(ctx);
          if (!s) return { error: '会話できる住人が足りません（人口を上げるか時間帯を待ってください）' };
          performScript(s.map((x, i) => ({ ...x, delay: i * 2500 })), null, true);
          return { lines: s.map(x => `${x.resident.name}: ${x.text}`) };
        }
        if (what === 'feed') {
          const item = composeFeed(ctx);
          if (!item) return { error: 'オンラインの住人がいません' };
          postFeed(item);
          return { lines: [`${item.icon} ${item.text}`] };
        }
        if (what === 'greet') {
          const s = composeReaction('greet_plain', ctx, {}, 1);
          performScript(s.map(x => ({ ...x, delay: 500 })), null, true);
          return { lines: s.map(x => `${x.resident.name}: ${x.text}`) };
        }
        if (what === 'reaction') {
          const kind = ctx.event ? 'event_start' : ctx.poll ? 'poll_open' : 'greet_plain';
          const s = composeReaction(kind, ctx, {}, 2);
          performScript(s.map((x, i) => ({ ...x, delay: 500 + i * 2500 })), null, true);
          return { lines: s.map(x => `${x.resident.name}: ${x.text}`) };
        }
        const line = residentLine();
        postChat(line.name, line.text, line.tr ? { tr: line.tr } : {});
        return { lines: [`${line.name}: ${line.text}`] };
      },
      activeCount: () => worldCtx().active.length,
    },
  };
}
