import type { ActionProposal } from '../src/decisions/schemas.js';

export function proposal(workspace: {
  id: string;
  root_agent_id: string;
}): ActionProposal {
  return {
    type: 'configure_agent',
    objective: 'Set the root agent display title to Engineering Lead',
    rationale: 'Make the displayed responsibility clear',
    intendedScope: workspace.id,
    intendedTarget: workspace.root_agent_id,
    expectedEffect: 'The agent title becomes Engineering Lead',
    riskClass: 'LOCAL_REVERSIBLE',
    parameters: { title: 'Engineering Lead' },
  };
}

export function response() {
  return {
    model: 'jev-test',
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      effect_matches_objective: {
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
      authority_is_preserved: {
        type: 'choice',
        choice: 'PRESERVED',
        confidence: 0.98,
        probabilities: { PRESERVED: 0.98, EXPANDED: 0.01, UNCLEAR: 0.01 },
      },
    },
  };
}
