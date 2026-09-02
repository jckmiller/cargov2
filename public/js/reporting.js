// Reporting: load plan generation, printable manifest & load plan, PNG export.
// Printouts are branded deliverables (A3 · Shipping Pro — 3D Container Loading).
import { fmtFeet, fmtInches } from './container.js';
import { scenarioStats, fmtLb, fmtPct, fmtFt3 } from './stats.js';

// ---------------------------------------------------------------------------
// Branding constants
// ---------------------------------------------------------------------------
const BRAND = {
  company: 'A3',
  product: 'Shipping Pro',
  tagline: '3D Container Loading',
  logo: '/assets/logo.png',
  accent: '#3b6fe0',
};

/** Human category labels look nicer title-cased on the printout. */
function titleCase(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(d = new Date()) {
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return d.toISOString();
  }
}

// ---------------------------------------------------------------------------
// Load plan model
// ---------------------------------------------------------------------------

/** Generate step-by-step loading instructions from a scenario. */
export function generateLoadPlan(scenario) {
  // Order: bottom layers first, then front-to-back, left-to-right.
  const ordered = [...scenario.placements].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 1e-6) return a.y - b.y;
    if (Math.abs(a.z - b.z) > 1e-6) return a.z - b.z;
    return a.x - b.x;
  });
  return ordered.map((p, i) => {
    const stacked = p.y > 1e-6;
    return {
      step: i + 1,
      name: p.name,
      category: p.category,
      hazmatClass: p.hazmatClass,
      weight: p.weight,
      dims: p.dims,
      pos: { x: p.x, y: p.y, z: p.z },
      stacked,
      // Backwards-compatible one-line description.
      text:
        `Place "${p.name}" at length ${fmtFeet(p.x)}, width ${fmtFeet(p.z)}, ` +
        `height ${fmtFeet(p.y)} ` +
        `(${fmtInches(p.dims.l)}×${fmtInches(p.dims.w)}×${fmtInches(p.dims.h)}, ${Math.round(p.weight)} lb)` +
        (stacked ? ' — stacked' : ' — floor'),
    };
  });
}


// ---------------------------------------------------------------------------
// Shared print chrome (masthead, meta grid, stat cards, print stylesheet)
// ---------------------------------------------------------------------------

/** Branded masthead: A3 logo lockup + document title/subtitle. */
function masthead(docTitle, docSubtitle) {
  return `<header class="rp-masthead">
    <div class="rp-brand">
      <img class="rp-logo" src="${BRAND.logo}" alt="${BRAND.company} logo"
           onerror="this.style.display='none'" />
      <div class="rp-brand-text">
        <span class="rp-company">${escapeHtml(BRAND.company)}</span>
        <span class="rp-product">${escapeHtml(BRAND.product)}</span>
        <span class="rp-tagline">${escapeHtml(BRAND.tagline)}</span>
      </div>
    </div>
    <div class="rp-doc">
      <h1 class="rp-doc-title">${escapeHtml(docTitle)}</h1>
      ${docSubtitle ? `<p class="rp-doc-sub">${escapeHtml(docSubtitle)}</p>` : ''}
    </div>
  </header>`;
}

/** A definition-style metadata grid. `entries` is an array of [label, value]. */
function metaGrid(entries) {
  const cells = entries
    .filter(([, v]) => v != null && v !== '')
    .map(
      ([label, value]) => `<div class="rp-meta-cell">
        <span class="rp-meta-label">${escapeHtml(label)}</span>
        <span class="rp-meta-value">${escapeHtml(String(value))}</span>
      </div>`
    )
    .join('');
  return `<section class="rp-meta">${cells}</section>`;
}

