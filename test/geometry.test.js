import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as cargo from '../public/js/cargo.js';
import { getContainer } from '../public/js/container.js';
import { validateProjectData } from '../public/js/projectValidation.js';
import { newProject, makeScenario } from '../public/js/store.js';

const box = (id, x = 0, y = 0, dims = { l: 2, w: 2, h: 2 }) => ({
  id, catalogItemId: 'cat', name: id, x, y, z: 0, dims, weight: 10, category: 'general', hazmatClass: 'none',
});
test('layout validation rejects floating cargo, overlaps, out-of-bounds and lost support', () => {
  const spec = getContainer('20STD');
  assert.equal(cargo.layoutError([box('base'), box('top', 0, 2)], spec), null);
  assert.match(cargo.layoutError([box('top', 0, 2)], spec), /unsupported/);
  assert.match(cargo.layoutError([box('base'), box('overlap', 1)], spec), /overlaps/);
  assert.match(cargo.layoutError([box('wide', 0, 0, { l: 2, w: 10, h: 2 })], spec), /outside/);
  assert.match(cargo.layoutError([box('base'), box('top', 1, 2)], spec), /unsupported/);
});
test('project validation rejects over-allocation, orphan placements and malformed imports', () => {
  const p = newProject();
  p.catalog = [cargo.makeCatalogItem({ id: 'cat', qtyAvailable: 1 })];
  p.scenarios[0].placements = [box('one')];
  assert.equal(validateProjectData(p), p);
  const copy = makeScenario();
  copy.placements = [box('two')];
  p.scenarios.push(copy);
  assert.throws(() => validateProjectData(p), /exceeds available/);
  p.catalog = [];
  assert.throws(() => validateProjectData(p), /missing catalog/);
  assert.throws(() => validateProjectData({ scenarios: [null], catalog: [] }), /Container IDs/);
});

// Exercise the real interaction methods without loading CDN Three.js or WebGL.
// These methods only need the actual cargo helpers plus renderer/state doubles.
function interaction(placements) {
  const scenario = { placements };
  const source = fs.readFileSync(new URL('../public/js/interaction.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export class Interaction', 'class Interaction');
  const C = vm.runInNewContext(`${source}\nInteraction`, {
    ...cargo, activeScenario: () => scenario, catalogItem: () => null, toast: () => {},
  });
  const instance = Object.create(C.prototype);
  instance.sm = { upsertPlacement: () => {} };
  instance.cb = { getContainerSpec: () => getContainer('20STD'), getSnapEnabled: () => false, onChange: () => {} };
  instance.getSelectedIds = () => placements.map((p) => p.id);
  return instance;
}
test('group drag uses immutable start coordinates, not accumulated movement', () => {
  const placements = [box('a'), box('b', 3)];
  const control = interaction(placements);
  control.dragging = { anchor: { x: 0, z: 0 }, moveSet: new Set(['a', 'b']),
    members: placements.map((p) => ({ placement: p, start: { x: p.x, y: p.y, z: p.z }, lastValid: { x: p.x, y: p.y, z: p.z } })) };
  control.moveGroup({ x: 1, z: 0 });
  assert.deepEqual(placements.map((p) => p.x), [1, 4]);
  control.moveGroup({ x: 1, z: 0 });
  assert.deepEqual(placements.map((p) => p.x), [1, 4]);
});
test('nudge cannot create floating cargo and rotation cannot exceed bounds', () => {
  const p = box('wide', 0, 0, { l: 10, w: 2, h: 2 });
  const control = interaction([p]);
  control.nudgeSelected({ dy: 1 });
  assert.equal(p.y, 0);
  control.transformPlacement(p, (d) => ({ dims: { l: d.w, w: d.l, h: d.h }, rot: { rot: 90 } }), 'rotate');
  assert.equal(p.dims.w, 2);
});