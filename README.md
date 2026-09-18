# Steward

A self-hosted AI system for turning goals into reviewed work and learning from
human feedback.

Steward is designed to separate reasoning from authority: language models propose
actions, a decision kernel evaluates them, and constrained executors carry them
out. Human review and recorded evidence are central to that design.

**Status: early development.** The current foundation provides a CLI for
PostgreSQL migrations and an append-only event log. Agent execution and learning
are not implemented yet.

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
npm run build
npm run db:migrate
```

The application database is selected by `DATABASE_URL`; `steward` is only the
example name. Repeating `db:migrate` applies only pending migrations.

For available commands:

```sh
npm run steward -- --help
```

The CLI loads `.env` from the current directory automatically. Existing
environment variables take precedence, and `.env` is gitignored.

## Running Tests

Create a separate database named `steward_test`, owned by your test role, and
set `TEST_DATABASE_URL` in `.env` to its connection URL. Then run:

```sh
npm run lint
npm run typecheck
npm test
```

Tests also load `.env`, build the project, and use temporary schemas in `steward_test`, removing
them afterward. They do not use the application database.

## Database Migration

Run `npm run db:migrate` (equivalent to `npm run steward -- db migrate`)
to apply pending migrations.

SQL migrations live in [`src/storage/migrations`](src/storage/migrations).
Append new timestamp-prefixed files rather than editing applied migrations.
Migrations run in a transaction; omit transaction-control statements from SQL.
