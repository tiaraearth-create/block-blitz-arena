// 🤝 フレンド（申請・承認・ブロック・通知設定）／🏁 ライバル表／
// 🎉 パーティー（通報と運営の窓口）。
//
// server/index.js から切り出しただけのもので、処理は1文字も変えていない。
// 共有依存は server/context.js 経由で受け取る（index.js → context → ここ）。
import express from 'express';
import crypto from 'crypto';
import {
  saveDb,
} from '../db.js';
import {
  requireAuth,
} from '../auth.js';
import {
  ensureSocial, friendsView, friendRow, sendRequest, acceptRequest, declineRequest, cancelRequest, unfriend, block as blockUser, unblock as unblockUser, rivalBoard, sendChallenge, dismissChallenge, CHALLENGE_COOLDOWN_MS,
} from '../friends.js';
import {
  jstDayKey,
} from '../adminevent.js';
import {
  residentByName, residentStats, activeResidents,
} from '../ambient.js';
import { strHash } from '../residents.js';
import { anonId } from '../sanitize.js';
import { ctx } from '../context.js';

// index.js のモジュールスコープにしか無いもの。値は起動時に一度だけ
// 流し込む（init… は server.listen より前・battle 生成より後に呼ばれる）。
let db, migrateUser, levelOf, fmtNum, curWeek, BUGREPORT_CAP, rateLimit, battleReady, adminLog, userById, battle;
export function initSocialRoutes() {
  ({ db, migrateUser, levelOf, fmtNum, curWeek, BUGREPORT_CAP, rateLimit, battleReady, adminLog, userById, battle } = ctx);
}

// ミドルウェアだけは上の遅延束縛にできない ── ハンドラ本体と違って、
// express は **登録した瞬間** に関数であることを確かめ、undefined なら
// その場で throw する（値が入るのは起動の終盤なので必ず間に合わない）。
// 呼び出しを1枚かぶせて、実体の解決をリクエスト時まで遅らせる。
const maintenanceGuard = (req, res, next) => ctx.maintenanceGuard(req, res, next);

export const socialRouter = express.Router();

// ---------------------------------------------------------------------------
// 以下は server/index.js から移設したもの。`app.get(` などの登録先を
// 上のルーターに差し替えただけで、処理そのものは1文字も変えていない。
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 🤝 フレンド
// ---------------------------------------------------------------------------
// 連絡は必ず申請制。申請に自由文は載せられない（載せられると、申請そのものが
// 嫌がらせの配達手段になる）。断りの文言はどの理由でも同じにしてある ──
// 理由を出し分けると、この窓口が「ブロックされているか」を調べる道具になる。

const friendStatus = () => (battleReady && battle.presence ? battle.presence.statusOf : () => 'offline');

