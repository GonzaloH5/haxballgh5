-- Private messages between friends. Kept MESSAGE_TTL days (see friends.js).

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX messages_pair ON messages(from_id, to_id, id);
CREATE INDEX messages_unread ON messages(to_id, read_at);
