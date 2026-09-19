# Decision Kernel

The Decision Kernel evaluates whether a proposed action satisfies Steward's
constraints and semantic policy. It combines authoritative facts, deterministic
checks, and Jev judgments to produce a recorded `ALLOW`, `DENY`, or `ESCALATE`
decision. A reasoning model can propose an action, but cannot authorize it.

## Work Items, Runs, and Action Intents

A **Work Item** describes an outcome to accomplish. A **Run** is one attempt to
accomplish it. An **Action Intent** describes a proposed consequential action:
its objective, rationale, scope, optional target, expected effect, and claimed
risk labels. A **Decision** records an evaluation of that intent.

For example, consider a Work Item to add a readable decision report. A coding
workflow could create a Run and progressively propose actions to prepare an
isolated worktree, implement the report, validate the result, and apply the exact
reviewed change. Each action is evaluated when its required evidence is available.
The application proposal can only be concrete once the actual changes exist.

One intent can have several decisions as new evidence becomes available. Earlier
decisions remain preserved. Changing the proposal itself creates a new intent.

Permission to attempt an action does not certify its result: an allowed test run
can fail, and authorized coding can produce incorrect code. Verification and
permission to apply a reviewed result are separate from permission to start work.

## Evaluation flow

```text
Action Intent + authoritative context + action policy
                         ↓
                Deterministic checks
                         ↓
                  Jev judgments
                         ↓
              Record decision and evidence
```

Trusted application code retrieves facts and selects the policy. Proposal claims
stay separate from those facts; a target named by a model must be independently
resolved. Agents and HTTP clients must not supply authoritative context,
deterministic verdicts, or policy definitions.

Deterministic checks establish mechanically verifiable conditions, such as a
target belonging to the permitted workspace. A failed check yields `DENY` without
calling Jev. Missing context, policy, or checks yields `ESCALATE`. The proposal's
action type and risk labels must match the selected policy. Labels are compared
as a set, independent of their order. Trusted policy code must establish all
applicable risks and include their safeguards; a proposal cannot omit a label
to reduce requirements.

Risk labels are controlled values, not free-form tags. For example, an action
can be both `DESTRUCTIVE` and `SECURITY_SENSITIVE`. Sets must be nonempty and
contain no duplicates. `READ_ONLY` conflicts with mutation labels, and
`IRREVERSIBLE` conflicts with either reversible label. `READ_ONLY` may coexist
with `SECURITY_SENSITIVE`, such as reading protected data.

Jev answers narrow semantic questions, such as whether a proposed change satisfies
a Work Item or exceeds its scope. Each policy specifies its version, required
questions, answer choices, accepted and denied choices, and probability thresholds.
Independent questions are sent together in one request.

| Verdict    | Meaning                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW`    | All supplied deterministic checks and required semantic acceptance conditions passed.                                     |
| `DENY`     | A deterministic constraint failed, the action or risk labels mismatched policy, or a semantic conflict met its threshold. |
| `ESCALATE` | Required evidence or evaluation is unavailable, or semantic results are uncertain.                                        |

Deterministic denial takes precedence over semantic judgment. Jev's reported
confidence is preserved, but is not itself the probability that execution is safe.
Thresholds belong to concrete action policies and need validation against outcomes.

## Evidence and failures

Action Intents and Decisions are workspace-scoped and append-only. A Decision
preserves context and source references, deterministic checks, the full policy,
the exact Jev request, JSON response, model identifier, token usage, assessments,
thresholds, and verdict reason. This allows policy composition to be reconstructed
from recorded evidence.

`DECISION_REQUESTED` is recorded before contacting Jev. The final decision and its
verdict event are committed in one transaction. If evaluation is interrupted or
that transaction fails, the request remains as evidence of an incomplete attempt;
it cannot imply permission to act.

Missing credentials or service failures escalate with `JEV_UNAVAILABLE`. Invalid
answers escalate with `INVALID_RESPONSE`. Raw SDK errors are excluded from stored
evidence because they can contain credentials. The TypeSafe adapter uses a
30-second timeout and no automatic retries; another evaluation is explicit and
retains the earlier evidence.

## Current implementation

Internal evaluation, the Jev adapter, and proposal/decision persistence are
implemented. There are no decision HTTP endpoints or registered action policies.
Tests use synthetic Work Item evidence and test-only policies; they do not establish
semantic accuracy or calibrated thresholds.

Work Item and Run models, their decision relationships, authoritative context
resolvers, and execution integration are still to be built. Before execution is
connected, authorization must be bound to the action, target, evaluated state,
and lifetime, with state revalidated immediately before execution. A stored
`ALLOW` alone is not an execution credential. Human approval and application will
remain separate operations.
