// routes-auth.js
const express = require('express');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const { db } = require('./db');
const {
    hashPassword,
    verifyPassword,
    newId,
    validators,
    aesEncrypt,
    aesDecrypt,
} = require('./security');
const mailbox = require('./dev-mailbox');

const router = express.Router();

/* ---------- helpers ---------- */
function getUserByEmailOrPhone(identifier) {
    return db
        .prepare('SELECT * FROM users WHERE email = ? OR phone = ?')
        .get(identifier, identifier);
}

function createSession(res, userId, req) {
    const ttlHours = +(process.env.SESSION_TTL_HOURS || 168);
    const sid = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    db.prepare(
        'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)'
    ).run(sid, userId, req.ip, req.get('user-agent'));
    res.cookie('sid', sid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // set true when on HTTPS
        maxAge: ttlHours * 3600 * 1000,
    });
}

function requireAuth(req, res, next) {
    const sid = req.cookies.sid;
    if (!sid) return res.status(401).json({ error: 'not_authenticated' });
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.status(401).json({ error: 'invalid_session' });
    if (new Date(sess.expires_at) < new Date())
        return res.status(401).json({ error: 'session_expired' });
    req.userId = sess.user_id;
    db.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(sid);
    next();
}

/* ---------- me (session introspection) ----------
   Returns { user: {...} } if logged in, or { user: null } otherwise. */
router.get('/me', (req, res) => {
    const sid = req.cookies.sid;
    if (!sid) return res.json({ user: null });
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.json({ user: null });

    const user = db
        .prepare(
            'SELECT id, email, phone, role, email_verified_at, phone_verified_at FROM users WHERE id = ?'
        )
        .get(sess.user_id);
    if (!user) return res.json({ user: null });

    const totp = db
        .prepare('SELECT is_enabled AS enabled FROM totp WHERE user_id = ?')
        .get(sess.user_id);

    res.json({ user: { ...user, totp_enabled: !!(totp && totp.enabled) } });
});

router.post('/register', async (req, res) => {
    const { email, phone, password } = req.body || {};
    try {
        if (!email && !phone) return res.status(400).json({ error: 'email_or_phone_required' });
        if (email) validators.email.parse(email);
        if (phone) validators.phone.parse(phone);
        validators.password.parse(password);

        const exists = db
            .prepare('SELECT 1 FROM users WHERE email = ? OR phone = ?')
            .get(email || null, phone || null);
        if (exists) return res.status(409).json({ error: 'user_exists' });

        const hash = await hashPassword(password);

        // atomic insert
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
    } catch (e) {
        // Distinguish validation vs. internal
        const msg = String(e?.message || e);
        if (/ZodError/i.test(msg)) return res.status(400).json({ error: 'invalid_input' });
        // unique constraint safety
        if (/SQLITE_CONSTRAINT|UNIQUE/.test(msg)) return res.status(409).json({ error: 'user_exists' });
        console.error('REGISTER_ERROR:', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* ---------- login (with optional TOTP) ---------- */
router.post('/login', async (req, res) => {
    const { identifier, password, totp } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'missing_fields' });

    const user = getUserByEmailOrPhone(identifier);
    if (!user) return res.status(401).json({ error: 'bad_credentials' });

    const cred = db.prepare('SELECT * FROM credentials WHERE user_id = ?').get(user.id);
    if (!cred) return res.status(401).json({ error: 'bad_credentials' });

    const ok = await verifyPassword(cred.password_hash, password);
    if (!ok) return res.status(401).json({ error: 'bad_credentials' });

    // 2FA: if enabled, require a valid code
    const totpRow = db
        .prepare('SELECT is_enabled, secret_ciphertext FROM totp WHERE user_id = ?')
        .get(user.id);
    if (totpRow && totpRow.is_enabled) {
        if (!totp) return res.status(401).json({ error: 'totp_required' });
        const secret = aesDecrypt(totpRow.secret_ciphertext);
        const verified = speakeasy.totp.verify({
            secret,
            encoding: 'ascii',
            token: String(totp),
            window: 1,
        });
        if (!verified) return res.status(401).json({ error: 'totp_invalid' });
    }

    createSession(res, user.id, req);
    res.json({ ok: true });
});

/* ---------- logout ---------- */
router.post('/logout', (req, res) => {
    const sid = req.cookies.sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    res.clearCookie('sid');
    res.json({ ok: true });
});

/* ---------- password reset: request ---------- */
router.post('/password/reset/request', (req, res) => {
    const { identifier } = req.body || {};
    if (!identifier) return res.status(400).json({ error: 'identifier_required' });
    const user = getUserByEmailOrPhone(identifier);
    if (!user) return res.json({ ok: true }); // don't leak existence
    const token = newId(16);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)').run(
        user.id,
        tokenHash,
        exp
    );
    if (process.env.DEV_MAILBOX === '1') {
        mailbox.send(
            'email',
            user.email || user.phone || 'unknown',
            'Password Reset (PoC)',
            `Reset token: ${token}`
        );
    }
    res.json({ ok: true });
});

/* ---------- password reset: confirm ---------- */
router.post('/password/reset/confirm', async (req, res) => {
    const { identifier, token, newPassword } = req.body || {};
    if (!identifier || !token || !newPassword)
        return res.status(400).json({ error: 'missing_fields' });

    const user = getUserByEmailOrPhone(identifier);
    if (!user) return res.status(400).json({ error: 'bad_token' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db
        .prepare(
            'SELECT * FROM password_resets WHERE user_id = ? AND token_hash = ? AND used_at IS NULL'
        )
        .get(user.id, tokenHash);
    if (!row) return res.status(400).json({ error: 'bad_token' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'token_expired' });

    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE credentials SET password_hash = ? WHERE user_id = ?').run(hash, user.id);
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

    res.json({ ok: true });
});

/* ---------- 2FA setup (generate QR) ---------- */
router.post('/2fa/enable', requireAuth, async (req, res) => {
    const userId = req.userId;
    const secret = speakeasy.generateSecret({ length: 20, name: 'DailyPlea (PoC)' });
    const pngDataUrl = await qrcode.toDataURL(secret.otpauth_url);
    const ciphertext = aesEncrypt(secret.ascii);
    db.prepare(
        'INSERT OR REPLACE INTO totp (user_id, secret_ciphertext, is_enabled) VALUES (?,?,0)'
    ).run(userId, ciphertext);
    res.json({ ok: true, qrcodeDataUrl: pngDataUrl });
});

/* ---------- 2FA verify (turn on) ---------- */
router.post('/2fa/verify', requireAuth, (req, res) => {
    const { token } = req.body || {};
    const row = db
        .prepare('SELECT is_enabled, secret_ciphertext FROM totp WHERE user_id = ?')
        .get(req.userId);
    if (!row) return res.status(400).json({ error: 'not_initialized' });

    const secret = aesDecrypt(row.secret_ciphertext);
    const verified = speakeasy.totp.verify({
        secret,
        encoding: 'ascii',
        token: String(token),
        window: 1,
    });
    if (!verified) return res.status(400).json({ error: 'totp_invalid' });

    db.prepare('UPDATE totp SET is_enabled = 1 WHERE user_id = ?').run(req.userId);
    res.json({ ok: true });
});

module.exports = { router, requireAuth };
