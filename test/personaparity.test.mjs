// リポジトリのルートから:  node test/personaparity.test.mjs
//
// 🎭 対戦カードに載る「称号・ギルド・直近の戦績」で、**席の正体が割れない**ことを見張る。
//
// ■ なぜこのテストが要るのか
// 対戦カード（試合前の 3-2-1 に重ねる名刺）にこの3つを出す話は、第5波でいったん
// 見送られている。理由は値ではなく **欄の有無**:
//
//   ボット席の約3割は名簿に居ない使い捨ての persona（pickResidentBot が null を
//   返す分岐）で、称号もギルドも戦績も持たない。null を送ると
//   「その欄が出ない ＝ 使い捨てのボット」と読めてしまい、いま無害な機能が
//   そのまま秘匿の穴になる。
//
// クライアントは「並ぶ全員がその欄を持つときだけ行ごと出す」規則で実装済みなので、
// サーバーが全員ぶん揃えて載せた日に自動で出る。ここはその「揃っているか」を、
// 目ではなく統計と機械で確かめる。
//
// ■ 3つの観点
//   A. 分布 … 1000人ぶんの persona と住人を並べて、称号の保有率・ギルド加入率・
//      勝敗数の分布に有意な差が出ないこと。**帯（席の強さ）ごと**に見るのが肝心で、
//      全体の割合だけ合わせても「レート1800なのに“かけだしブロッカー”」という
//      住人には絶対に起きない組み合わせが persona にだけ出れば、そこが印になる。
//   B. 効くこと（対照実験）… 帯を合わせない「素朴な合成」を同じ検定にかけると
//      必ず落ちること。落ちないテストは、通っても何も保証していない。
//   C. フレーム … 実際の match_found で、どの席も**同じ欄の集合**を持つこと。
//      住人が出る世界（POP_SCALE=1）と使い捨てしか出ない世界（POP_SCALE=0）の
//      両方で確かめる ── 片方でしか見ないと「揃っているのはたまたま」になる。
//      あわせて非管理者に isBot 類が載らないこと（secrecy と同じ観点）。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { freePort } from './_port.mjs';
import {
  buildRoster, customResident, residentStats, residentRating,
  BOT_RATING_BANDS, JA_NAMES, EN_NAMES, strHash,
} from '../server/residents.js';

// ⚠ ambient.js は POP_SCALE を**読み込みの瞬間に**確定させる（モジュール定数）。
// 静的 import は巻き上げられてこの行より先に走るので、動的 import でないと
// 環境変数を効かせられない。走らせた人のシェルに POP_SCALE=0 が残っていても
// 同じ結果になるように、ここで明示しておく（residents.js は env を見ないので
// 静的 import のままでよい。guilds.js は ambient.js を経由するので後から）。
process.env.POP_SCALE = '1';
const { seatProfile, setLiveScale, getRoster } = await import('../server/ambient.js');
const { ghostGuildOfResident } = await import('../server/guilds.js');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 時刻を固定する。住人の数字は「参加日からの日数」で動くので、実時刻で回すと
// 何か月か先に理由の分からない失敗をする（＝テストが嘘をつく）。
const NOON_JST = Date.UTC(2026, 7, 26, 3);
const LEVELS = ['easy', 'normal', 'hard', 'oni'];

// ---------------------------------------------------------------------------
// 検定の道具
// ---------------------------------------------------------------------------

// 2標本の割合の差（プールした標準誤差での z）。|z| が大きいほど「別物」。
function zProp(k1, n1, k2, n2) {
  if (!n1 || !n2) return Infinity;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (k1 / n1 - k2 / n2) / se : 0;
}
// 両側 α=0.01。実測はどれも |z| < 1 なので、ここは「本当に差があるときだけ赤」。
const Z_CRIT = 2.58;

