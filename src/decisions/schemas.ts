import { z } from 'zod';

export const riskLabelSchema = z.enum([
  'READ_ONLY',
  'LOCAL_REVERSIBLE',
  'EXTERNAL_REVERSIBLE',
  'DESTRUCTIVE',
  'IRREVERSIBLE',
  'SECURITY_SENSITIVE',
]);

// JSON stores a set as an array. Reject duplicates; ordering has no meaning.
export const riskLabelsSchema = z
  .array(riskLabelSchema)
  .min(1)
  .refine(
    (labels) => new Set(labels).size === labels.length,
    'Risk labels must be unique',
  )
  .refine((labels) => {
    const mutation = labels.some(
      (label) =>
        label === 'LOCAL_REVERSIBLE' ||
        label === 'EXTERNAL_REVERSIBLE' ||
        label === 'DESTRUCTIVE' ||
        label === 'IRREVERSIBLE',
    );
    return !labels.includes('READ_ONLY') || !mutation;
  }, 'READ_ONLY cannot be combined with mutation labels')
  .refine(
    (labels) =>
      !labels.includes('IRREVERSIBLE') ||
      (!labels.includes('LOCAL_REVERSIBLE') &&
        !labels.includes('EXTERNAL_REVERSIBLE')),
    'IRREVERSIBLE cannot be combined with reversible labels',
  );

const text = z.string().trim().min(1);
const probability = z.number().min(0).max(1);

// Claims in a proposal are inputs to evaluation, never authoritative facts.
export const actionProposalSchema = z.strictObject({
  type: text.max(100),
  objective: text.max(4000),
  rationale: text.max(4000),
  intendedScope: text.max(4000),
  intendedTarget: text.max(4000).optional(),
  expectedEffect: text.max(4000),
  riskLabels: riskLabelsSchema,
});

export const deterministicCheckSchema = z.strictObject({
  name: text,
  passed: z.boolean(),
  evidence: text,
});

export const decisionContextSchema = z.strictObject({
  facts: z
    .record(z.string(), z.json())
    .refine((facts) => Object.keys(facts).length > 0, 'Context requires facts'),
  sources: z.array(text).min(1),
});

const semanticPredicateSchema = z
  .strictObject({
    question: z.strictObject({
      type: z.literal('choice'),
      instructions: text,
      criteria: z
        .record(text, text)
        .refine(
          (criteria) => Object.keys(criteria).length >= 2,
          'Choice requires alternatives',
        ),
    }),
    acceptedChoice: text,
    deniedChoices: z.array(text),
    minimumProbability: probability.gt(0),
  })
  .refine((predicate) => {
    const labels = Object.keys(predicate.question.criteria);
    return (
      labels.includes(predicate.acceptedChoice) &&
      predicate.deniedChoices.every(
        (label) => labels.includes(label) && label !== predicate.acceptedChoice,
      )
    );
  }, 'Policy choices must belong to the question and have distinct verdicts');

// Supplied by trusted application code, never an agent or HTTP request.
// No action policy is registered by this foundation PR.
export const decisionPolicySchema = z.strictObject({
  version: text,
  actionType: text,
  riskLabels: riskLabelsSchema,
  predicates: z
    .record(text, semanticPredicateSchema)
    .refine(
      (predicates) => Object.keys(predicates).length > 0,
      'Policy requires semantic predicates',
    ),
});

export const decisionPreparationSchema = z.strictObject({
  context: decisionContextSchema.nullable(),
  checks: z.array(deterministicCheckSchema),
  policy: decisionPolicySchema.nullable(),
});

export type ActionProposal = z.infer<typeof actionProposalSchema>;
export type DecisionPolicy = z.infer<typeof decisionPolicySchema>;
export type PreparedDecision = z.infer<typeof decisionPreparationSchema>;
