import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import {
  createGoalSchema,
  updateGoalSchema,
  type CreateGoalInput,
  type UpdateGoalInput,
} from './schemas.js';
import type { Goal } from './types.js';

export async function createGoal(
  db: Kysely<Database>,
  workspaceId: string,
  input: CreateGoalInput,
  actor: OperatorActor,
): Promise<Goal> {
  const operator = validateOperatorActor(actor);
  const parsed = createGoalSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    await showWorkspace(trx, workspaceId);
    const goal = await trx
      .insertInto('goals')
      .values({
        id: randomUUID(),
        workspace_id: workspaceId,
        title: parsed.title,
        objective: parsed.objective,
        status: 'active',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: 'GOAL_CREATED',
        payload: { ...operator, data: goal },
      })
      .execute();
    return goal;
  });
}

export async function updateGoal(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
  input: UpdateGoalInput,
  actor: OperatorActor,
): Promise<Goal> {
  const operator = validateOperatorActor(actor);
  const parsed = updateGoalSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    await showWorkspace(trx, workspaceId);
    const before = await trx
      .selectFrom('goals')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) {
      throw new ApplicationError('NOT_FOUND', 'Goal not found in workspace');
    }
    const goal = await trx
      .updateTable('goals')
      .set({ ...parsed, updated_at: sql<Date>`now()` })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: 'GOAL_UPDATED',
        payload: { ...operator, before, data: goal },
      })
      .execute();
    return goal;
  });
}

export async function listGoals(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<Goal[]> {
  await showWorkspace(db, workspaceId);
  return db
    .selectFrom('goals')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function showGoal(
  db: Kysely<Database>,
  workspaceId: string,
  id: string,
): Promise<Goal> {
  await showWorkspace(db, workspaceId);
  const goal = await db
    .selectFrom('goals')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!goal) {
    throw new ApplicationError('NOT_FOUND', 'Goal not found in workspace');
  }
  return goal;
}
