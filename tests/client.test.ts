import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { createClient } from '../src/cli/client.js';

async function withServer(
  handler: RequestListener,
  run: (client: ReturnType<typeof createClient>) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server');
  }
  vi.stubEnv('STEWARD_API_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('STEWARD_API_TOKEN', 'test-operator-token');
  try {
    await run(createClient());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

afterEach(() => vi.unstubAllEnvs());

describe('HTTP client policy', () => {
  it('does not follow redirects carrying operator credentials', async () => {
    const paths: string[] = [];
    await withServer(
      (request, response) => {
        paths.push(request.url ?? '');
        response.writeHead(302, {
          location: '/redirect-target',
          'content-type': 'application/json',
        });
        response.end('{}');
      },
      async (client) => {
        await expect(client.request('/api/v1/workspaces')).rejects.toThrow(
          /HTTP 302/,
        );
        expect(paths).toEqual(['/api/v1/workspaces']);
      },
    );
  });

  it('does not retry a failed mutation', async () => {
    let attempts = 0;
    await withServer(
      (_request, response) => {
        attempts++;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ code: 'UNAVAILABLE', error: 'Try later' }),
        );
      },
      async (client) => {
        await expect(
          client.request('/api/v1/workspaces', 'POST', {
            slug: 'first',
            name: 'First',
          }),
        ).rejects.toThrow(/HTTP 503: UNAVAILABLE: Try later/);
        expect(attempts).toBe(1);
      },
    );
  });

  it('rejects malformed JSON instead of returning it as successful data', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{broken');
      },
      async (client) => {
        await expect(client.request('/api/v1/workspaces')).rejects.toThrow(
          /Invalid API response/,
        );
      },
    );
  });
});
