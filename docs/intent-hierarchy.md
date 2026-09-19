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

The current mission is the nullable `mission_statement` field on the Workspace,
not a separate entity or table. Goals belong to the workspace, not to a mission
revision. Setting a new statement updates the workspace and records the previous
statement in the audit log. Goals can be created before a mission is set.

## Relationships

Every Work Item requires one primary Goal. Goals and Work Items have no parent
field. Instead, each can have multiple explicit relationships within its Workspace:

| Between    | Forward label  | Reverse label | Type             |
| ---------- | -------------- | ------------- | ---------------- |
| Goals      | contributes to | advanced by   | `contributes_to` |
| Goals      | relates to     | relates to    | `relates_to`     |
| Work Items | blocks         | is blocked by | `blocks`         |
| Work Items | relates to     | relates to    | `relates_to`     |

Reverse labels display the same stored link. `relates_to` is symmetric; reversing
its endpoints does not create another link. Work Items may link across primary
Goals within their Workspace. Self-links, duplicates, and directed cycles are
rejected, including cycles introduced by concurrent additions. Context links may
form cycles. Endpoints and types cannot be edited in place: remove and recreate
the link, preserving both operations in the audit history.

`contributes_to` expresses purpose without imposing execution order or automatic
completion. `relates_to` supplies context only. If A `blocks` B, B must not start
execution while A is incomplete. Rejection of A does not fulfill the dependency;
it must be resolved explicitly. Completing A does not automatically change B's
status or start execution. Dependency checks and revalidation will be connected
with Run orchestration; these APIs only record the relationships today.

A Work Item's primary Goal is fixed at creation in this slice. Moving work between
Goals and deleting Goals or Work Items are not exposed yet.

## Operator workflow

Use the authenticated [HTTP API](http-api.md#intent-hierarchy) to set a mission,
create goals, and create work with explicit acceptance criteria. These endpoints
accept direct human-operator instructions. They are not agent capabilities:
agents will need a separate Decision Kernel authorization path.

Goals start `active`; the operator can set `active`, `paused`, `completed`, or
`cancelled`. Status changes do not cascade through relationships or infer completion from
related records.

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
preserve the previous record. Creator attribution lives in immutable creation
events, not `created_by` columns on Work Items or relationships. Actor and
request metadata come from trusted operator context, never from request bodies.
A shared identity model for humans and agents is deferred until agent access is
implemented.

This provides durable intent for the next execution slice. Linking Runs and
Action Intents to Work Items, retrieving authoritative decision context, and
performing action-specific checks remain separate work. The visual interface,
CLI commands for these records, and root-agent conversation are not included yet.
