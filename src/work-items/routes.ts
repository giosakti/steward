import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../storage/database.js';
import { createWorkItemSchema, updateWorkItemSchema } from './schemas.js';
import {
  createWorkItem,
  updateWorkItem,
  listWorkItems,
  showWorkItem,
} from './work-items.js';

export function workItemRoutes(
  server: FastifyInstance,
  { db }: { db: Kysely<Database> },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/api/v1/workspaces/:id/work-items',
    {
      schema: {
        params: workspaceParams,
        querystring,
        body: createWorkItemSchema,
      },
    },
    async (request, reply) => {
      const result = await createWorkItem(db, request.params.id, request.body, {
        actor: 'operator',
        source: 'workspace-http',
        requestId: request.id,
      });
      return reply
        .code(201)
        .header(
          'location',
          `/api/v1/workspaces/${request.params.id}/work-items/${result.id}`,
        )
        .send(result);
    },
  );
  app.patch(
    '/api/v1/workspaces/:id/work-items/:entityId',
    {
      schema: { params: entityParams, querystring, body: updateWorkItemSchema },
    },
    (request) =>
      updateWorkItem(
        db,
        request.params.id,
        request.params.entityId,
        request.body,
        {
          actor: 'operator',
          source: 'workspace-http',
          requestId: request.id,
        },
      ),
  );
  app.get(
    '/api/v1/workspaces/:id/work-items',
    { schema: { params: workspaceParams, querystring } },
    (request) => listWorkItems(db, request.params.id),
  );
  app.get(
    '/api/v1/workspaces/:id/work-items/:entityId',
    { schema: { params: entityParams, querystring } },
    (request) => showWorkItem(db, request.params.id, request.params.entityId),
  );
  done();
}

const workspaceParams = z.strictObject({ id: z.uuid() });
const entityParams = z.strictObject({ id: z.uuid(), entityId: z.uuid() });
const querystring = z.strictObject({});
