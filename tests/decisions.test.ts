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
import { assessResponse } from '../src/decisions/policy.js';
import { buildApp } from '../src/http/app.js';
import { connectDatabase, type Database } from '../src/storage/database.js';
import { createWorkspace, showAgent } from '../src/workspaces/workspaces.js';
import type { Workspace } from '../src/workspaces/types.js';
import { isolated } from './database.js';
import { preparation, proposal, response } from './decision-fixtures.js';

interface Context {
  db: Kysely<Database>;
  client: pg.Client;
  workspace: Workspace;
  url: string;
}
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const operator: OperatorActor = { actor: 'operator', source: 'workspace-http' };

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

describe('decision evidence foundation', () => {
  it('preserves the supplied context, policy and judgments without executing anything', async () => {
    await setup(async ({ db, client, workspace, url }) => {
      const proposed = proposal();
      proposed.riskLabels = ['DESTRUCTIVE', 'SECURITY_SENSITIVE'];
      const prepared = preparation();
      prepared.policy!.riskLabels = ['SECURITY_SENSITIVE', 'DESTRUCTIVE'];
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposed,
        operator,
      );
      expect(intent.proposal.riskLabels).toEqual(proposed.riskLabels);
      const before = await showAgent(db, workspace.id);
      const evaluate = vi.fn<EvaluateJev>(async () => {
        const requested = await client.query<{
          payload: { evidence: { reason: string } };
        }>("SELECT payload FROM events WHERE type='DECISION_REQUESTED'");
        expect(requested.rows).toHaveLength(1);
        expect(requested.rows[0]?.payload.evidence.reason).toBe(
          'Awaiting semantic evaluation',
        );
        return response();
      });
      const decision = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        prepared,
        operator,
        evaluate,
      );
      expect(decision.verdict).toBe('ALLOW');
      expect(evaluate).toHaveBeenCalledOnce();
      expect(decision.evidence.context).toEqual(prepared.context);
      expect(decision.evidence.policy).toEqual(prepared.policy);
      expect(decision.evidence.assessments).toHaveLength(2);
      expect(decision.evidence.checks).toEqual(prepared.checks);
      expect(
        assessResponse(decision.evidence.jevResponse, decision.evidence.policy!)
          .verdict,
      ).toBe(decision.verdict);
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

  it('does not call Jev when prerequisites fail or preparation is incomplete', async () => {
    await setup(async ({ db, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(),
        operator,
      );
      const evaluate = vi.fn<EvaluateJev>(() => Promise.resolve(response()));
      const prepared = preparation();
      for (const patch of [
        { context: null },
        { policy: null },
        { checks: [] },
      ]) {
        const decision = await evaluateIntent(
          db,
          workspace.id,
          intent.id,
          { ...prepared, ...patch },
          operator,
          evaluate,
        );
        expect(decision.verdict).toBe('ESCALATE');
        expect(decision.evidence.jevRequest).toBeNull();
      }
      const failed = {
        ...prepared,
        checks: [
          {
            name: 'scope',
            passed: false,
            evidence: 'Target outside permitted worktree',
          },
        ],
      };
      expect(
        (
          await evaluateIntent(
            db,
            workspace.id,
            intent.id,
            failed,
            operator,
            evaluate,
          )
        ).verdict,
      ).toBe('DENY');
      const wrongRisk = {
        ...prepared,
        policy: { ...prepared.policy!, riskLabels: ['READ_ONLY' as const] },
      };
      expect(
        (
          await evaluateIntent(
            db,
            workspace.id,
            intent.id,
            wrongRisk,
            operator,
            evaluate,
          )
        ).verdict,
      ).toBe('DENY');
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  it('records Jev failures separately from invalid responses without storing SDK secrets', async () => {
    await setup(async ({ db, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(),
        operator,
      );
      for (const evaluate of [
        createJevEvaluator(undefined),
        () => Promise.reject(new Error('secret-api-key')),
      ]) {
        const decision = await evaluateIntent(
          db,
          workspace.id,
          intent.id,
          preparation(),
          operator,
          evaluate,
        );
        expect(decision.verdict).toBe('ESCALATE');
        expect(decision.evidence.evaluationError).toBe('JEV_UNAVAILABLE');
        expect(JSON.stringify(decision)).not.toContain('secret-api-key');
      }
      const malformed = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        preparation(),
        operator,
        () => Promise.resolve({ answers: {} }),
      );
      expect(malformed.verdict).toBe('ESCALATE');
      expect(malformed.evidence.evaluationError).toBe('INVALID_RESPONSE');
      expect(malformed.evidence.jevResponse).toEqual({ answers: {} });
    });
  });

  it('enforces workspace isolation in reads, evaluation, and foreign keys', async () => {
    await setup(async ({ db, client, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(),
        operator,
      );
      const decision = await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        preparation(),
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
        evaluateIntent(
          db,
          other.id,
          intent.id,
          preparation(),
          operator,
          evaluate,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(evaluate).not.toHaveBeenCalled();
      await expect(
        client.query(
          "INSERT INTO decisions(id,workspace_id,action_intent_id,verdict,policy_version,evidence) VALUES ($1,$2,$3,'ALLOW','test','{}')",
          [randomUUID(), other.id, intent.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  it('preserves immutable evidence and rolls back decisions when the verdict event fails', async () => {
    await setup(async ({ db, client, workspace }) => {
      const intent = await createActionIntent(
        db,
        workspace.id,
        proposal(),
        operator,
      );
      await evaluateIntent(
        db,
        workspace.id,
        intent.id,
        preparation(),
        operator,
        () => Promise.resolve(response()),
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
          preparation(),
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
        createActionIntent(db, workspace.id, proposal(), operator),
      ).rejects.toThrow(/reject_intent/);
      expect(
        (await client.query('SELECT * FROM action_intents')).rows,
      ).toHaveLength(0);
    });
  });

  it('does not expose proposal evaluation over HTTP or intercept operator configuration', async () => {
    await setup(async ({ db, workspace }) => {
      const token = randomUUID();
      const app = buildApp(db, token);
      const base = `/api/v1/workspaces/${workspace.id}`;
      const headers = { authorization: `Bearer ${token}` };
      try {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/action-intents`,
              headers,
              payload: proposal(),
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/action-intents/${randomUUID()}/decisions`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `${base}/agent`,
              headers,
              payload: { title: 'Engineering Lead' },
            })
          ).statusCode,
        ).toBe(200);
        expect(await db.selectFrom('decisions').selectAll().execute()).toEqual(
          [],
        );
      } finally {
        await app.close();
      }
    });
  });
});
