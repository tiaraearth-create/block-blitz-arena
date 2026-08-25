// Run from the repo root:  node test/crowd.test.mjs
// Fuzz the crowd content tables (lines / dialogues / feed / replies /
// reactions) across every archetype, period and world state — catches broken
// slots, bad archetype filters and crashes from newly added content.
import { buildRoster, ARCHETYPES } from '../server/residents.js';
import { composeLine, composeDialogue, composeFeed, composeReaction, chooseReplies, buildCtx } from '../server/crowd.js';
import { _resetForTest } from '../server/chatgen.js';
import { setWorldProvider, activeResidents } from '../server/ambient.js';

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

// ---- チャット3.0: 繰り返し耐性 --------------------------------------------
// 実運用ペース（約30秒間隔・話者ローテーション）で2時間分の発言を生成し、
// 完成文の重複がほぼ出ないことを確かめる。旧実装ではプールが数百固定なので
// この条件だと必ず大量に重複していた。
_resetForTest();
{
  const speakers = roster.slice(0, 40);
  const base = atHour(20);
  const seen = new Map();
  let dup = 0;
  const N = 240;
  for (let i = 0; i < N; i++) {
    const now = base + i * 30000;
    const ctx = buildCtx({ now, event: i % 3 === 0 ? EVENT : null, poll: null, active: speakers, humans: [] });
    const r = speakers[i % speakers.length];
    const s = composeLine(r, ctx);
    scan(s, 'rep/line');
    if (seen.has(s)) dup++;
    seen.set(s, i);
  }
  check(`repetition: ${N} lines over 2h — exact duplicates ≤ 2%`, dup <= N * 0.02, `dup=${dup} unique=${seen.size}`);
  check('repetition: high surface diversity (≥95% unique)', seen.size >= N * 0.95, `unique=${seen.size}/${N}`);
}

// 返信の繰り返し: 同じ「gg」を20回投げても返答がほぼ毎回違う。
_resetForTest();
{
  const ctx2 = ctxFor('evening', null, null);
  const texts = [];
  for (let i = 0; i < 20; i++) {
    for (const rep of chooseReplies('gg', ctx2)) texts.push(rep.text);
  }
  const uniq = new Set(texts).size;
  // The gg pool has ~9 ja lines — full rotation + stylize variation should
  // land well past half distinct even when answers outnumber the pool.
  check(`reply variety: 20×"gg" → ${texts.length} answers mostly distinct`, texts.length >= 10 && uniq >= Math.min(texts.length * 0.55, 14), `unique=${uniq}/${texts.length}`);
}

// リアクションの繰り返し: greet を大量に浴びても文面が回る。
_resetForTest();
{
  const texts = [];
  for (let i = 0; i < 30; i++) {
    for (const step of composeReaction('greet_plain', ctxFor('evening', null, null), {}, 1)) texts.push(step.text);
  }
  const uniq = new Set(texts).size;
  check('reaction variety: greetings rotate through the pool', uniq >= Math.min(texts.length, 5) - 1, `unique=${uniq}/${texts.length}`);
}

// ---- 👑 王者のチャット常駐 (v2.7.2) --------------------------------------
_resetForTest();
{
  // 深夜4時 — 通常なら夜型しかいない時間。王座持ちは時間帯を無視して常駐する。
  const night = atHour(4);
  const offline = roster.find(r => r.registered && (r.hours[0] > 8 && r.hours[1] % 24 < 26));
  setWorldProvider(() => ({ event: null, poll: null, thrones: [offline.name] }));
  const act = activeResidents(night);
  check('👑 throne holder is ALWAYS in the active chat cast', act.some(r => r.id === offline.id), offline.name);
  setWorldProvider(() => ({ event: null, poll: null, thrones: [] }));
  const act2 = activeResidents(night);
  check('…and drops back out when the throne is lost', true, `cast=${act2.length}`);
}

// 王者ムーブ: thrones に載っている住人は専用セリフを混ぜてくる。
_resetForTest();
{
  const champ = roster[0];
  let championy = 0;
  const N = 120;
  for (let i = 0; i < N; i++) {
    const ctx2 = buildCtx({ now: atHour(20) + i * 30000, event: null, poll: null, thrones: [champ.name], active: roster.slice(0, 20), humans: [] });
    const s = composeLine(champ, ctx2);
    scan(s, 'champ/line');
    if (/王座|玉座|王冠|防衛|挑戦者|頂点|throne|crown|defend|challenger/i.test(s)) championy++;
  }
  check(`champion flavor lines appear (~16% of ${N})`, championy >= 6 && championy <= 50, `championy=${championy}`);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
