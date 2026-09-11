// Smart auto-load engine.
// Heuristic 3D shelf/layer packing with weight-safety awareness.
//
// Coordinate system (scene units = feet):
//   x: along container LENGTH  (0 .. spec.length)
//   z: along container WIDTH   (0 .. spec.width)
//   y: vertical HEIGHT         (0 .. spec.height)
// Placement position (x,y,z) is the item's min corner.

import { getContainer, getOpenings } from './container.js';
import {
  canStack, hazmatIncompatible, uid, itemColor, overlaps3D, restingY,
} from './cargo.js';
import { orientationFitsOpening, scenarioStats } from './stats.js';

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

/**
 * Candidate orientations for an item: all six axis-aligned permutations of
 * (l, w, h), de-duplicated. The first two entries are the historical
 * "as-entered" and "rotated 90° (R)" variants, which keep the item standing on
 * its original base; the rest change which face is down, i.e. the item has been
 * tipped (T) — possibly tipped AND then spun, which the old three-variant set
 * could not express and which often buys a whole extra row of fill.
 *
 * `tipped` is derived from the geometry rather than hard-coded: any variant
 * whose height differs from the item's own height has been laid over onto a
 * different face. Items flagged `noTip` in the catalog therefore keep only the
 * variants that preserve their upright height, since laying them on their side
 * isn't physically safe. `rot`/`tipped` stay in the same vocabulary the scene,
 * load plan and manifest already use, so nothing downstream needs to change.
 */
