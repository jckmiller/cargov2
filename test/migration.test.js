import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('old databases migrate idempotently without losing users or projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-migration-'));
  const path = join(dir, 'old.sqlite');
  try {
    let db = new Database(path);
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, created_at TEXT);
      CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, visibility TEXT, data TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO users VALUES (1, 'existing', 'hash', 'admin', '2020-01-01');
      INSERT INTO projects VALUES (1, 'Preserve me', 1, 'restricted', '{}', '2020-01-01', '2020-01-01');`);
    db.close();
    for (let i = 0; i < 2; i++) {
      const script = `import db from ${JSON.stringify(new URL('../server/db.js', import.meta.url).href)}; db.close();`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DB_PATH: path }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    db = new Database(path);
    try {
      assert.equal(db.prepare('SELECT token_version FROM users WHERE id = 1').get().token_version, 0);
      assert.deepEqual(db.prepare('SELECT name, revision FROM projects WHERE id = 1').get(), { name: 'Preserve me', revision: 1 });
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});