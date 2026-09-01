// リポジトリのルートから:  node test/secrecy.test.mjs
//
// 🎭 「AIの住人は、管理者以外のプレイヤーには絶対にAIだとバレない」を機械で見張る。
//
// ■ なぜ人の目では足りないのか
// 住人の正体は1本の派手な穴では漏れない。match_found の isBot、プロフィールの
// kind:'resident'、ギルドの ghost:true、キュー画面の botInSec という
// **フィールド名そのもの**、殿堂の resident フラグ、ライブフィードの ⭐（real）…
// 1文字ずつの粉があちこちに落ちている。しかも送信箇所は今後も増える。
// だから「レスポンス全文を再帰的に走査して、禁止キーが1つでも出たら赤」に
// する ── 新しい漏れは、それを足した人が気づく前にここで止まる。
//
// ■ 逆向きも見る
// 管理者パネルは住人と実プレイヤーを区別できないと仕事にならない。
// 同じ経路を管理者トークンで叩いたとき、区別できる情報が **返ること** も
// 確かめる（隠しすぎて運営が困る、を防ぐ）。
//
// ■ 列挙オラクル
// 「実在プレイヤー名」「住人名」「予約名」を /api/register に投げたときの
// 応答が違うと、名前を総当たりするだけで住人が全員あぶり出せる。
// 3つが同じステータス・同じ文言であることを見る。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';
import { CHAMPION, buildRoster } from '../server/residents.js';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
// 保存先にポートを混ぜる。固定名だと、run-all が同時に2つ走ったときに
// 両方が同じフォルダを使い、片方の rmSync がもう片方の db.json を消す
// （並列開発では実際に踏む）。理由の詳細は test/battle.test.mjs を参照。
const DIR = path.join(os.tmpdir(), `bba-secrecy-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なしもある */ }
  return { status: r.status, body: d };
};

let proc = null;
async function start(extraEnv = {}) {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR,
      SESSION_SECRET: 'secrecy-test-secret', SEED_RESTORE: '0', POP_SCALE: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return log; } catch { /* まだ */ }
  }
  throw new Error('server did not start:\n' + log);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---------------------------------------------------------------------------
// 走査器: レスポンス全文を再帰的に見て、正体を明かす痕跡を集める
// ---------------------------------------------------------------------------
// server/sanitize.js の SECRET_KEYS と揃えてある。ここを import で共有しないのは
// わざと ── 実装側の一覧をうっかり空にしても、テストが気づかなくなるため。
const FORBIDDEN = [
  'isBot', 'bot', 'ai', 'resident', 'npc', 'fake', 'ghost', 'human',
  'archLabel', 'archLabelEn', 'arch', 'archs',
  'skill', 'chatty', 'quirk', 'custom', 'registered', 'fakeLevel', 'residentId',
  'botInSec', 'aiVoters', 'realVoters', 'real',
];
const RESIDENT_ID_RE = /^(?:res:)?(?:ghost|r|x)\d+$/;
const isIdKey = k => k === 'id' || (k.length > 2 && k.endsWith('Id'));

function traces(value, where = '$') {
  const found = [];
  const walk = (v, at, depth) => {
    if (depth > 20 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return; }
    for (const [k, raw] of Object.entries(v)) {
      if (FORBIDDEN.includes(k)) found.push(`${at}.${k}`);
      if (k === 'kind' && raw === 'resident') found.push(`${at}.kind='resident'`);
      if (typeof raw === 'string' && isIdKey(k) && RESIDENT_ID_RE.test(raw)) found.push(`${at}.${k}='${raw}'`);
      walk(raw, `${at}.${k}`, depth + 1);
    }
  };
  walk(value, where, 0);
  return found;
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
  const adminLogin = await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } });
  const adminTok = adminLogin.body.token;
  check('管理者ログイン', !!adminTok);
  // にぎわいをONにして住人をボードへ出す（env × live の両方が要る）。
  await j('/api/admin/pop', { method: 'POST', body: { scale: 1 } }, adminTok);

  const player = await j('/api/register', { method: 'POST', body: { username: 'ふつうの一般人', password: 'pass1234' } });
  const tok = player.body.token;
  check('一般プレイヤーを作れる', !!tok, JSON.stringify(player.body).slice(0, 120));
  // ランキングに載るために1戦だけ走らせる（住人と同じボードに並ばせたい）。
  await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1200, lines: 8, maxCombo: 3, duration: 60 } }, tok);

  // -------------------------------------------------------------------------
  // 1. 非管理者に返る全文へ、禁止キーが1つも無いこと
  // -------------------------------------------------------------------------
  const CHAMP = encodeURIComponent(CHAMPION.name);
  // 住人のギルドの id は不透明なので、管理者の目で1つ拾ってから一般の目で叩く。
  const guildsAdmin = await j('/api/guilds', {}, adminTok);
  const ghostGuild = (guildsAdmin.body.guilds || []).find(g => g.ghost);
  check('管理者にはゴーストギルドが ghost 印つきで見える', !!ghostGuild,
    JSON.stringify((guildsAdmin.body.guilds || []).slice(0, 2)).slice(0, 160));

  const PATHS = [
    `/api/profile/${CHAMP}`,
    '/api/leaderboard?board=rating',
    '/api/leaderboard?board=score',
    '/api/leaderboard?board=daily',
    '/api/halloffame',
    '/api/guilds',
    '/api/daily',
    '/api/daily/replays',
    '/api/feed',
    '/api/poll',
    '/api/status',
    ...(ghostGuild ? [`/api/guilds/${encodeURIComponent(ghostGuild.id)}`] : []),
  ];
  for (const label of ['未ログイン', '一般プレイヤー']) {
    const useTok = label === '一般プレイヤー' ? tok : undefined;
    const leaks = [];
    for (const p of PATHS) {
      const r = await j(p, {}, useTok);
      for (const t of traces(r.body, p)) leaks.push(t);
    }
    check(`${label}に返る全レスポンスに禁止キーが0件`, leaks.length === 0, leaks.slice(0, 8).join(' / '));
  }

  // 住人のプロフィールが「ふつうのプレイヤー」と同じ形であること。
  const profRes = await j(`/api/profile/${CHAMP}`, {}, tok);
  const profHuman = await j('/api/profile/ふつうの一般人', {}, tok);
  check('住人のプロフィールは kind:player', profRes.status === 200 && profRes.body.profile.kind === 'player',
    JSON.stringify(profRes.body.profile).slice(0, 160));
  const keysOf = o => Object.keys(o).sort().join(',');
  check('住人と実プレイヤーのプロフィールが同じ欄ぞろえ',
    keysOf(profRes.body.profile) === keysOf(profHuman.body.profile),
    `住人=${keysOf(profRes.body.profile)} / 人間=${keysOf(profHuman.body.profile)}`);

  // 「その名前だけ何をしても反応が無い」を作らない ── 未登録の住人も、
  // 実在しない名前とまったく同じ 404 で返ること。
  const unknown = await j('/api/profile/この名前は誰も使っていない', {}, tok);
  check('知らない名前は404', unknown.status === 404, String(unknown.status));
  // 未登録の住人（ロビーには居るがランキングには載らない人）も同じ404。
  // ここだけ kind:'guest' の名刺が返っていた頃は、「404が返らない名前＝住人」
  // という当たり判定になっていた。
  const guestResident = buildRoster('v1', 600).find(r => !r.registered);
  const unreg = guestResident
    ? await j(`/api/profile/${encodeURIComponent(guestResident.name)}`, {}, tok)
    : null;
  check('未登録の住人も、実在しない名前と同じ404',
    !!unreg && unreg.status === unknown.status && unreg.body.error === unknown.body.error,
    unreg ? `${guestResident.name}: ${unreg.status}:${unreg.body.error}` : '未登録の住人が居ない名簿');

  // -------------------------------------------------------------------------
  // 2. 管理者には従来どおり区別がつくこと（隠しすぎて運営が困らない）
  // -------------------------------------------------------------------------
  const profAdmin = await j(`/api/profile/${CHAMP}`, {}, adminTok);
  check('管理者には kind:resident と archLabel が返る',
    profAdmin.status === 200 && profAdmin.body.profile.kind === 'resident' && !!profAdmin.body.profile.archLabel,
    JSON.stringify(profAdmin.body.profile).slice(0, 200));
  const roster = await j('/api/admin/residents', {}, adminTok);
  check('管理者の名簿に skill / archLabel が載る',
    roster.status === 200 && (roster.body.residents || []).some(r => typeof r.skill === 'number' && r.archLabel),
    JSON.stringify((roster.body.residents || [])[0] || null).slice(0, 200));
  check('/api/admin/* は関門をバイパスしている（削られていない）',
    traces(roster.body).length > 0, `区別できる印 ${traces(roster.body).length}件`);

  // -------------------------------------------------------------------------
  // 3. 列挙オラクル: 名前の3分岐が同じ応答になること
  // -------------------------------------------------------------------------
  const tryName = n => j('/api/register', { method: 'POST', body: { username: n, password: 'pass1234' } });
  const takenReal = await tryName('ふつうの一般人');      // 実在プレイヤー
  const takenRes = await tryName(CHAMPION.name);          // 住人
  const takenRsv = await tryName('運営');                 // 予約語
  const same = takenReal.status === takenRes.status && takenRes.status === takenRsv.status
    && takenReal.body.error === takenRes.body.error && takenRes.body.error === takenRsv.body.error;
  check('/api/register の3分岐が同一ステータス・同一文言', same,
    `${takenReal.status}:${takenReal.body.error} / ${takenRes.status}:${takenRes.body.error} / ${takenRsv.status}:${takenRsv.body.error}`);

  // 改名も同じ（登録だけ塞いでも改名で総当たりできては意味がない）。
  const renamer = await j('/api/register', { method: 'POST', body: { username: '改名したい人', password: 'pass1234' } });
  const rt = renamer.body.token;
  const rn = n => j('/api/me/rename', { method: 'POST', body: { username: n } }, rt);
  const rReal = await rn('ふつうの一般人');
  const rRes = await rn(CHAMPION.name);
  const rRsv = await rn('運営');
  check('/api/me/rename の3分岐も同一ステータス・同一文言',
    rReal.status === rRes.status && rRes.status === rRsv.status
    && rReal.body.error === rRes.body.error && rRes.body.error === rRsv.body.error,
    `${rReal.status}:${rReal.body.error} / ${rRes.status}:${rRes.body.error} / ${rRsv.status}:${rRsv.body.error}`);

  // 🤝 フレンド検索。ランキングやチャットには名前が並ぶのに検索だけ「居ない」
  // だと、それが住人の判定になる。住人も実プレイヤーと同じ形で出て、申請の
  // 断り方（ステータス・文言）も実プレイヤーと区別がつかないこと。
  {
    const fRes = await j('/api/friends/search', { method: 'POST', body: { username: CHAMPION.name } }, tok);
    const fHum = await j('/api/friends/search', { method: 'POST', body: { username: '改名したい人' } }, tok);
    const fNone = await j('/api/friends/search', { method: 'POST', body: { username: 'まったく居ない人' } }, tok);
    check('住人もフレンド検索に出る', fRes.status === 200 && !!fRes.body.user, JSON.stringify(fRes.body).slice(0, 160));
    check('住人と実プレイヤーの検索結果が同じ欄ぞろえ',
      !!fHum.body.user && keysOf(fRes.body.user) === keysOf(fHum.body.user),
      `住人=${fRes.body.user && keysOf(fRes.body.user)} / 人間=${fHum.body.user && keysOf(fHum.body.user)}`);
    check('検索結果に禁止キーが0件', traces(fRes.body, 'search').length === 0, traces(fRes.body, 'search').join(' / '));
    check('居ない人はこれまでどおり user:null', fNone.status === 200 && fNone.body.user === null, JSON.stringify(fNone.body));
    const reqRes = await j('/api/friends/request', { method: 'POST', body: { userId: fRes.body.user.id } }, tok);
    const reqBogus = await j('/api/friends/request', { method: 'POST', body: { userId: 'no-such-user-id' } }, tok);
    check('住人への申請は「知らないid」とまったく同じ断り方',
      reqRes.status === reqBogus.status && reqRes.body.error === reqBogus.body.error,
      `住人=${reqRes.status}:${reqRes.body.error} / 不明=${reqBogus.status}:${reqBogus.body.error}`);
  }

  // ギルドも同じ ── 住人のギルドに加入を試したとき「そんなギルドは無い」と
  // 返ると、それだけで住人のギルドが特定できる。
  if (ghostGuild) {
    const joinGhost = await j('/api/guilds/join', { method: 'POST', body: { id: ghostGuild.id } }, tok);
    const joinNone = await j('/api/guilds/join', { method: 'POST', body: { id: 'no-such-guild-id' } }, tok);
    check('住人のギルドへの加入が「存在しない」とは返らない',
      joinGhost.status !== 404 && joinGhost.body.error !== joinNone.body.error,
      `ghost=${joinGhost.status}:${joinGhost.body.error} / none=${joinNone.status}:${joinNone.body.error}`);
  }

  // -------------------------------------------------------------------------
  // 4. WebSocket のフレーム
  // -------------------------------------------------------------------------
  const wsFrames = (token, guestName, drive) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const got = [];
    const to = setTimeout(() => { try { ws.close(); } catch { /* もう閉じている */ } res(got); }, 20000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      got.push(m);
      if (m.type === 'hello_ok') drive(ws);
      if (m.type === 'match_found') { clearTimeout(to); try { ws.close(); } catch { /* 済み */ } res(got); }
    });
    ws.on('open', () => ws.send(JSON.stringify(token ? { type: 'hello', token } : { type: 'hello', guestName })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });
  const queueUp = ws => ws.send(JSON.stringify({ type: 'queue', mode: 'duel' }));

  const guestFrames = await wsFrames(null, 'こっそり観測者', queueUp);
  const guestLeaks = guestFrames.flatMap(m => traces(m, `ws:${m.type}`));
  check('WSフレーム（一般）に禁止キーが0件', guestLeaks.length === 0, guestLeaks.slice(0, 8).join(' / '));
  const queued = guestFrames.find(m => m.type === 'queued');
  check('待機中の残り秒は中立な名前（matchInSec）で来る',
    !!queued && typeof queued.matchInSec === 'number' && queued.botInSec === undefined,
    JSON.stringify(queued || null).slice(0, 160));
  const mfGuest = guestFrames.find(m => m.type === 'match_found');
  check('match_found の席に isBot が乗らない',
    !!mfGuest && mfGuest.players.every(p => !('isBot' in p)), JSON.stringify(mfGuest && mfGuest.players));

  const adminFrames = await wsFrames(adminTok, null, queueUp);
  const mfAdmin = adminFrames.find(m => m.type === 'match_found');
  check('管理者の match_found には isBot が残る（運営の目は塞がない）',
    !!mfAdmin && mfAdmin.players.some(p => 'isBot' in p), JSON.stringify(mfAdmin && mfAdmin.players));
} catch (err) {
  check('test harness', false, err.stack || String(err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
