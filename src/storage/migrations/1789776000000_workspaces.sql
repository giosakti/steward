CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  root_path text,
  root_agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  role_description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

-- Defer this check so workspace and agent can be created in one transaction.
ALTER TABLE workspaces ADD CONSTRAINT workspace_root_agent
  FOREIGN KEY (id, root_agent_id) REFERENCES agents(workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- One local operator selection per database, with explicit overrides in the CLI.
CREATE TABLE workspace_selection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  workspace_id uuid NOT NULL REFERENCES workspaces(id)
);

ALTER TABLE events ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
CREATE INDEX events_workspace_id ON events(workspace_id, id);
