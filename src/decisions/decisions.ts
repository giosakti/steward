import { randomUUID } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import type { EvaluateJev } from './jev.js';
import {
  assessResponse,
  checkPrerequisites,
  evaluationRequest,
} from './policy.js';
import {
  actionProposalSchema,
  decisionPreparationSchema,
  type PreparedDecision,
} from './schemas.js';
import type { ActionIntent, Decision, DecisionEvidence } from './types.js';

export async function createActionIntent(
  db: Kysely<Database>,
  workspaceId: string,
  input: unknown,
  actor: OperatorActor,
): Promise<ActionIntent> {
  const operator = validateOperatorActor(actor);
  const proposal = actionProposalSchema.parse(input);
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

// Internal entry point for future Work Item/Run orchestration. The preparation
// must come from trusted resolvers and policy code, not a proposal's author.
// This records an evaluation; no executor may treat it as an execution grant.
export async function evaluateIntent(
  db: Kysely<Database>,
  workspaceId: string,
  intentId: string,
  prepared: PreparedDecision,
  actor: OperatorActor,
  evaluateJev: EvaluateJev,
): Promise<Decision> {
  const operator = validateOperatorActor(actor);
  const intent = await showActionIntent(db, workspaceId, intentId);
  const preparation = decisionPreparationSchema.parse(prepared);
  const prerequisite = checkPrerequisites(intent.proposal, preparation);
  const request = prerequisite
    ? null
    : evaluationRequest(intent.proposal, preparation);
  const id = randomUUID();
  const policyVersion = preparation.policy?.version ?? 'NO_POLICY';
  const evidence: DecisionEvidence = {
    ...preparation,
    request,
    response: null,
    evaluationError: null,
    assessments: [],
    reason: prerequisite?.reason ?? 'Awaiting semantic evaluation',
  };
  // Durable before the network call. An interrupted attempt cannot imply ALLOW.
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

  let verdict = prerequisite?.verdict ?? 'ESCALATE';
  if (request && preparation.policy) {
    let failure: 'JEV_UNAVAILABLE' | 'INVALID_RESPONSE' = 'JEV_UNAVAILABLE';
    try {
      const raw = await evaluateJev(request);
      failure = 'INVALID_RESPONSE';
      evidence.response = z.json().parse(raw);
      const assessment = assessResponse(evidence.response, preparation.policy);
      verdict = assessment.verdict;
      evidence.assessments = assessment.assessments;
      evidence.reason = assessment.reason;
    } catch {
      verdict = 'ESCALATE';
      // Raw SDK errors may include credentials. Persist only a failure category.
      evidence.evaluationError = failure;
      evidence.reason = 'Semantic evaluation could not be established';
    }
  }

  return db.transaction().execute(async (trx) => {
    const decision = await trx
      .insertInto('decisions')
      .values({
        id,
        workspace_id: workspaceId,
        action_intent_id: intentId,
        verdict,
        policy_version: policyVersion,
        evidence: JSON.stringify(evidence),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const eventType = {
      ALLOW: 'DECISION_ALLOWED',
      DENY: 'DECISION_DENIED',
      ESCALATE: 'DECISION_ESCALATED',
    }[verdict];
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
