// リポジトリのルートから:  node test/wave6.test.mjs
//
// 🩹 第6波の統合で潰した不具合の回帰テスト。
//    「同じ穴が二度と開かない」ことだけを見る ── 直した理由は各検査の
//    コメントに書いてある（コードのコメントと必ず対で読むこと）。
//
// ■ A: 対戦の裁定（server/battle.js）
//   A-1 終了間際に相手が切れても、最後まで遊んだ側が勝つ
//       猶予の終わりは min(now+猶予, ハード終了) なので、終盤の切断では
//       猶予切れ(reason='forfeit')ではなく**ハード終了(reason='timeout')が
//       先に鳴る**。reason だけで裁いていたため、切れた側が点でリードした
//       まま勝ち、最後まで遊んだ側が敗北・レート-16になっていた。
//   A-2 古い猶予の札を捨てるときは、その試合をその場で確定させる
//       「切断→すぐ別の試合に入って切断」で1試合目の猶予タイマーだけが
//       消え、相手がハード終了まで宙吊りになっていた（実測44秒）。
//   A-3 自分で降りた（forfeit フレーム）ときは猶予を通さない
//       ソケットを閉じるだけだと回線事故と区別が付かず、相手が最大25秒
//       待たされ、1日3回の猶予枠まで自分の離脱で減っていた。
//
// ■ B: カスタムルームの観戦席（server/battle.js）
//   B-1 試合中に部屋へ残った人は**全員が観戦者**で、観戦相手を切り替えられる
//   B-2 試合が終わったら、出ていた人が部屋へ戻る
//   B-3 ホストの席割り（観戦席へ回した人）が次の試合へ引き継がれる
//
// ■ C: サーバーを立てない検査（翻訳・実績・復元・書き出し）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';

const PORT = await freePort();
// 保存先にポートを混ぜる（run-all を2つ同時に走らせても踏み合わない）。
const DIR = path.join(os.tmpdir(), `bba-wave6-test-${PORT}`);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// テスト用に縮めた値。実装の既定（試合120秒 / 猶予25秒）のままだと
// 「ハード終了が先に鳴る」窓を踏むのに2分以上待つことになる。
const MATCH_SECS = 6;
const GRACE_MS = 8000;
const COUNTDOWN = 3;
// createMatch の match.timer と同じ式（server/battle.js の matchHardEndAt）。
const HARD_END_MS = (COUNTDOWN + MATCH_SECS + 12) * 1000;

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'wave6-test-secret-key', SEED_RESTORE: '0',
      MATCH_SECONDS: String(MATCH_SECS),
      RECONNECT_GRACE_MS: String(GRACE_MS),
      RECONNECT_GRACE_PER_DAY: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    }
    try { const r = await fetch(`${BASE}/api/status`); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

async function register(username, password = 'passpass1') {
  const r = await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(x => x.json());
  if (!r.token) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.token;
}

// ちいさなWSクライアント（reconnect.test.mjs と同じ作り）。
// ⚠ open の待ち方は readyState を見ること。別のソケットを待っているあいだに
//   開いてしまうと、あとから 'open' を購読しても二度と呼ばれず永久に止まる。
function makeClient({ token = null, guestName = null } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = {};
  const c = {
    ws, inbox,
    send: m => { try { ws.send(JSON.stringify(m)); } catch { /* 閉じかけ */ } },
    got: type => !!(inbox[type] && inbox[type].length),
    last: type => (inbox[type] || [])[(inbox[type] || []).length - 1],
    async wait(type, timeout = 30000) {
      const t0 = Date.now();
      for (;;) {
        if (inbox[type] && inbox[type].length) return inbox[type].shift();
        if (Date.now() - t0 > timeout) {
          throw new Error(`timeout waiting for ${type} (got: ${Object.keys(inbox).filter(k => inbox[k].length).join(',') || 'nothing'})`);
        }
        await sleep(50);
      }
    },
  };
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    (inbox[m.type] = inbox[m.type] || []).push(m);
  });
  ws.on('error', () => { /* 閉じたソケットのエラーは無視 */ });
  return new Promise((res, rej) => {
    const hello = () => c.send({ type: 'hello', token, guestName, role: 'battle' });
    if (ws.readyState === ws.OPEN) hello(); else ws.on('open', hello);
    ws.on('error', rej);
    (async () => { await c.wait('hello_ok', 10000); res(c); })().catch(rej);
  });
}