/** A row of summary stat cards. `cards` = [{ label, value, note, tone }]. */
function statCards(cards) {
  const items = cards
    .map(
      (c) => `<div class="rp-card${c.tone ? ' ' + c.tone : ''}">
        <span class="rp-card-value">${c.valueHtml || escapeHtml(String(c.value))}</span>
        <span class="rp-card-label">${escapeHtml(c.label)}</span>
        ${c.note ? `<span class="rp-card-note">${escapeHtml(c.note)}</span>` : ''}
      </div>`
    )
    .join('');
  return `<section class="rp-cards">${items}</section>`;
}

/**
 * A figure grid of rendered container views. `views` is a map like
 * { iso, side, front, top } of PNG data URLs; missing keys are skipped.
 * `only` optionally restricts/orders which views to show.
 */
function viewsFigure(views, only) {
  if (!views) return '';
  const labels = { iso: 'Isometric', side: 'Side View', front: 'Front View', top: 'Top View' };
  const keys = (only || ['iso', 'side', 'front', 'top']).filter((k) => views[k]);
  if (!keys.length) return '';
  const figs = keys
    .map(
      (k) => `<figure class="rp-figure">
        <img src="${views[k]}" alt="${escapeHtml(labels[k] || k)}" />
        <figcaption>${escapeHtml(labels[k] || k)}</figcaption>
      </figure>`
    )
    .join('');
  const single = keys.length === 1 ? ' rp-views-single' : '';
  return `<section class="rp-views${single}">${figs}</section>`;
}

/** Small colored status pill. */
function pill(text, tone = '') {
  return `<span class="rp-pill${tone ? ' ' + tone : ''}">${escapeHtml(text)}</span>`;
}

function reportFooter() {
  return `<footer class="rp-footer">
    <span>${escapeHtml(BRAND.company)} · ${escapeHtml(BRAND.product)} — ${escapeHtml(BRAND.tagline)}</span>
    <span>Generated ${escapeHtml(formatDate())}</span>
  </footer>`;
}


