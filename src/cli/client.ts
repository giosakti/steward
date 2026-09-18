import axios, { type AxiosResponse } from 'axios';
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

  const http = axios.create({
    baseURL: apiUrl.origin,
    headers: { authorization: `Bearer ${token}` },
    timeout: 10000,
    maxRedirects: 0,
    // This local CLI connects directly, without environment-configured proxies.
    proxy: false,
    responseType: 'json',
    transitional: { silentJSONParsing: false },
    validateStatus: () => true,
  });

  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    let response: AxiosResponse<unknown>;
    try {
      response = await http.request<unknown>({
        url: path,
        method,
        data: body,
        // Bound the entire request as well as Axios's socket timeout.
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.code === 'ERR_BAD_RESPONSE') {
        throw new Error('Invalid API response', { cause: error });
      }
      throw new Error(
        `Cannot reach Steward API at ${apiUrl.origin}; check the server and STEWARD_API_URL`,
        { cause: error },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const error = errorSchema.safeParse(response.data);
      const message = error.success
        ? `${error.data.code}: ${error.data.error}`
        : 'Request failed';
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return response.data;
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
