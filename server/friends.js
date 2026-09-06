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

// 🔔 挑戦状。申請と同じで、自由文は載せられない（定型のみ）。
// 送れるのはフレンドだけ ── 見知らぬ相手に飛ばせると、
// 「フレンド申請」を経由しない二本目の配達経路ができてしまう。
export const MAX_CHALLENGE_IN = 20;                        // 受信上限。あふれたら送り主を断る
export const CHALLENGE_COOLDOWN_MS = 20 * 3600 * 1000;     // 同じ相手へは実質1日1回
export const CHALLENGE_EXPIRE_MS = 24 * 3600 * 1000;       // 「今日の記録」への挑戦なので1日で腐る
export const MAX_CHALLENGE_MEMO = 200;                     // 送信控え（クールダウン用）の上限

// どの理由で断っても同じ文言を返す。ここを理由ごとに分けると、
// この窓口が「あの人にブロックされているか」を調べる道具になる。
const REFUSED = '申請できませんでした';
// 挑戦状も同じ考え方 ── 断る理由（ブロック／受け取り拒否／満杯）は出し分けない。
const CH_REFUSED = '挑戦状を送れませんでした';

// db.users を素の添字で引くと '__proto__' や 'constructor' が
// Object.prototype 由来の値を返してしまう（実在しない相手が「いる」ことになる）。
// 引くときは必ずこれを通す。index.js の userById と同じ理屈。
function userOf(db, id) {
  const key = String(id == null ? '' : id);
  return Object.prototype.hasOwnProperty.call(db.users || {}, key) ? db.users[key] : null;
}

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
  // 🔔 挑戦状も user レコードの上に置く（新しいトップレベルの入れ物を作らない ──
  // 復元の merge が拾うのは users なので、ここに置けばただ乗りで生き残る）。
  if (!Array.isArray(user.challengeIn)) user.challengeIn = [];
  if (!user.challengeOut || typeof user.challengeOut !== 'object' || Array.isArray(user.challengeOut)) user.challengeOut = {};
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
// ⏳ 「その人あての申請が、相手の受信箱で**まだ生きている**か」。
//    送信控え（friendReqOut）は id だけで時刻を持たないので、期限は相手側の
//    受信箱でしか測れない。sendRequest と friendsView の両方がこれを使う。
export function liveReqTo(to, fromId) {
  if (!to || !Array.isArray(to.friendReqIn)) return false;
  return to.friendReqIn.some(r => r && r.from === fromId && Date.now() - (r.at || 0) < REQ_EXPIRE_MS);
}

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
  const to = userOf(db, toId);
  if (!to) return { error: REFUSED };
  ensureSocial(from); ensureSocial(to);

  // ===========================================================================
  // ① 自分側の事情だけで決まる断り ── ここは文言を出し分けてよい
  // ===========================================================================
  // 「相手が誰か」に一切依存しないので、詳しい理由を返しても何も漏れない。
  //
  // ⚠ **必ず相手側の判定より前に置くこと。** すぐ下の注意書きは元からここに
  //   書いてあったのに、実装は逆順（ブロック・受け取り拒否・断りの冷却が先、
  //   自分の上限があと）だった。そのせいで、送信枠を満杯にしてから送るだけで
  //     ・ブロックされている → 一律の REFUSED
  //     ・されていない       → 「申請は同時に20件までです」
  //   と文言が割れ、**相手にブロックされたか／断られたかを1件ずつ調べられた**。
  //   ブロックも断りも「相手に気づかれない」ことが前提の機能なので、
  //   このファイルが冒頭で掲げている2つの約束がここで破れていた。
  if (isFriend(from, toId)) return { error: 'すでにフレンドです' };
  // ⏳ 送信控え（friendReqOut）は id の配列だけで時刻を持たないので、
  //    期限（REQ_EXPIRE_MS）は受信側でしか効いていなかった。相手の受信箱では
  //    とっくに腐っている申請が、送った側では永久に「申請ずみです」で居座り、
  //    **同じ人へ二度と申請できない**（掃除するのは起動時の healSocial だけ）。
  //    相手の受信箱に生きた行が無ければ、その控えは無かったことにして先へ進む。
  if (from.friendReqOut.includes(toId)) {
    if (liveReqTo(to, from.id)) return { error: '申請ずみです' };
    from.friendReqOut = from.friendReqOut.filter(id => id !== toId);
  }

  // すれ違い（相手からも申請が来ていた）はその場で成立させる。
  // ここに置けるのは「自分の受信箱に相手からの申請がある」＝自分側の事実で、
  // しかも送信枠を消費しないから（枠の上限より前に見てよい）。
  // 送り主はその申請が自分の受信箱にあることを既に知っているので、
  // ここで分岐しても新しい情報は漏れない。
  // 呼び出し側が「申請が届いた」ではなく「フレンドになった」を送れるよう、
  // 成立したことが分かる印を付けて返す。
  // ⏳ 期限切れ(REQ_EXPIRE_MS超)の申請は「無い」ものとして扱う。
  //    見ていなかったので、相手からの14日超の申請が受信箱に残っていると
  //    この枝に入り、acceptRequest が期限切れを検出して
  //    `{error:'その申請はありません'}` を返す ── 何も送られないまま
  //    1回目だけ失敗し、2回目は（掃除されたので）通る、という形だった。
  if (from.friendReqIn.some(r => r.from === toId && Date.now() - (r.at || 0) < REQ_EXPIRE_MS)) {
    if (eitherBlocks(from, to)) return { error: REFUSED };
    const r = acceptRequest(db, from, toId);
    return r.error ? r : { ...r, accepted: true };
  }

  if (from.friends.length >= MAX_FRIENDS) return { error: `フレンドは${MAX_FRIENDS}人までです` };
  if (from.friendReqOut.length >= MAX_REQ_OUT) return { error: `申請は同時に${MAX_REQ_OUT}件までです` };

  // ===========================================================================
  // ② 相手側の事情による断り ── ここから先はすべて同じ文言（REFUSED）
  // ===========================================================================
  if (eitherBlocks(from, to)) return { error: REFUSED };
  if (to.social.requests === 'none') return { error: REFUSED };
  const declinedAt = to.friendDeclines[from.id] || 0;
  if (declinedAt && Date.now() - declinedAt < DECLINE_COOLDOWN_MS) return { error: REFUSED };
  if (to.friends.length >= MAX_FRIENDS) return { error: REFUSED };
  // 期限切れ(REQ_EXPIRE_MS超)の申請は受信枠に数えない。定期実行が無く healSocial は
  // 起動/復元時しか走らないので、送信のたびにここで自然に掃除する（さもないと古い申請
  // MAX_REQ_IN件で受信箱が塞がり、本物の新規申請が REFUSED され続ける）。
  to.friendReqIn = to.friendReqIn.filter(r => r && Date.now() - (r.at || 0) < REQ_EXPIRE_MS);
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
  const other = userOf(db, fromId);
  if (!other) { me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId); return { error: '相手が見つかりません' }; }
  ensureSocial(other);
  const req = me.friendReqIn.find(r => r.from === fromId);
  // 期限切れ(REQ_EXPIRE_MS超)の申請は「無い」ものとして扱い、両側から掃除する。
  // healSocial が起動/復元時にしか走らないため、ここで見ないと期限切れを承認できてしまう。
  if (!req || Date.now() - (req.at || 0) >= REQ_EXPIRE_MS) {
    if (req) {
      me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId);
      other.friendReqOut = other.friendReqOut.filter(id => id !== me.id);
    }
    return { error: 'その申請はありません' };
  }
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
  // ⏳ 期限切れ(14日超)は「無い」ものとして扱う。掃除はするが、7日ロックは
  //    刻まない ── 期限切れの行を断っただけで、相手が7日間再申請できなく
  //    なるのはおかしい（acceptRequest 側は既に期限を見て断っている）。
  const had = me.friendReqIn.some(r => r.from === fromId
    && Date.now() - (r.at || 0) < REQ_EXPIRE_MS);
  me.friendReqIn = me.friendReqIn.filter(r => r.from !== fromId);
  const other = userOf(db, fromId);
  if (other) { ensureSocial(other); other.friendReqOut = other.friendReqOut.filter(id => id !== me.id); }
  if (!had) return { error: 'その申請はありません' };
  me.friendDeclines[fromId] = Date.now();
  return { ok: true };
}