// 2標本コルモゴロフ–スミルノフ統計量（累積分布の最大の開き）。
// 勝敗数は同じ値が何度も出る離散量なので、値でまとめて進める形にしてある。
function ksStat(a, b) {
  const A = [...a].sort((x, y) => x - y);
  const B = [...b].sort((x, y) => x - y);
  let i = 0, j = 0, d = 0;
  while (i < A.length && j < B.length) {
    const v = Math.min(A[i], B[j]);
    while (i < A.length && A[i] <= v) i++;
    while (j < B.length && B[j] <= v) j++;
    d = Math.max(d, Math.abs(i / A.length - j / B.length));
  }
  return d;
}
// α=0.01 の臨界値（c=1.63）。実測は臨界値の 0.3〜0.6 倍に収まる。
const ksCrit = (n, m) => 1.63 * Math.sqrt((n + m) / (n * m));

// 称号の「種類」の分布のずれ（総変動距離 0〜1）。保有率だけ合わせても、
// 中身が偏っていれば帯と食い違う ── そこを見るための指標。
function tvd(listA, listB, keyOf) {
  const hist = list => {
    const m = new Map();
    for (const x of list) { const k = keyOf(x) || '-'; m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  const ha = hist(listA), hb = hist(listB);
  let sum = 0;
  for (const k of new Set([...ha.keys(), ...hb.keys()])) {
    sum += Math.abs((ha.get(k) || 0) / listA.length - (hb.get(k) || 0) / listB.length);
  }
  return sum / 2;
}
// 実測 0.009〜0.025。素朴な合成だと 0.22〜0.40 まで飛ぶので、間に線を引く。
const TVD_MAX = 0.08;

// ---------------------------------------------------------------------------
// 標本づくり
// ---------------------------------------------------------------------------
// にぎわいを最大にして名簿を 600人にする。ギルドの加入率は名簿の大きさで
// 70.3%（64人）〜65.8%（600人）と動くので、いちばん動いた側で見る。
setLiveScale(2000);
const guildTagOf = n => { const g = ghostGuildOfResident(n); return g ? g.tag : null; };
const liveRoster = getRoster();

// persona の名前空間は pickPersona と同じ（JA+EN の名簿 ＋ 2桁のサフィックス）。
const POOL = JA_NAMES.concat(EN_NAMES);
const personaNames = [];
for (let i = 0; i < 1000; i++) {
  const base = POOL[i % POOL.length];
  personaNames.push(i < POOL.length ? base : base + String(10 + (i * 37) % 90));
}

// 住人側の標本。シードを4つ使うのは、帯によっては1つの名簿だと数十人しか
// 該当せず検定に力が出ないため（シードが違うだけで、どれも同じ生成器の引き）。
const residents = [];
for (const seed of ['v1', 'v2', 'v3', 'v4']) residents.push(...buildRoster(seed, 600));

const residentsInBand = level => {
  const [lo, hi] = BOT_RATING_BANDS[level];
  return residents.filter(r => {
    const x = residentRating(r, NOON_JST);
    return x >= lo && x <= hi;
  });
};
const personaProfiles = level => personaNames.map(n => seatProfile({ name: n, level, now: NOON_JST, guildTagOf }));

// ---------------------------------------------------------------------------
// A-1. 欄は必ず3つ揃って返る（値が null でもキーは消さない）
// ---------------------------------------------------------------------------
{
  const KEYS = 'guild,record,title';
  const keysOf = o => Object.keys(o).sort().join(',');
  const samples = [
    ['住人', seatProfile({ resident: liveRoster[3], name: liveRoster[3].name, registered: liveRoster[3].registered, now: NOON_JST, guildTagOf })],
    ['使い捨て', seatProfile({ name: 'そらまめ', level: 'hard', now: NOON_JST, guildTagOf })],
    ['ゲスト', seatProfile({ name: 'ゲスト4821', level: 'normal', registered: false, now: NOON_JST, guildTagOf })],
    ['名前なし', seatProfile()],
  ];
  const bad = samples.filter(([, p]) => keysOf(p) !== KEYS).map(([k]) => k);
  check('A-1 どの席でも欄は title/guild/record の3つで揃う', bad.length === 0, bad.join(' / '));
  // ゲストは3つとも null（本物のゲストと同じ）。ここを埋めると
  // 「ゲスト名なのに称号がある＝人間ではない」という逆向きの穴になる。
  const guest = samples[2][1];
  check('A-1 ゲスト席は3つとも null', guest.title === null && guest.guild === null && guest.record === null,
    JSON.stringify(guest));
  // 逆に、アカウント持ちの席は戦績を必ず持つ（欄が生えたり消えたりしない）。
  const withAcct = personaProfiles('normal');
  check('A-1 アカウント持ちの使い捨ては全員が戦績を持つ',
    withAcct.every(p => p.record && Number.isFinite(p.record.w) && Number.isFinite(p.record.l)),
    `${withAcct.filter(p => !p.record).length}件が欠落`);
}

// ---------------------------------------------------------------------------
// A-2. 決定論（同じ名前・同じ強さなら毎回同じ）
// ---------------------------------------------------------------------------
{
  const once = personaProfiles('hard');
  const twice = personaProfiles('hard');
  const same = once.every((p, i) => JSON.stringify(p) === JSON.stringify(twice[i]));
  check('A-2 同じ名前・同じ強さなら毎回同じ profile', same);
  // 強さが変われば中身は変わってよい（席のレートが帯から決まるので、
  // むしろ変わらないと「レートと称号が食い違う」ほうの穴になる）。
  const other = personaProfiles('easy');
  const moved = once.filter((p, i) => JSON.stringify(p) !== JSON.stringify(other[i])).length;
  check('A-2 帯が変われば内容も変わる', moved > once.length * 0.5, `${moved}/${once.length}人`);
}

// ---------------------------------------------------------------------------
// A-3. 称号の保有率・種類 — 帯ごとに住人と同じか
// ---------------------------------------------------------------------------
for (const level of LEVELS) {
  const rs = residentsInBand(level).map(r => residentStats(r, NOON_JST));
  const ps = personaProfiles(level);
  const kr = rs.filter(s => s.title).length;
  const kp = ps.filter(p => p.title).length;
  const z = zProp(kr, rs.length, kp, ps.length);
  check(`A-3 [${level}] 称号の保有率に有意差なし`, Math.abs(z) < Z_CRIT,
    `住人 ${(kr / rs.length * 100).toFixed(1)}%(n=${rs.length}) / 使い捨て ${(kp / ps.length * 100).toFixed(1)}%(n=${ps.length}) z=${z.toFixed(2)}`);
  const d = tvd(rs, ps, x => x.title && x.title.id);
  check(`A-3 [${level}] 称号の“種類”の分布も同じ`, d < TVD_MAX, `TVD=${d.toFixed(4)}（上限 ${TVD_MAX}）`);
}

// ---------------------------------------------------------------------------
// A-4. 勝敗数の分布 — 帯ごとに住人と同じか
// ---------------------------------------------------------------------------
for (const level of LEVELS) {
  const rs = residentsInBand(level).map(r => residentStats(r, NOON_JST));
  const ps = personaProfiles(level);
  const crit = ksCrit(rs.length, ps.length);
  const dw = ksStat(rs.map(s => s.pvpWins), ps.map(p => p.record.w));
  const dl = ksStat(rs.map(s => s.pvpLosses), ps.map(p => p.record.l));
  check(`A-4 [${level}] 勝ち数の分布に有意差なし`, dw < crit, `KS=${dw.toFixed(4)} 臨界=${crit.toFixed(4)}`);
  check(`A-4 [${level}] 負け数の分布に有意差なし`, dl < crit, `KS=${dl.toFixed(4)} 臨界=${crit.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// A-5. ギルド加入率
// ---------------------------------------------------------------------------
{
  const kr = liveRoster.filter(r => ghostGuildOfResident(r.name)).length;
  const ps = personaProfiles('normal');
  const kp = ps.filter(p => p.guild).length;
  const z = zProp(kr, liveRoster.length, kp, ps.length);
  check('A-5 ギルド加入率に有意差なし', Math.abs(z) < Z_CRIT,
    `住人 ${(kr / liveRoster.length * 100).toFixed(1)}%(n=${liveRoster.length}) / 使い捨て ${(kp / ps.length * 100).toFixed(1)}% z=${z.toFixed(2)}`);
  // タグは実在するゴーストギルドのものだけ（架空の4文字を作らない）。
  const tags = new Set(liveRoster.map(r => guildTagOf(r.name)).filter(Boolean));
  const stray = ps.filter(p => p.guild && !tags.has(p.guild)).map(p => p.guild);
  check('A-5 使い捨てのタグも実在するギルドのもの', stray.length === 0, [...new Set(stray)].slice(0, 4).join(' / '));
  // 🛡 ギルドの詳細（/api/guilds/:id）は所属者の名前を並べる。名簿に同名の住人が
  // 居る使い捨ては、**その人のタグ**を名乗ること ── 無関係なタグを借りると
  // 「タグはあるのに、そのギルドの名簿にその名前が居ない」という、1人ずつ
  // 確実に判定できる食い違いが残る。
  const byName = new Map(liveRoster.map(r => [r.name, r]));
  const mismatched = personaNames
    .map((n, i) => [n, ps[i]])
    .filter(([n, p]) => byName.has(n) && p.guild !== guildTagOf(n));
  check('A-5 同名の住人が居る使い捨ては、その人のタグを名乗る', mismatched.length === 0,
    mismatched.slice(0, 3).map(([n, p]) => `${n}: ${p.guild} ≠ ${guildTagOf(n)}`).join(' / '));
}

// ---------------------------------------------------------------------------
// B. 対照実験 — この検定は本当に差を見つけられるのか
// ---------------------------------------------------------------------------
// 「名前から合成住人を1人作る」だけで、席の強さの帯に合わせない**素朴な実装**を
// 同じ検定にかける。これが素通りするなら、A が通っても何も保証していない。
// （帯を合わせないと easy 席に“ダイヤの誇り”が並ぶ ＝ 住人には起きない組み合わせ。）
{
  const naive = level => personaNames.map(n => residentStats(customResident({ name: n }, strHash(`naive:${n}`) % 1000000), NOON_JST));
  let caught = 0;
  const detail = [];
  for (const level of LEVELS) {
    const rs = residentsInBand(level).map(r => residentStats(r, NOON_JST));
    const ns = naive(level);
    const d = tvd(rs, ns, x => x.title && x.title.id);
    const dw = ksStat(rs.map(s => s.pvpWins), ns.map(s => s.pvpWins));
    const fail = d >= TVD_MAX || dw >= ksCrit(rs.length, ns.length);
    if (fail) caught++;
    detail.push(`${level}:TVD=${d.toFixed(3)} KS=${dw.toFixed(3)}`);
  }
  check('B 帯を合わせない素朴な実装は全帯で落ちる（検定が効いている）',
    caught === LEVELS.length, detail.join(' / '));
}

// ---------------------------------------------------------------------------
// C. 実際の match_found — どの席も同じ欄の集合を持つ
// ---------------------------------------------------------------------------
// 住人が出る世界と、使い捨てしか出ない世界（POP_SCALE=0 で pickResidentBot が
// 必ず null を返す）の両方で1試合ずつ組んで、席の欄ぞろえを見比べる。

// secrecy.test.mjs と同じ観点の走査器（あちらの一覧を import しないのはわざと。
// 実装側の一覧を空にしてもテストが気づかなくなるため）。
const FORBIDDEN = [
  'isBot', 'bot', 'ai', 'resident', 'npc', 'fake', 'ghost', 'human',
  'arch', 'archLabel', 'skill', 'chatty', 'quirk', 'custom', 'registered',
  'fakeLevel', 'residentId', 'botInSec', 'real',
];
const RESIDENT_ID_RE = /^(?:res:)?(?:ghost|r|x)\d+$/;
function traces(value, where = '$') {
  const found = [];
  const walk = (v, at, depth) => {
    if (depth > 20 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return; }
    for (const [k, raw] of Object.entries(v)) {
      if (FORBIDDEN.includes(k)) found.push(`${at}.${k}`);
      const idKey = k === 'id' || (k.length > 2 && k.endsWith('Id'));
      if (typeof raw === 'string' && idKey && RESIDENT_ID_RE.test(raw)) found.push(`${at}.${k}='${raw}'`);
      walk(raw, `${at}.${k}`, depth + 1);
    }
  };
  walk(value, where, 0);
  return found;
}

// 1つの世界を立てて、1試合ぶんの match_found を集める。
async function matchFoundIn(label, popScale) {
  const port = await freePort();
  // ⚠ DATA_DIR にはポートを混ぜる（固定名だと並列実行で互いの db.json を消す）。
  const dir = path.join(os.tmpdir(), `bba-personaparity-test-${port}-${popScale}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir,
      SESSION_SECRET: 'personaparity-test-secret', SEED_RESTORE: '0',
      POP_SCALE: String(popScale),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const base = `http://localhost:${port}`;
  const j = async (p, opt = {}, token) => {
    const r = await fetch(base + p, {
      ...opt,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
    let d = {}; try { d = await r.json(); } catch { /* 本文なしもある */ }
    return { status: r.status, body: d };
  };
  const frames = (token, guestName) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const got = [];
    const to = setTimeout(() => { try { ws.close(); } catch { /* もう閉じている */ } res(got); }, 25000);
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      got.push(m);
      if (m.type === 'hello_ok') ws.send(JSON.stringify({ type: 'queue', mode: 'duel' }));
      if (m.type === 'match_found') { clearTimeout(to); try { ws.close(); } catch { /* 済み */ } res(got); }
    });
    ws.on('open', () => ws.send(JSON.stringify(token ? { type: 'hello', token } : { type: 'hello', guestName })));
    ws.on('error', e => { clearTimeout(to); rej(e); });
  });

  try {
    for (let i = 0; ; i++) {
      await sleep(250);
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})\n${log}`);
      if (i >= 80) throw new Error('サーバーが起動しませんでした\n' + log);
      try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch { /* まだ */ }
    }
    // にぎわいは env × live の両方が要る。使い捨てだけの世界は env 側で 0。
    const adminPw = fs.readFileSync(path.join(dir, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
    const adminTok = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).body.token;
    if (popScale) await j('/api/admin/pop', { method: 'POST', body: { scale: 1 } }, adminTok);
    const tok = (await j('/api/register', { method: 'POST', body: { username: `対戦カード試験${port}`, password: 'pass1234' } })).body.token;
    const asPlayer = (await frames(tok)).find(m => m.type === 'match_found');
    // 実プレイヤー側の出典（equippedTitle / db.guilds[].tag / stats.pvp*）も
    // 通しで見る。ここが null のままだと、住人だけ欄を持つことになって
    // 「並ぶ全員が持つときだけ出す」規則により行が永久に出ない ── つまり
    // 秘匿は保てても機能そのものが死ぬ。管理者はギルド設立が無料なので、
    // 称号とギルドの両方を1アカウントで用意できる。
    await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 1500, lines: 9, maxCombo: 4, duration: 60 } }, adminTok);
    const equipped = await j('/api/titles/equip', { method: 'POST', body: { id: 'rookie' } }, adminTok);
    const guild = await j('/api/guilds/create', { method: 'POST', body: { name: `試験ギルド`, tag: 'TEST' } }, adminTok);
    const asAdmin = (await frames(adminTok)).find(m => m.type === 'match_found');
    return { label, asPlayer, asAdmin, equipped, guild };
  } finally {
    await new Promise(res => { proc.on('exit', res); proc.kill(); });
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const seatKeys = mf => (mf ? mf.players.map(p => Object.keys(p).sort().join(',')) : []);

try {
  // 住人が変装で出てくる世界と、使い捨てしか居ない世界。
  const worlds = [await matchFoundIn('住人あり', 1), await matchFoundIn('使い捨てのみ', 0)];
  for (const w of worlds) {
    const mf = w.asPlayer;
    check(`C [${w.label}] match_found が届く`, !!mf && Array.isArray(mf.players) && mf.players.length >= 2,
      JSON.stringify(mf && mf.players));
    if (!mf) continue;
    const keys = seatKeys(mf);
    check(`C [${w.label}] どの席も同じ欄の集合`, new Set(keys).size === 1, keys.join(' | '));
    check(`C [${w.label}] 全席に title/guild/record がある`,
      mf.players.every(p => 'title' in p && 'guild' in p && 'record' in p),
      JSON.stringify(mf.players));
    // 値の形も揃っていること（片方だけ壊れた形だと、画面が行を落として
    // 結局「欄の有無」に戻る）。
    const shapeOk = mf.players.every(p =>
      (p.title === null || (p.title && typeof p.title.id === 'string' && typeof p.title.name === 'string'))
      && (p.guild === null || typeof p.guild === 'string')
      && (p.record === null || (typeof p.record.w === 'number' && typeof p.record.l === 'number')));
    check(`C [${w.label}] title/guild/record の形が全席で揃う`, shapeOk, JSON.stringify(mf.players));
    const leaks = traces(mf, `ws:match_found(${w.label})`);
    check(`C [${w.label}] 非管理者の match_found に禁止キーが0件`, leaks.length === 0, leaks.slice(0, 6).join(' / '));
    check(`C [${w.label}] 管理者には isBot が残る（運営の目は塞がない）`,
      !!w.asAdmin && w.asAdmin.players.some(p => 'isBot' in p),
      JSON.stringify(w.asAdmin && w.asAdmin.players.map(p => p.isBot)));
    // 実プレイヤーの席にも本物の称号・ギルド・戦績が載ること（欄が住人にしか
    // 無ければ、クライアントの「全員が持つときだけ出す」規則で行は出ない）。
    const meSeat = w.asAdmin && w.asAdmin.players.find(p => p.isYou);
    check(`C [${w.label}] 実プレイヤーの席に本物の称号・ギルド・戦績が載る`,
      !!meSeat && meSeat.title && meSeat.title.id === 'rookie'
      && meSeat.guild === 'TEST'
      && meSeat.record && typeof meSeat.record.w === 'number' && typeof meSeat.record.l === 'number',
      `${JSON.stringify(meSeat)} / equip=${w.equipped.status}:${JSON.stringify(w.equipped.body.error || '')} guild=${w.guild.status}:${JSON.stringify(w.guild.body.error || '')}`);
  }
  // ★ この波の本丸: 住人が出る世界と使い捨てだけの世界で、席の欄ぞろえが
  //   1文字も違わないこと。ここが違うと、対戦相手の正体が欄の形で割れる。
  const a = new Set(seatKeys(worlds[0].asPlayer));
  const b = new Set(seatKeys(worlds[1].asPlayer));
  check('C 住人の席と使い捨ての席で欄の集合がまったく同じ',
    a.size === 1 && b.size === 1 && [...a][0] === [...b][0], `${[...a][0]} vs ${[...b][0]}`);
} catch (err) {
  check('test harness', false, err.stack || String(err));
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
