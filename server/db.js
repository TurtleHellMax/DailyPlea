// server/db.js
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- small utils ---------- */
function tableInfo(name) {
    try { return db.prepare(`PRAGMA table_info(${name})`).all(); } catch { return []; }
}
function colNames(name) {
    return tableInfo(name).map(c => c.name);
}
function tableExists(name) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    return !!row;
}
function addColumnIfMissing(table, defSql) {
    const name = defSql.trim().split(/\s+/)[0];
    const cols = colNames(table);
    if (!cols.includes(name)) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${defSql}`); } catch { } }
}

/* ---------- USERS ---------- */
function ensureUsersTable() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      email             TEXT,
      phone             TEXT,
      username          TEXT,         -- current handle (nullable until set)
      first_username    TEXT,         -- immutable slug seed (/user/:first_username)
      profile_photo     TEXT,
      role              TEXT NOT NULL DEFAULT 'user',
      is_admin          INTEGER NOT NULL DEFAULT 0,
      received_likes    INTEGER NOT NULL DEFAULT 0,
      received_dislikes INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email   ON users(email)           WHERE email           IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone   ON users(phone)           WHERE phone           IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_usernm  ON users(username)        WHERE username        IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_first   ON users(first_username)  WHERE first_username  IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_users_updated_at;
    CREATE TRIGGER trg_users_updated_at
    AFTER UPDATE ON users
    FOR EACH ROW BEGIN
      UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);

    // Safety adds on old DBs
    const want = [
        `email TEXT`, `phone TEXT`, `username TEXT`, `first_username TEXT`,
        `profile_photo TEXT`, `role TEXT NOT NULL DEFAULT 'user'`,
        `is_admin INTEGER NOT NULL DEFAULT 0`,
        `received_likes INTEGER NOT NULL DEFAULT 0`,
        `received_dislikes INTEGER NOT NULL DEFAULT 0`,
        `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`,
        `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ];
    for (const def of want) addColumnIfMissing('users', def);
}

/* ---------- CREDENTIALS (password storage) ---------- */
function ensureCredentialsTable() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      provider      TEXT NOT NULL DEFAULT 'local',
      email         TEXT,             -- nullable
      password_hash TEXT,
      password      TEXT,             -- legacy/plain compat (nullable)
      algo          TEXT,             -- e.g., 'argon2id'
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_credentials_user ON credentials(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_credentials_provider_email
      ON credentials(provider, email) WHERE email IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_credentials_updated_at;
    CREATE TRIGGER trg_credentials_updated_at
    AFTER UPDATE ON credentials
    FOR EACH ROW BEGIN
      UPDATE credentials SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);

    // Add missing columns (and ensure email is nullable)
    addColumnIfMissing('credentials', `password_hash TEXT`);
    addColumnIfMissing('credentials', `password TEXT`);
    addColumnIfMissing('credentials', `algo TEXT`);

    // If some legacy schema forced NOT NULL on email, rebuild without it
    try {
        const emailCol = tableInfo('credentials').find(c => c.name === 'email');
        if (emailCol && emailCol.notnull) {
            const tx = db.transaction(() => {
                db.exec(`PRAGMA foreign_keys=OFF;`);
                db.exec(`
          CREATE TABLE credentials_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL DEFAULT 'local',
            email TEXT,
            password_hash TEXT,
            password TEXT,
            algo TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          INSERT INTO credentials_new
            (id,user_id,provider,email,password_hash,password,algo,created_at,updated_at)
          SELECT id,user_id,provider,email,password_hash,password,algo,created_at,updated_at
          FROM credentials;
          DROP TABLE credentials;
          ALTER TABLE credentials_new RENAME TO credentials;
          CREATE UNIQUE INDEX IF NOT EXISTS uq_credentials_user ON credentials(user_id);
          CREATE UNIQUE INDEX IF NOT EXISTS uq_credentials_provider_email
            ON credentials(provider, email) WHERE email IS NOT NULL;
        `);
                db.exec(`PRAGMA foreign_keys=ON;`);
            });
            tx();
        }
    } catch { }
}

