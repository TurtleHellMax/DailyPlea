// server/routes-auth.js
const express = require('express');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const { db } = require('./db');
const mailbox = require('./dev-mailbox'); // <- dev inbox
const {
    hashPassword,
    verifyPassword,
    aesEncrypt,
    aesDecrypt,
    newId,
} = require('./security');

const router = express.Router();

/* ========= username helpers ========= */

// load banned usernames from optional text file (one per line)
const BANNED_FILE = path.join(__dirname, 'banned-usernames.txt');
const BANNED_SET = new Set();
try {
    const txt = fs.readFileSync(BANNED_FILE, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
        const s = line.trim().toLowerCase();
        if (s && !s.startsWith('#')) BANNED_SET.add(s);
    }
} catch { /* file optional */ }

// hard-reserved slugs/words that should never be usernames
const RESERVED = new Set([
    'admin', 'administrator', 'root', 'system', 'support', 'help', 'security', 'staff', 'moderator', 'mod',
    'api', 'v1', 'v2', 'v3', 'auth', 'login', 'logout', 'register', 'signup', 'sign-in',
    'user', 'users', 'me', 'you', 'owner', 'null', 'undefined',
    'comments', 'comment', 'plea', 'pleas', 'web', 'assets', 'static'
]);

const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;

function normalizeUsername(u) {
    return String(u || '').trim();
}
function isUsernameFormatOk(u) {
    return USERNAME_RE.test(u);
}
function isUsernameBanned(u) {
    const lc = u.toLowerCase();
    return BANNED_SET.has(lc) || RESERVED.has(lc);
}
function usernameExistsAnywhere(u) {
    // Case-insensitive check against BOTH current usernames and immutable slugs
    const row = db.prepare(
        `SELECT 1 AS n FROM users
     WHERE LOWER(username) = LOWER(?) OR LOWER(first_username) = LOWER(?)
     LIMIT 1`
    ).get(u, u);
    return !!row;
}

/* ========= password policy (server-side) =========
   7–31 chars, at least one uppercase, one number, and one symbol
-------------------------------------------------- */
function validatePassword(pw) {
    const s = String(pw || '');
    if (s.length < 7 || s.length > 31) {
        return { ok: false, reason: 'length', detail: 'Password must be 7–31 characters.' };
    }
    if (!/[A-Z]/.test(s)) return { ok: false, reason: 'uppercase', detail: 'Add at least one uppercase letter.' };
    if (!/[0-9]/.test(s)) return { ok: false, reason: 'number', detail: 'Add at least one number.' };
    if (!/[^A-Za-z0-9]/.test(s)) return { ok: false, reason: 'symbol', detail: 'Add at least one symbol.' };
    return { ok: true };
}

/* ========= helpers ========= */

function getUserByEmailOrPhone(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;
    return db.prepare(
        `SELECT * FROM users
     WHERE (email IS NOT NULL AND LOWER(email) = LOWER(?))
        OR (phone IS NOT NULL AND phone = ?)
     LIMIT 1`
    ).get(id, id);
}

function createSession(res, userId, req) {
    const sid = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
        .run(sid, userId, expiresAt);

    const SECURE = process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';
    res.cookie('sid', sid, {
        httpOnly: true, sameSite: 'lax', secure: SECURE,
        maxAge: 30 * 24 * 60 * 60 * 1000, path: '/'
    });
}

function requireAuth(req, res, next) {
    const sid = req.cookies.sid;
    if (!sid) return res.status(401).json({ error: 'not_authenticated' });
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.status(401).json({ error: 'invalid_session' });
    try { db.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(sid); } catch { }
    req.userId = sess.user_id;
    next();
}

