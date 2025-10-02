const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');

const router = express.Router();

/* ====== config / crypto ====== */

const MASTER_KEY_HEX = process.env.DM_MASTER_KEY || ''; // 64 hex chars (32 bytes)
if (!/^[0-9a-fA-F]{64}$/.test(MASTER_KEY_HEX || '')) {
    console.warn('[DM] WARNING: DM_MASTER_KEY not set (or not 64 hex). Generating ephemeral key; encrypted data will be unreadable across restarts.');
}
const MASTER_KEY = /^[0-9a-fA-F]{64}$/.test(MASTER_KEY_HEX)
    ? Buffer.from(MASTER_KEY_HEX, 'hex')
    : crypto.randomBytes(32);

function aeadEncrypt(key, plaintextBuf) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const enc = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { nonce, cipher: Buffer.concat([enc, tag]) };
}
function aeadDecrypt(key, bufWithTag, nonce) {
    const tag = bufWithTag.slice(-16);
    const data = bufWithTag.slice(0, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}
function encryptJSON(key, obj) { return aeadEncrypt(key, Buffer.from(JSON.stringify(obj))); }
function decryptJSON(key, cipher, nonce) { return JSON.parse(aeadDecrypt(key, cipher, nonce)); }

/* ====== helpers ====== */

function findUserBySlugOrId(slug) {
    if (/^\d+$/.test(slug)) return db.prepare(`SELECT * FROM users WHERE id=?`).get(+slug);
    return db.prepare(`
    SELECT * FROM users
    WHERE lower(first_username)=lower(?) OR lower(username)=lower(?)
    LIMIT 1
  `).get(slug, slug);
}

function isMember(convId, userId) {
    const r = db.prepare(`SELECT 1 FROM dm_members WHERE conversation_id=? AND user_id=? LIMIT 1`).get(convId, userId);
    return !!r;
}

function ensureConvKey(convId) {
    const row = db.prepare(`SELECT key_cipher, key_nonce FROM dm_conversation_keys WHERE conversation_id=?`).get(convId);
    if (row) return;
    const convKey = crypto.randomBytes(32);
    const enc = aeadEncrypt(MASTER_KEY, convKey);
    db.prepare(`INSERT OR REPLACE INTO dm_conversation_keys(conversation_id, key_cipher, key_nonce) VALUES(?,?,?)`)
        .run(convId, enc.cipher, enc.nonce);
}

/** Always return a key. If missing, create one; if decrypt fails (e.g., master changed),
 * return null so callers can choose to continue without decryption. */
function getOrCreateConvKey(convId) {
    let row = db.prepare(`SELECT key_cipher, key_nonce FROM dm_conversation_keys WHERE conversation_id=?`).get(convId);
    if (!row) {
        const convKey = crypto.randomBytes(32);
        const enc = aeadEncrypt(MASTER_KEY, convKey);
        db.prepare(`INSERT INTO dm_conversation_keys(conversation_id, key_cipher, key_nonce) VALUES(?,?,?)`)
            .run(convId, enc.cipher, enc.nonce);
        return convKey;
    }
    try {
        return aeadDecrypt(MASTER_KEY, row.key_cipher, row.key_nonce);
    } catch (e) {
        console.warn('[DM] conv key decrypt failed for', convId, e.message, '-> rotating');
        // ROTATE: overwrite with a fresh conv key so future messages work
        const convKey = crypto.randomBytes(32);
        const enc = aeadEncrypt(MASTER_KEY, convKey);
        db.prepare(`UPDATE dm_conversation_keys SET key_cipher=?, key_nonce=? WHERE conversation_id=?`)
            .run(enc.cipher, enc.nonce, convId);
        return convKey;
    }
}


/* ====== SSE (simple) ====== */
const streams = new Map(); // convId -> Set(res)
function getStreamSet(convId) {
    let set = streams.get(convId);
    if (!set) { set = new Set(); streams.set(convId, set); }
    return set;
}
function broadcast(convId, event, data, id) {
    const set = streams.get(convId);
    if (!set || set.size === 0) return;
    const payload =
        (id ? `id: ${id}\n` : '') +
        `event: ${event}\n` +
        `data: ${JSON.stringify(data || {})}\n\n`;
    for (const res of set) {
        try { res.write(payload); } catch { /* ignore */ }
    }
}
// heartbeat so proxies don’t close
setInterval(() => {
    for (const set of streams.values()) for (const res of set) { try { res.write(`: ping\n\n`); } catch { } }
}, 15000);

/* ====== multer (1 MB hard limit per file) ====== */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 } // 1 MB
});

/* ====== routes ====== */

