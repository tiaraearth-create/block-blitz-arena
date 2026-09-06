#!/usr/bin/env node
// 🧾 不正の疑いがある記録を取り消す。
//
// 管理画面の「記録の監査」と**同じAPI**を叩くだけの道具。画面を開いて
// タップするのと結果は変わらないが、
//   ・消す前の数字を必ず表に出す
//   ・確認しない限り 1バイトも書き換えない（既定は下見だけ）
//   ・名指しした人しか触らない
// ので、押し間違いが起きにくい。
//
// 使い方:
//   node scripts/clear-record.mjs                        … 監査の一覧を見るだけ
//   node scripts/clear-record.mjs --apply まじ コーヘイ80  … その2人の記録を取り消す
//   node scripts/clear-record.mjs --apply --floors まじ   … 階層のほうを取り消す
//   node scripts/clear-record.mjs --apply --keep-history まじ … 殿堂とお知らせは残す
//   node scripts/clear-record.mjs --url http://localhost:3000 … 対象を変える
//
// パスワードは打った端末から出ない（この画面に出ることも、ログに残ることも無い）。
//
// ⚠ 取り消した記録は、サーバーの🧾操作ログに「前の値 → 後の値」で残る（v2.70〜）。
//   押し間違えたら、その値を見ながら手で戻せる。
// 🏛 既定では**歴史も書き換える**。殿堂の行を消して残った人の順位を繰り上げ、
//   お知らせ本文からもその行を消し、受け取り待ちの報酬とシーズン王者バッジを
//   取り消す。殿堂とお知らせは未ログインでも読めるので、ここを残すと
//   「取り消したのに1位のまま載っている」状態になる。
//   --keep-history を付けると、記録だけ 0 にして歴史はそのまま残す。

import readline from 'readline';

const DEFAULT_URL = 'https://block-blitz-arena.onrender.com';
const ADMIN_NAME = 'るみまき';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const BASE = (opt('--url') || DEFAULT_URL).replace(/\/$/, '');
const APPLY = flag('--apply');
const PURGE = !flag('--keep-history');
const WHAT = flag('--floors') ? 'floors' : 'score';
// 旗と、その旗が取る値を除いた残りが「名指しした人」。
const NAMES = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && (args[i - 1] === '--url')));

// 「ハイスコアを取り消す」で一緒に落とす欄。1回の走りで出た点は各モードの
// 自己ベストにも写るので、bestScore だけ消すと本人のソロ画面には
// 「BEST ◯◯」が残り、メルトダウン等の順位表にも残る（public/js/admintools.js
// の SCORE_FAMILY と同じ並び。片方だけ足すと画面と食い違うので注意）。
const SCORE_FAMILY = ['bestScore', 'soloBest', 'meltdownBest', 'chimeraBest',
  'chainBest', 'chainMax', 'rushDepth', 'blueprintClears', 'ghostBest'];
const FLOOR_FAMILY = ['dungeonMax', 'underMax', 'heavenMax', 'abyssMax'];

// ---------------------------------------------------------------------------
// 送り先の検証。この先で /api/login に管理者パスワードを本文へ載せて POST する。
// http:// のまま走らせるとパスワードが平文で回線に乗る。
// （scripts/pull-backup.mjs と同じ理由・同じ判定）
// ---------------------------------------------------------------------------
{
  let u;
  try { u = new URL(BASE); } catch {
    console.error(`対象URLとして読めません: ${BASE}`);
    process.exit(1);
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    console.error(`中止しました: ${BASE} は https:// ではありません。`);
    console.error('この道具は管理者パスワードを送信します。暗号化されていない経路には出せません。');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// パスワードを伏せ字で読む。
//
// raw モードにして1文字ずつ自分で受け取る（echo された文字の上に * を
// 重ね書きする方式だと、バックスペースで表示と中身がずれ、端末によっては
// 制御文字が値に紛れ込む ── 打ったつもりのものと違うものが送られて、
// 原因が分からないままログインに失敗する）。pull-backup.mjs と同じ作法。
// ---------------------------------------------------------------------------
function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    // ⚠ 閉じたあと stdin を必ず手放す。開いたままだと、この直後の
    //    process.exit() で Windows の libuv が「閉じかけのハンドルを
    //    触った」と assert して異常終了する（ログインに失敗しただけなのに
    //    クラッシュに見える）。
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', line => { rl.close(); stdin.pause(); resolve(line); });
    });
  }
  return new Promise(resolve => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = value => {
      stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
      stdout.write('\n'); resolve(value);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003') { stdout.write('\n中止しました\n'); process.exit(1); }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) { buf = buf.slice(0, -1); stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function askLine(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, a => { rl.close(); resolve(a.trim()); });
  });
}

// 無料プランは寝ていることがあるので、一度で諦めない。
async function req(url, opts = {}, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fetch(url, opts); } catch (e) {
      last = e;
      const c = (e && e.cause) || e;
      if (i < tries) {
        console.log(`  通信に失敗（${c.code || c.message}）── ${i * 5}秒後に再試行 ${i}/${tries - 1}`);
        await new Promise(r => setTimeout(r, i * 5000));
      }
    }
  }
  throw last;
}

const fmt = n => (Number(n) || 0).toLocaleString('en-US');

