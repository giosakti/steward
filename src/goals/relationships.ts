import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import { showGoal } from './goals.js';
import {
  createGoalRelationshipSchema,
  type CreateGoalRelationshipInput,
} from './schemas.js';
import type { GoalRelationship } from './types.js';

export async function createGoalRelationship(
  db: Kysely<Database>,
  workspaceId: string,
  input: CreateGoalRelationshipInput,
  actor: OperatorActor,
): Promise<GoalRelationship> {
  const operator = validateOperatorActor(actor);
  const parsed = createGoalRelationshipSchema.parse(input);
  let { sourceId, targetId } = parsed;
  if (parsed.type === 'relates_to' && sourceId > targetId) {
    [sourceId, targetId] = [targetId, sourceId];
  }
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await lockWorkspace(trx, workspaceId);
      await showGoal(trx, workspaceId, sourceId);
      await showGoal(trx, workspaceId, targetId);
      const existing = await trx
        .selectFrom('goal_relationships')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('type', '=', parsed.type)
        .where('source_id', '=', sourceId)
        .where('target_id', '=', targetId)
        .executeTakeFirst();
      if (existing) {
        throw new ApplicationError('CONFLICT', 'Relationship already exists');
      }
      if (
        parsed.type === 'contributes_to' &&
        (await wouldCreateCycle(trx, workspaceId, sourceId, targetId))
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Relationship would create a cycle',
        );
      }
      const relationship = await trx
        .insertInto('goal_relationships')
        .values({
          id: randomUUID(),
          workspace_id: workspaceId,
          source_id: sourceId,
          target_id: targetId,
          type: parsed.type,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('events')
        .values({
          workspace_id: workspaceId,
          type: 'GOAL_RELATIONSHIP_CREATED',
          payload: { ...operator, data: relationship },
        })
        .execute();
      return relationship;
    });
}

export async function removeGoalRelationship(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
  actor: OperatorActor,
): Promise<void> {
  const operator = validateOperatorActor(actor);
  await db.transaction().execute(async (trx) => {
    await lockWorkspace(trx, workspaceId);
    const relationship = await trx
      .deleteFrom('goal_relationships')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!relationship) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Relationship not found in workspace',
      );
    }
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: 'GOAL_RELATIONSHIP_REMOVED',
        payload: { ...operator, data: relationship },
      })
      .execute();
  });
}

export async function listGoalRelationships(
  db: Kysely<Database>,
  workspaceId: string,
  entityId?: string,
): Promise<GoalRelationship[]> {
  await showWorkspace(db, workspaceId);
  if (entityId !== undefined) {
    await showGoal(db, workspaceId, entityId);
  }
  let query = db
    .selectFrom('goal_relationships')
    .selectAll()
    .where('workspace_id', '=', workspaceId);
  if (entityId !== undefined) {
    query = query.where((eb) =>
      eb.or([eb('source_id', '=', entityId), eb('target_id', '=', entityId)]),
    );
  }
  return query.orderBy('created_at').orderBy('id').execute();
}

export async function showGoalRelationship(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
): Promise<GoalRelationship> {
  await showWorkspace(db, workspaceId);
  const relationship = await db
    .selectFrom('goal_relationships')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!relationship) {
    throw new ApplicationError(
      'NOT_FOUND',
      'Relationship not found in workspace',
    );
  }
  return relationship;
}

async function lockWorkspace(db: Transaction<Database>, workspaceId: string) {
  // Serialize link mutations before reading edges: concurrent inserts must not
  // both pass cycle detection against an older graph. The next query sees commits.
  const workspace = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .where('archived_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!workspace) {
    throw new ApplicationError('NOT_FOUND', 'Workspace not found');
  }
}

async function wouldCreateCycle(
  db: Transaction<Database>,
  workspaceId: string,
  sourceId: string,
  targetId: string,
): Promise<boolean> {
  const result = await sql<{ cycle: boolean }>`
    WITH RECURSIVE reachable(id) AS (
      SELECT target_id FROM goal_relationships
      WHERE workspace_id = ${workspaceId} AND type = 'contributes_to' AND source_id = ${targetId}
      UNION
      SELECT edge.target_id FROM goal_relationships edge
      JOIN reachable ON edge.source_id = reachable.id
      WHERE edge.workspace_id = ${workspaceId} AND edge.type = 'contributes_to'
    )
    SELECT EXISTS (SELECT 1 FROM reachable WHERE id = ${sourceId}) AS cycle
  `.execute(db);
  return result.rows[0]!.cycle;
}
