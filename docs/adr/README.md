# Architecture Decision Records

MADR-lite format: Context, Decision Drivers, Considered Options, Decision
Outcome, Consequences. One file per significant, settled architectural
decision — numbered sequentially, not reordered or renumbered as new ones
are added.

This directory holds the *why* for decisions already made. `docs/assumptions.md`
holds finer-grained, still-tracked assumptions (including open ones);
entries there that graduated into a formal decision link to the ADR that
records it. `docs/plan.md` holds the build sequence these decisions get
implemented in.

| ADR | Decision |
|---|---|
| [0001](0001-row-level-security-for-tenant-isolation.md) | Row-level security for tenant isolation |
| [0002](0002-plan-history-as-a-range-table.md) | Plan history as a range table, not a column |
| [0003](0003-fastify-and-kysely.md) | Fastify and Kysely over an ORM/Express default |
| [0004](0004-containerize-with-podman-compatible-images.md) | Containerize with Podman-compatible image references |
| [0005](0005-derived-dedupe-key-no-source-event-id.md) | Derived dedupe key, since the source has no event ID |
| [0006](0006-non-superuser-role-for-rls-enforcement.md) | Dedicated non-superuser role for the API connection |
