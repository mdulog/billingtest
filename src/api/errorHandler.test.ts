import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { registerErrorHandler } from './errorHandler.js';

// Unit-level, not against a real DB: the branches here (503 vs. 500) are
// driven by the *shape* of the thrown error (a `code` matching one of the
// libpq "not ready yet" codes), which is trivial to fabricate and doesn't
// need a real Postgres connection to exercise correctly.
function appThrowing(err: unknown): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/boom', () => {
    throw err;
  });
  return app;
}

describe('registerErrorHandler', () => {
  test('maps a libpq "not ready yet" error code to 503, not 500', async () => {
    const app = appThrowing(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'unavailable', message: 'Database is not ready' });
  });

  test('maps an invalid_password error (28P01) to 503 rather than leaking it as a 500', async () => {
    const app = appThrowing(
      Object.assign(new Error('password authentication failed for user "app_user"'), { code: '28P01' })
    );

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(503);
    // A09: the client must never see the raw error message -- this one
    // names the role, which is exactly the detail an attacker would use to
    // fingerprint the DB credential the API connects with.
    expect(JSON.stringify(response.json())).not.toContain('app_user');
  });

  test('maps an unrecognized error to a generic 500, never the original message', async () => {
    const app = appThrowing(new Error('password authentication failed for user "app_user"'));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal_error', message: 'Something went wrong' });
  });
});
