# Decision evaluation

The first Decision Kernel slice evaluates proposed root-agent configuration
changes. It records `ALLOW`, `DENY`, or `ESCALATE` and the evidence behind the
outcome. **Evaluation never changes the agent and issues no execution credential.**
Existing workspace configuration commands remain explicit human-operator actions.
Agent authentication and execution are not exposed yet.

## Configuration

Set `TYPESAFE_API_KEY` in the server's `.env`, then rebuild and restart the server.
The CLI does not need this key. Without it, valid evaluation requests are recorded
as `ESCALATE`; workspace management continues to work.

The official `@typesafe-ai/sdk` calls `jev-latest` with all predicates in one
request, a 30-second timeout, and no automatic retries. A new evaluation must be
requested explicitly. The returned model identifier and token usage are preserved.

## API flow

All routes require the existing human-operator bearer token. Use workspace UUIDs.

1. `POST /api/v1/workspaces/:workspaceId/action-intents` records a proposal.
2. `GET /api/v1/workspaces/:workspaceId/action-intents/:id` retrieves it.
3. `POST /api/v1/workspaces/:workspaceId/action-intents/:id/decisions` with `{}`
   evaluates it against freshly retrieved state.
4. `GET /api/v1/workspaces/:workspaceId/decisions/:id` retrieves the decision.

Both POST operations return `201` and a `Location` header. Input errors return
`400`; missing or cross-workspace records return `404`. A recorded `DENY` or
`ESCALATE` is a successful evaluation response, not an HTTP error.

Example proposal (replace the UUID placeholders):

```json
{
  "type": "configure_agent",
  "objective": "Set the root agent display title to Engineering Lead",
  "rationale": "Make the displayed responsibility clear",
  "intendedScope": "<workspace UUID>",
  "intendedTarget": "<root agent UUID>",
  "expectedEffect": "The agent title becomes Engineering Lead",
  "riskClass": "LOCAL_REVERSIBLE",
  "parameters": { "title": "Engineering Lead" }
}
```

`parameters` accepts the existing agent configuration fields. Caller identity,
context snapshots, policy, thresholds, and outcomes cannot be supplied by clients.
The submission identity is recorded from the authenticated HTTP entry point.

## Policy and evidence

The context resolver joins the workspace to its actual root agent in PostgreSQL.
It does not fetch a target merely because the proposal names it. Each snapshot
contains record references and a fingerprint.

Deterministic checks require an active workspace, matching scope and root-agent
UUID, the supported `configure_agent` action, and its policy-defined
`LOCAL_REVERSIBLE` risk class. Unsupported actions and risk mismatches are denied
without calling Jev. Other risk classes are represented but have no action policy
or execution support in this increment.

Jev assesses three independent questions:

- Do the proposed field changes implement the stated objective and effect?
- Is each proposed change necessary for that objective?
- Does the proposal preserve the distinction between agent description and authority?

Each question includes an explicit uncertain answer. Policy requires the accepted
choice to have probability at least `0.9` for every predicate. A conflicting choice
at that threshold yields `DENY`; other valid distributions yield `ESCALATE`.
Malformed or missing answers and service failures also escalate. Confidence is
recorded but is not treated as a probability of safe execution.

**The threshold is provisional and uncalibrated.** This slice establishes evidence
collection and policy mechanics, not demonstrated safety for autonomous changes.
It evaluates the proposal's internal consistency against workspace state; it does
not claim alignment with missions, work items, or canonical knowledge, which do
not exist yet. Those capabilities require subsequent policy revisions.

The kernel records `DECISION_REQUESTED` before contacting Jev. Before storing the
outcome, it reloads and locks the relevant database rows in a short transaction.
Changed state prevents `ALLOW`. Decisions preserve the snapshot, exact Jev request,
JSON response, assessments, thresholds, policy version, checks, and failure status.
Proposals and decisions are append-only; the outcome event and decision commit
atomically. Raw SDK errors are not persisted because they can contain credentials.

If the process stops mid-evaluation or the final transaction fails, the request
event remains without a completed decision. That is an incomplete attempt, never
permission to act. A later evaluation creates a new decision and retains history.
A stored `ALLOW` describes that snapshot; it is not reusable authorization after
state changes.

State-bound expiring authorizations, commit-time revalidation, executors, human
approval/application, and knowledge-aware policy are subsequent increments.
