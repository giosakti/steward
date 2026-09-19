import type { Generated, Selectable } from 'kysely';

export interface WorkspaceTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mission_statement: Generated<string | null>;
  root_path: string | null;
  root_agent_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: Generated<Date | null>;
}

export interface AgentTable {
  id: string;
  workspace_id: string;
  name: string;
  title: string;
  role_description: Generated<string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type Workspace = Selectable<WorkspaceTable>;
export type Agent = Selectable<AgentTable>;

export interface WorkspaceMission {
  workspace_id: string;
  statement: string;
}
