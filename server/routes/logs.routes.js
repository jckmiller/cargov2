import { Router } from 'express';
import { authRequired } from '../auth.js';
import { getServerErrors } from '../logsBuffer.js';

/**
 * Server-side error log for the client diagnostics report. Any signed-in
 * role may read it — viewers hit errors too. The buffer is in-memory only.
 */
const router = Router();

/**
 * GET /api/logs -> { entries }
 *
 * Returns the most recent server-side API errors (newest last), capped by
 * logsBuffer's ring-buffer size. Nothing here is persisted.
 */

router.get('/logs', authRequired, (_req, res) => {
  res.json({ entries: getServerErrors() });
});

export default router;
