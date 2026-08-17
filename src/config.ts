// Fail fast on missing config rather than letting a malformed connection
// string surface as a confusing runtime error three layers down.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface Config {
  readonly databaseUrl: string;
  // Connects as app_admin (BYPASSRLS, SELECT-only) -- used exclusively by
  // the /customers/top handler. See ADR 0007. Kept as its own required
  // var, not an optional fallback to databaseUrl, so a missing grant fails
  // fast at startup rather than as a confusing RLS-empty-result at request
  // time.
  readonly adminDatabaseUrl: string;
  readonly port: number;
  readonly host: string;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got: ${process.env.PORT}`);
  }

  return {
    databaseUrl: requireEnv('DATABASE_URL'),
    adminDatabaseUrl: requireEnv('ADMIN_DATABASE_URL'),
    port,
    host: process.env.HOST ?? '0.0.0.0',
  };
}
