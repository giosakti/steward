import { sql, type Kysely } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import { setMissionSchema, type SetMissionInput } from './schemas.js';
import type { WorkspaceMission } from './types.js';
import { showWorkspace } from './workspaces.js';

export async function setMission(
  db: Kysely<Database>,
  workspaceId: string,
  input: SetMissionInput,
  actor: OperatorActor,
): Promise<WorkspaceMission> {
  const operator = validateOperatorActor(actor);
  const parsed = setMissionSchema.parse(input);
  return db.transaction().execute(async (trx) => {
    // Lock before reading so concurrent updates preserve the actual prior statement.
    const workspace = await trx
      .selectFrom('workspaces')
      .select(['id', 'mission_statement'])
      .where('id', '=', workspaceId)
      .where('archived_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!workspace) {
      throw new ApplicationError('NOT_FOUND', 'Workspace not found');
    }
    const updated = await trx
      .updateTable('workspaces')
      .set({
        mission_statement: parsed.statement,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', workspaceId)
      .returning(['id', 'mission_statement'])
      .executeTakeFirstOrThrow();
    const mission = {
      workspace_id: updated.id,
      statement: updated.mission_statement!,
    };
    const before =
      workspace.mission_statement === null
        ? null
        : {
            workspace_id: workspace.id,
            statement: workspace.mission_statement,
          };
    await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        type: before === null ? 'MISSION_CREATED' : 'MISSION_UPDATED',
        payload: { ...operator, before, data: mission },
      })
      .execute();
    return mission;
  });
}

export async function showMission(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<WorkspaceMission> {
  const workspace = await showWorkspace(db, workspaceId);
  if (workspace.mission_statement === null) {
    throw new ApplicationError('NOT_FOUND', 'Mission not set in workspace');
  }
  return { workspace_id: workspace.id, statement: workspace.mission_statement };
}
