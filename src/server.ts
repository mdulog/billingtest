import Fastify from 'fastify';
import { sql } from 'kysely';
import { loadConfig } from './config.js';
import { createDb, closeDb } from './db/connection.js';
import { registerErrorHandler } from './api/errorHandler.js';
import { registerUsageSummaryRoute } from './api/usage.js';
import { registerEndpointsRoute } from './api/endpoints.js';
import { registerTopCustomersRoute } from './api/top.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({ logger: true });
  const db = createDb(config.databaseUrl, app.log);
  // Separate connection, deliberately -- app_admin (BYPASSRLS, SELECT-only)
  // is used exclusively by /customers/top. See ADR 0007.
  const adminDb = createDb(config.adminDatabaseUrl, app.log);

  registerErrorHandler(app);

  // Liveness/readiness in one: if the DB round-trip fails, this container
  // isn't ready to serve billing queries regardless of whether the HTTP
  // server itself is up.
  app.get('/healthz', async (_request, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'Health check failed to reach Postgres');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  registerUsageSummaryRoute(app, db);
  registerEndpointsRoute(app, db);
  registerTopCustomersRoute(app, adminDb);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await closeDb(db);
    await closeDb(adminDb);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup', err);
  process.exit(1);
});
