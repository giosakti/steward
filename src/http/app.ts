import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import bearerAuth from '@fastify/bearer-auth';
import {
  validatorCompiler,
  serializerCompiler,
  hasZodFastifySchemaValidationErrors,
} from '@fastify/type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../storage/database.js';
import { ApplicationError } from '../errors.js';
import { goalRelationshipRoutes } from '../goals/relationship-routes.js';
import { workItemRelationshipRoutes } from '../work-items/relationship-routes.js';
import { goalRoutes } from '../goals/routes.js';
import { workItemRoutes } from '../work-items/routes.js';
import { workspaceRoutes } from '../workspaces/routes.js';

export function buildApp(db: Kysely<Database>, token: string, logging = false) {
  // Refuse missing or malformed credentials before accepting connections.
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error(
      'STEWARD_API_TOKEN must contain at least 32 letters, digits, underscores, or hyphens',
    );
  }
  const app = Fastify({
    logger: logging ? { redact: ['req.headers.authorization'] } : false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 65536,
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-request-id', request.id);
    if (reply.statusCode === 401) {
      reply.header('www-authenticate', 'Bearer');
    }
    done(null, payload);
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(bearerAuth, {
    keys: new Set([token]),
    errorResponse: () => ({
      code: 'UNAUTHORIZED',
      error: 'A valid operator bearer token is required',
    }),
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      const status = {
        INVALID_INPUT: 400,
        NOT_FOUND: 404,
        FORBIDDEN: 403,
        CONFLICT: 409,
      }[error.code];
      return reply
        .code(status)
        .send({ code: error.code, error: error.message });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        error: error.message,
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        error: error.issues.map((issue) => issue.message).join('; '),
      });
    }
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply
        .code(error.statusCode)
        .send({ code: 'INVALID_REQUEST', error: 'Invalid request' });
    }
    request.log.error({ err: error }, 'Request failed');
    return reply
      .code(500)
      .send({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: 'NOT_FOUND', error: 'Route not found' }),
  );
  app.register(workspaceRoutes, { db });
  app.register(goalRelationshipRoutes, { db });
  app.register(workItemRelationshipRoutes, { db });
  app.register(goalRoutes, { db });
  app.register(workItemRoutes, { db });
  return app;
}
