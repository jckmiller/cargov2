// App entry point: authentication, wiring, and the main controller.
import { api, loadToken, saveToken } from './api.js';
import {
  state, setProject as setStoreProject, newProject, makeScenario, activeScenario, catalogItem, markDirty,
  setSelection, toggleSelection, clearSelection, remainingQty, placedQty,
} from './store.js';
import { SceneManager } from './scene.js';
import { Interaction } from './interaction.js';
import { getContainer, CONTAINER_TYPES } from './container.js';
import { makeCatalogItem, uid, itemColor, findFreePlacementAnyOrientation, layoutError } from './cargo.js';
import { createProjectSaver } from './persistence.js';
import { validateProjectData } from './projectValidation.js';
import { startPacking } from './packingJob.js';
import { presetToCatalogItem, deleteCustomPreset } from './library.js';
import {
  renderScenarios, renderCatalog, renderLibrary, renderStats, renderStaging, renderClearances,
} from './panels.js';
import { MeasureTool } from './measure.js';
import { el, toast, openModal, confirmDialog, makeCollapsible } from './ui.js';
import { itemForm, autoloadForm, loadPlanModal, manifestModal, compareModal, catalogImportForm, shortcutsModal } from './forms.js';
import { projectsDialog, newProjectDialog, usersDialog } from './dialogs.js';
import { downloadPNG } from './reporting.js';
import { exportProjectJSON, importProjectJSON } from './io.js';

let sm = null; // SceneManager
let interaction = null;
let measure = null; // MeasureTool
let staging = []; // reference to the active project's staging array
const persistProject = createProjectSaver(state, api);
function setProject(project) {
  setStoreProject(project);
  staging = project.staging;
}
function mayDiscardChanges() {
  return !state.dirty || window.confirm('Discard unsaved changes? Cancel to save or export them first.');
}
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Theme (defaults to day/light, persisted) ----------
const THEME_KEY = 'a3_theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  if (sm) sm.setThemeBackground();
}
function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
}
// Apply persisted theme before login so the whole app matches immediately.
initTheme();

// ---------- Snap-to-grid (1", persisted) ----------
const SNAP_KEY = 'a3_snap_grid';
function initSnapToGrid() {
  const saved = localStorage.getItem(SNAP_KEY);
  state.snapToGridEnabled = saved == null ? true : saved === '1';
}
initSnapToGrid();

// ---------- Door/jamb overlay (on by default, persisted) ----------
const OPENINGS_KEY = 'a3_show_openings';
function initOpenings() {
  const saved = localStorage.getItem(OPENINGS_KEY);
  state.openingsVisible = saved == null ? true : saved === '1';
}
initOpenings();

// ---------- Auth ----------
const loginOverlay = document.getElementById('login-overlay');
const appEl = document.getElementById('app');

async function tryResumeSession() {
  const token = loadToken();
  if (!token) return false;
  state.token = token;
  try {
    const { user } = await api.me();
    state.user = user;
    return true;
  } catch {
    saveToken(null);
    state.token = null;
    return false;
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const { token, user } = await api.login(username, password);
    saveToken(token);
    state.token = token;
    state.user = user;
    enterApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  if (!mayDiscardChanges()) return;
  state.dirty = false;
  saveToken(null);
  state.token = null;
  state.user = null;
  location.reload();
});

function enterApp() {
  loginOverlay.classList.add('hidden');
  appEl.classList.remove('hidden');

  document.getElementById('user-badge').textContent = state.user.role;
  if (state.user.role === 'admin') {
    document.getElementById('btn-admin').classList.remove('hidden');
  }

  initScene();
  wireToolbar();
  wireTopbar();
  wireCollapse();
  applyTheme(document.documentElement.getAttribute('data-theme')); // sync glyph + scene bg

  // Start with a fresh local project.
  setProject(newProject('My First Project'));
  renderAll();
  toast(`Welcome, ${state.user.username}`, 'ok');
}

// ---------- Collapse: panels + whole sidebars ----------
function resizeSceneSoon() {
  // Resize during and after the layout/grid transition so the canvas re-fits.
  const iv = setInterval(() => sm && sm.resize(), 30);
  setTimeout(() => clearInterval(iv), 340);
}