socialRouter.get('/api/friends', requireAuth, (req, res) => {
  migrateUser(req.user);
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

// 名前から探す。住人(AI)と予約名は弾く ── 登録/改名と同じ三段の確認。
// 🎭 住人の「最終ログイン」。住人ごとに決まる値で、1分より細かくは動かない。
//    離席中は 15分前〜約2日前のあいだに散らす（全員が同じ値でそろわないように）。
// 刻みは実プレイヤーに合わせる。server/battle.js の在席更新は
// `Date.now() - live.lastSeen > 300_000` のときだけ書き直すので、実プレイヤーの
// lastSeen も**5分ていどの段**でしか動かない。住人だけ毎秒動くと、
// 同じ名前を2回引くだけで見分けが付く。
const SEEN_STEP = 5 * 60_000;
function residentSeenAt(r, online) {
  const nowStep = Math.floor(Date.now() / SEEN_STEP) * SEEN_STEP;
  if (online) return nowStep;
  // 離席中は住人ごとに決まる過去へ散らす（全員そろって「ぴったり1時間前」に
  // なっていると、それ自体が印になる）。15分〜約48時間前。
  const back = 3 + (strHash(`seen:${r.id}`) % (48 * 12));
  return nowStep - back * SEEN_STEP;
}

socialRouter.post('/api/friends/search', requireAuth, (req, res) => {
  const name = String(req.body.username || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: '名前を入力してください' });
  if (!rateLimit('fsearch:' + req.user.id, 20, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const low = name.toLowerCase();
  const found = Object.values(db.users).find(u => u && u.username.toLowerCase() === low);
  // 🎭 住人（AIプレイヤー）もここに出す。ランキングやチャットには名前が並ぶのに
  // フレンド検索だけ「そんな人は居ない」と返していたので、
  // 「見えているのに探せない名前＝住人」という総当たり判定になっていた。
  //
  // 申請そのものは通らないが、断り方は実プレイヤーとまったく同じ ──
  // friends.js の sendRequest は「知らない id」も「申請を受け取らない設定の人」も
  // 同じ REFUSED を返すので、こちらで何もしなくても文言はそろう。
  if (!found) {
    const r = residentByName(name);
    if (r && r.registered) {
      const st = residentStats(r, Date.now());
      const online = activeResidents().some(x => x.id === r.id);
      return res.json({
        user: {
          // id は不透明（連番の住人idを出さない）。実ユーザーの id と同じ見た目。
          id: anonId(`resident:${r.id}`),
          username: r.name,
          level: st.level,
          badges: (st.badges || []).slice(0, 6),
          title: st.title ? st.title.id : null,
          // 🎭 状態の言葉は statusOf（battle.js）と同じ語彙にそろえる。
          //   実プレイヤーに返るのは 'playing' / 'room' / 'menu' / 'offline' の4つだけで、
          //   'online' は構造的に絶対に出ない値だった ── しかも画面側の STATUS 表
          //   （public/js/friends.js）にその鍵が無いので、住人の行だけ状態欄が
          //   **空文字・無色**で描かれる。APIを見なくても、フレンド検索に名前を
          //   打つだけで住人だと分かってしまう。
          status: online ? 'menu' : 'offline',
          // 🎭 最終ログイン。実プレイヤーの lastSeen は**保存された固定値**なので、
          //   ここで毎回 now から引くと、同じ名前を2回引いただけで値が経過時間ぶん
          //   動く（しかも離席中の住人は全員ぴったり1時間前でそろう）。どちらも
          //   実プレイヤーには起きない形。住人ごとに決まる時刻にして、
          //   1分より細かくは動かさない。
          lastSeen: residentSeenAt(r, online),
        },
        already: false,
        pending: false,
      });
    }
  }
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

socialRouter.post('/api/friends/request', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  if (!rateLimit('freq:' + req.user.id, 10, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  // 🤝 名前でも受ける。
  //    プロフィールカード（対戦カード・ロビー・順位表のどこからでも開く）から
  //    誘えるようにしたが、あちらが握っているのは名前だけで id は持っていない。
  //    id を先に引かせるために窓口をもう1本作ると、その窓口の返事が
  //    「実プレイヤーかどうか」を教えてしまう ── ここで解決するのが安全。
  const target = req.body.userId
    ? userById(req.body.userId)
    : (typeof req.body.username === 'string'
      ? Object.values(db.users).find(u => u.username === req.body.username.slice(0, 20) && !u.banned)
      : null);
  // 知らない id への申請は 409（friends.js の REFUSED と同じ扱い）。404 に
  // していた頃は、住人や退会者を狙ったときだけ状態コードが違い、
  // 「申請を受け取らない設定の実プレイヤー」と見分けがついた。文言は元から
  // 同じなので、そろえるのはステータスだけでよい。
  if (!target) return res.status(409).json({ error: '申請できませんでした' });
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

socialRouter.post('/api/friends/accept', requireAuth, maintenanceGuard, (req, res) => {
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

socialRouter.post('/api/friends/decline', requireAuth, (req, res) => {
  migrateUser(req.user);
  // 断ったことは相手に伝えない。伝えると、断る側が気まずさを負う。
  const r = declineRequest(db, req.user, String(req.body.userId || ''));
  saveDb();
  if (r.error) return res.status(409).json({ error: r.error });
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

socialRouter.post('/api/friends/cancel', requireAuth, (req, res) => {
  migrateUser(req.user);
  cancelRequest(db, req.user, String(req.body.userId || ''));
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

socialRouter.post('/api/friends/remove', requireAuth, (req, res) => {
  migrateUser(req.user);
  unfriend(db, req.user, String(req.body.userId || ''));
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

socialRouter.post('/api/friends/block', requireAuth, (req, res) => {
  migrateUser(req.user);
  const id = String(req.body.userId || '');
  const r = blockUser(db, req.user, id);
  if (r.error) return res.status(409).json({ error: r.error });
  saveDb();
  // 同席したままだと、ブロックが「見えないだけで同じ部屋にいる」になる。
  if (battleReady && battle.party) battle.party.splitOnBlock(req.user.id, id);
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

socialRouter.post('/api/friends/unblock', requireAuth, (req, res) => {
  migrateUser(req.user);
  unblockUser(db, req.user, String(req.body.userId || ''));
  saveDb();
  res.json(friendsView(db, req.user, levelOf, friendStatus()));
});

// 受け取りの設定。既定は「申請は誰からでも／招待はフレンドだけ」。
socialRouter.post('/api/friends/settings', requireAuth, (req, res) => {
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
  const sorted = rows
    .filter(r => valueOf(r) > 0)
    .sort((a, b) => valueOf(b) - valueOf(a));
  // 🏅 **同点は同順位（1,2,2,4）。** 順位を載せずに返していたので、画面は
  //    配列の添字をそのまま順位にしていて、まったく同じ点の2人に金と銀が
  //    割れていた（並び順は内部の都合で決まるので、開き直すと入れ替わる）。
  //    公開ランキングは screens.js の lbRanks で同じ事故を直してある。
  let rank = 0;
  let prevVal = null;
  const rankOfIdx = sorted.map((r, i) => {
    const v = valueOf(r);
    if (prevVal === null || v !== prevVal) { rank = i + 1; prevVal = v; }
    return rank;
  });
  return sorted
    .map((r, i) => ({
      rank: rankOfIdx[i],
      id: r.id, username: r.username, level: r.level, badges: r.badges, title: r.title,
      status: r.status, lastSeen: r.lastSeen, me: r.me,
      value: valueOf(r), score: valueOf(r), rating: r.rating,
      // 🔔 を出してよくなる時刻（送った直後は出さない）。
      cooldownUntil: r.challengedAt ? r.challengedAt + CHALLENGE_COOLDOWN_MS : 0,
    }));
}

socialRouter.get('/api/friends/board', requireAuth, (req, res) => {
  migrateUser(req.user);
  // rivalBoard は challengeOut の期限切れ**だけ**を掃除する（キーを消すのみ）。
  // 掃除が起きなかった読み取りで毎回 saveDb() すると、盤面を開くたびに
  // ディスクへ書き込む無駄になる。掃除前後で件数を比べ、減ったとき＝実際に
  // db を書き換えたときだけ保存する。
  const before = Object.keys(req.user.challengeOut || {}).length;
  const board = rivalBoard(db, req.user, {
    dayKey: jstDayKey(), weekId: curWeek(), levelOf, statusOf: friendStatus(),
  });
  const after = Object.keys(req.user.challengeOut || {}).length;
  if (after !== before) saveDb();
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
socialRouter.post('/api/friends/challenge', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  if (!rateLimit('fchal:' + req.user.id, 10, 60_000)) {
    return res.status(429).json({ error: 'すこし待ってからお試しください' });
  }
  const target = userById(String((req.body || {}).userId || ''));
  // 申請と同じ理由で 409 にそろえる（CH_REFUSED と同じステータス・同じ文言）。
  if (!target) return res.status(409).json({ error: '挑戦状を送れませんでした' });
  migrateUser(target);
  const r = sendChallenge(db, req.user, target.id, jstDayKey());
  if (r.error) return res.status(409).json({ error: r.error });
  saveDb();
  // 相手が今いるなら、その場で知らせる。
  if (battleReady && battle.presence) {
    battle.presence.sendToUser(target.id, {
      type: 'announce',
      message: `${req.user.username} から挑戦状が届きました — 今日のデイリーは ${fmtNum(r.score)}点。同じ盤面・同じピース順です`,
      messageEn: `${req.user.username} challenged you — ${r.score.toLocaleString('en-US')} pts on today's Daily. Same board, same pieces.`,
      from: '運営',
    }, { primaryOnly: true });
  }
  res.json({
    ok: true, day: r.day, score: r.score, cleared: r.cleared,
    cooldownUntil: Date.now() + CHALLENGE_COOLDOWN_MS,
  });
});

// 🔔 届いた挑戦状を消す。
//
// friends.js には dismissChallenge が最初からあったのに、HTTP の口が1本も
// 無かった。しかも `data.challenges` を描く場所が public/js 全体に無く、
// 挑戦状は **どこにも表示されないまま24時間で消えていた** ── 送った側は
// 成功トーストと20時間のクールダウンを消費するので、届いていないことに
// 誰も気づけない。フレンド画面に一覧を出すのと合わせて、この口を開ける。
socialRouter.post('/api/friends/challenge/dismiss', requireAuth, maintenanceGuard, (req, res) => {
  migrateUser(req.user);
  const fromId = String((req.body || {}).userId || '');
  const r = dismissChallenge(db, req.user, fromId);
  if (r.error) return res.status(409).json({ error: r.error });
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 👥 パーティーの通報と、運営の確認
// ---------------------------------------------------------------------------
// 新しい入れ物は作らず、既存の bugreports に kind:'party' で落とす。
// 復元がちゃんと取り込んでくれるし、管理画面もそのまま使える。
socialRouter.post('/api/party/report', requireAuth, (req, res) => {
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

socialRouter.get('/api/mod/parties', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'mod') return res.status(403).json({ error: '権限がありません' });
  if (!battleReady || !battle.party) return res.json({ parties: [] });
  res.json({ parties: battle.party.modList() });   // 人数と合言葉だけ。本文は出さない
});

// 本文を読む窓口。読んだこと自体を記録に残す ── 非公開の会話を運営が
// 見るのなら、その操作も監査できないと約束が片手落ちになる。
socialRouter.get('/api/mod/party/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'mod') return res.status(403).json({ error: '権限がありません' });
  if (!battleReady || !battle.party) return res.status(503).json({ error: 'いまは読めません' });
  const r = battle.party.modRead(String(req.params.id), req.user.username);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json(r);
});

socialRouter.post('/api/mod/party/disband', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'mod') return res.status(403).json({ error: '権限がありません' });
  if (!battleReady || !battle.party) return res.status(503).json({ error: 'いまはできません' });
  const r = battle.party.disband(String(req.body.partyId || ''));
  if (r.error) return res.status(404).json({ error: r.error });
  adminLog(req, 'party_disband', String(req.body.partyId || ''));
  res.json({ ok: true });
});
