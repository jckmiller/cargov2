// Shared API/import/save validation. No DOM or server dependencies.
import { CATEGORIES, HAZMAT_CLASSES, MAX_CATALOG_UNITS, layoutError } from './cargo.js';
import { CONTAINER_TYPES, getContainer } from './container.js';

function requireValue(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { status: 400 });
}

export function validateProjectData(data) {
  requireValue(data && typeof data === 'object' && Array.isArray(data.catalog) && Array.isArray(data.scenarios),
    'Project must contain catalog and scenarios arrays');
  requireValue(data.catalog.length <= MAX_CATALOG_UNITS && data.scenarios.length <= 100, 'Project exceeds item/container limits');
  const catalog = new Map();
  let units = 0;
  for (const item of data.catalog) {
    requireValue(item && typeof item.id === 'string' && item.id && !catalog.has(item.id), 'Catalog IDs must be unique strings');
    requireValue(typeof item.name === 'string' && item.name.trim() && item.name.length <= 200, 'Item name must be 1–200 characters');
    requireValue([item.length, item.width, item.height].every((n) => Number.isFinite(n) && n > 0), 'All item dimensions must be positive numbers');
    requireValue(Number.isFinite(item.weight) && item.weight >= 0, 'Item weight must be nonnegative');
    requireValue(Number.isSafeInteger(item.qtyAvailable) && item.qtyAvailable >= 0, 'Item quantity must be a nonnegative integer');
    requireValue(Object.hasOwn(CATEGORIES, item.category) && Object.hasOwn(HAZMAT_CLASSES, item.hazmatClass), 'Unknown cargo category or hazmat class');
    requireValue(item.noTip === undefined || typeof item.noTip === 'boolean', 'noTip must be boolean');
    units += item.qtyAvailable;
    catalog.set(item.id, item);
  }
  requireValue(units <= MAX_CATALOG_UNITS, `Project supports at most ${MAX_CATALOG_UNITS} available units`);
  const scenarioIds = new Set();
  const placementIds = new Set();
  const counts = new Map();
  for (const scenario of data.scenarios) {
    requireValue(scenario && typeof scenario.id === 'string' && scenario.id && !scenarioIds.has(scenario.id), 'Container IDs must be unique strings');
    scenarioIds.add(scenario.id);
    requireValue(typeof scenario.name === 'string' && scenario.name.trim(), 'Container name required');
    requireValue(Object.hasOwn(CONTAINER_TYPES, scenario.containerType), 'Unknown container type');
    requireValue(Array.isArray(scenario.placements) && scenario.placements.length <= MAX_CATALOG_UNITS, 'Invalid placements');
    for (const p of scenario.placements) {
      requireValue(p && typeof p.id === 'string' && !placementIds.has(p.id), 'Placement IDs must be unique strings');
      placementIds.add(p.id);
      requireValue(catalog.has(p.catalogItemId), 'Placement references a missing catalog item');
      requireValue(typeof p.name === 'string' && Object.hasOwn(CATEGORIES, p.category) &&
        Object.hasOwn(HAZMAT_CLASSES, p.hazmatClass), 'Invalid placement name/category/hazmat');
      counts.set(p.catalogItemId, (counts.get(p.catalogItemId) || 0) + 1);
      requireValue(counts.get(p.catalogItemId) <= catalog.get(p.catalogItemId).qtyAvailable, 'Placed quantity exceeds available inventory');
    }
    const error = layoutError(scenario.placements, getContainer(scenario.containerType), (id) => catalog.get(id));
    requireValue(!error, error);
  }
  requireValue(data.staging === undefined || (Array.isArray(data.staging) && data.staging.length <= MAX_CATALOG_UNITS), 'Invalid staging array');
  for (const p of data.staging || []) {
    requireValue(p && catalog.has(p.catalogItemId) && typeof p.name === 'string' && p.dims &&
      [p.dims.l, p.dims.w, p.dims.h].every((n) => Number.isFinite(n) && n > 0) &&
      Number.isFinite(p.weight) && p.weight >= 0 && Object.hasOwn(CATEGORIES, p.category) &&
      Object.hasOwn(HAZMAT_CLASSES, p.hazmatClass), 'Invalid staged item or missing catalog reference');
  }
  return data;
}