function wireCollapse() {
  // Individual panels.
  document.querySelectorAll('.panel[data-panel]').forEach((panel) => {
    makeCollapsible(panel, panel.dataset.panel, resizeSceneSoon);
  });

  // Whole sidebars.
  const layout = document.querySelector('.layout');
  const LKEY = 'a3_sidebar_left';
  const RKEY = 'a3_sidebar_right';
  const applySidebar = (side, collapsed) => {
    layout.classList.toggle(`${side}-collapsed`, collapsed);
    const btn = document.getElementById(`toggle-${side}`);
    if (btn) btn.textContent = side === 'left'
      ? (collapsed ? '›' : '‹')
      : (collapsed ? '‹' : '›');
    localStorage.setItem(side === 'left' ? LKEY : RKEY, collapsed ? '1' : '0');
    resizeSceneSoon();
  };
  // Restore persisted sidebar state.
  applySidebar('left', localStorage.getItem(LKEY) === '1');
  applySidebar('right', localStorage.getItem(RKEY) === '1');

  document.getElementById('toggle-left').addEventListener('click', () => {
    applySidebar('left', !layout.classList.contains('left-collapsed'));
  });
  document.getElementById('toggle-right').addEventListener('click', () => {
    applySidebar('right', !layout.classList.contains('right-collapsed'));
  });
}

// ---------- Scene ----------
function initScene() {
  const containerEl = document.getElementById('canvas-container');
  sm = new SceneManager(containerEl);

  // Populate container select.
  const sel = document.getElementById('container-select');
  sel.innerHTML = '';
  for (const c of Object.values(CONTAINER_TYPES)) {
    sel.appendChild(el('option', { value: c.id, text: c.name }));
  }
  sel.addEventListener('change', () => {
    const scn = activeScenario();
    if (!scn) return;
    const error = layoutError(scn.placements, getContainer(sel.value), catalogItem);
    if (error) { toast(error, 'warn'); sel.value = scn.containerType; return; }
    scn.containerType = sel.value;
    markDirty();
    refreshScene();
    renderAll();
  });

  interaction = new Interaction(sm, {
    onSelect: (id, opts = {}) => {
      if (opts.toggle) toggleSelection(id);
      else setSelection(id);
      sm.syncPlacements(activeScenario().placements, state.selectedPlacementIds);
      updateNudgePad();
      renderClearances(selectedPlacementForClearances(), getContainer(activeScenario().containerType));
    },
    onChange: () => {
      markDirty();
      renderStats(activeScenario());
      renderScenarios(state.project, state.activeScenarioId, scenarioHandlers());
      renderClearances(selectedPlacementForClearances(), getContainer(activeScenario().containerType));
    },
    onEdit: (id) => editPlacement(id),
    onDetails: (id) => showDetails(id),
    onDelete: (id) => removePlacement(id),
    onToggleLabels: () => toggleLabels(),
    onTogglePending: () => togglePendingView(),
    onToggleSnap: () => toggleSnapToGrid(),
    onToggleOpenings: () => toggleOpenings(),
    getContainerSpec: () => getContainer(activeScenario().containerType),
    getSelectedId: () => state.selectedPlacementId,
    getSelectedIds: () => state.selectedPlacementIds,
    getSnapEnabled: () => state.snapToGridEnabled,
    isMeasuring: () => measure && measure.isActive(),
  });

  measure = new MeasureTool(sm);
}

function refreshScene() {
  const scn = activeScenario();
  if (!scn) return;
  const spec = getContainer(scn.containerType);
  sm.setContainer(scn.containerType);
  sm.clearCargo();
  sm.setLabelsVisible(state.labelsVisible);
  // setContainer() rebuilds the door-jamb overlay, so reapply the user's
  // chosen visibility after every refresh.
  sm.setOpeningsVisible(state.openingsVisible);
  sm.syncPlacements(scn.placements, state.selectedPlacementIds);
  sm.setPendingVisible(state.pendingViewVisible);
  if (state.pendingViewVisible) sm.setPendingItems(pendingItemsList(), spec);
  const sel = document.getElementById('container-select');
  sel.value = scn.containerType;
}

/**
 * Build the "Pending Items" staging list: one entry per unplaced unit,
 * across the whole catalog's remaining inventory. Placing a unit into any
 * container reduces its remaining qty, so it drops out of this list — and
 * the layout beside the container — on the next refresh.
 */
function pendingItemsList() {
  const p = state.project;
  if (!p) return [];
  const out = [];
  for (const it of p.catalog) {
    const remaining = remainingQty(it.id);
    for (let i = 0; i < remaining; i++) {
      out.push({
        name: it.name,
        color: itemColor(it),
        dims: { l: it.length, w: it.width, h: it.height },
      });
    }
  }
  return out;
}

