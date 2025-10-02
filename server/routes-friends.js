const express = require('express');
const { db, dbPath } = require('./db');  // <- include dbPath

const router = express.Router();

router.get('/__debug/dbinfo', (req, res) => {
    const counts = {
        users: (db.prepare('SELECT COUNT(*) c FROM users').get().c) | 0,
        friend_requests: (db.prepare('SELECT COUNT(*) c FROM friend_requests').get().c) | 0,
        friendships: (db.prepare('SELECT COUNT(*) c FROM friendships').get().c) | 0,
        sessions: (db.prepare('SELECT COUNT(*) c FROM sessions').get().c) | 0,
    };
    res.json({ dbPath, counts });
});

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
function pickUserFromAliases(r, prefix) {
    return pickUser({
        id: r[`${prefix}_id`],
        username: r[`${prefix}_username`],
        first_username: r[`${prefix}_first_username`],
        profile_photo: r[`${prefix}_profile_photo`],
        bio_html: r[`${prefix}_bio_html`],
        bio: r[`${prefix}_bio`]
    });
}
function orderPair(a, b) { return a < b ? [a, b] : [b, a]; }

function getAuthedUserId(req) {
    const h = req.get('x-user-id');
    if (h && /^\d+$/.test(h)) return +h;

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

router.use((req, res, next) => {
    const start = Date.now();
    const uid = getAuthedUserId(req);
    console.log(`[api] ${req.method} ${req.originalUrl} uid=${uid ?? '∅'} body=`, req.body || null);
    res.on('finish', () => {
        console.log(`[api] → ${res.statusCode} (${Date.now() - start}ms) ${req.method} ${req.originalUrl}`);
    });
    next();
});

function findUserBySlugOrId(slug) {
    if (/^\d+$/.test(slug)) return db.prepare(`SELECT * FROM users WHERE id=?`).get(+slug);
    return db.prepare(`
    SELECT * FROM users
    WHERE lower(first_username) = lower(?) OR lower(username) = lower(?)
    LIMIT 1
  `).get(slug, slug);
}

function inspectPair(me, otherId) {
    const [a, b] = orderPair(me, otherId);
    const friendships = db.prepare(`
    SELECT rowid, user_id_a, user_id_b FROM friendships
    WHERE (user_id_a=? AND user_id_b=?) OR (user_id_a=? AND user_id_b=?)
  `).all(a, b, b, a);
    const requests = db.prepare(`
    SELECT id, from_user_id, to_user_id, status FROM friend_requests
    WHERE (from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)
  `).all(me, otherId, otherId, me);
    return { friendships, requests, a, b };
}

function getRelationship(meId, otherId) {
    if (!meId || !otherId || meId === otherId) return 'none';

    const [a, b] = orderPair(meId, otherId);
    const fr = db.prepare(`
    SELECT 1 FROM friendships
    WHERE (user_id_a=? AND user_id_b=?) OR (user_id_a=? AND user_id_b=?)
    LIMIT 1
  `).get(a, b, b, a);
    if (fr) return 'friend';

    const req = db.prepare(`
    SELECT from_user_id, to_user_id
    FROM friend_requests
    WHERE status='pending'
      AND ((from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?))
    LIMIT 1
  `).get(meId, otherId, otherId, meId);

    if (!req) return 'none';
    if (req.from_user_id === meId) return 'requested_by_me';
    if (req.to_user_id === meId) return 'requested_of_me';
    return 'none';
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

router.get('/friends/requests', requireAuth, (req, res) => {
    const dir = (req.query.direction || 'in').toLowerCase();
    if (!['in', 'out'].includes(dir)) return res.status(400).json({ error: 'bad_direction' });

    const base = `
    SELECT
      fr.id, fr.from_user_id, fr.to_user_id, fr.status,
      fu.id   AS fu_id, fu.username AS fu_username, fu.first_username AS fu_first_username,
      fu.profile_photo AS fu_profile_photo, fu.bio_html AS fu_bio_html, fu.bio AS fu_bio,
      tu.id   AS tu_id, tu.username AS tu_username, tu.first_username AS tu_first_username,
      tu.profile_photo AS tu_profile_photo, tu.bio_html AS tu_bio_html, tu.bio AS tu_bio
    FROM friend_requests fr
    JOIN users fu ON fu.id = fr.from_user_id
    JOIN users tu ON tu.id = fr.to_user_id
    WHERE %WHERE% AND fr.status='pending'
    ORDER BY fr.created_at DESC
  `;
    const where = (dir === 'in') ? 'fr.to_user_id = ?' : 'fr.from_user_id = ?';
    const rows = db.prepare(base.replace('%WHERE%', where)).all(req.userId);
    const items = rows.map(r => ({
        id: r.id,
        from_user: pickUserFromAliases(r, 'fu'),
        to_user: pickUserFromAliases(r, 'tu'),
        status: r.status
    }));
    res.json({ items });
});

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

    const dup = db.prepare(`
    SELECT 1 FROM friend_requests
    WHERE status='pending'
      AND ((from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?))
    LIMIT 1
  `).get(me, toId, toId, me);
    if (dup) return res.status(409).json({ error: 'request_exists' });

    const [a, b] = orderPair(me, toId);
    const isFriend = db.prepare(`
    SELECT 1 FROM friendships WHERE (user_id_a=? AND user_id_b=?) OR (user_id_a=? AND user_id_b=?) LIMIT 1
  `).get(a, b, b, a);
    if (isFriend) return res.status(409).json({ error: 'already_friends' });

    const info = db.prepare(`
    INSERT INTO friend_requests (from_user_id, to_user_id, status)
    VALUES (?, ?, 'pending')
  `).run(me, toId);
    console.log(`[friends] request created id=${info.lastInsertRowid} from=${me} to=${toId}`);
    res.json({ ok: true, id: info.lastInsertRowid });
});

