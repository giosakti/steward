import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const root = fileURLToPath(new URL('../../', import.meta.url));

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

await test('workspaces persist across CLI processes and explicit overrides do not change selection', async () => {
  await setup(async (pool, url) => {
    const cli = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
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
    assert.notEqual(first.root_agent_id, second.root_agent_id);
    assert.equal(first.root_path, null);
    assert.equal(second.root_path, root.replace(/\/$/, ''));
    await assert.rejects(command(['agent', 'show']), /No workspace selected/);
    await command(['workspace', 'use', 'first']);
    const original = JSON.parse(await command(['agent', 'show'])) as Agent;
    assert.equal(original.name, 'Steward');
    assert.equal(original.title, 'Steward');
    await assert.rejects(
      command(['agent', 'configure']),
      /Provide --name, --title, or --role-description/,
    );
    await assert.rejects(
      command(['agent', 'configure', '--title', ' ']),
      /Agent title must not be blank/,
    );
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
    assert.deepEqual(JSON.parse(await command(['agent', 'show'])), original);
    const changed = JSON.parse(
      await command(['--workspace', 'second', 'agent', 'show']),
    ) as Agent;
    assert.equal(changed.id, second.root_agent_id);
    assert.equal(changed.title, 'Engineer');
    assert.equal(changed.role_description, 'Review small changes');
    await command(['workspace', 'use', 'second']);
    assert.equal(
      (JSON.parse(await command(['workspace', 'show'])) as Workspace).id,
      second.id,
    );
    assert.equal(
      (JSON.parse(await command(['workspace', 'list'])) as Workspace[]).length,
      2,
    );
    const audit = await pool.query<{
      workspace_id: string;
      payload: { actor: string; data: Agent };
    }>("SELECT workspace_id,payload FROM events WHERE type='AGENT_CONFIGURED'");
    assert.equal(audit.rows[0]?.workspace_id, second.id);
    assert.equal(audit.rows[0]?.payload.actor, 'operator');
    assert.equal(audit.rows[0]?.payload.data.title, 'Engineer');
  });
});

await test('workspace/root-agent constraints prevent duplicates, missing roots, and cross-workspace roots', async () => {
  await setup(async (pool, _url, db) => {
    const first = await createWorkspace(db, { slug: 'first', name: 'First' });
    const second = await createWorkspace(db, {
      slug: 'second',
      name: 'Second',
    });
    await assert.rejects(
      createWorkspace(db, { slug: 'first', name: 'Duplicate' }),
      /unique/,
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO agents(id,workspace_id,name,title) VALUES ($1,$2,'Extra','Extra')",
        [randomUUID(), first.id],
      ),
      /unique/,
    );
    await assert.rejects(
      pool.query('UPDATE workspaces SET root_agent_id=$2 WHERE id=$1', [
        first.id,
        second.root_agent_id,
      ]),
      /foreign key/,
    );
    await assert.rejects(
      pool.query('DELETE FROM agents WHERE id=$1', [first.root_agent_id]),
      /foreign key/,
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO workspaces(id,slug,name,root_agent_id) VALUES ($1,'orphan','Orphan',$2)",
        [randomUUID(), randomUUID()],
      ),
      /foreign key/,
    );
    assert.equal(
      (await pool.query<{ count: string }>('SELECT count(*) FROM workspaces'))
        .rows[0]?.count,
      '2',
    );
    assert.equal(
      (await pool.query<{ count: string }>('SELECT count(*) FROM agents'))
        .rows[0]?.count,
      '2',
    );
    assert.equal(
      (await pool.query<{ count: string }>('SELECT count(*) FROM events'))
        .rows[0]?.count,
      '4',
    );
    await useWorkspace(db, 'first');
    await assert.rejects(useWorkspace(db, 'missing'), /not found/);
    assert.equal((await showWorkspace(db)).id, first.id);
  });
});

await test('invalid input and audit failures leave workspace and agent state unchanged', async () => {
  await setup(async (pool, _url, db) => {
    await assert.rejects(
      createWorkspace(db, { slug: 'Invalid Slug', name: 'Invalid' }),
      /slug/,
    );
    await assert.rejects(
      createWorkspace(db, { slug: 'blank', name: ' ' }),
      /blank/,
    );
    await assert.rejects(
      createWorkspace(db, {
        slug: 'missing',
        name: 'Missing',
        rootPath: `/tmp/${randomUUID()}`,
      }),
      /ENOENT/,
    );
    // Runtime callers can violate TypeScript declarations; validation must reject them.
    // @ts-expect-error Deliberately exercise malformed external input.
    await assert.rejects(createWorkspace(db, { slug: 'wrong-type', name: 42 }));
    await assert.rejects(
      // @ts-expect-error Unknown fields must not be silently accepted.
      createWorkspace(db, { slug: 'extra', name: 'Extra', unexpected: true }),
    );
    const workspace = await createWorkspace(db, {
      slug: 'valid',
      name: 'Valid',
    });
    await configureAgent(
      db,
      { name: '  Builder  ', roleDescription: 'Original' },
      'valid',
    );
    const cleared = await configureAgent(db, { roleDescription: '' }, 'valid');
    assert.equal(cleared.name, '  Builder  ');
    assert.equal(cleared.title, 'Steward');
    assert.equal(cleared.role_description, '');
    const before = await showAgent(db, 'valid');
    await assert.rejects(configureAgent(db, { title: ' ' }, 'valid'), /blank/);
    // Simulate audit-storage failure; state and events must commit together.
    await pool.query(
      "ALTER TABLE events ADD CONSTRAINT reject_configuration CHECK (type <> 'AGENT_CONFIGURED') NOT VALID",
    );
    await assert.rejects(
      configureAgent(db, { title: 'Changed' }, 'valid'),
      /reject_configuration/,
    );
    assert.deepEqual(await showAgent(db, 'valid'), before);
    await pool.query(
      "ALTER TABLE events ADD CONSTRAINT reject_creation CHECK (type <> 'WORKSPACE_CREATED') NOT VALID",
    );
    await assert.rejects(
      createWorkspace(db, { slug: 'failed', name: 'Failed' }),
      /reject_creation/,
    );
    assert.equal(
      (await pool.query<{ id: string }>('SELECT id FROM workspaces')).rows[0]
        ?.id,
      workspace.id,
    );
    assert.equal(
      (await pool.query<{ count: string }>('SELECT count(*) FROM agents'))
        .rows[0]?.count,
      '1',
    );
  });
});
