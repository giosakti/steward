import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { connectDatabase, type Database } from '../src/storage/database.js';
import { isolated } from './database.js';
import {
  createWorkspace,
  showAgent,
  configureAgent,
  useWorkspace,
  showWorkspace,
} from '../src/workspaces/workspaces.js';
import type { Workspace, Agent } from '../src/workspaces/types.js';
import type { CreateWorkspaceInput } from '../src/workspaces/schemas.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

async function setup(
  fn: (pool: pg.Pool, url: string, db: Kysely<Database>) => Promise<void>,
) {
  await isolated(async (url, _client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    const pool = new pg.Pool({ connectionString: url });
    const db = connectDatabase(url);
    try {
      await fn(pool, url, db);
    } finally {
      await db.destroy();
      await pool.end();
    }
  });
}

async function command(url: string, args: string[]) {
  const result = await exec(process.execPath, [cli, ...args], {
    env: { ...process.env, DATABASE_URL: url },
  });
  return result.stdout;
}

describe('workspace CLI', () => {
  it('creates and lists workspaces across processes with optional root paths', async () => {
    await setup(async (_pool, url) => {
      const first = JSON.parse(
        await command(url, ['workspace', 'create', 'first', 'First']),
      ) as Workspace;
      const second = JSON.parse(
        await command(url, [
          'workspace',
          'create',
          'second',
          'Second',
          '--root-path',
          root,
        ]),
      ) as Workspace;
      expect(first.root_agent_id).not.toBe(second.root_agent_id);
      expect(first.root_path).toBeNull();
      expect(second.root_path).toBe(root.replace(/\/$/, ''));
      expect(
        JSON.parse(await command(url, ['workspace', 'list'])),
      ).toHaveLength(2);
      const agent = JSON.parse(
        await command(url, ['--workspace', 'first', 'agent', 'show']),
      ) as Agent;
      expect(agent.name).toBe('Steward');
      expect(agent.title).toBe('Steward');
    });
  });

  it('persists selection and scopes explicit overrides without changing the selection', async () => {
    await setup(async (pool, url, db) => {
      await createWorkspace(db, { slug: 'first', name: 'First' });
      const second = await createWorkspace(db, {
        slug: 'second',
        name: 'Second',
      });
      await command(url, ['workspace', 'use', 'first']);
      const original = JSON.parse(
        await command(url, ['agent', 'show']),
      ) as Agent;
      await command(url, [
        '--workspace',
        'second',
        'agent',
        'configure',
        '--name',
        'Builder',
        '--title',
        'Engineer',
        '--role-description',
        'Review small changes',
      ]);
      expect(JSON.parse(await command(url, ['agent', 'show']))).toEqual(
        original,
      );
      const changed = JSON.parse(
        await command(url, ['--workspace', 'second', 'agent', 'show']),
      ) as Agent;
      expect(changed.id).toBe(second.root_agent_id);
      expect(changed.title).toBe('Engineer');
      expect(changed.role_description).toBe('Review small changes');
      await command(url, ['workspace', 'use', 'second']);
      expect(
        (JSON.parse(await command(url, ['workspace', 'show'])) as Workspace).id,
      ).toBe(second.id);
      const audit = await pool.query<{
        workspace_id: string;
        payload: { actor: string; data: Agent };
      }>(
        "SELECT workspace_id,payload FROM events WHERE type='AGENT_CONFIGURED'",
      );
      expect(audit.rows[0]?.workspace_id).toBe(second.id);
      expect(audit.rows[0]?.payload.actor).toBe('operator');
      expect(audit.rows[0]?.payload.data.title).toBe('Engineer');
    });
  });

  it('explains missing selection and invalid agent configuration', async () => {
    await setup(async (_pool, url, db) => {
      await expect(command(url, ['agent', 'show'])).rejects.toThrow(
        /No workspace selected/,
      );
      await createWorkspace(db, { slug: 'first', name: 'First' });
      await useWorkspace(db, 'first');
      await expect(command(url, ['agent', 'configure'])).rejects.toThrow(
        /Provide --name, --title, or --role-description/,
      );
      await expect(
        command(url, ['agent', 'configure', '--title', ' ']),
      ).rejects.toThrow(/Agent title must not be blank/);
    });
  });
});

describe('workspace constraints', () => {
  it('rejects duplicate slugs without creating extra agents or events', async () => {
    await setup(async (pool, _url, db) => {
      await createWorkspace(db, { slug: 'first', name: 'First' });
      await expect(
        createWorkspace(db, { slug: 'first', name: 'Duplicate' }),
      ).rejects.toThrow(/unique/);
      expect((await pool.query('SELECT * FROM workspaces')).rows).toHaveLength(
        1,
      );
      expect((await pool.query('SELECT * FROM agents')).rows).toHaveLength(1);
      expect((await pool.query('SELECT * FROM events')).rows).toHaveLength(2);
    });
  });

  it.each([
    {
      name: 'a second agent in a workspace',
      sql: "INSERT INTO agents(id,workspace_id,name,title) VALUES ($1,$2,'Extra','Extra')",
      error: /unique/,
    },
    {
      name: 'a workspace without a root agent',
      sql: "INSERT INTO workspaces(id,slug,name,root_agent_id) VALUES ($1,'orphan','Orphan',$2)",
      error: /foreign key/,
    },
  ])('rejects $name', async ({ sql, error }) => {
    await setup(async (pool, _url, db) => {
      const workspace = await createWorkspace(db, {
        slug: 'first',
        name: 'First',
      });
      await expect(
        pool.query(sql, [randomUUID(), workspace.id]),
      ).rejects.toThrow(error);
    });
  });

  it('rejects assigning another workspace’s agent as root', async () => {
    await setup(async (pool, _url, db) => {
      const first = await createWorkspace(db, { slug: 'first', name: 'First' });
      const second = await createWorkspace(db, {
        slug: 'second',
        name: 'Second',
      });
      await expect(
        pool.query('UPDATE workspaces SET root_agent_id=$2 WHERE id=$1', [
          first.id,
          second.root_agent_id,
        ]),
      ).rejects.toThrow(/foreign key/);
      expect((await showWorkspace(db, 'first')).root_agent_id).toBe(
        first.root_agent_id,
      );
    });
  });

  it('rejects deleting a workspace’s root agent', async () => {
    await setup(async (pool, _url, db) => {
      const workspace = await createWorkspace(db, {
        slug: 'first',
        name: 'First',
      });
      await expect(
        pool.query('DELETE FROM agents WHERE id=$1', [workspace.root_agent_id]),
      ).rejects.toThrow(/foreign key/);
    });
  });

  it('preserves selection when the requested workspace does not exist', async () => {
    await setup(async (_pool, _url, db) => {
      const workspace = await createWorkspace(db, {
        slug: 'first',
        name: 'First',
      });
      await useWorkspace(db, 'first');
      await expect(useWorkspace(db, 'missing')).rejects.toThrow(/not found/);
      expect((await showWorkspace(db)).id).toBe(workspace.id);
    });
  });
});

