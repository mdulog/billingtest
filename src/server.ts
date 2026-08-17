import Fastify from 'fastify';
import { sql } from 'kysely';
import { loadConfig } from './config.js';
import { createDb, closeDb } from './db/connection.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({ logger: true });
  const db = createDb(config.databaseUrl, app.log);

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

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await closeDb(db);
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