/** Self-contained print stylesheet (paper stock: white/ink + accent blue). */
function printStyles() {
  return `
  :root { --rp-accent: ${BRAND.accent}; --rp-accent-soft: #eaf0fd;
    --rp-ink: #16203a; --rp-muted: #61708f; --rp-border: #d8dfec;
    --rp-ok: #12a97b; --rp-warn: #d4870f; --rp-danger: #e0455a; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: var(--rp-ink); background: #fff; font-size: 12.5px; line-height: 1.5;
    padding: 28px 32px 64px;
  }
  .rp-doc-title, h1, h2, h3 { margin: 0; }

  /* Masthead */
  .rp-masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 24px; padding-bottom: 16px; border-bottom: 3px solid var(--rp-accent);
  }
  .rp-brand { display: flex; align-items: center; gap: 14px; }
  .rp-logo { height: 52px; width: auto; object-fit: contain; }
  .rp-brand-text { display: flex; flex-direction: column; line-height: 1.15; }
  .rp-company { font-size: 20px; font-weight: 800; letter-spacing: 0.02em; color: var(--rp-ink); }
  .rp-product { font-size: 13px; font-weight: 700; color: var(--rp-accent); text-transform: uppercase; letter-spacing: 0.08em; }
  .rp-tagline { font-size: 10.5px; color: var(--rp-muted); text-transform: uppercase; letter-spacing: 0.12em; }
  .rp-doc { text-align: right; }
  .rp-doc-title { font-size: 22px; font-weight: 800; color: var(--rp-ink); }
  .rp-doc-sub { margin: 2px 0 0; font-size: 12px; color: var(--rp-muted); }

  /* Meta grid */
  .rp-meta {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px;
    margin: 18px 0; background: var(--rp-border);
    border: 1px solid var(--rp-border); border-radius: 8px; overflow: hidden;
  }
  .rp-meta-cell { background: #fff; padding: 9px 12px; display: flex; flex-direction: column; gap: 2px; }
  .rp-meta-label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--rp-muted); font-weight: 700; }
  .rp-meta-value { font-size: 12.5px; font-weight: 600; color: var(--rp-ink); }

  /* Summary cards */
  .rp-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 18px 0; }
  .rp-card {
    border: 1px solid var(--rp-border); border-top: 3px solid var(--rp-accent);
    border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 3px;
    background: #fff;
  }
  .rp-card-value { font-size: 20px; font-weight: 800; color: var(--rp-ink); }
  .rp-card-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--rp-muted); font-weight: 700; }
  .rp-card-note { font-size: 10.5px; color: var(--rp-muted); }
  .rp-card.ok { border-top-color: var(--rp-ok); }
  .rp-card.warn { border-top-color: var(--rp-warn); }
  .rp-card.danger { border-top-color: var(--rp-danger); }

  /* Section heading */
  .rp-section-title {
    font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--rp-accent); margin: 22px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid var(--rp-border);
  }


  /* Container views (rendered snapshots) */
  .rp-views {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 8px 0 4px;
  }
  .rp-views-single { grid-template-columns: 1fr; }
  .rp-figure {
    margin: 0; border: 1px solid var(--rp-border); border-radius: 8px; overflow: hidden;
    background: #fff; break-inside: avoid;
  }
  .rp-figure img { display: block; width: 100%; height: auto; background: #f6f8fd; }
  .rp-figure figcaption {
    padding: 6px 10px; font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--rp-muted); border-top: 1px solid var(--rp-border);
  }

  /* Tables */
  .rp-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .rp-table thead th {
    background: var(--rp-accent); color: #fff; text-align: left; font-weight: 700;
    padding: 8px 10px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .rp-table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--rp-border); vertical-align: top; }
  .rp-table tbody tr:nth-child(even) td { background: #f6f8fd; }
  .rp-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rp-table .center { text-align: center; }
  .rp-table tfoot td {
    padding: 8px 10px; font-weight: 800; border-top: 2px solid var(--rp-accent);
    background: var(--rp-accent-soft);
  }
  .rp-empty { padding: 16px; text-align: center; color: var(--rp-muted); font-style: italic; }

  /* Chips + pills */
  .rp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 6px; align-items: center; }
  .rp-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border: 1px solid var(--rp-border); border-radius: 999px; background: #fff; font-size: 11px;
  }
  .rp-chip b { color: var(--rp-accent); }
  .rp-pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px;
    font-weight: 700; background: var(--rp-accent-soft); color: var(--rp-accent);
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  .rp-pill.ok { background: #e3f6ef; color: var(--rp-ok); }
  .rp-pill.warn { background: #fbf0dc; color: var(--rp-warn); }
  .rp-pill.danger { background: #fbe3e7; color: var(--rp-danger); }
  .rp-pill.muted { background: #eef1f6; color: var(--rp-muted); }

  .rp-note { font-size: 11.5px; color: var(--rp-muted); margin: 6px 0; }

  /* Footer */
  .rp-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; justify-content: space-between;
    padding: 8px 32px; font-size: 9.5px; color: var(--rp-muted);
    border-top: 1px solid var(--rp-border); background: #fff;
  }

  @page { margin: 14mm 12mm 18mm; }
  @media print {
    body { padding: 0 0 48px; }
    .rp-card, .rp-meta, .rp-table tr { break-inside: avoid; }
    thead { display: table-header-group; }
  }`;
}

