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
test('removal is blocked only when it strands cargo, not by unrelated pre-existing issues', () => {
  const spec = getContainer('20STD');
  // Removing the base strands the stacked item: blocked with a useful message.
  const stacked = [box('base'), box('top', 0, 2)];
  assert.match(cargo.removalError(stacked, 'base', spec), /"top" would be unsupported/);
  // Removing an unrelated item from a valid layout is fine.
  assert.equal(cargo.removalError([...stacked, box('far', 6)], 'far', spec), null);
  // A pre-existing floating item must not block removing an unrelated item.
  const legacy = [box('ghost', 0, 2), box('unrelated', 6)];
  assert.equal(cargo.removalError(legacy, 'unrelated', spec), null);
  // Removing the pre-existing problematic item itself is allowed too.
  assert.equal(cargo.removalError(legacy, 'ghost', spec), null);
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
function interaction(placements, toast = () => {}) {
  const scenario = { placements };
  const source = fs.readFileSync(new URL('../public/js/interaction.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export class Interaction', 'class Interaction');
  const C = vm.runInNewContext(`${source}\nInteraction`, {
    ...cargo, activeScenario: () => scenario, catalogItem: () => null, toast,
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

// --- Drag-time auto-reorientation (fitAtSpot + moveSingle) -----------------
test('fitAtSpot keeps the current orientation when it fits', () => {
  const spec = getContainer('20STD');
  const fit = cargo.fitAtSpot(1, 1, [box('base', 6)], spec, { l: 2, w: 2, h: 2 });
  assert.deepEqual(fit.dims, { l: 2, w: 2, h: 2 });
  assert.deepEqual(fit.rot, { rot: 0, tipped: false });
});
test('fitAtSpot rotates 90° when only the rotated footprint fits', () => {
  const spec = getContainer('20STD'); // width 7'8.5" ≈ 7.708 ft
  // Base occupies z 0..4; the remaining strip (z 4..7.708) is ~3.708 ft wide.
  const base = { ...box('base'), dims: { l: 4, w: 4, h: 3 } };
  // Item A is 3 ft along length x 4 ft across width: too wide for the strip
  // as-is, but fits when rotated to 4 x 3.
  const fit = cargo.fitAtSpot(0, 4.2, [base], spec, { l: 3, w: 4, h: 2 });
  assert.ok(fit, 'expected a rotated fit beside the base');
  assert.deepEqual(fit.dims, { l: 4, w: 3, h: 2 });
  assert.equal(fit.rot.rot, 90);
  assert.equal(fit.rot.tipped, false);
  assert.ok(fit.z >= 4 - 1e-6 && fit.z + 3 <= spec.width + 1e-6);
});
test('fitAtSpot stacks on supports only in the orientation that fits', () => {
  const spec = getContainer('20STD');
  // Support C occupies z 4..7.5, top at y=2. Item A (l3 x w4) overhangs C as-is
  // (4 > 3.5 wide support) but rests fully once rotated to w=3.
  const support = { ...box('support', 0, 0, { l: 4, w: 3.5, h: 2 }), z: 4 };
  const opts = { stack: true, item: { category: 'general', hazmatClass: 'none' } };
  const fit = cargo.fitAtSpot(0, 4, [support], spec, { l: 3, w: 4, h: 2 }, opts);
  assert.ok(fit, 'expected a stacked fit after rotating');
  assert.equal(fit.y, 2); // resting on top of the support
  assert.deepEqual(fit.dims, { l: 4, w: 3, h: 2 });
});
test('fitAtSpot never tips a do-not-tip item', () => {
  const spec = getContainer('20STD'); // internal height ~7.85 ft
  // 9 ft tall upright only fits tipped (h becomes 2). With noTip, no fit.
  const dims = { l: 2, w: 2, h: 9 };
  assert.equal(cargo.fitAtSpot(0, 0, [], spec, dims, { noTip: true }), null);
  const fit = cargo.fitAtSpot(0, 0, [], spec, dims);
  assert.ok(fit.rot.tipped, 'without noTip the tipped variant is allowed');
  assert.equal(fit.dims.h, 2);
});
test('single-item drag auto-rotates to fit beside a blocking item', () => {
  const spec = getContainer('20STD');
  // Item A sits on top of item B. Beside B there is no room for A's 4-ft
  // width, but there is once A is rotated to 4 long x 3 wide.
  const b = { ...box('b'), dims: { l: 4, w: 4, h: 3 } };
  const a = { ...box('a', 0, 3, { l: 3, w: 4, h: 2 }) };
  a.rot = { rot: 0, tipped: false };
  const control = interaction([b, a]);
  control.dragging = {
    stackMode: false, moveSet: new Set(['a']), moved: false,
    members: [{ placement: a, offset: { x: 0, z: 0 }, lastValid: { x: a.x, y: a.y, z: a.z } }],
  };
  control.moveSingle({ x: 0, z: 4.2 }); // drag A into the strip beside B
  assert.equal(a.y, 0, 'A should drop to the floor beside B');
  assert.deepEqual(a.dims, { l: 4, w: 3, h: 2 }, 'A should have auto-rotated 90°');
  assert.equal(a.rot.rot, 90);
  assert.equal(cargo.collidesAny(a, [b]), false);
});
test('single-item drag settles on top of cargo blocking the floor spot', () => {
  const b = box('b'); // 2x2x2 at the origin
  const a = { ...box('a', 6, 0, { l: 2, w: 2, h: 2 }) };
  a.rot = { rot: 0, tipped: false };
  const control = interaction([b, a]);
  control.dragging = {
    moveSet: new Set(['a']), moved: false,
    anchor: { x: 6, z: 0 },
    members: [{ placement: a, offset: { x: 0, z: 0 }, lastValid: { x: a.x, y: a.y, z: a.z } }],
  };
  control.moveSingle({ x: 0, z: 0 }); // onto B's footprint: floor taken, A stacks on top
  assert.deepEqual({ x: a.x, y: a.y, z: a.z }, { x: 0, y: 2, z: 0 });
});
test('single-item drag snaps back when there is no legal rest', () => {
  const b = { ...box('b'), category: 'fragile' }; // fragile: cannot support cargo
  const a = { ...box('a', 6, 0, { l: 2, w: 2, h: 2 }) };
  a.rot = { rot: 0, tipped: false };
  const control = interaction([b, a]);
  control.dragging = {
    moveSet: new Set(['a']), moved: false,
    anchor: { x: 6, z: 0 },
    members: [{ placement: a, offset: { x: 0, z: 0 }, lastValid: { x: a.x, y: a.y, z: a.z } }],
  };
  control.moveSingle({ x: 0, z: 0 }); // onto a fragile base: no legal rest
  assert.deepEqual({ x: a.x, y: a.y, z: a.z }, { x: 6, y: 0, z: 0 });
});
test('plain drag crosses stacked cargo: settles on the far stack tops', () => {
  const spec = getContainer('20STD');
  // Floor fully covered by four 4x7x3 bases; C starts stacked on the first.
  const mk = (id, x) => ({ ...box(id, x), dims: { l: 4, w: 7, h: 3 } });
  const b = mk('b', 2), d = mk('d', 6), e = mk('e', 10), f = mk('f', 14);
  const c = { ...box('c', 2, 3), dims: { l: 4, w: 4, h: 2 } };
  c.rot = { rot: 0, tipped: false };
  const placements = [b, d, e, f, c];
  const control = interaction(placements);
  control.dragging = {
    moveSet: new Set(['c']), moved: false,
    anchor: { x: 2, z: 0 },
    members: [{ placement: c, offset: { x: 0, z: 0 }, lastValid: { x: c.x, y: c.y, z: c.z } }],
  };
  for (const x of [3, 5, 7, 9, 11, 13, 14]) control.moveSingle({ x, z: 0 });
  assert.equal(c.x, 14, 'C should glide across the container to the far half');
  assert.equal(c.y, 3, 'C should rest on the far stack top, not rubber-band home');
  assert.equal(cargo.collidesAny(c, [b, d, e, f]), false);
  assert.equal(cargo.layoutError(placements, spec), null);
});
test('dragging the base of a stack carries the cargo on top', () => {
  const spec = getContainer('20STD');
  const b = { ...box('b', 2), dims: { l: 4, w: 7, h: 3 } };
  const c = { ...box('c', 2, 3), dims: { l: 4, w: 4, h: 2 } }; // C sits on B
  const placements = [b, c];
  const control = interaction(placements);
  const carried = control.carriedDependents(placements, ['b']);
  assert.deepEqual([...carried].sort(), ['b', 'c'], 'the tower moves together');
  control.dragging = {
    moveSet: carried, moved: false, isGroup: true,
    anchor: { x: 2, z: 0 },
    members: [b, c].map((p) => ({
      placement: p, offset: { x: 0, z: 0 },
      lastValid: { x: p.x, y: p.y, z: p.z }, start: { x: p.x, y: p.y, z: p.z },
    })),
  };
  control.moveGroup({ x: 10, z: 0 });
  assert.equal(b.x, 10);
  assert.equal(b.y, 0);
  assert.equal(c.x, 10);
  assert.equal(c.y, 3, 'C keeps its height on top of B');
  assert.equal(cargo.layoutError(placements, spec), null);
});
test('carriedDependents stacks transitively but skips independent cargo', () => {
  const b = { ...box('b', 0), dims: { l: 4, w: 7, h: 2 } };
  const c = { ...box('c', 0, 2), dims: { l: 4, w: 4, h: 2 } }; // on B
  const e = { ...box('e', 0, 4), dims: { l: 2, w: 2, h: 1 } }; // on C
  const d = { ...box('d', 8), dims: { l: 4, w: 7, h: 3 } };    // independent
  const control = interaction([b, c, e, d]);
  assert.deepEqual([...control.carriedDependents([b, c, e, d], ['b'])].sort(), ['b', 'c', 'e']);
  assert.deepEqual([...control.carriedDependents([b, c, e, d], ['c'])].sort(), ['c', 'e']);
  assert.deepEqual([...control.carriedDependents([b, c, e, d], ['d'])], ['d']);
});
test('cargo shared with a stationary base blocks the carry and explains why', () => {
  const b = { ...box('b', 0), dims: { l: 4, w: 7, h: 3 } };
  const d = { ...box('d', 4), dims: { l: 4, w: 7, h: 3 } };
  const f = { ...box('f', 3, 3), dims: { l: 4, w: 4, h: 2 } }; // F straddles B and D
  const msgs = [];
  const control = interaction([b, d, f], (m, kind) => msgs.push([m, kind]));
  const carried = control.carriedDependents([b, d, f], ['b']);
  assert.deepEqual([...carried].sort(), ['b', 'f'], 'F needs B, so it is carried');
  control.dragging = {
    moveSet: carried, moved: false, isGroup: true,
    anchor: { x: 0, z: 0 },
    members: [b, f].map((p) => ({
      placement: p, offset: { x: 0, z: 0 },
      lastValid: { x: p.x, y: p.y, z: p.z }, start: { x: p.x, y: p.y, z: p.z },
    })),
  };
  control.moveGroup({ x: 10, z: 0 }); // F would leave its other base D behind
  control.onUp();
  assert.equal(b.x, 0, 'move is rejected: F would be stranded off D');
  assert.equal(f.x, 3);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][0], /"f" would be unsupported/);
  assert.match(msgs[0][0], /Shift-click/);
  assert.equal(msgs[0][1], 'warn');
});
test('a pre-existing floating item does not block unrelated drags', () => {
  const ghost = { ...box('ghost', 0, 3) }; // legacy float: already unsupported
  const a = { ...box('a', 6) };
  const msgs = [];
  const control = interaction([ghost, a], (m, kind) => msgs.push([m, kind]));
  control.dragging = {
    moveSet: new Set(['a']), moved: false,
    anchor: { x: 6, z: 0 },
    members: [{ placement: a, offset: { x: 0, z: 0 }, lastValid: { x: a.x, y: a.y, z: a.z } }],
  };
  for (const x of [7, 8, 9, 10]) control.moveSingle({ x, z: 0 }); // empty floor
  control.onUp();
  assert.equal(a.x, 10, 'unrelated item should drag freely past a pre-existing issue');
  assert.equal(msgs.length, 0, 'no warning for a successful drag');
});
test('rotate is no longer blocked by a pre-existing unrelated layout error', () => {
  const ghost = { ...box('ghost', 0, 3) }; // floating legacy item
  const a = { ...box('a', 6, 0, { l: 4, w: 2, h: 2 }) };
  const control = interaction([ghost, a]);
  control.transformPlacement(a, (d) => ({
    dims: { l: d.w, w: d.l, h: d.h }, rot: { rot: 90 },
  }), 'rotate');
  assert.deepEqual(a.dims, { l: 2, w: 4, h: 2 }, 'rotate should commit despite the unrelated ghost');
});
test('rotate that would strand supported cargo still reverts', () => {
  const b = { ...box('b', 2), dims: { l: 6, w: 4, h: 3 } };    // spans x 2..8
  const c = { ...box('c', 6, 3), dims: { l: 2, w: 4, h: 2 } }; // C on B's tail (x 6..8)
  const msgs = [];
  const control = interaction([b, c], (m, kind) => msgs.push([m, kind]));
  control.transformPlacement(b, (d) => ({
    dims: { l: d.w, w: d.l, h: d.h }, rot: { rot: 90 },
  }), 'rotate'); // rotated B spans x 2..6: C loses its base
  assert.deepEqual(b.dims, { l: 6, w: 4, h: 3 }, 'rotate must revert: C would lose support');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][0], /"c" would be unsupported/);
  assert.equal(msgs[0][1], 'warn');
});
test('fitAtSpot reports why no orientation fits via diag', () => {
  const spec = getContainer('20STD');
  let reason = null;
  const diag = (r) => { reason = r; };
  // Too tall and do-not-tip: every orientation is rejected.
  assert.equal(cargo.fitAtSpot(0, 0, [], spec, { l: 2, w: 2, h: 9 }, { noTip: true, diag }), null);
  assert.match(reason, /too tall/);
  // A validate() rule error is the most specific explanation and wins.
  reason = null;
  assert.equal(cargo.fitAtSpot(0, 0, [], spec, { l: 2, w: 2, h: 2 },
    { validate: () => 'custom rule broken', diag }), null);
  assert.equal(reason, 'custom rule broken');
});