function orientations(item) {
  const { length: l, width: w, height: h } = item;
  const variants = [
    { l, w, h, rot: 0 },          // as entered
    { l: w, w: l, h, rot: 90 },   // R (swap L/W, still upright)
    { l: h, w, h: l, rot: 0 },    // T (swap L/H)
    { l: w, w: h, h: l, rot: 90 },
    { l, w: h, h: w, rot: 0 },
    { l: h, w: l, h: w, rot: 90 },
  ];
  const seen = new Set();
  return variants
    // A variant that changes the standing height has been tipped onto another
    // face. Tag it so `noTip` items can drop exactly those variants.
    .map((v) => ({ ...v, tipped: Math.abs(v.h - h) > EPS }))
    .filter((v) => !(item.noTip && v.tipped))
    .filter((v) => {
      const key = `${v.l.toFixed(3)}x${v.w.toFixed(3)}x${v.h.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Per-simulation orientation preference. The packer takes the first orientation
 * that fits, so the order it considers them in decides the layout as much as
 * the arrival order does. Varying this across simulations is what makes the
 * search explore genuinely different rotation strategies instead of replaying
 * the same greedy choice with a reshuffled queue.
 *
 *   upright — original footprint first (most conservative, legacy behavior)
 *   flat    — lowest profile first: more items per layer and mass kept low,
 *             which the floor/roof balance term rewards
 *   tight   — whichever variant leaves the least slack in the length still
 *             available at the cursor, i.e. best use of the current run
 */
const ORIENTATION_BIASES = ['upright', 'flat', 'tight'];

function orderOrientations(oris, bias, runLength) {
  if (bias === 'flat') {
    return [...oris].sort((a, b) => (a.h - b.h) || (b.l * b.w - a.l * a.w));
  }
  if (bias === 'tight') {
    // Prefer the variant that most nearly consumes the remaining run without
    // overshooting it; variants that don't fit the run at all sort last.
    const slack = (o) => {
      const left = runLength - o.l;
      return left < -EPS ? Infinity : left;
    };
    return [...oris].sort((a, b) => (slack(a) - slack(b)) || (a.h - b.h));
  }
  return oris; // 'upright' — declaration order
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
 * Can this orientation be carried in through any of the container's openings?
 * A box that clears the internal cross-section can still be too tall for the
 * door header, so orientations that can't physically get inside are rejected
 * before they're ever placed (see stats.js for the geometric check).
 * Containers with no modeled opening never block anything.
 */
function passesOpening(o, spec) {
  const openings = getOpenings(spec);
  if (!openings.length) return true;
  return openings.some((op) => orientationFitsOpening(o, op, spec).fits);
}

/**
 * True when NO legal orientation of a unit can pass the container's openings —
 * i.e. it could never be loaded, regardless of available space. Used to label
 * staged items with an accurate reason ('door' vs. plain 'no-space').
 */
function doorBlocks(unit, spec) {
  return !orientations(unit).some((o) => passesOpening(o, spec));
}

/** Reason label for a unit that ended up staged rather than placed. */
function unplacedReason(unit, spec) {
  return doorBlocks(unit, spec) ? 'door' : 'no-space';
}

/**
 * Core single-container greedy shelf packer. Fills space sequentially
 * (front→back, left→right, bottom→top), honoring orientation, payload, hazmat
 * segregation and stacking rules. It never mutates the incoming units (their
 * fields are only read), so the same unit pool can be tried under several seed
 * orderings safely.
 *
 * @param {Array} units    pre-sorted unit instances (arrival order matters)
 * @param {object} spec    container spec
 * @param {object} options { segregateHazmat?, orientationBias? }
 * @returns {{ placements, plan, totalWeight, placed:Set, remaining:Array }}
 */
function packInto(units, spec, options = {}) {
  const placements = [];
  const remaining = [];
  const plan = [];
  let totalWeight = 0;
  let step = 0;

  let cursorX = 0; // along length
  let cursorZ = 0; // along width
  let rowDepth = 0; // deepest (width) item in current row
  let currentLayer = 0; // nominal shelf pass, used for hazmat segregation grouping
  // Units rejected solely because no legal orientation clears the door jambs.
  // Tracked separately from ordinary "didn't fit" so the UI can explain that
  // the item is unloadable rather than merely out of room.
  const doorBlocked = [];

  function startNewRow() {
    cursorX = 0;
    cursorZ += rowDepth;
    rowDepth = 0;
  }
  function startNewLayer() {
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
    // Only consider orientations that can actually be carried in through a
    // door/side opening. If none can, the unit is unloadable in this container
    // no matter how much room is left — record it and move on.
    const oris = orientations(unit).filter((o) => passesOpening(o, spec));
    if (!oris.length) {
      doorBlocked.push(unit);
      remaining.push(unit);
      continue;
    }

    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      // Re-rank orientations for THIS cursor: the 'tight' bias depends on how
      // much length is still open in the current run, which changes on every
      // placement and after every row/layer break.
      const ranked = orderOrientations(
        oris, options.orientationBias, spec.length - cursorX
      );
      for (const o of ranked) {
        const fitsLength = cursorX + o.l <= spec.length + EPS;
        const fitsWidth = cursorZ + o.w <= spec.width + EPS;
        if (!fitsLength || !fitsWidth) continue;

        // Hazmat segregation within a layer.
        const conflict = placements.some(
          (p) =>
            p.layer === currentLayer &&
            hazmatIncompatible(p.hazmatClass, unit.hazmatClass)
        );
        if (conflict && options.segregateHazmat !== false) continue;

        // Resolve the item's actual resting height against whatever is
        // physically beneath its footprint (never a flat, guessed layer
        // plane) — this is what keeps items from hovering over gaps. It also
        // enforces the "no overhang" policy: `restingY` only returns a
        // height when the entire footprint at that height is carried by
        // legal, rule-compatible bases (see cargo.js).
        const y = restingY(
          cursorX, cursorZ, { l: o.l, w: o.w, h: o.h },
          placements, spec, unit, (p) => p.__item
        );
        if (y == null) continue;

        // Final overlap guard: never emit a placement that intersects an
        // already-placed item, even if per-axis fit checks rounded favorably.
        const candidate = {
          x: cursorX,
          y,
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
          y,
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
        step += 1;
        plan.push({
          step,
          text:
            `Place ${unit.name} (${unit.weight} lb) on layer ${currentLayer + 1}` +
            (o.rot ? ' [rotated]' : '') +
            (o.tipped ? ' [tipped]' : ''),
          note: y <= EPS ? 'floor / heaviest-first' : 'stacked (no overhang, rules ok)',
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
  return { placements, plan, totalWeight, placed, remaining, doorBlocked };
}

/**
 * Utilization term for a packed container. Higher = fuller. Volume fill is the
 * primary component (best physically fills the box); weight fill is a lighter
 * secondary term so, all else equal, the packing that also uses more payload is
 * preferred. Clamped to 0..1 so it composes with the balance terms below.
 */
function fillScore(placements, totalWeight, spec) {
  const usedVol = placements.reduce(
    (s, p) => s + p.dims.l * p.dims.w * p.dims.h,
    0
  );
  const containerVol = spec.length * spec.width * spec.height || 1;
  const volFrac = usedVol / containerVol;
  const weightFrac = spec.payloadLb ? totalWeight / spec.payloadLb : 0;
  return Math.max(0, Math.min(1, volFrac + 0.25 * weightFrac));
}

/**
 * Aggregate scoring weights per strategy. Every component is normalized to
 * 0..1, so `total` is always 0..1 and directly comparable between simulations.
 *
 *   Balanced        -> balance-first: the three axes carry 70% of the score.
 *   Maximize volume -> items + fill dominate; balance only breaks ties.
 *   Fewest          -> item count dominates (cram each box), then fill.
 *
 * Exported so the guideline is easy to tune in one place, mirroring how
 * stats.js exports BALANCE_THRESHOLD.
 */
export const SCORE_WEIGHTS = {
  balanced: { frontBack: 0.25, leftRight: 0.25, floorRoof: 0.20, items: 0.20, fill: 0.10 },
  volume:   { frontBack: 0.10, leftRight: 0.10, floorRoof: 0.10, items: 0.30, fill: 0.40 },
  fewest:   { frontBack: 0.10, leftRight: 0.10, floorRoof: 0.10, items: 0.40, fill: 0.30 },
};

/**
 * Symmetric balance credit for one axis: 1.0 at a perfect 50/50 split, falling
 * linearly to 0.0 when the whole load sits in one half.
 */
function axisBalanceScore(heavierPct) {
  if (heavierPct == null) return 1;
  return Math.max(0, Math.min(1, 1 - (heavierPct - 50) / 50));
}

/**
 * Floor/roof credit, deliberately ASYMMETRIC. A low center of gravity is
 * desirable, so a floor-heavy load earns full marks rather than being penalized
 * for not being 50/50 — the same "floor-heavy is good, roof-heavy is bad"
 * convention stats.js encodes as `badSide: 'roof'`. Credit only falls once mass
 * climbs into the upper half, reaching 0 when everything is roof-side.
 */
function floorRoofScore(roofPct) {
  if (roofPct == null) return 1;
  if (roofPct <= 50) return 1;
  return Math.max(0, Math.min(1, 1 - (roofPct - 50) / 50));
}

/**
 * Score a candidate layout on the four requested parameters — front/back
 * balance, left/right balance, floor/roof balance and number of items — plus a
 * fill term so a beautifully balanced half-empty container can't win.
 *
 * Balance is read from scenarioStats(), the exact same proportional-overlap
 * model the Balance panel shows the user, so the score the engine optimizes and
 * the numbers on screen can never disagree.
 *
 * @param {Array} placements  clean placements (post-balance, as the user gets)
 * @param {string} containerType
 * @param {number} totalWeight
 * @param {number} offered    units presented to this container (for `items`)
 * @param {string} strategy
 * @returns {{ total, components }}
 */
function scoreLayout(placements, containerType, totalWeight, offered, strategy) {
  const spec = getContainer(containerType);
  const weights = SCORE_WEIGHTS[strategy] || SCORE_WEIGHTS.balanced;
  const { balance } = scenarioStats({ containerType, placements });

  const components = {
    frontBack: axisBalanceScore(balance.length.heavierPct),
    leftRight: axisBalanceScore(balance.width.heavierPct),
    floorRoof: floorRoofScore(balance.height ? balance.height.roofPct : null),
    items: offered > 0 ? Math.min(1, placements.length / offered) : 0,
    fill: fillScore(placements, totalWeight, spec),
  };

  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    total += weight * (components[key] || 0);
  }

  // Hard guideline check. stats.js already decides per axis whether the load
  // breaches the BALANCE_THRESHOLD rule of thumb (and correctly treats a
  // floor-heavy load as fine), which is exactly what the Balance panel shows
  // the user as "⚠ Unbalanced load". Reuse those flags so the engine can never
  // propose a layout the UI would immediately flag: each breach multiplies the
  // score down, so a compliant layout beats a non-compliant one essentially
  // every time, while still ranking sensibly if EVERY simulation breaches.
  const breaches = [
    balance.length.over,
    balance.width.over,
    balance.height && balance.height.over,
  ].filter(Boolean).length;
  const penalized = total * Math.pow(THRESHOLD_PENALTY, breaches);

  return {
    total: penalized,
    rawTotal: total,
    breaches,
    components,
    // Carry through the raw percentages so the UI can show WHY this layout won
    // without recomputing stats.
    detail: {
      frontPct: balance.length.frontPct,
      backPct: balance.length.backPct,
      leftPct: balance.width.leftPct,
      rightPct: balance.width.rightPct,
      floorPct: balance.height ? balance.height.floorPct : null,
      roofPct: balance.height ? balance.height.roofPct : null,
      placed: placements.length,
      offered,
    },
  };
}

/**
 * Small deterministic PRNG (mulberry32). Seeded so the same catalog + options
 * always produce the same plan — a planner re-running auto-load must not get a
 * different answer every click.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A randomized arrival order derived from a base ordering: each unit's rank is
 * nudged by up to `strength` positions. Small jitter explores layouts close to
 * the proven heuristic; large jitter explores further afield. Sorting the
 * perturbed keys keeps the ordering a true permutation of the input.
 */
function jitteredOrdering(base, random, strength) {
  return base
    .map((unit, i) => ({ unit, key: i + (random() - 0.5) * 2 * strength }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.unit);
}

/**
 * Run MANY simulations for a single container and return the highest-scoring
 * one. This is the heart of the engine: rather than packing once and presenting
 * the result as good enough, it explores the search space along three
 * independent axes and scores every candidate on front/back balance, left/right
 * balance, floor/roof balance and item count.
 *
 *   1. Arrival order    — the 5 deterministic SEED_ORDERINGS, then randomized
 *                         jitters around the strategy's natural ordering.
 *   2. Orientation bias — upright / flat / tight (see ORIENTATION_BIASES), so
 *                         simulations make genuinely different rotation choices
 *                         instead of replaying one greedy preference.
 *   3. Balance pass      — the winner is scored AFTER balanceLoad() is applied,
 *                         so the score reflects the layout the user receives.
 *
 * Deterministic: the PRNG is seeded from the unit count, so identical inputs
 * always yield an identical plan. Bounded: stops early once `timeBudgetMs` is
 * spent, so a large catalog can never hang the browser.
 *
 * @returns the winning packInto() result (with __item attached) plus
 *          { score, candidatesRun }, or null when nothing could be placed.
 */
function bestFill(units, spec, strategy, options = {}) {
  const order =
    strategy === 'volume'
      ? ['volume', 'footprint', 'tallest', 'heaviest', 'density']
      : strategy === 'fewest'
        ? ['volume', 'density', 'footprint', 'heaviest', 'tallest']
        : ['heaviest', 'density', 'volume', 'footprint', 'tallest']; // balanced

  const simulations = Math.max(1, Math.floor(options.simulations ?? DEFAULT_SIMULATIONS));
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const started = Date.now();
  const random = mulberry32(0x9e3779b9 ^ units.length);
  const offered = units.length;

  // Candidate plans: [orderingFn, orientationBias]. The strategy's natural
  // ordering with the legacy 'upright' bias is always candidate #0, so the
  // engine can never do worse than the old single-shot behavior.
  const candidates = [];
  for (const seedId of order) {
    candidates.push({ units: () => SEED_ORDERINGS[seedId](units), bias: 'upright' });
  }
  // Then the deterministic seeds under the other orientation biases.
  for (const bias of ORIENTATION_BIASES.filter((b) => b !== 'upright')) {
    for (const seedId of order) {
      candidates.push({ units: () => SEED_ORDERINGS[seedId](units), bias });
    }
  }
  // Then randomized jitters around the strategy's primary ordering, cycling
  // through the orientation biases and widening the jitter as we go.
  const primary = SEED_ORDERINGS[order[0]](units);
  for (let i = 0; i < simulations; i++) {
    const bias = ORIENTATION_BIASES[i % ORIENTATION_BIASES.length];
    const strength = 1 + (i / Math.max(1, simulations)) * Math.max(2, offered * 0.25);
    candidates.push({ units: () => jitteredOrdering(primary, random, strength), bias });
  }

  const scored = [];
  let candidatesRun = 0;
  let maxPlaced = 0;

  for (const cand of candidates) {
    // Always evaluate the first candidate so a container is never left empty
    // purely because time ran out; after that, respect both the per-container
    // budget and the run-wide deadline.
    if (candidatesRun > 0 && (
      Date.now() - started > timeBudgetMs ||
      (options.deadline && Date.now() > options.deadline)
    )) break;

    const res = packInto(cand.units(), spec, { ...options, orientationBias: cand.bias });
    candidatesRun += 1;
    if (!res.placements.length) continue;

    // Score the layout the user would actually receive: apply the balance pass
    // to this candidate before measuring it.
    if (strategy === 'balanced') balanceLoad(res.placements, spec);
    const score = scoreLayout(
      res.placements, spec.id, res.totalWeight, offered, strategy
    );

    maxPlaced = Math.max(maxPlaced, res.placements.length);
    scored.push({ ...res, score, orientationBias: cand.bias });
  }

  if (!scored.length) return null;

  // Optional item floor. Balance and item count genuinely trade off: a layout
  // can post a better balance score precisely BY loading less cargo, but those
  // skipped units don't vanish — they roll into the next container and can
  // force an extra one. With a floor set, only layouts loading at least this
  // fraction of the most items any simulation managed may win, which yields a
  // "cram it in" variant of the plan. packAll() builds plans both with and
  // without the floor and lets the whole-plan scorer decide, so neither
  // priority is hard-coded here.
  const itemFloor = options.itemFloor ?? 0;
  const pool = itemFloor > 0
    ? scored.filter((s) => s.placements.length >= maxPlaced * itemFloor)
    : scored;
  const finalPool = pool.length ? pool : scored;

  let best = finalPool[0];
  for (const cand of finalPool) {
    if (cand.score.total > best.score.total) best = cand;
  }

  best.score.simulationsRun = candidatesRun;
  best.score.consideredLayouts = scored.length;
  best.score.maxPlacedFound = maxPlaced;
  best.candidatesRun = candidatesRun;
  return best;
}

/**
 * Pack a catalog into a SINGLE container (backward-compatible entry point).
 * Runs the scored multi-simulation search so overflow is reported as
 * `unplaced`. The balance pass is applied inside bestFill(), so the layout
 * returned here is exactly the one that was scored.
 * @returns { placements, unplaced, plan, stats, score }
 */
export function pack(catalog, containerType, options = {}) {
  const strategy = options.strategy || 'balanced';
  const spec = getContainer(containerType);
  const units = expandUnits(catalog);

  const res =
    bestFill(units, spec, strategy, options) ||
    { placements: [], plan: [], totalWeight: 0, remaining: units, score: null };

  const clean = res.placements.map(({ __item, ...p }) => ({ ...p }));
  const unplaced = res.remaining.map((u) => ({ item: u, reason: unplacedReason(u, spec) }));
  const stats = buildStats(clean, unplaced, spec, res.totalWeight);
  return { placements: clean, unplaced, plan: res.plan, stats, score: res.score || null };
}

/**
 * Build ONE complete multi-container plan: fill a container with the scored
 * simulation search, lock it, repeat with what's left. `simulations` controls
 * how much searching each container does.
 *
 * @returns {{ containers, remaining, simulationsRun }}
 */
function buildPlan(units, spec, strategy, maxContainers, options) {
  let remaining = units;
  const containers = [];
  let simulationsRun = 0;

  let truncated = false;

  while (remaining.length && containers.length < maxContainers) {
    // Respect the run-wide deadline shared by every plan in the ladder, so the
    // total generate time stays bounded no matter how many plans are tried.
    // Bailing out here leaves cargo unpacked, so the plan is marked truncated
    // and can only win if no complete plan was produced at all.
    if (options.deadline && Date.now() > options.deadline) {
      truncated = true;
      break;
    }
    const res = bestFill(remaining, spec, strategy, options);
    if (!res || !res.placements.length) {
      // Nothing left fits even an empty container — stop and stage the rest.
      break;
    }

    simulationsRun += res.candidatesRun || 0;
    const clean = res.placements.map(({ __item, ...p }) => ({ ...p }));
    const stats = buildStats(clean, [], spec, res.totalWeight);
    containers.push({
      containerType: spec.id, placements: clean, plan: res.plan, stats, score: res.score || null,
    });
    remaining = res.remaining;
  }

  return { containers, remaining, simulationsRun, truncated };
}

/**
 * Score a COMPLETE plan, so plans can be compared as wholes rather than
 * container-by-container. Optimizing each container greedily doesn't optimize
 * the shipment: a container that packs itself beautifully can leave an awkward
 * remainder that needs an extra box. This aggregate therefore accounts for:
 *
 *   - mean per-container layout score (the balance + items work)
 *   - total units actually placed across the whole shipment
 *   - container count, penalized, since an extra container is a real cost
 *   - any container that breaches the balance guideline drags the whole plan
 *
 * @returns {{ total, meanLayout, placedFrac, containerCount, breaches }}
 */
function scorePlan(plan, totalUnits) {
  const { containers, remaining } = plan;
  if (!containers.length) return { total: -Infinity, meanLayout: 0, placedFrac: 0, containerCount: 0, breaches: 0 };

  const meanLayout = containers.reduce((s, c) => s + (c.score ? c.score.total : 0), 0) / containers.length;
  const placed = totalUnits - remaining.length;
  const placedFrac = totalUnits > 0 ? placed / totalUnits : 0;
  const breaches = containers.reduce((s, c) => s + (c.score ? c.score.breaches : 0), 0);

  // Placing the cargo is the point, so it carries the most weight; layout
  // quality (the balance + item scoring) follows. Each container beyond the
  // first then costs a flat penalty, so a plan only earns its extra box by
  // placing meaningfully more cargo or being meaningfully better laid out.
  const total =
    0.55 * placedFrac +
    0.45 * meanLayout -
    CONTAINER_COST * (containers.length - 1);

  return { total, meanLayout, placedFrac, containerCount: containers.length, breaches };
}

/**
 * Sequentially best-fill the catalog across as many containers as needed, then
 * pick the best COMPLETE plan.
 *
 * Each pass selects the subset of remaining units that best fills the current
 * (empty) container, "locks" it, then repeats with whatever is left — mirroring
 * a real workflow of packing one container out, sealing it, and starting the
 * next. Units that cannot fit any empty container (e.g. oversized) are reported
 * as `unplaced` once no further progress is possible.
 *
 * Because a locally-perfect container can leave an awkward remainder, several
 * whole plans are built at different search depths and the one with the best
 * aggregate (scorePlan) is returned. This is what makes the result the highest
 * scoring plan overall rather than a chain of locally-greedy choices.
 *
 * @param {Array} catalog   project item catalog (with qtyAvailable)
 * @param {object} options  { strategy?, containerType?, maxContainers?,
 *                            simulations?, timeBudgetMs?, segregateHazmat? }
 * @returns {{ containers, unplaced, summary }}
 *   containers: [{ containerType, placements, plan, stats, score }]
 */
export function packAll(catalog, options = {}) {
  const strategy = options.strategy || 'balanced';
  const containerType = options.containerType || '20STD';
  const maxContainers = Math.max(1, Math.floor(options.maxContainers || 10));
  const spec = getContainer(containerType);
  const requested = Math.max(1, Math.floor(options.simulations ?? DEFAULT_SIMULATIONS));

  const units = expandUnits(catalog);
  const totalUnits = units.length;

  // Build a handful of complete plans at different per-container search depths.
  // Different depths pick different container-1 layouts, which cascades into
  // genuinely different shipments — so the plan-level comparison has real
  // alternatives to choose between rather than re-ranking one chain.
  //
  // The ladder always includes MIN_DEEP_SIMULATIONS. Consolidating cargo into
  // fewer containers only becomes visible once the search is deep enough to
  // find the tighter layout, so without a guaranteed deep rung a low
  // "Simulations" setting could return a 3-container plan when a better
  // 2-container one exists.
  const depths = [...new Set([
    requested,
    Math.max(1, Math.round(requested / 2)),
    requested * 2,
    Math.max(requested, MIN_DEEP_SIMULATIONS),
  ])].sort((a, b) => a - b);

  // Each depth is run twice: once letting balance win freely (floor 0), and
  // once requiring each container to be packed nearly as full as anything the
  // search found (ITEM_FLOOR). The first favors beautifully balanced loads, the
  // second favors consolidating into fewer containers — and only the whole-plan
  // score decides which is actually better for the shipment in hand.
  const floors = [0, ITEM_FLOOR];

  let bestPlan = null;
  let bestPlanScore = null;
  let simulationsRun = 0;
  let plansEvaluated = 0;

  // One wall-clock deadline for the ENTIRE run, shared by every plan and every
  // simulation. The ladder runs SHALLOWEST-first: a shallow plan is cheap and
  // therefore always completes, guaranteeing that a full plan covering all the
  // cargo exists before any expensive deep search begins. Ordering it the other
  // way round lets one deep plan eat the whole budget and strand most of the
  // inventory in the staging area.
  const deadline = Date.now() + (options.totalTimeBudgetMs ?? DEFAULT_TOTAL_TIME_BUDGET_MS);
  const ladder = [];
  for (const depth of depths) {
    for (const itemFloor of floors) ladder.push({ depth, itemFloor });
  }

  for (const { depth, itemFloor } of ladder) {
    // Always build the first plan; afterwards stop as soon as time is up.
    if (plansEvaluated > 0 && Date.now() > deadline) break;

    const plan = buildPlan(units, spec, strategy, maxContainers, {
      ...options, simulations: depth, itemFloor, deadline,
    });
    simulationsRun += plan.simulationsRun;
    if (!plan.containers.length) continue;
    plansEvaluated += 1;

    const planScore = scorePlan(plan, totalUnits);

    // A plan abandoned mid-fill has cargo sitting in staging purely because
    // time ran out — never present that over a plan that actually finished.
    // Complete plans always outrank truncated ones; among equals, score wins.
    const better = !bestPlanScore
      || (bestPlan.truncated && !plan.truncated)
      || (bestPlan.truncated === plan.truncated && planScore.total > bestPlanScore.total);
    if (better) {
      bestPlan = plan;
      bestPlanScore = planScore;
    }
  }

  const containers = bestPlan ? bestPlan.containers : [];
  const remaining = bestPlan ? bestPlan.remaining : units;
  const unplaced = [];

  for (const u of remaining) unplaced.push({ item: u, reason: unplacedReason(u, spec) });

  // Items staged specifically because they can't clear the door jambs — these
  // will never load into this container type, so the UI calls them out
  // separately from items that merely ran out of room.
  const doorBlockedUnits = unplaced.filter((u) => u.reason === 'door').length;

  return {
    containers,
    unplaced,
    summary: {
      containerCount: containers.length,
      totalUnits,
      placedUnits: totalUnits - unplaced.length,
      unplacedUnits: unplaced.length,
      doorBlockedUnits,
      cappedByMax: remaining.length > 0 && containers.length >= maxContainers,
      // How much searching was done, and how the winning plan scored.
      // `bestScore` is the mean per-container layout score (the balance + item
      // metrics) so it reads as "how good are these loads"; `planScore` is the
      // whole-shipment aggregate the plan was actually selected on.
      simulationsRun,
      plansEvaluated,
      bestScore: bestPlanScore ? bestPlanScore.meanLayout : 0,
      planScore: bestPlanScore ? bestPlanScore.total : 0,
      balanceBreaches: bestPlanScore ? bestPlanScore.breaches : 0,
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

  // Stacking rules for anything resting above the floor. A slot can be
  // carried by more than one base (multi-support), so every base under its
  // footprint — not just the first match — must accept `unit` on top.
  if (slot.y > EPS) {
    const below = placements.filter(
      (p) =>
        p !== slot &&
        Math.abs(p.y + p.dims.h - slot.y) <= Math.max(1e-4, EPS) &&
        intersectsXZ(p, slot.x, slot.z, slot.dims.l, slot.dims.w)
    );
    if (!below.every((p) => canStack(unit, p.__item))) return false;
  }

  // Anything resting on this slot must still be allowed to sit on `unit`.
  const above = placements.filter(
    (p) =>
      p !== slot &&
      Math.abs(slot.y + slot.dims.h - p.y) <= Math.max(1e-4, EPS) &&
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

// How many RANDOMIZED simulations each container runs, on top of the
// deterministic seed orderings × orientation biases. More simulations explore
// more layouts (better scores) at a linear CPU cost — all synchronous in the
// browser, hence the companion time budget below.
export const DEFAULT_SIMULATIONS = 16;

// Wall-clock ceiling per container for the simulation search. Once exceeded,
// the search stops early and returns the best layout found so far, so a large
// catalog degrades gracefully instead of freezing the tab.
export const DEFAULT_TIME_BUDGET_MS = 1200;

// Wall-clock ceiling for an ENTIRE auto-load run: every plan in the ladder,
// every container, every simulation. This is the number that actually bounds
// how long the user waits after clicking Generate, so it's the important one.
// The search degrades gracefully — it keeps the best complete plan found so
// far — rather than blocking the page.
export const DEFAULT_TOTAL_TIME_BUDGET_MS = 4000;

// Multiplier applied to a layout's aggregate score for EACH axis that breaches
// the BALANCE_THRESHOLD guideline (>60% of weight in one half). A layout that
// the Balance panel would flag with a red "⚠ Unbalanced load" warning should
// never be proposed just because it scored well elsewhere, so a breach costs a
// large, compounding fraction of the score rather than a few points.
export const THRESHOLD_PENALTY = 0.55;

// Score cost of each container beyond the first, applied when comparing whole
// plans. Shipping an extra box is expensive in the real world, so a plan must
// gain more than this in cargo placed / layout quality to justify one.
export const CONTAINER_COST = 0.06;

// The "cram it in" item floor used by one half of the plan ladder: a container
// layout must load at least this fraction of the most items any simulation
// achieved to be eligible. Used to generate consolidation-oriented plans that
// are then compared, as whole plans, against the balance-oriented ones.
export const ITEM_FLOOR = 0.95;

// The plan ladder always evaluates at least one run at this search depth, even
// if the user asked for fewer simulations. Consolidating a shipment into fewer
// containers is often only discoverable with a deeper search, and quietly
// shipping an extra container is a much worse outcome than a slightly longer
// generate. The per-container time budget still bounds the total work.
export const MIN_DEEP_SIMULATIONS = 60;
