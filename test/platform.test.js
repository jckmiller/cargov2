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
