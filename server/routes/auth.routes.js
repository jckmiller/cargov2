import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { signToken, authRequired } from '../auth.js';

const router = Router();

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role };
}

// POST /api/login  { username, password } -> { token, user }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username));
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// GET /api/me -> current user
router.get('/me', authRequired, (req, res) => {
  const user = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

export default router;
