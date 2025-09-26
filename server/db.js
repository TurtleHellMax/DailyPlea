// --- in server/db.js ---
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableInfo(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all();
}
function hasColumn(name, col) {
  return tableInfo(name).some(c => c.name === col);
}
function ensureColumn(table, defSql) {
  const colName = defSql.trim().split(/\s+/)[0];
  if (!hasColumn(table, colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${defSql}`);
  }
}
function tableExists(name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function normalizeCommentVotesTable() {
  try {
    const cols = db.prepare('PRAGMA table_info(comment_votes)').all();
    const hasValue = cols.some(c => c.name === 'value');
    const hasVote  = cols.some(c => c.name === 'vote');
    if (hasValue) {
      console.log('[migrate] comment_votes already normalized (has value)');
      return;
    }
    if (!hasVote) {
      console.log('[migrate] comment_votes has neither vote nor value — skipping');
      return;
    }

    console.log('[migrate] normalizing comment_votes: vote -> value');
    const tx = db.transaction(() => {
      db.exec(`
        PRAGMA foreign_keys=OFF;
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
          SELECT comment_id, user_id,
                 COALESCE(value, vote, 0) AS value,
                 COALESCE(updated_at, CURRENT_TIMESTAMP)
          FROM comment_votes;
        DROP TABLE comment_votes;
        ALTER TABLE comment_votes_new RENAME TO comment_votes;
        CREATE INDEX IF NOT EXISTS idx_comment_votes_user ON comment_votes (user_id);
        PRAGMA foreign_keys=ON;
      `);
    });
    tx();
    console.log('[migrate] comment_votes normalized');
  } catch (e) {
    console.error('[migrate] normalizeCommentVotesTable failed:', e);
    throw e;
  }
}

function ensureBaseTables() {
  // Users/credentials/etc. are assumed created by your existing schema.sql/migrations.
  // Create the two comment tables if they don’t exist yet (with full modern shape).
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
      value        INTEGER NOT NULL DEFAULT 0, -- -1, 0, 1
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(comment_id, user_id),
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function maybeRenamePleaToPleaNum() {
  // Legacy column was `plea`; if present, rebuild comments preserving data.
  const cols = tableInfo('comments');
  const hasPlea = cols.some(c => c.name === 'plea');
  const hasPleaNum = cols.some(c => c.name === 'plea_num');
  if (hasPlea && !hasPleaNum) {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE comments_new (
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
        INSERT INTO comments_new (id, plea_num, user_id, parent_id, body, likes, dislikes, created_at, updated_at)
        SELECT id, plea,       user_id, parent_id, body, likes, dislikes, created_at, COALESCE(updated_at, created_at)
        FROM comments;
        DROP TABLE comments;
        ALTER TABLE comments_new RENAME TO comments;
      `);
    });
    tx();
  }
}

function ensureCommentColumns() {
  // Add any missing columns safely.
  ensureColumn('comments',       `parent_id INTEGER`);
  ensureColumn('comments',       `likes INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('comments',       `dislikes INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('comments',       `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  // In case some very old DB had `plea` but we didn't rebuild (defensive):
  if (!hasColumn('comments', 'plea_num')) {
    maybeRenamePleaToPleaNum();
  }

  ensureColumn('comment_votes',  `value INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('comment_votes',  `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
}

function ensureIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_plea_created ON comments (plea_num, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comment_votes_user ON comment_votes (user_id);
    CREATE INDEX IF NOT EXISTS idx_comment_votes_comment ON comment_votes (comment_id);
  `);
}

function ensureTriggers() {
  // Use AFTER UPDATE triggers to stamp updated_at (no recursion because recursive_triggers is OFF by default)
  db.exec(`
    DROP TRIGGER IF EXISTS trg_comments_updated_at;
    CREATE TRIGGER trg_comments_updated_at
    AFTER UPDATE ON comments
    FOR EACH ROW
    BEGIN
      UPDATE comments SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    DROP TRIGGER IF EXISTS trg_comment_votes_updated_at;
    CREATE TRIGGER trg_comment_votes_updated_at
    AFTER UPDATE ON comment_votes
    FOR EACH ROW
    BEGIN
      UPDATE comment_votes SET updated_at = CURRENT_TIMESTAMP
      WHERE comment_id = NEW.comment_id AND user_id = NEW.user_id;
    END;
  `);
}

function backfillTimestamps() {
  // Ensure non-null updated_at values
  db.exec(`
    UPDATE comments SET updated_at = COALESCE(updated_at, created_at);
    UPDATE comment_votes SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
  `);
}

function ensureUserReceivedCounters() {
  try { db.exec(`ALTER TABLE users ADD COLUMN received_likes INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN received_dislikes INTEGER NOT NULL DEFAULT 0`); } catch {}
}

// server/db.js (replace your migrate() with this)
function migrate() {
    // your existing base schema loads, etc. are fine to keep above/below if you have them
    // …

    // Ensure core tables exist (idempotent)
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
    value        INTEGER NOT NULL, -- canonical column
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(comment_id, user_id),
    FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  `);

    // Make sure users has counters (idempotent)
    try { db.exec(`ALTER TABLE users ADD COLUMN received_likes INTEGER NOT NULL DEFAULT 0`); } catch { }
    try { db.exec(`ALTER TABLE users ADD COLUMN received_dislikes INTEGER NOT NULL DEFAULT 0`); } catch { }

    // --- Normalize comment_votes to ONLY have "value" (and NOT a legacy NOT NULL "vote") ---
    try {
        const cols = db.prepare(`PRAGMA table_info(comment_votes)`).all();
        const hasValue = cols.some(c => c.name === 'value');
        const hasVote = cols.some(c => c.name === 'vote');
        // If both exist, or legacy "vote" exists (esp. NOT NULL), rebuild table to canonical schema.
        if (hasVote || !hasValue) {
            console.warn('[migrate] Rebuilding comment_votes to canonical schema...');
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
        `);

                // copy over, coalescing any legacy "vote" into "value"
                const existingCols = cols.map(c => c.name);
                const hasUpdatedAt = existingCols.includes('updated_at');
                const selectValue = hasValue ? 'value' : (hasVote ? 'vote' : '0');
                const selectUpdated = hasUpdatedAt ? 'updated_at' : 'CURRENT_TIMESTAMP';

                db.exec(`
          INSERT INTO comment_votes_new (comment_id, user_id, value, updated_at)
          SELECT comment_id, user_id, COALESCE(${selectValue}, 0), ${selectUpdated}
          FROM comment_votes;
        `);

                db.exec(`DROP TABLE comment_votes;`);
                db.exec(`ALTER TABLE comment_votes_new RENAME TO comment_votes;`);
                db.exec(`PRAGMA foreign_keys=ON;`);

                // helpful index
                db.exec(`CREATE INDEX IF NOT EXISTS idx_comment_votes_user ON comment_votes (user_id);`);
            });
            tx();
            console.warn('[migrate] comment_votes normalized ✅');
        } else {
            console.log('[migrate] comment_votes already canonical (value only) ✅');
        }
    } catch (e) {
        console.error('[migrate] comment_votes normalization failed:', e);
        throw e;
    }

    // Helpful indexes (idempotent)
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_plea_created ON comments (plea_num, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comment_votes_user   ON comment_votes (user_id);
  `);
}


module.exports = { db, migrate };