/** Assemble a full, self-contained branded HTML document for a report body. */
export function reportDocument(docTitle, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8" />
     <title>${escapeHtml(BRAND.company)} ${escapeHtml(BRAND.product)} — ${escapeHtml(docTitle)}</title>
     <style>${printStyles()}</style></head>
     <body><div id="print-area">${bodyHtml}</div>${reportFooter()}</body></html>`;
}

/** Open a new window with the branded print chrome and trigger the dialog. */
function openPrintWindow(docTitle, bodyHtml) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(reportDocument(docTitle, bodyHtml));
  win.document.close();
  win.focus();
  // Give the logo/layout a beat to settle before invoking print.
  setTimeout(() => win.print(), 250);
}


// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function manifestHTML(project, scenario, user, isoImage) {
  const st = scenarioStats(scenario);
  const spec = st.container;

  const dims = `${fmtFeet(spec.length)} L × ${fmtFeet(spec.width)} W × ${fmtFeet(spec.height)} H`;

  const cards = statCards([
    { label: 'Items', value: st.itemCount },
    {
      label: 'Total Weight',
      valueHtml: escapeHtml(fmtLb(st.totalWeight)),
      note: `${fmtPct(st.weightPct)} of payload`,
      tone: st.overweight ? 'danger' : 'ok',
    },
    {
      label: 'Volume Used',
      valueHtml: escapeHtml(fmtPct(st.volumePct)),
      note: fmtFt3(st.usedVolume),
    },
    {
      label: 'Hazmat Items',
      value: st.hazmatCount,
      tone: st.hazmatCount > 0 ? 'warn' : '',
    },
  ]);

  // Category breakdown chips.
  const catEntries = Object.entries(st.byCategory || {}).sort((a, b) => b[1] - a[1]);
  const categoryChips = catEntries.length
    ? `<div class="rp-chips">${catEntries
        .map(([cat, n]) => `<span class="rp-chip">${escapeHtml(titleCase(cat))} <b>${n}</b></span>`)
        .join('')}</div>`
    : '<p class="rp-note">No categories recorded.</p>';

  const balanceHtml = balanceSummary(st.balance);

  const rows = scenario.placements
    .map((p, i) => {
      const haz = p.hazmatClass && p.hazmatClass !== 'none';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(titleCase(p.category))}</td>
        <td class="center">${haz ? pill(p.hazmatClass, 'danger') : '<span class="rp-pill muted">—</span>'}</td>
        <td>L ${escapeHtml(fmtFeet(p.x))} · W ${escapeHtml(fmtFeet(p.z))} · H ${escapeHtml(fmtFeet(p.y))}</td>
        <td>${fmtInches(p.dims.l)}×${fmtInches(p.dims.w)}×${fmtInches(p.dims.h)}</td>
        <td class="num">${Math.round(p.weight).toLocaleString()} lb</td>
      </tr>`;
    })
    .join('');

  const table = scenario.placements.length
    ? `<table class="rp-table">
        <thead><tr>
          <th class="num">#</th><th>Item</th><th>Category</th>
          <th class="center">Hazmat</th><th>Position (L·W·H)</th>
          <th>Dims (L×W×H)</th><th class="num">Weight</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="6">Total — ${st.itemCount} item${st.itemCount === 1 ? '' : 's'}</td>
          <td class="num">${escapeHtml(fmtLb(st.totalWeight))}</td>
        </tr></tfoot>
      </table>`
    : '<div class="rp-empty">No items placed in this scenario.</div>';

  return `${masthead('Packing Manifest', `${BRAND.product} · ${BRAND.tagline}`)}
    ${metaGrid([
      ['Project', project?.name || '—'],
      ['Scenario', scenario.name],
      ['Container', spec.name],
      ['Internal Dimensions', dims],
      ['Payload Limit', fmtLb(spec.payloadLb)],
      ['Prepared By', user?.username || '—'],
    ])}
    ${cards}
    ${st.overweight ? `<p class="rp-note">${pill('Over payload limit', 'danger')} Total weight exceeds the container payload rating.</p>` : ''}
    ${isoImage ? `<h2 class="rp-section-title">Container View</h2>
    ${viewsFigure({ iso: isoImage }, ['iso'])}
    <p class="rp-note">Isometric view of the loaded container with item labels.</p>` : ''}
    <h2 class="rp-section-title">Category Breakdown</h2>
    ${categoryChips}
    <h2 class="rp-section-title">Weight Distribution</h2>
    ${balanceHtml}
    <h2 class="rp-section-title">Cargo Items</h2>
    ${table}`;
}

