// server/routes-users.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');
const { hashPassword, verifyPassword } = require('./security');

const router = express.Router();

/* ---------------- helpers ---------------- */

/* ---------------- analytics/settings schema ---------------- */

function ensureUserExtrasSchema() {
    db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id       INTEGER PRIMARY KEY,
      consent_emails INTEGER NOT NULL DEFAULT 0,  -- 0/1
      tos_version    TEXT,                        -- e.g. "2025-09-30"
      region         TEXT,                        -- free-form short label (e.g. "NA","EU","LATAM")
      language       TEXT,                        -- BCP-47-ish (e.g. "en", "en-US", "es")
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at     TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS trg_user_settings_updated
    AFTER UPDATE ON user_settings
    FOR EACH ROW BEGIN
      UPDATE user_settings SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
    END;

    CREATE TABLE IF NOT EXISTS user_friends (
      user_id               INTEGER NOT NULL,
      friend_user_id        INTEGER NOT NULL,
      friend_first_username TEXT    NOT NULL,     -- snapshot of OG username
      created_at            TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, friend_user_id),
      FOREIGN KEY(user_id)        REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(friend_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_friends_user ON user_friends(user_id);

    CREATE TABLE IF NOT EXISTS user_blocks (
      user_id                INTEGER NOT NULL,
      blocked_user_id        INTEGER NOT NULL,
      blocked_first_username TEXT    NOT NULL,    -- snapshot of OG username
      created_at             TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, blocked_user_id),
      FOREIGN KEY(user_id)         REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id);

    CREATE TABLE IF NOT EXISTS user_time_daily (
      user_id  INTEGER NOT NULL,
      day      TEXT    NOT NULL,                 -- YYYY-MM-DD in UTC
      seconds  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_time_daily_user_day ON user_time_daily(user_id, day);

    CREATE TABLE IF NOT EXISTS plea_reads (
      user_id      INTEGER NOT NULL,
      plea_num     INTEGER NOT NULL,             -- your plea identifier
      completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, plea_num),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_plea_reads_user ON plea_reads(user_id);

    CREATE TABLE IF NOT EXISTS user_presence (
        user_id  INTEGER PRIMARY KEY,
        seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_presence_seen ON user_presence(seen_at);
  `);
}
ensureUserExtrasSchema();

/* ---------------- tiny helpers for new routes ---------------- */

function dayKeyUTC(d = new Date()) {
    // YYYY-MM-DD in UTC
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function clamp(n, min, max) {
    n = Number(n); if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function resolveUserByEither(uname, firstUname) {
    if (firstUname) {
        return db.prepare(`SELECT id, username, first_username FROM users WHERE LOWER(first_username)=LOWER(?)`).get(firstUname);
    }
    if (uname) {
        return db.prepare(`SELECT id, username, first_username FROM users WHERE LOWER(username)=LOWER(?)`).get(uname);
    }
    return null;
}

function resolveUid(req) {
    const sid = req.cookies && req.cookies.sid;
    if (!sid) return 0;
    const row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sid);
    return row ? row.user_id : 0;
}

// banned/reserved names
const BANNED_PATH = path.join(__dirname, 'banned-usernames.txt');
function loadBannedSet() {
    try {
        const set = new Set();
        const txt = fs.readFileSync(BANNED_PATH, 'utf8');
        for (const line of txt.split(/\r?\n/)) {
            const s = line.trim().toLowerCase();
            if (s && !s.startsWith('#')) set.add(s);
        }
        return set;
    } catch {
        return new Set(['admin', 'administrator', 'support', 'moderator', 'root', 'owner', 'staff']);
    }
}
const BANNED_SET = loadBannedSet();
const RESERVED_SET = new Set([
    'admin', 'administrator', 'root', 'system', 'support', 'help', 'security', 'staff', 'moderator', 'mod',
    'api', 'v1', 'v2', 'v3', 'auth', 'login', 'logout', 'register', 'signup', 'sign-in',
    'user', 'users', 'me', 'you', 'owner', 'null', 'undefined',
    'comments', 'comment', 'plea', 'pleas', 'web', 'assets', 'static'
]);

const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
function usernameValid(u) { return USERNAME_RE.test(String(u || '').trim()); }
function usernameBanned(u) {
    const lu = String(u || '').trim().toLowerCase();
    return BANNED_SET.has(lu) || RESERVED_SET.has(lu);
}
function usernameTakenAnywhere(u, exceptUserId = 0) {
    const row = db.prepare(
        `SELECT 1 FROM users
     WHERE id <> ?
       AND (LOWER(username)=LOWER(?) OR LOWER(first_username)=LOWER(?))
     LIMIT 1`
    ).get(exceptUserId | 0, u, u);
    return !!row;
}
function emailValid(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '')); }
function phoneValid(p) { return /^\+?[0-9]{7,15}$/.test(String(p || '')); }

// server-side password policy (same as routes-auth)
function validatePassword(pw) {
    const s = String(pw || '');
    if (s.length < 7 || s.length > 31) return { ok: false, detail: 'Password must be 7–31 characters.' };
    if (!/[A-Z]/.test(s)) return { ok: false, detail: 'Add at least one uppercase letter.' };
    if (!/[0-9]/.test(s)) return { ok: false, detail: 'Add at least one number.' };
    if (!/[^A-Za-z0-9]/.test(s)) return { ok: false, detail: 'Add at least one symbol.' };
    return { ok: true };
}

// scrub public fields (no IDs, no email/phone)
// add to scrubPublic()
function scrubPublic(u, meId = 0) {
    if (!u) return null;
    return {
        username: u.username || null,
        first_username: u.first_username || null,
        profile_photo: u.profile_photo || null,
        bio_html: u.bio_html ?? null,     // <-- add
        bio: u.bio ?? null,               // <-- add
        received_likes: u.received_likes | 0,
        received_dislikes: u.received_dislikes | 0,
        created_at: u.created_at,
        updated_at: u.updated_at,
        is_me: !!(u.__owner_id && u.__owner_id === meId)
    };
}

// add columns to both queries:
const Q_PUBLIC_BY_FIRST = `
  SELECT
    username,
    first_username,
    profile_photo,
    bio_html,              -- <-- add
    bio,                   -- <-- add
    received_likes,
    received_dislikes,
    created_at,
    updated_at
  FROM users
  WHERE LOWER(first_username) = LOWER(?)
  LIMIT 1
`;

const Q_PUBLIC_BY_USERNAME = `
  SELECT
    username,
    first_username,
    profile_photo,
    bio_html,              -- <-- add
    bio,                   -- <-- add
    received_likes,
    received_dislikes,
    created_at,
    updated_at
  FROM users
  WHERE LOWER(username) = LOWER(?)
  LIMIT 1
`;

/* ---------------- routes ---------------- */

/**
 * GET /api/users/:slug
 * Public profile by first_username (case-insensitive)
 * Kept for compatibility with your existing frontend.
 */
router.get('/users/:slug', (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'bad_slug' });

    const meId = resolveUid(req);
    const row = db.prepare(Q_PUBLIC_BY_FIRST).get(slug);
    if (!row) return res.status(404).json({ error: 'not_found' });

    // Add ephemeral owner marker to compute is_me without returning ids
    const ownerId = db.prepare('SELECT id FROM users WHERE LOWER(first_username)=LOWER(?)').get(slug)?.id || 0;
    const user = scrubPublic({ ...row, __owner_id: ownerId }, meId);
    return res.json({ ok: true, user });
});

/**
 * GET /api/users/by-first/:slug
 * Same as above, explicit name.
 */
router.get('/users/by-first/:slug', (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'bad_slug' });

    const meId = resolveUid(req);
    const row = db.prepare(Q_PUBLIC_BY_FIRST).get(slug);
    if (!row) return res.status(404).json({ error: 'not_found' });

    const ownerId = db.prepare('SELECT id FROM users WHERE LOWER(first_username)=LOWER(?)').get(slug)?.id || 0;
    const user = scrubPublic({ ...row, __owner_id: ownerId }, meId);
    return res.json({ ok: true, user });
});

/**
 * PATCH /api/users/by-first/:slug
 * Edit profile (owner or admin).
 * Accepts { username?, email?, phone?, profile_photo?, password?, current_password? }
 */
router.patch('/users/by-first/:slug', requireAuth, async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const target = db.prepare(`
    SELECT id, username, first_username, email, phone, is_admin
    FROM users
    WHERE LOWER(first_username) = LOWER(?)
    LIMIT 1
  `).get(slug);
    if (!target) return res.status(404).json({ error: 'not_found' });

    const me = db.prepare(`SELECT id, is_admin FROM users WHERE id = ?`).get(req.userId);
    const amOwner = target.id === req.userId;
    const amAdmin = !!me?.is_admin;
    if (!amOwner && !amAdmin) return res.status(403).json({ error: 'forbidden' });

    const { username, email, profile_photo, password, current_password, phone, bio_html, bio } = req.body || {};

    // username validation (if provided)
    if (username !== undefined) {
        if (username === null || username === '') return res.status(400).json({ error: 'invalid_username' });
        if (!usernameValid(username)) return res.status(400).json({ error: 'invalid_username' });
        if (usernameBanned(username)) return res.status(400).json({ error: 'username_banned' });
        if (usernameTakenAnywhere(username, target.id)) return res.status(409).json({ error: 'username_taken' });
    }

    // email/phone format (if provided)
    if (email !== undefined && email !== null && email !== '' && !emailValid(email)) {
        return res.status(400).json({ error: 'invalid_email' });
    }
    if (phone !== undefined && phone !== null && phone !== '' && !phoneValid(phone)) {
        return res.status(400).json({ error: 'invalid_phone' });
    }

    // password flow (if provided)
    let newPwdHash = null;
    if (password !== undefined) {
        const v = validatePassword(password);
        if (!v.ok) return res.status(400).json({ error: 'weak_password', detail: v.detail });

        if (!amAdmin) {
            const cred = db.prepare('SELECT * FROM credentials WHERE user_id = ?').get(target.id);
            if (!cred) return res.status(400).json({ error: 'no_credentials' });
            const ok = await verifyPassword(cred.password_hash, String(current_password || ''));
            if (!ok) return res.status(401).json({ error: 'bad_current_password' });
        }
        newPwdHash = await hashPassword(String(password));
    }

    try {
        const updatedPublic = db.transaction(() => {
            // Uniqueness checks for email/phone when changing
            if (email !== undefined) {
                const dupEmail = db.prepare(
                    `SELECT 1 FROM users WHERE id <> ? AND email IS NOT NULL AND LOWER(email)=LOWER(?) LIMIT 1`
                ).get(target.id, email);
                if (dupEmail) { const e = new Error('email_taken'); e.code = 409; throw e; }
            }
            if (phone !== undefined && phone !== null && phone !== '') {
                const dupPhone = db.prepare(
                    `SELECT 1 FROM users WHERE id <> ? AND phone IS NOT NULL AND phone = ? LIMIT 1`
                ).get(target.id, phone);
                if (dupPhone) { const e = new Error('phone_taken'); e.code = 409; throw e; }
            }

            // Update users (only provided fields)
            // Update users (only provided fields)
            const sets = [];
            const params = [];

            // username
            if (username !== undefined) {
                sets.push('username = ?');
                params.push(username);
            }

            // email (tri-state: missing=keep, ''|null=clear, value=set)
            if (email !== undefined) {
                if (email === null || email === '') {
                    sets.push('email = NULL');
                } else {
                    sets.push('email = ?');
                    params.push(email);
                }
            }

            // phone (tri-state)
            if (phone !== undefined) {
                if (phone === null || phone === '') {
                    sets.push('phone = NULL');
                } else {
                    sets.push('phone = ?');
                    params.push(phone);
                }
            }

            // profile photo (let empty/null clear)
            if (profile_photo !== undefined) {
                if (profile_photo === null || profile_photo === '') {
                    sets.push('profile_photo = NULL');
                } else {
                    sets.push('profile_photo = ?');
                    params.push(profile_photo);
                }
            }

            // Bio (tri-state & dual-field: bio_html and bio kept in sync)
            if (bio_html !== undefined || bio !== undefined) {
                const val = (bio_html !== undefined ? bio_html : bio);
                if (val === null || val === '') {
                    sets.push('bio_html = NULL');
                    sets.push('bio = NULL');
                } else {
                    sets.push('bio_html = ?');
                    params.push(String(val));
                    sets.push('bio = ?');
                    params.push(String(val));
                }
            }

            if (sets.length) {
                db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
                    .run(...params, target.id);
            }

            // Update password if requested
            if (newPwdHash) {
                db.prepare(`
          INSERT INTO credentials (user_id, password_hash, algo)
          VALUES (?,?, 'argon2id')
          ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash, algo='argon2id'
        `).run(target.id, newPwdHash);
            }

            // Return fresh public row (no id)
            const pub = db.prepare(`
      SELECT username, first_username, profile_photo,
             bio_html, bio,                       -- <-- add
             received_likes, received_dislikes, created_at, updated_at
      FROM users WHERE id = ?
    `).get(target.id);

            return pub;
        })();

        const user = scrubPublic({ ...updatedPublic, __owner_id: target.id }, req.userId);
        return res.json({ ok: true, user });
    } catch (e) {
        if (e && (e.message === 'email_taken' || e.message === 'phone_taken')) {
            return res.status(409).json({ error: e.message });
        }
        console.error('PROFILE_UPDATE_ERR', e);
        return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
    }
});

/**
 * GET /api/users/by_username/:username
 * Public read by *current* username (case-insensitive)
 * Used by the comment author link resolver.
 */
router.get('/users/by_username/:username', (req, res) => {
    const uname = String(req.params.username || '').trim();
    if (!uname) return res.status(400).json({ error: 'missing_username' });

    const meId = resolveUid(req);
    const row = db.prepare(Q_PUBLIC_BY_USERNAME).get(uname);
    if (!row) return res.status(404).json({ error: 'not_found' });

    const ownerId = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(uname)?.id || 0;
    const user = scrubPublic({ ...row, __owner_id: ownerId }, meId);
    return res.json({ ok: true, user });
});

/**
 * GET /api/users/resolve?username=foo
 * Same as above but query param style.
 */
router.get('/users/resolve', (req, res) => {
    const uname = String(req.query.username || '').trim();
    if (!uname) return res.status(400).json({ error: 'missing_username' });

    const meId = resolveUid(req);
    const row = db.prepare(Q_PUBLIC_BY_USERNAME).get(uname);
    if (!row) return res.status(404).json({ error: 'not_found' });

    const ownerId = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(uname)?.id || 0;
    const user = scrubPublic({ ...row, __owner_id: ownerId }, meId);
    return res.json({ ok: true, user });
});

/**
 * GET /api/users/first_of/:username
 * Ultra-light resolver (only first_username) by current username (case-insensitive).
 * Optional, but handy if you ever want a minimal payload.
 */
router.get('/users/first_of/:username', (req, res) => {
    const uname = String(req.params.username || '').trim();
    if (!uname) return res.status(400).json({ error: 'missing_username' });
    const row = db.prepare(`SELECT first_username FROM users WHERE LOWER(username)=LOWER(?) LIMIT 1`).get(uname);
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, first_username: row.first_username });
});

// GET /api/users/:slug/activity?offset=0&limit=10
// Public: lists this user's own comments, ordered by plea_num desc, then newest first.
// Each item may include "parent" (the comment they replied to) for context.
router.get('/users/:slug/activity', (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'bad_slug' });

    // Find the target user id by first_username
    const userRow = db.prepare(
        `SELECT id FROM users WHERE LOWER(first_username)=LOWER(?) LIMIT 1`
    ).get(slug);
    if (!userRow) return res.status(404).json({ error: 'not_found' });

    const targetId = userRow.id;

    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10) || 10));

    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE user_id = ?`).get(targetId);
    const total = totalRow?.n | 0;

    // Pull a slice of this user's comments; join parent (if reply) for context
    const rows = db.prepare(`
    SELECT
      c.id, c.plea_num, c.parent_id, c.body, c.likes, c.dislikes, c.created_at, c.updated_at,
      pc.id AS parent_id_join, pc.body AS parent_body, pc.user_id AS parent_user_id, pc.created_at AS parent_created_at,
      pu.username AS parent_username, pu.first_username AS parent_first_username
    FROM comments c
    LEFT JOIN comments pc ON pc.id = c.parent_id
    LEFT JOIN users pu     ON pu.id = pc.user_id
    WHERE c.user_id = ?
    ORDER BY c.plea_num DESC, c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(targetId, limit, offset);

    const items = rows.map(r => ({
        id: r.id,
        plea_num: r.plea_num,
        body: r.body,
        parent_id: r.parent_id || null,
        likes: r.likes | 0,
        dislikes: r.dislikes | 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        // include context for replies
        parent: r.parent_id ? {
            id: r.parent_id_join,
            body: r.parent_body,
            author_username: r.parent_username || null,
            author_first_username: r.parent_first_username || null,
            created_at: r.parent_created_at
        } : null
    }));

    const has_more = offset + items.length < total;

    // Add viewer/owner hint so client can show Edit buttons only for owner
    const viewerId = (req.cookies && req.cookies.sid)
        ? (db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(req.cookies.sid)?.user_id || 0)
        : 0;

    res.json({ ok: true, total, offset, limit, has_more, items, is_me: viewerId === targetId });
});


/* ===================== SETTINGS ===================== */
/**
 * GET /api/users/me/settings
 * Returns private settings (consent, TOS version, region, language)
 */
router.get('/users/me/settings', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT consent_emails, tos_version, region, language FROM user_settings WHERE user_id = ?`).get(req.userId);
    res.json({ ok: true, settings: row || { consent_emails: 0, tos_version: null, region: null, language: null } });
});

