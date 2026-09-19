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

## Intent hierarchy

All paths below are relative to `/api/v1/workspaces/:id`. The same operator
bearer token and workspace UUID rules apply. See [Missions, Goals, and Work
Items](intent-hierarchy.md) for relationships, status meaning, and authority.

| Method | Path                    | Operation                                             |
| ------ | ----------------------- | ----------------------------------------------------- |
| PUT    | `/mission`              | Set or replace the current mission statement          |
| GET    | `/mission`              | Inspect the current mission; `404` if unset           |
| POST   | `/goals`                | Create an active goal                                 |
| GET    | `/goals`                | List goals in creation order                          |
| GET    | `/goals/:entityId`      | Inspect a goal                                        |
| PATCH  | `/goals/:entityId`      | Update a goal                                         |
| POST   | `/work-items`           | Create a proposed Work Item                           |
| GET    | `/work-items`           | List work by descending priority, then creation order |
| GET    | `/work-items/:entityId` | Inspect a Work Item                                   |
| PATCH  | `/work-items/:entityId` | Update a Work Item                                    |

Goal and Work Item creation returns `201` with `Location`. Mission setting returns
`200` with the current record, whether first set or replaced. Reads and patches
return `200`. Missing, archived, or mismatched workspace references return `404`.
These list routes return arrays and accept no query parameters.

Example request bodies, in order:

```json
{ "statement": "Build a useful self-improving Steward" }
```

```json
{
  "title": "First self-hosted improvement",
  "objective": "Complete one reviewed change"
}
```

```json
{
  "goalId": "<goal UUID returned above>",
  "title": "Isolate execution",
  "objective": "Use a Run-specific Git worktree",
  "acceptanceCriteria": ["The base checkout remains unchanged"]
}
```

Work Item creation optionally accepts an integer `priority` (default `0`).
Creation does not accept parent fields or a status override. Text is trimmed; required text must not be blank.
Titles allow up to 200 characters; objectives and mission statements allow 10,000.
Acceptance criteria require 1–100 nonblank strings, each at most 2,000 characters.
Priority uses PostgreSQL's signed 32-bit integer range.

Goal patches accept `title`, `objective`, and `status`. Work Item patches accept
`title`, `objective`, `acceptanceCriteria`, `priority`, and `status`; supplied
acceptance criteria replace the array. Patches require at least one field.
Unknown fields, null values, changes to a Work Item's Goal, and caller-supplied identity are
rejected with `400`.

For example, `PATCH /work-items/:entityId` with `{"status":"ready"}` records that
work is ready without executing it. Setting `running` or `needs_review` returns
`400`; editing work already in either state returns `409`. Every successful
mutation records an audit event with the server-generated request ID.

## Relationships

Paths are relative to `/api/v1/workspaces/:id` and require the operator token.

| Method | Path                                       | Operation                |
| ------ | ------------------------------------------ | ------------------------ |
| POST   | `/goal-relationships`                      | Link two Goals           |
| GET    | `/goal-relationships`                      | List Goal links          |
| GET    | `/goal-relationships/:relationshipId`      | Inspect a Goal link      |
| DELETE | `/goal-relationships/:relationshipId`      | Remove a Goal link       |
| POST   | `/work-item-relationships`                 | Link two Work Items      |
| GET    | `/work-item-relationships`                 | List Work Item links     |
| GET    | `/work-item-relationships/:relationshipId` | Inspect a Work Item link |
| DELETE | `/work-item-relationships/:relationshipId` | Remove a Work Item link  |

Creation accepts `sourceId`, `targetId`, and `type`. Goal links support
`contributes_to` and `relates_to`; Work Item links support `blocks` and
`relates_to`. For example:

```json
{
  "sourceId": "<prerequisite Work Item UUID>",
  "targetId": "<dependent Work Item UUID>",
  "type": "blocks"
}
```

Both endpoints must exist in this Workspace. Creation returns `201` with a
`Location` header. Responses include `source_id`, `target_id`, `type`,
`created_by`, and `created_at`. Symmetric links use canonical UUID order, so
`source_id` need not be the endpoint supplied first; it carries no direction for
`relates_to`. Directed links preserve their supplied direction.

Listing optionally accepts `?entityId=<UUID>` to return links touching either
side of that Goal or Work Item. Inspecting the reverse perspective uses these
same links, not separate records. Removal returns `204`; the complete removed
link and removing operator remain in the immutable audit log. There is no PATCH
endpoint for links.

Malformed input, unsupported types, and self-links return `400`. Missing,
wrong-type, or cross-workspace endpoints return `404`. Duplicates (including
reversed symmetric links) and directed cycles return `409`. See the
[relationship semantics](intent-hierarchy.md#relationships) for the distinction
between purpose, context, and prerequisites.
