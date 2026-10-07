// Cargo domain: categories, hazmat classes, colors, stacking rules, and helpers.
import { getOpenings } from './container.js';

export const MAX_CATALOG_UNITS = 5000;

// Default footprint-overhang allowance for stacked items (percent of the
// item's base that may hang past legal supports). Scenarios can override it;
// anything overhanging within the allowance is highlighted red in the viewer.
export const DEFAULT_MAX_OVERHANG_PCT = 5;

function numeric(value, fallback, name, min, integer = false) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isSafeInteger(n))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} ≥ ${min}`);
  }
  return n;
}

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

// ---------------------------------------------------------------------------
// Platform / racking structures.
//
// A "platform" placement (kind === 'platform') models real-world framing and
// decking built to create extra load-bearing surfaces above floor level
// (e.g. a deck built over a 4x4 crate so smaller crates can rest on top of
// it). Its base/legs and walls are STRUCTURAL ONLY: they never collide with
// cargo (both directions — cargo may pass through the platform body, and the
// platform may be erected overlapping existing cargo). Only the container
// walls still bound it, and its TOP surface counts as legal, packable support
// for any item. Rendered tan and very translucent (see scene.js).
// ---------------------------------------------------------------------------

/** Tan color used to render platform structures in the viewer. */
// Platform/racking structures render tan and translucent so the cargo they
// frame/bridge stays visible through the ghost body.
export const PLATFORM_COLOR = '#d2b48c';
export const PLATFORM_OPACITY = 0.35;

/** True when placement `p` is a platform/racking structure. */
export function isPlatform(p) {
  return !!p && p.kind === 'platform';
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
  if (partial.qtyAvailable != null && Number(partial.qtyAvailable) > MAX_CATALOG_UNITS) {
    throw new Error(`Quantity cannot exceed ${MAX_CATALOG_UNITS}`);
  }
  return {
    id: partial.id || uid('cat'),
    name: partial.name || 'New Item',
    category: partial.category || 'general',
    hazmatClass: partial.hazmatClass || 'none',
    length: numeric(partial.length, 4, 'Length', 0.001),
    width: numeric(partial.width, 3.5, 'Width', 0.001),
    height: numeric(partial.height, 4, 'Height', 0.001),
    weight: numeric(partial.weight, 500, 'Weight', 0),
    qtyAvailable: numeric(partial.qtyAvailable, 1, 'Quantity', 0, true),
    stackOn: partial.stackOn || ['general', 'heavy'],
    stackUnder: partial.stackUnder || ['general', 'fragile', 'perishable'],
    color: partial.color || null,
    // "Do not tip": when true, this item may still be rotated 90° (L/W swap)
    // but must never be tipped onto its side (L/H swap) — manual tip (T),
    // auto-load, and the "Place" rotate-retry fallback all honor this.
    noTip: !!partial.noTip,
  };
}

/**
 * Can `top` item be stacked on top of `base` item?
 * Rules:
 *  - the floor (no base) is always a valid support
 *  - never stack anything on a fragile base
 *  - never stack hazmat-incompatible items together
 *  - otherwise any base can support any top, so items can be placed higher
 *    (stacked) once the floor is full
 */
export function canStack(top, base) {
  if (!base) return true; // floor is always a valid base
  if (base.category === 'fragile') return false; // never stack on a fragile base
  // Keep hazmat segregation; otherwise allow stacking on any base so items can
  // be placed higher when the floor is full (no stackOn/stackUnder category gate).
  if (hazmatIncompatible(top?.hazmatClass, base?.hazmatClass)) return false;
  return true;
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

// Vertical tolerance (ft, ~3/4") for treating a base as supporting an item
// whose bottom sits slightly above the base top: neighboring stacks a hair
// apart in height must still count as (bridging) support, otherwise stacking
// across them is reported as "no legal resting spot".
export const SUPPORT_TOL = 0.06;

// ---------------------------------------------------------------------------
// Snap-to-grid (viewer)
//
// The 3D viewer's floor grid is drawn at 1-foot cells (cosmetic), but drag and
// nudge snapping uses a finer 1-inch grid so items can be aligned precisely
// without being restricted to whole-foot positions. All scene units are feet,
// so 1 inch is 1/12 ft.
// ---------------------------------------------------------------------------

export const GRID_SIZE_FT = 1 / 12; // 1 inch, in feet

/** Snap a single coordinate (feet) to the nearest multiple of `size` (feet). */
export function snapToGrid(value, size = GRID_SIZE_FT) {
  if (!size) return value;
  return Math.round(value / size) * size;
}

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
 * Platform structures are invisible to this check in BOTH directions: a
 * platform's legs/walls pass through cargo, and cargo passes through the
 * platform body — only the platform's top surface matters (as a support).
 */
export function collidesAny(target, others, eps = COLLISION_EPS) {
  if (isPlatform(target)) return false;
  for (const other of others) {
    if (!other || other === target) continue;
    if (target.id != null && other.id === target.id) continue;
    if (isPlatform(other)) continue;
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
export function restingY(x, z, dims, placements, spec, topItem, baseLookup, skipId, maxOverhangPct = 0) {
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
  // Legal-support + overhang check: an elevated item must rest on base(s) that
  // stacking rules allow (not e.g. on fragile, or a hazmat mismatch) and those
  // legal bases must cover the item's footprint — except for a configurable
  // overhang allowance (maxOverhangPct, percent of the base area that may hang
  // over open air; default 0 = strict full support).
  if (restY > COLLISION_EPS && topItem) {
    const matched = overlapping.filter((b) => {
      const top = b.y + b.dims.h;
      // A base supports the item when its top is at (or just below — within
      // SUPPORT_TOL, i.e. the item bridges the tiny step) the resting height.
      // A top ABOVE restY would collide and cannot have survived the climb.
      if (top > restY + Math.max(1e-4, COLLISION_EPS) || top < restY - SUPPORT_TOL) return false;
      const base = (baseLookup && baseLookup(b)) || b;
      return canStack(topItem, base);
    });
    if (!matched.length || !isFullySupported(probe, matched, maxOverhangPct)) return null;
  }
  return restY;
}

/** Half-open Y interval intersection: [a0,a1) vs [b0,b1). */
function ySpanIntersects(a0, a1, b0, b1) {
  return a0 < b1 - COLLISION_EPS && a1 > b0 + COLLISION_EPS;
}

/**
 * Fraction (0..1) of `box`'s XZ footprint NOT covered by the union of
 * `supports`' XZ footprints (each support exposing a min-corner {x,z} and
 * {dims:{l,w}}). Implemented via iterative axis-aligned rectangle
 * subtraction: start with the box's footprint as a single "uncovered" piece,
 * carve out each support's footprint from every remaining piece, and measure
 * what is left. Returns 0 when only a sliver of floating-point noise is
 * uncovered — real overhang only.
 */
export function overhangRatio(box, supports) {
  const area = box.dims.l * box.dims.w;
  if (!(area > 0)) return 0;
  let pieces = [{ x0: box.x, x1: box.x + box.dims.l, z0: box.z, z1: box.z + box.dims.w }];
  for (const s of supports) {
    if (!pieces.length) break;
    const rect = { x0: s.x, x1: s.x + s.dims.l, z0: s.z, z1: s.z + s.dims.w };
    const next = [];
    for (const p of pieces) next.push(...subtractRect(p, rect));
    pieces = next;
  }
  const leftoverArea = pieces.reduce(
    (sum, p) => sum + Math.max(0, p.x1 - p.x0) * Math.max(0, p.z1 - p.z0),
    0
  );
  if (leftoverArea <= 1e-4) return 0; // tolerate floating-point noise, not real overhang
  return Math.min(1, leftoverArea / area);
}

/**
 * Overhang support check: true when the uncovered fraction of `box`'s
 * footprint (see overhangRatio) is within `maxOverhangPct` percent
 * (default 0 = full support required, only floating-point noise tolerated).
 */
export function isFullySupported(box, supports, maxOverhangPct = 0) {
  return overhangRatio(box, supports) * 100 <= Math.max(0, maxOverhangPct) + 1e-9;
}

/** Axis-aligned rectangle difference: the piece(s) of `p` not covered by `s`. */
function subtractRect(p, s) {
  const ix0 = Math.max(p.x0, s.x0);
  const ix1 = Math.min(p.x1, s.x1);
  const iz0 = Math.max(p.z0, s.z0);
  const iz1 = Math.min(p.z1, s.z1);
  if (ix0 >= ix1 - COLLISION_EPS || iz0 >= iz1 - COLLISION_EPS) return [p]; // no overlap
  const out = [];
  if (p.z0 < iz0 - COLLISION_EPS) out.push({ x0: p.x0, x1: p.x1, z0: p.z0, z1: iz0 }); // strip before
  if (p.z1 > iz1 + COLLISION_EPS) out.push({ x0: p.x0, x1: p.x1, z0: iz1, z1: p.z1 }); // strip after
  if (p.x0 < ix0 - COLLISION_EPS) out.push({ x0: p.x0, x1: ix0, z0: iz0, z1: iz1 }); // left of overlap
  if (p.x1 > ix1 + COLLISION_EPS) out.push({ x0: ix1, x1: p.x1, z0: iz0, z1: iz1 }); // right of overlap
  return out;
}

/**
 * Lowest uniform vertical shift `dy` that lets a RIGID GROUP of boxes rest
 * legally at a target XZ pose — the group-drag counterpart of `restingY` for
 * a single box. `members` are candidate poses (min-corner {x,y,z} + dims) at
 * their target XZ with their START heights; `outside` are the placements the
 * group must not collide with. A uniform dy keeps every member's relative
 * position and height, so support relations INSIDE the group are dy-invariant
 * (a stack moves as one).
 *
 * Returns the lowest dy (negative when the group can settle DOWN, e.g. off a
 * stack onto the floor) such that every member stays inside the container,
 * collides with nothing outside, and is fully supported — by the floor, by
 * outside cargo tops at the right level, or by fellow members (stacking rules
 * enforced via the same predicate layoutError uses). Returns null when no
 * legal rest exists at this XZ pose (overhang, fragile base, hazmat mismatch,
 * or the group would poke through the roof).
 */
export function groupRestingDelta(members, outside, spec, maxOverhangPct = 0) {
  const levels = new Set([0]);
  for (const m of members) {
    levels.add(-m.y); // this member reaches the floor
    for (const o of outside) levels.add(o.y + o.dims.h - m.y); // rests on o's top
  }
  for (const dy of [...levels].sort((a, b) => a - b)) {
    const posed = members.map((m) => ({ ...m, y: m.y + dy }));
    if (posed.some((p) => p.y < -COLLISION_EPS || p.y + p.dims.h > spec.height + COLLISION_EPS)) continue;
    if (posed.some((p) => collidesAny(p, outside))) continue;
    const supported = posed.every((p) => {
      if (p.y <= COLLISION_EPS) return true; // the floor is always a valid base
      const supporters = [...posed.filter((q) => q !== p), ...outside].filter((q) =>
        q.y + q.dims.h >= p.y - SUPPORT_TOL && q.y + q.dims.h <= p.y + 1e-4 &&
        overlapsXZ(p, q) && canStack(p, q));
      return isFullySupported(p, supporters, maxOverhangPct);
    });
    if (supported) return dy;
  }
  return null;
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
  if (placements.some((p) => hazmatIncompatible(p.hazmatClass, topItem.hazmatClass))) return null;
  if (placements.reduce((sum, p) => sum + (p.weight || 0), 0) + (topItem.weight || 0) > spec.payloadLb) return null;
  if (![dims.l, dims.w, dims.h].every((v) => Number.isFinite(v) && v > 0)) return null;
  const baseLookup = options.baseLookup || null;
  const maxX = spec.length - dims.l;
  const maxZ = spec.width - dims.w;
  if (maxX < -COLLISION_EPS || maxZ < -COLLISION_EPS || dims.h > spec.height + COLLISION_EPS) {
    return null; // Item does not fit the container at all.
  }

  // Grid step: fine enough to slot between items, capped so scans stay cheap.
  const stepX = Math.max(0.25, Math.min(dims.l, maxX || dims.l) / 4 || 0.25);
  const stepZ = Math.max(0.25, Math.min(dims.w, maxZ || dims.w) / 4 || 0.25);

  // Scan coordinates: the regular grid PLUS every edge-aligned coordinate
  // (a placement's own edge, and where the new item would touch its far edge),
  // so legal slots between items are never skipped just because they fall
  // between grid points.
  const coords = (maxC, dimC, step, along) => {
    const vals = new Set();
    for (let v = 0; v <= maxC + COLLISION_EPS; v += step) vals.add(Math.min(v, Math.max(0, maxC)));
    for (const p of placements) {
      for (const v of [p[along], p[along] + p.dims[dimC === 'l' ? 'l' : 'w'] - dimC]) {
        if (Number.isFinite(v)) vals.add(Math.max(0, Math.min(v, maxC)));
      }
    }
    return [...vals].sort((a, b) => a - b);
  };
  const xs = coords(maxX, dims.l, stepX, 'x');
  const zs = coords(maxZ, dims.w, stepZ, 'z');

  const scan = (allowStack) => {
    for (const z of zs) {
      const cz = z;
      for (const x of xs) {
        const cx = x;
        let y = 0;
        if (allowStack) {
          y = restingY(cx, cz, dims, placements, spec, topItem, baseLookup, undefined, options.maxOverhangPct ?? 0);
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

/**
 * Candidate orientations for a box of `dims` (feet), each describing a
 * rotate/tip transform relative to the original: rotating 90° (R) swaps
 * length/width, and tipping (T) swaps length/height. Mirrors the orientation
 * set used by the auto-load packer (see autoload.js `orientations`) so manual
 * "Place" placement can retry the same set of physical orientations.
 */
export function placementOrientations(dims, options = {}) {
  const variants = [
    { l: dims.l, w: dims.w, h: dims.h, rot: 0, tipped: false },
    { l: dims.w, w: dims.l, h: dims.h, rot: 90, tipped: false }, // R
  ];
  // Respect the catalog item's "do not tip" flag: skip the tip (L/H swap)
  // orientation entirely for items that can't safely be placed on their side.
  if (!options.noTip) {
    variants.push(
      { l: dims.h, w: dims.w, h: dims.l, rot: 0, tipped: true },
      { l: dims.w, w: dims.h, h: dims.l, rot: 90, tipped: true },
      { l: dims.l, w: dims.h, h: dims.w, rot: 0, tipped: true },
      { l: dims.h, w: dims.l, h: dims.w, rot: 90, tipped: true },
    );
  }
  const seen = new Set();
  return variants.filter((v) => {
    const key = `${v.l.toFixed(4)}x${v.w.toFixed(4)}x${v.h.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Like `findFreePlacement`, but when the item does not fit (or has no room)
 * in its current orientation, automatically retries with the item rotated
 * (swap L/W) and tipped (swap L/H) — the same physical orientations the
 * auto-load packer considers — before giving up. Returns the resting spot
 * plus the `dims`/`rot` that worked, or null if no orientation fits.
 *
 * @returns {{x:number, y:number, z:number, layer:number, dims:object, rot:{rot:number, tipped:boolean}}|null}
 */
export function findFreePlacementAnyOrientation(placements, spec, dims, options = {}) {
  const noTip = !!(options.noTip ?? options.item?.noTip);
  for (const o of placementOrientations(dims, { noTip })) {
    if (!fitsOpening(o, spec)) continue;
    const spot = findFreePlacement(placements, spec, { l: o.l, w: o.w, h: o.h }, options);
    if (spot) {
      return { ...spot, dims: { l: o.l, w: o.w, h: o.h }, rot: { rot: o.rot, tipped: o.tipped } };
    }
  }
  return null;
}

// How close (in feet) a drag target may be to a neighboring footprint edge
// for the support-magnet to win over the plain grid snap. Auto-packed layouts
// place cargo at fractional, off-grid coordinates (e.g. flush against a wall at
// z = 4.375 ft in a 40HC), so grid snapping alone can never zero out a stacking
// misalignment — the magnet aligns footprints instead. 0.5 ft = 6 inches.
export const MAGNET_TOL_FT = 0.5;

/**
 * Support-magnet snapping for one axis. Given the raw (pointer) min-coordinate
 * `raw` and the item's span along this axis, consider three alignment poses
 * against every other placement's footprint on that axis —
 *   - left-aligned  (raw = other.x)
 *   - right-aligned (raw + span = other edge)
 *   - centered      (raw = other.x + (other span - span) / 2)
 * — plus the two container walls. When the closest alignment candidate is
 * within MAGNET_TOL_FT of the raw target it wins (even if the plain grid snap
 * would move the item less); otherwise the fallback (grid snap, or identity)
 * applies. Returns an unclamped coordinate; callers clamp inside the container.
 */
function magnetizeAxis(raw, supports, fallback, span) {
  let best = null;
  let bestDist = Infinity;
  for (const s of supports) {
    for (const c of [s.lo, s.lo + s.span - span, s.lo + (s.span - span) / 2]) {
      const d = Math.abs(c - raw);
      if (d < bestDist - 1e-9) {
        best = c;
        bestDist = d;
      }
    }
  }
  return bestDist <= MAGNET_TOL_FT ? best : fallback;
}

/**
 * Try to fit an item at a specific pointer spot, retrying other orientations
 * when its current one doesn't fit there — the drag-time counterpart of
 * `findFreePlacementAnyOrientation` (which searches the whole container).
 *
 * Orientations are tried current-first via `placementOrientations` (rotate 90°,
 * then the tipped variants unless the item is `noTip`), each re-centered on the
 * requested spot so the item stays under the pointer, clamped inside the
 * container, and validated for collisions and (optionally) full-layout rules.
 *
 * @param {number} x,z   requested min-corner position (pre-snap pointer target)
 * @param {object} options { item?, noTip?, baseLookup?, skipId?, stack?,
 *   snapGrid?, magnet?, validate?(candidate)=>error|null, diag?(reason) }
 *   - stack:    settle onto supports via restingY instead of dropping to y=0
 *   - skipId:   placement id to ignore as obstacle (the dragged item itself)
 *   - magnet:   support-magnet snapping (default true) — align the footprint
 *               to a neighboring cargo edge or wall within MAGNET_TOL_FT,
 *               overriding the plain grid snap
 *   - validate: extra rule check; candidate is rejected when it returns truthy
 *   - diag:     optional callback receiving the most specific rejection reason
 *               when no orientation fits (a validate() error beats generics)
 * @returns {{x:number, y:number, z:number, dims:object, rot:{rot:number, tipped:boolean}}|null}
 *   The pose that fit (dims/rot describe the orientation change relative to
 *   the given `dims`), or null when no orientation fits at this spot.
 */
export function fitAtSpot(x, z, placements, spec, dims, options = {}) {
  const noTip = !!(options.noTip ?? options.item?.noTip);
  const snap = options.snapGrid ? (v) => snapToGrid(v) : (v) => v;
  // Support-magnet: alignment candidates from every other placement's footprint
  // (left/right/centered per axis). Walls are added per-orientation below.
  const magnet = options.magnet !== false;
  const supportsX = [];
  const supportsZ = [];
  if (magnet) {
    for (const q of placements) {
      if (!q || !q.dims || q.id === options.skipId) continue;
      supportsX.push({ lo: q.x, span: q.dims.l });
      supportsZ.push({ lo: q.z, span: q.dims.w });
    }
  }
  let reason = null; // why no orientation has fit so far (for options.diag)
  for (const o of placementOrientations(dims, { noTip })) {
    const odims = { l: o.l, w: o.w, h: o.h };
    // Floor drops skip restingY, so enforce the container height explicitly.
    if (!options.stack && o.h > spec.height + COLLISION_EPS) {
      reason = reason || 'too tall for the container';
      continue;
    }
    // Keep the footprint CENTER at the requested spot when the orientation
    // changes, so a reoriented item doesn't jump sideways out from under the
    // pointer; then snap (grid + support-magnet) and clamp inside the
    // container with the new dims. The magnet aligns the footprint to a
    // neighboring cargo edge or a wall when one is close, so stacking on
    // off-grid auto-packed cargo lands flush instead of overhanging.
    const rawX = x + (dims.l - o.l) / 2;
    const rawZ = z + (dims.w - o.w) / 2;
    const wallX = magnet
      ? supportsX.concat([{ lo: 0, span: o.l }, { lo: spec.length - o.l, span: o.l }])
      : null;
    const wallZ = magnet
      ? supportsZ.concat([{ lo: 0, span: o.w }, { lo: spec.width - o.w, span: o.w }])
      : null;
    const nx = Math.max(0, Math.min(
      magnet ? magnetizeAxis(rawX, wallX, snap(rawX), o.l) : snap(rawX),
      spec.length - o.l));
    const nz = Math.max(0, Math.min(
      magnet ? magnetizeAxis(rawZ, wallZ, snap(rawZ), o.w) : snap(rawZ),
      spec.width - o.w));
    let y = 0;
    if (options.stack) {
      y = restingY(nx, nz, odims, placements, spec, options.item, options.baseLookup, options.skipId, options.maxOverhangPct ?? 0);
      if (y == null) {
        reason = reason || 'no legal resting spot (fragile base, hazmat mismatch, overhang, or stack too tall)';
        continue;
      }
    }
    const candidate = { id: options.skipId, x: nx, y, z: nz, dims: odims };
    if (collidesAny(candidate, placements)) {
      reason = reason || 'overlaps other cargo';
      continue;
    }
    if (options.validate) {
      const err = options.validate(candidate);
      // A rule error (e.g. stranded support) is the most useful explanation.
      if (err) {
        reason = typeof err === 'string' ? err : (reason || 'not allowed there');
        continue;
      }
    }
    return { x: nx, y, z: nz, dims: odims, rot: { rot: o.rot, tipped: o.tipped } };
  }
  if (reason && options.diag) options.diag(reason);
  return null;
}

/** Axis-aligned entry check shared by manual placement and layout validation. */
export function fitsOpening(dims, spec) {
  const openings = getOpenings(spec);
  return !openings.length || openings.some((op) => {
    const end = op.face === 'front' || op.face === 'back';
    return (end ? dims.w : dims.l) <= op.width + COLLISION_EPS &&
      dims.h <= Math.min(op.height, spec.height - (op.sill || 0)) + COLLISION_EPS;
  });
}

/**
 * Error introduced by removing placement `removedId`, or null if removal is
 * safe. Compares the layout validation before and after the removal and only
 * reports NEW problems (e.g. cargo the removed item was supporting), so that
 * pre-existing layout issues elsewhere cannot block deleting an unrelated item.
 */
export function removalError(placements, removedId, spec, lookup = () => null, maxOverhangPct = 0) {
  const before = layoutError(placements, spec, lookup, maxOverhangPct);
  const after = layoutError(placements.filter((p) => p.id !== removedId), spec, lookup, maxOverhangPct);
  return after && after !== before ? after : null;
}

/** Human-readable reason canStack(top, base) rejects a pairing (or null). */
export function stackRejectReason(top, base) {
  if (!base) return null;
  if (base.category === 'fragile') return 'fragile base — cargo may never be stacked on fragile items';
  if (hazmatIncompatible(top?.hazmatClass, base?.hazmatClass)) {
    return `hazmat segregation: class ${top?.hazmatClass} cannot be stacked on class ${base.hazmatClass}`;
  }
  return null;
}

/** Placements legally supporting `p` right now (the predicate layoutError uses). */
export function legalSupports(p, placements) {
  return placements.filter((q) => q !== p && q.y + q.dims.h <= p.y + 1e-4 &&
    q.y + q.dims.h >= p.y - SUPPORT_TOL && overlapsXZ(p, q) && canStack(p, q));
}

/**
 * DIAGNOSTIC sibling of layoutError() for a single placement `p` (or a
 * candidate pose substituted into a layout): returns null when `p` passes
 * every per-item rule layoutError enforces, otherwise a structured
 * explanation `{ rule, message, detail }`. `detail` carries the exact
 * geometry numbers — support heights, per-base verdicts, overhang fraction
 * vs. the scenario allowance — so an "illegal placement" can be diagnosed
 * from the diagnostics log instead of guessed at. Purely additive:
 * layoutError() remains the gate the application actually uses.
 */
export function explainPlacementError(p, placements, spec, lookup = () => null, maxOverhangPct = 0) {
  // Platform structures are exempt from cargo rules (door, stacking support)
  // by design; only their bounds matter and layoutError already enforces that.
  if (isPlatform(p)) return null;
  const others = placements.filter((q) => q !== p && q.id !== p.id);
  const r = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);
  const d = p.dims;
  const pose = () => ({ x: r(p.x), y: r(p.y), z: r(p.z) });
  const dims = () => ({ l: r(d.l), w: r(d.w), h: r(d.h) });

  if (!d || ![d.l, d.w, d.h].every((n) => Number.isFinite(n) && n > 0) ||
      ![p.x, p.y, p.z, p.weight].every(Number.isFinite) || p.weight < 0) {
    return { rule: 'invalid', message: 'Invalid cargo dimensions, position or weight',
      detail: { pose: pose(), dims: dims(), weight: p.weight } };
  }
  if (p.x < -COLLISION_EPS || p.y < -COLLISION_EPS || p.z < -COLLISION_EPS ||
      p.x + d.l > spec.length + COLLISION_EPS || p.y + d.h > spec.height + COLLISION_EPS ||
      p.z + d.w > spec.width + COLLISION_EPS) {
    return {
      rule: 'bounds', message: `"${p.name}" is outside the container`,
      detail: {
        pose: pose(), dims: dims(),
        container: { l: r(spec.length), w: r(spec.width), h: r(spec.height) },
        note: `item spans x ${r(p.x)}–${r(p.x + d.l)} (limit ${r(spec.length)}), ` +
          `z ${r(p.z)}–${r(p.z + d.w)} (limit ${r(spec.width)}), ` +
          `top ${r(p.y + d.h)} (limit ${r(spec.height)})`,
      },
    };
  }
  const collider = others.find((q) => overlaps3D(p, q));
  if (collider) {
    return {
      rule: 'collision', message: `"${p.name}" overlaps other cargo`,
      detail: {
        pose: pose(), dims: dims(),
        with: { name: collider.name, x: r(collider.x), y: r(collider.y), z: r(collider.z),
          dims: { l: r(collider.dims.l), w: r(collider.dims.w), h: r(collider.dims.h) } },
      },
    };
  }
  const item = lookup(p.catalogItemId) || p;
  const hazPartner = others.find((q) => hazmatIncompatible(p.hazmatClass, q.hazmatClass));
  if (hazPartner) {
    return {
      rule: 'hazmat', message: 'Incompatible hazardous cargo cannot share a container',
      detail: { pose: pose(), partner: { name: hazPartner.name, hazmatClass: hazPartner.hazmatClass },
        own: { name: p.name, hazmatClass: p.hazmatClass } },
    };
  }
  if (!placementOrientations(d, { noTip: item.noTip }).some((o) => fitsOpening(o, spec))) {
    const op = (getOpenings(spec)[0] || {});
    return {
      rule: 'door', message: `"${p.name}" cannot clear the door`,
      detail: { dims: dims(), opening: { width: r(op.width), height: r(op.height) },
        note: `no orientation of ${r(d.l)}×${r(d.w)}×${r(d.h)} fits the ${r(op.width)}×${r(op.height)} ft door opening` },
    };
  }
  if (item.noTip && item.height != null && Math.abs(d.h - item.height) > COLLISION_EPS) {
    return {
      rule: 'noTip', message: `"${p.name}" must stay upright`,
      detail: { dims: dims(), catalogHeight: r(item.height),
        note: `item is marked do-not-tip but its height ${r(d.h)} differs from the catalog height ${r(item.height)}` },
    };
  }
  if (p.y > COLLISION_EPS) {
    const supports = legalSupports(p, placements);
    if (!isFullySupported(p, supports, maxOverhangPct)) {
      const area = d.l * d.w;
      // Per-base verdict for every item whose footprint is under the candidate.
      const bases = others.filter((q) => overlapsXZ(p, q)).map((q) => {
        const top = q.y + q.dims.h;
        const inter = Math.max(0, Math.min(p.x + d.l, q.x + q.dims.l) - Math.max(p.x, q.x)) *
          Math.max(0, Math.min(p.z + d.w, q.z + q.dims.w) - Math.max(p.z, q.z));
        let verdict;
        if (top > p.y + Math.max(1e-4, COLLISION_EPS)) {
          verdict = `top ${r(top)} is ABOVE the item bottom ${r(p.y)} (would collide)`;
        } else {
          const stackReason = stackRejectReason(p, q);
          if (stackReason) verdict = stackReason;
          else if (top >= p.y - SUPPORT_TOL) verdict = 'legal support';
          else verdict = `top ${r(top)} is ${r(p.y - top)} ft below the item bottom ${r(p.y)} — beyond the ${SUPPORT_TOL} ft bridging tolerance`;
        }
        return { name: q.name, top: r(top), overlapPct: r((inter / area) * 100), verdict };
      });
      const rest = restingY(p.x, p.z, d, placements, spec, item, lookup, p.id, maxOverhangPct);
      return {
        rule: 'unsupported', message: `"${p.name}" would be unsupported`,
        detail: {
          pose: pose(), dims: dims(), itemBottom: r(p.y),
          allowancePct: maxOverhangPct, overhangPct: r(overhangRatio(p, supports) * 100),
          legalSupports: supports.map((q) => q.name),
          restYLegal: rest == null ? null : r(rest),
          bases,
        },
      };
    }
  }
  const totalWeight = placements.reduce((s, q) => s + (q.weight || 0), 0);
  if (totalWeight > spec.payloadLb) {
    return {
      rule: 'payload', message: 'Container payload limit exceeded',
      detail: { totalWeight: r(totalWeight), payloadLb: spec.payloadLb },
    };
  }
  return null;
}

