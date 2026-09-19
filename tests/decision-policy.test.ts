import { describe, expect, it } from 'vitest';

import {
  assessResponse,
  checkPrerequisites,
  evaluationRequest,
} from '../src/decisions/policy.js';
import {
  actionProposalSchema,
  riskLabelsSchema,
  decisionPolicySchema,
  decisionPreparationSchema,
} from '../src/decisions/schemas.js';
import {
  policy,
  preparation,
  proposal,
  response,
} from './decision-fixtures.js';

describe('decision policy composition', () => {
  it('requires every predicate to meet its own policy threshold', () => {
    const rules = policy();
    const raw = response();
    expect(assessResponse(raw, rules).verdict).toBe('ALLOW');
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: 0.9,
      EXCESSIVE: 0.05,
      UNCLEAR: 0.05,
    };
    expect(assessResponse(raw, rules).verdict).toBe('ALLOW');
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: 0.899,
      EXCESSIVE: 0.051,
      UNCLEAR: 0.05,
    };
    expect(assessResponse(raw, rules).verdict).toBe('ESCALATE');
    rules.predicates.scope_is_minimal!.minimumProbability = 0.95;
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: 0.94,
      EXCESSIVE: 0.03,
      UNCLEAR: 0.03,
    };
    expect(assessResponse(raw, rules).verdict).toBe('ESCALATE');
  });

  it('denies established conflicts and escalates uncertainty regardless of confidence', () => {
    const raw = response();
    raw.answers.scope_is_minimal.choice = 'EXCESSIVE';
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: 0.01,
      EXCESSIVE: 0.98,
      UNCLEAR: 0.01,
    };
    expect(assessResponse(raw, policy()).verdict).toBe('DENY');
    raw.answers.scope_is_minimal.choice = 'UNCLEAR';
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: 0.01,
      EXCESSIVE: 0.01,
      UNCLEAR: 0.98,
    };
    expect(assessResponse(raw, policy()).verdict).toBe('ESCALATE');
  });

  it.each([
    null,
    {},
    { ...response(), answers: {} },
    {
      ...response(),
      answers: {
        ...response().answers,
        extra: response().answers.scope_is_minimal,
      },
    },
    ...[
      { choice: 'INVENTED' },
      { type: 'score' },
      { confidence: 2 },
      { probabilities: { MATCHES: 1 } },
      { probabilities: { MATCHES: 0.8, CONTRADICTS: 0.8, UNCLEAR: 0 } },
      { probabilities: { MATCHES: -0.1, CONTRADICTS: 0.9, UNCLEAR: 0.2 } },
      { choice: 'CONTRADICTS' },
    ].map((patch) => ({
      ...response(),
      answers: {
        ...response().answers,
        action_satisfies_work_item: {
          ...response().answers.action_satisfies_work_item,
          ...patch,
        },
      },
    })),
  ])('rejects malformed or incomplete external answers (%#)', (raw) => {
    expect(() => assessResponse(raw, policy())).toThrow();
  });

  it('requires a nonempty, internally consistent policy and source-backed context', () => {
    expect(() =>
      assessResponse(
        { ...response(), answers: {} },
        { ...policy(), predicates: {} },
      ),
    ).toThrow();
    for (const patch of [
      { acceptedChoice: 'INVENTED' },
      { deniedChoices: ['MATCHES'] },
      { minimumProbability: 0 },
      { minimumProbability: 2 },
    ]) {
      const rules = policy();
      Object.assign(rules.predicates.action_satisfies_work_item!, patch);
      expect(() => decisionPolicySchema.parse(rules)).toThrow();
    }
    expect(() =>
      decisionPreparationSchema.parse({
        ...preparation(),
        context: { facts: {}, sources: [] },
      }),
    ).toThrow();
  });

  it('keeps deterministic denial above absent context and checks action/risk policy binding', () => {
    const prepared = preparation();
    expect(checkPrerequisites(proposal(), prepared)).toBeNull();
    expect(
      checkPrerequisites({ ...proposal(), type: 'deploy' }, prepared)?.verdict,
    ).toBe('DENY');
    expect(
      checkPrerequisites({ ...proposal(), riskLabels: ['READ_ONLY'] }, prepared)
        ?.verdict,
    ).toBe('DENY');
    for (const patch of [{ context: null }, { policy: null }, { checks: [] }]) {
      expect(
        checkPrerequisites(proposal(), { ...prepared, ...patch })?.verdict,
      ).toBe('ESCALATE');
    }
    expect(
      checkPrerequisites(proposal(), {
        ...prepared,
        context: null,
        policy: null,
        checks: [{ name: 'scope', passed: false, evidence: 'Wrong workspace' }],
      })?.verdict,
    ).toBe('DENY');
  });

  it('keeps proposal claims distinct from supplied facts and batches policy questions', () => {
    const prepared = preparation();
    const request = evaluationRequest(proposal(), prepared);
    expect(request.state).toEqual({
      proposal: proposal(),
      context: prepared.context,
    });
    expect(Object.keys(request.questions)).toEqual([
      'action_satisfies_work_item',
      'scope_is_minimal',
    ]);
  });
});

