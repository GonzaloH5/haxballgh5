-- Invitations from a friend to their room (to play, or to watch their match).
-- One per sender and receiver: a new one replaces the old. They expire after
-- a few minutes and are deleted, password included.

CREATE TABLE invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  room_name TEXT NOT NULL,
  room_link TEXT NOT NULL,
  password TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);
CREATE INDEX invites_to ON invites(to_id);
