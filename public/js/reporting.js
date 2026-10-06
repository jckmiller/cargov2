// Reporting: load plan generation, printable manifest & load plan, PNG export.
// Printouts are branded deliverables (A3 · Shipping Pro — 3D Container Loading).
import { fmtFeet, fmtInches, getOpenings } from './container.js';
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

/**
 * Summarize a container's clear door/jamb openings for a printout, e.g.
 * "End doors 7' 8" W x 7' 5" H". This is the hole cargo must actually pass
 * through — always smaller than the internal cross-section.
 */
function openingsSummary(spec) {
  const openings = getOpenings(spec);
  if (!openings.length) return null;
  return openings
    .map((op) => `${op.label} ${fmtFeet(op.width)} W × ${fmtFeet(op.height)} H`)
    .join(' · ');
}

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

// Tolerance for "flush against a surface": ~1 inch.
const FLUSH_EPS = 1 / 12;

/**
 * Find the item a placement is resting on: the tallest placement beneath it
 * whose footprint overlaps. Returns null for floor placements.
 */
function findSupport(p, placements) {
  let best = null;
  for (const q of placements) {
    if (q === p || q.y >= p.y - FLUSH_EPS) continue;
    const overlapX = Math.min(p.x + p.dims.l, q.x + q.dims.l) - Math.max(p.x, q.x);
    const overlapZ = Math.min(p.z + p.dims.w, q.z + q.dims.w) - Math.max(p.z, q.z);
    if (overlapX > FLUSH_EPS && overlapZ > FLUSH_EPS && (!best || q.y > best.y)) best = q;
  }
  return best;
}

/**
 * Human-readable location phrase, anchored to what the loader can see from
 * the doors. Boundary-flush coordinates become words; the length position is
 * given as distance from the rear doors (the direction cargo travels in),
 * since "L 7' 5"" from the front wall is unusable without a diagram.
 */
export function locationText(p, spec) {
  const parts = [];
  const gapDoors = spec.length - (p.x + p.dims.l);
  if (p.x <= FLUSH_EPS) parts.push('front wall');
  else if (gapDoors <= FLUSH_EPS) parts.push('at rear doors');
  else parts.push(`${fmtFeet(gapDoors)} from rear doors`);

  const gapRight = spec.width - (p.z + p.dims.w);
  if (p.z <= FLUSH_EPS) parts.push('left wall');
  else if (gapRight <= FLUSH_EPS) parts.push('right wall');
  else if (Math.abs(gapRight - p.z) <= FLUSH_EPS) parts.push('centered');
  else parts.push(p.z < gapRight ? `${fmtFeet(p.z)} from left wall` : `${fmtFeet(gapRight)} from right wall`);

  // Height is omitted for floor placement — the Placement column already
  // says "On floor" / "Stacked on …", which is the useful instruction.
  if (p.y > FLUSH_EPS) parts.push(`${fmtFeet(p.y)} high`);
  return parts.join(' · ');
}

/** Placement label: how this item is supported. */
export function placementText(p, placements) {
  const support = findSupport(p, placements);
  return support ? `Stacked on ${support.name}` : 'On floor';
}

/**
 * Generate step-by-step loading instructions from a container loading.
 */
