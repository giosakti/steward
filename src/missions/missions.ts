import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { showWorkspace } from '../workspaces/workspaces.js';
import { setMissionSchema, type SetMissionInput } from './schemas.js';
import type { Mission } from './types.js';

export async function setMission(
  db: Kysely<Database>,
  workspaceId: string,
  input: SetMissionInput,
  actor: OperatorActor,
): Promise<Mission> {
  const operator = validateOperatorActor(actor);
  const parsed = setMissionSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    // Serialize first-time creation too, so concurrent setters preserve audit order.
    const workspace = await trx
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .where('archived_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!workspace) {
      throw new ApplicationError('NOT_FOUND', 'Workspace not found');
    }
    const before = await trx
      .selectFrom('missions')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    const mission = await trx
      .insertInto('missions')
      .values({
        id: randomUUID(),
        workspace_id: workspaceId,
        statement: parsed.statement,
      })
      .onConflict((conflict) =>
        conflict.column('workspace_id').doUpdateSet({
          statement: parsed.statement,
          updated_at: sql<Date>`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: before ? 'MISSION_UPDATED' : 'MISSION_CREATED',
        payload: { ...operator, before: before ?? null, data: mission },
      })
      .execute();
    return mission;
  });
}

export async function showMission(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<Mission> {
  await showWorkspace(db, workspaceId);
  const mission = await db
    .selectFrom('missions')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!mission) {
    throw new ApplicationError('NOT_FOUND', 'Mission not set in workspace');
  }
  return mission;
}
