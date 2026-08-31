// Multiplayer battle system: matchmaking (1v1 / 2v2 team), custom rooms,
// and server-side bot players that fill empty seats.
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { Engine } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';
import { RAID_BOSSES } from './catalog.js';
import {
  effectiveScale, pickPersona, pickResidentBot, residentLine, residentById, residentByName,
  ambientOnline, ambientMatches, ambientQueue, crowdMood, chooseReplies, chatPaceFactor, chatFloorMs, getRoster,
  toggles, isQuietNow, popFactor, worldCtx,
} from './ambient.js';
import { composeDialogue, composeFeed, composeReaction } from './crowd.js';
import { zeroSay, moodFor } from './zero.js';
import { createSession as createZeroSession, tick as tickZero, submitCut as zeroCut,
  submitStake as zeroStake, submitDealVote as zeroDealVote,
  submitWill as zeroWill, latestWill as zeroLatestWill, addHuman as zeroAddHuman,
  topOut as zeroTopOut, stateView as zeroStateView, syncBoard as zeroSyncBoard,
  ZERO_TICK } from './zero-session.js';
import { eventBonus } from './events.js';
import { danAt, DAN as ZERO_DAN } from './zero.js';
import { createParties } from './party.js';
import { getSchedule as getAeSchedule, liveSlotFor as aeLiveSlotFor,
  ensureRun as aeEnsureRun, slotCounts as aeSlotCounts, entrantCount as aeEntrantCount,
  SHARD as AE_SHARD, recordThrone as aeRecordThrone } from './adminevent.js';
import { translateChat, translateLocal, detectLang } from './translate.js';
import { isOpen as pollIsOpen, vote as pollVote, residentChoice, residentVoteAt, isSwingVoter } from './polls.js';

const COUNTDOWN = 3;
// ms alone in queue before an AI player fills the seat (randomized per entry
// so joins don't feel mechanical)
const duelBotWait = () => 4000 + Math.random() * 5000;
const teamBotWait = () => 5000 + Math.random() * 5000;
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
const coopBotWait = () => 6000 + Math.random() * 5000;
// Bot strength rises with the round: QF easy/normal, SF normal/hard, F hard/oni.
const TOURNEY_BOT_LEVELS = [['easy', 'normal'], ['normal', 'hard'], ['hard', 'oni']];

