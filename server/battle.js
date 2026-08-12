// Multiplayer battle system: matchmaking (1v1 / 2v2 team), custom rooms,
// and server-side bot players that fill empty seats.
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { Engine } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';
import { RAID_BOSSES } from './catalog.js';
import {
  effectiveScale, pickPersona, lobbyPersona,
  ambientOnline, ambientMatches, randomChatLine, chooseReplies,
} from './ambient.js';

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
// Bot strength rises with the round: QF easy/normal, SF normal/hard, F hard/oni.
const TOURNEY_BOT_LEVELS = [['easy', 'normal'], ['normal', 'hard'], ['hard', 'oni']];

export function initBattle(server, deps) {
  const { db, saveDb, applyGameResult, publicUser, levelOf, sanitizeName, MATCH_DURATION } = deps;

  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();
  const matches = new Map();               // matchId -> match
  const rooms = new Map();                 // code -> room
  const tourneys = new Map();              // id -> tournament
  const royales = new Map();               // id -> battle royale
  const queues = { duel: [], team: [], raid: [], tourney: [], royale: [] };   // entries: { ws, since, botAt }

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

  // Ambient chat: simulated players keep the lobby lively. Seed a little
  // back-history so the chat never looks dead, then post at a natural pace.
  function postAmbient(text) {
    const entry = {
      type: 'chat', from: lobbyPersona().name, role: 'user',
      text: text || randomChatLine(), at: Date.now(),
    };
    chatHistory.push(entry);
    if (chatHistory.length > 60) chatHistory.shift();
    broadcastAll(entry);
    return entry;
  }

  if (effectiveScale()) {
    let t = Date.now() - 25 * 60 * 1000;
    const used = new Set();
    for (let i = 0; i < 8; i++) {
      t += (1.5 + Math.random() * 3) * 60 * 1000;
      chatHistory.push({
        type: 'chat', from: pickPersona({ used }).name, role: 'user',
        text: randomChatLine(), at: Math.min(t, Date.now() - 30000),
      });
    }
  }
  const ambientChat = () => {
    setTimeout(() => {
      if (effectiveScale() && clients.size > 0) postAmbient();
      ambientChat();
    }, 22000 + Math.random() * 53000);
  };
  ambientChat();

  // AI players answer real messages (rate-limited so they never spam).
  let replyCooldownUntil = 0;
  function maybeAmbientReply(text) {
    if (!effectiveScale()) return;
    if (Date.now() < replyCooldownUntil) return;
    if (Math.random() > 0.85) return;
    const replies = chooseReplies(text);
    if (!replies.length) return;
    replyCooldownUntil = Date.now() + 12000;
    for (const r of replies) {
      setTimeout(() => { if (clients.size > 0) postAmbient(r.text); }, r.delay);
    }
  }

  // Live population sync: keep every client's counters in agreement.
  setInterval(() => {
    if (clients.size > 0) {
      broadcastAll({ type: 'online', online: displayOnline(), matches: displayMatches() });
    }
  }, 25000);

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
      const persona = pickPersona({ used });
      this.name = persona.name;
      const [rLo, rHi] = BOT_RATING[this.level];
      this.rating = persona.registered ? rLo + crypto.randomInt(rHi - rLo) : null;
      const [lLo, lHi] = BOT_LVL[this.level];
      this.fakeLevel = persona.registered ? lLo + crypto.randomInt(lHi - lLo) : 1;
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
    for (const p of match.players) if (p.sock.isBot) p.sock.startPlay(match, p.slot);
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

  function endMatch(match, reason) {
    if (match.ended) return;
    match.ended = true;
    clearTimeout(match.timer);
    clearInterval(match.raidAtk);
    clearInterval(match.raidSync);
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

    const playersInfo = match.players.map(p => ({
      slot: p.slot, team: p.team, name: sockName(p.sock),
      score: p.score, isBot: !!p.sock.isBot,
    }));

    const humanUsers = match.players.map(p =>
      (!p.sock.isBot && p.sock.user) ? db.users[p.sock.user.id] : null);
    // Rated 1v1: vs another account, or vs a "registered" AI player (its fake
    // rating drives a real Elo update so ranked works even when nobody's on).
    const duel2 = match.rated && match.mode === 'duel' && match.players.length === 2;

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
      if (me) {
        if (duel2) {
          const oppUser = humanUsers[1 - p.slot];
          const oppSock = match.players[1 - p.slot].sock;
          const oppRating = oppUser && oppUser.id !== me.id ? oppUser.stats.rating
            : oppSock.isBot && oppSock.rating != null ? oppSock.rating : null;
          if (oppRating != null) {
            ratingDelta = eloUpdate(me.stats.rating, oppRating, outcome);
            me.stats.rating = Math.max(0, me.stats.rating + ratingDelta);
          }
        }
        if (match.rated && match.mode !== 'raid') {
          if (outcome === 1) me.stats.pvpWins += 1;
          else if (outcome === 0) me.stats.pvpLosses += 1;
        }
        if (!p.forfeited) {
          rewards = applyGameResult(me, {
            mode: match.tourney ? 'tournament'
              : match.mode === 'team' ? 'team' : match.mode === 'raid' ? 'raid' : 'pvp',
            score: p.score, lines: p.lines, maxCombo: p.maxCombo,
            duration: match.duration,
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
        you: { slot: p.slot, team: p.team },
        players: playersInfo,
        ratingDelta, rewards,
        user: me ? publicUser(me) : null,
      });
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

  function joinQueue(ws, mode) {
    if (ws.matchId || ws.roomCode || ws.tourneyId || ws.royaleId) return;
    leaveQueues(ws);
    const wait = mode === 'duel' ? duelBotWait() : teamBotWait();
    queues[mode].push({ ws, since: Date.now(), botAt: Date.now() + wait });
    send(ws, { type: 'queued', mode });
    sweepQueues();
  }

  function leaveQueues(ws) {
    for (const q of Object.values(queues)) {
      const i = q.findIndex(e => e.ws === ws);
      if (i !== -1) q.splice(i, 1);
    }
  }

  function sweepQueues() {
    for (const mode of ['duel', 'team', 'raid', 'tourney', 'royale']) {
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
    while (queues.duel.length >= 2) {
      const [a, b] = queues.duel.splice(0, 2);
      createMatch({ mode: 'duel', entries: [{ sock: a.ws, team: 0 }, { sock: b.ws, team: 1 }] });
    }
    if (queues.duel.length === 1 && Date.now() >= queues.duel[0].botAt) {
      const [a] = queues.duel.splice(0, 1);
      createMatch({ mode: 'duel', entries: [{ sock: a.ws, team: 0 }, { sock: new Bot('random'), team: 1 }] });
    }
    while (queues.team.length >= 4) {
      const four = queues.team.splice(0, 4);
      createMatch({ mode: 'team', entries: four.map((e, i) => ({ sock: e.ws, team: i % 2 })) });
    }
    if (queues.team.length > 0 && Date.now() >= queues.team[0].botAt) {
      const humans = queues.team.splice(0, queues.team.length);
      const entries = humans.map((e, i) => ({ sock: e.ws, team: i % 2 }));
      const used = new Set(humans.map(e => sockName(e.ws)));
      while (entries.length < 4) entries.push({ sock: new Bot('random', used), team: entries.length % 2 });
      createMatch({ mode: 'team', entries });
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
      while (entries.length < 4) entries.push({ sock: new Bot('random', used), team: 0 });
      createMatch({ mode: 'raid', entries, rated: false });
    }
  }
  setInterval(sweepQueues, 2000);

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

  function cleanSettings(s = {}) {
    return {
      duration: DURATIONS.includes(Number(s.duration)) ? Number(s.duration) : MATCH_DURATION,
      team: !!s.team,
      botFill: s.botFill !== false,
      botLevel: ['random', 'easy', 'normal', 'hard', 'oni'].includes(s.botLevel) ? s.botLevel : 'random',
    };
  }

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
    const need = room.settings.team ? 4 : 2;
    if (room.players.length > need) {
      send(ws, { type: 'room_error', error: `この設定では最大${need}人です（チーム戦に変更してください）` });
      return;
    }
    if (room.players.length < need && !room.settings.botFill) {
      send(ws, { type: 'room_error', error: `あと${need - room.players.length}人必要です（ボット補充をONにもできます）` });
      return;
    }
    // Humans keep join order: in team mode the first two are team A.
    const teamOf = i => room.settings.team ? (i < 2 ? 0 : 1) : i % 2;
    const entries = room.players.map((p, i) => ({ sock: p, team: teamOf(i) }));
    const used = new Set(room.players.map(p => sockName(p)));
    while (entries.length < need) entries.push({ sock: new Bot(room.settings.botLevel, used), team: teamOf(entries.length) });
    const players = room.players.slice();
    rooms.delete(room.code);
    for (const p of players) p.roomCode = null;
    createMatch({
      mode: room.settings.team ? 'team' : 'duel',
      entries,
      duration: room.settings.duration,
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
  // Battle Royale: 100 entrants, humans + lightweight simulated AI players
  // (score curves only — no engines), periodic cuts until one remains.
  // -------------------------------------------------------------------------

  const ROYALE_SIZE = 100;
  const ROYALE_DURATION = Math.max(30, Number(process.env.ROYALE_SECS) || 180);
  // At these fractions of the match, the field is cut down TO `keep` players.
  const ROYALE_CUTS = [
    { at: 1 / 6, keep: 70 }, { at: 2 / 6, keep: 45 }, { at: 3 / 6, keep: 25 },
    { at: 4 / 6, keep: 12 }, { at: 5 / 6, keep: 5 },
  ];

  function startRoyale(humanSocks) {
    const id = crypto.randomUUID();
    const used = new Set(humanSocks.map(s => sockName(s)));
    const entrants = humanSocks.map(ws => ({
      ws, human: true, name: sockName(ws), score: 0, lines: 0, combo: 0, alive: true, placement: null,
    }));
    while (entrants.length < ROYALE_SIZE) {
      const skill = Math.random();
      entrants.push({
        human: false, name: pickPersona({ used }).name,
        score: 0, alive: true, placement: null,
        rate: 12 + 95 * skill * skill,   // points/sec — few monsters, many mortals
      });
    }
    const r = { id, entrants, startedAt: Date.now(), ended: false, cutIdx: 0, lastState: 0 };
    royales.set(id, r);
    for (const e of entrants) {
      if (!e.human) continue;
      e.ws.royaleId = id;
      send(e.ws, {
        type: 'royale_found',
        duration: ROYALE_DURATION, countdown: COUNTDOWN, players: ROYALE_SIZE,
        seed: Math.floor(Math.random() * 2 ** 31),
      });
    }
    r.tick = setInterval(() => tickRoyale(r), 1000);
  }

  function royaleRanked(r) {
    return r.entrants.filter(e => e.alive).sort((a, b) => b.score - a.score);
  }

  function endRoyaleFor(e, r, placement, ranked) {
    e.alive = false;
    e.placement = placement;
    if (!e.human) return;
    if (e.ws.royaleId === r.id) e.ws.royaleId = null;
    const me = e.ws.user ? db.users[e.ws.user.id] : null;
    let rewards = null;
    if (me && e.ws.readyState === e.ws.OPEN) {
      rewards = applyGameResult(me, {
        mode: 'royale', score: e.score, lines: e.lines, maxCombo: e.combo,
        duration: Math.max(1, (Date.now() - r.startedAt) / 1000), won: placement === 1,
      });
    }
    send(e.ws, {
      type: 'royale_result',
      placement, players: ROYALE_SIZE, score: e.score,
      top: ranked.slice(0, 5).map(x => ({ name: x.name, score: Math.floor(x.score) })),
      rewards, user: me ? publicUser(me) : null,
    });
  }

  function tickRoyale(r) {
    if (r.ended) return;
    const elapsed = (Date.now() - r.startedAt) / 1000 - COUNTDOWN;
    if (elapsed < 0) return;
    // simulated players grind away
    for (const e of r.entrants) {
      if (e.alive && !e.human) e.score += e.rate * (0.6 + Math.random() * 0.8);
      // disconnected humans freeze and sink on their own
    }
    // scheduled cuts
    const cut = ROYALE_CUTS[r.cutIdx];
    if (cut && elapsed >= ROYALE_DURATION * cut.at) {
      r.cutIdx++;
      const ranked = royaleRanked(r);
      if (ranked.length > cut.keep) {
        const dropped = ranked.slice(cut.keep);
        for (let i = 0; i < dropped.length; i++) {
          endRoyaleFor(dropped[i], r, cut.keep + 1 + i, ranked);
        }
        for (const e of r.entrants) {
          if (e.alive && e.human) {
            send(e.ws, { type: 'royale_cut', eliminated: dropped.length, alive: cut.keep });
          }
        }
      }
    }
    // finale
    if (elapsed >= ROYALE_DURATION) {
      r.ended = true;
      clearInterval(r.tick);
      const ranked = royaleRanked(r);
      for (let i = ranked.length - 1; i >= 0; i--) endRoyaleFor(ranked[i], r, i + 1, ranked);
      const winner = ranked[0];
      if (winner) {
        broadcastAll({
          type: 'announce',
          message: `💯 バトルロイヤルで「${winner.name}」が100人の頂点に！`,
          from: '大会運営',
        });
      }
      royales.delete(r.id);
      return;
    }
    // rank sync every 2s
    if (Date.now() - r.lastState >= 2000) {
      r.lastState = Date.now();
      const ranked = royaleRanked(r);
      const nextCut = ROYALE_CUTS[r.cutIdx];
      for (let i = 0; i < ranked.length; i++) {
        const e = ranked[i];
        if (!e.human) continue;
        send(e.ws, {
          type: 'royale_state',
          rank: i + 1, alive: ranked.length, score: Math.floor(e.score),
          remain: Math.max(0, Math.round(ROYALE_DURATION - elapsed)),
          top: ranked.slice(0, 3).map(x => ({ name: x.name, score: Math.floor(x.score) })),
          nextCutIn: nextCut ? Math.max(0, Math.round(ROYALE_DURATION * nextCut.at - elapsed)) : null,
          nextKeep: nextCut ? nextCut.keep : null,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const match = ws.matchId ? matches.get(ws.matchId) : null;
      const me = match ? match.players.find(p => p.sock === ws) : null;

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
            chat: chatHistory.slice(-40),
          });
          break;
        }
        case 'queue': {
          const mode = ['team', 'raid', 'tourney', 'royale'].includes(msg.mode) ? msg.mode : 'duel';
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
                e.score = Math.max(e.score, Math.min(1_000_000, Math.floor(Number(msg.score) || 0)));
                e.lines = Math.max(e.lines, Math.floor(Number(msg.lines) || 0));
                e.combo = Math.max(e.combo, Math.floor(Number(msg.combo) || 0));
              }
            }
            return;
          }
          if (!match || match.ended || !me) return;
          me.score = Math.max(0, Math.min(1_000_000, Math.floor(Number(msg.score) || 0)));
          me.lines = Math.max(me.lines, Math.floor(Number(msg.lines) || 0));
          me.maxCombo = Math.max(me.maxCombo, Math.floor(Number(msg.combo) || 0));
          broadcastState(match, me.slot, {
            score: me.score,
            combo: Math.floor(Number(msg.combo) || 0),
            lines: me.lines,
            grid: Array.isArray(msg.grid) ? msg.grid.slice(0, 64) : null,
          });
          break;
        }
        case 'finish': {
          if (!match || match.ended || !me) return;
          finishPlayer(match, me.slot, msg.score, msg.lines, msg.combo);
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
          if (room.players.length >= 4) { send(ws, { type: 'room_error', error: 'ルームが満員です' }); return; }
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
          const entry = { type: 'chat', from: sockName(ws), role, text, at: Date.now() };
          chatHistory.push(entry);
          if (chatHistory.length > 60) chatHistory.shift();
          broadcastAll(entry);
          maybeAmbientReply(text);
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
    });

    ws.on('close', () => {
      clients.delete(ws);
      leaveQueues(ws);
      leaveRoom(ws);
      // Battle royale: leaving = instant elimination at the current rank.
      if (ws.royaleId) {
        const r = royales.get(ws.royaleId);
        if (r && !r.ended) {
          const ranked = royaleRanked(r);
          const idx = ranked.findIndex(e => e.ws === ws);
          if (idx !== -1) endRoyaleFor(ranked[idx], r, idx + 1, ranked);
        }
        ws.royaleId = null;
      }
      const match = ws.matchId ? matches.get(ws.matchId) : null;
      if (match && !match.ended) {
        const p = match.players.find(q => q.sock === ws);
        if (p && !p.finished) {
          p.forfeited = true;
          p.finished = true;
          const otherHumans = match.players.filter(q => q !== p && !q.sock.isBot && !q.forfeited);
          if (match.mode === 'duel' && match.players.length === 2 && otherHumans.length === 1) {
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
    queueSize: () => queues.duel.length + queues.team.length,
    displayOnline, displayMatches,
    broadcastAll,
    chatOps: {
      clear: () => {
        chatHistory.length = 0;
        broadcastAll({ type: 'chat_clear' });
      },
      say: (text) => postAmbient(text),
    },
  };
}
