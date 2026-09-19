import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../storage/database.js';
import { setMission, showMission } from './missions.js';
import { setMissionSchema } from './schemas.js';

export function missionRoutes(
  server: FastifyInstance,
  { db }: { db: Kysely<Database> },
  done: () => void,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.put(
    '/api/v1/workspaces/:id/mission',
    { schema: { params, querystring, body: setMissionSchema } },
    (request) =>
      setMission(db, request.params.id, request.body, {
        actor: 'operator',
        source: 'workspace-http',
        requestId: request.id,
      }),
  );
  app.get(
    '/api/v1/workspaces/:id/mission',
    { schema: { params, querystring } },
    (request) => showMission(db, request.params.id),
  );
  done();
}

const params = z.strictObject({ id: z.uuid() });
const querystring = z.strictObject({});
