import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../storage/database.js';
import {
  createWorkItemRelationship,
  removeWorkItemRelationship,
  listWorkItemRelationships,
  showWorkItemRelationship,
} from './relationships.js';
import { createWorkItemRelationshipSchema } from './schemas.js';

export function workItemRelationshipRoutes(
  server: FastifyInstance,
  { db }: { db: Kysely<Database> },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/api/v1/workspaces/:id/work-item-relationships',
    {
      schema: {
        params: workspaceParams,
        querystring: emptyQuery,
        body: createWorkItemRelationshipSchema,
      },
    },
    async (request, reply) => {
      const result = await createWorkItemRelationship(
        db,
        request.params.id,
        request.body,
        { actor: 'operator', source: 'workspace-http', requestId: request.id },
      );
      return reply
        .code(201)
        .header(
          'location',
          `/api/v1/workspaces/${request.params.id}/work-item-relationships/${result.id}`,
        )
        .send(result);
    },
  );
  app.delete(
    '/api/v1/workspaces/:id/work-item-relationships/:relationshipId',
    { schema: { params: relationshipParams, querystring: emptyQuery } },
    async (request, reply) => {
      await removeWorkItemRelationship(
        db,
        request.params.id,
        request.params.relationshipId,
        { actor: 'operator', source: 'workspace-http', requestId: request.id },
      );
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/workspaces/:id/work-item-relationships',
    { schema: { params: workspaceParams, querystring: listQuery } },
    (request) =>
      listWorkItemRelationships(db, request.params.id, request.query.entityId),
  );
  app.get(
    '/api/v1/workspaces/:id/work-item-relationships/:relationshipId',
    { schema: { params: relationshipParams, querystring: emptyQuery } },
    (request) =>
      showWorkItemRelationship(
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
