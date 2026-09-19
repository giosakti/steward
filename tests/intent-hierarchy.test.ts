import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { OperatorActor } from '../src/audit/actor.js';
import { createGoal, updateGoal, showGoal } from '../src/goals/goals.js';
import type { Goal } from '../src/goals/types.js';
import { buildApp } from '../src/http/app.js';
import { setMission, showMission } from '../src/workspaces/mission.js';
import { connectDatabase, type Database } from '../src/storage/database.js';
import {
  createWorkItem,
  updateWorkItem,
  showWorkItem,
} from '../src/work-items/work-items.js';
import type { WorkItem } from '../src/work-items/types.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
import type { Workspace } from '../src/workspaces/types.js';
import { isolated } from './database.js';

describe('operator intent hierarchy', () => {
  it('persists missions, goals and work with explicit operator attribution', async () => {
    await setup(async ({ app, db, workspace, url, client }) => {
      const base = `/api/v1/workspaces/${workspace.id}`;
      expect(
        (await app.inject({ url: `${base}/mission`, headers })).statusCode,
      ).toBe(404);
      const mission = await app.inject({
        method: 'PUT',
        url: `${base}/mission`,
        headers,
        payload: { statement: 'Build a useful Steward' },
      });
      expect(mission.statusCode).toBe(200);
      expect(mission.json()).toEqual({
        workspace_id: workspace.id,
        statement: 'Build a useful Steward',
      });
      const storedWorkspace = await app.inject({ url: base, headers });
      expect(
        storedWorkspace.json<{ mission_statement: string }>().mission_statement,
      ).toBe('Build a useful Steward');
      expect(
        (await app.inject({ url: `${base}/mission`, headers })).json(),
      ).toEqual(mission.json());
      const goalResponse = await app.inject({
        method: 'POST',
        url: `${base}/goals`,
        headers,
        payload: goalInput,
      });
      expect(goalResponse.statusCode).toBe(201);
      const goal = goalResponse.json<Goal>();
      expect(goalResponse.headers.location).toBe(`${base}/goals/${goal.id}`);
      const workResponse = await app.inject({
        method: 'POST',
        url: `${base}/work-items`,
        headers: { ...headers, 'x-actor': 'agent', 'x-request-id': 'spoofed' },
        payload: workInput(goal.id),
      });
      expect(workResponse.statusCode).toBe(201);
      const work = workResponse.json<WorkItem>();
      expect(workResponse.headers.location).toBe(
        `${base}/work-items/${work.id}`,
      );
      expect(work).toMatchObject({
        status: 'proposed',
        priority: 0,
        created_by: {
          actor: 'operator',
          source: 'workspace-http',
          requestId: workResponse.headers['x-request-id'],
        },
      });
      expect(work.created_by.requestId).not.toBe('spoofed');
      const prioritized = await createWorkItem(
        db,
        workspace.id,
        { ...workInput(goal.id), priority: 5 },
        operator,
      );
      expect(
        (await app.inject({ url: `${base}/goals`, headers })).json(),
      ).toHaveLength(1);
      const listing = await app.inject({ url: `${base}/work-items`, headers });
      expect(listing.json<WorkItem[]>()[0]?.id).toBe(prioritized.id);
      const connection = connectDatabase(url);
      try {
        expect((await showMission(connection, workspace.id)).statement).toBe(
          'Build a useful Steward',
        );
        expect(await showGoal(connection, workspace.id, goal.id)).toEqual(
          expect.objectContaining({ id: goal.id }),
        );
        expect(
          await showWorkItem(connection, workspace.id, prioritized.id),
        ).toEqual(prioritized);
      } finally {
        await connection.destroy();
      }
      expect((await client.query('SELECT * FROM decisions')).rows).toEqual([]);
    });
  });

  it('keeps one mission and preserves serial before/after evidence under concurrent setters', async () => {
    await setup(async ({ db, workspace, client }) => {
      const results = await Promise.all(
        ['First', 'Second'].map((statement) =>
          setMission(db, workspace.id, { statement }, operator),
        ),
      );
      expect(results.map((result) => result.workspace_id)).toEqual([
        workspace.id,
        workspace.id,
      ]);
      const stored = (
        await client.query<{ mission_statement: string }>(
          'SELECT mission_statement FROM workspaces WHERE id=$1',
          [workspace.id],
        )
      ).rows[0]!;
      expect(stored.mission_statement).toBe(
        (await showMission(db, workspace.id)).statement,
      );
      const events = (
        await client.query<{
          type: string;
          payload: {
            before: { statement: string } | null;
            data: { statement: string };
          };
        }>(
          "SELECT type, payload FROM events WHERE type LIKE 'MISSION_%' ORDER BY id",
        )
      ).rows;
      expect(events.map((event) => event.type)).toEqual([
        'MISSION_CREATED',
        'MISSION_UPDATED',
      ]);
      expect(events[0]?.payload.before).toBeNull();
      expect(events[1]?.payload.before?.statement).toBe(
        events[0]?.payload.data.statement,
      );
      expect((await showMission(db, workspace.id)).statement).toBe(
        events[1]?.payload.data.statement,
      );
    });
  });

  it('updates planning state with before/after evidence, without starting execution', async () => {
    await setup(async ({ app, db, workspace, client }) => {
      const goal = await createGoal(db, workspace.id, goalInput, operator);
      const work = await createWorkItem(
        db,
        workspace.id,
        workInput(goal.id),
        operator,
      );
      const base = `/api/v1/workspaces/${workspace.id}`;
      const goalUpdate = await app.inject({
        method: 'PATCH',
        url: `${base}/goals/${goal.id}`,
        headers,
        payload: { title: 'Reviewed improvement', status: 'paused' },
      });
      expect(goalUpdate.statusCode).toBe(200);
      expect(goalUpdate.json()).toMatchObject({
        objective: goal.objective,
        status: 'paused',
      });
      const workUpdate = await app.inject({
        method: 'PATCH',
        url: `${base}/work-items/${work.id}`,
        headers,
        payload: {
          acceptanceCriteria: ['Reviewed through a PR'],
          priority: 3,
          status: 'ready',
        },
      });
      expect(workUpdate.statusCode).toBe(200);
      expect(workUpdate.json()).toMatchObject({
        title: work.title,
        acceptance_criteria: ['Reviewed through a PR'],
        priority: 3,
        status: 'ready',
      });
      const event = (
        await client.query<{
          payload: { before: WorkItem; data: WorkItem; requestId: string };
        }>("SELECT payload FROM events WHERE type='WORK_ITEM_UPDATED'")
      ).rows[0]!;
      expect(event.payload.before.status).toBe('proposed');
      expect(event.payload.data.status).toBe('ready');
      expect(event.payload.requestId).toBe(workUpdate.headers['x-request-id']);
      expect((await client.query('SELECT * FROM action_intents')).rows).toEqual(
        [],
      );
      for (const status of [
        'blocked',
        'completed',
        'rejected',
        'proposed',
      ] as const) {
        expect(
          (
            await updateWorkItem(
              db,
              workspace.id,
              work.id,
              { status },
              operator,
            )
          ).status,
        ).toBe(status);
      }
    });
  });

  it('enforces workspace boundaries for reads, updates and required goals', async () => {
    await setup(async ({ app, db, workspace, client }) => {
      const other = await createWorkspace(
        db,
        { slug: 'other', name: 'Other' },
        operator,
      );
      const goal = await createGoal(db, workspace.id, goalInput, operator);
      const work = await createWorkItem(
        db,
        workspace.id,
        workInput(goal.id),
        operator,
      );
      const otherGoal = await createGoal(db, other.id, goalInput, operator);
      const base = `/api/v1/workspaces/${other.id}`;
      for (const resource of [`goals/${goal.id}`, `work-items/${work.id}`]) {
        expect(
          (await app.inject({ url: `${base}/${resource}`, headers }))
            .statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${base}/${resource}`,
              headers,
              payload: { title: 'Wrong workspace' },
            })
          ).statusCode,
        ).toBe(404);
      }
      for (const [resource, payload] of [
        ['work-items', workInput(goal.id)],
        ['work-items', workInput(randomUUID())],
      ] as const) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/${resource}`,
              headers,
              payload,
            })
          ).statusCode,
        ).toBe(404);
      }
      expect(
        (await app.inject({ url: `${base}/work-items`, headers })).json(),
      ).toEqual([]);
      await expect(
        client.query('UPDATE work_items SET goal_id=$1 WHERE id=$2', [
          otherGoal.id,
          work.id,
        ]),
      ).rejects.toThrow(/foreign key/);
      await expect(
        client.query('UPDATE work_items SET goal_id=NULL WHERE id=$1', [
          work.id,
        ]),
      ).rejects.toThrow(/null/);
    });
  });

  it('rejects invalid input, removed parent fields, forged identity and execution-owned statuses', async () => {
    await setup(async ({ app, db, workspace, client }) => {
      const goal = await createGoal(db, workspace.id, goalInput, operator);
      const work = await createWorkItem(
        db,
        workspace.id,
        workInput(goal.id),
        operator,
      );
      const base = `/api/v1/workspaces/${workspace.id}`;
      const count = (await client.query('SELECT * FROM events')).rows.length;
      const requests = [
        {
          method: 'POST',
          path: 'goals',
          payload: { ...goalInput, parentGoalId: goal.id },
        },
        {
          method: 'POST',
          path: 'work-items',
          payload: { ...workInput(goal.id), parentWorkItemId: work.id },
        },
        { method: 'PUT', path: 'mission', payload: { statement: ' ' } },
        {
          method: 'POST',
          path: 'goals',
          payload: { ...goalInput, objective: '' },
        },
        {
          method: 'POST',
          path: 'work-items',
          payload: { ...workInput(goal.id), goalId: undefined },
        },
        {
          method: 'POST',
          path: 'work-items',
          payload: { ...workInput(goal.id), acceptanceCriteria: [] },
        },
        {
          method: 'POST',
          path: 'work-items',
          payload: { ...workInput(goal.id), acceptanceCriteria: [' '] },
        },
        {
          method: 'POST',
          path: 'work-items',
          payload: { ...workInput(goal.id), createdBy: 'Gio' },
        },
        {
          method: 'POST',
          path: 'work-items',
          payload: { ...workInput(goal.id), status: 'running' },
        },
        { method: 'PATCH', path: `goals/${goal.id}`, payload: {} },
        {
          method: 'PATCH',
          path: `goals/${goal.id}`,
          payload: { parentGoalId: goal.id },
        },
        {
          method: 'PATCH',
          path: `goals/${goal.id}`,
          payload: { status: 'invented' },
        },
        { method: 'PATCH', path: `work-items/${work.id}`, payload: {} },
        {
          method: 'PATCH',
          path: `work-items/${work.id}`,
          payload: { parentWorkItemId: work.id },
        },
        {
          method: 'PATCH',
          path: `work-items/${work.id}`,
          payload: { goalId: goal.id },
        },
        {
          method: 'PATCH',
          path: `work-items/${work.id}`,
          payload: { status: 'running' },
        },
        {
          method: 'PATCH',
          path: `work-items/${work.id}`,
          payload: { status: 'needs_review' },
        },
        {
          method: 'PATCH',
          path: `work-items/${work.id}`,
          payload: { priority: 1.5 },
        },
        {
          method: 'PATCH',
          path: `work-items/${work.id}`,
          payload: { priority: 2147483648 },
        },
      ] as const;
      for (const { method, path, payload } of requests) {
        expect(
          (
            await app.inject({
              method,
              url: `${base}/${path}`,
              headers,
              payload,
            })
          ).statusCode,
          path,
        ).toBe(400);
      }
      expect(
        (await app.inject({ url: `${base}/goals/not-a-uuid`, headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: `${base}/work-items?workspace=other`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect((await client.query('SELECT * FROM events')).rows).toHaveLength(
        count,
      );
      for (const status of ['running', 'needs_review']) {
        await client.query('UPDATE work_items SET status=$1 WHERE id=$2', [
          status,
          work.id,
        ]);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${base}/work-items/${work.id}`,
              headers,
              payload: { status: 'ready' },
            })
          ).statusCode,
        ).toBe(409);
      }
    });
  });

  it('requires authentication on every route and rejects agent actors in shared operations', async () => {
    await setup(async ({ app, db, workspace }) => {
      const base = `/api/v1/workspaces/${workspace.id}`;
      for (const [method, path] of [
        ['GET', 'mission'],
        ['PUT', 'mission'],
        ['GET', 'goals'],
        ['POST', 'goals'],
        ['GET', `goals/${randomUUID()}`],
        ['PATCH', `goals/${randomUUID()}`],
        ['GET', 'work-items'],
        ['POST', 'work-items'],
        ['GET', `work-items/${randomUUID()}`],
        ['PATCH', `work-items/${randomUUID()}`],
      ] as const) {
        expect(
          (await app.inject({ method, url: `${base}/${path}` })).statusCode,
        ).toBe(401);
      }
      const agent = { ...operator, actor: 'agent' } as unknown as OperatorActor;
      await expect(
        setMission(db, workspace.id, { statement: 'No' }, agent),
      ).rejects.toThrow(/human operator/);
      await expect(
        createGoal(db, workspace.id, goalInput, agent),
      ).rejects.toThrow(/human operator/);
      await expect(
        updateGoal(db, workspace.id, randomUUID(), { status: 'active' }, agent),
      ).rejects.toThrow(/human operator/);
      await expect(
        createWorkItem(db, workspace.id, workInput(randomUUID()), agent),
      ).rejects.toThrow(/human operator/);
      await expect(
        updateWorkItem(
          db,
          workspace.id,
          randomUUID(),
          { status: 'ready' },
          agent,
        ),
      ).rejects.toThrow(/human operator/);
      await expect(
        setMission(db, workspace.id, { statement: ' ' }, operator),
      ).rejects.toThrow();
      await expect(
        createGoal(db, workspace.id, { ...goalInput, title: '' }, operator),
      ).rejects.toThrow();
      await expect(
        createWorkItem(
          db,
          workspace.id,
          { ...workInput(randomUUID()), acceptanceCriteria: [] },
          operator,
        ),
      ).rejects.toThrow();
    });
  });

  it('rolls back every mutation when its audit write fails', async () => {
    await setup(async ({ db, workspace, client }) => {
      const mission = await setMission(
        db,
        workspace.id,
        { statement: 'Original' },
        operator,
      );
      const goal = await createGoal(db, workspace.id, goalInput, operator);
      const work = await createWorkItem(
        db,
        workspace.id,
        workInput(goal.id),
        operator,
      );
      const other = await createWorkspace(
        db,
        { slug: 'other', name: 'Other' },
        operator,
      );
      await client.query(
        "ALTER TABLE events ADD CONSTRAINT reject_hierarchy CHECK (type NOT LIKE 'MISSION_%' AND type NOT LIKE 'GOAL_%' AND type NOT LIKE 'WORK_ITEM_%') NOT VALID",
      );
      const mutations = [
        () => setMission(db, other.id, { statement: 'New' }, operator),
        () => setMission(db, workspace.id, { statement: 'Changed' }, operator),
        () => createGoal(db, workspace.id, goalInput, operator),
        () =>
          updateGoal(db, workspace.id, goal.id, { title: 'Changed' }, operator),
        () => createWorkItem(db, workspace.id, workInput(goal.id), operator),
        () =>
          updateWorkItem(
            db,
            workspace.id,
            work.id,
            { status: 'ready' },
            operator,
          ),
      ];
      for (const mutation of mutations) {
        await expect(mutation()).rejects.toThrow(/reject_hierarchy/);
      }
      expect(await showMission(db, workspace.id)).toEqual(mission);
      await expect(showMission(db, other.id)).rejects.toThrow(/not set/);
      expect(await showGoal(db, workspace.id, goal.id)).toEqual(goal);
      expect(await showWorkItem(db, workspace.id, work.id)).toEqual(work);
      for (const table of ['goals', 'work_items']) {
        expect(
          (await client.query(`SELECT * FROM ${table}`)).rows,
        ).toHaveLength(1);
      }
    });
  });

  it('rejects reads and mutations in absent or archived workspaces', async () => {
    await setup(async ({ app, db, workspace, client }) => {
      const goal = await createGoal(db, workspace.id, goalInput, operator);
      const work = await createWorkItem(
        db,
        workspace.id,
        workInput(goal.id),
        operator,
      );
      await client.query(
        'UPDATE workspaces SET archived_at=now() WHERE id=$1',
        [workspace.id],
      );
      for (const workspaceId of [workspace.id, randomUUID()]) {
        const base = `/api/v1/workspaces/${workspaceId}`;
        for (const path of [
          'mission',
          'goals',
          `goals/${goal.id}`,
          'work-items',
          `work-items/${work.id}`,
        ]) {
          expect(
            (await app.inject({ url: `${base}/${path}`, headers })).statusCode,
          ).toBe(404);
        }
        for (const request of [
          { method: 'PUT', path: 'mission', payload: { statement: 'No' } },
          { method: 'POST', path: 'goals', payload: goalInput },
          { method: 'POST', path: 'work-items', payload: workInput(goal.id) },
          {
            method: 'PATCH',
            path: `goals/${goal.id}`,
            payload: { status: 'paused' },
          },
          {
            method: 'PATCH',
            path: `work-items/${work.id}`,
            payload: { status: 'ready' },
          },
        ] as const) {
          expect(
            (
              await app.inject({
                method: request.method,
                url: `${base}/${request.path}`,
                headers,
                payload: request.payload,
              })
            ).statusCode,
          ).toBe(404);
        }
      }
    });
  });
});

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
      await run({ app, db, client, workspace, url });
    } finally {
      await app.close();
      await db.destroy();
    }
  });
}

function workInput(goalId: string) {
  return {
    goalId,
    title: 'Isolate execution',
    objective: 'Use a Run-specific worktree',
    acceptanceCriteria: ['Base checkout stays unchanged'],
  };
}

interface Context {
  app: ReturnType<typeof buildApp>;
  db: Kysely<Database>;
  client: pg.Client;
  workspace: Workspace;
  url: string;
}
const token = randomUUID();
const headers = { authorization: `Bearer ${token}` };
const operator: OperatorActor = { actor: 'operator', source: 'workspace-http' };
const goalInput = {
  title: 'First self-hosted improvement',
  objective: 'Complete one reviewed change',
};
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
