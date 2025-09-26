// server/routes-social.js
const express = require('express');
const router = express.Router();
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');

// quick sanity endpoint so we can test the mount
router.get('/ping-social', (req, res) => res.json({ ok: true, where: 'routes-social' }));

// ---- helpers ----
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

// Detect which column exists in comment_votes (value preferred; legacy vote supported)
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

// ---- list top-level comments ----
router.get('/pleas/:id/comments', (req, res) => {
    const pleaNum = i(req.params.id);
    const page = Math.max(1, i(req.query.page, 1));
    const pageSize = Math.max(1, Math.min(50, i(req.query.page_size, 10)));
    const sort = sortKey(req.query.sort);
    const offset = (page - 1) * pageSize;

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
        (SELECT COUNT(1) FROM comments r WHERE r.parent_id = c.id) AS reply_count
      FROM comments c
      WHERE c.plea_num = ? AND c.parent_id IS NULL
      ORDER BY ${orderByFor(sort)}
      LIMIT ? OFFSET ?
    `).all(pleaNum, pageSize, offset);

        res.json({ page, page_size: pageSize, total, items });
    } catch (e) {
        console.error('LIST_COMMENTS_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// ---- list replies ----
router.get('/comments/:id/replies', (req, res) => {
    const parentId = i(req.params.id);
    try {
        const items = db.prepare(`
      SELECT id, plea_num, user_id, parent_id, body, likes, dislikes, created_at, updated_at
      FROM comments
      WHERE parent_id = ?
      ORDER BY created_at ASC
    `).all(parentId);
        res.json({ items });
    } catch (e) {
        console.error('LIST_REPLIES_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// ---- create comment / reply ----
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
      INSERT INTO comments (plea_num, user_id, parent_id, body)
      VALUES (?,?,?,?)
    `).run(pleaNum, req.userId, parentId, body);

        const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(r.lastInsertRowid);
        res.status(201).json({ ok: true, comment: row });
    } catch (e) {
        console.error('CREATE_COMMENT_ERR', e);
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// ---- vote (like/dislike/clear) ----
// body: { value: 1 } (like), { value: -1 } (dislike), { value: 0 } (clear)
router.post('/comments/:id/vote', requireAuth, (req, res) => {
    const commentId = parseInt(req.params.id, 10) || 0;
    const raw = req.body?.value;
    const value = Number(raw);
    if (![-1, 0, 1].includes(value)) {
        return res.status(400).json({ error: 'bad_value', detail: `got=${JSON.stringify(raw)}` });
    }

    console.log('VOTE_DEBUG begin', {
        commentId,
        userId: req.userId,
        body: req.body,
        usingColumn: VOTE_COL
    });

    try {
        const out = db.transaction(() => {
            const c = db.prepare(`SELECT id, user_id FROM comments WHERE id = ?`).get(commentId);
            if (!c) { const err = new Error('not_found'); err.status = 404; throw err; }

            const prevRow = db.prepare(
                `SELECT ${VOTE_COL} AS v FROM comment_votes WHERE comment_id = ? AND user_id = ?`
            ).get(commentId, req.userId) || { v: 0 };

            console.log('VOTE_DEBUG prev', prevRow);

            // Upsert vote (store 0 when clearing)
            db.prepare(`
        INSERT INTO comment_votes (comment_id, user_id, ${VOTE_COL})
        VALUES (?,?,?)
        ON CONFLICT(comment_id, user_id)
        DO UPDATE SET ${VOTE_COL} = excluded.${VOTE_COL}, updated_at = CURRENT_TIMESTAMP
      `).run(commentId, req.userId, value);

            // Re-aggregate likes/dislikes on comment
            const agg = db.prepare(`
        SELECT
          SUM(CASE WHEN ${VOTE_COL} =  1 THEN 1 ELSE 0 END) AS likes,
          SUM(CASE WHEN ${VOTE_COL} = -1 THEN 1 ELSE 0 END) AS dislikes
        FROM comment_votes WHERE comment_id = ?
      `).get(commentId);

            const likes = (agg.likes | 0);
            const dislikes = (agg.dislikes | 0);
            db.prepare(`UPDATE comments SET likes = ?, dislikes = ? WHERE id = ?`)
                .run(likes, dislikes, commentId);

            // Adjust author counters based on change
            const dLike = (value === 1 ? 1 : 0) - (prevRow.v === 1 ? 1 : 0);
            const dDislike = (value === -1 ? 1 : 0) - (prevRow.v === -1 ? 1 : 0);

            console.log('VOTE_DEBUG delta', { dLike, dDislike });

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

        console.log('VOTE_DEBUG ok', out);
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

module.exports = { router };
