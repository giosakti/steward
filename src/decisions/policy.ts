import type { SystemOneRequestPayload } from '@typesafe-ai/sdk';
import { z } from 'zod';

import {
  decisionPolicySchema,
  type ActionProposal,
  type DecisionPolicy,
  type PreparedDecision,
} from './schemas.js';
import type { DecisionEvaluation, SemanticAssessment } from './types.js';

export function assessResponse(
  raw: unknown,
  input: DecisionPolicy,
): DecisionEvaluation {
  const policy = decisionPolicySchema.parse(input);
  const response = responseSchema.parse(raw);
  if (
    Object.keys(response.answers).length !==
    Object.keys(policy.predicates).length
  ) {
    throw new Error('Unexpected answer set');
  }
  const assessments = Object.entries(policy.predicates).map(
    ([predicate, rule]) =>
      assessPredicate(predicate, rule, response.answers[predicate]),
  );
  if (
    assessments.some(
      (item) =>
        item.deniedChoices.includes(item.choice) &&
        item.probabilities[item.choice]! >= item.minimumProbability,
    )
  ) {
    return {
      verdict: 'DENY',
      assessments,
      reason: 'Semantic conflict established',
    };
  }
  if (assessments.every((item) => item.accepted)) {
    return {
      verdict: 'ALLOW',
      assessments,
      reason:
        'Supplied checks and semantic predicates passed; no execution authorization issued',
    };
  }
  return {
    verdict: 'ESCALATE',
    assessments,
    reason: 'Semantic evidence is uncertain or insufficient',
  };
}

export function checkPrerequisites(
  proposal: ActionProposal,
  prepared: PreparedDecision,
): DecisionEvaluation | null {
  if (prepared.checks.some((check) => !check.passed)) {
    return {
      verdict: 'DENY',
      assessments: [],
      reason: 'Deterministic check failed',
    };
  }
  if (!prepared.policy || !prepared.context || prepared.checks.length === 0) {
    return {
      verdict: 'ESCALATE',
      assessments: [],
      reason:
        'Action policy, authoritative context, or deterministic checks unavailable',
    };
  }
  if (
    prepared.policy.actionType !== proposal.type ||
    prepared.policy.riskLabels.length !== proposal.riskLabels.length ||
    prepared.policy.riskLabels.some(
      (label) => !proposal.riskLabels.includes(label),
    )
  ) {
    return {
      verdict: 'DENY',
      assessments: [],
      reason: 'Proposal action or risk labels do not match the trusted policy',
    };
  }
  return null;
}

export function evaluationRequest(
  proposal: ActionProposal,
  prepared: PreparedDecision,
): SystemOneRequestPayload {
  if (!prepared.policy || !prepared.context) {
    throw new Error('Evaluation requires policy and context');
  }
  return {
    model: 'jev-latest',
    state: {
      proposal: z.record(z.string(), z.json()).parse(proposal),
      context: prepared.context,
    },
    questions: Object.fromEntries(
      Object.entries(prepared.policy.predicates).map(([name, predicate]) => [
        name,
        predicate.question,
      ]),
    ),
  };
}

function assessPredicate(
  predicate: string,
  rule: DecisionPolicy['predicates'][string],
  answer: z.infer<typeof answerSchema> | undefined,
): SemanticAssessment {
  const labels = Object.keys(rule.question.criteria);
  if (
    !answer ||
    !labels.includes(answer.choice) ||
    Object.keys(answer.probabilities).length !== labels.length ||
    labels.some((label) => answer.probabilities[label] === undefined)
  ) {
    throw new Error('Missing or unexpected answer options');
  }
  const values = Object.values(answer.probabilities);
  if (
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001 ||
    answer.probabilities[answer.choice] !== Math.max(...values)
  ) {
    throw new Error('Invalid probability distribution');
  }
  return {
    predicate,
    ...answer,
    acceptedChoice: rule.acceptedChoice,
    deniedChoices: rule.deniedChoices,
    minimumProbability: rule.minimumProbability,
    accepted:
      answer.choice === rule.acceptedChoice &&
      answer.probabilities[answer.choice]! >= rule.minimumProbability,
  };
}

const probability = z.number().min(0).max(1);
const answerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
});
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
