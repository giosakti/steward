import {fileURLToPath} from 'node:url';
import {runner} from 'node-pg-migrate';

export async function migrate(
  connectionString: string,
  directory = new URL('./migrations/', import.meta.url),
  schema = 'public',
): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid schema name');
  const applied = await runner({
    databaseUrl: {connectionString, connectionTimeoutMillis: 5000},
    dir: fileURLToPath(directory),
    schema,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    singleTransaction: true,
    checkOrder: true,
    advisoryLockMode: 'wait',
    log: () => undefined,
  });
  return applied.map(migration => migration.name);
}
