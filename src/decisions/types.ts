import type { Generated, JSONColumnType, Selectable } from 'kysely';
import type { JsonValue, SystemOneRequestPayload } from '@typesafe-ai/sdk';

import type { OperatorActor } from '../audit/actor.js';
import type { ActionProposal } from './schemas.js';

export type Outcome = 'ALLOW' | 'DENY' | 'ESCALATE';

export interface Check {
  name: string;
  passed: boolean;
  evidence: string;
}

export type DecisionContext = {
  workspace: {
    id: string;
    name: string;
    description: string | null;
    rootAgentId: string;
    updatedAt: string;
    archivedAt: string | null;
  };
  agent: {
    id: string;
    name: string;
    title: string;
    roleDescription: string | null;
    updatedAt: string;
  };
  provenance: { workspace: string; agent: string };
};

export interface Assessment {
  predicate: string;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  accepted: boolean;
  minimumProbability: number;
}

export interface DecisionEvidence {
  context: DecisionContext;
  recheckedContext: DecisionContext | null;
  stateFingerprint: string;
  checks: Check[];
  request: SystemOneRequestPayload | null;
  response: JsonValue;
  evaluationError: string | null;
  assessments: Assessment[];
  reason: string;
}

export interface ActionIntentTable {
  id: string;
  workspace_id: string;
  proposal: JSONColumnType<ActionProposal>;
  proposed_by: JSONColumnType<OperatorActor>;
  created_at: Generated<Date>;
}

export interface DecisionTable {
  id: string;
  workspace_id: string;
  action_intent_id: string;
  outcome: Outcome;
  policy_version: string;
  evidence: JSONColumnType<DecisionEvidence>;
  created_at: Generated<Date>;
}

export type ActionIntent = Selectable<ActionIntentTable>;
export type Decision = Selectable<DecisionTable>;
