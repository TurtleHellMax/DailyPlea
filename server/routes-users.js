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

// Use the same filename and semantics as routes-auth.js
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

function usernameValid(u) {
    return USERNAME_RE.test(String(u || '').trim());
}
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

// server-side password policy (same as routes-auth)
function validatePassword(pw) {
    const s = String(pw || '');
    if (s.length < 7 || s.length > 31) return { ok: false, detail: 'Password must be 7–31 characters.' };
    if (!/[A-Z]/.test(s)) return { ok: false, detail: 'Add at least one uppercase letter.' };
    if (!/[0-9]/.test(s)) return { ok: false, detail: 'Add at least one number.' };
    if (!/[^A-Za-z0-9]/.test(s)) return { ok: false, detail: 'Add at least one symbol.' };
    return { ok: true };
}

function emailValid(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '')); }
function phoneValid(p) { return /^\+?[0-9]{7,15}$/.test(String(p || '')); }

/* ---------------- routes ---------------- */

/**
 * GET /api/users/:slug
 * Public profile by first_username (case-insensitive)
 */
router.get('/users/:slug', (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'bad_slug' });

    const u = db.prepare(`
    SELECT id, username, first_username, profile_photo,
           created_at, received_likes, received_dislikes
    FROM users
    WHERE LOWER(first_username) = LOWER(?)
    LIMIT 1
  `).get(slug);

    if (!u) return res.status(404).json({ error: 'not_found' });
    res.json({ user: u });
});

/**
 * GET /api/users/by-first/:slug
 * Same as above but explicitly named; scrubs PII for non-owners
 */
router.get('/users/by-first/:slug', (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'bad_slug' });

    const u = db.prepare(`
    SELECT id, username, first_username, email, phone, profile_photo,
           created_at, received_likes, received_dislikes, is_admin
    FROM users
    WHERE LOWER(first_username) = LOWER(?)
    LIMIT 1
  `).get(slug);

    if (!u) return res.status(404).json({ error: 'not_found' });

    const me = resolveUid(req);
    const is_me = me === u.id;

    const scrubbed = {
        id: u.id,
        username: u.username,
        first_username: u.first_username,
        profile_photo: u.profile_photo,
        created_at: u.created_at,
        received_likes: u.received_likes,
        received_dislikes: u.received_dislikes,
        is_me
    };
    res.json({ ok: true, user: scrubbed });
});

/**
 * PATCH /api/users/by-first/:slug
 * Edit profile (owner or admin). Accepts { username?, email?, phone?, profile_photo?, password?, current_password? }
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
        if (username === null || username === '') {
            return res.status(400).json({ error: 'invalid_username' });
        }
        if (!usernameValid(username)) return res.status(400).json({ error: 'invalid_username' });
        if (usernameBanned(username)) return res.status(400).json({ error: 'username_banned' });
        if (usernameTakenAnywhere(username, target.id)) {
            return res.status(409).json({ error: 'username_taken' });
        }
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
        const out = db.transaction(() => {
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
            if (username !== undefined || email !== undefined || profile_photo !== undefined || phone !== undefined) {
                db.prepare(`
          UPDATE users
             SET username = COALESCE(?, username),
                 email = CASE WHEN ? IS NULL OR ? = '' THEN NULL ELSE ? END,
                 phone = CASE WHEN ? IS NULL OR ? = '' THEN NULL ELSE ? END,
                 profile_photo = COALESCE(?, profile_photo)
           WHERE id = ?
        `).run(
                    username ?? null,
                    email, email, email,
                    phone, phone, phone,
                    profile_photo ?? null,
                    target.id
                );
            }

            // Update password if requested
            if (newPwdHash) {
                db.prepare(`
          INSERT INTO credentials (user_id, password_hash, algo)
          VALUES (?,?, 'argon2id')
          ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash, algo='argon2id'
        `).run(target.id, newPwdHash);
            }

            return db.prepare(`
        SELECT id, username, first_username, profile_photo, created_at,
               received_likes, received_dislikes
        FROM users WHERE id = ?
      `).get(target.id);
        })();

        const meId = resolveUid(req);
        res.json({ ok: true, user: { ...out, is_me: meId === target.id } });
    } catch (e) {
        if (e && (e.message === 'email_taken' || e.message === 'phone_taken')) {
            return res.status(409).json({ error: e.message });
        }
        console.error('PROFILE_UPDATE_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
    }
});

module.exports = { router };
