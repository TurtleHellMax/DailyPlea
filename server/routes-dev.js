// server/routes-dev.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const mailbox = require('./dev-mailbox');

const router = express.Router();

// Public switch + optional key
const PUBLIC_ON = process.env.DEV_MAILBOX_PUBLIC === '1';
const ACCESS_KEY = process.env.DEV_MAILBOX_KEY || '';

// modest rate limit (per IP)
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

function gate(req, res, next) {
    if (!PUBLIC_ON) return res.status(403).json({ error: 'dev_mailbox_disabled' });
    if (ACCESS_KEY) {
        const key = req.query.key || req.get('x-dev-key');
        if (key !== ACCESS_KEY) return res.status(401).json({ error: 'bad_key' });
    }
    next();
}

// GET /api/dev/outbox  (latest first)
router.get('/outbox', limiter, gate, (req, res) => {
    const items = (mailbox.list?.() ?? mailbox.outbox ?? []).slice(-200).reverse();
    res.json({ items });
});

// DEV ONLY: clear via GET to avoid CSRF hassle (never ship this!)
router.get('/outbox/clear', limiter, gate, (req, res) => {
    if (mailbox.clear) mailbox.clear();
    else if (Array.isArray(mailbox.outbox)) mailbox.outbox.length = 0;
    res.json({ ok: true });
});

module.exports = { router };
