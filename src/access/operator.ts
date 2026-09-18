import { z } from 'zod';
import { ApplicationError } from '../errors.js';

const operatorSchema = z.strictObject({
  actor: z.literal('operator'),
  source: z.enum(['workspace-cli', 'workspace-http']),
  requestId: z.string().optional(),
});

export type OperatorContext = z.infer<typeof operatorSchema>;

// Only trusted entry points construct this context. Never parse it from user input.
// Agent access will require a separate Decision Kernel authorization path.
export function requireOperator(context: OperatorContext): OperatorContext {
  const result = operatorSchema.safeParse(context);
  if (!result.success) {
    throw new ApplicationError('FORBIDDEN', 'A human operator is required');
  }
  return result.data;
}
