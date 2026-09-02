// Item library: built-in industrial presets (grouped) plus user-saved custom presets.
import { makeCatalogItem } from './cargo.js';

const CUSTOM_KEY = 'a3_custom_presets';

// Built-in presets grouped for organization. Dimensions in feet.
export const BUILTIN_GROUPS = [
  {
    group: 'Industrial Crates',
    items: [
      { name: 'SurePak', category: 'general', length: 4, width: 3.3333, height: 3.75, weight: 850 },
      { name: 'Trailer Crate', category: 'heavy', length: 11.0833, width: 6.5833, height: 4.3333, weight: 2600 },
    ],
  },
  {
    group: 'Specialty',
    items: [
      { name: 'Blade Container', category: 'fragile', length: 25.25, width: 3.1667, height: 1.5, weight: 1800,
        stackUnder: [] },
      { name: 'Sheet Metal Crate', category: 'heavy', length: 12.6667, width: 4.4167, height: 0.6667, weight: 3200 },
    ],
  },
];

export function loadCustomPresets() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomPreset(item) {
  const list = loadCustomPresets();
  list.push({
    name: item.name,
    category: item.category,
    hazmatClass: item.hazmatClass,
    length: item.length,
    width: item.width,
    height: item.height,
    weight: item.weight,
    stackOn: item.stackOn,
    stackUnder: item.stackUnder,
    color: item.color,
  });
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

export function deleteCustomPreset(index) {
  const list = loadCustomPresets();
  list.splice(index, 1);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

/** Build a catalog item from a preset definition. */
export function presetToCatalogItem(preset) {
  return makeCatalogItem({ ...preset, qtyAvailable: 1 });
}
