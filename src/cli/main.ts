#!/usr/bin/env node
import { Command } from 'commander';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { connectDatabase, type Database } from '../storage/database.js';
import {
  createWorkspace,
  listWorkspaces,
  showWorkspace,
  useWorkspace,
  showAgent,
  configureAgent,
} from '../workspaces/workspaces.js';
import type {
  CreateWorkspaceInput,
  ConfigureAgentInput,
} from '../workspaces/schemas.js';

const program = new Command()
  .name('steward')
  .description('Manage Steward workspaces')
  .option(
    '--workspace <slug>',
    'Override the selected workspace for this command',
  );

const selected = () => program.opts<{ workspace?: string }>().workspace;

async function run(fn: (db: Kysely<Database>) => Promise<unknown>) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const db = connectDatabase(connectionString);
  try {
    const result = await fn(db);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.destroy();
  }
}

const workspace = program
  .command('workspace')
  .description('Create, inspect, and select workspaces');

workspace
  .command('create <slug> <name>')
  .description('Create a workspace and its root agent')
  .option('--description <text>', 'Workspace description')
  .option('--root-path <path>', 'Existing local project directory')
  .action(
    async (
      slug: string,
      name: string,
      options: Pick<CreateWorkspaceInput, 'description' | 'rootPath'>,
    ) => {
      await run((db) => createWorkspace(db, { slug, name, ...options }));
    },
  );

workspace
  .command('list')
  .description('List active workspaces')
  .action(async () => {
    await run(listWorkspaces);
  });

workspace
  .command('show [slug]')
  .description('Show a workspace or the current selection')
  .action(async (slug?: string) => {
    await run((db) => showWorkspace(db, slug ?? selected()));
  });

workspace
  .command('use <slug>')
  .description('Persist the default workspace for this database')
  .action(async (slug: string) => {
    await run((db) => useWorkspace(db, slug));
  });

const agent = program
  .command('agent')
  .description('Inspect and configure the root agent');

agent.command('show').action(async () => {
  await run((db) => showAgent(db, selected()));
});

agent
  .command('configure')
  .option('--name <name>')
  .option('--title <title>')
  .option('--role-description <text>')
  .action(async (options: ConfigureAgentInput) => {
    await run((db) => configureAgent(db, options, selected()));
  });

try {
  if (process.argv.length === 2) {
    program.outputHelp();
  } else {
    await program.parseAsync();
  }
} catch (error) {
  let message = String(error);
  if (error instanceof z.ZodError) {
    message = error.issues.map((issue) => issue.message).join('; ');
  } else if (error instanceof Error) {
    message = error.message;
  }

  console.error(message);
  process.exitCode = 1;
}
