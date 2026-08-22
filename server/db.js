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
  season: null,     // { id, name, number, endsAt }
  transactions: [], // gem purchases (demo)
  meta: { createdAt: Date.now() },
};

let db = null;
let saveTimer = null;

export function loadDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      console.error('[db] failed to parse db.json, starting fresh:', err.message);
      db = structuredClone(DEFAULT_DB);
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
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[db] save failed:', err.message);
    }
  }, 250);
}

export function flushDb() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[db] flush failed:', err.message);
  }
}

export { DATA_DIR };
