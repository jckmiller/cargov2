// Reporting: the load plan's Loading Sequence must be depth-first from the
// doors — furthest-from-door items (and whatever stacks on them) load before
// anything closer to the doors, replacing the old layer-by-layer order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLoadPlan, loadPlanHTML, manifestHTML } from '../public/js/reporting.js';
import { getContainer } from '../public/js/container.js';

const spec = getContainer('20STD');

const item = (id, name, { x, y, z, l = 2, w = 2, h = 2 }) => ({
  id, name, catalogItemId: id, category: 'general', hazmatClass: 'none',
  weight: 10, dims: { l, w, h }, x, y, z,
});

test('load plan loads furthest from the doors first, stacking as it goes', () => {
  // Floor items at three depths: near doors (x=18), middle (x=10), nose (x=0).
  // A box stacked on the nose item must be step 2, before the middle item.
  const placements = [
    item('near', 'Near Doors', { x: 18, y: 0, z: 0 }),
    item('mid', 'Middle', { x: 10, y: 0, z: 0 }),
    item('nose', 'Nose Floor', { x: 0, y: 0, z: 0 }),
    item('top', 'Nose Top', { x: 0, y: 2, z: 0 }), // rests on nose
  ];
  const steps = generateLoadPlan({ containerType: '20STD', placements });
  assert.deepEqual(
    steps.map((s) => s.name),
    ['Nose Floor', 'Nose Top', 'Middle', 'Near Doors']
  );
  assert.equal(steps[1].stacked, true);
  assert.equal(steps[1].stackedOn, 'Nose Floor');
  assert.equal(steps[3].step, 4);
});

test('ties at the same depth and height break left-to-right', () => {
  const placements = [
    item('r', 'Right', { x: 0, y: 0, z: 4 }),
    item('l', 'Left', { x: 0, y: 0, z: 0 }),
  ];
  const steps = generateLoadPlan({ containerType: '20STD', placements });
  assert.deepEqual(steps.map((s) => s.name), ['Left', 'Right']);
});

// Intro labels the Load Plan's frontmatter must carry, mirroring the Manifest.
const MANIFEST_META_LABELS = [
  'Project', 'Container Loading', 'Prepared By', 'Container',
  'Internal Dimensions', 'Cubic Feet Total', 'Tare', 'Payload Limit',
  'Max Gross', 'Payload', 'Gross',
];
const MANIFEST_CARD_LABELS = ['Items', 'Volume Used', 'Hazmat Items'];

const metaLabels = (html) => [...html.matchAll(/rp-meta-label">([^<]+)</g)].map((m) => m[1]);
const cardLabels = (html) => [...html.matchAll(/rp-card-label">([^<]+)</g)].map((m) => m[1]);

test('load plan intro mirrors the manifest meta grid and stat cards', () => {
  const scenario = {
    name: 'Scenario A',
    containerType: '20STD',
    placements: [item('nose', 'Nose Floor', { x: 0, y: 0, z: 0 })],
  };
  const project = { name: 'Project A' };
  const user = { username: 'jm' };

  const manifest = manifestHTML(project, scenario, user, null);
  const loadPlan = loadPlanHTML(scenario, project, user, null);

  // The Load Plan keeps the load-relevant opening in addition to everything
  // the Manifest shows; every Manifest meta label must appear.
  const planLabels = metaLabels(loadPlan);
  for (const label of MANIFEST_META_LABELS) {
    assert.ok(planLabels.includes(label), `missing meta label: ${label}`);
  }
  assert.ok(planLabels.includes('Clear Door Opening'));

  // Stat cards are identical between the two reports.
  assert.deepEqual(cardLabels(loadPlan), MANIFEST_CARD_LABELS);
  assert.deepEqual(cardLabels(manifest), MANIFEST_CARD_LABELS);

  // Masthead matches the Manifest style: company wordmark hidden.
  assert.ok(!loadPlan.includes('rp-company'));
  assert.ok(loadPlan.includes('Load Plan'));
});
