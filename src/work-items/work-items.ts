import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import { showGoal } from '../goals/goals.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
} from './schemas.js';
import type { WorkItem } from './types.js';

export async function createWorkItem(
  db: Kysely<Database>,
  workspaceId: string,
  input: CreateWorkItemInput,
  actor: OperatorActor,
): Promise<WorkItem> {
  const operator = validateOperatorActor(actor);
  const parsed = createWorkItemSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    await showGoal(trx, workspaceId, parsed.goalId);
    if (parsed.parentWorkItemId) {
      await showWorkItem(trx, workspaceId, parsed.parentWorkItemId);
    }
    const item = await trx
      .insertInto('work_items')
      .values({
        id: randomUUID(),
        workspace_id: workspaceId,
        goal_id: parsed.goalId,
        parent_work_item_id: parsed.parentWorkItemId ?? null,
        title: parsed.title,
        objective: parsed.objective,
        acceptance_criteria: JSON.stringify(parsed.acceptanceCriteria),
        status: 'proposed',
        priority: parsed.priority ?? 0,
        created_by: JSON.stringify(operator),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: 'WORK_ITEM_CREATED',
        payload: { ...operator, data: item },
      })
      .execute();
    return item;
  });
}

export async function updateWorkItem(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
  input: UpdateWorkItemInput,
  actor: OperatorActor,
): Promise<WorkItem> {
  const operator = validateOperatorActor(actor);
  const parsed = updateWorkItemSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    await showWorkspace(trx, workspaceId);
    const before = await trx
      .selectFrom('work_items')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Work Item not found in workspace',
      );
    }
    // Run-owned work must not change underneath execution or result review.
    if (before.status === 'running' || before.status === 'needs_review') {
      throw new ApplicationError(
        'CONFLICT',
        'Work Item is controlled by a Run',
      );
    }
    const { acceptanceCriteria, ...fields } = parsed;
    const item = await trx
      .updateTable('work_items')
      .set({
        ...fields,
        ...(acceptanceCriteria !== undefined
          ? { acceptance_criteria: JSON.stringify(acceptanceCriteria) }
          : {}),
        updated_at: sql<Date>`now()`,
      })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: 'WORK_ITEM_UPDATED',
        payload: { ...operator, before, data: item },
      })
      .execute();
    return item;
  });
}

export async function listWorkItems(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<WorkItem[]> {
  await showWorkspace(db, workspaceId);
  return db
    .selectFrom('work_items')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .orderBy('priority', 'desc')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function showWorkItem(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
): Promise<WorkItem> {
  await showWorkspace(db, workspaceId);
  const item = await db
    .selectFrom('work_items')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!item) {
    throw new ApplicationError('NOT_FOUND', 'Work Item not found in workspace');
  }
  return item;
}
