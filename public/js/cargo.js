// Cargo domain: categories, hazmat classes, colors, stacking rules, and helpers.

export const CATEGORIES = {
  general: { id: 'general', label: 'General', color: '#4f8cff' },
  fragile: { id: 'fragile', label: 'Fragile', color: '#ffc15c' },
  heavy: { id: 'heavy', label: 'Heavy', color: '#8a97b1' },
  hazardous: { id: 'hazardous', label: 'Hazardous', color: '#ff5c6c' },
  perishable: { id: 'perishable', label: 'Perishable', color: '#38d39f' },
};

// UN/DOT hazmat classes with standard placard colors.
export const HAZMAT_CLASSES = {
  none: { id: 'none', label: 'None', color: null },
  '1': { id: '1', label: 'Class 1 — Explosives', color: '#f4a100' },
  '2.1': { id: '2.1', label: 'Class 2.1 — Flammable Gas', color: '#e2231a' },
  '2.2': { id: '2.2', label: 'Class 2.2 — Non-Flammable Gas', color: '#2e8b57' },
  '2.3': { id: '2.3', label: 'Class 2.3 — Toxic Gas', color: '#ffffff' },
  '3': { id: '3', label: 'Class 3 — Flammable Liquid', color: '#e2231a' },
  '4.1': { id: '4.1', label: 'Class 4.1 — Flammable Solid', color: '#e2231a' },
  '4.2': { id: '4.2', label: 'Class 4.2 — Spontaneously Combustible', color: '#c0392b' },
  '4.3': { id: '4.3', label: 'Class 4.3 — Dangerous When Wet', color: '#1f6fd0' },
  '5.1': { id: '5.1', label: 'Class 5.1 — Oxidizer', color: '#f4c400' },
  '5.2': { id: '5.2', label: 'Class 5.2 — Organic Peroxide', color: '#f4c400' },
  '6.1': { id: '6.1', label: 'Class 6.1 — Toxic', color: '#ffffff' },
  '7': { id: '7', label: 'Class 7 — Radioactive', color: '#f4c400' },
  '8': { id: '8', label: 'Class 8 — Corrosive', color: '#5a5a5a' },
  '9': { id: '9', label: 'Class 9 — Miscellaneous', color: '#3a3a3a' },
};

// Hazmat classes that must not be stored together (simplified segregation).
const HAZMAT_INCOMPATIBLE = [
  ['3', '5.1'],
  ['3', '5.2'],
  ['4.1', '5.1'],
  ['2.1', '5.1'],
  ['8', '2.3'],
];

export function hazmatIncompatible(a, b) {
  if (!a || !b || a === 'none' || b === 'none') return false;
  return HAZMAT_INCOMPATIBLE.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x)
  );
}

export function categoryColor(cat) {
  return (CATEGORIES[cat] || CATEGORIES.general).color;
}

export function itemColor(item) {
  if (item.hazmatClass && item.hazmatClass !== 'none') {
    const h = HAZMAT_CLASSES[item.hazmatClass];
    if (h && h.color) return h.color;
  }
  return item.color || categoryColor(item.category);
}

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * Create a normalized catalog item. Dimensions in feet.
 */
export function makeCatalogItem(partial = {}) {
  return {
    id: partial.id || uid('cat'),
    name: partial.name || 'New Item',
    category: partial.category || 'general',
    hazmatClass: partial.hazmatClass || 'none',
    length: Number(partial.length) || 4,
    width: Number(partial.width) || 3.5,
    height: Number(partial.height) || 4,
    weight: Number(partial.weight) || 500,
    qtyAvailable: partial.qtyAvailable != null ? Number(partial.qtyAvailable) : 1,
    stackOn: partial.stackOn || ['general', 'heavy'],
    stackUnder: partial.stackUnder || ['general', 'fragile', 'perishable'],
    color: partial.color || null,
  };
}

/**
 * Can `top` item be stacked on top of `base` item?
 * Rules:
 *  - base must allow top's category in base.stackUnder
 *  - top must allow base's category in top.stackOn
 *  - never stack anything on a fragile base
 */
export function canStack(top, base) {
  if (!base) return true; // floor
  if (base.category === 'fragile') return false;
  const baseAllows = !base.stackUnder || base.stackUnder.includes(top.category);
  const topAllows = !top.stackOn || top.stackOn.includes(base.category);
  return baseAllows && topAllows;
}

export function itemVolumeFt3(item) {
  return item.length * item.width * item.height;
}

// ---------------------------------------------------------------------------
// Collision helpers (shared by the interactive viewer and the auto-load packer)
//
// A "box" is any object exposing a min-corner {x, y, z} and dims {l, w, h}:
//   x -> along container LENGTH  (l)
//   z -> along container WIDTH   (w)
//   y -> vertical HEIGHT         (h)
// The EPS margin means touching faces (shared boundaries) are NOT overlaps.
// ---------------------------------------------------------------------------

export const COLLISION_EPS = 1e-6;

/** True if two boxes overlap on the XZ (floor) footprint. */
export function overlapsXZ(a, b, eps = COLLISION_EPS) {
  return (
    a.x + eps < b.x + b.dims.l &&
    a.x + a.dims.l - eps > b.x &&
    a.z + eps < b.z + b.dims.w &&
    a.z + a.dims.w - eps > b.z
  );
}

