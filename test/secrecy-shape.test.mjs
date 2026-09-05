// リポジトリのルートから:  node test/secrecy-shape.test.mjs
//
// 🎭 「禁止キーは1つも出ていないのに、**欄の有無**で住人と実プレイヤーが仕分けできる」
//    という形の漏れを見張る。
//
// ■ なぜ別のファイルなのか
// test/secrecy.test.mjs は traces()＝「禁止キー名が出たか」で見ている。
// これは *余計な欄が付いた* 漏れしか捕まえられない。実際に起きていたのは逆で、
//
//   ・順位表: 実プレイヤーの行にだけ dailyScore が付き、住人の行には無かった
//     → 無認証の /api/leaderboard 1回で、板の上の全員が誤り0で仕分けできた
//   ・ライブフィード: 住人の行にだけ id（テンプレの内部名）が付いていた
//     → 未ログインのゲストがトップを開いた瞬間に届くデータで仕分けできた
//   ・フレンド検索: 住人だけ status:'online'（実プレイヤーには構造的に出ない値）
//     → しかも画面の STATUS 表にその鍵が無いので、状態欄が空白で描かれる
//   ・/api/profile: 実プレイヤーだけ完全一致で引いていた
//     → 表記を変えた名前で叩くと住人だけ 200 が返る
//
// どれも禁止キーは0件なので、73本ぜんぶ緑のまま実機で再現した。
// 「同じ配列に並ぶ行は、全行が同じ欄ぞろえであること」を機械で見る。
//
// ■ 見るもの
//   A. /api/leaderboard の rows が、全部門・全行で同じキー集合
//   B. /api/feed の項目が全行で同じキー集合（WSで届くフィードも同じ）
//   C. フレンド検索の status が、実プレイヤーに返りうる語彙の中にある
//   D. 住人の lastSeen が、続けて2回引いても動かない
//   E. /api/profile が大文字小文字で住人と実プレイヤーを区別しない
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { freePort, waitForServer } from './_port.mjs';
import { buildRoster } from '../server/residents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-secshape-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なしもある */ }
  return { status: r.status, ...d };
};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR,
      SESSION_SECRET: 'secshape-test', SEED_RESTORE: '0', POP_SCALE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(proc, BASE);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

// 行の「形」。値ではなくキー集合だけを見る。
// throne / crowns は「王座を持っている人にだけ付く印」で、画面に王冠として
// 出ている公開情報なので比較から外す（住人も実プレイヤーも同じ条件で付く）。
const IGNORE = new Set(['throne', 'crowns']);
const shapeOf = o => Object.keys(o).filter(k => !IGNORE.has(k)).sort().join(',');

function shapesIn(rows) {
  const m = new Map();
  for (const r of rows) {
    const s = shapeOf(r);
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(r.username || r.who || r.name || '?');
  }
  return m;
}

