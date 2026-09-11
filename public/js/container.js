// Standard ISO container specifications.
// Internal dimensions given in inches (from feet+inches), and payload/tare in lb.
// Scene units = feet.
//
// DOOR / JAMB OPENINGS
// Every type also declares its clear `openings` — the actual hole cargo has to
// pass through, measured between the door jambs and under the header. These are
// always SMALLER than the internal cross-section (a container is a few inches
// taller inside than the door it's loaded through), and that difference is the
// constraint planners keep getting caught by. The `face` names match the six
// boundary names used by SceneManager.rebuildBoundaryPlanes() so geometry,
// validation and reporting all share one vocabulary:
//   'front' -> x = 0      'back'  -> x = length
//   'left'  -> z = 0      'right' -> z = width
// An opening is centered on its face and rises from `sill` (0 = floor level).

function ftIn(feet, inches) {
  return feet + inches / 12;
}

export const CONTAINER_TYPES = {
  '20STD': {
    id: '20STD',
    name: "20' Standard",
    // Internal ~ 19'4" L x 7'8" W x 7'10" H
    length: ftIn(19, 4.25),
    width: ftIn(7, 8.5),
    height: ftIn(7, 10.25),
    payloadLb: 47900,
    tareLb: 4916,
    // End doors 7'8" x 7'5" clear: ~5.25" of headroom is lost to the header.
    openings: [{
      id: 'end', label: 'End doors', face: 'back',
      width: ftIn(7, 8), height: ftIn(7, 5), sill: 0,
    }],
  },
  '40STD': {
    id: '40STD',
    name: "40' Standard",
    // Internal ~ 39'5" L x 7'8" W x 7'10" H
    length: ftIn(39, 5.5),
    width: ftIn(7, 8.5),
    height: ftIn(7, 10.25),
    payloadLb: 58860,
    tareLb: 8159,
    // Same end-door opening as the 20' Standard.
    openings: [{
      id: 'end', label: 'End doors', face: 'back',
      width: ftIn(7, 8), height: ftIn(7, 5), sill: 0,
    }],
  },
  '40HC': {
    id: '40HC',
    name: "40' High Cube",
    // Internal ~ 39'5" L x 7'8" W x 8'10" H
    length: ftIn(39, 5.5),
    width: ftIn(7, 8.5),
    height: ftIn(8, 10.25),
    payloadLb: 58860,
    tareLb: 8747,
    // Taller end doors 7'8" x 8'5" clear — still ~5.25" lost to the header.
    openings: [{
      id: 'end', label: 'End doors', face: 'back',
      width: ftIn(7, 8), height: ftIn(8, 5), sill: 0,
    }],
  },
  '40SL': {
    id: '40SL',
    name: "40' Side-Load",
    // Standard 40' footprint (same L x W as 40' Standard / High Cube), 8'0" internal height
    // Internal ~ 39'5" L x 7'8" W x 8'0" H
    length: ftIn(39, 5.5),
    width: ftIn(7, 8.5),
    height: ftIn(8, 0),
    payloadLb: 52910,
    tareLb: 14290,
    // Side opening ONLY — this unit has no usable end doors. The full-length
    // 39'0" x 7'5" opening means length is effectively unconstrained for
    // loading, but it loses ~7" of headroom to the header (8'0" internal vs.
    // 7'5" clear) — the worst header loss of any type here.
    openings: [{
      id: 'side', label: 'Side opening', face: 'right',
      width: ftIn(39, 0), height: ftIn(7, 5), sill: 0,
    }],
  },
};

/** Clear door/jamb openings for a container spec (always an array). */
export function getOpenings(spec) {
  return (spec && spec.openings) || [];
}

/**
 * Resolve an opening to its rectangle in scene coordinates, centered on its
 * face. Returns the span along each axis plus which axis cargo travels through:
 *
 *   axis    'x' for an end (front/back) opening, 'z' for a side opening
 *   spanLo/spanHi   the opening's extent along the face's horizontal axis
 *   yLo/yHi         the opening's vertical extent (sill .. sill + height)
 *   plane           the coordinate of the face along `axis`
 *   inward          +1 or -1: the direction cargo moves entering the container
 *
 * `spanLo/spanHi` are measured along z for an end opening (across the
 * container's width) and along x for a side opening (along its length).
 */
export function openingBounds(spec, opening) {
  const endFace = opening.face === 'front' || opening.face === 'back';
  const axis = endFace ? 'x' : 'z';
  // The face's horizontal axis runs across the OTHER horizontal dimension.
  const faceSpan = endFace ? spec.width : spec.length;
  const width = Math.min(opening.width, faceSpan);
  const center = faceSpan / 2;
  const sill = opening.sill || 0;
  const plane = opening.face === 'front' || opening.face === 'left'
    ? 0
    : endFace ? spec.length : spec.width;
  // Entering cargo always travels away from the face it came through.
  const inward = plane === 0 ? 1 : -1;
  return {
    axis,
    plane,
    inward,
    spanLo: center - width / 2,
    spanHi: center + width / 2,
    yLo: sill,
    yHi: Math.min(sill + opening.height, spec.height),
    width,
    height: Math.min(opening.height, spec.height - sill),
  };
}

export function getContainer(id) {
  return CONTAINER_TYPES[id] || CONTAINER_TYPES['20STD'];
}

/** Format decimal feet as feet + inches, e.g. 19.35 -> 19' 4" */
export function fmtFeet(value) {
  const ft = Math.floor(value);
  const inch = Math.round((value - ft) * 12);
  if (inch === 12) return `${ft + 1}' 0"`;
  return `${ft}' ${inch}"`;
}

/** Format a value stored in feet as whole inches, e.g. 4 -> 48" */
export function fmtInches(value) {
  return `${Math.round(value * 12)}"`;
}
