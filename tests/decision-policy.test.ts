import { describe, expect, it } from 'vitest';

import { assessResponse, minimumProbability } from '../src/decisions/policy.js';
import { response } from './decision-fixtures.js';

describe('semantic decision policy', () => {
  it('allows only when all independent predicates meet the probability threshold', () => {
    expect(assessResponse(response()).outcome).toBe('ALLOW');
    const raw = response();
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: minimumProbability,
      EXCESSIVE: 0.05,
      UNCLEAR: 0.05,
    };
    expect(assessResponse(raw).outcome).toBe('ALLOW');
    raw.answers.scope_is_minimal.probabilities = {
      BOUNDED: 0.899,
      EXCESSIVE: 0.051,
      UNCLEAR: 0.05,
    };
    expect(assessResponse(raw).outcome).toBe('ESCALATE');
  });

  it('denies established conflicts and escalates ambiguity even when confidence is high', () => {
    const raw = response();
    raw.answers.authority_is_preserved.choice = 'EXPANDED';
    raw.answers.authority_is_preserved.probabilities = {
      PRESERVED: 0.01,
      EXPANDED: 0.98,
      UNCLEAR: 0.01,
    };
    expect(assessResponse(raw).outcome).toBe('DENY');
    raw.answers.authority_is_preserved.choice = 'UNCLEAR';
    raw.answers.authority_is_preserved.probabilities = {
      PRESERVED: 0.01,
      EXPANDED: 0.01,
      UNCLEAR: 0.98,
    };
    expect(assessResponse(raw).outcome).toBe('ESCALATE');
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
        effect_matches_objective: {
          ...response().answers.effect_matches_objective,
          ...patch,
        },
      },
    })),
  ])('rejects malformed or incomplete external answers (%#)', (raw) => {
    expect(() => assessResponse(raw)).toThrow();
  });
});
