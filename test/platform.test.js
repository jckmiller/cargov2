import test from 'node:test';
import assert from 'node:assert/strict';
import * as cargo from '../public/js/cargo.js';
import { getContainer } from '../public/js/container.js';
import { validateProjectData } from '../public/js/projectValidation.js';

const spec = getContainer('20STD');

const box = (id, x = 0, y = 0, dims = { l: 2, w: 2, h: 2 }) => ({
  id, catalogItemId: 'cat', name: id, x, y, z: 0, dims, weight: 10, category: 'general', hazmatClass: 'none',
});

// A platform structure: legs at the floor, deck surface at deckY.
const platform = (id, { l = 4, w = 4, h = 4, deckY = 4, x = 0, z = 0, weight = 0 } = {}) => ({
  id, kind: 'platform', name: id, category: 'general', hazmatClass: 'none',
  x, y: deckY - h, z, dims: { l, w, h }, weight, color: cargo.PLATFORM_COLOR,
});

test('platforms pass through cargo in both directions (no collisions)', () => {
  // Platform erected directly over a floor crate — no overlap error.
  assert.equal(cargo.layoutError([box('crate', 0, 0, { l: 4, w: 4, h: 4 }), platform('deck')], spec), null);
  // A crate placed inside the platform's leg volume is also legal.
  assert.equal(cargo.layoutError([platform('deck'), box('under', 1, 0, { l: 2, w: 2, h: 2 })], spec), null);
  // collidesAny is blind to platforms both ways.
  assert.equal(cargo.collidesAny(box('a', 0, 0), [platform('deck')]), false);
  assert.equal(cargo.collidesAny(platform('deck'), [box('a', 0, 0)]), false);
  // Two platforms overlapping each other are also non-colliding.
  assert.equal(cargo.collidesAny(platform('p1'), [platform('p2')]), false);
});

test('platform tops are legal, packable support surfaces', () => {
  // Item resting exactly on the deck (deck top = 4 ft) validates.
  assert.equal(cargo.layoutError([platform('deck'), box('onDeck', 0, 4)], spec), null);
  // Two items side by side on the deck (3x4 + 1x4 over a 4x4 deck).
  assert.equal(cargo.layoutError([
    platform('deck'),
    box('left', 0, 4, { l: 3, w: 4, h: 2 }),
    box('right', 3, 4, { l: 1, w: 4, h: 2 }),
  ], spec), null);
  // An item overhanging past the deck edge is unsupported (strict default).
  assert.match(cargo.layoutError([platform('deck'), box('hang', 3, 4)], spec), /unsupported/);
  // Floating next to the deck (no support at all) still fails.
  assert.match(cargo.layoutError([platform('deck'), box('float', 6, 4)], spec), /unsupported/);
  // restingY drops an item onto the deck top, not the floor beneath it.
  const y = cargo.restingY(0, 0, { l: 2, w: 2, h: 2 }, [platform('deck')], spec, { category: 'general' });
  assert.equal(y, 4);
});

test('platforms are still bounded by the container walls', () => {
  assert.match(cargo.layoutError([platform('tall', { h: 9, deckY: 9 })], spec), /outside/);
  assert.match(cargo.layoutError([platform('wide', { l: 40 })], spec), /outside/);
});

test('platform projects validate without a catalog reference', () => {
  const project = {
    catalog: [],
    scenarios: [{
      id: 's1', name: 'C1', containerType: '20STD',
      placements: [platform('p1', { deckY: 4 })],
    }],
  };
  assert.deepEqual(validateProjectData(project), project);
  // Unknown kinds are rejected.
  assert.throws(() => validateProjectData({
    catalog: [], scenarios: [{ id: 's1', name: 'C1', containerType: '20STD',
      placements: [{ ...box('x'), kind: 'mystery' }] }],
  }), /Unknown placement kind/);
  // Platform with broken dims is rejected.
  assert.throws(() => validateProjectData({
    catalog: [], scenarios: [{ id: 's1', name: 'C1', containerType: '20STD',
      placements: [platform('p1', { l: 0 })] }],
  }), /Invalid platform/);
});

test('resizePlatform adjusts one face, clamped to walls and a 1" minimum', () => {
  const p = platform('deck', { l: 4, w: 4, h: 4, deckY: 4 }); // anchored at origin
  // Grow the length face to x=6: min corner stays, l becomes 6.
  assert.deepEqual(cargo.resizePlatform(p, 'x', 6, spec),
    { dims: { l: 6, w: 4, h: 4 }, x: 0, y: 0, z: 0 });
  // Dragged past the back wall: clamped to the interior length.
  assert.equal(cargo.resizePlatform(p, 'x', 99, spec).dims.l, spec.length);
  // Dragged below the 1" minimum: clamped up to 1".
  assert.equal(cargo.resizePlatform(p, 'z', 0.01, spec).dims.w, cargo.GRID_SIZE_FT);
  // Height clamped to the roof.
  assert.equal(cargo.resizePlatform(p, 'y', 99, spec).dims.h, spec.height);
  // Snap rounds the dragged face to the 1" grid first.
  assert.equal(cargo.resizePlatform(p, 'x', 5.04, spec, true).dims.l, 5);
  // Non-platforms and unknown axes are rejected.
  assert.equal(cargo.resizePlatform(box('b'), 'x', 6, spec), null);
  assert.equal(cargo.resizePlatform(p, 'q', 6, spec), null);
  // The source placement is never mutated (the result is a copy).
  assert.deepEqual(p.dims, { l: 4, w: 4, h: 4 });
});

test('resizePlatform anchors the min corner for off-origin platforms', () => {
  // y = deckY - h = 2, min corner (2, 2, 1).
  const off = platform('off', { l: 2, w: 2, h: 3, deckY: 5, x: 2, z: 1 });
  // Length face dragged to x=7 -> l = 5; x/y/z untouched.
  assert.deepEqual(cargo.resizePlatform(off, 'x', 7, spec),
    { dims: { l: 5, w: 2, h: 3 }, x: 2, y: 2, z: 1 });
  // Height face dragged to y=7 (base anchored at y=2) -> h = 5.
  assert.equal(cargo.resizePlatform(off, 'y', 7, spec).dims.h, 5);
  // ...and clamps at the roof when dragged past it.
  assert.equal(cargo.resizePlatform(off, 'y', 99, spec).dims.h, spec.height - 2);
  // Width wall clamp accounts for the anchored z.
  assert.equal(cargo.resizePlatform(off, 'z', 99, spec).dims.w, spec.width - 1);
  // Dragging a face BACKWARD past the min corner still floors at 1".
  assert.equal(cargo.resizePlatform(off, 'x', 0, spec).dims.l, cargo.GRID_SIZE_FT);
});
