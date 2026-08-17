import Fastify from 'fastify';
import FastifySwagger from '@fastify/swagger';
import ScalarApiReference from '@scalar/fastify-api-reference';
import { describe, expect, test } from 'vitest';
import { registerUsageSummaryRoute } from './usage.js';
import { registerEndpointsRoute } from './endpoints.js';

// Unit-level, not against a real DB: this only exercises the plugin wiring
// (does the OpenAPI document get generated from route schemas, does the
// Scalar UI render). registerUsageSummaryRoute / registerEndpointsRoute are
// called only so fastify.swagger() has their `schema` to extract paths/tags
// from -- no test in this file ever sends a request to those routes, so
// their handlers (and the `db` argument) never run.
async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  await app.register(FastifySwagger, {
    openapi: { info: { title: 'Billing Test API', version: '1.0.0' } },
  });
  await app.register(ScalarApiReference, { routePrefix: '/reference' });
  app.get('/openapi.json', async () => app.swagger());
  registerUsageSummaryRoute(app, undefined as never);
  registerEndpointsRoute(app, undefined as never);
  return app;
}

describe('OpenAPI document generation', () => {
  test('derives paths and tags from route schema, not a hand-maintained spec', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    const doc = response.json();
    expect(doc.paths).toHaveProperty('/customers/{customerId}/usage');
    expect(doc.paths).toHaveProperty('/customers/{customerId}/endpoints');
    expect(doc.paths['/customers/{customerId}/usage'].get.tags).toEqual(['usage']);
  });
});

describe('GET /reference', () => {
  test('redirects the bare route-prefix path to the trailing-slash form', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/reference' });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe('/reference/');
  });

  test('serves the Scalar UI reading the generated OpenAPI document', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/reference/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Scalar API Reference');
  });
});
