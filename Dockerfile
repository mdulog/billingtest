# Multi-stage: the runtime image carries no compiler, no TypeScript, no
# devDependencies -- only what's needed to run node dist/server.js.

FROM docker.io/library/node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
# The synthetic fixture, per docs/plan.md ("COPY the fixture into the image
# rather than bind-mounting it" -- same SELinux/rootless-Podman reasoning as
# pgdata's named volume). Only the ingest stage below actually reads this;
# harmless to also carry in migrate's image since it forks from `build` too.
# When the real usage_events.json lands at the repo root, add a
# `COPY usage_events.json ./` line here -- Podman's builder errors on a glob
# that matches zero files, so an unconditional COPY isn't safe while the
# real file is still absent (verified locally).
COPY fixtures ./fixtures
RUN npm run build

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

# One-shot migration runner. Needs tsx + typescript (devDependencies) to run
# migrations/*.ts directly, same as `npm run dev` runs src/server.ts directly
# -- so it forks from `build`, which still has those installed, rather than
# adding devDependencies to the runtime image. `build` alone would run as
# root (no USER directive); this stage exists mainly to fix that.
FROM build AS migrate
USER node
CMD ["npx", "tsx", "src/db/migrate.ts"]

# One-shot ingestion runner -- same rationale as `migrate` above (needs
# tsx/typescript to run src/ingest/ingest.ts directly).
FROM build AS ingest
USER node
CMD ["npx", "tsx", "src/ingest/ingest.ts"]
