// Modal forms for catalog items, projects, users, compare, load plan/manifest.
import { el, openModal, toast, confirmDialog } from './ui.js';
import { CATEGORIES, HAZMAT_CLASSES, makeCatalogItem } from './cargo.js';
import { CONTAINER_TYPES, getContainer } from './container.js';
import { STRATEGIES, DEFAULT_MAX_CONTAINERS, DEFAULT_SIMULATIONS } from './autoload.js';
import { scenarioStats, fmtLb, fmtPct, fmtFt3 } from './stats.js';
import { saveCustomPreset } from './library.js';
import { loadPlanHTML, manifestHTML, reportDocument, printLoadPlan, printManifest } from './reporting.js';
import { parseCatalogCsv, downloadSampleCatalogCSV } from './catalogCsv.js';

function option(value, label, selected) {
  return el('option', { value, ...(selected ? { selected: '' } : {}), text: label });
}

/** Catalog item create/edit form. onSave(item). */
export function itemForm(existing, onSave) {
  const item = existing ? { ...existing } : makeCatalogItem();
  const catSel = el(
    'select',
    {},
    Object.values(CATEGORIES).map((c) => option(c.id, c.label, c.id === item.category))
  );
  const hazSel = el(
    'select',
    {},
    Object.values(HAZMAT_CLASSES).map((h) =>
      option(h.id, h.label, h.id === item.hazmatClass)
    )
  );
  const f = {
    name: el('input', { value: item.name }),
    length: el('input', { type: 'number', step: '0.5', value: item.length * 12 }),
    width: el('input', { type: 'number', step: '0.5', value: item.width * 12 }),
    height: el('input', { type: 'number', step: '0.5', value: item.height * 12 }),
    weight: el('input', { type: 'number', step: '1', value: item.weight }),
    qty: el('input', { type: 'number', step: '1', min: '0', value: item.qtyAvailable }),
  };
  const noTip = el('input', { type: 'checkbox', ...(item.noTip ? { checked: '' } : {}) });
  const savePreset = el('input', { type: 'checkbox' });

  openModal((close) => {
    function submit() {
      try {
        const out = makeCatalogItem({
          id: item.id,
          name: f.name.value.trim() || 'Item',
          category: catSel.value,
          hazmatClass: hazSel.value,
          length: parseFloat(f.length.value) / 12,
          width: parseFloat(f.width.value) / 12,
          height: parseFloat(f.height.value) / 12,
          weight: parseFloat(f.weight.value),
          qtyAvailable: f.qty.value.trim() === '' ? NaN : Number(f.qty.value),
          stackOn: item.stackOn,
          stackUnder: item.stackUnder,
          color: item.color,
          noTip: noTip.checked,
        });
        if (savePreset.checked) {
          saveCustomPreset(out);
          toast('Saved as custom preset', 'ok');
        }
        onSave(out);
        close();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    return el('div', {}, [
      el('div', { class: 'form-grid' }, [
        el('label', { class: 'full-col' }, ['Name', f.name]),
        el('label', {}, ['Category', catSel]),
        el('label', {}, ['Hazmat Class', hazSel]),
        el('label', {}, ['Length (in)', f.length]),
        el('label', {}, ['Width (in)', f.width]),
        el('label', {}, ['Height (in)', f.height]),
        el('label', {}, ['Weight (lb)', f.weight]),
        el('label', {}, ['Qty Available', f.qty]),
        el('label', { class: 'full-col inline' }, [noTip, ' Do not tip (cannot be laid on its side)']),
        el('label', { class: 'full-col inline' }, [savePreset, ' Save as reusable custom preset']),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Cancel', onClick: close }),
        el('button', { class: 'btn primary', text: 'Save', onClick: submit }),
      ]),
    ]);
  }, { title: existing ? 'Edit Item' : 'New Catalog Item' });
}

/**
 * Catalog CSV import dialog. onImport(items, errors) receives parsed catalog
 * items plus per-row skip reasons. Includes a downloadable sample template.
 */
export function catalogImportForm(onImport) {
  let closeFn = () => {};
  const statusEl = el('p', { class: 'muted small' });
  const fileInput = el('input', {
    type: 'file', accept: '.csv,text/csv', style: 'display:none',
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });
      const { items, errors } = parseCatalogCsv(text);
      if (!items.length) {
        statusEl.className = 'error';
        const msgs = errors.length
          ? errors.map((e) => `Line ${e.line}: ${e.message}`)
          : ['No usable rows found.'];
        statusEl.textContent = `Nothing imported. ${msgs.join(' · ')}`;
        fileInput.value = '';
        return;
      }
      closeFn();
      onImport(items, errors);
    } catch (err) {
      statusEl.className = 'error';
      statusEl.textContent = `Could not read file: ${err.message || 'unknown error'}`;
    }
    fileInput.value = '';
  });

  openModal((close) => {
      closeFn = close;
      return el('div', {}, [
        el('div', { class: 'form-grid' }, [
          el('p', {
            class: 'muted small full-col',
            text:
              'Upload a CSV to populate the Item Catalog. Columns (case-insensitive): name, ' +
              'category, hazmatClass, length, width, height, weight, qty (optional), ' +
              'noTip (optional — yes/true/1 to prevent tipping). ' +
              'Dimensions are in inches; weight is in pounds.',
          }),
          el('p', {
            class: 'muted small full-col',
            text:
              `Valid categories: ${Object.keys(CATEGORIES).join('|')}. ` +
              `Hazmat classes: ${Object.keys(HAZMAT_CLASSES).join('|')} (blank = none).`,
          }),
          statusEl,
        ]),
        el('div', { class: 'modal-actions' }, [
          el('button', {
            class: 'btn',
            text: '⤓ Download Sample CSV',
            onClick: downloadSampleCatalogCSV,
          }),
          el('button', {
            class: 'btn primary',
            text: 'Choose CSV…',
            onClick: () => fileInput.click(),
          }),
          el('button', { class: 'btn', text: 'Close', onClick: close }),
          fileInput,
        ]),
      ]);
    },
    { title: 'Import Catalog from CSV' }
  );
}

