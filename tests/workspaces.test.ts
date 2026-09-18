import type { OperatorActor } from '../src/audit/actor.js';
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
  showWorkspace,
} from '../src/workspaces/workspaces.js';
import type { CreateWorkspaceInput } from '../src/workspaces/schemas.js';

const operator: OperatorActor = {
  actor: 'operator',
  source: 'workspace-http',
};

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

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

describe('workspace constraints', () => {
  it('rejects duplicate slugs without creating extra agents or events', async () => {
    await setup(async (pool, _url, db) => {
      await createWorkspace(db, { slug: 'first', name: 'First' }, operator);
      await expect(
        createWorkspace(db, { slug: 'first', name: 'Duplicate' }, operator),
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
      const workspace = await createWorkspace(
        db,
        {
          slug: 'first',
          name: 'First',
        },
        operator,
      );
      await expect(
        pool.query(sql, [randomUUID(), workspace.id]),
      ).rejects.toThrow(error);
    });
  });

  it('rejects assigning another workspace’s agent as root', async () => {
    await setup(async (pool, _url, db) => {
      const first = await createWorkspace(
        db,
        { slug: 'first', name: 'First' },
        operator,
      );
      const second = await createWorkspace(
        db,
        {
          slug: 'second',
          name: 'Second',
        },
        operator,
      );
      await expect(
        pool.query('UPDATE workspaces SET root_agent_id=$2 WHERE id=$1', [
          first.id,
          second.root_agent_id,
        ]),
      ).rejects.toThrow(/foreign key/);
      expect((await showWorkspace(db, first.id)).root_agent_id).toBe(
        first.root_agent_id,
      );
    });
  });

  it('rejects deleting a workspace’s root agent', async () => {
    await setup(async (pool, _url, db) => {
      const workspace = await createWorkspace(
        db,
        {
          slug: 'first',
          name: 'First',
        },
        operator,
      );
      await expect(
        pool.query('DELETE FROM agents WHERE id=$1', [workspace.root_agent_id]),
      ).rejects.toThrow(/foreign key/);
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
        await expect(createWorkspace(db, input, operator)).rejects.toThrow(
          error,
        );
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
      const workspace = await createWorkspace(
        db,
        { slug: 'valid', name: 'Valid' },
        operator,
      );
      await configureAgent(
        db,
        { name: '  Builder  ', roleDescription: 'Original' },
        workspace.id,
        operator,
      );
      const cleared = await configureAgent(
        db,
        { roleDescription: '' },
        workspace.id,
        operator,
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
      const workspace = await createWorkspace(
        db,
        { slug: 'valid', name: 'Valid' },
        operator,
      );
      const before = await showAgent(db, workspace.id);
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_configuration CHECK (type <> 'AGENT_CONFIGURED')",
      );
      await expect(
        configureAgent(db, { title: 'Changed' }, workspace.id, operator),
      ).rejects.toThrow(/reject_configuration/);
      expect(await showAgent(db, workspace.id)).toEqual(before);
      expect((await pool.query('SELECT * FROM events')).rows).toHaveLength(2);
    });
  });

  it('rolls back workspace, agent, and prior event when the agent event fails', async () => {
    await setup(async (pool, _url, db) => {
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_creation CHECK (type <> 'AGENT_CREATED')",
      );
      await expect(
        createWorkspace(db, { slug: 'failed', name: 'Failed' }, operator),
      ).rejects.toThrow(/reject_creation/);
      expect((await pool.query('SELECT * FROM workspaces')).rows).toHaveLength(
        0,
      );
      expect((await pool.query('SELECT * FROM agents')).rows).toHaveLength(0);
      expect((await pool.query('SELECT * FROM events')).rows).toHaveLength(0);
    });
  });
});
