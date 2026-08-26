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

fs.rmSync(ROOT, { recursive: true, force: true });
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
