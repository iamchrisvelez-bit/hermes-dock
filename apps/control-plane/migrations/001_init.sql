-- HERMES DIGITAL WORLD: initial schema.
-- Durable state tables + an append-only event log. State changes and their events are
-- written in the same transaction by the Store (see src/store.ts).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','operator','viewer')),
  created_at TEXT NOT NULL
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  autonomy_tier TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  island_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  data_deleted_at TEXT
);

CREATE TABLE islands (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('headquarters','project')),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  slot INTEGER NOT NULL,
  x REAL NOT NULL,
  z REAL NOT NULL,
  seed INTEGER NOT NULL,
  state TEXT NOT NULL,
  removal_preset TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live island per slot; destroyed islands free their slot.
CREATE UNIQUE INDEX islands_live_slot ON islands(slot) WHERE state <> 'destroyed';

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  appearance_json TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  current_task_id TEXT,
  activity TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES agents(id),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status, created_at);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  adapter TEXT NOT NULL,
  external_run_id TEXT,
  revision_notes TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT,
  output_artifact_id TEXT,
  usage_json TEXT,
  last_adapter_seq INTEGER,
  UNIQUE (task_id, number)
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id),
  adapter TEXT NOT NULL,
  external_run_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('input','deliverable','partial')),
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id),
  artifact_id TEXT,
  verdict TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE research_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('observation','hypothesis','validated_finding')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE skill_proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_project_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT,
  max_tokens INTEGER,
  max_cost_usd REAL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_cost_usd REAL NOT NULL DEFAULT 0,
  usage_unreported INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE controls (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pause_all INTEGER NOT NULL DEFAULT 0,
  new_work_disabled INTEGER NOT NULL DEFAULT 0,
  emergency_stop INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Append-only. `seq` is the world cursor clients resume from.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- Command idempotency (e.g. a retried intake POST returns the original result).
CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Security audit trail (auth, denials, owner commands). Never stores secrets or prompts.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL,
  detail_json TEXT
);
