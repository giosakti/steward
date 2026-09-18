import { randomUUID } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import { fingerprint, resolveContext } from './context.js';
import type { EvaluateJev } from './jev.js';
import {
  assessResponse,
  deterministicChecks,
  evaluationRequest,
  policyVersion,
} from './policy.js';
import { actionIntentSchema } from './schemas.js';
import type {
  ActionIntent,
  Decision,
  DecisionEvidence,
  Outcome,
} from './types.js';

export async function createActionIntent(
  db: Kysely<Database>,
  workspaceId: string,
  input: unknown,
  actor: OperatorActor,
): Promise<ActionIntent> {
  const operator = validateOperatorActor(actor);
  const proposal = actionIntentSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    await showWorkspace(trx, workspaceId);
    const intent = await trx
      .insertInto('action_intents')
      .values({
        id: randomUUID(),
        workspace_id: workspaceId,
        proposal: JSON.stringify(proposal),
        proposed_by: JSON.stringify(operator),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await record(trx, workspaceId, 'ACTION_INTENT_CREATED', {
      operator,
      intent,
    });
    return intent;
  });
}

export async function showActionIntent(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
): Promise<ActionIntent> {
  const intent = await db
    .selectFrom('action_intents')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!intent) {
    throw new ApplicationError(
      'NOT_FOUND',
      'Action intent not found in workspace',
    );
  }
  return intent;
}

export async function evaluateIntent(
  db: Kysely<Database>,
  workspaceId: string,
  intentId: string,
  actor: OperatorActor,
  evaluateJev: EvaluateJev,
): Promise<Decision> {
  const operator = validateOperatorActor(actor);
  const intent = await showActionIntent(db, workspaceId, intentId);
  const context = await resolveContext(db, workspaceId);
  const checks = deterministicChecks(intent.proposal, context);
  const denied = checks.some((check) => !check.passed);
  const request = denied ? null : evaluationRequest(intent.proposal, context);
  const id = randomUUID();
  const evidence: DecisionEvidence = {
    context,
    recheckedContext: null,
    stateFingerprint: fingerprint(context),
    checks,
    request,
    response: null,
    evaluationError: null,
    assessments: [],
    reason: denied
      ? 'Deterministic check failed'
      : 'Awaiting semantic evaluation',
  };
  // Durable before the network call. An interrupted attempt remains inspectable;
  // it has a request event but no Decision, and cannot imply ALLOW.
  await db
    .insertInto('events')
    .values({
      workspace_id: workspaceId,
      type: 'DECISION_REQUESTED',
      payload: {
        decisionId: id,
        actionIntentId: intentId,
        operator,
        policyVersion,
        evidence,
      },
    })
    .execute();

  let outcome: Outcome = 'DENY';
  if (request) {
    try {
      // The SDK boundary is external data even though its TypeScript types are known.
      evidence.response = z.json().parse(await evaluateJev(request));
      const assessment = assessResponse(evidence.response);
      outcome = assessment.outcome;
      evidence.assessments = assessment.assessments;
      evidence.reason = assessment.reason;
    } catch {
      outcome = 'ESCALATE';
      // Do not serialize SDK errors: they may include request credentials.
      evidence.evaluationError = 'Jev unavailable or response invalid';
      evidence.reason = 'Semantic evaluation could not be established';
    }
  }

  return db.transaction().execute(async (trx) => {
    const current = await resolveContext(trx, workspaceId, true);
    evidence.recheckedContext = current;
    const unchanged = fingerprint(current) === evidence.stateFingerprint;
    evidence.checks.push({
      name: 'state_unchanged',
      passed: unchanged,
      evidence: `Evaluated ${evidence.stateFingerprint}; current ${fingerprint(current)}`,
    });
    if (!unchanged && outcome !== 'DENY') {
      outcome = 'ESCALATE';
      evidence.reason =
        'Authoritative state changed during evaluation; submit a new evaluation';
    }
    const decision = await trx
      .insertInto('decisions')
      .values({
        id,
        workspace_id: workspaceId,
        action_intent_id: intentId,
        outcome,
        policy_version: policyVersion,
        evidence: JSON.stringify(evidence),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const eventType = {
      ALLOW: 'DECISION_ALLOWED',
      DENY: 'DECISION_DENIED',
      ESCALATE: 'DECISION_ESCALATED',
    }[outcome];
    await record(trx, workspaceId, eventType, {
      decisionId: id,
      actionIntentId: intentId,
      operator,
    });
    return decision;
  });
}

export async function showDecision(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
): Promise<Decision> {
  const decision = await db
    .selectFrom('decisions')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!decision) {
    throw new ApplicationError('NOT_FOUND', 'Decision not found in workspace');
  }
  return decision;
}

async function record(
  db: Transaction<Database>,
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  await db
    .insertInto('events')
    .values({ workspace_id: workspaceId, type, payload })
    .execute();
}
