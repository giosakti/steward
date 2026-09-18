import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import pg from 'pg';
import { sql, type Kysely, type Transaction } from 'kysely';

import { validateOperatorActor, type OperatorActor } from '../audit/actor.js';
import { ApplicationError } from '../errors.js';
import type { Database } from '../storage/database.js';
import type { Workspace, Agent } from './types.js';
import {
  createWorkspaceSchema,
  configureAgentSchema,
  type CreateWorkspaceInput,
  type ConfigureAgentInput,
} from './schemas.js';

// These are explicit local operator commands, not autonomous agent capabilities.
export async function createWorkspace(
  db: Kysely<Database>,
  input: CreateWorkspaceInput,
  context: OperatorActor,
): Promise<Workspace> {
  const operator = validateOperatorActor(context);
  const parsed = createWorkspaceSchema.parse(input);
  const root = await resolveRootPath(parsed.rootPath);

  try {
    return await db.transaction().execute(async (trx) => {
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
  } catch (error) {
    if (
      error instanceof pg.DatabaseError &&
      error.code === '23505' &&
      error.constraint === 'workspaces_slug_key'
    ) {
      throw new ApplicationError('CONFLICT', 'Workspace slug already exists');
    }
    throw error;
  }
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
  context: OperatorActor,
): Promise<Agent> {
  const operator = validateOperatorActor(context);
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

async function resolveRootPath(
  path: string | undefined,
): Promise<string | null> {
  let root: string | null = null;
  if (path !== undefined) {
    try {
      root = await realpath(path);
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

  return root;
}

async function record(
  db: Transaction<Database>,
  workspace: string,
  type: string,
  data: unknown,
  operator: OperatorActor,
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