/* ========= Email OTP (dev 2FA) ========= */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function generateSix() {
    return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function issueEmailOtp(user) {
    const code = generateSix();
    const codeHash = sha256(code);
    const exp = new Date(Date.now() + OTP_TTL_MS).toISOString();
    db.prepare('INSERT INTO email_otp (user_id, code_hash, expires_at) VALUES (?,?,?)')
        .run(user.id, codeHash, exp);

    const dest = user.email || user.phone || 'unknown';
    mailbox.send(
        'email',
        dest,
        'Your DailyPlea 2FA Code',
        `Your code is: ${code}\nIt expires in 10 minutes.`
    );
}

function verifyEmailOtp(userId, code) {
    const hash = sha256(String(code || ''));
    const row = db.prepare(`
    SELECT * FROM email_otp
     WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
     ORDER BY id DESC LIMIT 1
  `).get(userId, hash);
    if (!row) return { ok: false, reason: 'email_otp_invalid' };
    if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'email_otp_expired' };
    db.prepare('UPDATE email_otp SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    return { ok: true };
}

/* ========= Register (REQUIRES username) ========= */
router.post('/register', async (req, res) => {
    try {
        const { email = null, phone = null, password, username } = req.body || {};

        // Basic field presence
        if ((!email && !phone) || !password || !username) {
            return res.status(400).json({ error: 'missing_fields', need: ['email_or_phone', 'password', 'username'] });
        }

        // Validate username
        const uname = normalizeUsername(username);
        if (!isUsernameFormatOk(uname)) {
            return res.status(400).json({
                error: 'invalid_username',
                detail: 'Use 3–24 characters: letters, numbers, underscore.'
            });
        }
        if (isUsernameBanned(uname)) {
            return res.status(400).json({ error: 'username_banned' });
        }
        if (usernameExistsAnywhere(uname)) {
            return res.status(409).json({ error: 'username_taken' });
        }

        // Validate contacts
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return res.status(400).json({ error: 'invalid_email' });
        }
        if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) {
            return res.status(400).json({ error: 'invalid_phone' });
        }

        // Password policy
        const pw = validatePassword(password);
        if (!pw.ok) {
            return res.status(400).json({ error: 'weak_password', detail: pw.detail });
        }

        // Ensure email/phone not already in use
        const exists = db.prepare(
            `SELECT 1 FROM users
       WHERE (email = ? AND email IS NOT NULL)
          OR (phone = ? AND phone IS NOT NULL)
       LIMIT 1`
        ).get(email || null, phone || null);
        if (exists) return res.status(409).json({ error: 'user_exists' });

        // Hash + insert
        const hash = await hashPassword(password);

        const insertUser = db.prepare(
            'INSERT INTO users (email, phone, username, first_username) VALUES (?,?,?,?)'
        );
        const insertCred = db.prepare(
            'INSERT INTO credentials (user_id, password_hash, algo) VALUES (?,?,?)'
        );

        const tx = db.transaction((em, ph, un, pwHash) => {
            const r = insertUser.run(em || null, ph || null, un, un /* first_username = initial choice */);
            insertCred.run(r.lastInsertRowid, pwHash, 'argon2id');
            return r.lastInsertRowid;
        });

        const userId = tx(email, phone, uname, hash);

        createSession(res, userId, req);
        res.json({ ok: true, userId, username: uname });
    } catch (err) {
        if (/SQLITE_CONSTRAINT|UNIQUE/i.test(String(err))) {
            // could be username, first_username, email, or phone unique hits
            return res.status(409).json({ error: 'conflict', detail: String(err.message || err) });
        }
        console.error('REGISTER_ERROR:', err);
        res.status(500).json({ error: 'server_error', detail: String(err?.message || err) });
    }
});

/* ========= Login (password + TOTP or Email OTP) ========= */
router.post('/login', async (req, res) => {
    try {
        const { identifier, password, totp } = req.body || {};
        if (!identifier || !password) return res.status(400).json({ error: 'missing_fields' });

        const user = getUserByEmailOrPhone(identifier);
        if (!user) return res.status(401).json({ error: 'bad_credentials' });

        const cred = db.prepare('SELECT * FROM credentials WHERE user_id = ?').get(user.id);
        if (!cred) return res.status(401).json({ error: 'bad_credentials' });

        const ok = await verifyPassword(cred.password_hash, password);
        if (!ok) return res.status(401).json({ error: 'bad_credentials' });

        // If TOTP is enabled -> require TOTP
        const totpRow = db.prepare('SELECT * FROM totp WHERE user_id = ?').get(user.id);
        if (totpRow && (totpRow.enabled === 1 || totpRow.enabled === true)) {
            if (!totp) return res.status(401).json({ error: 'totp_required' });
            const secret = aesDecrypt(totpRow.secret_ciphertext);
            const verified = speakeasy.totp.verify({ secret, encoding: 'ascii', token: String(totp), window: 1 });
            if (!verified) return res.status(401).json({ error: 'totp_invalid' });
            createSession(res, user.id, req);
            return res.json({ ok: true });
        }

        // Optional dev email 2FA
        if (process.env.DEV_EMAIL_2FA === '1' && (user.email || user.phone)) {
            if (!totp) {
                issueEmailOtp(user);
                return res.status(401).json({ error: 'email_otp_required', delivery: 'email' });
            }
            const v = verifyEmailOtp(user.id, totp);
            if (!v.ok) return res.status(401).json({ error: v.reason });
            createSession(res, user.id, req);
            return res.json({ ok: true });
        }

        // No second factor
        createSession(res, user.id, req);
        res.json({ ok: true });
    } catch (err) {
        console.error('LOGIN_ERROR:', err);
        res.status(500).json({ error: 'server_error', detail: String(err?.message || err) });
    }
});

