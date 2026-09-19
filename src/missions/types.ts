import type { Generated, Selectable } from 'kysely';

export type Mission = Selectable<MissionTable>;

export interface MissionTable {
  id: string;
  workspace_id: string;
  statement: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