/**
 * Auto-load options dialog.
 * onGenerate({ containerType, strategy, maxContainers, simulations }).
 */
export function autoloadForm(currentContainer, onGenerate) {
  const contSel = el(
    'select',
    {},
    Object.values(CONTAINER_TYPES).map((c) =>
      option(c.id, c.name, c.id === currentContainer)
    )
  );
  const stratSel = el(
    'select',
    {},
    STRATEGIES.map((s) => option(s.id, s.label, s.id === 'balanced'))
  );
  const maxInput = el('input', {
    type: 'number',
    min: '1',
    max: '50',
    step: '1',
    value: String(DEFAULT_MAX_CONTAINERS),
  });
  const simInput = el('input', {
    type: 'number',
    min: '1',
    max: '200',
    step: '1',
    value: String(DEFAULT_SIMULATIONS),
    title:
      'How many randomized layouts to simulate and score per container. ' +
      'Higher explores more options but takes longer.',
  });
  openModal((close) =>
    el('div', {}, [
      el('p', {
        class: 'muted small',
        text:
          'Best-fills the remaining shipment inventory across as many containers ' +
          'as needed: it packs one container as full as possible, locks it as its ' +
          'own container loading, then loads the remaining items into the next.',
      }),
      el('p', {
        class: 'muted small',
        text:
          'Each container is packed many times over — varying the order items ' +
          'arrive and how they are rotated — and every layout is scored on ' +
          'front/back, left/right and floor/roof weight balance plus the number ' +
          'of items loaded. The highest-scoring layout is the one proposed.',
      }),
      el('div', { class: 'form-grid' }, [
        el('label', {}, ['Container', contSel]),
        el('label', {}, ['Strategy', stratSel]),
        el('label', {}, ['Max containers', maxInput]),
        el('label', {}, ['Simulations', simInput]),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Cancel', onClick: close }),
        el('button', {
          class: 'btn primary',
          text: 'Generate',
          onClick: () => {
            const maxContainers = Math.max(
              1,
              Math.min(50, Math.floor(Number(maxInput.value) || DEFAULT_MAX_CONTAINERS))
            );
            const simulations = Math.max(
              1,
              Math.min(200, Math.floor(Number(simInput.value) || DEFAULT_SIMULATIONS))
            );
            onGenerate({
              containerType: contSel.value,
              strategy: stratSel.value,
              maxContainers,
              simulations,
            });
            close();
          },
        }),
      ]),
    ]),
    { title: '🧠 Auto-Generate Load Plan' }
  );
}

