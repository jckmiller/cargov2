import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as cargo from '../public/js/cargo.js';
import { getContainer } from '../public/js/container.js';
import { validateProjectData, collectLayoutWarnings } from '../public/js/projectValidation.js';
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
test('overhang allowance permits slight overhang and reports the ratio', () => {
  const spec = getContainer('20STD');
  // Top (2×2) shifted 0.1 ft off the 2×2 base: uncovered area 0.1×2 = 0.2 of
  // 4 sq ft = exactly 5% overhang.
  const base = box('base', 0, 0);
  const top = box('top', 0.1, 2);
  // Strict (default) still rejects any overhang.
  assert.match(cargo.layoutError([base, top], spec), /unsupported/);
  // Within the 5% allowance it validates; 4% is not enough.
  assert.equal(cargo.layoutError([base, top], spec, () => null, 5), null);
  assert.match(cargo.layoutError([base, top], spec, () => null, 4), /unsupported/);
  // overhangFractions reports the 5% overhang (for the red highlight).
  const ratios = cargo.overhangFractions([base, top]);
  assert.ok(Math.abs(ratios.get('top') - 0.05) < 1e-9);
  assert.equal(ratios.has('base'), false);
  // removalError honors the allowance too.
  assert.equal(cargo.removalError([base, top, box('far', 6)], 'far', spec, () => null, 5), null);
  assert.match(cargo.removalError([base, top], 'base', spec, () => null, 5), /unsupported/);
  // restingY accepts the same slight overhang only under the allowance.
  const dims = { l: 2, w: 2, h: 2 };
  assert.equal(cargo.restingY(0.1, 0, dims, [base], spec, top, null, undefined, 5), 2);
  assert.equal(cargo.restingY(0.1, 0, dims, [base], spec, top), null);
  // Scenarios default to the 5% allowance.
  assert.equal(makeScenario().maxOverhangPct, cargo.DEFAULT_MAX_OVERHANG_PCT);
  // Project validation accepts an overhang within the scenario's allowance.
  const p = newProject();
  p.catalog = [cargo.makeCatalogItem({ id: 'cat', qtyAvailable: 2 })];
  p.scenarios[0].placements = [box('base', 0, 0), box('top', 0.1, 2)];
  assert.equal(validateProjectData(p), p);
  p.scenarios[0].maxOverhangPct = 0;
  // Layout-rule violations no longer reject the project — they are warnings.
  assert.equal(validateProjectData(p), p);
  assert.deepEqual(collectLayoutWarnings(p), [`${p.scenarios[0].name}: "top" would be unsupported`]);
});
test('catalog item names are unique identifiers within a project', () => {
  const mk = (id, name) => cargo.makeCatalogItem({ id, name, qtyAvailable: 1 });
  const p = newProject();
  // Unique names (identifiers) validate fine.
  p.catalog = [mk('cat1', 'GBX0001'), mk('cat2', 'GBX0002')];
  assert.equal(validateProjectData(p), p);
  // Exact duplicate name is rejected — only one GBX0001 per project.
  p.catalog = [mk('cat1', 'GBX0001'), mk('cat2', 'GBX0001')];
  assert.throws(() => validateProjectData(p), /unique identifiers/);
  // Whitespace is trimmed before comparison.
  p.catalog = [mk('cat1', 'GBX0001'), mk('cat2', ' GBX0001 ')];
  assert.throws(() => validateProjectData(p), /unique identifiers/);
  // Matching is case-sensitive: gbx0001 is a distinct identifier.
  p.catalog = [mk('cat1', 'GBX0001'), mk('cat2', 'gbx0001')];
  assert.equal(validateProjectData(p), p);
  // The placement/staging copies of a catalog name are NOT affected — several
  // placed units of the same item legitimately share the item's name.
  const q = newProject();
  q.catalog = [cargo.makeCatalogItem({ id: 'cat', name: 'GBX0001', qtyAvailable: 2 })];
  q.scenarios[0].placements = [box('base', 0, 0), box('top', 0, 2)];
  assert.equal(validateProjectData(q), q);
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
test('nudge may create floating cargo (warned, allowed); oversized rotation still reverts', () => {
  const p = box('wide', 0, 0, { l: 10, w: 2, h: 2 });
  const msgs = [];
  const control = interaction([p], (m, kind) => msgs.push([m, kind]));
  control.nudgeSelected({ dy: 1 });
  assert.equal(p.y, 1, 'illegal floating nudge is committed');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][0], /unsupported/);
  assert.equal(msgs[0][1], 'warn');
  control.transformPlacement(p, (d) => ({ dims: { l: d.w, w: d.l, h: d.h }, rot: { rot: 90 } }), 'rotate');
  assert.equal(p.dims.w, 2, 'rotation that leaves the container still reverts');
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
test('support-magnet aligns stacked drags to off-grid base footprints', () => {
  const spec = getContainer('40HC'); // interior width ≈ 7.7083 ft
  const dims = { l: 4, w: 10 / 3, h: 3.75 }; // 48″ × 40″ × 45″ pallet
  // Auto-packed base flush against the right wall at z = 4.375 ft (52.5 in —
  // exactly half a cell off the 1″ grid), as in the "Greece Cont01" demo.
  const base = { ...box('GSP0071', 33.25, 0, dims), z: 4.375 };
  const opts = { stack: true, item: { category: 'general', hazmatClass: 'none' }, maxOverhangPct: 5 };
  // User releases ~4.5″ misaligned (z=4). Without the magnet the 1″ grid snap
  // keeps the item misaligned → 11.25% overhang → no legal rest in any
  // orientation (the exact "GSP0073 would be unsupported" diagnostic).
  assert.equal(cargo.fitAtSpot(33.6, 4, [base], spec, dims, { ...opts, magnet: false, snapGrid: true }), null);
  // With the magnet (default on) the footprint snaps flush onto the base:
  // zero overhang, resting on top at y = 3.75.
  const fit = cargo.fitAtSpot(33.6, 4, [base], spec, dims, { ...opts, snapGrid: true });
  assert.ok(fit, 'expected the magnet to align the item onto the base');
  assert.equal(fit.x, 33.25);
  assert.equal(fit.z, 4.375);
  assert.equal(fit.y, 3.75);
  assert.deepEqual(fit.dims, dims);
});
test('support-magnet stays out of the way of far drops', () => {
  const spec = getContainer('40HC');
  const dims = { l: 4, w: 10 / 3, h: 3.75 };
  const base = { ...box('base', 33.25, 0, dims), z: 4.375 };
  // A floor drop far from every edge/footprint keeps the raw target — the
  // magnet only engages within MAGNET_TOL_FT (0.5 ft).
  const fit = cargo.fitAtSpot(10, 3.4, [base], spec, dims);
  assert.ok(fit);
  assert.equal(fit.x, 10);
  assert.equal(fit.z, 3.4);
  assert.equal(fit.y, 0);
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
test('single-item drag onto a fragile base commits with a warning', () => {
  const b = { ...box('b'), category: 'fragile' }; // fragile: cannot legally support cargo
  const a = { ...box('a', 6, 0, { l: 2, w: 2, h: 2 }) };
  a.rot = { rot: 0, tipped: false };
  const msgs = [];
  const control = interaction([b, a], (m, kind) => msgs.push([m, kind]));
  control.dragging = {
    moveSet: new Set(['a']), moved: false,
    anchor: { x: 6, z: 0 },
    members: [{ placement: a, offset: { x: 0, z: 0 }, lastValid: { x: a.x, y: a.y, z: a.z } }],
  };
  control.moveSingle({ x: 0, z: 0 }); // onto a fragile base: no legal rest
  assert.deepEqual({ x: a.x, y: a.y, z: a.z }, { x: 0, y: 2, z: 0 }, 'illegal rest is allowed');
  control.onUp();
  assert.equal(msgs.length, 1, 'the rule violation is warned on release');
  assert.match(msgs[0][0], /unsupported/);
  assert.equal(msgs[0][1], 'warn');
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
test('carried stack crosses an occupied far half by settling onto its cargo', () => {
  const spec = getContainer('20STD');
  const b = { ...box('b', 1), dims: { l: 4, w: 7, h: 3 } };
  const c = { ...box('c', 1, 3), dims: { l: 4, w: 4, h: 2 } }; // on B
  const m = { ...box('m', 8), dims: { l: 4, w: 7, h: 3 } };    // middle cargo
  const f = { ...box('f', 13), dims: { l: 4, w: 7, h: 2 } };   // far-half floor cargo
  const placements = [b, c, m, f];
  const control = interaction(placements);
  const carried = control.carriedDependents(placements, ['b']);
  control.dragging = {
    moveSet: carried, moved: false, isGroup: true,
    anchor: { x: 1, z: 0 },
    members: [b, c].map((p) => ({
      placement: p, offset: { x: 0, z: 0 },
      lastValid: { x: p.x, y: p.y, z: p.z }, start: { x: p.x, y: p.y, z: p.z },
    })),
  };
  for (const hx of [3, 5, 7, 9, 11, 13]) control.moveGroup({ x: hx, z: 0 });
  assert.equal(b.x, 13, 'the tower should cross to the far half, not wall up mid-way');
  assert.equal(b.y, 2, 'the base settles on the far cargo top');
  assert.equal(c.x, 13);
  assert.equal(c.y, 5, 'the top item rides along, keeping its relative height');
  assert.equal(cargo.layoutError(placements, spec), null);
});
test('group drag settles DOWN off a stack onto free floor', () => {
  const spec = getContainer('20STD');
  const m = { ...box('m', 0), dims: { l: 4, w: 7, h: 3 } };    // stack base (not moved)
  const a = { ...box('a', 0, 3), dims: { l: 4, w: 4, h: 2 } }; // on M, dragged alone
  const placements = [m, a];
  const control = interaction(placements);
  control.dragging = {
    moveSet: new Set(['a']), moved: false, isGroup: true,
    anchor: { x: 0, z: 0 },
    members: [{ placement: a, offset: { x: 0, z: 0 },
      lastValid: { x: a.x, y: a.y, z: a.z }, start: { x: a.x, y: a.y, z: a.z } }],
  };
  control.moveGroup({ x: 8, z: 0 }); // free floor
  assert.equal(a.x, 8);
  assert.equal(a.y, 0, 'settles down to the floor instead of hovering at stack height');
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
test('cargo shared with a stationary base is carried with a warning, not blocked', () => {
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
  assert.equal(b.x, 10, 'lenient move commits: F is stranded but allowed');
  assert.equal(f.x, 13);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][0], /"f" would be unsupported/);
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
test('rotate that would strand supported cargo commits with a warning', () => {
  const b = { ...box('b', 2), dims: { l: 6, w: 4, h: 3 } };    // spans x 2..8
  const c = { ...box('c', 6, 3), dims: { l: 2, w: 4, h: 2 } }; // C on B's tail (x 6..8)
  const msgs = [];
  const control = interaction([b, c], (m, kind) => msgs.push([m, kind]));
  control.transformPlacement(b, (d) => ({
    dims: { l: d.w, w: d.l, h: d.h }, rot: { rot: 90 },
  }), 'rotate'); // rotated B spans x 2..6: C loses its base — allowed with a warning
  assert.deepEqual(b.dims, { l: 4, w: 6, h: 3 }, 'rotate commits: C is stranded but allowed');
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