// UI primitives: DOM helpers, toasts, modal builder.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function toast(message, kind = '') {
  const host = document.getElementById('toast-host');
  // Cap the stack at 4 toasts.
  while (host.children.length >= 4) host.firstChild.remove();
  const t = el('div', { class: `toast ${kind}`, text: message });
  const dismiss = () => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(20px)';
    setTimeout(() => t.remove(), 300);
  };
  t.addEventListener('click', dismiss); // click-to-dismiss
  host.appendChild(t);
  setTimeout(dismiss, 2800);
}

/**
 * Open a modal. `render(close)` returns a DOM node placed inside the modal body.
 * Options: { title } renders a header bar with a ✕ close button.
 * Escape closes; backdrop click closes; first field is focused.
 * Returns a close() function.
 */
export function openModal(render, options = {}) {
  const host = document.getElementById('modal-host');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  backdrop.appendChild(modal);
  host.appendChild(backdrop);

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  // Optional header with title + close button.
  const header = el('div', { class: 'modal-header' }, [
    el('h2', { text: options.title || '' }),
    el('button', { class: 'modal-close', 'aria-label': 'Close', text: '✕', onClick: close }),
  ]);
  if (!options.title) header.querySelector('h2').style.display = 'none';

  const content = el('div', { class: 'modal-content' }, [render(close)]);
  modal.appendChild(header);
  modal.appendChild(content);

  // Focus the first focusable field for keyboard users.
  const focusable = modal.querySelector('input, select, textarea, button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);

  return close;
}

/**
 * Wire a collapsible panel: clicking its .collapse-toggle hides .panel-body.
 * Persists collapsed state in localStorage under `a3_panel_<key>`.
 * Calls onToggle() after the height transition (e.g. to resize the 3D canvas).
 */
export function makeCollapsible(panelEl, key, onToggle) {
  const toggle = panelEl.querySelector('.collapse-toggle');
  const body = panelEl.querySelector('.panel-body');
  if (!toggle || !body) return;

  const storeKey = `a3_panel_${key}`;
  const setState = (collapsed, animate = true) => {
    if (!animate) body.style.transition = 'none';
    if (collapsed) {
      body.style.maxHeight = body.scrollHeight + 'px';
      requestAnimationFrame(() => {
        panelEl.classList.add('collapsed');
        body.style.maxHeight = '0px';
      });
    } else {
      panelEl.classList.remove('collapsed');
      body.style.maxHeight = body.scrollHeight + 'px';
      const clear = () => {
        body.style.maxHeight = '';
        body.removeEventListener('transitionend', clear);
      };
      body.addEventListener('transitionend', clear);
    }
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (!animate) requestAnimationFrame(() => { body.style.transition = ''; });
    localStorage.setItem(storeKey, collapsed ? '1' : '0');
  };

  // Restore saved state (no animation on load).
  if (localStorage.getItem(storeKey) === '1') setState(true, false);

  toggle.addEventListener('click', () => {
    const collapsed = !panelEl.classList.contains('collapsed');
    setState(collapsed);
    if (onToggle) setTimeout(onToggle, 300);
  });
}

export function confirmDialog(message, onYes) {
  openModal(
    (close) =>
      el('div', {}, [
        el('p', { text: message }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn', onClick: close, text: 'Cancel' }),
          el('button', {
            class: 'btn danger',
            text: 'Confirm',
            onClick: () => {
              close();
              onYes();
            },
          }),
        ]),
      ]),
    { title: 'Confirm' }
  );
}
