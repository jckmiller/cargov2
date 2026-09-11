// Central application state. Controllers explicitly refresh affected views.
import { uid } from './cargo.js';

export const state = {
  user: null,
  token: null,
  // Active project: { id?, name, visibility, viewers[], catalog[], scenarios[] }
  project: null,
  activeScenarioId: null,
  // Primary selection — the most-recently clicked item. Drives edit/details,
  // rotate/tip, and the "primary" highlight. Kept in sync with the set below.
  selectedPlacementId: null,
  // Multi-selection set. Items here move/nudge/delete together as one unit.
  // Always includes selectedPlacementId when a primary exists.
  selectedPlacementIds: [],
  labelsVisible: true,
  // Show remaining (unplaced) catalog items laid out beside the container so
  // the user can preview what's next to load. An item drops out of this
  // layout the moment a unit of it is placed into the active container.
  pendingViewVisible: false,
  // Snap dragged/nudged items to the 1" viewer grid (see cargo.js GRID_SIZE_FT).
  snapToGridEnabled: true,
  // Show the door/jamb overlay: the clear opening, the blocked jamb/header
  // area, and the entry envelope reachable through it. On by default — a
  // narrowed entry is a real constraint the planner needs to see.
  openingsVisible: true,
  dirty: false,
  editRevision: 0,
};

/**
 * Replace the current selection. Pass an array (multi-select) or a single id
 * (or null to clear). The first id is treated as the primary selection.
 */
export function setSelection(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : ids ? [ids] : [];
  // De-duplicate while preserving order.
  state.selectedPlacementIds = [...new Set(list)];
  state.selectedPlacementId = state.selectedPlacementIds[0] || null;
}

/**
 * Toggle a single id in the multi-selection. Adds it (and makes it primary)
 * when absent; removes it when present. Returns the resulting set.
 */
export function toggleSelection(id) {
  if (!id) return state.selectedPlacementIds;
  const set = state.selectedPlacementIds;
  if (set.includes(id)) {
    setSelection(set.filter((x) => x !== id));
  } else {
    // New id becomes primary (first in the list).
    setSelection([id, ...set]);
  }
  return state.selectedPlacementIds;
}

/** Clear all selection state. */
export function clearSelection() {
  setSelection([]);
}

export function markDirty() {
  state.dirty = true;
  state.editRevision += 1;
  const scenario = activeScenario();
  if (scenario) delete scenario.loadScore;
}

/** Create an empty project scaffold. */
export function newProject(name = 'Untitled Project') {
  const scenario = makeScenario('Container 1');
  return {
    id: null,
    name,
    visibility: 'restricted',
    viewers: [],
    catalog: [],
    staging: [],
    scenarios: [scenario],
  };
}

export function makeScenario(name = 'New Container', containerType = '20STD') {
  return {
    id: uid('scn'),
    name,
    containerType,
    placements: [], // { id, catalogItemId, x, y, z, rot: {l,w,h} , name, category, hazmatClass, weight, color }
    generatedBy: 'manual',
  };
}

export function activeScenario() {
  if (!state.project) return null;
  return (
    state.project.scenarios.find((s) => s.id === state.activeScenarioId) ||
    state.project.scenarios[0] ||
    null
  );
}

export function catalogItem(id) {
  if (!state.project) return null;
  return state.project.catalog.find((c) => c.id === id) || null;
}

/**
 * Count how many units of a catalog item are placed across ALL container
 * loadings (the shared shipment). Only live placements consume inventory —
 * staged items do not count (they've been pulled back out of the shipment).
 * When `excludeContainerId` is given, that container's placements are ignored
 * (useful when previewing a move/replace).
 */
export function placedQty(catalogItemId, excludeContainerId = null) {
  if (!state.project || !catalogItemId) return 0;
  let n = 0;
  for (const s of state.project.scenarios) {
    if (excludeContainerId && s.id === excludeContainerId) continue;
    for (const p of s.placements || []) {
      if (p.catalogItemId === catalogItemId) n += 1;
    }
  }
  return n;
}

/**
 * Remaining (unshipped) quantity of a catalog item: its available total minus
 * the units already placed into container loadings across the whole shipment.
 * Never returns a negative number.
 */
export function remainingQty(catalogItemId) {
  const item = catalogItem(catalogItemId);
  if (!item) return 0;
  const total = Math.max(0, Math.floor(item.qtyAvailable || 0));
  return Math.max(0, total - placedQty(catalogItemId));
}

export function setProject(project) {
  state.project = project;
  if (project) project.staging ||= [];
  state.activeScenarioId = project?.scenarios?.[0]?.id || null;
  state.selectedPlacementId = null;
  state.selectedPlacementIds = [];
  state.dirty = false;
  state.editRevision += 1;
}