describe('risk label sets', () => {
  it.each([
    ['DESTRUCTIVE', 'SECURITY_SENSITIVE'],
    ['READ_ONLY', 'SECURITY_SENSITIVE'],
    ['LOCAL_REVERSIBLE', 'EXTERNAL_REVERSIBLE'],
  ])('accepts compatible labels: %j', (...labels) => {
    expect(riskLabelsSchema.parse(labels)).toEqual(labels);
  });

  it.each([
    [],
    ['UNKNOWN'],
    ['DESTRUCTIVE', 'DESTRUCTIVE'],
    ['READ_ONLY', 'DESTRUCTIVE'],
    ['READ_ONLY', 'IRREVERSIBLE'],
    ['READ_ONLY', 'LOCAL_REVERSIBLE'],
    ['READ_ONLY', 'EXTERNAL_REVERSIBLE'],
    ['IRREVERSIBLE', 'LOCAL_REVERSIBLE'],
    ['IRREVERSIBLE', 'EXTERNAL_REVERSIBLE'],
  ])('rejects invalid label sets (%#)', (...labels) => {
    expect(() => riskLabelsSchema.parse(labels)).toThrow();
  });

  it('matches order-independent sets and denies omitted or extra risks', () => {
    const prepared = preparation();
    prepared.policy!.riskLabels = ['DESTRUCTIVE', 'SECURITY_SENSITIVE'];
    const proposed = {
      ...proposal(),
      riskLabels: ['SECURITY_SENSITIVE', 'DESTRUCTIVE'] as (
        'SECURITY_SENSITIVE' | 'DESTRUCTIVE'
      )[],
    };
    expect(checkPrerequisites(proposed, prepared)).toBeNull();
    expect(
      checkPrerequisites({ ...proposed, riskLabels: ['DESTRUCTIVE'] }, prepared)
        ?.verdict,
    ).toBe('DENY');
    expect(
      checkPrerequisites(
        {
          ...proposed,
          riskLabels: ['DESTRUCTIVE', 'SECURITY_SENSITIVE', 'IRREVERSIBLE'],
        },
        prepared,
      )?.verdict,
    ).toBe('DENY');
  });

  it('requires riskLabels on proposals and policies rather than the old scalar field', () => {
    const proposed = { ...proposal(), riskLabels: undefined };
    const rules = { ...policy(), riskLabels: undefined };
    expect(() =>
      actionProposalSchema.parse({
        ...proposed,
        riskClass: 'LOCAL_REVERSIBLE',
      }),
    ).toThrow();
    expect(() =>
      decisionPolicySchema.parse({ ...rules, riskClass: 'LOCAL_REVERSIBLE' }),
    ).toThrow();
    expect(() =>
      decisionPolicySchema.parse({
        ...rules,
        riskLabels: ['READ_ONLY', 'DESTRUCTIVE'],
      }),
    ).toThrow();
  });
});
