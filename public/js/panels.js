// Render the left (scenarios/catalog/library), right (stats/staging) panels.
import { el } from './ui.js';
import { CATEGORIES, itemColor } from './cargo.js';
import { getContainer, fmtInches } from './container.js';
import { scenarioStats, fmtLb, fmtPct, fmtFt3 } from './stats.js';
import { BUILTIN_GROUPS, loadCustomPresets } from './library.js';

export function renderScenarios(project, activeId, handlers) {
  const host = document.getElementById('scenario-list');
  host.innerHTML = '';
  for (const s of project.scenarios) {
    const st = scenarioStats(s);
    host.appendChild(
      el('div', { class: `list-item ${s.id === activeId ? 'active' : ''}`,
          onClick: () => handlers.select(s.id) }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'title', text: s.name }),
          el('span', { class: 'sub', text: getContainer(s.containerType).name }),
        ]),
        el('div', { class: 'sub', text:
          `${st.itemCount} items · ${fmtPct(st.volumePct)} vol · ${fmtLb(st.totalWeight)}` }),
        el('div', { class: 'item-actions' }, [
          el('button', { class: 'btn small', text: 'Rename', onClick: (e) => { e.stopPropagation(); handlers.rename(s.id); } }),
          el('button', { class: 'btn small', text: 'Duplicate', onClick: (e) => { e.stopPropagation(); handlers.duplicate(s.id); } }),
          project.scenarios.length > 1
            ? el('button', { class: 'btn small danger', text: 'Delete', onClick: (e) => { e.stopPropagation(); handlers.remove(s.id); } })
            : null,
        ]),
      ])
    );
  }
}

export function renderCatalog(project, handlers, activeScenario) {
  const host = document.getElementById('catalog-list');
  host.innerHTML = '';
  if (!project.catalog.length) {
    host.appendChild(el('p', { class: 'muted small', text: 'No items yet. Add items or use the library.' }));
  }
  // Items are single independent units: each catalog item can be placed at most
  // once in the active scenario. Track what's already placed to disable re-placing.
  const placedIds = new Set(
    (activeScenario?.placements || [])
      .map((p) => p.catalogItemId)
      .filter(Boolean)
  );
  for (const it of project.catalog) {
    const isPlaced = placedIds.has(it.id);
    const placeBtn = isPlaced
      ? el('button', { class: 'btn small', text: 'Placed', disabled: '', title: 'Already placed in this scenario' })
      : el('button', { class: 'btn small primary', text: '+ Place', onClick: () => handlers.place(it.id) });
    host.appendChild(
      el('div', { class: `list-item ${isPlaced ? 'placed' : ''}` }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'title', text: it.name }),
          el('span', { class: 'chip', style: `background:${itemColor(it)}`, text: isPlaced ? 'placed' : 'available' }),
        ]),
        el('div', { class: 'sub', text:
          `${CATEGORIES[it.category]?.label || it.category} · ${fmtInches(it.length)}×${fmtInches(it.width)}×${fmtInches(it.height)} · ${Math.round(it.weight)} lb` }),
        el('div', { class: 'item-actions' }, [
          placeBtn,
          el('button', { class: 'btn small', text: 'Edit', onClick: () => handlers.edit(it.id) }),
          el('button', { class: 'btn small danger', text: 'Del', onClick: () => handlers.remove(it.id) }),
        ]),
      ])
    );
  }
}

export function renderLibrary(handlers) {
  const host = document.getElementById('library-list');
  host.innerHTML = '';
  for (const grp of BUILTIN_GROUPS) {
    host.appendChild(el('div', { class: 'sub', style: 'margin-top:4px;font-weight:600', text: grp.group }));
    for (const preset of grp.items) {
      host.appendChild(
        el('div', { class: 'list-item', onClick: () => handlers.add(preset) }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'title', text: preset.name }),
            el('span', { class: 'sub', text: `${fmtInches(preset.length)}×${fmtInches(preset.width)}×${fmtInches(preset.height)}` }),
          ]),
        ])
      );
    }
  }
  const custom = loadCustomPresets();
  if (custom.length) {
    host.appendChild(el('div', { class: 'sub', style: 'margin-top:4px;font-weight:600', text: 'My Presets' }));
    custom.forEach((preset, i) => {
      host.appendChild(
        el('div', { class: 'list-item' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'title', text: preset.name }),
            el('div', { class: 'item-actions' }, [
              el('button', { class: 'btn small primary', text: 'Add', onClick: () => handlers.add(preset) }),
              el('button', { class: 'btn small danger', text: 'Del', onClick: () => handlers.deletePreset(i) }),
            ]),
          ]),
        ])
      );
    });
  }
}

export function renderStats(scenario) {
  const host = document.getElementById('stats-panel');
  host.innerHTML = '';
  const st = scenarioStats(scenario);
  const wCls = st.overweight ? 'over' : st.weightPct > 85 ? 'warn' : '';
  const vCls = st.volumePct > 100 ? 'over' : st.volumePct > 90 ? 'warn' : '';

  const rowKV = (k, v) =>
    el('div', { class: 'stat-row' }, [el('span', { class: 'k', text: k }), el('span', { text: v })]);
  const bar = (cls, pct) =>
    el('div', { class: `bar ${cls}` }, [el('span', { style: `width:${Math.min(100, pct)}%` })]);

  host.appendChild(rowKV('Container', st.container.name));
  host.appendChild(rowKV('Items', String(st.itemCount)));
  host.appendChild(rowKV('Weight', `${fmtLb(st.totalWeight)} / ${fmtLb(st.payloadLb)}`));
  host.appendChild(bar(wCls, st.weightPct));
  host.appendChild(rowKV('Weight %', fmtPct(st.weightPct)));
  host.appendChild(rowKV('Volume', `${fmtFt3(st.usedVolume)} / ${fmtFt3(st.containerVolume)}`));
  host.appendChild(bar(vCls, st.volumePct));
  host.appendChild(rowKV('Volume %', fmtPct(st.volumePct)));
  if (st.hazmatCount) host.appendChild(rowKV('Hazmat items', String(st.hazmatCount)));
  if (st.overweight) host.appendChild(el('div', { class: 'sub', style: 'color:var(--danger)', text: '⚠ Over payload limit!' }));

  renderBalance(host, st.balance);
}

