import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { OperatorActor } from '../src/audit/actor.js';
import { createGoal } from '../src/goals/goals.js';
import {
  createGoalRelationship,
  removeGoalRelationship,
} from '../src/goals/relationships.js';
import { buildApp } from '../src/http/app.js';
import { connectDatabase, type Database } from '../src/storage/database.js';
import { createWorkItem } from '../src/work-items/work-items.js';
import {
  createWorkItemRelationship,
  removeWorkItemRelationship,
} from '../src/work-items/relationships.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
import { isolated } from './database.js';

describe.each([
  {
    route: 'goal-relationships',
    table: 'goal_relationships',
    directed: 'contributes_to',
    event: 'GOAL',
  },
  {
    route: 'work-item-relationships',
    table: 'work_item_relationships',
    directed: 'blocks',
    event: 'WORK_ITEM',
  },
] as const)('$route', (kind) => {
  it('supports multiple directed links and incident listing without changing endpoint state', async () => {
    await setup(async ({ app, db, workspaceId, goals, work, url }) => {
      const [a, b, c] = kind.event === 'GOAL' ? goals : work;
      const base = `/api/v1/workspaces/${workspaceId}/${kind.route}`;
      const first = await createLink(app, base, a, b, kind.directed);
      expect(first.statusCode).toBe(201);
      const link = first.json<Link>();
      expect(link).toMatchObject({
        source_id: a,
        target_id: b,
        type: kind.directed,
        created_by: {
          actor: 'operator',
          requestId: first.headers['x-request-id'],
        },
      });
      expect(first.headers.location).toBe(`${base}/${link.id}`);
      expect(
        (await app.inject({ url: `${base}/${link.id}`, headers })).json(),
      ).toEqual(link);
      expect(
        (await createLink(app, base, a, c, kind.directed)).statusCode,
      ).toBe(201);
      const incoming = await app.inject({
        url: `${base}?entityId=${b}`,
        headers,
      });
      expect(incoming.json()).toEqual([link]);
      expect((await app.inject({ url: base, headers })).json()).toHaveLength(2);
      const connection = connectDatabase(url);
      const reopened = buildApp(connection, token);
      try {
        expect(
          (
            await reopened.inject({ url: `${base}/${link.id}`, headers })
          ).json(),
        ).toEqual(link);
      } finally {
        await reopened.close();
        await connection.destroy();
      }
      expect(
        (await db.selectFrom('goals').select('status').execute()).every(
          (row) => row.status === 'active',
        ),
      ).toBe(true);
      expect(
        (await db.selectFrom('work_items').select('status').execute()).every(
          (row) => row.status === 'proposed',
        ),
      ).toBe(true);
      expect(await db.selectFrom('decisions').selectAll().execute()).toEqual(
        [],
      );
    });
  });

  it('stores symmetric links once, permits context cycles, and keeps link types independent', async () => {
    await setup(async ({ app, workspaceId, goals, work }) => {
      const [a, b, c] = kind.event === 'GOAL' ? goals : work;
      const base = `/api/v1/workspaces/${workspaceId}/${kind.route}`;
      const result = await createLink(
        app,
        base,
        b.toUpperCase(),
        a,
        'relates_to',
      );
      expect(result.statusCode).toBe(201);
      expect([
        result.json<Link>().source_id,
        result.json<Link>().target_id,
      ]).toEqual([a, b].sort());
      expect((await createLink(app, base, a, b, 'relates_to')).statusCode).toBe(
        409,
      );
      expect((await createLink(app, base, b, c, 'relates_to')).statusCode).toBe(
        201,
      );
      expect((await createLink(app, base, c, a, 'relates_to')).statusCode).toBe(
        201,
      );
      expect(
        (await createLink(app, base, a, b, kind.directed)).statusCode,
      ).toBe(201);
      expect(
        (await createLink(app, base, a, b, kind.directed)).statusCode,
      ).toBe(409);
    });
  });

  it('rejects transitive cycles and concurrent cycle-closing or duplicate additions', async () => {
    await setup(async ({ app, workspaceId, goals, work }) => {
      const [a, b, c] = kind.event === 'GOAL' ? goals : work;
      const base = `/api/v1/workspaces/${workspaceId}/${kind.route}`;
      const results = await Promise.all([
        createLink(app, base, a, b, kind.directed),
        createLink(app, base, b, c, kind.directed),
        createLink(app, base, c, a, kind.directed),
      ]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([
        201, 201, 409,
      ]);
      const failed = results.find((result) => result.statusCode === 409)!;
      expect(failed.json<{ error: string }>().error).toMatch(/cycle/);
      for (const result of results.filter(
        (response) => response.statusCode === 201,
      )) {
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `${base}/${result.json<Link>().id}`,
              headers,
            })
          ).statusCode,
        ).toBe(204);
      }
      expect(
        (await createLink(app, base, a, b, kind.directed)).statusCode,
      ).toBe(201);
      expect(
        (await createLink(app, base, b, c, kind.directed)).statusCode,
      ).toBe(201);
      expect(
        (await createLink(app, base, c, a, kind.directed)).statusCode,
      ).toBe(409);
      const duplicates = await Promise.all([
        createLink(app, base, a, c, 'relates_to'),
        createLink(app, base, c, a, 'relates_to'),
      ]);
      expect(duplicates.map((result) => result.statusCode).sort()).toEqual([
        201, 409,
      ]);
    });
  });

  it('rejects wrong endpoints and workspace access, with database foreign keys as a backstop', async () => {
    await setup(async ({ app, db, client, workspaceId, goals, work }) => {
      const [a, b] = kind.event === 'GOAL' ? goals : work;
      const wrongType = kind.event === 'GOAL' ? work[0] : goals[0];
      const base = `/api/v1/workspaces/${workspaceId}/${kind.route}`;
      const other = await createWorkspace(
        db,
        { slug: 'other', name: 'Other' },
        operator,
      );
      const otherGoal = await createGoal(
        db,
        other.id,
        { title: 'Other', objective: 'Other outcome' },
        operator,
      );
      const otherWork = await createWorkItem(
        db,
        other.id,
        {
          goalId: otherGoal.id,
          title: 'Other',
          objective: 'Other work',
          acceptanceCriteria: ['Done'],
        },
        operator,
      );
      const foreignId = kind.event === 'GOAL' ? otherGoal.id : otherWork.id;
      for (const invalid of [foreignId, wrongType, randomUUID()]) {
        expect(
          (await createLink(app, base, a, invalid, kind.directed)).statusCode,
        ).toBe(404);
        expect(
          (await createLink(app, base, invalid, b, kind.directed)).statusCode,
        ).toBe(404);
        expect(
          (await app.inject({ url: `${base}?entityId=${invalid}`, headers }))
            .statusCode,
        ).toBe(404);
      }
      const link = (
        await createLink(app, base, a, b, kind.directed)
      ).json<Link>();
      const otherBase = `/api/v1/workspaces/${other.id}/${kind.route}`;
      for (const method of ['GET', 'DELETE'] as const) {
        expect(
          (
            await app.inject({
              method,
              url: `${otherBase}/${link.id}`,
              headers,
            })
          ).statusCode,
        ).toBe(404);
      }
      expect((await app.inject({ url: otherBase, headers })).json()).toEqual(
        [],
      );
      await expect(
        client.query(
          `INSERT INTO ${kind.table}(id, workspace_id, source_id, target_id, type, created_by) VALUES ($1,$2,$3,$4,$5,'{}')`,
          [randomUUID(), workspaceId, a, foreignId, kind.directed],
        ),
      ).rejects.toThrow(/foreign key/);
      await client.query(
        'UPDATE workspaces SET archived_at=now() WHERE id=$1',
        [workspaceId],
      );
      for (const method of ['GET', 'DELETE'] as const) {
        expect(
          (await app.inject({ method, url: `${base}/${link.id}`, headers }))
            .statusCode,
        ).toBe(404);
      }
      expect((await createLink(app, base, b, a, 'relates_to')).statusCode).toBe(
        404,
      );
      expect((await app.inject({ url: base, headers })).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            url: `/api/v1/workspaces/${randomUUID()}/${kind.route}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it('rejects invalid and unauthenticated operations, including in-place relationship edits', async () => {
    await setup(async ({ app, workspaceId, goals, work }) => {
      const [a, b] = kind.event === 'GOAL' ? goals : work;
      const base = `/api/v1/workspaces/${workspaceId}/${kind.route}`;
      for (const [method, path] of [
        ['POST', base],
        ['GET', base],
        ['GET', `${base}/${randomUUID()}`],
        ['DELETE', `${base}/${randomUUID()}`],
      ] as const) {
        expect((await app.inject({ method, url: path })).statusCode).toBe(401);
      }
      for (const payload of [
        { sourceId: a, targetId: a.toUpperCase(), type: kind.directed },
        {
          sourceId: a,
          targetId: b,
          type: kind.event === 'GOAL' ? 'blocks' : 'contributes_to',
        },
        { sourceId: a, targetId: b, type: 'duplicates' },
        { sourceId: a, targetId: b, type: kind.directed, createdBy: 'Gio' },
        { sourceId: a, targetId: b },
        { sourceId: 'bad', targetId: b, type: kind.directed },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: base, headers, payload }))
            .statusCode,
        ).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `${base}/${randomUUID()}`,
            headers,
            payload: { targetId: b },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it('preserves removed-link evidence and rolls back link changes when audit recording fails', async () => {
    await setup(async ({ app, client, workspaceId, goals, work }) => {
      const [a, b, c] = kind.event === 'GOAL' ? goals : work;
      const base = `/api/v1/workspaces/${workspaceId}/${kind.route}`;
      const created = await createLink(app, base, a, b, kind.directed);
      const link = created.json<Link>();
      await client.query(
        `ALTER TABLE events ADD CONSTRAINT reject_links CHECK (type NOT IN ('${kind.event}_RELATIONSHIP_CREATED', '${kind.event}_RELATIONSHIP_REMOVED')) NOT VALID`,
      );
      expect(
        (await createLink(app, base, a, c, kind.directed)).statusCode,
      ).toBe(500);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `${base}/${link.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(500);
      expect((await app.inject({ url: base, headers })).json()).toEqual([link]);
      await client.query('ALTER TABLE events DROP CONSTRAINT reject_links');
      const removed = await app.inject({
        method: 'DELETE',
        url: `${base}/${link.id}`,
        headers,
      });
      expect(removed.statusCode).toBe(204);
      expect(removed.body).toBe('');
      expect(
        (await app.inject({ url: `${base}/${link.id}`, headers })).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `${base}/${link.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      const history = (
        await client.query<{
          type: string;
          payload: { data: Link; requestId: string; actor: string };
        }>(
          'SELECT type, payload FROM events WHERE type IN ($1,$2) ORDER BY id',
          [
            `${kind.event}_RELATIONSHIP_CREATED`,
            `${kind.event}_RELATIONSHIP_REMOVED`,
          ],
        )
      ).rows;
      expect(history.map((event) => event.type)).toEqual([
        `${kind.event}_RELATIONSHIP_CREATED`,
        `${kind.event}_RELATIONSHIP_REMOVED`,
      ]);
      for (const event of history) {
        expect(event.payload.data).toEqual(link);
        expect(event.payload.actor).toBe('operator');
      }
      expect(history[1]?.payload.requestId).toBe(
        removed.headers['x-request-id'],
      );
      expect(
        (await createLink(app, base, a, b, kind.directed)).statusCode,
      ).toBe(201);
    });
  });
});

it('rejects agent callers and self-links at the shared operation boundary', async () => {
  await setup(async ({ db, workspaceId, goals, work }) => {
    const agent = { ...operator, actor: 'agent' } as unknown as OperatorActor;
    await expect(
      createGoalRelationship(
        db,
        workspaceId,
        { sourceId: goals[0], targetId: goals[1], type: 'contributes_to' },
        agent,
      ),
    ).rejects.toThrow(/human operator/);
    await expect(
      createWorkItemRelationship(
        db,
        workspaceId,
        { sourceId: work[0], targetId: work[1], type: 'blocks' },
        agent,
      ),
    ).rejects.toThrow(/human operator/);
    await expect(
      removeGoalRelationship(db, workspaceId, randomUUID(), agent),
    ).rejects.toThrow(/human operator/);
    await expect(
      removeWorkItemRelationship(db, workspaceId, randomUUID(), agent),
    ).rejects.toThrow(/human operator/);
    await expect(
      createGoalRelationship(
        db,
        workspaceId,
        { sourceId: goals[0], targetId: goals[0], type: 'contributes_to' },
        operator,
      ),
    ).rejects.toThrow(/itself/);
    await expect(
      createWorkItemRelationship(
        db,
        workspaceId,
        { sourceId: work[0], targetId: work[0], type: 'blocks' },
        operator,
      ),
    ).rejects.toThrow(/itself/);
  });
});

function createLink(
  app: ReturnType<typeof buildApp>,
  base: string,
  sourceId: string,
  targetId: string,
  type: string,
) {
  return app.inject({
    method: 'POST',
    url: base,
    headers,
    payload: { sourceId, targetId, type },
  });
}

async function setup(run: (context: Context) => Promise<void>) {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    const db = connectDatabase(url);
    const app = buildApp(db, token);
    try {
      const workspace = await createWorkspace(
        db,
        { slug: 'first', name: 'First' },
        operator,
      );
      const goals: string[] = [];
      const work: string[] = [];
      for (let i = 0; i < 3; i++) {
        const goal = await createGoal(
          db,
          workspace.id,
          { title: `Goal ${i}`, objective: 'An outcome' },
          operator,
        );
        goals.push(goal.id);
        const item = await createWorkItem(
          db,
          workspace.id,
          {
            goalId: goal.id,
            title: `Work ${i}`,
            objective: 'Advance outcome',
            acceptanceCriteria: ['Done'],
          },
          operator,
        );
        work.push(item.id);
      }
      await run({
        app,
        db,
        client,
        workspaceId: workspace.id,
        goals: goals as [string, string, string],
        work: work as [string, string, string],
        url,
      });
    } finally {
      await app.close();
      await db.destroy();
    }
  });
}

interface Context {
  app: ReturnType<typeof buildApp>;
  db: Kysely<Database>;
  client: pg.Client;
  workspaceId: string;
  goals: [string, string, string];
  work: [string, string, string];
  url: string;
}
interface Link {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
}
const token = randomUUID();
const headers = { authorization: `Bearer ${token}` };
const operator: OperatorActor = { actor: 'operator', source: 'workspace-http' };
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
