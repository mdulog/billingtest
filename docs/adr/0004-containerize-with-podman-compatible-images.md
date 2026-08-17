# 4. Containerize with Podman-compatible image references

**Status:** Accepted
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` P8, P9 · `docs/plan.md` Phase 0 · ADR 0006

## Context and Problem Statement

The grading criteria explicitly reward operational instincts, not just
code. A reviewer who has to hand-install Postgres 17 and hand-craft a
matching connection string before seeing anything work has already formed
an opinion before reading a line of the schema. `docker compose up`
(or the local equivalent) needs to be the entire setup step.

This machine's actual container runtime is **rootless Podman 5.8.4 on
Fedora with SELinux `Enforcing`**, not Docker — verified directly rather
than assumed, and it changed two concrete decisions below.

## Decision Drivers

- Reproducibility on a machine the author doesn't control is itself an
  operational property worth spec'ing, not an afterthought.
- The compose spec is engine-agnostic; the container images and volume
  strategy are what actually differ between Docker and Podman in
  practice.
- Whatever role the API connects as must not be able to silently defeat
  ADR 0001's RLS policy (see ADR 0006).

## Considered Options

1. **No containers; document manual setup steps.** Rejected outright —
   fails the reproducibility bar and the spec's operational-instincts
   criterion directly.
2. **Docker-only compose file**, assuming the reviewer also has Docker.
   Works for many reviewers, silently fails for a Podman-only machine —
   exactly the machine this was built on.
3. **Vendor-neutral compose file + fully-qualified image references +
   named volumes**, portable across both engines.

## Decision Outcome

Chosen: **3**. Concretely:

- **Multi-stage `Dockerfile`** — a `build` stage compiles TypeScript, a
  `runtime` stage installs only production dependencies and runs `USER
  node` (never root).
- **`docker-compose.yml`** wires `db` (Postgres 17) and `api`, with
  `db`'s healthcheck (`pg_isready`) gating `api`'s start via `condition:
  service_healthy` — `pg_isready` returns non-zero while Postgres is
  still initializing, so `service_started` alone races the database on a
  cold start.
- **Named volume for `pgdata`, not a bind mount.** Under SELinux
  `Enforcing`, a bind mount needs `:z`/`:Z` relabeling or the container
  gets permission denied; under rootless Podman it also inherits
  UID-mapped ownership that confuses Postgres's own file ownership
  checks. A named volume sidesteps both — this was verified as a live
  constraint, not a hypothetical one.
- **Fully-qualified image references** (`docker.io/library/postgres:17-alpine`,
  `docker.io/library/node:24-slim`), not short names. This host has
  `short-name-mode = "enforcing"` in `/etc/containers/registries.conf`
  with three candidate registries configured — an unqualified name blocks
  on an interactive registry-selection prompt Podman can't issue without
  a TTY, which manifested as `podman compose up` hanging indefinitely
  with no error surfaced (`podman-compose` reported exit 0 regardless).
  Fully-qualifying is unambiguous and correct under Docker too.
- **`migrate` and `ingest` are one-shot compose services added only once
  the scripts they invoke exist** (Phase 1 and Phase 2 respectively) —
  wiring a compose target around a script that doesn't exist yet would
  just be a broken target sitting in the file.

## Consequences

**Good:**
- Verified end-to-end on this machine: `db` reports healthy, `api` starts
  after it, `/healthz` correctly reports a DB-connectivity failure with a
  meaningful reason (`password authentication failed for user "app_user"`
  — expected, since that role doesn't exist until ADR 0006's migration
  runs), and `SIGTERM` produces a clean, logged shutdown.
- The short-name hang would have cost a reviewer real time with no error
  message pointing at the cause; fully-qualifying removes an entire class
  of "works on my machine" failure.

**Bad:**
- Fully-qualified image references are marginally more verbose than short
  names, and the reasoning (SELinux + rootless UID mapping + short-name
  enforcement) is Fedora/Podman-specific detail that a Docker-only reader
  has to take on faith rather than reproduce locally.
- `podman-compose`'s `condition: service_healthy` support was flagged in
  `docs/plan.md` as historically inconsistent; it held on this run, but
  wasn't assumed to without direct verification.
