import { z } from 'zod';

import { configureAgentSchema } from '../workspaces/schemas.js';

export const riskClassSchema = z.enum([
  'READ_ONLY',
  'LOCAL_REVERSIBLE',
  'EXTERNAL_REVERSIBLE',
  'DESTRUCTIVE',
  'IRREVERSIBLE',
  'SECURITY_SENSITIVE',
]);

const text = z.string().trim().min(1).max(4000);

// Claims in a proposal are inputs to evaluation, never authoritative facts.
export const actionIntentSchema = z.strictObject({
  type: z.string().min(1).max(100),
  objective: text,
  rationale: text,
  intendedScope: z.uuid(),
  intendedTarget: z.uuid(),
  expectedEffect: text,
  riskClass: riskClassSchema,
  parameters: configureAgentSchema,
});

export type ActionProposal = z.infer<typeof actionIntentSchema>;
