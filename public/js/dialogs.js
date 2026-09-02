// Project browser and admin user-management dialogs.
import { el, openModal, toast, confirmDialog } from './ui.js';
import { api } from './api.js';

/**
 * Projects browser. Callbacks: { onOpen(id), onNew(), onImport(file), canWrite }
 */
export async function projectsDialog(callbacks) {
  let data = { projects: [] };
  try {
    data = await api.listProjects();
  } catch (err) {
    toast(err.message, 'error');
  }

  openModal((close) => {
    const list = el('div', { class: 'list' });
    if (!data.projects.length) {
      list.appendChild(el('p', { class: 'muted', text: 'No projects yet.' }));
    }
    for (const p of data.projects) {
      list.appendChild(
        el('div', { class: 'list-item' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'title', text: p.name }),
            el('span', { class: 'chip', style: 'background:var(--accent-2)', text: p.visibility }),
          ]),
          el('div', { class: 'sub', text:
            `${p.catalogCount} catalog items · ${p.scenarioCount} scenarios · updated ${new Date(p.updated_at + 'Z').toLocaleString()}` }),
          el('div', { class: 'item-actions' }, [
            el('button', { class: 'btn small primary', text: 'Open', onClick: () => { close(); callbacks.onOpen(p.id); } }),
            p.canEdit
              ? el('button', { class: 'btn small danger', text: 'Delete', onClick: () => {
                  confirmDialog(`Delete project "${p.name}"?`, async () => {
                    try { await api.deleteProject(p.id); toast('Deleted', 'ok'); close(); projectsDialog(callbacks); }
                    catch (e) { toast(e.message, 'error'); }
                  });
                } })
              : null,
          ]),
        ])
      );
    }

    const fileInput = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) { callbacks.onImport(fileInput.files[0]); close(); }
    });

    return el('div', {}, [
      list,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Import JSON', onClick: () => fileInput.click() }),
        callbacks.canWrite
          ? el('button', { class: 'btn primary', text: '+ New Project', onClick: () => { close(); callbacks.onNew(); } })
          : null,
        el('button', { class: 'btn', text: 'Close', onClick: close }),
        fileInput,
      ]),
    ]);
  }, { title: 'Projects' });
}

/** Simple prompt for a project name + visibility. onCreate({name, visibility}). */
export function newProjectDialog(onCreate) {
  const name = el('input', { value: 'New Project' });
  const vis = el('select', {}, [
    el('option', { value: 'restricted', text: 'Restricted' }),
    el('option', { value: 'public', text: 'Public' }),
  ]);
  openModal((close) =>
    el('div', {}, [
      el('div', { class: 'form-grid' }, [
        el('label', { class: 'full-col' }, ['Name', name]),
        el('label', {}, ['Visibility', vis]),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Cancel', onClick: close }),
        el('button', { class: 'btn primary', text: 'Create', onClick: () => {
          onCreate({ name: name.value.trim() || 'New Project', visibility: vis.value });
          close();
        } }),
      ]),
    ]),
    { title: 'New Project' }
  );
}

/** Admin user-management dialog. */
export async function usersDialog() {
  let data = { users: [] };
  try {
    data = await api.listUsers();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  openModal((close) => {
    const list = el('div', { class: 'list' });
    for (const u of data.users) {
      const roleSel = el('select', {}, ['admin', 'editor', 'viewer'].map((r) =>
        el('option', { value: r, ...(r === u.role ? { selected: '' } : {}), text: r })
      ));
      list.appendChild(
        el('div', { class: 'list-item' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'title', text: u.username }),
            roleSel,
          ]),
          el('div', { class: 'item-actions' }, [
            el('button', { class: 'btn small', text: 'Update role', onClick: async () => {
              try { await api.updateUser(u.id, { role: roleSel.value }); toast('Updated', 'ok'); }
              catch (e) { toast(e.message, 'error'); }
            } }),
            el('button', { class: 'btn small danger', text: 'Delete', onClick: () => {
              confirmDialog(`Delete user "${u.username}"?`, async () => {
                try { await api.deleteUser(u.id); toast('Deleted', 'ok'); close(); usersDialog(); }
                catch (e) { toast(e.message, 'error'); }
              });
            } }),
          ]),
        ])
      );
    }

    const nu = el('input', { placeholder: 'username' });
    const np = el('input', { placeholder: 'password', type: 'password' });
    const nr = el('select', {}, ['viewer', 'editor', 'admin'].map((r) =>
      el('option', { value: r, text: r })
    ));

    return el('div', {}, [
      list,
      el('h3', { text: 'Add user' }),
      el('div', { class: 'form-grid' }, [
        el('label', {}, ['Username', nu]),
        el('label', {}, ['Password', np]),
        el('label', {}, ['Role', nr]),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn primary', text: 'Create user', onClick: async () => {
          try {
            await api.createUser({ username: nu.value.trim(), password: np.value, role: nr.value });
            toast('User created', 'ok'); close(); usersDialog();
          } catch (e) { toast(e.message, 'error'); }
        } }),
        el('button', { class: 'btn', text: 'Close', onClick: close }),
      ]),
    ]);
  }, { title: 'User Management' });
}
