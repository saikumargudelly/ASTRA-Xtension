import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'astra.db');

let db: Database.Database;

export function getDb(): Database.Database {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initSchema();
    }
    return db;
}

function initSchema() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      plan_json TEXT,
      result_json TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      text TEXT NOT NULL,
      embedding_id TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Default user and session for MVP
    INSERT OR IGNORE INTO users (id) VALUES ('default-user');
    INSERT OR IGNORE INTO sessions (id, user_id) VALUES ('default-session', 'default-user');
  `);
}

export function closeDb() {
    if (db) {
        db.close();
    }
}
