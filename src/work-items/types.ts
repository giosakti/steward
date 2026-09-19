import type { Generated, JSONColumnType, Selectable } from 'kysely';
import type { z } from 'zod';
import type { OperatorActor } from '../audit/actor.js';
import type { workItemStatusSchema } from './schemas.js';

export type WorkItem = Selectable<WorkItemTable>;
export type WorkItemRelationship = Selectable<WorkItemRelationshipTable>;
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

export interface WorkItemTable {
  id: string;
  workspace_id: string;
  goal_id: string;
  title: string;
  objective: string;
  acceptance_criteria: JSONColumnType<string[]>;
  status: WorkItemStatus;
  priority: number;
  created_by: JSONColumnType<OperatorActor>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WorkItemRelationshipTable {
  id: string;
  workspace_id: string;
  source_id: string;
  target_id: string;
  type: 'blocks' | 'relates_to';
  created_by: JSONColumnType<OperatorActor>;
  created_at: Generated<Date>;
}
