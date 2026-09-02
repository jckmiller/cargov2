// Modal forms for catalog items, projects, users, compare, load plan/manifest.
import { el, openModal, toast, confirmDialog } from './ui.js';
import { CATEGORIES, HAZMAT_CLASSES, makeCatalogItem } from './cargo.js';
import { CONTAINER_TYPES, getContainer } from './container.js';
import { STRATEGIES, DEFAULT_MAX_CONTAINERS } from './autoload.js';
import { scenarioStats, fmtLb, fmtPct, fmtFt3 } from './stats.js';
import { saveCustomPreset } from './library.js';
import { loadPlanHTML, reportDocument, printLoadPlan } from './reporting.js';
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
  const savePreset = el('input', { type: 'checkbox' });

  openModal((close) => {
    function submit() {
      const out = makeCatalogItem({
        id: item.id,
        name: f.name.value.trim() || 'Item',
        category: catSel.value,
        hazmatClass: hazSel.value,
        length: parseFloat(f.length.value) / 12,
        width: parseFloat(f.width.value) / 12,
        height: parseFloat(f.height.value) / 12,
        weight: parseFloat(f.weight.value),
        qtyAvailable: parseInt(f.qty.value, 10),
        stackOn: item.stackOn,
        stackUnder: item.stackUnder,
        color: item.color,
      });
      if (savePreset.checked) {
        saveCustomPreset(out);
        toast('Saved as custom preset', 'ok');
      }
      onSave(out);
      close();
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
              'category, hazmatClass, length, width, height, weight, qty (optional). ' +
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
 * onGenerate({ containerType, strategy, maxContainers }).
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
  openModal((close) =>
    el('div', {}, [
      el('p', {
        class: 'muted small',
        text:
          'Best-fills the project inventory across as many containers as needed: ' +
          'it packs one container as full as possible, locks it as its own ' +
          'scenario, then loads the remaining items into the next container.',
      }),
      el('div', { class: 'form-grid' }, [
        el('label', {}, ['Container', contSel]),
        el('label', {}, ['Strategy', stratSel]),
        el('label', {}, ['Max containers', maxInput]),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Cancel', onClick: close }),
        el('button', {
          class: 'btn primary',
          text: 'Generate',
          onClick: () => {
            const maxContainers = Math.max(
              1,
              Math.floor(Number(maxInput.value) || DEFAULT_MAX_CONTAINERS)
            );
            onGenerate({
              containerType: contSel.value,
              strategy: stratSel.value,
              maxContainers,
            });
            close();
          },
        }),
      ]),
    ]),
    { title: '🧠 Auto-Generate Load Plan' }
  );
}

/** Load plan modal: branded preview (isolated iframe) + print. */
export function loadPlanModal(scenario, project, user, views) {
  const preview = el('iframe', {
    class: 'report-preview',
    title: 'Load Plan preview',
  });
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
    return el('div', { class: 'report-modal' }, [
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

/** Comparison modal: stats table across all scenarios. onSwitch(id). */
export function compareModal(project, activeId, onSwitch) {
  const scenarios = project.scenarios;
  const stats = scenarios.map((s) => ({ s, st: scenarioStats(s) }));
  const bestVol = Math.max(...stats.map((x) => x.st.volumePct), 0);
  const bestItems = Math.max(...stats.map((x) => x.st.itemCount), 0);

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
  ]);

  function row(label, fn, bestTest) {
    return el('tr', {}, [
      el('td', { text: label }),
      ...stats.map((x) => {
        const val = fn(x.st, x.s);
        const isBest = bestTest ? bestTest(x.st) : false;
        return el('td', { class: isBest ? 'best' : '', text: val });
      }),
    ]);
  }

  const table = el('table', { class: 'compare-table' }, [
    header,
    row('Container', (_st, s) => getContainer(s.containerType).name),
    row('Items placed', (st) => String(st.itemCount), (st) => st.itemCount === bestItems && bestItems > 0),
    row('Total weight', (st) => `${fmtLb(st.totalWeight)} (${fmtPct(st.weightPct)})`),
    row('Payload limit', (st) => fmtLb(st.payloadLb)),
    row('Overweight?', (st) => (st.overweight ? '⚠ YES' : 'No')),
    row('Volume used', (st) => `${fmtFt3(st.usedVolume)} (${fmtPct(st.volumePct)})`,
      (st) => st.volumePct === bestVol && bestVol > 0),
    row('Hazmat items', (st) => String(st.hazmatCount)),
  ]);

  openModal((close) =>
    el('div', {}, [
      stats.length ? table : el('p', { class: 'muted', text: 'No scenarios to compare.' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn primary', text: 'Close', onClick: close }),
      ]),
    ]),
    { title: 'Compare Scenarios' }
  );
}

export { confirmDialog };
