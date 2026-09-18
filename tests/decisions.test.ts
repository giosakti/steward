import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { Kysely } from 'kysely';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorActor } from '../src/audit/actor.js';
import {
  createActionIntent,
  evaluateIntent,
  showActionIntent,
  showDecision,
} from '../src/decisions/decisions.js';
import { createJevEvaluator, type EvaluateJev } from '../src/decisions/jev.js';
import { fingerprint } from '../src/decisions/context.js';
import { assessResponse } from '../src/decisions/policy.js';
import type { Decision } from '../src/decisions/types.js';
import { buildApp } from '../src/http/app.js';
import { connectDatabase, type Database } from '../src/storage/database.js';
import {
  createWorkspace,
  configureAgent,
  showAgent,
} from '../src/workspaces/workspaces.js';
import type { Workspace } from '../src/workspaces/types.js';
import { isolated } from './database.js';
import { proposal, response } from './decision-fixtures.js';

interface Context {
  db: Kysely<Database>;
  client: pg.Client;
  workspace: Workspace;
  url: string;
}
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const operator: OperatorActor = { actor: 'operator', source: 'decision-http' };

async function setup(run: (context: Context) => Promise<void>) {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    const db = connectDatabase(url);
    try {
      const workspace = await createWorkspace(
        db,
        { slug: 'first', name: 'First' },
        operator,
      );
      await run({ db, client, workspace, url });
    } finally {
      await db.destroy();
    }
  });
}

