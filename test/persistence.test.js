import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectSaver } from '../public/js/persistence.js';
import { newProject, makeScenario, setProject, state, markDirty } from '../public/js/store.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
test('in-flight saves are deduplicated and newer edits remain dirty', async () => {
  const p = newProject('Test');
  const local = { project: p, dirty: true, editRevision: 1 };
  const response = deferred();
  let requests = 0;
  let payload;
  const save = createProjectSaver(local, { createProject: (body) => {
    requests++; payload = body; return response.promise;
  } });
  const first = save();
  assert.equal(save(), first);
  p.scenarios.push(makeScenario());
  local.editRevision++;
  response.resolve({ project: { id: 42, revision: 1, name: p.name, visibility: 'restricted', viewers: [] } });
  await first;
  assert.equal(requests, 1);
  assert.equal(payload.data.scenarios.length, 1);
  assert.equal(local.dirty, true);
  assert.equal(p.id, 42);
});
test('content saves omit sharing and do not clear another project dirty flag', async () => {
  const p = { ...newProject('Original'), id: 1, revision: 3, visibility: 'public' };
  const local = { project: p, dirty: true, editRevision: 1 };
  const response = deferred();
  let payload;
  const save = createProjectSaver(local, { updateProject: (_id, body) => { payload = body; return response.promise; } });
  const operation = save();
  local.project = newProject('Other');
  local.editRevision++;
  response.resolve({ project: { id: 1, revision: 4, name: p.name, visibility: 'restricted', viewers: [] } });
  await operation;
  assert.deepEqual(Object.keys(payload).sort(), ['data', 'revision']);
  assert.equal(local.dirty, true);
  assert.equal(p.visibility, 'restricted');
});
test('unchanged saved snapshot clears dirty; staging is project scoped', async () => {
  const a = newProject('A');
  const b = newProject('B');
  setProject(a);
  markDirty();
  a.staging.push({ name: 'Only A' });
  setProject(b);
  assert.deepEqual(state.project.staging, []);
  markDirty();
  const save = createProjectSaver(state, { createProject: async () => ({ project: { ...b, id: 2, revision: 1 } }) });
  await save();
  assert.equal(state.dirty, false);
  assert.equal(a.staging.length, 1);
});