/** True if two boxes overlap in all three dimensions (a real intersection). */
export function overlaps3D(a, b, eps = COLLISION_EPS) {
  return (
    a.x + eps < b.x + b.dims.l &&
    a.x + a.dims.l - eps > b.x &&
    a.z + eps < b.z + b.dims.w &&
    a.z + a.dims.w - eps > b.z &&
    a.y + eps < b.y + b.dims.h &&
    a.y + a.dims.h - eps > b.y
  );
}

/**
 * True if `target` intersects any box in `others` (skipping itself by id).
 */
export function collidesAny(target, others, eps = COLLISION_EPS) {
  for (const other of others) {
    if (!other || other === target) continue;
    if (target.id != null && other.id === target.id) continue;
    if (overlaps3D(target, other, eps)) return true;
  }
  return false;
}

/**
 * Lowest-clear resting Y for a box of `dims` at footprint (x, z): stays as
 * close to the floor as possible, climbing past only the blockers whose
 * vertical span actually intersects the item. Honoring stacking rules,
 * returns null when no legal rest exists (item would hover on a forbidden
 * base) or when the resulting stack would exceed the container height.
 *
 * `topItem` describes the item being placed (for canStack checks); `baseLookup`
 * maps a placement to its catalog item (or null to use the placement itself).
 * `skipId` (optional) excludes the placement with that id — useful for the
 * dragged item excluding itself.
 */
export function restingY(x, z, dims, placements, spec, topItem, baseLookup, skipId) {
  const probe = { x, z, dims };
  const overlapping = placements.filter(
    (o) => (skipId == null || o.id !== skipId) && overlapsXZ(probe, o)
  );
  let restY = 0;
  // Iteratively climb to a clear (non-intersecting) height. Because every next
  // top is strictly larger than the previous restY, this converges quickly.
  for (let guard = 0; guard < overlapping.length; guard++) {
    let nextTop = null;
    for (const b of overlapping) {
      if (!ySpanIntersects(restY, restY + dims.h, b.y, b.y + b.dims.h)) continue;
      const top = b.y + b.dims.h;
      if (nextTop == null || top < nextTop) nextTop = top;
    }
    if (nextTop == null) break;
    restY = nextTop;
  }
  if (restY + dims.h > spec.height + COLLISION_EPS) return null; // exceeds container
  // Legal-support check: an elevated item must rest on a base that stacking
  // rules allow (not e.g. on fragile or a stackOn/stackUnder mismatch).
  if (restY > COLLISION_EPS && topItem) {
    const supported = overlapping.some((b) => {
      const top = b.y + b.dims.h;
      if (Math.abs(top - restY) > Math.max(1e-4, COLLISION_EPS)) return false;
      const base = (baseLookup && baseLookup(b)) || b;
      return canStack(topItem, base);
    });
    if (!supported) return null;
  }
  return restY;
}

/** Half-open Y interval intersection: [a0,a1) vs [b0,b1). */
function ySpanIntersects(a0, a1, b0, b1) {
  return a0 < b1 - COLLISION_EPS && a1 > b0 + COLLISION_EPS;
}

/**
 * Find the first non-overlapping resting spot for an item of `dims` inside the
 * container. Scans the floor footprint at ground level first (keeping items as
 * low as possible); if the floor is full, scans again allowing the item to rest
 * on top of stackable items (via `restingY`).
 *
 * @returns {{x:number, y:number, z:number, layer:number}|null}
 */
export function findFreePlacement(placements, spec, dims, options = {}) {
  const topItem = options.item || { category: 'general' };
  const baseLookup = options.baseLookup || null;
  const maxX = spec.length - dims.l;
  const maxZ = spec.width - dims.w;
  if (maxX < -COLLISION_EPS || maxZ < -COLLISION_EPS || dims.h > spec.height + COLLISION_EPS) {
    return null; // Item does not fit the container at all.
  }

  // Grid step: fine enough to slot between items, capped so scans stay cheap.
  const stepX = Math.max(0.25, Math.min(dims.l, maxX || dims.l) / 4 || 0.25);
  const stepZ = Math.max(0.25, Math.min(dims.w, maxZ || dims.w) / 4 || 0.25);

  const scan = (allowStack) => {
    for (let z = 0; z <= maxZ + COLLISION_EPS; z += stepZ) {
      const cz = Math.min(z, Math.max(0, maxZ));
      for (let x = 0; x <= maxX + COLLISION_EPS; x += stepX) {
        const cx = Math.min(x, Math.max(0, maxX));
        let y = 0;
        if (allowStack) {
          y = restingY(cx, cz, dims, placements, spec, topItem, baseLookup);
          if (y == null) continue;
        }
        const candidate = { x: cx, y, z: cz, dims };
        if (!collidesAny(candidate, placements)) {
          return { x: cx, y, z: cz, layer: y <= COLLISION_EPS ? 0 : 1 };
        }
      }
    }
    return null;
  };

  return scan(false) || scan(true);
}
