// App entry point: authentication, wiring, and the main controller.
import { api, loadToken, saveToken } from './api.js';
import {
  state, setProject, newProject, makeScenario, activeScenario, catalogItem, markDirty,
  setSelection, toggleSelection, clearSelection, remainingQty,
} from './store.js';
import { SceneManager } from './scene.js';
import { Interaction } from './interaction.js';
import { getContainer, CONTAINER_TYPES } from './container.js';
import { makeCatalogItem, uid, itemColor, findFreePlacement } from './cargo.js';
import { packAll } from './autoload.js';
import { presetToCatalogItem, deleteCustomPreset } from './library.js';
import {
  renderScenarios, renderCatalog, renderLibrary, renderStats, renderStaging,
} from './panels.js';
import { el, toast, openModal, confirmDialog, makeCollapsible } from './ui.js';
import { itemForm, autoloadForm, loadPlanModal, compareModal, catalogImportForm, shortcutsModal } from './forms.js';
import { projectsDialog, newProjectDialog, usersDialog } from './dialogs.js';
import { printManifest, downloadPNG } from './reporting.js';
import { exportProjectJSON, importProjectJSON } from './io.js';

let sm = null; // SceneManager
let interaction = null;
const staging = []; // removed placements held aside

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
    },
    onChange: () => { markDirty(); renderStats(activeScenario()); renderScenarios(state.project, state.activeScenarioId, scenarioHandlers()); },
    onEdit: (id) => editPlacement(id),
    onDetails: (id) => showDetails(id),
    onDelete: (id) => removePlacement(id),
    onToggleLabels: () => toggleLabels(),
    getContainerSpec: () => getContainer(activeScenario().containerType),
    getSelectedId: () => state.selectedPlacementId,
    getSelectedIds: () => state.selectedPlacementIds,
  });
}

function refreshScene() {
  const scn = activeScenario();
  if (!scn) return;
  sm.setContainer(scn.containerType);
  sm.clearCargo();
  sm.setLabelsVisible(state.labelsVisible);
  sm.syncPlacements(scn.placements, state.selectedPlacementIds);
  const sel = document.getElementById('container-select');
  sel.value = scn.containerType;
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
  renderStaging(staging, stagingHandlers());
  refreshScene();
  updateNudgePad();
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
  const spot = findFreePlacement(scn.placements, spec, p.dims, {
    item,
    baseLookup: (o) => catalogItem(o.catalogItemId),
  });
  if (!spot) {
    toast(`No room to place "${item.name}"`, 'warn');
    return;
  }
  p.x = spot.x; p.y = spot.y; p.z = spot.z; p.layer = spot.layer;
  scn.placements.push(p);
  // The staged item is tied to the catalog: placing it again clears any staged
  // copies. Match on catalogItemId; fall back to name for entries that lack it
  // (e.g. auto-load leftovers).
  for (let i = staging.length - 1; i >= 0; i--) {
    const s = staging[i];
    if (s.catalogItemId === item.id || (!s.catalogItemId && s.name === item.name)) {
      staging.splice(i, 1);
    }
  }
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
      p.name = out.name; p.category = out.category; p.hazmatClass = out.hazmatClass;
      p.dims = { l: out.length, w: out.width, h: out.height };
      p.weight = out.weight; p.color = itemColor(out);
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
      const s = state.project.scenarios.find((x) => x.id === id);
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
      itemForm(item, (out) => { Object.assign(item, out); markDirty(); renderAll(); });
    },
    remove: (catId) => {
      const idx = state.project.catalog.findIndex((c) => c.id === catId);
      if (idx >= 0) state.project.catalog.splice(idx, 1);
      markDirty(); renderAll();
    },
  };
}

