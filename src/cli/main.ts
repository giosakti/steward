#!/usr/bin/env node
import {Command} from 'commander';
import pg from 'pg';
import {createWorkspace, listWorkspaces, showWorkspace, useWorkspace, showAgent, configureAgent} from '../workspaces/workspaces.js';

const program = new Command().name('steward').description('Manage Steward workspaces')
  .option('--workspace <slug>', 'Override the selected workspace for this command');
const selected = () => program.opts<{workspace?: string}>().workspace;
async function run(fn: (pool: pg.Pool) => Promise<unknown>) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({connectionString, connectionTimeoutMillis: 5000});
  try { console.log(JSON.stringify(await fn(pool), null, 2)); }
  finally { await pool.end(); }
}
const workspace = program.command('workspace').description('Create, inspect, and select workspaces');
workspace.command('create <slug> <name>').description('Create a workspace and its root agent')
  .option('--description <text>', 'Workspace description')
  .option('--root-path <path>', 'Existing local project directory')
  .action(async (slug: string, name: string, options: {description?: string; rootPath?: string}) => {
    await run(pool => createWorkspace(pool, {slug, name, ...options}));
  });
workspace.command('list').description('List active workspaces').action(async () => { await run(listWorkspaces); });
workspace.command('show [slug]').description('Show a workspace or the current selection')
  .action(async (slug?: string) => { await run(pool => showWorkspace(pool, slug ?? selected())); });
workspace.command('use <slug>').description('Persist the default workspace for this database')
  .action(async (slug: string) => { await run(pool => useWorkspace(pool, slug)); });
const agent = program.command('agent').description('Inspect and configure the root agent');
agent.command('show').action(async () => { await run(pool => showAgent(pool, selected())); });
agent.command('configure').option('--name <name>').option('--title <title>').option('--role-description <text>')
  .action(async (options: {name?: string; title?: string; roleDescription?: string}) => {
    await run(pool => configureAgent(pool, options, selected()));
  });
try {
  if (process.argv.length === 2) program.outputHelp();
  else await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
