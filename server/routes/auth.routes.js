import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { signToken, authRequired } from '../auth.js';

/**
 * Authentication endpoints: login (token issuance) and current-user lookup.
 */
const router = Router();

/**
 * Project a full `users` row onto the shape that is safe to send to clients:
 * id, username and role only — never the password hash or token_version.
 */
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role };
}

/**
 * POST /api/login  { username, password } -> { token, user }
 *
 * Issues a JWT for valid credentials. Responds 401 (not 400) for an unknown
 * username or wrong password so the failure mode does not reveal which half
 * of the credential pair was wrong. Requests are rate-limited at the app level.
 */
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

/**
 * GET /api/me -> { user }
 *
 * Returns the caller's profile, re-read from the database so role changes
 * and account deletions take effect immediately rather than at token expiry.
 */
router.get('/me', authRequired, (req, res) => {
  const user = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

export default router;
