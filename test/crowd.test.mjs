// Run from the repo root:  node test/crowd.test.mjs
// Fuzz the crowd content tables (lines / dialogues / feed / replies /
// reactions) across every archetype, period and world state — catches broken
// slots, bad archetype filters and crashes from newly added content.
import { buildRoster, ARCHETYPES } from '../server/residents.js';
import { composeLine, composeDialogue, composeFeed, composeReaction, chooseReplies, buildCtx } from '../server/crowd.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const roster = buildRoster('v1', 240);
const byArch = id => roster.filter(r => r.arch === id);
check('roster covers every archetype', ARCHETYPES.every(a => byArch(a.id).length > 0));

// JST hour -> a UTC timestamp with that hour.
const atHour = h => Date.UTC(2026, 7, 26, (h - 9 + 24) % 24, 30);
const PERIOD_HOURS = { morning: 8, day: 14, evening: 19, night: 23, late: 3 };
const EVENT = { name: 'コイン祭り', type: 'coinfes' };
const POLL = { question: 'つぎの企画どれがいい？', options: [{ id: 'o0', text: 'ガチャ祭' }, { id: 'o1', text: 'ボス週間' }] };

const ctxFor = (period, event, poll) => buildCtx({
  now: atHour(PERIOD_HOURS[period]),
  event, poll,
  active: roster.slice(0, 48),
  humans: ['テスト太郎'],
});

const bad = [];
const scan = (s, src) => {
  if (typeof s !== 'string' || !s.length) bad.push(`${src}: empty`);
  else if (/\{\w+\}/.test(s)) bad.push(`${src}: unfilled slot in "${s}"`);
  else if (/undefined|NaN/.test(s)) bad.push(`${src}: leaked value in "${s}"`);
};

// ---- composeLine: every archetype × every period × event/poll states ----
let lineCount = 0;
for (const period of Object.keys(PERIOD_HOURS)) {
  for (const [event, poll] of [[null, null], [EVENT, null], [null, POLL]]) {
    const ctx = ctxFor(period, event, poll);
    for (const a of ARCHETYPES) {
      const r = byArch(a.id)[0];
      for (let i = 0; i < 25; i++) { scan(composeLine(r, ctx), `line/${a.id}/${period}`); lineCount++; }
    }
  }
}
check(`composeLine fuzz (${lineCount} samples)`, bad.length === 0, bad.slice(0, 3).join(' | '));

// ---- composeDialogue ----
bad.length = 0;
let dlgCount = 0, dlgNull = 0;
for (const period of Object.keys(PERIOD_HOURS)) {
  for (const [event, poll] of [[null, null], [EVENT, null], [null, POLL]]) {
    const ctx = ctxFor(period, event, poll);
    for (let i = 0; i < 40; i++) {
      const s = composeDialogue(ctx);
      if (!s) { dlgNull++; continue; }
      for (const step of s) { scan(step.text, `dlg/${period}`); dlgCount++; }
    }
  }
}
check(`composeDialogue fuzz (${dlgCount} texts)`, bad.length === 0 && dlgCount > 100, bad.slice(0, 3).join(' | ') || `nulls=${dlgNull}`);

// ---- composeFeed ----
bad.length = 0;
let feedCount = 0;
const feedIds = new Set();
for (let i = 0; i < 600; i++) {
  const item = composeFeed(ctxFor('evening', null, null));
  if (!item) continue;
  scan(item.text, 'feed/ja');
  scan(item.textEn, 'feed/en');
  feedIds.add(item.id);
  feedCount++;
}
check(`composeFeed fuzz (${feedCount} items, ${feedIds.size} distinct kinds)`, bad.length === 0 && feedIds.size >= 15, bad.slice(0, 3).join(' | '));

// ---- composeReaction: every kind ----
bad.length = 0;
const KINDS = ['greet_named', 'greet_plain', 'lost_to', 'beat', 'drew', 'coop_done', 'event_start', 'event_end', 'poll_open', 'poll_close', 'poll_voted', 'poll_swing', 'poll_lastcall', 'champion', 'royale_win', 'record', 'badge'];
const extra = { you: 'テスト太郎', opt: 'ガチャ祭', winner: 'ガチャ祭', score: '12,000', badge: '鬼討伐バッジ' };
for (const kind of KINDS) {
  for (let i = 0; i < 25; i++) {
    for (const step of composeReaction(kind, ctxFor('evening', EVENT, POLL), extra, 2)) scan(step.text, `react/${kind}`);
  }
}
check('composeReaction fuzz (all kinds)', bad.length === 0, bad.slice(0, 3).join(' | '));

// ---- chooseReplies: new topic categories answer reliably ----
bad.length = 0;
const TRIGGERS = [
  'メルトダウンで臨界いった！', 'キメラ工房で3体合体した', '無限地獄ラッシュの遺物なに取る？',
  'カット決めてCOUNTER出た', 'エクスマキナ強すぎない？', 'BGMなに聴いてる？', 'ランキング報酬もらった！',
  'gg', 'ダンジョン50Fむずい', 'ガチャ爆死した', 'ねむい', '初心者です！よろしく',
];
const ctx = ctxFor('evening', null, null);
for (const trigger of TRIGGERS) {
  let answered = 0;
  for (let i = 0; i < 30; i++) {
    const replies = chooseReplies(trigger, ctx);
    if (replies.length) answered++;
    for (const rep of replies) scan(rep.text, `reply/"${trigger.slice(0, 12)}"`);
  }
  if (!answered) bad.push(`no replies ever for "${trigger}"`);
}
check('chooseReplies fuzz (new + old topics)', bad.length === 0, bad.slice(0, 3).join(' | '));

// ---- forced reply target (chat replies to a specific resident) ----
const quiet = roster.find(r => r.chatty <= 0.3);
const forcedCtx = buildCtx({ now: atHour(20), event: null, poll: null, active: [quiet, ...roster.slice(0, 10)], humans: [] });
const forced = chooseReplies('gg', forcedCtx, quiet.name);
check('forced reply: even a lurker answers a direct reply', forced.length > 0 && forced[0].resident.name === quiet.name, forced.length ? forced[0].resident.name : 'no reply');

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
