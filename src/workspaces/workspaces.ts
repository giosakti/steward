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

export type WorkspaceReference = string | { id: string };

async function resolveWorkspace(
  db: Kysely<Database>,
  reference?: WorkspaceReference,
): Promise<Workspace> {
  const query = db
    .selectFrom('workspaces as w')
    .selectAll('w')
    .where('w.archived_at', 'is', null);
  let scopedQuery;
  if (reference === undefined) {
    scopedQuery = query
      .innerJoin('workspace_selection as s', 'w.id', 's.workspace_id')
      .where('s.singleton', '=', true);
  } else if (typeof reference === 'string') {
    scopedQuery = query.where('w.slug', '=', reference);
  } else {
    scopedQuery = query.where('w.id', '=', reference.id);
  }

  const workspace = await scopedQuery.executeTakeFirst();
  if (!workspace) {
    const message =
      reference === undefined
        ? 'No workspace selected; use workspace use <slug> or --workspace <slug>'
        : `Workspace not found: ${typeof reference === 'string' ? reference : reference.id}`;
    throw new ApplicationError('NOT_FOUND', message);
  }
  return workspace;
}

export async function showWorkspace(
  db: Kysely<Database>,
  reference?: WorkspaceReference,
): Promise<Workspace> {
  return resolveWorkspace(db, reference);
}

export async function useWorkspace(
  db: Kysely<Database>,
  slug: string,
  context: OperatorContext,
): Promise<Workspace> {
  const operator = requireOperator(context);
  return db.transaction().execute(async (trx) => {
    const workspace = await resolveWorkspace(trx, slug);
    await trx
      .insertInto('workspace_selection')
      .values({ singleton: true, workspace_id: workspace.id })
      .onConflict((oc) =>
        oc.column('singleton').doUpdateSet({ workspace_id: workspace.id }),
      )
      .execute();
    await record(
      trx,
      workspace.id,
      'WORKSPACE_SELECTED',
      {
        workspaceId: workspace.id,
      },
      operator,
    );
    return workspace;
  });
}

export async function showAgent(
  db: Kysely<Database>,
  reference?: WorkspaceReference,
): Promise<Agent> {
  const workspace = await resolveWorkspace(db, reference);
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
  reference: WorkspaceReference | undefined,
  context: OperatorContext,
): Promise<Agent> {
  const operator = requireOperator(context);
  const parsed = configureAgentSchema.parse(input);

  return db.transaction().execute(async (trx) => {
    const workspace = await resolveWorkspace(trx, reference);
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