function appendCatalogItems(items) {
  validateProjectData({ ...state.project, catalog: [...state.project.catalog, ...items] });
  state.project.catalog.push(...items);
  markDirty();
  renderAll();
}

function renderAll() {
  const p = state.project;
  if (!p) return;
  document.getElementById('active-project-name').textContent =
    p.name + (state.dirty ? ' *' : '') + (p.id ? '' : ' (unsaved)');
  renderScenarios(p, state.activeScenarioId, scenarioHandlers());
  renderCatalog(p, catalogHandlers(), activeScenario());
  renderLibrary(libraryHandlers());
  renderStats(activeScenario());
  renderClearances(selectedPlacementForClearances(), getContainer(activeScenario().containerType));
  renderStaging(staging, stagingHandlers());
  refreshScene();
  updateNudgePad();
}

/**
 * The single selected placement to show in the Clearances panel, or null
 * when nothing (or more than one item) is selected — clearances only make
 * sense for one item at a time.
 */
function selectedPlacementForClearances() {
  if (state.selectedPlacementIds.length !== 1) return null;
  const scn = activeScenario();
  return scn?.placements.find((p) => p.id === state.selectedPlacementIds[0]) || null;
}

// Enable the fine-tune "Move" pad only when an item is selected.
function updateNudgePad() {
  const pad = document.getElementById('nudge-pad');
  if (!pad) return;
  const enabled = state.selectedPlacementIds.length > 0;
  pad.classList.toggle('disabled', !enabled);
  pad.querySelectorAll('button.nudge').forEach((b) => { b.disabled = !enabled; });
}

// ---------- Placement helpers ----------
function addPlacementFromCatalog(catId) {
  const scn = activeScenario();
  const item = catalogItem(catId);
  if (!item) return;
  // Inventory is a shared pool consumed across all container loadings. Refuse
  // to place another unit once the item's remaining quantity is depleted.
  if (remainingQty(item.id) <= 0) {
    toast(`No units of "${item.name}" left in the shipment inventory`, 'warn');
    return;
  }
  const spec = getContainer(scn.containerType);
  const p = {
    id: uid('pl'),
    catalogItemId: item.id,
    name: item.name,
    category: item.category,
    hazmatClass: item.hazmatClass,
    weight: item.weight,
    color: itemColor(item),
    x: 0, y: 0, z: 0,
    dims: { l: item.length, w: item.width, h: item.height },
    rot: { rot: 0, tipped: false },
    layer: 0,
  };
  // Find the first non-overlapping resting spot instead of a fixed offset.
  // If it doesn't fit as-is, retry rotated/tipped orientations before giving up.
  const spot = findFreePlacementAnyOrientation(scn.placements, spec, p.dims, {
    item,
    baseLookup: (o) => catalogItem(o.catalogItemId),
  });
  if (!spot) {
    toast(`No room to place "${item.name}"`, 'warn');
    return;
  }
  p.x = spot.x; p.y = spot.y; p.z = spot.z; p.layer = spot.layer;
  p.dims = spot.dims; p.rot = spot.rot;
  scn.placements.push(p);
  // One placed unit consumes one staged entry, not every staged copy.
  const stagedIndex = staging.findIndex((entry) => entry.catalogItemId === item.id);
  if (stagedIndex >= 0) staging.splice(stagedIndex, 1);
  setSelection(p.id);
  markDirty();
  renderAll();
}

function editPlacement(id) {
  const scn = activeScenario();
  const p = scn.placements.find((x) => x.id === id);
  if (!p) return;
  itemForm(
    makeCatalogItem({
      name: p.name, category: p.category, hazmatClass: p.hazmatClass,
      length: p.dims.l, width: p.dims.w, height: p.dims.h, weight: p.weight,
    }),
    (out) => {
      const candidate = { ...p, name: out.name, category: out.category, hazmatClass: out.hazmatClass,
        dims: { l: out.length, w: out.width, h: out.height }, weight: out.weight, color: itemColor(out) };
      const error = layoutError(scn.placements.map((q) => q === p ? candidate : q), getContainer(scn.containerType), catalogItem);
      if (error) throw new Error(error);
      Object.assign(p, candidate);
      markDirty(); renderAll();
    }
  );
}