/** 途中でやめる。stdin を手放してから抜ける（上の理由）。 */
function bail(msg) {
  console.error(msg);
  try { process.stdin.pause(); } catch { /* すでに閉じている */ }
  process.exitCode = 1;
  throw new Bail();
}
class Bail extends Error {}

async function main() {
  console.log(`対象: ${BASE}`);
  console.log(APPLY
    ? `\n⚠ 取り消しを実行します（${WHAT === 'score' ? 'ハイスコア' : '階層'}）`
    : '\n下見だけです。実際に取り消すには --apply と名前を付けてください。');

  const pw = process.env.ADMIN_PASSWORD || await askHidden('\n管理者パスワード: ');
  if (!pw) bail('パスワードが空です');

  const lr = await req(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_NAME, password: pw }),
  });
  const login = await lr.json().catch(() => ({}));
  if (!lr.ok || !login.token) bail(`\nログインに失敗しました: ${login.error || lr.status}`);
  const H = { Authorization: `Bearer ${login.token}` };
  console.log('ログインしました。\n');

  const ar = await req(`${BASE}/api/admin/audit`, { headers: H });
  if (!ar.ok) {
    if (ar.status === 404) console.error('（サーバーが v2.66 より古い可能性があります）');
    bail(`監査を読めませんでした: HTTP ${ar.status}`);
  }
  const audit = await ar.json();
  const rows = audit.rows || [];
  console.log(`${audit.total}人中 ${rows.length}人に気になる点があります:\n`);

  for (const r of rows) {
    const floors = [['塔', r.dungeonMax], ['地下', r.underMax], ['天国', r.heavenMax], ['深淵', r.abyssMax]]
      .filter(([, v]) => v > 0).map(([n, v]) => `${n}${v}`).join('・') || '—';
    console.log(`  ${r.username}  Lv${r.level}${r.banned ? ' ・凍結中' : ''}`);
    console.log(`    ハイスコア ${fmt(r.bestScore)} / プレイ ${fmt(r.gamesPlayed)}回 ${fmt(r.playSecs)}秒 / 階層 ${floors}`);
    for (const f of (r.flags || [])) console.log(`    [${f.level}] ${f.label} — ${f.detail}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('取り消すには:');
    console.log(`  node scripts/clear-record.mjs --apply ${rows.slice(0, 2).map(r => r.username).join(' ') || '<名前>'}`);
    return;
  }
  if (!NAMES.length) bail('取り消す相手を名前で指定してください（安全のため、一括では消しません）。');

  const targets = [];
  for (const name of NAMES) {
    const hit = rows.find(r => r.username === name);
    if (!hit) bail(`「${name}」は監査の一覧に居ません。名前を確かめてください。`);
    targets.push(hit);
  }

  const keys = WHAT === 'score' ? SCORE_FAMILY : FLOOR_FAMILY;
  console.log(PURGE
    ? 'これから取り消します（**歴史も書き換えます**）:\n'
    : 'これから取り消します（歴史はそのまま残します）:\n');
  for (const t of targets) {
    console.log(`  ${t.username}`);
    if (WHAT === 'score') console.log(`    ハイスコア ${fmt(t.bestScore)} → 0（各モードの自己ベストも一緒に）`);
    else console.log(`    塔${t.dungeonMax} 地下${t.underMax} 天国${t.heavenMax} 深淵${t.abyssMax} → すべて 0`);
  }
  if (PURGE) {
    console.log('\n  ＋ 殿堂からその行を消し、残った人の順位を繰り上げます');
    console.log('  ＋ 過去のお知らせ本文からもその行を消します（未ログインでも読める面）');
    console.log('  ＋ 受け取り待ちのランキング報酬と、シーズン王者・週間王者バッジを取り消します');
  }
  console.log('\n消した中身はサーバーの🧾操作ログに残るので、間違えたら手で戻せます。\n');

  const ans = await askLine(`本当に実行しますか？ yes と入力: `);
  if (ans !== 'yes') { console.log('中止しました。何も変更していません。'); return; }

  for (const t of targets) {
    const body = { setStats: Object.fromEntries(keys.map(k => [k, 0])), ...(PURGE ? { purgeHistory: true } : {}) };
    const res = await req(`${BASE}/api/admin/users/${encodeURIComponent(t.id)}`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`  ❌ ${t.username}: ${d.error || res.status}`); continue; }
    const st = (d.user && d.user.stats) || {};
    const left = keys.filter(k => (Number(st[k]) || 0) !== 0);
    const pg = d.purged;
    const note = pg ? `（殿堂${pg.hof} / お知らせ${pg.news} / 報酬${pg.rewards}${pg.badges && pg.badges.length ? ` / バッジ${pg.badges.length}` : ''}）` : '';
    console.log(left.length
      ? `  ⚠ ${t.username}: 残った欄があります → ${left.join(',')}`
      : `  ✅ ${t.username}: 取り消しました ${note}`);
    for (const line of (pg && pg.removed ? pg.removed : [])) console.log(`       - ${line}`);
  }
  console.log('\n管理画面の 🧾操作ログ に「前の値 → 後の値」が残っています。');
}

main().catch(err => {
  if (err instanceof Bail) { process.exitCode = 1; return; }   // 文言は bail が出し済み
  const c = (err && err.cause) || err;
  console.error(`\nエラー: ${c.message || err}`);
  process.exitCode = 1;
});
