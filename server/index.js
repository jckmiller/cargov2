import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import './db.js'; // initialize DB (migrate + seed) on boot
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';
import projectsRoutes from './routes/projects.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// Behind a reverse proxy (Nginx/Caddy/Traefik) so client IPs and the
// rate limiter see the real remote address via X-Forwarded-For.
app.set('trust proxy', 1);

// Security headers. The frontend uses an import-map + inline module scripts
// and loads assets same-origin, so a strict-but-compatible CSP is applied.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'https://unpkg.com'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(compression());

// CORS: the frontend is served same-origin, so cross-origin requests are only
// allowed when an explicit allow-list is provided via CORS_ORIGIN.
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (corsOrigins.length) {
  app.use(cors({ origin: corsOrigins }));
}

app.use(express.json({ limit: '10mb' }));

// Throttle auth attempts to blunt credential brute-forcing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// API routes
app.use('/api', healthRoutes);
app.use('/api/login', loginLimiter);
app.use('/api', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/projects', projectsRoutes);

// Static frontend
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// SPA-ish fallback for anything that isn't an API call.
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Bind to 0.0.0.0 by default so it works inside a container; override with HOST
// (e.g. 127.0.0.1) when running the process directly behind a local proxy.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`A3 Shipping Pro listening on ${HOST}:${PORT}`);
});
