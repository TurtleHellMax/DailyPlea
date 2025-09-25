// server/routes-saves.js
const express = require('express');
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');

const router = express.Router();

// Fetch current save
router.get('/save', requireAuth, (req, res) => {
    const row = db.prepare('SELECT data_json, version, updated_at FROM saved_games WHERE user_id = ?')
        .get(req.userId);
    if (!row) return res.json({ data: null, version: 0 });
    let data = null;
    try { data = JSON.parse(row.data_json); } catch { data = null; }
    res.json({ data, version: row.version, updated_at: row.updated_at });
});

// Upsert save
router.post('/save', requireAuth, (req, res) => {
    const data = req.body?.data ?? {};
    const json = JSON.stringify(data);
    db.prepare(`
    INSERT INTO saved_games (user_id, data_json, version, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      data_json = excluded.data_json,
      version   = saved_games.version + 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(req.userId, json);
    res.json({ ok: true });
});

// Carry over guest save after first login/registration (only if none exists)
router.post('/save/sync', requireAuth, (req, res) => {
    const local = req.body?.localSave;
    if (!local) return res.json({ ok: true });
    const exists = db.prepare('SELECT 1 FROM saved_games WHERE user_id = ?').get(req.userId);
    if (!exists) {
        db.prepare('INSERT INTO saved_games (user_id, data_json, version) VALUES (?,?,1)')
            .run(req.userId, JSON.stringify(local));
    }
    res.json({ ok: true });
});

module.exports = { router };
