// Standard ISO container specifications.
// Internal dimensions given in inches (from feet+inches), and payload/tare in lb.
// Scene units = feet.

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
  },
};

export function getContainer(id) {
  return CONTAINER_TYPES[id] || CONTAINER_TYPES['20STD'];
}

export function containerVolumeFt3(spec) {
  return spec.length * spec.width * spec.height;
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