/**
 * Render the front/back and left/right weight-balance indicator.
 * Uses the "no more than N% of weight in one half" rule of thumb (N =
 * BALANCE_THRESHOLD) as the trigger, and also surfaces the center-of-gravity
 * offset from the geometric center — the metric the CTU Code cares about.
 */
function renderBalance(host, balance) {
  if (!balance) return;

  host.appendChild(
    el('div', {
      class: 'stat-section',
      title: `Guideline: no more than ${balance.threshold}% of weight in one half of the container (rule of thumb).`,
    }, [el('span', { class: 'k', text: 'Balance' })])
  );

  if (!balance.hasWeight) {
    host.appendChild(el('div', { class: 'sub muted', text: 'No weight placed yet.' }));
    return;
  }

  // A segmented histogram: one cell per floor bin (neg→pos), each cell's fill
  // height scaled to that bin's share of the heaviest bin, so the weight
  // profile is shown incrementally across the deck. Color: green when
  // balanced, amber near the threshold, red when unbalanced.
  const balanceRow = (label, axis, negLabel, posLabel, negPct, posPct) => {
    const near = balance.threshold - 5;
    const cls = axis.over ? 'over' : axis.heavierPct >= near ? 'warn' : '';
    const bins = axis.bins || [];
    const maxBin = Math.max(0, ...bins);
    // Center-of-gravity marker position along the bar (0% = neg end, 100% =
    // pos end). cogOffsetPct is signed [-100..100] from center.
    const cogMarkerPct = Math.min(100, Math.max(0, 50 + axis.cogOffsetPct / 2));
    const cells = bins.map((pct) => {
      const h = maxBin > 0 ? (pct / maxBin) * 100 : 0;
      return el('span', {
        class: 'cell',
        title: `${pct.toFixed(1)}% of load`,
      }, [el('span', { class: 'cell-fill', style: `height:${h}%;` })]);
    });
    const cog = axis.cogOffsetPct;
    const cogWhich = cog === 0 ? '' : (cog > 0 ? posLabel.text : negLabel.text);
    const cogText = Math.abs(cog) < 0.05
      ? 'CoG centered'
      : `CoG ${Math.abs(cog).toFixed(1)}% ${cogWhich}`;

    return el('div', { class: 'balance-item' }, [
      el('div', { class: 'stat-row' }, [
        el('span', { class: 'k', text: label }),
        el('span', {
          text: `${negPct.toFixed(0)}% / ${posPct.toFixed(0)}%`,
        }),
      ]),
      el('div', { class: `balance-hist ${cls}` }, [
        ...cells,
        el('span', { class: 'cog-marker', style: `left:${cogMarkerPct}%;` }),
      ]),
      el('div', { class: 'balance-labels' }, [
        el('span', { text: negLabel.text }),
        el('span', { class: 'muted', text: cogText }),
        el('span', { text: posLabel.text }),
      ]),
    ]);
  };

  host.appendChild(
    balanceRow(
      'Front / Back',
      balance.length,
      { text: 'Front', side: 'front' },
      { text: 'Back', side: 'back' },
      balance.length.frontPct,
      balance.length.backPct
    )
  );
  host.appendChild(
    balanceRow(
      'Left / Right',
      balance.width,
      { text: 'Left', side: 'left' },
      { text: 'Right', side: 'right' },
      balance.width.leftPct,
      balance.width.rightPct
    )
  );

  const problems = [];
  if (balance.length.over) {
    problems.push(`${balance.length.heavierPct.toFixed(0)}% ${balance.length.heavierSide}`);
  }
  if (balance.width.over) {
    problems.push(`${balance.width.heavierPct.toFixed(0)}% ${balance.width.heavierSide}`);
  }
  if (problems.length) {
    host.appendChild(
      el('div', {
        class: 'sub',
        style: 'color:var(--danger)',
        text: `⚠ Unbalanced load (>${balance.threshold}% in one half): ${problems.join(', ')}`,
      })
    );
  }
}

export function renderStaging(staging, handlers) {
  const host = document.getElementById('staging-list');
  host.innerHTML = '';
  if (!staging.length) {
    host.appendChild(el('p', { class: 'muted small', text: 'Empty. Removed items appear here.' }));
    return;
  }
  staging.forEach((p, i) => {
    host.appendChild(
      el('div', { class: 'list-item' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'title', text: p.name }),
          el('span', { class: 'sub', text: `${Math.round(p.weight)} lb` }),
        ]),
        el('div', { class: 'item-actions' }, [
          el('button', { class: 'btn small primary', text: 'Re-add', onClick: () => handlers.readd(i) }),
          el('button', { class: 'btn small danger', text: 'Discard', onClick: () => handlers.discard(i) }),
        ]),
      ])
    );
  });
}
