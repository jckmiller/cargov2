// Compute real-time statistics for a scenario.
import { getContainer } from './container.js';

// Rule-of-thumb balance threshold: no more than this % of total cargo weight
// should occupy one half (50%) of the container along a given axis.
// This is a widely used freight/forwarder convention rather than a codified
// regulation — the underlying standards (e.g. the IMO/ILO/UNECE CTU Code)
// focus on keeping the center of gravity near the geometric center. We surface
// both: the heavier-half % (against this threshold) and the CoG offset.
// Kept as a single exported constant so the guideline is easy to tune.
export const BALANCE_THRESHOLD = 60;

// Number of segments each floor axis is divided into for the incremental weight
// distribution profile. Weight is spread across these bins in proportion to how
// much of each item's footprint overlaps each bin (a uniform-density model),
// rather than snapping the whole item into one half. Length gets more bins
// because the container is much longer than it is wide.
export const BALANCE_BINS_LENGTH = 16;
export const BALANCE_BINS_WIDTH = 6;

/**
 * Distribute a weight spanning [start, end] (in feet) across `binCount` equal
 * bins covering [0, dimension], proportional to the overlap length between the
 * span and each bin. Returns an array of per-bin weight contributions. The span
 * is clamped to the container; a zero-length span deposits its full weight into
 * the single bin its center falls in (so point-like items still register).
 */
function distributeToBins(bins, start, end, dimension, weight, binCount) {
  if (weight <= 0 || dimension <= 0) return;
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(dimension, Math.max(start, end));
  const binSize = dimension / binCount;
  const span = hi - lo;

  if (span <= 0) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor(lo / binSize)));
    bins[idx] += weight;
    return;
  }

  for (let i = 0; i < binCount; i++) {
    const binLo = i * binSize;
    const binHi = binLo + binSize;
    const overlap = Math.min(hi, binHi) - Math.max(lo, binLo);
    if (overlap > 0) bins[i] += weight * (overlap / span);
  }
}

/**
 * Split `weight` across the two halves of [0, dimension] divided at its center,
 * proportional to how much of the span [start, end] lies on each side. Returns
 * { neg, pos } where `neg` is the portion in [0, mid) and `pos` is the portion
 * in [mid, dimension]. This mirrors the proportional-overlap model used for the
 * histogram bins, so an item straddling the centerline contributes to both
 * halves rather than having its whole weight snapped to the side its center
 * happens to land on. A zero-length span (point-like item) is assigned entirely
 * to the side its point falls on.
 */
function splitAtMid(start, end, dimension, weight) {
  if (weight <= 0 || dimension <= 0) return { neg: 0, pos: 0 };
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(dimension, Math.max(start, end));
  const mid = dimension / 2;
  const span = hi - lo;

  if (span <= 0) {
    return lo < mid ? { neg: weight, pos: 0 } : { neg: 0, pos: weight };
  }

  const negOverlap = Math.max(0, Math.min(hi, mid) - lo);
  const negPortion = negOverlap / span;
  const neg = weight * negPortion;
  return { neg, pos: weight - neg };
}

