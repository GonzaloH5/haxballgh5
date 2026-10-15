-- Accounts (signed in with Discord), their sessions, and logins in progress.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL UNIQUE,
  discord_name TEXT NOT NULL,
  discord_avatar TEXT,
  -- Chosen once signed in; unique ignoring case (nick_key).
  nick TEXT,
  nick_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Only the SHA-256 of a session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A login started by the app: state goes to Discord and back; once Discord
-- returns, the new session token waits here until the app polls for it once.
CREATE TABLE logins (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  token TEXT,
  error TEXT
);
