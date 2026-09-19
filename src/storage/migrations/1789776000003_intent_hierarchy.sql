CREATE TABLE missions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
  statement text NOT NULL CHECK (length(btrim(statement)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE goals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  parent_goal_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  objective text NOT NULL CHECK (length(btrim(objective)) > 0),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_goal_id) REFERENCES goals(workspace_id, id),
  CHECK (parent_goal_id IS DISTINCT FROM id)
);

CREATE TABLE work_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  goal_id uuid NOT NULL,
  parent_work_item_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  objective text NOT NULL CHECK (length(btrim(objective)) > 0),
  acceptance_criteria jsonb NOT NULL CHECK (
    jsonb_typeof(acceptance_criteria) = 'array' AND jsonb_array_length(acceptance_criteria) > 0
  ),
  status text NOT NULL CHECK (status IN (
    'proposed', 'ready', 'running', 'needs_review', 'completed', 'rejected', 'blocked'
  )),
  priority integer NOT NULL,
  created_by jsonb NOT NULL CHECK (jsonb_typeof(created_by) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES goals(workspace_id, id),
  FOREIGN KEY (workspace_id, parent_work_item_id) REFERENCES work_items(workspace_id, id),
  CHECK (parent_work_item_id IS DISTINCT FROM id)
);

CREATE INDEX goals_workspace ON goals(workspace_id, created_at, id);
CREATE INDEX goals_parent ON goals(workspace_id, parent_goal_id);
CREATE INDEX work_items_goal ON work_items(workspace_id, goal_id);
CREATE INDEX work_items_parent ON work_items(workspace_id, parent_work_item_id);
CREATE INDEX work_items_workspace ON work_items(workspace_id, priority DESC, created_at, id);
