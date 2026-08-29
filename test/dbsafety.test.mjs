// Run from the repo root:  node test/dbsafety.test.mjs
//
// db.json の壊れ方に対する備えを検証する。
//
// なぜこのテストがあるか:
// 以前、本番のプレイヤーデータが同梱 seed（数日前・3人）の状態まで巻き戻り、
// アカウントが1つ失われた。そのときの直接の原因は別（永続ディスク無し）だが、
// 調査の過程で「ディスクがあっても同じ結末に至る経路」が残っていることが
// 分かった:
//
//   flushDb が db.json へ直接 writeFileSync していた
//     → 書き込み中に SIGKILL されると db.json が途中で切れる
//     → 次の起動で JSON.parse に失敗
//     → 黙って空のデータベースから開始（全アカウント消滅）
//     → 同時に db.meta.seedHash も消える
//     → seed の再適用を止めている唯一の門が外れ、古い seed が復活
//
// つまり「書き込みが1回中断される」だけで事故が再現しうる状態だった。
// 対策は2つ入れてある。どちらも、外れたことに気づけないと意味がないので
// ここで固定する。
//   ① 書き込みを不可分にする（tmp に書いて fsync してから rename）
//   ② それでも壊れていたら、起動スナップショットから復旧する
import fs from 'fs';
import path from 'path';
import os from 'os';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bba-dbsafety-'));
const dbFile = d => path.join(d, 'db.json');

const makeDb = (n, extraMeta = {}) => ({
  users: Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, { id: `u${i}`, username: `player${i}` }])),
  tokens: {}, revoked: {}, deleted: {}, guilds: {}, news: [], season: null,
  transactions: [], bugreports: [],
  meta: { createdAt: 1, ...extraMeta },
});

// db.js はモジュールスコープに db をキャッシュするので、ケースごとに
// クエリ文字列を変えて別インスタンスとして読み込む。
let loadN = 0;
async function freshDbModule(dir) {
  process.env.DATA_DIR = dir;
  return import(`../server/db.js?case=${++loadN}`);
}

// ---- ① 不可分な書き込み ----------------------------------------------------
{
  const dir = path.join(ROOT, 'atomic');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbFile(dir), JSON.stringify(makeDb(5), null, 2));
  const before = fs.readFileSync(dbFile(dir), 'utf8');

  const m = await freshDbModule(dir);
  const db = m.loadDb();
  check('既存の db.json を読める', Object.keys(db.users).length === 5, `${Object.keys(db.users).length}人`);

  // 「tmp は書けたが rename の直前でプロセスが死んだ」を再現する。
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated kill just before rename'); };
  for (let i = 0; i < 200; i++) db.users[`new${i}`] = { id: `new${i}`, username: `x${i}` };
  m.flushDb();
  fs.renameSync = realRename;

  const after = fs.readFileSync(dbFile(dir), 'utf8');
  check('書き込みが中断されても db.json は前の内容のまま', after === before,
    after === before ? '' : `${before.length}→${after.length} bytes`);
  let parsed = null;
  try { parsed = JSON.parse(after); } catch { /* 壊れている */ }
  check('中断後も JSON として読める', !!parsed && Object.keys(parsed.users).length === 5,
    parsed ? `${Object.keys(parsed.users).length}人` : 'パース不能');

  // 正常系: 実際に書けば中身は更新される（不可分化で壊していないこと）
  m.flushDb();
  const written = JSON.parse(fs.readFileSync(dbFile(dir), 'utf8'));
  check('通常の flushDb はちゃんと保存される', Object.keys(written.users).length === 205,
    `${Object.keys(written.users).length}人`);
}

