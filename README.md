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
- A database named `steward` and a role with permission to create tables in it

```sh
git clone https://github.com/giosakti/steward.git
cd steward
npm ci
npm run build

export DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/steward'
npm run db:migrate
```

Replace `USER` and `PASSWORD` with your local PostgreSQL credentials. Repeating
`db:migrate` applies only pending migrations.

For available commands:

```sh
npm run steward -- --help
```

Configuration is supplied through environment variables; `.env` files are not
loaded automatically. See [`.env.example`](.env.example) for local examples.

## Development

Create a separate database named `steward_test`, owned by your test role, then run:

```sh
export TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/steward_test'
npm run lint
npm run typecheck
npm test
```

Tests build the project and use temporary schemas in `steward_test`, removing
them afterward. They do not use the application database.

SQL migrations live in [`src/storage/migrations`](src/storage/migrations).
Append new timestamp-prefixed files rather than editing applied migrations.
Migrations run in a transaction; omit transaction-control statements from SQL.
