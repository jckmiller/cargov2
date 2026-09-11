import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Set before dynamic imports: never touch the developer's database.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.JWT_SECRET = 'isolated-test-signing-key';
const { default: db } = await import('../server/db.js');
const { signToken } = await import('../server/auth.js');
const { default: users } = await import('../server/routes/users.routes.js');
const { default: projects } = await import('../server/routes/projects.routes.js');
const app = express();
app.use(express.json());
app.use('/users', users);
app.use('/projects', projects);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});
const admin = db.prepare('SELECT * FROM users LIMIT 1').get();
const adminToken = signToken(admin);
async function request(method, path, body, token = adminToken) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
function user(name, role = 'admin') {
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(name, admin.password_hash, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
}

test('demotion immediately removes admin permissions from existing tokens', async () => {
  const target = user('demoted');
  const token = signToken(target);
  assert.equal((await request('PUT', `/users/${target.id}`, { role: 'viewer' })).status, 200);
  assert.equal((await request('GET', '/users', undefined, token)).status, 403);
});

test('deleted accounts and password-reset sessions are rejected', async () => {
  const target = user('deleted');
  const token = signToken(target);
  await request('DELETE', `/users/${target.id}`);
  assert.equal((await request('GET', '/users', undefined, token)).status, 401);
  const reset = user('reset');
  const resetToken = signToken(reset);
  await request('PUT', `/users/${reset.id}`, { password: 'replacement-password' });
  assert.equal((await request('GET', '/users', undefined, resetToken)).status, 401);
});

test('invalid viewers cannot partially create or update a project', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const before = count();
  assert.equal((await request('POST', '/projects', { name: 'Invalid', viewers: [999999] })).status, 400);
  assert.equal(count(), before);
  const viewer = user('shared', 'viewer');
  const created = await request('POST', '/projects', { name: 'Original', viewers: [viewer.id] });
  const p = created.body.project;
  const bad = await request('PUT', `/projects/${p.id}`, {
    name: 'Changed', visibility: 'public', viewers: [999999], revision: p.revision,
  });
  assert.equal(bad.status, 400);
  const saved = (await request('GET', `/projects/${p.id}`)).body.project;
  assert.equal(saved.name, 'Original');
  assert.equal(saved.visibility, 'restricted');
  assert.deepEqual(saved.viewers.map((v) => v.id), [viewer.id]);
});

test('updates require a current revision and content saves preserve sharing', async () => {
  const p = (await request('POST', '/projects', { name: 'Versioned', visibility: 'public' })).body.project;
  assert.equal((await request('PUT', `/projects/${p.id}`, { name: 'Unversioned' })).status, 428);
  const changed = await request('PUT', `/projects/${p.id}`, { revision: p.revision, visibility: 'restricted' });
  assert.equal(changed.status, 200);
  assert.equal((await request('PUT', `/projects/${p.id}`, { revision: p.revision, visibility: 'public' })).status, 409);
  const saved = await request('PUT', `/projects/${p.id}`, {
    revision: changed.body.project.revision, data: { catalog: [], scenarios: [] },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.project.visibility, 'restricted');
});

test('unexpected viewer insertion failures roll back both data and sharing', async () => {
  const viewer = user('rollback-viewer', 'viewer');
  const p = (await request('POST', '/projects', { name: 'Atomic', viewers: [viewer.id] })).body.project;
  db.exec(`CREATE TRIGGER fail_viewers BEFORE INSERT ON project_viewers BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  try {
    const failed = await request('PUT', `/projects/${p.id}`, { revision: p.revision, name: 'Partial', viewers: [viewer.id] });
    assert.equal(failed.status, 500);
    const saved = (await request('GET', `/projects/${p.id}`)).body.project;
    assert.equal(saved.name, 'Atomic');
    assert.equal(saved.revision, p.revision);
    assert.deepEqual(saved.viewers.map((v) => v.id), [viewer.id]);
  } finally { db.exec('DROP TRIGGER fail_viewers'); }
});

test('malformed project data receives validation errors without changing data', async () => {
  const response = await request('POST', '/projects', { name: 'Malformed', data: { catalog: [], scenarios: [null] } });
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT 1 FROM projects WHERE name = ?').get('Malformed'), undefined);
});