import { Router } from 'express';

/**
 * Liveness/health endpoint for uptime probes, load balancers and the
 * post-deploy smoke test (`curl /api/health`). Unauthenticated by design.
 */
const router = Router();

/** GET /api/health -> { status, time } */

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

export default router;
