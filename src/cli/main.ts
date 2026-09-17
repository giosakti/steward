#!/usr/bin/env node
import {migrate} from '../storage/migrate.js';

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
  console.log('Steward\n\nUsage: steward init\nApply reviewed SQL migrations to DATABASE_URL.');
} else if (args.length !== 1 || args[0] !== 'init') {
  console.error('Unknown command. Use --help.');
  process.exitCode = 1;
} else {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    const applied = await migrate(url);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } catch (error) {
    console.error(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
