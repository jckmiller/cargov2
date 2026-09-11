import jwt from 'jsonwebtoken';
import db from './db.js';

const DEFAULT_SECRET = 'change-me-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Fail fast: never run in production with a missing or default signing secret,
// otherwise tokens would be trivially forgeable.
if (process.env.NODE_ENV === 'production' && JWT_SECRET === DEFAULT_SECRET) {
  throw new Error(
    'JWT_SECRET must be set to a strong, unique value in production. ' +
      'Generate one with: openssl rand -hex 32'
  );
}

/**
 * Create a signed JWT for a user record.
 */
export function signToken(user) {
  return jwt.sign(
    { id: user.id, tokenVersion: user.token_version ?? 0 },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Express middleware: require a valid Bearer token. Attaches req.user.
 */
export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!Number.isSafeInteger(claims.id)) throw new Error('Invalid user');
    const user = db.prepare('SELECT id, username, role, token_version FROM users WHERE id = ?').get(claims.id);
    if (!user || claims.tokenVersion !== user.token_version) throw new Error('Revoked session');
    req.user = { id: user.id, username: user.username, role: user.role };
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  next();
}

/**
 * Express middleware factory: require the user to have one of the given roles.
 * Must be used after authRequired.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Role helpers used across routes.
export const canWrite = (role) => role === 'admin' || role === 'editor';