export function generateLoadPlan(scenario) {
  // Order: farthest from the doors first (x asc — front wall is x=0, doors at
  // x=length), then each stack bottom-to-top (y asc) so items load right after
  // what supports them, then left-to-right (z asc) as a tie-break within the
  // same depth. This walks the loader from the nose to the doors once instead
  // of layer-by-layer round trips.
  const ordered = [...scenario.placements].sort((a, b) => {
    if (Math.abs(a.x - b.x) > 1e-6) return a.x - b.x;
    if (Math.abs(a.y - b.y) > 1e-6) return a.y - b.y;
    return a.z - b.z;
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
      stackedOn: findSupport(p, scenario.placements)?.name || null,
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

/** Branded masthead: A3 logo lockup + document title/subtitle.
 * `opts.hideCompany` omits the company wordmark ("A3") above the product name. */
function masthead(docTitle, docSubtitle, opts = {}) {
  return `<header class="rp-masthead">
    <div class="rp-brand">
      <img class="rp-logo" src="${BRAND.logo}" alt="${BRAND.company} logo"
           onerror="this.style.display='none'" />
      <div class="rp-brand-text">
        ${opts.hideCompany ? '' : `<span class="rp-company">${escapeHtml(BRAND.company)}</span>`}
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
  // Intentionally empty labels/values are kept (rendered as blank cells) so the
  // 3-column layout stays aligned; null/undefined still drop the cell.
  const cells = entries
    .filter(([, v]) => v != null)
    .map(
      ([label, value]) => `<div class="rp-meta-cell${!label && !value ? ' rp-meta-cell-empty' : ''}">
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
  const labels = {
    iso: 'Isometric', side: 'Side View', front: 'Front View', top: 'Top View',
    current: 'Custom View',
  };
  const keys = (only || ['iso', 'side', 'front', 'top', 'current']).filter((k) => views[k]);
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
    color: var(--rp-ink); background: #fff; font-size: 11.5px; line-height: 1.5;
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
  .rp-company { font-size: 19px; font-weight: 800; letter-spacing: 0.02em; color: var(--rp-ink); }
  .rp-product { font-size: 12px; font-weight: 700; color: var(--rp-accent); text-transform: uppercase; letter-spacing: 0.08em; }
  .rp-tagline { font-size: 9.5px; color: var(--rp-muted); text-transform: uppercase; letter-spacing: 0.12em; }
  .rp-doc { text-align: right; }
  .rp-doc-title { font-size: 21px; font-weight: 800; color: var(--rp-ink); }
  .rp-doc-sub { margin: 2px 0 0; font-size: 11px; color: var(--rp-muted); }

  /* Meta grid */
  .rp-meta {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px;
    margin: 18px 0; background: var(--rp-border);
    border: 1px solid var(--rp-border); border-radius: 8px; overflow: hidden;
  }
  .rp-meta-cell { background: #fff; padding: 9px 12px; display: flex; flex-direction: column; gap: 2px; }
  .rp-meta-label { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--rp-muted); font-weight: 700; }
  .rp-meta-value { font-size: 11.5px; font-weight: 600; color: var(--rp-ink); }
  /* The meta cell dividers rely on background fills, which browsers strip
     when printing unless told to keep them — force exact colors. */
  .rp-meta { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* Manifest: light but visible borders around every meta cell; the skipped
     filler cell (the blank one below Tare) is lightly grayed out. */
  .rp-manifest .rp-meta { gap: 0; background: #fff; }
  .rp-manifest .rp-meta-cell {
    border: 1px solid var(--rp-border);
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .rp-manifest .rp-meta-cell-empty { background: #eff2f8; }

  /* Summary cards: auto-fit so 3 or 4 cards each fill the row evenly. */
  .rp-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0; }
  .rp-card {
    border: 1px solid var(--rp-border); border-top: 3px solid var(--rp-accent);
    border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 3px;
    background: #fff;
  }
  .rp-card-value { font-size: 19px; font-weight: 800; color: var(--rp-ink); }
  .rp-card-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--rp-muted); font-weight: 700; }
  .rp-card-note { font-size: 9.5px; color: var(--rp-muted); }
  .rp-card.ok { border-top-color: var(--rp-ok); }
  .rp-card.warn { border-top-color: var(--rp-warn); }
  .rp-card.danger { border-top-color: var(--rp-danger); }

  /* Section heading */
  .rp-section-title {
    font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--rp-accent); margin: 22px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid var(--rp-border);
  }


  /* Container views (rendered snapshots) */
  .rp-views {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 8px 0 4px;
  }
  .rp-views-single { grid-template-columns: 1fr; }
  /* A single full-width view must fit on page 1 below the masthead/meta/cards,
     so cap its height and letterbox the image inside. */
  .rp-views-single .rp-figure img {
    max-height: 105mm; object-fit: contain; margin: 0 auto;
  }
  .rp-figure {
    margin: 0; border: 1px solid var(--rp-border); border-radius: 8px; overflow: hidden;
    background: #fff; break-inside: avoid;
  }
  .rp-figure img { display: block; width: 100%; height: auto; background: #f6f8fd; }
  .rp-figure figcaption {
    padding: 6px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--rp-muted); border-top: 1px solid var(--rp-border);
  }

  /* Tables */
  .rp-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  .rp-table thead th {
    background: var(--rp-accent); color: #fff; text-align: left; font-weight: 700;
    padding: 8px 10px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em;
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
    border: 1px solid var(--rp-border); border-radius: 999px; background: #fff; font-size: 10px;
  }
  .rp-chip b { color: var(--rp-accent); }
  .rp-pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 9px;
    font-weight: 700; background: var(--rp-accent-soft); color: var(--rp-accent);
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  .rp-pill.ok { background: #e3f6ef; color: var(--rp-ok); }
  .rp-pill.warn { background: #fbf0dc; color: var(--rp-warn); }
  .rp-pill.danger { background: #fbe3e7; color: var(--rp-danger); }
  .rp-pill.muted { background: #eef1f6; color: var(--rp-muted); }

  .rp-note { font-size: 10.5px; color: var(--rp-muted); margin: 6px 0; }

  /* A heading must never be stranded at the bottom of a page without its
     content — keep it glued to the next block. */
  .rp-section-title { break-after: avoid; }

  /* Footer */
  .rp-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; justify-content: space-between;
    padding: 8px 32px; font-size: 8.5px; color: var(--rp-muted);
    border-top: 1px solid var(--rp-border); background: #fff;
  }

  /* Packing Manifest only: page 1 must hold the masthead + meta grid + cards +
     the container view, so the frontmatter is compacted ("the window") while
     the single view figure is enlarged — keeping the post-view page break
     meaningful instead of stranding a near-empty page. */
  .rp-manifest .rp-masthead { padding-bottom: 12px; }
  .rp-manifest .rp-logo { height: 44px; }
  .rp-manifest .rp-meta { margin: 12px 0; }
  .rp-manifest .rp-meta-cell { padding: 6px 10px; }
  .rp-manifest .rp-cards { margin: 12px 0; }
  .rp-manifest .rp-card { padding: 8px 12px; }
  .rp-manifest .rp-card-value { font-size: 16px; }
  .rp-manifest .rp-section-title { margin: 14px 0 6px; }
  .rp-manifest .rp-views-single .rp-figure img { max-height: 128mm; }

  @page { margin: 14mm 12mm 18mm; }
  @media print {
    body { padding: 0 0 48px; }
    .rp-card, .rp-meta, .rp-table tr { break-inside: avoid; }
    thead { display: table-header-group; }
    /* End page 1 after the rendered container view: everything that follows
       (Category Breakdown, Weight Distribution, Cargo Items) starts on a fresh
       page instead of being clipped at the bottom of page 1. */
    .rp-break-after { break-after: page; }
  }`;
}

/** Assemble a full, self-contained branded HTML document for a report body.
 *  `opts.bodyClass` adds a class to <body> for report-specific print styling. */
export function reportDocument(docTitle, bodyHtml, opts = {}) {
  return `<!doctype html><html><head><meta charset="utf-8" />
     <title>${escapeHtml(BRAND.company)} ${escapeHtml(BRAND.product)} — ${escapeHtml(docTitle)}</title>
     <style>${printStyles()}</style></head>
     <body class="${opts.bodyClass || ''}"><div id="print-area">${bodyHtml}</div>${reportFooter()}</body></html>`;
}

/** Open a new window with the branded print chrome and trigger the dialog. */
function openPrintWindow(docTitle, bodyHtml, opts = {}) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(reportDocument(docTitle, bodyHtml, opts));
  win.document.close();
  win.focus();
  // Give the logo/layout a beat to settle before invoking print.
  setTimeout(() => win.print(), 250);
}


// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function manifestHTML(project, scenario, user, viewImage, viewKey = 'iso') {
  const st = scenarioStats(scenario);
  const spec = st.container;

  const dims = `${fmtFeet(spec.length)} L × ${fmtFeet(spec.width)} W × ${fmtFeet(spec.height)} H`;

  // Manifest summary: Items / Volume Used / Hazmat Items (no Total Weight card).
  const cards = statCards([
    { label: 'Items', value: st.itemCount },
    {
      label: 'Volume Used',
      valueHtml: escapeHtml(fmtPct(st.volumePct)),
      note: fmtFt3(st.usedVolume),
    },
    {
      label: 'Hazmat Items',
      value: st.hazmatCount,
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
        <td class="center">${haz ? pill(p.hazmatClass) : '<span class="rp-pill muted">—</span>'}</td>
        <td>${escapeHtml(locationText(p, spec))}</td>
        <td>${fmtInches(p.dims.l)}×${fmtInches(p.dims.w)}×${fmtInches(p.dims.h)}</td>
        <td class="num">${Math.round(p.weight).toLocaleString()} lb</td>
      </tr>`;
    })
    .join('');

  const table = scenario.placements.length
    ? `<table class="rp-table">
        <thead><tr>
          <th class="num">#</th><th>Item</th><th>Category</th>
          <th class="center">Hazmat</th><th>Location</th>
          <th>Dims (L×W×H)</th><th class="num">Weight</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="6">Total — ${st.itemCount} item${st.itemCount === 1 ? '' : 's'}</td>
          <td class="num">${escapeHtml(fmtLb(st.totalWeight))}</td>
        </tr></tfoot>
      </table>`
    : '<div class="rp-empty">No items placed in this container loading.</div>';

  // Meta grid: 4 rows × 3 columns (gross values derived from tare + payload;
  // row 3 shows limits, row 4 shows actual payload/gross).
  const cubicFeet = spec.length * spec.width * spec.height;

  return `${masthead('Packing Manifest', null, { hideCompany: true })}
    ${metaGrid([
      ['Project', project?.name || '—'],
      ['Container Loading', scenario.name],
      ['Prepared By', user?.username || '—'],
      ['Container', spec.name],
      ['Internal Dimensions', dims],
      ['Cubic Feet Total', fmtFt3(cubicFeet)],
      ['Tare', fmtLb(spec.tareLb)],
      ['Payload Limit', fmtLb(spec.payloadLb)],
      ['Max Gross', fmtLb(spec.tareLb + spec.payloadLb)],
      ['', ''],
      ['Payload', fmtLb(st.totalWeight)],
      ['Gross', fmtLb(spec.tareLb + st.totalWeight)],
    ])}
    ${cards}
    ${viewImage ? `<h2 class="rp-section-title">Container View</h2>
    <div class="rp-break-after">${viewsFigure({ [viewKey]: viewImage }, [viewKey])}
    <p class="rp-note">View of the loaded container with item labels.</p></div>` : ''}
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
    return `<span class="rp-chip">${escapeHtml(label)} <b>${a.heavierPct.toFixed(0)}%</b> <span class="rp-note" style="margin:0">CoG ${offset}% off center</span></span>`;
  };
  return `<div class="rp-chips">
    ${axis(balance.length, 'Fore-heavy', 'Aft-heavy')}
    ${axis(balance.width, 'Left-heavy', 'Right-heavy')}
  </div>
  <p class="rp-note">Guideline: no single half should carry more than ${balance.threshold}% of total cargo weight.</p>`;
}

export function printManifest(project, scenario, user, viewImage, viewKey = 'iso') {
  openPrintWindow('Packing Manifest', manifestHTML(project, scenario, user, viewImage, viewKey), {
    bodyClass: 'rp-manifest',
  });
}


// ---------------------------------------------------------------------------
// Load plan
// ---------------------------------------------------------------------------

export function loadPlanHTML(scenario, project, user, views) {
  const steps = generateLoadPlan(scenario);
  const st = scenarioStats(scenario);
  const spec = st.container;
  const stackedCount = steps.filter((s) => s.stacked).length;

  // Intro mirrors the Packing Manifest: same stat cards (Items / Volume Used /
  // Hazmat Items) so the two deliverables present one consistent summary.
  const cards = statCards([
    { label: 'Items', value: st.itemCount },
    {
      label: 'Volume Used',
      valueHtml: escapeHtml(fmtPct(st.volumePct)),
      note: fmtFt3(st.usedVolume),
    },
    {
      label: 'Hazmat Items',
      value: st.hazmatCount,
    },
  ]);

  const rows = steps
    .map(
      (s) => `<tr>
        <td class="num">${s.step}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(locationText({ ...s.pos, dims: s.dims }, spec))}</td>
        <td>${fmtInches(s.dims.l)}×${fmtInches(s.dims.w)}×${fmtInches(s.dims.h)}</td>
        <td class="num">${Math.round(s.weight).toLocaleString()} lb</td>
        <td class="center">${s.stackedOn ? pill(`Stacked on ${s.stackedOn}`) : pill('On floor')}</td>
      </tr>`
    )
    .join('');

  const table = steps.length
    ? `<table class="rp-table">
        <thead><tr>
          <th class="num">Step</th><th>Item</th><th>Location</th>
          <th>Dims (L×W×H)</th><th class="num">Weight</th><th class="center">Placement</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<div class="rp-empty">No items placed — nothing to load.</div>';

  // Meta grid mirrors the Manifest's 4 rows × 3 columns (gross values derived
  // from tare + payload; row 3 shows limits, row 4 shows actual payload/gross),
  // with the load-relevant Clear Door Opening kept in row 2.
  const dims = `${fmtFeet(spec.length)} L × ${fmtFeet(spec.width)} W × ${fmtFeet(spec.height)} H`;
  const cubicFeet = spec.length * spec.width * spec.height;

  return `${masthead('Load Plan', null, { hideCompany: true })}
    ${metaGrid([
      ['Project', project?.name || '—'],
      ['Container Loading', scenario.name],
      ['Prepared By', user?.username || '—'],
      ['Container', spec.name],
      ['Internal Dimensions', dims],
      ['Clear Door Opening', openingsSummary(spec)],
      ['Cubic Feet Total', fmtFt3(cubicFeet)],
      ['Tare', fmtLb(spec.tareLb)],
      ['Payload Limit', fmtLb(spec.payloadLb)],
      ['Max Gross', fmtLb(spec.tareLb + spec.payloadLb)],
      ['Payload', fmtLb(st.totalWeight)],
      ['Gross', fmtLb(spec.tareLb + st.totalWeight)],
    ])}
    ${cards}
    ${viewsFigure(views) ? `<h2 class="rp-section-title">Container Views</h2>
    ${viewsFigure(views)}` : ''}
    <p class="rp-note">Load in the sequence shown: start at the point furthest from the doors, stack each position fully, then work back toward the doors. ${steps.length} step${steps.length === 1 ? '' : 's'} — ${steps.length - stackedCount} on the floor, ${stackedCount} stacked.</p>
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

