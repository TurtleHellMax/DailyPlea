// server/db.js
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data.sqlite');
console.log(`[db] Using SQLite at: ${dbPath}`);
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- small utils ---------- */
function tableInfo(name) {
    try { return db.prepare(`PRAGMA table_info(${name})`).all(); } catch { return []; }
}
function colNames(name) { return tableInfo(name).map(c => c.name); }
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
      username          TEXT,
      first_username    TEXT,
      profile_photo     TEXT,
      bio_html          TEXT,
      bio               TEXT,
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

    const want = [
        `email TEXT`, `phone TEXT`, `username TEXT`, `first_username TEXT`,
        `profile_photo TEXT`,
        `bio_html TEXT`,
        `bio TEXT`,
        `role TEXT NOT NULL DEFAULT 'user'`,
        `is_admin INTEGER NOT NULL DEFAULT 0`,
        `received_likes INTEGER NOT NULL DEFAULT 0`,
        `received_dislikes INTEGER NOT NULL DEFAULT 0`,
        `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`,
        `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ];
    for (const def of want) addColumnIfMissing('users', def);
}

/* ---------- FRIENDS & REQUESTS ---------- */
function ensureFriendsTables() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id  INTEGER NOT NULL,
      to_user_id    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(to_user_id)   REFERENCES users(id) ON DELETE CASCADE,
      CHECK (status IN ('pending','accepted','ignored'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_requests_open
      ON friend_requests(from_user_id, to_user_id)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_friend_requests_to   ON friend_requests(to_user_id);
    CREATE INDEX IF NOT EXISTS idx_friend_requests_stat ON friend_requests(status);

    DROP TRIGGER IF EXISTS trg_friend_requests_updated_at;
    CREATE TRIGGER trg_friend_requests_updated_at
    AFTER UPDATE ON friend_requests
    FOR EACH ROW BEGIN
      UPDATE friend_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_id_a  INTEGER NOT NULL,
      user_id_b  INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id_a, user_id_b),
      CHECK (user_id_a < user_id_b),
      FOREIGN KEY(user_id_a) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id_b) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_id_a);
    CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_id_b);
  `);

    try {
        db.exec(`
      CREATE VIEW IF NOT EXISTS user_friend_edges AS
      SELECT user_id_a AS user_id, user_id_b AS friend_id, rowid AS created_at
      FROM friendships
      UNION ALL
      SELECT user_id_b AS user_id, user_id_a AS friend_id, rowid AS created_at
      FROM friendships;
    `);
    } catch { }
}

/* ---------- CREDENTIALS (password storage) ---------- */
function ensureCredentialsTable() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      provider      TEXT NOT NULL DEFAULT 'local',
      email         TEXT,
      password_hash TEXT,
      password      TEXT,
      algo          TEXT,
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

    addColumnIfMissing('credentials', `password_hash TEXT`);
    addColumnIfMissing('credentials', `password TEXT`);
    addColumnIfMissing('credentials', `algo TEXT`);

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

