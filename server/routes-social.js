// server/routes-social.js
const express = require('express');
const router = express.Router();
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');

/* ---------------- sanity ---------------- */
router.get('/ping-social', (req, res) => res.json({ ok: true, where: 'routes-social' }));

/* ---------------- helpers ---------------- */
function i(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function sortKey(v) {
    const s = String(v || '').toLowerCase();
    return ['hottest', 'newest', 'controversial', 'popular'].includes(s) ? s : 'hottest';
}
function orderByFor(s) {
    switch (s) {
        case 'newest': return 'c.created_at DESC';
        case 'popular': return '(c.likes - c.dislikes) DESC, c.created_at DESC';
        case 'controversial': return '(c.likes + c.dislikes) DESC, c.created_at DESC';
        case 'hottest':
        default: return '(c.likes - c.dislikes) DESC, c.created_at DESC';
    }
}
function nowIso() { return new Date().toISOString(); }

/* ---------------- vote column autodetect ---------------- */
const VOTE_COL = (() => {
    try {
        const cols = db.prepare('PRAGMA table_info(comment_votes)').all();
        const hasValue = cols.some(c => c.name === 'value');
        const hasVote = cols.some(c => c.name === 'vote');
        const chosen = hasValue ? 'value' : (hasVote ? 'vote' : 'value');
        console.log('[social] using vote column:', chosen, '(comment_votes)');
        return chosen;
    } catch (e) {
        console.warn('[social] PRAGMA table_info(comment_votes) failed; defaulting to value', e);
        return 'value';
    }
})();

/* ---------------- username expression autodetect ---------------- */
const USER_NAME_COL = (() => {
    try {
        const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
        if (cols.includes('username')) return 'username';
        if (cols.includes('display_name')) return 'display_name';
        if (cols.includes('name')) return 'name';
    } catch { }
    return null;
})();
const USERNAME_EXPR = USER_NAME_COL
    ? `CASE WHEN u.${USER_NAME_COL} IS NULL OR TRIM(u.${USER_NAME_COL}) = '' THEN 'User#' || u.id ELSE u.${USER_NAME_COL} END`
    : `'User#' || u.id`;

const LIKE_CHECK = VOTE_COL === 'value'
    ? `${VOTE_COL} = 1`
    : `${VOTE_COL} IN ('up','like','liked','1',1)`;

const DISLIKE_CHECK = VOTE_COL === 'value'
    ? `${VOTE_COL} = -1`
    : `${VOTE_COL} IN ('down','dislike','disliked','-1',-1)`;

const NORM_V_EXPR = VOTE_COL === 'value'
    ? `${VOTE_COL}`
    : `CASE
       WHEN ${VOTE_COL} IN ('up','like','liked','1',1) THEN 1
       WHEN ${VOTE_COL} IN ('down','dislike','disliked','-1',-1) THEN -1
       ELSE 0
     END`;

/* ---------------- session schema autodetect (once) ----------------
   We resolve req.userId for GET requests by reading cookie 'sid'
   and looking it up in whatever session table exists.
------------------------------------------------------------------- */
const SESSION_META = (() => {
    try {
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
        const candidates = ['sessions', 'auth_sessions', 'user_sessions', ...tables];
        const seen = new Set();
        for (const t of candidates) {
            if (!t || seen.has(t)) continue;
            seen.add(t);
            try {
                const cols = db.prepare(`PRAGMA table_info(${t})`).all();
                const names = cols.map(c => c.name);
                const sidCol = ['sid', 'session_id', 'token'].find(n => names.includes(n));
                const userCol = ['user_id', 'uid', 'userId'].find(n => names.includes(n));
                if (sidCol && userCol) {
                    const expiresCol = ['expires_at', 'expiry', 'expires', 'valid_until'].find(n => names.includes(n)) || null;
                    console.log('[social] detected session table:', { table: t, sidCol, userCol, expiresCol });
                    return { table: t, sidCol, userCol, expiresCol };
                }
            } catch { }
        }
    } catch (e) {
        console.warn('[social] session autodetect failed:', e);
    }
    console.warn('[social] no session table detected; GET my_vote will be 0 unless req.userId is set upstream');
    return null;
})();

function resolveUid(req) {
    if (req.userId) return req.userId;
    if (req._resolvedUid != null) return req._resolvedUid;

    // NEW: allow debug header/query
    const headerUid = parseInt(req.get('x-user-id') || req.query.uid, 10);
    if (Number.isFinite(headerUid) && headerUid > 0) {
        req._resolvedUid = headerUid;
        return headerUid;
    }

    // existing cookie/session autodetect…
    let uid = 0;
    try {
        const sid = req.cookies && req.cookies.sid;
        if (sid && SESSION_META) {
            const meta = SESSION_META;
            const row = db.prepare(`
        SELECT ${meta.userCol} AS uid${meta.expiresCol ? `, ${meta.expiresCol} AS exp` : ''}
        FROM ${meta.table}
        WHERE ${meta.sidCol} = ?
        LIMIT 1
      `).get(sid);
            if (row && row.uid) {
                if (row.exp) {
                    const expMs = new Date(row.exp).getTime();
                    uid = (Number.isFinite(expMs) && expMs < Date.now()) ? 0 : (row.uid | 0);
                } else {
                    uid = row.uid | 0;
                }
            }
        }
    } catch { }
    req._resolvedUid = uid;
    return uid;
}

/* ---------------- list top-level comments ---------------- */
router.get('/pleas/:id/comments', (req, res) => {
    const pleaNum = i(req.params.id);
    const page = Math.max(1, i(req.query.page, 1));
    const pageSize = Math.max(1, Math.min(50, i(req.query.page_size, 10)));
    const sort = sortKey(req.query.sort);
    const offset = (page - 1) * pageSize;
    const meId = resolveUid(req) || 0;

    try {
        const total = db.prepare(`
      SELECT COUNT(*) AS n
      FROM comments c
      WHERE c.plea_num = ? AND c.parent_id IS NULL
    `).get(pleaNum).n | 0;

        const items = db.prepare(`
      SELECT
        c.id, c.plea_num, c.user_id, c.parent_id, c.body,
        c.likes, c.dislikes, c.created_at, c.updated_at,
        (SELECT COUNT(1) FROM comments r WHERE r.parent_id = c.id) AS reply_count,
        COALESCE((
          SELECT ${VOTE_COL} FROM comment_votes mv
          WHERE mv.comment_id = c.id AND mv.user_id = ?
          LIMIT 1
        ), 0) AS my_vote,
        ${USERNAME_EXPR} AS username
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.plea_num = ? AND c.parent_id IS NULL
      ORDER BY ${orderByFor(sort)}
      LIMIT ? OFFSET ?
    `).all(meId, pleaNum, pageSize, offset);

        res.json({ page, page_size: pageSize, total, items });
    } catch (e) {
        console.error('LIST_COMMENTS_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ---------------- list replies ---------------- */
router.get('/comments/:id/replies', (req, res) => {
    const parentId = i(req.params.id);
    const meId = resolveUid(req) || 0;
    try {
        const items = db.prepare(`
      SELECT
        c.id, c.plea_num, c.user_id, c.parent_id, c.body,
        c.likes, c.dislikes, c.created_at, c.updated_at,
        COALESCE((
          SELECT ${VOTE_COL} FROM comment_votes mv
          WHERE mv.comment_id = c.id AND mv.user_id = ?
          LIMIT 1
        ), 0) AS my_vote,
        ${USERNAME_EXPR} AS username
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.parent_id = ?
      ORDER BY c.created_at ASC
    `).all(meId, parentId);

        res.json({ items });
    } catch (e) {
        console.error('LIST_REPLIES_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// create a reply
router.post('/comments/:id/replies', requireAuth, (req, res) => {
    const parentId = i(req.params.id);
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body_required' });

    try {
        // find parent + its plea_num
        const parent = db.prepare(`SELECT id, plea_num FROM comments WHERE id = ?`).get(parentId);
        if (!parent) return res.status(404).json({ error: 'bad_parent' });

        const r = db.prepare(`
      INSERT INTO comments (plea_num, user_id, parent_id, body, created_at, updated_at)
      VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run(parent.plea_num, req.userId, parentId, body);

        const row = db.prepare(`
      SELECT c.*,
             ${USERNAME_EXPR} AS username
      FROM comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `).get(r.lastInsertRowid);

        // keep response shape similar to create-comment
        res.status(201).json({ ok: true, comment: { ...row, my_vote: 0 } });
    } catch (e) {
        console.error('CREATE_REPLY_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ---------------- create comment / reply ---------------- */
router.post('/pleas/:id/comments', requireAuth, (req, res) => {
    const pleaNum = i(req.params.id);
    const body = String(req.body?.body || '').trim();
    const parentId = req.body?.parent_id != null ? i(req.body.parent_id) : null;

    if (!pleaNum) return res.status(400).json({ error: 'bad_plea' });
    if (!body) return res.status(400).json({ error: 'body_required' });

    try {
        if (parentId) {
            const p = db.prepare(`SELECT id, plea_num FROM comments WHERE id = ?`).get(parentId);
            if (!p) return res.status(400).json({ error: 'bad_parent' });
            if (p.plea_num !== pleaNum) return res.status(400).json({ error: 'parent_mismatch' });
        }

        const r = db.prepare(`
      INSERT INTO comments (plea_num, user_id, parent_id, body, created_at, updated_at)
      VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run(pleaNum, req.userId, parentId, body);

        const row = db.prepare(`
      SELECT c.*,
             ${USERNAME_EXPR} AS username
      FROM comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `).get(r.lastInsertRowid);

        res.status(201).json({ ok: true, comment: { ...row, my_vote: 0 } });
    } catch (e) {
        console.error('CREATE_COMMENT_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ---------------- get current user's vote for a comment ---------------- */
router.get('/comments/:id/my_vote', (req, res) => {
    const commentId = i(req.params.id);
    const uid = resolveUid(req);
    if (!uid) return res.json({ my_vote: 0, vote: null });

    try {
        const row = db.prepare(`
      SELECT ${NORM_V_EXPR} AS v FROM comment_votes
      WHERE comment_id = ? AND user_id = ? LIMIT 1
    `).get(commentId, uid);
        const val = row ? (row.v > 0 ? 1 : row.v < 0 ? -1 : 0) : 0;
        res.json({ my_vote: val, vote: val === 1 ? 'up' : val === -1 ? 'down' : null });
    } catch (e) {
        console.error('GET_MY_VOTE_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// alias some clients use
router.get('/comments/:id/vote', (req, res) => {
    const commentId = i(req.params.id);
    const uid = resolveUid(req);
    if (!uid) return res.json({ my_vote: 0, vote: null });

    try {
        const row = db.prepare(`
      SELECT ${VOTE_COL} AS v FROM comment_votes
      WHERE comment_id = ? AND user_id = ? LIMIT 1
    `).get(commentId, uid);
        const val = row ? (row.v > 0 ? 1 : row.v < 0 ? -1 : 0) : 0;
        res.json({ my_vote: val, vote: val === 1 ? 'up' : val === -1 ? 'down' : null });
    } catch (e) {
        console.error('GET_MY_VOTE_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

router.delete('/comments/:id/vote', requireAuth, (req, res) => {
    const commentId = i(req.params.id);
    try {
        const out = db.transaction(() => {
            db.prepare(`
        INSERT INTO comment_votes (comment_id, user_id, ${VOTE_COL}, updated_at)
        VALUES (?,?,0,CURRENT_TIMESTAMP)
        ON CONFLICT(comment_id, user_id)
        DO UPDATE SET ${VOTE_COL} = 0, updated_at = CURRENT_TIMESTAMP
      `).run(commentId, req.userId);

            const agg = db.prepare(`
        SELECT
          SUM(CASE WHEN ${LIKE_CHECK} THEN 1 ELSE 0 END)    AS likes,
          SUM(CASE WHEN ${DISLIKE_CHECK} THEN 1 ELSE 0 END) AS dislikes
        FROM comment_votes WHERE comment_id = ?
      `).get(commentId);

            db.prepare(`UPDATE comments SET likes=?, dislikes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
                .run(agg.likes | 0, agg.dislikes | 0, commentId);

            return { likes: agg.likes | 0, dislikes: agg.dislikes | 0, my_vote: 0 };
        })();
        res.json({ ok: true, ...out });
    } catch (e) {
        console.error('VOTE_CLEAR_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});


/* ---------------- vote (like/dislike/clear) ----------------
   Accepts multiple shapes:
   - { value: 1|-1|0 }
   - { delta: 1|-1|0 }
   - { vote: "up"|"down"|"none" }
   - { direction: "up"|"down"|"none" }
------------------------------------------------------------ */
router.post('/comments/:id/vote', requireAuth, (req, res) => {
    const commentId = i(req.params.id);
    let value = null;

    if (typeof req.body?.value === 'number') value = req.body.value;
    if (value === null && typeof req.body?.delta === 'number') value = req.body.delta;
    if (value === null && typeof req.body?.vote === 'string') {
        const s = req.body.vote.toLowerCase();
        value = s === 'up' ? 1 : s === 'down' ? -1 : 0;
    }
    if (value === null && typeof req.body?.direction === 'string') {
        const s = req.body.direction.toLowerCase();
        value = s === 'up' ? 1 : s === 'down' ? -1 : 0;
    }

    if (![-1, 0, 1].includes(value)) {
        return res.status(400).json({ error: 'bad_value', detail: `got=${JSON.stringify(req.body)}` });
    }

    try {
        const out = db.transaction(() => {
            const c = db.prepare(`SELECT id, user_id FROM comments WHERE id = ?`).get(commentId);
            if (!c) { const err = new Error('not_found'); err.status = 404; throw err; }

            const prevRow = db.prepare(
                `SELECT ${VOTE_COL} AS v FROM comment_votes WHERE comment_id = ? AND user_id = ?`
            ).get(commentId, req.userId) || { v: 0 };

            // Upsert vote (store 0 when clearing)
            db.prepare(`
        INSERT INTO comment_votes (comment_id, user_id, ${VOTE_COL}, updated_at)
        VALUES (?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(comment_id, user_id)
        DO UPDATE SET ${VOTE_COL} = excluded.${VOTE_COL}, updated_at = CURRENT_TIMESTAMP
      `).run(commentId, req.userId, value);

            // Re-aggregate likes/dislikes on comment
            const agg = db.prepare(`
              SELECT
                SUM(CASE WHEN ${LIKE_CHECK} THEN 1 ELSE 0 END)    AS likes,
                SUM(CASE WHEN ${DISLIKE_CHECK} THEN 1 ELSE 0 END) AS dislikes
              FROM comment_votes WHERE comment_id = ?
            `).get(commentId);

            const likes = (agg.likes | 0);
            const dislikes = (agg.dislikes | 0);
            db.prepare(`UPDATE comments SET likes = ?, dislikes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(likes, dislikes, commentId);

            // Adjust author counters based on change
            const dLike = (value === 1 ? 1 : 0) - (prevRow.v === 1 ? 1 : 0);
            const dDislike = (value === -1 ? 1 : 0) - (prevRow.v === -1 ? 1 : 0);
            if (dLike || dDislike) {
                db.prepare(`
          UPDATE users
          SET received_likes    = received_likes    + ?,
              received_dislikes = received_dislikes + ?
          WHERE id = ?
        `).run(dLike, dDislike, c.user_id);
            }

            return { likes, dislikes, my_vote: value };
        })();

        res.json({ ok: true, ...out });
    } catch (e) {
        console.error('VOTE_ERR', e);
        const status = e.status || 500;
        res.status(status).json({
            error: status === 404 ? 'not_found' : 'server_error',
            detail: String(e && e.message || e)
        });
    }
});

/* ---------------- edit comment (owner within 24h; admin anytime) ---------------- */
router.patch('/comments/:id', requireAuth, (req, res) => {
    const id = i(req.params.id);
    const body = String(req.body?.body || req.body?.text || req.body?.content || '').trim();
    if (!body) return res.status(400).json({ error: 'body_required' });

    try {
        const c = db.prepare(`
      SELECT
        c.*,
        u.is_admin AS is_admin,
        (strftime('%s','now') - strftime('%s', c.created_at)) AS age_sec
      FROM comments c
      LEFT JOIN users u ON u.id = ?
      WHERE c.id = ?
    `).get(req.userId, id);

        if (!c) return res.status(404).json({ error: 'not_found' });

        const isOwner = c.user_id === req.userId;
        const isAdmin = !!c.is_admin;
        if (!isOwner && !isAdmin) return res.status(403).json({ error: 'forbidden' });

        if (!isAdmin && (c.age_sec | 0) > 24 * 60 * 60) {
            return res.status(403).json({ error: 'edit_window_closed' });
        }

        db.prepare(`UPDATE comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(body, id);

        const row = db.prepare(`
      SELECT c.*,
             ${USERNAME_EXPR} AS username,
             COALESCE((
               SELECT ${VOTE_COL} FROM comment_votes mv
               WHERE mv.comment_id = c.id AND mv.user_id = ?
               LIMIT 1
             ), 0) AS my_vote
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `).get(req.userId, id);

        res.json({ ok: true, comment: row });
    } catch (e) {
        console.error('EDIT_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ---------------- delete comment (owner or admin; deletes replies + votes) ---------------- */
router.delete('/comments/:id', requireAuth, (req, res) => {
    const id = i(req.params.id);

    try {
        const c = db.prepare(`
      SELECT c.*, u.is_admin as is_admin
      FROM comments c
      LEFT JOIN users u ON u.id = ?
      WHERE c.id = ?
    `).get(req.userId, id);

        if (!c) return res.status(404).json({ error: 'not_found' });

        const isOwner = c.user_id === req.userId;
        const isAdmin = !!c.is_admin;
        if (!isOwner && !isAdmin) return res.status(403).json({ error: 'forbidden' });

        db.transaction(() => {
            const cte = `
        WITH RECURSIVE to_del(id) AS (
          SELECT id FROM comments WHERE id = ?
          UNION ALL
          SELECT ch.id FROM comments ch JOIN to_del d ON ch.parent_id = d.id
        )
      `;
            db.prepare(`${cte} DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM to_del)`).run(id);
            db.prepare(`${cte} DELETE FROM comments      WHERE id         IN (SELECT id FROM to_del)`).run(id);
        })();

        res.json({ ok: true, deleted: id });
    } catch (e) {
        console.error('DELETE_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

module.exports = { router };