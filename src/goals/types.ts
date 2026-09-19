import type { Generated, Selectable } from 'kysely';
import type { z } from 'zod';

import type { goalStatusSchema } from './schemas.js';

export type Goal = Selectable<GoalTable>;
export type GoalRelationship = Selectable<GoalRelationshipTable>;
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export interface GoalTable {
  id: string;
  workspace_id: string;
  title: string;
  objective: string;
  status: GoalStatus;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GoalRelationshipTable {
  id: string;
  workspace_id: string;
  source_id: string;
  target_id: string;
  type: 'contributes_to' | 'relates_to';
  created_at: Generated<Date>;
}
