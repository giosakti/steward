# Steward

A self-hosted AI system for turning goals into reviewed work and learning from
human feedback.

Language models propose actions; a decision kernel evaluates them, and
constrained executors carry them out. Human review and recorded evidence are
central to the design.

**Status: early development.** Workspace management and configurable root agents
are available through an authenticated HTTP API and CLI. Missions, goals, and
work items are available through the API. Agent execution and learning are not
implemented yet.

## Getting started

Requires Node.js 24 LTS, PostgreSQL 18, and a database role that can create tables.

```sh
git clone https://github.com/giosakti/steward.git
cd steward
npm ci
cp .env.example .env
openssl rand -hex 32
```

Set `DATABASE_URL` in `.env` to your database connection URL and
`STEWARD_API_TOKEN` to the generated token. Keep this human-operator token private;
do not give it to agents. Commands load `.env` automatically, with existing
environment variables taking precedence.

```sh
npm run db:migrate
npm run build
npm run serve
```

The server listens on `127.0.0.1:3000`. In another terminal:

```sh
npm run steward -- workspace create personal "Personal project" --root-path .
npm run steward -- workspace use personal
npm run steward -- agent show
```

## Running Tests

Create a separate database named `steward_test`, owned by your test role, and
set `TEST_DATABASE_URL` in `.env` to its connection URL. Then run:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
```

Tests run with Vitest. `npm test` loads `.env` and builds the CLI before testing.
Database tests use temporary schemas in `steward_test`, removing them afterward.
They do not use the application database. Type checking remains a separate check.

Use `npm run format` to format code with Prettier. ESLint also enforces braces,
separate variable declarations, and no nested ternaries. Prefer named intermediate
values and blank lines between logical steps when they make code easier to read.

## Database Migration

Run `npm run db:migrate` to apply pending migrations directly with
node-pg-migrate. No build step is required. `DATABASE_URL` selects the application
database; the name `steward` in `.env.example` is only an example. Repeating the
command applies only pending migrations.

SQL migrations live in [`src/storage/migrations`](src/storage/migrations).
Append new timestamp-prefixed files rather than editing applied migrations.
Migrations run in a transaction; omit transaction-control statements from SQL.

The local-selection migration removes the old shared `workspace_selection` table.
Existing workspaces and audit events are retained. After upgrading, run
`workspace use <slug>` again to establish your local selection.

## Contributing

Keep changes focused and reviewable:

- Group code by domain, separating input schemas, table types, and operations
  when that makes them easier to navigate.
- Keep CLI handlers focused on parsing arguments, calling the HTTP API, and
  displaying results.
- Give tests a specific behavior to verify and a descriptive name. Reuse the
  database isolation helper for PostgreSQL tests.
- Commit state changes and their audit events in the same transaction.

GitHub Actions runs formatting, lint, typecheck, clean-database migrations, and
build/tests for pull requests and pushes to `main`, using Node 24 and a disposable
PostgreSQL 18 service.

## Documentation

- [Workspaces and CLI](docs/workspaces.md)
- [HTTP API](docs/http-api.md)
- [Missions, Goals, and Work Items](docs/intent-hierarchy.md)
- [Decision Kernel](docs/decisions.md)
