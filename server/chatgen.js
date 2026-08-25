// チャット3.0 会話エンジン (v2.6)
//
// crowd.js 2.x の弱点は「固定プールからの純ランダム抽選」だった — 同じテンプレ
// が数分おきに再登場し、常連ほど繰り返しに気づく。このモジュールは3つの記憶と
// 1つの話題状態で、その繰り返しを構造的に潰す:
//
//   1. グローバル再出クールダウン  — 同じテンプレは約25分は再登場しない
//   2. 住人ごとの記憶            — 同じ住人は同じテンプレを丸1日言わない
//   3. 表層文字列メモリ          — 完成文が直近の発言と一致したら作り直し
//   4. 話題スレッド              — ロビーに「いま話している話題」があり、
//      発言の多くはトピック本文かフォロー（相づち・質問・体験談）として
//      その流れに乗る。実イベント（イベント開始・投票・優勝）も話題を動かす。
//
// このモジュールは crowd.js から使われる純ロジック層で、content は
// chatgen-content.js、スロット展開/口癖は crowd.js 側の fill/stylize が担う。

// ---------------------------------------------------------------------------
// Recency memory
// ---------------------------------------------------------------------------

const TPL_COOLDOWN = 25 * 60 * 1000;        // same template, anyone
const RES_COOLDOWN = 20 * 60 * 60 * 1000;   // same template, same resident
const SURFACE_WINDOW = 6 * 60 * 60 * 1000;  // exact same finished sentence
const SPOKE_DAMP_MS = 9 * 60 * 1000;        // a resident who just spoke gets quieter

const usedAt = new Map();        // templateKey → ts
const perResident = new Map();   // residentId → Map(templateKey → ts)
const surfaceAt = new Map();     // normalized surface → ts
const spokeAt = new Map();       // residentId → ts

function keyOf(pool, item, i) {
  if (typeof item === 'string') return `${pool}|${item}`;
  const id = item.ja || item.id || (item.lines && item.lines[0] && item.lines[0][1]) || i;
  return `${pool}|${id}`;
}

function pruneMap(map, max) {
  if (map.size <= max) return;
  const cut = [...map.entries()].sort((a, b) => a[1] - b[1]).slice(0, map.size - max);
  for (const [k] of cut) map.delete(k);
}

export function noteSurface(text, now = Date.now()) {
  surfaceAt.set(String(text).trim(), now);
  if (surfaceAt.size > 600) {
    for (const [k, t] of surfaceAt) if (now - t > SURFACE_WINDOW) surfaceAt.delete(k);
    pruneMap(surfaceAt, 500);
  }
}

export function surfaceFresh(text, now = Date.now()) {
  const t = surfaceAt.get(String(text).trim());
  return !t || now - t > SURFACE_WINDOW;
}

export function noteSpoken(residentId, now = Date.now()) {
  if (residentId) spokeAt.set(residentId, now);
  pruneMap(spokeAt, 400);
}

// Multiplier for the speaker-choice weights: fresh voices over chatterboxes.
export function speakerDamp(residentId, now = Date.now()) {
  const t = spokeAt.get(residentId);
  if (!t) return 1;
  const dt = now - t;
  if (dt < SPOKE_DAMP_MS) return 0.15 + 0.85 * (dt / SPOKE_DAMP_MS);
  return 1;
}