// ---- ② 壊れた db.json からの復旧 -------------------------------------------
{
  const dir = path.join(ROOT, 'recover');
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  // 起動スナップショット2件。新しい方が採用されるべき。
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-08-25T00-00-00-000Z_boot.json'),
    JSON.stringify(makeDb(2, { seedHash: 'OLD' })));
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-08-27T00-00-00-000Z_boot.json'),
    JSON.stringify(makeDb(7, { seedHash: 'ALREADY-APPLIED' })));
  // db.json は書き込み中に切れた状態
  const full = JSON.stringify(makeDb(9, { seedHash: 'ALREADY-APPLIED' }), null, 2);
  fs.writeFileSync(dbFile(dir), full.slice(0, Math.floor(full.length / 2)));

  const m = await freshDbModule(dir);
  const db = m.loadDb();

  check('壊れていても空から始めない', Object.keys(db.users).length > 0, `${Object.keys(db.users).length}人`);
  check('いちばん新しいスナップショットを使う', Object.keys(db.users).length === 7,
    `${Object.keys(db.users).length}人（7=新しい方 / 2=古い方）`);
  // これが本丸。seedHash が生き残らないと同梱 seed が再適用され、
  // データが seed の時点まで巻き戻る。
  check('seedHash が生き残る（seed の再適用を防ぐ門）', db.meta.seedHash === 'ALREADY-APPLIED',
    String(db.meta.seedHash));
  const kept = fs.readdirSync(dir).filter(f => f.startsWith('db.json.corrupt-'));
  check('壊れたファイルは捨てずに残す', kept.length === 1, kept.join(','));
}

// ---- ③ スナップショットも無い場合 -------------------------------------------
{
  const dir = path.join(ROOT, 'nosnap');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbFile(dir), '{"users": {"a": ');   // 壊れている

  const m = await freshDbModule(dir);
  const db = m.loadDb();
  check('復旧材料が無くても起動はできる', !!db && typeof db.users === 'object', '');
  check('その場合は空のデータベース', Object.keys(db.users).length === 0, `${Object.keys(db.users).length}人`);
  // seedHash が無い＝seed 未適用あつかい。ここは意図どおり（本当に空なので、
  // 同梱 seed から復元してもらったほうがよい）。
  check('seedHash は無い（seed からの復元を許す）', db.meta.seedHash === undefined, String(db.meta.seedHash));
}