function showDetails(id) {
  const p = activeScenario().placements.find((x) => x.id === id);
  if (!p) return;
  openModal((close) =>
    el('div', {}, [
      el('div', { class: 'form-grid' }, [
        el('div', {}, [el('div', { class: 'muted small', text: 'Category' }), el('div', { text: p.category })]),
        el('div', {}, [el('div', { class: 'muted small', text: 'Hazmat' }), el('div', { text: p.hazmatClass })]),
        el('div', {}, [el('div', { class: 'muted small', text: 'Weight' }), el('div', { text: `${Math.round(p.weight)} lb` })]),
        el('div', {}, [el('div', { class: 'muted small', text: 'Dimensions' }), el('div', { text: `${Math.round(p.dims.l * 12)}×${Math.round(p.dims.w * 12)}×${Math.round(p.dims.h * 12)} in` })]),
        el('div', {}, [el('div', { class: 'muted small', text: 'Position' }), el('div', { text: `x${p.x.toFixed(1)} y${p.y.toFixed(1)} z${p.z.toFixed(1)}` })]),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn primary', text: 'Close', onClick: close }),
      ]),
    ]),
    { title: p.name }
  );
}

function removePlacement(id) {
  const scn = activeScenario();
  const idx = scn.placements.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const error = layoutError(scn.placements.filter((p) => p.id !== id), getContainer(scn.containerType), catalogItem);
  if (error) { toast(error, 'warn'); return; }
  staging.push(scn.placements[idx]);
  scn.placements.splice(idx, 1);
  // Drop the removed item from the (possibly multi-) selection.
  if (state.selectedPlacementIds.includes(id)) {
    setSelection(state.selectedPlacementIds.filter((x) => x !== id));
  }
  markDirty();
  renderAll();
}

function toggleLabels() {
  state.labelsVisible = !state.labelsVisible;
  sm.setLabelsVisible(state.labelsVisible);
  syncLabelsButton();
}

/** Reflect the current label visibility on the toggle button. */
function syncLabelsButton() {
  const btn = document.getElementById('btn-toggle-labels');
  if (!btn) return;
  btn.classList.toggle('active', state.labelsVisible);
  btn.setAttribute('aria-pressed', String(state.labelsVisible));
}

/**
 * Toggle snap-to-grid: while on, dragging or nudging an item rounds its
 * position to the nearest 1" cell (see cargo.js GRID_SIZE_FT). Persisted
 * across sessions like the theme preference.
 */
function toggleSnapToGrid() {
  state.snapToGridEnabled = !state.snapToGridEnabled;
  localStorage.setItem(SNAP_KEY, state.snapToGridEnabled ? '1' : '0');
  syncSnapButton();
  toast(`Snap to grid ${state.snapToGridEnabled ? 'on' : 'off'}`, 'ok');
}

/** Reflect the current snap-to-grid state on the toggle button. */
function syncSnapButton() {
  const btn = document.getElementById('btn-toggle-snap');
  if (!btn) return;
  btn.classList.toggle('active', state.snapToGridEnabled);
  btn.setAttribute('aria-pressed', String(state.snapToGridEnabled));
}

/**
 * Toggle the "Pending Items" staging view: a grid of every remaining
 * (unplaced) catalog unit laid out beside the active container. Placing a
 * unit removes it from the layout on the next refresh (see pendingItemsList).
 */
function togglePendingView() {
  state.pendingViewVisible = !state.pendingViewVisible;
  sm.setPendingVisible(state.pendingViewVisible);
  if (state.pendingViewVisible) {
    sm.setPendingItems(pendingItemsList(), getContainer(activeScenario().containerType));
  }
  syncPendingButton();
}

/** Reflect the current pending-view visibility on the toggle button. */
function syncPendingButton() {
  const btn = document.getElementById('btn-toggle-pending');
  if (!btn) return;
  btn.classList.toggle('active', state.pendingViewVisible);
  btn.setAttribute('aria-pressed', String(state.pendingViewVisible));
}

/**
 * Toggle the door/jamb overlay: the clear opening outline + dimensions, the
 * translucent jamb/header mask showing what's BLOCKED, and the faint entry
 * envelope swept from the opening through the container. Persisted like the
 * theme and snap-to-grid preferences.
 */
function toggleOpenings() {
  state.openingsVisible = !state.openingsVisible;
  localStorage.setItem(OPENINGS_KEY, state.openingsVisible ? '1' : '0');
  sm.setOpeningsVisible(state.openingsVisible);
  syncOpeningsButton();
}

/** Reflect the current door-jamb overlay visibility on the toggle button. */
function syncOpeningsButton() {
  const btn = document.getElementById('btn-toggle-openings');
  if (!btn) return;
  btn.classList.toggle('active', state.openingsVisible);
  btn.setAttribute('aria-pressed', String(state.openingsVisible));
}