// Weighted pick with recency penalties. `items` may be strings or objects
// (uses .w as base weight). Records the choice in both memories.
export function smartPick(pool, items, { now = Date.now(), rid = null, weightFn = null } = {}) {
  if (!items || !items.length) return null;
  let rmap = null;
  if (rid) {
    rmap = perResident.get(rid);
    if (!rmap) { rmap = new Map(); perResident.set(rid, rmap); }
  }
  const weights = items.map((it, i) => {
    let w = weightFn ? weightFn(it, i) : (typeof it === 'object' && it.w) || 1;
    const k = keyOf(pool, it, i);
    const dt = now - (usedAt.get(k) || 0);
    if (dt < TPL_COOLDOWN) w *= 0.02;           // near-ban (tiny pools can still resort to it)
    else if (dt < TPL_COOLDOWN * 4) w *= 0.3;   // fading penalty
    if (rmap) {
      const rdt = now - (rmap.get(k) || 0);
      if (rdt < RES_COOLDOWN) w *= 0.08;
    }
    return Math.max(w, 0.0001);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let x = Math.random() * total;
  let idx = items.length - 1;
  for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x <= 0) { idx = i; break; } }
  const k = keyOf(pool, items[idx], idx);
  usedAt.set(k, now);
  pruneMap(usedAt, 6000);
  if (rmap) { rmap.set(k, now); pruneMap(rmap, 300); }
  if (perResident.size > 400) perResident.clear();   // roster reseed safety valve
  return items[idx];
}

// ---------------------------------------------------------------------------
// Topic threads
// ---------------------------------------------------------------------------

// Baseline interest per topic; live world state boosts event/poll hard.
const TOPIC_BASE = {
  boss: 3, dungeon: 3, gacha: 3, ranking: 2.2, ult: 2.2, weekly: 2, sprint: 2,
  survival: 1.6, chaos: 1.6, rush: 2, abyss: 1.6, guild: 1.8, coop: 1.6,
  royale: 1.8, tourney: 1.4, music: 1.4, shop: 1.4,
  meltdown: 2.2, chimera: 2.2,
  // 新モードは旬なのでよく話題に上がる
  puzzle: 3.4, dig: 3.4,
};

let topic = null;   // { id, until, depth, max }

function pickTopicId(ctx) {
  const entries = Object.entries(TOPIC_BASE).slice();
  if (ctx.event) entries.push(['event', 9]);
  if (ctx.poll) entries.push(['poll', 7]);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = Math.random() * total;
  for (const [id, w] of entries) { x -= w; if (x <= 0) return id; }
  return 'boss';
}

// Called once per ambient line. Returns null (free line) or
// { id, role: 'core' | 'follow' } — core opens/extends the topic, follow
// reacts to whatever was just said about it.
export function tickTopic(ctx) {
  const now = ctx.now || Date.now();
  if (topic && (topic.until < now || topic.depth >= topic.max)) topic = null;
  if (!topic) {
    if (Math.random() >= 0.62) return null;   // quiet drift between topics
    topic = {
      id: pickTopicId(ctx),
      until: now + (4 + Math.random() * 7) * 60 * 1000,
      depth: 0,
      max: 3 + Math.floor(Math.random() * 4),
    };
  }
  // Topics that need live world state die with it.
  if ((topic.id === 'event' && !ctx.event) || (topic.id === 'poll' && !ctx.poll)) {
    topic = null;
    return null;
  }
  topic.depth++;
  return { id: topic.id, role: topic.depth === 1 ? 'core' : (Math.random() < 0.56 ? 'follow' : 'core') };
}

// Real world moments steer the lobby conversation (called from composeReaction).
const REACTION_TOPIC = {
  event_start: 'event', event_end: 'event',
  poll_open: 'poll', poll_close: 'poll', poll_voted: 'poll', poll_swing: 'poll', poll_lastcall: 'poll',
  champion: 'ranking', royale_win: 'royale', coop_done: 'coop', throne: 'ranking', rankup: 'ranking',
};

export function adoptTopic(id, ctx = {}) {
  if (!id) return;
  const now = ctx.now || Date.now();
  topic = { id, until: now + 8 * 60 * 1000, depth: 0, max: 4 + Math.floor(Math.random() * 3) };
}

export function topicForReaction(kind) { return REACTION_TOPIC[kind] || null; }

// Test hook — lets the fuzz suite reset module state between scenarios.
export function _resetForTest() {
  usedAt.clear(); perResident.clear(); surfaceAt.clear(); spokeAt.clear(); topic = null;
}