export function scenarioStats(scenario) {
  const spec = getContainer(scenario.containerType);
  const placements = scenario.placements || [];

  let totalWeight = 0;
  let usedVolume = 0;
  const byCategory = {};
  let hazmatCount = 0;

  // Balance accumulators. Half-weight totals are split proportionally at each
  // axis centerline (see splitAtMid); CoG sums are weighted by item center.
  let frontWeight = 0; // portion toward the front half (x < length/2)
  let backWeight = 0;  // portion toward the back half  (x >= length/2)
  let leftWeight = 0;  // portion toward the left half  (z < width/2)
  let rightWeight = 0; // portion toward the right half (z >= width/2)
  let cogXSum = 0;     // Σ(weight · centerX)
  let cogZSum = 0;     // Σ(weight · centerZ)

  // Incremental weight profile: weight spread across floor segments in
  // proportion to each item's footprint overlap, so the distribution reflects
  // where mass physically sits rather than snapping into halves.
  const lengthBins = new Array(BALANCE_BINS_LENGTH).fill(0);
  const widthBins = new Array(BALANCE_BINS_WIDTH).fill(0);

  for (const p of placements) {
    const w = p.weight || 0;
    totalWeight += w;
    const d = p.dims || { l: 0, w: 0, h: 0 };
    usedVolume += d.l * d.w * d.h;
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    if (p.hazmatClass && p.hazmatClass !== 'none') hazmatCount += 1;

    // Positions are stored as the min corner, in feet.
    const x0 = p.x || 0;
    const z0 = p.z || 0;

    // Half-weight totals use the same proportional-overlap model as the
    // histogram bins: an item straddling the centerline contributes to both
    // halves in proportion to its footprint, rather than snapping its whole
    // weight onto whichever half its center lands in. This keeps the L/R and
    // F/B percentages consistent with the histogram (a balanced load reads
    // ~50/50 instead of 0/100 when items span the centerline).
    const lengthSplit = splitAtMid(x0, x0 + (d.l || 0), spec.length, w);
    frontWeight += lengthSplit.neg;
    backWeight += lengthSplit.pos;
    const widthSplit = splitAtMid(z0, z0 + (d.w || 0), spec.width, w);
    leftWeight += widthSplit.neg;
    rightWeight += widthSplit.pos;

    // Center of gravity uses each item's center (min corner + half-dimension).
    const cx = x0 + (d.l || 0) / 2;
    const cz = z0 + (d.w || 0) / 2;
    cogXSum += w * cx;
    cogZSum += w * cz;

    // Spread this item's weight across the bins its footprint spans.
    distributeToBins(lengthBins, x0, x0 + (d.l || 0), spec.length, w, BALANCE_BINS_LENGTH);
    distributeToBins(widthBins, z0, z0 + (d.w || 0), spec.width, w, BALANCE_BINS_WIDTH);
  }

  const containerVolume = spec.length * spec.width * spec.height;
  const balance = computeBalance({
    totalWeight,
    frontWeight, backWeight, leftWeight, rightWeight,
    cogXSum, cogZSum,
    lengthBins, widthBins,
    length: spec.length, width: spec.width,
  });

  return {
    container: spec,
    itemCount: placements.length,
    totalWeight,
    payloadLb: spec.payloadLb,
    weightPct: spec.payloadLb ? (totalWeight / spec.payloadLb) * 100 : 0,
    overweight: totalWeight > spec.payloadLb,
    usedVolume,
    containerVolume,
    volumePct: containerVolume ? (usedVolume / containerVolume) * 100 : 0,
    byCategory,
    hazmatCount,
    balance,
  };
}

/**
 * Build the balance indicator model for both axes.
 * cogOffsetPct is the signed CoG distance from center as a % of the dimension:
 * positive = toward back (length) / right (width), negative = front / left.
 */
function computeBalance({ totalWeight, frontWeight, backWeight, leftWeight, rightWeight, cogXSum, cogZSum, lengthBins, widthBins, length, width }) {
  const hasWeight = totalWeight > 0;

  // Per-bin weight as a % of the total load, front→back / left→right.
  const toPctBins = (bins) =>
    hasWeight ? bins.map((w) => (w / totalWeight) * 100) : bins.map(() => 0);

  const axis = (aWeight, bWeight, cogSum, dimension, negSide, posSide) => {
    if (!hasWeight) {
      return {
        aPct: 50, bPct: 50, heavierPct: 50,
        heavierSide: null, cogOffsetPct: 0, over: false,
      };
    }
    const aPct = (aWeight / totalWeight) * 100;
    const bPct = (bWeight / totalWeight) * 100;
    const heavierPct = Math.max(aPct, bPct);
    const heavierSide = aPct === bPct ? null : (aPct > bPct ? negSide : posSide);
    // CoG relative to center, normalized to [-1, 1] then to %.
    const cog = cogSum / totalWeight;         // in feet from the 0 end
    const cogOffsetPct = dimension ? ((cog - dimension / 2) / (dimension / 2)) * 100 : 0;
    return {
      aPct, bPct, heavierPct, heavierSide,
      cogOffsetPct,
      over: heavierPct > BALANCE_THRESHOLD,
    };
  };

  const lengthAxis = axis(frontWeight, backWeight, cogXSum, length, 'front', 'back');
  const widthAxis = axis(leftWeight, rightWeight, cogZSum, width, 'left', 'right');

  return {
    threshold: BALANCE_THRESHOLD,
    hasWeight,
    length: {
      frontPct: lengthAxis.aPct,
      backPct: lengthAxis.bPct,
      heavierPct: lengthAxis.heavierPct,
      heavierSide: lengthAxis.heavierSide,
      cogOffsetPct: lengthAxis.cogOffsetPct,
      over: lengthAxis.over,
      bins: toPctBins(lengthBins),
    },
    width: {
      leftPct: widthAxis.aPct,
      rightPct: widthAxis.bPct,
      heavierPct: widthAxis.heavierPct,
      heavierSide: widthAxis.heavierSide,
      cogOffsetPct: widthAxis.cogOffsetPct,
      over: widthAxis.over,
      bins: toPctBins(widthBins),
    },
  };
}

export function fmtLb(n) {
  return `${Math.round(n).toLocaleString()} lb`;
}
export function fmtPct(n) {
  return `${n.toFixed(1)}%`;
}
export function fmtFt3(n) {
  return `${n.toFixed(1)} ft³`;
}
