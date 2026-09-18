import { z } from 'zod';

import type { createClient } from './client.js';
import { selectedWorkspace } from './config.js';

const workspaceSchema = z.looseObject({ id: z.uuid(), slug: z.string() });

export async function resolveWorkspace(
  client: ReturnType<typeof createClient>,
  slug?: string,
) {
  let id: string;
  if (slug !== undefined) {
    const workspaces = z
      .array(workspaceSchema)
      .parse(await client.request('/api/v1/workspaces'));
    const match = workspaces.find((workspace) => workspace.slug === slug);
    if (!match) {
      throw new Error(`Workspace not found: ${slug}`);
    }
    id = match.id;
  } else {
    id = await selectedWorkspace(client.apiUrl);
  }
  return workspaceSchema.parse(
    await client.request(`/api/v1/workspaces/${id}`),
  );
}
