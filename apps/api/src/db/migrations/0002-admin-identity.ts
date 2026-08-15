import type { Database } from "bun:sqlite";

// The spec 0001 §3.2.1 schema, verbatim, plus the §3.2 `versions.author_account_id`
// column the passkey model adds. `author` keeps its meaning — a username copied at
// publish time — so existing rows stay valid with a NULL account id.
export function up(db: Database): void {
  db.exec(`
    ALTER TABLE versions ADD COLUMN author_account_id TEXT;

    CREATE TABLE admin_accounts (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      disabled_at INTEGER
    );

    CREATE TABLE admin_credentials (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
      public_key   BLOB NOT NULL,
      counter      INTEGER NOT NULL,
      transports   TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE admin_enrollments (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
      code_hash   TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER
    );

    -- id is the session token's jti claim: the JWT carries it, this row makes
    -- revoking it instant (§8.1.4).
    CREATE TABLE admin_sessions (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      ip         TEXT,
      user_agent TEXT
    );

    CREATE TABLE admin_grants (
      account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, permission)
    );

    CREATE TABLE admin_audit (
      id         TEXT PRIMARY KEY,
      account_id TEXT,
      username   TEXT NOT NULL,
      session_id TEXT,
      method     TEXT NOT NULL,
      path       TEXT NOT NULL,
      status     INTEGER NOT NULL,
      body       TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_admin_credentials_account ON admin_credentials(account_id);
    CREATE INDEX idx_admin_sessions_account ON admin_sessions(account_id);
    CREATE INDEX idx_admin_audit_created ON admin_audit(created_at DESC);
  `);
}
