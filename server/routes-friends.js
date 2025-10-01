const express = require('express');
const { db } = require('./db');

const router = express.Router();

/* ========= helpers ========= */
function pickUser(u) {
    return u && {
        id: u.id,
        username: u.username,
        first_username: u.first_username,
        profile_photo: u.profile_photo,
        bio_html: u.bio_html,
        bio: u.bio
    };
}
function orderPair(a, b) {
    return a < b ? [a, b] : [b, a];
}
function getAuthedUserId(req) {
    // Fast-path: dev header (allowed in CORS)
    const h = req.get('x-user-id');
    if (h && /^\d+$/.test(h)) return +h;

    // Cookie-based fallback (matches sessions schema you have)
    const sid = req.cookies?.sid || req.cookies?.session || req.cookies?.token;
    if (sid) {
        const row = db.prepare(`SELECT user_id FROM sessions WHERE id=? OR sid=? LIMIT 1`).get(sid, sid);
        if (row) return row.user_id;
    }
    return null;
}
function requireAuth(req, res, next) {
    const uid = getAuthedUserId(req);
    if (!uid) return res.status(401).json({ error: 'auth_required' });
    req.userId = uid;
    next();
}
function findUserBySlugOrId(slug) {
    if (/^\d+$/.test(slug)) {
        return db.prepare(`SELECT * FROM users WHERE id=?`).get(+slug);
    }
    // slug could be first_username or username
    return db.prepare(`
    SELECT * FROM users
    WHERE lower(first_username) = lower(?) OR lower(username) = lower(?)
    LIMIT 1
  `).get(slug, slug);
}

router.get('/users/by-first/:slug', (req, res) => {
    const s = String(req.params.slug || '').trim();
    const row = db.prepare(`
    SELECT id, username, first_username, profile_photo, bio_html, bio
    FROM users
    WHERE lower(first_username) = lower(?) OR lower(username) = lower(?)
    LIMIT 1
  `).get(s, s);

    if (!row) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: row });
});
/* ========= requests ========= */

/** GET /api/friends/requests?direction=in|out  (current user) */
router.get('/friends/requests', requireAuth, (req, res) => {
    const dir = (req.query.direction || 'in').toLowerCase();
    if (!['in', 'out'].includes(dir)) return res.status(400).json({ error: 'bad_direction' });

    const sqlIn = `
    SELECT fr.id, fr.from_user_id, fr.to_user_id, fr.status,
           fu.*, tu.*
    FROM friend_requests fr
    JOIN users fu ON fu.id = fr.from_user_id
    JOIN users tu ON tu.id = fr.to_user_id
    WHERE fr.to_user_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `;
    const sqlOut = `
    SELECT fr.id, fr.from_user_id, fr.to_user_id, fr.status,
           fu.*, tu.*
    FROM friend_requests fr
    JOIN users fu ON fu.id = fr.from_user_id
    JOIN users tu ON tu.id = fr.to_user_id
    WHERE fr.from_user_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `;
    const rows = db.prepare(dir === 'in' ? sqlIn : sqlOut).all(req.userId);
    const items = rows.map(r => ({
        id: r.id,
        from_user: pickUser({
            id: r.from_user_id, username: r.username, first_username: r.first_username,
            profile_photo: r.profile_photo, bio_html: r.bio_html, bio: r.bio
        }),
        to_user: pickUser({
            id: r.to_user_id,
            username: r['tu.username'] || r.username,                   // safe-ish in case of column shadow
            first_username: r['tu.first_username'] || r.first_username,
            profile_photo: r['tu.profile_photo'] || r.profile_photo,
            bio_html: r['tu.bio_html'] || r.bio_html,
            bio: r['tu.bio'] || r.bio
        }),
        status: r.status
    }));
    res.json({ items });
});

