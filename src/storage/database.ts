import {
  Kysely,
  PostgresDialect,
  type Generated,
  type GeneratedAlways,
} from 'kysely';
import pg from 'pg';

import type { ActionIntentTable, DecisionTable } from '../decisions/types.js';
import type { GoalTable, GoalRelationshipTable } from '../goals/types.js';
import type {
  WorkItemTable,
  WorkItemRelationshipTable,
} from '../work-items/types.js';
import type { AgentTable, WorkspaceTable } from '../workspaces/types.js';

export function connectDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 }),
    }),
  });
}

// These types mirror the SQL migrations; PostgreSQL remains the schema authority.
export interface Database {
  goal_relationships: GoalRelationshipTable;
  work_item_relationships: WorkItemRelationshipTable;
  goals: GoalTable;
  work_items: WorkItemTable;
  action_intents: ActionIntentTable;
  decisions: DecisionTable;
  workspaces: WorkspaceTable;
  agents: AgentTable;
  events: {
    id: GeneratedAlways<string>;
    workspace_id: string | null;
    type: string;
    created_at: Generated<Date>;
    payload: Record<string, unknown>;
  };
}
