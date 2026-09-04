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
            `${p.catalogCount} catalog items · ${p.scenarioCount} container loadings · updated ${new Date(p.updated_at + 'Z').toLocaleString()}` }),
          el('div', { class: 'item-actions' }, [
            el('button', { class: 'btn small primary', text: 'Open', onClick: () => { close(); callbacks.onOpen(p.id); } }),
            callbacks.canWrite
              ? el('button', { class: 'btn small', text: 'Copy', onClick: async () => {
                  try {
                    await callbacks.onCopy(p.id);
                    close();
                    projectsDialog(callbacks);
                  } catch (e) { toast(e.message, 'error'); }
                } })
              : null,
            callbacks.canManage
              ? el('button', { class: 'btn small', text: 'Manage', onClick: async () => {
                  try {
                    const { project } = await api.getProject(p.id);
                    manageProjectDialog(project, () => { close(); projectsDialog(callbacks); });
                  } catch (e) { toast(e.message, 'error'); }
                } })
              : null,
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

/**
 * Admin "Manage sharing" dialog for an existing project. Lets an admin flip
 * visibility between Restricted and Public, and — when Restricted — pick which
 * users may view it. The project owner is always an implicit viewer, so they
 * are excluded from the pick list. `onSaved()` runs after a successful save.
 */
export async function manageProjectDialog(project, onSaved) {
  let users = [];
  try {
    const data = await api.listUsers();
    users = data.users || [];
  } catch (err) {
    toast(err.message, 'error');
  }

  // Users eligible to be assigned as viewers (everyone except the owner).
  const assignable = users.filter((u) => u.id !== project.owner_id);
  const currentViewerIds = new Set((project.viewers || []).map((v) => v.id));

  const vis = el('select', {}, [
    el('option', { value: 'restricted', ...(project.visibility === 'restricted' ? { selected: '' } : {}), text: 'Restricted' }),
    el('option', { value: 'public', ...(project.visibility === 'public' ? { selected: '' } : {}), text: 'Public' }),
  ]);

  const checks = assignable.map((u) =>
    el('label', { class: 'row', style: 'gap:var(--space-2); cursor:pointer' }, [
      el('input', { type: 'checkbox', value: String(u.id), ...(currentViewerIds.has(u.id) ? { checked: '' } : {}) }),
      el('span', { text: u.username }),
    ])
  );

  const viewersBox = el('div', { class: 'list' },
    checks.length ? checks : [el('p', { class: 'muted', text: 'No other users to assign.' })]
  );

  const viewersSection = el('div', {}, [
    el('label', { text: 'Users who can view (Restricted)' }),
    viewersBox,
  ]);

  const syncVisibility = () => {
    viewersSection.style.display = vis.value === 'restricted' ? '' : 'none';
  };
  vis.addEventListener('change', syncVisibility);
  syncVisibility();

  openModal((close) =>
    el('div', {}, [
      el('div', { class: 'form-grid' }, [
        el('label', { class: 'full-col' }, ['Visibility', vis]),
      ]),
      viewersSection,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Cancel', onClick: close }),
        el('button', { class: 'btn primary', text: 'Save', onClick: async () => {
          const viewers = vis.value === 'restricted'
            ? checks
                .map((label) => label.querySelector('input'))
                .filter((cb) => cb.checked)
                .map((cb) => Number(cb.value))
            : [];
          try {
            await api.updateProject(project.id, { visibility: vis.value, viewers });
            toast('Sharing updated', 'ok');
            close();
            if (onSaved) onSaved();
          } catch (e) { toast(e.message, 'error'); }
        } }),
      ]),
    ]),
    { title: `Manage "${project.name}"` }
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