/** Ensure or reuse a 1:1 convo by slug; return its id */
router.post('/dm/with/:slug', requireAuth, (req, res) => {
    const s = String(req.params.slug || '').trim();
    const other = findUserBySlugOrId(s);
    if (!other) return res.status(404).json({ error: 'user_not_found' });
    if (other.id === req.userId) return res.status(400).json({ error: 'self' });

    const row = db.prepare(`
    SELECT c.id
    FROM dm_conversations c
    JOIN dm_members m1 ON m1.conversation_id=c.id AND m1.user_id=?
    JOIN dm_members m2 ON m2.conversation_id=c.id AND m2.user_id=?
    WHERE c.is_group=0
    LIMIT 1
  `).get(req.userId, other.id);

    if (row) {
        // *** backfill key if missing ***
        ensureConvKey(row.id);
        return res.json({ ok: true, conversation_id: row.id, id: row.id });
    }

    const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO dm_conversations(is_group, title) VALUES(0, NULL)`).run();
        const convId = r.lastInsertRowid;
        db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, req.userId);
        db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, other.id);
        ensureConvKey(convId);
        return convId;
    });
    const id = tx();
    res.json({ ok: true, conversation_id: id, id });
});

/** SSE stream */
router.get('/dm/conversations/:id/stream', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).end();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    getStreamSet(convId).add(res);
    res.write(`event: hello\ndata: {"ok":true}\n\n`);

    req.on('close', () => {
        const set = streams.get(convId);
        if (set) set.delete(res);
        if (set && set.size === 0) streams.delete(convId);
    });
});

/** Create group or 1:1 by ids; ensure key for existing 1:1 reuse. */
router.post('/dm/conversations', requireAuth, (req, res) => {
    let { user_ids = [], title = null } = req.body || {};
    user_ids = Array.from(new Set([...(user_ids || []).map(n => +n).filter(Boolean), req.userId])).sort((a, b) => a - b);
    if (user_ids.length < 2) return res.status(400).json({ error: 'need_two_members' });

    const isGroup = user_ids.length > 2 ? 1 : 0;

    if (!isGroup) {
        const row = db.prepare(`
      SELECT c.id
      FROM dm_conversations c
      JOIN dm_members m1 ON m1.conversation_id=c.id AND m1.user_id=?
      JOIN dm_members m2 ON m2.conversation_id=c.id AND m2.user_id=?
      WHERE c.is_group=0
      LIMIT 1
    `).get(user_ids[0], user_ids[1]);
        if (row) {
            ensureConvKey(row.id); // *** backfill if needed ***
            return res.json({ ok: true, conversation_id: row.id, id: row.id });
        }
    }

    const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO dm_conversations(is_group, title) VALUES(?,?)`)
            .run(isGroup, isGroup ? String(title || 'Group') : null);
        const convId = r.lastInsertRowid;
        for (const uid of user_ids) {
            db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, uid);
        }
        ensureConvKey(convId);
        return convId;
    });
    const id = tx();
    res.json({ ok: true, conversation_id: id, id });
});

/** List conversations with preview (best-effort decrypt) */
router.get('/dm/conversations', requireAuth, (req, res) => {
    const rows = db.prepare(`
    SELECT c.id, c.is_group, c.title,
           (SELECT sender_id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_sender_id,
           (SELECT body_cipher FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body_cipher,
           (SELECT body_nonce  FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body_nonce,
           (SELECT id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_msg_id
    FROM dm_conversations c
    JOIN dm_members m ON m.conversation_id=c.id
    WHERE m.user_id=?
    ORDER BY last_msg_id DESC NULLS LAST
  `).all(req.userId);

    const out = rows.map(r => {
        let preview = '';
        try {
            const key = getOrCreateConvKey(r.id); // may be null if decrypt fails
            if (key && r.last_body_cipher && r.last_body_nonce) {
                const body = decryptJSON(key, r.last_body_cipher, r.last_body_nonce);
                preview = (body?.text || '').slice(0, 80);
            }
        } catch { /* ignore */ }
        return { id: r.id, is_group: !!r.is_group, title: r.title, preview };
    });
    res.json({ ok: true, items: out });
});

router.get('/dm/conversations/:id', requireAuth, (req, res) => {
    const convId = +req.params.id;
    // Must exist & requester must be a member
    const conv = db.prepare(`SELECT id, is_group, title FROM dm_conversations WHERE id=?`).get(convId);
    if (!conv) {
        console.warn('[DM] conv-detail 404', convId);
        return res.status(404).json({ error: 'not_found' });
    }
    if (!isMember(convId, req.userId)) {
        console.warn('[DM] conv-detail forbidden', convId, 'reqUser', req.userId);
        return res.status(403).json({ error: 'forbidden' });
    }

    const members = db.prepare(`
    SELECT u.id, u.username, u.first_username, u.profile_photo
    FROM dm_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `).all(convId);

    const other = !conv.is_group ? (members.find(u => (u.id | 0) !== (req.userId | 0)) || null) : null;

    console.log('[DM] conv-detail ok', { convId, is_group: !!conv.is_group, members: members.length, me: req.userId, other: other?.username || other?.first_username });

    res.json({
        ok: true,
        id: conv.id,
        is_group: !!conv.is_group,
        title: conv.title,
        members,
        other
    });
});

