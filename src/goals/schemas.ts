import { z } from 'zod';

const text = z.string().trim().min(1);
export const goalStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'cancelled',
]);

export const createGoalSchema = z.strictObject({
  title: text.max(200),
  objective: text.max(10000),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z
  .strictObject({
    title: text.max(200).optional(),
    objective: text.max(10000).optional(),
    status: goalStatusSchema.optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Provide at least one field',
  );

export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

export const createGoalRelationshipSchema = z
  .strictObject({
    sourceId: z.uuid().transform((id) => id.toLowerCase()),
    targetId: z.uuid().transform((id) => id.toLowerCase()),
    type: z.enum(['contributes_to', 'relates_to']),
  })
  .refine(
    (input) => input.sourceId !== input.targetId,
    'A relationship cannot link an item to itself',
  );

export type CreateGoalRelationshipInput = z.infer<
  typeof createGoalRelationshipSchema
>;
