CREATE TABLE operator_owner_bootstrap_runs (
  bootstrap_key TEXT PRIMARY KEY CHECK (bootstrap_key = 'initial_owner'),
  email TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
