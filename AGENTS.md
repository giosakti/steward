# Code organization

Follow the newspaper rule: put high-level operations before supporting helpers,
and test cases before their setup helpers. Present public result types before
their supporting details.

Keep runtime schemas and SQL in dependency order where initialization requires
it. Do not introduce lazy initialization, classes, or extra modules solely to
force a particular reading order.

Group imports as Node built-ins, external packages, then internal modules; sort
by module path within each group. Group route registrations and database tables
by domain: workspace (including mission and root agent), goals and their
relationships, work items and their relationships, decisions, then audit events.

# Code comments

Explain intent, constraints, tradeoffs, or context that the code cannot convey
on its own. Do not narrate obvious operations or repeat names and types. Prefer
clear names and structure over explanatory comments. Keep comments accurate as
code changes; avoid PR progress notes. Use TODOs for specific missing work.
