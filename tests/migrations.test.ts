import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolated } from './database.js';
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
});
