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
  type Workspace,
  type Agent,
} from '../src/workspaces/workspaces.js';
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

describe('workspaces', () => {
  it('workspaces persist across CLI processes and explicit overrides do not change selection', async () => {
    await setup(async (pool, url) => {
      const cli = fileURLToPath(
        new URL('../dist/src/cli/main.js', import.meta.url),
      );
      const command = async (args: string[]) =>
        (
          await exec(process.execPath, [cli, ...args], {
            env: { ...process.env, DATABASE_URL: url },
          })
        ).stdout;
      const first = JSON.parse(
        await command(['workspace', 'create', 'first', 'First']),
      ) as Workspace;
      const second = JSON.parse(
        await command([
          'workspace',
          'create',
          'second',
          'Second',
          '--root-path',
          root,
        ]),
      ) as Workspace;
      expect(first.root_agent_id).not.toBe(second.root_agent_id);
      expect(first.root_path).toBe(null);
      expect(second.root_path).toBe(root.replace(/\/$/, ''));
      await expect(command(['agent', 'show'])).rejects.toThrow(
        /No workspace selected/,
      );
      await command(['workspace', 'use', 'first']);
      const original = JSON.parse(await command(['agent', 'show'])) as Agent;
      expect(original.name).toBe('Steward');
      expect(original.title).toBe('Steward');
      await expect(command(['agent', 'configure'])).rejects.toThrow(
        /Provide --name, --title, or --role-description/,
      );
      await expect(
        command(['agent', 'configure', '--title', ' ']),
      ).rejects.toThrow(/Agent title must not be blank/);
      await command([
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
      expect(JSON.parse(await command(['agent', 'show']))).toEqual(original);
      const changed = JSON.parse(
        await command(['--workspace', 'second', 'agent', 'show']),
      ) as Agent;
      expect(changed.id).toBe(second.root_agent_id);
      expect(changed.title).toBe('Engineer');
      expect(changed.role_description).toBe('Review small changes');
      await command(['workspace', 'use', 'second']);
      expect(
        (JSON.parse(await command(['workspace', 'show'])) as Workspace).id,
      ).toBe(second.id);
      expect(
        (JSON.parse(await command(['workspace', 'list'])) as Workspace[])
          .length,
      ).toBe(2);
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

  it('workspace/root-agent constraints prevent duplicates, missing roots, and cross-workspace roots', async () => {
    await setup(async (pool, _url, db) => {
      const first = await createWorkspace(db, { slug: 'first', name: 'First' });
      const second = await createWorkspace(db, {
        slug: 'second',
        name: 'Second',
      });
      await expect(
        createWorkspace(db, { slug: 'first', name: 'Duplicate' }),
      ).rejects.toThrow(/unique/);
      await expect(
        pool.query(
          "INSERT INTO agents(id,workspace_id,name,title) VALUES ($1,$2,'Extra','Extra')",
          [randomUUID(), first.id],
        ),
      ).rejects.toThrow(/unique/);
      await expect(
        pool.query('UPDATE workspaces SET root_agent_id=$2 WHERE id=$1', [
          first.id,
          second.root_agent_id,
        ]),
      ).rejects.toThrow(/foreign key/);
      await expect(
        pool.query('DELETE FROM agents WHERE id=$1', [first.root_agent_id]),
      ).rejects.toThrow(/foreign key/);
      await expect(
        pool.query(
          "INSERT INTO workspaces(id,slug,name,root_agent_id) VALUES ($1,'orphan','Orphan',$2)",
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow(/foreign key/);
      expect(
        (await pool.query<{ count: string }>('SELECT count(*) FROM workspaces'))
          .rows[0]?.count,
      ).toBe('2');
      expect(
        (await pool.query<{ count: string }>('SELECT count(*) FROM agents'))
          .rows[0]?.count,
      ).toBe('2');
      expect(
        (await pool.query<{ count: string }>('SELECT count(*) FROM events'))
          .rows[0]?.count,
      ).toBe('4');
      await useWorkspace(db, 'first');
      await expect(useWorkspace(db, 'missing')).rejects.toThrow(/not found/);
      expect((await showWorkspace(db)).id).toBe(first.id);
    });
  });

  it('invalid input and audit failures leave workspace and agent state unchanged', async () => {
    await setup(async (pool, _url, db) => {
      await expect(
        createWorkspace(db, { slug: 'Invalid Slug', name: 'Invalid' }),
      ).rejects.toThrow(/slug/);
      await expect(
        createWorkspace(db, { slug: 'blank', name: ' ' }),
      ).rejects.toThrow(/blank/);
      await expect(
        createWorkspace(db, {
          slug: 'missing',
          name: 'Missing',
          rootPath: `/tmp/${randomUUID()}`,
        }),
      ).rejects.toThrow(/ENOENT/);
      // Runtime callers can violate TypeScript declarations; validation must reject them.
      await expect(
        createWorkspace(db, {
          slug: 'wrong-type',
          // @ts-expect-error Deliberately exercise malformed external input.
          name: 42,
        }),
      ).rejects.toThrow();
      await expect(
        createWorkspace(db, {
          slug: 'extra',
          name: 'Extra',
          // @ts-expect-error Unknown fields must not be silently accepted.
          unexpected: true,
        }),
      ).rejects.toThrow();
      const workspace = await createWorkspace(db, {
        slug: 'valid',
        name: 'Valid',
      });
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
      const before = await showAgent(db, 'valid');
      await expect(configureAgent(db, { title: ' ' }, 'valid')).rejects.toThrow(
        /blank/,
      );
      // Simulate audit-storage failure; state and events must commit together.
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_configuration CHECK (type <> 'AGENT_CONFIGURED') NOT VALID",
      );
      await expect(
        configureAgent(db, { title: 'Changed' }, 'valid'),
      ).rejects.toThrow(/reject_configuration/);
      expect(await showAgent(db, 'valid')).toEqual(before);
      await pool.query(
        "ALTER TABLE events ADD CONSTRAINT reject_creation CHECK (type <> 'WORKSPACE_CREATED') NOT VALID",
      );
      await expect(
        createWorkspace(db, { slug: 'failed', name: 'Failed' }),
      ).rejects.toThrow(/reject_creation/);
      expect(
        (await pool.query<{ id: string }>('SELECT id FROM workspaces')).rows[0]
          ?.id,
      ).toBe(workspace.id);
      expect(
        (await pool.query<{ count: string }>('SELECT count(*) FROM agents'))
          .rows[0]?.count,
      ).toBe('1');
    });
  });
});
