import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, '..', 'data', 'a3shipping.sqlite');

// Ensure the containing directory exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Auto-migrations: create tables if they do not exist. Kept idempotent so the
 * server can boot against a fresh or existing database.
 */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('admin','editor','viewer')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      owner_id    INTEGER NOT NULL,
      visibility  TEXT NOT NULL DEFAULT 'restricted'
                    CHECK (visibility IN ('public','restricted')),
      data        TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_viewers (
      project_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
    CREATE INDEX IF NOT EXISTS idx_pv_user        ON project_viewers(user_id);
  `);
}

/**
 * Seed an initial admin account if there are no users yet. The username and
 * password come from ADMIN_USERNAME / ADMIN_PASSWORD so no weak default
 * credential ships to production. In production a password MUST be provided.
 */
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count !== 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'No users exist and ADMIN_PASSWORD is not set. Set ADMIN_PASSWORD ' +
          '(and optionally ADMIN_USERNAME) to seed the initial admin account.'
      );
    }
    // Development-only convenience fallback.
    const hash = bcrypt.hashSync('123123', 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin', hash, 'admin');
    // eslint-disable-next-line no-console
    console.log('[db] Seeded development admin user: admin / 123123');
    return;
  }

  const hash = bcrypt.hashSync(String(password), 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(String(username), hash, 'admin');
  // eslint-disable-next-line no-console
  console.log(`[db] Seeded initial admin user: ${username}`);
}

migrate();
seed();

export default db;