/**
 * Toggle the Measure tool: click two points in the scene (item ↔ wall, item
 * ↔ roof, or any point A to point B) to read the distance between them.
 * Suspends normal drag/select interaction while active (see Interaction's
 * isMeasuring guard) and clears any in-progress selection so the two modes
 * never fight over the canvas.
 */
function toggleMeasureTool() {
  if (!measure) return;
  const active = measure.toggle();
  if (active) {
    clearSelection();
    sm.syncPlacements(activeScenario().placements, state.selectedPlacementIds);
    updateNudgePad();
    renderClearances(null, getContainer(activeScenario().containerType));
  }
  syncMeasureButton(active);
}

/** Reflect the current Measure tool state on the toggle button. */
function syncMeasureButton(active) {
  const btn = document.getElementById('btn-measure');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
}

// ---------- Panel handlers ----------
function scenarioHandlers() {
  return {
    select: (id) => { state.activeScenarioId = id; clearSelection(); renderAll(); },
    rename: (id) => {
      const s = state.project.scenarios.find((x) => x.id === id);
      const input = el('input', { value: s.name });
      openModal((close) => el('div', {}, [
        el('label', {}, ['Name', input]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn', text: 'Cancel', onClick: close }),
          el('button', { class: 'btn primary', text: 'Save', onClick: () => { s.name = input.value.trim() || s.name; markDirty(); renderAll(); close(); } }),
        ]),
      ]), { title: 'Rename Container Loading' });
    },
    duplicate: (id) => {
      if (state.project.scenarios.length >= 100) { toast('Project limit is 100 containers', 'warn'); return; }
      const s = state.project.scenarios.find((x) => x.id === id);
      const needed = new Map();
      for (const p of s.placements) needed.set(p.catalogItemId, (needed.get(p.catalogItemId) || 0) + 1);
      if ([...needed].some(([catId, qty]) => qty > remainingQty(catId))) {
        toast('Not enough remaining inventory to duplicate this loading', 'warn'); return;
      }
      const copy = JSON.parse(JSON.stringify(s));
      copy.id = uid('scn');
      copy.name = s.name + ' (copy)';
      copy.placements.forEach((p) => { p.id = uid('pl'); });
      state.project.scenarios.push(copy);
      state.activeScenarioId = copy.id;
      markDirty(); renderAll();
    },
    remove: (id) => {
      confirmDialog('Delete this container loading?', () => {
        const arr = state.project.scenarios;
        const idx = arr.findIndex((x) => x.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        if (state.activeScenarioId === id) state.activeScenarioId = arr[0]?.id || null;
        markDirty(); renderAll();
      });
    },
  };
}

function catalogHandlers() {
  return {
    place: (catId) => addPlacementFromCatalog(catId),
    edit: (catId) => {
      const item = catalogItem(catId);
      itemForm(item, (out) => {
        validateProjectData({ ...state.project, catalog: state.project.catalog.map((c) => c.id === catId ? out : c) });
        Object.assign(item, out); markDirty(); renderAll();
      });
    },
    remove: (catId) => {
      if (placedQty(catId) > 0) { toast('Remove this item from all containers before deleting it', 'warn'); return; }
      const idx = state.project.catalog.findIndex((c) => c.id === catId);
      if (idx >= 0) state.project.catalog.splice(idx, 1);
      for (let i = staging.length - 1; i >= 0; i--) {
        if (staging[i].catalogItemId === catId) staging.splice(i, 1);
      }
      markDirty(); renderAll();
    },
  };
}

function libraryHandlers() {
  return {
    add: (preset) => {
      const seed = presetToCatalogItem(preset);
      itemForm(seed, (out) => {
        appendCatalogItems([out]);
        toast(`Added "${out.name}" to catalog`, 'ok');
      });
    },
    deletePreset: (i) => { deleteCustomPreset(i); renderLibrary(libraryHandlers()); },
  };
}

