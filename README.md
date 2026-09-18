# Steward

Steward is being bootstrapped in small, human-reviewed pull requests. The local
`docs/specs/0001-steward-kernel.md` is authoritative and intentionally untracked.

This first increment provides TypeScript tooling, PostgreSQL migrations, and an
append-only event table. Commander handles the CLI; node-pg-migrate runs the SQL migrations. It does not yet run agents or authorize coding actions.

## Try this increment

Use Node 24 LTS and your existing PostgreSQL server on port 5432. Create an empty
`steward` database owned by the `steward` role first; no additional server or
container is started by this project.

```sh
npm ci
npm run build
export DATABASE_URL=postgresql://steward:steward@127.0.0.1:5432/steward
npm run db:migrate
npm run db:migrate
```

The first invocation prints `Applied: 1789689600000_events`; the second prints
`Database is up to date.` The example credentials are for the local test setup.
The CLI reads environment variables, not `.env` files automatically.

## Review focus

- `src/storage/migrate.ts`: a thin configuration wrapper around node-pg-migrate,
  with ordered SQL files, one transaction for pending migrations, and advisory
  locking. A failed batch rolls back its changes and applied-history entries.
  The library may leave an empty `pgmigrations` table after failure.
- `src/storage/migrations/1789689600000_events.sql`: event data can be inserted and read;
  update, delete, and truncate are rejected. A database owner can still change
  the schema or disable triggers; this is not protection against administrators.
- `tests/migrations.test.ts`: PostgreSQL integration tests for persistence,
  repeat runs, concurrent initialization, rollback, migration ordering, and event
  immutability. Tests use temporary schemas within the separate `steward_test` database and clean them up.

```sh
npm run typecheck
npm run lint
export TEST_DATABASE_URL=postgresql://steward:steward@127.0.0.1:5432/steward_test
npm test
```

Create `steward_test` owned by `steward` before testing. Tests require that database name and schema-creation permission; `steward` is never used for tests. They do not create
another PostgreSQL instance or require permission to create databases.

## Adding migrations

Append `<timestamp>_description.sql` files under `src/storage/migrations/`. Never edit an
applied migration: node-pg-migrate records names and order, not content checksums. SQL is trusted, reviewed source: do not include `BEGIN`,
`COMMIT`, `ROLLBACK`, or statements that cannot run in a transaction. Use the
CLI as an explicit operator maintenance command; it is not an agent capability.
Migration SQL is copied alongside compiled code, so invocation works outside
this repository's working directory.

The next increment will establish workspaces and their persistent root agents.

## Dependency choices

Direct dependencies are pinned to stable releases. Node types follow the Node 24
LTS line. TypeScript 6.0.3 is intentionally used instead of the latest 7.0.2:
`typescript-eslint` 8.70.0 supports TypeScript `>=4.8.4 <6.1.0`. No peer-dependency
checks are bypassed.

[ESLint with typescript-eslint](https://typescript-eslint.io/getting-started/typed-linting/)
uses recommended type-aware rules, including checks for unhandled promises.
[Commander](https://github.com/tj/commander.js) supplies command parsing and help.
[node-pg-migrate](https://github.com/salsita/node-pg-migrate) supplies migration
history, transactions, and locking without requiring an ORM. Dependency versions
were checked against npm stable tags on 2026-09-18.
