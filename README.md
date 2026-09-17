# Steward

Steward is being bootstrapped in small, human-reviewed pull requests. The local
`docs/specs/0001-steward-kernel.md` is authoritative and intentionally untracked.

This first increment provides TypeScript tooling, PostgreSQL migrations, and an
append-only event table. It does not yet run agents or authorize coding actions.

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

The first invocation prints `Applied: 0001_events.sql`; the second prints
`Database is up to date.` The example credentials are for the local test setup.
The CLI reads environment variables, not `.env` files automatically.

## Review focus

- `src/storage/migrate.ts`: ordered SQL files, SHA-256 history checks, and a single
  transaction protected by a PostgreSQL advisory lock. A failed batch rolls back;
  edited, missing, or reordered applied migrations are rejected.
- `src/storage/migrations/0001_events.sql`: event data can be inserted and read;
  update, delete, and truncate are rejected. A database owner can still change
  the schema or disable triggers; this is not protection against administrators.
- `tests/migrations.test.ts`: PostgreSQL integration tests for persistence,
  repeat runs, concurrent initialization, rollback, history drift, and event
  immutability. Tests use temporary schemas and clean them up.

```sh
npm run typecheck
TEST_DATABASE_URL="$DATABASE_URL" npm test
```

Tests require schema-creation permission in the test database. They do not create
another PostgreSQL instance or require permission to create databases.

## Adding migrations

Append `NNNN_description.sql` files under `src/storage/migrations/`. Never edit an
applied migration. SQL is trusted, reviewed source: do not include `BEGIN`,
`COMMIT`, `ROLLBACK`, or statements that cannot run in a transaction. Use the
CLI as an explicit operator maintenance command; it is not an agent capability.
Migration SQL is copied alongside compiled code, so invocation works outside
this repository's working directory.

The next increment will establish workspaces and their persistent root agents.
