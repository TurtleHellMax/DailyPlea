// server/routes-admin.js
const express = require('express');
const { db } = require('./db');
const mailbox = require('./dev-mailbox');

const router = express.Router();

/* ---------- guards ---------- */
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

/* ---------- schema probes (once per process) ---------- */
const totpColRow =
    db.prepare("SELECT name FROM pragma_table_info('totp') WHERE name IN ('enabled','is_enabled') LIMIT 1").get() || null;
const TOTP_ENABLED_COL = totpColRow ? totpColRow.name : null;

const hasLastSeen =
    !!db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name='last_seen_at'").get();

const LAST_SEEN_EXPR = hasLastSeen
    ? "(SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id)"
    : "NULL";

/* ---------- helpers ---------- */
function csvEscape(v) {
    const s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) return "'" + s;
    if (/[\",\n]/.test(s)) return `"${s.replace(/\"/g, '\"\"')}"`;
    return s;
}

function selectUsersSQL(whereClause) {
    // Compose the totp_enabled projection safely for both schemas
    const totpEnabledExpr = TOTP_ENABLED_COL
        ? `COALESCE(t.${TOTP_ENABLED_COL}, 0)`
        : `CASE WHEN t.user_id IS NULL THEN 0 ELSE 1 END`;

    return `
    SELECT
      u.id,
      u.email,
      u.phone,
      u.role,
      u.created_at,
      u.email_verified_at,
      u.phone_verified_at,
      ${totpEnabledExpr} AS totp_enabled,
      ${LAST_SEEN_EXPR} AS last_seen_at
    FROM users u
    LEFT JOIN totp t ON t.user_id = u.id
    WHERE ${whereClause}
    ORDER BY u.created_at DESC
  `;
}

/* ---------- GET /api/admin/users (JSON, paginated) ---------- */
router.get('/users', requireAuth, requireAdmin, (req, res) => {
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

    const items = db.prepare(`${selectUsersSQL(where)} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);

    res.json({ page, page_size: pageSize, total, items });
});

/* ---------- GET /api/admin/users.csv (CSV export) ---------- */
router.get('/users.csv', requireAuth, requireAdmin, (req, res) => {
    const q = (req.query.q || '').trim();

    let where = '1=1';
    const params = [];
    if (q) {
        where = '(u.email LIKE ? OR u.phone LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like);
    }

    const rows = db.prepare(selectUsersSQL(where)).all(...params);

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="users.csv"');

    const header = [
        'id', 'email', 'phone', 'role', 'created_at',
        'email_verified_at', 'phone_verified_at', 'totp_enabled', 'last_seen_at'
    ].join(',');

    const lines = rows.map(r =>
        [r.id, r.email, r.phone, r.role, r.created_at, r.email_verified_at, r.phone_verified_at, r.totp_enabled, r.last_seen_at]
            .map(csvEscape).join(',')
    );

    res.send([header, ...lines].join('\n'));
});

router.get('/dev/outbox', requireAuth, requireAdmin, (req, res) => {
    const items = (mailbox.list?.() ?? mailbox.outbox ?? []).slice(-200).reverse();
    res.json({ items });
});

// POST /api/admin/dev/outbox/clear  -> wipe
router.post('/dev/outbox/clear', requireAuth, requireAdmin, (req, res) => {
    if (mailbox.clear) mailbox.clear();
    else if (Array.isArray(mailbox.outbox)) mailbox.outbox.length = 0;
    res.json({ ok: true });
});

module.exports = { router };