function libraryHandlers() {
  return {
    add: (preset) => {
      const seed = presetToCatalogItem(preset);
      itemForm(seed, (out) => {
        state.project.catalog.push(out);
        markDirty(); renderAll();
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
      if (p.catalogItemId && remainingQty(p.catalogItemId) <= 0) {
        toast(`No units of "${p.name}" left in the shipment inventory`, 'warn');
        return;
      }
      const spot = findFreePlacement(scn.placements, spec, p.dims, {
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
      scn.placements.push(p);
      markDirty(); renderAll();
    },
    discard: (i) => { staging.splice(i, 1); renderStaging(staging, stagingHandlers()); },
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
    itemForm(null, (item) => { state.project.catalog.push(item); markDirty(); renderAll(); });
  });
  document.getElementById('btn-import-catalog').addEventListener('click', () => {
    catalogImportForm((items, errors) => {
      state.project.catalog.push(...items);
      markDirty(); renderAll();
      const skipped = errors.length ? ` · ${errors.length} skipped` : '';
      toast(`Imported ${items.length} item${items.length === 1 ? '' : 's'}${skipped}`,
        errors.length ? 'warn' : 'ok');
      if (errors.length) showSkippedRows(errors);
    });
  });
  document.getElementById('btn-add-scenario').addEventListener('click', () => {
    const s = makeScenario(`Container ${state.project.scenarios.length + 1}`);
    state.project.scenarios.push(s);
    state.activeScenarioId = s.id;
    markDirty(); renderAll();
  });
  document.getElementById('btn-autoload').addEventListener('click', () => {
    const scn = activeScenario();
    autoloadForm(scn.containerType, ({ containerType, strategy, maxContainers }) => {
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

      const result = packAll(remainingCatalog, {
        containerType, strategy, maxContainers,
      });

      if (!result.containers.length) {
        toast('Nothing could be packed — check item sizes vs. container.', 'warn');
        return;
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
        state.project.scenarios.push(s);
        if (i === 0) firstId = s.id;
      });

      // Items that fit no container at all go to the staging area.
      result.unplaced.forEach((u) => staging.push({
        id: uid('pl'), name: u.item.name, category: u.item.category,
        hazmatClass: u.item.hazmatClass, weight: u.item.weight, color: itemColor(u.item),
        x: 0, y: 0, z: 0, dims: { l: u.item.length, w: u.item.width, h: u.item.height },
        rot: { rot: 0, tipped: false }, layer: 0,
      }));

      // Switch to the first generated container.
      if (firstId) state.activeScenarioId = firstId;
      markDirty(); renderAll();

      const { containerCount, placedUnits, totalUnits, cappedByMax } = result.summary;
      let msg = `${placedUnits}/${totalUnits} items across ${containerCount} container${containerCount > 1 ? 's' : ''}`;
      if (result.unplaced.length) msg += ` · ${result.unplaced.length} staged`;
      toast(msg, cappedByMax || result.unplaced.length ? 'warn' : 'ok');
    });
  });

  document.getElementById('btn-toggle-labels').addEventListener('click', toggleLabels);
  document.getElementById('btn-rotate').addEventListener('click', () => interaction.onKey({ key: 'r', target: {} }));
  document.getElementById('btn-tip').addEventListener('click', () => interaction.onKey({ key: 't', target: {} }));
  document.getElementById('btn-delete').addEventListener('click', () => {
    // Delete the whole selection (a copy — removePlacement mutates the set).
    const ids = [...state.selectedPlacementIds];
    for (const id of ids) removePlacement(id);
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

  document.getElementById('btn-loadplan').addEventListener('click', () => {
    const views = sm.captureViews(['iso', 'side', 'front', 'top'], { labels: true });
    loadPlanModal(activeScenario(), state.project, state.user, views);
  });
  document.getElementById('btn-manifest').addEventListener('click', () => {
    const iso = sm.captureViews(['iso'], { labels: true }).iso;
    printManifest(state.project, activeScenario(), state.user, iso);
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
      setProject(proj); renderAll(); toast('Imported project', 'ok');
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
        const proj = newProject(name); proj.visibility = visibility;
        setProject(proj); renderAll();
        await saveProject();
      }),
      onCopy: async (id) => {
        const { project } = await api.duplicateProject(id);
        toast(`Copied to "${project.name}"`, 'ok');
      },
      onImport: async (file) => {
        try { const proj = await importProjectJSON(file); setProject(proj); renderAll(); toast('Imported', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      },
    });
  });
  document.getElementById('btn-save').addEventListener('click', () => saveProject());
}

async function loadProject(id) {
  try {
    const { project } = await api.getProject(id);
    const data = project.data || {};
    setProject({
      id: project.id,
      name: project.name,
      visibility: project.visibility,
      viewers: project.viewers || [],
      catalog: Array.isArray(data.catalog) ? data.catalog : [],
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
  const payload = {
    name: p.name,
    visibility: p.visibility,
    viewers: (p.viewers || []).map((v) => (typeof v === 'object' ? v.id : v)),
    data: { catalog: p.catalog, scenarios: p.scenarios },
  };
  try {
    if (p.id) {
      await api.updateProject(p.id, payload);
    } else {
      const { project } = await api.createProject(payload);
      p.id = project.id;
    }
    state.dirty = false;
    renderAll();
    toast('Project saved', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

// bootstrap
(async () => {
  if (await tryResumeSession()) enterApp();
})();