function stagingHandlers() {
  return {
    readd: (i) => {
      const scn = activeScenario();
      const spec = getContainer(scn.containerType);
      const p = staging[i];
      // Respect the shared inventory pool: only re-add if the item still has
      // remaining (unshipped) units across all container loadings.
      if (!p.catalogItemId || remainingQty(p.catalogItemId) <= 0) {
        toast(`No units of "${p.name}" left in the shipment inventory`, 'warn');
        return;
      }
      // If it doesn't fit as-is, retry rotated/tipped orientations before giving up.
      const spot = findFreePlacementAnyOrientation(scn.placements, spec, p.dims, {
        item: catalogItem(p.catalogItemId) || p,
        baseLookup: (o) => catalogItem(o.catalogItemId),
      });
      if (!spot) {
        toast(`No room to place "${p.name}"`, 'warn');
        return;
      }
      staging.splice(i, 1);
      p.id = uid('pl');
      p.x = spot.x; p.y = spot.y; p.z = spot.z; p.layer = spot.layer;
      p.dims = spot.dims; p.rot = spot.rot;
      scn.placements.push(p);
      markDirty(); renderAll();
    },
    discard: (i) => { staging.splice(i, 1); markDirty(); renderAll(); },
  };
}

// ---------- Toolbar & topbar ----------
/** Modal listing CSV rows skipped during import, with per-row reasons. */
function showSkippedRows(errors) {
  openModal(
    (close) =>
      el('div', {}, [
        el('ul', { class: 'list' },
          errors.map((e) => el('li', { text: `Line ${e.line}: ${e.message}` }))),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn primary', text: 'OK', onClick: close }),
        ]),
      ]),
    { title: 'CSV rows skipped' }
  );
}