/**
 * Map of placement id → overhang fraction (0..1] for every elevated placement
 * whose footprint is not fully carried by legal supports. Used to highlight
 * items that overhang within the scenario's allowance.
 */
export function overhangFractions(placements) {
  const out = new Map();
  for (const p of placements) {
    if (p.y <= COLLISION_EPS) continue;
    const ratio = overhangRatio(p, legalSupports(p, placements));
    if (ratio > 0) out.set(p.id, ratio);
  }
  return out;
}

/** Validate the whole candidate layout, including cargo supported by moved items. */
export function layoutError(placements, spec, lookup = () => null, maxOverhangPct = 0) {
  let weight = 0;
  const ids = new Set();
  for (const p of placements) {
    const d = p.dims;
    if (!d || ![d.l, d.w, d.h].every((n) => Number.isFinite(n) && n > 0) ||
        ![p.x, p.y, p.z, p.weight].every(Number.isFinite) || p.weight < 0) return 'Invalid cargo dimensions, position or weight';
    if (!p.id || ids.has(p.id)) return 'Placement IDs must be unique';
    ids.add(p.id);
    if (p.x < -COLLISION_EPS || p.y < -COLLISION_EPS || p.z < -COLLISION_EPS ||
        p.x + d.l > spec.length + COLLISION_EPS || p.y + d.h > spec.height + COLLISION_EPS ||
        p.z + d.w > spec.width + COLLISION_EPS) return `"${p.name}" is outside the container`;
    if (collidesAny(p, placements)) return `"${p.name}" overlaps other cargo`;
    const item = lookup(p.catalogItemId) || p;
    if (placements.some((q) => q !== p && hazmatIncompatible(p.hazmatClass, q.hazmatClass))) return 'Incompatible hazardous cargo cannot share a container';
    // Platforms are erected, not loaded through the door, and are structural
    // (framing + legs) rather than cargo: they never need their own support.
    if (!isPlatform(p)) {
      if (!placementOrientations(d, { noTip: item.noTip }).some((o) => fitsOpening(o, spec))) return `"${p.name}" cannot clear the door`;
      if (item.noTip && item.height != null && Math.abs(d.h - item.height) > COLLISION_EPS) return `"${p.name}" must stay upright`;
      if (p.y > COLLISION_EPS) {
        if (!isFullySupported(p, legalSupports(p, placements), maxOverhangPct)) return `"${p.name}" would be unsupported`;
      }
    }
    weight += p.weight;
  }
  return weight > spec.payloadLb ? 'Container payload limit exceeded' : null;
}