export function cancelRequest(db, me, toId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  me.friendReqOut = me.friendReqOut.filter(id => id !== toId);
  const other = userOf(db, toId);
  if (other) { ensureSocial(other); other.friendReqIn = other.friendReqIn.filter(r => r.from !== me.id); }
  return { ok: true };
}

export function unfriend(db, me, otherId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  me.friends = me.friends.filter(id => id !== otherId);
  // 挑戦状はフレンド同士でしか送れない。関係が切れたら両側の受信箱から消す ──
  // 残すと「フレンドを外したのに 🔔 だけ届き続ける」経路になる。
  me.challengeIn = me.challengeIn.filter(c => c && c.from !== otherId);
  const other = userOf(db, otherId);
  if (other) {
    ensureSocial(other);
    other.friends = other.friends.filter(id => id !== me.id);
    other.challengeIn = other.challengeIn.filter(c => c && c.from !== me.id);
  }
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
  // 実在しない id は受け取らない。受け取ると自分のブロック欄に
  // 意味のない文字列が溜まり、上限(200)を無駄に食う。
  if (!userOf(db, otherId)) return { error: '相手が見つかりません' };
  ensureSocial(me);
  if (me.blocked.length >= MAX_BLOCKED) return { error: `ブロックは${MAX_BLOCKED}人までです` };
  if (!me.blocked.includes(otherId)) me.blocked.push(otherId);
  unfriend(db, me, otherId);
  me.friendReqIn = me.friendReqIn.filter(r => r.from !== otherId);
  me.friendReqOut = me.friendReqOut.filter(id => id !== otherId);
  const other = userOf(db, otherId);
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
    if (Array.isArray(u.challengeIn)) u.challengeIn = u.challengeIn.filter(c => c && c.from !== user.id);
    if (u.challengeOut && typeof u.challengeOut === 'object') delete u.challengeOut[user.id];
  }
  return n;
}

