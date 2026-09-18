import { requireOperator, type OperatorContext } from '../access/operator.js';
import { ApplicationError } from '../errors.js';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../storage/database.js';
import type { Workspace, Agent } from './types.js';
import {
  createWorkspaceSchema,
  configureAgentSchema,
  type CreateWorkspaceInput,
  type ConfigureAgentInput,
} from './schemas.js';

async function record(
  db: Transaction<Database>,
  workspace: string,
  type: string,
  data: unknown,
  operator: OperatorContext,
) {
  await db
    .insertInto('events')
    .values({
      workspace_id: workspace,
      type,
      payload: { ...operator, data },
    })
    .execute();
}

// These are explicit local operator commands, not autonomous agent capabilities.
export async function createWorkspace(
  db: Kysely<Database>,
  input: CreateWorkspaceInput,
  context: OperatorContext,
): Promise<Workspace> {
  const operator = requireOperator(context);
  const parsed = createWorkspaceSchema.parse(input);
  let root: string | null = null;
  if (parsed.rootPath !== undefined) {
    try {
      root = await realpath(parsed.rootPath);
      if (!(await stat(root)).isDirectory()) {
        throw new ApplicationError(
          'INVALID_INPUT',
          'Root path must be a directory',
        );
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' ||
          error.code === 'ENOTDIR' ||
          error.code === 'EACCES')
      ) {
        throw new ApplicationError(
          'INVALID_INPUT',
          `Root path must be an accessible directory (${String(error.code)})`,
        );
      }
      throw error;
    }
  }

  return db.transaction().execute(async (trx) => {
    const id = randomUUID();
    const agentId = randomUUID();
    const workspace = await trx
      .insertInto('workspaces')
      .values({
        id,
        slug: parsed.slug,
        name: parsed.name,
        description: parsed.description ?? null,
        root_path: root,
        root_agent_id: agentId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const agent = await trx
      .insertInto('agents')
      .values({
        id: agentId,
        workspace_id: id,
        name: 'Steward',
        title: 'Steward',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await record(trx, id, 'WORKSPACE_CREATED', workspace, operator);
    await record(trx, id, 'AGENT_CREATED', agent, operator);
    return workspace;
  });
}

export async function listWorkspaces(
  db: Kysely<Database>,
): Promise<Workspace[]> {
  return db
    .selectFrom('workspaces')
    .selectAll()
    .where('archived_at', 'is', null)
    .orderBy('slug')
    .execute();
}

export async function showWorkspace(
  db: Kysely<Database>,
  id: string,
): Promise<Workspace> {
  const workspace = await db
    .selectFrom('workspaces')
    .selectAll()
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!workspace) {
    throw new ApplicationError('NOT_FOUND', `Workspace not found: ${id}`);
  }
  return workspace;
}

export async function showAgent(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<Agent> {
  const workspace = await showWorkspace(db, workspaceId);
  return db
    .selectFrom('agents')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('id', '=', workspace.root_agent_id)
    .executeTakeFirstOrThrow();
}

export async function configureAgent(
  db: Kysely<Database>,
  input: ConfigureAgentInput,
  workspaceId: string,
  context: OperatorContext,
): Promise<Agent> {
  const operator = requireOperator(context);
  const parsed = configureAgentSchema.parse(input);

  return db.transaction().execute(async (trx) => {
    const workspace = await showWorkspace(trx, workspaceId);
    const agent = await trx
      .updateTable('agents')
      .set({
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.roleDescription !== undefined
          ? { role_description: parsed.roleDescription }
          : {}),
        updated_at: sql<Date>`now()`,
      })
      .where('workspace_id', '=', workspace.id)
      .where('id', '=', workspace.root_agent_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await record(trx, workspace.id, 'AGENT_CONFIGURED', agent, operator);
    return agent;
  });
}
