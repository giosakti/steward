import type { Generated, JSONColumnType, Selectable } from 'kysely';
import type { JsonValue, SystemOneRequestPayload } from '@typesafe-ai/sdk';

import type { OperatorActor } from '../audit/actor.js';
import type { ActionProposal, PreparedDecision } from './schemas.js';

export type Verdict = 'ALLOW' | 'DENY' | 'ESCALATE';

export interface Assessment {
  predicate: string;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  accepted: boolean;
  acceptedChoice: string;
  deniedChoices: string[];
  minimumProbability: number;
}

export interface Evaluation {
  verdict: Verdict;
  assessments: Assessment[];
  reason: string;
}

export interface DecisionEvidence extends PreparedDecision {
  request: SystemOneRequestPayload | null;
  response: JsonValue;
  evaluationError: 'JEV_UNAVAILABLE' | 'INVALID_RESPONSE' | null;
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
  verdict: Verdict;
  policy_version: string;
  evidence: JSONColumnType<DecisionEvidence>;
  created_at: Generated<Date>;
}

export type ActionIntent = Selectable<ActionIntentTable>;
export type Decision = Selectable<DecisionTable>;