/* ========= Logout / Me ========= */
router.post('/logout', (req, res) => {
    const sid = req.cookies.sid;
    if (sid) { try { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); } catch { } }
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
});

router.get('/me', (req, res) => {
    const sid = req.cookies.sid;
    if (!sid) return res.json({ user: null });
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.json({ user: null });
    const user = db.prepare(`
    SELECT id, email, phone, role, username, first_username, created_at
    FROM users WHERE id = ?
  `).get(sess.user_id);
    res.json({ user: user || null });
});

/* ========= TOTP 2FA (authenticator app) ========= */
router.post('/2fa/enable', requireAuth, async (req, res) => {
    const userId = req.userId;
    const secret = speakeasy.generateSecret({ length: 20, name: 'DailyPlea (PoC)' });
    const pngDataUrl = await qrcode.toDataURL(secret.otpauth_url);
    const ciphertext = aesEncrypt(secret.ascii);
    db.prepare('INSERT OR REPLACE INTO totp (user_id, secret_ciphertext, enabled) VALUES (?,?,0)').run(userId, ciphertext);
    res.json({ ok: true, qrcodeDataUrl: pngDataUrl });
});

router.post('/2fa/verify', requireAuth, (req, res) => {
    const { token } = req.body || {};
    const row = db.prepare('SELECT * FROM totp WHERE user_id = ?').get(req.userId);
    if (!row) return res.status(400).json({ error: 'not_initialized' });
    const secret = aesDecrypt(row.secret_ciphertext);
    const verified = speakeasy.totp.verify({ secret, encoding: 'ascii', token: String(token), window: 1 });
    if (!verified) return res.status(400).json({ error: 'totp_invalid' });
    db.prepare('UPDATE totp SET enabled = 1 WHERE user_id = ?').run(req.userId);
    res.json({ ok: true });
});

/* ========= Password reset (with link) ========= */
router.post('/password/reset/request', (req, res) => {
    const { identifier } = req.body || {};
    if (!identifier) return res.status(400).json({ error: 'identifier_required' });

    const user = getUserByEmailOrPhone(identifier);
    if (!user) return res.json({ ok: true }); // do not leak

    const token = newId(16);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)')
        .run(user.id, tokenHash, exp);

    const base = process.env.CLIENT_ORIGIN || 'http://localhost:5500';
    const link = `${base}/web/reset.html?token=${encodeURIComponent(token)}&id=${encodeURIComponent(user.email || user.phone)}`;

    mailbox.send(
        'email',
        user.email || user.phone || 'unknown',
        'Password Reset',
        `Click to reset your password:\n${link}\n\nOr paste this token on the reset page: ${token}\nThis link/token expires in 1 hour.`
    );

    res.json({ ok: true });
});

router.post('/password/reset/confirm', async (req, res) => {
    const { identifier, token, newPassword } = req.body || {};
    if (!identifier || !token || !newPassword) return res.status(400).json({ error: 'missing_fields' });

    const user = getUserByEmailOrPhone(identifier);
    if (!user) return res.status(400).json({ error: 'bad_token' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare(
        'SELECT * FROM password_resets WHERE user_id = ? AND token_hash = ? AND used_at IS NULL'
    ).get(user.id, tokenHash);
    if (!row) return res.status(400).json({ error: 'bad_token' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'token_expired' });

    // Enforce password policy on reset too
    const pw = validatePassword(newPassword);
    if (!pw.ok) return res.status(400).json({ error: 'weak_password', detail: pw.detail });

    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE credentials SET password_hash = ? WHERE user_id = ?').run(hash, user.id);
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    res.json({ ok: true });
});

module.exports = { router, requireAuth };