// ---------------------------------------------------------------------------
// 掃除（起動時・復元後にまとめて）
// ---------------------------------------------------------------------------
// migrateUser には置かない。あれは publicUser のたびに走るので、
// 毎回全フレンドを走査することになる。
export function healSocial(db) {
  const alive = id => !!userOf(db, id);
  // db.deleted は { userId: 消した時刻 } の形。配列だと思って map していたので、
  // この番人はこれまで一度も働いていなかった。
  const gone = new Set(db.deleted && typeof db.deleted === 'object' && !Array.isArray(db.deleted)
    ? Object.keys(db.deleted)
    : (Array.isArray(db.deleted) ? db.deleted.map(d => (d && d.id) || d).filter(Boolean) : []));
  const now = Date.now();
  const fixed = { friends: 0, requests: 0, blocked: 0, declines: 0, oneWay: 0, challenges: 0 };

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
    const ob = u.friendReqOut.length;
    u.friendReqOut = u.friendReqOut.filter(id => alive(id) && !gone.has(id));
    fixed.requests += ob - u.friendReqOut.length;

    const bb = u.blocked.length;
    u.blocked = u.blocked.filter(id => alive(id) && !gone.has(id));
    fixed.blocked += bb - u.blocked.length;

    for (const [id, at] of Object.entries(u.friendDeclines)) {
      if (!alive(id) || now - at > DECLINE_COOLDOWN_MS) { delete u.friendDeclines[id]; fixed.declines++; }
    }

    // 🔔 期限切れ・送り主が消えた挑戦状を落とす。フレンドかどうかの照合は
    // 片側だけの関係が残っている段階だと誤爆するので、下の片側掃除のあとでやる。
    const cb = u.challengeIn.length;
    u.challengeIn = u.challengeIn.filter(c =>
      c && alive(c.from) && !gone.has(c.from) && (now - (c.at || 0)) < CHALLENGE_EXPIRE_MS);
    fixed.challenges += cb - u.challengeIn.length;
    for (const [id, at] of Object.entries(u.challengeOut)) {
      if (!alive(id) || gone.has(id) || !(now - at < CHALLENGE_COOLDOWN_MS)) delete u.challengeOut[id];
    }
  }

  // 送った申請は相手側が期限切れで消えても残り続けるので、
  // 「相手の受信箱に無い送信控え」を落とす。放っておくと
  // 申請枠(20件)が幽霊で埋まって、本当の申請が送れなくなる。
  for (const u of Object.values(db.users || {})) {
    if (!u) continue;
    const ob = u.friendReqOut.length;
    u.friendReqOut = u.friendReqOut.filter(id => {
      const o = userOf(db, id);
      return o && Array.isArray(o.friendReqIn) && o.friendReqIn.some(r => r && r.from === u.id);
    });
    fixed.requests += ob - u.friendReqOut.length;
  }

  // 片側だけ残った関係を両側から落とす。ブロックしている相手との
  // フレンド関係も切る（復元でどちらか片方だけが巻き戻ることがある）。
  for (const u of Object.values(db.users || {})) {
    if (!u) continue;
    u.friends = u.friends.filter(id => {
      const o = userOf(db, id);
      if (!o || !Array.isArray(o.friends) || !o.friends.includes(u.id)) { fixed.oneWay++; return false; }
      if (blocks(u, id) || blocks(o, u.id)) { fixed.oneWay++; return false; }
      return true;
    });
  }

  // フレンド関係が確定したあとで、フレンドでない相手からの挑戦状を落とす。
  // （ブロック済み・関係が切れた相手が 🔔 だけ届け続けるのを防ぐ）
  for (const u of Object.values(db.users || {})) {
    if (!u) continue;
    const cb = u.challengeIn.length;
    u.challengeIn = u.challengeIn.filter(c => c && u.friends.includes(c.from));
    fixed.challenges += cb - u.challengeIn.length;
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// 画面に渡す形
// ---------------------------------------------------------------------------
// publicUser は財布も stats も丸ごと入っているので、他人の行には絶対に使わない。
// ランキングの行と同じ範囲だけを出す。
export function friendRow(db, id, levelOf, statusOf) {
  const u = userOf(db, id);
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
    // ⏳ 期限切れ(14日超)は受信箱に出さない。
    //    acceptRequest は期限を見て断るのに、この一覧は見ていなかったので、
    //    「承認」だけが必ず赤トースト『その申請はありません』になり、
    //    「ことわる」は成功して friendDeclines を刻む ── 相手はその後
    //    **7日間**再申請できなくなる。承認は壊れているのに拒否だけ効いて
    //    相手を締め出す、という最悪の組み合わせだった。通知ドットの件数も
    //    ここを数えているので、まとめて直る。
    incoming: user.friendReqIn
      .filter(r => r && Date.now() - (r.at || 0) < REQ_EXPIRE_MS)
      .map(r => { const row = friendRow(db, r.from, levelOf, statusOf); return row ? { ...row, at: r.at } : null; })
      .filter(Boolean),
    // ⏳ 相手の受信箱で生きている申請だけを「送った申請」として出す。
    //    腐った控えを出していたので、画面には「申請ずみ」と並ぶのに相手には
    //    届いていない、という行が永久に残っていた（sendRequest 側と同じ判定）。
    outgoing: user.friendReqOut
      .filter(id => liveReqTo(userOf(db, id), user.id))
      .map(id => friendRow(db, id, levelOf, statusOf)).filter(Boolean),
    blocked: user.blocked.map(id => {
      const u = userOf(db, id);
      return u ? { id: u.id, username: u.username } : null;
    }).filter(Boolean),
    social: { ...user.social },
    // 🔔 届いている挑戦状。既存の画面が毎回叩く窓口に相乗りさせておくと、
    // 新しいポーリングを増やさずに済む。
    challenges: challengesView(db, user, levelOf, statusOf),
    limits: { friends: MAX_FRIENDS, requests: MAX_REQ_OUT, challenges: MAX_CHALLENGE_IN },
  };
}

