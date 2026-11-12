-- The tables and columns of Lumiverse's database that the database reader reads (src/runtime/db),
-- each column declared as Lumiverse's own schema declares it (its src/db/baseline.sql), with the
-- indexes Lumiverse keeps on them. Columns the reader doesn't read are left out. The tests build their
-- databases from this file.

CREATE TABLE "chats" (
  id TEXT PRIMARY KEY,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  index_in_chat INTEGER NOT NULL,
  is_user INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  send_date INTEGER NOT NULL DEFAULT (unixepoch()),
  swipe_id INTEGER NOT NULL DEFAULT 0,
  swipes TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, revision INTEGER NOT NULL DEFAULT 1);

CREATE TABLE world_book_entries (
  id TEXT PRIMARY KEY,
  world_book_id TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
  key TEXT NOT NULL DEFAULT '[]',
  keysecondary TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  role TEXT,
  order_value INTEGER NOT NULL DEFAULT 100,
  constant INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  extensions TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, use_regex INTEGER NOT NULL DEFAULT 0, vectorized INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);

CREATE TABLE world_books (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE INDEX idx_chats_user_id ON chats(user_id);

CREATE INDEX idx_messages_chat_id ON messages(chat_id);

CREATE INDEX idx_messages_chat_index ON messages(chat_id, index_in_chat);

CREATE INDEX idx_messages_last_assistant ON messages(chat_id, is_user, index_in_chat DESC);

CREATE INDEX idx_wbe_world_book_id ON world_book_entries(world_book_id);

CREATE INDEX idx_wbe_world_book_order
  ON world_book_entries(world_book_id, order_value, id);

CREATE INDEX idx_world_books_user_id ON world_books(user_id);
