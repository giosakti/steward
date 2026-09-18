import { z } from 'zod';
import { ApplicationError } from '../errors.js';

const operatorActorSchema = z.strictObject({
  actor: z.literal('operator'),
  source: z.enum(['workspace-http', 'decision-http']),
  requestId: z.string().optional(),
});

export type OperatorActor = z.infer<typeof operatorActorSchema>;

// Trusted entry points construct this audit actor after authentication, never from user input.
// Agent access will require a separate Decision Kernel authorization path.
export function validateOperatorActor(actor: OperatorActor): OperatorActor {
  const result = operatorActorSchema.safeParse(actor);
  if (!result.success) {
    throw new ApplicationError('FORBIDDEN', 'A human operator is required');
  }
  return result.data;
}
