import { z } from 'zod';

const text = z.string().trim().min(1);
const criteria = z.array(text.max(2000)).min(1).max(100);
const priority = z.number().int().min(-2147483648).max(2147483647);

export const workItemStatusSchema = z.enum([
  'proposed',
  'ready',
  'running',
  'needs_review',
  'completed',
  'rejected',
  'blocked',
]);
const operatorStatusSchema = workItemStatusSchema.exclude([
  'running',
  'needs_review',
]);

export const createWorkItemSchema = z.strictObject({
  goalId: z.uuid(),
  title: text.max(200),
  objective: text.max(10000),
  acceptanceCriteria: criteria,
  priority: priority.optional(),
});

export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const updateWorkItemSchema = z
  .strictObject({
    title: text.max(200).optional(),
    objective: text.max(10000).optional(),
    acceptanceCriteria: criteria.optional(),
    priority: priority.optional(),
    status: operatorStatusSchema.optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Provide at least one field',
  );

export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;

export const createWorkItemRelationshipSchema = z
  .strictObject({
    sourceId: z.uuid().transform((id) => id.toLowerCase()),
    targetId: z.uuid().transform((id) => id.toLowerCase()),
    type: z.enum(['blocks', 'relates_to']),
  })
  .refine(
    (input) => input.sourceId !== input.targetId,
    'A relationship cannot link an item to itself',
  );

export type CreateWorkItemRelationshipInput = z.infer<
  typeof createWorkItemRelationshipSchema
>;
