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

Generate an operator token with `openssl rand -hex 32`, set
`STEWARD_API_TOKEN` in `.env`, and start the server:

```sh
npm run build
npm start
```

In another terminal, create and select a workspace through the API:

```sh
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

The CLI uses `STEWARD_API_URL` (default `http://127.0.0.1:3000`) and
`STEWARD_API_TOKEN`; it never connects directly to PostgreSQL. Relative root paths
are resolved from the CLI working directory and must exist on the server.

`workspace use` resolves the slug through the API and saves the workspace UUID
and API address locally. The default file is `$XDG_CONFIG_HOME/steward/config.json`
or `~/.config/steward/config.json`; override it with `STEWARD_CONFIG_FILE`.
It contains no credentials. Selection applies only to the saved API address;
select again when switching servers. Missing, invalid, or stale selections fail
explicitly. Use `--workspace <slug>` for a temporary override:

```sh
npm run steward -- --workspace personal agent show
npm run steward -- workspace list
npm run steward -- --help
```

These commands authenticate as the human operator through HTTP. Creating a workspace does not start an agent
or grant it execution authority.

## HTTP API

The server listens on `127.0.0.1:3000`; set `PORT` in `.env` to change the port.
Every endpoint requires `Authorization: Bearer <your-token>`. This token identifies
one human operator with access to all workspaces; keep it private and do not give
it to agents. Agent access will use a separate authorization path.

| Method | Path                           | Operation                         |
| ------ | ------------------------------ | --------------------------------- |
| POST   | `/api/v1/workspaces`           | Create a workspace and root agent |
| GET    | `/api/v1/workspaces`           | List active workspaces            |
| GET    | `/api/v1/workspaces/:id`       | Inspect a workspace               |
| GET    | `/api/v1/workspaces/:id/agent` | Inspect its root agent            |
| PATCH  | `/api/v1/workspaces/:id/agent` | Configure its root agent          |

Create with a JSON body such as `{"slug":"personal","name":"Personal project"}`;
`description` and `rootPath` are optional. Agent updates accept `name`, `title`,
and `roleDescription`, with at least one supplied field. Unknown fields are rejected.

Use the workspace UUID returned by creation or listing as `:id`. API targeting is
independent of the CLI's selected workspace; the CLI continues to accept slugs.
Responses use the existing record field names (such as `root_agent_id`) and ISO
timestamps. Creation returns `201` with a `Location` header; reads and updates
return `200`. Errors have `{ "code": "...", "error": "..." }` bodies and use
`400`, `401`, `403`, `404`, `409`, or `500` as appropriate.

Responses include a server-generated `X-Request-Id`. Successful mutations record
that identifier, the operator identity, and the HTTP source with the state change.
Database internals are excluded from error responses. The server closes its
listener and database pool on `SIGINT` or `SIGTERM`.

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
