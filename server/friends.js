// 🤝 フレンド。
//
// ここは純粋な関数だけ。db を受け取って `{ error: '日本語' }` か `{ ok: true, ... }`
// を返す。socket も HTTP も時計も触らない（guilds.js と同じ作り）。
// そうしておくと、実サーバーを立てずにテストから直接叩ける。
//
// ── 置き場所について ──
// フレンド関係は **user レコードの上** に置いてある。db.friends のような
// 新しいトップレベルの入れ物を作ってはいけない。復元（applyRestore）の
// merge モードが取り込むのは users / revoked / deleted / guilds / news /
// 許可リスト入りの meta / transactions / bugreports だけで、それ以外の
// キーは黙って落ちる。ディスクが飛んだ再デプロイのたびに、
// エラーも警告も無しに全フレンドが消えることになる。
// user レコードなら丸ごとコピーされるので、ただ乗りで生き残る。
//
// ── 同意について ──
// 連絡は必ず申請制。申請に自由文は載せられない（載せられると、
// 申請そのものが嫌がらせの配達手段になる）。
// 断ると送り主には何も伝わらず、7日間は再申請できない。
// 断りの文言はどの理由でも同じにしてある ── 文言が違うと、
// 「ブロックされているかどうか」をこの窓口で調べられてしまう。

export const MAX_FRIENDS = 100;      // 接続/切断のたびに全フレンドへ通知が飛ぶので、上限＝通知の上限
export const MAX_REQ_IN = 20;        // 受け取り側の上限。あふれたら送り主を断る（既存を押し出さない）
export const MAX_REQ_OUT = 20;
export const MAX_BLOCKED = 200;
export const DECLINE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
export const REQ_EXPIRE_MS = 14 * 24 * 3600 * 1000;

// どの理由で断っても同じ文言を返す。ここを理由ごとに分けると、
// この窓口が「あの人にブロックされているか」を調べる道具になる。
const REFUSED = '申請できませんでした';

export function socialDefaults() {
  return { requests: 'all', invites: 'friends' };
}

// user レコードに足りない欄を生やす。migrateUser から呼ばれる。
// ここで「存在しない id を掃除する」ことはしない ── migrateUser は
// publicUser のたびに走るので、毎回全フレンドを走査することになる。
// 掃除は起動時と復元後にまとめてやる（healSocial）。
export function ensureSocial(user) {
  if (!Array.isArray(user.friends)) user.friends = [];
  if (!Array.isArray(user.friendReqIn)) user.friendReqIn = [];
  if (!Array.isArray(user.friendReqOut)) user.friendReqOut = [];
  if (!Array.isArray(user.blocked)) user.blocked = [];
  if (!user.friendDeclines || typeof user.friendDeclines !== 'object') user.friendDeclines = {};
  if (!user.social || typeof user.social !== 'object') user.social = socialDefaults();
  const s = user.social;
  if (!['all', 'none'].includes(s.requests)) s.requests = 'all';
  if (!['friends', 'all', 'none'].includes(s.invites)) s.invites = 'friends';
  if (!Number.isFinite(user.lastSeen)) user.lastSeen = 0;
  return user;
}

export function blocks(a, b) {
  return !!(a && Array.isArray(a.blocked) && a.blocked.includes(b));
}
// どちらか片方でもブロックしていれば、連絡は成立しない。
// 片方向だけ見ていると、ブロックした側が相手から申請を受けられてしまう。
export function eitherBlocks(a, b) {
  return blocks(a, b && b.id) || blocks(b, a && a.id);
}

export function isFriend(a, bId) {
  return !!(a && Array.isArray(a.friends) && a.friends.includes(bId));
}

// ---------------------------------------------------------------------------
// 申請
// ---------------------------------------------------------------------------

