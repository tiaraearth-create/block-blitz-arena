// 👥 パーティー & パーティーチャット。
//
// ── 保存しない ──
// パーティーはメモリの上だけに置く。db.parties を作っても意味がない:
// ディスクが飛んだ再デプロイを埋め戻すのは手で作った seed-backup.json
// なので、直前にできたパーティーはそもそも入っていないし、入っていたら
// いたで「誰も居ないパーティー」が復活するだけ。
// かわりに画面側が直前のメンバーを localStorage に覚えていて、
// ワンタップで組み直せるようにしてある。
//
// ── パーティーは「状態」ではなく「重ね着」 ──
// ws.partyId を対戦中フラグ（matchId/royaleId/…）の仲間に入れてはいけない。
// パーティーはソロにもオンラインにも重ねて着るもので、それがメニュー→ソロ→
// 対戦とついてくる理由。だから所属は **socket ではなく user** に紐づく。
// 対戦から抜けるたびに battle 用の socket は閉じるので、close で所属を
// 落とすとパーティーが点滅し続ける。
//
// ── 誰が入れるか ──
// アカウントのみ。ゲストは名前が毎回変わり、ミュートもブロックも効かないので、
// 4人だけの非公開の場に入れると対処のしようがなくなる。

export const MAX_MEMBERS = 4;          // roomSeats の team と同じ
export const MAX_PARTIES = 100;
export const CHAT_RING = 40;
export const INVITE_TTL_MS = 60_000;
export const OFFLINE_GRACE_MS = 90_000;  // 全 socket が切れてからの猶予
export const PARTY_TTL_MS = 12 * 3600 * 1000;
export const CHAT_MAX = 200;
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // 紛らわしい字を抜いた
export const CODE_LEN = 6;             // 合言葉ルームの4桁より広い（私語が流れる場所なので）