export function initBattle(server, deps) {
  const { db, saveDb, applyGameResult, publicUser, levelOf, sanitizeName, MATCH_DURATION } = deps;
  // 予約名判定（無ければ何も予約しない安全側デフォルト）。index.js が渡す。
  const reservedName = deps.reservedName || (() => false);
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
      if (w.matchId || w.royaleId || w.zeroId || w.tourneyId || w.roomCode) return 'playing';
    }
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
  const MAX_SOCKETS_PER_IP = 12;        // 同一IPあたり（家族や学校の共有を考慮して緩め）
  const MAX_SOCKETS_PER_USER = 6;       // 同一アカウントあたり（PC＋スマホ＋予備）
  const HELLO_GRACE_MS = 20_000;        // 名乗らない接続を切るまで
  const sockIp = ws => (ws && ws._ip) || '?';
  const matches = new Map();               // matchId -> match
  const rooms = new Map();                 // code -> room
  const tourneys = new Map();              // id -> tournament
  const royales = new Map();               // id -> battle royale
  const queues = { duel: [], attack: [], team: [], raid: [], tourney: [], royale: [], coop: [] };   // entries: { ws, since, botAt }
  // 全体チャットを「発言順」で配るための直列化チェーン（翻訳完了順のズレを防ぐ）。
  let chatChain = Promise.resolve();

  function send(sock, msg) {
    if (sock.isBot) return;
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
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
          message: `👁️ 断罪 ── 第${rec.dan}段が陥落！ 王座がひとつ返ってきました${rec.by ? `（とどめ: ${rec.by}）` : ''}`,
          messageEn: `👁️ CONDEMNED ── Stage ${rec.dan} has fallen. One throne returns${rec.by ? ` (finished by ${rec.by})` : ''}`,
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
    send(e.ws, {
      ...zeroStateView(sess, run),
      type: 'zero_found',
      id: sess.id, seed: sess.seed, countdown: 3,
      // 再接続（新セッション）でも、とどめを刺して未記入の段があれば伝言を書ける。
      canWill: (run.broken || []).some(b => b.by === e.name && !b.will),
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
      ...(en ? { tr: { lang: 'en', text: String(en).slice(0, 300), engine: 'native' } } : {}),
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

  // Replying to a resident's message always gets an answer from that resident.
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
  function performScript(script, key = 'chat') {
    for (const s of script) {
      setTimeout(() => {
        if (!crowdOn(key)) return;
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
    void ctx;
  }

  // Chat cadence: busier crowd → shorter gaps. Dialogues are rarer.
  let lastDialogueAt = 0;
  const directChat = () => {
    // Absolute floor keeps a ×100 crowd lively without a broadcast storm.
    const gap = Math.max(chatFloorMs(2500), (20000 + Math.random() * 50000) / chatPaceFactor() / Math.max(0.5, Math.min(4, popFactor())));
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
    const gap = Math.max(chatFloorMs(6000), (25000 + Math.random() * 60000) / chatPaceFactor() / Math.max(0.5, Math.min(4, popFactor())));
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
  const EMOTE_SET = ['👍', '🔥', '😂', '😭', '🎉', '😱', '💪', '😎', '👏', '🤯'];

  class Bot {
    constructor(level = 'random', used) {
      this.isBot = true;
      this.level = BOT_LEVELS.includes(level) ? level : randomBotLevel();
      // Prefer a resident whose rating matches this strength — the name you
      // beat in ranked is the same one chatting in the lobby and sitting on
      // the leaderboard. Fall back to a throwaway persona otherwise.
      const res = Math.random() < 0.7 ? pickResidentBot(this.level, used) : null;
      if (res) {
        this.resident = res.resident;
        this.name = res.name;
        this.rating = res.rating;
        this.fakeLevel = res.level;
      } else {
        this.resident = null;
        const persona = pickPersona({ used });
        this.name = persona.name;
        const [rLo, rHi] = BOT_RATING[this.level];
        this.rating = persona.registered ? rLo + crypto.randomInt(rHi - rLo) : null;
        const [lLo, lHi] = BOT_LVL[this.level];
        this.fakeLevel = persona.registered ? lLo + crypto.randomInt(lHi - lLo) : 1;
      }
      this.timer = null;
      this.emoteTimer = null;
    }

    startPlay(match, slot) {
      this.engine = new Engine(match.seed);
      const moveMs = BOT_MOVE_MS[this.level] || 1700;
      const endAt = match.startedAt + (COUNTDOWN + match.duration) * 1000;
      const tick = () => {
        if (match.ended) return;
        if (Date.now() >= endAt) {
          finishPlayer(match, slot, this.engine.score, this.engine.linesCleared, this.engine.maxCombo);
          return;
        }
        if (this.engine.over) this.engine.reviveBoard();
        const mv = chooseMove(this.engine, this.level);
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
              deliverAttack(match, slot, q, cells);
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
        players: match.players.map(q => ({
          slot: q.slot, team: q.team, name: sockName(q.sock),
          level: sockLevel(q.sock), rating: sockRating(q.sock),
          isBot: !!q.sock.isBot, isYou: q === p,
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

  function deliverAttack(match, fromSlot, p, cells) {
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
      send(p.sock, { type: 'garbage', from: fromSlot, cells });
    }
  }

  // 段位（クライアント dom.js rankOf と同じしきい値）
  const RANK_TIERS = [
    { min: 0, icon: '🥉', name: 'ブロンズ', nameEn: 'Bronze' },
    { min: 950, icon: '🥈', name: 'シルバー', nameEn: 'Silver' },
    { min: 1100, icon: '🥇', name: 'ゴールド', nameEn: 'Gold' },
    { min: 1300, icon: '💠', name: 'プラチナ', nameEn: 'Platinum' },
    { min: 1500, icon: '💎', name: 'ダイヤ', nameEn: 'Diamond' },
    { min: 1700, icon: '👑', name: 'マスター', nameEn: 'Master' },
  ];
  function tierOfRating(r) {
    let out = RANK_TIERS[0];
    for (const t of RANK_TIERS) if (r >= t.min) out = t;
    return out;
  }

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
    for (const p of match.players) if (p.sock.isBot) p.sock.stop();

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
    if (reason === 'forfeit') {
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

    const playersInfo = match.players.map(p => ({
      slot: p.slot, team: p.team, name: sockName(p.sock),
      score: p.score, moves: p.moves || 0, isBot: !!p.sock.isBot,
    }));

    // 試合開始時に固定した userId で人物を解決する（p.sock.user を見ない）。
    // 終了時点の名乗りで引くと、ゲスト化・別token での戦績回避／付け替えが通る。
    const humanUsers = match.players.map(p =>
      (!p.sock.isBot && p.userId) ? db.users[p.userId] : null);
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
      if (me) {
        if (duel2) {
          const oppUser = humanUsers[1 - p.slot];
          const oppSock = match.players[1 - p.slot].sock;
          const oppRating = oppUser && oppUser.id !== me.id ? preRatings[1 - p.slot]
            : oppSock.isBot && oppSock.rating != null ? oppSock.rating : null;
          if (oppRating != null) {
            const beforeTier = tierOfRating(me.stats.rating);
            ratingDelta = eloUpdate(me.stats.rating, oppRating, outcome);
            me.stats.rating = Math.max(0, me.stats.rating + ratingDelta);
            // レート系称号が下振れで剥がれないよう、到達最高レートを残す。
            me.stats.ratingBest = Math.max(me.stats.ratingBest || 0, me.stats.rating);
            const afterTier = tierOfRating(me.stats.rating);
            if (afterTier !== beforeTier) {
              tierChange = { up: afterTier.min > beforeTier.min, from: beforeTier, to: afterTier };
              // 📈 昇格はゴールド以上で全体アナウンス + 住人が祝う
              if (tierChange.up && afterTier.min >= 1100) {
                broadcastAll({
                  type: 'announce',
                  message: `${afterTier.icon} 「${me.username}」が${afterTier.name}帯に昇格！`,
                  messageEn: `${afterTier.icon} "${me.username}" was promoted to ${afterTier.nameEn}!`,
                  from: '大会運営',
                });
                // tier はオブジェクトで渡す — renderSlot が言語別に name/nameEn を選ぶ
                react('rankup', { you: me.username, tier: afterTier, notName: me.username });
              }
            }
          }
        }
        if (match.rated && match.mode !== 'raid' && !selfPlay) {
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
            // Tournament: the badge/bonus fires only on winning the FINAL.
            // 自己対戦は勝敗を付けない（PvP勝利系ミッション/実績・勝利報酬を稼がせない）。
            won: selfPlay ? false : (match.tourney ? (outcome === 1 && !!match.tourney.final) : outcome === 1),
            drew: selfPlay ? false : outcome === 0.5,
          });
        }
      }
      if (p.forfeited) continue;   // quitter is gone — stats recorded, nothing to send
      send(p.sock, {
        type: 'result',
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
        players: playersInfo,
        ratingDelta, rewards, tierChange, rematchId,
        user: me ? publicUser(me) : null,
      });
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
      send(ws, { type: 'error', error: '🛠 メンテナンス中です。しばらくお待ちください' });
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
  function bestPair(q, now) {
    let best = null;
    for (let i = 0; i < q.length; i++) {
      for (let j = i + 1; j < q.length; j++) {
        // 同一アカウントの2ソケットを組ませない（自己対戦の多重防御）。
        if (q[i].ws.user && q[j].ws.user && q[i].ws.user.id === q[j].ws.user.id) continue;
        const gap = Math.abs(ratingOf(q[i].ws) - ratingOf(q[j].ws));
        const allowed = Math.max(ratingBand(now - q[i].since), ratingBand(now - q[j].since));
        if (gap > allowed) continue;
        if (!best || gap < best.gap) best = { i, j, gap };
      }
    }
    return best;
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
      // Honest, not decorative: this is the actual moment a bot fills the seat.
      botInSec: Math.max(0, Math.round((entry.botAt - Date.now()) / 1000)),
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
    let mode = ['duel', 'team', 'coop', 'land'].includes(s.mode) ? s.mode : (s.team ? 'team' : 'duel');
    if (s.team === true && s.mode === undefined) mode = 'team';
    if (s.team === false && s.mode === undefined) mode = 'duel';
    return {
      duration: DURATIONS.includes(Number(s.duration)) ? Number(s.duration) : MATCH_DURATION,
      mode,
      team: mode === 'team',
      botFill: s.botFill !== false,
      botLevel: ['random', 'easy', 'normal', 'hard', 'oni'].includes(s.botLevel) ? s.botLevel : 'random',
    };
  }
  const roomSeats = room => room.settings.mode === 'team' ? 4 : 2;

  function broadcastRoom(room) {
    for (const ws of room.players) {
      send(ws, {
        type: 'room_update',
        code: room.code,
        settings: room.settings,
        youAreHost: room.players[0] === ws,
        players: room.players.map((p, i) => ({
          name: sockName(p), isHost: i === 0, isYou: p === ws,
        })),
      });
    }
  }

  function leaveRoom(ws, notify = true) {
    const room = roomOf(ws);
    ws.roomCode = null;
    if (!room) return;
    const i = room.players.indexOf(ws);
    if (i !== -1) room.players.splice(i, 1);
    if (room.players.length === 0) rooms.delete(room.code);
    else if (notify) broadcastRoom(room);
  }

  function startRoom(ws) {
    const room = roomOf(ws);
    if (!room) return;
    if (room.players[0] !== ws) { send(ws, { type: 'room_error', error: 'ホストのみ開始できます' }); return; }
    const need = roomSeats(room);
    const coop = room.settings.mode === 'coop';
    const land = room.settings.mode === 'land';
    if (room.players.length > need) {
      send(ws, { type: 'room_error', error: `この設定では最大${need}人です（チーム戦に変更してください）` });
      return;
    }
    if (room.players.length < need && !room.settings.botFill) {
      send(ws, { type: 'room_error', error: `あと${need - room.players.length}人必要です（ボット補充をONにもできます）` });
      return;
    }
    // Humans keep join order: in team mode the first two are team A. Co-op
    // puts everyone on one side of one board.
    const teamOf = i => coop ? 0 : room.settings.team ? (i < 2 ? 0 : 1) : i % 2;
    const entries = room.players.map((p, i) => ({ sock: p, team: teamOf(i) }));
    const used = new Set(room.players.map(p => sockName(p)));
    while (entries.length < need) entries.push({ sock: new Bot(room.settings.botLevel, used), team: teamOf(entries.length) });
    const players = room.players.slice();
    rooms.delete(room.code);
    for (const p of players) p.roomCode = null;
    createMatch({
      mode: coop ? 'coop' : land ? 'land' : room.settings.team ? 'team' : 'duel',
      entries,
      // 陣取りは時間制。部屋で選んだ長さ（60/120/180秒）をそのまま使う。
      duration: coop ? COOP_MAX_SECS : room.settings.duration,
      rated: false,
    });
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
        if (s.isBot) s.level = lv[crypto.randomInt(lv.length)];
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
          const rewards = applyGameResult(cu, {
            trusted: true, mode: 'tournament', won: true, drew: false,
            score: 0, lines: 0, maxCombo: 0, duration: 0, pieces: 0,
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
        message: `🏆 オンライントーナメントで「${sockName(champ)}」が優勝！`,
        messageEn: `🏆 "${sockName(champ)}" wins the online tournament!`,
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
    const entrants = humanSocks.map(ws => ({
      ws, human: true, name: sockName(ws), score: 0, lines: 0, combo: 0,
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
  function royaleAttack(r, from, cells) {
    if (!cells || r.ended) return;
    const others = royaleAlive(r).filter(e => e !== from);
    if (!others.length) return;
    const leader = others.reduce((a, b) => (b.score > a.score ? b : a), others[0]);
    // Bounty rate: at 45% an early leader drew fire from ~99 attackers at once
    // and was reliably buried before halfway — leading has to be dangerous,
    // not fatal. 25% keeps the pressure and leaves the lead survivable.
    const target = (Math.random() < 0.25 && leader !== from) ? leader
      : others[Math.floor(Math.random() * others.length)];
    royaleHit(r, target, cells, from);
  }

  function royaleHit(r, target, cells, from) {
    if (!target || !target.alive) return;
    if (target.human) {
      if (target.ws.readyState === target.ws.OPEN) {
        send(target.ws, { type: 'royale_garbage', cells, from: from ? from.name : null });
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

  function endRoyaleFor(e, r, placement, ranked) {
    if (!e.alive) return;
    e.alive = false;
    e.placement = placement;
    if (!e.human) return;
    const me = e.ws.user ? db.users[e.ws.user.id] : null;
    let rewards = null;
    const payout = royalePayout(placement);
    if (me && e.ws.readyState === e.ws.OPEN) {
      rewards = applyGameResult(me, {
        trusted: true,   // サーバーが順位を決めている（クライアント申告ではない）
        mode: 'royale', score: e.score, lines: e.lines, maxCombo: e.combo,
        pieces: e.pieces || 0,
        duration: Math.max(1, (Date.now() - r.startedAt) / 1000), won: placement === 1,
      });
      // Placement ladder on top of the normal per-run payout.
      me.coins += payout.coins;
      me.gems += payout.gems;
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
      payout,
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
        royaleFeed(r, { kind: 'left', victim: e.name, alive: royaleAlive(r).length });
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
        if (res.lineCount >= 2) royaleAttack(r, e, attackCells(res.lineCount, res.streak));
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
    if (!watching) {
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
      // Only a REAL player's win is world news — a bot taking a lobby that no
      // human survived is not an announcement.
      if (winner && winner.human) {
        broadcastAll({
          type: 'announce',
          message: `💯 バトルロイヤルで「${winner.name}」が100人の頂点に！（${winner.kills || 0}KO）`,
          messageEn: `💯 "${winner.name}" is the last one standing out of 100 in Battle Royale! (${winner.kills || 0} KOs)`,
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
      const leader = ranked[0];
      for (let i = 0; i < r.entrants.length; i++) {
        const e = r.entrants[i];
        if (!e.human || e.ws.readyState !== e.ws.OPEN) continue;
        const rank = e.alive ? ranked.indexOf(e) + 1 : null;
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
          // Spectators watch the leader's board.
          watch: !e.alive && leader ? { name: leader.name, score: Math.floor(leader.score), grid: royaleGridOf(leader) } : null,
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
  // Socket lifecycle
  // -------------------------------------------------------------------------

  wss.on('connection', (ws, req) => {
    const ip = String((req && req.socket && req.socket.remoteAddress) || '?');
    ws._ip = ip;
    if (clients.size >= MAX_SOCKETS) {
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
    // ws emits 'error' for ordinary conditions (ECONNRESET on a phone that
    // walked out of range, a malformed frame, a failed ping). An EventEmitter
    // that emits 'error' with no listener takes the whole process down with
    // it — one flaky connection would have ended every live match.
    ws.on('error', err => console.error('[ws] socket error:', err && err.code ? err.code : '', err && err.message));

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
            send(ws, { type: 'error', error: '🛠 メンテナンス中です。しばらくお待ちください' });
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
            const want = sanitizeName(msg.guestName) || '';
            const taken = want && (
              Object.values(db.users).some(u => u.username.toLowerCase() === want.toLowerCase())
              || reservedName(want)
              || !!residentByName(want)
            );
            ws.guestName = (want && !taken) ? want : `ゲスト${Math.floor(Math.random() * 9999)}`;
            if (want && taken) send(ws, { type: 'error', error: 'その名前は使えません。別の名前になりました' });
          } else {
            ws.guestName = null;
          }
          trackSocket(ws);
          if (user) {
            // 5分に1回だけ書く。毎回書くと接続のたびにディスクを叩く。
            const live = db.users[user.id];
            if (live && Date.now() - (live.lastSeen || 0) > 300_000) { live.lastSeen = Date.now(); saveDb(); }
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
              if (e && e.alive) {
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
              send(e.ws, { type: 'zero_deal_vote', by: sockName(ws), pick: msg.pick, tally: r.tally, human: true });
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
          const wu = ws.user ? db.users[ws.user.id] : null;
          if (wu && wu.muted) {
            send(ws, { type: 'error', error: '🔇 管理者によりチャットが制限されています' });
            return;
          }
          const r = zeroWill(run, sockName(ws), String(msg.text || ''));
          if (r.ok) {
            saveDb();
            send(ws, { type: 'zero_will_ok' });
            // 伝言はその場の全員にも見せる（次の枠の人は開幕で読む）
            broadcastAll({
              type: 'announce',
              message: `📝 ${sockName(ws)} が次の枠へ伝言を残した`,
              messageEn: `📝 ${sockName(ws)} left a message for the next slot`,
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
        case 'zero_leave': {
          zeroSeatOut(ws);
          return;
        }
        case 'royale_topout': {
          if (!ws.royaleId) return;
          const r = royales.get(ws.royaleId);
          if (!r || r.ended) return;
          const e = r.entrants.find(x => x.ws === ws);
          if (e && e.alive) royaleTopOut(r, e, null);
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
          royaleAttack(r, e, rCells);
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
            deliverAttack(match, me.slot, p, cells);
          }
          break;
        }
        case 'rematch': {
          if (!sockRate(ws, 'rmTimes', 6, 10000)) return;
          const offer = rematchOffers.get(String(msg.rematchId || ''));
          if (!offer || offer.until < Date.now()) { send(ws, { type: 'rematch_gone' }); return; }
          // joinQueue と同じガード — ルーム/トーナメント/ロイヤル在籍中の再戦受諾は
          // rooms Map にゴースト部屋を残す（createMatch が roomCode を黙って消すため）
          if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId || ws.zeroId) return;
          const mine = offer.sides.find(sd => sd.sock === ws);
          if (!mine) return;
          mine.ready = true;
          const other = offer.sides.find(sd => sd !== mine);
          if (other.isBot) {
            // ボット相手は即再戦（同じ強さのボットを新しく座らせる）
            rematchOffers.delete(String(msg.rematchId));
            createMatch({ mode: offer.mode, rated: offer.rated, duration: offer.duration, entries: [
              { sock: ws, team: 0 },
              { sock: new Bot(other.level || 'random', new Set([sockName(ws)])), team: 1 },
            ] });
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
          rooms.set(code, { code, players: [ws], settings: cleanSettings(msg.settings) });
          ws.roomCode = code;
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
          if (room.players.length >= roomSeats(room)) { send(ws, { type: 'room_error', error: 'ルームが満員です' }); return; }
          leaveQueues(ws);
          leaveRoom(ws);
          room.players.push(ws);
          ws.roomCode = code;
          broadcastRoom(room);
          break;
        }
        case 'room_set': {
          const room = roomOf(ws);
          if (!room || room.players[0] !== ws) return;
          room.settings = cleanSettings({ ...room.settings, ...msg.settings });
          broadcastRoom(room);
          break;
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
          const u = ws.user ? db.users[ws.user.id] : null;
          if (u && u.muted) {
            send(ws, { type: 'error', error: '🔇 管理者によりチャットが制限されています' });
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
          });
          break;
        }
        case 'react': {
          const emoji = String(msg.emoji || '');
          if (!REACT_EMOJI.includes(emoji)) return;
          // ミュートはリアクションにも効く（モデレーションの抜け穴防止）。
          const ru = ws.user ? db.users[ws.user.id] : null;
          if (ru && ru.muted) return;
          if (!sockRate(ws, 'reactTimes', 12, 10000)) return;
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
        if (live && socketsOf(ws.user.id).length === 0) { live.lastSeen = Date.now(); saveDb(); }
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
            const ranked = royaleRanked(r);
            endRoyaleFor(e, r, ranked.length, ranked);
            royaleFeed(r, { kind: 'left', victim: e.name, alive: ranked.length - 1 });
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
      try { endTourney(t); ended++; } catch { /* 同上 */ }
    }
    // 待ち行列だけ通知なしで捨てていた。SIGTERM 経由なら5秒後に落ちるので
    // 目立たないが、この関数は /api/admin/prepare-update からも呼ばれ、
    // そちらはサーバーが動き続ける。待っていた人は1秒ごとの queued が
    // 止まるだけで「🎯 レート … あと N 秒で AIプレイヤーが参戦します」を
    // 表示したまま凍り、何分待ってもマッチもAI補充も起きなかった。
    for (const q of Object.values(queues)) {
      for (const e of q) {
        send(e.ws, { type: 'queue_cancelled' });
        send(e.ws, { type: 'error', error: '🛠 サーバー更新のためマッチングを中止しました。少し待ってからもう一度お試しください' });
      }
      q.length = 0;
    }
    return ended;
  }

  return {
    clients,
    party,
    presence: { isOnline, statusOf, sendToUser },
    matches, rooms,
    endAllForShutdown,
    queueSize: queueSizeAll,   // all seven queues — duel+team alone under-reported
    displayOnline, displayMatches,
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
          performScript(s.map((x, i) => ({ ...x, delay: i * 2500 })), null);
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
          performScript(s.map(x => ({ ...x, delay: 500 })), null);
          return { lines: s.map(x => `${x.resident.name}: ${x.text}`) };
        }
        if (what === 'reaction') {
          const kind = ctx.event ? 'event_start' : ctx.poll ? 'poll_open' : 'greet_plain';
          const s = composeReaction(kind, ctx, {}, 2);
          performScript(s.map((x, i) => ({ ...x, delay: 500 + i * 2500 })), null);
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
