import type {
  ActionProposal,
  DecisionPolicy,
  PreparedDecision,
} from '../src/decisions/schemas.js';

// Synthetic Work Item evidence for testing kernel mechanics. These are not
// registered application policies, production thresholds, or persisted Work Items.
export function proposal(): ActionProposal {
  return {
    type: 'modify_code',
    objective: 'Add a decision report',
    rationale: 'Make recorded blockers inspectable',
    intendedScope:
      'src/reports/decision-report.ts and its tests in the isolated worktree',
    intendedTarget: 'fixture-worktree',
    expectedEffect:
      'A report displays recorded blockers without changing authorization',
    riskLabels: ['LOCAL_REVERSIBLE'],
  };
}

export function policy(): DecisionPolicy {
  return {
    version: 'test-only-v1',
    actionType: 'modify_code',
    riskLabels: ['LOCAL_REVERSIBLE'],
    predicates: {
      action_satisfies_work_item: {
        question: {
          type: 'choice',
          instructions:
            'Does the proposed change satisfy the supplied Work Item?',
          criteria: {
            MATCHES: 'Meets the Work Item',
            CONTRADICTS: 'Contradicts the Work Item',
            UNCLEAR: 'Evidence is insufficient',
          },
        },
        acceptedChoice: 'MATCHES',
        deniedChoices: ['CONTRADICTS'],
        minimumProbability: 0.9,
      },
      scope_is_minimal: {
        question: {
          type: 'choice',
          instructions: 'Is every proposed change necessary for the Work Item?',
          criteria: {
            BOUNDED: 'Every change is necessary',
            EXCESSIVE: 'Includes unrelated changes',
            UNCLEAR: 'Evidence is insufficient',
          },
        },
        acceptedChoice: 'BOUNDED',
        deniedChoices: ['EXCESSIVE'],
        minimumProbability: 0.9,
      },
    },
  };
}

export function preparation(): PreparedDecision {
  return {
    policy: policy(),
    context: {
      facts: {
        workItem: {
          id: 'fixture-work-item',
          objective: 'Add a read-only decision report',
        },
        target: 'fixture-worktree',
      },
      sources: ['test-fixture:work-item', 'test-fixture:worktree'],
    },
    checks: [
      {
        name: 'isolated_target',
        passed: true,
        evidence: 'Synthetic isolated worktree fixture',
      },
    ],
  };
}

export function response() {
  return {
    model: 'jev-test',
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      action_satisfies_work_item: {
        type: 'choice',
        choice: 'MATCHES',
        confidence: 0.98,
        probabilities: { MATCHES: 0.98, CONTRADICTS: 0.01, UNCLEAR: 0.01 },
      },
      scope_is_minimal: {
        type: 'choice',
        choice: 'BOUNDED',
        confidence: 0.98,
        probabilities: { BOUNDED: 0.98, EXCESSIVE: 0.01, UNCLEAR: 0.01 },
      },
    },
  };
}
