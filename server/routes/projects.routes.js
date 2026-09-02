import { Router } from 'express';
import db from '../db.js';
import { authRequired, canWrite } from '../auth.js';

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

// GET /api/projects  -> projects the user may read (summaries)
router.get('/', (req, res) => {
  const all = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  const visible = all
    .filter((p) => canReadProject(req.user, p))
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
  if (!name) return res.status(400).json({ error: 'name required' });
  const vis = visibility === 'public' ? 'public' : 'restricted';
  const json = JSON.stringify(data ?? { catalog: [], scenarios: [] });
  const info = db
    .prepare(
      'INSERT INTO projects (name, owner_id, visibility, data) VALUES (?, ?, ?, ?)'
    )
    .run(String(name), req.user.id, vis, json);
  setViewers(info.lastInsertRowid, viewers);
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
  const { name, visibility, data, viewers } = req.body || {};
  const newName = name != null ? String(name) : p.name;
  const newVis =
    visibility === 'public' || visibility === 'restricted' ? visibility : p.visibility;
  const newData = data != null ? JSON.stringify(data) : p.data;
  db.prepare(
    `UPDATE projects SET name = ?, visibility = ?, data = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(newName, newVis, newData, id);
  if (viewers !== undefined) setViewers(id, viewers);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
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
