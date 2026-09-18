#!/usr/bin/env node
import { resolve } from 'node:path';

import { Command } from 'commander';

import { createClient } from './client.js';
import { saveSelection } from './config.js';
import { resolveWorkspace } from './workspace.js';

const program = new Command()
  .name('steward')
  .description('Manage Steward workspaces through the HTTP API')
  .option('--workspace <slug>', 'Override the locally selected workspace');
const selected = () => program.opts<{ workspace?: string }>().workspace;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

const workspace = program
  .command('workspace')
  .description('Create, inspect, and select workspaces');
workspace
  .command('create <slug> <name>')
  .description('Create a workspace and its root agent')
  .option('--description <text>', 'Workspace description')
  .option('--root-path <path>', 'Existing project directory on the server')
  .action(
    async (
      slug: string,
      name: string,
      options: { description?: string; rootPath?: string },
    ) => {
      const body = { slug, name, ...options };
      if (options.rootPath !== undefined && options.rootPath.trim()) {
        body.rootPath = resolve(options.rootPath);
      }
      print(await createClient().request('/api/v1/workspaces', 'POST', body));
    },
  );

workspace
  .command('list')
  .description('List active workspaces')
  .action(async () => {
    print(await createClient().request('/api/v1/workspaces'));
  });

workspace
  .command('show [slug]')
  .description('Show a workspace or the local selection')
  .action(async (slug?: string) => {
    print(await resolveWorkspace(createClient(), slug ?? selected()));
  });

workspace
  .command('use <slug>')
  .description('Save the selected workspace on this machine')
  .action(async (slug: string) => {
    const client = createClient();
    const workspace = await resolveWorkspace(client, slug);
    await saveSelection(client.apiUrl, workspace.id);
    print(workspace);
  });

const agent = program
  .command('agent')
  .description('Inspect and configure the root agent');
agent.command('show').action(async () => {
  const client = createClient();
  const workspace = await resolveWorkspace(client, selected());
  print(await client.request(`/api/v1/workspaces/${workspace.id}/agent`));
});

agent
  .command('configure')
  .option('--name <name>')
  .option('--title <title>')
  .option('--role-description <text>')
  .action(
    async (options: {
      name?: string;
      title?: string;
      roleDescription?: string;
    }) => {
      const client = createClient();
      const workspace = await resolveWorkspace(client, selected());
      print(
        await client.request(
          `/api/v1/workspaces/${workspace.id}/agent`,
          'PATCH',
          options,
        ),
      );
    },
  );

try {
  if (process.argv.length === 2) {
    program.outputHelp();
  } else {
    await program.parseAsync();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
