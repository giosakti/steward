import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { OperatorActor } from '../audit/actor.js';
import type { Database } from '../storage/database.js';
import {
  createActionIntent,
  evaluateIntent,
  showActionIntent,
  showDecision,
} from './decisions.js';
import type { EvaluateJev } from './jev.js';
import { actionIntentSchema } from './schemas.js';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const entityParams = workspaceParams.extend({ id: z.uuid() });
const querystring = z.strictObject({});

export function decisionRoutes(
  server: FastifyInstance,
  { db, evaluateJev }: { db: Kysely<Database>; evaluateJev: EvaluateJev },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const prefix = '/api/v1/workspaces/:workspaceId';
  const operator = (requestId: string): OperatorActor => ({
    actor: 'operator',
    source: 'decision-http',
    requestId,
  });

  app.post(
    `${prefix}/action-intents`,
    {
      schema: {
        params: workspaceParams,
        querystring,
        body: actionIntentSchema,
      },
    },
    async (request, reply) => {
      const intent = await createActionIntent(
        db,
        request.params.workspaceId,
        request.body,
        operator(request.id),
      );
      return reply
        .code(201)
        .header(
          'location',
          `/api/v1/workspaces/${intent.workspace_id}/action-intents/${intent.id}`,
        )
        .send(intent);
    },
  );

  app.get(
    `${prefix}/action-intents/:id`,
    {
      schema: { params: entityParams, querystring },
    },
    (request) =>
      showActionIntent(db, request.params.workspaceId, request.params.id),
  );

  app.post(
    `${prefix}/action-intents/:id/decisions`,
    {
      schema: { params: entityParams, querystring, body: z.strictObject({}) },
    },
    async (request, reply) => {
      const decision = await evaluateIntent(
        db,
        request.params.workspaceId,
        request.params.id,
        operator(request.id),
        evaluateJev,
      );
      return reply
        .code(201)
        .header(
          'location',
          `/api/v1/workspaces/${decision.workspace_id}/decisions/${decision.id}`,
        )
        .send(decision);
    },
  );

  app.get(
    `${prefix}/decisions/:id`,
    {
      schema: { params: entityParams, querystring },
    },
    (request) =>
      showDecision(db, request.params.workspaceId, request.params.id),
  );
  done();
}
