/**
 * Ordered schema migrations. Each entry upgrades the schema by one version;
 * `PRAGMA user_version` records how many have been applied. Never edit a
 * migration that has shipped — append a new one instead.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: accounts, sessions and rooms */ `
  CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    username            TEXT    NOT NULL,
    username_normalized TEXT    NOT NULL UNIQUE,
    password_hash       TEXT    NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    last_login_at       INTEGER
  ) STRICT;

  CREATE TABLE sessions (
    token_hash   TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_user_id ON sessions (user_id);
  CREATE INDEX sessions_expires_at ON sessions (expires_at);

  CREATE TABLE rooms (
    id             TEXT    PRIMARY KEY,
    owner_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel        TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    game           TEXT    NOT NULL,
    UNIQUE (owner_id, channel)
  ) STRICT;
  `,

  /* 2: single-use invite codes */ `
  CREATE TABLE invite_codes (
    id               INTEGER PRIMARY KEY,
    code_hash        TEXT    NOT NULL UNIQUE,
    hint             TEXT    NOT NULL,
    note             TEXT,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    revoked_at       INTEGER,
    used_at          INTEGER,
    used_by_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    used_by_username TEXT
  ) STRICT;
  `,
];
