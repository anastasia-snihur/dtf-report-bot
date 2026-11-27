ALTER TABLE report_runs ADD COLUMN parts TEXT;
ALTER TABLE report_runs ADD COLUMN next_part INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_runs ADD COLUMN part_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_runs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_runs ADD COLUMN claim_at INTEGER;
ALTER TABLE orders ADD COLUMN message_update_id INTEGER NOT NULL DEFAULT -1;

CREATE TABLE actor_reactions (
  source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL,
  actor TEXT NOT NULL, fire INTEGER NOT NULL, heart INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  PRIMARY KEY (source_chat_id, source_message_id, actor)
);
