// server/routes-auth.js
const express = require('express');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const { db } = require('./db');
const {
    hashPassword,
    verifyPassword,
    // createSession,  // <- DO NOT import (it’s not exported in your security.js)
    aesEncrypt,
    aesDecrypt,
    newId,
} = require('./security');

const router = express.Router();

/* ========= local helpers ========= */

function getUserByEmailOrPhone(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;
    // IMPORTANT: 2 placeholders => pass 2 params
    return db.prepare(
        `SELECT * FROM users
     WHERE (email IS NOT NULL AND LOWER(email) = LOWER(?))
        OR (phone IS NOT NULL AND phone = ?)
     LIMIT 1`
    ).get(id, id);
}

// Minimal, DB-backed session creator (sets a signed-in cookie)
function createSession(res, userId, req) {
    const sid = crypto.randomBytes(16).toString('hex');

    // 30 days from now
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Insert only the columns we KNOW exist + the NOT NULL one (expires_at)
    // If your schema also has last_seen_at/ip/ua with defaults, that's fine.
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
        .run(sid, userId, expiresAt);

    const SECURE = process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';
    const MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

    res.cookie('sid', sid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: SECURE,
        maxAge: MAX_AGE,
        path: '/', // whole site
    });
}

function requireAuth(req, res, next) {
    const sid = req.cookies.sid;
    if (!sid) return res.status(401).json({ error: 'not_authenticated' });

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.status(401).json({ error: 'invalid_session' });

    // Best-effort heartbeat
    try { db.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(sid); } catch { }
    req.userId = sess.user_id;
    next();
}

/* ========= routes ========= */

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { email = null, phone = null, password } = req.body || {};
        if ((!email && !phone) || !password) return res.status(400).json({ error: 'missing_fields' });

        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
        if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
        if (String(password).length < 8) return res.status(400).json({ error: 'weak_password' });

        const exists = db.prepare('SELECT 1 FROM users WHERE email = ? OR phone = ?').get(email || null, phone || null);
        if (exists) return res.status(409).json({ error: 'user_exists' });

        const hash = await hashPassword(password);

        const insertUser = db.prepare('INSERT INTO users (email, phone) VALUES (?, ?)');
        const insertCred = db.prepare('INSERT INTO credentials (user_id, password_hash, algo) VALUES (?,?,?)');

        const tx = db.transaction((em, ph, pwHash) => {
            const r = insertUser.run(em || null, ph || null);
            insertCred.run(r.lastInsertRowid, pwHash, 'argon2id');
            return r.lastInsertRowid;
        });

        const userId = tx(email, phone, hash);

        createSession(res, userId, req);
        res.json({ ok: true, userId });
    } catch (err) {
        if (/SQLITE_CONSTRAINT|UNIQUE/i.test(String(err))) return res.status(409).json({ error: 'user_exists' });
        console.error('REGISTER_ERROR:', err);
        res.status(500).json({ error: 'server_error', detail: String(err?.message || err) });
    }
});

// POST /api/auth/login
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

        // Optional TOTP
        const totpRow = db.prepare('SELECT * FROM totp WHERE user_id = ?').get(user.id);
        if (totpRow && (totpRow.enabled === 1 || totpRow.enabled === true)) {
            if (!totp) return res.status(401).json({ error: 'totp_required' });
            const secret = aesDecrypt(totpRow.secret_ciphertext);
            const verified = speakeasy.totp.verify({ secret, encoding: 'ascii', token: String(totp), window: 1 });
            if (!verified) return res.status(401).json({ error: 'totp_invalid' });
        }

        createSession(res, user.id, req);
        res.json({ ok: true });
    } catch (err) {
        console.error('LOGIN_ERROR:', err);
        res.status(500).json({ error: 'server_error', detail: String(err?.message || err) });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    const sid = req.cookies.sid;
    if (sid) {
        try { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); } catch { }
    }
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
    const sid = req.cookies.sid;
    if (!sid) return res.json({ user: null });

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.json({ user: null });

    const user = db.prepare('SELECT id, email, phone, role, created_at FROM users WHERE id = ?').get(sess.user_id);
    res.json({ user: user || null });
});

// POST /api/auth/2fa/enable
router.post('/2fa/enable', requireAuth, async (req, res) => {
    const userId = req.userId;
    const secret = speakeasy.generateSecret({ length: 20, name: 'DailyPlea (PoC)' });
    const pngDataUrl = await qrcode.toDataURL(secret.otpauth_url);
    const ciphertext = aesEncrypt(secret.ascii);

    db.prepare('INSERT OR REPLACE INTO totp (user_id, secret_ciphertext, enabled) VALUES (?,?,0)')
        .run(userId, ciphertext);

    res.json({ ok: true, qrcodeDataUrl: pngDataUrl });
});

// POST /api/auth/2fa/verify
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

// POST /api/auth/password/reset/request
router.post('/password/reset/request', (req, res) => {
    const { identifier } = req.body || {};
    if (!identifier) return res.status(400).json({ error: 'identifier_required' });

    const user = getUserByEmailOrPhone(identifier);
    if (!user) return res.json({ ok: true }); // don't leak existence

    const token = newId(16);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)')
        .run(user.id, tokenHash, exp);

    try {
        const mailbox = require('./dev-mailbox');
        if (process.env.DEV_MAILBOX === '1' && mailbox?.send) {
            mailbox.send('email', user.email || user.phone || 'unknown', 'Password Reset', `Reset token (PoC): ${token}`);
        }
    } catch { }

    res.json({ ok: true });
});

// POST /api/auth/password/reset/confirm
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

    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE credentials SET password_hash = ? WHERE user_id = ?').run(hash, user.id);
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

    res.json({ ok: true });
});

module.exports = { router, requireAuth };
