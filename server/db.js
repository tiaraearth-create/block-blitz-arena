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
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);            // OSのキャッシュ止まりにせず、実際に書かせる
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
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
      if (!db) {
        console.error('[db] 使えるスナップショットもありません。空のデータベースで起動します');
        db = structuredClone(DEFAULT_DB);
      }
    }
  } else {
    db = structuredClone(DEFAULT_DB);
  }
  for (const key of Object.keys(DEFAULT_DB)) {
    if (!(key in db)) db[key] = structuredClone(DEFAULT_DB[key]);
  }
  return db;
}

export function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeAtomic(DB_FILE, JSON.stringify(db, null, 2));
    } catch (err) {
      console.error('[db] save failed:', err.message);
    }
  }, 250);
}

export function flushDb() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    writeAtomic(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[db] flush failed:', err.message);
  }
}

export { DATA_DIR };
