// Central application state store with a tiny pub/sub.
import { uid } from './cargo.js';

const listeners = new Set();

export const state = {
  user: null,
  token: null,
  // Active project: { id?, name, visibility, viewers[], catalog[], scenarios[] }
  project: null,
  activeScenarioId: null,
  selectedPlacementId: null,
  labelsVisible: false,
  dirty: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

export function markDirty() {
  state.dirty = true;
}

/** Create an empty project scaffold. */
export function newProject(name = 'Untitled Project') {
  const scenario = makeScenario('Scenario 1');
  return {
    id: null,
    name,
    visibility: 'restricted',
    viewers: [],
    catalog: [],
    scenarios: [scenario],
  };
}

export function makeScenario(name = 'New Scenario', containerType = '20STD') {
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

export function setProject(project) {
  state.project = project;
  state.activeScenarioId = project?.scenarios?.[0]?.id || null;
  state.selectedPlacementId = null;
  state.dirty = false;
  emit();
}