/* ---------- Sessions ---------- */
function ensureSessionsTable() {
    if (!tableExists('sessions')) {
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

    const cols = colNames('sessions');
    const needRebuild = !cols.includes('id') || !cols.includes('last_seen_at');

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
        const colsNow = colNames('sessions');
        const idSrc =
            colsNow.includes('id') ? 'id' :
                colsNow.includes('sid') ? 'sid' :
                    colsNow.includes('session_id') ? 'session_id' :
                        colsNow.includes('token') ? 'token' : null;

        const sidSrc =
            colsNow.includes('sid') ? 'sid' : (idSrc ? idSrc : null);

        const userSrc =
            colsNow.includes('user_id') ? 'user_id' :
                colsNow.includes('uid') ? 'uid' :
                    colsNow.includes('userId') ? 'userId' : null;

        const createdSrc = colsNow.includes('created_at') ? 'created_at' : null;
        const lastSeenSrc =
            colsNow.includes('last_seen_at') ? 'last_seen_at' :
                colsNow.includes('seen_at') ? 'seen_at' : null;
        const expiresSrc =
            colsNow.includes('expires_at') ? 'expires_at' :
                colsNow.includes('expiry') ? 'expiry' :
                    colsNow.includes('expires') ? 'expires' : null;

        const canCopy = !!userSrc;

        const tx = db.transaction(() => {
            db.exec(`PRAGMA foreign_keys=OFF;`);
            createCanonical();

            if (canCopy) {
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

            db.exec(`DROP TABLE sessions; ALTER TABLE sessions_new RENAME TO sessions;`);
            installTriggersAndIndexes();
            db.exec(`PRAGMA foreign_keys=ON;`);
        });

        try { tx(); } catch (e) {
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
      value        INTEGER NOT NULL DEFAULT 0,
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

/* ---------- DMs ---------- */
function ensureDMTables() {
    db.exec(`
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS dm_conversations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      is_group     INTEGER NOT NULL DEFAULT 0,
      title        TEXT,
      owner_id     INTEGER,
      color        TEXT,                         -- NEW
      deleted_at   TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS dm_members (
      conversation_id INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      joined_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id)         REFERENCES users(id)             ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);

    CREATE TABLE IF NOT EXISTS dm_conversation_keys (
      conversation_id INTEGER PRIMARY KEY,
      key_cipher      BLOB NOT NULL,
      key_nonce       BLOB NOT NULL,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dm_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id       INTEGER NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'text',
      body_cipher     BLOB,
      body_nonce      BLOB,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(sender_id)       REFERENCES users(id)            ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dm_messages_conv_id ON dm_messages(conversation_id, id DESC);

    CREATE TABLE IF NOT EXISTS dm_attachments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      INTEGER NOT NULL,
      filename        TEXT NOT NULL,
      mime_type       TEXT NOT NULL,
      encoding        TEXT,
      size_bytes      INTEGER NOT NULL,
      duration_ms     INTEGER,
      blob_cipher     BLOB NOT NULL,
      blob_nonce      BLOB NOT NULL,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(message_id) REFERENCES dm_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dm_attachments_msg_id ON dm_attachments(message_id);

    -- NEW: encrypted per-group icon
    CREATE TABLE IF NOT EXISTS dm_group_icons (
      conversation_id INTEGER PRIMARY KEY,
      mime_type       TEXT NOT NULL,
      blob_cipher     BLOB NOT NULL,
      blob_nonce      BLOB NOT NULL,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dm_group_icons_updated ON dm_group_icons(updated_at DESC);

    CREATE TABLE IF NOT EXISTS dm_deleted_groups (
      conversation_id INTEGER PRIMARY KEY,
      owner_id        INTEGER,
      deleted_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(owner_id)        REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS dm_message_colors (
      conversation_id INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      color           TEXT,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(conversation_id, user_id),
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id)         REFERENCES users(id)            ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS dm_hidden (
      user_id            INTEGER NOT NULL,
      conversation_id    INTEGER NOT NULL,
      last_hidden_msg_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, conversation_id),
      FOREIGN KEY(user_id)         REFERENCES users(id)             ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dm_hidden_conv ON dm_hidden(conversation_id);

    CREATE TABLE IF NOT EXISTS dm_conv_blocks (
      user_id         INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, conversation_id),
      FOREIGN KEY(user_id)         REFERENCES users(id)             ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id)  ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dm_msgcolors_conv ON dm_message_colors(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_dm_msgcolors_user ON dm_message_colors(user_id);
    DROP TRIGGER IF EXISTS trg_dm_message_colors_updated_at;
    CREATE TRIGGER trg_dm_message_colors_updated_at
    AFTER UPDATE ON dm_message_colors
    FOR EACH ROW BEGIN
      UPDATE dm_message_colors SET updated_at = CURRENT_TIMESTAMP
      WHERE conversation_id = NEW.conversation_id AND user_id = NEW.user_id;
    END;
  `);

    // safety columns
    addColumnIfMissing('dm_conversations', `owner_id INTEGER`);
    addColumnIfMissing('dm_conversations', `deleted_at TEXT`);
    addColumnIfMissing('dm_conversations', `color TEXT`);
    addColumnIfMissing('dm_attachments', `duration_ms INTEGER`);

    // backfill owner for old groups
    try {
        db.exec(`
      UPDATE dm_conversations
      SET owner_id = (
        SELECT user_id FROM dm_members
        WHERE conversation_id = dm_conversations.id
        ORDER BY datetime(joined_at) ASC, user_id ASC
        LIMIT 1
      )
      WHERE is_group = 1 AND (owner_id IS NULL OR owner_id = 0);
    `);
    } catch { }
}

/* ---------- master migration ---------- */
function migrate() {
    ensureUsersTable();
    ensureFriendsTables();
    ensureCredentialsTable();
    ensureSessionsTable();
    ensureTotpTable();
    ensureEmailOtpTable();
    ensurePasswordResetsTable();
    ensureCommentsAndVotes();
    ensureDMTables();
}

module.exports = { db, migrate, dbPath };