# Code organization

Follow the newspaper rule: put high-level operations before supporting helpers,
and test cases before their setup helpers. Present public result types before
their supporting details.

Keep runtime schemas and SQL in dependency order where initialization requires
it. Do not introduce lazy initialization, classes, or extra modules solely to
force a particular reading order.
