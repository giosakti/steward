# HTTP API

Build with `npm run build`, then start the server with `npm run serve`.
See the [quick start](../README.md#getting-started) for initial configuration.

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

See [Decision evaluation](decisions.md) for the workspace-scoped proposal and
decision endpoints. These record evaluations without applying changes.
