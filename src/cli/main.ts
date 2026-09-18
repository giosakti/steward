#!/usr/bin/env node
import {Command} from 'commander';
import {migrate} from '../storage/migrate.js';

const program = new Command()
  .name('steward')
  .description('Steward bootstrap tools');

program.command('init')
  .description('Apply reviewed SQL migrations to DATABASE_URL')
  .option('--schema <name>', 'Existing PostgreSQL schema', 'public')
  .action(async (options: {schema: string}) => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    const applied = await migrate(url, undefined, options.schema);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  });

try {
  if (process.argv.length === 2) program.outputHelp();
  else await program.parseAsync();
} catch (error) {
  console.error(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