async function pairDuel(a, b) {
  a.send({ type: 'queue', mode: 'duel' });
  b.send({ type: 'queue', mode: 'duel' });
  const mf = await a.wait('match_found', 20000);
  await b.wait('match_found', 20000);
  return mf;
}

// 部屋の席を "名前:席" で並べた文字列にする（読みやすさのため）。
const seatsOf = u => (u && u.players ? u.players.map(p => `${p.name}:${p.seat}`).join(' ') : '(なし)');

try {
  await start();

  // =========================================================================
  // A-1 終了間際に相手が切れても、最後まで遊んだ側が勝つ
  // =========================================================================
  {
    const tokA = await register('リード側');
    const tokB = await register('最後まで');
    const A = await makeClient({ token: tokA });
    const B = await makeClient({ token: tokB });
    await pairDuel(A, B);
    const t0 = Date.now();
    await sleep(3400);                       // カウントダウン明け
    // A が点でリードする（切れた側が「点で勝ったまま」終われないことを見たい）
    A.send({ type: 'state', score: 3000, combo: 0, lines: 20, grid: new Array(64).fill(0), pieces: 30 });
    B.send({ type: 'state', score: 200, combo: 0, lines: 2, grid: new Array(64).fill(0), pieces: 5 });
    await sleep(300);
    // B は制限時間どおり最後まで遊ぶ
    B.send({ type: 'finish', score: 200, lines: 2, combo: 1 });

    // 🔑 ここが肝。「ハード終了まで残りが猶予より短い」時刻に切る。
    //    こうすると猶予の終わりが min() でハード終了に丸められ、
    //    猶予切れではなく match.timer（reason='timeout'）が先に鳴る。
    const cutAt = HARD_END_MS - GRACE_MS + 1500;
    await sleep(Math.max(0, cutAt - (Date.now() - t0)));
    const remain = HARD_END_MS - (Date.now() - t0);
    A.ws.close();

    const rB = await B.wait('result', 30000);
    check('A-1 切断が「猶予より短い残り時間」に入っている（この窓を踏めていること自体の確認）',
      remain < GRACE_MS && remain > 0, `残り ${Math.round(remain)}ms < 猶予 ${GRACE_MS}ms`);
    // ⚠ reason は**わざと断定しない**。この窓では猶予の終わりが
    //    min(now+猶予, ハード終了) でハード終了ちょうどに丸められるため、
    //    猶予切れのタイマー(forfeit)と試合終了のタイマー(timeout)が
    //    同じミリ秒に並び、どちらが先に鳴るかは実行ごとに変わる。
    //    大事なのは**どちらの順序でも裁定が正しいこと**なので、そこを見る。
    //    「timeout の順序のときだけ壊れる」形の再発は、下の C-0 が
    //    ソースの側から取りこぼしなく捕まえる。
    check('A-1 最後まで遊んだ側が勝つ（点で負けていても、切れた側は棄権）',
      rB.outcome === 'win',
      `outcome=${rB.outcome} reason=${rB.reason} teamScores=${JSON.stringify(rB.teamScores)}`);
    check('A-1 最後まで遊んだ側のレートが下がらない',
      Number(rB.ratingDelta) > 0, `ratingDelta=${rB.ratingDelta} reason=${rB.reason}`);
    B.ws.close();
    await sleep(400);
  }

  // =========================================================================
  // A-2 古い猶予の札を捨てるときは、その試合をその場で確定させる
  // =========================================================================
  {
    const tokC = await register('二重切断');
    const tokD = await register('待たされ側');
    const C1 = await makeClient({ token: tokC });
    const D = await makeClient({ token: tokD });
    await pairDuel(C1, D);
    await sleep(3400);
    C1.send({ type: 'state', score: 400, combo: 0, lines: 3, grid: new Array(64).fill(0), pieces: 8 });
    D.send({ type: 'state', score: 900, combo: 0, lines: 6, grid: new Array(64).fill(0), pieces: 12 });
    await sleep(300);

    const cutAt = Date.now();
    C1.ws.close();                       // 試合1から切断 → 猶予が開く
    await sleep(500);
    // 別のソケットで入り直し、2試合目に入ってからまた切る。
    // ここで試合1の札が「タイマーだけ消えて席は宙吊り」になっていた。
    const C2 = await makeClient({ token: tokC });
    C2.send({ type: 'queue', mode: 'duel' });
    await C2.wait('match_found', 25000);
    await sleep(300);
    C2.ws.close();

    const rD = await D.wait('result', 30000);
    const waited = Date.now() - cutAt;
    // ハード終了まで宙吊りになっていたのが元の症状。猶予切れ（GRACE_MS）
    // の前後で片が付いていればよい ── 少なくともハード終了より十分早いこと。
    check('A-2 1試合目がハード終了まで宙吊りにならない',
      waited < HARD_END_MS - 3000, `決着まで ${waited}ms（ハード終了は ${HARD_END_MS}ms）`);
    check('A-2 残っていた側がちゃんと勝つ', rD.outcome === 'win', `outcome=${rD.outcome} reason=${rD.reason}`);
    D.ws.close();
    await sleep(400);
  }

  // =========================================================================
  // A-3 自分で降りた（forfeit フレーム）ときは猶予を通さない
  // =========================================================================
  {
    const tokE = await register('自分で降りる');
    const tokF = await register('相手側');
    const E = await makeClient({ token: tokE });
    const F = await makeClient({ token: tokF });
    await pairDuel(E, F);
    await sleep(3400);

    const t0 = Date.now();
    E.send({ type: 'forfeit' });          // ✕ →「終了する」と同じ
    E.ws.close();
    const rF = await F.wait('result', 20000);
    const waited = Date.now() - t0;

    check('A-3 相手が猶予ぶん待たされない（即座に決着する）',
      waited < GRACE_MS - 2000, `${waited}ms（猶予は ${GRACE_MS}ms）`);
    check('A-3 棄権として裁かれる（相手の不戦勝）',
      rF.reason === 'forfeit' && rF.outcome === 'win', `reason=${rF.reason} outcome=${rF.outcome}`);
    // 相手に「接続が不安定です」を見せない ── 事故ではなく本人の意思なので。
    check('A-3 相手に「接続が不安定」の帯を出さない', !F.got('opp_unstable'));

    // 1日3回の猶予枠を、自分の離脱で減らさない。
    const db = JSON.parse(fs.readFileSync(path.join(DIR, 'db.json'), 'utf8'));
    const uE = Object.values(db.users).find(u => u.username === '自分で降りる');
    const used = uE && uE.stats && uE.stats.dcGrace ? Number(uE.stats.dcGrace.n) || 0 : 0;
    check('A-3 猶予の回数を消費しない（本当に電波が切れた日のぶんを残す）',
      used === 0, `dcGrace.n=${used}`);
    F.ws.close();
    await sleep(400);
  }

  // =========================================================================
  // B カスタムルームの観戦席
  // =========================================================================
  {
    const host = await makeClient({ guestName: 'ホスト' });
    host.send({ type: 'create_room', settings: { mode: 'duel', duration: 60, botFill: false } });
    const code = (await host.wait('room_update')).code;
    const gs = [];
    for (let i = 1; i <= 3; i++) {
      const g = await makeClient({ guestName: '客' + i });
      g.send({ type: 'join_room', code });
      await g.wait('room_update');
      gs.push(g);
      await sleep(150);
    }
    // ホストが自分を観戦席へ回す（＝benched に入る）
    const hostName = host.last('room_update').players.find(p => p.isYou).name;
    host.send({ type: 'room_seat', name: hostName, seat: 'watch' });
    await sleep(400);
    const before = host.last('room_update');
    check('B 前提: 4人・ホストは観戦席', before.players.length === 4
      && before.players.find(p => p.isYou).seat === 'watch', seatsOf(before));

    host.send({ type: 'room_start' });
    await sleep(1500);
    const during = host.last('room_update');
    const playing = gs.filter(g => g.got('match_found'));
    check('B 前提: 2人が試合に出た', playing.length === 2, playing.length + '人');

    // ---- B-1 試合中は部屋に残った人が全員「観戦席」で、相手を切り替えられる
    check('B-1 試合中は残った人が全員 watch（対戦席への繰り上げをしない）',
      during.players.every(p => p.seat === 'watch'), seatsOf(during));

    const watchers = [host, ...gs.filter(g => !playing.includes(g))];
    const list = during.watchable || [];
    check('B-1 観戦できる相手が2人ぶん届く', list.length === 2, JSON.stringify(list.map(x => x.name)));
    // 全員が「いま見ている人」以外へ切り替えられること。
    const switched = [];
    for (const w of watchers) {
      const cur = w.last('room_update');
      const now = cur && cur.watch ? cur.watch.name : null;
      const other = list.map(x => x.name).find(n => n !== now);
      // ⚠ フレームの欄は target（name ではない）。server/battle.js の case 'watch'。
      w.send({ type: 'watch', target: other });
      await sleep(600);
      const after = w.last('room_update');
      switched.push(after && after.watch ? after.watch.name === other : false);
    }
    check('B-1 観戦者は全員が観戦相手を切り替えられる（席で弾かれない）',
      switched.length === watchers.length && switched.every(Boolean),
      `${switched.filter(Boolean).length}/${switched.length} 人が切り替えられた`);

    // ---- B-2 / B-3 試合が終わったら部屋が元に戻る
    await sleep(2600);                       // カウントダウン明けまで待ってから畳む
    for (const g of playing) g.send({ type: 'finish', score: 100, lines: 1, combo: 1 });
    await sleep(2500);
    const after = host.last('room_update');
    check('B-2 試合に出ていた人が部屋へ戻る（毎試合2人ずつ落ちない）',
      after.players.length === 4, `${after.players.length}人 / ${seatsOf(after)}`);
    check('B-3 ホストの席割りが次の試合へ引き継がれる（毎試合リセットしない）',
      (after.players.find(p => p.name === hostName) || {}).seat === 'watch', seatsOf(after));
    // 観戦していた人が次の対戦席に座る＝交代で遊べている
    const nextPlayers = after.players.filter(p => p.seat === 'play').map(p => p.name);
    const wasWatching = gs.filter(g => !playing.includes(g)).map(g => g.last('room_update').players.find(p => p.isYou).name);
    check('B-3 前の試合で見ていた人が次の対戦席に入る（交代で遊べる）',
      wasWatching.every(n => nextPlayers.includes(n)),
      `次の対戦席=${nextPlayers.join(',')} / 前に見ていた人=${wasWatching.join(',')}`);

    for (const c of [host, ...gs]) c.ws.close();
    await sleep(300);
  }
} catch (err) {
  check('A/B のハーネス', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ===========================================================================
// C サーバーを立てない検査
// ===========================================================================
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- C-0 裁定が reason だけを見ていない（A-1 の順序依存を埋める決定的な検査）
{
  const src = read('server/battle.js');
  // 猶予切れで forfeited を立てた席があったかを控えているか。
  check('C-0 猶予切れで棄権にした席があったかを控えている',
    /graceForfeit\s*=\s*true/.test(src), '');
  // その控えが**勝敗を決める分岐**に効いているか。ここが
  // `reason === 'forfeit'` だけに戻ると、終了間際の切断で
  // 「最後まで遊んだ側が敗北」が復活する。
  check('C-0 勝敗の分岐が reason だけでなく猶予切れも見ている',
    /if \(reason === 'forfeit' \|\| soloForfeit\)/.test(src), '');
  // その上書きは1対1限定であること。3人以上でやると
  // 「players の並びで最初の人間の team」という無意味な側へ倒れる
  // （2v2 で味方が1人切れただけで、点で負けている側が勝ちになる）。
  check('C-0 猶予切れの上書きは1対1のときだけ',
    /graceForfeit && match\.players\.length === 2/.test(src), '');
}

// ---- C-1 翻訳: 日本語が残った半端な訳を「翻訳」として配らない
{
  const { translateLocal } = await import('../server/translate.js');
  // 「すきな色」は 'すき'→'love it' だけが当たり "love itな色" になっていた。
  // 「テスト発言です」は 'です' が消えただけで日本語のまま配られていた。
  const broken = ['すきな色', 'テスト発言です', '本文です'];
  const stillBad = broken.filter(s => {
    const r = translateLocal(s, 'en');
    return r && /[぀-ゟ゠-ヿ一-鿿]/.test(r.text);
  });
  check('C-1 日本語が残ったままの訳を返さない', stillBad.length === 0, stillBad.join(' / ') || '全て訳さないと判断');
  // 訳せるものは今までどおり訳せること（黙って全部止めた、では困る）
  const ok = translateLocal('こんにちは', 'en');
  check('C-1 ちゃんと訳せる文は今までどおり訳す', !!(ok && ok.text === 'hello'), ok ? ok.text : '(null)');
}

// ---- C-2 実績のアイコン
{
  const { ACHIEVEMENTS, achievementsView } = await import('../server/achievements.js');
  const icons = await import('../public/js/icons.js');
  const missing = ACHIEVEMENTS.filter(a => !icons.hasIcon(a.icon)).map(a => `${a.id}:${a.icon}`);
  check('C-2 実績のアイコンはすべて icons.js に実在する', missing.length === 0, missing.slice(0, 5).join(' '));

  // ジャンル違いの取り違え（ギルド＝ダンジョンの絵 など）が戻っていないか。
  // 「段階違い（ach_wave10/20/30）は同じ絵でよい」ので、id の英字の頭を
  // そろえた組だけを同一視する ── 数字を落とした語幹で見る。
  const stem = id => id.replace(/^ach_/, '').replace(/[0-9].*$/, '').replace(/_$/, '');
  const byIcon = new Map();
  for (const a of ACHIEVEMENTS) {
    if (!byIcon.has(a.icon)) byIcon.set(a.icon, new Set());
    byIcon.get(a.icon).add(stem(a.id));
  }
  // 一度でも「別ジャンルが同じ絵を共有」していた組を名指しで見張る。
  const pinned = [
    ['ach_guild', 'guild'], ['ach_guild2k', 'guild'],
    ['ach_rush', 'mode_boss'], ['ach_wave10', 'mode_survival'],
    ['ach_wave20', 'mode_survival'], ['ach_wave30', 'mode_survival'],
    ['ach_ae_join', 'mode_adminevent'], ['ach_ae_10', 'mode_adminevent'],
    ['ach_rate1700', 'rating'],
  ];
  const wrong = pinned.filter(([id, want]) => {
    const a = ACHIEVEMENTS.find(x => x.id === id);
    return !a || a.icon !== want;
  }).map(([id, want]) => `${id}→${want}`);
  check('C-2 別ジャンルの絵の取り違えが戻っていない', wrong.length === 0, wrong.join(' '));

  // 受け取り済みは必ず「解除済み」。管理者シードは受取済だけ全部入れるので、
  // ここが外れると「解除 84 / 124 ・ 受取済 124」が復活する。
  const u = { stats: {}, achievements: ACHIEVEMENTS.map(a => a.id), owned: [], badges: [], guildId: null, level: 1 };
  const v = achievementsView(u);
  check('C-2 受取済の数が解除の数を超えない', v.claimedCount <= v.unlocked, `解除${v.unlocked} / 受取済${v.claimedCount}`);
}

// ---- C-3 復元（backup.js）
{
  const backup = await import('../server/backup.js');
  const src = read('server/backup.js');
  // 🏗️ ブループリントの日次印。落ちると復元した日にもう一度勝利ぶんを取れる。
  check('C-3 mergeEarned が bpDay を引き継ぐ', /bpDay/.test(src),
    /bpDay/.test(src) ? 'bpDay あり' : '⚠ backup.js に bpDay が1つも無い');
  // 合流(union)にも書き込み口と同じ上限が掛かっていること。
  // ⚠ 値は backup.js が持ち、ここで**書き込み口のソースから読んで**突き合わせる
  //    （写経すると片方だけ直したときに黙ってズレる）。
  const idx = read('server/index.js');
  const shop = read('server/routes/shop.js');
  // ⚠ `db.news.length > 0`（空かどうかの判定）も5箇所あるので、
  //    **切り詰めている行**だけを拾う（shift とセットになっているもの）。
  const newsCap = Number((idx.match(/db\.news\.length\s*>\s*(\d+)\)\s*db\.news\.shift\(\)/) || [])[1]);
  const bugCap = Number((idx.match(/BUGREPORT_CAP\s*=\s*(\d+)/) || [])[1]);
  const txCap = Number((shop.match(/TX_KEEP\s*=\s*(\d+)/) || [])[1]);
  check('C-3 news の上限が書き込み口と一致', backup.NEWS_CAP === newsCap, `backup=${backup.NEWS_CAP} index=${newsCap}`);
  check('C-3 bugreports の上限が書き込み口と一致', backup.BUGREPORT_CAP_MIRROR === bugCap, `backup=${backup.BUGREPORT_CAP_MIRROR} index=${bugCap}`);
  check('C-3 transactions の上限が書き込み口と一致', backup.TX_CAP === txCap, `backup=${backup.TX_CAP} shop=${txCap}`);
  // 実際に切っているか（push しっぱなしに戻っていないか）
  for (const [name, arr] of [['news', 'db.news'], ['transactions', 'db.transactions'], ['bugreports', 'db.bugreports']]) {
    check(`C-3 合流のあと ${name} を上限で切っている`,
      new RegExp(`${arr.replace('.', '\\.')}\\s*=\\s*${arr.replace('.', '\\.')}\\.slice\\(-`).test(src), '');
  }
}

// ---- C-4 v2.36「絵文字→独自アイコン」の取りこぼし
{
  // サントラの書き出しは TRACK_INFO の欄が icon → iconName に変わったのに
  // 追随しておらず、動画とサムネの中央に "undefined" を焼き込んでいた。
  const yt = read('public/js/ytexport.js');
  const audio = read('public/js/audio.js');
  check('C-4 audio.js の TRACK_INFO は iconName を持つ（欄名の前提の確認）',
    /iconName:/.test(audio) && !/\bicon:\s*'/.test(audio), '');
  // コメント中の言及は許すので、「コードとして info.icon / x.icon を読む」形だけを見る。
  const ytCode = yt.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('C-4 ytexport が存在しない .icon を読んでいない',
    !/\binfo\.icon\b/.test(ytCode) && !/\$\{x\.icon\}/.test(ytCode), '');

  // 実績解除の速報は**絵文字**で流すこと。icons.js の名前を渡すと
  // 「throne るみまき が実績…」と生の名前が流れるうえ、住人の行(crowd.js)は
  // 必ず絵文字なので「生の名前の行＝必ず人間」の目印になってしまう。
  const missions = read('server/routes/missions.js');
  const feedLine = (missions.match(/postRealFeed\(req\.user, \[\{ icon: [^\n]*/) || [''])[0];
  check('C-4 実績の速報が icons.js の名前ではなく絵文字を渡している',
    /icon:\s*'[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(feedLine),
    feedLine.slice(0, 80));
}

// ---- C-5 観戦の後始末が1か所にまとまっている
{
  const modes = read('public/js/modes.js');
  // ルーム観戦とロイヤルの脱落後観戦で、隠すものの列挙が二重に書かれていた
  // （ロイヤル側だけ抜けていて、リロールが死にボタンとして残っていた）。
  check('C-5 観戦時の後始末が関数にまとまっている', /enterSpectatorHud\(\)\s*\{/.test(modes), '');
  const calls = (modes.match(/this\.enterSpectatorHud\(\)/g) || []).length;
  check('C-5 ルーム観戦とロイヤル観戦の両方から呼んでいる', calls >= 2, `呼び出し ${calls} 箇所`);
  // 観戦をやめるだけの人に「敗北になります」と言わない。
  check('C-5 ルーム観戦の離脱を敗北と書かない（quitWarning）',
    /if \(this\.spectatingRoom\) return null;/.test(modes), '');
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${failed ? '❌' : '✅'} wave6: ${results.length - failed} 件成功 / ${failed} 件失敗`);