// ---------------------------------------------------------------------------
// 🔔 挑戦状
// ---------------------------------------------------------------------------
// 「今日のデイリーの記録に挑戦してほしい」の定型だけ。自由文は載せられない
// （載せられると、挑戦状そのものが嫌がらせの配達手段になる ── 申請と同じ理屈）。
//
// 送り主が申告した点数は一切信じない。挑戦状に載る点数は、送信の瞬間に
// サーバーが送り主の stats.dailyc から読み直したものだけ。

// 期限切れは「掃除が走ったかどうか」に頼らず、触った時点で必ず落とす
// （healSocial は起動/復元時にしか走らない）。
function liveChallenges(user, now = Date.now()) {
  return (user.challengeIn || []).filter(c => c && (now - (c.at || 0)) < CHALLENGE_EXPIRE_MS);
}

// 送信控え（クールダウン用）。期限切れを落としつつ、上限を越えたら古い順に捨てる。
function pruneChallengeOut(user, now = Date.now()) {
  const out = user.challengeOut;
  for (const [id, at] of Object.entries(out)) {
    if (!Number.isFinite(at) || !(now - at < CHALLENGE_COOLDOWN_MS)) delete out[id];
  }
  const keys = Object.keys(out);
  if (keys.length > MAX_CHALLENGE_MEMO) {
    keys.sort((a, b) => out[a] - out[b]);
    for (const id of keys.slice(0, keys.length - MAX_CHALLENGE_MEMO)) delete out[id];
  }
}

