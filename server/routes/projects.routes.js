import { Router } from 'express';
import db from '../db.js';
import { authRequired, canWrite } from '../auth.js';
import { validateProjectData } from '../../public/js/projectValidation.js';

const router = Router();
router.use(authRequired);

/**
 * Determine whether the given user may read a project row.
 * - admin: everything
 * - owner: their own projects
 * - public projects: anyone
 * - restricted: only listed viewers
 */
function canReadProject(user, project) {
  if (user.role === 'admin') return true;
  if (project.owner_id === user.id) return true;
  if (project.visibility === 'public') return true;
  const shared = db
    .prepare('SELECT 1 FROM project_viewers WHERE project_id = ? AND user_id = ?')
    .get(project.id, user.id);
  return Boolean(shared);
}

function canEditProject(user, project) {
  if (!canWrite(user.role)) return false;
  return user.role === 'admin' || project.owner_id === user.id;
}

function withViewers(project) {
  const viewers = db
    .prepare(
      `SELECT u.id, u.username FROM project_viewers pv
       JOIN users u ON u.id = pv.user_id WHERE pv.project_id = ?`
    )
    .all(project.id);
  let data = {};
  try {
    data = JSON.parse(project.data || '{}');
  } catch {
    data = {};
  }
  return { ...project, data, viewers };
}

function setViewers(projectId, userIds) {
  db.prepare('DELETE FROM project_viewers WHERE project_id = ?').run(projectId);
  if (Array.isArray(userIds) && userIds.length) {
    const ins = db.prepare(
      'INSERT OR IGNORE INTO project_viewers (project_id, user_id) VALUES (?, ?)'
    );
    const tx = db.transaction((ids) => {
      for (const uid of ids) ins.run(projectId, Number(uid));
    });
    tx(userIds);
  }
}

function validateViewers(ids) {
  if (ids === undefined) return;
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) =>
    !Number.isSafeInteger(id) || id <= 0 || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id))) {
    throw Object.assign(new Error('viewers must contain existing user IDs'), { status: 400 });
  }
}

// GET /api/projects  -> projects the user may read (summaries)
router.get('/', (req, res) => {
  const all = db.prepare(`SELECT * FROM projects p WHERE ? = 'admin' OR owner_id = ?
    OR visibility = 'public' OR EXISTS (
      SELECT 1 FROM project_viewers pv WHERE pv.project_id = p.id AND pv.user_id = ?
    ) ORDER BY updated_at DESC`).all(req.user.role, req.user.id, req.user.id);
  const visible = all
    .map((p) => {
      const { data, ...meta } = p;
      let parsed = {};
      try {
        parsed = JSON.parse(data || '{}');
      } catch {
        parsed = {};
      }
      return {
        ...meta,
        catalogCount: Array.isArray(parsed.catalog) ? parsed.catalog.length : 0,
        scenarioCount: Array.isArray(parsed.scenarios)
          ? parsed.scenarios.length
          : 0,
        canEdit: canEditProject(req.user, p),
      };
    });
  res.json({ projects: visible });
});

// GET /api/projects/:id -> full project incl. data + viewers
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!canReadProject(req.user, p)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json({
    project: withViewers(p),
    canEdit: canEditProject(req.user, p),
  });
});

// POST /api/projects  { name, visibility?, data?, viewers? }
router.post('/', (req, res) => {
  if (!canWrite(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { name, visibility, data, viewers } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    return res.status(400).json({ error: 'name must be 1–200 characters' });
  }
  validateViewers(viewers);
  if (visibility !== undefined && !['public', 'restricted'].includes(visibility)) {
    return res.status(400).json({ error: 'Invalid visibility' });
  }
  const vis = visibility === 'public' ? 'public' : 'restricted';
  const json = JSON.stringify(validateProjectData(data ?? { catalog: [], scenarios: [] }));
  const p = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO projects (name, owner_id, visibility, data) VALUES (?, ?, ?, ?)'
      )
      .run(name.trim(), req.user.id, vis, json);
    setViewers(info.lastInsertRowid, viewers);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  })();
  res.status(201).json({ project: withViewers(p) });
});

// POST /api/projects/:id/duplicate  { name? }
// Copies a project the user may read into a new project owned by the copier.
// The duplicate always starts restricted with no viewers (safe default).
router.post('/:id/duplicate', (req, res) => {
  if (!canWrite(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const source = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Project not found' });
  if (!canReadProject(req.user, source)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { name } = req.body || {};
  const newName = name != null && String(name).trim()
    ? String(name).trim()
    : `${source.name} (Copy)`;
  if (newName.length > 200) return res.status(400).json({ error: 'name cannot exceed 200 characters' });
  const info = db
    .prepare(
      'INSERT INTO projects (name, owner_id, visibility, data) VALUES (?, ?, ?, ?)'
    )
    .run(newName, req.user.id, 'restricted', source.data);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ project: withViewers(p) });
});

// PUT /api/projects/:id  { name?, visibility?, data?, viewers? }
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!canEditProject(req.user, p)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { name, visibility, data, viewers, revision } = req.body || {};
  if (revision === undefined) return res.status(428).json({ error: 'Project revision required; reload before saving' });
  if (revision !== p.revision) return res.status(409).json({ error: 'Project changed elsewhere. Export your local changes before reloading.' });
  validateViewers(viewers);
  if (name !== undefined && (typeof name !== 'string' || name.length > 200)) {
    return res.status(400).json({ error: 'name must be a string of at most 200 characters' });
  }
  if (visibility !== undefined && !['public', 'restricted'].includes(visibility)) {
    return res.status(400).json({ error: 'Invalid visibility' });
  }
  // Ignore blank/whitespace-only renames so a project keeps a usable title.
  const trimmedName = name != null ? String(name).trim() : '';
  const newName = trimmedName || p.name;
  const newVis =
    visibility === 'public' || visibility === 'restricted' ? visibility : p.visibility;
  const newData = data !== undefined ? JSON.stringify(validateProjectData(data)) : p.data;
  const updated = db.transaction(() => {
    const result = db.prepare(
      `UPDATE projects SET name = ?, visibility = ?, data = ?, revision = revision + 1, updated_at = datetime('now')
       WHERE id = ? AND revision = ?`
    ).run(newName, newVis, newData, id, revision);
    if (!result.changes) throw Object.assign(new Error('Project changed elsewhere; reload before saving'), { status: 409 });
    if (viewers !== undefined) setViewers(id, viewers);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  })();
  res.json({ project: withViewers(updated) });
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!canEditProject(req.user, p)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