describe('persisted decision evaluation', () => {
  it('records complete evidence without changing the agent and survives reconnection', async () => {
    await setup(async ({ db, client, workspace, url }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(workspace),
        operator,
      );
      const before = await showAgent(db, workspace.id);
      const evaluate = vi.fn<EvaluateJev>(async () => {
        expect(
          (
            await client.query(
              "SELECT * FROM events WHERE type='DECISION_REQUESTED'",
            )
          ).rows,
        ).toHaveLength(1);
        return response();
      });
      const decision = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        operator,
        evaluate,
      );
      expect(decision.outcome).toBe('ALLOW');
      expect(evaluate).toHaveBeenCalledOnce();
      expect(decision.evidence.context.agent.id).toBe(workspace.root_agent_id);
      expect(decision.evidence.context.provenance.agent).toContain(
        workspace.root_agent_id,
      );
      expect(decision.evidence.assessments).toHaveLength(3);
      expect(fingerprint(decision.evidence.context)).toBe(
        decision.evidence.stateFingerprint,
      );
      expect(decision.evidence.checks.every((check) => check.passed)).toBe(
        true,
      );
      expect(assessResponse(decision.evidence.response).outcome).toBe(
        decision.outcome,
      );
      expect(await showAgent(db, workspace.id)).toEqual(before);
      expect(decision).not.toHaveProperty('authorization');
      const connection = connectDatabase(url);
      try {
        expect(
          await showDecision(connection, workspace.id, decision.id),
        ).toEqual(decision);
        expect(
          await showActionIntent(connection, workspace.id, intent.id),
        ).toEqual(intent);
      } finally {
        await connection.destroy();
      }
    });
  });

  it('denies unsupported actions, scope/target mismatches, and risk downgrades without calling Jev', async () => {
    await setup(async ({ db, workspace }) => {
      const other = await createWorkspace(
        db,
        { slug: 'second', name: 'Second' },
        operator,
      );
      const evaluate = vi.fn<EvaluateJev>(() => Promise.resolve(response()));
      for (const patch of [
        { type: 'deploy' },
        { intendedScope: other.id },
        { intendedTarget: other.root_agent_id },
        { riskClass: 'READ_ONLY' },
        { riskClass: 'SECURITY_SENSITIVE' },
      ]) {
        const intent = await createActionIntent(
          db,
          workspace.id,
          { ...proposal(workspace), ...patch },
          operator,
        );
        const decision = await evaluateIntent(
          db,
          workspace.id,
          intent.id,
          operator,
          evaluate,
        );
        expect(decision.outcome).toBe('DENY');
        expect(decision.evidence.request).toBeNull();
        expect(decision.evidence.checks.some((check) => !check.passed)).toBe(
          true,
        );
      }
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  it('escalates missing Jev and malformed answers, preserving failures without SDK secrets', async () => {
    await setup(async ({ db, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(workspace),
        operator,
      );
      for (const evaluate of [
        createJevEvaluator(undefined),
        () => Promise.resolve({ answers: {} }),
        () => Promise.reject(new Error('secret-api-key')),
      ]) {
        const decision = await evaluateIntent(
          db,
          workspace.id,
          intent.id,
          operator,
          evaluate,
        );
        expect(decision.outcome).toBe('ESCALATE');
        expect(decision.evidence.evaluationError).not.toBeNull();
        expect(JSON.stringify(decision)).not.toContain('secret-api-key');
      }
      const malformed = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        operator,
        () => Promise.resolve({ answers: {} }),
      );
      expect(malformed.evidence.response).toEqual({ answers: {} });
    });
  });

  it('escalates a state change during Jev evaluation and denies archived workspaces', async () => {
    await setup(async ({ db, client, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(workspace),
        operator,
      );
      const decision = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        operator,
        async () => {
          await configureAgent(
            db,
            { title: 'Changed concurrently' },
            workspace.id,
            operator,
          );
          return response();
        },
      );
      expect(decision.outcome).toBe('ESCALATE');
      expect(decision.evidence.context.agent.title).toBe('Steward');
      expect(decision.evidence.recheckedContext?.agent.title).toBe(
        'Changed concurrently',
      );
      expect(decision.evidence.checks.at(-1)?.passed).toBe(false);
      await client.query(
        'UPDATE workspaces SET archived_at=now() WHERE id=$1',
        [workspace.id],
      );
      const evaluate = vi.fn<EvaluateJev>(() => Promise.resolve(response()));
      expect(
        (await evaluateIntent(db, workspace.id, intent.id, operator, evaluate))
          .outcome,
      ).toBe('DENY');
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  it('enforces workspace isolation in reads, evaluation, and foreign keys', async () => {
    await setup(async ({ db, client, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(workspace),
        operator,
      );
      const decision = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        operator,
        () => Promise.resolve(response()),
      );
      const other = await createWorkspace(
        db,
        { slug: 'second', name: 'Second' },
        operator,
      );
      await expect(
        showActionIntent(db, other.id, intent.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        showDecision(db, other.id, decision.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const evaluate = vi.fn<EvaluateJev>(() => Promise.resolve(response()));
      await expect(
        evaluateIntent(db, other.id, intent.id, operator, evaluate),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(evaluate).not.toHaveBeenCalled();
      await expect(
        client.query(
          "INSERT INTO decisions(id,workspace_id,action_intent_id,outcome,policy_version,evidence) VALUES ($1,$2,$3,'ALLOW','test','{}')",
          [randomUUID(), other.id, intent.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  it('preserves immutable evidence and rolls back decisions when their outcome event fails', async () => {
    await setup(async ({ db, client, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(workspace),
        operator,
      );
      await evaluateIntent(db, workspace.id, intent.id, operator, () =>
        Promise.resolve(response()),
      );
      for (const table of ['action_intents', 'decisions']) {
        for (const statement of [
          `DELETE FROM ${table}`,
          `UPDATE ${table} SET id=id`,
          `TRUNCATE ${table} CASCADE`,
        ]) {
          await expect(client.query(statement)).rejects.toThrow(/append-only/);
        }
      }
      await client.query(
        "ALTER TABLE events ADD CONSTRAINT reject_decision CHECK (type <> 'DECISION_ESCALATED')",
      );
      await expect(
        evaluateIntent(
          db,
          workspace.id,
          intent.id,
          operator,
          createJevEvaluator(undefined),
        ),
      ).rejects.toThrow(/reject_decision/);
      expect((await client.query('SELECT * FROM decisions')).rows).toHaveLength(
        1,
      );
      expect(
        (
          await client.query(
            "SELECT * FROM events WHERE type='DECISION_REQUESTED'",
          )
        ).rows,
      ).toHaveLength(2);
    });
  });

  it('rolls back proposals when their audit event fails', async () => {
    await setup(async ({ db, client, workspace }) => {
      await client.query(
        "ALTER TABLE events ADD CONSTRAINT reject_intent CHECK (type <> 'ACTION_INTENT_CREATED')",
      );
      await expect(
        createActionIntent(db, workspace.id, proposal(workspace), operator),
      ).rejects.toThrow(/reject_intent/);
      expect(
        (await client.query('SELECT * FROM action_intents')).rows,
      ).toHaveLength(0);
    });
  });
});

describe('decision HTTP routes', () => {
  it('requires authentication, rejects caller-supplied authority, and exposes scoped evidence', async () => {
    await setup(async ({ db, workspace }) => {
      const token = randomUUID();
      const app = buildApp(db, token, false, () => Promise.resolve(response()));
      const base = `/api/v1/workspaces/${workspace.id}`;
      const headers = { authorization: `Bearer ${token}` };
      try {
        for (const [method, url] of [
          ['POST', `${base}/action-intents`],
          ['GET', `${base}/action-intents/${randomUUID()}`],
          ['POST', `${base}/action-intents/${randomUUID()}/decisions`],
          ['GET', `${base}/decisions/${randomUUID()}`],
        ] as const) {
          expect((await app.inject({ method, url })).statusCode).toBe(401);
        }
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/action-intents`,
              headers,
              payload: { ...proposal(workspace), proposedBy: 'Gio' },
            })
          ).statusCode,
        ).toBe(400);
        const created = await app.inject({
          method: 'POST',
          url: `${base}/action-intents`,
          headers,
          payload: proposal(workspace),
        });
        expect(created.statusCode).toBe(201);
        const id = created.json<{ id: string }>().id;
        expect(
          (await app.inject({ url: `${base}/action-intents/${id}`, headers }))
            .statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/action-intents/${id}/decisions`,
              headers,
              payload: { outcome: 'ALLOW' },
            })
          ).statusCode,
        ).toBe(400);
        const result = await app.inject({
          method: 'POST',
          url: `${base}/action-intents/${id}/decisions`,
          headers,
          payload: {},
        });
        expect(result.statusCode).toBe(201);
        const decision = result.json<Decision>();
        expect(decision.outcome).toBe('ALLOW');
        expect(
          (
            await app.inject({
              url: `${base}/decisions/${decision.id}`,
              headers,
            })
          ).json(),
        ).toEqual(decision);
        expect(
          (
            await app.inject({
              url: `/api/v1/workspaces/${randomUUID()}/decisions/${decision.id}`,
              headers,
            })
          ).statusCode,
        ).toBe(404);
        expect((await showAgent(db, workspace.id)).title).toBe('Steward');
      } finally {
        await app.close();
      }
    });
  });
});