function wireToolbar() {
  document.getElementById('btn-add-catalog').addEventListener('click', () => {
    itemForm(null, (item) => appendCatalogItems([item]));
  });
  document.getElementById('btn-import-catalog').addEventListener('click', () => {
    catalogImportForm((items, errors) => {
      try { appendCatalogItems(items); }
      catch (err) { toast(err.message, 'error'); return; }
      const skipped = errors.length ? ` · ${errors.length} skipped` : '';
      toast(`Imported ${items.length} item${items.length === 1 ? '' : 's'}${skipped}`,
        errors.length ? 'warn' : 'ok');
      if (errors.length) showSkippedRows(errors);
    });
  });
  document.getElementById('btn-add-scenario').addEventListener('click', () => {
    if (state.project.scenarios.length >= 100) { toast('Project limit is 100 containers', 'warn'); return; }
    const s = makeScenario(`Container ${state.project.scenarios.length + 1}`);
    state.project.scenarios.push(s);
    state.activeScenarioId = s.id;
    markDirty(); renderAll();
  });
  document.getElementById('btn-autoload').addEventListener('click', () => {
    const scn = activeScenario();
    autoloadForm(scn.containerType, async ({ containerType, strategy, maxContainers, simulations }) => {
      const project = state.project;
      const revision = state.editRevision;
      let closeProgress = () => {};
      try {
        validateProjectData(project);
        // Pack only what's left in the shared shipment inventory (append mode):
        // each container loading already consumed its units, so auto-load fills
        // fresh containers from the remaining pool without double-counting.
        const remainingCatalog = state.project.catalog
          .map((it) => ({ ...it, qtyAvailable: remainingQty(it.id) }))
          .filter((it) => it.qtyAvailable > 0);

        if (!remainingCatalog.length) {
          toast('No remaining inventory to pack — everything is already placed.', 'warn');
          return;
        }

        const job = startPacking(remainingCatalog, {
          containerType, strategy, maxContainers, simulations,
        });
        const busy = el('div', {}, [
          el('p', { text: 'Searching cargo layouts… You can cancel without changing the project.' }),
          el('button', { class: 'btn', text: 'Cancel', onClick: () => job.cancel() }),
        ]);
        closeProgress = openModal(() => busy, { title: 'Auto-load running', onClose: () => job.cancel() });
        const result = await job.promise;
        if (state.project !== project || state.editRevision !== revision) {
          toast('Project changed during packing; result discarded. Run auto-load again.', 'warn'); return;
        }
        if (project.scenarios.length + result.containers.length > 100) throw new Error('Project limit is 100 container loadings');

        if (!result.containers.length) {
          toast('Nothing could be packed — remaining items are staged.', 'warn');
        }

        // Each packed container becomes its own new container loading, appended
        // after any existing ones. Numbering continues from the current count.
        const base = state.project.scenarios.length;
        let firstId = null;
        result.containers.forEach((c, i) => {
          const label = `Auto — Container ${base + i + 1}`;
          const s = makeScenario(label, c.containerType);
          s.placements = c.placements;
          s.generatedBy = strategy;
          // Keep the winning simulation's score with the loading so the shipment
          // summary can show how (and how well) this layout was chosen. Rides
          // inside the existing project JSON blob — no schema change.
          s.loadScore = c.score;
          state.project.scenarios.push(s);
          if (i === 0) firstId = s.id;
        });

        // Replace stale staging entries for the inventory offered in this run.
        const offeredIds = new Set(remainingCatalog.map((item) => item.id));
        for (let i = staging.length - 1; i >= 0; i--) {
          if (offeredIds.has(staging[i].catalogItemId)) staging.splice(i, 1);
        }
        result.unplaced.forEach((u) => staging.push({
          id: uid('pl'), catalogItemId: u.item.id, name: u.item.name, category: u.item.category,
          hazmatClass: u.item.hazmatClass, weight: u.item.weight, color: itemColor(u.item),
          x: 0, y: 0, z: 0, dims: { l: u.item.length, w: u.item.width, h: u.item.height },
          rot: { rot: 0, tipped: false }, layer: 0,
        }));

        // Switch to the first generated container.
        markDirty();
        if (firstId) state.activeScenarioId = firstId;
        renderAll();

        const {
          containerCount, placedUnits, totalUnits, cappedByMax, doorBlockedUnits,
          simulationsRun, bestScore, plansEvaluated, balanceBreaches,
        } = result.summary;
        let msg = `${placedUnits}/${totalUnits} items across ${containerCount} container${containerCount > 1 ? 's' : ''}`;
        // Show that the plan is the winner of a scored search, not a single try.
        if (simulationsRun) {
          msg += ` · best of ${plansEvaluated} plans / ${simulationsRun} layouts` +
            ` (balance+fit score ${(bestScore * 100).toFixed(0)}/100)`;
        }
        if (result.unplaced.length) msg += ` · ${result.unplaced.length} staged`;
        // Call out door-blocked items explicitly: they're not a space problem,
        // they physically can't pass the jambs of this container type.
        if (doorBlockedUnits) msg += ` (${doorBlockedUnits} won't clear the door)`;
        if (result.summary.truncated) msg += ' · time limit reached; some inventory remains unpacked';
        // If even the best plan still breaches the >60%-in-one-half guideline,
        // say so — the Balance panel will be showing a warning too.
        if (balanceBreaches) {
          msg += ` · ⚠ ${balanceBreaches} balance warning${balanceBreaches > 1 ? 's' : ''}`;
        }
        toast(msg,
          cappedByMax || result.unplaced.length || balanceBreaches ? 'warn' : 'ok');
      } catch (error) { toast(error.message, 'warn'); }
      finally { closeProgress(); }
    });
  });

  document.getElementById('btn-toggle-labels').addEventListener('click', toggleLabels);
  syncLabelsButton();
  document.getElementById('btn-toggle-pending').addEventListener('click', togglePendingView);
  syncPendingButton();
  document.getElementById('btn-toggle-snap').addEventListener('click', toggleSnapToGrid);
  syncSnapButton();
  document.getElementById('btn-toggle-openings').addEventListener('click', toggleOpenings);
  syncOpeningsButton();
  document.getElementById('btn-rotate').addEventListener('click', () => interaction.onKey({ key: 'r', target: {} }));
  document.getElementById('btn-tip').addEventListener('click', () => interaction.onKey({ key: 't', target: {} }));
  document.getElementById('btn-delete').addEventListener('click', () => {
    // Delete the whole selection (a copy — removePlacement mutates the set).
    const ids = [...state.selectedPlacementIds].sort((a, b) =>
      (activeScenario().placements.find((p) => p.id === b)?.y || 0) -
      (activeScenario().placements.find((p) => p.id === a)?.y || 0));
    for (const id of ids) removePlacement(id);
  });

  document.getElementById('btn-measure').addEventListener('click', () => toggleMeasureTool());
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'm') return;
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable) return;
    toggleMeasureTool();
  });

  // Fine-tune "Move" pad: nudge the selected item along the viewer's axes.
  // Hold Alt while clicking for a coarse 6" step (matches the arrow-key path).
  document.querySelectorAll('#nudge-pad button.nudge').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (!state.selectedPlacementIds.length) return;
      const step = (e.altKey ? 6 : 1) / 12; // feet
      interaction.nudgeByView(btn.dataset.dir, step);
    });
  });

  // `capture` re-renders whichever view keys are requested on demand (e.g.
  // when the user changes the view picker inside the report modal), always
  // from the live SceneManager so the printout reflects the current
  // container/labels — including 'current', the user's live orbit angle.
  const captureReportViews = (list) => sm.captureViews(list, { labels: true });

  document.getElementById('btn-loadplan').addEventListener('click', () => {
    try { validateProjectData(state.project); } catch (err) { toast(err.message, 'error'); return; }
    loadPlanModal(activeScenario(), state.project, state.user, captureReportViews);
  });
  document.getElementById('btn-manifest').addEventListener('click', () => {
    try { validateProjectData(state.project); } catch (err) { toast(err.message, 'error'); return; }
    manifestModal(state.project, activeScenario(), state.user, captureReportViews);
  });
  document.getElementById('btn-export-png').addEventListener('click', () => {
    downloadPNG(sm.exportPNG(), `${state.project.name}-${activeScenario().name}.png`);
  });
  document.getElementById('btn-export-json').addEventListener('click', () => exportProjectJSON(state.project));

  const importInput = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
  document.body.appendChild(importInput);
  importInput.addEventListener('change', async () => {
    if (!importInput.files[0]) return;
    try {
      const proj = await importProjectJSON(importInput.files[0]);
      if (mayDiscardChanges()) { setProject(proj); markDirty(); renderAll(); toast('Imported project', 'ok'); }
    } catch (e) { toast(e.message, 'error'); }
    importInput.value = '';
  });
  document.getElementById('btn-import-json').addEventListener('click', () => importInput.click());

  // Controls & shortcuts reference (replaces the old always-on hint bar).
  document.getElementById('btn-shortcuts').addEventListener('click', () => shortcutsModal());
  window.addEventListener('keydown', (e) => {
    if (e.key !== '?') return;
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable) return;
    shortcutsModal();
  });
}

