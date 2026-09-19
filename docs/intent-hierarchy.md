# Missions, Goals, and Work Items

A workspace has one current **Mission**: its overarching purpose. A **Goal** is
an outcome, and a **Work Item** is concrete work intended to advance a Goal.

For example:

```text
Mission: Build a useful self-improving Steward
└── Goal: Complete a reviewed self-hosted improvement
    └── Work Item: Implement isolated Git worktree execution
        Acceptance: The base checkout remains unchanged
```

Goals belong to the workspace, not to a particular mission revision. Setting a
new mission retains its ID and records the previous statement in the audit log.
Goals can be created before a mission is set.

## Relationships

Every Work Item requires a Goal. Goals may have a parent Goal; Work Items may
have a parent Work Item. All references must belong to the same workspace.
A child Work Item may advance a different Goal from its parent within that
workspace, allowing work to be divided across subgoals.

Parent links and a Work Item's Goal are fixed at creation in this slice. New
records can reference only existing parents, so the API cannot create cycles.
Reparenting, moving work between goals, and deletion are not exposed yet.

## Operator workflow

Use the authenticated [HTTP API](http-api.md#intent-hierarchy) to set a mission,
create goals, and create work with explicit acceptance criteria. These endpoints
accept direct human-operator instructions. They are not agent capabilities:
agents will need a separate Decision Kernel authorization path.

Goals start `active`; the operator can set `active`, `paused`, `completed`, or
`cancelled`. Status changes do not cascade to children or infer completion from
their statuses.

Work Items start `proposed`, with priority `0`. Larger priority values sort first.
The operator can change a Work Item's title, objective, acceptance criteria,
priority, and planning status: `proposed`, `ready`, `blocked`, `completed`, or
`rejected`. Completion here records an operator's judgment; it does not certify
execution, tests, review approval, or application of code.

`running` and `needs_review` are reserved for Run orchestration. The operator API
cannot set these statuses or edit work already in either state. Marking work
`ready` does not start a Run or authorize execution. No scheduler or executor is
connected by this slice.

## Evidence

Mutations and their audit events commit in one transaction. Events identify the
operator and request and preserve the resulting record. Update events also
preserve the previous record. A Work Item's `created_by` is derived from the
trusted operator context, never supplied in the request body.

This provides durable intent for the next execution slice. Linking Runs and
Action Intents to Work Items, retrieving authoritative decision context, and
performing action-specific checks remain separate work. The visual interface,
CLI commands for these records, and root-agent conversation are not included yet.