// その日のデイリー記録（dayKey が一致するときだけ）。既存の stats を読むだけで、
// 新しい保存は増やさない。
export function dailyRecordOf(user, dayKey) {
  const d = user && user.stats && user.stats.dailyc;
  if (!d || !dayKey || d.day !== dayKey) return null;
  return { score: Number(d.score) || 0, cleared: !!d.cleared, streak: Number(d.streak) || 0 };
}

// 今週のウィークリーのベスト（週が変わっていれば 0）。
export function weeklyBestOf(user, weekId) {
  const w = user && user.stats && user.stats.weekly;
  if (!w || !weekId || w.week !== weekId) return 0;
  return Number(w.best) || 0;
}

function ratingOf(user) {
  const r = user && user.stats && user.stats.rating;
  return Number.isFinite(r) ? r : 0;
}

// 挑戦状を送る。dayKey は index.js（jstDayKey）から渡してもらう ──
// ここは時計の都合（JSTの日境界）を知らないままにしておきたい。
export function sendChallenge(db, from, toId, dayKey) {
  if (!from || !toId || !dayKey) return { error: CH_REFUSED };
  if (toId === from.id) return { error: '自分には送れません' };
  const to = userOf(db, toId);
  if (!to) return { error: CH_REFUSED };
  ensureSocial(from); ensureSocial(to);

  // 送り主側の事情（記録がない・クールダウン）は先に見る。相手側の事情より
  // 後ろに置くと、文言の違いから「ブロックされているか」を読み取れてしまう。
  const mine = dailyRecordOf(from, dayKey);
  if (!mine || mine.score <= 0) return { error: '今日のデイリーチャレンジの記録がまだありません' };

  const now = Date.now();
  pruneChallengeOut(from, now);
  if (from.challengeOut[toId] && now - from.challengeOut[toId] < CHALLENGE_COOLDOWN_MS) {
    return { error: 'この相手にはもう送っています' };
  }

  // 以下、断る理由はすべて同じ文言。
  if (eitherBlocks(from, to)) return { error: CH_REFUSED };
  if (!isFriend(from, toId) || !isFriend(to, from.id)) return { error: CH_REFUSED };
  // 受け取りの設定に相乗りする（新しい設定は増やさない）。フレンド同士なので
  // 'friends' は通り、'none' だけが断る。
  if (to.social.invites === 'none') return { error: CH_REFUSED };

  // 期限切れは受信枠に数えない（古い挑戦状で受信箱が塞がると、本物が届かない）。
  to.challengeIn = liveChallenges(to, now);
  // 同じ送り主の古いぶんは上書きする（列に二重で並ばせない）。
  to.challengeIn = to.challengeIn.filter(c => c.from !== from.id);
  // あふれている相手には送れない。古いものを押し出す作りにすると、
  // 連投で本物の挑戦状を消せてしまう。
  if (to.challengeIn.length >= MAX_CHALLENGE_IN) return { error: CH_REFUSED };

  // 点数は必ずサーバーが読み直したものを載せる（申告は受け取らない）。
  to.challengeIn.push({ from: from.id, at: now, day: dayKey, score: mine.score, cleared: mine.cleared });
  from.challengeOut[toId] = now;
  return { ok: true, to, day: dayKey, score: mine.score, cleared: mine.cleared };
}

// 見た／断った。どちらも送り主には何も伝えない（申請の断りと同じ作法）。
export function dismissChallenge(db, me, fromId) {
  if (!me) return { error: '相手が見つかりません' };
  ensureSocial(me);
  const now = Date.now();
  const live = liveChallenges(me, now);
  const had = live.some(c => c.from === fromId);
  me.challengeIn = live.filter(c => c.from !== fromId);
  if (!had) return { error: 'その挑戦状はありません' };
  return { ok: true };
}

