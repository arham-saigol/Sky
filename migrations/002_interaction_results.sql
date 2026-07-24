ALTER TABLE discord_events
ADD COLUMN result_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