// ---- ④ 空でない db.json を壊れたスナップショットで上書きしない ----------------
{
  const dir = path.join(ROOT, 'badsnap');
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-08-27T00-00-00-000Z_boot.json'), '{{{ broken');
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-08-26T00-00-00-000Z_boot.json'),
    JSON.stringify(makeDb(4, { seedHash: 'KEEP' })));
  fs.writeFileSync(dbFile(dir), 'not json at all');

  const m = await freshDbModule(dir);
  const db = m.loadDb();
  check('壊れたスナップショットは飛ばして次を試す', Object.keys(db.users).length === 4,
    `${Object.keys(db.users).length}人`);
  check('その場合も seedHash は戻る', db.meta.seedHash === 'KEEP', String(db.meta.seedHash));
}

// ---- ⑤ 復元が seedHash を巻き戻さないか ------------------------------------
// seedHash は「同梱 seed をもう適用したか」の記録で、この機体の履歴に属する。
// /api/admin/backup は db を丸ごと書き出すので、バックアップにも seedHash が入る。
// それを replace で戻すと記録が当時に巻き戻り、次の起動で古い seed が
// 「未適用」と判定されて再適用される — 復元したばかりのデータの上に被さる。
{
  const { applyRestore } = await import('../server/backup.js');
  const live = () => ({
    users: { a: { id: 'a', username: 'いま', stats: { gamesPlayed: 5 } } },
    tokens: {}, revoked: {}, deleted: {}, guilds: {}, news: [], season: null,
    transactions: [], bugreports: [], meta: { createdAt: 1, seedHash: 'CURRENT' },
  });
  const oldBackup = {
    users: { b: { id: 'b', username: 'むかし', stats: { gamesPlayed: 1 } } },
    tokens: {}, meta: { createdAt: 1, seedHash: 'ANCIENT', popScale: 2 },
  };

  const db1 = live();
  applyRestore(db1, oldBackup, 'replace');
  check('replace: seedHash は現在の値のまま', db1.meta.seedHash === 'CURRENT', String(db1.meta.seedHash));
  check('replace: seedHash 以外の meta は復元される', db1.meta.popScale === 2, String(db1.meta.popScale));
  check('replace: ユーザーは置き換わる', !!db1.users.b && !db1.users.a, Object.keys(db1.users).join(','));

  const db2 = live();
  applyRestore(db2, oldBackup, 'merge');
  check('merge: seedHash も現在の値のまま', db2.meta.seedHash === 'CURRENT', String(db2.meta.seedHash));

  // seedHash をまだ持っていない機体（＝一度も seed を当てていない）に、
  // seedHash 入りのバックアップを流し込んでも、勝手に「適用済み」にしない。
  const db3 = live();
  delete db3.meta.seedHash;
  applyRestore(db3, oldBackup, 'replace');
  check('seedHash 未設定の機体に持ち込まれない', db3.meta.seedHash === undefined, String(db3.meta.seedHash));

  // merge の db.meta は「持ち込まないキーの一覧（拒否リスト）」で守られている。
  // 以前は逆の許可リスト（持ち込んでよいキーの一覧）で、そこに書き足し忘れた
  // throneMax（世界がこれまでに割った最高段）と newsUnpinned が毎回落ちていた。
  // throneMax が消えると 👑王座ショップは棚が max >= dan でしか開かないので、
  // ディスクごと消える再デプロイ ── まさにこの復元機構が要る場面 ── のたびに
  // 7品すべてが買えなくなる。newsUnpinned が消えると unpinOldReleaseNotes の
  // 「一度きり」が毎回やり直され、📌し直したお知らせが起動のたびに剥がされる。
  // 次に誰かが「安全のため」と許可リストへ戻したら、ここで落ちるようにしておく。
  const db4 = live();
  delete db4.meta.seedHash;              // seedHash をまだ持っていない機体
  // JSON.parse を通すのは意図的。"__proto__" を素の own プロパティとして作れる
  // のはこの経路だけで（オブジェクトリテラルではプロトタイプ指定になる）、
  // 実際の復元もファイルを JSON.parse した結果を受け取る。
  const worldBackup = JSON.parse(`{
    "users": {}, "tokens": {},
    "meta": {
      "createdAt": 999, "throneMax": 7, "newsUnpinned": true, "popScale": 3,
      "seedHash": "ANCIENT", "backupAt": 1700000000000, "backupVersion": 2,
      "__proto__": { "polluted": "yes" }
    }
  }`);
  applyRestore(db4, worldBackup, 'merge');
  check('merge: throneMax が持ち越される（👑王座ショップの棚）', db4.meta.throneMax === 7, String(db4.meta.throneMax));
  check('merge: newsUnpinned が持ち越される', db4.meta.newsUnpinned === true, String(db4.meta.newsUnpinned));
  check('merge: 一覧に無い世界の状態（popScale）も持ち越される', db4.meta.popScale === 3, String(db4.meta.popScale));
  check('merge: seedHash 未設定の機体にも持ち込まれない', db4.meta.seedHash === undefined, String(db4.meta.seedHash));
  // backupAt / backupVersion はバックアップファイル自身の素性で、世界の状態では
  // ない。持ち込むと「いつ取ったバックアップか」が現在の db の値として居座る。
  check('merge: backupAt / backupVersion は持ち込まれない',
    db4.meta.backupAt === undefined && db4.meta.backupVersion === undefined,
    `${db4.meta.backupAt} / ${db4.meta.backupVersion}`);
  // 拒否リストへの反転で「既定は持ち越す」になったが、**生きている側が既に
  // 持っている値まで上書きする**わけではない（起動後に管理者が設定した値を
  // 古いファイルで巻き戻さないため）。ここも一緒に固定する。
  check('merge: 生きている側が持っている値は上書きされない', db4.meta.createdAt === 1, String(db4.meta.createdAt));
  // ファイルの中身は外から来る。"__proto__" を代入するとプロトタイプの setter が
  // 動き、db.meta のプロトタイプがファイル側のオブジェクトに差し替わる ──
  // 以後 db.meta.（知らないキー）がファイルの値を返すようになる。
  // いまは二重に塞がっている（キー名の明示スキップと、`db.meta[k] == null` の
  // 条件 ── db.meta.__proto__ は Object.prototype なので null ではない）。
  // どちらの理由で守られているかではなく「結果として差し替わらない」を固定する。
  check('merge: "__proto__" でプロトタイプが差し替わらない',
    Object.getPrototypeOf(db4.meta) === Object.prototype
      && !Object.prototype.hasOwnProperty.call(db4.meta, '__proto__'),
    String(db4.meta.polluted));
}
fs.rmSync(ROOT, { recursive: true, force: true });
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
