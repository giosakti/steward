# Steward

A self-hosted AI system for turning goals into reviewed work and learning from
human feedback.

Steward is designed to separate reasoning from authority: language models propose
actions, a decision kernel evaluates them, and constrained executors carry them
out. Human review and recorded evidence are central to that design.

**Status: early development.** You can create workspaces, select a workspace,
and configure its persistent root agent. Agent execution and learning are not
implemented yet.

## Getting started

Requirements:

- Node.js 24 LTS
- PostgreSQL 18
- A PostgreSQL database and a role with permission to create tables in it

```sh
git clone https://github.com/giosakti/steward.git
cd steward
npm ci
cp .env.example .env
```

Edit `.env` with your PostgreSQL credentials and database names, then apply the migrations:

```sh
npm run db:migrate
```

The application database is selected by `DATABASE_URL`; `steward` is only the
example name. Repeating `db:migrate` applies only pending migrations.

The npm commands load `.env` automatically. Existing environment
variables take precedence, and `.env` is gitignored.

## Workspaces

Build the CLI, then create and select a workspace:

```sh
npm run build
npm run steward -- workspace create personal "Personal project" --root-path .
npm run steward -- workspace use personal
npm run steward -- workspace show
npm run steward -- agent show
npm run steward -- agent configure --title "Engineering Lead"
```

Each workspace has one root agent, named and titled `Steward` by default.
`--root-path` is optional and records an existing directory; these commands do
not modify its files. Agent configuration also accepts `--name` and
`--role-description`.

The selected workspace persists across commands in the same database. Use
`--workspace <slug>` to target another workspace without changing that selection:

```sh
npm run steward -- --workspace personal agent show
npm run steward -- workspace list
npm run steward -- --help
```

These are local operator commands. Creating a workspace does not start an agent
or grant it execution authority.

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
node-pg-migrate. No build step is required.

SQL migrations live in [`src/storage/migrations`](src/storage/migrations).
Append new timestamp-prefixed files rather than editing applied migrations.
Migrations run in a transaction; omit transaction-control statements from SQL.
