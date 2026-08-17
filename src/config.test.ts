import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from './config.js';

const REQUIRED_VARS = ['DATABASE_URL', 'ADMIN_DATABASE_URL'] as const;
const TOUCHED_VARS = [...REQUIRED_VARS, 'PORT', 'HOST'] as const;

// Snapshot and restore only the vars this file touches, in place -- this
// suite runs alongside integration tests that read the same env at import
// time (vitest.config.ts's DATABASE_URL/ADMIN_DATABASE_URL/
// MIGRATE_DATABASE_URL, under fileParallelism: false), so a test here must
// not leak a deleted var into a later test file. Reassigning `process.env`
// wholesale (`process.env = {...}`) replaces the object rather than
// mutating the live one -- restoring per key instead avoids depending on
// which files happen to hold a reference to the old object.
let saved: Partial<Record<(typeof TOUCHED_VARS)[number], string | undefined>>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED_VARS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of TOUCHED_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('loadConfig', () => {
  for (const missing of REQUIRED_VARS) {
    test(`throws fast when ${missing} is missing rather than surfacing a confusing error later`, () => {
      delete process.env[missing];

      expect(() => loadConfig()).toThrow(`Missing required environment variable: ${missing}`);
    });

    test(`throws fast when ${missing} is blank`, () => {
      process.env[missing] = '   ';

      expect(() => loadConfig()).toThrow(`Missing required environment variable: ${missing}`);
    });
  }

  test('rejects a non-numeric PORT rather than silently falling back', () => {
    process.env.PORT = 'not-a-number';

    expect(() => loadConfig()).toThrow(/PORT must be a positive integer/);
  });

  test('rejects a zero or negative PORT', () => {
    process.env.PORT = '0';

    expect(() => loadConfig()).toThrow(/PORT must be a positive integer/);
  });

  test('defaults PORT to 3000 and HOST to 0.0.0.0 when unset', () => {
    delete process.env.PORT;
    delete process.env.HOST;

    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
  });
});
