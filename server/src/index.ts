/**
TOEFL House ERP — Express Application Entry Point
============================================================
Bootstraps the entire backend: initializes the database schema,
seeds default rules/workflows, starts the Event Bus, registers
event handlers, and mounts every API router across all Domain-oriented ERP.
*/
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

// ── Database ──────────────────────────────────────────────────────────────
import { initSchema, db } from './db/connection.js';
import { bootstrapRbacCatalog } from './core/rbac/rbac-service.js';
import { bootstrapAcademicCatalog } from './core/academic/bootstrap-catalog.js';

// ── Core Engines ──────────────────────────────────────────────────────────
import { seedDefaultRules } from './core/configuration/rule-engine.js';
import { initializeEventBus } from './core/events/event-bus.js';
import { registerEventHandlers } from './core/events/handlers.js';
import { seedDefaultWorkflowDefinitions } from './utils/workflowSeeds.js';

// ── Middleware ─────────────────────────────────────────────────────────────
import { errorHandler } from './middleware/errorHandler.js';

// ── Security ───────────────────────────────────────────────────────────────
import { assertJwtSecretConfigured } from './utils/auth.js';

// ── Routers (Imports remain exactly the same, omitted for brevity) ─────────
import authRouter from './routes/auth.routes.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { securityRouter } from './routes/security.routes.js';
import usersRouter from './routes/users.routes.js';
import branchesRouter, { partnersRouter, campusesRouter, organizationRouter } from './routes/branches.routes.js';
import visitorsRouter from './routes/visitors.routes.js';
import placementRouter from './routes/placement.routes.js';
import classesRouter, { attendanceRouter } from './routes/classes.routes.js';
import academicRouter from './routes/academic.routes.js';
import studentsRouter, { paymentsRouter } from './routes/students.routes.js';
import offeringsRouter from './routes/offerings.routes.js';
import journeyRouter from './routes/journey.routes.js';
import invoicesRouter from './routes/invoices.routes.js';
import examsRouter from './routes/exams.routes.js';
import teachersRouter, { employeesRouter } from './routes/teachers.routes.js';
import skillsRouter, { classTeacherSkillsRouter } from './routes/skills.routes.js';
import financeRouter from './routes/finance.routes.js';
import booksRouter from './routes/books.routes.js';
import fundingRouter from './routes/funding.routes.js';
import impactRouter from './routes/impact.routes.js';
import workflowsRouter from './routes/workflows.routes.js';
import automationsRouter from './routes/automations.routes.js';
import eventsRouter from './routes/events.routes.js';
import auditRouter, { notificationsRouter } from './routes/audit.routes.js';
import systemSettingsRouter from './routes/settings.routes.js';
import { rulesRouter } from './routes/rules.routes.js';
import { discountAuthorizationsRouter } from './routes/discount-authorizations.routes.js';
import bosRouter from './routes/bos.routes.js';
import sessionsRouter from './routes/sessions.routes.js';
import enrollmentRouter from './routes/enrollment.routes.js';
import waitlistRouter from './routes/waitlist.routes.js';
import searchRouter from './routes/search.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { createLogger } from './core/observability/logger.js';
import { createAutomatedDatabaseBackupService } from './core/operations/database-backup.js';
const log = createLogger('index');
const backupService = createAutomatedDatabaseBackupService(db);

// ============================================================================
// §1 — INITIALIZATION
// ============================================================================

async function bootstrap(): Promise<void> {
  assertJwtSecretConfigured();

  log.info('Initializing database…');
  initSchema();
  
  bootstrapRbacCatalog(db);
  
  bootstrapAcademicCatalog(db);
  
  log.info('Seeding default rules and workflows…');
  seedDefaultRules();
  seedDefaultWorkflowDefinitions();

  log.info('Checking automated database backups…');
  await backupService.start();
  
  log.info('Starting Event Bus and registering handlers…');
  registerEventHandlers();
  await initializeEventBus();

  log.info('✅ Bootstrap complete.');
}

// ============================================================================
// §2 — EXPRESS APPLICATION
// ============================================================================

const isProduction = process.env.NODE_ENV === 'production';
const app = express();
let isApplicationReady = false;
let startupFailure: string | null = null;
if (process.env.TRUST_PROXY === 'true' && isProduction && !process.env.TRUST_PROXY_HOPS) throw new Error('FATAL: TRUST_PROXY_HOPS must be set when TRUST_PROXY is enabled in production.');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? Number(process.env.TRUST_PROXY_HOPS || 1) : false);

// ── Security and performance ──────────────────────────────────────────────
app.use(helmet());
app.use(compression()); // Gzip compression

const corsOriginConfig = process.env.CORS_ORIGIN?.trim();
if (isProduction && !corsOriginConfig) throw new Error('FATAL: CORS_ORIGIN must be explicitly configured in production.');
const effectiveCorsOrigin = corsOriginConfig || 'http://localhost:3000';
const corsOrigins = effectiveCorsOrigin
  .split(',')
  .map((s) => s.trim());
app.use(cors({ origin: corsOrigins, credentials: true }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────
// Prevent brute-force attacks on authentication routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' }
});

// ── Request logging ───────────────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV !== 'production') {
    log.info(`[API] ${req.method} ${req.path}`);
  }
  next();
});

// ============================================================================
// §3 — HEALTH CHECK (Database-aware)
// ============================================================================

