import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import pg from 'pg';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

// Trusted, reviewed SQL only. Migrations must not contain transaction-control statements.
export async function migrate(connectionString: string, directory: URL = migrationsDirectory): Promise<string[]> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (names.some(name => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) || new Set(names.map(name => name.slice(0, 4))).size !== names.length) {
    throw new Error('Migration names must have unique four-digit prefixes: 0001_description.sql');
  }
  const files = await Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return {name, sql, checksum: createHash('sha256').update(sql).digest('hex')};
  }));
  const client = new pg.Client({connectionString, connectionTimeoutMillis: 5000});
  await client.connect();
  try {
    await client.query('BEGIN');
    // Serialize initialization and migration history checks within this database.
    await client.query("SELECT pg_advisory_xact_lock(1937006967, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await client.query<{name: string; checksum: string}>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    for (const [index, row] of history.rows.entries()) {
      const file = files[index];
      if (!file || file.name !== row.name || file.checksum !== row.checksum) {
        throw new Error(`Migration history differs at ${row.name}; restore applied files and append a new migration`);
      }
    }
    const applied: string[] = [];
    for (const file of files.slice(history.rows.length)) {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
      applied.push(file.name);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
