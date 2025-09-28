// server/routes-users.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');
const { hashPassword, verifyPassword } = require('./security');

const router = express.Router();

/* ---------------- helpers ---------------- */

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
function scrubPublic(u, meId = 0) {
    if (!u) return null;
    return {
        username: u.username || null,
        first_username: u.first_username || null,
        profile_photo: u.profile_photo || null,
        received_likes: u.received_likes | 0,
        received_dislikes: u.received_dislikes | 0,
        created_at: u.created_at,
        updated_at: u.updated_at,
        is_me: !!(u.__owner_id && u.__owner_id === meId) // internal marker carried by queries below
    };
}

/* ---------------- queries ---------------- */

const Q_PUBLIC_BY_FIRST = `
  SELECT
    username,
    first_username,
    profile_photo,
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

    const { username, email, profile_photo, password, current_password, phone } = req.body || {};

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

module.exports = { router };
