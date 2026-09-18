import { randomUUID } from 'node:crypto';
import pg from 'pg';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/steward_test') {
  throw new Error(
    'TEST_DATABASE_URL must target the separate steward_test database',
  );
}

export async function isolated(
  fn: (url: string, client: pg.Client, schema: string) => Promise<void>,
) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const scoped = new URL(url!);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const client = new pg.Client({ connectionString: scoped.toString() });
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