export function createParties(deps) {
  const {
    db, sendToUser, isOnline, statusOf, uuid,
    now = () => Date.now(), rateLimit, adminLog, translateLocal,
  } = deps;

  const parties = new Map();          // partyId -> party
  const partyOfUser = new Map();      // userId -> partyId
  const invites = new Map();          // inviteId -> { partyId, toId, fromId, at }

  const userOf = id => db.users[id] || null;

  function makeCode() {
    for (let tries = 0; tries < 40; tries++) {
      let c = '';
      for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (![...parties.values()].some(p => p.code === c)) return c;
    }
    return null;
  }

  // 送る相手ごとに中身を変える（自分が leader かどうか等）。
  // 名前は送るときに db から読む ── hello の時点の控えを使うと、
  // 改名しても永久に古い名前のままになる。
  function viewFor(p, userId) {
    return {
      type: 'party_state',
      party: {
        id: p.id,
        code: p.code,
        leaderId: p.leaderId,
        youAreLeader: p.leaderId === userId,
        members: p.members.map(m => {
          const u = userOf(m.userId);
          return {
            id: m.userId,
            username: u ? u.username : '???',
            status: statusOf ? statusOf(m.userId) : 'offline',
            offlineAt: m.offlineAt || 0,
          };
        }),
        max: MAX_MEMBERS,
      },
    };
  }

  function broadcast(p, msg) {
    for (const m of p.members) sendToUser(m.userId, msg, { primaryOnly: true });
  }
  function pushState(p) {
    for (const m of p.members) sendToUser(m.userId, viewFor(p, m.userId), { primaryOnly: true });
  }

  function partyOf(userId) {
    const id = partyOfUser.get(userId);
    return id ? parties.get(id) || null : null;
  }

  // ---- 作る / 入る / 出る ------------------------------------------------

  function create(userId) {
    if (partyOf(userId)) return { error: 'すでにパーティーにいます' };
    if (parties.size >= MAX_PARTIES) return { error: 'いまパーティーがいっぱいです。少し待ってください' };
    const code = makeCode();
    if (!code) return { error: 'パーティーを作れませんでした' };
    const p = {
      id: uuid(), code, leaderId: userId,
      members: [{ userId, joinedAt: now(), offlineAt: 0 }],
      chat: [], createdAt: now(), launch: null,
    };
    parties.set(p.id, p);
    partyOfUser.set(userId, p.id);
    pushState(p);
    return { ok: true, party: p };
  }

  function join(userId, code) {
    if (partyOf(userId)) return { error: 'すでにパーティーにいます' };
    const p = [...parties.values()].find(x => x.code === String(code || '').toUpperCase());
    if (!p) return { error: 'そのパーティーは見つかりません' };
    if (p.members.length >= MAX_MEMBERS) return { error: 'パーティーがいっぱいです' };
    const me = userOf(userId);
    // 合言葉が全体チャットに貼られたら、ブロックは合言葉で素通しになる。
    // だから招待だけでなく、合言葉入場でもブロックを見る。
    for (const m of p.members) {
      const o = userOf(m.userId);
      if (!o || !me) continue;
      if ((me.blocked || []).includes(o.id) || (o.blocked || []).includes(me.id)) {
        return { error: 'そのパーティーには参加できません' };
      }
    }
    p.members.push({ userId, joinedAt: now(), offlineAt: 0 });
    partyOfUser.set(userId, p.id);
    pushState(p);
    return { ok: true, party: p };
  }

  function leave(userId) {
    const p = partyOf(userId);
    if (!p) return { error: 'パーティーにいません' };
    // 部屋を作りにいった本人が抜けたら、待ちも畳む。
    // 残しておくと10秒後に「部屋を作れませんでした」が全員に飛ぶ。
    if (p.launch && p.launch.by === userId) p.launch = null;
    p.members = p.members.filter(m => m.userId !== userId);
    partyOfUser.delete(userId);
    sendToUser(userId, { type: 'party_state', party: null }, { primaryOnly: true });
    if (!p.members.length) { parties.delete(p.id); return { ok: true }; }
    // リーダーが抜けたら、いちばん古いメンバーへ明示的に渡す。
    // 「配列の先頭が偉い」にしておくと、並び替えたときに壊れる。
    if (p.leaderId === userId) {
      p.leaderId = p.members.slice().sort((a, b) => a.joinedAt - b.joinedAt)[0].userId;
    }
    pushState(p);
    return { ok: true };
  }

  function kick(leaderId, targetId) {
    const p = partyOf(leaderId);
    if (!p) return { error: 'パーティーにいません' };
    if (p.leaderId !== leaderId) return { error: 'リーダーだけができます' };
    if (targetId === leaderId) return { error: '自分は追い出せません' };
    if (!p.members.some(m => m.userId === targetId)) return { error: 'その人はいません' };
    if (p.launch && p.launch.by === targetId) p.launch = null;
    p.members = p.members.filter(m => m.userId !== targetId);
    partyOfUser.delete(targetId);
    sendToUser(targetId, { type: 'party_state', party: null }, { primaryOnly: true });
    sendToUser(targetId, { type: 'party_error', error: 'パーティーから外れました' }, { primaryOnly: true });
    pushState(p);
    return { ok: true };
  }

  // ブロックした瞬間に同席していたら、その場で切り離す。
  // 残しておくと、ブロックが「見えないだけで同じ部屋にいる」になる。
  function splitOnBlock(aId, bId) {
    const p = partyOf(aId);
    if (!p || !p.members.some(m => m.userId === bId)) return false;
    // ブロックした側がリーダーなら相手を外す。そうでなければ自分が出る。
    if (p.leaderId === aId) kick(aId, bId);
    else leave(aId);
    return true;
  }

  function ejectUser(userId) {
    const p = partyOf(userId);
    if (!p) return false;
    leave(userId);
    return true;
  }

  // ---- 招待 --------------------------------------------------------------

  function invite(fromId, toId) {
    const p = partyOf(fromId);
    if (!p) return { error: 'パーティーにいません' };
    if (p.members.length >= MAX_MEMBERS) return { error: 'パーティーがいっぱいです' };
    if (partyOf(toId)) return { error: 'その人はすでに別のパーティーにいます' };
    const from = userOf(fromId), to = userOf(toId);
    if (!from || !to) return { error: '相手が見つかりません' };
    if ((from.blocked || []).includes(toId) || (to.blocked || []).includes(fromId)) {
      return { error: '招待できませんでした' };
    }
    // 既定は「フレンドだけ」。承認していない相手は、画面に何ひとつ出せない。
    const pref = (to.social && to.social.invites) || 'friends';
    if (pref === 'none') return { error: '招待できませんでした' };
    if (pref === 'friends' && !(to.friends || []).includes(fromId)) return { error: '招待できませんでした' };
    if (!isOnline(toId)) return { error: 'その人はいまオフラインです' };

    const id = uuid();
    invites.set(id, { partyId: p.id, toId, fromId, at: now() });
    sendToUser(toId, {
      type: 'party_invite',
      inviteId: id, from: from.username, code: p.code,
      members: p.members.length, max: MAX_MEMBERS,
      expiresIn: INVITE_TTL_MS,
    }, { primaryOnly: true });
    return { ok: true };
  }

  function acceptInvite(userId, inviteId) {
    const inv = invites.get(inviteId);
    if (!inv || inv.toId !== userId) return { error: 'その招待は見つかりません' };
    if (now() - inv.at > INVITE_TTL_MS) { invites.delete(inviteId); return { error: 'その招待は期限切れです' }; }
    invites.delete(inviteId);
    const p = parties.get(inv.partyId);
    if (!p) return { error: 'そのパーティーは解散しています' };
    return join(userId, p.code);
  }

  function declineInvite(userId, inviteId) {
    const inv = invites.get(inviteId);
    if (inv && inv.toId === userId) invites.delete(inviteId);
    return { ok: true };
  }

  // ---- チャット ----------------------------------------------------------
  //
  // 全体チャットの処理から「漏れるもの」を全部落としたもの。
  // ・pushHistory を通さない（全体チャットの履歴を押し出すし、
  //   私語が db.meta.chatLog に書き込まれる）
  // ・返信を持たせない（返信先は全体チャットの履歴から引くので、
  //   私語が全体チャットに引用されてしまう）
  // ・リアクションを持たせない（持ち主の記録が解放されず溜まり続ける）
  // ・住人の反応に流さない（私語が AI の入力になる）
  // ・chatMessages を増やさない（4人の非公開部屋で実績を稼げてしまう）
  // ・外部の翻訳サーバーに送らない（私語が箱の外に出る）
  function chat(userId, text) {
    const p = partyOf(userId);
    if (!p) return { error: 'パーティーにいません' };
    const u = userOf(userId);
    if (!u) return { error: 'ログインが必要です' };
    // ミュートはここでも見る。socket の入口はBANとメンテしか見ていない。
    if (u.muted) return { error: '🔇 管理者によりチャットが制限されています' };
    if (rateLimit && !rateLimit('pchat:' + userId, 20, 10_000)) {
      return { error: 'すこし早すぎます' };
    }
    const body = String(text || '').trim().slice(0, CHAT_MAX);
    if (!body) return { error: '' };

    const entry = { id: uuid(), from: u.username, fromId: userId, text: body, at: now() };
    p.chat.push(entry);
    if (p.chat.length > CHAT_RING) p.chat.shift();
    // 先に配ってから翻訳を後追いで貼る。翻訳を待ってから配ると、
    // 発言の順番が入れ替わる（全体チャットで実際に起きている）。
    broadcast(p, { type: 'party_chat', msg: entry });
    if (translateLocal) {
      // 文字列以外が来たら捨てる。オブジェクトを素通しすると
      // 画面に [object Object] が出る（実際に出た）。
      const tr = translateLocal(body);
      const txt = typeof tr === 'string' ? tr : (tr && typeof tr.text === 'string' ? tr.text : null);
      if (txt && txt !== body) broadcast(p, { type: 'party_chat_tr', id: entry.id, text: txt });
    }
    return { ok: true };
  }

  // ---- 通報 --------------------------------------------------------------
  // 直近の会話と参加者を、既存の bugreports に kind:'party' で落とす。
  // 新しい入れ物を作らないのは、復元がそれを取り込んでくれるから。
  function report(userId) {
    const p = partyOf(userId);
    if (!p) return { error: 'パーティーにいません' };
    const u = userOf(userId);
    return {
      ok: true,
      snapshot: {
        partyId: p.id,
        by: u ? u.username : '?',
        byId: userId,
        members: p.members.map(m => {
          const mu = userOf(m.userId);
          return { id: m.userId, username: mu ? mu.username : '?' };
        }),
        lines: p.chat.slice(-CHAT_RING).map(c => ({ from: c.from, fromId: c.fromId, text: c.text, at: c.at })),
      },
    };
  }

  // 運営が読むときは、読んだこと自体を記録に残す。
  function modRead(party_id, byName) {
    const p = parties.get(party_id);
    if (!p) return { error: 'そのパーティーはありません' };
    if (adminLog) adminLog(`パーティー ${p.code} の会話を閲覧`, byName);
    return {
      ok: true,
      party: {
        id: p.id, code: p.code, createdAt: p.createdAt,
        members: p.members.map(m => {
          const u = userOf(m.userId);
          return { id: m.userId, username: u ? u.username : '?' };
        }),
        chat: p.chat.slice(),
      },
    };
  }

  function modList() {
    return [...parties.values()].map(p => ({
      id: p.id, code: p.code, createdAt: p.createdAt,
      members: p.members.map(m => {
        const u = userOf(m.userId);
        return u ? u.username : '?';
      }),
      lines: p.chat.length,
    }));
  }

  function disband(partyId) {
    const p = parties.get(partyId);
    if (!p) return { error: 'そのパーティーはありません' };
    for (const m of p.members) {
      partyOfUser.delete(m.userId);
      sendToUser(m.userId, { type: 'party_state', party: null }, { primaryOnly: true });
      sendToUser(m.userId, { type: 'party_error', error: 'パーティーは運営により解散されました' }, { primaryOnly: true });
    }
    parties.delete(p.id);
    return { ok: true };
  }

  // ---- いっしょに遊ぶ ----------------------------------------------------
  //
  // 部屋を作るのはリーダーの画面。サーバーは合言葉を受け取って配るだけ。
  // こうすると create_room / join_room / startRoom を1行も触らずに済む
  // （あそこはこのコードベースでいちばん壊しやすい場所）。
  function play(leaderId, mode, seats) {
    const p = partyOf(leaderId);
    if (!p) return { error: 'パーティーにいません' };
    if (p.leaderId !== leaderId) return { error: 'リーダーだけができます' };
    if (seats && p.members.length > seats) {
      return { error: `このモードは${seats}人までです（いま${p.members.length}人）` };
    }
    const busy = p.members.filter(m => m.userId !== leaderId && statusOf(m.userId) !== 'menu');
    if (busy.length) return { error: '対戦中のメンバーがいます。終わるまで待ってください' };
    p.launch = { mode, at: now(), by: leaderId };
    sendToUser(leaderId, { type: 'party_launch_begin', mode }, { primaryOnly: true });
    return { ok: true };
  }

  function launchCode(leaderId, code) {
    const p = partyOf(leaderId);
    if (!p || p.leaderId !== leaderId || !p.launch) return { error: '' };
    const mode = p.launch.mode;
    p.launch = null;
    for (const m of p.members) {
      if (m.userId === leaderId) continue;
      sendToUser(m.userId, { type: 'party_launch', code, mode, expiresIn: INVITE_TTL_MS }, { primaryOnly: true });
    }
    return { ok: true };
  }

  // ---- 掃除 --------------------------------------------------------------
  // 招待の期限、全員オフラインの猶予、12時間で店じまい。
  function sweep() {
    const t = now();
    for (const [id, inv] of invites) if (t - inv.at > INVITE_TTL_MS) invites.delete(id);

    for (const p of [...parties.values()]) {
      // 部屋作りの返事が来ない（リーダーが落ちた等）。待たせっぱなしにしない。
      if (p.launch && t - p.launch.at > 10_000) {
        // 失敗を知る必要があるのは、部屋を作りにいった本人だけ。
        // 全員に投げると、何もしていない人に的外れなエラーが出る。
        const by = p.launch.by;
        p.launch = null;
        sendToUser(by, { type: 'party_error', error: '部屋を作れませんでした。もう一度お試しください' }, { primaryOnly: true });
      }
      for (const m of p.members) {
        const online = isOnline(m.userId);
        if (online) m.offlineAt = 0;
        else if (!m.offlineAt) m.offlineAt = t;
      }
      const allGone = p.members.every(m => m.offlineAt && t - m.offlineAt > OFFLINE_GRACE_MS);
      if (allGone || t - p.createdAt > PARTY_TTL_MS) {
        // 消す前に、まだ繋がっている人には必ず知らせる。
        // 黙って消すと、画面には解散したパーティーが残り続け、
        // 話しかけても誰にも届かない状態になる（12時間で消えるので、
        // 長く遊んでいる人ほど確実に踏む）。
        for (const m of p.members) {
          partyOfUser.delete(m.userId);
          sendToUser(m.userId, { type: 'party_state', party: null }, { primaryOnly: true });
          sendToUser(m.userId, { type: 'party_error', error: 'パーティーは時間切れで解散しました' }, { primaryOnly: true });
        }
        parties.delete(p.id);
        continue;
      }
      // 猶予を超えた個人だけ外す
      for (const m of [...p.members]) {
        if (m.offlineAt && t - m.offlineAt > OFFLINE_GRACE_MS) leave(m.userId);
      }
    }
  }

  // socket が1本閉じただけでは所属を落とさない。
  // 1人が最大6本の socket を持ちうるし、battle 用の socket は
  // 対戦から抜けるたびに閉じる。ここでは在席表示を配り直すだけ。
  function socketGone(userId) {
    const p = partyOf(userId);
    if (p) pushState(p);
  }
  function socketArrived(userId) {
    const p = partyOf(userId);
    if (!p) {
      // 繋ぎ直したときにパーティーが無いなら、画面に残っている
      // 古いパーティーを消させる。何も送らないと、解散したはずの
      // パーティーが出たままになる。
      sendToUser(userId, { type: 'party_state', party: null }, { primaryOnly: false });
      return;
    }
    const m = p.members.find(x => x.userId === userId);
    if (m) m.offlineAt = 0;
    // 他のメンバーには在席の変化を配る（通知なので primaryOnly）。
    for (const x of p.members) {
      if (x.userId !== userId) sendToUser(x.userId, viewFor(p, x.userId), { primaryOnly: true });
    }
    // 本人には **全部の socket** に配る。再読み込みの瞬間は古い socket が
    // まだ開いていることがあり、primaryOnly だと死にかけの方に送ってしまって
    // 新しい画面にはパーティーが出てこない（実際にそうなった）。
    // 状態は何度届いても同じ結果になるので、重複しても害はない。
    sendToUser(userId, viewFor(p, userId), { primaryOnly: false });
    sendToUser(userId, { type: 'party_chat_history', chat: p.chat.slice() }, { primaryOnly: false });
  }

  function shutdownAll() {
    for (const p of [...parties.values()]) {
      broadcast(p, { type: 'party_error', error: 'サーバーの更新のため、パーティーを解散しました' });
      for (const m of p.members) partyOfUser.delete(m.userId);
      parties.delete(p.id);
    }
  }

  return {
    create, join, leave, kick, invite, acceptInvite, declineInvite,
    chat, report, play, launchCode, splitOnBlock, ejectUser,
    modRead, modList, disband,
    sweep, socketGone, socketArrived, shutdownAll,
    partyOf, viewFor, pushState,
    _parties: parties,
  };
}
