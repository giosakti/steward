import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolated } from './database.js';
import { connectDatabase } from '../src/storage/database.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

describe('database migrations', () => {
  it('project migrations create an empty event log', async () => {
    await isolated(async (url, client, schema) => {
      await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
      });
      expect((await client.query('SELECT * FROM events')).rows).toEqual([]);
    });
  });

  it('event log allows inserts and reads but rejects mutation', async () => {
    await isolated(async (url, client, schema) => {
      await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
      });
      await client.query(
        'INSERT INTO events(type, payload) VALUES (\'BOOTSTRAP_TEST\', \'{"note":"preserve"}\')',
      );
      const before = (await client.query('SELECT * FROM events')).rows;
      expect(before.length).toBe(1);
      for (const sql of [
        "UPDATE events SET type='changed'",
        'DELETE FROM events',
        'TRUNCATE events',
      ]) {
        await expect(client.query(sql)).rejects.toThrow(/append-only/);
      }
      expect((await client.query('SELECT * FROM events')).rows).toEqual(before);
    });
  });
  it('removes database selection on upgrade without losing workspace or event records', async () => {
    await isolated(async (url, client, schema) => {
      const options = { cwd: root, env: { ...process.env, DATABASE_URL: url } };
      await exec(
        'npm',
        ['run', 'db:migrate', '--', '2', '--schema', schema],
        options,
      );
      const db = connectDatabase(url);
      try {
        const workspace = await createWorkspace(
          db,
          { slug: 'existing', name: 'Existing' },
          { actor: 'operator', source: 'workspace-http' },
        );
        await client.query(
          'INSERT INTO workspace_selection(workspace_id) VALUES ($1)',
          [workspace.id],
        );
        await client.query(
          "INSERT INTO events(workspace_id, type, payload) VALUES ($1, 'WORKSPACE_SELECTED', '{}')",
          [workspace.id],
        );
        const events = (await client.query('SELECT * FROM events ORDER BY id'))
          .rows;
        await exec(
          'npm',
          ['run', 'db:migrate', '--', '--schema', schema],
          options,
        );
        expect(
          (
            await client.query('SELECT to_regclass($1) AS table', [
              'workspace_selection',
            ])
          ).rows,
        ).toEqual([{ table: null }]);
        expect((await client.query('SELECT id FROM workspaces')).rows).toEqual([
          { id: workspace.id },
        ]);
        expect((await client.query('SELECT id FROM agents')).rows).toEqual([
          { id: workspace.root_agent_id },
        ]);
        expect(
          (await client.query('SELECT * FROM events ORDER BY id')).rows,
        ).toEqual(events);
      } finally {
        await db.destroy();
      }
    });
  });
});