/** Get messages (ASC). Supports ?before= and ?after= */
router.get('/dm/conversations/:id/messages', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const before = parseInt(req.query.before || '0', 10) || 0;
    const after = parseInt(req.query.after || '0', 10) || 0;

    let rows = [];
    if (after > 0) {
        rows = db.prepare(`
      SELECT id, sender_id, kind, body_cipher, body_nonce, created_at
      FROM dm_messages
      WHERE conversation_id=? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(convId, after, limit);
    } else if (before > 0) {
        const r = db.prepare(`
      SELECT id, sender_id, kind, body_cipher, body_nonce, created_at
      FROM dm_messages
      WHERE conversation_id=? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(convId, before, limit);
        rows = r.reverse(); // return ASC
    } else {
        const r = db.prepare(`
      SELECT id, sender_id, kind, body_cipher, body_nonce, created_at
      FROM dm_messages
      WHERE conversation_id=?
      ORDER BY id DESC
      LIMIT ?
    `).all(convId, limit);
        rows = r.reverse(); // newest N, ASC
    }

    const key = getOrCreateConvKey(convId); // may be null
    const msgs = rows.map(r => {
        let text = '';
        try {
            if (key && r.body_cipher && r.body_nonce) {
                const obj = decryptJSON(key, r.body_cipher, r.body_nonce);
                text = obj?.text || '';
            }
        } catch { /* ignore */ }
        const atts = db.prepare(`
      SELECT id, filename, mime_type, encoding, size_bytes
      FROM dm_attachments WHERE message_id=? ORDER BY id ASC
    `).all(r.id);
        return { id: r.id, sender_id: r.sender_id, kind: r.kind, text, attachments: atts, created_at: r.created_at };
    });

    const next_before = msgs.length ? msgs[0].id : null; // oldest id in this page
    res.json({ ok: true, items: msgs, next_before });
});

/** Send a message (multipart) */
router.post('/dm/conversations/:id/messages', requireAuth, upload.array('files', 8), (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const text = String(req.body?.text || '');
    const files = req.files || [];
    if (!text && files.length === 0) return res.status(400).json({ error: 'empty' });

    const key = getOrCreateConvKey(convId);
    if (!key) return res.status(500).json({ error: 'key_missing' }); // master changed or corrupt — can’t encrypt

    const kind = files.length ? (text ? 'mix' : 'file') : 'text';
    const encBody = encryptJSON(key, { text });

    const tx = db.transaction(() => {
        const msgId = db.prepare(`
      INSERT INTO dm_messages(conversation_id, sender_id, kind, body_cipher, body_nonce)
      VALUES(?,?,?,?,?)
    `).run(convId, req.userId, kind, encBody.cipher, encBody.nonce).lastInsertRowid;

        for (const f of files) {
            const encoding = (f?.encoding || req.body?.[`encoding_${f.originalname}`] || req.body?.encoding || '').toLowerCase() === 'gzip' ? 'gzip' : null;
            const metaMime = f.mimetype || 'application/octet-stream';
            const metaName = f.originalname || 'file';
            const enc = aeadEncrypt(key, f.buffer);
            db.prepare(`
        INSERT INTO dm_attachments(message_id, filename, mime_type, encoding, size_bytes, blob_cipher, blob_nonce)
        VALUES(?,?,?,?,?,?,?)
      `).run(msgId, metaName, metaMime, encoding, f.size | 0, enc.cipher, enc.nonce);
        }
        return msgId;
    });
    const id = tx();

    broadcast(convId, 'new', { id }, String(id));
    res.json({ ok: true, id });
});

// (Optional: members-only endpoint if you want it)
router.get('/dm/conversations/:id/members', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const members = db.prepare(`
    SELECT u.id, u.username, u.first_username, u.profile_photo
    FROM dm_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `).all(convId);

    console.log('[DM] conv-members ok', { convId, count: members.length });
    res.json({ ok: true, members });
});

/** Download attachment */
router.get('/dm/attachments/:id/download', requireAuth, (req, res) => {
    const attId = +req.params.id;
    const att = db.prepare(`
    SELECT a.*, m.conversation_id
    FROM dm_attachments a
    JOIN dm_messages m ON m.id=a.message_id
    WHERE a.id=?
  `).get(attId);
    if (!att) return res.status(404).json({ error: 'not_found' });
    if (!isMember(att.conversation_id, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const key = getOrCreateConvKey(att.conversation_id);
    if (!key) return res.status(500).json({ error: 'key_missing' });

    const plain = aeadDecrypt(key, att.blob_cipher, att.blob_nonce);
    const inline = String(req.query.inline || '') === '1';
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    if (att.encoding === 'gzip') res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', plain.length);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.filename)}"`);
    res.end(plain);
});

module.exports = { router };
