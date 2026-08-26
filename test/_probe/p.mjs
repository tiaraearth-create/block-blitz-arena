import { Engine } from '../../public/js/engine.js';
import { chooseMove } from '../../public/js/ai.js';
import { createSession, tick, submitCut, stateView } from '../../server/zero-session.js';
import { danHpFor, sealHpFor, softCapFor, cutDamageFor, seatsFor, lanesFor } from '../../server/zero.js';

let CLOCK = 1_000_000;
const now = () => CLOCK;
let SEED = 999;
const random = () => { SEED = (SEED * 1103515245 + 12345) % 2147483648; return SEED / 2147483648; };
const fakeSock = n => ({ _name: n, readyState: 1, OPEN: 1 });
let pn = 0;
const deps = () => ({
  Engine, chooseMove, sockName: ws => ws._name, now, random,
  uuid: () => 's' + (++pn),
  pickResidentBot: () => null, pickPersona: () => ({ name: 'p' + (++pn) }),
  emit: () => {}, say: () => {}, attack: () => {}, onDanBroken: () => {},
});
const freshRun = () => ({ dan: 0, dealt: 0, sealDealt: 0, cuts: 0, fallen: [], broken: [], dayKey: 'x' });

// A: 1 room, 1 human (what battle.js actually does for one player)
function runRooms(nRooms, minutes) {
  CLOCK = 1_000_000; SEED = 999;
  const run = freshRun();
  const sessions = [];
  for (let i = 0; i < nRooms; i++) sessions.push(createSession(deps(), [fakeSock('H' + i)]));
  const d = deps();
  const end = CLOCK + minutes * 60_000;
  while (CLOCK < end) {
    CLOCK += 250;
    for (const s of sessions) tick(s, run, d);
  }
  return { dan: run.dan, dealt: run.dealt, softCap: softCapFor(run.dan | 0, 1, run), bots: sessions[0].entrants.filter(e => !e.human).length };
}
console.log('1 room  10min:', JSON.stringify(runRooms(1, 10)));
console.log('12 rooms 10min:', JSON.stringify(runRooms(12, 10)));

// B: what the intended one-room-12-humans looks like
CLOCK = 1_000_000; SEED = 999;
const many = createSession(deps(), Array.from({ length: 12 }, (_, i) => fakeSock('H' + i)));
console.log('intended 12-human room: humans=', many.humans, 'seats=', seatsFor(12), 'lanes=', lanesFor(12),
  'hp=', danHpFor(0, 12, null), 'seal=', sealHpFor(0, 12, null), 'cut=', cutDamageFor(0, 12, {}));
console.log('actual solo room:      humans=1 hp=', danHpFor(0, 1, null), 'seal=', sealHpFor(0, 1, null), 'cut=', cutDamageFor(0, 1, {}), 'lanes=', lanesFor(1));

// C: dealHalve mid-stage
{
  const run = freshRun();
  run.dealt = softCapFor(0, 1, run);          // 点は上限まで
  run.sealDealt = cutDamageFor(0, 1, {}) * 12; // 12回斬った（必要24回の半分）
  console.log('before halve: seal=', sealHpFor(0,1,run), 'sealDealt=', run.sealDealt, 'broken?', run.sealDealt >= sealHpFor(0,1,run));
  run.dealHalve = true;
  console.log('after  halve: seal=', sealHpFor(0,1,run), 'softCap=', softCapFor(0,1,run), 'dealt=', run.dealt,
    'broken?', run.sealDealt >= sealHpFor(0,1,run) && run.dealt >= softCapFor(0,1,run) - 0.5);
}
