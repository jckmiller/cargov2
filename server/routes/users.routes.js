import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { authRequired, requireRole } from '../auth.js';

const router = Router();

// All user-management endpoints are admin-only.
router.use(authRequired, requireRole('admin'));

const ROLES = ['admin', 'editor', 'viewer'];

// GET /api/users
router.get('/', (_req, res) => {
  const users = db
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY id')
    .all();
  res.json({ users });
});

// POST /api/users  { username, password, role }
router.post('/', (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const r = ROLES.includes(role) ? role : 'viewer';
  const exists = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(String(username));
  if (exists) return res.status(409).json({ error: 'username already taken' });

  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(String(username), hash, r);
  const user = db
    .prepare('SELECT id, username, role, created_at FROM users WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({ user });
});

// PUT /api/users/:id  { password?, role? }
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { password, role } = req.body || {};
  if (role && !ROLES.includes(role)) {
    return res.status(400).json({ error: 'invalid role' });
  }
  // Prevent demoting the last remaining admin.
  if (role && role !== 'admin' && target.role === 'admin') {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get().n;
    if (admins <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
  }
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      bcrypt.hashSync(String(password), 10),
      id
    );
  }
  if (role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  const user = db
    .prepare('SELECT id, username, role, created_at FROM users WHERE id = ?')
    .get(id);
  res.json({ user });
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get().n;
    if (admins <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
