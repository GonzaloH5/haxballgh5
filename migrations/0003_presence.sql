-- What each player is doing, sent by the app every few seconds while it runs
-- (POST /presence) and shown to their friends: online while updated_at is
-- recent, in a room when room_name is set.

CREATE TABLE presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  online INTEGER NOT NULL,
  room_name TEXT,
  room_link TEXT,
  players INTEGER,
  max_players INTEGER,
  playing INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
