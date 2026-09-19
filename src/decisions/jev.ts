import { TypeSafeClient, type SystemOneRequestPayload } from '@typesafe-ai/sdk';

export type EvaluateJev = (
  request: SystemOneRequestPayload,
) => Promise<unknown>;

export function createJevEvaluator(apiKey: string | undefined): EvaluateJev {
  return async (request) => {
    if (!apiKey) {
      throw new Error('Jev unavailable');
    }
    const client = new TypeSafeClient({
      apiKey,
      baseURL: 'https://api.typesafe.ai',
      timeout: 30000,
      retry: { maxRetries: 0 },
      logLevel: 'off',
    });
    // Preserve the actual service payload, including malformed answers, for audit.
    const response = await client.systemOne(request).asResponse();
    return response.json() as Promise<unknown>;
  };
}
