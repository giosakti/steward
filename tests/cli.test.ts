import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { describe, expect, it } from 'vitest';
import type pg from 'pg';

import { buildApp } from '../src/http/app.js';
import { connectDatabase } from '../src/storage/database.js';
import { isolated } from './database.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));
type Command = (
  args: string[],
  overrides?: NodeJS.ProcessEnv,
) => Promise<string>;

interface TestContext {
  command: Command;
  client: pg.Client;
  config: string;
  address: string;
  close: () => Promise<void>;
}

async function setup(fn: (context: TestContext) => Promise<void>) {
  await isolated(async (url, client, schema) => {
    await exec('npm', ['run', 'db:migrate', '--', '--schema', schema], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
    });
    const db = connectDatabase(url);
    const token = randomUUID();
    const app = buildApp(db, token);
    const directory = await mkdtemp(join(tmpdir(), 'steward-cli-'));
    const config = join(directory, 'config.json');
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const command: Command = async (args, overrides = {}) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          STEWARD_API_URL: address,
          STEWARD_API_TOKEN: token,
          STEWARD_CONFIG_FILE: config,
          ...overrides,
        };
        delete env.DATABASE_URL;
        delete env.TEST_DATABASE_URL;
        const result = await exec(process.execPath, [cli, ...args], {
          cwd: directory,
          env,
        });
        expect(result.stderr).toBe('');
        return result.stdout;
      };
      await fn({ command, client, config, address, close: () => app.close() });
    } finally {
      await app.close();
      await db.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function create(command: Command, slug: string) {
  return JSON.parse(await command(['workspace', 'create', slug, slug])) as {
    id: string;
    slug: string;
  };
}

describe('CLI HTTP client', () => {
  it('creates, lists, and configures workspaces without database credentials', async () => {
    await setup(async ({ command, client }) => {
      const workspace = await create(command, 'first');
      expect(JSON.parse(await command(['workspace', 'list']))).toMatchObject([
        { id: workspace.id },
      ]);
      expect(
        JSON.parse(await command(['workspace', 'show', 'first'])),
      ).toMatchObject({ id: workspace.id });
      expect(
        JSON.parse(await command(['--workspace', 'first', 'agent', 'show'])),
      ).toMatchObject({ title: 'Steward' });
      expect(
        JSON.parse(
          await command([
            '--workspace',
            'first',
            'agent',
            'configure',
            '--title',
            'Engineer',
          ]),
        ),
      ).toMatchObject({ title: 'Engineer' });
      const events = (
        await client.query<{ payload: { source: string; requestId: string } }>(
          'SELECT payload FROM events',
        )
      ).rows;
      expect(events).toHaveLength(3);
      for (const { payload } of events) {
        expect(payload.source).toBe('workspace-http');
        expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
      }
    });
  });

  it('persists the selected UUID locally and keeps explicit overrides temporary', async () => {
    await setup(async ({ command, client, config, address }) => {
      const first = await create(command, 'first');
      const second = await create(command, 'second');
      await command(['workspace', 'use', 'first']);
      expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
        apiUrl: address,
        workspaceId: first.id,
      });
      await command([
        '--workspace',
        'second',
        'agent',
        'configure',
        '--title',
        'Builder',
      ]);
      expect(JSON.parse(await command(['agent', 'show']))).toMatchObject({
        workspace_id: first.id,
        title: 'Steward',
      });
      expect(
        JSON.parse(await command(['workspace', 'show', 'second'])),
      ).toMatchObject({ id: second.id });
      await expect(command(['workspace', 'use', 'missing'])).rejects.toThrow(
        /Workspace not found/,
      );
      expect(JSON.parse(await command(['workspace', 'show']))).toMatchObject({
        id: first.id,
      });
      await client.query('UPDATE workspaces SET slug=$1 WHERE id=$2', [
        'renamed',
        first.id,
      ]);
      expect(JSON.parse(await command(['workspace', 'show']))).toMatchObject({
        id: first.id,
        slug: 'renamed',
      });
      expect(
        (
          await client.query(
            "SELECT * FROM events WHERE type='WORKSPACE_SELECTED'",
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await client.query('SELECT to_regclass($1) AS table', [
            'workspace_selection',
          ])
        ).rows,
      ).toEqual([{ table: null }]);
    });
  });

  it('isolates different local configurations and API addresses', async () => {
    await setup(async ({ command, config }) => {
      await create(command, 'first');
      await command(['workspace', 'use', 'first']);
      await expect(
        command(['agent', 'show'], { STEWARD_CONFIG_FILE: `${config}.other` }),
      ).rejects.toThrow(/No workspace selected/);
      await expect(
        command(['agent', 'show'], { STEWARD_API_URL: 'http://127.0.0.1:1' }),
      ).rejects.toThrow(/No workspace selected for this API/);
    });
  });

  it('fails closed for corrupted or stale selections and allows explicit recovery', async () => {
    await setup(async ({ command, client, config }) => {
      const workspace = await create(command, 'first');
      await writeFile(config, '{broken');
      await expect(command(['agent', 'show'])).rejects.toThrow(
        /Invalid CLI configuration/,
      );
      await command(['workspace', 'use', 'first']);
      await client.query(
        'UPDATE workspaces SET archived_at=now() WHERE id=$1',
        [workspace.id],
      );
      await expect(command(['agent', 'show'])).rejects.toThrow(/HTTP 404/);
    });
  });

  it('reports authentication, validation, conflict, and unavailable-server errors', async () => {
    await setup(async ({ command, client, close }) => {
      await expect(
        command(['workspace', 'list'], { STEWARD_API_TOKEN: '' }),
      ).rejects.toThrow(/STEWARD_API_TOKEN is required/);
      await expect(
        command(['workspace', 'create', 'denied', 'Denied'], {
          STEWARD_API_TOKEN: 'wrong',
        }),
      ).rejects.toThrow(/HTTP 401/);
      const workspace = await create(command, 'first');
      await command(['workspace', 'use', 'first']);
      await expect(command(['agent', 'configure'])).rejects.toThrow(
        /HTTP 400.*Provide/,
      );
      await expect(
        command(['agent', 'configure', '--title', ' ']),
      ).rejects.toThrow(/Agent title must not be blank/);
      await expect(create(command, 'first')).rejects.toThrow(/HTTP 409/);
      expect((await client.query('SELECT id FROM workspaces')).rows).toEqual([
        { id: workspace.id },
      ]);
      await close();
      await expect(command(['workspace', 'list'])).rejects.toThrow(
        /Cannot reach Steward API/,
      );
    });
  });

  it('resolves a relative root path from the CLI working directory', async () => {
    await setup(async ({ command, config }) => {
      const created = JSON.parse(
        await command([
          'workspace',
          'create',
          'path',
          'Path',
          '--root-path',
          '.',
        ]),
      ) as { root_path: string };
      expect(created.root_path).toBe(dirname(config));
    });
  });
});
