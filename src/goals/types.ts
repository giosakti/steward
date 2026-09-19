import type { Generated, Selectable } from 'kysely';
import type { z } from 'zod';
import type { goalStatusSchema } from './schemas.js';

export type Goal = Selectable<GoalTable>;
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export interface GoalTable {
  id: string;
  workspace_id: string;
  parent_goal_id: string | null;
  title: string;
  objective: string;
  status: GoalStatus;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
