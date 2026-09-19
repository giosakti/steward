import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJevEvaluator } from '../src/decisions/jev.js';
import { preparation, proposal, response } from './decision-fixtures.js';
import { evaluationRequest } from '../src/decisions/policy.js';

const request = evaluationRequest(proposal(), preparation());

afterEach(() => vi.unstubAllGlobals());

describe('Jev adapter', () => {
  it('sends one batched request through the official SDK and preserves the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(response())),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await createJevEvaluator('test-key')(request)).toEqual(response());
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options?.method).toBe('POST');
    expect(new Headers(options?.headers).get('authorization')).toBe(
      'Bearer test-key',
    );
    expect(typeof options?.body).toBe('string');
    expect(JSON.parse(options?.body as string)).toEqual(request);
  });

  it('does not silently retry a failed evaluation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(createJevEvaluator('test-key')(request)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('makes no request without server-side credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    await expect(createJevEvaluator(undefined)(request)).rejects.toThrow(
      /unavailable/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
