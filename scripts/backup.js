import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.DB_PATH || fileURLToPath(new URL('../data/a3shipping.sqlite', import.meta.url));
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) {
  throw new Error('Usage: npm run backup -- /absolute/path/to/backup.sqlite');
}
if (existsSync(destination)) throw new Error('Backup destination already exists; choose a new file');
mkdirSync(path.dirname(destination), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || backup.pragma('foreign_key_check').length) {
      throw new Error('Backup validation failed');
    }
  } finally { backup.close(); }
  console.log(`Verified SQLite backup: ${destination}`);
} finally { db.close(); }