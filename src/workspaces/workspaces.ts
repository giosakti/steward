import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import {
  sql,
  type Generated,
  type Kysely,
  type Selectable,
  type Transaction,
} from 'kysely';
import { z } from 'zod';
import type { Database } from '../storage/database.js';

export interface WorkspaceTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
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

const nonblank = (label: string) =>
  z
    .string()
    .refine((value) => value.trim().length > 0, `${label} must not be blank`);

const createWorkspaceSchema = z.strictObject({
  slug: z
    .string()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Use a lowercase slug with letters, numbers, and single hyphens',
    ),
  name: nonblank('Workspace name'),
  description: z.string().optional(),
  rootPath: nonblank('Root path').optional(),
});

const configureAgentSchema = z
  .strictObject({
    name: nonblank('Agent name').optional(),
    title: nonblank('Agent title').optional(),
    roleDescription: z.string().optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Provide --name, --title, or --role-description',
  );

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type ConfigureAgentInput = z.infer<typeof configureAgentSchema>;

async function record(
  db: Transaction<Database>,
  workspace: string,
  type: string,
  data: unknown,
) {
  await db
    .insertInto('events')
    .values({
      workspace_id: workspace,
      type,
      payload: { actor: 'operator', source: 'workspace-cli', data },
    })
    .execute();
}

// These are explicit local operator commands, not autonomous agent capabilities.
export async function createWorkspace(
  db: Kysely<Database>,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const parsed = createWorkspaceSchema.parse(input);
  let root: string | null = null;
  if (parsed.rootPath !== undefined) {
    root = await realpath(parsed.rootPath);
    if (!(await stat(root)).isDirectory()) {
      throw new Error('Root path must be a directory');
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

    await record(trx, id, 'WORKSPACE_CREATED', workspace);
    await record(trx, id, 'AGENT_CREATED', agent);
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

async function resolveWorkspace(
  db: Kysely<Database>,
  slug?: string,
): Promise<Workspace> {
  const query = db
    .selectFrom('workspaces as w')
    .selectAll('w')
    .where('w.archived_at', 'is', null);
  const scopedQuery =
    slug !== undefined
      ? query.where('w.slug', '=', slug)
      : query
          .innerJoin('workspace_selection as s', 'w.id', 's.workspace_id')
          .where('s.singleton', '=', true);

  const workspace = await scopedQuery.executeTakeFirst();
  if (!workspace) {
    const message =
      slug === undefined
        ? 'No workspace selected; use workspace use <slug> or --workspace <slug>'
        : `Workspace not found: ${slug}`;
    throw new Error(message);
  }
  return workspace;
}

export async function showWorkspace(
  db: Kysely<Database>,
  slug?: string,
): Promise<Workspace> {
  return resolveWorkspace(db, slug);
}

export async function useWorkspace(
  db: Kysely<Database>,
  slug: string,
): Promise<Workspace> {
  return db.transaction().execute(async (trx) => {
    const workspace = await resolveWorkspace(trx, slug);
    await trx
      .insertInto('workspace_selection')
      .values({ singleton: true, workspace_id: workspace.id })
      .onConflict((oc) =>
        oc.column('singleton').doUpdateSet({ workspace_id: workspace.id }),
      )
      .execute();
    await record(trx, workspace.id, 'WORKSPACE_SELECTED', {
      workspaceId: workspace.id,
    });
    return workspace;
  });
}

export async function showAgent(
  db: Kysely<Database>,
  slug?: string,
): Promise<Agent> {
  const workspace = await resolveWorkspace(db, slug);
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
  slug?: string,
): Promise<Agent> {
  const parsed = configureAgentSchema.parse(input);

  return db.transaction().execute(async (trx) => {
    const workspace = await resolveWorkspace(trx, slug);
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
    await record(trx, workspace.id, 'AGENT_CONFIGURED', agent);
    return agent;
  });
}