export function sendRequest(db, from, toId) {
  if (!from || !toId) return { error: REFUSED };
  if (toId === from.id) return { error: '自分には申請できません' };
  const to = db.users[toId];
  if (!to) return { error: REFUSED };
  ensureSocial(from); ensureSocial(to);

  // 以下、断る理由はすべて同じ文言。理由の出し分けはしない。
  if (eitherBlocks(from, to)) return { error: REFUSED };
  if (to.social.requests === 'none') return { error: REFUSED };
  if (isFriend(from, toId)) return { error: 'すでにフレンドです' };
  if (from.friendReqOut.includes(toId)) return { error: '申請ずみです' };

  // 相手からすでに申請が来ていたら、その場で成立させる（すれ違い防止）
  if (from.friendReqIn.some(r => r.from === toId)) return acceptRequest(db, from, toId);

  const declinedAt = to.friendDeclines[from.id] || 0;
  if (declinedAt && Date.now() - declinedAt < DECLINE_COOLDOWN_MS) return { error: REFUSED };

  if (from.friends.length >= MAX_FRIENDS) return { error: `フレンドは${MAX_FRIENDS}人までです` };
  if (to.friends.length >= MAX_FRIENDS) return { error: REFUSED };
  if (from.friendReqOut.length >= MAX_REQ_OUT) return { error: `申請は同時に${MAX_REQ_OUT}件までです` };
  // 受け取り側があふれている場合は、送り主を断る。
  // 古いものを押し出す作りにすると、大量申請で本物の申請を消せてしまう。
  if (to.friendReqIn.length >= MAX_REQ_IN) return { error: REFUSED };

  from.friendReqOut.push(toId);
  to.friendReqIn.push({ from: from.id, at: Date.now() });
  return { ok: true, to };
}

export function acceptRequest(db, me, fromId) {
  if (!me || !fromId) return { error: '相手が見つかりません' };
  ensureSocial(me);
  const other = db.users[fromId];
  if (!other) { me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId); return { error: '相手が見つかりません' }; }
  ensureSocial(other);
  if (!me.friendReqIn.some(r => r.from === fromId)) return { error: 'その申請はありません' };
  if (eitherBlocks(me, other)) {
    me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId);
    other.friendReqOut = other.friendReqOut.filter(id => id !== me.id);
    return { error: '申請できませんでした' };
  }
  if (me.friends.length >= MAX_FRIENDS) return { error: `フレンドは${MAX_FRIENDS}人までです` };
  if (other.friends.length >= MAX_FRIENDS) return { error: '相手のフレンドがいっぱいです' };

  me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId);
  other.friendReqOut = other.friendReqOut.filter(id => id !== me.id);
  if (!me.friends.includes(fromId)) me.friends.push(fromId);
  if (!other.friends.includes(me.id)) other.friends.push(me.id);
  delete me.friendDeclines[fromId];
  return { ok: true, other };
}

// 断ったことは送り主に伝えない。伝えると、断る側が気まずさを負う。
// かわりに7日間の再申請よけを置く。
export function declineRequest(db, me, fromId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  const had = me.friendReqIn.some(r => r.from === fromId);
  me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId);
  const other = db.users[fromId];
  if (other) { ensureSocial(other); other.friendReqOut = other.friendReqOut.filter(id => id !== me.id); }
  if (!had) return { error: 'その申請はありません' };
  me.friendDeclines[fromId] = Date.now();
  return { ok: true };
}

export function cancelRequest(db, me, toId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  me.friendReqOut = me.friendReqOut.filter(id => id !== toId);
  const other = db.users[toId];
  if (other) { ensureSocial(other); other.friendReqIn = other.friendReqIn.filter(r => r.from !== me.id); }
  return { ok: true };
}