function wireTopbar() {
  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
  });
  document.getElementById('btn-admin').addEventListener('click', () => usersDialog());
  document.getElementById('btn-compare').addEventListener('click', () => {
    compareModal(state.project, state.activeScenarioId, (id) => {
      state.activeScenarioId = id; clearSelection(); renderAll();
    });
  });
  document.getElementById('btn-projects').addEventListener('click', () => {
    projectsDialog({
      canWrite: state.user.role !== 'viewer',
      canManage: state.user.role === 'admin',
      onOpen: (id) => loadProject(id),
      onNew: () => newProjectDialog(async ({ name, visibility }) => {
        if (!mayDiscardChanges()) return;
        const proj = newProject(name); proj.visibility = visibility;
        setProject(proj); renderAll();
        await saveProject();
      }),
      onCopy: async (id) => {
        const { project } = await api.duplicateProject(id);
        toast(`Copied to "${project.name}"`, 'ok');
      },
      // Advance the local revision only if Manage started from the same version.
      // Otherwise leave the stale revision so a later save correctly conflicts.
      onUpdated: (updated, previousRevision) => {
        if (state.project && state.project.id === updated.id) {
          state.project.name = updated.name;
          state.project.visibility = updated.visibility;
          state.project.viewers = updated.viewers;
          if (state.project.revision === previousRevision) state.project.revision = updated.revision;
          renderAll();
        }
      },
      onImport: async (file) => {
        try { const proj = await importProjectJSON(file); if (!mayDiscardChanges()) return; setProject(proj); markDirty(); renderAll(); toast('Imported', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      },
    });
  });
  document.getElementById('btn-save').addEventListener('click', () => saveProject());
}

async function loadProject(id) {
  try {
    const original = state.project;
    const { project, canEdit } = await api.getProject(id);
    if (state.project !== original || !mayDiscardChanges()) return;
    const data = project.data || {};
    setProject({
      id: project.id,
      revision: project.revision,
      canEdit,
      name: project.name,
      visibility: project.visibility,
      viewers: project.viewers || [],
      catalog: Array.isArray(data.catalog) ? data.catalog : [],
      staging: Array.isArray(data.staging) ? data.staging : [],
      scenarios: Array.isArray(data.scenarios) && data.scenarios.length
        ? data.scenarios : [makeScenario('Container 1')],
    });
    renderAll();
    toast(`Opened "${project.name}"`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function saveProject() {
  if (state.user.role === 'viewer') { toast('Viewers cannot save', 'error'); return; }
  const p = state.project;
  if (p.canEdit === false) { toast('This project is read-only. Copy it before editing.', 'error'); return; }
  try {
    await persistProject(p);
    renderAll();
    toast(state.project === p && state.dirty ? 'Snapshot saved; newer edits still need saving' : 'Project saved', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

// bootstrap
(async () => {
  if (await tryResumeSession()) enterApp();
})();
