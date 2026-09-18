# Steward

A self-hosted AI system for turning goals into reviewed work and learning from
human feedback.

Language models propose actions; a decision kernel evaluates them, and
constrained executors carry them out. Human review and recorded evidence are
central to the design.

**Status: early development.** Workspace management and configurable root agents
are available through an authenticated HTTP API and CLI. Agent execution and
learning are not implemented yet.

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

## Documentation

- [Workspaces and CLI](docs/workspaces.md)
- [HTTP API](docs/http-api.md)
- [Testing, migrations, and contributing](docs/development.md)