// Checkbox options for the container-view picker shared by the Load Plan
// and Manifest report modals. 'current' captures the live interactive
// camera's present orbit/zoom, exactly as the user last left it.
const VIEW_OPTIONS = [
  { key: 'iso', label: 'Isometric' },
  { key: 'current', label: 'Current View' },
  { key: 'side', label: 'Side' },
  { key: 'front', label: 'Front' },
  { key: 'top', label: 'Top' },
];

/**
 * Build a row of view-selection inputs. `initial` is the set of keys
 * pre-checked; `onChange(selectedKeys)` fires whenever the selection
 * changes. `single` (radio semantics) restricts the picker to exactly one
 * selected view at a time — used by the Manifest modal, which only ever
 * shows one container image.
 */
function viewPicker(initial, onChange, { single = false } = {}) {
  const selected = new Set(initial);
  const groupName = single ? `view-picker-${Math.random().toString(36).slice(2)}` : null;
  const boxes = VIEW_OPTIONS.map(({ key, label }) => {
    const cb = el('input', single
      ? { type: 'radio', name: groupName }
      : { type: 'checkbox' });
    cb.checked = selected.has(key);
    cb.addEventListener('change', () => {
      if (single) {
        selected.clear();
        if (cb.checked) selected.add(key);
      } else if (cb.checked) {
        selected.add(key);
      } else {
        selected.delete(key);
      }
      onChange([...selected]);
    });
    return el('label', { class: 'inline view-picker-option' }, [cb, ' ', label]);
  });
  return el('div', { class: 'view-picker' }, boxes);
}

/**
 * Load plan modal: branded preview (isolated iframe) + print.
 * `capture(list)` re-renders the requested container views (e.g. from the
 * live SceneManager) and returns a { [viewKey]: dataUrl } map; the modal
 * calls it whenever the user changes the view selection so the preview and
 * final print always reflect the chosen viewpoint(s).
 */
export function loadPlanModal(scenario, project, user, capture, initialViews = ['iso', 'side', 'front', 'top']) {
  const preview = el('iframe', {
    class: 'report-preview',
    title: 'Load Plan preview',
  });
  let views = capture(initialViews);

  // Render the exact branded document into an isolated frame so the print
  // styles don't leak into (or inherit from) the app theme.
  const load = () => {
    const doc = preview.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(reportDocument('Load Plan', loadPlanHTML(scenario, project, user, views)));
    doc.close();
  };
  preview.addEventListener('load', load);

  openModal((close) => {
    // Kick off the write once the frame is in the DOM.
    setTimeout(load, 0);
    const picker = viewPicker(initialViews, (keys) => {
      views = capture(keys);
      load();
    });
    return el('div', { class: 'report-modal' }, [
      el('div', {}, [
        el('div', { class: 'muted small', style: 'margin-bottom:4px', text: 'Container views to include:' }),
        picker,
      ]),
      preview,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Close', onClick: close }),
        el('button', {
          class: 'btn primary',
          text: 'Print',
          onClick: () => printLoadPlan(scenario, project, user, views),
        }),
      ]),
    ]);
  }, { title: 'Load Plan' });
}

/**
 * Manifest modal: same branded-preview pattern as loadPlanModal, but the
 * manifest report shows a single container view (defaults to Isometric).
 * `capture(list)` behaves the same as in loadPlanModal.
 */
export function manifestModal(project, scenario, user, capture, initialView = 'iso') {
  const preview = el('iframe', {
    class: 'report-preview',
    title: 'Packing Manifest preview',
  });
  let viewKey = initialView;
  let image = capture([viewKey])[viewKey];

  const load = () => {
    const doc = preview.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(reportDocument('Packing Manifest', manifestHTML(project, scenario, user, image, viewKey)));
    doc.close();
  };
  preview.addEventListener('load', load);

  openModal((close) => {
    setTimeout(load, 0);
    const picker = viewPicker([initialView], (keys) => {
      const key = keys[0] || null;
      viewKey = key;
      image = key ? capture([key])[key] : null;
      load();
    }, { single: true });
    return el('div', { class: 'report-modal' }, [
      el('div', {}, [
        el('div', { class: 'muted small', style: 'margin-bottom:4px', text: 'Container view to include:' }),
        picker,
      ]),
      preview,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Close', onClick: close }),
        el('button', {
          class: 'btn primary',
          text: 'Print',
          onClick: () => printManifest(project, scenario, user, image, viewKey),
        }),
      ]),
    ]);
  }, { title: 'Packing Manifest' });
}

