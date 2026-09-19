import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../storage/database.js';
import { createGoal, updateGoal, listGoals, showGoal } from './goals.js';
import { createGoalSchema, updateGoalSchema } from './schemas.js';

export function goalRoutes(
  server: FastifyInstance,
  { db }: { db: Kysely<Database> },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/api/v1/workspaces/:id/goals',
    {
      schema: { params: workspaceParams, querystring, body: createGoalSchema },
    },
    async (request, reply) => {
      const result = await createGoal(db, request.params.id, request.body, {
        actor: 'operator',
        source: 'workspace-http',
        requestId: request.id,
      });
      return reply
        .code(201)
        .header(
          'location',
          `/api/v1/workspaces/${request.params.id}/goals/${result.id}`,
        )
        .send(result);
    },
  );
  app.patch(
    '/api/v1/workspaces/:id/goals/:entityId',
    { schema: { params: entityParams, querystring, body: updateGoalSchema } },
    (request) =>
      updateGoal(db, request.params.id, request.params.entityId, request.body, {
        actor: 'operator',
        source: 'workspace-http',
        requestId: request.id,
      }),
  );
  app.get(
    '/api/v1/workspaces/:id/goals',
    { schema: { params: workspaceParams, querystring } },
    (request) => listGoals(db, request.params.id),
  );
  app.get(
    '/api/v1/workspaces/:id/goals/:entityId',
    { schema: { params: entityParams, querystring } },
    (request) => showGoal(db, request.params.id, request.params.entityId),
  );
  done();
}

const workspaceParams = z.strictObject({ id: z.uuid() });
const entityParams = z.strictObject({ id: z.uuid(), entityId: z.uuid() });
const querystring = z.strictObject({});
