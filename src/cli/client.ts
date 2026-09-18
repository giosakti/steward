import { z } from 'zod';
import { selectedWorkspace } from './config.js';

const workspaceSchema = z.looseObject({ id: z.uuid(), slug: z.string() });
const errorSchema = z.object({ code: z.string(), error: z.string() });

export function createClient() {
  const apiUrl = new URL(
    process.env.STEWARD_API_URL ?? 'http://127.0.0.1:3000',
  );
  if (
    !['http:', 'https:'].includes(apiUrl.protocol) ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    apiUrl.pathname !== '/'
  ) {
    throw new Error(
      'STEWARD_API_URL must be an HTTP(S) origin without credentials, a path, query, or fragment',
    );
  }
  const token = process.env.STEWARD_API_TOKEN;
  if (!token) {
    throw new Error('STEWARD_API_TOKEN is required');
  }

  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, apiUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error(
        `Cannot reach Steward API at ${apiUrl.origin}; check the server and STEWARD_API_URL`,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Invalid API response (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const error = errorSchema.safeParse(result);
      const message = error.success
        ? `${error.data.code}: ${error.data.error}`
        : 'Request failed';
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return result;
  }

  async function workspace(slug?: string) {
    let id: string;
    if (slug !== undefined) {
      const workspaces = z
        .array(workspaceSchema)
        .parse(await request('/api/v1/workspaces'));
      const match = workspaces.find((workspace) => workspace.slug === slug);
      if (!match) {
        throw new Error(`Workspace not found: ${slug}`);
      }
      id = match.id;
    } else {
      id = await selectedWorkspace(apiUrl.origin);
    }
    return workspaceSchema.parse(await request(`/api/v1/workspaces/${id}`));
  }

  return { apiUrl: apiUrl.origin, request, workspace };
}
