CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, order_number TEXT NOT NULL, description TEXT NOT NULL, published_at INTEGER NOT NULL, deadline TEXT NOT NULL, reaction_fire INTEGER NOT NULL DEFAULT 0, reaction_heart INTEGER NOT NULL DEFAULT 0, reaction_update_id INTEGER NOT NULL DEFAULT -1, updated_at INTEGER NOT NULL, UNIQUE(source_chat_id,source_message_id));
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(reaction_heart,deadline,published_at);
CREATE TABLE IF NOT EXISTS pending_reactions (source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, reaction_fire INTEGER NOT NULL, reaction_heart INTEGER NOT NULL, update_id INTEGER NOT NULL, PRIMARY KEY(source_chat_id,source_message_id));
CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, processed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS report_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL, local_date TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, message_ids TEXT NOT NULL DEFAULT '[]', error_message TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_auto_report_per_day ON report_runs(report_type,local_date) WHERE report_type='auto';
CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
