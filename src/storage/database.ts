import {Kysely, PostgresDialect, type Generated, type GeneratedAlways} from 'kysely';
import pg from 'pg';
import type {AgentTable, WorkspaceTable} from '../workspaces/workspaces.js';

// These types mirror the SQL migrations; PostgreSQL remains the schema authority.
export interface Database {
  workspaces: WorkspaceTable;
  agents: AgentTable;
  workspace_selection: {singleton: Generated<boolean>; workspace_id: string};
  events: {
    id: GeneratedAlways<string>;
    workspace_id: string | null;
    type: string;
    created_at: Generated<Date>;
    payload: Record<string, unknown>;
  };
}

export function connectDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({pool: new pg.Pool({connectionString, connectionTimeoutMillis: 5000})}),
  });
}
