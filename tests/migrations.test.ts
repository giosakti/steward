import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, writeFile, rm, readFile, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {migrate} from '../src/storage/migrate.js';
const exec = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required; tests use PostgreSQL with disposable schemas');

async function isolated(fn: (url: string, client: pg.Client) => Promise<void>) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({connectionString: url});
  await admin.connect();
  const scoped = new URL(url!);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({connectionString: scoped.toString()});
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await client.connect();
    await fn(scoped.toString(), client);
  } finally {
    await client.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

test('clean initialization persists across processes, repeats safely, and protects events', async () => {
  await isolated(async (url, client) => {
    const cli = new URL('../src/cli/main.js', import.meta.url);
    const args = [cli.pathname, 'init'];
    const first = await exec(process.execPath, args, {env: {...process.env, DATABASE_URL: url}});
    assert.match(first.stdout, /Applied: 0001_events.sql/);
    const second = await exec(process.execPath, args, {env: {...process.env, DATABASE_URL: url}});
    assert.match(second.stdout, /Database is up to date/);
    await client.query("INSERT INTO events(type, payload) VALUES ('BOOTSTRAP_TEST', '{\"note\":\"preserve\"}')");
    for (const sql of ["UPDATE events SET type='changed'", 'DELETE FROM events', 'TRUNCATE events']) {
      await assert.rejects(client.query(sql), /append-only/);
    }
    assert.equal((await client.query('SELECT count(*) FROM events')).rows[0].count, '1');
    assert.equal((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '1');
  });
});

test('concurrent initialization applies each migration once', async () => {
  await isolated(async (url, client) => {
    const results = await Promise.all([migrate(url), migrate(url)]);
    assert.equal(results.flat().length, 1);
    assert.equal((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '1');
  });
});

test('failed SQL rolls back schema and history, then a corrected migration succeeds', async () => {
  const path = await mkdtemp(join(tmpdir(), 'steward-migrations-'));
  const directory = pathToFileURL(`${path}/`);
  try {
    await writeFile(join(path, '0001_sample.sql'), 'CREATE TABLE sample (id int);');
    await writeFile(join(path, '0002_broken.sql'), 'SELECT nonexistent_column;');
    await isolated(async (url, client) => {
      await assert.rejects(migrate(url, directory), /nonexistent_column/);
      assert.equal((await client.query("SELECT to_regclass('sample') AS name")).rows[0].name, null);
      assert.equal((await client.query("SELECT to_regclass('schema_migrations') AS name")).rows[0].name, null);
      await writeFile(join(path, '0002_broken.sql'), 'ALTER TABLE sample ADD COLUMN label text;');
      assert.equal((await migrate(url, directory)).length, 2);
      const original = await readFile(join(path, '0001_sample.sql'), 'utf8');
      await writeFile(join(path, '0001_sample.sql'), `${original}\n-- edited`);
      await assert.rejects(migrate(url, directory), /Migration history differs/);
      await writeFile(join(path, '0001_sample.sql'), original);
      await unlink(join(path, '0002_broken.sql'));
      await assert.rejects(migrate(url, directory), /Migration history differs/);
      assert.equal((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '2');
    });
  } finally { await rm(path, {recursive: true, force: true}); }
});

test('CLI help needs no database and invalid commands fail', async () => {
  const cli = new URL('../src/cli/main.js', import.meta.url).pathname;
  const env = {...process.env}; delete env.DATABASE_URL;
  assert.match((await exec(process.execPath, [cli, '--help'], {env})).stdout, /steward init/);
  await assert.rejects(exec(process.execPath, [cli, 'init'], {env}), /DATABASE_URL is required/);
  await assert.rejects(exec(process.execPath, [cli, 'unknown'], {env}), /Unknown command/);
});
