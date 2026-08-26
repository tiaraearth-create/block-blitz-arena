// Multiplayer battle system: matchmaking (1v1 / 2v2 team), custom rooms,
// and server-side bot players that fill empty seats.
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { Engine } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';
import { RAID_BOSSES } from './catalog.js';
import {
  effectiveScale, pickPersona, pickResidentBot, residentLine, residentById, residentByName,
  ambientOnline, ambientMatches, ambientQueue, crowdMood, chooseReplies, chatPaceFactor,
  toggles, isQuietNow, popFactor, worldCtx,
} from './ambient.js';
import { composeDialogue, composeFeed, composeReaction } from './crowd.js';
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

  // maxPayload: the default is 100 MiB per frame, which on a single free-tier
  // instance is a cheap way to exhaust memory. The largest legitimate message
  // here is a chat line or a 64-cell grid.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('error', err => console.error('[wss]', err && err.message));
  const clients = new Set();
  const matches = new Map();               // matchId -> match
  const rooms = new Map();                 // code -> room
  const tourneys = new Map();              // id -> tournament
  const royales = new Map();               // id -> battle royale
  const queues = { duel: [], attack: [], team: [], raid: [], tourney: [], royale: [], coop: [] };   // entries: { ws, since, botAt }

  function send(sock, msg) {
    if (sock.isBot) return;
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
  }
  function broadcastAll(msg) { for (const ws of clients) send(ws, msg); }

  // Displayed population = real sockets + simulated ambient players.
  const displayOnline = () => clients.size + ambientOnline();
  const displayMatches = () => matches.size + ambientMatches();

  // ---- global chat (in-memory history) ----
  const chatHistory = [];   // { type:'chat', from, role, text, at }
  const feedHistory = [];   // { icon, text, textEn, at, real, who }

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
  const humanNames = () => [...clients].filter(c => !c.isBot).map(sockName).filter(Boolean);

  // Guild tag shown next to a name in chat ([TAG]); residents carry their
  // ghost guild's tag so the crowd looks like it belongs to guilds too.
  const tagOf = (name, user) => {
    if (deps.guildTagOf) return deps.guildTagOf(name, user) || null;
    return null;
  };

  function postChat(name, text, extra = {}) {
    const entry = { type: 'chat', id: crypto.randomUUID(), from: name, role: 'user', text, at: Date.now(), tag: tagOf(name, null), ...extra };
    // 👑 王座を持つ住人（AIプレイヤー）の発言にも王冠（名前は一意・なりすまし不可）
    const crowns = db.meta.thrones ? Object.values(db.meta.thrones).filter(t => t && t.username === name).length : 0;
    if (crowns) entry.crown = crowns;
    // 翻訳: 会話エンジンが「人間が書いたネイティブ対訳」を同梱してきたら
    // それを最優先。無い素材（旧ja-only行など）だけ辞書翻訳で補う。
    if (!entry.tr) {
      const tr = translateLocal(text, detectLang(text) === 'ja' ? 'en' : 'ja');
      if (tr) entry.tr = tr;
    }
    pushHistory(entry);
    broadcastAll(entry);
    return entry;
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
  }

  function reactOwnerKey(ws) {
    if (ws.user) return `u:${ws.user.id}`;
    if (!ws.reactId) ws.reactId = crypto.randomUUID();
    return `g:${ws.reactId}`;
  }

  function applyReaction(entry, ownerKey, name, emoji) {
    let owners = reactOwners.get(entry.id);
    if (!owners) { owners = new Map(); reactOwners.set(entry.id, owners); }
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
    return postChat(line.name, text || line.text, !text && line.tr ? { tr: line.tr } : {});
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
    const gap = Math.max(2500, (20000 + Math.random() * 50000) / chatPaceFactor() / Math.max(0.5, Math.min(4, popFactor())));
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
    const gap = Math.max(6000, (25000 + Math.random() * 60000) / Math.max(0.5, Math.min(4, popFactor())));
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
          const due = ctx.active.filter(r => !poll.voters[`r:${r.id}`] && elapsed >= residentVoteAt(poll, r));
          const burst = Math.min(due.length, 1 + Math.floor(popFactor()));
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
    // Raid: everyone fights one shared boss whose HP scales with party size.
    if (mode === 'raid') {
      const def = RAID_BOSSES[crypto.randomInt(RAID_BOSSES.length)];
      match.boss = { ...def, hp: def.hp * match.players.length };
      match.bossDead = false;
    }
    matches.set(id, match);
    for (const p of match.players) {
      if (p.sock.isBot) continue;
      p.sock.matchId = id;
      p.sock.roomCode = null;
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
    for (const p of match.players) if (p.sock.isBot && mode !== 'coop') p.sock.startPlay(match, p.slot);
    if (mode === 'coop') {
      match.coopTick = setInterval(() => coopTick(match), 400);
      setTimeout(() => { if (!match.ended) coopBroadcast(match, null); }, COUNTDOWN * 1000);
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
      });
    }
  }

  // Apply one move to the shared board. Returns false when it is illegal.
  function coopApply(match, slot, index, row, col) {
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
    coopBroadcast(match, { slot, index, row, col });
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
    coopApply(match, match.turn, mv.index, mv.row, mv.col);
  }

  function coopTick(match) {
    if (match.ended || match.engine.over) return;
    if (Date.now() < match.startedAt + COUNTDOWN * 1000) return;
    const cur = match.players[match.turn];
    const isBot = cur.sock.isBot;
    // Bots "think" for a beat; humans get the full turn clock.
    const due = isBot
      ? Date.now() >= match.turnEndsAt - COOP_TURN_MS + (COOP_BOT_THINK_MS)
      : Date.now() >= match.turnEndsAt;
    if (!due) return;
    if (!isBot && cur.sock.readyState !== cur.sock.OPEN) cur.forfeited = false;   // keep playing for them
    coopAutoMove(match);
  }

  function broadcastState(match, fromSlot, state) {
    for (const p of match.players) {
      if (p.slot === fromSlot || p.sock.isBot) continue;
      send(p.sock, { type: 'opp_state', slot: fromSlot, ...state });
    }
  }

  function finishPlayer(match, slot, score, lines = 0, maxCombo = 0) {
    const p = match.players[slot];
    if (!p || p.finished || match.ended) return;
    p.finished = true;
    p.score = Math.max(0, Math.min(1_000_000, Math.floor(Number(score) || 0)));
    if (lines) p.lines = Math.max(p.lines, Math.floor(lines));
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
    matches.delete(match.id);
    for (const p of match.players) if (p.sock.isBot) p.sock.stop();

    const ts = teamScores(match);
    let winTeam = ts[0] > ts[1] ? 0 : ts[1] > ts[0] ? 1 : -1;   // -1 = draw
    if (reason === 'forfeit') {
      const alive = match.players.find(p => !p.forfeited && !p.sock.isBot);
      if (alive) winTeam = alive.team;
    }
    // Raid is co-op: everyone wins if the boss fell, loses otherwise.
    if (match.mode === 'raid') winTeam = match.bossDead ? 0 : -2;
    // Co-op has no opponent — it is a shared run, never a win or a loss.
    if (match.mode === 'coop') winTeam = -1;

    const playersInfo = match.players.map(p => ({
      slot: p.slot, team: p.team, name: sockName(p.sock),
      score: p.score, moves: p.moves || 0, isBot: !!p.sock.isBot,
    }));

    const humanUsers = match.players.map(p =>
      (!p.sock.isBot && p.sock.user) ? db.users[p.sock.user.id] : null);
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
        if (match.rated && match.mode !== 'raid') {
          if (outcome === 1) me.stats.pvpWins += 1;
          else if (outcome === 0) me.stats.pvpLosses += 1;
        }
        if (match.mode === 'coop') {
          me.stats = me.stats || {};
          if (p.score > (me.stats.coopBest || 0)) me.stats.coopBest = p.score;
        }
        if (!p.forfeited) {
          rewards = applyGameResult(me, {
            mode: match.tourney ? 'tournament'
              : match.mode === 'team' ? 'team' : match.mode === 'raid' ? 'raid'
              : match.mode === 'coop' ? 'coop' : 'pvp',
            score: p.score, lines: p.lines, maxCombo: p.maxCombo,
            duration: match.mode === 'coop' ? Math.max(1, (Date.now() - match.startedAt) / 1000) : match.duration,
            // `match.moves` only exists on the co-op shared board; every other
            // online mode reported 0 pieces, which quietly froze the
            // piece-count missions and achievements for online players.
            pieces: match.mode === 'coop' ? (match.moves || 0) : (p.pieces || 0),
            // Tournament: the badge/bonus fires only on winning the FINAL.
            won: match.tourney ? (outcome === 1 && !!match.tourney.final) : outcome === 1,
            drew: outcome === 0.5,
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
    if (match.tourney) tourneyMatchEnd(match);
  }

  // -------------------------------------------------------------------------
  // Matchmaking queues
  // -------------------------------------------------------------------------

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
    if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId) return;
    leaveQueues(ws);
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
      createMatch({ mode: 'team', entries: four.map((e, i) => ({ sock: e.ws, team: i % 2 })) });
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
  setInterval(() => { sweepQueues(); sweepRematches(); }, 2000);

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

  // mode: 'duel' (1v1) | 'team' (2v2) | 'coop' (two players, one board).
  // `team` is kept in sync for older clients that only know the boolean.
  function cleanSettings(s = {}) {
    let mode = ['duel', 'team', 'coop'].includes(s.mode) ? s.mode : (s.team ? 'team' : 'duel');
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
      mode: coop ? 'coop' : room.settings.team ? 'team' : 'duel',
      entries,
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

  function tourneyMatchEnd(match) {
    const t = tourneys.get(match.tourney.id);
    if (!t || t.ended) return;
    const ts = teamScores(match);
    let winIdx = ts[0] > ts[1] ? 0 : ts[1] > ts[0] ? 1 : null;
    if (match.players[0].forfeited && !match.players[1].forfeited) winIdx = 1;
    else if (match.players[1].forfeited && !match.players[0].forfeited) winIdx = 0;
    if (winIdx === null) {
      // Tie: a human beats an AI player; human-vs-human ties flip a coin.
      const aHuman = !match.players[0].sock.isBot, bHuman = !match.players[1].sock.isBot;
      winIdx = aHuman && !bHuman ? 0 : bHuman && !aHuman ? 1 : (Math.random() < 0.5 ? 0 : 1);
    }
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
      endTourney(t);
      if (!champ.isBot) {
        send(champ, { type: 'tourney_champion' });
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
      const cutLine = nextCut && ranked.length > nextCut.keep ? ranked[nextCut.keep] : null;
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

  wss.on('connection', (ws) => {
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
          const user = deps.userFromToken(msg.token);
          if (user && user.banned) { send(ws, { type: 'error', error: 'アカウントが凍結されています' }); ws.close(); return; }
          if (deps.isMaintenance && deps.isMaintenance() && (!user || user.role !== 'admin')) {
            send(ws, { type: 'error', error: '🛠 メンテナンス中です。しばらくお待ちください' });
            ws.close();
            return;
          }
          ws.user = user ? { id: user.id, username: user.username } : null;
          ws.guestName = user ? null : (sanitizeName(msg.guestName) || `ゲスト${Math.floor(Math.random() * 9999)}`);
          send(ws, {
            type: 'hello_ok',
            name: user ? user.username : ws.guestName,
            online: displayOnline(),
            queueing: ambientQueue() + queueSizeAll(),
            mood: crowdMood().id,
            chat: chatHistory.slice(-40),
            feed: feedHistory.slice(-20),
          });
          // Only a fresh arrival gets greeted, not a reconnecting chat socket.
          if (!ws.greeted) { ws.greeted = true; maybeGreet(ws); }
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
                e.score = Math.max(e.score, Math.min(claimed, cap));
                e.lines = Math.max(e.lines, Math.floor(Number(msg.lines) || 0));
                e.combo = Math.max(e.combo, Math.floor(Number(msg.combo) || 0));
                e.pieces = Math.max(e.pieces || 0, Math.min(20000, Math.floor(Number(msg.pieces) || 0)));
                if (Array.isArray(msg.grid)) e.grid = msg.grid.slice(0, 64);
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
          // A finished player's score is already locked in for Elo — a late
          // frame must not move it.
          if (me.finished) return;
          me.score = Math.max(0, Math.min(1_000_000, Math.floor(Number(msg.score) || 0)));
          me.lines = Math.max(me.lines, Math.floor(Number(msg.lines) || 0));
          me.maxCombo = Math.max(me.maxCombo, Math.floor(Number(msg.combo) || 0));
          // Online modes reported 0 pieces placed, which froze three missions
          // and the matching achievements for anyone who mostly plays online.
          me.pieces = Math.max(me.pieces || 0, Math.min(20000, Math.floor(Number(msg.pieces) || 0)));
          broadcastState(match, me.slot, {
            score: me.score,
            combo: Math.floor(Number(msg.combo) || 0),
            lines: me.lines,
            grid: Array.isArray(msg.grid) ? msg.grid.slice(0, 64) : null,
          });
          break;
        }
        // 💯 Royale: the client reports its own top-out, and the SERVER decides
        // what it costs — the same revive-then-eliminate rule the bots follow.
        // Without this humans were immortal while bots died, which made
        // burying someone pointless.
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
          if (!sockRate(ws, 'royaleAtkTimes', 12, 5000)) return;
          const lines = Math.max(0, Math.min(4, Math.floor(Number(msg.lines) || 0)));
          const combo = Math.max(0, Math.min(30, Math.floor(Number(msg.combo) || 0)));
          if (lines < 2) return;
          royaleAttack(r, e, attackCells(lines, combo));
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
          me.atkLinesUsed += aLines;
          const cells = attackCells(aLines, aCombo);
          if (!cells) return;
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
          if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId) return;
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
          if (!other.sock || other.sock.readyState !== other.sock.OPEN || other.sock.matchId) {
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
          finishPlayer(match, me.slot, msg.score, msg.lines, msg.combo);
          break;
        }
        case 'coop_place': {
          if (!match || match.ended || !me || match.mode !== 'coop') return;
          if (!sockRate(ws, '_coopRate', 40, 10000)) return;
          const ok = coopApply(match, me.slot, Number(msg.index), Number(msg.row), Number(msg.col));
          // Rejected (not your turn / stale board): resend authoritative state.
          if (!ok) send(ws, { type: 'coop_reject', turn: match.turn, grid: match.engine.snapshot(), score: match.engine.score });
          break;
        }
        case 'create_room': {
          if (ws.matchId) return;
          leaveQueues(ws);
          leaveRoom(ws);
          const code = makeCode();
          rooms.set(code, { code, players: [ws], settings: cleanSettings(msg.settings) });
          ws.roomCode = code;
          broadcastRoom(rooms.get(code));
          break;
        }
        case 'join_room': {
          if (ws.matchId) return;
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
          if (!sockRate(ws, 'chatTimes', 5, 10000)) {
            send(ws, { type: 'error', error: '連投しすぎです。少し待ってください' });
            return;
          }
          const role = u ? u.role : 'guest';
          if (u) {
            u.stats = u.stats || {};
            u.stats.chatMessages = (u.stats.chatMessages || 0) + 1;   // 実績用の生涯カウンター
          }
          const entry = { type: 'chat', id: crypto.randomUUID(), from: sockName(ws), role, text, at: Date.now(), tag: tagOf(sockName(ws), u) };
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
          translateChat(text).then(tr => {
            if (tr) entry.tr = tr;
          }).catch(() => {}).finally(() => {
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
        case 'ping': send(ws, { type: 'pong' }); break;
      }
    }

    ws.on('close', () => {
      clients.delete(ws);
      leaveQueues(ws);
      leaveRoom(ws);
      dropRematchesFor(ws);   // 🔁 相手が消えたら再戦オファーも消える
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
          if ((match.mode === 'duel' || match.mode === 'attack') && match.players.length === 2 && otherHumans.length === 1) {
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

  return {
    clients, matches, rooms,
    queueSize: queueSizeAll,   // all seven queues — duel+team alone under-reported
    displayOnline, displayMatches,
    broadcastAll,
    chatOps: {
      clear: () => {
        chatHistory.length = 0;
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
