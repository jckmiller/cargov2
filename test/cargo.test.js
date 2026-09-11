import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCatalogItem, findFreePlacementAnyOrientation, hazmatIncompatible } from '../public/js/cargo.js';
import { parseCatalogCsv } from '../public/js/catalogCsv.js';
import { getContainer } from '../public/js/container.js';
import { pack } from '../public/js/autoload.js';

test('zero is preserved and negative dimensions are rejected', () => {
  assert.equal(makeCatalogItem({ weight: 0, qtyAvailable: 0 }).weight, 0);
  assert.throws(() => makeCatalogItem({ length: -4 }));
});
test('CSV rejects missing dimensions, preserves zero quantity and weight', () => {
  const bad = parseCatalogCsv('name,length,width,height,weight,qty\nCrate,48,,,0,0');
  assert.equal(bad.items.length, 0);
  assert.equal(bad.errors.length, 1);
  const good = parseCatalogCsv('name,length,width,height,weight,qty\nCrate,48,48,48,0,0');
  assert.equal(good.items[0].weight, 0);
  assert.equal(good.items[0].qtyAvailable, 0);
});
test('manual placement considers all six physical orientations', () => {
  const item = makeCatalogItem({ length: 8, width: 9, height: 2, weight: 100 });
  const spot = findFreePlacementAnyOrientation([], getContainer('40HC'), { l: 8, w: 9, h: 2 }, { item });
  assert.ok(spot);
  assert.ok(spot.dims.w <= getContainer('40HC').width);
});
test('incompatible cargo cannot share a container across different layers', () => {
  const items = [
    { name: 'Base', weight: 1000 },
    { name: 'Flammable', weight: 900, hazmatClass: '3' },
    { name: 'Oxidizer', weight: 800, hazmatClass: '5.1' },
  ].map((item) => makeCatalogItem({ length: 2, width: 2, height: 2, ...item }));
  const result = pack(items, '20STD', { strategy: 'fewest', simulations: 1 });
  assert.equal(result.placements.some((p, i) => result.placements.slice(i + 1)
    .some((q) => hazmatIncompatible(p.hazmatClass, q.hazmatClass))), false);
});