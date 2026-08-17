import type { FastifyInstance, FastifyError } from 'fastify';
import { RangeValidationError } from './schemas.js';

// Postgres/libpq codes that mean "the database isn't reachable/ready yet,"
// not "this request is broken." Named here because docker-compose.yml's
// migrate/api race (podman-compose doesn't reliably gate on
// service_completed_successfully) means a request can land in the window
// before migrations/004_admin_role.ts has created app_user/app_admin --
// that must surface as a clean 503, not a 500 with a leaked credential
// error, and not a hung connection.
const DB_UNAVAILABLE_CODES = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification (role doesn't exist yet)
  '57P03', // cannot_connect_now
  '3D000', // invalid_catalog_name (database doesn't exist yet)
  'ECONNREFUSED',
]);

function isDbUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    DB_UNAVAILABLE_CODES.has((err as { code: string }).code)
  );
}

// Never returns a raw error.message to the client (A09: no stack traces or
// exception messages in responses) -- a DB auth failure's message literally
// contains `password authentication failed for user "app_user"`.
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    if ('validation' in err && err.validation) {
      app.log.warn({ err, url: request.url }, 'Request failed boundary validation');
      reply.status(400).send({ error: 'invalid_request', message: err.message });
      return;
    }

    if (err instanceof RangeValidationError) {
      app.log.warn({ err, url: request.url }, 'Request failed boundary validation');
      reply.status(400).send({ error: 'invalid_request', message: err.message });
      return;
    }

    if (isDbUnavailable(err)) {
      app.log.error({ err, url: request.url }, 'Database unreachable while handling request');
      reply.status(503).send({ error: 'unavailable', message: 'Database is not ready' });
      return;
    }

    app.log.fatal({ err, url: request.url }, 'Unhandled error while handling request');
    reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });
}