/**
 * Controls & shortcuts reference. Replaces the old always-on hint bar with a
 * grouped, readable modal opened from the scene toolbar (or the "?" key).
 * Each entry is [keys[], description]; keys render as <kbd> chips.
 */
export function shortcutsModal() {
  const GROUPS = [
    ['Selection', [
      [['Click'], 'Select an item'],
      [['Shift', 'Click'], 'Add / remove from multi-selection'],
      [['Dbl-Click'], 'Open item details'],
    ]],
    ['Move', [
      [['Drag'], 'Move item (drops to floor, snaps to 1" grid)'],
      [['Shift', 'Drag'], 'Stack on the item below'],
      [['Drag'], 'Move whole selection as one group'],
      [['←', '↑', '↓', '→'], 'Nudge (hold Alt for a 6" step)'],
      [['PgUp', 'PgDn'], 'Raise / lower'],
    ]],
    ['Transform', [
      [['R'], 'Rotate 90°'],
      [['T'], 'Tip forward'],
      [['E'], 'Edit item'],
      [['Del'], 'Remove item'],
    ]],
    ['View', [
      [['L'], 'Toggle labels'],
      [['P'], 'Toggle Pending Items (staged beside container)'],
      [['G'], 'Toggle 1" snap-to-grid'],
      [['D'], 'Toggle door/jamb openings'],
      [['Ctrl/Cmd', 'Drag'], 'Orbit camera'],
      [['Shift', 'Ctrl/Cmd', 'Drag'], 'Pan view / move the pivot'],
      [['Scroll'], 'Zoom'],
    ]],
    ['Measure', [
      [['M'], 'Toggle the Measure tool'],
      [['Click', 'Click'], 'Set point A, then point B — reads the distance'],
      [['Shift', 'Click'], 'Lock B above/below A (vertical only — e.g. item to roof)'],
      [['Alt', 'Click'], 'Lock B level with A (horizontal only — e.g. item to wall)'],
      [['Esc'], 'Clear the current measurement'],
    ]],
  ];

  function keyRow([keys, desc]) {
    return el('div', { class: 'shortcuts-row' }, [
      el('span', { class: 'keys' }, keys.map((k) => el('kbd', { text: k }))),
      el('span', { class: 'desc', text: desc }),
    ]);
  }

  openModal(() => el('div', { class: 'shortcuts' },
    GROUPS.map(([title, rows]) =>
      el('div', { class: 'shortcuts-group' }, [
        el('h3', { text: title }),
        ...rows.map(keyRow),
      ])
    )
  ), { title: '⌨ Controls & Shortcuts' });
}

/**
 * Shipment summary modal: a cross-container roll-up. Each container loading is a
 * column, plus a "Shipment Total" column that sums the whole shipment. Below the
 * per-container stats is an inventory reconciliation table (total qty vs.
 * placed vs. remaining) so you can see what's still unshipped. onSwitch(id).
 */
