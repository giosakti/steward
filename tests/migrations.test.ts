import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolated } from './database.js';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

await test('project migrations create an empty event log', async () => {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    assert.deepEqual((await client.query('SELECT * FROM events')).rows, []);
  });
});

await test('event log allows inserts and reads but rejects mutation', async () => {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    await client.query(
      'INSERT INTO events(type, payload) VALUES (\'BOOTSTRAP_TEST\', \'{"note":"preserve"}\')',
    );
    const before = (await client.query('SELECT * FROM events')).rows;
    assert.equal(before.length, 1);
    for (const sql of [
      "UPDATE events SET type='changed'",
      'DELETE FROM events',
      'TRUNCATE events',
    ]) {
      await assert.rejects(client.query(sql), /append-only/);
    }
    assert.deepEqual((await client.query('SELECT * FROM events')).rows, before);
  });
});
