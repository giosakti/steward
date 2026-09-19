import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../storage/database.js';
import {
  createGoalRelationship,
  removeGoalRelationship,
  listGoalRelationships,
  showGoalRelationship,
} from './relationships.js';
import { createGoalRelationshipSchema } from './schemas.js';

export function goalRelationshipRoutes(
  server: FastifyInstance,
  { db }: { db: Kysely<Database> },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/api/v1/workspaces/:id/goal-relationships',
    {
      schema: {
        params: workspaceParams,
        querystring: emptyQuery,
        body: createGoalRelationshipSchema,
      },
    },
    async (request, reply) => {
      const result = await createGoalRelationship(
        db,
        request.params.id,
        request.body,
        { actor: 'operator', source: 'workspace-http', requestId: request.id },
      );
      return reply
        .code(201)
        .header(
          'location',
          `/api/v1/workspaces/${request.params.id}/goal-relationships/${result.id}`,
        )
        .send(result);
    },
  );
  app.delete(
    '/api/v1/workspaces/:id/goal-relationships/:relationshipId',
    { schema: { params: relationshipParams, querystring: emptyQuery } },
    async (request, reply) => {
      await removeGoalRelationship(
        db,
        request.params.id,
        request.params.relationshipId,
        { actor: 'operator', source: 'workspace-http', requestId: request.id },
      );
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/workspaces/:id/goal-relationships',
    { schema: { params: workspaceParams, querystring: listQuery } },
    (request) =>
      listGoalRelationships(db, request.params.id, request.query.entityId),
  );
  app.get(
    '/api/v1/workspaces/:id/goal-relationships/:relationshipId',
    { schema: { params: relationshipParams, querystring: emptyQuery } },
    (request) =>
      showGoalRelationship(
        db,
        request.params.id,
        request.params.relationshipId,
      ),
  );
  done();
}

const workspaceParams = z.strictObject({ id: z.uuid() });
const relationshipParams = z.strictObject({
  id: z.uuid(),
  relationshipId: z.uuid(),
});
const emptyQuery = z.strictObject({});
const listQuery = z.strictObject({ entityId: z.uuid().optional() });