// Replace your ensureSessionsTable() with this
function ensureSessionsTable() {
    // 1) Fresh create if missing
    if (!tableExists('sessions')) {
        db.exec(`
      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,           -- cookie value
        sid          TEXT UNIQUE,                -- legacy/compat
        user_id      INTEGER NOT NULL,
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at   TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      DROP TRIGGER IF EXISTS trg_sessions_insert_sid;
      CREATE TRIGGER trg_sessions_insert_sid
      AFTER INSERT ON sessions
      FOR EACH ROW BEGIN
        UPDATE sessions SET sid = COALESCE(NEW.sid, NEW.id) WHERE id = NEW.id;
      END;

      DROP TRIGGER IF EXISTS trg_sessions_update_sid;
      CREATE TRIGGER trg_sessions_update_sid
      AFTER UPDATE OF id ON sessions
      FOR EACH ROW BEGIN
        UPDATE sessions SET sid = NEW.id WHERE id = NEW.id;
      END;

      CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
        return;
    }

    // 2) If table exists, see if it needs a rebuild (missing id/last_seen_at)
    const cols = colNames('sessions');
    const needRebuild = !cols.includes('id') || !cols.includes('last_seen_at');

    // Helper to create the canonical table & triggers/indexes
    const createCanonical = () => {
        db.exec(`
      CREATE TABLE sessions_new (
        id           TEXT PRIMARY KEY,
        sid          TEXT UNIQUE,
        user_id      INTEGER NOT NULL,
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at   TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    };
    const installTriggersAndIndexes = () => {
        db.exec(`
      DROP TRIGGER IF EXISTS trg_sessions_insert_sid;
      CREATE TRIGGER trg_sessions_insert_sid
      AFTER INSERT ON sessions
      FOR EACH ROW BEGIN
        UPDATE sessions SET sid = COALESCE(NEW.sid, NEW.id) WHERE id = NEW.id;
      END;

      DROP TRIGGER IF EXISTS trg_sessions_update_sid;
      CREATE TRIGGER trg_sessions_update_sid
      AFTER UPDATE OF id ON sessions
      FOR EACH ROW BEGIN
        UPDATE sessions SET sid = NEW.id WHERE id = NEW.id;
      END;

      CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    };

    if (needRebuild) {
        // Build a copy plan based on what columns actually exist
        const idSrc =
            cols.includes('id') ? 'id' :
                cols.includes('sid') ? 'sid' :
                    cols.includes('session_id') ? 'session_id' :
                        cols.includes('token') ? 'token' : null;

        const sidSrc =
            cols.includes('sid') ? 'sid' :
                idSrc ? idSrc : null;

        const userSrc =
            cols.includes('user_id') ? 'user_id' :
                cols.includes('uid') ? 'uid' :
                    cols.includes('userId') ? 'userId' : null;

        const createdSrc =
            cols.includes('created_at') ? 'created_at' : null;

        const lastSeenSrc =
            cols.includes('last_seen_at') ? 'last_seen_at' :
                cols.includes('seen_at') ? 'seen_at' : null;

        const expiresSrc =
            cols.includes('expires_at') ? 'expires_at' :
                cols.includes('expiry') ? 'expiry' :
                    cols.includes('expires') ? 'expires' : null;

        // If we can’t find a user column, it’s safer to recreate empty
        const canCopy = !!userSrc;

        const tx = db.transaction(() => {
            db.exec(`PRAGMA foreign_keys=OFF;`);
            createCanonical();

            if (canCopy) {
                // COPY ONLY FROM COLUMNS THAT EXIST — no referencing missing columns
                const selectSQL = `
          INSERT INTO sessions_new (id, sid, user_id, created_at, last_seen_at, expires_at)
          SELECT
            ${idSrc ? idSrc : "lower(hex(randomblob(16)))"}            AS id,
            ${sidSrc ? sidSrc : (idSrc ? idSrc : "NULL")}              AS sid,
            ${userSrc}                                                 AS user_id,
            ${createdSrc ? createdSrc : "CURRENT_TIMESTAMP"}           AS created_at,
            ${lastSeenSrc ? lastSeenSrc : (createdSrc ? createdSrc : "CURRENT_TIMESTAMP")} AS last_seen_at,
            ${expiresSrc ? expiresSrc : "NULL"}                        AS expires_at
          FROM sessions
        `;
                db.exec(selectSQL);
            }

            db.exec(`
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);

            installTriggersAndIndexes();
            db.exec(`PRAGMA foreign_keys=ON;`);
        });

        try {
            tx();
        } catch (e) {
            // If anything went wrong, fall back to a clean recreate
            const rescue = db.transaction(() => {
                db.exec(`PRAGMA foreign_keys=OFF;`);
                db.exec(`DROP TABLE IF EXISTS sessions;`);
                db.exec(`
          CREATE TABLE sessions (
            id           TEXT PRIMARY KEY,
            sid          TEXT UNIQUE,
            user_id      INTEGER NOT NULL,
            created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at   TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
                installTriggersAndIndexes();
                db.exec(`PRAGMA foreign_keys=ON;`);
            });
            rescue();
        }
        return;
    }

    // 3) If no rebuild needed, ensure convenience columns & indexes exist
    addColumnIfMissing('sessions', `sid TEXT UNIQUE`);
    addColumnIfMissing('sessions', `expires_at TEXT`);
    addColumnIfMissing('sessions', `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    addColumnIfMissing('sessions', `last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
}

/* ---------- 2FA / OTP / PW reset ---------- */
function ensureTotpTable() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS totp (
      user_id           INTEGER PRIMARY KEY,
      secret_ciphertext TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function ensureEmailOtpTable() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS email_otp (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      code_hash  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_email_otp_user ON email_otp(user_id);
  `);
}

function ensurePasswordResetsTable() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_pwreset_used ON password_resets(used_at);
  `);
}

/* ---------- Comments & Votes (social) ---------- */
function ensureCommentsAndVotes() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plea_num     INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      parent_id    INTEGER,
      body         TEXT NOT NULL,
      likes        INTEGER NOT NULL DEFAULT 0,
      dislikes     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS comment_votes (
      comment_id   INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      value        INTEGER NOT NULL DEFAULT 0, -- -1,0,1
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(comment_id, user_id),
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id)    REFERENCES users(id)    ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_plea_created   ON comments (plea_num, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comment_votes_user      ON comment_votes (user_id);
    CREATE INDEX IF NOT EXISTS idx_comment_votes_comment   ON comment_votes (comment_id);

    DROP TRIGGER IF EXISTS trg_comments_updated_at;
    CREATE TRIGGER trg_comments_updated_at
    AFTER UPDATE ON comments
    FOR EACH ROW BEGIN
      UPDATE comments SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    DROP TRIGGER IF EXISTS trg_comment_votes_updated_at;
    CREATE TRIGGER trg_comment_votes_updated_at
    AFTER UPDATE ON comment_votes
    FOR EACH ROW BEGIN
      UPDATE comment_votes SET updated_at = CURRENT_TIMESTAMP
      WHERE comment_id = NEW.comment_id AND user_id = NEW.user_id;
    END;
  `);

    // Legacy normalization: comment_votes.vote -> value
    try {
        const names = colNames('comment_votes');
        const hasValue = names.includes('value');
        const hasVote = names.includes('vote');
        if (hasVote && !hasValue) {
            const tx = db.transaction(() => {
                db.exec(`PRAGMA foreign_keys=OFF;`);
                db.exec(`
          CREATE TABLE comment_votes_new (
            comment_id INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            value      INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(comment_id, user_id),
            FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id)    REFERENCES users(id)    ON DELETE CASCADE
          );
          INSERT INTO comment_votes_new (comment_id, user_id, value, updated_at)
          SELECT
            comment_id, user_id,
            CASE
              WHEN value = 1 OR vote IN ('up','like','liked','1') THEN  1
              WHEN value = -1 OR vote IN ('down','dislike','-1')   THEN -1
              ELSE 0
            END,
            COALESCE(updated_at, CURRENT_TIMESTAMP)
          FROM comment_votes;
          DROP TABLE comment_votes;
          ALTER TABLE comment_votes_new RENAME TO comment_votes;
          CREATE INDEX IF NOT EXISTS idx_comment_votes_user    ON comment_votes (user_id);
          CREATE INDEX IF NOT EXISTS idx_comment_votes_comment ON comment_votes (comment_id);
        `);
                db.exec(`PRAGMA foreign_keys=ON;`);
            });
            tx();
        }
    } catch { }
}

/* ---------- master migration ---------- */
function migrate() {
    // Order matters: users → credentials/sessions/2FA → resets → comments
    ensureUsersTable();
    ensureCredentialsTable();
    ensureSessionsTable();
    ensureTotpTable();
    ensureEmailOtpTable();
    ensurePasswordResetsTable();
    ensureCommentsAndVotes();
}

module.exports = { db, migrate };
