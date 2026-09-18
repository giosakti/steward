import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';

import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import type { DecisionContext } from './types.js';

// One SQL statement gives a consistent workspace/agent snapshot.
// Lock only during the final short transaction, never while waiting for Jev.
export async function resolveContext(
  db: Kysely<Database>,
  workspaceId: string,
  lock = false,
): Promise<DecisionContext> {
  const query = db
    .selectFrom('workspaces as w')
    .innerJoin('agents as a', (join) =>
      join
        .onRef('a.id', '=', 'w.root_agent_id')
        .onRef('a.workspace_id', '=', 'w.id'),
    )
    .select([
      'w.id',
      'w.name',
      'w.description',
      'w.root_agent_id',
      'w.updated_at',
      'w.archived_at',
      'a.name as agent_name',
      'a.title',
      'a.role_description',
      'a.updated_at as agent_updated_at',
    ])
    .where('w.id', '=', workspaceId);
  const row = await (
    lock ? query.forUpdate(['w', 'a']) : query
  ).executeTakeFirst();
  if (!row) {
    throw new ApplicationError(
      'NOT_FOUND',
      'Workspace or root agent not found',
    );
  }
  return {
    workspace: {
      id: row.id,
      name: row.name,
      description: row.description,
      rootAgentId: row.root_agent_id,
      updatedAt: row.updated_at.toISOString(),
      archivedAt: row.archived_at?.toISOString() ?? null,
    },
    agent: {
      id: row.root_agent_id,
      name: row.agent_name,
      title: row.title,
      roleDescription: row.role_description,
      updatedAt: row.agent_updated_at.toISOString(),
    },
    provenance: {
      workspace: `postgres:workspaces/${row.id}`,
      agent: `postgres:agents/${row.root_agent_id}`,
    },
  };
}

export function fingerprint(context: DecisionContext): string {
  // Explicit field order is stable after PostgreSQL JSONB reorders object keys.
  const { workspace, agent } = context;
  const facts = [
    workspace.id,
    workspace.name,
    workspace.description,
    workspace.rootAgentId,
    workspace.updatedAt,
    workspace.archivedAt,
    agent.id,
    agent.name,
    agent.title,
    agent.roleDescription,
    agent.updatedAt,
  ];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}
