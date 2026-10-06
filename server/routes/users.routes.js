import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { authRequired, requireRole } from '../auth.js';

const router = Router();

/**
 * User management (admin only). Every route below requires a valid token
 * and the `admin` role; non-admins receive 403 regardless of method.
 */
router.use(authRequired, requireRole('admin'));

const ROLES = ['admin', 'editor', 'viewer'];

/**
 * GET /api/users -> { users }
 *
 * Lists all accounts (id, username, role, created_at). Password hashes are
 * never selected or returned.
 */
router.get('/', (_req, res) => {
  const users = db
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY id')
    .all();
  res.json({ users });
});

/**
 * POST /api/users  { username, password, role } -> { user } (201)
 *
 * Creates an account. An omitted or unrecognized role defaults to the
 * least-privileged `viewer`. Duplicate usernames are rejected with 409.
 */
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

/**
 * PUT /api/users/:id  { password?, role? } -> { user }
 *
 * Updates a password and/or role. Setting a password bumps the user's
 * `token_version`, which immediately revokes every JWT previously issued
 * to them — outstanding sessions die with the credential change.
 *
 * Guard: an admin cannot demote the only remaining admin, so a deployment
 * can never lose administrative access.
 */
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
    // token_version += 1 invalidates all of this user's outstanding tokens.
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
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

/**
 * DELETE /api/users/:id -> { ok: true }
 *
 * Removes an account. Cascading foreign keys delete the user's projects and
 * their project-viewer grants as well. Guarded twice: the caller cannot
 * delete their own account, and the last remaining admin cannot be deleted.
 */
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