/** Render a compact fore/aft & left/right balance summary from stats.balance. */
function balanceSummary(balance) {
  if (!balance || !balance.hasWeight) {
    return '<p class="rp-note">No weight recorded — balance not applicable.</p>';
  }
  const axis = (a, negLabel, posLabel) => {
    const side = a.heavierSide;
    const label = side === 'front' || side === 'left' ? negLabel
      : side === 'back' || side === 'right' ? posLabel : 'Centered';
    const offset = Math.abs(a.cogOffsetPct).toFixed(0);
    const tone = a.over ? 'warn' : 'ok';
    return `<span class="rp-chip">${escapeHtml(label)} <b>${a.heavierPct.toFixed(0)}%</b> ${pill(a.over ? 'Check' : 'OK', tone)} <span class="rp-note" style="margin:0">CoG ${offset}% off center</span></span>`;
  };
  return `<div class="rp-chips">
    ${axis(balance.length, 'Fore-heavy', 'Aft-heavy')}
    ${axis(balance.width, 'Left-heavy', 'Right-heavy')}
  </div>
  <p class="rp-note">Guideline: no single half should carry more than ${balance.threshold}% of total cargo weight.</p>`;
}

export function printManifest(project, scenario, user, isoImage) {
  openPrintWindow('Packing Manifest', manifestHTML(project, scenario, user, isoImage));
}


// ---------------------------------------------------------------------------
// Load plan
// ---------------------------------------------------------------------------

export function loadPlanHTML(scenario, project, user, views) {
  const steps = generateLoadPlan(scenario);
  const st = scenarioStats(scenario);
  const spec = st.container;
  const stackedCount = steps.filter((s) => s.stacked).length;

  const cards = statCards([
    { label: 'Load Steps', value: steps.length },
    { label: 'On Floor', value: steps.length - stackedCount, tone: 'ok' },
    { label: 'Stacked', value: stackedCount, tone: stackedCount ? 'warn' : '' },
    { label: 'Total Weight', valueHtml: escapeHtml(fmtLb(st.totalWeight)), note: `${fmtPct(st.weightPct)} of payload` },
  ]);

  const rows = steps
    .map(
      (s) => `<tr>
        <td class="num">${s.step}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>L ${escapeHtml(fmtFeet(s.pos.x))} · W ${escapeHtml(fmtFeet(s.pos.z))} · H ${escapeHtml(fmtFeet(s.pos.y))}</td>
        <td>${fmtInches(s.dims.l)}×${fmtInches(s.dims.w)}×${fmtInches(s.dims.h)}</td>
        <td class="num">${Math.round(s.weight).toLocaleString()} lb</td>
        <td class="center">${s.stacked ? pill('Stacked', 'warn') : pill('Floor', 'ok')}</td>
      </tr>`
    )
    .join('');

  const table = steps.length
    ? `<table class="rp-table">
        <thead><tr>
          <th class="num">Step</th><th>Item</th><th>Position (L·W·H)</th>
          <th>Dims (L×W×H)</th><th class="num">Weight</th><th class="center">Placement</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<div class="rp-empty">No items placed — nothing to load.</div>';

  return `${masthead('Load Plan', `${BRAND.product} · ${BRAND.tagline}`)}
    ${metaGrid([
      ['Project', project?.name || '—'],
      ['Scenario', scenario.name],
      ['Container', spec.name],
      ['Prepared By', user?.username || '—'],
    ])}
    ${cards}
    ${viewsFigure(views) ? `<h2 class="rp-section-title">Container Views</h2>
    ${viewsFigure(views)}` : ''}
    <p class="rp-note">Load in the sequence shown: bottom layers first, then front-to-back, left-to-right.</p>
    <h2 class="rp-section-title">Loading Sequence</h2>
    ${table}`;
}

export function printLoadPlan(scenario, project, user, views) {
  openPrintWindow('Load Plan', loadPlanHTML(scenario, project, user, views));
}

// ---------------------------------------------------------------------------
// PNG export + utilities
// ---------------------------------------------------------------------------

export function downloadPNG(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

