// Catalog CSV import + downloadable sample template.
// Dimensions in the CSV are in inches (matching the item form); the catalog
// stores them internally in feet.

import { CATEGORIES, HAZMAT_CLASSES, makeCatalogItem } from './cargo.js';

// Canonical columns with accepted aliases (normalized: lowercase, no spaces).
const COLUMN_MAP = {
  name: ['name', 'itemname', 'item'],
  category: ['category', 'cat', 'type'],
  hazmatClass: ['hazmatclass', 'hazmat', 'hazclass', 'hazmat_class'],
  length: ['length', 'len', 'l'],
  width: ['width', 'w'],
  height: ['height', 'h'],
  weight: ['weight', 'lb', 'lbs'],
  qty: ['qty', 'quantity', 'count'],
};

const SAMPLE_HEADER = ['name', 'category', 'hazmatClass', 'length', 'width', 'height', 'weight', 'qty'];
const SAMPLE_ROWS = [
  ['Packaging Crate', 'general', '', 48, 42, 42, 850, 4],
  ['Generator Set', 'heavy', '', 90, 48, 54, 3200, 2],
  ['Glass Panels', 'fragile', '', 72, 36, 24, 260, 6],
  ['Solvent Drums', 'hazardous', '3', 30, 30, 40, 480, 3],
  ['Fresh Produce Totes', 'perishable', '', 24, 18, 12, 45, 10],
];

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[\s_-]+/g, '').trim();
}

function findColIndex(headerCells, canonical) {
  const aliases = COLUMN_MAP[canonical].map(normalizeHeader);
  return headerCells.findIndex((h) => aliases.includes(normalizeHeader(h)));
}

// RFC-4180-ish: comma separators, double-quoted cells, "" escapes, CRLF.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; }
        else { inQuotes = false; i += 1; }
      } else { cell += ch; i += 1; }
    } else if (ch === '"') {
      inQuotes = true; i += 1;
    } else if (ch === ',') {
      pushCell(); i += 1;
    } else if (ch === '\n') {
      pushRow(); i += 1;
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') { pushRow(); i += 2; } else { pushRow(); i += 1; }
    } else { cell += ch; i += 1; }
  }
  // Trailing record without newline.
  if (cell !== '' || row.length) pushRow();
  return rows;
}

function csvCell(raw) {
  const s = String(raw);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells) {
  return cells.map(csvCell).join(',');
}

/** Generate and download the sample/template CSV for the user. */
export function downloadSampleCatalogCSV() {
  // Guide lines must be single comma-free cells: spreadsheet apps split bare
  // commas into columns, which makes raw "# Label: v1, v2" notes look broken.
  // Pipes keep the lists clean and match the dialog's help text.
  const guide = [
    `# Valid categories: ${Object.keys(CATEGORIES).join('|')}`,
    `# Hazmat classes: ${Object.keys(HAZMAT_CLASSES).join('|')} (blank = none)`,
    '# Dimensions: length / width / height in inches',
    '# Weight: pounds',
    '# Qty: optional — defaults to 1',
  ];
  const lines = [
    ...guide,
    csvLine(SAMPLE_HEADER),
    ...SAMPLE_ROWS.map((r) => csvLine(r)),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'catalog-sample.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Parse CSV text into catalog items.
 * Returns { items, errors } — errors are { line, message } for skipped rows.
 */
export function parseCatalogCsv(text) {
  // Keep the original 1-based file line number on every row so error messages
  // stay accurate after blank/comment rows are filtered out below.
  const rows = parseCsvRows(String(text || ''))
    .map((cells, i) => ({ line: i + 1, cells: cells.map((c) => c.trim()) }))
    .filter((r) => r.cells.some((c) => c !== '')) // skip fully-blank rows
    .filter((r) => !(r.cells[0] && String(r.cells[0]).startsWith('#'))); // skip comment rows

  if (!rows.length) {
    return { items: [], errors: [{ line: 1, message: 'File is empty — no header row found.' }] };
  }

  const header = rows[0].cells;
  const idx = {};
  for (const canonical of Object.keys(COLUMN_MAP)) {
    idx[canonical] = findColIndex(header, canonical);
  }
  if (idx.name < 0) {
    return {
      items: [],
      errors: [{ line: rows[0].line, message: 'Header row is missing the required "name" column.' }],
    };
  }

  const items = [];
  const errors = [];
  const fieldOf = (row, canonical) => (idx[canonical] >= 0 ? row[idx[canonical]] : undefined);
  const numOf = (row, canonical) => {
    const raw = fieldOf(row, canonical);
    if (raw == null || raw === '') return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  };
  const enumOf = (row, canonical, classes) => {
    const raw = fieldOf(row, canonical);
    if (raw == null || raw === '') return undefined;
    const norm = String(raw).toLowerCase().trim();
    return classes[norm] ? classes[norm].id : undefined;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r].cells;
    const line = rows[r].line;
    const name = fieldOf(row, 'name');
    if (!name) { errors.push({ line, message: 'Missing name — row skipped.' }); continue; }

    const lengthIn = numOf(row, 'length');
    const widthIn = numOf(row, 'width');
    const heightIn = numOf(row, 'height');
    const weight = numOf(row, 'weight');
    const badDims = [lengthIn, widthIn, heightIn].every((v) => v == null);
    if (badDims) {
      errors.push({ line, message: 'Dimensions must be numbers (inches) — row skipped.' });
      continue;
    }

    const category = enumOf(row, 'category', CATEGORIES) || 'general';
    const hazmatClass = enumOf(row, 'hazmatClass', HAZMAT_CLASSES) || 'none';
    const qtyRaw = fieldOf(row, 'qty');

    items.push(makeCatalogItem({
      name,
      category,
      hazmatClass,
      length: lengthIn != null ? lengthIn / 12 : undefined,
      width: widthIn != null ? widthIn / 12 : undefined,
      height: heightIn != null ? heightIn / 12 : undefined,
      weight: weight != null ? weight : undefined,
      qtyAvailable: qtyRaw != null && qtyRaw !== '' ? Math.max(0, Math.floor(Number(qtyRaw) || 1)) : undefined,
    }));
  }

  return { items, errors };
}