describe('workspace inputs', () => {
  const invalid: {
    name: string;
    input: CreateWorkspaceInput;
    error: RegExp;
  }[] = [
    {
      name: 'invalid slug',
      input: { slug: 'Invalid Slug', name: 'Invalid' },
      error: /slug/,
    },
    { name: 'blank name', input: { slug: 'blank', name: ' ' }, error: /blank/ },
    {
      name: 'missing root directory',
      input: {
        slug: 'missing',
        name: 'Missing',
        rootPath: `/tmp/${randomUUID()}`,
      },
      error: /ENOENT/,
    },
    {
      name: 'a file as root directory',
      input: {
        slug: 'file',
        name: 'File',
        rootPath: fileURLToPath(new URL('../package.json', import.meta.url)),
      },
      error: /directory/,
    },
    {
      name: 'wrong field type',
      input: {
        slug: 'wrong-type',
        // @ts-expect-error Deliberately exercise malformed external input.
        name: 42,
      },
      error: /string/,
    },
    {
      name: 'unknown field',
      input: {
        slug: 'extra',
        name: 'Extra',
        // @ts-expect-error Unknown fields must not be silently accepted.
        unexpected: true,
      },
      error: /unexpected/,
    },
  ];

  it.each(invalid)(
    'rejects $name before writing state',
    async ({ input, error }) => {
      await setup(async (pool, _url, db) => {
        await expect(createWorkspace(db, input)).rejects.toThrow(error);
        expect(
          (await pool.query('SELECT * FROM workspaces')).rows,
        ).toHaveLength(0);
        expect((await pool.query('SELECT * FROM agents')).rows).toHaveLength(0);
        expect((await pool.query('SELECT * FROM events')).rows).toHaveLength(0);
      });
    },
  );

  it('updates only supplied agent fields and permits clearing the role description', async () => {
    await setup(async (_pool, _url, db) => {
      await createWorkspace(db, { slug: 'valid', name: 'Valid' });
      await configureAgent(
        db,
        { name: '  Builder  ', roleDescription: 'Original' },
        'valid',
      );
      const cleared = await configureAgent(
        db,
        { roleDescription: '' },
        'valid',
      );
      expect(cleared.name).toBe('  Builder  ');
      expect(cleared.title).toBe('Steward');
      expect(cleared.role_description).toBe('');
    });
  });
});

describe('atomic audit recording', () => {
  it('rolls back agent configuration when its event cannot be recorded', async () => {
    await setup(async (pool, _url, db) => {
      await createWorkspace(db, { slug: 'valid', name: 'Valid' });
      const before = await showAgent(db, 'valid');
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_configuration CHECK (type <> 'AGENT_CONFIGURED')",
      );
      await expect(
        configureAgent(db, { title: 'Changed' }, 'valid'),
      ).rejects.toThrow(/reject_configuration/);
      expect(await showAgent(db, 'valid')).toEqual(before);
      expect((await pool.query('SELECT * FROM events')).rows).toHaveLength(2);
    });
  });

  it('rolls back workspace, agent, and prior event when the agent event fails', async () => {
    await setup(async (pool, _url, db) => {
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_creation CHECK (type <> 'AGENT_CREATED')",
      );
      await expect(
        createWorkspace(db, { slug: 'failed', name: 'Failed' }),
      ).rejects.toThrow(/reject_creation/);
      expect((await pool.query('SELECT * FROM workspaces')).rows).toHaveLength(
        0,
      );
      expect((await pool.query('SELECT * FROM agents')).rows).toHaveLength(0);
      expect((await pool.query('SELECT * FROM events')).rows).toHaveLength(0);
    });
  });

  it('rolls back selection when its event cannot be recorded', async () => {
    await setup(async (pool, _url, db) => {
      const first = await createWorkspace(db, { slug: 'first', name: 'First' });
      await createWorkspace(db, { slug: 'second', name: 'Second' });
      await useWorkspace(db, 'first');
      const before = (await pool.query('SELECT * FROM events ORDER BY id'))
        .rows;
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_selection CHECK (type <> 'WORKSPACE_SELECTED') NOT VALID",
      );
      await expect(useWorkspace(db, 'second')).rejects.toThrow(
        /reject_selection/,
      );
      expect((await showWorkspace(db)).id).toBe(first.id);
      expect(
        (await pool.query('SELECT * FROM events ORDER BY id')).rows,
      ).toEqual(before);
    });
  });
});