/**
 * PATCH /api/users/me/settings
 * Body: { consent_emails?: boolean, tos_version?: string, region?: string, language?: string }
 */
router.patch('/users/me/settings', requireAuth, (req, res) => {
    let { consent_emails, tos_version, region, language } = req.body || {};

    // Normalize
    if (consent_emails !== undefined) consent_emails = !!consent_emails ? 1 : 0;
    if (tos_version !== undefined) tos_version = String(tos_version || '').slice(0, 32);
    if (region !== undefined) region = String(region || '').slice(0, 32);
    if (language !== undefined) language = String(language || '').slice(0, 32);

    db.transaction(() => {
        db.prepare(`
      INSERT INTO user_settings(user_id, consent_emails, tos_version, region, language)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        consent_emails = COALESCE(excluded.consent_emails, user_settings.consent_emails),
        tos_version    = COALESCE(excluded.tos_version,    user_settings.tos_version),
        region         = COALESCE(excluded.region,         user_settings.region),
        language       = COALESCE(excluded.language,       user_settings.language)
    `).run(
            req.userId,
            consent_emails ?? null,
            tos_version ?? null,
            region ?? null,
            language ?? null
        );
    })();

    const out = db.prepare(`SELECT consent_emails, tos_version, region, language FROM user_settings WHERE user_id = ?`).get(req.userId);
    res.json({ ok: true, settings: out });
});