// 2つのキー集合の差分を読める形にする（どの欄が片側にしか無いか）。
function diffOf(a, b) {
  const A = new Set(a.split(',')), B = new Set(b.split(','));
  const onlyA = [...A].filter(k => !B.has(k));
  const onlyB = [...B].filter(k => !A.has(k));
  return `片方だけ: [${onlyA.join(' ')}] / もう片方だけ: [${onlyB.join(' ')}]`;
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

  // 実プレイヤーを板に載せる（載っていないと形の比較ができない）。
  const me = await j('/api/register', { method: 'POST', body: { username: 'ホンモノ太郎', password: 'pw-secshape-1' } });
  check('下ごしらえ: アカウントを作れた', !!me.token, me.error || '');
  await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 4200, lines: 20, duration: 90, pieces: 40 } }, me.token);
  await sleep(200);

  // -------------------------------------------------------------------------
  // A. 順位表 — 全部門で行の欄ぞろえが1種類
  // -------------------------------------------------------------------------
  const boardsRes = await j('/api/leaderboard?board=score');
  check('A-0 未ログインで順位表を取れる', boardsRes.status === 200 && Array.isArray(boardsRes.rows),
    String(boardsRes.status));

  // 部門の一覧はサーバーが返すものを使う（書き写した定数が実装とずれるのを避ける）。
  const BOARDS = Array.isArray(boardsRes.boards) && boardsRes.boards.length
    ? boardsRes.boards.map(b => (typeof b === 'string' ? b : b.id)).filter(Boolean)
    : ['score', 'rating', 'weekly', 'daily', 'sprint', 'dungeon', 'puzzle', 'dig',
      'meltdown', 'chimera', 'chain', 'survival', 'rush', 'blueprint', 'under', 'heaven', 'abyss'];

  let boardsChecked = 0;
  const boardProblems = [];
  for (const b of BOARDS) {
    const r = await j(`/api/leaderboard?board=${encodeURIComponent(b)}`);
    if (r.status !== 200 || !Array.isArray(r.rows) || r.rows.length < 2) continue;
    boardsChecked++;
    const shapes = shapesIn(r.rows);
    if (shapes.size !== 1) {
      const [s1, s2] = [...shapes.keys()];
      boardProblems.push(`${b}: ${shapes.size}種 / ${diffOf(s1, s2)}`);
    }
  }
  check('A-1 十分な数の部門を見た', boardsChecked >= 6, `${boardsChecked}部門`);
  check('A-2 順位表はどの部門でも行の欄ぞろえが1種類だけ', boardProblems.length === 0,
    boardProblems.slice(0, 3).join(' ｜ '));

  // 実プレイヤーが実際にその板に載っていることを確かめる（載っていなければ
  // 「1種類」は自明に成立してしまい、検査が黙って無効になる）。
  const scoreRows = (await j('/api/leaderboard?board=score')).rows || [];
  check('A-3 板の上に実プレイヤーが載っている（検査が空振りしていない）',
    scoreRows.some(r => r.username === 'ホンモノ太郎'), `${scoreRows.length}行`);

  // -------------------------------------------------------------------------
  // B. ライブフィード — 住人の行と実プレイヤーの行が同じ形
  // -------------------------------------------------------------------------
  // 参加通知が実プレイヤーのフィード項目になる。
  await j('/api/register', { method: 'POST', body: { username: 'ホンモノ次郎', password: 'pw-secshape-1' } });
  await sleep(400);
  const feedRes = await j('/api/feed');
  const feed = feedRes.feed || [];
  check('B-0 未ログインでフィードを取れる', feedRes.status === 200 && feed.length >= 2, `${feed.length}件`);
  const feedShapes = shapesIn(feed);
  const fk = [...feedShapes.keys()];
  check('B-1 フィードの項目は全部同じ欄ぞろえ', feedShapes.size <= 1,
    fk.length >= 2 ? diffOf(fk[0], fk[1]) : '');
  check('B-2 フィードに実プレイヤー由来の行がある（検査が空振りしていない）',
    feed.some(f => /ホンモノ/.test(String(f.who || '') + String(f.text || ''))),
    feed.map(f => f.who).slice(0, 6).join(' '));
  check('B-3 フィードに内部テンプレ名（id）が載っていない',
    !feed.some(f => Object.prototype.hasOwnProperty.call(f, 'id')), '');

  // WS で届くフィードも同じ形（ゲストが接続した瞬間に受け取るもの）。
  const wsFeed = await new Promise(resolve => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const done = v => { try { ws.close(); } catch { /* 閉じるだけ */ } resolve(v); };
    const timer = setTimeout(() => done([]), 8000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'hello_ok') { clearTimeout(timer); done(m.feed || []); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', guestName: 'ゲスト見物人' })));
    ws.on('error', () => { clearTimeout(timer); done([]); });
  });
  check('B-4 ゲストのWSに届くフィードも欄ぞろえが1種類', shapesIn(wsFeed).size <= 1,
    `${wsFeed.length}件 / ${[...shapesIn(wsFeed).keys()].length}種`);

  // -------------------------------------------------------------------------
  // C/D. フレンド検索 — 状態の語彙と lastSeen
  // -------------------------------------------------------------------------
  // 実プレイヤーに返りうる状態の語彙は statusOf（server/battle.js）が唯一の正解。
  // 書き写さず、実装から読み取る。
  const battleSrc = fs.readFileSync(path.join(ROOT, 'server', 'battle.js'), 'utf8').replace(/\r\n/g, '\n');
  const statusFn = battleSrc.slice(battleSrc.indexOf('function statusOf('));
  const statusBody = statusFn.slice(0, statusFn.indexOf('\n  }') + 4);
  const VOCAB = new Set((statusBody.match(/return '([a-z]+)'/g) || []).map(s => s.slice(8, -1)));
  check('C-0 statusOf の語彙を実装から読み取れた', VOCAB.size >= 3, [...VOCAB].join('/'));

  const roster = buildRoster('v1', 600).filter(r => r.registered);
  const picks = roster.slice(0, 6);
  const bad = [];
  const seen1 = new Map();
  for (const r of picks) {
    const s = await j('/api/friends/search', { method: 'POST', body: { username: r.name } }, me.token);
    if (!s.user) continue;
    if (!VOCAB.has(s.user.status)) bad.push(`${r.name}=${s.user.status}`);
    seen1.set(r.name, s.user.lastSeen);
  }
  check('C-1 住人の検索結果の状態が、実プレイヤーにも返りうる語彙の中にある',
    bad.length === 0 && seen1.size > 0, bad.length ? bad.join(' ') : `${seen1.size}人ぶん確認`);

  await sleep(1500);
  // 実プレイヤーの lastSeen も段（server/battle.js の 300_000）でしか動かないので、
  // 「まったく動かない」ではなく「**経過時間のぶんだけ動かない**」を見る。
  // 段の大きさは実装から読み取る（書き写さない）。
  const socialSrc = read('server/routes/social.js');
  const stepM = socialSrc.match(/const SEEN_STEP = (\d+) \* (\d[\d_]*);/);
  const STEP = stepM ? Number(stepM[1]) * Number(stepM[2].replace(/_/g, '')) : 300000;
  check('D-0 lastSeen の刻みを実装から読み取れた', STEP >= 60000, `${STEP}ms`);
  const moved = [];
  for (const [name, was] of seen1) {
    const s = await j('/api/friends/search', { method: 'POST', body: { username: name } }, me.token);
    if (!s.user) continue;
    const delta = s.user.lastSeen - was;
    // 0（同じ段の中）か、ちょうど1段ぶん（段をまたいだ）だけを許す。
    // 経過時間（1.5秒）ぶん動いたら、それが判別印になる。
    if (delta !== 0 && delta !== STEP) moved.push(`${name}: ${was} → ${s.user.lastSeen} (差 ${delta})`);
  }
  check('D-1 住人の lastSeen が経過時間のぶん動かない', moved.length === 0, moved.slice(0, 3).join(' ｜ '));
  // 離席中の住人が全員そろって同じ時刻になっていないこと（それ自体が印になる）。
  const offlineSeen = [...seen1.values()];
  check('D-2 住人の lastSeen が全員同じ値でそろっていない',
    new Set(offlineSeen).size > 1 || offlineSeen.length < 2, `${new Set(offlineSeen).size}種 / ${offlineSeen.length}人`);

  // -------------------------------------------------------------------------
  // E. /api/profile — 大文字小文字で住人と実プレイヤーの当たり方が変わらない
  // -------------------------------------------------------------------------
  // ASCII名の住人を1人選ぶ（表記を変えられる名前でないと試せない）。
  const ascii = roster.find(r => /^[A-Za-z][A-Za-z0-9 _-]*$/.test(r.name));
  await j('/api/register', { method: 'POST', body: { username: 'AsciiTaro', password: 'pw-secshape-1' } });
  const flip = s => s.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');

  const humanExact = await j('/api/profile/AsciiTaro');
  const humanFlip = await j(`/api/profile/${encodeURIComponent(flip('AsciiTaro'))}`);
  check('E-0 実プレイヤーは正しい表記で引ける', humanExact.status === 200, String(humanExact.status));
  if (ascii) {
    const resExact = await j(`/api/profile/${encodeURIComponent(ascii.name)}`);
    const resFlip = await j(`/api/profile/${encodeURIComponent(flip(ascii.name))}`);
    check('E-1 住人も正しい表記で引ける', resExact.status === 200, `${ascii.name} → ${resExact.status}`);
    check('E-2 表記を崩したときの返りが、住人と実プレイヤーで同じ',
      resFlip.status === humanFlip.status,
      `住人 ${resFlip.status} / 人間 ${humanFlip.status}（この差が「住人だけ当たる」判定器になっていた）`);
  } else {
    check('E-1 住人も正しい表記で引ける', true, 'ASCII名の住人がいないので省略');
    check('E-2 表記を崩したときの返りが、住人と実プレイヤーで同じ', true, '同上');
  }

  // -------------------------------------------------------------------------
  // F. ソースの形（直しが1か所に寄っているか）
  // -------------------------------------------------------------------------
  const idx = read('server/index.js');
  check('F-1 順位表の行の形が1か所の表から出ている', /const lbRowShape = \(\) => \(\{/.test(idx), '');
  check('F-2 実プレイヤーの行もその表を土台にしている', /\.\.\.lbRowShape\(\),\n    username: u\.username,/.test(idx), '');
  check('F-3 住人・埋め草の行もその表を土台にしている', /\.\.\.lbRowShape\(\), \.\.\.r, guildTag: ghostTagOf/.test(idx), '');
  check('F-4 フィードが id を組み立てていない', !/id: f\.id, icon: f\.icon/.test(read('server/crowd.js')), '');
  check('F-5 検索の状態が online を返していない', !/status: online \? 'online'/.test(read('server/routes/social.js')), '');

  // -------------------------------------------------------------------------
  // G. 派生ボードの値が「素の強さ × 定数」になっていないか
  //
  //   ⚠ ここは**値で見るしかない**。ソースの形（BOARD_VALUE に entry があるか）を
  //     見る検査では原理的に捕まらない種類の抜けで、実際にすり抜けた:
  //     正規化の分母にも倍率を掛けていたせいで約分で消え、住人の
  //     meltdownBest と chimeraBest が**必ず同じ値**になり、しかもどちらも
  //     bestScore のちょうど定数倍だった。公開ランキングは無認証で100行返るので、
  //     1リクエスト＋割り算1回で板の上の住人が全員あぶり出せた。
  //     実プレイヤーの各欄は別々の記録から来る独立の値なので、この関係は
  //     絶対に成立しない ＝ 完全な判別器。
  // -------------------------------------------------------------------------
  const ambient = await import('../server/ambient.js');
  if (ambient.setLiveScale) ambient.setLiveScale(1);
  const gScore = ambient.ghostRows('score', 'w1', new Set());
  check('G-0 前提: 住人の行を取れた', gScore.length >= 8, `${gScore.length}行`);
  const sameMC = gScore.filter(r => r.meltdownBest === r.chimeraBest).length;
  check('G-1 メルトダウンとキメラの値が一致する行が無い', sameMC === 0, `${sameMC}/${gScore.length}行`);
  const ratioKinds = (rows, a, b) => new Set(rows.filter(r => r[b]).map(r => (r[a] / r[b]).toFixed(4))).size;
  for (const [a, b] of [['meltdownBest', 'bestScore'], ['chimeraBest', 'bestScore']]) {
    const kinds = ratioKinds(gScore, a, b);
    check(`G-2 ${a} ÷ ${b} が全員同じにならない`, kinds > Math.max(3, gScore.length * 0.5),
      `${kinds}種 / ${gScore.length}行`);
  }
  const gDun = ambient.ghostRows('dungeon', 'w1', new Set());
  for (const k of ['underMax', 'heavenMax']) {
    const kinds = ratioKinds(gDun, k, 'dungeonMax');
    check(`G-3 ${k} ÷ dungeonMax が全員同じにならない`, kinds > Math.max(3, gDun.length * 0.5),
      `${kinds}種 / ${gDun.length}行`);
  }
  // ⚠ 比の種類だけでは弱い ── 定数倍でも Math.round のせいで比は少しずつ違う
  //   （旧実装でも24種あった＝この検査だけでは素通りする）。
  //   決め手は「**元の値から予測できてしまうか**」。定数倍だと、塔の階が同じ
  //   2人は地下の値も必ず同じになる ── そこから「地下＝塔×0.85」と読み取れれば、
  //   1行見るだけでその行が合成物だと分かる。人ごとの係数が入っていれば割れる。
  //   （実測: 旧実装は同じ塔階の31組すべてで地下も同一。いまは30/31組が割れる）
  if (ambient.setLiveScale) ambient.setLiveScale(12);
  const big = ambient.ghostRows('dungeon', 'w1', new Set());
  for (const k of ['underMax', 'heavenMax']) {
    const byTower = new Map();
    for (const r of big) {
      if (!byTower.has(r.dungeonMax)) byTower.set(r.dungeonMax, []);
      byTower.get(r.dungeonMax).push(r[k]);
    }
    const dup = [...byTower.values()].filter(v => v.length > 1);
    const split = dup.filter(v => new Set(v).size > 1);
    check(`G-3b ${k} が塔の階から予測できない`,
      dup.length >= 5 && split.length >= dup.length * 0.6,
      `同じ塔階の組 ${dup.length} / 値が割れている組 ${split.length}`);
  }
  if (ambient.setLiveScale) ambient.setLiveScale(1);
  // 「板の1位なのに、そのバッジを持っていない」も規則上ありえない行。
  const gRush = ambient.ghostRows('rush', 'w1', new Set());
  const rushBad = gRush.filter(r => ((r.badges || []).includes('rush')) !== (r.rushDepth >= 12));
  check('G-4 ボスラッシュの深度と🔥制覇バッジが食い違わない', rushBad.length === 0,
    rushBad.slice(0, 3).map(r => `${r.username}:${r.rushDepth}`).join(' '));
  // 回数系の板は「そのモードでいちばん難しい実績のしきい値」の内側に収まること。
  const capOK = [
    ['survival', 'survivalWave', 30], ['chain', 'chainMax', 10], ['blueprint', 'blueprintClears', 30],
  ];
  for (const [board, key, top] of capOK) {
    const rows = ambient.ghostRows(board, 'w1', new Set());
    const over = rows.filter(r => (r[key] || 0) >= top);
    check(`G-5 ${board} 板が人間の最高実績（${top}）に届かない`, over.length === 0,
      over.slice(0, 3).map(r => `${r.username}:${r[key]}`).join(' ') || `最大 ${Math.max(0, ...rows.map(r => r[key] || 0))}`);
  }
  // チャットが言う数字と板の数字が食い違わないこと（食い違い自体が判別器になる）。
  const crowdSrc = read('server/crowd.js');
  check('G-6 チャットのWAVEが自己ベストを超えない',
    /Math\.min\(st\.survivalWave, st\.survivalWave \+ rint\(-3, 0\)\)/.test(crowdSrc), '');

  // -------------------------------------------------------------------------
  // H. 名前が並ぶ面（ロイヤル・大会・ゲスト名）
  //    どれも「片方にだけ起きること」が判別器になっていた形。
  // -------------------------------------------------------------------------
  const battleSrc2 = read('server/battle.js');
  const ambientSrc = read('server/ambient.js');
  // 実在のプレイヤーのゲスト名は 0〜9998、住人・埋め草は必ず 1000〜9999 の4桁
  // だったので、**3桁以下のゲスト名は必ず生身の人間**と分かった。
  const humanGuest = battleSrc2.match(/ゲスト\$\{([^}]+)\}/);
  check('H-1 ゲスト名の番号帯を住人とそろえている',
    !!humanGuest && /1000 \+ Math\.floor\(Math\.random\(\) \* 9000\)/.test(humanGuest[1]),
    humanGuest ? humanGuest[1] : '見つからない');
  check('H-1b 住人側の番号帯も同じ（1000〜9999）',
    /ゲスト\$\{1000 \+ Math\.floor\(rnd\(\) \* 9000\)\}/.test(ambientSrc), '');
  // ロイヤル優勝の全体告知が「勝者が人間のときだけ」だと、結果カードの名前と
  // チャットの告知を見比べるだけで住人だと確定できた。
  check('H-2 ロイヤル優勝の告知を勝者の種類で出し分けていない',
    !/if \(winner && winner\.human\) \{/.test(battleSrc2)
    && /const hadHuman = r\.entrants\.some\(e => e\.human\);/.test(battleSrc2), '');
  // 大会のブラケットは人間が必ず左に置かれていた（参加者が4人以下なら右列は全部AI）。
  check('H-3 大会のブラケットで組の左右を入れ替えている',
    /for \(let i = 0; i < 8; i \+= 2\) \{[\s\S]{0,40}?if \(crypto\.randomInt\(2\)\)/.test(battleSrc2), '');
  // 人間が潰れた回に帰属が付かないので、矢印つきの撃破ログに出る名前が
  // 例外なく住人だった。
  check('H-4 人間が潰れた回にも撃破の帰属が付く',
    /target\.lastHitBy = from;/.test(battleSrc2) && /const blame = \(e\.lastHitBy/.test(battleSrc2), '');
  check('H-4b ただし直前のお邪魔からの時間で切る（自滅は自滅のまま）',
    /ROYALE_BLAME_MS/.test(battleSrc2), '');

} catch (err) {
  check('テストが最後まで走った', false, err.message);
} finally {
  await stop();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n🎭 欄の有無で正体が割れないか\n');
for (const [m, n, d] of results) console.log(`${m} ${n}${d ? `  (${d})` : ''}`);
const bad2 = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad2}/${results.length} 件 OK`);
