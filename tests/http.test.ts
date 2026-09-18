import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Kysely } from 'kysely';
import { buildApp } from '../src/http/app.js';
import { connectDatabase, type Database } from '../src/storage/database.js';
import {
  configureAgent,
  createWorkspace,
} from '../src/workspaces/workspaces.js';
import type { OperatorActor } from '../src/audit/actor.js';
import { isolated } from './database.js';

const token = randomUUID();
const headers = { authorization: `Bearer ${token}` };
const operator: OperatorActor = {
  actor: 'operator',
  source: 'workspace-http',
};
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
type App = ReturnType<typeof buildApp>;

async function setup(
  fn: (app: App, db: Kysely<Database>, client: pg.Client) => Promise<void>,
) {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    const db = connectDatabase(url);
    const app = buildApp(db, token);
    try {
      await fn(app, db, client);
    } finally {
      await app.close();
      await db.destroy();
    }
  });
}

function getWorkspace(app: App, id: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${id}`,
    headers,
  });
}

describe('operator authentication', () => {
  it('rejects missing or wrong credentials on every endpoint before parsing input', async () => {
    await setup(async (app, _db, client) => {
      const endpoints = [
        { method: 'GET', url: '/api/v1/workspaces' },
        { method: 'GET', url: `/api/v1/workspaces/${randomUUID()}` },
        { method: 'GET', url: `/api/v1/workspaces/${randomUUID()}/agent` },
        { method: 'POST', url: '/api/v1/workspaces' },
        { method: 'PATCH', url: `/api/v1/workspaces/${randomUUID()}/agent` },
      ] as const;
      for (const { method, url } of endpoints) {
        for (const authorization of ['', 'Bearer wrong', `Basic ${token}`]) {
          const response = await app.inject({
            method,
            url,
            headers: { authorization, 'content-type': 'application/json' },
            ...(method !== 'GET' ? { payload: '{broken' } : {}),
          });
          expect(response.statusCode).toBe(401);
          expect(response.headers['www-authenticate']).toBe('Bearer');
          expect(response.json()).toEqual({
            code: 'UNAUTHORIZED',
            error: 'A valid operator bearer token is required',
          });
        }
      }
      expect((await client.query('SELECT * FROM events')).rows).toHaveLength(0);
    });
  });

  it('refuses invalid server credentials at startup', async () => {
    await setup(async (_app, db) => {
      for (const invalid of ['', 'short', ' '.repeat(40)]) {
        expect(() => buildApp(db, invalid)).toThrow(/STEWARD_API_TOKEN/);
      }
    });
  });

  it('rejects an agent caller at the shared mutation boundary', async () => {
    await setup(async (_app, db, client) => {
      const workspace = await createWorkspace(
        db,
        { slug: 'existing', name: 'Existing' },
        operator,
      );
      const agent: OperatorActor = {
        ...operator,
        // @ts-expect-error Agent callers are not authorized on the operator path.
        actor: 'agent',
      };
      await expect(
        createWorkspace(db, { slug: 'denied', name: 'Denied' }, agent),
      ).rejects.toThrow(/human operator/);
      await expect(
        configureAgent(db, { title: 'Changed' }, workspace.id, agent),
      ).rejects.toThrow(/human operator/);
      expect((await client.query('SELECT * FROM events')).rows).toHaveLength(2);
    });
  });
});

describe('workspace HTTP operations', () => {
  it('creates, lists, and fetches workspaces and root agents by UUID', async () => {
    await setup(async (app, _db, client) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { slug: 'first', name: 'First' },
      });
      expect(response.statusCode).toBe(201);
      const created = response.json<{
        id: string;
        root_agent_id: string;
        created_at: string;
      }>();
      expect(response.headers.location).toBe(
        `/api/v1/workspaces/${created.id}`,
      );
      expect(created.created_at).toMatch(/^\d{4}-/);
      expect((await getWorkspace(app, created.id)).json()).toEqual(
        response.json(),
      );
      const listing = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces',
        headers,
      });
      expect(listing.statusCode).toBe(200);
      expect(listing.json()).toEqual([response.json()]);
      const agent = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${created.id}/agent`,
        headers,
      });
      expect(agent.statusCode).toBe(200);
      expect(agent.json()).toMatchObject({
        id: created.root_agent_id,
        workspace_id: created.id,
        name: 'Steward',
        title: 'Steward',
      });
      const events = await client.query<{
        payload: { actor: string; source: string; requestId: string };
      }>('SELECT payload FROM events ORDER BY id');
      expect(events.rows).toHaveLength(2);
      for (const { payload } of events.rows) {
        expect(payload).toMatchObject({
          actor: 'operator',
          source: 'workspace-http',
        });
        expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(payload.requestId).toBe(response.headers['x-request-id']);
      }
      expect(events.rows[0]?.payload.requestId).toBe(
        events.rows[1]?.payload.requestId,
      );
    });
  });

  it('targets the requested UUID and records trusted caller context', async () => {
    await setup(async (app, db, client) => {
      const first = await createWorkspace(
        db,
        { slug: 'first', name: 'First' },
        operator,
      );
      const second = await createWorkspace(
        db,
        { slug: 'second', name: 'Second' },
        operator,
      );
      const result = await app.inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${second.id}/agent`,
        headers: { ...headers, 'x-request-id': 'spoofed', 'x-actor': 'agent' },
        payload: { title: 'Engineer' },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        id: second.root_agent_id,
        title: 'Engineer',
      });
      expect(
        (
          await client.query<{ title: string }>(
            'SELECT title FROM agents WHERE workspace_id=$1',
            [first.id],
          )
        ).rows[0]?.title,
      ).toBe('Steward');
      const event = (
        await client.query<{ payload: { requestId: string } }>(
          "SELECT payload FROM events WHERE type='AGENT_CONFIGURED'",
        )
      ).rows[0];
      expect(event?.payload).toMatchObject({
        actor: 'operator',
        source: 'workspace-http',
      });
      expect(event?.payload.requestId).not.toBe('spoofed');
    });
  });

  it('keeps an existing UUID usable after its slug changes', async () => {
    await setup(async (app, db, client) => {
      const workspace = await createWorkspace(
        db,
        { slug: 'before', name: 'Before' },
        operator,
      );
      await client.query('UPDATE workspaces SET slug=$1 WHERE id=$2', [
        'after',
        workspace.id,
      ]);
      const response = await getWorkspace(app, workspace.id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: workspace.id,
        slug: 'after',
      });
    });
  });
});

describe('HTTP errors and atomic mutations', () => {
  it('returns 400 for invalid UUIDs and 404 for absent or archived workspaces', async () => {
    await setup(async (app, db, client) => {
      expect((await getWorkspace(app, 'slug-not-an-id')).statusCode).toBe(400);
      expect((await getWorkspace(app, randomUUID())).statusCode).toBe(404);
      const workspace = await createWorkspace(
        db,
        { slug: 'archived', name: 'Archived' },
        operator,
      );
      await client.query(
        'UPDATE workspaces SET archived_at=now() WHERE id=$1',
        [workspace.id],
      );
      for (const suffix of ['', '/agent']) {
        expect(
          (
            await app.inject({
              url: `/api/v1/workspaces/${workspace.id}${suffix}`,
              headers,
            })
          ).statusCode,
        ).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/workspaces/${workspace.id}/agent`,
            headers,
            payload: { title: 'Changed' },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it('rejects malformed and invalid input without creating records', async () => {
    await setup(async (app, _db, client) => {
      for (const payload of [
        { slug: 'bad slug', name: 'Name' },
        { slug: 'blank', name: ' ' },
        { slug: 'extra', name: 'Name', actor: 'operator' },
        { slug: 'path', name: 'Path', rootPath: `/tmp/${randomUUID()}` },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/workspaces',
              headers,
              payload,
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/workspaces',
            headers: { ...headers, 'content-type': 'application/json' },
            payload: '{broken',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/workspaces?workspace=other',
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect((await client.query('SELECT * FROM events')).rows).toHaveLength(0);
      expect(
        (await client.query('SELECT * FROM workspaces')).rows,
      ).toHaveLength(0);
    });
  });

  it('rejects empty patches and attempts to change another agent or caller identity', async () => {
    await setup(async (app, db, client) => {
      const workspace = await createWorkspace(
        db,
        { slug: 'first', name: 'First' },
        operator,
      );
      for (const payload of [
        {},
        { title: ' ' },
        { title: null },
        { title: 'New', workspace_id: randomUUID() },
        { title: 'New', actor: 'operator' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/api/v1/workspaces/${workspace.id}/agent`,
              headers,
              payload,
            })
          ).statusCode,
        ).toBe(400);
      }
      expect((await client.query('SELECT * FROM events')).rows).toHaveLength(2);
    });
  });

  it('returns a conflict for duplicate slugs without exposing SQL', async () => {
    await setup(async (app, db) => {
      await createWorkspace(db, { slug: 'first', name: 'First' }, operator);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { slug: 'first', name: 'Duplicate' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: 'CONFLICT',
        error: 'Workspace slug already exists',
      });
    });
  });

  it('returns a generic 500 and rolls back when audit recording fails', async () => {
    await setup(async (app, db, client) => {
      const workspace = await createWorkspace(
        db,
        { slug: 'first', name: 'First' },
        operator,
      );
      await client.query(
        "ALTER TABLE events ADD CONSTRAINT secret_internal_constraint CHECK (type <> 'AGENT_CONFIGURED')",
      );
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${workspace.id}/agent`,
        headers,
        payload: { title: 'Changed' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        code: 'INTERNAL_ERROR',
        error: 'Internal server error',
      });
      expect(
        (await client.query<{ title: string }>('SELECT title FROM agents'))
          .rows[0]?.title,
      ).toBe('Steward');
      expect((await client.query('SELECT * FROM events')).rows).toHaveLength(2);
    });
  });
});

describe('HTTP listener', () => {
  it('serves authenticated requests over loopback and closes cleanly', async () => {
    await setup(async (app) => {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${address}/api/v1/workspaces`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      await app.close();
      expect(app.server.listening).toBe(false);
    });
  });
});
