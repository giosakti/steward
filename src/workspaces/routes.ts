import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../storage/database.js';
import type { OperatorActor } from '../audit/actor.js';
import { createWorkspaceSchema, configureAgentSchema } from './schemas.js';
import {
  createWorkspace,
  listWorkspaces,
  showWorkspace,
  showAgent,
  configureAgent,
} from './workspaces.js';

const params = z.strictObject({ id: z.uuid() });
const querystring = z.strictObject({});

export function workspaceRoutes(
  server: FastifyInstance,
  { db }: { db: Kysely<Database> },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const operator = (requestId: string): OperatorActor => ({
    actor: 'operator',
    source: 'workspace-http',
    requestId,
  });

  app.post(
    '/api/v1/workspaces',
    { schema: { body: createWorkspaceSchema, querystring } },
    async (request, reply) => {
      const workspace = await createWorkspace(
        db,
        request.body,
        operator(request.id),
      );
      return reply
        .code(201)
        .header('location', `/api/v1/workspaces/${workspace.id}`)
        .send(workspace);
    },
  );
  app.get('/api/v1/workspaces', { schema: { querystring } }, () =>
    listWorkspaces(db),
  );
  app.get(
    '/api/v1/workspaces/:id',
    { schema: { params, querystring } },
    (request) => showWorkspace(db, request.params.id),
  );
  app.get(
    '/api/v1/workspaces/:id/agent',
    { schema: { params, querystring } },
    (request) => showAgent(db, request.params.id),
  );
  app.patch(
    '/api/v1/workspaces/:id/agent',
    { schema: { params, querystring, body: configureAgentSchema } },
    (request) =>
      configureAgent(db, request.body, request.params.id, operator(request.id)),
  );
  done();
}
