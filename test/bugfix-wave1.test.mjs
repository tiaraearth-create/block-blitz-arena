// リポジトリのルートから:  node test/bugfix-wave1.test.mjs
//
// 🐛 バグ探し（2026-09-04）で見つかった不具合のうち、サーバーを立てて確かめられる
//    ものと、配線をソースで固定できるものをまとめて見張る。
//
// ここに入れてあるのは「直したことが逆戻りしやすい」ものだけ。とくに:
//   ・順序が意味を持つもの（フレンド申請の断り順・ギルドの合言葉照合）
//   ・「一度満たしたら自分のもの」の約束（称号《大富豪》）
//   ・コメントが約束しているのに実装が破っていたもの（quitWarning・履歴の畳み）
//
// ■ どれも「効きすぎない側」を必ず一緒に見る
//   取り締まりや上限の類は、緩いと意味が無く、強いと正直な人を巻き込む。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-bugfix1-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なし */ }
  return { status: r.status, ...d };
};
const meOf = async token => (await j('/api/me', {}, token)).user || {};

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'bugfix1-test', SEED_RESTORE: '0',
    },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    }
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(300);
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();
  const reg = async (name, pw) => j('/api/register', { method: 'POST', body: { username: name, password: pw } });

  // =========================================================================
  // A. 招待制ギルドは合言葉が合わないと入れない
  //
  // findGuild は id を優先して引くのに、joinGuild へ渡す viaCode を
  // 「リクエストに code が入っていたか」だけで決めていた。つまり
  // 「ギルドid ＋ でたらめな合言葉」で招待制の門を素通りできた
  // （合言葉は一度も照合されない）。ギルド一覧には id が並んでいる。
  // =========================================================================
  {
    const owner = await reg('ぎるどぬし', 'guild-owner-1');
    const outsider = await reg('よそのひと', 'outsider-1');
    const invited = await reg('しょうたい', 'invited-1');
    check('A-0 下ごしらえの3アカウント', !!owner.token && !!outsider.token && !!invited.token,
      `${owner.error || ''} ${outsider.error || ''} ${invited.error || ''}`);

    // 設立には 2,000コイン（GUILD_CREATE_COST）が要る。管理者編集で持たせる。
    const admPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
    const admTok = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: admPw } })).token;
    await j(`/api/admin/users/${owner.user.id}`, { method: 'POST', body: { grantCoins: 5000 } }, admTok);

    // 招待制（open:false）で作る。合言葉はオーナーにだけ返る（guildView）。
    const made = await j('/api/guilds/create', { method: 'POST', body: { name: 'ひみつの会', tag: 'SCRT', open: false } }, owner.token);
    check('A-0 招待制ギルドを作れた', made.status === 200 && !!made.guild, `HTTP ${made.status} ${made.error || ''}`);
    const gid = made.guild && made.guild.id;
    const code = made.guild && made.guild.code;
    check('A-0 合言葉が発行されている（オーナーには見える）', !!code, `code=${code}`);
    check('A-0 招待制になっている', made.guild && made.guild.open === false, `open=${made.guild && made.guild.open}`);

    // ❌ id ＋ でたらめな合言葉
    const forged = await j('/api/guilds/join', { method: 'POST', body: { id: gid, code: 'DEADBEEF' } }, outsider.token);
    check('A-1 ギルドid＋でたらめな合言葉では入れない', forged.status !== 200,
      `HTTP ${forged.status} ${forged.error || ''}`);

    // ❌ id だけ（合言葉なし）
    const idOnly = await j('/api/guilds/join', { method: 'POST', body: { id: gid } }, outsider.token);
    check('A-2 ギルドidだけでも入れない', idOnly.status !== 200, `HTTP ${idOnly.status} ${idOnly.error || ''}`);

    // ✅ 正しい合言葉なら入れる（効きすぎていないこと）
    const ok = await j('/api/guilds/join', { method: 'POST', body: { id: gid, code } }, invited.token);
    check('A-3 正しい合言葉なら入れる（招待された人を締め出さない）', ok.status === 200,
      `HTTP ${ok.status} ${ok.error || ''}`);
    // ✅ 合言葉だけ（idなし）でも入れる — 従来からの経路
    const outsider2 = await reg('ごうけい', 'goukei-1');
    const byCode = await j('/api/guilds/join', { method: 'POST', body: { code } }, outsider2.token);
    check('A-4 合言葉だけでも入れる（従来の経路を壊していない）', byCode.status === 200,
      `HTTP ${byCode.status} ${byCode.error || ''}`);
  }

  // =========================================================================
  // B. 称号《大富豪》は「一度10,000枚ためたら自分のもの」
  //
  // `user.coins >= 10000`（いま持っている枚数）で判定していたので、買い物を
  // した瞬間に剥がれ、一覧ではロックになるのに装備中の表示だけ残り、別の
  // 称号に替えると二度と付け直せなくなっていた。稼いだコインを使いたくなくなる
  // ＝ショップとガチャの導線を静かに殺す。
  // =========================================================================
  {
    const rich = await reg('おかねもち', 'okane-1234');
    const adminPw = fs.readFileSync(path.join(DIR, 'admin-credentials.txt'), 'utf8').match(/password: (.+)/)[1].trim();
    const atk = (await j('/api/login', { method: 'POST', body: { username: 'るみまき', password: adminPw } })).token;

    const before = await j('/api/titles', {}, rich.token);
    check('B-0 まだ《大富豪》は持っていない', !(before.earned || []).includes('rich'),
      (before.earned || []).join(','));

    // 管理者の編集でコインを10,000枚にする。
    const give = await j(`/api/admin/users/${rich.user.id}`, { method: 'POST', body: { grantCoins: 10000 } }, atk);
    check('B-1 コインを10,000枚にできた', give.status === 200, `HTTP ${give.status} ${give.error || ''}`);
    const afterGive = await meOf(rich.token);
    check('B-1 実際に10,000枚以上ある', (afterGive.coins || 0) >= 10000, `${afterGive.coins}🪙`);

    const got = await j('/api/titles', {}, rich.token);
    check('B-2 《大富豪》を獲得できる', (got.earned || []).includes('rich'), (got.earned || []).join(','));

    // 使う（管理者編集で減らす＝買い物と同じ状態にする）
    const spend = await j(`/api/admin/users/${rich.user.id}`, { method: 'POST', body: { grantCoins: -9500 } }, atk);
    check('B-3 コインを使った状態にできた', spend.status === 200, `HTTP ${spend.status}`);
    const poor = await meOf(rich.token);
    check('B-3 残高は10,000枚を下回っている', (poor.coins || 0) < 10000, `${poor.coins}🪙`);

    const still = await j('/api/titles', {}, rich.token);
    check('B-4 使っても《大富豪》は剥がれない（到達したら自分のもの）',
      (still.earned || []).includes('rich'), (still.earned || []).join(','));
    const equip = await j('/api/titles/equip', { method: 'POST', body: { id: 'rich' } }, rich.token);
    check('B-4 使ったあとでも装備できる', equip.status === 200, `HTTP ${equip.status} ${equip.error || ''}`);

    // 効きすぎていないこと ── 一度も到達していない人には出ない。
    const never = await reg('びんぼう', 'binbou-1234');
    const nt = await j('/api/titles', {}, never.token);
    check('B-5 一度も到達していない人には出ない', !(nt.earned || []).includes('rich'), (nt.earned || []).join(','));
  }

  // =========================================================================
  // C. フレンド申請の断りは、自分側の事情だけを出し分ける
  //
  // 「送信枠が満杯」の文言が相手側の判定より後ろにあったので、枠を満杯にして
  // 送るだけで「相手にブロックされているか」を1件ずつ調べられた。
  // =========================================================================
  {
    const src = read('server/friends.js');
    const fn = src.slice(src.indexOf('export function sendRequest'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const at = re => { const m = body.search(re); return m < 0 ? Infinity : m; };
    const ownLimit = Math.max(at(/friendReqOut\.length >= MAX_REQ_OUT/), at(/from\.friends\.length >= MAX_FRIENDS/));
    const otherSide = Math.min(
      at(/if \(eitherBlocks\(from, to\)\) return \{ error: REFUSED \};[\s\S]{0,80}requests === 'none'/),
      at(/to\.social\.requests === 'none'/),
      at(/friendDeclines\[from\.id\]/),
      at(/to\.friends\.length >= MAX_FRIENDS/));
    check('C-1 自分側の上限が、相手側の事情より前に来ている',
      ownLimit < otherSide, `自分側 @${ownLimit} / 相手側 @${otherSide}`);
    // 相手側の断りが1文言に揃っていること（理由を出し分けない）。
    const refusedCount = (body.match(/return \{ error: REFUSED \}/g) || []).length;
    check('C-2 相手側の断りはすべて同じ文言（REFUSED）', refusedCount >= 4, `${refusedCount}箇所`);
  }

  // =========================================================================
  // D. 配線（ソース検査）── コメントが約束しているのに破れていたもの
  // =========================================================================
  {
    const main = read('public/js/main.js');
    check('D-1 ✕ の確認がモード自身の quitWarning() を読む',
      /cur\.quitWarning === 'function'/.test(main) && /cur\.quitWarning\(\)/.test(main), '');
    check('D-2 ダンジョンの記録が領域ごとの statKey を見る（塔決め打ちでない）',
      /realm\.statKey && session\.user/.test(main) && !/realm\.id === 'tower' && session\.user/.test(main), '');

    const dom = read('public/js/dom.js');
    check('D-3 メニューへ戻るとき、端末の履歴も同じだけ畳む',
      /history\.go\(-depth\)/.test(dom), '');
    check('D-4 自分で畳んだぶんの popstate は拾わない',
      /Date\.now\(\) < unwindUntil/.test(dom), '');

    const game = read('public/js/game.js');
    check('D-5 手札の帯へのタップは盤面のタップにしない',
      /if \(this\.trayHit\(x, y\) !== -1\) return false;/.test(game), '');

    const screens = read('public/js/screens.js');
    check('D-6 称号カタログはログアウトで捨てない（共通データ）',
      !/^\s*titlesCatalog = null;$/m.test(screens.slice(screens.indexOf('export function resetScreenCaches'), screens.indexOf('export function resetScreenCaches') + 900)), '');
    check('D-7 称号の名前が引けないときは取り直す',
      /if \(!titlesCatalog\) \{ loadTitles\(\); return ''; \}/.test(screens), '');
    check('D-8 インベントリのタブ競合を入口で塞いでいる',
      /if \(invTab !== tab\) return;/.test(screens), '');
    check('D-9 #invSummary もログアウトで空にする',
      /'#invSummary'/.test(screens), '');
    check('D-10 実績の受取に二度押しガードがある',
      /const claim = async \(id, btn\) => \{[\s\S]{0,200}btn\.disabled = true;/.test(screens), '');
    check('D-11 称号モーダルが back を受け取る',
      /showTitlesModal\(\{ back:/.test(screens) && /export async function showTitlesModal\(\{ back = null \} = \{\}\)/.test(screens), '');

    const index = read('server/index.js');
    check('D-12 コインの高水位を積んでいる',
      /s\.coinsBest = user\.coins \|\| 0/.test(index), '');
    const cat = read('server/catalog.js');
    check('D-13 《大富豪》は到達最高で判定する',
      /coinsBest[\s\S]{0,60}>= 10000\) out\.push\('rich'\)/.test(cat), '');
    const backup = read('server/backup.js');
    check('D-14 復元の合流で coinsBest を落とさない',
      /coinsBest = Math\.max/.test(backup), '');
    check('D-15 工房の上限に当たったことを結果に載せる',
      /capped: 'workshop'/.test(index) && /rewards\.capped === 'workshop'/.test(read('public/js/modes.js')), '');
  }
} catch (err) {
  check('テストが最後まで走った', false, String((err && err.stack) || err));
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🐛 バグ修正 第1波  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
