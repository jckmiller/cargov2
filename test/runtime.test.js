import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

test('production entry point serves frontend, login, workers and JSON API errors', async () => {
  const child = spawn(process.execPath, [new URL('../server/index.js', import.meta.url).pathname], {
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', DB_PATH: ':memory:',
      JWT_SECRET: 'runtime-test-secret-not-used-in-production', ADMIN_PASSWORD: 'test-runtime-password', ADMIN_USERNAME: 'admin', TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${errors}`)), 10000);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Exited ${code}: ${errors}`)); });
      child.stdout.on('data', (data) => {
        output += data;
        const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const page = await fetch(base);
    assert.match(await page.text(), /js\/main.js/);
    assert.match(page.headers.get('content-security-policy'), /worker-src 'self'/);
    assert.equal((await fetch(`${base}/js/autoload.worker.js`)).status, 200);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-runtime-password' }) });
    const session = await login.json();
    assert.equal(login.status, 200);
    const projects = await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${session.token}` } });
    assert.deepEqual((await projects.json()).projects, []);
    const unknown = await fetch(`${base}/api/not-a-route`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'API route not found');
    const malformed = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.ok((await malformed.json()).error);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
});

test('online WAL backup is consistent and refuses overwriting an existing backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-backup-'));
  const source = join(dir, 'live.sqlite');
  const destination = join(dir, 'backup.sqlite');
  const db = new Database(source);
  try {
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('preserved');");
    const run = () => spawnSync(process.execPath, [new URL('../scripts/backup.js', import.meta.url).pathname, destination], {
      env: { ...process.env, DB_PATH: source }, encoding: 'utf8', timeout: 10000,
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const backup = new Database(destination, { readonly: true });
    try { assert.equal(backup.prepare('SELECT value FROM example').get().value, 'preserved'); }
    finally { backup.close(); }
    assert.notEqual(run().status, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});