export function compareModal(project, activeId, onSwitch) {
  const containers = project.scenarios;
  const stats = containers.map((s) => ({ s, st: scenarioStats(s) }));

  // Shipment-wide totals across every container loading.
  const totals = stats.reduce(
    (acc, x) => {
      acc.itemCount += x.st.itemCount;
      acc.totalWeight += x.st.totalWeight;
      acc.usedVolume += x.st.usedVolume;
      acc.containerVolume += x.st.containerVolume;
      acc.hazmatCount += x.st.hazmatCount;
      return acc;
    },
    { itemCount: 0, totalWeight: 0, usedVolume: 0, containerVolume: 0, hazmatCount: 0 }
  );
  const totalVolPct = totals.containerVolume
    ? (totals.usedVolume / totals.containerVolume) * 100 : 0;

  const header = el('tr', {}, [
    el('th', { text: 'Metric' }),
    ...stats.map((x) =>
      el('th', {}, [
        el('div', { text: x.s.name }),
        el('button', {
          class: 'btn small',
          text: x.s.id === activeId ? 'Active' : 'View',
          onClick: () => onSwitch(x.s.id),
        }),
      ])
    ),
    el('th', {}, [el('div', { text: 'Shipment Total' })]),
  ]);

  function row(label, fn, totalText) {
    return el('tr', {}, [
      el('td', { text: label }),
      ...stats.map((x) => el('td', { text: fn(x.st, x.s) })),
      el('td', { class: 'best', text: totalText }),
    ]);
  }

  const table = el('table', { class: 'compare-table' }, [
    header,
    row('Container', (_st, s) => getContainer(s.containerType).name,
      `${stats.length} container${stats.length === 1 ? '' : 's'}`),
    row('Items placed', (st) => String(st.itemCount), String(totals.itemCount)),
    row('Total weight', (st) => `${fmtLb(st.totalWeight)} (${fmtPct(st.weightPct)})`,
      fmtLb(totals.totalWeight)),
    row('Payload limit', (st) => fmtLb(st.payloadLb), '—'),
    row('Overweight?', (st) => (st.overweight ? '⚠ YES' : 'No'),
      stats.some((x) => x.st.overweight) ? '⚠ YES' : 'No'),
    row('Volume used', (st) => `${fmtFt3(st.usedVolume)} (${fmtPct(st.volumePct)})`,
      `${fmtFt3(totals.usedVolume)} (${fmtPct(totalVolPct)})`),
    row('Hazmat items', (st) => String(st.hazmatCount), String(totals.hazmatCount)),
    // Balance read-out per axis, straight from the same scenarioStats() model
    // the Balance panel and the auto-load scorer use.
    row('Front / Back',
      (st) => `${fmtPct(st.balance.length.frontPct)} / ${fmtPct(st.balance.length.backPct)}`,
      '—'),
    row('Left / Right',
      (st) => `${fmtPct(st.balance.width.leftPct)} / ${fmtPct(st.balance.width.rightPct)}`,
      '—'),
    row('Floor / Roof',
      (st) => (st.balance.height
        ? `${fmtPct(st.balance.height.floorPct)} / ${fmtPct(st.balance.height.roofPct)}`
        : '—'),
      '—'),
    // Auto-generated loadings carry the aggregate score of the winning
    // simulation; manually-built ones have none.
    row('Load score',
      (_st, s) => (s.loadScore ? `${(s.loadScore.total * 100).toFixed(0)} / 100` : '—'),
      (() => {
        const scored = containers.filter((s) => s.loadScore);
        if (!scored.length) return '—';
        const avg = scored.reduce((sum, s) => sum + s.loadScore.total, 0) / scored.length;
        return `${(avg * 100).toFixed(0)} / 100 avg`;
      })()),
  ]);

  // Inventory reconciliation: total available vs. placed across all containers
  // vs. remaining (unshipped). Placed count comes straight from placements so
  // it reflects the shared consumed pool.
  const placedByItem = new Map();
  for (const s of containers) {
    for (const p of s.placements || []) {
      if (!p.catalogItemId) continue;
      placedByItem.set(p.catalogItemId, (placedByItem.get(p.catalogItemId) || 0) + 1);
    }
  }
  const invRows = (project.catalog || []).map((it) => {
    const total = Math.max(0, Math.floor(it.qtyAvailable || 0));
    const placed = placedByItem.get(it.id) || 0;
    const remaining = Math.max(0, total - placed);
    return el('tr', { class: remaining > 0 ? '' : 'best' }, [
      el('td', { text: it.name }),
      el('td', { text: String(total) }),
      el('td', { text: String(placed) }),
      el('td', { text: String(remaining) }),
    ]);
  });
  const inventoryTable = el('table', { class: 'compare-table' }, [
    el('tr', {}, [
      el('th', { text: 'Item' }),
      el('th', { text: 'Available' }),
      el('th', { text: 'Placed' }),
      el('th', { text: 'Remaining' }),
    ]),
    ...invRows,
  ]);

  openModal((close) =>
    el('div', {}, [
      containers.length ? table : el('p', { class: 'muted', text: 'No container loadings yet.' }),
      el('h3', { text: 'Inventory reconciliation', style: 'margin-top:16px' }),
      (project.catalog || []).length
        ? inventoryTable
        : el('p', { class: 'muted', text: 'No catalog items.' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn primary', text: 'Close', onClick: close }),
      ]),
    ]),
    { title: 'Shipment Summary' }
  );
}

export { confirmDialog };