export function unfriend(db, me, otherId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  me.friends = me.friends.filter(id => id !== otherId);
  const other = db.users[otherId];
  if (other) { ensureSocial(other); other.friends = other.friends.filter(id => id !== me.id); }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ブロック
// ---------------------------------------------------------------------------
// 片方向。相手には一切見えない。ブロックすると、フレンド関係も
// 申請も同時に切れる（残しておくと通知経路として生き残ってしまう）。
export function block(db, me, otherId) {
  if (!me || !otherId) return { error: '相手が見つかりません' };
  if (otherId === me.id) return { error: '自分はブロックできません' };
  ensureSocial(me);
  if (me.blocked.length >= MAX_BLOCKED) return { error: `ブロックは${MAX_BLOCKED}人までです` };
  if (!me.blocked.includes(otherId)) me.blocked.push(otherId);
  unfriend(db, me, otherId);
  me.friendReqIn = me.friendReqIn.filter(r => r.from !== otherId);
  me.friendReqOut = me.friendReqOut.filter(id => id !== otherId);
  const other = db.users[otherId];
  if (other) {
    ensureSocial(other);
    other.friendReqIn = other.friendReqIn.filter(r => r.from !== me.id);
    other.friendReqOut = other.friendReqOut.filter(id => id !== me.id);
  }
  return { ok: true };
}

export function unblock(db, me, otherId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  me.blocked = me.blocked.filter(id => id !== otherId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// アカウント削除
// ---------------------------------------------------------------------------
// ギルドで一度やらかしている ── 所有者を消したらギルドが誰にも触れなく
// なった。同じことを繰り返さないために、レコードが消える直前に必ず呼ぶ。
// 相手側に残った id は、二度と本人が現れないので永久に宙に浮く。
export function unfriendAll(db, user) {
  if (!user) return 0;
  let n = 0;
  for (const u of Object.values(db.users || {})) {
    if (!u || u.id === user.id) continue;
    if (Array.isArray(u.friends) && u.friends.includes(user.id)) { u.friends = u.friends.filter(id => id !== user.id); n++; }
    if (Array.isArray(u.friendReqOut)) u.friendReqOut = u.friendReqOut.filter(id => id !== user.id);
    if (Array.isArray(u.friendReqIn)) u.friendReqIn = u.friendReqIn.filter(r => r && r.from !== user.id);
    if (Array.isArray(u.blocked)) u.blocked = u.blocked.filter(id => id !== user.id);
    if (u.friendDeclines && typeof u.friendDeclines === 'object') delete u.friendDeclines[user.id];
  }
  return n;
}

// ---------------------------------------------------------------------------
// 掃除（起動時・復元後にまとめて）
// ---------------------------------------------------------------------------
// migrateUser には置かない。あれは publicUser のたびに走るので、
// 毎回全フレンドを走査することになる。
export function healSocial(db) {
  const alive = id => !!db.users[id];
  const gone = new Set(Array.isArray(db.deleted) ? db.deleted.map(d => d && d.id).filter(Boolean) : []);
  const now = Date.now();
  const fixed = { friends: 0, requests: 0, blocked: 0, declines: 0, oneWay: 0 };

  for (const u of Object.values(db.users || {})) {
    if (!u) continue;
    ensureSocial(u);
    const before = u.friends.length;
    u.friends = u.friends.filter(id => alive(id) && !gone.has(id));
    fixed.friends += before - u.friends.length;

    const rb = u.friendReqIn.length;
    u.friendReqIn = u.friendReqIn.filter(r =>
      r && alive(r.from) && !gone.has(r.from) && (now - (r.at || 0)) < REQ_EXPIRE_MS);
    fixed.requests += rb - u.friendReqIn.length;
    u.friendReqOut = u.friendReqOut.filter(id => alive(id) && !gone.has(id));

    const bb = u.blocked.length;
    u.blocked = u.blocked.filter(id => alive(id) && !gone.has(id));
    fixed.blocked += bb - u.blocked.length;

    for (const [id, at] of Object.entries(u.friendDeclines)) {
      if (!alive(id) || now - at > DECLINE_COOLDOWN_MS) { delete u.friendDeclines[id]; fixed.declines++; }
    }
  }

  // 片側だけ残った関係を両側から落とす。ブロックしている相手との
  // フレンド関係も切る（復元でどちらか片方だけが巻き戻ることがある）。
  for (const u of Object.values(db.users || {})) {
    if (!u) continue;
    u.friends = u.friends.filter(id => {
      const o = db.users[id];
      if (!o || !Array.isArray(o.friends) || !o.friends.includes(u.id)) { fixed.oneWay++; return false; }
      if (blocks(u, id) || blocks(o, u.id)) { fixed.oneWay++; return false; }
      return true;
    });
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// 画面に渡す形
// ---------------------------------------------------------------------------
// publicUser は財布も stats も丸ごと入っているので、他人の行には絶対に使わない。
// ランキングの行と同じ範囲だけを出す。
export function friendRow(db, id, levelOf, statusOf) {
  const u = db.users[id];
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    level: levelOf ? levelOf(u.xp || 0) : 1,
    badges: (u.badges || []).slice(0, 6),
    title: u.equippedTitle || null,
    status: statusOf ? statusOf(u.id) : 'offline',
    lastSeen: u.lastSeen || 0,
  };
}

export function friendsView(db, user, levelOf, statusOf) {
  ensureSocial(user);
  return {
    friends: user.friends.map(id => friendRow(db, id, levelOf, statusOf)).filter(Boolean),
    incoming: user.friendReqIn
      .map(r => { const row = friendRow(db, r.from, levelOf, statusOf); return row ? { ...row, at: r.at } : null; })
      .filter(Boolean),
    outgoing: user.friendReqOut.map(id => friendRow(db, id, levelOf, statusOf)).filter(Boolean),
    blocked: user.blocked.map(id => {
      const u = db.users[id];
      return u ? { id: u.id, username: u.username } : null;
    }).filter(Boolean),
    social: { ...user.social },
    limits: { friends: MAX_FRIENDS, requests: MAX_REQ_OUT },
  };
}
