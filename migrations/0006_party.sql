-- Groups (parties): a leader and up to a few friends who play together. Each
-- player is in one group at most. rev goes up on every change, so the app
-- knows when to fetch the group again.

CREATE TABLE parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL DEFAULT 1,
  -- The room the leader called the group to, while the call lasts.
  call_name TEXT,
  call_link TEXT,
  call_password TEXT,
  call_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE party_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL
);
CREATE INDEX party_members_party ON party_members(party_id);

CREATE TABLE party_invites (
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (party_id, to_id)
);
CREATE INDEX party_invites_to ON party_invites(to_id);

CREATE TABLE party_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX party_messages_party ON party_messages(party_id, id);