// 画面に渡す形。publicUser は使わない（財布も stats も丸ごと入っている）。
export function challengesView(db, user, levelOf, statusOf) {
  ensureSocial(user);
  const now = Date.now();
  user.challengeIn = liveChallenges(user, now);
  return user.challengeIn.map(c => {
    const row = friendRow(db, c.from, levelOf, statusOf);
    return row ? { ...row, at: c.at, day: c.day || '', score: Number(c.score) || 0, cleared: !!c.cleared } : null;
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 🏁 ライバルボード
// ---------------------------------------------------------------------------
// フレンド＋自分の「今日のデイリー」「今週のウィークリーのbest」「レート」を
// 並べるだけ。読むのは既存の stats（dailyc / weekly / rating）で、
// 新しい保存はひとつも増やさない。
//
// opts: { dayKey, weekId, levelOf, statusOf }
export function rivalBoard(db, user, opts = {}) {
  ensureSocial(user);
  const dayKey = String(opts.dayKey || '');
  const weekId = String(opts.weekId || '');
  const { levelOf, statusOf } = opts;
  const now = Date.now();
  pruneChallengeOut(user, now);

  const rows = [];
  const seen = new Set();
  for (const id of [user.id, ...user.friends]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = friendRow(db, id, levelOf, statusOf);
    if (!row) continue;
    const u = userOf(db, id);
    const d = dailyRecordOf(u, dayKey);
    rows.push({
      ...row,
      me: id === user.id,
      daily: d ? d.score : 0,
      dailyPlayed: !!d,
      dailyCleared: d ? d.cleared : false,
      dailyStreak: d ? d.streak : 0,
      weeklyBest: weeklyBestOf(u, weekId),
      rating: ratingOf(u),
      // 🔔 を出してよい相手か（自分・すでに送った相手には出さない）。
      challengedAt: id === user.id ? 0 : (user.challengeOut[id] || 0),
    });
  }

  // 同点は同順位（競技順位）。0点の人は順位を付けない ── 未挑戦の人が
  // 「最下位」として並ぶと、遊んでいないことが晒される形になる。
  for (const [key, rankKey] of [['daily', 'rankDaily'], ['weeklyBest', 'rankWeekly'], ['rating', 'rankRating']]) {
    const ranked = rows.filter(r => (r[key] || 0) > 0).sort((a, b) => (b[key] || 0) - (a[key] || 0));
    let last = null, lastRank = 0;
    ranked.forEach((r, i) => {
      if (last !== null && r[key] === last) r[rankKey] = lastRank;
      else { r[rankKey] = i + 1; lastRank = i + 1; last = r[key]; }
    });
    for (const r of rows) if (r[rankKey] == null) r[rankKey] = null;
  }

  const me = rows.find(r => r.me) || null;
  return {
    day: dayKey,
    week: weekId,
    rows,
    me,
    canChallenge: !!(me && me.daily > 0),   // 自分の記録が無いと挑戦状は送れない
    limits: { friends: MAX_FRIENDS, challenges: MAX_CHALLENGE_IN },
  };
}

// 📅 デイリー提出で「フレンドを追い抜いた」相手を洗い出す。
// 通知そのものは index.js が送る（ここは socket を触らない）。
// prevScore は提出前の自分のその日の点数（未挑戦なら 0）。
export function friendsOvertaken(db, user, dayKey, newScore, prevScore = 0) {
  if (!user || !dayKey) return [];
  ensureSocial(user);
  const score = Number(newScore) || 0;
  const prev = Number(prevScore) || 0;
  if (score <= 0 || score <= prev) return [];
  const out = [];
  for (const id of user.friends) {
    const u = userOf(db, id);
    if (!u || eitherBlocks(user, u)) continue;
    const d = dailyRecordOf(u, dayKey);
    if (!d || d.score <= 0) continue;
    // 今回の提出ではじめて追い越した相手だけ（前回すでに上だった相手は除く）。
    if (d.score <= prev) continue;
    if (d.score >= score) continue;
    out.push({ user: u, score: d.score });
  }
  // 抜いた相手が多いときのために、僅差の順（すぐ下）から並べる。
  out.sort((a, b) => b.score - a.score);
  return out;
}
