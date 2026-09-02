// Smart auto-load engine.
// Heuristic 3D shelf/layer packing with weight-safety awareness.
//
// Coordinate system (scene units = feet):
//   x: along container LENGTH  (0 .. spec.length)
//   z: along container WIDTH   (0 .. spec.width)
//   y: vertical HEIGHT         (0 .. spec.height)
// Placement position (x,y,z) is the item's min corner.

import { getContainer } from './container.js';
import {
  canStack, hazmatIncompatible, uid, itemColor, overlaps3D,
} from './cargo.js';

const EPS = 1e-6;

/** Expand catalog (with qtyAvailable) into individual unit instances. */
function expandUnits(catalog) {
  const units = [];
  for (const item of catalog) {
    const qty = Math.max(0, Math.floor(item.qtyAvailable || 0));
    for (let i = 0; i < qty; i++) {
      units.push({ ...item, _unit: i + 1 });
    }
  }
  return units;
}

/** Candidate orientations for an item, honoring R (swap L/W) and T (tip L/H). */
function orientations(item) {
  const base = { l: item.length, w: item.width, h: item.height };
  const variants = [
    { l: base.l, w: base.w, h: base.h, rot: 0 },
    { l: base.w, w: base.l, h: base.h, rot: 90 }, // R
    { l: base.h, w: base.w, h: base.l, rot: 0, tipped: true }, // T
  ];
  const seen = new Set();
  return variants.filter((v) => {
    const key = `${v.l.toFixed(3)}x${v.w.toFixed(3)}x${v.h.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Candidate seed orderings tried by the best-fill selector. Each returns a
 * fresh sorted copy of the given units. Feeding the same greedy shelf packer a
 * different arrival order produces a different fill; trying several and keeping
 * the best is what lets the engine "pick through" the catalog to best fill the
 * container in front of it, rather than being locked into one global sort.
 */
const SEED_ORDERINGS = {
  heaviest: (u) => [...u].sort((a, b) =>
    (b.weight - a.weight) ||
    (b.length * b.width * b.height - a.length * a.width * a.height)),
  volume: (u) => [...u].sort((a, b) =>
    (b.length * b.width * b.height - a.length * a.width * a.height) ||
    (b.weight - a.weight)),
  footprint: (u) => [...u].sort((a, b) =>
    (b.length * b.width - a.length * a.width) || (b.height - a.height)),
  tallest: (u) => [...u].sort((a, b) =>
    (b.height - a.height) ||
    (b.length * b.width - a.length * a.width)),
  density: (u) => [...u].sort((a, b) => {
    const da = a.weight / Math.max(EPS, a.length * a.width * a.height);
    const db = b.weight / Math.max(EPS, b.length * b.width * b.height);
    return (db - da) || (b.weight - a.weight);
  }),
};

/**
 * Core single-container greedy shelf packer. Fills space sequentially
 * (front→back, left→right, bottom→top), honoring orientation, payload, hazmat
 * segregation and stacking rules. It never mutates the incoming units (their
 * fields are only read), so the same unit pool can be tried under several seed
 * orderings safely.
 *
 * @param {Array} units    pre-sorted unit instances (arrival order matters)
 * @param {object} spec    container spec
 * @param {object} options { segregateHazmat? }
 * @returns {{ placements, plan, totalWeight, placed:Set, remaining:Array }}
 */
function packInto(units, spec, options = {}) {
  const placements = [];
  const remaining = [];
  const plan = [];
  let totalWeight = 0;
  let step = 0;

  let layerBaseY = 0; // bottom of current layer
  let layerHeight = 0; // tallest item in current layer
  let cursorX = 0; // along length
  let cursorZ = 0; // along width
  let rowDepth = 0; // deepest (width) item in current row
  let currentLayer = 0;

  function startNewRow() {
    cursorX = 0;
    cursorZ += rowDepth;
    rowDepth = 0;
  }
  function startNewLayer() {
    layerBaseY += layerHeight;
    layerHeight = 0;
    cursorX = 0;
    cursorZ = 0;
    rowDepth = 0;
    currentLayer += 1;
  }

  for (const unit of units) {
    if (totalWeight + unit.weight > spec.payloadLb + EPS) {
      // Too heavy for what's left of this container's payload; it may still fit
      // an emptier container later, so hand it back as remaining.
      remaining.push(unit);
      continue;
    }

    let placed = false;
    const oris = orientations(unit);

    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      for (const o of oris) {
        const fitsHeight = layerBaseY + o.h <= spec.height + EPS;
        const fitsLength = cursorX + o.l <= spec.length + EPS;
        const fitsWidth = cursorZ + o.w <= spec.width + EPS;
        if (!fitsHeight || !fitsLength || !fitsWidth) continue;

        // Hazmat segregation within a layer.
        const conflict = placements.some(
          (p) =>
            p.layer === currentLayer &&
            hazmatIncompatible(p.hazmatClass, unit.hazmatClass)
        );
        if (conflict && options.segregateHazmat !== false) continue;

        // Stacking rules when above the floor.
        if (currentLayer > 0) {
          const below = placements.find(
            (p) =>
              p.layer === currentLayer - 1 &&
              intersectsXZ(p, cursorX, cursorZ, o.l, o.w)
          );
          if (below && !canStack(unit, below.__item)) continue;
        }

        // Final overlap guard: never emit a placement that intersects an
        // already-placed item, even if per-axis fit checks rounded favorably.
        const candidate = {
          x: cursorX,
          y: layerBaseY,
          z: cursorZ,
          dims: { l: o.l, w: o.w, h: o.h },
        };
        if (placements.some((q) => overlaps3D(candidate, q, EPS))) continue;

        const placement = {
          id: uid('pl'),
          catalogItemId: unit.id,
          name: unit.name,
          category: unit.category,
          hazmatClass: unit.hazmatClass,
          weight: unit.weight,
          color: itemColor(unit),
          x: cursorX,
          y: layerBaseY,
          z: cursorZ,
          dims: { l: o.l, w: o.w, h: o.h },
          rot: { rot: o.rot || 0, tipped: !!o.tipped },
          layer: currentLayer,
          __item: unit,
        };
        placements.push(placement);
        totalWeight += unit.weight;
        cursorX += o.l;
        rowDepth = Math.max(rowDepth, o.w);
        layerHeight = Math.max(layerHeight, o.h);
        step += 1;
        plan.push({
          step,
          text:
            `Place ${unit.name} (${unit.weight} lb) on layer ${currentLayer + 1}` +
            (o.rot ? ' [rotated]' : '') +
            (o.tipped ? ' [tipped]' : ''),
          note: currentLayer === 0 ? 'floor / heaviest-first' : 'stacked (rules ok)',
        });
        placed = true;
        break;
      }
      if (!placed) {
        if (attempt === 0) startNewRow();
        else if (attempt === 1) startNewLayer();
      }
    }

    if (!placed) remaining.push(unit);
  }

  const placed = new Set(placements.map((p) => p.__item));
  return { placements, plan, totalWeight, placed, remaining };
}

/**
 * Utilization score for a packed container. Higher = fuller. Volume fill is the
 * primary objective (best physically fills the box); weight fill is a lighter
 * secondary term so, all else equal, the packing that also uses more payload is
 * preferred. Purely a ranking function — units and their scale don't matter.
 */
function fillScore(res, spec) {
  const usedVol = res.placements.reduce(
    (s, p) => s + p.dims.l * p.dims.w * p.dims.h,
    0
  );
  const containerVol = spec.length * spec.width * spec.height || 1;
  const volFrac = usedVol / containerVol;
  const weightFrac = spec.payloadLb ? res.totalWeight / spec.payloadLb : 0;
  return volFrac + 0.25 * weightFrac;
}

/**
 * Best-fill selection for a single container. Packs the given units under every
 * seed ordering and keeps the fullest result. The seed list is ordered so the
 * strategy's natural ordering is tried first (and wins ties), which keeps the
 * behavior intuitive while still exploring alternatives.
 *
 * @returns the winning packInto() result (with __item still attached), or null.
 */
function bestFill(units, spec, strategy, options = {}) {
  const order =
    strategy === 'volume'
      ? ['volume', 'footprint', 'tallest', 'heaviest', 'density']
      : strategy === 'fewest'
        ? ['volume', 'density', 'footprint', 'heaviest', 'tallest']
        : ['heaviest', 'density', 'volume', 'footprint', 'tallest']; // balanced

  let best = null;
  let bestScore = -Infinity;
  for (const seedId of order) {
    const seeded = SEED_ORDERINGS[seedId](units);
    const res = packInto(seeded, spec, options);
    if (!res.placements.length) continue;
    const score = fillScore(res, spec);
    if (score > bestScore) {
      bestScore = score;
      best = res;
    }
  }
  return best;
}

/**
 * Pack a catalog into a SINGLE container (backward-compatible entry point).
 * Uses the best-fill selector so overflow is reported as `unplaced`.
 * @returns { placements, unplaced, plan, stats }
 */
export function pack(catalog, containerType, options = {}) {
  const strategy = options.strategy || 'balanced';
  const spec = getContainer(containerType);
  const units = expandUnits(catalog);

  const res =
    bestFill(units, spec, strategy, options) ||
    { placements: [], plan: [], totalWeight: 0, remaining: units };

  // The shelf packer fills space sequentially (front→back, left→right, bottom→
  // top), clustering used cargo in one corner. For the balanced strategy,
  // re-center the load and redistribute weight so "Balanced" is truly balanced.
  if (strategy === 'balanced') {
    balanceLoad(res.placements, spec);
  }

  const clean = res.placements.map(({ __item, ...p }) => ({ ...p }));
  const unplaced = res.remaining.map((u) => ({ item: u, reason: 'no-space' }));
  const stats = buildStats(clean, unplaced, spec, res.totalWeight);
  return { placements: clean, unplaced, plan: res.plan, stats };
}

/**
 * Sequentially best-fill the catalog across as many containers as needed.
 *
 * Each pass selects the subset of remaining units that best fills the current
 * (empty) container, "locks" it, then repeats with whatever is left — mirroring
 * a real workflow of packing one container out, sealing it, and starting the
 * next. Units that cannot fit any empty container (e.g. oversized) are reported
 * as `unplaced` once no further progress is possible.
 *
 * @param {Array} catalog   project item catalog (with qtyAvailable)
 * @param {object} options  { strategy?, containerType?, maxContainers?, segregateHazmat? }
 * @returns {{ containers, unplaced, summary }}
 *   containers: [{ containerType, placements, plan, stats }]
 */
export function packAll(catalog, options = {}) {
  const strategy = options.strategy || 'balanced';
  const containerType = options.containerType || '20STD';
  const maxContainers = Math.max(1, Math.floor(options.maxContainers || 10));
  const spec = getContainer(containerType);

  let remaining = expandUnits(catalog);
  const totalUnits = remaining.length;
  const containers = [];
  const unplaced = [];

  while (remaining.length && containers.length < maxContainers) {
    const res = bestFill(remaining, spec, strategy, options);
    if (!res || !res.placements.length) {
      // Nothing left fits even an empty container — stop and stage the rest.
      break;
    }

    if (strategy === 'balanced') {
      balanceLoad(res.placements, spec);
    }

    const clean = res.placements.map(({ __item, ...p }) => ({ ...p }));
    const stats = buildStats(clean, [], spec, res.totalWeight);
    containers.push({ containerType, placements: clean, plan: res.plan, stats });
    remaining = res.remaining;
  }

  for (const u of remaining) unplaced.push({ item: u, reason: 'no-space' });

  return {
    containers,
    unplaced,
    summary: {
      containerCount: containers.length,
      totalUnits,
      placedUnits: totalUnits - unplaced.length,
      unplacedUnits: unplaced.length,
      cappedByMax: remaining.length > 0 && containers.length >= maxContainers,
    },
  };
}

/**
 * Weighted center-of-gravity offset from the container's geometric center,
 * expressed as the sum of the absolute normalized offsets on both floor axes
 * (length + width). 0 = perfectly centered; larger = more skewed.
 */
function cogSkew(placements, spec) {
  let totalWeight = 0;
  let sumX = 0;
  let sumZ = 0;
  for (const p of placements) {
    const w = p.weight || 0;
    totalWeight += w;
    sumX += w * (p.x + p.dims.l / 2);
    sumZ += w * (p.z + p.dims.w / 2);
  }
  if (totalWeight <= 0) return 0;
  const midL = spec.length / 2;
  const midW = spec.width / 2;
  const offX = midL ? Math.abs(sumX / totalWeight - midL) / midL : 0;
  const offZ = midW ? Math.abs(sumZ / totalWeight - midW) / midW : 0;
  return offX + offZ;
}

/**
 * Balance a packed load for the "balanced" strategy. Two rules-preserving
 * steps, applied in order:
 *   1. Re-center the whole load: translate every placement by the same offset
 *      so the used cargo's bounding box is centered on the container's floor.
 *      A uniform shift keeps all relative positions, stacks and overlaps
 *      intact — it only moves the load off the packing corner.
 *   2. Redistribute weight (balanceByCog) so, within groups of identical
 *      footprint, the heaviest units sit closest to the center.
 */
function balanceLoad(placements, spec) {
  centerLoad(placements, spec);
  balanceByCog(placements, spec);
}

/**
 * Translate every placement by a single shared offset so the used footprint is
 * centered along both floor axes. The vertical layout is left untouched. Since
 * the shift is uniform, no two boxes change their relative position, so all
 * stacking and collision relationships are preserved by construction.
 */
function centerLoad(placements, spec) {
  if (!placements.length) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of placements) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.dims.l);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z + p.dims.w);
  }
  const usedLength = maxX - minX;
  const usedWidth = maxZ - minZ;
  // Clamp the shift so the load can never be pushed outside the container
  // (guards against floating-point spill when the load fills a full axis).
  const shiftX = clamp((spec.length - usedLength) / 2 - minX, -minX, spec.length - maxX);
  const shiftZ = clamp((spec.width - usedWidth) / 2 - minZ, -minZ, spec.width - maxZ);
  for (const p of placements) {
    p.x += shiftX;
    p.z += shiftZ;
  }
}

function clamp(value, lo, hi) {
  if (hi < lo) return value; // no room to move on this axis
  return Math.max(lo, Math.min(hi, value));
}

/** True if placing `unit` at `slot` keeps hazmat + stacking rules satisfied. */
function slotAccepts(slot, unit, placements) {
  // Hazmat segregation within the same layer.
  const hazConflict = placements.some(
    (p) =>
      p !== slot &&
      p.layer === slot.layer &&
      hazmatIncompatible(p.hazmatClass, unit.hazmatClass)
  );
  if (hazConflict) return false;

  // Stacking rules for anything resting above the floor.
  if (slot.layer > 0) {
    const below = placements.find(
      (p) =>
        p.layer === slot.layer - 1 &&
        intersectsXZ(p, slot.x, slot.z, slot.dims.l, slot.dims.w)
    );
    if (below && !canStack(unit, below.__item)) return false;
  }

  // Anything resting on this slot must still be allowed to sit on `unit`.
  const above = placements.filter(
    (p) =>
      p !== slot &&
      p.layer === slot.layer + 1 &&
      intersectsXZ(p, slot.x, slot.z, slot.dims.l, slot.dims.w)
  );
  return above.every((p) => canStack(p.__item, unit));
}

/**
 * Rebalance a packed layout by reassigning whole units among slots that share
 * an identical footprint. Because the footprint is identical, overlaps never
 * change; only weight distribution (and the units' own identity) moves. A
 * global greedy assigns the heaviest units to the slots that keep the running
 * center of gravity closest to the container center. The result is applied only
 * when every reassignment stays rule-valid and overall balance improves.
 */
function balanceByCog(placements, spec) {
  if (placements.length < 2) return;

  const key = (d) => `${d.l.toFixed(3)}x${d.w.toFixed(3)}x${d.h.toFixed(3)}`;
  const groups = new Map();
  placements.forEach((p) => {
    const k = key(p.dims);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });

  const midL = spec.length / 2;
  const midW = spec.width / 2;
  const before = cogSkew(placements, spec);

  // Snapshot the identity/weight payload of each slot so we can revert.
  const snapshot = placements.map((p) => ({ ...p }));
  const assignments = []; // { slot, unit } to apply if accepted.

  for (const slots of groups.values()) {
    if (slots.length < 2) continue;

    // The interchangeable units are exactly the payloads currently in this
    // group; assign the heaviest first for a stable, weight-aware placement.
    const units = slots.map((s) => s.__item).sort((a, b) => b.weight - a.weight);
    const open = slots.map((s) => ({
      slot: s,
      cx: s.x + s.dims.l / 2,
      cz: s.z + s.dims.w / 2,
      taken: false,
    }));

    let sumX = 0;
    let sumZ = 0;
    let tw = 0;
    for (const unit of units) {
      let best = null;
      let bestScore = Infinity;
      for (const cand of open) {
        if (cand.taken) continue;
        if (!slotAccepts(cand.slot, unit, placements)) continue;
        const nt = tw + unit.weight;
        const offX = midL ? Math.abs((sumX + unit.weight * cand.cx) / nt - midL) / midL : 0;
        const offZ = midW ? Math.abs((sumZ + unit.weight * cand.cz) / nt - midW) / midW : 0;
        const score = offX + offZ;
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      if (!best) {
        // No rule-valid slot for this unit — abandon rebalancing entirely.
        return;
      }
      best.taken = true;
      sumX += unit.weight * best.cx;
      sumZ += unit.weight * best.cz;
      tw += unit.weight;
      assignments.push({ slot: best.slot, unit });
    }
  }

  if (!assignments.length) return;

  // Apply the reassignment: copy each unit's identity + weight into its slot.
  for (const { slot, unit } of assignments) {
    slot.name = unit.name;
    slot.category = unit.category;
    slot.hazmatClass = unit.hazmatClass;
    slot.weight = unit.weight;
    slot.color = itemColor(unit);
    slot.catalogItemId = unit.id;
    slot.__item = unit;
  }

  // Keep the new layout only if it genuinely improves balance.
  if (cogSkew(placements, spec) >= before - EPS) {
    placements.forEach((p, i) => Object.assign(p, snapshot[i]));
  }
}

function intersectsXZ(p, x, z, l, w) {
  return (
    x < p.x + p.dims.l - EPS &&
    x + l > p.x + EPS &&
    z < p.z + p.dims.w - EPS &&
    z + w > p.z + EPS
  );
}

function buildStats(placements, unplaced, spec, totalWeight) {
  const usedVol = placements.reduce(
    (s, p) => s + p.dims.l * p.dims.w * p.dims.h,
    0
  );
  const containerVol = spec.length * spec.width * spec.height;
  return {
    itemCount: placements.length,
    unplacedCount: unplaced.length,
    totalWeight,
    payloadLb: spec.payloadLb,
    weightPct: spec.payloadLb ? (totalWeight / spec.payloadLb) * 100 : 0,
    usedVolume: usedVol,
    containerVolume: containerVol,
    volumePct: containerVol ? (usedVol / containerVol) * 100 : 0,
  };
}

export const STRATEGIES = [
  { id: 'balanced', label: 'Balanced (space + weight safety)' },
  { id: 'volume', label: 'Maximize volume' },
  { id: 'fewest', label: 'Fewest containers (fill fully)' },
];

// Default cap on how many containers a single auto-load run may generate.
export const DEFAULT_MAX_CONTAINERS = 10;
