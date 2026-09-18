import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const selectionSchema = z.strictObject({
  apiUrl: z.url(),
  workspaceId: z.uuid(),
});

function configPath() {
  return (
    process.env.STEWARD_CONFIG_FILE ??
    join(
      process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
      'steward',
      'config.json',
    )
  );
}

export async function selectedWorkspace(apiUrl: string): Promise<string> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new Error(
        'No workspace selected; use workspace use <slug> or --workspace <slug>',
        { cause: error },
      );
    }
    throw error;
  }
  let selection: z.infer<typeof selectionSchema>;
  try {
    selection = selectionSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(
      `Invalid CLI configuration at ${path}; select a workspace again`,
    );
  }
  if (selection.apiUrl !== apiUrl) {
    throw new Error(
      'No workspace selected for this API; use workspace use <slug> or --workspace <slug>',
    );
  }
  return selection.workspaceId;
}

export async function saveSelection(apiUrl: string, workspaceId: string) {
  const selection = selectionSchema.parse({ apiUrl, workspaceId });
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
