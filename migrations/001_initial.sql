CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  soul_path TEXT NOT NULL,
  memory_path TEXT NOT NULL,
  voice TEXT NOT NULL CHECK (voice IN ('Katie', 'Skylar', 'Gemma')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id),
  thread_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  lobby_channel_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'ending', 'ended')),
  accepting_messages INTEGER NOT NULL DEFAULT 1 CHECK (accepting_messages IN (0, 1)),
  speak_mode TEXT NOT NULL DEFAULT 'off' CHECK (speak_mode IN ('off', 'on', 'mirror')),
  model_id TEXT NOT NULL DEFAULT 'deepseek-v4-pro' CHECK (model_id IN ('deepseek-v4-pro', 'minimax-m3', 'hy3')),
  reasoning_mode TEXT NOT NULL DEFAULT 'default',
  started_at TEXT NOT NULL,
  last_activity_at TEXT,
  inactivity_deadline_at TEXT,
  curation_watermark_id INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT,
  archived_at TEXT
);

CREATE TABLE thread_bindings (
  thread_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  guild_id TEXT NOT NULL,
  bound_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  discord_message_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'assistant')),
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text', 'voice')),
  triggering_discord_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX messages_session_id_id ON messages(session_id, id);

CREATE TABLE discord_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  discord_message_id TEXT NOT NULL,
  discord_attachment_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  content_type TEXT,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_seconds REAL,
  waveform TEXT,
  local_path TEXT,
  transcript TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'downloading', 'transcribing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outbound_responses (
  triggering_discord_message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  assistant_message_row_id INTEGER REFERENCES messages(id),
  discord_response_message_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('generating', 'generated', 'sending', 'sent', 'failed')),
  clean_content TEXT,
  expression TEXT,
  voice_requested INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE curation_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  from_message_id INTEGER NOT NULL,
  to_message_id INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('inactivity', 'end')),
  segment_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, from_message_id, to_message_id)
);

CREATE INDEX curation_jobs_due ON curation_jobs(state, next_attempt_at);

CREATE TABLE file_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES characters(id),
  file_kind TEXT NOT NULL CHECK (file_kind IN ('SOUL', 'MEMORY')),
  revision INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('create', 'curator', 'external')),
  curation_job_id TEXT REFERENCES curation_jobs(id),
  created_at TEXT NOT NULL,
  UNIQUE(character_id, file_kind, revision)
);

CREATE TABLE model_capabilities (
  model_id TEXT PRIMARY KEY,
  reasoning_modes_json TEXT NOT NULL,
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE service_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE health_checks (
  component TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE INDEX sessions_character_id ON sessions(character_id);
CREATE INDEX thread_bindings_character_id ON thread_bindings(character_id);
CREATE INDEX attachments_session_id ON attachments(session_id);
CREATE INDEX outbound_responses_session_id ON outbound_responses(session_id);
CREATE INDEX file_revisions_curation_job_id ON file_revisions(curation_job_id);