/** POST /api/friends/requests  { to_user_id? , to_username? } */
router.post('/friends/requests', requireAuth, (req, res) => {
    const me = req.userId;
    let toId = req.body?.to_user_id | 0;

    if (!toId && req.body?.to_username) {
        const u = findUserBySlugOrId(String(req.body.to_username));
        if (!u) return res.status(404).json({ error: 'user_not_found' });
        toId = u.id;
    }
    if (!toId) return res.status(400).json({ error: 'to_user_required' });
    if (toId === me) return res.status(400).json({ error: 'cannot_friend_self' });

    const already = db.prepare(`
    SELECT 1 FROM friend_requests
    WHERE (from_user_id=? AND to_user_id=? AND status='pending')
       OR (from_user_id=? AND to_user_id=? AND status='pending')
    LIMIT 1
  `).get(me, toId, toId, me);
    if (already) return res.status(409).json({ error: 'request_exists' });

    // If already friends, skip
    const [a, b] = orderPair(me, toId);
    const isFriend = db.prepare(`SELECT 1 FROM friendships WHERE user_id_a=? AND user_id_b=?`).get(a, b);
    if (isFriend) return res.status(409).json({ error: 'already_friends' });

    const info = db.prepare(`
    INSERT INTO friend_requests (from_user_id, to_user_id, status)
    VALUES (?, ?, 'pending')
  `).run(me, toId);

    res.json({ ok: true, id: info.lastInsertRowid });
});

/** POST /api/friends/requests/:id/accept */
router.post('/friends/requests/:id/accept', requireAuth, (req, res) => {
    const me = req.userId;
    const id = +req.params.id;

    const row = db.prepare(`SELECT * FROM friend_requests WHERE id=?`).get(id);
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'request_not_found' });
    if (row.to_user_id !== me) return res.status(403).json({ error: 'not_recipient' });

    const tx = db.transaction(() => {
        db.prepare(`UPDATE friend_requests SET status='accepted' WHERE id=?`).run(id);
        const [a, b] = orderPair(row.from_user_id, row.to_user_id);
        db.prepare(`INSERT OR IGNORE INTO friendships(user_id_a, user_id_b) VALUES(?, ?)`).run(a, b);
    });
    tx();

    res.json({ ok: true });
});

/** POST /api/friends/requests/:id/ignore */
router.post('/friends/requests/:id/ignore', requireAuth, (req, res) => {
    const me = req.userId;
    const id = +req.params.id;

    const row = db.prepare(`SELECT * FROM friend_requests WHERE id=?`).get(id);
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'request_not_found' });
    if (row.to_user_id !== me) return res.status(403).json({ error: 'not_recipient' });

    db.prepare(`UPDATE friend_requests SET status='ignored' WHERE id=?`).run(id);
    res.json({ ok: true });
});

/* ========= friends list ========= */

/** GET /api/users/:slug/friends?offset=0&limit=10 */
router.get('/users/:slug/friends', (req, res) => {
    const off = Math.max(0, parseInt(req.query.offset || '0', 10));
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit || '10', 10)));
    const slug = req.params.slug;

    let u;
    if (slug === 'me') {
        const id = getAuthedUserId(req);
        if (!id) return res.status(401).json({ error: 'auth_required' });
        u = db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
    } else {
        u = findUserBySlugOrId(slug);
    }
    if (!u) return res.status(404).json({ error: 'user_not_found' });

    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM user_friend_edges WHERE user_id=?`).get(u.id);
    const items = db.prepare(`
    SELECT ue.friend_id AS id, us.username, us.first_username, us.profile_photo, us.bio_html, us.bio
    FROM user_friend_edges ue
    JOIN users us ON us.id = ue.friend_id
    WHERE ue.user_id = ?
    ORDER BY ue.created_at DESC
    LIMIT ? OFFSET ?
  `).all(u.id, lim, off);

    res.json({ total: totalRow.c | 0, items });
});

/** GET /api/users/me/friends/summary */
router.get('/users/me/friends/summary', requireAuth, (req, res) => {
    const uid = req.userId;
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM user_friend_edges WHERE user_id=?`).get(uid);
    // If you add a presence table, compute "online" here; for now return 0.
    res.json({ total: totalRow.c | 0, online: 0, window_minutes: 5 });
});

module.exports = { router };
