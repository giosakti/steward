CREATE TABLE action_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  proposed_by jsonb NOT NULL CHECK (jsonb_typeof(proposed_by) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  action_intent_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('ALLOW', 'DENY', 'ESCALATE')),
  policy_version text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, action_intent_id) REFERENCES action_intents(workspace_id, id)
);

CREATE INDEX action_intents_workspace ON action_intents(workspace_id, created_at, id);
CREATE INDEX decisions_intent ON decisions(workspace_id, action_intent_id, created_at, id);

CREATE FUNCTION reject_action_intent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'action intents are append-only';
END;
$$;

CREATE TRIGGER action_intents_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON action_intents
FOR EACH STATEMENT EXECUTE FUNCTION reject_action_intent_mutation();

CREATE FUNCTION reject_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'decisions are append-only';
END;
$$;

CREATE TRIGGER decisions_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON decisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_decision_mutation();
