// Multiplayer battle system: matchmaking (1v1 / 2v2 team), custom rooms,
// and server-side bot players that fill empty seats.
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { Engine } from '../public/js/engine.js';
import { chooseMove } from '../public/js/ai.js';

const COUNTDOWN = 3;
const DUEL_BOT_WAIT = 10000;   // ms alone in 1v1 queue before a bot joins
const TEAM_BOT_WAIT = 8000;    // ms in team queue before bots fill
const DURATIONS = [60, 120, 180];

export function initBattle(server, deps) {
  const { db, saveDb, applyGameResult, publicUser, levelOf, sanitizeName, MATCH_DURATION } = deps;

  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();
  const matches = new Map();               // matchId -> match
  const rooms = new Map();                 // code -> room
  const queues = { duel: [], team: [] };   // entries: { ws, since }

  function send(sock, msg) {
    if (sock.isBot) return;
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
  }
  function broadcastAll(msg) { for (const ws of clients) send(ws, msg); }

  function sockName(s) { return s.isBot ? s.name : (s.user ? s.user.username : s.guestName); }
  function sockLevel(s) {
    if (s.isBot) return { easy: 2, normal: 6, hard: 12 }[s.level] || 6;
    return s.user && db.users[s.user.id] ? levelOf(db.users[s.user.id].xp) : 1;
  }
  function sockRating(s) {
    return !s.isBot && s.user && db.users[s.user.id] ? db.users[s.user.id].stats.rating : null;
  }

  // -------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------

  const BOT_NAMES = ['ブロッコ', 'ピクセル', 'キューブ', 'テトラ', 'ネオン', 'ラピッド', 'モザイク', 'グリッド'];

  class Bot {
    constructor(level = 'normal') {
      this.isBot = true;
      this.level = level;
      this.name = `🤖${BOT_NAMES[crypto.randomInt(BOT_NAMES.length)]}`;
      this.timer = null;
    }

    startPlay(match, slot) {
      this.engine = new Engine(match.seed);
      const moveMs = { easy: 2500, normal: 1600, hard: 1000 }[this.level] || 1600;
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
        this.timer = setTimeout(tick, moveMs * (0.8 + Math.random() * 0.4));
      };
      this.timer = setTimeout(tick, COUNTDOWN * 1000 + moveMs);
    }

    stop() { clearTimeout(this.timer); }
  }

  // -------------------------------------------------------------------------
  // Matches (2 or 4 players, humans and/or bots)
  // -------------------------------------------------------------------------

  function createMatch({ mode, entries, duration, rated = true }) {
    const id = crypto.randomUUID();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const match = {
      id, mode, seed, rated,
      duration: duration || MATCH_DURATION,
      startedAt: Date.now(),
      ended: false,
      players: entries.map((e, i) => ({
        sock: e.sock, team: e.team, slot: i,
        score: 0, lines: 0, maxCombo: 0, finished: false, forfeited: false,
      })),
    };
    matches.set(id, match);
    for (const p of match.players) {
      if (p.sock.isBot) continue;
      p.sock.matchId = id;
      p.sock.roomCode = null;
      send(p.sock, {
        type: 'match_found',
        matchId: id, mode, seed, duration: match.duration, countdown: COUNTDOWN,
        you: { slot: p.slot, team: p.team },
        players: match.players.map(q => ({
          slot: q.slot, team: q.team, name: sockName(q.sock),
          level: sockLevel(q.sock), rating: sockRating(q.sock),
          isBot: !!q.sock.isBot, isYou: q === p,
        })),
      });
    }
    for (const p of match.players) if (p.sock.isBot) p.sock.startPlay(match, p.slot);
    match.timer = setTimeout(() => endMatch(match, 'timeout'), (COUNTDOWN + match.duration + 12) * 1000);
    return match;
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
    matches.delete(match.id);
    for (const p of match.players) if (p.sock.isBot) p.sock.stop();

    const ts = teamScores(match);
    let winTeam = ts[0] > ts[1] ? 0 : ts[1] > ts[0] ? 1 : -1;   // -1 = draw
    if (reason === 'forfeit') {
      const alive = match.players.find(p => !p.forfeited && !p.sock.isBot);
      if (alive) winTeam = alive.team;
    }

    const playersInfo = match.players.map(p => ({
      slot: p.slot, team: p.team, name: sockName(p.sock),
      score: p.score, isBot: !!p.sock.isBot,
    }));

    const humanUsers = match.players.map(p =>
      (!p.sock.isBot && p.sock.user) ? db.users[p.sock.user.id] : null);
    const isRatedDuel = match.rated && match.mode === 'duel' && match.players.length === 2
      && humanUsers[0] && humanUsers[1] && humanUsers[0].id !== humanUsers[1].id;

    for (const p of match.players) {
      if (p.sock.isBot || p.forfeited) continue;
      const me = humanUsers[p.slot];
      const outcome = winTeam === -1 ? 0.5 : p.team === winTeam ? 1 : 0;
      let ratingDelta = 0;
      let rewards = null;
      if (me) {
        if (isRatedDuel) {
          const opp = humanUsers[1 - p.slot];
          ratingDelta = eloUpdate(me.stats.rating, opp.stats.rating, outcome);
          me.stats.rating = Math.max(0, me.stats.rating + ratingDelta);
        }
        if (match.rated) {
          if (outcome === 1) me.stats.pvpWins += 1;
          else if (outcome === 0) me.stats.pvpLosses += 1;
        }
        rewards = applyGameResult(me, {
          mode: match.mode === 'team' ? 'team' : 'pvp',
          score: p.score, lines: p.lines, maxCombo: p.maxCombo,
          duration: match.duration, won: outcome === 1,
        });
      }
      send(p.sock, {
        type: 'result',
        outcome: outcome === 1 ? 'win' : outcome === 0 ? 'lose' : 'draw',
        reason, mode: match.mode,
        teamScores: ts,
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
  }

  // -------------------------------------------------------------------------
  // Matchmaking queues
  // -------------------------------------------------------------------------

  function joinQueue(ws, mode) {
    if (ws.matchId || ws.roomCode) return;
    leaveQueues(ws);
    queues[mode].push({ ws, since: Date.now() });
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
    for (const mode of ['duel', 'team']) {
      queues[mode] = queues[mode].filter(e => e.ws.readyState === e.ws.OPEN && !e.ws.matchId);
    }
    while (queues.duel.length >= 2) {
      const [a, b] = queues.duel.splice(0, 2);
      createMatch({ mode: 'duel', entries: [{ sock: a.ws, team: 0 }, { sock: b.ws, team: 1 }] });
    }
    if (queues.duel.length === 1 && Date.now() - queues.duel[0].since > DUEL_BOT_WAIT) {
      const [a] = queues.duel.splice(0, 1);
      createMatch({ mode: 'duel', entries: [{ sock: a.ws, team: 0 }, { sock: new Bot('normal'), team: 1 }] });
    }
    while (queues.team.length >= 4) {
      const four = queues.team.splice(0, 4);
      createMatch({ mode: 'team', entries: four.map((e, i) => ({ sock: e.ws, team: i % 2 })) });
    }
    if (queues.team.length > 0 && Date.now() - queues.team[0].since > TEAM_BOT_WAIT) {
      const humans = queues.team.splice(0, queues.team.length);
      const entries = humans.map((e, i) => ({ sock: e.ws, team: i % 2 }));
      while (entries.length < 4) entries.push({ sock: new Bot('normal'), team: entries.length % 2 });
      createMatch({ mode: 'team', entries });
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
      botLevel: ['easy', 'normal', 'hard'].includes(s.botLevel) ? s.botLevel : 'normal',
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
    while (entries.length < need) entries.push({ sock: new Bot(room.settings.botLevel), team: teamOf(entries.length) });
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
          ws.user = user ? { id: user.id, username: user.username } : null;
          ws.guestName = user ? null : (sanitizeName(msg.guestName) || `ゲスト${Math.floor(Math.random() * 9999)}`);
          send(ws, { type: 'hello_ok', name: user ? user.username : ws.guestName, online: clients.size });
          break;
        }
        case 'queue': {
          const mode = msg.mode === 'team' ? 'team' : 'duel';
          joinQueue(ws, mode);
          break;
        }
        case 'cancel_queue': {
          leaveQueues(ws);
          send(ws, { type: 'queue_cancelled' });
          break;
        }
        case 'state': {
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
        case 'ping': send(ws, { type: 'pong' }); break;
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      leaveQueues(ws);
      leaveRoom(ws);
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
    broadcastAll,
  };
}
