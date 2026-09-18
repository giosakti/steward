# Decision Kernel foundation

This increment adds internal decision evaluation and evidence storage. It does
not add a user workflow or HTTP endpoints. No action policy is registered, and
root-agent configuration is not evaluated by the kernel. Existing configuration
commands remain explicit human-operator operations.

## Relationship to Work Items and Runs

A Work Item describes work to accomplish; a Run is an attempt to execute it.
The kernel evaluates specific consequential actions associated with that work,
rather than assigning one general score to an entire Run.

For the self-building workflow, later increments will connect decisions to:

- Starting a bounded execution attempt for a Work Item.
- Proposed consequential actions within that attempt.
- Verification of actual results against the Work Item and validation evidence.
- Applying an exact reviewed result, with current state and required approval.

Those policies need authoritative Work Item, Run, repository, validation, and
review records. They will be implemented alongside those capabilities. This
foundation does not substitute agent configuration for that workflow.

## What is implemented

- Workspace-scoped, append-only Action Intent and Decision records.
- An internal evaluation function that accepts prepared context, deterministic
  checks, and an explicit action policy from trusted application code.
- `ALLOW`, `DENY`, and `ESCALATE` composition with deterministic denial taking
  precedence. Missing policy, context, or checks prevents `ALLOW` and skips Jev.
- The official TypeSafe SDK adapter for batched Choice questions, with a
  30-second timeout and no automatic retries.
- Durable request evidence before the external call, followed by an atomic
  decision and outcome-event write.

A proposal contains the requested action, objective, rationale, intended scope,
optional target, expected effect, and claimed risk class. Proposal claims are
kept separate from context facts. A claimed target is not an authoritative target.

A prepared policy names its action type and risk class, its version, and each
required semantic predicate's question, accepted and denied choices, and minimum
probability. The proposal must match the policy's action type and risk class.
There are no default semantic questions or production probability thresholds.

Every required predicate must meet its policy's acceptance threshold for `ALLOW`.
An established conflicting choice yields `DENY`; remaining uncertainty escalates.
Incomplete or malformed distributions cannot authorize anything. Model confidence
is recorded separately and does not stand for a probability of safe execution.

## Evidence and failure behavior

Each Decision preserves the supplied context and source references, deterministic
checks, full policy definition, exact Jev request, JSON response, assessments,
thresholds, and outcome reason. The returned model identifier and usage are
preserved. Tests can replay policy composition from the stored evidence.

The kernel records `DECISION_REQUESTED` before contacting Jev. Missing credentials
or service failures produce `ESCALATE` with `JEV_UNAVAILABLE`; invalid returned
answers produce `ESCALATE` with `INVALID_RESPONSE`. Raw SDK errors are not stored
because they can contain credentials.

If the process stops mid-evaluation or the final transaction fails, the request
event remains without a completed decision. That is an incomplete attempt, never
permission to act. A later evaluation retains the earlier evidence.

## Integration boundary and remaining work

The internal preparation argument is not an external API contract. Neither agents
nor HTTP clients may supply policies, deterministic verdicts, or authoritative
context. Concrete orchestration must retrieve facts and choose policy itself.
Do not expose this internal function directly as an HTTP or MCP endpoint.

No production context resolver, Work Item/Run linkage, state fingerprint,
commit-time revalidation, authorization credential, or executor is implemented
here. The relevant foreign keys and action-specific state checks will accompany
the actual models. A recorded `ALLOW` alone is not executable authority and must
not be reused after the evaluated state changes.

The first real integration will connect a Work Item and Run to a bounded coding
action. It must establish the authoritative target and scope, select policy,
verify state before execution, preserve actual results, and keep human approval
separate from application. Root-agent reasoning, wakeups, and agent authentication
remain later increments; the operator token must not become an agent credential.

Tests use synthetic Work Item evidence and test-only policies to verify these
mechanics. They do not establish semantic accuracy or calibrated thresholds.
There is no server configuration or live Jev call to exercise through the product
yet; the adapter receives its credential from its future trusted caller.
