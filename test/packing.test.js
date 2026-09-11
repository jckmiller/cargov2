import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { makeCatalogItem, layoutError } from '../public/js/cargo.js';
import { getContainer } from '../public/js/container.js';
import { packAll } from '../public/js/autoload.js';
import { startPacking } from '../public/js/packingJob.js';

test('all packing strategies preserve inventory and valid geometry', () => {
  const catalog = [
    makeCatalogItem({ length: 4, width: 3, height: 2, weight: 300, qtyAvailable: 6 }),
    makeCatalogItem({ length: 2, width: 2, height: 3, weight: 0, qtyAvailable: 3, noTip: true }),
  ];
  for (const strategy of ['balanced', 'volume', 'fewest']) {
    const result = packAll(catalog, { strategy, simulations: 1 });
    const placements = result.containers.flatMap((c) => c.placements);
    assert.equal(placements.length + result.unplaced.length, 9);
    for (const c of result.containers) {
      assert.equal(layoutError(c.placements, getContainer(c.containerType),
        (id) => catalog.find((item) => item.id === id)), null);
    }
    for (const item of catalog) {
      assert.equal(placements.filter((p) => p.catalogItemId === item.id).length +
        result.unplaced.filter((p) => p.item.id === item.id).length, item.qtyAvailable);
    }
  }
});
test('packing rejects unbounded quantities and reports truncated work', () => {
  assert.throws(() => packAll([{ ...makeCatalogItem(), qtyAvailable: Infinity }]), /at most/);
  const result = packAll([makeCatalogItem()], { totalTimeBudgetMs: -1 });
  assert.equal(result.summary.truncated, true);
  assert.equal(result.unplaced.length, 1);
});
test('actual worker module returns results and errors', async () => {
  const url = new URL('../public/js/autoload.worker.js', import.meta.url).href;
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (data) => parentPort.postMessage(data) };
    import(${JSON.stringify(url)}).then(() => {
      parentPort.on('message', (data) => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    });`, { eval: true });
  const message = () => new Promise((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject);
  });
  try {
    await message();
    let response = message();
    worker.postMessage({ catalog: [makeCatalogItem()], options: { simulations: 1 } });
    assert.equal((await response).result.summary.placedUnits, 1);
    response = message();
    worker.postMessage({ catalog: [{ ...makeCatalogItem(), qtyAvailable: Infinity }], options: {} });
    assert.match((await response).error, /at most/);
  } finally { await worker.terminate(); }
});
test('worker job cancellation and timeout terminate the worker', async () => {
  const Original = globalThis.Worker;
  let instance;
  globalThis.Worker = class {
    constructor() { instance = this; this.terminated = false; }
    postMessage() {}
    terminate() { this.terminated = true; }
  };
  try {
    const job = startPacking([], {});
    job.cancel();
    await assert.rejects(job.promise, /cancelled/);
    assert.equal(instance.terminated, true);
    const timed = startPacking([], {}, 1);
    await assert.rejects(timed.promise, /timed out/);
    assert.equal(instance.terminated, true);
  } finally { globalThis.Worker = Original; }
});