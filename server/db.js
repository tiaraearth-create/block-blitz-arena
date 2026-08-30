// Simple JSON-file persistence layer with debounced atomic writes.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR env lets tests (and hosts with a mounted disk elsewhere) relocate the data.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  users: {},        // id -> user record
  tokens: {},       // legacy token -> { userId, createdAt }
  revoked: {},      // signed token -> revokedAt (single-device logouts)
  deleted: {},      // userId -> deletedAt (so a stale session knows the account is gone)
  guilds: {},       // guildId -> guild
  news: [],         // announcements [{ id, title, body, at, pinned, by }]
  season: null,     // legacy — the season derives from SEASON_EPOCH since v2.6
  transactions: [], // gem purchases (demo)
  bugreports: [],   // player bug reports [{ id, text, by, role, ua, at, status }]
  meta: { createdAt: Date.now() },
};

let db = null;
let saveTimer = null;
// 直近の書き込みが失敗していたら、その理由。成功したら null に戻す。
// これまで saveDb / flushDb は例外を console に出して飲み込むだけで、
// 呼び出し元には成否を伝えていなかった。そのため /api/admin/restore は
// ディスクが満杯・読み取り専用・未マウントで1バイトも書けていなくても
// 200 と「💾 データを復元しました」の全体アナウンスを返し、管理画面には
// メモリ上の（正しく見える）データが出る。管理者が異常に気づけるのは
// 再起動して全部消えたあと、という最悪の順序だった。
// このホスティングは「ディスクが無くてデータが飛んだ」を実際に踏んでいる。
// 書けなかったことは必ず外から見えるようにする。
let lastWriteError = null;
// 直近の db.json 書き込みにかかった時間(ms)と、書いたバイト数。
// db が育つと saveDb は 250ms のデバウンス明けに同期で走り、fsync まで待つ。
// つまり保存が重くなると、その分だけイベントループが素で止まる。管理画面から
// 「今の保存は何msで何バイトか」が見えれば、重くなり始めた時点で気づける。
// 値は writeAtomic が実際に書けたときだけ更新する（失敗時は lastWriteError 側）。
let lastWriteMs = null;
let lastWriteBytes = null;

// 本体の db.json はここで無整形に書く。整形（インデント2）は人が読むための
// もので、db.json を人が開くのは事故のときだけ。実際に読むのは JSON.parse
// なので整形の有無は互換性に影響しない一方、インデントと改行はユーザーが
// 増えるほど効いてきて、書き出すバイト数＝fsync するバイト数＝保存で止まる
// 時間になる。読みやすい写しが要る経路（backup.js の snapshot と
// /api/admin/backup のダウンロード）は別系統なので、そちらは触らない。
function serializeDb() {
  return JSON.stringify(db);
}

// db.json を安全に書く。同じディレクトリに一時ファイルを作り、ディスクまで
// 確実に書き出してから rename で差し替える。rename(2) は不可分なので、
// 読み手が見るのは「前の完全なファイル」か「新しい完全なファイル」だけになる。
//
// flushDb は以前 DB_FILE へ直接 writeFileSync していた。これはファイルを
// 先に空にしてから書くので、書いている途中でプロセスが殺されると（Render は
// 終了猶予を過ぎると SIGKILL を送る。しかも v2.11 で終了処理が実仕事をする
// ようになった）中途半端な db.json が残る。次の起動でそれは JSON として
// 読めず、空のデータベースから始まってしまう — 同時に db.meta.seedHash も
// 失われる。それは同梱 seed の再適用を止めている唯一の門なので、
// 書き込みが1回中断されるだけで、以前起きたデータ巻き戻りが再現しうる。
function writeAtomic(file, text) {
  const startedAt = performance.now();
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);            // OSのキャッシュ止まりにせず、実際に書かせる
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // ここまで来たら本当にディスクに載っている。計測値はその時だけ更新する。
  lastWriteMs = Math.round((performance.now() - startedAt) * 10) / 10;
  lastWriteBytes = Buffer.byteLength(text);
}

// db.json が壊れていたときの最後の砦。起動ごとに撮っている
// snapshots/ の中で、いちばん新しく中身のあるものを採用する。
// スナップショットは db 全体の写しなので meta.seedHash も一緒に戻る。
function recoverFromSnapshot() {
  try {
    const dir = path.join(DATA_DIR, 'snapshots');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
        if (snap && snap.users && Object.keys(snap.users).length) {
          console.error(`[db] スナップショット ${files[i]} から復旧しました（${Object.keys(snap.users).length}人）`);
          return snap;
        }
      } catch { /* これも壊れていた。1つ前を試す */ }
    }
  } catch { /* snapshots ディレクトリがまだ無い */ }
  return null;
}

