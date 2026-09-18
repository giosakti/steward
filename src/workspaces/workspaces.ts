import {randomUUID} from 'node:crypto';
import {realpath, stat} from 'node:fs/promises';
import type pg from 'pg';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  root_path: string | null;
  root_agent_id: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}
export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  title: string;
  role_description: string | null;
  created_at: Date;
  updated_at: Date;
}

async function transaction<T>(pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
  return value;
}

async function record(db: pg.PoolClient, workspace: string, type: string, data: unknown) {
  await db.query('INSERT INTO events(workspace_id, type, payload) VALUES ($1, $2, $3)',
    [workspace, type, JSON.stringify({actor: 'operator', source: 'workspace-cli', data})]);
}

// These are explicit local operator commands, not autonomous agent capabilities.
export async function createWorkspace(pool: pg.Pool, input: {
  slug: string; name: string; description?: string; rootPath?: string;
}): Promise<Workspace> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) throw new Error('Use a lowercase slug with letters, numbers, and single hyphens');
  required(input.name, 'Workspace name');
  let root: string | null = null;
  if (input.rootPath !== undefined) {
    root = await realpath(required(input.rootPath, 'Root path'));
    if (!(await stat(root)).isDirectory()) throw new Error('Root path must be a directory');
  }
  return transaction(pool, async db => {
    const id = randomUUID(), agentId = randomUUID();
    const workspace = (await db.query<Workspace>(`INSERT INTO workspaces
      (id, slug, name, description, root_path, root_agent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, input.slug, input.name, input.description ?? null, root, agentId])).rows[0]!;
    const agent = (await db.query<Agent>(`INSERT INTO agents(id, workspace_id, name, title)
      VALUES ($1,$2,'Steward','Steward') RETURNING *`, [agentId, id])).rows[0]!;
    await record(db, id, 'WORKSPACE_CREATED', workspace);
    await record(db, id, 'AGENT_CREATED', agent);
    return workspace;
  });
}

export async function listWorkspaces(pool: pg.Pool): Promise<Workspace[]> {
  return (await pool.query<Workspace>('SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY slug')).rows;
}

async function resolveWorkspace(db: pg.Pool | pg.PoolClient, slug?: string): Promise<Workspace> {
  const result = slug !== undefined
    ? await db.query<Workspace>('SELECT * FROM workspaces WHERE slug=$1 AND archived_at IS NULL', [slug])
    : await db.query<Workspace>(`SELECT w.* FROM workspace_selection s JOIN workspaces w ON w.id=s.workspace_id
        WHERE s.singleton=true AND w.archived_at IS NULL`);
  const workspace = result.rows[0];
  if (!workspace) throw new Error(slug === undefined ? 'No workspace selected; use workspace use <slug> or --workspace <slug>' : `Workspace not found: ${slug}`);
  return workspace;
}

export async function showWorkspace(pool: pg.Pool, slug?: string): Promise<Workspace> {
  return resolveWorkspace(pool, slug);
}

export async function useWorkspace(pool: pg.Pool, slug: string): Promise<Workspace> {
  return transaction(pool, async db => {
    const workspace = await resolveWorkspace(db, slug);
    await db.query(`INSERT INTO workspace_selection(singleton, workspace_id) VALUES (true,$1)
      ON CONFLICT (singleton) DO UPDATE SET workspace_id=excluded.workspace_id`, [workspace.id]);
    await record(db, workspace.id, 'WORKSPACE_SELECTED', {workspaceId: workspace.id});
    return workspace;
  });
}

export async function showAgent(pool: pg.Pool, slug?: string): Promise<Agent> {
  const workspace = await resolveWorkspace(pool, slug);
  return (await pool.query<Agent>('SELECT * FROM agents WHERE workspace_id=$1 AND id=$2',
    [workspace.id, workspace.root_agent_id])).rows[0]!;
}

export async function configureAgent(pool: pg.Pool, input: {
  name?: string; title?: string; roleDescription?: string;
}, slug?: string): Promise<Agent> {
  if (input.name === undefined && input.title === undefined && input.roleDescription === undefined) throw new Error('Provide --name, --title, or --role-description');
  if (input.name !== undefined) required(input.name, 'Agent name');
  if (input.title !== undefined) required(input.title, 'Agent title');
  return transaction(pool, async db => {
    const workspace = await resolveWorkspace(db, slug);
    const agent = (await db.query<Agent>(`UPDATE agents SET name=coalesce($3,name), title=coalesce($4,title),
      role_description=coalesce($5,role_description), updated_at=now()
      WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspace.id, workspace.root_agent_id, input.name ?? null, input.title ?? null, input.roleDescription ?? null])).rows[0]!;
    await record(db, workspace.id, 'AGENT_CONFIGURED', agent);
    return agent;
  });
}