// POST /friends/requests/:id/accept
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

    // Return the *friend* (the sender of the request)
    const other = db.prepare(`SELECT id, username, first_username, profile_photo, bio_html, bio FROM users WHERE id=?`).get(row.from_user_id);
    console.log(`[friends] accepted request id=${id} pair=${row.from_user_id}<->${row.to_user_id}`);
    res.json({ ok: true, friend: pickUser(other) });
});

router.post('/friends/requests/:id/ignore', requireAuth, (req, res) => {
    const me = req.userId;
    const id = +req.params.id;

    const row = db.prepare(`SELECT * FROM friend_requests WHERE id=?`).get(id);
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'request_not_found' });
    if (row.to_user_id !== me) return res.status(403).json({ error: 'not_recipient' });

    db.prepare(`UPDATE friend_requests SET status='ignored' WHERE id=?`).run(id);
    console.log(`[friends] ignored request id=${id}`);
    res.json({ ok: true });
});

// DELETE /friends/requests/:id  (sender can cancel)
router.delete('/friends/requests/:id', requireAuth, (req, res) => {
    const me = req.userId;
    const id = +req.params.id;

    const row = db.prepare(`SELECT * FROM friend_requests WHERE id=?`).get(id);
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'request_not_found' });
    if (row.from_user_id !== me) return res.status(403).json({ error: 'not_sender' });

    db.prepare(`DELETE FROM friend_requests WHERE id=?`).run(id);
    console.log(`[friends] canceled request id=${id} by=${me}`);
    res.json({ ok: true });
});

// Optional compatibility endpoint:
router.post('/friends/requests/:id/cancel', requireAuth, (req, res) => {
    const me = req.userId;
    const id = +req.params.id;

    const row = db.prepare(`SELECT * FROM friend_requests WHERE id=?`).get(id);
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'request_not_found' });
    if (row.from_user_id !== me) return res.status(403).json({ error: 'not_sender' });

    db.prepare(`DELETE FROM friend_requests WHERE id=?`).run(id);
    console.log(`[friends] canceled request id=${id} by=${me} (POST /cancel)`);
    res.json({ ok: true });
});


router.get('/users/:slug/friends', (req, res) => {
    const off = Math.max(0, parseInt(req.query.offset || '0', 10));
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit || '10', 10)));
    const slug = String(req.params.slug || '');

    let u;
    if (slug === 'me') {
        const id = getAuthedUserId(req);
        if (!id) return res.status(401).json({ error: 'auth_required' });
        u = db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
    } else {
        u = findUserBySlugOrId(slug);
    }
    if (!u) return res.status(404).json({ error: 'user_not_found' });

    const totalRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM friendships f
    WHERE f.user_id_a=? OR f.user_id_b=?
  `).get(u.id, u.id);

    const items = db.prepare(`
    SELECT
      CASE WHEN f.user_id_a = ? THEN f.user_id_b ELSE f.user_id_a END AS id,
      us.username, us.first_username, us.profile_photo, us.bio_html, us.bio
    FROM friendships f
    JOIN users us ON us.id = CASE WHEN f.user_id_a = ? THEN f.user_id_b ELSE f.user_id_a END
    WHERE f.user_id_a=? OR f.user_id_b=?
    ORDER BY f.rowid DESC
    LIMIT ? OFFSET ?
  `).all(u.id, u.id, u.id, u.id, lim, off);

    res.json({ total: totalRow.c | 0, items });
});

router.delete('/users/me/friends/:slug', requireAuth, (req, res) => {
    const me = req.userId;
    const slug = String(req.params.slug || '').trim();
    const other = findUserBySlugOrId(slug);
    if (!other) return res.status(404).json({ error: 'user_not_found' });

    const [a, b] = orderPair(me, other.id);
    const before = inspectPair(me, other.id);
    console.log(`[unfriend] BEGIN me=${me} other=${other.id} slug=${slug} before=`, before);

    const r = db.prepare(`
    DELETE FROM friendships
    WHERE (user_id_a=? AND user_id_b=?) OR (user_id_a=? AND user_id_b=?)
  `).run(a, b, b, a);

    try {
        db.prepare(`
      DELETE FROM user_friend_edges
      WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)
    `).run(me, other.id, other.id, me);
    } catch { }
    try {
        db.prepare(`
      DELETE FROM friend_requests
      WHERE (from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)
    `).run(me, other.id, other.id, me);
    } catch { }

    const after = inspectPair(me, other.id);
    console.log(`[unfriend] END me=${me} other=${other.id} removed=${r.changes} after=`, after);

    return res.status(200).json({
        ok: true,
        removed: r.changes | 0,
        debug: { before, after }
    });
});

router.get('/relationships/:slug', requireAuth, (req, res) => {
    const me = req.userId;
    const other = findUserBySlugOrId(String(req.params.slug || '').trim());
    if (!other) return res.status(404).json({ error: 'user_not_found' });

    const status = getRelationship(me, other.id);
    const details = inspectPair(me, other.id);
    console.log(`[rel] me=${me} other=${other.id} slug=${req.params.slug} -> status=${status} details=`, details);

    res.json({ status });
});

router.get('/__debug/me', (req, res) => {
    res.json({ userId: getAuthedUserId(req) ?? null });
});

router.get('/__debug/pair/:slug', requireAuth, (req, res) => {
    const me = req.userId;
    const other = findUserBySlugOrId(String(req.params.slug || '').trim());
    if (!other) return res.status(404).json({ error: 'user_not_found' });
    const info = inspectPair(me, other.id);
    res.json({ me, other: pickUser(other), ...info });
});

module.exports = { router };