export function loadDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let recovered = false;
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      // ここで黙って空から始めるのが、いちばんやってはいけない対応だった。
      // 全アカウントが消えるうえ db.meta.seedHash も道連れになり、同梱 seed が
      // 再適用されて「意図した巻き戻し」と見分けがつかない壊れ方をする。
      console.error('[db] db.json を読み込めません:', err.message);
      try {
        const kept = `${DB_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(DB_FILE, kept);
        console.error(`[db] 壊れたファイルは ${path.basename(kept)} として残しました（手動で救出できます）`);
      } catch { /* 残せなくても復旧は続ける */ }
      db = recoverFromSnapshot();
      if (db) recovered = true;
      else {
        console.error('[db] 使えるスナップショットもありません。空のデータベースで起動します');
        db = structuredClone(DEFAULT_DB);
      }
    }
  } else {
    // db.json が無い。ふつうは初回起動だが、破損復旧はメモリ上で先に済み、
    // ディスクへ書く前にプロセスが死ぬ窓がある。そこで殺されると次回は
    // ここに来る ── 何もせず空DBで起動すると seedHash が失われ、同梱 seed が
    // 再適用されてデータが seed 時点まで巻き戻る。まずスナップショットを試す。
    db = recoverFromSnapshot();
    if (db) {
      recovered = true;
      console.error('[db] db.json が見つかりません。スナップショットから復旧しました（意図的にリセットしたいときは snapshots/ も一緒に消してください）');
    } else {
      db = structuredClone(DEFAULT_DB);
    }
  }
  for (const key of Object.keys(DEFAULT_DB)) {
    if (!(key in db)) db[key] = structuredClone(DEFAULT_DB[key]);
  }
  // 復旧したのにディスクへ書き戻さずに進むと、次にプロセスが死んだとき今度は
  // 「db.json 無しの通常初回起動」と区別が付かず、空DB→seed再適用に化ける。
  // 復旧できたときはその場で db.json を確定させ、その窓を閉じる。
  if (recovered) {
    try { writeAtomic(DB_FILE, serializeDb()); lastWriteError = null; }
    catch (e) { lastWriteError = e.message; console.error('[db] 復旧直後の書き込みに失敗:', e.message); }
  }
  // まだ一度も保存していない間も現在のサイズを答えられるように、起動時に
  // ディスク上の db.json から拾っておく（復旧書き込みが走った場合はその実測値が既に入っている）。
  if (lastWriteBytes === null) {
    try { lastWriteBytes = fs.statSync(DB_FILE).size; } catch { /* 初回起動でまだファイルが無い */ }
  }
  return db;
}

// 遅延書き込み。呼び出し元は結果を受け取れない（250ms後に走るので）ため、
// 失敗は lastPersistError() で拾う。
export function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeAtomic(DB_FILE, serializeDb());
      lastWriteError = null;
    } catch (err) {
      lastWriteError = err.message;
      console.error('[db] save failed:', err.message);
    }
  }, 250);
}

// ディスクまで書けたら true、書けなかったら false。
// 「保存しました」「復元しました」と名乗る前に、必ずこの戻り値を見ること。
// 返り値を無視しても以前と同じ挙動なので、既存の呼び出しは壊れない。
export function flushDb() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    writeAtomic(DB_FILE, serializeDb());
    lastWriteError = null;
    return true;
  } catch (err) {
    lastWriteError = err.message;
    console.error('[db] flush failed:', err.message);
    return false;
  }
}

// 直近の永続化が失敗していればその理由、成功していれば null。
// 管理画面や /api/status から「今ディスクに書けていない」と分かるようにするための口。
export function lastPersistError() { return lastWriteError; }

// 直近に成功した db.json 書き込みの所要ミリ秒（小数第1位まで）。まだ一度も
// 書けていなければ null。保存は同期＋fsync なので、この値はそのままイベント
// ループが止まった時間として読める。
export function lastPersistMs() { return lastWriteMs; }

// 直近に書いた db.json のバイト数。起動直後でまだ保存していない間は、
// ディスク上の db.json の実サイズ。ファイルがまだ無ければ null。
export function lastDbBytes() { return lastWriteBytes; }

export { DATA_DIR };