app.get('/api/health', (_req: Request, res: Response) => {
  try {
    db.prepare('SELECT 1').get();
    const backup = backupService.getStatus();
    const ready = isApplicationReady && !startupFailure && backup.healthy;
    const state = ready
      ? 'ready'
      : startupFailure
        ? 'failed'
        : isApplicationReady && !backup.healthy
          ? 'degraded'
          : 'bootstrapping';
    res.status(ready ? 200 : 503).json({
      ok: ready, ready, service: 'toefl-house-erp-server', version: '2.0.0',
      database: 'connected', backup, state,
      error: startupFailure || backup.lastError, time: new Date().toISOString(),
    });
  } catch (_err) {
    res.status(503).json({ ok: false, ready: false, service: 'toefl-house-erp-server', database: 'disconnected', state: 'failed', error: 'Database is not responding' });
  }
});

app.get('/api/ready', (_req: Request, res: Response) => {
  const backup = backupService.getStatus();
  const ready = isApplicationReady && !startupFailure && backup.healthy;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    ready,
    state: startupFailure ? 'failed' : isApplicationReady && !backup.healthy ? 'degraded' : ready ? 'ready' : 'bootstrapping',
    error: startupFailure || backup.lastError,
    backup,
  });
});

// ============================================================================
// §4 — API ROUTES
// ============================================================================

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (isApplicationReady && !startupFailure) return next();
  res.status(503).json({ error: startupFailure || 'Service is still initializing. Please retry shortly.', code: startupFailure ? 'STARTUP_FAILED' : 'SERVICE_NOT_READY' });
});

app.use('/api/auth', authLimiter, authRouter); // Apply rate limiter to auth
app.use('/api/users', usersRouter);
app.use('/api/security', securityRouter);
app.use('/api/organization', organizationRouter);
app.use('/api/campuses', campusesRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/partners', partnersRouter);

app.use('/api/visitors', visitorsRouter);
app.use('/api/placement', placementRouter);

app.use('/api/classes', classesRouter);
app.use('/api/academic', academicRouter);
app.use('/api/offerings', offeringsRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/sessions', sessionsRouter);

app.use('/api/students', studentsRouter);
app.use('/api/enrollments', enrollmentRouter);
app.use('/api/students/:id/journey', journeyRouter);
app.use('/api/classes/:id/waitlist', waitlistRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/invoices', invoicesRouter);

app.use('/api/exams', examsRouter);

app.use('/api/teachers', teachersRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/class-teacher-skills', classTeacherSkillsRouter);

app.use('/api/finance', financeRouter);
app.use('/api/books', booksRouter);
app.use('/api/funding', fundingRouter);
app.use('/api/impact', impactRouter);

app.use('/api/workflows', workflowsRouter);
app.use('/api/automations', automationsRouter);
app.use('/api/events', eventsRouter);

app.use('/api/audit-logs', auditRouter);
app.use('/api/notifications', notificationsRouter);

app.use('/api/settings', systemSettingsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/discount-authorizations', discountAuthorizationsRouter);

app.use('/api/bos', bosRouter);
app.use('/api/search', searchRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/dashboard', dashboardRouter);

// ============================================================================
// §5 — 404 HANDLER & GLOBAL ERROR HANDLER
// ============================================================================

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use(errorHandler);

// ============================================================================
// §6 — SERVER STARTUP & GRACEFUL SHUTDOWN
// ============================================================================

const PORT = Number(process.env.PORT) || 4000;
// LAN deployment model: one Windows PC runs the backend, other computers on
// the same network connect through the frontend (Vite serves on 0.0.0.0 and
// proxies /api to this backend). The backend must therefore listen on all
// interfaces by default; set HOST=127.0.0.1 to restrict to loopback.
const HOST = process.env.HOST || '0.0.0.0';
let server: http.Server | undefined;

function listenOnConfiguredPort(): Promise<void> {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(PORT, HOST);
    const onError = (err: NodeJS.ErrnoException) => {
      candidate.removeAllListeners('listening');
      const detail = err.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use on ${HOST}. Stop the existing TOEFL House ERP backend or change PORT in server/.env.`
        : (err.stack || err.message);
      reject(new Error(detail));
    };
    candidate.once('error', onError);
    candidate.once('listening', () => {
      candidate.removeListener('error', onError);
      server = candidate;
      log.info(`[BOOT] HTTP listener active on http://${HOST}:${PORT}`);
      resolve();
    });
  });
}

async function start(): Promise<void> {
  try {
    // Bootstrap must complete before readiness is announced and before the
    // listener is opened. This prevents a half-initialized API and makes
    // port conflicts fail deterministically instead of as an uncaught event.
    await bootstrap();
    await listenOnConfiguredPort();
    setupGracefulShutdown();
    isApplicationReady = true;
    startupFailure = null;
    log.info(`✅ TOEFL House ERP ready on http://127.0.0.1:${PORT}`);
  } catch (err) {
    const message = err instanceof Error ? (err.stack || err.message) : String(err);
    startupFailure = message;
    isApplicationReady = false;
    process.exitCode = 1;
    log.error('❌ Fatal error during startup:', err);
    await backupService.stop();
    if (server) {
      try { server.close(); } catch { /* listener may already be closed */ }
    }
    try { db.close(); } catch { /* database may already be closed during shutdown */ }
  }
}

function setupGracefulShutdown() {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info(`\n${signal} received. Shutting down gracefully...`);
    const backupStop = backupService.stop();

    if (!server) {
      await backupStop;
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
      return;
    }

    server.close(async (err) => {
      if (err) {
        log.error('Error during server close:', err);
        process.exit(1);
      }

      await backupStop;
      log.info('HTTP server closed.');
      try {
        db.close();
        log.info('Database connection closed.');
      } catch (dbErr) {
        log.error('Error closing database:', dbErr);
      }
      
      process.exit(0);
    });

    // Force kill if graceful shutdown fails after 10 seconds
    setTimeout(() => {
      log.error('Forcing shutdown after timeout...');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught Exception:', err);
  process.exit(1);
});

start();