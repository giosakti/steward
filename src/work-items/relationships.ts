import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import { showWorkItem } from './work-items.js';
import {
  createWorkItemRelationshipSchema,
  type CreateWorkItemRelationshipInput,
} from './schemas.js';
import type { WorkItemRelationship } from './types.js';

export async function createWorkItemRelationship(
  db: Kysely<Database>,
  workspaceId: string,
  input: CreateWorkItemRelationshipInput,
  actor: OperatorActor,
): Promise<WorkItemRelationship> {
  const operator = validateOperatorActor(actor);
  const parsed = createWorkItemRelationshipSchema.parse(input);
  let { sourceId, targetId } = parsed;
  if (parsed.type === 'relates_to' && sourceId > targetId) {
    [sourceId, targetId] = [targetId, sourceId];
  }
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await lockWorkspace(trx, workspaceId);
      await showWorkItem(trx, workspaceId, sourceId);
      await showWorkItem(trx, workspaceId, targetId);
      const existing = await trx
        .selectFrom('work_item_relationships')
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
        parsed.type === 'blocks' &&
        (await wouldCreateCycle(trx, workspaceId, sourceId, targetId))
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Relationship would create a cycle',
        );
      }
      const relationship = await trx
        .insertInto('work_item_relationships')
        .values({
          id: randomUUID(),
          workspace_id: workspaceId,
          source_id: sourceId,
          target_id: targetId,
          type: parsed.type,
          created_by: JSON.stringify(operator),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('events')
        .values({
          workspace_id: workspaceId,
          type: 'WORK_ITEM_RELATIONSHIP_CREATED',
          payload: { ...operator, data: relationship },
        })
        .execute();
      return relationship;
    });
}

export async function removeWorkItemRelationship(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
  actor: OperatorActor,
): Promise<void> {
  const operator = validateOperatorActor(actor);
  await db.transaction().execute(async (trx) => {
    await lockWorkspace(trx, workspaceId);
    const relationship = await trx
      .deleteFrom('work_item_relationships')
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
        type: 'WORK_ITEM_RELATIONSHIP_REMOVED',
        payload: { ...operator, data: relationship },
      })
      .execute();
  });
}

export async function listWorkItemRelationships(
  db: Kysely<Database>,
  workspaceId: string,
  entityId?: string,
): Promise<WorkItemRelationship[]> {
  await showWorkspace(db, workspaceId);
  if (entityId !== undefined) {
    await showWorkItem(db, workspaceId, entityId);
  }
  let query = db
    .selectFrom('work_item_relationships')
    .selectAll()
    .where('workspace_id', '=', workspaceId);
  if (entityId !== undefined) {
    query = query.where((eb) =>
      eb.or([eb('source_id', '=', entityId), eb('target_id', '=', entityId)]),
    );
  }
  return query.orderBy('created_at').orderBy('id').execute();
}

export async function showWorkItemRelationship(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
): Promise<WorkItemRelationship> {
  await showWorkspace(db, workspaceId);
  const relationship = await db
    .selectFrom('work_item_relationships')
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
      SELECT target_id FROM work_item_relationships
      WHERE workspace_id = ${workspaceId} AND type = 'blocks' AND source_id = ${targetId}
      UNION
      SELECT edge.target_id FROM work_item_relationships edge
      JOIN reachable ON edge.source_id = reachable.id
      WHERE edge.workspace_id = ${workspaceId} AND edge.type = 'blocks'
    )
    SELECT EXISTS (SELECT 1 FROM reachable WHERE id = ${sourceId}) AS cycle
  `.execute(db);
  return result.rows[0]!.cycle;
}
