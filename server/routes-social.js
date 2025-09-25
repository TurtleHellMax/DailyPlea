// routes-social.js
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');
const { validators } = require('./security');

const router = express.Router();

/* ---------- Plea votes ---------- */
router.get('/pleas/:id/votes', (req, res) => {
    const pleaId = +req.params.id;
    const row = db
        .prepare(
            'SELECT ' +
            'SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) AS up, ' +
            'SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS down ' +
            'FROM plea_votes WHERE plea_id = ?'
        )
        .get(pleaId);
    const up = row && row.up ? row.up : 0;
    const down = row && row.down ? row.down : 0;
    res.json({ up, down, score: up - down });
});

router.post('/pleas/:id/vote', requireAuth, (req, res) => {
    const pleaId = +req.params.id;
    const v = String((req.body && req.body.vote) || '0');
    validators.vote.parse(v);
    const vote = +v;
    db.prepare(
        'INSERT INTO plea_votes (plea_id, user_id, vote) VALUES (?,?,?) ' +
        'ON CONFLICT(plea_id,user_id) DO UPDATE SET vote=excluded.vote, created_at=CURRENT_TIMESTAMP'
    ).run(pleaId, req.userId, vote);
    res.json({ ok: true });
});

/* ---------- Comments ---------- */
router.post('/pleas/:id/comments', requireAuth, (req, res) => {
    const pleaId = +req.params.id;
    const bodyRaw = String((req.body && req.body.body) || '');
    const body = sanitizeHtml(bodyRaw, {
        allowedTags: ['b', 'i', 'em', 'strong', 'a', 'code', 'pre'],
        allowedAttributes: { a: ['href', 'title', 'rel', 'target'] },
    });
    validators.commentBody.parse(body);
    const r = db
        .prepare('INSERT INTO comments (plea_id, user_id, body) VALUES (?,?,?)')
        .run(pleaId, req.userId, body);
    res.json({ ok: true, commentId: r.lastInsertRowid });
});

router.get('/pleas/:id/comments', (req, res) => {
    const pleaId = +req.params.id;
    const sort = (req.query.sort || 'hottest').toString();

    const base =
        'SELECT c.*, ' +
        'COALESCE(SUM(CASE WHEN cv.vote=1 THEN 1 ELSE 0 END),0) AS up, ' +
        'COALESCE(SUM(CASE WHEN cv.vote=-1 THEN 1 ELSE 0 END),0) AS down, ' +
        '(COALESCE(SUM(CASE WHEN cv.vote=1 THEN 1 ELSE 0 END),0) - COALESCE(SUM(CASE WHEN cv.vote=-1 THEN 1 ELSE 0 END),0)) AS score ' +
        'FROM comments c ' +
        'LEFT JOIN comment_votes cv ON cv.comment_id = c.id ' +
        'WHERE c.plea_id = ? AND c.deleted_at IS NULL AND c.is_removed = 0 ' +
        'GROUP BY c.id ';

    let order = 'ORDER BY score DESC, c.created_at DESC';
    if (sort === 'newest') {
        order = 'ORDER BY c.created_at DESC';
    } else if (sort === 'popular') {
        // SQLite-safe: ratio, then volume, then recency
        order =
            'ORDER BY ' +
            'CASE WHEN (up+down)=0 THEN 0 ELSE (1.0*up)/(up+down) END DESC, ' +
            '(up+down) DESC, ' +
            'c.created_at DESC';
    } else if (sort === 'controversial') {
        order = 'ORDER BY (up+down) DESC, ABS(score) ASC, c.created_at DESC';
    } else if (sort === 'hottest') {
        // simple hot score with time decay (hours); SQLite strftime timestamps
        order =
            'ORDER BY (score) / ( (strftime("%s","now") - strftime("%s", c.created_at)) / 3600.0 + 2 ) DESC';
    }

    const rows = db.prepare(base + ' ' + order + ' LIMIT 200').all(pleaId);
    res.json({
        comments: rows.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            body: r.body,
            created_at: r.created_at,
            up: r.up,
            down: r.down,
            score: r.score,
        })),
    });
});

/* ---------- Comment votes ---------- */
router.post('/comments/:id/vote', requireAuth, (req, res) => {
    const cid = +req.params.id;
    const v = String((req.body && req.body.vote) || '0');
    validators.vote.parse(v);
    const vote = +v;
    db.prepare(
        'INSERT INTO comment_votes (comment_id, user_id, vote) VALUES (?,?,?) ' +
        'ON CONFLICT(comment_id,user_id) DO UPDATE SET vote=excluded.vote'
    ).run(cid, req.userId, vote);
    res.json({ ok: true });
});

module.exports = { router };
