import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
const exec = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/steward_test') throw new Error('TEST_DATABASE_URL must target the separate steward_test database');
const root = fileURLToPath(new URL('../../', import.meta.url));

async function isolated(fn: (url: string, client: pg.Client, schema: string) => Promise<void>) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({connectionString: url});
  await admin.connect();
  const scoped = new URL(url!);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({connectionString: scoped.toString()});
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await client.connect();
    await fn(scoped.toString(), client, schema);
  } finally {
    await client.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

await test('project migrations create an empty event log', async () => {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root, env: {...process.env, DATABASE_URL: url},
    });
    assert.deepEqual((await client.query('SELECT * FROM events')).rows, []);
  });
});

await test('event log allows inserts and reads but rejects mutation', async () => {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root, env: {...process.env, DATABASE_URL: url},
    });
    await client.query("INSERT INTO events(type, payload) VALUES ('BOOTSTRAP_TEST', '{\"note\":\"preserve\"}')");
    const before = (await client.query('SELECT * FROM events')).rows;
    assert.equal(before.length, 1);
    for (const sql of ["UPDATE events SET type='changed'", 'DELETE FROM events', 'TRUNCATE events']) {
      await assert.rejects(client.query(sql), /append-only/);
    }
    assert.deepEqual((await client.query('SELECT * FROM events')).rows, before);
  });
});