/* ===================== FRIENDS (OG usernames) ===================== */
/**
 * POST /api/users/me/friends
 * Body: { username?: string, first_username?: string }
 * Saves friend relation using snapshot of friend's first_username (OG).
 */
router.post('/users/me/friends', requireAuth, (req, res) => {
    const { username, first_username } = req.body || {};
    const friend = resolveUserByEither(username, first_username);
    if (!friend) return res.status(404).json({ error: 'friend_not_found' });
    if (friend.id === req.userId) return res.status(400).json({ error: 'cannot_friend_self' });

    db.prepare(`
    INSERT INTO user_friends(user_id, friend_user_id, friend_first_username)
    VALUES (?,?,?)
    ON CONFLICT(user_id, friend_user_id) DO NOTHING
  `).run(req.userId, friend.id, friend.first_username);

    const rows = db.prepare(`
    SELECT f.friend_user_id, f.friend_first_username, u.username
    FROM user_friends f
    LEFT JOIN users u ON u.id = f.friend_user_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(req.userId);

    res.json({
        ok: true,
        friends: rows.map(r => ({
            username: r.username || null,
            first_username: r.friend_first_username
        }))
    });
});

/**
 * DELETE /api/users/me/friends/:username
 * Removes a friend (resolve by current username or OG name)
 */
/**
 * DELETE /api/users/me/friends/:username
 * Removes friend everywhere:
 *  - user_friends (your snapshot table)
 *  - friendships  (undirected a<b store)
 *  - friend_requests (any lingering requests either way)
 */
router.delete('/users/me/friends/:username', requireAuth, (req, res) => {
    const key = String(req.params.username || '').trim();
    if (!key) return res.status(400).json({ error: 'missing_username' });

    // Resolve by current username OR first_username
    const friend =
        resolveUserByEither(key, null) ||
        resolveUserByEither(null, key);

    if (!friend) return res.status(404).json({ error: 'friend_not_found' });

    const me = req.userId;
    const other = friend.id;
    const a = Math.min(me, other);
    const b = Math.max(me, other);

    const removed = { user_friends: 0, friendships: 0, friend_requests: 0 };

    const tx = db.transaction(() => {
        // Snapshot table (both directions)
        removed.user_friends += db.prepare(`
      DELETE FROM user_friends
      WHERE (user_id=? AND friend_user_id=?) OR (user_id=? AND friend_user_id=?)
    `).run(me, other, other, me).changes | 0;

        // Undirected canonical friendships (be liberal: delete either orientation)
        removed.friendships += db.prepare(`
      DELETE FROM friendships
      WHERE (user_id_a=? AND user_id_b=?) OR (user_id_a=? AND user_id_b=?)
    `).run(a, b, b, a).changes | 0;

        // Any pending/lingering requests between the pair
        removed.friend_requests += db.prepare(`
      DELETE FROM friend_requests
      WHERE (from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)
    `).run(me, other, other, me).changes | 0;
    });

    tx();

    console.log('[unfriend]', {
        me,
        other,
        key,
        removed
    });

    // Give you numbers to confirm it actually removed from the canonical table
    return res.status(200).json({ ok: true, removed });
});

/**
 * GET /api/users/me/friends
 */
router.get('/users/me/friends', requireAuth, (req, res) => {
    const rows = db.prepare(`
    SELECT f.friend_user_id, f.friend_first_username, u.username
    FROM user_friends f
    LEFT JOIN users u ON u.id = f.friend_user_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(req.userId);

    res.json({
        ok: true,
        friends: rows.map(r => ({
            username: r.username || null,
            first_username: r.friend_first_username
        }))
    });
});

/* ===================== BLOCKED USERS ===================== */
/**
 * POST /api/users/me/blocks
 * Body: { username?: string, first_username?: string }
 */
router.post('/users/me/blocks', requireAuth, (req, res) => {
    const { username, first_username } = req.body || {};
    const target = resolveUserByEither(username, first_username);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (target.id === req.userId) return res.status(400).json({ error: 'cannot_block_self' });

    db.prepare(`
    INSERT INTO user_blocks(user_id, blocked_user_id, blocked_first_username)
    VALUES (?,?,?)
    ON CONFLICT(user_id, blocked_user_id) DO NOTHING
  `).run(req.userId, target.id, target.first_username);

    res.json({ ok: true });
});

/**
 * DELETE /api/users/me/blocks/:username
 */
router.delete('/users/me/blocks/:username', requireAuth, (req, res) => {
    const key = String(req.params.username || '').trim();
    const target = resolveUserByEither(key, null) || resolveUserByEither(null, key);
    if (!target) return res.status(404).json({ error: 'user_not_found' });

    db.prepare(`DELETE FROM user_blocks WHERE user_id = ? AND blocked_user_id = ?`).run(req.userId, target.id);
    res.json({ ok: true });
});

/**
 * GET /api/users/me/blocks
 */
router.get('/users/me/blocks', requireAuth, (req, res) => {
    const rows = db.prepare(`
    SELECT b.blocked_user_id, b.blocked_first_username, u.username
    FROM user_blocks b
    LEFT JOIN users u ON u.id = b.blocked_user_id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).all(req.userId);

    res.json({
        ok: true,
        blocked: rows.map(r => ({
            username: r.username || null,
            first_username: r.blocked_first_username
        }))
    });
});

/* ===================== TIME SPENT (last 30 days) ===================== */
/**
 * POST /api/users/me/time
 * Body: { seconds: number, day?: "YYYY-MM-DD" (UTC) }
 * Accumulates seconds for a UTC day key.
 */
router.post('/users/me/time', requireAuth, (req, res) => {
    let { seconds, day } = req.body || {};
    seconds = clamp(seconds, 0, 24 * 60 * 60); // sane daily bound
    if (!seconds) return res.status(400).json({ error: 'missing_seconds' });

    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        day = dayKeyUTC();
    }

    db.prepare(`
    INSERT INTO user_time_daily(user_id, day, seconds)
    VALUES (?,?,?)
    ON CONFLICT(user_id, day) DO UPDATE SET seconds = user_time_daily.seconds + excluded.seconds
  `).run(req.userId, day, seconds);

    res.json({ ok: true });
});

/**
 * GET /api/users/me/time?days=30
 * Returns an array of { day, seconds, hours }
 */
router.get('/users/me/time', requireAuth, (req, res) => {
    const days = clamp(req.query.days || 30, 1, 90);
    const today = new Date();
    const keys = Array.from({ length: days }, (_, i) => {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        d.setUTCDate(d.getUTCDate() - i);
        return dayKeyUTC(d);
    }).reverse();

    const rows = db.prepare(`SELECT day, seconds FROM user_time_daily WHERE user_id = ? AND day BETWEEN ? AND ?`)
        .all(req.userId, keys[0], keys[keys.length - 1]);

    const map = new Map(rows.map(r => [r.day, r.seconds | 0]));
    const data = keys.map(k => {
        const s = map.get(k) | 0;
        return { day: k, seconds: s, hours: +(s / 3600).toFixed(3) };
    });

    res.json({ ok: true, days, data });
});

/* ===================== PLEAS FULLY READ ===================== */
/**
 * POST /api/users/me/reads
 * Body: { plea_num: integer }
 * Marks a plea as fully read (idempotent).
 */
router.post('/users/me/reads', requireAuth, (req, res) => {
    const plea_num = Number(req.body?.plea_num);
    if (!Number.isInteger(plea_num) || plea_num < 0) return res.status(400).json({ error: 'bad_plea_num' });

    db.prepare(`INSERT INTO plea_reads(user_id, plea_num) VALUES (?, ?) ON CONFLICT(user_id, plea_num) DO NOTHING`)
        .run(req.userId, plea_num);

    const count = db.prepare(`SELECT COUNT(*) AS n FROM plea_reads WHERE user_id = ?`).get(req.userId)?.n | 0;
    res.json({ ok: true, total_read: count });
});

/**
 * GET /api/users/me/reads/count
 */
router.get('/users/me/reads/count', requireAuth, (req, res) => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM plea_reads WHERE user_id = ?`).get(req.userId)?.n | 0;
    res.json({ ok: true, total_read: count });
});

/**
 * GET /api/users/me/reads
 * Optional: list back the IDs you’ve fully read
 */
router.get('/users/me/reads', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT plea_num, completed_at FROM plea_reads WHERE user_id = ? ORDER BY completed_at DESC`).all(req.userId);
    res.json({ ok: true, items: rows });
});

/* ===================== PRESENCE ===================== */
/**
 * POST /api/presence/ping
 * Body: { } (ignored). Marks viewer as online "now".
 */
router.post('/presence/ping', requireAuth, (req, res) => {
    db.prepare(`
    INSERT INTO user_presence(user_id, seen_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET seen_at = datetime('now')
  `).run(req.userId);
    res.json({ ok: true });
});

/* ===================== FRIENDS SUMMARY (owner only) ===================== */
/**
 * GET /api/users/me/friends/summary
 * Returns: { total, online, window_minutes }
 * "online" = seen within last 5 minutes according to user_presence.
 */
router.get('/users/me/friends/summary', requireAuth, (req, res) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM user_friends WHERE user_id = ?`).get(req.userId)?.n | 0;
    const windowMinutes = 5;
    const online = db.prepare(`
    SELECT COUNT(*) AS n
    FROM user_friends f
    JOIN user_presence p ON p.user_id = f.friend_user_id
    WHERE f.user_id = ?
      AND p.seen_at >= datetime('now', ?)
  `).get(req.userId, `-${windowMinutes} minutes`)?.n | 0;
    res.json({ ok: true, total, online, window_minutes: windowMinutes });
});

// Inspect all rows for me <-> :key across the three places
router.get('/__debug/pair/:key', requireAuth, (req, res) => {
    const key = String(req.params.key || '').trim();
    const friend =
        resolveUserByEither(key, null) ||
        resolveUserByEither(null, key);

    if (!friend) return res.status(404).json({ error: 'friend_not_found' });

    const me = req.userId;
    const other = friend.id;
    const a = Math.min(me, other);
    const b = Math.max(me, other);

    const out = {
        me, other, a, b,
        friendships: db.prepare(`
      SELECT * FROM friendships
      WHERE (user_id_a=? AND user_id_b=?) OR (user_id_a=? AND user_id_b=?)
    `).all(a, b, b, a),
        friend_requests: db.prepare(`
      SELECT * FROM friend_requests
      WHERE (from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)
    `).all(me, other, other, me),
        user_friends: db.prepare(`
      SELECT * FROM user_friends
      WHERE (user_id=? AND friend_user_id=?) OR (user_id=? AND friend_user_id=?)
    `).all(me, other, other, me)
    };

    res.json(out);
});

module.exports = { router };
