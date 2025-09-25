// server/routes-admin.js
const express = require('express');
const { db } = require('./db');

const router = express.Router();

/* --- auth gates --- */
function requireAuth(req, res, next) {
    const sid = req.cookies.sid;
    if (!sid) return res.status(401).json({ error: 'not_authenticated' });
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!sess) return res.status(401).json({ error: 'invalid_session' });
    req.userId = sess.user_id;
    next();
}
function requireAdmin(req, res, next) {
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    if (!u || u.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
}

/* --- helpers --- */
function csvEscape(v) {
    // Prevent CSV formula injection in Excel/Sheets
    const s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) return "'" + s;
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/* --- GET /api/admin/users  (JSON list, paginated, searchable) --- */
router.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 25));
    const offset = (page - 1) * pageSize;
    const q = (req.query.q || '').trim();

    let where = '1=1';
    const params = [];
    if (q) {
        where = '(u.email LIKE ? OR u.phone LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like);
    }

    const total = db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE ${where}`).get(...params).c;

    const rows = db.prepare(
        `SELECT
        u.id,
        u.email,
        u.phone,
        u.role,
        u.created_at,
        u.email_verified_at,
        u.phone_verified_at,
        COALESCE(t.is_enabled, 0) AS totp_enabled,
        (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
     FROM users u
     LEFT JOIN totp t ON t.user_id = u.id
     WHERE ${where}
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    res.json({ page, page_size: pageSize, total, items: rows });
});

/* --- GET /api/admin/users.csv  (CSV export; same fields, safe) --- */
router.get('/admin/users.csv', requireAuth, requireAdmin, (req, res) => {
    // reuse the JSON query by calling our own code would be nice, but we’ll inline for simplicity
    const q = (req.query.q || '').trim();
    let where = '1=1';
    const params = [];
    if (q) {
        where = '(u.email LIKE ? OR u.phone LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like);
    }
    const rows = db.prepare(
        `SELECT
        u.id, u.email, u.phone, u.role, u.created_at,
        u.email_verified_at, u.phone_verified_at,
        COALESCE(t.is_enabled, 0) AS totp_enabled,
        (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
     FROM users u
     LEFT JOIN totp t ON t.user_id = u.id
     WHERE ${where}
     ORDER BY u.created_at DESC`
    ).all(...params);

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="users.csv"');
    const header = [
        'id', 'email', 'phone', 'role', 'created_at',
        'email_verified_at', 'phone_verified_at',
        'totp_enabled', 'last_seen_at'
    ].join(',');
    const lines = rows.map(r =>
        [
            r.id, r.email, r.phone, r.role, r.created_at,
            r.email_verified_at, r.phone_verified_at,
            r.totp_enabled, r.last_seen_at
        ].map(csvEscape).join(',')
    );
    res.send([header, ...lines].join('\n'));
});

/* --- GET /api/admin/users/:id  (single user, safe fields) --- */
router.get('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    const uid = +req.params.id;
    const row = db.prepare(
        `SELECT
        u.id, u.email, u.phone, u.role, u.created_at,
        u.email_verified_at, u.phone_verified_at,
        COALESCE(t.is_enabled, 0) AS totp_enabled,
        (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
     FROM users u
     LEFT JOIN totp t ON t.user_id = u.id
     WHERE u.id = ?`
    ).get(uid);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ user: row });
});

module.exports = { router, requireAuth, requireAdmin };
